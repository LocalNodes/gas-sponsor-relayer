// POST /send/safe-create and GET /creations/:groupUuid (Sponsored Fund Creation), against the shared contract
// fixture. Stubbed chain; no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAddress, keccak256 } from 'viem';
import { loadNetworks } from '../../src/config.js';
import { build, buildCreation } from '../../src/allowlist.js';
import { openDb } from '../../src/db.js';
import { loadCreationPolicy, parseCreationPolicy, recoverCreations } from '../../src/creations.js';
import { buildInitializer, creationCodeReader, deploymentOf, initCodeHashOf, predictAddress, creationCalldata, dedupeKeyOf } from '../../src/sends/safeCreate.js';
import { execBody, startStub } from '../helpers/stub.js';
import { SEPOLIA_INIT_CODE_HASH, sepoliaCreationCode } from '../helpers/creation.js';
import { refusal } from '../helpers/node.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/fund-creation-contract.json', import.meta.url), 'utf8'));
const networks = loadNetworks();
const sepolia = deploymentOf(networks['11155111']);
const REQ = fx.request;
const R = fx.responses;
const S = fx.statusResponses;
const NOW = REQ.issuedAt * 1000;
const HASH = /^0x[0-9a-f]{64}$/;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GROUPS = [REQ.groupUuid, uuid(1), uuid(2), uuid(3), uuid(4)];
const policyOf = (over = {}) => parseCreationPolicy({ enabled: true, siteUuid: REQ.siteUuid, groups: GROUPS, limits: { perActorPerDay: 1, perSitePerDay: 3 }, ...over }).policy;
const POLICY = policyOf();

/** A request for another Group or other choices, with the relayer's own prediction for it. */
function req(over = {}) {
  const r = { ...structuredClone(REQ), ...over };
  if (!('predictedAddress' in over)) r.predictedAddress = predictAddress(sepolia, buildInitializer(sepolia, r.owners, r.threshold), r.saltNonce, SEPOLIA_INIT_CODE_HASH);
  return r;
}
const forGroup = (n, actor = n) => req({ groupUuid: GROUPS[n], intentUuid: uuid(100 + n), actor: { ...REQ.actor, uuid: uuid(200 + actor) }, saltNonce: String(1000 + n) });
const withHash = (body, hash) => ({ ...body, hash });

async function stub(opts = {}) {
  return startStub({ creationPolicy: POLICY, now: () => NOW, capNow: () => NOW, ...opts });
}
const post = (s, body) => s.call('POST', '/send/safe-create', body);
const view = (s, group = REQ.groupUuid) => s.call('GET', `/creations/${group}`);
const attempts = (s) => s.db.countedCreationAttempts(REQ.siteUuid, REQ.chainId, 0).length;

