/**
 * Waves AI Assistant — Channel-agnostic conversational engine
 *
 * Core design:
 *  - Channel-agnostic: doesn't know if message came from SMS, portal, or WhatsApp
 *  - Tool-use based: Claude decides when to look up data, escalate, or respond
 *  - Escalation-first: schedule changes, cancellations, complaints → escalate to human
 *  - 30-min conversation timeout: context resets after inactivity
 *  - Data-minimized: only authenticated scheduling facts are exposed to the model
 */

const db = require('../../models/db');
const logger = require('../logger');
const { TOOLS, portalToolsFor, executeToolCall, withoutEmails } = require('./tools');
const { renderCompanyFactsSection } = require('../sms-company-facts');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../../constants/business');
const { recordGap } = require('../agent-gap-reports');

// One texting-AI gap report for an escalation its caller marked as the
// assistant not knowing how to help. Fire-and-forget; never throws.
function recordEscalationGap(customerMessage, reason) {
  const summary = (reason && String(reason).trim()) || customerMessage;
  const attempted = customerMessage && customerMessage !== reason ? `Customer text: ${customerMessage}` : 'Escalated to staff';
  recordGap({ source: 'texting-ai', summary, attempted }).catch(() => {});
}

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MODEL = require('../../config/models').FLAGSHIP;
const { anthropicMaxTokens, anthropicEffortConfig } = require('../llm/anthropic-wire');
const { ledgerCall, ledgerCallRejected } = require('../llm-dispatch-metrics');

// Prompt-cache breakpoint (same pattern as admin-intelligence-bar.js). Applied
// to a shallow copy of the messages array at call time — never to the array we
// keep appending to — so markers don't accumulate across tool-use rounds past
// the API's 4-breakpoint limit.
const EPHEMERAL_CACHE = { cache_control: { type: 'ephemeral' } };
const MINIMAL_CONTEXT_VERSION = 2;

function parsedContextSnapshot(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function safeFirstNameFromSnapshot(raw) {
  const snapshot = parsedContextSnapshot(raw);
  if (snapshot?.version !== MINIMAL_CONTEXT_VERSION || typeof snapshot.firstName !== 'string') return '';
  return snapshot.firstName.trim().replace(/[^\p{L}\p{M}' -]/gu, '').slice(0, 80);
}

function withCacheBreakpoint(messages) {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  let content = last.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content, ...EPHEMERAL_CACHE }];
  } else if (Array.isArray(content) && content.length) {
    content = [...content.slice(0, -1), { ...content[content.length - 1], ...EPHEMERAL_CACHE }];
  } else {
    return messages;
  }
  return [...messages.slice(0, -1), { ...last, content }];
}

// Escalation triggers — Phase 1: escalate all sensitive actions
const ESCALATION_TRIGGERS = [
  'cancel', 'cancellation', 'stop service', 'end service', 'discontinue',
  'reschedule', 'change my appointment', 'move my service',
  'complaint', 'not happy', 'terrible', 'worst', 'never coming back', 'lawsuit', 'bbb',
  'refund', 'charge back', 'dispute',
  'manager', 'supervisor', 'owner', 'adam',
];

// Portal chat keeps every trigger except the reschedule ones: the portal can
// hand the customer the visit's own self-serve reschedule page, so a
// reschedule ask goes to the model and its offer_reschedule_link tool. (The
// AI bar's "Reschedule my visit" pill hit this list on every tap.)
const RESCHEDULE_TRIGGERS = ['reschedule', 'change my appointment', 'move my service'];
const PORTAL_ESCALATION_TRIGGERS = ESCALATION_TRIGGERS.filter((t) => !RESCHEDULE_TRIGGERS.includes(t));

const PORTAL_CHAT = 'portal_chat';
// Portal chat with its kill switch on (PORTAL_CHAT_SELF_SERVE, default on).
// Off, portal chat runs exactly as the other channels do.
const portalSelfServe = (channel) => channel === PORTAL_CHAT
  && require('../../config/feature-gates').portalChatSelfServeLive();
// Prompt, tools and the reply extras a channel gets. Portal chat gets its
// own prompt and button tools, plus the payment card under
// GATE_PORTAL_CHAT_FACTS; every other channel (and the portal with its
// switch off) keeps the original pair and no extras.
// The buttons and cards a turn's tools produced, as reply fields (absent
// when there are none). Shared by the normal reply and the hand-off reply.
function laneExtras(lane) {
  return {
    ...(lane.actions?.length ? { actions: lane.actions } : {}),
    ...(lane.cards?.length ? { cards: lane.cards } : {}),
  };
}

// A hand-off's reply with the turn's buttons and cards. A card or button an
// earlier tool in this turn produced still shows under the hand-off reply (a
// charge question shows the card AND hands off the "why"), except a free
// re-service booking button: a turn that hands off is one the team decides.
function handOffReply(escResult, lane) {
  if (lane.actions) lane.actions.splice(0, lane.actions.length, ...lane.actions.filter((a) => !String(a.href || '').startsWith('/reservice/')));
  return { ...escResult, ...laneExtras(lane) };
}
// Tools that end the turn run last, in this order (every other tool first).
const HAND_OFF_ORDER = ['request_email_change', 'escalate'];

