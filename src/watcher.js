// The wrong-answer watcher (D-16, OQ-3, TM-83, TM-84).
//
// With a short Reality timeout, a wrong "yes" can finalize and move money long before a daily check runs. So every
// minute this loop looks at every registered Group's Reality module:
//
//   1. It reads the LogNewQuestion events whose questioner is the module, from final blocks only (block ranges of at
//      most 2,000, a cursor per module that never passes the finalized block), and keeps each question in the
//      `questions` table, with its whole text as a key, until Reality says it is final.
//   2. For an open question that has an answer, it asks answer.js what the answer should be, from the hub and the time
//      the question was asked (a question asked before the vote ended stays invalid; a question that is not, as a
//      whole, the module's question for a proposal of the Group is invalid), and compares it with Reality's current
//      best answer. The relayer's own answer has no special weight: a question it answered is judged like any other.
//      When no answer can be decided (a time that cannot be read, or a count not final yet) nothing is challenged; a
//      standing yes is one escalation_needed (reason cannot_decide), so the organizers can watch it.
//   3. A bond is spent only where money is at stake: to overturn a standing yes that should not be yes, to put the
//      rightful yes on a proposal that passed, and to turn a standing no into invalid on a question for a proposal that
//      passed but was asked before the vote ended (so it can be asked again). A standing no or invalid that already
//      stops the payment is left alone otherwise. A challenge carries decide()'s answer and double the current bond
//      (max_previous = the current bond, so a front-run changes nothing silently). Every challenge goes through the
//      spend cap and the serial queue. When the cap cannot cover it, or the challenge keeps failing, the watcher stores
//      escalation_needed with the question's finalize time as the deadline: the Group Safe owns the arbitrator, and
//      that is the backstop (D-07, D-16).
//   4. A finalized question is checked against decide() once more: a final answer that is wrong where money is at
//      stake (by the same rule) is a wrong_final event, and a question the watcher had flagged that ended without
//      such a wrong is a resolved event.
//
// A hub outage never causes a challenge: when decide() cannot read the hub the question is left for the next tick.
// The bond of a challenge goes to the reclaim loop through the reality_questions table.
import { encodeFunctionData, parseAbi } from 'viem';
import { build } from './allowlist.js';
import { chainIsConfigured } from './config.js';
import { ANSWER_BYTES, createAnswerer } from './answer.js';
import { HubError } from './hub.js';
import { createdOf, DEFAULT_LOOKBACK_BLOCKS, finalizedBlock, inRange, LOG_RANGE_BLOCKS, newQuestion, parseQuestion, questionAskedAt, questionBytesOf } from './questionTime.js';
import { createPipeline } from './sends/pipeline.js';
import { createEvents } from './events.js';

export const DEFAULT_WATCH_INTERVAL_S = 60;
export const DEFAULT_LOW_BALANCE_WEI = 20_000_000_000_000_000n;
// Most blocks one getLogs call covers, and how far back the first look at a module goes.
export { DEFAULT_LOOKBACK_BLOCKS, LOG_RANGE_BLOCKS, parseQuestion };
/** Challenges tried at one bond level before the watcher gives up and asks for the arbitrator. */
export const MAX_CHALLENGE_ATTEMPTS = 3;

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

