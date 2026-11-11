# gas-sponsor-relayer

A small Node 24 service that pays the gas for a LocalNodes community's on-chain steps. Each
community (each Drupal instance) runs its own relayer. The relayer holds the only sending key.
The Drupal site talks to it over the internal network with a bearer token and asks for sends by
intent; it never sees the key.

The source lives at github.com/LocalNodes/gas-sponsor-relayer and the image at ghcr.io/localnodes/gas-sponsor-relayer. It is free software, GPL-2.0-or-later (the Licence line below).

Licence: GPL-2.0-or-later (see `LICENSE`).

## The key rule (D-01)

`SPONSOR_RELAYER_PRIVATE_KEY` is read from this container's environment and nowhere else. Drupal
never receives it. It is not in any response body, log line or config object (a unit test with a
sentinel key checks every route and error path). With no usable key the relayer says
`configured: false` in `GET /status` and answers every send with 503.

**Web3 off means keyless.** Every instance runs this container, but only an instance that turned web3
on holds a funded key. Unless `WEB3_ENABLED` is exactly the string `true` (not `TRUE`, `1`, `yes` or
empty), `config.js` never reads `SPONSOR_RELAYER_PRIVATE_KEY`, even when it is set, and the server
answers every request except `GET /healthz` with `503 {"error": "web3_disabled"}`. The container
stays healthy, nothing can send, and nothing opens a database or an RPC connection (TM-151).

The relayer's address is shown in `GET /status`. Fund that address with test ETH to sponsor.

## How a Group gets on the list (D-18)

The relayer sponsors a Group's Safe only after the Safe's owners register it. They sign this
EIP-712 message, wrapped as a Safe message, with enough owners to meet the Safe's threshold:

```
domain  { name: "gas-sponsor-relayer", version: "1", chainId }
type    SponsorRegistration { relayer address, chainId uint256, safe address, space string, community string }
```

`relayer` is this relayer's own address and `community` is its `SPONSOR_RELAYER_COMMUNITY`. The
relayer fills both in itself; a request cannot choose them. It hashes the typed data and asks the
Safe on-chain: `isValidSignature(digest, signature)` must return `0x1626ba7e`. Anything else is a
403. Drupal cannot forge a registration, because it holds no owner key.

Owner signatures are concatenated in ascending owner-address order, as Safe's `checkSignatures`
requires, and each owner signs `SafeMessage(bytes message)` with `message = abi.encode(digest)`
under the Safe's own EIP-712 domain. `test/helpers/fork.js` shows it end to end.

## HTTP API

All bodies are JSON (`Content-Type: application/json`, 64 KB limit; larger bodies get 413).
Every route except `GET /healthz` needs `Authorization: Bearer <SPONSOR_RELAYER_TOKEN>`; a missing
or wrong token is 401 and sends nothing. Quantities of wei are decimal strings of whole numbers,
never JSON numbers.

| Endpoint | Added by | Purpose |
|---|---|---|
| `GET /healthz` | 25-04 | Liveness. No auth, answers whether or not web3 is on. `200` with the plain text body `ok` (25-05 changed it from JSON, for the container health check) |
| `GET /status` | 25-04, cap fields 25-05 | Address, balance per chain, pending, cap and spend, covered Groups |
| `POST /groups` | 25-04 | Register a Group's Safe (D-18) |
| `POST /send/safe-exec` | 25-04 | Send an owner-signed `Safe.execTransaction` and pay the gas |
| `POST /send/ens` | 25-06 | Register the Group's ENS name with the Safe as owner; the relayer pays (see below) |
| `GET /jobs/:id` | 25-06 | State of an ENS registration job: `pending`, `committed`, `registered` or `failed`, with the transaction hashes |
| `GET /sends/:hash` | 25-28 round 2 | What happened to a send: `pending`, `mined`, or `not_sent` with the hash of the transaction that took its nonce (see below) |
| `GET /ops/recheck` | 25-28 dedupe | The sends an operator should look at, each with a plain reason: stuck ones, and ones held because the node gave conflicting evidence (see below) |
| `POST /ops/recheck` | 25-28 dedupe | `{"hash": "0x..."}` and nothing else: read that send's chain evidence again now and answer its `GET /sends/:hash` view. It never takes an outcome from the caller |
| `POST /send/reality/add` | 25-07 | `addProposal` on the Group's Reality module |
| `POST /send/reality/answer` | 25-07 | `submitAnswer` with the minimum bond |
| `POST /send/reality/execute` | 25-07 | `executeProposalWithIndex` |
| `GET /events?since=<id>` | 25-08 | The event feed: what the wrong-answer watcher did and saw, and the alerts the cap, the queue and the balance check raise (see "Wrong answers") |

Endpoints marked 25-05 to 25-08 are listed so the Drupal client (`gas_sponsor`, 25-10) has one
place to read the whole contract. Their request and response shapes are set by the plan that adds
them, and that plan updates this table.

### Error codes

