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
const { validate: isUuid } = require('uuid');
const { hashExtractionSource, recordExtractionAttempt, shouldSkipExtraction, TERMINAL_STATUSES } = require('./data-hygiene/source-extraction-store');
const { stalePendingExtractionProposals, findPendingExtractionProposal, upsertSensitiveProposal, findSmsExtractionProposals, buildIdempotencyKey } = require('./data-hygiene/proposal-store');
const { resolvePropertyPreferencesTarget, applyPropertyPreferenceValue } = require('./data-hygiene/property-preferences');
const { VERSION, extractSmsOperations, explicitContactPreference, matchesExplicitAccessCode } = require('./sms-operational-extractor');
const { IRRIGATION_INPUT_FIELDS } = require('./irrigation-schedule-confirmation');
const { isInternalTestCustomerId } = require('./internal-test-customers');
const { isSmsReaction } = require('./sms-intent');
const { hashSensitiveValue } = require('./data-hygiene/sensitive-vault');

const enabled = () => gateEnvValue('GATE_SMS_OPERATIONAL_ACTIONS');
const REPLAY_VERSION = `${VERSION}:replay`;
const SOURCE_COLUMNS = ['id', 'customer_id', 'direction', 'message_body', 'message_type', 'created_at', 'from_phone', 'to_phone', 'status', 'twilio_sid'];
const EXCLUDED_TYPES = ['opt_out', 'opt_in', 'sms_reaction', 'help_request'];
// Owner decision 2026-09-07: only bounded typed fields auto-apply, each behind
// its strict validator. Free-form text becomes a pending proposal in the
// existing data-hygiene queue (vault, audit and revert included), so a missed
// backstop can at most propose, never write.
const AUTO_APPLY_FIELDS = new Set(['contact_preference', 'neighborhood_gate_code', 'property_gate_code', 'lockbox_code', 'garage_code']);
const tail = (v) => String(v || '').replace(/\D/g, '').slice(-10);
function eligibleMessage(message = {}) {
  const ourNumber = message.direction === 'inbound' ? message.to_phone : message.from_phone;
  return !!message.customer_id && !!message.message_body
    && !isInternalTestCustomerId(message.customer_id)
    && tail(ourNumber) !== tail(numbers.tollFree.number)
    && !!numbers.findByNumber(ourNumber)
    && !EXCLUDED_TYPES.includes(message.message_type)
    // Loud tapbacks are stored as ordinary inbound rows; the webhook's own
    // detector keeps every reaction out of profile extraction.
    && !isSmsReaction(message.message_body)
    && message.direction === 'inbound';
}

