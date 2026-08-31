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
const SETTLED_SKIP_COPY = {
  already_processed: 'Already processed — use Reprocess to re-run extraction.',
  spam: 'Processed — classified as spam.',
  voicemail: 'Processed — classified as voicemail.',
  pan_quarantined: 'Quarantined — a card number was read aloud, so the recording is not stored.',
  already_has_recording: 'Already has its recording — nothing to recover.',
  already_recovered_by_peer: 'Another pass already recovered this recording.',
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

// Skips where NOTHING ran. Each one leaves the call exactly as it was, so
// the operator has to know the button did not do what it looks like it did.
const BLOCKED_SKIP_COPY = {
  // Names PROCESS, not Reprocess: the row is still 'processing', and both
  // lists label the control by status — Reprocess appears only once a row
  // reads 'processed'. Pointing at a button the operator cannot see is its
  // own small lie.
  already_processing: 'Nothing ran — another pass still holds this call. Give it about ten minutes, then hit Process again.',
  recording_not_ready: "Nothing ran — the recording hasn't landed from Twilio yet.",
  terminal_write_ownership_lost: 'Nothing was saved — another pass took this call over mid-run.',
  transcription_rejected_ownership_lost: 'Nothing was saved — another pass took this call over mid-run.',
  no_completed_recording: 'Nothing ran — Twilio has no completed recording for this call.',
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
    if (SETTLED_SKIP_COPY[reason]) {
      return { didWork: true, severity: 'ok', text: SETTLED_SKIP_COPY[reason] };
    }
    // Unknown reasons fail CLOSED — an unrecognised skip is reported as
    // nothing-ran rather than quietly styled as success. That default is
    // the whole point of this module.
    return { didWork: false, severity: 'blocked', text: BLOCKED_SKIP_COPY[reason] || `Nothing ran — ${reason}` };
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