| Code | Body | Meaning |
|---|---|---|
| 400 | `{"error": "bad_request", "reason"}` | The JSON is malformed or a field has the wrong type |
| 401 | `{"error": "unauthorized"}` | Missing or wrong bearer token (or none configured) |
| 403 | `{"error": "forbidden", "reason"}` | Policy refusal; nothing was sent. `reason` is one of `unknown_chain`, `no_ens_on_network`, `label_not_space`, `registration_signature_invalid`, `safe_not_registered`, `refund_fields_must_be_zero`, `target_not_allowed`, `selector_not_allowed`, `delegatecall_target_not_allowed`, `bad_operation` |
| 409 | `{"error": "conflict", "reason"}` | The request conflicts with current state: `safe_registered_with_another_space` on `/groups`, `name_taken` or `job_in_progress` on `/send/ens`, or `simulation_failed` on `/send/safe-exec` (the `eth_call` did not return true: a stale Safe nonce, bad signatures, or an inner call that fails) |
| 413 | `{"error": "body_too_large"}` | Body over 64 KB |
| 429 | `{"error": "cap_reached", "limit": "day" or "month", "until": <ISO time>, "monthStartsAt": <ISO time>}` | A spend cap would be exceeded and nothing was sent. `until` is the first moment the send would fit (the 24-hour window frees up, or the month resets). `limit` is the cap whose `until` is later. `monthStartsAt` is the start of the current UTC calendar month: `gas_sponsor` computes the month name for the steward message "The limit for <Month> is reached." from it, so no month name is ever hard-coded |
| 502 | `{"error": "send_failed", "reason", "broadcast": false}` | The node refused the transaction in one of the exact refusals listed under "Spend caps" (for example the relayer is out of ETH). Nothing was broadcast. Any other failure of the broadcast (a lost answer, an error the relayer does not recognise) is a `202` with the hash, not a 502. A 502 can also come before any broadcast (`fee_estimate_failed`, or a read that failed while the transaction was being prepared or signed). Every 502 the relayer itself answers carries `"broadcast": false`; a 502 without it (from a proxy in front of the relayer) says nothing about whether a transaction went out |
| 404 | `{"error": "not_found", "reason": "send_not_found"}` | `GET /sends/:hash`: no send of this relayer ever had that hash |
| 503 | `{"error": "unavailable", "reason"}` | `not_configured` (no usable key, or no community name for `/groups`), `chain_not_available`, or `chain_not_sponsored` (see "Base Sepolia: no sponsoring until Phase 30"). Nothing was reserved or sent |
| 503 | `{"error": "web3_disabled"}` | `WEB3_ENABLED` is not exactly `true`. Every route but `/healthz`, valid token or not. The HTTP reason phrase is also `web3_disabled` |

Every 403 is also logged as `refused <reason> <chainId> <target> <selector>`, without request bodies.

### Base Sepolia: no sponsoring until Phase 30

The relayer does not pay for sends on Base Sepolia (chain `84532`). On an OP-stack chain a transaction also pays an
L1 data fee and an operator fee, and the spend cap counts only execution gas and value, so the cap could not hold
there (25-28 round 3, Codex HIGH 4). `config/networks.json` marks the chain `"sponsoring": false`. Every send route
(`/send/safe-exec`, `/send/reality/*`, `/send/ens`), the shared send pipeline (Reality steps, bond reclaim, the
watcher's challenge) and the queue itself answer such a send with

```json
503 {"error": "unavailable", "reason": "chain_not_sponsored"}
```

before any gas estimate, reservation or broadcast: nothing is held and nothing is sent. `gas_sponsor` maps a 503 to
`SponsorNotConfiguredException` ("this relayer serves no such network"), one of its "nothing was sent" answers.
A send already stored for such a chain (from before the switch) is held read-only (25-28 round 4): its receipts and
the release proof still run, so it settles or is released as any other, and its reservation stays until then, but
it is never broadcast again at boot and never fee-bumped.
Reads stay: `GET /status` still shows the chain's balance, and `POST /groups` still registers a Safe there. Phase 30
turns sponsoring back on once reservations and settlement count the whole OP-stack fee (viem's `estimateTotalFee`
before the send, the receipt's `l1Fee` after it).

### `GET /status`

```json
{
  "configured": true,
  "address": "0x...",
  "community": "My Community",
  "chains": {
    "11155111": { "balanceWei": "5000000000000000000", "pending": 0 },
    "84532": { "error": "unreachable" }
  },
  "cap": {
    "dayWei": "50000000000000000",
    "monthWei": "500000000000000000",
    "spentDayWei": "1234500000000",
    "spentMonthWei": "9876500000000",
    "dayResetsAt": "2026-11-09T09:30:12.000Z",
    "monthResetsAt": "2026-12-01T00:00:00.000Z",
    "monthStartsAt": "2026-11-01T00:00:00.000Z"
  },
  "groups": [
    { "chainId": 11155111, "safe": "0x...", "space": "my-group.eth", "community": "My Community", "module": "0x..." }
  ]
}
```

`community` is `SPONSOR_RELAYER_COMMUNITY`, the value every Group registration message must carry
(the relayer refuses any other). Drupal reads it from here to build the message the Group's owners
sign; it is the community's public name or hostname, and `""` when unset.

`balanceWei` is the relayer's balance on that chain. `pending` is the count of its transactions
still in the mempool (pending nonce minus latest nonce). A chain whose RPC cannot be reached reads
`{"error": "unreachable"}`; it is never shown as a zero balance. Each chain's reads, and each
Group's module lookup, get at most 3 seconds (`STATUS_READ_TIMEOUT_MS`): a chain that has not answered
by then reads `{"error": "unreachable"}` and its Groups read `"module": null`, while the other chains
keep their values. A stalled RPC therefore costs one 3-second wait, not the whole answer.

`cap` is the relayer's own spend limit (D-01, D-19), always present. Wei values are decimal strings,
times are ISO-8601 UTC. `dayWei` and `monthWei` are the caps; `spentDayWei` covers the rolling 24
hours and `spentMonthWei` the current UTC calendar month, both across every chain, net of bonds that
came back. `dayResetsAt` is when the oldest spend in the 24-hour window leaves it (`null` when
nothing is in the window); `monthResetsAt` is 00:00 UTC on the 1st of next month; `monthStartsAt` is
00:00 UTC on the 1st of this month. Stewards see these through `gas_sponsor`. With no key,
`configured` is `false`, `address` is `null` and `chains` is empty; `cap` is still shown.

`module` in a `groups` entry is the Group's Zodiac Reality module, or `null` until the Group's
setup transaction has mined. The relayer reads it from the chain only (see Group modules below).

### Group modules

A Group's Reality module is never named in a request. For each registered Safe the relayer asks the
chain (`getModulesPaginated`) and keeps a module only if all of these hold: the Safe has it enabled,
its runtime code is exactly the ERC-1167 minimal proxy of the configured Zodiac Reality mastercopy
(`realityMastercopy` in `config/networks.json`), and its `avatar()` and `target()` are the Safe. A
module of another mastercopy, with another avatar or target, or not enabled is ignored. The answer is
cached for one minute per Safe and read again as soon as a send from that Safe mines, so the module a
setup transaction enables shows up in `GET /status` without waiting. The allowlist then allows
`addProposal` and `executeProposalWithIndex` on each such module, and nothing else on it. If the
chain cannot be read the answer is "none yet" and is not cached.

### Spend caps

Two caps apply to every sponsored send, whatever Drupal asks for: a rolling 24 hours and the UTC
calendar month. Defaults are 0.05 and 0.5 Sepolia ETH (`50000000000000000` and `500000000000000000`
wei), set per instance with `SPONSOR_RELAYER_CAP_DAY_WEI` and `SPONSOR_RELAYER_CAP_MONTH_WEI`. A
value that is not a whole number of wei stops the relayer at start. A refusal stores one `cap_reached` event per limit
and window: the event names the time the send could fit again, and further refusals before that time add nothing.

- Before a send the relayer reserves `gas limit x maxFeePerGas + value`. The reservation becomes the real cost,
  `gasUsed x effectiveGasPrice + value`, only once the receipt's block is **finalized** (25-28 round 3). Until then
  the whole maximum stays held, with every fee-bump increase: a receipt that is not final yet can still be reorged
  out, and the same transaction can then mine again at a higher cost. See "Reservation lifecycle" below.
- A receipt counts only when it is bound to its transaction (25-28 round 4), on every path that marks a send
  `confirming` or settles it: on the proof endpoint, the block at the receipt's height, read with its transactions,
  lists exactly one transaction with the receipt's hash (one of the send's own), and that transaction and the
  receipt both name that block, by hash and by height; settling also needs that block on the pinned finalized
  chain. A receipt lookup that answers with another transaction's receipt is no answer. Evidence that disagrees
  leaves the send as it is, its whole maximum held: a `pending` send is not marked `confirming`, a `confirming`
  one is not settled. Only another block at that height (a reorg) puts a `confirming` send back to `pending`.
- **An unresolved reservation counts against the current day and month windows, whatever time it was made**,
  until it is settled or released (25-28 round 2). A live liability never ages out of a window: with both caps at
  1,200 wei, 1,000 reserved before midnight on the last day of a month still blocks a second 1,000 after it.
  Settled spend counts by the time the relayer saw its receipt, so a send counts in the window where it was paid.
  Ledger entries are `open` (unresolved), `settled` or `released`. When unresolved reservations alone fill a cap,
  a 429's `until` cannot be known from time and reads 24 hours ahead (or the month's end for the month cap).
