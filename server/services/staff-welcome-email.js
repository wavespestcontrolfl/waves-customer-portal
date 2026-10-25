/**
 * Welcome email for a new staff hire (GATE_HIRED_PACKET): a one-time
 * set-password link that works 7 days, plus a pointer to the Onboarding card.
 * Mirrors sendStaffPasswordResetEmail: the link rides in the URL fragment, the
 * token is never logged, and a failure before the provider call carries
 * definitelyNotQueued so the caller may clear the stored token.
 */
const sendgrid = require('./sendgrid-mail');
const { wrapEmail } = require('./email-template');
const logger = require('./logger');
const { staffPasswordResetUrl } = require('./staff-password-reset-email');

const HIRE_LINK_TTL_DAYS = 7;
const HIRE_LINK_TTL_MS = HIRE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A DATE column read by node-postgres is a JS Date at LOCAL midnight; a
// request body or test fixture is already 'YYYY-MM-DD'. Either way the result
// is the calendar date as written, with no timezone shift.
function dateOnlyParts(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

// 'Monday, January 4' for a date-only value; null when there is no date.
function formatFirstDay(value) {
  const parts = dateOnlyParts(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

async function sendStaffWelcomeEmail({ technicianId, email, token, firstName, firstDay }) {
  if (!technicianId || !email || !token) {
    throw new Error('staff welcome email is missing required fields');
  }
  if (!sendgrid.isConfigured()) {
    throw Object.assign(new Error('SendGrid is not configured'), {
      definitelyNotQueued: true,
    });
  }

  let url;
  let html;
  let text;
  try {
    url = staffPasswordResetUrl(token);
    const name = firstNameOf(firstName);
    const day = formatFirstDay(firstDay);
    const introText = `Hi ${name}, set your password to open the Waves staff app. Then complete the documents on your Onboarding card${day ? ` before your first day, ${day}` : ' before your first day'}.`;
    const footerText = `This link works for ${HIRE_LINK_TTL_DAYS} days. If it expires, ask the office to send a new one.`;
    html = wrapEmail({
      preheader: 'Set your password to open the Waves staff app.',
      heading: 'Welcome to Waves Pest Control',
      intro: escapeHtml(introText),
      ctaHref: url,
      ctaLabel: 'Set your password',
      footerNote: footerText,
    });
    text = [
      'Welcome to Waves Pest Control',
      '',
      introText,
      '',
      'Set your password:',
      url,
      '',
      footerText,
    ].join('\n');
  } catch (error) {
    // No provider request has happened yet, so the caller can safely clear
    // the stored token instead of treating this like an ambiguous response.
    error.definitelyNotQueued = true;
    throw error;
  }

  const result = await sendgrid.sendOne({
    to: email,
    fromEmail: 'contact@wavespestcontrol.com',
    fromName: 'Waves Pest Control',
    subject: 'Welcome to Waves Pest Control',
    html,
    text,
    categories: ['staff_welcome'],
    asmGroupId: 0,
    suppressErrorLog: true,
    disableTracking: true,
  });
  logger.info(`[staff-welcome] Welcome email queued for technician id=${technicianId} (msgId=${result.messageId || 'n/a'})`);
  return result;
}

module.exports = {
  HIRE_LINK_TTL_DAYS,
  HIRE_LINK_TTL_MS,
  formatFirstDay,
  sendStaffWelcomeEmail,
};
