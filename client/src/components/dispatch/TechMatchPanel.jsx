// client/src/components/dispatch/TechMatchPanel.jsx
import { useState } from 'react';

const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' });

const SERVICES = ['general_pest', 'termite', 'wdo_inspection', 'lawn', 'mosquito', 'tree_shrub', 'german_roach', 'stinging_insect', 'rodent', 'callback'];
const ZIPS = ['34219 – Parrish', '34208 – Bradenton', '34240 – Lakewood Ranch', '34231 – Sarasota', '34234 – Sarasota N', '34285 – Venice', '34286 – North Port', '33980 – Port Charlotte'];
const CATEGORIES = ['recurring', 'one_time', 'estimate', 'callback'];

const RULES = [
  { rule: 'License / certification match', detail: 'Termite, WDO, restricted pest apps require licensed tech', level: 'required' },
  { rule: 'Service line specialization', detail: 'Termite → Adam only · Lawn → lawn-certified only', level: 'required' },
  { rule: 'Callback → original tech', detail: 'Routes retreat to original tech when available same day', level: 'preferred' },
  { rule: 'Upsell-capable tech for inspections', detail: 'High upsell-rate techs get estimates and new leads', level: 'preferred' },
  { rule: 'Performance tier by job type', detail: 'Best completion-rate tech matched to that service category', level: 'preferred' },
  { rule: 'Proximity + day density', detail: 'Prefer tech already working that zip cluster today', level: 'optional' },
];

const LEVEL_STYLE = { required: 'bg-red-50 text-red-700', preferred: 'bg-blue-50 text-blue-700', optional: 'bg-gray-100 text-gray-500' };

export default function TechMatchPanel() {
  const [service, setService] = useState('general_pest');
  const [zip, setZip] = useState('34219 – Parrish');
  const [category, setCategory] = useState('recurring');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function simulate() {
    setLoading(true);
    try {
      const res = await fetch('/api/dispatch/match/simulate', {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ serviceType: service, zip: zip.split(' ')[0], jobCategory: category }),
      });
      const data = await res.json();
      setResult(data);
    } catch {
      setResult(null);
    }
    setLoading(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Rules */}
      <div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700 mb-4">
          Rules run in priority order. <strong>Required</strong> blocks assignment. <strong>Preferred</strong> adjusts score. <strong>Optional</strong> is tie-break only.
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Active matching rules</div>
          <div className="divide-y divide-gray-100">
            {RULES.map((r) => (
              <div key={r.rule} className="flex items-start justify-between py-3 gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-800">{r.rule}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{r.detail}</div>
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex-shrink-0 ${LEVEL_STYLE[r.level]}`}>{r.level}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Simulator */}
      <div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Simulate job match</div>
          <div className="grid grid-cols-1 gap-3 mb-4">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Service type</label>
              <select value={service} onChange={(e) => setService(e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-green-500">
                {SERVICES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Zip / cluster</label>
              <select value={zip} onChange={(e) => setZip(e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-green-500">
                {ZIPS.map((z) => <option key={z}>{z}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Job category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-green-500">
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <button onClick={simulate} disabled={loading} className="w-full py-2 bg-green-700 text-white text-sm rounded-lg font-medium hover:bg-green-800 disabled:opacity-50">
            {loading ? 'Matching…' : 'Run match'}
          </button>
        </div>

        {result && (
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Match result</div>
            {result.allMatches?.map((m, i) => (
              <div key={i} className={`p-3 rounded-lg mb-2 ${m.blocked ? 'bg-red-50 border border-red-100' : i === 0 ? 'bg-green-50 border border-green-200' : 'bg-gray-50'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-800">{m.tech?.name}</span>
                  {m.blocked
                    ? <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">blocked</span>
                    : <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">score {m.matchScore}</span>
                  }
                </div>
                <div className="text-xs text-gray-500 mt-1">{m.blocked ? m.blockReason : m.reasoning}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