- A broadcast never exists without a held reservation and a `pending` row. The relayer signs the
  transaction and stores it, with its hash, before the node sees it.
- The raw broadcast goes to **one endpoint, once**: the first RPC URL, with no fallback and no retry. Only that
  node's own JSON-RPC refusal (code -32000) in one of these exact texts means nothing went out:
  `insufficient funds for gas * price + value`, `intrinsic gas too low`, `exceeds block gas limit`,
  `transaction underpriced`, `replacement transaction underpriced`,
  `max priority fee per gas higher than max fee per gas`, `max fee per gas less than block base fee`,
  `nonce too high`, `invalid sender`, `oversized data`, `txpool is full`. The row is then deleted, the reservation
  given back and the answer is 502 `send_failed`. Any other outcome (a timeout, an HTTP failure, a response too
  large to read, "already known", "nonce too low", an error the relayer does not recognise) means the send may be
  live: it is kept as `pending` with its reservation and answered `202`.
- One broadcast at a time per send: while the first broadcast or a replacement waits for its answer, the poll loop
  and reconcile leave the send alone, and a refusal deletes the row only while it is still exactly that first
  broadcast. An older broadcast's answer never deletes or overwrites newer state.
- A fee bump first checks the replacement's extra maximum cost against both current windows and stores it as its
  own `open` entry at that time. If the cap has no room, nothing is sent: the send waits as it is (a `cap_reached`
  event, as for any refusal) and is bumped once the cap has room. A send never runs over the cap.
