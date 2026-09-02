// How to read a POST /admin/call-recordings/process/:callSid response.
//
// Why this exists: on 2026-08-31 the owner hit Process on a hot new-lead
// call at 09:54, saw a success-styled line, and believed it had run. It had
// not — a dead pass still held the claim, so the route returned
// `{ success: true, skipped: true, reason: 'already_processing' }` with HTTP
// 200 and the UI painted that as done. The call sat another 18 minutes and
// the caller rang back to chase his estimate.
//
// The contract the surfaces need is narrower than the raw response: did the
// pipeline actually do the work it was asked to do? `success: true` does not
// answer that — several skips are HTTP 200 successes in which nothing ran.

// Skips where the pipeline DID reach a real outcome. Nothing is wrong and
// nothing is owed; the row is in the state the operator wanted.
//
// Scoped to what POST /admin/call-recordings/process/:callSid can actually
// return — that route runs processRecording. The recovery sweep
// (recoverRecordingForCall) has its own reasons; speculating about them
// here would be policy no client path exercises, free to drift from the
// endpoint it claims to describe.
const SETTLED_SKIP_COPY = {
  already_processed: 'Already processed — use Reprocess to re-run extraction.',
  spam: 'Processed — classified as spam.',
  voicemail: 'Processed — classified as voicemail.',
  // NOT a failure and NOT a no-op: the run completed and persisted the
  // extraction, summary, sentiment, lead quality and a terminal status, then
  // deliberately withheld the customer/lead/appointment writes and opened a
  // review. Calling that "nothing was saved" invites a pointless reprocess.
  v2_canonical_write_blocked:
    'Processed and held for review — no customer, lead or appointment was created from it.',
  // Also settled, not pending: the server stamps a terminal rejection,
  // dismisses stale triage cards and retires artifacts a prior hallucinated
  // extraction left behind. Nothing is owed and a Reprocess would be wasted.
  transcription_rejected_implausible:
    "Rejected — the transcript didn't plausibly belong to this call, so it was discarded.",
};

// Skips where the pipeline never got to finish its work, so the operator has
// to know the button did not do what it looks like it did.
const BLOCKED_SKIP_COPY = {
  // Names PROCESS, not Reprocess: the row is still 'processing', and both
  // lists label the control by status — Reprocess appears only once a row
  // reads 'processed'. Pointing at a button the operator cannot see is its
  // own small lie.
  // Fallback only — the route sends its own message naming the real retry
  // window, which differs for a forced run. See describeProcessResult.
  already_processing: 'Nothing ran — another pass still holds this call. Try again once it goes quiet.',
  recording_not_ready: "Nothing ran — the recording hasn't landed from Twilio yet.",
  // NOT "nothing was saved": the transcript is persisted before the terminal
  // fence, so a pass that loses its claim here may already have written real
  // work. What it could not do is finish and stamp the outcome.
  terminal_write_ownership_lost:
    "Didn't finish — another pass took this call over mid-run. Reload before deciding whether to re-run it.",
  transcription_rejected_ownership_lost:
    "Didn't finish — another pass took this call over mid-run. Reload before deciding whether to re-run it.",
};

/**
 * @param {object|null} res parsed JSON body from the process route
 * @returns {{didWork: boolean, severity: 'ok'|'blocked'|'failed', text: string}}
 *   didWork  — the pipeline reached a real outcome for this call
 *   severity — 'blocked' is the one this module exists for: HTTP 200,
 *              success:true, and nothing actually ran. It is not an error
 *              (nothing broke) and it is not success (nothing happened), so
 *              surfaces render it as a warning, not in the alert red.
 */
export function describeProcessResult(res) {
  if (res?.success === false && !res?.skipped) {
    return { didWork: false, severity: 'failed', text: `Process failed — ${res.error || 'unknown error'}` };
  }
  if (res?.skipped) {
    const reason = res.reason || 'unknown';
    // A settled skip needs the SAME explicit confirmation a completed run
    // does. Every settled reason processRecording returns carries
    // success: true, so `{skipped: true, reason: 'spam'}` without it is a
    // malformed response, not a classified call — and letting it through
    // would put the fail-closed guarantee back where it started. Blocked
    // reasons deliberately don't check: recording_not_ready is a genuine
    // success: false.
    if (res.success === true && SETTLED_SKIP_COPY[reason]) {
      return { didWork: true, severity: 'ok', text: SETTLED_SKIP_COPY[reason] };
    }
    // Unknown reasons fail CLOSED — an unrecognised skip is reported as
    // nothing-ran rather than quietly styled as success. That default is
    // the whole point of this module.
    // Prefer the SERVER's own explanation when it sent one: the retry window
    // depends on whether the run was forced, and only the server knows which
    // constants apply. The table below is the fallback for a body that
    // carries no message.
    const served = typeof res.error === 'string' && res.error.trim() ? res.error.trim() : null;
    return {
      didWork: false,
      severity: 'blocked',
      text: served || BLOCKED_SKIP_COPY[reason] || `Nothing ran — ${reason}`,
    };
  }
  // FAIL CLOSED on anything that is not an explicit success. The processor's
  // happy path always sets success: true, so a null body, an empty object, or
  // a response missing the flag is a malformed or regressed API — and
  // treating that as a completed run is precisely the false success this
  // module exists to stop.
  if (res?.success !== true) {
    return {
      didWork: false,
      severity: 'failed',
      text: 'Process failed — the server did not confirm the run.',
    };
  }
  const extracted = res?.extracted || {};
  const parts = [];
  const name = [extracted.first_name, extracted.last_name].filter(Boolean).join(' ');
  if (name) parts.push(`Name: ${name}`);
  if (extracted.email) parts.push(`Email: ${extracted.email}`);
  const addr = extracted.address_line1 || extracted.address;
  if (addr) parts.push(`Address: ${addr}`);
  return {
    didWork: true,
    severity: 'ok',
    text: `Processed${parts.length ? ` — ${parts.join(' · ')}` : ''}`,
  };
}
