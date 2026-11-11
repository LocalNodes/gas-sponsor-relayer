#!/usr/bin/env node
// Reproducible mutation run for the spend-safety rules (25-28 fix round 2, MEDIUM 7; extended in rounds 3, 4 and 5 and the dedupe round).
//
// Each mutation breaks one rule by replacing one exact piece of a file under src/. The runner applies it, runs the
// whole unit suite, records which tests failed, and puts the file back before the next one, also when a run fails
// or is interrupted. A mutation no test catches is reported as SURVIVED and makes the exit code 1.
// No git command is used and nothing outside the mutated file is written.
//
//   node scripts/mutate.mjs              run every mutation, print a summary
//   node scripts/mutate.mjs --markdown   the same, printed as the table in test/MUTATIONS.md
//   node scripts/mutate.mjs --only M7    one mutation
//   node scripts/mutate.mjs --list       list the mutations without running them
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** id, file, rule (what the mutation breaks), find (must occur exactly once), replace. */
export const MUTATIONS = [
  // HIGH 1: one endpoint, one attempt; only an exact refusal deletes a row.
  { id: 'M1', item: 'HIGH 1', file: 'src/chain.js', rule: 'the wallet broadcasts through the fallback transport',
    find: 'transport: http(urls[0], { retryCount: 0 }) })', replace: 'transport })' },
  { id: 'M2', item: 'HIGH 1', file: 'src/chain.js', rule: 'the broadcast endpoint retries',
    find: 'http(urls[0], { retryCount: 0 })', replace: 'http(urls[0])' },
  { id: 'M3', item: 'HIGH 1', file: 'src/queue.js', rule: 'an unrecognised broadcast error counts as a refusal',
    find: "  if (answer && REFUSALS.some((r) => r.test(String(answer.details ?? '').trim()))) return 'refused';\n  return 'uncertain';",
    replace: "  if (answer && REFUSALS.some((r) => r.test(String(answer.details ?? '').trim()))) return 'refused';\n  return 'refused';" },
  { id: 'M4', item: 'HIGH 1', file: 'src/queue.js', rule: 'a refusal is believed without the node\'s JSON-RPC code',
    find: "x?.name === 'RpcRequestError' && x.code === REFUSAL_CODE", replace: "x?.name === 'RpcRequestError'" },
  { id: 'M5', item: 'HIGH 1', file: 'src/queue.js', rule: '"already known" is not treated as accepted',
    find: "if (list.some((x) => KNOWN.test(text(x)))) return 'accepted';", replace: '' },
  // HIGH 2: one broadcast at a time per row.
  { id: 'M6', item: 'HIGH 2', file: 'src/queue.js', rule: 'the first broadcast does not hold its row',
    find: '    busy.add(id);\n    try {\n      await clients.walletClient.sendRawTransaction', replace: '    try {\n      await clients.walletClient.sendRawTransaction' },
  { id: 'M7', item: 'HIGH 2', file: 'src/queue.js', rule: 'the poll loop acts on a row whose broadcast is on its way',
    find: '            if (busy.has(listed.id)) continue;\n', replace: '' },
  { id: 'M8', item: 'HIGH 2', file: 'src/queue.js', rule: 'reconcile acts on a row whose broadcast is on its way',
    find: "if (!row || busy.has(row.id) || !waiting(row.status)) continue;",
    replace: "if (!row || !waiting(row.status)) continue;" },
  { id: 'M9', item: 'HIGH 2', file: 'src/queue.js', rule: 'a refusal deletes the row whatever newer state it has',
    find: "if (outcome === 'refused' && db.deleteUntouchedPending(id, hash)) throw e;",
    replace: "if (outcome === 'refused') { db.deletePending(id); throw e; }" },
  { id: 'M10', item: 'HIGH 2', file: 'src/db.js', rule: 'the guarded delete ignores the row\'s newer state',
    find: "DELETE FROM pending WHERE id = ? AND status = 'pending' AND attempts = 0 AND hash = ? AND hashes = ?",
    replace: 'DELETE FROM pending WHERE id = ? AND ? IS NOT NULL AND ? IS NOT NULL' },
  { id: 'M11', item: 'HIGH 2', file: 'src/queue.js', rule: 'the poll loop acts on the row as it was listed, not as it is',
    find: '            const row = db.getPending(listed.id);\n            if (!row || row.status !== listed.status) continue;',
    replace: '            const row = listed;' },
  // HIGH 3: unresolved reservations count in the current windows.
  { id: 'M12', item: 'HIGH 3', file: 'src/cap.js', rule: 'unresolved reservations count only by their own time',
    find: 'const open = db.openSpend().reduce((s, e) => s + e.wei, 0n);', replace: 'const open = 0n;' },
  { id: 'M13', item: 'HIGH 3', file: 'src/db.js', rule: 'an unresolved reservation counts in the settled-by-time list too',
    find: "FROM spend WHERE at >= ? AND state = 'settled' ORDER BY at, id", replace: "FROM spend WHERE at >= ? AND state != 'released' ORDER BY at, id" },
  { id: 'M14', item: 'HIGH 3', file: 'src/cap.js', rule: 'a bump increase is written back into the old reservation',
    find: "db.insertSpend({ chainId: entry.chainId, at: w.t, wei: wei - held, kind: 'send', ref: `${entry.ref}:bump`, state: 'open', parentId: id });",
    replace: 'db.updateSpendWei(id, entry.wei + (wei - held));' },
  { id: 'M15', item: 'HIGH 3', file: 'src/cap.js', rule: 'a bump increase is not checked against the cap',
    find: '      refuseOver(w, chainId ?? entry.chainId, wei - held);\n', replace: '' },
  { id: 'M16', item: 'HIGH 3', file: 'src/cap.js', rule: 'a settled send keeps the time it was reserved',
    find: 'db.settleSpend(entry.id, wei, now());', replace: 'db.settleSpend(entry.id, wei, db.getSpend(entry.id).at);' },
  { id: 'M17', item: 'HIGH 3', file: 'src/db.js', rule: 'release also gives back settled spend',
    find: "UPDATE spend SET state = 'released' WHERE (id = ? OR parent_id = ?) AND state = 'open'",
    replace: "UPDATE spend SET state = 'released' WHERE (id = ? OR parent_id = ?)" },
  { id: 'M18', item: 'HIGH 3', file: 'src/cap.js', rule: 'a released or settled reservation can be raised',
    find: "if (!entry || entry.state !== 'open') throw new Error('reservation_missing');", replace: "if (!entry) throw new Error('reservation_missing');" },
  { id: 'M19', item: 'HIGH 3', file: 'src/queue.js', rule: 'at boot, reservations of waiting sends are released as orphans',
    find: "if (e.parentId !== null || held.has(e.id)) continue;",
    replace: "if (e.parentId !== null) continue;" },
  { id: 'M20', item: 'HIGH 3', file: 'src/cap.js', rule: 'dayResetsAt counts unresolved reservations',
    find: '    const oldest = w.day.find((e) => e.kind !== \'credit\');', replace: "    const oldest = [...db.openSpend(), ...w.day].find((e) => e.kind !== 'credit');" },
  // HIGH 4 and MEDIUM 6: release only on proof of the consuming transaction.
  { id: 'M21', item: 'HIGH 4', file: 'src/queue.js', rule: '(i) the nonce count at the finalized block is not checked',
    find: '          if (!(f.count > nonce)) return null;\n', replace: '' },
  { id: 'M22', item: 'HIGH 4', file: 'src/queue.js', rule: '(ii) the consuming transaction may be one of the send\'s own hashes',
    find: 'if (!row.hashes.some((h) => same(h, hash))) return { hash, block: lo, own: false };', replace: 'return { hash, block: lo, own: false };' },
  { id: 'M23', item: 'HIGH 4', file: 'src/queue.js', rule: '(ii) the search ignores the first broadcast block',
    find: '          if (first > 0n && (await countAt(first - 1n)) > nonce) return null;\n', replace: '' },
  { id: 'M24', item: 'HIGH 4', file: 'src/queue.js', rule: '(ii) the transaction found need not be from the relayer',
    find: "typeof t === 'object' && same(t.from, address) && BigInt(t.nonce) === nonce", replace: "typeof t === 'object' && BigInt(t.nonce) === nonce" },
  { id: 'M25', item: 'HIGH 4', file: 'src/queue.js', rule: '(i) the proof reads the latest block, not the finalized one',
    find: "reader.getBlock({ blockTag: 'finalized' })", replace: "reader.getBlock({ blockTag: 'latest' })" },
  { id: 'M26', item: 'HIGH 4', file: 'src/queue.js', rule: '(iii) the proof reads the fallback client',
    find: 'const readerOf = (clients) => clients.proofClient ?? clients.publicClient;', replace: 'const readerOf = (clients) => clients.publicClient;' },
  { id: 'M27', item: 'HIGH 4', file: 'src/queue.js', rule: '(v) replaced sends are no longer looked up',
    find: "r.status === 'pending' || r.status === 'stuck' || r.status === 'replaced' || r.status === 'confirming');",
    replace: "r.status === 'pending' || r.status === 'stuck' || r.status === 'confirming');" },
  { id: 'M28', item: 'HIGH 4', file: 'src/db.js', rule: '(v) a late receipt does not undo a release',
    find: "UPDATE spend SET wei = ?, at = ?, state = 'settled' WHERE id = ?", replace: 'UPDATE spend SET wei = ?, at = ? WHERE id = ?' },
  { id: 'M29', item: 'HIGH 4', file: 'src/queue.js', rule: 'receipts "not found" release the send (the old rule)',
    find: '    const c = await proof.consumer(row);\n    if (c === null) return null;',
    replace: "    const c = found.unclear ? null : { hash: 'unknown', block: 0n, own: false };\n    if (c === null) return null;" },
  { id: 'M30', item: 'HIGH 4', file: 'src/server.js', rule: '(vi) GET /sends/:hash shows a replaced send as pending',
    find: "row.status === 'replaced' ? 'not_sent' : 'pending'", replace: "'pending'" },
  { id: 'M31', item: 'MEDIUM 6', file: 'src/queue.js', rule: 'reconcile leaves stuck sends out',
    find: "const waiting = (s) => s === 'pending' || s === 'stuck' || s === 'confirming';",
    replace: "const waiting = (s) => s === 'pending' || s === 'confirming';" },
  // MEDIUM 5: 202 with the hash after a broadcast.
  { id: 'M32', item: 'MEDIUM 5', file: 'src/sends/pipeline.js', rule: 'pipeline: a recordSend failure after the broadcast fails the send',
    find: 'logger.error(`recording sent ${kind}', replace: 'throw e; logger.error(`recording sent ${kind}' },
  { id: 'M33', item: 'MEDIUM 5', file: 'src/sends/safeExec.js', rule: 'safe-exec: a recordSend failure after the broadcast is a 500',
    find: 'logger.error(`recording sent safe-exec', replace: 'throw e; logger.error(`recording sent safe-exec' },
  { id: 'M34', item: 'MEDIUM 5', file: 'src/sends/reality.js', rule: 'reality: a failure after the broadcast is 502 read_failed',
    find: '      if (out) {\n', replace: '      if (false) {\n' },
  { id: 'M35', item: 'MEDIUM 5', file: 'src/sends/ens.js', rule: 'ens: a recordSend failure after the broadcast fails the job',
    find: 'logger.error(`recording ens ${name}', replace: 'throw e; logger.error(`recording ens ${name}' },
  // Fix A rules this round keeps.
  { id: 'M36', item: 'fix A', file: 'src/queue.js', rule: 'a fee bump is sent without extending the reservation',
    find: '                cap.extend(row.spendId, BigInt(row.gas) * fees.maxFeePerGas + BigInt(row.value), chainId);\n', replace: '' },
  { id: 'M37', item: 'fix A', file: 'src/queue.js', rule: 'the row is stored after the broadcast, not before',
    find: '    // Held from the insert on (no await between), so the poll loop never sees this row without the hold.\n    busy.add(id);\n    try {\n      await clients.walletClient.sendRawTransaction({ serializedTransaction });',
    replace: '    busy.add(id);\n    db.deletePending(id);\n    try {\n      await clients.walletClient.sendRawTransaction({ serializedTransaction });' },
  { id: 'M38', item: 'fix A', file: 'src/sends/pipeline.js', rule: 'the reservation is given back after a send that may be live',
    find: "      logger.info(`sent ${kind} ${chainId} ${safe} ${sent.hash}`);", replace: "      cap.release(reservation);\n      logger.info(`sent ${kind} ${chainId} ${safe} ${sent.hash}`);" },
  // Round 3 (Codex round 3 HIGH 1 to 4, MEDIUM 5; the orchestrator's ruling): one mutation per new guard.
  { id: "M39", item: "round 3 #4", file: "config/networks.json", rule: "Base Sepolia is sponsored again (the config flag is gone)",
    find: "    \"sponsoring\": false,\n", replace: "" },
  { id: "M40", item: "round 3 #4", file: "src/config.js", rule: "chainIsSponsored ignores \"sponsoring\": false",
    find: " && networks[String(chainId)].sponsoring !== false;", replace: ";" },
  { id: "M41", item: "round 3 #4", file: "src/chain.js", rule: "chain.js marks every configured chain sponsored",
    find: "sponsored: chainIsSponsored(networks, chainId),", replace: "sponsored: true," },
  { id: "M42", item: "round 3 #4", file: "src/queue.js", rule: "the queue signs and sends on a chain not sponsored",
    find: "    if (clients.sponsored === false) throw new Error('chain_not_sponsored');\n", replace: "" },
  { id: "M43", item: "round 3 #4", file: "src/sends/pipeline.js", rule: "the pipeline reserves on a chain not sponsored",
    find: "      if (clients.sponsored === false) return { ok: false, status: 503, body: { ...NOT_SPONSORED } };\n", replace: "" },
  { id: "M44", item: "round 3 #4", file: "src/sends/safeExec.js", rule: "safe-exec reserves on a chain not sponsored",
    find: "  if (!chainIsSponsored(networks, tx.chainId)) return { status: 503, body: { ...NOT_SPONSORED } };\n", replace: "" },
  { id: "M45", item: "round 3 #4", file: "src/sends/reality.js", rule: "the Reality routes run on a chain not sponsored",
    find: "    if (!chainIsSponsored(networks, v.chainId)) return { err: reply(503, { ...NOT_SPONSORED }) };\n", replace: "" },
  { id: "M46", item: "round 3 #4", file: "src/sends/ens.js", rule: "ENS starts a job on a chain not sponsored",
    find: "      if (!chainIsSponsored(networks, chainId)) return { status: 503, body: { ...NOT_SPONSORED } };\n", replace: "" },
  { id: "M47", item: "round 3 #5", file: "src/db.js", rule: "nonce allocation forgets stuck sends",
    find: "status IN ('pending', 'stuck', 'confirming')\");", replace: "status IN ('pending', 'confirming')\");" },
  { id: "M48", item: "round 3 #5", file: "src/sends/pipeline.js", rule: "pipeline.waitMined takes the newest row at the nonce",
    find: "[...ownHashes(db, sent)]", replace: "[...(db.listPending().filter((r) => r.chainId === Number(chainId) && r.nonce === sent.nonce).at(-1)?.hashes ?? [sent.hash])]" },
  { id: "M49", item: "round 3 #5", file: "src/sends/ens.js", rule: "the ENS job's waiter takes the newest row at the nonce",
    find: "[...ownHashes(db, sent)]", replace: "[...(db.listPending().filter((r) => r.chainId === Number(chainId) && r.nonce === sent.nonce).at(-1)?.hashes ?? [sent.hash])]" },
  { id: "M50", item: "round 3 #5", file: "src/sends/pipeline.js", rule: "a waiter does not follow its own send's fee bumps",
    find: "return db.findPendingByHash(sent.hash)?.hashes ?? [sent.hash];", replace: "return [sent.hash];" },
  { id: "M51", item: "round 3 #1", file: "src/queue.js", rule: "a settlement is not one transaction",
    find: "    db.atomically(() => {\n      db.updatePending(row.id, { ...row, status: 'mined'", replace: "    ((f) => f())(() => {\n      db.updatePending(row.id, { ...row, status: 'mined'" },
  { id: "M52", item: "round 3 #1", file: "src/queue.js", rule: "a release is not one transaction",
    find: "    db.atomically(() => {\n      db.updatePending(row.id, { ...row, status: 'replaced'", replace: "    ((f) => f())(() => {\n      db.updatePending(row.id, { ...row, status: 'replaced'" },
  { id: "M53", item: "round 3 #1", file: "src/queue.js", rule: "holding a replaced send again is not one transaction",
    find: "      db.atomically(() => {\n        if (row.spendId !== null) db.reopenSpend", replace: "      ((f) => f())(() => {\n        if (row.spendId !== null) db.reopenSpend" },
  { id: "M54", item: "round 3 #1", file: "src/queue.js", rule: "going back on a reorg is not one transaction",
    find: "    db.atomically(() => {\n      db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null", replace: "    ((f) => f())(() => {\n      db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null" },
  { id: "M55", item: "round 3 #1", file: "src/queue.js", rule: "boot releases a reservation held by a mined or replaced row (only pending and stuck rows hold one)",
    find: "const held = new Set(db.listPending().map((r) => r.spendId)", replace: "const held = new Set(db.listPending().filter((r) => r.status === 'pending' || r.status === 'stuck').map((r) => r.spendId)" },
  { id: "M56", item: "round 3 #1", file: "src/queue.js", rule: "boot does not recover a mined or replaced row with an open reservation",
    find: "if ((r.status !== 'mined' && r.status !== 'replaced') || r.spendId === null || !open.has(r.spendId)) continue;", replace: "continue;" },
  { id: "M57", item: "round 3 #1", file: "src/queue.js", rule: "onMined runs before the change is stored (a replaced send held again)",
    find: "held again and pending, or neither.\n      db.atomically(() => {", replace: "held again and pending, or neither.\n      notify(row, found.receipt);\n      db.atomically(() => {" },
  { id: "M58", item: "round 3 #2", file: "src/queue.js", rule: "a receipt settles at once (the old rule)",
    find: "    const marked = markConfirming(row, receipt);\n    return (await confirm(marked, proof, head)) ?? 'confirming';", replace: "    settle(row, receipt);\n    return 'mined';" },
  { id: "M59", item: "round 3 #2", file: "src/queue.js", rule: "a confirming send settles before its block is finalized",
    find: "      if (height > (await proof.finalized()).number) return 'confirming';\n      onChain = await proof.onFinalChain(height, row.minedBlockHash);", replace: "      onChain = true;" },
  { id: "M60", item: "round 3 #2", file: "src/queue.js", rule: "a receipt that is gone is not a reorg",
    find: "return receiptMissing(e) ? reorged(row, 'receipt_gone', head) : null;", replace: "return null;" },
  { id: "M61", item: "round 3 #2", file: "src/queue.js", rule: "a receipt that names another block is not a reorg",
    find: "if (!same(receipt.blockHash, row.minedBlockHash) || BigInt(receipt.blockNumber) !== height) return reorged(row, 'receipt_moved', head);", replace: "" },
  { id: "M62", item: "round 3 #2", file: "src/queue.js", rule: "another block at the receipt's height is not a reorg",
    find: "if (where === 'moved') return reorged(row, 'block_replaced', head);", replace: "" },
  { id: "M63", item: "round 3 #2", file: "src/queue.js", rule: "a receipt block off the finalized chain settles anyway",
    find: "if (!onChain) return reorged(row, 'not_on_finalized_chain', head);", replace: "" },
  { id: "M64", item: "round 3 #2", file: "src/queue.js", rule: "the poll loop leaves confirming sends out",
    find: "r.status === 'replaced' || r.status === 'confirming');", replace: "r.status === 'replaced');" },
  { id: "M65", item: "round 3 #2", file: "src/queue.js", rule: "reconcile rebroadcasts a confirming send",
    find: "        if (row.status === 'confirming') {\n", replace: "        if (false) {\n" },
  { id: "M66", item: "round 3 #2", file: "src/db.js", rule: "nonce allocation forgets confirming sends",
    find: "status IN ('pending', 'stuck', 'confirming')\");", replace: "status IN ('pending', 'stuck')\");" },
  { id: "M67", item: "round 3 #2", file: "src/queue.js", rule: "a replaced send whose receipt appears is not held again",
    find: "        if (row.spendId !== null) db.reopenSpend(row.spendId);\n", replace: "" },
  { id: "M68", item: "round 3 #2", file: "src/queue.js", rule: "the bump timer does not restart after a reorg",
    find: "sentBlock: head ?? row.sentBlock });\n      if (row.heldReason) db.setHeldReason(row.id, null);", replace: "sentBlock: row.sentBlock });\n      if (row.heldReason) db.setHeldReason(row.id, null);" },
  { id: "M69", item: "round 3 #2", file: "src/queue.js", rule: "the read client's receipt is trusted without the proof endpoint",
    find: "receipt = await proof.reader.getTransactionReceipt({ hash: found.hash });", replace: "receipt = found.receipt;" },
  { id: "M70", item: "round 3 #2", file: "src/server.js", rule: "GET /sends/:hash says finalized for a confirming send",
    find: "finalized: row.status === 'mined' }", replace: "finalized: true }" },
  { id: "M71", item: "round 3 #2", file: "src/server.js", rule: "GET /sends/:hash shows a confirming send as pending",
    find: "const mined = row.status === 'mined' || row.status === 'confirming';", replace: "const mined = row.status === 'mined';" },
  { id: "M72", item: "round 3 #3", file: "src/queue.js", rule: "the consuming block need not be on the finalized chain",
    find: "          if (!(await onFinalChain(lo, block.hash))) return null;\n", replace: "" },
  { id: "M73", item: "round 3 #3", file: "src/queue.js", rule: "the consuming transaction need not name its block",
    find: "          if (!same(t.blockHash, block.hash) || t.blockNumber === undefined || t.blockNumber === null || BigInt(t.blockNumber) !== lo) return null;\n", replace: "" },
  { id: "M74", item: "round 3 #3", file: "src/queue.js", rule: "our own receipt need not name the consuming block",
    find: "          if (!same(receipt.blockHash, block.hash) || receipt.blockNumber === undefined || receipt.blockNumber === null || BigInt(receipt.blockNumber) !== lo) return null;\n", replace: "" },
  { id: "M75", item: "round 3 #3", file: "src/queue.js", rule: "the finalized hash is not pinned (the walk starts from the block it checks)",
    find: "let h = f.hash;", replace: "let h = hash;" },
  { id: "M76", item: "round 3 #3", file: "src/queue.js", rule: "a block read by hash need not be the block asked for",
    find: "if (!same(block?.hash, hash) || typeof block.parentHash !== 'string') throw new Error('block_by_hash');", replace: "if (typeof block?.parentHash !== 'string') throw new Error('block_by_hash');" },
  { id: "M77", item: "round 3 #3", file: "src/queue.js", rule: "a block read by hash need not be at the height expected",
    find: "      if (b.number !== number) throw new Error('block_height');\n", replace: "" },
  { id: "M78", item: "round 3 #3", file: "src/queue.js", rule: "the walk has no budget per pass",
    find: "if (walked >= walkBudget)", replace: "if (false)" },
  { id: "M79", item: "round 3 #3", file: "src/queue.js", rule: "blocks read by hash are not kept between passes",
    find: "    } else if (blocks.size > keptBlocks) {", replace: "    } else if (true) {\n      blocks.clear();" },
  // Round 4 (Codex round 4 HIGH 1, HIGH 2 and MEDIUM 4; Flash round 4's two LOWs; the orchestrator's ruling).
  { id: "M80", item: "round 4 #1", file: "src/queue.js", rule: "findReceipt takes a receipt of another transaction and follows its hash",
    find: "if (receipt && same(receipt.transactionHash, hash)) return { receipt, hash, unclear: false };", replace: "if (receipt) return { receipt, hash: receipt.transactionHash, unclear: false };" },
  { id: "M81", item: "round 4 #1", file: "src/queue.js", rule: "the binding accepts a hash that is not one of the send's own",
    find: "if (typeof hash !== 'string' || !row.hashes.some((h) => same(h, hash))) return 'unbound';", replace: "if (typeof hash !== 'string') return 'unbound';" },
  { id: "M82", item: "round 4 #1", file: "src/queue.js", rule: "the block need not list the transaction (exactly once)",
    find: "      if (hits.length !== 1) return 'unbound';\n", replace: "      if (hits.length !== 1) return 'bound';\n" },
  { id: "M83", item: "round 4 #1", file: "src/queue.js", rule: "the listed transaction need not name the block's hash",
    find: "      if (!same(t.blockHash, block.hash)) return 'unbound';\n", replace: "" },
  { id: "M84", item: "round 4 #1", file: "src/queue.js", rule: "the listed transaction need not name the block's height",
    find: "      if (t.blockNumber === undefined || t.blockNumber === null || BigInt(t.blockNumber) !== height) return 'unbound';\n", replace: "" },
  { id: "M85", item: "round 4 #1", file: "src/queue.js", rule: "seen() marks confirming without the binding",
    find: "      if ((await proof.ownIn(row, receipt)) !== 'bound') return 'seen';\n", replace: "" },
  { id: "M86", item: "round 4 #1", file: "src/queue.js", rule: "confirm() settles a send whose block and receipt disagree about the transaction",
    find: "    if (where !== 'bound') return null;\n", replace: "" },
  { id: "M87", item: "round 4 #2", file: "src/queue.js", rule: "reconcile rebroadcasts a stored send on a chain not sponsored",
    find: "} else if (row.nonce >= pending && clients.sponsored !== false) {", replace: "} else if (row.nonce >= pending) {" },
  { id: "M88", item: "round 4 #2", file: "src/queue.js", rule: "the poll loop bumps a stored send on a chain not sponsored",
    find: "            if (clients.sponsored === false) continue;\n", replace: "" },
  { id: "M89", item: "round 4 MEDIUM 4", file: "src/queue.js", rule: "a block read by hash at the wrong height is kept",
    find: "if (b.number === number) blocks.set(hash, b);", replace: "blocks.set(hash, b);" },
  { id: "M90", item: "round 4 LOW 1", file: "src/queue.js", rule: "reconcile gives resolve no head (a reorg found at boot keeps the old bump timer)",
    find: "heads.set(row.chainId, await publicClient.getBlockNumber({ cacheTime: 0 }).catch(() => null));", replace: "heads.set(row.chainId, null);" },
  { id: "M91", item: "round 4 LOW 2", file: "src/queue.js", rule: "boot recovery keeps the recovered row's block hash",
    find: "status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null });", replace: "status: 'pending', consumedBy: null, consumedBlock: null });" },
  // Round 5 (Codex round 5 INTRODUCED HIGH): a replaced send whose own receipt appears is held again first.
  { id: "M92", item: "round 5 HIGH", file: "src/queue.js", rule: "a replaced send whose own receipt appears is not held again before the binding read (the re-hold removed)",
    find: "    if (row.status === 'replaced') {\n      // findReceipt returns only", replace: "    if (false) {\n      // findReceipt returns only" },
  // Dedupe round (orchestrator 2026-11-11, round-5 Q2 (b); Codex round-5 re-check MEDIUM).
  { id: "M93", item: "dedupe Q2", file: "src/queue.js", rule: "onMined runs before markConfirming stores confirming",
    find: "    db.atomically(() => {\n      db.updatePending(row.id, { ...row, status: 'confirming', consumedBy: receipt.transactionHash, consumedBlock: BigInt(receipt.blockNumber), minedBlockHash: receipt.blockHash.toLowerCase() });\n    });\n    notify(row, receipt);\n", replace: "    notify(row, receipt);\n    db.atomically(() => {\n      db.updatePending(row.id, { ...row, status: 'confirming', consumedBy: receipt.transactionHash, consumedBlock: BigInt(receipt.blockNumber), minedBlockHash: receipt.blockHash.toLowerCase() });\n    });\n" },
  { id: "M94", item: "dedupe Q2", file: "src/queue.js", rule: "the re-hold keeps the old sentBlock (the bump timer does not restart)",
    find: "db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null, sentBlock: head ?? row.sentBlock });\n        db.insertEvent({ kind: 'send_release_reversed'", replace: "db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null, sentBlock: row.sentBlock });\n        db.insertEvent({ kind: 'send_release_reversed'" },
  { id: "M95", item: "dedupe Q2", file: "src/queue.js", rule: "the re-hold keeps the consuming hash",
    find: "db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null, sentBlock: head ?? row.sentBlock });\n        db.insertEvent({ kind: 'send_release_reversed'", replace: "db.updatePending(row.id, { ...row, status: 'pending', consumedBlock: null, minedBlockHash: null, sentBlock: head ?? row.sentBlock });\n        db.insertEvent({ kind: 'send_release_reversed'" },
  { id: "M96", item: "dedupe Q2", file: "src/queue.js", rule: "the re-hold keeps the consuming block",
    find: "db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null, sentBlock: head ?? row.sentBlock });\n        db.insertEvent({ kind: 'send_release_reversed'", replace: "db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, minedBlockHash: null, sentBlock: head ?? row.sentBlock });\n        db.insertEvent({ kind: 'send_release_reversed'" },
  { id: "M97", item: "dedupe Q2", file: "src/queue.js", rule: "the re-hold keeps the block hash",
    find: "db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, minedBlockHash: null, sentBlock: head ?? row.sentBlock });\n        db.insertEvent({ kind: 'send_release_reversed'", replace: "db.updatePending(row.id, { ...row, status: 'pending', consumedBy: null, consumedBlock: null, sentBlock: head ?? row.sentBlock });\n        db.insertEvent({ kind: 'send_release_reversed'" },
  { id: "M98", item: "dedupe Q2", file: "src/queue.js", rule: "the re-hold writes no send_release_reversed event",
    find: "        db.insertEvent({ kind: 'send_release_reversed', chainId: row.chainId, detail: { nonce: row.nonce, hash: found.hash, replacedBy: row.consumedBy } });\n", replace: "" },
  { id: "M99", item: "dedupe MEDIUM", file: "src/queue.js", rule: "confirm() settles an own inclusion that contradicts the finalized consumer",
    find: "if (c !== null && (!c.own || !same(c.hash, row.consumedBy) || c.block !== height)) {", replace: "if (false) {" },
  // The dedupe round's second half: the held reason, the operator list, the recheck body, the pending count, the in-flight
  // mark, the walk cache floor, broadcast false at each 502, and the duplicate answer (25-28 dedupe).
  { id: "M100", item: "dedupe", file: "src/queue.js", rule: "a send held on conflicting evidence is logged on every pass, not once",
    find: "if (row.heldReason !== HELD_CONFLICT) {",
    replace: "if (true) {" },
  { id: "M101", item: "dedupe", file: "src/queue.js", rule: "a reorg leaves the held reason on a send that goes back to pending",
    find: "      if (row.heldReason) db.setHeldReason(row.id, null);\n",
    replace: "" },
  { id: "M102", item: "dedupe", file: "src/queue.js", rule: "needsOperator leaves out stuck sends",
    find: "r.status === 'stuck' ? HELD_STUCK : ",
    replace: "" },
  { id: "M103", item: "dedupe", file: "src/queue.js", rule: "needsOperator leaves out sends held on conflicting evidence",
    find: "r.status === 'confirming' && r.heldReason ? r.heldReason : null",
    replace: "null" },
  { id: "M104", item: "dedupe", file: "src/server.js", rule: "the recheck body may carry keys besides hash",
    find: "Object.keys(v).some((k) => k !== 'hash') || ",
    replace: "" },
  { id: "M105", item: "dedupe", file: "src/queue.js", rule: "the nonce takes only the proof endpoint's pending count",
    find: "const chainPending = Math.max(...counts.map(Number));",
    replace: "const chainPending = Number(counts[0]);" },
  { id: "M106", item: "dedupe", file: "src/queue.js", rule: "the nonce takes only the fallback's pending count",
    find: "const chainPending = Math.max(...counts.map(Number));",
    replace: "const chainPending = Number(counts[1]);" },
  { id: "M107", item: "dedupe", file: "src/watcher.js", rule: "the challenge's in-flight mark is written after the question is stored",
    find: "    after('marking it in flight', () => db.updateWatched(q.chainId, q.questionId, { flagged: true, challengedBond: bondKey, challengeNonce: sent.nonce, challengeAttempts: attempts + 1 }));\n    // Reclaim (25-07) works from this row. The history it rebuilds starts at the block the question was asked in,\n    // so the attacker's answer, which came after, is in it.\n    after('storing its bond for reclaim', () => db.insertQuestion({ chainId: q.chainId, questionId: q.questionId, module: q.module, safe: q.safe, proposalId: q.proposalId, answer: decision.answer, bondWei: next, bondRef, fromBlock: q.createdBlock, txHash: sent.hash }));",
    replace: "    // Reclaim (25-07) works from this row. The history it rebuilds starts at the block the question was asked in,\n    // so the attacker's answer, which came after, is in it.\n    after('storing its bond for reclaim', () => db.insertQuestion({ chainId: q.chainId, questionId: q.questionId, module: q.module, safe: q.safe, proposalId: q.proposalId, answer: decision.answer, bondWei: next, bondRef, fromBlock: q.createdBlock, txHash: sent.hash }));\n    after('marking it in flight', () => db.updateWatched(q.chainId, q.questionId, { flagged: true, challengedBond: bondKey, challengeNonce: sent.nonce, challengeAttempts: attempts + 1 }));" },
  { id: "M108", item: "dedupe", file: "src/queue.js", rule: "the walk cache prune deletes blocks above the floor",
    find: "floor === null || b.number <= floor",
    replace: "true" },
  { id: "M109", item: "dedupe", file: "src/queue.js", rule: "the walk cache floor ignores confirming sends",
    find: "r.status === 'stuck' || r.status === 'confirming')) continue;",
    replace: "r.status === 'stuck')) continue;" },
  { id: "M110", item: "dedupe", file: "src/sends/pipeline.js", rule: "pipeline: the fee estimate 502 loses broadcast false",
    find: "reason: 'fee_estimate_failed', broadcast: false",
    replace: "reason: 'fee_estimate_failed'" },
  { id: "M111", item: "dedupe", file: "src/sends/pipeline.js", rule: "pipeline: the enqueue 502 loses broadcast false",
    find: "reason: e.shortMessage ?? 'send failed', broadcast: false",
    replace: "reason: e.shortMessage ?? 'send failed'" },
  { id: "M112", item: "dedupe", file: "src/sends/safeExec.js", rule: "safe-exec: the unreadable Safe nonce 502 loses broadcast false",
    find: "reason: 'safe_nonce_unreadable', broadcast: false",
    replace: "reason: 'safe_nonce_unreadable'" },
  { id: "M113", item: "dedupe", file: "src/sends/safeExec.js", rule: "safe-exec: the fee estimate 502 loses broadcast false",
    find: "reason: 'fee_estimate_failed', broadcast: false",
    replace: "reason: 'fee_estimate_failed'" },
  { id: "M114", item: "dedupe", file: "src/sends/safeExec.js", rule: "safe-exec: the enqueue 502 loses broadcast false",
    find: "reason: e.shortMessage ?? 'send failed', broadcast: false",
    replace: "reason: e.shortMessage ?? 'send failed'" },
  { id: "M115", item: "dedupe", file: "src/sends/reality.js", rule: "reality: a hub error 502 loses broadcast false",
    find: "reply(502, { error: e.code, broadcast: false })",
    replace: "reply(502, { error: e.code })" },
  { id: "M116", item: "dedupe", file: "src/sends/reality.js", rule: "reality: the read_failed 502 loses broadcast false",
    find: "reply(502, { error: 'read_failed', broadcast: false })",
    replace: "reply(502, { error: 'read_failed' })" },
  { id: "M117", item: "dedupe", file: "src/sends/ens.js", rule: "ens: the availability_unreadable 502 loses broadcast false",
    find: "reason: 'availability_unreadable', broadcast: false",
    replace: "reason: 'availability_unreadable'" },
  { id: "M118", item: "dedupe", file: "src/db.js", rule: "the duplicate check ignores status, so a replaced send counts as a duplicate",
    find: "AND status IN ('pending', 'stuck', 'confirming', 'mined') ",
    replace: "" },
  { id: "M119", item: "dedupe", file: "src/queue.js", rule: "the duplicate check is removed from the queue",
    find: "if (meta.dedupeKey) {",
    replace: "if (false) {" },
  { id: "M120", item: "dedupe", file: "src/sends/pipeline.js", rule: "pipeline: a duplicate does not give its reservation back",
    find: "        cap.release(reservation);\n        logger.info(`duplicate",
    replace: "        logger.info(`duplicate" },
  { id: "M121", item: "dedupe", file: "src/sends/safeExec.js", rule: "safe-exec: a duplicate does not give its reservation back",
    find: "    cap.release(reservation);\n    logger.info(`duplicate safe-exec",
    replace: "    logger.info(`duplicate safe-exec" },
  { id: "M122", item: "dedupe", file: "src/sends/safeExec.js", rule: "safe-exec: the dedupe key ignores the Safe nonce",
    find: ":${tx.safe.toLowerCase()}:${safeNonce}`",
    replace: ":${tx.safe.toLowerCase()}`" },
  { id: "M123", item: "dedupe", file: "src/sends/reality.js", rule: "reality: a duplicate answer stores the question again",
    find: "if (sent.ok && !sent.duplicate) {",
    replace: "if (sent.ok) {" },
];