- A send's reservation is given back (the send is marked `replaced`, `not_sent` on `GET /sends/:hash`) only with
  proof that none of its broadcasts can ever mine, read on the one proof endpoint (the first RPC URL) in one pass:
  the relayer's nonce count at the `finalized` block is past the send's nonce, and the relayer's transaction with
  that nonce, found in a block from the send's first broadcast block to `finalized`, is none of the send's own
  hashes. That block must be on the finalized chain (25-28 round 3): the finalized block's hash is pinned for the
  pass, parent hashes are followed down from it (blocks read by hash, kept only when at the height expected, so a
  wrong answer is read again next pass; at most 256 such reads per chain per pass; a longer walk goes on in the next
  pass) and must arrive at the consuming block's hash at its height, and the
  transaction (and, on the send's own hash, its receipt) must name that block. Its hash and block are stored and
  shown. A read that fails or disagrees, or a walk not finished, leaves the send unresolved, its reservation held. Receipts that read "not found" prove nothing (an index may lag), and neither does a nonce
  taken many blocks deep: when the transaction that took the nonce is one of the send's own, the send is settled
  from its receipt, and held until that receipt can be read.
- A `replaced` send is still looked up under its own hashes. If one of them ever shows a receipt, its reservation
  and increases are held again, whole, the send becomes `confirming` and a `send_release_reversed` audit line is
  stored; its real cost is settled once that receipt is final.
- A `stuck` send keeps its reservation and resolves only as above, from the chain.
- Settling, releasing, marking `confirming` and going back to `pending` on a reorg are each one database
  transaction with the ledger change and the audit line (25-28 round 3): a crash or a failed write leaves the send
  as it was, its reservation held, and the next pass does it once.
- At start, before anything is sent: a `mined` or `replaced` row whose reservation is still open (a database from
  before round 3 could hold one) goes back to `pending` (`send_recovered` audit line), so it settles from its receipt
  or is released only by the proof. Then an open reservation that **no** send row holds, in any status, is given
  back (`reservation_released` audit line): a row always comes before its broadcast, so nothing went out for it.
- A bond counts as spend until it is reclaimed; a credit entry then offsets it. A bond whose send was
  `replaced` has only a released entry, so it earns no credit: a credit never reduces other spend. Reclaim
  then reports 0 credited and writes a `reality_credit_skipped` audit line (reason `no_bond_entry`,
  with the wei withdrawn).
- Spend exactly equal to a cap is allowed; one wei more is a 429. The 24-hour window is
  `(now - 86400 s, now]`: an entry exactly 86400 s old has left it. The month cap resets at 00:00
  UTC on the 1st.
- All arithmetic is integer wei (`BigInt`). A test fails if `cap.js` or `queue.js` uses floating
  point.

### Nonces and stuck sends

One serial queue per chain hands out nonces in request order, so concurrent requests get consecutive
nonces. A nonce held by a `pending`, `stuck` or `confirming` send is never handed out again, even when the node has
forgotten that send (25-28 round 3). Every transaction is signed and stored in sqlite (`pending`), with its hash and its first broadcast block
(read before the nonce), before it is broadcast, so a restart always finds a send that may be live. At boot the
relayer gives back reservations no waiting send holds, then reconciles waiting and stuck sends with the chain: a
send whose hash the chain has mined is settled, one the node no longer holds is sent again as the identical signed
transaction (the same hash, never a second transaction; for a stuck send, its last replacement; never on a chain
the relayer does not sponsor), a `confirming` send found reorged waits a full bump interval from the boot head
(25-28 round 4), and one proven
replaced at the finalized block (see "Spend caps") is marked `replaced` (stored as a `send_replaced` audit line
with the consuming hash) and its reservation given back. Anything not proven stays for the poll loop. A send not
mined after 12 blocks is resent with the same nonce and both fees raised by one eighth (rounded up, at least 1
wei), at most 3 times, each time within the spend cap (see "Spend caps"); after that a `send_stuck` event is
stored (it reaches `GET /events`, with the Safe when the send was for a Group) and the send is marked `stuck`.

#### Reservation lifecycle (25-28 rounds 3 and 4)

| Send status | Its reservation | Leaves this status when |
|---|---|---|
| (no row yet) | **held** from `cap.reserve`, before signing | the row is stored, before the broadcast; or the node's exact refusal (or a refusal before any broadcast) releases it |
| `pending` | **held**, the maximum, raised by each fee bump | a receipt of one of its own hashes is on the proof endpoint and bound to its transaction (`confirming`); or the proof shows another transaction took its nonce (`replaced`); or 3 bumps ran out (`stuck`) |
| `stuck` | **held** | the same as `pending`, without more bumps |
| `confirming` (`mined`, `finalized: false` on `GET /sends/:hash`) | **held**, the whole maximum | its receipt's block is finalized, on the finalized chain, and still lists the transaction as the receipt says: **settled** to the real cost (`mined`); or the receipt is gone, names another block, or another block holds that height: back to `pending`, still held (`send_reorged`); while the block and the receipt disagree about the transaction it stays `confirming`, held |
| `mined` (`finalized: true`) | **settled**: the real cost, counted by the time it settled | never |
| `replaced` (`not_sent`) | **released** | one of its own hashes shows a receipt bound to its transaction after all: **held** again, whole, as `confirming` (`send_release_reversed`). It never settles while the finalized chain names the other transaction: it stays held and is listed in `GET /ops/recheck` |

Every pass re-reads, on the proof endpoint, each `confirming` send's receipt and the block at its height; it is
never bumped or rebroadcast. Reconcile at boot covers `pending`, `stuck` and `confirming` sends.

**A load-balanced proof URL.** The proof endpoint should be one node. When the first RPC URL is a load balancer over
several nodes, consecutive reads can come from nodes at different heights or on different forks, so a send can
move between `confirming` and `pending` (and `GET /sends/:hash` between `mined` and `pending`) from one pass to the
next. That is the safe direction: the maximum stays held throughout, and a send settles only when one pass's reads
agree. It costs RPC reads and delays settlement; point `SPONSOR_RELAYER_RPC_URL_<chainId>`'s first URL at a single
node to avoid it.

**What callers treat as done.** Flow logic may act on the first receipt; only the spend cap waits for finality.
- `waitMined` (Reality add, answer and execute; bond reclaim's claim and withdraw) returns the first receipt of the
  send's own hashes (never another send's at the same nonce), final or not, and its caller goes on from it.
- The ENS job's waiter does the same for each step (mint, approve, commit, register).
- `onMined` (the Group module cache) runs once, when the send becomes `confirming`.
- `GET /sends/:hash` answers `mined` from the first receipt, with `finalized: false` until the cap has settled it.
  Only `not_sent`, which is itself proven at finality, lets Drupal send again.
A receipt that is later reorged out puts the send back to `pending` while its caller has already moved on; the same
signed transaction normally mines again. The cap stays correct either way.

Each poll pass reads, per chain with unresolved sends, the head block, the receipts of each send's hashes and,
on the proof endpoint, the `finalized` block and the relayer's nonce count there. Only a send whose nonce is past
that count costs more: a binary search of nonce counts between its first broadcast block and `finalized`, then that
one block with its transactions. This needs an endpoint that serves nonce counts at those blocks; one that cannot
leaves the send unresolved (held), never released.

### `GET /sends/:hash`

Any hash a send has had (the first broadcast or a fee bump), in any letter case. Answers `200`:

```json
{ "hash": "0x...", "chainId": 11155111, "nonce": 12, "status": "pending", "stuck": false, "hashes": ["0x...", "0x..."] }
{ "hash": "0x...", "chainId": 11155111, "nonce": 12, "status": "mined", "stuck": false, "hashes": ["0x..."], "minedHash": "0x...", "finalized": false }
{ "hash": "0x...", "chainId": 11155111, "nonce": 12, "status": "not_sent", "stuck": false, "hashes": ["0x..."], "consumedBy": "0x...", "consumedBlock": "7712345" }
```

- `pending`: still waiting. `stuck: true` means the fee bumps ran out and the organizers were alerted
  (`send_stuck`); it is still waiting.
- `mined`: `minedHash`, one of `hashes`, mined. Read its receipt from the chain for the outcome (a revert also
  mines). `finalized` (25-28 round 3) is `false` while that receipt's block is not finalized: a reorg can still put
  the send back to `pending`, and the cap still holds its maximum. It is `true` once the block is finalized and the
  cap holds the real cost.
- `not_sent`: proven at the finalized block (see "Spend caps"): the relayer's transaction `consumedBy`, in block
  `consumedBlock`, took this send's nonce, so none of `hashes` can ever mine. Its reservation was given back. This
  is the relayer's proof for the Drupal "not sent" rule: only now may a caller send again or discard.

`hashes` lists every hash the send has had, oldest first. A hash the relayer never sent is `404` with
`"reason": "send_not_found"`. A send answered by a `/send/*` route always has a row here, from before its broadcast.

### `GET /ops/recheck` and `POST /ops/recheck`

`GET /ops/recheck` answers `{"sends": [{"hash", "chainId", "nonce", "status", "reason"}]}`. Two kinds of send are
listed:

- `stuck`: "the send has not mined after its fee bumps".
- `confirming`, "the node gave conflicting evidence for this send": the send's own transaction shows in a final
  block, but the finalized chain says another transaction took its nonce. Both cannot be true, so the relayer
  settles neither way: the send's whole maximum stays reserved, out of the cap, until the evidence changes (the
  receipt goes away and the send is proven replaced) or an operator acts. The relayer logs one ALERT line when a
  send first enters this state.

