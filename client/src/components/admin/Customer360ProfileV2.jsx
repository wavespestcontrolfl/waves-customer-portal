/**
 * Customer360ProfileV2.jsx
 * client/src/components/admin/Customer360ProfileV2.jsx
 *
 * Monochrome rewrite of Customer360Profile (PR #4c).
 * Strict 1:1 with V1 on:
 *   - endpoints (GET /admin/customers/:id, /timeline, /autopay-state;
 *     POST /admin/communications/send-sms, /admin/customers/:id/refund,
 *     /admin/customers/:id/charge-now)
 *   - state (data, loading, activeTab, timelineFilter, smsReply, sendingSms)
 *   - tabs (overview / services / billing / comms / property / compliance)
 *   - slide-out overlay structure + ESC handler
 *   - mobile sticky-bottom CustomerActionBar (standalone)
 *
 * Visual changes vs V1:
 *   - Tailwind zinc ramp + components/ui primitives (Card, Badge, Button)
 *   - Hairline borders, no colored tinted backgrounds
 *   - alert-fg reserved for: overdue balance, expiring card, refund/failed
 *     payments, at_risk/churned stage, health score < 40
 *   - Tier collapses to neutral Badge (no purple/gold/teal)
 *   - HealthCircle/RadarChart recolored to zinc; alert tier only when low
 *
 * Audit focus:
 * - Six tabs each fetch their own data on mount/switch — confirm we
 *   don't re-fetch on every re-render (useEffect deps), and that
 *   switching tabs back doesn't re-flicker if data is already cached
 *   in component state.
 * - Slide-out lifecycle: ESC handler should detach on unmount, clicks
 *   on the overlay should close cleanly, focus should return to the
 *   row that opened the panel.
 * - SMS reply submit (POST /communications/send-sms): must be
 *   debounced or single-flight so a double-click doesn't double-send.
 *   Also: empty / whitespace-only message should not submit.
 * - Refund / charge-now (POST /:id/refund, /:id/charge-now): these
 *   are real money operations. Confirm they require explicit
 *   confirmation before fire and that error states surface clearly
 *   (e.g. Stripe declined → not silently swallowed).
 * - alert-fg coverage: the spec reserves red for overdue balance,
 *   expiring card, refund/failed payments, at_risk/churned stage,
 *   health < 40. Verify nothing else in the V2 paint accidentally
 *   uses alert-fg as decoration.
 * - Mobile sticky CustomerActionBar: when an action sheet opens
 *   (call, SMS, follow-up), confirm the ActionBar doesn't double-
 *   stack with the underlying sheet's own buttons.
 * - Timeline filter: SMS / calls / notes filter on the timeline tab.
 *   Switching filter should clear stale rows / not mix categories.
 */

