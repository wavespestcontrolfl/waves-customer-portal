'use strict';

const { gateEnvValue } = require('../config/feature-gates');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { recordAuditEvent } = require('./audit-log');
const { phoneMatchDigits } = require('../utils/phone');
const { ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');

const enabled = () => gateEnvValue('GATE_NOSHOW_DETECTOR');
const LIVE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];
const NOTICE_PURPOSES = ['appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h'];
const instant = (value) => value == null ? NaN : new Date(value).getTime();

// Pure, also used by the replay. All evidence must exist by the evaluation
// time; a later arrival cannot erase an earlier useful warning in a replay.
function evaluateNoShow({ visit, promise, now = new Date(), stage1Minutes = 45 } = {}) {
  if (!visit || !LIVE_STATUSES.includes(visit.status) || !promise) return null;
  const start = instant(promise.start_at);
  const known = instant(promise.communicated_at);
  const nowMs = instant(now);
  if (!Number.isFinite(start) || !Number.isFinite(known) || known > nowMs || nowMs < start
    || nowMs > start + 48 * 3600000) return null;
  const dayStart = parseETDateTime(`${etDateString(new Date(start))}T00:00`).getTime();
  const observed = (stamp) => Number.isFinite(instant(stamp)) && instant(stamp) >= dayStart && instant(stamp) <= nowMs;
  const arrived = ['arrived_at', 'actual_start_time', 'check_in_time'].some((key) => observed(visit[key]));
  if (arrived || visit.status === 'on_site') return null;
  const departed = observed(visit.en_route_at);
  const stage = nowMs >= start + 150 * 60000 ? 2 : (!departed && nowMs >= start + stage1Minutes * 60000 ? 1 : null);
  if (!stage) return null;
  return { stage, evidence: 'missing_tracking', promised_window: { start_at: new Date(start).toISOString(), end_at: new Date(start + ARRIVAL_WINDOW_MINUTES * 60000).toISOString() },
    message: stage === 2
      ? (departed ? 'En Route was recorded, but no arrival is recorded after the promised window.' : 'The promised window ended over 30 minutes ago; no arrival is recorded.')
      : 'No departure or arrival is recorded for this window yet.',
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
  const since = new Date(now.getTime() - 100 * 86400000);
  const reads = [
    () => conn('messaging_audit_log as a').leftJoin('sms_log as s', 's.twilio_sid', 'a.provider_message_id')
      .whereIn('a.appointment_id', visitIds)
      // Generic appointment texts also include links and preparation tips;
      // only a scheduling notice can replace the customer's promised window.
      // Legacy move notices without a saved time still count as unknown.
      .whereRaw(`(a.purpose = ANY(?::text[]) OR (a.purpose = 'appointment' AND
        (a.metadata->>'rendered_slot_ms' IS NOT NULL OR a.metadata->>'original_message_type' LIKE 'rain_out_moved%')))`, [NOTICE_PURPOSES])
      .whereBetween('a.sent_at', [since, now]).whereNull('a.blocked_code').whereNull('a.provider_error')
      .where(function delivered() { this.where('a.provider', 'push').orWhereIn('s.status', ['sent', 'delivered', 'read']); })
      .select('a.id', 'a.appointment_id', 'a.metadata', 'a.sent_at'),
    () => conn('customer_interactions').where('interaction_type', 'email_outbound').whereBetween('created_at', [since, now])
      .whereRaw("metadata->>'scheduled_service_id' = ANY(?::text[])", [visitIds])
      .whereRaw("metadata->>'status' IN ('sent','delivered')")
      .whereRaw("metadata->>'event_type' IN ('appointment.confirmation','appointment.reminder_72h','appointment.reminder_24h','appointment.rescheduled')")
      .select('id', 'metadata', 'created_at'),
    () => conn('audit_log').where({ action: 'visit_window_promised', resource_type: 'scheduled_service' })
      .whereIn('resource_id', visitIds).whereBetween('created_at', [since, now]).select('id', 'resource_id', 'metadata', 'created_at'),
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

async function recordAgreedWindow(conn, { callId, visitId } = {}) {
  if (!enabled() || !callId || !visitId) return false;
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['promised-call-window', `${callId}:${visitId}`]);
    const call = await trx('call_log').where({ id: callId, v2_extraction_status: 'valid' }).first();
    const visit = await trx('scheduled_services').where({ id: visitId }).first('customer_id');
    const customer = visit ? await trx('customers').where({ id: visit.customer_id }).first('phone') : null;
    const v2 = call?.ai_extraction_enriched;
    const target = v2?.scheduling?.confirmed_start_at;
    if (!call || call.processing_token || !visit || call.customer_id !== visit.customer_id
      || !phoneMatchDigits(customer?.phone).some((key) => phoneMatchDigits(call.direction === 'outbound' ? call.to_phone : call.from_phone).includes(key))
      || v2?.meta?.is_spam || v2?.meta?.is_voicemail || v2?.scheduling?.agent_committed_booking !== true || !Number.isFinite(instant(target))) return false;
    // Mirrors canAutoRoute's own trusted-speaker guard (call-triage-flags.js
    // ~L1162-1181): the Agent:/Caller: transcript labels hasAgentCommitted
    // Evidence grounds against are themselves LLM-inferred, so a swapped
    // label could let a caller-spoken slot pass as an agent commitment.
    // Require the same deterministic-labels opt this claim class demands
    // everywhere else before writing it as a promised-window audit row
    // (codex P1 af4925f71) — read live, not the module-load `gates` snapshot,
    // matching this file's other gate reads.
    if (!gateEnvValue('GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS')
      || !require('./call-triage-flags').hasAgentCommittedEvidence(v2, call.transcription, call.created_at)) return false;
    const prior = await trx('audit_log').where({ action: 'visit_window_promised', resource_id: visitId })
      .whereRaw("metadata->>'call_log_id' = ?", [callId]).first('id');
    if (prior) return false;
    await recordAuditEvent({ actor_type: 'system', action: 'visit_window_promised', resource_type: 'scheduled_service', resource_id: visitId,
      metadata: { call_log_id: callId, start_at: new Date(target).toISOString(), communicated_at: new Date(call.created_at).toISOString() }, critical: true, trx });
    return true;
  });
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
      const key = `tracking:${card.id}:${live.promised_window.start_at}:${live.stage}:${type}`;
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
        stage: live.stage, dedupeKey: `${key}:${recipient}`, message: live.message,
        payload: { ...live, visit_id: card.id, customer_name: customerName, when } });
      const office = live.stage === 2 || !recipient;
      // Only alerts THIS detector created (matches clearTrackingBells in
      // dispatch-alerts.js) — a pre-existing tech_late/unassigned_overdue
      // row from the legacy overdue detectors, or any other future source
      // of that type, must never be auto-resolved as a side effect of a
      // tracking-key mismatch it was never party to (codex P1).
      const existing = await trx('dispatch_alerts').where({ job_id: card.id }).whereIn('type', dispatch.OVERDUE_ALERT_TYPES)
        .whereNull('resolved_at').whereRaw("payload->>'source' = 'no_show_detector'");
      for (const alert of existing) {
        if (!office || alert.payload?.tracking_key !== key) await dispatch.resolveAlert({ id: alert.id, trx });
      }
      let created = false;
      if (office) {
        const already = await trx('dispatch_alerts').where({ job_id: card.id, type }).whereRaw("payload->>'tracking_key' = ?", [key]).first('id');
        if (!already) {
          const result = await dispatch.createAlertOnce({ type, severity: live.stage === 2 ? 'critical' : 'warn',
            techId: recipient, jobId: card.id, trx, payload: { source: 'no_show_detector', tracking_key: key, ...live,
              scheduled_date: visit.scheduled_date, window_start: visit.window_start, window_end: visit.window_end,
              ...trackingIdentityFields(recipientTech, card) } });
          created = result.created;
          if (created) await require('./notification-service').notifyAdmin('alert', 'A promised arrival needs attention', live.message, {
            // The tracking card lives on the dispatch Action Queue (this
            // office alert is a tech_late/unassigned_overdue dispatch_alerts
            // row), not Communications -> Owed — that tab loads only
            // /admin/call-recordings/commitments/open, which never includes
            // this alert type (codex P1 af4925f71).
            dedupeKey: `dispatch-alert:${result.row.id}`, trx, link: '/admin/dispatch', bell: true,
            metadata: { dispatch_alert_id: result.row.id, scheduled_service_id: card.id, stage: live.stage },
          });
        }
      }
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
    const live = evaluateNoShow({ visit, promise, now });
    if (!live || live.stage !== alert.payload.stage || live.promised_window.start_at !== alert.payload.promised_window?.start_at) {
      await dispatch.resolveAlert({ id: alert.id, trx });
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
    const live = visit ? evaluateNoShow({ visit, promise, now }) : null;
    const stillCurrent = live && visit.technician_id === notice.technician_id
      && live.stage === notice.payload?.stage && live.promised_window.start_at === notice.payload?.promised_window?.start_at;
    if (!stillCurrent) {
      await trx('tech_notifications').where({ id: notice.id }).whereNull('dismissed_at')
        .update({ dismissed_at: new Date(), read: true, updated_at: new Date() });
    }
  });
  return { alerted, active: rows.length };
}

module.exports = { enabled, evaluateNoShow, latestPromises, loadPromiseEvents, recordAgreedWindow, listNoShows, sweep };
