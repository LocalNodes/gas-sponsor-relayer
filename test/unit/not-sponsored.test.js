// 25-28 round 3, #4 (Codex round 3 HIGH 4, ruling (b)): Base Sepolia's L1 data fee and operator fee are outside the
// spend cap, so the relayer does not sponsor sends on chain 84532 until Phase 30 counts the total OP-stack fee.
// A send there is refused with 503 {"error": "unavailable", "reason": "chain_not_sponsored"} before any reservation,
// gas estimate or broadcast: nothing is sent. Reads and GET /status for 84532 stay.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, zeroHash } from 'viem';
import { chainIsSponsored, loadConfig, loadNetworks } from '../../src/config.js';
import { createChains } from '../../src/chain.js';
import { createEns } from '../../src/sends/ens.js';
import { createPipeline } from '../../src/sends/pipeline.js';
import { createReality } from '../../src/sends/reality.js';
import { COMMUNITY, execBody, privateKeyOf, RELAYER_ACCOUNT, SAFE, startStub } from '../helpers/stub.js';
import { CHAIN, ME, quiet, setup, spentDay, tx } from '../helpers/node.js';

const networks = loadNetworks();
const BASE = 84532;
const REFUSED = { error: 'unavailable', reason: 'chain_not_sponsored' };
const allowAll = { check: () => ({ ok: true }) };

/** The scriptable node, with its one chain marked as not sponsored, as chain.js marks 84532. */
function offChain() {
  const ctx = setup();
  const get = ctx.node.chains.get;
  ctx.node.chains.get = (id) => {
    const c = get(id);
    return c ? { ...c, sponsored: false } : c;
  };
  return ctx;
}

