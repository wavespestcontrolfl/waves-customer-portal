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
const { isCredentialName, isCredentialPair, nameWords, FREE_TEXT_EXEMPT_WORDS } = require('./credential-fields');

const REMOVED = '[removed]';

// ONE notion of "the value after a label", shared by every labelled pass (the labelled secrets and
// identifier assignments below, and the card code, SSN and card number passes in signed-link-redaction.js).
//  - AFTER_SEPARATOR: an explicit ":" or "=" with spaces or tabs around it, and then at most ONE line
//    break (with spaces or tabs around that), so "Password:\nhunter2" has its value on the next line.
//  - labelGap(n): the loose gap for a label with no separator ("CVV 123", "Card number 4242...", "Amex CID:\n1234"):
//    up to n characters that hold no digit and end no sentence, and at most one line break.
const AFTER_SEPARATOR = '[ \\t]*[:=][ \\t]*(?:\\r?\\n[ \\t]*)?';
const labelGap = (max) => `[^\\d.;!?\\n]{0,${max}}?(?:[ \\t]*\\r?\\n[ \\t]*)?`;

// ASSIGNMENTS: "DB_PASSWORD=hunter2", "api-key: abc", {"password":"hunter2"}, {'access_token':'abc'}. An
// identifier, optionally in quotes (a JSON or JS key), then "=" or ":", then a value. The identifier is a
// credential name by the SAME classifier the structured-field redactor uses (credential-fields.js
// isCredentialName: password, secret, token, session, cookie, pwd, passphrase, "api key" ...), minus the
// words that also name ordinary things in a sentence (FREE_TEXT_EXEMPT_WORDS: pin, authorization, hash,
// signature ...). "\b" cannot find "secret" inside AWS_SECRET_ACCESS_KEY because "_" is a word
// character, and such a value has no distinctive prefix.
//   NOT included: code (a gate, access, door or lockbox code is kept data), "keypad", "monkey" (a part
//   must be the whole word), "author".
//   Counter rule: an identifier whose LAST part is a counter word with a plain number of up to 6 digits
//   is a quantity, not a secret ("tokens_used=12", "max_tokens: 4096", "page_token_count: 3",
//   "password_attempts: 3"). A non-numeric value under such a name is still removed. A NAME counter word
//   (number, num, index) may also label the credential itself ("PASSWORD_NUMBER=123456", "OTP_NUMBER=123456",
//   "PORTAL_PIN_NUMBER=4821"), so it is a counter only when the name parts BEFORE it hold no credential word.
const QUANTITY_PARTS = new Set(['count', 'counts', 'used', 'total', 'limit', 'max', 'min', 'size', 'length', 'len', 'ttl',
  'seconds', 'secs', 'ms', 'days', 'hours', 'remaining', 'left', 'age', 'tokens', 'attempts', 'tries', 'failures']);
const NAME_COUNTER_PARTS = new Set(['number', 'num', 'index']);
// Credential words beyond the shared classifier that make a "number" a credential number.
const NUMBER_CREDENTIAL_WORDS = new Set(['pin', 'passcode', 'otp', 'code', 'token', 'key', 'secret', 'cvv', 'cvc', 'csc', 'cid', 'ssn',
  'card', 'pan', 'password', 'passwd', 'pwd', 'passphrase', 'account', 'routing', 'auth', 'login']);
function isCounterName(identifier) {
  const parts = nameWords(identifier);
  const last = parts[parts.length - 1];
  if (QUANTITY_PARTS.has(last)) return true;
  if (!NAME_COUNTER_PARTS.has(last)) return false;
  const before = parts.slice(0, -1);
  return !before.some((word) => NUMBER_CREDENTIAL_WORDS.has(word)) && !isCredentialName(before.join(' '));
}

// Plain English words that are also credential names ("Session: weekly service", "a cookie: chocolate chip"):
// as a bare word (no "_", "." or "-") the name counts only when its value is secret-shaped, one token with a
// digit or symbol, or 16+ characters.
const PROSE_NAMES = new Set(['session', 'sessions', 'cookie', 'cookies', 'credential', 'credentials', 'secret', 'secrets', 'token', 'tokens', 'auth']);
const proseName = (identifier, value) => PROSE_NAMES.has(identifier.toLowerCase())
  && !(!/\s/.test(value) && (/[\d%=+/\\_-]/.test(value) || value.length >= 16));

