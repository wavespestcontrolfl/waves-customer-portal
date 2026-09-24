/**
 * <TechOutSection> — "Tech out today" panel inside <TechDrawer>, under the
 * stats cards. Lets a dispatcher mark the open tech out for today (sick /
 * emergency / no-show / other) with a one-step inline confirm, then shows
 * the redistribution summary the server computed (moved / parked / failed)
 * once out, with a "Tech is back" clear.
 *
 * Feature-gated server-side (GATE_TECH_OUT_REDISTRIBUTE): a 404 means the
 * gate is off, and this section renders nothing — same contract as a
 * disabled Intelligence Bar surface.
 *
 * Race-safety: same fetchSeq pattern as TechDrawer's own fetchTech — a
 * per-request sequence token so a stale fetch (tech switched, or the same
 * tech reselected before the first fetch resolved) can't clobber state.
 * The POST (mark out) and DELETE (tech is back) mutations capture the
 * seq + techId before firing and re-check both before applying their
 * response — a late-resolving redistribution for tech A can't paint
 * over tech B's drawer if the dispatcher switched selection mid-flight
 * (Codex P1 on PR #4678).
 *
 * Tier 1 V2 styling: Card / Badge / Button / Select / Textarea primitives,
 * zinc ramp, fontWeight 400/500, 14px text minimum.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Select, Textarea } from '../ui';
import { etDateString } from '../../lib/timezone';
import { TECH_ABSENCE_EVENT } from '../../hooks/useDispatchBoard';
import { TECH_OUT_ALERTS_EVENT } from '../../hooks/useDispatchAlerts';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminAuthHeaders() {
  const token = localStorage.getItem('waves_admin_token');
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

const REASONS = [
  { value: 'sick', label: 'Sick' },
  { value: 'emergency', label: 'Emergency' },
  { value: 'no_show', label: 'No-show' },
  { value: 'other', label: 'Other' },
];

const REASON_LABELS = REASONS.reduce((acc, r) => {
  acc[r.value] = r.label;
  return acc;
}, {});

function postErrorMessage(errCode) {
  if (errCode === 'past_date') return "Can't mark a past date";
  if (errCode === 'already_out') return 'Already marked out';
  return null;
}

export default function TechOutSection({ techId, techName, onChanged }) {
  // 'loading' | 'off' | 'ready'
  const [phase, setPhase] = useState('loading');
  const [absence, setAbsence] = useState(null);
  // GATE_TECH_OUT_AUTO_MOVE, read off every status GET (see fetchStatus) —
  // shows/hides the "Auto-assign parked stops" action without a second
  // round trip.
  const [autoMoveEnabled, setAutoMoveEnabled] = useState(false);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [autoAssignError, setAutoAssignError] = useState(null);
  const [autoAssignResult, setAutoAssignResult] = useState(null);

  const [reason, setReason] = useState('sick');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [clearing, setClearing] = useState(false);

  const fetchSeqRef = useRef(0);
  // Count-only refreshes (onTechOutAlertsChange) — see fetchStatus.
  const countSeqRef = useRef(0);
  // Mirrors the techId prop on every render so an already-in-flight async
  // handler (whose own `techId` closure is frozen at the value from the
  // render it started in) can still tell the selection moved on. Needed
  // alongside fetchSeqRef: the seq only advances once the selection-change
  // effect actually runs, which is soon but not synchronous with the prop
  // change itself.
  const techIdRef = useRef(techId);
  techIdRef.current = techId;
  // Board invalidation is independent of drawer state: a mutation that the
  // server committed refreshes the roster (out_today, drop targets) even if
  // this drawer moved to another tech or closed before the response landed.
  // Only the drawer's own state updates are discarded when stale.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  // Unmount invalidates every in-flight request (drawer closed mid-mutation,
  // then reopened on another tech): a late response finds the seq advanced
  // and no current tech, so it neither renders nor calls onChanged.
  useEffect(() => () => {
    fetchSeqRef.current += 1;
    techIdRef.current = null;
  }, []);

  const fetchStatus = useCallback(async (id) => {
    const seq = ++fetchSeqRef.current;
    // Any full status read (tech switch, reopen, mutation) supersedes an
    // in-flight count-only read, so a slow count for an earlier selection
    // can never overwrite the fresher count this read brings.
    countSeqRef.current += 1;
    try {
      const date = etDateString();
      const res = await fetch(`${API_BASE}/admin/tech-out/${id}?date=${date}`, {
        headers: adminAuthHeaders(),
      });
      if (res.status === 404) {
        if (fetchSeqRef.current !== seq) return;
        setPhase('off');
        setAbsence(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (fetchSeqRef.current !== seq) return;
      if (!data.enabled) {
        setPhase('off');
        setAbsence(null);
        return;
      }
      setAbsence(data.absence || null);
      setAutoMoveEnabled(!!data.auto_move_enabled);
      setPhase('ready');
    } catch {
      // No error UI is specified for the status GET itself — treat a
      // failed read the same as "feature not usable right now".
      if (fetchSeqRef.current !== seq) return;
      setPhase('off');
      setAbsence(null);
    }
  }, []);

  useEffect(() => {
    // Bump the seq synchronously on every selection change so an in-flight
    // fetch from the previous tech (or a previous fetch for this same tech)
    // can't apply state — same two race patterns TechDrawer guards against.
    fetchSeqRef.current += 1;
    setPhase('loading');
    setAbsence(null);
    setAutoMoveEnabled(false);
    setAutoAssigning(false);
    setAutoAssignError(null);
    setAutoAssignResult(null);
    setConfirming(false);
    setSubmitError(null);
    setSubmitting(false);
    setNote('');
    setReason('sick');
    if (techId) fetchStatus(techId);
  }, [techId, fetchStatus]);

  // Another tab marked or cleared THIS technician: useDispatchBoard relays
  // the dispatch:tech_absence broadcast as a window event (it refreshes the
  // roster itself); the open drawer re-reads status so it never keeps
  // offering "Mark out today" after a remote mark, or the old absence after
  // a remote clear (Codex r8 P2 on #4678).
  useEffect(() => {
    function onRemoteAbsenceChange(event) {
      const changedTechId = event?.detail?.tech_id;
      if (!changedTechId || changedTechId !== techIdRef.current) return;
      fetchStatus(changedTechId);
    }
    window.addEventListener(TECH_ABSENCE_EVENT, onRemoteAbsenceChange);
    return () => window.removeEventListener(TECH_ABSENCE_EVENT, onRemoteAbsenceChange);
  }, [fetchStatus]);

  // An overflow card for THIS technician appeared, changed or resolved
  // (another dispatcher moved or dismissed it): refresh ONLY the live parked
  // count. Deliberately not fetchStatus — that advances fetchSeqRef, which
  // the mark-out / clear / auto-assign handlers read as "superseded", and
  // those very actions broadcast cards mid-request. Merged only into the
  // same absence, under its own sequence, so a late read never regresses.
  useEffect(() => {
    async function onTechOutAlertsChange(event) {
      const changedTechId = event?.detail?.tech_id;
      if (!changedTechId || changedTechId !== techIdRef.current) return;
      const seq = ++countSeqRef.current;
      try {
        const res = await fetch(`${API_BASE}/admin/tech-out/${changedTechId}?date=${etDateString()}`, {
          headers: adminAuthHeaders(),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (countSeqRef.current !== seq || techIdRef.current !== changedTechId) return;
        const fresh = data?.absence;
        if (!fresh || fresh.parked_open_count == null) return;
        setAbsence((prev) => (prev && prev.id === fresh.id
          ? { ...prev, parked_open_count: fresh.parked_open_count }
          : prev));
      } catch {
        /* best-effort; the next status read catches up */
      }
    }
    window.addEventListener(TECH_OUT_ALERTS_EVENT, onTechOutAlertsChange);
    return () => window.removeEventListener(TECH_OUT_ALERTS_EVENT, onTechOutAlertsChange);
  }, []);

  async function handleConfirmMarkOut() {
    if (submitting) return;
    // Capture the guard pair before the request goes out — see the
    // header comment. A response that comes back after the dispatcher
    // has switched to a different tech (or this same tech re-fetched)
    // must be discarded, never applied to whatever's on screen now.
    // Checked once, right after the request settles: nothing below this
    // component re-bumps fetchSeqRef, so a single check is sufficient
    // (unlike handleTechIsBack, which calls fetchStatus internally).
    const seq = fetchSeqRef.current;
    const requestTechId = techId;
    setSubmitting(true);
    setSubmitError(null);
    let discarded = false;
    try {
      const res = await fetch(`${API_BASE}/admin/tech-out/${requestTechId}`, {
        method: 'POST',
        headers: adminAuthHeaders(),
        body: JSON.stringify({ reason, note: note || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onChangedRef.current?.(requestTechId);
      if (fetchSeqRef.current !== seq || techIdRef.current !== requestTechId) {
        discarded = true;
        return;
      }
      if (res.status === 404) {
        // The gate closed between this drawer's status GET and the
        // confirm: the server answers its documented 404 {enabled:false}.
        // Same transition the GET takes — hide the controls (Codex r7 P2).
        setPhase('off');
        setAbsence(null);
        return;
      }
      if (res.status === 409 || res.status === 400) {
        setSubmitError(postErrorMessage(data.error) || data.error || 'Failed to mark out');
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // The POST response shape is { absence, summary } (siblings), unlike
      // the GET status shape which nests summary as absence.redistribution
      // — normalize so the "out" view below has one shape to read. Success
      // covers both a fresh mark-out (201) and the resume case (200,
      // { ..., resumed: true }) — both are `res.ok` and carry the same
      // { absence, summary } shape.
      setAbsence({ ...data.absence, redistribution: data.absence?.redistribution || data.summary });
      setConfirming(false);
      setNote('');
    } catch (err) {
      if (fetchSeqRef.current !== seq || techIdRef.current !== requestTechId) {
        discarded = true;
        return;
      }
      setSubmitError(err.message || 'Failed to mark out');
    } finally {
      // A discarded response still resets the loading flag when THIS tech
      // is still on screen: a remote absence refetch (TECH_ABSENCE_EVENT)
      // can supersede an in-flight mutation without the selection moving,
      // and the refetched status is what the section now shows (pre-push
      // auditor P1 on #4678). Only a selection change / unmount leaves it.
      if (!discarded || techIdRef.current === requestTechId) setSubmitting(false);
    }
  }

  async function handleTechIsBack() {
    if (clearing) return;
    const seq = fetchSeqRef.current;
    const requestTechId = techId;
    setClearing(true);
    setSubmitError(null);
    // `discarded` (not a live re-check of fetchSeqRef) drives the finally
    // block: fetchStatus() below bumps fetchSeqRef itself on success, so
    // re-comparing against the captured `seq` afterwards would misfire on
    // the ordinary, non-stale path and leave `clearing` stuck true.
    let discarded = false;
    try {
      const date = etDateString();
      const res = await fetch(`${API_BASE}/admin/tech-out/${requestTechId}?date=${date}`, {
        method: 'DELETE',
        headers: adminAuthHeaders(),
      });
      if (res.ok) onChangedRef.current?.(requestTechId);
      if (fetchSeqRef.current !== seq || techIdRef.current !== requestTechId) {
        discarded = true;
        return;
      }
      if (res.status === 404) {
        const data = await res.json().catch(() => ({}));
        if (data.error === 'not_out') {
          // Another dispatcher already cleared this absence (route answers
          // 404 not_out, gate still on): re-read status so the section
          // returns to the plain Availability form — never `off` (Codex r8
          // P2 on #4678).
          await fetchStatus(requestTechId);
          return;
        }
        // Gate closed mid-drawer — see handleConfirmMarkOut.
        setPhase('off');
        setAbsence(null);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchStatus(requestTechId);
    } catch (err) {
      if (discarded) return;
      setSubmitError(err.message || 'Failed to clear absence');
    } finally {
      if (!discarded || techIdRef.current === requestTechId) setClearing(false); // same rule as setSubmitting above
    }
  }

  // GATE_TECH_OUT_AUTO_MOVE (PR B): try the canonical mover on every open
  // overflow alert for this tech-day. Same discard-guard shape as the
  // mark-out / tech-is-back handlers above — a response landing after the
  // dispatcher switched tech (or this drawer unmounted) is dropped.
  async function handleAutoAssign() {
    if (autoAssigning) return;
    const seq = fetchSeqRef.current;
    const requestTechId = techId;
    setAutoAssigning(true);
    setAutoAssignError(null);
    setAutoAssignResult(null);
    let discarded = false;
    try {
      const date = etDateString();
      const res = await fetch(`${API_BASE}/admin/tech-out/${requestTechId}/auto-assign`, {
        method: 'POST',
        headers: adminAuthHeaders(),
        body: JSON.stringify({ date }),
      });
      const data = await res.json().catch(() => ({}));
      // The move (if any) already committed server-side — refresh the board
      // (job pins, tech current-job) unconditionally on success, same as the
      // mark-out/clear handlers.
      if (res.ok) onChangedRef.current?.(requestTechId);
      if (fetchSeqRef.current !== seq || techIdRef.current !== requestTechId) {
        discarded = true;
        return;
      }
      if (res.status === 404) {
        // Either gate closed mid-drawer, matching handleConfirmMarkOut.
        if (data.enabled === false) {
          setPhase('off');
          setAbsence(null);
        } else {
          setAutoMoveEnabled(false);
        }
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const moved = Array.isArray(data.moved) ? data.moved.length : 0;
      setAutoAssignResult({ moved });
      // Re-read status so the parked count (parked_open_count) and any
      // resolved cards reflect what the batch just did.
      await fetchStatus(requestTechId);
    } catch (err) {
      if (discarded) return;
      setAutoAssignError(err.message || 'Auto-assign failed');
    } finally {
      if (!discarded || techIdRef.current === requestTechId) setAutoAssigning(false);
    }
  }

  if (phase !== 'ready') return null;

  if (absence) {
    const redistribution = absence.redistribution || {};
    // Park-only foundation (Codex r4 + r5 on PR #4678): a mark-out parks
    // EVERY open stop as a "Needs a decision" alert; PR B (GATE_TECH_OUT_
    // AUTO_MOVE) adds the "Auto-assign parked stops" action below, still
    // opt-in per tech-day — nothing moves without the dispatcher asking.
    // parked_open_count (Codex r8 P2 on #4678) is a LIVE read of open
    // overflow alerts as of the last status fetch — not the frozen
    // mark-out snapshot, which never reflected a card resolved by hand or
    // by a prior auto-assign run. Falls back to the snapshot's own count
    // only for a stale/cached response shape that predates that field.
    const parkedCount = absence.parked_open_count != null
      ? absence.parked_open_count
      : (redistribution.parked || []).length;
    return (
      <Card className="p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <Badge tone="warn">
            Out today · {REASON_LABELS[absence.reason] || absence.reason}
          </Badge>
        </div>
        <div className="text-14 text-ink-primary mb-3">
          {parkedCount} stop{parkedCount === 1 ? '' : 's'} parked in the Action Queue — decide who to move
        </div>
        <div className="text-14 text-ink-tertiary mb-3">
          Parked stops are in the Action Queue as &quot;Needs a decision&quot;.
        </div>
        {autoMoveEnabled && parkedCount > 0 && (
          <div className="mb-3">
            <Button variant="secondary" onClick={handleAutoAssign} disabled={autoAssigning}>
              {autoAssigning ? 'Assigning…' : 'Auto-assign parked stops'}
            </Button>
            {autoAssignResult && (
              <div className="text-14 text-ink-tertiary mt-1">
                {/* Moved only: the live parked count above is the authoritative
                    remainder — it counts every stop of a grouped visit, which a
                    per-card tally here would undercount (Codex r4 P2). */}
                Moved {autoAssignResult.moved} {autoAssignResult.moved === 1 ? 'stop' : 'stops'} automatically.
              </div>
            )}
            {autoAssignError && <div className="text-14 text-alert-fg mt-1">{autoAssignError}</div>}
          </div>
        )}
        {submitError && <div className="text-14 text-alert-fg mb-3">{submitError}</div>}
        <Button variant="secondary" onClick={handleTechIsBack} disabled={clearing}>
          {clearing ? 'Clearing…' : 'Tech is back'}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-4 mb-4">
      <div className="text-14 font-medium text-ink-primary mb-3">Availability</div>
      {!confirming ? (
        <>
          <div className="mb-3">
            <label className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1 block">
              Reason
            </label>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </Select>
          </div>
          <div className="mb-3">
            <label className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1 block">
              Note (optional)
            </label>
            <Textarea
              rows={2}
              value={note}
              maxLength={300}
              placeholder="Optional note"
              onChange={(e) => setNote(e.target.value.slice(0, 300))}
            />
          </div>
          {submitError && <div className="text-14 text-alert-fg mb-3">{submitError}</div>}
          <Button
            variant="primary"
            onClick={() => {
              setSubmitError(null);
              setConfirming(true);
            }}
          >
            Mark out today
          </Button>
        </>
      ) : (
        <div>
          <div className="text-14 text-ink-primary mb-3">
            Mark {techName} out and park today&apos;s stops for a decision?
          </div>
          {submitError && <div className="text-14 text-alert-fg mb-3">{submitError}</div>}
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={handleConfirmMarkOut} disabled={submitting}>
              {submitting ? 'Redistributing…' : 'Confirm'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
                setSubmitError(null);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
