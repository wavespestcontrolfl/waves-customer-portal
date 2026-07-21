// Pest Report V2 — customer-facing, protection-first visual layer.
//
// Presentational components ONLY, driven by the `pestReportV2` payload key
// (server/services/service-report/pest-report-v2.js). Lightweight inline CSS/SVG,
// customer-surface warm tokens (NOT admin monochrome) — mirrors the lawn V2 layer.
//
// The reframe vs lawn: pest value is mostly INVISIBLE protection, and the customer's
// real questions are "am I protected?" / "is there a problem?". So the hero leads
// with a STATUS (Protected / We're watching / Action needed), and the numeric
// pest-pressure reading is supporting evidence, not the headline.
//
// Honest-copy: no internal A/B/C/D zone letters (stripped server-side too), and the
// section renders nothing when its payload is absent (flag off / not a pest visit).

import { useState, useEffect, useId, useRef } from 'react';
import { COLORS, FONTS } from '../../../theme-brand';
import { CUSTOMER_SURFACE } from '../../../theme-customer';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ── Surface tokens (shared with the lawn V2 / public estimate surface) ──────────
const TEXT = 'var(--text)'; // report ink var — resolves per theme (glass navy / doc ink); was CUSTOMER_SURFACE.text (old marketing navy)
const BODY = 'var(--text)'; // prose uses the same ink as the rest of the report body
// muted was drifted gray-500 #6B7280; normalized to the portal slate-600.
const MUTED = 'var(--muted)'; // single supporting gray, matches the page
const BORDER = CUSTOMER_SURFACE.border;
const CARD = COLORS.white;

// Status tone → accent + soft wash. Drives the hero and the defense chips.
// Washes/borders are alpha tints of the three status colors themselves — no
// separate pastel hex family (owner 2026-07-09: reduce the palette).
const TONE = {
  good: { color: COLORS.glassNavy, wash: 'rgba(4, 57, 94, 0.08)', border: 'rgba(4, 57, 94, 0.35)' },
  watch: { color: COLORS.glassNavy, wash: 'rgba(4, 57, 94, 0.08)', border: 'rgba(4, 57, 94, 0.38)' },
  attention: { color: COLORS.red, wash: 'rgba(200, 16, 46, 0.06)', border: 'rgba(200, 16, 46, 0.3)' },
};
function tone(key) { return TONE[key] || TONE.watch; }

// Entry-point node status → color + word. active = protection applied / clear = no
// activity found (both reassuring green); watched = activity or recommendation noted.
const NODE_COLOR = { active: COLORS.glassNavy, clear: COLORS.glassNavy, watched: COLORS.glassNavy };
const NODE_WORD = { active: 'Treated', clear: 'Clear', watched: 'Watching' };

// Fixed positions for the entry points we recognize; anything else is distributed
// evenly around the home so the diagram still reads with an unexpected area set.
const NODE_POS = {
  front_entry: { x: 160, y: 172, label: 'Front entry', dy: 15 },
  lanai: { x: 240, y: 134, label: 'Lanai', dy: 15 },
  pool_equipment_pad: { x: 80, y: 134, label: 'Pool pad', dy: 15 },
  garage: { x: 104, y: 72, label: 'Garage', dy: -8 },
  kitchen: { x: 216, y: 72, label: 'Kitchen', dy: -8 },
};

// Flips true once the element scrolls into view so the ripple entrance plays when
// the customer actually sees it (the map lives below the fold — a mount-timed
// animation would finish before anyone scrolled down). Settled immediately when
// IntersectionObserver is unavailable or the viewer prefers reduced motion.
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

