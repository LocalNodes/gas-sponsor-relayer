// A canned Snapshot hub and sequencer for tests (no live hub, no network beyond loopback).
//
//   POST /graphql      answers { data: { proposal } } from the proposals the test set
//   GET  /scores/:id   the sequencer's score finalizer; the stub records the call and runs `onScores`
//
// Every request is recorded in `calls`, so a test can show the relayer asked the sequencer itself.
// `forceStatus(path, [429, 429])` makes the next requests to that path answer those statuses first.
import { createServer } from 'node:http';

export async function startHubStub() {
  const proposals = new Map();
  const calls = [];
  const forced = new Map();
  const stub = { calls, onScores: null };

  const respond = (res, status, body, type = 'application/json') => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub.invalid');
    const path = url.pathname;
    const queue = forced.get(path);
    if (queue?.length) {
      const status = queue.shift();
      calls.push({ kind: path === '/graphql' ? 'graphql' : 'scores', id: null, forced: status });
      return respond(res, status, { error: `forced ${status}` });
    }
    if (req.method === 'POST' && path === '/graphql') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return respond(res, 400, { error: 'bad json' });
      }
      const id = body?.variables?.id ?? /proposal\s*\(\s*id:\s*"([^"]+)"/.exec(body?.query ?? '')?.[1];
      calls.push({ kind: 'graphql', id: id ?? null });
      if (typeof id !== 'string') return respond(res, 400, { errors: [{ message: 'no proposal id' }] });
      return respond(res, 200, { data: { proposal: proposals.get(id.toLowerCase()) ?? null } });
    }
    const m = req.method === 'GET' ? /^\/scores\/([^/]+)$/.exec(path) : null;
    if (m) {
      const id = decodeURIComponent(m[1]);
      calls.push({ kind: 'scores', id });
      stub.onScores?.(id, proposals);
      return respond(res, 200, 'true');
    }
    return respond(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  /** Set (or replace) a proposal; `p.id` is the key. */
  stub.set = (p) => { proposals.set(p.id.toLowerCase(), structuredClone(p)); return p; };
  stub.get = (id) => proposals.get(id.toLowerCase());
  stub.callsOf = (kind, id) => calls.filter((c) => c.kind === kind && (id === undefined || c.id === id));
  stub.forceStatus = (path, statuses) => forced.set(path, [...statuses]);
  stub.close = async () => {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  };
  return stub;
}

/** A hub proposal in the shape GraphQL returns, with a safeSnap plugin for one module (sx-monorepo form). */
export function hubProposal({ id, space, module, chainId, txs, state = 'closed', scoresState = 'final', scores = [2, 0, 1], scoresTotal, quorum = 2, end = 1_700_000_000 }) {
  return {
    id,
    space: { id: space },
    state,
    scores_state: scoresState,
    scores,
    scores_total: scoresTotal ?? scores.reduce((a, b) => a + b, 0),
    quorum,
    end,
    plugins: {
      safeSnap: {
        safes: [
          {
            network: String(chainId),
            realityAddress: module,
            multiSendAddress: null,
            umaAddress: null,
            txs: [txs.map((t, i) => ({ to: t.to, value: String(t.value), data: t.data ?? '0x', operation: String(t.operation ?? 0), nonce: String(i) }))],
          },
        ],
        valid: true,
      },
    },
  };
}
