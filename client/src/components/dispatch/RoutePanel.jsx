// client/src/components/dispatch/RoutePanel.jsx
import { useState, useEffect, useRef } from 'react';

const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' });

const SCORE_COLOR = (s) => s >= 80 ? '#0e8c6a' : s >= 65 ? '#ba7517' : '#a32d2d';
const BADGE = { critical: 'bg-green-100 text-green-800', high: 'bg-blue-100 text-blue-700', standard: 'bg-amber-100 text-amber-700', low: 'bg-red-100 text-red-700' };
const TIER_BADGE = { platinum: 'bg-purple-100 text-purple-700', gold: 'bg-yellow-100 text-yellow-700', silver: 'bg-gray-100 text-gray-600', bronze: 'bg-orange-100 text-orange-700' };

const SERVICE_ZONES = [
  { value: 'all', label: 'All Zones' },
  { value: 'lakewood_bradenton', label: 'Lakewood Ranch / Bradenton' },
  { value: 'parrish_palmetto', label: 'Parrish / Palmetto' },
  { value: 'sarasota', label: 'Sarasota' },
  { value: 'venice_northport', label: 'Venice / North Port' },
];

const AVG_JOB_DURATION_MIN = 25;
const AVG_DRIVE_BETWEEN_MIN = 12;
const DEFAULT_START_HOUR = 8;
const DEFAULT_CAPACITY = 8;

function estimateFinishTime(totalJobs, avgDrivePct) {
  if (!totalJobs) return '--';
  const totalMinutes = totalJobs * AVG_JOB_DURATION_MIN + totalJobs * AVG_DRIVE_BETWEEN_MIN;
  const startDate = new Date();
  startDate.setHours(DEFAULT_START_HOUR, 0, 0, 0);
  const finishDate = new Date(startDate.getTime() + totalMinutes * 60000);
  const hrs = finishDate.getHours();
  const mins = finishDate.getMinutes();
  const ampm = hrs >= 12 ? 'PM' : 'AM';
  const displayHr = hrs > 12 ? hrs - 12 : hrs === 0 ? 12 : hrs;
  return `${displayHr}:${mins.toString().padStart(2, '0')} ${ampm}`;
}

function capacityColor(pct) {
  if (pct > 90) return { bar: '#dc2626', bg: '#fef2f2', text: '#991b1b' };   // red
  if (pct >= 70) return { bar: '#d97706', bg: '#fffbeb', text: '#92400e' };  // amber
  return { bar: '#16a34a', bg: '#f0fdf4', text: '#166534' };                 // green
}

function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function MetricCard({ label, value, sub, accent }) {
  return (
    <div className={`rounded-xl p-4 ${accent ? '' : 'bg-gray-50'}`} style={accent ? { background: accent } : {}}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function CapacityBar({ current, max }) {
  const pct = max > 0 ? Math.round((current / max) * 100) : 0;
  const colors = capacityColor(pct);
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-2 rounded-full" style={{ background: colors.bg }}>
        <div className="h-2 rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%`, background: colors.bar }} />
      </div>
      <span className="text-xs font-medium" style={{ color: colors.text }}>{pct}%</span>
    </div>
  );
}

function ComparisonCard({ before, after }) {
  if (!before || !after) return null;
  const savedMiles = Math.round(before.totalMiles - after.totalMiles);
  const savedPct = before.totalMiles > 0 ? Math.round((savedMiles / before.totalMiles) * 100) : 0;
  const savedHrs = ((before.driveHours || 0) - (after.driveHours || 0)).toFixed(1);
  if (savedMiles <= 0 && savedHrs <= 0) return null;

  return (
    <div className="mb-4 bg-green-50 border border-green-200 rounded-xl p-4">
      <div className="text-xs font-semibold text-green-800 uppercase tracking-wide mb-2">Optimization Results</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div>
          <span className="text-gray-500">Before: </span>
          <span className="font-medium text-gray-700">{before.totalMiles} mi, {before.driveHours?.toFixed(1) || '?'} hrs driving</span>
        </div>
        <div>
          <span className="text-gray-500">After: </span>
          <span className="font-medium text-gray-700">{after.totalMiles} mi, {after.driveHours?.toFixed(1) || '?'} hrs driving</span>
        </div>
        <div>
          <span className="text-gray-500">Saved: </span>
          <span className="font-semibold text-green-700">{savedMiles} mi ({savedPct}%){savedHrs > 0 ? `, ${savedHrs} hrs` : ''}</span>
        </div>
      </div>
    </div>
  );
}

function JobRow({ job, index }) {
  const score = job.score || job.job_score || 0;
  const priority = job.priority || 'standard';
  const tier = job.waveguard_tier;

  return (
    <div className="flex items-center gap-3 py-3 border-b border-gray-100 last:border-0">
      <div className="w-6 h-6 rounded-full bg-green-50 text-green-700 text-xs font-medium flex items-center justify-center flex-shrink-0">
        {index + 1}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{job.customer_name}</div>
        <div className="text-xs text-gray-400 truncate">{job.address}{job.city ? `, ${job.city}` : ''}</div>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${BADGE[priority] || BADGE.standard}`}>
            {job.service_type?.replace(/_/g, ' ')}
          </span>
          {tier && tier !== 'none' && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_BADGE[tier] || ''}`}>
              {tier}
            </span>
          )}
          {job.scheduled_time && <span className="text-xs text-gray-400">{job.scheduled_time}</span>}
          {job.job_category === 'callback' && <span className="text-xs bg-red-50 text-red-600 px-2 py-0.5 rounded-full">callback</span>}
          {job.job_category === 'estimate' && <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">estimate</span>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <span className="text-sm font-semibold" style={{ color: SCORE_COLOR(score) }}>{score}</span>
        <div className="w-12 h-1 bg-gray-200 rounded-full">
          <div className="h-1 rounded-full" style={{ width: `${score}%`, background: SCORE_COLOR(score) }} />
        </div>
      </div>
    </div>
  );
}

