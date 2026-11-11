// POST /send/ens and GET /jobs/:id: a <label>.eth name registered through the ENSv2 registrar, paid by
// the relayer, owned by the Group's Safe from the register call (D-08, RESEARCH Pattern 2, TM-76).
//
// The job runs: mint the payment token (only on networks flagged testnet), approve the registrar,
// commit, wait until the chain's clock is MIN_COMMITMENT_AGE + 1 s past the commit block, register with
// owner = the Safe, then read the owner back through the UniversalHelper. Every step goes through the
// allowlist, cap.reserve and the serial queue like any other sponsored send. The relayer never sets a
// resolver or a record: subregistry and resolver are zero, so the owner can do that later.
//
// Refusals happen before anything is sent: a label that fails the ENSIP-15 subset, a network without ENS,
// an owner that is not a registered Safe, a label that is not the Safe's registered space, a taken name.
import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, encodeFunctionData, getAddress, isAddress, keccak256, parseAbi, toHex, zeroAddress, zeroHash } from 'viem';
import { normalize, packetToBytes } from 'viem/ens';
import { build, SELECTORS } from '../allowlist.js';
import { CapReached } from '../cap.js';
import { chainIsConfigured, chainIsSponsored, NOT_SPONSORED } from '../config.js';
import { isRegistered } from '../registration.js';
import { ownHashes } from './pipeline.js';

/** Registration length: one year, in seconds (the registrar's minimum is 28 days). */
export const DURATION_SECONDS = 365n * 24n * 60n * 60n;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

const registrarAbi = parseAbi([
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function MIN_COMMITMENT_AGE() view returns (uint256)',
]);
const tokenAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);
const helperAbi = parseAbi(['function findExactOwner(bytes name) view returns (address)']);

/**
 * The label rules for a Group's space name (the same rules as isValidLabel in
 * fresh3 tests/governance/lib/governance.mjs): lowercase a-z, 0-9 and hyphen, 3 to 40 characters, never a
 * hyphen in both the third and fourth position. That set is ASCII and already normalized.
 */
export function isValidLabel(label) {
  if (typeof label !== 'string') return false;
  if (!/^[a-z0-9-]{3,40}$/.test(label)) return false;
  if (label[2] === '-' && label[3] === '-') return false;
  try {
    return normalize(label) === label;
  } catch {
    return false;
  }
}

/** keccak256(abi.encode(label, owner, secret, subregistry, resolver, duration, referrer)): ETHRegistrar.makeCommitment. */
export function ensCommitment(c) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint64' }, { type: 'bytes32' }],
      [c.label, c.owner, c.secret, c.subregistry, c.resolver, BigInt(c.duration), c.referrer],
    ),
  );
}

/** Validate the wire body of POST /send/ens. Returns {ok, value} or {ok: false, error}. */
export function parseEnsBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const { chainId, safe, label } = body;
  if (!Number.isInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof safe !== 'string' || !isAddress(safe, { strict: false })) return { ok: false, error: 'safe must be an address' };
  if (typeof label !== 'string') return { ok: false, error: 'label must be a string' };
  return { ok: true, value: { chainId, safe: getAddress(safe), label } };
}

// Job failures that are known to come before the register transaction is handed to the queue: the
// steps before it, and the register step's own checks and refusals ahead of its send.
const STEPS_BEFORE_REGISTER = new Set(['price', 'balance', 'mint', 'approve', 'commit', 'wait']);
const FAILED_BEFORE_REGISTER_SEND = new Set([
  'chain_not_available',
  'payment_token_balance_too_low',
  'register:name_taken',
  'register:unreadable',
  'register:price_changed',
  'register:simulation_failed',
  'register:fee_estimate_failed',
  'register:cap_reached',
]);

/**
 * Has this name job started registering? Every job that has not failed has (pending, committed and
 * registered), and so has one that failed at or after the register send, or at a point not known
 * (internal, interrupted_by_restart): its register transaction may still be mined. Only a job that
 * failed before the register send has not. While any job for a Safe's space has started, the space
 * cannot be replaced (POST /groups, 25-19 follow-up).
 */
export function nameJobStarted(job) {
  if (job.status !== 'failed') return true;
  const error = String(job.error ?? '');
  if (FAILED_BEFORE_REGISTER_SEND.has(error)) return false;
  const step = error.includes(':') ? error.slice(0, error.indexOf(':')) : null;
  return !(step !== null && STEPS_BEFORE_REGISTER.has(step));
}

class JobError extends Error {}
const fail = (code) => new JobError(code);

const refuse = (status, reason, extra = {}) => ({ status, body: { error: status === 409 ? 'conflict' : status === 400 ? 'bad_request' : 'forbidden', reason, ...extra }, refusal: status === 403 ? reason : undefined });

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the chain's latest block is at or past `target` (seconds). On a real chain blocks keep coming,
 * so this ends by itself. Tests on an idle local chain pass their own `wait` that moves the chain's clock.
 */
