'use strict';

// Profile capture and separately gated SMS follow-up share extraction receipts,
// the audited profile writer, commitment ledger, cron lock and exception bell.
// No customer communications, scheduling writes, account merges or money movement.
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue, gateEnvTimestamp, promiseRecordEvidenceMode } = require('../config/feature-gates');
const numbers = require('../config/twilio-numbers');
const { runExclusive } = require('../utils/cron-lock');
const { recordAuditEvent } = require('./audit-log');
const NotificationService = require('./notification-service');
const { raiseAdminAlert, cutAtWord, breaksAlertRules, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { validate: isUuid } = require('uuid');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { hashExtractionSource, recordExtractionAttempt, shouldSkipExtraction, TERMINAL_STATUSES } = require('./data-hygiene/source-extraction-store');
const { stalePendingExtractionProposals, findPendingExtractionProposal, upsertSensitiveProposal, findSmsExtractionProposals, buildIdempotencyKey } = require('./data-hygiene/proposal-store');
const { resolvePropertyPreferencesTarget, applyPropertyPreferenceValue } = require('./data-hygiene/property-preferences');
const { VERSION, extractSmsOperations, explicitContactPreference, matchesAccessCode, statesClock } = require('./sms-operational-extractor');
const { IRRIGATION_INPUT_FIELDS } = require('./irrigation-schedule-confirmation');
const { isInternalTestCustomerId } = require('./internal-test-customers');
const { isSmsReaction } = require('./sms-intent');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
const { verifyThreadCompletion, BASIS: THREAD_BASIS } = require('./sms-commitment-thread-close');
const { loadSmsFulfillmentEvidence, verifySmsFulfillment, revalidateSmsFulfillment, admissibleWitness, withExtendedEvidence, fulfillmentFingerprint, SYSTEM_EVENT_TYPES, PROVIDER_RETRY_MS, WITNESS_TRANSITION_STATUSES, LOGGED_MOVE_SQL, PAYMENT_WITNESS_KINDS, paymentEvidenceRow } = require('./sms-commitment-fulfillment');

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

// `unlinked`: an inbound text from a number with no customer record (the
// access codes net files it for the office to link); every other rule holds.
function eligibleMessage(message = {}, { captured = false, unlinked = false } = {}) {
  const statuses = captured ? ['sent', 'delivered', 'failed', 'undelivered'] : ['sent', 'delivered'];
  const ourNumber = message.direction === 'inbound' ? message.to_phone : message.from_phone;
  return (!!message.customer_id || (unlinked && message.direction === 'inbound')) && !!message.message_body
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

// Codex #4816 r20: relative or calendar timing the customer stated ("call me
// tomorrow", "this afternoon", "Friday", "mid Oct", "in 2 days") is still
// stated timing when the extractor leaves due_text empty; it must not be
// replaced by a per-kind default that could ring before that period.
// One unit vocabulary for every relative-offset form, so no form carries a
// shorter unit list than another (Codex #4816 r25/r33): OFFSET_UNIT after
// "in / within / give me …", SPAN_UNIT after "next / coming / following /
// over the next". "this year" stays out: "ants all this year" is usually
// the past, and a false match would drop a real follow-up's bell.
const OFFSET_UNIT = String.raw`(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|wks?|months?|mos?|years?|yrs?)`;
const SPAN_UNIT = String.raw`(?:days?|weeks?|months?|years?)`;
// What the customer asks ABOUT is the topic, not the deadline: "call me
// about my next visit", "about this month's invoice", "regarding Friday's
// service" (Codex #4816 r37–r39 kept finding one topical form per round).
// The clause after about/regarding/concerning, up to the next punctuation,
// is dropped before the timing test; "in/within/after/give me about 2
// hours" is an offset, not a topic, and stays. "from" names the source
// of an artifact ("the report from this morning", Codex #4816 r41). Erring
// toward the default deadline is the safe side: a missed bell is the worse
// failure.
// The clause always takes its first word ("about tomorrow's visit", "about
// my next visit"), then stops before a word that starts a trailing deadline
// ("about my invoice tomorrow", "... on Friday", "... by 5", "... next
// week"), so that timing is still tested (Codex #4816 r40).
const TRAILING_TIMING_START = String.raw`(?:today|tomorrow|tmrw|tonight|asap|eod|eow|by|before|after|on|until|till|at|in|within|later|end`
  + String.raw`|(?:mon|tues|wednes|thurs|fri|satur|sun)day|this (?:morning|afternoon|evening|week(?:end)?)|next (?:week(?:end)?|month|year))\b`;

// A possessive period names the topic, not the deadline: "about this
// month's invoice", "tomorrow's appointment", "Friday's visit" (Codex #4816
// r38). NOT_POSSESSIVE follows each bare period form.
const NOT_POSSESSIVE = String.raw`(?!['’]s\b)`;
const STATED_TIMING = new RegExp([
  String.raw`\b(?:today|tomorrow|tmrw|tonight|this (?:morning|afternoon|evening|week(?:end)?|month)|next (?:week(?:end)?|month|year)|later (?:today|this week)|end of (?:the )?(?:day|week|month|year)|eod|eow)\b${NOT_POSSESSIVE}`,
  // Day parts after a timing preposition ("call me in the morning", "after
  // work"), or plural as a standing preference ("evenings are best"). A bare
  // "good morning" is a greeting, not timing (Codex #4816 r24).
  String.raw`\b(?:in the|during the|by|before|after|around|until|till|early|late) (?:morning|afternoon|evening|night)\b`,
  String.raw`\b(?:mornings|afternoons|evenings|nights)\b`,
  // The period forms TEMPORARY_INSTRUCTION already knows (Codex #4816 r27).
  String.raw`\bover the (?:weekend|summer|winter|holidays?|next (?:${COUNT} )?${SPAN_UNIT})\b`,
  String.raw`\b(?:through|thru) the (?:weekend|week|month)\b`,
  String.raw`\b(?:next|coming|following) (?:${COUNT} )?${SPAN_UNIT}\b${NOT_POSSESSIVE}|\bnext time\b`,
  // A next visit is timing only when a timing preposition introduces it
  // ("at the next visit", "before my next appointment"); "call to discuss
  // the next appointment" names the topic (Codex #4816 r42).
  String.raw`\b(?:at|on|during|before|after|by|until|till|for)(?: (?:the|my|our|your))? next (?:visit|appointment|service)\b`,
  String.raw`\b(?:after|before) (?:work|school|lunch|dinner|noon)\b|\b(?:at )?lunch ?time\b`,
  String.raw`\b${WEEKDAY}${NOT_POSSESSIVE}`,
  // Undotted abbreviations ("call me Fri"). Wed/sat/sun double as ordinary
  // words, so they count only after a day preposition (Codex #4816 r21).
  String.raw`\b(?:mon|tue|tues|thu|thur|thurs|fri)\b`,
  String.raw`\b(?:on|by|next|this|til|till|until|before|after) (?:wed|sat|sun)\b`,
  // Any relative offset introduced as one, every unit and its abbreviations
  // ("in 30 min", "within 2 hrs", "in half an hour", "give me 20 mins"), and
  // "in a bit" / "in a few" — Codex #4816 r25 closes the family rather than
  // one unit at a time. Bare "later", "shortly" or "2 hours" are left out:
  // an undated row never bells, so a false match would drop a real
  // follow-up, while a vague "later" only makes the default bell early.
  // "about"/"like"/"around" only qualify an introducer ("in about 2 hours"):
  // standing alone they describe a topic or history ("about 2 years of
  // invoices", "here like 2 hours"), not callback timing (Codex #4816 r37).
  String.raw`\b(?:in|within|after|give me)(?: (?:about|like|around|roughly|maybe))? (?:(?:${COUNT}|half an?|an?(?: half)?|\d+(?:\.\d+)?)\s*(?:-|to|or)?\s*(?:\d+\s*)?)${OFFSET_UNIT}\b`,
  String.raw`\b(?:in|after) (?:a (?:bit|few|while|sec|second|minute|moment)|a little (?:bit|while)|a few)\b`,
  String.raw`\b(?:mid|early|late)[- ]?(?:${MONTH}\b|next (?:week|month|year)\b)`,
  String.raw`\b${MONTH}\.? ?(?:${ORDINAL_DAY}|\d{1,2})\b`,
  String.raw`\b(?:${ORDINAL_DAY}|\d{1,2}) (?:of )?${MONTH}\b`,
  // The calendar-date forms match TEMPORARY_INSTRUCTION's, ISO included
  // (Codex #4816 r23).
  String.raw`\b(?:on|by|until|till|before|after|around|starting) the ${ORDINAL_DAY}\b`,
  String.raw`\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b`,
  String.raw`\b\d{4}-\d{2}-\d{2}\b`,
].join('|'), 'i');

// Stops before any word where STATED_TIMING itself matches, so every date
// form it knows ("10/14", "Oct 14", "the 15th", weekdays) survives, plus the
// preposition starts above (Codex #4816 r43).
// "from" names a source ("the report from this morning", r41) unless an
// open-ended marker makes it a start date ("call me from Friday onward",
// "from tomorrow on", r44): then the clause is left for the timing test.
// The other introducers always take their first word ("about tomorrow's
// visit").
const TOPIC_STOP = String.raw`(?!${TRAILING_TIMING_START}|${STATED_TIMING.source})`;
// The marker must directly follow the start expression (at most three
// words in): "the service that happened on Friday" is a source (r46).
const RECORD_NOUN = String.raw`(?:reports?|photos?|pictures?|pics|videos?|images?|invoices?|statements?|bills?|receipts?|records?|notes|results|readings|logs?|data|charges|paperwork|documents?)`;
const FROM_START_DATE = String.raw`(?!(?:[^\s,.;!?]+\s+){1,3}(?:on|onwards?|forward|until|till|through|thru)\b)`;
const TOPIC_CLAUSE = new RegExp(
  // After a record noun, "from" names what the record covers, a range's
  // end date included ("the report from Friday through Sunday", Codex #4816
  // r48); it still stops before a trailing deadline ("the report from last
  // week tomorrow", r50).
  String.raw`(?<=\b${RECORD_NOUN}\s)from\s+[^\s,.;!?]+`
  + String.raw`(?:\s+(?:(?:that|which|who|where)\s[^,.;!?]*|(?:through|thru|until|till|to)\s+[^\s,.;!?]+|${TOPIC_STOP}[^\s,.;!?]+))*`
  + String.raw`|(?<!\b(?:in|within|after|give me) )\b`
  + String.raw`(?:(?:about|regarding|concerning|re:|in regards? to|with regards? to)\s+|from\s+${FROM_START_DATE})`
  // A relative clause ("the service that happened on Friday") describes the
  // topic, so it runs to the clause end, its dates included (r46).
  + String.raw`[^\s,.;!?]+(?:\s+(?:(?:that|which|who|where)\s[^,.;!?]*|${TOPIC_STOP}[^\s,.;!?]+))*`, 'gi');
function withoutTopics(quote) {
  return String(quote || '').replace(TOPIC_CLAUSE, ' ');
}

// Owner ruling 2026-09-28: the exact same-day tokens that still leave a
// Waves obligation undated below ("today", "tonight", the day-part trio,
// "later today", "eod", "end of (the) day") — the subset of STATED_TIMING's
// own vocabulary that names TODAY specifically, never a longer span ("this
// week/month" stay out on purpose: those keep the legacy undated behavior).
// NOT_POSSESSIVE follows every form, as in STATED_TIMING, so "today's
// appointment" or "tonight's visit" names the topic and is left to the
// existing per-kind handling (Codex #5170 r3 P2). A qualifier bound to the
// same-day form ("later tonight", "any time today", "sometime this
// afternoon") is part of it, so stripping takes it too and it never reads
// as a later option below (r3 P2).
const SAME_DAY_QUALIFIER = String.raw`(?:(?:later|any ?time|some ?time|early|late) )?`;
const SAME_DAY_TIMING = new RegExp([
  String.raw`\btoday\b${NOT_POSSESSIVE}`,
  String.raw`\btonight\b${NOT_POSSESSIVE}`,
  String.raw`\bthis (?:morning|afternoon|evening)\b${NOT_POSSESSIVE}`,
  String.raw`\beod\b${NOT_POSSESSIVE}`,
  String.raw`\bend of (?:the )?day\b${NOT_POSSESSIVE}`,
].map((form) => String.raw`\b${SAME_DAY_QUALIFIER}${form.slice(2)}`).join('|'), 'i');
// Global twin used only to strip every same-day occurrence before re-testing
// STATED_TIMING on what is left (Codex conventions keep the stateful global
// regex out of resolveDueDeadline's own module-level .test() calls).
const SAME_DAY_TIMING_STRIP = new RegExp(SAME_DAY_TIMING.source, 'gi');
// A later option offered beside the same-day timing ("today or next visit",
// "today, otherwise whenever") that STATED_TIMING does not recognize on its
// own (a bare "next visit" needs a preposition there) keeps the legacy
// undated row: a same-day deadline would bell before the option the customer
// allowed (Codex #5170 r1 P2). Only a later OPTION counts, never the bare
// word "or": "today or not", "call or text me today" and "this afternoon or
// tonight" stay same-day (r2 P2).
const SAME_DAY_ALTERNATIVE = /\bnext (?:visit|appointment|service|time)\b|\b(?:whenever|any ?time|some ?time|later(?! today)|another (?:day|time)|some ?other (?:day|time)|a different (?:day|time))\b/i;

// Outcomes a visit-only fact may reach without anyone needing to act: the
// duration verdict itself and the scope/authority guards that can run before
// it. Safety reviews (REVIEW_ON_NEGATION) are deliberately absent.
const VISIT_ONLY_SILENCED_OUTCOMES = ['temporary_instruction', 'property_ambiguous', 'contact_authority', 'conflicting_facts', 'mixed_topics'];

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
  if (fact.field.endsWith('_code') && !matchesAccessCode(fact, { messageBody, properties })) return 'code_uncertain';
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
    // The safety review outranks the duplicate-field conflict: a cat plus
    // "not sure about the dog" is two pet_details facts, and the uncertain
    // one must still ring (Codex #4816 r38).
    const verdict = negated ? negatedReview : duplicateField ? 'conflicting_facts'
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
    // codex #4331 P2 (structural pass): an unresolved review-ask reservation
    // must not read as prior history for this operational-action extraction.
    excludeUnresolvedSendReservations(conn('sms_log').where({ customer_id: message.customer_id }).where('created_at', '<', new Date(message.created_at)))
      .where(function endpoints() {
        this.where({ from_phone: message.from_phone, to_phone: message.to_phone })
          .orWhere({ from_phone: message.to_phone, to_phone: message.from_phone });
      }).orderBy('created_at', 'desc').limit(20).select(...SOURCE_COLUMNS),
    conn('customer_properties').where({ customer_id: message.customer_id, active: true })
      .select('id', 'is_primary', 'address_line1', 'address_line2', 'city', 'zip'),
    conn('property_preferences').where({ customer_id: message.customer_id }).first(),
  ]);
  return { message, history: history.reverse(), properties, preferences: preferences || {}, captureCommitments: smsCommitmentsEnabled(), captureAdditionalProperties: require('./sms-additional-properties').enabled() };
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

