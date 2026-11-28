// An old relayer database (one creation slot per site and Group, attempts without a network) opens with the
// per-network slot key (D-02, D-17): rows kept, attempts given their slot's network, a second open a no-op, and a
// failed rebuild rolls back. Real files in a temp directory; no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/db.js';

// The creations and creation_attempts tables of an older relayer, before one slot per network, copied as they were.
const OLD_SCHEMA = `
    CREATE TABLE IF NOT EXISTS creations (
      site_uuid TEXT NOT NULL,
      group_uuid TEXT NOT NULL,
      intent_uuid TEXT NOT NULL,
      digest TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      safe_version TEXT NOT NULL,
      owners TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      salt_nonce TEXT NOT NULL,
      predicted_address TEXT NOT NULL,
      actor_uuid TEXT NOT NULL,
      actor_address TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending', 'pending', 'not_sent')),
      dedupe_key TEXT NOT NULL,
      hash TEXT,
      row_floor INTEGER NOT NULL DEFAULT 0,
      attempt_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (site_uuid, group_uuid)
    );
    CREATE TABLE IF NOT EXISTS creation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_uuid TEXT NOT NULL,
      group_uuid TEXT NOT NULL,
      actor_uuid TEXT NOT NULL,
      at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('counted', 'returned'))
    );
    CREATE INDEX IF NOT EXISTS creation_attempts_site ON creation_attempts (site_uuid, state, at);
`;

const SITE = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const CHAIN = 11155111;
const OWNER_A = '0x00000000000000000000000000000000000000a1';
const OWNER_B = '0x00000000000000000000000000000000000000b2';
const SLOT = {
  siteUuid: SITE,
  groupUuid: GROUP,
  intentUuid: '33333333-3333-4333-8333-333333333333',
  digest: `0x${'ab'.repeat(32)}`,
  chainId: CHAIN,
  safeVersion: '1.4.1',
  owners: [OWNER_A, OWNER_B],
  threshold: 2,
  saltNonce: '123456789',
  predictedAddress: '0x00000000000000000000000000000000000000c3',
  actorUuid: '44444444-4444-4444-8444-444444444444',
  actorAddress: OWNER_A,
  status: 'pending',
  dedupeKey: `safe-create:${SITE}:${GROUP}`,
  hash: `0x${'cd'.repeat(32)}`,
  rowFloor: 7,
  attemptId: 1,
};

