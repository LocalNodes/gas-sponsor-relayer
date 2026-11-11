// Environment and networks. Nothing here prints or serializes the private key.
import { readFileSync } from 'node:fs';
import { isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { capsFromEnv } from './cap.js';

/** Address-bearing keys of a config/networks.json entry. An entry with none of them is empty. */
export const ADDRESS_KEYS = [
  'multiSend',
  'multiSendCallOnly',
  'createCall',
  'signMessageLib',
  'moduleProxyFactory',
  'realityMastercopy',
  'reality',
  'hats',
  'ensRegistrar',
  'ensPaymentToken',
  'ensUniversalHelper',
];

export function loadNetworks(path = new URL('../config/networks.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** A chain is served only when its entry holds at least one contract address. */
export function chainIsConfigured(networks, chainId) {
  const entry = networks?.[String(chainId)];
  return Boolean(entry) && ADDRESS_KEYS.some((k) => typeof entry[k] === 'string' && entry[k] !== '');
}

/**
 * The relayer pays for sends on a chain only when it is configured and its entry does not say `"sponsoring": false`.
 * Base Sepolia says so until Phase 30 (25-28 round 3): the spend cap counts execution gas and value, not an OP-stack
 * chain's L1 data fee and operator fee. Reads and GET /status still serve such a chain.
 */
export function chainIsSponsored(networks, chainId) {
  return chainIsConfigured(networks, chainId) && networks[String(chainId)].sponsoring !== false;
}

/** The answer to a send on a chain the relayer does not sponsor: nothing was reserved, estimated or sent. */
export const NOT_SPONSORED = Object.freeze({ error: 'unavailable', reason: 'chain_not_sponsored' });

function parsePort(value) {
  if (value === undefined || value === '') return 8787;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8787;
}

/**
 * Read the relayer settings from env (default process.env).
 *
 * Web3 off means keyless (TM-151): unless WEB3_ENABLED is exactly the string 'true', the key
 * variable is never read, there is no account, and the server answers 503 web3_disabled to
 * everything but GET /healthz. 'TRUE', '1', 'yes' and '' count as off.
 *
 * With web3 on and no usable key, `configured` is false: the server answers 503 to every send,
 * and GET /status says so. The key sits on a non-enumerable property so that logging or
 * serializing the config object cannot leak it.
 *
 * The spend caps (SPONSOR_RELAYER_CAP_DAY_WEI, SPONSOR_RELAYER_CAP_MONTH_WEI) must be whole
 * numbers of wei when web3 is on; anything else throws, so the relayer refuses to start.
 */
export function loadConfig(env = process.env, networks = {}) {
  const web3Enabled = env.WEB3_ENABLED === 'true';
  const rawKey = web3Enabled ? (env.SPONSOR_RELAYER_PRIVATE_KEY ?? '') : '';
  let account = null;
  if (rawKey !== '' && isHex(rawKey) && rawKey.length === 66) {
    try {
      account = privateKeyToAccount(rawKey);
    } catch {
      account = null;
    }
  }
  const rpcUrls = {};
  for (const id of Object.keys(networks)) {
    const url = env[`SPONSOR_RELAYER_RPC_URL_${id}`];
    if (url) rpcUrls[id] = url;
  }
  // Hub and sequencer URL overrides (tests point them at a stub); only http(s) URLs count.
  const hubUrls = {};
  const sequencerUrls = {};
  for (const id of Object.keys(networks)) {
    const hub = env[`SPONSOR_RELAYER_HUB_URL_${id}`];
    if (typeof hub === 'string' && /^https?:\/\//.test(hub)) hubUrls[id] = hub;
    const seq = env[`SPONSOR_RELAYER_SEQUENCER_URL_${id}`];
    if (typeof seq === 'string' && /^https?:\/\//.test(seq)) sequencerUrls[id] = seq;
  }
  const config = {
    token: env.SPONSOR_RELAYER_TOKEN ?? '',
    community: env.SPONSOR_RELAYER_COMMUNITY ?? '',
    dbPath: env.SPONSOR_RELAYER_DB || ':memory:',
    port: parsePort(env.SPONSOR_RELAYER_PORT),
    host: env.SPONSOR_RELAYER_HOST || '0.0.0.0',
    rpcUrls,
    hubUrls,
    sequencerUrls,
    web3Enabled,
    address: account ? account.address : null,
    configured: account !== null,
    keyPresentButInvalid: rawKey !== '' && account === null,
  };
  Object.defineProperty(config, 'account', { value: account, enumerable: false });
  // BigInt values, so they stay off the enumerable surface: JSON.stringify(config) must not throw.
  Object.defineProperty(config, 'caps', { value: web3Enabled ? capsFromEnv(env) : capsFromEnv({}), enumerable: false });
  return config;
}
