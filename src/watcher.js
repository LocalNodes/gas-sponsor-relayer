// The wrong-answer watcher (D-16, OQ-3, TM-83, TM-84).
//
// With a short Reality timeout, a wrong "yes" can finalize and move money long before a daily check runs. So every
// minute this loop looks at every registered Group's Reality module:
//
//   1. It reads the LogNewQuestion events whose questioner is the module (block ranges of at most 2,000, a cursor
//      per module) and keeps each question in the `questions` table until Reality says it is final.
//   2. For an open question that has an answer, it asks answer.js decide() what the answer should be and compares it
//      with Reality's current best answer. The relayer's own answer has no special weight: a question it answered is
//      judged like any other.
//   3. A wrong answer is challenged at once with decide()'s answer and double the current bond (max_previous = the
//      current bond, so a front-run changes nothing silently). Every challenge goes through the spend cap and the
//      serial queue. When the cap cannot cover it, or the challenge keeps failing, the watcher stores
//      escalation_needed with the question's finalize time as the deadline: the Group Safe owns the arbitrator, and
//      that is the backstop (D-07, D-16).
//   4. A finalized question is checked against decide() once more: a wrong final answer is a wrong_final event, and a
//      question the watcher had flagged that ended right is a resolved event.
//
// A hub outage never causes a challenge: when decide() cannot read the hub the question is left for the next tick.
// The bond of a challenge goes to the reclaim loop (25-07) through the reality_questions table.
import { encodeFunctionData, parseAbi, parseAbiItem } from 'viem';
import { build } from './allowlist.js';
import { chainIsConfigured } from './config.js';
import { ANSWER_BYTES, createAnswerer } from './answer.js';
import { HubError } from './hub.js';
import { QUESTION_SEPARATOR } from './realityHash.js';
import { createPipeline } from './sends/pipeline.js';
import { createEvents } from './events.js';

export const DEFAULT_WATCH_INTERVAL_S = 60;
export const DEFAULT_LOW_BALANCE_WEI = 20_000_000_000_000_000n;
/** Most blocks one getLogs call covers. */
export const LOG_RANGE_BLOCKS = 2000n;
/** How far back the first look at a module goes: more than an hour on the fastest chain we serve. */
export const DEFAULT_LOOKBACK_BLOCKS = 2400n;
/** Challenges tried at one bond level before the watcher gives up and asks for the arbitrator. */
export const MAX_CHALLENGE_ATTEMPTS = 3;

const PROPOSAL_ID = /^0x[0-9a-f]{64}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const WHOLE = /^(0|[1-9][0-9]*)$/;

/**
 * Watcher settings from the environment: SPONSOR_RELAYER_WATCH_INTERVAL_S (1 to 3600 seconds, default 60) and
 * SPONSOR_RELAYER_LOW_BALANCE_WEI (whole wei, default 0.02 ETH). Anything else throws, so the relayer refuses to start.
 */
export function watchSettingsFromEnv(env = process.env) {
  const rawInterval = env.SPONSOR_RELAYER_WATCH_INTERVAL_S;
  let seconds = DEFAULT_WATCH_INTERVAL_S;
  if (rawInterval !== undefined && rawInterval !== '') {
    if (typeof rawInterval !== 'string' || !/^[1-9][0-9]{0,3}$/.test(rawInterval) || Number(rawInterval) > 3600) {
      throw new Error(`SPONSOR_RELAYER_WATCH_INTERVAL_S must be a whole number of seconds from 1 to 3600, got ${JSON.stringify(String(rawInterval).slice(0, 40))}`);
    }
    seconds = Number(rawInterval);
  }
  const rawLow = env.SPONSOR_RELAYER_LOW_BALANCE_WEI;
  let lowBalanceWei = DEFAULT_LOW_BALANCE_WEI;
  if (rawLow !== undefined && rawLow !== '') {
    if (typeof rawLow !== 'string' || !WHOLE.test(rawLow)) {
      throw new Error(`SPONSOR_RELAYER_LOW_BALANCE_WEI must be a whole number of wei (digits only), got ${JSON.stringify(String(rawLow).slice(0, 40))}`);
    }
    lowBalanceWei = BigInt(rawLow);
  }
  return { intervalMs: seconds * 1000, lowBalanceWei };
}

/** The proposal id and the hex of the packed transaction hash in a module question (`<id>` U+241F `<hex>`). */
export function parseQuestion(text) {
  const s = String(text);
  const i = s.indexOf(QUESTION_SEPARATOR);
  if (i < 0) return { proposalId: s, hash: null };
  const hash = s.slice(i + QUESTION_SEPARATOR.length);
  return { proposalId: s.slice(0, i), hash: HASH_HEX.test(hash) ? hash : null };
}

