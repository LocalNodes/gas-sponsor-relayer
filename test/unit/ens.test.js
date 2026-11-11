// Relayer-paid ENSv2 registration with the Safe as owner (25-06, D-08, TM-76, TM-78).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, getAddress, parseAbi, zeroAddress, zeroHash } from 'viem';
import { SELECTORS } from '../../src/allowlist.js';
import { createCap } from '../../src/cap.js';
import { loadNetworks } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { createQueue } from '../../src/queue.js';
import { createEns, ensCommitment, isValidLabel, parseEnsBody } from '../../src/sends/ens.js';
import { COMMUNITY, SAFE, rawWallet, startStub, RELAYER_ACCOUNT } from '../helpers/stub.js';

process.env.WEB3_ENABLED = 'true';

const networks = loadNetworks();
const CHAIN = 11155111;
const net = networks[String(CHAIN)];
const ME = RELAYER_ACCOUNT.address;
const quiet = { info() {}, warn() {}, error() {} };
const ensVector = JSON.parse(readFileSync(new URL('../fixtures/vectors/ens.json', import.meta.url), 'utf8'));

const registrarAbi = parseAbi([
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
]);
const tokenAbi = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 value) returns (bool)']);
const selectorOf = (tx) => tx.data.slice(0, 10);

/** A chain for the job runner: reads answer from `o`, every send mines at once in its own block. */
function ensChain(networkSet, o = {}) {
  const s = {
    available: true, base: 8_000_000n, premium: 0n, minAge: 60n, tokenBalance: 10n ** 12n, owner: SAFE,
    sent: [], receipts: {}, reverted: new Set(), block: 500n, time: 1_700_000_000n, ...o,
  };
  const blockTime = new Map();
  let counter = 0;
  const publicClient = {
    async readContract({ functionName }) {
      if (functionName === 'isAvailable') return s.available;
      if (functionName === 'getRegisterPrice') return [s.base, s.premium];
      if (functionName === 'MIN_COMMITMENT_AGE') return s.minAge;
      if (functionName === 'balanceOf') return s.tokenBalance;
      if (functionName === 'findExactOwner') return s.owner;
      throw new Error(`unexpected read ${functionName}`);
    },
    async estimateGas() { return 100000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n }; },
    async getTransactionCount() { return 1 + counter; },
    async getBlockNumber() { return s.block; },
    async getTransactionReceipt({ hash }) { const r = s.receipts[hash]; if (!r) throw new Error('not found'); return r; },
    async getBlock({ blockNumber }) { return { number: blockNumber, timestamp: blockTime.get(blockNumber) }; },
  };
  const walletClient = rawWallet((tx, hash) => {
    counter += 1;
    s.block += 1n;
    s.time += 12n;
    blockTime.set(s.block, s.time);
    s.sent.push(tx);
    s.receipts[hash] = {
      status: s.reverted.has(counter) ? 'reverted' : 'success', blockNumber: s.block, gasUsed: 50000n, effectiveGasPrice: 10n ** 9n, transactionHash: hash,
    };
    return hash;
  });
  return { state: s, chains: { get: (id) => (Number(id) === CHAIN && networkSet[String(CHAIN)] ? { publicClient, walletClient } : null) } };
}

function setup({ nets = networks, chain: chainOpts = {}, capWei } = {}) {
  const db = openDb(':memory:');
  db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth', community: COMMUNITY });
  const cap = createCap({ db, caps: { dayWei: capWei ?? 10n ** 18n, monthWei: capWei ?? 10n ** 19n }, now: () => 1_700_000_000_000 });
  const chain = ensChain(nets, chainOpts);
  const queue = createQueue({ db, chains: chain.chains, cap, address: ME, logger: quiet });
  const waits = [];
  const ens = createEns({
    db, config: { address: ME, configured: true }, networks: nets, chains: chain.chains, cap, queue, logger: quiet,
    wait: async (w) => { waits.push(w); }, pollMs: 1,
  });
  return { db, cap, chain, queue, ens, waits };
}
const body = (over = {}) => ({ chainId: CHAIN, safe: SAFE, label: 'gov-vectors', ...over });

