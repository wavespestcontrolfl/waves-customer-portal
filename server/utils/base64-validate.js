// Stack-safe base64 charset validation for user-supplied image payloads.
//
// One anchored regex over a multi-megabyte subject can exhaust V8's regex
// backtrack stack when little machine stack is left, throwing RangeError
// "Maximum call stack size exceeded" — the cause of the CI-only 500 flake in
// the IB image-turn test, where a 7MB attachment hit a whole-string
// /^[A-Za-z0-9+/]+={0,2}$/ on a loaded 2-worker runner. Trailing padding is
// stripped up front and the charset is checked in 64KB slices, so no regex
// ever scans an unbounded subject.
//
// Semantics match the whole-string form: non-empty, length % 4 === 0, '='
// only as 1–2 trailing padding chars, all other chars in the base64 set.
const BASE64_CHUNK_RE = /^[A-Za-z0-9+/]+$/;
const VALIDATE_SLICE = 65536;

function isValidBase64(data) {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0) return false;
  let end = data.length;
  if (data.endsWith('==')) end -= 2;
  else if (data.endsWith('=')) end -= 1;
  if (end === 0) return false;
  for (let i = 0; i < end; i += VALIDATE_SLICE) {
    if (!BASE64_CHUNK_RE.test(data.slice(i, Math.min(i + VALIDATE_SLICE, end)))) return false;
  }
  return true;
}

module.exports = { isValidBase64 };