// R5 — per-kind default deadlines (owner ruling 2026-09-24: "actions vs
// follow-ups should have different timeframes"). Applied only when the
// extractor could not resolve an explicit stated due_at (groundExtraction
// keeps a bare "this morning"/"mid Oct" undated on purpose). Quick
// request/response asks get a same-day window; deliverables that take real
// work get a day or two; a technician follow-up gets the longest window.
// send_reschedule_link sits with schedule_visit: both ask Waves to move a
// booking, one by hand and one by texting the self-serve link.
const DEFAULT_DEADLINE_HOURS = Object.freeze({
  callback: 4, send_appointment_confirmation: 4,
  schedule_visit: 24, send_reschedule_link: 24, send_estimate: 24, other: 24,
  send_report: 48, send_paperwork: 48,
  technician_follow_up: 72,
});
// Owner ruling 2026-09-24 (late): a promise Adam made himself is the ask
// most likely to embarrass him if it slips, so it always gets the tighter
// 48h window — overriding the per-kind table above, regardless of kind.
const PROMISE_DEFAULT_DEADLINE_HOURS = 48;

// due_basis: 'stated' when the extractor grounded an explicit deadline in
// the source text; 'default_kind' when either this per-kind/basis table or
// the same-day rule below filled one in instead; null when the kind has no
// default and nothing was stated (legacy behavior — refreshSmsCommitments'
// null-due branch still applies).
//
// due_basis reuse (owner ruling 2026-09-28): the same-day rule below could
// have introduced its own 'same_day' value, but call_commitments carries a
// CHECK constraint enumerating due_basis ('stated' | 'suggested' |
// 'default_kind' — see migrations 20260901000010/20260925000001/…000002),
// and NEVER EDIT AN EXISTING MIGRATION rules out widening it in place; a new
// value needs a new migration for a distinction no reader currently needs.
// Every due_basis reader was checked (grep -rn due_basis server/): the Calls
// tab only special-cases 'suggested' for its "(suggested)" label
// (CallIntelligencePanel.jsx); nothing anywhere branches on 'default_kind'
// specifically. A same-day deadline IS a default this per-kind/basis table
// would otherwise have filled in — it fires only where R5's table already
// would have — so it reuses 'default_kind' rather than add a migration and
// an enum value for a rendering distinction no surface asks for.
// End of the business day on an ET calendar date (8 PM ET matches the
// follow-up SLA's 8 AM–8 PM ET window). Less than an hour after the text
// (it lands after ~7 PM ET) pushes the deadline to 9 AM ET the next morning
// instead of bell-in-an-hour. parseETDateTime does the DST-correct
// wall-clock -> instant conversion; never hand-roll the offset here.
function endOfBusinessDay(day, messageDate) {
  const endOfDay = parseETDateTime(`${day}T20:00`);
  return endOfDay.getTime() - messageDate.getTime() < 3600000
    ? parseETDateTime(`${etDateString(addETDays(endOfDay, 1))}T09:00`)
    : endOfDay;
}

function resolveDueDeadline(item, messageCreatedAt) {
  if (item.due_at) return { due_at: item.due_at, due_basis: 'stated' };
  // Defaults are Waves' own service windows. A customer-owned promise ("I'll
  // send photos") keeps the legacy undated behavior; a 48h stamp would show
  // the customer's own action as an overdue follow-up (Codex #4816 r2).
  if (item.party !== 'waves') return { due_at: null, due_basis: null };
  // The customer DID state a time ("tomorrow at 9 or 10", "mid Oct") that the
  // extractor could not resolve to a clock instant: leave it undated rather
  // than manufacture a per-kind deadline that contradicts what was said
  // (Codex #4816 r1). The row still closes on evidence; it never bells.
  // The grounded quote only, never the rest of the message (Codex #4816 r28
  // reversing r22): an undated row never bells, so timing borrowed from an
  // unrelated sentence ("The treatment on 2026-08-01 failed; please call
  // me") would silently drop a real follow-up, while timing a shortened
  // quote omits only makes the default bell early. A missed bell is the
  // worse failure.
  // timing_unverified is computed from every clock in the SMS; it speaks for
  // this obligation only when its own quote states a clock ("Call me at 3
  // and send the estimate" leaves the estimate its default — Codex #4816 r31).
  const unresolvedClock = item.timing_unverified && statesClock(item.quote);
  // A staff promise naming a day but no clock ("I'll stop by today",
  // "tomorrow", "Wednesday", "this weekend"): the extraction names the day
  // and groundExtraction checked it (due_date). Due at the end of that
  // business day (owner-approved staff-promise plan, 2026-09-28).
  if (item.basis === 'promise' && item.due_date && !unresolvedClock) {
    return { due_at: endOfBusinessDay(item.due_date, new Date(messageCreatedAt)).toISOString(), due_basis: 'default_kind' };
  }
  // Quotes are short excerpts; the cap keeps the timing regexes bounded.
  const strippedQuote = withoutTopics(String(item.quote || '').slice(0, 500));
  if (item.due_text || unresolvedClock || STATED_TIMING.test(strippedQuote)) {
    // Owner ruling 2026-09-28: an ask about TODAY ("Did you come to my house
    // today?", "Should we skip today?") used to leave the row undated like
    // any other stated timing, so it never bells staff. Give it an
    // end-of-business-day deadline instead — but ONLY when every stated
    // timing in play is a same-day token and no clock was stated at all: an
    // unresolved clock (above) always wins undated, and a resolved due_at
    // already returned 'stated' before reaching here.
    // "Only same-day timing": strip the same-day tokens from both the
    // topic-stripped quote and due_text, then re-run STATED_TIMING on each
    // remainder. Either remainder still matching ("today or tomorrow",
    // "today, else Friday", a due_text that names more than the same day)
    // keeps the legacy undated behavior — the safer side, since a missed
    // bell is worse than an early one (comment above).
    const sameDayRemainderClear = (text) => !STATED_TIMING.test(String(text || '').replace(SAME_DAY_TIMING_STRIP, ' '));
    const sameDayOnly = !unresolvedClock
      && SAME_DAY_TIMING.test(strippedQuote) && sameDayRemainderClear(strippedQuote)
      && !SAME_DAY_ALTERNATIVE.test(strippedQuote.replace(SAME_DAY_TIMING_STRIP, ' '))
      && !SAME_DAY_ALTERNATIVE.test(String(item.due_text || '').replace(SAME_DAY_TIMING_STRIP, ' '))
      && sameDayRemainderClear(item.due_text);
    if (!sameDayOnly) return { due_at: null, due_basis: null };
    const messageDate = new Date(messageCreatedAt);
    return { due_at: endOfBusinessDay(etDateString(messageDate), messageDate).toISOString(), due_basis: 'default_kind' };
  }
  const hours = item.basis === 'promise' ? PROMISE_DEFAULT_DEADLINE_HOURS : DEFAULT_DEADLINE_HOURS[item.kind];
  if (hours == null) return { due_at: null, due_basis: null };
  return { due_at: new Date(new Date(messageCreatedAt).getTime() + hours * 3600000).toISOString(), due_basis: 'default_kind' };
}

// True when a fact needs no human: a visit-only fact the scope guards stopped, or
// an access note held back as a temporary instruction (see the ruling above).
function isQuietTemporaryFact(f) {
  return (f.duration === 'visit_only' && VISIT_ONLY_SILENCED_OUTCOMES.includes(f.outcome))
    || (f.field === 'access_notes' && f.outcome === 'temporary_instruction');
}

// Plain words for the review bell (owner ruling 2026-10-21). The title names
// the customer; the body says what the reader wanted to save and why it
// stopped. It NEVER quotes the customer's text (title, body, detail or
// metadata): a text can hold a code, a spelled-out code word or an address, and
// no screen caught them all (Codex #6414 r1/r2). The first line is the whole
// visible bell (the admin brevity guard cuts a multi-line body at its first
// line and keeps the rest under "Show full text").
const REVIEW_FIELD_LABELS = Object.freeze({
  access_notes: 'access note', pet_details: 'pet note', contact_preference: 'contact preference',
  neighborhood_gate_code: 'neighborhood gate code', property_gate_code: 'gate code', lockbox_code: 'lockbox code',
  garage_code: 'garage code', irrigation_controller_location: 'irrigation controller location',
});
const REVIEW_REASONS = Object.freeze({
  existing_value_conflict: 'it conflicts with the note on file',
  temporary_instruction: 'the text sounds like a one-time instruction',
  property_ambiguous: 'it could not be tied to one property',
  contact_authority: 'the sender is not the main contact on the account',
  conflicting_facts: 'the text gives two different values for it',
  mixed_topics: 'the text mixes several topics',
  pet_needs_review: 'a "no" or "not sure" pet report needs a person to read it',
  irrigation_needs_review: 'a "no" or "not sure" report needs a person to read it',
  preference_uncertain: 'the contact preference is not clear',
  code_uncertain: 'the code does not clearly match this property',
  value_too_long: 'the value is too long to save',
  changed_during_extraction: 'the profile changed while the text was read',
});

