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
 * a claim is written the moment an attempt actually starts (never while a
 * caller is still working through the pre-connect screen — see
 * markScreenFailed / the /voice wiring) and settled to a terminal outcome
 * once resolved. A transient failure (a thrown lookup, a notification
 * insert error) leaves the claim at 'pending' rather than settling it, so
 * the EXISTING call-alert recovery sweep (scheduler.js's every-2-minutes
 * tick, the same one missed-call-bell / repeat-caller-bell use) can retry it —
 * no new sweep. A stale 'pending' lease (LEASE_MS) is reclaimable, same
 * idiom as those two bells' own claim.
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
// reclaimable; 'rung' and 'skipped' are terminal and never reclaimed.
async function claimAttempt(callId) {
  const token = new Date().toISOString();
  const claimed = await db('call_log').where({ id: callId })
    .whereRaw("COALESCE(metadata->'promise_chaser'->>'status', '') NOT IN ('rung', 'skipped')")
    // Parenthesized as ONE fragment — knex ANDs separate whereRaw calls with
    // plain string concatenation, so an unparenthesized top-level OR here
    // would bind looser than the preceding ANDs and match ANY row with a
    // stale claimed_at, including unrelated and already-terminal calls
    // (repeat-caller-bell's own CLAIM_FREE_SQL wraps its OR the same way).
    .whereRaw("((metadata->'promise_chaser'->>'status' IS DISTINCT FROM 'pending') OR (metadata->'promise_chaser'->>'claimed_at')::timestamptz < ?)", [new Date(Date.now() - LEASE_MS)])
    .update({
      metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('promise_chaser', ?::jsonb)",
        [JSON.stringify({ status: 'pending', claimed_at: token })]),
    });
  return claimed ? token : null;
}

// Settle a claim to a terminal outcome, fenced on the token: a stale owner
// waking up late cannot overwrite what a newer attempt already decided.
// `commitmentId` (stamped on a 'rung' settle) is what alreadyRungToday
// checks — the cross-call "once per promise per day" decision, made here
// rather than through notifyAdmin's own dedupe, so a retry of THIS call's
// own failed push is never mistaken for a duplicate.
async function settle(callId, token, status, reason = null, commitmentId = null) {
  await db('call_log').where({ id: callId })
    .whereRaw("metadata->'promise_chaser'->>'claimed_at' = ?", [token])
    .update({
      metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('promise_chaser', ?::jsonb)",
        [JSON.stringify({ status, reason, commitmentId, claimed_at: token, at: new Date().toISOString() })]),
    });
}

// Has ANY call already rung for this exact promise today (ET)? The
// cross-call half of "once per promise per day" — a genuinely separate
// call on the same open promise must not re-buzz, but this call's OWN
// retry of its own not-yet-rung attempt must never be blocked by it (it
// checks OTHER calls' settled outcomes, never this one's still-pending
// claim). Bounded to 48h so it stays a bounded index scan, not a table scan.
async function alreadyRungToday(promiseId, now) {
  const rows = await db('call_log')
    .where('created_at', '>', new Date(now.getTime() - 48 * 60 * 60 * 1000))
    .whereRaw("metadata->'promise_chaser'->>'status' = 'rung'")
    .whereRaw("metadata->'promise_chaser'->>'commitmentId' = ?", [String(promiseId)])
    .select(db.raw("metadata->'promise_chaser'->>'at' as rung_at"));
  const today = etDateString(now);
  return rows.some((r) => r.rung_at && etDateString(new Date(r.rung_at)) === today);
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
  if (!rows.length) return { outcome: 'skip', reason: 'no_open_promise' };

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

    // Cross-call half of "once per promise per day": a genuinely SEPARATE
    // call for the same open promise, already rung today by another call,
    // must not re-buzz. This never blocks THIS call's own retry of its own
    // not-yet-rung attempt (it only sees OTHER calls' settled 'rung' rows).
    if (await alreadyRungToday(promise.id, now)) {
      await settle(call.id, token, 'skipped', 'already_rung_today', promise.id);
      return false;
    }

    const customer = call.customer_id
      ? await db('customers').where('id', call.customer_id).first('first_name', 'last_name')
      : null;

    // Re-checked immediately before both the bell write and the push: staff
    // may dismiss, fulfill, or close the commitment in the gap between the
    // stillOpenIds snapshot above and dispatch below.
    const stillEligible = async () => {
      const stillLive = await commitments.stillOpenIds(db, [promise.id], { now: new Date() });
      return stillLive.has(promise.id);
    };

    const { triggerNotification } = require('./notification-triggers');
    // Once per promise per ET day — a caller who rings twice in an
    // afternoon does not double the bell (notifyAdmin's own dedupe lock).
    const dedupeKey = `waves-promise_chaser-${promise.id}-${etDateString(now)}`;
    const stats = await triggerNotification('promise_chaser', {
      customerId: call.customer_id || null,
      name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || null,
      phone,
      callLogId: call.id,
      commitmentId: promise.id,
      what,
      when,
      // "Calling in now" is only true at the live call sites; a durable
      // retry lands after the call has already ended.
      liveCall: !viaSweep,
      calledAtLabel: call.created_at ? `${formatETDate(new Date(call.created_at))} ${formatETTime(new Date(call.created_at))}` : null,
    }, { dedupeKey, shouldContinue: stillEligible, beforePush: stillEligible });

    // triggerNotification never throws — a swallowed bell-insert failure, a
    // failed push, or a failed preferences lookup surfaces as stats.retryable
    // / stats.prefsUnavailable (often with no stats.error at all) rather than
    // a caught exception. Any of these leaves the claim pending; only a
    // definitive, non-retryable outcome may settle.
    if (stats?.error || stats?.retryable || stats?.prefsUnavailable) return false; // leave pending — retry
    // Genuine delivery only — a deliberate non-send (every admin opted out,
    // the bell policy silenced the category, or stillEligible just blocked
    // a promise that closed in the race window) is still a settled, non-
    // retryable outcome, but it never counts as "rang".
    const delivered = Boolean(stats && (stats.bellWritten || Number(stats.push?.sent || 0) > 0));
    const skipReason = stats?.suppressed ? 'suppressed' : (stats?.policySilenced ? 'policy_silenced' : 'not_delivered');
    await settle(call.id, token, delivered ? 'rung' : 'skipped', delivered ? null : skipReason, delivered ? promise.id : null);
    return delivered;
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
    // Never override an outcome another path already reached (e.g. a
    // duplicate Twilio postback replaying an already-settled call).
    if (promiseChaserState(call.metadata)) return false;
    await db('call_log').where({ id: call.id })
      .whereRaw("COALESCE(metadata->'promise_chaser'->>'status', '') = ''")
      .update({
        metadata: db.raw("COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('promise_chaser', ?::jsonb)",
          [JSON.stringify({ status: 'skipped', reason: 'screen_failed', at: new Date().toISOString() })]),
      });
    return true;
  } catch (err) {
    logger.warn(`[promise-chaser-bell] markScreenFailed failed for call ${String(callSid).slice(-6)}: ${err.message}`);
    return false;
  }
}

