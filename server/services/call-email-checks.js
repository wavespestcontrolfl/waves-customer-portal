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
const { KNOWN_DOMAINS, damerauLevenshtein } = require('../utils/email-typo-correction');

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

// The runs a transcript spells: "F-L-E-T-C-H-E-R S-H-Y-L-A at gmail" -> ["fletchershyla"],
// "S-C-L-A-Y 18" -> ["sclay18"]. A run counts only with at least three spelled letters.
function spelledRuns(text) {
  const reduced = String(text || '').replace(PHONETIC_MARKER, '$1');
  const runs = [];
  let run = '';
  let letters = 0;
  const close = () => {
    if (letters >= MIN_SPELLED_LETTERS) runs.push(run);
    run = '';
    letters = 0;
  };
  for (const raw of reduced.split(/[\s,;:!?"“”()]+/).filter(Boolean)) {
    // Hyphen-joined letters ("F-L-E-T") are one spelled stretch; a trailing
    // sentence period ("C-L-A-Y.") is punctuation, not a spoken "dot".
    for (const token of raw.replace(/\.+$/, '').split('-').filter(Boolean)) {
      const unit = spelledUnit(token);
      if (unit === null) { close(); continue; }
      run += unit;
      if (/^[a-z]$/.test(unit)) letters += 1;
    }
  }
  close();
  return runs;
}

const KNOWN_DOMAIN_SET = new Set(KNOWN_DOMAINS);

// A spelled run that is close to the saved local part but not equal to it: the
// two transcripts (or two passes of the spelling) heard different letters.
const NEAR_MISS_EDITS = 2;
const isNearMiss = (run, local) => run !== local && damerauLevenshtein(run, local) <= NEAR_MISS_EDITS;

// True when a transcript shows the caller spelling this exact local part, no
// transcript spells a near-miss of it, the domain is a known consumer mail
// provider, and the provider's name was said on the call. A custom domain is
// never trusted this way: it is usually said, not spelled, and a misheard one
// can belong to someone else.
function spelledEmailMatches({ transcripts = [], email } = {}) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!KNOWN_DOMAIN_SET.has(domain)) return false;
  if ((local.match(/[a-z]/g) || []).length < MIN_SPELLED_LETTERS) return false;
  const provider = domain.split('.')[0];
  const texts = transcripts.filter(Boolean).map(String);
  const providerSaid = texts.some((t) => new RegExp(`\\b${provider}\\b`, 'i').test(t));
  if (!providerSaid) return false;
  const runs = texts.flatMap((t) => spelledRuns(t));
  return runs.includes(local) && !runs.some((run) => isNearMiss(run, local));
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
  spelledRuns,
  spelledEmailMatches,
  checkEmailDomain,
  screenCallEmail,
  deadDomainQuestion,
  isNoMailServerReason,
  MIN_SPELLED_LETTERS,
};
