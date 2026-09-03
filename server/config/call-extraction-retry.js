// The extraction retry predicate, in one place: the processor's sweep retries
// an extraction_failed row only under this many attempts and only while the
// call is younger than this window; anything that DESCRIBES the retry state
// (the call intelligence panel's processing phase) reads the same values,
// so it can never promise a retry the sweep will not make or call retries
// exhausted while one is scheduled (Codex #3738 P2).
const CALL_EXTRACTION_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.CALL_EXTRACTION_MAX_ATTEMPTS || '3', 10) || 3);
const EXTRACTION_RETRY_WINDOW_DAYS = 7;

module.exports = { CALL_EXTRACTION_MAX_ATTEMPTS, EXTRACTION_RETRY_WINDOW_DAYS };