const realityAbi = parseAbi([
  'function isFinalized(bytes32 question_id) view returns (bool)',
  'function getBestAnswer(bytes32 question_id) view returns (bytes32)',
  'function getBond(bytes32 question_id) view returns (uint256)',
  'function getFinalizeTS(bytes32 question_id) view returns (uint32)',
  'function resultFor(bytes32 question_id) view returns (bytes32)',
  'function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable',
]);
const moduleAbi = parseAbi(['function questionCooldown() view returns (uint32)']);
const newQuestion = parseAbiItem(
  'event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)',
);

const lower = (s) => String(s).toLowerCase();
const isoOf = (seconds) => new Date(Number(seconds) * 1000).toISOString();
const answerName = (bytes) => Object.keys(ANSWER_BYTES).find((k) => ANSWER_BYTES[k] === lower(bytes)) ?? 'other';

export function createWatcher({
  db,
  config,
  networks,
  chains,
  cap,
  queue,
  groupModules,
  hub,
  events = null,
  answerer = null,
  pipeline = null,
  logger = console,
  intervalMs = DEFAULT_WATCH_INTERVAL_S * 1000,
  lowBalanceWei = DEFAULT_LOW_BALANCE_WEI,
  lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS,
}) {
  const feed = events ?? createEvents({ db });
  const answers = answerer ?? createAnswerer({ hub, db, logger });
  const pipe = pipeline ?? createPipeline({ config, db, chains, cap, queue, logger });
  const lookback = BigInt(lookbackBlocks);
  let timer = null;
  let ticking = false;

  const realityOf = (chainId) => networks[String(chainId)]?.reality ?? null;
  const readReality = (clients, reality, functionName, args) => clients.publicClient.readContract({ address: reality, abi: realityAbi, functionName, args });

  /** decide()'s answer for a question; the same proposal and hash are asked of the hub once per tick. */
  function decisionFor(q, cache) {
    if (!PROPOSAL_ID.test(q.proposalId) || !HASH_HEX.test(q.questionHash)) {
      // Not a question the module would build from a hub proposal: nothing to read, and the answer is no.
      return Promise.resolve({ answer: 'no', reason: 'unknown_proposal' });
    }
    const key = `${q.chainId}:${lower(q.module)}:${q.proposalId}:${q.questionHash}`;
    if (!cache.has(key)) cache.set(key, answers.decide({ chainId: q.chainId, safe: q.safe, module: q.module, proposalId: q.proposalId, questionHashHex: q.questionHash }));
    return cache.get(key);
  }

  /** Read the module's new LogNewQuestion events, in ranges of at most 2,000 blocks, and remember each question. */
  async function discover(group, module) {
    const clients = chains.get(group.chainId);
    const reality = realityOf(group.chainId);
    const key = `questions:${group.chainId}:${lower(module)}`;
    const latest = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
    const saved = db.getCursor(key);
    let from = saved === null ? (latest > lookback ? latest - lookback : 0n) : BigInt(saved) + 1n;
    while (from <= latest) {
      const to = from + LOG_RANGE_BLOCKS - 1n < latest ? from + LOG_RANGE_BLOCKS - 1n : latest;
      const logs = await clients.publicClient.getLogs({ address: reality, event: newQuestion, args: { user: module }, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const { proposalId, hash } = parseQuestion(log.args.question);
        db.insertWatched({ chainId: group.chainId, questionId: log.args.question_id, module, safe: group.safe, proposalId, questionHash: hash ?? '', createdBlock: log.blockNumber });
      }
      db.setCursor(key, to.toString());
      from = to + 1n;
    }
  }

  /** One low_balance event when the relayer's balance falls under the line, and none more until it has recovered. */
  async function checkBalance(chainId) {
    if (!config.address) return;
    const clients = chains.get(chainId);
    const balance = await clients.publicClient.getBalance({ address: config.address });
    const flag = `low_balance:${chainId}`;
    const raised = db.getCursor(flag) !== null;
    if (balance < lowBalanceWei) {
      if (raised) return;
      db.setCursor(flag, '1');
      feed.add('low_balance', { chainId, detail: { balanceWei: balance, thresholdWei: lowBalanceWei, address: config.address } });
    } else if (raised) {
      db.deleteCursor(flag);
    }
  }

  const base = (q) => ({ chainId: q.chainId, safe: q.safe, module: q.module, questionId: q.questionId, proposalId: q.proposalId });

  /**
   * Tell the organizers that the arbitrator has to take over before `finalizeTs`. The event is stored once per wrong
   * answer (one bond level), not once per tick. A cap refusal is tried again on later ticks, so a cap that frees up in
   * time still lets the challenge through.
   */
  function escalate(q, { reason, bond, best, expected, finalizeTs, extra = {} }, actions) {
    if (q.escalatedBond === bond.toString()) return;
    feed.add('escalation_needed', {
      ...base(q),
      detail: {
        reason,
        currentBondWei: bond,
        neededBondWei: bond * 2n,
        currentAnswer: answerName(best),
        expectedAnswer: answerName(expected),
        deadline: isoOf(finalizeTs),
        deadlineTs: Number(finalizeTs),
        ...extra,
      },
    });
    db.updateWatched(q.chainId, q.questionId, { flagged: true, escalatedBond: bond.toString() });
    actions.push({ action: 'escalated', chainId: q.chainId, questionId: q.questionId, reason });
  }

  /** Is the challenge this question last sent still waiting for a receipt? */
  function inFlight(q) {
    if (q.challengeNonce === null) return false;
    return db.listPending().some((r) => r.chainId === q.chainId && r.nonce === q.challengeNonce && (r.status === 'pending' || r.status === 'stuck'));
  }

  /** Answer decide()'s answer with double the bond. Returns after the node has accepted the send (or refused to). */
  async function challenge(q, { clients, reality, bond, best, decision, finalizeTs }, actions) {
    const bondKey = bond.toString();
    const expected = ANSWER_BYTES[decision.answer];
    const sameLevel = q.challengedBond === bondKey;
    // A challenge against this bond is still on its way: wait for its receipt.
    if (sameLevel && inFlight(q)) return;
    // Reaching here at the same level means the last challenge mined without taking the answer (it reverted).
    const attempts = sameLevel ? q.challengeAttempts : 0;
    const info = { bond, best, expected, finalizeTs };
    if (attempts >= MAX_CHALLENGE_ATTEMPTS) return escalate(q, { ...info, reason: 'challenge_failed', extra: { attempts } }, actions);

    const next = bond * 2n;
    const bondRef = `bond:${q.chainId}:${q.questionId}:${next}`;
    const data = encodeFunctionData({ abi: realityAbi, functionName: 'submitAnswer', args: [q.questionId, expected, bond] });
    const sent = await pipe.send({
      chainId: q.chainId,
      safe: q.safe,
      to: reality,
      selectorName: 'submitAnswer',
      data,
      value: next,
      kind: 'reality-challenge',
      list: build(networks, db.listGroups()),
      reserve: { kind: 'bond', ref: bondRef },
    });
    if (!sent.ok) {
      if (sent.status === 429) return escalate(q, { ...info, reason: 'cap_reached', extra: { limit: sent.body?.limit, until: sent.body?.until } }, actions);
      db.updateWatched(q.chainId, q.questionId, { challengedBond: bondKey, challengeNonce: null, challengeAttempts: attempts + 1 });
      logger.warn(`challenge of ${q.questionId} on ${q.chainId} not sent: ${sent.body?.reason ?? sent.body?.error ?? 'failed'}`);
      if (attempts + 1 >= MAX_CHALLENGE_ATTEMPTS) escalate(q, { ...info, reason: 'challenge_failed', extra: { attempts: attempts + 1 } }, actions);
      return;
    }
    // The challenge is out (25-28 dedupe, round-2 Q6). First the mark that makes the next pass wait for its receipt
    // instead of challenging again; then the bookkeeping, each step logged when it fails and never thrown, as the
    // send routes do after a broadcast (25-28 round 2, MEDIUM 5).
    const after = (what, fn) => {
      try {
        fn();
      } catch (e) {
        logger.error(`ALERT challenge ${sent.hash} of ${q.questionId} on ${q.chainId} is out, but ${what} failed: ${e?.name ?? 'Error'}`);
      }
    };
    after('marking it in flight', () => db.updateWatched(q.chainId, q.questionId, { flagged: true, challengedBond: bondKey, challengeNonce: sent.nonce, challengeAttempts: attempts + 1 }));
    // Reclaim (25-07) works from this row. The history it rebuilds starts at the block the question was asked in,
    // so the attacker's answer, which came after, is in it.
    after('storing its bond for reclaim', () => db.insertQuestion({ chainId: q.chainId, questionId: q.questionId, module: q.module, safe: q.safe, proposalId: q.proposalId, answer: decision.answer, bondWei: next, bondRef, fromBlock: q.createdBlock, txHash: sent.hash }));
    after('the answer_challenged event', () => feed.add('answer_challenged', {
      ...base(q),
      detail: {
        answer: decision.answer,
        reason: decision.reason,
        previousAnswer: answerName(best),
        previousBondWei: bond,
        bondWei: next,
        txHash: sent.hash,
        deadline: isoOf(finalizeTs),
        deadlineTs: Number(finalizeTs),
      },
    }));
    actions.push({ action: 'challenged', chainId: q.chainId, questionId: q.questionId, answer: decision.answer, bondWei: next, hash: sent.hash });
  }

  /** Look at one open question. Throws when a chain read fails; the next tick looks again. */
  async function handle(q, cache, actions) {
    const clients = chains.get(q.chainId);
    const reality = realityOf(q.chainId);
    if (!clients?.walletClient || !reality) return;
    const read = (fn, args = [q.questionId]) => readReality(clients, reality, fn, args);

    if (await read('isFinalized')) {
      const result = lower(await read('resultFor'));
      let decision;
      try {
        decision = await decisionFor(q, cache);
      } catch (e) {
        if (e instanceof HubError) return;
        throw e;
      }
      const expected = ANSWER_BYTES[decision.answer];
      if (result !== expected) {
        const finalizeTs = await read('getFinalizeTS');
        const cooldown = await clients.publicClient.readContract({ address: q.module, abi: moduleAbi, functionName: 'questionCooldown' }).catch(() => null);
        feed.add('wrong_final', {
          ...base(q),
          detail: {
            finalAnswer: answerName(result),
            expectedAnswer: decision.answer,
            reason: decision.reason,
            finalizedAt: isoOf(finalizeTs),
            ...(cooldown === null ? {} : { executableAfter: isoOf(BigInt(finalizeTs) + BigInt(cooldown)) }),
          },
        });
        actions.push({ action: 'wrong_final', chainId: q.chainId, questionId: q.questionId });
      } else if (q.flagged) {
        feed.add('resolved', { ...base(q), detail: { answer: decision.answer, reason: decision.reason } });
        actions.push({ action: 'resolved', chainId: q.chainId, questionId: q.questionId });
      }
      db.updateWatched(q.chainId, q.questionId, { status: 'closed' });
      return;
    }

    // An unanswered question has no wrong answer (its best answer reads as zero, which is "no").
    const bond = await read('getBond');
    if (bond === 0n) return;
    const best = lower(await read('getBestAnswer'));
    let decision;
    try {
      decision = await decisionFor(q, cache);
    } catch (e) {
      if (e instanceof HubError) {
        logger.warn(`watcher: hub not readable for ${q.proposalId} (${e.code}); question left for the next tick`);
        return;
      }
      throw e;
    }
    if (best === ANSWER_BYTES[decision.answer]) return;
    const finalizeTs = await read('getFinalizeTS');
    await challenge(q, { clients, reality, bond, best, decision, finalizeTs }, actions);
  }

  return {
    /** One pass: new questions, balance, then every open question. Returns what it did. */
    async tick() {
      if (ticking) return [];
      ticking = true;
      const actions = [];
      try {
        const groups = db.listGroups().filter((g) => chainIsConfigured(networks, g.chainId) && realityOf(g.chainId) && chains.get(g.chainId)?.publicClient);
        for (const chainId of new Set(groups.map((g) => g.chainId))) {
          try {
            await checkBalance(chainId);
          } catch (e) {
            logger.warn(`watcher: balance of ${chainId} not read: ${e?.shortMessage ?? e?.name}`);
          }
        }
        for (const group of groups) {
          try {
            for (const module of await groupModules.modulesFor(group.chainId, group.safe)) await discover(group, module);
          } catch (e) {
            logger.warn(`watcher: questions of ${group.safe} on ${group.chainId} not read: ${e?.shortMessage ?? e?.name}`);
          }
        }
        const cache = new Map();
        for (const q of db.listOpenWatched()) {
          try {
            await handle(q, cache, actions);
          } catch (e) {
            logger.warn(`watcher: question ${q.questionId} on ${q.chainId}: ${e?.shortMessage ?? e?.name ?? 'error'}`);
          }
        }
      } finally {
        ticking = false;
      }
      return actions;
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        this.tick().catch((e) => logger.error(`watcher tick failed: ${e?.name ?? 'Error'}`));
      }, intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
