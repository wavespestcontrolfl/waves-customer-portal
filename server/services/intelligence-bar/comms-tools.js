/**
 * Intelligence Bar — Communications Tools
 * server/services/intelligence-bar/comms-tools.js
 *
 * Tools for the SMS inbox, conversation threading, call recordings,
 * AI reply drafting, and CSR coaching. Virginia's daily driver.
 */

const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { etDateString } = require('../../utils/datetime-et');

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
    description: `Get the full SMS conversation thread with a specific customer. Shows all messages in order.
Use for: "show me the conversation with Henderson", "what did we say to the customer on 941-555-0142?", "pull up the thread with Smith"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Customer name (partial match OK)' },
        phone: { type: 'string', description: 'Phone number' },
        customer_id: { type: 'string' },
        limit: { type: 'number', description: 'Max messages to return (default 20)' },
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
        search: { type: 'string', description: 'Search in message body text' },
        customer_name: { type: 'string' },
        phone: { type: 'string' },
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
        message_type: { type: 'string', enum: ['manual', 'reminder', 'follow_up'], description: 'Default: manual' },
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
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeCommsTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_unanswered_threads': return await getUnansweredThreads(input);
      case 'get_conversation_thread': return await getConversationThread(input);
      case 'search_messages': return await searchMessages(input);
      case 'get_sms_stats': return await getSmsStats(input.days || 30);
      case 'get_call_log': return await getCallLog(input);
      case 'send_sms': return await sendSms(input);
      case 'draft_sms_reply': return await draftSmsReply(input);
      case 'get_csr_overview': return await getCsrOverview(input.days || 30);
      case 'get_todays_activity': return await getTodaysActivity();
      default: return { error: `Unknown comms tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:comms] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function resolveCustomer(input) {
  if (input.customer_id) return db('customers').where('id', input.customer_id).first();
  if (input.customer_name) {
    return db('customers').where(function () {
      const s = `%${input.customer_name}%`;
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("first_name || ' ' || last_name ILIKE ?", [s]);
    }).first();
  }
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, '').slice(-10);
    return db('customers').whereRaw("RIGHT(REPLACE(phone, '+', ''), 10) = ?", [digits]).first();
  }
  return null;
}


async function getUnansweredThreads(input) {
  const { hours_back = 48, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 50);
  const since = new Date(Date.now() - hours_back * 3600000).toISOString();

  // Get recent inbound messages
  const inbound = await db('sms_log')
    .where('direction', 'inbound')
    .where('created_at', '>=', since)
    .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
    .select(
      'sms_log.from_phone', 'sms_log.to_phone', 'sms_log.message_body',
      'sms_log.created_at', 'sms_log.customer_id', 'sms_log.is_read',
      'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
    )
    .orderBy('sms_log.created_at', 'desc');

  // For each inbound, check if there's a later outbound to the same number
  const unanswered = [];
  const seenPhones = new Set();

  for (const msg of inbound) {
    if (isAdminPhone(msg.from_phone)) continue;
    const digits = (msg.from_phone || '').replace(/\D/g, '').slice(-10);
    if (seenPhones.has(digits)) continue;
    seenPhones.add(digits);

    // Check for a reply after this message
    const reply = await db('sms_log')
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
  const limit = Math.min(rawLimit || 20, 50);

  let phone;
  if (input.phone) {
    phone = input.phone;
  } else {
    const customer = await resolveCustomer(input);
    if (!customer) return { error: 'Customer not found' };
    phone = customer.phone;
  }

  if (!phone) return { error: 'No phone number found' };
  const digits = phone.replace(/\D/g, '').slice(-10);

  const messages = await db('sms_log')
    .where(function () {
      this.whereRaw("RIGHT(REPLACE(from_phone, '+', ''), 10) = ?", [digits])
        .orWhereRaw("RIGHT(REPLACE(to_phone, '+', ''), 10) = ?", [digits]);
    })
    .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
    .select(
      'sms_log.id', 'sms_log.direction', 'sms_log.message_body',
      'sms_log.from_phone', 'sms_log.to_phone',
      'sms_log.message_type', 'sms_log.created_at',
      'customers.first_name', 'customers.last_name',
    )
    .orderBy('sms_log.created_at', 'desc')
    .limit(limit);

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
    total: messages.length,
  };
}


