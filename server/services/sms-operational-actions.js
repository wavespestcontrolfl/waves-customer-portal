'use strict';

// Profile capture and separately gated SMS follow-up share extraction receipts,
// the audited profile writer, commitment ledger, cron lock and exception bell.
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
const { loadSmsFulfillmentEvidence, verifySmsFulfillment, revalidateSmsFulfillment } = require('./sms-commitment-fulfillment');

const { hashSensitiveValue } = require('./data-hygiene/sensitive-vault');
const REPLAY_VERSION = `${VERSION}:replay`;

const enabled = () => gateEnvValue('GATE_SMS_OPERATIONAL_ACTIONS');
const smsCommitmentsEnabled = () => enabled() && gateEnvValue('GATE_SMS_COMMITMENT_FOLLOWUP');
const HUMAN_TYPES = ['manual', 'ai_approved', 'ai_revised'];
const SOURCE_COLUMNS = ['id', 'customer_id', 'direction', 'message_body', 'message_type', 'created_at', 'from_phone', 'to_phone', 'status', 'twilio_sid', 'admin_user_id'];
const EXCLUDED_TYPES = ['opt_out', 'opt_in', 'sms_reaction', 'help_request'];
// Owner decision 2026-09-07: only bounded typed fields auto-apply, each behind
// its strict validator. Free-form text becomes a pending proposal in the
// existing data-hygiene queue (vault, audit and revert included), so a missed
// backstop can at most propose, never write.
const AUTO_APPLY_FIELDS = new Set(['contact_preference', 'neighborhood_gate_code', 'property_gate_code', 'lockbox_code', 'garage_code']);
const tail = (v) => String(v || '').replace(/\D/g, '').slice(-10);
// A sentence can request the same kind of work for two properties or two
// recipients/deliverables. Keep that scope in identity. Source-row locking
// and operational_analysis prevent a reworded retry from committing a
// second extraction of the same SMS.
const keyOf = (item) => `${item.party}:${item.kind}:${hashExtractionSource(
  JSON.stringify([item.quote, item.property_id, item.description]),
).slice(0, 20)}`;

