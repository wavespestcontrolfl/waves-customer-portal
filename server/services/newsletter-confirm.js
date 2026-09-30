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

class ConfirmationVetoedError extends Error {
  constructor(reason) {
    super(`confirmation email vetoed: ${reason}`);
    this.name = 'ConfirmationVetoedError';
    this.code = 'confirmation_vetoed';
    this.reason = reason;
  }
}

/**
 * The one outbound veto for a newsletter confirmation email. The send below
 * deliberately bypasses SendGrid's suppression group (asmGroupId: 0 — a
 * prior newsletter unsubscribe must not stop a fresh, deliberate re-signup
 * confirmation), so the app-level vetoes have to run here, before the
 * provider call, for EVERY caller (public form, quote wizard, admin import,
 * call pipeline, email fanout).
 *
 *  - email_suppressions: an active bounce / spam_complaint / do_not_email row
 *    (any stream) or an ungrouped row, on this mailbox under ANY Gmail
 *    spelling — the same rule newsletter-sender's excludeGloballySuppressed
 *    applies. A group-scoped newsletter unsubscribe does NOT veto: the
 *    subscriber is asking back in.
 *  - do-not-contact: a call_log consent.do_not_contact_request on the linked
 *    customer OR on any customer profile carrying this mailbox in any of its email columns.
 *
 * Fail closed: a lookup that throws means the address could not be cleared,
 * so nothing is sent. Vetoes are not surfaced to anonymous callers — every
 * caller already swallows a send error and answers uniformly.
 */
async function assertConfirmationAllowed(subscriber, dbh = db) {
  const emailLc = String(subscriber.email || '').trim().toLowerCase();
  try {
    const { suppressionCoversEmail } = require('../utils/email-equivalence');
    const suppression = await dbh('email_suppressions')
      .where(suppressionCoversEmail(emailLc))
      .where({ status: 'active' })
      .where(function globalOrUngrouped() {
        this.whereRaw('LOWER(suppression_type) IN (?, ?, ?)', GLOBAL_SUPPRESSION_TYPES)
          .orWhereNull('group_key')
          .orWhere('group_key', '');
      })
      .first('id');
    if (suppression) throw new ConfirmationVetoedError('address_suppressed');

    const { GOOGLE_MAILBOX_SQL, googleMailboxIdentity, CUSTOMER_EMAIL_COLUMNS } = require('../utils/customer-comms-lock');
    const customerIds = new Set();
    if (subscriber.customer_id) customerIds.add(subscriber.customer_id);
    const mailbox = googleMailboxIdentity(emailLc);
    const profiles = await dbh('customers')
      .where(function sameMailbox() {
        for (const col of CUSTOMER_EMAIL_COLUMNS) {
          this.orWhereRaw(`LOWER(${col}) = ?`, [emailLc]);
          if (mailbox) {
            this.orWhereRaw(
              `(${GOOGLE_MAILBOX_SQL.isGoogle(col)} AND ${GOOGLE_MAILBOX_SQL.mailbox(col)} = ?)`,
              [mailbox.split('@')[0]],
            );
          }
        }
      })
      .select('id');
    for (const row of profiles || []) customerIds.add(row.id);
    if (customerIds.size) {
      const { customerCallDoNotContact } = require('./lead-first-touch-resume');
      for (const id of customerIds) {
        if (await customerCallDoNotContact(id, dbh)) throw new ConfirmationVetoedError('do_not_contact');
      }
    }
  } catch (err) {
    if (err instanceof ConfirmationVetoedError) throw err;
    // ID-only, no address, per AGENTS.md.
    logger.warn(`[newsletter-confirm] veto check failed for subscriber id=${subscriber.id}: ${err.code || err.name || 'error'} — not sending`);
    throw new ConfirmationVetoedError('veto_unverifiable');
  }
}

/**
 * Send (or re-send) a confirmation email. Idempotent at the SendGrid
 * level — re-firing it just lands a duplicate in the recipient's inbox,
 * which is the standard behavior for "didn't get my confirmation"
 * retries.
 *
 * Returns { messageId } on success; throws on SendGrid error so the
 * caller can decide whether to surface a 500 or swallow. Throws a
 * ConfirmationVetoedError (code 'confirmation_vetoed') — never sending — when
 * the address is suppressed / do-not-contact / unverifiable (see
 * assertConfirmationAllowed); callers treat it like any failed send.
 */
async function sendConfirmationEmail(subscriber) {
  if (!subscriber || !subscriber.email || !subscriber.confirmation_token) {
    throw new Error('subscriber missing email or confirmation_token');
  }
  if (!sendgrid.isConfigured()) {
    throw new Error('SendGrid not configured (SENDGRID_API_KEY missing)');
  }
  await assertConfirmationAllowed(subscriber);

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

  // Confirmation emails are transactional — they must arrive even for
  // recipients who've previously unsubscribed from newsletter broadcasts.
  // Pass asmGroupId: 0 to bypass the SendGrid suppression group entirely.
  const result = await sendgrid.sendOne({
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
  // ID-only logging per AGENTS.md (no PII in logs).
  logger.info(`[newsletter-confirm] Confirmation email queued for subscriber id=${subscriber.id} (msgId=${result.messageId || 'n/a'})`);
  return result;
}

module.exports = { sendConfirmationEmail, confirmationUrl, assertConfirmationAllowed, ConfirmationVetoedError };
