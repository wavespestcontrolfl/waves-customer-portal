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
      },
      required: ['reason'],
    },
  },
];

const CUSTOMER_SCOPED_TOOLS = new Set(['get_upcoming_services']);

// Tool execution
async function executeToolCall(toolName, input, contextCustomerId) {
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

async function getPestAdvice(topic) {
  try {
    const WikiQA = require('../knowledge/wiki-qa');
    const result = await WikiQA.query(topic, { source: 'ai_assistant' });
    return { answer: result.answer, sources: result.articlesUsed };
  } catch {
    return { answer: 'Knowledge base unavailable. General SWFL advice: contact your technician for specific pest identification and treatment recommendations.' };
  }
}

module.exports = { TOOLS, executeToolCall };
