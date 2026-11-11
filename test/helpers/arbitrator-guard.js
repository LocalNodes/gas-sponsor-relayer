// Licence guard for the fixtures. Reality.eth's Arbitrator creation code is GPL-3.0-only; this
// repository is GPL-2.0-or-later and is published, so no tracked file under test/ may hold that
// code. The code itself is not stored anywhere in the tracked tree. What is stored is the sha256
// of every 20-byte window of it (as 40 lowercase hex characters), in
// test/fixtures/guard/arbitrator-window-sha256.json. This module slides a 40-character window
// over every hex run in a file and reports any window whose hash is in that list.
//
// A hit is reported as path, character offset and hash only. The matched text is never returned,
// so a failing test cannot print the code.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const WINDOW_HEX = 40; // 20 bytes

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** All windows of `hex` (a lowercase hex string): [{ offset, hash }], every character offset. */
export function windowHashes(hex, step = 1, size = WINDOW_HEX) {
  const out = [];
  for (let i = 0; i + size <= hex.length; i += step) out.push({ offset: i, hash: sha256Hex(hex.slice(i, i + size)) });
  return out;
}

/** Hits of `hashSet` (a Set of sha256 hex strings) in `text`: [{ offset, hash }]. Case-insensitive. */
export function hitsInText(text, hashSet, size = WINDOW_HEX) {
  const hits = [];
  const re = new RegExp(`[0-9a-f]{${size},}`, 'g');
  const lower = text.toLowerCase();
  let m;
  while ((m = re.exec(lower)) !== null) {
    const run = m[0];
    for (let i = 0; i + size <= run.length; i += 1) {
      const hash = sha256Hex(run.slice(i, i + size));
      if (hashSet.has(hash)) hits.push({ offset: m.index + i, hash });
    }
  }
  return hits;
}

/** Every file under `root`, skipping directories named in `skipDirs` (paths relative to root). */
export function listFiles(root, skipDirs = []) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      if (e.isDirectory()) {
        if (!skipDirs.includes(rel)) walk(p);
      } else if (e.isFile()) files.push(p);
    }
  };
  walk(root);
  return files.sort();
}

/** Scan files under `root`. Returns [{ file (relative to root), count, firstOffset }]; no matched text. */
export function scanTree(root, hashSet, { skipDirs = ['fixtures/private'], textOf = (_file, text) => text } = {}) {
  const found = [];
  for (const file of listFiles(root, skipDirs)) {
    const rel = relative(root, file);
    const hits = hitsInText(textOf(rel, readFileSync(file, 'latin1')), hashSet);
    if (hits.length > 0) found.push({ file: rel, count: hits.length, firstOffset: hits[0].offset });
  }
  return found;
}
