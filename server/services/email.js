/**
 * Transactional email service — thin nodemailer wrapper over Google Workspace
 * SMTP (contact@wavespestcontrol.com). Not Beehiiv (that's marketing); this is
 * for one-off operational sends like follow-ups, onboarding nudges, and
 * dunning notices.
 *
 * Returns { ok, error? } so callers can treat email like SMS channels.
 */

const logger = require('./logger');

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

// Minimal HTML body with Waves branding. Keep inline styles — most email
// clients strip <style> blocks.
function wrapHtml({ heading, body, ctaUrl, ctaLabel }) {
  const cta = ctaUrl && ctaLabel
    ? `<p style="text-align:center;margin:24px 0;"><a href="${ctaUrl}" style="display:inline-block;padding:14px 28px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">${ctaLabel}</a></p>`
    : '';
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <h2 style="color:#0ea5e9;margin-top:0;">Waves Pest Control, LLC</h2>
      ${heading ? `<h3 style="margin:0 0 12px 0;">${heading}</h3>` : ''}
      <div style="font-size:15px;line-height:1.5;">${body}</div>
      ${cta}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
      <p style="color:#666;font-size:13px;">Questions? Call or text (941) 318-7612 or reply to this email.</p>
      <p style="color:#999;font-size:12px;">Waves Pest Control, LLC · Lakewood Ranch, FL</p>
    </div>
  `;
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
    logger.error(`[email] send failed to ${to}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { send, wrapHtml };
