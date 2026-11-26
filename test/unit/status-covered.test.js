// GET /status carries one mark per network: chains["<chainId>"].covered, JSON true when the fee service pays on that
// network (chainIsSponsored) and JSON false otherwise, on every network entry, an unreachable one included. The change is
// additive: nothing else in the answer moves. The same contract file is committed in gas_sponsor's tests
// (test/fixtures/status-coverage-contract.json); this file replays what the relayer side of it can check.
// Stubbed chain; no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNetworks } from '../../src/config.js';
import { startStub } from '../helpers/stub.js';

const contract = JSON.parse(readFileSync(new URL('../fixtures/status-coverage-contract.json', import.meta.url), 'utf8'));
const SEPOLIA = '11155111';
const BASE = '84532';

/** The shipped networks with one chain's `sponsoring` set as given (undefined removes the key). */
function networksWith(chainId, sponsoring) {
  const networks = structuredClone(loadNetworks());
  if (sponsoring === undefined) delete networks[chainId].sponsoring;
  else networks[chainId].sponsoring = sponsoring;
  return networks;
}

describe('status covered mark', () => {
  test('status-covered: a sponsored network is marked covered true, the configured unsponsored one is still listed with covered false', async () => {
    const s = await startStub();
    try {
      const res = await s.call('GET', '/status');
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(Object.keys(res.json.chains).sort(), [SEPOLIA, BASE], 'both configured networks are listed');
      assert.deepEqual(res.json.chains[SEPOLIA], { balanceWei: '5000000000000000000', pending: 0, covered: true });
      assert.deepEqual(res.json.chains[BASE], { balanceWei: '5000000000000000000', pending: 0, covered: false }, '84532 as shipped: sponsoring is off');
    } finally {
      await s.close();
    }
  });

  test('status-covered: the mark follows the network entry, not the chain id: sponsoring false turns a listed network off, no sponsoring key reads on', async () => {
    const off = await startStub({ networks: networksWith(SEPOLIA, false) });
    try {
      const res = await off.call('GET', '/status');
      assert.equal(res.json.chains[SEPOLIA].covered, false, 'a network that says sponsoring false is listed and not covered');
      assert.equal(res.json.chains[SEPOLIA].balanceWei, '5000000000000000000', 'its balance is still read');
    } finally {
      await off.close();
    }
    const on = await startStub({ networks: networksWith(BASE, undefined) });
    try {
      const res = await on.call('GET', '/status');
      assert.equal(res.json.chains[BASE].covered, true, 'with the sponsoring key removed the network is covered');
    } finally {
      await on.close();
    }
  });

  test('status-covered: an unreachable network still carries its mark, and nothing else in the entry changes', async () => {
    const s = await startStub({ chainsOpts: { unreachable: true } });
    try {
      const res = await s.call('GET', '/status');
      assert.deepEqual(res.json.chains[SEPOLIA], { error: 'unreachable', covered: true });
      assert.deepEqual(res.json.chains[BASE], { error: 'unreachable', covered: false });
    } finally {
      await s.close();
    }
  });

  test('status-covered: the answer is otherwise as it was: the same top-level keys, and a mark that is a JSON boolean on every entry', async () => {
    const s = await startStub();
    try {
      const res = await s.call('GET', '/status');
      assert.deepEqual(Object.keys(res.json).sort(), ['address', 'cap', 'chains', 'community', 'configured', 'createdFunds', 'groups']);
      for (const [id, entry] of Object.entries(res.json.chains)) assert.equal(typeof entry.covered, 'boolean', `chain ${id} carries a boolean mark`);
      assert.ok(res.text.includes('"covered":true') && res.text.includes('"covered":false'), 'the wire carries JSON true and false, never a string or a number');
    } finally {
      await s.close();
    }
  });

  // The contract file pins the site's reading (SponsorStatus::coversSafe) of an answer; the relayer can check the
  // answer's side: that the entries it describes are what status() emits for such a network, and that it never emits the
  // shapes the site treats as "no mark" or "wrong mark" (the c-* and d-* cases). Those cases' queries (what coversSafe
  // answers) and the createdFunds lists are the site's own and are not replayed here.
  describe('contract replay (relayer side)', () => {
    for (const [name, c] of Object.entries(contract.cases)) {
      const entry = c.chains[SEPOLIA];
      if (typeof entry.covered !== 'boolean') {
        test(`status-covered contract ${name}: a mark the site rejects is a shape the relayer never emits`, async () => {
          const s = await startStub();
          try {
            const res = await s.call('GET', '/status');
            for (const [id, e] of Object.entries(res.json.chains)) {
              assert.equal(typeof e.covered, 'boolean', `chain ${id}: the mark is present and a boolean`);
            }
          } finally {
            await s.close();
          }
        });
        continue;
      }
      test(`status-covered contract ${name}: status() emits the described entry and the listed groups`, async () => {
        const unreachable = entry.error === 'unreachable';
        const chainsOpts = unreachable ? { unreachable: [Number(SEPOLIA)] } : { balance: BigInt(entry.balanceWei), latest: 0, pending: entry.pending };
        const groups = c.groups.map((g) => ({ chainId: g.chainId, safe: g.safe, space: g.space, community: g.community }));
        const s = await startStub({ networks: networksWith(SEPOLIA, entry.covered ? undefined : false), chainsOpts, groups });
        try {
          const res = await s.call('GET', '/status');
          assert.equal(res.status, 200, res.text);
          assert.deepEqual(res.json.chains[SEPOLIA], entry, 'the network entry is exactly the one the contract describes');
          assert.equal(res.json.configured, contract.base.configured);
          // The contract's fund address is not in EIP-55 case and the relayer lists the checksummed form, so addresses compare by value.
          const shape = (g) => ({ chainId: g.chainId, safe: g.safe.toLowerCase(), space: g.space, community: g.community, module: g.module });
          assert.deepEqual(res.json.groups.map(shape).sort((a, b) => a.chainId - b.chainId), c.groups.map(shape).sort((a, b) => a.chainId - b.chainId), 'the groups are listed in the contract\'s shape');
        } finally {
          await s.close();
        }
      });
    }
  });
});