describe('ens labels', () => {
  test('ens: labels "abc", a 40-character label and "a-b" pass; the rest of the ENSIP-15 rules fail', () => {
    for (const ok of ['abc', 'x'.repeat(40), 'a-b', 'a-b-c', 'gov-vectors', 'ab-cd', '1-2-3', 'abc--d']) assert.equal(isValidLabel(ok), true, ok);
    const bad = ['ab', 'x'.repeat(41), 'Abc', 'ab--c', 'ab--cd', 'a b', 'a_b', 'é-é-é', 'café', '日本語ab', '', 'a.b', 'abc.eth'];
    for (const l of bad) assert.equal(isValidLabel(l), false, JSON.stringify(l));
    for (const notString of [undefined, null, 12345, ['abc'], { toString: () => 'abc' }]) assert.equal(isValidLabel(notString), false);
  });

  test('ens: the commitment equals the one in the shared ens.json vector', () => {
    const i = ensVector.input;
    assert.equal(ensCommitment({ label: i.label, owner: i.owner, secret: i.secret, subregistry: i.subregistry, resolver: i.resolver, duration: BigInt(i.duration), referrer: i.referrer }), ensVector.commitment);
  });

  test('ens: the request body is checked field by field', () => {
    assert.equal(parseEnsBody(body()).ok, true);
    assert.equal(parseEnsBody(body()).value.safe, SAFE);
    for (const bad of [null, 'x', [], body({ chainId: '11155111' }), body({ chainId: 0 }), body({ safe: 'nope' }), body({ label: 5 }), body({ label: undefined })]) {
      assert.equal(parseEnsBody(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe('ens requests', () => {
  test('ens: Base Sepolia (no ENS) answers 403 "no ENS on this network" and nothing is sent', async () => {
    const s = await startStub({ groups: [{ chainId: 84532, safe: SAFE, space: 'gov-vectors.eth' }], chainsOpts: { readResult: true } });
    try {
      const res = await s.call('POST', '/send/ens', body({ chainId: 84532 }));
      assert.equal(res.status, 403, res.text);
      assert.equal(res.json.reason, 'no_ens_on_network');
      assert.equal(res.json.detail, 'no ENS on this network');
      assert.equal(s.chains.calls.send, 0);
      assert.equal(s.chains.calls.read, 0, 'refused before any chain read');
    } finally {
      await s.close();
    }
  });

  test('ens: bad labels, an unregistered owner and a label other than the registered space are refused before anything is sent', async () => {
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth' }], chainsOpts: { readResult: true } });
    try {
      for (const label of ['ab', 'x'.repeat(41), 'Abc', 'ab--c', 'a b', 'é-é-é', 'gov-vectors.eth']) {
        const res = await s.call('POST', '/send/ens', body({ label }));
        assert.equal(res.status, 400, label);
        assert.equal(res.json.reason, 'invalid_label');
      }
      const other = await s.call('POST', '/send/ens', body({ label: 'another-name' }));
      assert.equal(other.status, 403, other.text);
      assert.equal(other.json.reason, 'label_not_space');
      const stranger = await s.call('POST', '/send/ens', body({ safe: getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8') }));
      assert.equal(stranger.status, 403);
      assert.equal(stranger.json.reason, 'safe_not_registered');
      const unknownChain = await s.call('POST', '/send/ens', body({ chainId: 1 }));
      assert.equal(unknownChain.status, 403);
      assert.equal(s.chains.calls.send, 0);
      assert.equal(s.chains.calls.read, 0, 'no chain read for a refused request');
    } finally {
      await s.close();
    }
  });

  test('ens: a taken label answers 409 and sends nothing', async () => {
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth' }], chainsOpts: { readResult: false } });
    try {
      const res = await s.call('POST', '/send/ens', body());
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.reason, 'name_taken');
      assert.equal(s.chains.calls.send, 0);
    } finally {
      await s.close();
    }
  });

  test('ens: GET /jobs/:id answers 404 job_not_found for an id it does not know', async () => {
    const s = await startStub({});
    try {
      const res = await s.call('GET', `/jobs/${'0'.repeat(32)}`);
      assert.equal(res.status, 404);
      assert.equal(res.json.reason, 'job_not_found');
      assert.equal((await s.call('GET', '/jobs/not-an-id')).json.error, 'not_found');
    } finally {
      await s.close();
    }
  });
});

describe('ens job', () => {
  test('ens: on a testnet the job mints, approves, commits, waits MIN_COMMITMENT_AGE + 1 s and registers to the Safe', async () => {
    const { ens, chain, waits } = setup();
    const res = await ens.request(body());
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.match(res.body.jobId, /^[0-9a-f]{32}$/);
    await ens.idle();

    const sent = chain.state.sent;
    assert.deepEqual(sent.map(selectorOf), [SELECTORS.mint, SELECTORS.approve, SELECTORS.commit, SELECTORS.register]);
    assert.deepEqual(sent.map((t) => t.to.toLowerCase()), [net.ensPaymentToken, net.ensPaymentToken, net.ensRegistrar, net.ensRegistrar].map((a) => a.toLowerCase()));
    const mint = decodeFunctionData({ abi: tokenAbi, data: sent[0].data });
    assert.deepEqual(mint.args, [ME, 8_000_000n]);
    const approve = decodeFunctionData({ abi: tokenAbi, data: sent[1].data });
    assert.deepEqual(approve.args.map((a) => String(a).toLowerCase()), [net.ensRegistrar.toLowerCase(), '8000000']);
    const commit = decodeFunctionData({ abi: registrarAbi, data: sent[2].data });
    const reg = decodeFunctionData({ abi: registrarAbi, data: sent[3].data });
    assert.equal(reg.functionName, 'register');
    const [label, owner, secret, subregistry, resolver, duration, token, referrer] = reg.args;
    assert.equal(label, 'gov-vectors');
    assert.equal(owner, SAFE, 'the Safe owns the name');
    assert.equal(subregistry, zeroAddress);
    assert.equal(resolver, zeroAddress);
    assert.equal(duration, 365n * 24n * 60n * 60n);
    assert.equal(token.toLowerCase(), net.ensPaymentToken.toLowerCase());
    assert.equal(referrer, zeroHash);
    assert.equal(commit.args[0], ensCommitment({ label, owner, secret, subregistry, resolver, duration, referrer }), 'the commitment is the one register reveals');
    assert.ok(sent.every((t) => t.value === 0n));
    assert.ok(sent.every((t) => t.nonce !== undefined));

    // The wait starts from the commit block's timestamp and adds MIN_COMMITMENT_AGE + 1 s.
    assert.equal(waits.length, 1);
    const commitBlockTime = chain.state.time - 12n; // the register block is one block later
    assert.equal(waits[0].target, commitBlockTime + 60n + 1n);

    const job = ens.job(res.body.jobId);
    assert.equal(job.status, 200);
    assert.equal(job.body.status, 'registered');
    assert.equal(job.body.txHashes.length, 4);
    assert.equal(job.body.label, 'gov-vectors');
    assert.equal(job.body.safe, SAFE);
    assert.ok(!JSON.stringify(job.body).includes(secret), 'the commit secret is not in the job answer');
  });

  test('ens: recording a send fails after its broadcast: the job goes on and keeps the hash (25-28 round 2, MEDIUM 5)', async () => {
    const { db, ens, chain } = setup();
    db.recordSend = () => { throw new Error('disk full'); };
    const res = await ens.request(body());
    await ens.idle();
    const job = ens.job(res.body.jobId).body;
    assert.equal(job.status, 'registered', JSON.stringify(job));
    assert.equal(job.txHashes.length, 4);
    assert.equal(chain.state.sent.length, 4);
  });

  test('ens: the job is reported as committed while it waits, then registered', async () => {
    const seen = [];
    const db = openDb(':memory:');
    db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth', community: COMMUNITY });
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => 1_700_000_000_000 });
    const chain = ensChain(networks);
    const queue = createQueue({ db, chains: chain.chains, cap, address: ME, logger: quiet });
    let id;
    const ens = createEns({
      db, config: { address: ME, configured: true }, networks, chains: chain.chains, cap, queue, logger: quiet, pollMs: 1,
      wait: async () => { seen.push(ens.job(id).body); },
    });
    id = (await ens.request(body())).body.jobId;
    await ens.idle();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, 'committed');
    assert.equal(seen[0].txHashes.length, 3);
    assert.equal(ens.job(id).body.status, 'registered');
  });

  test('ens: on a non-testnet chain the mint step is never built, and a low token balance fails the job', async () => {
    const live = { ...networks, [String(CHAIN)]: { ...net, testnet: false } };
    const rich = setup({ nets: live });
    const res = await rich.ens.request(body());
    assert.equal(res.status, 202);
    await rich.ens.idle();
    assert.deepEqual(rich.chain.state.sent.map(selectorOf), [SELECTORS.approve, SELECTORS.commit, SELECTORS.register]);
    assert.equal(rich.ens.job(res.body.jobId).body.status, 'registered');

    const poor = setup({ nets: live, chain: { tokenBalance: 1n } });
    const res2 = await poor.ens.request(body());
    await poor.ens.idle();
    assert.equal(poor.chain.state.sent.length, 0);
    const job = poor.ens.job(res2.body.jobId).body;
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'payment_token_balance_too_low');
  });

  test('ens: a reverted step fails the job with the step name and nothing later is sent', async () => {
    const { ens, chain } = setup({ chain: { reverted: new Set([3]) } }); // the commit
    const res = await ens.request(body());
    await ens.idle();
    const job = ens.job(res.body.jobId).body;
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'commit:reverted');
    assert.equal(job.txHashes.length, 3);
    assert.equal(chain.state.sent.length, 3);
  });

  test('ens: a name taken while the job waited fails it before register is sent', async () => {
    const db = openDb(':memory:');
    db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth', community: COMMUNITY });
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => 1_700_000_000_000 });
    const chain = ensChain(networks);
    const queue = createQueue({ db, chains: chain.chains, cap, address: ME, logger: quiet });
    const ens = createEns({
      db, config: { address: ME, configured: true }, networks, chains: chain.chains, cap, queue, logger: quiet, pollMs: 1,
      wait: async () => { chain.state.available = false; },
    });
    const res = await ens.request(body());
    await ens.idle();
    const job = ens.job(res.body.jobId).body;
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'register:name_taken');
    assert.deepEqual(chain.state.sent.map(selectorOf), [SELECTORS.mint, SELECTORS.approve, SELECTORS.commit]);
  });

  test('ens: round 3 #5, Codex repro: another send at the same nonce mined; the job never takes its receipt for its own step', async () => {
    const db = openDb(':memory:');
    db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth', community: COMMUNITY });
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => 1_700_000_000_000 });
    const chain = ensChain(networks);
    const other = `0x${'b2'.repeat(32)}`;
    const get = chain.chains.get;
    let first = true;
    chain.chains.get = (id) => {
      const c = get(id);
      if (!c) return c;
      return {
        ...c,
        walletClient: {
          signTransaction: (t) => c.walletClient.signTransaction(t),
          async sendRawTransaction(a) {
            const h = await c.walletClient.sendRawTransaction(a);
            if (first) {
              // The job's first send (mint) never mines; another send got the same nonce after it, and that one mined.
              first = false;
              const mine = db.findPendingByHash(h);
              const r = chain.state.receipts[h];
              delete chain.state.receipts[h];
              db.insertPending({ chainId: CHAIN, nonce: mine.nonce, hash: other, to: ME, data: '0x', value: 0n, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, sentBlock: 1n, kind: 'send' });
              chain.state.receipts[other] = { ...r, transactionHash: other };
            }
            return h;
          },
        },
      };
    };
    const queue = createQueue({ db, chains: chain.chains, cap, address: ME, logger: quiet });
    const ens = createEns({
      db, config: { address: ME, configured: true }, networks, chains: chain.chains, cap, queue, logger: quiet, pollMs: 1, timeoutMs: 30, wait: async () => {},
    });
    const res = await ens.request(body());
    await ens.idle();
    const job = ens.job(res.body.jobId).body;
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'mint:timeout', 'the job waited for its own mint, not the other send at that nonce');
    assert.deepEqual(chain.state.sent.map(selectorOf), [SELECTORS.mint], 'nothing after the mint was sent');
  });

  test('ens: a second request for the same label while a job runs answers 409 job_in_progress', async () => {
    const db = openDb(':memory:');
    db.addGroup({ chainId: CHAIN, safe: SAFE, space: 'gov-vectors.eth', community: COMMUNITY });
    const cap = createCap({ db, caps: { dayWei: 10n ** 18n, monthWei: 10n ** 19n }, now: () => 1_700_000_000_000 });
    const chain = ensChain(networks);
    const queue = createQueue({ db, chains: chain.chains, cap, address: ME, logger: quiet });
    let release;
    const gate = new Promise((r) => { release = r; });
    const ens = createEns({ db, config: { address: ME, configured: true }, networks, chains: chain.chains, cap, queue, logger: quiet, pollMs: 1, wait: () => gate });
    const first = await ens.request(body());
    assert.equal(first.status, 202);
    // Let the job reach its wait.
    for (let i = 0; i < 200 && ens.job(first.body.jobId).body.status !== 'committed'; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ens.job(first.body.jobId).body.status, 'committed');
    const second = await ens.request(body());
    assert.equal(second.status, 409);
    assert.equal(second.body.reason, 'job_in_progress');
    release();
    await ens.idle();
    assert.equal(ens.job(first.body.jobId).body.status, 'registered');
  });

  test('ens: an owner other than the Safe after register fails the job', async () => {
    const { ens } = setup({ chain: { owner: getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8') } });
    const res = await ens.request(body());
    await ens.idle();
    const job = ens.job(res.body.jobId).body;
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'register:owner_mismatch');
  });

  test('ens: a reached spend cap fails the job and nothing is sent', async () => {
    const { ens, chain } = setup({ capWei: 1n });
    const res = await ens.request(body());
    await ens.idle();
    assert.equal(chain.state.sent.length, 0);
    assert.equal(ens.job(res.body.jobId).body.error, 'mint:cap_reached');
  });

  test('ens: jobs left open by a restart are marked failed, never silently resumed', async () => {
    const { ens, db } = setup();
    db.insertJob({ id: 'a'.repeat(32), kind: 'ens', chainId: CHAIN, safe: SAFE, label: 'gov-vectors', secret: zeroHash });
    assert.equal(ens.resume(), 1);
    const job = ens.job('a'.repeat(32)).body;
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'interrupted_by_restart');
  });
});

describe('ens source', () => {
  test('ens: the relayer never sets a text record or a resolver', () => {
    for (const file of ['../../src/sends/ens.js', '../../src/server.js', '../../src/allowlist.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /setText|setResolver|setAddr/, file);
    }
  });
});
