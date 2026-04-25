// Chart primitives for the redesigned admin Dashboard (DashboardPageV2).
//
// Style contract: Tier 1 V2 monochrome — zinc ramp + hairline borders +
// the existing 11–28 type scale. alert-fg red is reserved for genuinely
// failing values (overdue 90+, churn, callbacks above threshold), never
// for decoration. fontWeight stays 400/500.

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardBody, CardHeader, CardTitle, cn } from '../ui';

// ─── Palette ──────────────────────────────────────────────────────
//
// Categorical chart colors are pulled from the zinc ramp so the
// dashboard reads as a monochrome surface, not a candy-store of brand
// hues. Alert red is the only chromatic accent and only on alarm bars.

export const CHART_INK = '#18181B';            // zinc-900 — primary fills
export const CHART_INK_DIM = '#52525B';        // zinc-600 — secondary lines
export const CHART_GRID = '#E4E4E7';           // zinc-200 — gridlines / dividers
export const CHART_TICK = '#71717A';           // zinc-500 — axis ticks
export const CHART_PRIOR = '#A1A1AA';          // zinc-400 — prior-period overlay
export const CHART_ALERT = '#C8312F';          // alert-fg — failing buckets only

// Categorical ramp for service mix / lead source — staircase of zincs so
// the eye scans by length, not color.
export const CHART_SERIES = [
  '#18181B', '#3F3F46', '#52525B', '#71717A', '#A1A1AA', '#D4D4D8',
];

// ─── Formatters ───────────────────────────────────────────────────

export function fmtMoney(n, opts = {}) {
  const v = Number(n || 0);
  return '$' + v.toLocaleString(undefined, {
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

export function fmtMoneyCompact(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(v) >= 1_000) return '$' + (v / 1_000).toFixed(1) + 'k';
  return '$' + Math.round(v).toLocaleString();
}

export function fmtInt(n) {
  return Number(n || 0).toLocaleString();
}

// ─── Chart-card wrapper ───────────────────────────────────────────

export function ChartCard({ title, sub, action, children, className }) {
  return (
    <Card className={cn('max-md:border-0 max-md:shadow-sm max-md:rounded-xl', className)}>
      <CardHeader className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <CardTitle>{title}</CardTitle>
          {sub && <div className="text-12 text-ink-secondary mt-1">{sub}</div>}
        </div>
        {action}
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

// ─── Tooltip styling shared by every chart ────────────────────────

const TOOLTIP_STYLE = {
  background: '#FFFFFF',
  border: '0.5px solid #E4E4E7',
  borderRadius: 6,
  color: '#18181B',
  fontSize: 12,
  padding: '6px 10px',
};

// ─── KPI tile w/ sparkline + delta ────────────────────────────────

// Big number, tiny inline area sparkline, period-over-period delta.
// Pass `series` as an array of numbers (oldest → newest). If `delta`
// is null, the chip is suppressed.
export function KpiSparklineTile({ label, value, sub, delta, deltaSuffix, alert, series }) {
  const data = (series || []).map((v, i) => ({ i, v: Number(v) || 0 }));
  return (
    <Card className="max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
      <CardBody className="p-4 max-md:p-5">
        <div className="u-label text-ink-secondary max-md:text-13 max-md:font-medium max-md:normal-case max-md:tracking-normal max-md:text-zinc-500">
          {label}
        </div>
        <div className="flex items-end justify-between gap-3 mt-2">
          <div
            className={cn(
              'u-nums text-28 font-medium tracking-tight leading-none max-md:text-[32px] max-md:font-bold',
              alert ? 'text-alert-fg' : 'text-zinc-900'
            )}
          >
            {value}
          </div>
          {data.length > 1 && (
            <div className="w-[88px] h-[28px] flex-shrink-0 opacity-90">
              <ResponsiveContainer>
                <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_INK} stopOpacity={0.18} />
                      <stop offset="100%" stopColor={CHART_INK} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={CHART_INK}
                    strokeWidth={1.25}
                    fill="url(#sparkfill)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        {delta != null && (
          <div
            className={cn(
              'mt-2 text-12 font-medium',
              delta < 0 ? 'text-alert-fg' : 'text-ink-secondary'
            )}
          >
            {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)}{deltaSuffix || '% vs prior'}
          </div>
        )}
        {sub && delta == null && (
          <div className="mt-2 text-12 text-ink-secondary">{sub}</div>
        )}
      </CardBody>
    </Card>
  );
}

// ─── Revenue trend area (current vs prior overlay) ────────────────

// `current`/`prior` are arrays of { date, total }. We zip them by index
// (day-of-period), not by calendar date, so a 31-day "this month"
// overlays cleanly on a 30-day "last month."
export function RevenueTrendArea({ current = [], prior = [], height = 240 }) {
  const len = Math.max(current.length, prior.length);
  const data = Array.from({ length: len }, (_, i) => ({
    day: i + 1,
    current: current[i]?.total ?? null,
    prior: prior[i]?.total ?? null,
  }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="rev-current" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_INK} stopOpacity={0.22} />
              <stop offset="100%" stopColor={CHART_INK} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fill: CHART_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID }}
          />
          <YAxis
            tick={{ fill: CHART_TICK, fontSize: 10 }}
            tickFormatter={fmtMoneyCompact}
            tickLine={false}
            axisLine={false}
            width={56}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v, name) => [fmtMoney(v), name === 'current' ? 'Current' : 'Prior']}
            labelFormatter={(d) => `Day ${d}`}
          />
          <Area
            type="monotone"
            dataKey="prior"
            stroke={CHART_PRIOR}
            strokeWidth={1}
            strokeDasharray="3 3"
            fill="none"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="current"
            stroke={CHART_INK}
            strokeWidth={1.5}
            fill="url(#rev-current)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Service mix donut ────────────────────────────────────────────