// Why the reader stopped. The verdict code temporary_instruction is also what
// factVerdict returns for any duration that is not 'durable', so an 'uncertain'
// label gets its own words (Codex #6414 r3).
const UNCERTAIN_DURATION_REASON = 'it is not clear if this is lasting or just for one visit';
function reviewReason(f) {
  if (f.outcome === 'temporary_instruction' && f.duration === 'uncertain') return UNCERTAIN_DURATION_REASON;
  return REVIEW_REASONS[f.outcome] || 'it needs a person to check it';
}

// The admin-alert spec parts (docs/admin-notifications.md): a "Comms — ..."
// headline inside 60 characters, a one-sentence why inside 110, and the full
// reason lines in `detail`.
function reviewBellCopy({ customer, exceptions }) {
  const { fitAction, fullName } = require('./admin-alert-names');
  const name = fullName(customer);
  const action = name
    ? fitAction('Comms', name, [(n) => `check ${n}'s text note`, (n) => `check ${n}'s note`])
    : 'check a customer text note';
  const lines = exceptions.map((f, i) => {
    const label = REVIEW_FIELD_LABELS[f.field] || String(f.field).replaceAll('_', ' ');
    return `${i === 0 ? 'Wanted' : 'Also wanted'} to save as ${label}; ${reviewReason(f)}.`;
  });
  const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : '';
  const first = lines[0].replace(/\.$/, '');
  const room = MAX_WHY_CHARS - more.length - 1;
  const lead = first.length <= room ? `${first}.` : cutAtWord(first, room + 1);
  let why = `${lead}${more}`;
  if (breaksAlertRules(why)) why = 'Part of a customer text needs a person to check it.';
  return { action, why, detail: [...lines, 'Open the conversation to check.'].join('\n') };
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
    // The address fields feed the house-number and ZIP check of a natural-wording code at write time.
    const properties = await trx('customer_properties').where({ customer_id: customer.id, active: true }).select('id', 'address_line1', 'zip');
    const [current = {}] = await trx('property_preferences').where({ customer_id: customer.id }).forUpdate().limit(1).select('*');
    const sender = { inbound: message.from_phone, outbound: message.to_phone }[message.direction];
    const matches = await trx('customers').whereNull('deleted_at')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [tail(sender)]).limit(2).select('id');
    const senderIsPrimary = matches.length === 1 && matches[0].id === customer.id;
    const facts = await applyFacts(trx, message, extracted.facts, {
      properties, current, expectedCurrent: matchedContext.preferences, senderIsPrimary, messageBody: message.message_body,
      replayAppliedFields,
    });
    const additional = !replay && matchedContext.captureAdditionalProperties
      ? await require('./sms-additional-properties').stageAdditionalProperties({ trx, message: live, proposals: extracted.additional_properties })
      : null;
    if (obligations.length) await trx('call_commitments').insert(obligations.map((item) => {
      const propertyId = properties.length === 1 && properties.some((p) => p.id === item.property_id) ? item.property_id : null;
      const { due_at: dueAt, due_basis: dueBasis } = resolveDueDeadline(item, message.created_at);
      return {
        sms_log_id: message.id, commitment_key: keyOf({ ...item, property_id: propertyId }), party: item.party, kind: item.kind,
        description: item.description, channel: 'sms', due_at: dueAt,
        due_basis: dueBasis, source: 'ai', extractor_version: VERSION,
        evidence: JSON.stringify([{ quote: item.quote, sms_log_id: message.id, matched: true,
          speaker: { inbound: 'caller', outbound: 'agent' }[message.direction] }]),
        // The customer's only active property when the text arrived: an
        // unscoped cancel ask is answered only by a cancellation there, never
        // by a property that became the sole one later (Codex #4816 r20).
        sms_context: { basis: item.basis, due_text: item.due_text, property_id: propertyId,
          property_ambiguous: !propertyId,
          customer_id: customer.id, source_at: message.created_at,
          // Whether money landing can answer this ask at all: the
          // extraction's own judgement (answered_by_payment; a refund or a
          // payment-method change never is, however worded). Payment
          // admissibility and the event page read it, since an ask's words
          // never change after intake (Codex #4996 r6).
          ...(PAYMENT_WITNESS_KINDS.includes(item.kind) ? { money_answerable: item.answered_by_payment === true } : {}),
          // The day a staff promise named (groundExtraction checked it): the
          // completion check reads it, since due_at alone is a UTC instant.
          ...(item.basis === 'promise' && item.due_date ? { due_date: item.due_date } : {}) },
      };
    })).onConflict(['sms_log_id', 'commitment_key']).ignore();
    // The existing notifier writes only through trx. Preview rolls this back
    // with the proposals, while execution hashes the same dedupe decision.
    // Owner ruling 2026-09-24 (R4, the access-note text "my son should be
    // there"): a temporary access note is not urgent, so a fact the
    // extractor labels visit_only never rings the review bell on its own.
    // It still rides in `analysis.facts` and counts toward
    // `unverified_count` on a bell some OTHER real exception raises.
    // - Keyed on the extractor's label (the schema's only temporary value),
    //   whichever SCOPE guard caught the fact first: a visit-only fact is
    //   never written, so property ambiguity, contact authority, a duplicate
    //   or mixed topics add nothing for staff to decide (Codex #4816
    //   r29/r32). An allowlist, so a safety review (a negated or uncertain
    //   pet/irrigation report) or any future outcome still rings (r34).
    // - 'uncertain' is the extractor asking for review, so it rings (r10).
    // - A durable fact held back only by temporary wording rings: every fact
    //   quotes the whole message, so the wording cannot be tied to it ("I'm
    //   away tomorrow. My lockbox code is 1234") (r26/r27).
    // Owner ruling 2026-10-21 ("what does sms instructions need review do?",
    // all fixes go): a held-back ACCESS NOTE never rings on its own, whatever
    // duration label the extractor gave it. Live rows that rang for nothing:
    // "It's the door up the sidewalk" and "You are welcome to come earlier..
    // I'm here" (both 'uncertain'). An access note is a how-to-reach-the-door
    // line, not a safety fact, and held back by temporary wording it is by
    // definition not a profile write. Narrow on purpose: the field is named,
    // so a gate/lockbox code, a pet or irrigation report held back the same
    // way (the r10/r26/r27 cases above) still rings.
    const settled = ['applied', 'unchanged', 'proposed', 'superseded', 'previously_applied'];
    const temporaryFacts = facts.filter(isQuietTemporaryFact);
    const exceptions = facts.filter((f) => !settled.includes(f.outcome) && !temporaryFacts.includes(f));
    let notification = null;
    // Owner ruling 2026-09-24: dropped model proposals (rejected by the
    // grounding filter) are not, on their own, a real exception — only a
    // fact that actually needs a human decision rings the review bell.
    // `dropped` still rides in `operational_analysis` and, when a bell does
    // fire for a real exception, in that bell's `unverified_count`.
    if (exceptions.length) {
      const copy = reviewBellCopy({ customer, exceptions });
      const notif = await raiseAdminAlert('alert', {
        area: 'Comms', action: copy.action, why: copy.why, severity: 'needs-you',
        link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}&tab=comms`,
        subject: { type: 'customer', id: String(customer.id) }, doneWhen: 'text_note_checked', who: 'person',
      }, { trx, bell: true, dedupeKey: `sms-property-instructions:${message.id}`, detail: copy.detail,
        metadata: { triggerKey: 'sms_operational_exception', customerId: customer.id, sms_log_id: message.id,
          fields: exceptions.map((f) => f.field), unverified_count: extracted.dropped + temporaryFacts.length,
          reasons: [...new Set(exceptions.map((f) => f.outcome))] } });
      if (!notif.id) throw new Error('sms_operations_bell_not_persisted');
      notification = notif.deduped
        ? { action: 'preserve_notification', notification_id: notif.id }
        : { action: 'create_notification' };
    }
    let analysis = { version: VERSION, processed_at: new Date().toISOString(), facts, additional_properties: additional, dropped: extracted.dropped };
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

// What the follow-up bell says is owed, per kind (owner audit 2026-10-01: a bell must
// name WHO and WHAT). `action` completes "<Area> — <action>" with the customer's name;
// `open` ends the why when nothing on file shows the work done. A promise staff texted
// (basis 'promise') is owed the same thing, so it shares the kind's wording; only the
// why changes ("We said ..." instead of the customer's own words).
const KIND_ALERT = {
  send_estimate: { area: 'Comms', action: (n) => `send ${n} the estimate`, open: 'no estimate sent yet' },
  callback: { area: 'Comms', action: (n) => `call ${n} back`, open: 'no callback on record yet' },
  send_report: { area: 'Comms', action: (n) => `send ${n} the report`, open: 'no report sent yet' },
  send_paperwork: { area: 'Comms', action: (n) => `send ${n} the paperwork`, open: 'no paperwork sent yet' },
  technician_follow_up: { area: 'Comms', action: (n) => `have a tech follow up with ${n}`, open: 'no tech follow-up on record yet' },
  schedule_visit: { area: 'Schedule', action: (n) => `schedule ${n}'s visit`, open: 'no visit scheduled yet' },
  send_appointment_confirmation: { area: 'Schedule', action: (n) => `confirm ${n}'s appointment`, open: 'no confirmation sent yet' },
  send_reschedule_link: { area: 'Schedule', action: (n) => `send ${n} the reschedule link`, open: 'no reschedule link sent yet' },
  other: { area: 'Comms', action: (n) => `follow up with ${n}`, open: 'nothing on record shows it done' },
};

// An ask row's emails.customer_id, else the row's own email_customer_id —
// the same resolution email-operational-actions.js uses; both follow a
// customer merge.
const RESOLVED_EMAIL_CUSTOMER_ID_SQL = 'COALESCE(e.customer_id, cc.email_customer_id)';

// Only the customer profile opts into SMS/email rows. Call queues and
// workers continue using their call-scoped reader and implicit deadline
// rules. Coordinator correction #4, 2026-09-29: the SMS branch's own
// query/columns are UNCHANGED (a plain UNION ALL with a second, email-
// sourced branch, kept to compatible column names) — an SMS row's output
// shape is byte-identical to before. `channel` distinguishes the two for a
// reader (e.g. the customer-profile panel's own label).
// `channels` (optional, additive): read only these sources ('sms' / 'email') so a
// caller that renders one channel's rows is not bounded by the other's.
// `lane` (optional, additive): 'request' = asks the customer is waiting on
// (sms_context.basis 'request'); 'promise' = Waves-owned promises (party waves,
// any other basis) — so a caller rendering one lane is not bounded by the other.
const SMS_COMMITMENT_LANES = {
  request: (b) => b.whereRaw("cc.sms_context->>'basis' = 'request'"),
  promise: (b) => b.where('cc.party', 'waves').whereRaw("COALESCE(cc.sms_context->>'basis', '') <> 'request'"),
};
async function listSmsCommitments(conn, { customerId, limit = 20, offset = 0, now = new Date(), channels = null, lane = null }) {
  const byLane = (b) => { if (SMS_COMMITMENT_LANES[lane]) SMS_COMMITMENT_LANES[lane](b); };
  const smsRows = conn('call_commitments as cc')
    .join('sms_log as s', 's.id', 'cc.sms_log_id')
    .join('customers as c', 'c.id', 's.customer_id')
    .where({ 's.customer_id': customerId, 'cc.status': 'open' }).whereNull('c.deleted_at')
    .modify(byLane)
    .select('cc.id', 'cc.party', 'cc.kind', 'cc.description', 'cc.status', 'cc.due_at', 'cc.human_note',
      'cc.sms_log_id', conn.raw('NULL::uuid as email_id'), 's.created_at as sms_started_at',
      's.customer_id', conn.raw("'sms' as channel"));
  const emailRows = conn('call_commitments as cc')
    .join('emails as e', 'e.id', 'cc.email_id')
    .whereRaw(`${RESOLVED_EMAIL_CUSTOMER_ID_SQL} = ?`, [customerId]).where({ 'cc.status': 'open' })
    .whereExists(function availableCustomer() {
      this.select(1).from('customers as c').whereRaw(`c.id = ${RESOLVED_EMAIL_CUSTOMER_ID_SQL}`).whereNull('c.deleted_at');
    })
    .modify(byLane)
    .select('cc.id', 'cc.party', 'cc.kind', 'cc.description', 'cc.status', 'cc.due_at', 'cc.human_note',
      conn.raw('NULL::uuid as sms_log_id'), 'cc.email_id', 'e.received_at as sms_started_at',
      conn.raw('?::uuid as customer_id', [customerId]), conn.raw("'email' as channel"));
  const wanted = Array.isArray(channels) ? channels : ['sms', 'email'];
  const parts = [wanted.includes('sms') && smsRows, wanted.includes('email') && emailRows].filter(Boolean);
  if (!parts.length) return [];
  const rows = await conn.unionAll(parts, true)
    .orderByRaw('due_at ASC NULLS LAST, sms_started_at ASC, id ASC')
    .limit(Math.max(1, Math.min(201, Number(limit) || 20)))
    .offset(Math.max(0, Number(offset) || 0));
  return rows.map((row) => ({ ...row, overdue: !!row.due_at && new Date(row.due_at) <= now }));
}

const stale = (message) => Object.assign(new Error(message), { status: 409 });

// Lock the source row the commitment hangs on and prove the requested profile
// still owns it (a merge or relink may have moved it while controls were open).
async function lockCommitmentSource(trx, initial, id, customerId) {
  if (initial.sms_log_id) {
    const source = await trx('sms_log').where({ id: initial.sms_log_id }).forUpdate().first();
    if (source?.customer_id !== customerId) throw stale('SMS follow-up moved; reload this profile');
    return source.id;
  }
  const source = await trx('emails').where({ id: initial.email_id }).forUpdate().first();
  if (!source) throw stale('Email follow-up moved; reload this profile');
  const row = await trx('call_commitments').where({ id }).first('email_customer_id');
  // An ask row's emails.customer_id follows a merge; a staff promise's
  // SENT row never carries one (email-sync.js never sets it on a SENT
  // row), so its own email_customer_id does — same rule as refresh.
  if ((source.customer_id || row?.email_customer_id) !== customerId) throw stale('Email follow-up moved; reload this profile');
  return source.id;
}

// The commitment is still this source's, still open, and its lane is on.
async function assertCommitmentOpen(trx, initial, id, sourceId) {
  const current = await trx('call_commitments').where({ id }).forUpdate().first();
  const channel = initial.sms_log_id ? 'SMS' : 'Email';
  if ((initial.sms_log_id ? current?.sms_log_id : current?.email_id) !== sourceId || current.status !== 'open') {
    throw stale(`${channel} follow-up changed; reload this profile`);
  }
  const gateOpen = initial.sms_log_id ? smsCommitmentsEnabled() : gateEnvValue('GATE_EMAIL_OPERATIONAL_ACTIONS');
  if (!gateOpen) throw stale(`${channel} follow-up is disabled`);
}

// Staff settled the promise (dismiss / fulfill): its bell is done, by that
// person. Any other staff update (an edit, a snooze) leaves the promise
// open, so the bell is only read.
// done_by names the workflow and the person (`sms-commitments:<id>`),
// never a bare person id: the follow-up itself is closed, so the bell
// Done is not a person's to Reopen (PERSON_DONE_BY_SQL refuses it).
async function settleCommitmentAlert(trx, initial, id, { action, reviewedBy }) {
  const settled = ['dismiss', 'fulfill'].includes(action);
  const channel = initial.sms_log_id ? 'sms' : 'email';
  // Any other staff update leaves the promise open, so its bell is only read.
  const update = settled
    ? require('./notification-service')._private.doneColumns({ by: `${channel}-commitments:${reviewedBy}`, resolution: `Follow-up ${action === 'dismiss' ? 'dismissed' : 'marked done'} by staff`, keepExisting: true, conn: trx })
    : { read_at: trx.fn.now() };
  if (initial.sms_log_id) await closeSmsCommitmentAlerts(trx, { commitmentId: id, smsLogId: initial.sms_log_id, settled }, update);
  else await trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [`email-commitment:${id}`]).update(update);
}

