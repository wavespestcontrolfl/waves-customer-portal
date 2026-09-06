'use strict';

// The action half of the SMS agent. Reuses the extraction receipt store,
// commitment ledger, private profile writer, cron lock and admin bell.
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
const { isInternalTestCustomerId } = require('./internal-test-customers');
const { loadSmsFulfillmentEvidence, verifySmsFulfillment } = require('./sms-commitment-fulfillment');

const enabled = () => gateEnvValue('GATE_SMS_OPERATIONAL_ACTIONS');
const SOURCE_COLUMNS = ['id', 'customer_id', 'direction', 'message_body', 'message_type', 'created_at', 'from_phone', 'to_phone', 'status'];
const HUMAN_TYPES = ['manual', 'ai_approved', 'ai_revised'];
const EXCLUDED_TYPES = ['opt_out', 'opt_in', 'sms_reaction', 'help_request', 'reschedule_reply'];
const tail = (v) => String(v || '').replace(/\D/g, '').slice(-10);
// A sentence can request the same kind of work for two properties or two
// recipients/deliverables. Keep that scope in identity. Source-row locking
// and operational_analysis prevent a reworded retry from committing a
// second extraction of the same SMS.
const keyOf = (item) => `${item.party}:${item.kind}:${hashExtractionSource(
  JSON.stringify([item.quote, item.property_id, item.description]),
).slice(0, 20)}`;

function eligibleMessage(message) {
  const ourNumber = message.direction === 'inbound' ? message.to_phone : message.from_phone;
  return !!message.customer_id && !!message.message_body
    && !isInternalTestCustomerId(message.customer_id)
    && tail(ourNumber) !== tail(numbers.tollFree.number)
    && !!numbers.findByNumber(ourNumber)
    && !EXCLUDED_TYPES.includes(message.message_type)
    && (message.direction === 'inbound'
      || (HUMAN_TYPES.includes(message.message_type) && ['sent', 'delivered'].includes(message.status)));
}

function factVerdict(fact, { properties, current = {}, expectedCurrent = current, senderIsPrimary }) {
  if (!senderIsPrimary) return 'contact_authority';
  if (properties.length !== 1 || fact.property_id !== properties[0].id) return 'property_ambiguous';
  if (fact.duration !== 'durable') return 'temporary_instruction';
  if (fact.field === 'contact_preference'
    && explicitContactPreference(fact.quote) !== fact.value) return 'preference_uncertain';
  if (fact.field.endsWith('_code') && !matchesExplicitAccessCode(fact)) return 'code_uncertain';
  const maxLength = fact.field.endsWith('_code') ? 100 : fact.field === 'irrigation_controller_location' ? 200 : 600;
  if (fact.value.length > maxLength) return 'value_too_long';
  const before = current[fact.field] ?? null;
  if (before !== (expectedCurrent[fact.field] ?? null)) return 'changed_during_extraction';
  if (before === fact.value) return 'unchanged';
  // Existing information is not erased merely because a new model pass
  // found different wording. Explicit correction policy is owner-reviewed.
  if (before != null && before !== '') return 'existing_value_conflict';
  return 'apply';
}

