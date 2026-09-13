'use strict';

const { gateEnvValue } = require('../config/feature-gates');
const { parseETDateTime } = require('../utils/datetime-et');
const { arrivalWindowRange } = require('../utils/sms-time-format');
const { lockTriageCall } = require('../utils/triage-locks');
const { recordAuditEvent } = require('./audit-log');
const { etWallClockOfConfirmedStart } = require('./call-triage-flags');
const { loadCandidates, humanHandledRescheduleCard, ACTIVITY_ACTION } = require('./call-reschedule-apply');

const enabled = () => gateEnvValue('GATE_RESCHEDULE_PROPOSAL_CARD');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const openStates = ['open', 'in_progress'];
const ADDRESS_COLUMNS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];
const PROPERTY_COLUMNS = ['id', ...ADDRESS_COLUMNS, 'updated_at'];

// Display only: keep the raw property identity untouched for the Apply guard.
function proposalAddress(visit, customer) {
  const source = visit.property || (visit.service_address_line1 ? {
    address_line1: visit.service_address_line1, address_line2: visit.service_address_line2,
    city: visit.service_address_city, state: visit.service_address_state, zip: visit.service_address_zip,
  } : customer);
  if (!String(source?.address_line1 || '').trim()) return null;
  return Object.fromEntries(ADDRESS_COLUMNS.map((field) => [field, source[field] || null]));
}

function proposalEvidence(v2, transcript) {
  const quotes = (v2?.evidence || []).filter((e) => e.field_path === '/scheduling/proposed_start_at' && e.speaker === 'caller');
  const turns = String(transcript || '').split('\n').map((line) => line.match(/^\s*(caller|customer)\s*:\s*(.*)$/i))
    .filter(Boolean).map((m) => norm(m[2]));
  // No speaker labels means review the transcript in the existing triage
  // inbox; a model's claimed speaker alone must not mint an Apply button.
  return quotes.find((e) => norm(e.quote).length >= 8 && turns.some((t) => t.includes(norm(e.quote))))?.quote || null;
}

function customerWindow(date, start) {
  if (!date || !start) return null;
  const day = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  const range = arrivalWindowRange(start);
  const match = range?.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (!match) return null;
  const startMinutes = Number(match[1].slice(0, 2)) * 60 + Number(match[1].slice(3));
  const endMinutes = Number(match[2].slice(0, 2)) * 60 + Number(match[2].slice(3));
  const [year, month, dateOfMonth] = day.split('-').map(Number);
  const endDay = endMinutes <= startMinutes
    ? new Date(Date.UTC(year, month - 1, dateOfMonth + 1)).toISOString().slice(0, 10) : day;
  const startAt = parseETDateTime(`${day}T${match[1]}`);
  const endAt = parseETDateTime(`${endDay}T${match[2]}`);
  if (!startAt || !endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null;
  return { start_at: startAt.toISOString(), end_at: endAt.toISOString() };
}

async function stageProposal(conn, { callId, procGeneration = null, now = new Date() } = {}) {
  if (!enabled() || !callId) return { staged: false };
  return conn.transaction(async (trx) => {
    await lockTriageCall(trx, callId);
    const call = await trx('call_log').where({ id: callId }).forUpdate().first();
    if (!enabled() || !call || call.processing_token
      || (procGeneration != null && Number(call.processing_generation) !== Number(procGeneration))) return { staged: false };
    const retire = async () => {
      const card = await trx('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_or_cancel', status: 'open' })
        .whereNull('assigned_to').whereRaw("payload->'reschedule_proposal' IS NOT NULL").forUpdate().first('id', 'payload');
      if (card) {
        const payload = typeof card.payload === 'string' ? JSON.parse(card.payload) : { ...(card.payload || {}) };
        delete payload.reschedule_proposal;
        await trx('triage_items').where({ id: card.id }).update({ payload, updated_at: new Date() });
      }
      return { staged: false };
    };
    if (!call.customer_id || call.v2_extraction_status !== 'valid') return retire();
    const v2 = call.ai_extraction_enriched;
    if (v2?.meta?.is_spam || v2?.meta?.is_voicemail || v2?.scheduling?.status !== 'reschedule_requested'
      || v2.scheduling.agent_committed_booking === true || v2.scheduling.confirmed_start_at) return retire();
    const proposed = v2.scheduling.proposed_start_at;
    const quote = proposalEvidence(v2, call.transcription);
    const requestedAt = new Date(proposed);
    if (!proposed || !Number.isFinite(requestedAt.getTime()) || requestedAt.getTime() <= now.getTime() || !quote) return retire();
    const handled = await trx('activity_log').where({ action: ACTIVITY_ACTION })
      .whereRaw("metadata->>'call_log_id' = ?", [callId]).first('id');
    if (handled) return { staged: false };
    if (await humanHandledRescheduleCard(trx, callId)) return retire();
    const proposal = { version: 1, proposed_start_at: proposed, quote,
      call_generation: call.processing_generation, staged_at: now.toISOString() };
    let card = await trx('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_or_cancel' })
      .whereIn('status', openStates).forUpdate().first();
    if (card) {
      const previous = card.payload?.reschedule_proposal;
      if (previous?.proposed_start_at === proposed && previous?.quote === quote
        && Number(previous.call_generation) === Number(call.processing_generation)) return { staged: true, id: card.id };
      await trx('triage_items').where({ id: card.id }).update({ payload: { ...card.payload, reschedule_proposal: proposal }, updated_at: new Date() });
    } else {
      [card] = await trx('triage_items').insert({ call_log_id: callId, related_customer_id: call.customer_id,
        category: 'time_ambiguous', severity: 'advisory', reason_code: 'reschedule_or_cancel', status: 'open',
        summary: 'The caller requested a new appointment time.', payload: { reschedule_proposal: proposal } }).returning('id');
    }
    await trx('call_log').where({ id: callId }).update({ review_status: 'open', updated_at: new Date() });
    await recordAuditEvent({ actor_type: 'system', action: 'reschedule_proposal_staged', resource_type: 'triage_item',
      resource_id: card.id, metadata: { call_log_id: callId, processing_generation: call.processing_generation }, critical: true, trx });
    return { staged: true, id: card.id };
  });
}

