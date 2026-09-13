'use strict';

const { gateEnvValue } = require('../config/feature-gates');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
// Lazy, like this file's other write-path requires (./dispatch-alerts,
// ./tech-visit-notifications): audit-log.js requires ../models/db at module
// scope, and ops/agents/replay-no-show-detector.js imports THIS module for
// its pure helpers alone — a top-level require would build a database
// connection module for an operator running that offline CLI with no
// DATABASE_URL, breaking the "READ-ONLY, no database access" guarantee its
// header and ops/agents/README.md both make (pre-push audit, round 5).
const recordAuditEvent = (...args) => require('./audit-log').recordAuditEvent(...args);
const { ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');
// Call-time, for the same reason as recordAuditEvent above:
// technician-eligibility.js requires ../models/db at module scope, and every
// other service dependency of this file is already lazy so that
// ops/agents/replay-no-show-detector.js — which imports this module for its
// pure helpers alone — never loads the database module (pre-push audit,
// round 5). With this one, the replay's entire module-scope require chain is
// config/feature-gates + utils only.
const isAssignable = (...args) => require('./technician-eligibility').isAssignable(...args);

const enabled = () => gateEnvValue('GATE_NOSHOW_DETECTOR');
const LIVE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];
// The one terminal status that means the truck actually reached the stop.
// Used only to settle a GROUPED stop: 'cancelled', 'skipped' and 'no_show'
// (the rest of visit-context/statuses.js's TERMINAL_ROW_STATUSES) say nothing
// about arrival, and a 'rescheduled' row is awaiting re-placement, not done.
const ATTENDED_STATUSES = ['completed'];
const NOTICE_PURPOSES = ['appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h'];
// purpose='appointment' scheduling notices whose original_message_type
// names a reschedule/confirmation rung, but predate rendered_slot_ms being
// written for that rung (or a future rung this list hasn't caught up to
// yet) — reschedule-sms.js's SMS-reply confirmation ('confirmation', a
// customer picking a rain-out reschedule option) and admin-dispatch.js's
// series-move notice ('reschedule_series_confirmation'). Adding
// rendered_slot_ms to a writer only fixes FUTURE sends; an already-sent
// row with neither rendered_slot_ms nor this original_message_type match
// falls out of the query entirely, so latestPromises silently falls back
// to an OLDER (often the original booking) promise and can raise a
// critical alert against a window the visit no longer holds (codex P1).
// Listed here so the row is still fetched — the existing start_at ternary
// below already renders it as an unknown (null) promise when
// rendered_slot_ms is absent, which is what makes it win over a stale-but-
// known-window promise without asserting a window we don't actually have
// on record. NOT every purpose='appointment' original_message_type
// belongs here — only ones that supersede a previously promised window;
// grepped every purpose:'appointment' writer (rain-out.js is already
// covered by the LIKE 'rain_out_moved%' clause; 'manual' call-requested
// acks, prep-info texts, the recurring welcome text, and recipient-optin
// requests never quote a specific arrival slot and must stay excluded).
const LEGACY_SCHEDULING_MESSAGE_TYPES = ['reschedule_series_confirmation', 'confirmation'];
// email_messages.status values that mean the recipient actually got it —
// webhooks-sendgrid.js's own vocabulary. 'processed'/'sent' are SendGrid's
// accept states, 'delivered' its confirmation, and the last three are
// reactions it reports only for a delivered message.
const DELIVERED_EMAIL_STATUSES = ['sent', 'processed', 'delivered', 'complained', 'spam_report', 'unsubscribed'];
// sms_log statuses that mean the text reached the phone. queued/scheduled/
// sending have not yet; undelivered/failed/blocked never will.
const DELIVERED_SMS_STATUSES = ['sent', 'delivered', 'read'];
// The appointment email event types that quote an arrival window — the same
// list the interaction read filters on, and the first segment of the
// idempotency key appointment-email.js builds for each of them. Only the
// three that actually have a sender: there is no appointment.rescheduled
// producer, and listing it would widen what counts as promise evidence (and
// the supporting index) for a workflow that does not exist (codex P2 round
// 13).
const APPOINTMENT_EMAIL_EVENTS = ['appointment.confirmation', 'appointment.reminder_72h',
  'appointment.reminder_24h'];
const instant = (value) => value == null ? NaN : new Date(value).getTime();
// Stamps that prove the tech reached the stop, in the order job-status.js
// writes them. Any one of them clears the card.
const ARRIVAL_STAMPS = ['arrived_at', 'actual_start_time', 'check_in_time'];
// Past this much after the promised start, a promise no longer MINTS a card
// (see the ignoreHorizon note on promisedStartAt) — an ancient, presumably
// already-handled promise must not surface as news.
const HORIZON_MS = 48 * 3600000;
// How recently a tracking row must have been created for the disabled-state
// cleanup to conclude the feature is still running on another replica. Long
// enough to cover a rolling deploy, in which one replica can still read the
// gate as off while another creates rows under it.
const DISABLED_CLEANUP_GRACE_MS = 15 * 60000;

// Pure, exported for tests and for the replay's coverage measure: the
// evidence-validity half of the rule. Returns the promised start instant the
// stage rules are judged against, or null when this promise cannot be judged
// at `now` at all — no window on record, a communication dated in the future,
// a window that has not begun, or (creation only) one past the 48h horizon.
// Split out of evaluateNoShow so a timing or lifecycle change touches ONE of
// the two rule sets, not a single over-budget decision function (codex P2).
//
// The horizon gates CREATION, not retention: listNoShows (the candidate feed
// behind every NEW alert/notice) always evaluates with ignoreHorizon left
// false, so an ancient, presumably-already-handled promise never mints a
// fresh alert out of nowhere. sweep()'s two reconcile passes (the open
// dispatch_alerts loop and the tech-notice loop) pass ignoreHorizon: true
// instead, so a visit that's STILL in LIVE_STATUSES with no arrival/departure
// evidence and an unchanged promise keeps its already-open alert/notice alive
// past 48h — without this split, elapsed time alone silently auto-resolved
// the exact still-unresolved no-show this feature exists to surface (codex
// P1). Every OTHER exit (status left LIVE_STATUSES, arrival/departure
// evidence, no promise, a changed promise) still applies unconditionally.
// All evidence must exist by the evaluation time; a later arrival cannot
// erase an earlier useful warning in a replay.
function promisedStartAt({ promise, now = new Date(), ignoreHorizon = false } = {}) {
  const start = instant(promise?.start_at);
  const known = instant(promise?.communicated_at);
  const nowMs = instant(now);
  if (!Number.isFinite(start) || !Number.isFinite(known) || known > nowMs || nowMs < start) return null;
  return !ignoreHorizon && nowMs > start + HORIZON_MS ? null : start;
}

// Pure, exported for tests: the stage half of the rule. `null` means nothing
// to raise — the tech is demonstrably there (an arrival stamp, or on_site),
// or neither threshold has been crossed yet. Every stamp must fall between
// the promised day's ET midnight and `now`: a stale stamp from another day
// is not evidence for this window, and a future one cannot erase a warning
// that was already true (which is what keeps the replay honest).
function trackingStage({ visit, start, nowMs, stage1Minutes }) {
  const dayStart = parseETDateTime(`${etDateString(new Date(start))}T00:00`).getTime();
  const observed = (stamp) => Number.isFinite(instant(stamp)) && instant(stamp) >= dayStart && instant(stamp) <= nowMs;
  if (visit.status === 'on_site' || ARRIVAL_STAMPS.some((key) => observed(visit[key]))) return null;
  // The STATUS counts as departure too: admin-dispatch commits
  // transitionJobStatus before calling trackTransitions.markEnRoute, and a
  // failure there is caught — so a visit can sit at status 'en_route' with no
  // en_route_at stamp, and stage 1 ("no departure recorded") would be a false
  // warning about a tech who is already driving (codex P2 round 14).
  const departed = visit.status === 'en_route' || observed(visit.en_route_at);
  if (nowMs >= start + 150 * 60000) return { stage: 2, departed };
  return !departed && nowMs >= start + stage1Minutes * 60000 ? { stage: 1, departed } : null;
}

function stageMessage(stage, departed) {
  if (stage === 1) return 'No departure or arrival is recorded for this window yet.';
  return departed
    ? 'En Route was recorded, but no arrival is recorded after the promised window.'
    : 'The promised window ended over 30 minutes ago; no arrival is recorded.';
}

function evaluateNoShow({ visit, promise, now = new Date(), stage1Minutes = 45, ignoreHorizon = false } = {}) {
  if (!visit || !LIVE_STATUSES.includes(visit.status) || !promise) return null;
  const start = promisedStartAt({ promise, now, ignoreHorizon });
  if (start == null) return null;
  const nowMs = instant(now);
  const staged = trackingStage({ visit, start, nowMs, stage1Minutes });
  if (!staged) return null;
  const { stage, departed } = staged;
  return { stage, evidence: 'missing_tracking', promised_window: { start_at: new Date(start).toISOString(), end_at: new Date(start + ARRIVAL_WINDOW_MINUTES * 60000).toISOString() },
    message: stageMessage(stage, departed),
    due_at: new Date(start + (stage === 2 ? 150 : stage1Minutes) * 60000).toISOString(),
    promise_source: promise.source, promise_id: promise.source_id };
}

function latestPromises(events, now = new Date()) {
  const byVisit = new Map();
  for (const event of events) {
    const at = instant(event.communicated_at);
    // A later notice without a saved window makes coverage unknown. Do
    // not fall back to an older window and call it the latest promise.
    if (!event.visit_id || !Number.isFinite(at) || at > now.getTime()) continue;
    const prior = byVisit.get(String(event.visit_id));
    // A strictly NEWER communication always wins — including an unknown
    // window, which is the legacy move-notice rule. On a TIE the known window
    // wins: the same send can reach this list twice, once from an interaction
    // row that predates rendered_slot_ms (unknown) and once recovered from
    // the message row's own key (known), and keeping the unknown copy threw
    // away the window that recovery exists to restore (codex P1 round 14).
    const tie = prior && instant(prior.communicated_at) === at
      && prior.start_at == null && event.start_at != null;
    if (!prior || instant(prior.communicated_at) < at || tie) byVisit.set(String(event.visit_id), event);
  }
  return byVisit;
}

// The delivery half of the SMS evidence rule, shared by the two reads that
// need it (a visit's own scheduling notices, and the series text that
// supersedes its siblings' windows) so they can never drift apart: a LINKED
// sms_log row must currently read sent/delivered/read, a push row is proof in
// itself, and an UNLINKED row counts only for a real Twilio SM/MM sid — see
// the long note on the messaging_audit_log read for why unlinked is neutral
// and why the success-shaped sentinels are not.
function textActuallyWentOut() {
  this.where('a.provider', 'push').orWhereIn('s.status', DELIVERED_SMS_STATUSES)
    .orWhere(function unlinkedRealSend() {
      this.whereNull('s.id').whereRaw(`a.provider_message_id ~* '^(SM|MM)[a-f0-9]{32}$'`);
    });
}

// One canonical name for a reminder tier however the sender spelled it:
// messaging metadata carries `appointment_reminder_72h`, the email event type
// `appointment.reminder_72h`, and the grouped key's first segment matches the
// latter. Used to match a recovered email to the SEND it belongs to, so the
// 72h window never answers for the 24h send.
function reminderTier(value) {
  const name = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return name.replace(/^appointment/, '') || null;
}

