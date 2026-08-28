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

    // Durable retry for the customer-email bell: Gmail never re-emits a
    // message, so a claim released by a transient delivery failure would be
    // lost forever without this — every run re-offers unclaimed eligible
    // rows (idempotent via the atomic claim) (hook P1).
    await sweepUnclaimedCustomerEmailBells().catch((err) => logger.warn(`[email-sync] bell sweep failed: ${err.message}`));

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
    // First connect: persist the scan boundary ONCE, before the remote
    // listing begins, and reuse it on every retry — mail received after it
    // (during the listing, or between a failed pass and its retry) is new
    // and takes the normal path (codex P1).
    const initialConnect = !state?.initial_sync_completed_at;
    let scanBoundary = state?.initial_scan_started_at ? new Date(state.initial_scan_started_at) : null;
    if (initialConnect && !scanBoundary && state?.id) {
      scanBoundary = new Date();
      await db('email_sync_state').where('id', state.id).whereNull('initial_scan_started_at').update({ initial_scan_started_at: scanBoundary });
      const fresh = await db('email_sync_state').where('id', state.id).first('initial_scan_started_at');
      if (fresh?.initial_scan_started_at) scanBoundary = new Date(fresh.initial_scan_started_at); // another pod may have won
    }
    const messages = await gmailClient.listMessages('', Number.isFinite(fullSyncLimit) ? fullSyncLimit : null);
    logger.info(`[email-sync] Full sync: fetching ${messages.length} messages`);
    // fullSync serves two cases: first connect (mailbox HISTORY, never
    // notify) and expired-history-cursor recovery (genuinely new arrivals
    // are among these, so the 24h age guard decides, as for an incremental
    // sync). Decided from the sync-state row read BEFORE the remote scan —
    // durable across pods: a pod that has never completed a sync has no
    // last_sync_at, so two concurrent first syncs both see "initial" (both
    // stay silent); recovery has a completed prior sync (hook P1).
    // initial_sync_completed_at is written exactly once, when a full sync
    // COMPLETES (failed/incomplete runs also stamp last_sync_at, so that
    // cannot be the signal — codex P1). Null ⇒ this IS the first connect.

    let failedMessages = 0;
    for (const msg of messages) {
      try {
        const parsed = await gmailClient.getMessage(msg.id);
        const receivedTs = parsed.received_at ? new Date(parsed.received_at).getTime() : 0;
        const inserted = await upsertEmail(parsed, { backfill: initialConnect && Boolean(scanBoundary) && receivedTs < scanBoundary.getTime() });
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
      // First COMPLETED full sync — set once, never cleared (see migration
      // 20260828000041); later full syncs are recoveries, not first connects.
      ...(state?.initial_sync_completed_at ? {} : { initial_sync_completed_at: new Date() }),
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
    // Case-insensitive, like the request/complaint handlers (codex P2): a
    // sender whose address differs only by casing is the same customer.
    const customer = await db('customers')
      .whereRaw('LOWER(email) = ?', [String(parsed.from_address).trim().toLowerCase()])
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

  // First-connect history is pre-claimed at insert so the retry sweep can
  // never re-offer it (hook P1). Column guard: the migration runs prebuild,
  // but a sync racing an older pod must not fail the insert.
  if (backfill && await bellClaimColumnExists()) emailData.customer_bell_claimed_at = new Date();
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

  // Control messages never ring AND must never reach the recovery sweep,
  // which would otherwise read their unclassified row as a crash recovery
  // and run the classifier (auto-actions) over them. Pre-claim the bell so
  // the sweep skips them (hook P1). Best-effort: a miss here is caught by
  // the sweep's own control check.
  if ((proofHandled || approvalControl) && await bellClaimColumnExists()) {
    await db('emails').where({ id: email.id }).whereNull('customer_bell_claimed_at')
      .update({ customer_bell_claimed_at: new Date() }).catch(() => {});
  }

  // Classify in background (don't block sync)
  if (!proofHandled && !approvalControl && (!email.classification || email.classification === 'vendor')) {
    const { classifyEmail } = require('./email-classifier');
    if (bellCandidate) {
      // Bell candidates only: classification + bell are AWAITED so the sync
      // cursor never advances past a message whose bell has not happened
      // (a process exit there would otherwise lose it). Everything else
      // keeps the bounded background path — a full mailbox sync must not
      // serialize an LLM call per message (hook P1 ×2).
      let classified = false;
      try {
        await classifyEmail(email);
        classified = true;
      } catch (err) {
        logger.error(`[email-sync] Classification failed for ${email.id}: ${err?.message || err}`);
      }
      await ringCustomerEmailBell(email, { customerId, parsed, classified });
    } else {
      setImmediate(() => {
        classifyEmail(email).catch((err) => {
          logger.error(`[email-sync] Classification failed for ${email.id}: ${err?.message || err}`);
        });
      });
    }
  }

  return true; // new email
}

const CUSTOMER_EMAIL_BELL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Re-offer unclaimed, still-eligible customer emails from the last 24h.
 * Cheap (indexed on customer_id / received_at), bounded, idempotent.
 */
// Only a confirmed `true` is cached: a transient schema-check failure must
// not disable the sweep for the process lifetime (hook P1).
let bellClaimColumnKnown = false;
async function bellClaimColumnExists() {
  if (!bellClaimColumnKnown) {
    bellClaimColumnKnown = await db.schema.hasColumn('emails', 'customer_bell_claimed_at').catch(() => false) === true;
  }
  return bellClaimColumnKnown;
}

async function sweepUnclaimedCustomerEmailBells() {
  if (!(await bellClaimColumnExists())) return 0;
  const rows = await db('emails')
    .whereNull('customer_bell_claimed_at')
    .whereNotNull('customer_id')
    .where('received_at', '>', new Date(Date.now() - CUSTOMER_EMAIL_BELL_MAX_AGE_MS))
    .where({ is_archived: false })
    // Terminal exclusions the DB can see (bulk class, List-Unsubscribe)
    // never occupy the page (hook P1 — starvation).
    .whereNull('list_unsubscribe')
    .where((b) => b.whereNull('classification').orWhereNotIn('classification', [...NEVER_RING_CLASSES]))
    .orderBy('received_at', 'asc')
    .limit(50);
  let rung = 0;
  for (const row of rows) {
    const parsed = { from_name: row.from_name, from_address: row.from_address, subject: row.subject, label_ids: row.label_ids || [] };
    const outcome = await recoverLostCustomerEmailBell(row, { customerId: row.customer_id, parsed, backfill: false }).catch(() => null);
    if (outcome === 'ineligible' || outcome === 'control') {
      // Terminally ineligible (unauthenticated sender, not in INBOX, control
      // message): mark handled so it stops occupying the oldest-50 page and
      // can't starve newer eligible rows (hook P1). Only the sweep stamps —
      // the history-replay caller leaves the row for a later replay.
      await db('emails').where({ id: row.id }).whereNull('customer_bell_claimed_at')
        .update({ customer_bell_claimed_at: new Date() }).catch(() => {});
    } else if (outcome === 'offered') {
      rung += 1;
    }
  }
  return rung;
}

// Bulk/spam classes the classifier may assign after insert — never ring.
const NEVER_RING_CLASSES = new Set(['spam', 'marketing_newsletter', 'vendor', 'vendor_invoice', 'vendor_communication']);

/**
 * Is this row a control message (newsletter proof reply / [EA-…] content
 * approval reply)? Same two gated checks the insert path makes before
 * classification — the sweep must never classify these (hook P1).
 */
async function isControlMessage(row) {
  try {
    const proof = require('../newsletter-proof');
    if (proof.isProofApprovalEnabled() && proof.parseProofToken(row.subject)) return true;
  } catch { /* module unavailable = not proof traffic */ }
  try {
    const { isApprovalControlMessage } = require('../content/email-approvals');
    return await isApprovalControlMessage({ subject: row.subject, from_address: row.from_address });
  } catch { return false; }
}

/**
 * A row that exists but was never notified (sync died between insert and
 * bell): if it is still an eligible candidate and no bell carries its id,
 * ring now. Idempotent — the bell payload stores emailId.
 * Returns 'ineligible' | 'control' | 'offered' (the sweep stamps the first
 * two as handled; 'offered' means the claim was attempted).
 */
async function recoverLostCustomerEmailBell(existing, { customerId, parsed, backfill }) {
  // A persisted NON-bulk classification (the crash window is after the
  // classifier wrote, before the bell) must not disqualify the row.
  const bulk = existing.classification && NEVER_RING_CLASSES.has(existing.classification);
  if (!customerEmailBellEligible({
    customerId: existing.customer_id || customerId,
    classification: bulk ? existing.classification : null,
    listUnsubscribe: existing.list_unsubscribe,
    labelIds: parsed.label_ids,
    authenticationResults: existing.authentication_results,
    fromAddress: existing.from_address,
    receivedAt: existing.received_at,
    backfill,
  })) return 'ineligible';
  if (existing.is_archived) return 'ineligible';
  if (await isControlMessage(existing)) return 'control';
  // A row the crash left UNCLASSIFIED (insert landed, classifier never
  // wrote) gets the same awaited classification the insert path gives a
  // bell candidate — otherwise spam without a List-Unsubscribe header could
  // ring through the recovery lane (codex r4). Classifier failure keeps the
  // insert path's fallback: ring (classified:false).
  let classified = Boolean(existing.classification);
  if (!classified) {
    const { classifyEmail } = require('./email-classifier');
    try {
      await classifyEmail(existing);
      classified = true;
    } catch (err) {
      logger.error(`[email-sync] Recovery classification failed for ${existing.id}: ${err?.message || err}`);
    }
  }
  await ringCustomerEmailBell(existing, { customerId: existing.customer_id || customerId, parsed, classified });
  return 'offered';
}

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
    // Atomic per-email claim (emails.customer_bell_claimed_at): at most one
    // delivery across insert path, crash recovery, label/history replays and
    // concurrent pods — and independent of a bell row (push-only admins get
    // none). A failed trigger releases the claim so a retry can ring.
    const claimed = await db('emails').where({ id: email.id }).whereNull('customer_bell_claimed_at')
      .update({ customer_bell_claimed_at: new Date() });
    if (!claimed) return;
    const { triggerNotification } = require('../notification-triggers');
    let stats = null;
    try {
      stats = await triggerNotification('customer_email_received', {
        fromName: parsed.from_name || parsed.from_address,
        subject: parsed.subject,
        emailId: email.id,
        customerId,
      });
    } finally {
      // Keep the claim only for a real outcome: a bell written, a push sent,
      // or a deliberate suppression (prefs/policy). Any other no-delivery
      // (prefs lookup failed, empty recipients, insert/push failure) releases
      // it so a later replay can recover the alert (hook P1).
      const delivered = Boolean(stats && !stats.error
        && (stats.bellWritten || Number(stats.push?.sent || 0) > 0 || stats.suppressed || stats.policySilenced));
      if (!delivered) {
        await db('emails').where({ id: email.id }).update({ customer_bell_claimed_at: null }).catch(() => {});
      }
    }
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

module.exports = { syncEmails, customerEmailBellEligible, sweepUnclaimedCustomerEmailBells };