`POST /ops/recheck` with `{"hash": "0x..."}` runs the same chain checks a poll pass runs, for that one send, and
answers its `GET /sends/:hash` view (404 for an unknown hash). The body may hold the hash only (400 otherwise): an
operator can make the relayer look again, never tell it what happened. A send with a broadcast on its way, or a
recheck while a poll pass runs, is answered as it stands.

### `POST /groups`

Request:

```json
{ "chainId": 11155111, "safe": "0x...", "space": "my-group.eth", "signature": "0x..." }
```

`space` is the Group's ENS name in lowercase. `signature` is the owners' concatenated signatures.

- `201 {"chainId", "safe", "space", "community", "relayer"}`: registered.
- `201 {"chainId", "safe", "space", "community", "relayer", "replaced"}`: the Safe was registered with another space, and this space replaced it. `replaced` is the old space. See "Replacing the space" below.
- `200` with the same body as the first `201` (no `replaced`): the Safe was already registered with this space.
- `403`: the Safe did not accept the signature (wrong signer, wrong threshold, a different space, community or relayer than the one signed), or the chain is not configured.
- `409 safe_registered_with_another_space`: the Safe is registered with a different space, and a name job for that space has started registering, so the space can no longer be replaced.
- `503`: no key, or no `SPONSOR_RELAYER_COMMUNITY`.

#### Replacing the space

Someone can take a Group's name between its registration and its name job (`POST /send/ens`).
`POST /send/ens` only registers the label of the registered space, so the Group needs a new space.
A new registration for the same Safe and another space replaces the old space when all of this holds
(25-19 follow-up, orchestrator ruling of 2026-11-08):

1. The Safe accepts the signature for the new space: the same EIP-1271 check as a first registration.
   A signature another Safe accepts is refused with `403 registration_signature_invalid`.
2. No name job for the old space has started registering. A job for `<label>` of an old space
   `<label>.eth` that is `pending`, `committed` or `registered` has started. So has a `failed` job,
   unless it failed before its register transaction went to the queue: at the `price`, `balance`,
   `mint`, `approve`, `commit` or `wait` step, with `chain_not_available` or
   `payment_token_balance_too_low`, or at the register step's own checks (`register:name_taken`,
   `register:unreadable`, `register:price_changed`, `register:simulation_failed`,
   `register:fee_estimate_failed`, `register:cap_reached`). A job that failed at an unknown point
   (`internal`, `interrupted_by_restart`) counts as started. When a job has started, the answer is
   the existing `409 safe_registered_with_another_space` and nothing changes.
3. The new space replaces the old one in the Safe's one row; there is never a second space.

The check and the swap are one database transaction. `POST /send/ens` checks the space again, in one
transaction with creating its job, so a job never starts for a space that was just replaced: such a
request answers `403 label_not_space`. Two racing replacements leave one space, the last one stored.

### `POST /send/safe-exec`

Request (the Safe transaction the owners signed, plus their signatures):

```json
{
  "chainId": 11155111,
  "safe": "0x...",
  "to": "0x...",
  "value": "1000000000000000",
  "data": "0x",
  "operation": 0,
  "safeTxGas": "0",
  "baseGas": "0",
  "gasPrice": "0",
  "gasToken": "0x0000000000000000000000000000000000000000",
  "refundReceiver": "0x0000000000000000000000000000000000000000",
  "signatures": "0x..."
}
```

The relayer sends `Safe.execTransaction` to `safe` and pays the gas. It refuses unless all of this
holds:

1. `gasPrice` is 0, `gasToken` is the zero address and `refundReceiver` is the zero address.
2. The Safe is registered on that chain (`POST /groups`).
3. The static allowlist allows `(chainId, safe, execTransaction)`. If `operation` is 1 (a delegatecall), `to` must be one of the Safe MultiSend, MultiSendCallOnly, CreateCall or SignMessageLib contracts for that chain in `config/networks.json`.
4. An `eth_call` of the same transaction from the relayer's address returns true.

Answers: `202 {"hash": "0x...", "status": "pending"}`, or 400, 401, 403, 409, 429, 502, 503. Once the transaction
is broadcast the answer is always the 202 with its hash, even when the relayer's own bookkeeping after it fails
(that is logged); follow it with `GET /sends/:hash`.
The order inside the relayer is: field rules, registration, allowlist, gas estimate, cap reserve, simulation, queue. The spend is recorded when the receipt arrives.
The hash is the relayer's transaction hash. The relayer's answer is not proof of execution: read the
receipt from the chain yourself (GOV-04).

