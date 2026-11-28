// When a Reality question was asked: the `created` time Reality itself writes into LogNewQuestion (the timestamp of
// the block the question was asked in). answer.js compares it with the hub's end of the vote.
//
// Every log is read from final blocks only (the chain's `finalized` block and below), so a question and its time,
// once read, cannot move. A question in a block that is not final yet is not read, and nothing is answered or sent on
// it until it is. When the finalized block cannot be read nothing is read at all. The watcher stores the time, the
// keccak of the question's bytes as the chain holds them as its key (the module's questionIds key) and the parts of
// the question; the answer and execute endpoints and the watcher use a stored row as it is once all of that was read
// at a final block. An older row that was read near the head is read again. A log that is not found gives null, and
// nothing is answered or sent on it. A read that fails throws, as every other chain read does.
import { bytesToHex, hexToBytes, keccak256, parseAbiItem } from 'viem';
import { QUESTION_SEPARATOR } from './realityHash.js';

/** Most blocks one getLogs call covers. */
export const LOG_RANGE_BLOCKS = 2000n;
/** How far back a question is looked for: more than an hour on the fastest chain we serve. */
export const DEFAULT_LOOKBACK_BLOCKS = 2400n;

export const newQuestion = parseAbiItem(
  'event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)',
);

/** The `created` time of a LogNewQuestion log, or null when it is not a positive whole number. */
export function createdOf(log) {
  const t = log?.args?.created;
  return typeof t === 'bigint' && t > 0n ? t : null;
}

/**
 * The question's bytes exactly as the log's data carries them, never the decoded text, or null when the data does not
 * hold a whole string at the question's place (the second word).
 */
export function questionBytesOf(log) {
  try {
    const data = hexToBytes(log.data);
    const word = (at) => (at + 32 <= data.length ? BigInt(bytesToHex(data.subarray(at, at + 32))) : null);
    const offset = word(32);
    if (offset === null || offset > BigInt(data.length)) return null;
    const length = word(Number(offset));
    const start = Number(offset) + 32;
    if (length === null || BigInt(start) + length > BigInt(data.length)) return null;
    return data.subarray(start, start + Number(length));
  } catch {
    return null;
  }
}

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const PROPOSAL_ID = /^0x[0-9a-f]{64}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;

/**
 * The parts of a module question (`<id>` U+241F `<hex of the packed hash>`) from its bytes as the chain holds them,
 * split at the LAST separator: the hash after it is what the module executes. `key` is the module's questionIds key:
 * the keccak of those bytes. `proposalId` is the text before the separator only when that is a hub proposal id (0x and
 * 64 lowercase hex digits), else ''; `hash` is the 64 hex digits, else ''. Bytes that are not plain text, read without
 * dropping or replacing any of them, have no parts.
 */
export function parseQuestion(bytes) {
  const key = keccak256(bytes);
  let s;
  try {
    s = strict.decode(bytes);
  } catch {
    return { proposalId: '', hash: '', key };
  }
  const i = s.lastIndexOf(QUESTION_SEPARATOR);
  const id = i < 0 ? s : s.slice(0, i);
  const hash = i < 0 ? '' : s.slice(i + QUESTION_SEPARATOR.length);
  return { proposalId: PROPOSAL_ID.test(id) ? id : '', hash: HASH_HEX.test(hash) ? hash : '', key };
}

/** The chain's finalized block number, or null when it cannot be read (then nothing is read). */
export async function finalizedBlock(publicClient) {
  try {
    const block = await publicClient.getBlock({ blockTag: 'finalized' });
    return typeof block?.number === 'bigint' ? block.number : null;
  } catch {
    return null;
  }
}

/** The logs of one getLogs call that are inside the range asked for; a node that answers wider is not believed. */
export const inRange = (logs, from, to) => logs.filter((l) => typeof l?.blockNumber === 'bigint' && l.blockNumber >= from && l.blockNumber <= to);

/** The question's LogNewQuestion in blocks `from` to `last` (ranges of at most 2,000), or null. */
async function findLog(publicClient, reality, questionId, from, last) {
  for (let start = from; start <= last;) {
    const to = start + LOG_RANGE_BLOCKS - 1n < last ? start + LOG_RANGE_BLOCKS - 1n : last;
    const logs = inRange(await publicClient.getLogs({ address: reality, event: newQuestion, args: { question_id: questionId }, fromBlock: start, toBlock: to }), start, to);
    const log = logs.find((l) => String(l.args?.question_id).toLowerCase() === questionId.toLowerCase());
    if (createdOf(log) !== null && questionBytesOf(log) !== null) return log;
    start = to + 1n;
  }
  return null;
}

const minOf = (a, b) => (a < b ? a : b);
const back = (block, by) => (block > by ? block - by : 0n);

/** What a log read at a final block stores on a question row. */
const storedOf = (log) => {
  const { proposalId, hash, key } = parseQuestion(questionBytesOf(log));
  return { createdBlock: log.blockNumber, createdTs: createdOf(log), createdFinal: true, proposalId, questionHash: hash, questionKey: key };
};

/**
 * The time the question was asked, or null when its LogNewQuestion is not found in a final block.
 *
 * A stored row is used as it is once its log was read at a final block (`createdFinal`, with its time and key).
 * An older row read near the head is read again: at its stored block, then within the lookback before and after it,
 * never past the finalized block. `remember` ({ module, safe, proposalId, questionHash }), when given, stores a
 * question the watcher has not stored yet, found in the lookback before the finalized block, so a later step (the
 * execute, hours on) still has its time.
 */
export async function questionAskedAt({ db, publicClient, reality, chainId, questionId, lookback = DEFAULT_LOOKBACK_BLOCKS, remember = null }) {
  const row = db.getWatched(chainId, questionId);
  if (row?.createdTs && row.createdFinal && row.questionKey) return row.createdTs;
  const finalized = await finalizedBlock(publicClient);
  if (finalized === null) return null;
  if (row) {
    let log = row.createdBlock <= finalized ? await findLog(publicClient, reality, questionId, row.createdBlock, row.createdBlock) : null;
    if (!log) log = await findLog(publicClient, reality, questionId, back(row.createdBlock, lookback), minOf(row.createdBlock + lookback, finalized));
    if (!log) return null;
    const stored = storedOf(log);
    db.updateWatched(chainId, questionId, { ...stored, createdBlock: stored.createdBlock.toString(), createdTs: stored.createdTs.toString() });
    return stored.createdTs;
  }
  const log = await findLog(publicClient, reality, questionId, back(finalized, lookback), finalized);
  if (!log) return null;
  const stored = storedOf(log);
  if (remember) db.insertWatched({ chainId, questionId, ...remember, ...stored });
  return stored.createdTs;
}
