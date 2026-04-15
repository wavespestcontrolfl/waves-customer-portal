const db = require('../../models/db');
const gmailClient = require('./gmail-client');
const logger = require('../logger');

async function executeAutoAction(email, classification) {
  try {
    switch (classification.category) {
      case 'spam':
        await handleSpam(email);
        break;
      case 'marketing_newsletter':
        await handleNewsletter(email);
        break;
      case 'lead_inquiry':
        await handleLeadInquiry(email, classification);
        break;
      case 'customer_request':
      case 'scheduling':
        await handleCustomerRequest(email, classification);
        break;
      case 'complaint':
        await handleComplaint(email, classification);
        break;
      case 'vendor_invoice':
        await handleVendorInvoice(email, classification);
        break;
      case 'vendor_communication':
        await handleVendorComm(email);
        break;
      default:
        // No auto-action for other categories
        break;
    }
  } catch (err) {
    logger.error(`[email-actions] Auto-action failed for ${email.id} (${classification.category}): ${err.message}`);
  }
}

async function handleSpam(email) {
  // 1. Trash in Gmail
  try { await gmailClient.trashMessage(email.gmail_id); } catch (e) { /* non-critical */ }

  // 2. Block future emails from this sender
  const { blockSpamSender } = require('./spam-blocker');
  await blockSpamSender(email);

  // 3. Mark in DB
  await db('emails').where({ id: email.id }).update({
    is_archived: true,
    auto_action: 'spam_blocked',
    updated_at: new Date(),
  });
  logger.info(`[email-actions] Spam blocked: "${email.subject}" from ${email.from_address}`);
}

async function handleNewsletter(email) {
  // 1. Archive in Gmail
  try { await gmailClient.archiveMessage(email.gmail_id); } catch (e) { /* non-critical */ }

  // 2. Try to unsubscribe
  let unsubMethod = 'none';
  try {
    const { autoUnsubscribe } = require('./auto-unsubscribe');
    const result = await autoUnsubscribe(email);
    unsubMethod = result.method;
  } catch (e) {
    logger.warn(`[email-actions] Unsubscribe failed for ${email.from_address}: ${e.message}`);
  }

  // 3. Mark in DB
  await db('emails').where({ id: email.id }).update({
    is_archived: true,
    auto_action: unsubMethod !== 'none' ? `newsletter_unsubscribed:${unsubMethod}` : 'newsletter_archived',
    updated_at: new Date(),
  });
}

async function handleLeadInquiry(email, classification) {
  const extracted = classification.extracted || {};

  // Check if lead already exists
  let existingLead = null;
  if (extracted.email || extracted.phone) {
    existingLead = await db('leads')
      .where(function () {
        let first = true;
        if (extracted.email) {
          first ? this.where('email', extracted.email) : this.orWhere('email', extracted.email);
          first = false;
        }
        if (extracted.phone) {
          first ? this.where('phone', extracted.phone) : this.orWhere('phone', extracted.phone);
          first = false;
        }
      })
      .whereNotIn('status', ['won', 'lost'])
      .first();
  }
  if (!existingLead && email.from_address) {
    existingLead = await db('leads').where('email', email.from_address)
      .whereNotIn('status', ['won', 'lost']).first();
  }

  if (!existingLead) {
    const nameParts = (extracted.person_name || email.from_name || '').split(' ');
    const firstName = nameParts[0] || 'Unknown';
    const lastName = nameParts.slice(1).join(' ') || '';

    const [lead] = await db('leads').insert({
      first_name: firstName,
      last_name: lastName,
      email: extracted.email || email.from_address,
      phone: extracted.phone || null,
      address: extracted.address || null,
      service_interest: extracted.service_interest || 'General inquiry',
      lead_type: 'email_inquiry',
      status: 'new',
      first_contact_at: email.received_at,
      first_contact_channel: 'email',
    }).returning('*');

    await db('emails').where({ id: email.id }).update({
      lead_id: lead.id,
      auto_action: 'lead_created',
      updated_at: new Date(),
    });

    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'created',
      description: `Lead auto-created from email: "${email.subject}"`,
      performed_by: 'Email Classifier',
    });

    // Notification
    try {
      await db('notifications').insert({
        recipient_type: 'admin',
        category: 'new_lead',
        title: `New lead from email: ${firstName} ${lastName}`,
        body: classification.summary || email.subject,
        icon: '\uD83D\uDCE7',
        link: '/admin/email',
        metadata: JSON.stringify({ emailId: email.id, leadId: lead.id }),
      });
    } catch (e) { /* non-critical */ }

    logger.info(`[email-actions] Lead created: ${firstName} ${lastName} — ${extracted.service_interest || 'general'}`);
  } else {
    await db('emails').where({ id: email.id }).update({
      lead_id: existingLead.id,
      auto_action: 'linked_to_existing_lead',
      updated_at: new Date(),
    });
  }
}

async function handleCustomerRequest(email, classification) {
  let customer = await db('customers').where('email', email.from_address).first();

  if (!customer && email.from_name) {
    const parts = email.from_name.split(' ');
    if (parts.length >= 2) {
      customer = await db('customers').where(function () {
        this.whereILike('first_name', `%${parts[0]}%`)
          .andWhereILike('last_name', `%${parts[parts.length - 1]}%`);
      }).first();
    }
  }

  if (customer) {
    await db('emails').where({ id: email.id }).update({
      customer_id: customer.id,
      auto_action: 'matched_to_customer',
      updated_at: new Date(),
    });
  }
}

async function handleComplaint(email, classification) {
  // Match customer
  let customer = await db('customers').where('email', email.from_address).first();
  if (!customer && email.from_name) {
    const parts = email.from_name.split(' ');
    if (parts.length >= 2) {
      customer = await db('customers').where(function () {
        this.whereILike('first_name', `%${parts[0]}%`)
          .andWhereILike('last_name', `%${parts[parts.length - 1]}%`);
      }).first();
    }
  }

  await db('emails').where({ id: email.id }).update({
    customer_id: customer?.id || null,
    is_starred: true,
    auto_action: 'complaint_flagged',
    updated_at: new Date(),
  });

  try { await gmailClient.modifyLabels(email.gmail_id, ['STARRED'], []); } catch (e) { /* non-critical */ }

  // Urgent notification
  try {
    await db('notifications').insert({
      recipient_type: 'admin',
      category: 'email_alert',
      title: `Complaint from ${email.from_name || email.from_address}`,
      body: classification.summary || email.subject,
      icon: '\u26A0\uFE0F',
      link: '/admin/email',
      metadata: JSON.stringify({ emailId: email.id, customerId: customer?.id }),
    });
  } catch (e) { /* non-critical */ }

  logger.warn(`[email-actions] COMPLAINT: ${email.from_address} — "${email.subject}"`);
}

async function handleVendorInvoice(email, classification) {
  const { processVendorInvoice } = require('./invoice-processor');
  await processVendorInvoice(email, classification);
}

async function handleVendorComm(email) {
  const domain = email.from_address?.split('@')[1];
  const vendor = domain ? await db('vendor_email_domains').where('domain', domain).first() : null;
  await db('emails').where({ id: email.id }).update({
    auto_action: vendor ? `vendor_tagged:${vendor.vendor_name}` : 'vendor_unmatched',
    updated_at: new Date(),
  });
}

module.exports = { executeAutoAction };
