// The three Reality steps anyone may call, sent and paid by the relayer (D-09, D-16, UX-01):
//   POST /send/reality/add      Zodiac module addProposal       (the vote resolved: closed, final, passed)
//   POST /send/reality/answer   Reality submitAnswer            (value = the module's minimumBond)
//   POST /send/reality/execute  module executeProposalWithIndex (finalized yes, cooldown over)
//
// Members and organizers sign nothing for these. A request names a Group and a proposal and nothing else that matters:
// the transactions, the question, the answer and the bond all come from the relayer's own reads of the hub and the
// chain. The module is the one groups.js found on the chain for the Safe; no request can name one. An answer posted
// here carries no special weight: anyone can challenge it with a higher bond, and the Group Safe owns the arbitrator.
import { encodeFunctionData, getAddress, isAddress, parseAbi, zeroHash } from 'viem';
import { build } from '../allowlist.js';
import { chainIsConfigured, chainIsSponsored, NOT_SPONSORED } from '../config.js';
import { ANSWER_BYTES, createAnswerer } from '../answer.js';
import { HubError } from '../hub.js';
import { questionHashOf } from '../realityHash.js';
import { createPipeline } from './pipeline.js';

const moduleAbi = parseAbi([
  'function addProposal(string proposalId, bytes32[] txHashes)',
  'function executeProposalWithIndex(string proposalId, bytes32[] txHashes, address to, uint256 value, bytes data, uint8 operation, uint256 txIndex)',
  'function questionIds(bytes32 questionHash) view returns (bytes32)',
  'function executedProposalTransactions(bytes32 questionHash, bytes32 txHash) view returns (bool)',
  'function minimumBond() view returns (uint256)',
  'function questionCooldown() view returns (uint32)',
  'function buildQuestion(string proposalId, bytes32[] txHashes) view returns (string)',
  'function getQuestionId(string question, uint256 nonce) view returns (bytes32)',
]);
const realityAbi = parseAbi([
  'function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable',
  'function isFinalized(bytes32 question_id) view returns (bool)',
  'function getFinalizeTS(bytes32 question_id) view returns (uint32)',
  'function getBond(bytes32 question_id) view returns (uint256)',
  'function resultFor(bytes32 question_id) view returns (bytes32)',
]);

const PROPOSAL_ID = /^0x[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_HASHES = 64;

/** Validate the wire body. `txHashes` (add) and `txIndex` (execute) are optional. Unknown fields are ignored. */
export function parseRealityBody(body, { route }) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const bad = (field, why) => ({ ok: false, error: `${field} ${why}` });
  if (!Number.isInteger(body.chainId) || body.chainId <= 0) return bad('chainId', 'must be a positive integer');
  if (typeof body.safe !== 'string' || !isAddress(body.safe, { strict: false })) return bad('safe', 'must be an address');
  if (typeof body.proposalId !== 'string' || !PROPOSAL_ID.test(body.proposalId)) return bad('proposalId', 'must be the hub proposal id: 0x and 64 lowercase hex digits');
  const value = { chainId: body.chainId, safe: getAddress(body.safe), proposalId: body.proposalId };
  if (route === 'add' && body.txHashes !== undefined) {
    if (!Array.isArray(body.txHashes) || body.txHashes.length === 0 || body.txHashes.length > MAX_HASHES || !body.txHashes.every((h) => typeof h === 'string' && HASH.test(h))) {
      return bad('txHashes', 'must be a list of 32-byte hex hashes');
    }
    value.txHashes = body.txHashes.map((h) => h.toLowerCase());
  }
  if (route === 'execute' && body.txIndex !== undefined) {
    if (!Number.isInteger(body.txIndex) || body.txIndex < 0 || body.txIndex >= MAX_HASHES) return bad('txIndex', 'must be a small non-negative integer');
    value.txIndex = body.txIndex;
  }
  return { ok: true, value };
}

const reply = (status, body, refusal) => ({ status, body, ...(refusal ? { refusal } : {}) });

