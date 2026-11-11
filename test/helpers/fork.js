// Shared fork-test helpers: anvil dev accounts, a 2-of-2 Safe 1.4.1, owner signatures and an
// in-process relayer. Only anvil's public dev keys appear here, and they sign only on the fork.
import { randomBytes } from 'node:crypto';
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  encodeAbiParameters,
  hexToBigInt,
  http,
  parseAbi,
  toHex,
  zeroAddress,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { loadConfig, loadNetworks } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { createChains } from '../../src/chain.js';
import { createServer } from '../../src/server.js';
import { capsFromEnv, createCap } from '../../src/cap.js';
import { createQueue } from '../../src/queue.js';
import { createGroupModules } from '../../src/groups.js';
import { createEns } from '../../src/sends/ens.js';

// The fork this run talks to. FORK_NETWORK picks it (default ethereum_sepolia); 25-26 runs the same
// tests with FORK_NETWORK=base_sepolia against a Base Sepolia fork. Ports are the ones in tests/e2e/fork/forks.json.
const FORKS = { ethereum_sepolia: { chainId: 11155111, port: 18545 }, base_sepolia: { chainId: 84532, port: 18546 } };
export const FORK_NETWORK = process.env.FORK_NETWORK ?? 'ethereum_sepolia';
if (!FORKS[FORK_NETWORK]) throw new Error(`FORK_NETWORK must be ethereum_sepolia or base_sepolia, got ${JSON.stringify(FORK_NETWORK)}`);
export const CHAIN_ID = FORKS[FORK_NETWORK].chainId;
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
export const TOKEN = 'test-bearer-token-not-a-secret';
export const COMMUNITY = 'Gov Vectors';

// Safe 1.4.1 set-up contracts, the same rows as tests/governance/lib/governance.mjs (safe-deployments v1.4.1).
// They live in the test only: the relayer never deploys a Safe.
const SAFE = {
  singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
};

export const safeAbi = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
]);
const factoryAbi = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);

export const account = (i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
export const privateKeyOf = (acct) => toHex(acct.getHdKey().privateKey);
export const RELAYER_ACCOUNT = account(5);

export function forkUrl() {
  return process.env[`FORK_RPC_URL_${CHAIN_ID}`] ?? `http://127.0.0.1:${FORKS[FORK_NETWORK].port}`;
}

/** Public client on the fork. Fails with "fork not reachable" and never skips. */
export async function forkClients() {
  // 60 s, not viem's 10 s: anvil forks from a public endpoint (Pocket) and an anvil_mine can wait on its state reads.
  const transport = http(forkUrl(), { timeout: 60_000 });
  const pub = createPublicClient({ transport });
  try {
    const id = await pub.getChainId();
    if (id !== CHAIN_ID) throw new Error(`chain id ${id}`);
    const meta = await pub.request({ method: 'anvil_metadata', params: [] });
    if (!meta?.forkedNetwork) throw new Error('anvil is not forking');
  } catch (e) {
    throw new Error(`fork not reachable at ${forkUrl()}: ${e.shortMessage ?? e.message}`);
  }
  const wallet = (acct) => createWalletClient({ account: acct, transport });
  return { pub, wallet };
}

/**
 * Mine until the node's `finalized` block reaches `block` (anvil's finalized tag trails latest). The relayer settles a
 * receipt in its spend cap only once the receipt's block is finalized (25-28 round 3, #2).
 */
export async function untilFinalized(pub, block, rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    const f = await pub.getBlock({ blockTag: 'finalized' });
    if (f.number >= block) return f.number;
    await pub.request({ method: 'anvil_mine', params: ['0x10'] });
  }
  throw new Error(`finalized never reached block ${block}`);
}

/** Finalize everything mined so far, then run one pass of the relayer's queue: every mined send is settled. */
export async function settleSends(pub, relayer) {
  await untilFinalized(pub, await pub.getBlockNumber());
  await relayer.queue.tick();
}

/** Deploy a Safe 1.4.1 proxy. Pass saltNonce to land on a predicted address; the default is a random one. */
export async function deploySafe(pub, wallet, owners, threshold, saltNonce) {
  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [owners.map((o) => o.address), BigInt(threshold), zeroAddress, '0x', SAFE.fallbackHandler, zeroAddress, 0n, zeroAddress],
  });
  const salt = saltNonce === undefined ? hexToBigInt(toHex(randomBytes(16))) : BigInt(saltNonce);
  const payer = account(2);
  const sim = await pub.simulateContract({
    account: payer,
    address: SAFE.proxyFactory,
    abi: factoryAbi,
    functionName: 'createProxyWithNonce',
    args: [SAFE.singletonL2, initializer, salt],
  });
  const hash = await wallet(payer).writeContract(sim.request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('Safe deployment reverted');
  return getAddress(sim.result);
}

