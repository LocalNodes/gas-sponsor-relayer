// Web3 off means keyless (orchestrator ruling 2026-11-07, TM-151): unless WEB3_ENABLED is exactly
// 'true' no key is loaded and every route but GET /healthz answers 503 web3_disabled.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadNetworks } from '../../src/config.js';
import { createServer, ROUTES } from '../../src/server.js';
import { privateKeyOf, RELAYER_ACCOUNT, startStub, TOKEN } from '../helpers/stub.js';

const SENTINEL = privateKeyOf(RELAYER_ACCOUNT);
const networks = loadNetworks();
const OFF_VALUES = [undefined, 'false', 'TRUE', 'True', '1', 'yes', '', ' true', 'true '];

/** An env that records which names were read. */
function spyEnv(values) {
  const read = new Set();
  return { read, env: new Proxy(values, { get: (t, k) => { read.add(k); return t[k]; }, has: (t, k) => { read.add(k); return k in t; } }) };
}

describe('web3-disabled', () => {
  test('web3-disabled: without WEB3_ENABLED=true config holds no key, no account and never reads the key variable', () => {
    for (const v of OFF_VALUES) {
      const values = { SPONSOR_RELAYER_PRIVATE_KEY: SENTINEL, SPONSOR_RELAYER_TOKEN: TOKEN };
      if (v !== undefined) values.WEB3_ENABLED = v;
      const { env, read } = spyEnv(values);
      const c = loadConfig(env, networks);
      const label = JSON.stringify(v);
      assert.equal(c.web3Enabled, false, label);
      assert.equal(c.configured, false, label);
      assert.equal(c.account, null, label);
      assert.equal(c.address, null, label);
      assert.equal(c.keyPresentButInvalid, false, label);
      assert.ok(!read.has('SPONSOR_RELAYER_PRIVATE_KEY'), `${label}: the key variable was read`);
      assert.ok(!JSON.stringify(c).includes(SENTINEL.slice(2)), label);
      assert.ok(!Object.getOwnPropertyNames(c).some((k) => String(c[k]).includes(SENTINEL.slice(2))), label);
    }
  });

  test('web3-disabled: with WEB3_ENABLED=true the key is loaded (control case)', () => {
    const c = loadConfig({ WEB3_ENABLED: 'true', SPONSOR_RELAYER_PRIVATE_KEY: SENTINEL }, networks);
    assert.equal(c.web3Enabled, true);
    assert.equal(c.configured, true);
    assert.equal(c.address, RELAYER_ACCOUNT.address);
    assert.ok(c.account);
  });

  test('web3-disabled: a bad cap value does not stop an instance that has web3 off', () => {
    const c = loadConfig({ SPONSOR_RELAYER_CAP_DAY_WEI: 'junk' }, networks);
    assert.equal(c.web3Enabled, false);
  });

  test('web3-disabled: every route but GET /healthz answers 503 web3_disabled, with a valid token, and nothing is touched', async () => {
    const config = loadConfig({ SPONSOR_RELAYER_PRIVATE_KEY: SENTINEL, SPONSOR_RELAYER_TOKEN: TOKEN }, networks);
    const logs = [];
    const logger = { info: (l) => logs.push(String(l)), warn: (l) => logs.push(String(l)), error: (l) => logs.push(String(l)) };
    // No db, no chains, no cap, no queue: a handler that reached for any of them would throw.
    const server = createServer({ config, networks, db: null, chains: null, cap: null, queue: null, logger });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const hit = async (method, path, token = TOKEN) => {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(url + path, { method, headers, body: method === 'POST' ? '{}' : undefined });
      return { status: res.status, statusText: res.statusText, text: await res.text() };
    };
    try {
      assert.ok(ROUTES.length >= 4);
      const health = await hit('GET', '/healthz', null);
      assert.equal(health.status, 200);
      assert.equal(health.text, 'ok');
      for (const entry of ROUTES) {
        const [method, path] = entry.split(' ');
        if (entry === 'GET /healthz') continue;
        for (const token of [TOKEN, null, 'wrong']) {
          const res = await hit(method, path, token);
          assert.equal(res.status, 503, `${entry} token=${token}`);
          assert.deepEqual(JSON.parse(res.text), { error: 'web3_disabled' }, entry);
          assert.equal(res.statusText, 'web3_disabled', entry);
          assert.ok(!res.text.includes(SENTINEL.slice(2)));
        }
      }
      for (const [method, path] of [['GET', '/nowhere'], ['POST', '/send/ens'], ['POST', '/send/reality/add'], ['GET', '/events'], ['POST', '/healthz']]) {
        const res = await hit(method, path);
        assert.equal(res.status, 503, `${method} ${path}`);
        assert.deepEqual(JSON.parse(res.text), { error: 'web3_disabled' });
      }
      assert.ok(!logs.join('\n').includes(SENTINEL.slice(2)), 'no log line holds the key');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('web3-disabled: with web3 on, /healthz answers ok as plain text and the routes work', async () => {
    const s = await startStub();
    try {
      const h = await s.call('GET', '/healthz', undefined, null);
      assert.equal(h.status, 200);
      assert.equal(h.text, 'ok');
      assert.equal((await s.call('GET', '/status')).status, 200);
    } finally {
      await s.close();
    }
  });

  test('web3-disabled: the route table matches what the server dispatches', async () => {
    assert.deepEqual(
      [...ROUTES].sort(),
      ['GET /events', 'GET /healthz', 'GET /jobs/:id', 'GET /ops/recheck', 'GET /sends/:hash', 'GET /status', 'POST /groups', 'POST /ops/recheck', 'POST /send/ens', 'POST /send/reality/add', 'POST /send/reality/answer', 'POST /send/reality/execute', 'POST /send/safe-exec'],
    );
    const s = await startStub();
    try {
      for (const entry of ROUTES) {
        const [method, path] = entry.split(' ');
        // A parameter route is hit with a well-formed id; an unknown job is a 404 that says so.
        const res = await s.call(method, path.replace(':id', '0'.repeat(32)).replace(':hash', `0x${'0'.repeat(64)}`), method === 'POST' ? {} : undefined);
        if (entry === 'GET /jobs/:id') {
          assert.equal(res.json.reason, 'job_not_found');
          continue;
        }
        if (entry === 'GET /sends/:hash') {
          assert.equal(res.json.reason, 'send_not_found');
          continue;
        }
        assert.notEqual(res.status, 404, entry);
        assert.notEqual(res.status, 503, entry);
      }
    } finally {
      await s.close();
    }
  });
});
