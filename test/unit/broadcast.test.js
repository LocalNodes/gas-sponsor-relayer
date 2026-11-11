// 25-28 fix round 2, HIGH 1 (Codex round 2): the raw broadcast goes to one endpoint, once, and only the node's own
// exact refusal from that one attempt counts as "nothing went out". Everything else, including an error this file
// does not recognise, means the send may be live: its row and its reservation are kept.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWalletClient,
  custom,
  defineChain,
  fallback,
  HttpRequestError,
  ResponseBodyTooLargeError,
  RpcRequestError,
  UnknownRpcError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createChains } from '../../src/chain.js';
import { createCap } from '../../src/cap.js';
import { openDb } from '../../src/db.js';
import { broadcastOutcome, createQueue } from '../../src/queue.js';
import { privateKeyOf, RELAYER_ACCOUNT } from '../helpers/stub.js';
import { CHAIN, down, lost, NOW, quiet, refusal, settle, setup, spentDay, tx } from '../helpers/node.js';

const A = 'http://a.rpc.invalid/';
const B = 'http://b.rpc.invalid/';
const NETWORKS = { [String(CHAIN)]: { name: 'test', rpcUrls: [A, B], multiSend: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526' } };

describe('round 2 HIGH 1: what a failed broadcast means', () => {
  test('broadcast: only the node\'s own JSON-RPC refusal in exact known words counts as refused; anything else is uncertain', () => {
    const refused = [
      refusal('insufficient funds for gas * price + value: balance 0, tx cost 1200, overshot 1200'),
      refusal('intrinsic gas too low: gas 100, minimum needed 21000'),
      refusal('exceeds block gas limit'),
      refusal('transaction underpriced: tip needed 1, tip permitted 0'),
      refusal('replacement transaction underpriced'),
      refusal('nonce too high'),
      new RpcRequestError({ body: {}, error: { code: -32000, message: 'insufficient funds for gas * price + value' }, url: A }),
    ];
    for (const e of refused) assert.equal(broadcastOutcome(e), 'refused', e.details ?? e.message);

    const uncertain = [
      new Error('boom'),
      new ResponseBodyTooLargeError({ maxSize: 1, size: 2 }),
      lost(),
      down(),
      new HttpRequestError({ url: A, status: 500, details: 'insufficient funds for gas * price + value' }),
      refusal('nonce too low: next nonce 6, tx nonce 5'),
      refusal('the node is busy, try again'),
      refusal('insufficient funds for gas * price + value', -32603),
      new UnknownRpcError(new Error('insufficient funds for gas * price + value')),
      // Looks like a refusal, but is not the node's own answer: no JSON-RPC error code.
      Object.assign(new Error('RPC Request failed.'), { name: 'RpcRequestError', details: 'insufficient funds for gas * price + value' }),
    ];
    for (const e of uncertain) assert.equal(broadcastOutcome(e), 'uncertain', `${e.name}: ${e.details ?? e.message}`);

    assert.equal(broadcastOutcome(refusal('already known')), 'accepted');
  });

  test('broadcast: an error the queue does not recognise keeps the row and the reservation, and the send is answered as sent', async () => {
    for (const e of [new Error('boom'), new ResponseBodyTooLargeError({ maxSize: 1, size: 2 })]) {
      const { db, cap, node, queue } = setup({ node: { refuse: e } });
      const reservation = cap.reserve(CHAIN, 1000n);
      const out = await settle(queue.enqueue(CHAIN, () => tx(), { reservation }));
      assert.equal(out.error, undefined, `${e.name}: the send may be live, so it is not reported as failed`);
      assert.equal(db.listPending().length, 1, e.name);
      assert.equal(db.listPending()[0].hash, out.value.hash, e.name);
      assert.equal(spentDay(cap), 1000n, e.name);
      assert.equal(node.state.sent.length, 0);
    }
  });

  test('broadcast: an exact refusal deletes the row, and enqueue rejects so the caller gives the reservation back', async () => {
    const { db, cap, queue } = setup({ node: { refuse: refusal('insufficient funds for gas * price + value: balance 0') } });
    const reservation = cap.reserve(CHAIN, 1000n);
    const out = await settle(queue.enqueue(CHAIN, () => tx(), { reservation }));
    assert.ok(out.error);
    assert.equal(db.listPending().length, 0);
  });
});

describe('round 2 HIGH 1: the broadcast has one endpoint and no fallback', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('broadcast: createChains gives the wallet one endpoint with no retry; reads keep the fallback; proofs read that one endpoint', () => {
    const chains = createChains({ config: { rpcUrls: {}, account: privateKeyToAccount(privateKeyOf(RELAYER_ACCOUNT)) }, networks: NETWORKS });
    const c = chains.get(CHAIN);
    assert.equal(c.walletClient.transport.type, 'http');
    assert.equal(c.walletClient.transport.url, A);
    assert.equal(c.walletClient.transport.retryCount, 0);
    assert.equal(c.publicClient.transport.type, 'fallback');
    assert.equal(c.proofClient.transport.type, 'http');
    assert.equal(c.proofClient.transport.url, A, 'the proof reads the endpoint the broadcasts go to');
  });

  test('broadcast: with a fallback transport, endpoint B\'s refusal hides that endpoint A took the send (why the broadcast has none)', async () => {
    const account = privateKeyToAccount(privateKeyOf(RELAYER_ACCOUNT));
    const chain = defineChain({ id: CHAIN, name: 't', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [A] } } });
    const took = [];
    const a = custom({ async request({ method, params }) { if (method === 'eth_sendRawTransaction') { took.push(params[0]); throw new HttpRequestError({ url: A, details: 'socket hang up' }); } throw new Error(method); } });
    const b = custom({ async request({ method }) { if (method === 'eth_sendRawTransaction') throw new RpcRequestError({ body: {}, error: { code: -32000, message: 'insufficient funds for gas * price + value' }, url: B }); throw new Error(method); } });
    const wallet = createWalletClient({ account, chain, transport: fallback([a, b]) });
    const err = await wallet.sendRawTransaction({ serializedTransaction: '0x02' }).catch((e) => e);
    assert.equal(took.length, 1, 'A took it');
    assert.match(String(err.details ?? err.message), /insufficient funds/, 'only B\'s refusal reaches the caller');
  });

  test('broadcast: Codex repro: endpoint A takes the send and its answer is lost, B would refuse: the row and the reservation stay, and B never sees the send', async () => {
    const seen = { [A]: [], [B]: [] };
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const u = String(url);
      seen[u].push(body.method);
      const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
      if (body.method === 'eth_chainId') return ok(`0x${CHAIN.toString(16)}`);
      if (body.method === 'eth_blockNumber') return ok('0x64');
      if (body.method === 'eth_getTransactionCount') return ok('0x5');
      if (body.method === 'eth_sendRawTransaction') {
        if (u === A) throw new TypeError('fetch failed'); // A took it; the answer never came back
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'insufficient funds for gas * price + value: balance 0' } }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${body.method}`);
    };
    const chains = createChains({ config: { rpcUrls: {}, account: privateKeyToAccount(privateKeyOf(RELAYER_ACCOUNT)) }, networks: NETWORKS });
    const db = openDb(':memory:');
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => NOW });
    const queue = createQueue({ db, chains, cap, address: RELAYER_ACCOUNT.address, logger: quiet });
    const reservation = cap.reserve(CHAIN, 1000n);
    const out = await settle(queue.enqueue(CHAIN, () => tx(), { reservation }));
    assert.equal(out.error, undefined, `answered as a possibly live send, not a failure: ${out.error?.shortMessage ?? ''}`);
    assert.equal(seen[A].filter((m) => m === 'eth_sendRawTransaction').length, 1, 'one attempt, at A');
    assert.equal(seen[B].filter((m) => m === 'eth_sendRawTransaction').length, 0, 'B never sees the broadcast');
    const rows = db.listPending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hash, out.value.hash);
    assert.equal(spentDay(cap), 1000n);
  });
});
