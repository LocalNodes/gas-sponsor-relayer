import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { requireToken } from '../../src/auth.js';
import { loadNetworks } from '../../src/config.js';
import { execBody, privateKeyOf, RELAYER_ACCOUNT, SAFE, startStub, TOKEN } from '../helpers/stub.js';

const networks = loadNetworks();
const ROUTES = [
  ['GET', '/status'],
  ['GET', '/events?since=0'],
  ['POST', '/groups'],
  ['POST', '/send/safe-exec'],
  ['POST', '/send/ens'],
  ['POST', '/send/reality/add'],
  ['POST', '/send/reality/answer'],
  ['POST', '/send/reality/execute'],
  ['GET', `/jobs/${'0'.repeat(32)}`],
  ['GET', `/sends/0x${'0'.repeat(64)}`],
  ['GET', '/ops/recheck'],
  ['POST', '/ops/recheck'],
  ['GET', '/nothing-here'],
];

describe('auth', () => {
  let r;
  before(async () => {
    r = await startStub();
  });
  after(async () => {
    await r.close();
  });

  test('auth: no Authorization header answers 401 on every route but /healthz', async () => {
    for (const [m, p] of ROUTES) {
      const res = await r.call(m, p, m === 'POST' ? {} : undefined, null);
      assert.equal(res.status, 401, `${m} ${p}`);
    }
    assert.equal(r.chains.calls.send, 0);
  });

  test('auth: a wrong token, a token one character short and a longer token answer 401', async () => {
    for (const bad of ['wrong-token', TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), '']) {
      for (const [m, p] of ROUTES) {
        const res = await r.call(m, p, m === 'POST' ? {} : undefined, bad || null);
        assert.equal(res.status, 401, `${m} ${p} with "${bad}"`);
      }
    }
    const basic = await r.call('GET', '/status', undefined, null, { authorization: `Basic ${TOKEN}` });
    assert.equal(basic.status, 401);
    const noScheme = await r.call('GET', '/status', undefined, null, { authorization: TOKEN });
    assert.equal(noScheme.status, 401);
  });

  test('auth: the correct token passes and /healthz needs no token', async () => {
    assert.equal((await r.call('GET', '/status')).status, 200);
    assert.equal((await r.call('GET', '/healthz', undefined, null)).status, 200);
    assert.equal((await r.call('GET', '/healthz', undefined, 'wrong-token')).status, 200);
  });

  test('auth: requireToken compares in constant time with timingSafeEqual and refuses when no token is configured', () => {
    const req = (h) => ({ headers: { authorization: h } });
    assert.equal(requireToken(req(`Bearer ${TOKEN}`), TOKEN), true);
    assert.equal(requireToken(req(`Bearer ${TOKEN}`), ''), false);
    assert.equal(requireToken(req(`Bearer ${TOKEN}`), undefined), false);
    assert.equal(requireToken({ headers: {} }, TOKEN), false);
    assert.equal(requireToken(req('Bearer '), TOKEN), false);
  });

  test('auth: the sending key appears in no response body and no log line, on any route or error path', async () => {
    const key = privateKeyOf(RELAYER_ACCOUNT);
    const bare = key.slice(2);
    const boom = new Error(`boom ${key} http://rpc.invalid/${bare}`);
    const s = await startStub({ chainsOpts: { sendError: boom }, groups: [{ chainId: 11155111, safe: SAFE, space: 'a.eth' }] });
    try {
      const seen = [];
      const grab = (res) => seen.push(res.text);
      grab(await s.call('GET', '/healthz', undefined, null));
      grab(await s.call('GET', '/status'));
      grab(await s.call('GET', '/status', undefined, 'nope'));
      grab(await s.call('POST', '/groups', 'not json{'));
      grab(await s.call('POST', '/groups', { chainId: 11155111, safe: SAFE, space: 'a.eth', signature: `0x${'11'.repeat(65)}` }));
      grab(await s.call('POST', '/send/safe-exec', execBody(networks, { gasPrice: '1' })));
      grab(await s.call('POST', '/send/safe-exec', execBody(networks))); // reaches the failing send
      assert.ok(s.chains.calls.send >= 1, 'the failing send path was exercised');
      const all = [...seen, ...s.logs, JSON.stringify(s.config), String(s.config.address)].join('\n').toLowerCase();
      assert.ok(!all.includes(bare.toLowerCase()), 'key hex found in output');
      assert.ok(!all.includes('boom'), 'raw error message leaked');
      assert.ok(s.logs.length > 0, 'logs were captured');
    } finally {
      await s.close();
    }
  });
});

