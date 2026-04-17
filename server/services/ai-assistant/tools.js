/**
 * Waves AI Assistant — Claude Tool Definitions
 *
 * Claude decides when to call these based on the conversation.
 * No rigid decision trees — the model picks the right tool naturally.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

// Tool definitions in Anthropic format
const TOOLS = [
  {
    name: 'lookup_customer',
    description: 'Look up a customer by phone number or name. Returns account details, tier, balance, upcoming services.',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Customer phone number' },
        name: { type: 'string', description: 'Customer name (first or full)' },
      },
    },
  },
  {
    name: 'get_upcoming_services',
    description: 'Get the next scheduled services for a customer. Shows dates, service types, and technician.',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'Customer UUID' } },
      required: ['customer_id'],
    },
  },
  {
    name: 'get_service_history',
    description: 'Get recent completed services for a customer with technician notes and products used.',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'Customer UUID' }, limit: { type: 'number' } },
      required: ['customer_id'],
    },
  },
  {
    name: 'get_billing_info',
    description: 'Get billing info: current balance, recent payments, payment methods, overdue amounts.',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'Customer UUID' } },
      required: ['customer_id'],
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
  {
    name: 'get_call_history',
    description: 'Get recent call recordings and transcripts for a customer.',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'Customer UUID' }, limit: { type: 'number' } },
      required: ['customer_id'],
    },
  },
];

// Tool execution
async function executeToolCall(toolName, input, contextCustomerId) {
  try {
    switch (toolName) {
      case 'lookup_customer':
        return await lookupCustomer(input, contextCustomerId);
      case 'get_upcoming_services':
        return await getUpcomingServices(input.customer_id || contextCustomerId);
      case 'get_service_history':
        return await getServiceHistory(input.customer_id || contextCustomerId, input.limit);
      case 'get_billing_info':
        return await getBillingInfo(input.customer_id || contextCustomerId);
      case 'get_pest_advice':
        return await getPestAdvice(input.topic);
      case 'get_call_history':
        return await getCallHistory(input.customer_id || contextCustomerId, input.limit);
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

async function lookupCustomer(input, contextCustomerId) {
  let customer;

  if (contextCustomerId) {
    customer = await db('customers').where('id', contextCustomerId).first();
  }

  if (!customer && input.phone) {
    const clean = input.phone.replace(/\D/g, '');
    customer = await db('customers').where(function () {
      this.where('phone', clean).orWhere('phone', `+1${clean}`).orWhere('phone', `+${clean}`);
    }).first();
  }

  if (!customer && input.name) {
    customer = await db('customers').where('first_name', 'ilike', `%${input.name}%`).first();
  }

  if (!customer) return { found: false };

  const balance = await db('payments').where('customer_id', customer.id)
    .whereIn('status', ['failed', 'overdue']).sum('amount as total').first();

  return {
    found: true,
    id: customer.id,
    name: `${customer.first_name} ${customer.last_name}`,
    firstName: customer.first_name,
    phone: customer.phone,
    address: `${customer.address_line1}, ${customer.city}, FL ${customer.zip}`,
    tier: customer.waveguard_tier,
    monthlyRate: parseFloat(customer.monthly_rate || 0),
    memberSince: customer.member_since,
    outstandingBalance: parseFloat(balance?.total || 0),
  };
}

async function getUpcomingServices(customerId) {
  if (!customerId) return { services: [] };
  const services = await db('scheduled_services')
    .where('customer_id', customerId)
    .where('scheduled_date', '>=', etDateString())
    .whereNotIn('status', ['cancelled'])
    .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
    .select('scheduled_services.scheduled_date', 'scheduled_services.service_type',
      'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.status', 'technicians.name as tech_name')
    .orderBy('scheduled_date')
    .limit(5);

  return {
    services: services.map(s => ({
      date: s.scheduled_date,
      type: s.service_type,
      window: s.window_start && s.window_end ? `${s.window_start}-${s.window_end}` : 'TBD',
      tech: s.tech_name || 'TBD',
      status: s.status,
    })),
  };
}

async function getServiceHistory(customerId, limit = 5) {
  if (!customerId) return { services: [] };
  const services = await db('service_records')
    .where('customer_id', customerId)
    .where('status', 'completed')
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .select('service_records.service_date', 'service_records.service_type',
      'service_records.technician_notes', 'technicians.name as tech_name')
    .orderBy('service_date', 'desc')
    .limit(limit);

  return {
    services: services.map(s => ({
      date: s.service_date,
      type: s.service_type,
      tech: s.tech_name,
      notes: (s.technician_notes || '').substring(0, 200),
    })),
  };
}

async function getBillingInfo(customerId) {
  if (!customerId) return { error: 'No customer ID' };

  const customer = await db('customers').where('id', customerId).first();
  const payments = await db('payments').where('customer_id', customerId).orderBy('payment_date', 'desc').limit(5);
  const cards = await db('payment_methods').where('customer_id', customerId);
  const overdue = payments.filter(p => ['failed', 'overdue'].includes(p.status));

  return {
    tier: customer?.waveguard_tier,
    monthlyRate: parseFloat(customer?.monthly_rate || 0),
    outstandingBalance: overdue.reduce((s, p) => s + parseFloat(p.amount || 0), 0),
    recentPayments: payments.map(p => ({
      date: p.payment_date, amount: parseFloat(p.amount), status: p.status, description: p.description,
    })),
    paymentMethods: cards.map(c => ({
      brand: c.card_brand, lastFour: c.last_four, isDefault: c.is_default, autopay: c.autopay_enabled,
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

async function getCallHistory(customerId, limit = 5) {
  if (!customerId) return { calls: [] };
  const calls = await db('call_log')
    .where('customer_id', customerId)
    .orderBy('created_at', 'desc')
    .limit(limit);

  return {
    calls: calls.map(c => ({
      date: c.created_at,
      direction: c.direction,
      duration: c.duration_seconds,
      status: c.status,
      outcome: c.call_outcome,
      hasRecording: !!c.recording_url,
      transcription: (c.transcription || '').substring(0, 300),
    })),
  };
}

module.exports = { TOOLS, executeToolCall };
