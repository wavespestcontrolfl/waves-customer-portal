import { useMemo } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus, Sparkles } from 'lucide-react';

/**
 * Customer-facing Pest Pressure card.
 *
 * Data comes from the report API's `pestPressure` field (built by
 * server/services/pest-pressure/customer-view.js). When the field is
 * null (feature disabled or showOnCustomerReport is false), the card
 * renders nothing. When dataCompleteness is "insufficient", it shows
 * a polite placeholder instead of a misleading number.
 *
 * Accessibility:
 * - The meter is an SVG with role="img" + an aria-label that includes
 *   the numeric score, label, and trend so screen readers don't depend
 *   on visual position.
 * - The numeric score and label are always rendered as text — color
 *   never carries information alone.
 * - The trend chip uses an icon + word, not color alone.
 */

const MAX_SCORE = 5;

const TREND_META = {
  first_marker: { label: 'First marker', Icon: Sparkles, tone: 'neutral' },
  improving: { label: 'Improving', Icon: ArrowDownRight, tone: 'good' },
  stable: { label: 'Stable', Icon: Minus, tone: 'neutral' },
  increasing: { label: 'Increasing', Icon: ArrowUpRight, tone: 'caution' },
  significant_increase: { label: 'Significant increase', Icon: ArrowUpRight, tone: 'warn' },
  insufficient_data: { label: 'Not enough data', Icon: ArrowRight, tone: 'neutral' },
};

const TONE_STYLES = {
  good: { bg: '#E8F5E9', fg: '#1B5E20' },
  neutral: { bg: '#EEF2F7', fg: '#334155' },
  caution: { bg: '#FFF4E5', fg: '#7A4A00' },
  warn: { bg: '#FFE9E0', fg: '#7A2A0A' },
};

function formatDate(value) {
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

function MeterSvg({ score, label }) {
  const safeScore = score === null || score === undefined ? 0 : Math.max(0, Math.min(MAX_SCORE, Number(score)));
  const pct = (safeScore / MAX_SCORE) * 100;
  const labelName = label && label.name ? label.name : 'No score';
  const ariaLabel = score === null || score === undefined
    ? 'Pest Pressure score not yet available.'
    : `Pest Pressure ${safeScore.toFixed(1)} out of 5, labelled ${labelName}.`;

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

function TrendChip({ trend, delta }) {
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

function ComponentsTable({ components }) {
  if (!components || typeof components !== 'object') return null;
  const labelByKey = {
    clientRating: 'Client-reported activity',
    technicianRating: 'Technician observations',
    reServiceImpact: 'Re-services / callbacks',
    recurringIssueRating: 'Recurring issue areas',
    riskFactorRating: 'Risk factors / conditions',
  };
  const rows = Object.entries(components).map(([key, c]) => ({
    key,
    label: labelByKey[key] || key,
    value: c && c.present ? Number(c.value) : null,
    weight: c ? Number(c.weight) : 0,
  }));
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <thead>
        <tr style={{ textAlign: 'left', color: '#64748B', fontWeight: 600 }}>
          <th style={{ padding: '6px 4px', borderBottom: '1px solid #E5E7EB' }}>Component</th>
          <th style={{ padding: '6px 4px', borderBottom: '1px solid #E5E7EB', textAlign: 'right' }}>Rating</th>
          <th style={{ padding: '6px 4px', borderBottom: '1px solid #E5E7EB', textAlign: 'right' }}>Weight</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} style={{ borderBottom: '1px solid #F1F5F9' }}>
            <td style={{ padding: '6px 4px', color: '#1B2C5B' }}>{row.label}</td>
            <td style={{ padding: '6px 4px', textAlign: 'right', color: row.value === null ? '#94A3B8' : '#1B2C5B', fontFamily: "'JetBrains Mono', monospace" }}>
              {row.value === null ? '—' : row.value.toFixed(1)}
            </td>
            <td style={{ padding: '6px 4px', textAlign: 'right', color: '#64748B', fontFamily: "'JetBrains Mono', monospace" }}>
              {row.weight}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PestPressureCard({ data }) {
  // Pre-compute date once (avoid recompute on hover/expand).
  const dateText = useMemo(() => formatDate(data && data.date), [data]);

  if (!data) return null;
  if (data.enabled === false || data.showOnCustomerReport === false) return null;

  const isInsufficient = data.dataCompleteness === 'insufficient' || data.score === null || data.score === undefined;
  const scoreNum = isInsufficient ? null : Number(data.score);
  const labelName = data.label || (data.labelKey ? data.labelKey.replace('_', ' ') : null);

  return (
    <section
      id="pest-pressure"
      data-section="pest-pressure"
      style={{
        background: '#FFFFFF',
        border: '1px solid #E7E2D7',
        borderRadius: 14,
        padding: 24,
        margin: '0 0 16px',
        fontFamily: "'Inter', system-ui, sans-serif",
        color: '#1B2C5B',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7280', fontWeight: 600 }}>
            Pest Pressure
          </div>
          <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 700, color: '#1B2C5B' }}>
            {isInsufficient ? 'Score not yet available' : `${labelName || 'Score'} — ${scoreNum.toFixed(1)} / ${MAX_SCORE}`}
          </h2>
          {dateText ? (
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>As of {dateText}</div>
          ) : null}
        </div>
        <TrendChip trend={data.trend} delta={data.trendDelta} />
      </header>

      {!isInsufficient ? (
        <div style={{ marginBottom: 16 }}>
          <MeterSvg score={scoreNum} label={{ name: labelName }} />
        </div>
      ) : null}

      {data.summary ? (
        <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.55, color: '#3F4A65' }}>
          {data.summary}
        </p>
      ) : null}

      {data.showComponentBreakdown && data.components ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#0B3A66', fontWeight: 600 }}>
            Component breakdown
          </summary>
          <ComponentsTable components={data.components} />
        </details>
      ) : null}

      {data.howCalculated ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#0B3A66', fontWeight: 600 }}>
            How we calculate Pest Pressure
          </summary>
          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: '#3F4A65', whiteSpace: 'pre-line' }}>
            {data.howCalculated}
          </div>
        </details>
      ) : null}
    </section>
  );
}
