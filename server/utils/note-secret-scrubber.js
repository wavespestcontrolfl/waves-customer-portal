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
 *  - any other run of 32 or more base64/hex characters
 */
const { scrubPans } = require('./pan-scrub');
const { isCredentialName } = require('./credential-fields');

const REMOVED = '[removed]';
const NOTE_CAP = 1000;
const CUT = '[cut]';
// A note longer than this is cut before scrubbing: only NOTE_CAP characters are
// ever returned, and the scan stays cheap on a huge value.
const SCAN_LIMIT = 20000;

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
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
// HTTP Basic credentials ("Authorization: Basic dXNlcjpwYXNz", or bare "Basic <base64>").
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+\/]{8,}={0,2}/g;
// An environment-style assignment whose NAME says it is a secret (DB_PASSWORD=x,
// STRIPE_SECRET_KEY=x, API_TOKEN=x). A fixed config format, not a prose label:
// upper-case name, '=', no spaces (Codex #6375 r2).
const ENV_SECRET_RE = /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;
// user:password@ in a link of ANY scheme (postgresql://, redis://, ftp://,
// smb://, ...); the http(s) links above also go through scrubUrl (Codex #6375).
const ANY_SCHEME_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@:"'<>]*:[^\s\/@"'<>]+@/gi;
const URL_USERINFO_RE = /^(https?:\/\/[^\s/:@?#]*:)[^\s/@?#]+@/i;
const QUERY_PARAM_RE = /([?&#;])([A-Za-z0-9_.%+[\]-]+)=([^&#\s"'<>\\]*)/g;
// Credential names that are not credential words as a field name but are as a
// query key (the same short list signed-link-redaction.js keeps for links).
const EXTRA_QUERY_KEYS = new Set(['key', 'auth', 'sid', 'ticket', 'pwd', 'sessionid', 'authtoken', 'accesstoken', 'idtoken', 'apikey', 'awsaccesskeyid', 'key-pair-id']);
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

// Returns { text, removed }. `removed` counts the replacements.
function scrubNoteText(input) {
  let removed = 0;
  const swap = () => { removed += 1; return REMOVED; };
  let text = String(input).slice(0, SCAN_LIMIT);
  text = text.replace(PEM_RE, swap);
  text = text.replace(ANY_SCHEME_USERINFO_RE, (match, scheme) => { removed += 1; return `${scheme}${REMOVED}@`; });
  text = text.replace(URL_RE, (url) => {
    const clean = scrubUrl(url);
    if (clean !== url) removed += 1;
    return clean;
  });
  text = text.replace(JWT_RE, swap).replace(BEARER_RE, swap).replace(BASIC_RE, swap);
  text = text.replace(ENV_SECRET_RE, (match, name) => { removed += 1; return `${name}=${REMOVED}`; });
  for (const pattern of PREFIXED_RES) text = text.replace(pattern, swap);
  const noPans = scrubPans(text);
  if (noPans !== text) removed += 1;
  text = noPans.replace(SSN_RE, swap);
  // A rule line ("--------", "======") is not a secret: the run needs 16 letters or digits.
  text = text.replace(LONG_RUN_RE, run => ((run.match(/[A-Za-z0-9]/g) || []).length >= 16 ? swap() : run));
  return { text, removed };
}

// A scrubbed note, cut to NOTE_CAP characters with "[cut]" at the end.
function scrubNote(input) {
  const { text, removed } = scrubNoteText(input);
  const cut = String(input).length > SCAN_LIMIT || text.length > NOTE_CAP;
  return { text: cut ? `${text.slice(0, NOTE_CAP)}${CUT}` : text, removed };
}

module.exports = { scrubNote, scrubNoteText, NOTE_CAP, SCAN_LIMIT, CUT, REMOVED };
