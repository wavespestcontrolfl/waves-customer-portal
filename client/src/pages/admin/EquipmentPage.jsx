import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', text: '#334155', muted: '#64748B', white: '#FFFFFF', input: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600 });
const sInput = { width: '100%', padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const fmt = (n) => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

const STATUS_COLORS = { active: D.green, maintenance: D.amber, retired: D.muted, pending: D.purple };
const CAT_ICONS = { sprayer: '🔫', pump: '⚙️', reel: '🔄', spreader: '📦', dethatcher: '🌱', backpack: '🎒', vehicle: '🚐', other: '🔧' };

const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

export default function EquipmentPage() {
  const [tab, setTab] = useState('equipment');
  const [toast, setToast] = useState('');
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: D.heading }}>Equipment & Job Costing</div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
        {[
          { key: 'equipment', label: 'Equipment' },
          { key: 'tank-mixes', label: 'Tank Mixes' },
          { key: 'job-costs', label: 'Job Costing' },
          { key: 'maintenance', label: 'Maintenance' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
            whiteSpace: 'nowrap', flexShrink: 0, minHeight: 44,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'equipment' && <EquipmentTab showToast={showToast} />}
      {tab === 'tank-mixes' && <TankMixTab showToast={showToast} />}
      {tab === 'job-costs' && <JobCostTab />}
      {tab === 'maintenance' && <MaintenanceTab showToast={showToast} />}

      <div style={{ position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none' }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ── Equipment Tab ──
function EquipmentTab({ showToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/equipment/equipment').then(d => setItems(d.equipment || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading equipment...</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
      {items.map(e => {
        const hoursLeft = e.next_service_hours ? e.next_service_hours - (e.current_hours || 0) : null;
        const needsService = hoursLeft !== null && hoursLeft <= 10;
        return (
          <div key={e.id} style={{ ...sCard, marginBottom: 0, borderLeft: `3px solid ${STATUS_COLORS[e.status] || D.muted}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{CAT_ICONS[e.category] || '🔧'} {e.name}</div>
                <div style={{ fontSize: 11, color: D.muted }}>{e.make} {e.model}</div>
              </div>
              <span style={sBadge(`${STATUS_COLORS[e.status]}22`, STATUS_COLORS[e.status])}>{e.status}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 11 }}>
              {e.current_hours > 0 && <div><span style={{ color: D.muted }}>Hours:</span> <span style={{ color: D.heading, fontFamily: MONO }}>{e.current_hours}</span></div>}
              {e.purchase_price > 0 && <div><span style={{ color: D.muted }}>Cost:</span> <span style={{ color: D.green, fontFamily: MONO }}>{fmt(e.purchase_price)}</span></div>}
              {e.book_value > 0 && <div><span style={{ color: D.muted }}>Book:</span> <span style={{ fontFamily: MONO }}>{fmt(e.book_value)}</span></div>}
              {e.last_service_date && <div><span style={{ color: D.muted }}>Last Svc:</span> <span>{new Date(e.last_service_date).toLocaleDateString()}</span></div>}
            </div>
            {e.specs && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                {Object.entries(typeof e.specs === 'string' ? JSON.parse(e.specs) : e.specs).map(([k, v]) => (
                  <span key={k} style={sBadge(`${D.teal}22`, D.teal)}>{k.replace(/_/g, ' ')}: {v}</span>
                ))}
              </div>
            )}
            {needsService && <div style={{ marginTop: 8, fontSize: 11, color: D.amber, fontWeight: 600 }}>⚠ Service due in {Math.round(hoursLeft)} hours — {e.next_service_type}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ── Tank Mix Tab ──
function TankMixTab({ showToast }) {
  const [mixes, setMixes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/equipment/tank-mixes').then(d => setMixes(d.mixes || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const recalculate = async (id) => {
    try {
      await adminFetch(`/admin/equipment/tank-mixes/${id}/recalculate`, { method: 'POST' });
      showToast('Costs recalculated from current inventory prices');
      const d = await adminFetch('/admin/equipment/tank-mixes');
      setMixes(d.mixes || []);
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading tank mixes...</div>;

  return (
    <div>
      {mixes.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No tank mixes configured yet. Add your standard mixes to track costs per application.</div>
      ) : mixes.map(m => {
        const products = typeof m.products === 'string' ? JSON.parse(m.products) : (m.products || []);
        return (
          <div key={m.id} style={{ ...sCard }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{m.name}</div>
                <div style={{ fontSize: 12, color: D.muted }}>{m.service_type} · {m.tank_size_gal}gal tank · covers {(m.coverage_sqft || 0).toLocaleString()} sqft</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: D.green }}>{fmt(m.cost_per_tank)}/tank</div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: D.muted }}>{fmt(m.cost_per_1000sf)}/1000sf</div>
                </div>
                <button onClick={() => recalculate(m.id)} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}`, padding: '4px 8px', fontSize: 10 }}>Recalc</button>
              </div>
            </div>
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isMobile ? 400 : undefined }}>
              <thead><tr>
                {['Product', 'Rate/1000sf', 'Oz/Tank', 'Cost'].map(h => <th key={h} style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '4px 8px', borderBottom: `1px solid ${D.border}22` }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {products.map((p, i) => (
                  <tr key={i}>
                    <td style={{ padding: '6px 8px', fontSize: 12, color: D.heading }}>{p.product_name}</td>
                    <td style={{ padding: '6px 8px', fontSize: 12, fontFamily: MONO }}>{p.rate_per_1000sf} {p.rate_unit}</td>
                    <td style={{ padding: '6px 8px', fontSize: 12, fontFamily: MONO }}>{p.oz_per_tank}</td>
                    <td style={{ padding: '6px 8px', fontSize: 12, fontFamily: MONO, color: D.green }}>{fmt(p.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Job Cost Tab ──
function JobCostTab() {
  const [summary, setSummary] = useState(null);
  const [costs, setCosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminFetch('/admin/equipment/job-costs/summary').catch(() => null),
      adminFetch('/admin/equipment/job-costs?limit=30').catch(() => ({ costs: [] })),
    ]).then(([s, c]) => { setSummary(s); setCosts(c.costs || []); setLoading(false); });
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading job costs...</div>;

  return (
    <div>
      {summary && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Avg Margin', value: summary.avgMargin ? `${summary.avgMargin.toFixed(1)}%` : '—', color: summary.avgMargin >= 50 ? D.green : D.amber },
            { label: 'Avg Revenue/Job', value: fmt(summary.avgRevenue), color: D.green },
            { label: 'Avg Cost/Job', value: fmt(summary.avgCost), color: D.amber },
            { label: 'Total Jobs Costed', value: summary.totalJobs || 0, color: D.heading },
          ].map(s => (
            <div key={s.label} style={{ ...sCard, flex: isMobile ? '1 1 calc(50% - 6px)' : '1 1 140px', minWidth: isMobile ? 0 : 140, marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontFamily: MONO, fontSize: isMobile ? 18 : 22, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* By service type */}
      {summary?.byServiceType && (
        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Margins by Service Type</div>
          {Object.entries(summary.byServiceType).map(([svc, stats]) => (
            <div key={svc} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${D.border}22`, fontSize: 12 }}>
              <span style={{ color: D.heading, fontWeight: 500 }}>{svc}</span>
              <div style={{ display: 'flex', gap: 16 }}>
                <span style={{ color: D.muted }}>{stats.count} jobs</span>
                <span style={{ color: D.green, fontFamily: MONO }}>Rev: {fmt(stats.avgRevenue)}</span>
                <span style={{ color: D.amber, fontFamily: MONO }}>Cost: {fmt(stats.avgCost)}</span>
                <span style={{ color: stats.avgMargin >= 50 ? D.green : D.amber, fontFamily: MONO, fontWeight: 700 }}>{stats.avgMargin?.toFixed(1)}%</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {costs.length === 0 && <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No job costs recorded yet</div>}
    </div>
  );
}

// ── Maintenance Tab ──
function MaintenanceTab({ showToast }) {
  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/equipment/equipment').then(d => {
      const items = (d.equipment || []).filter(e => {
        const hoursLeft = e.next_service_hours ? e.next_service_hours - (e.current_hours || 0) : null;
        return hoursLeft !== null && hoursLeft <= 50;
      });
      setEquipment(items);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>;

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Upcoming Maintenance</div>
      {equipment.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No equipment needs service soon</div>
      ) : equipment.map(e => {
        const hoursLeft = e.next_service_hours - (e.current_hours || 0);
        return (
          <div key={e.id} style={{ ...sCard, borderLeft: `3px solid ${hoursLeft <= 10 ? D.red : D.amber}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{e.name}</div>
                <div style={{ fontSize: 12, color: D.muted }}>{e.next_service_type} — in {Math.round(hoursLeft)} hours</div>
              </div>
              <button onClick={async () => {
                try {
                  await adminFetch(`/admin/equipment/equipment/${e.id}/maintenance`, { method: 'POST', body: JSON.stringify({ service_type: e.next_service_type, hours_at_service: e.current_hours }) });
                  showToast('Maintenance logged');
                } catch (err) { showToast(`Failed: ${err.message}`); }
              }} style={sBtn(D.green, D.white)}>Mark Complete</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
