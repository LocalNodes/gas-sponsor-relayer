// A Safe may replace its registered space while no name job for the old space has started registering
// (25-19 follow-up, orchestrator ruling 2026-11-08 answer 1). The case: someone takes the Group's name
// between registration and name reservation, so the Group needs a new space and a new name.
//
// The chain is a fake EIP-1271 check with real ECDSA over the registration digest: a Safe accepts a
// signature only from its own owner key (anvil test keys; nothing touches a network).
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, recoverAddress, zeroHash } from 'viem';
import { ERC1271_MAGIC, registrationDigest } from '../../src/registration.js';
import { account } from '../helpers/fork.js';
import { COMMUNITY, RELAYER_ACCOUNT, SAFE, startStub } from '../helpers/stub.js';

const CHAIN = 11155111;
const OTHER = getAddress('0x0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e0a7e');
const OWNERS = { [SAFE]: account(0), [OTHER]: account(1) };
const NOT_MAGIC = '0xffffffff';

/** isValidSignature as a 1-of-1 Safe answers it: the magic value only for its owner's signature over that digest. */
async function fake1271({ address, args }) {
  const owner = OWNERS[getAddress(address)];
  if (!owner) return NOT_MAGIC;
  try {
    const signer = await recoverAddress({ hash: args[0], signature: args[1] });
    return signer === owner.address ? ERC1271_MAGIC : NOT_MAGIC;
  } catch {
    return NOT_MAGIC;
  }
}

/** Reads for one test: isValidSignature goes to fake1271 (after `before`, if given); anything else throws. */
function reads({ before = null, isAvailable = null } = {}) {
  return async (req) => {
    if (req.functionName === 'isValidSignature') {
      if (before) await before();
      return fake1271(req);
    }
    if (req.functionName === 'isAvailable' && isAvailable) return isAvailable();
    throw new Error(`read refused in this test: ${req.functionName}`);
  };
}

/** The registration signature `signer` makes for (safe, space); by default the Safe's own owner. */
const sign = (safe, space, signer = OWNERS[safe]) =>
  signer.sign({ hash: registrationDigest({ chainId: CHAIN, relayer: RELAYER_ACCOUNT.address, safe, space, community: COMMUNITY }) });

const register = async (s, space, signature, safe = SAFE) => s.call('POST', '/groups', { chainId: CHAIN, safe, space, signature });

/** A name job row for `label`, as sends/ens.js leaves it. */
function seedJob(db, label, status, error = null, safe = SAFE) {
  const id = randomBytes(16).toString('hex');
  db.insertJob({ id, kind: 'ens', chainId: CHAIN, safe, label, secret: zeroHash });
  if (status !== 'pending') db.updateJob(id, { status, hashes: [], error });
  return id;
}

/** Resolves for every caller once `n` callers are waiting: both racers have passed the signature read. */
function barrier(n) {
  let waiting = 0;
  let open;
  const all = new Promise((resolve) => { open = resolve; });
  return async () => {
    waiting += 1;
    if (waiting >= n) open();
    await all;
  };
}

const OLD = 'old-name.eth';
const groupRow = (space, safe = SAFE) => ({ chainId: CHAIN, safe, space, community: COMMUNITY });

