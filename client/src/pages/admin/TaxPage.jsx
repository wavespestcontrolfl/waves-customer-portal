import { useState, useEffect, useCallback } from 'react';
import { etDateString } from '../../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal/blue/purple/orange fold to zinc-900. Semantic accents preserved.
const D = { bg: '#F4F4F5', card: '#FFFFFF', cardHover: '#FAFAFA', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', purple: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', blue: '#18181B', orange: '#18181B', heading: '#09090B', inputBorder: '#D4D4D8' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function Badge({ children, color, small }) {
  return <span style={{ display: 'inline-block', padding: small ? '1px 6px' : '2px 10px', borderRadius: 9999, fontSize: small ? 10 : 11, fontWeight: 600, background: `${color || D.muted}22`, color: color || D.muted, textTransform: 'capitalize', letterSpacing: 0.5 }}>{children}</span>;
}
function StatCard({ label, value, color, sub, onClick }) {
  return (
    <div onClick={onClick} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: isMobile ? '12px 10px' : '16px 20px', flex: isMobile ? '1 1 calc(50% - 6px)' : '1 1 0', minWidth: isMobile ? 0 : 140, cursor: onClick ? 'pointer' : 'default', transition: 'border-color 0.15s' }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = color || D.teal; }} onMouseLeave={e => { e.currentTarget.style.borderColor = D.border; }}>
      <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: color || D.heading }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
