/**
 * Best-effort scrubber for credentials pasted into free text (a payer's
 * `notes`, a ledger `note`, a script body). Used by the Intelligence Bar's
 * general admin read on every string value before the answer is cut to its
 * cap. It is a net, not a guarantee: a secret in a shape it does not know, or
 * a password written as an ordinary word, passes.
 *
 *  A. Known secret formats and credential-named identifier assignments
 *     (AWS_SECRET_ACCESS_KEY=..., DB_PASSWORD: ...), one named pattern each
 *     (SECRET_PATTERNS).
 *  B. Labelled secrets in prose: "password: hunter2", "PIN is 4821",
 *     "api key = abc", "OTP: 123456". The label stays, the value goes.
 *
 * Kept on purpose (owner ruling, owner login): gate code, access code, door
 * code, lockbox code. Ordinary prose that names a credential without giving
 * one ("PIN the note", "token of appreciation", "password reset requested")
 * is left alone.
 */
const REMOVED = '[removed]';

// ENVIRONMENT-STYLE ASSIGNMENTS. An identifier of letters, digits and "_" "."
// "-" (AWS_SECRET_ACCESS_KEY, DB_PASSWORD, db.password, api-key) that has a
// credential word as one of its separated parts, then "=" or ":", then a
// value. "\b" cannot find "secret" inside AWS_SECRET_ACCESS_KEY because "_" is
// a word character, and such a value has no distinctive prefix.
//   Credential parts: password, passwd, pwd, passphrase, secret(s), token,
//   apikey, auth, credential(s); and "key" right after api, access, secret,
//   private, signing, encryption or cert. NOT included: pin, code (a gate,
//   access, door or lockbox code is kept data), "keypad", "monkey" (a part
//   must be the whole word), "tokens" (plural: a counter), "author".
//   Counter rule: an identifier whose LAST part is a counter word (count, used,
//   total, limit, max, min, size, length, num, number, ttl, seconds, ms, days,
//   remaining, ...) with a plain number of up to 6 digits is a quantity, not a
//   secret ("tokens_used=12", "page_token_count: 3"). A non-numeric value
//   under such a name is still removed.
const CREDENTIAL_PARTS = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret', 'secrets', 'token', 'apikey', 'auth', 'credential', 'credentials']);
const KEY_PREFIXES = new Set(['api', 'access', 'secret', 'private', 'signing', 'encryption', 'cert']);
const COUNTER_PARTS = new Set(['count', 'counts', 'used', 'total', 'limit', 'max', 'min', 'size', 'length', 'len', 'num', 'number', 'ttl',
  'seconds', 'secs', 'ms', 'days', 'hours', 'remaining', 'left', 'age', 'index']);

function hasCredentialPart(identifier) {
  const parts = identifier.toLowerCase().split(/[_.-]/).filter(Boolean);
  return parts.some((part, index) => CREDENTIAL_PARTS.has(part) || (part === 'key' && index > 0 && KEY_PREFIXES.has(parts[index - 1])));
}

// The value after the separator: to the closing quote, else to whitespace.
const VALUE_RE = /(?:(["'`])([^"'`\n]*)\1|(["'`]?)([^\s"'`,;]+))/y;
const IDENT_SEP_RE = /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*)([ \t]*[:=][ \t]*)/g;

// Returns { text, removed }. A non-credential identifier ("Pasted:") does not
// swallow what follows it, so the next identifier is still examined.
function scrubIdentifierAssignments(input) {
  let out = '';
  let cursor = 0;
  let removed = 0;
  IDENT_SEP_RE.lastIndex = 0;
  let match;
  while ((match = IDENT_SEP_RE.exec(input)) !== null) {
    const identifier = match[1];
    const valueStart = match.index + match[0].length;
    if (!hasCredentialPart(identifier)) continue;
    VALUE_RE.lastIndex = valueStart;
    const found = VALUE_RE.exec(input);
    if (!found) continue;
    const quote = found[1] || '';
    const open = found[3] || '';
    const rawBare = found[4] || '';
    const tail = quote ? '' : (rawBare.match(/[.!?:]+$/) || [''])[0];
    const value = quote ? found[2] : (tail ? rawBare.slice(0, -tail.length) : rawBare);
    const last = identifier.toLowerCase().split(/[_.-]/).pop();
    const keep = !value || value.startsWith('[removed') || NOT_A_VALUE.has(value.toLowerCase())
      || (COUNTER_PARTS.has(last) && /^\d{1,6}$/.test(value));
    if (keep) continue;
    out += input.slice(cursor, valueStart) + (quote ? `${quote}${REMOVED}${quote}` : `${open}${REMOVED}${tail}`);
    cursor = valueStart + found[0].length;
    removed += 1;
    IDENT_SEP_RE.lastIndex = cursor;
  }
  return { text: out + input.slice(cursor), removed };
}