// Read the immutable time rendered into the communication. The current
// scheduled time is deliberately never used as proof of what we promised.
async function loadPromiseEvents(conn, visitIds, { now = new Date() } = {}) {
  if (!visitIds.length) return [];
  // No lower time bound — scoped by the candidate visit ids instead (codex
  // P2). A visit booked >100 days ahead whose customer disabled the 72h/24h
  // reminders has only the ORIGINAL confirmation as evidence; a fixed
  // lookback measured from `now` (evaluated near the service date, not the
  // booking date) excluded a confirmation sent well before that horizon,
  // and with the gate on, the legacy overdue scans are also off — the
  // visit got NO alert at all. All three reads are already scoped to
  // `visitIds` (a small, bounded candidate set from listNoShows) and each
  // one's supporting index is appointment/visit-id-keyed —
  // messaging_audit_appointment_sent_idx, audit_visit_promised_window_idx
  // (20260911000020_follow_through_alerts.js), and
  // customer_interactions_email_scheduled_service_idx
  // (20260911000030_no_show_evidence_indexes.js) — so the visit-id scope
  // alone keeps every read indexed without a time-horizon filter. `now` is
  // still an upper bound: a row can't communicate a promise from the
  // future.
  const reads = [
    () => conn('messaging_audit_log as a').leftJoin('sms_log as s', 's.twilio_sid', 'a.provider_message_id')
      // Either linkage, because appointment_id is NOT universal: the
      // messaging audit only began stamping it from the appointment senders
      // on 2026-08-06 (appointment-reminders.js's
      // `...(metaExtra.scheduled_service_id ? { appointmentId } : {})`), while
      // those same senders have always carried scheduled_service_id in the
      // row's metadata. A LEGACY reschedule/confirmation notice — exactly the
      // class the purpose predicate below goes out of its way to keep as an
      // unknown-window promise — is therefore invisible to an
      // appointment_id-only scope, so the stale pre-move window it superseded
      // goes on driving alerts (codex P1 round 6). Matched on both, and the
      // mapping below reads the visit id from whichever one the row has.
      .where((qb) => qb.whereIn('a.appointment_id', visitIds)
        .orWhereRaw("a.appointment_id IS NULL AND a.metadata->>'scheduled_service_id' = ANY(?::text[])", [visitIds]))
      // Generic appointment texts also include links and preparation tips;
      // only a scheduling notice can replace the customer's promised window.
      // Legacy move notices without a saved time still count as unknown.
      .whereRaw(`(a.purpose = ANY(?::text[]) OR (a.purpose = 'appointment' AND
        (a.metadata->>'rendered_slot_ms' IS NOT NULL OR a.metadata->>'original_message_type' LIKE 'rain_out_moved%'
          OR a.metadata->>'original_message_type' = ANY(?::text[]))))`, [NOTICE_PURPOSES, LEGACY_SCHEDULING_MESSAGE_TYPES])
      .where('a.sent_at', '<=', now).whereNull('a.blocked_code').whereNull('a.provider_error')
      // Live delivery state comes from the sms_log row Twilio's status
      // callback updates. A LINKED row must currently read sent/delivered/
      // read (queued/scheduled/sending never reached the phone yet;
      // undelivered/failed/blocked never will). An UNLINKED audit row
      // (s.id IS NULL) is neutral, not bad, exactly like the email read's
      // em.id IS NULL below: twilio.js's sms_log insert runs AFTER the
      // Twilio API accepted the message and is wrapped in its own
      // try/catch, so a logging failure — or an audit row older than the
      // twilio_sid link — leaves a text the customer really received with
      // no sms_log row at all; requiring positive proof here dropped that
      // promise and let latestPromises fall back to an older window (audit
      // P1). Neutral ONLY for a real Twilio SM/MM sid (the same shape
      // send-customer-message's recordReceiptSmsDelivery trusts): the
      // success-shaped sentinels ('owner-silence', gate-/template-/
      // internal-) mean NO text reached the customer and never get an
      // sms_log row, so they must stay excluded.
      .where(textActuallyWentOut)
      // purpose carries the TIER for a text: the sender passes a generic
      // 'appointment_reminder' message type and names the rung in the purpose
      // ('appointment_reminder_24h' / '_72h' / 'appointment_confirmation'),
      // so normalising the message type alone could never match the email
      // side of the same send (codex P1 round 21, fourth pass).
      .select('a.id', 'a.appointment_id', 'a.metadata', 'a.sent_at', 'a.purpose'),
    // appointment-email.js's own send-time customer_interactions row is
    // never updated afterward (it stays status:'sent' forever) — the LIVE
    // delivery state lands on email_messages via the SendGrid webhook
    // (webhooks-sendgrid.js's computeEmailMessageEventUpdates). A row that
    // webhook later marked bounced/dropped/blocked/failed must not count as
    // promise evidence — the customer never actually got the window — same
    // live-status discipline as the sms_log.status check above (codex P1).
    // Joined on the STABLE email_messages primary key
    // (metadata.email_message_id, stamped by appointment-email.js's
    // logEmailAttempt), NOT the provider id: transactional-email-provider
    // -retry.js reuses the same email_messages row and clears/replaces
    // provider_message_id on every retry claim, so a provider-id join stops
    // matching after the first retry and the em.id IS NULL branch below
    // would read a KNOWN-failed delivery as usable evidence — critical
    // missing-arrival alerts against a window the customer never received
    // (codex P1, round 4). The provider-id match stays as the fallback for
    // interaction rows written before email_message_id existed. No matched
    // row (em.id IS NULL) is still NOT bad evidence — that's an unlinked or
    // legacy send, and this exclusion is about excluding a CONFIRMED bounce,
    // not requiring positive proof of delivery.
    () => conn('customer_interactions as ci')
      .leftJoin('email_messages as em', function joinOnStableMessageId() {
        // Third branch for rows written before email_message_id existed
        // (codex P1 round 7): their provider-id link BREAKS the moment the
        // retry worker claims the message — it clears provider_message_id and
        // later writes a different one, while the interaction keeps the
        // original — after which the join returns em.id IS NULL forever and
        // the row's frozen 'sent' snapshot is read as neutral evidence even
        // while the retry sits queued or failed. email_messages.idempotency_key
        // is immutable and, for every appointment email, is built as
        // `<event_type>:<scheduled_service_id>:<appointment stamp>:<recipient
        // token>` (appointment-email.js), where the appointment stamp IS the
        // slot epoch the interaction already records as rendered_slot_ms. All
        // three are matched, so the link is to THIS occurrence's send: a visit
        // rescheduled twice has one interaction and one message row per slot,
        // and a visit-only prefix would let a later, delivered confirmation
        // vouch for an earlier one the customer never received (codex P1
        // round 7). A row with no rendered_slot_ms cannot be pinned to an
        // occurrence, so it stays unlinked and neutral rather than guessing.
        // Fourth branch for a GROUPED reminder, whose key is
        // `<event_type>:visit:<service_visits id>:…` — the per-service shape
        // above cannot match it, so a grouped interaction written before
        // email_message_id existed had NO usable link once a retry replaced
        // the provider id, and its frozen 'sent' snapshot was read as neutral
        // evidence while the retry sat queued or failed (codex P1 round 13).
        // Relinked through the stop the interaction's own service belongs to,
        // AND the occurrence it was sent for: the claim dedupe key ends in
        // that date, so without it a reminder for the stop's next occurrence
        // would answer for this one's delivery state (codex P1 round 13).
        // The date comes from the window the text itself quoted
        // (rendered_slot_ms), in ET, not from the visit's current
        // scheduled_date, which a later move may have changed.
        // A fan-out matches each recipient's row; one delivered recipient is
        // delivery, same as the SMS side.
        this.on(conn.raw(`em.id::text = (ci.metadata->>'email_message_id')
          OR (ci.metadata->>'email_message_id' IS NULL AND em.provider_message_id = (ci.metadata->>'provider_message_id'))
          OR (ci.metadata->>'email_message_id' IS NULL AND ci.metadata->>'event_type' IS NOT NULL
            AND ci.metadata->>'scheduled_service_id' IS NOT NULL AND ci.metadata->>'rendered_slot_ms' IS NOT NULL
            AND em.idempotency_key LIKE (ci.metadata->>'event_type') || ':' || (ci.metadata->>'scheduled_service_id') || ':' || (ci.metadata->>'rendered_slot_ms') || ':%')
          OR (ci.metadata->>'email_message_id' IS NULL AND ci.metadata->>'event_type' IS NOT NULL
            AND ci.metadata->>'scheduled_service_id' ~ '^[0-9a-f-]{36}$'
            AND ci.metadata->>'rendered_slot_ms' ~ '^[0-9]+$'
            AND em.idempotency_key LIKE (ci.metadata->>'event_type') || ':visit:%'
            AND split_part(em.idempotency_key, ':', 3) = (
              SELECT sv2.visit_id::text FROM scheduled_services sv2
              WHERE sv2.id = (ci.metadata->>'scheduled_service_id')::uuid)
            AND split_part(em.idempotency_key, ':', 5) = to_char(
              to_timestamp((ci.metadata->>'rendered_slot_ms')::bigint / 1000) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'))`));
      })
      .where('ci.interaction_type', 'email_outbound').where('ci.created_at', '<=', now)
      .whereRaw("ci.metadata->>'scheduled_service_id' = ANY(?::text[])", [visitIds])
      // The interaction row is a write-once snapshot of the FIRST attempt, so
      // a send that failed and was later RETRIED SUCCESSFULLY still reads
      // 'failed' here forever — the retry worker reuses the email_messages
      // row and writes no new interaction row. Taking the snapshot alone
      // would discard a window the customer really received on the retry,
      // leaving an older promise standing as the latest (codex P1 round 6).
      // The live email_messages status decides whenever the row is linked;
      // the snapshot still decides for an unlinked/legacy row.
      .where((qb) => qb.whereRaw("ci.metadata->>'status' IN ('sent','delivered')")
        .orWhereIn('em.status', DELIVERED_EMAIL_STATUSES))
      .whereIn(conn.raw("ci.metadata->>'event_type'"), APPOINTMENT_EMAIL_EVENTS)
      // A LINKED row must currently show a delivery the customer actually
      // received: an allowlist, not "anything but the terminal failures"
      // (codex P1 round 6). transactional-email-provider-retry.js flips a
      // failed row back to 'queued' when it claims a retry — before any new
      // provider handoff, and for as long as a crashed worker's claim takes
      // stale-recovery to clear — so a deny-list read that interval as usable
      // evidence for a send that had already failed. DELIVERED_EMAIL_STATUSES
      // therefore lists only states that mean the message reached the
      // recipient: SendGrid's accepted/delivered states, plus the post-
      // delivery reactions ('complained', 'spam_report', 'unsubscribed'),
      // which the provider reports only for a message it delivered. queued/
      // processing (in flight), the four terminal failures, and a NULL status
      // are all excluded. An UNLINKED row (em.id IS NULL) stays neutral —
      // that is a legacy or unlinked send, not a known-bad one.
      .where((qb) => qb.whereNull('em.id').orWhereIn('em.status', DELIVERED_EMAIL_STATUSES))
      // em.sent_at is the LIVE send time: after a successful retry it is the
      // retry's, while ci.metadata.sent_at is frozen at the first (failed)
      // attempt. Selected so the mapping below can order promises by when the
      // customer actually heard this window (codex P1 round 6).
      // em.idempotency_key identifies a GROUPED send: appointment-reminders
      // keys those by the visit-effect claim (`…:visit:<stop>:…`), so the copy
      // speaks for every member of the stop rather than this one service —
      // which is what lets it supersede each member's own confirmation
      // (codex P1 round 24).
      .select('ci.id', 'ci.metadata', 'ci.created_at', 'em.sent_at as provider_sent_at',
        'em.idempotency_key as em_key'),
    () => conn('audit_log as al')
      // A fallback row minted when the messaging audit insert failed carries
      // the provider sid it was accepted under, so the carrier's LATER word
      // still governs: if sms_log now reports that message undelivered/
      // failed/blocked, the promise is dropped, exactly as it would be for an
      // ordinary audit row (codex P1 round 9). A call-evidence row carries no
      // sid and is unaffected.
      .leftJoin('sms_log as fs', 'fs.twilio_sid', conn.raw("al.metadata->>'provider_sid'"))
      .where({ 'al.action': 'visit_window_promised', 'al.resource_type': 'scheduled_service' })
      .whereIn('al.resource_id', visitIds).where('al.created_at', '<=', now)
      // The SAME allowlist the messaging read applies, not a deny-list of the
      // terminal failures: a linked row still sitting at queued/scheduled/
      // sending has not reached the phone, and counting it made a fallback
      // promise stronger than an ordinary one (codex P1 round 10). Unlinked
      // stays neutral — the fallback exists precisely because the primary
      // ledger failed, and sms_log may be missing too.
      .where((qb) => qb.whereRaw("al.metadata->>'provider_sid' IS NULL").orWhereNull('fs.id')
        .orWhereIn('fs.status', DELIVERED_SMS_STATUSES))
      .select('al.id', 'al.resource_id', 'al.metadata', 'al.created_at'),
    // A series move sends ONE text, and that text names only the anchor
    // occurrence's new date — every SIBLING it moved is left with whatever
    // reminder it held for its OLD slot as its latest promise. DERIVED here
    // rather than written at notification time (codex P1 round 6, replacing
    // the round-5 writer): series_moves already records, durably and in one
    // committed row, which occurrences the move touched (`rows`) and whether
    // the customer was actually told (`customer_notified`/`notified_at`), so
    // reading it needs no second write to keep consistent, no retry marker
    // for a write that failed after the text went out, and no backfill —
    // every move made BEFORE this feature existed derives the same way.
    // An APPLIED call reschedule is the one promise class with no
    // customer-facing text of its own (call-reschedule-apply.js deliberately
    // sends nothing — the agent already said it on the call), so it is also
    // the one whose evidence cannot be recovered from a message. Derived from
    // the activity_log row that path writes IN THE SAME TRANSACTION as the
    // move (action call_reschedule_applied, metadata carrying the call, the
    // visit and the applied `to` window), rather than trusted to a separate
    // best-effort write afterwards: a transient failure in that write used to
    // lose the promise permanently — the call is already finalized, and
    // nothing re-runs it — leaving the PRE-MOVE reminder as the latest
    // promise and alerting against a window the customer changed on the call
    // (codex P1 round 8). The same derivation covers every reschedule already
    // applied before this feature existed, and any applied while the capture
    // gate was off — the same reason the booking read above derives from
    // sv.source_call_log_id rather than a write.
    // The email evidence read above starts from customer_interactions, whose
    // insert is itself best-effort: appointment-email.js's logEmailAttempt
    // swallows a failure, the send still reports success, and an idempotent
    // retry writes no second interaction — so an email-only customer could
    // permanently lose the window they were given (codex P1 round 11). The
    // durable email_messages row survives that, and its idempotency_key
    // encodes exactly what the promise needs: <event_type>:<visit>:<slot ms>.
    // Read straight from it, holding the same delivered-status bar, and let
    // latestPromises dedupe against the interaction-derived copy when both
    // exist (same visit, same window, same send time).
    () => conn('email_messages')
      .whereIn(conn.raw("split_part(idempotency_key, ':', 1)"), APPOINTMENT_EMAIL_EVENTS)
      .whereIn(conn.raw("split_part(idempotency_key, ':', 2)"), visitIds)
      .whereRaw("split_part(idempotency_key, ':', 3) ~ '^[0-9]+$'")
      .whereIn('status', DELIVERED_EMAIL_STATUSES)
      .whereNotNull('sent_at').where('sent_at', '<=', now)
      .select('id', 'sent_at', conn.raw("split_part(idempotency_key, ':', 2) as visit_id"),
        conn.raw("split_part(idempotency_key, ':', 3) as slot_ms")),
    // The GROUPED reminder's key has a different shape:
    // `appointment.reminder_<kind>:visit:<service_visits id>:<effect>:<date>`
    // (appointment-reminders.js's visitReminderEmailKey, keyed by the visit
    // -effect claim so every member's email leg dedupes together). Segment 2
    // is the literal 'visit' and there is no slot epoch in it, so the read
    // above cannot see these at all — a stop whose grouped email lost its
    // interaction row would fall back to an older promise (codex P1 round
    // 12). Recovered here through the stop, as an UNKNOWN window: the key
    // proves the customer was told about this occurrence but does not carry
    // the time, and inventing one is exactly what these rounds keep
    // rejecting. Unknown still beats a stale known window — latestPromises
    // keeps the newest, and an unknown window raises no alert.
    () => conn('email_messages as em')
      // Scoped to the occurrence, not just the stop: the claim dedupe key is
      // `<visit>:<effect>:<date>`, so segment 5 is the occurrence date and a
      // reminder for the stop's NEXT occurrence would otherwise mint an
      // unknown-window promise for today's visit and silence its alert
      // (codex P1 round 13).
      // The key's own stop, and only that stop. stop_base_key was tried here
      // to follow a service split onto its new service_visits row, but the
      // base key is (property|customer, date) — every OTHER stop at that
      // property on that day shares it, so the reminder for one stop would
      // have answered for an unrelated one (codex P2 round 18). service_visits
      // records no split lineage, so a split-off row loses this recovery;
      // that costs only the unknown-window fallback, and only when the
      // interaction insert ALSO failed for that send.
      .join('service_visits as keyed', conn.raw("keyed.id::text = split_part(em.idempotency_key, ':', 3)"))
      .join('scheduled_services as sv', function joinOnStopOccurrence() {
        // The key's occurrence date must not be in the visit's FUTURE — that
        // is the next occurrence of a recurring stop, whose reminder says
        // nothing about this one (codex P1 round 13). It may well be in its
        // past: visit-groups carries reminder state when a service splits off
        // a stop without sending another notice, and a whole-stop move keeps
        // the visit id while changing the date — in both cases the customer
        // still holds the promise that reminder communicated, and requiring
        // equality made the evidence vanish exactly when the schedule moved
        // under it (codex P1 round 16).
        this.on(conn.raw(`sv.visit_id = keyed.id
          AND split_part(em.idempotency_key, ':', 5) <= to_char(sv.scheduled_date, 'YYYY-MM-DD')`));
      })
      .whereIn(conn.raw("split_part(em.idempotency_key, ':', 1)"), APPOINTMENT_EMAIL_EVENTS)
      .whereRaw("split_part(em.idempotency_key, ':', 2) = 'visit'")
      .whereIn('sv.id', visitIds)
      .whereIn('em.status', DELIVERED_EMAIL_STATUSES)
      .whereNotNull('em.sent_at').where('em.sent_at', '<=', now)
      // One row per (message, member) even if two visits of the stop match —
      // seriesSupersessions/latestPromises dedupe by visit anyway.
      .select('em.id', 'em.sent_at', 'sv.id as visit_id', 'keyed.id as stop_id',
        conn.raw("split_part(em.idempotency_key, ':', 1) as tier"),
        conn.raw("split_part(em.idempotency_key, ':', 5) as occurrence")),
    // A call-created booking: the visit row itself carries source_call_log_id
    // (a FK written in the booking transaction), so the window the agent
    // committed on that call is derivable from durable state — no separate
    // best-effort write to lose (codex P1 round 10, the booking twin of the
    // applied-reschedule derivation below). The caller-identity check the old
    // writer made is unnecessary here: the visit exists BECAUSE of this call,
    // which is a stronger link than a phone match. Every other rule still
    // applies through agentCommittedStart — spam/voicemail, an actual agent
    // commitment, a finite confirmed_start_at, and the trusted-labels gate.
    () => conn('scheduled_services as sv').join('call_log as cl', 'cl.id', 'sv.source_call_log_id')
      .whereIn('sv.id', visitIds)
      // The call's confirmed_start_at belongs to the visit the caller BOOKED,
      // not to a follow-up treatment the same call spawned: that child
      // carries source_call_log_id too but deliberately has no confirmed time
      // of its own (dispatch settles it), and mapping the primary's window
      // onto it could raise a critical missing-arrival alert before the
      // child's own window even begins (codex P1 round 16). The child is
      // marked by followup_source_service_id / parent_service_id at creation.
      .whereNull('sv.followup_source_service_id').whereNull('sv.parent_service_id')
      .where('cl.created_at', '<=', now)
      // processing_generation rides along rather than filtering: the
      // extraction is MUTABLE (a force-reprocess rewrites
      // ai_extraction_enriched on the same call row), so a later pass must not
      // be allowed to move the window the customer was given at booking time
      // — but dropping the row outright erased the only evidence a call-only
      // booking has, including for an ordinary recovery pass after a partial
      // first one (codex P1 round 19, P2 round 21). Past the first pass the
      // promise survives as an UNKNOWN window: the booking still proves the
      // customer was told something on that call, and the time is no longer
      // ours to assert.
      .select('sv.id as visit_id', 'sv.created_at as booked_at', 'cl.id as call_id', 'cl.ai_extraction_enriched',
        'cl.transcription', 'cl.processing_token', 'cl.processing_generation', 'cl.v2_extraction_status',
        'cl.created_at as call_created_at', 'cl.direction as call_direction', 'cl.bridged_at as call_bridged_at',
        'cl.duration_seconds', 'cl.recording_duration_seconds'),
    () => conn('activity_log as al')
      // The CALL is joined for its own clock: the activity row is written
      // when the pass processed the recording, which can be long after the
      // customer actually heard the commitment, and dating the promise there
      // lets a reminder sent in between outrank it — the same ordering the
      // round-5 fix made for directly captured call promises (codex P1 round
      // 9). callCommitmentInstant below reads the call's end from these.
      .leftJoin('call_log as cl', conn.raw("cl.id::text = al.metadata->>'call_log_id'"))
      .where({ 'al.action': 'call_reschedule_applied' })
      .whereRaw("al.metadata->>'scheduled_service_id' = ANY(?::text[])", [visitIds])
      .where('al.created_at', '<=', now)
      .select('al.id', 'al.metadata', 'al.created_at', 'cl.created_at as call_created_at',
        'cl.direction as call_direction', 'cl.bridged_at as call_bridged_at', 'cl.duration_seconds', 'cl.recording_duration_seconds'),
    // The same supersession, proved by the FALLBACK row instead of the audit
    // row: when persistAudit failed for a series confirmation, nothing in
    // messaging_audit_log records that text, so the join below finds nothing
    // and every sibling keeps its stale promise (codex P1 round 14). The
    // fallback row carries the move id and the send time, which is all the
    // derivation needs; seriesSupersessions dedupes the two sources by
    // (visit, move), keeping the earliest.
    () => conn('series_moves as sm')
      .join('audit_log as fb', function joinOnFallbackProof() {
        this.on(conn.raw(`fb.action = 'visit_window_promised'
          AND fb.metadata->>'series_move_id' = sm.id::text`));
      })
      // Held to the SAME delivery bar as the audit-row proof below: the
      // fallback row carries the sid it was accepted under, so the carrier's
      // later word still governs — a text the customer never received
      // supersedes nothing (codex P1 round 14). Unlinked stays neutral, which
      // is the fallback's premise.
      .leftJoin('sms_log as fbs', 'fbs.twilio_sid', conn.raw("fb.metadata->>'provider_sid'"))
      .where('sm.customer_notified', true).where('fb.created_at', '<=', now)
      .where((qb) => qb.whereRaw("fb.metadata->>'provider_sid' IS NULL").orWhereNull('fbs.id')
        .orWhereIn('fbs.status', DELIVERED_SMS_STATUSES))
      .whereRaw("sm.rows @> ANY (SELECT jsonb_build_array(jsonb_build_object('id', v)) FROM unnest(?::text[]) AS v)", [visitIds])
      .select('sm.id', 'sm.anchor_service_id', 'sm.rows', conn.raw("(fb.metadata->>'communicated_at')::timestamptz as sent_at")),
    () => conn('series_moves as sm')
      // The move's own series text, joined by the series_move_id its metadata
      // carries, and held to the SAME delivery bar as any other promise
      // evidence (codex P1 round 6): series_moves.customer_notified says the
      // sender accepted a handoff, not that the carrier delivered it. A text
      // the customer never got supersedes nothing — the sibling's existing
      // promise still stands. a.sent_at is also the honest communicated_at:
      // the moment the customer was told, not when the effects pass stamped
      // its marker.
      .join('messaging_audit_log as a', function joinOnSeriesMove() {
        // ONE message type supersedes a sibling's promise: the series
        // confirmation, whose copy tells the customer the recurring
        // appointments moved. Quick Move's rain_out_moved* text is NOT it —
        // it describes the anchor appointment only, which is exactly why
        // admin-dispatch.js's closeScope keeps the siblings' reminders open
        // ("never covered by that text"). Treating it as a supersession
        // replaced every sibling's still-standing promise with an unknown
        // window and silenced alerts for appointments the customer is still
        // expecting at the times they were given (codex P1 round 12). The
        // placement confirmation is excluded for the same reason: its copy
        // says later commitments stand until staff review.
        this.on(conn.raw(`a.metadata->>'original_message_type' = 'reschedule_series_confirmation'
          AND a.metadata->>'series_move_id' = sm.id::text`));
      })
      .leftJoin('sms_log as s', 's.twilio_sid', 'a.provider_message_id')
      .where('sm.customer_notified', true)
      .where('a.sent_at', '<=', now).whereNull('a.blocked_code').whereNull('a.provider_error')
      .where(textActuallyWentOut)
      // ONE set-based predicate, not one OR branch per candidate: a large
      // recurring schedule put thousands of containment clauses in this
      // statement, whose construction and planning cost (and expression
      // limits) could abort the whole tick (codex P2 round 11). The GIN index
      // still serves each generated element.
      .whereRaw("sm.rows @> ANY (SELECT jsonb_build_array(jsonb_build_object('id', v)) FROM unnest(?::text[]) AS v)", [visitIds])
      .select('sm.id', 'sm.anchor_service_id', 'sm.rows', 'a.sent_at'),
  ];
  const results = [];
  if (conn.isTransaction) {
    for (const read of reads) results.push(await read());
  } else results.push(...await Promise.all(reads.map((read) => read())));
  const [messages, emails, calls, directEmails, groupedEmails, bookings, appliedReschedules,
    seriesMoveFallbacks, seriesMoves] = results;
  const candidates = new Set(visitIds.map(String));
  const slotOf = (metadata) => (Number.isFinite(Number(metadata?.rendered_slot_ms)) && metadata?.rendered_slot_ms != null
    ? new Date(Number(metadata.rendered_slot_ms)).toISOString() : null);
  // Built before the fallbacks, because the fallbacks defer to them: a
  // `both`-channel grouped reminder sends its SMS FIRST, so when the email's
  // interaction insert fails the KNOWN window is already on the message side,
  // and a check that looked only at interaction rows let the later email row
  // survive as an unknown-window fallback and outrank it (codex P1 round 21).
  const noticeEvents = [
    ...messages.map((r) => ({ visit_id: r.appointment_id || r.metadata?.scheduled_service_id,
      start_at: slotOf(r.metadata), tier: reminderTier(r.purpose || r.metadata?.original_message_type),
      // notificationEventKey is the visit-effect claim the GROUPED send was
      // made under (appointment-reminders.js): it marks copy that speaks for
      // the whole stop, not just this member's own service.
      grouped: !!r.metadata?.notificationEventKey,
      communicated_at: r.sent_at, source: 'message', source_id: r.id })),
    ...emails.map((r) => ({ visit_id: r.metadata?.scheduled_service_id, start_at: slotOf(r.metadata),
      tier: reminderTier(r.metadata?.event_type),
      grouped: String(r.em_key || '').includes(':visit:') || !!r.metadata?.notificationEventKey,
      // The retry's send time when there is one (see the select above), then
      // the interaction row's own snapshot, then its insert time. A promise
      // the customer heard on a retry must not be ordered at the moment the
      // first attempt failed — an intervening reminder would otherwise look
      // newer than it (codex P1 round 6).
      communicated_at: r.provider_sent_at || r.metadata?.sent_at || r.created_at, source: 'email', source_id: r.id })),
  ];
  // The per-service recovery keeps its own window (the key carries the slot),
  // so it is only dropped when the interaction row already provided one for
  // the same send.
  // A grouped email belongs to the STOP, and its interaction row is keyed to
  // whichever member owned the claim — so the "already recovered" check has
  // to be stop-wide. Per member, a sibling would see no interaction evidence
  // of its own and keep an unknown-window fallback that then outranks the
  // owner's known window for the whole stop (codex P1 round 12).
  const groupedFallbacks = (() => {
    // Keyed by ONE SEND — stop, reminder tier and occurrence — and measured
    // from the earliest row of that send's fan-out. A grouped reminder writes
    // an email_messages row per recipient, and logEmailAttempt can fail for a
    // later one after an earlier one already recorded the window; keying on
    // the exact send time let that later row survive as an unknown-window
    // fallback and, being newer, outrank the known window every recipient
    // actually received (codex P1 round 17). Keying by stop ALONE went too
    // far the other way: the 72h reminder's recovery would then cover the
    // 24h send too, which is a different message the customer received later
    // (codex P1 round 17, second pass).
    const sendKey = (r) => `${r.stop_id}:${r.tier}:${r.occurrence}`;
    // Matched by SEND IDENTITY — the visit and the occurrence the notice
    // quoted — not by "communicated at or after". A `both`-channel reminder
    // sends its SMS BEFORE the email, so the known window is timestamped
    // EARLIER than the email fan-out it covers, and a time comparison could
    // never see it (codex P1 round 21, second pass).
    // Same visit, same occurrence, SAME TIER: identity, so the SMS leg of a
    // `both` reminder (sent before its email, therefore timestamped earlier)
    // still covers it, while the 72h reminder's window does not cover the 24h
    // send — a different message the customer received later (codex P1 round
    // 21, rounds 17 and 21 pulling in opposite directions until both are
    // expressed as identity rather than order).
    // GROUPED evidence only: a member that got an INDIVIDUAL reminder before
    // it was grouped can share the tier and occurrence with the later grouped
    // send, and counting that as proof discarded the grouped send's own
    // fallback — leaving the members on their pre-grouping windows (codex P2
    // round 25). A grouped fallback exists because the grouped interaction
    // row is missing, so only other grouped evidence can stand in for it.
    const knownSends = new Set(noticeEvents
      .filter((event) => event.grouped && event.visit_id && event.start_at != null && event.tier)
      .map((event) => `${event.visit_id}:${etDateString(new Date(event.start_at))}:${event.tier}`));
    const stopMembersOf = new Map();
    for (const r of groupedEmails) {
      if (!stopMembersOf.has(r.stop_id)) stopMembersOf.set(r.stop_id, new Set());
      stopMembersOf.get(r.stop_id).add(String(r.visit_id));
    }
    const recoveredSends = new Set(groupedEmails
      .filter((r) => [...stopMembersOf.get(r.stop_id)]
        .some((memberId) => knownSends.has(`${memberId}:${r.occurrence}:${reminderTier(r.tier)}`)))
      .map(sendKey));
    return groupedEmails
      .filter((r) => !recoveredSends.has(sendKey(r)))
      .map((r) => ({ visit_id: r.visit_id, start_at: null, communicated_at: r.sent_at,
        source: 'email', source_id: r.id }));
  })();
  const directEmailFallbacks = directEmails.map((r) => ({ visit_id: r.visit_id,
    start_at: new Date(Number(r.slot_ms)).toISOString(), communicated_at: r.sent_at,
    source: 'email', source_id: r.id }));
  return [
    ...noticeEvents,
    ...calls.map((r) => ({ visit_id: r.resource_id, start_at: r.metadata?.start_at,
      grouped: r.metadata?.stop_wide === true,
      communicated_at: r.metadata?.communicated_at || r.created_at, source: 'call', source_id: r.id })),

    // Recovery only: an unknown-window fallback must never DISPLACE the known
    // window for the same send. When the interaction row exists, it carries
    // the slot and lands above with the same send time — dropping the
    // fallback there keeps the real window (codex P1 round 12). A genuinely
    // NEWER unknown promise (the legacy move-notice case) still wins, because
    // this only defers to known evidence at or after the fallback's own time.
    ...groupedFallbacks.map((event) => ({ ...event, grouped: true })),
    // The per-service recovery is NOT suppressed: it carries the same window
    // the interaction row does (both come from the same send), but it is
    // dated by the message row's live sent_at — which, after a successful
    // retry, is when the customer actually received it, while the interaction
    // snapshot is frozen at the failed first attempt. Dropping it would keep
    // the less accurate of two identical windows (codex P1 round 13). Only
    // the grouped fallback, whose window is UNKNOWN, has to defer.
    ...directEmailFallbacks,
    ...bookings.map((r) => {
      // The call's own start is passed EXPLICITLY: the row aliases it to
      // call_created_at (sv also has a created_at), and
      // hasAgentCommittedEvidence grounds its transcript check on that
      // timestamp — handing it `undefined` silently weakened the
      // trusted-speaker rule this promise class depends on (codex P1 round
      // 10).
      if (r.processing_token) return null;
      // Past the first processing pass the extraction is no longer evidence
      // of anything — it may have been rewritten, invalidated, or had its
      // commitment removed — but the BOOKING still proves the customer was
      // told something on that call, so the promise survives as an unknown
      // window. Both mutable-extraction checks are therefore skipped there,
      // not merely overridden afterwards (codex P1 round 22).
      const firstPass = Number(r.processing_generation || 0) <= 1;
      if (!firstPass) {
        return { visit_id: r.visit_id, start_at: null,
          communicated_at: callCommitmentInstant({ created_at: r.call_created_at, direction: r.call_direction,
            bridged_at: r.call_bridged_at, duration_seconds: r.duration_seconds,
            recording_duration_seconds: r.recording_duration_seconds }, { notAfter: r.booked_at }).toISOString(),
          source: 'call', source_id: r.call_id };
      }
      if (r.v2_extraction_status !== 'valid') return null;
      const target = agentCommittedStart({
        ai_extraction_enriched: r.ai_extraction_enriched, transcription: r.transcription, created_at: r.call_created_at,
      });
      if (target == null) return null;
      return { visit_id: r.visit_id, start_at: new Date(target).toISOString(),
        communicated_at: callCommitmentInstant({ created_at: r.call_created_at, direction: r.call_direction, bridged_at: r.call_bridged_at,
          duration_seconds: r.duration_seconds, recording_duration_seconds: r.recording_duration_seconds },
        { notAfter: r.booked_at }).toISOString(),
        source: 'call', source_id: r.call_id };
    }).filter(Boolean),
    ...appliedReschedules.map((r) => {
      // The window the apply actually moved the visit to, which is the window
      // the agent committed to on the call. ET wall clock, like every other
      // date in this file; an unparseable one becomes an UNKNOWN window
      // rather than a guess — the customer was still told the visit moved.
      const to = r.metadata?.to || {};
      const at = to.date ? parseETDateTime(`${String(to.date).slice(0, 10)}T${String(to.start || '08:00').slice(0, 5)}`) : null;
      // When the customer heard it: the call's end, not the moment the
      // recording pass wrote this row. Falls back to the activity row's own
      // timestamp when the call is gone (a purge, a legacy row).
      const heard = r.call_created_at
        ? callCommitmentInstant({ created_at: r.call_created_at, direction: r.call_direction, bridged_at: r.call_bridged_at,
          duration_seconds: r.duration_seconds, recording_duration_seconds: r.recording_duration_seconds },
        { notAfter: r.created_at })
        : null;
      return { visit_id: r.metadata?.scheduled_service_id,
        start_at: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
        communicated_at: heard ? heard.toISOString() : r.created_at, source: 'call', source_id: r.id };
    }),
    ...seriesSupersessions([...seriesMoves, ...seriesMoveFallbacks], candidates),
  ];
}

