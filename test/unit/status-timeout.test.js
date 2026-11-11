// GET /status with a stalled chain (25-10 inbox item 4, 25-26 addendum).
//
// Every per-chain read behind /status is capped at about 3 s. A chain whose RPC accepts the connection
// and never answers reads {"error": "unreachable"}, the other chains keep their values, and the whole
// answer comes back within about 4 s. Both RPCs are local node:http servers on 127.0.0.1, read through the
// real viem clients (createChains), so the cap is proven on the transport the relayer runs. No network access.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { encodeFunctionResult, getAddress, parseAbi } from 'viem';
import { capsFromEnv, createCap } from '../../src/cap.js';
import { createChains } from '../../src/chain.js';
import { loadConfig, loadNetworks } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { createQueue } from '../../src/queue.js';
import * as relayerServer from '../../src/server.js';
import { COMMUNITY, RELAYER_ACCOUNT, SAFE, TOKEN, privateKeyOf } from '../helpers/stub.js';

process.env.WEB3_ENABLED = 'true';

const { createServer, STATUS_READ_TIMEOUT_MS } = relayerServer;
const STALLED = 84532;
const LIVE = 11155111;
const OTHER_SAFE = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const modulesAbi = parseAbi(['function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)']);
const NO_MODULES = encodeFunctionResult({ abi: modulesAbi, functionName: 'getModulesPaginated', result: [[], '0x0000000000000000000000000000000000000001'] });

/** Starts a local HTTP server; `handler` null means accept every request and never answer. */
async function listen(handler) {
  const requests = [];
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push(raw);
      if (handler) handler(JSON.parse(raw), res);
      // Stalled: the request is read and left open, as a hung RPC node would.
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close };
}

/** A JSON-RPC answer for the reads /status makes on a healthy chain. */
function liveRpc(body, res) {
  const one = (call) => {
    const result = {
      eth_chainId: `0x${LIVE.toString(16)}`,
      eth_getBalance: '0x1bc16d674ec80000', // 2 ETH
      eth_getTransactionCount: call.params?.[1] === 'pending' ? '0x5' : '0x3',
      eth_call: NO_MODULES,
    }[call.method];
    return result === undefined
      ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `no ${call.method}` } }
      : { jsonrpc: '2.0', id: call.id, result };
  };
  const out = Array.isArray(body) ? body.map(one) : one(body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
}

describe('status: per-chain read cap', () => {
  test('the cap is about 3 s', () => {
    assert.equal(typeof STATUS_READ_TIMEOUT_MS, 'number');
    assert.ok(STATUS_READ_TIMEOUT_MS >= 2000 && STATUS_READ_TIMEOUT_MS <= 3500, `cap ${STATUS_READ_TIMEOUT_MS} ms`);
  });

  test('a stalled RPC answers within about 4 s, marks only that chain unreachable, and leaves the others', { timeout: 120_000 }, async () => {
    const stalled = await listen(null);
    const live = await listen(liveRpc);
    const networks = loadNetworks();
    const env = {
      WEB3_ENABLED: 'true',
      SPONSOR_RELAYER_PRIVATE_KEY: privateKeyOf(RELAYER_ACCOUNT),
      SPONSOR_RELAYER_TOKEN: TOKEN,
      SPONSOR_RELAYER_COMMUNITY: COMMUNITY,
      SPONSOR_RELAYER_DB: ':memory:',
      [`SPONSOR_RELAYER_RPC_URL_${STALLED}`]: stalled.url,
      [`SPONSOR_RELAYER_RPC_URL_${LIVE}`]: live.url,
    };
    const config = loadConfig(env, networks);
    const db = openDb(':memory:');
    // One Group on each chain: the module lookup per Group is a chain read too, and must be capped.
    db.addGroup({ community: COMMUNITY, chainId: STALLED, safe: SAFE, space: 'stalled.eth' });
    db.addGroup({ community: COMMUNITY, chainId: LIVE, safe: OTHER_SAFE, space: 'live.eth' });
    const chains = createChains({ config, networks });
    const cap = createCap({ db, caps: capsFromEnv(env) });
    const logger = { info() {}, warn() {}, error() {} };
    const queue = createQueue({ db, chains, cap, address: config.address, logger });
    const server = createServer({ config, networks, db, chains, cap, queue, logger });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${server.address().port}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const elapsed = Date.now() - started;
      const text = await res.text();
      const json = JSON.parse(text);

      assert.equal(res.status, 200);
      assert.ok(elapsed < 4000, `GET /status took ${elapsed} ms`);
      assert.ok(stalled.requests.length > 0, 'the stalled chain was asked');
      assert.deepEqual(json.chains[String(STALLED)], { error: 'unreachable' });
      assert.deepEqual(json.chains[String(LIVE)], { balanceWei: '2000000000000000000', pending: 2 });
      const byChain = Object.fromEntries(json.groups.map((g) => [g.chainId, g]));
      assert.equal(byChain[STALLED].module, null, 'a Group on the stalled chain reads no module');
      assert.equal(byChain[LIVE].module, null);
      assert.equal(byChain[LIVE].space, 'live.eth');
      assert.ok(!text.includes(stalled.url) && !text.includes(live.url), 'an RPC URL leaked');
    } finally {
      queue.stop();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      db.close();
      await stalled.close();
      await live.close();
    }
  });
});
