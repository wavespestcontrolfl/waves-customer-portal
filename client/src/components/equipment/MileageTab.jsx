import { useState, useEffect, useCallback } from 'react';
import { etDateString } from '../../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', text: '#334155', muted: '#64748B', white: '#fff', input: '#FFFFFF' };

function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function adminFetchRaw(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
  });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '7px 14px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });
const sInput = { padding: '7px 10px', background: D.input, border: '1px solid #CBD5E1', borderRadius: 8, color: '#0F172A', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const fmt = (n) => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
const fmtMi = (n) => n != null ? Number(n).toFixed(1) : '0.0';
const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

function toDateStr(d) { return typeof d === 'string' ? d.slice(0, 10) : d ? etDateString(new Date(d)) : ''; }
function monthLabel(d) { const dt = new Date(d + 'T12:00:00'); return dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
function truncAddr(a, max) { if (!a) return '--'; return a.length > max ? a.slice(0, max) + '...' : a; }
function minToHM(m) { if (!m) return '0m'; const h = Math.floor(m / 60); const min = m % 60; return h > 0 ? `${h}h ${min}m` : `${min}m`; }

export default function MileageTab() {
  const [section, setSection] = useState('dashboard');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3000); };

  // Dashboard
  const [dash, setDash] = useState(null);
  // Trips
  const [trips, setTrips] = useState([]);
  const [tripPage, setTripPage] = useState(1);
  const [tripTotal, setTripTotal] = useState(0);
  const [tripDateStart, setTripDateStart] = useState('');
  const [tripDateEnd, setTripDateEnd] = useState('');
  const [tripFilter, setTripFilter] = useState('all');
  const [expandedTrip, setExpandedTrip] = useState(null);
  const [selectedTrips, setSelectedTrips] = useState(new Set());
  // Monthly
  const [monthDate, setMonthDate] = useState(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; });
  const [dailySummaries, setDailySummaries] = useState([]);
  // IRS
  const [irsYear, setIrsYear] = useState(new Date().getFullYear());
  const [irsReport, setIrsReport] = useState(null);
  // Geo-fences
  const [fences, setFences] = useState([]);
  const [fenceForm, setFenceForm] = useState(null);

  // ── Loaders ──────────────────────────────────────────────────
  const loadDashboard = useCallback(async () => {
    try { setLoading(true); const d = await adminFetch('/admin/mileage/dashboard'); setDash(d); } catch (e) { showToast('Failed to load dashboard'); } finally { setLoading(false); }
  }, []);

  const loadTrips = useCallback(async (page) => {
    try {
      setLoading(true);
      const p = page || tripPage;
      let url = `/admin/mileage/trips?page=${p}&limit=30`;
      if (tripDateStart) url += `&start_date=${tripDateStart}`;
      if (tripDateEnd) url += `&end_date=${tripDateEnd}`;
      if (tripFilter === 'business') url += '&is_business=true';
      if (tripFilter === 'personal') url += '&is_business=false';
      const data = await adminFetch(url);
      setTrips(data.trips || []);
      setTripTotal(data.pagination?.total || 0);
      setSelectedTrips(new Set());
    } catch (e) { showToast('Failed to load trips'); } finally { setLoading(false); }
  }, [tripPage, tripDateStart, tripDateEnd, tripFilter]);

  const loadDaily = useCallback(async () => {
    try {
      setLoading(true);
      const [y, m] = monthDate.split('-');
      const start = `${y}-${m}-01`;
      const end = etDateString(new Date(parseInt(y), parseInt(m), 0, 12));
      const data = await adminFetch(`/admin/mileage/daily?start_date=${start}&end_date=${end}`);
      setDailySummaries(data || []);
    } catch (e) { showToast('Failed to load daily summaries'); } finally { setLoading(false); }
  }, [monthDate]);

  const loadIrs = useCallback(async () => {
    try { setLoading(true); const data = await adminFetch(`/admin/mileage/irs-report?year=${irsYear}`); setIrsReport(data); } catch (e) { showToast('Failed to load IRS report'); } finally { setLoading(false); }
  }, [irsYear]);

  const loadFences = useCallback(async () => {
    try { const data = await adminFetch('/admin/mileage/geo-fences'); setFences(data || []); } catch (e) { showToast('Failed to load geo-fences'); }
  }, []);

  useEffect(() => {
    if (section === 'dashboard') loadDashboard();
    if (section === 'trips') loadTrips(1);
    if (section === 'monthly') loadDaily();
    if (section === 'irs') loadIrs();
    if (section === 'fences') loadFences();
  }, [section]);

  // ── Actions ──────────────────────────────────────────────────
  const syncNow = async () => {
    try { setLoading(true); await adminFetch('/admin/mileage/sync', { method: 'POST', body: '{}' }); showToast('Sync complete'); loadDashboard(); } catch (e) { showToast('Sync failed'); } finally { setLoading(false); }
  };

  const reclassifyTrip = async (id, isBusiness) => {
    try {
      await adminFetch(`/admin/mileage/trips/${id}`, { method: 'PUT', body: JSON.stringify({ is_business: isBusiness }) });
      showToast(isBusiness ? 'Marked as business' : 'Marked as personal');
      loadTrips();
    } catch (e) { showToast('Reclassify failed'); }
  };

  const bulkReclassify = async (isBusiness) => {
    for (const id of selectedTrips) { try { await adminFetch(`/admin/mileage/trips/${id}`, { method: 'PUT', body: JSON.stringify({ is_business: isBusiness }) }); } catch (_) {} }
    showToast(`${selectedTrips.size} trips updated`);
    loadTrips();
  };

  const exportCsv = async () => {
    try {
      const r = await adminFetchRaw(`/admin/mileage/irs-report/export?year=${irsYear}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `waves_mileage_irs_${irsYear}.csv`; a.click();
      URL.revokeObjectURL(url);
      showToast('CSV exported');
    } catch (e) { showToast('Export failed'); }
  };

  const saveFence = async () => {
    if (!fenceForm) return;
    try {
      const { id, ...body } = fenceForm;
      if (id) {
        await adminFetch(`/admin/mileage/geo-fences/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await adminFetch('/admin/mileage/geo-fences', { method: 'POST', body: JSON.stringify(body) });
      }
      setFenceForm(null);
      loadFences();
      showToast('Geo-fence saved');
    } catch (e) { showToast('Save failed'); }
  };

  const deleteFence = async (id) => {
    try { await adminFetch(`/admin/mileage/geo-fences/${id}`, { method: 'DELETE' }); loadFences(); showToast('Geo-fence removed'); } catch (e) { showToast('Delete failed'); }
  };

  // ── Sub-nav ──────────────────────────────────────────────────
  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'trips', label: 'Trips' },
    { key: 'monthly', label: 'Monthly' },
    { key: 'irs', label: 'IRS Report' },
    { key: 'fences', label: 'Geo-Fences' },
  ];

  const navStyle = { display: 'flex', gap: 4, marginBottom: 16, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto', flexWrap: 'nowrap' };
  const navBtn = (active) => ({ padding: '8px 14px', borderRadius: 8, border: 'none', background: active ? D.teal : 'transparent', color: active ? D.white : D.muted, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' });

  // ── Render: Dashboard ────────────────────────────────────────
  const renderDashboard = () => {
    if (!dash) return loading ? renderSpinner() : null;
    const t = dash.today || {};
    const m = dash.mtd || {};
    const v = dash.live_vehicle;
    const bizPct = t.total_miles > 0 ? ((t.business_miles / t.total_miles) * 100) : 100;

    return (
      <div>
        {/* Live Vehicle */}
        <div style={sCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>Live Vehicle Status</div>
            <button style={sBtn(D.teal, D.white)} onClick={syncNow} disabled={loading}>{loading ? 'Syncing...' : 'Sync Now'}</button>
          </div>
          {v ? (
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <div><span style={{ color: D.muted, fontSize: 11 }}>Vehicle</span><div style={{ color: '#0F172A', fontSize: 14, fontWeight: 600 }}>{v.nickname || `${v.make} ${v.model}`}</div></div>
              <div><span style={{ color: D.muted, fontSize: 11 }}>Status</span><div><span style={sBadge(v.isRunning ? D.green : D.muted, D.white)}>{v.isRunning ? 'RUNNING' : 'STOPPED'}</span></div></div>
              {v.lastLocation && <div><span style={{ color: D.muted, fontSize: 11 }}>Location</span><div style={{ color: D.text, fontSize: 13 }}>{v.lastLocation.address || `${v.lastLocation.lat}, ${v.lastLocation.lon}`}</div></div>}
              {v.odometer != null && <div><span style={{ color: D.muted, fontSize: 11 }}>Odometer</span><div style={{ color: D.text, fontSize: 13 }}>{Number(v.odometer).toLocaleString()} mi</div></div>}
              {v.fuelLevel != null && <div><span style={{ color: D.muted, fontSize: 11 }}>Fuel</span><div style={{ color: D.text, fontSize: 13 }}>{v.fuelLevel}%</div></div>}
            </div>
          ) : <div style={{ color: D.muted, fontSize: 13 }}>No live vehicle data available</div>}
        </div>

        {/* Today's Summary */}
        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 12 }}>Today — {t.date || 'N/A'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
            <StatBox label="Miles" value={fmtMi(t.total_miles)} color={D.teal} />
            <StatBox label="Trips" value={t.trip_count || 0} color={D.purple} />
            <StatBox label="Customer Stops" value={t.customer_stops || 0} color={D.green} />
            <StatBox label="IRS Deduction" value={fmt(t.irs_deduction)} color={D.amber} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
            <div><span style={{ color: D.muted, fontSize: 11 }}>Drive Time</span><div style={{ color: D.text, fontSize: 14 }}>{minToHM(t.drive_minutes)}</div></div>
            <div><span style={{ color: D.muted, fontSize: 11 }}>Idle Time</span><div style={{ color: D.text, fontSize: 14 }}>{minToHM(t.idle_minutes)}</div></div>
            <div>
              <span style={{ color: D.muted, fontSize: 11 }}>Business / Personal</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <div style={{ flex: 1, height: 8, background: D.border, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${bizPct}%`, height: '100%', background: D.green, borderRadius: 4 }} />
                </div>
                <span style={{ color: D.text, fontSize: 12 }}>{bizPct.toFixed(0)}%</span>
              </div>
            </div>
          </div>
        </div>

        {/* MTD Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 12 }}>
          <div style={sCard}><StatBox label="MTD Miles" value={fmtMi(m.total_miles)} color={D.teal} /></div>
          <div style={sCard}><StatBox label="MTD IRS Deduction" value={fmt(m.irs_deduction)} color={D.amber} /></div>
          <div style={sCard}><StatBox label="MTD Fuel (gal)" value={m.fuel_consumed_gal ? Number(m.fuel_consumed_gal).toFixed(1) : '0.0'} color={D.purple} /></div>
          <div style={sCard}><StatBox label="Avg Daily Miles" value={fmtMi(m.avg_daily_miles)} color={D.green} /></div>
        </div>
      </div>
    );
  };

  // ── Render: Trips ────────────────────────────────────────────
  const renderTrips = () => {
    const pages = Math.ceil(tripTotal / 30);
    return (
      <div>
        {/* Filters */}
        <div style={{ ...sCard, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" value={tripDateStart} onChange={e => setTripDateStart(e.target.value)} style={{ ...sInput, width: 140 }} />
          <span style={{ color: D.muted }}>to</span>
          <input type="date" value={tripDateEnd} onChange={e => setTripDateEnd(e.target.value)} style={{ ...sInput, width: 140 }} />
          <select value={tripFilter} onChange={e => setTripFilter(e.target.value)} style={{ ...sInput, width: 120 }}>
            <option value="all">All</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
          </select>
          <button style={sBtn(D.teal, D.white)} onClick={() => { setTripPage(1); loadTrips(1); }}>Filter</button>
          {selectedTrips.size > 0 && (
            <>
              <button style={sBtn(D.green, D.white)} onClick={() => bulkReclassify(true)}>Mark Business ({selectedTrips.size})</button>
              <button style={sBtn(D.red, D.white)} onClick={() => bulkReclassify(false)}>Mark Personal ({selectedTrips.size})</button>
            </>
          )}
        </div>

        {/* Trip Table */}
        <div style={{ ...sCard, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                <th style={th}><input type="checkbox" onChange={e => { if (e.target.checked) setSelectedTrips(new Set(trips.map(t => t.id))); else setSelectedTrips(new Set()); }} /></th>
                <th style={th}>Date/Time</th>
                <th style={th}>From</th>
                <th style={th}>To</th>
                <th style={th}>Miles</th>
                <th style={th}>Duration</th>
                <th style={th}>Customer</th>
                <th style={th}>Type</th>
                <th style={th}>Deduction</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trips.map(trip => (
                <TripRow
                  key={trip.id}
                  trip={trip}
                  expanded={expandedTrip === trip.id}
                  selected={selectedTrips.has(trip.id)}
                  onToggle={() => setExpandedTrip(expandedTrip === trip.id ? null : trip.id)}
                  onSelect={(checked) => { const s = new Set(selectedTrips); checked ? s.add(trip.id) : s.delete(trip.id); setSelectedTrips(s); }}
                  onReclassify={(isBiz) => reclassifyTrip(trip.id, isBiz)}
                />
              ))}
              {trips.length === 0 && <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: D.muted }}>No trips found</td></tr>}
            </tbody>
          </table>
          {pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginTop: 12 }}>
              {tripPage > 1 && <button style={sBtn('transparent', D.teal)} onClick={() => { setTripPage(tripPage - 1); loadTrips(tripPage - 1); }}>Prev</button>}
              <span style={{ color: D.muted, fontSize: 12, padding: '8px 12px' }}>{tripPage} / {pages} ({tripTotal} trips)</span>
              {tripPage < pages && <button style={sBtn('transparent', D.teal)} onClick={() => { setTripPage(tripPage + 1); loadTrips(tripPage + 1); }}>Next</button>}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── Render: Monthly ──────────────────────────────────────────
  const renderMonthly = () => {
    const changeMonth = (delta) => {
      const [y, m] = monthDate.split('-').map(Number);
      const nd = new Date(y, m - 1 + delta, 1);
      setMonthDate(`${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}`);
    };

    return (
      <div>
        {/* Month Navigator */}
        <div style={{ ...sCard, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <button style={sBtn('transparent', D.teal)} onClick={() => changeMonth(-1)}>&#9664; Prev</button>
          <span style={{ color: '#0F172A', fontSize: 16, fontWeight: 700 }}>{monthLabel(monthDate + '-01')}</span>
          <button style={sBtn('transparent', D.teal)} onClick={() => changeMonth(1)}>Next &#9654;</button>
          <button style={sBtn(D.teal, D.white)} onClick={loadDaily}>Load</button>
        </div>

        {/* Daily Summary Table */}
        <div style={{ ...sCard, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                <th style={th}>Date</th>
                <th style={th}>Total Mi</th>
                <th style={th}>Business Mi</th>
                <th style={th}>Trips</th>
                <th style={th}>Stops</th>
                <th style={th}>Drive</th>
                <th style={th}>Idle</th>
                <th style={th}>Biz %</th>
                <th style={th}>IRS Ded.</th>
                <th style={th}>Jobs</th>
                <th style={th}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {dailySummaries.map(d => (
                <tr key={d.id} style={{ borderBottom: `1px solid ${D.border}22` }}>
                  <td style={td}>{toDateStr(d.summary_date)}</td>
                  <td style={td}>{fmtMi(d.total_miles)}</td>
                  <td style={td}>{fmtMi(d.business_miles)}</td>
                  <td style={td}>{d.trip_count}</td>
                  <td style={td}>{d.customer_stops}</td>
                  <td style={td}>{minToHM(d.total_drive_minutes)}</td>
                  <td style={td}>{minToHM(d.total_idle_minutes)}</td>
                  <td style={td}>{Number(d.business_pct || 0).toFixed(0)}%</td>
                  <td style={{ ...td, color: D.amber }}>{fmt(d.irs_deduction)}</td>
                  <td style={td}>{d.jobs_completed}</td>
                  <td style={{ ...td, color: D.green }}>{fmt(d.revenue_generated)}</td>
                </tr>
              ))}
              {dailySummaries.length === 0 && <tr><td colSpan={11} style={{ padding: 20, textAlign: 'center', color: D.muted }}>No data for this month</td></tr>}
            </tbody>
          </table>
          {dailySummaries.length > 0 && (() => {
            const totMi = dailySummaries.reduce((s, d) => s + parseFloat(d.total_miles || 0), 0);
            const totBiz = dailySummaries.reduce((s, d) => s + parseFloat(d.business_miles || 0), 0);
            const totDed = dailySummaries.reduce((s, d) => s + parseFloat(d.irs_deduction || 0), 0);
            const totRev = dailySummaries.reduce((s, d) => s + parseFloat(d.revenue_generated || 0), 0);
            return (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 12, marginTop: 12, padding: '12px 0', borderTop: `1px solid ${D.border}` }}>
                <StatBox label="Month Total" value={`${fmtMi(totMi)} mi`} color={D.teal} />
                <StatBox label="Business Miles" value={`${fmtMi(totBiz)} mi`} color={D.green} />
                <StatBox label="IRS Deduction" value={fmt(totDed)} color={D.amber} />
                <StatBox label="Revenue" value={fmt(totRev)} color={D.purple} />
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  // ── Render: IRS Report ───────────────────────────────────────
  const renderIrs = () => {
    return (
      <div>
        <div style={{ ...sCard, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: '#0F172A', fontWeight: 600 }}>Tax Year:</span>
          <select value={irsYear} onChange={e => setIrsYear(parseInt(e.target.value))} style={{ ...sInput, width: 100 }}>
            {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button style={sBtn(D.teal, D.white)} onClick={loadIrs}>Load Report</button>
          <button style={sBtn(D.green, D.white)} onClick={exportCsv}>Export CSV</button>
        </div>

        {irsReport && (
          <>
            {/* YTD Summary */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
              <div style={sCard}><StatBox label="YTD Total Miles" value={fmtMi(irsReport.ytd.total_miles)} color={D.teal} /></div>
              <div style={sCard}><StatBox label="YTD Business Miles" value={fmtMi(irsReport.ytd.business_miles)} color={D.green} /></div>
              <div style={sCard}><StatBox label="YTD IRS Deduction" value={fmt(irsReport.ytd.irs_deduction)} color={D.amber} /></div>
              <div style={sCard}><StatBox label="Business %" value={`${(irsReport.ytd.business_pct || 100).toFixed(1)}%`} color={D.purple} /></div>
            </div>

            <div style={{ ...sCard, fontSize: 12, color: D.muted, marginBottom: 12 }}>
              IRS Standard Mileage Rate: <strong style={{ color: '#0F172A' }}>${irsReport.irs_rate}/mile</strong> | Total Trips: <strong style={{ color: '#0F172A' }}>{irsReport.ytd.trip_count}</strong>
            </div>

            {/* Monthly Breakdown */}
            <div style={{ ...sCard, overflowX: 'auto' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 12 }}>Monthly Breakdown</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                    <th style={th}>Month</th>
                    <th style={th}>Total Mi</th>
                    <th style={th}>Business Mi</th>
                    <th style={th}>Personal Mi</th>
                    <th style={th}>Trips</th>
                    <th style={th}>IRS Deduction</th>
                  </tr>
                </thead>
                <tbody>
                  {(irsReport.months || []).map(m => (
                    <tr key={m.month} style={{ borderBottom: `1px solid ${D.border}22` }}>
                      <td style={td}>{monthLabel(m.month + '-01')}</td>
                      <td style={td}>{fmtMi(m.total_miles)}</td>
                      <td style={{ ...td, color: D.green }}>{fmtMi(m.business_miles)}</td>
                      <td style={{ ...td, color: D.red }}>{fmtMi(m.personal_miles)}</td>
                      <td style={td}>{m.trip_count}</td>
                      <td style={{ ...td, color: D.amber, fontWeight: 600 }}>{fmt(m.irs_deduction)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${D.border}`, fontWeight: 700 }}>
                    <td style={td}>TOTAL</td>
                    <td style={td}>{fmtMi(irsReport.ytd.total_miles)}</td>
                    <td style={{ ...td, color: D.green }}>{fmtMi(irsReport.ytd.business_miles)}</td>
                    <td style={{ ...td, color: D.red }}>{fmtMi(irsReport.ytd.personal_miles)}</td>
                    <td style={td}>{irsReport.ytd.trip_count}</td>
                    <td style={{ ...td, color: D.amber }}>{fmt(irsReport.ytd.irs_deduction)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    );
  };

  // ── Render: Geo-Fences ───────────────────────────────────────
  const renderFences = () => {
    const types = ['business', 'personal', 'supplier', 'customer_zone'];
    const typeColor = { business: D.green, personal: D.red, supplier: D.purple, customer_zone: D.teal };

    return (
      <div>
        <div style={{ ...sCard, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>Geo-Fences</div>
          <button style={sBtn(D.teal, D.white)} onClick={() => setFenceForm({ name: '', fence_type: 'business', lat: '', lng: '', radius_meters: 200, notes: '' })}>Add Fence</button>
        </div>

        {/* Fence Form */}
        {fenceForm && (
          <div style={sCard}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 12 }}>{fenceForm.id ? 'Edit' : 'New'} Geo-Fence</div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
              <input placeholder="Name" value={fenceForm.name} onChange={e => setFenceForm({ ...fenceForm, name: e.target.value })} style={sInput} />
              <select value={fenceForm.fence_type} onChange={e => setFenceForm({ ...fenceForm, fence_type: e.target.value })} style={sInput}>
                {types.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input type="number" placeholder="Radius (m)" value={fenceForm.radius_meters} onChange={e => setFenceForm({ ...fenceForm, radius_meters: parseInt(e.target.value) || 200 })} style={sInput} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
              <input type="number" step="0.0000001" placeholder="Latitude" value={fenceForm.lat} onChange={e => setFenceForm({ ...fenceForm, lat: e.target.value })} style={sInput} />
              <input type="number" step="0.0000001" placeholder="Longitude" value={fenceForm.lng} onChange={e => setFenceForm({ ...fenceForm, lng: e.target.value })} style={sInput} />
              <input placeholder="Notes" value={fenceForm.notes || ''} onChange={e => setFenceForm({ ...fenceForm, notes: e.target.value })} style={sInput} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={sBtn(D.green, D.white)} onClick={saveFence}>Save</button>
              <button style={sBtn('transparent', D.muted)} onClick={() => setFenceForm(null)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Fences Table */}
        <div style={{ ...sCard, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                <th style={th}>Name</th>
                <th style={th}>Type</th>
                <th style={th}>Lat</th>
                <th style={th}>Lng</th>
                <th style={th}>Radius</th>
                <th style={th}>Notes</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {fences.map(f => (
                <tr key={f.id} style={{ borderBottom: `1px solid ${D.border}22` }}>
                  <td style={{ ...td, fontWeight: 600 }}>{f.name}</td>
                  <td style={td}><span style={sBadge(typeColor[f.fence_type] || D.muted, D.white)}>{f.fence_type}</span></td>
                  <td style={td}>{Number(f.lat).toFixed(4)}</td>
                  <td style={td}>{Number(f.lng).toFixed(4)}</td>
                  <td style={td}>{f.radius_meters}m</td>
                  <td style={{ ...td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.notes || '--'}</td>
                  <td style={td}>
                    <button style={{ ...sBtn('transparent', D.teal), marginRight: 4 }} onClick={() => setFenceForm({ id: f.id, name: f.name, fence_type: f.fence_type, lat: f.lat, lng: f.lng, radius_meters: f.radius_meters, notes: f.notes || '' })}>Edit</button>
                    <button style={sBtn('transparent', D.red)} onClick={() => deleteFence(f.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {fences.length === 0 && <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: D.muted }}>No geo-fences configured</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Toast */}
      {toast && <div style={{ position: 'fixed', top: 20, right: 20, background: D.teal, color: D.white, padding: '10px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999 }}>{toast}</div>}

      {/* Sub-navigation */}
      <div style={navStyle}>
        {tabs.map(t => (
          <button key={t.key} style={navBtn(section === t.key)} onClick={() => setSection(t.key)}>{t.label}</button>
        ))}
      </div>

      {/* Section Content */}
      {section === 'dashboard' && renderDashboard()}
      {section === 'trips' && renderTrips()}
      {section === 'monthly' && renderMonthly()}
      {section === 'irs' && renderIrs()}
      {section === 'fences' && renderFences()}
    </div>
  );
}

// ── Shared Components ────────────────────────────────────────────

function StatBox({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || '#0F172A', marginTop: 2 }}>{value}</div>
    </div>
  );
}

function TripRow({ trip, expanded, selected, onToggle, onSelect, onReclassify }) {
  const isBiz = trip.is_business !== false && trip.purpose !== 'personal';
  return (
    <>
      <tr style={{ borderBottom: `1px solid ${D.border}22`, cursor: 'pointer' }} onClick={onToggle}>
        <td style={td} onClick={e => e.stopPropagation()}><input type="checkbox" checked={selected} onChange={e => onSelect(e.target.checked)} /></td>
        <td style={td}>{toDateStr(trip.trip_date)}<br /><span style={{ color: D.muted, fontSize: 10 }}>{trip.created_at ? new Date(trip.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span></td>
        <td style={{ ...td, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncAddr(trip.start_address, 30)}</td>
        <td style={{ ...td, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncAddr(trip.end_address, 30)}</td>
        <td style={{ ...td, fontWeight: 600 }}>{fmtMi(trip.distance_miles)}</td>
        <td style={td}>{minToHM(trip.duration_minutes)}</td>
        <td style={{ ...td, color: trip.customer_name ? D.green : D.muted }}>{trip.customer_name || '--'}</td>
        <td style={td}><span style={sBadge(isBiz ? D.green : D.red, D.white)}>{isBiz ? 'BIZ' : 'PERS'}</span></td>
        <td style={{ ...td, color: D.amber }}>{fmt(trip.deduction_amount)}</td>
        <td style={td} onClick={e => e.stopPropagation()}>
          <button style={{ ...sBtn('transparent', isBiz ? D.red : D.green), fontSize: 10, padding: '3px 8px' }} onClick={() => onReclassify(!isBiz)}>{isBiz ? 'Personal' : 'Business'}</button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} style={{ padding: '8px 16px', background: '#F8FAFC', fontSize: 11 }}>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)', gap: 8 }}>
              <div><span style={{ color: D.muted }}>Start:</span> <span style={{ color: D.text }}>{trip.start_address || '--'}</span></div>
              <div><span style={{ color: D.muted }}>End:</span> <span style={{ color: D.text }}>{trip.end_address || '--'}</span></div>
              <div><span style={{ color: D.muted }}>Max Speed:</span> <span style={{ color: D.text }}>{trip.max_speed_mph || '--'} mph</span></div>
              <div><span style={{ color: D.muted }}>Hard Brakes:</span> <span style={{ color: D.text }}>{trip.hard_brakes || 0}</span></div>
              <div><span style={{ color: D.muted }}>Hard Accels:</span> <span style={{ color: D.text }}>{trip.hard_accels || 0}</span></div>
              <div><span style={{ color: D.muted }}>Idle:</span> <span style={{ color: D.text }}>{minToHM(trip.idle_minutes)}</span></div>
              <div><span style={{ color: D.muted }}>Fuel:</span> <span style={{ color: D.text }}>{trip.fuel_consumed_gal ? `${Number(trip.fuel_consumed_gal).toFixed(2)} gal` : '--'}</span></div>
              <div><span style={{ color: D.muted }}>MPG:</span> <span style={{ color: D.text }}>{trip.fuel_economy_mpg || '--'}</span></div>
              <div><span style={{ color: D.muted }}>Classification:</span> <span style={{ color: D.text }}>{trip.classification_method || '--'}</span></div>
              <div><span style={{ color: D.muted }}>Notes:</span> <span style={{ color: D.text }}>{trip.classification_notes || '--'}</span></div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function renderSpinner() {
  return <div style={{ textAlign: 'center', padding: 40, color: D.muted }}>Loading...</div>;
}

// ── Table Styles ─────────────────────────────────────────────────
const th = { textAlign: 'left', padding: '8px 6px', color: '#64748B', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' };
const td = { padding: '8px 6px', color: '#334155', verticalAlign: 'top' };
