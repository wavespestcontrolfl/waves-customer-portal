import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Badge,
  cn,
} from '../../components/ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
  }).then((r) => {
    if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); }
    return r.json();
  });
}

function fmt(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtD(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(n) { return n == null ? '—' : `${n}%`; }

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function fmtTimeShort(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'wtd', label: 'WTD' },
  { id: 'mtd', label: 'MTD' },
  { id: 'ytd', label: 'YTD' },
];

// Map status → Badge tone. Strict 1:1 semantics: failing = alert, else neutral.
function statusTone(s) {
  if (s === 'cancelled') return 'alert';
  if (s === 'completed') return 'strong';
  return 'neutral';
}

export default function DashboardPageV2() {
  const [data, setData] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('mtd');

  useEffect(() => {
    adminFetch('/admin/dashboard')
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { console.error('[dashboard-v2] load failed', err); setLoading(false); });
  }, []);

  useEffect(() => {
    adminFetch(`/admin/dashboard/core-kpis?period=${period}`)
      .then((d) => setKpis(d))
      .catch((err) => console.error('[dashboard-v2] core-kpis failed', err));
  }, [period]);

  if (loading) return <div className="p-16 text-center text-14 sm:text-13 text-ink-secondary">Loading dashboard…</div>;
  if (!data || data.error || !data.kpis) {
    return (
      <div className="p-16 text-center text-14 sm:text-13 text-alert-fg">
        Failed to load dashboard. <a href="/admin/login" className="underline">Try logging in again</a>
      </div>
    );
  }

  const k = data.kpis;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const HERO_KPIS = [
    { label: 'Revenue MTD', value: fmt(k.revenueMTD), delta: k.revenueChangePercent, deltaSuffix: '% vs last month' },
    { label: 'Active Customers', value: k.activeCustomers, delta: k.newCustomersThisMonth, deltaPrefix: '+', deltaSuffix: ' new MTD' },
    { label: 'MRR', value: fmt(data.mrr), sub: `ARR ${fmt(data.mrr * 12)}` },
    { label: 'Google Rating', value: `${k.googleReviewRating}★`, sub: `${k.googleReviewCount} reviews · ${k.googleUnresponded || 0} unreplied` },
  ];

  return (
    <div className="font-sans bg-surface-page min-h-full p-3 sm:p-6 text-zinc-900">
      {/* Header */}
      <header className="mb-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="u-label text-ink-secondary">{today}</div>
            <h1 className="text-28 font-normal tracking-h1 mt-1">{greeting()}, Adam</h1>
          </div>
        </div>
      </header>

      {/* Hero KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 mb-5">
        {HERO_KPIS.map((h, i) => (
          <Card key={i}>
            <CardBody className="p-4">
              <div className="u-label text-ink-secondary">{h.label}</div>
              <div className="u-nums text-28 font-medium tracking-tight mt-2 leading-none">{h.value}</div>
              {h.delta != null && (
                <div
                  className={cn(
                    'mt-2 text-12 font-medium',
                    h.delta < 0 ? 'text-alert-fg' : 'text-ink-secondary'
                  )}
                >
                  {h.delta >= 0 ? '↑' : '↓'} {h.deltaPrefix || ''}{Math.abs(h.delta)}{h.deltaSuffix}
                </div>
              )}
              {h.sub && h.delta == null && (
                <div className="mt-2 text-12 text-ink-secondary">{h.sub}</div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Core KPIs */}
      <Card className="mb-5">
        <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>Core KPIs</CardTitle>
            <div className="text-12 text-ink-secondary mt-1">
              {kpis?.periodLabel || 'Month to Date'}
            </div>
          </div>
          <div className="inline-flex items-center border-hairline border-zinc-200 rounded-sm overflow-hidden">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={cn(
                  'h-11 sm:h-7 px-4 sm:px-3 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors',
                  period === p.id
                    ? 'bg-zinc-900 text-white'
                    : 'bg-white text-ink-secondary hover:bg-zinc-50'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardBody>
          {!kpis ? (
            <div className="py-10 text-center text-14 sm:text-13 text-ink-secondary">Loading KPIs…</div>
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
                  sub={`${kpis.financial.laborHours}h billable`}
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
                  value={kpis.financial.revPerJob != null ? fmt(kpis.financial.revPerJob) : '—'}
                  sub={`${kpis.financial.jobsDone} completed`}
                />
                <KpiTile
                  label="Revenue / Man-Hour"
                  value={kpis.financial.rpmh != null ? fmt(kpis.financial.rpmh) : '—'}
                  sub="target $120"
                  alert={kpis.financial.rpmh != null && kpis.financial.rpmh < 90}
                />
                <KpiTile
                  label="Gross Margin"
                  value={kpis.financial.grossMargin != null ? `${Math.round(kpis.financial.grossMargin)}%` : '—'}
                  sub="target 55%"
                  alert={kpis.financial.grossMargin != null && kpis.financial.grossMargin < 40}
                />
                <KpiTile
                  label="AR Days"
                  value={kpis.ar.days != null ? `${kpis.ar.days}d` : '—'}
                  sub={`${fmt(kpis.ar.open)} open · ${kpis.ar.overdueCount} overdue`}
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
                  sub={kpis.quality.nps != null ? `NPS ${kpis.quality.nps}` : `${kpis.quality.csatResponses} responses`}
                  alert={kpis.quality.csatAvg != null && kpis.quality.csatAvg < 8}
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

      {/* Tech Leaderboard */}
      {kpis?.leaderboard?.length > 0 && (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle>Tech Leaderboard</CardTitle>
            <div className="text-12 text-ink-secondary mt-1">{kpis.periodLabel}</div>
          </CardHeader>
          <CardBody className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Rank</TH>
                  <TH>Technician</TH>
                  <TH align="right">Jobs</TH>
                  <TH align="right">Revenue</TH>
                  <TH align="right">RPMH</TH>
                  <TH align="right">Margin</TH>
                  <TH align="right">Callbacks</TH>
                </TR>
              </THead>
              <TBody>
                {kpis.leaderboard.map((t, i) => (
                  <TR key={t.techId || i}>
                    <TD nums className="text-ink-tertiary">{i + 1}</TD>
                    <TD className="font-medium">{t.name}</TD>
                    <TD align="right" nums>{t.jobs}</TD>
                    <TD align="right" nums>{fmt(t.revenue)}</TD>
                    <TD align="right" nums className={cn(t.rpmh < 90 && 'text-alert-fg font-medium')}>{fmt(t.rpmh)}</TD>
                    <TD align="right" nums className={cn(t.margin < 40 && 'text-alert-fg font-medium')}>{t.margin}%</TD>
                    <TD align="right" nums className={cn(t.callbackRate >= 6 && 'text-alert-fg font-medium')}>
                      {t.callbacks} ({t.callbackRate}%)
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      )}

      {/* Revenue chart */}
      <Card className="mb-5">
        <CardHeader className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle>
            Revenue — {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </CardTitle>
          <div className="text-12 text-ink-secondary">
            MRR <span className="u-nums font-medium text-zinc-900 ml-1">{fmtD(data.mrr)}</span>
          </div>
        </CardHeader>
        <CardBody>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.revenueChart?.daily || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E4E4E7" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#71717A', fontSize: 10 }}
                  tickFormatter={(d) => {
                    if (!d) return '';
                    const s = String(d).slice(0, 10);
                    const parsed = new Date(s + 'T12:00:00');
                    return isNaN(parsed) ? '' : parsed.getDate();
                  }}
                />
                <YAxis tick={{ fill: '#71717A', fontSize: 10 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{
                    background: '#FFFFFF',
                    border: '0.5px solid #E4E4E7',
                    borderRadius: 6,
                    color: '#18181B',
                    fontSize: 12,
                  }}
                  formatter={(v) => fmtD(v)}
                />
                <Bar dataKey="total" fill="#18181B" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      <BillingHealthCard />

      {/* Schedule + Activity */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Today's Schedule</CardTitle>
            <Badge>{data.todaysSchedule.length} services</Badge>
          </CardHeader>
          <CardBody className="p-0">
            {data.todaysSchedule.length === 0 ? (
              <div className="py-10 text-center text-14 sm:text-13 text-ink-secondary">
                No services scheduled today
              </div>
            ) : (
              <ul className="divide-y divide-zinc-200">
                {data.todaysSchedule.map((s) => (
                  <li key={s.id} className="flex items-start justify-between px-4 py-3 gap-3">
                    <div className="min-w-0">
                      <div className="u-nums text-12 text-ink-secondary">
                        {fmtTimeShort(s.windowStart)} – {fmtTimeShort(s.windowEnd)}
                      </div>
                      <div className="text-14 font-medium truncate">{s.customerName}</div>
                      <div className="text-12 text-ink-secondary truncate">{s.address}</div>
                      <div className="text-12 text-ink-secondary truncate">{s.serviceType} · {s.technicianName}</div>
                    </div>
                    <Badge dot tone={statusTone(s.status)}>{s.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {data.recentActivity.length === 0 ? (
              <div className="py-10 text-center text-14 sm:text-13 text-ink-secondary">No recent activity</div>
            ) : (
              <ul className="divide-y divide-zinc-200 max-h-[400px] overflow-y-auto">
                {data.recentActivity.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                    <span className="u-dot u-dot--filled mt-[7px] flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-14 sm:text-13 leading-snug">{a.description}</div>
                    </div>
                    <span className="text-11 text-ink-tertiary flex-shrink-0 whitespace-nowrap">{timeAgo(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'New Estimate', path: '/admin/estimates' },
          { label: 'New Customer', path: '/admin/customers' },
          { label: 'Review Request', path: '/admin/reviews' },
          { label: 'Property Lookup', path: '/admin/estimates' },
        ].map((a) => (
          <a
            key={a.label}
            href={a.path}
            className="block bg-white border-hairline border-zinc-200 rounded-md px-4 py-5 text-center no-underline u-focus-ring hover:bg-zinc-50"
          >
            <div className="u-label text-ink-secondary">{a.label}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="u-label text-ink-secondary pb-2 mb-3 border-b border-hairline border-zinc-200 mt-4 first:mt-0">
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
      <div
        className={cn(
          'u-nums text-22 font-medium tracking-tight mt-2 leading-none',
          alert ? 'text-alert-fg' : 'text-zinc-900'
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-11 text-ink-secondary">{sub}</div>}
    </div>
  );
}

function BillingHealthCard() {
  const [h, setH] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch('/admin/billing-health')
      .then((d) => setH(d?.summary || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  if (loading || !h) return null;

  const metrics = [
    { label: 'Autopay active', value: h.autopay_active },
    { label: 'Paused', value: h.autopay_paused },
    { label: 'No method', value: h.no_payment_method, alert: h.no_payment_method > 0 },
    { label: 'Charged this month', value: h.charged_this_month },
    { label: 'Failed (30d)', value: h.failed_last_30_days, alert: h.failed_last_30_days > 0 },
    { label: 'In retry', value: h.in_retry_queue, alert: h.in_retry_queue > 0 },
    { label: 'Escalated (30d)', value: h.escalated_last_30_days, alert: h.escalated_last_30_days > 0 },
    { label: 'Cards expiring 60d', value: h.expiring_cards_60_days, alert: h.expiring_cards_60_days > 0 },
  ];

  return (
    <Card className="mb-5">
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Billing Health</CardTitle>
        <span className="text-11 text-ink-secondary">{h.total_billable} billable customers</span>
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
