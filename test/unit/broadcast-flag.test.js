// 25-28 dedupe round (orchestrator 2026-11-09, round-2 Q4): every 502 the relayer answers before any broadcast says
// so with `"broadcast": false`, so gas_sponsor can map it to Unavailable (nothing sent). Any 502 without it (a proxy's,
// say) stays OutcomeUnknown there. After a broadcast the relayer never answers 502 (round 2, MEDIUM 5).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNetworks } from '../../src/config.js';
import { getAddress } from 'viem';
import { HubError } from '../../src/hub.js';
import { createPipeline } from '../../src/sends/pipeline.js';
import { createReality } from '../../src/sends/reality.js';
import { COMMUNITY, execBody, SAFE, startStub } from '../helpers/stub.js';
import { CHAIN, down, ME, quiet, refusal, setup, spentDay } from '../helpers/node.js';

const networks = loadNetworks();
const allowAll = { check: () => ({ ok: true }) };

async function exec(chainsOpts) {
  const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }], chainsOpts });
  try {
    const res = await s.call('POST', '/send/safe-exec', execBody(networks));
    return { res, sent: s.chains.calls.sent.length, spent: BigInt(s.cap.status().spentDayWei) };
  } finally {
    await s.close();
  }
}

function pipeline(node) {
  const ctx = setup({ node });
  const pipe = createPipeline({ config: { address: ME }, db: ctx.db, chains: ctx.node.chains, cap: ctx.cap, queue: ctx.queue, logger: quiet });
  return { ...ctx, send: () => pipe.send({ chainId: CHAIN, safe: SAFE, to: ME, selectorName: 'addProposal', data: '0x', kind: 'reality-add', list: allowAll }) };
}

describe('dedupe: a pre-broadcast 502 carries broadcast: false', () => {
  test('broadcast-flag: safe-exec, the fee estimate fails: 502 with broadcast false, nothing sent or held', async () => {
    const { res, sent, spent } = await exec({ feeError: down() });
    assert.equal(res.status, 502, res.text);
    assert.equal(res.json.broadcast, false);
    assert.equal(sent, 0);
    assert.equal(spent, 0n);
  });

  test('broadcast-flag: safe-exec, the node refuses the send: 502 with broadcast false, nothing held', async () => {
    const { res, spent } = await exec({ sendError: refusal('insufficient funds for gas * price + value') });
    assert.equal(res.status, 502, res.text);
    assert.equal(res.json.broadcast, false);
    assert.equal(spent, 0n);
  });

  test('broadcast-flag: pipeline, the fee estimate fails: 502 with broadcast false', async () => {
    const p = pipeline({ feeError: down() });
    const out = await p.send();
    assert.equal(out.status, 502);
    assert.equal(out.body.broadcast, false);
    assert.equal(p.node.state.sent.length, 0);
  });

  test('broadcast-flag: pipeline, the node refuses the send: 502 with broadcast false, nothing held', async () => {
    const p = pipeline({ refuse: refusal('insufficient funds for gas * price + value') });
    const out = await p.send();
    assert.equal(out.status, 502);
    assert.equal(out.body.broadcast, false);
    assert.equal(spentDay(p.cap), 0n);
  });
});

describe('dedupe: the operator routes', () => {
  test('ops routes: GET /ops/recheck lists, POST /ops/recheck takes only a hash and answers what the chain says', async () => {
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }] });
    try {
      const sent = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(sent.status, 202, sent.text);
      const row = s.db.listPending()[0];
      s.db.updatePending(row.id, { ...row, status: 'stuck' });
      const list = await s.call('GET', '/ops/recheck');
      assert.equal(list.status, 200, list.text);
      assert.deepEqual(list.json.sends.map((r) => [r.hash, r.status]), [[sent.json.hash, 'stuck']]);
      const re = await s.call('POST', '/ops/recheck', { hash: sent.json.hash, status: 'mined' });
      assert.equal(re.status, 400, 'an outcome in the body is refused');
      const ok = await s.call('POST', '/ops/recheck', { hash: sent.json.hash });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json.hash, sent.json.hash);
      assert.equal(ok.json.status, 'pending', 'GET /sends/:hash view: stuck reads pending, nothing declared');
      const missing = await s.call('POST', '/ops/recheck', { hash: `0x${'99'.repeat(32)}` });
      assert.equal(missing.status, 404);
    } finally {
      await s.close();
    }
  });
});

describe('dedupe: Reality and ENS 502s before any send carry broadcast: false', () => {
  const v = { chainId: CHAIN, safe: SAFE, proposalId: `0x${'5c'.repeat(32)}` };
  function reality(error) {
    const ctx = setup();
    ctx.db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'a.eth', community: COMMUNITY });
    const answerer = { async evaluate() { throw error; }, decideFromVerdict() { throw new Error('unreachable'); } };
    return createReality({
      db: ctx.db, config: { configured: true, address: ME }, networks, chains: ctx.node.chains, cap: ctx.cap, queue: ctx.queue,
      groupModules: { async modulesFor() { return [getAddress(`0x${'4d'.repeat(20)}`)]; } }, hub: null, answerer, logger: quiet,
    });
  }

  test('broadcast-flag: reality, the hub cannot be read: 502 with broadcast false', async () => {
    const out = await reality(new HubError('hub_unavailable')).add(v);
    assert.equal(out.status, 502);
    assert.deepEqual(out.body, { error: 'hub_unavailable', broadcast: false });
  });

  test('broadcast-flag: reality, the hub rate-limits: 503 as before, no 502 flag', async () => {
    const out = await reality(new HubError('hub_rate_limited')).add(v);
    assert.equal(out.status, 503);
    assert.deepEqual(out.body, { error: 'hub_rate_limited' });
  });

  test('broadcast-flag: ens, the name availability cannot be read: 502 with broadcast false, nothing sent', async () => {
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth' }], chainsOpts: { readResult: new Error('rpc down') } });
    try {
      const res = await s.call('POST', '/send/ens', { chainId: CHAIN, safe: SAFE, label: 'gov-vectors' });
      assert.equal(res.status, 502, res.text);
      assert.deepEqual(res.json, { error: 'send_failed', reason: 'availability_unreadable', broadcast: false });
      assert.equal(s.chains.calls.send, 0);
    } finally {
      await s.close();
    }
  });
});
