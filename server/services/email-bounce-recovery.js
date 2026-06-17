/**
 * Email bounce → transcription recovery.
 *
 * When a transactional/service email HARD-bounces because the recipient address
 * has a domain-level transcription typo (e.g. "jane@gmial.com" captured on a
 * phone call), this service:
 *   1. corrects the DOMAIN only (never the local part — see email-typo-correction.js)
 *   2. re-sends the EXACT stored snapshot (html/text/subject) to the fixed address
 *   3. once the corrected address actually DELIVERS, overwrites the stored
 *      customer email and records an audit trail.
 *
 * Behaviour is fully automatic above a confidence threshold (default: high).
 * Env:
 *   EMAIL_BOUNCE_RECOVERY          'off' to disable entirely (default on)
 *   EMAIL_RECOVERY_MIN_CONFIDENCE  'high' (default) | 'medium' | 'low'
 *
 * Wiring: called best-effort from the SendGrid event webhook AFTER the event's
 * DB transaction commits — never inside it, because the re-send is a network
 * call. See server/routes/webhooks-sendgrid.js.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const emailLib = require('./email-template-library');
const NotificationService = require('./notification-service');
const { correctEmailDomain, meetsConfidence } = require('../utils/email-typo-correction');

const RECOVERY_CATEGORY = 'bounce_recovery';
// Customer columns that can hold a sendable address. We overwrite whichever one
// held the bounced address. Hardcoded constant — safe to interpolate into SQL.
const CUSTOMER_EMAIL_FIELDS = ['email', 'service_contact_email', 'service_contact2_email', 'service_contact3_email'];

// Templates known to carry binary attachments (invoice/receipt/report PDFs).
// The has_attachments flag is authoritative for go-forward sends, but rows
// predating that column (migration default false) or any direct inserter that
// forgets to stamp it would otherwise be replayed body-only. Treating these
// template keys as attachment-bearing fails CLOSED → manual recovery, never a
// body-only replay of a PDF email. Keep in sync with the attachment senders.
const ATTACHMENT_TEMPLATE_KEYS = new Set([
  'invoice.sent',
  'invoice.receipt',
  'service.report_ready',
  'service.report_ready.legacy',
  'project.report_ready',
  'project.report_with_invoice',
]);

function recoveryEnabled() {
  return String(process.env.EMAIL_BOUNCE_RECOVERY || '').toLowerCase() !== 'off';
}

function minConfidence() {
  const v = String(process.env.EMAIL_RECOVERY_MIN_CONFIDENCE || 'high').toLowerCase();
  return ['high', 'medium', 'low'].includes(v) ? v : 'high';
}

function redactEmail(value) {
  if (!value || typeof value !== 'string') return '';
  const [local, domain] = value.split('@');
  if (!domain) return '[redacted]';
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Is this a TRUE hard bounce (address/domain bad), as opposed to a soft
 * 'blocked' (IP reputation / rate-limit, transient) or a 'dropped' due to an
 * existing suppression (no signal the address itself is wrong)? Mirrors the
 * bounce branch of webhooks-sendgrid.js `suppressionForEmailEvent`.
 */
function isHardBounceEvent(ev) {
  const event = String(ev?.event || '').toLowerCase();
  const reason = String(ev?.reason || ev?.response || ev?.type || '').trim().toLowerCase();
  if (event === 'bounce') {
    const type = String(ev?.type || '').trim().toLowerCase();
    return !type || type === 'bounce' || type === 'hard';
  }
  if (event === 'dropped') {
    return reason === 'bounced address' || reason === 'invalid';
  }
  return false;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** True when an email_messages row is itself a recovery re-send (loop guard). */
function isRecoveryMessage(message) {
  return parseJsonArray(message?.categories).includes(RECOVERY_CATEGORY);
}

function uniqueCategories(values = []) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = String(v || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// Atomically merge keys into the row's jsonb metadata without read-modify-write,
// so we never clobber concurrent writes (e.g. a delivery webhook racing a send).
function jsonbMerge(extra) {
  return db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(extra)]);
}

// The recovery ledger id we stamped into the recovery message's payload snapshot.
// Used as a fallback to resolve the ledger when recovery_message_id has not been
// linked yet (a fast delivery webhook racing the post-send ledger link).
function recoveryIdFromMessage(message) {
  const raw = message?.payload_snapshot;
  let obj = null;
  if (raw && typeof raw === 'object') obj = raw;
  else if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  return obj && obj.recovery_id ? obj.recovery_id : null;
}