function eligibleMessage(message = {}, { captured = false } = {}) {
  const statuses = captured ? ['sent', 'delivered', 'failed', 'undelivered'] : ['sent', 'delivered'];
  const ourNumber = message.direction === 'inbound' ? message.to_phone : message.from_phone;
  return !!message.customer_id && !!message.message_body
    && !isInternalTestCustomerId(message.customer_id)
    && tail(ourNumber) !== tail(numbers.tollFree.number)
    && !!numbers.findByNumber(ourNumber)
    && !EXCLUDED_TYPES.includes(message.message_type)
    // Loud tapbacks are stored as ordinary inbound rows; the webhook's own
    // detector keeps every reaction out of profile extraction.
    && !isSmsReaction(message.message_body)
    && (message.direction === 'inbound'
      // Automated senders also use "manual"; persisted staff attribution
      // must accompany a human message type before capturing a promise.
      || (smsCommitmentsEnabled() && !!message.admin_user_id
        && HUMAN_TYPES.includes(message.message_type) && statuses.includes(message.status)));
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

async function scheduledSourceMessage(conn, message) {
  if (message?.direction !== 'outbound') return message;
  // Keep queue identity but use the actual send's text, endpoints, time and
  // status. Recovery may re-stamp the queue hours later; relative deadlines
  // must not move with it. Locking the delivery also closes callback races.
  const delivery = await conn('sms_log').where({ direction: 'outbound', customer_id: message.customer_id })
    .whereRaw("metadata->>'scheduled_sms_log_id' = ?", [message.id])
    .orderBy('created_at', 'desc').orderBy('id', 'desc').forUpdate().first(...SOURCE_COLUMNS);
  return delivery ? { ...delivery, id: message.id, operational_analysis: message.operational_analysis } : message;
}

async function loadMessageContext(conn, message) {
  message = await scheduledSourceMessage(conn, message);
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
  return { message, history: history.reverse(), properties, preferences: preferences || {}, captureCommitments: smsCommitmentsEnabled() };
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
  const replay = matchedContext.replay === true;
  if (replay && message.direction !== 'inbound') return { skipped: 'source_changed' };
  const extractorVersion = replay ? REPLAY_VERSION : VERSION;
  const obligations = !replay && matchedContext.captureCommitments ? extracted.obligations : [];
  return conn.transaction(async (trx) => {
    // Match portal preference saves and merges: preference advisory lock,
    // customer, then its SMS rows. Do not hold a child row while awaiting its owner.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['property-preferences', String(message.customer_id)]);
    const customer = await trx('customers').where({ id: message.customer_id }).whereNull('deleted_at').forUpdate().first();
    if (!customer) return { skipped: 'customer_unavailable' };
    const source = await trx('sms_log').modify(withoutScheduledDeliveryTwins, 'sms_log')
      .where({ id: message.id }).forUpdate().first();
    const live = await scheduledSourceMessage(trx, source);
    const gatesPermitWrite = [enabled(), replay || matchedContext.captureCommitments === smsCommitmentsEnabled()].every(Boolean);
    if (!gatesPermitWrite) return { skipped: 'gate_changed' };
    if (!eligibleMessage(live) || ['customer_id', 'message_body', 'direction', 'message_type', 'from_phone', 'to_phone', 'created_at']
      .some((field) => {
        if (field === 'created_at') return new Date(live[field]).getTime() !== new Date(message[field]).getTime();
        return (live[field] ?? null) !== (message[field] ?? null);
      })) return { skipped: 'source_changed' };
    const since = gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE');
    if (!since || new Date(live.created_at) < since) return { skipped: 'outside_activation_window' };
    let replayAppliedFields;
    const receipt = { trx, source_type: 'message', source_id: message.id,
      extractor_version: extractorVersion, source_hash: hashExtractionSource(message.message_body) };
    if (replay) {
      const prior = await shouldSkipExtraction(receipt);
      if (prior.skip) return { skipped: 'replay_receipt_terminal', receipt_status: prior.existing.status };
      replayAppliedFields = await appliedSmsProfileFields(trx, live);
    } else if (live.operational_analysis?.version === VERSION) return { skipped: 'already_processed' };
    const properties = await trx('customer_properties').where({ customer_id: customer.id, active: true }).select('id');
    const [current = {}] = await trx('property_preferences').where({ customer_id: customer.id }).forUpdate().limit(1).select('*');
    const sender = { inbound: message.from_phone, outbound: message.to_phone }[message.direction];
    const matches = await trx('customers').whereNull('deleted_at')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [tail(sender)]).limit(2).select('id');
    const senderIsPrimary = matches.length === 1 && matches[0].id === customer.id;
    const facts = await applyFacts(trx, message, extracted.facts, {
      properties, current, expectedCurrent: matchedContext.preferences, senderIsPrimary, messageBody: message.message_body,
      replayAppliedFields,
    });
    if (obligations.length) await trx('call_commitments').insert(obligations.map((item) => {
      const propertyId = properties.length === 1 && properties.some((p) => p.id === item.property_id) ? item.property_id : null;
      return {
        sms_log_id: message.id, commitment_key: keyOf({ ...item, property_id: propertyId }), party: item.party, kind: item.kind,
        description: item.description, channel: 'sms', due_at: item.due_at,
        due_basis: item.due_at ? 'stated' : null, source: 'ai', extractor_version: VERSION,
        evidence: JSON.stringify([{ quote: item.quote, sms_log_id: message.id, matched: true,
          speaker: { inbound: 'caller', outbound: 'agent' }[message.direction] }]),
        sms_context: { basis: item.basis, due_text: item.due_text, property_id: propertyId,
          property_ambiguous: !propertyId, customer_id: customer.id, source_at: message.created_at },
      };
    })).onConflict(['sms_log_id', 'commitment_key']).ignore();
    // The existing notifier writes only through trx. Preview rolls this back
    // with the proposals, while execution hashes the same dedupe decision.
    const exceptions = facts.filter((f) => !['applied', 'unchanged', 'proposed', 'superseded', 'previously_applied'].includes(f.outcome));
    let notification = null;
    if (exceptions.length + extracted.dropped) {
      const notif = await NotificationService.notifyAdmin('alert', 'SMS instructions need review',
        'Part of this message needs an evidence, property, timing, or existing-value check. Open the customer profile to review the source conversation.',
        { trx, bell: true, dedupeKey: `sms-property-instructions:${message.id}`,
          link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}&tab=comms`,
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
      const previewAuthorized = [matchedContext.dryRun, matchedContext.previewHash === analysis.preview_hash].some(Boolean);
      if (!previewAuthorized) {
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
    await recordExtractionAttempt({ ...receipt, status: 'ok', proposal_count: facts.length + obligations.length });
    return { recorded: obligations.length, applied: facts.filter((f) => f.outcome === 'applied').length,
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
      // Filter the effective delivery before LIMIT: failed or pre-activation
      // sends must not occupy the recovery page forever. A later successful
      // delivery becomes eligible without clearing a terminal receipt.
      .whereRaw(`COALESCE((SELECT CASE
        WHEN delivery.status IN ('sent', 'delivered') AND delivery.created_at >= ?
          AND delivery.admin_user_id IS NOT NULL THEN TRUE ELSE FALSE END
        FROM sms_log delivery
        WHERE s.direction = 'outbound' AND delivery.direction = 'outbound'
          AND delivery.customer_id = s.customer_id
          AND delivery.metadata->>'scheduled_sms_log_id' = s.id::text
        ORDER BY delivery.created_at DESC, delivery.id DESC LIMIT 1), TRUE)`, [since])
      .whereNull('s.operational_analysis').whereNotNull('s.customer_id')
      .where(function staffOrCustomer() {
        this.where('s.direction', 'inbound').orWhereNotNull('s.admin_user_id');
      })
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
        if (!eligibleMessage(context.message) || new Date(context.message.created_at) < since) { skipped += 1; continue; }
        source.source_hash = hashExtractionSource(context.message.message_body);
        const extracted = await extract(context);
        const outcome = await recordMessageOperations(conn, context.message, extracted, context);
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
              link: `/admin/customers?customerId=${encodeURIComponent(message.customer_id)}&tab=comms`,
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

// Only the customer profile opts into SMS rows. Call queues and workers
// continue using their call-scoped reader and implicit deadline rules.
async function listSmsCommitments(conn, { customerId, limit = 20, offset = 0, now = new Date() }) {
  const rows = await conn('call_commitments as cc')
    .join('sms_log as s', 's.id', 'cc.sms_log_id')
    .join('customers as c', 'c.id', 's.customer_id')
    .where({ 's.customer_id': customerId, 'cc.status': 'open' }).whereNull('c.deleted_at')
    .orderByRaw('cc.due_at ASC NULLS LAST, s.created_at ASC, cc.id ASC')
    .limit(Math.max(1, Math.min(201, Number(limit) || 20)))
    .offset(Math.max(0, Number(offset) || 0))
    .select('cc.id', 'cc.party', 'cc.kind', 'cc.description', 'cc.status', 'cc.due_at',
      'cc.sms_log_id', 's.created_at as sms_started_at', 's.customer_id');
  return rows.map((row) => ({ ...row, overdue: !!row.due_at && new Date(row.due_at) <= now }));
}

async function applySmsCommitmentUpdate(conn, id, { customerId, action, note, reviewedBy }) {
  if (!['fulfill', 'dismiss'].includes(action)) throw Object.assign(new Error('SMS follow-up supports Mark done or Dismiss'), { status: 400 });
  if (note !== undefined && typeof note !== 'string') throw Object.assign(new Error('note must be text'), { status: 400 });
  return conn.transaction(async (trx) => {
    const initial = await trx('call_commitments').where({ id }).first('sms_log_id');
    if (!initial?.sms_log_id) throw Object.assign(new Error('SMS follow-up not found'), { status: 404 });
    // Match intake/watcher lock order. The requested profile must still own
    // the source after a merge or relink while its controls were open.
    const customer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first('id');
    if (!customer) throw Object.assign(new Error('Customer unavailable'), { status: 409 });
    const source = await trx('sms_log').where({ id: initial.sms_log_id }).forUpdate().first();
    if (source?.customer_id !== customerId) throw Object.assign(new Error('SMS follow-up moved; reload this profile'), { status: 409 });
    const current = await trx('call_commitments').where({ id }).forUpdate().first();
    if (current?.sms_log_id !== source.id || current.status !== 'open') {
      throw Object.assign(new Error('SMS follow-up changed; reload this profile'), { status: 409 });
    }
    if (!smsCommitmentsEnabled()) throw Object.assign(new Error('SMS follow-up is disabled'), { status: 409 });
    const { applyHumanUpdate } = require('./call-commitments');
    const updated = await applyHumanUpdate(trx, id, { action, note, reviewedBy });
    // Staff tokens resolve to technicians rows, including the admin role.
    await recordAuditEvent({ trx, critical: true, actor_type: 'technician', actor_id: reviewedBy,
      action: `sms.commitment.${action}`, resource_type: 'call_commitment', resource_id: id,
      metadata: { sms_log_id: source.id, customer_id: customerId } });
    await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`sms-commitment:${id}`]).update({ read_at: trx.fn.now() });
    return updated;
  });
}

async function refreshSmsCommitments({ now = new Date(), conn = db, verify = verifySmsFulfillment } = {}) {
  if (!smsCommitmentsEnabled()) return { skipped: 'gate_off' };
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
    if (!smsCommitmentsEnabled()) return { scanned, fulfilled, unverified, skipped: 'gate_off' };
    scanned += 1;
    const message = await scheduledSourceMessage(conn, await conn('sms_log').where({ id: row.sms_log_id }).first(...SOURCE_COLUMNS));
    // A later delivery failure cannot erase already-recorded staff work.
    // Intake still refuses failed sources; captured promises stay actionable.
    if (!message || !eligibleMessage(message, { captured: true })) continue;
    // The SMS foreign key follows merges and merge undo. Embedded context
    // is only a snapshot; never let its former owner strand the obligation.
    const current = { ...row, sms_context: { ...row.sms_context, customer_id: message.customer_id } };
    const evidence = await loadSmsFulfillmentEvidence(conn, current, message, now);
    const verdict = await verify(current, evidence, { now });
    if (verdict.verdict === 'uncertain') unverified += 1;
    await conn.transaction(async (trx) => {
      // Match merge and intake: customer, source, then commitment. A relink
      // while verification runs must retry against the current owner.
      const customer = await trx('customers').where({ id: message.customer_id }).whereNull('deleted_at').forUpdate().first();
      if (!customer) return;
      const source = await scheduledSourceMessage(trx, await trx('sms_log').where({ id: message.id }).forUpdate().first());
      if (!source || !eligibleMessage(source, { captured: true }) || source.customer_id !== message.customer_id || source.message_body !== message.message_body) return;
      const live = await trx('call_commitments').where({ id: row.id }).forUpdate().first();
      if (!smsCommitmentsEnabled() || live?.status !== 'open' || live.human_state != null) return;
      const latest = { ...live, sms_context: { ...live.sms_context, customer_id: source.customer_id } };
      if (verdict.verdict === 'fulfilled' && !await revalidateSmsFulfillment(trx, latest, source, verdict, now)) return;
      const dedupeKey = `sms-commitment:${row.id}`;
      if (live.sms_context.customer_id !== source.customer_id) {
        // Rolling dedupe only refreshes recent rows. Older bells must also
        // follow a merge or undo instead of opening the retired account.
        await trx('notifications').where({ recipient_type: 'admin' })
          .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).update({
            link: `/admin/customers?customerId=${encodeURIComponent(source.customer_id)}&tab=comms`,
            metadata: trx.raw("jsonb_set(metadata, '{customerId}', to_jsonb(?::text), true)", [source.customer_id]),
          });
      }
      await trx('call_commitments').where({ id: row.id }).update({
        sms_context: { ...current.sms_context, fulfillment_check: verdict },
      });
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
          link: `/admin/customers?customerId=${encodeURIComponent(message.customer_id)}&tab=comms`,
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

// Explicit operator action only. The scheduled intake never clears analysis
// markers or terminal receipts to replay messages after a model/body change.
async function replaySmsProfile({ smsLogId, execute = false, previewHash, conn = db, extract = extractSmsOperations } = {}) {
  if (!isUuid(smsLogId)) return { skipped: 'invalid_sms_log_id' };
  if (!enabled()) return { skipped: 'gate_off' };
  const since = gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE');
  if (!since) return { skipped: 'activation_time_required' };
  const message = await conn('sms_log as s').where({ 's.id': smsLogId, 's.direction': 'inbound' })
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
      const context = { ...await loadMessageContext(conn, message), captureCommitments: false };
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

module.exports = { smsCommitmentsEnabled, eligibleMessage, factVerdict, loadMessageContext, recordMessageOperations, runSmsOperationalActions, replaySmsProfile, refreshSmsCommitments, listSmsCommitments, applySmsCommitmentUpdate };
