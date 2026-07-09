/**
 * Legacy transactional email fallback — thin nodemailer wrapper over Google
 * Workspace SMTP (contact@wavespestcontrol.com). New customer-facing
 * operational emails should render through email-template-library first so
 * Waves owns template versions, validation, snapshots, and SendGrid events.
 *
 * Returns { ok, error? } so callers can treat email like SMS channels.
 */

const logger = require('./logger');
const { wrapServiceEmail, ctaButton, colors } = require('./email-template');

let cachedTransporter = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (!process.env.GOOGLE_SMTP_PASSWORD) return null;
  const nodemailer = require('nodemailer');
  cachedTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'contact@wavespestcontrol.com',
      pass: process.env.GOOGLE_SMTP_PASSWORD,
    },
  });
  return cachedTransporter;
}

// Legacy callers still reach this path when the template library is
// unavailable. Keep the body flexible, but use the same customer-facing
// chrome as the main transactional template.
function wrapHtml({ heading, body, ctaUrl, ctaLabel }) {
  const cta = ctaUrl && ctaLabel
    ? `<div style="margin:26px 0 14px 0;text-align:center;">${ctaButton(ctaUrl, ctaLabel)}</div>`
    : '';
  const headingHtml = heading
    ? `<h1 style="margin:0 0 16px 0;font-family:${colors.HEADING_FONT};font-size:28px;line-height:1.15;color:${colors.NAVY};font-weight:${colors.HEADING_WEIGHT};${colors.HEADING_TRACKING ? `letter-spacing:${colors.HEADING_TRACKING};` : ''}">${heading}</h1>`
    : '';
  return wrapServiceEmail({
    preheader: heading,
    body: `${headingHtml}<div style="font-size:15px;line-height:1.58;color:${colors.BODY};">${body || ''}</div>${cta}`,
  });
}

async function send({ to, subject, heading, body, ctaUrl, ctaLabel }) {
  if (!to) return { ok: false, error: 'No email address' };
  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'Email not configured (GOOGLE_SMTP_PASSWORD missing)' };
  try {
    await transporter.sendMail({
      from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
      to,
      subject,
      html: wrapHtml({ heading, body, ctaUrl, ctaLabel }),
    });
    return { ok: true };
  } catch (err) {
    logger.error(`[email] send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { send, wrapHtml };
