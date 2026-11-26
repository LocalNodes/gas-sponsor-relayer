// The fund-creation policy file, the attempt quotas, and the relayer's own factory call against the contract's golden
// vectors (Sponsored Fund Creation). No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, keccak256, toFunctionSelector } from 'viem';
import { buildCreation, CREATION_SELECTORS, CREATION_SIGNATURES } from '../../src/allowlist.js';
import { loadNetworks } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { DAY_S, DISABLED_POLICY, UNREADABLE_POLICY, loadCreationPolicy, parseCreationPolicy, quotaVerdict, slotState } from '../../src/creations.js';
import { buildInitializer, deploymentOf, intentDigest, parseSafeCreateBody, predictAddress, PROXY_CREATION_CODE_141_KECCAK } from '../../src/sends/safeCreate.js';
import { SEPOLIA_INIT_CODE_HASH } from '../helpers/creation.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/fund-creation-contract.json', import.meta.url), 'utf8'));
const networks = loadNetworks();
const SITE = fx.request.siteUuid;
const CHAIN = fx.request.chainId;
const GOOD = { enabled: true, siteUuid: SITE, groups: [fx.request.groupUuid], limits: { perActorPerDay: 1, perSitePerDay: 3 } };

describe('creation policy (unit)', () => {
  test('creation-policy D-07: the shipped file is valid, on, and leaves the site and the groups to the site', () => {
    const shipped = JSON.parse(readFileSync(new URL('../../config/fund-creation.json', import.meta.url), 'utf8'));
    const p = parseCreationPolicy(shipped);
    assert.equal(p.ok, true, p.error);
    assert.equal(p.policy.enabled, true);
    assert.equal(p.policy.siteUuid, '');
    assert.deepEqual(p.policy.groups, []);
    assert.deepEqual(p.policy.limits, { perActorPerDay: 1, perSitePerDay: 3 });
  });

  test('creation-policy: exact keys, lower-case UUIDs, a site that is empty or a UUID, limits 1 to 1000', () => {
    assert.equal(parseCreationPolicy(GOOD).ok, true);
    for (const bad of [
      { ...GOOD, extra: 1 }, { enabled: true, siteUuid: SITE, groups: [] }, { ...GOOD, enabled: 'yes' }, { ...GOOD, siteUuid: 7 },
      { ...GOOD, siteUuid: SITE.toUpperCase() }, { ...GOOD, groups: ['nope'] }, { ...GOOD, groups: [SITE, SITE] }, { ...GOOD, groups: 'all' },
      { ...GOOD, limits: { perActorPerDay: 0, perSitePerDay: 3 } }, { ...GOOD, limits: { perActorPerDay: 1, perSitePerDay: 1001 } },
      { ...GOOD, limits: { perActorPerDay: 1.5, perSitePerDay: 3 } }, { ...GOOD, limits: { perActorPerDay: 1 } }, { ...GOOD, limits: { perActorPerDay: 1, perSitePerDay: 3, x: 1 } },
      null, [], 'on',
    ]) {
      assert.equal(parseCreationPolicy(bad).ok, false, JSON.stringify(bad));
    }
    // Off with no site is fine.
    assert.equal(parseCreationPolicy({ ...GOOD, enabled: false, siteUuid: '' }).ok, true);
  });

  // D-07 (first half): an enabled policy with the site left empty is valid; it means the site binds itself (POST /site).
  test('creation-policy D-07: an enabled policy with an empty siteUuid parses, as the self-binding policy', () => {
    const p = parseCreationPolicy({ ...GOOD, siteUuid: '' });
    assert.equal(p.ok, true, p.error);
    assert.equal(p.policy.enabled, true);
    assert.equal(p.policy.siteUuid, '');
    assert.equal(Object.isFrozen(p.policy), true);
    // A site that is set must still be a lower-case UUID.
    assert.equal(parseCreationPolicy({ ...GOOD, siteUuid: SITE.toUpperCase() }).ok, false);
    assert.equal(parseCreationPolicy({ ...GOOD, siteUuid: 'not-a-uuid' }).ok, false);
  });

  test('creation-policy: a missing, unreadable or invalid file turns creation off with one log line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'creation-policy-'));
    try {
      const logs = [];
      const logger = { warn: (l) => logs.push(l) };
      const good = join(dir, 'good.json');
      writeFileSync(good, JSON.stringify(GOOD));
      assert.deepEqual(loadCreationPolicy({ env: { SPONSOR_RELAYER_FUND_CREATION_CONFIG: good }, logger }), parseCreationPolicy(GOOD).policy);
      assert.equal(logs.length, 0);
      const broken = join(dir, 'broken.json');
      writeFileSync(broken, '{not json');
      const invalid = join(dir, 'invalid.json');
      writeFileSync(invalid, JSON.stringify({ ...GOOD, siteUuid: SITE.toUpperCase() }));
      for (const path of [join(dir, 'missing.json'), broken, invalid]) {
        logs.length = 0;
        const loaded = loadCreationPolicy({ env: { SPONSOR_RELAYER_FUND_CREATION_CONFIG: path }, logger });
        // Creation off, as DISABLED_POLICY, but its own object: boundSite() reads it as no site (fail closed).
        assert.equal(loaded, UNREADABLE_POLICY);
        assert.deepEqual(loaded, DISABLED_POLICY);
        assert.equal(logs.length, 1);
        assert.match(logs[0], /fund creation off/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creation-policy: quotas are rolling, actor first, given-back attempts do not count', () => {
    const db = openDb(':memory:');
    try {
      const policy = parseCreationPolicy({ ...GOOD, limits: { perActorPerDay: 2, perSitePerDay: 3 } }).policy;
      const t0 = 1_000_000;
      const a = (actorUuid, at) => db.insertCreationAttempt({ siteUuid: SITE, groupUuid: SITE, chainId: CHAIN, actorUuid }, at);
      assert.equal(quotaVerdict(db, policy, SITE, CHAIN, 'x', t0), null);
      a('x', t0);
      const given = a('x', t0 + 10);
      db.returnCreationAttempt(given);
      assert.equal(quotaVerdict(db, policy, SITE, CHAIN, 'x', t0 + 20), null);
      a('x', t0 + 20);
      assert.deepEqual(quotaVerdict(db, policy, SITE, CHAIN, 'x', t0 + 30), { scope: 'actor', until: t0 + DAY_S });
      a('y', t0 + 40);
      assert.deepEqual(quotaVerdict(db, policy, SITE, CHAIN, 'z', t0 + 50), { scope: 'site', until: t0 + DAY_S });
      // Once the oldest leaves the window, one more fits.
      assert.equal(quotaVerdict(db, policy, SITE, CHAIN, 'z', t0 + DAY_S), null);
      // Another site's attempts are its own.
      assert.equal(quotaVerdict(db, policy, '11111111-1111-4111-8111-111111111111', CHAIN, 'x', t0 + 50), null);
    } finally {
      db.close();
    }
  });
});

describe('creation call (unit)', () => {
  const d = deploymentOf(networks['11155111']);

  test('creation call: the Sepolia Safe 1.4.1 addresses and the proxy creation code are the contract vectors', () => {
    assert.deepEqual(d, { factory: getAddress(fx.vectors.factory), singleton: getAddress(fx.vectors.singleton), fallbackHandler: getAddress(fx.vectors.fallbackHandler) });
    // The relayer and the contract keep only the code's hash (licence guard); the fork suite checks the factory's own
    // code against it.
    assert.equal(PROXY_CREATION_CODE_141_KECCAK, fx.vectors.proxyCreationCodeKeccak256);
    assert.equal(networks['11155111'].fundCreation, true);
    for (const [id, entry] of Object.entries(networks)) if (id !== '11155111') assert.notEqual(entry.fundCreation, true, id);
  });

  for (const c of fx.vectors.cases) {
    test(`creation call: golden vector ${c.name} (initializer and CREATE2 address)`, () => {
      const init = buildInitializer(d, c.owners, c.threshold);
      assert.equal(init, c.initializer);
      assert.equal(predictAddress(d, init, c.saltNonce, SEPOLIA_INIT_CODE_HASH), getAddress(c.predictedAddress));
    });
  }

  test('creation call: the selectors are the signatures, and only createProxyWithNonce on the chain factory is allowed', () => {
    for (const [name, sig] of Object.entries(CREATION_SIGNATURES)) assert.equal(CREATION_SELECTORS[name], toFunctionSelector(sig), name);
    const allow = buildCreation(networks);
    assert.deepEqual(allow.check(11155111, d.factory, CREATION_SELECTORS.createProxyWithNonce), { ok: true });
    assert.deepEqual(allow.check(11155111, d.factory, CREATION_SELECTORS.setup), { ok: false, reason: 'selector_not_allowed' });
    assert.deepEqual(allow.check(11155111, d.singleton, CREATION_SELECTORS.createProxyWithNonce), { ok: false, reason: 'target_not_allowed' });
    assert.deepEqual(allow.check(84532, d.factory, CREATION_SELECTORS.createProxyWithNonce), { ok: false, reason: 'network_not_supported' });
    const off = structuredClone(networks);
    off['11155111'].sponsoring = false;
    assert.equal(buildCreation(off).check(11155111, d.factory, CREATION_SELECTORS.createProxyWithNonce).ok, false);
  });

  test('creation call: the intent digest ignores the actor and the envelope, and nothing else', () => {
    const base = parseSafeCreateBody(fx.request).value;
    const dg = intentDigest(base);
    assert.equal(intentDigest({ ...base, actor: { uuid: SITE, address: base.owners[1] }, issuedAt: 1, expiresAt: 2 }), dg);
    for (const over of [{ chainId: 1 }, { intentUuid: SITE }, { owners: [...base.owners].reverse() }, { predictedAddress: base.owners[0] }, { safeVersion: '1.3.0' }, { saltNonce: '1' }, { threshold: 1 }]) {
      assert.notEqual(intentDigest({ ...base, ...over }), dg, JSON.stringify(over));
    }
  });
});

describe('slot view floor', () => {
  test('a queue row at or below the slot floor belongs to an earlier claim, not this one', () => {
    const old = { id: 7, status: 'replaced', hash: '0x' + '11'.repeat(32), consumedBy: null, receiptStatus: null };
    const db = { findLatestByDedupeKey: () => old };
    const slot = { status: 'sending', hash: null, chainId: 11155111, dedupeKey: 'k', rowFloor: 7 };
    assert.deepEqual(slotState(db, slot), { status: 'sending', hash: null });
    assert.deepEqual(slotState(db, { ...slot, rowFloor: 6 }), { status: 'not_sent', hash: null });
  });

  // D-02: the quotas are per network.
  for (const [scope, limits] of [['site', { perActorPerDay: 5, perSitePerDay: 3 }], ['actor', { perActorPerDay: 3, perSitePerDay: 5 }]]) {
    test(`creation-policy D-02: three counted attempts on one network stop the ${scope} there and not on another network`, () => {
      const db = openDb(':memory:');
      try {
        const policy = parseCreationPolicy({ ...GOOD, limits }).policy;
        const A = 11155111;
        const B = 84532;
        const t0 = 1_000_000;
        for (let i = 0; i < 3; i += 1) db.insertCreationAttempt({ siteUuid: SITE, groupUuid: SITE, chainId: A, actorUuid: 'x' }, t0 + i);
        assert.deepEqual(quotaVerdict(db, policy, SITE, A, 'x', t0 + 10), { scope, until: t0 + DAY_S });
        assert.equal(quotaVerdict(db, policy, SITE, B, 'x', t0 + 10), null);
        // The same Group's attempt on the other network is counted there alone.
        db.insertCreationAttempt({ siteUuid: SITE, groupUuid: SITE, chainId: B, actorUuid: 'x' }, t0 + 20);
        assert.equal(db.countedCreationAttempts(SITE, B, 0).length, 1);
        assert.equal(db.countedCreationAttempts(SITE, A, 0).length, 3);
        assert.equal(quotaVerdict(db, policy, SITE, B, 'x', t0 + 30), null);
      } finally {
        db.close();
      }
    });
  }

  // D-07 (TM-283): fund creation is only ever switched on for a test network.
  test('creation-policy D-07: every shipped network marked for fund creation is a testnet', () => {
    const marked = Object.entries(networks).filter(([, entry]) => entry.fundCreation === true);
    assert.ok(marked.length >= 1, 'at least one network is marked');
    for (const [id, entry] of marked) assert.equal(entry.testnet, true, `network ${id} is marked for fund creation but is not a testnet`);
  });
});
