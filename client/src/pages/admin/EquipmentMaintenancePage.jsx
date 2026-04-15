import { useState, useEffect, useCallback, useMemo } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', text: '#334155', muted: '#64748B', white: '#FFFFFF', input: '#FFFFFF', darkCard: '#F8FAFC', heading: '#0F172A', inputBorder: '#CBD5E1' };

function af(path, opts = {}) {
  return fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' }, ...opts })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sBtn = (bg, c) => ({ padding: '8px 16px', background: bg, color: c, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, c) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color: c, fontWeight: 600, display: 'inline-block' });
const sInput = { width: '100%', padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const fmt = n => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
const fmtN = n => n != null ? Number(n).toLocaleString() : '--';
const CAT_ICONS = { vehicle: '\u{1F690}', sprayer: '\u{1F4A7}', pump: '\u2699\uFE0F', reel: '\u{1F504}', injection: '\u{1F489}', dethatcher: '\u{1F33F}', topdresser: '\u{1F33E}', mower: '\u{1F33F}', trailer: '\u{1F69A}', tool: '\u{1F527}', safety: '\u{1F6E1}\uFE0F', other: '\u{1F527}' };
const STATUS_COLORS = { active: D.green, in_service: D.teal, retired: D.muted, sold: D.muted, lost: D.red };
const SEV_COLORS = { critical: D.red, high: '#f97316', medium: D.amber, low: D.teal };
const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

function ConditionBar({ rating }) {
  const r = rating || 5;
  const color = r >= 8 ? D.green : r >= 5 ? D.amber : D.red;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 6, background: D.input, borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
        <div style={{ width: `${r * 10}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, color, fontWeight: 600, minWidth: 20 }}>{r}/10</span>
    </div>
  );
}

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ ...sCard, flex: '1 1 160px', minWidth: 140, textAlign: 'center', padding: 16 }}>
      <div style={{ fontSize: 11, color: D.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || D.white }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════
export default function EquipmentMaintenancePage() {
  const [tab, setTab] = useState('fleet');
  const [toast, setToast] = useState('');
  const showToast = m => { setToast(m); setTimeout(() => setToast(''), 3500); };

  // Fleet state
  const [equipment, setEquipment] = useState([]);
  const [overview, setOverview] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterCat, setFilterCat] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [expandedId, setExpandedId] = useState(null);

  // Analytics state
  const [costs, setCosts] = useState([]);
  const [reliability, setReliability] = useState([]);
  const [mileageSummary, setMileageSummary] = useState(null);
  const [dueSchedules, setDueSchedules] = useState([]);
  const [monthlyCosts, setMonthlyCosts] = useState([]);

  const loadFleet = useCallback(async () => {
    setLoading(true);
    try {
      const [eqRes, ovRes, alRes] = await Promise.all([
        af('/admin/equipment-maintenance'),
        af('/admin/equipment-maintenance/analytics/overview'),
        af('/admin/equipment-maintenance/alerts?status=new'),
      ]);
      setEquipment(eqRes.equipment || []);
      setOverview(ovRes);
      setAlerts(alRes.alerts || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  const loadAnalytics = useCallback(async () => {
    try {
      const [cRes, rRes, mRes, dRes, recRes] = await Promise.all([
        af('/admin/equipment-maintenance/analytics/costs'),
        af('/admin/equipment-maintenance/analytics/reliability'),
        af('/admin/equipment-maintenance/mileage/summary'),
        af('/admin/equipment-maintenance/schedules/due'),
        af('/admin/equipment-maintenance/records/recent?limit=100'),
      ]);
      setCosts(cRes.costs || []);
      setReliability(rRes.reliability || []);
      setMileageSummary(mRes);
      setDueSchedules(dRes.schedules || []);

      // Build monthly cost trend from recent records
      const byMonth = {};
      (recRes.records || []).forEach(r => {
        const m = (r.performed_at || '').slice(0, 7);
        if (m) byMonth[m] = (byMonth[m] || 0) + parseFloat(r.total_cost || 0);
      });
      const months = Object.keys(byMonth).sort().slice(-6);
      setMonthlyCosts(months.map(m => ({ month: m, cost: byMonth[m] })));
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadFleet(); }, [loadFleet]);
  useEffect(() => { if (tab === 'analytics') loadAnalytics(); }, [tab, loadAnalytics]);

  const filtered = useMemo(() => {
    let list = [...equipment];
    if (filterCat) list = list.filter(e => e.category === filterCat);
    if (filterStatus) list = list.filter(e => e.status === filterStatus);
    list.sort((a, b) => {
      if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
      if (sortBy === 'condition') return (a.condition_rating || 0) - (b.condition_rating || 0);
      if (sortBy === 'cost') return (b.avg_maintenance_cost || 0) - (a.avg_maintenance_cost || 0);
      return 0;
    });
    return list;
  }, [equipment, filterCat, filterStatus, sortBy]);

  const categories = useMemo(() => [...new Set(equipment.map(e => e.category).filter(Boolean))].sort(), [equipment]);

  const dismissAlert = async (id) => {
    try {
      await af(`/admin/equipment-maintenance/alerts/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'resolved', resolved_by: 'admin' }) });
      setAlerts(prev => prev.filter(a => a.id !== id));
      showToast('Alert resolved');
    } catch (e) { showToast('Error resolving alert'); }
  };

  // ─── RENDER ─────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: D.heading }}>Equipment Maintenance & Fleet</div>
        <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>Maintenance schedules, mileage tracking, cost analysis, fleet health</div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}` }}>
        {[{ key: 'fleet', label: 'Fleet Overview' }, { key: 'analytics', label: 'Analytics' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{ ...sBtn(tab === t.key ? D.teal : 'transparent', tab === t.key ? D.white : D.muted), flex: 1, padding: '10px 16px', borderRadius: 8 }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Toast */}
      {toast && <div style={{ position: 'fixed', top: 20, right: 20, background: D.green, color: '#fff', padding: '10px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999 }}>{toast}</div>}

      {tab === 'fleet' && <FleetTab {...{ loading, overview, alerts, dismissAlert, filtered, categories, filterCat, setFilterCat, filterStatus, setFilterStatus, sortBy, setSortBy, expandedId, setExpandedId, showToast, loadFleet }} />}
      {tab === 'analytics' && <AnalyticsTab {...{ costs, reliability, mileageSummary, dueSchedules, monthlyCosts, overview }} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FLEET OVERVIEW TAB
// ═══════════════════════════════════════════════════════════════════
function FleetTab({ loading, overview, alerts, dismissAlert, filtered, categories, filterCat, setFilterCat, filterStatus, setFilterStatus, sortBy, setSortBy, expandedId, setExpandedId, showToast, loadFleet }) {
  if (loading) return <div style={{ color: D.muted, textAlign: 'center', padding: 40 }}>Loading fleet data...</div>;

  return (
    <>
      {/* Alert Banner */}
      {alerts.length > 0 && (
        <div style={{ ...sCard, background: '#2d1b1b', borderColor: D.red, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.red, marginBottom: 8 }}>
            {alerts.length} Active Alert{alerts.length > 1 ? 's' : ''}
          </div>
          {alerts.slice(0, 5).map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${D.border}` }}>
              <span style={sBadge(SEV_COLORS[a.severity] || D.amber, D.white)}>{a.severity}</span>
              <span style={{ flex: 1, fontSize: 12, color: D.text }}>{a.title}</span>
              <button onClick={() => dismissAlert(a.id)} style={sBtn('transparent', D.muted)}>Dismiss</button>
            </div>
          ))}
          {alerts.length > 5 && <div style={{ fontSize: 11, color: D.muted, marginTop: 6 }}>+ {alerts.length - 5} more</div>}
        </div>
      )}

      {/* Stats */}
      {overview && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
          <StatCard label="Total Assets" value={overview.total_assets} />
          <StatCard label="Overdue Maintenance" value={overview.overdue_maintenance} color={overview.overdue_maintenance > 0 ? D.red : D.green} />
          <StatCard label="YTD Maintenance" value={fmt(overview.ytd_maintenance_spend)} />
          <StatCard label="YTD Mileage" value={fmtN(Math.round(overview.ytd_total_miles))} sub="miles" />
          <StatCard label="YTD Fuel" value={fmt(overview.ytd_fuel_cost)} />
          <StatCard label="YTD IRS Deduction" value={fmt(overview.ytd_irs_deduction)} color={D.green} />
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ ...sInput, width: 'auto', minWidth: 140 }}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...sInput, width: 'auto', minWidth: 130 }}>
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="in_service">In Service</option>
          <option value="retired">Retired</option>
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...sInput, width: 'auto', minWidth: 130 }}>
          <option value="name">Sort: Name</option>
          <option value="condition">Sort: Condition</option>
          <option value="cost">Sort: Cost</option>
        </select>
      </div>

      {/* Equipment Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(340, 1fr))', gap: 12 }}>
        {filtered.map(eq => (
          <EquipmentCard key={eq.id} eq={eq} isExpanded={expandedId === eq.id}
            onToggle={() => setExpandedId(expandedId === eq.id ? null : eq.id)}
            showToast={showToast} loadFleet={loadFleet} />
        ))}
      </div>
      {filtered.length === 0 && <div style={{ color: D.muted, textAlign: 'center', padding: 40 }}>No equipment found</div>}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// EQUIPMENT CARD + EXPANDED DETAIL
// ═══════════════════════════════════════════════════════════════════
function EquipmentCard({ eq, isExpanded, onToggle, showToast, loadFleet }) {
  const [detail, setDetail] = useState(null);
  const [mileage, setMileage] = useState(null);
  const [recordForm, setRecordForm] = useState(false);
  const [mileageForm, setMileageForm] = useState(false);

  useEffect(() => {
    if (isExpanded && !detail) {
      Promise.all([
        af(`/admin/equipment-maintenance/${eq.id}`),
        eq.category === 'vehicle' ? af(`/admin/equipment-maintenance/${eq.id}/mileage?limit=30`) : Promise.resolve(null),
      ]).then(([d, m]) => { setDetail(d); setMileage(m); }).catch(console.error);
    }
  }, [isExpanded, eq.id, eq.category, detail]);

  const nm = eq.next_maintenance;
  const overdue = nm && nm.is_overdue;

  return (
    <div style={{ ...sCard, cursor: 'pointer', transition: 'border-color 0.2s', borderColor: overdue ? D.red : isExpanded ? D.teal : D.border, gridColumn: isExpanded ? '1 / -1' : undefined }}>
      {/* Card Header */}
      <div onClick={onToggle} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ fontSize: 28, lineHeight: 1 }}>{CAT_ICONS[eq.category] || '\u{1F527}'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>{eq.name}</span>
            <span style={sBadge(STATUS_COLORS[eq.status] || D.muted, D.white)}>{eq.status}</span>
          </div>
          <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
            {eq.asset_tag && <span style={{ marginRight: 12 }}>{eq.asset_tag}</span>}
            {eq.make && <span style={{ marginRight: 12 }}>{eq.make} {eq.model}</span>}
            {eq.year && <span>({eq.year})</span>}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 100px', minWidth: 80 }}>
              <ConditionBar rating={eq.condition_rating} />
            </div>
            {nm && (
              <div style={{ fontSize: 11, color: overdue ? D.red : D.muted }}>
                {overdue ? 'OVERDUE: ' : 'Next: '}{nm.task_name}
                {nm.next_due_at && <span> ({new Date(nm.next_due_at).toLocaleDateString()})</span>}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11, color: D.muted }}>
            {eq.assigned_tech_name !== 'Unassigned' && <span>Assigned: {eq.assigned_tech_name}</span>}
            {eq.current_miles > 0 && <span>{fmtN(eq.current_miles)} mi</span>}
            {parseFloat(eq.current_hours) > 0 && <span>{fmtN(eq.current_hours)} hrs</span>}
          </div>
        </div>
      </div>

      {/* Expanded Detail */}
      {isExpanded && detail && (
        <div style={{ marginTop: 16, borderTop: `1px solid ${D.border}`, paddingTop: 16 }}>
          {/* Equipment Info Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <InfoRow label="Serial" value={detail.equipment.serial_number} />
            <InfoRow label="VIN" value={detail.equipment.vin} />
            <InfoRow label="Purchase Date" value={detail.equipment.purchase_date ? new Date(detail.equipment.purchase_date).toLocaleDateString() : null} />
            <InfoRow label="Purchase Price" value={detail.equipment.purchase_price ? fmt(detail.equipment.purchase_price) : null} />
            <InfoRow label="Warranty" value={detail.equipment.warranty_expiration ? `Expires ${new Date(detail.equipment.warranty_expiration).toLocaleDateString()}` : null} />
            <InfoRow label="Engine" value={detail.equipment.engine_type} />
            <InfoRow label="Location" value={detail.equipment.location} />
            <InfoRow label="Depreciation" value={detail.equipment.depreciation_method} />
          </div>

          {/* Maintenance Schedules */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 8 }}>Maintenance Schedules</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', color: D.muted }}>Task</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', color: D.muted }}>Interval</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', color: D.muted }}>Next Due</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', color: D.muted }}>Priority</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', color: D.muted }}>Est Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.schedules || []).map(s => {
                    const intervals = [];
                    if (s.interval_miles) intervals.push(`${fmtN(s.interval_miles)} mi`);
                    if (s.interval_hours) intervals.push(`${s.interval_hours} hrs`);
                    if (s.interval_days) intervals.push(`${s.interval_days} days`);
                    if (s.interval_months) intervals.push(`${s.interval_months} mo`);
                    return (
                      <tr key={s.id} style={{ borderBottom: `1px solid ${D.border}`, background: s.is_overdue ? 'rgba(239,68,68,0.1)' : 'transparent' }}>
                        <td style={{ padding: '6px 8px', color: D.text }}>{s.task_name}</td>
                        <td style={{ padding: '6px 8px', color: D.muted }}>{intervals.join(' / ') || '--'}</td>
                        <td style={{ padding: '6px 8px', color: s.is_overdue ? D.red : D.text }}>
                          {s.is_overdue && 'OVERDUE '}
                          {s.next_due_at ? new Date(s.next_due_at).toLocaleDateString() : ''}
                          {s.next_due_miles ? ` / ${fmtN(s.next_due_miles)} mi` : ''}
                          {s.next_due_hours ? ` / ${s.next_due_hours} hrs` : ''}
                        </td>
                        <td style={{ padding: '6px 8px' }}><span style={sBadge(s.priority === 'critical' ? D.red : s.priority === 'high' ? '#f97316' : D.teal, D.white)}>{s.priority}</span></td>
                        <td style={{ padding: '6px 8px', color: D.text, textAlign: 'right' }}>{s.estimated_cost ? fmt(s.estimated_cost) : '--'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <button onClick={() => setRecordForm(!recordForm)} style={sBtn(D.teal, D.white)}>
              {recordForm ? 'Cancel' : 'Record Maintenance'}
            </button>
            {eq.category === 'vehicle' && (
              <button onClick={() => setMileageForm(!mileageForm)} style={sBtn(D.purple, D.white)}>
                {mileageForm ? 'Cancel' : 'Log Mileage'}
              </button>
            )}
          </div>

          {/* Record Maintenance Form */}
          {recordForm && <MaintenanceForm equipmentId={eq.id} schedules={detail.schedules || []} onDone={() => { setRecordForm(false); setDetail(null); loadFleet(); showToast('Maintenance recorded'); }} />}

          {/* Log Mileage Form */}
          {mileageForm && <MileageForm vehicleId={eq.id} currentMiles={eq.current_miles} onDone={() => { setMileageForm(false); setMileage(null); setDetail(null); loadFleet(); showToast('Mileage logged'); }} />}

          {/* Recent Maintenance History */}
          {(detail.recentRecords || []).length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 8 }}>Maintenance History</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                      <th style={{ textAlign: 'left', padding: '6px 8px', color: D.muted }}>Date</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', color: D.muted }}>Task</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', color: D.muted }}>Type</th>
                      <th style={{ textAlign: 'left', padding: '6px 8px', color: D.muted }}>By</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px', color: D.muted }}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.recentRecords.slice(0, 10).map(r => (
                      <tr key={r.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                        <td style={{ padding: '6px 8px', color: D.text }}>{new Date(r.performed_at).toLocaleDateString()}</td>
                        <td style={{ padding: '6px 8px', color: D.text }}>{r.task_name}</td>
                        <td style={{ padding: '6px 8px' }}><span style={sBadge(r.maintenance_type === 'repair' ? D.red : r.maintenance_type === 'inspection' ? D.purple : D.teal, D.white)}>{r.maintenance_type}</span></td>
                        <td style={{ padding: '6px 8px', color: D.muted }}>{r.performed_by || r.vendor_name || '--'}</td>
                        <td style={{ padding: '6px 8px', color: D.text, textAlign: 'right' }}>{fmt(r.total_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Cost of Ownership */}
          {detail.costOfOwnership && (
            <div style={{ ...sCard, background: D.darkCard }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Cost of Ownership</div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12, fontSize: 12 }}>
                <div><div style={{ color: D.muted }}>Purchase</div><div style={{ color: D.heading, fontWeight: 600 }}>{fmt(detail.costOfOwnership.purchase_price)}</div></div>
                <div><div style={{ color: D.muted }}>Total Maintenance</div><div style={{ color: D.heading, fontWeight: 600 }}>{fmt(detail.costOfOwnership.total_maintenance)}</div></div>
                <div><div style={{ color: D.muted }}>Total Fuel</div><div style={{ color: D.heading, fontWeight: 600 }}>{fmt(detail.costOfOwnership.total_fuel)}</div></div>
                <div><div style={{ color: D.muted }}>Total Cost</div><div style={{ color: D.amber, fontWeight: 700 }}>{fmt(detail.costOfOwnership.total_cost)}</div></div>
                <div><div style={{ color: D.muted }}>Monthly Cost</div><div style={{ color: D.heading, fontWeight: 600 }}>{fmt(detail.costOfOwnership.monthly_cost)}</div></div>
                <div><div style={{ color: D.muted }}>Age</div><div style={{ color: D.heading, fontWeight: 600 }}>{detail.costOfOwnership.age_months} months</div></div>
                {detail.costOfOwnership.cost_per_mile && <div><div style={{ color: D.muted }}>Cost/Mile</div><div style={{ color: D.heading, fontWeight: 600 }}>{fmt(detail.costOfOwnership.cost_per_mile)}</div></div>}
                {detail.costOfOwnership.total_irs_deduction > 0 && <div><div style={{ color: D.muted }}>IRS Deduction</div><div style={{ color: D.green, fontWeight: 700 }}>{fmt(detail.costOfOwnership.total_irs_deduction)}</div></div>}
              </div>
            </div>
          )}

          {/* Vehicle Mileage Section */}
          {mileage && mileage.logs && mileage.logs.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 8 }}>Mileage Log (Last 30 Days)</div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
                <div style={{ ...sCard, background: D.darkCard, padding: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: D.muted }}>Total Miles</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>{fmtN(Math.round(mileage.summary.total_miles))}</div>
                </div>
                <div style={{ ...sCard, background: D.darkCard, padding: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: D.muted }}>Business Miles</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: D.teal }}>{fmtN(Math.round(mileage.summary.business_miles))}</div>
                </div>
                <div style={{ ...sCard, background: D.darkCard, padding: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: D.muted }}>Fuel Cost</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: D.amber }}>{fmt(mileage.summary.total_fuel_cost)}</div>
                </div>
                <div style={{ ...sCard, background: D.darkCard, padding: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: D.muted }}>IRS Deduction</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: D.green }}>{fmt(mileage.summary.total_irs_deduction)}</div>
                </div>
              </div>
              {mileage.summary.avg_mpg && (
                <div style={{ fontSize: 12, color: D.muted, marginBottom: 8 }}>Avg MPG: {mileage.summary.avg_mpg}</div>
              )}
              <div style={{ overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${D.border}`, position: 'sticky', top: 0, background: D.card }}>
                      <th style={{ textAlign: 'left', padding: '4px 6px', color: D.muted }}>Date</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', color: D.muted }}>Miles</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', color: D.muted }}>Biz %</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', color: D.muted }}>Fuel</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', color: D.muted }}>IRS Ded.</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', color: D.muted }}>Jobs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mileage.logs.slice(0, 30).map(l => (
                      <tr key={l.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                        <td style={{ padding: '4px 6px', color: D.text }}>{new Date(l.log_date).toLocaleDateString()}</td>
                        <td style={{ padding: '4px 6px', color: D.text, textAlign: 'right' }}>{l.total_miles}</td>
                        <td style={{ padding: '4px 6px', color: D.muted, textAlign: 'right' }}>{l.business_pct}%</td>
                        <td style={{ padding: '4px 6px', color: D.text, textAlign: 'right' }}>{l.fuel_cost ? fmt(l.fuel_cost) : '--'}</td>
                        <td style={{ padding: '4px 6px', color: D.green, textAlign: 'right' }}>{fmt(l.irs_deduction_amount)}</td>
                        <td style={{ padding: '4px 6px', color: D.muted, textAlign: 'right' }}>{l.jobs_serviced || '--'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: D.muted }}>{label}: </span>
      <span style={{ color: D.text }}>{value}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// RECORD MAINTENANCE FORM
// ═══════════════════════════════════════════════════════════════════
function MaintenanceForm({ equipmentId, schedules, onDone }) {
  const [form, setForm] = useState({
    scheduleId: '', maintenanceType: 'scheduled', taskName: '', description: '',
    performedBy: '', vendorName: '', milesAtService: '', hoursAtService: '',
    conditionBefore: '', conditionAfter: '', partsCost: '0', laborCost: '0',
    vendorCost: '0', downtimeHours: '0', followUpNeeded: false, followUpNotes: '',
    followUpDate: '', warrantyClaim: false,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const selectSchedule = (id) => {
    const s = schedules.find(x => x.id === id);
    if (s) set('taskName', s.task_name);
    set('scheduleId', id);
  };

  const submit = async () => {
    if (!form.taskName) return;
    setSaving(true);
    try {
      await af(`/admin/equipment-maintenance/${equipmentId}/records`, {
        method: 'POST',
        body: JSON.stringify({
          scheduleId: form.scheduleId || null,
          maintenanceType: form.maintenanceType,
          taskName: form.taskName,
          description: form.description || null,
          performedBy: form.performedBy || null,
          vendorName: form.vendorName || null,
          milesAtService: form.milesAtService ? parseInt(form.milesAtService) : null,
          hoursAtService: form.hoursAtService ? parseFloat(form.hoursAtService) : null,
          conditionBefore: form.conditionBefore ? parseInt(form.conditionBefore) : null,
          conditionAfter: form.conditionAfter ? parseInt(form.conditionAfter) : null,
          partsCost: parseFloat(form.partsCost) || 0,
          laborCost: parseFloat(form.laborCost) || 0,
          vendorCost: parseFloat(form.vendorCost) || 0,
          downtimeHours: parseFloat(form.downtimeHours) || 0,
          followUpNeeded: form.followUpNeeded,
          followUpNotes: form.followUpNotes || null,
          followUpDate: form.followUpDate || null,
          warrantyClaim: form.warrantyClaim,
        }),
      });
      onDone();
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  return (
    <div style={{ ...sCard, background: D.darkCard, marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Record Maintenance</div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Schedule (optional)</label>
          <select value={form.scheduleId} onChange={e => selectSchedule(e.target.value)} style={sInput}>
            <option value="">-- Select schedule --</option>
            {schedules.map(s => <option key={s.id} value={s.id}>{s.task_name}{s.is_overdue ? ' (OVERDUE)' : ''}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Type</label>
          <select value={form.maintenanceType} onChange={e => set('maintenanceType', e.target.value)} style={sInput}>
            {['scheduled', 'reactive', 'inspection', 'repair', 'upgrade', 'recall'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
          <label style={{ fontSize: 11, color: D.muted }}>Task Name *</label>
          <input value={form.taskName} onChange={e => set('taskName', e.target.value)} style={sInput} placeholder="e.g. Oil Change" />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Performed By</label>
          <input value={form.performedBy} onChange={e => set('performedBy', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Vendor</label>
          <input value={form.vendorName} onChange={e => set('vendorName', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Miles at Service</label>
          <input type="number" value={form.milesAtService} onChange={e => set('milesAtService', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Hours at Service</label>
          <input type="number" step="0.1" value={form.hoursAtService} onChange={e => set('hoursAtService', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Condition Before (1-10)</label>
          <input type="number" min="1" max="10" value={form.conditionBefore} onChange={e => set('conditionBefore', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Condition After (1-10)</label>
          <input type="number" min="1" max="10" value={form.conditionAfter} onChange={e => set('conditionAfter', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Parts Cost</label>
          <input type="number" step="0.01" value={form.partsCost} onChange={e => set('partsCost', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Labor Cost</label>
          <input type="number" step="0.01" value={form.laborCost} onChange={e => set('laborCost', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Vendor Cost</label>
          <input type="number" step="0.01" value={form.vendorCost} onChange={e => set('vendorCost', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Downtime Hours</label>
          <input type="number" step="0.5" value={form.downtimeHours} onChange={e => set('downtimeHours', e.target.value)} style={sInput} />
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', gridColumn: isMobile ? undefined : '1 / -1' }}>
          <label style={{ fontSize: 12, color: D.muted, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={form.followUpNeeded} onChange={e => set('followUpNeeded', e.target.checked)} /> Follow-up needed
          </label>
          <label style={{ fontSize: 12, color: D.muted, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={form.warrantyClaim} onChange={e => set('warrantyClaim', e.target.checked)} /> Warranty claim
          </label>
        </div>
        {form.followUpNeeded && (
          <>
            <div>
              <label style={{ fontSize: 11, color: D.muted }}>Follow-up Date</label>
              <input type="date" value={form.followUpDate} onChange={e => set('followUpDate', e.target.value)} style={sInput} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: D.muted }}>Follow-up Notes</label>
              <input value={form.followUpNotes} onChange={e => set('followUpNotes', e.target.value)} style={sInput} />
            </div>
          </>
        )}
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={saving || !form.taskName} style={{ ...sBtn(D.green, D.white), opacity: saving || !form.taskName ? 0.5 : 1 }}>
          {saving ? 'Saving...' : 'Save Record'}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LOG MILEAGE FORM
// ═══════════════════════════════════════════════════════════════════
function MileageForm({ vehicleId, currentMiles, onDone }) {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({
    logDate: today, odometerStart: currentMiles || '', odometerEnd: '',
    businessMiles: '', personalMiles: '0', fuelGallons: '', fuelCost: '',
    jobsServiced: '', loggedBy: '', notes: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const totalMiles = (parseInt(form.odometerEnd) || 0) - (parseInt(form.odometerStart) || 0);
  const irsDeduction = totalMiles > 0 ? ((totalMiles - parseFloat(form.personalMiles || 0)) * 0.70).toFixed(2) : '0.00';

  const submit = async () => {
    if (!form.odometerStart || !form.odometerEnd) return;
    setSaving(true);
    try {
      await af(`/admin/equipment-maintenance/${vehicleId}/mileage`, {
        method: 'POST',
        body: JSON.stringify({
          logDate: form.logDate,
          odometerStart: parseInt(form.odometerStart),
          odometerEnd: parseInt(form.odometerEnd),
          personalMiles: parseFloat(form.personalMiles) || 0,
          fuelGallons: form.fuelGallons ? parseFloat(form.fuelGallons) : null,
          fuelCost: form.fuelCost ? parseFloat(form.fuelCost) : null,
          jobsServiced: form.jobsServiced ? parseInt(form.jobsServiced) : null,
          loggedBy: form.loggedBy || null,
          notes: form.notes || null,
          source: 'manual',
        }),
      });
      onDone();
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  return (
    <div style={{ ...sCard, background: D.darkCard, marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Log Mileage</div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Date</label>
          <input type="date" value={form.logDate} onChange={e => set('logDate', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Odometer Start</label>
          <input type="number" value={form.odometerStart} onChange={e => set('odometerStart', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Odometer End</label>
          <input type="number" value={form.odometerEnd} onChange={e => set('odometerEnd', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Personal Miles</label>
          <input type="number" step="0.1" value={form.personalMiles} onChange={e => set('personalMiles', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Fuel Gallons</label>
          <input type="number" step="0.01" value={form.fuelGallons} onChange={e => set('fuelGallons', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Fuel Cost ($)</label>
          <input type="number" step="0.01" value={form.fuelCost} onChange={e => set('fuelCost', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Jobs Serviced</label>
          <input type="number" value={form.jobsServiced} onChange={e => set('jobsServiced', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Logged By</label>
          <input value={form.loggedBy} onChange={e => set('loggedBy', e.target.value)} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: D.muted }}>Notes</label>
          <input value={form.notes} onChange={e => set('notes', e.target.value)} style={sInput} />
        </div>
      </div>
      {totalMiles > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: D.muted }}>
          Total: {totalMiles} miles | Business: {totalMiles - parseFloat(form.personalMiles || 0)} miles | IRS Deduction: <span style={{ color: D.green, fontWeight: 700 }}>${irsDeduction}</span>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button onClick={submit} disabled={saving || totalMiles <= 0} style={{ ...sBtn(D.purple, D.white), opacity: saving || totalMiles <= 0 ? 0.5 : 1 }}>
          {saving ? 'Saving...' : 'Save Mileage'}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS TAB
// ═══════════════════════════════════════════════════════════════════
function AnalyticsTab({ costs, reliability, mileageSummary, dueSchedules, monthlyCosts, overview }) {
  return (
    <>
      {/* Cost of Ownership Table */}
      <div style={{ ...sCard, marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Cost of Ownership</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                <th style={{ textAlign: 'left', padding: '8px', color: D.muted }}>Equipment</th>
                <th style={{ textAlign: 'left', padding: '8px', color: D.muted }}>Category</th>
                <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Age (mo)</th>
                <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Purchase</th>
                <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Maintenance</th>
                <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Monthly</th>
                <th style={{ textAlign: 'center', padding: '8px', color: D.muted }}>Condition</th>
              </tr>
            </thead>
            <tbody>
              {costs.map(c => (
                <tr key={c.equipment_id} style={{ borderBottom: `1px solid ${D.border}` }}>
                  <td style={{ padding: '8px', color: D.text }}>
                    {CAT_ICONS[c.category] || ''} {c.equipment_name}
                    {c.asset_tag && <span style={{ color: D.muted, fontSize: 10, marginLeft: 6 }}>{c.asset_tag}</span>}
                  </td>
                  <td style={{ padding: '8px', color: D.muted }}>{c.category}</td>
                  <td style={{ padding: '8px', color: D.text, textAlign: 'right' }}>{c.age_months}</td>
                  <td style={{ padding: '8px', color: D.text, textAlign: 'right' }}>{fmt(c.purchase_price)}</td>
                  <td style={{ padding: '8px', color: D.text, textAlign: 'right' }}>{fmt(c.total_maintenance)}</td>
                  <td style={{ padding: '8px', color: D.amber, textAlign: 'right', fontWeight: 600 }}>{fmt(c.monthly_cost)}</td>
                  <td style={{ padding: '8px' }}><ConditionBar rating={c.condition_rating} /></td>
                </tr>
              ))}
            </tbody>
            {costs.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: `2px solid ${D.border}` }}>
                  <td style={{ padding: '8px', color: D.heading, fontWeight: 700 }} colSpan={3}>Totals</td>
                  <td style={{ padding: '8px', color: D.heading, fontWeight: 700, textAlign: 'right' }}>{fmt(costs.reduce((s, c) => s + c.purchase_price, 0))}</td>
                  <td style={{ padding: '8px', color: D.heading, fontWeight: 700, textAlign: 'right' }}>{fmt(costs.reduce((s, c) => s + c.total_maintenance, 0))}</td>
                  <td style={{ padding: '8px', color: D.amber, fontWeight: 700, textAlign: 'right' }}>{fmt(costs.reduce((s, c) => s + c.monthly_cost, 0))}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Monthly Cost Trend - SVG Bar Chart */}
      {monthlyCosts.length > 0 && (
        <div style={{ ...sCard, marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Maintenance Cost Trend (Last 6 Months)</div>
          <CostBarChart data={monthlyCosts} />
        </div>
      )}

      {/* Reliability Ranking */}
      {reliability.length > 0 && (
        <div style={{ ...sCard, marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Reliability Ranking (Downtime Hours)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                  <th style={{ textAlign: 'left', padding: '8px', color: D.muted }}>Equipment</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Incidents</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Downtime (hrs)</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Jobs Affected</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Revenue Impact</th>
                </tr>
              </thead>
              <tbody>
                {reliability.map(r => (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                    <td style={{ padding: '8px', color: D.text }}>{CAT_ICONS[r.category] || ''} {r.name} <span style={{ color: D.muted, fontSize: 10 }}>{r.asset_tag}</span></td>
                    <td style={{ padding: '8px', color: D.text, textAlign: 'right' }}>{r.incident_count}</td>
                    <td style={{ padding: '8px', color: D.red, textAlign: 'right', fontWeight: 600 }}>{parseFloat(r.total_downtime_hours).toFixed(1)}</td>
                    <td style={{ padding: '8px', color: D.text, textAlign: 'right' }}>{r.total_jobs_affected}</td>
                    <td style={{ padding: '8px', color: D.amber, textAlign: 'right' }}>{fmt(r.total_revenue_impact)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Fleet Mileage Summary */}
      {mileageSummary && mileageSummary.vehicles && mileageSummary.vehicles.length > 0 && (
        <div style={{ ...sCard, marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Fleet Mileage Summary ({mileageSummary.year})</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                  <th style={{ textAlign: 'left', padding: '8px', color: D.muted }}>Vehicle</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Total Miles</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Business Miles</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Fuel Cost</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>IRS Deduction</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Jobs</th>
                </tr>
              </thead>
              <tbody>
                {mileageSummary.vehicles.map(v => (
                  <tr key={v.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                    <td style={{ padding: '8px', color: D.text }}>{v.name} <span style={{ color: D.muted, fontSize: 10 }}>{v.asset_tag}</span></td>
                    <td style={{ padding: '8px', color: D.text, textAlign: 'right' }}>{fmtN(Math.round(parseFloat(v.total_miles)))}</td>
                    <td style={{ padding: '8px', color: D.teal, textAlign: 'right' }}>{fmtN(Math.round(parseFloat(v.business_miles)))}</td>
                    <td style={{ padding: '8px', color: D.amber, textAlign: 'right' }}>{fmt(v.total_fuel_cost)}</td>
                    <td style={{ padding: '8px', color: D.green, textAlign: 'right', fontWeight: 700 }}>{fmt(v.total_irs_deduction)}</td>
                    <td style={{ padding: '8px', color: D.text, textAlign: 'right' }}>{v.total_jobs}</td>
                  </tr>
                ))}
              </tbody>
              {mileageSummary.fleet_totals && (
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${D.border}` }}>
                    <td style={{ padding: '8px', color: D.heading, fontWeight: 700 }}>Fleet Totals</td>
                    <td style={{ padding: '8px', color: D.heading, fontWeight: 700, textAlign: 'right' }}>{fmtN(Math.round(mileageSummary.fleet_totals.total_miles))}</td>
                    <td style={{ padding: '8px', color: D.teal, fontWeight: 700, textAlign: 'right' }}>{fmtN(Math.round(mileageSummary.fleet_totals.business_miles))}</td>
                    <td style={{ padding: '8px', color: D.amber, fontWeight: 700, textAlign: 'right' }}>{fmt(mileageSummary.fleet_totals.total_fuel_cost)}</td>
                    <td style={{ padding: '8px', color: D.green, fontWeight: 700, textAlign: 'right' }}>{fmt(mileageSummary.fleet_totals.total_irs_deduction)}</td>
                    <td style={{ padding: '8px', color: D.heading, fontWeight: 700, textAlign: 'right' }}>{mileageSummary.fleet_totals.total_jobs}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Upcoming Maintenance (Next 30 Days) */}
      {dueSchedules.length > 0 && (
        <div style={{ ...sCard }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Upcoming Maintenance (Next 30 Days)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                  <th style={{ textAlign: 'left', padding: '8px', color: D.muted }}>Equipment</th>
                  <th style={{ textAlign: 'left', padding: '8px', color: D.muted }}>Task</th>
                  <th style={{ textAlign: 'left', padding: '8px', color: D.muted }}>Due</th>
                  <th style={{ textAlign: 'left', padding: '8px', color: D.muted }}>Priority</th>
                  <th style={{ textAlign: 'right', padding: '8px', color: D.muted }}>Est Cost</th>
                </tr>
              </thead>
              <tbody>
                {dueSchedules.map(s => (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${D.border}`, background: s.is_overdue ? 'rgba(239,68,68,0.08)' : 'transparent' }}>
                    <td style={{ padding: '8px', color: D.text }}>
                      {CAT_ICONS[s.category] || ''} {s.equipment_name}
                      {s.asset_tag && <span style={{ color: D.muted, fontSize: 10, marginLeft: 4 }}>{s.asset_tag}</span>}
                    </td>
                    <td style={{ padding: '8px', color: D.text }}>{s.task_name}</td>
                    <td style={{ padding: '8px', color: s.is_overdue ? D.red : D.text }}>
                      {s.is_overdue && <span style={{ ...sBadge(D.red, D.white), marginRight: 4 }}>OVERDUE</span>}
                      {s.next_due_at ? new Date(s.next_due_at).toLocaleDateString() : '--'}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span style={sBadge(s.priority === 'critical' ? D.red : s.priority === 'high' ? '#f97316' : D.teal, D.white)}>{s.priority}</span>
                    </td>
                    <td style={{ padding: '8px', color: D.text, textAlign: 'right' }}>{s.estimated_cost ? fmt(s.estimated_cost) : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SVG BAR CHART
// ═══════════════════════════════════════════════════════════════════
function CostBarChart({ data }) {
  if (!data || data.length === 0) return null;
  const maxCost = Math.max(...data.map(d => d.cost), 1);
  const w = 600;
  const h = 200;
  const barW = Math.min(60, (w - 40) / data.length - 10);
  const xStep = (w - 40) / data.length;

  return (
    <svg viewBox={`0 0 ${w} ${h + 30}`} style={{ width: '100%', maxWidth: 600, height: 'auto' }}>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map(pct => {
        const y = h - pct * (h - 20);
        return (
          <g key={pct}>
            <line x1={30} y1={y} x2={w} y2={y} stroke={D.border} strokeWidth={0.5} />
            <text x={28} y={y + 4} fill={D.muted} fontSize={9} textAnchor="end">{fmt(maxCost * pct)}</text>
          </g>
        );
      })}
      {/* Bars */}
      {data.map((d, i) => {
        const barH = (d.cost / maxCost) * (h - 20);
        const x = 40 + i * xStep + (xStep - barW) / 2;
        const y = h - barH;
        return (
          <g key={d.month}>
            <rect x={x} y={y} width={barW} height={barH} rx={4} fill={D.teal} opacity={0.8} />
            <text x={x + barW / 2} y={h + 14} fill={D.muted} fontSize={10} textAnchor="middle">{d.month.slice(5)}</text>
            <text x={x + barW / 2} y={y - 4} fill={D.text} fontSize={9} textAnchor="middle">{fmt(d.cost)}</text>
          </g>
        );
      })}
    </svg>
  );
}
