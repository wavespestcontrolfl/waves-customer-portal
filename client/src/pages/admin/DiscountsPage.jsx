import { useState, useEffect, useCallback } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

function af(path, opts = {}) {
  return fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' }, ...opts }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, c) => ({ padding: '8px 16px', background: bg, color: c, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, c) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color: c, fontWeight: 600, display: 'inline-block' });
const sInput = { padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' };
const thS = { fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` };
const tdS = { padding: '10px', borderBottom: `1px solid ${D.border}22`, fontSize: 13 };

const TYPE_COLORS = { percentage: { bg: '#0ea5e920', c: D.teal }, fixed_amount: { bg: '#f59e0b20', c: D.amber }, free_service: { bg: '#10b98120', c: D.green } };
const EMPTY = { discount_key: '', name: '', description: '', discount_type: 'percentage', amount: 0, max_discount_dollars: '', applies_to: 'all', service_category_filter: '', service_key_filter: '', requires_waveguard_tier: '', is_waveguard_tier_discount: false, requires_military: false, requires_senior: false, requires_referral: false, requires_new_customer: false, requires_multi_home: false, requires_prepayment: false, min_service_count: '', min_subtotal: '', is_stackable: true, stack_group: '', priority: 100, promo_code: '', promo_code_expiry: '', promo_code_max_uses: '', is_active: true, is_auto_apply: false, show_in_estimates: true, show_in_invoices: true, show_in_scheduling: false, sort_order: '', color: '#0ea5e9', icon: '' };

export default function DiscountsPage() {
  const [discounts, setDiscounts] = useState([]);
  const [tab, setTab] = useState('catalog');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [toast, setToast] = useState('');
  const [previewCid, setPreviewCid] = useState('');
  const [previewSub, setPreviewSub] = useState('');
  const [previewResult, setPreviewResult] = useState(null);
  const [stats, setStats] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [custSearch, setCustSearch] = useState('');

  const load = useCallback(() => { af('/admin/discounts').then(setDiscounts).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  const show = (m) => { setToast(m); setTimeout(() => setToast(''), 3000); };

  const save = async () => {
    try {
      const payload = { ...form };
      if (!payload.promo_code) delete payload.promo_code;
      ['max_discount_dollars', 'min_service_count', 'min_subtotal', 'promo_code_max_uses', 'sort_order'].forEach(k => { if (payload[k] === '') payload[k] = null; });
      if (editing) {
        await af(`/admin/discounts/${editing}`, { method: 'PUT', body: JSON.stringify(payload) });
        show('Discount updated');
      } else {
        await af('/admin/discounts', { method: 'POST', body: JSON.stringify(payload) });
        show('Discount created');
      }
      load(); setTab('catalog'); setEditing(null); setForm({ ...EMPTY });
    } catch (e) { show('Error: ' + e.message); }
  };

  const toggleActive = async (d) => {
    await af(`/admin/discounts/${d.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !d.is_active }) });
    load();
  };

  const startEdit = (d) => {
    const f = { ...EMPTY };
    Object.keys(EMPTY).forEach(k => { if (d[k] !== null && d[k] !== undefined) f[k] = d[k]; });
    if (f.promo_code_expiry) f.promo_code_expiry = f.promo_code_expiry.slice(0, 16);
    setForm(f); setEditing(d.id); setTab('form');
  };

  const runPreview = async () => {
    try {
      const r = await af('/admin/discounts/calculate', { method: 'POST', body: JSON.stringify({ customerId: previewCid || null, subtotal: Number(previewSub) || 0 }) });
      setPreviewResult(r);
    } catch { show('Preview failed'); }
  };

  const searchCustomers = async (q) => {
    setCustSearch(q);
    if (q.length < 2) { setCustomers([]); return; }
    try {
      const r = await af(`/admin/customers?search=${encodeURIComponent(q)}&limit=5`);
      setCustomers(r.customers || r || []);
    } catch { setCustomers([]); }
  };

  const loadStats = () => { af('/admin/discounts/stats').then(setStats).catch(() => {}); };
  useEffect(() => { if (tab === 'stats') loadStats(); }, [tab]);

  const tabs = [{ key: 'catalog', label: 'Discount Catalog' }, { key: 'form', label: editing ? 'Edit Discount' : 'Create Discount' }, { key: 'preview', label: 'Preview' }, { key: 'stats', label: 'Stats' }];

  const upd = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const chk = (k) => <input type="checkbox" checked={form[k]} onChange={e => upd(k, e.target.checked)} />;

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: D.white }}>Discount Engine</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 2 }}>Manage discounts, promo codes, and pricing rules</div>
        </div>
        <button style={sBtn(D.teal, D.white)} onClick={() => { setEditing(null); setForm({ ...EMPTY }); setTab('form'); }}>+ New Discount</button>
      </div>

      {toast && <div style={{ ...sCard, background: D.teal + '20', color: D.teal, textAlign: 'center', fontSize: 13 }}>{toast}</div>}

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {tabs.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={{ ...sBtn(tab === t.key ? D.teal : 'transparent', tab === t.key ? D.white : D.muted), border: tab === t.key ? 'none' : `1px solid ${D.border}` }}>{t.label}</button>)}
      </div>

      {/* ── CATALOG ── */}
      {tab === 'catalog' && (
        <div style={sCard}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              {['', 'Name', 'Type', 'Amount', 'Eligibility', 'Stack', 'Auto', 'Used', 'Total Given', 'Active', ''].map(h => <th key={h} style={thS}>{h}</th>)}
            </tr></thead>
            <tbody>
              {discounts.map(d => {
                const tc = TYPE_COLORS[d.discount_type] || TYPE_COLORS.percentage;
                const rules = [d.requires_military && 'Military', d.requires_senior && 'Senior', d.requires_multi_home && 'Multi-home', d.requires_new_customer && 'New', d.requires_prepayment && 'Prepay', d.requires_referral && 'Referral', d.requires_waveguard_tier && d.requires_waveguard_tier].filter(Boolean);
                return (
                  <tr key={d.id} style={{ opacity: d.is_active ? 1 : 0.45 }}>
                    <td style={tdS}>{d.icon || ''}</td>
                    <td style={{ ...tdS, fontWeight: 600, color: D.white }}>{d.name}</td>
                    <td style={tdS}><span style={sBadge(tc.bg, tc.c)}>{d.discount_type}</span></td>
                    <td style={tdS}>{d.discount_type === 'percentage' ? `${d.amount}%` : d.discount_type === 'fixed_amount' ? `$${Number(d.amount).toFixed(2)}` : 'Free'}</td>
                    <td style={{ ...tdS, fontSize: 11 }}>{rules.length ? rules.join(', ') : <span style={{ color: D.muted }}>None</span>}</td>
                    <td style={{ ...tdS, fontSize: 11 }}>{d.stack_group || <span style={{ color: D.muted }}>-</span>}</td>
                    <td style={tdS}>{d.is_auto_apply ? <span style={sBadge(D.green + '20', D.green)}>Auto</span> : <span style={{ color: D.muted }}>Manual</span>}</td>
                    <td style={tdS}>{d.times_applied || 0}</td>
                    <td style={tdS}>${Number(d.total_discount_given || 0).toFixed(2)}</td>
                    <td style={tdS}><button style={{ ...sBtn(d.is_active ? D.green + '20' : D.red + '20', d.is_active ? D.green : D.red), fontSize: 11 }} onClick={() => toggleActive(d)}>{d.is_active ? 'On' : 'Off'}</button></td>
                    <td style={tdS}><button style={sBtn('transparent', D.teal)} onClick={() => startEdit(d)}>Edit</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── CREATE / EDIT FORM ── */}
      {tab === 'form' && (
        <div style={sCard}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.white, marginBottom: 16 }}>{editing ? 'Edit Discount' : 'New Discount'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* Basic info */}
            <label style={{ color: D.muted, fontSize: 11 }}>Key<input style={sInput} value={form.discount_key} onChange={e => upd('discount_key', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Name<input style={sInput} value={form.name} onChange={e => upd('name', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11, gridColumn: '1/-1' }}>Description<input style={sInput} value={form.description} onChange={e => upd('description', e.target.value)} /></label>

            {/* Mechanics */}
            <label style={{ color: D.muted, fontSize: 11 }}>Type
              <select style={sInput} value={form.discount_type} onChange={e => upd('discount_type', e.target.value)}>
                <option value="percentage">Percentage</option><option value="fixed_amount">Fixed Amount</option><option value="free_service">Free Service</option>
              </select>
            </label>
            <label style={{ color: D.muted, fontSize: 11 }}>Amount {form.discount_type === 'percentage' ? '(%)' : '($)'}<input type="number" style={sInput} value={form.amount} onChange={e => upd('amount', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Max Discount ($)<input type="number" style={sInput} value={form.max_discount_dollars} onChange={e => upd('max_discount_dollars', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Priority (lower = first)<input type="number" style={sInput} value={form.priority} onChange={e => upd('priority', e.target.value)} /></label>

            {/* Eligibility */}
            <div style={{ gridColumn: '1/-1', borderTop: `1px solid ${D.border}`, paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, marginBottom: 8 }}>ELIGIBILITY RULES</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                <label style={{ color: D.text, fontSize: 12 }}>{chk('requires_military')} Military</label>
                <label style={{ color: D.text, fontSize: 12 }}>{chk('requires_senior')} Senior</label>
                <label style={{ color: D.text, fontSize: 12 }}>{chk('requires_multi_home')} Multi-Home</label>
                <label style={{ color: D.text, fontSize: 12 }}>{chk('requires_new_customer')} New Customer</label>
                <label style={{ color: D.text, fontSize: 12 }}>{chk('requires_referral')} Referral</label>
                <label style={{ color: D.text, fontSize: 12 }}>{chk('requires_prepayment')} Prepayment</label>
                <label style={{ color: D.text, fontSize: 12 }}>{chk('is_waveguard_tier_discount')} Tier Discount</label>
              </div>
            </div>
            <label style={{ color: D.muted, fontSize: 11 }}>Requires WaveGuard Tier
              <select style={sInput} value={form.requires_waveguard_tier} onChange={e => upd('requires_waveguard_tier', e.target.value)}>
                <option value="">Any / None</option><option>Bronze</option><option>Silver</option><option>Gold</option><option>Platinum</option>
              </select>
            </label>
            <label style={{ color: D.muted, fontSize: 11 }}>Min Subtotal ($)<input type="number" style={sInput} value={form.min_subtotal} onChange={e => upd('min_subtotal', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Min Service Count<input type="number" style={sInput} value={form.min_service_count} onChange={e => upd('min_service_count', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Service Key Filter<input style={sInput} value={form.service_key_filter} onChange={e => upd('service_key_filter', e.target.value)} /></label>

            {/* Stacking */}
            <div style={{ gridColumn: '1/-1', borderTop: `1px solid ${D.border}`, paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, marginBottom: 8 }}>STACKING & VISIBILITY</div>
            </div>
            <label style={{ color: D.muted, fontSize: 11 }}>Stack Group<input style={sInput} value={form.stack_group} onChange={e => upd('stack_group', e.target.value)} /></label>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <label style={{ color: D.text, fontSize: 12 }}>{chk('is_stackable')} Stackable</label>
              <label style={{ color: D.text, fontSize: 12 }}>{chk('is_auto_apply')} Auto-Apply</label>
              <label style={{ color: D.text, fontSize: 12 }}>{chk('is_active')} Active</label>
            </div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', gridColumn: '1/-1' }}>
              <label style={{ color: D.text, fontSize: 12 }}>{chk('show_in_estimates')} Show in Estimates</label>
              <label style={{ color: D.text, fontSize: 12 }}>{chk('show_in_invoices')} Show in Invoices</label>
              <label style={{ color: D.text, fontSize: 12 }}>{chk('show_in_scheduling')} Show in Scheduling</label>
            </div>

            {/* Promo Code */}
            <div style={{ gridColumn: '1/-1', borderTop: `1px solid ${D.border}`, paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, marginBottom: 8 }}>PROMO CODE</div>
            </div>
            <label style={{ color: D.muted, fontSize: 11 }}>Code<input style={sInput} value={form.promo_code} onChange={e => upd('promo_code', e.target.value)} placeholder="e.g. SUMMER25" /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Expiry<input type="datetime-local" style={sInput} value={form.promo_code_expiry} onChange={e => upd('promo_code_expiry', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Max Uses<input type="number" style={sInput} value={form.promo_code_max_uses} onChange={e => upd('promo_code_max_uses', e.target.value)} /></label>

            {/* Appearance */}
            <label style={{ color: D.muted, fontSize: 11 }}>Color<input type="color" style={{ ...sInput, height: 36, padding: 2 }} value={form.color} onChange={e => upd('color', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Icon (emoji)<input style={sInput} value={form.icon} onChange={e => upd('icon', e.target.value)} /></label>
            <label style={{ color: D.muted, fontSize: 11 }}>Sort Order<input type="number" style={sInput} value={form.sort_order} onChange={e => upd('sort_order', e.target.value)} /></label>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button style={sBtn(D.teal, D.white)} onClick={save}>{editing ? 'Update' : 'Create'}</button>
            <button style={sBtn('transparent', D.muted)} onClick={() => { setTab('catalog'); setEditing(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── PREVIEW ── */}
      {tab === 'preview' && (
        <div style={sCard}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.white, marginBottom: 16 }}>Discount Preview</div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ color: D.muted, fontSize: 11 }}>Customer Search</label>
              <input style={sInput} value={custSearch} onChange={e => searchCustomers(e.target.value)} placeholder="Name, email, or phone" />
              {customers.length > 0 && (
                <div style={{ background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, marginTop: 4, maxHeight: 150, overflow: 'auto' }}>
                  {customers.map(c => (
                    <div key={c.id} style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 12, color: D.text, borderBottom: `1px solid ${D.border}22` }}
                      onClick={() => { setPreviewCid(c.id); setCustSearch(`${c.first_name} ${c.last_name}`); setCustomers([]); }}>
                      {c.first_name} {c.last_name} — {c.waveguard_tier || 'No tier'} {c.is_military ? '(Military)' : ''} {c.is_senior ? '(Senior)' : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ width: 160 }}>
              <label style={{ color: D.muted, fontSize: 11 }}>Subtotal ($)</label>
              <input type="number" style={sInput} value={previewSub} onChange={e => setPreviewSub(e.target.value)} placeholder="250.00" />
            </div>
            <div style={{ alignSelf: 'flex-end' }}>
              <button style={sBtn(D.teal, D.white)} onClick={runPreview}>Calculate</button>
            </div>
          </div>
          {previewResult && (
            <div>
              <div style={{ display: 'flex', gap: 20, marginBottom: 16 }}>
                <div style={{ ...sCard, flex: 1, textAlign: 'center' }}><div style={{ color: D.muted, fontSize: 11 }}>Subtotal</div><div style={{ color: D.white, fontSize: 20, fontWeight: 700 }}>${previewResult.subtotal.toFixed(2)}</div></div>
                <div style={{ ...sCard, flex: 1, textAlign: 'center' }}><div style={{ color: D.muted, fontSize: 11 }}>Discount</div><div style={{ color: D.red, fontSize: 20, fontWeight: 700 }}>-${previewResult.totalDiscount.toFixed(2)}</div></div>
                <div style={{ ...sCard, flex: 1, textAlign: 'center' }}><div style={{ color: D.muted, fontSize: 11 }}>After Discount</div><div style={{ color: D.green, fontSize: 20, fontWeight: 700 }}>${previewResult.afterDiscount.toFixed(2)}</div></div>
              </div>
              {previewResult.discounts.length === 0 && <div style={{ color: D.muted, textAlign: 'center', padding: 20 }}>No applicable discounts</div>}
              {previewResult.discounts.map((d, i) => {
                const tc = TYPE_COLORS[d.discount_type] || TYPE_COLORS.percentage;
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${D.border}22` }}>
                    <div><span style={{ marginRight: 8 }}>{d.icon}</span><span style={{ color: D.white, fontWeight: 600 }}>{d.name}</span> <span style={sBadge(tc.bg, tc.c)}>{d.discount_type === 'percentage' ? `${d.amount}%` : d.discount_type === 'fixed_amount' ? `$${d.amount}` : 'Free'}</span></div>
                    <div style={{ color: D.red, fontWeight: 600 }}>-${d.discount_dollars.toFixed(2)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── STATS ── */}
      {tab === 'stats' && stats && (
        <div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ ...sCard, flex: 1, textAlign: 'center' }}><div style={{ color: D.muted, fontSize: 11 }}>Total Applications</div><div style={{ color: D.white, fontSize: 24, fontWeight: 700 }}>{stats.totalApplied}</div></div>
            <div style={{ ...sCard, flex: 1, textAlign: 'center' }}><div style={{ color: D.muted, fontSize: 11 }}>Total Discounts Given</div><div style={{ color: D.amber, fontSize: 24, fontWeight: 700 }}>${stats.totalGiven.toFixed(2)}</div></div>
          </div>
          <div style={sCard}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Name', 'Key', 'Times Applied', 'Total Given', 'Active'].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
              <tbody>
                {stats.discounts.map(d => (
                  <tr key={d.id}>
                    <td style={{ ...tdS, fontWeight: 600, color: D.white }}>{d.name}</td>
                    <td style={{ ...tdS, color: D.muted, fontSize: 11 }}>{d.discount_key}</td>
                    <td style={tdS}>{d.times_applied || 0}</td>
                    <td style={tdS}>${Number(d.total_discount_given || 0).toFixed(2)}</td>
                    <td style={tdS}>{d.is_active ? <span style={sBadge(D.green + '20', D.green)}>Active</span> : <span style={sBadge(D.red + '20', D.red)}>Inactive</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
