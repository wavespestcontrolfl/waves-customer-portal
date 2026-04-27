/**
 * <JobDrawer> — slide-in panel that opens when a job pin is clicked
 * on the dispatch map. Display + two status-transition actions (Mark
 * en route / Mark on site). Reschedule lives in the Schedule tab —
 * not duplicated here.
 *
 * Hydration:
 *   GET /api/admin/dispatch/jobs/:id on open. Cached per id only via
 *   the parent's selectedJobId state — re-opens fetch fresh because
 *   broadcasts may have moved the world while the drawer was closed.
 *
 * Actions:
 *   PUT /api/admin/dispatch/:id/status with { status: 'en_route' | 'on_site' }
 *   On success, re-fetches the job so the displayed status reflects
 *   the change. The dispatch:job_update + dispatch:tech_status
 *   broadcasts will also fire from the server, so the roster + map
 *   update without a refresh.
 *
 * Tier 1 V2 styling: Sheet primitive, Card / Button / Badge from
 * components/ui, zinc ramp.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Sheet,
  SheetHeader,
  SheetBody,
  SheetFooter,
  Button,
  Badge,
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

export default function JobDrawer({ jobId, onClose }) {
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busyAction, setBusyAction] = useState(null);

  // Race guard: tracks the currently-selected jobId. If the dispatcher
  // closes one drawer and quickly opens another (or just clicks pin A
  // → pin B), an in-flight A response could land after B's selection
  // and overwrite the B drawer with stale A data. Worse, the action
  // buttons would target the wrong service. Guard at every state-
  // applying boundary by checking the ref before setJob/setError.
  // Codex P1 on PR #303.
  const currentIdRef = useRef(null);

  const fetchJob = useCallback(async (id) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/dispatch/jobs/${id}`, {
        headers: adminAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Selection changed while we were fetching — drop this response.
      if (currentIdRef.current !== id) return;
      setJob(data);
    } catch (err) {
      if (currentIdRef.current !== id) return;
      setError(err.message || 'Failed to load job');
    } finally {
      // Only clear the loading flag if we're still on the same job —
      // a stale loading=false would briefly flash empty before the
      // newer fetch completes.
      if (currentIdRef.current === id) setLoading(false);
    }
  }, []);

  // Re-fetch on every open or jobId change. A drawer that was open
  // and then re-opened on the same job should still show fresh data
  // — the pin click might've happened minutes after a status change.
  useEffect(() => {
    currentIdRef.current = jobId;
    if (jobId) {
      fetchJob(jobId);
    } else {
      setJob(null);
      setError(null);
    }
  }, [jobId, fetchJob]);

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
            <Field label="Tech">
              {job.tech_full_name || (
                <span className="text-ink-tertiary italic">Unassigned</span>
              )}
            </Field>
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