/**
 * Pure decision: given a correction candidate, the configured threshold, and
 * whether the corrected address is itself suppressed, decide what to do.
 * Extracted so the gating logic is unit-testable without a DB.
 */
function decideRecoveryAction({ candidate, suppressed, ownedByOther, hasAttachments, addressOnFile = true, min = 'high' }) {
  if (!candidate) return { action: 'skip', status: 'no_candidate' };
  if (!meetsConfidence(candidate.confidence, min)) {
    return { action: 'skip', status: 'skipped_low_confidence' };
  }
  // PRIVACY: the corrected address is on file for a DIFFERENT customer (or, for
  // a lead with no resolvable customer, for any customer/lead/estimate).
  // Domain-only correction can't prove the corrected mailbox is the same person,
  // so never auto-send another party's invoice/report/estimate there.
  if (ownedByOther) return { action: 'skip', status: 'corrected_owned_by_other' };
  if (suppressed) return { action: 'skip', status: 'corrected_suppressed' };
  // The original carried an attachment (invoice/report PDF) that isn't in the
  // stored snapshot — a replay would reference a missing file. Route to manual.
  if (hasAttachments) return { action: 'skip', status: 'has_attachments' };
  // Final gate: the bounced address is no longer on file (an operator already
  // changed/corrected the record). The bounce is for a stale address — don't
  // auto-resend a correction of it; route to manual.
  if (!addressOnFile) return { action: 'skip', status: 'address_no_longer_on_file' };
  return { action: 'send', status: 'resent' };
}

function asmGroupIdForStream(streamKey) {
  const s = String(streamKey || '').toLowerCase();
  if (s === 'transactional_required') return 0; // bypass suppression groups
  if (s.startsWith('marketing_')) return sendgrid.newsletterGroupId();
  return sendgrid.serviceGroupId();
}

/** Does the corrected address have an active suppression that should block a resend? */
async function correctedAddressSuppressed(bouncedMessage, correctedEmail) {
  try {
    const loaded = bouncedMessage.template_key
      ? await emailLib.loadTemplateByKey(bouncedMessage.template_key)
      : null;
    if (loaded?.template) {
      const supp = await emailLib.activeSuppressionFor(
        loaded.template,
        correctedEmail,
        bouncedMessage.suppression_group_key_snapshot || undefined,
      );
      return !!supp;
    }
  } catch (err) {
    logger.warn(`[bounce-recovery] suppression check fell back: ${err.message}`);
  }
  // Fallback when the template can't be resolved (e.g. a legacy template_key):
  // mirror emailLib.activeSuppressionFor's GROUP-aware semantics using the
  // stream snapshot, so a group-level unsubscribe/manual suppression on the
  // corrected address still blocks the resend (not just global suppressions).
  const groupKey = String(bouncedMessage.suppression_group_key_snapshot || '').trim() || null;
  const globalTypes = new Set(['bounce', 'spam_complaint', 'do_not_email']);
  let rows;
  try {
    rows = await db('email_suppressions')
      .whereRaw('LOWER(email) = ?', [String(correctedEmail).trim().toLowerCase()])
      .where({ status: 'active' });
  } catch (err) {
    // Fail CLOSED: if we can't verify suppression state we must not resend.
    logger.warn(`[bounce-recovery] suppression lookup failed — treating as suppressed: ${err.message}`);
    return true;
  }
  const isGlobal = (r) => globalTypes.has(String(r.suppression_type || '').toLowerCase());
  // transactional_required bypasses group opt-outs but never global ones.
  if (groupKey === 'transactional_required') {
    return rows.some(isGlobal);
  }
  return rows.some((r) => !r.group_key || (groupKey && r.group_key === groupKey) || isGlobal(r));
}

/** Resolve the customer + which email column held the bounced address. */
async function resolveCustomerEmailField(bouncedMessage, bouncedEmail) {
  let customer = null;
  if (String(bouncedMessage.recipient_type || '').toLowerCase() === 'customer' && bouncedMessage.recipient_id) {
    customer = await db('customers').where({ id: bouncedMessage.recipient_id }).first().catch(() => null);
  }
  if (!customer) {
    customer = await db('customers')
      .where((q) => {
        for (const f of CUSTOMER_EMAIL_FIELDS) q.orWhereRaw(`LOWER(${f}) = ?`, [bouncedEmail]);
      })
      .first()
      .catch(() => null);
  }
  if (!customer) return null;
  const field = CUSTOMER_EMAIL_FIELDS.find(
    (f) => String(customer[f] || '').trim().toLowerCase() === bouncedEmail,
  ) || null;
  return { customerId: customer.id, field };
}

