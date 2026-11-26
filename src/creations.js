// Sponsored fund creation: the operator's policy, the per-Group creation slot and the attempt quotas.
//
// The policy is a file the operator edits (config/fund-creation.json, or SPONSOR_RELAYER_FUND_CREATION_CONFIG). It is
// read once at start; no route can change it, enroll a Group or reset a slot. A missing, unreadable or invalid file
// means creation is off (fail closed). Rollback is `"enabled": false` and a restart.
//
// An enabled policy may leave siteUuid empty (D-07): the site then binds itself. The site comes from the policy's siteUuid
// when that is set (the operator's word wins), else from the site itself:
// POST /site binds the relayer to the first site that asks, for ever (db.bindSite). Still no route rebinds or unbinds,
// enrols a Group, changes a limit or resets a slot.
//
// A slot is one per (site, Group, network), for ever (D-02). Its stored status is what the relayer last did: sending (claimed, no
// hash yet), pending (handed to the queue) or not_sent (nothing broadcast). What the chain did is read from the
// slot's own queue row (status and receipt outcome), so this file never runs a receipt engine of its own.
import { readFileSync } from 'node:fs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DAY_S = 86400;
export const DEFAULT_POLICY_PATH = new URL('../config/fund-creation.json', import.meta.url);
const POLICY_KEYS = ['enabled', 'groups', 'limits', 'siteUuid'];
const LIMIT_KEYS = ['perActorPerDay', 'perSitePerDay'];
const MAX_LIMIT = 1000;

/** Creation off, with no site of its own (a stored binding still counts). A policy file that cannot be read gives UNREADABLE_POLICY instead. */
export const DISABLED_POLICY = Object.freeze({ enabled: false, siteUuid: '', groups: Object.freeze([]), limits: Object.freeze({ perActorPerDay: 1, perSitePerDay: 3 }) });
/**
 * What a policy file that cannot be read or is invalid gives: creation off and NO site (fail closed). It has the shape
 * of DISABLED_POLICY but is its own object, so boundSite() can tell it from a valid file that turns creation off on
 * purpose, which keeps a stored binding.
 */
export const UNREADABLE_POLICY = Object.freeze({ enabled: false, siteUuid: '', groups: Object.freeze([]), limits: Object.freeze({ perActorPerDay: 1, perSitePerDay: 3 }) });

const sameKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join('|') === keys.join('|');

/** Check a parsed policy file. Returns {ok, policy} (frozen) or {ok: false, error}. */
export function parseCreationPolicy(value) {
  if (!sameKeys(value, POLICY_KEYS)) return { ok: false, error: `the policy has exactly the keys ${POLICY_KEYS.join(', ')}` };
  if (typeof value.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (typeof value.siteUuid !== 'string' || (value.siteUuid !== '' && !UUID.test(value.siteUuid))) return { ok: false, error: 'siteUuid must be a lower-case UUID' };
  if (!Array.isArray(value.groups) || value.groups.some((g) => typeof g !== 'string' || !UUID.test(g)) || new Set(value.groups).size !== value.groups.length) {
    return { ok: false, error: 'groups must be distinct lower-case UUIDs' };
  }
  if (!sameKeys(value.limits, LIMIT_KEYS) || LIMIT_KEYS.some((k) => !Number.isInteger(value.limits[k]) || value.limits[k] < 1 || value.limits[k] > MAX_LIMIT)) {
    return { ok: false, error: `limits are perActorPerDay and perSitePerDay, whole numbers from 1 to ${MAX_LIMIT}` };
  }
  return {
    ok: true,
    policy: Object.freeze({
      enabled: value.enabled,
      siteUuid: value.siteUuid,
      groups: Object.freeze([...value.groups]),
      limits: Object.freeze({ perActorPerDay: value.limits.perActorPerDay, perSitePerDay: value.limits.perSitePerDay }),
    }),
  };
}

/** Read the policy file once. Any problem gives UNREADABLE_POLICY (creation off, bound to no site) and one log line. */
export function loadCreationPolicy({ env = process.env, path = env.SPONSOR_RELAYER_FUND_CREATION_CONFIG || DEFAULT_POLICY_PATH, logger = console } = {}) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    logger.warn(`gas-sponsor-relayer: fund creation off: the policy file could not be read (${e?.code ?? e?.name ?? 'Error'})`);
    return UNREADABLE_POLICY;
  }
  const parsed = parseCreationPolicy(value);
  if (!parsed.ok) {
    logger.warn(`gas-sponsor-relayer: fund creation off: the policy file is invalid (${parsed.error})`);
    return UNREADABLE_POLICY;
  }
  return parsed.policy;
}

/**
 * Whether a new funded attempt on `chainId` fits that network's rolling 24-hour quotas at `nowS` (seconds). Returns null when it fits, or
 * {scope: 'actor'|'site', until} where `until` (seconds) is when the oldest attempt in the way leaves the window.
 */