async function visitsForCard(conn, customerId, now) {
  const rows = await loadCandidates(conn, customerId, now, { includePast: true });
  const serviceIds = [...new Set(rows.map((r) => r.service_id).filter(Boolean))];
  const propertyIds = [...new Set(rows.map((r) => r.property_id).filter(Boolean))];
  const [services, properties] = await Promise.all([
    serviceIds.length ? conn('services').whereIn('id', serviceIds).select('id', 'name') : [],
    propertyIds.length ? conn('customer_properties').where({ customer_id: customerId, active: true }).whereIn('id', propertyIds).select(PROPERTY_COLUMNS) : [],
  ]);
  return rows.map((r) => ({ ...r, service_name: services.find((s) => s.id === r.service_id)?.name || 'Service',
    property: properties.find((p) => p.id === r.property_id) || null, current_window: customerWindow(r.scheduled_date, r.window_start) }));
}

async function listProposals(conn, { limit = 100, offset = 0, now = new Date() } = {}) {
  if (!enabled()) return [];
  const rows = await conn('triage_items as t').join('call_log as cl', 'cl.id', 't.call_log_id')
    .join('customers as c', 'c.id', 'cl.customer_id').whereNull('c.deleted_at').whereIn('t.status', openStates)
    .whereRaw("t.payload->'reschedule_proposal' IS NOT NULL").orderBy('t.created_at', 'asc').orderBy('t.id').limit(limit).offset(offset)
    .select('t.id', 't.call_log_id', 't.updated_at', 't.payload', 'cl.customer_id', 'cl.created_at as call_at',
      'c.first_name', 'c.last_name', 'c.phone', ...ADDRESS_COLUMNS.map((field) => `c.${field}`));
  for (const row of rows) {
    row.card_kind = 'reschedule_proposal';
    row.proposal = row.payload.reschedule_proposal;
    row.skip_reason = row.payload.reschedule_apply?.skipped || 'agent_did_not_commit';
    delete row.payload;
    row.candidates = await visitsForCard(conn, row.customer_id, now);
    const requested = etWallClockOfConfirmedStart(row.proposal.proposed_start_at);
    row.matched_visit_id = row.candidates.length === 1 ? row.candidates[0].id : null;
    row.requested_window = requested ? customerWindow(requested.slice(0, 10), requested.slice(11, 16)) : null;
    // Preserve appointment internals on the server; the card needs only the
    // identity and customer-facing window for choosing the discussed visit.
    row.candidates = row.candidates.map((visit) => {
      const { id, status, scheduled_date, current_window, service_name, property } = visit;
      return { id, status, scheduled_date, current_window, service_name, property, display_address: proposalAddress(visit, row) };
    });
    for (const field of ADDRESS_COLUMNS) delete row[field];
  }
  return rows;
}

async function dismissProposal(conn, id, { actorId, expectedAt } = {}) {
  if (!enabled()) throw fail('Reschedule proposals are disabled');
  const card = await conn('triage_items').where({ id }).first('call_log_id');
  if (!card) throw fail('Proposal not found', 404);
  return conn.transaction(async (trx) => {
    await lockTriageCall(trx, card.call_log_id);
    const live = await trx('triage_items').where({ id }).forUpdate().first();
    if (!enabled() || !live?.payload?.reschedule_proposal || !openStates.includes(live.status)
      || !expectedAt || new Date(live.updated_at).getTime() !== new Date(expectedAt).getTime()) throw fail('The proposal changed. Refresh before dismissing.');
    await trx('triage_items').where({ id }).update({ status: 'dismissed', resolution_source: 'human', assigned_to: actorId,
      resolution_note: 'Dismissed by staff.', resolved_at: new Date(), updated_at: new Date() });
    const remaining = await trx('triage_items').where({ call_log_id: card.call_log_id }).whereIn('status', openStates).first('id');
    await trx('call_log').where({ id: card.call_log_id }).update({ review_status: remaining ? 'open' : 'dismissed', updated_at: new Date() });
    await recordAuditEvent({ actor_type: 'technician', actor_id: actorId, action: 'reschedule_proposal_dismissed',
      resource_type: 'triage_item', resource_id: id, critical: true, trx });
    return { dismissed: true };
  });
}

module.exports = { enabled, proposalAddress, proposalEvidence, customerWindow, stageProposal, listProposals, dismissProposal };
