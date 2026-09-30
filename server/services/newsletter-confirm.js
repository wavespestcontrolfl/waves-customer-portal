/**
 * Newsletter double-opt-in confirmation email.
 *
 * Consumed by the public-newsletter route's POST /subscribe handler.
 * Admin-add and quote-wizard signups skip this — they auto-confirm
 * (audit §9.4: "new only + 24h grace" applies to anonymous public
 * signups; admin-trusted and transactional contexts don't need it).
 *
 * The confirmation URL points at GET /api/public/newsletter/confirm/:token
 * — the route flips status to 'active' and renders a confirmation page.
 * Same env var (PUBLIC_PORTAL_URL) the unsubscribe URL uses.
 */

const sendgrid = require('./sendgrid-mail');
const db = require('../models/db');
const { wrapEmail } = require('./email-template');
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');

// Local HTML escape — wrapEmail() interpolates intro/heading/lines as
// raw HTML, so any caller that includes user-controlled data (here:
// subscriber.first_name from the public signup form) MUST escape it
// first. Mirrors the implementation in routes/public-newsletter.js.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function confirmationUrl(token) {
  return `${publicPortalUrl()}/api/public/newsletter/confirm/${token}`;
}

// Suppression types that are a fact about the ADDRESS, not one mailing list
// (mirrors GLOBAL_SUPPRESSION_TYPES in email-template-library.js and
// newsletter-sender.js). A DOI must never reach one of these.
const GLOBAL_SUPPRESSION_TYPES = ['bounce', 'spam_complaint', 'do_not_email'];

// The customers columns that can hold a sendable address. CUSTOMER_EMAIL_COLUMNS
// also lists billing_email, which lives on notification_prefs (migration
// 20260927000150), NOT on customers — querying it there is a 42703 that would
// veto every confirmation. Same split as email-bounce-recovery's
// CUSTOMER_EMAIL_FIELDS + its separate notification_prefs read.
const CUSTOMER_EMAIL_FIELDS = require('../utils/customer-comms-lock').CUSTOMER_EMAIL_COLUMNS
  .filter((column) => column !== 'billing_email');

// Vetoes that will not clear by themselves: the address is suppressed or the
// customer asked not to be contacted. Everything else (ownership busy, an
// unverifiable lookup, a provider error) is transient and worth a retry.
const PERMANENT_VETO_REASONS = new Set(['address_suppressed', 'do_not_contact']);

class ConfirmationVetoedError extends Error {
  constructor(reason) {
    super(`confirmation email vetoed: ${reason}`);
    this.name = 'ConfirmationVetoedError';
    this.code = 'confirmation_vetoed';
    this.reason = reason;
  }
}

/**
 * The one outbound veto for a newsletter confirmation email. The send
 * deliberately bypasses SendGrid's suppression group (asmGroupId: 0 — a
 * prior newsletter unsubscribe must not stop a fresh, deliberate re-signup
 * confirmation), so the app-level vetoes have to run here, before the
 * provider call, for EVERY caller (public form, quote wizard, admin import,
 * call pipeline, email fanout).
 *
 * MUST run on a transaction that stays open through the provider handoff
 * (sendConfirmationEmail arranges this): the two locks below are
 * transaction-scoped and fence nothing once it ends. Same final-send-boundary
 * recipe as billing-channel-email-authority / email-bounce-recovery:
 *   1. lockCustomerEmail — the per-address lock every suppression writer
 *      (SendGrid webhook, admin do_not_email) takes, so a bounce / complaint /
 *      do-not-email is either committed before this read or lands after the
 *      send. Blocking; taken first (caller-held row locks are always taken
 *      AFTER the address key by the writers, never before).
 *   2. lockEmailOwnershipForSend — non-blocking, AFTER the blocking locks,
 *      fencing assignment of this address to a customer between the profile
 *      read and the send. Busy = a writer is mid-assignment: refuse (retryable).
 *
 *  - email_suppressions: an active bounce / spam_complaint / do_not_email row
 *    (any stream) or an ungrouped row, on this mailbox under ANY Gmail
 *    spelling — the same rule newsletter-sender's excludeGloballySuppressed
 *    applies. A group-scoped newsletter unsubscribe does NOT veto: the
 *    subscriber is asking back in.
 *  - do-not-contact: a call_log consent.do_not_contact_request on the linked
 *    customer OR on any customer that owns this mailbox: the four customers
 *    email columns and notification_prefs.billing_email (which is NOT a
 *    customers column).
 *
 * Fail closed: a lookup that throws means the address could not be cleared,
 * so nothing is sent. Vetoes are not surfaced to anonymous callers — every
 * caller already swallows a send error and answers uniformly.
 */
