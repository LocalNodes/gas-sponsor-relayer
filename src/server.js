// The relayer's HTTP surface (node:http). JSON in, JSON out, 64 KB body limit.
// Every route but GET /healthz needs the bearer token. The sending key never leaves config.
// With web3 off (WEB3_ENABLED not exactly 'true') only GET /healthz answers; the rest is 503 web3_disabled.
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { chainIsConfigured, loadConfig, loadNetworks } from './config.js';
import { openDb } from './db.js';
import { createChains } from './chain.js';
import { requireToken } from './auth.js';
import { parseRegistrationBody, storeRegistration, verifyRegistration } from './registration.js';
import { parseSafeExecBody, safeExec } from './sends/safeExec.js';
import { createEns, parseEnsBody } from './sends/ens.js';
import { SELECTORS } from './allowlist.js';
import { createCap } from './cap.js';
import { createQueue } from './queue.js';
import { createGroupModules } from './groups.js';
import { createHub } from './hub.js';
import { createReality, parseRealityBody } from './sends/reality.js';
import { createReclaim } from './reclaim.js';
import { createEvents } from './events.js';
import { createWatcher, watchSettingsFromEnv } from './watcher.js';

const BODY_LIMIT = 64 * 1024;

/** Every route the server answers when web3 is on. A test holds the dispatch table to this list. */
export const ROUTES = [
  'GET /events',
  'GET /healthz',
  'GET /jobs/:id',
  'GET /ops/recheck',
  'GET /sends/:hash',
  'GET /status',
  'POST /groups',
  'POST /ops/recheck',
  'POST /send/ens',
  'POST /send/reality/add',
  'POST /send/reality/answer',
  'POST /send/reality/execute',
  'POST /send/safe-exec',
];

// GET /events?since=<id>: the cursor is a whole number of at most 16 digits.
const SINCE = /^(0|[1-9][0-9]{0,15})$/;

// GET /jobs/<32 hex digits> and GET /sends/<transaction hash>: the routes with a parameter.
const JOB_PATH = /^\/jobs\/([0-9a-f]{32})$/;
const SEND_PATH = /^\/sends\/(0x[0-9a-fA-F]{64})$/;

/**
 * What GET /sends/:hash shows of a send (25-28 round 2, HIGH 4 (vi)). `status`: `pending` (still waiting; `stuck`
 * says the fee bumps ran out), `mined` (one of its own hashes mined: `minedHash`), or `not_sent` (proven at the
 * finalized block: another transaction, `consumedBy` in block `consumedBlock`, took its nonce, so none of its
 * hashes can ever mine; its reservation was given back).
 * A mined send also says `finalized` (25-28 round 3, #2): false while its receipt's block is not finalized yet (a
 * reorg can still put it back to `pending`), true once it is and the spend cap has the real cost.
 */
export function sendView(row, hash) {
  const mined = row.status === 'mined' || row.status === 'confirming';
  const status = mined ? 'mined' : row.status === 'replaced' ? 'not_sent' : 'pending';
  return {
    hash: hash.toLowerCase(),
    chainId: row.chainId,
    nonce: row.nonce,
    status,
    stuck: row.status === 'stuck',
    hashes: row.hashes,
    ...(mined ? { minedHash: row.consumedBy, finalized: row.status === 'mined' } : {}),
    ...(status === 'not_sent' ? { consumedBy: row.consumedBy, consumedBlock: row.consumedBlock } : {}),
  };
}

/**
 * The longest GET /status waits for one chain's reads (its balance and nonces, or one Group's module
 * lookup). viem's own transport timeout (10 s, with retries) is left alone because sends use it; a chain
 * that has not answered in time reads {"error": "unreachable"}, so a stalled RPC can't hold the whole
 * answer past the callers' timeouts (25-10: 41 s on the lane against gas_sponsor's 10 s).
 */
export const STATUS_READ_TIMEOUT_MS = 3000;

class ReadTimedOut extends Error {}

