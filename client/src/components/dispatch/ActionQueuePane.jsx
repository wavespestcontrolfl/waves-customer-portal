/**
 * <ActionQueuePane> — right pane, action queue.
 *
 * Reads dispatch_alerts via useDispatchAlerts (hydration via
 * GET /api/admin/dispatch/alerts?unresolved=true, then live updates
 * via dispatch:alert + dispatch:alert_resolved socket broadcasts).
 * Renders one <AlertCard> per unresolved alert, newest first, and
 * passes the hook's resolveAlert callback through so each card can
 * close itself. `onOpenJob(jobId)` (optional) is threaded straight
 * through to each <AlertCard> so a card whose alert carries a job_id
 * can offer an "Open job" action — <DispatchBoardPage> wires this to
 * handleSelectJob, opening <JobDrawer>.
 *
 * Tier 1 V2 styling.
 */
import React, { useState } from 'react';
import { useDispatchAlerts } from '../../hooks/useDispatchAlerts';
import AlertCard from './AlertCard';
import { ActionFeedback, Button } from '../ui';

const PROTECTED_DECISION_TYPES = new Set([
  'visit_not_closed_out',
  'follow_up_needed',
  'tech_out_overflow',
]);

export default function ActionQueuePane({ onOpenJob, feedbackRetryEnabled = false }) {
  const { alerts, total, loading, error, retryAlerts, resolveAlert, clearAlerts, decideNotClosedOut } = useDispatchAlerts();
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(null);
  const [clearNotice, setClearNotice] = useState(null);

  const openTotal = Math.max(alerts.length, Number.isFinite(total) ? total : alerts.length);
  const isTruncated = openTotal > alerts.length;
  const protectedCount = alerts.filter((a) => PROTECTED_DECISION_TYPES.has(a.type)).length;

  async function handleClearAll() {
    if (clearing || alerts.length === 0) return;
    const msg = protectedCount > 0
      ? 'Clear informational and overdue alerts? Decision cards (missed closeouts, follow-ups, and tech-out stops) stay open until decided.'
      : 'Clear all active Action Queue alerts? This marks them resolved and keeps audit history.';
    const ok = window.confirm(msg);
    if (!ok) return;
    setClearing(true);
    setClearError(null);
    setClearNotice(null);
    try {
      const data = await clearAlerts();
      const cleared = Number(data?.resolved ?? 0);
      if (protectedCount > 0) {
        setClearNotice(
          cleared > 0
            ? `Cleared ${cleared} alert${cleared === 1 ? '' : 's'}. Decision cards stay open until acted on.`
            : 'Only decision cards remain — each requires an action on the card.',
        );
      }
    } catch (err) {
      setClearError(err?.message || 'Clear failed');
    } finally {
      setClearing(false);
    }
  }

  return (
    <aside className="w-full xl:w-80 xl:flex-shrink-0 bg-white xl:border-l border-hairline border-zinc-200 flex flex-col">
      <div className="px-4 py-3 border-b border-hairline border-zinc-200 flex items-center justify-between">
        <h2 className="text-12 uppercase tracking-label font-medium text-ink-secondary">
          Action Queue
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-11 text-ink-tertiary tabular-nums">
            {isTruncated ? `${alerts.length} / ${openTotal}` : openTotal}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleClearAll}
            disabled={loading || clearing || alerts.length === 0}
            className="h-7 px-2"
          >
            {clearing ? 'Clearing...' : 'Clear'}
          </Button>
        </div>
      </div>
      {isTruncated && (
        <div role="status" className="px-4 py-2 text-12 text-ink-secondary bg-zinc-50 border-b border-hairline border-zinc-200">
          Showing top {alerts.length} of {openTotal} open alerts. Resolve or decide cards to see more.
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="text-12 text-ink-tertiary px-1 py-2">
            Loading alerts…
          </div>
        ) : error ? (
          feedbackRetryEnabled ? (
            <ActionFeedback error onRetry={retryAlerts} className="px-1 py-2">
              Failed to load alerts: {error}
            </ActionFeedback>
          ) : (
            <div className="text-12 text-alert-fg px-1 py-2">
              Failed to load alerts: {error}
            </div>
          )
        ) : alerts.length === 0 ? (
          <div className="text-12 text-ink-tertiary px-1 py-2">
            No active alerts.
          </div>
        ) : (
          <>
            {clearError && (
              <div className="text-12 text-alert-fg px-1 pb-2">
                Clear failed: {clearError}
              </div>
            )}
            {clearNotice && (
              <div role="status" className="text-12 text-ink-secondary px-1 pb-2">
                {clearNotice}
              </div>
            )}
            {alerts.map((a) => (
              <AlertCard key={a.id} alert={a} onResolve={resolveAlert} onOpenJob={onOpenJob} onDecide={decideNotClosedOut} />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
