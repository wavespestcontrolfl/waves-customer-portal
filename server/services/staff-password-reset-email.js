const sendgrid = require('./sendgrid-mail');
const { wrapEmail } = require('./email-template');
const logger = require('./logger');

const RESET_LINK_TTL_MINUTES = 30;
const PRODUCTION_STAFF_RESET_ORIGIN = 'https://portal.wavespestcontrol.com';

function isProductionStaffResetEnvironment(env = process.env) {
  return env.NODE_ENV === 'production'
    || String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

function staffPasswordResetOrigin(env = process.env) {
  const configured = String(env.STAFF_PASSWORD_RESET_ORIGIN || '').trim();
  const raw = configured || PRODUCTION_STAFF_RESET_ORIGIN;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('STAFF_PASSWORD_RESET_ORIGIN must be an absolute URL');
  }

  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname && parsed.pathname !== '/')
  ) {
    throw new Error('STAFF_PASSWORD_RESET_ORIGIN must contain only an origin');
  }

  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const isProduction = isProductionStaffResetEnvironment(env);
  if (parsed.protocol !== 'https:' && !(!isProduction && isLoopback)) {
    throw new Error('STAFF_PASSWORD_RESET_ORIGIN must use HTTPS');
  }

  // A password-reset link is a credential. Production deliberately does not
  // inherit the broad public-portal fallback chain: an unrelated CLIENT_URL
  // or preview-domain edit must never redirect Staff credentials off-site.
  if (isProduction && parsed.origin !== PRODUCTION_STAFF_RESET_ORIGIN) {
    throw new Error(
      `Production Staff password resets must use ${PRODUCTION_STAFF_RESET_ORIGIN}`,
    );
  }

  return parsed.origin;
}

function staffPasswordResetUrl(token) {
  return `${staffPasswordResetOrigin()}/admin/reset-password#token=${encodeURIComponent(token)}`;
}

async function sendStaffPasswordResetEmail({ technicianId, email, token }) {
  if (!technicianId || !email || !token) {
    throw new Error('staff password reset email is missing required fields');
  }
  if (!sendgrid.isConfigured()) {
    throw Object.assign(new Error('SendGrid is not configured'), {
      definitelyNotQueued: true,
    });
  }

  let resetUrl;
  let html;
  let text;
  try {
    resetUrl = staffPasswordResetUrl(token);
    html = wrapEmail({
      preheader: 'Your one-time Waves staff password reset link.',
      heading: 'Reset your staff password',
      intro: 'A password reset was requested for your Waves staff account. Use the one-time link below within 30 minutes.',
      ctaHref: resetUrl,
      ctaLabel: 'Reset staff password',
      footerNote: "If you didn't request this, you can ignore the email. Your current password and sessions will remain unchanged.",
    });
    text = [
      'Reset your Waves staff password',
      '',
      `Open this one-time link within ${RESET_LINK_TTL_MINUTES} minutes:`,
      resetUrl,
      '',
      "If you didn't request this, ignore the email. Your current password and sessions will remain unchanged.",
    ].join('\n');
  } catch (error) {
    // No provider request has happened yet, so callers can safely clear the
    // persisted token instead of treating this configuration/render failure
    // like an ambiguous network response.
    error.definitelyNotQueued = true;
    throw error;
  }

  const result = await sendgrid.sendOne({
    to: email,
    fromEmail: 'contact@wavespestcontrol.com',
    fromName: 'Waves Pest Control',
    subject: 'Reset your Waves staff password',
    html,
    text,
    categories: ['staff_password_reset'],
    asmGroupId: 0,
    suppressErrorLog: true,
    disableTracking: true,
  });
  logger.info(`[staff-auth] Password reset email queued for technician id=${technicianId} (msgId=${result.messageId || 'n/a'})`);
  return result;
}

module.exports = {
  PRODUCTION_STAFF_RESET_ORIGIN,
  RESET_LINK_TTL_MINUTES,
  isProductionStaffResetEnvironment,
  sendStaffPasswordResetEmail,
  staffPasswordResetOrigin,
  staffPasswordResetUrl,
};
