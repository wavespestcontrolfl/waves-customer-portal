const db = require('../../models/db');
const gmailClient = require('./gmail-client');
const logger = require('../logger');
const { isBlocked } = require('./spam-blocker');

async function syncEmails() {
  const connected = await gmailClient.isConnected();
  if (!connected) return { newEmails: 0, error: 'Gmail not connected' };

  const state = await db('email_sync_state').first();

  if (state?.last_history_id) {
    return incrementalSync(state);
  } else {
    return fullSync(state);
  }
}

async function fullSync(state) {
  logger.info('[email-sync] Starting full sync (first run)');
  let newEmails = 0;
  let lastHistoryId = null;

  try {
    const messages = await gmailClient.listMessages('', 200);
    logger.info(`[email-sync] Full sync: fetching ${messages.length} messages`);

    for (const msg of messages) {
      try {
        const parsed = await gmailClient.getMessage(msg.id);
        const inserted = await upsertEmail(parsed);
        if (inserted) newEmails++;
        if (parsed.historyId) lastHistoryId = parsed.historyId;
      } catch (err) {
        logger.warn(`[email-sync] Failed to fetch message ${msg.id}: ${err.message}`);
      }
    }

    await db('email_sync_state').where('id', state.id).update({
      last_history_id: lastHistoryId,
      last_sync_at: new Date(),
      emails_synced: (state.emails_synced || 0) + newEmails,
      errors: null,
    });

    logger.info(`[email-sync] Full sync complete: ${newEmails} emails stored`);
    return { newEmails, fullSync: true };
  } catch (err) {
    logger.error(`[email-sync] Full sync failed: ${err.message}`);
    await db('email_sync_state').where('id', state.id).update({
      errors: err.message,
      last_sync_at: new Date(),
    });
    return { newEmails: 0, error: err.message };
  }
}

async function incrementalSync(state) {
  let newEmails = 0;
  let latestHistoryId = state.last_history_id;

  try {
    const history = await gmailClient.getHistory(state.last_history_id);

    if (!history.history) {
      // No new changes
      await db('email_sync_state').where('id', state.id).update({
        last_sync_at: new Date(),
        errors: null,
      });
      return { newEmails: 0 };
    }

    const messageIds = new Set();
    for (const entry of history.history) {
      if (entry.messagesAdded) {
        for (const m of entry.messagesAdded) {
          messageIds.add(m.message.id);
        }
      }
      // Also handle label changes (read/unread/starred)
      if (entry.labelsAdded || entry.labelsRemoved) {
        const msgs = [...(entry.labelsAdded || []), ...(entry.labelsRemoved || [])];
        for (const m of msgs) {
          if (m.message?.id) messageIds.add(m.message.id);
        }
      }
    }

    if (history.historyId) latestHistoryId = history.historyId;

    for (const msgId of messageIds) {
      try {
        const parsed = await gmailClient.getMessage(msgId);
        const inserted = await upsertEmail(parsed);
        if (inserted) newEmails++;
        if (parsed.historyId && parsed.historyId > latestHistoryId) {
          latestHistoryId = parsed.historyId;
        }
      } catch (err) {
        logger.warn(`[email-sync] Failed to fetch message ${msgId}: ${err.message}`);
      }
    }

    await db('email_sync_state').where('id', state.id).update({
      last_history_id: latestHistoryId,
      last_sync_at: new Date(),
      emails_synced: (state.emails_synced || 0) + newEmails,
      errors: null,
    });

    if (newEmails > 0) {
      logger.info(`[email-sync] Incremental sync: ${newEmails} new, ${messageIds.size} checked`);
    }
    return { newEmails };
  } catch (err) {
    // If historyId is expired, do a full re-sync
    if (err.message?.includes('historyId') || err.code === 404) {
      logger.warn('[email-sync] History ID expired, resetting for full sync');
      await db('email_sync_state').where('id', state.id).update({
        last_history_id: null,
        errors: 'History expired, will full sync next run',
      });
      return { newEmails: 0, error: 'History expired, will resync' };
    }
    logger.error(`[email-sync] Incremental sync failed: ${err.message}`);
    await db('email_sync_state').where('id', state.id).update({
      errors: err.message,
      last_sync_at: new Date(),
    });
    return { newEmails: 0, error: err.message };
  }
}

