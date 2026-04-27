/**
 * <ActionQueuePane> — right pane, action queue.
 *
 * Reads dispatch_alerts via useDispatchAlerts (hydration via
 * GET /api/admin/dispatch/alerts?unresolved=true, then live updates
 * via dispatch:alert socket broadcasts). Renders one <AlertCard> per
 * unresolved alert, newest first.
 *
 * Read-only in v1 — resolve / snooze / acknowledge actions land in
 * a follow-up PR. Generators (cron + inline detectors) also land
 * separately. This PR closes the dispatch:alert loop on the read
 * side: PR #293 shipped channel + storage; this surfaces the data
 * to the dispatcher.
 *
 * Tier 1 V2 styling.
 */
import React from 'react';
import { useDispatchAlerts } from '../../hooks/useDispatchAlerts';
import AlertCard from './AlertCard';

export default function ActionQueuePane() {
  const { alerts, loading, error } = useDispatchAlerts();

  return (
    <aside className="w-80 flex-shrink-0 bg-white border-l border-hairline border-zinc-200 flex flex-col">
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
          alerts.map((a) => <AlertCard key={a.id} alert={a} />)
        )}
      </div>
    </aside>
  );
}
