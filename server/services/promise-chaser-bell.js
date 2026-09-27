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
 * (never earlier than MODULE_LOAD_AT — see below) from scratch, every tick.
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
 * MODULE_LOAD_AT is captured the moment this file loads; scheduler.js
 * requires it eagerly at the top level (mirroring #5018's own boot-time
 * activation boundary) so that instant is effectively process-boot time.
 * Railway restarts the whole process on any env var change, including a
 * gate flip, so MODULE_LOAD_AT is always reset to "now" the instant the
 * gate goes live — no PERSISTED activation boundary (the way #5018's own,
 * system_settings-backed one works) is needed here: a flip never replays
 * whatever happened while the gate was dark, and the 30-minute lookback
 * bounds everything else regardless of how long the process has been up.
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

const MODULE_LOAD_AT = new Date();

// The rule's own scope: "an earlier call ... ended UNBOOKED". Same live
// statuses repeat-caller-bell's BOOKED_SQL treats as booked — a call that
// resulted in an appointment is not the audit's unbooked-call pattern, even
// if a genuinely separate promise on it is still open.
const BOOKED_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site', 'completed'];

// How far back each tick looks for a fresh inbound call to re-check —
// generous enough that even a slow commitments-extraction pass (bounded by
// MODEL_TIMEOUT_MS) gets several retries inside the window on the existing
// 2-minute cadence, short enough that a genuinely late-arriving promise
// simply ages out unrung rather than surprise-ringing an hour later.
const LOOKBACK_MS = 30 * 60 * 1000;

// The sweep's own lookback boundary: never earlier than LOOKBACK_MS ago,
// and never earlier than MODULE_LOAD_AT (see the file docstring for why
// that alone is enough — a gate flip restarts the whole process). Exported
// so tests can probe the boundary itself without racing real wall-clock
// time against a module-load instant they cannot control.
function sweepSince(now = new Date()) {
  return new Date(Math.max(now.getTime() - LOOKBACK_MS, MODULE_LOAD_AT.getTime()));
}

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
  // extracted yet. When the CURRENT caller is a known customer, a promise
  // whose own call belongs to a DIFFERENT customer (a shared or reassigned
  // number) is excluded — an unlinked call on the same number stays
  // eligible.
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
    && (!call.customer_id || !r.customer_id || String(r.customer_id) === String(call.customer_id)));
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

  const dedupeKey = `promise_chaser:${promise.id}:${etDateString(now)}`;

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
 */
async function sweepPromiseChasers({ limit = 200 } = {}) {
  if (!isEnabled('promiseChaserBell') || !isEnabled('callCommitments')) return 0;
  const now = new Date();
  const since = sweepSince(now);
  const calls = await db('call_log')
    .where({ direction: 'inbound' })
    .modify(whereNotBlockedCall)
    .modify((q) => whereNotSandboxCall(q))
    .whereRaw(`LENGTH(${PHONE_KEY_SQL}) BETWEEN 10 AND 15`)
    .where('created_at', '>', since)
    .whereRaw("COALESCE(metadata->>'preconnect_screen', '') NOT IN ('gated', 'failed')")
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('*');
  let rang = 0;
  for (const call of calls) {
    const delivered = await ringForCall(call, now).catch((err) => {
      logger.warn(`[promise-chaser-bell] failed for call ${String(call.twilio_call_sid).slice(-6)}: ${err.message}`);
      return false;
    });
    if (delivered) rang += 1;
  }
  return rang;
}

module.exports = { sweepPromiseChasers, sweepSince, describePromise, MODULE_LOAD_AT };
