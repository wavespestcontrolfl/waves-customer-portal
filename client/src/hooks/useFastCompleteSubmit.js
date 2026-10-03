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
      storageWarningSeenRef.current = true;
      setStorageWarning(STORAGE_WARNING);
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
        setRestored(true);
        setFailure('retry');
        setError('An unfinished completion is saved on this device. Tap Retry when you’re ready to send the same completion again.');
      }
      setRecovering(false);
    });
    return () => { active = false; };
  }, [serviceId, operatorId]);

  const clearStored = useCallback(async (scope, idempotencyKey) => {
    if (scope.serviceId && scope.operatorId && idempotencyKey) {
      return deleteFastCompletionAttempt(scope.serviceId, scope.operatorId, idempotencyKey);
    }
    return true;
  }, []);

  const persistPrepared = useCallback(async (scope, body, summary) => {
    const stored = await putFastCompletionAttempt(
      scope.serviceId,
      scope.operatorId,
      { body, summary },
    );
    if (!sameScope(scopeRef.current, scope)) return 'stale';
    if (stored) {
      setStorageWarning('');
      storageWarningSeenRef.current = false;
      if (failure === 'storage') setFailure(null);
      return 'send';
    }
    // A second tab may have prepared a newer attempt after this tab started.
    // Its different key owns the row; do not send or erase either attempt.
    const observed = await getFastCompletionAttempt(scope.serviceId, scope.operatorId);
    if (!sameScope(scopeRef.current, scope)) return 'stale';
    const observedKey = String(observed.attempt?.body?.idempotencyKey || '');
    if (observed.available && observedKey && observedKey !== body.idempotencyKey) {
      pendingBodyRef.current = null;
      pendingSummaryRef.current = '';
      storageWarningSeenRef.current = false;
      setStorageWarning('');
      setFailure('terminal');
      setError('Another completion for this visit was prepared in a different tab. Close and reopen it from the schedule to continue that attempt.');
      return 'conflict';
    }
    if (observed.available && observedKey === body.idempotencyKey
      && observed.attempt.summary === summary
      && JSON.stringify(observed.attempt.body) === JSON.stringify(body)) {
      return 'send';
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
    if (DEFINITIVE_OUTCOMES.has(outcome)) await clearStored(scope, body.idempotencyKey);
    if (!sameScope(scopeRef.current, scope)) return;
    pendingBodyRef.current = outcome === 'retry' || outcome === 'confirm' ? body : null;
    pendingSummaryRef.current = pendingBodyRef.current ? summary : '';
    if (outcome === 'correctable') {
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

    // The body in memory and the body on disk are the same object shape sent
    // below, including inline Tree & Shrub photos and the idempotency key.
    const persistence = await persistPrepared(scope, body, heldSummary);
    if (persistence !== 'send') {
      if (persistence !== 'stale') {
        setSubmitting(false);
        inFlight.current = false;
      }
      return;
    }

    try {
      const result = await request(`${base}/complete`, { method: 'POST', body: JSON.stringify(body) });
      await clearStored(scope, body.idempotencyKey);
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
    const idempotencyKey = pendingBodyRef.current?.idempotencyKey;
    inFlight.current = true;
    setSubmitting(true);
    try {
      const removed = await clearStored(scope, idempotencyKey);
      if (!sameScope(scopeRef.current, scope)) return;
      if (!removed) {
        const current = await getFastCompletionAttempt(scope.serviceId, scope.operatorId);
        if (!sameScope(scopeRef.current, scope)) return;
        if (!current.available || current.attempt?.body?.idempotencyKey === idempotencyKey) {
          setError('Could not discard the saved completion on this device. Keep it open and try Discard again.');
          return;
        }
      }
      pendingBodyRef.current = null;
      pendingSummaryRef.current = '';
      keyRef.current = genIdempotencyKey();
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