// Pure, exported for tests. One customer-notified series move -> an UNKNOWN
// window (start_at: null) for each moved SIBLING, stamped at the moment the
// customer was told. Unknown is the honest record: the text quoted only the
// anchor's new slot, so we know the sibling's old window no longer stands but
// were never told the new one. latestPromises keeps it as that visit's latest
// promise and promisedStartAt reads it as unusable, so the stale pre-move
// reminder stops driving alerts without asserting a window nobody
// communicated — until the sibling's own new reminder does.
//
// The ANCHOR is excluded: its new slot IS in the text, and its own
// messaging_audit_log row carries the rendered_slot_ms that says so. Nothing
// else is: a date_exception sibling is NOT left where it was — rebooker.js's
// projectOccurrenceDate shifts its exceptional date by the anchor delta and
// stores the shifted row with exception: true — so its old-slot reminder is
// just as stale as any other sibling's, and dropping it here left it able to
// raise an alert on the very date the customer was told the series moved
// (codex P1 round 7). series_moves.rows carries only occurrences the move
// actually moved; genuinely preserved ones are recorded separately.
function seriesSupersessions(rows = [], candidates = new Set()) {
  // One row per DELIVERED recipient of the move's text (a fan-out to two
  // appointment contacts writes two audit rows), so keep the earliest
  // delivered send per (visit, move) — that is when the customer was told.
  const earliest = new Map();
  for (const move of rows) {
    const moved = Array.isArray(move.rows) ? move.rows : JSON.parse(move.rows || '[]');
    for (const occurrence of moved) {
      const visitId = String(occurrence?.id || '');
      if (!visitId || !candidates.has(visitId) || occurrence.anchor === true) continue;
      if (String(move.anchor_service_id || '') === visitId) continue;
      const key = `${visitId}:${move.id}`;
      const prior = earliest.get(key);
      if (prior && instant(prior.communicated_at) <= instant(move.sent_at)) continue;
      earliest.set(key, { visit_id: visitId, start_at: null, communicated_at: move.sent_at, source: 'series_move', source_id: move.id });
    }
  }
  return [...earliest.values()];
}