// `secondaryProperty`: the portal session is scoped to a non-primary saved
// property (the route decides; anything but false withholds the re-service
// button, which books at the primary address).
function portalLane(channel, { secondaryProperty = true } = {}) {
  if (!portalSelfServe(channel)) return { prompt: SYSTEM_PROMPT, tools: TOOLS, actions: null, cards: null, context: {} };
  const gates = require('../../config/feature-gates');
  // Three independent gates: the payment card, the past-visit facts and the
  // re-service offer.
  const payments = gates.portalChatFactsLive();
  const visits = gates.portalChatVisitFactsLive();
  const reservice = gates.portalChatReserviceLive();
  // The lawn line of the re-service offer: its own gate, on top of the offer's.
  const reserviceLawn = reservice && gates.portalChatReserviceLawnLive();
  // The confirmed email-change hand-off: its own gate.
  const emailChange = gates.portalChatEmailChangeLive();
  return {
    prompt: portalPrompt({ payments, visits, reservice, reserviceLawn, emailChange }),
    tools: portalToolsFor({ payments, visits, reservice, reserviceLawn, emailChange }),
    actions: [],
    cards: payments || visits ? [] : null,
    portal: true,
    // Whether the payment card and re-service tools are in this lane.
    payments,
    reservice,
    emailChange,
    context: { secondaryProperty: secondaryProperty !== false, lawn: reserviceLawn, emailChange },
  };
}

const SYSTEM_PROMPT = `You are the Waves Pest Control AI assistant. You help customers with questions about their pest control and lawn care services in Southwest Florida.

PERSONALITY:
- Friendly, knowledgeable, direct — like a helpful neighbor who knows pest control
- Use the customer's first name naturally
- Keep responses concise for SMS (2-4 sentences max) or longer for portal chat
- Reference SWFL-specific conditions (sandy soil, afternoon storms, St. Augustine grass)
- Never sound robotic or corporate

WHAT YOU CAN DO:
- Answer general questions about services, products, pests, and lawn care
- Look up the authenticated customer's upcoming services
- Provide pest/lawn care advice specific to SWFL
- Escalate account, billing, and service-change questions to the Waves team

WHAT YOU MUST ESCALATE (use the escalate tool):
- Any request to cancel, pause, or downgrade service
- Any request to reschedule or change an appointment
- Complaints about service quality or technician behavior
- Billing disputes or refund requests
- Anything you're uncertain about
- Requests to speak with a manager/owner

SCHEDULING QUESTIONS — HARD RULE:
If the customer asks anything about their schedule, upcoming visit, arrival
window, appointment time, or "when are you coming", you MUST call the
get_upcoming_services tool first before replying. Never assert "we're
booked" or "we don't have you on the schedule" without checking. If the
tool returns at least one upcoming service for this customer, confirm the
soonest one by date + time window. If the tool returns no upcoming
services, escalate — do not guess availability.

Also never state a specific date or month unless it came from a tool
response. If you need to reference "tomorrow" or "this week", phrase it
relative to the current context rather than inventing a specific date.

ESCALATION FORMAT: When escalating, explain to the customer that you're connecting them with the team, and use the escalate tool with a clear summary of the issue.

RULES:
- Never make up service dates, prices, or technician names — always look them up
- Never promise specific times without checking availability
- Do not expose or request addresses, phone numbers, payment details, balances, service notes, or call history
- Do not quote account-specific pricing; escalate billing and pricing questions
- If you detect the customer is frustrated, acknowledge it before solving
- End every conversation with an offer to help with anything else`;

// Portal chat only. The SMS prompt above stays as it is: a text thread has no
// buttons, and its replies go through the SMS send path's own rules.
const PORTAL_SYSTEM_PROMPT = `You are the Waves Pest Control AI assistant inside the customer portal. The customer is signed in. You help with questions about their pest control and lawn care services in Southwest Florida.

PERSONALITY:
- Friendly, knowledgeable, direct, like a helpful neighbor who knows pest control
- Use the customer's first name naturally
- Keep replies short: two to four sentences
- Reference SWFL-specific conditions (sandy soil, afternoon storms, St. Augustine grass)
- Never sound robotic or corporate

WHAT YOU CAN DO:
- Answer general questions about services, products, pests, and lawn care
- Look up the customer's upcoming services
- Show a Reschedule button for a visit (offer_reschedule_link)
- Show a button that opens a page of the portal (open_portal_section)
- Hand the conversation to the Waves team (escalate)

You cannot see charges, balances, cards, plan details, past visits, or documents. Never guess at them. The portal pages hold them, so show the page.

RESCHEDULING:
For any request to reschedule, move, postpone, or bring forward a visit, call offer_reschedule_link. If it returns a button, tell the customer to tap it to see the open times. Never state or promise a new time yourself. If it returns no button, escalate.

SCHEDULING QUESTIONS:
If the customer asks about their schedule, upcoming visit, arrival window, or "when are you coming", call get_upcoming_services before replying. Confirm the soonest visit by date and time window. If there is none, escalate. Never state a date or month that did not come from a tool.

BILLING, PLAN, REPORTS, PAPERWORK, REFERRALS:
Call open_portal_section for the matching page and say in one sentence what the customer will find there. For a charge: the Billing page lists every payment with its receipt, plus saved cards and Auto Pay. Say plainly that you cannot see the amounts yourself, and offer to pass a question about a specific charge to the team. Escalate when the customer says the page did not answer it, disputes a charge, or asks for a refund.

WHAT YOU MUST ESCALATE (use the escalate tool):
- Any request to cancel, pause, or downgrade service
- A visit that cannot be moved online
- Complaints about service quality or technician behavior
- Billing disputes or refund requests
- Changes to the account: email, phone, address, gate code, pets, adding a service
- Requests to speak with a manager or the owner
- Anything you are uncertain about

RULES:
- Never make up service dates, prices, or technician names
- Never write a web address or link yourself; buttons come only from the tools
- Do not quote account-specific pricing
- If the customer is frustrated, acknowledge it before solving
- End with an offer to help with anything else`;