// Each pattern: a name (for tests and for the README), the regex, and what to
// keep. Publishable keys (pk_live_, pk_test_) are public and are not listed.
// A Twilio account id (AC + 32 hex) is an identifier, not a secret, and is
// not listed either.
const SECRET_PATTERNS = Object.freeze([
  { name: 'stripe_secret_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: 'stripe_webhook_secret', re: /\bwhsec_[A-Za-z0-9]{16,}/g },
  { name: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { name: 'github_fine_grained_token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'twilio_api_key_sid', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { name: 'sendgrid_api_key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_api_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { name: 'pem_private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // An Authorization header (any scheme: Basic, Bearer, Digest, Negotiate, a
  // vendor scheme) is removed to the end of its line: scheme and payload together.
  { name: 'authorization_header', re: /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)[^\r\n]{1,400}/gi, keep: 1 },
  // A scheme with its payload outside a header ("Basic dXNlcjpwYXNz"). Basic
  // payloads are short, so the payload needs only 8 base64 characters.
  { name: 'basic_credentials', re: /\b(Basic[ \t]+)[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/])/g, keep: 1 },
  { name: 'bearer_token', re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, keep: 1 },
  // A credential-named identifier assigned a value (see the rules above).
  { name: 'credential_identifier_assignment', scrub: scrubIdentifierAssignments },
]);

// Words that name a credential. "access key" is a credential; "access code" is
// a gate/door code and is not in this list.
const LABEL_WORDS = '(?:password|passcode|passphrase|passwd|pwd|pin|secret|token|api[ _-]?key|access[ _-]?key|login[ _-]?code|verification[ _-]?code|otp)';
// label, separator (":" / "=" / " is "), then the WHOLE value clause: to the
// closing quote when quoted, otherwise to the end of the sentence or line (a
// passphrase is several words: "token: alpha beta gamma"), at most 120
// characters. A "." inside a value ("abc.def") does not end it; a "." followed
// by a space or the end does.
const LABELLED_RE = new RegExp(`\\b(${LABEL_WORDS})\\b([ \\t]*[:=][ \\t]*|[ \\t]+is[ \\t]+)(?:(["'\`])([^"'\`\\n]{1,120})\\3|()([^\\n]{1,120}?)(?=[.;!?,]?[ \\t]*(?:\\n|$)|[.;!?][ \\t]))`, 'gi');
// "gate PIN: 1234", "lockbox pin 1234": a PIN or passcode that opens a gate,
// door or lockbox is the same kept data as a gate code.
const KEPT_BEFORE_RE = /\b(?:gate|door|lockbox|access|garage|keypad)\s+(?:pin|passcode)\s*$/i;
// After ":" / "=" these are not values; after "is" the value must also look
// like a secret (a digit or a symbol, or be quoted).
const NOT_A_VALUE = new Set(['none', 'n/a', 'na', 'unknown', 'required', 'needed', 'reset', 'changed', 'set', 'updated', 'sent',
  'expired', 'pending', 'yes', 'no', 'tbd', 'blank', 'empty', 'invalid', 'incorrect', 'wrong', 'missing', 'on', 'off', 'the', 'a', 'an',
  'not', 'same', 'saved', 'stored', 'given', 'provided', 'correct', 'valid', 'active', 'old', 'new', 'forgotten', 'lost', 'confirmed',
  'verified', 'enabled', 'disabled', 'rejected', 'accepted', 'locked', 'unlocked', 'current', 'default', 'unset', 'shared', 'rotated',
  'changing', 'unknown', 'unavailable', 'optional', 'mandatory', 'sensitive', 'private', 'secure', 'secret']);

// Is the clause prose about the credential, not its value? It is when its
// first word is a status word ("required before booking", "on file", "not
// set"). A few status words can also open a passphrase ("correct horse battery
// staple"): for those every word of the clause must be a status word.
const AMBIGUOUS_FIRST = new Set(['correct', 'valid', 'private', 'secure', 'secret', 'same', 'old', 'new', 'current', 'default', 'shared', 'a', 'an', 'the']);
const statusWord = word => NOT_A_VALUE.has(word.replace(/[^a-z/]/g, ''));
function proseOnly(clause) {
  const words = clause.toLowerCase().split(/\s+/).filter(Boolean);
  if (!statusWord(words[0])) return false;
  return AMBIGUOUS_FIRST.has(words[0].replace(/[^a-z/]/g, '')) ? words.every(statusWord) : true;
}

function labelledReplacement(match, label, separator, quote, quoted, _empty, bare, offset, text) {
  const value = (quote ? quoted : bare || '').trim();
  // An earlier pattern may already have removed the first word; a value that
  // is ONLY the removed marker is done, anything after it is still the value.
  if (!value || /^\[removed[^\]]*\]$/.test(value) || proseOnly(value)) return match;
  if (/^pin|passcode/i.test(label) && KEPT_BEFORE_RE.test(text.slice(Math.max(0, offset - 20), offset + label.length))) return match;
  const viaIs = /\bis[ \t]*$/i.test(separator);
  // After " is " one short plain word ("pin is blue") reads as prose; anything
  // longer, several words, or a digit or symbol is taken as the value.
  if (viaIs && !quote && !/\s/.test(value) && !/[\d!@#$%^&*_+=~/\\|-]/.test(value) && value.length < 6) return match;
  return `${label}${separator}${quote || ''}${REMOVED}${quote || ''}`;
}

// Returns { text, removed } where removed counts the secrets taken out.
function scrubSecretText(input) {
  if (typeof input !== 'string' || input.length < 4) return { text: input, removed: 0 };
  let removed = 0;
  let text = input;
  for (const { re, keep, scrub } of SECRET_PATTERNS) {
    if (scrub) {
      const scrubbed = scrub(text);
      text = scrubbed.text;
      removed += scrubbed.removed;
    } else {
      text = text.replace(re, (...args) => { removed += 1; return `${keep ? args[keep] : ''}${REMOVED}`; });
    }
  }
  text = text.replace(LABELLED_RE, (...args) => {
    const replaced = labelledReplacement(...args);
    // A clause whose first word an earlier pattern already removed was counted there.
    if (replaced !== args[0] && !args[0].includes(REMOVED)) removed += 1;
    return replaced;
  });
  return { text, removed };
}

module.exports = { SECRET_PATTERNS, REMOVED, scrubSecretText };
