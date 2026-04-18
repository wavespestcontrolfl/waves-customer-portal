// client/src/components/dispatch/TechMatchPanelV2.jsx
// Monochrome V2 of TechMatchPanel. Strict 1:1 on data and behavior
// (same POST /api/dispatch/match/simulate, same rule set, same input fields).
import { useState } from 'react';
import { Card, CardBody, cn } from '../ui';

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

// Alert red for required (blocking); zinc for everything else. Monochrome discipline.
const LEVEL_STYLE = {
  required: 'bg-alert-bg text-alert-fg',
  preferred: 'bg-zinc-100 text-ink-primary',
  optional: 'bg-zinc-50 text-ink-tertiary',
};

const SELECT_CLS = 'w-full text-13 bg-white border-hairline border-zinc-200 rounded-sm px-3 h-9 focus:outline-none focus:border-zinc-900 u-focus-ring';

export default function TechMatchPanelV2() {
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
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Rules */}
      <div>
        <Card className="mb-3">
          <CardBody className="p-3 text-12 text-ink-secondary">
            Rules run in priority order.{' '}
            <strong className="text-ink-primary font-medium">Required</strong> blocks assignment.{' '}
            <strong className="text-ink-primary font-medium">Preferred</strong> adjusts score.{' '}
            <strong className="text-ink-primary font-medium">Optional</strong> is tie-break only.
          </CardBody>
        </Card>
        <Card>
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary mb-3">Active matching rules</div>
            <div className="divide-y divide-zinc-200">
              {RULES.map((r) => (
                <div key={r.rule} className="flex items-start justify-between py-3 gap-3">
                  <div>
                    <div className="text-13 font-medium text-ink-primary">{r.rule}</div>
                    <div className="text-11 text-ink-tertiary mt-0.5">{r.detail}</div>
                  </div>
                  <span className={cn('text-11 px-2 h-5 inline-flex items-center rounded-sm flex-shrink-0', LEVEL_STYLE[r.level])}>
                    {r.level}
                  </span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Simulator */}
      <div>
        <Card className="mb-3">
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary mb-3">Simulate job match</div>
            <div className="grid grid-cols-1 gap-3 mb-4">
              <div>
                <label className="text-11 text-ink-secondary mb-1 block">Service type</label>
                <select value={service} onChange={(e) => setService(e.target.value)} className={SELECT_CLS}>
                  {SERVICES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
              <div>
                <label className="text-11 text-ink-secondary mb-1 block">Zip / cluster</label>
                <select value={zip} onChange={(e) => setZip(e.target.value)} className={SELECT_CLS}>
                  {ZIPS.map((z) => <option key={z}>{z}</option>)}
                </select>
              </div>
              <div>
                <label className="text-11 text-ink-secondary mb-1 block">Job category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className={SELECT_CLS}>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <button
              onClick={simulate}
              disabled={loading}
              className="w-full h-9 bg-zinc-900 text-white text-11 uppercase tracking-label font-medium rounded-sm hover:bg-zinc-800 disabled:opacity-50 u-focus-ring transition-colors"
            >
              {loading ? 'Matching…' : 'Run match'}
            </button>
          </CardBody>
        </Card>

        {result && (
          <Card>
            <CardBody className="p-4">
              <div className="u-label text-ink-secondary mb-3">Match result</div>
              {result.allMatches?.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    'p-3 rounded-sm mb-2 border-hairline',
                    m.blocked
                      ? 'bg-alert-bg border-alert-fg/20'
                      : i === 0
                        ? 'bg-zinc-50 border-zinc-900'
                        : 'bg-white border-zinc-200'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-13 font-medium text-ink-primary">{m.tech?.name}</span>
                    {m.blocked ? (
                      <span className="u-label text-alert-fg bg-white px-2 py-0.5 rounded-sm">blocked</span>
                    ) : (
                      <span className="u-nums text-11 font-medium text-ink-primary">score {m.matchScore}</span>
                    )}
                  </div>
                  <div className="text-11 text-ink-secondary mt-1">{m.blocked ? m.blockReason : m.reasoning}</div>
                </div>
              ))}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
