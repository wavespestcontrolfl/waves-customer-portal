// client/src/components/dispatch/RoutePanel.jsx
import { useState, useEffect } from 'react';

const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' });

const SCORE_COLOR = (s) => s >= 80 ? '#0e8c6a' : s >= 65 ? '#ba7517' : '#a32d2d';
const BADGE = { critical: 'bg-green-100 text-green-800', high: 'bg-blue-100 text-blue-700', standard: 'bg-amber-100 text-amber-700', low: 'bg-red-100 text-red-700' };
const TIER_BADGE = { platinum: 'bg-purple-100 text-purple-700', gold: 'bg-yellow-100 text-yellow-700', silver: 'bg-gray-100 text-gray-600', bronze: 'bg-orange-100 text-orange-700' };

function MetricCard({ label, value, sub }) {
  return (
    <div className="bg-gray-50 rounded-xl p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
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
  if (!tech) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ background: tech.color }} />
          <span className="text-sm font-semibold text-gray-800">{tech.name}</span>
          <span className="text-xs text-gray-400">{tech.territory_label}</span>
        </div>
        <div className="flex gap-3 text-xs text-gray-500">
          <span>{metrics?.totalJobs || 0} jobs</span>
          <span>{metrics?.estimatedMiles || 0} mi</span>
          <span className={metrics?.driveTimePct > 25 ? 'text-amber-600 font-medium' : 'text-green-600'}>{metrics?.driveTimePct || 0}% drive</span>
          <span className="font-medium text-gray-700">${metrics?.revenuePerHour || 0}/hr</span>
        </div>
      </div>
      {notes && <p className="text-xs text-gray-400 mb-3 italic">{notes}</p>}
      <div>
        {(jobs || []).map((job, i) => <JobRow key={job.id} job={job} index={i} />)}
        {!jobs?.length && <div className="text-sm text-gray-400 py-4 text-center">No jobs scheduled</div>}
      </div>
    </div>
  );
}

export default function RoutePanel({ date }) {
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('mixed');
  const [zone, setZone] = useState('all');
  const [alert, setAlert] = useState('');

  async function loadRoutes() {
    setLoading(true);
    try {
      const res = await fetch(`/api/dispatch/routes?date=${date}&mode=${mode}&zone=${zone}`, { headers: authHeader() });
      const data = await res.json();
      setRoutes(data.routes || []);
    } catch (err) {
      setAlert('Failed to load routes. Check server.');
    }
    setLoading(false);
  }

  async function reoptimize() {
    setLoading(true);
    try {
      const res = await fetch('/api/dispatch/routes/reoptimize', { method: 'POST', headers: authHeader(), body: JSON.stringify({ date, mode, zone }) });
      const data = await res.json();
      setRoutes(data.routes || []);
      setAlert(data.message || 'Routes reoptimized');
      setTimeout(() => setAlert(''), 5000);
    } catch {
      setAlert('Reoptimize failed');
    }
    setLoading(false);
  }

  useEffect(() => { loadRoutes(); }, [date, mode, zone]);

  const totalJobs = routes.reduce((s, r) => s + (r.metrics?.totalJobs || 0), 0);
  const avgDrive = routes.length ? Math.round(routes.reduce((s, r) => s + (r.metrics?.driveTimePct || 0), 0) / routes.length) : 0;
  const totalMiles = routes.reduce((s, r) => s + (r.metrics?.estimatedMiles || 0), 0);
  const avgRevHr = routes.length ? Math.round(routes.reduce((s, r) => s + (r.metrics?.revenuePerHour || 0), 0) / routes.length) : 0;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <MetricCard label="Jobs today" value={totalJobs} sub={`${routes.length} techs active`} />
        <MetricCard label="Avg drive time" value={`${avgDrive}%`} sub="target < 25%" />
        <MetricCard label="Est. total miles" value={totalMiles} sub="all techs" />
        <MetricCard label="Avg rev / hr" value={`$${avgRevHr}`} sub="target $100+" />
      </div>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Mode toggle */}
        <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
          {['mixed', 'recurring', 'one_time'].map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              {m === 'one_time' ? 'One-time' : m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        {/* Zone toggle */}
        <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
          {['all', 'north', 'south'].map((z) => (
            <button key={z} onClick={() => setZone(z)} className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${zone === z ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              {z.charAt(0).toUpperCase() + z.slice(1)}
            </button>
          ))}
        </div>
        <button onClick={reoptimize} disabled={loading} className="px-4 py-2 bg-green-700 text-white text-sm rounded-lg font-medium hover:bg-green-800 disabled:opacity-50">
          {loading ? 'Optimizing…' : 'Re-optimize'}
        </button>
      </div>

      {alert && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-700">{alert}</div>
      )}

      {loading && !routes.length ? (
        <div className="text-center py-16 text-gray-400 text-sm">Loading routes…</div>
      ) : (
        routes.map((route, i) => <TechRoute key={i} route={route} />)
      )}
    </div>
  );
}
