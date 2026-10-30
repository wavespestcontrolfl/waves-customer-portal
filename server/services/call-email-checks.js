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

// "Caller:" / "Agent:" speaker labels in the primary transcript. The
// dictation pass has none; its mentions carry speaker null.
const SPEAKER_LABELS = [[/^(?:caller|customer):$/i, 'caller'], [/^(?:agent|staff|csr|rep):$/i, 'agent']];
// Our own addresses, which staff say on calls ("email us at ..."). Never the caller's.
const OWN_DOMAINS = new Set(['wavespestcontrol.com']);
// Provider names that mark "<word> at gmail" as an address even with no ".com".
// Everyday words among the provider labels (me, live, mac, cox, charter, att)
// are left out, so "look at me" is never an address.
const BARE_PROVIDER_LABELS = new Set(['gmail', 'googlemail', 'yahoo', 'ymail', 'hotmail', 'outlook', 'msn', 'icloud', 'aol', 'comcast', 'verizon', 'sbcglobal', 'bellsouth', 'earthlink', 'protonmail', 'proton']);

// "J-O" or "J-A-N-E" said as one word is the letters joined.
const joinHyphenLetters = (word) => (/^(?:[a-z0-9]-)+[a-z0-9]$/i.test(word) ? word.replace(/-/g, '') : word);

// An address written inline ("jane2@gmail.com", "J-A-N-E@gmail.com"), or null.
function inlineMention(bare, speaker) {
  const inline = bare.replace(/[.:]+$/, '').match(/^([^@\s]+)@([^@\s]+)$/);
  return inline ? { kind: 'said', local: joinHyphenLetters(inline[1]).toLowerCase(), domain: inline[2].toLowerCase(), speaker } : null;
}

// Every email address mentioned in one transcript: "<local> at <domain>".
//  - spelled: a spelled run (three or more spelled letters) ending directly on
//    "at" / "@". "It's F-L-E-T-C-H-E-R S-H-Y-L-A at gmail dot com" ->
//    { kind: 'spelled', local: 'fletchershyla', domain: 'gmail.com' }. A run that
//    was interrupted ("T-A-M-I, Rowe, R-O-W-E") or follows a spoken word that may
//    belong to the address ("jane D-O-E") has local: null.
//  - said: words before "at" with a dotted domain or a provider name
//    ("sclay18 at yahoo.com", "jane two at gmail dot com", "jane2 at gmail").
//    Only one word right after a clean start can stand for the whole local
//    part; anything else has local: null. An address written inline
//    ("jane2@gmail.com") is a said mention too.
// A spelled name that runs into a word ("S-M-I-T-H. My email is ...") is not a
// mention by itself. Returns { mentions, labeled }.
function emailMentions(text) {
  const tokens = String(text || '').replace(/[’‘]/g, "'").replace(PHONETIC_MARKER, '$1').split(/\s+/).filter(Boolean);
  const mentions = [];
  let labeled = false;
  let speaker = null;
  let run = '';
  let letters = 0;
  let clean = false;
  let lastRunEnd = -Infinity;
  const endRun = (i) => {
    if (letters >= 2) lastRunEnd = i - 1;
    run = '';
    letters = 0;
  };
  const cleanStartAt = (i) => {
    const prev = stripQuotes(tokens[i - 1]);
    return i === 0 || SENTENCE_END.test(prev) || INTRODUCERS.has(prev.toLowerCase().replace(/,+$/, ''))
      || SPEAKER_LABELS.some(([re]) => re.test(prev));
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = stripQuotes(tokens[i]);
    const label = SPEAKER_LABELS.find(([re]) => re.test(raw));
    if (label) {
      labeled = true;
      speaker = label[1];
      endRun(i);
      continue;
    }
    const bare = raw.replace(/[,;!?]+$/, '');
    // An address written inline is a said mention, so a correction typed out
    // this way still conflicts.
    const inline = inlineMention(bare, speaker);
    if (inline || /^(?:at|@)$/i.test(bare.replace(/[.:]+$/, ''))) {
      const mention = inline || atMention(tokens, i, { run, letters, clean, speaker, cleanStartAt });
      if (mention) mentions.push(mention);
      endRun(i);
      continue;
    }
    // Hyphen-joined letters ("F-L-E-T") are one spelled stretch; a trailing
    // sentence period ("C-L-A-Y.") is punctuation, not a spoken "dot".
    for (const piece of bare.replace(/\.+$/, '').split('-').filter(Boolean)) {
      const unit = spelledUnit(piece);
      if (unit === null) { endRun(i); continue; }
      if (!run) clean = cleanStartAt(i) && i - lastRunEnd - 1 > MAX_INTERRUPTION_WORDS;
      run += unit;
      if (/^[a-z]$/.test(unit)) letters += 1;
    }
  }
  return { mentions, labeled };
}

