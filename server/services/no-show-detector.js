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
const { phoneMatchDigits } = require('../utils/phone');
const { ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');
const { KNOWN_CALLER_PHONE_COLS } = require('../utils/known-caller-phone');
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
const instant = (value) => value == null ? NaN : new Date(value).getTime();
// Stamps that prove the tech reached the stop, in the order job-status.js
// writes them. Any one of them clears the card.
const ARRIVAL_STAMPS = ['arrived_at', 'actual_start_time', 'check_in_time'];
// Past this much after the promised start, a promise no longer MINTS a card
// (see the ignoreHorizon note on promisedStartAt) — an ancient, presumably
// already-handled promise must not surface as news.
const HORIZON_MS = 48 * 3600000;

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
  const departed = observed(visit.en_route_at);
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
    if (!prior || instant(prior.communicated_at) < at) byVisit.set(String(event.visit_id), event);
  }
  return byVisit;
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
      .whereIn('a.appointment_id', visitIds)
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
      .where(function delivered() {
        this.where('a.provider', 'push').orWhereIn('s.status', ['sent', 'delivered', 'read'])
          .orWhere(function unlinkedRealSend() {
            this.whereNull('s.id').whereRaw(`a.provider_message_id ~* '^(SM|MM)[a-f0-9]{32}$'`);
          });
      })
      .select('a.id', 'a.appointment_id', 'a.metadata', 'a.sent_at'),
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
        this.on(conn.raw(`em.id::text = (ci.metadata->>'email_message_id')
          OR (ci.metadata->>'email_message_id' IS NULL AND em.provider_message_id = (ci.metadata->>'provider_message_id'))`));
      })
      .where('ci.interaction_type', 'email_outbound').where('ci.created_at', '<=', now)
      .whereRaw("ci.metadata->>'scheduled_service_id' = ANY(?::text[])", [visitIds])
      .whereRaw("ci.metadata->>'status' IN ('sent','delivered')")
      .whereRaw("ci.metadata->>'event_type' IN ('appointment.confirmation','appointment.reminder_72h','appointment.reminder_24h','appointment.rescheduled')")
      // whereNull('em.status') is not redundant with whereNull('em.id'):
      // status is nullable (20260518000001_email_template_library.js writes a
      // 'queued' DEFAULT, not NOT NULL), and under three-valued logic
      // `NULL NOT IN (...)` is NULL — so a LINKED row with no status would be
      // excluded, i.e. read as a CONFIRMED bad delivery. That is the opposite
      // of this read's rule: only a known-bad status is bad evidence,
      // everything unknown stays neutral (pre-push audit, round 5).
      .where((qb) => qb.whereNull('em.id').orWhereNull('em.status')
        .orWhereNotIn('em.status', ['bounced', 'dropped', 'blocked', 'failed']))
      .select('ci.id', 'ci.metadata', 'ci.created_at'),
    () => conn('audit_log').where({ action: 'visit_window_promised', resource_type: 'scheduled_service' })
      .whereIn('resource_id', visitIds).where('created_at', '<=', now).select('id', 'resource_id', 'metadata', 'created_at'),
  ];
  const results = [];
  if (conn.isTransaction) {
    for (const read of reads) results.push(await read());
  } else results.push(...await Promise.all(reads.map((read) => read())));
  const [messages, emails, calls] = results;
  return [
    ...messages.map((r) => ({ visit_id: r.appointment_id, start_at: Number.isFinite(Number(r.metadata?.rendered_slot_ms)) && r.metadata?.rendered_slot_ms != null
      ? new Date(Number(r.metadata.rendered_slot_ms)).toISOString() : null, communicated_at: r.sent_at, source: 'message', source_id: r.id })),
    ...emails.map((r) => ({ visit_id: r.metadata?.scheduled_service_id, start_at: Number.isFinite(Number(r.metadata?.rendered_slot_ms)) && r.metadata?.rendered_slot_ms != null
      ? new Date(Number(r.metadata.rendered_slot_ms)).toISOString() : null, communicated_at: r.metadata?.sent_at || r.created_at, source: 'email', source_id: r.id })),
    ...calls.map((r) => ({ visit_id: r.resource_id, start_at: r.metadata?.start_at,
      communicated_at: r.metadata?.communicated_at || r.created_at, source: 'call', source_id: r.id })),
  ];
}