async function defaultWait({ publicClient, target, sleep }) {
  for (;;) {
    let block;
    try {
      block = await publicClient.getBlock({ blockTag: 'latest' });
    } catch {
      throw fail('wait:read_failed');
    }
    if (block.timestamp >= target) return;
    await sleep(2000);
  }
}

export function createEns({ db, config, networks, chains, cap, queue, logger = console, wait = null, sleep = defaultSleep, pollMs = 1000, timeoutMs = JOB_TIMEOUT_MS }) {
  const inflight = new Set();
  const waitFn = wait ?? defaultWait;

  const view = (job) => ({
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    chainId: job.chainId,
    safe: job.safe,
    label: job.label,
    txHashes: job.hashes,
    ...(job.status === 'failed' ? { error: job.error } : {}),
  });

  /** The first receipt among the send's own hashes (a fee bump changes the hash); never another send's. */
  async function waitMined(chainId, sent, step) {
    const { publicClient } = chains.get(chainId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const hash of [...ownHashes(db, sent)].reverse()) {
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash });
          if (receipt) return receipt;
        } catch {
          // not mined under this hash yet
        }
      }
      if (Date.now() > deadline) throw fail(`${step}:timeout`);
      await sleep(pollMs);
    }
  }

  /** One sponsored send: allowlist, estimate, cap.reserve, queue, then wait for the receipt. */
  async function step(job, ctx, name, target, selectorName, data) {
    const verdict = ctx.list.check(job.chainId, target, SELECTORS[selectorName]);
    if (!verdict.ok) throw fail(`${name}:${verdict.reason}`);
    const { publicClient } = ctx.clients;
    let gas;
    try {
      gas = await publicClient.estimateGas({ account: config.address, to: target, data });
    } catch {
      throw fail(`${name}:simulation_failed`);
    }
    let fees;
    try {
      fees = await publicClient.estimateFeesPerGas();
    } catch {
      throw fail(`${name}:fee_estimate_failed`);
    }
    const gasLimit = (gas * 12n) / 10n;
    let reservation;
    try {
      reservation = cap.reserve(job.chainId, gasLimit * fees.maxFeePerGas);
    } catch (e) {
      if (e instanceof CapReached) throw fail(`${name}:cap_reached`);
      throw e;
    }
    let sent;
    try {
      sent = await queue.enqueue(
        job.chainId,
        () => ({ to: target, data, value: 0n, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }),
        { reservation, safe: job.safe, kind: `ens-${name}` },
      );
    } catch {
      cap.release(reservation);
      throw fail(`${name}:send_failed`);
    }
    // The send is out: a bookkeeping failure is logged and the job goes on with the hash (25-28 round 2, MEDIUM 5).
    try {
      db.recordSend({ chainId: job.chainId, safe: job.safe, kind: `ens-${name}`, txHash: sent.hash });
    } catch (e) {
      logger.error(`recording ens ${name} ${job.chainId} ${sent.hash} failed: ${e?.name ?? 'Error'}`);
    }
    ctx.hashes.push(sent.hash);
    db.updateJob(job.id, { status: ctx.status, hashes: ctx.hashes });
    logger.info(`ens ${name} ${job.chainId} ${job.label} ${sent.hash}`);
    const receipt = await waitMined(job.chainId, sent, name);
    if (receipt.status !== 'success') throw fail(`${name}:reverted`);
    return receipt;
  }

  async function run(id) {
    const job = db.getJob(id);
    const ctx = { hashes: [], status: 'pending' };
    try {
      const net = networks[String(job.chainId)];
      const clients = chains.get(job.chainId);
      if (!clients?.walletClient) throw fail('chain_not_available');
      ctx.clients = clients;
      ctx.list = build(networks, db.listGroups());
      const { publicClient } = clients;
      const registrar = net.ensRegistrar;
      const token = net.ensPaymentToken;
      const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });

      let total;
      try {
        const [base, premium] = await read(registrar, registrarAbi, 'getRegisterPrice', [job.label, DURATION_SECONDS, token]);
        total = base + premium;
      } catch {
        throw fail('price:unreadable');
      }

      if (net.testnet === true) {
        // Only networks flagged testnet in config/networks.json have a token anyone may mint.
        await step(job, ctx, 'mint', token, 'mint', encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [config.address, total] }));
      } else {
        let balance;
        try {
          balance = await read(token, tokenAbi, 'balanceOf', [config.address]);
        } catch {
          throw fail('balance:unreadable');
        }
        if (balance < total) throw fail('payment_token_balance_too_low');
      }
      await step(job, ctx, 'approve', token, 'approve', encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [registrar, total] }));

      const reveal = {
        label: job.label,
        owner: job.safe,
        secret: job.secret,
        subregistry: zeroAddress,
        resolver: zeroAddress,
        duration: DURATION_SECONDS,
        referrer: zeroHash,
      };
      const commitReceipt = await step(job, ctx, 'commit', registrar, 'commit', encodeFunctionData({ abi: registrarAbi, functionName: 'commit', args: [ensCommitment(reveal)] }));
      ctx.status = 'committed';
      db.updateJob(job.id, { status: 'committed', hashes: ctx.hashes });

      // The registrar accepts a reveal once the commit is MIN_COMMITMENT_AGE old; one more second for the block it lands in.
      let target;
      try {
        const [age, block] = await Promise.all([
          read(registrar, registrarAbi, 'MIN_COMMITMENT_AGE'),
          publicClient.getBlock({ blockNumber: commitReceipt.blockNumber }),
        ]);
        target = BigInt(block.timestamp) + BigInt(age) + 1n;
      } catch {
        throw fail('wait:read_failed');
      }
      await waitFn({ publicClient, chainId: job.chainId, target, sleep, pollMs });

      // Last look before paying: still free, and not dearer than what was approved.
      let available;
      let quote;
      try {
        available = await read(registrar, registrarAbi, 'isAvailable', [job.label]);
        quote = await read(registrar, registrarAbi, 'getRegisterPrice', [job.label, DURATION_SECONDS, token]);
      } catch {
        throw fail('register:unreadable');
      }
      if (available !== true) throw fail('register:name_taken');
      if (quote[0] + quote[1] > total) throw fail('register:price_changed');
      await step(
        job,
        ctx,
        'register',
        registrar,
        'register',
        encodeFunctionData({
          abi: registrarAbi,
          functionName: 'register',
          args: [reveal.label, reveal.owner, reveal.secret, reveal.subregistry, reveal.resolver, reveal.duration, token, reveal.referrer],
        }),
      );

      if (net.ensUniversalHelper) {
        let owner;
        try {
          owner = await read(net.ensUniversalHelper, helperAbi, 'findExactOwner', [toHex(packetToBytes(`${job.label}.eth`))]);
        } catch {
          throw fail('register:owner_unreadable');
        }
        if (getAddress(owner) !== job.safe) throw fail('register:owner_mismatch');
      }
      db.updateJob(job.id, { status: 'registered', hashes: ctx.hashes });
      logger.info(`ens registered ${job.chainId} ${job.label}`);
    } catch (e) {
      const code = e instanceof JobError ? e.message : 'internal';
      if (!(e instanceof JobError)) logger.error(`ens job failed: ${e?.name ?? 'Error'}`);
      db.updateJob(job.id, { status: 'failed', hashes: ctx.hashes, error: code });
      logger.warn(`ens job ${job.chainId} ${job.label} failed: ${code}`);
    }
  }

  return {
    /** Check a request and, if it passes every refusal, start the job. Returns {status, body, refusal?}. */
    async request({ chainId, safe, label }) {
      if (!isValidLabel(label)) return refuse(400, 'invalid_label');
      if (!chainIsConfigured(networks, chainId)) return refuse(403, 'unknown_chain');
      const net = networks[String(chainId)];
      if (!net.ensRegistrar || !net.ensPaymentToken) return refuse(403, 'no_ens_on_network', { detail: 'no ENS on this network' });
      // Before the job and any send (25-28 round 3, #4): the relayer does not pay for sends on this chain.
      if (!chainIsSponsored(networks, chainId)) return { status: 503, body: { ...NOT_SPONSORED } };
      if (!isRegistered(db, chainId, safe)) return refuse(403, 'safe_not_registered');
      if (db.getGroup(chainId, safe).space !== `${label}.eth`) return refuse(403, 'label_not_space');
      const clients = chains.get(chainId);
      if (!clients?.walletClient || !config.configured) return { status: 503, body: { error: 'unavailable', reason: 'chain_not_available' } };
      if (db.findOpenJob(chainId, label)) return refuse(409, 'job_in_progress');
      let available;
      try {
        available = await clients.publicClient.readContract({ address: net.ensRegistrar, abi: registrarAbi, functionName: 'isAvailable', args: [label] });
      } catch {
        return { status: 502, body: { error: 'send_failed', reason: 'availability_unreadable', broadcast: false } };
      }
      if (available !== true) return refuse(409, 'name_taken');

      // The space can be replaced and another job can start while the availability read is out, so both
      // checks run again together with the insert: a job only ever starts for the space still registered.
      const id = randomBytes(16).toString('hex');
      const refused = db.atomically(() => {
        if (db.getGroup(chainId, safe)?.space !== `${label}.eth`) return refuse(403, 'label_not_space');
        if (db.findOpenJob(chainId, label)) return refuse(409, 'job_in_progress');
        db.insertJob({ id, kind: 'ens', chainId, safe, label, secret: toHex(randomBytes(32)) });
        return null;
      });
      if (refused) return refused;
      const job = run(id).finally(() => inflight.delete(job));
      inflight.add(job);
      return { status: 202, body: { jobId: id, status: 'pending' } };
    },

    /** GET /jobs/:id. */
    job(id) {
      const job = db.getJob(id);
      if (!job) return { status: 404, body: { error: 'not_found', reason: 'job_not_found' } };
      return { status: 200, body: view(job) };
    },

    /** At boot: a job a restart interrupted is marked failed, never resumed (a re-run could pay twice). */
    resume() {
      return db.failOpenJobs('interrupted_by_restart');
    },

    /** Resolves when no job is running. */
    async idle() {
      while (inflight.size) await Promise.all([...inflight]);
    },
  };
}