describe('round 3 #4: no sponsoring on Base Sepolia', () => {
  test('not-sponsored: config/networks.json turns sponsoring off for 84532 only; chain.js marks its clients', () => {
    assert.equal(networks['84532'].sponsoring, false);
    assert.equal(chainIsSponsored(networks, 84532), false);
    assert.equal(chainIsSponsored(networks, 11155111), true);
    assert.equal(chainIsSponsored(networks, 999), false, 'a chain with no entry is not sponsored either');
    const config = loadConfig({ WEB3_ENABLED: 'true', SPONSOR_RELAYER_PRIVATE_KEY: privateKeyOf(RELAYER_ACCOUNT) }, networks);
    const chains = createChains({ config, networks });
    assert.equal(chains.get(84532).sponsored, false);
    assert.equal(chains.get(11155111).sponsored, true);
    assert.ok(chains.get(84532).publicClient, 'reads on 84532 stay');
  });

  test('not-sponsored: POST /send/safe-exec on 84532 is 503 chain_not_sponsored before any reservation, estimate or broadcast', async () => {
    const s = await startStub({ groups: [{ chainId: BASE, safe: SAFE, space: 'a.eth' }] });
    try {
      let estimates = 0;
      const get = s.chains.get.bind(s.chains);
      s.chains.get = (id) => {
        const c = get(id);
        if (!c) return c;
        const estimateGas = c.publicClient.estimateGas;
        c.publicClient.estimateGas = async (...a) => { estimates += 1; return estimateGas(...a); };
        return c;
      };
      const res = await s.call('POST', '/send/safe-exec', execBody(networks, { chainId: BASE }));
      assert.equal(res.status, 503, res.text);
      assert.deepEqual(res.json, REFUSED);
      assert.equal(s.chains.calls.send, 0);
      assert.equal(s.chains.calls.call, 0, 'no simulation');
      assert.equal(estimates, 0, 'no gas estimate');
      assert.deepEqual(s.db.openSpend(), [], 'no reservation');
      assert.equal(s.db.listPending().length, 0);

      // Sepolia is still sponsored.
      s.db.addGroup({ chainId: 11155111, safe: SAFE, space: 'a.eth', community: COMMUNITY });
      const ok = await s.call('POST', '/send/safe-exec', execBody(networks));
      assert.equal(ok.status, 202, ok.text);
    } finally {
      await s.close();
    }
  });

  test('not-sponsored: GET /status still reads 84532', async () => {
    const s = await startStub();
    try {
      const res = await s.call('GET', '/status');
      assert.equal(res.status, 200);
      assert.match(res.json.chains['84532'].balanceWei, /^[0-9]+$/);
    } finally {
      await s.close();
    }
  });

  test('not-sponsored: the pipeline (Reality steps, reclaim, the watcher\'s challenge) refuses before the reservation', async () => {
    const { db, cap, node, queue } = offChain();
    const pipe = createPipeline({ config: { address: ME }, db, chains: node.chains, cap, queue, logger: quiet });
    const out = await pipe.send({ chainId: CHAIN, safe: SAFE, to: ME, selectorName: 'addProposal', data: '0x', kind: 'reality-add', list: allowAll });
    assert.equal(out.ok, false);
    assert.equal(out.status, 503);
    assert.deepEqual(out.body, REFUSED);
    assert.deepEqual(db.openSpend(), []);
    assert.equal(spentDay(cap), 0n);
    assert.equal(node.state.sent.length, 0);
  });

  test('not-sponsored: the queue itself refuses a send on a chain that is not sponsored, before signing', async () => {
    const { db, node, queue } = offChain();
    let signed = 0;
    const sign = node.walletClient.signTransaction;
    node.walletClient.signTransaction = async (t) => { signed += 1; return sign(t); };
    await assert.rejects(queue.enqueue(CHAIN, () => tx(), {}), /chain_not_sponsored/);
    assert.equal(signed, 0);
    assert.equal(node.state.sent.length, 0);
    assert.equal(db.listPending().length, 0);
  });

  test('not-sponsored: POST /send/reality/* on a chain that is not sponsored is 503 chain_not_sponsored, nothing read or sent', async () => {
    const { db, cap, node, queue } = setup({ node: { read: () => { throw new Error('no read expected'); } } });
    const off = { ...networks, [CHAIN]: { ...networks[CHAIN], sponsoring: false } };
    db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'a.eth', community: COMMUNITY });
    let lookups = 0;
    const service = createReality({
      db, config: { configured: true, address: ME }, networks: off, chains: node.chains, cap, queue,
      groupModules: { async modulesFor() { lookups += 1; return [getAddress(`0x${'4d'.repeat(20)}`)]; } }, hub: null,
      answerer: { async evaluate() { throw new Error('no hub read expected'); } }, logger: quiet,
    });
    for (const step of ['add', 'answer']) {
      const out = await service[step]({ chainId: CHAIN, safe: SAFE, proposalId: zeroHash });
      assert.equal(out.status, 503, `${step}: ${JSON.stringify(out.body)}`);
      assert.deepEqual(out.body, REFUSED);
    }
    assert.equal(lookups, 0);
    assert.equal(node.state.sent.length, 0);
    assert.deepEqual(db.openSpend(), []);
  });

  test('not-sponsored: POST /send/ens on a chain with ENS but sponsoring off is 503 chain_not_sponsored, no job', async () => {
    const { db, cap, node, queue } = setup();
    const off = { ...networks, [CHAIN]: { ...networks[CHAIN], sponsoring: false } };
    db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth', community: COMMUNITY });
    const ens = createEns({ db, config: { configured: true, address: ME }, networks: off, chains: node.chains, cap, queue, logger: quiet });
    const out = await ens.request({ chainId: CHAIN, safe: SAFE, label: 'gov-vectors' });
    assert.equal(out.status, 503, JSON.stringify(out.body));
    assert.deepEqual(out.body, REFUSED);
    assert.equal(db.findOpenJob(CHAIN, 'gov-vectors'), null);
    assert.equal(node.state.sent.length, 0);
  });
});
