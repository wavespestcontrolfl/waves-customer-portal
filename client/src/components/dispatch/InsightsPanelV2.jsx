// client/src/components/dispatch/InsightsPanelV2.jsx
// Monochrome V2 of InsightsPanel. Strict 1:1 on data:
//   - same GET /api/dispatch/insights?days=X
//   - same summary metrics (rev/hr, drive%, completion%, callback%, actualRevenue)
//   - same tech rows (completion, upsell, callback)
//   - same forecast bars
// Alert thresholds preserved: drive% > 25, callback% > 6, variance < 0 all trigger
// alert-fg. Everything else renders neutral zinc — no green/blue success color.
import { useState, useEffect } from 'react';
import { Card, CardBody, cn } from '../ui';

const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` });

const PERIOD_BTN = 'h-7 px-3 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors';

export default function InsightsPanelV2() {
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

  const driveAlert = (s.avgDrivePct || 0) > 25;
  const callbackAlert = (s.callbackRate || 0) > 6;
  const revenueNegative = s.revenueVariance != null && s.revenueVariance < 0;

  return (
    <div>
      {/* Period toggle */}
      <div className="flex items-center gap-2 mb-5">
        <span className="u-label text-ink-secondary">Period</span>
        <div className="inline-flex items-center border-hairline border-zinc-200 rounded-sm overflow-hidden bg-white">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => { setDays(d); load(d); }}
              className={cn(
                PERIOD_BTN,
                days === d
                  ? 'bg-zinc-900 text-white'
                  : 'bg-white text-ink-secondary hover:bg-zinc-50'
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <Card>
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary">Rev / route hr</div>
            <div className="u-nums text-22 font-medium tracking-tight text-ink-primary mt-2 leading-none">
              ${s.avgRevPerHr || '—'}
            </div>
            <div className="text-11 text-ink-tertiary mt-1">target $100+</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary">Avg drive time</div>
            <div className={cn(
              'u-nums text-22 font-medium tracking-tight mt-2 leading-none',
              driveAlert ? 'text-alert-fg' : 'text-ink-primary'
            )}>
              {s.avgDrivePct || '—'}%
            </div>
            <div className="text-11 text-ink-tertiary mt-1">target &lt;25%</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary">Completion rate</div>
            <div className="u-nums text-22 font-medium tracking-tight text-ink-primary mt-2 leading-none">
              {s.completionRate || '—'}%
            </div>
            <div className="text-11 text-ink-tertiary mt-1">last {days} days</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary">Callback rate</div>
            <div className={cn(
              'u-nums text-22 font-medium tracking-tight mt-2 leading-none',
              callbackAlert ? 'text-alert-fg' : 'text-ink-primary'
            )}>
              {s.callbackRate || '—'}%
            </div>
            <div className="text-11 text-ink-tertiary mt-1">target &lt;5%</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary">Actual revenue</div>
            <div className="u-nums text-22 font-medium tracking-tight text-ink-primary mt-2 leading-none">
              ${s.actualRevenue ? s.actualRevenue.toLocaleString() : '—'}
            </div>
            {s.revenueVariance != null && s.revenueVariance !== 0 && (
              <div className={cn(
                'u-nums text-11 font-medium mt-1',
                revenueNegative ? 'text-alert-fg' : 'text-ink-secondary'
              )}>
                {s.revenueVariance >= 0 ? '+' : ''}
                {typeof s.revenueVariance === 'number' ? `$${s.revenueVariance.toLocaleString()}` : '—'} vs forecast
              </div>
            )}
            {(!s.revenueVariance && s.revenueVariance !== 0) && (
              <div className="text-11 text-ink-tertiary mt-1">
                vs {s.expectedRevenue ? `$${s.expectedRevenue.toLocaleString()} forecast` : 'no forecast'}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Tech performance */}
        <Card>
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary mb-3">Performance by tech</div>
            {loading ? (
              <div className="text-13 text-ink-secondary py-6 text-center">Loading…</div>
            ) : (
              <div className="divide-y divide-zinc-200">
                {techs.map((t) => {
                  const techCallbackAlert = t.callbackRate > 5;
                  return (
                    <div key={t.id} className="py-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="u-dot u-dot--filled" />
                          <span className="text-13 font-medium text-ink-primary">{t.name}</span>
                        </div>
                        <span className="u-nums text-13 font-medium text-ink-primary">${t.revenuePerHour}/hr</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2 text-center">
                          <div className="u-nums text-13 font-medium text-ink-primary">{t.completionRate}%</div>
                          <div className="u-label text-ink-tertiary mt-0.5">completion</div>
                        </div>
                        <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2 text-center">
                          <div className="u-nums text-13 font-medium text-ink-primary">{t.upsellRate}%</div>
                          <div className="u-label text-ink-tertiary mt-0.5">upsell</div>
                        </div>
                        <div className={cn(
                          'border-hairline rounded-sm p-2 text-center',
                          techCallbackAlert ? 'bg-alert-bg border-alert-fg/20' : 'bg-zinc-50 border-zinc-200'
                        )}>
                          <div className={cn(
                            'u-nums text-13 font-medium',
                            techCallbackAlert ? 'text-alert-fg' : 'text-ink-primary'
                          )}>
                            {t.callbackRate}%
                          </div>
                          <div className="u-label text-ink-tertiary mt-0.5">callback</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!techs.length && <div className="text-13 text-ink-tertiary py-6 text-center">No tech data yet</div>}
              </div>
            )}
          </CardBody>
        </Card>

        {/* Seasonal forecast */}
        <Card>
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary mb-1">Seasonal demand — next 30 days</div>
            <div className="text-11 text-ink-tertiary mb-3">Push promos for high-demand services now</div>
            <div className="divide-y divide-zinc-200">
              {forecast.map((f) => (
                <div key={f.service} className="flex items-center gap-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-13 font-medium text-ink-primary">{f.service}</div>
                    <div className="text-11 text-ink-tertiary">{f.note}</div>
                  </div>
                  <div className="w-24 h-1 bg-zinc-100 rounded-sm flex-shrink-0 overflow-hidden">
                    <div
                      className="h-full bg-zinc-900 transition-all"
                      style={{ width: `${f.demandPct}%` }}
                    />
                  </div>
                  <div className="u-nums text-13 font-medium w-10 text-right flex-shrink-0 text-ink-primary">
                    {f.demandPct}%
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
