// Tree & Shrub Report V2 — customer-facing visual insight layer.
//
// Presentational components ONLY, driven by the `reportV2` payload key for a
// tree_shrub visit (server/services/service-report/tree-shrub-report-v2.js).
// Lightweight inline SVG/CSS — no charting dependency. Customer-surface warm
// tokens (NOT the admin monochrome). Self-contained: mirrors the lawn V2 layer's
// primitives rather than importing them, matching how pestV2 is structured.
//
// Positioning: Waves MONITORS landscape plant health and watches for issues before
// they become bigger problems. So the hero leads with overall landscape plant
// health + a peace-of-mind line, then the five photo-diagnosis categories, then
// findings organized by plant group.
//
// Honest-copy guards (presentation-side mirror of the server guards):
//   - A null/undefined score renders "Tracking", never 0.
//   - Pest/disease rows say "signals", never "infestation"/"diseased".
//   - Charts hide themselves when inputs are missing, rather than drawing empty.

import { useRef, useState, useEffect, createContext, useContext } from 'react';
import { COLORS, FONTS } from '../../../theme-brand';

export const PrintContext = createContext(false);
function usePrint() { return useContext(PrintContext); }

// ── Surface tokens (shared with the lawn/pest V2 + public estimate surface) ─────
const TEXT = '#1B2C5B';
const BODY = '#3F4A65';
const MUTED = '#6B7280';
const BORDER = '#E7E2D7';
const CARD = COLORS.white;
const TAN = '#F2EEE0';

// ── Status system — one vocabulary for the overall score + 5 diagnosis bars +
// insight cards + plant groups. Customer-safe words only. ───────────────────────
export const STATUS = {
  strong: { label: 'Strong', color: COLORS.green },
  healthy: { label: 'Healthy', color: COLORS.green },
  good: { label: 'Good', color: COLORS.green },
  stable: { label: 'Stable', color: COLORS.green },
  watch: { label: 'Watch', color: COLORS.orange },
  needs_attention: { label: 'Needs attention', color: COLORS.red },
  urgent: { label: 'Action needed', color: COLORS.red },
  tracking: { label: 'Tracking', color: COLORS.grayMid },
};
export function statusMeta(key) { return STATUS[key] || STATUS.tracking; }

// null / undefined / '' → UNKNOWN (NaN), never 0 (the Number(null) === 0 trap).
export function toScore(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}
// 0-100 → status band (85/70/55, matches the server scoreStatus). NaN → tracking.
export function scoreStatus(value) {
  const n = toScore(value);
  if (!Number.isFinite(n)) return 'tracking';
  if (n >= 85) return 'strong';
  if (n >= 70) return 'healthy';
  if (n >= 55) return 'watch';
  return 'needs_attention';
}
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function useMounted(delay = 40) {
  const print = usePrint();
  const reduce = print || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [m, setM] = useState(reduce);
  useEffect(() => {
    if (reduce) return undefined;
    const t = setTimeout(() => setM(true), delay);
    return () => clearTimeout(t);
  }, [reduce, delay]);
  return m;
}

// ── Primitives ──────────────────────────────────────────────────────────────────
export function ScoreRing({ value, size = 120, stroke = 10, status }) {
  const mounted = useMounted();
  const n = toScore(value);
  const known = Number.isFinite(n);
  const meta = statusMeta(status || (known ? scoreStatus(n) : 'tracking'));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = known ? clamp(n) / 100 : 0;
  const offset = c * (1 - pct);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
         aria-label={known ? `Score ${Math.round(n)} of 100` : 'Not yet scored'}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={BORDER} strokeWidth={stroke} />
      {known && (
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={meta.color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={mounted ? offset : c}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.9s cubic-bezier(0.4,0,0.2,1)' }}
        />
      )}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
            style={{ fontFamily: FONTS.heading, fontWeight: 800, fill: known ? TEXT : MUTED }}
            fontSize={size * 0.3}>
        {known ? Math.round(n) : '—'}
      </text>
    </svg>
  );
}

export function StatusPill({ status, small = false }) {
  const meta = statusMeta(status);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 7,
      padding: small ? '3px 9px' : '6px 12px', borderRadius: 999,
      background: CARD, border: `1px solid ${BORDER}`,
      fontFamily: FONTS.heading, fontWeight: 700, fontSize: small ? 12 : 14, color: TEXT,
    }}>
      <span style={{ width: small ? 8 : 10, height: small ? 8 : 10, borderRadius: 999, background: meta.color, flex: 'none' }} />
      {meta.label}
    </span>
  );
}