import { useState, useEffect, useRef } from 'react';
import { ChevronLeft, MoreHorizontal, Trash2 } from 'lucide-react';
import { CustomerActionBar } from './StickyActionBar';
import { Card, CardBody, Badge, Button, Switch, Table, THead, TBody, TR, TH, TD, cn } from '../ui';
import CallBridgeLink, { callViaBridge } from './CallBridgeLink';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const mins = Math.floor((Date.now() - new Date(dateStr)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtCurrency(v) { return '$' + parseFloat(v || 0).toFixed(2); }

const STAGE_LABELS = {
  new_lead: 'New Lead', contacted: 'Contacted', estimate_sent: 'Est. Sent',
  estimate_viewed: 'Est. Viewed', follow_up: 'Follow Up', won: 'Won',
  active_customer: 'Active', at_risk: 'At Risk', churned: 'Churned',
  lost: 'Lost', dormant: 'Dormant',
};

// ─── Health Score Circle (monochrome) ────────────────────────────
function HealthCircle({ score }) {
  if (score == null) return null;
  const stroke = score >= 70 ? '#10B981' : score >= 40 ? '#F59E0B' : '#C8312F';
  const r = 18, circ = 2 * Math.PI * r, offset = circ - (score / 100) * circ;
  return (
    <svg width={44} height={44} viewBox="0 0 44 44" className="flex-shrink-0">
      <circle cx={22} cy={22} r={r} fill="none" stroke="#E4E4E7" strokeWidth={3} />
      <circle cx={22} cy={22} r={r} fill="none" stroke={stroke} strokeWidth={3}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        transform="rotate(-90 22 22)" />
      <text x={22} y={26} textAnchor="middle" fill={stroke} fontSize={12} fontWeight={500}
        className="u-nums" fontFamily="ui-monospace, monospace">{score}</text>
    </svg>
  );
}

// ─── Radar Chart (monochrome) ────────────────────────────────────
function RadarChart({ data }) {
  if (!data || data.length < 3) return null;
  const size = 160, cx = size / 2, cy = size / 2, maxR = 60;
  const n = data.length;
  const angleStep = (2 * Math.PI) / n;
  const pointAt = (i, pct) => {
    const a = -Math.PI / 2 + i * angleStep;
    return [cx + maxR * (pct / 100) * Math.cos(a), cy + maxR * (pct / 100) * Math.sin(a)];
  };
  const gridLevels = [25, 50, 75, 100];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block mx-auto">
      {gridLevels.map(lv => (
        <polygon key={lv} points={data.map((_, i) => pointAt(i, lv).join(',')).join(' ')}
          fill="none" stroke="#E4E4E7" strokeWidth={0.5} />
      ))}
      {data.map((_, i) => {
        const [x, y] = pointAt(i, 100);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#E4E4E7" strokeWidth={0.5} />;
      })}
      <polygon points={data.map((d, i) => pointAt(i, d.value).join(',')).join(' ')}
        fill="rgba(24,24,27,0.10)" stroke="#18181B" strokeWidth={1.25} />
      {data.map((d, i) => {
        const [x, y] = pointAt(i, 115);
        return <text key={i} x={x} y={y} textAnchor="middle" fill="#71717A" fontSize={9}>{d.label}</text>;
      })}
    </svg>
  );
}

// ─── Tier badge (color-coded per metal) ─────────────────────────
const TIER_STYLES = {
  Platinum: { backgroundColor: '#E5E7EB', color: '#1F2937' },
  Gold:     { backgroundColor: '#D4A017', color: '#FFFFFF' },
  Silver:   { backgroundColor: '#9CA3AF', color: '#FFFFFF' },
  Bronze:   { backgroundColor: '#A16207', color: '#FFFFFF' },
};
function TierBadgeV2({ tier }) {
  if (!tier) return <Badge tone="neutral">No Plan</Badge>;
  const style = TIER_STYLES[tier];
  if (!style) return <Badge tone="neutral">{tier}</Badge>;
  return <Badge tone="neutral" style={style}>{tier}</Badge>;
}

// ─── Stage badge — green for active customers, red for everything else ───
function StageBadgeV2({ stage }) {
  const label = STAGE_LABELS[stage] || stage;
  const isActive = stage === 'active_customer' || stage === 'won';
  const style = isActive
    ? { backgroundColor: '#10B981', color: '#FFFFFF' }
    : { backgroundColor: '#C8312F', color: '#FFFFFF' };
  return <Badge tone="neutral" style={style}>{label}</Badge>;
}

// ─── Section title ───────────────────────────────────────────────
function SectionTitle({ children, className }) {
  return (
    <div className={cn('u-label text-ink-secondary mb-2', className)}>
      {children}
    </div>
  );
}

// ─── Stat card (alert color only for overdue balances) ───────────
function StatCardV2({ label, value, alert }) {
  return (
    <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-3 text-center">
      <div className="u-label text-ink-secondary mb-1">{label}</div>
      <div className={cn(
        'u-nums text-16 font-medium tracking-tight',
        alert ? 'text-alert-fg' : 'text-zinc-900'
      )}>{value}</div>
    </div>
  );
}

// ─── Service row (collapsible) ───────────────────────────────────
function ServiceRowV2({ service: s }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm overflow-hidden mb-1.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex justify-between items-center px-3.5 py-2.5 text-13 u-focus-ring hover:bg-zinc-100 transition-colors"
      >
        <span className="font-medium text-zinc-900 text-left">{s.service_type}</span>
        <span className="flex items-center gap-3">
          {s.total_cost > 0 && <span className="u-nums text-zinc-900">{fmtCurrency(s.total_cost)}</span>}
          <span className="text-ink-secondary">{fmtDate(s.service_date)}</span>
          <span
            className="text-ink-secondary text-12 transition-transform"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          >▾</span>
        </span>
      </button>
      {expanded && (
        <div className="px-3.5 py-2.5 border-t border-hairline border-zinc-200 text-12 space-y-1">
          {s.notes && <div className="text-zinc-900">{s.notes}</div>}
          {s.products_used && <div className="text-ink-secondary">Products: {s.products_used}</div>}
          {s.areas_treated && <div className="text-ink-secondary">Areas: {s.areas_treated}</div>}
          {s.technician_name && <div className="text-ink-secondary">Tech: {s.technician_name}</div>}
          {!s.notes && !s.products_used && !s.areas_treated && (
            <div className="text-ink-secondary">No additional details</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Autopay panel ───────────────────────────────────────────────
function AdminAutopayPanelV2({ customerId, monthlyRate, customerName }) {
  const [state, setState] = useState(null);
  const [charging, setCharging] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => {
    fetch(`${API_BASE}/admin/customers/${customerId}/autopay-state`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => setState(d))
      .catch(() => {});
  };

  useEffect(() => { load(); }, [customerId]);

  const chargeNow = async () => {
    const amt = parseFloat(monthlyRate || 0);
    if (!amt || amt <= 0) { setErr('Customer has no monthly_rate set'); return; }
    if (!window.confirm(`Charge ${customerName} $${amt.toFixed(2)} now?`)) return;
    setCharging(true); setErr(''); setMsg('');
    try {
      await adminFetch(`/admin/customers/${customerId}/charge-now`, {
        method: 'POST', body: JSON.stringify({}),
      });
      setMsg(`Charged $${amt.toFixed(2)} successfully`);
      load();
    } catch (e) { setErr(e.message || 'Charge failed'); }
    setCharging(false);
  };

  const stateLabel = state?.state || 'unknown';
  const isAlertState = stateLabel === 'paused' || stateLabel === 'failed';

  return (
    <Card className="mb-5">
      <CardBody className="p-4">
        <div className="flex justify-between items-start gap-3 flex-wrap">
          <div>
            <div className="u-label text-ink-secondary mb-1">Auto-pay</div>
            <div className="flex items-center gap-2">
              <span className={cn(
                'w-2 h-2 rounded-full inline-block',
                isAlertState ? 'bg-alert-fg' : stateLabel === 'active' ? 'bg-zinc-900' : 'bg-zinc-400'
              )} />
              <span className="text-14 font-medium text-zinc-900 capitalize">{stateLabel}</span>
            </div>
            {state && (
              <div className="text-12 text-ink-secondary mt-1.5 leading-relaxed">
                Next charge: <span className="u-nums text-zinc-900">{state.next_charge_date || '—'}</span>
                {' · '}Day: <span className="u-nums text-zinc-900">{state.billing_day || 1}</span>
                {state.paused_until && <>{' · '}Paused until {fmtDate(state.paused_until)}</>}
              </div>
            )}
          </div>
          <Button onClick={chargeNow} disabled={charging} size="md">
            {charging ? 'Charging…' : `Charge now${monthlyRate ? ` ($${parseFloat(monthlyRate).toFixed(2)})` : ''}`}
          </Button>
        </div>
        {msg && <div className="mt-2.5 px-2 py-1.5 bg-zinc-100 text-zinc-900 rounded-xs text-12">{msg}</div>}
        {err && <div className="mt-2.5 px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">{err}</div>}
        {state?.recent_events?.length > 0 && (
          <div className="mt-3 border-t border-hairline border-zinc-200 pt-2.5">
            <div className="u-label text-ink-secondary mb-1.5">Recent events</div>
            {state.recent_events.slice(0, 5).map(ev => (
              <div key={ev.id} className="text-11 text-ink-secondary py-0.5 flex justify-between gap-2">
                <span className="u-nums text-zinc-900">{ev.event_type}</span>
                <span>{ev.amount_cents != null ? `$${(ev.amount_cents / 100).toFixed(2)}` : ''}</span>
                <span>{timeAgo(ev.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export default function Customer360ProfileV2({ customerId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [timelineFilter, setTimelineFilter] = useState('all');
  const [timeline, setTimeline] = useState([]);
  const [comms, setComms] = useState([]);
  const [smsReply, setSmsReply] = useState('');
  const [sendingSms, setSendingSms] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErr, setEditErr] = useState('');
  const [deletingCustomer, setDeletingCustomer] = useState(false);
  const panelRef = useRef(null);
  const menuRef = useRef(null);

  const reloadCustomer = () =>
    adminFetch(`/admin/customers/${customerId}`).then(setData).catch(() => {});

  useEffect(() => {
    setLoading(true);
    Promise.all([
      adminFetch(`/admin/customers/${customerId}`),
      adminFetch(`/admin/customers/${customerId}/timeline`).catch(() => ({ timeline: [] })),
      adminFetch(`/admin/customers/${customerId}/comms`).catch(() => ({ comms: [] })),
    ]).then(([detail, tl, cm]) => {
      setData(detail);
      setTimeline(tl.timeline || []);
      setComms(cm.comms || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [customerId]);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [menuOpen]);

  if (loading) return (
    <div className="fixed inset-0 bg-black/70 z-[1000] flex justify-end" onClick={onClose}>
      <div className="c360-panel bg-white w-full max-w-[900px] h-screen flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="text-ink-secondary text-center py-16 text-13">Loading customer profile…</div>
      </div>
    </div>
  );

  if (!data || !data.customer) return (
    <div className="fixed inset-0 bg-black/70 z-[1000] flex justify-end" onClick={onClose}>
      <div className="c360-panel bg-white w-full max-w-[900px] h-screen flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="text-alert-fg text-center py-16 text-13">Failed to load customer</div>
      </div>
    </div>
  );

  const c = data.customer;
  const prefs = data.preferences || {};
  const hs = data.healthScore || {};
  const score = hs.health_score ?? hs.score ?? null;
  const invoices = data.invoices || [];
  const cards = data.cards || [];
  const photos = data.photos || [];
  const referral = data.referralInfo;
  const discounts = data.customerDiscounts || [];
  const compliance = data.complianceRecords || [];
  const services = data.services || [];
  const payments = data.payments || [];
  const scheduled = data.scheduled || [];

  const balanceOwed = invoices.filter(i => i.status !== 'paid')
    .reduce((s, i) => s + parseFloat(i.amount_due || 0) - parseFloat(i.amount_paid || 0), 0);
  const lastPayment = payments[0];
  const nextService = scheduled.find(s => s.status !== 'cancelled' && s.status !== 'completed' && new Date(s.scheduled_date) >= new Date());

  const expiringCard = cards.find(cd => {
    if (!cd.exp_month || !cd.exp_year) return false;
    const exp = new Date(cd.exp_year, cd.exp_month, 0);
    const diff = (exp - new Date()) / 86400000;
    return diff < 60 && diff > -30;
  });

  // Alerts — alert-fg only for $/card, otherwise neutral
  const alerts = [];
  if (prefs.pet_details) alerts.push({ alert: false, label: 'PET', text: `Pet: ${prefs.pet_details}` });
  if (prefs.property_gate_code) alerts.push({ alert: false, label: 'GATE', text: `Property gate: ${prefs.property_gate_code}` });
  if (prefs.neighborhood_gate_code) alerts.push({ alert: false, label: 'GATE', text: `Neighborhood gate: ${prefs.neighborhood_gate_code}` });
  if (balanceOwed > 0) alerts.push({ alert: true, label: '$', text: `Overdue balance: ${fmtCurrency(balanceOwed)}` });
  if (expiringCard) alerts.push({ alert: true, label: 'CARD', text: `Card ending ${expiringCard.last_four} expiring ${expiringCard.exp_month}/${expiringCard.exp_year}` });
  if (prefs.chemical_sensitivities) alerts.push({ alert: false, label: 'CHEM', text: `Chemical sensitivity: ${prefs.chemical_sensitivities}` });
  if (prefs.special_instructions) alerts.push({ alert: false, label: 'NOTE', text: prefs.special_instructions });

  const filteredTimeline = timelineFilter === 'all' ? timeline
    : timeline.filter(t => t.type === timelineFilter || (timelineFilter === 'notes' && t.type === 'interaction'));

  const radarData = hs.risk_factors ? [
    { label: 'Payment', value: 80 }, { label: 'Engagement', value: 60 },
    { label: 'Service', value: 70 }, { label: 'Satisfaction', value: 75 },
    { label: 'Tenure', value: 90 }, { label: 'Revenue', value: 65 },
  ] : [
    { label: 'Payment', value: score ? Math.min(score + 10, 100) : 50 },
    { label: 'Engagement', value: score || 50 },
    { label: 'Service', value: score ? Math.min(score + 5, 100) : 50 },
    { label: 'Satisfaction', value: score ? Math.max(score - 5, 0) : 50 },
    { label: 'Tenure', value: c.memberSince ? Math.min(Math.floor((Date.now() - new Date(c.memberSince)) / 86400000 / 3.65), 100) : 50 },
    { label: 'Revenue', value: c.lifetimeRevenue > 0 ? Math.min(Math.floor(c.lifetimeRevenue / 50), 100) : 20 },
  ];

  const sendSms = async () => {
    if (!smsReply.trim() || !c.phone) return;
    setSendingSms(true);
    try {
      await adminFetch('/admin/communications/send-sms', { method: 'POST', body: JSON.stringify({ to: c.phone, message: smsReply }) });
      setSmsReply('');
      const [fresh, freshComms] = await Promise.all([
        adminFetch(`/admin/customers/${customerId}`),
        adminFetch(`/admin/customers/${customerId}/comms`).catch(() => ({ comms: [] })),
      ]);
      setData(fresh);
      setComms(freshComms.comms || []);
    } catch { /* ignore */ }
    setSendingSms(false);
  };

  const fmtDur = (s) => {
    if (!s && s !== 0) return null;
    const mins = Math.floor(s / 60), secs = s % 60;
    return mins ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'services', label: 'Services' },
    { key: 'billing', label: 'Billing' },
    { key: 'comms', label: 'Comms' },
    { key: 'property', label: 'Property' },
    { key: 'compliance', label: 'Compliance' },
  ];

  return (
    <div className="fixed inset-0 bg-black/70 z-[1000] flex justify-end font-sans" onClick={onClose}>
      <div ref={panelRef} onClick={e => e.stopPropagation()}
        className="c360-panel bg-white w-full max-w-[900px] h-screen flex flex-col overflow-y-auto text-zinc-900">
        <style>{`
          @media (max-width: 768px) {
            .c360-overview-grid { grid-template-columns: 1fr !important; }
            .c360-billing-grid { grid-template-columns: 1fr 1fr !important; }
            .c360-property-grid { grid-template-columns: 1fr !important; }
            .c360-panel { width: 100% !important; max-width: 100% !important; }
            .c360-header-desktop { display: none !important; }
            .c360-header-mobile { display: block !important; }
            .c360-mobile-footer-spacer { display: block !important; }
          }
          .c360-header-mobile { display: none; }
          .c360-mobile-footer-spacer { display: none; }
        `}</style>

        {/* ZONE 1 — STICKY HEADER */}
        <div className="sticky top-0 z-10 bg-white border-b border-hairline border-zinc-200">
          {/* Desktop header (>= 768px) */}
          <div className="c360-header-desktop px-6 py-4">
            <div className="flex justify-between items-start mb-2">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="text-22 font-medium tracking-tight text-zinc-900">{c.firstName} {c.lastName}</div>
                <HealthCircle score={score} />
                <TierBadgeV2 tier={c.tier} />
                <StageBadgeV2 stage={c.pipelineStage} />
              </div>
              <button onClick={onClose} aria-label="Close"
                className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring">×</button>
            </div>
            {(c.phone || c.email) && (
              <div className="flex gap-4 items-center flex-wrap text-12 text-ink-secondary mb-1.5">
                {c.phone && <CallBridgeLink phone={c.phone} customerName={`${c.firstName || ''} ${c.lastName || ''}`.trim()} className="u-nums text-zinc-900 hover:underline">{c.phone}</CallBridgeLink>}
                {c.email && <a href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}`} target="_blank" rel="noopener noreferrer" className="text-zinc-900 hover:underline">{c.email}</a>}
              </div>
            )}
            {(c.serviceContactPhone || c.serviceContactEmail) && (
              <div className="text-12 text-ink-secondary mb-1.5">
                <span className="text-ink-tertiary mr-1">Service contact:</span>
                {c.serviceContactName && <span className="text-zinc-900 mr-2">{c.serviceContactName}</span>}
                {c.serviceContactPhone && (
                  <CallBridgeLink phone={c.serviceContactPhone} customerName={c.serviceContactName || `${c.firstName || ''} ${c.lastName || ''}`.trim()} className="u-nums text-zinc-900 hover:underline mr-3">{c.serviceContactPhone}</CallBridgeLink>
                )}
                {c.serviceContactEmail && (
                  <a href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.serviceContactEmail)}`} target="_blank" rel="noopener noreferrer" className="text-zinc-900 hover:underline">{c.serviceContactEmail}</a>
                )}
              </div>
            )}
            <div className="flex gap-4 items-center flex-wrap text-12 text-ink-secondary mb-2.5">
              {(() => {
                const parts = [c.address?.line1, c.address?.city, c.address?.state, c.address?.zip].filter(Boolean);
                if (!parts.length) return null;
                const full = `${c.address?.line1 || ''}, ${c.address?.city || ''}, ${c.address?.state || ''} ${c.address?.zip || ''}`.replace(/^,\s*|\s*,\s*$/g, '');
                return (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-900 hover:underline"
                  >
                    {full}
                  </a>
                );
              })()}
              <span className="u-nums text-zinc-900">{fmtCurrency(c.monthlyRate)}/mo</span>
              <span className="u-nums">{fmtCurrency(c.annualValue)}/yr</span>
              {c.memberSince && <span>Since {fmtDate(c.memberSince)}</span>}
            </div>
            <div className="flex gap-2 flex-wrap">
              {c.phone && <>
                <a href={`/admin/communications?phone=${encodeURIComponent(c.phone)}&action=sms`}
                  className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0">Text</a>
                <button
                  type="button"
                  onClick={() => callViaBridge(c.phone, `${c.firstName || ''} ${c.lastName || ''}`.trim())}
                  className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0">Call</button>
              </>}
              <a href={`/admin/schedule?customer=${customerId}`}
                className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0">Book Appt</a>
              <a href={`/admin/invoices?customer=${customerId}`}
                className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0">Invoice</a>
              <button onClick={() => setActiveTab('comms')}
                className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0">Add Note</button>
              <button
                onClick={() => {
                  setEditForm({
                    firstName: c.firstName || '',
                    lastName: c.lastName || '',
                    email: c.email || '',
                    phone: c.phone || '',
                    addressLine1: c.address?.line1 || '',
                    city: c.address?.city || '',
                    state: c.address?.state || '',
                    zip: c.address?.zip || '',
                    monthlyRate: c.monthlyRate ?? '',
                    tier: c.tier || '',
                    pipelineStage: c.pipelineStage || 'new_lead',
                  });
                  setEditErr('');
                  setEditOpen(true);
                }}
                className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0">Edit</button>
            </div>
          </div>

          {/* Mobile header (< 768px) — per mobile-admin-audit PR #3 item 2:
              back / menu / Text pills on top, large name, three-stat row */}
          <div className="c360-header-mobile px-4 pt-3 pb-3">
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={onClose}
                aria-label="Back"
                className="inline-flex items-center justify-center h-9 w-9 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 u-focus-ring"
              >
                <ChevronLeft size={18} strokeWidth={1.75} />
              </button>
              <div className="flex items-center gap-2">
                {c.phone && (
                  <a
                    href={`/admin/communications?phone=${encodeURIComponent(c.phone)}&action=sms`}
                    className="inline-flex items-center h-9 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 no-underline u-focus-ring"
                  >
                    Text
                  </a>
                )}
                {c.phone && (
                  <CallBridgeLink
                    phone={c.phone}
                    customerName={`${c.firstName || ''} ${c.lastName || ''}`.trim()}
                    className="inline-flex items-center h-9 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 no-underline u-focus-ring"
                  >
                    Call
                  </CallBridgeLink>
                )}
                <div ref={menuRef} className="relative">
                  <button
                    onClick={() => setMenuOpen(v => !v)}
                    aria-label="More"
                    aria-expanded={menuOpen}
                    className="inline-flex items-center justify-center h-9 w-9 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 u-focus-ring"
                  >
                    <MoreHorizontal size={18} strokeWidth={1.75} />
                  </button>
                  {menuOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[180px] rounded-sm border-hairline border-zinc-300 bg-white shadow-md py-1"
                    >
                      <button
                        role="menuitem"
                        onClick={() => {
                          setEditForm({
                            firstName: c.firstName || '',
                            lastName: c.lastName || '',
                            email: c.email || '',
                            phone: c.phone || '',
                            addressLine1: c.address?.line1 || '',
                            city: c.address?.city || '',
                            state: c.address?.state || '',
                            zip: c.address?.zip || '',
                            monthlyRate: c.monthlyRate ?? '',
                            tier: c.tier || '',
                            pipelineStage: c.pipelineStage || 'new_lead',
                          });
                          setEditErr('');
                          setEditOpen(true);
                          setMenuOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-13 text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                      >
                        Edit customer
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => { setActiveTab('comms'); setMenuOpen(false); }}
                        className="w-full text-left px-3 py-2 text-13 text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                      >
                        Add note
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="text-26 font-medium tracking-tight text-zinc-900 leading-tight mb-1">
              {c.firstName} {c.lastName}
            </div>
            {(c.address?.line1 || c.address?.city) && (() => {
              const parts = [c.address?.line1, c.address?.city, c.address?.state, c.address?.zip].filter(Boolean);
              const label = parts.join(', ');
              const query = encodeURIComponent(label);
              return (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${query}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-13 text-ink-secondary no-underline hover:text-zinc-900 mb-2 truncate"
                >
                  {label}
                </a>
              );
            })()}
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <TierBadgeV2 tier={c.tier} />
              <StageBadgeV2 stage={c.pipelineStage} />
            </div>

            <div className="flex items-stretch gap-3 pt-3 border-t border-hairline border-zinc-200">
              <div className="flex-1">
                <div className="u-label text-ink-tertiary">Monthly</div>
                <div className="u-nums text-15 font-medium text-zinc-900 mt-0.5">{fmtCurrency(c.monthlyRate)}</div>
              </div>
              <div className="flex-1 border-l border-hairline border-zinc-200 pl-3">
                <div className="u-label text-ink-tertiary">Annual</div>
                <div className="u-nums text-15 font-medium text-zinc-900 mt-0.5">{fmtCurrency(c.annualValue)}</div>
              </div>
              <div className="flex-1 border-l border-hairline border-zinc-200 pl-3">
                <div className="u-label text-ink-tertiary">Health</div>
                <div className={cn(
                  'u-nums text-15 font-medium mt-0.5',
                  score != null && score < 40 ? 'text-alert-fg' : 'text-zinc-900'
                )}>
                  {score != null ? score : '—'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ZONE 2 — ALERT BANNERS */}
        {alerts.length > 0 && (
          <div className="flex flex-wrap gap-2 px-6 py-3 bg-zinc-50 border-b border-hairline border-zinc-200">
            {alerts.map((a, i) => (
              <div key={i} className={cn(
                'inline-flex items-center gap-1.5 h-6 px-2 text-11 font-medium rounded-xs border-hairline',
                a.alert
                  ? 'bg-alert-bg border-alert-fg text-alert-fg'
                  : 'bg-white border-zinc-200 text-zinc-700'
              )}>
                <span className="uppercase tracking-label text-10">{a.label}</span>
                <span className="normal-case">{a.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* ZONE 3 — TAB BAR */}
        <div className="flex bg-white border-b border-hairline border-zinc-200 px-6 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={cn(
                'h-11 px-4 text-12 uppercase tracking-label font-medium whitespace-nowrap u-focus-ring transition-colors border-b-2',
                activeTab === t.key
                  ? 'text-zinc-900 border-zinc-900'
                  : 'text-ink-secondary border-transparent hover:text-zinc-900'
              )}
            >{t.label}</button>
          ))}
        </div>

        {/* TAB CONTENT */}
        <div className="p-6 flex-1">

          {/* OVERVIEW */}
          {activeTab === 'overview' && (
            <div>
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-hairline border-zinc-200">
                <div>
                  <div className="text-13 font-medium text-zinc-900">Already left a Google review</div>
                  <div className="text-11 text-ink-secondary">When on, this customer is excluded from review-request and 48h followup SMS.</div>
                  {c.reviewMarkedAt && c.hasLeftGoogleReview && (
                    <div className="text-10 text-ink-tertiary mt-0.5 u-nums">Marked {fmtDate(c.reviewMarkedAt)}</div>
                  )}
                </div>
                <Switch
                  id="has-left-review-v2"
                  checked={!!c.hasLeftGoogleReview}
                  onChange={async (val) => {
                    setData(prev => prev ? ({ ...prev, customer: { ...prev.customer, hasLeftGoogleReview: val, reviewMarkedAt: val ? new Date().toISOString() : null } }) : prev);
                    try {
                      await adminFetch(`/admin/customers/${customerId}`, {
                        method: 'PUT',
                        body: JSON.stringify({ hasLeftGoogleReview: val }),
                      });
                    } catch {
                      setData(prev => prev ? ({ ...prev, customer: { ...prev.customer, hasLeftGoogleReview: !val, reviewMarkedAt: !val ? new Date().toISOString() : null } }) : prev);
                    }
                  }}
                />
              </div>
            <div className="c360-overview-grid grid grid-cols-3 gap-5">
              {/* Col 1: Services */}
              <div>
                <SectionTitle>Upcoming Service</SectionTitle>
                {nextService ? (
                  <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5 mb-3">
                    <div className="text-13 font-medium text-zinc-900">{nextService.service_type}</div>
                    <div className="text-12 text-ink-secondary">{fmtDate(nextService.scheduled_date)} · {nextService.status}</div>
                  </div>
                ) : <div className="text-12 text-ink-secondary mb-3">No upcoming services</div>}

                <SectionTitle>Recent Services ({services.length})</SectionTitle>
                {services.slice(0, 5).map((s, i) => (
                  <div key={i} className="py-1.5 text-12 border-b border-hairline border-zinc-200/60 flex justify-between">
                    <span className="text-zinc-900">{s.service_type}</span>
                    <span className="text-ink-secondary">{fmtDate(s.service_date)}</span>
                  </div>
                ))}
                {services.length === 0 && <div className="text-12 text-ink-secondary">No services recorded</div>}
              </div>

              {/* Col 2: Billing snapshot */}
              <div>
                <SectionTitle>Billing Summary</SectionTitle>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <StatCardV2 label="Balance Owed" value={fmtCurrency(balanceOwed)} alert={balanceOwed > 0} />
                  <StatCardV2 label="Lifetime Rev" value={fmtCurrency(c.lifetimeRevenue)} />
                </div>
                {cards.length > 0 && (
                  <div className="text-12 text-ink-secondary mb-1.5">
                    Card: {cards[0].card_brand} ending {cards[0].last_four}
                  </div>
                )}
                {lastPayment && (
                  <div className="text-12 text-ink-secondary mb-3">
                    Last payment: {fmtCurrency(lastPayment.amount)} on {fmtDate(lastPayment.payment_date)}
                  </div>
                )}
                <SectionTitle>Recent Invoices</SectionTitle>
                {invoices.slice(0, 3).map((inv, i) => (
                  <div key={i} className="py-1 text-12 border-b border-hairline border-zinc-200/60 flex justify-between">
                    <span className="u-nums text-zinc-900">{fmtCurrency(inv.amount_due)}</span>
                    <span className={cn('font-medium uppercase tracking-label text-10', inv.status === 'paid' ? 'text-zinc-900' : 'text-alert-fg')}>{inv.status}</span>
                    <span className="text-ink-secondary">{fmtDate(inv.created_at)}</span>
                  </div>
                ))}
              </div>

              {/* Col 3: Health + Referral + Discounts */}
              <div>
                <SectionTitle>Health Radar</SectionTitle>
                <RadarChart data={radarData} />
                {score != null && (
                  <div className="text-center text-12 text-ink-secondary mt-1">
                    Score: <span className="font-medium" style={{ color: score >= 70 ? '#10B981' : score >= 40 ? '#F59E0B' : '#C8312F' }}>{score}/100</span>
                    {hs.churn_risk_level && <span> · {hs.churn_risk_level}</span>}
                  </div>
                )}
                {referral && (
                  <div className="mt-4">
                    <SectionTitle>Referral Stats</SectionTitle>
                    <div className="text-12 text-zinc-900">
                      Code: <span className="u-nums">{c.referralCode}</span>
                    </div>
                    {referral.total_referrals != null && <div className="text-12 text-ink-secondary">Referrals: {referral.total_referrals}</div>}
                    {referral.total_earned != null && <div className="text-12 text-zinc-900">Earned: <span className="u-nums">{fmtCurrency(referral.total_earned)}</span></div>}
                  </div>
                )}
                {discounts.length > 0 && (
                  <div className="mt-4">
                    <SectionTitle>Active Discounts</SectionTitle>
                    {discounts.map((d, i) => (
                      <div key={i} className="text-12 text-zinc-900 py-0.5">
                        {d.discount_name || 'Discount'}: <span className="u-nums">{d.discount_type === 'percentage' ? `${d.discount_value}%` : fmtCurrency(d.discount_value)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            </div>
          )}

          {/* SERVICES */}
          {activeTab === 'services' && (
            <div>
              <SectionTitle>Service History ({services.length})</SectionTitle>
              {services.length === 0 ? <div className="text-13 text-ink-secondary">No service records</div> : (
                <div className="flex flex-col">
                  {services.map((s, i) => <ServiceRowV2 key={i} service={s} />)}
                </div>
              )}
              {scheduled.length > 0 && (
                <div className="mt-5">
                  <SectionTitle>Scheduled Services ({scheduled.length})</SectionTitle>
                  {scheduled.map((s, i) => (
                    <div key={i} className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 flex justify-between text-13">
                      <span className="font-medium text-zinc-900">{s.service_type}</span>
                      <span className="text-ink-secondary">{fmtDate(s.scheduled_date)}</span>
                      <span className={cn('text-11 uppercase tracking-label font-medium', s.status === 'confirmed' ? 'text-zinc-900' : 'text-ink-secondary')}>{s.status}</span>
                    </div>
                  ))}
                </div>
              )}
              {photos.length > 0 && (
                <div className="mt-5">
                  <SectionTitle>Service Photos ({photos.length})</SectionTitle>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
                    {photos.map((p, i) => (
                      <div key={i} className="rounded-sm overflow-hidden bg-zinc-50 border-hairline border-zinc-200 aspect-square">
                        <img src={p.s3_url} alt={p.caption || ''} className="w-full h-full object-cover"
                          onError={e => { e.target.style.display = 'none'; }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* BILLING */}
          {activeTab === 'billing' && (
            <div>
              <div className="c360-billing-grid grid grid-cols-4 gap-3 mb-5">
                <StatCardV2 label="Balance Owed" value={fmtCurrency(balanceOwed)} alert={balanceOwed > 0} />
                <StatCardV2 label="Monthly Rate" value={fmtCurrency(c.monthlyRate)} />
                <StatCardV2 label="Annual Value" value={fmtCurrency(c.annualValue)} />
                <StatCardV2 label="Lifetime Revenue" value={fmtCurrency(c.lifetimeRevenue)} />
              </div>

              <AdminAutopayPanelV2 customerId={c.id} monthlyRate={c.monthlyRate} customerName={`${c.firstName} ${c.lastName}`} />

              <SectionTitle>Invoices ({invoices.length})</SectionTitle>
              {invoices.length > 0 ? (
                <Table className="mb-5">
                  <THead>
                    <TR>
                      <TH>Date</TH><TH align="right">Amount</TH><TH align="right">Paid</TH><TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {invoices.map((inv, i) => (
                      <TR key={i}>
                        <TD>{fmtDate(inv.created_at || inv.invoice_date)}</TD>
                        <TD align="right" className="u-nums">{fmtCurrency(inv.amount_due)}</TD>
                        <TD align="right" className="u-nums">{fmtCurrency(inv.amount_paid)}</TD>
                        <TD>
                          <Badge tone={inv.status === 'paid' ? 'strong' : 'alert'}>{inv.status}</Badge>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : <div className="text-13 text-ink-secondary mb-5">No invoices</div>}

              <SectionTitle>Payment History ({payments.length})</SectionTitle>
              {payments.slice(0, 10).map((p, i) => {
                const isRefund = !!p.refund_status;
                const isFailed = p.status === 'failed';
                return (
                  <div key={i} className="py-1.5 text-12 border-b border-hairline border-zinc-200/60 flex justify-between items-center gap-3">
                    <span className={cn('u-nums', isRefund ? 'text-ink-secondary' : 'text-zinc-900')}>{fmtCurrency(p.amount)}</span>
                    <span className="text-ink-secondary">{p.card_brand} …{p.last_four}</span>
                    <span className="text-ink-secondary">{fmtDate(p.payment_date)}</span>
                    <Badge tone={isRefund || isFailed ? 'alert' : 'neutral'}>
                      {isRefund ? 'Refunded' : (p.status || '').toUpperCase()}
                    </Badge>
                    {p.processor === 'stripe' && p.status === 'paid' && !isRefund && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm(`Refund $${parseFloat(p.amount).toFixed(2)} to ${c.firstName} ${c.lastName}?`)) return;
                          try {
                            await adminFetch(`/admin/customers/${c.id}/refund`, {
                              method: 'POST',
                              body: JSON.stringify({ paymentId: p.id, amount: parseFloat(p.amount), reason: 'requested_by_customer' }),
                            });
                            const fresh = await adminFetch(`/admin/customers/${customerId}`);
                            setData(fresh);
                          } catch (err) { alert('Refund failed: ' + err.message); }
                        }}
                      >Refund</Button>
                    )}
                  </div>
                );
              })}

              {cards.length > 0 && (
                <div className="mt-5">
                  <SectionTitle>Cards on File ({cards.length})</SectionTitle>
                  {cards.map((cd, i) => (
                    <div key={i} className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 text-13 flex justify-between items-center">
                      <span className="text-zinc-900">{cd.card_brand} ending {cd.last_four}</span>
                      {cd.exp_month && <span className="u-nums text-ink-secondary">{cd.exp_month}/{cd.exp_year}</span>}
                      {cd.is_default && <Badge tone="strong">Default</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* COMMS */}
          {activeTab === 'comms' && (
            <div className="flex flex-col h-full">
              <SectionTitle>Thread ({comms.length})</SectionTitle>
              <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 mb-3 max-h-[400px]">
                {[...comms].reverse().map((m, i) => {
                  const inbound = m.direction === 'inbound';
                  if (m.channel === 'sms') {
                    return (
                      <div key={m.id || i}
                        className={cn(
                          'max-w-[75%] px-3 py-2 text-13 leading-relaxed border-hairline',
                          inbound
                            ? 'self-start bg-zinc-50 border-zinc-200 text-zinc-900 rounded-sm rounded-bl-xs'
                            : 'self-end bg-zinc-900 border-zinc-900 text-white rounded-sm rounded-br-xs'
                        )}
                      >
                        <div>{m.body}</div>
                        <div className={cn(
                          'text-10 mt-1 text-right',
                          inbound ? 'text-ink-secondary' : 'text-zinc-300'
                        )}>{timeAgo(m.createdAt)}</div>
                      </div>
                    );
                  }
                  // voice
                  const rec = (m.media || []).find(x => x.type === 'recording');
                  const duration = fmtDur(m.durationSeconds ?? rec?.duration_seconds);
                  const summary = m.aiSummary || m.body;
                  return (
                    <div key={m.id || i}
                      className={cn(
                        'max-w-[85%] px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm',
                        inbound ? 'self-start' : 'self-end'
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-10 font-medium tracking-label uppercase text-ink-secondary">
                          {inbound ? 'Call in' : 'Call out'}
                        </span>
                        {duration && <span className="text-11 u-nums text-zinc-900">{duration}</span>}
                        {m.answeredBy && <span className="text-10 text-ink-secondary">· {m.answeredBy}</span>}
                      </div>
                      {summary && <div className="text-12 text-zinc-900 leading-relaxed">{summary}</div>}
                      {rec?.url && rec?.sid && (
                        <audio controls src={`${API_BASE}/admin/call-recordings/audio/${rec.sid}?token=${encodeURIComponent(localStorage.getItem('waves_admin_token') || '')}`} className="mt-1.5 w-full h-8" />
                      )}
                      <div className="text-10 mt-1 text-right text-ink-secondary">{timeAgo(m.createdAt)}</div>
                    </div>
                  );
                })}
                {comms.length === 0 && (
                  <div className="text-ink-secondary text-13 text-center py-5">No messages</div>
                )}
              </div>
              {c.phone && (
                <div className="flex gap-2 py-3 border-t border-hairline border-zinc-200">
                  <input
                    value={smsReply}
                    onChange={e => setSmsReply(e.target.value)}
                    placeholder="Type a message…"
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSms(); } }}
                    className="flex-1 h-10 px-3.5 bg-white border-hairline border-zinc-300 rounded-sm text-13 text-zinc-900 u-focus-ring"
                  />
                  <Button onClick={sendSms} disabled={sendingSms || !smsReply.trim()}>
                    {sendingSms ? '…' : 'Send'}
                  </Button>
                </div>
              )}

              {/* Notification preferences — admin override only.
                  Customers manage everything else via the customer-
                  facing /api/notifications/preferences endpoint
                  themselves. Today this exposes only the per-customer
                  auto-flip opt-out (Phase 2E). Add more rows here only
                  when ops genuinely needs to override on a customer's
                  behalf. */}
              <div className="mt-4">
                <SectionTitle>Notification preferences</SectionTitle>
                <label className="flex items-start gap-2 px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={data.notificationPrefs?.auto_flip_en_route !== false}
                    onChange={async (e) => {
                      const next = e.target.checked;
                      setData(prev => prev ? ({
                        ...prev,
                        notificationPrefs: { ...(prev.notificationPrefs || {}), auto_flip_en_route: next },
                      }) : prev);
                      try {
                        await adminFetch(`/admin/customers/${customerId}/notification-prefs`, {
                          method: 'PUT',
                          body: JSON.stringify({ autoFlipEnRoute: next }),
                        });
                      } catch {
                        // Revert on error so the toggle reflects DB truth.
                        setData(prev => prev ? ({
                          ...prev,
                          notificationPrefs: { ...(prev.notificationPrefs || {}), auto_flip_en_route: !next },
                        }) : prev);
                      }
                    }}
                  />
                  <div>
                    <div className="text-12 font-medium text-zinc-900">Auto-flip en route SMS</div>
                    <div className="text-12 text-ink-secondary">
                      When the tech&apos;s vehicle leaves a previous geofence and the next job is this customer, fire the &quot;on the way&quot; SMS automatically. Off here = customer keeps manual en-route SMS but skips auto-flip.
                    </div>
                  </div>
                </label>
              </div>

              <div className="mt-4">
                <SectionTitle>Notes &amp; Interactions ({(data.interactions || []).length})</SectionTitle>
                {(data.interactions || []).slice(0, 10).map((n, i) => (
                  <div key={i} className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 text-12">
                    <div className="flex justify-between mb-1">
                      <span className="font-medium text-zinc-900">{n.interaction_type}: {n.subject}</span>
                      <span className="text-ink-secondary text-10">{timeAgo(n.created_at)}</span>
                    </div>
                    {n.body && <div className="text-ink-secondary">{n.body.substring(0, 200)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PROPERTY */}
          {activeTab === 'property' && (
            <div>
              {(c.satelliteUrl || c.address?.line1) && (
                <div className="mb-5 rounded-md overflow-hidden border-hairline border-zinc-200 max-h-[200px]">
                  {c.satelliteUrl ? (
                    <img src={c.satelliteUrl} alt="Satellite view" className="w-full h-[200px] object-cover"
                      onError={e => { e.target.style.display = 'none'; }} />
                  ) : (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.address.line1}, ${c.address.city}, ${c.address.state} ${c.address.zip}`)}`}
                      target="_blank" rel="noopener noreferrer"
                      className="block p-5 bg-zinc-50 text-center text-13 text-zinc-900 hover:bg-zinc-100 u-focus-ring"
                    >View on Google Maps</a>
                  )}
                </div>
              )}

              <div className="c360-property-grid grid grid-cols-2 gap-5">
                <div>
                  <SectionTitle>Property Details</SectionTitle>
                  {[
                    ['Type', c.property?.type],
                    ['Lawn Type', c.property?.lawnType],
                    ['Property Sqft', c.property?.sqft ? `${parseInt(c.property.sqft).toLocaleString()} sqft` : null],
                    ['Lot Sqft', c.property?.lotSqft ? `${parseInt(c.property.lotSqft).toLocaleString()} sqft` : null],
                    ['Palm Count', c.property?.palmCount],
                    ['Pool', prefs.has_pool ? 'Yes' : null],
                    ['Irrigation', prefs.has_irrigation ? 'Yes' : null],
                  ].map(([label, val]) => val && (
                    <div key={label} className="flex justify-between py-1 text-12 border-b border-hairline border-zinc-200/60">
                      <span className="text-ink-secondary">{label}</span>
                      <span className="text-zinc-900 u-nums">{val}</span>
                    </div>
                  ))}
                </div>

                <div>
                  <SectionTitle>Access &amp; Preferences</SectionTitle>
                  {[
                    ['Property Gate Code', prefs.property_gate_code],
                    ['Neighborhood Gate', prefs.neighborhood_gate_code],
                    ['Parking Instructions', prefs.parking_instructions],
                    ['Interior Access', prefs.interior_access_instructions],
                    ['Pet Details', prefs.pet_details],
                    ['Chemical Sensitivities', prefs.chemical_sensitivities],
                    ['Preferred Time', prefs.preferred_service_time],
                    ['Preferred Tech', prefs.preferred_technician],
                    ['Special Instructions', prefs.special_instructions],
                  ].map(([label, val]) => val && (
                    <div key={label} className="flex justify-between py-1 text-12 border-b border-hairline border-zinc-200/60 gap-2">
                      <span className="text-ink-secondary flex-shrink-0">{label}</span>
                      <span className="text-zinc-900 text-right max-w-[200px] break-words">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* COMPLIANCE */}
          {activeTab === 'compliance' && (
            <div>
              <SectionTitle>Application History ({compliance.length})</SectionTitle>
              {compliance.length > 0 ? (
                <Table className="mb-5">
                  <THead>
                    <TR>
                      <TH>Date</TH><TH>Product</TH><TH>Rate</TH><TH>Area</TH><TH>Technician</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {compliance.map((r, i) => (
                      <TR key={i}>
                        <TD>{fmtDate(r.applied_at)}</TD>
                        <TD className="text-zinc-900">{r.product_name || r.product_id}</TD>
                        <TD className="u-nums">{r.rate_per_1000_sqft ? `${r.rate_per_1000_sqft}/1k sqft` : '—'}</TD>
                        <TD>{r.area_treated || '—'}</TD>
                        <TD>{r.technician_name || '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : <div className="text-13 text-ink-secondary">No application records</div>}

              <Card className="mt-5">
                <CardBody className="p-4">
                  <SectionTitle>Product Limits</SectionTitle>
                  <div className="text-12 text-ink-secondary space-y-1">
                    <div>Celsius applications this year: <span className="u-nums text-zinc-900">{compliance.filter(r => (r.product_name || '').toLowerCase().includes('celsius')).length}</span></div>
                    <div>Total nitrogen applied YTD: Check compliance records for detailed tracking</div>
                  </div>
                </CardBody>
              </Card>
            </div>
          )}
        </div>

        {/* ZONE 4 — TIMELINE */}
        <div className="border-t border-hairline border-zinc-200 px-6 py-4 bg-zinc-50">
          <div className="flex justify-between items-center mb-2.5 flex-wrap gap-2">
            <SectionTitle className="mb-0">Timeline ({filteredTimeline.length})</SectionTitle>
            <div className="flex gap-1 flex-wrap">
              {[
                { key: 'all', label: 'All' },
                { key: 'sms', label: 'SMS' },
                { key: 'call', label: 'Calls' },
                { key: 'service', label: 'Services' },
                { key: 'payment', label: 'Payments' },
                { key: 'notes', label: 'Notes' },
              ].map(f => (
                <button
                  key={f.key}
                  onClick={() => setTimelineFilter(f.key)}
                  className={cn(
                    'h-6 px-2.5 text-10 uppercase tracking-label font-medium rounded-xs border-hairline u-focus-ring transition-colors',
                    timelineFilter === f.key
                      ? 'bg-zinc-900 text-white border-zinc-900'
                      : 'bg-white text-ink-secondary border-zinc-200 hover:bg-zinc-100'
                  )}
                >{f.label}</button>
              ))}
            </div>
          </div>
          <div className="max-h-[250px] overflow-y-auto flex flex-col">
            {filteredTimeline.slice(0, 30).map((item, i) => {
              const TYPE_LABEL = { sms: 'SMS', call: 'CALL', service: 'SVC', payment: 'PAY', review: 'REV', scheduled_service: 'SCHED', interaction: 'NOTE', activity: 'ACT' };
              return (
                <div key={i} className="flex gap-2.5 py-1.5 border-b border-hairline border-zinc-200/60 text-12 items-center">
                  <Badge tone="neutral">{TYPE_LABEL[item.type] || 'EVT'}</Badge>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-zinc-900">{item.title}</span>
                    {item.description && <span className="text-ink-secondary ml-1.5">{item.description.substring(0, 80)}</span>}
                  </div>
                  <span className="text-ink-secondary text-10 u-nums flex-shrink-0">{timeAgo(item.date)}</span>
                </div>
              );
            })}
            {filteredTimeline.length === 0 && (
              <div className="text-ink-secondary text-12 text-center py-4">No timeline events</div>
            )}
          </div>
        </div>

        {/* Mobile spacer for sticky action bar */}
        <div className="c360-mobile-footer-spacer" style={{ height: 'calc(56px + env(safe-area-inset-bottom, 0px))' }} aria-hidden="true" />
      </div>

      {/* Mobile sticky action bar (mirrors desktop pills) */}
      <CustomerActionBar
        customer={{
          id: customerId,
          phone: c.phone,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          address: c.address
            ? [c.address.line1, c.address.city, c.address.state, c.address.zip].filter(Boolean).join(', ')
            : '',
        }}
        standalone
      />

      {editOpen && (
        <div
          className="fixed inset-0 bg-black/70 z-[1100] flex items-start sm:items-center justify-center p-4 overflow-y-auto"
          onClick={() => !savingEdit && setEditOpen(false)}
        >
          <div
            className="bg-white w-full max-w-[560px] rounded-sm border-hairline border-zinc-300 my-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
              <div className="text-15 font-medium text-zinc-900">Edit customer</div>
              <button
                onClick={() => !savingEdit && setEditOpen(false)}
                aria-label="Close"
                className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
              >×</button>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { key: 'firstName', label: 'First name' },
                { key: 'lastName', label: 'Last name' },
                { key: 'email', label: 'Email', type: 'email' },
                { key: 'phone', label: 'Phone', type: 'tel' },
                { key: 'addressLine1', label: 'Address', full: true },
                { key: 'city', label: 'City' },
                { key: 'state', label: 'State' },
                { key: 'zip', label: 'ZIP' },
                { key: 'monthlyRate', label: 'Monthly rate', type: 'number' },
              ].map(f => (
                <div key={f.key} className={f.full ? 'sm:col-span-2' : ''}>
                  <label className="u-label text-ink-secondary block mb-1">{f.label}</label>
                  <input
                    type={f.type || 'text'}
                    value={editForm[f.key] ?? ''}
                    onChange={e => setEditForm(p => ({ ...p, [f.key]: e.target.value }))}
                    className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
                  />
                </div>
              ))}
              <div>
                <label className="u-label text-ink-secondary block mb-1">Tier</label>
                <select
                  value={editForm.tier || ''}
                  onChange={e => setEditForm(p => ({ ...p, tier: e.target.value }))}
                  className="w-full h-9 px-2 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
                >
                  <option value="">No Plan</option>
                  <option value="Platinum">Platinum</option>
                  <option value="Gold">Gold</option>
                  <option value="Silver">Silver</option>
                  <option value="Bronze">Bronze</option>
                  <option value="One-Time">One-Time</option>
                </select>
              </div>
              <div>
                <label className="u-label text-ink-secondary block mb-1">Stage</label>
                <select
                  value={editForm.pipelineStage || ''}
                  onChange={e => setEditForm(p => ({ ...p, pipelineStage: e.target.value }))}
                  className="w-full h-9 px-2 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
                >
                  {Object.entries(STAGE_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </div>
            </div>
            {editErr && (
              <div className="mx-4 mb-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">{editErr}</div>
            )}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-hairline border-zinc-200">
              <button
                type="button"
                onClick={async () => {
                  if (deletingCustomer || savingEdit) return;
                  const name = [editForm.firstName, editForm.lastName].filter(Boolean).join(' ').trim() || 'this customer';
                  const ok = window.confirm(`Delete ${name}?\n\nThis removes them from the active customer list. Their history (services, invoices, payments) is preserved and can be restored.`);
                  if (!ok) return;
                  setDeletingCustomer(true); setEditErr('');
                  try {
                    await adminFetch(`/admin/customers/${customerId}`, { method: 'DELETE' });
                    setEditOpen(false);
                    onClose?.();
                  } catch (e) {
                    setEditErr(e.message || 'Delete failed');
                  }
                  setDeletingCustomer(false);
                }}
                disabled={deletingCustomer || savingEdit}
                aria-label="Delete customer"
                title="Delete this customer (soft-delete, restorable)"
                className="inline-flex items-center justify-center h-9 w-9 border-hairline border-alert-fg/60 rounded-sm text-alert-fg bg-white hover:bg-alert-bg disabled:opacity-50 disabled:cursor-not-allowed u-focus-ring"
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setEditOpen(false)} disabled={savingEdit || deletingCustomer}>Cancel</Button>
                <Button
                  onClick={async () => {
                    setSavingEdit(true); setEditErr('');
                    try {
                      const payload = {
                        ...editForm,
                        monthlyRate: editForm.monthlyRate === '' ? null : parseFloat(editForm.monthlyRate),
                        tier: editForm.tier || null,
                      };
                      await adminFetch(`/admin/customers/${customerId}`, {
                        method: 'PUT', body: JSON.stringify(payload),
                      });
                      await reloadCustomer();
                      setEditOpen(false);
                    } catch (e) {
                      setEditErr(e.message || 'Save failed');
                    }
                    setSavingEdit(false);
                  }}
                  disabled={savingEdit || deletingCustomer}
                >
                  {savingEdit ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
