'use strict';

const db = require('../models/db');
const { gateEnvValue, gateEnvTimestamp } = require('../config/feature-gates');
const { hashExtractionSource } = require('./data-hygiene/source-extraction-store');
const { recordAuditEvent } = require('./audit-log');
const { addressKey, ensurePrimaryProperty, completePrimaryFromCall, recordCallProperty, OCCUPANCY_TYPES } = require('./customer-properties');
const { phoneMatchDigits } = require('../utils/phone');
const { scrubPans } = require('../utils/pan-scrub');

const REASON = 'property_role_confirm';
const OPEN = ['open', 'in_progress'];
const enabled = () => gateEnvValue('GATE_SMS_OPERATIONAL_ACTIONS')
  && gateEnvValue('GATE_SMS_ADDITIONAL_PROPERTY') && gateEnvValue('GATE_CUSTOMER_PROPERTIES');
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { status }); };
const sourceHash = (message) => hashExtractionSource(JSON.stringify([
  message.id, message.customer_id, message.direction, message.from_phone, message.to_phone,
  message.message_body, new Date(message.created_at).toISOString(),
]));

async function primarySender(conn, message) {
  const phones = phoneMatchDigits(message?.from_phone);
  if (message?.direction !== 'inbound' || !phones.length) return false;
  const matches = await conn('customers').whereNull('deleted_at')
    .whereIn(conn.raw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')"), phones)
    .limit(2).select('id');
  return matches.length === 1 && matches[0].id === message.customer_id;
}

// Called under the existing SMS writer's customer → SMS row locks. The
// dedicated replay acquires the same locks and invokes only this lane.
async function stageAdditionalProperties({ trx, message, proposals, targetedReplay = false }) {
  if (!enabled() || !proposals?.length) return { skipped: 'gate_off_or_empty' };
  const since = gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE');
  if (!since || (!targetedReplay && new Date(message.created_at) < since)) return { skipped: 'outside_activation_window' };
  const existingCard = await trx('triage_items').where({ sms_log_id: message.id, reason_code: REASON }).first();
  if (existingCard) return { preserved: true, id: existingCard.id };
  const senderRequiresReview = !(await primarySender(trx, message));
  const existing = await trx('customer_properties').where({ customer_id: message.customer_id }).select('*');
  const fresh = proposals.filter((proposal) => !existing.some((property) => addressKey(property) === addressKey(proposal)));
  if (!fresh.length) return { skipped: 'already_recorded' };
  const [card] = await trx('triage_items').insert({ sms_log_id: message.id, call_log_id: null,
    category: 'customer', severity: 'advisory', reason_code: REASON, status: 'open',
    summary: `${fresh.length} additional service ${fresh.length === 1 ? 'address' : 'addresses'} mentioned by text`,
    payload: { customer_id: message.customer_id, additional_property_proposals: fresh, sender_requires_review: senderRequiresReview,
      source_hash: sourceHash(message), sms_text: scrubPans(message.message_body),
      sms_created_at: message.created_at, extractor_version: require('./sms-operational-extractor').VERSION },
  }).returning('id');
  await recordAuditEvent({ trx, critical: true, actor_type: 'system', action: 'sms.additional_properties.proposed',
    resource_type: 'triage_item', resource_id: card.id,
    metadata: { sms_log_id: message.id, customer_id: message.customer_id, count: fresh.length, targeted_replay: targetedReplay } });
  return { proposed: fresh.length, id: card.id };
}

function reviewedAddresses(proposals, input) {
  if (!Array.isArray(input) || input.length !== proposals.length) fail('Review every proposed address', 400);
  return input.map((item, index) => {
    const clean = Object.fromEntries(['address_line1', 'address_line2', 'city', 'state', 'zip']
      .map((field) => [field, String(item[field] || '').trim()]));
    if (item.quote !== proposals[index].quote || !/^\d+[A-Za-z-]*\s+\S/.test(clean.address_line1)
      || clean.address_line1.length > 200 || clean.address_line2.length > 100 || !clean.city || clean.city.length > 100
      || !/^[A-Z]{2}$/.test(clean.state) || !/^\d{5}(?:-\d{4})?$/.test(clean.zip)
      || !OCCUPANCY_TYPES.includes(item.occupancy_type)) fail('Complete and review each address and property role', 400);
    return { ...clean, occupancyType: item.occupancy_type, label: proposals[index].label || null };
  });
}

async function applyAdditionalProperties({ id, actorId, expectedUpdatedAt, sameResponsibility, addresses, conn = db }) {
  if (!enabled()) fail('Additional-property apply is gated off', 403);
  if (sameResponsibility !== true) fail('Confirm common service and billing responsibility before adding to this customer', 400);
  const before = await conn('triage_items').where({ id, reason_code: REASON }).first();
  if (!before?.sms_log_id) fail('SMS property card not found', 404);
  const customerId = before.payload?.customer_id;
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(customerId)]);
    await require('../utils/customer-comms-lock').lockCustomerComms(trx, customerId);
    const customer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first();
    const message = await trx('sms_log').where({ id: before.sms_log_id }).forUpdate().first();
    const card = await trx('triage_items').where({ id }).forUpdate().first();
    const actor = await trx('technicians').where({ id: actorId, role: 'admin', employment_status: 'active' }).first('id');
    if (!actor) fail('Active office staff required', 403);
    if (!enabled() || !customer || !card || !OPEN.includes(card.status)
      || !expectedUpdatedAt || +new Date(expectedUpdatedAt) !== +new Date(card.updated_at)) fail('Card changed; reload and review');
    if (!message || message.customer_id !== customerId || card.payload.customer_id !== customerId
      || sourceHash(message) !== card.payload.source_hash || !(await primarySender(trx, message))) fail('Source customer or message changed; review the conversation');
    const reviewed = reviewedAddresses(card.payload.additional_property_proposals || [], addresses);
    // Preserve the customer's current primary and the existing creator's
    // canonical address dedupe. Family occupancy does not assert ownership.
    const primaryResult = await ensurePrimaryProperty(customer, { conn: trx });
    if (!primaryResult.propertyId) fail('Establish the primary address in the customer profile before adding another property');
    const primary = await trx('customer_properties').where({ id: primaryResult.propertyId }).first();
    const results = [];
    for (const address of reviewed) {
      // Complete only gaps in the same known premises, including the unit.
      // A different city/unit cannot donate fields to the primary address.
      const matchesPrimary = [customer, primary].every((row) => addressKey({ ...row,
        city: row.city || address.city, zip: row.zip || address.zip }) === addressKey(address));
      if (matchesPrimary) await completePrimaryFromCall(customerId, address, { conn: trx });
      results.push(await recordCallProperty({ ...address, customerId, source: 'sms', conn: trx }));
    }
    await trx('triage_items').where({ id }).update({ status: 'resolved', resolution_source: 'human',
      resolution_note: 'Office reviewed addresses and confirmed common service and billing responsibility.',
      assigned_to: actorId, resolved_at: new Date(), updated_at: new Date() });
    await recordAuditEvent({ trx, critical: true, actor_type: 'technician', actor_id: actorId,
      action: 'sms.additional_properties.applied', resource_type: 'triage_item', resource_id: id,
      metadata: { customer_id: customerId, sms_log_id: message.id, common_responsibility_confirmed: true,
        created_property_ids: results.filter((row) => row.created).map((row) => row.propertyId),
        already_present_count: results.filter((row) => !row.created).length } });
    return { resolved: true, created: results.filter((row) => row.created).length };
  });
}