/** Leaf tests that failed, from node's TAP output (a suite's own "not ok" line is left out). */
function failedTests(tap) {
  const lines = tap.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*not ok \d+ - (.+)$/.exec(lines[i]);
    if (!m) continue;
    let suite = false;
    for (let j = i + 1; j < lines.length && j < i + 40; j += 1) {
      if (/^\s*\.\.\.\s*$/.test(lines[j])) break;
      if (/type: 'suite'/.test(lines[j])) suite = true;
    }
    if (!suite) out.push(m[1].trim());
  }
  return out;
}

function runSuite() {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(ROOT, 'test/unit/*.test.js')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tally = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? NaN);
  return { status: r.status, pass: tally('pass'), fail: tally('fail'), failed: failedTests(r.stdout) };
}

let restore = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restore?.();
    process.exit(130);
  });
}

function mutate(m) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const count = original.split(m.find).length - 1;
  if (count !== 1) return { ...m, error: `the text to replace occurs ${count} times, not once` };
  restore = () => writeFileSync(path, original);
  try {
    writeFileSync(path, original.replace(m.find, () => m.replace));
    const r = runSuite();
    return { ...m, ...r, caught: r.fail > 0 || r.status !== 0 };
  } finally {
    restore();
    restore = null;
  }
}

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const list = MUTATIONS.filter((m) => !only || m.id === only);
if (args.includes('--list')) {
  for (const m of list) console.log(`${m.id}\t${m.item}\t${m.file}\t${m.rule}`);
  process.exit(0);
}

