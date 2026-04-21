// client/src/pages/admin/CustomersPageV2.jsx
// Monochrome V2 of CustomersPage. Strict 1:1 on data, endpoints, behavior:
//   - GET  /admin/customers?search=&stage=&tier=&city=&page=&limit=100
//   - POST /admin/customers
//   - PUT  /admin/customers/:id
//   - DELETE /admin/customers/:id
//   - GET  /admin/customers/pipeline/view
// Scope: Directory view + header chrome + QuickAddModal redesigned.
// Pipeline / Map / Health / AI Advisor render V1 panels via named exports
// from CustomersPage.jsx (PR #4b/#4c/#4d will reskin those in later passes).
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Filter, Phone, MessageSquare, Plus } from 'lucide-react';
import Customer360Profile from '../../components/admin/Customer360ProfileV2';
import MobileNewCustomerSheet from '../../components/admin/MobileNewCustomerSheet';
import useIsMobile from '../../hooks/useIsMobile';
import { CustomerHealthSection } from './CustomerHealthTabs';
import {
  STAGES,
  STAGE_MAP,
  KANBAN_STAGES,
  LEAD_SOURCES,
  CustomerMap,
  CustomerIntelligenceTab,
} from './CustomersPage';
import {
  Button,
  Badge,
  Card,
  CardBody,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  cn,
} from '../../components/ui';

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

// Tier badge tone mapping. V2 drops all colored tier palette — all tiers
// render neutral. No-plan ("Bronze" default with no services) renders as
// plain text to de-emphasize.
function TierBadgeV2({ tier }) {
  if (!tier) return <span className="text-11 text-ink-tertiary">—</span>;
  return <Badge tone="neutral">{tier}</Badge>;
}

function StageBadgeV2({ stage }) {
  const s = STAGE_MAP[stage];
  if (!s) return null;
  const isAlert = stage === 'at_risk' || stage === 'churned';
  return (
    <Badge tone={isAlert ? 'alert' : 'neutral'}>{s.label}</Badge>
  );
}

// Health-score dot. Single color for valid score, alert red only for
// critical (<40). Amber is collapsed to neutral per the alert-reservation
// rule — the numeric score still communicates severity.
function HealthDot({ score }) {
  if (score == null) {
    return <span className="inline-block w-2 h-2 rounded-full bg-zinc-200" title="No score" />;
  }
  const isCritical = score < 40;
  return (
    <span
      className={cn(
        'inline-block w-2 h-2 rounded-full',
        isCritical ? 'bg-alert-fg' : 'bg-zinc-900'
      )}
      title={`Health: ${score}`}
    />
  );
}

