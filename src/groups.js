// Per-Group Reality module discovery (25-06, TM-77).
//
// The relayer learns a registered Group's module from the chain and from nothing else. A module counts
// only if all of these hold: the Group's Safe has it enabled (it is in getModulesPaginated), its runtime
// code is exactly the ERC-1167 minimal proxy of the configured Zodiac Reality mastercopy, and its avatar()
// and target() are the Safe. No request body can add one. Results are cached for one minute per Safe, and
// the queue drops a Safe's entry when a send from that Safe mines (a setup transaction enables the module).
import { getAddress, pad, parseAbi, zeroAddress } from 'viem';
import { build } from './allowlist.js';
import { chainIsConfigured } from './config.js';

/** Safe's module-list sentinel (SENTINEL_MODULES = address(1)). */
export const SENTINEL_MODULES = pad('0x01', { size: 20 });
export const CACHE_MS = 60_000;


const safeAbi = parseAbi(['function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)']);
const moduleAbi = parseAbi(['function avatar() view returns (address)', 'function target() view returns (address)']);

const lower = (a) => String(a).toLowerCase();

/**
 * Runtime code of an ERC-1167 minimal proxy for `mastercopy`: 363d3d373d3d3d363d73 || mastercopy || 5af43d82803e903d91602b57fd5bf3
 * (the code ModuleProxyFactory deploys, minus its 10-byte creation prefix).
 */
export function proxyRuntimeCode(mastercopy) {
  return `0x363d3d373d3d3d363d73${lower(mastercopy).slice(2)}5af43d82803e903d91602b57fd5bf3`;
}

/** Thrown when the chain could not be read; the caller treats it as "unknown", not as "no modules". */
class ReadFailed extends Error {}

async function readModules(publicClient, { safe, mastercopy, pageSize, maxPages }) {
  const candidates = [];
  let start = SENTINEL_MODULES;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const res = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'getModulesPaginated', args: [start, BigInt(pageSize)] });
      if (!Array.isArray(res) || !Array.isArray(res[0])) return []; // not a Safe: there is nothing to find
      for (const m of res[0]) if (typeof m === 'string' && !candidates.includes(m)) candidates.push(m);
      const next = res[1];
      if (res[0].length === 0 || typeof next !== 'string' || lower(next) === SENTINEL_MODULES || lower(next) === zeroAddress) break;
      start = next;
    }
  } catch {
    throw new ReadFailed('module list');
  }

  const expected = proxyRuntimeCode(mastercopy);
  const found = [];
  for (const m of candidates) {
    let address;
    try {
      address = getAddress(m);
    } catch {
      continue;
    }
    try {
      const code = await publicClient.getCode({ address });
      if (typeof code !== 'string' || lower(code) !== expected) continue;
      const [avatar, target] = await Promise.all([
        publicClient.readContract({ address, abi: moduleAbi, functionName: 'avatar' }),
        publicClient.readContract({ address, abi: moduleAbi, functionName: 'target' }),
      ]);
      if (typeof avatar === 'string' && typeof target === 'string' && lower(avatar) === lower(safe) && lower(target) === lower(safe)) found.push(address);
    } catch {
      throw new ReadFailed('module check');
    }
  }
  return found;
}

/**
 * The Reality modules a Safe has enabled that are proxies of `mastercopy` with the Safe as avatar and target.
 * Returns [] when there are none and when the chain cannot be read.
 */
export async function discoverModules(publicClient, { safe, mastercopy, pageSize = 50, maxPages = 20 }) {
  try {
    return await readModules(publicClient, { safe: getAddress(safe), mastercopy, pageSize, maxPages });
  } catch {
    return [];
  }
}

/** Module discovery for the registered Groups, with a one-minute cache per Safe. */
export function createGroupModules({ networks, chains, ttlMs = CACHE_MS, now = Date.now, pageSize = 50, maxPages = 20 }) {
  const cache = new Map(); // key -> { at, modules }
  const inflight = new Map(); // key -> Promise
  const generation = new Map(); // key -> number, bumped by invalidate()
  const keyOf = (chainId, safe) => `${Number(chainId)}:${lower(safe)}`;

  async function modulesFor(chainId, safe) {
    const mastercopy = networks?.[String(chainId)]?.realityMastercopy;
    if (!mastercopy || !chainIsConfigured(networks, chainId)) return [];
    const key = keyOf(chainId, safe);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.modules;
    if (inflight.has(key)) return inflight.get(key);
    const clients = chains?.get?.(chainId);
    if (!clients?.publicClient) return [];
    const startedAt = generation.get(key) ?? 0;
    const job = (async () => {
      try {
        const modules = await readModules(clients.publicClient, { safe: getAddress(safe), mastercopy, pageSize, maxPages });
        // A reset while the read was running means the answer may predate the change: use it once, do not keep it.
        if ((generation.get(key) ?? 0) === startedAt) cache.set(key, { at: now(), modules });
        return modules;
      } catch {
        return []; // unknown: not cached, so the next call reads again
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  return {
    modulesFor,
    /** Forget a Safe's entry (a send from it mined, so its modules may have changed). */
    invalidate(chainId, safe) {
      const key = keyOf(chainId, safe);
      cache.delete(key);
      generation.set(key, (generation.get(key) ?? 0) + 1);
    },
    /** The allowlist for the registered Groups, with each Group's discovered modules. */
    async allowlist(groups) {
      const modules = [];
      await Promise.all(
        groups.map(async (g) => {
          for (const module of await modulesFor(g.chainId, g.safe)) modules.push({ chainId: g.chainId, module });
        }),
      );
      return build(networks, groups, modules);
    },
  };
}
