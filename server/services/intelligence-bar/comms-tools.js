/**
 * Intelligence Bar — Communications Tools
 * server/services/intelligence-bar/comms-tools.js
 *
 * Tools for the SMS inbox, conversation threading, call recordings,
 * AI reply drafting, and CSR coaching. Virginia's daily driver.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { anthropicMaxTokens, anthropicEffortConfig } = require('../llm/anthropic-wire');
// First TEXT block of a Message — a thinking block leads the content on
// always-thinking models (Opus 5.5, Fable), so content[0] is not the answer.
const { anthropicText } = require('../llm/call');
const { etDateString, parseETDateTime } = require('../../utils/datetime-et');
const { excludeUnresolvedSendReservations } = require('../messaging/review-ask-reservation');
const {
  sendManualCustomerSms,
  manualSmsDeliveryState,
} = require('../messaging/send-manual-customer-sms');
const { excludeRecruitingSmsLog, isRecruitingMessageType } = require('../../utils/recruiting-thread-scope');
const { ledgerCall, ledgerCallRejected } = require('../llm-dispatch-metrics');
// cancel_queued_message is SMS-only (owner ruling, dunning-unification-style
// "simple only" sweep, 2026-09-28): an email_messages 'queued' row is never
// a scheduled email — sendTemplate dispatches it to SendGrid within seconds
// (QUEUED_IN_FLIGHT_MS = 2 min is an in-flight window, not a hold), so
// cancelling it always races the sender at one producer site or another.
// scheduled-sms-cancel.js owns the ONE writer for a scheduled sms_log row
// (thread lock, review-ask-reservation-in-place, recruiting reconciliation,
// agent_decision re-park/reopen — the same workflow the admin SMS inbox's
// own cancel uses, so this tool can never bypass it with a bare status flip).
const { cancelScheduledSmsRow, PRIOR_ATTEMPT_KEY_RE, SIMPLE_SMS_META_KEYS } = require('../scheduled-sms-cancel');
const { isDeferredReplayEntryPoint } = require('../messaging/deferred-replay-registry');

// Admin phones to exclude from results
const ADMIN_PHONE_RAW = '9415993489';
const ADMIN_PHONES = new Set([
  `+1${ADMIN_PHONE_RAW}`, `1${ADMIN_PHONE_RAW}`, ADMIN_PHONE_RAW,
  process.env.ADAM_PHONE,
].filter(Boolean));

function isAdminPhone(phone) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '').slice(-10);
  return ADMIN_PHONES.has(phone) || digits === ADMIN_PHONE_RAW;
}

const COMMS_TOOLS = [
  {
    name: 'get_unanswered_threads',
    description: `Find conversation threads where the customer sent the last message and is waiting for a reply. This is the #1 inbox priority.
Use for: "any unanswered messages?", "who's waiting for a reply?", "unread inbox"`,
    input_schema: {
      type: 'object',
      properties: {
        hours_back: { type: 'number', description: 'Only check messages from the last N hours (default: 48)' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_conversation_thread',
    description: `Read a page of SMS history with a specific customer, newest page first and messages in chronological order. Follow next_offset for older messages; a page is not the full history.
Use for: "show me the conversation with Henderson", "what did we say to the customer on 941-555-0142?", "pull up the thread with Smith"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Customer name (partial match OK)' },
        phone: { type: 'string', description: 'Phone number' },
        customer_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset for older messages' },
        limit: { type: 'number', description: 'Max messages to return (default 20, max 50)' },
      },
    },
  },
  {
    name: 'search_messages',
    description: `Search SMS messages by content, customer name, phone number, direction, or message type.
Use for: "find messages about rescheduling", "who texted us about lawn care?", "show all review request texts this week"`,
    input_schema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset' },
        search: { type: 'string', description: 'Search in message body text' },
        customer_name: { type: 'string' },
        phone: { type: 'string' },
        customer_id: { type: 'string', format: 'uuid' },
        direction: { type: 'string', enum: ['inbound', 'outbound'] },
        message_type: { type: 'string', enum: ['manual', 'auto_reply', 'reminder', 'confirmation', 'review_request', 'estimate', 'post_service', 'follow_up'] },
        days_back: { type: 'number', description: 'Only search last N days (default 7)' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_sms_stats',
    description: `Get SMS volume statistics: sent/received counts, breakdown by message type, by phone number/location, response times.
Use for: "how many texts did we send this month?", "SMS stats", "which phone number gets the most messages?"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look back N days (default 30)' },
      },
    },
  },
  {
    name: 'get_call_log',
    description: `Get recent call log: inbound/outbound calls, durations, recording status, transcripts if available, matched customers.
Use for: "what calls came in this morning?", "show me today's calls", "any missed calls?", "calls with recordings"`,
    input_schema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset' },
        call_id: { type: 'string', format: 'uuid', description: 'Read one known call; ignores days_back. Returns a transcript page.' },
        customer_id: { type: 'string', format: 'uuid', description: 'Filter calls to this customer' },
        transcript_offset: { type: 'integer', minimum: 0, description: 'Continue a call transcript from transcript_next_offset' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'all'] },
        has_recording: { type: 'boolean', description: 'Only calls with recordings' },
        has_transcript: { type: 'boolean', description: 'Only calls with transcripts' },
        customer_name: { type: 'string' },
        days_back: { type: 'number', description: 'Default 7' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_open_commitments',
    description: `The Owed queue: open promises from calls — what Waves told callers it would do (send an estimate, call back, send a confirmation, book a visit…) and what callers agreed to do — with what is overdue. Read-only; rows exist only while GATE_CALL_COMMITMENTS has been on.
Use for: "what do we owe callers?", "any overdue promises?", "what did we promise this customer?", "what is the customer supposed to send us?"`,
    input_schema: {
      type: 'object',
      properties: {
        party: { type: 'string', enum: ['waves', 'customer', 'all'], description: 'Default waves (what Waves owes)' },
        overdue_only: { type: 'boolean', description: 'Only promises past their due time (or open too long with none)' },
        customer_id: { type: 'string', format: 'uuid' },
        customer_name: { type: 'string', description: 'Resolve the customer by name instead of id' },
        limit: { type: 'number', description: 'Default 25, max 100' },
      },
    },
  },
  {
    name: 'list_call_partners',
    description: `Aggregate the B2B ARRANGERS who call to book service for other people — realtors/buyer's agents, lenders and title/closing coordinators, property managers — from the AI call extractions (caller relationship real_estate_agent/lender/property_manager, or an organization name on the call). Returns per-partner: name, organization, relationship, total calls, first/last call, WDO-related call count, latest call summary.
Use for: "who are my top realtor partners?", "which lenders keep calling us?", "show repeat WDO arrangers", "partner channel overview"`,
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'Lookback window, default 180' },
        relationship: { type: 'string', enum: ['real_estate_agent', 'lender', 'property_manager', 'all'], description: 'Filter to one arranger type. Default all.' },
        limit: { type: 'number', description: 'Default 25' },
      },
    },
  },
  {
    name: 'get_partner_call_history',
    description: `Every call from one arranger/partner phone number: date, summary, requested service, and any other parties (buyers/sellers/tenants) captured on each call. Use after list_call_partners to drill into one partner.
Use for: "show me all of Melissa from Coldwell Banker's calls", "what has New Day USA booked with us?"`,
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'The partner phone number (any format)' },
        limit: { type: 'number', description: 'Default 20' },
      },
      required: ['phone'],
    },
  },
  {
    name: 'send_sms',
    description: `Send an SMS to a customer. ALWAYS show the draft message and ask for confirmation before sending.
Use for: "text Henderson that we're running late", "send a reminder to Smith about tomorrow's service"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Find customer by name' },
        customer_id: { type: 'string' },
        phone: { type: 'string', description: 'Direct phone number' },
        message: { type: 'string', description: 'The SMS body' },
        message_type: { type: 'string', enum: ['manual', 'reminder', 'follow_up', 'billing_reminder'], description: 'Default: manual. Use billing_reminder for billing/overdue-balance nudges — it honors the customer\'s Billing Reminder Delivery channel (an email-preferring customer returns a blocked "prefers email" result instead of texting against their choice). There is no billing opt-out toggle; sms_enabled (STOP) is the only kill switch.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'draft_sms_reply',
    description: `Generate an AI-drafted reply for a customer's last inbound message. Returns a draft — does NOT send.
Use for: "draft a reply to Henderson", "what should we say to the customer asking about rescheduling?"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        customer_id: { type: 'string' },
        phone: { type: 'string' },
        context: { type: 'string', description: 'Additional context for the AI (e.g. "they want to reschedule to next week")' },
      },
    },
  },
  {
    name: 'get_csr_overview',
    description: `Get CSR coaching dashboard: follow-up tasks, lead quality vs CSR performance, fixable errors, weekly recommendations.
Use for: "how's Virginia doing on calls?", "any CSR coaching issues?", "follow-up tasks", "lost lead analysis"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback period in days (default 30)' },
      },
    },
  },
  {
    name: 'get_todays_activity',
    description: `Quick summary of today's communication activity: messages sent/received, calls, unanswered threads, response time.
Use for: "what happened today?", "today's comms summary", "morning inbox briefing"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_queued_messages',
    description: `List a customer's outbound TEXTS that are still SCHEDULED — not yet sent (e.g. a text held past 8PM-8AM quiet hours). Only texts a staff member scheduled from the inbox are cancelable; automated texts, anything a send worker already picked up, and replies tied to an Agent Review suggestion are left out (counted in excluded_count) — the office handles those. Use before cancel_queued_message to resolve the exact message_id; a cancel preview always names one message from this list. Soonest first, capped at 25 — pass next_cursor as cursor for more. SCHEDULED EMAILS DO NOT EXIST: an email is rendered and handed to the delivery provider within seconds of being queued, so by the time anyone could ask about it, it has already sent — there is nothing to list or cancel.
Use for: "what's queued to send Henderson?", "is there a text scheduled for this customer?"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The customer to check' },
        channel: { type: 'string', enum: ['sms'], description: 'Scheduled texts only — there is no scheduled-email store to check.' },
        cursor: { type: 'string', description: 'Continue from next_cursor in the previous result' },
        limit: { type: 'number', description: 'Max results (default 25, max 100)' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'cancel_queued_message',
    description: `Cancel ONE customer text that is still SCHEDULED — before it sends. Resolve message_id with list_queued_messages first. A text that has already started sending, was already sent, or is managed by another workflow (an invoice send, a recruiting reply, a completion report, …) can never be recalled here and this refuses it. Cancelling sends nothing to the customer — it only stops a text that has not gone out yet. EMAILS CANNOT BE CANCELLED THIS WAY OR ANY WAY: sendTemplate hands a queued email to the delivery provider within seconds, so by the time this tool could act, it has already sent.
Use for: "cancel that scheduled text", "stop the reminder we just queued for them"`,
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', format: 'uuid', description: 'From list_queued_messages' },
        customer_id: { type: 'string', format: 'uuid', description: 'The customer this message belongs to, from list_queued_messages' },
        channel: { type: 'string', enum: ['sms'], description: 'Scheduled texts only.' },
      },
      required: ['message_id', 'customer_id', 'channel'],
    },
  },
];

// Read-only subset loaded into every admin context (not just the Communications
// page) so any page can pull SMS/call history for a customer. Write tools
// (send_sms, cancel_queued_message) and comms-page-specific tools stay comms-only.
const COMMS_READ_TOOL_NAMES = new Set([
  'get_unanswered_threads',
  'get_conversation_thread',
  'search_messages',
  'get_sms_stats',
  'get_call_log',
  'get_todays_activity',
  'list_call_partners',
  'get_partner_call_history',
  'get_open_commitments',
  'list_queued_messages',
]);
const COMMS_READ_TOOLS = COMMS_TOOLS.filter(t => COMMS_READ_TOOL_NAMES.has(t.name));


// ─── EXECUTION ──────────────────────────────────────────────────

// Name → handler. A lookup table instead of a switch keeps the dispatcher's
// own complexity flat as tools are added (Codex round 10 on #5224).
const COMMS_TOOL_HANDLERS = {
  get_unanswered_threads: (input) => getUnansweredThreads(input),
  get_conversation_thread: (input) => getConversationThread(input),
  search_messages: (input) => searchMessages(input),
  get_sms_stats: (input) => getSmsStats(input.days || 30),
  get_call_log: (input) => getCallLog(input),
  list_call_partners: (input) => listCallPartners(input),
  get_open_commitments: (input) => getOpenCommitments(input),
  get_partner_call_history: (input) => getPartnerCallHistory(input),
  send_sms: (input) => sendSms(input),
  draft_sms_reply: (input) => draftSmsReply(input),
  get_csr_overview: (input) => getCsrOverview(input.days || 30),
  get_todays_activity: () => getTodaysActivity(),
  list_queued_messages: (input) => listQueuedMessages(input),
  cancel_queued_message: (input, actionContext) => cancelQueuedMessage(input, actionContext),
};

async function executeCommsTool(toolName, input, actionContext = {}) {
  const handler = Object.prototype.hasOwnProperty.call(COMMS_TOOL_HANDLERS, toolName)
    ? COMMS_TOOL_HANDLERS[toolName]
    : null;
  if (!handler) return { error: `Unknown comms tool: ${toolName}` };
  try {
    return await handler(input, actionContext);
  } catch (err) {
    if (isUncertainManualSmsOutcome(err)) {
      return uncertainManualSmsResponse(err);
    }
    // The sender preserves a provider receipt when its later audit write
    // fails. Losing that receipt would label an accepted message failed and
    // invite a duplicate send. Never include the recipient/body in logs.
    if (err.providerOutcome?.sent === true) {
      return {
        success: true, state: 'provider_accepted',
        providerMessageId: err.providerOutcome.providerMessageId || null,
        auditLogId: err.providerOutcome.auditLogId || null,
        warning: 'The provider accepted the message, but its local audit could not be completed. Do not send it again.',
      };
    }
    logger.error(`[intelligence-bar:comms] Tool ${toolName} failed (code=${err.code || 'unknown'})`);
    return { error: err.message };
  }
}

function uncertainManualSmsResponse(outcome) {
  return {
    success: false,
    error: 'The carrier did not confirm this text. It may still go out; check the thread and do not retry it.',
    blocked: true,
    code: outcome?.code || 'SMS_DELIVERY_UNCERTAIN',
    mayHaveSent: true,
    retry: false,
    retryable: false,
  };
}

function isUncertainManualSmsOutcome(outcome) {
  return manualSmsDeliveryState(outcome) === 'uncertain'
    || outcome?.deliveryOutcome === 'uncertain'
    || outcome?.providerOutcome?.deliveryOutcome === 'uncertain';
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

// A name match must be UNIQUE among live customers before anything acts on
// it. The old `.first()` (no ORDER BY, no deleted_at filter) let "Smith"
// resolve to whichever row Postgres returned first — possibly an archived/
// merged-away customer. Ambiguity is returned as a structured error so the
// tool can ask the operator to disambiguate instead of guessing.
function ambiguousCustomerMatch(name, matches) {
  // The error string is PERSISTED verbatim in tool-health telemetry
  // (recordToolEvent -> tool_health_events.error_message), so it must not
  // carry the typed name — the candidates array holds the detail and only
  // reaches the operator-facing tool result.
  return {
    error: 'Multiple customers match that name. Ask the operator which one, then retry with customer_id.',
    ambiguous: true,
    candidates: matches.map(c => ({
      id: c.id,
      name: `${c.first_name} ${c.last_name || ''}`.trim(),
      phone_last4: (c.phone || '').replace(/\D/g, '').slice(-4) || null,
    })),
  };
}

// Returns a customer row, null (no match), or an { error, ambiguous,
// candidates } object — callers must pass an error-shaped result through.
async function resolveCustomer(input) {
  if (input.customer_id) return db('customers').where('id', input.customer_id).first();
  if (input.customer_name) {
    const matches = await db('customers').where(function () {
      const s = `%${input.customer_name}%`;
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("TRIM(first_name || ' ' || COALESCE(last_name, '')) ILIKE ?", [s]);
    }).whereNull('deleted_at').limit(2);
    if (matches.length > 1) return ambiguousCustomerMatch(input.customer_name, matches);
    return matches[0] || null;
  }
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, '').slice(-10);
    return db('customers').whereRaw("RIGHT(REPLACE(phone, '+', ''), 10) = ?", [digits])
      .whereNull('deleted_at').first();
  }
  return null;
}

// ─── cancel_queued_message / list_queued_messages ────────────────
// SMS-ONLY (owner ruling, 2026-09-28 "simple only" sweep). An email_messages
// 'queued' row is never a scheduled email to hold and maybe cancel — it is
// an in-flight send: sendTemplate renders it and hands it to SendGrid
// within seconds (QUEUED_IN_FLIGHT_MS = 2 min covers a crash-recovery
// window, not a genuine hold), so a cancel always races the sender at one
// producer site or another (the direct service-report sender, a claimed
// provider retry, …) — that is structural, not a bug this tool's CAS can
// close. Only a scheduled sms_log row (a genuine hold: quiet hours, an
// uncertain-delivery retry) is ever listed or cancelable.
//
// Never a send — these two tools only read and, on confirmed cancel,
// retire a row already queued by some OTHER sender. Masking mirrors the
// phone_last4 convention used throughout this module (ambiguousCustomerMatch
// above).
//
// The bar cancels only STANDALONE scheduled messages (owner ruling
// 2026-09-28, "simple only" for the bar's cancel surfaces). A row the
// deferred-replay registry owns (any registered entry_point — some run an
// onTerminal hook, others just hold state, e.g. invoice_send_deferred holds
// its invoice's send claim), that already reached the provider
// (finalize_only / review_delivery_uncertain_exhausted), or that belongs to
// a recruiting applicant thread, is refused OUTRIGHT — never redirected to
// the Communications inbox. That inbox's own cancel (DELETE
// /admin/communications/scheduled/:id) calls this SAME cancelScheduledSmsRow
// writer, which never runs the deferred-replay registry's terminal/finalize
// handling either, so following a redirect there would strand the exact
// same obligation a direct cancel here would.

function maskPhoneLast4(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-4);
  return digits ? `…${digits}` : null;
}

async function customerDisplayName(conn, customerId) {
  if (!customerId) return null;
  const row = await conn('customers').where({ id: customerId }).first('first_name', 'last_name');
  if (!row) return null;
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || null;
}

function parseSmsMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// Collapsed whitespace, capped at ~160 chars — enough for the operator to
// confirm this is the RIGHT message, never the full body. No PII beyond
// what the body already carries; the recipient itself stays masked
// everywhere this rides (Codex round 2 on #5224, P2).
// Digest of the COMPLETE body (Codex round 5 on #5224, P2): the 160-char
// preview alone misses an edit past the prefix. Same md5 the cancel writer's
// CAS computes in SQL (scheduled-sms-cancel.js), so the two always agree.
function bodyDigest(text) {
  return text == null ? null : crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

function bodyPreview(text) {
  if (!text) return null;
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
}

// Non-null only for a standalone-eligible sms_log row that is NOT actually
// cancelable — the reason string is shown to the operator verbatim. NEVER
// points at the Communications inbox: its own cancel (DELETE
// /admin/communications/scheduled/:id) calls the SAME cancelScheduledSmsRow
// writer, which does not run the deferred-replay registry's terminal/
// finalize handling either, so a redirect there would strand the same
// obligation a direct cancel here would (Codex round 2 on #5224, P1).
function smsIneligibilityReason(row) {
  const meta = parseSmsMetadata(row.metadata);
  // Already reached the provider: finalize_only means the text itself
  // delivered and this row only re-runs post-delivery finalization — not
  // "still queued" (scheduler.js).
  if (meta.finalize_only === true) {
    return 'This text has already reached the provider — it cannot be cancelled.';
  }
  // Provider-attempt / uncertain (Codex round 3 on #5224, P1):
  // review_ask_reservation is stamped by scheduled-sms-delivery.js's
  // dispatch() immediately BEFORE every review-ask provider call, and is
  // NOT cleared when an ambiguous attempt is held back to 'scheduled' for
  // its next ask-spacing retry (holdUncertainReservation) — only when
  // delivery is later proven accepted or definitely not sent. So a
  // 'scheduled' row can carry this marker with review_delivery_uncertain_
  // exhausted still false/absent (that flag is stamped only on the FINAL
  // such attempt): Twilio may already have accepted an EARLIER attempt and
  // the row was simply requeued for its next retry. Refuse both states —
  // never only the exhausted one.
  if (meta.review_ask_reservation === true || meta.review_delivery_uncertain_exhausted === true) {
    return "This text may already have reached the provider and can't be cancelled here.";
  }
  // Generic provider retry (Codex round 5 on #5224, P1): scheduler.js puts
  // ANY retryable send failure back to 'scheduled' stamped with
  // provider_retry_at — including a Twilio handoff whose outcome was
  // 'uncertain', where the provider may already have accepted the text.
  // Nothing persisted distinguishes that from a definite not-sent retry, so
  // every requeued-after-attempt row is refused conservatively. (The retry
  // also moves scheduled_for, which the commit's CAS pin refuses on.)
  // Any prior send claim at all (Codex round 6 on #5224, P1): besides
  // provider retries, recoverStaleScheduledSmsClaims requeues a row whose
  // worker died mid-send (scheduled_sms_recovered_at) — possibly after
  // Twilio accepted it. Every claim stamps scheduled_sms_claimed_at, so the
  // bar cancels only texts NO worker has ever picked up (the simple-only
  // chokepoint, as #5214 did for visits), rather than one marker per round.
  //
  // Codex round 7 P1: producers mark this differently (twilio-webhook.js's
  // AI-reply retry row carries provider_retry: true), so match the marker
  // FAMILY by key name — the same regex the writer's CAS uses
  // (scheduled-sms-cancel.js PRIOR_ATTEMPT_KEY_RE).
  if (Object.keys(meta).some((k) => PRIOR_ATTEMPT_KEY_RE.test(k))) {
    return "This text already had a send attempt and may have reached the provider — it can't be cancelled here.";
  }
  // Agent Review linked (Codex round 6 on #5224, P1): cancelling a reply
  // that carries agent_decision_id / parked_decision_ids reopens or ignores
  // those decisions and can re-park them onto a SIBLING queued reply
  // (scheduled-sms-cancel.js). The bar cancels only texts with none, so the
  // card's "no other message is touched" is true; the writer re-checks this
  // in the same statement that cancels (simpleOnly).
  const parked = Array.isArray(meta.parked_decision_ids) ? meta.parked_decision_ids : [];
  if (meta.agent_decision_id || parked.length) {
    return "This text is tied to an Agent Review suggestion and can't be cancelled here.";
  }
  // Recruiting threads are answered from Recruiting only — message_type is
  // the general, always-present signal (a recruiting send may carry no
  // entry_point at all).
  if (isRecruitingMessageType(row.message_type)) {
    return "This text is managed by the Recruiting workflow and can't be cancelled here.";
  }
  // Workflow-owned: ANY entry point the deferred-replay registry owns. Some
  // register an onTerminal hook the executor runs on every terminal outcome
  // (undoing a claim, arming a fallback sender, flipping a status back to an
  // admin retry lane); others hold state without one (an
  // invoice_send_deferred row keeps its invoice's send claim). The bar
  // cancels neither — the registry's own lookup decides, never a hand-kept
  // list of entry points.
  if (isDeferredReplayEntryPoint(meta.entry_point)) {
    return `This text is managed by the ${String(meta.entry_point).replace(/_/g, ' ')} workflow and can't be cancelled here.`;
  }
  // Last and catch-all — ALLOWLIST, not another marker (Codex round 9 on #5224, P1: a deposit-
  // receipt requeue marks its retry only with its own entry_point; rounds
  // 5-9 each found one more producer's retry spelling). The bar cancels only
  // a text a STAFF MEMBER scheduled from the inbox (admin_user_id set) whose
  // metadata carries nothing beyond SIMPLE_SMS_META_KEYS. Every automated
  // producer's row is refused, whatever it calls its markers. The writer's
  // simpleOnly CAS enforces the same rule (scheduled-sms-cancel.js).
  if (!row.admin_user_id || Object.keys(meta).some((k) => !SIMPLE_SMS_META_KEYS.has(k))) {
    return "This text was queued by an automated workflow, not scheduled by staff — it can't be cancelled here.";
  }
  return null;
}

// Load the pinned row, judge whether it belongs to this customer, and build
// the fields a cancel card/list entry shows — the SMS store (the only one;
// see the SMS-ONLY note above).
const SMS_STORE = {
  table: 'sms_log',
  baseWhere: { direction: 'outbound' },
  liveStatus: 'scheduled',
  sentStatuses: ['sent', 'delivered'],
  alreadySentError: 'This text has already been sent — it cannot be recalled.',
  noLongerLiveError: 'This text is no longer scheduled — it may already be sending, sent, or resolved. Call list_queued_messages again.',
  notLinkedError: 'This text is not linked to a customer.',
  effect: 'Cancels this ONE scheduled text before it sends. No other queued message is touched, and nothing is sent to the customer.',
  customerId: (row) => row.customer_id || null,
  maskedRecipient: (row) => maskPhoneLast4(row.to_phone),
  kind: (row) => row.message_type || 'sms',
  scheduledIso: (row) => (row.scheduled_for ? new Date(row.scheduled_for).toISOString() : null),
  // Pinned claim state: the worker's own claim (claimDueScheduledSms,
  // scheduler.js) flips status 'scheduled' -> 'sending' the instant it
  // claims the row, so pinning scheduled_for here and re-checking it at
  // commit refuses a message that started sending or was rescheduled.
  // body_preview rides in the pin too (Codex round 2 P2) — a reviewer
  // editing the queued body between the card and Confirm must also refuse,
  // not silently cancel the wrong-worded message. to_phone rides in the pin
  // too (Codex round 3 P2) — customer-contact-fanout.js can retarget a
  // still-'scheduled' row's to_phone on a phone edit without touching
  // status or scheduled_for, so the scheduled_for pin alone would not
  // catch a card shown for one number committing against a different one.
  // body_digest (Codex round 5 P2) pins the complete body, not just the
  // preview prefix, and is enforced in the writer's DELETE/UPDATE too.
  version: (row, scheduledIso, previewText) => ({ scheduled_for: scheduledIso, body_preview: previewText, body_digest: bodyDigest(row.message_body), to_phone: row.to_phone || null }),
  ineligibilityReason: smsIneligibilityReason,
};

// Builds the ONE-message preview a cancel card shows, from a fresh read —
// never a cached/guessed value. Throws a plain, operator-readable Error for
// every ineligible state (not found, already sent, workflow-owned, not a
// customer message); the caller turns that into { error } so a failed read
// always REFUSES, never reads as "nothing queued". No row lock here — the
// sms cancel workflow's own CAS statement is the atomic check
// (scheduled-sms-cancel.js).
async function queuedMessagePreview(conn, messageId, channel) {
  if (channel !== 'sms') throw new Error('channel must be "sms".');
  const store = SMS_STORE;
  const row = await conn(store.table).where({ id: messageId, ...store.baseWhere }).first();
  if (!row) throw new Error('That message could not be found.');
  if (row.status !== store.liveStatus) {
    throw new Error(store.sentStatuses.includes(row.status) ? store.alreadySentError : store.noLongerLiveError);
  }
  const customerId = store.customerId(row);
  if (!customerId) throw new Error(store.notLinkedError);
  const ineligible = store.ineligibilityReason(row);
  if (ineligible) throw new Error(ineligible);
  const scheduledIso = store.scheduledIso(row);
  const previewText = bodyPreview(row.message_body);
  return {
    proposal: true,
    channel,
    message_id: row.id,
    customer_id: customerId,
    customer_name: await customerDisplayName(conn, customerId),
    masked_recipient: store.maskedRecipient(row),
    kind: store.kind(row),
    scheduled_time: scheduledIso,
    body_preview: previewText,
    effect: store.effect,
    _version: store.version(row, scheduledIso, previewText),
  };
}

const LIST_QUEUED_MESSAGES_DEFAULT_LIMIT = 25;
const LIST_QUEUED_MESSAGES_MAX_LIMIT = 100;
const LIST_QUEUED_MESSAGES_MAX_BATCHES = 10;

// Bounded like every other paged IB reader (query_customers, getScheduleView
// in tools.js): fetch one row past the page to learn has_more without a
// second COUNT query, soonest-first (Codex round 3 on #5224, P2 — an
// unbounded scan is an unnecessary footgun even though a real customer's
// scheduled queue is normally tiny).
//
// Keyset cursor, not an offset (Codex round 5 on #5224, P2): this is a live
// queue — the scheduler claims rows ('scheduled' → 'sending') between pages,
// so an offset would skip rows. The cursor is the last row's
// (scheduled_for truncated to ms, id); id breaks ties. Rows with no
// scheduled_for sort last.
const SF_MS = "date_trunc('milliseconds', scheduled_for)";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeQueueCursor(row) {
  const sf = row.scheduled_for ? new Date(row.scheduled_for).toISOString() : '';
  return Buffer.from(`${sf}|${row.id}`, 'utf8').toString('base64url');
}

function decodeQueueCursor(cursor) {
  if (!cursor) return null;
  const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
  const bar = raw.lastIndexOf('|');
  if (bar < 0) return undefined;
  const sf = raw.slice(0, bar);
  const id = raw.slice(bar + 1);
  // The id is bound against the uuid sms_log.id column — a non-uuid would
  // make Postgres reject the query instead of this clean refusal (Codex
  // round 7 P2).
  if (!UUID_RE.test(id) || (sf && Number.isNaN(Date.parse(sf)))) return undefined;
  return { scheduled_for: sf || null, id };
}

// Rows strictly after the cursor row in the listing's own order
// ((scheduled_for ms, id), NULL scheduled_for last): one row-value
// comparison, with 'infinity' standing in for NULL so it sorts last.
function afterQueueCursor(query, at) {
  if (!at) return;
  query.whereRaw(
    `(COALESCE(${SF_MS}, 'infinity'::timestamptz), id) > (COALESCE(?::timestamptz, 'infinity'::timestamptz), ?::uuid)`,
    [at.scheduled_for ? new Date(at.scheduled_for).toISOString() : null, at.id],
  );
}

function queueListNote(excluded, hasMore) {
  const parts = [];
  if (excluded > 0) parts.push(`${excluded} other scheduled text(s) on this page are still queued to send but can't be cancelled from the bar (workflow-owned, already attempted, or tied to Agent Review) — the office handles those.`);
  if (hasMore) parts.push('More are queued; call again with next_cursor.');
  return parts.length ? { note: parts.join(' ') } : {};
}

async function listQueuedMessages(input) {
  const customer = await resolveCustomer(input);
  if (!customer) return { error: 'Customer not found.' };
  if (customer.error) return customer;
  const limit = Math.max(1, Math.min(Math.trunc(input.limit) || LIST_QUEUED_MESSAGES_DEFAULT_LIMIT, LIST_QUEUED_MESSAGES_MAX_LIMIT));
  const after = decodeQueueCursor(input.cursor);
  if (after === undefined) return { error: 'That cursor is not valid — call list_queued_messages again without one.' };
  // Ineligible rows (workflow-owned, recruiting, already attempted) are
  // dropped from the listing, so keep reading batches until the page is full
  // or the queue is exhausted — a caller would read [] as "nothing queued"
  // (pre-push audit on #5224 round-5 fix). Bounded batch count — only a queue
  // with over 10 pages of back-to-back ineligible rows can still return an
  // empty page with has_more, and the result then says so. The
  // cursor always points at the last row EXAMINED, so a capped read resumes
  // exactly where it stopped.
  const messages = [];
  let excluded = 0;
  let cursor = after;
  let lastExamined = null;
  let hasMore = false;
  for (let batch = 0; batch < LIST_QUEUED_MESSAGES_MAX_BATCHES && messages.length < limit; batch += 1) {
    const want = limit - messages.length;
    const rows = await db('sms_log')
      .where({ customer_id: customer.id, direction: 'outbound', status: 'scheduled' })
      .modify(afterQueueCursor, cursor)
      .orderByRaw(`${SF_MS} ASC NULLS LAST, id ASC`)
      .limit(want + 1)
      .select('id', 'to_phone', 'message_type', 'scheduled_for', 'metadata', 'message_body', 'admin_user_id');
    hasMore = rows.length > want;
    const page = hasMore ? rows.slice(0, want) : rows;
    for (const row of page) {
      lastExamined = row;
      if (smsIneligibilityReason(row)) { excluded += 1; continue; } // not the bar's to cancel — counted, never silently hidden
      messages.push({
        message_id: row.id, channel: 'sms', masked_recipient: maskPhoneLast4(row.to_phone),
        kind: row.message_type || 'sms',
        scheduled_time: row.scheduled_for ? new Date(row.scheduled_for).toISOString() : null,
        body_preview: bodyPreview(row.message_body),
      });
    }
    if (!hasMore) break;
    cursor = lastExamined;
  }
  return {
    customer_id: customer.id,
    customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || null,
    messages, total: messages.length,
    has_more: hasMore,
    next_cursor: hasMore ? encodeQueueCursor(lastExamined) : null,
    // Codex round 7 P2: texts the bar cannot cancel are still queued to
    // send — say so, or [] reads as "nothing is queued".
    excluded_count: excluded,
    ...queueListNote(excluded, hasMore),
  };
}

// Deterministic — both call sites build `_version` from the same object
// literal shape, so a plain stable-key JSON compare is exact.
function sameVersion(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

async function commitCancelSms(input, preview, technicianId) {
  // Re-derive eligibility + the current pin fresh (cheap, no lock here —
  // the actual atomicity guarantee is cancelScheduledSmsRow's own CAS
  // inside its own transaction/thread lock, scoped to the pinned
  // scheduled_for/to_phone below).
  let fresh;
  try {
    fresh = await queuedMessagePreview(db, input.message_id, 'sms');
  } catch (err) {
    return { error: `${err.message} Nothing was changed.`, preview_changed: true };
  }
  if (!sameVersion(fresh._version, input._verified_message_version)) {
    return {
      error: 'This message changed after the card was shown — nothing was changed. Ask again for a fresh confirmation card.',
      preview_changed: true,
    };
  }
  const result = await cancelScheduledSmsRow({
    id: input.message_id,
    techRole: 'admin', // every IB comms tool is admin-only (action-policy.json)
    technicianId: technicianId || null, // the confirming admin — recorded on agent_decisions.reviewed_by if a parked decision reopens
    expectedScheduledFor: fresh._version.scheduled_for,
    expectedToPhone: fresh._version.to_phone,
    expectedBodyDigest: fresh._version.body_digest,
    expectedCustomerId: fresh.customer_id,
    simpleOnly: true,
  });
  if (result.outcome !== 'ok' || !result.cancelled) {
    // 'forbidden' cannot happen (techRole is always 'admin' here); 'not_found'
    // or a CAS miss both mean the row is no longer the one the card showed.
    return {
      error: 'Could not verify this message as still queued right now — nothing was changed. It may have started sending or been rescheduled. Ask again for a fresh confirmation card.',
      preview_changed: true,
    };
  }
  return {
    success: true, cancelled: true, channel: 'sms', message_id: input.message_id,
    customer_id: preview.customer_id, customer_name: preview.customer_name,
    masked_recipient: preview.masked_recipient, kind: preview.kind, messages_sent: false,
  };
}

// Two-step write (issue #1568 / ib-write-tools skill): an unconfirmed call
// returns only a preview (read-only, zero mutation — proven by the
// write-gate behavioral contract). Only /confirm-action can ever set
// input.confirmed; no model-facing schema declares it. Never a send: the
// commit is a single status column write on a row some OTHER sender
// already queued. SMS only — see the SMS-ONLY note above the tool
// definitions for why an email_messages row can never be safely cancelled.
async function cancelQueuedMessage(input, actionContext = {}) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(String(input.message_id || '')) || !uuid.test(String(input.customer_id || ''))) {
    return { error: 'Resolve the message and customer IDs first — call list_queued_messages.' };
  }
  const channel = String(input.channel || '').toLowerCase();
  if (channel !== 'sms') {
    return { error: 'channel must be "sms". Scheduled texts are the only cancelable message — emails send within seconds and cannot be recalled.' };
  }

  let preview;
  try {
    preview = await queuedMessagePreview(db, input.message_id, channel);
  } catch (err) {
    // A failed read REFUSES — it never falls through as "nothing queued".
    // On Confirm it means the message changed since the card (claimed,
    // sent, deleted), so it is flagged like every other confirm-time drift.
    return input.confirmed === true
      ? { error: `${err.message} Nothing was changed.`, preview_changed: true }
      : { error: err.message };
  }
  if (String(preview.customer_id).toLowerCase() !== String(input.customer_id).toLowerCase()) {
    return { error: 'That message does not belong to the named customer. Call list_queued_messages again to resolve the correct id.' };
  }
  if (input.confirmed !== true) return preview;
  if (!input._verified_message_version) {
    return { error: 'Use the confirmation card to approve this change.' };
  }
  return commitCancelSms(input, preview, actionContext?.technicianId);
}

async function getUnansweredThreads(input) {
  const { hours_back = 48, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 50);
  const since = new Date(Date.now() - hours_back * 3600000).toISOString();

  // Get recent inbound messages. Recruiting rows (job_*) are never a thread
  // for this tool (Codex #4623 r29 P1): an applicant reply answered through
  // the generic send would become customer-thread evidence on a shared
  // phone — applicants are answered from Recruiting.
  const inbound = await db('sms_log')
    .modify((qb) => excludeRecruitingSmsLog(qb))
    .where('direction', 'inbound')
    .where('created_at', '>=', since)
    .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
    .select(
      'sms_log.from_phone', 'sms_log.to_phone', 'sms_log.message_body',
      'sms_log.created_at', 'sms_log.customer_id', 'sms_log.is_read',
      'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
    )
    .orderBy('sms_log.created_at', 'desc').orderBy('sms_log.id', 'desc');

  // For each inbound, check if there's a later outbound to the same number
  const unanswered = [];
  const seenPhones = new Set();

  for (const msg of inbound) {
    if (isAdminPhone(msg.from_phone)) continue;
    const digits = (msg.from_phone || '').replace(/\D/g, '').slice(-10);
    if (seenPhones.has(digits)) continue;
    seenPhones.add(digits);

    // Check for a reply after this message. An unresolved review-ask
    // reservation (Codex #4331 P2) is excluded — its unconfirmed placeholder
    // must not read as a real reply and mask a genuinely unanswered thread.
    const reply = await excludeUnresolvedSendReservations(db('sms_log'))
      .where('direction', 'outbound')
      .where('created_at', '>', msg.created_at)
      .where(function () {
        this.where('to_phone', msg.from_phone)
          .orWhereRaw("RIGHT(REPLACE(to_phone, '+', ''), 10) = ?", [digits]);
      })
      .first();

    if (!reply) {
      unanswered.push({
        phone: msg.from_phone,
        customer: msg.first_name ? `${msg.first_name} ${msg.last_name}` : null,
        customer_id: msg.customer_id,
        tier: msg.waveguard_tier,
        last_message: msg.message_body,
        received_at: msg.created_at,
        waiting_minutes: Math.round((Date.now() - new Date(msg.created_at)) / 60000),
        is_read: msg.is_read,
      });
    }

    if (unanswered.length >= limit) break;
  }

  return {
    unanswered_threads: unanswered,
    total: unanswered.length,
    hours_checked: hours_back,
    urgent: unanswered.filter(t => t.waiting_minutes > 120).length,
  };
}


async function getConversationThread(input) {
  const { limit: rawLimit } = input;
  const limit = Math.max(1, Math.min(Math.trunc(rawLimit || 20), 50));
  const offset = Math.max(0, Math.trunc(input.offset || 0));

  let phone;
  if (input.phone) {
    phone = input.phone;
  } else {
    const customer = await resolveCustomer(input);
    if (!customer) return { error: 'Customer not found' };
    if (customer.error) return customer;
    phone = customer.phone;
  }

  if (!phone) return { error: 'No phone number found' };
  const digits = phone.replace(/\D/g, '').slice(-10);

  const fetched = await db('sms_log')
    .where(function () {
      this.whereRaw("RIGHT(REPLACE(from_phone, '+', ''), 10) = ?", [digits])
        .orWhereRaw("RIGHT(REPLACE(to_phone, '+', ''), 10) = ?", [digits]);
    })
    .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
    .modify(qb => {
      if (input.customer_id) qb.where(scope => scope.where('sms_log.customer_id', input.customer_id).orWhereNull('sms_log.customer_id'));
    })
    // Unresolved review-ask reservations excluded BEFORE the limit (Codex
    // #4331 P2): the in-flight placeholder must not displace a real message
    // out of this bounded conversation window — a resolved row still shows.
    .modify(excludeUnresolvedSendReservations)
    // Recruiting rows stay out of the Intelligence Bar (Codex #4623 r29 P1).
    .modify((qb) => excludeRecruitingSmsLog(qb))
    .select(
      'sms_log.id', 'sms_log.direction', 'sms_log.message_body',
      'sms_log.from_phone', 'sms_log.to_phone',
      'sms_log.message_type', 'sms_log.created_at',
      'customers.first_name', 'customers.last_name',
    )
    .orderBy('sms_log.created_at', 'desc')
    .orderBy('sms_log.id', 'desc').limit(limit + 1).offset(offset);
  const messages = fetched.slice(0, limit);

  const customerName = messages.find(m => m.first_name)
    ? `${messages.find(m => m.first_name).first_name} ${messages.find(m => m.first_name).last_name}`
    : null;

  return {
    phone,
    customer_name: customerName,
    messages: messages.reverse().map(m => ({
      direction: m.direction,
      body: m.message_body,
      type: m.message_type,
      time: m.created_at,
      from: m.direction === 'inbound' ? (customerName || m.from_phone) : 'Waves',
    })),
    returned_count: messages.length,
    has_more: fetched.length > limit,
    next_offset: fetched.length > limit ? offset + limit : null,
  };
}


async function searchMessages(input) {
  const { search, customer_name, phone: requestedPhone, direction, message_type, days_back = 7, limit: rawLimit } = input;
  let phone = requestedPhone;
  if (input.customer_id) {
    const customer = await db('customers').where('id', input.customer_id).whereNull('deleted_at').first('phone');
    if (!customer) return { error: 'The requested customer is unavailable', code: 'record_unavailable' };
    phone = customer.phone;
    if (requestedPhone && String(requestedPhone).replace(/\D/g, '').slice(-10) !== String(phone || '').replace(/\D/g, '').slice(-10)) {
      return { error: 'The phone no longer matches the requested customer', code: 'target_relationship_mismatch' };
    }
  }
  const limit = Math.min(rawLimit || 20, 100);
  const offset = Math.max(0, Math.trunc(input.offset || 0));
  const since = new Date(Date.now() - days_back * 86400000).toISOString();

  // Unresolved review-ask reservations excluded BEFORE the limit (Codex
  // #4331 P2): a still in-flight placeholder must not surface here as a
  // real sent message — a resolved row still shows.
  let query = excludeRecruitingSmsLog(excludeUnresolvedSendReservations(db('sms_log')))
    .where('sms_log.created_at', '>=', since)
    .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
    .select(
      'sms_log.*',
      'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
    )
    .orderBy('sms_log.created_at', 'desc').orderBy('sms_log.id', 'desc');

  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  const atPhone = scope => scope.whereRaw("RIGHT(REPLACE(sms_log.from_phone, '+', ''), 10) = ?", [digits])
    .orWhereRaw("RIGHT(REPLACE(sms_log.to_phone, '+', ''), 10) = ?", [digits]);
  if (search) query = query.whereILike('sms_log.message_body', `%${search}%`);
  if (input.customer_id) query = query.where(scope => {
    scope.where('sms_log.customer_id', input.customer_id);
    // Linked history stays with its account after a number change. Only
    // unlinked history needs the current saved phone as ownership evidence.
    if (digits.length === 10) scope.orWhere(unlinked => unlinked.whereNull('sms_log.customer_id').where(atPhone));
  });
  if (direction) query = query.where('sms_log.direction', direction);
  if (message_type) query = query.where('sms_log.message_type', message_type);

  if (customer_name) {
    query = query.where(function () {
      this.whereILike('customers.first_name', `%${customer_name}%`)
        .orWhereILike('customers.last_name', `%${customer_name}%`)
        .orWhereRaw("TRIM(customers.first_name || ' ' || COALESCE(customers.last_name, '')) ILIKE ?", [`%${customer_name}%`]);
    });
  }
  if (requestedPhone) query = query.where(atPhone);

  const fetched = await query.limit(limit + 1).offset(offset);
  const messages = fetched.slice(0, limit);

  return {
    has_more: fetched.length > limit,
    next_offset: fetched.length > limit ? offset + limit : null,
    coverage: { days_back: input.call_id ? null : days_back, offset, limit },
    messages: messages.filter(m => !isAdminPhone(m.from_phone) && !isAdminPhone(m.to_phone)).map(m => ({
      id: m.id,
      direction: m.direction,
      body: m.message_body,
      type: m.message_type,
      customer: m.first_name ? `${m.first_name} ${m.last_name}` : null,
      phone: m.direction === 'inbound' ? m.from_phone : m.to_phone,
      time: m.created_at,
    })),
    search_params: { search, direction, message_type, days_back },
  };
}


async function getSmsStats(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Unresolved review-ask reservations excluded from every stat (Codex
  // #4331 P2): an in-flight, unconfirmed placeholder must not inflate the
  // outbound-count signal — a resolved row still counts normally.
  const [byDirection, byType, byDay] = await Promise.all([
    excludeUnresolvedSendReservations(db('sms_log')).where('created_at', '>=', since)
      .select('direction', db.raw('COUNT(*) as count'))
      .groupBy('direction'),
    excludeUnresolvedSendReservations(db('sms_log')).where('created_at', '>=', since)
      .select('message_type', db.raw('COUNT(*) as count'))
      .groupBy('message_type').orderByRaw('COUNT(*) DESC'),
    excludeUnresolvedSendReservations(db('sms_log')).where('created_at', '>=', since)
      .select(db.raw("DATE(created_at) as day"), db.raw('COUNT(*) as count'), 'direction')
      .groupBy('day', 'direction').orderBy('day'),
  ]);

  const dirMap = {};
  byDirection.forEach(d => { dirMap[d.direction] = parseInt(d.count); });

  return {
    period_days: days,
    total_sent: dirMap.outbound || 0,
    total_received: dirMap.inbound || 0,
    by_type: byType.map(t => ({ type: t.message_type || 'unknown', count: parseInt(t.count) })),
    daily: byDay.map(d => ({ date: d.day, direction: d.direction, count: parseInt(d.count) })),
  };
}


// The Owed queue, read-only: listOpenCommitments is the same read the
// Communications → Owed tab and the overdue watchdog use, so the answer
// here is exactly what the office sees there.
async function getOpenCommitments(input) {
  const { listOpenCommitments, selectOverdue, overdueAt, OVERDUE_IMPLICIT_DAYS, OVERDUE_IMPLICIT_ESTIMATE_HOURS } = require('../call-commitments');
  const etMoment = (value) => (value ? etDateString(new Date(value)) + ' ' + new Date(value).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET' : null);
  const { isEnabled } = require('../../config/feature-gates');
  const party = input.party === 'customer' ? 'customer' : input.party === 'all' ? null : 'waves';
  let customerId = input.customer_id || null;
  let customerLabel = null;
  if (!customerId && input.customer_name) {
    const customer = await resolveCustomer({ customer_name: input.customer_name });
    if (customer && customer.ambiguous) return customer;
    if (!customer) return { commitments: [], note: `No customer matched "${input.customer_name}".` };
    customerId = customer.id;
    customerLabel = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  }
  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
  const rows = await listOpenCommitments(db, { party, customerId, limit, includeHints: true });
  const chosen = input.overdue_only ? selectOverdue(rows) : rows;
  return {
    enabled: isEnabled('callCommitments'),
    party: party || 'all',
    customer: customerLabel,
    // The implicit-deadline rules the queue applies when no time was stated
    // (Codex #3733 P2): estimates use elapsed hours, callbacks use the active
    // callback policy, and other prompts use OVERDUE_IMPLICIT_DAYS.
    // Each row also carries its own effective_due_at below.
    implicit_due_rules: {
      send_estimate: `${OVERDUE_IMPLICIT_ESTIMATE_HOURS} hours after the call`,
      callback: require('../callback-cards').enabled()
        ? 'four staffed hours after the call, using office hours and blackout dates'
        : "the end of the call's day (Eastern)",
      other_prompts: `${OVERDUE_IMPLICIT_DAYS} days after the call`,
    },
    total_open: rows.length,
    overdue: selectOverdue(rows).length,
    commitments: chosen.map((r) => ({
      id: r.id,
      party: r.party,
      kind: r.kind,
      description: r.description,
      due_at: etMoment(r.due_at),
      // The deadline the queue actually judges: the stated time, else the
      // kind's implicit one (null for kinds that wait for the office), pushed
      // out to the end of an active callback snooze.
      effective_due_at: etMoment(overdueAt(r)),
      snoozed_until: etMoment(r.snoozed_until),
      overdue: !!r.overdue,
      call_at: r.call_started_at ? new Date(r.call_started_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : null,
      customer: [r.customer_first_name, r.customer_last_name].filter(Boolean).join(' ') || null,
      customer_id: r.customer_id || null,
      call_log_id: r.call_log_id,
      source: r.source === 'human' ? 'office' : (r.extractor_version === 'relay-v1' ? 'AI phone assistant' : 'AI'),
      possibly_kept: r.fulfillment ? { kind: r.fulfillment.kind, basis: r.fulfillment.basis } : null,
    })),
    link: '/admin/communications#tab=owed',
  };
}

async function getCallLog(input) {
  const { direction, has_recording, has_transcript, customer_name, days_back = 7, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 50);
  const offset = Math.max(0, Math.trunc(input.offset || 0));
  const since = new Date(Date.now() - days_back * 86400000).toISOString();

  let query = db('call_log')
    .modify(qb => input.call_id ? qb.where('call_log.id', input.call_id) : qb.where('call_log.created_at', '>=', since))
    .modify((qb) => require('../voice-agent/relay-protocol').whereNotSandboxCall(qb, 'call_log.source')) // bake-off calls are not customer calls
    .leftJoin('customers', 'call_log.customer_id', 'customers.id')
    .select(
      'call_log.*',
      'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
    )
    .orderBy('call_log.created_at', 'desc').orderBy('call_log.id', 'desc');

  if (direction && direction !== 'all') query = query.where('call_log.direction', direction);
  if (input.customer_id) query = query.where('call_log.customer_id', input.customer_id);
  if (has_recording) query = query.whereNotNull('call_log.recording_url').where('call_log.recording_url', '!=', '');
  if (has_transcript) query = query.whereNotNull('call_log.transcription');
  if (customer_name) {
    query = query.where(function () {
      this.whereILike('customers.first_name', `%${customer_name}%`)
        .orWhereILike('customers.last_name', `%${customer_name}%`)
        .orWhereRaw("TRIM(customers.first_name || ' ' || COALESCE(customers.last_name, '')) ILIKE ?", [`%${customer_name}%`]);
    });
  }

  const fetched = await query.limit(limit + 1).offset(offset);
  const calls = fetched.slice(0, limit).filter(c => !isAdminPhone(c.from_phone) || !isAdminPhone(c.to_phone));

  return {
    has_more: fetched.length > limit,
    next_offset: fetched.length > limit ? offset + limit : null,
    coverage: { days_back: input.call_id ? null : days_back, offset, limit },
    calls: calls.map(c => ({
      id: c.id,
      direction: c.direction,
      from: c.from_phone,
      to: c.to_phone,
      customer: c.first_name ? `${c.first_name} ${c.last_name}` : null,
      tier: c.waveguard_tier,
      status: c.status,
      duration_seconds: c.duration_seconds,
      has_recording: !!(c.recording_url),
      has_transcript: !!(c.transcription),
      transcript_excerpt: c.transcription ? c.transcription.substring(0, 200) : null,
      ...(input.call_id ? {
        transcript: c.transcription ? c.transcription.slice(Math.max(0, input.transcript_offset || 0), Math.max(0, input.transcript_offset || 0) + 12000) : null,
        transcript_next_offset: c.transcription?.length > Math.max(0, input.transcript_offset || 0) + 12000 ? Math.max(0, input.transcript_offset || 0) + 12000 : null,
      } : { transcript_coverage: 'First 200 characters only; use call_id to read the transcript' }),
      sentiment: c.sentiment,
      time: c.created_at,
    })),
    returned_count: calls.length,
  };
}


// Map the legacy message_type strings used by Comms manual sends to the
// customer-message-middleware purpose enum. Mappings carry through to
// policy enforcement (consent, voice, segment). The legacy messageType
// is preserved separately via metadata.original_message_type so the
// admin-sms-templates kill switch + twilio.js manual-vs-MMS branch
// keep working.
function mapCommsMessageTypeToPurpose(messageType) {
  switch (messageType) {
    // Appointment-family — hits the service_reminder_24h preference gate
    // so opted-out reminder customers don't receive ANY of these.
    case 'reminder':                // send_sms tool's enum value
    case 'appointment_reminder':
    case 'tech_en_route':
    case 'service_complete':
    case 'booking_confirmation':
      return 'appointment';
    case 'billing_reminder':
      return 'billing';
    case 'payment_link':
      return 'payment_link';
    case 'review_request':
      return 'review_request';
    case 'estimate_followup':
      return 'estimate_followup';
    // 'follow_up' is general post-service outreach (not a hard reminder).
    // Keep it conversational so it doesn't hit service_reminder_24h, but
    // still goes through the customer-voice validators.
    case 'follow_up':
    case 'manual':
    default:
      return 'conversational';
  }
}

async function sendSms(input) {
  const { customer_name, customer_id, phone: directPhone, message, message_type = 'manual' } = input;

  let phone = directPhone;
  let customerName = null;
  let custId = customer_id;

  // Resolve identity carefully — never cross-wire a customerId to a different
  // recipient phone. The wrapper's consent + identity validators trust
  // customerId, so attaching a customerId that belongs to a different person
  // than the destination phone bypasses that customer's opt-out.
  //
  //   1. Only customer_id given: look up by id, use that record's phone.
  //   2. Only phone given: look up by phone (last-10 digits) — only attach
  //      the customerId if the phones genuinely match. Phone-format
  //      mismatches skip the indexed lookup; wrapper falls back to phone-
  //      match consent, which is the safe degraded mode.
  //   3. Only customer_name given: resolve by name, use that record's phone.
  //   4. BOTH phone AND id (or phone AND name): trust the phone as
  //      destination AND only keep the customerId when its record's phone
  //      matches the typed phone. A name-or-id-attached record with a
  //      DIFFERENT phone gets dropped — wrapper does phone-only consent
  //      lookup. This is the codex P1 fix.
  if (!custId && !phone) {
    const customer = await resolveCustomer(input);
    if (!customer) return { error: 'Customer not found' };
    if (customer.error) return customer;
    customerName = `${customer.first_name} ${customer.last_name}`;
    custId = customer.id;
    phone = customer.phone;
  } else if (custId && !phone) {
    const customer = await db('customers').where('id', custId).whereNull('deleted_at').first();
    if (!customer) return { error: 'Customer not found' };
    if (!customer.phone) return { error: 'Customer has no phone number' };
    customerName = `${customer.first_name} ${customer.last_name}`;
    phone = customer.phone;
  } else if (!custId && phone) {
    // Phone given but no customer_id. Try to find a customer record whose
    // phone matches the typed phone (last 10 digits, format-agnostic).
    const inputDigits = phone.replace(/\D/g, '').slice(-10);
    if (inputDigits.length === 10) {
      const customer = await db('customers')
        .whereRaw("RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = ?", [inputDigits])
        .whereNull('deleted_at')
        .first();
      if (customer) {
        customerName = `${customer.first_name} ${customer.last_name}`;
        custId = customer.id;
      }
    }
  } else {
    // BOTH custId and phone given. Verify they belong to the same record;
    // if not, trust the typed phone and drop the id. Prevents cross-wired
    // consent (codex P1).
    // deleted_at filter: a customer archived/merged-away after the card was
    // proposed must NOT pass the pin check just because the phone is
    // unchanged — the lookup misses, phonesMatch is false, and a pinned
    // confirmation refuses (codex P1 on the drift-guard round). Un-pinned
    // sends degrade to phone-only consent, never an archived identity.
    const customer = await db('customers').where('id', custId).whereNull('deleted_at').first();
    const inputDigits = phone.replace(/\D/g, '').slice(-10);
    const customerDigits = customer ? (customer.phone || '').replace(/\D/g, '').slice(-10) : null;
    const phonesMatch = !!customer && inputDigits === customerDigits && inputDigits.length === 10;
    // _require_phone_match rides on a proposal-pinned confirmation: the card
    // showed a specific person + phone last4, so if the record's phone
    // changed (or the record vanished) inside the pending window, REFUSE and
    // make the operator rebuild the card — never silently send to a number
    // nobody approved (codex P1 on the pinning round).
    if (input._require_phone_match && !phonesMatch) {
      return {
        error: 'Customer phone changed after the card was approved. Rebuild the confirmation card.',
        preview_changed: true,
      };
    }
    if (phonesMatch) {
      customerName = `${customer.first_name} ${customer.last_name}`;
    } else {
      custId = null;
    }
  }

  if (!phone) return { error: 'No phone number' };

  // Routed through the customer-message middleware. This is Virginia's
  // daily-driver send path, so the validators apply consistently:
  // suppression list, sms_enabled, no customer-emoji, segment metadata.
  // Operator messages still need to follow the customer voice rules.
  const result = await sendManualCustomerSms({
    to: phone,
    body: message,
    channel: 'sms',
    audience: 'customer',
    purpose: mapCommsMessageTypeToPurpose(message_type),
    customerId: custId || null,
    entryPoint: 'intelligence_bar_comms_send_sms',
    // billing_reminder honors the portal's Billing Reminder Delivery
    // dropdown: declaring the email leg makes the consent gate return
    // CHANNEL_EMAIL_ONLY for an email-preferring customer instead of
    // texting against their choice. The block is surfaced to the operator
    // (error/reason below), who IS the email fallback on this manual path —
    // unlike the automated flows, a block here is a prompt, not silence.
    // Customers with no billing/account email still fall back to SMS at
    // the gate itself.
    hasEmailLeg: message_type === 'billing_reminder' ? true : undefined,
    // metadata.original_message_type preserves the legacy messageType for
    // the admin-sms-templates kill switch + twilio.js manual-vs-MMS
    // logic. metadata.adminUserId populates sms_log.admin_user_id so
    // operator-typed sends are distinguishable from system-generated.
    metadata: {
      original_message_type: message_type,
      adminUserId: 'intelligence_bar',
    },
  });

  if (isUncertainManualSmsOutcome(result)) {
    return uncertainManualSmsResponse(result);
  }

  if (result.sent) {
    logger.info(`[intelligence-bar:comms] Sent SMS (custId=${custId || 'n/a'} segs=${result.segmentCount})`);
    return {
      success: true,
      state: 'provider_accepted',
      providerMessageId: result.providerMessageId || null,
      auditLogId: result.auditLogId || null,
      sent_to: phone,
      customer: customerName,
      message,
      char_count: message.length,
      segmentCount: result.segmentCount,
      encoding: result.encoding,
      ...(result.acceptedAfterError ? {
        warning: 'The provider accepted the message, but its local audit could not be completed. Do not send it again.',
      } : {}),
    };
  }
  // CRITICAL: Intelligence Bar tool-failure detection in
  // routes/admin-intelligence-bar.js keys on `result.error` (truthy =
  // failure) and /execute success is `!result.error`. Without an explicit
  // error field, blocked sends would be reported as successful tool
  // executions at the API layer.
  // CHANNEL_EMAIL_ONLY on a billing reminder is a REDIRECT, not a dead end:
  // the operator is the email fallback on this manual path (DECISIONS
  // round-4 ruling) — spell out the next step so the model relays it as an
  // instruction rather than a generic failure.
  const actionableError = result.code === 'CHANNEL_EMAIL_ONLY' && message_type === 'billing_reminder'
    ? 'This customer has Billing Reminder Delivery set to EMAIL — the text was not sent. Send this reminder to their billing/account email instead.'
    : null;
  return {
    success: false,
    error: actionableError || result.reason || result.code || 'send blocked',
    blocked: !!result.blocked,
    code: result.code,
    reason: result.reason,
    sent_to: phone,
    customer: customerName,
  };
}


async function draftSmsReply(input) {
  const customer = await resolveCustomer(input);
  if (!customer) return { error: 'Customer not found' };
  if (customer.error) return customer;
  if (!customer.phone) return { error: 'Customer has no phone number' };

  const digits = customer.phone.replace(/\D/g, '').slice(-10);

  // Get the last inbound message from this customer
  const lastInbound = await db('sms_log')
    // never an applicant's hiring reply on a shared phone (PR #4623 r31)
    .modify((qb) => excludeRecruitingSmsLog(qb))
    .where('direction', 'inbound')
    .where(scope => scope.where('customer_id', customer.id).orWhereNull('customer_id'))
    .where(function () {
      this.whereRaw("RIGHT(REPLACE(from_phone, '+', ''), 10) = ?", [digits]);
    })
    .orderBy('created_at', 'desc').first();

  if (!lastInbound) return { note: 'No recent inbound message found from this customer', customer: `${customer.first_name} ${customer.last_name}` };

  // Get customer context
  const lastService = await db('service_records').where({ customer_id: customer.id, status: 'completed' }).orderBy('service_date', 'desc').first();
  const nextService = await db('scheduled_services').where({ customer_id: customer.id }).where('scheduled_date', '>=', etDateString()).whereNotIn('status', ['cancelled']).orderBy('scheduled_date').first();

  const Anthropic = require('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'ANTHROPIC_API_KEY not set' };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await ledgerCall('anthropic', MODELS.FLAGSHIP, () => client.messages.create({
    model: MODELS.FLAGSHIP,
    ...anthropicEffortConfig(MODELS.FLAGSHIP),
    max_tokens: anthropicMaxTokens(MODELS.FLAGSHIP, 200),
    messages: [{
      role: 'user',
      content: `Draft a short SMS reply (max 160 chars) for Waves Pest Control.

Customer: ${customer.first_name} ${customer.last_name} (${customer.waveguard_tier || 'Bronze'} tier)
Their message: "${lastInbound.message_body}"
${lastService ? `Last service: ${lastService.service_type} on ${lastService.service_date}` : ''}
${nextService ? `Next service: ${nextService.service_type} on ${nextService.scheduled_date}` : ''}
${input.context ? `Additional context: ${input.context}` : ''}

Keep it friendly, concise, and action-oriented. Sign as "- Waves Pest Control" only if there's room.
Plain keyboard punctuation only: straight quotes and hyphens, never curly quotes, em dashes, or the ellipsis character (they force UCS-2 encoding and multiply SMS segments).
Return ONLY the SMS text, nothing else.`
    }],
  }), { laneId: 'ib_tools' });

  const draft = anthropicText(msg);
  // An empty/refusal answer (a thinking-only or refused reply has no .text)
  // renders as a blank draft the human silently never sends — recorded a
  // success with nothing usable produced, the same gap this call ledger
  // exists to catch on every other draft lane.
  if (!draft.trim()) ledgerCallRejected(msg, 'invalid_output');

  return {
    draft: true,
    customer: `${customer.first_name} ${customer.last_name}`,
    phone: customer.phone,
    their_message: lastInbound.message_body,
    their_message_time: lastInbound.created_at,
    reply_draft: draft.trim(),
    char_count: draft.trim().length,
    note: 'This is a DRAFT. Say "send it" to deliver, or modify it.',
  };
}


async function getCsrOverview(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let overview = null;
  let tasks = [];
  let leadQuality = null;

  try {
    // CSR stats
    overview = await db('csr_call_records')
      .where('created_at', '>=', since)
      .select(
        db.raw('COUNT(*) as total_calls'),
        db.raw("COUNT(*) FILTER (WHERE outcome = 'booked') as booked"),
        db.raw("COUNT(*) FILTER (WHERE outcome = 'lost') as lost"),
        db.raw("COUNT(*) FILTER (WHERE outcome = 'follow_up') as follow_up"),
        db.raw('AVG(call_score) as avg_score'),
      ).first();
  } catch { /* table may not exist */ }

  try {
    // Follow-up tasks. The real table is ai_follow_up_tasks (csr_coach
    // migration) — this queried a non-existent csr_follow_up_tasks for
    // months and the try/catch silently returned nothing.
    tasks = await db('ai_follow_up_tasks')
      // Same active set as the canonical admin-csr task route (codex
      // #3232 r25): in_progress is being worked, not done.
      .whereIn('status', ['pending', 'in_progress'])
      .leftJoin('customers', 'ai_follow_up_tasks.customer_id', 'customers.id')
      .select('ai_follow_up_tasks.*', 'customers.first_name', 'customers.last_name', 'customers.phone')
      .orderBy('ai_follow_up_tasks.deadline').limit(10);
  } catch { /* table may not exist */ }

  try {
    // Lead quality breakdown
    leadQuality = await db('csr_call_records')
      .where('created_at', '>=', since)
      .where('outcome', 'lost')
      .select('loss_reason', db.raw('COUNT(*) as count'))
      .groupBy('loss_reason').orderByRaw('COUNT(*) DESC');
  } catch { /* table may not exist */ }

  return {
    period_days: days,
    overview: overview ? {
      total_calls: parseInt(overview.total_calls || 0),
      booked: parseInt(overview.booked || 0),
      lost: parseInt(overview.lost || 0),
      follow_up: parseInt(overview.follow_up || 0),
      booking_rate: parseInt(overview.total_calls || 0) > 0 ? Math.round(parseInt(overview.booked || 0) / parseInt(overview.total_calls) * 100) : 0,
      avg_score: overview.avg_score ? parseFloat(overview.avg_score).toFixed(1) : null,
    } : null,
    pending_follow_ups: tasks.map(t => ({
      id: t.id,
      customer: t.first_name ? `${t.first_name} ${t.last_name}` : 'Unknown',
      phone: t.phone,
      task: t.recommended_action || t.context_summary || t.task_type,
      due: t.deadline,
      type: t.task_type,
    })),
    lost_lead_reasons: (leadQuality || []).map(r => ({
      reason: r.loss_reason, count: parseInt(r.count),
    })),
  };
}