// Explicit time windows anywhere in the current SMS require staff review,
// independent of the model's duration label: relative windows, absences and
// travel, seasons, weekdays and calendar dates all bound an instruction.
// Movement "through" a gate or an ordinal door on its own does not.
const WEEKDAY = String.raw`(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\.)`;
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const ORDINAL_DAY = String.raw`(?:[12]?\d|3[01])(?:st|nd|rd|th)`;
const COUNT = String.raw`(?:\d+|an?|one|two|three|four|five|six|seven|several|(?:a )?few|(?:a )?couple(?: of)?)`;
const TEMPORARY_INSTRUCTION = new RegExp([
  String.raw`\b(?:today|tomorrow|tonight|temporar(?:y|ily)|for now|currently|right now|at the moment|in the meantime|one[- ]time|upcoming|during|until|till|vacation|holiday|snowbird|travel(?:l)?ing)\b`,
  String.raw`\b(?:for|before|at|after) (?:our|your|the|this|my) (?:next |upcoming |scheduled )?(?:visit|service|appointment|treatment)\b`,
  String.raw`\bfor the (?:time being|moment|rest of)\b`,
  String.raw`\b(?:just|only) (?:for|on|this|today|tomorrow|tonight|once)\b`,
  String.raw`\bthis (?:time|once|visit|appointment|service|round|week(?:end)?|month|morning|afternoon|evening|summer|winter|spring|fall)\b`,
  String.raw`\bnext (?:visit|appointment|service|time|week|month)\b`,
  String.raw`\b(?:next|coming|following) (?:${COUNT} )?(?:days?|weeks?|months?|visits?)\b`,
  String.raw`\bfor (?:the next |another )?${COUNT} (?:days?|weeks?|months?|nights?)\b`,
  String.raw`\bover the (?:weekend|summer|winter|holidays?)\b`,
  String.raw`\b(?:through|thru) (?:the (?:weekend|end of|summer|winter|spring|fall|holidays?|week|month)\b|${WEEKDAY}|${MONTH}\b)`,
  String.raw`\bout of (?:town|the country|state)\b`,
  String.raw`\bon (?:a |our |my )?(?:trip|cruise|honeymoon)\b`,
  String.raw`\baway (?:until|till|through|thru|for|on|this|next|starting)\b`,
  String.raw`\b(?:while|when|whilst) (?:(?:we|i|they)(?:[’']re| are|[’']m| am)? )?(?:away|gone|out of town)\b`,
  String.raw`\b(?:we|i|they)(?:[’']re| are|[’']m| am|[’']ll be| will be|[’']ve| have) (?:away|gone|out|off|leaving|not (?:here|home|around|in town)|unavailable)\b`,
  String.raw`\b(?:back|return(?:s|ing)?) in ${COUNT} (?:days?|weeks?|months?)\b`,
  String.raw`\b${WEEKDAY}`,
  String.raw`\b${MONTH}\.? ?(?:${ORDINAL_DAY}|\d{1,2})\b`,
  String.raw`\b(?:${ORDINAL_DAY}|\d{1,2}) (?:of )?${MONTH}\b`,
  String.raw`\b(?:on|by|until|till|before|after|around|starting) the ${ORDINAL_DAY}\b`,
  String.raw`\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b`,
  String.raw`\b\d{4}-\d{2}-\d{2}\b`,
].join('|'), 'i');