async function searchMessages(input) {
  const { search, customer_name, phone, direction, message_type, days_back = 7, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 100);
  const since = new Date(Date.now() - days_back * 86400000).toISOString();

  let query = db('sms_log')
    .where('sms_log.created_at', '>=', since)
    .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
    .select(
      'sms_log.*',
      'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
    )
    .orderBy('sms_log.created_at', 'desc');

  if (search) query = query.whereILike('sms_log.message_body', `%${search}%`);
  if (direction) query = query.where('sms_log.direction', direction);
  if (message_type) query = query.where('sms_log.message_type', message_type);

  if (customer_name) {
    query = query.where(function () {
      this.whereILike('customers.first_name', `%${customer_name}%`)
        .orWhereILike('customers.last_name', `%${customer_name}%`);
    });
  }
  if (phone) {
    const digits = phone.replace(/\D/g, '').slice(-10);
    query = query.where(function () {
      this.whereRaw("RIGHT(REPLACE(sms_log.from_phone, '+', ''), 10) = ?", [digits])
        .orWhereRaw("RIGHT(REPLACE(sms_log.to_phone, '+', ''), 10) = ?", [digits]);
    });
  }

  const messages = await query.limit(limit);

  return {
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

  const [byDirection, byType, byDay] = await Promise.all([
    db('sms_log').where('created_at', '>=', since)
      .select('direction', db.raw('COUNT(*) as count'))
      .groupBy('direction'),
    db('sms_log').where('created_at', '>=', since)
      .select('message_type', db.raw('COUNT(*) as count'))
      .groupBy('message_type').orderByRaw('COUNT(*) DESC'),
    db('sms_log').where('created_at', '>=', since)
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


async function getCallLog(input) {
  const { direction, has_recording, has_transcript, customer_name, days_back = 7, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 50);
  const since = new Date(Date.now() - days_back * 86400000).toISOString();

  let query = db('call_log')
    .where('call_log.created_at', '>=', since)
    .leftJoin('customers', 'call_log.customer_id', 'customers.id')
    .select(
      'call_log.*',
      'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
    )
    .orderBy('call_log.created_at', 'desc');

  if (direction && direction !== 'all') query = query.where('call_log.direction', direction);
  if (has_recording) query = query.whereNotNull('call_log.recording_url').where('call_log.recording_url', '!=', '');
  if (has_transcript) query = query.whereNotNull('call_log.transcript');
  if (customer_name) {
    query = query.where(function () {
      this.whereILike('customers.first_name', `%${customer_name}%`)
        .orWhereILike('customers.last_name', `%${customer_name}%`);
    });
  }

  const calls = await query.limit(limit);

  return {
    calls: calls.filter(c => !isAdminPhone(c.from_phone) || !isAdminPhone(c.to_phone)).map(c => ({
      id: c.id,
      direction: c.direction,
      from: c.from_phone,
      to: c.to_phone,
      customer: c.first_name ? `${c.first_name} ${c.last_name}` : null,
      tier: c.waveguard_tier,
      status: c.status,
      duration_seconds: c.duration_seconds,
      has_recording: !!(c.recording_url),
      has_transcript: !!(c.transcript),
      transcript_excerpt: c.transcript ? c.transcript.substring(0, 200) + '...' : null,
      sentiment: c.sentiment,
      time: c.created_at,
    })),
    total: calls.length,
  };
}


// Map the legacy message_type strings used by Comms manual sends to the
// customer-message-middleware purpose enum. Anything not explicitly
// mapped defaults to 'conversational'.
function mapCommsMessageTypeToPurpose(messageType) {
  switch (messageType) {
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

  if (!phone) {
    const customer = await resolveCustomer(input);
    if (!customer) return { error: 'Customer not found' };
    phone = customer.phone;
    customerName = `${customer.first_name} ${customer.last_name}`;
    custId = customer.id;
  }

  if (!phone) return { error: 'No phone number' };

  // Routed through the customer-message middleware. This is Virginia's
  // daily-driver send path, so the validators apply consistently:
  // suppression list, sms_enabled, no customer-emoji, no price leak,
  // segment cap. Operator messages still need to follow the customer
  // voice rules — Virginia getting a wrapper-block telling her she
  // can't send "$199" is the wrapper doing its job (link to the portal
  // estimate instead).
  const { sendCustomerMessage } = require('../messaging/send-customer-message');
  const result = await sendCustomerMessage({
    to: phone,
    body: message,
    channel: 'sms',
    audience: 'customer',
    purpose: mapCommsMessageTypeToPurpose(message_type),
    customerId: custId || null,
    entryPoint: 'intelligence_bar_comms_send_sms',
    metadata: { adminUserId: 'intelligence_bar', original_message_type: message_type },
  });

  if (result.sent) {
    logger.info(`[intelligence-bar:comms] Sent SMS to ${phone}: ${message.substring(0, 50)}... (segs=${result.segmentCount})`);
    return {
      success: true,
      sent_to: phone,
      customer: customerName,
      message,
      char_count: message.length,
      segmentCount: result.segmentCount,
      encoding: result.encoding,
    };
  }
  // Surface the wrapper block to the IB so Virginia sees a clear reason
  // (e.g. "the customer is opted out", "the body has an emoji") instead
  // of a silent fail.
  return {
    success: false,
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
  if (!customer.phone) return { error: 'Customer has no phone number' };

  const digits = customer.phone.replace(/\D/g, '').slice(-10);

  // Get the last inbound message from this customer
  const lastInbound = await db('sms_log')
    .where('direction', 'inbound')
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

  const msg = await client.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Draft a short SMS reply (max 160 chars) for Waves Pest Control.

Customer: ${customer.first_name} ${customer.last_name} (${customer.waveguard_tier || 'Bronze'} tier)
Their message: "${lastInbound.message_body}"
${lastService ? `Last service: ${lastService.service_type} on ${lastService.service_date}` : ''}
${nextService ? `Next service: ${nextService.service_type} on ${nextService.scheduled_date}` : ''}
${input.context ? `Additional context: ${input.context}` : ''}

Keep it friendly, concise, and action-oriented. Sign as "— Waves Pest Control" only if there's room.
Return ONLY the SMS text, nothing else.`
    }],
  });

  const draft = msg.content[0]?.text || '';

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
    // Follow-up tasks
    tasks = await db('csr_follow_up_tasks')
      .where('status', 'pending')
      .leftJoin('customers', 'csr_follow_up_tasks.customer_id', 'customers.id')
      .select('csr_follow_up_tasks.*', 'customers.first_name', 'customers.last_name', 'customers.phone')
      .orderBy('csr_follow_up_tasks.due_date').limit(10);
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
      task: t.description,
      due: t.due_date,
      priority: t.priority,
    })),
    lost_lead_reasons: (leadQuality || []).map(r => ({
      reason: r.loss_reason, count: parseInt(r.count),
    })),
  };
}


async function getTodaysActivity() {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const since = todayStart.toISOString();

  const [smsIn, smsOut, calls, unanswered] = await Promise.all([
    db('sms_log').where('direction', 'inbound').where('created_at', '>=', since).count('* as c').first(),
    db('sms_log').where('direction', 'outbound').where('created_at', '>=', since).count('* as c').first(),
    db('call_log').where('created_at', '>=', since).select(
      db.raw('COUNT(*) as total'),
      db.raw("COUNT(*) FILTER (WHERE direction = 'inbound') as inbound"),
      db.raw("COUNT(*) FILTER (WHERE status = 'no-answer' OR status = 'busy') as missed"),
    ).first(),
    // Count unanswered inbound messages from today
    db('sms_log').where('direction', 'inbound').where('created_at', '>=', since)
      .whereNotExists(function () {
        this.select(db.raw(1)).from(db.raw('sms_log as reply'))
          .whereRaw('reply.direction = ?', ['outbound'])
          .whereRaw('reply.created_at > sms_log.created_at')
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


module.exports = { COMMS_TOOLS, executeCommsTool };
