// Mosquito Report V2 — customer-facing, yard-usability visual layer.
//
// Presentational components ONLY, driven by the `mosquitoReportV2` payload key
// (server/services/service-report/mosquito-report-v2.js). Lightweight inline
// CSS/SVG, customer-surface warm tokens (NOT admin monochrome) — mirrors the
// pest V2 layer's visual language (same card geometry, status tones, and the
// branded ripple "waves" motif) with mosquito semantics: the rings read as the
// treatment drifting across the YARD, and the nodes are breeding/harborage
// habitats (standing water, foliage, lanai, gutters) instead of entry points.
//
// Honest-copy: habitat items come from documented findings only, and the
// section renders nothing when its payload is absent (flag off / not a
// mosquito visit).

import { useState, useEffect, useId, useRef } from 'react';
import { COLORS, FONTS } from '../../../theme-brand';
import { CUSTOMER_SURFACE } from '../../../theme-customer';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ── Surface tokens (shared with the pest / lawn V2 surface) ─────────────────────
const TEXT = 'var(--text)';
const BODY = 'var(--text)';
const MUTED = 'var(--muted)';
const BORDER = CUSTOMER_SURFACE.border;
const CARD = COLORS.white;

// Status tone → accent + soft wash (same triad as pest V2 — one family).
const TONE = {
  good: { color: COLORS.green, wash: 'rgba(22, 163, 74, 0.08)', border: 'rgba(22, 163, 74, 0.35)' },
  watch: { color: COLORS.orange, wash: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.38)' },
  attention: { color: COLORS.red, wash: 'rgba(200, 16, 46, 0.06)', border: 'rgba(200, 16, 46, 0.3)' },
};
function tone(key) { return TONE[key] || TONE.watch; }

// Habitat node status → color + word. active = treatment applied / clear = no
// breeding condition found (both reassuring green); watched = documented today.
const NODE_COLOR = { active: COLORS.green, clear: COLORS.green, watched: COLORS.orange };
const NODE_WORD = { active: 'Treated', clear: 'Clear', watched: 'Watching' };

// Fixed positions for the habitat spots around the yard diagram.
const NODE_POS = {
  standing_water: { x: 84, y: 168, label: 'Standing water', dy: 15 },
  foliage: { x: 248, y: 160, label: 'Dense foliage', dy: 15 },
  lanai_patio: { x: 236, y: 78, label: 'Lanai & patio', dy: -8 },
  drainage: { x: 92, y: 72, label: 'Gutters & drains', dy: -8 },
};

// Flips true once the element scrolls into view so the ripple entrance plays
// when the customer actually sees it (same rationale as the pest map).
function useInViewOnce(threshold = 0.3) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setInView(true); return undefined; }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setInView(true); return undefined; }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setInView(true); obs.disconnect(); }
    }, { threshold });
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, inView];
}

// Geometry matches the report's .sr-section cards (24px padding, 20px rhythm).
const card = {
  background: CARD,
  border: `1px solid ${BORDER}`,
  borderRadius: 16,
  padding: '24px 24px',
  marginBottom: 20,
};
const eyebrow = {
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: MUTED,
  fontWeight: 700,
  marginBottom: 8,
};

// Trend arrow across the two vocabularies this dashboard receives: the
// seasonal forecast emits up/down/flat, while Pest Pressure trends
// (pest-pressure/trend.js) emit improving / increasing /
// significant_increase / stable / first_marker / insufficient_data (codex
// P2 — the old up/down-only check rendered a worsening "increasing" trend
// as a green down arrow). Directional reads: UP = more mosquitoes (red),
// DOWN = fewer (green); non-directional states render nothing.
const TREND_UP = new Set(['up', 'worsening', 'increasing', 'significant_increase']);
const TREND_DOWN = new Set(['down', 'improving', 'decreasing', 'significant_decrease']);
function TrendArrow({ trend }) {
  const up = TREND_UP.has(trend);
  if (!up && !TREND_DOWN.has(trend)) return null;
  return (
    <span style={{ color: up ? COLORS.red : COLORS.green, fontSize: 11, marginLeft: 4 }}>
      {up ? '▲' : '▼'}
    </span>
  );
}