// When the customer heard the commitment. The transcript carries no
// per-utterance timestamps (call-triage-flags.js grounds against bare
// "Agent:"/"Caller:" turns), so the call's END — created_at plus its own
// recorded duration — is the closest defensible instant, and the only one
// that orders correctly against an automated reminder sent DURING a long
// call: dated at the call's START, the promise the agent made minutes later
// looked OLDER than that reminder to latestPromises, and since the applied-
// reschedule path sends no confirmation of its own, the detector went on
// enforcing the stale window (codex P2 round 5). The end never precedes the
// commitment, and a call with no usable duration falls back to created_at.
// Portal OUTBOUND calls make created_at an even weaker floor: call-bridge.js
// inserts call_log BEFORE Twilio rings the staff phone and then the customer,
// so talk time alone omits setup and ringing and can still land before the
// commitment was spoken (codex P2 round 10). The status callback stamps
// updated_at when the call ends, which is the closest thing to a provider
// terminal timestamp we store — but later processing writes (extraction,
// transcription) move it too, so it is only trusted up to a bounded ringing
// allowance past the talk time. Under-stating is the harmful direction: a
// reminder sent during the call would then look newer than the window the
// agent gave, and the detector would enforce the stale one.
// A FIXED allowance, and only for the direction that needs it. updated_at is
// deliberately not used: later processing writes (extraction, transcription,
// enrichment) move it, so the same promise would drift later every time it is
// read — a promise whose timestamp advances after the fact can leapfrog a
// reminder that really was newer (codex P1 round 10). direction is immutable,
// so this stays deterministic: every read of the same call returns the same
// instant.
function callCommitmentInstant(call, { notAfter = null } = {}) {
  const started = instant(call?.created_at);
  // duration_seconds first, the same precedence call-commitments.js's
  // callEndedAt uses: the recording can start after ringing/connection setup,
  // so preferring it dates the commitment before the call actually ended and
  // a reminder sent in the omitted interval would outrank it (codex P2 round
  // 13).
  const seconds = Number(call?.duration_seconds || call?.recording_duration_seconds || 0);
  if (!Number.isFinite(started)) return new Date();
  // Not every call_log row is inserted before the call: a recovery/ingest
  // path can write one AFTER it ended, and adding the duration to that
  // created_at lands past the real end — a promise dated later than it was
  // spoken can leapfrog a reminder that genuinely came after it (codex P1
  // round 10). Each caller passes the anchor it already has (the row written
  // by the pass that processed this call), which is by construction at or
  // after the call ended.
  // The anchor is only usable when it is itself at or after the call began:
  // source_call_log_id can be ATTACHED to a visit that already existed, whose
  // created_at long predates the call, and clamping to that would drag the
  // promise back before it was spoken (codex P1 round 10). A pre-call anchor
  // is simply ignored.
  const anchor = instant(notAfter);
  const ceiling = Number.isFinite(anchor) && anchor >= started ? anchor : NaN;
  const clamp = (ms) => (Number.isFinite(ceiling) ? Math.min(ms, ceiling) : ms);
  // bridged_at is the recorded moment the two legs were connected — the
  // convention call-commitments.js's callEndedAt already uses — so for an
  // outbound call the end is bridge + talk time, measured rather than
  // guessed at a fixed allowance (codex P2 round 11). Rows without it (an
  // inbound call, or one recovered near the end by a status callback) keep
  // created_at as the floor.
  const bridged = instant(call?.bridged_at);
  const usableBridge = Number.isFinite(bridged) && bridged >= started;
  // The whole convention, not half of it: a bridged call ends at bridge +
  // duration, an INBOUND row at created_at + duration, and an outbound row
  // with NO bridge stamp at created_at — those are recovered rows, inserted
  // near the end of the call, so adding the duration would push the
  // commitment past the call itself (call-commitments.js's callEndedAt, codex
  // P2 round 14).
  const outboundNoBridge = !usableBridge && String(call?.direction || '').startsWith('outbound');
  const floor = usableBridge ? bridged : started;
  const talkEnd = clamp(!outboundNoBridge && Number.isFinite(seconds) && seconds > 0 ? floor + seconds * 1000 : floor);
  return new Date(talkEnd);
}

