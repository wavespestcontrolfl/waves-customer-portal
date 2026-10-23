/**
 * Fixed-format scrubber for the free-text notes the Intelligence Bar's general
 * admin read returns (GATE_IB_READ_NOTES; owner ruling 2026-10-13: the read
 * RETURNS notes and access instructions, scrubbed of secrets).
 *
 * It removes only secrets with a recognisable SHAPE. It has no prose rules: a
 * sentence such as "the gate code is 1234", "lockbox 4521, key under the mat"
 * or "password is hunter2" comes back as written. That is the ruling (gate and
 * lockbox instructions are operational data), and it is the known limit: a
 * secret typed as an ordinary word cannot be told from an instruction.
 * Do not add label-and-value rules here; two earlier attempts at that never
 * converged.
 *
 * Shapes removed (each becomes "[removed]"):
 *  - PEM blocks (-----BEGIN ... -----), to the END line or to the end of the text
 *  - known token prefixes: sk-/sk_, pk_, rk_, whsec_, ghp_/gho_/ghu_/ghs_/ghr_,
 *    github_pat_, xox[abprs]-, AKIA/ASIA access key ids, AIza keys, SG. keys
 *  - "Bearer <token>"
 *  - JWTs (three base64url parts, the first starting eyJ)
 *  - the value of a credential-named query parameter inside a URL
 *    (token, signature, sig, key, apikey, X-Amz-*, ...) and user:password@ in a URL
 *  - card numbers (Luhn, utils/pan-scrub.js) and a card security code named by its label
 *    ("CVV 123", "CVV: 123", "CVV=123"). Only the card-number span is replaced: the rest of the
 *    note is returned byte for byte (typographic dashes, spaces and full-width digits elsewhere stay)
 *  - SSN pattern ddd-dd-dddd
 *  - EVERYTHING after a credential key and its separator, to the end of the note string
 *    ("db.password: x", "DB_PASSWORD=x y z", "X-API-Key: x", "Authorization: Token x",
 *    {"password": ...): the key and separator stay, one marker replaces the rest. See
 *    CREDENTIAL_ASSIGN_RE: no value grammar is parsed, so quotes, brackets, YAML blocks, line breaks
 *    and an unclosed quote cannot hide the rest of a secret. Text before the key stays.
 *  - any other run of 32 or more base64/hex characters
 *  - a Luhn-valid card number inside a digit run longer than 120 digits
 *  - backstop: any other 20+ character token that mixes letters and digits and
 *    looks random (10+ distinct characters, no repeat run over 4); UUIDs, ISO
 *    dates and links are kept
 */
const { luhnValid, createEditTracker, applyTrackedEdits, trackedEditList, scrubPansTracked } = require('./pan-scrub');
const { isCredentialName, nameWords } = require('./credential-fields');

const REMOVED = '[removed]';
const NOTE_CAP = 1000;
const CUT = '[cut]';
// A note longer than this is cut before scrubbing: only NOTE_CAP characters are
// ever returned, and the scan stays cheap on a huge value.
const SCAN_LIMIT = 20000;

