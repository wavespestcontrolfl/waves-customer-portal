// client/src/components/dispatch/CSRPanel.jsx
import { useState, useEffect } from 'react';

const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' });

const SCENARIOS = [
  { id: 'urgent', label: 'Urgent pest issue', desc: 'Same-day or next AM · inside infestation' },
  { id: 'inspect', label: 'Inspection / estimate', desc: 'New lead · protect revenue slot' },
  { id: 'lawn', label: 'Recurring lawn', desc: 'Scheduled stop · density optimized' },
  { id: 'callback', label: 'Callback / retreat', desc: 'Original tech priority · 5-day window' },
  { id: 'seasonal', label: 'Seasonal add-on', desc: 'Mosquito, aeration, tree/shrub bundle' },
];

const SERVICES = ['General pest', 'Termite inspection', 'Lawn fert + weed', 'Mosquito', 'German roach', 'Tree & shrub', 'Callback/retreat', 'Stinging insect'];
const ZIPS = ['34219 – Parrish', '34208 – Bradenton', '34240 – Lakewood Ranch', '34231 – Sarasota', '34285 – Venice', '34286 – North Port', '33980 – Port Charlotte'];

export default function CSRPanel() {
  const [scenario, setScenario] = useState('urgent');
  const [service, setService] = useState('');
  const [zip, setZip] = useState('');
  const [slots, setSlots] = useState([]);
  const [factors, setFactors] = useState([]);
  const [loading, setLoading] = useState(false);

  async function loadSlots(s = scenario) {
    setLoading(true);
    try {
      const res = await fetch('/api/dispatch/csr/slots', {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ scenario: s, serviceType: service, zip: zip.split(' ')[0] }),
      });
      const data = await res.json();
      setSlots(data.slots || []);
      setFactors(data.slots?.[0]?.score_factors || []);
    } catch {
      setSlots([]);
    }
    setLoading(false);
  }

  function selectScenario(id) {
    setScenario(id);
    loadSlots(id);
  }

  useEffect(() => { loadSlots(); }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      {/* Left: scenarios + filters */}
      <div>
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Scenario</div>
        <div className="flex flex-col gap-2 mb-5">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => selectScenario(s.id)}
              className={`text-left p-3 rounded-xl border transition-all ${scenario === s.id ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}
            >
              <div className={`text-sm font-medium ${scenario === s.id ? 'text-green-800' : 'text-gray-800'}`}>{s.label}</div>
              <div className="text-xs text-gray-400 mt-0.5">{s.desc}</div>
            </button>
          ))}
        </div>

        <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Filters</div>
        <div className="flex flex-col gap-3">
          <select value={service} onChange={(e) => setService(e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-green-500">
            <option value="">Any service type</option>
            {SERVICES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={zip} onChange={(e) => setZip(e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-green-500">
            <option value="">Any zip</option>
            {ZIPS.map((z) => <option key={z}>{z}</option>)}
          </select>
          <button onClick={() => loadSlots()} disabled={loading} className="py-2 bg-green-700 text-white text-sm rounded-lg font-medium hover:bg-green-800 disabled:opacity-50">
            {loading ? 'Loading…' : 'Get slots'}
          </button>
        </div>
      </div>

      {/* Right: slots */}
      <div className="lg:col-span-2">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Recommended windows</div>
        {loading ? (
          <div className="text-sm text-gray-400 py-8 text-center">Finding best slots…</div>
        ) : (
          <div className="flex flex-col gap-3 mb-5">
            {slots.map((slot, i) => (
              <div key={i} className={`p-4 rounded-xl border ${slot.top ? 'border-green-500 border-2 bg-green-50' : 'border-gray-200 bg-white'}`}>
                <div className="text-xs text-gray-400 mb-1">{slot.rank}</div>
                <div className="text-base font-semibold text-gray-900">{slot.date_label}</div>
                <div className="text-sm text-gray-500 mt-0.5">{slot.tech_name}</div>
                <div className="text-xs text-gray-400 mt-2">{slot.detail}</div>
              </div>
            ))}
            {!slots.length && <div className="text-sm text-gray-400 py-8 text-center">Select a scenario to see slots</div>}
          </div>
        )}

        {factors.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Score factors active</div>
            <div className="flex flex-wrap gap-2">
              {factors.map((f, i) => (
                <span key={i} className="text-xs px-3 py-1 bg-green-50 text-green-700 rounded-full border border-green-100">{f}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
