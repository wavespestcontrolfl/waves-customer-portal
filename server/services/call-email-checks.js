// Deterministic checks on an email heard on a call (owner 2026-10-29, after the
// call-agent audit; dark behind GATE_CALL_EMAIL_CHECKS, reader
// callEmailChecksLive() in server/config/feature-gates.js). No AI, and nothing
// here sends anything:
//   - checkEmailDomain / screenCallEmail: does the domain have a mail server at
//     all? Reuses the quarantine arbiter's DNS evidence (MX, implicit A/AAAA,
//     RFC 7505 null MX). A dead domain is set aside before the upserts.
//   - isNoMailServerReason: a SendGrid failure that says the domain has no mail
//     server, which SendGrid files as a "blocked" bounce.

// Safe against suites that mock feature-gates with a partial object.
function callEmailChecksLive() {
  return require('../config/feature-gates').callEmailChecksLive?.() === true;
}

// { domain, deliverable: true | false | null, dns_error } or null. `false` only
// on an authoritative answer (no such domain, or no MX and no address record,
// or a null MX); a resolver hiccup is null and never blocks anything.
async function checkEmailDomain(email, deps = {}) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  try {
    const { gatherEmailDomainEvidence } = require('./contact-quarantine-arbiter');
    const [evidence] = await gatherEmailDomainEvidence([value], deps);
    if (!evidence) return null;
    return { domain: evidence.domain, deliverable: evidence.deliverable, dns_error: evidence.dns_error || null };
  } catch {
    return null;
  }
}

// The call processor's step, after every adopt and hold and before the upserts.
// Mutates `extracted` the way the dictation quarantine does: a domain with no
// mail server moves the address to email_raw, so no write or send path can use
// it. Returns the note the card decision reads, or null when there is nothing
// to check.
async function screenCallEmail(extracted, { deps = {} } = {}) {
  if (!extracted?.email) return null;
  const domainCheck = await checkEmailDomain(extracted.email, deps);
  if (domainCheck?.deliverable === false) {
    if (!extracted.email_raw) extracted.email_raw = extracted.email;
    extracted.email = null;
    return { dead_domain: domainCheck };
  }
  return { domain_deliverable: domainCheck?.deliverable ?? null };
}

// The card text the office reads for an address whose domain has no mail server.
function deadDomainQuestion(domain) {
  return `No mail server answers for "${domain}". Ask the caller to spell the whole email again.`;
}

// SendGrid's own wording for a domain with no mail server ("unable to get mx
// info: ..."), plus the common resolver phrasings receiving relays return.
const NO_MAIL_SERVER_REASON = /unable to get mx info|\bno mx record|\bnxdomain\b|host or domain name not found|domain (?:name )?not found|no such domain/i;

function isNoMailServerReason(text) {
  return NO_MAIL_SERVER_REASON.test(String(text || ''));
}

module.exports = {
  callEmailChecksLive,
  checkEmailDomain,
  screenCallEmail,
  deadDomainQuestion,
  isNoMailServerReason,
};
