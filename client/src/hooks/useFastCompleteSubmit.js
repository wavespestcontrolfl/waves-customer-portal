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
//  confirm     — a heads-up the tech may send through (the report-flow
//                sheet's edited-report check, a promise that changed after
//                the report was written): the SAME body and key go again with
//                the server's confirmation flag, as on the full form. Going
//                back instead makes the next completion a new request, under
//                a new key: an earlier attempt under the old key may be on
//                record, and the server refuses a changed body under it.
//
// A prepared request is written to IndexedDB before it can reach the server,
// then kept under the same operator, visit and idempotency key until the
// server gives a definite answer. Reopening the sheet offers that exact
// request as an explicit retry; it never submits during hydration. A caller
// opts in by passing both serviceId and operatorId; without them the hook
// keeps the in-memory submit above.
import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldResetCompletionIdempotencyKey } from '../lib/completion-idempotency';
import {
  deleteFastCompletionAttempt,
  getFastCompletionAttempt,
  hasFastCompletionMarker,
  putFastCompletionAttempt,
} from '../lib/completion-resume-store';

const SAVED_CODES = new Set(['service_already_completed', 'completion_resume_payload_mismatch']);
const IN_PROGRESS_CODES = new Set(['service_completion_pending', 'completion_pending', 'completion_side_effects_running']);
const DEFINITIVE_OUTCOMES = new Set(['saved', 'correctable', 'terminal']);
// The confirmable 409s and the body flag that sends each one through.
const CONFIRM_FLAGS = { report_rules_review: 'reportRulesConfirmed', promise_marks_changed: 'promiseMarksConfirmed' };
// A saved completion whose stored copy this device could not clear (the
// delete and its retry both left it) says so: a later scan may offer it, and
// its Retry resends the same key, so it only confirms this save.
const SAVED_COPY_NOTICE = 'This device could not clear its saved copy. If this visit offers it again, Retry only confirms this save.';
const savedNotice = (cleared) => (cleared ? {} : { notice: SAVED_COPY_NOTICE });
// A request refused for good whose stored copy this device could not clear:
// the saved-attempt view stays up with Discard, never a retry.
const KEPT_COPY_NOTICE = 'This device could not clear its saved copy of this completion. Discard it here.';
// A saved copy the server had refused, found again after a reload.
const REFUSED_COPY_NOTICE = 'The server refused this saved completion. Discard it here to start a new one.';
// A saved attempt this device marks but cannot read now: nothing new may be
// sent over it, so the sheet waits for a read (GitHub Codex P2 on #6001).
const UNREADABLE_COPY_NOTICE = 'A completion is saved on this device but can’t be read right now. Tap Try again.';
const STORAGE_WARNING = 'This device can’t save a reload-safe copy right now. Keep this screen open. You can still send after this warning.';

// A lapsed login, a timeout or a rate limit leaves the outcome open. A 403
// that names its reason (service_not_assigned after a reassignment, an
// admin-only override) is the server's definite refusal (GitHub Codex P2 on
// #5967).
function leavesOutcomeOpen(status, code) {
  return [401, 408, 425, 429].includes(status) || (status === 403 && !code);
}

// Only a sheet that renders the prompt (`confirmable`, the report flow) gets
// the confirm outcome; every other consumer keeps showing the server's
// message, exactly as before it existed (codex local r19 on #5538).
export function completionFailureOutcome(err, { confirmable = false } = {}) {
  const status = Number(err?.status);
  if (status === 409 && SAVED_CODES.has(err?.code)) return 'saved';
  if (confirmable && status === 409 && CONFIRM_FLAGS[err?.code]) return 'confirm';
  if (leavesOutcomeOpen(status, err?.code)) return 'retry';
  if (shouldResetCompletionIdempotencyKey(err)) return 'correctable';
  if (!Number.isFinite(status) || status >= 500 || (status === 409 && IN_PROGRESS_CODES.has(err?.code))) return 'retry';
  return 'terminal';
}

export function outcomeMessage(outcome, err) {
  if (outcome === 'retry') {
    return `${err?.message || 'Completion failed'} We couldn't confirm it saved. Tap Retry to send the same completion again.`;
  }
  if (err?.code === 'idempotency_key_mismatch') {
    return 'Another completion for this visit is in progress or was changed. Close and reopen it from the schedule to see where it stands.';
  }
  return err?.message || 'Completion failed';
}

