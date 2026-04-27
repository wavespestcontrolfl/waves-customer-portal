/**
 * <ActionQueuePane> — right pane, action queue.
 *
 * Reads dispatch_alerts via useDispatchAlerts (hydration via
 * GET /api/admin/dispatch/alerts?unresolved=true, then live updates
 * via dispatch:alert + dispatch:alert_resolved socket broadcasts).
 * Renders one <AlertCard> per unresolved alert, newest first, and
 * passes the hook's resolveAlert callback through so each card can
 * close itself.
 *
 * Tier 1 V2 styling.
 */
import React from 'react';
import { useDispatchAlerts } from '../../hooks/useDispatchAlerts';
import AlertCard from './AlertCard';

export default function ActionQueuePane() {
  const { alerts, loading, error, resolveAlert } = useDispatchAlerts();

  return (
    <aside className="w-full md:w-80 md:flex-shrink-0 bg-white md:border-l border-hairline border-zinc-200 flex flex-col">
      <div className="px-4 py-3 border-b border-hairline border-zinc-200 flex items-center justify-between">
        <h2 className="text-12 uppercase tracking-label font-medium text-ink-secondary">
          Action Queue
        </h2>
        <span className="text-11 text-ink-tertiary tabular-nums">
          {alerts.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="text-12 text-ink-tertiary px-1 py-2">
            Loading alerts…
          </div>
        ) : error ? (
          <div className="text-12 text-alert-fg px-1 py-2">
            Failed to load alerts: {error}
          </div>
        ) : alerts.length === 0 ? (
          <div className="text-12 text-ink-tertiary px-1 py-2">
            No active alerts.
          </div>
        ) : (
          alerts.map((a) => (
            <AlertCard key={a.id} alert={a} onResolve={resolveAlert} />
          ))
        )}
      </div>
    </aside>
  );
}