/** Owner signatures concatenated in ascending owner-address order, as Safe checkSignatures needs. */
export function sortAndConcat(entries) {
  const sorted = [...entries].sort((a, b) => {
    const x = hexToBigInt(a.owner);
    const y = hexToBigInt(b.owner);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return concat(sorted.map((e) => e.signature));
}

export function registrationTypedData(chainId, message) {
  return {
    domain: { name: 'gas-sponsor-relayer', version: '1', chainId: Number(chainId) },
    types: {
      SponsorRegistration: [
        { name: 'relayer', type: 'address' },
        { name: 'chainId', type: 'uint256' },
        { name: 'safe', type: 'address' },
        { name: 'space', type: 'string' },
        { name: 'community', type: 'string' },
      ],
    },
    primaryType: 'SponsorRegistration',
    message,
  };
}

/** Each signer signs SafeMessage{abi.encode(digest)} under the Safe's domain. */
export async function signRegistration({ chainId = CHAIN_ID, relayer, safe, space, community = COMMUNITY, signers }) {
  const digest = hashTypedData(registrationTypedData(chainId, { relayer, chainId: BigInt(chainId), safe, space, community }));
  const typed = {
    domain: { chainId, verifyingContract: getAddress(safe) },
    types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    primaryType: 'SafeMessage',
    message: { message: encodeAbiParameters([{ type: 'bytes32' }], [digest]) },
  };
  const entries = [];
  for (const s of signers) entries.push({ owner: s.address, signature: await s.signTypedData(typed) });
  return sortAndConcat(entries);
}

/** Owner signatures over the Safe's own transaction hash (v 27 or 28: the plain ecrecover path). */
export async function signSafeTx(pub, safe, tx, signers) {
  const nonce = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' });
  const hash = await pub.readContract({
    address: safe,
    abi: safeAbi,
    functionName: 'getTransactionHash',
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, nonce],
  });
  const entries = [];
  for (const s of signers) entries.push({ owner: s.address, signature: await s.sign({ hash }) });
  return sortAndConcat(entries);
}

/** A relayer in this process, pointed at the fork, with an in-memory database. */
export async function startRelayer(overrides = {}, options = {}) {
  const env = {
    WEB3_ENABLED: 'true',
    SPONSOR_RELAYER_PRIVATE_KEY: privateKeyOf(RELAYER_ACCOUNT),
    SPONSOR_RELAYER_TOKEN: TOKEN,
    SPONSOR_RELAYER_COMMUNITY: COMMUNITY,
    SPONSOR_RELAYER_DB: ':memory:',
    SPONSOR_RELAYER_PORT: '0',
    [`SPONSOR_RELAYER_RPC_URL_${CHAIN_ID}`]: forkUrl(),
    ...overrides,
  };
  process.env.WEB3_ENABLED = 'true';
  const networks = loadNetworks();
  const config = loadConfig(env, networks);
  const db = openDb(config.dbPath);
  const chains = createChains({ config, networks });
  const logs = [];
  const logger = { info: (l) => logs.push(String(l)), warn: (l) => logs.push(String(l)), error: (l) => logs.push(String(l)) };
  const cap = createCap({ db, caps: capsFromEnv(env) });
  const groupModules = createGroupModules({ networks, chains });
  const queue = createQueue({
    db,
    chains,
    cap,
    address: config.address,
    logger,
    onMined: (row) => {
      if (row.safe) groupModules.invalidate(row.chainId, row.safe);
    },
  });
  const ens = createEns({ db, config, networks, chains, cap, queue, logger, wait: options.ensWait, pollMs: 100 });
  const server = createServer({ config, networks, db, chains, cap, queue, groupModules, ens, logger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token = TOKEN) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text };
  };
  const close = async () => {
    await ens.idle();
    queue.stop();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    db.close();
  };
  return { url, call, close, db, config, logs, cap, queue, chains, groupModules, ens, networks, relayer: RELAYER_ACCOUNT.address };
}
