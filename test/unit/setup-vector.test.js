// The fork setup test picks its vector with test/helpers/setup-vector.js: the real one when the
// private copy is there, the tracked stand-in when it is not. These tests run on made-up code
// (never the real Arbitrator bytes) so the choice can be checked without a fork.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSetupVector, SKIP_REAL_REASON } from '../helpers/setup-vector.js';

const BYTES = 3585;
const STAND_IN = 'fe'.repeat(BYTES);
const sha = (b) => createHash('sha256').update(b).digest('hex');
// Made-up "Arbitrator code": 3585 deterministic bytes.
let made = '';
for (let s = 'made-up'; made.length < BYTES * 2; ) {
  s = sha(s);
  made += s;
}
const MADE_UP = made.slice(0, BYTES * 2);
const pad = (n) => '00'.repeat(n);
const vectorWith = (code, extra = {}) => ({
  inputs: { arbitratorInitCodeSha256: `0x${sha(Buffer.from(MADE_UP, 'hex'))}`, arbitratorInitCodeSource: 'x', arbitratorInitCodeKeccak256: '0x1', arbitratorInitCodeStandIn: 'y', owners: ['0xaa'] },
  calls: [{ data: `0x${pad(4)}${code}${pad(4)}` }],
  multiSendPacked: `0x${code}`,
  safeTx: { data: `0x${pad(2)}${code}` },
  typedData: { message: { data: `0x${pad(2)}${code}` } },
  variants: { any_member: { calls: [{ data: `0x${code}${pad(1)}` }], multiSendPacked: `0x${code}`, safeTxData: `0x${code}` } },
  safeTxHash: '0xabc',
  ...extra,
});

const dir = mkdtempSync(join(tmpdir(), 'setup-vector-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const put = (name, v) => {
  const p = join(dir, name);
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
  return p;
};
const tracked = put('tracked.json', vectorWith(STAND_IN));
const missing = join(dir, 'does-not-exist.json');

describe('setup vector choice', () => {
  test('without the private copy: the tracked stand-in, and the diagnostic names it by sha256 only', () => {
    const r = loadSetupVector({ env: {}, trackedPath: tracked, privatePath: missing });
    assert.equal(r.real, false);
    assert.equal(r.path, tracked);
    assert.match(r.fileSha256, /^[0-9a-f]{64}$/);
    assert.ok(r.diagnostic.includes(r.fileSha256));
    assert.ok(r.diagnostic.includes('stand-in'));
    assert.ok(r.diagnostic.includes(SKIP_REAL_REASON));
    assert.equal(SKIP_REAL_REASON, 'real Arbitrator code not present; see test/fixtures/vectors/README.md');
  });

  test('the shipped tracked vector is the stand-in: 7 copies of 0xfe x 3585, none of anything else', () => {
    const r = loadSetupVector({ env: {}, privatePath: missing });
    assert.equal(r.real, false);
    const text = JSON.stringify(r.vector);
    assert.equal(text.split(STAND_IN).length - 1, 7);
    assert.equal(r.vector.inputs.arbitratorInitCodeBytes, BYTES);
  });

  test('with a private copy at the default place: the real vector, and the diagnostic says so by sha256 only', () => {
    const priv = put('private.json', vectorWith(MADE_UP));
    const r = loadSetupVector({ env: {}, trackedPath: tracked, privatePath: priv });
    assert.equal(r.real, true);
    assert.equal(r.path, priv);
    assert.ok(r.diagnostic.includes('REAL'));
    assert.ok(r.diagnostic.includes(r.fileSha256));
    assert.ok(!r.diagnostic.includes(MADE_UP.slice(0, 40)), 'the diagnostic must not carry code');
    assert.ok(r.vector.calls[0].data.includes(MADE_UP));
  });

  test('LN_SETUP_BATCH_REAL names the private copy and wins over the default place', () => {
    const priv = put('private-env.json', vectorWith(MADE_UP));
    const r = loadSetupVector({ env: { LN_SETUP_BATCH_REAL: priv }, trackedPath: tracked, privatePath: missing });
    assert.equal(r.real, true);
    assert.equal(r.path, priv);
    assert.ok(r.diagnostic.includes('LN_SETUP_BATCH_REAL'));
  });

  test('LN_SETUP_BATCH_REAL pointing at nothing is an error, not a quiet fall back to the stand-in', () => {
    assert.throws(() => loadSetupVector({ env: { LN_SETUP_BATCH_REAL: missing }, trackedPath: tracked, privatePath: missing }), /LN_SETUP_BATCH_REAL is set but .* does not exist/);
  });

  test('a private copy with other code, a missing copy of the code, or a stale vector is refused', () => {
    const otherCode = `${MADE_UP.slice(0, -2)}${MADE_UP.endsWith('00') ? '01' : '00'}`;
    const wrongCode = put('wrong.json', vectorWith(otherCode));
    assert.throws(() => loadSetupVector({ env: {}, trackedPath: tracked, privatePath: wrongCode }), /does not hash to the pinned sha256/);

    const v = vectorWith(MADE_UP);
    v.safeTx.data = '0x00'; // one of the 7 copies gone
    assert.throws(() => loadSetupVector({ env: {}, trackedPath: tracked, privatePath: put('six.json', v) }), /expected the Arbitrator code 7 times/);

    const stale = vectorWith(MADE_UP);
    stale.inputs.owners = ['0xbb'];
    assert.throws(() => loadSetupVector({ env: {}, trackedPath: tracked, privatePath: put('stale.json', stale) }), /differs from the tracked setup vector/);
    const staleHash = vectorWith(MADE_UP, { safeTxHash: '0xdef' });
    assert.throws(() => loadSetupVector({ env: {}, trackedPath: tracked, privatePath: put('stale2.json', staleHash) }), /differs from the tracked setup vector/);
  });
});