A request that repeats a send is a duplicate. The relayer reads the Safe's `nonce()` after the registration and
allowlist checks, and a send for the same chain, Safe and Safe nonce that is pending, stuck, confirming or mined (never
one that was replaced) already stands for the request. The answer is `202 {"hash": "0x...", "status": "pending",
"duplicate": true}` with that send's current hash, and nothing is reserved, signed or sent for it, so a retry can never
become a second transaction. The check runs inside the chain's send queue, so two concurrent requests cannot both pass.
If the Safe's nonce cannot be read the answer is `502 {"error": "send_failed", "reason": "safe_nonce_unreadable",
"broadcast": false}`.

The allowlist is a list of `(chainId, target, selector)` tuples built from `config/networks.json`
plus each registered Group's Safe. The relayer never calls Hats, an Arbitrator or `enableModule`
itself. Those run inside owner-signed Safe transactions, so the relayer is never the sender of a
member-role mint (D-05). Inner calls of an owner-signed Safe transaction are not restricted by
target: the owners authorized them, and payments go to arbitrary recipients. Only delegatecall
targets are restricted.

### `POST /send/ens` and `GET /jobs/:id`

Request:

```json
{ "chainId": 11155111, "safe": "0x...", "label": "my-group" }
```

The relayer registers `<label>.eth` through the ENSv2 registrar with `owner` = the Safe, and pays for it.
It never owns the name, never sets a resolver and never writes a record: `subregistry` and `resolver`
are the zero address and the duration is 365 days. Nothing is sent when any of these fails:

- `400 invalid_label`: the label is not lowercase `a-z`, `0-9` and `-`, 3 to 40 characters, with no hyphens in both the third and fourth position (the ENSIP-15 subset in `isValidLabel`, the same rules as the fresh3 vector tests).
- `403 unknown_chain`, or `403 no_ens_on_network` (with `detail: "no ENS on this network"`): the chain is not served, or it has no registrar in `config/networks.json` (Base Sepolia).
- `403 safe_not_registered`: the Safe is not registered on that chain.
- `403 label_not_space`: `<label>.eth` is not the space the Safe was registered with, also when the space was replaced while the request was being checked.
- `409 job_in_progress`: a job for that label has not finished. `409 name_taken`: the registrar says the label is not available.

Otherwise the answer is `202 {"jobId", "status": "pending"}` and the job runs on in the background:
mint the payment token (only on a network flagged `testnet` in `config/networks.json`; elsewhere the relayer's own balance must cover the price, else the job fails with `payment_token_balance_too_low`),
`approve` the registrar, `commit`, wait until the chain's clock is `MIN_COMMITMENT_AGE` (read from the
registrar) plus one second past the commit block, `register`, and read the owner back through the
UniversalHelper. Each step passes the allowlist, `cap.reserve` and the serial queue like any other send.

`GET /jobs/<id>` answers `200 {"jobId", "kind": "ens", "status", "chainId", "safe", "label", "txHashes"}`
and, when failed, `"error"`. `status` is `pending` until the commit has mined, `committed` while the job waits,
`registered` when the Safe owns the name, or `failed`. `error` is a step and a reason (`commit:reverted`,
`mint:cap_reached`, `register:name_taken`, `register:owner_mismatch`) and never an RPC URL. An unknown id is `404`
with `"reason": "job_not_found"`. Jobs live in the `jobs` table. A job a restart interrupted is marked
`failed` with `interrupted_by_restart` and never resumed, because a second run could pay twice: ask again.

## Reality steps and bond reclaim (25-07)

Three steps carry out a passed payment, and anyone may call each one on the chain, so the relayer sends and pays
for all three. Members and organizers sign nothing for them. A request names a Group and a proposal and nothing
that matters: `{"chainId", "safe", "proposalId"}`. The module is the one found on the chain for the registered Safe,
and the transactions, the question, the answer and the bond all come from the relayer's own reads. A field such as
`answer` or `bond` in a body is ignored.

| Endpoint | Sends | Refuses |
|---|---|---|
| `POST /send/reality/add` | module `addProposal(proposalId, txHashes)` | `409 proposal_not_final` until the hub says `closed` and `final` (the relayer calls the sequencer's `GET /scores/<id>` itself first); `409 proposal_not_passed`; `400 no_transactions`; `409 already_asked` |
| `POST /send/reality/answer` | Reality `submitAnswer(questionId, answer, 0)` with `value` = the module's `minimumBond` | `409 question_not_asked`, `409 already_answered`, `409 already_final` |
| `POST /send/reality/execute` | module `executeProposalWithIndex(...)`, simulated first | `409 not_finalized`, `409 answer_not_yes`, `409 cooldown` (a block strictly after finalize time plus cooldown is needed), `409 already_executed` |

How the answer is decided (D-09, D-16, TM-79): the relayer reads the proposal from the hub itself and answers `yes`
only when the proposal is in the Safe's registered space, is `closed` with scores `final`, the pass rule holds
(scores_total at least the quorum and For above Against, Abstain counting toward the quorum), at least three scores
are present (every proposal Drupal creates is a basic vote with three choices), and the hash of the transactions in
the proposal's `safeSnap` plugin for this module equals the question's hash. A proposal that is not final yet gets
`invalid`; every other case gets `no`. The answer is never taken from a request.

A request that repeats a step is a duplicate: a send for the same chain and question (and, for `execute`, the same
`txIndex`) that is pending, stuck, confirming or mined, never one that was replaced. The answer is the usual 202 with
that send's current hash and `"duplicate": true`, and nothing is reserved or sent for it. A duplicate `answer` does not
store the question again: the request that sent the answer does.

Once a step's transaction is broadcast the answer is `202 {"hash", "status": "pending", ...}`, also when the relayer's
bookkeeping after the broadcast fails (storing the question for reclaim, recording the send): that is logged, never
answered `502 read_failed`. A `502 read_failed` (with `"broadcast": false`) means a read failed before anything was sent.

Reclaim loop: a bond counts as spend until it comes back. Every minute the relayer looks at the questions it
answered. Once a question is final it rebuilds the answer history from the `LogNewAnswer` events (newest first, last
hash empty), sends `claimWinnings`, then `withdraw`, and credits the cap with the smaller of the bond and the amount
withdrawn, only after the `withdraw` receipt has status 1. If a challenger's answer won, nothing is sent and the
bond stays counted. A step that fails is stored as an audit row in the `events` table (the feed below does not serve
it) and tried again on the next pass. A question whose history contains a commit-reveal answer is left open with an error, because the
relayer does not claim those.

## Wrong answers (25-08, D-16)

Anyone may ask a Group's Reality module a question and answer it, so a wrong "yes" can finalize and move money long
before a daily check runs. The relayer therefore runs a watcher every minute (`SPONSOR_RELAYER_WATCH_INTERVAL_S`,
default 60) over every registered Group's Reality module, and reports what it did as events that Drupal turns into
organizer alerts. The daily check (D-09) stays on the Drupal side as the organizers' report.

What the watcher checks every minute:

1. It reads the `LogNewQuestion` events whose questioner is the module, in block ranges of at most 2,000, with a
   cursor per module. The first look at a module goes back 2,400 blocks, more than an hour on the fastest chain
   served.
2. For each open question that has an answer it asks the same `decide()` the answer endpoint uses (the hub, the pass
   rule, the transaction hash) what the answer should be, and compares it with Reality's best answer. A question for a
   proposal the hub does not know, or one with a different transaction, should be answered `no`; a question asked
   before the vote resolved, `invalid`.
3. A wrong answer is challenged at once with `decide()`'s answer and double the current bond, with `max_previous`
   set to the current bond. Every challenge goes through the spend cap and the serial queue like any other send, and
   the bond goes to the reclaim loop. A challenge still waiting for its receipt is not repeated. A challenge that
   mined without taking the answer is tried again, three times at most per bond level.
4. When the cap cannot cover the double bond (or the challenge keeps failing) nothing is sent and the watcher stores
   `escalation_needed` with the question's current finalize time as the deadline. The Group Safe owns the arbitrator,
   and the arbitrator is the backstop: the organizers have until the deadline to ask it for a ruling. The event is
   stored once per wrong answer, not once per tick; a higher wrong answer is a new escalation. A cap that frees up in
   time still lets the next tick challenge.
5. When a question is final, `decide()` is asked once more. A wrong final answer is a `wrong_final` event (the
   transaction can still be stopped by the Group Safe until `executableAfter`, the end of the cooldown). A question the
   watcher had flagged that ended right is a `resolved` event.

A hub that cannot be read never causes a challenge: the question is left for the next tick. An unanswered question is
left alone. The relayer's own answer has no special weight here either: a question it answered is judged like any
other, and the host's answer is never trusted over the hub's.

Real Groups use a 1-hour Reality timeout, set by the Drupal setup flow (D-16), so the one-minute cadence leaves at
least 59 minutes to challenge. Short timeouts exist only for the judge Group and fork tests, where a test moves the
clock itself.

Known limits: a second bond on a question that the relayer already answered once (an escalation war) is credited back
only up to the first bond, which errs toward a tighter cap. Each open question costs a few RPC reads per tick, and
asking a question costs an attacker only gas.

### `GET /events?since=<id>`

Bearer auth like every route but `/healthz`; internal network only. The events hold public chain data and no key.
`since` is a whole number (default 0); anything else is `400`. The answer is

```
{ "events": [ { "id", "type", "chainId", "safe", "module", "questionId", "proposalId", "detail", "at" } ], "next": <id> }
```

in id order, at most 100 at a time. `next` is the id of the last event returned, or `since` when there is nothing new;
pass it back as `since` on the next poll. `id` is a number. `at` is ISO 8601 in UTC. `safe`, `module`, `questionId`
and `proposalId` are strings or `null` (an event that is not about one question, such as `low_balance`, has `null`).
`detail` is an object; wei values inside it are decimal strings. The types:

| `type` | When | `detail` |
|---|---|---|
| `answer_challenged` | The watcher answered a wrong Reality answer | `answer`, `reason`, `previousAnswer`, `previousBondWei`, `bondWei`, `txHash`, `deadline`, `deadlineTs` |
| `escalation_needed` | The watcher could not challenge; the arbitrator has to take over before `deadline` | `reason` (`cap_reached` or `challenge_failed`), `currentBondWei`, `neededBondWei`, `currentAnswer`, `expectedAnswer`, `deadline`, `deadlineTs`, and `limit` and `until` or `attempts` |
| `resolved` | A question the watcher flagged finalized with the right answer | `answer`, `reason` |
| `wrong_final` | A question finalized with the wrong answer | `finalAnswer`, `expectedAnswer`, `reason`, `finalizedAt`, `executableAfter` |
| `cap_reached` | A send was refused by a spend cap; once per window | `limit` (`day` or `month`), `until`, `monthStartsAt`, `refusedWei`, `spentDayWei`, `spentMonthWei` |
| `send_stuck` | A send had no receipt after its third fee bump | `nonce`, `hash`, `attempts`, `kind`; `safe` is set when the send was for a Group |
| `low_balance` | The relayer's balance on a chain fell under `SPONSOR_RELAYER_LOW_BALANCE_WEI`; once until it recovers | `balanceWei`, `thresholdWei`, `address` |

An unknown type is refused when an event is stored, so the list above is the whole feed. Other rows in the `events`
table (`send_replaced`, `reality_*`) are audit lines and are not served.

## What an answer from this relayer means

An answer the relayer posts to Reality.eth carries no special weight. The relayer is one account
that pays for the step; anyone can challenge its answer by posting a higher bond, and the Group Safe
owns the arbitrator that settles a dispute (D-09, D-07). Nothing in this service decides the outcome
of a vote.

## Configuration

| Variable | Meaning |
|---|---|
| `WEB3_ENABLED` | Exactly `true` turns the relayer on. Anything else (unset, `TRUE`, `1`, empty) leaves it keyless: no key is read and every route but `/healthz` answers 503 `web3_disabled`. Not set in the image |
| `SPONSOR_RELAYER_PRIVATE_KEY` | The sending key, 32 bytes as 0x-prefixed hex. Container environment only (D-01). Read only when `WEB3_ENABLED` is `true` |
| `SPONSOR_RELAYER_CAP_DAY_WEI` | Rolling 24-hour spend cap in wei. Default `50000000000000000` |
| `SPONSOR_RELAYER_CAP_MONTH_WEI` | UTC calendar-month spend cap in wei. Default `500000000000000000` |
| `SPONSOR_RELAYER_TOKEN` | Bearer token shared with Drupal. With none set, every route but `/healthz` answers 401 |
| `SPONSOR_RELAYER_COMMUNITY` | The community name that registrations must name |
| `SPONSOR_RELAYER_RPC_URL_<chainId>` | RPC URL for a chain. Unset: the public URLs in `config/networks.json`. Reads fall back across the URLs; broadcasts and the release proof use the first URL only |
| `SPONSOR_RELAYER_DB` | sqlite path (`:memory:` allowed). Default `:memory:`; the image sets `/data/relayer.sqlite` |
| `SPONSOR_RELAYER_HUB_URL_<chainId>` | Snapshot hub base URL for a chain (`/graphql` is appended). Unset: `hub` in `config/networks.json`. Tests point it at a canned hub |
| `SPONSOR_RELAYER_SEQUENCER_URL_<chainId>` | Snapshot sequencer URL for a chain. Unset: `sequencer` in `config/networks.json` |
| `SPONSOR_RELAYER_WATCH_INTERVAL_S` | Seconds between wrong-answer watcher passes, a whole number from 1 to 3600. Default 60. Anything else stops the relayer at start |
| `SPONSOR_RELAYER_LOW_BALANCE_WEI` | The balance in wei under which a `low_balance` event is stored. Default `20000000000000000` (0.02 ETH). A value that is not a whole number stops the relayer at start |
| `SPONSOR_RELAYER_PORT` | Listen port. Default 8787; the image sets 8080 |
| `SPONSOR_RELAYER_HOST` | Listen address. Default `0.0.0.0`; publish no port outside the internal network |

Tests also read `FORK_RPC_URL_11155111` (default `http://127.0.0.1:18545`), `FORK_NETWORK`
(`ethereum_sepolia` by default, or `base_sepolia`) and set `WEB3_ENABLED=true` in their own setup.