function TabBtn({ active, label, count, onClick, color }) {
  return <button onClick={onClick} style={{ background: active ? D.card : 'transparent', border: active ? `1px solid ${D.border}` : '1px solid transparent', borderRadius: 8, padding: '8px 14px', color: active ? D.white : D.muted, fontSize: 12, cursor: 'pointer', fontWeight: active ? 600 : 400, transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', flexShrink: 0, minHeight: 44 }}>{label}{count != null && <span style={{ background: `${color || D.teal}22`, color: color || D.teal, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 9999 }}>{count}</span>}</button>;
}
const inputStyle = { background: '#FFFFFF', border: `1px solid ${D.border}`, borderRadius: 6, padding: '6px 10px', color: D.text, fontSize: 12, fontFamily: 'inherit', outline: 'none' };
const fmtD = (d) => d ? new Date(d).toLocaleDateString() : '—';
const fmtM = (n) => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const fmtPct = (n) => n != null ? (n * 100).toFixed(2) + '%' : '—';
// Calendar-day diff (due date - today in ET) with both anchored at UTC midnight so same-day = 0.
const daysUntil = (due) => {
  if (!due) return 0;
  const dueStr = String(due).slice(0, 10);
  const todayStr = etDateString();
  return Math.floor((new Date(dueStr + 'T00:00:00Z') - new Date(todayStr + 'T00:00:00Z')) / 86400000);
};

const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
const PRIORITY_COLORS = { high: D.red, medium: D.amber, low: D.teal };
const STATUS_COLORS = { upcoming: D.blue, prepared: D.amber, filed: D.green, paid: D.green, late: D.red, new: D.teal, reviewed: D.amber, acted_on: D.green, dismissed: D.muted };
const FILING_STATUS_OPTIONS = ['upcoming', 'prepared', 'filed', 'paid', 'late'];

// ═══════════════════════════════════════════════════════════════
// TAX RATES TAB
// ═══════════════════════════════════════════════════════════════
function TaxRatesTab() {
  const [rates, setRates] = useState([]);
  useEffect(() => { adminFetch('/admin/tax/rates').then(d => setRates(d.rates || [])).catch(() => {}); }, []);
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Florida Sales Tax Rates by County</div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {rates.filter(r => r.active).map(r => (
          <div key={r.id} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>{r.county} County</span>
              <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: D.green }}>{fmtPct(r.combinedRate)}</span>
            </div>
            <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>State: {fmtPct(r.stateRate)} + County surtax: {fmtPct(r.countySurtax)}</div>
            <div style={{ fontSize: 11, color: D.muted }}>Zone: {r.serviceZone}</div>
            <div style={{ fontSize: 10, color: D.muted, marginTop: 4 }}>Effective: {fmtD(r.effectiveDate)}</div>
            {r.notes && <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>{r.notes}</div>}
          </div>
        ))}
      </div>
      {rates.filter(r => !r.active).length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Historical Rates</div>
          {rates.filter(r => !r.active).map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 12, padding: '6px 12px', fontSize: 12, color: D.muted, background: D.card, borderRadius: 6, marginBottom: 3, opacity: 0.6, border: `1px solid ${D.border}` }}>
              <span>{r.county}</span><span style={{ fontFamily: MONO }}>{fmtPct(r.combinedRate)}</span>
              <span>{fmtD(r.effectiveDate)} — {fmtD(r.expiryDate)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SERVICE TAXABILITY TAB
// ═══════════════════════════════════════════════════════════════
function ServiceTaxabilityTab() {
  const [services, setServices] = useState([]);
  const [toggling, setToggling] = useState(null);
  const load = () => adminFetch('/admin/tax/service-taxability').then(d => setServices(d.services || [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const toggleTaxable = async (s) => {
    setToggling(s.id);
    try {
      await adminFetch(`/admin/tax/service-taxability/${s.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isTaxable: !s.isTaxable }),
      });
      setServices(prev => prev.map(svc => svc.id === s.id ? { ...svc, isTaxable: !svc.isTaxable } : svc));
    } catch (err) {
      alert('Failed to update: ' + (err.message || 'Unknown error'));
    }
    setToggling(null);
  };

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 4 }}>Service Taxability Matrix</div>
      <div style={{ fontSize: 11, color: D.muted, marginBottom: 14 }}>Click a service to toggle FL sales tax collection</div>
      {services.map(s => (
        <div key={s.id} onClick={() => toggleTaxable(s)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, marginBottom: 4, cursor: 'pointer', opacity: toggling === s.id ? 0.5 : 1 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.isTaxable ? D.green : D.muted, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{s.serviceLabel}</span>
            <span style={{ fontSize: 11, color: D.muted, marginLeft: 8 }}>{s.serviceKey}</span>
          </div>
          <Badge color={s.isTaxable ? D.green : D.muted}>{s.isTaxable ? 'Taxable' : 'Exempt'}</Badge>
          {s.taxCategory && <Badge color={D.teal} small>{s.taxCategory}</Badge>}
          {s.flStatuteRef && <span style={{ fontSize: 10, color: '#64748b' }}>{s.flStatuteRef}</span>}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EQUIPMENT TAB
// ═══════════════════════════════════════════════════════════════
function EquipmentTab() {
  const [equipment, setEquipment] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', assetCategory: 'equipment', purchaseDate: '', purchaseCost: '', depreciationMethod: 'section_179', usefulLifeYears: '7', makeModel: '' });

  useEffect(() => { adminFetch('/admin/tax/equipment').then(d => setEquipment(d.equipment || [])).catch(() => {}); }, []);

  const handleAdd = async () => {
    if (!form.name || !form.purchaseCost) return;
    try {
      await adminFetch('/admin/tax/equipment', { method: 'POST', body: JSON.stringify({ ...form, purchaseCost: parseFloat(form.purchaseCost), usefulLifeYears: parseInt(form.usefulLifeYears), section179Elected: form.depreciationMethod === 'section_179' }) });
      setShowAdd(false); setForm({ name: '', assetCategory: 'equipment', purchaseDate: '', purchaseCost: '', depreciationMethod: 'section_179', usefulLifeYears: '7', makeModel: '' });
      const d = await adminFetch('/admin/tax/equipment'); setEquipment(d.equipment || []);
    } catch (e) { alert('Failed: ' + e.message); }
  };

  const totalCost = equipment.filter(e => e.active).reduce((s, e) => s + e.purchaseCost, 0);
  const totalBookVal = equipment.filter(e => e.active).reduce((s, e) => s + e.currentBookValue, 0);
  const totalDepr = equipment.filter(e => e.active).reduce((s, e) => s + e.accumulatedDepreciation, 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>Equipment & Depreciation Register</div>
          <div style={{ fontSize: 11, color: D.muted }}>Section 179 & MACRS tracking</div>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} style={{ background: D.teal, border: 'none', borderRadius: 6, padding: '6px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Add Equipment</button>
      </div>

      {/* Summary */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <StatCard label="Total Cost" value={fmtM(totalCost)} />
        <StatCard label="Book Value" value={fmtM(totalBookVal)} color={D.green} />
        <StatCard label="Depreciated" value={fmtM(totalDepr)} color={D.amber} />
      </div>

      {showAdd && (
        <div style={{ background: D.bg, border: `1px solid ${D.teal}44`, borderRadius: 10, padding: 14, marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Name *</div><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ ...inputStyle, width: 180 }} /></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Make/Model</div><input value={form.makeModel} onChange={e => setForm(f => ({ ...f, makeModel: e.target.value }))} style={{ ...inputStyle, width: 150 }} /></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Category</div>
            <select value={form.assetCategory} onChange={e => setForm(f => ({ ...f, assetCategory: e.target.value }))} style={{ ...inputStyle, minWidth: 100 }}>
              <option value="vehicle">Vehicle</option><option value="equipment">Equipment</option><option value="tool">Tool</option><option value="technology">Technology</option>
            </select></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Purchase Date</div><input type="date" value={form.purchaseDate} onChange={e => setForm(f => ({ ...f, purchaseDate: e.target.value }))} style={{ ...inputStyle, width: 130 }} /></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Cost *</div><input type="number" step="0.01" value={form.purchaseCost} onChange={e => setForm(f => ({ ...f, purchaseCost: e.target.value }))} style={{ ...inputStyle, width: 90 }} /></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Method</div>
            <select value={form.depreciationMethod} onChange={e => setForm(f => ({ ...f, depreciationMethod: e.target.value }))} style={{ ...inputStyle, minWidth: 110 }}>
              <option value="section_179">Section 179</option><option value="MACRS">MACRS</option><option value="SL">Straight Line</option><option value="bonus_100">100% Bonus</option>
            </select></div>
          <button onClick={handleAdd} style={{ background: D.green, border: 'none', borderRadius: 6, padding: '6px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
          <button onClick={() => setShowAdd(false)} style={{ background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6, padding: '6px 10px', color: D.muted, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {equipment.filter(e => e.active).map(e => (
        <div key={e.id} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: '12px 14px', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: D.heading, flex: 1 }}>{e.name}</span>
            <Badge color={D.teal} small>{e.assetCategory}</Badge>
            <Badge color={e.section179Elected ? D.green : D.amber} small>{e.depreciationMethod}</Badge>
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: D.muted, flexWrap: 'wrap' }}>
            {e.makeModel && <span>{e.makeModel}</span>}
            <span>Cost: <span style={{ fontFamily: MONO, color: D.text }}>{fmtM(e.purchaseCost)}</span></span>
            <span>Book: <span style={{ fontFamily: MONO, color: D.green }}>{fmtM(e.currentBookValue)}</span></span>
            <span>Depr: <span style={{ fontFamily: MONO, color: D.amber }}>{fmtM(e.accumulatedDepreciation)}</span></span>
            {e.irsClass && <span>IRS: {e.irsClass}</span>}
            <span>Purchased: {fmtD(e.purchaseDate)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPENSES TAB
// ═══════════════════════════════════════════════════════════════
function ExpensesTab() {
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [summary, setSummary] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ categoryId: '', description: '', amount: '', expenseDate: '', vendorName: '', paymentMethod: 'card' });
  const [yearFilter, setYearFilter] = useState(String(new Date().getFullYear()));

  const load = useCallback(async () => {
    try {
      const [exp, cats] = await Promise.all([adminFetch(`/admin/tax/expenses?year=${yearFilter}`), adminFetch('/admin/tax/expense-categories')]);
      setExpenses(exp.expenses || []); setSummary(exp.summary || []); setCategories(cats.categories || []);
    } catch { }
  }, [yearFilter]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!form.description || !form.amount || !form.expenseDate) return;
    try {
      await adminFetch('/admin/tax/expenses', { method: 'POST', body: JSON.stringify({ ...form, amount: parseFloat(form.amount) }) });
      setShowAdd(false); setForm({ categoryId: '', description: '', amount: '', expenseDate: '', vendorName: '', paymentMethod: 'card' });
      load();
    } catch (e) { alert('Failed: ' + e.message); }
  };

  const totalExpenses = summary.reduce((s, c) => s + c.total, 0);
  const totalDeductible = summary.reduce((s, c) => s + c.deductible, 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>Business Expenses</div>
          <select value={yearFilter} onChange={e => setYearFilter(e.target.value)} style={{ ...inputStyle, minWidth: 80 }}>
            <option value="2026">2026</option><option value="2025">2025</option><option value="2024">2024</option>
          </select>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} style={{ background: D.teal, border: 'none', borderRadius: 6, padding: '6px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Add Expense</button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <StatCard label="Total Expenses" value={fmtM(totalExpenses)} />
        <StatCard label="Tax Deductible" value={fmtM(totalDeductible)} color={D.green} />
        <StatCard label="Records" value={expenses.length} color={D.teal} />
      </div>

      {showAdd && (
        <div style={{ background: D.bg, border: `1px solid ${D.teal}44`, borderRadius: 10, padding: 14, marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Category</div>
            <select value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))} style={{ ...inputStyle, minWidth: 160 }}>
              <option value="">Select...</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name} (Line {c.irsLine})</option>)}</select></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Description *</div><input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={{ ...inputStyle, width: 200 }} /></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Amount *</div><input type="number" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={{ ...inputStyle, width: 90 }} /></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Date *</div><input type="date" value={form.expenseDate} onChange={e => setForm(f => ({ ...f, expenseDate: e.target.value }))} style={{ ...inputStyle, width: 130 }} /></div>
          <div><div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Vendor</div><input value={form.vendorName} onChange={e => setForm(f => ({ ...f, vendorName: e.target.value }))} style={{ ...inputStyle, width: 130 }} /></div>
          <button onClick={handleAdd} style={{ background: D.green, border: 'none', borderRadius: 6, padding: '6px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
          <button onClick={() => setShowAdd(false)} style={{ background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6, padding: '6px 10px', color: D.muted, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {/* Category summary */}
      {summary.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>By Schedule C Category</div>
          {summary.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${D.border}` }}>
              <span style={{ fontSize: 12, color: D.heading, fontWeight: 500, flex: 1 }}>{c.category || 'Uncategorized'}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: D.text }}>{fmtM(c.total)}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: D.green }}>{fmtM(c.deductible)} deductible</span>
              <span style={{ fontSize: 10, color: D.muted }}>{c.count} items</span>
            </div>
          ))}
        </div>
      )}

      {/* Expense list */}
      {expenses.map(e => (
        <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${D.border}` }}>
          <span style={{ fontSize: 11, color: D.muted, minWidth: 70 }}>{fmtD(e.expenseDate)}</span>
          <span style={{ fontSize: 12, color: D.heading, flex: 1 }}>{e.description}</span>
          {e.categoryName && <Badge color={D.teal} small>{e.categoryName}</Badge>}
          {e.vendorName && <span style={{ fontSize: 11, color: D.muted }}>{e.vendorName}</span>}
          <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: D.text }}>{fmtM(e.amount)}</span>
        </div>
      ))}
      {expenses.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: D.muted, fontSize: 13 }}>No expenses recorded for {yearFilter}.</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// FILING CALENDAR TAB
// ═══════════════════════════════════════════════════════════════
function FilingCalendarTab() {
  const [filings, setFilings] = useState([]);
  const load = useCallback(async () => { try { const d = await adminFetch('/admin/tax/filings'); setFilings(d.filings || []); } catch { } }, []);
  useEffect(() => { load(); }, [load]);

  const handleStatusChange = async (id, status) => {
    try {
      const update = { status };
      if (status === 'filed') update.filedDate = etDateString();
      if (status === 'paid') update.paidDate = etDateString();
      await adminFetch(`/admin/tax/filings/${id}`, { method: 'PUT', body: JSON.stringify(update) });
      load();
    } catch (e) { alert('Failed: ' + e.message); }
  };

  const upcoming = filings.filter(f => f.status === 'upcoming' || f.status === 'prepared');
  const completed = filings.filter(f => f.status === 'filed' || f.status === 'paid');

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Tax Filing Calendar</div>

      {/* Upcoming */}
      <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Upcoming Deadlines</div>
      {upcoming.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: D.muted, fontSize: 12, marginBottom: 16 }}>All caught up!</div>}
      {upcoming.map(f => {
        const du = daysUntil(f.dueDate);
        const urgentColor = du <= 7 ? D.red : du <= 30 ? D.amber : D.muted;
        return (
          <div key={f.id} style={{ background: D.card, border: `1px solid ${du <= 7 ? D.red + '66' : D.border}`, borderRadius: 8, padding: '12px 14px', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: D.heading, flex: 1 }}>{f.title}</span>
              <Badge color={STATUS_COLORS[f.status]}>{f.status}</Badge>
              <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: urgentColor }}>{du > 0 ? `${du}d` : du === 0 ? 'TODAY' : `${Math.abs(du)}d OVERDUE`}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: D.muted }}>
              <span>Due: {fmtD(f.dueDate)}</span>
              {f.extendedDueDate && <span>Extended: {fmtD(f.extendedDueDate)}</span>}
              {f.amountDue && <span>Amount: <span style={{ fontFamily: MONO, color: D.text }}>{fmtM(f.amountDue)}</span></span>}
              <div style={{ flex: 1 }} />
              <select value={f.status} onChange={e => handleStatusChange(f.id, e.target.value)} style={{ ...inputStyle, minWidth: 100 }}>
                {FILING_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </select>
            </div>
          </div>
        );
      })}

      {/* Completed */}
      {completed.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Completed ({completed.length})</div>
          {completed.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${D.border}`, opacity: 0.7 }}>
              <Badge color={D.green} small>{f.status}</Badge>
              <span style={{ fontSize: 12, color: D.text, flex: 1 }}>{f.title}</span>
              <span style={{ fontSize: 11, color: D.muted }}>Due: {fmtD(f.dueDate)}</span>
              {f.filedDate && <span style={{ fontSize: 11, color: D.green }}>Filed: {fmtD(f.filedDate)}</span>}
              {f.amountPaid && <span style={{ fontFamily: MONO, fontSize: 11, color: D.green }}>{fmtM(f.amountPaid)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// AI ADVISOR TAB
// ═══════════════════════════════════════════════════════════════
function AdvisorTab() {
  const [reports, setReports] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [alertCounts, setAlertCounts] = useState({});
  const [selectedReport, setSelectedReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [alertFilter, setAlertFilter] = useState('new');

  useEffect(() => {
    adminFetch('/admin/tax/advisor/reports').then(rpt => {
      setReports(rpt.reports || []);
      setSelectedReport(prev => prev || (rpt.reports?.[0] ?? null));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    adminFetch(`/admin/tax/advisor/alerts?status=${alertFilter}`).then(alt => {
      setAlerts(alt.alerts || []);
      setAlertCounts(alt.counts || {});
    }).catch(() => {});
  }, [alertFilter]);

  const handleRunAdvisor = async () => {
    setRunning(true);
    try {
      await adminFetch('/admin/tax/advisor/run', { method: 'POST' });
      const rpt = await adminFetch('/admin/tax/advisor/reports');
      setReports(rpt.reports || []); if (rpt.reports?.length) setSelectedReport(rpt.reports[0]);
      const alt = await adminFetch(`/admin/tax/advisor/alerts?status=new`);
      setAlerts(alt.alerts || []); setAlertCounts(alt.counts || {});
    } catch (e) { alert('Failed: ' + e.message); }
    setRunning(false);
  };

  const handleAlertAction = async (id, status) => {
    try {
      await adminFetch(`/admin/tax/advisor/alerts/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
      const alt = await adminFetch(`/admin/tax/advisor/alerts?status=${alertFilter}`);
      setAlerts(alt.alerts || []); setAlertCounts(alt.counts || {});
    } catch { }
  };

  const r = selectedReport;
  const gradeColor = { A: D.green, B: D.teal, C: D.amber, D: D.orange, F: D.red }[r?.grade] || D.muted;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>AI Tax Advisor</div>
          <div style={{ fontSize: 11, color: D.muted }}>Weekly analysis of tax situation, regulations & savings</div>
        </div>
        <button onClick={handleRunAdvisor} disabled={running} style={{ background: running ? D.border : D.purple, border: 'none', borderRadius: 6, padding: '6px 16px', color: D.heading, fontSize: 12, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.6 : 1 }}>
          {running ? 'Running analysis...' : 'Run Advisor Now'}
        </button>
      </div>

      {/* Alerts */}
      {(alertCounts.new || 0) > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: D.heading }}>Action Items</div>
            {['new', 'reviewed', 'acted_on', 'dismissed'].map(s => (
              <button key={s} onClick={() => { setAlertFilter(s); }} style={{ background: alertFilter === s ? D.card : 'transparent', border: alertFilter === s ? `1px solid ${D.border}` : '1px solid transparent', borderRadius: 4, padding: '3px 8px', fontSize: 10, color: alertFilter === s ? D.heading : D.muted, cursor: 'pointer', textTransform: 'capitalize' }}>
                {s.replace('_', ' ')} {alertCounts[s] ? `(${alertCounts[s]})` : ''}
              </button>
            ))}
          </div>
          {alerts.map(a => (
            <div key={a.id} style={{ background: D.card, border: `1px solid ${PRIORITY_COLORS[a.priority]}44`, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Badge color={PRIORITY_COLORS[a.priority]} small>{a.priority}</Badge>
                <Badge color={D.teal} small>{a.type}</Badge>
                <span style={{ fontSize: 12, fontWeight: 600, color: D.heading, flex: 1 }}>{a.title}</span>
                {a.estimatedSavings && <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: D.green }}>~{fmtM(a.estimatedSavings)}/yr</span>}
              </div>
              {a.description && <div style={{ fontSize: 11, color: D.muted, marginBottom: 6 }}>{a.description}</div>}
              <div style={{ display: 'flex', gap: 4 }}>
                {a.status === 'new' && <button onClick={() => handleAlertAction(a.id, 'reviewed')} style={{ background: D.teal, border: 'none', borderRadius: 4, padding: '3px 10px', color: '#fff', fontSize: 10, cursor: 'pointer' }}>Mark Reviewed</button>}
                {(a.status === 'new' || a.status === 'reviewed') && <button onClick={() => handleAlertAction(a.id, 'acted_on')} style={{ background: D.green, border: 'none', borderRadius: 4, padding: '3px 10px', color: '#fff', fontSize: 10, cursor: 'pointer' }}>Done</button>}
                {a.status !== 'dismissed' && <button onClick={() => handleAlertAction(a.id, 'dismissed')} style={{ background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 4, padding: '3px 8px', color: D.muted, fontSize: 10, cursor: 'pointer' }}>Dismiss</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Report selector */}
      {reports.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {reports.slice(0, 8).map(rp => (
            <button key={rp.id} onClick={() => setSelectedReport(rp)} style={{ background: selectedReport?.id === rp.id ? D.card : 'transparent', border: selectedReport?.id === rp.id ? `1px solid ${D.border}` : '1px solid transparent', borderRadius: 6, padding: '4px 10px', fontSize: 11, color: selectedReport?.id === rp.id ? D.heading : D.muted, cursor: 'pointer' }}>
              {rp.period || fmtD(rp.date)} <span style={{ fontWeight: 700, color: { A: D.green, B: D.teal, C: D.amber }[rp.grade] || D.muted }}>{rp.grade}</span>
            </button>
          ))}
        </div>
      )}

      {/* Selected report */}
      {r ? (
        <div>
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '16px 20px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <span style={{ fontFamily: MONO, fontSize: 32, fontWeight: 800, color: gradeColor }}>{r.grade}</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{r.period}</div>
                <div style={{ fontSize: 12, color: D.muted }}>{r.date}</div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: D.text, lineHeight: 1.6 }}>{r.summary}</div>
          </div>

          {/* Regulation changes */}
          {r.regulationChanges?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 8 }}>📜 Regulation Changes Found</div>
              {r.regulationChanges.map((rc, i) => (
                <div key={i} style={{ background: D.card, border: `1px solid ${D.amber}44`, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 4 }}>{rc.change}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>{rc.impact}</div>
                  {rc.action_required && <div style={{ fontSize: 11, color: D.amber, marginTop: 4 }}>Action: {rc.action_required}</div>}
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>{rc.source} {rc.effective_date && `· Effective ${rc.effective_date}`}</div>
                </div>
              ))}
            </div>
          )}

          {/* Savings opportunities */}
          {r.savingsOpportunities?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 8 }}>💰 Savings Opportunities</div>
              {r.savingsOpportunities.map((s, i) => (
                <div key={i} style={{ background: D.card, border: `1px solid ${D.green}33`, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge color={PRIORITY_COLORS[s.priority]} small>{s.priority}</Badge>
                    <span style={{ fontSize: 12, fontWeight: 600, color: D.heading, flex: 1 }}>{s.title}</span>
                    {s.estimated_annual_savings && <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: D.green }}>~{fmtM(s.estimated_annual_savings)}/yr</span>}
                  </div>
                  <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>{s.action}</div>
                </div>
              ))}
            </div>
          )}

          {/* Deduction gaps */}
          {r.deductionGaps?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 8 }}>🔍 Deduction Gaps</div>
              {r.deductionGaps.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${D.border}` }}>
                  <span style={{ fontSize: 12, color: D.heading, flex: 1 }}>{d.deduction}</span>
                  {d.estimated_value && <span style={{ fontFamily: MONO, fontSize: 12, color: D.green }}>{fmtM(d.estimated_value)}</span>}
                  {d.irs_reference && <span style={{ fontSize: 10, color: D.muted }}>{d.irs_reference}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Compliance alerts */}
          {r.complianceAlerts?.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 8 }}>⚠️ Compliance Alerts</div>
              {r.complianceAlerts.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${PRIORITY_COLORS[a.severity] || D.border}44` }}>
                  <Badge color={PRIORITY_COLORS[a.severity]} small>{a.severity}</Badge>
                  <span style={{ fontSize: 12, color: D.heading, flex: 1 }}>{a.alert}</span>
                  {a.deadline && <span style={{ fontSize: 11, color: D.amber }}>By: {a.deadline}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🤖</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 6 }}>No Advisor Reports Yet</div>
          <div style={{ fontSize: 13, color: D.muted, maxWidth: 400, margin: '0 auto' }}>Click "Run Advisor Now" to generate your first weekly tax analysis. The advisor will search for current regulations, analyze your financials, and identify savings opportunities.</div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXEMPTIONS TAB
// ═══════════════════════════════════════════════════════════════
function ExemptionsTab() {
  const [exemptions, setExemptions] = useState([]);
  useEffect(() => { adminFetch('/admin/tax/exemptions').then(d => setExemptions(d.exemptions || [])).catch(() => {}); }, []);
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 4 }}>Tax Exemption Certificates</div>
      <div style={{ fontSize: 11, color: D.muted, marginBottom: 14 }}>DR-14 exemption certificates for tax-exempt customers</div>
      {exemptions.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: D.muted, fontSize: 13 }}>No exemption certificates on file. Add one when a customer provides a DR-14.</div>
      ) : (
        exemptions.map(e => (
          <div key={e.id} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: D.heading, flex: 1 }}>{e.customerName}</span>
              <Badge color={e.verified ? D.green : D.amber}>{e.verified ? 'Verified' : 'Unverified'}</Badge>
              <Badge color={D.teal} small>{e.exemptionType}</Badge>
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: D.muted, marginTop: 4 }}>
              <span>Cert: {e.certificateNumber || '—'}</span>
              <span>Expires: {fmtD(e.expiryDate)}</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// MILEAGE TAB
// ═══════════════════════════════════════════════════════════════
function MileageTab() {
  const [entries, setEntries] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [form, setForm] = useState({ trip_date: etDateString(), start_address: '', end_address: '', distance_miles: '', purpose: 'business', notes: '' });

  const load = () => {
    Promise.all([
      adminFetch('/admin/tax/mileage').catch((err) => { console.error('[tax] mileage fetch failed:', err); return { entries: [] }; }),
      adminFetch('/admin/tax/mileage/stats').catch((err) => { console.error('[tax] mileage stats failed:', err); return null; }),
    ]).then(([m, s]) => {
      setEntries((m && (m.entries || m)) || []);
      setStats(s || { totalMiles: 0, totalDeduction: 0, totalTrips: 0, avgDistance: 0, irsRate: 0.70 });
      setLoading(false);
    });
  };
  useEffect(load, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await adminFetch('/admin/tax/mileage/sync-bouncie', { method: 'POST' });
      alert(`Bouncie sync: ${r.tripsImported || 0} trips imported, ${r.totalMiles?.toFixed(1) || 0} miles, ${fmtM(r.deductionAmount)} deduction`);
      load();
    } catch (e) { alert(`Sync failed: ${e.message}`); }
    setSyncing(false);
  };

  const handleAdd = async () => {
    if (!form.distance_miles) return;
    try {
      await adminFetch('/admin/tax/mileage', { method: 'POST', body: JSON.stringify(form) });
      setForm(f => ({ ...f, start_address: '', end_address: '', distance_miles: '', notes: '' }));
      load();
    } catch (e) { alert(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading mileage...</div>;

  return (
    <div>
      {/* Stats */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <StatCard label="YTD Business Miles" value={`${(stats.totalMiles || 0).toLocaleString()} mi`} color={D.green} />
          <StatCard label="YTD Deduction" value={fmtM(stats.totalDeduction)} color={D.green} sub={`@ $${stats.irsRate || 0.70}/mile`} />
          <StatCard label="Total Trips" value={stats.totalTrips || 0} color={D.teal} />
          <StatCard label="Avg Trip" value={`${(stats.avgDistance || 0).toFixed(1)} mi`} color={D.muted} />
        </div>
      )}

      {/* Sync + Add */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <button onClick={handleSync} disabled={syncing} style={{ padding: '8px 16px', background: D.teal, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: syncing ? 0.5 : 1 }}>{syncing ? 'Syncing Bouncie...' : '🚗 Sync from Bouncie'}</button>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <div><label style={{ fontSize: 10, color: D.muted, display: 'block' }}>Date</label><input type="date" value={form.trip_date} onChange={e => setForm(f => ({ ...f, trip_date: e.target.value }))} style={{ ...inputStyle, width: 130 }} /></div>
          <div><label style={{ fontSize: 10, color: D.muted, display: 'block' }}>From</label><input value={form.start_address} onChange={e => setForm(f => ({ ...f, start_address: e.target.value }))} placeholder="Start" style={{ ...inputStyle, width: 140 }} /></div>
          <div><label style={{ fontSize: 10, color: D.muted, display: 'block' }}>To</label><input value={form.end_address} onChange={e => setForm(f => ({ ...f, end_address: e.target.value }))} placeholder="End" style={{ ...inputStyle, width: 140 }} /></div>
          <div><label style={{ fontSize: 10, color: D.muted, display: 'block' }}>Miles</label><input type="number" value={form.distance_miles} onChange={e => setForm(f => ({ ...f, distance_miles: e.target.value }))} placeholder="0.0" step="0.1" style={{ ...inputStyle, width: 70 }} /></div>
          <select value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}><option value="business">Business</option><option value="personal">Personal</option><option value="commute">Commute</option></select>
          <button onClick={handleAdd} style={{ padding: '6px 14px', background: D.green, color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Add</button>
        </div>
      </div>

      {/* Entries */}
      {entries.length === 0 ? (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: 40, textAlign: 'center', color: D.muted }}>No mileage entries yet. Sync from Bouncie or add manually.</div>
      ) : (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, overflow: 'hidden', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isMobile ? 600 : undefined }}>
            <thead><tr>{['Date', 'From', 'To', 'Miles', 'Purpose', 'Deduction', 'Source'].map(h => <th key={h} style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {entries.slice(0, 50).map((e, i) => (
                <tr key={e.id || i} style={{ borderBottom: `1px solid ${D.border}22` }}>
                  <td style={{ padding: '8px 10px', fontSize: 12 }}>{fmtD(e.trip_date)}</td>
                  <td style={{ padding: '8px 10px', fontSize: 11, color: D.muted, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.start_address || '—'}</td>
                  <td style={{ padding: '8px 10px', fontSize: 11, color: D.muted, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.end_address || '—'}</td>
                  <td style={{ padding: '8px 10px', fontFamily: MONO, fontSize: 12, color: D.heading }}>{parseFloat(e.distance_miles || 0).toFixed(1)}</td>
                  <td style={{ padding: '8px 10px' }}><Badge color={e.purpose === 'business' ? D.green : D.muted}>{e.purpose}</Badge></td>
                  <td style={{ padding: '8px 10px', fontFamily: MONO, fontSize: 12, color: D.green }}>{fmtM(e.deduction_amount)}</td>
                  <td style={{ padding: '8px 10px' }}><Badge color={e.source === 'bouncie' ? D.teal : D.muted} small>{e.source || 'manual'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// REVENUE TAB (Sales Tax Reconciliation)
// ═══════════════════════════════════════════════════════════════
function RevenueTab() {
  const [month, setMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [reconcile, setReconcile] = useState(null);
  const [quarterly, setQuarterly] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const q = new Date().getMonth() < 3 ? 'Q1' : new Date().getMonth() < 6 ? 'Q2' : new Date().getMonth() < 9 ? 'Q3' : 'Q4';
    Promise.all([
      adminFetch(`/admin/tax/revenue/reconcile?month=${month}`).catch(() => null),
      adminFetch(`/admin/tax/revenue/quarterly-estimate?quarter=${q}`).catch(() => null),
    ]).then(([r, qe]) => { setReconcile(r); setQuarterly(qe); setLoading(false); });
  };
  useEffect(load, [month]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading revenue data...</div>;

  return (
    <div>
      {/* Month selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: D.muted }}>Month:</label>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={{ ...inputStyle, width: 160 }} />
      </div>

      {/* Reconciliation */}
      {reconcile && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <StatCard label="Revenue" value={fmtM(reconcile.totalRevenue)} color={D.green} />
          <StatCard label="Tax Collected" value={fmtM(reconcile.taxCollected)} color={D.amber} />
          <StatCard label="Tax Owed" value={fmtM(reconcile.taxOwed)} color={D.red} />
          <StatCard label="Difference" value={fmtM((reconcile.taxCollected || 0) - (reconcile.taxOwed || 0))} color={(reconcile.taxCollected || 0) >= (reconcile.taxOwed || 0) ? D.green : D.red} sub={(reconcile.taxCollected || 0) >= (reconcile.taxOwed || 0) ? 'Over-collected' : 'Under-collected'} />
        </div>
      )}

      {/* Quarterly Estimate */}
      {quarterly && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Quarterly Estimated Tax Payment — {quarterly.quarter}</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8, fontSize: 12 }}>
            {[
              ['YTD Revenue', fmtM(quarterly.ytdRevenue)],
              ['YTD Expenses', fmtM(quarterly.ytdExpenses)],
              ['Estimated Net Income', fmtM(quarterly.estimatedNetIncome)],
              ['Self-Employment Tax (15.3%)', fmtM(quarterly.seTax)],
              ['Estimated Income Tax', fmtM(quarterly.incomeTax)],
              ['Total Quarterly Payment', fmtM(quarterly.quarterlyPayment)],
            ].map(([l, v]) => (
              <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${D.border}22` }}>
                <span style={{ color: D.muted }}>{l}</span>
                <span style={{ color: D.heading, fontFamily: MONO }}>{v}</span>
              </div>
            ))}
          </div>
          {quarterly.dueDate && <div style={{ marginTop: 12, fontSize: 12, color: D.amber }}>Due: {fmtD(quarterly.dueDate)}</div>}
        </div>
      )}

      {!reconcile && !quarterly && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: 40, textAlign: 'center', color: D.muted }}>No revenue data available for this period.</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// P&L TAB
