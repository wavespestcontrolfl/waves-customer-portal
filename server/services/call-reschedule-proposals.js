'use strict';

const crypto = require('crypto');
const { gateEnvValue } = require('../config/feature-gates');
const { parseETDateTime } = require('../utils/datetime-et');
const { lockTriageCall } = require('../utils/triage-locks');
const { recordAuditEvent } = require('./audit-log');
const { loadCandidates, planRescheduleFromCall, applyReviewedCallReschedule, ACTIVITY_ACTION } = require('./call-reschedule-apply');

const enabled = () => gateEnvValue('GATE_RESCHEDULE_PROPOSAL_CARD');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const openStates = ['open', 'in_progress'];
const CUSTOMER_COLUMNS = ['id', 'first_name', 'last_name', 'phone', 'secondary_phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone', 'address_line1', 'address_line2', 'city', 'state', 'zip'];
const PROPERTY_COLUMNS = ['id', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'updated_at'];

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
  const at = parseETDateTime(`${day}T${String(start).slice(0, 5)}`);
  if (!at || Number.isNaN(at.getTime())) return null;
  return { start_at: at.toISOString(), end_at: new Date(at.getTime() + 120 * 60000).toISOString() };
}

async function stageProposal(conn, { callId, procGeneration = null } = {}) {
  if (!enabled() || !callId) return { staged: false };
  return conn.transaction(async (trx) => {
    await lockTriageCall(trx, callId);
    const call = await trx('call_log').where({ id: callId }).forUpdate().first();
    if (!enabled() || !call?.customer_id || call.processing_token || call.v2_extraction_status !== 'valid'
      || (procGeneration != null && Number(call.processing_generation) !== Number(procGeneration))) return { staged: false };
    const v2 = call.ai_extraction_enriched;
    if (v2?.meta?.is_spam || v2?.meta?.is_voicemail || v2?.scheduling?.status !== 'reschedule_requested') return { staged: false };
    const proposed = v2.scheduling.proposed_start_at;
    const quote = proposalEvidence(v2, call.transcription);
    if (!proposed || !Number.isFinite(new Date(proposed).getTime()) || !quote) return { staged: false };
    const handled = await trx('activity_log').where({ action: ACTIVITY_ACTION })
      .whereRaw("metadata->>'call_log_id' = ?", [callId]).first('id');
    if (handled) return { staged: false };
    const priorHuman = await trx('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_or_cancel', resolution_source: 'human' })
      .whereIn('status', ['resolved', 'dismissed']).first('id');
    if (priorHuman) return { staged: false };
    const proposal = { version: 1, proposed_start_at: proposed, quote,
      call_generation: call.processing_generation, staged_at: new Date().toISOString() };
    let card = await trx('triage_items').where({ call_log_id: callId, reason_code: 'reschedule_or_cancel' })
      .whereIn('status', openStates).forUpdate().first();
    if (card?.status === 'in_progress') return { staged: false, reason: 'claimed_by_staff' };
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
    .leftJoin('customers as c', 'c.id', 'cl.customer_id').whereIn('t.status', openStates)
    .whereRaw("t.payload->'reschedule_proposal' IS NOT NULL").orderBy('t.created_at', 'asc').orderBy('t.id').limit(limit).offset(offset)
    .select('t.id', 't.call_log_id', 't.updated_at', 't.payload', 'cl.customer_id', 'cl.created_at as call_at',
      'c.first_name', 'c.last_name', 'c.phone');
  for (const row of rows) {
    row.card_kind = 'reschedule_proposal';
    row.proposal = row.payload.reschedule_proposal;
    row.skip_reason = row.payload.reschedule_apply?.skipped || 'agent_did_not_commit';
    delete row.payload;
    row.candidates = await visitsForCard(conn, row.customer_id, now);
    const requested = new Date(row.proposal.proposed_start_at);
    row.matched_visit_id = row.candidates.length === 1 ? row.candidates[0].id : null;
    row.requested_window = { start_at: requested.toISOString(), end_at: new Date(requested.getTime() + 120 * 60000).toISOString() };
    // Preserve appointment internals on the server; the card needs only the
    // identity and customer-facing window for choosing the discussed visit.
    row.candidates = row.candidates.map(({ id, status, scheduled_date, current_window, service_name, property }) =>
      ({ id, status, scheduled_date, current_window, service_name, property }));
  }
  return rows;
}

async function previewProposal(conn, id, { visitId, now = new Date(), rebooker = null } = {}) {
  if (!enabled()) throw fail('Reschedule proposals are disabled');
  const card = await conn('triage_items').where({ id }).whereIn('status', openStates).first();
  if (!card?.payload?.reschedule_proposal) throw fail('Proposal is no longer open', 404);
  const call = await conn('call_log').where({ id: card.call_log_id }).first();
  if (!call?.customer_id || call.processing_token || call.v2_extraction_status !== 'valid'
    || Number(call.processing_generation) !== Number(card.payload.reschedule_proposal.call_generation)) {
    throw fail('The call changed. Refresh the proposal.');
  }
  const customer = await conn('customers').where({ id: call.customer_id }).first(CUSTOMER_COLUMNS);
  const candidates = await visitsForCard(conn, customer?.id, now);
  const selection = visitId || (candidates.length === 1 ? candidates[0].id : null);
  if (!selection) throw fail('Select the appointment discussed on the call', 400);
  const reviewedVisit = candidates.find((v) => v.id === selection);
  if (reviewedVisit?.property_id && !reviewedVisit.property) throw fail('The appointment property needs review. Use the schedule editor.');
  if (reviewedVisit) reviewedVisit.follow_through_group_eligible = await require('./reschedule-link').hasUnblockedVisitGroup(conn, reviewedVisit.visit_id);
  const v2 = call.ai_extraction_enriched;
  if (!proposalEvidence(v2, call.transcription) || v2.scheduling.proposed_start_at !== card.payload.reschedule_proposal.proposed_start_at) {
    throw fail('The request evidence changed. Review the call.');
  }
  const plan = planRescheduleFromCall({ v2, call, customer, candidates, now, humanOverride: { visitId: selection } });
  if (plan.action === 'skip') throw fail(`This request needs the schedule editor: ${plan.reason.replace(/_/g, ' ')}`);
  const mover = rebooker || require('./rebooker');
  const series = mover.collectiveMoveGateOn()
    ? await mover.previewSeriesMove(selection, plan.newDate, { start: plan.newWindow.start }) : { collective: false };
  const selected = candidates.find((v) => v.id === selection);
  const followUps = await require('./call-booking-catalog').planCallFollowUpShift({ conn, parentServiceId: selection,
    fromDate: selected.scheduled_date, toDate: plan.newDate });
  if (followUps.length) throw fail('This visit has a linked follow-up. Use Pick another time to review both appointments together.');
  const snapshot = { source: digest([call.transcription, v2]), customer, property: selected.property, card_id: card.id, updated_at: new Date(card.updated_at).toISOString(), generation: call.processing_generation,
    visit_id: selection, from: { date: selected.scheduled_date, start: selected.window_start, end: selected.window_end,
      duration: selected.estimated_duration_minutes, status: selected.status, property_id: selected.property_id,
      service_id: selected.service_id, service_type: selected.service_type, service_name: selected.service_name,
      visit_id: selected.visit_id, is_recurring: selected.is_recurring, source_action: selected.source_action,
      customer_confirmed: selected.customer_confirmed, self_booking_id: selected.self_booking_id,
      service_address_line1: selected.service_address_line1, service_address_line2: selected.service_address_line2,
      service_address_city: selected.service_address_city, service_address_zip: selected.service_address_zip },
    target: v2.scheduling.proposed_start_at, series };
  return { preview_hash: digest(snapshot), card, call, customer, candidates, v2, plan, selected, series };
}

async function applyProposal(conn, id, { actorId, visitId, previewHash, now = new Date(), rebooker = null } = {}) {
  if (!previewHash) throw fail('Preview the requested move first', 400);
  const preview = await previewProposal(conn, id, { visitId, now, rebooker });
  if (preview.preview_hash !== previewHash) throw fail('The appointment or recurring plan changed. Refresh the preview.');
  const { call, card, customer, candidates, v2, series, selected } = preview;
  return applyReviewedCallReschedule({ conn, call, customer, candidates, v2, visitId: selected.id, actorId, now, rebooker,
    operationKey: `proposal:${id}:${previewHash}`,
    occurrenceIds: series.occurrenceIds || [], occurrences: series.occurrences, guard: async (trx) => {
      if (!enabled()) throw fail('Reschedule proposals are disabled');
      const followUps = await require('./call-booking-catalog').planCallFollowUpShift({ conn: trx, parentServiceId: selected.id,
        fromDate: selected.scheduled_date, toDate: preview.plan.newDate });
      if (followUps.length) throw fail('A linked follow-up appeared. Review both appointments from the schedule.');
      await lockTriageCall(trx, call.id);
      const liveCall = await trx('call_log').where({ id: call.id }).forUpdate().first();
      const liveCard = await trx('triage_items').where({ id }).forUpdate().first();
      const staff = await trx('technicians').where({ id: actorId, employment_status: 'active' }).first('id');
      const liveCustomer = await trx('customers').where({ id: customer.id }).forShare().first(CUSTOMER_COLUMNS);
      const liveProperty = selected.property ? await trx('customer_properties').where({ id: selected.property.id, customer_id: customer.id, active: true }).forShare().first(PROPERTY_COLUMNS) : null;
      if (!staff) throw fail('Active staff account required', 403);
      if (!liveCard || !openStates.includes(liveCard.status) || new Date(liveCard.updated_at).getTime() !== new Date(card.updated_at).getTime()
        || !liveCall || liveCall.processing_token || liveCall.v2_extraction_status !== 'valid' || liveCall.customer_id !== customer.id
        || digest(liveCustomer) !== digest(customer) || digest(liveProperty) !== digest(selected.property)
        || digest([liveCall.transcription, liveCall.ai_extraction_enriched]) !== digest([call.transcription, v2])
        || Number(liveCall.processing_generation) !== Number(call.processing_generation)) throw fail('The proposal changed. Refresh before applying.');
      await trx('triage_items').where({ id }).update({ status: 'resolved', resolution_source: 'human', assigned_to: actorId,
        resolution_note: 'Requested time applied. Normal appointment reminders continue.', resolved_at: now, updated_at: now,
        related_scheduled_service_id: selected.id });
      const remaining = await trx('triage_items').where({ call_log_id: call.id }).whereIn('status', openStates).first('id');
      await trx('call_log').where({ id: call.id }).update({ review_status: remaining ? 'open' : 'resolved', updated_at: now });
      await recordAuditEvent({ actor_type: 'technician', actor_id: actorId, action: 'reschedule_proposal_applied',
        resource_type: 'triage_item', resource_id: id, metadata: { call_log_id: call.id, scheduled_service_id: selected.id,
          occurrence_ids: series.occurrenceIds || [selected.id], preview_hash: previewHash }, critical: true, trx });
    } });
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

module.exports = { enabled, proposalEvidence, customerWindow, stageProposal, listProposals, previewProposal, applyProposal, dismissProposal };