// Pure, exported for tests. Same caller-identity rule
// call-reschedule-apply.js's applied-reschedule path uses — counterpartPhone
// classifies outbound by PREFIX (Twilio's direction keeps 'outbound-api'/
// 'outbound-dial' on some paths; an exact 'outbound' match read those as
// inbound and compared the Waves number instead of the customer's), matched
// against ALL five on-file identity columns (primary, secondary, the three
// service-contact slots) via KNOWN_CALLER_PHONE_COLS, not customer.phone
// alone. Reused here rather than copied, so recordAgreedWindow never drifts
// from what the apply path already treats as an on-file caller (codex P1,
// pre-push audit on e2e0e089c) — a caller the linker matched through a
// secondary/service-contact number, or a call whose direction is one of
// those Twilio variants, must not fail this and leave the old promise in
// place for a move that actually succeeded.
function callerIdentityMatches(call, customer) {
  const counterpartPhoneKeys = phoneMatchDigits(require('./call-reschedule-apply').counterpartPhone(call));
  const onFileKeys = new Set(KNOWN_CALLER_PHONE_COLS.flatMap((col) => phoneMatchDigits(customer?.[col])));
  return counterpartPhoneKeys.some((key) => onFileKeys.has(key));
}

// Pure, exported for tests. The whole "may this call's spoken slot become a
// promised-window audit row?" policy in one declarative place, rather than a
// chain of conditions spread through the transaction body (codex P2). Returns
// the agreed start instant, or null when ANY rule rejects it:
//   - the call is still being processed, or is not this visit's customer
//   - the counterpart phone is not one of the customer's on-file numbers
//   - the extraction says spam/voicemail, or that no agent commitment was made
//   - no finite confirmed_start_at was extracted
//   - the trusted-speaker rule below rejects the Agent:/Caller: labelling
// The trusted-labels part mirrors canAutoRoute's own guard
// (call-triage-flags.js ~L1162-1181): the transcript labels
// hasAgentCommittedEvidence grounds against are themselves LLM-inferred, so a
// swapped label could let a CALLER-spoken slot pass as an agent commitment.
// This claim class demands that deterministic-labels opt everywhere else, and
// a promised-window row is no different (codex P1 af4925f71) — the gate is
// read live, not from the module-load `gates` snapshot, matching this file's
// other gate reads.
// "Does this call speak for this visit's customer at all?" — a settled call
// (no processing token still held), linked to the same customer the visit
// belongs to, from/to a number on that customer's file.
function callSpeaksForVisit({ call, visit, customer }) {
  if (!call || call.processing_token || !visit || call.customer_id !== visit.customer_id) return false;
  return callerIdentityMatches(call, customer);
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

function agreedWindowStart({ call, visit, customer }) {
  return callSpeaksForVisit({ call, visit, customer }) ? agentCommittedStart(call) : null;
}

// Gated on CAPTURE, not on alerting (codex P1 round 5). A trusted call
// commitment is the one promise class with no customer-facing text or email
// of its own — the applied-reschedule path deliberately sends nothing — so a
// call handled while the detector was dark leaves the PRE-MOVE reminder as
// the latest promise forever. Activate the detector afterwards and it alerts
// against a window the customer was already told had changed. Capture runs
// ahead of activation instead: it writes one visit_window_promised audit row,
// raises nothing, and sends nothing. GATE_NOSHOW_DETECTOR implies it.
const captureEnabled = () => gateEnvValue('GATE_NOSHOW_PROMISE_CAPTURE') || enabled();

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
function callCommitmentInstant(call) {
  const started = instant(call?.created_at);
  const seconds = Number(call?.recording_duration_seconds || call?.duration_seconds || 0);
  if (!Number.isFinite(started)) return new Date();
  return new Date(Number.isFinite(seconds) && seconds > 0 ? started + seconds * 1000 : started);
}

async function recordAgreedWindow(conn, { callId, visitId } = {}) {
  if (!captureEnabled() || !callId || !visitId) return false;
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['promised-call-window', `${callId}:${visitId}`]);
    const call = await trx('call_log').where({ id: callId, v2_extraction_status: 'valid' }).first();
    const visit = await trx('scheduled_services').where({ id: visitId }).first('customer_id');
    const customer = visit ? await trx('customers').where({ id: visit.customer_id }).first(...KNOWN_CALLER_PHONE_COLS) : null;
    const target = agreedWindowStart({ call, visit, customer });
    if (target == null) return false;
    const prior = await trx('audit_log').where({ action: 'visit_window_promised', resource_id: visitId })
      .whereRaw("metadata->>'call_log_id' = ?", [callId]).first('id');
    if (prior) return false;
    await recordAuditEvent({ actor_type: 'system', action: 'visit_window_promised', resource_type: 'scheduled_service', resource_id: visitId,
      metadata: { call_log_id: callId, start_at: new Date(target).toISOString(), communicated_at: callCommitmentInstant(call).toISOString() }, critical: true, trx });
    return true;
  });
}

