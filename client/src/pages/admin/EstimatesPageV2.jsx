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
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, useNavigate } from 'react-router-dom';
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
import CustomerEstimatesPanel from './CustomerEstimatesPanel';
import {
  FollowUpModalV2,
  DeclineModalV2,
} from '../../components/admin/EstimateModalsV2';
import useIsMobile from '../../hooks/useIsMobile';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { Badge, Button, Card, CardBody, cn } from '../../components/ui';
import {
  Flag, Globe, Mic, Users, Bot, Phone, MessageSquare, Send, FilePlus2, SlidersHorizontal,
  Check, X, ArrowLeft, Plus,
} from 'lucide-react';

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

// Estimates v2 status pills (spec §6). Monochrome-professional; red is
// reserved strictly for `expired` so Virginia can scan "what needs attention
// today" in under 5 seconds. Gated by the `estimates_v2_status_pills` flag.
function StatusPillV3({ status }) {
  const label = (STATUS_CONFIG[status] || STATUS_CONFIG.draft).label;
  // Common base for the filled-pill variants.
  const filled = 'inline-flex items-center gap-1 h-5 px-2 rounded-full text-11 font-medium whitespace-nowrap';
  switch (status) {
    case 'expired':
      return (
        <span className={cn(filled, 'bg-alert-fg text-white')}>{label}</span>
      );
    case 'viewed':
      return (
        <span className={cn(filled, 'bg-zinc-200 text-zinc-900')}>
          <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-zinc-900" />
          {label}
        </span>
      );
    case 'accepted':
      return (
        <span className={cn(filled, 'bg-zinc-200 text-zinc-900')}>
          <Check size={10} strokeWidth={2.5} aria-hidden />
          {label}
        </span>
      );
    case 'sent':
      return (
        <span className={cn(filled, 'bg-zinc-200 text-zinc-900')}>{label}</span>
      );
    case 'declined':
      return (
        <span className="inline-flex items-center h-5 px-2 rounded-full text-11 font-normal whitespace-nowrap border-hairline border-zinc-300 text-ink-tertiary bg-white">
          {label}
        </span>
      );
    case 'draft':
    default:
      return (
        <span className="inline-flex items-center h-5 px-2 rounded-full text-11 font-normal whitespace-nowrap border-hairline border-zinc-300 text-ink-tertiary bg-white">
          {label}
        </span>
      );
  }
}

// Estimates v2 default sort (spec §7):
//   expired → viewed → sent → accepted/declined → drafts last
// Within a rank, tie-break by most-recent activity (updatedAt || createdAt).
const V3_STATUS_RANK = {
  expired: 0,
  viewed: 1,
  sent: 2,
  accepted: 3,
  declined: 3,
  draft: 4,
};

function v3SortFn(a, b) {
  const ra = V3_STATUS_RANK[a.status] ?? 5;
  const rb = V3_STATUS_RANK[b.status] ?? 5;
  if (ra !== rb) return ra - rb;
  const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
  return tb - ta;
}

// Estimates v2 filter chips (spec §7). Action Required = expired plus viewed
// sitting idle (viewed > 48h). Open = sent+viewed. Closed = accepted+declined.
const V3_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'action', label: 'Action Required' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'drafts', label: 'Drafts' },
];

function v3ChipMatches(e, chip) {
  if (chip === 'all') return true;
  if (chip === 'drafts') return e.status === 'draft';
  if (chip === 'open') return e.status === 'sent' || e.status === 'viewed';
  if (chip === 'closed') return e.status === 'accepted' || e.status === 'declined';
  if (chip === 'action') {
    if (e.status === 'expired') return true;
    if (e.status === 'viewed' && e.viewedAt) {
      const hrs = (Date.now() - new Date(e.viewedAt).getTime()) / 3.6e6;
      return hrs >= 48;
    }
    return false;
  }
  return true;
}

