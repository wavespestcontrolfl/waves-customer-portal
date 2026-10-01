// client/src/hooks/useFastCompleteSubmit.js
//
// The /complete submit every Fast Complete sheet shares (POST
// /admin/dispatch/:id/complete → completeScheduledService): one attempt at a
// time, one idempotency key per completion, and every failure sorted into
// one of four outcomes:
//  saved       — the visit is already saved: this or an earlier attempt
//                committed (a lost response, another device, or a partly
//                finished earlier try whose changed body the resume check
//                refuses — completion_resume_payload_mismatch is only
//                answered once a record exists; the office's Billing
//                Recovery finishes those).
//  correctable — a definitive pre-commit rejection: fix and resubmit under a
//                fresh key (the full form's shared rule).
//  retry       — outcome unknown or still running (network drop, 5xx, an
//                attempt pending or finishing its side effects): resend the
//                SAME body under the SAME key so the server replays/resumes.
//  terminal    — a conflict no retry can fix (a future-dated, closed or
//                changed visit, or an idempotency_key_mismatch, which the
//                server also answers for pending/failed attempts with no
//                record, so it is never proof of a save): show it and let
//                the tech leave.
import { useCallback, useRef, useState } from 'react';
import { shouldResetCompletionIdempotencyKey } from '../lib/completion-idempotency';

const SAVED_CODES = new Set(['service_already_completed', 'completion_resume_payload_mismatch']);
const IN_PROGRESS_CODES = new Set(['service_completion_pending', 'completion_pending', 'completion_side_effects_running']);
function completionFailureOutcome(err) {
  const status = Number(err?.status);
  if (status === 409 && SAVED_CODES.has(err?.code)) return 'saved';
  if (shouldResetCompletionIdempotencyKey(err)) return 'correctable';
  if (!Number.isFinite(status) || status >= 500 || (status === 409 && IN_PROGRESS_CODES.has(err?.code))) return 'retry';
  return 'terminal';
}

function outcomeMessage(outcome, err) {
  if (outcome === 'retry') {
    return `${err?.message || 'Completion failed'} We couldn't confirm it saved. Tap Retry to send the same completion again.`;
  }
  if (err?.code === 'idempotency_key_mismatch') {
    return 'Another completion for this visit is in progress or was changed. Close and reopen it from the schedule to see where it stands.';
  }
  return err?.message || 'Completion failed';
}

function genIdempotencyKey() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `fastcomplete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// One completion attempt at a time, settled into the four outcomes above.
export default function useFastCompleteSubmit({ base, request }) {
  const keyRef = useRef(null);
  if (!keyRef.current) keyRef.current = genIdempotencyKey();
  const pendingBodyRef = useRef(null);
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);

  const submit = useCallback(async (buildBody, summary) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    const body = pendingBodyRef.current || { idempotencyKey: keyRef.current, ...buildBody() };
    try {
      const result = await request(`${base}/complete`, { method: 'POST', body: JSON.stringify(body) });
      pendingBodyRef.current = null;
      setFailure(null);
      // customerText: what the server says it sent the customer (the pest
      // sheet's fixed re-service text), shown on the saved view.
      setDone({ summary, customerText: result?.customerText || null });
      // Saved: the done view can be dismissed (Close, Escape, backdrop).
      setSubmitting(false);
      inFlight.current = false;
    } catch (err) {
      const outcome = completionFailureOutcome(err);
      pendingBodyRef.current = outcome === 'retry' ? body : null;
      if (outcome === 'correctable') keyRef.current = genIdempotencyKey();
      if (outcome === 'saved') {
        setFailure(null);
        setDone({ summary: 'This visit was already saved. The office will finish anything still pending.' });
      } else {
        setFailure(outcome === 'correctable' ? null : outcome);
        setError(outcomeMessage(outcome, err));
      }
      setSubmitting(false);
      inFlight.current = false;
    }
  }, [base, request]);

  return { submitting, error, failure, done, submit, retryPending: failure === 'retry', hasPendingBody: () => !!pendingBodyRef.current };
}
