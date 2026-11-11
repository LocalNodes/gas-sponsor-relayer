# Mutation run: spend-safety rules (25-28 fix round 2, MEDIUM 7; rounds 3, 4 and 5, and the dedupe round)

Produced by `node scripts/mutate.mjs --markdown` (`npm run mutate` prints the same as a list). Each row breaks one
rule by replacing one exact text in `src/` or `config/` (the `find` and `replace` of each mutation are in
`scripts/mutate.mjs`), runs the whole unit suite (`test/unit/*.test.js`), and restores the file. "Failing tests" is
how many unit tests failed with the mutation in place; the last column names the first of them. A mutation no test
catches would read **SURVIVED** and make the run exit 1.

Run at relayer commit `a1499c1` (branch `dedupe`) with the dedupe-round `scripts/mutate.mjs` (committed with this
file; src as of `dad0742`), 2026-11-11, Node 24, no network.

History:
- Round 2: the first pass over 38 mutations (before `641ae6c`) left M7, M8 and M21 surviving. The holds and checks
  they remove were each also covered by a second layer (the resend hold; the block-contents check), so no test saw
  them alone. `641ae6c` added the tests that do.
- Round 3 added M39 to M79, one per new guard (items #1 to #5 of the round 3 ruling), and moved the `find` of M8,
  M19, M27 and M31 to the round 3 text of the same rules. The first round 3 pass left M69 (the read client's
  receipt trusted without the proof endpoint) surviving: the mutant marked the send confirming and the proof
  endpoint's read sent it straight back to pending, so the test's end state looked right. `ee4b12f` made the test
  check that such a receipt never marks the send confirming. Every later run catches all 79.
- Round 4 added M80 to M91, one per new guard (HIGH 1, HIGH 2, MEDIUM 4 and Flash's two LOWs of the round 4
  ruling), and moved the `find` of M62 (the reorg is now ownIn's 'moved') and M69 (seen now reads `found.hash`).
  The binding then masked M69 in the fake node, which listed a transaction only from the proof endpoint's receipts:
  `10a13a7` lists it from either endpoint's receipt, as a real block does, and the round 3 test catches it again.
  findReceipt's hash check (M80) and ownIn's own-hash check (M81) mask each other in the repros, so each has its own
  guard test (`ae39e8b`). Both full runs of this round catch all 91.
- Round 5 (Codex round 5 INTRODUCED HIGH): `69fa036` stopped the fake node listing a transaction from its receipt,
  so every test states the binding (`inBlock`); that run caught all 91. `2a3f708` (RED) and `25d148f` (GREEN) hold a
  replaced send again at the top of `seen()`, before the binding read, and remove `markConfirming()`'s unreachable
  `reversed` branch. The `find` of M53 (now: holding a replaced send again is not one transaction), M57 (onMined
  before the re-hold is stored) and M67 (the reservation not reopened) moved to the re-hold, and M68's `find` now
  names the reorg's event so it matches once (the re-hold writes the same `sentBlock` text). M92 removes the re-hold.
  The full run catches all 92.

- Dedupe round (orchestrator 2026-11-11): `6196d1f` makes `confirm()` re-read the consumer proof before it settles
  (Codex round-5 re-check MEDIUM); `7235601` makes `finalBlocks()` list only stated inclusions (the LOW). Round-5 Q2
  (b) adds M93 (notify before markConfirming stores confirming), M94-M98 (the re-hold's sentBlock, consumedBy,
  consumedBlock, minedBlockHash and its event) and M99 (the MEDIUM check removed). M97 is equivalent on any row the
  relayer itself writes (`replace()` never sets a block hash), so its test seeds an older row. M57 is now caught by 2
  tests. The full run catches all 99.
- Dedupe round, second half (orchestrator 2026-11-11): M100-M123 cover the code added since `8c2cbfd`: the held reason
  logged once and cleared on a reorg (M100, M101), `needsOperator` (M102, M103), the recheck body (M104), the nonce
  from both pending counts (M105, M106), the watcher's in-flight mark order (M107), the walk cache floor (M108, M109),
  `broadcast: false` at each 502 site (M110-M117: two in the pipeline, three in safe-exec, two in Reality, one in
  ENS), and the duplicate answer of `dad0742` (M118 status, M119 the queue check, M120 and M121 the reservation given
  back, M122 the Safe nonce in the key, M123 the question stored once). Run alone, five survived: M101, M107, M109,
  M115 and M117. Each got the smallest test that catches it (a reorg clears the held reason; a confirming send's walk
  longer than the kept-blocks limit settles; the in-flight mark is written before the bond is stored; a hub error on a
  Reality step is a 502 with `broadcast: false`; an unreadable ENS name check is too). The first full run reported
  M68 and M79 as errors: their `find` no longer matched (the held-reason clear now sits in the reorg, and the walk cache
  is pruned below the lowest unresolved send instead of cleared past a size), so `a1499c1` moved both to the current
  text. No mutation was dropped as equivalent. The full run catches all 123.

Baseline: 330 tests pass, 0 fail. Mutations: 123, caught: 123, survived: 0.

| Id | Item | File | Rule the mutation breaks | Failing tests | Caught by (first failing test) |
|---|---|---|---|---|---|
| M1 | HIGH 1 | `src/chain.js` | the wallet broadcasts through the fallback transport | 2 | broadcast: createChains gives the wallet one endpoint with no retry; reads keep the fallback; proofs read that one endpoint |
| M2 | HIGH 1 | `src/chain.js` | the broadcast endpoint retries | 1 | broadcast: createChains gives the wallet one endpoint with no retry; reads keep the fallback; proofs read that one endpoint |
| M3 | HIGH 1 | `src/queue.js` | an unrecognised broadcast error counts as a refusal | 7 | broadcast: only the node's own JSON-RPC refusal in exact known words counts as refused; anything else is uncertain |
| M4 | HIGH 1 | `src/queue.js` | a refusal is believed without the node's JSON-RPC code | 1 | broadcast: only the node's own JSON-RPC refusal in exact known words counts as refused; anything else is uncertain |
| M5 | HIGH 1 | `src/queue.js` | "already known" is not treated as accepted | 1 | broadcast: only the node's own JSON-RPC refusal in exact known words counts as refused; anything else is uncertain |
| M6 | HIGH 2 | `src/queue.js` | the first broadcast does not hold its row | 3 | serialise: Codex repro: while the first answer is delayed, 12 blocks pass and the poll loop runs: no fee bump is sent |
| M7 | HIGH 2 | `src/queue.js` | the poll loop acts on a row whose broadcast is on its way | 1 | serialise: the poll loop and reconcile leave a row alone while its first answer is outstanding, even with its receipt visible |
| M8 | HIGH 2 | `src/queue.js` | reconcile acts on a row whose broadcast is on its way | 1 | serialise: the poll loop and reconcile leave a row alone while its first answer is outstanding, even with its receipt visible |
| M9 | HIGH 2 | `src/queue.js` | a refusal deletes the row whatever newer state it has | 1 | serialise: Codex repro: a replacement accepted while the original's answer was delayed survives the original's refusal, with the row and the reservation |
| M10 | HIGH 2 | `src/db.js` | the guarded delete ignores the row's newer state | 1 | serialise: Codex repro: a replacement accepted while the original's answer was delayed survives the original's refusal, with the row and the reservation |
| M11 | HIGH 2 | `src/queue.js` | the poll loop acts on the row as it was listed, not as it is | 1 | serialise: a row the poll loop listed, then deleted by its first broadcast's refusal while the loop waited, is never acted on |
| M12 | HIGH 3 | `src/cap.js` | unresolved reservations count only by their own time | 84 | after-broadcast: POST /send/safe-exec: recording the send fails after the broadcast: 202 with the hash, reservation held |
| M13 | HIGH 3 | `src/db.js` | an unresolved reservation counts in the settled-by-time list too | 76 | after-broadcast: pipeline: recording the send fails after the broadcast: still ok, with the hash |
| M14 | HIGH 3 | `src/cap.js` | a bump increase is written back into the old reservation | 2 | cap-windows: each bump increase is its own entry, at the time it was checked; the reservation keeps its own time |
| M15 | HIGH 3 | `src/cap.js` | a bump increase is not checked against the cap | 4 | cap-windows: a bump increase is checked against the current windows, which hold the old unresolved reservation |
| M16 | HIGH 3 | `src/cap.js` | a settled send keeps the time it was reserved | 2 | cap-windows: a send settled after a boundary counts in the window it was settled in, not the one it was reserved in |
| M17 | HIGH 3 | `src/db.js` | release also gives back settled spend | 1 | cap-windows: a released reservation and its increases stop counting; a settled cost is never given back |
| M18 | HIGH 3 | `src/cap.js` | a released or settled reservation can be raised | 1 | cap-windows: only an unresolved reservation can be raised; a released or settled one cannot |
| M19 | HIGH 3 | `src/queue.js` | at boot, reservations of waiting sends are released as orphans | 7 | atomic-settle: releaseOrphans gives back only a reservation no send row holds, whatever the row's status |
| M20 | HIGH 3 | `src/cap.js` | dayResetsAt counts unresolved reservations | 1 | cap-windows: dayResetsAt comes from settled spend only, never from an old unresolved reservation |
| M21 | HIGH 4 | `src/queue.js` | (i) the nonce count at the finalized block is not checked | 1 | release-proof: conflicting or missing reads leave the send unresolved |
| M22 | HIGH 4 | `src/queue.js` | (ii) the consuming transaction may be one of the send's own hashes | 5 | dedupe MEDIUM control: the same own inclusion at 108 with no other consumer settles to the real cost |
| M23 | HIGH 4 | `src/queue.js` | (ii) the search ignores the first broadcast block | 1 | release-proof: conflicting or missing reads leave the send unresolved |
| M24 | HIGH 4 | `src/queue.js` | (ii) the transaction found need not be from the relayer | 1 | release-proof: conflicting or missing reads leave the send unresolved |
| M25 | HIGH 4 | `src/queue.js` | (i) the proof reads the latest block, not the finalized one | 24 | atomic-settle: Codex repro: 1,000 reserved at caps of 1,000, the settlement fails, boot: the real cost is charged and no second 1,000 fits |
| M26 | HIGH 4 | `src/queue.js` | (iii) the proof reads the fallback client | 54 | atomic-settle: Codex repro: 1,000 reserved at caps of 1,000, the settlement fails, boot: the real cost is charged and no second 1,000 fits |
| M27 | HIGH 4 | `src/queue.js` | (v) replaced sends are no longer looked up | 10 | atomic-settle: a crash while a replaced send whose own receipt appeared is held again leaves it as it was; the next pass holds it once |
| M28 | HIGH 4 | `src/db.js` | (v) a late receipt does not undo a release | 10 | atomic-settle: a crash between any two steps of a settlement leaves nothing half done; the next pass settles it once |
| M29 | HIGH 4 | `src/queue.js` | receipts "not found" release the send (the old rule) | 43 | atomic-settle: a crash between any two steps of a settlement leaves nothing half done; the next pass settles it once |
| M30 | HIGH 4 | `src/server.js` | (vi) GET /sends/:hash shows a replaced send as pending | 1 | release-proof: GET /sends/:hash answers pending, then not_sent with the consuming hash; any of the send's hashes finds it; unknown is 404 |
| M31 | MEDIUM 6 | `src/queue.js` | reconcile leaves stuck sends out | 2 | release-proof: at boot, a stuck send the node lost is sent again as its last signed replacement, and keeps its reservation |
| M32 | MEDIUM 5 | `src/sends/pipeline.js` | pipeline: a recordSend failure after the broadcast fails the send | 2 | after-broadcast: pipeline: recording the send fails after the broadcast: still ok, with the hash |
| M33 | MEDIUM 5 | `src/sends/safeExec.js` | safe-exec: a recordSend failure after the broadcast is a 500 | 1 | after-broadcast: POST /send/safe-exec: recording the send fails after the broadcast: 202 with the hash, reservation held |
| M34 | MEDIUM 5 | `src/sends/reality.js` | reality: a failure after the broadcast is 502 read_failed | 1 | after-broadcast: POST /send/reality/answer: storing the question fails after the broadcast: 202 with the hash, not 502 read_failed |
| M35 | MEDIUM 5 | `src/sends/ens.js` | ens: a recordSend failure after the broadcast fails the job | 1 | ens: recording a send fails after its broadcast: the job goes on and keeps the hash (25-28 round 2, MEDIUM 5) |
| M36 | fix A | `src/queue.js` | a fee bump is sent without extending the reservation | 6 | atomic-settle: a crash while a replaced send whose own receipt appeared is held again leaves it as it was; the next pass holds it once |
| M37 | fix A | `src/queue.js` | the row is stored after the broadcast, not before | 130 | after-broadcast: POST /send/safe-exec: recording the send fails after the broadcast: 202 with the hash, reservation held |
| M38 | fix A | `src/sends/pipeline.js` | the reservation is given back after a send that may be live | 9 | after-broadcast: pipeline: recording the send fails after the broadcast: still ok, with the hash |
| M39 | round 3 #4 | `config/networks.json` | Base Sepolia is sponsored again (the config flag is gone) | 2 | not-sponsored: config/networks.json turns sponsoring off for 84532 only; chain.js marks its clients |
| M40 | round 3 #4 | `src/config.js` | chainIsSponsored ignores "sponsoring": false | 4 | not-sponsored: config/networks.json turns sponsoring off for 84532 only; chain.js marks its clients |
| M41 | round 3 #4 | `src/chain.js` | chain.js marks every configured chain sponsored | 1 | not-sponsored: config/networks.json turns sponsoring off for 84532 only; chain.js marks its clients |
| M42 | round 3 #4 | `src/queue.js` | the queue signs and sends on a chain not sponsored | 1 | not-sponsored: the queue itself refuses a send on a chain that is not sponsored, before signing |
| M43 | round 3 #4 | `src/sends/pipeline.js` | the pipeline reserves on a chain not sponsored | 1 | not-sponsored: the pipeline (Reality steps, reclaim, the watcher's challenge) refuses before the reservation |
| M44 | round 3 #4 | `src/sends/safeExec.js` | safe-exec reserves on a chain not sponsored | 1 | not-sponsored: POST /send/safe-exec on 84532 is 503 chain_not_sponsored before any reservation, estimate or broadcast |
| M45 | round 3 #4 | `src/sends/reality.js` | the Reality routes run on a chain not sponsored | 1 | not-sponsored: POST /send/reality/* on a chain that is not sponsored is 503 chain_not_sponsored, nothing read or sent |
| M46 | round 3 #4 | `src/sends/ens.js` | ENS starts a job on a chain not sponsored | 1 | not-sponsored: POST /send/ens on a chain with ENS but sponsoring off is 503 chain_not_sponsored, no job |
| M47 | round 3 #5 | `src/db.js` | nonce allocation forgets stuck sends | 1 | nonce-binding: Codex repro: a stuck send the node forgot keeps nonce 5; the next send gets 6, not 5 |
| M48 | round 3 #5 | `src/sends/pipeline.js` | pipeline.waitMined takes the newest row at the nonce | 2 | nonce-binding: Codex repro: sends A and B both at nonce 5, B mined: waitMined(A) never returns B's receipt |
| M49 | round 3 #5 | `src/sends/ens.js` | the ENS job's waiter takes the newest row at the nonce | 1 | ens: round 3 \#5, Codex repro: another send at the same nonce mined; the job never takes its receipt for its own step |
| M50 | round 3 #5 | `src/sends/pipeline.js` | a waiter does not follow its own send's fee bumps | 1 | nonce-binding: waitMined follows the send's own fee bumps (its row's hashes), whatever its nonce now holds |
| M51 | round 3 #1 | `src/queue.js` | a settlement is not one transaction | 1 | atomic-settle: a crash between any two steps of a settlement leaves nothing half done; the next pass settles it once |
| M52 | round 3 #1 | `src/queue.js` | a release is not one transaction | 1 | atomic-settle: a crash between the steps of a release leaves the send unresolved with its reservation; the next pass releases it once |
| M53 | round 3 #1 | `src/queue.js` | holding a replaced send again is not one transaction | 1 | atomic-settle: a crash while a replaced send whose own receipt appeared is held again leaves it as it was; the next pass holds it once |
| M54 | round 3 #1 | `src/queue.js` | going back on a reorg is not one transaction | 1 | atomic-settle: a crash while a reorged send goes back to pending leaves it confirming with its maximum; the next pass moves it once |
| M55 | round 3 #1 | `src/queue.js` | boot releases a reservation held by a mined or replaced row (only pending and stuck rows hold one) | 1 | finality: reconcile at boot keeps a confirming send, never rebroadcasts it, and settles it once final |
| M56 | round 3 #1 | `src/queue.js` | boot does not recover a mined or replaced row with an open reservation | 3 | atomic-settle: at boot a mined row with an open reservation is settled from its receipt |
| M57 | round 3 #1 | `src/queue.js` | onMined runs before the change is stored (a replaced send held again) | 2 | atomic-settle: a crash while a replaced send whose own receipt appeared is held again leaves it as it was; the next pass holds it once |
| M58 | round 3 #2 | `src/queue.js` | a receipt settles at once (the old rule) | 27 | atomic-settle: a crash between any two steps of a settlement leaves nothing half done; the next pass settles it once |
| M59 | round 3 #2 | `src/queue.js` | a confirming send settles before its block is finalized | 20 | atomic-settle: a crash between any two steps of a settlement leaves nothing half done; the next pass settles it once |
| M60 | round 3 #2 | `src/queue.js` | a receipt that is gone is not a reorg | 7 | atomic-settle: a crash while a reorged send goes back to pending leaves it confirming with its maximum; the next pass moves it once |
| M61 | round 3 #2 | `src/queue.js` | a receipt that names another block is not a reorg | 1 | finality: the receipt is read again on the proof endpoint; a reorg in any form puts the send back to pending with its maximum |
| M62 | round 3 #2 | `src/queue.js` | another block at the receipt's height is not a reorg | 1 | finality: the receipt is read again on the proof endpoint; a reorg in any form puts the send back to pending with its maximum |
| M63 | round 3 #2 | `src/queue.js` | a receipt block off the finalized chain settles anyway | 1 | finality: the receipt is read again on the proof endpoint; a reorg in any form puts the send back to pending with its maximum |
| M64 | round 3 #2 | `src/queue.js` | the poll loop leaves confirming sends out | 14 | atomic-settle: a crash between any two steps of a settlement leaves nothing half done; the next pass settles it once |
| M65 | round 3 #2 | `src/queue.js` | reconcile rebroadcasts a confirming send | 2 | finality: reconcile at boot keeps a confirming send, never rebroadcasts it, and settles it once final |
| M66 | round 3 #2 | `src/db.js` | nonce allocation forgets confirming sends | 1 | finality: a confirming send keeps its nonce: the next send never takes it |
| M67 | round 3 #2 | `src/queue.js` | a replaced send whose receipt appears is not held again | 9 | atomic-settle: a crash while a replaced send whose own receipt appeared is held again leaves it as it was; the next pass holds it once |
| M68 | round 3 #2 | `src/queue.js` | the bump timer does not restart after a reorg | 2 | finality: a send back to pending after a reorg is not bumped at once: its bump timer starts again at the head |
| M69 | round 3 #2 | `src/queue.js` | the read client's receipt is trusted without the proof endpoint | 2 | finality: a receipt only the read client has (the proof endpoint has none yet) changes nothing, and the send is not bumped |
| M70 | round 3 #2 | `src/server.js` | GET /sends/:hash says finalized for a confirming send | 1 | finality: GET /sends/:hash says mined with finalized false while it waits, then finalized true |
| M71 | round 3 #2 | `src/server.js` | GET /sends/:hash shows a confirming send as pending | 1 | finality: GET /sends/:hash says mined with finalized false while it waits, then finalized true |
| M72 | round 3 #3 | `src/queue.js` | the consuming block need not be on the finalized chain | 7 | proof-binding: Codex repro: finalized block 105 is hash A holding our own transaction; block 105 read by number is hash B holding another at nonce 5: nothing is released |
| M73 | round 3 #3 | `src/queue.js` | the consuming transaction need not name its block | 1 | proof-binding: the consuming transaction must report the consuming block as its own |
| M74 | round 3 #3 | `src/queue.js` | our own receipt need not name the consuming block | 1 | proof-binding: our own transaction in the consuming block settles only from a receipt that names that block |
| M75 | round 3 #3 | `src/queue.js` | the finalized hash is not pinned (the walk starts from the block it checks) | 45 | atomic-settle: a crash between any two steps of a settlement leaves nothing half done; the next pass settles it once |
| M76 | round 3 #3 | `src/queue.js` | a block read by hash need not be the block asked for | 1 | proof-binding: a block read by hash must be the block asked for, at the height expected |
| M77 | round 3 #3 | `src/queue.js` | a block read by hash need not be at the height expected | 2 | proof-binding: a block read by hash must be the block asked for, at the height expected |
| M78 | round 3 #3 | `src/queue.js` | the walk has no budget per pass | 1 | proof-binding: a walk longer than one pass's budget goes on in the next pass from where it stopped |
| M79 | round 3 #3 | `src/queue.js` | blocks read by hash are not kept between passes | 3 | dedupe walk: a confirming send settles through a walk longer than the kept-blocks limit, over several passes |
| M80 | round 4 #1 | `src/queue.js` | findReceipt takes a receipt of another transaction and follows its hash | 1 | round 4 HIGH 1: a receipt of another transaction is no answer: the proof still releases a send another transaction replaced |
| M81 | round 4 #1 | `src/queue.js` | the binding accepts a hash that is not one of the send's own | 1 | round 4 HIGH 1: a confirming row whose stored hash is not one of its own (a damaged database) never settles |
| M82 | round 4 #1 | `src/queue.js` | the block need not list the transaction (exactly once) | 4 | round 4 HIGH 1: Codex repro: our own transaction is in finalized block 103, its receipt names canonical block 104 for 1 wei: nothing settles, and no second 999 fits |
| M83 | round 4 #1 | `src/queue.js` | the listed transaction need not name the block's hash | 1 | round 4 HIGH 1: the transaction listed in the block must name that block, by hash and by height |
| M84 | round 4 #1 | `src/queue.js` | the listed transaction need not name the block's height | 1 | round 4 HIGH 1: the transaction listed in the block must name that block, by hash and by height |
| M85 | round 4 #1 | `src/queue.js` | seen() marks confirming without the binding | 6 | dedupe Q2 (M97): a replaced row that still carries a block hash (an older database) has it cleared when held again |
| M86 | round 4 #1 | `src/queue.js` | confirm() settles a send whose block and receipt disagree about the transaction | 2 | round 4 HIGH 1: a confirming send whose block no longer lists its transaction (the same block hash) does not settle at finality |
| M87 | round 4 #2 | `src/queue.js` | reconcile rebroadcasts a stored send on a chain not sponsored | 1 | round 4 HIGH 2: Codex repro: a stored send, then the chain is not sponsored: no rebroadcast at boot, no fee bump, the reservation stays 1,000; its receipt still settles it |
| M88 | round 4 #2 | `src/queue.js` | the poll loop bumps a stored send on a chain not sponsored | 1 | round 4 HIGH 2: Codex repro: a stored send, then the chain is not sponsored: no rebroadcast at boot, no fee bump, the reservation stays 1,000; its receipt still settles it |
| M89 | round 4 MEDIUM 4 | `src/queue.js` | a block read by hash at the wrong height is kept | 1 | round 4 MEDIUM 4: Codex repro: one wrong-height answer to a read by hash, then correct ones: the proof completes |
| M90 | round 4 LOW 1 | `src/queue.js` | reconcile gives resolve no head (a reorg found at boot keeps the old bump timer) | 1 | round 4 LOW 1: a confirming send found reorged at boot waits a full bump interval from the boot head |
| M91 | round 4 LOW 2 | `src/queue.js` | boot recovery keeps the recovered row's block hash | 1 | round 4 LOW 2: boot recovery clears the recovered row's block hash |
| M92 | round 5 HIGH | `src/queue.js` | a replaced send whose own receipt appears is not held again before the binding read (the re-hold removed) | 9 | atomic-settle: a crash while a replaced send whose own receipt appeared is held again leaves it as it was; the next pass holds it once |
| M93 | dedupe Q2 | `src/queue.js` | onMined runs before markConfirming stores confirming | 1 | dedupe Q2: markConfirming stores confirming before onMined runs |
| M94 | dedupe Q2 | `src/queue.js` | the re-hold keeps the old sentBlock (the bump timer does not restart) | 1 | round 5: a replaced send with a bound late receipt is held again, then confirming, and at finality stays held against the finalized OTHER (dedupe MEDIUM) |
| M95 | dedupe Q2 | `src/queue.js` | the re-hold keeps the consuming hash | 2 | round 5: a replaced send whose late own-hash receipt is not bound to its block is held again at 1,000 and never settled |
| M96 | dedupe Q2 | `src/queue.js` | the re-hold keeps the consuming block | 2 | round 5: a replaced send whose late own-hash receipt is not bound to its block is held again at 1,000 and never settled |
| M97 | dedupe Q2 | `src/queue.js` | the re-hold keeps the block hash | 1 | dedupe Q2 (M97): a replaced row that still carries a block hash (an older database) has it cleared when held again |
| M98 | dedupe Q2 | `src/queue.js` | the re-hold writes no send_release_reversed event | 6 | atomic-settle: a crash while a replaced send whose own receipt appeared is held again leaves it as it was; the next pass holds it once |
| M99 | dedupe MEDIUM | `src/queue.js` | confirm() settles an own inclusion that contradicts the finalized consumer | 7 | dedupe MEDIUM: OTHER takes nonce 5 at 103, the own hash shows at 108; at finality the send does not settle and 1,000 stays held |
| M100 | dedupe | `src/queue.js` | a send held on conflicting evidence is logged on every pass, not once | 1 | dedupe ops: a send held on conflicting evidence logs one line however many passes see it, and is listed with a plain reason |
| M101 | dedupe | `src/queue.js` | a reorg leaves the held reason on a send that goes back to pending | 1 | dedupe ops: a held send that goes back to pending on a reorg no longer carries its held reason |
| M102 | dedupe | `src/queue.js` | needsOperator leaves out stuck sends | 2 | ops routes: GET /ops/recheck lists, POST /ops/recheck takes only a hash and answers what the chain says |
| M103 | dedupe | `src/queue.js` | needsOperator leaves out sends held on conflicting evidence | 2 | dedupe ops: a send held on conflicting evidence logs one line however many passes see it, and is listed with a plain reason |
| M104 | dedupe | `src/server.js` | the recheck body may carry keys besides hash | 1 | ops routes: GET /ops/recheck lists, POST /ops/recheck takes only a hash and answers what the chain says |
| M105 | dedupe | `src/queue.js` | the nonce takes only the proof endpoint's pending count | 2 | cap: integer math only, no floating point in cap.js or queue.js |
| M106 | dedupe | `src/queue.js` | the nonce takes only the fallback's pending count | 2 | cap: integer math only, no floating point in cap.js or queue.js |
| M107 | dedupe | `src/watcher.js` | the challenge's in-flight mark is written after the question is stored | 1 | watcher: the in-flight mark is written before the challenge's bond is stored (25-28 dedupe, round-2 Q6) |
| M108 | dedupe | `src/queue.js` | the walk cache prune deletes blocks above the floor | 2 | dedupe walk: a confirming send settles through a walk longer than the kept-blocks limit, over several passes |
| M109 | dedupe | `src/queue.js` | the walk cache floor ignores confirming sends | 1 | dedupe walk: a confirming send settles through a walk longer than the kept-blocks limit, over several passes |
| M110 | dedupe | `src/sends/pipeline.js` | pipeline: the fee estimate 502 loses broadcast false | 1 | broadcast-flag: pipeline, the fee estimate fails: 502 with broadcast false |
| M111 | dedupe | `src/sends/pipeline.js` | pipeline: the enqueue 502 loses broadcast false | 1 | broadcast-flag: pipeline, the node refuses the send: 502 with broadcast false, nothing held |
| M112 | dedupe | `src/sends/safeExec.js` | safe-exec: the unreadable Safe nonce 502 loses broadcast false | 1 | duplicate: the Safe nonce cannot be read: 502 safe_nonce_unreadable with broadcast false, nothing reserved or sent |
| M113 | dedupe | `src/sends/safeExec.js` | safe-exec: the fee estimate 502 loses broadcast false | 1 | broadcast-flag: safe-exec, the fee estimate fails: 502 with broadcast false, nothing sent or held |
| M114 | dedupe | `src/sends/safeExec.js` | safe-exec: the enqueue 502 loses broadcast false | 1 | broadcast-flag: safe-exec, the node refuses the send: 502 with broadcast false, nothing held |
| M115 | dedupe | `src/sends/reality.js` | reality: a hub error 502 loses broadcast false | 1 | broadcast-flag: reality, the hub cannot be read: 502 with broadcast false |
| M116 | dedupe | `src/sends/reality.js` | reality: the read_failed 502 loses broadcast false | 1 | after-broadcast: POST /send/reality/answer: a read that fails before any broadcast is still 502 read_failed, and nothing is sent |
| M117 | dedupe | `src/sends/ens.js` | ens: the availability_unreadable 502 loses broadcast false | 1 | broadcast-flag: ens, the name availability cannot be read: 502 with broadcast false, nothing sent |
| M118 | dedupe | `src/db.js` | the duplicate check ignores status, so a replaced send counts as a duplicate | 1 | duplicate: a replaced row with the key never happened: a new send goes out and carries the key |
| M119 | dedupe | `src/queue.js` | the duplicate check is removed from the queue | 9 | duplicate: two requests with the same Safe nonce: the second is 202 duplicate with the first hash, one transaction, one reservation |
| M120 | dedupe | `src/sends/pipeline.js` | pipeline: a duplicate does not give its reservation back | 5 | duplicate: two concurrent pipeline sends with one dedupeKey: exactly one broadcast, one reservation held |
| M121 | dedupe | `src/sends/safeExec.js` | safe-exec: a duplicate does not give its reservation back | 1 | duplicate: two requests with the same Safe nonce: the second is 202 duplicate with the first hash, one transaction, one reservation |
| M122 | dedupe | `src/sends/safeExec.js` | safe-exec: the dedupe key ignores the Safe nonce | 1 | duplicate: a different Safe nonce is a new send |
| M123 | dedupe | `src/sends/reality.js` | reality: a duplicate answer stores the question again | 1 | duplicate: a duplicate answer does not store the question again |
