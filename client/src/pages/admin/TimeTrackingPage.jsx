import { useState, useEffect, useCallback, useMemo } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };
const MONO = "'JetBrains Mono', monospace";
const LABOR_RATE = 35;

function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });
const sInput = { width: '100%', padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const fmt = (n) => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
const fmtHrs = (min) => min != null ? (parseFloat(min) / 60).toFixed(1) + 'h' : '--';
const fmtPct = (p) => p != null ? parseFloat(p).toFixed(1) + '%' : '--';
const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

const STATUS_COLORS = { active: D.green, completed: D.teal, edited: D.amber, voided: D.red, pending: D.amber, approved: D.green, disputed: D.red, exported: D.purple };
const TYPE_COLORS = { shift: D.teal, job: D.green, break: D.amber, drive: D.purple, admin_time: D.muted };

function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  return dt.toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function TimeTrackingPage() {
  const [tab, setTab] = useState('dashboard');
  const [toast, setToast] = useState('');
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: D.white }}>Time Tracking & Labor</div>
        <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>Clock management, timesheets, payroll, and labor analytics</div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
        {[
          { key: 'dashboard', label: 'Dashboard' },
          { key: 'timesheet', label: 'Timesheet' },
          { key: 'entries', label: 'Entries' },
          { key: 'analytics', label: 'Analytics' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
            whiteSpace: 'nowrap', flexShrink: 0, minHeight: 44,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'dashboard' && <DashboardTab showToast={showToast} />}
      {tab === 'timesheet' && <TimesheetTab showToast={showToast} />}
      {tab === 'entries' && <EntriesTab showToast={showToast} />}
      {tab === 'analytics' && <AnalyticsTab />}

      <div style={{ position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none' }}>
        <span style={{ color: D.green }}>OK</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// =============================================================================
// DASHBOARD TAB
// =============================================================================
function DashboardTab({ showToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch('/admin/timetracking');
      setData(res);
    } catch (e) { showToast('Failed to load dashboard'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 30000); return () => clearInterval(iv); }, [load]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>;
  if (!data) return <div style={{ color: D.red, padding: 40, textAlign: 'center' }}>Failed to load</div>;

  const { activeShifts, todaySummaries, weekDailies, allTechs } = data;

  // Today totals
  const todayShiftMin = todaySummaries.reduce((s, d) => s + parseFloat(d.total_shift_minutes || 0), 0);
  const todayJobMin = todaySummaries.reduce((s, d) => s + parseFloat(d.total_job_minutes || 0), 0);
  const todayRevenue = todaySummaries.reduce((s, d) => s + parseFloat(d.revenue_generated || 0), 0);
  const todayJobs = todaySummaries.reduce((s, d) => s + (d.job_count || 0), 0);
  const todayLaborCost = (todayShiftMin / 60) * LABOR_RATE;
  const todayUtil = todayShiftMin > 0 ? (todayJobMin / todayShiftMin * 100) : 0;

  // This week totals
  const weekShiftMin = weekDailies.reduce((s, d) => s + parseFloat(d.total_shift_minutes || 0), 0);
  const weekRevenue = weekDailies.reduce((s, d) => s + parseFloat(d.revenue_generated || 0), 0);
  const weekOT = Math.max(0, weekShiftMin - 2400);

  return (
    <div>
      {/* Live Tech Status Cards */}
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Live Status</div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 24 }}>
        {allTechs.map(tech => {
          const active = activeShifts.find(s => s.technician_id === tech.id);
          const summary = todaySummaries.find(s => s.technician_id === tech.id);
          const shiftDur = active ? ((Date.now() - new Date(active.clock_in).getTime()) / 60000) : 0;
          const dayHrs = summary ? parseFloat(summary.total_shift_minutes || 0) / 60 : 0;
          const dayJobs = summary ? summary.job_count : 0;
          const dayRev = summary ? parseFloat(summary.revenue_generated || 0) : 0;
          const dayUtil = summary ? parseFloat(summary.utilization_pct || 0) : 0;

          return (
            <div key={tech.id} style={{ ...sCard, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: active ? D.green : D.muted, boxShadow: active ? `0 0 8px ${D.green}` : 'none' }} />
                <div style={{ fontWeight: 600, color: D.white, flex: 1 }}>{tech.name}</div>
                <span style={sBadge(active ? D.green + '22' : D.muted + '22', active ? D.green : D.muted)}>
                  {active ? 'CLOCKED IN' : 'OFF'}
                </span>
              </div>
              {active && (
                <div style={{ fontSize: 12, color: D.muted }}>
                  Shift: {fmtHrs(shiftDur)} | {active.onBreak ? 'On Break' : active.currentJob ? `Job: ${active.currentJob.first_name || ''} ${active.currentJob.last_name || ''}`.trim() : 'Between jobs'}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <MiniStat label="Hours" value={dayHrs.toFixed(1)} />
                <MiniStat label="Jobs" value={dayJobs} />
                <MiniStat label="Revenue" value={fmt(dayRev)} />
              </div>
              {/* Utilization ring */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <UtilRing pct={dayUtil} size={32} />
                <span style={{ fontSize: 11, color: D.muted }}>Utilization: {dayUtil.toFixed(0)}%</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Today's Labor Summary */}
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Today's Labor</div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
        <StatCard label="Total Hours" value={fmtHrs(todayShiftMin)} color={D.teal} />
        <StatCard label="Labor Cost" value={fmt(todayLaborCost)} color={D.amber} />
        <StatCard label="Revenue" value={fmt(todayRevenue)} color={D.green} />
        <StatCard label="Jobs Done" value={todayJobs} color={D.purple} />
        <StatCard label="Utilization" value={fmtPct(todayUtil)} color={todayUtil >= 70 ? D.green : todayUtil >= 50 ? D.amber : D.red} />
      </div>

      {/* This Week Bar Chart */}
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>This Week</div>
      <div style={sCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: D.muted }}>Week total: {fmtHrs(weekShiftMin)} | Revenue: {fmt(weekRevenue)} | OT: {fmtHrs(weekOT)}</span>
        </div>
        <WeekBarChart weekDailies={weekDailies} weekStart={data.weekStart} />
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: D.white, fontFamily: MONO }}>{value}</div>
      <div style={{ fontSize: 10, color: D.muted }}>{label}</div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ ...sCard, textAlign: 'center', borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: MONO }}>{value}</div>
      <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function UtilRing({ pct, size = 32 }) {
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  const filled = circ * (pct / 100);
  const color = pct >= 70 ? D.green : pct >= 50 ? D.amber : D.red;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={D.border} strokeWidth={3} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={3}
        strokeDasharray={`${filled} ${circ - filled}`}
        strokeDashoffset={circ / 4} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.5s' }} />
    </svg>
  );
}

function WeekBarChart({ weekDailies, weekStart }) {
  const maxMin = 720; // 12 hours as max bar
  const barH = 120;
  const barW = isMobile ? 28 : 50;

  return (
    <svg width="100%" height={barH + 30} viewBox={`0 0 ${7 * (barW + 12) + 20} ${barH + 30}`}>
      {DAYS.map((day, i) => {
        const dateStr = addDays(weekStart, i);
        const dayData = weekDailies.filter(d => d.work_date === dateStr || (d.work_date && d.work_date.split('T')[0] === dateStr));
        const shiftMin = dayData.reduce((s, d) => s + parseFloat(d.total_shift_minutes || 0), 0);
        const otMin = dayData.reduce((s, d) => s + parseFloat(d.overtime_minutes || 0), 0);
        const regMin = shiftMin - otMin;
        const regH = Math.min((regMin / maxMin) * barH, barH);
        const otH = Math.min((otMin / maxMin) * barH, barH - regH);
        const x = i * (barW + 12) + 10;

        return (
          <g key={day}>
            {/* Regular time */}
            <rect x={x} y={barH - regH} width={barW} height={regH} fill={D.teal} rx={3} opacity={0.85} />
            {/* Overtime stacked */}
            {otH > 0 && <rect x={x} y={barH - regH - otH} width={barW} height={otH} fill={D.red} rx={3} opacity={0.85} />}
            {/* Hours label */}
            {shiftMin > 0 && <text x={x + barW / 2} y={barH - regH - otH - 4} textAnchor="middle" fontSize={9} fill={D.muted} fontFamily={MONO}>{(shiftMin / 60).toFixed(1)}</text>}
            {/* Day label */}
            <text x={x + barW / 2} y={barH + 16} textAnchor="middle" fontSize={10} fill={D.muted}>{day}</text>
          </g>
        );
      })}
      {/* Legend */}
      <rect x={7 * (barW + 12) - 60} y={2} width={8} height={8} fill={D.teal} rx={2} />
      <text x={7 * (barW + 12) - 48} y={10} fontSize={9} fill={D.muted}>Reg</text>
      <rect x={7 * (barW + 12) - 60} y={14} width={8} height={8} fill={D.red} rx={2} />
      <text x={7 * (barW + 12) - 48} y={22} fontSize={9} fill={D.muted}>OT</text>
    </svg>
  );
}

// =============================================================================
// TIMESHEET TAB
// =============================================================================
function TimesheetTab({ showToast }) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [dailies, setDailies] = useState([]);
  const [techs, setTechs] = useState([]);
  const [expanded, setExpanded] = useState(null); // { techId, date }
  const [cellEntries, setCellEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dailyRes, dashRes] = await Promise.all([
        adminFetch(`/admin/timetracking/daily?startDate=${weekStart}&endDate=${weekEnd}`),
        adminFetch('/admin/timetracking'),
      ]);
      setDailies(dailyRes);
      setTechs(dashRes.allTechs || []);
    } catch (e) { showToast('Failed to load timesheet'); }
    setLoading(false);
  }, [weekStart, weekEnd]);

  useEffect(() => { load(); }, [load]);

  const expandCell = useCallback(async (techId, date) => {
    if (expanded && expanded.techId === techId && expanded.date === date) {
      setExpanded(null);
      return;
    }
    setExpanded({ techId, date });
    try {
      const res = await adminFetch(`/admin/timetracking/entries?technicianId=${techId}&startDate=${date}&endDate=${date}`);
      setCellEntries(res.entries || []);
    } catch (e) { setCellEntries([]); }
  }, [expanded]);

  const bulkApprove = useCallback(async () => {
    const pendingIds = dailies.filter(d => d.status === 'pending').map(d => d.id);
    if (pendingIds.length === 0) { showToast('No pending entries'); return; }
    try {
      const res = await adminFetch('/admin/timetracking/daily/bulk-approve', { method: 'POST', body: { ids: pendingIds } });
      showToast(`Approved ${res.approved} day(s)`);
      load();
    } catch (e) { showToast('Bulk approve failed'); }
  }, [dailies, load]);

  const exportCSV = useCallback(() => {
    window.open(`${API_BASE}/admin/timetracking/payroll-export?weekStart=${weekStart}`, '_blank');
  }, [weekStart]);

  // Group dailies by tech
  const byTech = useMemo(() => {
    const map = {};
    techs.forEach(t => { map[t.id] = { tech: t, days: {} }; });
    dailies.forEach(d => {
      const tid = d.technician_id;
      if (!map[tid]) map[tid] = { tech: { id: tid, name: d.tech_name || 'Unknown' }, days: {} };
      const dateKey = typeof d.work_date === 'string' ? d.work_date.split('T')[0] : d.work_date;
      map[tid].days[dateKey] = d;
    });
    return Object.values(map);
  }, [dailies, techs]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>;

  return (
    <div>
      {/* Week nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={() => setWeekStart(addDays(weekStart, -7))} style={sBtn(D.card, D.text)}>&#9664; Prev</button>
        <span style={{ fontWeight: 600, color: D.white, fontFamily: MONO, fontSize: 14 }}>
          {weekStart} to {weekEnd}
        </span>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))} style={sBtn(D.card, D.text)}>Next &#9654;</button>
        <div style={{ flex: 1 }} />
        <button onClick={bulkApprove} style={sBtn(D.green, D.white)}>Approve All Pending</button>
        <button onClick={exportCSV} style={sBtn(D.teal, D.white)}>Export CSV</button>
      </div>

      {/* Timesheet grid */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: D.card }}>
              <th style={thStyle}>Tech</th>
              {DAYS.map((d, i) => <th key={d} style={thStyle}>{d}<br /><span style={{ fontSize: 9, color: D.muted }}>{addDays(weekStart, i).slice(5)}</span></th>)}
              <th style={thStyle}>Total</th>
              <th style={thStyle}>OT</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {byTech.map(({ tech, days }) => {
              let totalMin = 0, totalOT = 0;
              const allStatuses = [];
              DAYS.forEach((_, i) => {
                const dt = addDays(weekStart, i);
                const d = days[dt];
                if (d) {
                  totalMin += parseFloat(d.total_shift_minutes || 0);
                  totalOT += parseFloat(d.overtime_minutes || 0);
                  allStatuses.push(d.status);
                }
              });
              const weekStatus = allStatuses.includes('disputed') ? 'disputed' : allStatuses.includes('pending') ? 'pending' : allStatuses.length > 0 ? 'approved' : 'pending';

              return (
                <tr key={tech.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                  <td style={{ ...tdStyle, fontWeight: 600, color: D.white }}>{tech.name}</td>
                  {DAYS.map((_, i) => {
                    const dt = addDays(weekStart, i);
                    const d = days[dt];
                    const hrs = d ? (parseFloat(d.total_shift_minutes || 0) / 60).toFixed(1) : '--';
                    const color = !d ? D.muted : d.status === 'approved' ? D.green : d.status === 'edited' || d.status === 'pending' ? D.amber : D.red;
                    const isExp = expanded && expanded.techId === tech.id && expanded.date === dt;
                    return (
                      <td key={dt} style={{ ...tdStyle, cursor: 'pointer', background: isExp ? D.input : 'transparent' }}
                        onClick={() => expandCell(tech.id, dt)}>
                        <span style={{ color, fontFamily: MONO, fontWeight: 600 }}>{hrs}</span>
                      </td>
                    );
                  })}
                  <td style={{ ...tdStyle, fontFamily: MONO, fontWeight: 700, color: D.white }}>{(totalMin / 60).toFixed(1)}</td>
                  <td style={{ ...tdStyle, fontFamily: MONO, fontWeight: 700, color: totalOT > 0 ? D.red : D.muted }}>{(totalOT / 60).toFixed(1)}</td>
                  <td style={tdStyle}>
                    <span style={sBadge((STATUS_COLORS[weekStatus] || D.muted) + '22', STATUS_COLORS[weekStatus] || D.muted)}>
                      {weekStatus.toUpperCase()}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Expanded cell entries */}
      {expanded && (
        <div style={{ ...sCard, marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.white, marginBottom: 8 }}>
            Entries for {expanded.date}
          </div>
          {cellEntries.length === 0 ? (
            <div style={{ color: D.muted, fontSize: 12 }}>No entries</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr>
                  {['Type', 'Clock In', 'Clock Out', 'Duration', 'Customer', 'Status'].map(h => (
                    <th key={h} style={{ ...thStyle, fontSize: 10 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cellEntries.map(e => (
                  <tr key={e.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                    <td style={tdStyle}><span style={sBadge((TYPE_COLORS[e.entry_type] || D.muted) + '22', TYPE_COLORS[e.entry_type] || D.muted)}>{e.entry_type}</span></td>
                    <td style={{ ...tdStyle, fontFamily: MONO, fontSize: 10 }}>{e.clock_in ? new Date(e.clock_in).toLocaleTimeString() : '--'}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO, fontSize: 10 }}>{e.clock_out ? new Date(e.clock_out).toLocaleTimeString() : '--'}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{e.duration_minutes ? fmtHrs(e.duration_minutes) : '--'}</td>
                    <td style={tdStyle}>{e.customer_first_name ? `${e.customer_first_name} ${e.customer_last_name || ''}`.trim() : '--'}</td>
                    <td style={tdStyle}><span style={sBadge((STATUS_COLORS[e.status] || D.muted) + '22', STATUS_COLORS[e.status] || D.muted)}>{e.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const thStyle = { padding: '8px 6px', textAlign: 'left', color: D.muted, fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${D.border}` };
const tdStyle = { padding: '8px 6px', color: D.text, fontSize: 12 };

// =============================================================================
// ENTRIES TAB
// =============================================================================
function EntriesTab({ showToast }) {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState({ technicianId: '', startDate: '', endDate: '', entryType: '', status: '' });
  const [loading, setLoading] = useState(true);
  const [editModal, setEditModal] = useState(null);
  const [techs, setTechs] = useState([]);
  const LIMIT = 30;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', LIMIT);
      params.set('offset', page * LIMIT);
      if (filters.technicianId) params.set('technicianId', filters.technicianId);
      if (filters.startDate) params.set('startDate', filters.startDate);
      if (filters.endDate) params.set('endDate', filters.endDate);
      if (filters.entryType) params.set('entryType', filters.entryType);
      if (filters.status) params.set('status', filters.status);
      const res = await adminFetch(`/admin/timetracking/entries?${params.toString()}`);
      setEntries(res.entries || []);
      setTotal(res.total || 0);
    } catch (e) { showToast('Failed to load entries'); }
    setLoading(false);
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    adminFetch('/admin/timetracking').then(r => setTechs(r.allTechs || [])).catch(() => {});
  }, []);

  const handleVoid = useCallback(async (id) => {
    if (!window.confirm('Void this entry?')) return;
    try {
      await adminFetch(`/admin/timetracking/entries/${id}`, { method: 'DELETE', body: { reason: 'Admin voided from UI' } });
      showToast('Entry voided');
      load();
    } catch (e) { showToast('Void failed'); }
  }, [load]);

  const handleEdit = useCallback(async (formData) => {
    try {
      await adminFetch(`/admin/timetracking/entries/${formData.id}`, { method: 'PUT', body: formData });
      showToast('Entry updated');
      setEditModal(null);
      load();
    } catch (e) { showToast('Edit failed'); }
  }, [load]);

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div>
      {/* Filters */}
      <div style={{ ...sCard, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 120 }}>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Tech</label>
          <select value={filters.technicianId} onChange={e => { setFilters(f => ({ ...f, technicianId: e.target.value })); setPage(0); }} style={sInput}>
            <option value="">All</option>
            {techs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 120 }}>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Start Date</label>
          <input type="date" value={filters.startDate} onChange={e => { setFilters(f => ({ ...f, startDate: e.target.value })); setPage(0); }} style={sInput} />
        </div>
        <div style={{ minWidth: 120 }}>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>End Date</label>
          <input type="date" value={filters.endDate} onChange={e => { setFilters(f => ({ ...f, endDate: e.target.value })); setPage(0); }} style={sInput} />
        </div>
        <div style={{ minWidth: 100 }}>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Type</label>
          <select value={filters.entryType} onChange={e => { setFilters(f => ({ ...f, entryType: e.target.value })); setPage(0); }} style={sInput}>
            <option value="">All</option>
            {['shift', 'job', 'break', 'drive', 'admin_time'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 100 }}>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Status</label>
          <select value={filters.status} onChange={e => { setFilters(f => ({ ...f, status: e.target.value })); setPage(0); }} style={sInput}>
            <option value="">All</option>
            {['active', 'completed', 'edited', 'voided'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* Entries table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: D.card }}>
              {['Date', 'Tech', 'Type', 'Clock In', 'Clock Out', 'Duration', 'Customer', 'Service', 'Notes', 'Status', 'Actions'].map(h => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11} style={{ ...tdStyle, textAlign: 'center', color: D.muted }}>Loading...</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={11} style={{ ...tdStyle, textAlign: 'center', color: D.muted }}>No entries found</td></tr>
            ) : entries.map(e => (
              <tr key={e.id} style={{ borderBottom: `1px solid ${D.border}`, opacity: e.status === 'voided' ? 0.5 : 1 }}>
                <td style={tdStyle}>{e.clock_in ? new Date(e.clock_in).toLocaleDateString() : '--'}</td>
                <td style={tdStyle}>{e.tech_name || '--'}</td>
                <td style={tdStyle}><span style={sBadge((TYPE_COLORS[e.entry_type] || D.muted) + '22', TYPE_COLORS[e.entry_type] || D.muted)}>{e.entry_type}</span></td>
                <td style={{ ...tdStyle, fontFamily: MONO, fontSize: 10 }}>{e.clock_in ? new Date(e.clock_in).toLocaleTimeString() : '--'}</td>
                <td style={{ ...tdStyle, fontFamily: MONO, fontSize: 10 }}>{e.clock_out ? new Date(e.clock_out).toLocaleTimeString() : '--'}</td>
                <td style={{ ...tdStyle, fontFamily: MONO }}>{e.duration_minutes ? fmtHrs(e.duration_minutes) : '--'}</td>
                <td style={tdStyle}>{e.customer_first_name ? `${e.customer_first_name} ${e.customer_last_name || ''}`.trim() : '--'}</td>
                <td style={tdStyle}>{e.service_type || e.job_service_type || '--'}</td>
                <td style={{ ...tdStyle, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.notes || '--'}</td>
                <td style={tdStyle}><span style={sBadge((STATUS_COLORS[e.status] || D.muted) + '22', STATUS_COLORS[e.status] || D.muted)}>{e.status}</span></td>
                <td style={tdStyle}>
                  {e.status !== 'voided' && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => setEditModal(e)} style={sBtn(D.amber + '33', D.amber)} title="Edit">Edit</button>
                      <button onClick={() => handleVoid(e.id)} style={sBtn(D.red + '33', D.red)} title="Void">Void</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={sBtn(D.card, D.text)}>Prev</button>
          <span style={{ color: D.muted, fontSize: 12, padding: '8px 0' }}>Page {page + 1} of {totalPages} ({total} entries)</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} style={sBtn(D.card, D.text)}>Next</button>
        </div>
      )}

      {/* Edit Modal */}
      {editModal && <EditEntryModal entry={editModal} onClose={() => setEditModal(null)} onSave={handleEdit} />}
    </div>
  );
}

function EditEntryModal({ entry, onClose, onSave }) {
  const [form, setForm] = useState({
    id: entry.id,
    clock_in: entry.clock_in ? new Date(entry.clock_in).toISOString().slice(0, 16) : '',
    clock_out: entry.clock_out ? new Date(entry.clock_out).toISOString().slice(0, 16) : '',
    entry_type: entry.entry_type,
    notes: entry.notes || '',
    edit_reason: '',
  });

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div style={{ ...sCard, maxWidth: 500, width: '100%' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: D.white, marginBottom: 16 }}>Edit Time Entry</div>

        {entry.original_clock_in && (
          <div style={{ fontSize: 11, color: D.amber, marginBottom: 12, padding: 8, background: D.amber + '11', borderRadius: 6 }}>
            Original: {new Date(entry.original_clock_in).toLocaleString()} - {entry.original_clock_out ? new Date(entry.original_clock_out).toLocaleString() : 'active'}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: D.muted, display: 'block', marginBottom: 4 }}>Type</label>
            <select value={form.entry_type} onChange={e => setForm(f => ({ ...f, entry_type: e.target.value }))} style={sInput}>
              {['shift', 'job', 'break', 'drive', 'admin_time'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: D.muted, display: 'block', marginBottom: 4 }}>Clock In</label>
            <input type="datetime-local" value={form.clock_in} onChange={e => setForm(f => ({ ...f, clock_in: e.target.value }))} style={sInput} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: D.muted, display: 'block', marginBottom: 4 }}>Clock Out</label>
            <input type="datetime-local" value={form.clock_out} onChange={e => setForm(f => ({ ...f, clock_out: e.target.value }))} style={sInput} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: D.muted, display: 'block', marginBottom: 4 }}>Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...sInput, minHeight: 60, resize: 'vertical' }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: D.red, display: 'block', marginBottom: 4 }}>Edit Reason (required)</label>
            <input type="text" value={form.edit_reason} onChange={e => setForm(f => ({ ...f, edit_reason: e.target.value }))} style={sInput} placeholder="Why is this being changed?" />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={onClose} style={sBtn(D.card, D.muted)}>Cancel</button>
            <button disabled={!form.edit_reason} onClick={() => onSave(form)} style={{ ...sBtn(D.teal, D.white), opacity: form.edit_reason ? 1 : 0.5 }}>Save Changes</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// ANALYTICS TAB
// =============================================================================
function AnalyticsTab() {
  const [data, setData] = useState(null);
  const [comparison, setComparison] = useState([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState({ start: addDays(new Date().toISOString().split('T')[0], -30), end: new Date().toISOString().split('T')[0] });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      adminFetch(`/admin/timetracking/analytics?startDate=${range.start}&endDate=${range.end}`),
      adminFetch(`/admin/timetracking/analytics/comparison?startDate=${range.start}&endDate=${range.end}`),
    ]).then(([ana, cmp]) => {
      setData(ana);
      setComparison(cmp);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [range]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>;
  if (!data) return <div style={{ color: D.red, padding: 40, textAlign: 'center' }}>Failed to load analytics</div>;

  const { serviceTypeStats, utilizationByTech, rpmhByTech, overtimeTrend } = data;

  // Compute RPMH aggregates per tech
  const rpmhMap = {};
  (rpmhByTech || []).forEach(r => {
    if (!rpmhMap[r.technician_id]) rpmhMap[r.technician_id] = { name: r.tech_name, weeks: [] };
    rpmhMap[r.technician_id].weeks.push(r);
  });

  // Build utilization trend data (12 weeks)
  const utilTrend = {};
  (overtimeTrend || []).forEach(o => {
    if (!utilTrend[o.week_start]) utilTrend[o.week_start] = { week: o.week_start, util: [], ot: 0 };
    utilTrend[o.week_start].util.push(parseFloat(o.utilization_pct || 0));
    utilTrend[o.week_start].ot += parseFloat(o.overtime_minutes || 0);
  });
  const utilWeeks = Object.values(utilTrend).sort((a, b) => a.week < b.week ? -1 : 1);

  return (
    <div>
      {/* Date range */}
      <div style={{ ...sCard, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Start</label>
          <input type="date" value={range.start} onChange={e => setRange(r => ({ ...r, start: e.target.value }))} style={sInput} />
        </div>
        <div>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>End</label>
          <input type="date" value={range.end} onChange={e => setRange(r => ({ ...r, end: e.target.value }))} style={sInput} />
        </div>
      </div>

      {/* Actual vs Estimated */}
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Actual vs Estimated by Service Type</div>
      <div style={sCard}>
        {serviceTypeStats.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 12 }}>No job data in this period</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>{['Service Type', 'Jobs', 'Avg Est (min)', 'Avg Actual (min)', 'Variance', 'Accuracy'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {serviceTypeStats.map(s => {
                const est = parseFloat(s.avg_estimated || 0);
                const act = parseFloat(s.avg_actual || 0);
                const variance = act - est;
                const accuracy = est > 0 ? ((1 - Math.abs(variance) / est) * 100) : 0;
                return (
                  <tr key={s.svc_type} style={{ borderBottom: `1px solid ${D.border}` }}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{s.svc_type}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{s.job_count}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{est.toFixed(0)}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{act.toFixed(0)}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO, color: variance > 0 ? D.red : D.green }}>{variance > 0 ? '+' : ''}{variance.toFixed(0)}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO, color: accuracy >= 80 ? D.green : accuracy >= 60 ? D.amber : D.red }}>{accuracy.toFixed(0)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Per-tech comparison */}
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Per-Tech Service Time Comparison</div>
      <div style={sCard}>
        {comparison.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 12 }}>No comparison data</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>{['Tech', 'Service Type', 'Jobs', 'Avg Est', 'Avg Actual', 'Variance'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {comparison.map((c, i) => {
                const est = parseFloat(c.avg_estimated || 0);
                const act = parseFloat(c.avg_actual || 0);
                const v = act - est;
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${D.border}` }}>
                    <td style={tdStyle}>{c.tech_name}</td>
                    <td style={tdStyle}>{c.svc_type}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{c.job_count}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{est.toFixed(0)} min</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{act.toFixed(0)} min</td>
                    <td style={{ ...tdStyle, fontFamily: MONO, color: v > 0 ? D.red : D.green }}>{v > 0 ? '+' : ''}{v.toFixed(0)} min</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* RPMH by Tech */}
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Revenue Per Man-Hour (RPMH)</div>
      <div style={sCard}>
        {Object.keys(rpmhMap).length === 0 ? (
          <div style={{ color: D.muted, fontSize: 12 }}>No RPMH data yet</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>{['Tech', 'This Week', '4-Week Avg', 'vs $35 Target', 'Status'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {Object.values(rpmhMap).map(({ name, weeks }) => {
                const latest = weeks[weeks.length - 1];
                const avg4 = weeks.length > 0 ? weeks.reduce((s, w) => s + parseFloat(w.avg_rpmh || 0), 0) / weeks.length : 0;
                const vsTarget = avg4 - LABOR_RATE;
                const color = vsTarget >= 0 ? D.green : vsTarget >= -10 ? D.amber : D.red;
                return (
                  <tr key={name} style={{ borderBottom: `1px solid ${D.border}` }}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{name}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{fmt(latest?.avg_rpmh)}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO }}>{fmt(avg4)}</td>
                    <td style={{ ...tdStyle, fontFamily: MONO, color }}>{vsTarget >= 0 ? '+' : ''}{fmt(vsTarget)}</td>
                    <td style={tdStyle}><span style={sBadge(color + '22', color)}>{vsTarget >= 0 ? 'PROFITABLE' : 'BELOW TARGET'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Utilization Trend - SVG Line Chart */}
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Utilization Trend (12 Weeks)</div>
      <div style={sCard}>
        {utilWeeks.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 12 }}>No trend data yet</div>
        ) : (
          <UtilizationLineChart weeks={utilWeeks} />
        )}
      </div>

      {/* Overtime by Tech */}
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Weekly Overtime</div>
      <div style={sCard}>
        {(overtimeTrend || []).length === 0 ? (
          <div style={{ color: D.muted, fontSize: 12 }}>No overtime data</div>
        ) : (
          <OvertimeTable data={overtimeTrend || []} />
        )}
      </div>
    </div>
  );
}

function UtilizationLineChart({ weeks }) {
  const w = isMobile ? 300 : 600;
  const h = 150;
  const pad = { t: 20, r: 20, b: 30, l: 40 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  const maxUtil = 100;
  const points = weeks.map((wk, i) => {
    const avgUtil = wk.util.length > 0 ? wk.util.reduce((a, b) => a + b, 0) / wk.util.length : 0;
    const x = pad.l + (i / Math.max(weeks.length - 1, 1)) * innerW;
    const y = pad.t + innerH - (avgUtil / maxUtil) * innerH;
    return { x, y, util: avgUtil, week: wk.week };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} style={{ overflow: 'visible' }}>
      {/* Grid lines */}
      {[0, 25, 50, 75, 100].map(v => {
        const y = pad.t + innerH - (v / maxUtil) * innerH;
        return (
          <g key={v}>
            <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} stroke={D.border} strokeWidth={0.5} />
            <text x={pad.l - 4} y={y + 3} textAnchor="end" fontSize={8} fill={D.muted}>{v}%</text>
          </g>
        );
      })}
      {/* Target line at 70% */}
      <line x1={pad.l} y1={pad.t + innerH - (70 / maxUtil) * innerH} x2={w - pad.r} y2={pad.t + innerH - (70 / maxUtil) * innerH}
        stroke={D.green} strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />
      <text x={w - pad.r + 2} y={pad.t + innerH - (70 / maxUtil) * innerH + 3} fontSize={8} fill={D.green}>70% target</text>
      {/* Line */}
      <path d={pathD} fill="none" stroke={D.teal} strokeWidth={2} />
      {/* Dots + labels */}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={3} fill={D.teal} />
          {i % 2 === 0 && <text x={p.x} y={h - 5} textAnchor="middle" fontSize={7} fill={D.muted}>{p.week.slice(5)}</text>}
        </g>
      ))}
    </svg>
  );
}

function OvertimeTable({ data }) {
  // Group by tech
  const byTech = {};
  data.forEach(o => {
    const key = o.tech_name || 'Unknown';
    if (!byTech[key]) byTech[key] = [];
    byTech[key].push(o);
  });

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>{['Tech', 'Week', 'OT Hours', 'Flag'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {Object.entries(byTech).map(([name, rows]) =>
          rows.filter(r => parseFloat(r.overtime_minutes || 0) > 0).map((r, i) => {
            const otHrs = parseFloat(r.overtime_minutes || 0) / 60;
            return (
              <tr key={`${name}-${i}`} style={{ borderBottom: `1px solid ${D.border}` }}>
                <td style={tdStyle}>{name}</td>
                <td style={tdStyle}>{r.week_start}</td>
                <td style={{ ...tdStyle, fontFamily: MONO, color: otHrs > 5 ? D.red : D.amber }}>{otHrs.toFixed(1)}</td>
                <td style={tdStyle}>{otHrs > 5 ? <span style={sBadge(D.red + '22', D.red)}>HIGH OT</span> : <span style={sBadge(D.amber + '22', D.amber)}>OT</span>}</td>
              </tr>
            );
          })
        )}
        {Object.values(byTech).every(rows => rows.every(r => parseFloat(r.overtime_minutes || 0) === 0)) && (
          <tr><td colSpan={4} style={{ ...tdStyle, textAlign: 'center', color: D.muted }}>No overtime recorded</td></tr>
        )}
      </tbody>
    </table>
  );
}
