/**
 * Email Intelligence Bar Tools
 * server/services/intelligence-bar/email-tools.js
 *
 * 10 tools for managing the Gmail inbox via the Intelligence Bar.
 * AI reply drafting, email-to-SMS bridge, vendor invoice queries, spam management.
 */

const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const EMAIL_TOOLS = [
  {
    name: 'get_inbox_summary',
    description: `Get today's email summary: total received, breakdown by category, auto-actions taken, unread count, urgent items.
Use for: "what came in today?", "morning inbox briefing", "any urgent emails?", "email summary"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look back N days (default 1 = today)' },
      },
    },
  },
  {
    name: 'search_emails',
    description: `Search emails by sender, subject, body content, category, or date range.
Use for: "find the SiteOne invoice from last week", "emails from Henderson", "show me all lead inquiries this month", "any emails about termite"`,
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search in subject, body, sender name' },
        from: { type: 'string', description: 'Sender email or name' },
        category: { type: 'string', enum: ['lead_inquiry', 'customer_request', 'complaint', 'vendor_invoice', 'vendor_communication', 'scheduling', 'review_notification', 'regulatory', 'other'] },
        days_back: { type: 'number', description: 'Only search last N days (default 30)' },
        has_attachment: { type: 'boolean' },
        is_unread: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_email_thread',
    description: `Get a full email conversation thread. Shows all messages in order with bodies.
Use for: "show me the conversation with Henderson", "pull up that SiteOne thread", "what did we say to the customer who asked about lawn care?"`,
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Gmail thread ID' },
        from_name: { type: 'string', description: 'Find thread by sender name' },
        from_email: { type: 'string', description: 'Find thread by sender email' },
        subject_search: { type: 'string', description: 'Find thread by subject keywords' },
      },
    },
  },
  {
    name: 'draft_email_reply',
    description: `Generate an AI-drafted reply to an email. Returns a draft for approval — does NOT send automatically. Uses conversation context, customer history, and Waves brand voice.
Use for: "draft a reply to Henderson", "write a response to the customer asking about rescheduling", "reply to the SiteOne email about the order"`,
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'Specific email to reply to' },
        thread_id: { type: 'string', description: 'Reply to latest in thread' },
        from_name: { type: 'string', description: 'Find email by sender name' },
        instructions: { type: 'string', description: 'What to say or any special instructions (e.g. "tell them we can reschedule to Thursday")' },
      },
    },
  },
  {
    name: 'send_email_reply',
    description: `Send an email reply. ALWAYS show the draft and get confirmation before sending.
Use for: "send it", "send that reply", "yes, send the draft"`,
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'Email to reply to' },
        body: { type: 'string', description: 'Reply body text' },
      },
      required: ['email_id', 'body'],
    },
  },
  {
    name: 'reply_via_sms',
    description: `Instead of replying by email, send an SMS to the customer. Useful for scheduling questions, confirmations, and time-sensitive items since customers respond faster to texts.
Use for: "reply to Henderson via text instead", "SMS them about their appointment", "text the customer who emailed about rescheduling"`,
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'Email this is in response to' },
        customer_name: { type: 'string' },
        message: { type: 'string', description: 'SMS body (keep under 160 chars)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'get_vendor_invoices',
    description: `List vendor invoices detected in email, with expense linkage status and amounts.
Use for: "show me vendor invoices this month", "any unreviewed invoices?", "how much did SiteOne bill us?"`,
    input_schema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'Filter by vendor name' },
        status: { type: 'string', enum: ['pending_review', 'reviewed', 'all'], description: 'Expense review status (default: all)' },
        days_back: { type: 'number' },
      },
    },
  },
  {
    name: 'get_email_stats',
    description: `Email volume and classification statistics over time: total volume, by category, lead conversion rate from email, response times.
Use for: "how many leads came from email this month?", "email volume trend", "are we getting more spam?"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback period (default 30)' },
      },
    },
  },
  {
    name: 'get_blocked_senders',
    description: `List blocked email senders/domains with block counts.
Use for: "what domains are blocked?", "how many spam senders have we blocked?", "show me the blocklist"`,
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'block_sender',
    description: `Manually block an email sender or entire domain. Creates a Gmail filter to auto-trash future emails.
Use for: "block everything from spamsite.com", "block that sender"`,
    input_schema: {
      type: 'object',
      properties: {
        email_address: { type: 'string' },
        domain: { type: 'string' },
      },
    },
  },
];


