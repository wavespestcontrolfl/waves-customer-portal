import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DiscountsSection } from './DiscountsTabs';

const API = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

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

const catColors = { pest_control: '#0ea5e9', lawn_care: '#10b981', mosquito: '#6366f1', termite: '#dc2626', rodent: '#78716c', tree_shrub: '#059669', inspection: '#f59e0b', specialty: '#8b5cf6', other: '#64748b' };
const billingColors = { recurring: '#0ea5e9', one_time: '#f59e0b', free: '#64748b' };
const tierColors = { Platinum: '#a78bfa', Gold: '#f59e0b', Silver: '#94a3b8', Bronze: '#cd7f32', 'One-Time': '#0ea5e9' };

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
  pricing_type: 'variable', base_price: '', price_range_min: '', price_range_max: '', pricing_model_key: '',
  is_taxable: false, tax_service_key: '', requires_license: false, license_category: '',
  min_tech_skill_level: 1, customer_visible: true, booking_enabled: true,
  sort_order: 100, icon: '', color: '#0ea5e9', is_active: true,
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
    setSaving(true); setError('');
    try { await onSave(form); } catch (e) { setError(e.message || 'Save failed'); } finally { setSaving(false); }
  };

  const inp = (key, type = 'text') => (
    <input style={sInput} type={type} value={form[key] ?? ''} onChange={e => set(key, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
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
      <div style={{ fontSize: 15, fontWeight: 700, color: D.white, marginBottom: 12 }}>{svc?.id ? 'Edit Service' : 'New Service'}</div>

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
          {sel('frequency', [{ value: '', label: 'N/A' }, { value: 'monthly', label: 'Monthly' }, { value: 'bimonthly', label: 'Bi-Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annual', label: 'Annual' }])}
        </Field>
        <Field label="Visits/Year" half>{inp('visits_per_year', 'number')}</Field>
        <Field label="Duration (min)" half>{inp('default_duration_minutes', 'number')}</Field>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: D.teal, marginTop: 14, marginBottom: 8 }}>Pricing</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Field label="Pricing Type" half>
          {sel('pricing_type', [{ value: 'variable', label: 'Variable' }, { value: 'fixed', label: 'Fixed' }, { value: 'quoted', label: 'Quoted' }])}
        </Field>
        <Field label="Base Price" half>{inp('base_price', 'number')}</Field>
        <Field label="Price Min" half>{inp('price_range_min', 'number')}</Field>
        <Field label="Price Max" half>{inp('price_range_max', 'number')}</Field>
        <Field label="Pricing Model Key" half>{inp('pricing_model_key')}</Field>
        <Field label="Sort Order" half>{inp('sort_order', 'number')}</Field>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: D.teal, marginTop: 14, marginBottom: 8 }}>Compliance & Skills</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Field label="Tax Service Key" half>{inp('tax_service_key')}</Field>
        <Field label="License Category" half>{inp('license_category')}</Field>
        <Field label="Min Tech Skill Level" half>{inp('min_tech_skill_level', 'number')}</Field>
        <Field label="Color" half><input style={{ ...sInput, height: 36 }} type="color" value={form.color || '#0ea5e9'} onChange={e => set('color', e.target.value)} /></Field>
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

