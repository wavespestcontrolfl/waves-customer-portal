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

// The whole domain spoken after "at": "gmail.com", "yahoo.co.uk", or the
// spoken form "gmail dot com" / "yahoo dot co dot uk". A bare provider word
// ("at gmail") stays bare, so it never equals a full domain.
const wordOf = (token) => String(token || '').toLowerCase().replace(/[^a-z0-9.-]+$/, '');
function spokenDomainFrom(tokens, start) {
  let domain = wordOf(tokens[start]).replace(/\.+$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(domain)) return null;
  for (let j = start + 1; /^(?:dot|period|point)$/.test(wordOf(tokens[j]).replace(/\.+$/, '')); j += 2) {
    const label = wordOf(tokens[j + 1]).replace(/\.+$/, '');
    if (!/^[a-z0-9-]+$/.test(label)) break;
    domain += `.${label}`;
  }
  return domain;
}

// What may stand right before a spelled address: the start of the text, a
// sentence or speaker-label end ("Okay." "Caller:"), or a word that introduces
// it ("It's", "is", "so"). Anything else (a first name, "jane D-O-E") may be
// part of the address said aloud, so the spelling is not the whole address.
const INTRODUCERS = new Set(["it's", 'its', 'it', 'is', 'email', 'e-mail', 'address', 'so', 'okay', 'ok', 'yeah', 'yes', 'sure', 'be', 'um', 'uh', 'well', "that's", 'thats']);
const SENTENCE_END = /[.?:]$/;
// "T-A-M-I, Rowe, R-O-W-E": a spelled stretch that restarts within two words
// of an earlier one is one address interrupted, never a whole one.
const MAX_INTERRUPTION_WORDS = 2;
const stripQuotes = (token) => String(token || '').replace(/^["“(']+|["”)]+$/g, '');

// The spelled email statements in one transcript: a spelled run (three or more
// spelled letters) that ends directly on "at" / "@", paired with the whole
// domain spoken right after it. "It's F-L-E-T-C-H-E-R S-H-Y-L-A at gmail dot com" ->
// [{ local: 'fletchershyla', domain: 'gmail.com' }]; "Okay. S-C-L-A-Y 18 at yahoo.com" ->
// [{ local: 'sclay18', domain: 'yahoo.com' }]. A spelled name that runs into a
// word ("S-M-I-T-H. My email is ...") is not a statement. A statement that was
// interrupted, or does not start cleanly, carries local: null: it is evidence
// of an address the letters do not fully cover, so it keeps the card.
function spelledEmailStatements(text) {
  const tokens = String(text || '').replace(/[’‘]/g, "'").replace(PHONETIC_MARKER, '$1').split(/\s+/).filter(Boolean);
  const statements = [];
  let run = '';
  let letters = 0;
  let clean = false;
  let lastRunEnd = -Infinity;
  const endRun = (i) => {
    if (letters >= 2) lastRunEnd = i - 1;
    run = '';
    letters = 0;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const bare = stripQuotes(tokens[i]).replace(/[,;!?]+$/, '');
    if (/^(?:at|@)$/i.test(bare.replace(/[.:]+$/, ''))) {
      const domain = spokenDomainFrom(tokens, i + 1);
      if (letters >= MIN_SPELLED_LETTERS && domain) statements.push({ local: clean ? run : null, domain });
      endRun(i);
      continue;
    }
    // Hyphen-joined letters ("F-L-E-T") are one spelled stretch; a trailing
    // sentence period ("C-L-A-Y.") is punctuation, not a spoken "dot".
    for (const piece of bare.replace(/\.+$/, '').split('-').filter(Boolean)) {
      const unit = spelledUnit(piece);
      if (unit === null) { endRun(i); continue; }
      if (!run) {
        const prev = stripQuotes(tokens[i - 1]);
        const startsClean = i === 0 || SENTENCE_END.test(prev) || INTRODUCERS.has(prev.toLowerCase().replace(/,+$/, ''));
        clean = startsClean && i - lastRunEnd - 1 > MAX_INTERRUPTION_WORDS;
      }
      run += unit;
      if (/^[a-z]$/.test(unit)) letters += 1;
    }
  }
  return statements;
}

const KNOWN_DOMAIN_SET = new Set(KNOWN_DOMAINS);

// True when the call has at least one spelled email statement and EVERY spelled
// email statement in either transcript is this exact address (local part and
// the whole spoken domain), on a known consumer mail provider. A correction ("S-M-I-T-H at
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
  const statements = transcripts.filter(Boolean).flatMap((t) => spelledEmailStatements(String(t)));
  return statements.length > 0 && statements.every((st) => st.local === local && st.domain === domain);
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