function Card({ children, style }) {
  // data-glass is inert without html[data-glass-theme] (?glass=1 on the live
  // report view) — glass-theme.css supplies all material; gate-off unchanged.
  return (
    <section data-glass="card" style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 20, marginBottom: 16, ...style }}>
      {children}
    </section>
  );
}
function CardTitle({ children, sub }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ fontFamily: FONTS.serif, fontSize: 21, fontWeight: 500, lineHeight: 1.2, color: TEXT, margin: 0 }}>{children}</h2>
      {sub ? <div style={{ fontSize: 13, color: MUTED, marginTop: 3 }}>{sub}</div> : null}
    </div>
  );
}
function InsightLine({ label, value, strong }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.5, color: strong ? TEXT : BODY }}>
      <span style={{ fontWeight: 700, color: strong ? COLORS.green : MUTED }}>{label}: </span>
      {value}
    </div>
  );
}
function KeyLine({ label, value, dot }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={{ width: 9, height: 9, borderRadius: 999, background: dot, flex: 'none', marginTop: 6 }} />
      <div>
        <div data-gt="eyebrow" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 14.5, color: BODY, lineHeight: 1.5 }}>{value}</div>
      </div>
    </div>
  );
}

// ── 1. Tree & Shrub Health Snapshot (hero) ──────────────────────────────────────
export function TreeShrubSnapshotHero({ snapshot = {} }) {
  const {
    overallScore, statusHeadline, scoreExplanation, peaceOfMind, todaysFocus = [],
    watching = [], wavesNext, customerAction, noActionNeeded, nextVisit,
  } = snapshot;
  const status = snapshot.status || scoreStatus(overallScore);
  const hasNextVisit = nextVisit && nextVisit.label && nextVisit.label !== 'Invalid Date';
  const nextVisitText = hasNextVisit
    ? (nextVisit.source === 'estimated'
      ? `Expected around ${nextVisit.label}${nextVisit.cadenceWeeks ? ` (about every ${nextVisit.cadenceWeeks} weeks)` : ''}`
      : nextVisit.label)
    : null;
  return (
    <Card style={{ background: TAN }}>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 'none' }}>
          <ScoreRing value={overallScore} status={status} size={116} />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div data-gt="eyebrow" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: MUTED, fontWeight: 700, marginBottom: 4 }}>
            Overall Landscape Plant Health
          </div>
          <h1 style={{ fontFamily: FONTS.serif, fontSize: 25, fontWeight: 500, lineHeight: 1.2, color: TEXT, margin: '0 0 8px' }}>
            {statusHeadline || statusMeta(status).label}
          </h1>
          {scoreExplanation ? (
            <p style={{ fontSize: 14, color: BODY, lineHeight: 1.5, margin: '0 0 6px' }}>{scoreExplanation}</p>
          ) : null}
          {todaysFocus.length ? (
            <div style={{ fontSize: 13.5, color: MUTED, lineHeight: 1.5 }}>
              <strong style={{ color: BODY }}>Today&apos;s focus:</strong> {todaysFocus.join(' · ')}
            </div>
          ) : null}
        </div>
      </div>

      {/* Peace of mind — the reassurance line that frames the whole report. */}
      {peaceOfMind ? (
        <div style={{ marginTop: 14, padding: '11px 13px', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
          <div data-gt="eyebrow" style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Peace of mind</div>
          <div style={{ fontSize: 14.5, color: BODY, lineHeight: 1.5, marginTop: 3 }}>{peaceOfMind}</div>
        </div>
      ) : null}

      {watching.length ? (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${BORDER}` }}>
          <div data-gt="eyebrow" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, fontWeight: 700, marginBottom: 8 }}>What we’re monitoring</div>
          <ol style={{ margin: 0, padding: '0 0 0 20px', display: 'grid', gap: 5 }}>
            {watching.map((w, i) => (
              <li key={i} style={{ fontSize: 14.5, color: BODY, lineHeight: 1.45 }}>{w}</li>
            ))}
          </ol>
        </div>
      ) : null}

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${BORDER}`, display: 'grid', gap: 10 }}>
        {wavesNext ? <KeyLine label="What Waves will do next" value={wavesNext} dot={COLORS.teal} /> : null}
        {customerAction
          ? <KeyLine label="Your next step" value={customerAction} dot={COLORS.green} />
          : (noActionNeeded ? <KeyLine label="Your next step" value="No action is needed from you right now — we completed today’s treatment and did not identify an urgent plant health issue." dot={COLORS.green} /> : null)}
        {nextVisitText ? <KeyLine label="Next visit" value={nextVisitText} dot={COLORS.blueDeeper} /> : null}
      </div>
    </Card>
  );
}

