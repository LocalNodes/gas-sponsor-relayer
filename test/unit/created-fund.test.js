// D-24: a fund this relayer created for its site counts as registered for POST /send/safe-exec once its own creation
// receipt succeeded, with no space and no POST /groups. The test reaches every state through the routes and the queue
// row only (no db helper of the creation slot), against the shared contract fixture. Stubbed chain; no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNetworks } from '../../src/config.js';
import { DISABLED_POLICY, parseCreationPolicy } from '../../src/creations.js';
import { dedupeKeyOf } from '../../src/sends/safeCreate.js';
import { execBody, SAFE, startStub } from '../helpers/stub.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/fund-creation-contract.json', import.meta.url), 'utf8'));
const networks = loadNetworks();
const REQ = fx.request;
const NOW = REQ.issuedAt * 1000;
const CHAIN = REQ.chainId;
const FUND = REQ.predictedAddress;
const policyOf = (over = {}) => parseCreationPolicy({ enabled: true, siteUuid: REQ.siteUuid, groups: [REQ.groupUuid], limits: { perActorPerDay: 1, perSitePerDay: 3 }, ...over }).policy;

async function stub(opts = {}) {
  return startStub({ creationPolicy: policyOf(), now: () => NOW, capNow: () => NOW, ...opts });
}
const create = (s) => s.call('POST', '/send/safe-create', REQ);
const exec = (s, over = {}) => s.call('POST', '/send/safe-exec', execBody(networks, { safe: FUND, ...over }));

/** The slot's own queue row gets a receipt, as the queue's poll loop would store it. */
function receipt(s, hash, receiptStatus) {
  const row = s.db.findLatestByDedupeKey(CHAIN, dedupeKeyOf(REQ.siteUuid, REQ.groupUuid));
  s.db.updatePending(row.id, { ...row, status: 'confirming', consumedBy: hash, consumedBlock: 5n, minedBlockHash: `0x${'cd'.repeat(32)}`, receiptStatus });
}

/** A created fund whose creation receipt succeeded. */
async function confirmed(s) {
  const first = await create(s);
  assert.equal(first.status, 202, first.text);
  receipt(s, first.json.hash, 'success');
  return first;
}