// `mix` is an array of { category, service_count, pct_of_total, revenue }.
export function ServiceMixDonut({ mix = [], height = 220 }) {
  const data = mix.map((m, i) => ({
    name: m.category,
    value: m.service_count,
    pct: m.pct_of_total,
    revenue: m.revenue,
    fill: CHART_SERIES[i % CHART_SERIES.length],
  }));
  if (data.length === 0) {
    return <EmptyState>No completed services this period</EmptyState>;
  }
  return (
    <div className="grid grid-cols-2 gap-4 items-center" style={{ minHeight: height }}>
      <div style={{ height }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="92%"
              stroke="#FFFFFF"
              strokeWidth={1}
              isAnimationActive={false}
            >
              {data.map((d, i) => (<Cell key={i} fill={d.fill} />))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v, name, p) => [`${v} (${p?.payload?.pct}%)`, name]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="text-12 space-y-2">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: d.fill }} />
            <span className="truncate">{d.name}</span>
            <span className="ml-auto u-nums text-ink-secondary">{d.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Estimate funnel (horizontal bars) ────────────────────────────

// Each stage shrinks proportionally to the top of the funnel (sent).
// Pass `funnel` { sent, viewed, accepted, declined } and `rates` { view_rate,
// close_rate, decline_rate }.
export function EstimateFunnel({ funnel = {}, rates = {}, totalAcceptedValue }) {
  const sent = funnel.sent || 0;
  const stages = [
    { label: 'Sent',     count: sent,                  pct: 100 },
    { label: 'Viewed',   count: funnel.viewed || 0,    pct: rates.view_rate || 0 },
    { label: 'Accepted', count: funnel.accepted || 0,  pct: rates.close_rate || 0 },
    { label: 'Declined', count: funnel.declined || 0,  pct: rates.decline_rate || 0, dim: true },
  ];
  if (sent === 0) return <EmptyState>No estimates sent this period</EmptyState>;
  return (
    <div className="space-y-3">
      {stages.map((s) => (
        <div key={s.label}>
          <div className="flex items-baseline justify-between text-12 mb-1">
            <span className={cn('u-label', s.dim ? 'text-ink-tertiary' : 'text-ink-secondary')}>{s.label}</span>
            <span className="u-nums">
              <span className={cn('font-medium', s.dim ? 'text-ink-tertiary' : 'text-zinc-900')}>{s.count}</span>
              <span className="text-ink-tertiary ml-2">{s.pct}%</span>
            </span>
          </div>
          <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
            <div
              className="h-full"
              style={{
                width: `${Math.min(100, s.pct)}%`,
                background: s.dim ? CHART_PRIOR : CHART_INK,
              }}
            />
          </div>
        </div>
      ))}
      {totalAcceptedValue != null && (
        <div className="pt-3 mt-3 border-t border-hairline border-zinc-200 flex items-baseline justify-between">
          <span className="u-label text-ink-secondary">Accepted value</span>
          <span className="u-nums text-18 font-medium">{fmtMoney(totalAcceptedValue)}</span>
        </div>
      )}
    </div>
  );
}

// ─── AR aging stacked bar ─────────────────────────────────────────

// `aging` { current, days_30, days_60, days_90_plus }. We render four
// stacked segments so the relative weight of the 90+ bucket is visible
// at a glance — that bucket is the only one drawn in alert red.
export function AgingBar({ aging = {}, totalOutstanding, totalOverdue, height = 180 }) {
  const buckets = [
    { key: 'current',     label: 'Current',  amount: aging.current     || 0, fill: CHART_INK },
    { key: 'days_30',     label: '1–30 days', amount: aging.days_30     || 0, fill: CHART_INK_DIM },
    { key: 'days_60',     label: '31–60 days', amount: aging.days_60     || 0, fill: CHART_TICK },
    { key: 'days_90_plus',label: '90+ days',  amount: aging.days_90_plus|| 0, fill: CHART_ALERT },
  ];
  const total = buckets.reduce((s, b) => s + b.amount, 0);
  if (total === 0) return <EmptyState>No outstanding invoices</EmptyState>;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="u-nums text-22 font-medium tracking-tight">{fmtMoney(totalOutstanding ?? total)}</div>
          <div className="text-12 text-ink-secondary mt-1">Outstanding</div>
        </div>
        {totalOverdue != null && totalOverdue > 0 && (
          <div className="text-right">
            <div className="u-nums text-14 font-medium text-alert-fg">{fmtMoney(totalOverdue)}</div>
            <div className="text-11 text-ink-secondary mt-1">Overdue</div>
          </div>
        )}
      </div>
      <div className="h-3 flex rounded-sm overflow-hidden">
        {buckets.map((b) => b.amount > 0 && (
          <div key={b.key} style={{ width: `${(b.amount / total) * 100}%`, background: b.fill }} />
        ))}
      </div>
      <ul className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-12">
        {buckets.map((b) => (
          <li key={b.key} className="min-w-0">
            <div className="flex items-center gap-2 u-label text-ink-secondary">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.fill }} />
              <span className="truncate">{b.label}</span>
            </div>
            <div className={cn('u-nums mt-1 font-medium', b.key === 'days_90_plus' && b.amount > 0 ? 'text-alert-fg' : 'text-zinc-900')}>
              {fmtMoneyCompact(b.amount)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Today's completion gauge (radial) ────────────────────────────

export function CompletionGauge({ completed = 0, total = 0, remaining = 0, cancelled = 0 }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const data = [{ name: 'Completed', value: pct, fill: CHART_INK }];
  return (
    <div className="grid grid-cols-2 gap-4 items-center">
      <div style={{ height: 180 }}>
        <ResponsiveContainer>
          <RadialBarChart
            innerRadius="68%"
            outerRadius="100%"
            data={data}
            startAngle={90}
            endAngle={90 - (pct / 100) * 360}
          >
            <RadialBar
              dataKey="value"
              background={{ fill: CHART_GRID }}
              cornerRadius={2}
              isAnimationActive={false}
            />
            <text
              x="50%" y="50%"
              textAnchor="middle"
              dominantBaseline="middle"
              fill={CHART_INK}
              style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}
            >
              {total === 0 ? '—' : `${pct}%`}
            </text>
          </RadialBarChart>
        </ResponsiveContainer>
      </div>
      <ul className="text-12 space-y-2">
        <Row label="Completed" value={completed} fill={CHART_INK} />
        <Row label="Remaining" value={remaining} fill={CHART_TICK} />
        <Row label="Cancelled" value={cancelled} fill={CHART_PRIOR} dim />
        <li className="pt-2 mt-2 border-t border-hairline border-zinc-200 flex items-baseline justify-between">
          <span className="u-label text-ink-secondary">Scheduled today</span>
          <span className="u-nums font-medium">{total}</span>
        </li>
      </ul>
    </div>
  );
}

function Row({ label, value, fill, dim }) {
  return (
    <li className="flex items-center gap-2 min-w-0">
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: fill }} />
      <span className={cn('truncate', dim && 'text-ink-tertiary')}>{label}</span>
      <span className="ml-auto u-nums">{value}</span>
    </li>
  );
}

// ─── MRR trend (line + customer-count bars) ───────────────────────

// `trend` is an array of { month, mrr, customer_count }.
export function MrrTrendChart({ trend = [], height = 220 }) {
  if (!trend.length) return <EmptyState>No MRR history yet</EmptyState>;
  return (
    <div style={{ height }}>
      <ResponsiveContainer>
        <LineChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="month" tick={{ fill: CHART_TICK, fontSize: 10 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
          <YAxis
            tick={{ fill: CHART_TICK, fontSize: 10 }}
            tickFormatter={fmtMoneyCompact}
            tickLine={false}
            axisLine={false}
            width={56}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v, name) => name === 'mrr' ? [fmtMoney(v), 'MRR'] : [v, 'Customers']}
          />
          <Line
            type="monotone"
            dataKey="mrr"
            stroke={CHART_INK}
            strokeWidth={1.75}
            dot={{ r: 2, fill: CHART_INK, strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Lead source attribution (horizontal bars) ────────────────────

// `bySource` is an array of { source, count, mrr_added }, ranked by count.
export function LeadSourceBars({ bySource = [], maxRows = 8 }) {
  if (!bySource.length) return <EmptyState>No new customers acquired this period</EmptyState>;
  const top = bySource.slice(0, maxRows);
  const max = Math.max(...top.map(r => r.count), 1);
  return (
    <ul className="space-y-2">
      {top.map((r) => (
        <li key={r.source}>
          <div className="flex items-baseline justify-between text-12 mb-1">
            <span className="text-zinc-900 truncate pr-2">{r.source}</span>
            <span className="u-nums">
              <span className="font-medium">{r.count}</span>
              <span className="text-ink-tertiary ml-2">{fmtMoneyCompact(r.mrr_added)} MRR</span>
            </span>
          </div>
          <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
            <div className="h-full" style={{ width: `${(r.count / max) * 100}%`, background: CHART_INK }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── Tech leaderboard bars ────────────────────────────────────────

// Horizontal-bar variant of the existing leaderboard table — same data,
// tuned for a glance instead of a scan.
export function TechLeaderboardBars({ leaderboard = [] }) {
  if (!leaderboard.length) return <EmptyState>No technician activity this period</EmptyState>;
  const max = Math.max(...leaderboard.map(t => t.revenue || 0), 1);
  return (
    <ul className="space-y-3">
      {leaderboard.map((t, i) => (
        <li key={t.techId || i}>
          <div className="flex items-baseline justify-between text-12 mb-1">
            <span className="text-zinc-900">
              <span className="text-ink-tertiary u-nums mr-2">{i + 1}.</span>
              <span className="font-medium">{t.name}</span>
              <span className="text-ink-tertiary ml-2 u-nums">· {t.jobs} jobs</span>
            </span>
            <span className="u-nums font-medium">{fmtMoney(t.revenue)}</span>
          </div>
          <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
            <div className="h-full" style={{ width: `${(t.revenue / max) * 100}%`, background: CHART_INK }} />
          </div>
          <div className="flex justify-between mt-1 text-11 text-ink-secondary u-nums">
            <span>RPMH {fmtMoney(t.rpmh)}</span>
            <span className={cn(t.margin < 40 && 'text-alert-fg font-medium')}>{t.margin}% margin</span>
            <span className={cn(t.callbackRate >= 6 && 'text-alert-fg font-medium')}>{t.callbackRate}% callbacks</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── Empty state ──────────────────────────────────────────────────

export function EmptyState({ children }) {
  return (
    <div className="py-10 text-center text-13 text-ink-secondary">{children}</div>
  );
}

// ─── Calls / Leads / Channel attribution panels ───────────────────
//
// All three live below the existing MRR trend and replace the prior
// downstream-string Lead Source Attribution panel with the upstream
// signal we actually capture (call_log + leads + lead_sources).

// Channel chip — small zinc pill that renders the attribution channel
// (organic / paid / direct / offline / unmapped). `paid` is rendered
// slightly more prominent so paid spend is easy to spot.
function ChannelChip({ channel }) {
  if (!channel) return null;
  const isPaid = channel === 'paid';
  return (
    <span
      className={cn(
        'inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-label rounded-xs border-hairline',
        isPaid
          ? 'bg-zinc-900 text-white border-zinc-900'
          : 'bg-surface-sunken text-ink-secondary border-zinc-200'
      )}
    >
      {channel}
    </span>
  );
}

// CallsBySourceList — call_log JOIN lead_sources by dialed number.
// `sources` is the array returned by /admin/dashboard/calls-by-source.
export function CallsBySourceList({ sources = [], maxRows = 10 }) {
  if (!sources.length) return <EmptyState>No inbound calls in this window</EmptyState>;
  const rows = sources.slice(0, maxRows);
  const max = Math.max(...rows.map((r) => r.calls), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => {
        const unmapped = r.sourceType === 'unmapped';
        const dormant = r.isActive === false;
        return (
          <li key={`${r.name}-${i}`}>
            <div className="flex items-baseline justify-between text-12 mb-1 gap-2">
              <span className={cn('truncate min-w-0 flex items-center gap-2', dormant && 'text-ink-tertiary')}>
                <span className="truncate">{r.name}</span>
                <ChannelChip channel={r.channel} />
                {unmapped && (
                  <span className="text-[10px] uppercase tracking-label text-alert-fg">unmapped</span>
                )}
              </span>
              <span className="u-nums whitespace-nowrap">
                <span className="font-medium">{r.calls}</span>
                <span className="text-ink-tertiary ml-2">{r.uniqueCallers} unique</span>
              </span>
            </div>
            <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
              <div
                className="h-full"
                style={{
                  width: `${(r.calls / max) * 100}%`,
                  background: unmapped ? CHART_ALERT : (dormant ? CHART_PRIOR : CHART_INK),
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// LeadsBySourceList — `leads` GROUP BY lead_source_id.
// Shows count + booked + conversion %. Conversion below 20% renders in alert-fg.
export function LeadsBySourceList({ sources = [], maxRows = 10 }) {
  if (!sources.length) return <EmptyState>No leads in this window</EmptyState>;
  const rows = sources.slice(0, maxRows);
  const max = Math.max(...rows.map((r) => r.leads), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => {
        const conv = r.conversionPct;
        const lowConv = conv != null && conv < 20 && r.leads >= 5;
        return (
          <li key={`${r.name}-${i}`}>
            <div className="flex items-baseline justify-between text-12 mb-1 gap-2">
              <span className="truncate min-w-0 flex items-center gap-2">
                <span className="truncate">{r.name}</span>
                <ChannelChip channel={r.channel} />
              </span>
              <span className="u-nums whitespace-nowrap">
                <span className="font-medium">{r.leads}</span>
                <span className="text-ink-tertiary ml-2">{r.booked} won</span>
                {conv != null && (
                  <span className={cn('ml-2', lowConv ? 'text-alert-fg font-medium' : 'text-ink-tertiary')}>
                    {conv}%
                  </span>
                )}
              </span>
            </div>
            <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
              <div
                className="h-full"
                style={{ width: `${(r.leads / max) * 100}%`, background: CHART_INK }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ChannelMixDonut — leads.first_contact_channel breakdown.
// Phone vs form vs sms vs other — answers "is the web catching the phone yet?".
// Reuses the same monochrome ramp as ServiceMixDonut so the dashboard reads
// as a single visual system.
export function ChannelMixDonut({ channels = [], height = 200 }) {
  if (!channels.length) return <EmptyState>No leads in this window</EmptyState>;
  const data = channels.map((c, i) => ({
    name: c.channel,
    value: c.leads,
    pct: c.pctOfTotal,
    booked: c.booked,
    fill: CHART_SERIES[i % CHART_SERIES.length],
  }));
  return (
    <div className="grid grid-cols-2 gap-4 items-center" style={{ minHeight: height }}>
      <div style={{ height }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="92%"
              stroke="#FFFFFF"
              strokeWidth={1}
              isAnimationActive={false}
            >
              {data.map((d, i) => (<Cell key={i} fill={d.fill} />))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v, name, p) => [`${v} (${p?.payload?.pct}%) · ${p?.payload?.booked} won`, name]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="text-12 space-y-2">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: d.fill }} />
            <span className="truncate capitalize">{d.name}</span>
            <span className="ml-auto u-nums text-ink-secondary">{d.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