// GATE_SMS_FOLLOWUP_WITNESS_FIX (docs/admin-notifications.md: the emitter that
// raises a row owns clearing it). A person's Done on a text follow-up bell
// used to write only the notifications row, so the next sweep tick saw the
// commitment still open and rang again. Done now also marks every open
// promise the bell speaks for as done, by that person, through the same
// writer as the profile panel's Mark done (human_state, reviewed_by,
// reviewed_at, audit event). Returns the number of commitments settled.
// Best effort per commitment: one that changed since (already closed, source
// moved) is skipped and logged, never a failure for the Done click.
const SMS_ALERT_KEY = /^sms-commitment(?:-source)?:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
async function settleCommitmentsForDoneAlert(conn, notificationId, { reviewedBy }) {
  if (!require('../config/feature-gates').smsFollowupWitnessFixLive() || !reviewedBy) return 0;
  const alert = await conn('notifications').where({ id: notificationId, recipient_type: 'admin' }).first('metadata');
  let metadata = alert?.metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch (_) { metadata = null; } }
  const key = String(metadata?.dedupeKey || '');
  const match = SMS_ALERT_KEY.exec(key);
  if (!match || !metadata.customerId) return 0;
  const ids = key.startsWith('sms-commitment-source:')
    ? await openSourceCommitments(conn, match[1]).pluck('id')
    : [match[1]];
  let settled = 0;
  for (const id of ids) {
    try {
      await applySmsCommitmentUpdate(conn, id, { customerId: metadata.customerId, action: 'fulfill', note: 'Marked done from the alert', reviewedBy });
      settled += 1;
    } catch (err) {
      logger.warn(`[sms-operations] Done on alert ${notificationId} left commitment ${id} as is: ${err.message}`);
    }
  }
  return settled;
}

async function applySmsCommitmentUpdate(conn, id, { customerId, action, note, reviewedBy }) {
  if (!['fulfill', 'dismiss'].includes(action)) throw Object.assign(new Error('SMS follow-up supports Mark done or Dismiss'), { status: 400 });
  if (note !== undefined && typeof note !== 'string') throw Object.assign(new Error('note must be text'), { status: 400 });
  return conn.transaction(async (trx) => {
    const initial = await trx('call_commitments').where({ id }).first('sms_log_id', 'email_id', 'kind');
    if (!initial?.sms_log_id && !initial?.email_id) throw Object.assign(new Error('SMS follow-up not found'), { status: 404 });
    // A reschedule-link promise's office verdict also retires a call-log-
    // ONLY delivery ledger inside applyHumanUpdate (reschedule-link-
    // promises.js, reached by call_log_id alone) — no email analog exists.
    // Refused here rather than risk that path with a null call_log_id
    // (coordinator correction #4, 2026-09-29 — the one deliberate scope
    // limit on this generalization, reported rather than patched around).
    if (initial.email_id && initial.kind === 'send_reschedule_link') throw stale('This follow-up needs staff review outside this panel');
    // Match intake/watcher lock order. The requested profile must still own
    // the source after a merge or relink while its controls were open.
    const customer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first('id');
    if (!customer) throw stale('Customer unavailable');
    const sourceId = await lockCommitmentSource(trx, initial, id, customerId);
    await assertCommitmentOpen(trx, initial, id, sourceId);
    const { applyHumanUpdate } = require('./call-commitments');
    const updated = await applyHumanUpdate(trx, id, { action, note, reviewedBy });
    // Staff tokens resolve to technicians rows, including the admin role.
    await recordAuditEvent({ trx, critical: true, actor_type: 'technician', actor_id: reviewedBy,
      action: `${initial.sms_log_id ? 'sms' : 'email'}.commitment.${action}`, resource_type: 'call_commitment', resource_id: id,
      metadata: { sms_log_id: initial.sms_log_id || null, email_id: initial.email_id || null, customer_id: customerId } });
    await settleCommitmentAlert(trx, initial, id, { action, reviewedBy });
    return updated;
  });
}

// Codex #4816 r15–r19: the newest visit activity for the row's customer,
// after the source text, that the event page has not scanned yet — newer
// than the sms_context.event_seen_at watermark. The same activity
// loadSmsFulfillmentEvidence reads (creation, completion, a status
// transition, a logged move); admissibility still decides whether it
// answers the row. A watermark rather than a lookback window or cursor: the
// page drains every pending event however many rows qualify, a scanned row
// leaves it until new activity lands, and no event expires unseen. The
// watermark advances only to the activity this read actually saw (as text,
// keeping microseconds), never to the tick time, so a visit write that
// commits after the read with an earlier timestamp stays unseen (r19).
// Visit writers stamp their activity with the transaction-start time
// (job_status_history.transitioned_at defaults to now()), so one that began
// before a read can commit after it with an earlier timestamp than anything
// the read saw (Codex #4816 r20). The watermark therefore never passes
// now - EVENT_COMMIT_GRACE_MS, which outlasts any visit transaction: such a
// write stays above it. A fresh event is re-scanned for a tick or two until
// the cap passes it; the verdict cache makes that free of model calls.
const EVENT_COMMIT_GRACE_MS = 10 * 60 * 1000;
const RETRY_AFTER_SQL = "(cc.sms_context->'fulfillment_check'->>'retry_after')::timestamptz";
// Anchored to the obligation's effective source time: a scheduled outbound
// promise's queue row predates the delivery that actually made it (Codex
// #4816 r27).
const SOURCE_AT = "COALESCE((cc.sms_context->>'source_at')::timestamptz, s.created_at)";
// The watermark was read against one customer's visits: after a merge or
// merge undo moves the source SMS, it no longer applies (Codex #4816 r28).
const EVENT_SEEN_AT = `CASE WHEN cc.sms_context->>'event_seen_customer_id' = s.customer_id::text
  THEN (cc.sms_context->>'event_seen_at')::timestamptz END`;
const UNSEEN_FLOOR = `GREATEST(${SOURCE_AT}, COALESCE(${EVENT_SEEN_AT}, ${SOURCE_AT}))`;
// The floor and the tick bound sit in every branch, so each scan starts from
// the row's watermark rather than the customer's whole visit history.
const unseen = (column) => `${column} <= ? AND ${column} > ${UNSEEN_FLOOR}`;
// Visit activity, and money landing (R2): a payments row that can be
// evidence (paymentEvidenceRow, the payment legs' own test) or a received
// estimate deposit. Without the money branches a payment-only ask waited for
// its cursor page — a full rotation under backlog (Codex #4996 r1). Money
// wakes only the kinds that can cite it, and only through a row a leg reads:
// a callback or report row it cannot answer must not take a slot from a
// settlement question (r4), nor may a fee or a refund in flight (r9). A
// payment or deposit counts from when its row last changed, not its
// settlement stamp: a late webhook records a settlement from hours or days
// ago (stripe-webhook.js), which the watermark has long passed.
const PAYMENT_CHANGED_AT = "GREATEST(pm.updated_at, COALESCE((pm.metadata->>'settled_event_at')::timestamptz, pm.created_at))";
// Read against the event page's candidate row, like RETRY_AFTER_SQL and
// SOURCE_AT: `cc` is the open call_commitments row and `s` its source
// sms_log row (openRows in refreshSmsCommitments). An ask money can answer
// carries the extraction's stamp; one without it never wakes on money, as
// money never answers it.
const MONEY_KIND = `cc.kind IN (${PAYMENT_WITNESS_KINDS.map((v) => `'${v}'`).join(', ')})
  AND cc.sms_context->>'money_answerable' = 'true'`;
