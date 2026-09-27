/**
 * Promise-chaser bell — rings staff when a LEAD calls back on a number that
 * still carries an open, unkept Waves promise (a callback, a quote, a time
 * to come out) from an earlier UNBOOKED call. "Unbooked" is enforced
 * explicitly (BOOKED_STATUSES below, against the promise's own originating
 * call) — a genuinely separate promise on a call that DID result in an
 * appointment is not this alert's scope, even though it is still open.
 *
 * Event-driven, unlike the one-hour SLA pager (followup-sla-watcher.js),
 * which fires on a timer once a promise's own deadline passes — this one
 * fires the moment the number calls again, whether or not that deadline has
 * passed yet. The two never double up on the same event: this bell's
 * dedupe key is its own 'promise_chaser' family (never the pager's rolling
 * 'call_commitment_overdue' post), and its message says the caller called
 * (live, or — a durable retry — at a stated time), never that a deadline
 * was missed.
 *
 * The existing repeat-caller bell (GATE_REPEAT_CALLER_BELL) only rings on
 * 3+ calls from one number inside 3 hours — it misses a single callback
 * hours later, which is this alert's whole scope.
 *
 * "Kept" reuses the SLA pager's own evidence check (followedUpIds): a visit
 * booked since, a call that reached the caller, or a staff-typed text.
 * Nothing here is reimplemented — a promise the pager would already count
 * as followed up never rings this bell either.
 *
 * Durability (call_log.metadata.promise_chaser: pending → rung / skipped):
 * the 'pending' durability marker is written ATOMICALLY with the call_log
 * row itself — /voice's own insert/update embeds it (pendingClaimFragment),
 * gated on GATE_PROMISE_CHASER_BELL at THAT moment, so a row created while
 * the gate is dark never carries one, however much later the gate flips on
 * — and a screened caller's marker rides its 'passed' resolution the same
 * way. A crash right after either commit still leaves a claim the sweep
 * can find; a crash before it commits leaves no row at all, nothing to
 * recover. claimAttempt then takes the actual working lease (a fresh
 * claimed_at) the first time anything really attempts the call — the live
 * request, immediately, or the sweep, later — and settles it to a terminal
 * outcome once resolved. A transient failure (a thrown lookup, a
 * notification insert error) leaves it at 'pending' rather than settling
 * it, so the EXISTING call-alert recovery sweep (scheduler.js's every-2-
 * minutes tick, the same one missed-call-bell / repeat-caller-bell use)
 * retries it — no new sweep. A stale lease (LEASE_MS) is reclaimable, same
 * idiom as those two bells' own claim. A pre-connect screen still 'gated'
 * past SCREEN_ABANDON_MS is settled 'skipped' rather than left pending
 * forever, so an abandoned Gather never occupies every future sweep batch.
 *
 * Cross-call coordination (promiseDeliveryState): "once per promise per
 * day, never re-buzz a device already reached" is a PROMISE-scoped fact,
 * not a per-call one — a lead who hangs up and calls right back opens a
 * SEPARATE call_log row that could otherwise dispatch a second, unaware
 * attempt at the exact promise the first call already (partially)
 * delivered. stampTarget stamps which promise a still-pending claim is
 * targeting; every other row targeting the same promise (rung today, or
 * a fresh lease actively mid-dispatch right now) is checked before this
 * call ever dispatches, and any partial-push history those rows recorded
 * is merged into this dispatch's own deliveredSubscriptionIds exclusion
 * list.
 *
 * Gated by GATE_PROMISE_CHASER_BELL (needs GATE_CALL_COMMITMENTS too — no
 * commitment rows exist without it). Gate off: no claim is ever written and
 * the sweep does no query. Bell only — no customer comms, no writes to
 * call_commitments.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { etDateString, formatETDate, formatETTime } = require('../utils/datetime-et');
const commitments = require('./call-commitments');
const { whereNotBlockedCall, PHONE_KEY_SQL } = require('../middleware/spam-block');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { SLA_KINDS, followedUpIds, WHAT } = require('./followup-sla-watcher');
const { callReprocessInFlight } = require('../utils/estimate-claim-sql');

// The rule's own scope: "an earlier call ... ended UNBOOKED". Same live
// statuses repeat-caller-bell's BOOKED_SQL treats as booked — a call that
// resulted in an appointment is not the audit's unbooked-call pattern, even
// if a genuinely separate promise on it is still open.
const BOOKED_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site', 'completed'];

// Claim lease: covers a normal attempt (a handful of queries) with margin;
// a stale lease is reclaimable by a later attempt or the sweep — same
// duration missed-call-bell / repeat-caller-bell use for their own leases.
const LEASE_MS = 10 * 60 * 1000;
// How far back the durable sweep looks for a 'pending' claim (a crash
// between claim and settlement) — bounded, like every other call-alert
// sweep's recency scope; past this, a stuck claim just ages out unretried.
const SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// A pre-connect challenge normally resolves in seconds (a Gather timeout
// plus its own retries); past this, a caller who hung up mid-Gather with
// neither ?screened=1 nor ?screenfail=1 ever arriving is abandoned, not
// still in progress. Deliberately well past any real Gather's own timeout
// so a slow-but-genuine challenge is never mistaken for abandoned.
const SCREEN_ABANDON_MS = 30 * 60 * 1000;

function parseMeta(meta) {
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return meta && typeof meta === 'object' ? meta : {};
}

function promiseChaserState(meta) {
  return parseMeta(meta).promise_chaser || null;
}

// What we promised, and when — the two facts the alert body must carry.
function describePromise(row) {
  const what = WHAT[row.kind] || 'follow-up';
  const at = row.call_started_at ? new Date(row.call_started_at) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `${formatETDate(at)} ${formatETTime(at)}` : 'an earlier call';
  return { what, when };
}

// Atomic claim: first attempt wins; a stale 'pending' lease (a crash) is
// reclaimable, as is one with NO lease at all yet (claimed_at null — the
// durability marker /voice's own insert/update writes atomically with the
// row, before anyone has actually attempted it); 'rung' and 'skipped' are
// terminal and never reclaimed.
async function claimAttempt(callId) {
  const token = new Date().toISOString();
  const claimed = await db('call_log').where({ id: callId })
    .whereRaw("COALESCE(metadata->'promise_chaser'->>'status', '') NOT IN ('rung', 'skipped')")
    // Parenthesized as ONE fragment — knex ANDs separate whereRaw calls with
    // plain string concatenation, so an unparenthesized top-level OR here
    // would bind looser than the preceding ANDs and match ANY row with a
    // stale claimed_at, including unrelated and already-terminal calls
    // (repeat-caller-bell's own CLAIM_FREE_SQL wraps its OR the same way).
    .whereRaw("((metadata->'promise_chaser'->>'status' IS DISTINCT FROM 'pending') OR (metadata->'promise_chaser'->>'claimed_at') IS NULL OR (metadata->'promise_chaser'->>'claimed_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
    .update({
      // Merged INTO the existing promise_chaser sub-object (jsonb_set on
      // its own path), never replacing it wholesale: a full replace here
      // would silently wipe deliveredSubscriptionIds a PRIOR attempt's
      // recordProgress persisted (a partial push already reached some
      // devices) the moment this attempt reclaims the lease — before it
      // has any chance to recompute and re-merge that list itself. Every
      // other write in this file already merges the same way (settle keeps
      // this shape too, but only ever for a terminal outcome nothing reads
      // back after).
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata,'{}'::jsonb), '{promise_chaser}', COALESCE(metadata->'promise_chaser', '{}'::jsonb) || ?::jsonb, true)",
        [JSON.stringify({ status: 'pending', claimed_at: token })],
      ),
    });
  return claimed ? token : null;
}

// The durability marker /voice's own call_log insert (and its screened-
// caller 'passed' resolution) embeds ATOMICALLY with that same write, so a
// crash right after commit still leaves a claim the sweep can find. Gate
// off, or no usable phone (phoneDigits) at all, returns null — the caller
// then omits the key entirely, so a row created while dark never carries
// one and the sweep (which only ever looks at 'pending' rows) can never
// mistake it for a crashed live attempt, however much later the gate flips
// on. `claimed_at: null` (never a fresh token) — this is a durability
// marker, not a lease; claimAttempt is what actually takes the lease, the
// FIRST time anything really attempts the call (immediately, in the same
// request, for a non-screened caller or a passed screen; otherwise the
// sweep, later).
function pendingClaimFragment(fromPhone) {
  if (!isEnabled('promiseChaserBell') || !isEnabled('callCommitments')) return null;
  if (!commitments.phoneDigits(fromPhone)) return null;
  return { promise_chaser: { status: 'pending', claimed_at: null } };
}

// Settle a claim to a terminal outcome, fenced on the token: a stale owner
// waking up late cannot overwrite what a newer attempt already decided.
// `commitmentId` (stamped here on a 'rung'/'skipped' settle, and by
// stampTarget on a still-pending claim before dispatch) is what
// promiseDeliveryState checks — the cross-call "once per promise per day,
// never re-buzz a device already reached" decision, made here rather than
// through notifyAdmin's own dedupe, so a retry of THIS call's own failed
// push is never mistaken for a duplicate.
async function settle(callId, token, status, reason = null, commitmentId = null) {
  await db('call_log').where({ id: callId })
    .whereRaw("metadata->'promise_chaser'->>'claimed_at' = ?", [token])
    .update({
      metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('promise_chaser', ?::jsonb)",
        [JSON.stringify({ status, reason, commitmentId, claimed_at: token, at: new Date().toISOString() })]),
    });
}

// Records progress on an attempt that is staying 'pending' for the sweep to
// retry — currently just deliveredSubscriptionIds (a partial push already
// reached some devices; a retry must not re-buzz them). Same token fence as
// settle, and deliberately keeps the ORIGINAL claimed_at rather than
// refreshing it: every other "leave pending" path in this file (a thrown
// lookup, stats.retryable) also leaves claimed_at untouched, so a retry's
// own cadence is the same LEASE_MS backoff throughout, never reset to a
// fresh window just because this one attempt made partial progress.
// Merged INTO the existing sub-object (jsonb_set on its own path), never
// replacing it wholesale: `extra` never carries commitmentId, so a
// wholesale replace here would silently wipe the commitmentId stampTarget
// just stamped moments earlier, breaking promiseDeliveryState's cross-call
// check for a SEPARATE call that reaches this same promise next (Codex
// #5019 r10 — a wholesale replace bringing back the same bug class
// claimAttempt was already fixed for, just on a different write path).
async function recordProgress(callId, token, extra) {
  await db('call_log').where({ id: callId })
    .whereRaw("metadata->'promise_chaser'->>'claimed_at' = ?", [token])
    .update({
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata,'{}'::jsonb), '{promise_chaser}', COALESCE(metadata->'promise_chaser', '{}'::jsonb) || ?::jsonb, true)",
        [JSON.stringify({ status: 'pending', claimed_at: token, ...extra })],
      ),
    });
}

// Gives this attempt's OWN just-taken lease back immediately, on a defer
// (cross.activeElsewhere) — claimAttempt has ALREADY written a fresh
// claimed_at by the time that check runs, so a bare "leave it as is"
// would make THIS row look freshly active to the very next row that
// checks the same promise, and to itself on the sweep's own fresh-lease
// exclusion — two staggered callers for the same promise could then keep
// re-freshing each other's leases and deferring to one another
// indefinitely, losing the alert altogether (Codex #5019 r14). Clearing
// claimed_at back to null (never a fresh token) makes this row eligible
// for the very next sweep tick — a defer is expected to resolve in
// seconds, not the full LEASE_MS backoff a genuine failure warrants — and
// invisible to any OTHER row's own activeElsewhere check in the meantime.
async function releaseClaim(callId, token) {
  await db('call_log').where({ id: callId })
    .whereRaw("metadata->'promise_chaser'->>'claimed_at' = ?", [token])
    .update({
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata,'{}'::jsonb), '{promise_chaser}', COALESCE(metadata->'promise_chaser', '{}'::jsonb) || '{\"claimed_at\": null}'::jsonb, true)",
      ),
    });
}

// Stamps which promise THIS pending claim is targeting, the moment
// selectPromiseToRing picks one — before any cross-call check runs, so a
// concurrent call's OWN check can see us. Merged into the sub-object
// (jsonb_set on its own path), same as claimAttempt's own merge: a
// wholesale replace here would re-wipe deliveredSubscriptionIds a PRIOR
// attempt on this same row already persisted, the exact bug claimAttempt
// itself was just fixed for.
//
// A retry can legitimately switch which promise it targets (the last one
// was dismissed or kept since); when it does, deliveredSubscriptionIds
// belongs to the OLD target and must be cleared in the SAME atomic write
// — an in-memory "only reuse it for a matching target" check in the
// caller is not enough on its own: if THIS attempt never reaches
// recordProgress or settle at all (it defers on cross.activeElsewhere, or
// throws), the row would otherwise sit with commitmentId already pointing
// at the NEW promise but deliveredSubscriptionIds still holding the OLD
// promise's devices — corrupting exactly what the NEXT retry reads back.
// The CASE below is the single write that can ever change commitmentId,
// so it is the one place that has to make this atomic.
async function stampTarget(callId, token, promiseId) {
  const idText = String(promiseId);
  await db('call_log').where({ id: callId })
    .whereRaw("metadata->'promise_chaser'->>'claimed_at' = ?", [token])
    .update({
      metadata: db.raw(
        `jsonb_set(COALESCE(metadata,'{}'::jsonb), '{promise_chaser}',
          CASE WHEN metadata->'promise_chaser'->>'commitmentId' IS DISTINCT FROM ?
            THEN (COALESCE(metadata->'promise_chaser','{}'::jsonb) - 'deliveredSubscriptionIds') || jsonb_build_object('commitmentId', ?::text)
            ELSE COALESCE(metadata->'promise_chaser','{}'::jsonb) || jsonb_build_object('commitmentId', ?::text)
          END, true)`,
        [idText, idText, idText],
      ),
    });
}

// The cross-call half of "once per promise per day, never re-buzz a
// device already reached": every OTHER call_log row (never this one —
// this call's own retry of its own not-yet-rung attempt must never be
// blocked by it) currently targeting this SAME promise (stampTarget's own
// commitmentId, checked on both terminal AND still-pending claims, unlike
// the old rung-only check this replaces). Reports three things at once:
// alreadyRung — a genuinely separate call settled 'rung' for it today
//   (ET); this call must settle 'skipped' rather than ring again.
// activeElsewhere — another call is holding a FRESH lease on this exact
//   promise RIGHT NOW (mid-dispatch); this call defers rather than racing
//   it — the sweep retries on its own normal LEASE_MS cadence, by which
//   point the other attempt has settled or its own lease has gone stale.
// deliveredElsewhere — the union of deliveredSubscriptionIds any OTHER
//   call's own partial push already persisted for this promise — merged
//   into THIS call's own exclusion list before it ever dispatches, so a
//   second call for the same promise (a lead who hangs up and immediately
//   calls right back) never re-buzzes a device the first call already
//   reached, even though that history lives on a different row.
// Bounded to 48h so it stays a bounded index scan, not a table scan.
async function promiseDeliveryState(promiseId, callId, now) {
  const rows = await db('call_log')
    .where('id', '<>', callId)
    .where('created_at', '>', new Date(now.getTime() - 48 * 60 * 60 * 1000))
    .whereRaw("metadata->'promise_chaser'->>'commitmentId' = ?", [String(promiseId)])
    .select(db.raw("metadata->'promise_chaser' as pc"));
  const today = etDateString(now);
  const delivered = new Set();
  let alreadyRung = false;
  let activeElsewhere = false;
  for (const { pc } of rows) {
    if (!pc || typeof pc !== 'object') continue;
    if (pc.status === 'rung' && pc.at && etDateString(new Date(pc.at)) === today) alreadyRung = true;
    if (pc.status === 'pending' && pc.claimed_at && Date.now() - new Date(pc.claimed_at).getTime() < LEASE_MS) activeElsewhere = true;
    if (Array.isArray(pc.deliveredSubscriptionIds)) pc.deliveredSubscriptionIds.forEach((id) => delivered.add(id));
  }
  return { alreadyRung, activeElsewhere, deliveredElsewhere: [...delivered] };
}

// Is there an earlier, unbooked call on this same number, inside the
// sweep's own lookback window, whose commitments extraction might still be
// running? Two windows, matching the pipeline's own two stages exactly:
// callReprocessInFlight (call-recording-processor.js's own shared,
// dependency-free verdict via estimate-claim-sql.js — a live
// processing_token, or a processing_status the pipeline itself still
// treats as running or retry-eligible) for a call still mid transcription/
// extraction, or — once that clears — a finalize write (updated_at) more
// recent than MODEL_TIMEOUT_MS: recordCommitmentsStep's own commitments
// model pass runs AFTER that write commits and is bounded by exactly this
// timeout, so a call that fresh may not have its promise recorded yet even
// though processing_status already reads 'processed'.
async function earlierCommitmentsPending(call, now) {
  const rows = await commitments.phoneWhereAny(
    db('call_log').where({ direction: 'inbound' })
      .where('created_at', '>', new Date(now.getTime() - SWEEP_LOOKBACK_MS))
      .where('created_at', '<', call.created_at),
    'from_phone', [call.from_phone],
  ).select('id', 'created_at', 'updated_at', 'processing_token', 'processing_status', 'extraction_attempts');
  if (!rows.length) return false;
  const bookedIds = new Set((await db('scheduled_services')
    .whereIn('source_call_log_id', rows.map((r) => r.id))
    .whereIn('status', BOOKED_STATUSES)
    .pluck('source_call_log_id')).map(String));
  return rows.filter((r) => !bookedIds.has(String(r.id))).some((r) => callReprocessInFlight(r, now.getTime())
    || (r.updated_at && now.getTime() - new Date(r.updated_at).getTime() < commitments.MODEL_TIMEOUT_MS));
}

// Which open Waves promise (if any) this call should ring for, or why not:
// { outcome: 'found', promise, what, when } — a candidate, ready to dispatch.
// { outcome: 'skip', reason } — a definitive, settle-able fact (no open
//   promise, its own call was booked, it's no longer open, or it was kept).
// { outcome: 'retry' } — a lookup could not be verified; leave the claim
//   pending for the durable sweep rather than giving up on it.
async function selectPromiseToRing(call, now) {
  // Every open Waves promise (callback / quote / time to come out) made on
  // an EARLIER call from this same number — never this call's own row,
  // which the recording pipeline has not even extracted yet. When the
  // CURRENT caller is a known customer, a promise whose own call belongs to
  // a DIFFERENT customer (a shared or reassigned number) is excluded — an
  // unlinked call on the same number stays eligible.
  const rows = (await commitments.listOpenCommitments(db, {
    party: 'waves', phone: call.from_phone, limit: 200, includeHints: true, now,
  })).filter((r) => SLA_KINDS.includes(r.kind) && String(r.call_log_id) !== String(call.id)
    // Strictly PRECEDES this callback — never the current call's own row
    // (excluded above), and never a call that arrived AFTER it either.
    // A durable retry (the sweep) can land hours later, by which time a
    // NEWER call on the same number may have its own open promise; without
    // this, that later promise would wrongly read as "the reason this
    // earlier caller is chasing us".
    && new Date(r.call_started_at).getTime() < new Date(call.created_at).getTime()
    && (!call.customer_id || !r.customer_id || String(r.customer_id) === String(call.customer_id)));
  if (!rows.length) {
    // On a QUICK callback, the earlier call's own commitments pass
    // (recordCommitmentsStep, call-recording-processor.js) may genuinely
    // not have finished yet — it runs AFTER the call's own terminal
    // finalize write (processing_token cleared, processing_status already
    // 'processed'), bounded only by MODEL_TIMEOUT_MS, so "no rows" here can
    // mean "hasn't looked yet", not "found nothing". "No open promise" is
    // never a settled fact while that's still possible.
    if (await earlierCommitmentsPending(call, now)) return { outcome: 'retry' };
    return { outcome: 'skip', reason: 'no_open_promise' };
  }

  // Scope to calls that ended UNBOOKED (the rule's own trigger, and the
  // audit's pattern) — a call that resulted in an appointment is excluded
  // even when a genuinely separate promise on it is still open, same as
  // repeat-caller-bell's own booked-window exclusion.
  const candidateCallIds = [...new Set(rows.map((r) => r.call_log_id))];
  const bookedCallIds = new Set((await db('scheduled_services')
    .whereIn('source_call_log_id', candidateCallIds)
    .whereIn('status', BOOKED_STATUSES)
    .pluck('source_call_log_id')).map(String));
  const unbooked = rows.filter((r) => !bookedCallIds.has(String(r.call_log_id)));
  if (!unbooked.length) return { outcome: 'skip', reason: 'originating_call_booked' };

  // Refresh the fulfillment proof for the candidate calls first — nothing
  // stamps it until someone opens the queue (the SLA pager's own rule). A
  // call whose proof could not be verified (thrown, or refreshFulfillment's
  // own per-commitment `failed` count) is excluded below — an unverified
  // lookup proves nothing, and ringing on it risks a false alert for a
  // promise that was actually just kept.
  const callIds = [...new Set(unbooked.map((r) => r.call_log_id))];
  const unverified = new Set();
  for (const id of callIds) {
    const result = await commitments.refreshFulfillment(db, id).catch((err) => {
      logger.warn(`[promise-chaser-bell] fulfillment refresh failed for call ${id}: ${err.message}`);
      return { failed: 1 };
    });
    if (result.failed > 0) unverified.add(id);
  }
  const live = await commitments.stillOpenIds(db, unbooked.map((r) => r.id), { now });
  let open = unbooked.filter((r) => live.has(r.id) && !unverified.has(r.call_log_id));
  if (unverified.size && !open.length) return { outcome: 'retry' };
  if (!open.length) return { outcome: 'skip', reason: 'not_open' };

  // followedUpIds needs each row's call-ended time (promisedAt's basis) —
  // the same merge the SLA pager itself does before calling it.
  const calls = callIds.length
    ? await db('call_log').whereIn('id', callIds).select('id', 'created_at', 'duration_seconds', 'bridged_at', 'direction')
    : [];
  const endedById = new Map(calls.map((c) => [c.id, commitments.callEndedAt(c)]));
  open = open.map((r) => ({ ...r, call_ended_at: endedById.get(r.call_log_id) || null }));

  // Booked since, called back and reached, or texted by staff since the
  // promise — the SLA pager's own "kept" evidence, reused rather than
  // reimplemented. A lookup failure is a retry — an unproven "kept" must
  // never ring, but it must not be given up on either.
  const followed = await followedUpIds(db, open).catch((err) => {
    logger.warn(`[promise-chaser-bell] follow-up lookup failed: ${err.message}`);
    return null;
  });
  if (followed === null) return { outcome: 'retry' };
  open = open.filter((r) => !followed.has(r.id));
  if (!open.length) return { outcome: 'skip', reason: 'kept' };

  // The promise the caller has waited longest for.
  open.sort((a, b) => new Date(a.call_started_at) - new Date(b.call_started_at));
  const promise = open[0];
  return { outcome: 'found', promise, ...describePromise(promise) };
}

// Dispatches the notification for a SELECTED promise and classifies the
// outcome — never writes to call_log itself; the caller owns the token-
// fenced claim/settle write, same as every other decision in this file.
// Returns { pending: { deliveredSubscriptionIds } } to leave the claim
// open for the sweep, or { settle: { status, reason, commitmentId },
// delivered } for a definitive, terminal outcome.
async function dispatchPromiseNotification(call, promise, what, when, { viaSweep, existing }) {
  const customer = call.customer_id
    ? await db('customers').where('id', call.customer_id).first('first_name', 'last_name')
    : null;

  // Re-checked immediately before both the bell write and the push: staff
  // may dismiss, fulfill, or close the commitment — or a manual text, a
  // qualifying outbound call, or a booking may land — in the gap between
  // selectPromiseToRing's own snapshot and dispatch here. Re-runs the SAME
  // two kept-evidence predicates selectPromiseToRing already used (never a
  // narrower recheck), so this bell and the SLA pager can never disagree on
  // what counts as kept. A lookup failure returns false explicitly (never
  // throws) — shouldContinue and beforePush both fail CLOSED on a plain
  // false, unlike their shared throw-tolerant fail-OPEN contract, so an
  // unverifiable recheck blocks the send outright; recheckError (checked
  // below, payment-failure-notifications.js's own pattern) is what tells
  // the caller this was a lookup failure, not a genuine close, so the
  // claim is left pending for retry rather than settled skipped.
  let recheckError = null;
  const stillEligible = async () => {
    try {
      const stillLive = await commitments.stillOpenIds(db, [promise.id], { now: new Date() });
      if (!stillLive.has(promise.id)) return false;
      const followedNow = await followedUpIds(db, [promise]);
      return !followedNow.has(promise.id);
    } catch (err) {
      recheckError = err;
      return false;
    }
  };

  const { triggerNotification } = require('./notification-triggers');
  // Once per promise per ET day — a caller who rings twice in an afternoon
  // does not double the bell (notifyAdmin's own dedupe lock).
  const dedupeKey = `waves-promise_chaser-${promise.id}-${etDateString(new Date())}`;
  // Devices a PRIOR attempt already buzzed (a partial push — sent > 0,
  // failed > 0 — persisted these on its own way to leaving the claim
  // pending) never get buzzed again on this retry — payment-failure-
  // notifications.js's own deliveredSubscriptionIds pattern.
  const deliveredSoFar = Array.isArray(existing?.deliveredSubscriptionIds) ? existing.deliveredSubscriptionIds : [];
  const stats = await triggerNotification('promise_chaser', {
    customerId: call.customer_id || null,
    name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || null,
    phone: call.from_phone,
    callLogId: call.id,
    commitmentId: promise.id,
    what,
    when,
    // "Calling in now" is only true at the live call sites; a durable
    // retry lands after the call has already ended.
    liveCall: !viaSweep,
    calledAtLabel: call.created_at ? `${formatETDate(new Date(call.created_at))} ${formatETTime(new Date(call.created_at))}` : null,
  }, { dedupeKey, shouldContinue: stillEligible, beforePush: stillEligible, deliveredSubscriptionIds: deliveredSoFar });

  const acceptedNow = Array.isArray(stats?.push?.deliveredSubscriptionIds) ? stats.push.deliveredSubscriptionIds : [];
  const mergedDeliveredIds = [...new Set([...deliveredSoFar, ...acceptedNow])];

  // triggerNotification never throws — a swallowed bell-insert failure, a
  // failed push, or a failed preferences lookup surfaces as stats.retryable
  // / stats.prefsUnavailable (often with no stats.error at all) rather than
  // a caught exception. Any of these, or an unverifiable recheck above,
  // leaves the claim pending; only a definitive, non-retryable outcome may
  // settle.
  if (recheckError || stats?.error || stats?.retryable || stats?.prefsUnavailable) {
    return { pending: { deliveredSubscriptionIds: mergedDeliveredIds } };
  }
  // Genuine delivery only — a deliberate non-send (every admin opted out,
  // the bell policy silenced the category, or stillEligible just blocked a
  // promise that closed in the race window) is still a settled, non-
  // retryable outcome, but it never counts as "rang".
  const delivered = Boolean(stats && (stats.bellWritten || Number(stats.push?.sent || 0) > 0));
  const skipReason = stats?.suppressed ? 'suppressed' : (stats?.policySilenced ? 'policy_silenced' : 'not_delivered');
  return {
    settle: { status: delivered ? 'rung' : 'skipped', reason: delivered ? null : skipReason, commitmentId: delivered ? promise.id : null },
    delivered,
  };
}

/**
 * Called from the /voice webhook at two points: immediately, for a call the
 * pre-connect screen never challenges, or once a challenged caller PASSES it
 * (?screened=1) — never while a challenge is still outstanding, or a caller
 * who goes on to fail it would have already heard "calling in now" about
 * themselves. Also called by the durable sweep (`viaSweep: true`) for any
 * claim left 'pending' by a failed attempt.
 *
 * `viaSweep`: selects the alert's own copy — "is calling in now" only while
 * that is still true (the live call sites); a retry that lands after the
 * call has ended says when they called instead.
 */