/**
 * Is the BOUNCED address still on file? When a bounce arrives late and an operator
 * has already changed/corrected the address, the bounce is for a stale address and
 * we must not auto-resend a correction of it. True if a customer column still holds
 * it (match.field) or a source estimate/lead does (scoped to the customer when
 * known). Fails CLOSED on a read error: if we can't confirm the address is still
 * on file, route to manual rather than risk resending to a since-changed mailbox.
 */
async function bouncedAddressStillOnFile(bouncedEmail, match) {
  if (match?.field) return true;
  const email = String(bouncedEmail || '').trim().toLowerCase();
  if (!email) return false;
  try {
    const estQ = db('estimates').whereRaw('LOWER(customer_email) = ?', [email]);
    const leadQ = db('leads').whereRaw('LOWER(email) = ?', [email]);
    if (match?.customerId) {
      estQ.where({ customer_id: match.customerId });
      leadQ.where({ customer_id: match.customerId });
    }
    if (await estQ.first('id')) return true;
    if (await leadQ.first('id')) return true;
  } catch (err) {
    logger.warn(`[bounce-recovery] on-file check failed — treating as not on file: ${err.message}`);
    return false;
  }
  return false;
}

/**
 * Would re-sending to the corrected address leak one party's mail to another?
 * True when the corrected address is on file for a customer/lead/estimate that
 * is NOT provably the same entity as the recovery's subject. Checked across all
 * three tables regardless of whether the bounce resolved to a customer — a
 * customer's corrected address sitting on an unrelated prospect's estimate/lead
 * is just as much a leak. Same-entity records are positively excluded by
 * customer_id so legit lead→customer conversions don't over-block.
 */
async function correctedAddressOwnedByOther(correctedEmail, ownCustomerId) {
  const email = String(correctedEmail || '').trim().toLowerCase();
  if (!email) return false;
  const own = String(ownCustomerId || '');
  // A row is "another party" unless it is positively tied to our own customer.
  // With no own customer (lead recovery) we can't disambiguate, so any match counts.
  const isOther = (rowCustomerId) => !own || String(rowCustomerId || '') !== own;
  // Fail CLOSED on lookup error: if we can't verify the address isn't owned by
  // someone else, treat it as owned so recovery routes to manual, never a
  // privacy-leaking auto-resend.
  try {
    const customerRows = await db('customers')
      .where((q) => {
        for (const f of CUSTOMER_EMAIL_FIELDS) q.orWhereRaw(`LOWER(${f}) = ?`, [email]);
      })
      .select('id');
    if (customerRows.some((r) => String(r.id) !== own)) return true;

    // Estimates / leads carry a customer_id link; a record not tied to our own
    // customer (incl. prospect rows with no customer_id) is another party.
    const estRows = await db('estimates').whereRaw('LOWER(customer_email) = ?', [email]).select('customer_id');
    if (estRows.some((r) => isOther(r.customer_id))) return true;

    const leadRows = await db('leads').whereRaw('LOWER(email) = ?', [email]).select('customer_id');
    if (leadRows.some((r) => isOther(r.customer_id))) return true;
  } catch (err) {
    logger.warn(`[bounce-recovery] ownership lookup failed — treating as owned by other: ${err.message}`);
    return true;
  }
  return false;
}

/**
 * Insert (or reuse) the QUEUED recovery email_messages row. Deliberately does
 * NOT publish a provider_message_id — the caller links the ledger first, then
 * dispatches. The SendGrid webhook can only match this row once provider_message_id
 * is written, so writing it last guarantees the ledger is already linked when a
 * (possibly very fast) delivery event arrives. Returns { message, categories }.
 */
