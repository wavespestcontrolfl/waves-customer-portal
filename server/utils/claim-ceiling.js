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
 * Two ceilings fall out of it — see the note above them: the stall watchdog
 * rings well before a peer is allowed to take a still-beating claim away,
 * because a premature bell costs a notification and a premature reclaim costs
 * duplicate side effects on a customer's record.
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
  // Every leg processRecording can run SEQUENTIALLY on one pass, counted at
  // its own timeout: the download, three transcriptions (primary, provider
  // fallback, contact dictation), two labeling attempts, two V1 extraction
  // attempts, and the V2 fallback chain. This is the worst case a HEALTHY
  // pass can legitimately reach — both ceilings sit above it.
  // The dispatcher's OWN budget, not a mirror of it: a change there must move
  // this ceiling with it (existing-mechanism rule).
  const { DEFAULT_FALLBACK_BUDGET_MS } = require('../services/llm/call');
  return download + (3 * transcription) + (2 * label) + (2 * extraction) + DEFAULT_FALLBACK_BUDGET_MS;
}

// TWO ceilings, because alerting and stealing carry opposite risks.
//
// Ringing a bell early on a pass that turns out to be healthy costs one
// notification. RECLAIMING a live claim costs duplicate side effects on a
// customer's record, so it must never happen to a pass that is merely slow.
// ONE threshold, and it only ever rings a BELL.
//
// Reclaim is heartbeat-only: a ceiling that lets a peer take a still-beating
// claim has to sit above the longest legitimate pass, the pipeline contains
// provider calls with no bounded timeout, and a ceiling set too low steals
// live work and duplicates side effects on a customer's record. Alerting has
// no such downside — a false bell costs one notification — so this ceiling
// governs the watchdog alone.
//
// Neither number is an attempt to enumerate the call graph. The processor can
// run more legs than the four timeouts describe — a second labeling attempt,
// the contact-dictation transcription, the V2 extraction fallback chain, the
// contact decoder — and any count of them is wrong the next time that graph
// changes. These are MULTIPLES of what is measurable, chosen large enough
// that an unenumerated leg cannot cross them. At the shipped defaults that is
// a 30-minute bell and a 60-minute reclaim, against a 20-minute measured
// budget and a worst case around 35.
//
// The complete answer is one end-to-end deadline enforced INSIDE the pass, so
// no leg can outlive it and the ceiling becomes true by construction rather
// than by margin. That needs cancellation threaded through every provider
// await and is deliberately not attempted here.
const ALERT_HEADROOM = 1.2;

// When the stall watchdog should ring about a claim that is still beating.
function alertCeilingMinutes() {
  return Math.ceil((providerBudgetMs() * ALERT_HEADROOM) / 60000);
}

module.exports = { alertCeilingMinutes, providerBudgetMs, ALERT_HEADROOM };