export function genIdempotencyKey() {
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
  base, request, serviceId, operatorId, confirmable = false, sheet = '', invoiceFields = null,
}) {
  // The visit's invoice fields (lib/completion-invoice-fields.js), the same
  // ones the full form posts. Read when a NEW body is built; a held, retried
  // or restored body keeps the fields it was prepared with.
  const invoiceFieldsRef = useRef(invoiceFields);
  invoiceFieldsRef.current = invoiceFields;
  const keyRef = useRef(genIdempotencyKey());
  const pendingBodyRef = useRef(null);
  const pendingSummaryRef = useRef('');
  const rejectedBodyRef = useRef(null);
  const persistedBodyRef = useRef(null);
  const inFlight = useRef(false);
  const scopeRef = useRef(scopeOf(serviceId, operatorId, 0));
  const storageWarningSeenRef = useRef(false);
  // The held body is a refused copy found on reload: discarding it opens a
  // fresh form, since the refusal it answered is no longer on screen.
  const reloadedRefusalRef = useRef(false);
  const [recovering, setRecovering] = useState(true);
  const [restored, setRestored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [storageWarning, setStorageWarning] = useState('');
  // Bumped by Try again on an unreadable saved attempt: the read runs again.
  const [readTick, setReadTick] = useState(0);

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
    reloadedRefusalRef.current = false;
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
        if (hasFastCompletionMarker(scope.serviceId, scope.operatorId)) {
          setRestored(true);
          setFailure('unreadable');
          setError(UNREADABLE_COPY_NOTICE);
        }
      }
      if (attempt?.body && typeof attempt.body.idempotencyKey === 'string' && attempt.body.idempotencyKey) {
        pendingBodyRef.current = attempt.body;
        pendingSummaryRef.current = attempt.summary || '';
        keyRef.current = attempt.body.idempotencyKey;
        persistedBodyRef.current = attempt.body;
        setRestored(true);
        if (attempt.refused === true) {
          // Refused for good before the reload: Discard only, never Retry
          // (GitHub Codex P2 on #5967).
          reloadedRefusalRef.current = true;
          setFailure('terminal');
          setError(REFUSED_COPY_NOTICE);
        } else {
          setFailure('retry');
          setError('An unfinished completion is saved on this device. Tap Retry when you’re ready to send the same completion again.');
        }
      }
      setRecovering(false);
    });
    return () => { active = false; };
  }, [serviceId, operatorId, readTick]);

  // Removes exactly the row a send or discard stood on, captured before its
  // network call or storage read: never whatever row is current when a late
  // response arrives (a tech who left and reopened the visit may have saved a
  // newer attempt by then; handoff P1 on 463069ad05).
  const clearStored = useCallback(async (scope, storedBody) => {
    if (scope.serviceId && scope.operatorId && storedBody) {
      return deleteFastCompletionAttempt(scope.serviceId, scope.operatorId, storedBody);
    }
    return true;
  }, []);

  // After a settled send (saved, or refused for good): removes the exact row
  // the send stood on. A delete that removed nothing is re-read: another tab
  // may have removed the row, or saved a newer revision, which stays. While
  // this exact body is still there (or storage cannot be read), the delete
  // runs once more; false means the row still stands, which the caller
  // reports, so a later scan offering it is explained (GitHub Codex P2s on
  // 0fdeda8a25 and 102b99cb1b).
  const clearSettled = useCallback(async (scope, storedBody) => {
    const stillStored = async () => {
      const current = await getFastCompletionAttempt(scope.serviceId, scope.operatorId);
      return !current.available || JSON.stringify(current.attempt?.body) === JSON.stringify(storedBody);
    };
    if (await clearStored(scope, storedBody)) return true;
    if (!(await stillStored())) return true;
    if (await clearStored(scope, storedBody)) return true;
    return !(await stillStored());
  }, [clearStored]);

  // A refused request whose copy would not delete is marked refused in place
  // (best effort: storage that refused the delete may refuse this too), so a
  // reload offers it to discard, never as an uncertain retry (GitHub Codex P2
  // on #5967).
  const markRefused = useCallback(async (scope, storedBody, summary) => {
    if (!scope.serviceId || !scope.operatorId || !storedBody) return;
    await putFastCompletionAttempt(scope.serviceId, scope.operatorId, {
      body: storedBody, summary, expectedBody: storedBody, refused: true, sheet,
    });
  }, [sheet]);

  // A definitive answer removes the send's stored copy; a refused copy that
  // stays is marked refused. True when no copy of that answer remains.
  const settleCopy = useCallback(async (outcome, scope, storedBody, summary) => {
    if (!DEFINITIVE_OUTCOMES.has(outcome)) return true;
    const removed = await clearSettled(scope, storedBody);
    if (!removed && outcome !== 'saved') await markRefused(scope, storedBody, summary);
    return removed;
  }, [clearSettled, markRefused]);

  const persistPrepared = useCallback(async (scope, body, summary) => {
    if (!scope.serviceId || !scope.operatorId) return 'send';
    const stored = await putFastCompletionAttempt(
      scope.serviceId,
      scope.operatorId,
      { body, summary, expectedBody: persistedBodyRef.current, sheet },
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
    const unchanged = observedBody && persistedBodyRef.current
      && JSON.stringify(observedBody) === JSON.stringify(persistedBodyRef.current);
    if (observed.available && !unchanged && (observedBody || persistedBodyRef.current)) {
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
  }, [failure, sheet]);

  const settleFailure = useCallback(async (err, scope, body, summary, storedBody) => {
    const outcome = completionFailureOutcome(err, { confirmable });
    const removed = await settleCopy(outcome, scope, storedBody, summary);
    if (!sameScope(scopeRef.current, scope)) return;
    if (outcome === 'correctable' && !removed && persistedBodyRef.current) {
      rejectedBodyRef.current = persistedBodyRef.current;
    }
    // A request refused for good whose saved copy still stands stays in hand:
    // the saved-attempt view says so and offers Discard, so a later scan never
    // offers it as a retry (GitHub Codex P2 on 102b99cb1b).
    const keptTerminal = outcome === 'terminal' && !removed;
    pendingBodyRef.current = outcome === 'retry' || outcome === 'confirm' || keptTerminal ? body : null;
    pendingSummaryRef.current = pendingBodyRef.current ? summary : '';
    if (keptTerminal) {
      setRestored(true);
      setStorageWarning(KEPT_COPY_NOTICE);
    } else if (outcome === 'terminal') {
      // Its copy is gone: the saved-attempt view would say one is still here
      // (GitHub Codex P2 on b1ebfd50ce).
      setRestored(false);
    }
    if (outcome === 'correctable') {
      if (removed) persistedBodyRef.current = null;
      keyRef.current = genIdempotencyKey();
      setRestored(false);
    }
    if (outcome === 'saved') {
      setFailure(null);
      setDone({ summary: 'This visit was already saved. The office will finish anything still pending.', ...savedNotice(removed) });
      return;
    }
    if (outcome === 'confirm') {
      setFailure(null);
      setPrompt({ code: err.code, message: err?.message || '' });
      return;
    }
    setFailure(outcome === 'correctable' ? null : outcome);
    setError(outcomeMessage(outcome, err));
  }, [settleCopy, confirmable]);

  const submit = useCallback(async (buildBody, summary) => {
    if (inFlight.current || recovering) return;
    const scope = scopeRef.current;
    const held = pendingBodyRef.current;
    const body = held || { idempotencyKey: keyRef.current, ...buildBody(), ...(invoiceFieldsRef.current || {}) };
    const heldSummary = held ? pendingSummaryRef.current : String(summary || '');
    pendingBodyRef.current = body;
    pendingSummaryRef.current = heldSummary;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    setPrompt(null);
    // The row this send stands on (none when nothing was persisted): fixed
    // again once its body is persisted.
    let storedBody = persistedBodyRef.current;

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
      storedBody = persistedBodyRef.current;
      const result = await request(`${base}/complete`, { method: 'POST', body: JSON.stringify(body) });
      const cleared = await clearSettled(scope, storedBody);
      if (!sameScope(scopeRef.current, scope)) return;
      pendingBodyRef.current = null;
      pendingSummaryRef.current = '';
      setFailure(null);
      // customerText: what the server says it sent the customer (the pest
      // sheet's fixed re-service text), shown on the saved view.
      setDone({ summary: heldSummary, customerText: result?.customerText || null, response: result || null, ...savedNotice(cleared) });
    } catch (err) {
      await settleFailure(err, scope, body, heldSummary, storedBody);
    } finally {
      if (sameScope(scopeRef.current, scope)) {
        setSubmitting(false);
        inFlight.current = false;
      }
    }
  }, [base, request, recovering, clearStored, clearSettled, persistPrepared, settleFailure]);

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
    const storedBody = persistedBodyRef.current || body;
    // A request refused for good stays refused: discarding its saved copy
    // keeps the sheet's answer and its lock.
    const refused = failure === 'terminal' && !reloadedRefusalRef.current;
    inFlight.current = true;
    setSubmitting(true);
    try {
      const removed = await clearStored(scope, storedBody);
      if (!sameScope(scopeRef.current, scope)) return;
      if (!removed && persistedBodyRef.current) {
        const current = await getFastCompletionAttempt(scope.serviceId, scope.operatorId);
        if (!sameScope(scopeRef.current, scope)) return;
        if (!current.available || JSON.stringify(current.attempt?.body) === JSON.stringify(storedBody)) {
          setError('Could not discard the saved completion on this device. Keep it open and try Discard again.');
          return;
        }
      }
      pendingBodyRef.current = null;
      pendingSummaryRef.current = '';
      keyRef.current = genIdempotencyKey();
      persistedBodyRef.current = null;
      reloadedRefusalRef.current = false;
      setRestored(false);
      setStorageWarning((warning) => (warning === KEPT_COPY_NOTICE ? '' : warning));
      if (!refused) {
        setFailure(null);
        setError('');
      }
      setPrompt(null);
    } finally {
      if (sameScope(scopeRef.current, scope)) {
        inFlight.current = false;
        setSubmitting(false);
      }
    }
  }, [clearStored, failure]);

  return {
    recovering, restored, submitting, error, failure, done, prompt, storageWarning,
    submit, retry, confirm, discard, dismissPrompt: discard,
    recheck: () => setReadTick((tick) => tick + 1),
    pendingSummary: pendingSummaryRef.current,
    retryPending: failure === 'retry' || failure === 'storage',
    storageBypassPending: failure === 'storage',
    hasPendingBody: () => !!pendingBodyRef.current,
  };
}
