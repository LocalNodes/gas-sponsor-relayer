# Test vectors

These JSON files are copies of `tests/governance/vectors/*.json` in the fresh3 repository.
They are generated there by `tests/governance/vectors.mjs`. Generator commits:

- `6a8e457` (plan 25-02): every file except `setup-batch.json` ("Reality, Hats, MultiSend, ENS,
  registration, ABI and pass-rule vectors with a fork cross-check").
- `e5e3f0a` (plan 25-06): `setup-batch.json` ("setup batch vector and vendored reference
  Arbitrator"). The other files did not change in that commit.
- `8a7de05 (hub main; lane SHA a324000)` (plan 25-16): `setup-batch.json` again ("setup batch takes the organizer's proposer
  rule, any_member variant"). It adds `inputs.proposerRule` (`proposer_hat`) and
  `variants.any_member` (the 9-call batch without proposer mints). The 11 calls the setup fork
  test sends are unchanged. The other files did not change in that commit.

Do not edit these files by hand. To refresh them, regenerate in fresh3 (`node vectors.mjs`,
then `node vectors.mjs --check`), copy the files over, and record the new fresh3 commit here.
The one exception is `setup-batch.json`, which holds a stand-in for the Arbitrator's code (next section).

The relayer tests use `registration.json` (the SponsorRegistration typed data and digest) and
`setup-batch.json` (the Group setup batch: `test/fork/setup.fork.test.js` sends its owner-signed
SafeTx through the relayer and checks every predicted address). The other files are kept so later
relayer plans (Reality, ENS) can read them without a second copy step.

## The Arbitrator's code in setup-batch.json

`setup-batch.json` does **not** hold Reality.eth's Arbitrator creation code. That code is
GPL-3.0-only (RealityETH reality-eth-monorepo @40b9886, `packages/contracts/bytecode/Arbitrator.bin`),
and this repository is GPL-2.0-or-later and public. The tracked file is fresh3's stand-in vector,
byte for byte (fresh3 commit `fe8ad618`, `tests/governance/vectors/setup-batch.json`, sha256
`8afaab00936eb3b53ddab8ab6a539abd5020c2edd4fc12c9cb91550bc389fdf0`): every one of the 7 places the
code appears (`calls[0].data`, `multiSendPacked`, `safeTx.data`, `typedData.message.data`, and
`variants.any_member` `calls[0].data`, `multiSendPacked` and `safeTxData`) holds 3585 bytes of `0xfe`
(INVALID), the real code's length, so every ABI length word and all padding are the real batch's.
The addresses in `predicted` are the real ones: the planner predicts the Arbitrator from the pinned
keccak256 of the code (`inputs.arbitratorInitCodeKeccak256`), not from the bytes. `safeTxHash` and
`signatures` are the ones made over the **real** code, so they are not the hash and signatures of
the stand-in batch, and the batch cannot run on a chain (the first call would deploy `0xfe`).

The real code was in this file from `c71c4d0` (plan 25-06) through `2fc37e0`, and is gone from the
commit after that (the swap commit, `test(25-29)`). It stays in the git history of this
repository; the history was not rewritten.

### Running the setup fork test with the real code

`test/fork/setup.fork.test.js` loads its vector through `test/helpers/setup-vector.js`:

- With the private copy present, it uses the real vector and runs all of its tests.
- Without it, it uses the tracked stand-in and **skips** the two tests that need the real batch (the
  SafeTx hash and signatures check, and the relayer sending the batch), with the reason "real
  Arbitrator code not present; see test/fixtures/vectors/README.md". The test that the Safe is fresh
  and nothing the batch creates exists yet still runs.
- The TAP output has a `# setup vector: ...` diagnostic line that says which vector was used and its
  file sha256 (never the contents).

To place the private copy, put the real vector (the pre-swap `setup-batch.json`, file sha256
`e5459957e2ae87d34a33753c62c490513a11d1ed798157147d9c4d574ecf1a49`) at
`test/fixtures/private/setup-batch.real.json`, which is in `.gitignore`, or point
`LN_SETUP_BATCH_REAL` at it. The loader checks the copy before using it: its Arbitrator code must hash to the
pinned sha256 of the decoded code (`022c7c77...6aa0b`, `inputs.arbitratorInitCodeSha256`), and apart from that code it must equal
the tracked vector. A copy that fails either check, or an `LN_SETUP_BATCH_REAL` that names no file,
is an error and not a quiet fall back to the stand-in.
To regenerate the real vector, take the generator's output in fresh3 before the stand-in is applied,
or replace each of the 7 stand-ins in the tracked file with the code (from the URL above).

### The licence guard

`test/unit/arbitrator-guard.test.js` (part of `npm test`) fails if any file under `test/`, except
`test/fixtures/private/`, holds any 20-byte window of the real code as 40 hex characters, in any
case and at any character offset. The code is not stored for this: `test/fixtures/guard/arbitrator-window-sha256.json`
holds only the sha256 of each window. Failures name the file, the number of hits and the first offset,
and never print matched text. `test/helpers/make-arbitrator-window-hashes.mjs` writes that list from the
private copy (11 windows that also occur in other fixtures, such as runs of one byte, are left out and
counted in the file). The guard looks only at hex text under `test/`; it does not look at other
encodings or at files outside `test/`.
