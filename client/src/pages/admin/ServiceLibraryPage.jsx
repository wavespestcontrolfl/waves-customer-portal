import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DiscountsSection } from './DiscountsTabs';
import useIsMobile from '../../hooks/useIsMobile';
import MobileServiceLibrary from '../../components/admin/MobileServiceLibrary';

const API = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
// catColors / billingColors converted to V2-friendly hexes that keep semantic
// distinction (lawn=green, termite=red, inspection=amber) while folding
// non-semantic categories to zinc shades.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', purple: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', input: '#FFFFFF', heading: '#09090B', inputBorder: '#D4D4D8' };

async function aFetch(path, opts = {}) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${r.status}`);
  }
  return r.json();
}

const CATEGORIES = [
  { value: '', label: 'All Categories' },
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

const BILLING_TYPES = [
  { value: '', label: 'All Billing' },
  { value: 'recurring', label: 'Recurring' },
  { value: 'one_time', label: 'One-Time' },
  { value: 'free', label: 'Free' },
];

const catColors = { pest_control: '#18181B', lawn_care: '#15803D', mosquito: '#3F3F46', termite: '#991B1B', rodent: '#71717A', tree_shrub: '#166534', inspection: '#A16207', specialty: '#52525B', other: '#A1A1AA' };
const billingColors = { recurring: '#18181B', one_time: '#A16207', free: '#A1A1AA' };
const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16 };
const sInput = { padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box', width: '100%' };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg + '22', color: bg, fontWeight: 600, display: 'inline-block' });

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

function Field({ label, children, half }) {
  return (
    <div style={{ flex: half ? '1 1 48%' : '1 1 100%', minWidth: half ? 140 : 0, marginBottom: 10 }}>
      <label style={{ fontSize: 11, color: D.muted, marginBottom: 3, display: 'block' }}>{label}</label>
      {children}
    </div>
  );
}

function ServiceForm({ svc, onSave, onCancel }) {
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
    <div style={{ ...sCard, marginTop: 8, borderColor: D.teal + '44' }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginBottom: 12 }}>{svc?.id ? 'Edit Service' : 'New Service'}</div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Field label="Name" half>{inp('name')}</Field>
        <Field label="Service Key" half>{inp('service_key')}</Field>
        <Field label="Short Name" half>{inp('short_name')}</Field>
        <Field label="Icon" half>{inp('icon')}</Field>
        <Field label="Category" half>
          {sel('category', CATEGORIES.filter(c => c.value))}
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

      <div style={{ fontSize: 13, fontWeight: 600, color: D.teal, marginTop: 14, marginBottom: 8 }}>Pricing</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Field label="Pricing Type" half>
          {sel('pricing_type', [{ value: 'variable', label: 'Variable' }, { value: 'fixed', label: 'Fixed' }, { value: 'quoted', label: 'Quoted' }])}
        </Field>
        <Field label="Price" half>{inp('base_price', 'number')}</Field>
        <Field label="Pricing Model Key" half>{inp('pricing_model_key')}</Field>
        <Field label="Sort Order" half>{inp('sort_order', 'number')}</Field>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: D.teal, marginTop: 14, marginBottom: 8 }}>Compliance & Skills</div>
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
        <button style={sBtn(D.teal, D.white)} onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        <button style={sBtn('transparent', D.muted)} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Flat-list table row: thumbnail-less Name / Category / Billing /
// Duration / Price / Active / Actions columns. Click the row (or the
// chevron) to expand into the existing ServiceForm for inline editing —
// same edit / delete behavior the previous card grid had.
function ServiceRow({ svc, expanded, onToggle, onUpdate }) {
  const billingColor = billingColors[svc.billing_type] || '#64748b';
  const catColor = catColors[svc.category] || '#64748b';
  const price = svc.base_price ? `$${Number(svc.base_price).toFixed(0)}` : '—';
  const billingLabel = svc.billing_type === 'one_time' ? 'One-Time' : svc.billing_type === 'recurring' ? 'Recurring' : svc.billing_type || '—';
  const catLabel = (CATEGORIES.find(c => c.value === svc.category) || {}).label || svc.category || '—';
  const duration = svc.default_duration_minutes > 0 ? `${svc.default_duration_minutes} min` : '—';

  const cellPad = '10px 12px';
  const cellBase = { padding: cellPad, fontSize: 13, color: D.text, verticalAlign: 'middle' };
  const cell = (extra = {}) => ({ ...cellBase, ...extra });

  const handleToggleActive = async (e) => {
    e.stopPropagation();
    try {
      await aFetch(`/admin/services/${svc.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !svc.is_active }) });
      onUpdate();
    } catch {}
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${svc.name}"?\n\nThis removes it from the service catalog. Past services already invoiced keep their history. You can't undo this.`)) return;
    try {
      await aFetch(`/admin/services/${svc.id}`, { method: 'DELETE' });
      onUpdate();
    } catch (err) {
      window.alert('Delete failed: ' + (err?.message || 'unknown error'));
    }
  };

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          background: expanded ? '#FAFAFA' : svc.is_active ? D.white : '#F8F8F8',
          opacity: svc.is_active ? 1 : 0.55,
          borderTop: `1px solid ${D.border}`,
        }}
      >
        <td style={cell({ width: 28, color: D.muted })}>{expanded ? '▾' : '▸'}</td>
        <td style={cell({ fontWeight: 600, color: D.heading })}>
          {svc.name}
          {svc.is_waveguard && <span style={{ ...sBadge(D.teal), marginLeft: 8 }}>WaveGuard</span>}
        </td>
        <td style={cell()}><span style={sBadge(catColor)}>{catLabel}</span></td>
        <td style={cell()}><span style={sBadge(billingColor)}>{billingLabel}</span></td>
        <td style={cell({ color: D.muted })}>{svc.frequency || '—'}</td>
        <td style={cell({ color: D.muted })}>{duration}</td>
        <td style={cell({ fontWeight: 600, color: D.heading, textAlign: 'right' })}>{price}</td>
        <td style={cell({ textAlign: 'center' })}>
          <button
            onClick={handleToggleActive}
            style={{ ...sBtn(svc.is_active ? D.green + '22' : D.red + '22', svc.is_active ? D.green : D.red), fontSize: 11, padding: '4px 10px' }}
          >
            {svc.is_active ? 'Active' : 'Inactive'}
          </button>
        </td>
        <td style={cell({ textAlign: 'right', whiteSpace: 'nowrap' })}>
          <button
            onClick={handleDelete}
            style={{ ...sBtn(D.red + '15', D.red), fontSize: 11, padding: '4px 10px', border: `1px solid ${D.red}44` }}
            title="Delete this service permanently"
          >
            Delete
          </button>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: '#FAFAFA' }}>
          <td colSpan={9} style={{ padding: '10px 12px 16px' }} onClick={(e) => e.stopPropagation()}>
            <ServiceForm
              svc={svc}
              onSave={async (data) => {
                await aFetch(`/admin/services/${svc.id}`, { method: 'PUT', body: JSON.stringify(data) });
                onUpdate();
              }}
              onCancel={onToggle}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export default function ServiceLibraryPage() {
  const isMobile = useIsMobile(768);
  const [services, setServices] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ category: '', billing_type: '', is_active: 'true', search: '' });
  const [expandedId, setExpandedId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState('');
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') || 'catalog');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const loadServices = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filters.category) params.set('category', filters.category);
      if (filters.billing_type) params.set('billing_type', filters.billing_type);
      if (filters.is_active) params.set('is_active', filters.is_active);
      if (filters.search) params.set('search', filters.search);
      const data = await aFetch(`/admin/services?${params}`);
      setServices(data.services || []);
      setTotal(data.total || 0);
    } catch { setServices([]); }
  }, [filters]);

  useEffect(() => { loadServices(); }, [loadServices]);

  const handleCreate = async (data) => {
    await aFetch('/admin/services', { method: 'POST', body: JSON.stringify(data) });
    setShowNew(false);
    showToast('Service created');
    loadServices();
  };

  if (isMobile) return <MobileServiceLibrary />;

  const tabs = [
    { key: 'catalog', label: 'Service Catalog' },
    { key: 'discounts', label: 'Discounts' },
  ];

  // Flat sort by category (using the CATEGORIES filter order) then name —
  // keeps related services adjacent without needing per-category headers.
  const sortedServices = (() => {
    const orderIdx = Object.fromEntries(
      CATEGORIES.filter((c) => c.value).map((c, i) => [c.value, i]),
    );
    return [...services].sort((a, b) => {
      const ai = orderIdx[a.category] ?? 999;
      const bi = orderIdx[b.category] ?? 999;
      if (ai !== bi) return ai - bi;
      return (a.name || '').localeCompare(b.name || '');
    });
  })();

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>
            <span className="md:hidden" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>Services</span>
            <span className="hidden md:inline">Services</span>
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: D.muted }}>{total} services</span>
          {tab === 'catalog' && (
            <button
              type="button"
              onClick={() => { setShowNew(true); setExpandedId(null); }}
              style={{
                padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700,
                background: '#18181B', color: '#fff', border: 'none', cursor: 'pointer',
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
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: tab === t.key ? '#18181B' : 'transparent',
              color: tab === t.key ? '#FFFFFF' : '#A1A1AA',
              fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
              fontFamily: "'DM Sans', sans-serif",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, background: D.green, color: '#fff', padding: '10px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999 }}>
          {toast}
        </div>
      )}

      {/* === CATALOG TAB === */}
      {tab === 'catalog' && (
        <>
          {/* Filters */}
          <div style={{ ...sCard, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, padding: 12 }}>
            <select style={{ ...sInput, width: 'auto', minWidth: 140 }} value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <select style={{ ...sInput, width: 'auto', minWidth: 120 }} value={filters.billing_type} onChange={e => setFilters(f => ({ ...f, billing_type: e.target.value }))}>
              {BILLING_TYPES.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
            <select style={{ ...sInput, width: 'auto', minWidth: 110 }} value={filters.is_active} onChange={e => setFilters(f => ({ ...f, is_active: e.target.value }))}>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
              <option value="">All</option>
            </select>
            <input style={{ ...sInput, flex: 1, minWidth: 160 }} placeholder="Search services..." value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
          </div>

          {/* New Service Form */}
          {showNew && (
            <ServiceForm svc={null} onSave={handleCreate} onCancel={() => setShowNew(false)} />
          )}

          {/* Flat service table — single sortable list, no per-category sections. */}
          {sortedServices.length > 0 ? (
            <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
                <thead style={{ background: '#F8F8F8' }}>
                  <tr>
                    {[
                      { label: '', w: 28 },
                      { label: 'Name' },
                      { label: 'Category' },
                      { label: 'Billing' },
                      { label: 'Frequency' },
                      { label: 'Duration' },
                      { label: 'Price', align: 'right' },
                      { label: 'Status', align: 'center' },
                      { label: '', align: 'right' },
                    ].map((h, i) => (
                      <th
                        key={i}
                        style={{
                          padding: '10px 12px', fontSize: 11, fontWeight: 600,
                          color: D.muted, textTransform: 'uppercase', letterSpacing: 0.4,
                          textAlign: h.align || 'left',
                          width: h.w || undefined,
                          borderBottom: `1px solid ${D.border}`,
                        }}
                      >
                        {h.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedServices.map((svc) => (
                    <ServiceRow
                      key={svc.id}
                      svc={svc}
                      expanded={expandedId === svc.id}
                      onToggle={() => { setExpandedId(expandedId === svc.id ? null : svc.id); setShowNew(false); }}
                      onUpdate={() => { loadServices(); showToast('Service updated'); }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 40, color: D.muted }}>No services found. Adjust filters or add a new service.</div>
          )}
        </>
      )}

      {/* === DISCOUNTS TAB === */}
      {tab === 'discounts' && <DiscountsSection />}
    </div>
  );
}
