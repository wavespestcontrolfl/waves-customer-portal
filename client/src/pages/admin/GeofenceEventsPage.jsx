/**
 * Admin observability dashboard for the geofence_events table.
 *
 * Built specifically to support the auto-flip rollout:
 *   1. Operator enables geofence.auto_flip_on_departure='true' with
 *      auto_flip_dry_run='true' on Railway.
 *   2. Watches this dashboard for the auto_flip_dry_run rows that
 *      would have fired SMS, plus the auto_flip_skipped_* rows that
 *      explain why other EXIT events were filtered out.
 *   3. After a clean observation window, flips dry_run to false and
 *      keeps watching auto_flip_en_route / auto_flip_failed counts.
 *
 * Tier 1 V2 styling: components/ui primitives + Tailwind zinc ramp.
 * No D palette. Alert-fg reserved for genuine alerts (the failure
 * row only).
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Badge, Button, Card, CardBody, Select, cn } from '../../components/ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then((r) => {
    if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `HTTP ${r.status}`); }).catch(() => { throw new Error(`HTTP ${r.status}`); });
    return r.json();
  });
}

// Categorize each action_taken so the summary cards group related
// signals together. Order matters — the operator's eye should land
// first on auto-flip outcomes (the new pipeline), then auto-flip
// skips (why the system didn't fire), then existing timer events,
// then errors/no-ops.
const GROUPS = [
  {
    key: 'auto_flip_outcomes',
    label: 'Auto-flip outcomes',
    actions: ['auto_flip_en_route', 'auto_flip_dry_run', 'auto_flip_failed', 'auto_flip_claim'],
  },
  {
    key: 'auto_flip_skips',
    label: 'Auto-flip skipped (informational)',
    actions: [
      'auto_flip_skipped_dwell',
      'auto_flip_skipped_no_next_job',
      'auto_flip_skipped_no_window',
      'auto_flip_skipped_horizon',
      'auto_flip_skipped_cooldown',
      'auto_flip_skipped_dedupe',
      'auto_flip_skipped_tech_disabled',
      'auto_flip_skipped_customer_disabled',
    ],
  },
  {
    key: 'timer_events',
    label: 'Timer events',
    actions: ['timer_started', 'timer_stopped', 'timer_already_running', 'no_active_timer', 'reminder_sent'],
  },
  {
    key: 'noops_errors',
    label: 'No-match / errors',
    actions: ['no_customer_match', 'ignored_duplicate', 'unknown_vehicle', 'geocoding_failed', 'dismissed'],
  },
];

const WINDOWS = [
  { value: 24, label: 'Last 24 hours' },
  { value: 168, label: 'Last 7 days' },
  { value: 720, label: 'Last 30 days' },
];

// alert-fg only on genuine alerts. auto_flip_failed is the one that
// gets red — everything else uses zinc/neutral. Skips are
// informational, not alerts.
function actionVariant(action) {
  if (action === 'auto_flip_failed') return 'alert';
  if (action === 'auto_flip_en_route') return 'success';
  if (action === 'auto_flip_dry_run') return 'info';
  if (action.startsWith('auto_flip_skipped')) return 'muted';
  if (action === 'timer_started' || action === 'timer_stopped') return 'success';
  return 'muted';
}

function variantClasses(variant) {
  switch (variant) {
    case 'alert':   return 'bg-alert-fg/10 text-alert-fg border-alert-fg/30';
    case 'success': return 'bg-zinc-100 text-zinc-900 border-zinc-300';
    case 'info':    return 'bg-zinc-50 text-zinc-700 border-zinc-200';
    default:        return 'bg-zinc-50 text-zinc-500 border-zinc-200';
  }
}

// Pinned to America/New_York. The portal is ET-only by policy
// (CLAUDE.md), and an admin reading auto-flip events from a phone
// in another timezone would otherwise see shifted timestamps and
// misclassify rollout behavior.
function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

function customerName(row) {
  const f = row.customer_first_name;
  const l = row.customer_last_name;
  if (!f && !l) return '—';
  return `${f || ''} ${l ? l.charAt(0) + '.' : ''}`.trim();
}

export default function GeofenceEventsPage() {
  const [sinceHours, setSinceHours] = useState(168);
  const [actionFilter, setActionFilter] = useState('');
  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Send a full ISO timestamp, not YYYY-MM-DD. The backend
      // applies `event_timestamp >= startDate` directly, and rounding
      // to calendar day would let "Last 24 hours" return up to ~48
      // hours of data depending on local time — disagreeing with the
      // summary endpoint's exact rolling-hour cutoff.
      const startDate = new Date(Date.now() - sinceHours * 60 * 60 * 1000)
        .toISOString();
      const params = new URLSearchParams({
        startDate,
        limit: '100',
      });
      if (actionFilter) params.set('action', actionFilter);
      const [s, e] = await Promise.all([
        adminFetch(`/admin/geofence/events/summary?sinceHours=${sinceHours}`),
        adminFetch(`/admin/geofence/events?${params.toString()}`),
      ]);
      setSummary(s);
      setEvents(e.events || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sinceHours, actionFilter]);

  useEffect(() => { load(); }, [load]);

  const countMap = useMemo(() => {
    const m = new Map();
    (summary?.byAction || []).forEach((r) => m.set(r.action, r.count));
    return m;
  }, [summary]);

  const groupTotals = useMemo(() => {
    const totals = {};
    GROUPS.forEach((g) => {
      totals[g.key] = g.actions.reduce((sum, a) => sum + (countMap.get(a) || 0), 0);
    });
    return totals;
  }, [countMap]);

  // All distinct actions in the current window, for the filter dropdown.
  const allActions = useMemo(() => {
    const seen = new Set((summary?.byAction || []).map((r) => r.action));
    return Array.from(seen).sort();
  }, [summary]);

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-28 font-normal tracking-h1 text-ink-primary">
            <span className="md:hidden" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>Geofence</span>
            <span className="hidden md:inline">Geofence</span>
          </h1>
        </div>
        <Button variant="ghost" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </header>

      {/* Window + action filter row */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select
          value={sinceHours}
          onChange={(e) => setSinceHours(parseInt(e.target.value, 10))}
          className="w-44"
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </Select>
        <Select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="w-72"
        >
          <option value="">All actions</option>
          {allActions.map((a) => (
            <option key={a} value={a}>{a} ({countMap.get(a) || 0})</option>
          ))}
        </Select>
        {summary != null && (
          <span className="text-14 text-ink-tertiary">
            {summary.total} events · {summary.byAction.length} distinct actions
          </span>
        )}
      </div>

      {error && (
        <Card className="mb-6 border-alert-fg/40">
          <CardBody>
            <div className="text-14 text-alert-fg">Failed to load: {error}</div>
          </CardBody>
        </Card>
      )}

      {/* Summary cards: one per group */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {GROUPS.map((g) => (
          <Card key={g.key}>
            <CardBody>
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-14 font-medium text-ink-primary uppercase tracking-label">
                  {g.label}
                </h2>
                <span className="text-display font-medium tabular-nums text-ink-primary">
                  {groupTotals[g.key] ?? 0}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {g.actions.map((a) => {
                  const n = countMap.get(a) || 0;
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setActionFilter(actionFilter === a ? '' : a)}
                      className={cn(
                        'flex items-center justify-between text-14 py-1 px-2 rounded',
                        'hover:bg-zinc-50 transition-colors',
                        actionFilter === a && 'bg-zinc-100'
                      )}
                    >
                      <span className={cn(
                        'font-medium',
                        n === 0 ? 'text-ink-tertiary' : 'text-ink-secondary',
                        a === 'auto_flip_failed' && n > 0 && 'text-alert-fg'
                      )}>
                        {a}
                      </span>
                      <span className={cn(
                        'tabular-nums',
                        n === 0 ? 'text-ink-tertiary' : 'text-ink-primary'
                      )}>
                        {n}
                      </span>
                    </button>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Recent events table */}
      <Card>
        <CardBody>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-14 font-medium text-ink-primary uppercase tracking-label">
              Recent events
            </h2>
            <span className="text-14 text-ink-tertiary">
              {events.length} shown
            </span>
          </div>
          {events.length === 0 && !loading && (
            <div className="text-14 text-ink-tertiary py-8 text-center">
              No events in this window.
            </div>
          )}
          {events.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-14">
                <thead>
                  <tr className="border-b border-hairline text-ink-tertiary">
                    <th className="text-left font-medium py-2 px-2 uppercase text-12 tracking-label">When</th>
                    <th className="text-left font-medium py-2 px-2 uppercase text-12 tracking-label">Type</th>
                    <th className="text-left font-medium py-2 px-2 uppercase text-12 tracking-label">Tech</th>
                    <th className="text-left font-medium py-2 px-2 uppercase text-12 tracking-label">Customer</th>
                    <th className="text-left font-medium py-2 px-2 uppercase text-12 tracking-label">Action</th>
                    <th className="text-left font-medium py-2 px-2 uppercase text-12 tracking-label">Job</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} className="border-b border-hairline hover:bg-zinc-50">
                      <td className="py-2 px-2 text-ink-secondary tabular-nums whitespace-nowrap">
                        {fmtTime(e.event_timestamp)}
                      </td>
                      <td className="py-2 px-2 text-ink-secondary">
                        <Badge variant="muted">{e.event_type}</Badge>
                      </td>
                      <td className="py-2 px-2 text-ink-primary">
                        {e.tech_name || '—'}
                      </td>
                      <td className="py-2 px-2 text-ink-primary">
                        {customerName(e)}
                      </td>
                      <td className="py-2 px-2">
                        <span className={cn(
                          'inline-block px-2 py-0.5 rounded text-12 font-medium border',
                          variantClasses(actionVariant(e.action_taken))
                        )}>
                          {e.action_taken}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-ink-tertiary tabular-nums text-12">
                        {e.matched_job_id ? e.matched_job_id.slice(0, 8) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
