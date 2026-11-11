// Per-Group module discovery: the relayer learns a Group's Reality module from the chain only (25-06, TM-77).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { build, SELECTORS } from '../../src/allowlist.js';
import { createCap } from '../../src/cap.js';
import { loadNetworks } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { createGroupModules, discoverModules, proxyRuntimeCode, SENTINEL_MODULES } from '../../src/groups.js';
import { createQueue } from '../../src/queue.js';
import { COMMUNITY, SAFE, SIG65, rawWallet, startStub } from '../helpers/stub.js';
import { blockHash, finalBlocks, listed } from '../helpers/node.js';

process.env.WEB3_ENABLED = 'true';

const networks = loadNetworks();
const CHAIN = 11155111;
const MASTERCOPY = networks[String(CHAIN)].realityMastercopy;
const OTHER_MASTERCOPY = '0x1111111111111111111111111111111111111111';
const OTHER_SAFE = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const mod = (n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

// ERC-1167 runtime code written out byte by byte, independent of the function under test.
const runtimeFor = (mastercopy) => `0x363d3d373d3d3d363d73${mastercopy.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

/**
 * A chain stub for one Safe. `enabled` is the Safe's module list in order; `code`, `avatar` and `target`
 * map a module address to what it answers. Counts every read so the cache can be checked.
 */
function fakeChain({ safe = SAFE, enabled = [], code = {}, avatar = {}, target = {}, fail = false } = {}) {
  const reads = { total: 0 };
  const publicClient = {
    async readContract({ address, functionName, args }) {
      reads.total += 1;
      if (fail) throw new Error('HTTP request failed. URL: http://rpc.invalid/secret-key-in-url');
      if (functionName === 'getModulesPaginated') {
        assert.equal(getAddress(address), safe);
        const [start, size] = args;
        const from = start === SENTINEL_MODULES ? 0 : enabled.indexOf(start) + 1;
        const page = enabled.slice(from, from + Number(size));
        const more = from + Number(size) < enabled.length;
        return [page, more ? page[page.length - 1] : SENTINEL_MODULES];
      }
      if (functionName === 'avatar') return avatar[address] ?? safe;
      if (functionName === 'target') return target[address] ?? safe;
      throw new Error(`unexpected read ${functionName}`);
    },
    async getCode({ address }) {
      reads.total += 1;
      if (fail) throw new Error('rpc down');
      return code[address];
    },
  };
  return { reads, chains: { get: (id) => (Number(id) === CHAIN ? { publicClient } : null) }, publicClient };
}

describe('groups', () => {
  test('groups: the ERC-1167 runtime code of the configured mastercopy is built the documented way', () => {
    assert.equal(proxyRuntimeCode(MASTERCOPY), runtimeFor(MASTERCOPY));
    assert.equal(proxyRuntimeCode(MASTERCOPY.toLowerCase()), runtimeFor(MASTERCOPY));
    assert.notEqual(proxyRuntimeCode(OTHER_MASTERCOPY), proxyRuntimeCode(MASTERCOPY));
  });

  test('groups: a module of the configured mastercopy with avatar and target = the Safe is returned', async () => {
    const m = mod(0xa1);
    const { publicClient } = fakeChain({ enabled: [m], code: { [m]: runtimeFor(MASTERCOPY) } });
    assert.deepEqual(await discoverModules(publicClient, { safe: SAFE, mastercopy: MASTERCOPY }), [m]);
  });

  test('groups: a module with another mastercopy, another avatar or another target is ignored', async () => {
    const good = mod(0xa1);
    const wrongCode = mod(0xa2);
    const wrongAvatar = mod(0xa3);
    const wrongTarget = mod(0xa4);
    const noCode = mod(0xa5);
    const nearMiss = mod(0xa6);
    const { publicClient } = fakeChain({
      enabled: [wrongCode, wrongAvatar, good, wrongTarget, noCode, nearMiss],
      code: {
        [good]: runtimeFor(MASTERCOPY),
        [wrongCode]: runtimeFor(OTHER_MASTERCOPY),
        [wrongAvatar]: runtimeFor(MASTERCOPY),
        [wrongTarget]: runtimeFor(MASTERCOPY),
        // The right proxy with one byte of trailing code: not an exact match.
        [nearMiss]: `${runtimeFor(MASTERCOPY)}00`,
      },
      avatar: { [wrongAvatar]: OTHER_SAFE },
      target: { [wrongTarget]: OTHER_SAFE },
    });
    assert.deepEqual(await discoverModules(publicClient, { safe: SAFE, mastercopy: MASTERCOPY }), [good]);
  });

  test('groups: a module that is not enabled on the Safe is not returned, whatever its code says', async () => {
    const enabled = mod(0xb1);
    const stranger = mod(0xb2);
    const { publicClient } = fakeChain({ enabled: [enabled], code: { [enabled]: runtimeFor(MASTERCOPY), [stranger]: runtimeFor(MASTERCOPY) } });
    assert.deepEqual(await discoverModules(publicClient, { safe: SAFE, mastercopy: MASTERCOPY }), [enabled]);
  });

  test('groups: an empty module list gives [], and so does an RPC that fails', async () => {
    const empty = fakeChain({ enabled: [] });
    assert.deepEqual(await discoverModules(empty.publicClient, { safe: SAFE, mastercopy: MASTERCOPY }), []);
    const down = fakeChain({ fail: true });
    assert.deepEqual(await discoverModules(down.publicClient, { safe: SAFE, mastercopy: MASTERCOPY }), []);
  });

  test('groups: modules are read across pages', async () => {
    const list = [1, 2, 3, 4, 5].map((n) => mod(0xc0 + n));
    const code = Object.fromEntries(list.map((m) => [m, runtimeFor(MASTERCOPY)]));
    const { publicClient } = fakeChain({ enabled: list, code });
    assert.deepEqual(await discoverModules(publicClient, { safe: SAFE, mastercopy: MASTERCOPY, pageSize: 2 }), list);
  });

  test('groups: results are cached for one minute per Safe, and invalidate() forces a fresh read', async () => {
    const m = mod(0xd1);
    const chain = fakeChain({ enabled: [m], code: { [m]: runtimeFor(MASTERCOPY) } });
    let clock = 1_000_000;
    const groups = createGroupModules({ networks, chains: chain.chains, now: () => clock });
    assert.deepEqual(await groups.modulesFor(CHAIN, SAFE), [m]);
    const after1 = chain.reads.total;
    assert.ok(after1 > 0);
    clock += 59_999;
    assert.deepEqual(await groups.modulesFor(CHAIN, SAFE.toLowerCase()), [m], 'same Safe, other casing, same cache entry');
    assert.equal(chain.reads.total, after1, 'a read inside the minute');
    clock += 1;
    await groups.modulesFor(CHAIN, SAFE);
    assert.ok(chain.reads.total > after1, 'a read once the minute is over');
    const after2 = chain.reads.total;
    await groups.modulesFor(CHAIN, SAFE);
    assert.equal(chain.reads.total, after2);
    groups.invalidate(CHAIN, SAFE);
    await groups.modulesFor(CHAIN, SAFE);
    assert.ok(chain.reads.total > after2, 'a read after invalidate');
    // Another Safe has its own entry.
    const before = chain.reads.total;
    await groups.modulesFor(CHAIN, OTHER_SAFE);
    assert.ok(chain.reads.total > before);
  });

  test('groups: a failed read is not cached, and an unconfigured chain gives []', async () => {
    const chain = fakeChain({ fail: true });
    const groups = createGroupModules({ networks, chains: chain.chains });
    assert.deepEqual(await groups.modulesFor(CHAIN, SAFE), []);
    const afterFail = chain.reads.total;
    await groups.modulesFor(CHAIN, SAFE);
    assert.ok(chain.reads.total > afterFail, 'the failure was cached');
    assert.deepEqual(await groups.modulesFor(1, SAFE), []);
    assert.deepEqual(await groups.modulesFor(84532, SAFE), [], 'Base Sepolia has no client in this fake');
  });

  test('groups: the allowlist has addProposal and executeProposalWithIndex only for discovered modules, and the Reality rows once', async () => {
    const m = mod(0xe1);
    const stranger = mod(0xe2);
    const chain = fakeChain({ enabled: [m], code: { [m]: runtimeFor(MASTERCOPY), [stranger]: runtimeFor(MASTERCOPY) } });
    const groups = createGroupModules({ networks, chains: chain.chains });
    const registered = [{ chainId: CHAIN, safe: SAFE, space: 'a.eth' }, { chainId: CHAIN, safe: OTHER_SAFE, space: 'b.eth' }];
    const list = await groups.allowlist(registered);
    assert.equal(list.check(CHAIN, m, SELECTORS.addProposal).ok, true);
    assert.equal(list.check(CHAIN, m, SELECTORS.executeProposalWithIndex).ok, true);
    assert.equal(list.check(CHAIN, m, SELECTORS.submitAnswer).reason, 'selector_not_allowed');
    assert.equal(list.check(CHAIN, stranger, SELECTORS.addProposal).reason, 'target_not_allowed');
    // Reality's rows exist once per chain, however many Groups are registered.
    const reality = networks[String(CHAIN)].reality.toLowerCase();
    for (const name of ['submitAnswer', 'claimWinnings', 'withdraw']) {
      assert.equal(list.tuples.filter((t) => t === `${CHAIN}:${reality}:${SELECTORS[name]}`).length, 1, name);
      assert.equal(list.check(CHAIN, reality, SELECTORS[name]).ok, true, name);
    }
    // Module tuples are the discovered module's two selectors and nothing else.
    assert.deepEqual(list.tuples.filter((t) => t.includes(m.toLowerCase())).sort(), [`${CHAIN}:${m.toLowerCase()}:${SELECTORS.addProposal}`, `${CHAIN}:${m.toLowerCase()}:${SELECTORS.executeProposalWithIndex}`].sort());
    // build() alone, without modules, keeps the old behaviour.
    assert.equal(build(networks, registered).check(CHAIN, m, SELECTORS.addProposal).ok, false);
  });

  test('groups: a module on a chain without a configured entry gets no tuple', () => {
    const m = mod(0xe3);
    const list = build({ ...networks, 999: { name: 'x', rpcUrls: ['http://x.invalid'] } }, [], [{ chainId: 999, module: m }, { chainId: 1, module: m }]);
    assert.equal(list.tuples.some((t) => t.includes(m.toLowerCase())), false);
  });

  test('groups: the queue drops a Safe\'s cache entry when a send from that Safe mines', async () => {
    const db = openDb(':memory:');
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => 1_700_000_000_000 });
    const receipts = {};
    const included = [];
    const publicClient = {
      async getTransactionCount() { return 1; },
      async getBlockNumber() { return 100n; },
      async getTransactionReceipt({ hash }) { if (!receipts[hash]) throw new Error('not found'); return receipts[hash]; },
      getBlock: finalBlocks(() => 101n, () => included),
    };
    const walletClient = rawWallet((tx, hash) => hash);
    const invalidated = [];
    const queue = createQueue({
      db,
      chains: { get: () => ({ publicClient, walletClient }) },
      cap,
      address: OTHER_SAFE,
      logger: { info() {}, warn() {}, error() {} },
      onMined: (row) => invalidated.push([row.chainId, row.safe]),
    });
    const tx = { to: OTHER_SAFE, data: '0x', value: 0n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n };
    const reservation = cap.reserve(CHAIN, tx.gas * tx.maxFeePerGas);
    const { hash } = await queue.enqueue(CHAIN, tx, { reservation, safe: SAFE, kind: 'safe-exec' });
    await queue.tick();
    assert.deepEqual(invalidated, [], 'nothing mined yet');
    receipts[hash] = listed(included, { status: 'success', gasUsed: 21000n, effectiveGasPrice: 10n ** 9n, transactionHash: hash, blockNumber: 101n, blockHash: blockHash(101n) });
    await queue.tick();
    assert.deepEqual(invalidated, [[CHAIN, SAFE]]);
    db.close();
  });

  test('groups: a module address in a request body adds nothing, and /status shows module null for it', async () => {
    const s = await startStub({});
    try {
      const reg = await s.call('POST', '/groups', { chainId: CHAIN, safe: SAFE, space: 'a.eth', signature: SIG65, module: mod(0xf1), modules: [mod(0xf2)] });
      assert.equal(reg.status, 201, reg.text);
      const status = await s.call('GET', '/status');
      assert.deepEqual(status.json.groups, [{ chainId: CHAIN, safe: SAFE, space: 'a.eth', community: COMMUNITY, module: null }]);
      assert.ok(!status.text.toLowerCase().includes(mod(0xf1).toLowerCase()));
    } finally {
      await s.close();
    }
  });

  test('groups: no request handler reads a module address from a request body', () => {
    for (const file of ['../../src/server.js', '../../src/sends/safeExec.js', '../../src/registration.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /\b(body|parsed\.value|value)\??\.modules?\b/, `${file} reads a module from the request`);
      assert.doesNotMatch(source, /\{[^}]*\bmodules?\b[^}]*\}\s*=\s*(body|parsed\.value)/, `${file} destructures a module from the request`);
    }
  });
});