async function assertConfirmationAllowed(subscriber, dbh = db) {
  const emailLc = String(subscriber.email || '').trim().toLowerCase();
  try {
    const locks = require('../utils/customer-comms-lock');
    if (!dbh || !dbh.isTransaction) throw Object.assign(new Error('transaction required'), { code: 'NO_TRANSACTION' });
    await locks.lockCustomerEmail(dbh, emailLc);
    try {
      await locks.lockEmailOwnershipForSend(dbh, emailLc);
    } catch (lockErr) {
      if (lockErr && lockErr.code === 'EMAIL_OWNERSHIP_CHECK_BUSY') throw new ConfirmationVetoedError('ownership_busy');
      throw lockErr;
    }
    // Reads run in a savepoint so a failing statement cannot poison a
    // caller's transaction; the locks above (taken outside it) survive.
    await dbh.transaction(async (sp) => {
      const { suppressionCoversEmail } = require('../utils/email-equivalence');
      const suppression = await sp('email_suppressions')
        .where(suppressionCoversEmail(emailLc))
        .where({ status: 'active' })
        .where(function globalOrUngrouped() {
          this.whereRaw('LOWER(suppression_type) IN (?, ?, ?)', GLOBAL_SUPPRESSION_TYPES)
            .orWhereNull('group_key')
            .orWhere('group_key', '');
        })
        .first('id');
      if (suppression) throw new ConfirmationVetoedError('address_suppressed');

      const customerIds = new Set();
      if (subscriber.customer_id) customerIds.add(subscriber.customer_id);
      const mailbox = locks.googleMailboxIdentity(emailLc);
      const mailboxName = mailbox ? mailbox.split('@')[0] : null;
      const CANON = (col) => locks.GOOGLE_MAILBOX_SQL.mailbox(`BTRIM(${col})`);
      const GOOGLE = (col) => locks.GOOGLE_MAILBOX_SQL.isGoogle(`BTRIM(${col})`);
      const sameMailbox = (columns) => function match() {
        for (const col of columns) {
          this.orWhereRaw(`LOWER(BTRIM(${col})) = ?`, [emailLc]);
          if (mailboxName) this.orWhereRaw(`(${GOOGLE(col)} AND ${CANON(col)} = ?)`, [mailboxName]);
        }
      };
      const profiles = await sp('customers').where(sameMailbox(CUSTOMER_EMAIL_FIELDS)).select('id');
      for (const row of profiles || []) customerIds.add(row.id);
      const prefs = await sp('notification_prefs').where(sameMailbox(['billing_email'])).select('customer_id');
      for (const row of prefs || []) if (row.customer_id) customerIds.add(row.customer_id);

      if (customerIds.size) {
        const { customerCallDoNotContact } = require('./lead-first-touch-resume');
        for (const id of customerIds) {
          if (await customerCallDoNotContact(id, sp)) throw new ConfirmationVetoedError('do_not_contact');
        }
      }
    });
  } catch (err) {
    if (err instanceof ConfirmationVetoedError) throw err;
    // ID-only, no address, per AGENTS.md.
    logger.warn(`[newsletter-confirm] veto check failed for subscriber id=${subscriber.id}: ${err.code || err.name || 'error'} — not sending`);
    throw new ConfirmationVetoedError('veto_unverifiable');
  }
}

/**
 * subscribeOrResubscribe stamps confirmation_sent_at BEFORE the send. When the
 * send then fails for a TRANSIENT reason (ownership busy, unverifiable veto
 * lookup, provider error) the row would look delivered: nothing retries, the
 * DOI TTL runs against a mail that never left, and the purge sweep deletes the
 * row. Undo the pre-stamp so the row reads "not sent" again (a repeat signup
 * re-sends, the stale-pending lifecycle stays honest) — the discipline the
 * call pipeline and the email fanout already follow. A PERMANENT veto
 * (suppressed / do-not-contact) is left stamped: it must not be retried, and
 * the purge sweep retires the row.
 *
 * Never null a stamp that records a REAL delivery. A pending resubscribe
 * re-mails the SAME token, so the stamp it overwrote (`restoreTo`, from
 * subscribeOrResubscribe's priorConfirmationSentAt) may be the delivery of a
 * link the recipient already holds; nulling it would exempt that link from
 * the DOI expiry and the purge sweep for good. So: restore that value when
 * there is one, null only when this attempt was the first ever. And the undo is
 * a compare-and-set on the exact pre-stamp THIS attempt wrote
 * (subscriber.confirmation_sent_at): a concurrent attempt that re-stamped the
 * row (its send may have succeeded) makes this a no-op. Also scoped to the
 * attempted email+token+pending so a correction that rotated the row keeps its
 * own stamp. Best-effort; never throws.
 */
async function releaseUnsentConfirmationStamp(subscriber, err, { restoreTo = null, dbh = db } = {}) {
  try {
    if (!subscriber || !subscriber.id || !subscriber.confirmation_sent_at) return false;
    if (err && err.code === 'confirmation_vetoed' && PERMANENT_VETO_REASONS.has(err.reason)) return false;
    const updated = await dbh('newsletter_subscribers')
      .where({
        id: subscriber.id,
        confirmation_token: subscriber.confirmation_token,
        status: 'pending',
        confirmation_sent_at: subscriber.confirmation_sent_at,
      })
      .whereRaw('LOWER(email) = ?', [String(subscriber.email || '').trim().toLowerCase()])
      .update({ confirmation_sent_at: restoreTo || null, updated_at: new Date() });
    return updated > 0;
  } catch (clearErr) {
    logger.warn(`[newsletter-confirm] confirmation_sent_at release failed for subscriber id=${subscriber && subscriber.id}: ${clearErr.code || clearErr.name || 'db_error'}`);
    return false;
  }
}

