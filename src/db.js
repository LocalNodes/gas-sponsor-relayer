// sqlite through node:sqlite (Node 24). ":memory:" is allowed for tests.
import { DatabaseSync } from 'node:sqlite';
import { getAddress } from 'viem';

/**
 * The creations table (one slot per (site, Group, network), for ever: D-02). One text for the fresh CREATE and for the
 * in-place rebuild of an old database (D-17), so the two can never drift. call_target and call_data are the exact call
 * validated at the first claim, written once at insert and never changed (D-03, D-16): a retry of a not_sent slot sends
 * the same call to the same address (the retry reads them). A migrated old row has neither (NULL).
 */
const creationsTable = (name, ifNotExists) => `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
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
      call_target TEXT,
      call_data TEXT,
      actor_uuid TEXT NOT NULL,
      actor_address TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending', 'pending', 'not_sent')),
      dedupe_key TEXT NOT NULL,
      hash TEXT,
      -- The newest queue row id carrying dedupe_key when this send was claimed: only a later row is this send's.
      row_floor INTEGER NOT NULL DEFAULT 0,
      -- The counted attempt this send holds (creation_attempts.id), given back only when nothing was broadcast.
      attempt_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (site_uuid, group_uuid, chain_id)
    );`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      chain_id INTEGER NOT NULL,
      safe TEXT NOT NULL,
      space TEXT NOT NULL,
      community TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      PRIMARY KEY (chain_id, safe)
    );
    CREATE TABLE IF NOT EXISTS sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      safe TEXT NOT NULL,
      kind TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- Wei columns are TEXT holding decimal strings: spend is summed as BigInt, never as a float.
    CREATE TABLE IF NOT EXISTS spend (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      at INTEGER NOT NULL,
      wei TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('send', 'bond', 'credit')),
      ref TEXT NOT NULL,
      -- open: an unresolved reservation, counted in every current window whatever its time;
      -- settled: real spend (or a credit), counted by its time; released: given back, counted nowhere.
      state TEXT NOT NULL DEFAULT 'settled' CHECK (state IN ('open', 'settled', 'released')),
      -- A fee-bump increase is its own entry, pointing at the reservation it raises.
      parent_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS spend_at ON spend (at);
    CREATE INDEX IF NOT EXISTS spend_ref ON spend (ref);
    CREATE TABLE IF NOT EXISTS pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      nonce INTEGER NOT NULL,
      hash TEXT NOT NULL,
      hashes TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      data TEXT NOT NULL,
      value TEXT NOT NULL,
      gas TEXT NOT NULL,
      max_fee_per_gas TEXT NOT NULL,
      max_priority_fee_per_gas TEXT NOT NULL,
      sent_block TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      spend_id INTEGER,
      safe TEXT,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      -- The block read before the send's nonce: no transaction can take the nonce in an earlier block.
      first_block TEXT,
      -- The transaction that took the nonce and its block: one of the send's own hashes when it mined, another
      -- transaction when it was replaced (proven at the finalized block, queue.js).
      consumed_by TEXT,
      consumed_block TEXT,
      -- The hash of the block that holds the send's own receipt, while it is confirming and once it is mined: the
      -- receipt counts only while that block is still the chain's block at its height.
      mined_block_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS pending_chain_status ON pending (chain_id, status);
    -- Long-running sends that span several transactions (ENS registration). The secret is the
    -- commit-reveal secret; it never leaves this table.
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      safe TEXT NOT NULL,
      label TEXT NOT NULL,
      secret TEXT NOT NULL,
      status TEXT NOT NULL,
      hashes TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_label ON jobs (chain_id, label);
    -- Questions the relayer answered with a bond. The reclaim loop works through them:
    -- answered (bond paid) -> claimed (winnings assigned) -> done (withdrawn and credited, or nothing to claim).
    CREATE TABLE IF NOT EXISTS reality_questions (
      chain_id INTEGER NOT NULL,
      question_id TEXT NOT NULL,
      module TEXT NOT NULL,
      safe TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      answer TEXT NOT NULL,
      bond_wei TEXT NOT NULL,
      bond_ref TEXT NOT NULL,
      from_block TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chain_id, question_id)
    );
    -- Alerts and audit lines. events.js serves the feed types over GET /events; the safe, module, question and
    -- proposal columns are filled where the event is about one Group and one question.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      chain_id INTEGER,
      detail TEXT NOT NULL,
      safe TEXT,
      module TEXT,
      question_id TEXT,
      proposal_id TEXT
    );
    -- Questions asked to a Group's module, as the wrong-answer watcher sees them. 'open' until Reality says
    -- the question is final. The flag and bond columns make each alert and each challenge happen once per wrong answer.
    CREATE TABLE IF NOT EXISTS questions (
      chain_id INTEGER NOT NULL,
      question_id TEXT NOT NULL,
      module TEXT NOT NULL,
      safe TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      question_hash TEXT NOT NULL,
      created_block TEXT NOT NULL,
      status TEXT NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0,
      challenged_bond TEXT,
      challenge_nonce INTEGER,
      challenge_attempts INTEGER NOT NULL DEFAULT 0,
      escalated_bond TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (chain_id, question_id)
    );
    -- Small key/value state: the watcher's block cursors and its low-balance flag.
    CREATE TABLE IF NOT EXISTS cursors (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Sponsored fund creation (creations.js): one slot per (site, Group, network), for ever (D-02). Nothing in the API
    -- resets it. status is what the relayer last did: sending (claimed, no hash yet), pending (handed to the queue with
    -- hash), not_sent (nothing broadcast; the same intent may send again). Mined, confirmed or failed come from the
    -- queue row. call_target and call_data (the exact call validated at the first claim, written once and never
    -- changed) are in creationsTable above.
    ${creationsTable('creations', true)}
    -- Funded creation attempts for the rolling 24-hour quotas, per network. counted from the claim; returned only when
    -- nothing was broadcast. at is in seconds.
    CREATE TABLE IF NOT EXISTS creation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_uuid TEXT NOT NULL,
      group_uuid TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      actor_uuid TEXT NOT NULL,
      at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('counted', 'returned'))
    );
    CREATE INDEX IF NOT EXISTS creation_attempts_site ON creation_attempts (site_uuid, state, at);
    -- The site this relayer serves, learned from the site itself (POST /site). One row at most (id is always 1); the
    -- first claim wins and is permanent. Nothing in this file changes or removes the row, and no route can: the only
    -- ways out are the operator's own siteUuid in the policy file or a fresh volume (D-05, D-20, TM-281). at is in seconds.
    CREATE TABLE IF NOT EXISTS site_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      site_uuid TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    );
  `);
  // An older database has the five-column events table; add the Group and question columns.
  const eventColumns = new Set(db.prepare('PRAGMA table_info(events)').all().map((c) => c.name));
  for (const c of ['safe', 'module', 'question_id', 'proposal_id']) {
    if (!eventColumns.has(c)) db.exec(`ALTER TABLE events ADD COLUMN ${c} TEXT`);
  }
  // An older database has no first block or consuming hash on a send. A send never bumped was
  // first broadcast at its sent block; a bumped one has lost that block, so no proof can release it (only a receipt
  // of its own settles it).
  const pendingColumns = new Set(db.prepare('PRAGMA table_info(pending)').all().map((c) => c.name));
  if (!pendingColumns.has('first_block')) {
    db.exec('ALTER TABLE pending ADD COLUMN first_block TEXT');
    db.exec('UPDATE pending SET first_block = sent_block WHERE attempts = 0');
  }
  // held_reason: why a send is held for an operator to look at (queue.js needsOperator), or null.
  // dedupe_key: the request a send answers (safe-exec: Safe and Safe nonce; Reality: question), or null.
  // receipt_status (fund creation): 'success' or 'reverted' from the send's own receipt while it is confirming or mined,
  // else null. A creation slot reads confirmed or failed from it.
  for (const c of ['consumed_by', 'consumed_block', 'mined_block_hash', 'held_reason', 'dedupe_key', 'receipt_status']) {
    if (!pendingColumns.has(c)) db.exec(`ALTER TABLE pending ADD COLUMN ${c} TEXT`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS pending_dedupe ON pending (chain_id, dedupe_key)');
  // An older database has no spend state: every entry was settled, except a reservation whose
  // send is still waiting, which is unresolved.
  const spendColumns = new Set(db.prepare('PRAGMA table_info(spend)').all().map((c) => c.name));
  if (!spendColumns.has('state')) {
    db.exec("ALTER TABLE spend ADD COLUMN state TEXT NOT NULL DEFAULT 'settled'");
    db.exec("UPDATE spend SET state = 'open' WHERE id IN (SELECT spend_id FROM pending WHERE status IN ('pending', 'stuck', 'confirming') AND spend_id IS NOT NULL)");
  }
  if (!spendColumns.has('parent_id')) db.exec('ALTER TABLE spend ADD COLUMN parent_id INTEGER');
  // A relayer database made before one slot per network (D-02) has creations keyed (site_uuid, group_uuid) and attempts
  // with no chain_id. It is rebuilt in place at start (D-17), in one transaction: every column of every slot is copied
  // by name, so a claimed slot and its fixed address survive, and a failure rolls everything back. A migrated slot has
  // no stored call (a retry sends such a not_sent slot through the full path, whose prediction check still refuses
  // any address but the stored one). A migrated attempt takes its slot's network; one whose slot is gone keeps a NULL
  // chain and counts on no network. Old databases exist only on dev and DDEV volumes (the deployed image 550c0f2 has no
  // creations table). No Drupal update hook is involved.
  const creationKey = db.prepare('PRAGMA table_info(creations)').all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(',');
  const rebuildSlots = creationKey === 'site_uuid,group_uuid';
  const backfillAttempts = !new Set(db.prepare('PRAGMA table_info(creation_attempts)').all().map((c) => c.name)).has('chain_id');
  if (rebuildSlots || backfillAttempts) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (rebuildSlots) {
        const old = 'site_uuid, group_uuid, intent_uuid, digest, chain_id, safe_version, owners, threshold, salt_nonce, predicted_address, actor_uuid, actor_address, status, dedupe_key, hash, row_floor, attempt_id, created_at, updated_at';
        db.exec(creationsTable('creations_new', false));
        db.exec(`INSERT INTO creations_new (${old}) SELECT ${old} FROM creations`);
        db.exec('DROP TABLE creations');
        db.exec('ALTER TABLE creations_new RENAME TO creations');
      }
      if (backfillAttempts) {
        db.exec('ALTER TABLE creation_attempts ADD COLUMN chain_id INTEGER');
        db.exec('UPDATE creation_attempts SET chain_id = (SELECT c.chain_id FROM creations c WHERE c.site_uuid = creation_attempts.site_uuid AND c.group_uuid = creation_attempts.group_uuid) WHERE chain_id IS NULL');
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS creation_attempts_site_chain ON creation_attempts (site_uuid, chain_id, state, at)');
  const insertGroup = db.prepare('INSERT INTO groups (chain_id, safe, space, community, registered_at) VALUES (?, ?, ?, ?, ?)');
  const getGroup = db.prepare('SELECT chain_id, safe, space, community FROM groups WHERE chain_id = ? AND safe = ?');
  const allGroups = db.prepare('SELECT chain_id, safe, space, community FROM groups ORDER BY chain_id, safe');
  const replaceSpace = db.prepare('UPDATE groups SET space = ?, community = ?, registered_at = ? WHERE chain_id = ? AND safe = ? AND space = ?');
  const insertSend = db.prepare('INSERT INTO sends (chain_id, safe, kind, tx_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const SPEND = 'id, chain_id, at, wei, kind, ref, state, parent_id';
  const insertSpend = db.prepare('INSERT INTO spend (chain_id, at, wei, kind, ref, state, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updateSpendWei = db.prepare('UPDATE spend SET wei = ? WHERE id = ?');
  const deleteSpend = db.prepare('DELETE FROM spend WHERE id = ?');
  const spendAfter = db.prepare(`SELECT ${SPEND} FROM spend WHERE at >= ? AND state = 'settled' ORDER BY at, id`);
  const openSpend = db.prepare(`SELECT ${SPEND} FROM spend WHERE state = 'open' ORDER BY at, id`);
  const spendByRef = db.prepare(`SELECT ${SPEND} FROM spend WHERE ref = ? AND kind = ? AND state != 'released' AND parent_id IS NULL ORDER BY id LIMIT 1`);
  const spendById = db.prepare(`SELECT ${SPEND} FROM spend WHERE id = ?`);
  const spendParts = db.prepare(`SELECT ${SPEND} FROM spend WHERE parent_id = ? AND state = 'open' ORDER BY id`);
  const settleSpend = db.prepare("UPDATE spend SET wei = ?, at = ?, state = 'settled' WHERE id = ?");
  const deleteSpendParts = db.prepare('DELETE FROM spend WHERE parent_id = ?');
  const releaseSpend = db.prepare("UPDATE spend SET state = 'released' WHERE (id = ? OR parent_id = ?) AND state = 'open'");
  const reopenSpend = db.prepare("UPDATE spend SET state = 'open' WHERE (id = ? OR parent_id = ?) AND state = 'released'");
  const insertPending = db.prepare(
    'INSERT INTO pending (chain_id, nonce, hash, hashes, to_addr, data, value, gas, max_fee_per_gas, max_priority_fee_per_gas, sent_block, attempts, status, spend_id, safe, kind, created_at, first_block, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
  );
  // A send that happened or may still happen. A replaced one never did, so a new send may take its place.
  const pendingByKey = db.prepare("SELECT * FROM pending WHERE chain_id = ? AND dedupe_key = ? AND status IN ('pending', 'stuck', 'confirming', 'mined') ORDER BY id DESC LIMIT 1");
  const setHeldReason = db.prepare('UPDATE pending SET held_reason = ? WHERE id = ?');
  const pendingByHash = db.prepare('SELECT p.* FROM pending p WHERE EXISTS (SELECT 1 FROM json_each(p.hashes) j WHERE lower(j.value) = ?) ORDER BY p.id DESC LIMIT 1');
  const listPending = db.prepare('SELECT * FROM pending ORDER BY chain_id, nonce, id');
  const getPending = db.prepare('SELECT * FROM pending WHERE id = ?');
  const deletePending = db.prepare('DELETE FROM pending WHERE id = ?');
  const deleteUntouchedPending = db.prepare("DELETE FROM pending WHERE id = ? AND status = 'pending' AND attempts = 0 AND hash = ? AND hashes = ?");
  // A stuck send still holds its nonce: the node may have forgotten it, but it can still mine.
  // So does a confirming one: a reorg can put it back in the pool.
  const maxPendingNonce = db.prepare("SELECT MAX(nonce) AS n FROM pending WHERE chain_id = ? AND status IN ('pending', 'stuck', 'confirming')");
  const updatePending = db.prepare(
    'UPDATE pending SET hash = ?, hashes = ?, max_fee_per_gas = ?, max_priority_fee_per_gas = ?, sent_block = ?, attempts = ?, status = ?, consumed_by = ?, consumed_block = ?, mined_block_hash = ?, receipt_status = ? WHERE id = ?',
  );
  const insertJob = db.prepare('INSERT INTO jobs (id, kind, chain_id, safe, label, secret, status, hashes, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)');
  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const jobsFor = db.prepare('SELECT * FROM jobs WHERE chain_id = ? AND safe = ? AND label = ? ORDER BY created_at, id');
  const openJob = db.prepare("SELECT * FROM jobs WHERE chain_id = ? AND label = ? AND status IN ('pending', 'committed') ORDER BY created_at LIMIT 1");
  const updateJob = db.prepare('UPDATE jobs SET status = ?, hashes = ?, error = ?, updated_at = ? WHERE id = ?');
  const failOpenJobs = db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('pending', 'committed')");
  const insertQuestion = db.prepare(
    'INSERT OR IGNORE INTO reality_questions (chain_id, question_id, module, safe, proposal_id, answer, bond_wei, bond_ref, from_block, tx_hash, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
  );
  const getQuestion = db.prepare('SELECT * FROM reality_questions WHERE chain_id = ? AND question_id = ?');
  const openQuestions = db.prepare("SELECT * FROM reality_questions WHERE status IN ('answered', 'claimed') ORDER BY created_at, question_id");
  const updateQuestion = db.prepare('UPDATE reality_questions SET status = ?, error = ?, updated_at = ? WHERE chain_id = ? AND question_id = ?');
  const insertEvent = db.prepare('INSERT INTO events (at, kind, chain_id, detail, safe, module, question_id, proposal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const listEvents = db.prepare('SELECT id, at, kind, chain_id, detail, safe, module, question_id, proposal_id FROM events ORDER BY id');
  const insertWatched = db.prepare(
    'INSERT OR IGNORE INTO questions (chain_id, question_id, module, safe, proposal_id, question_hash, created_block, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const getWatched = db.prepare('SELECT * FROM questions WHERE chain_id = ? AND question_id = ?');
  const openWatched = db.prepare("SELECT * FROM questions WHERE status = 'open' ORDER BY created_at, chain_id, question_id");
  const getCursor = db.prepare('SELECT value FROM cursors WHERE key = ?');
  const setCursor = db.prepare('INSERT INTO cursors (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const deleteCursor = db.prepare('DELETE FROM cursors WHERE key = ?');
  const pendingLatestByKey = db.prepare('SELECT * FROM pending WHERE chain_id = ? AND dedupe_key = ? ORDER BY id DESC LIMIT 1');
  const getCreation = db.prepare('SELECT * FROM creations WHERE site_uuid = ? AND group_uuid = ? AND chain_id = ?');
  const insertCreation = db.prepare(
    'INSERT INTO creations (site_uuid, group_uuid, intent_uuid, digest, chain_id, safe_version, owners, threshold, salt_nonce, predicted_address, call_target, call_data, actor_uuid, actor_address, status, dedupe_key, hash, row_floor, attempt_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
  );
  const updateCreation = db.prepare('UPDATE creations SET status = ?, hash = ?, actor_uuid = ?, actor_address = ?, row_floor = ?, attempt_id = ?, updated_at = ? WHERE site_uuid = ? AND group_uuid = ? AND chain_id = ?');
  const claimSite = db.prepare('INSERT OR IGNORE INTO site_binding (id, site_uuid, bound_at) VALUES (1, ?, ?)');
  const readSite = db.prepare('SELECT site_uuid FROM site_binding WHERE id = 1');
  const creationsByStatus = db.prepare('SELECT * FROM creations WHERE status = ? ORDER BY created_at, site_uuid, group_uuid');
  const insertAttempt = db.prepare("INSERT INTO creation_attempts (site_uuid, group_uuid, chain_id, actor_uuid, at, state) VALUES (?, ?, ?, ?, ?, 'counted')");
  const returnAttempt = db.prepare("UPDATE creation_attempts SET state = 'returned' WHERE id = ? AND state = 'counted'");
  const siteAttempts = db.prepare("SELECT at FROM creation_attempts WHERE site_uuid = ? AND chain_id = ? AND state = 'counted' AND at > ? ORDER BY at, id");
  const actorAttempts = db.prepare("SELECT at FROM creation_attempts WHERE site_uuid = ? AND chain_id = ? AND actor_uuid = ? AND state = 'counted' AND at > ? ORDER BY at, id");
  const toCreation = (r) => ({
    siteUuid: r.site_uuid,
    groupUuid: r.group_uuid,
    intentUuid: r.intent_uuid,
    digest: r.digest,
    chainId: Number(r.chain_id),
    safeVersion: r.safe_version,
    owners: JSON.parse(r.owners),
    threshold: Number(r.threshold),
    saltNonce: r.salt_nonce,
    predictedAddress: r.predicted_address,
    callTarget: r.call_target ?? null,
    callData: r.call_data ?? null,
    actorUuid: r.actor_uuid,
    actorAddress: r.actor_address,
    status: r.status,
    dedupeKey: r.dedupe_key,
    hash: r.hash ?? null,
    rowFloor: Number(r.row_floor),
    attemptId: r.attempt_id === null ? null : Number(r.attempt_id),
  });
  const toSpend = (r) => ({
    id: Number(r.id),
    chainId: Number(r.chain_id),
    at: Number(r.at),
    wei: BigInt(r.wei),
    kind: r.kind,
    ref: r.ref,
    state: r.state,
    parentId: r.parent_id === null ? null : Number(r.parent_id),
  });
  const toPending = (r) => ({
    id: Number(r.id),
    chainId: Number(r.chain_id),
    nonce: Number(r.nonce),
    hash: r.hash,
    hashes: JSON.parse(r.hashes),
    to: r.to_addr,
    data: r.data,
    value: r.value,
    gas: r.gas,
    maxFeePerGas: r.max_fee_per_gas,
    maxPriorityFeePerGas: r.max_priority_fee_per_gas,
    sentBlock: r.sent_block,
    attempts: Number(r.attempts),
    status: r.status,
    spendId: r.spend_id === null ? null : Number(r.spend_id),
    safe: r.safe,
    kind: r.kind,
    firstBlock: r.first_block ?? null,
    consumedBy: r.consumed_by ?? null,
    consumedBlock: r.consumed_block ?? null,
    minedBlockHash: r.mined_block_hash ?? null,
    heldReason: r.held_reason ?? null,
    dedupeKey: r.dedupe_key ?? null,
    receiptStatus: r.receipt_status ?? null,
  });
  const toJob = (r) => ({
    id: r.id,
    kind: r.kind,
    chainId: Number(r.chain_id),
    safe: getAddress(r.safe),
    label: r.label,
    secret: r.secret,
    status: r.status,
    hashes: JSON.parse(r.hashes),
    error: r.error ?? null,
  });
  const toQuestion = (r) => ({
    chainId: Number(r.chain_id),
    questionId: r.question_id,
    module: getAddress(r.module),
    safe: getAddress(r.safe),
    proposalId: r.proposal_id,
    answer: r.answer,
    bondWei: BigInt(r.bond_wei),
    bondRef: r.bond_ref,
    fromBlock: BigInt(r.from_block),
    txHash: r.tx_hash,
    status: r.status,
    error: r.error ?? null,
  });
  const toWatched = (r) => ({
    chainId: Number(r.chain_id),
    questionId: r.question_id,
    module: getAddress(r.module),
    safe: getAddress(r.safe),
    proposalId: r.proposal_id,
    questionHash: r.question_hash,
    createdBlock: BigInt(r.created_block),
    status: r.status,
    flagged: Number(r.flagged) === 1,
    challengedBond: r.challenged_bond ?? null,
    challengeNonce: r.challenge_nonce === null ? null : Number(r.challenge_nonce),
    challengeAttempts: Number(r.challenge_attempts),
    escalatedBond: r.escalated_bond ?? null,
  });
  const toEvent = (r) => ({
    id: Number(r.id),
    at: Number(r.at),
    kind: r.kind,
    chainId: r.chain_id === null ? null : Number(r.chain_id),
    detail: r.detail,
    safe: r.safe ?? null,
    module: r.module ?? null,
    questionId: r.question_id ?? null,
    proposalId: r.proposal_id ?? null,
  });
  // JSON for the detail column: a BigInt (a bond, a balance) is written as a decimal string, never thrown on.
  const detailText = (d) => (typeof d === 'string' ? d : JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  // Columns the watcher may change on a question row (camelCase name -> column).
  const WATCHED_COLUMNS = {
    status: 'status',
    flagged: 'flagged',
    challengedBond: 'challenged_bond',
    challengeNonce: 'challenge_nonce',
    challengeAttempts: 'challenge_attempts',
    escalatedBond: 'escalated_bond',
  };
  const toGroup = (r) => ({ chainId: Number(r.chain_id), safe: getAddress(r.safe), space: r.space, community: r.community });
  return {
    /**
     * Run `fn` (synchronous) inside one write transaction and return its result; roll back if it throws.
     * BEGIN IMMEDIATE takes the write lock first, so what `fn` reads cannot change before it writes.
     */
    atomically(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    addGroup({ chainId, safe, space, community }) {
      insertGroup.run(chainId, safe.toLowerCase(), space, community, Math.floor(Date.now() / 1000));
    },
    getGroup(chainId, safe) {
      const r = getGroup.get(chainId, String(safe).toLowerCase());
      return r ? toGroup(r) : null;
    },
    listGroups() {
      return allGroups.all().map(toGroup);
    },
    /** Swap the Group's space from `from` to `space` in its one row; returns 1 if it was swapped, else 0. */
    replaceGroupSpace({ chainId, safe, from, space, community }) {
      return Number(replaceSpace.run(space, community, Math.floor(Date.now() / 1000), chainId, String(safe).toLowerCase(), from).changes);
    },
    recordSend({ chainId, safe, kind, txHash }) {
      insertSend.run(chainId, safe.toLowerCase(), kind, txHash, 'pending', Math.floor(Date.now() / 1000));
    },
    // Spend ledger (cap.js). `wei` is a BigInt. `state` is 'settled' unless given ('open' for a reservation).
    insertSpend({ chainId, at, wei, kind, ref, state = 'settled', parentId = null }) {
      return Number(insertSpend.run(chainId, at, wei.toString(), kind, ref, state, parentId).lastInsertRowid);
    },
    /** Every unresolved reservation and bump increase, whatever its time. */
    openSpend() {
      return openSpend.all().map(toSpend);
    },
    /** The unresolved bump increases of reservation `id`. */
    spendParts(id) {
      return spendParts.all(id).map(toSpend);
    },
    /** The reservation becomes real spend: `wei` at time `at`; its increases are folded into it. */
    settleSpend(id, wei, at) {
      settleSpend.run(wei.toString(), at, id);
      deleteSpendParts.run(id);
    },
    /** Give back an unresolved reservation and its increases. Settled spend is never given back. */
    releaseSpend(id) {
      releaseSpend.run(id, id);
    },
    /** Hold a given-back reservation and its increases again, whole (a send marked replaced whose own hash mined). */
    reopenSpend(id) {
      reopenSpend.run(id, id);
    },
    updateSpendWei(id, wei) {
      updateSpendWei.run(wei.toString(), id);
    },
    deleteSpend(id) {
      deleteSpend.run(id);
    },
    /** Every settled entry with `at >= sinceMs`, oldest first. */
    spendSince(sinceMs) {
      return spendAfter.all(sinceMs).map(toSpend);
    },
    findSpend(ref, kind) {
      const r = spendByRef.get(ref, kind);
      return r ? toSpend(r) : null;
    },
    getSpend(id) {
      const r = spendById.get(id);
      return r ? toSpend(r) : null;
    },
    // Sends waiting for a receipt (queue.js).
    insertPending(p) {
      return Number(
        insertPending.run(
          p.chainId, p.nonce, p.hash, JSON.stringify([p.hash]), p.to, p.data, p.value.toString(), p.gas.toString(),
          p.maxFeePerGas.toString(), p.maxPriorityFeePerGas.toString(), p.sentBlock.toString(), 'pending',
          p.spendId ?? null, p.safe ?? null, p.kind, Math.floor(Date.now() / 1000), (p.firstBlock ?? p.sentBlock).toString(), p.dedupeKey ?? null,
        ).lastInsertRowid,
      );
    },
    listPending() {
      return listPending.all().map(toPending);
    },
    getPending(id) {
      const r = getPending.get(id);
      return r ? toPending(r) : null;
    },
    /** Only for a send the node definitely refused: no broadcast of it exists (queue.js). */
    deletePending(id) {
      deletePending.run(id);
    },
    /**
     * Delete a send's row only while it is exactly as first stored: still pending, never bumped, its one hash `hash`.
     * Returns true when it was deleted. An older broadcast's answer can never delete newer state.
     */
    deleteUntouchedPending(id, hash) {
      return Number(deleteUntouchedPending.run(id, hash, JSON.stringify([hash])).changes) === 1;
    },
    /** Highest nonce among sends still waiting on this chain (pending, stuck or confirming), or null. */
    maxPendingNonce(chainId) {
      const n = maxPendingNonce.get(chainId)?.n;
      return n === null || n === undefined ? null : Number(n);
    },
    updatePending(id, p) {
      updatePending.run(
        p.hash, JSON.stringify(p.hashes), p.maxFeePerGas.toString(), p.maxPriorityFeePerGas.toString(), p.sentBlock.toString(), p.attempts, p.status,
        p.consumedBy ?? null, p.consumedBlock === null || p.consumedBlock === undefined ? null : p.consumedBlock.toString(), p.minedBlockHash ?? null,
        // A receipt's outcome holds only while the send is confirming or mined: back to pending (a reorg) clears it.
        p.status === 'confirming' || p.status === 'mined' ? (p.receiptStatus ?? null) : null, id,
      );
    },
    /** Mark (or clear, with null) why a send is held for an operator. */
    setHeldReason(id, reason) {
      setHeldReason.run(reason ?? null, id);
    },
    /** The send on this chain that carries `dedupeKey` and is pending, stuck, confirming or mined (never replaced), or null. */
    findDuplicate(chainId, dedupeKey) {
      const r = pendingByKey.get(chainId, dedupeKey);
      return r ? toPending(r) : null;
    },
    /** The send that has had `hash` as one of its hashes (any case), or null. */
    findPendingByHash(hash) {
      const r = pendingByHash.get(String(hash).toLowerCase());
      return r ? toPending(r) : null;
    },
    // Multi-transaction jobs (sends/ens.js).
    insertJob({ id, kind, chainId, safe, label, secret }) {
      const now = Date.now();
      insertJob.run(id, kind, chainId, safe.toLowerCase(), label, secret, 'pending', '[]', now, now);
    },
    getJob(id) {
      const r = getJob.get(String(id));
      return r ? toJob(r) : null;
    },
    /** Every job this Safe has had for this label, oldest first, whatever its status. */
    listJobsFor(chainId, safe, label) {
      return jobsFor.all(chainId, String(safe).toLowerCase(), label).map(toJob);
    },
    /** A job for this label that has not finished (pending or committed), or null. */
    findOpenJob(chainId, label) {
      const r = openJob.get(chainId, label);
      return r ? toJob(r) : null;
    },
    updateJob(id, { status, hashes, error = null }) {
      updateJob.run(status, JSON.stringify(hashes), error, Date.now(), id);
    },
    /** Mark every unfinished job failed; returns how many there were. */
    failOpenJobs(error) {
      return Number(failOpenJobs.run(error, Date.now()).changes);
    },
    // Questions the relayer answered with a bond (sends/reality.js, reclaim.js).
    insertQuestion(q) {
      const now = Date.now();
      insertQuestion.run(q.chainId, q.questionId, q.module.toLowerCase(), q.safe.toLowerCase(), q.proposalId, q.answer, q.bondWei.toString(), q.bondRef, q.fromBlock.toString(), q.txHash, 'answered', now, now);
    },
    getQuestion(chainId, questionId) {
      const r = getQuestion.get(chainId, questionId);
      return r ? toQuestion(r) : null;
    },
    /** Questions whose bond has not been dealt with yet (status answered or claimed). */
    listOpenQuestions() {
      return openQuestions.all().map(toQuestion);
    },
    updateQuestion(chainId, questionId, { status, error = null }) {
      updateQuestion.run(status, error, Date.now(), chainId, questionId);
    },
    /** Store an event row and return its id. `detail` may hold BigInt values; they are stored as decimal strings. */
    insertEvent({ kind, chainId = null, detail, safe = null, module = null, questionId = null, proposalId = null }) {
      return Number(insertEvent.run(Date.now(), kind, chainId, detailText(detail), safe, module, questionId, proposalId).lastInsertRowid);
    },
    listEvents() {
      return listEvents.all().map(toEvent);
    },
    /** Up to `limit` events of the given kinds with id > since, oldest first (the GET /events feed). */
    listEventsSince(since, limit, kinds) {
      const marks = kinds.map(() => '?').join(', ');
      const rows = db.prepare(`SELECT id, at, kind, chain_id, detail, safe, module, question_id, proposal_id FROM events WHERE id > ? AND kind IN (${marks}) ORDER BY id LIMIT ?`).all(since, ...kinds, limit);
      return rows.map(toEvent);
    },
    // Questions the wrong-answer watcher follows (watcher.js).
    insertWatched(q) {
      insertWatched.run(q.chainId, q.questionId, q.module.toLowerCase(), q.safe.toLowerCase(), q.proposalId, q.questionHash, q.createdBlock.toString(), 'open', Date.now());
    },
    getWatched(chainId, questionId) {
      const r = getWatched.get(chainId, questionId);
      return r ? toWatched(r) : null;
    },
    listOpenWatched() {
      return openWatched.all().map(toWatched);
    },
    updateWatched(chainId, questionId, patch) {
      const keys = Object.keys(patch).filter((k) => Object.hasOwn(WATCHED_COLUMNS, k));
      if (keys.length === 0) return;
      const sets = keys.map((k) => `${WATCHED_COLUMNS[k]} = ?`).join(', ');
      const values = keys.map((k) => (typeof patch[k] === 'boolean' ? Number(patch[k]) : patch[k]));
      db.prepare(`UPDATE questions SET ${sets} WHERE chain_id = ? AND question_id = ?`).run(...values, chainId, questionId);
    },
    getCursor(key) {
      return getCursor.get(key)?.value ?? null;
    },
    setCursor(key, value) {
      setCursor.run(key, String(value));
    },
    deleteCursor(key) {
      deleteCursor.run(key);
    },
    /** The newest send on this chain that carries `dedupeKey`, whatever its status (replaced too), or null. */
    findLatestByDedupeKey(chainId, dedupeKey) {
      const r = pendingLatestByKey.get(chainId, dedupeKey);
      return r ? toPending(r) : null;
    },
    // Fund creation slots and attempts (creations.js, sends/safeCreate.js).
    getCreation(siteUuid, groupUuid, chainId) {
      const r = getCreation.get(siteUuid, groupUuid, chainId);
      return r ? toCreation(r) : null;
    },
    insertCreation(c, at) {
      insertCreation.run(
        c.siteUuid, c.groupUuid, c.intentUuid, c.digest, c.chainId, c.safeVersion, JSON.stringify(c.owners), c.threshold, String(c.saltNonce),
        c.predictedAddress, c.callTarget ?? null, c.callData ?? null, c.actorUuid, c.actorAddress, c.status, c.dedupeKey, c.rowFloor ?? 0, c.attemptId ?? null, at, at,
      );
    },
    /** Change a slot's state. Its intent never changes: only the status, hash, actor and send bookkeeping. */
    updateCreation(c, at) {
      updateCreation.run(c.status, c.hash ?? null, c.actorUuid, c.actorAddress, c.rowFloor ?? 0, c.attemptId ?? null, at, c.siteUuid, c.groupUuid, c.chainId);
    },
    listCreations(status) {
      return creationsByStatus.all(status).map(toCreation);
    },
    /** Count one funded attempt at `at` (seconds); returns its id. */
    insertCreationAttempt({ siteUuid, groupUuid, chainId, actorUuid }, at) {
      return Number(insertAttempt.run(siteUuid, groupUuid, chainId, actorUuid, at).lastInsertRowid);
    },
    /** Give an attempt back (nothing was broadcast). Returns true when it was counted until now. */
    returnCreationAttempt(id) {
      return Number(returnAttempt.run(id).changes) === 1;
    },
    /** Times (seconds) of the counted attempts on one network after `since`, oldest first: the site's, or one actor's on the site. */
    countedCreationAttempts(siteUuid, chainId, since, actorUuid = null) {
      const rows = actorUuid === null ? siteAttempts.all(siteUuid, chainId, since) : actorAttempts.all(siteUuid, chainId, actorUuid, since);
      return rows.map((r) => Number(r.at));
    },
    /**
     * Claim the site for this relayer: the first claim stores `siteUuid` (seconds `nowS`), every later claim leaves the
     * row as it is. Returns {siteUuid: the stored site, created: whether this call stored it}. There is deliberately
     * no way to change or remove the binding (D-05, TM-281).
     */
    bindSite(siteUuid, nowS) {
      return this.atomically(() => {
        const changes = Number(claimSite.run(siteUuid, nowS).changes);
        return { siteUuid: readSite.get().site_uuid, created: changes === 1 };
      });
    },
    /** The stored site, or null while the relayer is unbound. */
    siteBinding() {
      return readSite.get()?.site_uuid ?? null;
    },
    close() {
      db.close();
    },
  };
}