async function getTodaysActivity() {
  // "Today" anchored to America/New_York — Railway runs UTC
  const todayStart = parseETDateTime(`${etDateString()}T00:00:00`);
  const since = todayStart.toISOString();

  // Unresolved review-ask reservations excluded (Codex #4331 P2): an
  // in-flight, unconfirmed placeholder must not inflate today's outbound
  // count or count as the reply that closes out an unanswered thread — a
  // resolved row still counts/replies normally.
  const [smsIn, smsOut, calls, unanswered] = await Promise.all([
    db('sms_log').modify((qb) => excludeRecruitingSmsLog(qb)).where('direction', 'inbound').where('created_at', '>=', since).count('* as c').first(),
    excludeUnresolvedSendReservations(db('sms_log')).modify((qb) => excludeRecruitingSmsLog(qb)).where('direction', 'outbound').where('created_at', '>=', since).count('* as c').first(),
    db('call_log').where('created_at', '>=', since)
      .modify((qb) => require('../voice-agent/relay-protocol').whereNotSandboxCall(qb)) // bake-off calls are not today's activity
      .select(
      db.raw('COUNT(*) as total'),
      db.raw("COUNT(*) FILTER (WHERE direction = 'inbound') as inbound"),
      db.raw("COUNT(*) FILTER (WHERE status = 'no-answer' OR status = 'busy') as missed"),
    ).first(),
    // Count unanswered inbound messages from today
    db('sms_log').modify((qb) => excludeRecruitingSmsLog(qb)).where('direction', 'inbound').where('created_at', '>=', since)
      .whereNotExists(function () {
        excludeUnresolvedSendReservations(
          this.select(db.raw(1)).from(db.raw('sms_log as reply'))
            .whereRaw('reply.direction = ?', ['outbound'])
            .whereRaw('reply.created_at > sms_log.created_at'),
          'reply',
        )
          .whereRaw("RIGHT(REPLACE(reply.to_phone, '+', ''), 10) = RIGHT(REPLACE(sms_log.from_phone, '+', ''), 10)");
      })
      .count('* as c').first(),
  ]);

  return {
    date: etDateString(),
    sms_received: parseInt(smsIn?.c || 0),
    sms_sent: parseInt(smsOut?.c || 0),
    calls_total: parseInt(calls?.total || 0),
    calls_inbound: parseInt(calls?.inbound || 0),
    calls_missed: parseInt(calls?.missed || 0),
    unanswered_messages: parseInt(unanswered?.c || 0),
    needs_attention: parseInt(unanswered?.c || 0) > 0 || parseInt(calls?.missed || 0) > 0,
  };
}