async function replayAdditionalProperties({ smsLogId, execute = false, previewHash, conn = db,
  extract = require('./sms-operational-extractor').extractSmsOperations }) {
  if (!enabled()) return { skipped: 'gate_off' };
  const message = await conn('sms_log').where({ id: smsLogId }).first();
  const { eligibleMessage } = require('./sms-operational-actions');
  if (!message || message.direction !== 'inbound' || !eligibleMessage(message)) return { skipped: 'ineligible_source' };
  const extracted = await extract({ message, history: [], properties: [], captureCommitments: false, captureAdditionalProperties: true });
  let result;
  const rollback = new Error('preview_rollback');
  try {
    await conn.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(message.customer_id)]);
      const customer = await trx('customers').where({ id: message.customer_id }).whereNull('deleted_at').forUpdate().first('id');
      const live = await trx('sms_log').where({ id: message.id }).forUpdate().first();
      if (!customer || !live || sourceHash(live) !== sourceHash(message)) fail('Replay source changed');
      const existing = await trx('customer_properties').where({ customer_id: customer.id }).orderBy('id').select('id', 'address_key', 'active');
      const card = await trx('triage_items').where({ sms_log_id: message.id, reason_code: REASON }).first('id', 'status', 'updated_at');
      const hash = hashExtractionSource(JSON.stringify({ source: sourceHash(live), proposals: extracted.additional_properties || [], existing, card }));
      if (execute && hash !== previewHash) fail('Replay preview changed');
      const outcome = await stageAdditionalProperties({ trx, message: live, proposals: extracted.additional_properties, targetedReplay: true });
      result = { sms_log_id: message.id, preview_hash: hash, mode: execute ? 'execute' : 'preview',
        proposed: outcome.proposed || 0, preserved: !!outcome.preserved, skipped: outcome.skipped || null, dropped: extracted.dropped };
      if (!execute) throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  return result;
}

module.exports = { enabled, primarySender, sourceHash, reviewedAddresses, stageAdditionalProperties, applyAdditionalProperties, replayAdditionalProperties };