// The mention an "at" at token i closes: the spelled run before it, or the one
// word said before it (a dotted domain or a provider name after it), or null.
function atMention(tokens, i, { run, letters, clean, speaker, cleanStartAt }) {
  const domain = spokenDomainFrom(tokens, i + 1);
  if (!domain) return null;
  if (letters >= MIN_SPELLED_LETTERS) return { kind: 'spelled', local: clean ? run : null, domain, speaker };
  if (i === 0 || !(domain.includes('.') || BARE_PROVIDER_LABELS.has(domain))) return null;
  const word = joinHyphenLetters(stripQuotes(tokens[i - 1]).toLowerCase().replace(/[,;:!?.]+$/, ''));
  return { kind: 'said', local: cleanStartAt(i - 1) && word ? word : null, domain, speaker };
}

const KNOWN_DOMAIN_SET = new Set(KNOWN_DOMAINS);

// How one mention bears on the saved address: 'conflict' (a different or
// unclear address), 'agrees' (consistent, not evidence: a said mention or a
// bare provider), or 'spelled' (a spelled mention of exactly this address).
// A bare provider ("at gmail") agrees only when its word and provider name both
// match, and it is never evidence: the domain itself was not said.
function mentionVerdict(m, local, domain) {
  const bare = !m.domain.includes('.');
  if (m.local !== local || m.domain !== (bare ? domain.split('.')[0] : domain)) return 'conflict';
  return m.kind === 'spelled' && !bare ? 'spelled' : 'agrees';
}

// The 2026-10-05 rule without AI. True only when:
//  - the saved address is on a known consumer mail provider (a custom domain is
//    usually said, not spelled, and a misheard one can belong to someone else);
//  - the CALLER spelled exactly this address (local part and the whole spoken
//    domain) from a clean start. In a labeled transcript an agent's spelling or
//    read-back alone is not the caller's; an unlabeled dictation pass counts;
//  - and no other address is mentioned in either transcript: a correction
//    ("No, jane two at gmail dot com"), an interrupted or mixed spelling, a
//    bare provider ("at gmail"), or a different address all keep the card.
function spelledEmailMatches({ transcripts = [], email } = {}) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!KNOWN_DOMAIN_SET.has(domain)) return false;
  if ((local.match(/[a-z]/g) || []).length < MIN_SPELLED_LETTERS) return false;
  // Speaker rule as in contact-dictation.js callerTurnWithSpelling: a labeled
  // Caller: spelling counts; an unlabeled copy (the dictation pass) counts
  // unless a labeled transcript puts the spelling only in an Agent: turn (then
  // the unlabeled copy is the employee's too).
  const spelledBy = { caller: false, agent: false, unlabeled: false };
  for (const text of transcripts.filter(Boolean)) {
    const { mentions, labeled } = emailMentions(String(text));
    for (const m of mentions.filter((x) => !OWN_DOMAINS.has(x.domain))) {
      const verdict = mentionVerdict(m, local, domain);
      if (verdict === 'conflict') return false;
      if (verdict === 'spelled') spelledBy[labeled ? m.speaker || 'none' : 'unlabeled'] = true;
    }
  }
  return spelledBy.caller || (spelledBy.unlabeled && !spelledBy.agent);
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
  emailMentions,
  spelledEmailMatches,
  checkEmailDomain,
  screenCallEmail,
  deadDomainQuestion,
  isNoMailServerReason,
  MIN_SPELLED_LETTERS,
};
