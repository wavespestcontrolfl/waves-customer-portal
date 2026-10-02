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
const ESCALATION_TOPICS = ['cancellation', 'schedule_change', 'billing', 'complaint', 'account_change', 'add_service', 'manager', 'other'];

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
        topic: { type: 'string', enum: ESCALATION_TOPICS, description: 'What the customer needs. account_change: email, phone, address, gate code, pets. add_service: adding or quoting a service. other: none of the rest.' },
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
const PAYMENT_STATUS_LABELS = { paid: 'Paid', processing: 'Processing', failed: 'Failed', refunded: 'Refunded' };
const PORTAL_FACTS_TOOLS = [
  ...PORTAL_TOOLS.slice(0, 4),
  {
    name: 'show_recent_payments',
    description: 'Show the customer a card with their most recent payments: date, amount, what it was for, the card or bank used, status, and a receipt link, plus an Open Billing button. Use for any question about a charge, a payment, a receipt, or whether a payment went through. You will be told only that the card was shown and how many payments it lists; the figures are on the card, not in your reply.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  PORTAL_TOOLS[4],
];

const CUSTOMER_SCOPED_TOOLS = new Set(['get_upcoming_services', 'offer_reschedule_link', 'show_recent_payments']);

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
// them leave both out.
async function executeToolCall(toolName, input, contextCustomerId, actions = null, cards = null) {
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

    switch (toolName) {
      case 'get_upcoming_services':
        return await getUpcomingServices(contextCustomerId);
      case 'get_pest_advice':
        return await getPestAdvice(input.topic);
      case 'offer_reschedule_link':
        return await offerRescheduleLink(contextCustomerId, actions);
      case 'open_portal_section':
        return openPortalSection(input.section, actions);
      case 'show_recent_payments':
        return await showRecentPayments(contextCustomerId, actions, cards);
      case 'escalate':
        // Handled in assistant.js before reaching here
        return { escalated: true, reason: input.reason };
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`Tool ${toolName} failed: ${err.message}`);
    return { error: `Tool failed: ${err.message}` };
  }
}

async function getUpcomingServices(customerId) {
  if (!customerId) return { services: [] };
  const services = await db('scheduled_services')
    .where('customer_id', customerId)
    .where('scheduled_date', '>=', etDateString())
    .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
    .select('scheduled_services.scheduled_date', 'scheduled_services.service_type',
      'scheduled_services.window_start', 'scheduled_services.status')
    .orderBy('scheduled_date')
    .limit(5);

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

async function offerRescheduleLink(customerId, actions) {
  const NO_LINK = {
    available: false,
    instruction: 'No visit of this customer can be moved online right now. Use the escalate tool so the team moves it.',
  };
  if (!customerId || !Array.isArray(actions)) return NO_LINK;
  // A button only for a visit the reschedule page itself will accept: its own
  // loader and GET verdict (account state, status, dispatch review, grouped or
  // frozen visit, the self-serve move notice window), never a mirror of it.
  // Any failure fails closed — no button.
  const { loadById, pageEligibility } = require('../../routes/reschedule-public')._internals;
  const movable = [];
  // Upcoming visits are read a page at a time until three are movable or
  // none are left: the button cap applies to movable visits, so no run of
  // visits the page refuses can hide a later one it accepts.
  for (let offset = 0; movable.length < MAX_RESCHEDULE_BUTTONS; offset += RESCHEDULE_PAGE) {
    const rows = await db('scheduled_services')
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
    for (const row of rows) {
      if (movable.length >= MAX_RESCHEDULE_BUTTONS) break;
      const svc = await loadById(row.id).catch(() => null);
      const verdict = svc && await pageEligibility(svc).catch((err) => {
        logger.warn(`[ai-assistant] reschedule eligibility failed for visit ${row.id}, no button: ${err.message}`);
        return null;
      });
      if (verdict?.ok) movable.push({ row, property: String(svc.address_line1 || '').trim() });
    }
    if (rows.length < RESCHEDULE_PAGE) break;
  }
  if (!movable.length) return NO_LINK;

  // A customer with visits at more than one property gets the street on each
  // button, so two same-day visits are never indistinguishable. The street
  // goes on the server-built label only: the tool result below is sent to
  // the model, which is given no account data.
  const multiProperty = new Set(movable.map((m) => m.property)).size > 1;
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
  const isBank = ['us_bank_account', 'bank', 'ach'].includes(String(p.methodType || '').toLowerCase());
  const brand = isBank ? (p.bankName || 'Bank account') : (p.cardBrand ? p.cardBrand.charAt(0).toUpperCase() + p.cardBrand.slice(1) : 'Card');
  return `${brand} ending in ${p.lastFour}`;
};

async function showRecentPayments(customerId, actions, cards) {
  const NOT_SHOWN = { shown: false, instruction: 'The payment card could not be shown. Offer the Billing page and, for a question about a specific charge, use the escalate tool.' };
  if (!customerId || !Array.isArray(cards)) return NOT_SHOWN;
  let page;
  try {
    page = await listPortalPayments(customerId, { limit: RECENT_PAYMENTS_SHOWN });
  } catch (err) {
    logger.warn(`[ai-assistant] recent payments read failed for ${customerId}: ${err.message}`);
    return NOT_SHOWN;
  }
  const rows = [];
  let otherStatuses = 0;
  for (const p of page.payments) {
    const statusLabel = PAYMENT_STATUS_LABELS[String(p.status || '').toLowerCase()];
    if (!statusLabel) { otherStatuses += 1; continue; }
    rows.push({
      id: String(p.id),
      description: String(p.description || 'Payment').replace(/\s+[—-]\s+per (application|visit)\s*$/i, ''),
      dateLabel: longDateLabel(p.date),
      amountLabel: moneyLabel(p.amount),
      statusLabel: p.refundAmount > 0 && statusLabel === 'Paid' ? `Paid, ${moneyLabel(p.refundAmount)} refunded` : statusLabel,
      methodLabel: methodLabel(p),
      receiptUrl: p.receiptUrl || null,
    });
  }
  addAction(actions, { type: 'tab', label: 'Open Billing', tab: 'billing' });
  if (!rows.length) {
    return {
      shown: false,
      count: 0,
      instruction: otherStatuses
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

function openPortalSection(section, actions) {
  const target = Object.prototype.hasOwnProperty.call(PORTAL_SECTIONS, section) ? PORTAL_SECTIONS[section] : null;
  if (!target || !Array.isArray(actions)) return { shown: false, error: 'Unknown section' };
  addAction(actions, { type: 'tab', label: target.label, tab: target.tab });
  return { shown: true, instruction: `An "${target.label}" button is now shown under your reply. Tell the customer to tap it.` };
}

async function getPestAdvice(topic) {
  try {
    const WikiQA = require('../knowledge/wiki-qa');
    const result = await WikiQA.query(topic, { source: 'ai_assistant' });
    return { answer: result.answer, sources: result.articlesUsed };
  } catch {
    return { answer: 'Knowledge base unavailable. General SWFL advice: contact your technician for specific pest identification and treatment recommendations.' };
  }
}

module.exports = { TOOLS, PORTAL_TOOLS, PORTAL_FACTS_TOOLS, PORTAL_SECTIONS, executeToolCall };