// A series move notifies the customer with ONE text, and that text names
// only the anchor occurrence's new date — so the anchor gets ordinary
// message evidence (rendered_slot_ms), while every SIBLING the operation
// moved is left with whatever reminder it had for its OLD slot standing as
// its latest promise. Activated, the detector would then raise missing-
// tracking alerts against windows the customer was already told had changed
// (codex P1 round 5). Each moved sibling therefore gets an UNKNOWN-window
// promise row stamped at the send time: unknown is the honest record (the
// text did not quote that sibling's new slot), it outranks the stale
// reminder, and latestPromises + promisedStartAt read it as "no usable
// window" — no alert until that sibling's own new reminder communicates one.
// Dedupe is per (visit, series move), so a retried notification pass writes
// nothing new. Returns the number of rows written.
async function recordSeriesSupersession(conn, { visitIds = [], communicatedAt = new Date(), seriesMoveId = null, excludeVisitId = null } = {}) {
  if (!captureEnabled()) return 0;
  const at = new Date(communicatedAt);
  // seriesMoveId is REQUIRED, not optional: it is the identity a retried
  // notification pass dedupes against, and a timestamp fallback would be
  // unique per call — the dedupe could never match and every retry would
  // write another row (pre-push audit, round 5). admin-dispatch.js's own
  // recordCustomerNotified already skips its bookkeeping without one, so an
  // operation with no series move id is simply not a series move to record.
  if (!seriesMoveId || !Number.isFinite(at.getTime())) return 0;
  const skip = excludeVisitId == null ? null : String(excludeVisitId);
  const marker = String(seriesMoveId);
  let written = 0;
  for (const id of new Set(visitIds.map((visitId) => String(visitId)).filter((visitId) => visitId && visitId !== skip))) {
    // Same advisory-lock discipline as recordAgreedWindow: the check and the
    // write are one transaction keyed on (visit, series move), so two passes
    // racing — a retry overlapping the original, or a double-submitted series
    // move — cannot both read "no prior row" and both insert (pre-push audit,
    // round 5). audit_log has no unique constraint to lean on instead.
    const wrote = await conn.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['promised-series-supersession', `${id}:${marker}`]);
      const prior = await trx('audit_log').where({ action: 'visit_window_promised', resource_id: id })
        .whereRaw("metadata->>'series_supersession' = ?", [marker]).first('id');
      if (prior) return false;
      await recordAuditEvent({ actor_type: 'system', action: 'visit_window_promised', resource_type: 'scheduled_service', resource_id: id,
        metadata: { series_move_id: marker, series_supersession: marker, start_at: null, communicated_at: at.toISOString() }, critical: true, trx });
      return true;
    });
    if (wrote) written += 1;
  }
  return written;
}

