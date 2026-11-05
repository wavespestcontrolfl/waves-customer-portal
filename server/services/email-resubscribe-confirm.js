'use strict';

// The one email behind GATE_PORTAL_EMAIL_RESUBSCRIBE: "Turn Waves emails back on?".
// Sent to a holder's own address after they ask in the app (services/email-resubscribe.js
// requestResubscribeEmail). The button opens GET /api/public/email-resubscribe/:token,
// a read-only page; only the page's POST undoes the block.
//
// The address is unsubscribed by definition, so this send asks SendGrid to skip its global
// unsubscribe list (bypassUnsubscribeManagement; bounces and spam reports still block) and
// carries no ASM group (asmGroupId left unset). Tracking is off: the link is a one-time credential and must not
// pass through a click-tracking redirect.

const sendgrid = require('./sendgrid-mail');
const { wrapEmail } = require('./email-template');
const { publicPortalUrl } = require('../utils/portal-url');
const { EMAIL } = require('./email-resubscribe-copy');

// The newsletter confirmation's bound: the send runs while the address lock is held.
const SEND_TIMEOUT_MS = 10_000;

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function resubscribeUrl(token) {
  return `${publicPortalUrl()}/api/public/email-resubscribe/${token}`;
}

function buildConfirmationEmail({ token, firstName = '' }) {
  const name = String(firstName || '').trim();
  const url = resubscribeUrl(token);
  const html = wrapEmail({
    preheader: EMAIL.preheader,
    heading: EMAIL.heading,
    // wrapEmail inserts intro as raw HTML: the name is escaped here.
    intro: EMAIL.intro(name ? `Hi ${escapeHtml(name)},` : 'Hi there,'),
    ctaHref: url,
    ctaLabel: EMAIL.ctaLabel,
    footerNote: EMAIL.footerNote,
  });
  const text = [
    EMAIL.intro(name ? `Hi ${name},` : 'Hi there,'),
    '',
    `${EMAIL.ctaLabel}: ${url}`,
    '',
    EMAIL.footerNote,
  ].join('\n');
  return { subject: EMAIL.subject, html, text, url };
}

// Throws on a send failure (the caller records the error code and answers `failed`).
async function sendResubscribeConfirmation({ to, token, firstName, database }) {
  const { subject, html, text } = buildConfirmationEmail({ token, firstName });
  return sendgrid.sendOne({
    to,
    fromEmail: 'contact@wavespestcontrol.com',
    subject,
    html,
    text,
    categories: ['email_resubscribe_confirm'],
    disableTracking: true,
    bypassUnsubscribeManagement: true,
    suppressErrorLog: true,
    timeoutMs: SEND_TIMEOUT_MS,
    database,
  });
}

module.exports = { buildConfirmationEmail, sendResubscribeConfirmation, resubscribeUrl, escapeHtml, SEND_TIMEOUT_MS };