describe('safe-create (unit)', () => {
  test('safe-create: the fixture request is accepted with the contract body, and GET reads it back', async () => {
    const s = await stub();
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.accepted.status, res.text);
      assert.match(res.json.hash, HASH);
      assert.deepEqual(res.json, withHash(R.accepted.body, res.json.hash));
      assert.equal(s.chains.calls.send, 1);
      const sent = s.chains.calls.sent[0];
      assert.equal(sent.to, sepolia.factory);
      assert.equal(sent.value, 0n);
      assert.equal(sent.data, creationCalldata(sepolia, buildInitializer(sepolia, REQ.owners, REQ.threshold), REQ.saltNonce));
      const got = await view(s);
      assert.equal(got.status, S.pending.status);
      assert.deepEqual(got.json, withHash(S.pending.body, res.json.hash));
      // One queue row, keyed to the slot, holding the predicted address.
      const row = s.db.findLatestByDedupeKey(11155111, dedupeKeyOf(REQ.siteUuid, REQ.groupUuid));
      assert.equal(row.kind, 'safe-create');
      assert.equal(row.safe.toLowerCase(), REQ.predictedAddress.toLowerCase());
      assert.equal(s.db.listPending().length, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create: GET for a Group with no slot is the contract 404', async () => {
    const s = await stub();
    try {
      const got = await view(s, uuid(9));
      assert.equal(got.status, S.none.status);
      // The contract body (rules.codes creation_not_found); an unknown route's 404 has no reason.
      assert.deepEqual(got.json, S.none.body);
      const unknown = await s.call('GET', '/creations/not-a-uuid');
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.reason, undefined);
    } finally {
      await s.close();
    }
  });

  test('safe-create: predictedAddress is EIP-55 and intentUuid and chainId echo the request, on 202, duplicate and GET', async () => {
    const s = await stub();
    try {
      const lower = { ...REQ, predictedAddress: REQ.predictedAddress.toLowerCase(), owners: REQ.owners.map((o) => o.toLowerCase()) };
      const bodies = [(await post(s, lower)).json, (await post(s, { ...REQ, actor: { uuid: uuid(303), address: REQ.owners[1] } })).json, (await view(s)).json];
      for (const b of bodies) {
        assert.equal(b.predictedAddress, getAddress(REQ.predictedAddress));
        assert.notEqual(b.predictedAddress, b.predictedAddress.toLowerCase());
        assert.equal(b.intentUuid, REQ.intentUuid);
        assert.equal(b.chainId, REQ.chainId);
        assert.equal(typeof b.chainId, 'number');
      }
      assert.equal(bodies[1].duplicate, true);
    } finally {
      await s.close();
    }
  });

  test('safe-create: no bearer token is 401 and nothing happens', async () => {
    const s = await stub();
    try {
      const res = await s.call('POST', '/send/safe-create', REQ, null);
      assert.equal(res.status, R.unauthorized.status);
      assert.deepEqual(res.json, R.unauthorized.body);
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId), null);
    } finally {
      await s.close();
    }
  });

  // C11: wrong site, unenrolled Group, creation off. Refused before estimate, reservation, attempt or slot.
  for (const [name, opts, body, expect] of [
    ['creation off', { creationPolicy: policyOf({ enabled: false }) }, REQ, R.creationDisabled],
    ['creation off by default (no policy given)', { creationPolicy: undefined }, REQ, R.creationDisabled],
    ['a wrong site', {}, req({ siteUuid: uuid(77) }), R.siteMismatch],
    ['an unenrolled Group', {}, req({ groupUuid: uuid(78) }), R.groupNotEnrolled],
  ]) {
    test(`safe-create C11: ${name} is refused before any estimate or claim`, async () => {
      const s = await stub(opts);
      try {
        const res = await post(s, body);
        assert.equal(res.status, expect.status, res.text);
        assert.deepEqual(res.json, expect.body);
        assert.equal(s.chains.calls.estimate, 0);
        assert.equal(s.chains.calls.send, 0);
        assert.equal(attempts(s), 0);
        assert.equal(s.db.listCreations('sending').length + s.db.listCreations('pending').length + s.db.listCreations('not_sent').length, 0);
        assert.ok(s.logs.some((l) => l.startsWith(`refused ${expect.body.reason} `)), 'refusal logged');
      } finally {
        await s.close();
      }
    });
  }

  // C16: unsupported networks and versions.
  test('safe-create C16: Base Sepolia, an unknown chain, mainnet and another Safe version are network_not_supported', async () => {
    for (const body of [req({ chainId: 84532 }), req({ chainId: 1 }), req({ chainId: 999999 }), req({ safeVersion: '1.3.0' })]) {
      const s = await stub();
      try {
        const res = await post(s, body);
        assert.equal(res.status, R.networkNotSupported.status, JSON.stringify(body.chainId));
        assert.deepEqual(res.json, R.networkNotSupported.body);
        assert.equal(s.chains.calls.estimate, 0);
        assert.equal(attempts(s), 0);
      } finally {
        await s.close();
      }
    }
  });

  // The factory's creation code (licence guard): the relayer keeps only its hash and reads the code from the factory.
  // These use made-up code with its own hash; the fork suite reads the real factory.
  const FAKE_CODE = '0x6080604052aabbccdd';
  const fakeReader = () => creationCodeReader({ expectedKeccak: keccak256(FAKE_CODE) });
  const readerClient = (answers) => {
    const c = { reads: 0, async readContract(r) { c.reads += 1; c.last = r; const a = answers.shift(); if (a instanceof Error) throw a; return a; } };
    return c;
  };

  test("safe-create code: the reader asks the factory's proxyCreationCode() once per chain and keeps the good answer", async () => {
    const read = fakeReader();
    const client = readerClient([FAKE_CODE]);
    const want = { ok: true, hash: initCodeHashOf(FAKE_CODE, sepolia.singleton) };
    assert.deepEqual(await read(11155111, sepolia, client), want);
    assert.deepEqual(await read(11155111, sepolia, client), want);
    assert.equal(client.reads, 1);
    assert.equal(client.last.address, sepolia.factory);
    assert.equal(client.last.functionName, 'proxyCreationCode');
  });

  test('safe-create code: other code is a mismatch, a failed read is unreadable, and neither is kept', async () => {
    const read = fakeReader();
    const client = readerClient(['0x6080604052aabbccde', new Error('HTTP request failed'), '0x', FAKE_CODE]);
    assert.deepEqual(await read(11155111, sepolia, client), { ok: false, reason: 'mismatch' });
    assert.deepEqual(await read(11155111, sepolia, client), { ok: false, reason: 'unreadable' });
    assert.deepEqual(await read(11155111, sepolia, client), { ok: false, reason: 'mismatch' });
    assert.deepEqual(await read(11155111, sepolia, client), { ok: true, hash: initCodeHashOf(FAKE_CODE, sepolia.singleton) });
    assert.equal(client.reads, 4);
  });

  test('safe-create code: the hash is the init code (creation code then the singleton), so another singleton is another hash', () => {
    assert.notEqual(initCodeHashOf(FAKE_CODE, sepolia.singleton), initCodeHashOf(FAKE_CODE, sepolia.factory));
    assert.equal(initCodeHashOf(FAKE_CODE, sepolia.singleton), keccak256(`${FAKE_CODE}${sepolia.singleton.slice(2).toLowerCase().padStart(64, '0')}`));
  });

  test("safe-create code: a factory without Safe 1.4.1's code is network_not_supported (403), nothing claimed, estimated or sent", async () => {
    const s = await stub({ creationCode: async () => ({ ok: false, reason: 'mismatch' }) });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.networkNotSupported.status, res.text);
      assert.deepEqual(res.json, R.networkNotSupported.body);
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(s.chains.calls.send, 0);
      assert.equal(attempts(s), 0);
      assert.equal((await view(s)).status, 404);
      assert.ok(s.logs.some((l) => l.includes("does not have Safe 1.4.1's proxy creation code")), s.logs.join('\n'));
    } finally {
      await s.close();
    }
  });

  test('safe-create code: an unreadable factory is chain_not_available (503), nothing claimed, estimated or sent', async () => {
    const s = await stub({ creationCode: async () => ({ ok: false, reason: 'unreadable' }) });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, 503, res.text);
      assert.deepEqual(res.json, { error: 'unavailable', reason: 'chain_not_available' });
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(s.chains.calls.send, 0);
      assert.equal(attempts(s), 0);
      assert.equal((await view(s)).status, 404);
    } finally {
      await s.close();
    }
  });

  test('safe-create code: the prediction uses the hash the reader gives, so another code is prediction_mismatch', async () => {
    const s = await stub({ creationCode: async () => ({ ok: true, hash: initCodeHashOf(FAKE_CODE, sepolia.singleton) }) });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.predictionMismatch.status, res.text);
      assert.equal(res.json.reason, 'prediction_mismatch');
      assert.equal(s.chains.calls.send, 0);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  test('safe-create C16: a chain not marked fundCreation is network_not_supported (403), sponsored or not, before any estimate', async () => {
    for (const sponsoring of [true, false]) {
      const off = structuredClone(networks);
      off['11155111'].fundCreation = false;
      off['11155111'].sponsoring = sponsoring;
      const s = await stub({ networks: off });
      try {
        const res = await post(s, REQ);
        assert.equal(res.status, R.networkNotSupported.status, res.text);
        assert.deepEqual(res.json, R.networkNotSupported.body);
        assert.equal(s.chains.calls.estimate, 0);
        assert.equal(attempts(s), 0);
      } finally {
        await s.close();
      }
    }
  });

  test('safe-create C16: a fund-creation chain with sponsoring off is 503 chain_not_sponsored, before any claim', async () => {
    const off = structuredClone(networks);
    off['11155111'].sponsoring = false;
    const s = await stub({ networks: off });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.notSponsored.status, res.text);
      assert.deepEqual(res.json, R.notSponsored.body);
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  // C17: malformed and extra fields, changed frozen choices.
  test('safe-create C17: extra fields (calldata, value, a target, a refund) are unexpected_field, also inside actor', async () => {
    const s = await stub();
    try {
      for (const extra of [{ data: '0x1234' }, { value: '1' }, { to: sepolia.factory }, { paymentReceiver: REQ.owners[0] }, { factory: sepolia.factory }]) {
        const res = await post(s, { ...REQ, ...extra });
        assert.equal(res.status, R.unexpectedField.status, JSON.stringify(extra));
        assert.deepEqual(res.json, R.unexpectedField.body);
      }
      const res = await post(s, { ...REQ, actor: { ...REQ.actor, role: 'admin' } });
      assert.deepEqual(res.json, R.unexpectedField.body);
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  test('safe-create C17: body rules (owners, threshold, salt, UUIDs, envelope fields) are 400 with the rule', async () => {
    const s = await stub();
    try {
      const dup = await post(s, { ...REQ, owners: [REQ.owners[0], REQ.owners[0].toLowerCase()] });
      assert.equal(dup.status, R.badRequest.status);
      assert.deepEqual(dup.json, R.badRequest.body);
      for (const bad of [
        { owners: [] }, { owners: Array.from({ length: 11 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`) }, { owners: ['0x0000000000000000000000000000000000000000'] },
        { threshold: 0 }, { threshold: 3 }, { threshold: 1.5 }, { saltNonce: '01' }, { saltNonce: 5 }, { saltNonce: (1n << 256n).toString() },
        { siteUuid: REQ.siteUuid.toUpperCase() }, { groupUuid: 'x' }, { intentUuid: undefined }, { actor: { uuid: REQ.actor.uuid } },
        { chainId: '11155111' }, { safeVersion: 'latest' }, { issuedAt: '1' }, { expiresAt: -1 }, { predictedAddress: '0x12' },
      ]) {
        const res = await post(s, { ...REQ, ...bad });
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.equal(res.json.error, 'bad_request');
        assert.notEqual(res.json.reason, undefined);
      }
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  test('safe-create C17: a changed owner, threshold or salt under the same predicted address is prediction_mismatch', async () => {
    const s = await stub();
    try {
      for (const over of [{ owners: [...REQ.owners].reverse() }, { threshold: 1 }, { saltNonce: '1' }]) {
        const res = await post(s, { ...REQ, ...over });
        assert.equal(res.status, R.predictionMismatch.status, JSON.stringify(over));
        assert.deepEqual(res.json, R.predictionMismatch.body);
      }
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  test('safe-create: the payer is never an owner (400 payer_is_owner, before any claim)', async () => {
    const s = await stub();
    try {
      const body = req({ owners: [REQ.owners[0], s.config.address] });
      const res = await post(s, body);
      assert.equal(res.status, 400, res.text);
      assert.deepEqual(res.json, { error: 'bad_request', reason: 'payer_is_owner' });
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  // C18: the envelope.
  test('safe-create C18: an expired first delivery is 400 expired, nothing claimed; an accepted repeat is answered after expiry', async () => {
    let now = REQ.expiresAt * 1000 + 1000;
    const s = await stub({ now: () => now });
    try {
      const late = await post(s, REQ);
      assert.equal(late.status, R.expired.status);
      assert.deepEqual(late.json, R.expired.body);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId), null);
      assert.equal(attempts(s), 0);
      for (const env of [{ issuedAt: REQ.issuedAt, expiresAt: REQ.issuedAt + 301 }, { issuedAt: REQ.issuedAt + 120, expiresAt: REQ.issuedAt + 200 }, { issuedAt: REQ.issuedAt, expiresAt: REQ.issuedAt }]) {
        now = NOW;
        const res = await post(s, { ...REQ, ...env });
        assert.deepEqual(res.json, R.expired.body, JSON.stringify(env));
      }
      now = NOW;
      const ok = await post(s, REQ);
      assert.equal(ok.status, 202, ok.text);
      now = REQ.expiresAt * 1000 + 3600_000;
      const again = await post(s, REQ);
      assert.equal(again.status, R.duplicate.status);
      assert.deepEqual(again.json, withHash(R.duplicate.body, ok.json.hash));
      assert.equal(s.chains.calls.send, 1);
    } finally {
      await s.close();
    }
  });

  // C13: an exact repeat, even with caps and quotas full.
  test('safe-create C13: an exact repeat (another actor, a new envelope) gets the slot answer with no second estimate, reservation or send', async () => {
    const s = await stub({ env: { SPONSOR_RELAYER_CAP_DAY_WEI: '200000000000000' } });
    try {
      const first = await post(s, REQ);
      assert.equal(first.status, 202, first.text);
      const estimates = s.chains.calls.estimate;
      const repeat = { ...REQ, actor: { uuid: uuid(300), address: REQ.owners[1] }, issuedAt: REQ.issuedAt + 5, expiresAt: REQ.issuedAt + 100 };
      const res = await post(s, repeat);
      assert.deepEqual(res.json, withHash(R.duplicate.body, first.json.hash));
      assert.equal(s.chains.calls.estimate, estimates);
      assert.equal(s.chains.calls.send, 1);
      assert.equal(attempts(s), 1);
      assert.equal(s.db.listPending().length, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create C13: a repeat after the receipt reads confirmed; a reverted receipt reads failed and is never sent again', async () => {
    for (const [receiptStatus, view200, dup] of [['success', S.confirmed, R.duplicateConfirmed], ['reverted', S.failed, null]]) {
      const s = await stub();
      try {
        const first = await post(s, REQ);
        const row = s.db.findLatestByDedupeKey(11155111, dedupeKeyOf(REQ.siteUuid, REQ.groupUuid));
        s.db.updatePending(row.id, { ...row, status: 'confirming', consumedBy: first.json.hash, consumedBlock: 5n, minedBlockHash: `0x${'cd'.repeat(32)}`, receiptStatus });
        const got = await view(s);
        assert.deepEqual(got.json, withHash(view200.body, first.json.hash));
        const res = await post(s, REQ);
        if (dup) assert.deepEqual(res.json, withHash(dup.body, first.json.hash));
        else assert.deepEqual(res.json, { ...withHash(R.duplicate.body, first.json.hash), status: 'failed' });
        assert.equal(s.chains.calls.send, 1);
        // A reorg takes the row back to pending: the view follows it (the receipt outcome is cleared with it).
        const mined = s.db.findLatestByDedupeKey(11155111, dedupeKeyOf(REQ.siteUuid, REQ.groupUuid));
        assert.equal(mined.receiptStatus, receiptStatus);
        s.db.updatePending(mined.id, { ...mined, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null });
        assert.equal(s.db.findLatestByDedupeKey(11155111, dedupeKeyOf(REQ.siteUuid, REQ.groupUuid)).receiptStatus, null);
        assert.equal((await view(s)).json.status, 'pending');
      } finally {
        await s.close();
      }
    }
  });

  // C14/C15: one slot per Group for ever.
  test('safe-create C15: a different intent for a taken slot is 409 slot_taken, whatever its state', async () => {
    const s = await stub();
    try {
      const first = await post(s, REQ);
      assert.equal(first.status, 202);
      for (const other of [req({ intentUuid: uuid(55) }), req({ threshold: 1 }), req({ owners: [REQ.owners[1], REQ.owners[0]] }), req({ saltNonce: '7' })]) {
        const res = await post(s, other);
        assert.equal(res.status, R.slotTaken.status, JSON.stringify(other.intentUuid));
        assert.deepEqual(res.json, R.slotTaken.body);
      }
      assert.equal(s.chains.calls.send, 1);
      assert.equal(attempts(s), 1);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).intentUuid, REQ.intentUuid);
    } finally {
      await s.close();
    }
  });

  test('safe-create C15: two different intents at once for one Group: one send, the other slot_taken', async () => {
    const s = await stub();
    try {
      const [a, b] = await Promise.all([post(s, REQ), post(s, req({ intentUuid: uuid(56), actor: { uuid: uuid(301), address: REQ.owners[1] }, saltNonce: '8' }))]);
      assert.deepEqual([a.status, b.status].sort(), [202, 409]);
      assert.equal(s.chains.calls.send, 1);
      assert.equal(s.db.listPending().length, 1);
      // The same intent twice at once: one send, one duplicate answer.
      const t = await stub();
      try {
        const [c, d] = await Promise.all([post(t, REQ), post(t, REQ)]);
        assert.equal(c.status, 202);
        assert.equal(d.status, 202);
        assert.equal(c.json.hash, d.json.hash);
        assert.equal([c.json, d.json].filter((j) => j.duplicate).length, 1);
        assert.equal(t.chains.calls.send, 1);
      } finally {
        await t.close();
      }
    } finally {
      await s.close();
    }
  });

  // C12: quotas.
  test('safe-create C12: one attempt per actor per day (setup_limit actor, until in seconds)', async () => {
    const s = await stub();
    try {
      assert.equal((await post(s, forGroup(1, 9))).status, 202);
      const res = await post(s, forGroup(2, 9));
      assert.equal(res.status, R.setupLimitActor.status, res.text);
      assert.deepEqual(res.json, R.setupLimitActor.body);
      assert.ok(Number.isSafeInteger(res.json.until), 'until is a Unix int');
      assert.equal(s.db.getCreation(REQ.siteUuid, GROUPS[2], REQ.chainId), null);
      assert.equal(s.chains.calls.estimate, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create C12: three attempts per site per day; racing Groups for the last one get exactly one', async () => {
    const s = await stub();
    try {
      assert.equal((await post(s, forGroup(1))).status, 202);
      assert.equal((await post(s, forGroup(2))).status, 202);
      const [a, b] = await Promise.all([post(s, forGroup(3)), post(s, forGroup(4))]);
      assert.deepEqual([a.status, b.status].sort(), [202, 429]);
      const lost = a.status === 429 ? a : b;
      assert.deepEqual(lost.json, R.setupLimitSite.body);
      assert.equal(s.chains.calls.send, 3);
      assert.equal(attempts(s), 3);
    } finally {
      await s.close();
    }
  });

  test('safe-create C12: the quota window rolls (an attempt older than 24 hours no longer counts)', async () => {
    let now = NOW;
    const s = await stub({ now: () => now });
    try {
      assert.equal((await post(s, forGroup(1, 9))).status, 202);
      now = NOW + 86400_000 + 1000;
      const later = forGroup(2, 9);
      const res = await post(s, { ...later, issuedAt: later.issuedAt + 86401, expiresAt: later.expiresAt + 86401 });
      assert.equal(res.status, 202, res.text);
    } finally {
      await s.close();
    }
  });

  test('safe-create C12: the money cap refuses with cap_reached in seconds; slot not_sent and the attempt given back', async () => {
    const s = await stub({ env: { SPONSOR_RELAYER_CAP_DAY_WEI: '1' } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.capReached.status, res.text);
      assert.deepEqual(Object.keys(res.json).sort(), Object.keys(R.capReached.body).sort());
      assert.equal(res.json.error, 'cap_reached');
      assert.ok(Number.isSafeInteger(res.json.until) && Number.isSafeInteger(res.json.monthStartsAt));
      // Unix seconds, not milliseconds.
      assert.ok(res.json.until > NOW / 1000 && res.json.until <= NOW / 1000 + 40 * 86400, String(res.json.until));
      assert.ok(res.json.monthStartsAt <= NOW / 1000 && res.json.monthStartsAt > NOW / 1000 - 32 * 86400, String(res.json.monthStartsAt));
      assert.equal(s.chains.calls.send, 0);
      assert.equal(attempts(s), 0);
      assert.deepEqual((await view(s)).json, S.notSent.body);
    } finally {
      await s.close();
    }
  });

  // One test per exit after the claim: each gives the slot (not_sent) and the attempt back, and the same intent may send again.
  for (const [name, opts, status, body] of [
    ['a simulation revert', { estimateError: new Error('execution reverted') }, R.simulationFailed.status, R.simulationFailed.body],
    ['a fee estimate failure', { feeError: new Error('rpc down') }, R.notSentFeeEstimate.status, R.notSentFeeEstimate.body],
    // After queueing, a funds refusal is the retryable node refusal, never payer_empty (the service's rule).
    ['an empty payer (insufficient funds)', { sendError: refusal('insufficient funds for gas * price + value') }, R.notSentNodeRefused.status, R.notSentNodeRefused.body],
    ['a node refusal', { sendError: refusal('transaction underpriced') }, R.notSentNodeRefused.status, R.notSentNodeRefused.body],
  ]) {
    test(`safe-create: ${name} after the claim gives the slot and the attempt back`, async () => {
      const s = await stub({ chainsOpts: opts });
      try {
        const res = await post(s, REQ);
        assert.equal(res.status, status, res.text);
        assert.deepEqual(res.json, body);
        assert.equal(attempts(s), 0);
        assert.deepEqual((await view(s)).json, S.notSent.body);
        assert.equal(s.db.listPending().length, 0);
        assert.equal(s.db.openSpend().length, 0, 'no reservation left held');
        // The same intent sends once the cause is gone.
        delete s.chains.options.estimateError;
        delete s.chains.options.feeError;
        s.chains.options.sendError = null;
        const again = await post(s, REQ);
        assert.equal(again.status, 202, again.text);
        assert.equal(again.json.duplicate, undefined);
        assert.equal(attempts(s), 1);
      } finally {
        await s.close();
      }
    });
  }

  // D-04, D-15 (TM-287): an empty fee wallet is a retryable 502 payer_empty read before the reservation, never a held
  // 409 and never a phantom send. Nothing is counted, reserved or queued, and the same intent sends once funded.
  const COST = (100000n * 12n / 10n) * 10n ** 9n; // gasLimit * maxFeePerGas of the stub's defaults
  // `attempted`: the broadcast was tried and the node refused it (layer 3); otherwise no broadcast was attempted at all.
  // `answer`: the contract answer expected; an after-queue funds refusal is the node refusal, not payer_empty.
  const notSentClean = async (s, res, { attempted = false, answer = R.notSentEmptyPayer } = {}) => {
    assert.equal(res.status, answer.status, res.text);
    assert.deepEqual(res.json, answer.body);
    if (!attempted) assert.equal(s.chains.calls.send, 0, 'no broadcast was attempted');
    assert.equal(s.chains.calls.sent.length, 0, 'nothing went out');
    assert.equal(attempts(s), 0);
    assert.deepEqual((await view(s)).json, S.notSent.body);
    assert.equal(s.db.listPending().length, 0);
    assert.equal(s.db.openSpend().length, 0, 'no reservation left held');
  };
  const viemText = (shortMessage) => Object.assign(new Error('RPC Request failed.'), { shortMessage });

  test('safe-create D-15: a fee wallet with a zero balance is payer_empty with nothing counted, queued or reserved, and the same intent sends once funded', async () => {
    const s = await stub({ chainsOpts: { balance: 0n } });
    try {
      await notSentClean(s, await post(s, REQ));
      assert.ok(s.logs.some((l) => l.includes(`safe-create ${REQ.chainId} ${REQ.groupUuid}`) && /cannot pay/.test(l)), 'the refusal is logged in one line');
      s.chains.options.balance = 5n * 10n ** 18n;
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
      assert.equal(again.json.duplicate, undefined);
      assert.equal(attempts(s), 1);
    } finally {
      await s.close();
    }
  });

  test("safe-create D-15: after queueing, a node's -32003 insufficient-funds answer to the broadcast is the retryable 'send failed', never payer_empty, nothing counted, queued or reserved", async () => {
    // The service's rule: the definite "the fee account is empty" is only given before queueing.
    const s = await stub({ chainsOpts: { sendError: refusal('Insufficient funds for gas * price + value', -32003) } });
    try {
      await notSentClean(s, await post(s, REQ), { attempted: true, answer: R.notSentNodeRefused });
      assert.equal(s.chains.calls.send, 1, 'the broadcast was tried once');
      assert.equal(s.chains.options.sendError.name, 'InvalidInputRpcError');
      s.chains.options.sendError = null;
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
      assert.equal(attempts(s), 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-15: a balance one wei below the send\'s cost is payer_empty, exactly the cost goes on to the queue', async () => {
    const s = await stub({ chainsOpts: { balance: COST - 1n } });
    try {
      await notSentClean(s, await post(s, REQ));
      s.chains.options.balance = COST;
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
      assert.equal(s.chains.calls.send, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-15: a balance that cannot be read does not refuse the send', async () => {
    const s = await stub({ chainsOpts: { balance: () => { throw new Error('rpc down'); } } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, 202, res.text);
      assert.equal(s.chains.calls.send, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-15: an estimate that fails for insufficient funds is payer_empty, a revert is still simulation_failed', async () => {
    const s = await stub({ chainsOpts: { estimateError: new Error('insufficient funds for gas * price + value') } });
    try {
      await notSentClean(s, await post(s, REQ));
      assert.equal(s.chains.calls.estimate, 1);
      // The words may sit in a cause, as viem wraps the node's answer.
      s.chains.options.estimateError = Object.assign(new Error('Execution failed'), { cause: new Error('exceeds transaction sender account balance') });
      await notSentClean(s, await post(s, REQ));
      s.chains.options.estimateError = new Error('execution reverted');
      const reverted = await post(s, REQ);
      assert.equal(reverted.status, R.simulationFailed.status, reverted.text);
      assert.deepEqual(reverted.json, R.simulationFailed.body);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  test("safe-create D-15: viem's 'exceeds the balance of the account' estimate error is payer_empty", async () => {
    const e = viemText('The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.');
    const s = await stub({ chainsOpts: { estimateError: e } });
    try {
      await notSentClean(s, await post(s, REQ));
    } finally {
      await s.close();
    }
  });

  test("safe-create D-15: geth's 'gas required exceeds allowance (0)' on an empty fee wallet is payer_empty, nothing counted, reserved or queued", async () => {
    const s = await stub({ chainsOpts: { balance: 0n, estimateError: new Error('gas required exceeds allowance (0)') } });
    try {
      await notSentClean(s, await post(s, REQ));
      assert.equal(s.chains.calls.estimate, 1);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).status, 'not_sent');
    } finally {
      await s.close();
    }
  });

  test("safe-create D-15: the same geth text with a funded fee wallet is still simulation_failed (the text alone never decides)", async () => {
    const s = await stub({ chainsOpts: { estimateError: new Error('gas required exceeds allowance (0)') } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.simulationFailed.status, res.text);
      assert.deepEqual(res.json, R.simulationFailed.body);
      assert.equal(attempts(s), 0);
      assert.equal(s.chains.calls.send, 0);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-15: a revert whose balance read in the catch fails is simulation_failed', async () => {
    const s = await stub({ chainsOpts: { balance: () => { throw new Error('rpc down'); }, estimateError: new Error('execution reverted') } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.simulationFailed.status, res.text);
      assert.deepEqual(res.json, R.simulationFailed.body);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  // Never stuck (D-04, D-15): a fee account holding dust (0 < balance < cost) is what a spent account really holds.
  // geth caps the estimate at balance / gasPrice and fails it with 'gas required exceeds allowance (N)', or with
  // 'execution reverted' when the inner call runs out of gas. That is a wait (502 payer_empty), never a held 409.
  const allowance = () => Object.assign(new Error('Execution reverted for an unknown reason.'), { shortMessage: 'gas required exceeds allowance (4)', name: 'ExecutionRevertedError' });
  test('safe-create D-15: dust below the cost and geth\'s allowance estimate error is payer_empty, nothing counted, reserved or queued, and the same intent sends once funded', async () => {
    const s = await stub({ chainsOpts: { balance: 1000n, estimateError: allowance(), estimateErrorAccountOnly: true } });
    try {
      await notSentClean(s, await post(s, REQ));
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).status, 'not_sent');
      s.chains.options.balance = 5n * 10n ** 18n;
      s.chains.options.estimateError = null;
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
      assert.equal(attempts(s), 1);
    } finally {
      await s.close();
    }
  });

  test("safe-create D-15: dust below the cost and an 'execution reverted' estimate (the inner call ran out of gas) is payer_empty", async () => {
    const s = await stub({ chainsOpts: { balance: COST - 1n, estimateError: new Error('execution reverted'), estimateErrorAccountOnly: true } });
    try {
      await notSentClean(s, await post(s, REQ));
    } finally {
      await s.close();
    }
  });

  test('safe-create D-15: a revert by an account that can pay the cost is still simulation_failed (exactly the cost, and well funded)', async () => {
    for (const balance of [COST, 5n * 10n ** 18n]) {
      const s = await stub({ chainsOpts: { balance, estimateError: new Error('execution reverted'), estimateErrorAccountOnly: true } });
      try {
        const res = await post(s, REQ);
        assert.equal(res.status, R.simulationFailed.status, `${balance}: ${res.text}`);
        assert.deepEqual(res.json, R.simulationFailed.body);
        assert.equal(attempts(s), 0);
        assert.equal(s.chains.calls.send, 0);
      } finally {
        await s.close();
      }
    }
  });

  test('safe-create D-15: dust and an estimate that also fails without the fee account is a genuine revert, simulation_failed', async () => {
    const s = await stub({ chainsOpts: { balance: 1000n, estimateError: allowance() } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.simulationFailed.status, res.text);
      assert.deepEqual(res.json, R.simulationFailed.body);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-15: dust and a second estimate that cannot be read (timeout, outage) is a retryable 502, never a held 409', async () => {
    const timeout = Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' });
    const wrapped = Object.assign(new Error('Execution reverted for an unknown reason.'), { name: 'EstimateGasExecutionError', cause: Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError' }) });
    for (const plainEstimateError of [timeout, wrapped, new Error('socket hang up')]) {
      const s = await stub({ chainsOpts: { balance: 1000n, estimateError: allowance(), estimateErrorAccountOnly: true, plainEstimateError } });
      try {
        const res = await post(s, REQ);
        assert.equal(res.status, 502, `${plainEstimateError.message}: ${res.text}`);
        assert.deepEqual(res.json, { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false });
        assert.equal(attempts(s), 0);
        assert.equal(s.db.openSpend().length, 0, 'nothing reserved');
        assert.equal(s.chains.calls.send, 0);
        assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).status, 'not_sent');
      } finally {
        await s.close();
      }
    }
  });

  test('safe-create D-15: dust and a transport failure wrapped inside a revert-worded estimate error is a retryable 502, a revert alone is still held', async () => {
    const wrap = (cause) => Object.assign(new Error('Execution reverted for an unknown reason.'), { name: 'EstimateGasExecutionError', cause });
    const wrappedErrors = [
      wrap(new Error('socket hang up')),
      wrap(Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' })),
      wrap(wrap(new Error('connect ECONNREFUSED 127.0.0.1:8545'))),
    ];
    for (const plainEstimateError of wrappedErrors) {
      const s = await stub({ chainsOpts: { balance: 1000n, estimateError: allowance(), estimateErrorAccountOnly: true, plainEstimateError } });
      try {
        const res = await post(s, REQ);
        assert.equal(res.status, 502, res.text);
        assert.deepEqual(res.json, { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false });
        assert.equal(attempts(s), 0);
      } finally {
        await s.close();
      }
    }
    // A revert with nothing transport in its chain is the call's own failure.
    const s = await stub({ chainsOpts: { balance: 1000n, estimateError: allowance(), estimateErrorAccountOnly: true, plainEstimateError: wrap(Object.assign(new Error('execution reverted: GS013'), { name: 'ExecutionRevertedError' })) } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.simulationFailed.status, res.text);
      assert.deepEqual(res.json, R.simulationFailed.body);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-15: dust, an estimate that works without the fee account and no fee estimate is a retryable 502, never a held 409', async () => {
    const s = await stub({ chainsOpts: { balance: 1000n, estimateError: allowance(), estimateErrorAccountOnly: true, feeError: new Error('fee node down') } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, 502, res.text);
      assert.deepEqual(res.json, { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false });
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });

  test("safe-create D-15: after queueing, a node's -32003 refusal wrapped in another error is the retryable 'send failed' too", async () => {
    const wrapped = Object.assign(new Error('the send failed upstream'), { cause: refusal('Insufficient funds for gas * price + value', -32003) });
    const s = await stub({ chainsOpts: { sendError: wrapped } });
    try {
      await notSentClean(s, await post(s, REQ), { attempted: true, answer: R.notSentNodeRefused });
      s.chains.options.sendError = null;
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
    } finally {
      await s.close();
    }
  });

  test('safe-create: an answer lost after the node took the send keeps the slot pending and the attempt counted', async () => {
    const s = await stub({ chainsOpts: { afterAccept: new Error('socket hang up') } });
    try {
      const res = await post(s, REQ);
      assert.equal(s.chains.calls.sent.length, 1);
      assert.notEqual(res.json.status, 'not_sent', res.text);
      assert.equal(attempts(s), 1);
      const got = await view(s);
      assert.equal(got.json.status, 'pending');
      assert.match(got.json.hash, HASH);
      // A retry is the slot's answer, never a second send.
      const again = await post(s, REQ);
      assert.equal(again.json.duplicate, true);
      assert.equal(s.chains.calls.sent.length, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create: a queue that rejects after storing its row keeps the slot pending, the attempt and the reservation', async () => {
    const s = await stub();
    try {
      const real = s.queue.enqueue;
      s.queue.enqueue = async (...a) => {
        await real(...a);
        throw new Error('lost after the row was stored');
      };
      const res = await post(s, REQ);
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.status, 'pending');
      assert.match(res.json.hash, HASH);
      assert.equal(attempts(s), 1);
      assert.equal(s.db.openSpend().length, 1);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).status, 'pending');
      s.queue.enqueue = real;
      const again = await post(s, REQ);
      assert.equal(again.json.duplicate, true);
      assert.equal(s.chains.calls.send, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create: a replaced send reads not_sent and the same intent may send again', async () => {
    const s = await stub();
    try {
      const first = await post(s, REQ);
      const row = s.db.findLatestByDedupeKey(11155111, dedupeKeyOf(REQ.siteUuid, REQ.groupUuid));
      s.db.updatePending(row.id, { ...row, status: 'replaced', consumedBy: `0x${'ee'.repeat(32)}`, consumedBlock: 9n });
      assert.deepEqual((await view(s)).json, S.notSent.body);
      // Another transaction took that nonce on the chain.
      s.chains.options.latest = 4;
      s.chains.options.pending = 4;
      // The replaced send was broadcast, so its attempt stays counted: another organizer resends the same intent.
      const again = await post(s, { ...REQ, actor: { uuid: uuid(302), address: REQ.owners[1] } });
      assert.equal(again.status, 202, again.text);
      assert.notEqual(again.json.hash, first.json.hash);
      assert.equal(again.json.duplicate, undefined);
      assert.equal(s.chains.calls.send, 2);
    } finally {
      await s.close();
    }
  });

  // C22: a stop between the claim and the answer.
  test('safe-create C22: after a restart over the same file, a slot left sending is settled from the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'safe-create-'));
    const path = join(dir, 'relayer.db');
    try {
      const s = await stub({ dbPath: path });
      // A second Group claimed but stopped before the queue stored anything.
      const g = forGroup(1);
      let first;
      try {
        first = await post(s, REQ);
        assert.equal(first.status, 202);
        s.db.insertCreation({ ...s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId), groupUuid: g.groupUuid, intentUuid: g.intentUuid, dedupeKey: dedupeKeyOf(REQ.siteUuid, g.groupUuid), status: 'sending', hash: null, rowFloor: 0, attemptId: s.db.insertCreationAttempt({ siteUuid: REQ.siteUuid, groupUuid: g.groupUuid, chainId: REQ.chainId, actorUuid: g.actor.uuid }, REQ.issuedAt) }, REQ.issuedAt);
        // The first Group's slot also left sending, with its row stored.
        s.db.updateCreation({ ...s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId), status: 'sending', hash: null }, REQ.issuedAt);
        assert.equal((await view(s)).json.status, 'pending');
      } finally {
        await s.close();
      }
      const db = openDb(path);
      const quiet = { warn() {} };
      assert.equal(recoverCreations(db, REQ.issuedAt, quiet), 2);
      const a = db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId);
      assert.equal(a.status, 'pending');
      assert.equal(a.hash, first.json.hash);
      assert.equal(db.getCreation(REQ.siteUuid, g.groupUuid, REQ.chainId).status, 'not_sent');
      assert.equal(db.countedCreationAttempts(REQ.siteUuid, REQ.chainId, 0).length, 1);
      db.close();
      const t = await stub({ dbPath: path });
      try {
        assert.deepEqual((await view(t)).json, withHash(S.pending.body, first.json.hash));
        assert.deepEqual((await post(t, REQ)).json, withHash(R.duplicate.body, first.json.hash));
        assert.equal(t.chains.calls.send, 0);
      } finally {
        await t.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('safe-create: a slot shown as sending has no hash (contract sending shape)', async () => {
    const s = await stub();
    try {
      s.db.insertCreation({
        siteUuid: REQ.siteUuid, groupUuid: REQ.groupUuid, intentUuid: REQ.intentUuid, digest: '0x', chainId: REQ.chainId, safeVersion: REQ.safeVersion,
        owners: REQ.owners, threshold: REQ.threshold, saltNonce: REQ.saltNonce, predictedAddress: REQ.predictedAddress, actorUuid: REQ.actor.uuid,
        actorAddress: REQ.actor.address, status: 'sending', hash: null, dedupeKey: dedupeKeyOf(REQ.siteUuid, REQ.groupUuid), rowFloor: 0, attemptId: null,
      }, REQ.issuedAt);
      assert.deepEqual((await view(s)).json, S.sending.body);
    } finally {
      await s.close();
    }
  });

  // C23: the slot outlives anything the site does.
  test('safe-create C23: the slot is permanent; a new Group UUID needs its own enrollment', async () => {
    const s = await stub();
    try {
      await post(s, REQ);
      const res = await post(s, req({ intentUuid: uuid(57), saltNonce: '99' }));
      assert.deepEqual(res.json, R.slotTaken.body);
      const fresh = await post(s, req({ groupUuid: uuid(58), intentUuid: uuid(58) }));
      assert.deepEqual(fresh.json, R.groupNotEnrolled.body);
    } finally {
      await s.close();
    }
  });

  // D-02: one slot per (site, Group, network). A test copy of networks marks Base Sepolia for fund creation too.
  const BASE = 84532;
  const twoNetworks = () => {
    const n = structuredClone(networks);
    n[String(BASE)] = { ...n[String(BASE)], sponsoring: true, fundCreation: true, safeProxyFactory: sepolia.factory, safeSingletonL2: sepolia.singleton, safeFallbackHandler: sepolia.fallbackHandler };
    return n;
  };
  const onBase = (over = {}) => req({ chainId: BASE, intentUuid: uuid(150), ...over });
  const viewAt = (s, query, group = REQ.groupUuid) => s.call('GET', `/creations/${group}${query}`);

  test('safe-create D-02: the same site and Group claim on two networks, each its own slot', async () => {
    const s = await stub({ networks: twoNetworks() });
    try {
      const a = await post(s, REQ);
      const b = await post(s, onBase());
      assert.equal(a.status, 202, a.text);
      assert.equal(b.status, 202, b.text);
      assert.equal(a.json.chainId, 11155111);
      assert.equal(b.json.chainId, BASE);
      assert.equal(s.chains.calls.send, 2);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, 11155111).chainId, 11155111);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, BASE).chainId, BASE);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, 1), null);
      // An exact repeat on one network is that network's duplicate, not the other's slot.
      const again = await post(s, onBase());
      assert.equal(again.json.duplicate, true);
      assert.equal(again.json.chainId, BASE);
      assert.equal(s.chains.calls.send, 2);
      // A different intent on the first network is still taken there.
      assert.deepEqual((await post(s, req({ intentUuid: uuid(57), saltNonce: '99' }))).json, R.slotTaken.body);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-02: GET /creations/:groupUuid?chainId= answers that network\'s slot', async () => {
    const s = await stub({ networks: twoNetworks() });
    try {
      await post(s, REQ);
      await post(s, onBase());
      const a = await viewAt(s, '?chainId=11155111');
      const b = await viewAt(s, `?chainId=${BASE}`);
      assert.equal(a.status, 200, a.text);
      assert.equal(b.status, 200, b.text);
      assert.equal(a.json.chainId, 11155111);
      assert.equal(a.json.intentUuid, REQ.intentUuid);
      assert.equal(b.json.chainId, BASE);
      assert.equal(b.json.intentUuid, uuid(150));
    } finally {
      await s.close();
    }
  });

  test('safe-create D-02: without chainId one marked network answers, two marked networks are 400 chain_id_required', async () => {
    const one = await stub();
    try {
      await post(one, REQ);
      const got = await view(one);
      assert.equal(got.status, 200, got.text);
      assert.equal(got.json.chainId, 11155111);
      assert.deepEqual(got.json, withHash(S.pending.body, got.json.hash));
    } finally {
      await one.close();
    }
    const two = await stub({ networks: twoNetworks() });
    try {
      await post(two, REQ);
      const got = await view(two);
      assert.equal(got.status, 400, got.text);
      assert.deepEqual(got.json, { error: 'bad_request', reason: 'chain_id_required' });
      // A stored slot is a fact: it is read by its chain whatever the file marks now.
      const marked = await viewAt(two, '?chainId=11155111');
      assert.equal(marked.status, 200);
    } finally {
      await two.close();
    }
    const none = await stub({ networks: (() => { const n = structuredClone(networks); delete n['11155111'].fundCreation; return n; })() });
    try {
      const got = await view(none);
      assert.equal(got.status, S.none.status);
      assert.deepEqual(got.json, S.none.body);
    } finally {
      await none.close();
    }
  });

  test('safe-create D-02: a malformed chainId is 400 invalid_chain_id; a valid one with no slot is the contract 404', async () => {
    const s = await stub();
    try {
      await post(s, REQ);
      for (const q of ['?chainId=abc', '?chainId=0', '?chainId=01', '?chainId=-1', '?chainId=', '?chainId=1.5', '?chainId=12345678901234567']) {
        const got = await viewAt(s, q);
        assert.equal(got.status, 400, `${q}: ${got.text}`);
        assert.deepEqual(got.json, { error: 'bad_request', reason: 'invalid_chain_id' }, q);
      }
      const none = await viewAt(s, `?chainId=${BASE}`);
      assert.equal(none.status, S.none.status);
      assert.deepEqual(none.json, S.none.body);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-02: a chainId above the largest safe integer is 400 invalid_chain_id, not a precision-lost 404', async () => {
    const s = await stub();
    try {
      await post(s, REQ);
      for (const q of ['?chainId=9007199254740992', '?chainId=9999999999999999']) {
        const got = await viewAt(s, q);
        assert.equal(got.status, 400, `${q}: ${got.text}`);
        assert.deepEqual(got.json, { error: 'bad_request', reason: 'invalid_chain_id' }, q);
      }
      // The largest safe integer is a valid id with no slot: the contract 404.
      const edge = await viewAt(s, '?chainId=9007199254740991');
      assert.equal(edge.status, S.none.status, edge.text);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-03 store: the claim stores the exact call it validated, once, and a retry never rewrites it', async () => {
    const s = await stub();
    try {
      const expected = creationCalldata(sepolia, buildInitializer(sepolia, REQ.owners, REQ.threshold), REQ.saltNonce);
      // A claim that broadcasts nothing (the simulation reverts): not_sent, with the validated call already stored.
      s.chains.options.estimateError = new Error('execution reverted');
      const failed = await post(s, REQ);
      assert.deepEqual(failed.json, R.simulationFailed.body);
      const stored = s.db.getCreation(REQ.siteUuid, REQ.groupUuid, 11155111);
      assert.equal(stored.status, 'not_sent');
      assert.equal(stored.callTarget, sepolia.factory);
      assert.equal(stored.callData, expected);
      // The same intent sends again: the slot's call is the call the transaction carried, and nothing rewrote it.
      delete s.chains.options.estimateError;
      const sent = await post(s, { ...REQ, actor: { uuid: uuid(301), address: REQ.owners[1] } });
      assert.equal(sent.status, 202, sent.text);
      const after = s.db.getCreation(REQ.siteUuid, REQ.groupUuid, 11155111);
      assert.equal(after.status, 'pending');
      assert.equal(after.callTarget, sepolia.factory);
      assert.equal(after.callData, s.chains.calls.sent.at(-1).data);
      assert.equal(after.callData, expected);
      // The answer body gained no field.
      assert.deepEqual(sent.json, withHash(R.accepted.body, sent.json.hash));
      const repeat = await post(s, REQ);
      assert.deepEqual(repeat.json, withHash(R.duplicate.body, sent.json.hash));
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, 11155111).callData, expected);
    } finally {
      await s.close();
    }
  });

  // D-03, D-16: the stored slot answers a repeat before anything is read or predicted; a not_sent retry sends
  // the call stored at the claim. The factory's code, the networks entry and the prediction may all have moved since.
  const OTHER_HASH = `0x${'11'.repeat(32)}`;
  const OTHER_HANDLER = getAddress('0x00000000000000000000000000000000000000f2');
  const OTHER_FACTORY = getAddress('0x00000000000000000000000000000000000000f1');
  /** A creation-code reader that counts its calls and can be told another hash. */
  function codeReader(gate = null) {
    const c = { calls: 0, hash: SEPOLIA_INIT_CODE_HASH };
    c.fn = async () => {
      c.calls += 1;
      if (gate) await gate;
      return { ok: true, hash: c.hash };
    };
    return c;
  }
  const untilCalls = async (c, n) => {
    for (let i = 0; i < 400 && c.calls < n; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.calls, n, 'both requests reached the factory read');
  };
  const storedFields = (db) => {
    const r = db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId);
    return { intentUuid: r.intentUuid, digest: r.digest, predictedAddress: r.predictedAddress, owners: r.owners, threshold: r.threshold, saltNonce: r.saltNonce, chainId: r.chainId, callTarget: r.callTarget, callData: r.callData };
  };

  test('safe-create D-16: a repeat of a claimed intent answers the stored address without reading the factory or predicting again, also after the code hash changed', async () => {
    const code = codeReader();
    const s = await stub({ creationCode: code.fn });
    try {
      const first = await post(s, REQ);
      assert.equal(first.status, 202, first.text);
      assert.equal(code.calls, 1);
      code.hash = OTHER_HASH; // a prediction made now would differ from the stored address
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
      assert.deepEqual(again.json, withHash(R.duplicate.body, first.json.hash));
      assert.equal(again.json.predictedAddress, REQ.predictedAddress);
      assert.equal(code.calls, 1, 'the factory was not read again');
      assert.equal(s.chains.calls.send, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-16: a repeat of a claimed intent is answered from the slot after fund creation was switched off for the network', async () => {
    const live = structuredClone(networks);
    const code = codeReader();
    const s = await stub({ networks: live, creationCode: code.fn });
    try {
      const first = await post(s, REQ);
      assert.equal(first.status, 202, first.text);
      live['11155111'].fundCreation = false;
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
      assert.deepEqual(again.json, withHash(R.duplicate.body, first.json.hash));
      assert.equal(code.calls, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-16: a different intent for a claimed slot is 409 slot_taken without reading the factory', async () => {
    const code = codeReader();
    const s = await stub({ creationCode: code.fn });
    try {
      assert.equal((await post(s, REQ)).status, 202);
      assert.equal(code.calls, 1);
      const other = await post(s, req({ intentUuid: uuid(555) }));
      assert.equal(other.status, 409, other.text);
      assert.deepEqual(other.json, { error: 'conflict', reason: 'slot_taken' });
      assert.equal(code.calls, 1, 'the factory was not read for the refused intent');
      assert.equal(s.chains.calls.send, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-16: a resend after a not_sent exit leaves the slot\'s intent, digest, address, owners, threshold, salt and network as they were', async () => {
    const s = await stub({ chainsOpts: { balance: 0n } });
    try {
      assert.equal((await post(s, REQ)).status, 502);
      const before = storedFields(s.db);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).status, 'not_sent');
      s.chains.options.balance = 5n * 10n ** 18n;
      assert.equal((await post(s, { ...REQ, actor: { uuid: uuid(301), address: REQ.owners[1] } })).status, 202);
      assert.deepEqual(storedFields(s.db), before);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).status, 'pending');
    } finally {
      await s.close();
    }
  });

  test('safe-create D-16 race: two identical requests that both passed the early read give one send and one duplicate', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const code = codeReader(gate);
    const s = await stub({ creationCode: code.fn });
    try {
      const both = Promise.all([post(s, REQ), post(s, REQ)]);
      await untilCalls(code, 2);
      release();
      const [a, b] = await both;
      assert.deepEqual([a.status, b.status], [202, 202]);
      assert.equal([a, b].filter((r) => r.json.duplicate === true).length, 1, 'exactly one is a duplicate');
      assert.equal(s.chains.calls.send, 1);
      assert.equal(attempts(s), 1);
      assert.equal(s.db.listPending().length, 1);
    } finally {
      release();
      await s.close();
    }
  });

  test('safe-create D-16 race: two different intents that both passed the early read give one send and one 409 slot_taken', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const code = codeReader(gate);
    const s = await stub({ creationCode: code.fn });
    try {
      const both = Promise.all([post(s, REQ), post(s, req({ intentUuid: uuid(556) }))]);
      await untilCalls(code, 2);
      release();
      const out = await both;
      assert.deepEqual(out.map((r) => r.status).sort(), [202, 409]);
      assert.deepEqual(out.find((r) => r.status === 409).json, { error: 'conflict', reason: 'slot_taken' });
      assert.equal(s.chains.calls.send, 1);
      assert.equal(attempts(s), 1);
    } finally {
      release();
      await s.close();
    }
  });

  test('safe-create D-16 retry: a not_sent resend after the fallback handler and the code hash changed sends the stored call to the stored address, never predicting again', async () => {
    const live = structuredClone(networks);
    const code = codeReader();
    const s = await stub({ networks: live, creationCode: code.fn, chainsOpts: { balance: 0n } });
    try {
      assert.equal((await post(s, REQ)).status, 502);
      const stored = s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId);
      assert.equal(stored.status, 'not_sent');
      const reads = code.calls;
      // Drift: a recomputed prediction would now differ from the stored address, and the entry builds other calldata.
      live['11155111'].safeFallbackHandler = OTHER_HANDLER;
      code.hash = OTHER_HASH;
      const drifted = deploymentOf(live['11155111']);
      const driftedData = creationCalldata(drifted, buildInitializer(drifted, REQ.owners, REQ.threshold), REQ.saltNonce);
      assert.notEqual(driftedData, stored.callData);
      s.chains.options.balance = 5n * 10n ** 18n;
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
      assert.equal(again.json.predictedAddress, REQ.predictedAddress);
      assert.equal(code.calls, reads, 'the factory was not read for the retry');
      const sent = s.chains.calls.sent.at(-1);
      assert.equal(sent.to, stored.callTarget);
      assert.equal(sent.data, stored.callData);
      assert.notEqual(sent.data, driftedData);
      assert.equal(attempts(s), 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-16 retry: a not_sent resend after the factory address itself changed still sends to the stored factory', async () => {
    const live = structuredClone(networks);
    const s = await stub({ networks: live, chainsOpts: { balance: 0n } });
    try {
      assert.equal((await post(s, REQ)).status, 502);
      const stored = s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId);
      live['11155111'].safeProxyFactory = OTHER_FACTORY;
      s.chains.options.balance = 5n * 10n ** 18n;
      const again = await post(s, REQ);
      assert.equal(again.status, 202, again.text);
      assert.equal(s.chains.calls.sent.at(-1).to, stored.callTarget);
      assert.equal(s.chains.calls.sent.at(-1).to, sepolia.factory);
      assert.notEqual(s.chains.calls.sent.at(-1).to, OTHER_FACTORY);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-16 retry: fund creation switched off for the network refuses the resend 403 network_not_supported, nothing counted or sent', async () => {
    const live = structuredClone(networks);
    const s = await stub({ networks: live, chainsOpts: { balance: 0n } });
    try {
      assert.equal((await post(s, REQ)).status, 502);
      live['11155111'].fundCreation = false;
      s.chains.options.balance = 5n * 10n ** 18n;
      const again = await post(s, REQ);
      assert.equal(again.status, R.networkNotSupported.status, again.text);
      assert.deepEqual(again.json, R.networkNotSupported.body);
      assert.equal(s.chains.calls.send, 0);
      assert.equal(attempts(s), 0);
      assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).status, 'not_sent');
    } finally {
      await s.close();
    }
  });

  test('safe-create D-16 retry: a not_sent slot with no stored call takes the full path, whose prediction check refuses any other address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'safe-create-retry-'));
    try {
      for (const drift of [false, true]) {
        const live = structuredClone(networks);
        const code = codeReader();
        const dbPath = join(dir, drift ? 'drift.db' : 'plain.db');
        const s = await stub({ networks: live, creationCode: code.fn, dbPath, chainsOpts: { balance: 0n } });
        try {
          assert.equal((await post(s, REQ)).status, 502);
          // A row migrated from the first fund-creation release has no stored call.
          const raw = new DatabaseSync(dbPath);
          raw.exec('UPDATE creations SET call_target = NULL, call_data = NULL');
          raw.close();
          assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId).callData, null);
          const reads = code.calls;
          if (drift) live['11155111'].safeFallbackHandler = OTHER_HANDLER;
          s.chains.options.balance = 5n * 10n ** 18n;
          const again = await post(s, REQ);
          assert.equal(code.calls, reads + 1, 'the factory is read again');
          if (drift) {
            assert.equal(again.status, 400, again.text);
            assert.deepEqual(again.json, { error: 'bad_request', reason: 'prediction_mismatch' });
            assert.equal(s.chains.calls.sent.length, 0);
            assert.equal(attempts(s), 0);
          } else {
            assert.equal(again.status, 202, again.text);
            assert.equal(s.chains.calls.sent.at(-1).to, sepolia.factory);
          }
        } finally {
          await s.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // TM-288: actor.uuid is the site's word, so the per-site quota is what stops a dishonest site.
  test('safe-create TM-288: the per-site quota stops a fourth creation in a day even when every request names a fresh actor', async () => {
    const s = await stub({ creationPolicy: policyOf({ limits: { perActorPerDay: 1, perSitePerDay: 3 } }) });
    try {
      const out = [];
      for (const n of [1, 2, 3, 4]) {
        const body = forGroup(n);
        assert.equal(body.actor.uuid, uuid(200 + n), 'each request names its own actor');
        out.push(await post(s, body));
      }
      assert.deepEqual(out.map((r) => r.status), [202, 202, 202, 429]);
      assert.equal(out[3].json.error, 'setup_limit');
      assert.equal(out[3].json.scope, 'site');
      assert.equal(s.chains.calls.send, 3);
      assert.equal(attempts(s), 3);
    } finally {
      await s.close();
    }
  });

  // D-05: an enabled policy that leaves the site empty serves the site that binds it through POST /site.
  const SELF = () => policyOf({ siteUuid: '' });
  const enrol = (s, siteUuid) => s.call('POST', '/site', { siteUuid });
  const FUND = REQ.predictedAddress;
  // The slot's own queue row gets a receipt, as the queue's poll loop would store it.
  function receipt(s, hash, receiptStatus) {
    const row = s.db.findLatestByDedupeKey(REQ.chainId, dedupeKeyOf(REQ.siteUuid, REQ.groupUuid));
    s.db.updatePending(row.id, { ...row, status: 'confirming', consumedBy: hash, consumedBlock: 5n, minedBlockHash: `0x${'cd'.repeat(32)}`, receiptStatus });
  }

  test('safe-create D-05: a self-binding relayer that is not yet bound refuses creation 403 site_mismatch before any claim', async () => {
    const s = await stub({ creationPolicy: SELF() });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.siteMismatch.status, res.text);
      assert.deepEqual(res.json, R.siteMismatch.body);
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(s.chains.calls.send, 0);
      assert.equal(attempts(s), 0);
      assert.equal(s.db.listCreations('sending').length + s.db.listCreations('pending').length + s.db.listCreations('not_sent').length, 0);
      assert.ok(s.logs.some((l) => l.startsWith('refused site_mismatch ')), 'refusal logged');
    } finally {
      await s.close();
    }
  });

  test('safe-create D-05: once POST /site binds the site, its request with a listed Group is accepted and another site is refused', async () => {
    const s = await stub({ creationPolicy: SELF() });
    try {
      assert.equal((await enrol(s, REQ.siteUuid)).status, 201);
      const other = await post(s, req({ siteUuid: uuid(77) }));
      assert.equal(other.status, R.siteMismatch.status, other.text);
      assert.deepEqual(other.json, R.siteMismatch.body);
      assert.equal(s.chains.calls.send, 0);
      const res = await post(s, REQ);
      assert.equal(res.status, R.accepted.status, res.text);
      assert.deepEqual(res.json, withHash(R.accepted.body, res.json.hash));
      assert.equal(s.chains.calls.send, 1);
      assert.equal((await view(s)).status, 200);
    } finally {
      await s.close();
    }
  });

  // TM-281: a second site's refused enrolment resets nothing; the bound site's attempts still count.
  test('safe-create TM-281: after the bound site filled its quota and another site was refused, the next request is still 429 setup_limit site', async () => {
    const s = await stub({ creationPolicy: policyOf({ siteUuid: '', limits: { perActorPerDay: 1, perSitePerDay: 3 } }) });
    try {
      assert.equal((await enrol(s, REQ.siteUuid)).status, 201);
      for (const n of [1, 2, 3]) assert.equal((await post(s, forGroup(n))).status, 202);
      assert.equal(attempts(s), 3);
      const refused = await enrol(s, uuid(77));
      assert.equal(refused.status, 409, refused.text);
      assert.deepEqual(refused.json, { error: 'conflict', reason: 'site_mismatch' });
      assert.equal((await enrol(s, REQ.siteUuid)).status, 200);
      assert.equal(attempts(s), 3, 'the refused enrolment reset nothing');
      const next = await post(s, forGroup(4));
      assert.equal(next.status, 429, next.text);
      assert.equal(next.json.error, 'setup_limit');
      assert.equal(next.json.scope, 'site');
      assert.equal(s.chains.calls.send, 3);
      // The refused site gets no slot and no attempt either: it is not the bound site.
      const intruder = await post(s, req({ siteUuid: uuid(77), groupUuid: GROUPS[4], actor: { ...REQ.actor, uuid: uuid(299) } }));
      assert.equal(intruder.status, 403);
      assert.equal(s.db.countedCreationAttempts(uuid(77), REQ.chainId, 0).length, 0);
    } finally {
      await s.close();
    }
  });

  // D-06, D-07, D-21, TM-280: what the image ships. Creation on, the site binds itself, every group of that site qualifies.
  const SHIPPED = () => loadCreationPolicy({ env: {}, logger: { warn: () => assert.fail('the shipped policy file must load without a warning') } });
  const anyGroup = (n) => req({ groupUuid: uuid(900 + n), intentUuid: uuid(950 + n), actor: { ...REQ.actor, uuid: uuid(850 + n) }, saltNonce: String(2000 + n) });

  test('safe-create D-06: with the shipped policy, once POST /site binds the site, a group that appears in no list is accepted', async () => {
    const s = await stub({ creationPolicy: SHIPPED() });
    try {
      assert.equal((await enrol(s, REQ.siteUuid)).status, 201);
      assert.ok(!GROUPS.includes(uuid(901)), 'the group is in no list');
      const res = await post(s, anyGroup(1));
      assert.equal(res.status, R.accepted.status, res.text);
      assert.equal(s.chains.calls.send, 1);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-06: with the shipped policy and an unbound relayer, creation is 403 site_mismatch before any claim', async () => {
    const s = await stub({ creationPolicy: SHIPPED() });
    try {
      const res = await post(s, anyGroup(1));
      assert.equal(res.status, R.siteMismatch.status, res.text);
      assert.deepEqual(res.json, R.siteMismatch.body);
      assert.equal(s.chains.calls.send, 0);
      assert.equal(attempts(s), 0);
      assert.equal(s.db.getCreation(REQ.siteUuid, uuid(901), REQ.chainId), null);
    } finally {
      await s.close();
    }
  });

  test('safe-create D-21: a non-empty group list is an allow-list: a listed group goes through, an unlisted one is 403 group_not_enrolled before any claim', async () => {
    const s = await stub({ creationPolicy: policyOf({ groups: [GROUPS[0]] }) });
    try {
      const refused = await post(s, anyGroup(1));
      assert.equal(refused.status, R.groupNotEnrolled.status, refused.text);
      assert.deepEqual(refused.json, R.groupNotEnrolled.body);
      assert.equal(s.chains.calls.estimate, 0);
      assert.equal(s.chains.calls.send, 0);
      assert.equal(attempts(s), 0);
      assert.equal(s.db.getCreation(REQ.siteUuid, uuid(901), REQ.chainId), null);
      const listed = await post(s, REQ);
      assert.equal(listed.status, R.accepted.status, listed.text);
      assert.equal(s.chains.calls.send, 1);
    } finally {
      await s.close();
    }
  });

  // TM-280: with an empty list the group is not a bound; the per-site quota is.
  test('safe-create TM-280: with the shipped policy the fourth different group in a day is 429 setup_limit scope site', async () => {
    const s = await stub({ creationPolicy: SHIPPED() });
    try {
      assert.equal((await enrol(s, REQ.siteUuid)).status, 201);
      const out = [];
      for (const n of [1, 2, 3, 4]) out.push(await post(s, anyGroup(n)));
      assert.deepEqual(out.map((r) => r.status), [202, 202, 202, 429]);
      assert.equal(out[3].json.error, 'setup_limit');
      assert.equal(out[3].json.scope, 'site');
      assert.equal(s.chains.calls.send, 3);
      assert.equal(attempts(s), 3);
    } finally {
      await s.close();
    }
  });

  // D-24 on a self-binding relayer: the created-fund rule reads the bound site, so it works once POST /site ran.
  test('safe-create D-24: on a self-binding relayer a fund created for the bound site and confirmed makes a sponsored send; before the site is bound, nothing counts', async () => {
    const s = await stub({ creationPolicy: SELF() });
    try {
      const before = await s.call('POST', '/send/safe-exec', execBody(networks, { safe: FUND }));
      assert.equal(before.status, 403, before.text);
      assert.equal(before.json.reason, 'safe_not_registered');
      assert.equal((await enrol(s, REQ.siteUuid)).status, 201);
      const created = await post(s, REQ);
      assert.equal(created.status, 202, created.text);
      const pending = await s.call('POST', '/send/safe-exec', execBody(networks, { safe: FUND }));
      assert.equal(pending.json.reason, 'safe_not_registered', 'not counted before its creation is confirmed');
      receipt(s, created.json.hash, 'success');
      const sent = await s.call('POST', '/send/safe-exec', execBody(networks, { safe: FUND }));
      assert.equal(sent.status, 202, sent.text);
      assert.equal(s.chains.calls.sent.at(-1).to.toLowerCase(), FUND.toLowerCase());
      assert.equal(s.chains.calls.sent.length, 2, 'the creation and the send');
    } finally {
      await s.close();
    }
  });

  test('safe-create D-24: a fresh self-binding relayer that was never bound answers safe_not_registered for any address', async () => {
    const s = await stub({ creationPolicy: SELF() });
    try {
      for (const safe of [FUND, REQ.owners[0], '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe']) {
        const res = await s.call('POST', '/send/safe-exec', execBody(networks, { safe }));
        assert.equal(res.status, 403, res.text);
        assert.equal(res.json.reason, 'safe_not_registered', safe);
      }
      assert.equal(s.chains.calls.send, 0);
    } finally {
      await s.close();
    }
  });

  // D-26 on a self-binding relayer: GET /status lists the bound site's confirmed fund apart from groups.
  test('safe-create D-26: on a self-binding relayer GET /status lists the bound site\'s confirmed fund in createdFunds and not in groups', async () => {
    const s = await stub({ creationPolicy: SELF() });
    try {
      assert.deepEqual((await s.call('GET', '/status')).json.createdFunds, []);
      assert.equal((await enrol(s, REQ.siteUuid)).status, 201);
      const created = await post(s, REQ);
      assert.equal(created.status, 202, created.text);
      assert.deepEqual((await s.call('GET', '/status')).json.createdFunds, [], 'not listed while its creation is pending');
      receipt(s, created.json.hash, 'success');
      const status = await s.call('GET', '/status');
      assert.equal(status.status, 200, status.text);
      assert.deepEqual(status.json.createdFunds, [{ chainId: REQ.chainId, safe: FUND }]);
      assert.equal(status.json.groups.some((g) => g.safe.toLowerCase() === FUND.toLowerCase()), false, 'a created fund is never a group');
    } finally {
      await s.close();
    }
  });

  // D-07 (TM-283): a network not flagged testnet is refused by the code and by the allow-list, even when marked for
  // fund creation, and before the creation code is read, an attempt counted or an estimate made.
  for (const sponsoring of [true, false]) {
    test(`safe-create D-07: a fund-creation network not flagged testnet is refused 403 network_not_supported (sponsoring ${sponsoring}), before any read, estimate or claim`, async () => {
      const real = structuredClone(networks);
      real['11155111'].testnet = false;
      real['11155111'].sponsoring = sponsoring;
      let codeReads = 0;
      const countingCode = async (...args) => {
        codeReads += 1;
        return sepoliaCreationCode(...args);
      };
      const s = await stub({ networks: real, creationCode: countingCode });
      try {
        const res = await post(s, REQ);
        assert.equal(res.status, 403, res.text);
        assert.deepEqual(res.json, R.networkNotSupported.body);
        assert.equal(codeReads, 0);
        assert.equal(s.chains.calls.estimate, 0);
        assert.equal(s.chains.calls.send, 0);
        assert.equal(attempts(s), 0);
        assert.equal(s.db.getCreation(REQ.siteUuid, REQ.groupUuid, REQ.chainId), null);
        assert.ok(s.logs.some((l) => l.startsWith('refused network_not_supported ')), 'refusal logged');
      } finally {
        await s.close();
      }
    });
  }

  test('safe-create D-07: the creation allow-list leaves out a network not flagged testnet', () => {
    const real = structuredClone(networks);
    const data = creationCalldata(sepolia, buildInitializer(sepolia, REQ.owners, REQ.threshold), REQ.saltNonce);
    assert.equal(buildCreation(real).check(11155111, sepolia.factory, data.slice(0, 10)).ok, true);
    real['11155111'].testnet = false;
    assert.deepEqual(buildCreation(real).check(11155111, sepolia.factory, data.slice(0, 10)), { ok: false, reason: 'network_not_supported' });
    delete real['11155111'].testnet;
    assert.equal(buildCreation(real).check(11155111, sepolia.factory, data.slice(0, 10)).ok, false);
  });

  test('safe-create: the factory is not reachable through /send/safe-exec or the exec allow-list', async () => {
    const s = await stub();
    try {
      const data = creationCalldata(sepolia, buildInitializer(sepolia, REQ.owners, REQ.threshold), REQ.saltNonce);
      const res = await s.call('POST', '/send/safe-exec', execBody(networks, { safe: sepolia.factory, to: sepolia.factory, data, value: '0' }));
      assert.notEqual(res.status, 202, res.text);
      assert.equal(s.chains.calls.send, 0);
      const v = build(networks).check(11155111, sepolia.factory, data.slice(0, 10));
      assert.equal(v.ok, false);
    } finally {
      await s.close();
    }
  });

  // The first estimate's network failure is read like the second's. A transport
  // failure, or a failure that is no revert at all, is a retryable 502 whatever the balance read says; only a revert
  // is the call's own failure.
  test('safe-create D-15: a first estimate that fails in transport is a retryable 502, never a held 409, whether or not the balance can be read', async () => {
    const http = () => Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError' });
    const timeout = () => Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' });
    const wrapped = () => Object.assign(new Error('Execution reverted for an unknown reason.'), { name: 'EstimateGasExecutionError', cause: http() });
    const cases = [
      ['outage: the estimate and the balance read both fail', { estimateError: http(), balance: () => { throw http(); } }],
      ['a timeout on the first estimate, the node back for the rest', { estimateError: timeout(), estimateErrorAccountOnly: true }],
      ['a transport failure inside a revert-worded estimate error', { estimateError: wrapped(), estimateErrorAccountOnly: true }],
      ['an error that is no revert at all', { estimateError: new Error('boom'), estimateErrorAccountOnly: true }],
    ];
    for (const [name, chainsOpts] of cases) {
      const s = await stub({ chainsOpts });
      try {
        const res = await post(s, REQ);
        assert.equal(res.status, 502, `${name}: ${res.text}`);
        assert.deepEqual(res.json, { error: 'send_failed', reason: 'fee_estimate_failed', broadcast: false }, name);
        assert.equal(attempts(s), 0, name);
        assert.equal(s.chains.calls.send, 0, name);
      } finally {
        await s.close();
      }
    }
    // A funded account whose call genuinely reverts is still the held 409.
    const s = await stub({ chainsOpts: { estimateError: Object.assign(new Error('execution reverted: GS013'), { name: 'ExecutionRevertedError' }) } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.simulationFailed.status, res.text);
      assert.deepEqual(res.json, R.simulationFailed.body);
    } finally {
      await s.close();
    }
  });

  // A typed revert is the call's own failure even when the error's text holds a
  // transport-looking word (here the RPC URL's query string); only a typed transport failure outranks it.
  test('safe-create D-15: a typed revert whose message names a timeout in the RPC URL is still the held 409, even with the balance unreadable', async () => {
    const revert = Object.assign(new Error('Execution reverted with reason: GS013. URL: https://rpc.example/?timeout=30'), {
      name: 'EstimateGasExecutionError',
      cause: Object.assign(new Error('execution reverted: GS013'), { name: 'ExecutionRevertedError', code: 3 }),
    });
    const s = await stub({ chainsOpts: { estimateError: revert, balance: () => { throw new Error('rpc down'); } } });
    try {
      const res = await post(s, REQ);
      assert.equal(res.status, R.simulationFailed.status, res.text);
      assert.deepEqual(res.json, R.simulationFailed.body);
      assert.equal(attempts(s), 0);
    } finally {
      await s.close();
    }
  });
});
