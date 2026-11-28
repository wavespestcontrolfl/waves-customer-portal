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

const PLOT_HEIGHT_PX = 128;
const Y_TICKS = [1, 2, 3, 4, 5];

function formatAxisMonthYear(t) {
  const date = new Date(t);
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  return `${month} '${String(date.getFullYear()).slice(-2)}`;
}

function selectVisibleTickIndices(coords) {
  if (coords.length <= 2) return coords.map((_, i) => i);
  // Percentage spacing (>= 24% apart) keeps 14px HTML date labels from
  // colliding even at a 280px mobile container width.
  const minPctGap = 24;
  const chosen = [0];
  const lastIdx = coords.length - 1;
  for (let i = 1; i < lastIdx; i += 1) {
    const prevX = coords[chosen[chosen.length - 1]].xPct;
    const distToLast = coords[lastIdx].xPct - coords[i].xPct;
    if (coords[i].xPct - prevX >= minPctGap && distToLast >= minPctGap) {
      chosen.push(i);
    }
  }
  if (coords[lastIdx].xPct - coords[chosen[chosen.length - 1]].xPct >= 16) {
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
    const yRatio = 1 - clampedScore / MAX_SCORE;
    const xPct = Math.round((4 + xRatio * 92) * 10) / 10;
    const yPct = Math.round((8 + yRatio * 84) * 10) / 10;
    return { xPct, yPct, t: p.t, score: p.score, label: formatAxisMonthYear(p.t) };
  });

  const linePath = coords.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.xPct} ${pt.yPct}`).join(' ');
  const baselineY = 92;
  const areaPath = `${linePath} L ${coords[coords.length - 1].xPct} ${baselineY} L ${coords[0].xPct} ${baselineY} Z`;
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
        @keyframes wavesHistReveal { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0% 0 0); } }
        @keyframes wavesHistFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .waves-hist-reveal--live { animation: wavesHistReveal 0.85s cubic-bezier(.16,1,.3,1) both; }
        .waves-hist-dot--live { animation: wavesHistFadeIn 0.45s ease-out 0.35s both; }
        @media (prefers-reduced-motion: reduce), print {
          .waves-hist-reveal--live, .waves-hist-dot--live {
            animation: none !important;
            clip-path: none !important;
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
      <div
        role="img"
        aria-label={chartAriaLabel}
        style={{
          width: '100%', padding: '10px 10px 8px', boxSizing: 'border-box',
          background: '#F7F5EE', border: '1px solid #E7E2D7', borderRadius: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
          {/* HTML axis labels keep a true >=14px size even on narrow 280px phones instead of scaling down with SVG viewBox */}
          <div aria-hidden="true" style={{ position: 'relative', width: 16, height: PLOT_HEIGHT_PX, flexShrink: 0 }}>
            {Y_TICKS.map((tick) => {
              const yPct = Math.round((8 + (1 - tick / MAX_SCORE) * 84) * 10) / 10;
              return (
                <span
                  key={tick}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: `${yPct}%`,
                    transform: 'translateY(-50%)',
                    fontSize: 14,
                    lineHeight: 1,
                    color: CUSTOMER_SURFACE.muted,
                    fontFamily: "'Inter', system-ui, sans-serif",
                  }}
                >
                  {tick}
                </span>
              );
            })}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ position: 'relative', width: '100%', height: PLOT_HEIGHT_PX }}>
              <svg
                aria-hidden="true"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
              >
                <defs>
                  <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#04395E" stopOpacity="0.14" />
                    <stop offset="100%" stopColor="#04395E" stopOpacity="0.01" />
                  </linearGradient>
                </defs>
                {Y_TICKS.map((tick) => {
                  const yPct = Math.round((8 + (1 - tick / MAX_SCORE) * 84) * 10) / 10;
                  return (
                    <line
                      key={tick}
                      x1="0"
                      x2="100"
                      y1={yPct}
                      y2={yPct}
                      stroke="#E7E2D7"
                      strokeDasharray="2 4"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
                <g className={entered ? 'waves-hist-reveal--live' : undefined}>
                  <path d={geometry.areaPath} fill={`url(#${gradId})`} />
                  <path
                    d={geometry.linePath}
                    fill="none"
                    stroke="#04395E"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              </svg>
              {geometry.coords.map((pt, index) => (
                <span
                  key={`${pt.t}-${index}`}
                  data-testid="history-point"
                  data-x={pt.xPct}
                  data-y={pt.yPct}
                  className={entered ? 'waves-hist-dot--live' : undefined}
                  style={{
                    position: 'absolute',
                    left: `${pt.xPct}%`,
                    top: `${pt.yPct}%`,
                    transform: 'translate(-50%, -50%)',
                    width: 9,
                    height: 9,
                    borderRadius: 999,
                    background: '#FFFFFF',
                    border: '2px solid #04395E',
                    boxSizing: 'border-box',
                    pointerEvents: 'none',
                  }}
                />
              ))}
            </div>
            <div aria-hidden="true" style={{ position: 'relative', height: 22, marginTop: 4 }}>
              {geometry.tickIndices.map((idx, pos) => {
                const pt = geometry.coords[idx];
                const tx = pos === 0 ? 'none' : pos === geometry.tickIndices.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)';
                return (
                  <span
                    key={`${pt.t}-tick-${idx}`}
                    style={{
                      position: 'absolute',
                      left: `${pt.xPct}%`,
                      top: 0,
                      transform: tx,
                      fontSize: 14,
                      lineHeight: 1.2,
                      whiteSpace: 'nowrap',
                      color: CUSTOMER_SURFACE.muted,
                      fontFamily: "'Inter', system-ui, sans-serif",
                    }}
                  >
                    {pt.label}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
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
