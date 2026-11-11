// Chooses the setup-batch vector for the fork setup test.
//
// The tracked test/fixtures/vectors/setup-batch.json holds a 0xfe stand-in where the batch has
// Reality.eth's Arbitrator creation code (GPL-3.0-only, so it can't be in this repository). The
// real vector is kept untracked at test/fixtures/private/setup-batch.real.json, or at the path in
// the environment variable LN_SETUP_BATCH_REAL. When it is there it is used; when it is not, the
// stand-in is used and the assertions that need the real code are skipped.
//
// The private copy is checked before it is used: its Arbitrator code must hash to the pinned
// sha256, and with that code replaced by the stand-in it must equal the tracked vector (apart from
// the three `inputs` strings that describe the stand-in). A wrong or stale private copy throws; it
// is never quietly replaced by the stand-in. Nothing here returns or prints the code.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SKIP_REAL_REASON = 'real Arbitrator code not present; see test/fixtures/vectors/README.md';
const ARBITRATOR_BYTES = 3585;
const STAND_IN_HEX = 'fe'.repeat(ARBITRATOR_BYTES);
const STAND_IN_ONLY_INPUTS = ['arbitratorInitCodeSource', 'arbitratorInitCodeKeccak256', 'arbitratorInitCodeStandIn'];

export const TRACKED_PATH = fileURLToPath(new URL('../fixtures/vectors/setup-batch.json', import.meta.url));
export const DEFAULT_PRIVATE_PATH = fileURLToPath(new URL('../fixtures/private/setup-batch.real.json', import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const withoutStandInInputs = (v) => {
  const copy = structuredClone(v);
  for (const k of STAND_IN_ONLY_INPUTS) delete copy.inputs[k];
  return copy;
};

/**
 * @returns {{ vector: object, real: boolean, path: string, fileSha256: string, diagnostic: string }}
 */
export function loadSetupVector({ env = process.env, trackedPath = TRACKED_PATH, privatePath = DEFAULT_PRIVATE_PATH } = {}) {
  const trackedBytes = readFileSync(trackedPath);
  const tracked = JSON.parse(trackedBytes.toString('utf8'));
  const explicit = env.LN_SETUP_BATCH_REAL;
  const realPath = explicit ? explicit : privatePath;

  if (explicit && !existsSync(explicit)) throw new Error(`LN_SETUP_BATCH_REAL is set but ${explicit} does not exist`);
  if (!existsSync(realPath)) {
    const fileSha256 = sha256(trackedBytes);
    return {
      vector: tracked,
      real: false,
      path: trackedPath,
      fileSha256,
      diagnostic: `setup vector: tracked stand-in (0xfe in place of the Arbitrator code), file sha256 ${fileSha256}; ${SKIP_REAL_REASON}`,
    };
  }

  const realBytes = readFileSync(realPath);
  const real = JSON.parse(realBytes.toString('utf8'));
  const at = tracked.calls[0].data.indexOf(STAND_IN_HEX);
  if (at < 0) throw new Error('the tracked setup vector holds no stand-in, so the private copy cannot be checked against it');
  const code = real.calls[0].data.slice(at, at + ARBITRATOR_BYTES * 2);
  const pinned = tracked.inputs.arbitratorInitCodeSha256.replace(/^0x/, '');
  if (code.length !== ARBITRATOR_BYTES * 2 || !/^[0-9a-f]+$/.test(code) || sha256(Buffer.from(code, 'hex')) !== pinned) {
    throw new Error(`${realPath}: its Arbitrator code does not hash to the pinned sha256 ${pinned}`);
  }
  const text = realBytes.toString('utf8');
  if (text.split(code).length - 1 !== 7) throw new Error(`${realPath}: expected the Arbitrator code 7 times`);
  const swapped = JSON.parse(text.replaceAll(code, STAND_IN_HEX));
  if (JSON.stringify(withoutStandInInputs(swapped)) !== JSON.stringify(withoutStandInInputs(tracked))) {
    throw new Error(`${realPath}: apart from the Arbitrator code it differs from the tracked setup vector (stale copy?)`);
  }
  const fileSha256 = sha256(realBytes);
  return {
    vector: real,
    real: true,
    path: realPath,
    fileSha256,
    diagnostic: `setup vector: REAL Arbitrator code from ${explicit ? 'LN_SETUP_BATCH_REAL' : 'test/fixtures/private/setup-batch.real.json'}, file sha256 ${fileSha256}`,
  };
}