/** Resolves as `promise` does, or rejects with ReadTimedOut after `ms`. The timer never holds the process open. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimedOut()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function send(res, status, body, reason) {
  const text = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
  if (status === 413) headers.connection = 'close';
  if (reason) res.writeHead(status, reason, headers);
  else res.writeHead(status, headers);
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    req.on('data', (c) => {
      size += c.length;
      if (done) return;
      if (size > BODY_LIMIT) {
        // Answer 413 now, discard the rest of the upload, and let `Connection: close` end the socket.
        finish({ error: 413 });
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        finish({ error: 400 });
      }
    });
    req.on('error', () => finish({ error: 400 }));
  });
}

export function createServer({ config, networks, db, chains, cap, queue, groupModules = null, ens = null, hub = null, reality = null, events = null, logger = console }) {
  const modules = groupModules ?? (chains ? createGroupModules({ networks, chains }) : null);
  const ensService = ens ?? (db && chains && cap && queue ? createEns({ db, config, networks, chains, cap, queue, logger }) : null);
  const realityService =
    reality ?? (db && chains && cap && queue && modules ? createReality({ db, config, networks, chains, cap, queue, groupModules: modules, hub: hub ?? createHub({ networks, config }), logger }) : null);
  const feed = events ?? (db ? createEvents({ db }) : null);
  const refused = (r, chainId, target, selector) => logger.warn(`refused ${r} ${chainId ?? '-'} ${target ?? '-'} ${selector ?? '-'}`);

  async function groups(req, res) {
    if (!config.configured || !config.community) return send(res, 503, { error: 'unavailable', reason: 'not_configured' });
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: body.error === 413 ? 'body_too_large' : 'bad_request' });
    const parsed = parseRegistrationBody(body.value);
    if (!parsed.ok) return send(res, 400, { error: 'bad_request', reason: parsed.error });
    const { chainId, safe, space, signature } = parsed.value;
    const clients = chainIsConfigured(networks, chainId) ? chains.get(chainId) : null;
    if (!clients) {
      refused('unknown_chain', chainId, safe, '-');
      return send(res, 403, { error: 'forbidden', reason: 'unknown_chain' });
    }
    const valid = await verifyRegistration({
      publicClient: clients.publicClient,
      relayer: config.address,
      community: config.community,
      chainId,
      safe,
      space,
      signature,
    });
    if (!valid) {
      refused('registration_signature_invalid', chainId, safe, '-');
      return send(res, 403, { error: 'forbidden', reason: 'registration_signature_invalid' });
    }
    // The Safe's own signature for this space, checked above, is the only way to register it or to
    // replace its space; storeRegistration decides which, atomically.
    const out = storeRegistration(db, { chainId, safe, space, community: config.community });
    if (out.outcome === 'same') return send(res, 200, { chainId, safe, space, community: out.group.community, relayer: config.address });
    if (out.outcome === 'refused') return send(res, 409, { error: 'conflict', reason: 'safe_registered_with_another_space' });
    if (out.outcome === 'replaced') {
      logger.info(`replaced ${chainId} ${safe} ${out.replaced} with ${space}`);
      return send(res, 201, { chainId, safe, space, community: config.community, relayer: config.address, replaced: out.replaced });
    }
    logger.info(`registered ${chainId} ${safe} ${space}`);
    return send(res, 201, { chainId, safe, space, community: config.community, relayer: config.address });
  }

  async function sendSafeExec(req, res) {
    if (!config.configured) return send(res, 503, { error: 'unavailable', reason: 'not_configured' });
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: body.error === 413 ? 'body_too_large' : 'bad_request' });
    const parsed = parseSafeExecBody(body.value);
    if (!parsed.ok) return send(res, 400, { error: 'bad_request', reason: parsed.error });
    const out = await safeExec({ value: parsed.value, config, networks, db, chains, cap, queue, logger });
    if (out.refusal) refused(out.refusal, parsed.value.chainId, parsed.value.safe, SELECTORS.execTransaction);
    return send(res, out.status, out.body);
  }

  async function sendEns(req, res) {
    if (!config.configured) return send(res, 503, { error: 'unavailable', reason: 'not_configured' });
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: body.error === 413 ? 'body_too_large' : 'bad_request' });
    const parsed = parseEnsBody(body.value);
    if (!parsed.ok) return send(res, 400, { error: 'bad_request', reason: parsed.error });
    const out = await ensService.request(parsed.value);
    if (out.refusal) refused(out.refusal, parsed.value.chainId, parsed.value.safe, '-');
    return send(res, out.status, out.body);
  }

  /** The three Reality steps share one shape: parse, hand to the service, answer with its status and body. */
  function sendReality(route) {
    return async (req, res) => {
      if (!config.configured) return send(res, 503, { error: 'unavailable', reason: 'not_configured' });
      const body = await readJson(req);
      if (body.error) return send(res, body.error, { error: body.error === 413 ? 'body_too_large' : 'bad_request' });
      const parsed = parseRealityBody(body.value, { route });
      if (!parsed.ok) return send(res, 400, { error: 'bad_request', reason: parsed.error });
      const out = await realityService[route](parsed.value);
      if (out.refusal) refused(out.refusal, parsed.value.chainId, parsed.value.safe, '-');
      return send(res, out.status, out.body);
    };
  }

  /** GET /events?since=<id>: stored events in id order and the cursor to pass next time (D-16, read by Drupal's poller). */
  async function eventsFeed(req, res) {
    const since = new URL(req.url, 'http://relayer.invalid').searchParams.get('since');
    if (since !== null && since !== '' && !SINCE.test(since)) return send(res, 400, { error: 'bad_request', reason: 'since must be a whole number' });
    return send(res, 200, feed.list(since === null || since === '' ? 0 : Number(since)));
  }

  /** GET /sends/:hash: the outcome of the send that had this hash (any of its hashes), or 404. */
  async function sendStatus(res, hash) {
    const row = db.findPendingByHash(hash);
    if (!row) return send(res, 404, { error: 'not_found', reason: 'send_not_found' });
    return send(res, 200, sendView(row, hash));
  }

  async function jobStatus(res, id) {
    if (!id) return send(res, 404, { error: 'not_found' });
    const out = ensService.job(id);
    return send(res, out.status, out.body);
  }

  async function status(res) {
    // Each Group shows the Reality module found on the chain (null until its setup transaction has mined).
    // A lookup that times out reads null, as an unreadable chain already does in modulesFor().
    const moduleOf = async (g) => {
      if (!config.configured || !modules) return null;
      try {
        return (await withTimeout(modules.modulesFor(g.chainId, g.safe), STATUS_READ_TIMEOUT_MS))[0] ?? null;
      } catch {
        return null;
      }
    };
    const chainOf = async (id) => {
      try {
        const { publicClient } = chains.get(id);
        const [balance, latest, pending] = await withTimeout(
          Promise.all([
            publicClient.getBalance({ address: config.address }),
            publicClient.getTransactionCount({ address: config.address, blockTag: 'latest' }),
            publicClient.getTransactionCount({ address: config.address, blockTag: 'pending' }),
          ]),
          STATUS_READ_TIMEOUT_MS,
        );
        return { balanceWei: balance.toString(), pending: Math.max(0, Number(pending) - Number(latest)) };
      } catch {
        return { error: 'unreachable' };
      }
    };
    const ids = config.configured ? Object.keys(networks).filter((id) => chainIsConfigured(networks, id)) : [];
    // The Groups' lookups and the chains' reads run side by side, so one stalled chain costs one cap, not two.
    const [groupsList, chainValues] = await Promise.all([
      Promise.all(db.listGroups().map(async (g) => ({ ...g, module: await moduleOf(g) }))),
      Promise.all(ids.map(chainOf)),
    ]);
    // community is the value a registration must be signed with (SPONSOR_RELAYER_COMMUNITY): the site's own
    // public name, so Drupal builds the owners' message from the relayer's value, not a copy of it (25-18).
    const out = { configured: config.configured, address: config.address, community: config.community, chains: {}, cap: cap.status(), groups: groupsList };
    ids.forEach((id, i) => { out.chains[id] = chainValues[i]; });
    return send(res, 200, out);
  }

  /**
   * The operator's recheck (25-28 dedupe): GET lists the sends to look at; POST {hash} reads one send's chain evidence
   * again and answers its GET /sends/:hash view. The body names the send only: nothing in it can declare an outcome.
   */
  async function opsList(res) {
    return send(res, 200, { sends: queue.needsOperator() });
  }
  async function opsRecheck(req, res) {
    const body = await readJson(req);
    if (body.error) return send(res, body.error, { error: body.error === 413 ? 'body_too_large' : 'bad_request' });
    const v = body.value;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => k !== 'hash') || typeof v.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v.hash)) {
      return send(res, 400, { error: 'bad_request', reason: 'the body is {"hash": "0x..."} and nothing else' });
    }
    const row = await queue.recheck(v.hash);
    if (!row) return send(res, 404, { error: 'not_found', reason: 'send_not_found' });
    return send(res, 200, sendView(row, v.hash));
  }

  const handlers = {
    'GET /ops/recheck': async (_req, res) => opsList(res),
    'POST /ops/recheck': opsRecheck,
    'GET /events': async (req, res) => eventsFeed(req, res),
    'GET /healthz': async (_req, res) => sendText(res, 200, 'ok'),
    'GET /jobs/:id': async (_req, res, id) => jobStatus(res, id),
    'GET /sends/:hash': async (_req, res, hash) => sendStatus(res, hash),
    'GET /status': async (_req, res) => status(res),
    'POST /groups': groups,
    'POST /send/ens': sendEns,
    'POST /send/reality/add': sendReality('add'),
    'POST /send/reality/answer': sendReality('answer'),
    'POST /send/reality/execute': sendReality('execute'),
    'POST /send/safe-exec': sendSafeExec,
  };
  if (Object.keys(handlers).sort().join('|') !== [...ROUTES].sort().join('|')) throw new Error('ROUTES and the handler table differ');

  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://relayer.invalid');
      const jobId = req.method === 'GET' ? JOB_PATH.exec(url.pathname)?.[1] : undefined;
      const sendHash = req.method === 'GET' ? SEND_PATH.exec(url.pathname)?.[1] : undefined;
      const route = jobId ? 'GET /jobs/:id' : sendHash ? 'GET /sends/:hash' : `${req.method} ${url.pathname}`;
      if (route === 'GET /healthz') return await handlers[route](req, res);
      // Web3 off: keyless and inert. This runs before auth and routing, so no token, route or body is looked at.
      // The reason phrase repeats the code, so a client that only shows the status line (busybox wget) still sees it.
      if (!config.web3Enabled) return send(res, 503, { error: 'web3_disabled' }, 'web3_disabled');
      if (!requireToken(req, config.token)) return send(res, 401, { error: 'unauthorized' });
      if (Object.hasOwn(handlers, route)) return await handlers[route](req, res, jobId ?? sendHash);
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      logger.error(`internal error: ${e?.name ?? 'Error'}`);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    }
  });
  return server;
}