async function listNoShows(conn, { now = new Date(), limit = 100, offset = 0, actorId = null, admin = true } = {}) {
  if (!enabled()) return [];
  const rows = await conn('scheduled_services as s').join('customers as c', 'c.id', 's.customer_id')
    .whereIn('s.status', LIVE_STATUSES)
    .whereBetween('s.scheduled_date', [etDateString(new Date(now.getTime() - 60 * 86400000)), etDateString(new Date(now.getTime() + 100 * 86400000))])
    .modify((q) => { if (!admin && actorId) q.where('s.technician_id', actorId); })
    .select('s.*', 'c.first_name', 'c.last_name', 'c.phone');
  const liveRows = rows.filter((r) => !require('./internal-test-customers').isInternalTestCustomerId(r.customer_id));
  const events = await loadPromiseEvents(conn, liveRows.map((r) => String(r.id)), { now });
  const promises = latestPromises(events, now);
  const cards = liveRows.map((r) => {
    const alert = evaluateNoShow({ visit: r, promise: promises.get(String(r.id)), now });
    return alert ? { id: r.id, customer_id: r.customer_id, technician_id: r.technician_id, first_name: r.first_name,
      last_name: r.last_name, phone: r.phone, scheduled_date: r.scheduled_date, ...alert } : null;
  }).filter(Boolean).sort((a, b) => b.stage - a.stage || instant(a.due_at) - instant(b.due_at) || a.id.localeCompare(b.id));
  return cards.slice(offset, offset + limit);
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
  for (const alert of legacy) await require('./dispatch-alerts').resolveAlert({ id: alert.id, trx });
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

async function sweep(conn, { now = new Date() } = {}) {
  if (!enabled()) return { alerted: 0 };
  const rows = await listNoShows(conn, { now, limit: 10000 });
  const dispatch = require('./dispatch-alerts');
  const techNotices = require('./tech-visit-notifications');
  let alerted = 0;
  for (const card of rows) {
    const notice = await conn.transaction(async (trx) => {
      const visit = await trx('scheduled_services').where({ id: card.id }).forUpdate().first();
      if (!enabled() || !visit) return null;
      const promise = latestPromises(await loadPromiseEvents(trx, [String(card.id)], { now }), now).get(String(card.id));
      const live = evaluateNoShow({ visit, promise, now });
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
    });
    // Deliver each committed notice before another row or cleanup can fail.
    if (notice) await techNotices.pushTrackingNotice(notice);
  }
  const active = await conn('dispatch_alerts').whereIn('type', dispatch.OVERDUE_ALERT_TYPES)
    .whereRaw("payload->>'source' = 'no_show_detector'").whereNull('resolved_at').select('id', 'job_id', 'payload');
  for (const alert of active) await conn.transaction(async (trx) => {
    if (!enabled()) return;
    const visit = await trx('scheduled_services').where({ id: alert.job_id }).forUpdate().first();
    const promise = latestPromises(await loadPromiseEvents(trx, [String(alert.job_id)], { now }), now).get(String(alert.job_id));
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
    const live = evaluateNoShow({ visit, promise, now, ignoreHorizon: true });
    if (!live || live.stage !== alert.payload.stage || live.promised_window.start_at !== alert.payload.promised_window?.start_at) {
      // Same automatic-supersession stamp as the per-card loop above (codex
      // P1) — this pass catches a visit that dropped out of `rows`
      // entirely (arrived, completed, cancelled); if it later re-enters
      // tracking under the exact same tracking_key, the `already` lookup
      // must not treat this row as a human resolution.
      await dispatch.resolveAlert({ id: alert.id, trx, auto: true });
    }
  });
  // Tech-side notices have no auto-resolve of their own (codex P1): a
  // stage-1-only notice never gets a dispatch_alerts row, and even a stage 2
  // that DOES only clears the office side above. Reconcile every unread/
  // undismissed tracking notice the same way — arrived, reassigned (the row
  // is scoped to the technician_id it was written for), or superseded by a
  // later stage (dedupeKey differs per stage, so the old stage-1 row would
  // otherwise sit next to the new stage-2 one forever) all dismiss it.
  const activeNotices = await conn('tech_notifications').where({ type: 'follow_through_tracking' })
    .whereNull('dismissed_at').select('id', 'technician_id', 'payload');
  for (const notice of activeNotices) await conn.transaction(async (trx) => {
    if (!enabled()) return;
    const visitId = notice.payload?.visit_id;
    const visit = visitId ? await trx('scheduled_services').where({ id: visitId }).forUpdate().first() : null;
    const promise = visit ? latestPromises(await loadPromiseEvents(trx, [String(visitId)], { now }), now).get(String(visitId)) : null;
    // ignoreHorizon: true for the same reason as the dispatch_alerts pass
    // above — elapsed time alone must not dismiss a notice for a visit
    // that is still live with no arrival evidence.
    const live = visit ? evaluateNoShow({ visit, promise, now, ignoreHorizon: true }) : null;
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
  });
  return { alerted, active: rows.length };
}

module.exports = { enabled, captureEnabled, evaluateNoShow, promisedStartAt, trackingStage, agreedWindowStart, callCommitmentInstant, LIVE_STATUSES, latestPromises, loadPromiseEvents, recordAgreedWindow, recordSeriesSupersession, listNoShows, sweep, trackingKey, resolveLegacyCollision, alreadyHasOpenAlert, callerIdentityMatches, noticeStillCurrent };