export function quotaVerdict(db, policy, siteUuid, chainId, actorUuid, nowS) {
  const since = nowS - DAY_S;
  const checks = [
    ['actor', policy.limits.perActorPerDay, db.countedCreationAttempts(siteUuid, chainId, since, actorUuid)],
    ['site', policy.limits.perSitePerDay, db.countedCreationAttempts(siteUuid, chainId, since)],
  ];
  for (const [scope, limit, times] of checks) {
    if (times.length >= limit) return { scope, until: times[times.length - limit] + DAY_S };
  }
  return null;
}

/**
 * A slot's status and hash as callers see them. Only queue rows newer than the slot's floor are its own send.
 *   not_sent                          -> not_sent
 *   own row replaced                  -> not_sent (its nonce went to another transaction; the same intent may resend)
 *   own row pending or stuck          -> pending
 *   own row confirming or mined       -> confirmed (receipt success), failed (receipt reverted), else pending
 *   no own row                        -> sending (claimed, nothing stored yet), or the slot's stored state
 * Confirmed and failed hold from the first receipt: a reorg puts the row back to pending, and this view with it.
 */
export function slotState(db, slot) {
  if (slot.status === 'not_sent') return { status: 'not_sent', hash: null };
  const row = db.findLatestByDedupeKey(slot.chainId, slot.dedupeKey);
  if (!row || row.id <= slot.rowFloor) return { status: slot.status, hash: slot.status === 'pending' ? slot.hash : null };
  if (row.status === 'replaced') return { status: 'not_sent', hash: null };
  const hash = row.consumedBy ?? row.hash;
  if (row.status === 'confirming' || row.status === 'mined') {
    if (row.receiptStatus === 'success') return { status: 'confirmed', hash };
    if (row.receiptStatus === 'reverted') return { status: 'failed', hash };
  }
  return { status: 'pending', hash };
}

/**
 * The site this relayer creates funds for: the operator's `policy.siteUuid` when it is a non-empty string (D-20), else the
 * site stored by POST /site (D-05), else null (unbound: creation answers site_mismatch, nothing is created or counted).
 * A policy file that could not be read (UNREADABLE_POLICY) is always null: it fails closed.
 */
export function boundSite(policy, db) {
  // A policy file that could not be read binds no site: never a stored binding the operator may have overridden.
  if (policy === UNREADABLE_POLICY) return null;
  if (typeof policy?.siteUuid === 'string' && policy.siteUuid !== '') return policy.siteUuid;
  return db?.siteBinding() ?? null;
}

/**
 * The funds this relayer created for `siteUuid` whose creation is confirmed, as [{ chainId, safe }] (D-24).
 * A fund the relayer created for its site, confirmed by its own successful receipt, counts as registered on that
 * chain for sponsored Safe sends, with no space: naming it is still POST /groups with the owners' signature.
 * A slot whose stored status stayed `sending` (the send went out, then settling it to pending failed) counts once its
 * own queue row is confirmed, because slotState() decides, not the stored status (D-26).
 * A slot whose slotState is pending, sending, failed or not_sent, another site's slot, and no site at all never count.
 */
export function createdFunds(db, siteUuid) {
  if (!siteUuid) return [];
  return [...db.listCreations('pending'), ...db.listCreations('sending')]
    .filter((slot) => slot.siteUuid === siteUuid && slotState(db, slot).status === 'confirmed')
    .map((slot) => ({ chainId: slot.chainId, safe: slot.predictedAddress }));
}

/** The GET /creations/:groupUuid body for a slot. */
export function creationView(db, slot) {
  const { status, hash } = slotState(db, slot);
  return { groupUuid: slot.groupUuid, intentUuid: slot.intentUuid, status, hash, predictedAddress: slot.predictedAddress, chainId: slot.chainId };
}

/**
 * At start, before any request: a slot left `sending` by a stop mid-request. The queue stores its row before the
 * broadcast, so a slot with its own row may be live (it becomes pending with that hash), and one without never
 * broadcast anything (not_sent, its attempt given back). Returns how many slots were changed.
 */
export function recoverCreations(db, nowS = Math.floor(Date.now() / 1000), logger = console) {
  let n = 0;
  for (const slot of db.listCreations('sending')) {
    db.atomically(() => {
      const row = db.findLatestByDedupeKey(slot.chainId, slot.dedupeKey);
      if (row && row.id > slot.rowFloor) {
        db.updateCreation({ ...slot, status: 'pending', hash: row.hash }, nowS);
      } else {
        db.updateCreation({ ...slot, status: 'not_sent', hash: null }, nowS);
        if (slot.attemptId !== null) db.returnCreationAttempt(slot.attemptId);
      }
    });
    n += 1;
  }
  if (n) logger.warn(`gas-sponsor-relayer: ${n} fund creation(s) interrupted by a stop were settled from the queue`);
  return n;
}
