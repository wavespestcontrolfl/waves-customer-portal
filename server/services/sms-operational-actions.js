'use strict';

// Private-profile capture for the SMS agent. Reuses extraction receipts,
// the audited profile writer, cron lock and existing exception bell.
// No customer communications, scheduling writes, account merges or money movement.
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue, gateEnvTimestamp } = require('../config/feature-gates');
const numbers = require('../config/twilio-numbers');
const { runExclusive } = require('../utils/cron-lock');
const { recordAuditEvent } = require('./audit-log');
const NotificationService = require('./notification-service');
const { hashExtractionSource, recordExtractionAttempt } = require('./data-hygiene/source-extraction-store');
const { resolvePropertyPreferencesTarget, applyPropertyPreferenceValue } = require('./data-hygiene/property-preferences');
const { VERSION, extractSmsOperations, explicitContactPreference, matchesExplicitAccessCode } = require('./sms-operational-extractor');
const { IRRIGATION_INPUT_FIELDS } = require('./irrigation-schedule-confirmation');
const { isInternalTestCustomerId } = require('./internal-test-customers');

const enabled = () => gateEnvValue('GATE_SMS_OPERATIONAL_ACTIONS');
const SOURCE_COLUMNS = ['id', 'customer_id', 'direction', 'message_body', 'message_type', 'created_at', 'from_phone', 'to_phone', 'status'];
const EXCLUDED_TYPES = ['opt_out', 'opt_in', 'sms_reaction', 'help_request'];
const tail = (v) => String(v || '').replace(/\D/g, '').slice(-10);
function eligibleMessage(message) {
  const ourNumber = message.direction === 'inbound' ? message.to_phone : message.from_phone;
  return !!message.customer_id && !!message.message_body
    && !isInternalTestCustomerId(message.customer_id)
    && tail(ourNumber) !== tail(numbers.tollFree.number)
    && !!numbers.findByNumber(ourNumber)
    && !EXCLUDED_TYPES.includes(message.message_type)
    && message.direction === 'inbound';
}

