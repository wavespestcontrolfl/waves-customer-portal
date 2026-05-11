import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DiscountsSection } from './DiscountsTabs';
import useIsMobile from '../../hooks/useIsMobile';
import MobileServiceLibrary from '../../components/admin/MobileServiceLibrary';

const API = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', purple: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', input: '#FFFFFF', heading: '#09090B', inputBorder: '#D4D4D8', railBg: '#FAFAFA', selected: '#18181B', selectedFg: '#FAFAFA' };

async function aFetch(path, opts = {}) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${r.status}`);
  }
  return r.json();
}

const CATEGORIES = [
  { value: 'pest_control', label: 'Pest Control' },
  { value: 'lawn_care', label: 'Lawn Care' },
  { value: 'mosquito', label: 'Mosquito' },
  { value: 'termite', label: 'Termite' },
  { value: 'rodent', label: 'Rodent' },
  { value: 'tree_shrub', label: 'Tree & Shrub' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'specialty', label: 'Specialty' },
  { value: 'other', label: 'Other' },
];

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16 };
const sInput = { padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box', width: '100%' };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });

const EMPTY_SVC = {
  name: '', service_key: '', short_name: '', description: '', internal_notes: '',
  category: 'pest_control', subcategory: '', billing_type: 'recurring', is_waveguard: false,
  default_duration_minutes: 60,
  scheduling_buffer_minutes: 0, requires_follow_up: false, follow_up_interval_days: '',
  frequency: '', visits_per_year: '',
  pricing_type: 'variable', base_price: '', pricing_model_key: '',
  is_taxable: false, tax_service_key: '', requires_license: false, license_category: '',
  min_tech_skill_level: 1, customer_visible: true, booking_enabled: true,
  sort_order: 100, icon: '', color: '#18181B', is_active: true,
};

// Visible name with the legacy "WaveGuard" suffix stripped (it's been getting
// jammed into the name string; we surface it as a pill instead).
function cleanName(svc) {
  return String(svc?.name || '').replace(/\s*WaveGuard\s*$/i, '').trim();
}

function parseProducts(svc) {
  const p = svc?.default_products;
  if (Array.isArray(p)) return p;
  if (typeof p === 'string') {
    try { return JSON.parse(p); } catch { return []; }
  }
  return [];
}

function frequencyLabel(f) {
  if (!f) return '';
  return ({
    monthly: 'Monthly',
    every_6_weeks: 'Every 6 wk',
    bimonthly: 'Bi-monthly',
    quarterly: 'Quarterly',
    semiannual: 'Semiannual',
    annual: 'Annual',
  })[f] || f;
}

function billingLabel(b) {
  return b === 'one_time' ? 'One-Time' : b === 'recurring' ? 'Recurring' : b === 'free' ? 'Free' : (b || '—');
}

function priceLabel(svc) {
  const p = Number(svc?.base_price || 0);
  if (svc?.pricing_type === 'variable' || svc?.pricing_type === 'quoted') return p ? `$${p.toFixed(0)}` : 'Variable';
  return p ? `$${p.toFixed(0)}` : '—';
}

function categoryLabel(value) {
  return (CATEGORIES.find(c => c.value === value) || {}).label || value || '—';
}

function Field({ label, children, half }) {
  return (
    <div style={{ flex: half ? '1 1 48%' : '1 1 100%', minWidth: half ? 140 : 0, marginBottom: 10 }}>
      <label style={{ fontSize: 11, color: D.muted, marginBottom: 3, display: 'block' }}>{label}</label>
      {children}
    </div>
  );
}

function ServiceForm({ svc, onSave, onCancel, isNew }) {
  const [form, setForm] = useState({ ...EMPTY_SVC, ...svc });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const submit = async () => {
    if (!String(form.name || '').trim()) {
      setError('Service name is required');
      return;
    }
    setSaving(true); setError('');
    try { await onSave(form); } catch (e) { setError(e.message || 'Save failed'); } finally { setSaving(false); }
  };

  const inp = (key, type = 'text') => (
    <input style={sInput} type={type} required={key === 'name'} value={form[key] ?? ''} onChange={e => set(key, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
  );
  const sel = (key, options) => (
    <select style={sInput} value={form[key] || ''} onChange={e => set(key, e.target.value)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  const chk = (key, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: D.text, cursor: 'pointer' }}>
      <input type="checkbox" checked={!!form[key]} onChange={e => set(key, e.target.checked)} /> {label}
    </label>
  );

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Definition</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Field label="Name" half>{inp('name')}</Field>
        <Field label="Service Key" half>{inp('service_key')}</Field>
        <Field label="Short Name" half>{inp('short_name')}</Field>
        <Field label="Icon" half>{inp('icon')}</Field>
        <Field label="Category" half>
          {sel('category', CATEGORIES)}
        </Field>
        <Field label="Subcategory" half>{inp('subcategory')}</Field>
        <Field label="Billing Type" half>
          {sel('billing_type', [{ value: 'recurring', label: 'Recurring' }, { value: 'one_time', label: 'One-Time' }, { value: 'free', label: 'Free' }])}
        </Field>
        <Field label="Frequency" half>
          {sel('frequency', [{ value: '', label: 'N/A' }, { value: 'monthly', label: 'Monthly' }, { value: 'every_6_weeks', label: 'Every 6 Weeks' }, { value: 'bimonthly', label: 'Bi-Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'semiannual', label: 'Semiannual' }, { value: 'annual', label: 'Annual' }])}
        </Field>
        <Field label="Visits/Year" half>{inp('visits_per_year', 'number')}</Field>
        <Field label="Duration (min)" half>{inp('default_duration_minutes', 'number')}</Field>
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 14, marginBottom: 8 }}>Pricing</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Field label="Pricing Type" half>
          {sel('pricing_type', [{ value: 'variable', label: 'Variable' }, { value: 'fixed', label: 'Fixed' }, { value: 'quoted', label: 'Quoted' }])}
        </Field>
        <Field label="Price" half>{inp('base_price', 'number')}</Field>
        <Field label="Pricing Model Key" half>{inp('pricing_model_key')}</Field>
        <Field label="Sort Order" half>{inp('sort_order', 'number')}</Field>
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 14, marginBottom: 8 }}>Compliance & Skills</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Field label="Tax Service Key" half>{inp('tax_service_key')}</Field>
        <Field label="License Category" half>{inp('license_category')}</Field>
        <Field label="Min Tech Skill Level" half>{inp('min_tech_skill_level', 'number')}</Field>
        <Field label="Color" half><input style={{ ...sInput, height: 36 }} type="color" value={form.color || '#18181B'} onChange={e => set('color', e.target.value)} /></Field>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
        {chk('is_waveguard', 'WaveGuard')}
        {chk('is_taxable', 'Taxable')}
        {chk('requires_license', 'Requires License')}
        {chk('requires_follow_up', 'Requires Follow-up')}
        {chk('customer_visible', 'Customer Visible')}
        {chk('booking_enabled', 'Booking Enabled')}
        {chk('is_active', 'Active')}
      </div>

      {form.requires_follow_up && (
        <div style={{ marginTop: 8 }}>
          <Field label="Follow-up Interval (days)" half>{inp('follow_up_interval_days', 'number')}</Field>
        </div>
      )}

      <Field label="Description">
        <textarea style={{ ...sInput, minHeight: 60, resize: 'vertical' }} value={form.description || ''} onChange={e => set('description', e.target.value)} />
      </Field>
      <Field label="Internal Notes">
        <textarea style={{ ...sInput, minHeight: 40, resize: 'vertical' }} value={form.internal_notes || ''} onChange={e => set('internal_notes', e.target.value)} />
      </Field>

      {error && <div style={{ color: D.red, fontSize: 12, marginTop: 8, padding: '6px 10px', background: D.red + '15', borderRadius: 6 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button style={sBtn(D.teal, D.white)} onClick={submit} disabled={saving}>{saving ? 'Saving...' : isNew ? 'Create Service' : 'Save Changes'}</button>
        {onCancel && <button style={sBtn('transparent', D.muted)} onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

// ── Left rail: category list + saved-view shortcuts ───────────────────
function RailItem({ label, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 10px', borderRadius: 6,
        background: active ? D.selected : 'transparent',
        color: active ? D.selectedFg : D.text,
        border: 'none', cursor: 'pointer', textAlign: 'left',
        width: '100%', fontSize: 13, fontWeight: active ? 600 : 500,
        marginBottom: 1,
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#F0F0F1'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{
        fontSize: 11, fontWeight: 500,
        color: active ? 'rgba(250,250,250,0.8)' : D.muted,
        marginLeft: 8, fontVariantNumeric: 'tabular-nums',
      }}>{count}</span>
    </button>
  );
}

function RailSection({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 10px 6px' }}>{title}</div>
      {children}
    </div>
  );
}

// ── Middle list: compact two-line service rows ────────────────────────
function ServiceListRow({ svc, selected, onSelect }) {
  const sub = [billingLabel(svc.billing_type), frequencyLabel(svc.frequency), priceLabel(svc)].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 14px',
        background: selected ? D.selected : 'transparent',
        color: selected ? D.selectedFg : D.text,
        border: 'none',
        borderBottom: `1px solid ${D.border}`,
        cursor: 'pointer', textAlign: 'left', width: '100%',
        opacity: svc.is_active ? 1 : 0.6,
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = '#FAFAFA'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: svc.is_waveguard ? (selected ? D.selectedFg : D.heading) : 'transparent',
        border: `1.5px solid ${selected ? D.selectedFg : D.muted}`,
      }} aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 500,
          color: selected ? D.selectedFg : D.heading,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{cleanName(svc)}</span>
          {svc.is_waveguard && (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3,
              background: selected ? 'rgba(250,250,250,0.18)' : '#18181B11',
              color: selected ? D.selectedFg : D.heading,
              letterSpacing: 0.4, flexShrink: 0,
            }}>WG</span>
          )}
        </div>
        <div style={{
          fontSize: 12, marginTop: 2,
          color: selected ? 'rgba(250,250,250,0.7)' : D.muted,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {sub || '—'}
        </div>
      </div>
    </button>
  );
}

// ── Right pane: detail/edit view ──────────────────────────────────────
function DetailPane({ svc, creating, onSaveNew, onCancelNew, onUpdated, onDeleted }) {
  if (creating) {
    return (
      <div style={{ overflowY: 'auto', height: '100%', minHeight: 0, WebkitOverflowScrolling: 'touch' }}>
        <div style={{
          position: 'sticky', top: 0, zIndex: 1,
          background: D.card, borderBottom: `1px solid ${D.border}`,
          padding: '20px 24px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>New</div>
          <h2 style={{ fontSize: 22, fontWeight: 500, color: D.heading, margin: 0, lineHeight: 1.2 }}>Add a Service</h2>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 6 }}>Define a new entry in the service catalog.</div>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <ServiceForm svc={null} onSave={onSaveNew} onCancel={onCancelNew} isNew />
        </div>
      </div>
    );
  }

  if (!svc) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 10, padding: 32,
        color: D.muted, textAlign: 'center',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 10, border: `1.5px dashed ${D.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: D.border, fontSize: 22, marginBottom: 4,
        }} aria-hidden>◧</div>
        <div style={{ fontSize: 14, fontWeight: 500, color: D.text }}>Select a service to view details</div>
        <div style={{ fontSize: 12 }}>Or click <b>+ Add Service</b> to create one.</div>
      </div>
    );
  }

  const products = parseProducts(svc);

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${cleanName(svc)}"?\n\nThis removes it from the service catalog. Past services already invoiced keep their history. You can't undo this.`)) return;
    try {
      await aFetch(`/admin/services/${svc.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (err) {
      window.alert('Delete failed: ' + (err?.message || 'unknown error'));
    }
  };

  const handleToggleActive = async () => {
    try {
      await aFetch(`/admin/services/${svc.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !svc.is_active }) });
      onUpdated();
    } catch {}
  };

  return (
    <div style={{ overflowY: 'auto', height: '100%', minHeight: 0, WebkitOverflowScrolling: 'touch' }} key={svc.id}>
      {/* Sticky summary header */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 1,
        background: D.card, borderBottom: `1px solid ${D.border}`,
        padding: '20px 24px',
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
          {categoryLabel(svc.category)}{svc.subcategory ? ` · ${svc.subcategory}` : ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 22, fontWeight: 500, color: D.heading, margin: 0, lineHeight: 1.25 }}>
            {cleanName(svc)}
            {svc.is_waveguard && (
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '3px 7px', borderRadius: 4,
                background: D.heading, color: D.card, marginLeft: 10,
                verticalAlign: 'middle', textTransform: 'uppercase', letterSpacing: 0.5,
              }}>WaveGuard</span>
            )}
          </h2>
          <button
            onClick={handleToggleActive}
            type="button"
            style={{
              ...sBtn(svc.is_active ? D.green + '18' : D.red + '15', svc.is_active ? D.green : D.red),
              fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap',
            }}
            title="Toggle active status"
          >
            {svc.is_active ? '● Active' : '○ Inactive'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 12, fontSize: 13, color: D.muted, flexWrap: 'wrap' }}>
          <span><b style={{ color: D.text, fontWeight: 500 }}>{billingLabel(svc.billing_type)}</b>{svc.frequency ? ` · ${frequencyLabel(svc.frequency)}` : ''}</span>
          <span style={{ color: D.border }}>·</span>
          <span><b style={{ color: D.text, fontWeight: 500 }}>{priceLabel(svc)}</b>{svc.pricing_type === 'variable' ? ' · variable' : ''}</span>
          {svc.default_duration_minutes > 0 && (<>
            <span style={{ color: D.border }}>·</span>
            <span><b style={{ color: D.text, fontWeight: 500 }}>{svc.default_duration_minutes} min</b></span>
          </>)}
          {svc.visits_per_year > 0 && (<>
            <span style={{ color: D.border }}>·</span>
            <span><b style={{ color: D.text, fontWeight: 500 }}>{svc.visits_per_year} visits/yr</b></span>
          </>)}
        </div>
      </div>

      {/* Read-only callouts */}
      <div style={{ padding: '20px 24px 0' }}>
        {svc.description && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Description</div>
            <div style={{ fontSize: 13, color: D.text, lineHeight: 1.5 }}>{svc.description}</div>
          </div>
        )}
        {products.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Default Products</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {products.map((p, i) => (
                <span key={i} style={{
                  fontSize: 12, padding: '4px 10px', borderRadius: 4,
                  background: '#F4F4F5', color: D.text, border: `1px solid ${D.border}`,
                }}>{p}</span>
              ))}
            </div>
          </div>
        )}
        {(svc.requires_license || svc.license_category || svc.min_tech_skill_level > 1 || svc.requires_follow_up) && (
          <div style={{ marginBottom: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {svc.license_category && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>License</div>
                <div style={{ fontSize: 13, color: D.text, marginTop: 2 }}>{svc.license_category}</div>
              </div>
            )}
            {svc.min_tech_skill_level > 1 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Min Skill</div>
                <div style={{ fontSize: 13, color: D.text, marginTop: 2 }}>Level {svc.min_tech_skill_level}</div>
              </div>
            )}
            {svc.requires_follow_up && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>Follow-up</div>
                <div style={{ fontSize: 13, color: D.text, marginTop: 2 }}>{svc.follow_up_interval_days || '—'} days</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit form */}
      <div style={{ padding: '8px 24px 24px' }}>
        <ServiceForm
          key={svc.id}
          svc={svc}
          onSave={async (data) => {
            await aFetch(`/admin/services/${svc.id}`, { method: 'PUT', body: JSON.stringify(data) });
            onUpdated();
          }}
        />
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${D.border}` }}>
          <button
            type="button"
            onClick={handleDelete}
            style={{ ...sBtn(D.red + '15', D.red), border: `1px solid ${D.red}33`, fontSize: 12 }}
          >Delete service</button>
        </div>
      </div>
    </div>
  );
}

// Tablet (768-1023px): horizontal-scroll category chips. <768 falls through to MobileServiceLibrary.
function CompactCategoryChips({ counts, selectedView, onChange }) {
  const items = [
    { key: 'all', label: 'All', count: counts.all },
    ...CATEGORIES.filter(c => counts.byCategory[c.value]).map(c => ({
      key: `category:${c.value}`, label: c.label, count: counts.byCategory[c.value],
    })),
    { key: 'view:waveguard', label: 'WaveGuard', count: counts.waveguard },
    ...(counts.inactive > 0 ? [{ key: 'view:inactive', label: 'Inactive', count: counts.inactive }] : []),
  ];
  return (
    <div style={{
      display: 'flex', gap: 6, overflowX: 'auto', padding: '0 0 12px',
      WebkitOverflowScrolling: 'touch',
    }}>
      {items.map(it => {
        const active = selectedView === it.key;
        return (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            type="button"
            style={{
              padding: '6px 12px', borderRadius: 999,
              fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
              background: active ? D.selected : D.card,
              color: active ? D.selectedFg : D.text,
              border: `1px solid ${active ? D.selected : D.border}`,
              cursor: 'pointer', flexShrink: 0,
            }}
          >
            {it.label} <span style={{ opacity: 0.7, marginLeft: 4 }}>{it.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function ServiceLibraryPage() {
  const isMobile = useIsMobile(768);
  const [services, setServices] = useState([]);
  const [selectedView, setSelectedView] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState('');
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') || 'catalog');
  // 768-1023px tablet stacked mode (separate from <768 mobile drilldown)
  const [isTablet, setIsTablet] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);

  useEffect(() => {
    const onResize = () => setIsTablet(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const loadServices = useCallback(async () => {
    try {
      // Load all services once; filter client-side for snappier nav.
      const data = await aFetch('/admin/services?limit=500');
      setServices(data.services || []);
    } catch { setServices([]); }
  }, []);

  useEffect(() => { loadServices(); }, [loadServices]);

  if (isMobile) return <MobileServiceLibrary />;

  const counts = (() => {
    const c = { all: 0, waveguard: 0, recurring: 0, onetime: 0, inactive: 0, byCategory: {} };
    for (const s of services) {
      if (s.is_active === false) { c.inactive++; continue; }
      c.all++;
      if (s.is_waveguard) c.waveguard++;
      if (s.billing_type === 'recurring') c.recurring++;
      if (s.billing_type === 'one_time') c.onetime++;
      const cat = s.category || 'other';
      c.byCategory[cat] = (c.byCategory[cat] || 0) + 1;
    }
    return c;
  })();

  const viewFiltered = (() => {
    let list = services;
    if (selectedView === 'all') list = list.filter(s => s.is_active !== false);
    else if (selectedView === 'view:waveguard') list = list.filter(s => s.is_waveguard && s.is_active !== false);
    else if (selectedView === 'view:recurring') list = list.filter(s => s.billing_type === 'recurring' && s.is_active !== false);
    else if (selectedView === 'view:onetime') list = list.filter(s => s.billing_type === 'one_time' && s.is_active !== false);
    else if (selectedView === 'view:inactive') list = list.filter(s => s.is_active === false);
    else if (selectedView.startsWith('category:')) {
      const cat = selectedView.slice('category:'.length);
      list = list.filter(s => (s.category || 'other') === cat && s.is_active !== false);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.short_name || '').toLowerCase().includes(q) ||
        (s.service_key || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) =>
      (a.sort_order ?? 999) - (b.sort_order ?? 999) ||
      (a.name || '').localeCompare(b.name || ''));
  })();

  const selectedSvc = services.find(s => s.id === selectedId) || null;

  const handleCreate = async (data) => {
    const created = await aFetch('/admin/services', { method: 'POST', body: JSON.stringify(data) });
    setShowNew(false);
    if (created?.id) setSelectedId(created.id);
    showToast('Service created');
    loadServices();
  };

  const handleUpdated = () => { loadServices(); showToast('Saved'); };
  const handleDeleted = () => { setSelectedId(null); loadServices(); showToast('Deleted'); };

  const tabs = [
    { key: 'catalog', label: 'Service Catalog' },
    { key: 'discounts', label: 'Discounts' },
  ];

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto', padding: '0 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>Services</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: D.muted }}>{counts.all} {counts.all === 1 ? 'service' : 'services'}</span>
          {tab === 'catalog' && (
            <button
              type="button"
              onClick={() => { setShowNew(true); setSelectedId(null); }}
              style={{
                padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700,
                background: D.heading, color: D.card, border: 'none', cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em',
                fontFamily: "'DM Sans', sans-serif",
              }}
            >+ Add Service</button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
        <div style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, background: '#F4F4F5', borderRadius: 10, padding: 4, border: '1px solid #E4E4E7' }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} type="button" style={{
              padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: tab === t.key ? D.heading : 'transparent',
              color: tab === t.key ? D.card : '#A1A1AA',
              fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
              fontFamily: "'DM Sans', sans-serif",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, background: D.green, color: D.card, padding: '10px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999 }}>
          {toast}
        </div>
      )}

      {/* === CATALOG TAB === */}
      {tab === 'catalog' && (
        isTablet ? (
          // Tablet (768-1023): stacked. Chips on top, full-width list, inline detail panel.
          <div>
            <CompactCategoryChips counts={counts} selectedView={selectedView} onChange={(v) => { setSelectedView(v); setSelectedId(null); }} />
            <div style={{ ...sCard, padding: 8, marginBottom: 12 }}>
              <input
                style={sInput}
                placeholder="Search services..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            {showNew && (
              <div style={{ ...sCard, marginBottom: 12, padding: 0 }}>
                <DetailPane creating onSaveNew={handleCreate} onCancelNew={() => setShowNew(false)} />
              </div>
            )}
            <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: 'hidden' }}>
              {viewFiltered.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: D.muted, fontSize: 13 }}>No services found</div>
              ) : (
                viewFiltered.map(svc => {
                  const isOpen = selectedId === svc.id;
                  return (
                    <div key={svc.id}>
                      <ServiceListRow
                        svc={svc}
                        selected={isOpen}
                        onSelect={() => { setSelectedId(isOpen ? null : svc.id); setShowNew(false); }}
                      />
                      {isOpen && (
                        <div style={{ background: D.railBg, borderBottom: `1px solid ${D.border}` }}>
                          <DetailPane svc={svc} onUpdated={handleUpdated} onDeleted={handleDeleted} />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          // Desktop (≥1024): three-pane master-detail.
          <div style={{
            display: 'grid',
            gridTemplateColumns: '210px 360px 1fr',
            height: 'clamp(420px, calc(100dvh - 240px), 760px)',
            minHeight: 0,
            minWidth: 0,
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 12,
            overflow: 'hidden',
          }}>
            {/* RAIL */}
            <div style={{
              borderRight: `1px solid ${D.border}`,
              padding: '12px 8px',
              overflowY: 'auto',
              minHeight: 0,
              background: D.railBg,
            }}>
              <RailSection title="Catalog">
                <RailItem label="All Services" count={counts.all} active={selectedView === 'all'} onClick={() => { setSelectedView('all'); setSelectedId(null); }} />
              </RailSection>
              <RailSection title="Categories">
                {CATEGORIES.filter(c => counts.byCategory[c.value]).map(c => (
                  <RailItem
                    key={c.value}
                    label={c.label}
                    count={counts.byCategory[c.value] || 0}
                    active={selectedView === `category:${c.value}`}
                    onClick={() => { setSelectedView(`category:${c.value}`); setSelectedId(null); }}
                  />
                ))}
              </RailSection>
              <RailSection title="Saved Views">
                <RailItem label="WaveGuard" count={counts.waveguard} active={selectedView === 'view:waveguard'} onClick={() => { setSelectedView('view:waveguard'); setSelectedId(null); }} />
                <RailItem label="Recurring" count={counts.recurring} active={selectedView === 'view:recurring'} onClick={() => { setSelectedView('view:recurring'); setSelectedId(null); }} />
                <RailItem label="One-Time" count={counts.onetime} active={selectedView === 'view:onetime'} onClick={() => { setSelectedView('view:onetime'); setSelectedId(null); }} />
                {/* Inactive only surfaces when there ARE inactive rows — keeps the
                    rail clean per Adam's directive while leaving a recovery path
                    for reactivating services that get deactivated. */}
                {counts.inactive > 0 && (
                  <RailItem label="Inactive" count={counts.inactive} active={selectedView === 'view:inactive'} onClick={() => { setSelectedView('view:inactive'); setSelectedId(null); }} />
                )}
              </RailSection>
            </div>

            {/* LIST */}
            <div style={{
              borderRight: `1px solid ${D.border}`,
              display: 'flex', flexDirection: 'column',
              minWidth: 0,
              minHeight: 0,
            }}>
              <div style={{ padding: 12, borderBottom: `1px solid ${D.border}` }}>
                <input
                  style={sInput}
                  placeholder="Search services..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <div style={{ fontSize: 11, color: D.muted, marginTop: 8, paddingLeft: 2, fontVariantNumeric: 'tabular-nums' }}>
                  {viewFiltered.length} {viewFiltered.length === 1 ? 'service' : 'services'}
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {viewFiltered.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: D.muted, fontSize: 13 }}>
                    No services found
                  </div>
                ) : (
                  viewFiltered.map(svc => (
                    <ServiceListRow
                      key={svc.id}
                      svc={svc}
                      selected={selectedId === svc.id && !showNew}
                      onSelect={() => { setSelectedId(svc.id); setShowNew(false); }}
                    />
                  ))
                )}
              </div>
            </div>

            {/* DETAIL */}
            <div style={{ minWidth: 0, minHeight: 0, height: '100%', background: D.card }}>
              <DetailPane
                svc={showNew ? null : selectedSvc}
                creating={showNew}
                onSaveNew={handleCreate}
                onCancelNew={() => setShowNew(false)}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
              />
            </div>
          </div>
        )
      )}

      {/* === DISCOUNTS TAB === */}
      {tab === 'discounts' && <DiscountsSection />}
    </div>
  );
}