// "What window, if any, did the AGENT commit to on this call?" — the
// extraction-side half, including the trusted-labels rule described above.
function agentCommittedStart(call) {
  const v2 = call?.ai_extraction_enriched;
  if (v2?.meta?.is_spam || v2?.meta?.is_voicemail || v2?.scheduling?.agent_committed_booking !== true) return null;
  const target = instant(v2?.scheduling?.confirmed_start_at);
  if (!Number.isFinite(target)) return null;
  if (!gateEnvValue('GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS')
    || !require('./call-triage-flags').hasAgentCommittedEvidence(v2, call.transcription, call.created_at)) return null;
  return target;
}

// The messaging audit row is where a text's promised window lives, and
// persistAudit is best-effort: if its insert fails AFTER Twilio accepted the
// message, the customer holds a window nothing in the system records. The
// reminder is marked sent and never retried, so the gap is permanent — the
// detector then either sees no promise at all or falls back to an OLDER
// communicated window and raises a critical alert against a slot the
// customer was already moved off (codex P1 round 9). send-customer-message
// calls this on exactly that path, so the promise lands in the durable
// audit_log ledger this file already reads for call evidence. Deliberately
// NOT gated on the detector or capture gates: it is one row, written only
// when the primary ledger failed, and its whole purpose is to still be there
// whenever the feature is switched on. Best-effort itself — a send must
// never fail because its bookkeeping did.
async function recordSentWindowFallback({ visitId, startAtMs, communicatedAt = new Date(), providerSid = null, seriesMoveId = null, stopWide = false } = {}) {
  // null BEFORE the Number conversion: Number(null) is 0, a finite instant
  // (the epoch), so a bare isFinite check would stamp a 1970 window as the
  // promise — the same null-before-conversion trap `instant` guards above.
  // A missing window is only allowed for a series confirmation, which is
  // evidence in its own right: a date-only move quotes no arrival range, so
  // the honest record is an UNKNOWN window for the anchor plus the
  // supersession proof for its siblings — refusing to write anything left
  // every one of those visits on its older window (codex P1 round 15).
  const known = startAtMs != null && Number.isFinite(Number(startAtMs));
  if (!visitId || (!known && !seriesMoveId)) return false;
  const at = new Date(communicatedAt);
  if (!Number.isFinite(at.getTime())) return false;
  try {
    await recordAuditEvent({ actor_type: 'system', action: 'visit_window_promised', resource_type: 'scheduled_service', resource_id: String(visitId),
      metadata: { start_at: known ? new Date(Number(startAtMs)).toISOString() : null, communicated_at: at.toISOString(),
        ...(providerSid ? { provider_sid: String(providerSid) } : {}),
        // A SERIES confirmation is also the proof that every sibling the move
        // touched was superseded — proof that normally lives on the audit row
        // this fallback exists because we could not write. Stamped here so
        // the sibling derivation can still find it (codex P1 round 14).
        ...(seriesMoveId ? { series_move_id: String(seriesMoveId) } : {}),
        // Copy that spoke for a whole grouped stop keeps that identity here,
        // so the promise it recovers supersedes every member's own rather
        // than reading as one service's (codex P1 round 26).
        ...(stopWide ? { stop_wide: true } : {}),
        fallback_reason: 'messaging_audit_unavailable' }, critical: true });
    return true;
  } catch (err) {
    require('./logger').warn(`[no-show-detector] promised-window fallback failed for ${visitId}: ${err.message}`);
    return false;
  }
}

// A `service_visits` row is ONE physical stop shared by N scheduled_services
// (visit-groups.js). The rest of the system already treats it as one: the
// reminder pipeline sends a single grouped text and links its evidence to
// whichever member won the claim, and one En Route / Arrived advances every
// member. Evaluating members independently therefore read a sibling's
// evidence as missing, and could raise several cards for one truck visit
// (codex P1 round 10). Rows with no visit_id are their own group, which is
// every row while GATE_VISIT_GROUPS is off.
//
// The representative is the lowest member id, not the claim owner: the claim
// moves between members from tier to tier, and the tracking key (and the
// dispatch_alerts job_id it carries) must stay stable across sweeps for the
// same stop.
// The stop's representative: the lowest-id member that is still LIVE (the
// lowest id at all if none are). Shared by creation and both reconcile passes
// so they cannot disagree — when the previous representative completes or
// cancels and drops out, the stop's card moves to the next live member, and
// the reconcile pass must recognise the old row's notice/alert as superseded
// rather than leaving two cards up for one stop (codex P1 round 10).
function representativeOf(members = []) {
  const ordered = [...members].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return ordered.find((m) => LIVE_STATUSES.includes(m.status)) || ordered[0] || null;
}

function groupedStops(rows = []) {
  const byStop = new Map();
  for (const row of rows) {
    const key = row.visit_id ? `visit:${row.visit_id}` : `row:${row.id}`;
    if (!byStop.has(key)) byStop.set(key, []);
    byStop.get(key).push(row);
  }
  return [...byStop.values()].map((members) => {
    const ordered = [...members].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return { representative: ordered[0], members: ordered };
  });
}

// Pure, exported for tests. One stop's state for evaluation: the earliest
// arrival/departure stamp any member carries (one action advances all of
// them, but a member that raced ahead is still proof the truck arrived), and
// a NON-live status if any member has left LIVE_STATUSES — a stop whose first
// service is already completed was plainly attended, whatever its siblings
// still say.
function stopState(members = [], { now = new Date(), since = null } = {}) {
  const base = members[0];
  if (members.length === 1) return base;
  // Only stamps that could COUNT as this window's evidence are considered
  // before taking the earliest: evaluateNoShow rejects anything outside the
  // promised day or dated in the future, so collapsing to a raw earliest
  // could hand it a stale prior-day stamp from one member and mask a valid
  // one on another — the group would read as never departed/arrived (codex
  // P1 round 10). The same bounds are applied there; this only decides which
  // member's stamp is offered.
  const floor = Number.isFinite(instant(since)) ? parseETDateTime(`${etDateString(new Date(instant(since)))}T00:00`).getTime() : -Infinity;
  const ceiling = instant(now);
  const earliest = (key) => members.map((m) => m[key])
    .filter((v) => Number.isFinite(instant(v)) && instant(v) >= floor && instant(v) <= ceiling)
    .sort((a, b) => instant(a) - instant(b))[0] || null;
  // Only an ATTENDED sibling settles the stop. A cancelled/skipped/no_show
  // sibling proves nothing about the truck — the customer may still be
  // waiting on the members that remain live, and treating it as settled
  // silenced the alert for the whole stop (codex P1 round 10). If nothing
  // was attended, the stop keeps a LIVE status while any member still has
  // one, so a cancelled representative cannot silence its live siblings
  // either.
  const attended = members.find((m) => ATTENDED_STATUSES.includes(m.status));
  // The most ADVANCED live status among the members, not the first one found:
  // LIVE_STATUSES runs pending -> confirmed -> en_route -> on_site, and one
  // member sitting at 'en_route' or 'on_site' is evidence for the whole stop
  // (one action advances them all). Taking whichever member happened to come
  // first could hand back 'pending' and discard that — on_site clears the
  // card outright, and en_route stops stage 1 (codex P1 round 14).
  const live = members.filter((m) => LIVE_STATUSES.includes(m.status))
    .sort((a, b) => LIVE_STATUSES.indexOf(b.status) - LIVE_STATUSES.indexOf(a.status))[0];
  const status = attended ? attended.status : (live ? live.status : base.status);
  return { ...base, status,
    en_route_at: earliest('en_route_at'), arrived_at: earliest('arrived_at'),
    actual_start_time: earliest('actual_start_time'), check_in_time: earliest('check_in_time') };
}