// Geometry matches the report's .sr-section cards (24px padding, 20px rhythm) so
// the pest block doesn't read as a different surface than the rest of the report.
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
// significant_increase / stable / first_marker / insufficient_data — the
// old up/down-only check rendered a worsening "increasing" pressure trend
// as a green down arrow (same codex finding as Mosquito V2). Directional
// reads: UP = more pests (red), DOWN = fewer (green); non-directional
// states render nothing.
const TREND_UP = new Set(['up', 'worsening', 'increasing', 'significant_increase']);
const TREND_DOWN = new Set(['down', 'improving', 'decreasing', 'significant_decrease']);
function TrendArrow({ trend }) {
  const up = TREND_UP.has(trend);
  if (!up && !TREND_DOWN.has(trend)) return null;
  return (
    <span style={{ color: up ? COLORS.red : COLORS.glassNavy, fontSize: 11, marginLeft: 4 }}>
      {up ? '▲' : '▼'}
    </span>
  );
}

// ── Hero: protection status first ───────────────────────────────────────────────
export function PestStatusHero({ status, statusSummary, supportingMetric, aiSummary, token = null, mode = 'live' }) {
  // The rating POST returns a recalculated pestPressure (possibly turning an
  // insufficient reading into a real score) — hold the displayed metric in
  // state so a successful submit can refresh it without a full reload (the
  // standalone PestPressureCard that used to own this is suppressed when the
  // dashboard renders). Parity with the same codex finding on Mosquito V2.
  const [metric, setMetric] = useState(supportingMetric);
  useEffect(() => { setMetric(supportingMetric); }, [supportingMetric]);
  if (!status) return null;
  const t = tone(status.tone);
  const refreshFromPestPressure = (pestPressure) => {
    if (!pestPressure) return;
    const score = pestPressure.displayScore ?? pestPressure.score;
    if (score == null) return;
    setMetric((prev) => ({
      ...(prev || { kind: 'pressure', caption: 'Pest pressure', rating: null, submittedRating: null }),
      kind: 'pressure',
      score: String(score),
      max: pestPressure.maxScore || 5,
      label: pestPressure.label || null,
      trend: pestPressure.trend || null,
    }));
  };
  return (
    <section data-glass="card" style={{ ...card, background: t.wash, border: `1px solid ${t.border}` }}>
      <div data-gt="eyebrow" style={eyebrow}>Today’s protection status</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: t.color, flexShrink: 0, boxShadow: `0 0 0 4px ${t.color}22` }} />
        {/* sr-v2-hero-title marks this as the V2 hero so glass hides the
            eyebrow above it (the ReportViewPage :has() rule) — lawn/tree get
            this via a direct-sibling h2; here the h2 sits in a flex wrapper. */}
        <h2 className="sr-v2-hero-title" style={{ fontFamily: FONTS.serif, fontWeight: 500, fontSize: 25, color: TEXT, margin: 0 }}>{status.label}</h2>
      </div>
      {statusSummary ? (
        <p style={{ fontSize: 15, color: BODY, lineHeight: 1.5, margin: '10px 0 0' }}>{statusSummary}</p>
      ) : null}
      {/* The score pill hides when the reading is still insufficient (score
          null) — the metric may then exist solely to carry the rating picker. */}
      {metric && (metric.score != null || metric.label)
        ? <SupportingMetric metric={metric} />
        : null}
      <PestPressureRating
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

