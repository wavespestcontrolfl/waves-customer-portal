/**
 * <JobDrawer> — slide-in panel that opens when a job pin is clicked
 * on the dispatch map. Display + status-transition actions (Mark
 * en route / Mark on site) + tech reassignment. Reschedule lives in
 * the Schedule tab — not duplicated here.
 *
 * Hydration:
 *   GET /api/admin/dispatch/jobs/:id on open. Cached per id only via
 *   the parent's selectedJobId state — re-opens fetch fresh because
 *   broadcasts may have moved the world while the drawer was closed.
 *   Active-tech list (GET /api/admin/dispatch/technicians) fetched
 *   once on first open and cached across opens.
 *
 *   refetchSignal prop: parent bumps a monotonic counter when an
 *   external action (drag-to-reassign on the map, etc.) changes the
 *   currently-open job. We re-fetch in place — no setJob(null) clear
 *   — so the user sees the assignee update without a "Loading…"
 *   flicker. Initial value 0 is ignored to avoid a redundant fetch
 *   on mount (the jobId-change effect already does the first fetch).
 *
 * Actions:
 *   - PUT /api/admin/dispatch/:id/status with { status: 'en_route' |
 *     'on_site' }. Re-fetches the job into the drawer on success.
 *   - PUT /api/admin/dispatch/jobs/:id/assign with { technicianId }
 *     (nullable). Re-fetches on success. Server auto-resolves any
 *     open unassigned_overdue alert when going null → tech, and
 *     emits dispatch:job_update so other dispatchers' boards refresh.
 *     Reassignment is disabled when the job is in a terminal state
 *     (completed/cancelled/skipped); the server enforces the same
 *     rule with 409.
 *
 * Tier 1 V2 styling: Sheet primitive, Card / Button / Badge / Select
 * from components/ui, zinc ramp.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Sheet,
  SheetHeader,
  SheetBody,
  SheetFooter,
  Button,
  Badge,
  Select,
  cn,
} from '../ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminAuthHeaders() {
  const token = localStorage.getItem('waves_admin_token');
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

const STATUS_TONE = {
  en_route:    'strong',
  on_site:     'strong',
  completed:   'neutral',
  cancelled:   'neutral',
  skipped:     'neutral',
  pending:     'neutral',
  confirmed:   'neutral',
  rescheduled: 'neutral',
};

function Field({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div className="mb-3">
      <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1">
        {label}
      </div>
      <div className="text-14 text-ink-primary">{children}</div>
    </div>
  );
}

function formatWindow(start, end) {
  if (!start && !end) return null;
  const s = (start || '').slice(0, 5);
  const e = (end || '').slice(0, 5);
  if (s && e) return `${s} – ${e}`;
  return s || e;
}

export default function JobDrawer({ jobId, onClose, refetchSignal = 0 }) {
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busyAction, setBusyAction] = useState(null);

  // Active-tech list for the assignment dropdown. Fetched once on
  // mount; same list applies regardless of which job the drawer
  // shows. Cached in state to avoid refetching on every open. Empty
  // on the first render — the dropdown gracefully shows just the
  // current assignment until the list lands.
  const [availableTechs, setAvailableTechs] = useState([]);
  // Pending-but-unsaved assignment selection. null means "Unassigned",
  // a UUID string means a specific tech. We track this separately so
  // the user can change the dropdown and click Save (rather than
  // auto-saving on every change, which is jarring + spawns one PUT
  // per keystroke if the dropdown is keyboard-driven).
  const [pendingTechId, setPendingTechId] = useState(undefined);
  const [savingAssign, setSavingAssign] = useState(false);
  const [assignError, setAssignError] = useState(null);

  // Two refs, two purposes:
  //
  //   currentIdRef — tracks the currently-selected jobId. Used by the
  //   action handler (handleStatus) to decide whether the post-PUT
  //   refetch + error-set should apply: "is the user still on the job
  //   we acted on?" Id comparison is correct here because a same-job
  //   reopen IS desired for refetch.
  //
  //   fetchSeqRef — monotonic per-request token for fetchJob. Each
  //   fetch increments + captures its own seq; only the request whose
  //   seq still matches the ref commits state. Catches both
  //   cross-job (A → B reopen) AND same-job (A → close → A reopen)
  //   races. Codex P2 on PR #315 caught this pattern in the (then-
  //   id-only) TechDrawer; this PR brings JobDrawer to parity.
  //
  // Both are needed: currentIdRef is for the id-question, fetchSeqRef
  // is for the staleness-question. Collapsing them would lose the
  // ability to refetch on same-job reopen.
  const currentIdRef = useRef(null);
  const fetchSeqRef = useRef(0);

  const fetchJob = useCallback(async (id) => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/dispatch/jobs/${id}`, {
        headers: adminAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Newer fetch already in flight (or completed) — drop this one.
      if (fetchSeqRef.current !== seq) return;
      setJob(data);
    } catch (err) {
      if (fetchSeqRef.current !== seq) return;
      setError(err.message || 'Failed to load job');
    } finally {
      // Only clear the loading flag if we're still the latest request
      // — a stale loading=false would briefly flash empty before the
      // newer fetch completes.
      if (fetchSeqRef.current === seq) setLoading(false);
    }
  }, []);

  // Re-fetch on every open or jobId change. A drawer that was open
  // and then re-opened on the same job should still show fresh data
  // — the pin click might've happened minutes after a status change.
  //
  // Bumping fetchSeqRef invalidates any in-flight fetch IMMEDIATELY,
  // even when the new jobId equals the old one (same-job reopen);
  // the next fetchJob call bumps it again to claim the latest seq.
  //
  // Clear `job` AND `error` synchronously on selection change so the
  // drawer doesn't render the previous job's data + action buttons
  // during the new fetch's in-flight window. On slow networks the
  // dispatcher could otherwise click "Mark En Route" while the
  // header still shows the prior customer, and the click would
  // submit the stale job.id (Codex P1 #2 on PR #303). With `job`
  // null, the body falls through to the "Loading job…" branch and
  // the footer (`{job && (canMarkEnRoute || canMarkOnSite) && ...}`)
  // doesn't render at all — no stale buttons exist to click.
  useEffect(() => {
    fetchSeqRef.current += 1;
    currentIdRef.current = jobId;
    setJob(null);
    setError(null);
    setPendingTechId(undefined);
    setAssignError(null);
    if (jobId) fetchJob(jobId);
  }, [jobId, fetchJob]);

  // External refetch trigger (e.g., drag-to-reassign on the map fired
  // for the same job that's currently open in this drawer). The page
  // bumps refetchSignal after a successful PUT; we re-fetch without
  // the synchronous setJob(null) clear that the jobId-change effect
  // does — re-rendering "Loading…" mid-drag would feel janky. The
  // user just sees the assignment update in place when the new
  // payload lands. Codex P2 on PR #327.
  useEffect(() => {
    if (jobId && refetchSignal > 0) {
      fetchJob(jobId);
    }
    // jobId deliberately excluded — re-running on jobId change is
    // covered by the effect above and would cause double-fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetchSignal]);

  // Fetch active techs once on first open. The list rarely changes
  // mid-session, so caching it across opens is fine. The current
  // assignment dropdown gracefully falls back to "(Unassigned)" +
  // the saved tech_full_name if this hasn't loaded yet.
  useEffect(() => {
    if (!jobId || availableTechs.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/dispatch/technicians`, {
          headers: adminAuthHeaders(),
        });
        if (!res.ok) return; // best-effort; dropdown still shows current assignment
        const data = await res.json();
        if (cancelled) return;
        setAvailableTechs(Array.isArray(data.technicians) ? data.technicians : []);
      } catch {
        /* swallow — dropdown degrades gracefully */
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, availableTechs.length]);

  const handleAssign = useCallback(async () => {
    if (!job || pendingTechId === undefined || savingAssign) return;
    if ((pendingTechId || null) === (job.tech_id || null)) {
      // No actual change — clear the pending state without a PUT.
      setPendingTechId(undefined);
      return;
    }
    const targetJobId = job.id;
    setSavingAssign(true);
    setAssignError(null);
    try {
      const res = await fetch(
        `${API_BASE}/admin/dispatch/jobs/${targetJobId}/assign`,
        {
          method: 'PUT',
          headers: adminAuthHeaders(),
          body: JSON.stringify({ technicianId: pendingTechId || null }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      // Refetch into the drawer if still on the same job — same
      // pattern as handleStatus. The dispatch:job_update broadcast
      // will refresh other dispatchers' boards.
      if (currentIdRef.current === targetJobId) {
        setPendingTechId(undefined);
        await fetchJob(targetJobId);
      }
    } catch (err) {
      if (currentIdRef.current === targetJobId) {
        setAssignError(err.message || 'Assignment failed');
      }
    } finally {
      setSavingAssign(false);
    }
  }, [job, pendingTechId, savingAssign, fetchJob]);

  const handleStatus = useCallback(
    async (nextStatus) => {
      if (!job || busyAction) return;
      setBusyAction(nextStatus);
      // Capture the job.id at action time so a concurrent selection
      // change doesn't redirect the PUT to a different service. The
      // PUT is intentionally NOT aborted on selection change — the
      // user has already acted; the action commits server-side. We
      // just don't apply the response into a drawer that's now
      // showing a different job.
      const targetJobId = job.id;
      try {
        const res = await fetch(
          `${API_BASE}/admin/dispatch/${targetJobId}/status`,
          {
            method: 'PUT',
            headers: adminAuthHeaders(),
            body: JSON.stringify({ status: nextStatus }),
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Only refetch into the drawer if the user is still on the
        // same job. Otherwise the dispatch:job_update broadcast will
        // refresh the relevant pin/card without our help.
        if (currentIdRef.current === targetJobId) {
          await fetchJob(targetJobId);
        }
      } catch (err) {
        if (currentIdRef.current === targetJobId) {
          setError(err.message || 'Status update failed');
        }
      } finally {
        setBusyAction(null);
      }
    },
    [job, busyAction, fetchJob]
  );

  const open = !!jobId;

  // Status-action gating. We only surface transitions that make sense
  // from the current state — admin-schedule.js still has the legacy
  // CHECK constraint enum, so showing impossible buttons would just
  // 500. Mirrors the rules in admin-dispatch.js status handler.
  const canMarkEnRoute = job && ['pending', 'confirmed', 'rescheduled'].includes(job.status);
  const canMarkOnSite  = job && job.status === 'en_route';

  return (
    <Sheet open={open} onClose={onClose} width="md">
      <SheetHeader>
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-18 font-medium text-ink-primary truncate">
            {job ? `${job.customer_first_name} ${job.customer_last_name}` : 'Job'}
          </h2>
          {job && (
            <Badge tone={STATUS_TONE[job.status] || 'neutral'}>
              {job.status}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          Close
        </Button>
      </SheetHeader>

      <SheetBody>
        {loading && !job && (
          <div className="text-14 text-ink-tertiary">Loading job…</div>
        )}
        {error && (
          <div className="text-14 text-alert-fg mb-3">{error}</div>
        )}
        {job && (
          <>
            <Field label="Service">{job.service_type || '—'}</Field>
            <Field label="Address">
              {/* Open-in-maps link uses the geocoded coords if present,
                  falls back to the address string. */}
              <a
                href={
                  job.lat != null && job.lng != null
                    ? `https://www.google.com/maps/search/?api=1&query=${job.lat},${job.lng}`
                    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.address)}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="text-waves-blue hover:underline"
              >
                {job.address}
              </a>
            </Field>
            <Field label="Window">
              {formatWindow(job.window_start, job.window_end) || 'Anytime'}
            </Field>
            <div className="mb-3">
              <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-1">
                Tech
              </div>
              {/* Reassign-disabled when the job is in a terminal
                  state. Server enforces the same rule (409); this
                  is just to keep the affordance honest. */}
              {['completed', 'cancelled', 'skipped'].includes(job.status) ? (
                <div className="text-14 text-ink-primary">
                  {job.tech_full_name || (
                    <span className="text-ink-tertiary italic">Unassigned</span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Select
                    size="sm"
                    className="flex-1"
                    value={
                      pendingTechId === undefined
                        ? (job.tech_id || '')
                        : (pendingTechId || '')
                    }
                    onChange={(e) => setPendingTechId(e.target.value || null)}
                    disabled={savingAssign}
                  >
                    <option value="">Unassigned</option>
                    {/* Make sure the currently-assigned tech is in
                        the list even if availableTechs hasn't
                        loaded yet, or the tech is now inactive. */}
                    {job.tech_id &&
                      !availableTechs.some((t) => t.id === job.tech_id) && (
                        <option value={job.tech_id}>
                          {job.tech_full_name || job.tech_id}
                        </option>
                      )}
                    {availableTechs.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleAssign}
                    disabled={
                      savingAssign ||
                      pendingTechId === undefined ||
                      (pendingTechId || null) === (job.tech_id || null)
                    }
                  >
                    {savingAssign ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              )}
              {assignError && (
                <div className="text-12 text-alert-fg mt-1">{assignError}</div>
              )}
            </div>
            <Field label="Customer Phone">
              {job.customer_phone ? (
                <a
                  href={`tel:${job.customer_phone}`}
                  className="text-waves-blue hover:underline"
                >
                  {job.customer_phone}
                </a>
              ) : null}
            </Field>
            <Field label="Notes (customer-facing)">{job.notes}</Field>
            <Field label="Internal Notes">{job.internal_notes}</Field>
          </>
        )}
      </SheetBody>

      {job && (canMarkEnRoute || canMarkOnSite) && (
        <SheetFooter>
          {canMarkEnRoute && (
            <Button
              variant="primary"
              onClick={() => handleStatus('en_route')}
              disabled={!!busyAction}
            >
              {busyAction === 'en_route' ? 'Marking…' : 'Mark En Route'}
            </Button>
          )}
          {canMarkOnSite && (
            <Button
              variant="primary"
              onClick={() => handleStatus('on_site')}
              disabled={!!busyAction}
            >
              {busyAction === 'on_site' ? 'Marking…' : 'Mark On Site'}
            </Button>
          )}
        </SheetFooter>
      )}
    </Sheet>
  );
}