function v3ChipCounts(estimates) {
  const out = {};
  for (const c of V3_CHIPS) {
    out[c.key] = estimates.filter((e) => v3ChipMatches(e, c.key)).length;
  }
  return out;
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

// Filter — 7 pipeline filters exceed the 4-item pill cap. Per UI SoR §6.1
// "over 4" rule + §6.6, we collapse to a single FILTER pill that opens a
// bottom-anchored sheet on mobile (centered modal on desktop) listing every
// option with its live count. Active option marked with a trailing check.
function FilterSheetV2({ value, onChange, options, counts }) {
  const [open, setOpen] = useState(false);
  const active = options.find((o) => o.key === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Filter estimates. Current filter: ${active.label} (${counts[active.key] ?? 0})`}
        className={cn(
          'inline-flex items-center gap-2 h-11 sm:h-9 pl-4 pr-5 rounded-full',
          'text-12 font-medium uppercase tracking-label',
          'bg-zinc-900 text-white border-hairline border-zinc-900',
          'u-focus-ring hover:bg-zinc-800 transition-colors',
        )}
      >
        <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden />
        <span>Filter: {active.label} ({counts[active.key] ?? 0})</span>
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Filter estimates"
        >
          <div
            className="absolute inset-0 bg-zinc-900/40"
            onClick={() => setOpen(false)}
          />
          <div
            className={cn(
              'relative w-full bg-white outline-none',
              'rounded-t-md sm:rounded-md sm:max-w-md',
              'border-hairline border-zinc-200',
              'flex flex-col max-h-[85vh]',
            )}
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
          >
            {/* Drag handle (mobile only) */}
            <div className="pt-2 pb-1 sm:hidden">
              <div className="mx-auto w-10 h-1 rounded-full bg-zinc-300" />
            </div>

            <div className="px-5 py-3 flex items-center justify-between border-b border-hairline border-zinc-200">
              <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary">
                Filter estimates
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="h-9 w-9 flex items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-zinc-200 u-focus-ring"
              >
                <X size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {options.map((o) => {
                const isActive = o.key === value;
                return (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => {
                      onChange(o.key);
                      setOpen(false);
                    }}
                    className={cn(
                      'w-full flex items-center justify-between gap-3',
                      'px-5 py-4 text-left u-focus-ring',
                      'border-b border-hairline border-zinc-100 last:border-b-0',
                      isActive ? 'bg-zinc-50' : 'bg-white hover:bg-zinc-50',
                    )}
                  >
                    <span
                      className={cn(
                        'text-14 tracking-tight',
                        isActive ? 'font-medium text-zinc-900' : 'text-zinc-700',
                      )}
                    >
                      {o.label}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-12 u-nums text-ink-tertiary">
                        {counts[o.key] ?? 0}
                      </span>
                      {isActive && (
                        <Check size={16} strokeWidth={2} className="text-zinc-900" aria-hidden />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// Stat card — label, big value, sub. Single alert accent reserved for
// Follow-Up Overdue when > 0. Conversion% no longer color-codes; the
// number alone tells the story. Centered both axes per spec.
function StatCard({ label, value, sub, alert }) {
  return (
    <Card className="flex-1 min-w-[140px] p-4 min-h-[104px] flex flex-col items-center justify-center text-center">
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
  lead_webhook: { Icon: Globe, title: 'Website lead' },
  voice_agent: { Icon: Mic, title: 'Voice agent lead' },
  referral: { Icon: Users, title: 'Referral' },
  ai_agent: { Icon: Bot, title: 'AI agent draft — review before sending' },
};

function EstimatePipelineViewV2() {
  const v3Flag = useFeatureFlag('estimates_v2_status_pills');
  const navigate = useNavigate();
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [customerPanelId, setCustomerPanelId] = useState(null);
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

      {/* Filter — 7 options exceeds the 4-item pill cap, so FILTER button
          opens a bottom sheet on mobile / centered modal on desktop */}
      <div className="mb-4 flex justify-center sm:justify-start">
        <FilterSheetV2
          value={filter}
          onChange={setFilter}
          options={PIPELINE_FILTERS}
          counts={filterCounts}
        />
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

                {v3Flag
                  ? <StatusPillV3 status={e.status} />
                  : <StatusBadgeV2 status={e.status} />}

                {/* Customer info */}
                <div className="flex-1 min-w-[150px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    {e.customerId ? (
                      <button
                        type="button"
                        onClick={(evt) => { evt.stopPropagation(); setCustomerPanelId(e.customerId); }}
                        className="text-14 sm:text-14 font-medium text-zinc-900 bg-transparent border-0 p-0 cursor-pointer hover:underline"
                        title="Open customer + estimate history"
                      >
                        {e.customerName || 'Unknown'}
                      </button>
                    ) : (
                      <span className="text-14 sm:text-14 font-medium text-zinc-900">
                        {e.customerName || 'Unknown'}
                      </span>
                    )}
                    {source && (
                      <span title={source.title} className="inline-flex text-ink-tertiary">
                        <source.Icon size={14} strokeWidth={1.75} aria-hidden />
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
                  <div className="text-13 sm:text-12 text-ink-secondary mt-0.5 truncate">
                    {e.address || '—'}
                    {e.serviceInterest ? ` · ${e.serviceInterest}` : ''}
                  </div>
                </div>

                {/* Call + text + send-estimate trailing buttons — matches the
                    CustomersPageV2 list row's icon trio. Send is shown for
                    states where it's a real action (draft / sent / viewed);
                    accepted/declined/expired hide it. */}
                {(e.customerPhone || ['draft', 'sent', 'viewed'].includes(e.status)) && (
                  <div className="flex gap-1.5">
                    {e.customerPhone && (
                      <button
                        type="button"
                        onClick={async (evt) => {
                          evt.stopPropagation();
                          if (!window.confirm(`Call ${e.customerName || 'customer'} at ${e.customerPhone}?\n\nWaves will call your phone first — press 1 to connect.`)) return;
                          try {
                            const r = await adminFetch('/admin/communications/call', {
                              method: 'POST',
                              body: JSON.stringify({ to: e.customerPhone, fromNumber: '+19412975749' }),
                            });
                            if (!r?.success) alert('Call failed: ' + (r?.error || 'unknown error'));
                          } catch (err) { alert('Call failed: ' + err.message); }
                        }}
                        aria-label={`Call ${e.customerName || 'customer'} via Waves`}
                        title="Call via Waves — rings your phone first, press 1 to connect"
                        className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                      >
                        <Phone size={16} strokeWidth={1.75} />
                      </button>
                    )}
                    {e.customerPhone && (
                      <a
                        href={`/admin/communications?phone=${encodeURIComponent(e.customerPhone)}`}
                        onClick={(evt) => evt.stopPropagation()}
                        aria-label={`Message ${e.customerName || 'customer'}`}
                        title={`Message ${e.customerPhone}`}
                        className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                      >
                        <MessageSquare size={16} strokeWidth={1.75} />
                      </a>
                    )}
                    {/* Create-estimate icon — carries customer fields into the
                        new-estimate form via query string. Always shown when
                        we have a customerId so the operator can start a
                        follow-up quote without leaving the list. */}
                    {e.customerId && (
                      <button
                        type="button"
                        onClick={(evt) => {
                          evt.stopPropagation();
                          const params = new URLSearchParams();
                          if (e.address) params.set('address', e.address);
                          if (e.customerName) params.set('customerName', e.customerName);
                          if (e.customerPhone) params.set('customerPhone', e.customerPhone);
                          if (e.customerEmail) params.set('customerEmail', e.customerEmail);
                          navigate(`/admin/estimates?${params.toString()}`);
                        }}
                        aria-label={`Create new estimate for ${e.customerName || 'customer'}`}
                        title="Create a new estimate for this customer"
                        className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                      >
                        <FilePlus2 size={16} strokeWidth={1.75} />
                      </button>
                    )}
                    {['draft', 'sent', 'viewed'].includes(e.status) && (
                      <button
                        type="button"
                        onClick={async (evt) => {
                          evt.stopPropagation();
                          const action = e.status === 'draft' ? 'Send' : 'Resend';
                          if (!window.confirm(`${action} estimate to ${e.customerName || 'customer'} via SMS + email?`)) return;
                          await adminFetch(`/admin/estimates/${e.id}/send`, {
                            method: 'POST',
                            body: JSON.stringify({ sendMethod: 'both' }),
                          }).catch(() => {});
                          refreshEstimates();
                        }}
                        aria-label={`${e.status === 'draft' ? 'Send' : 'Resend'} estimate to ${e.customerName || 'customer'}`}
                        title={e.status === 'draft' ? 'Send estimate via SMS + email' : 'Resend estimate via SMS + email'}
                        className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                      >
                        <Send size={16} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                )}

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

                {/* Actions — flag is its own icon button; primary actions
                    render as an equal-width pill group (flex-1) to remove
                    dead space between pills. */}
                <div className="flex items-center gap-1.5 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={() => togglePriority(e)}
                    title={e.isPriority ? 'Remove priority' : 'Flag as urgent'}
                    aria-label={e.isPriority ? 'Remove priority' : 'Flag as urgent'}
                    className={cn(
                      'h-11 w-11 sm:h-7 sm:w-7 flex-shrink-0 flex items-center justify-center rounded-full sm:rounded-xs border-hairline u-focus-ring transition-colors',
                      e.isPriority
                        ? 'bg-alert-bg text-alert-fg border-alert-fg'
                        : 'bg-white text-ink-secondary border-zinc-300 hover:bg-zinc-50',
                    )}
                  >
                    <Flag size={16} strokeWidth={1.75} aria-hidden />
                  </button>

                  <div className="grid grid-cols-2 sm:flex sm:flex-none gap-1.5 flex-1">
                    {e.status === 'draft' && e.monthlyTotal > 0 && (
                      <Button
                        size="sm"
                        variant="primary"
                        className="w-full sm:w-auto rounded-full whitespace-nowrap"
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
                        className="w-full sm:w-auto rounded-full whitespace-nowrap"
                        onClick={() => setFollowUpTarget(e)}
                      >
                        Follow Up
                      </Button>
                    )}

                    {(e.status === 'sent' || e.status === 'viewed') && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="w-full sm:w-auto rounded-full whitespace-nowrap"
                        onClick={async () => {
                          if (!confirm(`Resend estimate to ${e.customerName || 'customer'} via SMS + email?`)) return;
                          await adminFetch(`/admin/estimates/${e.id}/send`, {
                            method: 'POST',
                            body: JSON.stringify({ sendMethod: 'both' }),
                          }).catch(() => {});
                          refreshEstimates();
                        }}
                      >
                        Resend
                      </Button>
                    )}

                    {(e.status === 'sent' || e.status === 'viewed') && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="w-full sm:w-auto rounded-full whitespace-nowrap"
                        onClick={() => setDeclineTarget(e)}
                      >
                        Mark Lost
                      </Button>
                    )}

                    {(e.status === 'sent' || e.status === 'viewed') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-full sm:w-auto rounded-full whitespace-nowrap"
                        onClick={() => {
                          const link = `${window.location.origin}/estimate/${e.token || e.id}`;
                          navigator.clipboard?.writeText(link);
                        }}
                      >
                        Copy Link
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {customerPanelId && (
        <CustomerEstimatesPanel
          customerId={customerPanelId}
          onClose={() => setCustomerPanelId(null)}
        />
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

// Mobile-only filter dimensions. FILTER reuses PIPELINE_FILTERS. DATE filters on
// createdAt relative to now. SORT controls row order; grouping is always by day.
const MOBILE_DATE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'last30', label: 'Last 30 days' },
];

const MOBILE_SORT_OPTIONS = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'amount-desc', label: 'Amount: high → low' },
  { key: 'amount-asc', label: 'Amount: low → high' },
];

function mobileMatchesDate(createdAt, dateKey, nowTs) {
  if (dateKey === 'all') return true;
  if (!createdAt) return false;
  const ts = new Date(createdAt).getTime();
  if (Number.isNaN(ts)) return false;
  if (dateKey === 'today') {
    return new Date(ts).toDateString() === new Date(nowTs).toDateString();
  }
  const MS_DAY = 86400000;
  if (dateKey === 'week') return nowTs - ts <= 7 * MS_DAY;
  if (dateKey === 'month' || dateKey === 'last30') return nowTs - ts <= 30 * MS_DAY;
  return true;
}

function mobileSortFn(sortKey) {
  switch (sortKey) {
    case 'oldest': return (a, b) => new Date(a.createdAt) - new Date(b.createdAt);
    case 'amount-desc': return (a, b) => (b.monthlyTotal || 0) - (a.monthlyTotal || 0);
    case 'amount-asc': return (a, b) => (a.monthlyTotal || 0) - (b.monthlyTotal || 0);
    case 'newest':
    default: return (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  }
}

// Short 6-char ref derived from UUID. estimates.id is a UUID (no human-readable
// sequence column exists yet); last-6 uppercased is a pragmatic display token.
function shortEstimateRef(id) {
  if (!id) return '—';
  return String(id).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
}

// Bottom-sheet single-select chip. Matches FilterSheetV2 pattern but chip
// visual is lighter (zinc-100 bg, label + bold value) to match the mockup.
function MobileChipSheet({ label, value, options, onChange, title }) {
  const [open, setOpen] = useState(false);
  const active = options.find((o) => o.key === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${active.label}`}
        className={cn(
          'inline-flex items-center gap-1.5 h-9 px-4 rounded-lg',
          'bg-zinc-100 border-hairline border-zinc-100',
          'text-13 text-zinc-600 u-focus-ring',
          'hover:bg-zinc-200 active:bg-zinc-200 whitespace-nowrap',
        )}
      >
        <span>{label}</span>
        <span className="font-medium text-zinc-900">{active.label}</span>
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <div className="absolute inset-0 bg-zinc-900/40" onClick={() => setOpen(false)} />
          <div
            className={cn(
              'relative w-full bg-white outline-none',
              'rounded-t-md sm:rounded-md sm:max-w-md',
              'border-hairline border-zinc-200',
              'flex flex-col max-h-[85vh]',
            )}
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
          >
            <div className="pt-2 pb-1 sm:hidden">
              <div className="mx-auto w-10 h-1 rounded-full bg-zinc-300" />
            </div>
            <div className="px-5 py-3 flex items-center justify-between border-b border-hairline border-zinc-200">
              <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary">
                {title}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="h-9 w-9 flex items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-zinc-200 u-focus-ring"
              >
                <X size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {options.map((o) => {
                const isActive = o.key === value;
                return (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => { onChange(o.key); setOpen(false); }}
                    className={cn(
                      'w-full flex items-center justify-between gap-3',
                      'px-5 py-4 text-left u-focus-ring',
                      'border-b border-hairline border-zinc-100 last:border-b-0',
                      isActive ? 'bg-zinc-50' : 'bg-white hover:bg-zinc-50',
                    )}
                  >
                    <span
                      className={cn(
                        'text-14 tracking-tight',
                        isActive ? 'font-medium text-zinc-900' : 'text-zinc-700',
                      )}
                    >
                      {o.label}
                    </span>
                    {isActive && (
                      <Check size={16} strokeWidth={2} className="text-zinc-900" aria-hidden />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// Status label color on mobile row. Draft = waves blue, alert = red,
// accepted = zinc-900, others fall back to ink-tertiary for low emphasis.
function mobileStatusClass(status) {
  if (status === 'declined' || status === 'expired') return 'text-alert-fg';
  if (status === 'accepted') return 'text-zinc-900';
  if (status === 'draft' || status === 'sent' || status === 'viewed') return 'text-waves-blue';
  return 'text-ink-tertiary';
}

// Row in the mobile list. Mirrors CustomersPageV2 directory row: 64px white
// bordered card, name + sub left, trailing Call / Text actions when phone is
// present. Row tap is currently a no-op — action sheet will land in a
// follow-up PR so this PR stays scoped to the list-view redesign per
// CLAUDE.md Rule 1/2.
function MobileEstimateRow({ estimate, onCreateFromAddress, onOpenCustomerPanel, onSend, v3Flag = false }) {
  const navigate = useNavigate();
  const cfg = STATUS_CONFIG[estimate.status] || STATUS_CONFIG.draft;
  const amount = `$${(estimate.monthlyTotal || 0).toFixed(0)}/mo`;
  const customerName = estimate.customerName || 'Unknown';
  const isDraftMuted = v3Flag && estimate.status === 'draft';
  const openPanel = () => { if (estimate.customerId) onOpenCustomerPanel?.(estimate.customerId); };
  return (
    <div
      onClick={openPanel}
      className={cn(
        'bg-white border-hairline border-zinc-200 rounded-sm px-3 flex items-center gap-1.5 cursor-pointer hover:bg-zinc-50',
        isDraftMuted && 'opacity-60',
      )}
      style={{ height: 64 }}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {estimate.customerId ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openPanel(); }}
            className="text-14 font-medium text-ink-primary truncate text-left bg-transparent border-0 p-0 cursor-pointer hover:underline"
          >
            {customerName}
          </button>
        ) : (
          <div className="text-14 font-medium text-ink-primary truncate">{customerName}</div>
        )}
        {v3Flag ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="u-nums text-11 text-ink-tertiary">{amount}</span>
            <StatusPillV3 status={estimate.status} />
            <span className="u-nums text-11 text-ink-tertiary">#{shortEstimateRef(estimate.id)}</span>
          </div>
        ) : (
          <div className="text-11 text-ink-tertiary truncate">
            <span className="u-nums">{amount}</span>
            <span className={cn('ml-2 font-medium', mobileStatusClass(estimate.status))}>
              {cfg.label}
            </span>
            <span className="ml-2 u-nums">#{shortEstimateRef(estimate.id)}</span>
          </div>
        )}
      </div>
      {estimate.customerPhone && (
        <button
          type="button"
          onClick={async (e) => {
            e.stopPropagation();
            if (!window.confirm(`Call ${estimate.customerName || 'customer'} at ${estimate.customerPhone}?\n\nWaves will call your phone first — press 1 to connect.`)) return;
            try {
              const r = await adminFetch('/admin/communications/call', {
                method: 'POST',
                body: JSON.stringify({ to: estimate.customerPhone, fromNumber: '+19412975749' }),
              });
              if (!r?.success) alert('Call failed: ' + (r?.error || 'unknown error'));
            } catch (err) { alert('Call failed: ' + err.message); }
          }}
          aria-label="Call via Waves"
          title="Call via Waves — rings your phone first, press 1 to connect"
          className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
        >
          <Phone size={16} strokeWidth={1.75} />
        </button>
      )}
      {estimate.customerPhone && (
        <a
          href={`/admin/communications?phone=${encodeURIComponent(estimate.customerPhone)}`}
          onClick={(e) => e.stopPropagation()}
          aria-label="SMS"
          className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
        >
          <MessageSquare size={16} strokeWidth={1.75} />
        </a>
      )}
      {estimate.customerId && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const params = new URLSearchParams();
            if (estimate.address) params.set('address', estimate.address);
            if (estimate.customerName) params.set('customerName', estimate.customerName);
            if (estimate.customerPhone) params.set('customerPhone', estimate.customerPhone);
            if (estimate.customerEmail) params.set('customerEmail', estimate.customerEmail);
            navigate(`/admin/estimates?${params.toString()}`);
          }}
          aria-label={`Create new estimate for ${customerName}`}
          title="Create a new estimate for this customer"
          className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
        >
          <FilePlus2 size={16} strokeWidth={1.75} />
        </button>
      )}
      {['draft', 'sent', 'viewed'].includes(estimate.status) && (
        <button
          type="button"
          onClick={async (e) => {
            e.stopPropagation();
            const action = estimate.status === 'draft' ? 'Send' : 'Resend';
            if (!window.confirm(`${action} estimate to ${customerName} via SMS + email?`)) return;
            await adminFetch(`/admin/estimates/${estimate.id}/send`, {
              method: 'POST',
              body: JSON.stringify({ sendMethod: 'both' }),
            }).catch(() => {});
            onSend?.();
          }}
          aria-label={`${estimate.status === 'draft' ? 'Send' : 'Resend'} estimate`}
          title={estimate.status === 'draft' ? 'Send estimate via SMS + email' : 'Resend estimate via SMS + email'}
          className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
        >
          <Send size={16} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

// Mobile list view for /admin/estimates. Strict 1:1 on data + endpoint
// (GET /admin/estimates) with EstimatePipelineViewV2. KPI bar, Leads tab,
// and Pricing Logic tab are desktop-only by design.
function EstimatesMobileListView({ onNew, onCreateFromAddress }) {
  const v3Flag = useFeatureFlag('estimates_v2_status_pills');
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [customerPanelId, setCustomerPanelId] = useState(null);
  // Spec §7 default sort is the v3 status-rank; keep the old newest/oldest
  // options available when the flag is off.
  const [sort, setSort] = useState(v3Flag ? 'v3' : 'newest');

  const refreshEstimates = useCallback(() => {
    adminFetch('/admin/estimates')
      .then((d) => setEstimates(d.estimates || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    adminFetch('/admin/estimates')
      .then((d) => { setEstimates(d.estimates || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const groups = useMemo(() => {
    const now = Date.now();
    const q = search.trim().toLowerCase();
    const classified = estimates.map((e) => ({ ...e, _class: classifyEstimate(e) }));
    let list = classified;
    if (v3Flag) {
      list = list.filter((e) => v3ChipMatches(e, filter));
    } else if (filter !== 'all') {
      list = list.filter((e) => e._class === filter);
    }
    if (dateFilter !== 'all') {
      list = list.filter((e) => mobileMatchesDate(e.createdAt, dateFilter, now));
    }
    if (q) {
      list = list.filter((e) => {
        const name = (e.customerName || '').toLowerCase();
        const ref = shortEstimateRef(e.id).toLowerCase();
        return name.includes(q) || ref.includes(q);
      });
    }
    const useV3Sort = v3Flag && sort === 'v3';
    list = useV3Sort ? [...list].sort(v3SortFn) : [...list].sort(mobileSortFn(sort));

    // v3 sort breaks day-grouping (status rank wins, not date), so collapse
    // to a single group preserving the sorted order.
    if (useV3Sort) return [[0, list]];

    // Otherwise group by createdAt day; sort=oldest reverses group order.
    const byDay = new Map();
    for (const e of list) {
      const d = e.createdAt ? new Date(e.createdAt) : null;
      const key = d && !Number.isNaN(d.getTime())
        ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
        : 0;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    const sortedGroups = Array.from(byDay.entries()).sort((a, b) =>
      sort === 'oldest' ? a[0] - b[0] : b[0] - a[0],
    );
    return sortedGroups;
  }, [estimates, search, filter, dateFilter, sort, v3Flag]);

  const filterCounts = useMemo(() => {
    if (v3Flag) return v3ChipCounts(estimates);
    const counts = { all: estimates.length };
    for (const f of PIPELINE_FILTERS) {
      if (f.key === 'all') continue;
      counts[f.key] = estimates.filter((e) => classifyEstimate(e) === f.key).length;
    }
    return counts;
  }, [estimates, v3Flag]);

  // Reset filter + default sort when the v3 flag flips (flags load async
  // after initial render; useState seed can't see the resolved value).
  useEffect(() => {
    setFilter('all');
    if (v3Flag) setSort((s) => (s === 'newest' ? 'v3' : s));
    else setSort((s) => (s === 'v3' ? 'newest' : s));
  }, [v3Flag]);

  // Flat list across all days — mirrors CustomersPageV2 directory layout.
  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups]);

  return (
    // Mirrors CustomersPageV2: page padding comes from AdminLayout, no
    // edge-to-edge overrides, list rows are cards (not hairlined rows).
    <div>
      {/* Title row — matches Customers header: h1 + round FAB when v3 flag on. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <h1 className="text-28 font-normal tracking-h1 text-ink-primary">
          Estimates
        </h1>
        <button
          type="button"
          onClick={onNew}
          aria-label="Add estimate"
          className="flex items-center justify-center rounded-full bg-zinc-900 text-white u-focus-ring hover:bg-zinc-800"
          style={{ width: 36, height: 36 }}
        >
          <Plus size={20} strokeWidth={2} />
        </button>
      </div>

      {/* Search + Add/filter row — mirrors Customers mobile block. */}
      <div className="mb-3">
        <input
          type="search"
          inputMode="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by customer name or reference"
          aria-label="Search estimates"
          className="block w-full bg-white text-14 text-ink-primary border-hairline border-zinc-300 rounded-sm h-12 px-4 focus:outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900"
        />
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <MobileChipSheet
            label="Filter"
            value={filter}
            onChange={setFilter}
            options={(v3Flag ? V3_CHIPS : PIPELINE_FILTERS).map((f) => ({
              ...f,
              label: f.key === 'all'
                ? `All (${filterCounts.all || 0})`
                : `${f.label} (${filterCounts[f.key] || 0})`,
            }))}
            title="Filter estimates"
          />
          <MobileChipSheet
            label="Date"
            value={dateFilter}
            onChange={setDateFilter}
            options={MOBILE_DATE_FILTERS}
            title="Filter by date"
          />
          <MobileChipSheet
            label="Sort"
            value={sort}
            onChange={setSort}
            options={v3Flag
              ? [{ key: 'v3', label: 'Action Priority' }, ...MOBILE_SORT_OPTIONS]
              : MOBILE_SORT_OPTIONS}
            title="Sort estimates"
          />
        </div>
      </div>

      {/* Result count — mirrors Customers */}
      <div className="u-nums text-11 text-ink-tertiary text-right mb-3 mt-3">
        {flat.length} result{flat.length !== 1 ? 's' : ''}
      </div>

      {/* List */}
      {loading ? (
        <div className="p-10 text-center text-13 text-ink-secondary">
          Loading estimates…
        </div>
      ) : flat.length === 0 ? (
        <Card>
          <CardBody className="p-12 text-center">
            <div className="text-14 text-ink-primary mb-1">
              {estimates.length === 0 ? 'No estimates yet' : 'No estimates found'}
            </div>
            <div className="text-13 text-ink-tertiary">
              {estimates.length === 0
                ? 'Tap Add Estimate to create one'
                : 'Try adjusting your filters'}
            </div>
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {flat.map((e) => (
            <MobileEstimateRow
              key={e.id}
              estimate={e}
              onCreateFromAddress={onCreateFromAddress}
              onOpenCustomerPanel={setCustomerPanelId}
              onSend={refreshEstimates}
              v3Flag={v3Flag}
            />
          ))}
        </div>
      )}

      {customerPanelId && (
        <CustomerEstimatesPanel
          customerId={customerPanelId}
          onClose={() => setCustomerPanelId(null)}
        />
      )}
    </div>
  );
}

export default function EstimatesPageV2() {
  const isMobile = useIsMobile(768);
  const [searchParams, setSearchParams] = useSearchParams();

  // Prefill from URL params — populated when arriving from a Customer/Lead
  // row's "+ Estimate" quick action. Stays in state so consuming the params
  // (clearing the URL) doesn't blow away the wizard the user just landed on.
  const [prefill, setPrefill] = useState(() => ({
    address: searchParams.get('address') || '',
    customerName: searchParams.get('customerName') || '',
    customerPhone: searchParams.get('customerPhone') || '',
    customerEmail: searchParams.get('customerEmail') || '',
  }));
  const hasPrefill = !!(prefill.address || prefill.customerName || prefill.customerPhone || prefill.customerEmail);

  const [activeTab, setActiveTab] = useState(hasPrefill ? 'new' : 'leads');
  const [mobileView, setMobileView] = useState(hasPrefill ? 'new' : 'list'); // 'list' | 'new'

  // Strip prefill keys from the URL once we've captured them so a refresh
  // doesn't repeatedly snap the user into the create flow.
  useEffect(() => {
    if (!hasPrefill) return;
    const next = new URLSearchParams(searchParams);
    let changed = false;
    ['address', 'customerName', 'customerPhone', 'customerEmail'].forEach((k) => {
      if (next.has(k)) { next.delete(k); changed = true; }
    });
    if (changed) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearPrefill() {
    setPrefill({ address: '', customerName: '', customerPhone: '', customerEmail: '' });
  }

  // Mobile: list (default) + create-estimate flow. Leads + Pricing Logic are
  // desktop-only per CLAUDE.md Rule 1 (mobile IA scope confirmed with owner).
  if (isMobile) {
    if (mobileView === 'new') {
      return (
        <div>
          <button
            type="button"
            onClick={() => { setMobileView('list'); clearPrefill(); }}
            aria-label="Back to estimates"
            className="inline-flex items-center gap-1 mb-3 h-9 px-2 -ml-2 rounded-md text-14 text-zinc-700 hover:bg-zinc-100 u-focus-ring"
          >
            <ArrowLeft size={18} strokeWidth={1.75} aria-hidden />
            Back
          </button>
          <EstimateToolViewV2
            initialAddress={prefill.address}
            initialCustomerName={prefill.customerName}
            initialCustomerPhone={prefill.customerPhone}
            initialCustomerEmail={prefill.customerEmail}
          />
        </div>
      );
    }
    return (
      <EstimatesMobileListView
        onNew={() => { clearPrefill(); setMobileView('new'); }}
        onCreateFromAddress={(addr) => {
          setPrefill({ address: addr || '', customerName: '', customerPhone: '', customerEmail: '' });
          setMobileView('new');
        }}
      />
    );
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-28 font-normal text-zinc-900 tracking-display">
          Pipeline
        </h1>
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          marginBottom: 24,
          background: '#F4F4F5',
          borderRadius: 10,
          padding: 4,
          border: '1px solid #E4E4E7',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '10px 24px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              background: activeTab === t.key ? '#18181B' : 'transparent',
              color: activeTab === t.key ? '#FFFFFF' : '#A1A1AA',
              fontSize: 14,
              fontWeight: 700,
              transition: 'all 0.2s',
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'leads' && <LeadsSection />}
      {activeTab === 'estimates' && <EstimatePipelineViewV2 />}
      {activeTab === 'new' && (
        <EstimateToolViewV2
          initialAddress={prefill.address}
          initialCustomerName={prefill.customerName}
          initialCustomerPhone={prefill.customerPhone}
          initialCustomerEmail={prefill.customerEmail}
        />
      )}
      {activeTab === 'pricing' && (
        <>
          <MarginCalculator />
          <PricingLogicPanel />
        </>
      )}
    </div>
  );
}
