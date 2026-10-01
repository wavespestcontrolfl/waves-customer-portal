// Log-safe text: contact details are scrubbed before an error message reaches a log line
// (AGENTS.md: no PII in logs). Provider and database errors can echo the recipient address.
// The single email redactor; email-template-library re-exports it as redactEmailAddresses.

const EMAIL = /[^\s@:<>()"']+@[^\s@:<>()"']+\.[^\s@:<>()"']+/g;
// E.164 or a formatted 10+ digit run.
const PHONE = /\+?\(?\d[\d\s().-]{8,}\d/g;

function redactEmailAddresses(text) {
  return String(text || '').replace(EMAIL, '[redacted-email]');
}

function redactContact(text) {
  return redactEmailAddresses(text).replace(PHONE, '[redacted-phone]');
}

module.exports = { redactEmailAddresses, redactContact };
