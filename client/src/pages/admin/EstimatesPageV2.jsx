// client/src/pages/admin/EstimatesPageV2.jsx
// Monochrome V2 of EstimatePage. Strict 1:1 on data, endpoints, behavior:
//   - GET   /admin/estimates
//   - PATCH /admin/estimates/:id            (isPriority, status, declineReason)
//   - POST  /admin/estimates/:id/send
//   - POST  /admin/estimates/:id/follow-up
// Scope (post PR #5c):
//   PR #5a → tab chrome + Pipeline tab (stats bar + filter pills + list rows)
//   PR #5b → Create Estimate tab now renders EstimateToolViewV2 (monochrome
//            estimator — same endpoints/state/pricing as V1)
//   PR #5c → FollowUpModalV2 + DeclineModalV2 replace V1 modals (Dialog
//            primitive, danger variant on Mark-as-Lost)
// Leads / Pricing Logic tabs still render V1 panels.
import React, { useState, useEffect, useCallback } from 'react';
import {
  STATUS_CONFIG,
  PIPELINE_FILTERS,
  classifyEstimate,
  getUrgencyIndicator,
  detectCompetitor,
} from './EstimatePage';
import { LeadsSection } from './LeadsTabs';
import PricingLogicPanel from '../../components/admin/PricingLogicPanel';
import { MarginCalculator } from './PricingLogicPage';
import EstimateToolViewV2 from './EstimateToolViewV2';
import {
  FollowUpModalV2,
  DeclineModalV2,
} from '../../components/admin/EstimateModalsV2';
import { Badge, Button, Card, cn } from '../../components/ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// Status badge. V2 collapses to neutral; alert tone only for declined/expired.
function StatusBadgeV2({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.draft;
  const isAlert = status === 'declined' || status === 'expired';
  const isStrong = status === 'accepted';
  return (
    <Badge tone={isAlert ? 'alert' : isStrong ? 'strong' : 'neutral'}>
      {cfg.label}
    </Badge>
  );
}

// Urgency indicator — "Going cold" / "Final follow-up" get alert tone,
// "Not opened" / "Follow up" stay neutral. V1 used red-at-72h/168h, amber
// at 24h/48h — we preserve the thresholds; only the visual weight changes.
function UrgencyBadge({ urgency }) {
  if (!urgency) return null;
  const isCritical =
    urgency.label === 'Going cold' || urgency.label === 'Final follow-up';
  return (
    <Badge tone={isCritical ? 'alert' : 'neutral'}>{urgency.label}</Badge>
  );
}

// Filter pill — active pill uses filled zinc-900, inactive is outline.
// Pipeline filter keys never trigger alert tone on their own — the counts
// are informational, not action items.
function FilterPillV2({ active, label, count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 px-3 text-11 rounded-xs uppercase font-medium tracking-label',
        'border-hairline u-focus-ring transition-colors',
        active
          ? 'bg-zinc-900 text-white border-zinc-900'
          : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50',
      )}
    >
      {label} <span className="u-nums opacity-70">({count})</span>
    </button>
  );
}