async function insertRecoveryMessage(bouncedMessage, correctedEmail, recoveryId) {
  const now = new Date();
  const categories = uniqueCategories([...parseJsonArray(bouncedMessage.categories), RECOVERY_CATEGORY]);
  const idempotencyKey = `bounce_recovery:${bouncedMessage.id}`;

  const row = {
    provider: 'sendgrid',
    template_id: bouncedMessage.template_id || null,
    template_version_id: bouncedMessage.template_version_id || null,
    template_key: bouncedMessage.template_key || null,
    suppression_group_key_snapshot: bouncedMessage.suppression_group_key_snapshot || '',
    recipient_type: bouncedMessage.recipient_type || null,
    recipient_id: bouncedMessage.recipient_id || null,
    recipient_email_snapshot: correctedEmail,
    from_name_snapshot: bouncedMessage.from_name_snapshot || 'Waves Pest Control',
    from_email_snapshot: bouncedMessage.from_email_snapshot || 'contact@wavespestcontrol.com',
    reply_to_snapshot: bouncedMessage.reply_to_snapshot || 'contact@wavespestcontrol.com',
    subject_snapshot: bouncedMessage.subject_snapshot || '',
    html_snapshot: bouncedMessage.html_snapshot || null,
    text_snapshot: bouncedMessage.text_snapshot || null,
    payload_snapshot: JSON.stringify({
      bounce_recovery: true,
      recovery_id: recoveryId,
      original_message_id: bouncedMessage.id,
      original_email: bouncedMessage.recipient_email_snapshot || null,
    }),
    categories: JSON.stringify(categories),
    status: 'queued',
    idempotency_key: idempotencyKey,
    // Per-attempt token echoed in custom_args; the webhook fallback requires it
    // to match before trusting an unbound row.
    send_attempt_token: crypto.randomUUID(),
    queued_at: now,
    created_at: now,
    updated_at: now,
  };

  try {
    const [message] = await db('email_messages').insert(row).returning('*');
    return { message, categories };
  } catch (err) {
    // A prior partial attempt may already have created the row.
    const existing = await db('email_messages').where({ idempotency_key: idempotencyKey }).first().catch(() => null);
    if (!existing) throw err;
    return { message: existing, categories };
  }
}

/**
 * Dispatch the recovery message via SendGrid and publish provider_message_id
 * LAST. Idempotent — a row already sent (e.g. a partial-retry) is not re-sent.
 */
async function dispatchRecoveryMessage({ message, categories, bouncedMessage, correctedEmail }) {
  if (message.status === 'sent' && message.provider_message_id) {
    return { ok: true, messageRowId: message.id, reused: true };
  }
  try {
    const result = await sendgrid.sendOne({
      to: correctedEmail,
      fromEmail: message.from_email_snapshot,
      fromName: message.from_name_snapshot,
      replyTo: message.reply_to_snapshot,
      subject: message.subject_snapshot,
      html: bouncedMessage.html_snapshot || undefined,
      text: bouncedMessage.text_snapshot || undefined,
      categories,
      asmGroupId: asmGroupIdForStream(bouncedMessage.suppression_group_key_snapshot),
      // So a fast delivery/bounce webhook can resolve this row even before
      // provider_message_id is committed below.
      customArgs: { email_message_id: String(message.id), send_attempt_token: message.send_attempt_token },
    });
    // Always record the provider id + send time. These are safe regardless of
    // any concurrent webhook.
    await db('email_messages').where({ id: message.id }).update({
      provider_message_id: result.messageId,
      sent_at: new Date(),
      updated_at: new Date(),
    });
    // Advance to 'sent' ONLY if still 'queued' — a fast delivery/bounce webhook
    // (resolvable via custom_args.email_message_id before this commit) may have
    // already moved the row to a terminal status, and we must not regress it.
    await db('email_messages')
      .where({ id: message.id, status: 'queued' })
      .update({ status: 'sent', updated_at: new Date() })
      .catch(() => {});
    return { ok: true, messageRowId: message.id };
  } catch (err) {
    // The send POST failed — but SendGrid may have accepted it and a webhook
    // (via custom_args.email_message_id) already resolved the row before this
    // catch ran (lost-response case). If so, don't regress it or report failure.
    const current = await db('email_messages').where({ id: message.id }).first().catch(() => null);
    const status = String(current?.status || '').toLowerCase();
    if (current && status !== 'queued' && status !== 'failed') {
      return { ok: true, messageRowId: message.id, reused: true };
    }
    await db('email_messages')
      .where({ id: message.id, status: 'queued' })
      .update({
        status: 'failed',
        error_message: String(err.message || err).slice(0, 1000),
        updated_at: new Date(),
      })
      .catch(() => {});
    return { ok: false, error: String(err.message || err) };
  }
}

/**
 * Entry point for a hard-bounce event on a tracked email_messages row.
 * Best-effort; never throws.
 */
