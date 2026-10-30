// Deterministic checks on an email heard on a call (owner 2026-10-29, after the
// call-agent audit; dark behind GATE_CALL_EMAIL_CHECKS, reader
// callEmailChecksLive() in server/config/feature-gates.js). No AI, and nothing
// here sends anything:
//   - spelledEmailMatches: the owner's 2026-10-05 rule read straight from the
//     transcripts. The caller spelled the address letter by letter and the
//     spelled letters ARE the saved address, so no read-back card is owed. Until
//     now only the Gemini dictation decoder could prove that, so every spelled
//     email was held whenever Gemini failed (capped from 2026-10-24).
//   - checkEmailDomain: does the domain have a mail server at all? Reuses the
//     quarantine arbiter's DNS evidence (MX, implicit A/AAAA, RFC 7505 null MX).
//   - isNoMailServerReason: a SendGrid failure that says the domain has no mail
//     server, which SendGrid files as a "blocked" bounce.
const { KNOWN_DOMAINS } = require('../utils/email-typo-correction');

// Safe against suites that mock feature-gates with a partial object.
function callEmailChecksLive() {
  return require('../config/feature-gates').callEmailChecksLive?.() === true;
}

// "S as in Sam", "M like Mary", "G for good" are the letter itself, as in
// contact-dictation.js spelledLetterRuns. That helper keeps letters only; an
// email's local part also carries digits, dots and underscores, so the units
// here are wider.
const PHONETIC_MARKER = /\b([A-Za-z])\s+(?:as|like|for)\s+(?:in\s+)?[A-Za-z]+/gi;
const DIGIT_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const SYMBOL_WORDS = { dot: '.', period: '.', point: '.', underscore: '_', dash: '-', hyphen: '-' };
const MIN_SPELLED_LETTERS = 3;

// One spelled unit per token: a single letter, a digit run, a digit word, or a
// spoken symbol. Every other token (a whole word, "at") ends the run, so a run
// can only be built from what the caller spelled.
function spelledUnit(token) {
  if (/^[A-Za-z]$/.test(token)) return token.toLowerCase();
  if (/^\d+$/.test(token)) return token;
  const word = token.toLowerCase();
  if (DIGIT_WORDS[word]) return DIGIT_WORDS[word];
  if (SYMBOL_WORDS[word]) return SYMBOL_WORDS[word];
  return null;
}

// The spelled email statements in one transcript: a spelled run (three or more
// spelled letters) that ends directly on "at" / "@", paired with the provider
// word right after it. "F-L-E-T-C-H-E-R S-H-Y-L-A at gmail dot com" ->
// [{ local: 'fletchershyla', provider: 'gmail' }]; "S-C-L-A-Y 18 at yahoo.com" ->
// [{ local: 'sclay18', provider: 'yahoo' }]. A spelled name that runs into a
// word ("S-M-I-T-H. My email is ...") is not a statement: the evidence must be
// the email itself, not a name spelled elsewhere on the call.
function spelledEmailStatements(text) {
  const reduced = String(text || '').replace(PHONETIC_MARKER, '$1');
  const tokens = reduced.split(/[\s,;:!?"“”()]+/).filter(Boolean);
  const statements = [];
  let run = '';
  let letters = 0;
  const reset = () => { run = ''; letters = 0; };
  for (let i = 0; i < tokens.length; i += 1) {
    if (/^(?:at|@)$/i.test(tokens[i])) {
      const provider = String(tokens[i + 1] || '').toLowerCase().replace(/[^a-z0-9.]+$/, '').split('.')[0];
      if (letters >= MIN_SPELLED_LETTERS && provider) statements.push({ local: run, provider });
      reset();
      continue;
    }
    // Hyphen-joined letters ("F-L-E-T") are one spelled stretch; a trailing
    // sentence period ("C-L-A-Y.") is punctuation, not a spoken "dot".
    for (const piece of tokens[i].replace(/\.+$/, '').split('-').filter(Boolean)) {
      const unit = spelledUnit(piece);
      if (unit === null) { reset(); continue; }
      run += unit;
      if (/^[a-z]$/.test(unit)) letters += 1;
    }
  }
  return statements;
}

const KNOWN_DOMAIN_SET = new Set(KNOWN_DOMAINS);

// True when the call has at least one spelled email statement and EVERY spelled
// email statement in either transcript is this exact address (local part and
// provider), on a known consumer mail provider. A correction ("S-M-I-T-H at
// gmail, no, S-M-Y-T-H at gmail") or the two transcripts hearing different
// letters keeps the read-back card. A custom domain is never trusted this way:
// it is usually said, not spelled, and a misheard one can belong to someone else.
function spelledEmailMatches({ transcripts = [], email } = {}) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!KNOWN_DOMAIN_SET.has(domain)) return false;
  if ((local.match(/[a-z]/g) || []).length < MIN_SPELLED_LETTERS) return false;
  const provider = domain.split('.')[0];
  const statements = transcripts.filter(Boolean).flatMap((t) => spelledEmailStatements(String(t)));
  return statements.length > 0 && statements.every((st) => st.local === local && st.provider === provider);
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
async function screenCallEmail(extracted, { transcripts = [], deps = {} } = {}) {
  if (!extracted?.email) return null;
  const domainCheck = await checkEmailDomain(extracted.email, deps);
  if (domainCheck?.deliverable === false) {
    if (!extracted.email_raw) extracted.email_raw = extracted.email;
    extracted.email = null;
    return { dead_domain: domainCheck };
  }
  return {
    spelled_match: spelledEmailMatches({ transcripts, email: extracted.email }),
    domain_deliverable: domainCheck?.deliverable ?? null,
  };
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
  spelledEmailStatements,
  spelledEmailMatches,
  checkEmailDomain,
  screenCallEmail,
  deadDomainQuestion,
  isNoMailServerReason,
  MIN_SPELLED_LETTERS,
};