// Stat card — label, big value, sub. Single alert accent reserved for
// Follow-Up Overdue when > 0. Conversion% no longer color-codes; the
// number alone tells the story.
function StatCard({ label, value, sub, alert }) {
  return (
    <Card className="flex-1 min-w-[140px] p-4 text-center">
      <div className="text-11 uppercase tracking-label text-ink-tertiary mb-1">
        {label}
      </div>
      <div
        className={cn(
          'text-22 font-medium u-nums',
          alert ? 'text-alert-fg' : 'text-zinc-900',
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="text-11 text-ink-tertiary mt-1">{sub}</div>
      )}
    </Card>
  );
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function timeAgo(d) {
  if (!d) return '';
  const mins = Math.floor((Date.now() - new Date(d)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const SOURCE_ICON = {
  lead_webhook: { icon: '🌐', title: 'Website lead' },
  voice_agent: { icon: '🎙️', title: 'Voice agent lead' },
  referral: { icon: '🤝', title: 'Referral' },
  ai_agent: { icon: '🤖', title: 'AI agent draft — review before sending' },
};

function EstimatePipelineViewV2() {
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [followUpTarget, setFollowUpTarget] = useState(null);
  const [declineTarget, setDeclineTarget] = useState(null);

  const refreshEstimates = useCallback(() => {
    adminFetch('/admin/estimates')
      .then((d) => {
        setEstimates(d.estimates || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshEstimates();
  }, [refreshEstimates]);

  const togglePriority = useCallback(async (e) => {
    const newVal = !e.isPriority;
    try {
      await adminFetch(`/admin/estimates/${e.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isPriority: newVal }),
      });
      setEstimates((prev) =>
        prev.map((est) => (est.id === e.id ? { ...est, isPriority: newVal } : est)),
      );
    } catch {
      alert('Failed to update priority');
    }
  }, []);

  if (loading) {
    return (
      <div className="p-10 text-center text-13 text-ink-secondary">
        Loading estimates…
      </div>
    );
  }

  // Classify + sort (priority first, then newest)
  const classified = estimates.map((e) => ({ ...e, _class: classifyEstimate(e) }));
  const sorted = [...classified].sort((a, b) => {
    if (a.isPriority && !b.isPriority) return -1;
    if (!a.isPriority && b.isPriority) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  // Stats — preserved 1:1 from V1
  const total = estimates.length;
  const accepted = estimates.filter((e) => e.status === 'accepted').length;
  const sent = estimates.filter((e) => ['sent', 'viewed'].includes(e.status)).length;
  const declined = estimates.filter(
    (e) => e.status === 'declined' || e.status === 'expired',
  ).length;
  const totalMRRWon = estimates
    .filter((e) => e.status === 'accepted')
    .reduce((s, e) => s + (e.monthlyTotal || 0), 0);
  const pipelineValue = estimates
    .filter((e) => !['accepted', 'declined', 'expired'].includes(e.status))
    .reduce((s, e) => s + (e.monthlyTotal || 0), 0);
  const conversionRate =
    sent + accepted + declined > 0
      ? Math.round((accepted / (sent + accepted + declined)) * 100)
      : 0;
  const avgEstimateValue =
    total > 0
      ? Math.round(
          estimates.reduce((s, e) => s + (e.monthlyTotal || 0), 0) / total,
        )
      : 0;

  const HOUR = 3600000;
  const now = Date.now();
  const followUpOverdue = estimates.filter((e) => {
    if (
      e.status === 'sent' &&
      !e.viewedAt &&
      e.sentAt &&
      now - new Date(e.sentAt).getTime() > 72 * HOUR
    )
      return true;
    if (
      e.status === 'viewed' &&
      e.viewedAt &&
      now - new Date(e.viewedAt).getTime() > 48 * HOUR
    )
      return true;
    return false;
  }).length;

  // Filter counts
  const filterCounts = {};
  for (const f of PIPELINE_FILTERS) {
    filterCounts[f.key] =
      f.key === 'all' ? total : classified.filter((e) => e._class === f.key).length;
  }

  const filtered =
    filter === 'all' ? sorted : sorted.filter((e) => e._class === filter);

  return (
    <div>
      {followUpTarget && (
        <FollowUpModalV2
          estimate={followUpTarget}
          onClose={() => setFollowUpTarget(null)}
          onSent={() => {
            setFollowUpTarget(null);
            refreshEstimates();
          }}
        />
      )}
      {declineTarget && (
        <DeclineModalV2
          estimate={declineTarget}
          onClose={() => setDeclineTarget(null)}
          onSaved={() => {
            setDeclineTarget(null);
            refreshEstimates();
          }}
        />
      )}

      {/* Stats bar */}
      <div className="flex gap-2 mb-5 flex-wrap">
        <StatCard
          label="Pipeline Value"
          value={`$${Math.round(pipelineValue)}`}
          sub="/mo potential"
        />
        <StatCard
          label="MRR Won"
          value={`$${Math.round(totalMRRWon)}`}
          sub="/mo closed"
        />
        <StatCard
          label="Conversion"
          value={`${conversionRate}%`}
          sub={`${accepted} of ${sent + accepted + declined}`}
        />
        <StatCard
          label="Avg Estimate"
          value={`$${avgEstimateValue}`}
          sub="/mo"
        />
        <StatCard
          label="Follow-Up Overdue"
          value={followUpOverdue}
          sub={followUpOverdue > 0 ? 'need attention' : 'all clear'}
          alert={followUpOverdue > 0}
        />
        <StatCard
          label="Total"
          value={total}
          sub={`${accepted} won · ${declined} lost`}
        />
      </div>

      {/* Filter pills */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {PIPELINE_FILTERS.map((f) => (
          <FilterPillV2
            key={f.key}
            active={filter === f.key}
            label={f.label}
            count={filterCounts[f.key]}
            onClick={() => setFilter(f.key)}
          />
        ))}
      </div>

      {/* Estimates list */}
      {filtered.length === 0 ? (
        <div className="p-10 text-center text-13 text-ink-secondary">
          No estimates{' '}
          {filter !== 'all'
            ? `in "${PIPELINE_FILTERS.find((f) => f.key === filter)?.label}"`
            : 'yet'}
          . Create one using the Create Estimate tab.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((e) => {
            const urgency = getUrgencyIndicator(e);
            const competitor = detectCompetitor(e.notes || e.description);
            const source = SOURCE_ICON[e.source];

            return (
              <Card
                key={e.id}
                className={cn(
                  'p-4 flex flex-wrap items-center gap-3 relative',
                  e.isPriority && 'border-alert-fg',
                )}
              >
                {e.isPriority && (
                  <div className="absolute -top-px right-4 bg-alert-fg text-white text-11 uppercase tracking-label font-medium px-2 py-0.5 rounded-b-xs">
                    Urgent
                  </div>
                )}

                <StatusBadgeV2 status={e.status} />

                {/* Customer info */}
                <div className="flex-1 min-w-[150px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-14 font-medium text-zinc-900">
                      {e.customerName || 'Unknown'}
                    </span>
                    {source && (
                      <span title={source.title} className="text-14">
                        {source.icon}
                      </span>
                    )}
                    <UrgencyBadge urgency={urgency} />
                    {competitor && (
                      <Badge tone="neutral" title={`Switching from ${competitor}`}>
                        Switching from: {competitor}
                      </Badge>
                    )}
                    {e.declineReason && (
                      <Badge tone="alert">{e.declineReason}</Badge>
                    )}
                  </div>
                  <div className="text-12 text-ink-secondary mt-0.5 truncate">
                    {e.address || '—'}
                    {e.serviceInterest ? ` · ${e.serviceInterest}` : ''}
                  </div>
                </div>

                {e.tier && <Badge tone="neutral">{e.tier}</Badge>}

                {/* Monthly total */}
                <div className="text-right min-w-[80px]">
                  <div
                    className={cn(
                      'text-18 font-medium u-nums',
                      e.monthlyTotal > 0 ? 'text-zinc-900' : 'text-ink-tertiary',
                    )}
                  >
                    ${e.monthlyTotal?.toFixed(0) || '0'}
                    <span className="text-11 font-normal text-ink-tertiary">
                      /mo
                    </span>
                  </div>
                </div>

                {/* Timeline */}
                <div className="text-right min-w-[110px] text-11 text-ink-secondary space-y-0.5">
                  <div>Created {fmtDate(e.createdAt)}</div>
                  {e.sentAt && <div>Sent {timeAgo(e.sentAt)}</div>}
                  {e.viewedAt && <div>Viewed {timeAgo(e.viewedAt)}</div>}
                  {e.acceptedAt && <div>Accepted {timeAgo(e.acceptedAt)}</div>}
                  {e.declinedAt && <div>Declined {timeAgo(e.declinedAt)}</div>}
                  {e.followUpCount > 0 && (
                    <div>Follow-ups: {e.followUpCount}</div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => togglePriority(e)}
                    title={e.isPriority ? 'Remove priority' : 'Flag as urgent'}
                    className={cn(
                      'h-7 w-7 flex items-center justify-center rounded-xs border-hairline u-focus-ring transition-colors',
                      e.isPriority
                        ? 'bg-alert-bg text-alert-fg border-alert-fg'
                        : 'bg-white text-ink-secondary border-zinc-300 hover:bg-zinc-50',
                    )}
                  >
                    ⚑
                  </button>

                  {e.status === 'draft' && e.monthlyTotal > 0 && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={async () => {
                        await adminFetch(`/admin/estimates/${e.id}/send`, {
                          method: 'POST',
                        }).catch(() => {});
                        refreshEstimates();
                      }}
                    >
                      Send
                    </Button>
                  )}

                  {(e.status === 'sent' || e.status === 'viewed') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setFollowUpTarget(e)}
                    >
                      Follow Up
                    </Button>
                  )}

                  {(e.status === 'sent' || e.status === 'viewed') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setDeclineTarget(e)}
                    >
                      Mark Lost
                    </Button>
                  )}

                  {(e.status === 'sent' || e.status === 'viewed') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const link = `${window.location.origin}/estimate/${e.token || e.id}`;
                        navigator.clipboard?.writeText(link);
                      }}
                    >
                      Copy Link
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { key: 'leads', label: 'Leads' },
  { key: 'estimates', label: 'Estimates' },
  { key: 'new', label: 'Create Estimate' },
  { key: 'pricing', label: 'Pricing Logic' },
];

export default function EstimatesPageV2() {
  const [activeTab, setActiveTab] = useState('leads');

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="text-28 font-medium text-zinc-900 tracking-display">
          Pipeline
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                'h-9 px-4 text-12 uppercase font-medium tracking-label rounded-sm border-hairline u-focus-ring transition-colors',
                activeTab === t.key
                  ? 'bg-zinc-900 text-white border-zinc-900'
                  : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'leads' && <LeadsSection />}
      {activeTab === 'estimates' && <EstimatePipelineViewV2 />}
      {activeTab === 'new' && <EstimateToolViewV2 />}
      {activeTab === 'pricing' && (
        <>
          <MarginCalculator />
          <PricingLogicPanel />
        </>
      )}
    </div>
  );
}
