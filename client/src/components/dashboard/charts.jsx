// Chart primitives for the redesigned admin Dashboard (DashboardPageV2).
//
// Palette: semantic colors keyed to what each chart represents (revenue
// = emerald, primary/info = sky, ops warn = amber, alarms = red). This
// is a deliberate exception to the broader admin monochrome contract,
// kept scoped to the Dashboard's data-viz primitives at the owner's
// request — text + chrome on every other admin surface stays zinc.

import { useState } from 'react';
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
// Semantic ramp: each color carries meaning rather than position. The
// dashboard is the only admin surface using non-zinc fills; everything
// outside this file still follows the zinc + alert-fg-only rule.

export const CHART_INK = '#18181B';            // zinc-900 — neutral text fills
export const CHART_INK_DIM = '#52525B';        // zinc-600 — secondary lines
export const CHART_GRID = '#E4E4E7';           // zinc-200 — gridlines / dividers
export const CHART_TICK = '#71717A';           // zinc-500 — axis ticks
export const CHART_PRIOR = '#A1A1AA';          // zinc-400 — prior-period overlay / dim
export const CHART_ALERT = '#C8312F';          // alert-fg — failing buckets only

// Semantic accents — used by data fills, not by text or chrome.
export const CHART_PRIMARY = '#0EA5E9';        // sky-500 — Waves brand, primary data fills
export const CHART_SUCCESS = '#10B981';        // emerald-500 — revenue / healthy / completed
export const CHART_WARN    = '#F59E0B';        // amber-500 — aging / soft warnings
export const CHART_INFO    = '#A855F7';        // purple-500 — secondary categorical
export const CHART_PINK    = '#EC4899';        // pink-500 — categorical
export const CHART_TEAL    = '#14B8A6';        // teal-500 — categorical

// Categorical ramp for service mix / channel mix / source attribution.
// Ordered so the most-common slice gets Waves sky and adjacent hues stay
// distinguishable on a small donut.
export const CHART_SERIES = [
  CHART_PRIMARY, // sky
  CHART_SUCCESS, // emerald
  CHART_WARN,    // amber
  CHART_INFO,    // purple
  CHART_PINK,    // pink
  CHART_TEAL,    // teal
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

const RESPONSIVE_INITIAL_DIMENSION = { width: 1, height: 1 };
const SPARKLINE_INITIAL_DIMENSION = { width: 88, height: 28 };

// ─── KPI tile w/ sparkline + delta ────────────────────────────────

// Big number, tiny inline area sparkline, period-over-period delta.
// Pass `series` as an array of numbers (oldest → newest). If `delta`
// is null, the chip is suppressed.
export function KpiSparklineTile({ label, value, sub, delta, deltaSuffix, alert, series }) {
  const data = (series || []).map((v, i) => ({ i, v: Number(v) || 0 }));
  return (
    <Card className="max-md:border-0 max-md:shadow-sm max-md:rounded-xl max-md:min-h-[128px]">
      <CardBody className="p-4 max-md:p-4">
        <div className="u-label text-ink-secondary max-md:text-11 max-md:font-semibold max-md:tracking-label max-md:uppercase max-md:text-zinc-600">
          {label}
        </div>
        <div className="flex items-end justify-between gap-3 mt-2 max-md:block">
          <div
            className={cn(
              'u-nums text-28 font-medium tracking-tight leading-none max-md:text-[28px] max-md:font-bold',
              alert ? 'text-alert-fg' : 'text-zinc-900'
            )}
          >
            {value}
          </div>
          {data.length > 1 && (
            <div className="w-[88px] h-[28px] flex-shrink-0 opacity-90">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={0}
                initialDimension={SPARKLINE_INITIAL_DIMENSION}
              >
                <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_PRIMARY} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={CHART_PRIMARY} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={CHART_PRIMARY}
                    strokeWidth={1.5}
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
              'mt-2 text-12 font-medium max-md:text-11',
              delta < 0 ? 'text-alert-fg' : 'text-ink-secondary'
            )}
          >
            {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)}{deltaSuffix || '% vs prior'}
          </div>
        )}
        {sub && delta == null && (
          <div className="mt-2 text-12 max-md:text-11 text-ink-secondary">{sub}</div>
        )}
      </CardBody>
    </Card>
  );
}

// ─── Compact KPI charts (gauge ring / bullet bar / diverging) ─────
//
// Tiny visuals sized to live INSIDE a Core-KPI tile. All point-in-time
// (no time series), tone-coded: alert = red, on/above target = emerald,
// otherwise the Waves sky. Used by DashboardPageV2's KpiTile.

// Pick a fill tone from the row's alert flag + whether it meets its target.
function kpiTone(value, target, lowerIsBetter, alert) {
  if (alert) return CHART_ALERT;
  if (target != null && Number.isFinite(value)) {
    const meets = lowerIsBetter ? value <= target : value >= target;
    if (meets) return CHART_SUCCESS;
  }
  return CHART_PRIMARY;
}

// Progress ring with the value in the center. `display` is the formatted
// label (e.g. "45%", "10/10"); value/max drive the arc fraction.
export function KpiRing({ value, max = 100, target = null, lowerIsBetter = false, alert = false, display }) {
  // null/undefined/'' = metric absent this period. Keep it absent (NaN) so a
  // lower-is-better KPI isn't coerced to 0 and painted "on target" (green) while
  // the tile shows "—"; an absent ring renders a muted, empty track instead.
  const v = value == null || value === '' ? NaN : Number(value);
  const present = Number.isFinite(v);
  const frac = present && max > 0 ? Math.max(0, Math.min(1, v / max)) : 0;
  const size = 58;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = present ? kpiTone(v, target, lowerIsBetter, alert) : CHART_PRIOR;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={CHART_GRID} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${frac * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fill={color === CHART_SUCCESS || color === CHART_ALERT ? color : present ? '#18181B' : CHART_PRIOR}
        style={{ fontSize: String(display ?? '').length > 4 ? 11 : 13, fontWeight: 500 }}
      >
        {display}
      </text>
    </svg>
  );
}