/** A relayer file as 601e78e made it: one slot, one counted attempt and one returned attempt. */
function oldFile(dir, { withSlot = true, extra = '' } = {}) {
  const path = join(dir, 'relayer.db');
  const old = new DatabaseSync(path);
  try {
    old.exec(OLD_SCHEMA);
    if (extra) old.exec(extra);
    if (withSlot) {
      old.prepare('INSERT INTO creations (site_uuid, group_uuid, intent_uuid, digest, chain_id, safe_version, owners, threshold, salt_nonce, predicted_address, actor_uuid, actor_address, status, dedupe_key, hash, row_floor, attempt_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(SLOT.siteUuid, SLOT.groupUuid, SLOT.intentUuid, SLOT.digest, SLOT.chainId, SLOT.safeVersion, JSON.stringify(SLOT.owners), SLOT.threshold, SLOT.saltNonce, SLOT.predictedAddress, SLOT.actorUuid, SLOT.actorAddress, SLOT.status, SLOT.dedupeKey, SLOT.hash, SLOT.rowFloor, SLOT.attemptId, 1000, 2000);
      old.prepare("INSERT INTO creation_attempts (site_uuid, group_uuid, actor_uuid, at, state) VALUES (?, ?, ?, ?, 'counted')").run(SITE, GROUP, SLOT.actorUuid, 5000);
      old.prepare("INSERT INTO creation_attempts (site_uuid, group_uuid, actor_uuid, at, state) VALUES (?, ?, ?, ?, 'returned')").run(SITE, GROUP, SLOT.actorUuid, 6000);
    }
  } finally {
    old.close();
  }
  return path;
}

/** Read a file with a plain connection: the primary key columns of creations, its rows and its attempts' columns. */
function inspect(path) {
  const raw = new DatabaseSync(path);
  try {
    const pk = raw.prepare('PRAGMA table_info(creations)').all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const attemptColumns = raw.prepare('PRAGMA table_info(creation_attempts)').all().map((c) => c.name);
    const slots = raw.prepare('SELECT * FROM creations ORDER BY site_uuid, group_uuid, chain_id').all().map((r) => ({ ...r }));
    const attempts = raw.prepare('SELECT * FROM creation_attempts ORDER BY id').all().map((r) => ({ ...r }));
    return { pk, attemptColumns, slots, attempts };
  } finally {
    raw.close();
  }
}

/** A failed start must not leave its transaction open: another connection can still take the write lock. */
function assertUnlocked(path) {
  const raw = new DatabaseSync(path);
  try {
    raw.exec('BEGIN IMMEDIATE');
    raw.exec('ROLLBACK');
  } finally {
    raw.close();
  }
}

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'db-migration-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('db-migration (unit)', () => {
  test('db-migration: a 601e78e file opens with the per-network key, keeps its slot and attempts, and backfills the network', () => inTempDir((dir) => {
    const path = oldFile(dir);
    assert.deepEqual(inspect(path).pk, ['site_uuid', 'group_uuid']);
    const db = openDb(path);
    try {
      const slot = db.getCreation(SITE, GROUP, CHAIN);
      assert.deepEqual(slot, { ...SLOT, callTarget: null, callData: null });
      assert.equal(db.getCreation(SITE, GROUP, 84532), null);
      // Both attempts carry the slot's network; only the counted one counts.
      assert.equal(db.countedCreationAttempts(SITE, CHAIN, 0).length, 1);
      assert.deepEqual(db.countedCreationAttempts(SITE, CHAIN, 0), [5000]);
      assert.equal(db.countedCreationAttempts(SITE, 84532, 0).length, 0);
      assert.equal(db.returnCreationAttempt(1), true);
      assert.equal(db.countedCreationAttempts(SITE, CHAIN, 0).length, 0);
      // The rebuilt table takes a second network for the same site and Group.
      db.insertCreation({ ...SLOT, chainId: 84532, callTarget: '0xfeed', callData: '0xbeef' }, 9000);
      assert.equal(db.getCreation(SITE, GROUP, 84532).callData, '0xbeef');
    } finally {
      db.close();
    }
    const after = inspect(path);
    assert.deepEqual(after.pk, ['site_uuid', 'group_uuid', 'chain_id']);
    assert.ok(after.attemptColumns.includes('chain_id'));
    assert.deepEqual(after.attempts.map((a) => a.chain_id), [CHAIN, CHAIN]);
    assert.deepEqual(after.attempts.map((a) => a.at), [5000, 6000]);
  }));

  test('db-migration: opening a migrated file again changes nothing and does not throw', () => inTempDir((dir) => {
    const path = oldFile(dir);
    openDb(path).close();
    const once = inspect(path);
    openDb(path).close();
    openDb(path).close();
    assert.deepEqual(inspect(path), once);
    assert.deepEqual(once.pk, ['site_uuid', 'group_uuid', 'chain_id']);
    assert.equal(once.slots.length, 1);
    assert.equal(once.attempts.length, 2);
  }));

  test('db-migration: a file from before fund creation (no creations table) opens with the per-network key', () => inTempDir((dir) => {
    const path = join(dir, 'relayer.db');
    const bare = new DatabaseSync(path);
    bare.exec('CREATE TABLE cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    bare.close();
    const db = openDb(path);
    db.close();
    const got = inspect(path);
    assert.deepEqual(got.pk, ['site_uuid', 'group_uuid', 'chain_id']);
    assert.ok(got.attemptColumns.includes('chain_id'));
    assert.equal(got.slots.length, 0);
  }));

  test('db-migration: a questions table without the asking time or the question key opens with them, empty, and keeps its rows', () => inTempDir((dir) => {
    const path = join(dir, 'relayer.db');
    const bare = new DatabaseSync(path);
    bare.exec(`CREATE TABLE questions (
      chain_id INTEGER NOT NULL, question_id TEXT NOT NULL, module TEXT NOT NULL, safe TEXT NOT NULL, proposal_id TEXT NOT NULL,
      question_hash TEXT NOT NULL, created_block TEXT NOT NULL, status TEXT NOT NULL, flagged INTEGER NOT NULL DEFAULT 0,
      challenged_bond TEXT, challenge_nonce INTEGER, challenge_attempts INTEGER NOT NULL DEFAULT 0, escalated_bond TEXT,
      created_at INTEGER NOT NULL, PRIMARY KEY (chain_id, question_id))`);
    const qid = `0x${'aa'.repeat(32)}`;
    bare.prepare("INSERT INTO questions (chain_id, question_id, module, safe, proposal_id, question_hash, created_block, status, created_at) VALUES (1, ?, ?, ?, 'p', 'h', '42', 'open', 1)")
      .run(qid, `0x${'11'.repeat(20)}`, `0x${'22'.repeat(20)}`);
    bare.close();
    const db = openDb(path);
    try {
      const row = db.getWatched(1, qid);
      assert.equal(row.createdBlock, 42n);
      assert.equal(row.createdTs, null);
      assert.equal(row.createdFinal, false);
      db.updateWatched(1, qid, { createdFinal: true });
      assert.equal(db.getWatched(1, qid).createdFinal, true);
      db.updateWatched(1, qid, { createdTs: '1700000000' });
      assert.equal(db.getWatched(1, qid).createdTs, 1_700_000_000n);
      // No whole-question key either: empty until the question's log is read again.
      assert.equal(row.questionKey, null);
      db.updateWatched(1, qid, { questionKey: `0x${'cd'.repeat(32)}`, proposalId: '', questionHash: '' });
      const read = db.getWatched(1, qid);
      assert.equal(read.questionKey, `0x${'cd'.repeat(32)}`);
      assert.equal(read.proposalId, '');
    } finally {
      db.close();
    }
  }));

  test('db-migration: a rebuild that fails at its first step throws and leaves the old table and its row', () => inTempDir((dir) => {
    // A table named creations_new is already there, so the rebuild cannot create its own.
    const path = oldFile(dir, { extra: 'CREATE TABLE creations_new (x INTEGER)' });
    const before = inspect(path);
    assert.throws(() => openDb(path), /creations_new/);
    assertUnlocked(path);
    const after = inspect(path);
    assert.deepEqual(after.pk, ['site_uuid', 'group_uuid']);
    assert.deepEqual(after, before);
    assert.equal(after.slots.length, 1);
  }));

  test('db-migration: a rebuild that fails after the old table was replaced is rolled back whole', () => inTempDir((dir) => {
    // The attempts backfill is the last step: a trigger refuses it, after the slots were copied, dropped and renamed.
    const path = oldFile(dir, { extra: "CREATE TRIGGER refuse_backfill BEFORE UPDATE ON creation_attempts BEGIN SELECT RAISE(ABORT, 'refused'); END" });
    const before = inspect(path);
    assert.throws(() => openDb(path), /refused/);
    assertUnlocked(path);
    const after = inspect(path);
    assert.deepEqual(after.pk, ['site_uuid', 'group_uuid']);
    assert.equal(after.attemptColumns.includes('chain_id'), false);
    assert.deepEqual(after, before);
    assert.equal(after.slots.length, 1);
    const raw = new DatabaseSync(path);
    try {
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'creations_new'").get().n, 0);
    } finally {
      raw.close();
    }
  }));
});
