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
 * STATELESS, IDEMPOTENT SWEEP — the ONE path (no /voice wiring, no per-call
 * claim, no lease, and no promise-chaser-owned state of its own ever
 * written to call_log or call_commitments — refreshFulfillment's own
 * shared stale-hint stamp on call_commitments, the SAME side effect the
 * SLA pager's own read already triggers, is the one pre-existing write
 * this file's own reads happen to cause, not a new one):
 * the existing 2-minute call-alert recovery cron (scheduler.js — the same
 * one missed-call-bell / repeat-caller-bell use) calls sweepPromiseChasers,
 * which re-evaluates every eligible inbound call from the last 30 minutes
 * (never earlier than the persisted activation boundary — see below) from
 * scratch, every tick.
 * "Nothing qualifies this tick" is never a terminal fact; a promise whose
 * own extraction lands on a LATER tick is simply found then, by a fresh
 * read of call_commitments — this is what replaced the old design's own
 * claim/lease/retry state machine (and, with it, its own P1 history:
 * wholesale-vs-merge writes, sweep-batch starvation from stuck leases,
 * cross-call double-ring races, delivered-device history scoped to the
 * wrong promise or the wrong day, and a defer/release livelock between two
 * staggered callers). None of that machinery exists to have those bugs.
 *
 * Idempotency instead rests on ONE fact: a bell row already exists for this
 * exact promise+ET-day. That is the SAME durable "already delivered" check
 * missed-call-bell.js / repeat-caller-bell.js both use — a straight read of
 * the notifications table, never per-admin bell/push preferences — checked
 * BEFORE ever calling triggerNotification, so a tick that finds one simply
 * returns without touching the dispatch pipeline at all. A partial push is
 * NOT retried: once the bell row exists, that promise+day is done, exactly
 * like those two bells' own "a persisted bell proves delivery" rule.
 *
 * The sweep window's floor is a PERSISTED first-activation boundary
 * (activationBoundary / persistedActivationBoundary below), exactly
 * #5018's own (call-booking-link-text.js) pattern: env override
 * PROMISE_CHASER_ACTIVATED_AT, else the instant in system_settings key
 * promise_chaser_activated_at — written ONCE, ever, by the first process
 * that ever finds nothing stored there, and read back unchanged by every
 * process and every restart after. An in-memory MODULE_LOAD_AT (Codex
 * #5019 r16 P1) moves on every ordinary restart or deploy, not just a gate
 * flip, so a callback taken moments before a routine restart — its own
 * extraction or delivery still in flight — was excluded forever the
 * instant the new process booted. The persisted boundary never does that:
 * it fixes ONE origin instant for the feature's whole life, and the
 * 30-minute lookback is what actually bounds every tick after that,
 * regardless of how many restarts have happened since.
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
const { SLA_KINDS, followedUpIds, WHAT } = require('./followup-sla-watcher');

// This module's OWN load time — captured once, at require, which happens at
// process boot (scheduler.js requires this lane eagerly, unconditionally).
// Used ONLY as the very first persisted boundary's fallback value, instead
// of a DB-time read taken at whatever moment the first sweep tick happens
// to run (the same reasoning call-booking-link-text.js's own MODULE_LOAD_AT
// documents) — never as the boundary itself; see persistedActivationBoundary.
const MODULE_LOAD_AT = new Date();

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
// simply ages out unrung rather than surprise-ringing an hour later.
const LOOKBACK_MS = 30 * 60 * 1000;

// Own key/env, since this is a different gate/lane from every other
// activation-boundary user (reschedule-link-promises.js,
// call-booking-link-text.js) — mirrors call-booking-link-text.js's own
// persistedActivationBoundary exactly (see that file, #5018,
// feat/call-booking-link-text, for the pattern this is copied from): the
// first live sweep anywhere to find nothing stored writes MODULE_LOAD_AT
// there; every sweep after, on this process or any future one, reads the
// same instant back. onConflict('key').ignore() means only the very FIRST
// process (of a rolling deploy) to find nothing stored ever writes; every
// other process, and every later restart, just reads the persisted value.
const ACTIVATION_SETTINGS_KEY = 'promise_chaser_activated_at';
async function persistedActivationBoundary(conn) {
  const existing = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  if (existing?.value) return new Date(existing.value);
  await conn('system_settings').insert({
    key: ACTIVATION_SETTINGS_KEY, value: MODULE_LOAD_AT.toISOString(), category: 'promise_chaser',
    description: 'First live-activation instant for GATE_PROMISE_CHASER_BELL; a call that started before it is historical, not a live callback to chase.',
  }).onConflict('key').ignore();
  const settled = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  return settled?.value ? new Date(settled.value) : MODULE_LOAD_AT;
}

// PROMISE_CHASER_ACTIVATED_AT (an ISO instant), when set, always wins —
// read fresh each call, exactly like reschedule-link-promises' own env
// override. Unset, falls back to the persisted boundary.
async function activationBoundary(conn) {
  const configured = process.env.PROMISE_CHASER_ACTIVATED_AT;
  const parsed = configured ? new Date(configured) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : persistedActivationBoundary(conn);
}

// The sweep's own lookback boundary: never earlier than LOOKBACK_MS ago,
// and never earlier than the activation boundary. Exported (and the pure
// half factored out as windowFloor) so tests can probe the boundary logic
// directly rather than racing real wall-clock time against an activation
// instant a test cannot itself control.
function windowFloor(boundary, now) {
  return new Date(Math.max(now.getTime() - LOOKBACK_MS, boundary.getTime()));
}
async function sweepSince(conn, now = new Date()) {
  return windowFloor(await activationBoundary(conn), now);
}

// A `.catch()` sentinel distinguishable from every genuine obligationRenewedAt
// result (null = never renewed, or a real Date) — never a value that value
// could itself equal.
const RENEWAL_LOOKUP_FAILED = Symbol('renewal_lookup_failed');

// What we promised, and when — the two facts the alert body must carry.
function describePromise(row) {
  const what = WHAT[row.kind] || 'follow-up';
  const at = row.call_started_at ? new Date(row.call_started_at) : null;
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
    party: 'waves', phone: call.from_phone, limit: 200, includeHints: true, now,
  })).filter((r) => SLA_KINDS.includes(r.kind) && String(r.call_log_id) !== String(call.id)
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
  for (const id of callIds) {
    const result = await commitments.refreshFulfillment(db, id).catch((err) => {
      logger.warn(`[promise-chaser-bell] fulfillment refresh failed for call ${id}: ${err.message}`);
      return { failed: 1 };
    });
    if (result.failed > 0) unverified.add(id);
  }
  const live = await commitments.stillOpenIds(db, unbooked.map((r) => r.id), { now });
  let open = unbooked.filter((r) => live.has(r.id) && !unverified.has(r.call_log_id));
  if (!open.length) return null;

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
  const followed = await followedUpIds(db, open).catch((err) => {
    logger.warn(`[promise-chaser-bell] follow-up lookup failed: ${err.message}`);
    return null;
  });
  if (followed === null) return null;
  open = open.filter((r) => !followed.has(r.id));
  if (!open.length) return null;

  // The promise the caller has waited longest for.
  open.sort((a, b) => new Date(a.call_started_at) - new Date(b.call_started_at));
  const promise = open[0];
  return { promise, ...describePromise(promise) };
}

