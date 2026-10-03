/**
 * Waves AI Assistant — Claude Tool Definitions
 *
 * Claude decides when to call these based on the conversation.
 * No rigid decision trees — the model picks the right tool naturally.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { arrivalWindowRange } = require('../../utils/sms-time-format');
const { RESCHEDULABLE_STATUSES } = require('../reschedule-eligibility');
const { listPortalPayments } = require('../portal-payment-history');
const { listPortalServiceHistory } = require('../portal-service-history');

// Tool definitions in Anthropic format
const TOOLS = [
  {
    name: 'get_upcoming_services',
    description: 'Get the authenticated customer\'s next scheduled services. Shows dates, service types, and arrival windows.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_pest_advice',
    description: 'Get SWFL-specific pest or lawn care advice from the knowledge base. Ask about any pest, treatment, or lawn issue.',
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'The pest, lawn issue, or treatment to look up' } },
      required: ['topic'],
    },
  },
  {
    name: 'escalate',
    description: 'Escalate the conversation to a human team member. Use for: cancellations, schedule changes, complaints, billing disputes, or anything uncertain.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this needs human attention' },
        priority: { type: 'string', enum: ['urgent', 'normal', 'low'] },
        // Gap reports only (services/agent-gap-reports.js) — never shown to the customer.
        not_supported: { type: 'boolean', description: 'true ONLY when the customer asked for something you have no way to do or answer. Leave it out for cancellations, schedule changes, complaints, billing, pricing, or anything the team handles by design.' },
      },
      required: ['reason'],
    },
  },
];

// Portal chat only. The portal can show the customer a button, so these two
// tools hand the customer a working path instead of a hand-off: the visit's
// own self-serve reschedule page, or the portal page that holds the answer.
// The model never writes a link — every button's label and target is built
// here from the authenticated customer's rows.
const PORTAL_SECTIONS = {
  billing: { tab: 'billing', label: 'Open Billing' },
  upcoming_visits: { tab: 'schedule', label: 'Open upcoming visits' },
  service_reports: { tab: 'services', label: 'Open completed visits and reports' },
  plan: { tab: 'plan', label: 'Open My Plan' },
  documents: { tab: 'documents', label: 'Open Documents' },
  referrals: { tab: 'refer', label: 'Open Refer' },
};
// Reschedule buttons shown at once, and (RESCHEDULE_PAGE) the page size of
// the upcoming-visit read that finds them.
const MAX_RESCHEDULE_BUTTONS = 3;
const RESCHEDULE_PAGE = 12;
// What a portal hand-off is about, named by the model (or by the keyword that
// forced the hand-off) and worded for the office in assistant.js.
const ESCALATION_TOPICS = ['cancellation', 'schedule_change', 'billing', 'complaint', 'account_change', 'add_service', 'pest_problem', 'manager', 'other'];

const PORTAL_TOOLS = [
  TOOLS[0],
  TOOLS[1],
  {
    name: 'offer_reschedule_link',
    description: 'Show the customer a Reschedule button for each of their upcoming visits that can be moved online. The button opens the self-serve page with the real open times. Use for any request to reschedule, move, postpone, or bring forward a visit.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'open_portal_section',
    description: 'Show the customer a button that opens a page of their portal. billing: every payment with its receipt, saved cards, Auto Pay. upcoming_visits: scheduled visits. service_reports: completed visits and their reports. plan: what their plan includes. documents: agreements and paperwork. referrals: referral code and rewards.',
    input_schema: {
      type: 'object',
      properties: { section: { type: 'string', enum: Object.keys(PORTAL_SECTIONS) } },
      required: ['section'],
      additionalProperties: false,
    },
  },
  {
    ...TOOLS[2],
    description: 'Hand the conversation to a human team member. Use for: cancellations, complaints, billing disputes, a visit that cannot be moved online, account changes, or anything uncertain.',
    input_schema: {
      ...TOOLS[2].input_schema,
      properties: {
        ...TOOLS[2].input_schema.properties,
        // What the office bell says the customer asked about. Never shown to the customer.
        topic: { type: 'string', enum: ESCALATION_TOPICS, description: 'What the customer needs. account_change: email, phone, address, gate code, pets. add_service: adding or quoting a service. pest_problem: pests or a lawn problem back between visits. other: none of the rest.' },
      },
      required: ['reason', 'topic'],
    },
  },
];

// GATE_PORTAL_CHAT_FACTS: the portal tools plus the account-fact tools. A
// fact tool renders the customer's own rows into a CARD the chat shows (the
// same rows the portal tab shows); the model is told only that the card is
// there, never the figures, so there is no money-shaped text for it to
// misstate (owner ruling 2026-10-01: the AI states a payment fact only by
// copying a system-rendered sentence; here it copies nothing).
const RECENT_PAYMENTS_SHOWN = 3;
// Payment statuses the card knows how to label. Anything else is left off
// the card and reported to the model as "other" so it hands off.
// 'upcoming' is a scheduled Auto Pay row (getPaymentHistory orders it first by
// its future date); it is labeled so it never hides the card, and
// "Scheduled" is not a completed payment.
const PAYMENT_STATUS_LABELS = { paid: 'Paid', processing: 'Processing', failed: 'Failed', refunded: 'Refunded', upcoming: 'Scheduled' };
// A refund the card may call refunded: the webhook's settled stamps, or a
// Stripe refund object that succeeded. A pending or failed refund has no
// label, so the card is withheld.
const SETTLED_REFUND_STATUSES = new Set(['full', 'partial', 'succeeded']);
function paymentStatusLabel(p) {
  let status = String(p.status || '').toLowerCase();
  // The Billing tab's own rule: an 'upcoming' row whose date has passed has
  // not resolved yet and shows as processing, never as a future charge.
  if (status === 'upcoming' && dateKeyOf(p.date) < etDateString()) status = 'processing';
  const base = PAYMENT_STATUS_LABELS[status];
  if (!base) return null;
  if (!(p.refundAmount > 0)) return base;
  if (!SETTLED_REFUND_STATUSES.has(String(p.refundStatus || '').toLowerCase())) return null;
  return base === 'Paid' ? `Paid, ${moneyLabel(p.refundAmount)} refunded` : base;
}
const SHOW_RECENT_PAYMENTS_TOOL = {
    name: 'show_recent_payments',
    description: 'Show the customer a card with their most recent payments: date, amount, what it was for, the card or bank used, status, and a receipt link, plus an Open Billing button. Use for any question about a charge, a payment, a receipt, or whether a payment went through. You will be told only that the card was shown and how many payments it lists; the figures are on the card, not in your reply.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
};
// GATE_PORTAL_CHAT_VISIT_FACTS: the structured visit facts (date, service,
// technician first name, kinds of product) go to the model so it can answer
// in its own words; the reviewed summary, which is free text, goes on a card.
const RECENT_VISITS_READ = 3;
const VISIT_SUMMARY_CHARS = 600;
const GET_RECENT_VISITS_TOOL = {
  name: 'get_recent_visits',
  description: 'Get the customer\'s most recent completed visits (date, service, the technician\'s first name, the kinds of product applied) and show the customer a card with each visit\'s reviewed summary and report link. Use for any question about what was done at a visit, when the last visit was, or where a service report is.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};
// GATE_PORTAL_CHAT_RESERVICE: pests (or a lawn problem) back between visits.
// The free re-service is offered only through a button the server builds
// from the /reservice page's own eligibility read, for the one service line
// the customer named; the model is never the one deciding a visit is free.
const OFFER_RESERVICE_TOOL = {
  name: 'offer_reservice',
  description: 'For a customer reporting household pests back between scheduled visits: checks whether their plan covers a free pest re-service and, when it does, shows a button that opens its booking page. If one is already booked, shows a button to move it instead. You are told which case applies. Not for lawn problems.',
  input_schema: {
    type: 'object',
    // Pest only for now (owner ruling 2026-10-02): the lawn check ships in its own PR.
    properties: { service_line: { type: 'string', enum: ['pest'], description: 'pest: household insects and spiders. The server checks the customer\'s own words; rodents, termites, mosquitoes and tree or shrub problems are separate services and are never a free re-service.' } },
    required: ['service_line'],
    additionalProperties: false,
  },
};
// GATE_PORTAL_CHAT_RESERVICE_LAWN: the same tool with the lawn line. Whether
// the customer is reporting a current lawn problem is the model's judgement
// (owner ruling 2026-10-03: the AI judges and quotes the customer, the code
// only verifies; no lawn word list). Pest stays on the server's own classifier.
const OFFER_RESERVICE_LAWN_TOOL = {
  name: 'offer_reservice',
  description: 'For a customer reporting household pests, or a lawn problem, back between scheduled visits: checks whether their plan covers a free re-service for that service line and, when it does, shows a button that opens its booking page. If one is already booked, shows a button to move it instead. You are told which case applies.',
  input_schema: {
    type: 'object',
    properties: {
      service_line: { type: 'string', enum: ['pest', 'lawn'], description: 'pest: household insects and spiders (the server checks the customer\'s own words). lawn: weeds, turf insects, brown, thin or dying grass. Rodents, termites, mosquitoes and tree or shrub problems are separate services and are never a free re-service.' },
      current_problem: { type: 'boolean', description: 'lawn only. true ONLY when the customer says, in this message, that the lawn problem is happening now. false for a question about lawn care, a what-if, a problem in the past, or one they say is fixed.' },
      customer_quote: { type: 'string', description: 'lawn only. The customer\'s exact words from this message that describe the lawn problem, copied word for word.' },
    },
    required: ['service_line'],
    additionalProperties: false,
  },
};
// The portal tool set for the gates that are live: the four base tools, the
// fact and action tools, then escalate last.
function portalToolsFor({ payments = false, visits = false, reservice = false, reserviceLawn = false } = {}) {
  return [
    ...PORTAL_TOOLS.slice(0, 4),
    ...(payments ? [SHOW_RECENT_PAYMENTS_TOOL] : []),
    ...(visits ? [GET_RECENT_VISITS_TOOL] : []),
    ...(reservice ? [reserviceLawn ? OFFER_RESERVICE_LAWN_TOOL : OFFER_RESERVICE_TOOL] : []),
    PORTAL_TOOLS[4],
  ];
}
const PORTAL_FACTS_TOOLS = portalToolsFor({ payments: true });

const CUSTOMER_SCOPED_TOOLS = new Set(['get_upcoming_services', 'offer_reschedule_link', 'show_recent_payments', 'get_recent_visits', 'offer_reservice']);
const TOOL_CANCELLATION_CODES = new Set(['PORTAL_CHAT_DEADLINE', 'ABORT_ERR', '57014']);
const TOOL_CANCELLATION_NAMES = new Set(['AbortError', 'KnexTimeoutError']);

function isToolCancellation(err) {
  return TOOL_CANCELLATION_CODES.has(err?.code) || TOOL_CANCELLATION_NAMES.has(err?.name);
}

const TOOL_EXECUTORS = new Map([
  ['get_upcoming_services', ({ customerId, turn }) => getUpcomingServices(customerId, turn)],
  ['get_pest_advice', ({ input, turn }) => getPestAdvice(input.topic, turn)],
  ['offer_reschedule_link', ({ customerId, actions, turn }) => offerRescheduleLink(customerId, actions, turn)],
  ['open_portal_section', ({ input, actions, turn }) => openPortalSection(input.section, actions, turn)],
  ['show_recent_payments', ({ customerId, actions, cards, turn }) => showRecentPayments(customerId, actions, cards, turn)],
  ['get_recent_visits', ({ customerId, actions, cards, turn }) => getRecentVisits(customerId, actions, cards, turn)],
  ['offer_reservice', ({ customerId, input, actions, context, turn }) => offerReservice(customerId, input, actions, context, turn)],
  // Handled in assistant.js before reaching here.
  ['escalate', ({ input }) => ({ escalated: true, reason: input.reason })],
]);

// One button per target. No count cap is needed, and none may refuse a
// button a tool then reports as shown: the distinct targets are the portal
// sections plus MAX_RESCHEDULE_BUTTONS links.
function addAction(actions, action) {
  if (!Array.isArray(actions)) return;
  const key = action.href || action.tab;
  if (actions.some((a) => (a.href || a.tab) === key)) return;
  actions.push(action);
}

// Tool execution. `actions` collects the buttons a portal tool wants shown
// under the reply and `cards` the fact cards; callers that cannot render
// them leave both out. `context.secondaryProperty`: the portal session is
// scoped to a non-primary saved property (or its scope could not be read);
// `context.customerMessage`: the customer's message this turn.
// `turn` belongs to authenticated portal chat. SMS uses this same dispatcher
// without the portal coordinator and keeps its existing execution policy.
// The portal caller is wired in the separate coordinator activation slice.
async function executeToolCall(toolName, input, contextCustomerId, actions = null, cards = null, context = {}, turn = null) {
  try {
    input = input && typeof input === 'object' ? input : {};

    // Model-produced arguments are untrusted input. Customer scope always
    // comes from the authenticated request/webhook context, never from a tool
    // argument. Explicitly reject a conflicting legacy customer_id instead of
    // silently querying it or making the boundary ambiguous in logs.
    if (CUSTOMER_SCOPED_TOOLS.has(toolName)) {
      if (!contextCustomerId) return { error: 'Authenticated customer context required' };
      if (input.customer_id && String(input.customer_id) !== String(contextCustomerId)) {
        logger.warn(`[ai-assistant] blocked cross-customer tool scope tool=${toolName}`);
        return { error: 'Customer scope mismatch' };
      }
    }

    const execute = TOOL_EXECUTORS.get(toolName);
    if (!execute) return { error: `Unknown tool: ${toolName}` };
    return await execute({ input, customerId: contextCustomerId, actions, cards, context, turn });
  } catch (err) {
    if (isToolCancellation(err)) throw err;
    logger.error(`Tool ${toolName} failed: ${err.message}`);
    return { error: `Tool failed: ${err.message}` };
  }
}

async function getUpcomingServices(customerId, turn) {
  if (!customerId) return { services: [] };
  const query = db('scheduled_services')
    .where('customer_id', customerId)
    .where('scheduled_date', '>=', etDateString())
    .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
    .select('scheduled_services.scheduled_date', 'scheduled_services.service_type',
      'scheduled_services.window_start', 'scheduled_services.status')
    .orderBy('scheduled_date')
    .limit(5);
  const services = turn ? await turn.query(query, 'upcoming services') : await query;

  return {
    services: services.map(s => ({
      date: s.scheduled_date,
      type: s.service_type,
      // window_end is the internal job-duration block, not the promised
      // customer arrival window. Derive the same start + 2h window used by
      // customer SMS and the portal tracker.
      window: arrivalWindowRange(String(s.window_start || '')) || 'TBD',
      status: s.status,
    })),
  };
}

// 'YYYY-MM-DD' for a DATE column, which pg hands back as a Date at UTC
// midnight (reading it in Eastern time would name the day before).
function dateKeyOf(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

function shortDateLabel(dateKey) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// The visit as the reschedule page loads it, when that page's own GET verdict
// would let the customer move it; null otherwise. The caller fails closed
// after the bounded transaction has rolled back.
async function movableVisit(id, database = db) {
  const { loadById, pageEligibility } = require('../../routes/reschedule-public')._internals;
  const svc = await loadById(id, database);
  const verdict = svc && await pageEligibility(svc, new Date(), database);
  return verdict?.ok ? svc : null;
}

async function offerRescheduleLink(customerId, actions, turn) {
  const NO_LINK = {
    available: false,
    instruction: 'No visit of this customer can be moved online right now. Use the escalate tool so the team moves it.',
  };
  if (!customerId || !Array.isArray(actions)) return NO_LINK;
  // A button only for a visit the reschedule page itself will accept: its own
  // loader and GET verdict (account state, status, dispatch review, grouped or
  // frozen visit, the self-serve move notice window), never a mirror of it.
  // Any failure fails closed — no button.
  const movable = [];
  // Upcoming visits are read a page at a time until three are movable or
  // none are left: the button cap applies to movable visits, so no run of
  // visits the page refuses can hide a later one it accepts.
  for (let offset = 0; movable.length < MAX_RESCHEDULE_BUTTONS; offset += RESCHEDULE_PAGE) {
    const query = db('scheduled_services')
      .where('customer_id', customerId)
      .where('scheduled_date', '>=', etDateString())
      // The reschedule page's own status set (a 'rescheduled' visit is still
      // upcoming and movable); its verdict below decides the rest.
      .whereIn('status', [...RESCHEDULABLE_STATUSES])
      .whereNotNull('reschedule_token')
      .select('id', 'scheduled_date', 'service_type', 'window_start', 'reschedule_token')
      .orderBy('scheduled_date')
      .orderBy('id')
      .limit(RESCHEDULE_PAGE)
      .offset(offset);
    const rows = turn ? await turn.query(query, 'reschedule visits') : await query;
    for (const row of rows) {
      if (movable.length >= MAX_RESCHEDULE_BUTTONS) break;
      let svc;
      try {
        svc = turn
          ? await turn.transaction('reschedule eligibility', (database) => movableVisit(row.id, database))
          : await movableVisit(row.id);
      } catch (err) {
        if (isToolCancellation(err)) throw err;
        logger.warn(`[ai-assistant] reschedule eligibility failed for visit ${row.id}, no button: ${err.message}`);
        svc = null;
      }
      if (svc) movable.push({ row, property: String(svc.address_line1 || '').trim() });
    }
    if (rows.length < RESCHEDULE_PAGE) break;
  }
  if (!movable.length) return NO_LINK;

  // A customer with visits at more than one property gets the street on each
  // button, so two same-day visits are never indistinguishable. The street
  // goes on the server-built label only: the tool result below is sent to
  // the model, which is given no account data.
  const multiProperty = new Set(movable.map((m) => m.property)).size > 1;
  turn?.assertActive('reschedule buttons');
  const visits = movable.map(({ row, property }) => {
    const dateKey = dateKeyOf(row.scheduled_date);
    const type = String(row.service_type || 'visit');
    const where = multiProperty && property ? `, ${property}` : '';
    addAction(actions, {
      type: 'link',
      label: `Reschedule ${type}, ${shortDateLabel(dateKey)}${where}`.slice(0, 80),
      href: `/reschedule/${row.reschedule_token}`,
    });
    return { date: dateKey, type, window: arrivalWindowRange(String(row.window_start || '')) || 'TBD' };
  });
  return {
    available: true,
    visits,
    instruction: `A Reschedule button for each listed visit is now shown under your reply${multiProperty ? ', each naming its property' : ''}. Tell the customer to tap it to see the open times and pick one. Do not state or promise a new time yourself.`,
  };
}

// Money for a card: whole dollars and cents, as the Billing tab prints them.
const moneyLabel = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDateLabel = (value) => {
  const key = dateKeyOf(value);
  const d = new Date(`${key}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const methodLabel = (p) => {
  if (!p.lastFour) return '';
  // The same four aliases autopay-eligibility.js and the Billing tab read.
  const isBank = ['us_bank_account', 'bank', 'ach', 'bank_account'].includes(String(p.methodType || '').toLowerCase());
  const brand = isBank ? (p.bankName || 'Bank account') : (p.cardBrand ? p.cardBrand.charAt(0).toUpperCase() + p.cardBrand.slice(1) : 'Card');
  return `${brand} ending in ${p.lastFour}`;
};

async function showRecentPayments(customerId, actions, cards, turn) {
  const NOT_SHOWN = { shown: false, instruction: 'The payment card could not be shown. Offer the Billing page and, for a question about a specific charge, use the escalate tool.' };
  if (!customerId || !Array.isArray(cards)) return NOT_SHOWN;
  const prior = cards.findIndex((c) => c.type === 'payments');
  let page;
  try {
    page = turn
      ? await turn.transaction('payment history', (database) => listPortalPayments(customerId, { limit: RECENT_PAYMENTS_SHOWN, database }))
      : await listPortalPayments(customerId, { limit: RECENT_PAYMENTS_SHOWN });
  } catch (err) {
    if (isToolCancellation(err)) throw err;
    logger.warn(`[ai-assistant] recent payments read failed for ${customerId}: ${err.message}`);
    turn?.assertActive('payment card fallback');
    if (prior !== -1) cards.splice(prior, 1);
    addAction(actions, { type: 'tab', label: 'Open Billing', tab: 'billing' });
    return NOT_SHOWN;
  }
  turn?.assertActive('payment card');
  if (prior !== -1) cards.splice(prior, 1);
  addAction(actions, { type: 'tab', label: 'Open Billing', tab: 'billing' });
  // Any payment the card cannot label means no card at all: a card that
  // skipped the newest (say, disputed) payment would present an older one
  // as the latest, and the model would confirm a payment that did not land.
  const unlabeled = page.payments.some((p) => !paymentStatusLabel(p));
  // Payer ownership unreadable means a third-party payer's payment may be
  // in the list: show nothing rather than risk it.
  if (page.payerLookupFailed) return NOT_SHOWN;
  const rows = unlabeled ? [] : page.payments.map((p) => {
    const statusLabel = paymentStatusLabel(p);
    return {
      id: String(p.id),
      description: String(p.description || 'Payment').replace(/\s+[—-]\s+per (application|visit)\s*$/i, ''),
      dateLabel: longDateLabel(p.date),
      amountLabel: moneyLabel(p.amount),
      statusLabel,
      methodLabel: methodLabel(p),
      receiptUrl: p.receiptUrl || null,
    };
  });
  if (!rows.length) {
    return {
      shown: false,
      count: 0,
      // An empty page with history behind it (a bounded scan that ended
      // before the first visible row) is not "no payments".
      instruction: unlabeled || page.hasMore || Number(page.total || 0) > 0
        ? 'The recent payments are in a state the card cannot show. Tell the customer the Billing page has the details and offer to pass the question to the team.'
        : 'No payments are on record for this customer. Say so plainly and show the Billing page.',
    };
  }
  cards.push({ type: 'payments', title: rows.length === 1 ? 'Your most recent payment' : `Your last ${rows.length} payments`, rows });
  return {
    shown: true,
    count: rows.length,
    // Status words only, so the model can say whether the latest payment
    // went through. Dates, amounts and descriptions stay on the card.
    statuses: rows.map((r) => r.statusLabel.split(',')[0]),
    instruction: `A card listing the customer's last ${rows.length} payment${rows.length === 1 ? '' : 's'} (date, amount, description, payment method, status, receipt) is now shown under your reply, with an Open Billing button. Point the customer to it. Do not state any amount, date or description yourself. If the customer asks why a charge is what it is, or disputes it, use the escalate tool.`,
  };
}

async function getRecentVisits(customerId, actions, cards, turn) {
  const UNAVAILABLE = { visits: null, instruction: 'The visit history could not be read. Tell the customer the Completed visits page has it and, for a question about a specific visit, use the escalate tool.' };
  if (!customerId || !Array.isArray(actions) || !Array.isArray(cards)) return UNAVAILABLE;
  const prior = cards.findIndex((c) => c.type === 'visits');
  let page;
  try {
    page = turn
      ? await turn.transaction('service history', (database) => listPortalServiceHistory(customerId, {
        limit: RECENT_VISITS_READ, completedOnly: true, database,
      }))
      : await listPortalServiceHistory(customerId, { limit: RECENT_VISITS_READ, completedOnly: true });
  } catch (err) {
    if (isToolCancellation(err)) throw err;
    logger.warn(`[ai-assistant] recent visits read failed for ${customerId}: ${err.message}`);
    turn?.assertActive('visit card fallback');
    if (prior !== -1) cards.splice(prior, 1);
    addAction(actions, { type: 'tab', label: PORTAL_SECTIONS.service_reports.label, tab: PORTAL_SECTIONS.service_reports.tab });
    return UNAVAILABLE;
  }
  turn?.assertActive('visit card');
  if (prior !== -1) cards.splice(prior, 1);
  addAction(actions, { type: 'tab', label: PORTAL_SECTIONS.service_reports.label, tab: PORTAL_SECTIONS.service_reports.tab });
  if (!page.services.length) {
    return {
      visits: [],
      // An empty page with history behind it is not "no visits".
      instruction: page.total > 0
        ? UNAVAILABLE.instruction
        : 'No completed visits are on record for this customer. Say so plainly.',
    };
  }
  const rows = page.services.map((svc) => ({
    id: String(svc.id),
    service: String(svc.type || 'Visit'),
    dateLabel: longDateLabel(svc.date),
    technician: String(svc.technician || '').trim().split(/\s+/)[0] || null,
    // The reviewed report text, shown to the customer on the card exactly as
    // the Completed tab shows it. It is free text (it can name a product or
    // a price), so it goes on the card and never to the model.
    summary: svc.notes ? String(svc.notes).slice(0, VISIT_SUMMARY_CHARS) : null,
    // The Waves report page only; a project report hosted elsewhere stays on
    // the Completed visits page.
    reportUrl: typeof svc.reportUrl === 'string' && /^\/report\/[A-Za-z0-9_-]+$/.test(svc.reportUrl) ? svc.reportUrl : null,
    // Kinds only: product names are on the report, and the owner's rule is
    // that the assistant never names a product brand.
    productKinds: [...new Set((svc.products || []).map((p) => String(p.product_category || '').trim()).filter(Boolean))],
  }));
  cards.push({
    type: 'visits',
    title: rows.length === 1 ? 'Your most recent visit' : `Your last ${rows.length} visits`,
    rows: rows.map(({ productKinds: _kinds, ...row }) => row),
  });
  return {
    // Structured facts only. The summary text and the report link are on the
    // card, not here.
    visits: rows.map((r) => ({
      date: r.dateLabel, service: r.service, technician: r.technician, product_kinds: r.productKinds,
      summary_on_card: Boolean(r.summary), report_link_on_card: Boolean(r.reportUrl),
    })),
    instruction: 'A card under your reply shows each visit with its reviewed summary and report link. You are not given the summary text: say when the visit was, what service it was, who did it and the kinds of product applied, and point the customer to the card for what was found and treated. Do not add a finding, product or date that is not here, and never name a product brand.',
  };
}

// Pest only for now (owner ruling 2026-10-02); lawn reports hand off.
const RESERVICE_LINE_WORDS = { pest: 'pest control', lawn: 'lawn care' };
const RESERVICE_COVERS = { pest: 'general pest control', lawn: 'lawn care' };
const RESERVICE_SPECIALTY = {
  offered: false,
  instruction: 'What the customer describes includes a separately priced service (such as rodents, termites, mosquitoes or a tree and shrub problem), which a free re-service does not cover. Do not offer or imply a free visit. Acknowledge what they are seeing and use the escalate tool with topic pest_problem so the team follows up.',
};
const RESERVICE_HAND_OFF = {
  offered: false,
  instruction: 'A free re-service cannot be offered online for this right now. Do not offer or imply a free visit. Acknowledge what the customer is seeing and use the escalate tool with topic pest_problem so the team follows up.',
};

// Whether the /reservice page could take this customer at all from this
// session: the page books at the account's PRIMARY address, so a session
// looking at another property gets no button (the Schedule tab's own rule),
// and the same two switches the Schedule tab's hand-off to the page reads.
function reserviceSurfaceOpen({ secondaryProperty }) {
  return !secondaryProperty && reservicePageSwitchesOn();
}
// The two switches the /reservice page and the Schedule tab's hand-off to it
// need. POST /api/ai/chat reads them too, so it never resolves the property
// scope (which can write) for a tool that would refuse anyway.
function reservicePageSwitchesOn() {
  const { isEnabled } = require('../../config/feature-gates');
  return isEnabled('reserviceStreamline') && require('../reservice-scheduler').reserviceSelfServeEnabled();
}

// A re-service already open in the line: its date and window for the model,
// and a button to move it only when the reschedule page would accept it.
async function bookedReserviceResult(customerId, line, booked, database = db) {
  // The reschedule route's own token format: any other token is a 404 there.
  const token = /^\/reschedule\/([^/]+)$/.exec(String(booked.rescheduleUrl || ''))?.[1];
  const { TOKEN_RE: RESCHEDULE_TOKEN_RE } = require('../../routes/reschedule-public')._internals;
  if (token && !RESCHEDULE_TOKEN_RE.test(token)) return { result: bookedReserviceFacts(line, booked, false) };
  // The button is optional: a failed lookup keeps the booked visit's facts.
  const row = token && await database('scheduled_services').where({ customer_id: customerId, reschedule_token: token }).first('id');
  const movable = Boolean(row && await movableVisit(row.id, database));
  return {
    result: bookedReserviceFacts(line, booked, movable),
    action: movable ? {
      type: 'link',
      label: `Reschedule ${booked.serviceType}, ${shortDateLabel(booked.date)}`.slice(0, 80),
      href: booked.rescheduleUrl,
    } : null,
  };
}

function bookedReserviceFacts(line, booked, movable) {
  return {
    offered: false,
    already_booked: { date: longDateLabel(booked.date), window: arrivalWindowRange(String(booked.windowStart || '')) || 'TBD' },
    instruction: `A free ${RESERVICE_LINE_WORDS[line]} re-service is already on the schedule (date and window above). Do not offer another one or a paid visit. Acknowledge what the customer is seeing and refer to that visit${movable ? '; a button to move it is shown under your reply' : ''}.`,
  };
}

// What is covered is read from the customer's own message THIS turn with the
// texting AI's classifier, never from the line the model picked and never
// carried forward from an earlier message (a later "they're gone now" must
// not leave an old report standing). A separately priced specialty in it
// means no free offer, and so does anything short of an active pest report
// (isActivePestReport, the SMS flow's own predicate) in the pest line:
// "Do you cover ants?" names a pest but reports nothing.
function reportRefusal(customerMessage, line, input) {
  const { reportedReserviceLanes, reportedReserviceExcludedSpecialty, isActivePestReport } = require('../reservice-scheduler');
  const text = String(customerMessage || '');
  if (reportedReserviceExcludedSpecialty(text)) return RESERVICE_SPECIALTY;
  if (line === 'lawn') return lawnReportRefusal(text, input);
  return isActivePestReport(text) && reportedReserviceLanes(text).includes(line) ? null : RESERVICE_HAND_OFF;
}

// Lawn (owner ruling 2026-10-03): the model judges whether the customer is
// reporting a current lawn problem and quotes them; the code only verifies
// that the quote is word for word in this turn's message and names a lawn
// subject. No list of lawn-problem wording lives here: do not grow one.
const RESERVICE_NOT_CURRENT = {
  offered: false,
  instruction: 'This was not marked as a lawn problem happening now, so no free re-service applies. Answer the customer\'s question; do not offer or imply a free visit.',
};
const RESERVICE_QUOTE_UNVERIFIED = {
  offered: false,
  instruction: 'The quote is not the customer\'s own words about their lawn from this message, so no free re-service can be offered on it. Do not offer or imply a free visit. If the customer did report a lawn problem happening now in this message, call again with their exact words; otherwise answer them, or use the escalate tool with topic pest_problem.',
};
const LAWN_QUOTE_MIN_CHARS = 8;
const foldQuoteText = (v) => String(v || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
function lawnReportRefusal(customerMessage, input) {
  if (input.current_problem !== true) return RESERVICE_NOT_CURRENT;
  const quote = foldQuoteText(input.customer_quote);
  if (quote.length < LAWN_QUOTE_MIN_CHARS || !foldQuoteText(customerMessage).includes(quote)) return RESERVICE_QUOTE_UNVERIFIED;
  // The lawn copy's own service words (reservice-scheduler) plus the turf itself.
  const { RESERVICE_LAWN_SERVICE_WORDS } = require('../reservice-scheduler');
  const lawnSubject = new RegExp(`\\b(?:${RESERVICE_LAWN_SERVICE_WORDS}|grass|yard)\\b`, 'i');
  return lawnSubject.test(quote) ? null : RESERVICE_QUOTE_UNVERIFIED;
}

// The service line asked for; the lawn line exists only under its own gate.
function reserviceLineOf(input, lawn) {
  return (lawn ? ['pest', 'lawn'] : ['pest']).includes(input.service_line) ? input.service_line : null;
}

async function offerReservice(customerId, input, actions, { secondaryProperty = true, customerMessage = '', lawn = false } = {}, turn = null) {
  const line = reserviceLineOf(input, lawn);
  if (!customerId || !line || !Array.isArray(actions)) return RESERVICE_HAND_OFF;
  if (!reserviceSurfaceOpen({ secondaryProperty })) return RESERVICE_HAND_OFF;
  const refusal = reportRefusal(customerMessage, line, input);
  if (refusal) return refusal;
  const read = (database) => offerReserviceResult(customerId, line, database);
  let decision;
  try {
    decision = turn
      ? await turn.transaction('re-service offer', read)
      : await read(db);
  } catch (err) {
    if (isToolCancellation(err)) throw err;
    logger.warn(`[ai-assistant] re-service read failed, no button: ${err.message}`);
    return RESERVICE_HAND_OFF;
  }
  if (decision.booked) {
    try {
      decision = turn
        ? await turn.transaction('booked re-service move', (database) => bookedReserviceResult(customerId, line, decision.booked, database))
        : await bookedReserviceResult(customerId, line, decision.booked);
    } catch (err) {
      if (isToolCancellation(err)) throw err;
      logger.warn(`[ai-assistant] booked re-service move read failed, no button: ${err.message}`);
      decision = { result: bookedReserviceFacts(line, decision.booked, false) };
    }
  }
  if (decision.action) {
    turn?.assertActive('re-service button');
    addAction(actions, decision.action);
  }
  return decision.result;
}

async function offerReserviceResult(customerId, line, database = db) {
  // An open re-service in the line is read on its own, as the page does: a
  // visit booked while the plan covered the line stays on the schedule after
  // coverage changes, and the customer is told about it.
  const open = await require('../reservice-scheduler').openReserviceCallbacks(customerId, database);
  if (open[line]) return { booked: open[line] };
  const customer = await database('customers').where({ id: customerId }).whereNull('deleted_at').first('reservice_token');
  const token = String(customer?.reservice_token || '');
  // The /reservice page's own token format and verdict for this token (its
  // customer load, lane catalog, coverage and open re-services), so the chat
  // offers exactly what the page would show. Any failure hands off.
  const page = require('../../routes/reservice-public')._internals;
  if (!page.TOKEN_RE.test(token)) return { result: RESERVICE_HAND_OFF };
  const state = await page.pageLaneState(token, database);
  if (!state || String(state.customer.id) !== String(customerId)) return { result: RESERVICE_HAND_OFF };
  if (!state.bookableLanes.includes(line)) return { result: RESERVICE_HAND_OFF };
  // An address held for staff review shows no times on the page, only
  // instructions to text or call: hand off rather than promise a time.
  const reviewHold = await page.reserviceLocationReviewRequired(state.customer, database);
  if (reviewHold) return { result: RESERVICE_HAND_OFF };
  // One label for both lines: the page lets the customer pick the line, and a
  // second call for the other line shares this href (one button).
  return {
    action: { type: 'link', label: 'Book your free re-service', href: `/reservice/${token}` },
    result: {
      offered: true,
      instruction: `The customer's plan covers a free ${RESERVICE_LINE_WORDS[line]} re-service, and a button that opens its booking page is now shown under your reply. Acknowledge what they are seeing, tell them the visit is free under their plan, and tell them to tap the button to book it. Do not say whether times are open or promise a time: the page shows what is open, and says how to reach the team when nothing is. The free visit covers ${RESERVICE_COVERS[line]} only: never say it covers rodents, termites, mosquitoes or a tree and shrub problem.`,
    },
  };
}

function openPortalSection(section, actions, turn) {
  const target = Object.prototype.hasOwnProperty.call(PORTAL_SECTIONS, section) ? PORTAL_SECTIONS[section] : null;
  if (!target || !Array.isArray(actions)) return { shown: false, error: 'Unknown section' };
  turn?.assertActive('portal button');
  addAction(actions, { type: 'tab', label: target.label, tab: target.tab });
  return { shown: true, instruction: `An "${target.label}" button is now shown under your reply. Tell the customer to tap it.` };
}

async function getPestAdvice(topic, turn) {
  try {
    const WikiQA = require('../knowledge/wiki-qa');
    const read = () => WikiQA.query(topic, { source: 'ai_assistant' }, turn ? {
      signal: turn.signal,
      remainingMs: turn.remainingMs,
      assertActive: turn.assertActive,
      read: (query, stage) => turn.query(query, stage),
      write: (work, stage) => turn.transaction(stage, work),
    } : undefined);
    const result = turn ? await turn.waitFor(read, 'knowledge answer') : await read();
    return { answer: result.answer, sources: result.articlesUsed };
  } catch (err) {
    if (isToolCancellation(err)) throw err;
    return { answer: 'Knowledge base unavailable. General SWFL advice: contact your technician for specific pest identification and treatment recommendations.' };
  }
}

module.exports = { TOOLS, PORTAL_TOOLS, PORTAL_FACTS_TOOLS, PORTAL_SECTIONS, portalToolsFor, executeToolCall, reservicePageSwitchesOn };