// What the customer is told at a hand-off. Portal chat says the team was told
// only when the bell exists; other channels keep the original wording (an SMS
// hand-off reply is never sent).
function escalationReply({ isPortal, teamNotified, firstName, newEmail }) {
  if (!isPortal) {
    return firstName
      ? `Thanks ${firstName} — I'm connecting you with our team right now. Someone will follow up shortly. Is there anything else you'd like me to note for them?`
      : "Thanks for reaching out — I'm connecting you with our team right now. Someone will follow up with you shortly.";
  }
  const thanks = firstName ? `Thanks ${firstName}` : 'Thanks for reaching out';
  // A confirmed email change: the team makes the change, the chat never does.
  if (newEmail) {
    return teamNotified
      ? `${thanks}. I've sent your new email address, ${newEmail}, to our team. They'll update your account and reply by text or email, usually within one business hour between 8 AM and 8 PM. Until then our emails go to the address on file. Is there anything else you'd like me to pass along?`
      : `${thanks}. I've saved your email change request for our team. If it can't wait, please call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`;
  }
  return teamNotified
    ? `${thanks}. I've sent this to our team, and they'll reply by text or email, usually within one business hour between 8 AM and 8 PM. Is there anything else you'd like me to pass along?`
    : `${thanks}. I've saved your request for our team. If it can't wait, please call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`;
}

// How the office bell words a hand-off topic (tools.js ESCALATION_TOPICS).
// The topic comes from the model's escalate call, or from the keyword group
// that forced the hand-off — never from classifyEscalation, whose broad
// "change"/"charge" matches would call an email change a schedule change.
// GATE_PORTAL_CHAT_FACTS: the portal prompt with the billing section replaced
// by the payment card. Built from PORTAL_SYSTEM_PROMPT so the two can never
// drift apart anywhere else.
const PORTAL_BILLING_SECTION = PORTAL_SYSTEM_PROMPT.slice(
  PORTAL_SYSTEM_PROMPT.indexOf('BILLING, PLAN, REPORTS, PAPERWORK, REFERRALS:'),
  PORTAL_SYSTEM_PROMPT.indexOf('WHAT YOU MUST ESCALATE'),
);
const PORTAL_FACTS_PROMPT = PORTAL_SYSTEM_PROMPT
  .replace('- Show a button that opens a page of the portal (open_portal_section)\n', '- Show a button that opens a page of the portal (open_portal_section)\n- Show a card of the customer\'s recent payments (show_recent_payments)\n')
  .replace('You cannot see charges, balances, cards, plan details, past visits, or documents.', 'You cannot see balances, cards, plan details, past visits, or documents. For payments you can show a card, but you are never given the figures on it.')
  .replace(PORTAL_BILLING_SECTION, `CHARGES AND PAYMENTS:
For any question about a charge, a payment, a receipt, or whether a payment went through, call show_recent_payments. Tell the customer the card below lists their recent payments with receipts, and use the status you are given to say whether the latest one went through. Never state an amount, date or description yourself; they are on the card. If the customer asks why a charge is what it is, says a charge is wrong, or asks for a refund, use the escalate tool.

PLAN, REPORTS, PAPERWORK, REFERRALS:
Call open_portal_section for the matching page and say in one sentence what the customer will find there.

`);

// The visit-facts escalation sentence, which the re-service prompt narrows.
const VISIT_PROBLEM_ESCALATION = 'If the customer reports a problem since the visit or says something was missed, escalate.';

// GATE_PORTAL_CHAT_VISIT_FACTS on top of either portal prompt: the past-visit
// tool, and the owner-approved company facts (services/sms-company-facts.js,
// the texting AI's own block, unedited).
function withVisitFacts(prompt) {
  return prompt
    .replace('- Hand the conversation to the Waves team (escalate)', '- Look up the customer\'s recent completed visits (get_recent_visits)\n- Hand the conversation to the Waves team (escalate)')
    .replace('plan details, past visits, or documents', 'plan details, or documents')
    .replace('WHAT YOU MUST ESCALATE (use the escalate tool):', `PAST VISITS:
For a question about what was done at a visit, when the last visit was, or where a service report is, call get_recent_visits. Answer from what it returns (the date, the service, the technician's first name, the kinds of product applied) and point the customer to the card it shows for the reviewed summary and the report link. You are not given the summary text. Do not add a finding, product or date it did not return, and never name a product brand. ${VISIT_PROBLEM_ESCALATION}

${renderCompanyFactsSection()}
WHAT YOU MUST ESCALATE (use the escalate tool):`);
}

// The pest-only prompt's lawn sentence, which the lawn gate replaces.
const RESERVICE_LAWN_ESCALATION = 'A lawn problem (weeds, brown or thin grass) is not this tool\'s: escalate it with topic pest_problem.';