/**
 * Send (or re-send) a confirmation email. Idempotent at the SendGrid
 * level — re-firing it just lands a duplicate in the recipient's inbox,
 * which is the standard behavior for "didn't get my confirmation"
 * retries.
 *
 * Returns { messageId } on success; throws on SendGrid error so the
 * caller can decide whether to surface a 500 or swallow.
 *
 * Callers that already hold a transaction (row locks on the subscriber, the
 * fanout's hold gates) pass it as `{ dbh }` so the vetoes and the send share
 * that connection — a second pooled connection would deadlock a small pool
 * against the caller's own held connection. The caller should also take
 * lockCustomerEmail on the address BEFORE its own row locks (writers take the
 * address key first, then rows). Without `dbh` a transaction is opened here
 * and held through the provider call — the same discipline the billing and
 * bounce-recovery final-send boundaries use. Throws a
 * ConfirmationVetoedError (code 'confirmation_vetoed') — never sending — when
 * the address is suppressed / do-not-contact / unverifiable (see
 * assertConfirmationAllowed); callers treat it like any failed send.
 */
async function sendConfirmationEmail(subscriber, { dbh = null } = {}) {
  if (!subscriber || !subscriber.email || !subscriber.confirmation_token) {
    throw new Error('subscriber missing email or confirmation_token');
  }
  if (!sendgrid.isConfigured()) {
    throw new Error('SendGrid not configured (SENDGRID_API_KEY missing)');
  }
  const url = confirmationUrl(subscriber.confirmation_token);
  const firstName = (subscriber.first_name || '').trim();
  // Plain-text greeting is safe inline; HTML greeting must escape so a
  // crafted first_name (e.g. `<img src=x onerror=…>`) can't inject
  // markup into the trusted-sender confirmation email body.
  const greetingText = firstName ? `Hey ${firstName} —` : 'Hey there —';
  const greetingHtml = firstName ? `Hey ${escapeHtml(firstName)} —` : 'Hey there —';

  const html = wrapEmail({
    preheader: "One click and you're on the list.",
    heading: 'Confirm your subscription',
    intro: `${greetingHtml} thanks for signing up for the Waves Newsletter. Click the button below to confirm your email — no other steps, you're done after this.`,
    ctaHref: url,
    ctaLabel: 'Confirm subscription',
    footerNote: `If you didn't sign up, ignore this email and we'll never message you again. The link expires after a single use.`,
  });

  const text = [
    greetingText,
    '',
    `Thanks for signing up for the Waves Newsletter. Confirm your email by visiting the link below:`,
    '',
    url,
    '',
    "If you didn't sign up, ignore this email and we'll never message you again.",
    '',
    '— The Waves crew',
  ].join('\n');

  const handoff = async (trx) => {
    await assertConfirmationAllowed(subscriber, trx);
    // KNOWN LIMIT (owner ruling on PR #5390: document, no pipeline fence): the
    // address, suppression and ownership races are fenced by the locks above,
    // but a call-log do-not-contact request committed by ANOTHER call between
    // the read in assertConfirmationAllowed and the provider request is not.
    // Nothing fences call_log extraction writes (call-recording-processor
    // persists them at ~7 standalone sites before the call has a customer
    // link), and the other outbound vetoes (auto-text holds, first-touch
    // resume) read-then-send the same way. The read above is the last await
    // before sendOne, so the window is that gap only.
    // Confirmation emails are transactional — they must arrive even for
    // recipients who've previously unsubscribed from newsletter broadcasts.
    // Pass asmGroupId: 0 to bypass the SendGrid suppression group entirely.
    return sendgrid.sendOne({
      to: subscriber.email,
      // Newsletter confirmation is the legitimate use of the `newsletter@`
      // identity — name it explicitly so the intent is durable rather than
      // depending on sendgrid-mail's default (other callers should declare
      // their own identity; defaults are not policy).
      fromEmail: 'newsletter@wavespestcontrol.com',
      fromName: 'Waves Newsletter',
      subject: 'Confirm your Waves Newsletter signup',
      html,
      text,
      categories: ['newsletter_confirm'],
      asmGroupId: 0,
    });
  };
  const result = dbh && dbh.isTransaction ? await handoff(dbh) : await (dbh || db).transaction(handoff);
  // ID-only logging per AGENTS.md (no PII in logs).
  logger.info(`[newsletter-confirm] Confirmation email queued for subscriber id=${subscriber.id} (msgId=${result.messageId || 'n/a'})`);
  return result;
}

module.exports = {
  sendConfirmationEmail, confirmationUrl, assertConfirmationAllowed, ConfirmationVetoedError, releaseUnsentConfirmationStamp,
};