// ═══════════════════════════════════════════════════════════════
function PnlTab() {
  const [pnl, setPnl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('mtd');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let url = `/admin/tax/pnl?period=${period}`;
      if (period === 'custom' && customStart && customEnd) url += `&start_date=${customStart}&end_date=${customEnd}`;
      const data = await adminFetch(url);
      setPnl(data);
    } catch { setPnl(null); }
    setLoading(false);
  }, [period, customStart, customEnd]);

  useEffect(() => { load(); }, [load]);

  const downloadPnl = async () => {
    try {
      let url = `${API_BASE}/admin/tax/export/pnl?period=${period}`;
      if (period === 'custom' && customStart && customEnd) url += `&start_date=${customStart}&end_date=${customEnd}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` } });
      const blob = await resp.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `waves-pnl-${period}-${etDateString()}.csv`; a.click();
    } catch (e) { alert('Download failed: ' + e.message); }
  };

  const periods = [
    { id: 'mtd', label: 'This Month' }, { id: 'last_month', label: 'Last Month' },
    { id: 'quarterly', label: 'This Quarter' }, { id: 'ytd', label: 'YTD' },
    { id: 'last_year', label: 'Last Year' }, { id: 'custom', label: 'Custom' },
  ];

  const PnlRow = ({ label, value, bold, indent, color }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: `${bold ? 6 : 4}px 0`, borderBottom: bold ? `1px solid ${D.border}` : `1px solid ${D.border}22`, marginLeft: indent ? 20 : 0 }}>
      <span style={{ fontSize: 13, color: bold ? D.heading : D.muted, fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: bold ? 700 : 400, color: color || (bold ? D.heading : D.text), textAlign: 'right' }}>{fmtM(value)}</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>Profit & Loss Statement</div>
          <div style={{ fontSize: 11, color: D.muted }}>{pnl ? `${pnl.startDate} to ${pnl.endDate}` : 'Select a period'}</div>
        </div>
        <button onClick={downloadPnl} style={{ background: D.teal, border: 'none', borderRadius: 6, padding: '6px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Download P&L</button>
      </div>

      {/* Period selector */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {periods.map(p => (
          <button key={p.id} onClick={() => setPeriod(p.id)} style={{ background: period === p.id ? D.card : 'transparent', border: period === p.id ? `1px solid ${D.border}` : '1px solid transparent', borderRadius: 6, padding: '6px 12px', color: period === p.id ? D.heading : D.muted, fontSize: 12, cursor: 'pointer', fontWeight: period === p.id ? 600 : 400 }}>{p.label}</button>
        ))}
        {period === 'custom' && (
          <>
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ ...inputStyle, width: 130 }} />
            <span style={{ color: D.muted, fontSize: 11 }}>to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ ...inputStyle, width: 130 }} />
          </>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: D.muted }}>Loading P&L...</div>
      ) : pnl ? (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '20px 24px' }}>
          <PnlRow label="REVENUE" value={null} bold />
          <PnlRow label="Service Revenue" value={pnl.revenue?.serviceRevenue} indent />
          <PnlRow label="Other Revenue" value={pnl.revenue?.otherRevenue} indent />
          <PnlRow label="Total Revenue" value={pnl.revenue?.total} bold />

          <div style={{ height: 12 }} />
          <PnlRow label="COST OF GOODS SOLD" value={null} bold />
          <PnlRow label="Labor" value={pnl.cogs?.labor} indent />
          <PnlRow label="Materials & Supplies" value={pnl.cogs?.materials} indent />
          <PnlRow label="Total COGS" value={pnl.cogs?.total} bold />

          <div style={{ height: 12 }} />
          <PnlRow label="GROSS PROFIT" value={pnl.grossProfit} bold color={pnl.grossProfit >= 0 ? D.green : D.red} />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${D.border}22` }}>
            <span style={{ fontSize: 13, color: D.muted }}>Gross Margin</span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: D.text }}>{((pnl.grossMargin || 0) * 100).toFixed(1)}%</span>
          </div>

          <div style={{ height: 12 }} />
          <PnlRow label="OPERATING EXPENSES" value={null} bold />
          {pnl.operatingExpenses?.categories?.map((c, i) => (
            <PnlRow key={i} label={c.name} value={c.amount} indent />
          ))}
          <PnlRow label="Total Operating Expenses" value={pnl.operatingExpenses?.total} bold />

          <div style={{ height: 12 }} />
          <PnlRow label="DEDUCTIONS" value={null} bold />
          <PnlRow label="Mileage Deduction" value={pnl.deductions?.mileage} indent />
          <PnlRow label="Depreciation" value={pnl.deductions?.depreciation} indent />
          <PnlRow label="Total Deductions" value={pnl.deductions?.total} bold />

          <div style={{ height: 16 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: `2px solid ${D.border}` }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: D.heading }}>NET INCOME</span>
            <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 800, color: pnl.netIncome >= 0 ? D.green : D.red }}>{fmtM(pnl.netIncome)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span style={{ fontSize: 13, color: D.muted }}>Net Margin</span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: pnl.netIncome >= 0 ? D.green : D.red }}>{((pnl.netMargin || 0) * 100).toFixed(1)}%</span>
          </div>
        </div>
      ) : (
        <div style={{ padding: 40, textAlign: 'center', color: D.muted }}>No financial data available for this period.</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS TAB
// ═══════════════════════════════════════════════════════════════
function ExportsTab() {
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [startDate, setStartDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(etDateString());
  const [downloading, setDownloading] = useState('');

  const download = async (type, filename) => {
    setDownloading(type);
    try {
      let url = `${API_BASE}/admin/tax/export/${type}`;
      if (type === 'tax-package') { url += `?year=${year}`; }
      else if (type !== 'depreciation') { url += `?start_date=${startDate}&end_date=${endDate}`; }
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = filename; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { alert('Download failed: ' + e.message); }
    setDownloading('');
  };

  const exports = [
    { type: 'transactions', label: 'Transactions', desc: 'All payment transactions', icon: '$', color: D.green },
    { type: 'expenses', label: 'Expenses', desc: 'Schedule C categories', icon: 'E', color: D.amber },
    { type: 'mileage', label: 'Mileage', desc: 'IRS mileage log', icon: 'M', color: D.blue },
    { type: 'depreciation', label: 'Depreciation', desc: 'Equipment schedule', icon: 'D', color: D.purple },
    { type: 'labor', label: 'Labor', desc: 'Hours by technician', icon: 'L', color: D.teal },
    { type: 'pnl', label: 'P&L Statement', desc: 'Profit & Loss report', icon: 'P', color: D.green },
  ];

  return (
    <div>
      {/* Hero: Tax Package ZIP */}
      <div style={{ background: D.card, border: `2px solid ${D.teal}66`, borderRadius: 12, padding: '24px 28px', marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.heading, marginBottom: 4 }}>Download Complete Tax Package</div>
            <div style={{ fontSize: 12, color: D.muted }}>ZIP file with all CSVs + README for your CPA</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select value={year} onChange={e => setYear(e.target.value)} style={{ ...inputStyle, minWidth: 80 }}>
              <option value="2026">2026</option><option value="2025">2025</option><option value="2024">2024</option>
            </select>
            <button onClick={() => download('tax-package', `waves-tax-package-${year}.zip`)} disabled={downloading === 'tax-package'} style={{ background: D.teal, border: 'none', borderRadius: 8, padding: '10px 24px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: downloading === 'tax-package' ? 'not-allowed' : 'pointer', opacity: downloading === 'tax-package' ? 0.6 : 1 }}>
              {downloading === 'tax-package' ? 'Generating...' : 'Download ZIP'}
            </button>
          </div>
        </div>
      </div>

      {/* Date range for individual exports */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: D.muted }}>Date range:</span>
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...inputStyle, width: 130 }} />
        <span style={{ color: D.muted, fontSize: 11 }}>to</span>
        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ ...inputStyle, width: 130 }} />
      </div>

      {/* Export cards grid */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 10 }}>
        {exports.map(exp => (
          <div key={exp.type} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: `${exp.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 14, fontWeight: 800, color: exp.color }}>{exp.icon}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{exp.label}</div>
                <div style={{ fontSize: 11, color: D.muted }}>{exp.desc}</div>
              </div>
            </div>
            <button onClick={() => download(exp.type, `waves-${exp.type}-${startDate}-to-${endDate}.csv`)} disabled={downloading === exp.type} style={{ background: `${exp.color}22`, border: `1px solid ${exp.color}44`, borderRadius: 6, padding: '6px 12px', color: exp.color, fontSize: 11, fontWeight: 600, cursor: downloading === exp.type ? 'not-allowed' : 'pointer', marginTop: 'auto' }}>
              {downloading === exp.type ? 'Downloading...' : 'Download CSV'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ACCOUNTS RECEIVABLE TAB
// ═══════════════════════════════════════════════════════════════
function AccountsReceivableTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(null);

  useEffect(() => {
    adminFetch('/admin/tax/accounts-receivable')
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const sendReminder = async (inv) => {
    setSending(inv.id);
    try {
      await adminFetch('/admin/sms/send', {
        method: 'POST',
        body: JSON.stringify({
          to: inv.phone,
          message: `Hi ${inv.customerName}, this is Waves Pest Control. You have an outstanding balance of ${fmtM(inv.amount)} (Invoice #${inv.invoiceNumber}). Please call or reply to arrange payment. Thank you!`,
        }),
      });
      alert('Reminder sent!');
    } catch (e) { alert('Failed to send: ' + e.message); }
    setSending(null);
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: D.muted }}>Loading A/R...</div>;

  const s = data?.summary || { total: 0, current: 0, over30: 0, over60: 0, over90: 0, count: 0 };
  const invoices = data?.invoices || [];

  const bucketColor = (bucket) => {
    if (bucket === '90+') return D.red;
    if (bucket === '60') return D.orange;
    if (bucket === '30') return D.amber;
    return D.green;
  };

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 4 }}>Accounts Receivable Aging</div>
      <div style={{ fontSize: 11, color: D.muted, marginBottom: 14 }}>Outstanding invoices by aging bucket</div>

      {/* Aging summary cards */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatCard label="Total Outstanding" value={fmtM(s.total)} color={s.total > 500 ? D.red : D.white} sub={`${s.count} invoices`} />
        <StatCard label="Current" value={fmtM(s.current)} color={D.green} />
        <StatCard label="30 Days" value={fmtM(s.over30)} color={D.amber} />
        <StatCard label="60 Days" value={fmtM(s.over60)} color={D.orange} />
        <StatCard label="90+ Days" value={fmtM(s.over90)} color={D.red} />
      </div>

      {/* Invoices table */}
      {invoices.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: D.muted, fontSize: 13 }}>No outstanding invoices. All caught up!</div>
      ) : (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, overflow: 'hidden', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isMobile ? 650 : undefined }}>
            <thead>
              <tr>
                {['Customer', 'Invoice', 'Amount', 'Due Date', 'Days Overdue', 'Bucket', ''].map(h => (
                  <th key={h} style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv, i) => {
                const rowBg = inv.daysOverdue >= 90 ? `${D.red}11` : inv.daysOverdue >= 60 ? `${D.orange}11` : inv.daysOverdue >= 30 ? `${D.amber}11` : 'transparent';
                return (
                  <tr key={inv.id || i} style={{ background: rowBg, borderBottom: `1px solid ${D.border}22` }}>
                    <td style={{ padding: '8px 10px', fontSize: 12, color: D.heading, fontWeight: 500 }}>{inv.customerName}</td>
                    <td style={{ padding: '8px 10px', fontSize: 11, color: D.muted }}>{inv.invoiceNumber}</td>
                    <td style={{ padding: '8px 10px', fontFamily: MONO, fontSize: 13, fontWeight: 700, color: D.heading }}>{fmtM(inv.amount)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 11, color: D.muted }}>{fmtD(inv.dueDate)}</td>
                    <td style={{ padding: '8px 10px', fontFamily: MONO, fontSize: 12, fontWeight: 700, color: bucketColor(inv.bucket) }}>{inv.daysOverdue}d</td>
                    <td style={{ padding: '8px 10px' }}><Badge color={bucketColor(inv.bucket)}>{inv.bucket === '90+' ? '90+ days' : inv.bucket === '60' ? '60 days' : inv.bucket === '30' ? '30 days' : 'Current'}</Badge></td>
                    <td style={{ padding: '8px 10px' }}>
                      {inv.phone && inv.daysOverdue > 0 && (
                        <button onClick={() => sendReminder(inv)} disabled={sending === inv.id} style={{ background: `${D.amber}22`, border: `1px solid ${D.amber}44`, borderRadius: 4, padding: '3px 10px', color: D.amber, fontSize: 10, fontWeight: 600, cursor: sending === inv.id ? 'not-allowed' : 'pointer' }}>
                          {sending === inv.id ? 'Sending...' : 'Send Reminder'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function TaxPage() {
  const [activeTab, setActiveTab] = useState('overview');
  const [dashboard, setDashboard] = useState(null);
  const [quickPnl, setQuickPnl] = useState(null);
  const [arSummary, setArSummary] = useState(null);

  useEffect(() => {
    adminFetch('/admin/tax/dashboard').then(setDashboard).catch(() => {});
    adminFetch('/admin/tax/pnl?period=mtd').then(setQuickPnl).catch(() => {});
    adminFetch('/admin/tax/accounts-receivable').then(d => setArSummary(d?.summary)).catch(() => {});
  }, []);

  const d = dashboard;

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>Tax Center</h1>
      </div>

      {/* Dashboard stats */}
      {d && activeTab === 'overview' && (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <StatCard label="Tax Collected YTD" value={fmtM(d.ytdTaxCollected)} color={D.green} />
            <StatCard label="Expenses YTD" value={fmtM(d.expenses?.total)} color={D.amber} sub={`${d.expenses?.count || 0} records`} />
            <StatCard label="Equipment Book Value" value={fmtM(d.equipment?.bookValue)} color={D.teal} sub={`${d.equipment?.count || 0} assets`} />
            <StatCard label="Next Deadline" value={d.nextDeadlines?.[0] ? `${Math.max(0, daysUntil(d.nextDeadlines[0].dueDate))}d` : '—'} color={d.nextDeadlines?.[0] && daysUntil(d.nextDeadlines[0].dueDate) <= 14 ? D.red : D.blue} sub={d.nextDeadlines?.[0]?.title?.substring(0, 40)} />
          </div>

          {/* Latest advisor */}
          {d.latestReport && (
            <div style={{ background: D.card, border: `1px solid ${D.purple}44`, borderRadius: 10, padding: '14px 18px', marginBottom: 14, cursor: 'pointer' }} onClick={() => setActiveTab('advisor')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: D.purple, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>AI Tax Advisor</span>
                <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 800, color: { A: D.green, B: D.teal, C: D.amber }[d.latestReport.grade] || D.muted }}>{d.latestReport.grade}</span>
                <span style={{ fontSize: 11, color: D.muted }}>{fmtD(d.latestReport.date)}</span>
              </div>
              <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>{d.latestReport.summary?.substring(0, 200)}{d.latestReport.summary?.length > 200 ? '...' : ''}</div>
            </div>
          )}

          {/* Upcoming deadlines */}
          {d.nextDeadlines?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 8 }}>Upcoming Deadlines</div>
              {d.nextDeadlines.map(dl => {
                const days = daysUntil(dl.dueDate);
                return (
                  <div key={dl.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${days <= 7 ? D.red + '66' : D.border}` }}>
                    <Badge color={STATUS_COLORS[dl.status]}>{dl.status}</Badge>
                    <span style={{ fontSize: 12, color: D.heading, flex: 1 }}>{dl.title}</span>
                    <span style={{ fontSize: 11, color: D.muted }}>{fmtD(dl.dueDate)}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: days <= 7 ? D.red : days <= 30 ? D.amber : D.muted }}>{days}d</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Quick P&L + A/R + Tax Package row */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
            {/* Quick P&L */}
            <div onClick={() => setActiveTab('pnl')} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '14px 18px', cursor: 'pointer' }}>
              <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Quick P&L (MTD)</div>
              {quickPnl ? (
                <div style={{ fontSize: 12 }}>
                  {[
                    ['Revenue', quickPnl.revenue?.total, D.text],
                    ['COGS', quickPnl.cogs?.total, D.text],
                    ['Gross Profit', quickPnl.grossProfit, quickPnl.grossProfit >= 0 ? D.green : D.red],
                    ['OpEx', quickPnl.operatingExpenses?.total, D.text],
                    ['Net Income', quickPnl.netIncome, quickPnl.netIncome >= 0 ? D.green : D.red],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                      <span style={{ color: D.muted }}>{label}</span>
                      <span style={{ fontFamily: MONO, color, fontWeight: label === 'Net Income' ? 700 : 400 }}>{fmtM(val)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: D.muted, fontSize: 12 }}>No data yet</div>
              )}
            </div>

            {/* Outstanding A/R */}
            <div onClick={() => setActiveTab('ar')} style={{ background: D.card, border: `1px solid ${arSummary && arSummary.total > 500 ? D.red + '66' : D.border}`, borderRadius: 10, padding: '14px 18px', cursor: 'pointer' }}>
              <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Outstanding A/R</div>
              {arSummary ? (
                <>
                  <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: arSummary.total > 500 ? D.red : D.heading, marginBottom: 4 }}>{fmtM(arSummary.total)}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>{arSummary.count} unpaid invoice{arSummary.count !== 1 ? 's' : ''}</div>
                  {arSummary.over90 > 0 && <div style={{ fontSize: 11, color: D.red, marginTop: 4 }}>{fmtM(arSummary.over90)} over 90 days</div>}
                </>
              ) : (
                <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: D.green }}>$0.00</div>
              )}
            </div>

            {/* Download Tax Package */}
            <div style={{ background: D.card, border: `2px solid ${D.teal}44`, borderRadius: 10, padding: '14px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1 }}>CPA Tax Package</div>
              <button onClick={() => setActiveTab('exports')} style={{ background: D.teal, border: 'none', borderRadius: 8, padding: '10px 20px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Download Tax Package</button>
              <div style={{ fontSize: 10, color: D.muted }}>ZIP with all CSVs + README</div>
            </div>
          </div>
        </>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
        <TabBtn active={activeTab === 'overview'} label="Overview" onClick={() => setActiveTab('overview')} />
        <TabBtn active={activeTab === 'rates'} label="Tax Rates" onClick={() => setActiveTab('rates')} />
        <TabBtn active={activeTab === 'services'} label="Taxability" onClick={() => setActiveTab('services')} />
        <TabBtn active={activeTab === 'exemptions'} label="Exemptions" onClick={() => setActiveTab('exemptions')} />
        <TabBtn active={activeTab === 'equipment'} label="Equipment" onClick={() => setActiveTab('equipment')} />
        <TabBtn active={activeTab === 'expenses'} label="Expenses" onClick={() => setActiveTab('expenses')} />
        <TabBtn active={activeTab === 'mileage'} label="Mileage" onClick={() => setActiveTab('mileage')} color={D.green} />
        <TabBtn active={activeTab === 'revenue'} label="Revenue" onClick={() => setActiveTab('revenue')} color={D.green} />
        <TabBtn active={activeTab === 'pnl'} label="P&L" onClick={() => setActiveTab('pnl')} color={D.green} />
        <TabBtn active={activeTab === 'filings'} label="Filing Calendar" onClick={() => setActiveTab('filings')} color={D.blue} />
        <TabBtn active={activeTab === 'advisor'} label="AI Advisor" onClick={() => setActiveTab('advisor')} color={D.purple} count={d?.pendingAlerts?.high} />
        <TabBtn active={activeTab === 'exports'} label="Exports" onClick={() => setActiveTab('exports')} color={D.teal} />
        <TabBtn active={activeTab === 'ar'} label="A/R" onClick={() => setActiveTab('ar')} color={D.amber} />
      </div>

      {activeTab === 'rates' && <TaxRatesTab />}
      {activeTab === 'services' && <ServiceTaxabilityTab />}
      {activeTab === 'exemptions' && <ExemptionsTab />}
      {activeTab === 'equipment' && <EquipmentTab />}
      {activeTab === 'expenses' && <ExpensesTab />}
      {activeTab === 'mileage' && <MileageTab />}
      {activeTab === 'revenue' && <RevenueTab />}
      {activeTab === 'filings' && <FilingCalendarTab />}
      {activeTab === 'advisor' && <AdvisorTab />}
      {activeTab === 'pnl' && <PnlTab />}
      {activeTab === 'exports' && <ExportsTab />}
      {activeTab === 'ar' && <AccountsReceivableTab />}
    </div>
  );
}