// ─── Partner channel (B2B arrangers) ───────────────────────────
//
// Born from the 2026-07 call audit: WDO/real-estate calls come from REPEAT
// arrangers (realtors, lenders, property managers) booking for other people,
// every one urgent, price never negotiated — a channel, not walk-ins. Schema
// 1.7.0 gave arranger identity real enum values; these tools aggregate it.
// Sources BOTH extraction generations: the V2 enriched payload
// (caller.relationship_to_property / organization_name) and — because most
// history predates 1.7.0, when realtors were forced into "other" — a
// deterministic transcript/summary signal (WDO/realtor/lender phrasing).
// Read-only; wrapped per-query try/catch via executeCommsTool.

const ARRANGER_RELATIONSHIPS = ['real_estate_agent', 'lender', 'property_manager'];

// FULL phrases (no truncated stems — 'compan\\y' never matches 'company').
const ARRANGER_PHRASE_RE = /\b(realtor|real estate agent|buyer'?s agent|seller'?s agent|lender|loan officer|title company|closing coordinator|property manager|property management)\b/i;

// Legacy rows predate schema 1.7.0, when arranger callers were forced into
// relationship "other" — infer the enum from the summary phrasing so the
// relationship filter can still find pre-1.7.0 partners.
function inferArrangerRelationship(text) {
  const t = String(text || '');
  if (/\b(realtor|real estate agent|buyer'?s agent|seller'?s agent)\b/i.test(t)) return 'real_estate_agent';
  if (/\b(lender|loan officer|title company|closing coordinator)\b/i.test(t)) return 'lender';
  if (/\b(property manager|property management)\b/i.test(t)) return 'property_manager';
  return null;
}

