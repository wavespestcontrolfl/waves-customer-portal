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

import { useState, useEffect } from 'react';
import { COLORS, FONTS } from '../../../theme-brand';
import { CUSTOMER_SURFACE } from '../../../theme-customer';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ── Surface tokens (shared with the lawn V2 / public estimate surface) ──────────
const TEXT = CUSTOMER_SURFACE.text;
const BODY = CUSTOMER_SURFACE.body;
// muted was drifted gray-500 #6B7280; normalized to the portal slate-600.
const MUTED = CUSTOMER_SURFACE.muted;
const BORDER = CUSTOMER_SURFACE.border;
const CARD = COLORS.white;

// Status tone → accent + soft wash. Drives the hero and the defense chips.
const TONE = {
  good: { color: COLORS.green, wash: '#ECFDF3', border: '#BBF7D0' },
  watch: { color: COLORS.orange, wash: '#FFF7ED', border: '#FED7AA' },
  attention: { color: COLORS.red, wash: '#FEF2F2', border: '#FECACA' },
};
function tone(key) { return TONE[key] || TONE.watch; }

// Entry-point node status → color + word. active = protection applied / clear = no
// activity found (both reassuring green); watched = activity or recommendation noted.
const NODE_COLOR = { active: COLORS.green, clear: COLORS.green, watched: COLORS.orange };
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

// Flips true just after mount so the ripple animates in; settled immediately when
// printing or when the viewer prefers reduced motion.
function useMounted(delay = 80) {
  const [m, setM] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setM(true); return undefined; }
    const t = setTimeout(() => setM(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return m;
}

const card = {
  background: CARD,
  border: `1px solid ${BORDER}`,
  borderRadius: 16,
  padding: '18px 18px',
  marginBottom: 14,
};
const eyebrow = {
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: MUTED,
  fontWeight: 700,
  marginBottom: 8,
};

// Pressure trend reads inverted: DOWN is good (fewer pests). Forecast trend reads
// straight: UP is the thing to watch. `goodWhenDown` flips the color.
function TrendArrow({ trend, goodWhenDown = false }) {
  if (!trend || trend === 'flat' || trend === 'stable' || trend === 'insufficient_data') return null;
  const up = trend === 'up' || trend === 'worsening';
  const arrow = up ? '▲' : '▼';
  const isGood = goodWhenDown ? !up : up === false;
  const color = isGood ? COLORS.green : (up ? COLORS.red : COLORS.green);
  return <span style={{ color, fontSize: 11, marginLeft: 4 }}>{arrow}</span>;
}

// ── Hero: protection status first ───────────────────────────────────────────────
export function PestStatusHero({ status, statusSummary, supportingMetric, aiSummary, token = null, mode = 'live' }) {
  if (!status) return null;
  const t = tone(status.tone);
  return (
    <section data-glass="card" style={{ ...card, background: t.wash, border: `1px solid ${t.border}` }}>
      <div data-gt="eyebrow" style={eyebrow}>Today’s protection status</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: t.color, flexShrink: 0, boxShadow: `0 0 0 4px ${t.color}22` }} />
        <h2 style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 24, color: TEXT, margin: 0 }}>{status.label}</h2>
      </div>
      {statusSummary ? (
        <p style={{ fontSize: 15, color: BODY, lineHeight: 1.5, margin: '10px 0 0' }}>{statusSummary}</p>
      ) : null}
      {supportingMetric ? <SupportingMetric metric={supportingMetric} /> : null}
      <PestPressureRating metric={supportingMetric} token={token} live={mode === 'live'} />
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
      <span style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 18, color: TEXT }}>{value}</span>
      {showOutOf ? <span style={{ fontSize: 12, color: MUTED }}>/ {metric.max}</span> : null}
      {metric.label && metric.score != null ? <span style={{ fontSize: 12, color: MUTED }}>· {metric.label}</span> : null}
      <TrendArrow trend={metric.trend} goodWhenDown />
    </div>
  );
}