// Whose estimate a deposit is on: the customer's own, or an unowned one a
// lead of theirs names. A superset of whereEstimateCustomerOwnership (which
// also drops estimates another lead claims) is enough to trigger a check;
// the evidence read applies the exact rule.
const ESTIMATE_MAY_BELONG = `(e.customer_id = s.customer_id OR (e.customer_id IS NULL AND (
    e.id IN (SELECT l.estimate_id FROM leads l WHERE l.deleted_at IS NULL AND l.customer_id = s.customer_id)
    OR e.estimate_data ->> 'lead_id' IN (SELECT l.id::text FROM leads l WHERE l.deleted_at IS NULL AND l.customer_id = s.customer_id))))`;
const UNSEEN_EVENT_ACTIVITY = `(SELECT MAX(a.at) FROM (
    SELECT v.created_at AS at FROM scheduled_services v WHERE v.customer_id = s.customer_id AND ${unseen('v.created_at')}
    UNION ALL SELECT v.completed_at FROM scheduled_services v WHERE v.customer_id = s.customer_id AND ${unseen('v.completed_at')}
    UNION ALL SELECT h.transitioned_at FROM job_status_history h JOIN scheduled_services v ON v.id = h.job_id
      WHERE v.customer_id = s.customer_id AND ${unseen('h.transitioned_at')}
        AND h.to_status IN (${WITNESS_TRANSITION_STATUSES.map((v) => `'${v}'`).join(', ')})
    UNION ALL SELECT r.created_at FROM reschedule_log r JOIN scheduled_services v ON v.id = r.scheduled_service_id
      WHERE v.customer_id = s.customer_id AND ${unseen('r.created_at')}
        AND ${LOGGED_MOVE_SQL('r')}
    UNION ALL SELECT ${PAYMENT_CHANGED_AT} FROM payments pm WHERE ${MONEY_KIND} AND pm.customer_id = s.customer_id
        AND ${paymentEvidenceRow('pm')} AND ${unseen(PAYMENT_CHANGED_AT)}
    UNION ALL SELECT GREATEST(ed.updated_at, ed.received_at) FROM estimate_deposits ed JOIN estimates e ON e.id = ed.estimate_id
      WHERE ${MONEY_KIND} AND ed.status IN ('received', 'credited') AND ${unseen('GREATEST(ed.updated_at, ed.received_at)')}
        AND ${ESTIMATE_MAY_BELONG}
  ) a)`;

// Match merge and intake: customer, source, then commitment. A relink, an
// edited or ineligible source, a gate turned off, or a row a person already
// closed while verification ran all return null, so the verdict is retried
// against the current state.
async function lockLiveCommitment(trx, row, message) {
  const customer = await trx('customers').where({ id: message.customer_id }).whereNull('deleted_at').forUpdate().first('id');
  const source = customer && await scheduledSourceMessage(trx, await trx('sms_log').where({ id: message.id }).forUpdate().first());
  const sameSource = !!source && eligibleMessage(source, { captured: true })
    && source.customer_id === message.customer_id && source.message_body === message.message_body;
  const live = sameSource && await trx('call_commitments').where({ id: row.id }).forUpdate().first();
  return live && smsCommitmentsEnabled() && live.status === 'open' && live.human_state == null ? { source, live } : null;
}

// The explanation behind the bell, kept in `detail` (the why carries the customer's
// words instead). `when` is the ET time the message arrived; `channel` is sms or email.
const OVERDUE_BELL_DETAIL = {
  uncertain: (when, word) => `The ${when} ET ${word} needs a completion check. Some follow-up evidence is unavailable or ambiguous; the agent cannot determine whether the work was completed. Open the customer profile to verify.`,
  open: (when, word) => `Requested or promised in the ${when} ET ${word}. The available follow-up records do not establish completion. Open the customer profile to take the next step.`,
  late: (when, word) => `Promised in the ${when} ET ${word}. The records show it done only after the promised deadline. Open the customer profile to follow up.`,
};

// The words that created the obligation: the extraction's grounded quote, else its
// description, else (a text only) the message itself.
function obligationWords(row, message) {
  let evidence = row.evidence;
  if (typeof evidence === 'string') { try { evidence = JSON.parse(evidence); } catch (_) { evidence = null; } }
  const quoted = Array.isArray(evidence) ? evidence.map((item) => item?.quote).find((q) => typeof q === 'string' && q.trim()) : null;
  return quoted || row.description || message.message_body || '';
}

// The words the bell's headline quotes. One message can hold several
// obligations, each with the same evidence quote (prod 2026-10-06: two promises
// in one staff text rang two bells with the same first sentence). When the
// obligation's own description appears in the ORIGINAL quote as whole words,
// that slice of the quote is redacted and quoted, so each bell names its own
// promise and every word shown is the sender's. Matching runs before
// redaction, so two promises that differ only in a contact detail still find
// their own slices. Anything the slice cannot carry alone (sentence
// punctuation, any token the alert composer forbids) keeps today's headline:
// the quote's first sentence.
// Unicode-aware (any script; combining marks belong to their word). Scripts
// written without spaces between words (Han, kana, Hangul stems + endings,
// Thai, ...) get no edge check. Script_Extensions, not Script: shared marks
// such as the kana prolonged-sound mark ー are Common by Script.
const LETTER = /[\p{L}\p{N}\p{M}]/u;
const UNSPACED_SRC = '[\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}]';
const UNSPACED = new RegExp(UNSPACED_SRC, 'u');
// The edge's base character: the first one, or the last one before any
// trailing combining marks.
function needsEdge(chars) {
  const base = chars.find((ch) => !/\p{M}/u.test(ch));
  return base !== undefined && LETTER.test(base) && !UNSPACED.test(base);
}
function matchedSlice(rawQuote, description) {
  const part = typeof description === 'string' ? description.trim().replace(/[.!?。！？]+$/u, '') : '';
  if (!LETTER.test(part)) return null;
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const chars = [...part];
  // An edge only rejects a neighbour from a SPACED script: a Japanese or
  // Korean ending attached to a Latin word (PDFを) is still a word break.
  const lead = needsEdge(chars) ? `(?<!(?!${UNSPACED_SRC})[\\p{L}\\p{N}\\p{M}_])` : '';
  const tail = needsEdge([...chars].reverse()) ? `(?!(?!${UNSPACED_SRC})[\\p{L}\\p{N}\\p{M}_])` : '';
  const found = new RegExp(`${lead}${escaped}${tail}`, 'iu').exec(rawQuote);
  return found ? found[0] : null;
}
// Is the matched text one plain phrase? Judged on the ORIGINAL words, before
// redaction rewrites them. Only two periods are allowed: inside an email
// address (lowercase domain, so "a@b.com.Then" still ends a sentence) and
// between two digits (2.5). Every other period, including a bare domain
// (example.com is a URL the alert rules mean to keep out), and any ! ? or
// CJK sentence ender, is a break.
const EMAIL_TOKEN = /[\p{L}\p{N}._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gu;
function isPlainPhrase(raw) {
  const rest = raw.replace(/[.!?。！？]+$/u, '').replace(EMAIL_TOKEN, '').replace(/(?<=\p{N})\.(?=\p{N})/gu, '');
  return !/[.!?。！？]/u.test(rest);
}
function headlineWords(quote, rawQuote, description, redact) {
  const compose = require('./admin-alert-compose');
  const raw = matchedSlice(rawQuote, description);
  const slice = raw && isPlainPhrase(raw) && redact(raw).replace(/\s+/g, ' ').trim().replace(/[.!?。！？]+$/u, '');
  if (slice && !compose.breaksAlertRules(slice)) return slice;
  return compose.firstSentence(quote).replace(/[.!?]+$/, '');
}

// Owner ruling 2026-09-28: a staff promise kept late rings the bell, then
// clears. The deadline tick normally rings before the late record lands; when
// verification runs only after both (Codex #5248 r3), the late record rings
// the bell first and closes the row on a later tick.
function keptLate(row, verdict) {
  // A close from the later text thread (the customer said they got it, or a
  // person said it was sent) is not a late record: nothing is left to ring.
  return verdict.verdict === 'fulfilled' && verdict.basis !== THREAD_BASIS && row.sms_context?.basis === 'promise' && row.due_at != null
    && new Date(verdict.matched_at) > new Date(row.due_at);
}

// One open admin alert per source text (owner 2026-10-22): a single staff
// text such as "Adam will be out there and he'll look into it" yields several
// commitments, and each used to ring its own alert. The alert is keyed on the
// source sms_log row and lists every open promise from that text. Alerts an
// older build keyed on one commitment (`sms-commitment:<id>`) are still found
// and closed by every path below.
const smsSourceAlertKey = (smsLogId) => `sms-commitment-source:${smsLogId}`;
const legacyCommitmentAlertKey = (commitmentId) => `sms-commitment:${commitmentId}`;
const openSourceCommitments = (conn, smsLogId) => conn('call_commitments')
  .where({ sms_log_id: smsLogId, status: 'open', party: 'waves' }).whereNull('human_state')
  .orderBy('created_at').orderBy('id');

// Close the alert for a finished commitment. The shared source alert stays
// open while another promise from the same text is still open. `openOnly`
// touches open rows only: a temporary close (GATE_PROMISE_RECORD_EVIDENCE
// rule 3, on track until a visit) never takes over a row a person marked done.
// `needsAlert` (optional) narrows the text's other open promises to those that
// still need the alert (rule 3: one the same visit rule holds does not).
async function closeSmsCommitmentAlerts(trx, { commitmentId, smsLogId, settled = true, openOnly = false, needsAlert = null }, update) {
  // A non-settling update (edit, snooze) marks both alerts read; a settling
  // one finishes the shared alert only when no other promise from the text is open.
  const others = settled ? await openSourceCommitments(trx, smsLogId).whereNot('id', commitmentId) : [];
  const remaining = needsAlert ? await needsAlert(others) : others;
  const keys = [legacyCommitmentAlertKey(commitmentId), ...(remaining.length ? [] : [smsSourceAlertKey(smsLogId)])];
  await trx('notifications').where({ recipient_type: 'admin' }).modify((q) => { if (openOnly) q.whereNull('done_at'); })
    .whereIn(trx.raw("metadata->>'dedupeKey'"), keys).update(update);
  if (remaining.length) await refreshSharedSmsAlert(trx, smsLogId, remaining);
}

// The shared alert keeps naming a promise that has since settled. Rewrite its
// copy and commitment list to the promises still open; it stays open and does
// not ring again (refresh of an OPEN row only; nothing is created).
async function refreshSharedSmsAlert(trx, smsLogId, remaining) {
  const dedupeKey = smsSourceAlertKey(smsLogId);
  const queued = await trx('sms_log').where({ id: smsLogId }).first(...SOURCE_COLUMNS);
  // The same source the ring used: a scheduled text reads as its actual delivery.
  const source = queued && await scheduledSourceMessage(trx, queued);
  const shared = source && await trx('notifications').where({ recipient_type: 'admin' }).whereNull('done_at')
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).forUpdate().first('id');
  if (!shared) return;
  // The state comes from the promises still open, never from the one that just
  // settled (a settled promise's "kept late" must not stay on the alert).
  await ringOverdueBell(trx, { row: remaining[0], message: source, verdict: sourceAlertVerdict({ verdict: 'open' }, remaining),
    dedupeKey, promises: remaining, refreshOnly: true });
}