const realityAbi = parseAbi([
  'function isFinalized(bytes32 question_id) view returns (bool)',
  'function getBestAnswer(bytes32 question_id) view returns (bytes32)',
  'function getBond(bytes32 question_id) view returns (uint256)',
  'function getFinalizeTS(bytes32 question_id) view returns (uint32)',
  'function resultFor(bytes32 question_id) view returns (bytes32)',
  'function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable',
]);
const moduleAbi = parseAbi(['function questionCooldown() view returns (uint32)']);

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

  /**
   * The answer for a question, from the hub (each proposal read once per tick), the question's whole text and the
   * time it was asked. `matched`: the question is, as a whole, the module's question for a proposal of the Group;
   * `passedMatch`: and that proposal passed; `voteOpen`: its vote or count is not final yet.
   */
  async function decisionFor(q, clients, reality, cache) {
    const askedAt = await questionAskedAt({ db, publicClient: clients.publicClient, reality, chainId: q.chainId, questionId: q.questionId, lookback });
    const row = db.getWatched(q.chainId, q.questionId) ?? q;
    // The whole question is not read yet (its block is not final, or an older row): nothing is decided.
    const none = { matched: false, passedMatch: false, voteOpen: false };
    if (!row.questionKey) return { answer: null, reason: 'question_time_unknown', ...none };
    if (!row.proposalId) {
      // Not a question the module builds from a hub proposal (a separator inside the id, or no id): invalid.
      return { answer: 'invalid', reason: 'question_mismatch', ...none };
    }
    const key = `${q.chainId}:${lower(q.safe)}:${lower(q.module)}:${row.proposalId}`;
    if (!cache.has(key)) cache.set(key, answers.evaluate({ chainId: q.chainId, safe: q.safe, module: q.module, proposalId: row.proposalId }));
    const verdict = await cache.get(key);
    const decision = answers.decideFromVerdict(verdict, row.questionKey, askedAt);
    const matched = answers.isQuestionOf(verdict, row.questionKey);
    return { ...decision, matched, passedMatch: matched && verdict.kind === 'ok', voteOpen: matched && verdict.kind === 'not_final' };
  }

  /**
   * Whether a bond is spent to change `current` (Reality's answer bytes) into the decision's answer. Only where money
   * is at stake: a yes that should not be yes, a rightful yes not standing, and a no on a passed proposal's question
   * asked too early (a no can never be asked again; an invalid can).
   */
  function worthChallenging(current, decision) {
    const expected = ANSWER_BYTES[decision.answer];
    if (current === expected) return false;
    if (current === ANSWER_BYTES.yes || decision.answer === 'yes') return true;
    return decision.answer === 'invalid' && current === ANSWER_BYTES.no && decision.reason === 'asked_before_resolution' && decision.passedMatch;
  }

  /** Read the module's new LogNewQuestion events from final blocks, in ranges of at most 2,000, and remember each question. */
  async function discover(group, module) {
    const clients = chains.get(group.chainId);
    const reality = realityOf(group.chainId);
    // A new cursor name: a cursor of an older relayer may have passed blocks that were not final when it read them.
    const key = `questions-final:${group.chainId}:${lower(module)}`;
    const finalized = await finalizedBlock(clients.publicClient);
    if (finalized === null) {
      logger.warn(`watcher: questions of ${group.safe} on ${group.chainId} not read: the finalized block cannot be read`);
      return;
    }
    const saved = db.getCursor(key);
    let from;
    if (saved !== null) {
      from = BigInt(saved) + 1n;
    } else {
      // On a move from an older relayer: its cursor read up to the head, so its last blocks were not final. The first
      // scan starts the look-back before it and reads forward, so no question asked since it last read is skipped.
      const older = db.getCursor(`questions:${group.chainId}:${lower(module)}`);
      if (older !== null && /^\d+$/.test(older)) {
        from = BigInt(older) > lookback ? BigInt(older) - lookback : 0n;
      } else {
        from = finalized > lookback ? finalized - lookback : 0n;
        logger.warn(`watcher: first scan of questions on chain ${group.chainId} with no cursor: blocks ${from} to ${finalized}; questions asked before block ${from} are not read`);
      }
    }
    while (from <= finalized) {
      const to = from + LOG_RANGE_BLOCKS - 1n < finalized ? from + LOG_RANGE_BLOCKS - 1n : finalized;
      const logs = inRange(await clients.publicClient.getLogs({ address: reality, event: newQuestion, args: { user: module }, fromBlock: from, toBlock: to }), from, to);
      for (const log of logs) {
        const bytes = questionBytesOf(log);
        // A log whose data holds no question is not the module's question: it is not stored.
        if (bytes === null) continue;
        const { proposalId, hash, key: questionKey } = parseQuestion(bytes);
        const row = { proposalId, questionHash: hash, questionKey, createdFinal: true };
        db.insertWatched({ chainId: group.chainId, questionId: log.args.question_id, module, safe: group.safe, createdBlock: log.blockNumber, createdTs: createdOf(log), ...row });
        // A row an older relayer stored keeps its first reading; this one, from a final block, replaces it.
        const stored = db.getWatched(group.chainId, log.args.question_id);
        if (stored && !stored.questionKey) {
          db.updateWatched(group.chainId, log.args.question_id, { ...row, createdBlock: log.blockNumber.toString(), createdTs: createdOf(log)?.toString() ?? null, createdFinal: createdOf(log) !== null });
        }
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

  // An event names a hub proposal only when the question is, as a whole, that proposal's question ('' otherwise).
  const base = (q) => ({ chainId: q.chainId, safe: q.safe, module: q.module, questionId: q.questionId, proposalId: q.eventProposalId ?? '' });
  /** The row as stored now (decisionFor may have read it again), with the proposal its events may name. */
  const judged = (q, decision) => {
    const row = db.getWatched(q.chainId, q.questionId) ?? q;
    return { ...row, eventProposalId: decision.matched ? row.proposalId : '' };
  };
  /** The module's key of the question's whole text, for the detail of an event (null when not read yet). */
  const keyOf = (q) => db.getWatched(q.chainId, q.questionId)?.questionKey ?? q.questionKey ?? null;

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
        expectedAnswer: expected === null ? null : answerName(expected),
        deadline: isoOf(finalizeTs),
        deadlineTs: Number(finalizeTs),
        questionHash: keyOf(q),
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
    // The challenge is out. First the mark that makes the next pass wait for its receipt
    // instead of challenging again; then the bookkeeping, each step logged when it fails and never thrown, as the
    // send routes do after a broadcast.
    const after = (what, fn) => {
      try {
        fn();
      } catch (e) {
        logger.error(`ALERT challenge ${sent.hash} of ${q.questionId} on ${q.chainId} is out, but ${what} failed: ${e?.name ?? 'Error'}`);
      }
    };
    after('marking it in flight', () => db.updateWatched(q.chainId, q.questionId, { flagged: true, challengedBond: bondKey, challengeNonce: sent.nonce, challengeAttempts: attempts + 1 }));
    // Reclaim works from this row. The history it rebuilds starts at the block the question was asked in,
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
        questionHash: keyOf(q),
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
        decision = await decisionFor(q, clients, reality, cache);
      } catch (e) {
        if (e instanceof HubError) return;
        throw e;
      }
      // Not decided: the question stays open, and the next tick asks again.
      if (decision.answer === null) return;
      q = judged(q, decision);
      // A final no on a proposal's own question asked before its vote ended stops that proposal for good if it passes:
      // the question stays open until the vote is final, and is then judged by the same rule.
      if (decision.voteOpen && decision.reason === 'asked_before_resolution' && result === ANSWER_BYTES.no) return;
      if (worthChallenging(result, decision)) {
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
            questionHash: keyOf(q),
          },
        });
        actions.push({ action: 'wrong_final', chainId: q.chainId, questionId: q.questionId });
      } else if (q.flagged) {
        feed.add('resolved', { ...base(q), detail: { answer: decision.answer, reason: decision.reason, questionHash: keyOf(q) } });
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
      decision = await decisionFor(q, clients, reality, cache);
    } catch (e) {
      if (e instanceof HubError) {
        logger.warn(`watcher: hub not readable for ${q.proposalId} (${e.code}); question left for the next tick`);
        return;
      }
      throw e;
    }
    q = judged(q, decision);
    if (decision.answer === null) {
      // Nothing is challenged on a guess. Only a yes moves money, so a standing yes is told to the organizers.
      logger.warn(`watcher: no answer decided for ${q.questionId} on ${q.chainId} (${decision.reason}); question left for the next tick`);
      if (best === ANSWER_BYTES.yes) escalate(q, { reason: 'cannot_decide', bond, best, expected: null, finalizeTs: await read('getFinalizeTS'), extra: { decisionReason: decision.reason } }, actions);
      return;
    }
    // A standing answer that already stops the payment is left alone (no bond is spent on it).
    if (!worthChallenging(best, decision)) return;
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
