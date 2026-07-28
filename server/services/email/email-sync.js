const db = require('../../models/db');
const gmailClient = require('./gmail-client');
const logger = require('../logger');
const { isBlocked } = require('./spam-blocker');

// Prevent concurrent syncs from racing on email_sync_state counters.
let SYNC_IN_FLIGHT = null;

async function syncEmails() {
  if (SYNC_IN_FLIGHT) return SYNC_IN_FLIGHT;
  SYNC_IN_FLIGHT = (async () => {
    const connected = await gmailClient.isConnected();
    if (!connected) return { newEmails: 0, error: 'Gmail not connected' };

    const state = await db('email_sync_state').first();

    if (state?.last_history_id) {
      return incrementalSync(state);
    } else {
      return fullSync(state);
    }
  })().finally(() => { SYNC_IN_FLIGHT = null; });
  return SYNC_IN_FLIGHT;
}

async function fullSync(state) {
  logger.info('[email-sync] Starting full sync (first run)');
  let newEmails = 0;
  let lastHistoryId = null;

  try {
    // Anchor the incremental cursor at the CURRENT mailbox historyId,
    // captured BEFORE the scan. The message loop below ends on the OLDEST
    // message (Gmail lists newest-first), and storing that stale position
    // hands the next incremental run a backlog deep enough to re-trigger
    // the full-resync fallback — an endless full-download loop. Changes
    // landing DURING the scan replay through the first incremental run
    // (upserts are idempotent).
    const anchorHistoryId = await gmailClient.getProfileHistoryId().catch(() => null);
    const fullSyncLimit = process.env.GMAIL_FULL_SYNC_LIMIT
      ? Number.parseInt(process.env.GMAIL_FULL_SYNC_LIMIT, 10)
      : null;
    const messages = await gmailClient.listMessages('', Number.isFinite(fullSyncLimit) ? fullSyncLimit : null);
    logger.info(`[email-sync] Full sync: fetching ${messages.length} messages`);

    let failedMessages = 0;
    for (const msg of messages) {
      try {
        const parsed = await gmailClient.getMessage(msg.id);
        const inserted = await upsertEmail(parsed);
        if (inserted) newEmails++;
        if (parsed.historyId) lastHistoryId = parsed.historyId;
      } catch (err) {
        // 404 = deleted mid-scan (benign). Anything else means this message
        // is NOT stored, and it predates the pre-scan anchor — no future
        // incremental run would ever see it again.
        const gone = err.code === 404 || err.response?.status === 404;
        if (!gone) failedMessages += 1;
        logger.warn(`[email-sync] Failed to fetch message ${msg.id}: ${err.message}`);
      }
    }

    if (failedMessages > 0) {
      // Withhold the cursor so the next 2-minute run re-runs the full sync
      // (upserts are idempotent) — anchoring past a missed message would
      // drop it from the portal permanently.
      await db('email_sync_state').where('id', state.id).update({
        errors: `full sync incomplete: ${failedMessages} message(s) failed — retrying next run`,
        last_sync_at: new Date(),
      });
      if (newEmails > 0) {
        await db('email_sync_state').where('id', state.id).increment('emails_synced', newEmails);
      }
      logger.warn(`[email-sync] Full sync incomplete (${failedMessages} failure(s)) — cursor withheld for retry`);
      return { newEmails, fullSync: true, retry: true };
    }

    await db('email_sync_state').where('id', state.id).update({
      last_history_id: anchorHistoryId || lastHistoryId,
      last_sync_at: new Date(),
      errors: null,
    });
    if (newEmails > 0) {
      await db('email_sync_state').where('id', state.id).increment('emails_synced', newEmails);
    }

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
      if (entry.messagesDeleted) {
        for (const m of entry.messagesDeleted) {
          if (m.message?.id) messageIds.add(m.message.id);
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
        if (err.code === 404 || err.response?.status === 404) {
          await db('emails').where('gmail_id', msgId).update({
            is_archived: true,
            updated_at: new Date(),
          });
        } else {
          logger.warn(`[email-sync] Failed to fetch message ${msgId}: ${err.message}`);
        }
      }
    }

    await db('email_sync_state').where('id', state.id).update({
      last_history_id: latestHistoryId,
      last_sync_at: new Date(),
      errors: null,
    });
    if (newEmails > 0) {
      await db('email_sync_state').where('id', state.id).increment('emails_synced', newEmails);
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
    // parseMessage has always extracted List-Unsubscribe; persisting it is
    // what lets autoUnsubscribe's RFC 8058 one-click method actually fire.
    list_unsubscribe: parsed.list_unsubscribe || null,
    list_unsubscribe_post: parsed.list_unsubscribe_post || null,
    // Message-ID threads reply drafts into the source conversation.
    message_id: parsed.message_id || null,
    // Validated single-mailbox Reply-To — reply drafts prefer it over a
    // relay's no-reply From address.
    reply_to: parsed.reply_to || null,
    // Gmail's SPF/DKIM verdict — gates the spam-path unsubscribe and the
    // spam-folder rescue (spoof containment).
    authentication_results: parsed.authentication_results || null,
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
    const labelIds = parsed.label_ids || [];
    // Update read/starred/archive label status
    await db('emails').where('id', existing.id).update({
      is_read: parsed.is_read,
      is_starred: parsed.is_starred,
      is_archived: !labelIds.includes('INBOX') || labelIds.includes('TRASH'),
      label_ids: JSON.stringify(labelIds),
      // Backfill the header captures on resync — pre-migration rows would
      // otherwise fail the authentication gates closed forever and never
      // regain unsubscribe/threading capability.
      list_unsubscribe: parsed.list_unsubscribe || existing.list_unsubscribe || null,
      list_unsubscribe_post: parsed.list_unsubscribe_post || existing.list_unsubscribe_post || null,
      message_id: parsed.message_id || existing.message_id || null,
      reply_to: parsed.reply_to || existing.reply_to || null,
      authentication_results: parsed.authentication_results || existing.authentication_results || null,
      updated_at: new Date(),
    });
    return false; // not new
  }

  // Our own outbound — auto-drafts (GATE_EMAIL_AUTO_DRAFTS) and sent
  // replies — lands in Gmail history like any other message. Store it
  // archived so the thread record is complete, but NEVER classify it or
  // run inbound automation: a generated draft must not appear in the admin
  // inbox, burn a classifier call, or trigger handlers.
  {
    const outboundLabels = parsed.label_ids || [];
    // SENT+INBOX = self-addressed (e.g. an owner control message sent from
    // this mailbox to itself) — that IS inbound mail and stays classified.
    if (outboundLabels.includes('DRAFT')
      || (outboundLabels.includes('SENT') && !outboundLabels.includes('INBOX'))) {
      emailData.is_archived = true;
      emailData.auto_action = 'outbound_skipped';
      const outboundInsert = await db('emails').insert(emailData).onConflict('gmail_id').ignore().returning('id');
      return outboundInsert.length > 0;
    }
  }

  // Check blocklist before inserting — skip blocked senders
  if (await isBlocked(parsed.from_address, { gmailId: parsed.gmail_id })) {
    // Auto-trash without wasting a Sonnet call
    try { await gmailClient.trashMessage(parsed.gmail_id); } catch (e) { /* non-critical */ }
    emailData.is_archived = true;
    emailData.classification = 'spam';
    emailData.auto_action = 'blocked_sender_trashed';
    const blockedInsert = await db('emails').insert(emailData).onConflict('gmail_id').ignore().returning('id');
    return blockedInsert.length > 0; // true only if this sync actually inserted it (else a concurrent sync won)
  }

  const inserted = await db('emails').insert(emailData).onConflict('gmail_id').ignore().returning('*');
  if (!inserted.length) return false; // lost an insert race with a concurrent sync; already stored
  const [email] = inserted;

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

  // Newsletter proof-approval replies are deterministic control messages —
  // check them before AI classification. Gated + fail-closed inside the
  // handler; a throw here must never break the sync loop. When the handler
  // recognizes the email as proof traffic, skip classification entirely:
  // a control message must not burn a classifier call or risk an
  // auto-action archiving it.
  let proofHandled = false;
  try {
    const { maybeHandleProofApproval } = require('../newsletter-proof');
    proofHandled = await maybeHandleProofApproval(email);
  } catch (err) {
    logger.error(`[email-sync] Proof-approval check failed for ${email.id}: ${err?.message || err}`);
  }

  // Classify in background (don't block sync)
  if (!proofHandled && (!email.classification || email.classification === 'vendor')) {
    setImmediate(() => {
      (async () => {
        const { classifyEmail } = require('./email-classifier');
        await classifyEmail(email);
      })().catch((err) => {
        logger.error(`[email-sync] Classification failed for ${email.id}: ${err?.message || err}`);
      });
    });
  }

  return true; // new email
}

module.exports = { syncEmails };