// GATE_PORTAL_CHAT_RESERVICE on top of any portal prompt: pests back between
// visits go to offer_reservice, which alone decides whether a visit is free.
function withReservice(prompt) {
  return prompt
    // The one plan fact this lane is given: whether offer_reservice found a
    // free re-service covered.
    .replace('plan details', 'plan details (apart from what offer_reservice tells you)')
    .replace(VISIT_PROBLEM_ESCALATION, 'If the customer says something was missed at the visit, or reports damage, escalate. Pests back since the visit follow PESTS BACK BETWEEN VISITS below.')
    .replace('- Hand the conversation to the Waves team (escalate)', '- Offer a free re-service when pests come back between visits (offer_reservice)\n- Hand the conversation to the Waves team (escalate)')
    .replace('WHAT YOU MUST ESCALATE (use the escalate tool):', `PESTS BACK BETWEEN VISITS:
When the customer reports household pests back or still there between scheduled visits, call offer_reservice in that same turn, with service line pest, and follow its instruction. It reads the customer's message from that turn only. Offer a free visit ONLY when it says the plan covers one and a button is shown. If the same message is a complaint about the service or the technician, or reports damage, escalate instead. ${RESERVICE_LAWN_ESCALATION}

WHAT YOU MUST ESCALATE (use the escalate tool):`);
}

// GATE_PORTAL_CHAT_RESERVICE_LAWN on top of the re-service prompt: a lawn
// problem happening now goes to offer_reservice too. The model judges that
// and quotes the customer; the server verifies the quote (owner ruling
// 2026-10-03).
function withReserviceLawn(prompt) {
  return prompt
    .replace('- Offer a free re-service when pests come back between visits (offer_reservice)', '- Offer a free re-service when pests or a lawn problem come back between visits (offer_reservice)')
    .replace(RESERVICE_LAWN_ESCALATION, `For a lawn problem (weeds, turf insects, brown, thin or dying grass) the customer says is happening now, call offer_reservice in that same turn with service line lawn, current_problem true, and customer_quote set to their exact words about it from this message, copied word for word. A question about lawn care, a what-if, a past problem or one they say is fixed is NOT a current problem: answer it and do not call the tool with current_problem true.`);
}

// GATE_PORTAL_CHAT_EMAIL_CHANGE on top of any portal prompt: an email change
// is read back, confirmed, then sent to the team by request_email_change
// (owner ruling 2026-10-02: staff make the change).
function withEmailChange(prompt) {
  return prompt
    .replace('- Hand the conversation to the Waves team (escalate)', '- Send a confirmed email change to the Waves team (request_email_change)\n- Hand the conversation to the Waves team (escalate)')
    .replace('- Changes to the account: email, phone, address, gate code, pets, adding a service', '- Changes to the account: phone, address, gate code, pets, adding a service')
    .replace('WHAT YOU MUST ESCALATE (use the escalate tool):', `EMAIL CHANGE:
When the customer asks to change the email on their account, you cannot change it; the team does. If they have not typed the new address, ask for it. Then call request_email_change with the address exactly as they typed it and customer_confirmed false, and read the address back as it tells you. Only when the customer's next message confirms that address, call request_email_change again with customer_confirmed true: that sends it to the team. If they correct the address, start again with the corrected one. Never say the email has been changed, and never state or guess the email currently on the account.

WHAT YOU MUST ESCALATE (use the escalate tool):`);
}

// Every portal prompt, built once per gate combination: the text sent to the
// model for a combination never varies between requests (it carries the
// cache breakpoint).
const PORTAL_PROMPTS = new Map();
function portalPrompt({ payments, visits, reservice, reserviceLawn, emailChange }) {
  const key = `${payments ? 'payments' : 'base'}${visits ? '+visits' : ''}${reservice ? '+reservice' : ''}${reserviceLawn ? '+lawn' : ''}${emailChange ? '+email' : ''}`;
  if (!PORTAL_PROMPTS.has(key)) {
    let prompt = payments ? PORTAL_FACTS_PROMPT : PORTAL_SYSTEM_PROMPT;
    if (visits) prompt = withVisitFacts(prompt);
    if (reservice) prompt = withReservice(prompt);
    if (reserviceLawn) prompt = withReserviceLawn(prompt);
    if (emailChange) prompt = withEmailChange(prompt);
    PORTAL_PROMPTS.set(key, prompt);
  }
  return PORTAL_PROMPTS.get(key);
}

// What the durable hand-off row says. A confirmed email change keeps both
// addresses on it, so the request survives a bell that did not ring. They
// are not put in `reason`, which is logged.
function escalationSummary(reason, customer, newEmail) {
  if (!newEmail) return reason;
  return `${reason}. Email on file: ${String(customer?.email || '').trim() || 'none'}. New email: ${newEmail}`;
}

const TOPIC_WORDING = {
  cancellation: 'a cancellation',
  schedule_change: 'a schedule change',
  billing: 'a billing question',
  complaint: 'a complaint',
  account_change: 'an account change',
  add_service: 'adding a service',
  pest_problem: 'pests or a lawn problem back between visits',
  manager: 'reaching a manager',
};
const TRIGGER_TOPICS = [
  ['cancellation', ['cancel', 'cancellation', 'stop service', 'end service', 'discontinue']],
  ['schedule_change', RESCHEDULE_TRIGGERS],
  ['complaint', ['complaint', 'not happy', 'terrible', 'worst', 'never coming back', 'lawsuit', 'bbb']],
  ['billing', ['refund', 'charge back', 'dispute']],
  ['manager', ['manager', 'supervisor', 'owner', 'adam']],
];
const topicOfTrigger = (trigger) => TRIGGER_TOPICS.find(([, words]) => words.includes(trigger))?.[0];