// ai_extraction / ai_extraction_enriched are TEXT columns with legacy
// malformed values on old rows — a SQL ::jsonb cast anywhere in the query
// makes ONE bad row throw the whole tool. All JSON parsing happens here,
// per-row, fail-open.
function safeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function phoneKeyExpr(col) {
  return `RIGHT(regexp_replace(COALESCE(${col}, ''), '\\D', '', 'g'), 10)`;
}

async function listCallPartners(input = {}) {
  const daysBack = Math.min(Number(input.days_back) || 180, 730);
  const limit = Math.min(Number(input.limit) || 25, 100);
  const relationship = ARRANGER_RELATIONSHIPS.includes(input.relationship) ? input.relationship : null;

  // Cheap SQL predicates only — no ::jsonb casts (legacy malformed rows would
  // throw the whole query). Arranger detection + JSON parsing happen in JS,
  // so the fetch pages the ENTIRE window in keyset batches — a flat LIMIT
  // before the JS filter would silently drop partners on busy windows.
  const BATCH = 2000;
  const MAX_BATCHES = 10; // 20k calls ≫ any realistic window; log if hit
  const rows = [];
  let cursor = null;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const q = db('call_log')
      .whereRaw("created_at >= now() - (?::int * interval '1 day')", [daysBack])
      .where('direction', 'inbound')
      .modify((qb) => require('../voice-agent/relay-protocol').whereNotSandboxCall(qb))
      .whereRaw(`${phoneKeyExpr('from_phone')} <> ''`)
      // Legacy rows (pre-V2, or a failed V2 run) have NO enriched payload but
      // a usable summary — they must reach the ARRANGER_PHRASE_RE fallback.
      // safeJson fails open on the null enriched.
      .where(function () {
        this.whereNotNull('ai_extraction_enriched').orWhereRaw("COALESCE(call_summary, '') <> ''");
      })
      .select('from_phone', 'created_at', 'call_summary', 'ai_extraction_enriched')
      .orderBy('created_at', 'desc')
      .limit(BATCH);
    if (cursor) q.where('created_at', '<', cursor);
    const batch = await q;
    rows.push(...batch);
    if (batch.length < BATCH) break;
    cursor = batch[batch.length - 1].created_at;
    if (i === MAX_BATCHES - 1) {
      logger.warn(`[intelligence-bar:comms] list_call_partners hit the ${MAX_BATCHES * BATCH}-row scan cap for days_back=${daysBack}; oldest calls not aggregated`);
    }
  }

  const WDO_RE = /\b(wdo|wood[- ]destroying|termite (letter|inspection))\b/i;
  // Pass 1: identify ARRANGER phone keys. A partner is identified by ANY of
  // their calls carrying the signal; pass 2 then aggregates EVERY call from
  // those keys — a follow-up whose individual summary never repeats
  // "realtor" still belongs to the partner's totals.
  const parsed = rows.map((r) => {
    const en = safeJson(r.ai_extraction_enriched) || {};
    return { r, en, key: String(r.from_phone || '').replace(/\D/g, '').slice(-10), summary: String(r.call_summary || '') };
  });
  const arrangerKeys = new Set();
  for (const { en, key, summary } of parsed) {
    const caller = en.caller || {};
    const isArranger = ARRANGER_RELATIONSHIPS.includes(caller.relationship_to_property)
      || !!String(caller.organization_name || '').trim()
      || ARRANGER_PHRASE_RE.test(summary);
    if (isArranger) arrangerKeys.add(key);
  }

  const partners = new Map();
  for (const { r, en, key, summary } of parsed) {
    if (!arrangerKeys.has(key)) continue;
    const caller = en.caller || {};
    const rel = ARRANGER_RELATIONSHIPS.includes(caller.relationship_to_property)
      ? caller.relationship_to_property : null;
    const org = String(caller.organization_name || '').trim() || null;
    let p = partners.get(key);
    if (!p) {
      p = {
        phone: r.from_phone,
        name: null,
        organization: null,
        relationship: null,
        calls: 0,
        wdo_calls: 0,
        first_call: r.created_at,
        last_call: r.created_at,
        latest_summary: summary.slice(0, 200) || null,
      };
      partners.set(key, p);
    }
    p.calls += 1;
    // WDO detection reads the STRUCTURED extraction first, then the prose.
    // Real WDO calls usually persist as category 'termite' with a WDO
    // specific service name — and an arranger's termite call with
    // inspection-only intent IS the real-estate WDO pattern even when
    // neither name nor prose says "WDO".
    const svc = en.service_request || {};
    const category = String(svc.primary_service_category || '');
    const wdoStructured = category === 'wdo'
      || WDO_RE.test(String(svc.specific_service_name || ''))
      || (category === 'termite' && String(svc.service_intent || '') === 'inspection_only');
    if (wdoStructured || WDO_RE.test(summary)) p.wdo_calls += 1;
    // Order-independent bounds (keyset batches preserve DESC, but nothing
    // downstream should depend on it).
    if (r.created_at < p.first_call) p.first_call = r.created_at;
    if (r.created_at > p.last_call) p.last_call = r.created_at;
    // Rows arrive newest-first: keep the first non-null identity fields.
    // name_full may be absent while first/last survive (persisted schema
    // allows it) — an identified partner must not list as unnamed.
    const callerName = caller.name_full
      || [caller.first_name, caller.last_name].filter(Boolean).join(' ')
      || null;
    if (!p.name && callerName) p.name = callerName;
    if (!p.organization && org) p.organization = org;
    if (!p.relationship && rel) p.relationship = rel;
    // Legacy fallback: infer the enum from phrasing so pre-1.7.0 partners
    // survive the relationship filter below.
    if (!p.relationship) p.relationship = inferArrangerRelationship(summary);
  }

  let list = [...partners.values()];
  if (relationship) list = list.filter((p) => p.relationship === relationship);
  list.sort((a, b) => b.calls - a.calls || new Date(b.last_call) - new Date(a.last_call));

  return {
    days_back: daysBack,
    partner_count: list.length,
    partners: list.slice(0, limit),
    note: 'Identity fields come from AI call extractions; pre-1.7.0 history often lacks relationship values (matched by transcript phrasing instead).',
  };
}