function TechRoute({ route }) {
  const { tech, jobs, metrics, notes } = route;
  const [expanded, setExpanded] = useState(true);
  if (!tech) return null;

  const jobCount = metrics?.totalJobs || jobs?.length || 0;
  const capacity = tech.max_capacity || metrics?.capacity || DEFAULT_CAPACITY;
  const capacityPct = capacity > 0 ? Math.round((jobCount / capacity) * 100) : 0;
  const totalRevenue = metrics?.totalRevenue || (jobs || []).reduce((s, j) => s + (j.revenue || j.price || 0), 0);

  // Build route summary: unique cities/neighborhoods
  const cities = [...new Set((jobs || []).map(j => j.city || j.neighborhood).filter(Boolean))];

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ background: tech.color }} />
          <span className="text-sm font-semibold text-gray-800">{tech.name}</span>
          <span className="text-xs text-gray-400">{tech.territory_label}</span>
          <span className="text-xs text-gray-300 ml-1">{expanded ? '\u25B2' : '\u25BC'}</span>
        </div>
        <div className="flex gap-3 text-xs text-gray-500 flex-wrap justify-end">
          <span>{jobCount}/{capacity} stops</span>
          <span>{metrics?.estimatedMiles || 0} mi</span>
          <span className={metrics?.driveTimePct > 25 ? 'text-amber-600 font-medium' : 'text-green-600'}>{metrics?.driveTimePct || 0}% drive</span>
          <span className="font-medium text-gray-700">${metrics?.revenuePerHour || 0}/hr</span>
          {totalRevenue > 0 && <span className="font-medium text-green-700">${totalRevenue} rev</span>}
        </div>
      </div>

      {/* Capacity bar */}
      <CapacityBar current={jobCount} max={capacity} />

      {/* Route summary cities */}
      {cities.length > 0 && (
        <div className="mt-2 text-xs text-gray-400 truncate">
          Route: {cities.join(' \u2192 ')}
        </div>
      )}

      {notes && <p className="text-xs text-gray-400 mt-2 italic">{notes}</p>}

      {/* Expandable job list */}
      {expanded && (
        <div className="mt-3">
          {(jobs || []).map((job, i) => <JobRow key={job.id} job={job} index={i} />)}
          {!jobs?.length && <div className="text-sm text-gray-400 py-4 text-center">No jobs scheduled</div>}
        </div>
      )}
    </div>
  );
}