// Horizontal value bar with a target marker. `max` defaults to leave the
// value and target both visible with headroom.
export function KpiBullet({ value, target = null, max = null, lowerIsBetter = false, alert = false }) {
  // Absent metric → no fill + muted tone, so missing data never paints as
  // "on target" (see KpiRing).
  const present = value != null && value !== '' && Number.isFinite(Number(value));
  const v = present ? Number(value) : 0;
  const t = target != null ? Number(target) : null;
  const ceiling = max || Math.max(v, t || 0) * 1.25 || 1;
  const valFrac = present ? Math.max(0, Math.min(1, v / ceiling)) : 0;
  const tgtFrac = t != null ? Math.max(0, Math.min(1, t / ceiling)) : null;
  const color = present ? kpiTone(v, t, lowerIsBetter, alert) : CHART_PRIOR;
  return (
    <div className="relative h-2 rounded-sm bg-zinc-200 overflow-hidden">
      <div className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${valFrac * 100}%`, background: color }} />
      {tgtFrac != null && (
        <div className="absolute inset-y-0 w-px bg-zinc-900" style={{ left: `${tgtFrac * 100}%` }} title={`target ${target}`} />
      )}
    </div>
  );
}

// New-vs-lost split for momentum tiles (net = positive − negative).
export function KpiDivergingBar({ positive = 0, negative = 0 }) {
  const p = Math.abs(Number(positive) || 0);
  const n = Math.abs(Number(negative) || 0);
  const tot = p + n;
  if (tot === 0) return <div className="h-2 rounded-sm bg-zinc-200" />;
  return (
    <div className="flex h-2 rounded-sm overflow-hidden bg-zinc-200">
      <div style={{ width: `${(p / tot) * 100}%`, background: CHART_SUCCESS }} title={`+${positive} new`} />
      <div style={{ width: `${(n / tot) * 100}%`, background: CHART_ALERT }} title={`${negative} lost`} />
    </div>
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
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={RESPONSIVE_INITIAL_DIMENSION}
      >
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="rev-current" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_SUCCESS} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART_SUCCESS} stopOpacity={0} />
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
            stroke={CHART_SUCCESS}
            strokeWidth={1.75}
            fill="url(#rev-current)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Review trend area (monthly Google-review count) ──────────────

// `trend` is an array of { month:'YYYY-MM', label:'Jul 2025', count, avgRating }.
// Reviews are a positive metric, so the area is filled with CHART_SUCCESS like
// the revenue trend. X-axis = the short month (e.g. 'Jul'), Y = monthly count.
export function ReviewTrendChart({ trend = [], height = 240 }) {
  if (!trend.length) return <EmptyState>No reviews yet</EmptyState>;
  const data = trend.map((t) => ({
    // Strip 'Jul 2025' → 'Jul'; fall back to the label or month key as-is.
    month: (t.label || t.month || '').split(' ')[0] || t.month,
    count: Number(t.count) || 0,
    avgRating: t.avgRating ?? null,
  }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={RESPONSIVE_INITIAL_DIMENSION}
      >
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="review-count" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_SUCCESS} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART_SUCCESS} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis
            dataKey="month"
            tick={{ fill: CHART_TICK, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID }}
          />
          <YAxis
            tick={{ fill: CHART_TICK, fontSize: 10 }}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v, _name, p) => {
              const r = p?.payload?.avgRating;
              return [r != null ? `${v} reviews · ${r}★` : `${v} reviews`, 'Reviews'];
            }}
          />
          <Area
            type="monotone"
            dataKey="count"
            stroke={CHART_SUCCESS}
            strokeWidth={1.75}
            fill="url(#review-count)"
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
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          initialDimension={RESPONSIVE_INITIAL_DIMENSION}
        >
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
                background: s.dim ? CHART_PRIOR : CHART_PRIMARY,
              }}
            />
          </div>
        </div>
      ))}
      {totalAcceptedValue != null && (
        <div className="pt-3 mt-3 flex items-baseline justify-between">
          <span className="u-label text-ink-secondary">Accepted value</span>
          <span className="u-nums text-18 font-medium">{fmtMoney(totalAcceptedValue)}</span>
        </div>
      )}
    </div>
  );
}

// ─── AR aging stacked bar ─────────────────────────────────────────

// `aging` { current, days_30, days_60, days_90, days_120, days_120_plus }. Six
// ST-style stacked segments on a green→red severity ramp so the oldest, least-
// collectible debt (91–120, 121+) stands out for collections triage; those two
// oldest buckets render in alert red.
export function AgingBar({ aging = {}, totalOutstanding, totalOverdue, height = 180 }) {
  const buckets = [
    { key: 'current',       label: 'Current',     amount: aging.current       || 0, fill: CHART_SUCCESS },
    { key: 'days_30',       label: '1–30 days',   amount: aging.days_30       || 0, fill: CHART_PRIMARY },
    { key: 'days_60',       label: '31–60 days',  amount: aging.days_60       || 0, fill: CHART_WARN },
    { key: 'days_90',       label: '61–90 days',  amount: aging.days_90        || 0, fill: '#FB923C' },
    { key: 'days_120',      label: '91–120 days', amount: aging.days_120      || 0, fill: '#F87171', severe: true },
    { key: 'days_120_plus', label: '121+ days',   amount: aging.days_120_plus || 0, fill: CHART_ALERT, severe: true },
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
      <ul className="grid grid-cols-3 md:grid-cols-6 gap-3 mt-4 text-12">
        {buckets.map((b) => (
          <li key={b.key} className="min-w-0">
            <div className="flex items-center gap-2 u-label text-ink-secondary">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.fill }} />
              <span className="truncate">{b.label}</span>
            </div>
            <div className={cn('u-nums mt-1 font-medium', b.severe && b.amount > 0 ? 'text-alert-fg' : 'text-zinc-900')}>
              {fmtMoneyCompact(b.amount)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Revenue by city (horizontal bar list) ────────────────────────
//
// ServiceTitan-style geo cut: where this month's completed-service
// revenue comes from. Lightweight div-bar list (no Recharts), matching
// the ChannelMixBar / AgingBar style already in this file.

export function RevenueByCity({ cities = [], total = 0 }) {
  if (!cities.length) {
    return <EmptyState>No completed-service revenue this month</EmptyState>;
  }
  const maxRevenue = Math.max(...cities.map((c) => c.revenue || 0), 1);
  return (
    <ul className="space-y-2.5">
      {cities.map((c) => (
        <li key={c.city} className="flex items-center gap-3 text-12">
          <span className="w-24 flex-shrink-0 truncate text-ink-secondary" title={c.city}>
            {c.city}
          </span>
          <div className="flex-1 h-2 rounded-sm overflow-hidden bg-surface-sunken">
            <div
              className="h-full rounded-sm"
              style={{ width: `${(c.revenue / maxRevenue) * 100}%`, background: CHART_PRIMARY }}
            />
          </div>
          <span className="flex-shrink-0 u-nums text-right whitespace-nowrap">
            <span className="font-medium text-zinc-900">{fmtMoneyCompact(c.revenue)}</span>
            <span className="text-ink-tertiary"> · {c.jobs} jobs</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ─── Today's completion gauge (radial) ────────────────────────────

export function CompletionGauge({ completed = 0, total = 0, remaining = 0, cancelled = 0, noShow = 0 }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const data = [{ name: 'Completed', value: pct, fill: CHART_SUCCESS }];
  return (
    <div className="grid grid-cols-2 gap-4 items-center">
      <div style={{ height: 180 }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          initialDimension={RESPONSIVE_INITIAL_DIMENSION}
        >
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
              fill="#18181B"
              style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}
            >
              {total === 0 ? '—' : `${pct}%`}
            </text>
          </RadialBarChart>
        </ResponsiveContainer>
      </div>
      <ul className="text-12 space-y-2">
        <Row label="Completed" value={completed} fill={CHART_SUCCESS} />
        <Row label="Remaining" value={remaining} fill={CHART_PRIMARY} />
        <Row label="Cancelled" value={cancelled} fill={CHART_PRIOR} dim />
        {/* No-show only renders when present — excluded from Remaining
            server-side, so without this row the buckets wouldn't sum to
            Scheduled today on a day with a missed visit. */}
        {noShow > 0 ? <Row label="No-show" value={noShow} fill={CHART_PRIOR} dim /> : null}
        <li className="pt-2 mt-2 flex items-baseline justify-between">
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

// ─── Sales-capture speedometer (semicircle gauge) ─────────────────
//
// ServiceTitan-style "captured vs missed" hero gauge: a 180° arc split into
// three risk zones (red 0–40 / amber 40–70 / green 70–100) with a needle at
// the capture rate. Pure SVG — no Recharts — matching KpiRing's lightweight,
// hand-rolled-arc style.

// Map a gauge fraction t∈[0,1] to a point on the semicircle. The arc spans the
// TOP half: t=0 is the left end (180°), t=1 the right end (0°), so the angle
// sweeps 180°→0°. SVG y grows downward, so a point above the center has y < cy
// (we subtract the sin term).
function gaugePoint(cx, cy, radius, t) {
  const angle = Math.PI * (1 - t); // 0→π as t goes 1→0; here t→angle = (1−t)π
  return {
    x: cx + radius * Math.cos(angle),
    y: cy - radius * Math.sin(angle),
  };
}

// SVG path for the arc segment between two fractions (t0 → t1) along the
// semicircle. Uses a single arc command (sweep-flag 1 = clockwise across the
// top from left toward right as t increases).
function gaugeArcPath(cx, cy, radius, t0, t1) {
  const a = gaugePoint(cx, cy, radius, t0);
  const b = gaugePoint(cx, cy, radius, t1);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

// Zone tone for the rate text + needle: <40 red, 40–69 amber, ≥70 green.
function captureZoneColor(rate) {
  if (rate == null || !Number.isFinite(rate)) return CHART_PRIOR;
  if (rate < 40) return CHART_ALERT;
  if (rate < 70) return CHART_WARN;
  return CHART_SUCCESS;
}

export function CaptureGauge({ captureRate, captured = 0, missed = 0, wonCount = 0, lostCount = 0 }) {
  const present = captureRate != null && Number.isFinite(Number(captureRate));
  const rate = present ? Math.max(0, Math.min(100, Number(captureRate))) : 0;
  const t = rate / 100;

  // Geometry: a 220-wide viewBox, center near the bottom so the semicircle
  // fills the top. Stroke width gives the colored band thickness.
  const W = 220;
  const cx = W / 2;
  const cy = 120;
  const radius = 92;
  const band = 16;

  // Three colored zones along the arc (fractions of the 0–100 scale).
  const zones = [
    { from: 0, to: 0.4, color: CHART_ALERT },
    { from: 0.4, to: 0.7, color: CHART_WARN },
    { from: 0.7, to: 1, color: CHART_SUCCESS },
  ];

  // Needle: a thin line from the hub to the rim at the current fraction,
  // pulled slightly inside the band so the tip sits on the colored arc.
  const needleColor = captureZoneColor(present ? rate : null);
  const tip = gaugePoint(cx, cy, radius - band - 4, t);

  return (
    <div className="flex flex-col items-center">
      <svg
        viewBox={`0 0 ${W} 140`}
        width="100%"
        style={{ maxWidth: 320 }}
        role="img"
        aria-label={`Capture rate ${present ? `${Math.round(rate)} percent` : 'unavailable'}`}
      >
        {/* Track underlay so the band reads as a continuous arc even at the
            zone seams. */}
        <path
          d={gaugeArcPath(cx, cy, radius, 0, 1)}
          fill="none"
          stroke={CHART_GRID}
          strokeWidth={band}
          strokeLinecap="round"
        />
        {/* Colored risk zones. */}
        {zones.map((z) => (
          <path
            key={z.from}
            d={gaugeArcPath(cx, cy, radius, z.from, z.to)}
            fill="none"
            stroke={present ? z.color : CHART_PRIOR}
            strokeWidth={band}
            opacity={present ? 1 : 0.35}
          />
        ))}
        {/* Needle + hub. */}
        {present && (
          <>
            <line
              x1={cx}
              y1={cy}
              x2={tip.x.toFixed(2)}
              y2={tip.y.toFixed(2)}
              stroke={needleColor}
              strokeWidth={3}
              strokeLinecap="round"
            />
            <circle cx={cx} cy={cy} r={5} fill={needleColor} />
          </>
        )}
        {/* Endpoint labels: 0% (left) and 100% (right). */}
        <text x={cx - radius} y={cy + 16} textAnchor="middle" fill={CHART_TICK} style={{ fontSize: 10, fontWeight: 400 }}>0%</text>
        <text x={cx + radius} y={cy + 16} textAnchor="middle" fill={CHART_TICK} style={{ fontSize: 10, fontWeight: 400 }}>100%</text>
      </svg>

      {/* Big rate %, toned by zone, with the captured/missed money + counts. */}
      <div className="mt-1 text-center">
        <div
          className="u-nums leading-none"
          style={{ fontSize: 40, fontWeight: 500, letterSpacing: '-0.02em', color: present ? needleColor : CHART_PRIOR }}
        >
          {present ? `${Math.round(rate)}%` : '—'}
        </div>
        <div className="u-label text-ink-tertiary mt-1">Capture rate</div>
        <div className="text-13 text-ink-secondary mt-2 u-nums">
          {fmtMoneyCompact(captured)} captured · {fmtMoneyCompact(missed)} missed
        </div>
        <div className="text-12 text-ink-tertiary mt-1 u-nums">
          {fmtInt(wonCount)} won / {fmtInt(lostCount)} lost
        </div>
      </div>
    </div>
  );
}

// ─── MRR trend (line + customer-count bars) ───────────────────────

// `trend` is an array of { month, mrr, customer_count }.
export function MrrTrendChart({ trend = [], height = 220 }) {
  if (!trend.length) return <EmptyState>No MRR history yet</EmptyState>;
  return (
    <div style={{ height }}>
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={RESPONSIVE_INITIAL_DIMENSION}
      >
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
            stroke={CHART_SUCCESS}
            strokeWidth={1.75}
            dot={{ r: 2, fill: CHART_SUCCESS, strokeWidth: 0 }}
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
            <div className="h-full" style={{ width: `${(r.count / max) * 100}%`, background: CHART_PRIMARY }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── Retention cohort grid ────────────────────────────────────────

// Signup-cohort retention heatmap. Rows = the month a customer converted,
// columns = whole months since signup (M0 = signup month = 100% base), cell =
// % of that cohort still a live customer. Monochrome zinc heat (darker = higher
// retention); the % is always printed so small differences in the high range
// stay legible. Future cells (a cohort hasn't aged that far yet) are blank.
export function RetentionCohortGrid({ cohorts = [], maxOffset = 0 }) {
  // Toggle between headcount retention (% of customers still active) and
  // MRR-weighted retention (% of the cohort's recurring revenue still active).
  const [weight, setWeight] = useState("customers");
  if (!cohorts.length) return <EmptyState>Not enough customer history yet</EmptyState>;
  const mrrAvailable = cohorts.some(
    (c) => Array.isArray(c.retentionMrr) && c.retentionMrr.some((v) => v != null),
  );
  const byMrr = weight === "mrr" && mrrAvailable;
  const cols = Array.from({ length: maxOffset + 1 }, (_, i) => i);
  // Zinc-900 wash whose opacity tracks retention; text flips to white once the
  // wash is dark enough to keep contrast readable.
  const cellStyle = (pct) => ({
    backgroundColor: `rgba(24, 24, 27, ${0.06 + (pct / 100) * 0.84})`,
    color: pct >= 45 ? "#fff" : "#3f3f46",
  });
  return (
    <div>
      {mrrAvailable && (
        <div className="flex items-center gap-2 mb-3">
          <div className="inline-flex border-hairline border-zinc-300 rounded-sm overflow-hidden">
            {[["customers", "Customers"], ["mrr", "MRR"]].map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setWeight(k)}
                className={cn(
                  "px-2.5 h-7 text-12",
                  weight === k ? "bg-zinc-900 text-white" : "text-ink-secondary hover:bg-zinc-50",
                )}
              >
                {lbl}
              </button>
            ))}
          </div>
          <span className="text-11 text-ink-tertiary">
            {byMrr ? "share of cohort MRR retained" : "share of customers retained"}
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <div className="min-w-max">
          <div className="flex items-center gap-1 mb-1">
            <div className="w-16 shrink-0 u-label text-ink-tertiary">Cohort</div>
            <div className="w-10 shrink-0 u-label text-ink-tertiary text-right">N</div>
            {cols.map((m) => (
              <div key={m} className="w-10 shrink-0 u-label text-ink-tertiary text-center">{`M${m}`}</div>
            ))}
          </div>
          {cohorts.map((c) => {
            const series = byMrr ? c.retentionMrr : c.retention;
            return (
              <div key={c.month} className="flex items-center gap-1 mb-1">
                <div className="w-16 shrink-0 text-12 text-ink-secondary truncate">{c.label}</div>
                <div className="w-10 shrink-0 text-12 u-nums text-ink-tertiary text-right">{fmtInt(c.size)}</div>
                {cols.map((m) => {
                  const pct = series?.[m];
                  if (pct == null) return <div key={m} className="w-10 h-7 shrink-0" />;
                  const title = byMrr
                    ? `${c.label} · month ${m}: ${pct}% of ${fmtMoney(c.baseMrr)} cohort MRR retained`
                    : `${c.label} · month ${m}: ${pct}% of ${c.size} retained`;
                  return (
                    <div
                      key={m}
                      className="w-10 h-7 shrink-0 rounded-xs flex items-center justify-center text-11 u-nums"
                      style={cellStyle(pct)}
                      title={title}
                    >
                      {Math.round(pct)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
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
      {leaderboard.map((t, i) => {
        // Unassigned bucket = service_records without technician_id.
        // Render in alert-fg if any unassigned jobs exist — that's
        // a true alert (work nobody is being credited for, callback
        // rates undercounted, leaderboard inflated).
        const unassigned = !!t.unassigned;
        return (
          <li key={t.techId || `unassigned-${i}`}>
            <div className="flex items-baseline justify-between text-12 mb-1">
              <span className={cn('text-zinc-900', unassigned && 'text-alert-fg')}>
                <span className="text-ink-tertiary u-nums mr-2">{i + 1}.</span>
                <span className="font-medium">{t.name}</span>
                <span className="text-ink-tertiary ml-2 u-nums">· {t.jobs} jobs</span>
              </span>
              <span className={cn('u-nums font-medium', unassigned && 'text-alert-fg')}>{fmtMoney(t.revenue)}</span>
            </div>
            <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
              <div
                className="h-full"
                style={{
                  width: `${(t.revenue / max) * 100}%`,
                  background: unassigned ? CHART_ALERT : CHART_SUCCESS,
                }}
              />
            </div>
            <div className="flex justify-between mt-1 text-11 text-ink-secondary u-nums">
              <span>RPMH {fmtMoney(t.rpmh)}</span>
              <span className={cn(t.margin < 40 && 'text-alert-fg font-medium')}>{t.margin}% margin</span>
              <span className={cn(t.callbackRate >= 6 && 'text-alert-fg font-medium')}>{t.callbackRate}% callbacks</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Empty state ──────────────────────────────────────────────────

export function EmptyState({ children }) {
  return (
    <div className="py-10 text-center text-13 text-ink-secondary">{children}</div>
  );
}

// Capital allocation — channels banded by LTV:CAC so the owner can see at a glance
// where to pour cash and where it's leaking. Traffic-light band colors mirror the
// documented Customers-surface triage palette (the dashboard's color exception).
const CAP_TONE_COLOR = {
  great: '#10B981', // pour_in
  good: '#10B981', // healthy / scale
  warn: '#F59E0B', // below 3:1
  bad: '#C8312F', // losing
  neutral: '#9CA3AF', // no paid spend
};
function fmtRatio(v) {
  return v == null ? '—' : `${v}:1`;
}

export function CapitalAllocationCard({ data }) {
  const channels = data?.channels || [];
  if (!channels.length) return <EmptyState>No ad spend tracked yet</EmptyState>;
  const h = data.headline || {};
  const blendedColor = h.blendedLtvCac == null ? undefined : (CAP_TONE_COLOR[h.blendedTone] || CAP_TONE_COLOR.neutral);
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="u-label text-ink-tertiary">Blended LTV:CAC</div>
          <div className="u-nums text-28 font-medium tracking-tight leading-none" style={{ color: blendedColor }}>
            {fmtRatio(h.blendedLtvCac)}
          </div>
        </div>
        {h.blendedBandLabel && (
          <span
            className="text-11 px-2 py-0.5 rounded-sm shrink-0"
            style={{ color: blendedColor || '#71717a', border: `1px solid ${blendedColor || '#d4d4d8'}` }}
          >
            {h.blendedBandLabel}
          </span>
        )}
      </div>

      {h.topOpportunity && (
        <div className="text-12 mt-2" style={{ color: CAP_TONE_COLOR.good }}>
          ▲ <span className="font-medium">{h.topOpportunity.source}</span> {fmtRatio(h.topOpportunity.ltvCac)} —{' '}
          {h.topOpportunity.band === 'pour_in' ? 'pour cash in' : 'scale up'}
        </div>
      )}
      {h.biggestLeak && (
        <div className="text-12 mt-1" style={{ color: CAP_TONE_COLOR.bad }}>
          ▼ <span className="font-medium">{h.biggestLeak.source}</span> {fmtRatio(h.biggestLeak.ltvCac)} — losing money, cut or fix
        </div>
      )}

      <div className="mt-3 space-y-2">
        {channels.map((c) => {
          const color = CAP_TONE_COLOR[c.tone] || CAP_TONE_COLOR.neutral;
          const title = `${c.bandLabel}: ${c.verdict}\nCAC ${c.cac == null ? '—' : fmtMoney(c.cac)} · spend ${fmtMoney(c.adSpend)} · ${fmtInt(c.customers)} customers`;
          return (
            <div
              key={c.sourceKey}
              className="flex items-center gap-2"
              style={{ opacity: c.confidence === 'low' ? 0.55 : 1 }}
              title={title}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
              <span className="text-13 text-ink-primary truncate">{c.source}</span>
              {c.confidence === 'low' && c.ltvCac != null && (
                <span className="text-11 text-ink-tertiary shrink-0">n={fmtInt(c.customers)}</span>
              )}
              <span
                className="ml-auto u-nums text-13 font-medium"
                style={{ color: c.ltvCac == null ? undefined : color }}
              >
                {fmtRatio(c.ltvCac)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-11 text-ink-tertiary">
        Lifetime gross profit ÷ ad spend, by channel. ≥30:1 = pour cash in; under 3:1 = fix or cut. Faded = small sample.
      </div>
    </div>
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

// ─── Marketing Attribution scorecard ──────────────────────────────
//
// ServiceTitan-style unified view: a Calls → Leads → Booked funnel strip
// over a single sortable per-source table (merging calls-by-source and
// leads-by-source by source name), plus a slim first-contact channel-mix
// bar. Replaces the prior three separate cards (calls list / leads list /
// channel donut). Same data/endpoints — purely a visual rework. The caller
// wraps it in a ChartCard / MobileFold.

// Merge calls-by-source + leads-by-source into one record per source name. A
// source can have calls but no leads (a tracking DID / "Unmapped — …") or leads
// but no calls (web "Unattributed"); hasCalls / hasLeads keep those distinct so
// the table shows "—" rather than a misleading 0.
function mergeAttributionRows(calls, leads) {
  const byName = new Map();
  const ensure = (name) => {
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        channel: null,
        sourceType: null,
        isActive: null,
        calls: 0,
        uniqueCallers: 0,
        leads: 0,
        booked: 0,
        conversionPct: null,
        revenue: null,
        cost: null,
        roi: null,
        hasCalls: false,
        hasLeads: false,
        hasRevenue: false,
      });
    }
    return byName.get(name);
  };
  // /calls-by-source groups by name + dialed number, and source names are not
  // unique, so one source can arrive as several rows — AGGREGATE them rather
  // than overwrite, or the table undercounts vs the funnel total. A NULL name
  // (call_log.to_phone IS NULL → COALESCE concat yields NULL) collapses to one
  // 'Unmapped' bucket so it never crashes the name sort.
  for (const c of calls) {
    const row = ensure(c.name || 'Unmapped');
    row.calls += c.calls || 0;
    row.uniqueCallers += c.uniqueCallers || 0;
    row.hasCalls = true;
    if (row.channel == null) row.channel = c.channel || null;
    if (row.sourceType == null) row.sourceType = c.sourceType ?? null;
    if (c.isActive === true) row.isActive = true;
    else if (row.isActive == null) row.isActive = c.isActive ?? null;
  }
  for (const l of leads) {
    const row = ensure(l.name || 'Unattributed');
    row.leads += l.leads || 0;
    row.booked += l.booked || 0;
    row.hasLeads = true;
    if (row.channel == null) row.channel = l.channel || null;
    if (row.sourceType == null) row.sourceType = l.sourceType ?? null;
    // Revenue/cost/ROI are already aggregated by source NAME server-side, so the
    // same value rides on every duplicate-named lead row — SET (not add) to avoid
    // double-counting when the client also merges those rows by name.
    if (l.revenue != null) {
      row.revenue = l.revenue;
      row.hasRevenue = true;
    }
    if (l.cost != null) row.cost = l.cost;
    if (l.roi != null) row.roi = l.roi;
  }
  // Recompute conversion from aggregated totals (a per-row pct can't be summed);
  // null for sources with no leads so the cell shows "—" and sorts as absent.
  for (const row of byName.values()) {
    row.conversionPct = row.hasLeads && row.leads > 0
      ? Math.round((row.booked / row.leads) * 1000) / 10
      : null;
  }
  return [...byName.values()];
}

// Sortable value for a metric, treating a metric the row doesn't have (a
// call-only DID has no leads; a lead-only web source has no calls) as null so
// it sorts last in BOTH directions — matching the "—" the cell renders.
function attributionMetric(row, key) {
  if ((key === 'calls' || key === 'uniqueCallers') && !row.hasCalls) return null;
  if ((key === 'leads' || key === 'booked' || key === 'conversionPct') && !row.hasLeads) return null;
  if (key === 'revenue' && !row.hasRevenue) return null;
  return row[key]; // roi is already null when absent
}

const SCORECARD_COLUMNS = [
  { key: 'calls', label: 'Calls' },
  { key: 'uniqueCallers', label: 'Unique' },
  { key: 'leads', label: 'Leads' },
  { key: 'booked', label: 'Booked' },
  { key: 'conversionPct', label: 'Conv' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'roi', label: 'ROI' },
];

function sortAttributionRows(rows, key, dir) {
  const m = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'name') return (a.name || '').localeCompare(b.name || '') * m;
    // Absent metrics (a row that has no calls, or no leads) always sort last so
    // "—" cells don't float to the top of an ascending sort.
    const av = attributionMetric(a, key);
    const bv = attributionMetric(b, key);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * m;
  });
}

// Tapering visual funnel — Calls → Leads → Booked as proportional bars (each
// width = value / calls, floored so the tiny Booked stage stays visible), with
// the stage-to-stage pass-through % called out on the right, then a Won-rev line.
function AttributionFunnel({ calls, leads, booked, leadsToBookedPct, revenue }) {
  const base = calls > 0 ? calls : null;
  const widthFor = (value) => {
    if (base == null || value == null) return 6;
    return Math.max((value / base) * 100, 6);
  };
  const leadsPct = base != null && leads != null ? Math.round((leads / base) * 100) : null;
  const stages = [
    { label: 'Calls', value: calls, pct: null },
    { label: 'Leads', value: leads, pct: leadsPct },
    { label: 'Booked', value: booked, pct: leadsToBookedPct ?? null },
  ];
  return (
    <div className="pb-3 mb-3 border-b border-hairline border-zinc-200">
      <div className="u-label text-ink-tertiary mb-2">Funnel</div>
      <div className="flex flex-col gap-1.5">
        {stages.map((s) => (
          <div key={s.label} className="flex items-center gap-3">
            <span className="u-label text-ink-tertiary w-12 shrink-0">{s.label}</span>
            <div className="relative flex-1 h-5 rounded-xs overflow-hidden bg-surface-sunken" style={{ background: CHART_GRID }}>
              <div
                className="absolute inset-y-0 left-0 rounded-xs"
                style={{ width: `${widthFor(s.value)}%`, background: CHART_PRIMARY }}
              />
            </div>
            {/* value sits OUTSIDE the bar so it stays legible even when the bar
                is floored to its 6% minimum (e.g. the small Booked stage). */}
            <span className="u-nums text-12 text-ink-primary w-10 shrink-0 text-right">
              {s.value == null ? '—' : fmtInt(s.value)}
            </span>
            <span className="u-nums text-11 text-ink-tertiary w-12 shrink-0 text-right whitespace-nowrap">
              {s.pct != null ? `↓ ${s.pct}%` : ''}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-baseline gap-2 mt-2 pl-[3.75rem]">
        <span className="u-label text-ink-tertiary">Won rev</span>
        <span className="u-nums text-16 font-medium text-ink-primary">
          {revenue == null ? '—' : fmtMoneyCompact(revenue)}
        </span>
      </div>
    </div>
  );
}

function ChannelMixBar({ channels }) {
  if (!channels.length) return null;
  const total = channels.reduce((s, c) => s + (c.leads || 0), 0) || 1;
  return (
    <div className="mt-4 pt-3 border-t border-hairline border-zinc-200">
      <div className="u-label text-ink-tertiary mb-2">Channel mix · first contact</div>
      <div className="flex h-2 rounded-sm overflow-hidden mb-2 bg-surface-sunken">
        {channels.map((c, i) => (
          <div
            key={c.channel}
            style={{ width: `${(c.leads / total) * 100}%`, background: CHART_SERIES[i % CHART_SERIES.length] }}
            title={`${c.channel}: ${c.leads} (${c.pctOfTotal}%)`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {channels.map((c, i) => (
          <span key={c.channel} className="flex items-center gap-1.5 text-12">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: CHART_SERIES[i % CHART_SERIES.length] }}
            />
            <span className="capitalize text-ink-secondary">{c.channel}</span>
            <span className="u-nums text-ink-tertiary">{c.pctOfTotal}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const SCORECARD_GRID =
  'grid-cols-[minmax(0,1fr)_3rem_3rem_3rem_3rem_3rem_4.25rem_3.75rem]';

// Source rows that don't map to a real lead_sources.name (synthetic fallbacks /
// calls-only buckets) can't be filtered in the Leads list, so they aren't
// drillable — gating on these avoids a click that lands on an empty list.
const DRILL_BLOCKED_SOURCE_TYPES = new Set(['unattributed', 'unmapped']);

export function AttributionScorecard({ callsBySource, leadsBySource, channelMix, loading, error, onDrillSource }) {
  const [sortKey, setSortKey] = useState('leads');
  const [sortDir, setSortDir] = useState('desc');
  const [showAll, setShowAll] = useState(false);

  if (loading) return <EmptyState>Loading…</EmptyState>;
  if (error) return <EmptyState>Failed to load attribution</EmptyState>;

  const rows = mergeAttributionRows(callsBySource?.sources || [], leadsBySource?.sources || []);
  if (!rows.length) return <EmptyState>No attribution data in this window</EmptyState>;

  // Ranked "where leads & revenue come from" bars: lead-bearing sources only,
  // most leads first, top 6. Winners (booked > 0) get a ★ + revenue call-out.
  const leadRows = rows.filter((r) => r.hasLeads && r.leads > 0).sort((a, b) => b.leads - a.leads);
  const topLeadRows = leadRows.slice(0, 6);
  const maxLeads = Math.max(...leadRows.map((r) => r.leads), 1);
  const shownCount = topLeadRows.length;

  const sorted = sortAttributionRows(rows, sortKey, sortDir);
  // The faint in-row bar tracks the sorted column (falls back to leads for the
  // name / conversion sorts), so visual weight always matches the ranking.
  const barKey = ['calls', 'uniqueCallers', 'leads', 'booked', 'revenue'].includes(sortKey) ? sortKey : 'leads';
  const barMax = Math.max(...sorted.map((r) => r[barKey] || 0), 1);

  const onSort = (key) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };
  const arrow = (key) => (key === sortKey ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '');
  const cell = (has, value) =>
    has ? value : <span className="text-ink-disabled">—</span>;

  // A row drills into the Leads list filtered by its source name (matching the
  // panel's name-based grouping). Only real, lead-bearing sources are clickable.
  const canDrill = (r) =>
    typeof onDrillSource === 'function'
    && !!r.sourceType
    && !DRILL_BLOCKED_SOURCE_TYPES.has(r.sourceType)
    && r.hasLeads;
  const drillProps = (r) =>
    canDrill(r)
      ? {
          role: 'button',
          tabIndex: 0,
          onClick: () => onDrillSource(r.name),
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onDrillSource(r.name);
            }
          },
          title: `View ${r.name} leads`,
        }
      : {};

  return (
    <div>
      <AttributionFunnel
        calls={callsBySource?.total_inbound_calls ?? null}
        leads={leadsBySource?.total_leads ?? null}
        booked={leadsBySource?.total_booked ?? null}
        leadsToBookedPct={leadsBySource?.overall_conversion_pct ?? null}
        revenue={leadsBySource?.total_revenue ?? null}
      />

      <div className="u-label text-ink-tertiary mb-2">Where leads &amp; revenue come from</div>
      <div className="flex flex-col gap-2">
        {topLeadRows.map((r, i) => {
          const won = r.booked > 0;
          const drill = canDrill(r);
          return (
            <div
              key={`${r.name}-${i}`}
              {...drillProps(r)}
              className={cn(
                'flex items-center gap-2 sm:gap-3',
                drill
                  && 'cursor-pointer rounded-xs -mx-1 px-1 py-0.5 hover:bg-surface-sunken focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400',
              )}
            >
              {/* Narrower name column on phones so the bar + revenue still fit;
                  the bar keeps a min width and the revenue column is content-sized
                  on mobile (sm:w-24 aligns desktop) so neither collapses or clips. */}
              <div className="flex items-center gap-1.5 min-w-0 w-28 sm:w-40 shrink-0">
                <span className="truncate text-12 text-ink-secondary">{r.name}</span>
                <ChannelChip channel={r.channel} />
              </div>
              <div className="relative flex-1 min-w-[16px] h-4 rounded-xs overflow-hidden bg-surface-sunken">
                <div
                  className="absolute inset-y-0 left-0 rounded-xs"
                  style={{ width: `${(r.leads / maxLeads) * 100}%`, background: CHART_PRIMARY }}
                />
              </div>
              <span className="u-nums text-12 text-ink-primary w-7 shrink-0 text-right">{fmtInt(r.leads)}</span>
              <span className="u-nums text-12 shrink-0 text-right whitespace-nowrap sm:w-24">
                {won ? (
                  <>
                    <span className="font-medium" style={{ color: CHART_SUCCESS }}>★{r.booked}</span>
                    {r.hasRevenue && (
                      <span className="text-ink-secondary ml-1.5">{fmtMoneyCompact(r.revenue)}</span>
                    )}
                  </>
                ) : (
                  <span className="text-ink-disabled">·</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {rows.length > shownCount && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 text-12 text-ink-tertiary hover:text-ink-secondary"
        >
          {showAll
            ? 'Hide source detail ▴'
            : `▸ ${rows.length - shownCount} more sources · Show all`}
        </button>
      )}

      {showAll && (
        <div className="overflow-x-auto mt-3 pt-3 border-t border-hairline border-zinc-200">
          <div className="min-w-[600px]">
            <div className={cn('grid gap-x-2 pb-2 text-ink-tertiary', SCORECARD_GRID)}>
              <button type="button" onClick={() => onSort('name')} className="u-label text-left hover:text-ink-secondary">
                Source{arrow('name')}
              </button>
              {SCORECARD_COLUMNS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => onSort(c.key)}
                  className="u-label text-right hover:text-ink-secondary whitespace-nowrap"
                >
                  {c.label}
                  {arrow(c.key)}
                </button>
              ))}
            </div>
            {sorted.map((r, i) => {
              const unmapped = r.sourceType === 'unmapped';
              const dormant = r.isActive === false;
              const lowConv = r.conversionPct != null && r.conversionPct < 20 && r.leads >= 5;
              const barPct = ((r[barKey] || 0) / barMax) * 100;
              return (
                <div
                  key={`${r.name}-${i}`}
                  {...drillProps(r)}
                  className={cn(
                    'relative grid gap-x-2 items-center py-1.5 text-12 border-t border-hairline border-zinc-100',
                    canDrill(r)
                      && 'cursor-pointer hover:bg-surface-sunken focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400',
                    SCORECARD_GRID,
                  )}
                >
                  <div
                    className="absolute inset-y-0.5 left-0 rounded-xs pointer-events-none"
                    style={{ width: `${barPct}%`, background: CHART_PRIMARY, opacity: 0.08 }}
                  />
                  <div className={cn('relative flex items-center gap-2 min-w-0', dormant && 'text-ink-tertiary')}>
                    <span className="truncate">{r.name}</span>
                    <ChannelChip channel={r.channel} />
                    {unmapped && (
                      <span className="text-[10px] uppercase tracking-label text-alert-fg shrink-0">unmapped</span>
                    )}
                  </div>
                  <span className="relative text-right u-nums">{cell(r.hasCalls, r.calls)}</span>
                  <span className="relative text-right u-nums text-ink-tertiary">{cell(r.hasCalls, r.uniqueCallers)}</span>
                  <span className="relative text-right u-nums">{cell(r.hasLeads, r.leads)}</span>
                  <span className="relative text-right u-nums text-ink-secondary">{cell(r.hasLeads, r.booked)}</span>
                  <span className={cn('relative text-right u-nums', lowConv ? 'text-alert-fg font-medium' : 'text-ink-tertiary')}>
                    {r.conversionPct != null ? `${r.conversionPct}%` : <span className="text-ink-disabled">—</span>}
                  </span>
                  <span className="relative text-right u-nums">
                    {r.hasRevenue ? fmtMoneyCompact(r.revenue) : <span className="text-ink-disabled">—</span>}
                  </span>
                  <span className="relative text-right u-nums text-ink-tertiary">
                    {r.roi == null ? (
                      <span className="text-ink-disabled">—</span>
                    ) : r.revenue > 0 && (r.cost == null || r.cost === 0) ? (
                      // Revenue with no cost (e.g. a free GBP listing) → ROI is
                      // infinite; "∞" reads cleaner than the 9999 sentinel.
                      '∞'
                    ) : (
                      `${Math.round(r.roi).toLocaleString()}%`
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ChannelMixBar channels={channelMix?.channels || []} />
    </div>
  );
}

