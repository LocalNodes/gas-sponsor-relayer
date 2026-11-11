// Writes test/fixtures/guard/arbitrator-window-sha256.json from the private copy of the setup
// vector (test/fixtures/private/setup-batch.real.json, never tracked). Run by hand:
//   node test/helpers/make-arbitrator-window-hashes.mjs [stand-in vector]
// The optional argument is a stand-in vector (fresh3's tests/governance/vectors/setup-batch.json) for
// the case that the tracked vector still holds the real code.
// The Arbitrator code is found where the tracked stand-in vector holds its run of 0xfe bytes, and
// is checked against the pinned sha256 of the decoded code before anything is written. Only the
// sha256 of each byte-aligned 20-byte window is written, never the code.
//
// A window is left out if it also occurs in the rest of the tracked tree as it will be once the real
// code is gone (other fixtures, the stand-in itself): such a window is generic (a run of one byte,
// say) and would make the guard fire on files that hold no part of the code. The number left out is
// recorded in the file.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hitsInText, listFiles, windowHashes, WINDOW_HEX } from './arbitrator-guard.js';

const testDir = fileURLToPath(new URL('..', import.meta.url));
const privatePath = process.env.LN_SETUP_BATCH_REAL ?? `${testDir}fixtures/private/setup-batch.real.json`;
const vectorRel = 'fixtures/vectors/setup-batch.json';
const PIN_DECODED_SHA256 = '022c7c772f86b46876212d1c48b1190a4a86d723a90b09fc5ae19c55ef96aa0b';
const BYTES = 3585;

const real = JSON.parse(readFileSync(privatePath, 'utf8'));
const standIn = 'fe'.repeat(BYTES);
const tracked = JSON.parse(readFileSync(process.argv[2] ?? `${testDir}${vectorRel}`, 'utf8'));
const at = tracked.calls[0].data.indexOf(standIn);
if (at < 0) {
  console.error('the vector holds no stand-in; pass a stand-in vector as the argument');
  process.exit(1);
}
const code = real.calls[0].data.slice(at, at + BYTES * 2).toLowerCase();
const decodedSha = createHash('sha256').update(Buffer.from(code, 'hex')).digest('hex');
if (decodedSha !== PIN_DECODED_SHA256) {
  console.error('the private copy does not hold the pinned Arbitrator code (decoded sha256 differs)');
  process.exit(1);
}

const all = new Set();
for (let i = 0; i + WINDOW_HEX <= code.length; i += 2) all.add(windowHashes(code.slice(i, i + WINDOW_HEX), 1)[0].hash);

// Generic windows: those found in any other tracked file, or in the vector with the code replaced by the stand-in.
const textOf = (rel, text) => (rel === vectorRel ? text.replaceAll(code, standIn) : text);
const root = testDir.replace(/\/$/, '');
const hitting = new Set();
{
  for (const file of listFiles(root, ['fixtures/private', 'fixtures/guard'])) {
    const rel = file.slice(root.length + 1);
    for (const hit of hitsInText(textOf(rel, readFileSync(file, 'latin1')), all)) hitting.add(hit.hash);
  }
}
const kept = [...all].filter((h) => !hitting.has(h)).sort();
const out = {
  note: 'sha256 of the lowercase 40-hex-character string of each byte-aligned 20-byte window of the Reality.eth Arbitrator creation code (GPL-3.0-only). The code is not stored. Made by test/helpers/make-arbitrator-window-hashes.mjs. See test/fixtures/vectors/README.md.',
  windowBytes: 20,
  codeBytes: BYTES,
  decodedCodeSha256: `0x${PIN_DECODED_SHA256}`,
  windowsInCode: all.size,
  leftOutAsGeneric: hitting.size,
  sha256: kept,
};
writeFileSync(`${testDir}fixtures/guard/arbitrator-window-sha256.json`, `${JSON.stringify(out, null, 1)}\n`);
console.log(`windows ${all.size}, left out as generic ${hitting.size}, written ${kept.length}`);