// Dispatches the alert for one eligible call, if any open Waves promise
// still applies and hasn't already rung today. This file owns no claim,
// lease, or tracking state of its own — the bell row itself (checked by
// dedupeKey before dispatch) is the only durable state IT produces.
async function ringForCall(call, now = new Date()) {
  const found = await findPromiseToRing(call, now);
  if (!found) return false;
  const { promise, what, when } = found;

  // A callback staff RE-OPENED or edited after it last rang is a NEW
  // obligation, not the one the old bell already covered — versioning the
  // key on the renewal instant (0 when never renewed) lets it ring again
  // for THAT obligation while repeated calls chasing the SAME unrenewed one
  // still collapse onto the one bell. A lookup failure never rings — the
  // next tick, still inside the sweep's own window, tries again.
  const renewedAt = await commitments.obligationRenewedAt(db, promise).catch((err) => {
    logger.warn(`[promise-chaser-bell] renewal lookup failed for commitment ${promise.id}: ${err.message}`);
    return RENEWAL_LOOKUP_FAILED;
  });
  if (renewedAt === RENEWAL_LOOKUP_FAILED) return false;
  const dedupeKey = `promise_chaser:${promise.id}:${renewedAt ? renewedAt.getTime() : 0}:${etDateString(now)}`;

  // The canonical "already delivered" check missed-call-bell.js and
  // repeat-caller-bell.js both use before an atomic-claim reclaim — a
  // durable notifications row, never per-admin bell/push preferences: a
  // bell written with every admin push-disabled still counts as delivered.
  // A shop where every admin is push-only never gets a bell row at all
  // (notifyAdmin only writes one for a bell-enabled recipient) — that
  // narrow case relies on notification-triggers.js's own dedupeKey push tag
  // (kept, unchanged) to coalesce at the device instead, same as it always
  // has for this trigger.
  const alreadyRung = await db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first('id');
  if (alreadyRung) return false;

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
  const stillEligible = async () => {
    try {
      // Re-run the SAME fulfillment refresh findPromiseToRing's own
      // snapshot did — direct fulfillment (an estimate actually sent, a
      // visit actually booked) can land in the gap between that snapshot
      // and here just as easily as the kept-evidence checks below can
      // change; without this, an estimate sent in the race window still
      // rang "still owe them a quote" (Codex #5019 r16 P2). An unverified
      // refresh (thrown, or its own per-commitment `failed` count) blocks
      // the send the same way findPromiseToRing already treats it.
      const refreshed = await commitments.refreshFulfillment(db, promise.call_log_id);
      if (refreshed.failed > 0) return false;
      const stillLive = await commitments.stillOpenIds(db, [promise.id], { now: new Date() });
      if (!stillLive.has(promise.id)) return false;
      const followedNow = await followedUpIds(db, [promise]);
      return !followedNow.has(promise.id);
    } catch {
      return false;
    }
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

  // Genuine delivery only (a bell row, or a push that actually sent) —
  // triggerNotification never throws, so a swallowed insert failure or a
  // failed preferences lookup simply reads as "nothing delivered" here;
  // the next tick tries again.
  return Boolean(stats && (stats.bellWritten || Number(stats.push?.sent || 0) > 0));
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
async function sweepPromiseChasers({ pageSize = 200 } = {}) {
  if (!isEnabled('promiseChaserBell') || !isEnabled('callCommitments')) return 0;
  const now = new Date();
  const since = await sweepSince(db, now);
  let rang = 0;
  let cursor = null;
  for (;;) {
    const calls = await db('call_log')
      .where({ direction: 'inbound' })
      .modify(whereNotBlockedCall)
      .modify((q) => whereNotSandboxCall(q))
      .whereRaw(`LENGTH(${PHONE_KEY_SQL}) BETWEEN 10 AND 15`)
      .where('created_at', '>', since)
      .whereRaw("COALESCE(metadata->>'preconnect_screen', '') NOT IN ('gated', 'failed')")
      .modify((q) => { if (cursor) q.whereRaw('(created_at, id) > (?, ?)', [cursor.sweep_created_at, cursor.id]); })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(pageSize)
      // A text cursor preserves PostgreSQL microseconds across tied dates
      // (missed-call-bell.js's own sweepMissedCalls does the same).
      .select('*', db.raw('created_at::text AS sweep_created_at'));
    for (const call of calls) {
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
  sweepPromiseChasers, sweepSince, windowFloor, activationBoundary, persistedActivationBoundary,
  describePromise, MODULE_LOAD_AT,
};
