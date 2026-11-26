// D-26: GET /status lists the funds this relayer created for its bound site whose creation is confirmed, in a key
// apart from `groups`: the list POST /send/safe-exec counts for D-24, so the site's one question ("does the fee
// service pay for a send from this fund") has one answer. Every other key of the body is as it was (the body only ever
// gains keys). The test reaches every state through the routes and the slot's own queue row only. Stubbed chain; no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadNetworks } from '../../src/config.js';
import { DISABLED_POLICY, parseCreationPolicy } from '../../src/creations.js';
import { createServer } from '../../src/server.js';
import { dedupeKeyOf } from '../../src/sends/safeCreate.js';
import { execBody, privateKeyOf, RELAYER_ACCOUNT, SAFE, startStub, TOKEN } from '../helpers/stub.js';

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

/**
 * Rewrites the slot's stored row in the database file, as a database handle of its own, while the stub keeps running:
 * the state safeCreate() leaves when settleTo() throws after the send is out (its status stays 'sending').
 * The stub is never restarted for this: recoverCreations() at start would settle the slot and hide the defect.
 */
function storeSlotAs(dbPath, status, rowFloor = null) {
  const raw = new DatabaseSync(dbPath);
  try {
    const set = rowFloor === null ? 'status = ?, hash = NULL' : 'status = ?, hash = NULL, row_floor = ?';
    const args = rowFloor === null ? [status] : [status, rowFloor];
    const done = raw.prepare(`UPDATE creations SET ${set} WHERE site_uuid = ? AND group_uuid = ? AND chain_id = ?`).run(...args, REQ.siteUuid, REQ.groupUuid, CHAIN);
    assert.equal(Number(done.changes), 1, 'the slot was rewritten');
  } finally {
    raw.close();
  }
}

