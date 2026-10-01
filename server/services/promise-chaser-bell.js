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
 * passed yet. The two never double up on the same event: this bell's own
 * dedupe key family ('promise_chaser:<id>:<ET day>') is never the pager's
 * rolling 'call_commitment_overdue' post, and its copy always says WHEN the
 * caller called, never that a deadline was missed.
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
 * STATELESS, IDEMPOTENT SWEEP — the ONE path (no per-call claim, no lease,
 * and no promise-chaser-owned STATE MACHINE of its own ever written to
 * call_log or call_commitments — refreshFulfillment's own shared
 * stale-hint stamp on call_commitments, the SAME side effect the SLA
 * pager's own read already triggers, is the one pre-existing write this
 * file's own reads happen to cause, not a new one): the existing 2-minute
 * call-alert recovery cron (scheduler.js — the same one missed-call-bell /
 * repeat-caller-bell use) calls sweepPromiseChasers, which re-evaluates
 * every ELIGIBLE inbound call from the last 30 minutes from scratch, every
 * tick. "Nothing qualifies this tick" is never a terminal fact; a promise
 * whose own extraction lands on a LATER tick is simply found then, by a
 * fresh read of call_commitments — this is what replaced the old design's
 * own claim/lease/retry state machine (and, with it, its own P1 history:
 * wholesale-vs-merge writes, sweep-batch starvation from stuck leases,
 * cross-call double-ring races, delivered-device history scoped to the
 * wrong promise or the wrong day, and a defer/release livelock between two
 * staggered callers). None of that machinery exists to have those bugs.
 *
 * "Eligible" is ONE metadata key, `promise_chaser_eligible: true`, stamped
 * by the /voice webhook (twilio-voice-webhook.js) ATOMICALLY with the same
 * call_log row it inserts — gated on isEnabled('promiseChaserBell') at
 * that exact moment, added to nothing else, no extra query. This is a
 * PER-CALL fact frozen at arrival, not a time boundary — which turned out
 * to be structurally the wrong tool (Codex #5019 r20/r21): any floor tied
 * to "when did the gate go live" or "when did this process boot" cannot
 * tell "the gate was off" apart from "the process merely restarted" — one
 * must never be swept (it was dark) and the other must always still be
 * swept (an ordinary restart must not drop a callback whose extraction or
 * delivery hadn't finished yet), and no single instant can satisfy both at
 * once. The stamp sidesteps the whole question: a call from a dark period
 * is simply never stamped, so it can never ring however the gate toggles
 * afterward; a call from before a restart keeps whatever stamp it already
 * had, so an ordinary restart loses nothing. KNOWN LIMITATION: a call_log
 * row created by a recovery path (the /call-status or /recording-status
 * fallback insert, when /voice itself never landed for that call) is
 * never stamped and never rings — this fails closed, and is rare enough
 * to accept rather than build a second stamping site for.
 *
 * Idempotency rests on TWO durable facts, either one enough to skip a
 * redispatch, both checked BEFORE ever calling triggerNotification: a bell
 * row already exists for this exact promise+ET-day (the SAME check
 * missed-call-bell.js / repeat-caller-bell.js both use — a straight read
 * of the notifications table, never per-admin bell/push preferences), or a
 * promise_chaser_deliveries row exists for the same dedupeKey (a plain
 * fact table, not claim machinery: no ownership, no expiry, no retry
 * bookkeeping — see that migration's own docstring). The second exists
 * because a shop where every admin is push-only never gets a bell row at
 * all, and a matching push tag only silently replaces a notification still
 * showing — once staff dismiss or open it, the next tick's push shows
 * again with no durable trace anywhere (Codex #5019 r19/r20 P1). A partial
 * push is NOT retried: once either fact exists, that promise+day is done,
 * exactly like those two bells' own "a persisted bell proves delivery"
 * rule.
 *
 * Gated by GATE_PROMISE_CHASER_BELL (needs GATE_CALL_COMMITMENTS too — no
 * commitment rows exist without it). Gate off: no query at all, and so no
 * writes either. Bell only — no customer comms, ever.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { etDateString, formatETDate, formatETTime } = require('../utils/datetime-et');
const commitments = require('./call-commitments');
const { whereNotBlockedCall, PHONE_KEY_SQL } = require('../middleware/spam-block');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { isSentinelPhone } = require('./external-phone');
const { TERMINAL_STATUSES } = require('./missed-call-bell');
const { SLA_KINDS, followedUpIds, WHAT } = require('./followup-sla-watcher');

// The rule's own scope: "an earlier call ... ended UNBOOKED". Same live
// statuses repeat-caller-bell's BOOKED_SQL treats as booked — a call that
// resulted in an appointment is not the audit's unbooked-call pattern, even
// if a genuinely separate promise on it is still open.
// 'rescheduled' is a live booked visit that was moved (pre-push P1): the call
// still ended booked. repeat-caller-bell's BOOKED_SQL omits it too; that's
// a separate follow-up so this PR doesn't change a live bell.
const BOOKED_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site', 'completed'];

// How far back each tick looks for a fresh inbound call to re-check —
// generous enough that even a slow commitments-extraction pass (bounded by
// MODEL_TIMEOUT_MS) gets several retries inside the window on the existing
// 2-minute cadence, short enough that a genuinely late-arriving promise
// simply ages out unrung rather than surprise-ringing an hour later. This
// is now the ONLY window boundary: eligibility itself (was a call stamped
// promise_chaser_eligible at arrival?) is what keeps a dark-period call
// from ringing, not how far back the sweep looks — see the module
// docstring (Codex #5019 r20/r21).
const LOOKBACK_MS = 30 * 60 * 1000;

// A generous ceiling on how long a genuine call can run — wide enough that
// no real call is ever excluded by the coarse pre-filter below (Codex
// #5019 r9 P2). Not itself a window: the precise, end-based condition is
// what actually decides eligibility.
const MAX_CALL_DURATION_MS = 4 * 60 * 60 * 1000;


// What we promised, and when — the two facts the alert body must carry.
// A HUMAN-typed commitment (source 'human') wasn't necessarily made ON the
// linked call at all — a staff member can log one after the fact, backed
// by any earlier call as its anchor — so its own created_at is the actual
// moment the promise was made (Codex #5019 r8 P2: the SAME boundary
// findPromiseToRing's own precedence check already treats as that
// commitment's origin). An AI-extracted row (the default) keeps the
// originating call's own time — that IS when the promise was spoken.
function describePromise(row) {
  const what = WHAT[row.kind] || 'follow-up';
  // findPromiseToRing's effective obligation time wins when present: it is
  // the later of the source time and a renewal (codex r9 P2), so a reopened
  // promise reads as promised when it was renewed.
  const source = Number.isFinite(row.__obligationAtMs) ? row.__obligationAtMs
    : (row.source === 'human' ? row.created_at : row.call_started_at);
  const at = source != null ? new Date(source) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `${formatETDate(at)} ${formatETTime(at)}` : 'an earlier call';
  return { what, when };
}

// Which open Waves promise (if any) this call should ring for — or null,
// which is NEVER a terminal fact here (no promise-chaser-owned state is
// ever recorded either way — refreshFulfillment's own shared stale-hint
// stamp below is the SLA pager's own established side effect, not a new
// claim/tracking write of this file's own): a promise whose own commitments
// extraction hasn't landed yet, or whose fulfillment proof couldn't be
// verified this instant, reads exactly the same as "genuinely nothing
// open" — either way, the next tick (still inside the sweep's own window)
// just re-runs this same read from scratch.
// findPromiseToRing's result when it could not verify the answer (a lookup
// threw or a refresh was unverified): never a ring, and never read as
// "nothing is owed" either — only a verified null retires a stale bell.
const FIND_FAILED = Symbol('find_failed');

async function findPromiseToRing(call, now) {
  // Every open Waves promise (callback / quote / time to come out) made on
  // an EARLIER call for this same contact number — direction-agnostic
  // (scopeCommitmentRows' own `phone` scope: the dialed number on an
  // outbound call, the caller ID on an inbound one), so a promise Waves
  // made calling the lead counts exactly like one made on an inbound call.
  // Never this call's own row, which the recording pipeline has not even
  // extracted yet. A promise whose own call belongs to a customer counts
  // only when THIS call is linked to that same customer, in both directions
  // (pre-push P1: the old one-way guard let an unlinked caller on a shared
  // or reassigned number surface another customer's promise). A promise on
  // an unlinked (lead) call stays eligible for any caller on the number.
  // An existing customer's callback isn't lost: the recording pipeline
  // links the call within minutes, and a later tick inside the 30-minute
  // window re-reads the link and rings then.
  const rows = (await commitments.listOpenCommitments(db, {
    // kinds pushes the SLA_KINDS filter into the QUERY itself (Codex #5019
    // r10 P2): filtering client-side AFTER a LIMIT 200 page let a shared
    // or long-lived number's unrelated commitments (customer-party rows,
    // other kinds) crowd the one relevant promise out of every tick's page
    // entirely — it was never wrong, just never reached.
    party: 'waves', kinds: SLA_KINDS, phone: call.from_phone, limit: 200, includeHints: true, now,
  })).filter((r) => String(r.call_log_id) !== String(call.id)
    // Strictly PRECEDES this callback — never the current call's own row
    // (excluded above), and never a call that arrived AFTER it either. A
    // later tick can land well after this callback, by which time a NEWER
    // call on the same number may have its own open promise; without this,
    // that later promise would wrongly read as "the reason this earlier
    // caller is chasing us".
    && new Date(r.call_started_at).getTime() < new Date(call.created_at).getTime()
    && (!r.customer_id || String(r.customer_id) === String(call.customer_id || '')));
  if (!rows.length) return null;

  // Scope to calls that ended UNBOOKED (the rule's own trigger) — a call
  // that resulted in an appointment is excluded even when a genuinely
  // separate promise on it is still open, same as repeat-caller-bell's own
  // booked-window exclusion.
  const candidateCallIds = [...new Set(rows.map((r) => r.call_log_id))];
  const bookedCallIds = new Set((await db('scheduled_services')
    .whereIn('source_call_log_id', candidateCallIds)
    .whereIn('status', BOOKED_STATUSES)
    .pluck('source_call_log_id')).map(String));
  const unbooked = rows.filter((r) => !bookedCallIds.has(String(r.call_log_id)));
  if (!unbooked.length) return null;

  // Refresh the fulfillment proof for the candidate calls first — nothing
  // stamps it until someone opens the queue (the SLA pager's own rule). A
  // call whose proof could not be verified (thrown, or refreshFulfillment's
  // own per-commitment `failed` count) is excluded below — an unverified
  // lookup proves nothing, and ringing on it risks a false alert for a
  // promise that was actually just kept.
  const callIds = [...new Set(unbooked.map((r) => r.call_log_id))];
  const unverified = new Set();
  // A null below is "nothing owed" only when every candidate was verified;
  // with a row excluded as unverified it may still be owed.
  const nothingOwed = () => (unverified.size ? FIND_FAILED : null);
  for (const id of callIds) {
    const result = await commitments.refreshFulfillment(db, id).catch((err) => {
      logger.warn(`[promise-chaser-bell] fulfillment refresh failed for call ${id}: ${err.message}`);
      return { failed: 1 };
    });
    if (result.failed > 0) unverified.add(id);
  }
  const live = await commitments.stillOpenIds(db, unbooked.map((r) => r.id), { now });
  let open = unbooked.filter((r) => live.has(r.id) && !unverified.has(r.call_log_id));
  if (!open.length) return nothingOwed();

  // followedUpIds needs each row's call-ended time (promisedAt's basis) —
  // the same merge the SLA pager itself does before calling it.
  const calls = callIds.length
    ? await db('call_log').whereIn('id', callIds).select('id', 'created_at', 'duration_seconds', 'bridged_at', 'direction')
    : [];
  const endedById = new Map(calls.map((c) => [c.id, commitments.callEndedAt(c)]));
  open = open.map((r) => ({ ...r, call_ended_at: endedById.get(r.call_log_id) || null }));

  // Booked since, called back and reached, or texted by staff since the
  // promise — the SLA pager's own "kept" evidence (renewal-aware: a
  // reopened callback's own evidence boundary moves forward), reused
  // rather than reimplemented. A lookup failure reads the same as "nothing
  // open" — never a false ring, and the next tick tries again.
  // Each row's renewal time, loaded once and shared by followedUpIds and
  // the attribution check below (Codex #5019 r18 P2: both used to query it
  // serially per row). A lookup failure holds the whole callback, exactly
  // as a thrown followedUpIds already did — never a ring on unverified
  // renewal state.
  // A legacy promise whose renewal cannot be known (renewalBoundaryUnknown)
  // never rings: its pre-renewal evidence and callbacks cannot be told apart
  // from the current obligation's.
  const renewedById = new Map();
  const unknown = new Set();
  try {
    for (const r of open) {
      if (await commitments.renewalBoundaryUnknown(db, r)) unknown.add(r.id);
      else renewedById.set(String(r.id), await commitments.obligationRenewedAt(db, r));
    }
  } catch (err) {
    logger.warn(`[promise-chaser-bell] renewal lookup failed: ${err.message}`);
    return FIND_FAILED;
  }
  open = open.filter((r) => !unknown.has(r.id));
  if (!open.length) return nothingOwed();
  const renewedFloors = new Map([...renewedById].filter(([, at]) => at));
  const followed = await followedUpIds(db, open, { renewed: renewedFloors }).catch((err) => {
    logger.warn(`[promise-chaser-bell] follow-up lookup failed: ${err.message}`);
    return null;
  });
  if (followed === null) return FIND_FAILED;
  open = open.filter((r) => !followed.has(r.id));
  if (!open.length) return nothingOwed();

  // A callback that arrived BEFORE a promise's own renewal (staff reopened
  // or restated it) cannot be "about" that renewal — it happened before
  // the renewal even existed. Without this, a call still sitting inside
  // the sweep window when staff later reopen the SAME promise would get
  // re-attributed to the NEW obligation and ring a second time for a call
  // that already had its alert, purely because the dedupeKey versions on
  // the renewal instant. Read from renewedById (once per candidate, reused by
  // ringForCall for that same dedupeKey) rather than only after picking
  // the winner, since the winner itself may be the one this excludes (a
  // renewal lookup failure already held the whole callback, above).
  const withRenewal = [];
  for (const r of open) {
    const renewedAt = renewedById.get(String(r.id)) || null;
    // The commitment's own creation — or renewal, whichever is LATER —
    // must precede THIS callback (Codex #5019 r5 P2, then r6 P1): a
    // HUMAN-typed commitment (source 'human', e.g. a send_estimate or
    // schedule_visit promise added to an OLDER call AFTER the fact)
    // cannot possibly be "about" a callback that happened before it
    // existed, exactly like a renewed callback cannot be about a callback
    // that preceded the renewal — for that source, created_at IS the
    // moment the promise came into being.
    //
    // An AI-EXTRACTED commitment (source 'ai', the default) is different:
    // its created_at is when the extraction pipeline's row landed, which
    // can be well AFTER the call itself — extraction is async, and a slow
    // pass finishing after a genuinely later callback already arrived
    // must NOT permanently exclude the promise it correctly found (Codex
    // r6 P1: the delayed-extraction test above only passed because its
    // fixture backdates created_at 4 hours, masking this). The promise's
    // own boundary there is the ORIGINATING call's time (call_started_at
    // — already enforced to precede this callback above, at the very top
    // of this function), so this check is a deliberate no-op for AI rows:
    // only a human row's own later created_at can ever move the boundary
    // past what that earlier check already guaranteed.
    // An unreadable created_at excludes the row (never a false ring on
    // unverifiable creation time).
    const createdBoundaryMs = r.source === 'human'
      ? new Date(r.created_at).getTime()
      : new Date(r.call_started_at).getTime();
    if (!Number.isFinite(createdBoundaryMs)) continue;
    const boundaryMs = renewedAt && renewedAt.getTime() > createdBoundaryMs ? renewedAt.getTime() : createdBoundaryMs;
    if (boundaryMs >= call.created_at.getTime()) continue;
    withRenewal.push({ ...r, __renewedAt: renewedAt, __obligationAtMs: boundaryMs });
  }
  if (!withRenewal.length) return nothingOwed();

  // The promise the caller has waited longest for — by its own EFFECTIVE
  // obligation time (Codex #5019 r9 P2: the SAME boundaryMs just computed
  // per candidate above — a human commitment's own created_at, a renewal
  // instant, or otherwise the originating call's time), never
  // call_started_at alone. A human-typed commitment logged well after its
  // linked (possibly much older) call is only "owed" from when it was
  // actually made, and a renewed callback is only "owed" from the renewal
  // — sorting on the call's own timestamp instead could describe the
  // WRONG promise as the one the caller has waited longest for.
  withRenewal.sort((a, b) => a.__obligationAtMs - b.__obligationAtMs);
  const promise = withRenewal[0];
  return { promise, renewedAt: promise.__renewedAt, ...describePromise(promise) };
}

// Dispatches the alert for one eligible call, if any open Waves promise
// still applies and hasn't already rung today. This file owns no claim,
// lease, or tracking state of its own — the bell row itself (checked by
// dedupeKey before dispatch) is the only durable state IT produces.
async function ringForCall(call, now = new Date()) {
  const found = await findPromiseToRing(call, now);
  if (found === FIND_FAILED) return false;
  if (!found) {
    // Verified: nothing is owed on this callback any more. Retire any bell
    // it still has showing — including one whose post-dispatch retirement
    // failed on an earlier tick (Codex #5019 r20 P2); every tick inside the
    // sweep window retries it.
    await require('./notification-service').supersedeMissedCallAdmin({ callLogId: call.id, triggerKey: 'promise_chaser' })
      .catch((err) => logger.warn(`[promise-chaser-bell] failed to retire a stale bell for call ${call.id}: ${err.message}`));
    return false;
  }
  const { promise, what, when, renewedAt } = found;

  // A callback staff RE-OPENED or edited after it last rang is a NEW
  // obligation, not the one the old bell already covered — versioning the
  // key on the renewal instant (0 when never renewed, computed by
  // findPromiseToRing above — which also excludes a callback that
  // preceded the renewal) lets it ring again for THAT obligation while
  // repeated calls chasing the SAME unrenewed one still collapse onto the
  // one bell.
  //
  // The ET day comes from the CALLBACK's own created_at, never the
  // sweep's own current tick time: a callback still sitting in the
  // 30-minute window is retried by more than one tick, and `now` moves
  // forward with every one of them — a call alerted right before midnight
  // would otherwise get a brand-new key (and a second ring for the exact
  // same call) the instant a later tick crosses into the next ET day. The
  // callback's own timestamp is fixed, so every tick that retries it
  // computes the identical key.
  const dedupeKey = `promise_chaser:${promise.id}:${renewedAt ? renewedAt.getTime() : 0}:${etDateString(new Date(call.created_at))}`;

  // A bell this callback already has for a DIFFERENT identity — another
  // promise that has since been kept, or an older version of this one — is
  // stale now that this promise is the one owed (Codex #5019 r21 P2).
  await db('notifications').where({ recipient_type: 'admin', category: 'missed_call' }).whereNull('read_at')
    .whereRaw("metadata->>'triggerKey' = 'promise_chaser'")
    .whereRaw("metadata->'payload'->>'callLogId' = ?", [String(call.id)])
    .whereRaw("metadata->>'dedupeKey' IS DISTINCT FROM ?", [dedupeKey])
    .update({ read_at: new Date(), ...require('./notification-service')._private.doneColumns({ by: 'promise-chaser', resolution: 'Replaced by a newer reminder for this call' }) })
    .catch((err) => logger.warn(`[promise-chaser-bell] failed to retire a superseded bell for call ${call.id}: ${err.message}`));

  // The canonical "already delivered" check missed-call-bell.js and
  // repeat-caller-bell.js both use before an atomic-claim reclaim — a
  // durable notifications row, never per-admin bell/push preferences: a
  // bell written with every admin push-disabled still counts as delivered.
  //
  // A shop where every admin is push-only never gets a bell row at all
  // (notifyAdmin only writes one for a bell-enabled recipient), so this
  // check alone had nothing to find there — a matching push tag only
  // silently replaces a notification still showing on the device; once
  // staff dismiss or open it, the next tick's push displays again (Codex
  // #5019 r19/r20 P1, confirmed against client/public/sw.js). The second
  // check (promise_chaser_deliveries — a plain fact, not a claim: no
  // ownership, no expiry, no retry bookkeeping, same idea as
  // sms_reply_alert_claims / missed_call_text_claims) covers exactly that
  // gap, alongside — never instead of — the notifications check.
  const alreadyRung = await db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first('id');
  if (alreadyRung) return false;
  const alreadyDelivered = await db('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
  if (alreadyDelivered) return false;

  const customer = call.customer_id
    ? await db('customers').where('id', call.customer_id).first('first_name', 'last_name')
    : null;

  // Re-checked immediately before dispatch: staff may dismiss, fulfill, or
  // close the commitment — or a manual text, a qualifying outbound call, or
  // a booking may land — in the gap between findPromiseToRing's own
  // snapshot and here. Re-runs the SAME two kept-evidence predicates
  // findPromiseToRing already used, so this bell and the SLA pager can
  // never disagree on what counts as kept. Fails CLOSED on a lookup error
  // (never throws) — an unverifiable recheck blocks the send outright; a
  // later tick, still inside the sweep's own window, simply re-evaluates
  // from scratch.
  // Set the instant this re-check itself blocks the send — whether because
  // the promise was genuinely superseded in the race window, or because a
  // lookup inside it threw (Codex #5019 r7 P1: notification-triggers.js's
  // own shouldContinue rejection surfaces as `stats.suppressed` — the SAME
  // flag deliberate preference/policy suppression uses — so without this,
  // a merely TRANSIENT failure here (a DB blip mid-refresh) got the same
  // permanent "settle the delivery fact, never retry" treatment as a real
  // opt-out, silencing an actually-still-open promise for the rest of the
  // ET day). Read below, right before deciding whether to settle.
  let stillEligibleBlocked = false;
  // Whether the MOST RECENT stillEligible() call POSITIVELY established
  // supersession — a successful check that genuinely found the promise
  // renewed past this callback, closed, or already followed up — never
  // merely "a lookup couldn't verify" (Codex #5019 r15 P1). Reset at the
  // START of every call so it reflects only that one invocation: a
  // transient DB failure (or an ambiguous missing row) fails closed for
  // shouldContinue/beforePush's own SEND decision the same as before, but
  // the SEPARATE post-dispatch retire decision below must never treat
  // "couldn't verify" as "confirmed superseded" — that would retire an
  // ALREADY-WRITTEN, genuinely valid bell, and the unconditional
  // alreadyRung check finds that SAME notifications row on every later
  // tick with no delivery fact to explain why nothing is ever retried,
  // permanently hiding a real alert behind one bad connection.
  let stillEligibleConfirmedSuperseded = false;
  const stillEligible = async () => {
    stillEligibleConfirmedSuperseded = false;
    const ok = await (async () => {
      try {
        // Every read below runs on the CRON-HELD connection, not a fresh
        // pool checkout (Codex #5019 r14 P1): shouldContinue/beforePush are
        // invoked from WITHIN notification-service.js's own open
        // notifyAdmin dedupe transaction (a second pool connection), while
        // runExclusive (scheduler.js) already pins a first for this whole
        // sweep — at DB_POOL_MAX=2 (a supported production floor, see
        // cron-lock.js's own docstring and every other site that guards
        // against this exact shape), a THIRD checkout for these queries
        // would simply never arrive: both existing connections are held by
        // callers waiting on THIS code to finish. getHeldConnection()
        // (cron-lock.js's own established reuse mechanism — the same one
        // appointment-reminders.js already uses for the identical reason)
        // returns undefined outside a runExclusive context (tests, or any
        // future non-cron caller), where knex's own `{ connection }` option
        // simply falls back to a normal pool checkout — this is safe
        // either way. A single transaction for every read here is harmless
        // (all SELECTs, no writes) and never nests: this whole function
        // runs to completion before it, or a sibling call, opens another.
        const { getHeldConnection } = require('../utils/cron-lock');
        return await db.transaction(async (trx) => {
          // Re-run the SAME fulfillment refresh findPromiseToRing's own
          // snapshot did — direct fulfillment (an estimate actually sent, a
          // visit actually booked) can land in the gap between that snapshot
          // and here just as easily as the kept-evidence checks below can
          // change; without this, an estimate sent in the race window still
          // rang "still owe them a quote" (Codex #5019 r16 P2). An unverified
          // refresh (thrown, or its own per-commitment `failed` count) blocks
          // the send the same way findPromiseToRing already treats it.
          const refreshed = await commitments.refreshFulfillment(trx, promise.call_log_id);
          if (refreshed.failed > 0) return false;
          // Reload the commitment row FRESH by id before the renewal recheck
          // (Codex #5019 r10 P2): `promise` is findPromiseToRing's own
          // SELECTION SNAPSHOT, taken before this gap — for an AI callback
          // staff edit or reopen in that gap, the snapshot's own human_state
          // is still null, and obligationRenewedAt short-circuits on exactly
          // that field (`if (!['confirmed','edited'].includes(human_state))
          // return null`) without ever reading the new renewal audit event.
          // A plain call_commitments read by id carries every mutable staff-
          // edit field (human_state, status, reviewed_at, snoozed_until,
          // fulfillment) fresh; merged ONTO the snapshot rather than
          // replacing it, since call_commitments itself has no call_started_at
          // / call_ended_at / customer_id / phone columns — those still come
          // from findPromiseToRing's own join and never change for this call.
          // A missing row (deleted) or a read failure blocks the same way an
          // unverified fulfillment refresh does — never a false ring on
          // unverifiable state; the next tick simply re-evaluates from scratch.
          const freshRow = await trx('call_commitments').where({ id: promise.id }).first();
          if (!freshRow) return false;
          const current = { ...promise, ...freshRow };
          // Re-check renewal precedence too (Codex #5019 r9 P2, then r10 P2
          // for the fresh read above): staff can reopen/restate the SAME
          // promise in the gap between findPromiseToRing's own snapshot and
          // here, exactly like they can fulfill or dismiss it —
          // findPromiseToRing's own precedence rule (a callback cannot be
          // "about" a renewal that postdates it) must hold at dispatch time
          // too, not just at selection time, or a renewal landing in this
          // exact gap would let a stale obligation ring anyway.
          const renewedNow = await commitments.obligationRenewedAt(trx, current);
          if (renewedNow && renewedNow.getTime() >= call.created_at.getTime()) {
            stillEligibleConfirmedSuperseded = true;
            return false;
          }
          const stillLive = await commitments.stillOpenIds(trx, [current.id], { now: new Date() });
          if (!stillLive.has(current.id)) {
            stillEligibleConfirmedSuperseded = true;
            return false;
          }
          const followedNow = await followedUpIds(trx, [current]);
          if (followedNow.has(current.id)) {
            stillEligibleConfirmedSuperseded = true;
            return false;
          }
          return true;
        }, { connection: getHeldConnection() });
      } catch {
        return false;
      }
    })();
    if (!ok) stillEligibleBlocked = true;
    return ok;
  };

  const { triggerNotification } = require('./notification-triggers');
  const stats = await triggerNotification('promise_chaser', {
    customerId: call.customer_id || null,
    name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || null,
    phone: call.from_phone,
    callLogId: call.id,
    commitmentId: promise.id,
    what,
    when,
    calledAtLabel: formatETTime(new Date(call.created_at)),
  }, { dedupeKey, shouldContinue: stillEligible, beforePush: stillEligible });

  // Genuine delivery (a bell row, or a push that actually sent) OR
  // DELIBERATE suppression (every admin has both channels off, the bell
  // policy silences the category, or an internal test customer — the
  // `suppressed` / `policySilenced` results) both settle this key, the
  // same posture missed-call-bell.js / repeat-caller-bell.js already use
  // (Codex #5019 r5 P2): a shop that has genuinely chosen not to be told
  // is not a delivery failure to retry forever. triggerNotification never
  // throws, so a swallowed insert failure or a failed preferences lookup
  // (retryable, not suppressed) simply reads as neither here; the next
  // tick tries again.
  //
  // EXCEPT when stillEligible itself is what blocked the send
  // (`stillEligibleBlocked`, Codex #5019 r7 P1): unlike missed-call-bell.js
  // / repeat-caller-bell.js, this bell wires stillEligible into BOTH
  // shouldContinue (the bell write) and beforePush (the push) — and
  // notification-triggers.js's own shouldContinue rejection surfaces as
  // the SAME `stats.suppressed` flag deliberate preference suppression
  // uses. stillEligible fails closed on ANY thrown lookup error, so a
  // merely transient failure there must never get the permanent
  // "settle, never retry" treatment a genuine opt-out earns — it reads as
  // neither delivered nor suppressed here, exactly like it did before
  // suppression settling existed, and the next tick re-evaluates from
  // scratch. A genuinely superseded promise (fulfilled in the race
  // window) is harmless to leave unsettled too: the next tick's own
  // findPromiseToRing already excludes it once it is truly gone.
  const delivered = Boolean(stats && (stats.bellWritten || Number(stats.push?.sent || 0) > 0
    || (!stillEligibleBlocked && (stats.suppressed || stats.policySilenced))));
  // Retire a bell the FINAL check rejected — mirrors repeat-caller-bell.js's
  // own post-dispatch cleanup exactly (Codex #5019 r11 P2, then r15 P1):
  // shouldContinue (the bell write) and beforePush (the push, a moment
  // later) both run stillEligible, but nothing re-checks it again after
  // both finish. If the promise was fulfilled in that exact gap — allowed
  // through at the bell write, rejected by the time beforePush ran — the
  // bell notification row already exists and stays visible forever
  // (nothing ever marks it read), and delivered above still reads true, so
  // the delivery fact still gets written. One more independent
  // stillEligible() call, exactly like repeat-caller-bell's own
  // `if (stats?.bellWritten && !await stillEligible())`, catches this —
  // retiring the now-stale bell through the SAME shared notification-
  // service helper that bell already uses (never touched here before).
  // Gated on stillEligibleConfirmedSuperseded too (r15 P1): stillEligible
  // also returns false on a merely UNVERIFIABLE recheck (a transient DB
  // blip, an ambiguous missing row) — treating that as "confirmed
  // superseded" would retire an ALREADY-WRITTEN, genuinely valid bell on
  // nothing more than a bad connection, and the unconditional alreadyRung
  // check then finds that SAME row on every later tick with no delivery
  // fact to explain why nothing is ever retried — permanently hiding a
  // real alert. Only a POSITIVE verdict (genuinely renewed, closed, or
  // already followed up) retires it; an unverifiable recheck leaves the
  // valid bell exactly as it is, and the fact still settles below.
  const recheckStillWanted = await stillEligible();
  const bellSuperseded = Boolean(stats?.bellWritten) && !recheckStillWanted && stillEligibleConfirmedSuperseded;
  if (bellSuperseded) {
    await require('./notification-service').supersedeMissedCallAdmin({ callLogId: call.id, triggerKey: 'promise_chaser' })
      .catch((err) => logger.warn(`[promise-chaser-bell] failed to retire a superseded bell for ${dedupeKey}: ${err.message}`));
  }
  if (delivered && !bellSuperseded) {
    // Recorded AFTER dispatch, never before: the sweep is already
    // serialized (runExclusive, scheduler.js), so there is no concurrent
    // attempt to claim against — this is a fact about what just happened,
    // not a lock taken before it. ON CONFLICT DO NOTHING since a bell
    // write can ALSO satisfy the (unconditional) notifications check next
    // time, making this row redundant but never wrong. A write failure
    // here is logged and swallowed: the event already delivered, and a
    // retried send next tick (same dedupeKey, so still a single bell rewrite
    // or a same-tag push) is an acceptable cost against silently losing the
    // "already delivered" fact.
    await db('promise_chaser_deliveries').insert({ dedupe_key: dedupeKey }).onConflict('dedupe_key').ignore()
      .catch((err) => logger.warn(`[promise-chaser-bell] delivery-fact insert failed for ${dedupeKey}: ${err.message}`));
  }
  return delivered;
}

/**
 * The ONE path: called from the existing 2-minute call-alert recovery tick
 * (scheduler.js — the same one missed-call-bell / repeat-caller-bell use).
 * Stateless and idempotent — see the file docstring. Excludes blocked
 * numbers, sandbox calls, and unusable caller IDs (mirroring the other two
 * bells' own basic eligibility), and a call whose pre-connect screen is
 * still outstanding ('gated' — the caller has not proven human yet) or
 * failed it ('failed' — fell to voicemail, never reached staff): a caller
 * who never passes never rings, and one who passes rings on a later tick,
 * once the webhook's own 'passed' stamp lands — no special handling needed
 * for that resolution here, since every tick just re-reads the stamp fresh.
 *
 * Pages the WHOLE sweep window with a created_at/id cursor, the same shape
 * missed-call-bell.js's own sweepMissedCalls uses — a single `.limit()`
 * batch (Codex #5019 r16 P2) let ineligible rows anywhere in the window
 * (a batch of blocked numbers, say) crowd out a genuinely actionable one
 * further along; paging to a SHORT page (fewer rows than pageSize) instead
 * of a fixed cap means the whole window is always covered in one tick.
 */
// How long a promise_chaser_deliveries row is kept — dedupeKey already
// carries the ET day (and, when renewed, the renewal instant) as part of
// its own identity, so a row this old can never match a live key again;
// bounded housekeeping, same posture as every other gate-off-skips-it
// query in this file.
const DELIVERY_FACT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

async function sweepPromiseChasers({ pageSize = 200 } = {}) {
  if (!isEnabled('promiseChaserBell') || !isEnabled('callCommitments')) return 0;
  const now = new Date();
  await db('promise_chaser_deliveries').where('delivered_at', '<', new Date(now.getTime() - DELIVERY_FACT_RETENTION_MS)).del()
    .catch((err) => logger.warn(`[promise-chaser-bell] delivery-fact housekeeping failed: ${err.message}`));
  const since = new Date(now.getTime() - LOOKBACK_MS);
  // Lazy, not top-level (Codex #5019 r11 P2): call-recording-processor.js is
  // a large module with its own heavy dependency graph; every other
  // cross-file reuse in this sweep (notification-triggers.js, below) is
  // lazy for the same reason. Cached by Node after the first tick either way.
  const settledStatuses = [...require('./call-recording-processor').COMPLETED_STATUSES];
  const { CALL_EXTRACTION_MAX_ATTEMPTS } = require('../config/call-extraction-retry');
  let rang = 0;
  let cursor = null;
  for (;;) {
    const calls = await db('call_log')
      .where({ direction: 'inbound' })
      .modify(whereNotBlockedCall)
      .modify((q) => whereNotSandboxCall(q))
      .whereRaw(`LENGTH(${PHONE_KEY_SQL}) BETWEEN 10 AND 15`)
      // TERMINAL ONLY (Codex #5019 r8 P2, reused from missed-call-bell.js —
      // the same set repeat-caller-bell.js also imports from there): /voice
      // stamps promise_chaser_eligible the instant the call arrives, well
      // before it ends, so a still-ringing or in-progress callback would
      // otherwise be swept in and get the past-tense "we still owe them a
      // <what>" alert BEFORE the conversation itself has a chance to keep
      // the promise. The 30-minute window is unchanged — this is an
      // additional filter, not a replacement for it.
      .whereIn('status', TERMINAL_STATUSES)
      // The window is on when the call ENDED, not when it started (Codex
      // #5019 r9 P2): paired with the terminal-status filter above, a call
      // that ran close to (or beyond) the 30-minute lookback itself would
      // otherwise cross the created_at cutoff and never be evaluated at
      // all, even though it just ended. `created_at` alone stays as a
      // COARSE, index-friendly pre-filter with a generous extra margin for
      // the longest a real call could plausibly run — it never itself
      // excludes a genuine call, only keeps this query sargable; the
      // precise end-based condition right below it is what actually
      // decides eligibility. End time mirrors call-commitments.js's own
      // callEndedAt (bridged_at + duration when bridged, else created_at +
      // duration) — simplified to COALESCE(bridged_at, created_at) since
      // this query is already direction:'inbound'-only, so callEndedAt's
      // own non-inbound branch (created_at, no duration added) never
      // applies here.
      .where('created_at', '>', new Date(since.getTime() - MAX_CALL_DURATION_MS))
      .whereRaw("COALESCE(bridged_at, created_at) + make_interval(secs => COALESCE(duration_seconds, 0)) > ?", [since])
      // SETTLED processing only (Codex #5019 r11 P2): a terminal Twilio
      // status (above) says the CALL ended, not that call-recording-
      // processor has finished with it — the pipeline may still create the
      // booking or send the estimate that keeps this exact promise. Settled
      // means EITHER processing_status is already one of the processor's
      // own COMPLETED_STATUSES (reused, not re-derived — processed /
      // voicemail / spam; the retry states extraction_failed/no_transcription
      // are deliberately NOT here, matching the processor's own posture:
      // they are unfinished work, not done), OR its extraction retries are
      // exhausted, so the processor will not pick it up again. No elapsed-
      // time valve (Codex #5019 r20 P2): every other unfinished state can
      // still be retried and keep the promise, so it never rings.
      .whereRaw(`(processing_status IN (${settledStatuses.map(() => '?').join(', ')})
        OR (processing_status = 'extraction_failed' AND COALESCE(extraction_attempts, 0) >= ?))`,
        [...settledStatuses, CALL_EXTRACTION_MAX_ATTEMPTS])
      // Eligibility, not the window, is what keeps a dark-period call from
      // ringing (see module docstring) — a call the /voice webhook did not
      // stamp promise_chaser_eligible: true at arrival is never considered,
      // however the gate toggles afterward or however recently it arrived.
      // A call the pipeline classified as spam is terminal but is no lead
      // calling back — a spoofed caller ID on a number with an open promise
      // must not ring (Codex #5019 r18 P2).
      .whereRaw("COALESCE(processing_status, '') <> 'spam'")
      .whereRaw("metadata->>'promise_chaser_eligible' = 'true'")
      .whereRaw("COALESCE(metadata->>'preconnect_screen', '') NOT IN ('gated', 'failed')")
      .modify((q) => { if (cursor) q.whereRaw('(created_at, id) > (?, ?)', [cursor.sweep_created_at, cursor.id]); })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(pageSize)
      // A text cursor preserves PostgreSQL microseconds across tied dates
      // (missed-call-bell.js's own sweepMissedCalls does the same).
      .select('*', db.raw('created_at::text AS sweep_created_at'));
    for (const call of calls) {
      // Twilio's own withheld-caller-ID sentinels (Codex #5019 r5 P2 —
      // the same exclusion missed-call-bell.js / repeat-caller-bell.js
      // both apply via this shared helper, reused rather than
      // re-listed): these numeric placeholders stand for many unrelated
      // callers, so a promise "open" against one is never really about
      // whoever is calling in on it now.
      if (isSentinelPhone(call.from_phone)) continue;
      const delivered = await ringForCall(call, now).catch((err) => {
        logger.warn(`[promise-chaser-bell] failed for call ${String(call.twilio_call_sid).slice(-6)}: ${err.message}`);
        return false;
      });
      if (delivered) rang += 1;
    }
    if (calls.length < pageSize) break;
    cursor = calls[calls.length - 1];
  }
  return rang;
}

module.exports = {
  sweepPromiseChasers, ringForCall,
  describePromise,
};