async function ringPromiseChaserIfNeeded(callSid, { viaSweep = false } = {}) {
  if (!callSid || !isEnabled('promiseChaserBell') || !isEnabled('callCommitments')) return false;
  try {
    const call = await db('call_log').where('twilio_call_sid', callSid)
      .modify(whereNotBlockedCall)
      .modify((qb) => whereNotSandboxCall(qb))
      .first();
    if (!call || call.direction !== 'inbound') return false;
    const phone = call.from_phone;
    if (!commitments.phoneDigits(phone)) return false;

    const existing = promiseChaserState(call.metadata);
    if (existing?.status === 'rung') return true;
    if (existing?.status === 'skipped') return false;

    // Still mid pre-connect screen (a challenge issued, no key pressed and
    // no timeout yet) — the durability marker /voice's insert wrote is a
    // 'pending' row with no lease, same as any other, so without this check
    // a sweep tick landing in the few seconds before 'passed'/'failed'
    // resolves could ring "calling in now" about someone not proven human
    // yet. Soft skip: no claim taken, nothing settled — the caller's own
    // screen resolution (or a later sweep tick, once it has) picks this up.
    // Past SCREEN_ABANDON_MS, though, "still gated" stops being a fresh
    // in-progress challenge and starts being a caller who hung up mid-
    // Gather with NEITHER ?screened=1 nor ?screenfail=1 ever arriving: a
    // soft skip forever would leave the row 'pending' at every future
    // sweep tick, up to LIMIT of them occupying a batch that could
    // otherwise recover a genuinely actionable claim (Codex #5019 r10).
    // Take the claim and settle it terminally so it converges instead.
    if (parseMeta(call.metadata).preconnect_screen === 'gated') {
      if (Date.now() - new Date(call.created_at).getTime() < SCREEN_ABANDON_MS) return false;
      const abandonToken = await claimAttempt(call.id);
      if (!abandonToken) return false;
      await settle(call.id, abandonToken, 'skipped', 'screen_abandoned');
      return false;
    }

    const token = await claimAttempt(call.id);
    if (!token) return false; // a fresh attempt already owns this call right now

    // Checked directly here, not only via markScreenFailed's own terminal
    // mark: if that mark itself failed to write (a crash between
    // stampPreconnectScreen('failed') and it) or never ran, a caller who
    // fell to voicemail must still never ring — this call's own metadata
    // (call_log.metadata.preconnect_screen, stamped by the webhook) already
    // says so independently of promise_chaser's own claim state.
    if (parseMeta(call.metadata).preconnect_screen === 'failed') {
      await settle(call.id, token, 'skipped', 'screen_failed');
      return false;
    }

    const now = new Date();
    const selection = await selectPromiseToRing(call, now);
    if (selection.outcome === 'retry') return false; // leave pending — the sweep retries it
    if (selection.outcome === 'skip') { await settle(call.id, token, 'skipped', selection.reason); return false; }
    const { promise, what, when } = selection;

    // A retry (the sweep reclaiming this SAME row) can legitimately select
    // a DIFFERENT promise than its own prior attempt did — the first
    // promise may have been dismissed or kept in the meantime. This row's
    // OWN deliveredSubscriptionIds belongs to whichever promise it was
    // targeting when a PRIOR attempt persisted it (existing.commitmentId,
    // read before stampTarget below overwrites it); reused only when this
    // attempt is chasing that SAME promise again, never carried over onto
    // an unrelated one it was never actually delivered against.
    const priorTarget = existing?.commitmentId;
    const ownDeliveredSoFar = priorTarget && String(priorTarget) === String(promise.id)
      ? (existing?.deliveredSubscriptionIds || []) : [];

    // Stamp which promise this claim now targets BEFORE the cross-call
    // check below, so a concurrent call checking the SAME promise can see
    // us. Cross-call half of "once per promise per day, never re-buzz a
    // device already reached": a genuinely SEPARATE call for the same
    // open promise, already rung today by another call, must not re-buzz;
    // one actively mid-dispatch for it RIGHT NOW is deferred rather than
    // raced; either way, a PRIOR call's own partial-push history is
    // merged into this dispatch's exclusion list. Never blocks THIS call's
    // own retry of its own not-yet-rung attempt (it only ever looks at
    // OTHER rows).
    await stampTarget(call.id, token, promise.id);
    const cross = await promiseDeliveryState(promise.id, call.id, now);
    if (cross.alreadyRung) {
      await settle(call.id, token, 'skipped', 'already_rung_today', promise.id);
      return false;
    }
    if (cross.activeElsewhere) {
      // Defer — but give this row's own just-taken lease back immediately
      // rather than leaving it artificially fresh (see releaseClaim): the
      // sweep's very next tick can retry it, and no OTHER row's own check
      // mistakes it for an active dispatcher in the meantime.
      await releaseClaim(call.id, token);
      return false;
    }

    const existingWithCrossDelivered = {
      ...existing,
      deliveredSubscriptionIds: [...new Set([...ownDeliveredSoFar, ...cross.deliveredElsewhere])],
    };
    const result = await dispatchPromiseNotification(call, promise, what, when, { viaSweep, existing: existingWithCrossDelivered });
    if (result.pending) { await recordProgress(call.id, token, result.pending); return false; }
    await settle(call.id, token, result.settle.status, result.settle.reason, result.settle.commitmentId);
    return result.delivered;
  } catch (err) {
    logger.warn(`[promise-chaser-bell] failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false; // leave any claim already written pending — retry
  }
}

/**
 * Called from the /voice webhook when a pre-connect-screened caller never
 * presses a key (?screenfail=1) and falls to voicemail — they never reached
 * staff, so the bell must never say "calling in now" (or anything at all)
 * about them. Marks the call terminal without ever attempting a ring.
 */
async function markScreenFailed(callSid) {
  if (!callSid || !isEnabled('promiseChaserBell')) return false;
  try {
    const call = await db('call_log').where('twilio_call_sid', callSid).first('id', 'metadata');
    if (!call) return false;
    // Never override a REAL outcome another path already reached (e.g. a
    // duplicate Twilio postback replaying an already-settled call) — but DO
    // override the plain 'pending' durability marker /voice's own insert
    // wrote atomically with the row: that marker is not an outcome, just
    // "gate was live when this row was created", and this call resolving
    // to 'failed' is exactly the outcome it was waiting to learn.
    const existing = promiseChaserState(call.metadata);
    if (existing?.status === 'rung' || existing?.status === 'skipped') return false;
    const updated = await db('call_log').where({ id: call.id })
      .whereRaw("COALESCE(metadata->'promise_chaser'->>'status', '') NOT IN ('rung', 'skipped')")
      .update({
        metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('promise_chaser', ?::jsonb)",
          [JSON.stringify({ status: 'skipped', reason: 'screen_failed', at: new Date().toISOString() })]),
      });
    return updated > 0;
  } catch (err) {
    logger.warn(`[promise-chaser-bell] markScreenFailed failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

/**
 * Durable retry (runs on the existing 2-minute call-alert recovery tick,
 * scheduler.js — the same one missed-call-bell / repeat-caller-bell use):
 * re-offer any inbound call whose claim is still 'pending' (a prior attempt
 * threw, or a notification insert/push failed) from the last 24h. Idempotent
 * — the atomic claim inside ringPromiseChaserIfNeeded makes a re-offer a
 * no-op once another attempt already owns or has settled the call.
 *
 * Deliberately does NOT scan for calls with no promise_chaser key at all
 * (a prior version did, to recover a claim that never got written) — a
 * 'pending' durability marker is now written ATOMICALLY with the call_log
 * row itself (or, for a screened caller, with its 'passed' resolution) —
 * see pendingClaimFragment / the /voice wiring — so a genuine crash before
 * that write ever commits leaves NO row at all, nothing to recover, and a
 * row with no key was created while the gate was DARK and must stay
 * untouched no matter how much later the gate flips on. Scanning "no key"
 * rows instead treated every one of them (however old, however long the
 * gate had been off) as a crashed live attempt and backfilled a burst of
 * delayed alerts the moment the gate first went live.
 *
 * Excludes blocked numbers, sandbox calls, and unusable caller IDs
 * (mirroring ringPromiseChaserIfNeeded's own basic eligibility) — belt and
 * suspenders only now, since none of those paths can reach pendingClaim
 * Fragment in the first place, but cheap insurance against a future writer
 * of this same claim shape.
 *
 * Also excludes, BEFORE the LIMIT, two classes of 'pending' row that
 * ringPromiseChaserIfNeeded would immediately turn back on anyway: a row
 * whose lease is still FRESH (another attempt owns it right now — a live
 * request or an overlapping sweep tick) and a row still mid an outstanding
 * pre-connect screen that has not yet had time to abandon. Without this, a
 * batch of either can occupy the whole LIMIT and starve genuinely
 * recoverable claims behind them (Codex #5019 r10) — an abandoned screen
 * past SCREEN_ABANDON_MS is deliberately left IN this query so
 * ringPromiseChaserIfNeeded gets a chance to settle it terminally and it
 * stops recurring in every future batch.
 */
async function sweepPromiseChasers({ limit = 50 } = {}) {
  if (!isEnabled('promiseChaserBell') || !isEnabled('callCommitments')) return 0;
  const since = new Date(Date.now() - SWEEP_LOOKBACK_MS);
  const rows = await db('call_log')
    .where({ direction: 'inbound' })
    .modify(whereNotBlockedCall)
    .modify((q) => whereNotSandboxCall(q))
    .whereRaw(`LENGTH(${PHONE_KEY_SQL}) BETWEEN 10 AND 15`)
    .where('created_at', '>', since)
    .whereRaw("metadata->'promise_chaser'->>'status' = 'pending'")
    .whereRaw("(metadata->'promise_chaser'->>'claimed_at' IS NULL OR (metadata->'promise_chaser'->>'claimed_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
    .whereRaw("(COALESCE(metadata->>'preconnect_screen', '') <> 'gated' OR created_at < ?)", [new Date(Date.now() - SCREEN_ABANDON_MS)])
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('twilio_call_sid');
  let rang = 0;
  for (const row of rows) {
    if (row.twilio_call_sid && await ringPromiseChaserIfNeeded(row.twilio_call_sid, { viaSweep: true })) rang += 1;
  }
  return rang;
}

module.exports = { ringPromiseChaserIfNeeded, markScreenFailed, sweepPromiseChasers, pendingClaimFragment, describePromise };