// Temporal qualifiers anywhere in the current SMS require staff review, even
// if the model omits that sentence or labels the extracted fact durable.
const TEMPORARY_INSTRUCTION = /\b(?:today|tomorrow|tonight|temporar(?:y|ily)|vacation|until|for now|this (?:time|visit|appointment|week|month)|next (?:visit|appointment)|one[- ]time|(?:just|only) (?:for|on)|(?:for|on) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

function factVerdict(fact, { properties, current = {}, expectedCurrent = current, senderIsPrimary, messageBody = '' }) {
  if (!senderIsPrimary) return 'contact_authority';
  if (properties.length !== 1 || fact.property_id !== properties[0].id) return 'property_ambiguous';
  if (fact.duration !== 'durable' || TEMPORARY_INSTRUCTION.test(`${messageBody} ${fact.quote}`)) return 'temporary_instruction';
  if (fact.field === 'contact_preference'
    && explicitContactPreference(fact.quote) !== fact.value) return 'preference_uncertain';
  if (fact.field.endsWith('_code') && !matchesExplicitAccessCode(fact)) return 'code_uncertain';
  const maxLength = { neighborhood_gate_code: 100, property_gate_code: 100, lockbox_code: 100,
    garage_code: 100, irrigation_controller_location: 200 }[fact.field] ?? 600;
  if (fact.value.length > maxLength) return 'value_too_long';
  const before = current[fact.field] ?? null;
  if (before !== (expectedCurrent[fact.field] ?? null)) return 'changed_during_extraction';
  if (before === fact.value) return 'unchanged';
  // Existing information is not erased merely because a new model pass
  // found different wording. Explicit correction policy is owner-reviewed.
  if (![null, ''].includes(before)) return 'existing_value_conflict';
  return 'apply';
}

async function applyFacts(trx, message, facts, context) {
  const outcomes = [];
  let persistedCurrent = context.current;
  for (const fact of facts) {
    const duplicateField = facts.filter((f) => f.field === fact.field).length > 1;
    // A negated or uncertain report does not establish an active system.
    // Keep these as review exceptions before the shared companion write.
    const uncertainIrrigation = IRRIGATION_INPUT_FIELDS.includes(fact.field)
      && /\b(?:no|not|never|without|unsure|uncertain|maybe|perhaps|might|removed|lack(?:s|ing)?)\b|n['’]t/i.test(message.message_body);
    const verdict = duplicateField ? 'conflicting_facts' : uncertainIrrigation ? 'irrigation_needs_review' : factVerdict(fact, context);
    if (verdict !== 'apply') { outcomes.push({ ...fact, outcome: verdict }); continue; }
    const proposal = { scope_id: message.customer_id, field: fact.field, resource_id: persistedCurrent?.id || null };
    const target = await resolvePropertyPreferencesTarget({ trx, proposal, currentRaw: persistedCurrent?.[fact.field] ?? null });
    await applyPropertyPreferenceValue({ trx, proposal, target, proposedRaw: fact.value });
    await recordAuditEvent({ trx, critical: true, actor_type: 'system', action: 'sms.property_preference.updated',
      resource_type: 'property_preferences', resource_id: target.id,
      metadata: { sms_log_id: message.id, customer_id: message.customer_id, property_id: fact.property_id,
        field: fact.field, extractor_version: VERSION } });
    persistedCurrent = { ...target, [fact.field]: fact.value };
    // A row created by this batch hydrates DB defaults, not customer
    // choices. Keep untouched logical fields empty while CAS uses the
    // actual persisted values under the transaction's row lock.
    context.current = { ...context.current, id: target.id, [fact.field]: fact.value };
    outcomes.push({ ...fact, outcome: 'applied' });
  }
  return outcomes;
}

async function loadMessageContext(conn, message) {
  const [history, properties, preferences] = await Promise.all([
    conn('sms_log').where({ customer_id: message.customer_id }).where('created_at', '<', new Date(message.created_at))
      .where(function endpoints() {
        this.where({ from_phone: message.from_phone, to_phone: message.to_phone })
          .orWhere({ from_phone: message.to_phone, to_phone: message.from_phone });
      }).orderBy('created_at', 'desc').limit(20).select(...SOURCE_COLUMNS),
    conn('customer_properties').where({ customer_id: message.customer_id, active: true })
      .select('id', 'is_primary', 'address_line1', 'address_line2', 'city', 'zip'),
    conn('property_preferences').where({ customer_id: message.customer_id }).first(),
  ]);
  return { message, history: history.reverse(), properties, preferences: preferences || {} };
}

async function recordMessageOperations(conn, message, extracted, matchedContext) {
  return conn.transaction(async (trx) => {
    // Match portal preference saves and merges: preference advisory lock,
    // customer, then its SMS rows. Do not hold a child row while awaiting its owner.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['property-preferences', String(message.customer_id)]);
    const customer = await trx('customers').where({ id: message.customer_id }).whereNull('deleted_at').forUpdate().first();
    if (!customer) return { skipped: 'customer_unavailable' };
    const live = await trx('sms_log').where({ id: message.id }).forUpdate().first();
    if (!enabled()) return { skipped: 'gate_off' };
    if (!live || live.customer_id !== message.customer_id || live.message_body !== message.message_body) return { skipped: 'source_changed' };
    if (live.operational_analysis?.version === VERSION) return { skipped: 'already_processed' };
    const properties = await trx('customer_properties').where({ customer_id: customer.id, active: true }).select('id');
    const current = await trx('property_preferences').where({ customer_id: customer.id }).forUpdate().first();
    const sender = message.direction === 'inbound' ? message.from_phone : message.to_phone;
    const matches = await trx('customers').whereNull('deleted_at')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [tail(sender)]).limit(2).select('id');
    const senderIsPrimary = matches.length === 1 && matches[0].id === customer.id;
    const facts = await applyFacts(trx, message, extracted.facts, {
      properties, current: current || {}, expectedCurrent: matchedContext.preferences, senderIsPrimary, messageBody: message.message_body,
    });
    const analysis = { version: VERSION, processed_at: new Date().toISOString(), facts, dropped: extracted.dropped };
    await trx('sms_log').where({ id: message.id }).update({ operational_analysis: analysis });
    await recordExtractionAttempt({ trx, source_type: 'message', source_id: message.id, extractor_version: VERSION,
      source_hash: hashExtractionSource(message.message_body), status: 'ok', proposal_count: facts.length });
    const exceptions = facts.filter((f) => !['applied', 'unchanged'].includes(f.outcome));
    if (exceptions.length + extracted.dropped) {
      const notif = await NotificationService.notifyAdmin('alert', 'SMS instructions need review',
        'Part of this message needs an evidence, property, or existing-value check. Open the customer profile to review the source conversation.',
        { trx, bell: true, dedupeKey: `sms-property-instructions:${message.id}`,
          link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
          metadata: { triggerKey: 'sms_operational_exception', customerId: customer.id, sms_log_id: message.id,
            fields: exceptions.map((f) => f.field), unverified_count: extracted.dropped,
            reasons: [...new Set(exceptions.map((f) => f.outcome))] } });
      if (!notif?.id) throw new Error('sms_operations_bell_not_persisted');
    }
    return { applied: facts.filter((f) => f.outcome === 'applied').length };
  });
}

async function runSmsOperationalActions({ now = new Date(), conn = db, extract = extractSmsOperations } = {}) {
  if (!enabled()) return { skipped: 'gate_off' };
  const since = gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE');
  if (!since) return { skipped: 'activation_time_required' };
  return runExclusive('sms-operational-actions', async () => {
    const candidates = await conn('sms_log as s').where('s.created_at', '>=', since).where('s.created_at', '<=', now)
      .whereNull('s.operational_analysis').whereNotNull('s.customer_id')
      .whereExists(function availableCustomer() {
        this.select(1).from('customers as c').whereRaw('c.id = s.customer_id').whereNull('c.deleted_at');
      })
      .where(function settledMessage() {
        this.where('s.direction', 'inbound').orWhereIn('s.status', ['sent', 'delivered', 'failed', 'undelivered']);
      })
      .whereNotExists(function completedAttempt() {
        this.select(1).from('data_hygiene_source_extractions as x').whereRaw('x.source_id = s.id')
          .where({ 'x.source_type': 'message', 'x.extractor_version': VERSION })
          .whereIn('x.status', ['ok', 'no_fields', 'failed_max_retries']);
      }).orderBy('s.created_at').orderBy('s.id').limit(30).select('s.*');
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    for (const message of candidates) {
      if (!enabled()) break;
      const source = { source_type: 'message', source_id: message.id, extractor_version: VERSION,
        source_hash: hashExtractionSource(message.message_body) };
      if (!eligibleMessage(message)) { await recordExtractionAttempt({ ...source, trx: conn, status: 'no_fields' }); continue; }
      try {
        const context = await loadMessageContext(conn, message);
        const extracted = await extract(context);
        const outcome = await recordMessageOperations(conn, message, extracted, context);
        if (outcome.skipped) { skipped += 1; continue; }
        processed += 1;
      } catch {
        failed += 1;
        await conn.transaction(async (trx) => {
          if (!enabled()) return;
          const receipt = await recordExtractionAttempt({ ...source, trx, status: 'failed', error_message: 'sms_operations_failed' });
          if (receipt.status !== 'failed_max_retries') return;
          const notification = await NotificationService.notifyAdmin('alert', 'An SMS needs a manual review',
            'The SMS agent could not finish processing this conversation after its retries. Open the customer profile to check the requested work.',
            { trx, bell: true, dedupeKey: `sms-operations-failed:${message.id}`,
              link: `/admin/customers?customerId=${encodeURIComponent(message.customer_id)}`,
              metadata: { triggerKey: 'sms_operational_exception', customerId: message.customer_id, sms_log_id: message.id } });
          if (!notification?.id) throw new Error('sms_operations_bell_not_persisted');
        });
        logger.warn(`[sms-operations] extraction failed for sms_log ${message.id}`);
      }
    }
    return { processed, failed, skipped };
  });
}

module.exports = { eligibleMessage, factVerdict, loadMessageContext, recordMessageOperations, runSmsOperationalActions };