// ── Hero: protection status first ───────────────────────────────────────────────
export function MosquitoStatusHero({ status, statusSummary, supportingMetric, aiSummary, token = null, mode = 'live' }) {
  // The rating POST returns a recalculated pestPressure (possibly turning an
  // insufficient reading into a real score) — hold the displayed metric in
  // state so a successful submit can refresh it without a full reload
  // (codex P2; the standalone PestPressureCard that used to own this is
  // suppressed when the dashboard renders).
  const [metric, setMetric] = useState(supportingMetric);
  useEffect(() => { setMetric(supportingMetric); }, [supportingMetric]);
  if (!status) return null;
  const t = tone(status.tone);
  const refreshFromPestPressure = (pestPressure) => {
    if (!pestPressure) return;
    const score = pestPressure.displayScore ?? pestPressure.score;
    if (score == null) return;
    setMetric((prev) => ({
      ...(prev || { kind: 'pressure', caption: 'Mosquito pressure', rating: null, submittedRating: null }),
      kind: 'pressure',
      score: String(score),
      max: pestPressure.maxScore || 5,
      label: pestPressure.label || null,
      trend: pestPressure.trend || null,
    }));
  };
  return (
    <section data-glass="card" style={{ ...card, background: t.wash, border: `1px solid ${t.border}` }}>
      <div data-gt="eyebrow" style={eyebrow}>Today’s mosquito protection</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: t.color, flexShrink: 0, boxShadow: `0 0 0 4px ${t.color}22` }} />
        <h2 style={{ fontFamily: FONTS.serif, fontWeight: 500, fontSize: 25, color: TEXT, margin: 0 }}>{status.label}</h2>
      </div>
      {statusSummary ? (
        <p style={{ fontSize: 15, color: BODY, lineHeight: 1.5, margin: '10px 0 0' }}>{statusSummary}</p>
      ) : null}
      {/* The score pill hides when the reading is still insufficient (score
          null) — the metric may then exist solely to carry the rating picker. */}
      {metric && (metric.score != null || metric.label)
        ? <SupportingMetric metric={metric} />
        : null}
      <MosquitoPressureRating
        metric={supportingMetric}
        token={token}
        live={mode === 'live'}
        onRefreshed={refreshFromPestPressure}
      />
      {aiSummary?.body ? (
        <p style={{ fontSize: 14, color: MUTED, lineHeight: 1.5, margin: '12px 0 0' }}>{aiSummary.body}</p>
      ) : null}
    </section>
  );
}

function SupportingMetric({ metric }) {
  const value = metric.score != null ? metric.score : (metric.label || '—');
  const showOutOf = metric.score != null && metric.max;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 8,
      marginTop: 14, padding: '8px 14px', background: CARD,
      border: `1px solid ${BORDER}`, borderRadius: 999,
    }}>
      <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{metric.caption}</span>
      <span style={{ fontFamily: FONTS.body, fontWeight: 700, fontSize: 18, color: TEXT }}>{value}</span>
      {showOutOf ? <span style={{ fontSize: 12, color: MUTED }}>/ {metric.max}</span> : null}
      {metric.label && metric.score != null ? <span style={{ fontSize: 12, color: MUTED }}>· {metric.label}</span> : null}
      <TrendArrow trend={metric.trend} />
    </div>
  );
}

// One-shot customer calibration — same token route the pest hero uses; the
// server only offers `rating` when this line's pressure tracking allows it.
function MosquitoPressureRating({ metric, token, live, onRefreshed }) {
  const [submitted, setSubmitted] = useState(Boolean(metric && metric.submittedRating != null));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Client-side navigation to another /report/:token reuses this mounted
  // component — re-derive the one-shot state from the new report's payload so
  // a rating submitted on the previous report doesn't hide this one's picker
  // (codex P2, matches the legacy PestPressureCard's token reset).
  useEffect(() => {
    setSubmitted(Boolean(metric && metric.submittedRating != null));
    setBusy(false);
    setFailed(false);
  }, [token, metric && metric.submittedRating]);
  if (!metric || metric.kind !== 'pressure') return null;
  if (submitted) {
    return <div style={{ marginTop: 12, fontSize: 14, color: COLORS.green, fontWeight: 600 }}>Thanks — your input helps us calibrate your protection plan.</div>;
  }
  if (!metric.rating || !token || !live) return null;
  const submit = async (n) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`${API_BASE}/reports/${token}/pest-pressure/client-rating`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: n }),
      });
      if (res.ok || res.status === 409) {
        setSubmitted(true);
        // The route recalculates the score with the new signal and returns
        // the updated pestPressure — surface it (legacy card parity).
        if (res.ok && onRefreshed) {
          const body = await res.json().catch(() => null);
          if (body?.pestPressure) onRefreshed(body.pestPressure);
        }
      } else setFailed(true);
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 14, padding: '12px 14px', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: TEXT, marginBottom: 8 }}>{metric.rating.question}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" disabled={busy} onClick={() => submit(n)} aria-label={`Rating ${n} of 5`}
            style={{ padding: '10px 0', borderRadius: 9, border: `1px solid ${BORDER}`, background: COLORS.white, color: TEXT, fontWeight: 700, fontSize: 15, cursor: busy ? 'wait' : 'pointer' }}>{n}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>0 = none · 5 = a lot</div>
      {failed && (
        <div style={{ fontSize: 12, color: '#991B1B', marginTop: 8 }}>
          Couldn&rsquo;t save your rating — please tap a number to try again.
        </div>
      )}
    </div>
  );
}