// Promise events grouped by visit id — what stopPromise needs, since it has
// to see a grouped send even when a later per-service notice has displaced it
// as some member's latest.
function byVisit(events = []) {
  const map = new Map();
  for (const event of events) {
    const key = String(event.visit_id || '');
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return map;
}

// Pure, exported for tests. The stop's communicated window: the latest
// promise across ALL members, because the grouped reminder's evidence is
// linked to whichever member won the claim for that tier — a sibling has no
// evidence of its own, and reading its id alone would fall back to an older
// promise or none at all.
function stopPromise(members = [], eventsByVisit = new Map(), now = new Date()) {
  // The full event list per member, not just each member's latest: a grouped
  // send stops being anyone's latest as soon as one member gets a later
  // per-service notice, and the supersession below would then be invisible —
  // leaving another member's stale pre-grouped confirmation standing (codex
  // P1 round 24, fourth pass).
  const eventsOf = (member) => eventsByVisit.get(String(member.id)) || [];
  // A member the customer is no longer expecting — cancelled, skipped,
  // no_show, awaiting re-placement — contributes no window of its own: the
  // stop must not be held to a time for a service that is not happening
  // (codex P1 round 25). Its GROUPED evidence still counts below, because
  // that copy spoke for the whole stop.
  const awaited = members.filter((member) => LIVE_STATUSES.includes(member.status)
    || ATTENDED_STATUSES.includes(member.status));
  const held = awaited.map((member) => latestPromises(eventsOf(member), now).get(String(member.id)))
    .filter(Boolean);
  // Anything communicated BEFORE the newest grouped send is gone: that send
  // quoted one window for every member, so a member's older per-service
  // confirmation no longer stands even if another member's confirmation came
  // later and is not itself grouped (codex P1 round 24, third pass). Read
  // from EVERY member's events, and before the empty check below: a grouped
  // reminder owned by a member that has since been cancelled is still the
  // window its live siblings are holding (codex P1 round 25).
  const newestGrouped = members.flatMap(eventsOf)
    .filter((event) => event.grouped && instant(event.communicated_at) <= instant(now))
    .reduce((a, b) => (!a || instant(a.communicated_at) < instant(b.communicated_at) ? b : a), null);
  // Past a grouped send, the candidates are anything a member was told AFTER
  // it, plus the send itself — but only while some member is still holding
  // it. A member that has had its own notice since is no longer waiting on
  // the grouped window, and once EVERY member has one the grouped promise is
  // fully superseded and must not linger as the stop's earliest (codex P1
  // round 24, fifth and sixth passes).
  if (!held.length && !newestGrouped) return null;
  const after = newestGrouped
    ? held.filter((promise) => instant(promise.communicated_at) > instant(newestGrouped.communicated_at)) : [];
  const replaced = new Set(after.map((promise) => String(promise.visit_id)));
  const stillHolding = newestGrouped && awaited.some((member) => !replaced.has(String(member.id)));
  const own = newestGrouped ? [...(stillHolding ? [newestGrouped] : []), ...after] : held;
  if (!own.length) return null;
  // An UNKNOWN window still wins when it is the newest thing the customer
  // heard: that is the legacy move-notice rule — coverage became unknown and
  // nothing has replaced it.
  const newest = own.reduce((a, b) => (instant(a.communicated_at) >= instant(b.communicated_at) ? a : b));
  // The newest communication wins outright when it SPEAKS FOR THE STOP — an
  // unknown window (the legacy move-notice rule: coverage became unknown and
  // nothing replaced it), or a GROUPED send, whose copy quotes one window for
  // every member and therefore supersedes each member's own older
  // confirmation (codex P1 round 24, second pass).
  if (newest.start_at == null || newest.grouped) return newest;
  // Otherwise each member still holds its own confirmation — staff can group
  // already-confirmed appointments (admin-visits) without sending replacement
  // copy — so the stop must meet the EARLIEST window any member was promised.
  // Picking the most recently communicated one let a later-sent 11 AM
  // confirmation override a sibling's still-standing 9 AM promise and delay
  // both stages for a stop the customer expects at 9 (codex P1 round 24).
  // Anything communicated before a grouped send is already excluded by the
  // branch above.
  return own.filter((promise) => promise.start_at != null)
    .reduce((a, b) => (instant(a.start_at) <= instant(b.start_at) ? a : b));
}

// One internal caller (sweep), one scope: every live candidate. The
// tech-scoped / paginated variants this used to expose had no route behind
// them (codex P2 round 17).
// Visits the customer was TOLD about recently, whatever their current
// scheduled_date says. Three index-backed reads, unioned: the scheduling
// notices' own visit linkage (both the column and the legacy metadata key),
// the appointment emails' interaction rows, and the call-evidence audit rows.
// Deliberately id-only — the promise itself is loaded later by
// loadPromiseEvents, which applies every delivery and eligibility rule.
async function promisedVisitIds(conn, { now }) {
  // By the PROMISED WINDOW, not by how recently the notice was sent: a
  // confirmation for a visit booked months ahead is the only communication
  // that visit may ever get, and a send-time cutoff dropped exactly the
  // long-lead-confirmation-plus-uncommunicated-move case this path exists for
  // (codex P1 round 19). The window that can be alerting right now is the
  // creation horizon itself — from 48h ago to now — which is also what keeps
  // this bounded.
  const windowFrom = now.getTime() - HORIZON_MS;
  const windowTo = now.getTime();
  // ET date strings for the two date-text lookups below, widened by a day so
  // a window near midnight cannot fall outside the band.
  const recallFromDate = etDateString(new Date(windowFrom - 86400000));
  const recallToDate = etDateString(new Date(windowTo + 86400000));
  const [notices, emails, calls, appliedMoves, bookings, messages] = await Promise.all([
    conn('messaging_audit_log')
      .whereRaw("(metadata->>'rendered_slot_ms')::bigint BETWEEN ? AND ?", [windowFrom, windowTo])
      .select('appointment_id', conn.raw("metadata->>'scheduled_service_id' as meta_visit_id")),
    conn('customer_interactions').where('interaction_type', 'email_outbound')
      .whereRaw("(metadata->>'rendered_slot_ms')::bigint BETWEEN ? AND ?", [windowFrom, windowTo])
      .select(conn.raw("metadata->>'scheduled_service_id' as meta_visit_id")),
    conn('audit_log').where({ action: 'visit_window_promised', resource_type: 'scheduled_service' })
      .whereBetween(conn.raw("(metadata->>'start_at')"), [new Date(windowFrom).toISOString(), new Date(windowTo).toISOString()])
      .select('resource_id'),
    // The durable email row too: loadPromiseEvents recovers a delivered
    // appointment email straight from email_messages when the best-effort
    // interaction insert failed, and leaving it out of recall meant that
    // visit could still be moved out of the date window and vanish — the one
    // case the recovery exists for (codex P1 round 20). Per-service keys
    // only; a grouped key carries no slot, and its promise is unknown-window,
    // which never alerts.
    // The two DERIVED call promises too, by the window they carry: an applied
    // reschedule's activity row and a booking's own call extraction are the
    // only evidence those visits have (neither path sends the customer
    // anything of its own), so leaving them out of recall let exactly those
    // visits vanish when staff moved them out of the date window (codex P1
    // round 20, second pass).
    // Matched on the DATE TEXT each row already stores, not on a converted
    // timestamp: `::timestamptz` and `AT TIME ZONE` are not immutable in
    // Postgres, so an index over them cannot be built and the lookup would
    // scan the table whole (codex P1 round 20, third pass). Recall only has
    // to pull the visit into the candidate set — a day of slack on either
    // side costs a few extra candidates, and evaluateNoShow applies the real
    // window to every one of them.
    conn('activity_log').where({ action: 'call_reschedule_applied' })
      .whereBetween(conn.raw("metadata->'to'->>'date'"), [recallFromDate, recallToDate])
      .select(conn.raw("metadata->>'scheduled_service_id' as meta_visit_id")),
    conn('scheduled_services as sv').join('call_log as cl', 'cl.id', 'sv.source_call_log_id')
      .whereBetween(conn.raw("substr(cl.ai_extraction_enriched->'scheduling'->>'confirmed_start_at', 1, 10)"),
        [recallFromDate, recallToDate])
      .select('sv.id as meta_visit_id'),
    conn('email_messages')
      .whereIn(conn.raw("split_part(idempotency_key, ':', 1)"), APPOINTMENT_EMAIL_EVENTS)
      .whereRaw("split_part(idempotency_key, ':', 2) <> 'visit'")
      .whereRaw("split_part(idempotency_key, ':', 3) ~ '^[0-9]+$'")
      .whereRaw("split_part(idempotency_key, ':', 3)::bigint BETWEEN ? AND ?", [windowFrom, windowTo])
      .whereIn('status', DELIVERED_EMAIL_STATUSES)
      .select(conn.raw("split_part(idempotency_key, ':', 2) as meta_visit_id")),
  ]);
  return [...new Set([
    ...notices.flatMap((r) => [r.appointment_id, r.meta_visit_id]),
    ...emails.map((r) => r.meta_visit_id),
    ...calls.map((r) => r.resource_id),
    ...appliedMoves.map((r) => r.meta_visit_id),
    ...bookings.map((r) => r.meta_visit_id),
    ...messages.map((r) => r.meta_visit_id),
  ].filter(Boolean).map(String))];
}

async function listNoShows(conn, { now = new Date(), limit = 100 } = {}) {
  if (!enabled()) return [];
  // Candidates by SCHEDULE DATE (the indexed scan) OR by PROMISED WINDOW: a
  // still-live visit that staff moved far out of the date window without
  // telling the customer would otherwise drop out before its immutable
  // promise evidence was ever read — and that uncommunicated move is exactly
  // what this detector exists to catch (codex P2 carried from round 4, P1
  // round 19).
  const promisedIds = await promisedVisitIds(conn, { now });
  const rows = await conn('scheduled_services as s').join('customers as c', 'c.id', 's.customer_id')
    .whereIn('s.status', LIVE_STATUSES)
    .where((qb) => qb
      .whereBetween('s.scheduled_date', [etDateString(new Date(now.getTime() - 60 * 86400000)), etDateString(new Date(now.getTime() + 100 * 86400000))])
      .modify((inner) => { if (promisedIds.length) inner.orWhereIn('s.id', promisedIds); }))
    .select('s.*', 'c.first_name', 'c.last_name', 'c.phone');
  // A recalled row that is NOT live still names a stop: the grouped reminder
  // is linked to whichever member won the send claim, and that member may
  // have been cancelled since — in which case the live siblings that are
  // still holding its window would be recalled by nobody, because the status
  // filter above drops the only id the promise pointed at (codex P1 round
  // 26). Their stop is pulled in explicitly.
  const strandedStops = promisedIds.length
    ? (await conn('scheduled_services').whereIn('id', promisedIds).whereNotIn('status', LIVE_STATUSES)
      .whereNotNull('visit_id').distinct('visit_id')).map((r) => r.visit_id)
    : [];
  const stranded = strandedStops.length
    ? await conn('scheduled_services as s').join('customers as c', 'c.id', 's.customer_id')
      .whereIn('s.visit_id', strandedStops).whereIn('s.status', LIVE_STATUSES)
      .whereNotIn('s.id', rows.map((r) => r.id))
      .select('s.*', 'c.first_name', 'c.last_name', 'c.phone')
    : [];
  const liveRows = [...rows, ...stranded]
    .filter((r) => !require('./internal-test-customers').isInternalTestCustomerId(r.customer_id));
  // Pull in every member of the stops these candidates belong to, even the
  // ones this query could not return — a sibling already completed, outside
  // the date window, or filtered out by the tech scope. The grouped reminder
  // links its evidence to whichever member won the claim, so a stop whose
  // promise sits on an unfetched sibling would otherwise read as having none
  // (codex P1 round 10). Cards are still raised only for candidate stops.
  const stopIds = [...new Set(liveRows.map((r) => r.visit_id).filter(Boolean))];
  const siblings = stopIds.length
    ? await conn('scheduled_services as s').join('customers as c', 'c.id', 's.customer_id')
      .whereIn('s.visit_id', stopIds).whereNotIn('s.id', liveRows.map((r) => r.id))
      .select('s.*', 'c.first_name', 'c.last_name', 'c.phone')
    : [];
  const events = await loadPromiseEvents(conn, [...liveRows, ...siblings].map((r) => String(r.id)), { now });
  // Event ARRAYS, the shape stopPromise needs: it computes each member's
  // latest itself so a grouped send stays visible even when a later
  // per-service notice displaced it (codex P1 round 24).
  const promises = byVisit(events);
  const candidateIds = new Set(liveRows.map((r) => String(r.id)));
  const cards = groupedStops([...liveRows, ...siblings]).map(({ members }) => {
    // The representative must be a row this scan actually returned — the
    // card, its tracking key and the office alert's job_id all hang off it —
    // so a stop pulled in only through a sibling raises no card of its own.
    // The stop's canonical representative whenever ANY member made it into
    // this scan — including when recall pulled in only the sibling that owns
    // the grouped reminder. Building the card on that sibling instead would
    // hand lockedStop a non-representative id, which it treats as superseded,
    // so the stop would raise no alert at all (codex P1 round 22). Members
    // outside the scan are still loaded (siblings are fetched above), so the
    // representative is available even when it was not itself recalled.
    const r = members.some((m) => candidateIds.has(String(m.id))) ? representativeOf(members) : null;
    if (!r) return null;
    const promise = stopPromise(members, promises, now);
    const alert = evaluateNoShow({ visit: stopState(members, { now, since: promise?.start_at }), promise, now });
    return alert ? { id: r.id, customer_id: r.customer_id, technician_id: r.technician_id, first_name: r.first_name,
      last_name: r.last_name, phone: r.phone, scheduled_date: r.scheduled_date,
      ...(members.length > 1 ? { grouped_service_ids: members.map((m) => String(m.id)) } : {}), ...alert } : null;
  }).filter(Boolean).sort((a, b) => b.stage - a.stage || instant(a.due_at) - instant(b.due_at) || a.id.localeCompare(b.id));
  return cards.slice(0, limit);
}

// Pure. The dispatch:alert socket broadcast carries the bare inserted row
// (createAlertOnce -> emitAlert), no tech/customer join — an admin with the
// board already open sees "Unassigned" and a blank name on an assigned
// stage-2 card until the next /alerts hydration otherwise (codex P1). Same
// pattern as scheduling/quality-alerts.js's payload.techName.
function trackingIdentityFields(recipientTech, card) {
  return { tech_name: recipientTech?.name || null,
    customer_first_name: card.first_name || null, customer_last_name: card.last_name || null };
}

// Pure, exported for tests. The recipient tech rides in the key (not just
// the type) so a reassignment between two active/dispatchable techs — which
// leaves promise/stage/type unchanged — still changes the key: the sweep's
// existing `payload.tracking_key !== key` branch then resolves the stale
// office alert (still joining tech_name via the old tech_id) and creates a
// fresh one for the new recipient, and the tech-notice reconcile keys off
// the same value (codex P1).
function trackingKey({ visitId, startAt, stage, type, recipient }) {
  return `tracking:${visitId}:${startAt}:${stage}:${type}:${recipient || 'unassigned'}`;
}

// A legacy tech_late/unassigned_overdue row (the older tech-late-detector.js
// / unassigned-overdue-detector.js cron, or any other future non-detector
// source) for this exact (type, job_id) blocks createAlertOnce's insert:
// the partial unique index (idx_dispatch_alerts_tech_late_one_unresolved /
// ..._unassigned_overdue_one_unresolved) is scoped to (job_id) WHERE type=…
// AND resolved_at IS NULL, with no payload.source condition, and
// createAlertOnce's `ON CONFLICT DO NOTHING` has no explicit target — so it
// no-ops against ANY unresolved row of that type+job, not just this
// detector's own. The cleanup loop above is deliberately scoped to
// payload.source = 'no_show_detector' so it never auto-resolves an alert it
// didn't create; this is the explicit handover for the one case that
// blocks it — resolve the legacy row in the SAME transaction, immediately
// before the insert it would otherwise starve forever (codex P1, pre-push
// audit on 4bd251cfc). Rows of other types or other jobs are never touched.
async function resolveLegacyCollision(trx, { jobId, type }) {
  const legacy = await trx('dispatch_alerts').where({ job_id: jobId, type }).whereNull('resolved_at')
    .whereRaw("COALESCE(payload->>'source', '') != 'no_show_detector'");
  // auto: true stamps payload.superseded_at. Without it, the legacy row this
  // handoff resolved still reads to tech-late-detector's own dedupe as an
  // acknowledged alert for the current schedule, so turning the gate back off
  // left the fallback scan suppressed for that visit — the rollback path
  // poisoned by the very handoff that enabled the feature (codex P2 round
  // 12). The legacy predicate ignores rows carrying that stamp.
  for (const alert of legacy) await require('./dispatch-alerts').resolveAlert({ id: alert.id, trx, auto: true });
  return legacy.length;
}

// A row under this exact tracking_key blocks recreation only while it's
// still OPEN, or it's resolved but NOT an automatic supersession (a human
// clicked Resolve on the dispatch board — respect that, stay quiet). A
// resolved row carrying the supersession stamp (set by sweep()'s own
// resolve-on-key-mismatch loops, never by a human resolve) never blocks —
// trackingKey is deterministic, so an A -> B -> A visit reassignment across
// sweeps reuses A's original key, and A's own prior auto-resolution from
// the B handover must not silence its own recreation on the third tick
// (codex P1, pre-push audit on f32a48e35).
async function alreadyHasOpenAlert(trx, { jobId, type, key }) {
  return trx('dispatch_alerts').where({ job_id: jobId, type })
    .whereRaw("payload->>'tracking_key' = ?", [key])
    .where((qb) => qb.whereNull('resolved_at').orWhereRaw("payload->>'superseded_at' IS NULL"))
    .first('id');
}

// Pure, exported for tests. "Still current" gate for the tech-notice
// reconcile pass: same recipient technician, that technician still
// eligible for field work (same isAssignable rule recordTrackingNotice —
// the writer — already requires), same stage, same promised window. A
// tech set field_dispatchable=false keeps their FUTURE visits assigned
// (a deliberate manual reassignment) and still uses the portal — the
// sweep's own office-alert logic already treats them as "no recipient",
// but this reconcile previously checked only the unchanged
// technician_id, so a stale tracking notice stayed visible to a now
// office-only user who cannot act on it (codex P2, pre-push audit on
// 04ecfd821).
function noticeStillCurrent({ live, visit, notice, recipientTech }) {
  const sameRecipient = !!(live && visit?.technician_id === notice?.technician_id);
  return sameRecipient && isAssignable(recipientTech)
    && live.stage === notice?.payload?.stage
    && live.promised_window.start_at === notice?.payload?.promised_window?.start_at;
}

// The office half of one card's reconciliation, lifted out of the per-visit
// transaction so that callback states the LIFECYCLE (notice, then office
// alert, then audit) and this states the alert rules (codex P2).
// `office` is false for a stage-1 card with a recipient tech — the tech's own
// notice is the whole treatment there, and any office row still open from an
// earlier stage or recipient is superseded rather than kept.
async function reconcileOfficeAlert(trx, { card, visit, live, key, type, recipient, recipientTech, office }) {
  const dispatch = require('./dispatch-alerts');
  // Only alerts THIS detector created (matches clearTrackingBells in
  // dispatch-alerts.js) — a pre-existing tech_late/unassigned_overdue row
  // from the legacy overdue detectors, or any other future source of that
  // type, must never be auto-resolved as a side effect of a tracking-key
  // mismatch it was never party to (codex P1).
  const existing = await trx('dispatch_alerts').where({ job_id: card.id }).whereIn('type', dispatch.OVERDUE_ALERT_TYPES)
    .whereNull('resolved_at').whereRaw("payload->>'source' = 'no_show_detector'");
  for (const alert of existing) {
    // auto: true stamps payload.superseded_at on this same write
    // (dispatch-alerts.js#resolveAlert) — trackingKey is deterministic, so an
    // A -> B -> A reassignment across sweeps reuses A's original key, and
    // without this stamp the `already` lookup right below finds THIS same
    // auto-resolved row again on the third tick and refuses to recreate the
    // alert, leaving the overdue visit with no open office card (codex P1,
    // pre-push audit on f32a48e35). A row a dispatcher actually clicked
    // Resolve on never gets this stamp, so it still stays quiet.
    if (!office || alert.payload?.tracking_key !== key) await dispatch.resolveAlert({ id: alert.id, trx, auto: true });
  }
  if (!office || await alreadyHasOpenAlert(trx, { jobId: card.id, type, key })) return false;
  await resolveLegacyCollision(trx, { jobId: card.id, type });
  const result = await dispatch.createAlertOnce({ type, severity: live.stage === 2 ? 'critical' : 'warn',
    techId: recipient, jobId: card.id, trx, payload: { source: 'no_show_detector', tracking_key: key, ...live,
      scheduled_date: visit.scheduled_date, window_start: visit.window_start, window_end: visit.window_end,
      ...trackingIdentityFields(recipientTech, card) } });
  if (!result.created) return false;
  await require('./notification-service').notifyAdmin('alert', 'A promised arrival needs attention', live.message, {
    // The tracking card lives on the dispatch Action Queue (this office alert
    // is a tech_late/unassigned_overdue dispatch_alerts row), not
    // Communications -> Owed — that tab loads only
    // /admin/call-recordings/commitments/open, which never includes this
    // alert type (codex P1 af4925f71).
    dedupeKey: `dispatch-alert:${result.row.id}`, trx, link: '/admin/dispatch', bell: true,
    metadata: { dispatch_alert_id: result.row.id, scheduled_service_id: card.id, stage: live.stage },
  });
  return true;
}

// One stop, read and LOCKED under the caller's transaction, evaluated the
// same way everywhere: creation and both reconcile passes. The group is
// re-derived from the row's current visit_id rather than from a payload, so a
// stop regrouped since the card was raised still reconciles as it stands now.
//
// All three call sites MUST share this: the per-card loop evaluated the whole
// stop while the reconcile passes looked only at the representative, so a
// grouped reminder owned by a SIBLING read as "no promise" there — each tick
// created the alert and notice and then immediately resolved and dismissed
// them, re-notifying the tech every five minutes (codex P1 round 10).
// Members are locked in id order, the same order every pass takes them in.
async function lockedStop(trx, serviceId, { now = new Date(), ignoreHorizon = false, promises = null } = {}) {
  // The STOP's advisory lock first, the same one visit-groups takes for every
  // create/join/split: its splitChild can lock the higher-id child and then
  // wait for its sibling, while an id-ordered FOR UPDATE here locks the
  // sibling first and waits for the child — a lock inversion that deadlocks
  // the sweep against an operator's split (codex P1 round 22). Holding the
  // stop lock serialises the two, and it is released with the transaction.
  // NOT swallowed: lockStopForRow throws VISIT_STOP_MOVED when the stop
  // changed under the peek, and continuing without the lock would put back
  // exactly the inversion it prevents. Each caller's transaction is one row,
  // so the throw skips that row and the next tick retries it (codex P1 round
  // 22, second pass).
  await require('./visit-groups').lockStopForRow(trx, serviceId);
  // The first read takes NO lock: it only answers "which stop is this?".
  // Locking the representative and then the group would take row locks in
  // two different orders (this row first, then every member in id order),
  // which is how two sweeps working the same stop from different members
  // deadlock. The group below is locked in id order, the one order every
  // pass uses (codex P1 round 10).
  const row = await trx('scheduled_services').where({ id: serviceId }).first();
  if (!row) return { visit: null, members: [], promise: null, live: null };
  let members = row.visit_id
    ? await trx('scheduled_services').where({ visit_id: row.visit_id }).forUpdate().orderBy('id').select('*')
    : await trx('scheduled_services').where({ id: serviceId }).forUpdate().select('*');
  if (!members.length) return { visit: null, members: [], promise: null, live: null };
  // Membership is re-checked against the LOCKED row: visit-groups can attach
  // or split this service between the unlocked read above and the lock, and
  // the snapshot would then be of the wrong stop — most sharply when the
  // first read saw no group and one committed while FOR UPDATE waited (codex
  // P2 round 20). One re-read settles it: the group is now locked, so it
  // cannot change again underneath this transaction.
  let locked = members.find((m) => String(m.id) === String(serviceId));
  if (!locked) {
    // The service LEFT the group between the two reads (splitChild), so the
    // predicate no longer matches it and the locked set is all siblings. Its
    // own row has to be read — and locked — or the evaluation would run on
    // the stale pre-lock copy against a stop it no longer belongs to (codex
    // P2 round 21).
    [locked] = await trx('scheduled_services').where({ id: serviceId }).forUpdate().select('*');
    if (!locked) return { visit: null, members: [], promise: null, live: null };
  }
  if (String(locked.visit_id || '') !== String(row.visit_id || '')) {
    members = locked.visit_id
      ? await trx('scheduled_services').where({ visit_id: locked.visit_id }).forUpdate().orderBy('id').select('*')
      : [locked];
  }
  const visit = members.find((m) => String(m.id) === String(serviceId)) || row;
  // Evidence can be handed in, pre-loaded for the whole tick. Re-reading it
  // per row meant nine queries per card — a backlog of 50 stage-2 visits ran
  // roughly 900 evidence queries every five minutes, each one WHILE holding
  // the stop's row locks, because transaction-backed reads run sequentially
  // (codex P2 round 16). The lock still protects the schedule rows, which are
  // what the decision writes against; evidence a few seconds old cannot make
  // a card appear or vanish that the next tick would not correct.
  const known = promises || byVisit(await loadPromiseEvents(trx, members.map((m) => String(m.id)), { now }));
  const promise = stopPromise(members, known, now);
  const live = evaluateNoShow({ visit: stopState(members, { now, since: promise?.start_at }), promise, now, ignoreHorizon });
  // A card belongs to the stop's representative. If this row is no longer it
  // — the previous representative completed or cancelled and the stop moved
  // to the next live member — its card is superseded by that member's, so the
  // reconcile passes must clear it instead of keeping two up for one stop.
  const representative = representativeOf(members);
  const stale = !!representative && String(representative.id) !== String(serviceId);
  return { visit, members, promise, representative, live: stale ? null : live };
}

// The kill switch has to CLEAN UP, not just stop creating: sweep() is the
// only pass that resolves a detector office alert or dismisses a tracking
// notice when the visit arrives, completes, moves or is reassigned. Flipping
// GATE_NOSHOW_DETECTOR off used to freeze both — /api/admin/dispatch/alerts
// keeps serving unresolved rows, so a stale critical card could sit on the
// board indefinitely, and an unresolved detector row also suppresses the
// legacy scanner the gate just handed back (codex P1 round 10). Runs from the
// same cron as the legacy scan, so a disabled feature clears itself within one
// tick. Every resolve is stamped automatic, so nothing here reads later as a
// dispatcher's own acknowledgement.
async function cleanupAfterDisable(conn) {
  if (enabled()) return { resolved: 0, dismissed: 0 };
  const dispatch = require('./dispatch-alerts');
  // Is the DETECTOR still running anywhere? This decision is process-local,
  // so during a zero-downtime deploy an old replica still carrying the gate
  // as OFF runs alongside a new one that has it ON. The durable fleet signal
  // is the sweep's own cron health row: runExclusive('no-show-detector', …)
  // stamps last_started_at on EVERY enabled tick, whether or not that tick
  // had anything to create — which is exactly the case row-recency probes
  // missed, an enabled replica maintaining unchanged rows without making new
  // ones (codex P2 round 22, refining the round-20 fix). Newly created rows
  // are still honoured as a second signal, for the first ticks after a flip
  // when health may not have been written yet.
  const settled = new Date(Date.now() - DISABLED_CLEANUP_GRACE_MS);
  const sweepRan = await conn('job_health').where({ job_name: 'no-show-detector' })
    .where('last_started_at', '>=', settled).first('job_name').catch(() => null);
  const recentAlert = sweepRan ? null
    : await conn('dispatch_alerts').whereRaw("payload->>'source' = 'no_show_detector'")
      .where('created_at', '>=', settled).first('id');
  const recentNotice = sweepRan || recentAlert ? null
    : await conn('tech_notifications').where({ type: 'follow_through_tracking' })
      .where('created_at', '>=', settled).first('id');
  if (sweepRan || recentAlert || recentNotice) return { resolved: 0, dismissed: 0, deferred: true };
  const open = await conn('dispatch_alerts').whereIn('type', dispatch.OVERDUE_ALERT_TYPES)
    .whereNull('resolved_at').whereRaw("payload->>'source' = 'no_show_detector'")
    .select('id');
  for (const alert of open) await dispatch.resolveAlert({ id: alert.id, auto: true });
  const dismissedAt = new Date();
  const dismissed = await conn('tech_notifications').where({ type: 'follow_through_tracking' })
    .whereNull('dismissed_at')
    .update({ dismissed_at: dismissedAt, read: true, updated_at: dismissedAt,
      payload: conn.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('superseded_at', ?::text)", [dismissedAt.toISOString()]) });
  if (open.length || dismissed) {
    require('./logger').info(`[no-show-detector] gate off — cleared ${open.length} office alert(s) and ${dismissed} tracking notice(s)`);
  }
  return { resolved: open.length, dismissed: Number(dismissed) || 0 };
}

// Is this notice's stop still overdue, and still this technician's? Checked
// between the committed card and the push, which is the one effect the next
// sweep cannot undo (codex P2 round 24). On a clock taken NOW, not the
// tick's: the point of the check is what is true at the moment the push
// leaves, and the sweep may have been running for minutes (codex P1 round
// 24). Read-only and outside the transaction: the card already stands either
// way.
async function stillOverdue(conn, notice, { now = new Date() } = {}) {
  try {
    const { visit, live } = await lockedStop(conn, notice.visitId, { now, ignoreHorizon: true });
    return !!live && !!visit && String(visit.technician_id || '') === String(notice.technicianId || '');
  } catch (err) {
    require('./logger').warn(`[no-show-detector] push recheck failed for ${notice.visitId}: ${err.message}`);
    return false;
  }
}

// One row's transaction, isolated: a stop lock that cannot be taken (another
// pass holds it) or a stop that moved under the peek raises, and that must
// skip this row rather than abort the sweep — the next tick retries it.
async function withRow(id, run) {
  try {
    return await run();
  } catch (err) {
    require('./logger').warn(`[no-show-detector] row ${id} skipped this tick: ${err.message}`);
    return null;
  }
}

async function sweep(conn, { now = new Date() } = {}) {
  if (!enabled()) return { alerted: 0 };
  const rows = await listNoShows(conn, { now, limit: 10000 });
  const dispatch = require('./dispatch-alerts');
  const techNotices = require('./tech-visit-notifications');
  let alerted = 0;
  // One evidence read for the whole tick, shared by both RECONCILE passes
  // (codex P2 round 16). The per-card creation loop deliberately re-reads
  // under its own lock — see there. Built from the visits behind every open
  // alert and active notice, which may no longer be candidates.
  const openAlerts = await conn('dispatch_alerts').whereIn('type', dispatch.OVERDUE_ALERT_TYPES)
    .whereNull('resolved_at').whereRaw("payload->>'source' = 'no_show_detector'").select('id', 'job_id', 'payload');
  const activeNotices = await conn('tech_notifications').where({ type: 'follow_through_tracking' })
    .whereNull('dismissed_at').select('id', 'technician_id', 'payload');
  const touched = [...new Set([
    ...openAlerts.map((alert) => String(alert.job_id)),
    ...activeNotices.map((notice) => String(notice.payload?.visit_id || '')),
  ].filter(Boolean))];
  const stopsTouched = touched.length
    ? (await conn('scheduled_services').whereIn('visit_id',
      (await conn('scheduled_services').whereIn('id', touched).whereNotNull('visit_id').distinct('visit_id')).map((r) => r.visit_id))
      .select('id')).map((r) => String(r.id))
    : [];
  const evidenceIds = [...new Set([...touched, ...stopsTouched])];
  const tickPromises = evidenceIds.length
    ? byVisit(await loadPromiseEvents(conn, evidenceIds, { now })) : new Map();
  for (const card of rows) {
    // One row's failure — a stop lock that could not be taken, a moved stop —
    // must not abort the sweep: the next tick retries it.
    const notice = await withRow(card.id, () => conn.transaction(async (trx) => {
      // Re-read the WHOLE stop under the lock, not just the representative:
      // a grouped visit is evaluated as one (see groupedStops), so its
      // confirmation here must use the same members, the same shared promise
      // and the same merged arrival state, or a sibling's arrival stamp
      // recorded since listNoShows ran would be missed (codex P1 round 10).
      // Evidence re-read for THIS STOP, inside the transaction, on a FRESH
      // clock. This is the path that MINTS an alert and pushes a
      // notification: a reschedule communicated since the tick-wide read
      // would otherwise raise a card for a window the customer has already
      // been told was replaced, and the next tick can clear the row but
      // cannot retract the push (codex P1 round 19). The clock matters for
      // the same reason — the tick's `now` was read before a serial loop
      // that can run for minutes. Scoped to the stop's own members rather
      // than re-running the whole tick's scan under the lock (codex P2 round
      // 24); the reconcile passes keep the tick-wide preload, since they only
      // resolve or dismiss and the next tick recreates anything cleared too
      // eagerly.
      const at = new Date();
      const { visit, live } = await lockedStop(trx, card.id, { now: at });
      if (!enabled() || !visit) return null;
      if (!live || live.stage !== card.stage || live.promised_window.start_at !== card.promised_window.start_at) return null;
      const recipientTech = visit.technician_id ? await trx('technicians').where({ id: visit.technician_id,
        employment_status: 'active', field_dispatchable: true }).first('id', 'name') : null;
      const recipient = recipientTech?.id || null;
      const type = recipient ? 'tech_late' : 'unassigned_overdue';
      const key = trackingKey({ visitId: card.id, startAt: live.promised_window.start_at, stage: live.stage, type, recipient });
      // Identify the visit on the card itself (codex P1) — a tech with more
      // than one stop can't tell which one a bare stage message is about.
      // Same "who/when" a visit_* card shows, not a second formatter. Built
      // from the PROMISED window, not the visit's current scheduled_date/
      // window_start/window_end — those are mutable and a shorter service
      // block or an uncommunicated internal move must not repaint what was
      // promised (codex P1).
      const customerName = techNotices.customerLabel({ cust_last_name: card.last_name, cust_first_name: card.first_name });
      const when = techNotices.formatPromisedWindow(live.promised_window.start_at, live.promised_window.end_at);
      const notice = await techNotices.recordTrackingNotice(trx, { visitId: card.id, technicianId: recipient,
        stage: live.stage, dedupeKey: key, message: live.message,
        payload: { ...live, visit_id: card.id, customer_name: customerName, when } });
      const office = live.stage === 2 || !recipient;
      const created = await reconcileOfficeAlert(trx, { card, visit, live, key, type, recipient, recipientTech, office });
      if (notice || created) {
        await recordAuditEvent({ actor_type: 'system', action: 'missing_tracking_alerted', resource_type: 'scheduled_service', resource_id: card.id,
          metadata: { stage: live.stage, promise_start_at: live.promised_window.start_at, evidence: live.evidence }, critical: true, trx });
        alerted += 1;
      }
      return notice;
    }));
    // Deliver each committed notice before another row or cleanup can fail —
    // but re-check the visit first. An arrival, completion or reassignment
    // waiting on the row lock this transaction just released can commit
    // before the provider call finishes, and the old technician would get a
    // missing-tracking push for a visit that has already arrived or moved on:
    // the next sweep dismisses the durable card, but nothing retracts a push
    // (codex P2 round 24).
    if (notice && await stillOverdue(conn, notice, { now: new Date() })) await techNotices.pushTrackingNotice(notice);
  }
  // The same rows the evidence preload above was built from.
  for (const alert of openAlerts) await withRow(alert.job_id, () => conn.transaction(async (trx) => {
    if (!enabled()) return;
    const { live } = await lockedStop(trx, alert.job_id, { now, ignoreHorizon: true, promises: tickPromises });
    // ignoreHorizon: true — past the 48h horizon this alert's own visit
    // would no longer appear in listNoShows' candidate set at all (the
    // horizon gates CREATION, not retention — see evaluateNoShow), and
    // this reconcile pass is the only thing left touching it. Without
    // this, elapsed time alone would read as "no longer applicable" and
    // auto-resolve a visit that's still overdue with zero evidence
    // (codex P1).
    // Deliberately NO tracking_key / recipient comparison here: a tech ->
    // tech reassignment inside the horizon is the per-card loop's job (it
    // resolves the old key AND mints the replacement), and past the horizon
    // nothing can mint a replacement — resolving on a recipient change
    // there would be the same silent drop, so the existing card stays open
    // (naming the tech it was raised against) until the visit itself moves
    // on or a dispatcher resolves it.
    if (!live || live.stage !== alert.payload.stage || live.promised_window.start_at !== alert.payload.promised_window?.start_at) {
      // Same automatic-supersession stamp as the per-card loop above (codex
      // P1) — this pass catches a visit that dropped out of `rows`
      // entirely (arrived, completed, cancelled); if it later re-enters
      // tracking under the exact same tracking_key, the `already` lookup
      // must not treat this row as a human resolution.
      await dispatch.resolveAlert({ id: alert.id, trx, auto: true });
    }
  }));
  // Tech-side notices have no auto-resolve of their own (codex P1): a
  // stage-1-only notice never gets a dispatch_alerts row, and even a stage 2
  // that DOES only clears the office side above. Reconcile every unread/
  // undismissed tracking notice the same way — arrived, reassigned (the row
  // is scoped to the technician_id it was written for), or superseded by a
  // later stage (dedupeKey differs per stage, so the old stage-1 row would
  // otherwise sit next to the new stage-2 one forever) all dismiss it.
  for (const notice of activeNotices) await withRow(notice.payload?.visit_id, () => conn.transaction(async (trx) => {
    if (!enabled()) return;
    const visitId = notice.payload?.visit_id;
    const { visit, live } = visitId ? await lockedStop(trx, visitId, { now, ignoreHorizon: true, promises: tickPromises })
      : { visit: null, live: null };
    // ignoreHorizon: true for the same reason as the dispatch_alerts pass
    // above — elapsed time alone must not dismiss a notice for a visit
    // that is still live with no arrival evidence.
    const sameRecipient = !!(live && visit.technician_id === notice.technician_id);
    // The tech this notice was written for may have gone
    // field_dispatchable=false since (a deliberate move to office-only —
    // future visits stay assigned, and the account still uses the portal).
    // Only fetched when otherwise current, to skip the extra read once
    // any other mismatch already dismisses the notice.
    const recipientTech = sameRecipient ? await trx('technicians').where({ id: visit.technician_id })
      .first('id', 'employment_status', 'field_dispatchable') : null;
    if (!noticeStillCurrent({ live, visit, notice, recipientTech })) {
      // Stamped as an AUTOMATIC dismissal (never a tech's own Got-it tap —
      // routes/tech-notifications.js's /dismiss and /confirm-start never
      // touch payload), so recordTrackingNotice can revive this same row
      // for a later cycle under the same dedupe_key (a GLOBAL unique index,
      // unlike dispatch_alerts' partial one) instead of staying silenced
      // forever — same A -> B -> A reassignment case the dispatch_alerts
      // supersession stamp above handles (codex P1, pre-push audit on
      // f32a48e35).
      const dismissedAt = new Date();
      await trx('tech_notifications').where({ id: notice.id }).whereNull('dismissed_at')
        .update({ dismissed_at: dismissedAt, read: true, updated_at: dismissedAt,
          payload: trx.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('superseded_at', ?::text)", [dismissedAt.toISOString()]) });
    }
  }));
  return { alerted, active: rows.length };
}

module.exports = { enabled, cleanupAfterDisable, evaluateNoShow, promisedStartAt, trackingStage, callCommitmentInstant, LIVE_STATUSES, latestPromises, loadPromiseEvents, seriesSupersessions, byVisit, reminderTier, promisedVisitIds, groupedStops, representativeOf, stopState, stopPromise, lockedStop, recordSentWindowFallback, listNoShows, sweep, trackingKey, resolveLegacyCollision, alreadyHasOpenAlert, noticeStillCurrent };