const hasCredentialPart = (identifier) => isCredentialName(identifier, FREE_TEXT_EXEMPT_WORDS);
// A PIN or passcode name ("PORTAL_PIN", "portal_pin", "APP_PASSCODE") is a
// credential unless it names an entry device or its clause is an access code.
const PIN_NAME_RE = /(?:^|[_.-])(?:pin|passcode)(?:$|[_.-])/i;
const ACCESS_NAME_RE = /(?:^|[_.-])(?:gate|door|lockbox|garage|keypad|callbox)(?:$|[_.-])/i;
const isPinName = (identifier) => PIN_NAME_RE.test(identifier);
// An account word inside the name (PORTAL_PIN, APP_PASSCODE) makes it an
// account credential whatever the clause says about a gate or door.
const accessPinName = (identifier, text, offset, valueEnd) => !ACCOUNT_WORD_RE.test(identifier.replace(/[_.-]/g, ' '))
  && (ACCESS_NAME_RE.test(identifier) || accessCodeLine(text, offset, valueEnd));

// The value after the separator: to the closing quote, else its first token
// plus up to 20 plain words that follow it in the same clause, so a dotenv
// passphrase goes whole ("DB_PASSWORD=correct horse battery staple") while a
// following assignment or quoted value is still examined on its own
// ("DB_PASSWORD=hunter2 OTHER_VAR=\"value\"").
// A quoted value honors backslash escapes: {"password":"abc\\"def"} is one value.
const VALUE_RE = /(?:(["'`])((?:\\.|(?!\1)[^\\\n])*)\1|(["'`]?)((?:[^\s"'`,;]*[^\s"'`,;.!?:}\]](?:[ \t]+[A-Za-z0-9][A-Za-z0-9'!@#$%^&*+-]*(?=[ \t]|[.,;!?:]|$)){0,20}|[^\s"'`,;]+?)[.!?:}\]]*(?=[\s"'`,;]|$)))/y;
// The value may sit on the next line ("DB_PASSWORD:\nhunter2"): one line break is allowed after the separator.
// An optional quote on each side of the identifier covers a JSON or JS key ("password": "x", 'api_key': 'x').
// A bare or quoted identifier; a QUOTED key may also hold spaces, as JSON
// keys do ({"api key":"..."}, {"access key":"..."}).
const IDENT_SEP_RE = new RegExp(`(?<![A-Za-z0-9_.-])(?:(["'\`])([A-Za-z][A-Za-z0-9]*(?:[ _.-][A-Za-z0-9]+){0,5})\\1|([A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*))(${AFTER_SEPARATOR})`, 'g');

// Returns { text, removed }. A non-credential identifier ("Pasted:") does not
// swallow what follows it, so the next identifier is still examined.
// Is this credential-named assignment's value kept? An empty or already
// removed value, status prose, an access PIN, a prose name with a plain value,
// or a small counter ("password_attempts: 3").
function keepAssignment({ identifier, value, pinName, input, offset, valueEnd }) {
  if (!value || value.startsWith('[removed') || proseOnly(value)) return true;
  if (pinName && accessPinName(identifier, input, offset, valueEnd)) return true;
  if (proseName(identifier, value)) return true;
  return isCounterName(identifier) && /^\d{1,6}$/.test(value);
}