async function getPartnerCallHistory(input = {}) {
  const digits = String(input.phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return { error: 'phone must contain at least 10 digits' };
  const limit = Math.min(Number(input.limit) || 20, 100);

  // Both directions: an inbound partner call lands in from_phone, staff
  // calling the partner back lands in to_phone. No ::jsonb casts (legacy
  // malformed rows would throw the whole tool) — JSON parses per-row in JS.
  const rows = await db('call_log')
    .whereRaw(`(${phoneKeyExpr('from_phone')} = ? OR ${phoneKeyExpr('to_phone')} = ?)`, [digits, digits])
    .modify((qb) => require('../voice-agent/relay-protocol').whereNotSandboxCall(qb))
    .select('id', 'created_at', 'direction', 'duration_seconds', 'call_summary', 'disposition', 'ai_extraction', 'ai_extraction_enriched')
    .orderBy('created_at', 'desc')
    .limit(limit);

  const contactLabel = (c) => {
    if (!c || typeof c !== 'object') return null;
    // A party captured with only contact info (the extraction contract allows
    // name OR contact detail) still belongs in the drilldown — label by email
    // or phone when the name is absent.
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ')
      || c.name_full
      || c.email
      || c.phone_e164
      || c.phone
      || null;
    return name ? `${name}${c.role ? ` (${c.role})` : ''}` : null;
  };

  return {
    phone: input.phone,
    call_count: rows.length,
    calls: rows.map((r) => {
      const v1 = safeJson(r.ai_extraction) || {};
      const v2 = safeJson(r.ai_extraction_enriched) || {};
      // Multi-party context from BOTH generations: legacy V1 secondary_contact
      // plus the 1.4.0+ V2 secondary_contacts array — the whole point of the
      // drilldown is who each arranger call was FOR.
      const parties = [];
      const seen = new Set();
      for (const c of [v1.secondary_contact, v2.secondary_contact, ...(Array.isArray(v2.secondary_contacts) ? v2.secondary_contacts : [])]) {
        const label = contactLabel(c);
        if (label && !seen.has(label)) { seen.add(label); parties.push(label); }
      }
      return {
        id: r.id,
        at: r.created_at,
        direction: r.direction,
        duration_seconds: r.duration_seconds,
        summary: String(r.call_summary || '').slice(0, 300) || null,
        // Most specific first: V1 requested_service is often the flattened
        // COARSE category copy, so the V2 specific service name must win.
        requested_service: v2.service_request?.specific_service_name
          || v1.requested_service
          || v2.service_request?.primary_service_category
          || null,
        other_party: parties.length ? parties.join('; ') : null,
        disposition: r.disposition || null,
      };
    }),
  };
}

module.exports = { COMMS_TOOLS, COMMS_READ_TOOLS, executeCommsTool, resolveCustomer };
