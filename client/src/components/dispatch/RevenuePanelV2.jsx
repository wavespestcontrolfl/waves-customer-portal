// client/src/components/dispatch/RevenuePanelV2.jsx
// Monochrome V2 of RevenuePanel. Strict 1:1 on data:
//   - same GET /api/dispatch/jobs?date=X&status=scheduled
//   - same summary math (avg/highValue/upsellFlags/atRisk)
//   - same score thresholds (≥80 protect, 55-79 standard, <55 can move)
//   - same breakdown display
// Colors collapse: alert-fg reserved for "<55" (at-risk) only. Score bar + score
// text are zinc-900 (or alert when at-risk). No amber tier.
import { useState, useEffect } from 'react';
import { Card, CardBody, cn } from '../ui';

const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` });

// Tier just tracks at-risk vs ok. High/mid both render as neutral zinc-900 —
// the only signal is "do we need eyes on this?" which is the alert case.
function isAtRisk(score) {
  return score < 55;
}

export default function RevenuePanelV2({ date }) {
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

  const avgScore = jobs.length ? Math.round(jobs.reduce((s, j) => s + (j.job_score || 0), 0) / jobs.length) : null;
  const highValue = jobs.filter((j) => (j.job_score || 0) >= 80).length;
  const atRisk = jobs.filter((j) => (j.job_score || 0) < 55).length;
  const upsellFlags = jobs.filter((j) => (j.upsell_flags || []).length > 0).length;

  const SUMMARY = [
    { label: 'Avg job score', value: avgScore ?? '—', sub: '/ 100' },
    { label: 'Protect slots', value: highValue, sub: 'score ≥ 80' },
    { label: 'Upsell opps', value: upsellFlags, sub: 'flagged today' },
    { label: 'Low priority', value: atRisk, sub: 'score < 55', alert: atRisk > 0 },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {SUMMARY.map((s) => (
          <Card key={s.label}>
            <CardBody className="p-4">
              <div className="u-label text-ink-secondary">{s.label}</div>
              <div
                className={cn(
                  'u-nums text-22 font-medium tracking-tight mt-2 leading-none',
                  s.alert ? 'text-alert-fg' : 'text-ink-primary'
                )}
              >
                {s.value}
              </div>
              <div className="text-11 text-ink-tertiary mt-1">{s.sub}</div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card className="mb-4">
        <CardBody className="p-4">
          <div className="u-label text-ink-secondary mb-1">Score formula</div>
          <p className="text-13 text-ink-secondary leading-relaxed">
            Job score = <strong className="text-ink-primary font-medium">Revenue (40%)</strong>{' '}
            + <strong className="text-ink-primary font-medium">Renewal probability (25%)</strong>{' '}
            + <strong className="text-ink-primary font-medium">Upsell potential (20%)</strong>{' '}
            + <strong className="text-ink-primary font-medium">Route efficiency (15%)</strong>
            &nbsp;·&nbsp;Score ≥ 80 = protect · 55–79 = standard · &lt;55 = can move
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-4">
          <div className="u-label text-ink-secondary mb-3">Today's job scores</div>
          {loading ? (
            <div className="text-13 text-ink-secondary py-8 text-center">Loading…</div>
          ) : (
            <div>
              {jobs.map((job) => {
                const score = job.job_score || 0;
                const bd = job.score_breakdown || {};
                const flags = job.upsell_flags || [];
                const risk = isAtRisk(score);
                return (
                  <div
                    key={job.id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-sm border-hairline mb-2',
                      risk ? 'bg-alert-bg/40 border-alert-fg/20' : 'bg-white border-zinc-200'
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-13 font-medium text-ink-primary truncate">{job.customer_name}</div>
                      <div className="text-11 text-ink-secondary mt-0.5">
                        {job.service_type?.replace(/_/g, ' ')} · {job.waveguard_tier !== 'none' ? job.waveguard_tier : job.job_category}
                      </div>
                      {flags.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {flags.map((f, i) => (
                            <span key={i} className="text-11 bg-zinc-100 text-ink-primary px-2 py-0.5 rounded-sm">
                              {f}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <div
                        className={cn(
                          'u-nums text-18 font-medium',
                          risk ? 'text-alert-fg' : 'text-ink-primary'
                        )}
                      >
                        {score}
                      </div>
                      <div className="w-20 h-1 bg-zinc-100 rounded-sm mt-1 overflow-hidden">
                        <div
                          className={cn('h-full transition-all', risk ? 'bg-alert-fg' : 'bg-zinc-900')}
                          style={{ width: `${score}%` }}
                        />
                      </div>
                      <div className="u-nums text-11 text-ink-tertiary mt-1">
                        {bd.revenue_pts || 0}+{bd.renewal_pts || 0}+{bd.upsell_pts || 0}+{bd.efficiency_pts || 0}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!jobs.length && (
                <div className="text-13 text-ink-tertiary py-6 text-center">No jobs found for {date}</div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