// Cut a long note at SCAN_LIMIT without leaving half a secret: back off to the
// last whitespace or delimiter within the last 200 characters, or drop those 200
// when there is none, so a key cut in two never reaches the rules (Codex #6375 r10).
const BACKOFF = 200;
function trimToScanLimit(input, limit = SCAN_LIMIT) {
  const text = String(input);
  if (text.length <= limit) return text;
  const start = Math.max(limit - BACKOFF, 0);
  const tail = text.slice(start, limit);
  const at = tail.search(/[\s,;"'(){}[\]<>][^\s,;"'(){}[\]<>]*$/);
  return text.slice(0, at >= 0 ? start + at : start);
}

const PEM_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const PREFIXED_RES = [
  /\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
];
// "Bearer <token>": a long token always; a short one when it looks like a token
// (a digit or . _ ~ + / = -) or follows "Authorization:", so "the bearer of" stays (Codex #6375 r4).
const BEARER_RE = /(\bauthorization\s*:\s*)?\bBearer\s+([A-Za-z0-9._~+/=-]+)/gi;
const looksLikeBearerToken = (header, token) => Boolean(header) || token.length >= 16 || /[0-9._~+/=-]/.test(token);
// HTTP Basic credentials ("Authorization: Basic dXNlcjpwYXNz", or bare "Basic <base64>").
// "Basic <base64>" in any casing (HTTP schemes are case-insensitive), removed
// only when the token decodes to "user:password", so prose such as "Basic
// perimeter treatment" stays (Codex #6375 r3, pre-push audit r4).
const BASIC_RE = /(\bauthorization\s*:\s*)?\b(basic)\s+([A-Za-z0-9+\/]{4,}={0,2})/gi;
// After an "Authorization:" header any Basic token is a credential; elsewhere
// it must decode (UTF-8, any language) to "user:password" (Codex #6375 r6).
function looksLikeBasicCredential(header, token) {
  if (header) return true;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    return decoded.includes(':') && !/[\u0000-\u001f\u007f\ufffd]/.test(decoded) && decoded.indexOf(':') > 0;
  } catch {
    return false;
  }
}
// CREDENTIAL ASSIGNMENTS (one structural rule; Codex #6375 r19). A credential KEY followed by its
// separator ("=" or ":") removes EVERYTHING after the separator to the END OF THE NOTE STRING and puts
// one "[removed]" in its place; the text before the key, the key and the separator stay. No value
// grammar is parsed (quotes, brackets, YAML blocks, several words, line breaks and an unclosed quote
// all end the same way), so a format cannot be mis-read. A key is credential when
//  - isAssignmentSecretKey(key): its last word is password, passwd, secret, token, api key, credential,
//    auth, authorization, cookie, nonce, jwt, bearer, otp ... (names split on . _ - and camelCase), with
//    "=" or ":"; or
//  - isEnvSecretName(key): an environment-style name (api_token, DB_PASSWORD_FILE) with a whole
//    name segment that is PASS, PASSWORD, SECRET, TOKEN, API_KEY, PRIVATE_KEY, CREDENTIAL(S), with "=".
// The key may sit in plain or backslash-escaped quotes ({"password": ..., {\"password\": ...). A key
// inside a link is left to the link rules. Prose has no separator: "the password is in the lockbox",
// "PIN: 8842", "gate code: 1234" come back as written. An already removed value (exactly the marker)
// is left alone, so a second pass changes nothing.
// A key may be written with spaces after a key prefix: "private key:", "access key id =" (Codex #6375 r21).
const CREDENTIAL_ASSIGN_RE = /(?<![A-Za-z0-9_.-])(-{1,2})?(\\?["']?)((?:(?:api|private|secret|signing|access|encryption|ssh)[ \t]+(?:key[ \t]+)?)?[A-Za-z][A-Za-z0-9_.-]*)\2(\s*[=:][ \t]*)/gi;
const ENV_STEM_WORDS = new Set(['password', 'passwd', 'pwd', 'passphrase', 'pass', 'secret', 'token', 'apikey', 'credential', 'credentials']);
const ENV_STEM_PAIRS = [['api', 'key'], ['private', 'key']];
function isEnvSecretName(key) {
  const parts = key.toLowerCase().split(/[_.-]/).filter(Boolean);
  return parts.some((part, i) => ENV_STEM_WORDS.has(part) || ENV_STEM_PAIRS.some(([first, second]) => part === first && parts[i + 1] === second));
}
// The credential vocabulary of a fixed-format key (Codex #6375 r17). It is the
// shared classifier's list less the words that name an ACCESS instruction the
// owner wants returned (ruling 2026-10-13: pin, passcode) or that are ordinary
// note words (session, signature, sig, hash/salt on their own).
const ASSIGN_KEY_WORDS = new Set(['password', 'passwords', 'passwd', 'pwd', 'passphrase', 'secret', 'secrets', 'token', 'tokens', 'apikey', 'credential',
  'credentials', 'auth', 'authorization', 'cookie', 'cookies', 'nonce', 'jwt', 'bearer', 'otp']);
const SECRET_KEY_PREFIXES = new Set(['api', 'private', 'secret', 'signing', 'access', 'encryption', 'ssh']);
const CREDENTIAL_PREFIX_WORDS = new Set(['password', 'passwd', 'secret', 'token', 'api', 'auth', 'session']);
function isAssignmentSecretKey(key) {
  const words = nameWords(key);
  const last = words[words.length - 1];
  const prev = words[words.length - 2];
  if (ASSIGN_KEY_WORDS.has(last)) return true;
  if (last === 'key') return SECRET_KEY_PREFIXES.has(prev);
  // password_hash, session_id-style pairs: a hash, salt or id of a credential.
  if (!['hash', 'salt', 'id'].includes(last)) return false;
  // access_key_id, secret_access_key-style ids: the words before the id are judged by the same key rule.
  return CREDENTIAL_PREFIX_WORDS.has(prev) || (prev === 'key' && SECRET_KEY_PREFIXES.has(words[words.length - 3]));
}
// Only the exact marker (bare, or inside matching quotes or escaped quotes) counts as already removed:
// "[removed]hunter22" still has its secret (Codex #6375 r15).
const ALREADY_REMOVED_RE = /^(?:\[removed\]|(["']|\\["'])\[removed\]\1)$/;
const isAlreadyRemoved = value => ALREADY_REMOVED_RE.test(value);

// Typographic dashes and spaces become plain ones, full-width digits become ASCII
// and invisible format characters go, so a card number written with them is
// still found (Codex #6375 security r23). The normalized text is only used to FIND card numbers: the
// result keeps, for every character of it, the index of the character it came from, so the mask can be
// written into the original note and the rest of the note stays byte for byte.
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/;
const DASH_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/;
const SPACE_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;
const FULL_WIDTH_DIGIT_RE = /[\uFF10-\uFF19]/;
function plainDigitsAndSeparators(text) {
  let plain = '';
  const origin = [];
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at];
    if (INVISIBLE_RE.test(ch)) continue;
    if (DASH_RE.test(ch)) plain += '-';
    else if (SPACE_RE.test(ch)) plain += ' ';
    else if (FULL_WIDTH_DIGIT_RE.test(ch)) plain += String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 48);
    else plain += ch;
    origin.push(at);
  }
  return { plain, origin };
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
// A JSON-escaped link (https:\/\/user:pw@host\/path) is a link too: the scheme slashes
// and the path may carry a backslash before each slash (Codex #6375 r10).
// Any scheme: postgresql://, redis://, ftp:// links carry credential query names too (Codex #6375 r12).
const URL_RE = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:(?:\\?\/){2}(?:[^\s"'<>\\]|\\\/)+/gi;
// user:password@ in a link of ANY scheme (postgresql://, redis://, ftp://,
// smb://, ...); the http(s) links above also go through scrubUrl (Codex #6375).
// A scheme starts after a non-scheme character, so a long run of letters, dots or dashes is scanned once, not from every offset (Codex #6375 r20).
const ANY_SCHEME_USERINFO_RE = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:(?:\\?\/){2})[^\s\/@:"'<>\\]*:[^\s\/@"'<>\\]+@/gi;
// user:password@host.example with no scheme at all (Codex #6375 r21). The user part starts after a
// non-user character, so a long run is scanned once; the host must have a dot.
const BARE_USERINFO_RE = /(?<![A-Za-z0-9._%+\-:\/@])([A-Za-z0-9._%+-]+):([^\s\/@"'<>\\:]+)@(?=[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
// "mailto:pat@example.com" is an address link, not user:password@host.
const URI_PREFIXES = new Set(['mailto', 'tel', 'sms', 'sip', 'sips', 'xmpp', 'im', 'facetime', 'callto', 'geo', 'maps',
  // Labels in front of an address ("Email:pat@example.com", "Reply-To:pat@..."), not a user name (Codex #6375 r26).
  'email', 'e-mail', 'mail', 'contact', 'reply-to', 'replyto', 'from', 'to', 'cc', 'bcc', 'owner', 'tenant', 'billing', 'office', 'manager']);
const URL_USERINFO_RE = /^([a-z][a-z0-9+.-]*:(?:\\?\/){2}[^\s/:@?#\\]*:)[^\s/@?#\\]+@/i;
// A value may hold a JSON-escaped slash (token=abc\/hunter22): it is part of the value (Codex #6375 r15).
const QUERY_PARAM_RE = /([?&#;])([A-Za-z0-9_.%+[\]-]+)=((?:[^&#\s"'<>\\]|\\\/)*)/g;
// Credential names that are not credential words as a field name but are as a
// query key (the same short list signed-link-redaction.js keeps for links).
const EXTRA_QUERY_KEYS = new Set(['key', 'auth', 'sid', 'ticket', 'pwd', 'pass', 'sessionid', 'authtoken', 'accesstoken', 'idtoken', 'apikey', 'awsaccesskeyid', 'key-pair-id']);
// 9dd-dd-dddd is an ITIN (a taxpayer number): removed like an SSN (Codex #6375 r24).
const SSN_RE = /(?<![\d-])(?!000|666)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;
const LONG_RUN_RE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

// A query name may be percent-encoded ("%74oken" is "token" to the server);
// malformed encoding fails closed (the value is removed).
function isCredentialQueryKey(rawKey) {
  let key;
  try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch { return true; }
  const lower = key.toLowerCase();
  if (EXTRA_QUERY_KEYS.has(lower) || EXTRA_QUERY_KEYS.has(lower.replace(/[^a-z0-9-]/g, ''))) return true;
  return lower.startsWith('x-amz-') || lower.startsWith('x-goog-') || isCredentialName(key);
}

function scrubUrl(url) {
  return url
    .replace(URL_USERINFO_RE, `$1${REMOVED}@`)
    .replace(QUERY_PARAM_RE, (match, lead, key, value) => (value && isCredentialQueryKey(key) ? `${lead}${key}=${REMOVED}` : match));
}

// scrubPans gives up on a run of more than 120 digits (bulk dumps). For a returned
// note such a run is scanned for a Luhn-valid 13-19 digit window made of whole
// separator-delimited groups, so a card inside a long grouped run is masked too
// (Codex #6375 r10).
const LONG_DIGIT_RUN_RE = /\d+(?:[\s,./-]{1,40}\d+)*/g;
const PAN_LENGTHS = [16, 15, 19, 14, 13, 18, 17];
function maskPansInRun(run) {
  const groups = [];
  for (const m of run.matchAll(/\d+/g)) groups.push({ digits: m[0], start: m.index, end: m.index + m[0].length });
  const edits = [];
  let cursor = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].start < cursor) continue;
    let sum = 0;
    const endByLength = new Map();
    for (let j = i; j < groups.length && sum <= 19; j += 1) {
      sum += groups[j].digits.length;
      if (sum >= 13 && sum <= 19 && !endByLength.has(sum)) endByLength.set(sum, j);
    }
    for (const len of PAN_LENGTHS) {
      if (!endByLength.has(len)) continue;
      const j = endByLength.get(len);
      const digits = groups.slice(i, j + 1).map(group => group.digits).join('');
      if (!/^[2-6]/.test(digits) || !luhnValid(digits)) continue;
      edits.push({ start: groups[i].start, end: groups[j].end, text: `[card ending ${digits.slice(-4)}]` });
      cursor = groups[j].end;
      break;
    }
  }
  return edits;
}
// The card numbers inside long digit runs, as edits ({ start, end, text }) in `text` offsets.
function longDigitRunEdits(text) {
  const edits = [];
  for (const match of text.matchAll(LONG_DIGIT_RUN_RE)) {
    if ((match[0].match(/\d/g) || []).length <= 120) continue;
    for (const edit of maskPansInRun(match[0])) edits.push({ ...edit, start: edit.start + match.index, end: edit.end + match.index });
  }
  return edits;
}

// Masks the card numbers in `text` and nothing else: returns the text with ONLY the card-number spans
// replaced ("[card ending 1111]", plus the expiry and security code written beside the number), and
// `pans` (scrubPans found something) and `longRuns` (cards found inside runs of more than 120 digits).
// The search reads a normalized copy (typographic dashes and spaces, full-width digits, invisible
// characters), but every edit is mapped back to the original characters, so a note's other dashes,
// spaces and digits come back byte for byte (Codex #6375 r24; follow-up to #6375 known limit).
function maskCardSpans(text) {
  const { plain, origin } = plainDigitsAndSeparators(text);
  const pans = scrubPansTracked(createEditTracker(plain));
  const panEdits = trackedEditList(pans.tracker);
  const longEdits = longDigitRunEdits(pans.tracker.text);
  const tracker = applyTrackedEdits(pans.tracker, longEdits);
  const edits = trackedEditList(tracker);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    const from = origin[edit.start];
    out += text.slice(cursor, from) + edit.text;
    cursor = origin[edit.end - 1] + 1;
  }
  return { text: out + text.slice(cursor), pans: panEdits.length > 0, longRuns: longEdits.length };
}

// Structural backstop for secret formats no rule names (Codex #6375 r10): a token
// of 20+ characters that mixes letters and digits and looks random (10+ distinct
// characters, no run of one character longer than 4) is removed. Record ids stay:
// UUIDs, ISO dates and timestamps, the redaction markers, and anything inside a link
// the link rules already judged.
const BACKSTOP_TOKEN_RE = /[^\s,;:="'{}[\]()]+/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
// Readable text is not random: an e-mail address, or a token that splits on - _ . /
// into plain words and short numbers ("door-code-is-1234-west-side",
// "invoice_2026_10_service_report.pdf"), stays (Codex #6375 r11).
// A plain word is lower-case, UPPER-case or Capitalized and at most 24 letters: random
// mixed-case letters ("QxLmVbTnRk...") are not a word (Codex #6375 r12 audit P1).
const PLAIN_PART_RE = /^(?:[a-z]{1,24}|[A-Z]{1,24}|[A-Z][a-z]{1,23}|\d{1,6})$/;
const isReadableToken = token => token.includes('@') || token.split(/[-_./]/).filter(Boolean).every(part => PLAIN_PART_RE.test(part));
const letterDigitTransitions = token => (token.match(/[A-Za-z]\d|\d[A-Za-z]/g) || []).length;
function looksLikeRandomToken(token) {
  if (token.length < 20 || !/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
  if (UUID_RE.test(token) || ISO_DATE_RE.test(token) || isReadableToken(token)) return false;
  if (new Set(token).size < 10 || letterDigitTransitions(token) < 3) return false;
  return !/(.)\1{4}/.test(token);
}
function scrubRandomTokens(text) {
  const links = [];
  for (const m of text.matchAll(URL_RE)) links.push([m.index, m.index + m[0].length]);
  let count = 0;
  const out = text.replace(BACKSTOP_TOKEN_RE, (token, at) => {
    if (!looksLikeRandomToken(token) || links.some(([from, to]) => at >= from && at < to)) return token;
    count += 1;
    return REMOVED;
  });
  return { text: out, count };
}

// Applies the credential-assignment rule above to one string. The first credential key with something
// after its separator wins: everything after the separator goes.
function scrubCredentialAssignments(text) {
  const pattern = new RegExp(CREDENTIAL_ASSIGN_RE.source, CREDENTIAL_ASSIGN_RE.flags);
  let links = null;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [whole, dash, , key, sep] = match;
    // A command-line option (--password=x, --api-key=x, mysql's -p=x) is a key with a dash prefix (Codex #6375 r26).
    const shortPasswordOption = dash === '-' && key.toLowerCase() === 'p' && sep.includes('=');
    if (!(shortPasswordOption || isAssignmentSecretKey(key) || (sep.includes('=') && isEnvSecretName(key)))) continue;
    if (!links) links = [...text.matchAll(URL_RE)].map(link => [link.index, link.index + link[0].length]);
    if (links.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const sepEnd = match.index + whole.length;
    const rest = text.slice(sepEnd).trim();
    if (rest === '' || isAlreadyRemoved(rest)) break;
    return { text: `${text.slice(0, sepEnd)}${REMOVED}`, count: 1 };
  }
  return { text, count: 0 };
}

// Returns { text, removed }. `removed` counts the replacements.
function scrubNoteText(input) {
  let removed = 0;
  const swap = () => { removed += 1; return REMOVED; };
  let text = trimToScanLimit(input);
  text = text.replace(PEM_RE, swap);
  text = text.replace(ANY_SCHEME_USERINFO_RE, (match, scheme) => { removed += 1; return `${scheme}${REMOVED}@`; });
  text = text.replace(BARE_USERINFO_RE, (match, user, secret) => (isAlreadyRemoved(secret) || URI_PREFIXES.has(user.toLowerCase())
    ? match : (removed += 1, `${user}:${REMOVED}@`)));
  text = text.replace(URL_RE, (url) => {
    const clean = scrubUrl(url);
    if (clean !== url) removed += 1;
    return clean;
  });
  text = text.replace(JWT_RE, swap)
    .replace(BEARER_RE, (match, header, token) => (looksLikeBearerToken(header, token) ? `${header || ''}${swap()}` : match))
    .replace(BASIC_RE, (match, header, scheme, token) => (looksLikeBasicCredential(header, token) ? `${header || ''}${swap()}` : match));
  const assigned = scrubCredentialAssignments(text);
  removed += assigned.count;
  text = assigned.text;
  for (const pattern of PREFIXED_RES) text = text.replace(pattern, swap);
  // The card-number check reads a normalized COPY (typographic dashes and spaces, full-width digits, invisible
  // characters); only the card-number spans of the note are replaced, so the rest of the note, and a note
  // without a card number, come back byte for byte (Codex #6375 r24; span-only mask in the follow-up).
  const cards = maskCardSpans(text);
  if (cards.pans) removed += 1;
  removed += cards.longRuns;
  text = cards.text.replace(SSN_RE, swap);
  // A rule line ("--------", "======") is not a secret: the run needs 16 letters or digits. A UUID is a record id and a readable run (words and short numbers) stays, as in the backstop below.
  text = text.replace(LONG_RUN_RE, run => (!UUID_RE.test(run) && !isReadableToken(run) && (run.match(/[A-Za-z0-9]/g) || []).length >= 16 ? swap() : run));
  const backstop = scrubRandomTokens(text);
  removed += backstop.count;
  text = backstop.text;
  return { text, removed };
}

// The masked text when `text` holds a card number (read on the normalized copy), else null. Used for a
// structured note, whose items are joined before the check (Codex #6375 r24).
function maskCardNumbers(text) {
  // The long-run pass too: a card number inside more than 120 joined digits (pre-push audit).
  const masked = maskCardSpans(text).text;
  return masked === text ? null : masked;
}

// A scrubbed note, cut to NOTE_CAP characters with "[cut]" at the end.
// `truncated` says a caller already cut the input (the original was longer),
// so the marker still shows that content was dropped (Codex #6375 r3).
function scrubNote(input, { truncated = false } = {}) {
  const { text, removed } = scrubNoteText(input);
  const cut = truncated || String(input).length > SCAN_LIMIT || text.length > NOTE_CAP;
  return { text: cut ? `${text.slice(0, NOTE_CAP)}${CUT}` : text, removed };
}

module.exports = { scrubNote, scrubNoteText, maskCardNumbers, trimToScanLimit, NOTE_CAP, SCAN_LIMIT, CUT, REMOVED };