`config/networks.json` holds every contract address, per chain id, with its source in a `_sources`
object. No address appears in `src/` (a guard test checks that). An entry with no contract
addresses is treated as empty: that chain refuses every send.

## Image

```
docker build -t gas-sponsor-relayer:p25 .
```

The Dockerfile builds on `node:24-alpine`, pinned by digest, as measured on 2026-11-08:

| | |
|---|---|
| Tag | `node:24-alpine` |
| Index digest (used in `FROM`) | `sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8` |
| linux/amd64 manifest | `sha256:ec318aabf188af4e5488847eea4b24452650b9917140563e140762526a37f1df` |

The image installs with `npm ci --omit=dev --ignore-scripts` from the checked lockfile (the 13
packages of the viem 2.57.10 verdict), copies only `src/` and `config/`, runs as the non-root user
`node` (uid 1000), and sets `SPONSOR_RELAYER_DB=/data/relayer.sqlite` and `SPONSOR_RELAYER_PORT=8080`.
It has no `EXPOSE`: publish no host port, Drupal reaches the relayer on the internal network. The
health check is `wget` on `/healthz`. It holds no `test/` directory and no `WEB3_ENABLED`; the
operator sets that, together with the key, only on an instance that wants sponsoring.

## Hosting cost

Measured on desktop-dev on 2026-11-08 (Docker, linux/amd64), replacing the estimate in the research
(image about 150 MB, idle memory 60 to 120 MB):

