// client/src/components/dispatch/InsightsPanel.jsx
import { useState, useEffect } from 'react';

const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` });
const BAR_COLOR = (pct) => pct >= 80 ? '#0e8c6a' : pct >= 60 ? '#ba7517' : '#888780';

export default function InsightsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(30);

  async function load(d = days) {
    setLoading(true);
    try {
      const res = await fetch(`/api/dispatch/insights?days=${d}`, { headers: authHeader() });
      setData(await res.json());
    } catch { setData(null); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const s = data?.summary || {};
  const techs = data?.techMetrics || [];
  const forecast = data?.forecast || [];

  return (
    <div>
      {/* Period toggle */}
      <div className="flex items-center gap-2 mb-5">
        <span className="text-xs text-gray-400">Period:</span>
        {[7, 30, 90].map((d) => (
          <button key={d} onClick={() => { setDays(d); load(d); }}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-all ${days === d ? 'bg-green-700 text-white border-green-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
            {d}d
          </button>
        ))}
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <div className="bg-gray-50 rounded-xl p-4"><div className="text-xs text-gray-500 mb-1">Rev / route hr</div><div className="text-2xl font-semibold text-gray-900">${s.avgRevPerHr || '—'}</div><div className="text-xs text-gray-400">target $100+</div></div>
        <div className="bg-gray-50 rounded-xl p-4"><div className="text-xs text-gray-500 mb-1">Avg drive time</div><div className={`text-2xl font-semibold ${(s.avgDrivePct || 0) > 25 ? 'text-amber-600' : 'text-green-700'}`}>{s.avgDrivePct || '—'}%</div><div className="text-xs text-gray-400">target &lt;25%</div></div>
        <div className="bg-gray-50 rounded-xl p-4"><div className="text-xs text-gray-500 mb-1">Completion rate</div><div className="text-2xl font-semibold text-gray-900">{s.completionRate || '—'}%</div><div className="text-xs text-gray-400">last {days} days</div></div>
        <div className="bg-gray-50 rounded-xl p-4"><div className="text-xs text-gray-500 mb-1">Callback rate</div><div className={`text-2xl font-semibold ${(s.callbackRate || 0) > 6 ? 'text-red-600' : 'text-gray-900'}`}>{s.callbackRate || '—'}%</div><div className="text-xs text-gray-400">target &lt;5%</div></div>
        <div className="bg-gray-50 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Actual revenue</div>
          <div className="text-2xl font-semibold text-gray-900">${s.actualRevenue ? s.actualRevenue.toLocaleString() : '—'}</div>
          {s.revenueVariance != null && s.revenueVariance !== 0 && (
            <div className={`text-xs font-medium ${s.revenueVariance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {s.revenueVariance >= 0 ? '+' : ''}{typeof s.revenueVariance === 'number' ? `$${s.revenueVariance.toLocaleString()}` : '—'} vs forecast
            </div>
          )}
          {(!s.revenueVariance && s.revenueVariance !== 0) && <div className="text-xs text-gray-400">vs ${s.expectedRevenue ? `$${s.expectedRevenue.toLocaleString()} forecast` : 'no forecast'}</div>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Tech performance */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Performance by tech</div>
          {loading ? <div className="text-sm text-gray-400 py-6 text-center">Loading…</div> : (
            <div className="divide-y divide-gray-100">
              {techs.map((t) => (
                <div key={t.id} className="py-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: t.color }} />
                      <span className="text-sm font-semibold text-gray-800">{t.name}</span>
                    </div>
                    <span className="text-sm font-bold text-gray-900">${t.revenuePerHour}/hr</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-green-50 rounded-lg p-2 text-center">
                      <div className="text-sm font-semibold text-green-700">{t.completionRate}%</div>
                      <div className="text-xs text-gray-400">completion</div>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-2 text-center">
                      <div className="text-sm font-semibold text-blue-700">{t.upsellRate}%</div>
                      <div className="text-xs text-gray-400">upsell</div>
                    </div>
                    <div className={`rounded-lg p-2 text-center ${t.callbackRate > 5 ? 'bg-red-50' : 'bg-gray-50'}`}>
                      <div className={`text-sm font-semibold ${t.callbackRate > 5 ? 'text-red-600' : 'text-gray-600'}`}>{t.callbackRate}%</div>
                      <div className="text-xs text-gray-400">callback</div>
                    </div>
                  </div>
                </div>
              ))}
              {!techs.length && <div className="text-sm text-gray-400 py-6 text-center">No tech data yet</div>}
            </div>
          )}
        </div>

        {/* Seasonal forecast */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">Seasonal demand — next 30 days</div>
          <div className="text-xs text-gray-400 mb-3">Push promos for high-demand services now</div>
          <div className="divide-y divide-gray-100">
            {forecast.map((f) => (
              <div key={f.service} className="flex items-center gap-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800">{f.service}</div>
                  <div className="text-xs text-gray-400">{f.note}</div>
                </div>
                <div className="w-24 h-1.5 bg-gray-100 rounded-full flex-shrink-0">
                  <div className="h-1.5 rounded-full transition-all" style={{ width: `${f.demandPct}%`, background: BAR_COLOR(f.demandPct) }} />
                </div>
                <div className="text-sm font-semibold w-10 text-right flex-shrink-0" style={{ color: BAR_COLOR(f.demandPct) }}>{f.demandPct}%</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
