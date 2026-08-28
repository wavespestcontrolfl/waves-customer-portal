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
    // fullSync serves two cases: first connect (empty table → mailbox
    // HISTORY, never notify) and expired-history-cursor recovery (table
    // populated → genuinely new arrivals are among these, so the 24h age
    // guard decides, exactly as for an incremental sync) — hook P1.
    const initialConnect = !(await db('emails').first('id'));

    let failedMessages = 0;
    for (const msg of messages) {
      try {
        const parsed = await gmailClient.getMessage(msg.id);
        const inserted = await upsertEmail(parsed, { backfill: initialConnect });
        if (inserted) newEmails++;
      } catch (err) {
        // 404 = deleted mid-scan (benign). Anything else means this message
        // is NOT stored, and it predates the pre-scan anchor — no future
        // incremental run would ever see it again.
        const gone = err.code === 404 || err.response?.status === 404;
        if (!gone) failedMessages += 1;
        logger.warn(`[email-sync] Failed to fetch message ${msg.id}: ${err.message}`);
      }
    }

    if (failedMessages > 0 || !anchorHistoryId) {
      // Withhold the cursor so the next 2-minute run re-runs the full sync
      // (upserts are idempotent). Anchoring past a missed message would
      // drop it from the portal permanently — and there is NO safe fallback
      // anchor when getProfile failed: the last iterated message is the
      // OLDEST one, and a cursor that old re-triggers the expired-history
      // full resync in a loop.
      const why = failedMessages > 0
        ? `${failedMessages} message(s) failed`
        : 'no current history anchor (getProfile failed)';
      await db('email_sync_state').where('id', state.id).update({
        errors: `full sync incomplete: ${why} — retrying next run`,
        last_sync_at: new Date(),
      });
      if (newEmails > 0) {
        await db('email_sync_state').where('id', state.id).increment('emails_synced', newEmails);
      }
      logger.warn(`[email-sync] Full sync incomplete (${why}) — cursor withheld for retry`);
      return { newEmails, fullSync: true, retry: true };
    }

    await db('email_sync_state').where('id', state.id).update({
      last_history_id: anchorHistoryId,
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

async function upsertEmail(parsed, { backfill = false } = {}) {
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
    // Crash-recovery: a row inserted by a sync that died before its bell
    // fired is re-seen here. Ring at most once (idempotent on emailId).
    await recoverLostCustomerEmailBell(existing, { customerId, parsed, backfill }).catch(() => {});
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

  // Approval-control replies ([EA-…] subjects) are exempt from blocklist
  // trashing — a blocklisted-but-allowlisted approver's decision must
  // never be removed from INBOX before the approval poller reads it
  // (Codex #3024 r7). The poller's own sender allowlist + DMARC check
  // remain the authorization gate.
  let approvalControlEarly = false;
  try {
    const { isApprovalControlMessage } = require('../content/email-approvals');
    approvalControlEarly = await isApprovalControlMessage({ subject: parsed.subject, from_address: parsed.from_address });
  } catch { /* module unavailable — fall through to normal handling */ }

  // Check blocklist before inserting — skip blocked senders
  if (!approvalControlEarly && await isBlocked(parsed.from_address, { gmailId: parsed.gmail_id })) {
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
  // A new inbound email from someone on the customer list rings the admin
  // bell like a text does (owner ruling 2026-08-28) — but only AFTER the
  // async classifier has had its say (spam / marketing_newsletter arrive
  // later than the insert), so the bell fires from inside that path below.
  const bellCandidate = customerEmailBellEligible({
    customerId,
    classification: emailData.classification,
    listUnsubscribe: parsed.list_unsubscribe,
    labelIds: parsed.label_ids,
    authenticationResults: parsed.authentication_results,
    fromAddress: parsed.from_address,
    receivedAt: parsed.received_at,
    backfill,
  });
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

  // Content-approval replies ([EA-xxxxxxxx] subjects) are control messages
  // too: the IMAP poller owns the decision — they must never burn a
  // classifier call or risk an auto-action archiving/answering them. The
  // EARLY verdict (computed before the blocklist branch) is reused so a
  // decision the poller executed between the two points can't flip this
  // to false (Codex r10).
  const approvalControl = approvalControlEarly;

  // Classify in background (don't block sync)
  if (!proofHandled && !approvalControl && (!email.classification || email.classification === 'vendor')) {
    // Awaited (was setImmediate): the sync cursor must not advance past a
    // message whose classification + bell have not happened — a process
    // exit in that window would leave a row future syncs treat as existing,
    // silently losing the bell (hook P1). The existing-row path below
    // re-checks a never-notified candidate for the same reason.
    const { classifyEmail } = require('./email-classifier');
    let classified = false;
    try {
      await classifyEmail(email);
      classified = true;
    } catch (err) {
      logger.error(`[email-sync] Classification failed for ${email.id}: ${err?.message || err}`);
    }
    if (bellCandidate) await ringCustomerEmailBell(email, { customerId, parsed, classified });
  }

  return true; // new email
}

/**
 * A row that exists but was never notified (sync died between insert and
 * bell): if it is still an eligible candidate and no bell carries its id,
 * ring now. Idempotent — the bell payload stores emailId.
 */
async function recoverLostCustomerEmailBell(existing, { customerId, parsed, backfill }) {
  if (!customerEmailBellEligible({
    customerId: existing.customer_id || customerId,
    classification: existing.classification,
    listUnsubscribe: existing.list_unsubscribe,
    labelIds: parsed.label_ids,
    authenticationResults: existing.authentication_results,
    fromAddress: existing.from_address,
    receivedAt: existing.received_at,
    backfill,
  })) return;
  if (existing.is_archived) return;
  const already = await db('notifications')
    .where({ category: 'inbound_email' })
    .whereRaw("metadata->'payload'->>'emailId' = ?", [String(existing.id)])
    .first('id');
  if (already) return;
  await ringCustomerEmailBell(existing, { customerId: existing.customer_id || customerId, parsed, classified: Boolean(existing.classification) });
}

// Bulk/spam classes the classifier may assign after insert — never ring.
const NEVER_RING_CLASSES = new Set(['spam', 'marketing_newsletter', 'vendor']);

/**
 * Fire the bell for an already-eligible candidate once classification is
 * known. Reads the row back (the classifier writes there). Fallback policy
 * when the classifier FAILED: ring — the sender already passed DMARC
 * alignment and matches a customer, and a missed customer email costs more
 * than a rare unwanted bell. An archived row (auto-trashed / bulk) never
 * rings. Fail-soft: the bell can never fail the sync.
 */
async function ringCustomerEmailBell(email, { customerId, parsed, classified }) {
  try {
    const row = await db('emails').where('id', email.id).first('classification', 'is_archived');
    if (!row || row.is_archived) return;
    if (classified && row.classification && NEVER_RING_CLASSES.has(row.classification)) return;
    const { triggerNotification } = require('../notification-triggers');
    await triggerNotification('customer_email_received', {
      fromName: parsed.from_name || parsed.from_address,
      subject: parsed.subject,
      emailId: email.id,
      customerId,
    });
  } catch (e) { logger.warn(`[email-sync] customer_email_received bell failed: ${e.message}`); }
}

/**
 * Should a new inbound email ring the "email from a customer" bell?
 * Pure. From is attacker-controlled, so an exact address match is not proof
 * the customer sent it: the sender must pass DMARC-style alignment
 * (inbox-hygiene.hasAlignedAuth — the same gate auto-unsubscribe trusts).
 * Vendor/spam/bulk mail (classification set, or a List-Unsubscribe header)
 * and anything not in INBOX never ring.
 */
const CUSTOMER_EMAIL_BELL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function customerEmailBellEligible({ customerId, classification, listUnsubscribe, labelIds, authenticationResults, fromAddress, receivedAt, backfill = false, now = Date.now() } = {}) {
  // A fullSync (first Gmail connect / empty table) is history, whatever its
  // timestamps say — it never notifies (hook P1). The 24h guard below is the
  // second line for incremental syncs that replay old messages.
  if (backfill) return false;
  if (!customerId || classification || listUnsubscribe) return false;
  if (!(labelIds || []).includes('INBOX')) return false;
  // Only NEW arrivals ring: a full mailbox backfill (first connect, empty
  // table) inserts history and must never bell/push for it (hook P1).
  const ts = receivedAt ? new Date(receivedAt).getTime() : NaN;
  if (!Number.isFinite(ts) || now - ts > CUSTOMER_EMAIL_BELL_MAX_AGE_MS) return false;
  const { hasAlignedAuth } = require('./inbox-hygiene');
  const { domainFromAddress } = require('./spam-blocker');
  return hasAlignedAuth(authenticationResults, domainFromAddress(fromAddress));
}

module.exports = { syncEmails, customerEmailBellEligible };
