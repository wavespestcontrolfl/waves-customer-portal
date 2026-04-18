// client/src/components/dispatch/CSRPanelV2.jsx
// Monochrome V2 of CSRPanel. Strict 1:1 on data and behavior
// (same POST /api/dispatch/csr/slots, same scenarios/filters, same slots render).
import { useState, useEffect } from 'react';
import { Card, CardBody, cn } from '../ui';

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

const SELECT_CLS = 'w-full text-13 bg-white border-hairline border-zinc-200 rounded-sm px-3 h-9 focus:outline-none focus:border-zinc-900 u-focus-ring';

export default function CSRPanelV2() {
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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Left: scenarios + filters */}
      <div>
        <div className="u-label text-ink-secondary mb-3">Scenario</div>
        <div className="flex flex-col gap-2 mb-5">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => selectScenario(s.id)}
              className={cn(
                'text-left p-3 rounded-sm border-hairline transition-colors u-focus-ring',
                scenario === s.id
                  ? 'border-zinc-900 bg-zinc-50'
                  : 'border-zinc-200 bg-white hover:bg-zinc-50'
              )}
            >
              <div className="text-13 font-medium text-ink-primary">{s.label}</div>
              <div className="text-11 text-ink-tertiary mt-0.5">{s.desc}</div>
            </button>
          ))}
        </div>

        <div className="u-label text-ink-secondary mb-3">Filters</div>
        <div className="flex flex-col gap-3">
          <select value={service} onChange={(e) => setService(e.target.value)} className={SELECT_CLS}>
            <option value="">Any service type</option>
            {SERVICES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={zip} onChange={(e) => setZip(e.target.value)} className={SELECT_CLS}>
            <option value="">Any zip</option>
            {ZIPS.map((z) => <option key={z}>{z}</option>)}
          </select>
          <button
            onClick={() => loadSlots()}
            disabled={loading}
            className="h-9 bg-zinc-900 text-white text-11 uppercase tracking-label font-medium rounded-sm hover:bg-zinc-800 disabled:opacity-50 u-focus-ring transition-colors"
          >
            {loading ? 'Loading…' : 'Get slots'}
          </button>
        </div>
      </div>

      {/* Right: slots */}
      <div className="lg:col-span-2">
        <div className="u-label text-ink-secondary mb-3">Recommended windows</div>
        {loading ? (
          <div className="text-13 text-ink-secondary py-8 text-center">Finding best slots…</div>
        ) : (
          <div className="flex flex-col gap-3 mb-5">
            {slots.map((slot, i) => (
              <Card key={i} className={cn(slot.top && 'border-zinc-900')}>
                <CardBody className={cn('p-4', slot.top && 'bg-zinc-50')}>
                  <div className="u-label text-ink-tertiary mb-1">{slot.rank}</div>
                  <div className="text-16 font-medium text-ink-primary">{slot.date_label}</div>
                  <div className="text-13 text-ink-secondary mt-0.5">{slot.tech_name}</div>
                  <div className="text-11 text-ink-tertiary mt-2">{slot.detail}</div>
                </CardBody>
              </Card>
            ))}
            {!slots.length && <div className="text-13 text-ink-tertiary py-8 text-center">Select a scenario to see slots</div>}
          </div>
        )}

        {factors.length > 0 && (
          <Card>
            <CardBody className="p-4">
              <div className="u-label text-ink-secondary mb-3">Score factors active</div>
              <div className="flex flex-wrap gap-2">
                {factors.map((f, i) => (
                  <span
                    key={i}
                    className="text-11 px-2.5 h-6 inline-flex items-center bg-zinc-100 text-ink-primary rounded-sm"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