describe('created fund (D-24)', () => {
  test('created-fund D-24: a created fund is refused while its creation is pending and sent once the creation receipt succeeded', async () => {
    const s = await stub();
    try {
      const first = await create(s);
      assert.equal(first.status, 202, first.text);
      assert.equal(s.chains.calls.send, 1);
      const early = await exec(s);
      assert.equal(early.status, 403, early.text);
      assert.equal(early.json.reason, 'safe_not_registered');
      assert.equal(s.chains.calls.send, 1, 'nothing sent for a fund whose creation is not confirmed');
      receipt(s, first.json.hash, 'success');
      const res = await exec(s);
      assert.equal(res.status, 202, res.text);
      assert.equal(s.chains.calls.send, 2);
      assert.equal(s.chains.calls.sent.at(-1).to.toLowerCase(), FUND.toLowerCase());
    } finally {
      await s.close();
    }
  });

  test('created-fund D-24: the fund is in the allow-list too: an owner-signed send to it is sent to the fund itself', async () => {
    const s = await stub();
    try {
      await confirmed(s);
      const res = await exec(s);
      assert.equal(res.status, 202, res.text);
      assert.match(res.json.hash, /^0x[0-9a-f]{64}$/);
      assert.equal(s.chains.calls.call, 1, 'simulated once');
      assert.equal(s.chains.calls.sent.at(-1).to.toLowerCase(), FUND.toLowerCase());
    } finally {
      await s.close();
    }
  });

  test('created-fund D-24: the address counts in lower case and checksummed', async () => {
    const s = await stub();
    try {
      await confirmed(s);
      for (const form of [FUND.toLowerCase(), FUND]) {
        const res = await exec(s, { safe: form });
        assert.equal(res.status, 202, `${form}: ${res.text}`);
      }
    } finally {
      await s.close();
    }
  });

  test('created-fund D-24: a slot whose receipt reverted never counts', async () => {
    const s = await stub();
    try {
      const first = await create(s);
      receipt(s, first.json.hash, 'reverted');
      assert.equal((await s.call('GET', `/creations/${REQ.groupUuid}`)).json.status, 'failed');
      const sends = s.chains.calls.send;
      const res = await exec(s);
      assert.equal(res.status, 403, res.text);
      assert.equal(res.json.reason, 'safe_not_registered');
      assert.equal(s.chains.calls.send, sends);
    } finally {
      await s.close();
    }
  });

  test('created-fund D-24: a slot left not_sent never counts', async () => {
    const s = await stub({ chainsOpts: { feeError: new Error('rpc down') } });
    try {
      const first = await create(s);
      assert.notEqual(first.status, 202, first.text);
      assert.equal((await s.call('GET', `/creations/${REQ.groupUuid}`)).json.status, 'not_sent');
      for (const _ of [0, 1]) {
        const res = await exec(s);
        assert.equal(res.status, 403, res.text);
        assert.equal(res.json.reason, 'safe_not_registered');
        delete s.chains.options.feeError;
      }
      assert.equal(s.chains.calls.send, 0);
    } finally {
      await s.close();
    }
  });

  test('created-fund D-24: another site, or no site, does not count a slot confirmed for the first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'created-fund-'));
    const dbPath = join(dir, 'relayer.db');
    try {
      const a = await stub({ dbPath });
      try {
        await confirmed(a);
        assert.equal((await exec(a)).status, 202, 'the site that created it counts it');
      } finally {
        await a.close();
      }
      const otherSite = '00000000-0000-4000-8000-0000000000b2';
      for (const [name, creationPolicy] of [['another site', policyOf({ siteUuid: otherSite })], ['no site', DISABLED_POLICY]]) {
        const b = await stub({ dbPath, creationPolicy });
        try {
          const res = await exec(b);
          assert.equal(res.status, 403, `${name}: ${res.text}`);
          assert.equal(res.json.reason, 'safe_not_registered', name);
          assert.equal(b.chains.calls.send, 0, name);
        } finally {
          await b.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('created-fund D-24: it counts on its own chain and at its own address only', async () => {
    const s = await stub();
    try {
      await confirmed(s);
      const sends = s.chains.calls.send;
      const otherChain = await exec(s, { chainId: 84532 });
      assert.equal(otherChain.status, 403, otherChain.text);
      assert.equal(otherChain.json.reason, 'safe_not_registered');
      const otherSafe = await exec(s, { safe: SAFE });
      assert.equal(otherSafe.status, 403, otherSafe.text);
      assert.equal(otherSafe.json.reason, 'safe_not_registered');
      assert.equal(s.chains.calls.send, sends, 'nothing sent for the refused ones');
      assert.equal((await exec(s)).status, 202, 'the created fund itself passes');
      assert.equal(s.chains.calls.send, sends + 1);
    } finally {
      await s.close();
    }
  });

  test('created-fund D-24: naming is unchanged: /send/ens still refuses it and GET /status lists no group for it', async () => {
    const s = await stub();
    try {
      await confirmed(s);
      const sends = s.chains.calls.send;
      const ens = await s.call('POST', '/send/ens', { chainId: CHAIN, safe: FUND, label: 'gov-vectors' });
      assert.equal(ens.status, 403, ens.text);
      assert.equal(ens.json.reason, 'safe_not_registered');
      const status = await s.call('GET', '/status');
      assert.equal(status.status, 200, status.text);
      assert.equal(status.json.groups.some((g) => g.safe.toLowerCase() === FUND.toLowerCase()), false, 'no group entry for the created fund');
      assert.equal(s.chains.calls.send, sends);
    } finally {
      await s.close();
    }
  });
});