// One-shot customer calibration (replaces the suppressed legacy PestPressureCard
// picker). Posts to the same token route; live mode only; hides once submitted.
function PestPressureRating({ metric, token, live }) {
  const [submitted, setSubmitted] = useState(Boolean(metric && metric.submittedRating != null));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!metric || metric.kind !== 'pressure') return null;
  if (submitted) {
    return <div style={{ marginTop: 12, fontSize: 13, color: COLORS.green, fontWeight: 600 }}>Thanks — your input helps us calibrate your protection plan.</div>;
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
      if (res.ok || res.status === 409) setSubmitted(true);
      else setFailed(true);
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 14, padding: '12px 14px', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 8 }}>{metric.rating.question}</div>
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
export function PestProtectionMap({ defense, print = false }) {
  const mounted = useMounted();
  const animate = !print && mounted;
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
  const ringColor = COLORS.wavesBlue;
  const rings = [
    { rx: 48, ry: 34, o: 0.85 }, { rx: 84, ry: 58, o: 0.5 },
    { rx: 120, ry: 82, o: 0.3 }, { rx: 150, ry: 100, o: 0.16 },
  ];

  return (
    <section data-glass="card" style={card}>
      <div data-gt="eyebrow" style={eyebrow}>Where we protected</div>
      <h3 style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 17, color: TEXT, margin: '0 0 2px' }}>
        {perimeterActive ? 'A protective barrier is active around your home' : 'We’re building protection around your home'}
      </h3>
      <p style={{ fontSize: 13, color: MUTED, margin: '0 0 6px' }}>Where we treated and what we’re keeping an eye on this visit.</p>

      <div style={{ width: '100%', maxWidth: 360, margin: '0 auto' }}>
        <svg viewBox="0 0 320 232" width="100%" role="img" aria-label="Diagram of treatment coverage around your home" style={{ display: 'block' }}>
          <style>{`
            @keyframes pestRippleIn { from { opacity: 0; } to { opacity: 1; } }
            .pest-ring { animation: pestRippleIn .9s ease-out both; }
            .pest-node { animation: pestRippleIn .5s ease-out both; }
            @media (print), (prefers-reduced-motion: reduce) { .pest-ring, .pest-node { animation: none !important; } }
          `}</style>
          {rings.map((r, i) => (
            <ellipse
              key={i}
              cx="160" cy="120" rx={r.rx} ry={r.ry} fill="none"
              stroke={ringColor}
              strokeOpacity={perimeterActive ? r.o : r.o * 0.6}
              strokeWidth={2}
              strokeDasharray={perimeterActive ? undefined : '4 5'}
              className={animate ? 'pest-ring' : undefined}
              style={animate ? { animationDelay: `${0.1 + i * 0.13}s` } : undefined}
            />
          ))}
          {/* home */}
          <polygon points="160,84 134,106 186,106" fill={COLORS.blueDeeper} />
          <rect x="138" y="106" width="44" height="30" rx="3" fill={COLORS.blueDeeper} />
          <rect x="155" y="118" width="10" height="18" rx="1.5" fill={COLORS.white} />
          {/* entry-point nodes */}
          {placed.map((n, i) => {
            const color = NODE_COLOR[n.status] || COLORS.grayMid;
            return (
              <g key={n.key} className={animate ? 'pest-node' : undefined} style={animate ? { animationDelay: `${0.45 + i * 0.12}s` } : undefined}>
                <circle cx={n.x} cy={n.y} r="6.5" fill={COLORS.white} stroke={color} strokeWidth="2.5" />
                <circle cx={n.x} cy={n.y} r="2.5" fill={color} />
                <text x={n.x} y={n.y + (n.dy > 0 ? n.dy + 4 : n.dy)} textAnchor="middle" fontSize="10" fontWeight="700" fill={TEXT} fontFamily={FONTS.body}>{n.label}</text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* legend — what we did per area (no internal zone letters) */}
      <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
        {perimeter ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
            <span style={{ color: ringColor, fontWeight: 800, lineHeight: 1.2 }} aria-hidden="true">〰</span>
            <span style={{ color: BODY }}><strong style={{ color: TEXT }}>Exterior perimeter</strong> — <span style={{ color: perimeterActive ? COLORS.green : COLORS.orange, fontWeight: 700 }}>{perimeterActive ? 'Treated' : 'Monitored'}</span>{perimeter.detail ? ` · ${perimeter.detail}` : ''}</span>
          </div>
        ) : null}
        {placed.map((n) => {
          const color = NODE_COLOR[n.status] || COLORS.grayMid;
          return (
            <div key={n.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
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
    <section data-glass="card" style={{ ...card, borderLeft: `4px solid ${COLORS.wavesBlue}` }}>
      <div data-gt="eyebrow" style={eyebrow}>Your next step</div>
      <h3 style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 17, color: TEXT, margin: '0 0 6px' }}>{primaryMove.title}</h3>
      {primaryMove.why ? <p style={{ fontSize: 14, color: BODY, lineHeight: 1.5, margin: '0 0 4px' }}>{primaryMove.why}</p> : null}
      {primaryMove.impact ? <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.5, margin: 0 }}>{primaryMove.impact}</p> : null}
      {primaryMove.dueLabel ? (
        <span style={{ display: 'inline-block', marginTop: 10, padding: '4px 10px', background: COLORS.blueLight, color: COLORS.blueDeeper, borderRadius: 999, fontSize: 12, fontWeight: 700 }}>{primaryMove.dueLabel}</span>
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
            <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 18, color: TEXT }}>{stat.value}</div>
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
                <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.green, background: '#ECFDF3', borderRadius: 999, padding: '2px 8px' }}>Identified on-site</span>
              ) : null}
            </div>
            {bug.whereSeen ? <div style={{ fontSize: 13, color: BODY, marginTop: 4 }}>Where: {bug.whereSeen}</div> : null}
            <details open={print} style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: COLORS.wavesBlue, listStyle: 'none' }}>More about this pest</summary>
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
      <div style={{ fontSize: 13, color: BODY, lineHeight: 1.45 }}>{value}</div>
    </div>
  );
}

// ── Season forecast: "what to expect" (pest-forecast/) ──────────────────────────
const LEVEL_COLOR = { high: COLORS.red, elevated: COLORS.orange, moderate: COLORS.orange, low: COLORS.green };

export function PestSeasonForecast({ forecast }) {
  if (!forecast?.pests?.length) return null;
  const title = forecast.monthName ? `What to expect in ${forecast.monthName}` : 'What to expect this season';
  return (
    <section data-glass="card" style={card}>
      <div data-gt="eyebrow" style={eyebrow}>Seasonal outlook</div>
      <h3 style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 17, color: TEXT, margin: '0 0 4px' }}>{title}</h3>
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
