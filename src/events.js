// The relayer's event feed (D-16, 25-08). Drupal polls GET /events?since=<id> every cron minute and turns what it
// finds into organizer alerts (25-25). Events are public chain facts about one Group and one Reality question; they hold
// no key and no secret.
//
// Seven types make up the feed:
//   answer_challenged  the watcher answered a wrong Reality answer with decide()'s answer and double the bond
//   escalation_needed  the watcher could not challenge (the cap, or repeated failures): the Group Safe's arbitrator
//                      is the backstop, and `detail.deadline` is when the question finalizes
//   resolved           a question the watcher flagged finalized with the right answer
//   wrong_final        a question finalized with the wrong answer; `detail.executableAfter` is the end of the cooldown
//   cap_reached        a send was refused by the spend cap (once per window)
//   send_stuck         a send still had no receipt after its last fee bump
//   low_balance        the relayer's balance fell under SPONSOR_RELAYER_LOW_BALANCE_WEI
//
// Other rows in the `events` table (send_replaced, reality_*) are audit lines, never served by the feed.

export const EVENT_TYPES = Object.freeze(['answer_challenged', 'escalation_needed', 'resolved', 'wrong_final', 'cap_reached', 'send_stuck', 'low_balance']);

/** The most events one GET /events answer carries. */
export const FEED_LIMIT = 100;

/** add() was given a type the feed does not have. */
export class UnknownEventType extends TypeError {
  constructor(type) {
    super(`unknown event type ${JSON.stringify(String(type).slice(0, 40))}`);
    this.name = 'UnknownEventType';
  }
}

function parseDetail(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One feed entry, in the shape the README documents. `at` is ISO 8601 in UTC; `detail` is the stored JSON. */
function toFeedEvent(row) {
  return {
    id: row.id,
    type: row.kind,
    chainId: row.chainId,
    safe: row.safe,
    module: row.module,
    questionId: row.questionId,
    proposalId: row.proposalId,
    detail: parseDetail(row.detail),
    at: new Date(row.at).toISOString(),
  };
}

/** The event store over the db.js `events` table. */
export function createEvents({ db }) {
  return {
    /**
     * Store an event of one of the seven types. Returns its id. Wei and other BigInt values may sit in `detail`;
     * they are stored as decimal strings.
     */
    add(type, { chainId = null, safe = null, module = null, questionId = null, proposalId = null, detail = {} } = {}) {
      if (!EVENT_TYPES.includes(type)) throw new UnknownEventType(type);
      return db.insertEvent({ kind: type, chainId, safe, module, questionId, proposalId, detail });
    },

    /**
     * Up to `limit` feed events with id > since, in id order, and the cursor to pass next time.
     * `next` is the id of the last event returned, or `since` when there is nothing new.
     */
    list(since = 0, limit = FEED_LIMIT) {
      const n = Math.min(Math.max(1, Math.trunc(limit)), FEED_LIMIT);
      const events = db.listEventsSince(since, n, EVENT_TYPES).map(toFeedEvent);
      return { events, next: events.length ? events[events.length - 1].id : since };
    },
  };
}