// ─── Tool implementations ────────────────────────────────────────

async function getInboxSummary({ days = 1 }) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const emails = await db('emails').where('received_at', '>=', since);

    const byCategory = {};
    const autoActions = { spam_blocked: 0, newsletter_unsubscribed: 0, lead_created: 0, expense_created: 0 };
    const urgent = [];

    emails.forEach(e => {
      const cat = e.classification || 'unclassified';
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      if (e.auto_action) {
        const actions = e.auto_action.split(',').filter(Boolean);
        actions.forEach(a => {
          if (a.includes('spam') || a.includes('blocked')) autoActions.spam_blocked++;
          if (a.includes('unsubscrib')) autoActions.newsletter_unsubscribed++;
          if (a.includes('lead_created')) autoActions.lead_created++;
          if (a.includes('expense_created')) autoActions.expense_created++;
        });
      }

      if (e.classification === 'complaint' || (e.extracted_data && typeof e.extracted_data === 'object' && e.extracted_data.urgency === 'high')) {
        urgent.push({ from: e.from_name || e.from_address, subject: e.subject, category: e.classification });
      }
    });

    const unread = emails.filter(e => !e.is_read && !e.is_archived).length;
    const needsAttention = emails.filter(e => !e.is_read && !e.is_archived && !['spam', 'marketing_newsletter'].includes(e.classification)).length;

    return {
      period: days === 1 ? 'today' : `last ${days} days`,
      total_received: emails.length,
      unread,
      needs_attention: needsAttention,
      by_category: byCategory,
      auto_actions: autoActions,
      urgent: urgent.slice(0, 5),
    };
  } catch (err) {
    logger.error('[intelligence-bar:email] get_inbox_summary failed:', err);
    return { error: err.message };
  }
}

async function searchEmails({ search, from, category, days_back = 30, has_attachment, is_unread, limit = 20 }) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days_back);

    let query = db('emails')
      .where('received_at', '>=', since)
      .orderBy('received_at', 'desc')
      .limit(Math.min(limit, 50));

    if (search) {
      query = query.where(function () {
        this.whereILike('subject', `%${search}%`)
          .orWhereILike('from_name', `%${search}%`)
          .orWhereILike('snippet', `%${search}%`)
          .orWhereILike('body_text', `%${search}%`);
      });
    }
    if (from) {
      query = query.where(function () {
        this.whereILike('from_name', `%${from}%`)
          .orWhereILike('from_address', `%${from}%`);
      });
    }
    if (category) query = query.where('classification', category);
    if (has_attachment) query = query.where('has_attachments', true);
    if (is_unread) query = query.where('is_read', false);

    const results = await query.select(
      'id', 'gmail_id', 'gmail_thread_id', 'from_address', 'from_name',
      'subject', 'snippet', 'received_at', 'is_read', 'is_starred',
      'classification', 'has_attachments', 'customer_id', 'auto_action'
    );

    return { results, total: results.length };
  } catch (err) {
    logger.error('[intelligence-bar:email] search_emails failed:', err);
    return { error: err.message };
  }
}

async function getEmailThread({ thread_id, from_name, from_email, subject_search }) {
  try {
    let threadId = thread_id;

    // Find thread by sender or subject
    if (!threadId) {
      let finder = db('emails').orderBy('received_at', 'desc');
      if (from_name) finder = finder.whereILike('from_name', `%${from_name}%`);
      if (from_email) finder = finder.whereILike('from_address', `%${from_email}%`);
      if (subject_search) finder = finder.whereILike('subject', `%${subject_search}%`);
      const match = await finder.first();
      if (!match) return { error: 'No matching email found' };
      threadId = match.gmail_thread_id;
    }

    const messages = await db('emails')
      .where('gmail_thread_id', threadId)
      .orderBy('received_at', 'asc')
      .select('id', 'from_name', 'from_address', 'to_address', 'subject',
        'body_text', 'received_at', 'classification', 'has_attachments', 'customer_id');

    // Get attachments
    const emailIds = messages.map(m => m.id);
    const attachments = emailIds.length > 0
      ? await db('email_attachments').whereIn('email_id', emailIds).select('email_id', 'filename', 'mime_type', 'size_bytes')
      : [];

    const enriched = messages.map(m => ({
      ...m,
      body_text: (m.body_text || '').substring(0, 2000),
      attachments: attachments.filter(a => a.email_id === m.id),
    }));

    return { thread_id: threadId, message_count: messages.length, messages: enriched };
  } catch (err) {
    logger.error('[intelligence-bar:email] get_email_thread failed:', err);
    return { error: err.message };
  }
}

