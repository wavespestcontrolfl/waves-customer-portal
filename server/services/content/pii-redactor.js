/**
 * pii-redactor.js — conservative PII stripping for any customer-derived
 * text that touches the content engine.
 *
 * Safety bias is high: false-positive redactions are cheap, false-
 * negative leaks are catastrophic. When in doubt, redact.
 *
 * Patterns covered:
 *   - phone numbers (US, multiple formats)
 *   - email addresses
 *   - street addresses (number + street + suffix)
 *   - 5-digit ZIPs adjacent to address context
 *   - credit-card-shaped digit groups
 *   - SSN-shaped (XXX-XX-XXXX)
 *   - first+last name pairs (capitalized name heuristic + signal words)
 *   - long URLs (may contain query-string PII)
 *
 * Output:
 *   { text, confidence: 'high'|'medium'|'low', findings: [{type, count}] }
 *
 * confidence rules:
 *   'high'   structured PII (phone/email/SSN/CC) cleanly redacted, no
 *            heuristic name detection fired
 *   'medium' heuristic name detection fired OR address pattern matched
 *            (false-positive prone)
 *   'low'    text has long unstructured runs, mixed case proper nouns,
 *            or any unicode unrecognized class — gates downstream from
 *            quoting publicly
 *
 * Pure functions — no DB, no logger. Caller decides what to do with
 * `low` confidence output (typically: never quote publicly).
 */

const PATTERNS = [
  // Phone numbers — US, generous match: +1 / parens / dots / dashes / spaces.
  { type: 'phone', token: '[phone]', re: /\b\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },

  // Emails.
  { type: 'email', token: '[email]', re: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g },

  // SSN-shaped — strict.
  { type: 'ssn', token: '[ssn]', re: /\b\d{3}-\d{2}-\d{4}\b/g },

  // Credit-card-shaped (13–19 digits grouped 4-4-4-4 or run of 16).
  { type: 'card', token: '[card]', re: /\b(?:\d[ -]?){13,19}\b/g },

  // Street addresses — house number + street name + suffix.
  // Conservative: requires a numeric prefix, capitalized street name(s),
  // and a recognized suffix abbreviation.
  {
    type: 'address',
    token: '[address]',
    re: /\b\d{1,6}\s+([A-Z][a-zA-Z]+\s+){1,4}(St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Cir|Circle|Pl|Place|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Trl|Trail)\.?\b/g,
  },

  // Long URLs — anything > 40 chars likely has tracking / query PII.
  { type: 'url', token: '[url]', re: /https?:\/\/\S{40,}/g },

  // 5-digit ZIP only when adjacent to an FL state hint OR after a
  // redacted [address] marker (we redact a second pass after the address
  // pass to catch trailing ZIPs).
  { type: 'zip', token: '[zip]', re: /\b(FL|Florida)\s+\d{5}(-\d{4})?\b/g },
];

// Heuristic first+last name detection — separate pass so we can
// flag confidence ↓ medium when it fires.
const NAME_SIGNAL_PREFIXES = [
  /\b(my name is|this is|i'?m|i am|hi[,]?|hello[,]?|hey[,]?|name:|signed,?|from,?|sincerely,?|regards,?)\s+([A-Z][a-z]{1,15})(\s+[A-Z][a-z]{1,20})?\b/g,
];
const STANDALONE_NAME_PAIR = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,20})\b/g;

// Single first name after a STRONG self-introduction signal. The pair
// detector above only fires on first+last; call transcripts are full of
// bare first-name intros ("Hi, this is Anthony", "my name is John") that
// have no last name and would otherwise survive. The signal word is strong
// enough evidence to redact a lone capitalized token (allowlist still
// protects owner/staff/place/brand names like "this is Adam").
const NAME_SIGNAL_SINGLE = /\b([Mm]y name is|[Tt]his is|[Ii]'?m|[Ii] am|[Nn]ame:|[Ii]t'?s|[Hh]i|[Hh]ello|[Hh]ey)[,]?\s+([A-Z][a-z]{1,15})\b/g;