// A challenged caller who genuinely never gets a claim written (still mid-
// Gather) resolves within Twilio's own ~12s timeout; this grace floor is
// far past that, so a call this old with no claim at all is a failure to
// recover, never one still legitimately outstanding.
const UNCLAIMED_GRACE_MS = 5 * 60 * 1000;

/**
 * Durable retry (runs on the existing 2-minute call-alert recovery tick,
 * scheduler.js — the same one missed-call-bell / repeat-caller-bell use):
 * re-offer any inbound call whose claim is still 'pending' (a prior attempt
 * threw, or a notification insert/push failed) from the last 24h. Idempotent
 * — the atomic claim inside ringPromiseChaserIfNeeded makes a re-offer a
 * no-op once another attempt already owns or has settled the call.
 *
 * Also recovers a call that never acquired a claim AT ALL — the initial
 * call_log lookup or the claim UPDATE itself can fail, or the process can
 * exit right after logging the call, before any 'pending' row ever exists;
 * the webhook's own firstDelivery guard means an ordinary Twilio redelivery
 * can never retry it. Excludes anything still mid pre-connect-screen
 * ('gated') or already resolved as a failed one ('failed' — belt and
 * suspenders alongside ringPromiseChaserIfNeeded's own check, so a batch
 * is never spent re-discovering the same excluded call every tick), and
 * anything younger than UNCLAIMED_GRACE_MS, so a challenge genuinely still
 * outstanding is never rung prematurely.
 *
 * Both queries also exclude blocked numbers, sandbox calls, and unusable
 * caller IDs (mirroring ringPromiseChaserIfNeeded's own basic eligibility)
 * — none of those ever get a claim written (the function returns before
 * ever reaching claimAttempt for them), so without this a batch of such
 * rows would occupy every LIMIT-bounded slot, oldest-first, forever, and
 * starve a genuinely recoverable call behind them.
 */
async function sweepPromiseChasers({ limit = 50 } = {}) {
  if (!isEnabled('promiseChaserBell') || !isEnabled('callCommitments')) return 0;
  const since = new Date(Date.now() - SWEEP_LOOKBACK_MS);
  const eligible = (qb) => qb.where({ direction: 'inbound' })
    .modify(whereNotBlockedCall)
    .modify((q) => whereNotSandboxCall(q))
    .whereRaw(`LENGTH(${PHONE_KEY_SQL}) BETWEEN 10 AND 15`);
  const pendingRows = await eligible(db('call_log'))
    .where('created_at', '>', since)
    .whereRaw("metadata->'promise_chaser'->>'status' = 'pending'")
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('twilio_call_sid');
  const unclaimedRows = await eligible(db('call_log'))
    .where('created_at', '>', since)
    .where('created_at', '<', new Date(Date.now() - UNCLAIMED_GRACE_MS))
    .whereRaw("metadata->'promise_chaser' IS NULL")
    .whereRaw("COALESCE(metadata->>'preconnect_screen', '') NOT IN ('gated', 'failed')")
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('twilio_call_sid');
  const sids = [...new Set([...pendingRows, ...unclaimedRows].map((r) => r.twilio_call_sid).filter(Boolean))];
  let rang = 0;
  for (const sid of sids) {
    if (await ringPromiseChaserIfNeeded(sid, { viaSweep: true })) rang += 1;
  }
  return rang;
}

module.exports = { ringPromiseChaserIfNeeded, markScreenFailed, sweepPromiseChasers, describePromise };