// The bell's words (owner audit 2026-10-01): the customer's name and what is owed in the
// headline, their quoted words in the why, the whole story in `detail`.
// The parts of the bell that differ between one promise and several from one
// text: the kind's wording, the quoted lines, the headline words and the status.
function bellParts({ row, message, group, names, closing, state }) {
  const rawQuote = obligationWords(row, message);
  const quote = names.redactedWords(rawQuote);
  if (!group) {
    const alert = KIND_ALERT[row.kind] || KIND_ALERT.other;
    return { alert, promised: row.sms_context?.basis === 'promise', quoteLine: quote ? `“${quote.slice(0, 600)}”` : null,
      closingLine: closing, openStatus: alert.open, headline: quote && headlineWords(quote, rawQuote, row.description, names.redactedWords) };
  }
  // The words each promise is quoted by; promises that quote alike show once.
  const words = [...new Set(group.map((item) => {
    const raw = obligationWords(item, message);
    return headlineWords(names.redactedWords(raw), raw, item.description, names.redactedWords);
  }).filter(Boolean))];
  const kinds = new Set(group.map((item) => item.kind));
  return { alert: KIND_ALERT[kinds.size === 1 ? row.kind : 'other'] || KIND_ALERT.other,
    promised: group.every((item) => item.sms_context?.basis === 'promise'),
    quoteLine: words.map((w) => `• “${w.slice(0, 300)}”`).join('\n'),
    closingLine: `${group.length} follow-ups from this one ${state.channelWord} are still open. ${closing}`,
    openStatus: 'nothing on record shows them done', headline: words.join('” and “') };
}

function overdueBellCopy({ row, message, verdict, customerName, channelWord, promises = null }) {
  const names = require('./admin-alert-names');
  const when = new Date(message.created_at).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const state = verdict.late ? 'late' : verdict.verdict;
  // One text with several promises: one alert that names all of them. Same
  // kind keeps the kind's wording; mixed kinds fall back to a general follow-up.
  const group = Array.isArray(promises) && promises.length > 1 ? promises : null;
  const closing = (OVERDUE_BELL_DETAIL[state] || OVERDUE_BELL_DETAIL.open)(when, channelWord);
  const parts = bellParts({ row, message, group, names, closing, state: { channelWord } });
  const status = state === 'late' ? 'done only after the promised time'
    : (state === 'uncertain' ? "can't tell if it was done" : parts.openStatus);
  const day = names.shortDateET(message.created_at);
  const detail = [
    `${customerName || 'A customer'}: ${parts.promised ? `we promised ${group ? 'these' : 'this'} by ${channelWord}` : `asked by ${channelWord}`} on ${when} ET.`,
    parts.quoteLine, parts.closingLine,
  ].filter(Boolean).join('\n');
  return {
    detail,
    spec: {
      area: parts.alert.area,
      action: names.fitAction(parts.alert.area, customerName || 'the customer', [parts.alert.action]),
      why: names.whyWithQuote({ lead: parts.promised ? 'We said ' : '', quote: parts.headline,
        tail: `${day ? ` (${day})` : ''} — ${status}.` }),
      severity: 'needs-you',
      link: `/admin/customers?customerId=${encodeURIComponent(message.customer_id)}&tab=comms`,
      subject: { type: 'customer', id: message.customer_id },
      doneWhen: 'promise_fulfilled',
      who: 'person',
    },
  };
}

