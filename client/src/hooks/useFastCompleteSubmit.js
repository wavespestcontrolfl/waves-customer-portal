// The shared Fast Complete /complete attempt. A prepared request is written
// to IndexedDB before it can reach the server, then kept under the same
// operator, visit and idempotency key until the server gives a definite
// answer. Reopening the sheet offers that exact request as an explicit retry;
// it never submits during hydration.
import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldResetCompletionIdempotencyKey } from '../lib/completion-idempotency';
import {
  deleteFastCompletionAttempt,
  getFastCompletionAttempt,
  putFastCompletionAttempt,
} from '../lib/completion-resume-store';

const SAVED_CODES = new Set(['service_already_completed', 'completion_resume_payload_mismatch']);
const IN_PROGRESS_CODES = new Set(['service_completion_pending', 'completion_pending', 'completion_side_effects_running']);
const DEFINITIVE_OUTCOMES = new Set(['saved', 'correctable', 'terminal']);
const CONFIRM_FLAGS = { report_rules_review: 'reportRulesConfirmed', promise_marks_changed: 'promiseMarksConfirmed' };
const STORAGE_WARNING = 'This device can’t save a reload-safe copy right now. Keep this screen open. You can still send after this warning.';

function completionFailureOutcome(err, { confirmable = false } = {}) {
  const status = Number(err?.status);
  if (status === 409 && SAVED_CODES.has(err?.code)) return 'saved';
  if (confirmable && status === 409 && CONFIRM_FLAGS[err?.code]) return 'confirm';
  if ([401, 403, 408, 425, 429].includes(status)) return 'retry';
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

function scopeOf(serviceId, operatorId, epoch) {
  return { serviceId: String(serviceId || ''), operatorId: String(operatorId || ''), epoch };
}

function sameScope(left, right) {
  return !!left && !!right
    && left.epoch === right.epoch
    && left.serviceId === right.serviceId
    && left.operatorId === right.operatorId;
}

export default function useFastCompleteSubmit({
  base, request, serviceId, operatorId, confirmable = false,
}) {
  const keyRef = useRef(genIdempotencyKey());
  const pendingBodyRef = useRef(null);
  const pendingSummaryRef = useRef('');
  const rejectedBodyRef = useRef(null);
  const persistedBodyRef = useRef(null);
  const inFlight = useRef(false);
  const scopeRef = useRef(scopeOf(serviceId, operatorId, 0));
  const storageWarningSeenRef = useRef(false);
  const [recovering, setRecovering] = useState(true);
  const [restored, setRestored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [storageWarning, setStorageWarning] = useState('');

  // A scope change invalidates every late read and response from the previous
  // operator/visit. Its durable row remains available to that original scope.
  useEffect(() => {
    const scope = scopeOf(serviceId, operatorId, scopeRef.current.epoch + 1);
    scopeRef.current = scope;
    keyRef.current = genIdempotencyKey();
    rejectedBodyRef.current = null;
    persistedBodyRef.current = null;
    pendingBodyRef.current = null;
    pendingSummaryRef.current = '';
    inFlight.current = false;
    storageWarningSeenRef.current = false;
    setRecovering(true);
    setRestored(false);
    setSubmitting(false);
    setError('');
    setFailure(null);
    setDone(null);
    setPrompt(null);
    setStorageWarning('');

    if (!scope.serviceId || !scope.operatorId) {
      // Existing callers opt into durable recovery by supplying both IDs.
      // Until their UI is migrated, retain the established in-memory submit.
      setRecovering(false);
      return undefined;
    }

    let active = true;
    getFastCompletionAttempt(scope.serviceId, scope.operatorId).then(({ available, attempt }) => {
      if (!active || !sameScope(scopeRef.current, scope)) return;
      if (!available) {
        storageWarningSeenRef.current = true;
        setStorageWarning(STORAGE_WARNING);
      }
      if (attempt?.body && typeof attempt.body.idempotencyKey === 'string' && attempt.body.idempotencyKey) {
        pendingBodyRef.current = attempt.body;
        pendingSummaryRef.current = attempt.summary || '';
        keyRef.current = attempt.body.idempotencyKey;
        persistedBodyRef.current = attempt.body;
        setRestored(true);
        setFailure('retry');
        setError('An unfinished completion is saved on this device. Tap Retry when you’re ready to send the same completion again.');
      }
      setRecovering(false);
    });
    return () => { active = false; };
  }, [serviceId, operatorId]);

  const clearStored = useCallback(async (scope, body) => {
    if (scope.serviceId && scope.operatorId && body) {
      return deleteFastCompletionAttempt(scope.serviceId, scope.operatorId, body);
    }
    return true;
  }, []);

  const persistPrepared = useCallback(async (scope, body, summary) => {
    if (!scope.serviceId || !scope.operatorId) return 'send';
    const stored = await putFastCompletionAttempt(
      scope.serviceId,
      scope.operatorId,
      { body, summary, expectedBody: persistedBodyRef.current },
    );
    if (!sameScope(scopeRef.current, scope)) return 'stale';
    if (stored) {
      persistedBodyRef.current = body;
      setStorageWarning('');
      storageWarningSeenRef.current = false;
      if (failure === 'storage') setFailure(null);
      return 'send';
    }
    // Compare the body as well as the key: another tab can confirm the same
    // request while this tab still holds its unconfirmed revision.
    const observed = await getFastCompletionAttempt(scope.serviceId, scope.operatorId);
    if (!sameScope(scopeRef.current, scope)) return 'stale';
    const observedBody = observed.attempt?.body;
    if (observed.available && JSON.stringify(observedBody) === JSON.stringify(body)) {
      persistedBodyRef.current = body;
      return 'send';
    }
    if (observed.available && (observedBody || persistedBodyRef.current)) {
      pendingBodyRef.current = null;
      pendingSummaryRef.current = '';
      storageWarningSeenRef.current = false;
      setStorageWarning('');
      setFailure('terminal');
      setError('This saved completion was changed or discarded in another tab. Close and reopen it from the schedule before continuing.');
      return 'conflict';
    }
    setStorageWarning(STORAGE_WARNING);
    if (storageWarningSeenRef.current) return 'send';
    // Stop before the network the first time storage fails. The warning is
    // now visible; the next explicit tap sends this held body unchanged.
    storageWarningSeenRef.current = true;
    setFailure('storage');
    return 'warned';
  }, [failure]);

  const settleFailure = useCallback(async (err, scope, body, summary) => {
    const outcome = completionFailureOutcome(err, { confirmable });
    const removed = DEFINITIVE_OUTCOMES.has(outcome) ? await clearStored(scope, body) : true;
    if (!sameScope(scopeRef.current, scope)) return;
    if (outcome === 'correctable' && !removed && persistedBodyRef.current) {
      rejectedBodyRef.current = body;
    }
    pendingBodyRef.current = outcome === 'retry' || outcome === 'confirm' ? body : null;
    pendingSummaryRef.current = pendingBodyRef.current ? summary : '';
    if (outcome === 'correctable') {
      if (removed) persistedBodyRef.current = null;
      keyRef.current = genIdempotencyKey();
      setRestored(false);
    }
    if (outcome === 'saved') {
      setFailure(null);
      setDone({ summary: 'This visit was already saved. The office will finish anything still pending.' });
      return;
    }
    if (outcome === 'confirm') {
      setFailure(null);
      setPrompt({ code: err.code, message: err?.message || '' });
      return;
    }
    setFailure(outcome === 'correctable' ? null : outcome);
    setError(outcomeMessage(outcome, err));
  }, [clearStored, confirmable]);

  const submit = useCallback(async (buildBody, summary) => {
    if (inFlight.current || recovering) return;
    const scope = scopeRef.current;
    const held = pendingBodyRef.current;
    const body = held || { idempotencyKey: keyRef.current, ...buildBody() };
    const heldSummary = held ? pendingSummaryRef.current : String(summary || '');
    pendingBodyRef.current = body;
    pendingSummaryRef.current = heldSummary;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    setPrompt(null);

    try {
      if (rejectedBodyRef.current) {
        const rejectedBody = rejectedBodyRef.current;
        const removed = await clearStored(scope, rejectedBody);
        if (!sameScope(scopeRef.current, scope)) return;
        if (!removed) {
          const current = await getFastCompletionAttempt(scope.serviceId, scope.operatorId);
          if (!sameScope(scopeRef.current, scope)) return;
          if (!current.available || JSON.stringify(current.attempt?.body) === JSON.stringify(rejectedBody)) {
            pendingBodyRef.current = null;
            pendingSummaryRef.current = '';
            setError('Could not clear the rejected completion on this device. Try sending again when device storage is available.');
            return;
          }
        }
        rejectedBodyRef.current = null;
        persistedBodyRef.current = null;
      }
      // Persist the exact held body, including photos, before network.
      const persistence = await persistPrepared(scope, body, heldSummary);
      if (persistence !== 'send') return;
      const result = await request(`${base}/complete`, { method: 'POST', body: JSON.stringify(body) });
      await clearStored(scope, body);
      if (!sameScope(scopeRef.current, scope)) return;
      pendingBodyRef.current = null;
      pendingSummaryRef.current = '';
      setFailure(null);
      setDone({ summary: heldSummary, customerText: result?.customerText || null, response: result || null });
    } catch (err) {
      await settleFailure(err, scope, body, heldSummary);
    } finally {
      if (sameScope(scopeRef.current, scope)) {
        setSubmitting(false);
        inFlight.current = false;
      }
    }
  }, [base, request, recovering, clearStored, persistPrepared, settleFailure]);

  const retry = useCallback(() => {
    if (!pendingBodyRef.current) return;
    return submit(() => ({}), pendingSummaryRef.current);
  }, [submit]);

  // Confirmation changes the held request, so submit persists the new exact
  // body before it sends it under the original idempotency key.
  const confirm = useCallback(() => {
    const held = pendingBodyRef.current;
    const flag = CONFIRM_FLAGS[prompt?.code];
    if (!held || !flag) return;
    pendingBodyRef.current = { ...held, [flag]: true };
    return submit(() => ({}), pendingSummaryRef.current);
  }, [prompt, submit]);

  // A deliberate discard (including going back from a confirmation prompt)
  // removes the prepared attempt. Closing the sheet does not call this: an
  // uncertain retry remains available after a reload.
  const discard = useCallback(async () => {
    if (inFlight.current) return;
    const scope = scopeRef.current;
    const body = pendingBodyRef.current;
    inFlight.current = true;
    setSubmitting(true);
    try {
      const removed = await clearStored(scope, body);
      if (!sameScope(scopeRef.current, scope)) return;
      if (!removed && persistedBodyRef.current) {
        const current = await getFastCompletionAttempt(scope.serviceId, scope.operatorId);
        if (!sameScope(scopeRef.current, scope)) return;
        if (!current.available || JSON.stringify(current.attempt?.body) === JSON.stringify(body)) {
          setError('Could not discard the saved completion on this device. Keep it open and try Discard again.');
          return;
        }
      }
      pendingBodyRef.current = null;
      pendingSummaryRef.current = '';
      keyRef.current = genIdempotencyKey();
      persistedBodyRef.current = null;
      setRestored(false);
      setFailure(null);
      setError('');
      setPrompt(null);
    } finally {
      if (sameScope(scopeRef.current, scope)) {
        inFlight.current = false;
        setSubmitting(false);
      }
    }
  }, [clearStored]);

  return {
    recovering, restored, submitting, error, failure, done, prompt, storageWarning,
    submit, retry, confirm, discard, dismissPrompt: discard,
    pendingSummary: pendingSummaryRef.current,
    retryPending: failure === 'retry' || failure === 'storage',
    storageBypassPending: failure === 'storage',
    hasPendingBody: () => !!pendingBodyRef.current,
  };
}