async function main() {
  const networks = loadNetworks();
  const config = loadConfig(process.env, networks);
  if (!config.web3Enabled) {
    // Keyless and inert: no database, no chain clients, no queue. Only /healthz answers.
    console.warn('gas-sponsor-relayer: WEB3_ENABLED is not "true"; no key is loaded and every route but /healthz answers 503 web3_disabled');
    const idle = createServer({ config, networks, db: null, chains: null, cap: null, queue: null, logger: console });
    idle.listen(config.port, config.host, () => console.log(`gas-sponsor-relayer listening on ${config.host}:${idle.address().port} (web3 off)`));
    const halt = () => idle.close(() => process.exit(0));
    process.on('SIGTERM', halt);
    process.on('SIGINT', halt);
    return;
  }
  if (!config.configured) console.warn(`gas-sponsor-relayer: no usable sending key; every send answers 503${config.keyPresentButInvalid ? ' (SPONSOR_RELAYER_PRIVATE_KEY is set but invalid)' : ''}`);
  if (!config.token) console.warn('gas-sponsor-relayer: no SPONSOR_RELAYER_TOKEN; every authenticated route answers 401');
  const watch = watchSettingsFromEnv(process.env);
  const db = openDb(config.dbPath);
  const events = createEvents({ db });
  const chains = createChains({ config, networks });
  const cap = createCap({ db, caps: config.caps, events });
  const groupModules = createGroupModules({ networks, chains });
  // A send from a Safe mining may have enabled its module: read that Safe's modules again.
  const queue = createQueue({
    db,
    chains,
    cap,
    address: config.address,
    logger: console,
    events,
    onMined: (row) => {
      if (row.safe) groupModules.invalidate(row.chainId, row.safe);
    },
  });
  if (config.configured) {
    // Give back reservations no send row holds, settle what the chain mined while the relayer was down, and resend
    // what the node lost.
    try {
      queue.releaseOrphans();
      const r = await queue.reconcile();
      console.log(`gas-sponsor-relayer: reconciled pending sends (${JSON.stringify(r)})`);
    } catch (e) {
      console.warn(`gas-sponsor-relayer: reconcile failed: ${e?.shortMessage ?? e?.name}`);
    }
    queue.start();
  }
  const ens = createEns({ db, config, networks, chains, cap, queue, logger: console });
  const interrupted = ens.resume();
  if (interrupted) console.warn(`gas-sponsor-relayer: ${interrupted} unfinished ENS job(s) from before the restart marked failed`);
  const hub = createHub({ networks, config });
  const server = createServer({ config, networks, db, chains, cap, queue, groupModules, ens, hub, events, logger: console });
  // Bonds the relayer posted come back through this loop (25-07); without a key there is nothing to claim.
  const reclaim = config.configured ? createReclaim({ db, config, networks, chains, cap, queue, logger: console }) : null;
  reclaim?.start();
  // Every minute (SPONSOR_RELAYER_WATCH_INTERVAL_S): challenge any Reality answer that is not the Group's real vote (D-16).
  const watcher = config.configured
    ? createWatcher({ db, config, networks, chains, cap, queue, groupModules, hub, events, intervalMs: watch.intervalMs, lowBalanceWei: watch.lowBalanceWei, logger: console })
    : null;
  watcher?.start();
  server.listen(config.port, config.host, () => console.log(`gas-sponsor-relayer listening on ${config.host}:${server.address().port}`));
  const stop = () => { queue.stop(); reclaim?.stop(); watcher?.stop(); server.close(() => { db.close(); process.exit(0); }); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