describe('registration: replacing the space', () => {
  test('a replacement signed by the same Safe succeeds, and only the new space exists', async () => {
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: OLD }], chainsOpts: { readResult: reads() } });
    try {
      const res = await register(s, 'new-name.eth', await sign(SAFE, 'new-name.eth'));
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.space, 'new-name.eth');
      assert.equal(res.json.replaced, OLD);
      assert.equal(res.json.safe, SAFE);
      assert.equal(res.json.community, COMMUNITY);
      assert.deepEqual(s.db.listGroups(), [groupRow('new-name.eth')]);
      const status = await s.call('GET', '/status');
      assert.deepEqual(status.json.groups.map((g) => g.space), ['new-name.eth']);
      // The same request again is the plain "already registered" answer.
      const again = await register(s, 'new-name.eth', await sign(SAFE, 'new-name.eth'));
      assert.equal(again.status, 200, again.text);
      assert.equal(again.json.replaced, undefined);
      // And the old space cannot come back as a second row: it is a replacement too.
      assert.deepEqual(s.db.listGroups(), [groupRow('new-name.eth')]);
    } finally {
      await s.close();
    }
  });

  test('a name job that failed before its register send does not block the replacement', async () => {
    for (const error of ['register:name_taken', 'register:unreadable', 'register:price_changed', 'commit:reverted', 'approve:cap_reached', 'mint:send_failed', 'wait:read_failed', 'price:unreadable', 'balance:unreadable', 'payment_token_balance_too_low', 'chain_not_available']) {
      const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: OLD }], chainsOpts: { readResult: reads() } });
      try {
        seedJob(s.db, 'old-name', 'failed', error);
        const res = await register(s, 'new-name.eth', await sign(SAFE, 'new-name.eth'));
        assert.equal(res.status, 201, `${error}: ${res.text}`);
        assert.deepEqual(s.db.listGroups(), [groupRow('new-name.eth')], error);
      } finally {
        await s.close();
      }
    }
  });

  test("another Safe's signature is refused, and the space stays", async () => {
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: OLD }], chainsOpts: { readResult: reads() } });
    try {
      // The other Safe's owner signs this Safe's replacement.
      const forged = await register(s, 'new-name.eth', await sign(SAFE, 'new-name.eth', OWNERS[OTHER]));
      assert.equal(forged.status, 403, forged.text);
      assert.equal(forged.json.reason, 'registration_signature_invalid');
      // A signature the other Safe really accepts, but for itself, sent under this Safe.
      const borrowed = await register(s, 'new-name.eth', await sign(OTHER, 'new-name.eth'));
      assert.equal(borrowed.status, 403, borrowed.text);
      assert.equal(borrowed.json.reason, 'registration_signature_invalid');
      assert.deepEqual(s.db.listGroups(), [groupRow(OLD)]);
      // Control: that signature is valid for the other Safe, so the refusals above are the Safe check firing.
      const own = await register(s, 'new-name.eth', await sign(OTHER, 'new-name.eth'), OTHER);
      assert.equal(own.status, 201, own.text);
      assert.equal(s.db.getGroup(CHAIN, SAFE).space, OLD);
    } finally {
      await s.close();
    }
  });

  test('a replacement after the name job started is refused with the existing 409', async () => {
    const started = [
      ['pending', null],
      ['committed', null],
      ['registered', null],
      // Failed at or after the register send: the old name may still end up owned by the Safe.
      ['failed', 'register:timeout'],
      ['failed', 'register:reverted'],
      ['failed', 'register:send_failed'],
      ['failed', 'register:owner_mismatch'],
      ['failed', 'register:owner_unreadable'],
      // Failed at an unknown point: treated as started.
      ['failed', 'interrupted_by_restart'],
      ['failed', 'internal'],
    ];
    for (const [status, error] of started) {
      const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: OLD }], chainsOpts: { readResult: reads() } });
      try {
        seedJob(s.db, 'old-name', 'failed', 'register:name_taken');
        seedJob(s.db, 'old-name', status, error);
        const res = await register(s, 'new-name.eth', await sign(SAFE, 'new-name.eth'));
        assert.equal(res.status, 409, `${status} ${error}: ${res.text}`);
        assert.deepEqual(res.json, { error: 'conflict', reason: 'safe_registered_with_another_space' });
        assert.deepEqual(s.db.listGroups(), [groupRow(OLD)], `${status} ${error}`);
      } finally {
        await s.close();
      }
    }
  });

  test("only a name job for this Safe's registered space blocks it", async () => {
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: OLD }], chainsOpts: { readResult: reads() } });
    try {
      seedJob(s.db, 'unrelated', 'registered');
      seedJob(s.db, 'old-name', 'registered', null, OTHER);
      const res = await register(s, 'new-name.eth', await sign(SAFE, 'new-name.eth'));
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(s.db.listGroups(), [groupRow('new-name.eth')]);
    } finally {
      await s.close();
    }
  });

  test('two racing replacements leave exactly one space', async () => {
    // Both requests pass the Safe's signature check before either reaches the store.
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: OLD }], chainsOpts: { readResult: reads({ before: barrier(2) }) } });
    try {
      const [one, two] = await Promise.all([
        register(s, 'new-one.eth', await sign(SAFE, 'new-one.eth')),
        register(s, 'new-two.eth', await sign(SAFE, 'new-two.eth')),
      ]);
      assert.deepEqual([one.status, two.status], [201, 201], `${one.text} ${two.text}`);
      const rows = s.db.listGroups();
      assert.equal(rows.length, 1);
      assert.ok(['new-one.eth', 'new-two.eth'].includes(rows[0].space), rows[0].space);
      const status = await s.call('GET', '/status');
      assert.equal(status.json.groups.length, 1);
    } finally {
      await s.close();
    }
  });

  test('two racing first registrations leave exactly one space', async () => {
    const s = await startStub({ chainsOpts: { readResult: reads({ before: barrier(2) }) } });
    try {
      const [one, two] = await Promise.all([
        register(s, 'new-one.eth', await sign(SAFE, 'new-one.eth')),
        register(s, 'new-two.eth', await sign(SAFE, 'new-two.eth')),
      ]);
      assert.deepEqual([one.status, two.status], [201, 201], `${one.text} ${two.text}`);
      assert.equal(s.db.listGroups().length, 1);
    } finally {
      await s.close();
    }
  });

  test('a name job asked for while its space is replaced never starts for the old space', async () => {
    // POST /send/ens checks the space, then reads isAvailable; the replacement lands during that read.
    let asked;
    const reached = new Promise((resolve) => { asked = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const isAvailable = async () => { asked(); await gate; return true; };
    const s = await startStub({ groups: [{ chainId: CHAIN, safe: SAFE, space: OLD }], chainsOpts: { readResult: reads({ isAvailable }) } });
    try {
      const ens = s.call('POST', '/send/ens', { chainId: CHAIN, safe: SAFE, label: 'old-name' });
      await reached;
      const res = await register(s, 'new-name.eth', await sign(SAFE, 'new-name.eth'));
      assert.equal(res.status, 201, res.text);
      release();
      const out = await ens;
      assert.equal(out.status, 403, out.text);
      assert.equal(out.json.reason, 'label_not_space');
      assert.equal(s.db.findOpenJob(CHAIN, 'old-name'), null);
      assert.deepEqual(s.db.listGroups(), [groupRow('new-name.eth')]);
    } finally {
      await s.close();
    }
  });
});