// A negated or uncertain report does not establish an active system or a
// pet on site (next-stop alerts treat any pet_details as a pet). Keep these
// as review exceptions before the shared write, whatever the model labelled.
const NEGATED_OR_UNCERTAIN = /\b(?:no|not|never|without|none|unsure|uncertain|maybe|perhaps|might|removed|used to|anymore|any more|passed away|gone|lack(?:s|ing)?)\b|n['’]t/i;
const REVIEW_ON_NEGATION = Object.freeze({ pet_details: 'pet_needs_review',
  ...Object.fromEntries(IRRIGATION_INPUT_FIELDS.map((field) => [field, 'irrigation_needs_review'])) });

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

// A grounded free-form fact for an empty field is offered to staff through the
// existing sensitive-proposal path: the same row shape, vault and approve
// route the data-hygiene extraction phase uses (create-on-apply when the
// customer has no preferences row yet).
async function proposeFact(trx, message, fact, current) {
  // The same SMS is also dual-written to the unified inbox, where the admin
  // extraction phase may already have proposed this field from a regex
  // fragment, and an older SMS can be retried after a newer one succeeded.
  // The customer's newest statement wins. Only a matching Twilio identity
  // identifies a twin; a distinct newer correction always outranks this SMS.
  if (await findPendingExtractionProposal({ trx, scope_id: message.customer_id, field: fact.field,
    newerThan: message.created_at, sameMessageSid: message.twilio_sid })) return { id: null, created: false };
  const input = {
    rule_id: 'extract.sms_profile', rule_version: VERSION, resource_type: 'property_preferences',
    resource_id: current?.id || null, scope_type: 'customer', scope_id: message.customer_id, field: fact.field,
    current_value: current?.[fact.field] ?? null, proposed_value: fact.value,
    source: 'message-extraction', confidence: 0.9, tier: 'medium', is_sensitive: true,
    // The proposals API returns evidence without the audited reveal step, so
    // the text itself stays in the vault and the customer conversation.
    evidence: { evidence_source_type: 'message', evidence_source_id: message.id, sms_log_id: message.id,
      channel: 'sms', source_at: new Date(message.created_at).toISOString(), twilio_sid: message.twilio_sid || null,
      property_id: fact.property_id, extractor_version: VERSION,
      source_excerpt: 'Customer SMS; the text is in the vault and the customer conversation.' },
  };
  // Re-extraction can return an identical proposal. Preserve its pending or
  // terminal disposition before retiring siblings; the idempotent insert
  // would otherwise leave that very proposal stale with no replacement.
  const prior = await findSmsExtractionProposals({ trx, scope_id: message.customer_id,
    sms_log_id: message.id, twilio_sid: message.twilio_sid });
  const sameFact = prior.filter((proposal) => proposal.field === fact.field
    && proposal.evidence?.after_hash === hashSensitiveValue(fact.value));
  const existing = sameFact.find((proposal) => proposal.status !== 'pending') || sameFact[0]
    || await trx('data_hygiene_proposals').where({ idempotency_key: buildIdempotencyKey(input) }).forUpdate().first('id', 'status');
  if (existing) return { id: existing.status === 'pending' ? existing.id : null, created: false };
  const retired = await stalePendingExtractionProposals({ trx, scope_id: message.customer_id, field: fact.field,
    notNewerThan: message.created_at, sameMessageSid: message.twilio_sid });
  const proposal = await upsertSensitiveProposal(input, { trx });
  return { id: proposal.id, created: proposal.inserted, retired_proposal_ids: retired.map((row) => row.id).sort() };
}

async function applyFacts(trx, message, facts, context) {
  const outcomes = [];
  let persistedCurrent = context.current;
  // Every free-form value is the whole message, so two distinct free-form
  // fields in one batch claim the same text for different topics.
  const mixedTopics = new Set(facts.filter((f) => !AUTO_APPLY_FIELDS.has(f.field)).map((f) => f.field)).size > 1;
  for (const fact of facts) {
    if (context.replayAppliedFields?.has(fact.field)) {
      outcomes.push({ ...fact, outcome: 'previously_applied' });
      continue;
    }
    const duplicateField = facts.filter((f) => f.field === fact.field).length > 1;
    const negatedReview = REVIEW_ON_NEGATION[fact.field];
    const negated = negatedReview && NEGATED_OR_UNCERTAIN.test(message.message_body);
    const verdict = duplicateField ? 'conflicting_facts' : negated ? negatedReview
      : mixedTopics && !AUTO_APPLY_FIELDS.has(fact.field) ? 'mixed_topics' : factVerdict(fact, context);
    if (verdict !== 'apply') { outcomes.push({ ...fact, outcome: verdict }); continue; }
    // An explicit replay can offer new facts to staff but cannot refill a
    // cleared field or repeat an automatic write from an older message.
    if (context.replayAppliedFields || !AUTO_APPLY_FIELDS.has(fact.field)) {
      const proposal = await proposeFact(trx, message, fact, persistedCurrent);
      const proposalId = proposal.id;
      outcomes.push({ ...fact, outcome: proposalId ? 'proposed' : 'superseded', proposal_id: proposalId,
        proposal_created: proposal.created,
        ...(proposal.retired_proposal_ids?.length ? { retired_proposal_ids: proposal.retired_proposal_ids } : {}) });
      continue;
    }
    // A newer distinct pending proposal for this typed field (the extraction
    // phase saw a later message) outranks an older retried SMS: leave it to staff.
    if (await findPendingExtractionProposal({ trx, scope_id: message.customer_id, field: fact.field,
      newerThan: message.created_at, sameMessageSid: message.twilio_sid })) {
      outcomes.push({ ...fact, outcome: 'superseded' });
      continue;
    }
    const proposal = { scope_id: message.customer_id, field: fact.field, resource_id: persistedCurrent?.id || null };
    const target = await resolvePropertyPreferencesTarget({ trx, proposal, currentRaw: persistedCurrent?.[fact.field] ?? null });
    await applyPropertyPreferenceValue({ trx, proposal, target, proposedRaw: fact.value });
    // The admin extraction phase may already hold a pending proposal for this
    // field; its approve would now fail the before-value check, so retire it
    // here instead of leaving stale review work.
    await stalePendingExtractionProposals({ trx, scope_id: message.customer_id, field: fact.field });
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

// A scheduled send has a durable queue row and may also have a provider log.
// Always retain the queue identity, including before it settles and when the
// provider log is absent. Body equality is not identity: distinct sends stay
// separate, and send-time rendering/phone refresh may change the provider row.
function withoutScheduledDeliveryTwins(query, alias) {
  query.whereNotExists(function scheduledQueue() {
    this.select(1).from('sms_log as scheduled_source')
      .where(`${alias}.direction`, 'outbound')
      .where('scheduled_source.direction', 'outbound')
      .whereNotNull('scheduled_source.scheduled_for')
      .whereRaw("scheduled_source.id::text = ??->>'scheduled_sms_log_id'", [`${alias}.metadata`])
      .whereRaw('scheduled_source.customer_id = ??', [`${alias}.customer_id`]);
  });
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

async function appliedSmsProfileFields(conn, message) {
  const [audits, proposals] = await Promise.all([
    conn('audit_log').where({ action: 'sms.property_preference.updated', resource_type: 'property_preferences' })
      .whereRaw("metadata->>'sms_log_id' = ?", [message.id]).pluck('metadata'),
    findSmsExtractionProposals({ trx: conn, scope_id: message.customer_id,
      sms_log_id: message.id, twilio_sid: message.twilio_sid }),
  ]);
  return new Set([...audits.map((entry) => entry.field),
    ...proposals.filter((proposal) => ['approved', 'auto_applied', 'reverted'].includes(proposal.status)).map((proposal) => proposal.field)]);
}

async function recordMessageOperations(conn, message, extracted, matchedContext) {
  return conn.transaction(async (trx) => {
    // Match portal preference saves and merges: preference advisory lock,
    // customer, then its SMS rows. Do not hold a child row while awaiting its owner.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['property-preferences', String(message.customer_id)]);
    const customer = await trx('customers').where({ id: message.customer_id }).whereNull('deleted_at').forUpdate().first();
    if (!customer) return { skipped: 'customer_unavailable' };
    const live = await trx('sms_log').modify(withoutScheduledDeliveryTwins, 'sms_log')
      .where({ id: message.id }).forUpdate().first();
    if (!enabled()) return { skipped: 'gate_off' };
    if (!eligibleMessage(live) || ['customer_id', 'message_body'].some((field) => live[field] !== message[field])) return { skipped: 'source_changed' };
    const replay = matchedContext.replay === true;
    let replayAppliedFields;
    const receipt = { trx, source_type: 'message', source_id: message.id,
      extractor_version: replay ? REPLAY_VERSION : VERSION, source_hash: hashExtractionSource(message.message_body) };
    if (replay) {
      const since = gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE');
      if (!since || new Date(live.created_at) < since) return { skipped: 'outside_activation_window' };
      const prior = await shouldSkipExtraction(receipt);
      if (prior.skip) return { skipped: 'replay_receipt_terminal', receipt_status: prior.existing.status };
      replayAppliedFields = await appliedSmsProfileFields(trx, live);
    } else if (live.operational_analysis?.version === VERSION) return { skipped: 'already_processed' };
    const properties = await trx('customer_properties').where({ customer_id: customer.id, active: true }).select('id');
    const current = await trx('property_preferences').where({ customer_id: customer.id }).forUpdate().first();
    const sender = { inbound: message.from_phone, outbound: message.to_phone }[message.direction];
    const matches = await trx('customers').whereNull('deleted_at')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [tail(sender)]).limit(2).select('id');
    const senderIsPrimary = matches.length === 1 && matches[0].id === customer.id;
    const facts = await applyFacts(trx, message, extracted.facts, {
      properties, current: current || {}, expectedCurrent: matchedContext.preferences, senderIsPrimary, messageBody: message.message_body,
      replayAppliedFields,
    });
    // The existing notifier writes only through trx. Preview rolls this back
    // with the proposals, while execution hashes the same dedupe decision.
    const exceptions = facts.filter((f) => !['applied', 'unchanged', 'proposed', 'superseded', 'previously_applied'].includes(f.outcome));
    let notification = null;
    if (exceptions.length + extracted.dropped) {
      const notif = await NotificationService.notifyAdmin('alert', 'SMS instructions need review',
        'Part of this message needs an evidence, property, or existing-value check. Open the customer profile to review the source conversation.',
        { trx, bell: true, dedupeKey: `sms-property-instructions:${message.id}`,
          link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
          metadata: { triggerKey: 'sms_operational_exception', customerId: customer.id, sms_log_id: message.id,
            fields: exceptions.map((f) => f.field), unverified_count: extracted.dropped,
            reasons: [...new Set(exceptions.map((f) => f.outcome))] } });
      if (!notif.id) throw new Error('sms_operations_bell_not_persisted');
      notification = notif.deduped
        ? { action: 'preserve_notification', notification_id: notif.id }
        : { action: 'create_notification' };
    }
    let analysis = { version: VERSION, processed_at: new Date().toISOString(), facts, dropped: extracted.dropped };
    if (replay) {
      // Bind the actual locked decisions, including private values, to the
      // operator's preview without exposing them. Fresh proposal UUIDs vary
      // across rollback; preserved and retired proposal identities must still match.
      analysis.preview_hash = hashSensitiveValue({ purpose: 'sms-profile-replay', version: VERSION,
        source: SOURCE_COLUMNS.map((column) => [column, live[column] ?? null]),
        facts: facts.map((fact) => ({ field: fact.field, value: fact.value, quote: fact.quote,
          duration: fact.duration, property_id: fact.property_id, outcome: fact.outcome,
          proposal_created: fact.proposal_created, retired_proposal_ids: fact.retired_proposal_ids,
          proposal_id: fact.proposal_created ? null : fact.proposal_id ?? null })), dropped: extracted.dropped, notification });
      if (!matchedContext.dryRun && matchedContext.previewHash !== analysis.preview_hash) {
        throw Object.assign(new Error('sms_profile_replay_preview_changed'), { code: 'SMS_REPLAY_PREVIEW_CHANGED' });
      }
      analysis.notification = notification;
      await recordAuditEvent({ trx, critical: true, actor_type: 'system', action: 'sms.profile.replayed',
        resource_type: 'sms_log', resource_id: message.id,
        metadata: { initiated_by: 'operator', extractor_version: VERSION, preview_hash: analysis.preview_hash,
          outcomes: facts.map(({ field, outcome, proposal_id }) => ({ field, outcome, proposal_id })) } });
      analysis = { ...live.operational_analysis, replay: analysis };
    }
    await trx('sms_log').where({ id: message.id }).update({ operational_analysis: analysis });
    await recordExtractionAttempt({ ...receipt, status: 'ok', proposal_count: facts.length });
    return { applied: facts.filter((f) => f.outcome === 'applied').length,
      proposed: facts.filter((f) => f.outcome === 'proposed').length,
      preserved: facts.filter((f) => f.outcome === 'previously_applied').length };
  });
}

async function runSmsOperationalActions({ now = new Date(), conn = db, extract = extractSmsOperations } = {}) {
  if (!enabled()) return { skipped: 'gate_off' };
  const since = gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE');
  if (!since) return { skipped: 'activation_time_required' };
  return runExclusive('sms-operational-actions', async () => {
    const candidates = await conn('sms_log as s').modify(withoutScheduledDeliveryTwins, 's').where('s.created_at', '>=', since).where('s.created_at', '<=', now)
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
      }).orderBy('s.created_at').orderBy('s.id').limit(30)
      // The same projection as history: media metadata (provider URLs, object
      // keys) is never part of the text the providers see.
      .select(...SOURCE_COLUMNS.map((column) => `s.${column}`));
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

// Explicit operator action only. The scheduled intake never clears analysis
// markers or terminal receipts to replay messages after a model/body change.
async function replaySmsProfile({ smsLogId, execute = false, previewHash, conn = db, extract = extractSmsOperations } = {}) {
  if (!isUuid(smsLogId)) return { skipped: 'invalid_sms_log_id' };
  if (!enabled()) return { skipped: 'gate_off' };
  const since = gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE');
  if (!since) return { skipped: 'activation_time_required' };
  const message = await conn('sms_log as s').where('s.id', smsLogId)
    .where('s.created_at', '>=', since)
    .whereExists(function availableCustomer() {
      this.select(1).from('customers as c').whereRaw('c.id = s.customer_id').whereNull('c.deleted_at');
    }).first(...SOURCE_COLUMNS.map((column) => `s.${column}`), 's.operational_analysis');
  if (!eligibleMessage(message)) return { skipped: 'source_unavailable' };
  const previousReceipt = await conn('data_hygiene_source_extractions')
    .where({ source_type: 'message', source_id: smsLogId }).whereIn('status', TERMINAL_STATUSES).first('id');
  if (!message.operational_analysis && !previousReceipt) return { skipped: 'not_previously_analyzed' };
  const receipt = { trx: conn, source_type: 'message', source_id: smsLogId,
    extractor_version: REPLAY_VERSION, source_hash: hashExtractionSource(message.message_body) };
  const prior = await shouldSkipExtraction(receipt);
  if (prior.skip) return { skipped: 'replay_receipt_terminal', receipt_status: prior.existing.status };
  if (execute && !/^[a-f0-9]{64}$/.test(previewHash || '')) return { skipped: 'preview_required' };
  return runExclusive('sms-operational-actions', async () => {
    try {
      if (!enabled()) return { skipped: 'gate_off' };
      const lockedReceipt = await shouldSkipExtraction(receipt);
      if (lockedReceipt.skip) return { skipped: 'replay_receipt_terminal', receipt_status: lockedReceipt.existing.status };
      const context = await loadMessageContext(conn, message);
      const extracted = await extract(context);
      if (execute) return await recordMessageOperations(conn, message, extracted, { ...context, replay: true, previewHash });
      const preview = await conn.transaction();
      try {
        const outcome = await recordMessageOperations(preview, message, extracted, { ...context, replay: true, dryRun: true });
        if (outcome.skipped) return { dry_run: true, ...outcome };
        const simulated = await preview('sms_log').where({ id: smsLogId }).first('operational_analysis');
        const outcomes = simulated.operational_analysis.replay.facts.map((fact) => ({
          field: fact.field, action: fact.outcome === 'proposed'
            ? (fact.proposal_created ? 'create_proposal' : 'preserve_pending') : fact.outcome,
          ...(fact.retired_proposal_ids?.length ? { retired_proposal_ids: fact.retired_proposal_ids } : {}),
        }));
        return { dry_run: true, sms_log_id: smsLogId, preview_hash: simulated.operational_analysis.replay.preview_hash, ...outcome,
          unverified_count: simulated.operational_analysis.replay.dropped, outcomes,
          ...(simulated.operational_analysis.replay.notification ? { notification: simulated.operational_analysis.replay.notification } : {}) };
      } finally {
        await preview.rollback();
      }
    } catch (error) {
      if (error.code === 'SMS_REPLAY_PREVIEW_CHANGED') return { skipped: 'preview_changed' };
      if (!execute) return { dry_run: true, failed: true };
      return conn.transaction(async (trx) => {
        // Success locks this same source before recording its receipt. A
        // delayed failure must not downgrade an already committed replay.
        const live = await trx('sms_log').where({ id: smsLogId }).forUpdate().first('id');
        if (!live || !enabled()) return { failed: true };
        const completed = await shouldSkipExtraction({ ...receipt, trx });
        if (completed.skip) return { skipped: 'replay_receipt_terminal', receipt_status: completed.existing.status };
        await recordExtractionAttempt({ ...receipt, trx, status: 'failed', error_message: 'sms_profile_replay_failed' });
        return { failed: true };
      });
    }
  }, { recordHealth: false });
}

module.exports = { eligibleMessage, factVerdict, loadMessageContext, recordMessageOperations, runSmsOperationalActions, replaySmsProfile };