function ServiceCard({ svc, expanded, onToggle, onUpdate }) {
  const billingColor = billingColors[svc.billing_type] || '#64748b';
  const catColor = catColors[svc.category] || '#64748b';
  const price = svc.base_price ? `$${Number(svc.base_price).toFixed(0)}` : svc.price_range_min ? `$${Number(svc.price_range_min).toFixed(0)}-$${Number(svc.price_range_max).toFixed(0)}` : '--';

  const handleToggleActive = async (e) => {
    e.stopPropagation();
    try {
      await aFetch(`/admin/services/${svc.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !svc.is_active }) });
      onUpdate();
    } catch {}
  };

  return (
    <div style={{ ...sCard, opacity: svc.is_active ? 1 : 0.5, cursor: 'pointer', transition: 'border-color 0.2s', borderColor: expanded ? D.teal : D.border }} onClick={onToggle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 14, color: D.muted }}>{'>'}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{svc.name}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <span style={sBadge(catColor)}>{(CATEGORIES.find(c => c.value === svc.category) || {}).label || svc.category}</span>
              <span style={sBadge(billingColor)}>{svc.billing_type === 'one_time' ? 'One-Time' : svc.billing_type === 'recurring' ? 'Recurring' : svc.billing_type}</span>
              {svc.is_waveguard && <span style={sBadge(D.teal)}>WaveGuard</span>}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>{price}</div>
          {svc.frequency && <div style={{ fontSize: 11, color: D.muted }}>{svc.frequency}</div>}
          {svc.default_duration_minutes > 0 && <div style={{ fontSize: 11, color: D.muted }}>{svc.default_duration_minutes} min</div>}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button onClick={handleToggleActive} style={{ ...sBtn(svc.is_active ? D.green + '22' : D.red + '22', svc.is_active ? D.green : D.red), fontSize: 11, padding: '4px 10px' }}>
          {svc.is_active ? 'Active' : 'Inactive'}
        </button>
      </div>

      {expanded && (
        <div onClick={e => e.stopPropagation()}>
          <ServiceForm
            svc={svc}
            onSave={async (data) => {
              await aFetch(`/admin/services/${svc.id}`, { method: 'PUT', body: JSON.stringify(data) });
              onUpdate();
            }}
            onCancel={onToggle}
          />
        </div>
      )}
    </div>
  );
}

function PackageCard({ pkg, allServices, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...pkg });
  const [saving, setSaving] = useState(false);
  const tierColor = tierColors[pkg.tier] || D.muted;
  const features = typeof pkg.features === 'string' ? JSON.parse(pkg.features) : (pkg.features || []);

  const save = async () => {
    setSaving(true);
    try {
      await aFetch(`/admin/services/packages/${pkg.id}`, { method: 'PUT', body: JSON.stringify(form) });
      onUpdate();
      setEditing(false);
    } finally { setSaving(false); }
  };

  if (editing) {
    return (
      <div style={{ ...sCard, borderColor: tierColor + '66' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: tierColor, marginBottom: 10 }}>Edit {pkg.name}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Field label="Name" half><input style={sInput} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Discount %" half><input style={sInput} type="number" value={form.discount_pct} onChange={e => setForm({ ...form, discount_pct: Number(e.target.value) })} /></Field>
          <Field label="Monthly Min" half><input style={sInput} type="number" value={form.monthly_price_min || ''} onChange={e => setForm({ ...form, monthly_price_min: Number(e.target.value) })} /></Field>
          <Field label="Monthly Max" half><input style={sInput} type="number" value={form.monthly_price_max || ''} onChange={e => setForm({ ...form, monthly_price_max: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Description"><textarea style={{ ...sInput, minHeight: 50, resize: 'vertical' }} value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button style={sBtn(tierColor, D.white)} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          <button style={sBtn('transparent', D.muted)} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...sCard, borderColor: tierColor + '44', flex: '1 1 220px', minWidth: 220 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: tierColor }}>{pkg.name}</div>
        <button style={{ ...sBtn('transparent', D.muted), fontSize: 11, padding: '4px 8px' }} onClick={() => setEditing(true)}>Edit</button>
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: D.white, marginBottom: 2 }}>
        ${Number(pkg.monthly_price_min || 0).toFixed(0)}-${Number(pkg.monthly_price_max || 0).toFixed(0)}<span style={{ fontSize: 12, fontWeight: 400, color: D.muted }}>/mo</span>
      </div>
      {pkg.discount_pct > 0 && <div style={{ ...sBadge(tierColor), marginBottom: 8 }}>{pkg.discount_pct}% off add-ons</div>}
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 8 }}>{pkg.description}</div>

      {(pkg.items || []).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', marginBottom: 4 }}>Included Services</div>
          {pkg.items.map(item => (
            <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: D.text, padding: '2px 0' }}>
              <span>{item.service_name || item.short_name}</span>
              {item.included_visits && <span style={{ color: D.muted }}>{item.included_visits}x/yr</span>}
            </div>
          ))}
        </div>
      )}

      {features.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', marginBottom: 4 }}>Features</div>
          {features.map((f, i) => (
            <div key={i} style={{ fontSize: 12, color: D.text, padding: '1px 0' }}>+ {f}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ServiceLibraryPage() {
  const [services, setServices] = useState([]);
  const [total, setTotal] = useState(0);
  const [packages, setPackages] = useState([]);
  const [dropdown, setDropdown] = useState([]);
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

  const loadPackages = useCallback(async () => {
    try {
      const data = await aFetch('/admin/services/packages');
      setPackages(data || []);
    } catch { setPackages([]); }
  }, []);

  const loadDropdown = useCallback(async () => {
    try {
      const data = await aFetch('/admin/services/dropdown');
      setDropdown(data || []);
    } catch {}
  }, []);

  useEffect(() => { loadServices(); }, [loadServices]);
  useEffect(() => { loadPackages(); loadDropdown(); }, [loadPackages, loadDropdown]);

  const handleCreate = async (data) => {
    await aFetch('/admin/services', { method: 'POST', body: JSON.stringify(data) });
    setShowNew(false);
    showToast('Service created');
    loadServices();
    loadDropdown();
  };

  const handleDelete = async (id) => {
    if (!confirm('Deactivate this service?')) return;
    await aFetch(`/admin/services/${id}`, { method: 'DELETE' });
    showToast('Service deactivated');
    loadServices();
  };

  const tabs = [
    { key: 'catalog', label: 'Service Catalog' },
    { key: 'packages', label: 'WaveGuard Packages' },
    { key: 'discounts', label: 'Discounts' },
  ];

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: D.white }}>Service Library</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 2 }}>Single source of truth for all services, pricing, and WaveGuard packages</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: D.muted }}>{total} services</span>
          {tab === 'catalog' && <button style={sBtn(D.teal, D.white)} onClick={() => { setShowNew(true); setExpandedId(null); }}>+ Add Service</button>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: '8px 18px', background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted, border: `1px solid ${tab === t.key ? D.teal : D.border}`, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, background: D.green, color: D.white, padding: '10px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999 }}>
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

          {/* Service Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {services.map(svc => (
              <ServiceCard
                key={svc.id}
                svc={svc}
                expanded={expandedId === svc.id}
                onToggle={() => { setExpandedId(expandedId === svc.id ? null : svc.id); setShowNew(false); }}
                onUpdate={() => { loadServices(); loadDropdown(); showToast('Service updated'); }}
              />
            ))}
          </div>

          {services.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: D.muted }}>No services found. Adjust filters or add a new service.</div>
          )}
        </>
      )}

      {/* === PACKAGES TAB === */}
      {tab === 'packages' && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {packages.map(pkg => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                allServices={dropdown}
                onUpdate={() => { loadPackages(); showToast('Package updated'); }}
              />
            ))}
          </div>
          {packages.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: D.muted }}>No packages found. Run the migration to seed WaveGuard packages.</div>
          )}
        </>
      )}

      {/* === DISCOUNTS TAB === */}
      {tab === 'discounts' && <DiscountsSection />}
    </div>
  );
}