// How a verdict from answer.js that is not "ok" is shown to the caller.
const VERDICT_REPLY = {
  unknown_group: (v) => reply(403, { error: 'forbidden', reason: 'safe_not_registered' }, 'safe_not_registered'),
  unknown_proposal: () => reply(404, { error: 'not_found', reason: 'proposal_not_found' }),
  wrong_space: () => reply(403, { error: 'forbidden', reason: 'proposal_wrong_space' }, 'proposal_wrong_space'),
  not_final: (v) => reply(409, { error: 'conflict', reason: 'proposal_not_final', state: v.proposal?.state, scoresState: v.proposal?.scoresState }),
  not_passed: (v) => reply(409, { error: 'conflict', reason: 'proposal_not_passed', detail: v.reason }),
  no_transactions: () => reply(400, { error: 'bad_request', reason: 'no_transactions' }),
  plugin_other_module: () => reply(400, { error: 'bad_request', reason: 'plugin_other_module' }),
  bad_plugin: () => reply(400, { error: 'bad_request', reason: 'bad_plugin' }),
};
const fromVerdict = (v) => VERDICT_REPLY[v.kind](v);

export function createReality({ db, config, networks, chains, cap, queue, groupModules, hub, answerer = null, pipeline = null, logger = console }) {
  const answers = answerer ?? createAnswerer({ hub, db, logger });
  const pipe = pipeline ?? createPipeline({ config, db, chains, cap, queue, logger });

  /** Everything every step needs before it reads the hub: the chain, the registered Group and its module. */
  async function prelude(v) {
    if (!config.configured) return { err: reply(503, { error: 'unavailable', reason: 'not_configured' }) };
    const clients = chainIsConfigured(networks, v.chainId) ? chains.get(v.chainId) : null;
    if (!clients) return { err: reply(403, { error: 'forbidden', reason: 'unknown_chain' }, 'unknown_chain') };
    // Before any hub or chain read (25-28 round 3, #4): the relayer does not pay for sends on this chain.
    if (!chainIsSponsored(networks, v.chainId)) return { err: reply(503, { ...NOT_SPONSORED }) };
    const net = networks[String(v.chainId)];
    if (!net.reality) return { err: reply(403, { error: 'forbidden', reason: 'no_reality_on_network' }, 'no_reality_on_network') };
    if (!db.getGroup(v.chainId, v.safe)) return { err: reply(403, { error: 'forbidden', reason: 'safe_not_registered' }, 'safe_not_registered') };
    const modules = await groupModules.modulesFor(v.chainId, v.safe);
    if (modules.length === 0) return { err: reply(409, { error: 'conflict', reason: 'module_not_found' }) };
    if (modules.length > 1) return { err: reply(409, { error: 'conflict', reason: 'multiple_modules' }) };
    const module = modules[0];
    return { clients, module, reality: net.reality, list: build(networks, db.listGroups(), [{ chainId: v.chainId, module }]) };
  }

  /**
   * Run a step; a hub or chain read that fails becomes a 502/503 with a code and no detail. `fn` gets `sent(out,
   * extra)`, to call on the pipeline's answer: once a send is out, anything that fails after it is logged and the
   * answer is 202 with the hash (25-28 round 2, MEDIUM 5). A 502 there would hide a live send and invite a retry.
   */
  async function guarded(name, fn) {
    let out = null;
    const sent = (s, extra = {}) => {
      if (s?.ok) out = { hash: s.hash, extra: s.duplicate ? { ...extra, duplicate: true } : extra };
      return s;
    };
    try {
      return await fn(sent);
    } catch (e) {
      if (out) {
        logger.error(`reality ${name}: bookkeeping after the broadcast of ${out.hash} failed: ${e?.name ?? 'Error'}`);
        return reply(202, { hash: out.hash, status: 'pending', ...out.extra });
      }
      if (e instanceof HubError) return e.code === 'hub_rate_limited' ? reply(503, { error: e.code }) : reply(502, { error: e.code, broadcast: false });
      logger.warn(`reality ${name} read failed: ${e?.shortMessage ?? e?.name ?? 'error'}`);
      return reply(502, { error: 'read_failed', broadcast: false });
    }
  }

  const readModule = (ctx, functionName, args = []) => ctx.clients.publicClient.readContract({ address: ctx.module, abi: moduleAbi, functionName, args });
  const readReality = (ctx, functionName, args = []) => ctx.clients.publicClient.readContract({ address: ctx.reality, abi: realityAbi, functionName, args });
  const sendReply = (sent, ok) => (sent.ok ? reply(202, { hash: sent.hash, status: 'pending', ...ok, ...(sent.duplicate ? { duplicate: true } : {}) }) : reply(sent.status, sent.body, sent.refusal));

  return {
    /** addProposal(proposalId, txHashes): only after the hub says closed, final and passed. */
    add(v) {
      return guarded('add', async (track) => {
        const ctx = await prelude(v);
        if (ctx.err) return ctx.err;
        const verdict = await answers.evaluate({ chainId: v.chainId, safe: v.safe, module: ctx.module, proposalId: v.proposalId });
        if (verdict.kind !== 'ok') return fromVerdict(verdict);
        if (v.txHashes && v.txHashes.join() !== verdict.txHashes.map((h) => h.toLowerCase()).join()) {
          return reply(409, { error: 'conflict', reason: 'tx_hashes_mismatch' });
        }
        // The module's own view must agree with the local question before anything is asked.
        if ((await readModule(ctx, 'buildQuestion', [v.proposalId, verdict.txHashes])) !== verdict.question) {
          return reply(409, { error: 'conflict', reason: 'question_mismatch' });
        }
        const existing = await readModule(ctx, 'questionIds', [questionHashOf(verdict.question)]);
        if (existing !== zeroHash) return reply(409, { error: 'conflict', reason: 'already_asked', questionId: existing });
        const questionId = await readModule(ctx, 'getQuestionId', [verdict.question, 0n]);
        const data = encodeFunctionData({ abi: moduleAbi, functionName: 'addProposal', args: [v.proposalId, verdict.txHashes] });
        const sent = track(await pipe.send({ chainId: v.chainId, safe: v.safe, to: ctx.module, selectorName: 'addProposal', data, kind: 'reality-add', list: ctx.list, dedupeKey: `reality-add:${v.chainId}:${questionId}` }), { questionId });
        return sendReply(sent, { questionId });
      });
    },

    /** submitAnswer(questionId, answer, 0) with value = minimumBond. The answer is decide()'s, never the request's. */
    answer(v) {
      return guarded('answer', async (track) => {
        const ctx = await prelude(v);
        if (ctx.err) return ctx.err;
        const verdict = await answers.evaluate({ chainId: v.chainId, safe: v.safe, module: ctx.module, proposalId: v.proposalId });
        if (['unknown_group', 'unknown_proposal', 'wrong_space'].includes(verdict.kind)) return fromVerdict(verdict);
        // Without the plugin's transactions there is no question to find.
        if (!verdict.question) return VERDICT_REPLY[verdict.pluginReason](verdict);

        // The block before any check: the history reclaim.js rebuilds starts here, so no earlier answer can be missed.
        const fromBlock = await ctx.clients.publicClient.getBlockNumber({ cacheTime: 0 });
        const questionId = await readModule(ctx, 'questionIds', [questionHashOf(verdict.question)]);
        if (questionId === zeroHash) return reply(409, { error: 'conflict', reason: 'question_not_asked' });
        if (db.getQuestion(v.chainId, questionId)) return reply(409, { error: 'conflict', reason: 'already_answered', questionId });
        if (await readReality(ctx, 'isFinalized', [questionId])) return reply(409, { error: 'conflict', reason: 'already_final', questionId });
        if ((await readReality(ctx, 'getBond', [questionId])) > 0n) return reply(409, { error: 'conflict', reason: 'already_answered', questionId });

        // The question was found under the hash of the transactions the hub lists, so that is its hash.
        const decision = answers.decideFromVerdict(verdict, verdict.packedHash);
        const bond = await readModule(ctx, 'minimumBond');
        const data = encodeFunctionData({ abi: realityAbi, functionName: 'submitAnswer', args: [questionId, ANSWER_BYTES[decision.answer], 0n] });
        const bondRef = `bond:${v.chainId}:${questionId}`;
        const sent = track(await pipe.send({
          chainId: v.chainId,
          safe: v.safe,
          to: ctx.reality,
          selectorName: 'submitAnswer',
          data,
          value: bond,
          kind: 'reality-answer',
          list: ctx.list,
          reserve: { kind: 'bond', ref: bondRef },
          dedupeKey: `reality-answer:${v.chainId}:${questionId}`,
        }), { questionId, answer: decision.answer, reason: decision.reason });
        // A duplicate is the earlier request's send: that request stores the question, with the block it started from.
        if (sent.ok && !sent.duplicate) {
          db.insertQuestion({ chainId: v.chainId, questionId, module: ctx.module, safe: v.safe, proposalId: v.proposalId, answer: decision.answer, bondWei: bond, bondRef, fromBlock, txHash: sent.hash });
        }
        return sendReply(sent, { questionId, answer: decision.answer, reason: decision.reason });
      });
    },

    /** executeProposalWithIndex: simulated first; the module's cooldown is checked against the chain's latest block. */
    execute(v) {
      return guarded('execute', async (track) => {
        const ctx = await prelude(v);
        if (ctx.err) return ctx.err;
        const verdict = await answers.evaluate({ chainId: v.chainId, safe: v.safe, module: ctx.module, proposalId: v.proposalId });
        if (verdict.kind !== 'ok') return fromVerdict(verdict);
        const txIndex = v.txIndex ?? 0;
        const tx = verdict.txs[txIndex];
        if (!tx) return reply(400, { error: 'bad_request', reason: 'tx_index_out_of_range' });

        const questionHash = questionHashOf(verdict.question);
        const questionId = await readModule(ctx, 'questionIds', [questionHash]);
        if (questionId === zeroHash) return reply(409, { error: 'conflict', reason: 'question_not_asked' });
        if (await readModule(ctx, 'executedProposalTransactions', [questionHash, verdict.txHashes[txIndex]])) {
          return reply(409, { error: 'conflict', reason: 'already_executed', questionId });
        }
        if (!(await readReality(ctx, 'isFinalized', [questionId]))) return reply(409, { error: 'conflict', reason: 'not_finalized', questionId });
        if ((await readReality(ctx, 'resultFor', [questionId])) !== ANSWER_BYTES.yes) return reply(409, { error: 'conflict', reason: 'answer_not_yes', questionId });

        // The module wants a block strictly after finalize time + cooldown. Until the chain has one, nothing is sent.
        const [finalizeTs, cooldown, latest] = await Promise.all([
          readReality(ctx, 'getFinalizeTS', [questionId]),
          readModule(ctx, 'questionCooldown'),
          ctx.clients.publicClient.getBlock(),
        ]);
        const readyAfter = BigInt(finalizeTs) + BigInt(cooldown);
        if (latest.timestamp <= readyAfter) return reply(409, { error: 'conflict', reason: 'cooldown', questionId, until: Number(readyAfter) + 1 });

        const data = encodeFunctionData({
          abi: moduleAbi,
          functionName: 'executeProposalWithIndex',
          args: [v.proposalId, verdict.txHashes, tx.to, tx.value, tx.data, tx.operation, BigInt(txIndex)],
        });
        const sent = track(await pipe.send({ chainId: v.chainId, safe: v.safe, to: ctx.module, selectorName: 'executeProposalWithIndex', data, kind: 'reality-execute', list: ctx.list, dedupeKey: `reality-execute:${v.chainId}:${questionId}:${txIndex}` }), { questionId, txIndex });
        return sendReply(sent, { questionId, txIndex });
      });
    },
  };
}
