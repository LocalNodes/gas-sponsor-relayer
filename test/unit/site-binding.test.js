// POST /site and GET /site: the relayer learns which site it serves from the site itself (D-05), the operator's policy
// file still wins (D-20), and creation reads the bound site. First claim wins and is permanent (TM-281). Stubbed chain;
// no network. The answers follow the shared enrolment contract (test/fixtures/site-enrolment-contract.json, replayed by
// site-enrolment-contract.test.js).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROUTES } from '../../src/server.js';
import { DISABLED_POLICY, loadCreationPolicy } from '../../src/creations.js';
import { startStub } from '../helpers/stub.js';

const SITE = '5b0e7c1e-2f43-4a8e-9d55-0c6f6a0e9b11';
const OTHER = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const GROUP = '3f6c2a10-8d1b-4e57-9a2c-5b7e1d0c4f68';
const LIMITS = Object.freeze({ perActorPerDay: 1, perSitePerDay: 3 });
// The shape parseCreationPolicy returns, built by hand: an enabled policy with the site left to the site (D-07).
const policy = (siteUuid, groups = []) => Object.freeze({ enabled: true, siteUuid, groups: Object.freeze([...groups]), limits: LIMITS });
const SELF = policy('');
const OPERATOR = policy(SITE);

const enrol = (s, siteUuid, token) => s.call('POST', '/site', { siteUuid }, token);
const bound = (siteUuid) => ({ siteUuid, bound: true, created: true });
const CONFLICT = { error: 'conflict', reason: 'site_mismatch' };
const INVALID = { error: 'bad_request', reason: 'invalid_body' };

/** A slot row for `siteUuid`, as the claim in safe-create would have stored it (not sent: no queue row is needed to read it). */
function seedSlot(db, siteUuid, intentUuid) {
  db.insertCreation({
    siteUuid, groupUuid: GROUP, intentUuid, digest: `0x${'ab'.repeat(32)}`, chainId: 11155111, safeVersion: '1.4.1',
    owners: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'], threshold: 1, saltNonce: '7', predictedAddress: '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe',
    actorUuid: GROUP, actorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', status: 'not_sent', dedupeKey: `safe-create:${siteUuid}:${GROUP}`,
  }, 1000);
}

/** The statements in a db.js source that could change or remove the stored binding (D-05, TM-281). Empty when there are none. */
function rebindingStatements(source) {
  return source.split('\n').filter((line) => /(UPDATE\s+site_binding|DELETE\s+FROM\s+site_binding|REPLACE\s+INTO\s+site_binding|DROP\s+TABLE\s+(IF\s+EXISTS\s+)?site_binding)/i.test(line));
}