describe('empty config', () => {
  test('empty config: with no key every send answers 503 and /status says configured false', async () => {
    const s = await startStub({ env: { SPONSOR_RELAYER_PRIVATE_KEY: undefined } });
    try {
      assert.equal(s.config.configured, false);
      const status = await s.call('GET', '/status');
      assert.equal(status.status, 200);
      assert.equal(status.json.configured, false);
      assert.equal(status.json.address, null);
      assert.deepEqual(status.json.chains, {});
      assert.equal((await s.call('POST', '/send/safe-exec', execBody(networks))).status, 503);
      assert.equal((await s.call('POST', '/groups', { chainId: 11155111, safe: SAFE, space: 'a.eth', signature: `0x${'11'.repeat(65)}` })).status, 503);
      assert.equal(s.chains.calls.send, 0);
    } finally {
      await s.close();
    }
  });

  test('empty config: an invalid key counts as no key', async () => {
    for (const bad of ['0x1234', 'not-a-key', `0x${'zz'.repeat(32)}`]) {
      const s = await startStub({ env: { SPONSOR_RELAYER_PRIVATE_KEY: bad } });
      try {
        assert.equal(s.config.configured, false, bad);
        assert.equal((await s.call('POST', '/send/safe-exec', execBody(networks))).status, 503);
      } finally {
        await s.close();
      }
    }
  });

  test('empty config: no token configured refuses every authenticated route with 401', async () => {
    const s = await startStub({ env: { SPONSOR_RELAYER_TOKEN: '' } });
    try {
      assert.equal((await s.call('GET', '/status', undefined, 'anything')).status, 401);
      assert.equal((await s.call('GET', '/status', undefined, '')).status, 401);
      assert.equal((await s.call('GET', '/healthz', undefined, null)).status, 200);
    } finally {
      await s.close();
    }
  });

  test('empty config: a chain with an empty networks entry refuses every send with 403', async () => {
    const empty = { ...networks, 84532: {} };
    const s = await startStub({ networks: empty, groups: [{ chainId: 84532, safe: SAFE, space: 'a.eth' }] });
    try {
      const res = await s.call('POST', '/send/safe-exec', execBody(empty, { chainId: 84532 }));
      assert.equal(res.status, 403);
      assert.equal(res.json.reason, 'unknown_chain');
      assert.equal(s.chains.calls.send, 0);
      assert.equal(s.chains.calls.call, 0);
    } finally {
      await s.close();
    }
  });

  test('empty config: an empty allowlist (no networks at all) refuses every send with 403', async () => {
    const s = await startStub({ networks: {}, groups: [{ chainId: 11155111, safe: SAFE, space: 'a.eth' }] });
    try {
      assert.equal((await s.call('POST', '/send/safe-exec', execBody({}))).status, 403);
      assert.equal(s.chains.calls.send, 0);
    } finally {
      await s.close();
    }
  });
});

describe('status', () => {
  test('status: answers the documented shape with decimal-string wei balances and the cap readout', async () => {
    const huge = 123456789012345678901234567890n;
    const s = await startStub({
      chainsOpts: { balance: huge, latest: 3, pending: 5 },
      groups: [{ chainId: 11155111, safe: SAFE, space: 'a.eth' }],
    });
    try {
      const res = await s.call('GET', '/status');
      assert.equal(res.status, 200);
      assert.equal(res.json.configured, true);
      assert.equal(res.json.address, RELAYER_ACCOUNT.address);
      assert.deepEqual(Object.keys(res.json.cap).sort(), ['dayResetsAt', 'dayWei', 'monthResetsAt', 'monthStartsAt', 'monthWei', 'spentDayWei', 'spentMonthWei']);
      assert.equal(res.json.cap.dayWei, '50000000000000000');
      assert.equal(res.json.cap.spentDayWei, '0');
      assert.deepEqual(Object.keys(res.json.chains).sort(), ['11155111', '84532']);
      assert.deepEqual(res.json.chains['11155111'], { balanceWei: '123456789012345678901234567890', pending: 2 });
      assert.match(res.json.chains['84532'].balanceWei, /^[0-9]+$/);
      assert.deepEqual(res.json.groups, [{ chainId: 11155111, safe: SAFE, space: 'a.eth', community: 'Gov Vectors', module: null }]);
      assert.equal(typeof res.json.chains['11155111'].balanceWei, 'string');
    } finally {
      await s.close();
    }
  });

  test('status: a chain whose RPC is down reads unreachable, never a zero balance', async () => {
    const s = await startStub({ chainsOpts: { unreachable: [84532] } });
    try {
      const res = await s.call('GET', '/status');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.chains['84532'], { error: 'unreachable' });
      assert.equal(res.json.chains['11155111'].balanceWei, '5000000000000000000');
      assert.ok(!res.text.includes('secret-key-in-url'), 'RPC URL leaked');
      assert.ok(!res.text.includes('"balanceWei":"0"'));
    } finally {
      await s.close();
    }
    const allDown = await startStub({ chainsOpts: { unreachable: true } });
    try {
      const res = await allDown.call('GET', '/status');
      for (const c of Object.values(res.json.chains)) assert.deepEqual(c, { error: 'unreachable' });
    } finally {
      await allDown.close();
    }
  });

  test('status: needs the bearer token', async () => {
    const s = await startStub();
    try {
      assert.equal((await s.call('GET', '/status', undefined, null)).status, 401);
    } finally {
      await s.close();
    }
  });
});