class WavesAssistant {

  /**
   * Process an incoming message from any channel.
   * Returns { reply, conversationId, escalated, escalationId }
   */
  async processMessage({ message, channel, channelIdentifier, customerId, customerPhone, secondaryProperty }) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      logger.warn('[ai-assistant] ANTHROPIC_API_KEY not configured');
      return { reply: "Thanks for reaching out! One of our team members will get back to you shortly. — Waves Pest Control", escalated: false };
    }

    // 1. Find or create conversation (respecting 30-min timeout)
    let conversation;
    try {
      conversation = await this.getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone);
    } catch (convErr) {
      logger.error(`[ai-assistant] getOrCreateConversation failed: ${convErr.message}`, { stack: convErr.stack });
      return { reply: "I'm having a brief connection issue. Please try again in a moment, or call us at (941) 318-7612.", escalated: false };
    }

    // 2. Check for escalation triggers in the raw message
    // Portal chat gets its own prompt and button tools; every other channel
    // (and the portal with its switch off) keeps the original pair.
    const lane = portalLane(channel, { secondaryProperty });
    const trigger = this.matchedEscalationTrigger(message, channel);

    // 3. Save the user message
    try {
      await db('agent_messages').insert({
        conversation_id: conversation.id,
        role: 'user',
        content: message,
        channel,
      });
      await db('agent_sessions').where('id', conversation.id).update({
        message_count: (conversation.message_count || 0) + 1,
        last_activity_at: new Date(),
        timeout_at: new Date(Date.now() + CONVERSATION_TIMEOUT_MS),
      });
    } catch (msgErr) {
      logger.error(`[ai-assistant] Failed to save user message: ${msgErr.message}`);
    }

    // 4. If escalation trigger detected, escalate immediately
    if (trigger) {
      const topic = topicOfTrigger(trigger);
      // A billing keyword ("refund", "dispute") hands off, but under the facts
      // lane the customer still gets the payment card and Open Billing
      // button under the hand-off reply, as a model-led hand-off would give.
      if (topic === 'billing' && lane.payments) {
        await executeToolCall('show_recent_payments', {}, customerId, lane.actions, lane.cards);
      }
      const escResult = await this.escalate(conversation, message, 'Sensitive topic detected in customer message', { topic });
      return { ...escResult, ...laneExtras(lane) };
    }

    // 5. Build conversation history for Claude
    // Portal chat reads the newest messages; other channels keep the original
    // oldest-first read.
    const history = await this.buildHistory(conversation.id, { newest: lane.portal === true });
    // The customer's own words this turn, which the re-service tool
    // classifies (the model's reading of them never decides what is covered).
    // Only this message counts: an earlier report is never carried forward
    // past a later "they're gone now".
    if (lane.reservice || lane.emailChange) lane.context.customerMessage = message;
    // The chat whose messages the email-change check reads.
    if (lane.emailChange) lane.context.conversationId = conversation.id;

    // 6. Build a data-minimized context string. Older active rows may still
    // contain the legacy full-account summary; never forward that shape to the
    // model during the rollout window.
    let contextStr = '';
    if (conversation.context_snapshot) {
      const firstName = safeFirstNameFromSnapshot(conversation.context_snapshot);
      if (firstName) contextStr = `Customer first name: ${firstName}`;
    }

    // 7. Call Claude with tools
    try {
      return await this.answerWithTools({ conversation, message, history, contextStr, lane, customerId, channel });
    } catch (err) {
      logger.error(`[ai-assistant] processMessage failed: ${err.message}`, { stack: err.stack, model: MODEL, customerId, channel });
      // A card or button a tool already built this turn still shows under
      // the fallback text.
      return { reply: "I'm having trouble right now. Please try calling us at (941) 318-7612.", escalated: false, ...laneExtras(lane) };
    }
  }

  /**
   * One model turn: the tool-use loop for a saved customer message. Runs the
   * lane's prompt and tools, executes tool calls (an escalate call ends the
   * turn with the hand-off reply), saves and returns the reply. Throws on a
   * provider failure; processMessage owns the fallback reply.
   */
  async answerWithTools({ conversation, message, history, contextStr, lane, customerId, channel }) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let messages = history;
    let finalReply = '';
    let escalated = false;
    let escalationId = null;

    // Two system blocks: the static prompt carries a 1-hour cache breakpoint
    // (tools render before system, so the entry covers TOOLS + SYSTEM_PROMPT
    // and is shared across every customer and conversation); the
    // per-conversation context block sits AFTER the breakpoint so it never
    // fragments that shared entry. 1h TTL because customer replies routinely
    // arrive more than 5 minutes apart.
    const system = [
      { type: 'text', text: lane.prompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ];
    if (contextStr) {
      system.push({ type: 'text', text: `CUSTOMER CONTEXT:\n${contextStr}` });
    }

    // Tool-use loop — Claude may call multiple tools before responding
    let lastResponse = null;
    let loopExhausted = true;
    for (let turn = 0; turn < 5; turn++) {
      const response = await ledgerCall('anthropic', MODEL, () => anthropic.messages.create({
        model: MODEL,
        ...anthropicEffortConfig(MODEL),
        max_tokens: anthropicMaxTokens(MODEL, 800),
        system,
        tools: lane.tools,
        messages: withCacheBreakpoint(messages),
      }), { laneId: 'portal_assistant' });

      // Cache-hit visibility: cache_read > 0 on later rounds / follow-up
      // customer turns is the prod verification signal.
      const u = response.usage || {};
      logger.info(
        `[ai-assistant] usage turn=${turn} in=${u.input_tokens ?? 0} ` +
        `cache_write=${u.cache_creation_input_tokens ?? 0} ` +
        `cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens ?? 0}`
      );

      // Check if Claude wants to use tools
      const toolUses = response.content.filter(c => c.type === 'tool_use');
      const textBlocks = response.content.filter(c => c.type === 'text');

      if (toolUses.length === 0) {
        // No tools — just a text response
        finalReply = textBlocks.map(t => t.text).join('');
        // A terminal turn with neither a tool call nor usable text (a
        // thinking-only or refused reply) is this exact call answering
        // nothing — the loop-exhausted guard below still catches it and
        // serves the canned reply, but that guard cannot tell this leg's
        // own row apart from one where every earlier turn correctly used
        // a tool; flag it here on the response that actually produced it.
        if (!finalReply.trim()) ledgerCallRejected(response, 'invalid_output');
        loopExhausted = false;
        break;
      }
      lastResponse = response;

      // Execute tool calls
      const toolResults = [];
      // Every other tool in this response runs before a hand-off, so a card
      // or button the model asked for in the same breath is on the hand-off
      // reply whatever order the blocks came in.
      // A confirmed email change is a hand-off too, and it goes before a
      // plain escalate so the turn rings one bell, the one with the address.
      const ordered = [...toolUses].sort((a, b) => HAND_OFF_ORDER.indexOf(a.name) - HAND_OFF_ORDER.indexOf(b.name));
      for (const toolUse of ordered) {
        // Check if it's an escalation
        if (toolUse.name === 'escalate') {
          const escResult = await this.escalate(conversation, message, toolUse.input.reason || 'AI-initiated escalation',
            { gap: toolUse.input.not_supported === true, topic: toolUse.input.topic });
          return handOffReply(escResult, lane);
        }

        const result = await executeToolCall(toolUse.name, toolUse.input, customerId, lane.actions, lane.cards, lane.context);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });

        // Log tool usage
        await db('agent_messages').insert({
          conversation_id: conversation.id,
          role: 'tool_use',
          content: toolUse.name,
          tool_calls: JSON.stringify(toolUse.input),
          tool_results: JSON.stringify(result),
        }).catch(e => logger.error(`[ai-assistant] Failed to log tool use: ${e.message}`));

        // The email-change check passed: the confirmed address goes to the
        // team, and the turn ends with the hand-off reply.
        if (toolUse.name === 'request_email_change' && result.confirmed_email) {
          const escResult = await this.escalate(conversation, message, 'Customer confirmed a new email address in portal chat',
            { topic: 'account_change', newEmail: result.confirmed_email });
          return handOffReply(escResult, lane);
        }
      }

      // Continue the loop with tool results
      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    // If every loop turn was tool_use (e.g. a tool kept erroring and the
    // model kept retrying it), finalReply is still empty — degrade to the
    // canned reply instead of persisting a blank customer-visible message.
    if (!finalReply.trim()) {
      // Every turn was a (valid-looking) tool_use round, so no row was
      // failed above; the call that ended the loop without a reply is the
      // one that answered nothing (Codex r12 on #4884).
      if (loopExhausted && lastResponse) ledgerCallRejected(lastResponse, 'tool_loop_exhausted');
      logger.warn(`[ai-assistant] Tool-use loop exhausted with no text reply`, { customerId, channel, conversationId: conversation.id });
      return { reply: "I'm having trouble right now. Please try calling us at (941) 318-7612.", conversationId: conversation.id, escalated: false, ...laneExtras(lane) };
    }

    // Save the assistant reply
    await db('agent_messages').insert({
      conversation_id: conversation.id,
      role: 'assistant',
      content: finalReply,
      channel,
      sent_to_customer: true,
    }).catch(e => logger.error(`[ai-assistant] Failed to save reply: ${e.message}`));

    // generated marks true model output — canned fallbacks and the
    // deterministic escalation template never carry it, so the portal's
    // "report AI content" affordance only attaches to real AI replies.
    return {
      reply: finalReply, conversationId: conversation.id, escalated, escalationId, generated: true,
      // Buttons the portal tools asked for, shown under the reply.
      ...laneExtras(lane),
    };

  }

  /**
   * Get or create an active conversation. Timeout after 30 min of inactivity.
   */
  async getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone) {
    const now = new Date();
    const identifier = channelIdentifier || customerPhone;

    if (!channel || !identifier) {
      throw new Error('Conversation channel and identifier are required');
    }

    // Client session IDs and phone identifiers are not authorization. Scope
    // every lookup by channel AND the already-resolved customer identity (or
    // explicitly to an anonymous lead) so a guessed identifier can never
    // attach another customer's message history.
    const existingQuery = db('agent_sessions')
      .where({ channel, channel_identifier: identifier, status: 'active' });
    if (customerId) existingQuery.where({ customer_id: customerId });
    else existingQuery.whereNull('customer_id');
    const existing = await existingQuery
      .where('timeout_at', '>', now)
      .orderBy('last_activity_at', 'desc')
      .first();

    // Do not carry legacy full-context snapshots/history across this security
    // boundary. Those conversations may contain model replies grounded in
    // billing, call-summary, contact, or service-note data. Anonymous lead
    // sessions had no customer snapshot and remain safe to reuse.
    if (existing && (!existing.customer_id
      || parsedContextSnapshot(existing.context_snapshot)?.version === MINIMAL_CONTEXT_VERSION)) {
      return existing;
    }

    // Timeout any stale conversations for this identifier
    const staleQuery = db('agent_sessions')
      .where({ channel, channel_identifier: identifier, status: 'active' });
    if (customerId) staleQuery.where({ customer_id: customerId });
    else staleQuery.whereNull('customer_id');
    await staleQuery
      .update({ status: 'timeout', resolved_by: 'timeout', updated_at: now });

    // Keep model context deliberately small. The legacy full-context
    // aggregator included payment history, property flags, SMS/call summaries,
    // service notes and contact details. The model only needs a first name for
    // natural phrasing; schedule facts come through the scoped tool above.
    let contextSnapshot = null;
    try {
      if (customerId) {
        const customer = await db('customers')
          .where({ id: customerId })
          .select('first_name')
          .first();
        if (customer?.first_name) {
          contextSnapshot = { version: MINIMAL_CONTEXT_VERSION, firstName: customer.first_name };
        } else {
          contextSnapshot = { version: MINIMAL_CONTEXT_VERSION };
        }
      }
    } catch (ctxErr) {
      logger.warn(`[ai-assistant] Minimal context lookup failed (non-blocking): ${ctxErr.message}`);
    }

    // Create new conversation — pass plain object for jsonb column (Knex serializes it)
    const [conv] = await db('agent_sessions').insert({
      customer_id: customerId || null,
      channel,
      channel_identifier: identifier,
      status: 'active',
      last_activity_at: now,
      timeout_at: new Date(now.getTime() + CONVERSATION_TIMEOUT_MS),
      message_count: 0,
      context_snapshot: contextSnapshot,
    }).returning('*');

    return conv;
  }

  /**
   * Build Claude message history from conversation.
   */
  // The last 20 messages. `newest`: read newest-first and put back in order,
  // so a long chat still reaches its latest turn (portal chat). Without it,
  // the original read: the first 20, which never reaches the latest turn once
  // a chat passes 20 (SMS keeps it unchanged).
  async buildHistory(conversationId, { newest = false } = {}) {
    const msgs = await db('agent_messages')
      .where('conversation_id', conversationId)
      .whereIn('role', ['user', 'assistant'])
      .orderBy([{ column: 'created_at', order: newest ? 'desc' : 'asc' }, ...(newest ? [{ column: 'id', order: 'desc' }] : [])])
      .limit(20);
    const ordered = newest ? msgs.reverse() : msgs;
    // The model's input must open with a customer turn: a newest-20 window
    // can start on an assistant row, which is dropped.
    while (newest && ordered.length && ordered[0].role !== 'user') ordered.shift();

    return ordered.map(m => ({ role: m.role, content: m.content }));
  }

  /**
   * Check if message contains escalation trigger keywords.
   */
  checkEscalationTriggers(message, channel) {
    return Boolean(this.matchedEscalationTrigger(message, channel));
  }

  matchedEscalationTrigger(message, channel) {
    const portal = portalSelfServe(channel);
    let lower = (message || '').toLowerCase();
    // Under the email-change lane an address the customer types is not their
    // words: "homeowner@…" or "adam@…" must not read as asking for the owner.
    // Only the address itself is left out, never the words around it.
    if (portal && require('../../config/feature-gates').portalChatEmailChangeLive()) lower = withoutEmails(lower);
    const triggers = portal ? PORTAL_ESCALATION_TRIGGERS : ESCALATION_TRIGGERS;
    return triggers.find(trigger => lower.includes(trigger)) || null;
  }

  /**
   * Escalate to human — create escalation record, update conversation, notify Adam.
   */
  async escalate(conversation, customerMessage, reason, { gap = false, topic, newEmail } = {}) {
    const customer = conversation.customer_id
      ? await db('customers').where('id', conversation.customer_id).first()
      : null;

    // Determine priority
    const lower = (customerMessage || '').toLowerCase();
    let priority = 'normal';
    if (lower.includes('cancel') || lower.includes('lawsuit') || lower.includes('bbb')) priority = 'urgent';
    if (lower.includes('complaint') || lower.includes('not happy') || lower.includes('refund')) priority = 'urgent';

    const [escalation] = await db('ai_escalations').insert({
      conversation_id: conversation.id,
      customer_id: conversation.customer_id,
      reason: this.classifyEscalation(customerMessage),
      summary: escalationSummary(reason, customer, newEmail),
      customer_message: customerMessage,
      ai_draft_response: null,
      priority,
      status: 'pending',
    }).returning('*');

    // Gap reports (server/services/agent-gap-reports.js): the caller says
    // whether this escalation is the assistant not knowing how to help
    // (`gap`), since classifyEscalation's keyword buckets can't tell a
    // missing feature from a staff workflow. Fire-and-forget — a failed write
    // must never affect the escalation reply.
    if (gap) recordEscalationGap(customerMessage, reason);

    // The ai_escalations row above is the source of truth. Once it exists,
    // the customer must get the escalation reply — session bookkeeping and
    // transcript logging are best-effort (a failed UPDATE here once surfaced
    // as the generic error fallback mid-escalation).
    await db('agent_sessions').where('id', conversation.id).update({
      escalated: true,
      escalation_reason: reason,
      status: 'escalated',
      updated_at: new Date(),
    }).catch(e => logger.error(`[ai-assistant] Failed to mark session escalated: ${e.message}`, { conversationId: conversation.id }));

    // Portal chat: ring the office, then tell the customer only what really
    // happened. Before this the hand-off was a queue row nobody was shown,
    // while the reply said a team member had been notified. (A text already
    // rings the office as an inbound SMS, and its escalation reply is never
    // sent, so SMS keeps its wording.)
    const isPortal = portalSelfServe(conversation.channel);
    const teamNotified = isPortal
      && await this.notifyTeamOfEscalation({ escalation, topic, conversation, customer, customerMessage, newEmail });

    const reply = escalationReply({ isPortal, teamNotified, firstName: String(customer?.first_name || '').trim(), newEmail });

    await db('agent_messages').insert({
      conversation_id: conversation.id,
      role: 'assistant',
      content: reply,
      channel: conversation.channel,
      sent_to_customer: true,
    }).catch(e => logger.error(`[ai-assistant] Failed to save escalation reply: ${e.message}`, { conversationId: conversation.id }));

    // Notify Adam via SMS for urgent escalations
    if (priority === 'urgent') {
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `🚨 AI Escalation (${priority})\n${customer ? customer.first_name + ' ' + customer.last_name : 'Unknown'}\nReason: ${reason}\nMsg: "${(customerMessage || '').substring(0, 100)}"`,
            { messageType: 'internal_alert' }
          );
        }
      } catch { /* SMS notification is best-effort */ }
    }

    logger.info(`AI escalated: ${conversation.id} reason="${reason}" priority=${priority}`);

    return {
      reply, conversationId: conversation.id, escalated: true, escalationId: escalation.id,
      ...(isPortal ? { teamNotified } : {}),
    };
  }

  /**
   * Ring the admin bell for a portal-chat hand-off. Returns true only when a
   * notification row exists (new or already standing for this escalation).
   * Never throws: the ai_escalations row is the record, the bell is delivery.
   */
  async notifyTeamOfEscalation({ escalation, topic, conversation, customer, customerMessage, newEmail }) {
    if (!customer?.id) return false;
    try {
      const { raiseAdminAlert, cutAtWord } = require('../admin-alert-compose');
      const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'A customer';
      // A confirmed email change is its own bell: what to do, with both
      // addresses in the full text (an address can break the headline rules).
      const wording = newEmail
        ? { area: 'Customers', action: require('../admin-alert-names').fitAction('Customers', name, [(who) => `Change ${who}'s email`]), why: `${name} confirmed a new email address in portal chat`, doneWhen: 'email_changed' }
        : { area: 'Comms', action: 'Reply to a portal chat request', why: `${name} asked the portal assistant about ${TOPIC_WORDING[topic] || 'a request it could not handle'}`, doneWhen: 'customer_answered' };
      const result = await raiseAdminAlert('alert', {
        area: wording.area,
        action: wording.action,
        why: cutAtWord(wording.why, 110),
        severity: 'needs-you',
        // The customer record, not a message thread: a portal customer may
        // have no texts yet, or only a thread on an old number.
        link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
        subject: { type: 'customer', id: String(customer.id) },
        doneWhen: wording.doneWhen,
        who: 'person',
      }, {
        bell: true,
        dedupeKey: `portal-chat-escalation:${escalation.id}`,
        // The customer's own words in full (the chat route caps a message at
        // 4000 characters), read from the bell's "Show full text".
        detail: newEmail
          ? `Email on file: ${String(customer.email || '').trim() || 'none'}\nNew email, confirmed by the customer in portal chat: ${newEmail}\n\nCustomer's message: ${String(customerMessage || '')}`
          : String(customerMessage || ''),
        metadata: { customerId: customer.id, escalationId: escalation.id, conversationId: conversation.id },
      });
      // notifyAdmin returns the stored row flattened ({ id, …, deduped }),
      // { id: null, suppressed: true } when the bell was withheld (a demo
      // account), and null when the write failed.
      return Boolean(result?.id) && !result.suppressed;
    } catch (err) {
      logger.error(`[ai-assistant] escalation bell failed: ${err.message}`, { conversationId: conversation.id });
      return false;
    }
  }

  classifyEscalation(message) {
    const lower = (message || '').toLowerCase();
    if (lower.includes('cancel') || lower.includes('stop service') || lower.includes('end service')) return 'cancellation';
    if (lower.includes('reschedule') || lower.includes('change') || lower.includes('move')) return 'schedule_change';
    if (lower.includes('complaint') || lower.includes('not happy') || lower.includes('terrible')) return 'complaint';
    if (lower.includes('refund') || lower.includes('charge') || lower.includes('dispute')) return 'billing_dispute';
    if (lower.includes('manager') || lower.includes('supervisor') || lower.includes('owner')) return 'manager_request';
    return 'ai_uncertain';
  }

  /**
   * Transcribe a call recording using Claude (for when Twilio transcription isn't available).
   */
  async transcribeRecording(callSid, recordingUrl) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY || !recordingUrl) return;

    // For now, mark as pending — actual audio transcription requires Whisper or Twilio
    // This is a placeholder that updates status; real implementation would use
    // Twilio's built-in transcription (already configured in the voice webhook)
    // or OpenAI Whisper API for higher quality
    await db('call_log').where('twilio_call_sid', callSid).update({
      transcription_status: 'pending',
      updated_at: new Date(),
    });

    logger.info(`Transcription queued for call ${callSid}`);
  }
}

module.exports = new WavesAssistant();