async function draftEmailReply(emailId, threadId, fromName, instructions) {
  try {
    // Find the email
    let email;
    if (emailId) {
      email = await db('emails').where('id', emailId).first();
    } else if (threadId) {
      email = await db('emails').where('gmail_thread_id', threadId).orderBy('received_at', 'desc').first();
    } else if (fromName) {
      email = await db('emails').whereILike('from_name', `%${fromName}%`).orderBy('received_at', 'desc').first();
    }
    if (!email) return { error: 'Email not found' };

    // Load thread context
    const thread = await db('emails')
      .where('gmail_thread_id', email.gmail_thread_id)
      .orderBy('received_at', 'asc')
      .select('from_name', 'from_address', 'subject', 'body_text', 'received_at');

    // Load customer context if matched
    let customerContext = '';
    if (email.customer_id) {
      const customer = await db('customers').where('id', email.customer_id).first();
      if (customer) {
        const lastService = await db('service_records')
          .where({ customer_id: customer.id, status: 'completed' })
          .orderBy('service_date', 'desc').first();
        const nextService = await db('scheduled_services')
          .where('customer_id', customer.id)
          .where('scheduled_date', '>=', new Date().toISOString().split('T')[0])
          .whereNotIn('status', ['cancelled'])
          .orderBy('scheduled_date').first();

        customerContext = `\nCUSTOMER CONTEXT:
Name: ${customer.first_name} ${customer.last_name}
Tier: ${customer.waveguard_tier || 'Bronze'}
${lastService ? `Last service: ${lastService.service_type} on ${lastService.service_date}` : ''}
${nextService ? `Next service: ${nextService.service_type} on ${nextService.scheduled_date}` : ''}
Address: ${customer.address_line1 || ''}, ${customer.city || ''}`;
      }
    }

    // Check if sender is a vendor
    const senderDomain = email.from_address.split('@')[1];
    const vendor = await db('vendor_email_domains').where('domain', senderDomain).first();
    let vendorContext = '';
    if (vendor) {
      vendorContext = `\nVENDOR: This is from ${vendor.vendor_name}${vendor.primary_contact ? ` (contact: ${vendor.primary_contact})` : ''}. Keep the tone professional and business-to-business.`;
    }

    const threadText = thread.map(t =>
      `FROM: ${t.from_name || t.from_address} (${new Date(t.received_at).toLocaleDateString()})\n${(t.body_text || '').substring(0, 1000)}`
    ).join('\n---\n');

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return { error: 'ANTHROPIC_API_KEY not configured for AI drafting' };
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Draft an email reply for Waves Pest Control & Lawn Care.

THREAD:
${threadText}
${customerContext}
${vendorContext}

${instructions ? `SPECIFIC INSTRUCTIONS: ${instructions}` : ''}

RULES:
- Professional but warm, small-business friendly
- Use "we" and "our" (Waves Pest Control voice)
- Keep it concise — 2-3 short paragraphs max
- If it's a scheduling/service question, be specific about next steps
- If it's a complaint, acknowledge and offer resolution
- If it's a vendor, keep it professional and direct
- Sign off: "Best,\\nThe Waves Pest Control Team"

Return ONLY the email body text, no subject line, no metadata.`
      }],
    });

    const draft = msg.content[0]?.text || '';

    return {
      draft: true,
      email_id: email.id,
      thread_id: email.gmail_thread_id,
      replying_to: email.from_name || email.from_address,
      subject: email.subject?.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      reply_draft: draft,
      note: 'This is a DRAFT. Say "send it" to deliver, or give instructions to revise.',
    };
  } catch (err) {
    logger.error('[intelligence-bar:email] draft_email_reply failed:', err);
    return { error: err.message };
  }
}

async function sendEmailReply({ email_id, body }) {
  try {
    const email = await db('emails').where('id', email_id).first();
    if (!email) return { error: 'Email not found' };

    const gmailClient = require('../../services/email/gmail-client');
    const result = await gmailClient.sendMessage(
      email.from_address,
      email.subject?.startsWith('Re:') ? email.subject : `Re: ${email.subject || '(no subject)'}`,
      body.replace(/\n/g, '<br>'),
      email.gmail_thread_id
    );

    logger.info(`[intelligence-bar:email] Sent reply to ${email.from_address}: ${result.id}`);

    return {
      success: true,
      sent_to: email.from_address,
      message_id: result.id,
      subject: email.subject,
    };
  } catch (err) {
    logger.error('[intelligence-bar:email] send_email_reply failed:', err);
    return { error: err.message };
  }
}

async function replyViaSms({ email_id, customer_name, message }) {
  try {
    let phone = null;
    let custName = customer_name;
    let custId = null;

    if (email_id) {
      const email = await db('emails').where('id', email_id).first();
      if (email?.customer_id) {
        const customer = await db('customers').where('id', email.customer_id).first();
        if (customer) {
          phone = customer.phone;
          custName = `${customer.first_name} ${customer.last_name}`;
          custId = customer.id;
        }
      }
      // Try matching by email address
      if (!phone && email) {
        const customer = await db('customers').where('email', email.from_address).first();
        if (customer) {
          phone = customer.phone;
          custName = `${customer.first_name} ${customer.last_name}`;
          custId = customer.id;
        }
      }
    } else if (customer_name) {
      const customer = await db('customers').where(function () {
        const s = `%${customer_name}%`;
        this.whereILike('first_name', s).orWhereILike('last_name', s);
      }).first();
      if (customer) {
        phone = customer.phone;
        custId = customer.id;
      }
    }

    if (!phone) return { error: 'Could not find phone number for this customer' };

    const TwilioService = require('../twilio');
    await TwilioService.sendSMS(phone, message, {
      customerId: custId, messageType: 'manual', adminUserId: 'intelligence_bar_email',
    });

    // Mark the email as responded via SMS
    if (email_id) {
      await db('emails').where('id', email_id).update({
        auto_action: db.raw("COALESCE(auto_action, '') || ',replied_via_sms'"),
        is_read: true,
        updated_at: new Date(),
      });
    }

    logger.info(`[intelligence-bar:email] SMS reply to ${custName} at ${phone}`);

    return {
      success: true,
      sent_to: phone,
      customer: custName,
      message,
      note: `SMS sent to ${custName} at ${phone} instead of email reply.`,
    };
  } catch (err) {
    logger.error('[intelligence-bar:email] reply_via_sms failed:', err);
    return { error: err.message };
  }
}

async function getVendorInvoices({ vendor, status, days_back = 30 }) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days_back);

    let query = db('emails')
      .where('classification', 'vendor_invoice')
      .where('received_at', '>=', since)
      .orderBy('received_at', 'desc');

    if (vendor) {
      query = query.where(function () {
        this.whereILike('from_name', `%${vendor}%`)
          .orWhereILike('from_address', `%${vendor}%`);
      });
    }

    const invoices = await query.select(
      'id', 'from_name', 'from_address', 'subject', 'received_at',
      'extracted_data', 'has_attachments', 'expense_id', 'auto_action'
    );

    // Enrich with expense data if linked
    const expenseIds = invoices.filter(i => i.expense_id).map(i => i.expense_id);
    const expenses = expenseIds.length > 0
      ? await db('expenses').whereIn('id', expenseIds)
      : [];

    const enriched = invoices.map(inv => {
      const expense = expenses.find(e => e.id === inv.expense_id);
      const extracted = inv.extracted_data
        ? (typeof inv.extracted_data === 'string' ? JSON.parse(inv.extracted_data) : inv.extracted_data)
        : {};

      return {
        email_id: inv.id,
        vendor: inv.from_name || extracted.vendor_name || 'Unknown',
        subject: inv.subject,
        date: inv.received_at,
        invoice_number: extracted.invoice_number,
        amount: extracted.invoice_amount || expense?.amount,
        has_pdf: inv.has_attachments,
        expense_logged: !!inv.expense_id,
        expense_status: expense?.status || (inv.expense_id ? 'linked' : 'not_linked'),
      };
    });

    const totalAmount = enriched.reduce((sum, inv) => sum + (parseFloat(inv.amount) || 0), 0);

    return { invoices: enriched, total: enriched.length, total_amount: totalAmount };
  } catch (err) {
    logger.error('[intelligence-bar:email] get_vendor_invoices failed:', err);
    return { error: err.message };
  }
}

async function getEmailStats({ days = 30 }) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const emails = await db('emails')
      .where('received_at', '>=', since)
      .select('classification', 'auto_action', 'is_read', 'received_at');

    const byCategory = {};
    let totalAutoActions = 0;
    let leadsFromEmail = 0;

    emails.forEach(e => {
      const cat = e.classification || 'unclassified';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      if (e.auto_action) totalAutoActions++;
      if (e.auto_action && e.auto_action.includes('lead_created')) leadsFromEmail++;
    });

    // Weekly breakdown
    const byWeek = {};
    emails.forEach(e => {
      const week = new Date(e.received_at).toISOString().split('T')[0].substring(0, 7);
      byWeek[week] = (byWeek[week] || 0) + 1;
    });

    // Blocked count
    const [blockedCount] = await db('blocked_email_senders').count('* as count');

    return {
      period: `last ${days} days`,
      total: emails.length,
      by_category: byCategory,
      auto_actions_taken: totalAutoActions,
      leads_from_email: leadsFromEmail,
      domains_blocked: parseInt(blockedCount.count),
      avg_per_day: Math.round(emails.length / days * 10) / 10,
      by_month: byWeek,
    };
  } catch (err) {
    logger.error('[intelligence-bar:email] get_email_stats failed:', err);
    return { error: err.message };
  }
}

async function getBlockedSenders({ limit = 50 }) {
  try {
    const blocked = await db('blocked_email_senders')
      .orderBy('blocked_count', 'desc')
      .limit(limit);

    return {
      blocked: blocked.map(b => ({
        id: b.id,
        domain: b.domain,
        email_address: b.email_address,
        reason: b.reason,
        blocked_count: b.blocked_count,
        created_at: b.created_at,
      })),
      total: blocked.length,
    };
  } catch (err) {
    logger.error('[intelligence-bar:email] get_blocked_senders failed:', err);
    return { error: err.message };
  }
}

async function blockSender({ email_address, domain }) {
  try {
    if (!email_address && !domain) return { error: 'email_address or domain required' };

    const blockDomain = domain || email_address.split('@')[1];
    const { blockSpamSender } = require('../../services/email/spam-blocker');

    // Build a minimal email object for the blocker
    await blockSpamSender({
      from_address: email_address || `spam@${blockDomain}`,
    });

    return {
      success: true,
      blocked_domain: blockDomain,
      note: `All future emails from @${blockDomain} will be auto-trashed.`,
    };
  } catch (err) {
    logger.error('[intelligence-bar:email] block_sender failed:', err);
    return { error: err.message };
  }
}


// ─── Tool execution router ───────────────────────────────────────

async function executeEmailTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_inbox_summary': return await getInboxSummary(input);
      case 'search_emails': return await searchEmails(input);
      case 'get_email_thread': return await getEmailThread(input);
      case 'draft_email_reply': return await draftEmailReply(input.email_id, input.thread_id, input.from_name, input.instructions);
      case 'send_email_reply': return await sendEmailReply(input);
      case 'reply_via_sms': return await replyViaSms(input);
      case 'get_vendor_invoices': return await getVendorInvoices(input);
      case 'get_email_stats': return await getEmailStats(input);
      case 'get_blocked_senders': return await getBlockedSenders(input);
      case 'block_sender': return await blockSender(input);
      default: return { error: `Unknown email tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:email] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { EMAIL_TOOLS, executeEmailTool, draftEmailReply };
