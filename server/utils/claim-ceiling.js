/**
 * How long any single call-processing claim may be held, in the worst case,
 * before it is reclaimable no matter what its heartbeat says.
 *
 * The heartbeat runs on a TIMER, so it keeps beating while a pass is alive
 * even when the work is hung on an open socket — a heartbeat-only reclaim
 * rule leaves such a claim unreclaimable forever. The ceiling is the backstop.
 *
 * It is DERIVED, not guessed. A healthy pass can legitimately run the full
 * provider budget end to end: download, transcription (primary and fallback),
 * speaker labeling, extraction (primary and its cross-provider fallback). At
 * the shipped defaults that sums to exactly 20 minutes, so a flat 20-minute
 * ceiling would have reclaimed a slow-but-working pass out from under itself.
 * Computing from the same env vars the processor reads keeps the ceiling
 * above the budget automatically when an operator tunes a timeout up.
 *
 * The 1.5x factor covers what the provider budgets do not: the CDN-settle
 * retry between legs, database round trips, and event-loop pressure on a
 * shared instance.
 */

function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Mirrors PROVIDER_FETCH_TIMEOUTS_MS in call-recording-processor.js — pinned
// by a contract test so the two cannot drift apart silently.
function providerBudgetMs() {
  const download = envMs('CALL_PROC_DOWNLOAD_TIMEOUT_MS', 120000);
  const transcription = envMs('CALL_PROC_TRANSCRIBE_TIMEOUT_MS', 300000);
  const label = envMs('CALL_PROC_LABEL_TIMEOUT_MS', 120000);
  const extraction = envMs('CALL_PROC_EXTRACT_TIMEOUT_MS', 180000);
  // Transcription and extraction each have a fallback leg that runs AFTER the
  // primary one times out, so both count twice.
  return download + (2 * transcription) + label + (2 * extraction);
}

const HEADROOM = 1.5;

function claimAbsoluteCeilingMinutes() {
  return Math.ceil((providerBudgetMs() * HEADROOM) / 60000);
}

module.exports = { claimAbsoluteCeilingMinutes, providerBudgetMs, HEADROOM };
