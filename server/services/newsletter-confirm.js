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
const { wrapEmail } = require('./email-template');
const logger = require('./logger');

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
  const baseUrl = process.env.PUBLIC_PORTAL_URL || 'https://portal.wavespestcontrol.com';
  return `${baseUrl}/api/public/newsletter/confirm/${token}`;
}

/**
 * Send (or re-send) a confirmation email. Idempotent at the SendGrid
 * level — re-firing it just lands a duplicate in the recipient's inbox,
 * which is the standard behavior for "didn't get my confirmation"
 * retries.
 *
 * Returns { messageId } on success; throws on SendGrid error so the
 * caller can decide whether to surface a 500 or swallow.
 */
async function sendConfirmationEmail(subscriber) {
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
    intro: `${greetingHtml} thanks for signing up for The Waves Newsletter. Click the button below to confirm your email — no other steps, you're done after this.`,
    ctaHref: url,
    ctaLabel: 'Confirm subscription',
    footerNote: `If you didn't sign up, ignore this email and we'll never message you again. The link expires after a single use.`,
  });

  const text = [
    greetingText,
    '',
    `Thanks for signing up for The Waves Newsletter. Confirm your email by visiting the link below:`,
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

module.exports = { sendConfirmationEmail, confirmationUrl };