// The deadline passed and the records do not establish completion.
// sourceIdField/triggerKey are optional overrides, added so
// email-operational-actions.js can reuse this exact bell/dedupe/close
// mechanics with its own source column (email_id) — coordinator correction
// #3, 2026-09-29: "export and reuse ringOverdueBell ... through small
// exports only". An email source also words the bell for an email. The bell
// names the customer and quotes the words behind it (owner audit 2026-10-01);
// the title is not the dedupe key (dedupeKey is), so the wording may change.
// Every existing SMS caller omits the overrides, so the SMS bell keeps its
// dedupe, link and metadata shape.
async function ringOverdueBell(trx, { row, message, verdict, dedupeKey, sourceIdField = 'sms_log_id', triggerKey = 'sms_operational_followup', promises = null, refreshOnly = false }) {
  const customerName = await require('./admin-alert-names').lookupCustomerName(trx, message.customer_id);
  const { spec, detail } = overdueBellCopy({ row, message, verdict, customerName, channelWord: sourceIdField === 'email_id' ? 'email' : 'text', promises });
  const ringOpts = {
    trx, bell: true, dedupeKey, dedupeWindowMs: 24 * 60 * 60 * 1000, refreshOnDedupe: true, detail,
    metadata: { triggerKey, customerId: message.customer_id,
      [sourceIdField]: message.id, commitment_id: row.id, kind: row.kind, verification: verdict.late ? 'kept_late' : verdict.verdict,
      ...(promises ? { commitment_ids: promises.map((item) => item.id) } : {}) } };
  // GATE_ALERT_RING_ONCE (owner 2026-10-14): a promise rings once. The probe
  // looks only at OPEN rows, at any age: an open row is refreshed without a
  // ring (read state, done state and push stay), so a later check never makes
  // a new row. With no open row (first time, or a person marked it done and
  // the promise is still overdue) the insert is fresh: one new row, one bell.
  const ringOnce = require('../config/feature-gates').alertRingOnceLive?.();
  const notification = await raiseAdminAlert('alert', spec, ringOnce || refreshOnly
    ? { ...ringOpts, dedupeWindowMs: undefined, dedupeOpenOnly: true, ringOnRefresh: () => false }
    : ringOpts);
  if (!notification?.id && !notification?.suppressed) throw new Error('sms_operations_bell_not_persisted');
  // The 24h window rolls from created_at, so a promise still overdue after a
  // day gets a NEW row and the old one stayed open: one promise piled up four
  // to six unread rows (prod 2026-10-05). The daily re-ring stays; only the
  // newest row for this key may stay open. Runs for a deduped result too, so
  // rows an older build left behind close on the next ring. openToCloser: a
  // row a person marked done is taken over too (their Reopen would bring an
  // obsolete duplicate back); a row a system component closed is left alone.
  if (notification.id && !refreshOnly) {
    const { doneColumns, openToCloser } = require('./notification-service')._private;
    await openToCloser(trx('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .whereNot({ id: notification.id }), 'supersede')
      .update(doneColumns({ by: 'supersede', resolution: 'Replaced by a newer reminder for the same promise', keepExisting: true, conn: trx }));
  }
  return notification;
}

// One alert speaks for every promise from the text, so its state is read from
// all of them, not from whichever row the scan reached first. Precedence:
// uncertain > kept late > open. "Can't tell if it was done" is the strongest
// claim to make the office look (a person must check), so it wins; a promise
// that was kept but late (overdueBellCopy's 'late' wording) outranks plain open
// so a late-but-done promise never reads as "nothing on record shows it done".
// `scannedId` is the row being scanned now; its state is `verdict`, the others
// are read from their stored checks. Order-independent: it is a max over states.
const STATE_RANK = { open: 0, late: 1, uncertain: 2 };
function promiseState(item) {
  const check = item.sms_context?.fulfillment_check;
  if (check?.verdict === 'uncertain') return 'uncertain';
  return check && keptLate(item, check) ? 'late' : 'open';
}
function sourceAlertVerdict(verdict, promises, scannedId = null) {
  const own = verdict.late ? 'late' : (verdict.verdict === 'uncertain' ? 'uncertain' : 'open');
  const states = [own, ...promises.filter((item) => item.id !== scannedId).map(promiseState)];
  const top = states.reduce((best, state) => (STATE_RANK[state] > STATE_RANK[best] ? state : best), 'open');
  if (top === 'uncertain') return { ...verdict, verdict: 'uncertain', late: false };
  return top === 'late' ? { ...verdict, late: true } : verdict;
}

// The overdue alert for a text commitment: one open alert per source text,
// listing every open promise from it. An alert an older build keyed on one
// commitment is closed in its favor. `row` is the commitment that triggered the
// ring; it leads the list.
async function ringSmsSourceBell(trx, { row, message, verdict }) {
  const open = await openSourceCommitments(trx, message.id);
  const promises = [row, ...open.filter((item) => item.id !== row.id)];
  const notification = await ringOverdueBell(trx, { row, message, verdict: sourceAlertVerdict(verdict, promises, row.id),
    dedupeKey: smsSourceAlertKey(message.id), promises });
  if (notification?.id) {
    const { doneColumns, openToCloser } = require('./notification-service')._private;
    await openToCloser(trx('notifications').where({ recipient_type: 'admin' })
      .whereIn(trx.raw("metadata->>'dedupeKey'"), promises.map((item) => legacyCommitmentAlertKey(item.id))), 'supersede')
      .update(doneColumns({ by: 'supersede', resolution: 'Replaced by one alert for this text', keepExisting: true, conn: trx }));
  }
  return notification;
}

// Close-only reconciliation with the later text thread. A row the records have
// not settled (open, uncertain, a failed check, or undated with no witness) may
// close when a later text clearly confirms it: the customer got it, or a person
// said it was sent. A close by the records stands exactly as before; the thread
// never reopens or holds anything. A failed thread read changes nothing.
const THREAD_CALLS_PER_CUSTOMER = 3;

async function reconcileWithThread({ conn, row, current, message, now, verdict, verifyThread }) {
  if (verdict.verdict === 'fulfilled') return verdict;
  try {
    const thread = await verifyThread(conn, current, message, now);
    if (!thread) return verdict;
    current.sms_context = { ...current.sms_context, thread_check: thread };
    if (thread.verdict === 'fulfilled') return thread;
    await conn('call_commitments').where({ id: row.id, status: 'open' }).whereNull('human_state')
      .update({ sms_context: conn.raw("COALESCE(sms_context, '{}'::jsonb) || jsonb_build_object('thread_check', ?::jsonb)", [JSON.stringify(thread)]) });
  } catch (err) {
    logger.warn(`[sms-operations] thread check failed for commitment ${row.id}: ${err.message}`);
  }
  return verdict;
}

// GATE_PROMISE_RECORD_EVIDENCE (owner 2026-10-29, fix F4) — read at call time.
// 'off' = nothing here runs. 'shadow' = nothing applies; it writes audit rows.
// 'true' = rule 3 (on track until the visit) and the extended evidence apply.
const promiseRecordMode = () => promiseRecordEvidenceMode?.() ?? 'off';
const SHADOW_FULFILLMENT_ACTION = 'sms_commitment.fulfillment.shadow';
const SHADOW_ON_TRACK_ACTION = 'sms_commitment.on_track.shadow';
// Extra model calls per refresh run in shadow mode.
const SHADOW_MODEL_CALLS_PER_RUN = 10;
const alertRingOnce = () => require('../config/feature-gates').alertRingOnceLive?.() === true;
// The text's other open promises that still need its shared alert: every one
// rule 3 does not hold in 'true' mode (findOnTrackVisit; a failed read holds
// nothing, so that promise keeps the alert).
async function notOnTrack(conn, promises, message, now) {
  const kept = [];
  for (const item of promises) {
    if ((await findOnTrackVisit(conn, item, message, now))?.mode !== 'true') kept.push(item);
  }
  return kept;
}
const etShortDateTime = (at) => new Date(at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// Rule 3: a waves row of these kinds (a promise Waves made or a customer's
// request, whatever its basis) that is booked onto a visit is on track until
// that visit's window ends.
const ON_TRACK_KINDS = ['other', 'callback', 'technician_follow_up'];
// A visit that did not run is no visit still to come. (A completed visit is
// kept: R1 closes the ask it answers, and a promise it left open is held only
// until that window's end.)
const ON_TRACK_EXCLUDED_STATUSES = ['cancelled', 'canceled', 'no_show', 'skipped'];
const onTrackWindowEnd = (visit) => {
  const day = String(visit.scheduled_date || '').slice(0, 10);
  const clock = (value) => (/^\d{2}:\d{2}/.test(String(value || '')) ? String(value).slice(0, 5) : null);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const end = clock(visit.window_end);
  const start = clock(visit.window_start);
  // The flat-60 convention of the scheduler when a window has a start and no end.
  const at = end ? parseETDateTime(`${day}T${end}`)
    : (start ? new Date(parseETDateTime(`${day}T${start}`).getTime() + 3600000) : null);
  return at && !Number.isNaN(at.getTime()) ? at : null;
};
// The nearest visit that keeps an overdue waves row (promise or request) on track: live (not
// cancelled, no-show or skipped), not a recurring-series child, at the
// promise's property when it names one, created after the promise text, with
// its window end still ahead. Null when the gate is off, the row is not such a
// promise, nothing qualifies, or the read fails (the ring then stands).
async function findOnTrackVisit(conn, commitment, message, now) {
  const mode = promiseRecordMode();
  if (mode === 'off' || commitment.party !== 'waves' || !ON_TRACK_KINDS.includes(commitment.kind)) return null;
  // Only an overdue ring is held: a row not yet due rings nothing to hold.
  if (commitment.due_at == null || new Date(commitment.due_at) > now) return null;
  try {
    const sourceAt = new Date(commitment.sms_context?.source_at || message.created_at);
    if (Number.isNaN(sourceAt.getTime())) return null;
    const visits = await conn('scheduled_services').where({ customer_id: message.customer_id })
      .whereNull('recurring_parent_id')
      .where((q) => q.whereNull('status').orWhereNotIn('status', ON_TRACK_EXCLUDED_STATUSES))
      .where('created_at', '>', sourceAt).where('created_at', '<=', now)
      .whereRaw('scheduled_date >= ?::date', [etDateString(new Date(now.getTime() - 86400000))])
      .modify((q) => { if (commitment.sms_context?.property_id) q.where({ property_id: commitment.sms_context.property_id }); })
      .orderBy('scheduled_date').limit(20)
      .select('id', 'status', 'created_at', conn.raw('scheduled_date::text as scheduled_date'),
        conn.raw('window_start::text as window_start'), conn.raw('window_end::text as window_end'));
    const ahead = visits.map((visit) => ({ visit, end: onTrackWindowEnd(visit) })).filter(({ end }) => end && end > now)
      .sort((a, b) => a.end - b.end);
    return ahead.length ? { mode, visit_id: ahead[0].visit.id, window_end: ahead[0].end.toISOString() } : null;
  } catch (err) {
    logger.warn(`[sms-operations] on-track visit check failed for commitment ${commitment.id}: ${err.message}`);
    return null;
  }
}

// Shadow mode, rule 3: the ring still happened; record that it would have
// been held, once per promise per Eastern day. Never throws.
async function recordOnTrackShadow(conn, commitment, onTrack, now) {
  try {
    const already = await conn('audit_log')
      .where({ action: SHADOW_ON_TRACK_ACTION, resource_type: 'call_commitment', resource_id: commitment.id })
      .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date = ?::date", [etDateString(now)]).first('id');
    if (already) return false;
    await recordAuditEvent({ trx: conn, actor_type: 'system', action: SHADOW_ON_TRACK_ACTION,
      resource_type: 'call_commitment', resource_id: commitment.id,
      metadata: { commitment_id: commitment.id, kind: commitment.kind, due_at: commitment.due_at,
        visit_id: onTrack.visit_id, window_end: onTrack.window_end } });
    return true;
  } catch (err) {
    logger.warn(`[sms-operations] on-track shadow write failed for commitment ${commitment.id}: ${err.message}`);
    return false;
  }
}

// Shadow mode, rules 1 and 2: when the normal check left a promise open and
// the extended evidence holds a record the normal one refused (an invoice for
// a staff promise, an accepted estimate), ask the model once more on the
// extended evidence and write ONE audit row. Nothing else changes. Capped per
// run, and never again for the same evidence (the fingerprint hash).
async function recordFulfillmentShadow(conn, { current, message, evidence, baseVerdict, now, verify, eventOnly, budget }) {
  try {
    const staff = current.kind === 'other' && current.sms_context?.basis === 'promise';
    if ((!staff && current.kind !== 'send_estimate') || budget.left <= 0) return false;
    const extended = withExtendedEvidence(current);
    const wider = await loadSmsFulfillmentEvidence(conn, extended, message, now);
    const baseRefs = new Map(evidence.records.map((record) => [record.ref, record]));
    const fresh = wider.records.filter((record) => ['invoice', 'estimate'].includes(record.type)
      && admissibleWitness(record, extended, wider.records)
      && !(baseRefs.has(record.ref) && admissibleWitness(baseRefs.get(record.ref), current, evidence.records)));
    if (!fresh.length) return false;
    const { evidenceHash } = fulfillmentFingerprint(extended, wider, { eventOnly });
    const already = await conn('audit_log').where({ action: SHADOW_FULFILLMENT_ACTION, resource_type: 'call_commitment', resource_id: current.id })
      .whereRaw("metadata->>'evidence_hash' = ?", [evidenceHash]).first('id');
    if (already) return false;
    budget.left -= 1;
    const verdict = await verify(extended, wider, { now, eventOnly });
    // A provider outage is retried on a later run, not recorded as an answer.
    if (['provider_failed', 'invalid_model_output'].includes(verdict?.reason)) return false;
    await recordAuditEvent({ trx: conn, actor_type: 'system', action: SHADOW_FULFILLMENT_ACTION,
      resource_type: 'call_commitment', resource_id: current.id,
      metadata: { commitment_id: current.id, kind: current.kind, sms_log_id: message.id,
        new_records: fresh.map((record) => ({ type: record.type, id: record.id })),
        shadow_verdict: verdict?.verdict ?? null, shadow_reason: verdict?.reason ?? null,
        shadow_record: verdict?.record_type ? { type: verdict.record_type, id: verdict.record_id } : null,
        base_verdict: baseVerdict?.verdict ?? null, evidence_hash: evidenceHash } });
    return true;
  } catch (err) {
    logger.warn(`[sms-operations] fulfillment shadow failed for commitment ${current.id}: ${err.message}`);
    return false;
  }
}

// The shadow rows of one refresh, written after its transaction so an audit
// write can never undo a persisted verdict. Shadow mode only; both writers
// never throw.
async function recordPromiseRecordShadows(conn, { persisted, rang, onTrack, current, message, evidence, verdict, inWindow, threadOnly, now, verify, budget }) {
  if (!persisted) return;
  if (rang && onTrack?.mode === 'shadow') await recordOnTrackShadow(conn, current, onTrack, now);
  // Only a promise the normal check left open (a closed one had a fulfilled verdict).
  if (verdict.verdict === 'fulfilled' || inWindow || threadOnly || promiseRecordMode() !== 'shadow') return;
  await recordFulfillmentShadow(conn, { current, message, evidence, baseVerdict: verdict, now, verify, eventOnly: false, budget });
}

// One open row: skip, verify, and close or bell. Returns what happened so
// the caller can count it.
async function refreshSmsCommitment(conn, row, now, verify, verifyThread = verifyThreadCompletion, shadowBudget = { left: SHADOW_MODEL_CALLS_PER_RUN }) {
  const message = await scheduledSourceMessage(conn, await conn('sms_log').where({ id: row.sms_log_id }).first(...SOURCE_COLUMNS));
  // A later delivery failure cannot erase already-recorded staff work.
  // Intake still refuses failed sources; captured promises stay actionable.
  if (!message || !eligibleMessage(message, { captured: true })) return { outcome: 'ineligible' };
  // The SMS foreign key follows merges and merge undo. Embedded context
  // is only a snapshot; never let its former owner strand the obligation.
  const current = { ...row, sms_context: { ...row.sms_context, customer_id: message.customer_id } };
  const evidence = await loadSmsFulfillmentEvidence(conn, current, message, now);
  // An outcome reached while a source query failed outright (truncation is
  // persistent, so it does not count) is retried: the missing source may hold
  // the event that selected the row (Codex #4816 r21/r26/r34).
  const incomplete = evidence.failures.some((f) => !f.endsWith('_truncated'));
  const settle = (outcome) => (incomplete ? 'deferred' : outcome);
  const deadlinePassed = row.due_at != null && new Date(row.due_at) <= now;
  // No deadline to enforce yet (none stated, or the window is still open)
  // and nothing on file even looks like an answer: skip the model call
  // entirely rather than spend it on an obligation with no chance of a
  // grounded verdict, and leave the row open and silent. An undated row has
  // one more way to finish: the later text thread (threadOnly below).
  const noWitness = !deadlinePassed && !evidence.records.some((record) => admissibleWitness(record, current, evidence.records));
  const threadOnly = noWitness && row.due_at == null;
  if (noWitness && !threadOnly) return { outcome: settle('no_witness') };
  // R1 (owner ruling 2026-09-24): inside an open window only an event may
  // act. An admissible visit record (field progress, a move, a
  // cancellation) reaches `verify` at once; a message witness (a staff
  // text, a call) waits for the deadline before it costs a model call,
  // exactly as a stated-deadline row always has. A NULL due_at is never an
  // open window. Inside the window the event is what earned the early
  // check, so only an event record may ground it (Codex #4816 r17): the
  // model cannot close the row early by citing the call instead.
  const inWindow = row.due_at != null && !deadlinePassed;
  const eventWitness = evidence.records.some((record) => SYSTEM_EVENT_TYPES.includes(record.type)
    && admissibleWitness(record, current, evidence.records));
  if (!eventWitness && inWindow) return { outcome: settle('not_due') };
  const checked = threadOnly ? { verdict: 'open' } : await verify(current, evidence, { now, eventOnly: inWindow });
  // R1 holds for the thread too: inside an open window a text cannot close
  // the row early, so the thread check waits for the deadline (Codex #6415 r7).
  const verdict = inWindow ? checked : await reconcileWithThread({ conn, row, current, message, now, verdict: checked, verifyThread });
  if (threadOnly && verdict.verdict !== 'fulfilled') return { outcome: settle('no_witness') };
  let closed = false;
  // GATE_PROMISE_RECORD_EVIDENCE rule 3: an overdue promise with a visit still
  // to come does not ring until that visit's window ends. Read before the
  // transaction so a failed read can never abort it; null with the gate off.
  const onTrack = await findOnTrackVisit(conn, current, message, now);
  const holdBell = onTrack?.mode === 'true';
  let rang = false;
  // Only a verdict this transaction actually persisted counts as handled.
  // Every early exit — a relinked or changed source, the gate turning off, a
  // fulfilled verdict the revalidator could not commit (a locked or changed
  // witness) — is retried, so its event stays unseen (Codex #4816 r18/r19).
  let persisted = false;
  await conn.transaction(async (trx) => {
    const locked = await lockLiveCommitment(trx, row, message);
    if (!locked) return;
    const { source, live } = locked;
    const latest = { ...live, sms_context: { ...live.sms_context, customer_id: source.customer_id } };
    if (verdict.verdict === 'fulfilled' && !await revalidateSmsFulfillment(trx, latest, source, verdict, now)) return;
    const alertKeys = [legacyCommitmentAlertKey(row.id), smsSourceAlertKey(source.id)];
    if (live.sms_context.customer_id !== source.customer_id) {
      // Rolling dedupe only refreshes recent rows. Older bells must also
      // follow a merge or undo instead of opening the retired account.
      await trx('notifications').where({ recipient_type: 'admin' })
        .whereIn(trx.raw("metadata->>'dedupeKey'"), alertKeys).update({
          link: `/admin/customers?customerId=${encodeURIComponent(source.customer_id)}&tab=comms`,
          metadata: trx.raw("jsonb_set(metadata, '{customerId}', to_jsonb(?::text), true)", [source.customer_id]),
        });
    }
    await trx('call_commitments').where({ id: row.id }).update({
      sms_context: { ...current.sms_context, fulfillment_check: verdict },
    });
    persisted = true;
    if (keptLate(live, verdict) && !holdBell && !await trx('notifications').where({ recipient_type: 'admin' })
      .whereIn(trx.raw("metadata->>'dedupeKey'"), alertKeys).first('id')) {
      // A suppressed bell leaves no row to find next tick: close now instead.
      const bell = await ringSmsSourceBell(trx, { row, message, verdict: { ...verdict, late: true } });
      rang = true;
      if (!bell.suppressed) return;
    }
    if (verdict.verdict === 'fulfilled') {
      await trx('call_commitments').where({ id: row.id }).update({
        status: 'fulfilled', fulfillment: verdict, fulfilled_at: now, updated_at: now,
      });
      await closeSmsCommitmentAlerts(trx, { commitmentId: row.id, smsLogId: source.id },
        require('./notification-service')._private.doneColumns({ by: 'sms-commitments',
          resolution: verdict.basis === THREAD_BASIS ? `The text follow-up was done (${verdict.note})` : 'The text follow-up was done',
          at: now, keepExisting: true, conn: trx }));
      closed = true;
      return;
    }
    // A NULL-due commitment only ever closes quietly on real evidence; it
    // never rings a bell on its own (there is no stated deadline to have
    // passed). The fulfillment_check above is still stored so a later
    // pass with new evidence does not repeat the same model call for free.
    // Rule 3 ('true'): an overdue alert that rang before the visit was booked
    // closes while the visit is ahead, through the usual closer (open rows
    // only; a shared alert keeps the text's other open promises). Only with
    // GATE_ALERT_RING_ONCE on: its open-only probe lets the ring after the
    // window raise a fresh alert, and the ring's supersede step leaves a system
    // close alone. Without it a closed row would absorb that ring for a day.
    if (holdBell) {
      if (alertRingOnce()) {
        await closeSmsCommitmentAlerts(trx, { commitmentId: row.id, smsLogId: source.id, openOnly: true,
          needsAlert: (others) => notOnTrack(trx, others, message, now) },
        require('./notification-service')._private.doneColumns({ by: 'sms-commitments',
          resolution: `On track: a visit is booked until ${etShortDateTime(onTrack.window_end)} ET`, at: now, keepExisting: true, conn: trx }));
      }
      return;
    }
    if (deadlinePassed) {
      await ringSmsSourceBell(trx, { row, message, verdict });
      rang = true;
    }
  });
  await recordPromiseRecordShadows(conn, { persisted, rang, onTrack, current, message, evidence, verdict,
    inWindow, threadOnly, now, verify, budget: shadowBudget });
  // A provider or schema failure is persisted with retry_after, but no model
  // judged the event: keep it pending (verify reuses the stored failure until
  // retry_after, so this costs no extra provider calls).
  return { outcome: persisted && !verdict.retry_after ? settle('verified') : 'deferred', verdict, closed };
}

async function refreshSmsCommitments({ now = new Date(), conn = db, verify = verifySmsFulfillment, verifyThread = verifyThreadCompletion } = {}) {
  if (!smsCommitmentsEnabled()) return { skipped: 'gate_off' };
  if (!gateEnvTimestamp('GATE_SMS_OPERATIONAL_ACTIONS_SINCE')) return { skipped: 'activation_time_required' };
  const counts = { scanned: 0, fulfilled: 0, unverified: 0, skipped_no_witness: 0, skipped_not_due: 0 };
  const PAGE = 25;
  // Two bounded pages per tick, each with its own durable cursor, so an old
  // open item cannot monopolize the first page and strand later customers.
  // Due work (deadline passed, or a legacy NULL due_at that closes on
  // evidence but never bells) keeps its full page; rows whose window is
  // still open are probed on a SEPARATE page for early system-event closure
  // (R1) and never eat into due capacity (Codex #4816 r4: a backlog of
  // future-dated rows must not delay a 4h callback bell). Inside the window
  // only a system event or an admissible event witness may act; the model
  // check and the bell still wait for the deadline.
  const openRows = () => conn('call_commitments as cc').join('sms_log as s', 's.id', 'cc.sms_log_id')
    .join('customers as c', 'c.id', 's.customer_id').whereNull('c.deleted_at')
    .where({ 'cc.status': 'open', 'cc.party': 'waves' }).whereNull('cc.human_state');
  const page = async (cursorKey, scope) => {
    const cursor = await conn('system_settings').where({ key: cursorKey }).first('value');
    const afterId = /^[a-f0-9-]{36}$/i.test(cursor?.value || '') ? cursor.value : null;
    const rows = await scope(openRows()).modify((q) => { if (afterId) q.where('cc.id', '>', afterId); })
      .orderBy('cc.id').limit(PAGE).select('cc.*');
    return { cursorKey, rows };
  };
  // A third page, ahead of the cursors: any open row (due, undated or
  // future) with unseen event activity (visit or payment), so an event is
  // checked on the next tick wherever the cursors stand (Codex #4816
  // r15–r17; Codex round 1 P2, #4996: payment activity joined the scan).
  const tickBound = Array(6).fill(now);
  // A row waiting out a provider/schema failure's retry_after cannot make
  // progress on the same evidence (verify returns the stored failure until
  // then), so it yields its slot rather than pinning the page through an
  // outage; its event stays unseen and it returns once the retry is due.
  // Activity newer than the failed attempt changes the evidence, so it brings
  // the row back at once (Codex #4816 r21).
  // Least recently stamped first, so a re-scan inside the commit grace never
  // holds back a row whose event has not been seen at all.
  // The unseen-activity scan runs ONCE per candidate row (a LATERAL join)
  // and is reused by the filter, the backoff override and the watermark,
  // instead of being re-evaluated in each. OFFSET 0 is the optimization
  // fence: without it Postgres flattens the one-column subquery and inlines
  // the scan back into every reference.
  const eventRows = await openRows()
    .joinRaw(`CROSS JOIN LATERAL (SELECT ${UNSEEN_EVENT_ACTIVITY} AS unseen_at OFFSET 0) ev`, tickBound)
    .whereNotNull('ev.unseen_at')
    // A stored failure reached for another owner (sms_context.customer_id is
    // rewritten with every persisted verdict) says nothing about the current
    // owner's evidence: a merge or undo lifts the backoff (Codex #4816 r32).
    .where((q) => q.whereRaw(`${RETRY_AFTER_SQL} IS NULL OR ${RETRY_AFTER_SQL} <= ?`, [now])
      .orWhereRaw("cc.sms_context->>'customer_id' IS DISTINCT FROM s.customer_id::text")
      // Newer than what the failed attempt read: the same commit-grace cap
      // as the watermark, so a visit write that began before that attempt
      // but committed after it still counts (Codex #4816 r30).
      .orWhereRaw(`ev.unseen_at > COALESCE((cc.sms_context->>'event_attempted_through')::timestamptz,
        ${RETRY_AFTER_SQL} - make_interval(secs => ?))`, [PROVIDER_RETRY_MS / 1000]))
    // A deferred row keeps its event but moves behind rows not yet tried, so
    // repeated deferrals cannot hold the page prefix (Codex #4816 r28).
    .orderByRaw(`GREATEST(${EVENT_SEEN_AT}, (cc.sms_context->>'event_attempted_at')::timestamptz) ASC NULLS FIRST, cc.id`).limit(PAGE)
    .select('cc.*', 's.customer_id as event_customer_id', conn.raw('LEAST(ev.unseen_at, ?::timestamptz)::text AS event_seen_through',
      [new Date(now.getTime() - EVENT_COMMIT_GRACE_MS)]));
  const seenThrough = new Map(eventRows.map(({ id, event_seen_through: at, event_customer_id: customerId }) => [id, { at, customerId }]));
  const pages = [
    await page('sms_operations.fulfillment_cursor', (q) => q.where((w) => w.whereNull('cc.due_at').orWhere('cc.due_at', '<=', now))),
    await page('sms_operations.future_cursor', (q) => q.where('cc.due_at', '>', now)),
  ];
  const rows = [...new Map([...eventRows.map(({ event_seen_through: _at, event_customer_id: _customer, ...row }) => row), ...pages.flatMap((p) => p.rows)]
    .map((row) => [row.id, row])).values()];
  // Every new text changes each row's thread fingerprint, so one text per tick
  // could buy a model call for every open row of that customer. Each customer
  // gets THREAD_CALLS_PER_CUSTOMER new thread calls a tick; the rest keep
  // their record verdict (and its alert) until a later tick (Codex #6415).
  const threadCalls = new Map();
  const shadowBudget = { left: SHADOW_MODEL_CALLS_PER_RUN };
  const budgetedThread = (c, commitment, message, at) => verifyThread(c, commitment, message, at, { mayCall: () => {
    const used = threadCalls.get(message.customer_id) || 0;
    if (used >= THREAD_CALLS_PER_CUSTOMER) return false;
    threadCalls.set(message.customer_id, used + 1);
    return true;
  } });
  for (const row of rows) {
    if (!smsCommitmentsEnabled()) return { ...counts, skipped: 'gate_off' };
    counts.scanned += 1;
    const result = await refreshSmsCommitment(conn, row, now, verify, budgetedThread, shadowBudget);
    if (result.outcome === 'no_witness') counts.skipped_no_witness += 1;
    if (result.outcome === 'not_due') counts.skipped_not_due += 1;
    if (result.verdict?.verdict === 'uncertain') counts.unverified += 1;
    if (result.closed) counts.fulfilled += 1;
    // Stamped only after the row is handled: an error above, or a deferred
    // close, leaves its event pending for the next tick.
    // Only while the row is still open and untouched by staff: a human
    // closure or correction in between wins.
    if (seenThrough.has(row.id)) {
      const { at, customerId } = seenThrough.get(row.id);
      await conn('call_commitments').where({ id: row.id, status: 'open' }).whereNull('human_state').update({ sms_context: result.outcome === 'deferred'
        ? conn.raw("COALESCE(sms_context, '{}'::jsonb) || jsonb_build_object('event_attempted_at', ?::text, 'event_attempted_through', ?::text)", [now.toISOString(), at])
        : conn.raw("(COALESCE(sms_context, '{}'::jsonb) - 'event_attempted_at' - 'event_attempted_through') || jsonb_build_object('event_seen_at', ?::text, 'event_seen_customer_id', ?::text)", [at, customerId]) });
    }
  }
  for (const { cursorKey, rows: pageRows } of pages) {
    const nextCursor = pageRows.length === PAGE ? pageRows[pageRows.length - 1].id : null;
    await conn('system_settings').insert({ key: cursorKey, value: nextCursor, category: 'sms_operations' })
      .onConflict('key').merge({ value: nextCursor, updated_at: now });
  }
  return counts;
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

module.exports = { findOnTrackVisit, onTrackWindowEnd, isQuietTemporaryFact, reviewBellCopy, smsCommitmentsEnabled, eligibleMessage, factVerdict, loadMessageContext, recordMessageOperations, runSmsOperationalActions, replaySmsProfile, refreshSmsCommitments, listSmsCommitments, applySmsCommitmentUpdate, settleCommitmentsForDoneAlert, closeSmsCommitmentAlerts, sourceAlertVerdict, DEFAULT_DEADLINE_HOURS, PROMISE_DEFAULT_DEADLINE_HOURS, resolveDueDeadline, ringOverdueBell, keptLate };