// A YAML block scalar ("DB_PASSWORD: |", "api_key: |-", ">", ">-", "|+", with an optional indent digit and
// comment): the value is the following lines that are blank or indented deeper than the key.
const BLOCK_INDICATOR_RE = /[|>][+-]?\d?[+-]?[ \t]*(?:#[^\n]*)?(?:\r?\n|$)/y;
const LINE_RE = /[^\n]*(?:\n|$)/y;
// The end offset of the block that starts at `from` (just after the indicator line), or -1 when it holds no text.
function blockEnd(input, keyIndent, from) {
  let cursor = from;
  let end = -1;
  while (cursor < input.length) {
    LINE_RE.lastIndex = cursor;
    const line = LINE_RE.exec(input)[0];
    const content = line.replace(/\r?\n$/, '');
    if (content.trim()) {
      if (content.match(/^[ \t]*/)[0].length <= keyIndent) break;
      end = cursor + content.length;
    }
    cursor += line.length;
  }
  return end;
}
function lineIndent(input, offset) {
  const lineStart = input.lastIndexOf('\n', offset - 1) + 1;
  return input.slice(lineStart).match(/^[ \t]*/)[0].length;
}

function scrubIdentifierAssignments(input) {
  let out = '';
  let cursor = 0;
  let removed = 0;
  IDENT_SEP_RE.lastIndex = 0;
  let match;
  while ((match = IDENT_SEP_RE.exec(input)) !== null) {
    const identifier = match[2] || match[3];
    const valueStart = match.index + match[0].length;
    const pinName = isPinName(identifier);
    if (!pinName && !hasCredentialPart(identifier)) continue;
    BLOCK_INDICATOR_RE.lastIndex = valueStart;
    const indicator = BLOCK_INDICATOR_RE.exec(input);
    if (indicator) {
      const end = blockEnd(input, lineIndent(input, match.index), valueStart + indicator[0].length);
      if (end < 0) continue;
      out += `${input.slice(cursor, valueStart)}${REMOVED}`;
      cursor = end;
      removed += 1;
      IDENT_SEP_RE.lastIndex = cursor;
      continue;
    }
    VALUE_RE.lastIndex = valueStart;
    const found = VALUE_RE.exec(input);
    if (!found) continue;
    const quote = found[1] || '';
    const open = found[3] || '';
    const rawBare = found[4] || '';
    const tail = quote ? '' : (rawBare.match(/[.!?:}\]]+$/) || [''])[0];
    const value = quote ? found[2] : (tail ? rawBare.slice(0, -tail.length) : rawBare);
    if (keepAssignment({ identifier, value, pinName, input, offset: match.index, valueEnd: valueStart + found[0].length })) continue;
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
const AUTH_SCHEMES = 'basic|bearer|digest|negotiate|ntlm|aws4-hmac-sha256|token|hoba|mutual';
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
  // An Authorization header (any scheme: Basic, Bearer, Digest, Negotiate, a vendor scheme) is removed to
  // the end of its line, scheme and payload together. It must be header-shaped: the word starts a line or
  // follows a quote or brace ("Authorization: ...", {"authorization": "..."}); or the value starts with a
  // recognised scheme, a JWT or a 20+ character token. "Customer authorization: verbal consent received"
  // and "Prior authorization: required before treatment" are notes and stay.
  { name: 'authorization_header', re: /((?:^|(?<=["'{]))[ \t]*(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)[^\r\n]{1,400}/gim, keep: 1 },
  { name: 'authorization_scheme', re: new RegExp(`(\\b(?:proxy-)?authorization["']?[ \\t]*[:=][ \\t]*["']?)(?=(?:${AUTH_SCHEMES})[ \\t]+\\S|eyJ|[^\\s"']{20})[^\\r\\n]{1,400}`, 'gi'), keep: 1 },
  // A Cookie or Set-Cookie header loses its whole value, to the end of the line: header-shaped, or the value
  // starts with a name=value pair.
  { name: 'cookie_header', re: /((?:^|(?<=["'{]))[ \t]*(?:set-)?cookie["']?[ \t]*[:=][ \t]*["']?)[^\r\n]{1,1000}/gim, keep: 1 },
  { name: 'cookie_pair', re: /(\b(?:set-)?cookie["']?[ \t]*[:=][ \t]*["']?)(?=[A-Za-z0-9_.%-]+=)[^\r\n]{1,1000}/gi, keep: 1 },
  // A scheme with its payload outside a header ("Basic dXNlcjpwYXNz"). Basic
  // payloads are short, so the payload needs only 8 base64 characters.
  { name: 'basic_credentials', re: /\b(Basic[ \t]+)[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/])/g, keep: 1 },
  { name: 'bearer_token', re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, keep: 1 },
  // A credential-named identifier assigned a value (see the rules above).
  { name: 'credential_identifier_assignment', scrub: scrubIdentifierAssignments },
]);

// LABELS in prose ("Wifi password: x", "Private key: x", "PIN is 4821"). ONE vocabulary: a label of 1 to 3
// words is a credential label when the shared classifier (credential-fields.js isCredentialName, minus the
// ordinary-prose words) calls it a credential name: password, passcode, secret, token, otp, "api key",
// "private key", "secret key", "encryption key", "verification code", session, cookie ... Two spellings the
// classifier does not cover stay listed here: "pin" (exempt there because a gate PIN is kept data, so it has
// its own gate-code rule) and "login code". "access code" is a gate/door code and is in neither.
// The credential name must END the label ("Wifi password", "Private key"); "Password hint" and "Private key
// pairs" are not credentials.
const PIN_LABEL_RE = /\b(?:pin|passcode)$/i;
const LOGIN_CODE_RE = /\blogin[ _-]?code$/i;
const endsWithCredentialName = (label) => {
  const words = nameWords(label);
  // the last word alone ("wifi password"), or the last two words as a listed pair ("private key", "secret key")
  return isCredentialName(words.slice(-1).join(' '), FREE_TEXT_EXEMPT_WORDS) || (words.length > 1 && isCredentialPair(words[words.length - 2], words[words.length - 1]));
};
const labelIsCredential = (label) => PIN_LABEL_RE.test(label) || LOGIN_CODE_RE.test(label) || endsWithCredentialName(label);
// Plain English words that are also credential names: alone in a label they count only when the value is
// secret-shaped ("Session: weekly service" stays, "Session: a1b2c3" goes). A label with any other
// credential word ("session token", "wifi password") is a credential label whatever follows.
const PROSE_LABEL_WORDS = new Set(['session', 'sessions', 'cookie', 'cookies', 'credential', 'credentials', 'auth', 'tokens', 'secrets']);
const isProseLabel = (label) => !PIN_LABEL_RE.test(label) && !LOGIN_CODE_RE.test(label)
  && !isCredentialName(nameWords(label).filter((word) => !PROSE_LABEL_WORDS.has(word)).join(' '), FREE_TEXT_EXEMPT_WORDS);
const secretShaped = (value) => !/\s/.test(value) && (/[\d%=+/\\_-]/.test(value) || value.length >= 16);
// label (1 to 3 words), then the separator (":" / "=" / " is "). The value clause that follows runs to
// the closing quote when quoted, otherwise to the end of the sentence or line (a passphrase is several
// words: "token: alpha beta gamma"), at most 120 characters. A "." inside a value ("abc.def") does not
// end it; a "." followed by a space or the end does.
// After ':' or '=' ONE line break (with spaces or tabs around it) may come before the value
// ("Password:\nhunter2"); after " is " it may not.
// A line that runs on for more than 120 characters with no sentence end still
// loses the value: the first 120 characters after the label are removed.
const LABEL_RE = new RegExp(`\\b([A-Za-z][A-Za-z0-9]*(?:[ \\t]+[A-Za-z][A-Za-z0-9]*){0,2})(${AFTER_SEPARATOR}|[ \\t]+is[ \\t]+)`, 'g');
const LABEL_VALUE_RE = /(?:(["'`])([^"'`\n]{1,120})\1|()((?:[^\n]{1,120}?(?=[.;!?,]?[ \t]*(?:\n|$)|[.;!?][ \t]))|[^\n]{120}))/y;
// "gate PIN: 1234", "lockbox pin 1234": a PIN or passcode that opens a gate,
// door or lockbox is the same kept data as a gate code.
const KEPT_BEFORE_RE = /\b(?:gate|door|lockbox|access|garage|keypad)\s+(?:pin|passcode)\s*$/i;
// "PIN is 4821 at the front gate", "Use PIN: 4821 for the gate": the access
// word may follow the label. A PIN or passcode whose own line names a gate,
// door, lockbox, garage, keypad or callbox (a physical entry device; a word such
// as "lobby" or "entry" proves nothing: "Zoom PIN for the meeting lobby") is a property
// access code, which the owner reads through the bar like a gate code.
const ACCESS_WORD_RE = /\b(?:gate|gates|door|doors|lockbox|lock\s?box|garage|keypad|callbox|call\s?box)\b/i;
// Only the PIN's own clause counts (to the nearest ".", ";", "!" , "?" or line
// break on each side): "Portal PIN is 4821. Gate is open." names the gate in
// another sentence and is still removed. A clause that names an account
// (portal, bank, app, login, wifi, ...) is never an access code.
const ACCOUNT_WORD_RE = /\b(?:portal|bank|banking|app|account|login|log-in|online|website|wifi|wi-fi|email|card|debit|credit|atm|voicemail|phone|zoom|meeting|conference|call-in|dial-in|webinar|teams)\b/i;
// A clause is short, so every clause lookup reads a window of CLAUSE_WINDOW characters on each side of the
// match, never the whole text: the work for one match does not grow with the length of the note.
const CLAUSE_WINDOW = 300;
// Where the clause that holds `offset` starts: after the nearest "\n", ". ", ";", "! " or "? " before it
// (or at the window edge).
function clauseStart(text, offset) {
  const from = Math.max(0, offset - CLAUSE_WINDOW);
  const before = text.slice(from, offset);
  const found = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('. '), before.lastIndexOf(';'), before.lastIndexOf('! '), before.lastIndexOf('? '));
  return found === -1 ? from : from + found + 1;
}
// The clause around `offset`: from clauseStart to the nearest "\n", ";" or sentence end after it.
function clauseAt(text, offset) {
  const rest = text.slice(offset, offset + CLAUSE_WINDOW);
  const end = rest.search(/\n|;|[.!?](?:\s|$)/);
  return text.slice(clauseStart(text, offset), end === -1 ? Math.min(text.length, offset + CLAUSE_WINDOW) : offset + end);
}
// The credential phrase around a PIN: from the clause start to the end of the PIN's value, plus up to 4 more
// plain words (no comma, no sentence end). "PIN: 4821 for the gate, call customer phone before arrival" has the
// phrase "PIN: 4821 for the gate"; "phone" is another instruction in the clause.
function credentialPhrase(text, offset, valueEnd) {
  const head = text.slice(clauseStart(text, offset), valueEnd);
  const after = text.slice(valueEnd, valueEnd + CLAUSE_WINDOW);
  // A value that ends its sentence ("Door passcode: 7788.") takes no words
  // from the next sentence.
  if (/[.!?;][ \t]*$/.test(head) || /^[.!?;]/.test(after)) return head;
  const tail = after.match(/^(?:[ \t]+[^\s,;.!?]+){0,4}/)[0];
  return head + tail;
}
function accessCodeLine(text, offset, valueEnd) {
  return ACCESS_WORD_RE.test(clauseAt(text, offset)) && !ACCOUNT_WORD_RE.test(credentialPhrase(text, offset, valueEnd));
}
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
// A status word is letters only ("n/a" too); a word with a digit or symbol is
// a value ("secret123", "changed2026!"), never prose.
const statusWord = (word) => {
  const bare = word.toLowerCase().replace(/[.,!?:;]+$/, '');
  return /^[a-z/]+$/.test(bare) && NOT_A_VALUE.has(bare);
};
// Verbs that can take the new value directly ("reset hunter2").
const CHANGE_VERBS = new Set(['reset', 'changed', 'updated', 'set', 'rotated', 'changing']);
const PROSE_FOLLOWERS = new Set(['to', 'as', 'into', 'before', 'after', 'for', 'on', 'at', 'by', 'until', 'when', 'if', 'in',
  'with', 'from', 'during', 'and', 'or', 'but', 'yesterday', 'today', 'recently', 'again', 'last', 'this', 'next', 'please',
  'per', 'via', 'so', 'because', 'since', 'already', 'still', 'too', 'also', 'here', 'there', 'now', 'soon', 'yet']);
function proseOnly(clause) {
  const words = clause.toLowerCase().split(/\s+/).filter(Boolean);
  if (!statusWord(words[0])) return false;
  // "changed to hunter2", "reset to X", "set as X": the word after "to" / "as"
  // / "into" is the new value unless it is itself a status word.
  const connector = words.findIndex((word) => ['to', 'as', 'into'].includes(word));
  if (connector >= 0 && words[connector + 1] && !statusWord(words[connector + 1])) return false;
  // "reset hunter2", "changed hunter2": the word right after the status word
  // is the value unless it is a status word, a connector or a plain
  // preposition / time word ("required before booking", "changed yesterday").
  const next = words[1] && words[1].replace(/[.,!?:;]+$/, '');
  if (CHANGE_VERBS.has(words[0].replace(/[.,!?:;]+$/, '')) && next && !statusWord(next) && !PROSE_FOLLOWERS.has(next)) return false;
  return AMBIGUOUS_FIRST.has(words[0].replace(/[^a-z/]/g, '')) ? words.every(statusWord) : true;
}

// A PIN or passcode label that opens a gate, door or lockbox: kept data.
function keptAccessPin(label, separator, value, offset, text) {
  if (!/\b(?:pin|passcode)\s*$/i.test(label)) return false;
  if (KEPT_BEFORE_RE.test(text.slice(Math.max(0, offset - 20), offset + label.length))) return true;
  return accessCodeLine(text, offset, offset + label.length + separator.length + (value.match(/^\S+/) || [''])[0].length);
}

// The replacement text for a credential label's value, or null when the value stays.
function labelledReplacement(label, separator, quote, quoted, bare, offset, text) {
  const value = (quote ? quoted : bare || '').trim();
  // An earlier pattern may already have removed the first word; a value that
  // is ONLY the removed marker is done, anything after it is still the value.
  if (!value || /^\[removed[^\]]*\]$/.test(value) || proseOnly(value)) return null;
  if (isProseLabel(label) && !secretShaped(value)) return null;
  // "tokens: 40" is a quantity, as it is in an assignment.
  if (isCounterName(label) && /^\d{1,6}$/.test(value)) return null;
  if (keptAccessPin(label, separator, value, offset, text)) return null;
  const viaIs = /\bis[ \t]*$/i.test(separator);
  // After " is " one short plain word ("pin is blue") reads as prose; anything
  // longer, several words, or a digit or symbol is taken as the value.
  if (viaIs && !quote && !/\s/.test(value) && !/[\d!@#$%^&*_+=~/\\|-]/.test(value) && value.length < 6) return null;
  return `${quote || ''}${REMOVED}${quote || ''}`;
}

// Walks the credential labels of `source`. A kept value (an access PIN, prose, a short word) keeps only its
// first word: scanning resumes right after it, so "PIN is 4821 for the gate, password is hunter2" still
// loses the password. A label that is not a credential does not swallow what follows it.
function scrubLabelled(source) {
  let out = '';
  let cursor = 0;
  let removed = 0;
  LABEL_RE.lastIndex = 0;
  let match;
  while ((match = LABEL_RE.exec(source)) !== null) {
    const [whole, label, separator] = match;
    const valueStart = match.index + whole.length;
    LABEL_RE.lastIndex = valueStart;
    if (!labelIsCredential(label)) continue;
    LABEL_VALUE_RE.lastIndex = valueStart;
    const found = LABEL_VALUE_RE.exec(source);
    if (!found) continue;
    const replacement = labelledReplacement(label, separator, found[1], found[2], found[4], match.index, source);
    if (replacement !== null) {
      out += source.slice(cursor, valueStart) + replacement;
      cursor = valueStart + found[0].length;
      // A clause whose first word an earlier pattern already removed was counted there.
      if (!found[0].includes(REMOVED)) removed += 1;
      LABEL_RE.lastIndex = cursor;
    } else if (found[1]) {
      LABEL_RE.lastIndex = valueStart + found[0].length;
    } else {
      LABEL_RE.lastIndex = valueStart + (found[0].match(/^\s*\S+/)?.[0].length || found[0].length);
    }
  }
  return { text: out + source.slice(cursor), removed };
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
  const labelled = scrubLabelled(text);
  return { text: labelled.text, removed: removed + labelled.removed };
}

module.exports = { SECRET_PATTERNS, REMOVED, scrubSecretText, clauseAt, ACCESS_WORD_RE, AFTER_SEPARATOR, labelGap };