// ── "Waves across the yard" — the where-we-treated centerpiece ───────────────────
// The same branded ripple language as the pest map, reframed for a yard-wide
// service: rings = the treatment drifting outward across the yard (solid when a
// yard application was logged today, dashed when it wasn't), nodes = the habitat
// spots that can support mosquito breeding/resting. Static / pdf / print /
// reduced-motion paths render the finished frame with zero animation.
export function MosquitoHabitatMap({ habitat, print = false }) {
  const [sectionRef, inView] = useInViewOnce();
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!habitat?.items?.length) return null;
  const items = habitat.items;
  const treatment = items.find((i) => i.key === 'yard_treatment');
  const treated = treatment ? treatment.status === 'active' : false;
  const nodes = items.filter((i) => i.key !== 'yard_treatment');
  const placed = nodes.map((node, idx) => {
    const pos = NODE_POS[node.key];
    if (pos) return { ...node, ...pos };
    const angle = (Math.PI * 2 * idx) / Math.max(nodes.length, 1) - Math.PI / 2;
    return { ...node, x: 160 + Math.cos(angle) * 96, y: 120 + Math.sin(angle) * 66, label: node.label, dy: 15 };
  });
  const ringColor = '#0A7EC2';
  const rings = [
    { rx: 48, ry: 34, o: 0.85 }, { rx: 84, ry: 58, o: 0.5 },
    { rx: 120, ry: 82, o: 0.3 }, { rx: 150, ry: 100, o: 0.16 },
  ];
  const ringDelay = (i) => 0.15 + i * 0.22;
  const nodeDelay = (i) => 1.2 + i * 0.16;

  return (
    <section data-glass="card" style={card} ref={sectionRef} className={print ? undefined : (inView ? 'mosq-live' : 'mosq-await')}>
      <style>{`
        .mosq-ring, .mosq-ring-field { transform-box: view-box; transform-origin: 160px 120px; }
        .mosq-node-dot, .mosq-node-halo, .mosq-node-pulse { transform-box: fill-box; transform-origin: center; }
        @keyframes mosqRingRipple {
          from { opacity: 0; transform: scale(0.55); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes mosqGlowIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes mosqNodePop {
          0% { opacity: 0; transform: scale(0); }
          60% { opacity: 1; transform: scale(1.18); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes mosqNodeFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes mosqHaloPulse {
          0%, 100% { opacity: 0; transform: scale(1); }
          50% { opacity: 0.22; transform: scale(1.3); }
        }
        @keyframes mosqLegendIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .mosq-await .mosq-seal-glow, .mosq-await .mosq-ring-field,
        .mosq-await .mosq-node, .mosq-await .mosq-legend-row { opacity: 0; }
        .mosq-live .mosq-ring { animation: mosqRingRipple 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
        .mosq-live .mosq-seal-glow { animation: mosqGlowIn 0.6s ease-out both; }
        .mosq-live .mosq-node .mosq-node-dot { animation: mosqNodePop 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both; animation-delay: inherit; }
        .mosq-live .mosq-node .mosq-node-halo, .mosq-live .mosq-node text { animation: mosqNodeFade 0.5s ease-out both; animation-delay: inherit; }
        .mosq-live .mosq-node-pulse { animation: mosqHaloPulse 2.4s ease-in-out infinite; }
        .mosq-live .mosq-legend-row { animation: mosqLegendIn 0.5s ease-out both; }
        @media (print), (prefers-reduced-motion: reduce) {
          .mosq-live .mosq-ring, .mosq-live .mosq-seal-glow, .mosq-live .mosq-node .mosq-node-dot,
          .mosq-live .mosq-node .mosq-node-halo, .mosq-live .mosq-node-pulse, .mosq-live .mosq-node text,
          .mosq-live .mosq-legend-row { animation: none !important; }
          .mosq-await .mosq-seal-glow, .mosq-await .mosq-ring-field,
          .mosq-await .mosq-node, .mosq-await .mosq-legend-row { opacity: 1 !important; }
        }
      `}</style>
      <div data-gt="eyebrow" style={eyebrow}>Where we protected</div>
      <h3 style={{ fontFamily: FONTS.serif, fontWeight: 500, fontSize: 18, color: TEXT, margin: '0 0 2px' }}>
        {treated ? 'Today’s treatment is working across your yard' : 'We’re watching the spots mosquitoes use'}
      </h3>
      {habitat.summary ? <p style={{ fontSize: 14, color: MUTED, margin: '0 0 6px' }}>{habitat.summary}</p> : null}

      <div style={{ width: '100%', maxWidth: 360, margin: '0 auto' }}>
        <svg viewBox="0 0 320 232" width="100%" role="img" aria-label="Diagram of mosquito treatment coverage across your yard" style={{ display: 'block' }}>
          <defs>
            <linearGradient id={`mosqRing-${gradId}`} gradientUnits="userSpaceOnUse" x1="40" y1="10" x2="290" y2="225">
              <stop offset="0%" stopColor="#AFE1FF" />
              <stop offset="45%" stopColor="#38AAE1" />
              <stop offset="78%" stopColor="#0A7EC2" />
              <stop offset="100%" stopColor="#FFBE78" />
            </linearGradient>
            <radialGradient id={`mosqGlow-${gradId}`} cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" stopColor="#7CC7F0" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#7CC7F0" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* soft glow under the home — the origin the treatment ripples from */}
          <ellipse cx="160" cy="120" rx="52" ry="36" fill={`url(#mosqGlow-${gradId})`} className="mosq-seal-glow" />

          <g className="mosq-ring-field">
            {rings.map((r, i) => {
              const dim = treated ? 1 : 0.6;
              return (
                <g key={i} className="mosq-ring" style={{ animationDelay: `${ringDelay(i)}s` }}>
                  <ellipse
                    cx="160" cy="120" rx={r.rx} ry={r.ry} fill="none"
                    stroke={`url(#mosqRing-${gradId})`}
                    strokeOpacity={r.o * dim}
                    strokeWidth={2.4}
                    strokeDasharray={treated ? undefined : '4 5'}
                  />
                </g>
              );
            })}
          </g>

          {/* home */}
          <polygon points="160,84 134,106 186,106" fill={COLORS.glassNavy} />
          <rect x="138" y="106" width="44" height="30" rx="3" fill={COLORS.glassNavy} />
          <rect x="155" y="118" width="10" height="18" rx="1.5" fill={COLORS.white} />

          {/* habitat nodes — bloom on with a soft status glow */}
          {placed.map((n, i) => {
            const color = NODE_COLOR[n.status] || COLORS.grayMid;
            const watch = n.status === 'watched';
            return (
              <g key={n.key} className="mosq-node" style={{ animationDelay: `${nodeDelay(i)}s` }}>
                <circle cx={n.x} cy={n.y} r="12" fill={color} opacity="0.16" className="mosq-node-halo" />
                {!print && watch ? (
                  <circle
                    cx={n.x} cy={n.y} r="12" fill={color} opacity="0"
                    className="mosq-node-pulse" style={{ animationDelay: `${nodeDelay(i) + 0.7}s` }}
                  />
                ) : null}
                <g className="mosq-node-dot">
                  <circle cx={n.x} cy={n.y} r="6.5" fill={COLORS.white} stroke={color} strokeWidth="2.5" />
                  <circle cx={n.x} cy={n.y} r="2.5" fill={color} />
                </g>
                <text x={n.x} y={n.y + (n.dy > 0 ? n.dy + 4 : n.dy)} textAnchor="middle" fontSize="10" fontWeight="700" fill={TEXT} fontFamily={FONTS.body}>{n.label}</text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* legend — what we did / found per habitat; rows fade in synced to their
          node landing in live mode */}
      <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
        {treatment ? (
          <div className="mosq-legend-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14, animationDelay: '0.35s' }}>
            <span style={{ color: ringColor, fontWeight: 800, lineHeight: 1.2 }} aria-hidden="true">〰</span>
            <span style={{ color: BODY }}><strong style={{ color: TEXT }}>{treatment.label}</strong> — <span style={{ color: treated ? COLORS.green : COLORS.orange, fontWeight: 700 }}>{treated ? 'Applied' : 'Monitored'}</span>{treatment.detail ? ` · ${treatment.detail}` : ''}</span>
          </div>
        ) : null}
        {placed.map((n, i) => {
          const color = NODE_COLOR[n.status] || COLORS.grayMid;
          return (
            <div key={n.key} className="mosq-legend-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14, animationDelay: `${nodeDelay(i) + 0.1}s` }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, marginTop: 4, flexShrink: 0 }} aria-hidden="true" />
              <span style={{ color: BODY }}><strong style={{ color: TEXT }}>{n.label}</strong> — <span style={{ color, fontWeight: 700 }}>{NODE_WORD[n.status] || 'Tracking'}</span>{n.detail ? ` · ${n.detail}` : ''}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Next step: the one customer action ───────────────────────────────────────────
export function MosquitoNextStep({ primaryMove }) {
  if (!primaryMove?.title) return null;
  return (
    <section data-glass="card" style={{ ...card, borderLeft: `4px solid ${'#0A7EC2'}` }}>
      <div data-gt="eyebrow" style={eyebrow}>Your next step</div>
      <h3 style={{ fontFamily: FONTS.serif, fontWeight: 500, fontSize: 18, color: TEXT, margin: '0 0 6px' }}>{primaryMove.title}</h3>
      {primaryMove.why ? <p style={{ fontSize: 14, color: BODY, lineHeight: 1.5, margin: '0 0 4px' }}>{primaryMove.why}</p> : null}
      {primaryMove.impact ? <p style={{ fontSize: 14, color: MUTED, lineHeight: 1.5, margin: 0 }}>{primaryMove.impact}</p> : null}
      {primaryMove.dueLabel ? (
        <span style={{ display: 'inline-block', marginTop: 10, padding: '4px 10px', background: COLORS.blueLight, color: COLORS.glassNavy, borderRadius: 999, fontSize: 12, fontWeight: 700 }}>{primaryMove.dueLabel}</span>
      ) : null}
    </section>
  );
}

// ── Outlook: the weather-driven mosquito picture ─────────────────────────────────
const LEVEL_COLOR = { high: COLORS.red, elevated: COLORS.orange, moderate: COLORS.orange, low: COLORS.green };

export function MosquitoOutlook({ outlook }) {
  if (!outlook || (!outlook.mosquito && !outlook.conditions)) return null;
  const title = outlook.monthName ? `Mosquito outlook for ${outlook.monthName}` : 'Mosquito outlook';
  const m = outlook.mosquito;
  return (
    <section data-glass="card" style={card}>
      <div data-gt="eyebrow" style={eyebrow}>Seasonal outlook</div>
      <h3 style={{ fontFamily: FONTS.serif, fontWeight: 500, fontSize: 18, color: TEXT, margin: '0 0 4px' }}>{title}</h3>
      {outlook.weatherSummary ? (
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>{outlook.weatherSummary}{outlook.locationLabel ? ` · ${outlook.locationLabel}` : ''}</div>
      ) : null}
      {m ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '10px 12px' }}>
          <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }} aria-hidden="true">{m.emoji || '🦟'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>{m.label}</span>
              <TrendArrow trend={m.trend} />
            </div>
            {m.note ? <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.4 }}>{m.note}</div> : null}
          </div>
          {m.level ? (
            <span style={{ fontSize: 11, fontWeight: 700, color: LEVEL_COLOR[m.level] || COLORS.grayMid, textTransform: 'capitalize', flexShrink: 0 }}>{m.level}</span>
          ) : null}
        </div>
      ) : null}
      {outlook.conditions ? (
        <div style={{ marginTop: m ? 10 : 0, fontSize: 14, color: BODY, lineHeight: 1.5 }}>
          {outlook.conditions.headline ? <strong style={{ color: TEXT }}>{outlook.conditions.headline}</strong> : null}
          {outlook.conditions.headline && outlook.conditions.body ? ' ' : ''}
          {outlook.conditions.body || ''}
          {outlook.conditions.factsLine ? (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>At service time: {outlook.conditions.factsLine}</div>
          ) : null}
        </div>
      ) : null}
      {outlook.disclaimer ? <div style={{ fontSize: 11, color: MUTED, marginTop: 10, fontStyle: 'italic' }}>{outlook.disclaimer}</div> : null}
    </section>
  );
}
