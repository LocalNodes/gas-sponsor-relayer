// The shared site-enrolment contract (test/fixtures/site-enrolment-contract.json, a byte copy of gas_sponsor's
// tests/fixtures/site-enrolment-contract.json), replayed against the real server: every answer the contract lists for
// POST /site, GET /site and GET /creations/:groupUuid is what the relayer answers in that situation (D-10, D-18).
// The copy is never edited here: a change is made in gas_sponsor first, copied byte for byte, and both pins change.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig, loadNetworks } from '../../src/config.js';
import { parseCreationPolicy } from '../../src/creations.js';
import { createServer } from '../../src/server.js';
import { privateKeyOf, RELAYER_ACCOUNT, startStub, TOKEN } from '../helpers/stub.js';

const FILE = new URL('../fixtures/site-enrolment-contract.json', import.meta.url);
// The same value is pinned in gas_sponsor's SelfHostedRelayerSiteEnrolmentTest (CONTRACT_SHA256).
const CONTRACT_SHA256 = '95d5cf790dee675d777c3f4c00216860322a24a43ac8db013dcd47917b961d87';
const fx = JSON.parse(readFileSync(FILE, 'utf8'));
const networks = loadNetworks();
const SITE = fx.request.siteUuid;
const OTHER = fx.otherSiteUuid;
const GROUP = '3f6c2a10-8d1b-4e57-9a2c-5b7e1d0c4f68';
const LIMITS = { perActorPerDay: 1, perSitePerDay: 3 };
const SELF = parseCreationPolicy({ enabled: true, siteUuid: '', groups: [GROUP], limits: LIMITS }).policy;
const OFF = parseCreationPolicy({ enabled: false, siteUuid: '', groups: [], limits: LIMITS }).policy;

const E = fx.enrolResponses;
const READ = fx.readResponses;
const CS = fx.creationStatusResponses;
const enrol = (s, siteUuid = SITE, token) => s.call('POST', '/site', { siteUuid }, token);
/** The server's answer is exactly the contract's: status and body. */
function same(res, expected, label) {
  assert.equal(res.status, expected.status, `${label}: ${res.text}`);
  assert.deepEqual(res.json, expected.body, label);
}
/** Two networks marked for fund creation, as a relayer with a second test network configured. */
function twoNetworks() {
  const n = structuredClone(networks);
  n['84532'] = { ...n['84532'], sponsoring: true, fundCreation: true, testnet: true };
  return n;
}

describe('site enrolment contract (unit)', () => {
  test('site-enrolment-contract: the relayer copy has the sha256 gas_sponsor pins', () => {
    assert.equal(createHash('sha256').update(readFileSync(FILE)).digest('hex'), CONTRACT_SHA256, 'change the contract in gas_sponsor first, copy it byte for byte, and re-pin both');
    assert.equal(fx.request.siteUuid, '5b0e7c1e-2f43-4a8e-9d55-0c6f6a0e9b11');
    assert.deepEqual(Object.keys(E).sort(), ['created', 'creationOff', 'invalidBody', 'notConfigured', 'oldService', 'otherSite', 'same', 'unauthorized', 'web3Off']);
    assert.deepEqual(Object.keys(READ).sort(), ['bound', 'unbound']);
    assert.deepEqual(Object.keys(CS).sort(), ['chainIdRequired', 'invalidChainId', 'none']);
  });

  test('site-enrolment-contract: enrolResponses.created is the first POST /site on a self-binding relayer', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await enrol(s), E.created, 'created');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: enrolResponses.same is the second POST /site of the same site', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await enrol(s), E.created, 'created');
      same(await enrol(s), E.same, 'same');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: enrolResponses.otherSite is a POST /site of another site after the first bound', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await enrol(s), E.created, 'created');
      same(await enrol(s, OTHER), E.otherSite, 'otherSite');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: enrolResponses.invalidBody is an upper-case UUID', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await enrol(s, SITE.toUpperCase()), E.invalidBody, 'invalidBody');
      assert.equal(s.db.siteBinding(), null);
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: enrolResponses.creationOff is a POST /site while the policy is off', async () => {
    const s = await startStub({ creationPolicy: OFF });
    try {
      same(await enrol(s), E.creationOff, 'creationOff');
      assert.equal(s.db.siteBinding(), null);
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: enrolResponses.notConfigured is a POST /site with no sending key', async () => {
    const s = await startStub({ creationPolicy: SELF, env: { SPONSOR_RELAYER_PRIVATE_KEY: undefined } });
    try {
      same(await enrol(s), E.notConfigured, 'notConfigured');
      assert.equal(s.db.siteBinding(), null);
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: enrolResponses.web3Off is a POST /site to a relayer with web3 off', async () => {
    const config = loadConfig({ SPONSOR_RELAYER_PRIVATE_KEY: privateKeyOf(RELAYER_ACCOUNT), SPONSOR_RELAYER_TOKEN: TOKEN }, networks);
    assert.equal(config.web3Enabled, false);
    const logger = { info() {}, warn() {}, error() {} };
    const server = createServer({ config, networks, db: null, chains: null, cap: null, queue: null, logger });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/site`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ siteUuid: SITE }),
      });
      same({ status: res.status, json: await res.json(), text: '' }, E.web3Off, 'web3Off');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('site-enrolment-contract: enrolResponses.unauthorized is a POST /site with the wrong bearer', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await enrol(s, SITE, 'wrong-token'), E.unauthorized, 'unauthorized');
      same(await enrol(s, SITE, null), E.unauthorized, 'no bearer');
      assert.equal(s.db.siteBinding(), null);
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: enrolResponses.oldService is the 404 an unknown route gives (what a relayer without /site answers)', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await s.call('POST', '/site-not-here', { siteUuid: SITE }), E.oldService, 'oldService');
      same(await s.call('GET', '/nothing-here'), E.oldService, 'oldService GET');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: readResponses.unbound is GET /site before any binding', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await s.call('GET', '/site'), READ.unbound, 'unbound');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: readResponses.bound is GET /site after the site bound', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await enrol(s), E.created, 'created');
      same(await s.call('GET', '/site'), READ.bound, 'bound');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: readResponses.bound is also what a site named in the policy file reads', async () => {
    const s = await startStub({ creationPolicy: parseCreationPolicy({ enabled: true, siteUuid: SITE, groups: [GROUP], limits: LIMITS }).policy });
    try {
      same(await s.call('GET', '/site'), READ.bound, 'bound by the operator');
      same(await enrol(s), E.same, 'same');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: creationStatusResponses.chainIdRequired is GET /creations with two networks marked and no chainId', async () => {
    const s = await startStub({ creationPolicy: SELF, networks: twoNetworks() });
    try {
      same(await enrol(s), E.created, 'created');
      same(await s.call('GET', `/creations/${GROUP}`), CS.chainIdRequired, 'chainIdRequired');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: creationStatusResponses.invalidChainId is GET /creations?chainId=abc', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await enrol(s), E.created, 'created');
      same(await s.call('GET', `/creations/${GROUP}?chainId=abc`), CS.invalidChainId, 'invalidChainId');
    } finally {
      await s.close();
    }
  });

  test('site-enrolment-contract: creationStatusResponses.none is GET /creations for a bound site with no slot', async () => {
    const s = await startStub({ creationPolicy: SELF });
    try {
      same(await enrol(s), E.created, 'created');
      same(await s.call('GET', `/creations/${GROUP}`), CS.none, 'none');
      same(await s.call('GET', `/creations/${GROUP}?chainId=11155111`), CS.none, 'none with chainId');
    } finally {
      await s.close();
    }
  });
});
