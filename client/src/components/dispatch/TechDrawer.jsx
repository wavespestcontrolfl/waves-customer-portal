/**
 * <TechDrawer> — slide-in panel that opens when a tech is selected
 * in the roster (left pane) or by clicking a tech pin on the map.
 * Mirrors <JobDrawer> in shape and race-safety pattern; differs in
 * that v1 is read-only — no per-tech actions land in this PR.
 *
 * Hydration:
 *   GET /api/admin/dispatch/techs/:id on open. Fetches fresh on every
 *   re-open because broadcasts (dispatch:tech_status / dispatch:alert)
 *   may have moved the world while the drawer was closed.
 *
 * Race-safety:
 *   currentIdRef tracks the selected tech id; every async branch
 *   (fetch resolve / catch / finally) checks it before applying state.
 *   On selection change we synchronously clear `tech` and `error` so
 *   the body falls through to the "Loading…" branch instead of
 *   rendering stale data — same pattern as JobDrawer (Codex P1 #303).
 *
 * Tier 1 V2 styling: Sheet + Card / Badge / Button primitives, zinc
 * ramp, fontWeight 400/500 only, 14px text minimum.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet, SheetHeader, SheetBody, Badge, Button, Card, cn } from '../ui';

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
  wrapping_up: 'neutral',
  driving:     'strong',
  break:       'neutral',
  idle:        'neutral',
};

const JOB_STATUS_TONE = {
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
  if (s && e) return `${s}–${e}`;
  return s || e;
}

function customerLine(stop) {
  if (!stop.customer_first_name) return null;
  // Full last name is OK on this admin-authenticated drawer.
  return [stop.customer_first_name, stop.customer_last_name].filter(Boolean).join(' ');
}

function RouteStop({ stop }) {
  return (
    <Card className="px-3 py-2 mb-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-12 text-ink-tertiary tabular-nums">
          {formatWindow(stop.window_start, stop.window_end) || 'Anytime'}
        </div>
        <Badge tone={JOB_STATUS_TONE[stop.status] || 'neutral'}>{stop.status}</Badge>
      </div>
      <div className="text-14 font-medium text-ink-primary truncate">
        {customerLine(stop) || (
          <span className="text-ink-tertiary italic">No customer</span>
        )}
      </div>
      {stop.service_type && (
        <div className="text-12 text-ink-secondary truncate">
          {stop.service_type}
        </div>
      )}
      {stop.address && (
        <div className="text-12 text-ink-tertiary truncate" title={stop.address}>
          {stop.address}
        </div>
      )}
    </Card>
  );
}

export default function TechDrawer({ techId, onClose }) {
  const [tech, setTech] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const currentIdRef = useRef(null);

  const fetchTech = useCallback(async (id) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/dispatch/techs/${id}`, {
        headers: adminAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (currentIdRef.current !== id) return;
      setTech(data);
    } catch (err) {
      if (currentIdRef.current !== id) return;
      setError(err.message || 'Failed to load tech');
    } finally {
      if (currentIdRef.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    currentIdRef.current = techId;
    setTech(null);
    setError(null);
    if (techId) fetchTech(techId);
  }, [techId, fetchTech]);

  const open = !!techId;

  return (
    <Sheet open={open} onClose={onClose} width="md">
      <SheetHeader>
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-18 font-medium text-ink-primary truncate">
            {tech ? tech.name : 'Tech'}
          </h2>
          {tech && (
            <Badge tone={STATUS_TONE[tech.status] || 'neutral'}>
              {tech.status || 'idle'}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          Close
        </Button>
      </SheetHeader>

      <SheetBody>
        {loading && !tech && (
          <div className="text-14 text-ink-tertiary">Loading tech…</div>
        )}
        {error && (
          <div className="text-14 text-alert-fg mb-3">{error}</div>
        )}
        {tech && (
          <>
            <Field label="Role">{tech.role}</Field>
            <Field label="Phone">
              {tech.phone ? (
                <a
                  href={`tel:${tech.phone}`}
                  className="text-waves-blue hover:underline"
                >
                  {tech.phone}
                </a>
              ) : null}
            </Field>
            <Field label="Email">
              {tech.email ? (
                <a
                  href={`mailto:${tech.email}`}
                  className="text-waves-blue hover:underline"
                >
                  {tech.email}
                </a>
              ) : null}
            </Field>

            <div className="mt-2 mb-4 grid grid-cols-3 gap-2">
              <Card className="p-3">
                <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary">
                  Done
                </div>
                <div className="text-18 tabular-nums text-ink-primary">
                  {tech.today.completed}/{tech.today.total}
                </div>
              </Card>
              <Card className="p-3">
                <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary">
                  Open Late
                </div>
                <div
                  className={cn(
                    'text-18 tabular-nums',
                    tech.today.late_count > 0 ? 'text-alert-fg' : 'text-ink-primary'
                  )}
                >
                  {tech.today.late_count}
                </div>
              </Card>
              <Card className="p-3">
                <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary">
                  Active
                </div>
                <div className="text-14 text-ink-primary">
                  {tech.active ? 'Yes' : 'No'}
                </div>
              </Card>
            </div>

            <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary mb-2">
              Today's route
            </div>
            {tech.route.length === 0 ? (
              <div className="text-14 text-ink-tertiary">
                No jobs scheduled for today.
              </div>
            ) : (
              tech.route.map((stop) => (
                <RouteStop key={stop.job_id} stop={stop} />
              ))
            )}
          </>
        )}
      </SheetBody>
    </Sheet>
  );
}
