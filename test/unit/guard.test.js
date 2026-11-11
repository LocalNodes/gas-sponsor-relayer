import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SELECTORS } from '../../src/allowlist.js';

const SRC = new URL('../../src/', import.meta.url).pathname;

// Same address class as scripts/ci/check-web3-gates.sh in fresh3: 0x plus 40 hex digits not
// followed by more hex. Addresses live only in config/networks.json.
const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
// A four-byte selector literal. Selectors are named constants in allowlist.js and nowhere else.
const SELECTOR_RE = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{8}(?![0-9a-fA-F])/g;
// A Solidity function named inside an ABI string, or a viem functionName.
const ABI_FN_RE = /['"`]function\s+([A-Za-z0-9_]+)\s*\(/g;
const FUNCTION_NAME_RE = /functionName:\s*['"]([A-Za-z0-9_]+)['"]/g;
// Functions the relayer may call: everything it may send, plus the read-only views it needs
// (registration check, module discovery in groups.js, ENS availability, price, wait and owner reads). A read never changes state.
const READ_ONLY = [
  'isValidSignature', 'getModulesPaginated', 'avatar', 'target', 'isAvailable', 'getRegisterPrice', 'MIN_COMMITMENT_AGE', 'balanceOf', 'findExactOwner',
  // Reality module and Reality.eth views (sends/reality.js, reclaim.js)
  'questionIds', 'executedProposalTransactions', 'minimumBond', 'questionCooldown', 'buildQuestion', 'getQuestionId',
  'isFinalized', 'getFinalizeTS', 'getBond', 'resultFor',
  // The wrong-answer watcher reads the best answer of a question that is not final yet (watcher.js)
  'getBestAnswer',
  // The Safe's nonce, read to key a safe-exec request (sends/safeExec.js)
  'nonce',
];
const ALLOWED_FUNCTIONS = new Set([...Object.keys(SELECTORS), ...READ_ONLY]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Guard functions: each returns a list of "file: kind: text" findings for a src tree. */
export function findLiteralAddresses(root) {
  const out = [];
  for (const f of walk(root)) {
    for (const m of readFileSync(f, 'utf8').matchAll(ADDRESS_RE)) out.push(`${relative(root, f)}: address: ${m[0]}`);
  }
  return out;
}
export function findStraySelectors(root) {
  const out = [];
  for (const f of walk(root)) {
    if (relative(root, f) === 'allowlist.js') continue;
    for (const m of readFileSync(f, 'utf8').matchAll(SELECTOR_RE)) out.push(`${relative(root, f)}: selector: ${m[0]}`);
  }
  return out;
}
export function findUnlistedFunctions(root) {
  const out = [];
  for (const f of walk(root)) {
    const text = readFileSync(f, 'utf8');
    for (const re of [ABI_FN_RE, FUNCTION_NAME_RE]) {
      for (const m of text.matchAll(re)) if (!ALLOWED_FUNCTIONS.has(m[1])) out.push(`${relative(root, f)}: function: ${m[1]}`);
    }
  }
  return out;
}
const guards = { findLiteralAddresses, findStraySelectors, findUnlistedFunctions };

describe('guard', () => {
  test('guard: the real src/ holds no literal address, no stray selector and no unlisted function', () => {
    assert.ok(walk(SRC).length >= 8, 'src/ was found');
    for (const [name, guard] of Object.entries(guards)) assert.deepEqual(guard(SRC), [], name);
  });

  test('guard: planted violations in a temp copy of src/ are each reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relayer-guard-'));
    try {
      const copy = join(dir, 'src');
      cpSync(SRC, copy, { recursive: true });
      for (const guard of Object.values(guards)) assert.deepEqual(guard(copy), [], 'the copy starts clean');

      const planted = join(copy, 'sends', 'safeExec.js');
      const original = readFileSync(planted, 'utf8');
      writeFileSync(
        planted,
        `${original}\n// planted\nconst PLANTED_ADDRESS = '0x3bc1A0Ad72417f2d411118085256fC53CBdDd137';\nconst PLANTED_SELECTOR = '0xdeadbeef';\nconst PLANTED_ABI = ['function mintHat(uint256,address)'];\nconst PLANTED_CALL = { functionName: 'enableModule' };\n`,
      );
      assert.ok(statSync(planted).size > original.length);

      const addresses = findLiteralAddresses(copy);
      assert.deepEqual(addresses, ['sends/safeExec.js: address: 0x3bc1A0Ad72417f2d411118085256fC53CBdDd137']);
      assert.deepEqual(findStraySelectors(copy), ['sends/safeExec.js: selector: 0xdeadbeef']);
      assert.deepEqual(findUnlistedFunctions(copy).sort(), ['sends/safeExec.js: function: enableModule', 'sends/safeExec.js: function: mintHat']);

      // The real tree is untouched.
      for (const guard of Object.values(guards)) assert.deepEqual(guard(SRC), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('guard: a planted address is also caught when it sits in a new file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relayer-guard-'));
    try {
      const copy = join(dir, 'src');
      cpSync(SRC, copy, { recursive: true });
      writeFileSync(join(copy, 'extra.js'), "export const X = '0x00000000000000000000000000000000000000aa';\n");
      assert.equal(findLiteralAddresses(copy).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