| Measure | Value |
|---|---|
| Image size (`docker image inspect`) | 217 MB (217367850 bytes), of which `node_modules` is 81 MB |
| Idle memory, web3 off (keyless) | 38.7 MiB |
| Idle memory, web3 on, no key | 38.7 MiB |
| Idle memory, web3 on, with a key and the poll loop running | 44.9 MiB |
| How | `docker stats --no-stream` 60 s after start, no requests |

Cost per instance: one container (about 45 MiB of memory at idle, a few more under load) and one
small sqlite volume at `/data`. That is one more small service next to the instance's qdrant.
Instances with web3 off still run the container (about 39 MiB) but hold no key and send nothing.

## Development

```
npm ci --ignore-scripts          # viem 2.57.10 is the only dependency
npm test                         # unit tests, no network
npm run mutate                   # mutation run over the spend-safety rules (a few minutes)
TEST_PATTERN='registration|safe-exec' npm run test:fork   # needs a Sepolia fork on :18545
```

`npm run mutate` (`scripts/mutate.mjs`) breaks one spend-safety rule at a time in `src/`, runs the unit suite, and
records which tests failed; it restores each file and uses no git command. A mutation that no test catches fails the
run. `node scripts/mutate.mjs --markdown` prints the table kept in `test/MUTATIONS.md`, with the test that catches
each mutation.

A test filter goes in the `TEST_PATTERN` environment variable, never as trailing npm arguments.
The fork suite runs one file at a time because the files share one anvil chain and one payer. In
the fresh3 repository, `bash tests/e2e/fork/fork.sh pin ethereum_sepolia` then `fork.sh up
ethereum_sepolia` start the fork, and `fork.sh down all` stops it. A provider without archive state
drops old blocks within an hour or so, so pin right before `up`. The test keys are anvil's public
dev keys and only ever sign on the local fork.

## Wallet seam (WAAP-F3)

The Drupal side (`gas_sponsor`) asks for intents ("sponsor setup", "sponsor exec", "start
execution", "post answer", "execute", "register name"), not raw transactions. A WaaP Gas Tank
funds a member's own wallet, which then sends; an intent interface fits that backend as well as
this relayer. Keep the HTTP surface intent-shaped when adding endpoints.
