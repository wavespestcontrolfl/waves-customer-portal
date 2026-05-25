const DEFAULT_INTERNAL_DOMAINS = ['wavespestcontrol.com'];
const DEFAULT_INTERNAL_EMAILS = [
  'contact@wavespestcontrol.com',
  'newsletter@wavespestcontrol.com',
  'events@wavespestcontrol.com',
  'weekly@wavespestcontrol.com',
  'automations@wavespestcontrol.com',
];

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function csvSet(value) {
  return new Set(String(value || '').split(',').map(normalizeEmail).filter(Boolean));
}

function internalEmailDomains() {
  const configured = String(process.env.INTERNAL_EMAIL_DOMAINS || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_INTERNAL_DOMAINS);
}

function internalEmailAllowlist() {
  return new Set([
    ...DEFAULT_INTERNAL_EMAILS,
    ...csvSet(process.env.INTERNAL_EMAIL_ALLOWLIST),
    ...csvSet(process.env.ADMIN_EMAIL_ALLOWLIST),
    ...csvSet(process.env.INTERNAL_TEST_EMAIL_ALLOWLIST),
  ]);
}

function isValidEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeEmail(email));
}

function isInternalEmailRecipient(email, { adminEmail } = {}) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return false;
  const admin = normalizeEmail(adminEmail);
  if (admin && normalized === admin) return true;
  if (internalEmailAllowlist().has(normalized)) return true;
  const domain = normalized.split('@')[1];
  return internalEmailDomains().has(domain);
}

function assertInternalEmailRecipient(email, context = {}) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    const err = new Error('valid internal toEmail required');
    err.status = 400;
    throw err;
  }
  if (!isInternalEmailRecipient(normalized, context)) {
    const err = new Error('test email recipient must be an internal/admin address');
    err.status = 400;
    throw err;
  }
  return normalized;
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  isInternalEmailRecipient,
  assertInternalEmailRecipient,
};
