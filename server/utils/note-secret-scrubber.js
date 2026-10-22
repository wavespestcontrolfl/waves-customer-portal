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
 *  - card numbers (Luhn, utils/pan-scrub.js)
 *  - SSN pattern ddd-dd-dddd
 *  - the value of a structural credential assignment: a key whose last word is
 *    password, passwd, secret, token, api key, credential, auth or authorization,
 *    then '=' or ':' and 4+ characters ("db.password: x", "X-API-Key: x"); and an
 *    "Authorization:" header with any scheme word ("Token x", "Digest x")
 *  - any other run of 32 or more base64/hex characters
 *  - a Luhn-valid card number inside a digit run longer than 120 digits
 *  - backstop: any other 20+ character token that mixes letters and digits and
 *    looks random (10+ distinct characters, no repeat run over 4); UUIDs, ISO
 *    dates and links are kept
 */
const { scrubPans, luhnValid } = require('./pan-scrub');
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
function trimToScanLimit(input) {
  const text = String(input);
  if (text.length <= SCAN_LIMIT) return text;
  const tail = text.slice(SCAN_LIMIT - BACKOFF, SCAN_LIMIT);
  const at = tail.search(/[\s,;"'(){}[\]<>][^\s,;"'(){}[\]<>]*$/);
  return text.slice(0, at >= 0 ? SCAN_LIMIT - BACKOFF + at : SCAN_LIMIT - BACKOFF);
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
// An environment-style assignment whose NAME says it is a secret (DB_PASSWORD=x,
// STRIPE_SECRET_KEY=x, API_TOKEN=x). A fixed config format, not a prose label:
// upper-case name, '=', no spaces (Codex #6375 r2).
const ENV_SECRET_RE = /\b((?:[A-Z][A-Z0-9_]*)?(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)=(\\"(?:[^\\\n]|\\(?!"))*\\"|\\'(?:[^\\\n]|\\(?!'))*\\'|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
// Structural credential assignments in a config or header format (Codex #6375 r7):
// "db.password: hunter22", "DB_PASSWORD = hunter22", "X-API-Key: abc123xyz",
// "Authorization: Token abc123xyz". The KEY must end in a credential word (names
// split on . _ - and camelCase), then optional spaces, '=' or ':', optional
// spaces, and a value of 4+ characters. The key stays, the value is replaced.
// Still no prose rules: "the password is in the lockbox" has no '=' or ':' and
// "gate code: 1234" has no credential word, so both come back as written.
// The header's whole value goes, to the end of the line: a parameterized scheme
// (Digest username=..., nonce=..., response=...; AWS4-HMAC-SHA256 ... Signature=...)
// carries secrets after its first token (Codex #6375 r8).
// Any length: the header itself says the rest is credential material (Codex #6375 r9).
const AUTH_HEADER_RE = /(\bauthorization[ \t]*[:=][ \t]*)([A-Za-z][A-Za-z0-9_-]*)[ \t]+([^\n]+)/gi;
// The key may sit in paired quotes, as in serialized JSON or YAML:
// {"password":"hunter22"} (Codex #6375 r9).
// A quoted value honors backslash escapes (\" inside JSON); an unquoted value stops at a field delimiter, so a harmless field before it
// ("id":1,"password":"x") cannot swallow the next one (pre-push audit, r9).
// A double-serialized blob keeps its quotes escaped ({\"password\":\"hunter22\"}); the key and
// value quotes may be a backslash plus a quote, and the output keeps that shape (Codex #6375 r11).
const KEY_ASSIGN_RE = /(?<![A-Za-z0-9_.-])(\\?["']?)((?:api[ \t]+)?[A-Za-z][A-Za-z0-9_.-]*)\1([ \t]*[=:][ \t]*)(\\"(?:[^\\\n]|\\(?!"))*\\"|\\'(?:[^\\\n]|\\(?!'))*\\'|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s,;}\]"']{4,})/gi;
const ASSIGN_KEY_WORDS = new Set(['password', 'passwd', 'secret', 'token', 'apikey', 'credential', 'credentials', 'auth', 'authorization']);
function isAssignmentSecretKey(key) {
  const words = nameWords(key);
  const last = words[words.length - 1];
  if (ASSIGN_KEY_WORDS.has(last)) return true;
  return last === 'key' && words[words.length - 2] === 'api';
}
// Matched by the marker's opening (an unquoted value now stops before ']').
const REMOVED_OPEN = REMOVED.replace(/\]$/, '');
const isAlreadyRemoved = value => value.replace(/^\\?["']/, '').startsWith(REMOVED_OPEN);

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
// A JSON-escaped link (https:\/\/user:pw@host\/path) is a link too: the scheme slashes
// and the path may carry a backslash before each slash (Codex #6375 r10).
// Any scheme: postgresql://, redis://, ftp:// links carry credential query names too (Codex #6375 r12).
const URL_RE = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:(?:\\?\/){2}(?:[^\s"'<>\\]|\\\/)+/gi;
// user:password@ in a link of ANY scheme (postgresql://, redis://, ftp://,
// smb://, ...); the http(s) links above also go through scrubUrl (Codex #6375).
const ANY_SCHEME_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:(?:\\?\/){2})[^\s\/@:"'<>\\]*:[^\s\/@"'<>\\]+@/gi;
const URL_USERINFO_RE = /^([a-z][a-z0-9+.-]*:(?:\\?\/){2}[^\s/:@?#\\]*:)[^\s/@?#\\]+@/i;
const QUERY_PARAM_RE = /([?&#;])([A-Za-z0-9_.%+[\]-]+)=([^&#\s"'<>\\]*)/g;
// Credential names that are not credential words as a field name but are as a
// query key (the same short list signed-link-redaction.js keeps for links).
const EXTRA_QUERY_KEYS = new Set(['key', 'auth', 'sid', 'ticket', 'pwd', 'pass', 'sessionid', 'authtoken', 'accesstoken', 'idtoken', 'apikey', 'awsaccesskeyid', 'key-pair-id']);
const SSN_RE = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;
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
  let out = '';
  let cursor = 0;
  let count = 0;
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
      out += `${run.slice(cursor, groups[i].start)}[card ending ${digits.slice(-4)}]`;
      cursor = groups[j].end;
      count += 1;
      break;
    }
  }
  return { text: out + run.slice(cursor), count };
}
function scrubLongDigitRuns(text) {
  let count = 0;
  const out = text.replace(LONG_DIGIT_RUN_RE, (run) => {
    if ((run.match(/\d/g) || []).length <= 120) return run;
    const masked = maskPansInRun(run);
    count += masked.count;
    return masked.text;
  });
  return { text: out, count };
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

// Returns { text, removed }. `removed` counts the replacements.
function scrubNoteText(input) {
  let removed = 0;
  const swap = () => { removed += 1; return REMOVED; };
  let text = trimToScanLimit(input);
  text = text.replace(PEM_RE, swap);
  text = text.replace(ANY_SCHEME_USERINFO_RE, (match, scheme) => { removed += 1; return `${scheme}${REMOVED}@`; });
  text = text.replace(URL_RE, (url) => {
    const clean = scrubUrl(url);
    if (clean !== url) removed += 1;
    return clean;
  });
  text = text.replace(JWT_RE, swap)
    .replace(BEARER_RE, (match, header, token) => (looksLikeBearerToken(header, token) ? `${header || ''}${swap()}` : match))
    .replace(BASIC_RE, (match, header, scheme, token) => (looksLikeBasicCredential(header, token) ? `${header || ''}${swap()}` : match));
  text = text.replace(ENV_SECRET_RE, (match, name) => { removed += 1; return `${name}=${REMOVED}`; });
  text = text.replace(AUTH_HEADER_RE, (match, head, scheme, value) => (isAlreadyRemoved(scheme) || isAlreadyRemoved(value) ? match : `${head}${swap()}`));
  text = text.replace(KEY_ASSIGN_RE, (match, quote, key, sep, value) => {
    if (isAlreadyRemoved(value) || !isAssignmentSecretKey(key)) return match;
    removed += 1;
    const valueQuote = (value.match(/^\\?["']/) || [''])[0];
    return `${quote}${key}${quote}${sep}${valueQuote}${REMOVED}${valueQuote}`;
  });
  for (const pattern of PREFIXED_RES) text = text.replace(pattern, swap);
  const noPans = scrubPans(text);
  if (noPans !== text) removed += 1;
  const longRuns = scrubLongDigitRuns(noPans);
  removed += longRuns.count;
  text = longRuns.text.replace(SSN_RE, swap);
  // A rule line ("--------", "======") is not a secret: the run needs 16 letters or digits. A UUID is a record id and a readable run (words and short numbers) stays, as in the backstop below.
  text = text.replace(LONG_RUN_RE, run => (!UUID_RE.test(run) && !isReadableToken(run) && (run.match(/[A-Za-z0-9]/g) || []).length >= 16 ? swap() : run));
  const backstop = scrubRandomTokens(text);
  removed += backstop.count;
  text = backstop.text;
  return { text, removed };
}

// A scrubbed note, cut to NOTE_CAP characters with "[cut]" at the end.
// `truncated` says a caller already cut the input (the original was longer),
// so the marker still shows that content was dropped (Codex #6375 r3).
function scrubNote(input, { truncated = false } = {}) {
  const { text, removed } = scrubNoteText(input);
  const cut = truncated || String(input).length > SCAN_LIMIT || text.length > NOTE_CAP;
  return { text: cut ? `${text.slice(0, NOTE_CAP)}${CUT}` : text, removed };
}

module.exports = { scrubNote, scrubNoteText, trimToScanLimit, NOTE_CAP, SCAN_LIMIT, CUT, REMOVED };
