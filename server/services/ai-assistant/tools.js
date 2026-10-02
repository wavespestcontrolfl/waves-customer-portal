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
const MAX_ACTIONS_PER_REPLY = 4;

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
  },
];

const CUSTOMER_SCOPED_TOOLS = new Set(['get_upcoming_services', 'offer_reschedule_link']);

function addAction(actions, action) {
  if (!Array.isArray(actions) || actions.length >= MAX_ACTIONS_PER_REPLY) return;
  const key = action.href || action.tab;
  if (actions.some((a) => (a.href || a.tab) === key)) return;
  actions.push(action);
}

// Tool execution. `actions` collects the buttons a portal tool wants shown
// under the reply; callers that cannot render buttons leave it out.
async function executeToolCall(toolName, input, contextCustomerId, actions = null) {
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
  const rows = await db('scheduled_services')
    .where('customer_id', customerId)
    .where('scheduled_date', '>=', etDateString())
    .whereIn('status', ['pending', 'confirmed'])
    .select('id', 'visit_id', 'scheduled_date', 'service_type', 'window_start', 'reschedule_token')
    .orderBy('scheduled_date')
    .limit(3);

  // Same verdict the portal's own Reschedule button uses (routes/schedule.js):
  // a token, and not a grouped or frozen visit (the page refuses those). An
  // unreadable membership fails closed — no button.
  const { groupedVisit } = require('../../routes/reschedule-public');
  const visits = [];
  for (const row of rows) {
    if (!row.reschedule_token) continue;
    if ((await groupedVisit(row)) !== false) continue;
    const dateKey = dateKeyOf(row.scheduled_date);
    const type = String(row.service_type || 'visit');
    addAction(actions, {
      type: 'link',
      label: `Reschedule ${type}, ${shortDateLabel(dateKey)}`.slice(0, 60),
      href: `/reschedule/${row.reschedule_token}`,
    });
    visits.push({ date: dateKey, type, window: arrivalWindowRange(String(row.window_start || '')) || 'TBD' });
  }
  if (!visits.length) return NO_LINK;
  return {
    available: true,
    visits,
    instruction: 'A Reschedule button for each listed visit is now shown under your reply. Tell the customer to tap it to see the open times and pick one. Do not state or promise a new time yourself.',
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

module.exports = { TOOLS, PORTAL_TOOLS, PORTAL_SECTIONS, executeToolCall };