export default function RoutePanel({ date: dateProp }) {
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('mixed');
  const [zone, setZone] = useState('all');
  const [alert, setAlert] = useState('');
  const [selectedDate, setSelectedDate] = useState(dateProp || formatDate(new Date()));
  const [beforeSnapshot, setBeforeSnapshot] = useState(null);
  const [afterSnapshot, setAfterSnapshot] = useState(null);
  const dateInputRef = useRef(null);

  // Sync if parent passes a new date prop
  useEffect(() => {
    if (dateProp && dateProp !== selectedDate) setSelectedDate(dateProp);
  }, [dateProp]);

  const effectiveDate = selectedDate || dateProp;

  function buildSnapshot(routesList) {
    const totalMiles = routesList.reduce((s, r) => s + (r.metrics?.estimatedMiles || 0), 0);
    const totalDriveMin = routesList.reduce((s, r) => {
      const jobs = r.metrics?.totalJobs || 0;
      return s + jobs * AVG_DRIVE_BETWEEN_MIN + (r.metrics?.estimatedDriveMinutes || 0);
    }, 0);
    return { totalMiles, driveHours: totalDriveMin / 60 || totalMiles / 40 };
  }

  async function loadRoutes() {
    setLoading(true);
    try {
      const res = await fetch(`/api/dispatch/routes?date=${effectiveDate}&mode=${mode}&zone=${zone}`, { headers: authHeader() });
      const data = await res.json();
      setRoutes(data.routes || []);
      setBeforeSnapshot(null);
      setAfterSnapshot(null);
    } catch (err) {
      setAlert('Failed to load routes. Check server.');
    }
    setLoading(false);
  }

  async function reoptimize() {
    // Capture before snapshot
    const snap = buildSnapshot(routes);
    setBeforeSnapshot(snap);
    setLoading(true);
    try {
      const res = await fetch('/api/dispatch/routes/reoptimize', { method: 'POST', headers: authHeader(), body: JSON.stringify({ date: effectiveDate, mode, zone }) });
      const data = await res.json();
      const newRoutes = data.routes || [];
      setRoutes(newRoutes);
      setAfterSnapshot(buildSnapshot(newRoutes));
      setAlert(data.message || 'Routes reoptimized');
      setTimeout(() => setAlert(''), 5000);
    } catch {
      setAlert('Reoptimize failed');
      setAfterSnapshot(null);
    }
    setLoading(false);
  }

  useEffect(() => { loadRoutes(); }, [effectiveDate, mode, zone]);

  const totalJobs = routes.reduce((s, r) => s + (r.metrics?.totalJobs || 0), 0);
  const avgDrive = routes.length ? Math.round(routes.reduce((s, r) => s + (r.metrics?.driveTimePct || 0), 0) / routes.length) : 0;
  const totalMiles = routes.reduce((s, r) => s + (r.metrics?.estimatedMiles || 0), 0);
  const avgRevHr = routes.length ? Math.round(routes.reduce((s, r) => s + (r.metrics?.revenuePerHour || 0), 0) / routes.length) : 0;
  const estFinish = estimateFinishTime(totalJobs, avgDrive);

  // Savings from optimization (if available from server data)
  const unoptMiles = routes.reduce((s, r) => s + (r.metrics?.unoptimizedMiles || 0), 0);
  const savedMiles = unoptMiles > 0 ? Math.round(unoptMiles - totalMiles) : 0;
  const savedPct = unoptMiles > 0 ? Math.round((savedMiles / unoptMiles) * 100) : 0;

  // Date display label
  const isToday = effectiveDate === formatDate(new Date());
  const dateLabelSuffix = isToday ? ' (Today)' : '';

  return (
    <div>
      {/* Header metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <MetricCard label="Jobs today" value={totalJobs} sub={`${routes.length} techs active`} />
        <MetricCard label="Avg drive time" value={`${avgDrive}%`} sub="target < 25%" />
        <MetricCard label="Est. total miles" value={totalMiles} sub="all techs" />
        <MetricCard label="Avg rev / hr" value={`$${avgRevHr}`} sub="target $100+" />
        <MetricCard label="Est. finish" value={estFinish} sub="last tech done" />
        {savedMiles > 0 ? (
          <MetricCard label="Savings" value={`${savedMiles} mi`} sub={`${savedPct}% fewer miles`} accent="#f0fdf4" />
        ) : (
          <MetricCard label="Savings" value="--" sub="run optimize to compare" />
        )}
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Date picker */}
        <div className="relative">
          <input
            ref={dateInputRef}
            type="date"
            value={effectiveDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 font-medium focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          {!isToday && (
            <button
              onClick={() => setSelectedDate(formatDate(new Date()))}
              className="ml-1 px-2 py-1.5 text-xs text-green-700 hover:text-green-900 font-medium"
            >
              Today
            </button>
          )}
        </div>

        {/* Mode toggle */}
        <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
          {['mixed', 'recurring', 'one_time'].map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              {m === 'one_time' ? 'One-time' : m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Zone dropdown */}
        <select
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 font-medium focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
        >
          {SERVICE_ZONES.map((z) => (
            <option key={z.value} value={z.value}>{z.label}</option>
          ))}
        </select>

        <button onClick={reoptimize} disabled={loading} className="px-4 py-2 bg-green-700 text-white text-sm rounded-lg font-medium hover:bg-green-800 disabled:opacity-50">
          {loading ? 'Optimizing\u2026' : 'Re-optimize'}
        </button>
      </div>

      {/* Date indicator for non-today */}
      {!isToday && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-sm text-blue-700">
          Viewing routes for {new Date(effectiveDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
        </div>
      )}

      {/* Before/After comparison card */}
      <ComparisonCard before={beforeSnapshot} after={afterSnapshot} />

      {alert && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-700">{alert}</div>
      )}

      {loading && !routes.length ? (
        <div className="text-center py-16 text-gray-400 text-sm">Loading routes\u2026</div>
      ) : (
        routes.map((route, i) => <TechRoute key={i} route={route} />)
      )}
    </div>
  );
}