describe('status created funds (D-26)', () => {
  test('status-created-funds D-26: a fund is listed once its creation is confirmed, not in groups, and POST /send/safe-exec accepts what is listed', async () => {
    const s = await stub();
    try {
      const first = await create(s);
      assert.equal(first.status, 202, first.text);
      const early = await s.call('GET', '/status');
      assert.equal(early.status, 200, early.text);
      assert.deepEqual(early.json.createdFunds, [], 'not listed while its creation is pending');
      receipt(s, first.json.hash, 'success');
      const status = await s.call('GET', '/status');
      assert.equal(status.status, 200, status.text);
      assert.deepEqual(status.json.createdFunds, [{ chainId: CHAIN, safe: FUND }]);
      assert.equal(status.json.groups.some((g) => g.safe.toLowerCase() === FUND.toLowerCase()), false, 'a created fund is never a group');
      const sent = await exec(s);
      assert.equal(sent.status, 202, `the status lists what safe-exec accepts: ${sent.text}`);
    } finally {
      await s.close();
    }
  });

  test('status-created-funds D-26: a confirmed creation whose slot stayed sending is listed once and safe-exec accepts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-created-funds-'));
    const dbPath = join(dir, 'relayer.db');
    try {
      const s = await stub({ dbPath });
      try {
        await confirmed(s);
        storeSlotAs(dbPath, 'sending');
        const status = await s.call('GET', '/status');
        assert.equal(status.status, 200, status.text);
        assert.deepEqual(status.json.createdFunds, [{ chainId: CHAIN, safe: FUND }], 'listed exactly once');
        assert.equal(status.json.groups.length, 0);
        const sent = await exec(s);
        assert.equal(sent.status, 202, sent.text);
      } finally {
        await s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status-created-funds D-26: a slot stored as sending with no queue row of its own is in neither list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-created-funds-'));
    const dbPath = join(dir, 'relayer.db');
    try {
      const s = await stub({ dbPath });
      try {
        await confirmed(s);
        // The slot's floor above every queue row: claimed, nothing sent (no row of its own).
        storeSlotAs(dbPath, 'sending', 1_000_000);
        const status = await s.call('GET', '/status');
        assert.deepEqual(status.json.createdFunds, []);
        assert.deepEqual(status.json.groups, []);
        const sent = await exec(s);
        assert.equal(sent.status, 403, sent.text);
        assert.equal(sent.json.reason, 'safe_not_registered');
      } finally {
        await s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status-created-funds D-26: a slot whose receipt reverted is in neither list, and safe-exec refuses it', async () => {
    const s = await stub();
    try {
      const first = await create(s);
      receipt(s, first.json.hash, 'reverted');
      assert.equal((await s.call('GET', `/creations/${REQ.groupUuid}`)).json.status, 'failed');
      const status = await s.call('GET', '/status');
      assert.deepEqual(status.json.createdFunds, []);
      assert.deepEqual(status.json.groups, []);
      const sent = await exec(s);
      assert.equal(sent.status, 403, sent.text);
      assert.equal(sent.json.reason, 'safe_not_registered');
    } finally {
      await s.close();
    }
  });

  test('status-created-funds D-26: a slot left not_sent is in neither list', async () => {
    const s = await stub({ chainsOpts: { feeError: new Error('rpc down') } });
    try {
      const first = await create(s);
      assert.notEqual(first.status, 202, first.text);
      assert.equal((await s.call('GET', `/creations/${REQ.groupUuid}`)).json.status, 'not_sent');
      const status = await s.call('GET', '/status');
      assert.deepEqual(status.json.createdFunds, []);
      assert.deepEqual(status.json.groups, []);
    } finally {
      await s.close();
    }
  });

  test('status-created-funds D-26: a slot confirmed for one site is not listed by a relayer bound to another site', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-created-funds-'));
    const dbPath = join(dir, 'relayer.db');
    try {
      const a = await stub({ dbPath });
      try {
        await confirmed(a);
        assert.deepEqual((await a.call('GET', '/status')).json.createdFunds, [{ chainId: CHAIN, safe: FUND }], 'the site that created it lists it');
      } finally {
        await a.close();
      }
      const b = await stub({ dbPath, creationPolicy: policyOf({ siteUuid: '00000000-0000-4000-8000-0000000000b2' }) });
      try {
        const status = await b.call('GET', '/status');
        assert.equal(status.status, 200, status.text);
        assert.deepEqual(status.json.createdFunds, []);
        const sent = await exec(b);
        assert.equal(sent.status, 403, sent.text);
        assert.equal(sent.json.reason, 'safe_not_registered');
      } finally {
        await b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status-created-funds D-26: a registered group stays in groups only, a created fund in createdFunds only', async () => {
    const s = await stub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }] });
    try {
      const before = await s.call('GET', '/status');
      assert.deepEqual(before.json.groups.map((g) => [g.chainId, g.safe.toLowerCase(), g.space]), [[CHAIN, SAFE.toLowerCase(), 'a.eth']]);
      assert.deepEqual(before.json.createdFunds, [], 'a registered group is not a created fund');
      await confirmed(s);
      const after = await s.call('GET', '/status');
      assert.deepEqual(after.json.groups.map((g) => g.safe.toLowerCase()), [SAFE.toLowerCase()], 'groups are as before');
      assert.deepEqual(after.json.createdFunds, [{ chainId: CHAIN, safe: FUND }], 'only the created fund');
    } finally {
      await s.close();
    }
  });

  test('status-created-funds D-26: the keys keep their order with createdFunds last, and every existing key keeps its bytes', async () => {
    const s = await stub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }] });
    try {
      await confirmed(s);
      const res = await s.call('GET', '/status');
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(Object.keys(res.json), ['configured', 'address', 'community', 'chains', 'cap', 'groups', 'createdFunds']);
      const { createdFunds: list, ...rest } = res.json;
      const without = JSON.stringify(rest);
      assert.equal(res.text, `${without.slice(0, -1)},"createdFunds":${JSON.stringify(list)}}`);
      assert.equal(list.length, 1);
    } finally {
      await s.close();
    }
  });

  test('status-created-funds D-26: a relayer with no site answers createdFunds [], also over a database that holds a confirmed fund', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-created-funds-'));
    const dbPath = join(dir, 'relayer.db');
    try {
      const a = await stub({ dbPath });
      try {
        await confirmed(a);
      } finally {
        await a.close();
      }
      const b = await startStub({ dbPath, creationPolicy: DISABLED_POLICY, now: () => NOW, capNow: () => NOW });
      try {
        const res = await b.call('GET', '/status');
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(res.json.createdFunds, []);
        assert.equal(res.text.endsWith(',"createdFunds":[]}'), true);
      } finally {
        await b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status-created-funds D-26: with web3 off GET /status answers 503 web3_disabled and nothing else', async () => {
    const config = loadConfig({ SPONSOR_RELAYER_PRIVATE_KEY: privateKeyOf(RELAYER_ACCOUNT), SPONSOR_RELAYER_TOKEN: TOKEN }, networks);
    const logger = { info() {}, warn() {}, error() {} };
    const server = createServer({ config, networks, db: null, chains: null, cap: null, queue: null, logger });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: 'web3_disabled' });
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    }
  });
});
