// In-process relayer with a stubbed chain, for unit tests. No network access.
import { encodeFunctionResult, getAddress, keccak256, parseAbi, serializeTransaction, zeroAddress } from 'viem';
import { loadConfig, loadNetworks, chainIsConfigured } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { createServer } from '../../src/server.js';
import { capsFromEnv, createCap } from '../../src/cap.js';
import { createQueue } from '../../src/queue.js';
import { ERC1271_MAGIC } from '../../src/registration.js';
import { TOKEN, COMMUNITY, privateKeyOf, RELAYER_ACCOUNT } from './fork.js';

export { TOKEN, COMMUNITY, privateKeyOf, RELAYER_ACCOUNT };
export const SAFE = getAddress('0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe');
export const SIG65 = `0x${'11'.repeat(65)}`;
const execAbi = parseAbi(['function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool success)']);
export const SIM_TRUE = encodeFunctionResult({ abi: execAbi, functionName: 'execTransaction', result: true });
export const SIM_FALSE = encodeFunctionResult({ abi: execAbi, functionName: 'execTransaction', result: false });

/**
 * A wallet client stub as the queue uses it: sign first, then send the raw transaction. Signing is real
 * serialization without a signature, so one transaction always has one hash, as on a node.
 * `send(tx, hash)` does the stub's bookkeeping and returns the hash, or throws as the node would.
 */
export function rawWallet(send, chainId = 11155111) {
  const signed = new Map();
  return {
    async signTransaction(tx) {
      const serialized = serializeTransaction({
        chainId, type: 'eip1559', to: tx.to, data: tx.data, value: tx.value, gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, nonce: tx.nonce,
      });
      signed.set(serialized, tx);
      return serialized;
    },
    async sendRawTransaction({ serializedTransaction }) {
      return send(signed.get(serializedTransaction), keccak256(serializedTransaction));
    },
  };
}

/** A chain stub that records every call. Options change what the RPC answers. */
export function stubChains(networks, opts = {}) {
  const calls = { call: 0, send: 0, read: 0, nonce: 0, sent: [] };
  let nonceCounter = 0;
  const o = { balance: 5n * 10n ** 18n, latest: 3, pending: 3, sim: SIM_TRUE, unreachable: false, readResult: ERC1271_MAGIC, sendError: null, gas: 100000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, block: 1000n, receipts: {}, ...opts };
  const down = () => new Error(`HTTP request failed. URL: http://rpc.invalid/${'secret-key-in-url'}`);
  const isDown = (chainId) => o.unreachable === true || (Array.isArray(o.unreachable) && o.unreachable.includes(Number(chainId)));
  const publicFor = (chainId) => ({
    async getBalance() { if (isDown(chainId)) throw down(); return typeof o.balance === 'function' ? o.balance(chainId) : o.balance; },
    async getTransactionCount({ blockTag }) { if (isDown(chainId)) throw down(); return blockTag === 'pending' ? o.pending : o.latest; },
    // The Safe's nonce() (safe-exec dedupe key): `safeNonce` is a fixed value, a function of the call, or an Error to
    // throw. Left unset, every read answers a new nonce, so unrelated tests never look like retries of each other.
    async readContract(req) {
      if (req.functionName === 'nonce') {
        calls.nonce += 1;
        if (o.safeNonce instanceof Error) throw o.safeNonce;
        if (typeof o.safeNonce === 'function') return o.safeNonce(req);
        if (o.safeNonce !== undefined) return BigInt(o.safeNonce);
        return BigInt(nonceCounter++);
      }
      calls.read += 1;
      // readResult may be a function of the call ({address, functionName, args}), e.g. a fake EIP-1271 check.
      if (typeof o.readResult === 'function') return o.readResult(req); if (o.readResult instanceof Error) throw o.readResult; return o.readResult;
    },
    async estimateGas() { if (o.estimateError) throw o.estimateError; return o.gas; },
    async estimateFeesPerGas() { if (o.feeError) throw o.feeError; return { maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas }; },
    async getBlockNumber() { return typeof o.block === 'function' ? o.block() : o.block; },
    async getTransactionReceipt({ hash }) { const r = o.receipts[hash]; if (!r) throw new Error('receipt not found'); return r; },
    async call() { calls.call += 1; if (o.sim instanceof Error) throw o.sim; return { data: o.sim }; },
  });
  // `sendError` is a refusal before the node took the transaction; `afterAccept` is thrown once after it did.
  const walletClient = rawWallet((tx, hash) => {
    calls.send += 1;
    if (o.sendError) throw o.sendError;
    calls.sent.push(tx);
    if (o.afterAccept) {
      const e = o.afterAccept;
      o.afterAccept = null;
      throw e;
    }
    return hash;
  });
  return {
    calls,
    options: o,
    get(chainId) { return chainIsConfigured(networks, chainId) ? { publicClient: publicFor(chainId), walletClient } : null; },
  };
}

export async function startStub({ env = {}, networks = loadNetworks(), chainsOpts = {}, groups = [], capNow, chains: givenChains = null } = {}) {
  const fullEnv = {
    WEB3_ENABLED: 'true',
    SPONSOR_RELAYER_PRIVATE_KEY: privateKeyOf(RELAYER_ACCOUNT),
    SPONSOR_RELAYER_TOKEN: TOKEN,
    SPONSOR_RELAYER_COMMUNITY: COMMUNITY,
    SPONSOR_RELAYER_DB: ':memory:',
    ...env,
  };
  for (const [k, v] of Object.entries(fullEnv)) if (v === undefined) delete fullEnv[k];
  process.env.WEB3_ENABLED = 'true';
  const config = loadConfig(fullEnv, networks);
  const db = openDb(':memory:');
  for (const g of groups) db.addGroup({ community: COMMUNITY, ...g });
  const chains = givenChains ?? stubChains(networks, chainsOpts);
  const logs = [];
  const logger = { info: (l) => logs.push(String(l)), warn: (l) => logs.push(String(l)), error: (l) => logs.push(String(l)) };
  const cap = createCap({ db, caps: capsFromEnv(fullEnv), now: capNow });
  const queue = createQueue({ db, chains, cap, address: config.address, logger });
  const server = createServer({ config, networks, db, chains, cap, queue, logger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token = TOKEN, extraHeaders = {}) => {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const close = async () => {
    queue.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    db.close();
  };
  return { call, close, db, chains, logs, config, url, cap, queue };
}

/** A well-formed POST /send/safe-exec body. */
export function execBody(networks, overrides = {}) {
  return {
    chainId: 11155111,
    safe: SAFE,
    to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    value: '1000000000000000',
    data: '0x',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    signatures: SIG65,
    ...overrides,
  };
}