const baseline = runSuite();
if (baseline.fail !== 0 || baseline.status !== 0) {
  console.error(`the unmutated suite fails (${baseline.fail} failing): fix it before a mutation run`);
  process.exit(2);
}
const results = [];
for (const m of list) {
  const r = mutate(m);
  results.push(r);
  if (!args.includes('--markdown')) {
    const verdict = r.error ? `ERROR ${r.error}` : r.caught ? `caught by ${r.failed.length} test(s)` : 'SURVIVED';
    console.log(`${r.id} [${r.item}] ${r.file}: ${r.rule}: ${verdict}`);
    if (r.caught) for (const t of r.failed.slice(0, 3)) console.log(`    - ${t}`);
  }
}
const caught = results.filter((r) => r.caught).length;
if (args.includes('--markdown')) {
  console.log(`Baseline: ${baseline.pass} tests pass, 0 fail. Mutations: ${results.length}, caught: ${caught}, survived: ${results.length - caught}.\n`);
  console.log('| Id | Item | File | Rule the mutation breaks | Failing tests | Caught by (first failing test) |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    const by = r.error ? `ERROR: ${r.error}` : r.caught ? r.failed[0] ?? '(the suite exits non-zero)' : '**SURVIVED**';
    console.log(`| ${r.id} | ${r.item} | \`${r.file}\` | ${r.rule} | ${r.error ? '-' : r.failed.length} | ${by.replace(/\|/g, '\\|')} |`);
  }
} else {
  console.log(`\nbaseline ${baseline.pass} pass; ${results.length} mutations, ${caught} caught, ${results.length - caught} survived`);
}
process.exit(caught === results.length ? 0 : 1);