// ── 2. Top plant insights (cause → effect → action) ─────────────────────────────
const INSIGHT_CONFIDENCE = {
  tech_confirmed: 'Confirmed by your technician',
  protocol_confirmed: 'Confirmed on the service protocol',
  ai_supported: 'Seen in today’s photos',
  area_estimated: 'Estimated for your area',
  monitoring: 'Monitoring on future visits',
};

export function TreeShrubInsightCards({ insights = [], limit = 3 }) {
  const top = [...insights.filter(Boolean)]
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .slice(0, limit);
  if (!top.length) return null;
  return (
    <Card>
      <CardTitle sub="The few things that actually matter from today’s visit.">Top plant insights</CardTitle>
      <div style={{ display: 'grid', gap: 12 }}>
        {top.map((it, i) => {
          const meta = statusMeta(it.status || 'tracking');
          return (
            <div key={i} style={{ border: `1px solid ${BORDER}`, borderLeft: `4px solid ${meta.color}`, borderRadius: 12, background: CARD, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15.5, color: TEXT, lineHeight: 1.25 }}>{it.headline}</div>
                <StatusPill status={it.status || 'tracking'} small />
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {it.whatWeSaw ? <InsightLine label="What we saw" value={it.whatWeSaw} /> : null}
                {it.whyItMatters ? <InsightLine label="Why it matters" value={it.whyItMatters} /> : null}
                {it.wavesAction ? <InsightLine label="What Waves did" value={it.wavesAction} /> : null}
                {it.customerAction ? <InsightLine label="Your next step" value={it.customerAction} strong /> : null}
                {!it.customerAction && it.nextVisitPlan ? <InsightLine label="Next visit" value={it.nextVisitPlan} /> : null}
              </div>
              {it.confidence && INSIGHT_CONFIDENCE[it.confidence] ? (
                <div style={{ marginTop: 8, fontSize: 11.5, color: MUTED, fontStyle: 'italic' }}>{INSIGHT_CONFIDENCE[it.confidence]}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── 3. Five-category photo diagnosis (horizontal bars) ──────────────────────────
const CATEGORY_DETAIL = {
  foliage_fullness: {
    measures: 'How full and dense the plants look — thick canopy with few thin or bare areas scores high.',
    affects: 'Thinning usually traces back to shade, pests, over-pruning, or stress. Full foliage is the foundation the rest of the plant builds on.',
  },
  leaf_color_vigor: {
    measures: 'How vibrant and even the leaf color looks. Yellowing, bronzing, pale new growth, or scorch lowers it.',
    affects: 'Color responds to nutrients, iron, water, and heat — and shifts with the season, so we read it against the time of year before flagging anything.',
  },
  pest_activity: {
    measures: 'Visible pest-pressure SIGNALS on the foliage — chewing, stippling, webbing, scale-like bumps, sooty mold, or distorted growth.',
    affects: 'These are signals to monitor, not a diagnosis. Your technician checks the cause on site before treating — we never diagnose pests from a photo alone.',
  },
  disease_leaf_spot: {
    measures: 'Visible leaf-spot or disease-like SIGNALS — spotting clusters, blight-like patterns, mildew-like residue, or blackened foliage.',
    affects: 'These are early symptoms to watch, not a confirmed disease. We document and recheck before any treatment, so we never diagnose disease from a photo alone.',
  },
  water_heat_mechanical_stress: {
    measures: 'Whether the plants look stressed by water, heat, pruning, or the surroundings — wilt, crispy margins, scorch, over-pruning, or storm/mechanical damage.',
    affects: 'Both water extremes hurt, and over-pruning or broken branches add stress. In landscape beds, uneven coverage often shows as dry stress even when the area got rain.',
  },
};

export function TreeShrubVisualDiagnosisBars({ categories = [] }) {
  const print = usePrint();
  const cats = categories.filter(Boolean);
  if (!cats.length) return null;
  return (
    <Card>
      <CardTitle sub="What our cameras and AI scored from today’s photos. Tap a row for the details.">Photo Diagnosis</CardTitle>
      <div style={{ display: 'grid', gap: 8 }}>
        {cats.map((c) => {
          const status = c.status || scoreStatus(c.score);
          const meta = statusMeta(status);
          const known = Number.isFinite(toScore(c.score));
          const pct = known ? Math.max(4, Math.min(100, toScore(c.score))) : 0;
          const detail = CATEGORY_DETAIL[c.key];
          const sawValue = c.explanation || c.customerExplanation || (known ? null : 'Not clearly visible in today’s photos.');
          return (
            <div key={c.key} style={{ border: `1px solid ${BORDER}`, borderLeft: `4px solid ${meta.color}`, borderRadius: 12, background: CARD }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px' }}>
                <div style={{ flex: 'none' }}>
                  <ScoreRing value={c.score} status={status} size={54} stroke={6} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: TEXT, lineHeight: 1.15 }}>{c.label}</div>
                    <StatusPill status={status} small />
                  </div>
                  <div style={{ marginTop: 10, height: 7, borderRadius: 999, background: '#F1EEE6', overflow: 'hidden' }}>
                    {known ? <div style={{ width: `${pct}%`, height: '100%', background: meta.color, borderRadius: 999 }} /> : null}
                  </div>
                </div>
              </div>
              {detail ? (
                <details open={print} style={{ borderTop: `1px solid ${BORDER}`, padding: '9px 14px' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: MUTED, listStyle: 'none' }}>What this means</summary>
                  <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                    {sawValue ? <InsightLine label="What we saw" value={sawValue} strong /> : null}
                    <InsightLine label="What this measures" value={detail.measures} />
                    <InsightLine label="What affects it" value={detail.affects} />
                  </div>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── 4. Plant group / zone cards ─────────────────────────────────────────────────
export function PlantGroupStatusCards({ plantGroups = [] }) {
  const groups = (plantGroups || []).filter((g) => g && g.label);
  if (!groups.length) return null;
  return (
    <Card>
      <CardTitle sub="Organized by area so you can see exactly where things stand.">Plant groups</CardTitle>
      <div style={{ display: 'grid', gap: 10 }}>
        {groups.map((g, i) => {
          const meta = statusMeta(g.status || 'stable');
          return (
            <div key={g.key || i} style={{ border: `1px solid ${BORDER}`, borderLeft: `4px solid ${meta.color}`, borderRadius: 12, background: CARD, padding: '13px 15px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: g.finding ? 6 : 0 }}>
                <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: TEXT }}>{g.label}</div>
                <StatusPill status={g.status || 'stable'} small />
              </div>
              {g.finding ? <div style={{ fontSize: 13.5, color: BODY, lineHeight: 1.5 }}>{g.finding}</div> : null}
              {g.wavesAction ? <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5, marginTop: 5 }}><strong style={{ color: BODY }}>Waves:</strong> {g.wavesAction}</div> : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── 5. Landscape water context (softer than lawn) ───────────────────────────────
function inchLabel(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${String(Number(n.toFixed(2))).replace(/\.?0+$/, '')}"`;
}
// Server water vocabulary (surplus/deficit/balanced/unknown) → status pill word.
const WATER_PILL = { surplus: 'watch', deficit: 'watch', balanced: 'stable', unknown: 'tracking' };
export function LandscapeWaterContextCard({ water = null }) {
  if (!water || !water.explanation) return null;
  const rain = Number(water.rainInches);
  const irrigation = Number(water.irrigationInches);
  const total = Number(water.totalInches);
  const status = WATER_PILL[water.status]
    || (STATUS[water.status] ? water.status : (water.localizedDry ? 'watch' : 'stable'));
  return (
    <Card>
      <CardTitle sub="Landscape beds may use spray, drip, micro-spray, bubblers, or hand watering, so we read this softly.">Landscape Water Context</CardTitle>
      {(Number.isFinite(rain) || Number.isFinite(irrigation) || Number.isFinite(total)) ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '4px 18px', fontSize: 14, color: BODY, marginBottom: 14 }}>
          {Number.isFinite(rain) ? <><span style={{ color: MUTED }}>Rain this week</span><strong style={{ textAlign: 'right', color: TEXT }}>{inchLabel(rain)}</strong></> : null}
          {Number.isFinite(irrigation) ? <><span style={{ color: MUTED }}>Irrigation</span><strong style={{ textAlign: 'right', color: TEXT }}>{inchLabel(irrigation)}</strong></> : null}
          {water.irrigationType ? <><span style={{ color: MUTED }}>Watering type</span><strong style={{ textAlign: 'right', color: TEXT }}>{water.irrigationType}</strong></> : null}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <StatusPill status={status} small />
      </div>
      <p style={{ margin: 0, fontSize: 14, color: BODY, lineHeight: 1.55 }}>{water.explanation}</p>
    </Card>
  );
}

// ── 5b. What Waves did today (products applied) ─────────────────────────────────
const KIND_DOT = {
  fungicide: COLORS.teal, insecticide: COLORS.red, miticide: COLORS.orange,
  systemic: COLORS.red, fertilizer: COLORS.green, supplement: COLORS.green, other: COLORS.grayMid,
};
export function TreeShrubTreatmentCard({ treatment = {} }) {
  const products = Array.isArray(treatment.products) ? treatment.products : [];
  const focus = Array.isArray(treatment.focus) ? treatment.focus : [];
  if (!products.length && !focus.length) return null;
  return (
    <Card>
      <CardTitle sub="The treatment and products applied to your trees, shrubs, palms, and ornamentals this visit.">What Waves did today</CardTitle>
      {focus.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: products.length ? 14 : 0 }}>
          {focus.map((f, i) => (
            <span key={i} style={{ padding: '5px 11px', borderRadius: 999, background: TAN, border: `1px solid ${BORDER}`, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 12.5, color: TEXT }}>{f}</span>
          ))}
        </div>
      ) : null}
      {products.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {products.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '11px 13px', background: CARD }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: KIND_DOT[p.kind] || COLORS.grayMid, flex: 'none', marginTop: 6 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 14.5, color: TEXT }}>
                  {p.name}
                  {p.activeIngredient ? <span style={{ fontWeight: 500, color: MUTED, fontSize: 12.5 }}> · {p.activeIngredient}</span> : null}
                </div>
                {p.whatItDoes ? <div style={{ fontSize: 13.5, color: BODY, lineHeight: 1.5, marginTop: 2 }}>{p.whatItDoes}</div> : null}
                {(p.targets && p.targets.length) || p.area ? (
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                    {p.targets && p.targets.length ? `Targets: ${p.targets.join(', ')}` : ''}
                    {p.targets && p.targets.length && p.area ? ' · ' : ''}
                    {p.area ? `Area: ${p.area}` : ''}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

// ── 6. Photos with AI/tech captions ─────────────────────────────────────────────
export function TreeShrubPhotoCards({ photos = [], summary = null }) {
  const print = usePrint();
  const pics = (photos || []).filter((p) => p && p.url);
  if (!pics.length && !summary) return null;
  return (
    <Card>
      <CardTitle sub="What your technician documented on site today.">Plant photos</CardTitle>
      <div style={{ display: 'grid', gridTemplateColumns: print ? '1fr 1fr' : 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {pics.map((p, i) => (
          <figure key={i} style={{ margin: 0 }}>
            <img src={p.url} alt={p.label || 'Plant photo'} loading="lazy"
              style={{ width: '100%', height: 180, objectFit: 'cover', borderRadius: 12, border: `1px solid ${BORDER}`, display: 'block' }} />
            {p.label ? <figcaption style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 13, color: TEXT, marginTop: 7 }}>{p.label}</figcaption> : null}
            {p.caption ? <div style={{ fontSize: 13, color: BODY, lineHeight: 1.5, marginTop: 3 }}>{p.caption}</div> : null}
          </figure>
        ))}
      </div>
      {summary ? <p style={{ margin: '14px 0 0', fontSize: 14, color: BODY, lineHeight: 1.55 }}>{summary}</p> : null}
    </Card>
  );
}

// ── 7. Trends across visits ─────────────────────────────────────────────────────
function TrendChart({ title, sub, points = [], accent = COLORS.teal, compact = false }) {
  const mounted = useMounted();
  const [active, setActive] = useState(null);
  const pts = (points || []).map((p) => ({ label: p.label, value: toScore(p.value) })).filter((p) => Number.isFinite(p.value));
  if (pts.length < 2) return null;
  const W = 300;
  const H = compact ? 96 : 132;
  const padX = 12; const padTop = 16; const padBottom = 22;
  const lo = 0; const hi = 100;
  const x = (i) => padX + (i * (W - 2 * padX)) / (pts.length - 1);
  const y = (v) => padTop + (1 - (v - lo) / (hi - lo)) * (H - padTop - padBottom);
  const last = pts[pts.length - 1];
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const baseY = H - padBottom;
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;
  const activePt = active != null ? pts[active] : null;
  const labelX = (i) => Math.max(padX + 14, Math.min(W - padX - 14, x(i)));
  return (
    <Card style={compact ? { marginBottom: 0, padding: 16 } : undefined}>
      <CardTitle sub={compact ? undefined : sub}>{title}</CardTitle>
      {compact ? <div style={{ fontSize: 12, color: MUTED, marginTop: -8, marginBottom: 8 }}>{sub}</div> : null}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${title} trend`} onMouseLeave={() => setActive(null)}>
        <path d={area} fill={accent} fillOpacity={0.1} opacity={mounted ? 1 : 0} style={{ transition: 'opacity 0.6s ease 0.25s' }} />
        <path d={line} fill="none" stroke={accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          pathLength="1" strokeDasharray="1" strokeDashoffset={mounted ? 0 : 1}
          style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)' }} />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.value)} r={active === i ? 6 : (i === pts.length - 1 ? 4.5 : 3)}
              fill={active === i || i === pts.length - 1 ? accent : CARD} stroke={accent} strokeWidth="2" style={{ transition: 'r 0.15s ease' }} />
            <circle cx={x(i)} cy={y(p.value)} r="13" fill="transparent" style={{ cursor: 'pointer' }}
              onMouseEnter={() => setActive(i)} onClick={() => setActive((a) => (a === i ? null : i))} />
          </g>
        ))}
        {activePt ? (
          <text x={labelX(active)} y={y(activePt.value) - 11} textAnchor="middle" style={{ fontFamily: FONTS.heading, fontWeight: 800, fill: accent }} fontSize="13">{Math.round(activePt.value)}</text>
        ) : (
          <text x={x(pts.length - 1)} y={y(last.value) - 9} textAnchor="end" style={{ fontFamily: FONTS.heading, fontWeight: 800, fill: accent }} fontSize="13">{Math.round(last.value)}</text>
        )}
        {pts.map((p, i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" style={{ fontFamily: FONTS.body, fill: active === i ? TEXT : MUTED, fontWeight: active === i ? 700 : 400 }} fontSize="10.5">{p.label}</text>
        ))}
      </svg>
    </Card>
  );
}
const lastVal = (pts = []) => { const f = [...pts].reverse().find((p) => Number.isFinite(toScore(p.value))); return f ? toScore(f.value) : NaN; };
function scoreAccent(v) { return statusMeta(scoreStatus(v)).color; }

export function TreeShrubTrends({ trends = {} }) {
  const { overall, foliage, color, pest, water } = trends;
  const hasOverall = (overall || []).filter((p) => Number.isFinite(toScore(p.value))).length >= 2;
  const minis = [
    foliage && { key: 'foliage', title: 'Foliage Fullness', sub: 'higher is better', points: foliage },
    color && { key: 'color', title: 'Leaf Color & Vigor', sub: 'higher is better', points: color },
    pest && { key: 'pest', title: 'Pest Pressure', sub: 'higher is better', points: pest },
    water && { key: 'water', title: 'Water / Heat Stress', sub: 'higher is better', points: water },
  ].filter(Boolean).filter((m) => (m.points || []).filter((p) => Number.isFinite(toScore(p.value))).length >= 2);
  if (!hasOverall && !minis.length) return null;
  return (
    <>
      {hasOverall ? (
        <TrendChart title="Plant Health Trend" sub="Your overall landscape score across recent visits."
          points={overall} accent={scoreAccent(lastVal(overall))} />
      ) : null}
      {minis.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 16 }}>
          {minis.map((m) => (
            <TrendChart key={m.key} compact title={m.title} sub={m.sub} points={m.points} accent={scoreAccent(lastVal(m.points))} />
          ))}
        </div>
      ) : null}
    </>
  );
}
