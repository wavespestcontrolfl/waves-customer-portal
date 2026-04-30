import { useEffect, useState } from 'react';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  cn,
} from '../../components/ui';
import {
  AgingBar,
  CallsBySourceList,
  ChannelMixDonut,
  ChartCard,
  CompletionGauge,
  EmptyState,
  EstimateFunnel,
  KpiSparklineTile,
  LeadsBySourceList,
  MrrTrendChart,
  RevenueTrendArea,
  ServiceMixDonut,
  TechLeaderboardBars,
  fmtInt,
  fmtMoney,
  fmtMoneyCompact,
} from '../../components/dashboard/charts';
import { adminFetch, isRateLimitError } from '../../utils/admin-fetch';

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'wtd',   label: 'WTD' },
  { id: 'mtd',   label: 'MTD' },
  { id: 'ytd',   label: 'YTD' },
];

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

// Build a daily-revenue sparkline series from the array of { date, total }
// returned by /admin/dashboard. Pad to at least 2 points so the sparkline
// renders even on day 1 of the month.
function sparkSeries(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  if (daily.length === 1) return [0, daily[0].total];
  return daily.map((d) => Number(d.total) || 0);
}

export default function DashboardPageV2() {
  const [data, setData] = useState(null);     // /admin/dashboard
  const [kpis, setKpis] = useState(null);     // /admin/dashboard/core-kpis
  const [compare, setCompare] = useState(null); // /admin/dashboard/compare
  const [funnel, setFunnel] = useState(null);
  const [aging, setAging] = useState(null);
  const [mrrTrend, setMrrTrend] = useState(null);
  // /lead-source (downstream string aggregation) is intentionally dropped
  // in favor of the upstream attribution endpoints below.
  const [callsBySource, setCallsBySource] = useState(null);
  const [leadsBySource, setLeadsBySource] = useState(null);
  const [channelMix, setChannelMix] = useState(null);
  const [mix, setMix] = useState(null);
  const [today, setToday] = useState(null);
  const [billing, setBilling] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [period, setPeriod] = useState('mtd');

  useEffect(() => {
    let cancelled = false;
    // Run the 11 fan-out fetches in two staggered waves so a fresh mount
    // doesn't burst-trigger the per-user rate limiter (the original code
    // fired all 11 simultaneously). The hero KPIs land first, then the
    // attribution panels backfill.
    function track(label, p) {
      return p.catch((e) => {
        console.error(`[dashboard-v2] ${label}`, e);
        if (isRateLimitError(e) && !cancelled) setLoadError(e);
        return null;
      });
    }
    async function loadAll() {
      const wave1 = await Promise.all([
        track('/dashboard',         adminFetch('/admin/dashboard')),
        track('/compare',           adminFetch('/admin/dashboard/compare?period=this_month&against=last_month')),
        track('/today-completion',  adminFetch('/admin/dashboard/today-completion')),
        track('/billing-health',    adminFetch('/admin/billing-health')),
      ]);
      const [d, cmp, td, bh] = wave1;
      if (cancelled) return;
      setData(d);
      setCompare(cmp);
      setToday(td);
      setBilling(bh?.summary || null);
      setLoading(false);

      const wave2 = await Promise.all([
        track('/funnel',            adminFetch('/admin/dashboard/funnel')),
        track('/aging',             adminFetch('/admin/dashboard/aging')),
        track('/mrr-trend',         adminFetch('/admin/dashboard/mrr-trend?months=12')),
        track('/calls-by-source',   adminFetch('/admin/dashboard/calls-by-source?period=mtd')),
        track('/leads-by-source',   adminFetch('/admin/dashboard/leads-by-source?period=mtd')),
        track('/channel-mix',       adminFetch('/admin/dashboard/channel-mix?period=mtd')),
        track('/service-mix',       adminFetch('/admin/dashboard/service-mix')),
      ]);
      if (cancelled) return;
      const [fnl, ag, mrr, calls, leads, channels, mx] = wave2;
      setFunnel(fnl);
      setAging(ag);
      setMrrTrend(mrr);
      setCallsBySource(calls);
      setLeadsBySource(leads);
      setChannelMix(channels);
      setMix(mx);
    }
    loadAll();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    adminFetch(`/admin/dashboard/core-kpis?period=${period}`)
      .then((d) => setKpis(d))
      .catch((e) => console.error('[dashboard-v2] /core-kpis', e));
  }, [period]);

  if (loading) {
    return <div className="p-16 text-center text-14 sm:text-13 text-ink-secondary">Loading dashboard…</div>;
  }
  if (!data || data.error || !data.kpis) {
    // 429 from the global limiter used to render as "Try logging in again",
    // sending operators in circles. Show the real cause + a Retry button.
    if (isRateLimitError(loadError)) {
      return (
        <div className="p-16 text-center text-14 sm:text-13 text-alert-fg">
          Too many requests. Wait a few seconds and{' '}
          <button onClick={() => window.location.reload()} className="underline">retry</button>.
        </div>
      );
    }
    return (
      <div className="p-16 text-center text-14 sm:text-13 text-alert-fg">
        Failed to load dashboard. <a href="/admin/login" className="underline">Try logging in again</a>
      </div>
    );
  }

  const k = data.kpis;
  const dailySpark = sparkSeries(data.revenueChart?.daily);
  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Hero KPI tiles. Google Rating tile intentionally removed — NPS from the
  // /rate/:token submissions (review_requests.score where status='submitted')
  // is the more honest customer-satisfaction signal.
  const HERO = [
    {
      label: 'Revenue MTD',
      value: fmtMoney(k.revenueMTD),
      delta: compare?.deltas?.revenue ?? k.revenueChangePercent,
      deltaSuffix: '% vs last month',
      series: dailySpark,
    },
    {
      label: 'Active Customers',
      value: fmtInt(k.activeCustomers),
      sub: `+${fmtInt(k.newCustomersThisMonth)} new MTD`,
    },
    {
      label: 'MRR',
      value: fmtMoney(data.mrr),
      sub: `ARR ${fmtMoneyCompact(data.mrr * 12)}`,
    },
    {
      label: 'NPS',
      value: kpis?.quality?.nps != null ? String(kpis.quality.nps) : '—',
      sub: kpis?.quality?.csatResponses
        ? `${kpis.quality.csatResponses} responses · ${kpis.quality.csatAvg}/10 avg`
        : 'awaiting rate-page submissions',
      alert: kpis?.quality?.nps != null && kpis.quality.nps < 30,
    },
  ];

  return (
    <div className="dashboard-blackout font-sans bg-surface-page min-h-full p-3 sm:p-6 text-zinc-900">
      <header className="mb-5 max-md:mb-6">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="u-label text-ink-secondary max-md:text-13 max-md:tracking-normal max-md:normal-case max-md:font-medium max-md:text-zinc-500">
              {todayLabel}
            </div>
            <h1 className="text-28 font-normal tracking-h1 mt-1 max-md:mt-2">
              <span className="md:hidden" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>{greeting()}, Adam</span>
              <span className="hidden md:inline">{greeting()}, Adam</span>
            </h1>
          </div>
        </div>
      </header>

      {/* Hero KPI row — sparkline + delta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 mb-5 max-md:grid-cols-1">
        {HERO.map((h) => (
          <KpiSparklineTile key={h.label} {...h} />
        ))}
      </div>

      {/* Row: Revenue trend (2/3) + Today completion gauge (1/3) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <div className="md:col-span-2">
          <ChartCard
            title={`Revenue — ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`}
            sub={
              compare?.deltas?.revenue != null
                ? `${compare.deltas.revenue >= 0 ? '↑' : '↓'} ${Math.abs(compare.deltas.revenue)}% vs ${compare.against?.label?.toLowerCase() || 'prior period'}`
                : 'vs last month'
            }
            action={
              <span className="text-12 text-ink-secondary">
                MRR <span className="u-nums font-medium text-zinc-900 ml-1">{fmtMoney(data.mrr)}</span>
              </span>
            }
          >
            <RevenueTrendArea
              current={compare?.period?.series || data.revenueChart?.daily || []}
              prior={compare?.against?.series || []}
            />
          </ChartCard>
        </div>
        <ChartCard
          title="Today's Completion"
          sub={today?.date ? new Date(today.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long' }) : ''}
        >
          {today ? (
            <CompletionGauge
              completed={today.completed}
              total={today.total}
              remaining={today.remaining}
              cancelled={today.cancelled}
            />
          ) : <EmptyState>Loading…</EmptyState>}
        </ChartCard>
      </div>

      {/* Row: Service mix donut + Estimate funnel */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
        <ChartCard title="Service Mix" sub={`${mix?.total_services || 0} completed services this month`}>
          <ServiceMixDonut mix={mix?.mix || []} />
        </ChartCard>
        <ChartCard
          title="Estimate Funnel"
          sub={funnel?.period ? `${funnel.period.from} → ${funnel.period.to}` : ''}
        >
          <EstimateFunnel
            funnel={funnel?.funnel || {}}
            rates={funnel?.rates || {}}
            totalAcceptedValue={funnel?.total_accepted_value}
          />
        </ChartCard>
      </div>

      {/* AR aging — full width, the 90+ bucket is the only place alert-fg */}
      <div className="mb-5">
        <ChartCard
          title="Accounts Receivable Aging"
          sub={aging?.invoice_count != null ? `${aging.invoice_count} open invoices` : ''}
        >
          <AgingBar
            aging={aging?.aging || {}}
            totalOutstanding={aging?.total_outstanding}
            totalOverdue={aging?.total_overdue}
          />
        </ChartCard>
      </div>

      {/* Core operational KPIs (period switcher) */}
      <Card className="mb-5 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
        <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>Core KPIs</CardTitle>
            <div className="text-12 text-ink-secondary mt-1">{kpis?.periodLabel || 'Month to Date'}</div>
          </div>
          <div className="inline-flex items-center border-hairline border-zinc-200 rounded-sm overflow-hidden">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={cn(
                  'h-11 sm:h-7 px-4 sm:px-3 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors',
                  period === p.id ? 'bg-zinc-900 text-white' : 'bg-white text-ink-secondary hover:bg-zinc-50'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardBody>
          {!kpis ? (
            <EmptyState>Loading KPIs…</EmptyState>
          ) : (
            <>
              <SectionLabel>Operations</SectionLabel>
              <KpiGrid>
                <KpiTile
                  label="Service Completion"
                  value={pct(kpis.service.completionRate)}
                  sub={`${kpis.service.completed}/${kpis.service.scheduled} jobs`}
                  alert={kpis.service.completionRate != null && kpis.service.completionRate < 85}
                />
                <KpiTile
                  label="Callback Rate"
                  value={kpis.service.callbackRate != null ? `${kpis.service.callbackRate}%` : '—'}
                  sub={`${kpis.service.callbacks} callbacks`}
                  alert={kpis.service.callbackRate != null && kpis.service.callbackRate >= 6}
                />
                <KpiTile
                  label="Tech Utilization"
                  value={pct(kpis.financial.utilization)}
                  sub={
                    kpis.financial.activeTechs != null
                      ? `${kpis.financial.laborHours}h / ${kpis.financial.activeTechs} techs`
                      : 'tech count unavailable'
                  }
                  alert={kpis.financial.utilization != null && kpis.financial.utilization < 45}
                />
                <KpiTile
                  label="Stops / Hour"
                  value={kpis.financial.stopsPerHour != null ? kpis.financial.stopsPerHour.toFixed(1) : '—'}
                  sub="route efficiency"
                />
              </KpiGrid>

              <SectionLabel>Financial</SectionLabel>
              <KpiGrid>
                <KpiTile
                  label="Revenue / Job"
                  value={kpis.financial.revPerJob != null ? fmtMoney(kpis.financial.revPerJob) : '—'}
                  sub={`${kpis.financial.jobsDone} completed`}
                />
                <KpiTile
                  label="Revenue / Man-Hour"
                  value={kpis.financial.rpmh != null ? fmtMoney(kpis.financial.rpmh) : '—'}
                  sub="target $120"
                  alert={kpis.financial.rpmh != null && kpis.financial.rpmh < 90}
                />
                <KpiTile
                  label="Gross Margin"
                  value={
                    kpis.financial.grossMarginWeighted != null
                      ? `${Math.round(kpis.financial.grossMarginWeighted)}%`
                      : '—'
                  }
                  sub={
                    kpis.financial.grossMarginAvg != null
                      ? `per-job avg ${Math.round(kpis.financial.grossMarginAvg)}%`
                      : 'revenue-weighted'
                  }
                  alert={kpis.financial.grossMarginWeighted != null && kpis.financial.grossMarginWeighted < 40}
                />
                <KpiTile
                  label="AR Days"
                  value={kpis.ar.days != null ? `${kpis.ar.days}d` : '—'}
                  sub={`${fmtMoneyCompact(kpis.ar.open)} open · ${kpis.ar.overdueCount} overdue`}
                  alert={kpis.ar.days != null && kpis.ar.days > 30}
                />
              </KpiGrid>

              <SectionLabel>Sales &amp; Customer</SectionLabel>
              <KpiGrid>
                <KpiTile
                  label="Lead → Booked"
                  value={kpis.sales.conversion != null ? `${kpis.sales.conversion}%` : '—'}
                  sub={`${kpis.sales.booked}/${kpis.sales.leads} leads`}
                  alert={kpis.sales.conversion != null && kpis.sales.conversion < 20}
                />
                <KpiTile
                  label="Response Speed"
                  value={kpis.sales.avgResponseMin != null ? `${kpis.sales.avgResponseMin}m` : '—'}
                  sub="lead → first contact"
                  alert={kpis.sales.avgResponseMin != null && kpis.sales.avgResponseMin > 60}
                />
                <KpiTile
                  label="CSAT"
                  value={kpis.quality.csatAvg != null ? `${kpis.quality.csatAvg}/10` : '—'}
                  sub={kpis.quality.csatResponses
                    ? `${kpis.quality.csatResponses} rate-page responses`
                    : 'no responses yet'}
                  alert={kpis.quality.csatAvg != null && parseFloat(kpis.quality.csatAvg) < 8}
                />
                <KpiTile
                  label="Retention"
                  value={kpis.retention.pct != null ? `${kpis.retention.pct}%` : '—'}
                  sub={`${kpis.retention.churned} churned`}
                  alert={kpis.retention.pct != null && kpis.retention.pct < 85}
                />
              </KpiGrid>
            </>
          )}
        </CardBody>
      </Card>

      {/* MRR trend — full width above the attribution row */}
      <div className="mb-5">
        <ChartCard
          title="MRR Trend"
          sub={mrrTrend?.avg_growth_pct != null ? `${mrrTrend.avg_growth_pct >= 0 ? '↑' : '↓'} ${Math.abs(mrrTrend.avg_growth_pct)}% avg monthly growth` : 'last 12 months'}
        >
          <MrrTrendChart trend={mrrTrend?.trend || []} />
        </ChartCard>
      </div>

      {/* Upstream lead-attribution row.
          Replaces the prior single Lead Source panel (which aggregated the
          downstream customers.lead_source string) with three upstream views
          we actually capture:
            - Calls by Source: call_log JOIN lead_sources by dialed number
            - Leads by Source: leads GROUP BY lead_source_id
            - Channel Mix:     leads.first_contact_channel breakdown
          All MTD; can grow a period selector later. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <ChartCard
          title="Calls by Source"
          sub={
            callsBySource?.total_inbound_calls != null
              ? `${callsBySource.total_inbound_calls} inbound calls · ${callsBySource.period?.label || 'MTD'}`
              : ''
          }
        >
          <CallsBySourceList sources={callsBySource?.sources || []} />
        </ChartCard>
        <ChartCard
          title="Leads by Source"
          sub={
            leadsBySource?.total_leads != null
              ? `${leadsBySource.total_leads} leads · ${leadsBySource.overall_conversion_pct ?? 0}% booked · ${leadsBySource.period?.label || 'MTD'}`
              : ''
          }
        >
          <LeadsBySourceList sources={leadsBySource?.sources || []} />
        </ChartCard>
        <ChartCard
          title="Channel Mix"
          sub={channelMix?.total_leads != null ? `${channelMix.total_leads} leads by first-contact channel` : ''}
        >
          <ChannelMixDonut channels={channelMix?.channels || []} />
        </ChartCard>
      </div>

      {/* Tech leaderboard — bar variant */}
      {kpis?.leaderboard?.length > 0 && (
        <ChartCard title="Tech Leaderboard" sub={kpis.periodLabel} className="mb-5">
          <TechLeaderboardBars leaderboard={kpis.leaderboard} />
        </ChartCard>
      )}

      {/* Billing Health — kept as a peer panel per user instruction */}
      {billing && <BillingHealthPanel summary={billing} />}
    </div>
  );
}

function pct(n) { return n == null ? '—' : `${n}%`; }

function SectionLabel({ children }) {
  return (
    <div className="u-label text-ink-secondary pb-2 mb-3 mt-4 first:mt-0">
      {children}
    </div>
  );
}

function KpiGrid({ children }) {
  return <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{children}</div>;
}

function KpiTile({ label, value, sub, alert }) {
  return (
    <div className="bg-surface-sunken border-hairline border-zinc-200 rounded-sm p-3">
      <div className="u-label text-ink-secondary">{label}</div>
      <div className={cn('u-nums text-22 font-medium tracking-tight mt-2 leading-none', alert ? 'text-alert-fg' : 'text-zinc-900')}>
        {value}
      </div>
      {sub && <div className="mt-1 text-11 text-ink-secondary">{sub}</div>}
    </div>
  );
}

function BillingHealthPanel({ summary: h }) {
  const metrics = [
    { label: 'Autopay active',    value: h.autopay_active },
    { label: 'Paused',            value: h.autopay_paused },
    { label: 'No method',         value: h.no_payment_method,        alert: h.no_payment_method > 0 },
    { label: 'Charged this month',value: h.charged_this_month },
    { label: 'Failed (30d)',      value: h.failed_last_30_days,      alert: h.failed_last_30_days > 0 },
    { label: 'In retry',          value: h.in_retry_queue,           alert: h.in_retry_queue > 0 },
    { label: 'Escalated (30d)',   value: h.escalated_last_30_days,   alert: h.escalated_last_30_days > 0 },
    { label: 'Cards expiring 60d',value: h.expiring_cards_60_days,   alert: h.expiring_cards_60_days > 0 },
  ];
  return (
    <Card className="mb-5 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Billing Health</CardTitle>
        <Badge>{h.total_billable} billable</Badge>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {metrics.map((m) => (
            <div key={m.label} className="bg-surface-sunken border-hairline border-zinc-200 rounded-sm p-3">
              <div className="u-label text-ink-secondary">{m.label}</div>
              <div className={cn('u-nums text-22 font-medium tracking-tight mt-2 leading-none', m.alert ? 'text-alert-fg' : 'text-zinc-900')}>
                {m.value}
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