async function attemptRecovery(bouncedMessage, ev = {}) {
  try {
    if (!recoveryEnabled()) return { skipped: 'disabled' };
    if (!bouncedMessage || !bouncedMessage.id) return { skipped: 'no_message' };

    // Loop guard: a recovery re-send that itself bounced must NOT recurse.
    if (isRecoveryMessage(bouncedMessage)) {
      return await handleRecoveryBounce(bouncedMessage, ev);
    }

    const bouncedEmail = String(bouncedMessage.recipient_email_snapshot || '').trim().toLowerCase();
    if (!bouncedEmail) return { skipped: 'no_recipient' };

    // One recovery per original message (idempotent across webhook redelivery).
    const inserted = await db('email_bounce_recoveries')
      .insert({
        original_message_id: bouncedMessage.id,
        bounced_email: bouncedEmail,
        status: 'pending',
        metadata: JSON.stringify({
          bounce_event_id: ev.sg_event_id || null,
          bounce_reason: ev.reason || ev.response || ev.type || null,
        }),
      })
      .onConflict('original_message_id')
      .ignore()
      .returning('id');
    if (!inserted.length) return { skipped: 'already_attempted' };
    const recoveryId = inserted[0].id || inserted[0];

    const candidate = correctEmailDomain(bouncedEmail);
    const match = await resolveCustomerEmailField(bouncedMessage, bouncedEmail);
    const suppressed = candidate ? await correctedAddressSuppressed(bouncedMessage, candidate.corrected) : false;
    const ownedByOther = candidate ? await correctedAddressOwnedByOther(candidate.corrected, match?.customerId) : false;
    const addressOnFile = candidate ? await bouncedAddressStillOnFile(bouncedEmail, match) : true;
    // Fail closed: the stored flag OR a known attachment-bearing template (covers
    // pre-flag rows and any direct inserter that didn't stamp has_attachments).
    const hasAttachments = !!bouncedMessage.has_attachments
      || ATTACHMENT_TEMPLATE_KEYS.has(String(bouncedMessage.template_key || ''));
    const decision = decideRecoveryAction({ candidate, suppressed, ownedByOther, hasAttachments, addressOnFile, min: minConfidence() });

    const baseUpdate = {
      corrected_email: candidate?.corrected || null,
      correction_rule: candidate?.rule || null,
      confidence: candidate?.confidence || null,
      customer_id: match?.customerId || null,
      customer_email_field: match?.field || null,
      updated_at: new Date(),
    };

    if (decision.action === 'skip') {
      await db('email_bounce_recoveries').where({ id: recoveryId }).update({ ...baseUpdate, status: decision.status });
      // Every skip means a service/transactional email did NOT reach the
      // customer — nudge a human to fix the address (and show the suggestion
      // when we have one, e.g. a medium-confidence typo below the auto-send bar).
      if (['no_candidate', 'corrected_suppressed', 'skipped_low_confidence', 'corrected_owned_by_other', 'has_attachments', 'address_no_longer_on_file'].includes(decision.status)) {
        await alertUnrecoverableBounce({ bouncedMessage, bouncedEmail, customerId: match?.customerId, status: decision.status, candidate });
      }
      logger.info(`[bounce-recovery] ${decision.status} for ${redactEmail(bouncedEmail)} (${bouncedMessage.template_key || 'email'})`);
      return { skipped: decision.status };
    }

    // Build the queued recovery row first (no provider id yet).
    let built;
    try {
      built = await insertRecoveryMessage(bouncedMessage, candidate.corrected, recoveryId);
    } catch (err) {
      await db('email_bounce_recoveries').where({ id: recoveryId }).update({
        ...baseUpdate,
        status: 'send_failed',
        metadata: jsonbMerge({ send_error: String(err.message || err) }),
      });
      await alertUnrecoverableBounce({ bouncedMessage, bouncedEmail, customerId: match?.customerId, status: 'send_failed', candidate });
      logger.warn(`[bounce-recovery] could not stage resend for ${redactEmail(candidate.corrected)}: ${err.message}`);
      return { error: String(err.message || err) };
    }

    // Link the ledger to the recovery message BEFORE its provider id is
    // published, so a fast delivery webhook can always resolve the ledger.
    await db('email_bounce_recoveries').where({ id: recoveryId }).update({
      ...baseUpdate,
      status: 'resent',
      recovery_message_id: built.message.id,
    });

    const sendResult = await dispatchRecoveryMessage({
      message: built.message,
      categories: built.categories,
      bouncedMessage,
      correctedEmail: candidate.corrected,
    });
    if (!sendResult.ok) {
      await db('email_bounce_recoveries').where({ id: recoveryId }).update({
        status: 'send_failed',
        updated_at: new Date(),
        metadata: jsonbMerge({ send_error: sendResult.error }),
      });
      await alertUnrecoverableBounce({ bouncedMessage, bouncedEmail, customerId: match?.customerId, status: 'send_failed', candidate });
      logger.warn(`[bounce-recovery] resend failed for ${redactEmail(candidate.corrected)}: ${sendResult.error}`);
      return { error: sendResult.error };
    }

    logger.info(`[bounce-recovery] re-sent ${bouncedMessage.template_key || 'email'} ${redactEmail(bouncedEmail)} → ${redactEmail(candidate.corrected)} (${candidate.rule}/${candidate.confidence})`);
    return { resent: true, corrected: candidate.corrected, rule: candidate.rule };
  } catch (err) {
    logger.error(`[bounce-recovery] attemptRecovery failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * The recovery re-send DELIVERED. Commit the correction to the customer record
 * (auto-overwrite the column that held the bad address) and audit it.
 * Idempotent; best-effort; never throws.
 */
async function commitRecoveryOnDelivery(recoveryMessage) {
  try {
    if (!recoveryMessage?.id) return;
    let rec = await db('email_bounce_recoveries').where({ recovery_message_id: recoveryMessage.id }).first();
    if (!rec) {
      // Fallback: the ledger may not be linked yet if delivery raced the send.
      // Resolve via the recovery_id stamped in the message payload and self-heal.
      const recoveryId = recoveryIdFromMessage(recoveryMessage);
      if (recoveryId) {
        rec = await db('email_bounce_recoveries').where({ id: recoveryId }).first().catch(() => null);
        if (rec && !rec.recovery_message_id) {
          await db('email_bounce_recoveries').where({ id: rec.id })
            .update({ recovery_message_id: recoveryMessage.id, updated_at: new Date() })
            .catch(() => {});
        }
      }
    }
    if (!rec) return;
    if (rec.record_updated || rec.status === 'committed') return; // already done

    const correctedEmail = String(rec.corrected_email || recoveryMessage.recipient_email_snapshot || '').trim().toLowerCase();
    const bouncedEmail = String(rec.bounced_email || '').trim().toLowerCase();

    const updatedFields = [];

    // 1. Customer record (primary email or service-contact column), when the
    //    bounce resolved to a customer.
    if (rec.customer_id && rec.customer_email_field && correctedEmail
        && CUSTOMER_EMAIL_FIELDS.includes(rec.customer_email_field)) {
      const field = rec.customer_email_field;
      // Guard the UNIQUE primary email column: never overwrite onto an address
      // already owned by a different customer.
      if (field === 'email') {
        const clash = await db('customers')
          .whereRaw('LOWER(email) = ?', [correctedEmail])
          .whereNot({ id: rec.customer_id })
          .first('id')
          .catch(() => null);
        if (clash) {
          await db('email_bounce_recoveries').where({ id: rec.id }).update({
            status: 'delivered',
            updated_at: new Date(),
            metadata: jsonbMerge({ commit_skipped: 'email_in_use' }),
          });
          await alertEmailCollision({ recovery: rec, correctedEmail });
          return;
        }
      }
      // Only overwrite if the column STILL holds the bad address — a human edit
      // may have raced us, in which case we leave their value alone.
      const affected = await db('customers')
        .where({ id: rec.customer_id })
        .whereRaw(`LOWER(${field}) = ?`, [bouncedEmail])
        .update({ [field]: correctedEmail, updated_at: new Date() })
        .catch((err) => {
          logger.warn(`[bounce-recovery] customer ${field} overwrite failed: ${err.message}`);
          return 0;
        });
      if (Number(affected) > 0) updatedFields.push(field);
    }

    // 2. SOURCE estimate/lead rows that follow-ups read (estimate-follow-up.js →
    //    est.customer_email). Runs for BOTH customer-owned and lead/prospect
    //    recoveries, else a typo on a customer-owned estimate keeps bouncing.
    //    Scope to our own customer when known; for no-customer recoveries the
    //    pre-send ownership guard already verified the corrected address is
    //    unowned. Only rows still holding the bad address are touched.
    if (correctedEmail && bouncedEmail) {
      if (rec.customer_id) {
        // Customer-owned: scope to this customer's rows — no cross-prospect risk.
        const estAffected = await db('estimates')
          .whereRaw('LOWER(customer_email) = ?', [bouncedEmail])
          .where({ customer_id: rec.customer_id })
          .update({ customer_email: correctedEmail, updated_at: new Date() })
          .catch((err) => { logger.warn(`[bounce-recovery] estimate email overwrite failed: ${err.message}`); return 0; });
        const leadAffected = await db('leads')
          .whereRaw('LOWER(email) = ?', [bouncedEmail])
          .where({ customer_id: rec.customer_id })
          .update({ email: correctedEmail, updated_at: new Date() })
          .catch((err) => { logger.warn(`[bounce-recovery] lead email overwrite failed: ${err.message}`); return 0; });
        if (Number(estAffected) > 0) updatedFields.push('estimates.customer_email');
        if (Number(leadAffected) > 0) updatedFields.push('leads.email');
      } else {
        // No-customer (lead/prospect): no source id to scope by, so only rewrite
        // when the bounced address uniquely identifies ONE record ACROSS both
        // tables — a typo appearing once in estimates AND once in leads can't be
        // proven to be the same prospect, so we leave both alone.
        let estRows;
        let leadRows;
        try {
          estRows = await db('estimates').whereRaw('LOWER(customer_email) = ?', [bouncedEmail]).select('id');
          leadRows = await db('leads').whereRaw('LOWER(email) = ?', [bouncedEmail]).select('id');
        } catch (err) {
          // Fail closed: a failed lookup must not read as "zero matches" and let
          // a single match on the other table slip through as unique.
          logger.warn(`[bounce-recovery] source uniqueness lookup failed — left unchanged: ${err.message}`);
          estRows = null;
          leadRows = null;
        }
        if (estRows && leadRows) {
          const totalMatches = estRows.length + leadRows.length;
          if (totalMatches === 1 && estRows.length === 1) {
            // Re-guard on the bounced address: don't clobber an operator edit made
            // between the select and this update.
            const ok = await db('estimates').where({ id: estRows[0].id })
              .whereRaw('LOWER(customer_email) = ?', [bouncedEmail])
              .update({ customer_email: correctedEmail, updated_at: new Date() })
              .catch((err) => { logger.warn(`[bounce-recovery] estimate email overwrite failed: ${err.message}`); return 0; });
            if (Number(ok) > 0) updatedFields.push('estimates.customer_email');
          } else if (totalMatches === 1 && leadRows.length === 1) {
            const ok = await db('leads').where({ id: leadRows[0].id })
              .whereRaw('LOWER(email) = ?', [bouncedEmail])
              .update({ email: correctedEmail, updated_at: new Date() })
              .catch((err) => { logger.warn(`[bounce-recovery] lead email overwrite failed: ${err.message}`); return 0; });
            if (Number(ok) > 0) updatedFields.push('leads.email');
          } else if (totalMatches > 1) {
            logger.warn(`[bounce-recovery] ambiguous source (${estRows.length} estimate(s) + ${leadRows.length} lead(s) share the typo) — left unchanged`);
          }
        }
      }
    }

    const recordUpdated = updatedFields.length > 0;
    const updatedField = updatedFields.join('+') || null;

    await db('email_bounce_recoveries').where({ id: rec.id }).update({
      status: 'committed',
      record_updated: recordUpdated,
      committed_at: new Date(),
      updated_at: new Date(),
      metadata: jsonbMerge({ committed_field: updatedField }),
    });

    await notifyRecoverySuccess({ recovery: rec, bouncedEmail, correctedEmail, recordUpdated, field: updatedField });
    logger.info(`[bounce-recovery] committed ${redactEmail(bouncedEmail)} → ${redactEmail(correctedEmail)} (record_updated=${recordUpdated})`);
  } catch (err) {
    logger.error(`[bounce-recovery] commitRecoveryOnDelivery failed: ${err.message}`);
  }
}

/** The recovery re-send itself hard-bounced — record it and alert a human. */
async function handleRecoveryBounce(recoveryMessage, ev) {
  try {
    const rec = await db('email_bounce_recoveries').where({ recovery_message_id: recoveryMessage.id }).first().catch(() => null);
    if (rec && rec.status !== 'redelivered_bounced') {
      await db('email_bounce_recoveries').where({ id: rec.id }).update({
        status: 'redelivered_bounced',
        updated_at: new Date(),
        metadata: jsonbMerge({ redeliver_bounce_reason: ev?.reason || ev?.response || ev?.type || null }),
      });
      await alertUnrecoverableBounce({
        bouncedMessage: recoveryMessage,
        bouncedEmail: recoveryMessage.recipient_email_snapshot,
        customerId: rec.customer_id,
        status: 'redelivered_bounced',
      });
    }
  } catch (err) {
    logger.error(`[bounce-recovery] handleRecoveryBounce failed: ${err.message}`);
  }
  return { skipped: 'recovery_message_rebounced' };
}

// --- admin notifications (deduped) ---------------------------------------

async function adminAlertDeduped({ dedupeKey, windowHours = 168, category = 'alert', title, body, link, metadata = {} }) {
  try {
    const existing = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .where('created_at', '>=', db.raw("now() - (?::int * interval '1 hour')", [windowHours]))
      .first('id')
      .catch(() => null);
    if (existing) return;
    await NotificationService.notifyAdmin(category, title, body, { link, metadata: { dedupeKey, ...metadata } });
  } catch (err) {
    logger.warn(`[bounce-recovery] admin alert failed: ${err.message}`);
  }
}

const UNRECOVERABLE_REASONS = {
  redelivered_bounced: 'the corrected address also bounced',
  corrected_suppressed: 'the likely correction is on the suppression list',
  corrected_owned_by_other: 'the likely correction already belongs to another customer',
  has_attachments: 'it includes an attachment (e.g. an invoice or report PDF) that cannot be auto-resent',
  address_no_longer_on_file: 'the bounced address is no longer on the record (it was already changed)',
  send_failed: 're-sending to the corrected address failed',
  skipped_low_confidence: 'the likely correction was not confident enough to send automatically',
  no_candidate: 'no safe address correction was possible',
};

async function alertUnrecoverableBounce({ bouncedMessage, bouncedEmail, customerId, status, candidate = null }) {
  // Marketing bounces are noise here — the suppression ledger already handles them.
  const stream = String(bouncedMessage?.suppression_group_key_snapshot || '').toLowerCase();
  if (stream.startsWith('marketing_')) return;
  const email = String(bouncedEmail || '').trim().toLowerCase();
  if (!email) return;
  const reasonLabel = status === 'corrected_owned_by_other' && candidate?.corrected
    ? `the likely correction (${candidate.corrected}) already belongs to another customer`
    : (UNRECOVERABLE_REASONS[status] || UNRECOVERABLE_REASONS.no_candidate);
  // Surface the suggested address only when proposing it is actionable (i.e. it
  // wasn't itself suppressed).
  const suggestion = candidate?.corrected && ['skipped_low_confidence', 'send_failed', 'has_attachments'].includes(status)
    ? ` Suggested correction: ${candidate.corrected} (${candidate.confidence}).`
    : '';
  await adminAlertDeduped({
    dedupeKey: `bounce-recovery-unrecoverable:${email}`,
    windowHours: 168,
    category: 'alert',
    title: 'Email bounced — needs a correct address',
    body: `${email} hard-bounced on a ${bouncedMessage?.template_key || 'service'} email and ${reasonLabel}.${suggestion} Check/update the address on file.`,
    link: customerId ? `/admin/customers/${customerId}` : '/admin/communications',
    metadata: { customer_id: customerId || null, original_message_id: bouncedMessage?.id || null, status, suggested_email: candidate?.corrected || null },
  });
}

async function alertEmailCollision({ recovery, correctedEmail }) {
  await adminAlertDeduped({
    dedupeKey: `bounce-recovery-collision:${recovery.id}`,
    windowHours: 168,
    category: 'alert',
    title: 'Bounced email recovered, but address is in use',
    body: `A bounced email was re-sent and delivered to ${correctedEmail}, but that address already belongs to another customer, so the record was not updated. Reconcile manually.`,
    link: recovery.customer_id ? `/admin/customers/${recovery.customer_id}` : '/admin/communications',
    metadata: { customer_id: recovery.customer_id || null, recovery_id: recovery.id },
  });
}

async function notifyRecoverySuccess({ recovery, bouncedEmail, correctedEmail, recordUpdated, field }) {
  await adminAlertDeduped({
    dedupeKey: `bounce-recovery-committed:${recovery.id}`,
    windowHours: 24,
    category: 'system',
    title: 'Recovered a bounced email',
    body: `Corrected ${bouncedEmail} → ${correctedEmail} (${recovery.correction_rule || 'domain fix'}) and the re-send delivered.${recordUpdated ? ` Updated ${field} on the customer record.` : ''}`,
    link: recovery.customer_id ? `/admin/customers/${recovery.customer_id}` : '/admin/communications',
    metadata: { customer_id: recovery.customer_id || null, recovery_id: recovery.id, record_updated: recordUpdated },
  });
}

module.exports = {
  RECOVERY_CATEGORY,
  recoveryEnabled,
  minConfidence,
  isHardBounceEvent,
  isRecoveryMessage,
  decideRecoveryAction,
  asmGroupIdForStream,
  attemptRecovery,
  commitRecoveryOnDelivery,
  handleRecoveryBounce,
  // exported for tests
  resolveCustomerEmailField,
  correctedAddressSuppressed,
  correctedAddressOwnedByOther,
  bouncedAddressStillOnFile,
  CUSTOMER_EMAIL_FIELDS,
};