// --- Pipeline card (V2) ---
// Monochrome card. alert-fg reserved for the delete-confirm state only —
// the stage's own "urgency" color is collapsed to neutral chrome; the column
// header handles the at-risk signal via StageBadgeV2.
function PipelineCardV2({ customer, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const daysInStage = customer.stageEnteredAt
    ? Math.floor((Date.now() - new Date(customer.stageEnteredAt)) / 86400000)
    : null;
  const addressLine = customer.address ? customer.address.split(',')[0] : '';
  const tier = customer.tier && customer.tier !== 'Bronze' ? customer.tier : null;

  return (
    <div className="bg-white border border-hairline border-zinc-200 rounded-md p-3 mb-2 last:mb-0">
      <div className="flex justify-between items-start mb-1">
        <div className="text-13 font-medium text-ink-primary tracking-tight">
          {customer.firstName} {customer.lastName}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(!confirming);
          }}
          className="text-ink-tertiary hover:text-ink-primary text-14 leading-none u-focus-ring px-1"
          aria-label="Remove"
        >
          ×
        </button>
      </div>

      {confirming && (
        <div className="bg-alert-bg border border-hairline border-alert-fg/30 rounded p-2 mb-2">
          <div className="text-12 text-alert-fg mb-2">
            Delete {customer.firstName} {customer.lastName}?
          </div>
          <div className="flex gap-1.5">
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                try {
                  await fetch(`${API_BASE}/admin/customers/${customer.id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
                  });
                  onDelete?.(customer.id);
                } catch (e) {
                  alert('Delete failed: ' + e.message);
                }
              }}
            >
              Delete
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {addressLine && (
        <div className="text-12 text-ink-tertiary mb-2 truncate">{addressLine}</div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <HealthDot score={customer.leadScore} />
        {tier && <TierBadgeV2 tier={tier} />}
        {customer.monthlyRate > 0 && (
          <span className="font-mono u-nums text-12 text-ink-primary">
            ${customer.monthlyRate}/mo
          </span>
        )}
      </div>

      {daysInStage != null && (
        <div className="text-11 text-ink-tertiary u-label mt-1.5">
          {daysInStage === 0 ? 'Today' : `${daysInStage}d in stage`}
        </div>
      )}
    </div>
  );
}

// --- Pipeline column (V2) ---
function PipelineColumnV2({ stage, customers, onDeleteCustomer, fullWidth = false }) {
  const monthlyTotal = customers.reduce((sum, c) => sum + (c.monthlyRate || 0), 0);
  const isAlertStage = stage.key === 'at_risk' || stage.key === 'churned';
  return (
    <div
      className={cn(
        'bg-white border border-hairline border-zinc-200 rounded-md flex flex-col',
        fullWidth ? 'w-full' : 'flex-shrink-0 w-[260px]'
      )}
      style={{ maxHeight: 'calc(100vh - 220px)' }}
    >
      <div className="px-3.5 py-3 border-b border-hairline border-zinc-200 flex justify-between items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-13 font-medium text-ink-primary">{stage.label}</span>
            {isAlertStage && <span className="inline-block w-1.5 h-1.5 rounded-full bg-alert-fg" />}
          </div>
          <div className="text-11 font-mono u-nums text-ink-tertiary mt-0.5">
            {customers.length} {customers.length === 1 ? 'customer' : 'customers'}
          </div>
        </div>
        {monthlyTotal > 0 && (
          <span className="font-mono u-nums text-12 text-ink-primary font-medium">
            ${monthlyTotal.toLocaleString()}/mo
          </span>
        )}
      </div>
      <div className="p-2 overflow-y-auto flex-1">
        {customers.length === 0 ? (
          <div className="text-ink-tertiary text-12 text-center py-5">No customers</div>
        ) : (
          customers.map((c) => (
            <PipelineCardV2 key={c.id} customer={c} onDelete={onDeleteCustomer} />
          ))
        )}
      </div>
    </div>
  );
}

// --- Quick Add Modal (V2) ---
function QuickAddModalV2({ open, onClose, onCreated, onOpenExisting }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', phone: '', email: '', address: '',
    leadSource: 'referral', pipelineStage: 'new_lead', tags: '', notes: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [existingMatch, setExistingMatch] = useState(null);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) return;
    setExistingMatch(null);
    setSubmitting(true);
    try {
      const body = {
        ...form,
        tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      };
      const r = await fetch(`${API_BASE}/admin/customers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        if (data.existingCustomerId) {
          setExistingMatch({ id: data.existingCustomerId, name: data.existingCustomerName || 'existing customer' });
          return;
        }
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onCreated();
      onClose();
    } catch (err) {
      window.alert('Failed to create customer: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const INPUT_CLS =
    'block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-9 px-3 ' +
    'focus:outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900';
  const LABEL_CLS = 'block u-label text-ink-tertiary mb-1';

  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>Add Customer</DialogTitle>
      </DialogHeader>
      <form onSubmit={handleSubmit}>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>First name *</label>
              <input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} className={INPUT_CLS} required />
            </div>
            <div>
              <label className={LABEL_CLS}>Last name *</label>
              <input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} className={INPUT_CLS} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Phone</label>
              <input value={form.phone} onChange={(e) => set('phone', e.target.value)} className={INPUT_CLS} placeholder="+1…" />
            </div>
            <div>
              <label className={LABEL_CLS}>Email</label>
              <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} className={INPUT_CLS} />
            </div>
          </div>
          <div>
            <label className={LABEL_CLS}>Address</label>
            <input value={form.address} onChange={(e) => set('address', e.target.value)} className={INPUT_CLS} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL_CLS}>Lead source</label>
              <select value={form.leadSource} onChange={(e) => set('leadSource', e.target.value)} className={cn(INPUT_CLS, 'cursor-pointer')}>
                {LEAD_SOURCES.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Pipeline stage</label>
              <select value={form.pipelineStage} onChange={(e) => set('pipelineStage', e.target.value)} className={cn(INPUT_CLS, 'cursor-pointer')}>
                {STAGES.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={LABEL_CLS}>Tags (comma-separated)</label>
            <input value={form.tags} onChange={(e) => set('tags', e.target.value)} className={INPUT_CLS} placeholder="VIP, referral_machine" />
          </div>
          <div>
            <label className={LABEL_CLS}>Notes</label>
            <textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} className={cn(INPUT_CLS, 'h-auto py-2 resize-y')} />
          </div>
          {existingMatch && (
            <div className="bg-alert-bg border-hairline border-alert-fg/30 rounded-sm p-3 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-13 text-alert-fg">
                Phone already on file for <strong>{existingMatch.name}</strong>.
              </span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => { onOpenExisting?.(existingMatch.id); onClose(); }}
              >
                Open profile
              </Button>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create customer'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// Sortable header cell
function SortHeaderV2({ label, sortKey, currentSort, currentDir, onSort, className }) {
  const active = currentSort === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        'inline-flex items-center gap-1 u-label text-left',
        active ? 'text-zinc-900' : 'text-ink-tertiary hover:text-ink-secondary',
        className
      )}
    >
      {label}
      {active && <span className="text-11">{currentDir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  );
}

// --- View toggle (flat pill row, no emoji) ---
const VIEWS = [
  { key: 'map', label: 'Map', desktopOnly: true },
  { key: 'pipeline', label: 'Pipeline', desktopOnly: true },
  { key: 'health', label: 'Health', desktopOnly: true },
  { key: 'intelligence', label: 'AI Advisor', desktopOnly: true },
];

function ViewToggleV2({ view, onChange }) {
  return (
    <div className="flex w-full sm:inline-flex sm:w-auto bg-white border-hairline border-zinc-200 rounded-sm overflow-hidden">
      {VIEWS.map((v) => {
        const active = v.key === view;
        return (
          <button
            key={v.key}
            type="button"
            onClick={() => onChange(active ? 'directory' : v.key)}
            className={cn(
              'flex-1 sm:flex-none u-label px-2 sm:px-3 h-11 sm:h-8 border-r-hairline border-zinc-200 last:border-r-0 transition-colors u-focus-ring',
              v.desktopOnly && 'hidden md:inline-flex items-center justify-center',
              active
                ? 'bg-zinc-900 text-white'
                : 'bg-white text-ink-secondary hover:bg-zinc-50'
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

// --- Filter pill ---
function FilterPill({ active, onClick, alert = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'u-label px-3 h-7 rounded-full border-hairline whitespace-nowrap transition-colors',
        active
          ? (alert
              ? 'bg-alert-bg text-alert-fg border-alert-fg'
              : 'bg-zinc-900 text-white border-zinc-900')
          : 'bg-white text-ink-secondary border-zinc-200 hover:bg-zinc-50'
      )}
    >
      {children}
    </button>
  );
}

// Service-type initials (tone-collapsed to neutral zinc)
function serviceInitials(c) {
  const t = (c.serviceTypes || c.service_types || '').toLowerCase();
  const out = [];
  if (t.includes('pest')) out.push('P');
  if (t.includes('lawn')) out.push('L');
  if (t.includes('mosquito')) out.push('M');
  if (t.includes('termite')) out.push('T');
  return out;
}

function detectTier(c) {
  if (c.tier && c.tier !== 'Bronze') return c.tier;
  if (c.monthlyRate > 200) return 'Platinum';
  if (c.monthlyRate > 100) return 'Gold';
  if (c.monthlyRate > 50) return 'Silver';
  return c.tier || 'Bronze';
}

export default function CustomersPageV2() {
  const isMobile = useIsMobile();
  const [customers, setCustomers] = useState([]);
  const [pipelineData, setPipelineData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchParams] = useSearchParams();
  const [view, setView] = useState(searchParams.get('view') || 'directory');
  const [search, setSearch] = useState('');
  const [filterStage, setFilterStage] = useState('all');
  const [filterTier, setFilterTier] = useState('all');
  const [sortBy, setSortBy] = useState('lastName');
  const [sortDir, setSortDir] = useState('asc');
  const [showAddModal, setShowAddModal] = useState(false);
  const [filterHasBalance, setFilterHasBalance] = useState(false);
  const [filterLastVisited, setFilterLastVisited] = useState('all'); // all | 30 | 90 | 180 | never
  const [filterCards, setFilterCards] = useState('all'); // all | has | none
  const [pipelineStageMobile, setPipelineStageMobile] = useState('new_lead');
  const [showFilters, setShowFilters] = useState(false);
  const [selected360Id, setSelected360Id] = useState(() => {
    const id = searchParams.get('customerId');
    return id ? Number(id) : null;
  });
  const [page, setPage] = useState(1);
  const [totalCustomers, setTotalCustomers] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = (c) => {
    setEditingId(c.id);
    setEditForm({
      firstName: c.firstName, lastName: c.lastName, email: c.email || '',
      phone: c.phone || '', city: c.city || '', tier: c.tier || 'Bronze',
      monthlyRate: c.monthlyRate || '', pipelineStage: c.pipelineStage || 'new_lead',
    });
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      await adminFetch(`/admin/customers/${editingId}`, {
        method: 'PUT', body: JSON.stringify(editForm),
      });
      setEditingId(null);
      loadCustomers();
    } catch (e) { window.alert('Save failed: ' + e.message); }
    setSavingEdit(false);
  };

  const loadCustomers = (p) => {
    const pg = p || page;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (filterStage !== 'all') params.set('stage', filterStage);
    if (filterTier !== 'all') params.set('tier', filterTier);
    params.set('page', String(pg));
    params.set('limit', '100');
    adminFetch(`/admin/customers?${params.toString()}`)
      .then((data) => {
        setCustomers(Array.isArray(data) ? data : data.customers || []);
        setTotalCustomers(data.total || 0);
        setTotalPages(data.totalPages || 1);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  };

  const loadPipeline = () => {
    adminFetch('/admin/customers/pipeline/view')
      .then((data) => setPipelineData(data))
      .catch(() => {});
  };

  // Single debounced effect — one fetch per filter/search/view change.
  // StrictMode's mount→cleanup→mount double-fire is absorbed by the
  // setTimeout cleanup, so dev-mode mount no longer stacks duplicate
  // `/admin/customers` requests.
  useEffect(() => {
    if (view === 'pipeline') {
      loadPipeline();
      return undefined;
    }
    const t = setTimeout(() => { setPage(1); loadCustomers(1); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filterStage, filterTier, view]);

  const handleSort = (key) => {
    if (sortBy === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(key); setSortDir('asc'); }
  };

  const handleDeleteCustomer = async (customerId, customerName) => {
    if (!window.confirm(`Delete ${customerName}? This cannot be undone.`)) return;
    try {
      const r = await fetch(`${API_BASE}/admin/customers/${customerId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.error || `HTTP ${r.status}`); }
      loadCustomers();
    } catch (e) { window.alert('Delete failed: ' + e.message); }
  };

  const sorted = [...customers].sort((a, b) => {
    let aVal, bVal;
    switch (sortBy) {
      case 'name': aVal = `${a.lastName} ${a.firstName}`.toLowerCase(); bVal = `${b.lastName} ${b.firstName}`.toLowerCase(); break;
      case 'lastName': aVal = (a.lastName || '').toLowerCase(); bVal = (b.lastName || '').toLowerCase(); break;
      case 'leadScore': aVal = a.leadScore || 0; bVal = b.leadScore || 0; break;
      case 'monthlyRate': aVal = a.monthlyRate || 0; bVal = b.monthlyRate || 0; break;
      case 'lastContactDate': aVal = a.lastContactDate || ''; bVal = b.lastContactDate || ''; break;
      case 'lifetimeRevenue': aVal = a.lifetimeRevenue || 0; bVal = b.lifetimeRevenue || 0; break;
      default: aVal = (a[sortBy] || '').toString().toLowerCase(); bVal = (b[sortBy] || '').toString().toLowerCase();
    }
    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const daysSince = (iso) => {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return null;
    return Math.floor(ms / 86400000);
  };
  const filteredSorted = sorted.filter((c) => {
    if (filterHasBalance && !((c.balanceOwed || 0) > 0)) return false;
    if (filterCards === 'has' && !((c.cardsOnFile || 0) > 0)) return false;
    if (filterCards === 'none' && (c.cardsOnFile || 0) > 0) return false;
    if (filterLastVisited !== 'all') {
      const d = daysSince(c.lastServiceDate);
      if (filterLastVisited === 'never') { if (d !== null) return false; }
      else {
        const max = parseInt(filterLastVisited, 10);
        if (d === null || d > max) return false;
      }
    }
    return true;
  });
  const totalCount = customers.length;

  // Pipeline groups (for rendering V1 PipelineColumn)
  const pipelineGroups = {};
  KANBAN_STAGES.forEach((k) => { pipelineGroups[k] = []; });
  if (view === 'pipeline') {
    (pipelineData?.customers || customers).forEach((c) => {
      const key = c.pipelineStage || 'new_lead';
      if (pipelineGroups[key]) pipelineGroups[key].push(c);
    });
  }

  if (loading && customers.length === 0) {
    return (
      <div className="p-16 text-center text-13 text-ink-secondary">
        Loading customers…
      </div>
    );
  }

  if (error && customers.length === 0) {
    return (
      <div className="p-16 text-center">
        <div className="text-14 text-alert-fg mb-3">Failed to load customers</div>
        <div className="text-13 text-ink-tertiary mb-4">{error}</div>
        <Button variant="primary" onClick={() => loadCustomers()}>Retry</Button>
      </div>
    );
  }

  const TABLE_COLS = '2fr 0.3fr 0.6fr 0.9fr';

  const activeFilterCount =
    (filterTier !== 'all' ? 1 : 0) +
    (filterStage !== 'all' ? 1 : 0) +
    (filterLastVisited !== 'all' ? 1 : 0) +
    (filterCards !== 'all' ? 1 : 0) +
    (filterHasBalance ? 1 : 0);

  return (
    <div>
      {/* ======================= HEADER ======================= */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-28 font-normal tracking-h1 text-ink-primary">Customers</h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap w-full sm:w-auto">
          {view === 'directory' && (
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customers…"
              className="hidden sm:block bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-9 px-3 w-56 focus:outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900"
            />
          )}
          {view === 'directory' && (
            <Button variant="primary" onClick={() => setShowAddModal(true)} className="hidden sm:inline-flex">
              + Add Customer
            </Button>
          )}
          {view === 'directory' && (
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              aria-label="Add customer"
              className="sm:hidden flex items-center justify-center rounded-full bg-zinc-900 text-white u-focus-ring"
              style={{ width: 36, height: 36 }}
            >
              <Plus size={20} strokeWidth={2} />
            </button>
          )}
          {view === 'directory' && (
            <button
              type="button"
              onClick={() => setShowFilters(true)}
              className="hidden sm:inline-flex items-center gap-1.5 h-9 px-3 u-label border-hairline border-zinc-300 rounded-sm text-ink-secondary bg-white hover:bg-zinc-50"
            >
              <Filter size={14} strokeWidth={1.75} />
              Filter
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-zinc-900 text-white u-nums text-11">
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* View toggle — own row, below Waves AI */}
      <div className="mb-4">
        <ViewToggleV2 view={view} onChange={setView} />
      </div>

      {/* Context-specific mobile stack (search/filter/stage picker) */}
      <div className="sm:hidden mb-3">
        {view === 'directory' && (
          <>
            <h2 className="text-12 font-medium text-ink-primary mb-1.5">Search customers</h2>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customer by name, phone number"
              className="block w-full bg-white text-14 text-ink-primary border-hairline border-zinc-300 rounded-sm h-12 px-4 focus:outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900"
            />
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="inline-flex items-center justify-center u-label px-3 h-11 bg-zinc-900 text-white border-hairline border-zinc-900 rounded-sm transition-colors u-focus-ring"
              >
                + Add Customer
              </button>
              <button
                type="button"
                onClick={() => setShowFilters(true)}
                className="inline-flex items-center justify-center gap-1.5 u-label px-3 h-11 bg-white text-ink-secondary border-hairline border-zinc-300 rounded-sm transition-colors u-focus-ring"
              >
                <Filter size={14} strokeWidth={1.75} />
                Filter
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-zinc-900 text-white u-nums text-11">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            </div>
          </>
        )}
        {view === 'pipeline' && (
          <>
            <h2 className="text-12 font-medium text-ink-primary mb-1.5">Stage</h2>
            <div className="grid grid-cols-2 gap-1.5">
              {KANBAN_STAGES.map((key) => {
                const stage = STAGE_MAP[key];
                const count = (pipelineGroups[key] || []).length;
                const active = pipelineStageMobile === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setPipelineStageMobile(key)}
                    className={cn(
                      'inline-flex items-center justify-between gap-2 u-label px-3 h-11 rounded-sm border-hairline transition-colors u-focus-ring',
                      active
                        ? 'bg-zinc-900 text-white border-zinc-900'
                        : 'bg-white text-ink-secondary border-zinc-300'
                    )}
                  >
                    <span className="truncate">{stage.label}</span>
                    <span className={cn('u-nums text-11 flex-shrink-0', active ? 'text-white/80' : 'text-ink-tertiary')}>{count}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ======================= DIRECTORY ======================= */}
      {view === 'directory' && (
        <>
          <div className="u-nums text-11 text-ink-tertiary text-right mb-3 mt-3">
            {filteredSorted.length} result{filteredSorted.length !== 1 ? 's' : ''}
          </div>

          {/* Filters dialog */}
          <Dialog open={showFilters} onClose={() => setShowFilters(false)}>
            <DialogHeader onClose={() => setShowFilters(false)}>
              <DialogTitle>Filter customers</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <div className="mb-4">
                <div className="u-label text-ink-tertiary mb-1.5">Last visited</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    { v: 'all', l: 'Any' },
                    { v: '30', l: '≤ 30 days' },
                    { v: '90', l: '≤ 90 days' },
                    { v: '180', l: '≤ 180 days' },
                    { v: 'never', l: 'Never' },
                  ].map((o) => (
                    <FilterPill key={o.v} active={filterLastVisited === o.v} onClick={() => setFilterLastVisited(o.v)}>
                      {o.l}
                    </FilterPill>
                  ))}
                </div>
              </div>
              <div className="mb-4">
                <div className="u-label text-ink-tertiary mb-1.5">Cards on file</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    { v: 'all', l: 'Any' },
                    { v: 'has', l: 'Has card' },
                    { v: 'none', l: 'No card' },
                  ].map((o) => (
                    <FilterPill key={o.v} active={filterCards === o.v} onClick={() => setFilterCards(o.v)}>
                      {o.l}
                    </FilterPill>
                  ))}
                </div>
              </div>
              <div className="mb-4">
                <div className="u-label text-ink-tertiary mb-1.5">Status</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    { v: 'all', l: 'All' },
                    { v: 'active_customer', l: 'Active' },
                    { v: 'new_lead', l: 'New Lead' },
                    { v: 'at_risk', l: 'At Risk', alert: true },
                  ].map((s) => (
                    <FilterPill key={s.v} active={filterStage === s.v} alert={s.alert} onClick={() => setFilterStage(s.v)}>
                      {s.l}
                    </FilterPill>
                  ))}
                  <FilterPill active={filterHasBalance} alert onClick={() => setFilterHasBalance(!filterHasBalance)}>
                    Has Balance
                  </FilterPill>
                </div>
              </div>
              <div>
                <div className="u-label text-ink-tertiary mb-1.5">Tier</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    { v: 'all', l: 'All Tiers' },
                    { v: 'Platinum', l: 'Platinum' },
                    { v: 'Gold', l: 'Gold' },
                    { v: 'Silver', l: 'Silver' },
                    { v: 'Bronze', l: 'Bronze' },
                    { v: 'One-Time', l: 'One-Time' },
                    { v: 'none', l: 'No Plan' },
                  ].map((t) => (
                    <FilterPill key={t.v} active={filterTier === t.v} onClick={() => setFilterTier(t.v)}>
                      {t.l}
                    </FilterPill>
                  ))}
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => {
                  setFilterTier('all');
                  setFilterStage('all');
                  setFilterLastVisited('all');
                  setFilterCards('all');
                  setFilterHasBalance(false);
                }}
              >
                Clear all
              </Button>
              <Button variant="primary" onClick={() => setShowFilters(false)}>
                Done
              </Button>
            </DialogFooter>
          </Dialog>

          {/* Desktop table header */}
          {!isMobile && (
            <div
              className="grid gap-1.5 px-4 py-2.5 mb-1 u-label"
              style={{ gridTemplateColumns: TABLE_COLS }}
            >
              <SortHeaderV2 label="Name" sortKey="lastName" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
              <div className="text-ink-tertiary">HP</div>
              <div className="text-ink-tertiary">Next Svc</div>
              <div />
            </div>
          )}

          {/* Rows */}
          {filteredSorted.length === 0 ? (
            <Card>
              <CardBody className="p-12 text-center">
                <div className="text-14 text-ink-primary mb-1">No customers found</div>
                <div className="text-13 text-ink-tertiary">Try adjusting your filters or add a new customer</div>
              </CardBody>
            </Card>
          ) : (
            filteredSorted.map((c) => {
              return (
                <div key={c.id} className="mb-2">
                  {isMobile ? (() => {
                    const addr = (c.address || '').replace(/^,\s*|\s*,\s*$/g, '').trim();
                    return (
                      <div
                        onClick={() => setSelected360Id(c.id)}
                        className="bg-white border-hairline border-zinc-200 rounded-sm px-3 flex items-center gap-3 cursor-pointer hover:bg-zinc-50"
                        style={{ height: 64 }}
                      >
                        <HealthDot score={c.healthScore} />
                        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                          <div className="text-14 font-medium text-ink-primary truncate">
                            {c.firstName} {c.lastName}
                          </div>
                          {addr ? (
                            <a
                              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-11 text-ink-tertiary truncate no-underline hover:text-ink-primary"
                            >
                              {addr}
                            </a>
                          ) : (
                            <div className="text-11 text-ink-tertiary">—</div>
                          )}
                        </div>
                        {c.phone && (
                          <a
                            href={`tel:${c.phone}`}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Call"
                            className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                          >
                            <Phone size={16} strokeWidth={1.75} />
                          </a>
                        )}
                        {c.phone && (
                          <a
                            href={`/admin/communications?phone=${encodeURIComponent(c.phone)}`}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="SMS"
                            className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                          >
                            <MessageSquare size={16} strokeWidth={1.75} />
                          </a>
                        )}
                      </div>
                    );
                  })() : (
                    <div
                      onClick={() => setSelected360Id(c.id)}
                      className="grid gap-1.5 px-4 py-3 items-center bg-white border-hairline border-zinc-200 rounded-sm cursor-pointer hover:bg-zinc-50 transition-colors"
                      style={{ gridTemplateColumns: TABLE_COLS }}
                    >
                      <div className="text-13 font-medium text-ink-primary">
                        {c.firstName} {c.lastName}
                      </div>
                      <div className="flex items-center justify-center">
                        <HealthDot score={c.healthScore} />
                      </div>
                      <div className="u-nums text-11 text-ink-secondary">
                        {c.nextServiceDate
                          ? new Date(c.nextServiceDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          : <span className="text-ink-tertiary">—</span>}
                      </div>
                      <div className="flex gap-1 justify-end">
                        {c.phone && (
                          <a
                            href={`tel:${c.phone}`}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Call"
                            title={`Call ${c.phone}`}
                            className="inline-flex items-center justify-center h-6 w-6 border-hairline border-zinc-300 rounded-xs text-ink-secondary bg-white hover:bg-zinc-50"
                          >
                            <Phone size={12} strokeWidth={1.75} />
                          </a>
                        )}
                        {c.phone && (
                          <a
                            href={`/admin/communications?phone=${encodeURIComponent(c.phone)}`}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="SMS"
                            title={`SMS ${c.phone}`}
                            className="inline-flex items-center justify-center h-6 w-6 border-hairline border-zinc-300 rounded-xs text-ink-secondary bg-white hover:bg-zinc-50"
                          >
                            <MessageSquare size={12} strokeWidth={1.75} />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); startEdit(c); }}
                          className="h-6 px-2 u-label border-hairline border-zinc-300 rounded-xs text-ink-secondary bg-white hover:bg-zinc-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleDeleteCustomer(c.id, `${c.firstName} ${c.lastName}`); }}
                          className="h-6 px-2 u-label border-hairline border-alert-fg/30 rounded-xs text-alert-fg bg-white hover:bg-alert-bg"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Inline edit form */}
                  {editingId === c.id && (
                    <div className="bg-white border-hairline border-zinc-900 rounded-sm p-5 mt-1">
                      <div className="text-13 font-medium text-ink-primary mb-3">Edit Customer</div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                        {[
                          { key: 'firstName', label: 'First name' },
                          { key: 'lastName', label: 'Last name' },
                          { key: 'email', label: 'Email', type: 'email' },
                          { key: 'phone', label: 'Phone', type: 'tel' },
                          { key: 'city', label: 'City' },
                          { key: 'monthlyRate', label: '$/Mo', type: 'number' },
                        ].map((f) => (
                          <div key={f.key}>
                            <label className="u-label text-ink-tertiary block mb-1">{f.label}</label>
                            <input
                              value={editForm[f.key] || ''}
                              onChange={(e) => setEditForm((p) => ({ ...p, [f.key]: e.target.value }))}
                              type={f.type || 'text'}
                              className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-8 px-2 focus:outline-none focus:border-zinc-900"
                            />
                          </div>
                        ))}
                        <div>
                          <label className="u-label text-ink-tertiary block mb-1">Tier</label>
                          <select
                            value={editForm.tier || ''}
                            onChange={(e) => setEditForm((p) => ({ ...p, tier: e.target.value || null }))}
                            className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-8 px-2 cursor-pointer focus:outline-none focus:border-zinc-900"
                          >
                            <option value="">No Plan</option>
                            <option value="Platinum">Platinum (20%)</option>
                            <option value="Gold">Gold (15%)</option>
                            <option value="Silver">Silver (10%)</option>
                            <option value="Bronze">Bronze (0%)</option>
                            <option value="One-Time">One-Time</option>
                          </select>
                        </div>
                        <div>
                          <label className="u-label text-ink-tertiary block mb-1">Stage</label>
                          <select
                            value={editForm.pipelineStage || ''}
                            onChange={(e) => setEditForm((p) => ({ ...p, pipelineStage: e.target.value }))}
                            className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-8 px-2 cursor-pointer focus:outline-none focus:border-zinc-900"
                          >
                            {STAGES.map((s) => (
                              <option key={s.key} value={s.key}>{s.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="primary" onClick={saveEdit} disabled={savingEdit}>
                          {savingEdit ? 'Saving…' : 'Save'}
                        </Button>
                        <Button variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-5 py-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => { const p = Math.max(1, page - 1); setPage(p); loadCustomers(p); }}
              >
                ← Previous
              </Button>
              <span className="u-nums text-13 text-ink-secondary">
                Page {page} of {totalPages} ({totalCustomers} total)
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => { const p = Math.min(totalPages, page + 1); setPage(p); loadCustomers(p); }}
              >
                Next →
              </Button>
            </div>
          )}
        </>
      )}

      {/* ======================= MAP ======================= */}
      {view === 'map' && (
        <div className="mt-4">
          <CustomerMap customers={customers} onSelect={(c) => setSelected360Id(c.id)} />
        </div>
      )}

      {/* ======================= PIPELINE (V2 monochrome) ======================= */}
      {view === 'pipeline' && (
        <>
          {/* Mobile: single selected stage, full-width */}
          <div className="sm:hidden mt-4">
            <PipelineColumnV2
              stage={STAGE_MAP[pipelineStageMobile]}
              customers={pipelineGroups[pipelineStageMobile] || []}
              onDeleteCustomer={() => { loadPipeline(); loadCustomers(); }}
              fullWidth
            />
          </div>
          {/* Desktop: horizontal scrolling board */}
          <div className="hidden sm:flex gap-3 overflow-x-auto pb-3 mt-4" style={{ WebkitOverflowScrolling: 'touch' }}>
            {KANBAN_STAGES.map((key) => {
              const stage = STAGE_MAP[key];
              return (
                <PipelineColumnV2
                  key={key}
                  stage={stage}
                  customers={pipelineGroups[key] || []}
                  onDeleteCustomer={() => { loadPipeline(); loadCustomers(); }}
                />
              );
            })}
          </div>
        </>
      )}

      {/* ======================= HEALTH ======================= */}
      {view === 'health' && <div className="mt-4"><CustomerHealthSection /></div>}

      {/* ======================= AI ADVISOR ======================= */}
      {view === 'intelligence' && <div className="mt-4"><CustomerIntelligenceTab /></div>}

      {/* ======================= QUICK ADD (desktop modal / mobile Square sheet) ======================= */}
      {!isMobile && (
        <QuickAddModalV2
          open={showAddModal}
          onClose={() => setShowAddModal(false)}
          onCreated={() => { loadCustomers(); if (view === 'pipeline') loadPipeline(); }}
          onOpenExisting={(id) => setSelected360Id(id)}
        />
      )}
      {isMobile && (
        <MobileNewCustomerSheet
          open={showAddModal}
          onClose={() => setShowAddModal(false)}
          onCreated={(customer) => {
            loadCustomers();
            if (view === 'pipeline') loadPipeline();
            // Deep-link into the newly created profile (parity with desktop QuickAdd).
            if (customer?.id) setSelected360Id(customer.id);
          }}
        />
      )}

      {/* ======================= CUSTOMER 360 (V1) ======================= */}
      {selected360Id && (
        <Customer360Profile
          customerId={selected360Id}
          onClose={() => setSelected360Id(null)}
        />
      )}
    </div>
  );
}