async function applyFacts(trx, message, facts, context) {
  const outcomes = [];
  let persistedCurrent = context.current;
  for (const fact of facts) {
    const duplicateField = facts.filter((f) => f.field === fact.field).length > 1;
    const verdict = duplicateField ? 'conflicting_facts' : factVerdict(fact, context);
    if (verdict !== 'apply') { outcomes.push({ ...fact, outcome: verdict }); continue; }
    const proposal = { scope_id: message.customer_id, field: fact.field, resource_id: persistedCurrent?.id || null };
    const target = await resolvePropertyPreferencesTarget({ trx, proposal, currentRaw: persistedCurrent?.[fact.field] ?? null });
    await applyPropertyPreferenceValue({ trx, proposal, target, proposedRaw: fact.value });
    await recordAuditEvent({ trx, critical: true, actor_type: 'system', action: 'sms.property_preference.updated',
      resource_type: 'property_preferences', resource_id: target.id,
      metadata: { sms_log_id: message.id, customer_id: message.customer_id, property_id: fact.property_id,
        field: fact.field, extractor_version: VERSION, value_hash: hashExtractionSource(fact.value) } });
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
    const live = await trx('sms_log').where({ id: message.id }).forUpdate().first();
    if (!enabled()) return { skipped: 'gate_off' };
    if (!live || live.customer_id !== message.customer_id || live.message_body !== message.message_body) return { skipped: 'source_changed' };
    if (live.operational_analysis?.version === VERSION) return { skipped: 'already_processed' };
    const customer = await trx('customers').where({ id: message.customer_id }).whereNull('deleted_at').forUpdate().first();
    if (!customer) return { skipped: 'customer_unavailable' };
    const properties = await trx('customer_properties').where({ customer_id: customer.id, active: true }).select('id');
    const current = await trx('property_preferences').where({ customer_id: customer.id }).forUpdate().first();
    const sender = message.direction === 'inbound' ? message.from_phone : message.to_phone;
    const matches = await trx('customers').whereNull('deleted_at')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [tail(sender)]).limit(2).select('id');
    const senderIsPrimary = matches.length === 1 && matches[0].id === customer.id;
    const facts = await applyFacts(trx, message, extracted.facts, {
      properties, current: current || {}, expectedCurrent: matchedContext.preferences, senderIsPrimary,
    });
    for (const item of extracted.obligations) {
      const propertyValid = !item.property_id || properties.some((p) => p.id === item.property_id);
      await trx('call_commitments').insert({
        sms_log_id: message.id, commitment_key: keyOf(item), party: item.party, kind: item.kind,
        description: item.description, channel: 'sms', due_at: item.due_at ? new Date(item.due_at) : null,
        due_basis: item.due_at ? 'stated' : null, source: 'ai', extractor_version: VERSION,
        evidence: JSON.stringify([{ quote: item.quote, sms_log_id: message.id, matched: true,
          speaker: message.direction === 'inbound' ? 'caller' : 'agent' }]),
        sms_context: { basis: item.basis, due_text: item.due_text, property_id: propertyValid ? item.property_id : null,
          property_ambiguous: !propertyValid, customer_id: customer.id, source_at: message.created_at },
      }).onConflict(['sms_log_id', 'commitment_key']).ignore();
    }
    const analysis = { version: VERSION, processed_at: new Date().toISOString(), facts, dropped: extracted.dropped };
    await trx('sms_log').where({ id: message.id }).update({ operational_analysis: analysis });
    await recordExtractionAttempt({ trx, source_type: 'message', source_id: message.id, extractor_version: VERSION,
      source_hash: hashExtractionSource(message.message_body), status: 'ok', proposal_count: extracted.obligations.length });
    const exceptions = facts.filter((f) => !['applied', 'unchanged'].includes(f.outcome));
    if (exceptions.length + extracted.dropped) {
      const notif = await NotificationService.notifyAdmin('alert', 'SMS instructions need review',
        'Part of this message needs an evidence, property, timing, or existing-value check. Open the customer profile to review the source conversation.',
        { trx, bell: true, dedupeKey: `sms-property-instructions:${message.id}`,
          link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
          metadata: { triggerKey: 'sms_operational_exception', customerId: customer.id, sms_log_id: message.id,
            fields: exceptions.map((f) => f.field), unverified_count: extracted.dropped,
            reasons: [...new Set(exceptions.map((f) => f.outcome))] } });
      if (!notif?.id) throw new Error('sms_operations_bell_not_persisted');
    }
    return { recorded: extracted.obligations.length, applied: facts.filter((f) => f.outcome === 'applied').length };
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

const KIND_LABELS = {
  send_estimate: 'An estimate requested or promised by SMS needs follow-up',
  callback: 'An SMS callback request or promise needs follow-up',
  send_report: 'A requested report needs follow-up',
  send_paperwork: 'Requested paperwork needs follow-up',
  technician_follow_up: 'A technician follow-up needs attention',
  schedule_visit: 'An SMS scheduling request needs attention',
  send_appointment_confirmation: 'A promised appointment confirmation needs attention',
  other: 'An SMS request needs follow-up',
};

async function refreshSmsCommitments({ now = new Date(), conn = db, verify = verifySmsFulfillment } = {}) {
  if (!enabled()) return { skipped: 'gate_off' };
  if (!gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE')) return { skipped: 'activation_time_required' };
  let afterId = null;
  const cursorKey = 'sms_operations.fulfillment_cursor';
  const cursor = await conn('system_settings').where({ key: cursorKey }).first('value');
  if (/^[a-f0-9-]{36}$/i.test(cursor?.value || '')) afterId = cursor.value;
  let scanned = 0;
  let fulfilled = 0;
  let unverified = 0;
  // One bounded page per tick, with a durable cursor. An old open item
  // cannot monopolize the first page and strand later customers forever.
  const rows = await conn('call_commitments as cc').join('sms_log as s', 's.id', 'cc.sms_log_id')
    .join('customers as c', 'c.id', 's.customer_id').whereNull('c.deleted_at')
    .where({ 'cc.status': 'open', 'cc.party': 'waves' }).whereNull('cc.human_state')
    .whereNotNull('cc.due_at').where('cc.due_at', '<=', now)
    .modify((q) => { if (afterId) q.where('cc.id', '>', afterId); })
    .orderBy('cc.id').limit(25).select('cc.*');
  for (const row of rows) {
    if (!enabled()) return { scanned, fulfilled, unverified, skipped: 'gate_off' };
    scanned += 1;
    const message = await conn('sms_log').where({ id: row.sms_log_id }).first(...SOURCE_COLUMNS);
    if (!message || !eligibleMessage(message)) continue;
    // The SMS foreign key follows merges and merge undo. Embedded context
    // is only a snapshot; never let its former owner strand the obligation.
    const current = { ...row, sms_context: { ...row.sms_context, customer_id: message.customer_id } };
    const evidence = await loadSmsFulfillmentEvidence(conn, current, message, now);
    const verdict = await verify(current, evidence, { now });
    if (verdict.verdict === 'uncertain') unverified += 1;
    await conn.transaction(async (trx) => {
      // Intake also locks SMS before commitment. A merge/relink while the
      // verifier runs must retry against the new owner, not publish stale proof.
      const source = await trx('sms_log').where({ id: message.id }).forUpdate().first();
      if (!source || !eligibleMessage(source) || source.customer_id !== message.customer_id || source.message_body !== message.message_body) return;
      const customer = await trx('customers').where({ id: source.customer_id }).whereNull('deleted_at').forUpdate().first();
      if (!customer) return;
      const live = await trx('call_commitments').where({ id: row.id }).forUpdate().first();
      if (!enabled() || live?.status !== 'open' || live.human_state != null) return;
      await trx('call_commitments').where({ id: row.id }).update({
        sms_context: { ...current.sms_context, fulfillment_check: verdict },
      });
      const dedupeKey = `sms-commitment:${row.id}`;
      if (verdict.verdict === 'fulfilled') {
        await trx('call_commitments').where({ id: row.id }).update({
          status: 'fulfilled', fulfillment: verdict, fulfilled_at: now, updated_at: now,
        });
        await trx('notifications').where({ recipient_type: 'admin' })
          .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).update({ read_at: now });
        fulfilled += 1;
        return;
      }
      const when = new Date(message.created_at).toLocaleString('en-US', {
        timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const body = verdict.verdict === 'uncertain'
        ? `The ${when} ET SMS needs a completion check. Some follow-up evidence is unavailable or ambiguous; the agent cannot determine whether the work was completed. Open the customer profile to verify.`
        : `Requested or promised in the ${when} ET conversation. The available follow-up records do not establish completion. Open the customer profile to take the next step.`;
      const notification = await NotificationService.notifyAdmin('alert', KIND_LABELS[row.kind] || KIND_LABELS.other, body,
        { trx, bell: true, dedupeKey, dedupeWindowMs: 24 * 60 * 60 * 1000, refreshOnDedupe: true,
          link: `/admin/customers?customerId=${encodeURIComponent(message.customer_id)}`,
          metadata: { triggerKey: 'sms_operational_followup', customerId: message.customer_id,
            sms_log_id: message.id, commitment_id: row.id, kind: row.kind, verification: verdict.verdict } });
      if (!notification?.id && !notification?.suppressed) throw new Error('sms_operations_bell_not_persisted');
    });
  }
  const nextCursor = rows.length === 25 ? rows[rows.length - 1].id : null;
  await conn('system_settings').insert({ key: cursorKey, value: nextCursor, category: 'sms_operations' })
    .onConflict('key').merge({ value: nextCursor, updated_at: now });
  return { scanned, fulfilled, unverified };
}

module.exports = { eligibleMessage, factVerdict, loadMessageContext, recordMessageOperations, runSmsOperationalActions, refreshSmsCommitments };