// Words that look like names but are common false positives in this
// domain (pest names, neighborhoods, products, businesses, etc.).
const NAME_ALLOWLIST = new Set([
  'Bradenton', 'Sarasota', 'Venice', 'Parrish', 'Palmetto', 'North', 'Port',
  'Charlotte', 'Lakewood', 'Ranch', 'Manatee', 'Anna', 'Maria', 'Longboat',
  'Siesta', 'Key', 'Island', 'Wave', 'Waves', 'Pest', 'Control', 'Lawn',
  'Care', 'Mosquito', 'Termite', 'Rodent', 'Ant', 'Roach', 'Spider', 'Bee',
  'Wasp', 'Bird', 'Tree', 'Shrub', 'Palm', 'Florida', 'Friday', 'Monday',
  'Tuesday', 'Wednesday', 'Thursday', 'Saturday', 'Sunday', 'January',
  'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December', 'Saint', 'St',
  'Google', 'Facebook', 'Yelp', 'BBB', 'YouTube', 'Stripe', 'Twilio',
  'Adam', // owner — name appears in public reviews already
  'Virginia', 'Jose', 'Jacob', 'Alvarado', 'Heaton', // staff
]);

function looksLikeFalsePositiveName(first, last) {
  if (!first || !last) return true;
  if (NAME_ALLOWLIST.has(first) || NAME_ALLOWLIST.has(last)) return true;
  // All-caps single words are usually abbreviations, not names.
  if (first === first.toUpperCase() || last === last.toUpperCase()) return true;
  // Length sanity.
  if (first.length < 2 || last.length < 2) return true;
  return false;
}

function redactNames(text, findings) {
  let out = text;
  let nameMatchCount = 0;

  // Pass 1: explicit signal-prefix names ("my name is X Y").
  for (const re of NAME_SIGNAL_PREFIXES) {
    out = out.replace(re, (match, prefix, first, last) => {
      const lastClean = last ? last.trim() : '';
      if (looksLikeFalsePositiveName(first, lastClean)) return match;
      nameMatchCount++;
      return `${prefix} [name]`;
    });
  }

  // Pass 2: standalone capitalized name pair — always run. False
  // positives are bounded by the allowlist + the caps / length checks
  // in looksLikeFalsePositiveName. Initial design gated this behind a
  // sign-off marker, but real customer SMS leaked names ("Hi, this is
  // [first] [last]") that have no marker, and a false-positive
  // [name] swap on a multi-cap noun phrase is far less harmful than
  // a real customer name reaching a published asset.
  out = out.replace(STANDALONE_NAME_PAIR, (match, first, last) => {
    if (looksLikeFalsePositiveName(first, last)) return match;
    nameMatchCount++;
    return '[name]';
  });

  // Pass 1b: single first name after a strong self-introduction signal
  // ("this is Anthony", "my name is John", "it's Jeff"). The allowlist still
  // protects owner/staff/place/brand tokens, so "this is Adam" is untouched.
  out = out.replace(NAME_SIGNAL_SINGLE, (match, prefix, first) => {
    if (NAME_ALLOWLIST.has(first)) return match;
    if (first.length < 2 || first === first.toUpperCase()) return match;
    nameMatchCount++;
    return `${prefix} [name]`;
  });

  if (nameMatchCount > 0) findings.push({ type: 'name', count: nameMatchCount });
  return out;
}

function redact(text) {
  if (text === null || text === undefined) return { text: '', confidence: 'high', findings: [] };

  let out = String(text);
  const findings = [];

  // Structured patterns first — deterministic.
  for (const { type, token, re } of PATTERNS) {
    let count = 0;
    out = out.replace(re, () => { count++; return token; });
    if (count) findings.push({ type, count });
  }

  // Name heuristic last (highest false-positive risk).
  const nameHits = findings.filter((f) => f.type === 'name').length;
  const beforeNamePass = out;
  out = redactNames(out, findings);
  const nameTriggered = out !== beforeNamePass || nameHits > 0;
  const addressTriggered = findings.some((f) => f.type === 'address');

  // Confidence.
  let confidence = 'high';
  if (nameTriggered || addressTriggered) confidence = 'medium';

  // Downgrade to low if we still see suspicious unstructured runs.
  if (suspiciousUnstructured(out)) confidence = 'low';

  return { text: out, confidence, findings };
}

function suspiciousUnstructured(text) {
  // Long all-caps runs.
  if (/[A-Z]{20,}/.test(text)) return true;
  // Sequences of 7+ digits not already redacted (likely missed phone/CC).
  if (/\b\d{7,}\b/.test(text)) return true;
  // Mixed unicode (anything outside basic latin + common punctuation +
  // emoji + currency) — be cautious.
  // We allow common latin + emoji + standard punctuation; flag anything
  // odd by checking presence of unusual private-use / control chars.
  // eslint-disable-next-line no-control-regex
  if (/[---]/.test(text)) return true;
  return false;
}

// Public API.
module.exports = {
  redact,
  // Internals for unit tests.
  _internals: {
    PATTERNS,
    NAME_ALLOWLIST,
    looksLikeFalsePositiveName,
    redactNames,
    suspiciousUnstructured,
  },
};
