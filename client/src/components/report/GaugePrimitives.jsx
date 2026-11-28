import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus, Sparkles } from 'lucide-react';

/**
 * Shared gauge primitives for customer-facing score cards — pure SVG + CSS
 * implementation (replaces Recharts so customer report bundles stay fast and
 * lightweight while animating smoothly on scroll).
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

const CHART_W = 560;
const CHART_H = 180;
const CHART_PAD = { top: 14, right: 18, bottom: 30, left: 28 };
const PLOT_W = CHART_W - CHART_PAD.left - CHART_PAD.right;
const PLOT_H = CHART_H - CHART_PAD.top - CHART_PAD.bottom;
const Y_TICKS = [1, 2, 3, 4, 5];

function formatAxisMonthYear(t) {
  const date = new Date(t);
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  return `${month} '${String(date.getFullYear()).slice(-2)}`;
}

function selectVisibleTickIndices(coords) {
  if (coords.length <= 2) return coords.map((_, i) => i);
  const minGap = 72;
  const chosen = [0];
  const lastIdx = coords.length - 1;
  for (let i = 1; i < lastIdx; i += 1) {
    const prevX = coords[chosen[chosen.length - 1]].x;
    const distToLast = coords[lastIdx].x - coords[i].x;
    if (coords[i].x - prevX >= minGap && distToLast >= minGap) {
      chosen.push(i);
    }
  }
  if (coords[lastIdx].x - coords[chosen[chosen.length - 1]].x >= 36) {
    chosen.push(lastIdx);
  } else if (chosen.length > 1) {
    chosen[chosen.length - 1] = lastIdx;
  }
  return chosen;
}

function buildHistoryChartGeometry(points) {
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const spanT = maxT - minT;
  const lastIndex = Math.max(points.length - 1, 1);

  const coords = points.map((p, index) => {
    const xRatio = spanT > 0 ? (p.t - minT) / spanT : index / lastIndex;
    const clampedScore = Math.max(0, Math.min(MAX_SCORE, p.score));
    const x = Math.round((CHART_PAD.left + xRatio * PLOT_W) * 10) / 10;
    const y = Math.round((CHART_PAD.top + (1 - clampedScore / MAX_SCORE) * PLOT_H) * 10) / 10;
    return { x, y, t: p.t, score: p.score, label: formatAxisMonthYear(p.t) };
  });

  const linePath = coords.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ');
  const baselineY = CHART_PAD.top + PLOT_H;
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${baselineY} L ${coords[0].x} ${baselineY} Z`;
  const tickIndices = selectVisibleTickIndices(coords);

  return { coords, linePath, areaPath, tickIndices, baselineY };
}

function useChartInView(ref) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (entered) return undefined;
    if (typeof window !== 'undefined' && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setEntered(true);
        obs.disconnect();
      }
    }, { threshold: 0.25 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [entered, ref]);
  return entered;
}

export function PressureHistoryChart({ history, cadence }) {
  const containerRef = useRef(null);
  const entered = useChartInView(containerRef);
  const gradId = `wavesHistGrad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const points = useMemo(() => (
    (history || [])
      .map((row) => {
        const t = Date.parse(`${row.serviceDate}T12:00:00`);
        const score = Number(row.score);
        // Number(null) === 0 — a null-score history row must drop, not chart
        // as a false 0 dip (audit 2026-07-16)
        return Number.isFinite(t) && row.score != null && Number.isFinite(score) ? { t, score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t)
  ), [history]);

  const geometry = useMemo(() => (points.length >= 2 ? buildHistoryChartGeometry(points) : null), [points]);

  if (!geometry) return null;

  const cadenceWord = CADENCE_LABELS[cadence] || '';
  const subtitle = cadenceWord
    ? `Last ${points.length} ${cadenceWord} visit${points.length === 1 ? '' : 's'}`
    : `Last ${points.length} visits`;
  const firstPt = points[0];
  const lastPt = points[points.length - 1];
  const chartAriaLabel = `Score history across ${points.length} visits from ${firstPt.score.toFixed(1)} to ${lastPt.score.toFixed(1)} out of ${MAX_SCORE}.`;

  return (
    <div ref={containerRef} style={{ marginTop: 18 }}>
      <style>{`
        @keyframes wavesHistLineDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
        @keyframes wavesHistFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .waves-hist-line--live { stroke-dasharray: 1; stroke-dashoffset: 0; animation: wavesHistLineDraw 0.9s cubic-bezier(.16,1,.3,1) both; }
        .waves-hist-area--live { animation: wavesHistFadeIn 0.8s ease-out 0.15s both; }
        .waves-hist-dot--live { animation: wavesHistFadeIn 0.45s ease-out 0.45s both; }
        @media (prefers-reduced-motion: reduce), print {
          .waves-hist-line--live, .waves-hist-area--live, .waves-hist-dot--live {
            animation: none !important;
            stroke-dasharray: none !important;
            stroke-dashoffset: 0 !important;
            opacity: 1 !important;
          }
        }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div style={{ fontSize: 14, letterSpacing: '0.06em', textTransform: 'uppercase', color: CUSTOMER_SURFACE.muted, fontWeight: 700 }}>
          Score history
        </div>
        <div style={{ fontSize: 14, color: CUSTOMER_SURFACE.muted }}>{subtitle}</div>
      </div>
      <div style={{
        width: '100%', padding: '8px 6px 4px', boxSizing: 'border-box',
        background: '#F7F5EE', border: '1px solid #E7E2D7', borderRadius: 12,
      }}>
        <svg
          role="img"
          aria-label={chartAriaLabel}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#04395E" stopOpacity="0.14" />
              <stop offset="100%" stopColor="#04395E" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {Y_TICKS.map((tick) => {
            const y = Math.round((CHART_PAD.top + (1 - tick / MAX_SCORE) * PLOT_H) * 10) / 10;
            return (
              <g key={tick}>
                <line
                  x1={CHART_PAD.left}
                  x2={CHART_W - CHART_PAD.right}
                  y1={y}
                  y2={y}
                  stroke="#E7E2D7"
                  strokeDasharray="2 4"
                />
                <text
                  x={CHART_PAD.left - 8}
                  y={y + 5}
                  textAnchor="end"
                  fontSize="14"
                  fill={CUSTOMER_SURFACE.muted}
                  style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
                >
                  {tick}
                </text>
              </g>
            );
          })}
          <path
            d={geometry.areaPath}
            fill={`url(#${gradId})`}
            className={entered ? 'waves-hist-area--live' : undefined}
          />
          <path
            d={geometry.linePath}
            fill="none"
            stroke="#04395E"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            className={entered ? 'waves-hist-line--live' : undefined}
          />
          {geometry.coords.map((pt, index) => (
            <circle
              key={`${pt.t}-${index}`}
              cx={pt.x}
              cy={pt.y}
              r="4.5"
              fill="#FFFFFF"
              stroke="#04395E"
              strokeWidth="2"
              className={entered ? 'waves-hist-dot--live' : undefined}
            />
          ))}
          {geometry.tickIndices.map((idx, pos) => {
            const pt = geometry.coords[idx];
            const anchor = pos === 0 ? 'start' : pos === geometry.tickIndices.length - 1 ? 'end' : 'middle';
            return (
              <text
                key={`${pt.t}-tick-${idx}`}
                x={pt.x}
                y={CHART_H - 6}
                textAnchor={anchor}
                fontSize="14"
                fill={CUSTOMER_SURFACE.muted}
                style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
              >
                {pt.label}
              </text>
            );
          })}
        </svg>
      </div>
      {cadenceWord ? (
        <div style={{ marginTop: 8, fontSize: 14, color: CUSTOMER_SURFACE.muted, lineHeight: 1.45 }}>
          X-axis spacing reflects this customer's service cadence — {cadenceWord}.
        </div>
      ) : null}
    </div>
  );
}

export function MeterSvg({ score, label, noun = 'Pest Pressure' }) {
  // Treat '' and non-numeric the same as null: Number('') === 0 would render
  // a real 0 score, and NaN would emit invalid SVG attributes + an "NaN out
  // of 5" aria-label (audit 2026-07-16) — matching the V2 toScore() rule.
  const numeric = score !== null && score !== undefined && score !== '' && Number.isFinite(Number(score));
  const safeScore = numeric ? Math.max(0, Math.min(MAX_SCORE, Number(score))) : 0;
  const pct = (safeScore / MAX_SCORE) * 100;
  const labelName = label && label.name ? label.name : 'No score';
  const ariaLabel = !numeric
    ? `${noun} score not yet available.`
    : `${noun} ${safeScore.toFixed(1)} out of 5, labelled ${labelName}.`;

  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%' }}>
      <style>{`
        .waves-meter-fill { transition: width 0.6s cubic-bezier(.16,1,.3,1); }
        .waves-meter-thumb { transition: left 0.6s cubic-bezier(.16,1,.3,1); }
        @media (prefers-reduced-motion: reduce), print {
          .waves-meter-fill, .waves-meter-thumb { transition: none !important; }
        }
      `}</style>
      {/* Plain divs, not a preserveAspectRatio="none" SVG: stretching a fixed
          viewBox to the container width rendered the round marker as an
          ellipse. Percentage-positioned divs keep the thumb circular at any
          width. */}
      <div style={{ position: 'relative', width: '100%', height: 18 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 6, height: 6, borderRadius: 3, background: '#E5E7EB' }} />
        {numeric ? (
          <div className="waves-meter-fill" style={{ position: 'absolute', left: 0, top: 6, height: 6, borderRadius: 3, background: '#04395E', width: `max(2px, ${pct}%)` }} />
        ) : null}
        {[0, 50, 100].map((tickPct) => (
          <div
            key={tickPct}
            style={{
              position: 'absolute', top: 3, width: 2, height: 12, borderRadius: 1, background: '#94A3B8',
              left: `${tickPct}%`, transform: tickPct === 0 ? 'none' : tickPct === 100 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          />
        ))}
        {numeric ? (
          <div className="waves-meter-thumb" style={{
            position: 'absolute', top: '50%', left: `${pct}%`, transform: 'translate(-50%, -50%)',
            width: 12, height: 12, borderRadius: 999, background: '#FFFFFF',
            border: '2px solid #04395E', boxSizing: 'border-box',
          }} />
        ) : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 14, color: '#64748B', fontFamily: "'Inter', system-ui, sans-serif" }}>
        <span>0</span>
        <span>2.5</span>
        <span>5</span>
      </div>
    </div>
  );
}

export function TrendChip({ trend, delta }) {
  // an unknown/absent trend must not assert "Stable" — render nothing,
  // like the V2 TrendArrow (audit 2026-07-16)
  const meta = TREND_META[trend];
  if (!meta) return null;
  const tone = TONE_STYLES[meta.tone];
  const { Icon } = meta;
  const deltaText = trendDeltaText(trend, delta);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 999, background: tone.bg, color: tone.fg,
      fontSize: 14, fontWeight: 600, lineHeight: 1.2,
    }}>
      <Icon size={12} aria-hidden="true" />
      <span>{meta.label}{deltaText ? ` · ${deltaText}` : ''}</span>
    </span>
  );
}