async function upsertEmail(parsed) {
  const existing = await db('emails').where('gmail_id', parsed.gmail_id).first();

  // Match sender to customer
  let customerId = null;
  if (parsed.from_address) {
    const customer = await db('customers')
      .where('email', parsed.from_address)
      .first();
    if (customer) customerId = customer.id;
  }

  // Check vendor domain
  const domain = parsed.from_address?.split('@')[1]?.toLowerCase();
  let vendorMatch = null;
  if (domain) {
    vendorMatch = await db('vendor_email_domains')
      .where('domain', domain)
      .first();
  }

  const emailData = {
    gmail_id: parsed.gmail_id,
    gmail_thread_id: parsed.gmail_thread_id,
    from_address: parsed.from_address,
    from_name: parsed.from_name,
    to_address: parsed.to_address,
    subject: parsed.subject,
    body_text: parsed.body_text,
    body_html: parsed.body_html,
    snippet: parsed.snippet,
    has_attachments: parsed.has_attachments,
    label_ids: JSON.stringify(parsed.label_ids),
    received_at: parsed.received_at,
    is_read: parsed.is_read,
    is_starred: parsed.is_starred,
    customer_id: customerId,
    classification: vendorMatch ? 'vendor' : null,
    extracted_data: vendorMatch ? JSON.stringify({
      vendor_name: vendorMatch.vendor_name,
      vendor_domain: vendorMatch.domain,
      expense_category: vendorMatch.expense_category,
      primary_contact: vendorMatch.primary_contact,
    }) : null,
    updated_at: new Date(),
  };

  if (existing) {
    // Update read/starred/label status
    await db('emails').where('id', existing.id).update({
      is_read: parsed.is_read,
      is_starred: parsed.is_starred,
      label_ids: JSON.stringify(parsed.label_ids),
      updated_at: new Date(),
    });
    return false; // not new
  }

  // Check blocklist before inserting — skip blocked senders
  if (await isBlocked(parsed.from_address)) {
    // Auto-trash without wasting a Sonnet call
    try { await gmailClient.trashMessage(parsed.gmail_id); } catch (e) { /* non-critical */ }
    emailData.is_archived = true;
    emailData.classification = 'spam';
    emailData.auto_action = 'blocked_sender_trashed';
    await db('emails').insert(emailData);
    return true; // counted as new but auto-handled
  }

  const [email] = await db('emails').insert(emailData).returning('*');

  // Store list_unsubscribe for auto-unsubscribe
  if (parsed.list_unsubscribe) {
    await db('emails').where('id', email.id).update({
      extracted_data: JSON.stringify({
        ...((email.extracted_data && typeof email.extracted_data === 'string') ? JSON.parse(email.extracted_data) : (email.extracted_data || {})),
        list_unsubscribe: parsed.list_unsubscribe,
      }),
    });
    email.list_unsubscribe = parsed.list_unsubscribe;
  }

  // Store attachment metadata
  if (parsed.attachments?.length > 0) {
    for (const att of parsed.attachments) {
      await db('email_attachments').insert({
        email_id: email.id,
        gmail_attachment_id: att.gmail_attachment_id,
        filename: att.filename,
        mime_type: att.mime_type,
        size_bytes: att.size_bytes,
      });
    }
  }

  // Classify in background (don't block sync)
  if (!email.classification || email.classification === 'vendor') {
    setImmediate(async () => {
      try {
        const { classifyEmail } = require('./email-classifier');
        await classifyEmail(email);
      } catch (err) {
        logger.error(`[email-sync] Classification failed for ${email.id}: ${err.message}`);
      }
    });
  }

  return true; // new email
}

module.exports = { syncEmails };
