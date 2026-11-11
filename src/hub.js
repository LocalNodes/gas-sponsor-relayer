// The relayer's own reads of the Snapshot hub (GraphQL) and the sequencer's score finalizer (D-09, D-16).
//
// Nothing the relayer posts to Reality.eth comes from Drupal: it reads the proposal here and decides for itself.
// URLs come from config/networks.json (`hub`, `sequencer`) and can be overridden per chain by
// SPONSOR_RELAYER_HUB_URL_<chainId> and SPONSOR_RELAYER_SEQUENCER_URL_<chainId> (tests point them at a stub).
// The sequencer limits requests per IP (100 a minute), so HTTP 429 is retried with backoff.

export class HubError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HubError';
    this.code = code; // hub_unavailable | hub_rate_limited | hub_bad_response
  }
}

const QUERY = 'query Proposal($id: String!) { proposal(id: $id) { id space { id } state scores_state scores scores_total quorum end plugins } }';
const REQUEST_MS = 15_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Turn the hub's proposal object into the fields the relayer uses. Returns null for "the hub does not know it". */
export function normalizeProposal(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || typeof raw.id !== 'string') throw new HubError('hub_bad_response');
  let plugins = raw.plugins ?? null;
  if (typeof plugins === 'string') {
    try {
      plugins = JSON.parse(plugins);
    } catch {
      plugins = null;
    }
  }
  const scores = Array.isArray(raw.scores) ? raw.scores.map(numberOrNull) : [];
  return {
    id: raw.id,
    spaceId: typeof raw.space?.id === 'string' ? raw.space.id : '',
    state: typeof raw.state === 'string' ? raw.state : '',
    scoresState: typeof raw.scores_state === 'string' ? raw.scores_state : '',
    scores: scores.some((s) => s === null) ? [] : scores,
    scoresTotal: numberOrNull(raw.scores_total),
    quorum: numberOrNull(raw.quorum),
    end: numberOrNull(raw.end),
    plugins,
  };
}

export function createHub({ networks, config = {}, fetchImpl = globalThis.fetch, sleep = defaultSleep, maxRetries = 3, baseDelayMs = 500, requestMs = REQUEST_MS }) {
  const hubUrl = (chainId) => config.hubUrls?.[String(chainId)] ?? networks?.[String(chainId)]?.hub ?? null;
  const sequencerUrl = (chainId) => config.sequencerUrls?.[String(chainId)] ?? networks?.[String(chainId)]?.sequencer ?? null;

  /** One request with backoff on 429. Returns the Response of the first answer that is not a 429. */
  async function request(url, init) {
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(requestMs) });
      } catch {
        throw new HubError('hub_unavailable');
      }
      if (res.status !== 429) return res;
      if (attempt >= maxRetries) throw new HubError('hub_rate_limited');
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }

  return {
    hubUrl,
    sequencerUrl,

    /** The proposal as the hub holds it, or null when the hub does not know the id. Throws HubError when it cannot be read. */
    async getProposal(chainId, proposalId) {
      const base = hubUrl(chainId);
      if (!base) throw new HubError('hub_unavailable');
      const res = await request(`${base.replace(/\/+$/, '')}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { id: proposalId } }),
      });
      if (!res.ok) throw new HubError('hub_unavailable');
      let json;
      try {
        json = await res.json();
      } catch {
        throw new HubError('hub_bad_response');
      }
      if (json?.errors?.length || !json || typeof json !== 'object' || !('data' in json)) throw new HubError('hub_bad_response');
      return normalizeProposal(json.data?.proposal ?? null);
    },

    /**
     * Ask the sequencer to finalize the proposal's scores. Nothing finalizes them on its own;
     * the call is idempotent. Throws HubError when the sequencer cannot be reached or refuses.
     */
    async finalizeScores(chainId, proposalId) {
      const base = sequencerUrl(chainId);
      if (!base) throw new HubError('hub_unavailable');
      const res = await request(`${base.replace(/\/+$/, '')}/scores/${encodeURIComponent(proposalId)}`, { method: 'GET' });
      if (!res.ok) throw new HubError('hub_unavailable');
      await res.arrayBuffer().catch(() => {});
    },
  };
}
