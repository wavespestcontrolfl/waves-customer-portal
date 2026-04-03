// client/src/components/dispatch/RevenuePanel.jsx
import { useState, useEffect } from 'react';

const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` });
const SCORE_COLOR = (s) => s >= 80 ? '#0e8c6a' : s >= 65 ? '#ba7517' : '#a32d2d';
const SCORE_BG = (s) => s >= 80 ? 'bg-green-50 border-green-100' : s >= 65 ? 'bg-amber-50 border-amber-100' : 'bg-red-50 border-red-100';

export default function RevenuePanel({ date }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/dispatch/jobs?date=${date}&status=scheduled`, { headers: authHeader() });
      const data = await res.json();
      const sorted = (Array.isArray(data) ? data : []).sort((a, b) => (b.job_score || 0) - (a.job_score || 0));
      setJobs(sorted);
    } catch { setJobs([]); }
    setLoading(false);
  }

  useEffect(() => { load(); }, [date]);

  const highValue = jobs.filter((j) => (j.job_score || 0) >= 80).length;
  const atRisk = jobs.filter((j) => (j.job_score || 0) < 55).length;
  const upsellFlags = jobs.filter((j) => (j.upsell_flags || []).length > 0).length;
  const callbacks = jobs.filter((j) => j.job_category === 'callback').length;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-gray-50 rounded-xl p-4"><div className="text-xs text-gray-500 mb-1">Avg job score</div><div className="text-2xl font-semibold">{jobs.length ? Math.round(jobs.reduce((s, j) => s + (j.job_score || 0), 0) / jobs.length) : '—'}</div><div className="text-xs text-gray-400">/ 100</div></div>
        <div className="bg-gray-50 rounded-xl p-4"><div className="text-xs text-gray-500 mb-1">Protect slots</div><div className="text-2xl font-semibold text-green-700">{highValue}</div><div className="text-xs text-gray-400">score ≥ 80</div></div>
        <div className="bg-gray-50 rounded-xl p-4"><div className="text-xs text-gray-500 mb-1">Upsell opps</div><div className="text-2xl font-semibold text-blue-700">{upsellFlags}</div><div className="text-xs text-gray-400">flagged today</div></div>
        <div className="bg-gray-50 rounded-xl p-4"><div className="text-xs text-gray-500 mb-1">Low priority</div><div className="text-2xl font-semibold text-red-600">{atRisk}</div><div className="text-xs text-gray-400">score &lt; 55</div></div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">Score formula</div>
        <p className="text-sm text-gray-500">
          Job score = <strong className="text-gray-700">Revenue (40%)</strong> + <strong className="text-gray-700">Renewal probability (25%)</strong> + <strong className="text-gray-700">Upsell potential (20%)</strong> + <strong className="text-gray-700">Route efficiency (15%)</strong>
          &nbsp;&nbsp;·&nbsp;&nbsp;Score ≥ 80 = protect · 55–79 = standard · &lt;55 = can move
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Today's job scores</div>
        {loading ? <div className="text-sm text-gray-400 py-8 text-center">Loading…</div> : (
          <div>
            {jobs.map((job) => {
              const score = job.job_score || 0;
              const bd = job.score_breakdown || {};
              const flags = job.upsell_flags || [];
              return (
                <div key={job.id} className={`flex items-center gap-3 p-3 rounded-lg border mb-2 ${SCORE_BG(score)}`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900">{job.customer_name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{job.service_type?.replace(/_/g, ' ')} · {job.waveguard_tier !== 'none' ? job.waveguard_tier : job.job_category}</div>
                    {flags.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {flags.map((f, i) => <span key={i} className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">{f}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <div className="text-lg font-bold" style={{ color: SCORE_COLOR(score) }}>{score}</div>
                    <div className="w-20 h-1.5 bg-gray-200 rounded-full mt-1">
                      <div className="h-1.5 rounded-full" style={{ width: `${score}%`, background: SCORE_COLOR(score) }} />
                    </div>
                    <div className="text-xs text-gray-400 mt-1">{bd.revenue_pts || 0}+{bd.renewal_pts || 0}+{bd.upsell_pts || 0}+{bd.efficiency_pts || 0}</div>
                  </div>
                </div>
              );
            })}
            {!jobs.length && <div className="text-sm text-gray-400 py-6 text-center">No jobs found for {date}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
