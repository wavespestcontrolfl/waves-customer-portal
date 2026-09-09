'use strict';

const { gateEnvValue } = require('../config/feature-gates');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { recordAuditEvent } = require('./audit-log');
const { phoneMatchDigits } = require('../utils/phone');

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
  return { stage, evidence: 'missing_tracking', promised_window: { start_at: new Date(start).toISOString(), end_at: new Date(start + 120 * 60000).toISOString() },
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
    if (!require('./call-triage-flags').hasAgentCommittedEvidence(v2, call.transcription, call.created_at)) return false;
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
  const events = await loadPromiseEvents(conn, rows.map((r) => String(r.id)), { now });
  const promises = latestPromises(events, now);
  const cards = rows.map((r) => {
    const alert = evaluateNoShow({ visit: r, promise: promises.get(String(r.id)), now });
    return alert ? { id: r.id, customer_id: r.customer_id, technician_id: r.technician_id, first_name: r.first_name,
      last_name: r.last_name, phone: r.phone, scheduled_date: r.scheduled_date, ...alert } : null;
  }).filter(Boolean).sort((a, b) => b.stage - a.stage || instant(a.due_at) - instant(b.due_at) || a.id.localeCompare(b.id));
  return cards.slice(offset, offset + limit);
}

async function sweep(conn, { now = new Date() } = {}) {
  if (!enabled()) return { alerted: 0 };
  const rows = await listNoShows(conn, { now, limit: 10000 });
  let alerted = 0;
  const pushes = [];
  for (const card of rows) {
    await conn.transaction(async (trx) => {
      const visit = await trx('scheduled_services').where({ id: card.id }).forShare().first();
      if (!enabled() || !visit) return;
      const promise = latestPromises(await loadPromiseEvents(trx, [String(card.id)], { now }), now).get(String(card.id));
      const live = evaluateNoShow({ visit, promise, now });
      if (!live || live.stage !== card.stage || live.promised_window.start_at !== card.promised_window.start_at) return;
      const recipient = visit.technician_id || (await trx('technicians').where({ employment_status: 'active', field_dispatchable: true }).orderBy('created_at').first('id'))?.id;
      const key = `tracking:${card.id}:${live.promised_window.start_at}:${live.stage}`;
      const notice = await require('./tech-visit-notifications').recordTrackingNotice(trx, { visitId: card.id, technicianId: recipient,
        stage: live.stage, dedupeKey: `${key}:${recipient}`, message: live.message, payload: { ...live, visit_id: card.id } });
      let adminNotice = null;
      if (live.stage === 2) adminNotice = await require('./notification-service').notifyAdmin('alert', 'A promised arrival needs attention', live.message, {
        dedupeKey: key, trx, link: '/admin/communications#tab=owed', bell: true,
        metadata: { triggerKey: 'no_show_detector', scheduled_service_id: card.id, stage: live.stage, promise_start_at: live.promised_window.start_at },
      });
      if (notice || (adminNotice?.id && !adminNotice.deduped)) {
        await recordAuditEvent({ actor_type: 'system', action: 'missing_tracking_alerted', resource_type: 'scheduled_service', resource_id: card.id,
          metadata: { stage: live.stage, promise_start_at: live.promised_window.start_at, evidence: live.evidence }, critical: true, trx });
        alerted += 1;
      }
      if (notice) pushes.push(notice);
    });
  }
  // Clear obsolete bells automatically. No extra admin acknowledgement is
  // needed after an arrival, completion, cancellation, or communicated move.
  await conn('notifications').whereRaw("metadata->>'triggerKey' = 'no_show_detector'").whereNull('read_at')
    .modify((q) => {
      const keys = rows.filter((r) => r.stage === 2).map((r) => `tracking:${r.id}:${r.promised_window.start_at}:2`);
      if (keys.length) q.whereRaw("NOT (metadata->>'dedupeKey' = ANY(?::text[]))", [keys]);
    })
    .update({ read_at: now });
  for (const notice of pushes) await require('./tech-visit-notifications').pushTrackingNotice(notice);
  return { alerted, active: rows.length };
}

module.exports = { enabled, evaluateNoShow, latestPromises, loadPromiseEvents, recordAgreedWindow, listNoShows, sweep };
