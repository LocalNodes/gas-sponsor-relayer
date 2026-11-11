// Licence guard: no tracked file under test/ may hold Reality.eth's Arbitrator creation code
// (GPL-3.0-only; this repository is GPL-2.0-or-later and public). The code is not stored here, only
// the sha256 of each of its 20-byte windows. See test/helpers/arbitrator-guard.js and
// test/fixtures/vectors/README.md. Failure messages carry paths, counts and offsets, never text.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hitsInText, listFiles, scanTree, WINDOW_HEX } from '../helpers/arbitrator-guard.js';

const TEST_DIR = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const list = JSON.parse(readFileSync(new URL('../fixtures/guard/arbitrator-window-sha256.json', import.meta.url), 'utf8'));

// A made-up 64-byte "code" so the scanner can be shown to fire without any real bytes.
const sha = (s) => createHash('sha256').update(s).digest('hex');
let seed = 'synthetic';
let fake = '';
while (fake.length < 128) {
  seed = sha(seed);
  fake += seed;
}
fake = fake.slice(0, 128);
const fakeSet = new Set();
for (let i = 0; i + WINDOW_HEX <= fake.length; i += 2) fakeSet.add(sha(fake.slice(i, i + WINDOW_HEX)));
const ALIGNED_WINDOWS = (128 - WINDOW_HEX) / 2 + 1; // 45

describe('arbitrator licence guard: the scanner', () => {
  test('fires on a copy of the code however it is written', () => {
    assert.equal(fakeSet.size, ALIGNED_WINDOWS);
    const cases = {
      bare: fake,
      '0x prefix': `"data": "0x${fake}"`,
      uppercase: fake.toUpperCase(),
      'inside a longer hex run, at an odd character offset': `abc${fake}f00d`,
      'as the tail of a calldata word': `${'0'.repeat(63)}1${fake}`,
    };
    for (const [name, text] of Object.entries(cases)) {
      const hits = hitsInText(text, fakeSet);
      assert.equal(hits.length, ALIGNED_WINDOWS, `${name}: expected every aligned window to be found, got ${hits.length}`);
    }
  });

  test('fires on a part of the code that holds one whole window, and not on less', () => {
    assert.equal(hitsInText(fake.slice(10, 10 + WINDOW_HEX), fakeSet).length, 1);
    assert.equal(hitsInText(fake.slice(10, 10 + WINDOW_HEX - 1), fakeSet).length, 0, 'one character short of a window');
  });

  test('does not fire when a character is changed inside every window', () => {
    // Change one character every 30: no 40-character stretch of the code is left intact.
    const broken = fake.split('').map((c, i) => (i % 30 === 29 ? (c === '0' ? '1' : '0') : c)).join('');
    assert.equal(hitsInText(broken, fakeSet).length, 0);
  });

  test('a hit carries only an offset and a hash, never the matched text', () => {
    const [hit] = hitsInText(`zz ${fake}`, fakeSet);
    assert.deepEqual(Object.keys(hit).sort(), ['hash', 'offset']);
    assert.equal(hit.offset, 3);
  });
});

describe('arbitrator licence guard: the hash list', () => {
  test('is well-formed and holds hashes, not code', () => {
    assert.equal(list.windowBytes * 2, WINDOW_HEX);
    assert.equal(list.codeBytes, 3585);
    assert.equal(list.decodedCodeSha256, '0x022c7c772f86b46876212d1c48b1190a4a86d723a90b09fc5ae19c55ef96aa0b');
    assert.ok(Array.isArray(list.sha256));
    assert.equal(list.sha256.length, list.windowsInCode - list.leftOutAsGeneric);
    assert.equal(new Set(list.sha256).size, list.sha256.length, 'duplicate hashes');
    assert.ok(list.sha256.length > 3000, `only ${list.sha256.length} window hashes; the guard would be thin`);
    for (const h of list.sha256) assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe('arbitrator licence guard: the tree', () => {
  test('the scan reaches the vectors and leaves out only the private directory', () => {
    const rel = listFiles(TEST_DIR, ['fixtures/private']).map((f) => relative(TEST_DIR, f));
    assert.ok(rel.includes('fixtures/vectors/setup-batch.json'));
    assert.ok(rel.includes('fork/setup.fork.test.js'));
    assert.ok(rel.includes('fixtures/guard/arbitrator-window-sha256.json'));
    assert.ok(!rel.some((f) => f.startsWith('fixtures/private/')));
  });

  test('no file under test/ (except test/fixtures/private) holds any window of the Arbitrator code', () => {
    const found = scanTree(TEST_DIR, new Set(list.sha256));
    assert.deepEqual(found, [], `Arbitrator code windows found (file, count, first character offset): ${JSON.stringify(found)}`);
  });
});
