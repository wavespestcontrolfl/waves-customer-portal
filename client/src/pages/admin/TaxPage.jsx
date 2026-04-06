import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', cardHover: '#253347', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#a855f7', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', blue: '#3b82f6', orange: '#f97316' };
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
    <div onClick={onClick} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: '16px 20px', flex: '1 1 0', minWidth: 140, cursor: onClick ? 'pointer' : 'default', transition: 'border-color 0.15s' }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = color || D.teal; }} onMouseLeave={e => { e.currentTarget.style.borderColor = D.border; }}>
      <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: color || D.white }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
function TabBtn({ active, label, count, onClick, color }) {
  return <button onClick={onClick} style={{ background: active ? D.card : 'transparent', border: active ? `1px solid ${D.border}` : '1px solid transparent', borderRadius: 8, padding: '8px 14px', color: active ? D.white : D.muted, fontSize: 12, cursor: 'pointer', fontWeight: active ? 600 : 400, transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 5 }}>{label}{count != null && <span style={{ background: `${color || D.teal}22`, color: color || D.teal, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 9999 }}>{count}</span>}</button>;
}
const inputStyle = { background: '#0f1923', border: `1px solid ${D.border}`, borderRadius: 6, padding: '6px 10px', color: D.text, fontSize: 12, fontFamily: 'inherit', outline: 'none' };
const fmtD = (d) => d ? new Date(d).toLocaleDateString() : '—';
const fmtM = (n) => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const fmtPct = (n) => n != null ? (n * 100).toFixed(2) + '%' : '—';

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
      <div style={{ fontSize: 13, fontWeight: 600, color: D.white, marginBottom: 12 }}>Florida Sales Tax Rates by County</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {rates.filter(r => r.active).map(r => (
          <div key={r.id} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: D.white }}>{r.county} County</span>
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
  useEffect(() => { adminFetch('/admin/tax/service-taxability').then(d => setServices(d.services || [])).catch(() => {}); }, []);
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.white, marginBottom: 4 }}>Service Taxability Matrix</div>
      <div style={{ fontSize: 11, color: D.muted, marginBottom: 14 }}>Which services require FL sales tax collection</div>
      {services.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, marginBottom: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.isTaxable ? D.green : D.muted, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{s.serviceLabel}</span>
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
          <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>Equipment & Depreciation Register</div>
          <div style={{ fontSize: 11, color: D.muted }}>Section 179 & MACRS tracking</div>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} style={{ background: D.teal, border: 'none', borderRadius: 6, padding: '6px 14px', color: D.white, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Add Equipment</button>
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
          <button onClick={handleAdd} style={{ background: D.green, border: 'none', borderRadius: 6, padding: '6px 14px', color: D.white, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
          <button onClick={() => setShowAdd(false)} style={{ background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6, padding: '6px 10px', color: D.muted, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {equipment.filter(e => e.active).map(e => (
        <div key={e.id} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: '12px 14px', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: D.white, flex: 1 }}>{e.name}</span>
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
          <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>Business Expenses</div>
          <select value={yearFilter} onChange={e => setYearFilter(e.target.value)} style={{ ...inputStyle, minWidth: 80 }}>
            <option value="2026">2026</option><option value="2025">2025</option><option value="2024">2024</option>
          </select>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} style={{ background: D.teal, border: 'none', borderRadius: 6, padding: '6px 14px', color: D.white, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Add Expense</button>
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
          <button onClick={handleAdd} style={{ background: D.green, border: 'none', borderRadius: 6, padding: '6px 14px', color: D.white, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
          <button onClick={() => setShowAdd(false)} style={{ background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6, padding: '6px 10px', color: D.muted, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {/* Category summary */}
      {summary.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>By Schedule C Category</div>
          {summary.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${D.border}` }}>
              <span style={{ fontSize: 12, color: D.white, fontWeight: 500, flex: 1 }}>{c.category || 'Uncategorized'}</span>
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
          <span style={{ fontSize: 12, color: D.white, flex: 1 }}>{e.description}</span>
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
      if (status === 'filed') update.filedDate = new Date().toISOString().split('T')[0];
      if (status === 'paid') update.paidDate = new Date().toISOString().split('T')[0];
      await adminFetch(`/admin/tax/filings/${id}`, { method: 'PUT', body: JSON.stringify(update) });
      load();
    } catch (e) { alert('Failed: ' + e.message); }
  };

  const upcoming = filings.filter(f => f.status === 'upcoming' || f.status === 'prepared');
  const completed = filings.filter(f => f.status === 'filed' || f.status === 'paid');

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.white, marginBottom: 14 }}>Tax Filing Calendar</div>

      {/* Upcoming */}
      <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Upcoming Deadlines</div>
      {upcoming.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: D.muted, fontSize: 12, marginBottom: 16 }}>All caught up!</div>}
      {upcoming.map(f => {
        const daysUntil = Math.ceil((new Date(f.dueDate) - new Date()) / 86400000);
        const urgentColor = daysUntil <= 7 ? D.red : daysUntil <= 30 ? D.amber : D.muted;
        return (
          <div key={f.id} style={{ background: D.card, border: `1px solid ${daysUntil <= 7 ? D.red + '66' : D.border}`, borderRadius: 8, padding: '12px 14px', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: D.white, flex: 1 }}>{f.title}</span>
              <Badge color={STATUS_COLORS[f.status]}>{f.status}</Badge>
              <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: urgentColor }}>{daysUntil > 0 ? `${daysUntil}d` : daysUntil === 0 ? 'TODAY' : `${Math.abs(daysUntil)}d OVERDUE`}</span>
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

  const load = useCallback(async () => {
    try {
      const [rpt, alt] = await Promise.all([adminFetch('/admin/tax/advisor/reports'), adminFetch(`/admin/tax/advisor/alerts?status=${alertFilter}`)]);
      setReports(rpt.reports || []); setAlerts(alt.alerts || []); setAlertCounts(alt.counts || {});
      if (rpt.reports?.length && !selectedReport) setSelectedReport(rpt.reports[0]);
    } catch { }
  }, [alertFilter, selectedReport]);

  useEffect(() => { load(); }, [load]);

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
          <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>AI Tax Advisor</div>
          <div style={{ fontSize: 11, color: D.muted }}>Weekly analysis of tax situation, regulations & savings</div>
        </div>
        <button onClick={handleRunAdvisor} disabled={running} style={{ background: running ? D.border : D.purple, border: 'none', borderRadius: 6, padding: '6px 16px', color: D.white, fontSize: 12, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.6 : 1 }}>
          {running ? 'Running analysis...' : 'Run Advisor Now'}
        </button>
      </div>

      {/* Alerts */}
      {(alertCounts.new || 0) > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: D.white }}>Action Items</div>
            {['new', 'reviewed', 'acted_on', 'dismissed'].map(s => (
              <button key={s} onClick={() => { setAlertFilter(s); }} style={{ background: alertFilter === s ? D.card : 'transparent', border: alertFilter === s ? `1px solid ${D.border}` : '1px solid transparent', borderRadius: 4, padding: '3px 8px', fontSize: 10, color: alertFilter === s ? D.white : D.muted, cursor: 'pointer', textTransform: 'capitalize' }}>
                {s.replace('_', ' ')} {alertCounts[s] ? `(${alertCounts[s]})` : ''}
              </button>
            ))}
          </div>
          {alerts.map(a => (
            <div key={a.id} style={{ background: D.card, border: `1px solid ${PRIORITY_COLORS[a.priority]}44`, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Badge color={PRIORITY_COLORS[a.priority]} small>{a.priority}</Badge>
                <Badge color={D.teal} small>{a.type}</Badge>
                <span style={{ fontSize: 12, fontWeight: 600, color: D.white, flex: 1 }}>{a.title}</span>
                {a.estimatedSavings && <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: D.green }}>~{fmtM(a.estimatedSavings)}/yr</span>}
              </div>
              {a.description && <div style={{ fontSize: 11, color: D.muted, marginBottom: 6 }}>{a.description}</div>}
              <div style={{ display: 'flex', gap: 4 }}>
                {a.status === 'new' && <button onClick={() => handleAlertAction(a.id, 'reviewed')} style={{ background: D.teal, border: 'none', borderRadius: 4, padding: '3px 10px', color: D.white, fontSize: 10, cursor: 'pointer' }}>Mark Reviewed</button>}
                {(a.status === 'new' || a.status === 'reviewed') && <button onClick={() => handleAlertAction(a.id, 'acted_on')} style={{ background: D.green, border: 'none', borderRadius: 4, padding: '3px 10px', color: D.white, fontSize: 10, cursor: 'pointer' }}>Done</button>}
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
            <button key={rp.id} onClick={() => setSelectedReport(rp)} style={{ background: selectedReport?.id === rp.id ? D.card : 'transparent', border: selectedReport?.id === rp.id ? `1px solid ${D.border}` : '1px solid transparent', borderRadius: 6, padding: '4px 10px', fontSize: 11, color: selectedReport?.id === rp.id ? D.white : D.muted, cursor: 'pointer' }}>
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
                <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{r.period}</div>
                <div style={{ fontSize: 12, color: D.muted }}>{r.date}</div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: D.text, lineHeight: 1.6 }}>{r.summary}</div>
          </div>

          {/* Regulation changes */}
          {r.regulationChanges?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.white, marginBottom: 8 }}>📜 Regulation Changes Found</div>
              {r.regulationChanges.map((rc, i) => (
                <div key={i} style={{ background: D.card, border: `1px solid ${D.amber}44`, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.white, marginBottom: 4 }}>{rc.change}</div>
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
              <div style={{ fontSize: 12, fontWeight: 600, color: D.white, marginBottom: 8 }}>💰 Savings Opportunities</div>
              {r.savingsOpportunities.map((s, i) => (
                <div key={i} style={{ background: D.card, border: `1px solid ${D.green}33`, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge color={PRIORITY_COLORS[s.priority]} small>{s.priority}</Badge>
                    <span style={{ fontSize: 12, fontWeight: 600, color: D.white, flex: 1 }}>{s.title}</span>
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
              <div style={{ fontSize: 12, fontWeight: 600, color: D.white, marginBottom: 8 }}>🔍 Deduction Gaps</div>
              {r.deductionGaps.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${D.border}` }}>
                  <span style={{ fontSize: 12, color: D.white, flex: 1 }}>{d.deduction}</span>
                  {d.estimated_value && <span style={{ fontFamily: MONO, fontSize: 12, color: D.green }}>{fmtM(d.estimated_value)}</span>}
                  {d.irs_reference && <span style={{ fontSize: 10, color: D.muted }}>{d.irs_reference}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Compliance alerts */}
          {r.complianceAlerts?.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.white, marginBottom: 8 }}>⚠️ Compliance Alerts</div>
              {r.complianceAlerts.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${PRIORITY_COLORS[a.severity] || D.border}44` }}>
                  <Badge color={PRIORITY_COLORS[a.severity]} small>{a.severity}</Badge>
                  <span style={{ fontSize: 12, color: D.white, flex: 1 }}>{a.alert}</span>
                  {a.deadline && <span style={{ fontSize: 11, color: D.amber }}>By: {a.deadline}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🤖</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 6 }}>No Advisor Reports Yet</div>
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
      <div style={{ fontSize: 13, fontWeight: 600, color: D.white, marginBottom: 4 }}>Tax Exemption Certificates</div>
      <div style={{ fontSize: 11, color: D.muted, marginBottom: 14 }}>DR-14 exemption certificates for tax-exempt customers</div>
      {exemptions.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: D.muted, fontSize: 13 }}>No exemption certificates on file. Add one when a customer provides a DR-14.</div>
      ) : (
        exemptions.map(e => (
          <div key={e.id} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: D.white, flex: 1 }}>{e.customerName}</span>
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
export default function TaxPage() {
  const [activeTab, setActiveTab] = useState('overview');
  const [dashboard, setDashboard] = useState(null);

  useEffect(() => { adminFetch('/admin/tax/dashboard').then(setDashboard).catch(() => {}); }, []);

  const d = dashboard;

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: D.white, margin: 0, fontFamily: "'DM Sans', sans-serif" }}>Tax Center</h1>
        <p style={{ fontSize: 13, color: D.muted, margin: '4px 0 0' }}>Tax rates, filing calendar, expenses, depreciation & AI tax advisor</p>
      </div>

      {/* Dashboard stats */}
      {d && activeTab === 'overview' && (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <StatCard label="Tax Collected YTD" value={fmtM(d.ytdTaxCollected)} color={D.green} />
            <StatCard label="Expenses YTD" value={fmtM(d.expenses?.total)} color={D.amber} sub={`${d.expenses?.count || 0} records`} />
            <StatCard label="Equipment Book Value" value={fmtM(d.equipment?.bookValue)} color={D.teal} sub={`${d.equipment?.count || 0} assets`} />
            <StatCard label="Next Deadline" value={d.nextDeadlines?.[0] ? `${Math.max(0, Math.ceil((new Date(d.nextDeadlines[0].dueDate) - new Date()) / 86400000))}d` : '—'} color={d.nextDeadlines?.[0] && Math.ceil((new Date(d.nextDeadlines[0].dueDate) - new Date()) / 86400000) <= 14 ? D.red : D.blue} sub={d.nextDeadlines?.[0]?.title?.substring(0, 40)} />
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
              <div style={{ fontSize: 12, fontWeight: 600, color: D.white, marginBottom: 8 }}>Upcoming Deadlines</div>
              {d.nextDeadlines.map(dl => {
                const days = Math.ceil((new Date(dl.dueDate) - new Date()) / 86400000);
                return (
                  <div key={dl.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: D.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${days <= 7 ? D.red + '66' : D.border}` }}>
                    <Badge color={STATUS_COLORS[dl.status]}>{dl.status}</Badge>
                    <span style={{ fontSize: 12, color: D.white, flex: 1 }}>{dl.title}</span>
                    <span style={{ fontSize: 11, color: D.muted }}>{fmtD(dl.dueDate)}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: days <= 7 ? D.red : days <= 30 ? D.amber : D.muted }}>{days}d</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabBtn active={activeTab === 'overview'} label="Overview" onClick={() => setActiveTab('overview')} />
        <TabBtn active={activeTab === 'rates'} label="Tax Rates" onClick={() => setActiveTab('rates')} />
        <TabBtn active={activeTab === 'services'} label="Taxability" onClick={() => setActiveTab('services')} />
        <TabBtn active={activeTab === 'exemptions'} label="Exemptions" onClick={() => setActiveTab('exemptions')} />
        <TabBtn active={activeTab === 'equipment'} label="Equipment" onClick={() => setActiveTab('equipment')} />
        <TabBtn active={activeTab === 'expenses'} label="Expenses" onClick={() => setActiveTab('expenses')} />
        <TabBtn active={activeTab === 'filings'} label="Filing Calendar" onClick={() => setActiveTab('filings')} color={D.blue} />
        <TabBtn active={activeTab === 'advisor'} label="AI Advisor" onClick={() => setActiveTab('advisor')} color={D.purple} count={d?.pendingAlerts?.high} />
      </div>

      {activeTab === 'rates' && <TaxRatesTab />}
      {activeTab === 'services' && <ServiceTaxabilityTab />}
      {activeTab === 'exemptions' && <ExemptionsTab />}
      {activeTab === 'equipment' && <EquipmentTab />}
      {activeTab === 'expenses' && <ExpensesTab />}
      {activeTab === 'filings' && <FilingCalendarTab />}
      {activeTab === 'advisor' && <AdvisorTab />}
    </div>
  );
}
