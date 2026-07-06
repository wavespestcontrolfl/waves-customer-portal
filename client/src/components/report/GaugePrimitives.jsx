import { useMemo } from 'react';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus, Sparkles } from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Shared gauge primitives for customer-facing score cards — extracted
 * unchanged from PestPressureCard so the typed-specialty ActivityCard can
 * render the same meter / history chart / trend chip UI under a different
 * label. PestPressureCard re-imports these; visual output is identical.
 */

export const MAX_SCORE = 5;

export const TREND_META = {
  first_marker: { label: 'First marker', Icon: Sparkles, tone: 'neutral' },
  improving: { label: 'Improving', Icon: ArrowDownRight, tone: 'good' },
  stable: { label: 'Stable', Icon: Minus, tone: 'neutral' },
  increasing: { label: 'Increasing', Icon: ArrowUpRight, tone: 'caution' },
  significant_increase: { label: 'Significant increase', Icon: ArrowUpRight, tone: 'warn' },
  insufficient_data: { label: 'Not enough data', Icon: ArrowRight, tone: 'neutral' },
};

export const TONE_STYLES = {
  good: { bg: '#E8F5E9', fg: '#1B5E20' },
  neutral: { bg: '#EEF2F7', fg: '#334155' },
  caution: { bg: '#FFF4E5', fg: '#7A4A00' },
  warn: { bg: '#FFE9E0', fg: '#7A2A0A' },
};

export function formatGaugeDate(value) {
  if (!value) return null;
  // Server sends YYYY-MM-DD; parse as ET-local to avoid timezone shifts
  // shaving a day off the visible date.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), 12);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function trendDeltaText(trend, delta) {
  if (delta === null || delta === undefined || trend === 'first_marker' || trend === 'insufficient_data') return null;
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return 'no change vs. last visit';
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)} vs. last visit`;
}

const CADENCE_LABELS = {
  quarterly: 'quarterly',
  bimonthly: 'bi-monthly',
  monthly: 'monthly',
};

export function PressureHistoryChart({ history, cadence }) {
  const points = useMemo(() => (
    (history || [])
      .map((row) => {
        const t = Date.parse(`${row.serviceDate}T12:00:00`);
        return Number.isFinite(t) ? { t, score: Number(row.score) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t)
  ), [history]);

  const tickValues = useMemo(() => points.map((p) => p.t), [points]);

  if (points.length < 2) return null;

  const cadenceWord = CADENCE_LABELS[cadence] || '';
  const subtitle = cadenceWord
    ? `Last ${points.length} ${cadenceWord} visit${points.length === 1 ? '' : 's'}`
    : `Last ${points.length} visits`;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: CUSTOMER_SURFACE.muted, fontWeight: 700 }}>
          Score history
        </div>
        <div style={{ fontSize: 12, color: CUSTOMER_SURFACE.muted }}>{subtitle}</div>
      </div>
      <div style={{
        width: '100%', height: 180, padding: 6, boxSizing: 'border-box',
        background: '#F7F5EE', border: '1px solid #E7E2D7', borderRadius: 12,
      }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="#E7E2D7" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={tickValues}
              tickFormatter={(t) => {
                const date = new Date(t);
                const month = date.toLocaleDateString('en-US', { month: 'short' });
                return `${month} '${String(date.getFullYear()).slice(-2)}`;
              }}
              tick={{ fontSize: 10, fill: CUSTOMER_SURFACE.muted, fontFamily: "'Inter', system-ui, sans-serif" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0, 5]}
              ticks={[1, 2, 3, 4, 5]}
              tick={{ fontSize: 10, fill: CUSTOMER_SURFACE.muted, fontFamily: "'Inter', system-ui, sans-serif" }}
              tickLine={false}
              axisLine={false}
              width={20}
            />
            <Area type="monotone" dataKey="score" stroke="none" fill="#0B3A66" fillOpacity={0.08} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="score"
              stroke="#0B3A66"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={{ r: 4, fill: '#FFFFFF', stroke: '#0B3A66', strokeWidth: 2 }}
              activeDot={{ r: 5, fill: '#FFFFFF', stroke: '#0B3A66', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {cadenceWord ? (
        <div style={{ marginTop: 8, fontSize: 12, color: CUSTOMER_SURFACE.muted, lineHeight: 1.45 }}>
          X-axis spacing reflects this customer's service cadence — {cadenceWord}.
        </div>
      ) : null}
    </div>
  );
}

export function MeterSvg({ score, label, noun = 'Pest Pressure' }) {
  const safeScore = score === null || score === undefined ? 0 : Math.max(0, Math.min(MAX_SCORE, Number(score)));
  const pct = (safeScore / MAX_SCORE) * 100;
  const labelName = label && label.name ? label.name : 'No score';
  const ariaLabel = score === null || score === undefined
    ? `${noun} score not yet available.`
    : `${noun} ${safeScore.toFixed(1)} out of 5, labelled ${labelName}.`;

  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%' }}>
      <svg viewBox="0 0 200 24" preserveAspectRatio="none" style={{ width: '100%', height: 18, display: 'block' }}>
        <rect x="0" y="9" width="200" height="6" rx="3" fill="#E5E7EB" />
        {score !== null && score !== undefined ? (
          <rect x="0" y="9" width={Math.max(2, (pct / 100) * 200)} height="6" rx="3" fill="#0B3A66" />
        ) : null}
        {[0, 50, 100].map((tickPct) => (
          <rect key={tickPct} x={tickPct === 100 ? 198 : tickPct === 0 ? 0 : (tickPct / 100) * 200 - 1} y="6" width="2" height="12" rx="1" fill="#94A3B8" />
        ))}
        {score !== null && score !== undefined ? (
          <circle cx={(pct / 100) * 200} cy="12" r="6" fill="#FFFFFF" stroke="#0B3A66" strokeWidth="2" />
        ) : null}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: '#64748B', fontFamily: "'Inter', system-ui, sans-serif" }}>
        <span>0</span>
        <span>2.5</span>
        <span>5</span>
      </div>
    </div>
  );
}

export function TrendChip({ trend, delta }) {
  const meta = TREND_META[trend] || TREND_META.stable;
  const tone = TONE_STYLES[meta.tone];
  const { Icon } = meta;
  const deltaText = trendDeltaText(trend, delta);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 999, background: tone.bg, color: tone.fg,
      fontSize: 12, fontWeight: 600, lineHeight: 1.2,
    }}>
      <Icon size={12} aria-hidden="true" />
      <span>{meta.label}{deltaText ? ` · ${deltaText}` : ''}</span>
    </span>
  );
}