// One-shot customer calibration (replaces the suppressed legacy PestPressureCard
// picker). Posts to the same token route; live mode only; hides once submitted.
function PestPressureRating({ metric, token, live, onRefreshed }) {
  const [submitted, setSubmitted] = useState(Boolean(metric && metric.submittedRating != null));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Client-side navigation to another /report/:token reuses this mounted
  // component — re-derive the one-shot state from the new report's payload so
  // a rating submitted on the previous report doesn't hide this one's picker
  // (matches the legacy PestPressureCard's token reset; same codex finding
  // as Mosquito V2).
  useEffect(() => {
    setSubmitted(Boolean(metric && metric.submittedRating != null));
    setBusy(false);
    setFailed(false);
  }, [token, metric && metric.submittedRating]);
  if (!metric || metric.kind !== 'pressure') return null;
  if (submitted) {
    return <div style={{ marginTop: 12, fontSize: 14, color: COLORS.glassNavy, fontWeight: 600 }}>Thanks — your input helps us calibrate your protection plan.</div>;
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
      // 409 = already recorded (another tab/device) — show the thank-you,
      // not a dead picker.
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

// ── "Waves of Protection" — the where-we-treated centerpiece ─────────────────────
// A branded ripple diagram: the home at center, the exterior treatment radiating
// outward as concentric wave rings (on-brand for "Waves"), with named entry-point
// nodes lit by status. Driven entirely by the premium-experience defense items —
// no map tiles, geometry, or internal A/B/C/D zone letters needed.
//
// "Ripple Seal" motion (live mode only): rings ripple outward from the home one at
// a time as layered glass strokes (cool→warm gradient echoing the glass hairline
// language), each landing synced to its legend row; nodes bloom on with a soft
// status glow; a one-shot seal pulse marks the barrier closing; then a slow
// periodic shimmer sweeps the rings and the field breathes almost imperceptibly.
// Everything decorative-on-top is transform/opacity only, and the static / pdf /
// print / reduced-motion paths render the finished frame with zero animation.

// Ramanujan ellipse perimeter — positions the refracted hairline arcs with plain
// dasharray math instead of pathLength (which older Safari ignores on ellipses).
function ellipsePerimeter(a, b) {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}
// SVG ellipse strokes start at 3 o'clock and run clockwise on screen; fractions
// of the perimeter place the cool glint top-left and the warm kiss bottom-right.
function hairlineArc(C, centerFrac, lenFrac) {
  const len = C * lenFrac;
  return { strokeDasharray: `${len.toFixed(1)} ${(C - len).toFixed(1)}`, strokeDashoffset: (-(C * centerFrac - len / 2)).toFixed(1) };
}

export function PestProtectionMap({ defense, print = false }) {
  const [sectionRef, inView] = useInViewOnce();
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const animate = !print && inView;
  if (!defense?.items?.length) return null;
  const items = defense.items;
  const perimeter = items.find((i) => i.key === 'perimeter_shield');
  const perimeterActive = perimeter ? perimeter.status === 'active' : false;
  const nodes = items.filter((i) => i.key !== 'perimeter_shield' && i.key !== 'pressure');
  const placed = nodes.map((node, idx) => {
    const pos = NODE_POS[node.key];
    if (pos) return { ...node, ...pos };
    const angle = (Math.PI * 2 * idx) / Math.max(nodes.length, 1) - Math.PI / 2;
    return { ...node, x: 160 + Math.cos(angle) * 96, y: 120 + Math.sin(angle) * 66, label: node.label, dy: 15 };
  });
  const ringColor = COLORS.glassNavy;
  const rings = [
    { rx: 48, ry: 34, o: 0.85 }, { rx: 84, ry: 58, o: 0.5 },
    { rx: 120, ry: 82, o: 0.3 }, { rx: 150, ry: 100, o: 0.16 },
  ];
  const ringDelay = (i) => 0.15 + i * 0.22;
  const nodeDelay = (i) => 1.2 + i * 0.16;

  return (
    <section data-glass="card" style={card} ref={sectionRef} className={print ? undefined : (inView ? 'pest-live' : 'pest-await')}>
      <style>{`
        .pest-ring, .pest-ring-field, .pest-seal-pulse, .pest-seal-glow {
          transform-box: view-box;
          transform-origin: 160px 120px;
        }
        .pest-node-dot, .pest-node-halo, .pest-node-pulse { transform-box: fill-box; transform-origin: center; }
        @keyframes pestRingRipple {
          from { opacity: 0; transform: scale(0.55); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes pestGlowIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pestNodePop {
          0% { opacity: 0; transform: scale(0); }
          60% { opacity: 1; transform: scale(1.18); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes pestNodeFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pestHaloPulse {
          0%, 100% { opacity: 0; transform: scale(1); }
          50% { opacity: 0.22; transform: scale(1.3); }
        }
        @keyframes pestSealPulse {
          0% { opacity: 0; transform: scale(0.4); }
          35% { opacity: 0.4; }
          100% { opacity: 0; transform: scale(1.08); }
        }
        @keyframes pestShimmerSweep {
          0% { transform: translateX(-190px); }
          16% { transform: translateX(510px); }
          100% { transform: translateX(510px); }
        }
        @keyframes pestBreathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.012); }
        }
        @keyframes pestLegendIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        /* Awaiting scroll-into-view (live only): diagram internals hold hidden so
           the entrance plays from nothing when the customer reaches it. The card
           header stays visible — the glass card reveal (threshold .06) fires first,
           then the ripple (threshold .3) as the diagram itself scrolls in. */
        .pest-await .pest-seal-glow, .pest-await .pest-ring-field,
        .pest-await .pest-node, .pest-await .pest-legend-row { opacity: 0; }
        .pest-live .pest-ring { animation: pestRingRipple 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
        .pest-live .pest-seal-glow { animation: pestGlowIn 0.6s ease-out both; }
        .pest-live .pest-node .pest-node-dot { animation: pestNodePop 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both; animation-delay: inherit; }
        .pest-live .pest-node .pest-node-halo, .pest-live .pest-node text { animation: pestNodeFade 0.5s ease-out both; animation-delay: inherit; }
        .pest-live .pest-node-pulse { animation: pestHaloPulse 2.4s ease-in-out infinite; }
        .pest-live .pest-seal-pulse { animation: pestSealPulse 1.6s ease-out 1.5s both; }
        .pest-live .pest-shimmer { animation: pestShimmerSweep 9s linear 2.8s infinite; }
        .pest-live .pest-ring-field--breathe { animation: pestBreathe 8s ease-in-out 2.8s infinite; }
        .pest-live .pest-legend-row { animation: pestLegendIn 0.5s ease-out both; }
        @media (print), (prefers-reduced-motion: reduce) {
          .pest-live .pest-ring, .pest-live .pest-seal-glow, .pest-live .pest-node .pest-node-dot,
          .pest-live .pest-node .pest-node-halo, .pest-live .pest-node-pulse, .pest-live .pest-node text,
          .pest-live .pest-seal-pulse, .pest-live .pest-shimmer, .pest-live .pest-ring-field--breathe,
          .pest-live .pest-legend-row { animation: none !important; }
          /* printing before the map scrolled into view must not print it blank */
          .pest-await .pest-seal-glow, .pest-await .pest-ring-field,
          .pest-await .pest-node, .pest-await .pest-legend-row { opacity: 1 !important; }
        }
      `}</style>
      <div data-gt="eyebrow" style={eyebrow}>Where we protected</div>
      <h3 style={{ fontFamily: FONTS.serif, fontWeight: 500, fontSize: 18, color: TEXT, margin: '0 0 2px' }}>
        {/* Observational, not an efficacy promise — say what we DID, not that
            a barrier "is active" (same standard the AI copy guard enforces). */}
        {perimeterActive ? 'We treated the perimeter of your home today' : 'We’re building protection around your home'}
      </h3>
      <p style={{ fontSize: 14, color: MUTED, margin: '0 0 6px' }}>Where we treated and what we’re keeping an eye on this visit.</p>

      <div style={{ width: '100%', maxWidth: 360, margin: '0 auto' }}>
        <svg viewBox="0 0 320 232" width="100%" role="img" aria-label="Diagram of treatment coverage around your home" style={{ display: 'block' }}>
          <defs>
            {/* Refracted-glass ring stroke: cool top-left → accent blue → warm
                bottom-right, the same cool-to-warm language as the card hairlines. */}
            <linearGradient id={`pestRing-${gradId}`} gradientUnits="userSpaceOnUse" x1="40" y1="10" x2="290" y2="225">
              <stop offset="0%" stopColor="#AFE1FF" />
              <stop offset="45%" stopColor="#38AAE1" />
              <stop offset="78%" stopColor="#04395E" />
              <stop offset="100%" stopColor="#FFBE78" />
            </linearGradient>
            <radialGradient id={`pestGlow-${gradId}`} cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" stopColor='rgba(4, 57, 94, 0.35)' stopOpacity="0.4" />
              <stop offset="100%" stopColor='rgba(4, 57, 94, 0.35)' stopOpacity="0" />
            </radialGradient>
            <linearGradient id={`pestShimmer-${gradId}`} gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
              <stop offset="50%" stopColor="#FFFFFF" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
            </linearGradient>
            <mask id={`pestRingMask-${gradId}`}>
              <rect x="0" y="0" width="320" height="232" fill="black" />
              {rings.map((r, i) => (
                <ellipse key={i} cx="160" cy="120" rx={r.rx} ry={r.ry} fill="none" stroke="white" strokeWidth="3.5" />
              ))}
            </mask>
          </defs>

          {/* soft seal glow under the home — the origin the ripple grows from */}
          <ellipse
            cx="160" cy="120" rx="52" ry="36"
            fill={`url(#pestGlow-${gradId})`}
            className="pest-seal-glow"
          />

          <g className={`pest-ring-field${perimeterActive ? ' pest-ring-field--breathe' : ''}`}>
            {rings.map((r, i) => {
              const C = ellipsePerimeter(r.rx, r.ry);
              const dim = perimeterActive ? 1 : 0.6;
              return (
                <g
                  key={i}
                  className="pest-ring"
                  style={{ animationDelay: `${ringDelay(i)}s` }}
                >
                  <ellipse
                    cx="160" cy="120" rx={r.rx} ry={r.ry} fill="none"
                    stroke={`url(#pestRing-${gradId})`}
                    strokeOpacity={r.o * dim}
                    strokeWidth={2.4}
                    strokeDasharray={perimeterActive ? undefined : '4 5'}
                  />
                  {/* dual refraction hairlines: cool glint top-left, warm kiss
                      bottom-right (skipped in the dashed building-protection state) */}
                  {perimeterActive ? (
                    <>
                      <ellipse
                        cx="160" cy="120" rx={r.rx} ry={r.ry} fill="none"
                        stroke="rgba(175,225,255,0.95)" strokeWidth={1.1} strokeLinecap="round"
                        strokeOpacity={Math.min(1, r.o + 0.15)}
                        {...hairlineArc(C, 0.625, 0.16)}
                      />
                      <ellipse
                        cx="160" cy="120" rx={r.rx} ry={r.ry} fill="none"
                        stroke="rgba(255,210,160,0.85)" strokeWidth={1.1} strokeLinecap="round"
                        strokeOpacity={Math.min(1, r.o + 0.1)}
                        {...hairlineArc(C, 0.125, 0.12)}
                      />
                    </>
                  ) : null}
                </g>
              );
            })}
          </g>

          {/* one-shot "sealed" pulse after the last ring lands (live + active only —
              it settles at opacity 0, so it never belongs in a static frame) */}
          {animate && perimeterActive ? (
            <ellipse
              cx="160" cy="120" rx="150" ry="100" fill="none"
              stroke={`url(#pestRing-${gradId})`} strokeWidth="3"
              className="pest-seal-pulse" style={{ opacity: 0 }}
            />
          ) : null}

          {/* slow specular shimmer sweeping across the rings (live only) */}
          {animate && perimeterActive ? (
            <g mask={`url(#pestRingMask-${gradId})`} opacity="0.55" aria-hidden="true">
              <g transform="rotate(18 160 120)">
                <rect
                  x="0" y="-60" width="110" height="352"
                  fill={`url(#pestShimmer-${gradId})`}
                  className="pest-shimmer"
                />
              </g>
            </g>
          ) : null}

          {/* home */}
          <polygon points="160,84 134,106 186,106" fill={COLORS.glassNavy} />
          <rect x="138" y="106" width="44" height="30" rx="3" fill={COLORS.glassNavy} />
          <rect x="155" y="118" width="10" height="18" rx="1.5" fill={COLORS.white} />

          {/* entry-point nodes — bloom on with a soft status glow; watch-state
              halos keep a readable pulse, protected ones stay calm */}
          {placed.map((n, i) => {
            const color = NODE_COLOR[n.status] || COLORS.grayMid;
            const watch = n.status === 'watched';
            return (
              <g key={n.key} className="pest-node" style={{ animationDelay: `${nodeDelay(i)}s` }}>
                <circle cx={n.x} cy={n.y} r="12" fill={color} opacity="0.16" className="pest-node-halo" />
                {/* watch-state glow keeps a readable pulse (live only — settles at 0) */}
                {animate && watch ? (
                  <circle
                    cx={n.x} cy={n.y} r="12" fill={color} opacity="0"
                    className="pest-node-pulse" style={{ animationDelay: `${nodeDelay(i) + 0.7}s` }}
                  />
                ) : null}
                <g className="pest-node-dot">
                  <circle cx={n.x} cy={n.y} r="6.5" fill={COLORS.white} stroke={color} strokeWidth="2.5" />
                  <circle cx={n.x} cy={n.y} r="2.5" fill={color} />
                </g>
                <text x={n.x} y={n.y + (n.dy > 0 ? n.dy + 4 : n.dy)} textAnchor="middle" fontSize="10" fontWeight="700" fill={TEXT} fontFamily={FONTS.body}>{n.label}</text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* legend — what we did per area (no internal zone letters); rows fade in
          synced to their ring / node landing in live mode */}
      <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
        {perimeter ? (
          <div
            className="pest-legend-row"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14, animationDelay: '0.35s' }}
          >
            <span style={{ color: ringColor, fontWeight: 800, lineHeight: 1.2 }} aria-hidden="true">〰</span>
            <span style={{ color: BODY }}><strong style={{ color: TEXT }}>Exterior perimeter</strong> — <span style={{ color: perimeterActive ? COLORS.glassNavy : COLORS.glassNavy, fontWeight: 700 }}>{perimeterActive ? 'Treated' : 'Monitored'}</span>{perimeter.detail ? ` · ${perimeter.detail}` : ''}</span>
          </div>
        ) : null}
        {placed.map((n, i) => {
          const color = NODE_COLOR[n.status] || COLORS.grayMid;
          return (
            <div
              key={n.key}
              className="pest-legend-row"
              style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14, animationDelay: `${nodeDelay(i) + 0.1}s` }}
            >
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, marginTop: 4, flexShrink: 0 }} aria-hidden="true" />
              <span style={{ color: BODY }}><strong style={{ color: TEXT }}>{n.label}</strong> — <span style={{ color, fontWeight: 700 }}>{NODE_WORD[n.status] || 'Tracking'}</span>{n.detail ? ` · ${n.detail}` : ''}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Primary move: the one customer action ───────────────────────────────────────
export function PestPrimaryMove({ primaryMove }) {
  if (!primaryMove?.title) return null;
  return (
    <section data-glass="card" style={{ ...card, borderLeft: `4px solid ${COLORS.glassNavy}` }}>
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

// ── Receipt: the running record ("Since starting WaveGuard") ─────────────────────
export function PestReceipt({ receipt }) {
  if (!receipt?.stats?.length) return null;
  return (
    <section data-glass="card" style={card}>
      <div data-gt="eyebrow" style={eyebrow}>{receipt.headline || 'Your service record'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        {receipt.stats.map((stat) => (
          <div key={stat.label} style={{ background: '#F8FAFC', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '12px 12px' }}>
            <div style={{ fontFamily: FONTS.body, fontWeight: 700, fontSize: 18, color: TEXT }}>{stat.value}</div>
            <div style={{ fontSize: 12, color: MUTED, fontWeight: 600, marginTop: 2 }}>{stat.label}</div>
            {stat.detail ? <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{stat.detail}</div> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Bug files: "pests we're watching" ───────────────────────────────────────────
export function PestBugFiles({ bugFiles = [], print = false }) {
  if (!bugFiles.length) return null;
  return (
    <section data-glass="card" style={card}>
      <div data-gt="eyebrow" style={eyebrow}>Pests we’re watching</div>
      <div style={{ display: 'grid', gap: 10 }}>
        {bugFiles.map((bug) => (
          <div key={bug.pestKey || bug.suspectLabel} style={{ border: `1px solid ${BORDER}`, borderRadius: 12, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>{bug.suspectLabel}</span>
              {bug.confirmedByTech ? (
                <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.glassNavy, background: 'rgba(4, 57, 94, 0.08)', borderRadius: 999, padding: '2px 8px' }}>Identified on-site</span>
              ) : null}
            </div>
            {bug.whereSeen ? <div style={{ fontSize: 14, color: BODY, marginTop: 4 }}>Where: {bug.whereSeen}</div> : null}
            <details open={print} style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600, color: COLORS.glassNavy, listStyle: 'none' }}>More about this pest</summary>
              <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                {bug.whyItMatters ? <Line label="Why it matters" value={bug.whyItMatters} /> : null}
                {bug.whatWeDid ? <Line label="What we did" value={bug.whatWeDid} /> : null}
                {bug.yourMove ? <Line label="Your move" value={bug.yourMove} /> : null}
              </div>
            </details>
          </div>
        ))}
      </div>
    </section>
  );
}

function Line({ label, value }) {
  return (
    <div>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, fontWeight: 700 }}>{label}</span>
      <div style={{ fontSize: 14, color: BODY, lineHeight: 1.45 }}>{value}</div>
    </div>
  );
}

// ── Season forecast: "what to expect" (pest-forecast/) ──────────────────────────
const LEVEL_COLOR = { high: COLORS.red, elevated: COLORS.glassNavy, moderate: COLORS.glassNavy, low: COLORS.glassNavy };

export function PestSeasonForecast({ forecast }) {
  if (!forecast?.pests?.length) return null;
  const title = forecast.monthName ? `What to expect in ${forecast.monthName}` : 'What to expect this season';
  return (
    <section data-glass="card" style={card}>
      <div data-gt="eyebrow" style={eyebrow}>Seasonal outlook</div>
      <h3 style={{ fontFamily: FONTS.serif, fontWeight: 500, fontSize: 18, color: TEXT, margin: '0 0 4px' }}>{title}</h3>
      {forecast.headline ? <p style={{ fontSize: 14, color: BODY, lineHeight: 1.5, margin: '0 0 4px' }}>{forecast.headline}</p> : null}
      {forecast.weatherSummary ? <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>{forecast.weatherSummary}{forecast.locationLabel ? ` · ${forecast.locationLabel}` : ''}</div> : null}
      <div style={{ display: 'grid', gap: 8 }}>
        {forecast.pests.map((p) => (
          <div key={p.key || p.label} style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '10px 12px' }}>
            <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }} aria-hidden="true">{p.emoji || '•'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>{p.label}</span>
                <TrendArrow trend={p.trend} />
              </div>
              {p.note ? <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.4 }}>{p.note}</div> : null}
            </div>
            {p.level ? (
              <span style={{ fontSize: 11, fontWeight: 700, color: LEVEL_COLOR[p.level] || COLORS.grayMid, textTransform: 'capitalize', flexShrink: 0 }}>{p.level}</span>
            ) : null}
          </div>
        ))}
      </div>
      {forecast.disclaimer ? <div style={{ fontSize: 11, color: MUTED, marginTop: 10, fontStyle: 'italic' }}>{forecast.disclaimer}</div> : null}
    </section>
  );
}