describe('site binding (unit)', () => {
  test('site-binding: the first site that asks binds the relayer for ever (201), the same site again is 200, another site is 409, and GET reads the first', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      const first = await enrol(s, SITE);
      assert.equal(first.status, 201, first.text);
      assert.deepEqual(first.json, bound(SITE));
      const again = await enrol(s, SITE);
      assert.equal(again.status, 200, again.text);
      assert.deepEqual(again.json, { siteUuid: SITE, bound: true, created: false });
      const other = await enrol(s, OTHER);
      assert.equal(other.status, 409, other.text);
      assert.deepEqual(other.json, CONFLICT);
      const read = await s.call('GET', '/site');
      assert.equal(read.status, 200);
      assert.deepEqual(read.json, { bound: true, siteUuid: SITE });
      assert.equal(s.db.siteBinding(), SITE);
      // The refused site's UUID is in no answer, no stored row and no log line.
      assert.equal(JSON.stringify([first.json, again.json, other.json, read.json]).includes(OTHER), false);
      assert.equal(s.logs.join('\n').includes(OTHER), false);
      assert.equal(s.logs.join('\n').includes(SITE), false);
    } finally {
      await s.close();
    }
  });

  test('site-binding: a fresh relayer with no operator site reads {bound: false}', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      const read = await s.call('GET', '/site');
      assert.equal(read.status, 200);
      assert.deepEqual(read.json, { bound: false });
      assert.equal(s.db.siteBinding(), null);
    } finally {
      await s.close();
    }
  });

  test('site-binding: a body that is not exactly {"siteUuid": "<lower-case uuid>"} is 400 invalid_body (413 when oversized) and stores nothing', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      for (const bad of [
        { siteUuid: SITE.toUpperCase() }, {}, { site: SITE }, { siteUuid: SITE, extra: 1 }, { siteUuid: 7 }, { siteUuid: null }, { siteUuid: [SITE] },
        { siteUuid: `${SITE} ` }, { siteUuid: 'not-a-uuid' }, [], [{ siteUuid: SITE }], JSON.stringify('x'), 7, null, true,
      ]) {
        const res = await s.call('POST', '/site', bad);
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.deepEqual(res.json, INVALID, JSON.stringify(bad));
      }
      assert.equal((await s.call('POST', '/site', 'not json')).status, 400);
      const big = await s.call('POST', '/site', JSON.stringify({ siteUuid: SITE, pad: 'x'.repeat(70 * 1024) }));
      assert.equal(big.status, 413);
      assert.equal(s.db.siteBinding(), null);
      assert.deepEqual((await s.call('GET', '/site')).json, { bound: false });
    } finally {
      await s.close();
    }
  });

  test('site-binding: while creation is off POST /site is 403 creation_disabled and stores nothing', async () => {
    for (const off of [DISABLED_POLICY, Object.freeze({ ...SELF, enabled: false })]) {
      const s = await startStub({ creationPolicy: off });
      try {
        const res = await enrol(s, SITE);
        assert.equal(res.status, 403, res.text);
        assert.deepEqual(res.json, { error: 'forbidden', reason: 'creation_disabled' });
        assert.equal(s.db.siteBinding(), null);
        assert.deepEqual((await s.call('GET', '/site')).json, { bound: false });
      } finally {
        await s.close();
      }
    }
  });

  test('site-binding: with no sending key POST /site is 503 not_configured and stores nothing', async () => {
    const s = await startStub({ creationPolicy: SELF, env: { SPONSOR_RELAYER_PRIVATE_KEY: undefined } });
    try {
      assert.equal(s.config.configured, false);
      const res = await enrol(s, SITE);
      assert.equal(res.status, 503, res.text);
      assert.deepEqual(res.json, { error: 'unavailable', reason: 'not_configured' });
      assert.equal(s.db.siteBinding(), null);
    } finally {
      await s.close();
    }
  });

  test('site-binding: an operator site is the binding: the same site is 200 created false with no row written, another is 409, GET answers it', async () => {
    const s = await startStub({ creationPolicy: OPERATOR });
    try {
      assert.deepEqual((await s.call('GET', '/site')).json, { bound: true, siteUuid: SITE });
      const same = await enrol(s, SITE);
      assert.equal(same.status, 200, same.text);
      assert.deepEqual(same.json, { siteUuid: SITE, bound: true, created: false });
      const other = await enrol(s, OTHER);
      assert.equal(other.status, 409, other.text);
      assert.deepEqual(other.json, CONFLICT);
      assert.equal(s.db.siteBinding(), null, 'the operator file is the binding: no row is written');
      assert.deepEqual((await s.call('GET', '/site')).json, { bound: true, siteUuid: SITE });
    } finally {
      await s.close();
    }
  });

  test('site-binding: a database bound to one site, opened with an operator policy naming another, answers the operator site and says so once without a UUID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'site-binding-'));
    const dbPath = join(dir, 'relayer.db');
    try {
      const first = await startStub({ creationPolicy: SELF, dbPath });
      try {
        assert.equal((await enrol(first, OTHER)).status, 201);
        assert.equal(first.logs.some((l) => l.includes('stored binding')), false, 'no such line while the file names no site');
      } finally {
        await first.close();
      }
      const second = await startStub({ creationPolicy: OPERATOR, dbPath });
      try {
        assert.equal(second.db.siteBinding(), OTHER, 'the stored binding is still there, only ignored');
        assert.deepEqual((await second.call('GET', '/site')).json, { bound: true, siteUuid: SITE });
        assert.equal((await enrol(second, OTHER)).status, 409);
        assert.equal((await enrol(second, SITE)).status, 200);
        const lines = second.logs.filter((l) => l.includes('a stored binding to another site is ignored'));
        assert.equal(lines.length, 1, second.logs.join('\n'));
        assert.equal(lines[0], 'gas-sponsor-relayer: the policy file names the site; a stored binding to another site is ignored');
        assert.equal(second.logs.join('\n').includes(SITE), false);
        assert.equal(second.logs.join('\n').includes(OTHER), false);
      } finally {
        await second.close();
      }
      // The same site in both places is no mismatch: no line.
      const third = await startStub({ creationPolicy: policy(OTHER), dbPath });
      try {
        assert.equal(third.logs.some((l) => l.includes('stored binding')), false);
      } finally {
        await third.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('site-binding: a policy file that cannot be read or is invalid binds the relayer to no site, even over a stored binding the operator had overridden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'site-binding-'));
    const dbPath = join(dir, 'relayer.db');
    const quiet = { warn() {} };
    try {
      // Site A (OTHER) bound itself first; the operator then named site B (SITE) in the policy file.
      const first = await startStub({ creationPolicy: SELF, dbPath });
      try {
        assert.equal((await enrol(first, OTHER)).status, 201);
        seedSlot(first.db, OTHER, '11111111-1111-4111-8111-111111111111');
      } finally {
        await first.close();
      }
      const second = await startStub({ creationPolicy: OPERATOR, dbPath });
      try {
        assert.deepEqual((await second.call('GET', '/site')).json, { bound: true, siteUuid: SITE });
      } finally {
        await second.close();
      }
      // A later edit breaks the file, or the path points at nothing: the relayer is bound to no site, never back to A.
      const broken = join(dir, 'broken.json');
      writeFileSync(broken, '{not json');
      const invalid = join(dir, 'invalid.json');
      writeFileSync(invalid, JSON.stringify({ ...OPERATOR, siteUuid: SITE.toUpperCase() }));
      for (const path of [broken, invalid, join(dir, 'missing.json')]) {
        const unreadable = loadCreationPolicy({ env: { SPONSOR_RELAYER_FUND_CREATION_CONFIG: path }, logger: quiet });
        assert.equal(unreadable.enabled, false);
        const s = await startStub({ creationPolicy: unreadable, dbPath });
        try {
          assert.equal(s.db.siteBinding(), OTHER, 'the stored binding is still there, only not used');
          assert.deepEqual((await s.call('GET', '/site')).json, { bound: false }, path);
          const slot = await s.call('GET', `/creations/${GROUP}`);
          assert.equal(slot.status, 404, slot.text);
          assert.deepEqual((await s.call('GET', '/status')).json.createdFunds, []);
        } finally {
          await s.close();
        }
      }
      // A valid file that turns creation off on purpose keeps the stored binding (DISABLED_POLICY's shape, read from a file).
      const off = await startStub({ creationPolicy: Object.freeze({ ...SELF, enabled: false }), dbPath });
      try {
        assert.deepEqual((await off.call('GET', '/site')).json, { bound: true, siteUuid: OTHER });
      } finally {
        await off.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('site-binding: GET /creations/:groupUuid reads the slot of the bound site, and an unbound relayer answers 404 creation_not_found', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      const path = `/creations/${GROUP}`;
      seedSlot(s.db, SITE, '11111111-1111-4111-8111-111111111111');
      seedSlot(s.db, OTHER, '22222222-2222-4222-8222-222222222222');
      const unbound = await s.call('GET', path);
      assert.equal(unbound.status, 404, unbound.text);
      assert.deepEqual(unbound.json, { error: 'not_found', reason: 'creation_not_found' });
      assert.equal((await enrol(s, SITE)).status, 201);
      const mine = await s.call('GET', path);
      assert.equal(mine.status, 200, mine.text);
      assert.equal(mine.json.intentUuid, '11111111-1111-4111-8111-111111111111');
      assert.equal(mine.json.groupUuid, GROUP);
    } finally {
      await s.close();
    }
  });

  test('site-binding: GET /creations/:groupUuid reads the other site\'s slot when the operator names it (the policy file wins)', async () => {
    const s = await startStub({ creationPolicy: policy(OTHER) });
    try {
      seedSlot(s.db, SITE, '11111111-1111-4111-8111-111111111111');
      seedSlot(s.db, OTHER, '22222222-2222-4222-8222-222222222222');
      const res = await s.call('GET', `/creations/${GROUP}`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.intentUuid, '22222222-2222-4222-8222-222222222222');
    } finally {
      await s.close();
    }
  });

  test('site-binding: both routes are 401 without the bearer and nothing is stored', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      const post = await s.call('POST', '/site', { siteUuid: SITE }, null);
      assert.equal(post.status, 401, post.text);
      assert.deepEqual(post.json, { error: 'unauthorized' });
      const wrong = await s.call('POST', '/site', { siteUuid: SITE }, 'not-the-token');
      assert.equal(wrong.status, 401);
      assert.equal((await s.call('GET', '/site', undefined, null)).status, 401);
      assert.equal(s.db.siteBinding(), null);
      assert.deepEqual((await s.call('GET', '/site')).json, { bound: false });
    } finally {
      await s.close();
    }
  });

  test('site-binding: no statement and no route rebinds or unbinds (the source guard is shown to fire on a planted copy)', async () => {
    const source = readFileSync(new URL('../../src/db.js', import.meta.url), 'utf8');
    assert.deepEqual(rebindingStatements(source), [], 'db.js has no statement that changes or removes site_binding');
    assert.ok(/INSERT OR IGNORE INTO site_binding/.test(source), 'the one writing statement is the ignoring insert');
    // The guard fires: each planted line is found, in a copy only.
    for (const planted of [
      'db.prepare("UPDATE site_binding SET site_uuid = ?").run(x);',
      'db.exec("DELETE FROM site_binding");',
      'db.exec("INSERT OR REPLACE INTO site_binding (id, site_uuid, bound_at) VALUES (1, ?, ?)");',
      'db.exec("REPLACE INTO site_binding VALUES (1, 2, 3)");',
      'db.exec("drop table site_binding");',
    ]) {
      const copy = `${source}\n${planted}\n`;
      assert.deepEqual(rebindingStatements(copy), [planted], planted);
    }
    // Exactly two routes sit under /site, and they only read or claim.
    assert.deepEqual(ROUTES.filter((r) => /^\S+ \/site(\/|$)/.test(r)).sort(), ['GET /site', 'POST /site']);
    const s = await startStub({ creationPolicy: SELF });
    try {
      assert.equal((await enrol(s, SITE)).status, 201);
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const res = await s.call(method, '/site', { siteUuid: OTHER });
        assert.equal(res.status, 404, method);
      }
      assert.equal((await s.call('POST', '/site/reset', {})).status, 404);
      assert.equal((await s.call('POST', '/site/', { siteUuid: OTHER })).status, 404);
      assert.deepEqual((await s.call('GET', '/site')).json, { bound: true, siteUuid: SITE });
    } finally {
      await s.close();
    }
  });
});
