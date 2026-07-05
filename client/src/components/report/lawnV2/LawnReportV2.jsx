// Lawn Report V2 — customer-facing visual insight layer.
//
// Presentational components ONLY: every component is driven by props so they can
// render from the eventual `/api/reports/:token/data` payload (and from mock data
// in the dev preview at /report-v2-preview). Lightweight inline SVG/CSS — no
// charting dependency. Customer-surface warm tokens (NOT the admin monochrome).
//
// Honest-copy rules baked in here are presentation-side guards only — the real
// guards live server-side (rain-unknown gating, no over-diagnosis, "we don't mow"):
//   - A null/undefined score renders as "Tracking", never 0.
//   - Charts hide themselves when their inputs are missing, rather than drawing empty.

import { useRef, useState, useEffect, createContext, useContext } from 'react';
import { COLORS, FONTS } from '../../../theme-brand';

// Print/PDF mode: components render a static variant (dropdowns open, photo grid
// instead of a slider, no animations) so the Puppeteer PDF matches the screen.
export const PrintContext = createContext(false);
function usePrint() { return useContext(PrintContext); }

// ── Surface tokens (mirror LawnReportViewPage / public estimate surface) ──────
const TEXT = '#1B2C5B';
const BODY = '#3F4A65';
const MUTED = '#6B7280';
const BORDER = '#E7E2D7';
const CARD = COLORS.white;
const TAN = '#F2EEE0';

// ── Status system ─────────────────────────────────────────────────────────────
// One vocabulary shared by the overall score, the diagnosis cards, water, and
// mowing. Customer-safe words only — never "diseased", "infestation", etc.
export const STATUS = {
  strong: { label: 'Strong', color: COLORS.green },
  healthy: { label: 'Healthy', color: COLORS.green },
  good: { label: 'Good', color: COLORS.green },
  stable: { label: 'Stable', color: COLORS.green },
  balanced: { label: 'Balanced', color: COLORS.green },
  ideal: { label: 'Ideal', color: COLORS.green },
  watch: { label: 'Watch', color: COLORS.orange },
  needs_attention: { label: 'Needs attention', color: COLORS.red },
  urgent: { label: 'Needs attention', color: COLORS.red },
  too_short: { label: 'A bit short', color: COLORS.orange },
  too_tall: { label: 'A bit tall', color: COLORS.orange },
  low: { label: 'Below target', color: COLORS.orange },
  high: { label: 'Above target', color: COLORS.orange },
  tracking: { label: 'Tracking', color: COLORS.grayMid },
  not_assessed: { label: 'Not assessed', color: COLORS.grayMid },
};

export function statusMeta(key) {
  return STATUS[key] || STATUS.tracking;
}

// Coerce a score to a finite number, treating null / undefined / '' as UNKNOWN
// (NaN) rather than 0. Guards the Number(null) === 0 trap: a DB NULL / unassessed
// category must read "Tracking", never a red 0. (Same lesson as V1 lawnScoreValue.)
export function toScore(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// Score (0-100) → status band. Matches the existing lawnScoreLabel thresholds
// (85 / 70 / 55) so V1 and V2 never disagree. Null/NaN → "tracking".
export function scoreStatus(value) {
  const n = toScore(value);
  if (!Number.isFinite(n)) return 'tracking';
  if (n >= 85) return 'strong';
  if (n >= 70) return 'healthy';
  if (n >= 55) return 'watch';
  return 'needs_attention';
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// ── Primitives ────────────────────────────────────────────────────────────────

// Flips true just after mount so CSS transitions animate from an initial state.
// Respects prefers-reduced-motion (starts already-settled).
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

// Circular score ring. value null → renders a muted "—" with the tracking color.
// The arc fills on mount (animated strokeDashoffset).
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

function inchLabel(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${String(Number(n.toFixed(2))).replace(/\.?0+$/, '')}"`;
}

// ── 1. Lawn Health Snapshot (hero) ──────────────────────────────────────────────
export function LawnSnapshotHero({ snapshot = {} }) {
  const { overallScore, statusHeadline, scoreExplanation, rootCause, seasonalNote, todaysFocus = [], watching = [], wavesNext, customerAction, noActionNeeded, nextVisit } = snapshot;
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
            Overall Lawn Status
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

      {/* Root cause — the connected "what's driving it" read. */}
      {rootCause ? (
        <div style={{ marginTop: 14, padding: '11px 13px', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
          <div data-gt="eyebrow" style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em' }}>What’s driving it</div>
          <div style={{ fontSize: 14.5, color: BODY, lineHeight: 1.5, marginTop: 3 }}>{rootCause}</div>
        </div>
      ) : null}

      {/* The "story": what we're watching, what Waves does next, what (if anything) you do. */}
      {watching.length ? (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${BORDER}` }}>
          <div data-gt="eyebrow" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: MUTED, fontWeight: 700, marginBottom: 8 }}>Main things we’re watching</div>
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
          : (noActionNeeded ? <KeyLine label="Your next step" value="No action is needed from you right now — we’ve got it covered." dot={COLORS.green} /> : null)}
        {nextVisitText ? <KeyLine label="Next lawn visit" value={nextVisitText} dot={COLORS.blueDeeper} /> : null}
      </div>
      {seasonalNote ? (
        <div style={{ marginTop: 14, fontSize: 13, color: MUTED, fontStyle: 'italic', lineHeight: 1.5 }}>{seasonalNote}</div>
      ) : null}
    </Card>
  );
}

// Reassurance card: a planned/scheduled follow-up, surfaced instead of buried in prose.
export function LawnFollowUpCard({ followUp = null }) {
  if (!followUp || !followUp.scheduled) return null;
  return (
    <Card style={{ background: COLORS.greenLight, border: `1px solid ${COLORS.green}` }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ flex: 'none', width: 30, height: 30, borderRadius: 999, background: COLORS.green, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 16, fontWeight: 800 }}>✓</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: FONTS.heading, fontWeight: 800, fontSize: 15.5, color: TEXT }}>{followUp.headline || 'Follow-up already planned'}</div>
          {followUp.reason ? <p style={{ margin: '4px 0 0', fontSize: 14, color: BODY, lineHeight: 1.5 }}>{followUp.reason}</p> : null}
          {followUp.customerAction ? (
            <p style={{ margin: '8px 0 0', fontSize: 13.5, color: BODY, lineHeight: 1.5 }}>
              <strong style={{ color: TEXT }}>Your part:</strong> {followUp.customerAction}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
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

// ── 2. Photo diagnosis cards ────────────────────────────────────────────────────
// Field photos as a horizontal strip + ONE consolidated analysis across all photos
// (never the per-photo vision blurbs). Renders above the Photo Diagnosis scores.
function SliderArrow({ dir, onClick, disabled }) {
  return (
    <button
      type="button" aria-label={dir === 'prev' ? 'Previous photo' : 'Next photo'} onClick={onClick} disabled={disabled}
      style={{
        position: 'absolute', top: '42%', [dir === 'prev' ? 'left' : 'right']: 8, transform: 'translateY(-50%)',
        width: 36, height: 36, borderRadius: 999, border: 'none', background: 'rgba(27,44,91,0.82)', color: '#fff',
        fontSize: 20, fontWeight: 800, lineHeight: 1, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.3 : 1,
        display: 'grid', placeItems: 'center',
      }}
    >{dir === 'prev' ? '‹' : '›'}</button>
  );
}

export function LawnPhotoStrip({ photos = [], summary = null }) {
  const print = usePrint();
  const pics = (photos || []).filter((p) => p && p.url);
  const scroller = useRef(null);
  const [idx, setIdx] = useState(0);
  if (!pics.length && !summary) return null;
  const multi = pics.length > 1;
  const go = (d) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: d * el.clientWidth, behavior: 'smooth' });
  };
  const onScroll = () => {
    const el = scroller.current;
    if (el && el.clientWidth) setIdx(Math.round(el.scrollLeft / el.clientWidth));
  };
  return (
    <Card>
      <CardTitle sub={`${print ? 'What' : 'Swipe through what'} your technician documented on site today.`}>Lawn photos</CardTitle>
      {pics.length && print ? (
        /* Static grid for PDF/print — no slider/arrows. */
        <div style={{ display: 'grid', gridTemplateColumns: pics.length === 1 ? '1fr' : '1fr 1fr', gap: 10 }}>
          {pics.map((p, i) => (
            <figure key={i} style={{ margin: 0 }}>
              <img src={p.url} alt={p.label || 'Lawn photo'} style={{ width: '100%', height: 170, objectFit: 'cover', borderRadius: 10, border: `1px solid ${BORDER}`, display: 'block' }} />
              {p.label ? <figcaption style={{ fontSize: 12, color: MUTED, marginTop: 5 }}>{p.label}</figcaption> : null}
            </figure>
          ))}
        </div>
      ) : null}
      {pics.length && !print ? (
        <div style={{ position: 'relative' }}>
          <div
            ref={scroller}
            onScroll={onScroll}
            style={{ display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory', borderRadius: 12, scrollbarWidth: 'none' }}
          >
            {pics.map((p, i) => (
              <figure key={i} style={{ margin: 0, flex: '0 0 100%', scrollSnapAlign: 'center' }}>
                <img
                  src={p.url}
                  alt={p.label || 'Lawn photo'}
                  loading="lazy"
                  style={{ width: '100%', height: 240, objectFit: 'cover', borderRadius: 12, border: `1px solid ${BORDER}`, display: 'block' }}
                />
                {p.label ? <figcaption style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>{p.label}</figcaption> : null}
              </figure>
            ))}
          </div>
          {multi ? (
            <>
              <SliderArrow dir="prev" onClick={() => go(-1)} disabled={idx <= 0} />
              <SliderArrow dir="next" onClick={() => go(1)} disabled={idx >= pics.length - 1} />
              <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 10 }}>
                {pics.map((_, i) => (
                  <span key={i} style={{ width: 7, height: 7, borderRadius: 999, background: i === idx ? TEXT : BORDER }} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {summary ? <p style={{ margin: '12px 0 0', fontSize: 14, color: BODY, lineHeight: 1.55 }}>{summary}</p> : null}
    </Card>
  );
}

// Plain-English definition of each category — shown in an expandable "What this means".
// Damage Signals explicitly states it's PATTERNS to watch, never a confirmed diagnosis.
// Richer per-category detail for the dropdown: what it measures + what drives it.
// The plain-language per-visit read (c.explanation) is shown above these.
const CATEGORY_DETAIL = {
  coverage: {
    measures: 'How full and evenly covered the lawn is — thick turf with few bare or thinning spots scores high.',
    affects: 'Thinning usually traces back to shade, foot traffic, mowing too short, or pests. Even coverage is the foundation the rest of the lawn builds on.',
  },
  color_vigor: {
    measures: 'How healthy and consistent the lawn’s color looks. Yellowing, browning, or patchy color lowers it.',
    affects: 'Color responds to nitrogen, iron, water, and temperature — and naturally fades in the cooler months, so we read it against the season before flagging anything.',
  },
  weed_pressure: {
    measures: 'How clear the lawn is of weeds — fewer weeds competing with the turf scores higher.',
    affects: 'Weeds move in wherever turf is thin or stressed, so weed pressure and coverage tend to move together. Thick, healthy turf is the best long-term weed control.',
  },
  water_moisture_stress: {
    measures: 'Whether the lawn looks too wet or too dry — read from visible moisture signs (mushrooms, algae, damp or dry patches) alongside the week’s rain-plus-irrigation balance.',
    affects: 'Both extremes hurt: too much water invites fungus and weeds, too little browns the turf. Uneven sprinkler coverage often shows as dry spots even when the weekly total looks fine.',
  },
  damage_disease_signals: {
    measures: 'Visual stress patterns worth keeping an eye on — irregular dead or thinning patches, fungus-like rings, or insect-type damage.',
    affects: 'These are early signals to monitor, not a confirmed problem. Your technician confirms the cause on site before any treatment, so we never diagnose from a photo alone.',
  },
};

export function VisualDiagnosisCards({ categories = [] }) {
  const print = usePrint();
  const cats = categories.filter(Boolean);
  if (!cats.length) return null;
  return (
    <Card>
      <CardTitle sub="What our cameras and AI scored from today’s photos. Tap a row for the details.">Photo Diagnosis</CardTitle>
      {/* Visual-primary rows: the score ring + bar + status carry the read at a glance;
          the plain-language detail lives in the dropdown. */}
      <div style={{ display: 'grid', gap: 8 }}>
        {cats.map((c) => {
          const status = c.status || scoreStatus(c.score);
          const meta = statusMeta(status);
          const known = Number.isFinite(toScore(c.score));
          const pct = known ? Math.max(4, Math.min(100, toScore(c.score))) : 0;
          const detail = CATEGORY_DETAIL[c.key];
          const sawValue = c.explanation || (known ? null : 'Not clearly visible in today’s photos.');
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
                  {/* score bar — the primary visual read of where this sits 0–100 */}
                  <div style={{ marginTop: 10, height: 7, borderRadius: 999, background: '#F1EEE6', overflow: 'hidden' }}>
                    {known ? <div style={{ width: `${pct}%`, height: '100%', background: meta.color, borderRadius: 999 }} /> : null}
                  </div>
                </div>
              </div>
              {detail ? (
                <details open={print} style={{ borderTop: `1px solid ${BORDER}`, padding: '9px 14px' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: MUTED, listStyle: 'none' }}>
                    What this means
                  </summary>
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

// ── 2b. Top insights (cause → effect → action) ──────────────────────────────────
const INSIGHT_CONFIDENCE = {
  measured: 'Measured on site',
  tech_confirmed: 'Confirmed by your technician',
  ai_supported: 'Seen in today’s photos',
  area_estimated: 'Estimated for your area',
};

export function LawnInsightCards({ insights = [], limit = 3 }) {
  const top = [...insights.filter(Boolean)]
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .slice(0, limit);
  if (!top.length) return null;
  return (
    <Card>
      <CardTitle sub="The few things that actually matter from today’s visit.">What we’re paying attention to</CardTitle>
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

function InsightLine({ label, value, strong }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.5, color: strong ? TEXT : BODY }}>
      <span style={{ fontWeight: 700, color: strong ? statusMeta('healthy').color : MUTED }}>{label}: </span>
      {value}
    </div>
  );
}

// ── 3. Water This Week (stacked bar vs target band) ──────────────────────────────
export function WaterIntakeBar({ water = {}, irrigationHref = '/?tab=property', aftercare = null }) {
  const mounted = useMounted();
  if (!water) return null;
  const rain = Number(water.rainInches);
  const irrigation = Number(water.irrigationInches);
  const target = Number(water.targetInches);
  const hasRain = Number.isFinite(rain);
  const hasIrr = Number.isFinite(irrigation);
  // Nothing measurable → don't draw an empty chart.
  if (!hasRain && !hasIrr) return null;

  const total = Number.isFinite(Number(water.totalInches))
    ? Number(water.totalInches)
    : (hasRain ? rain : 0) + (hasIrr ? irrigation : 0);
  const status = water.status || 'unknown';
  const meta = statusMeta(status === 'unknown' ? 'tracking' : status);
  const axisMax = Math.max(total, Number.isFinite(target) ? target : 0) * 1.25 || 2;
  const pctOf = (v) => `${clamp((v / axisMax) * 100)}%`;

  return (
    <Card>
      <CardTitle sub="Rain in your area plus the irrigation schedule we have on file.">Water This Week</CardTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '4px 18px', fontSize: 14, color: BODY, marginBottom: 14 }}>
        {hasRain ? <><span style={{ color: MUTED }}>Rain</span><strong style={{ textAlign: 'right', color: TEXT }}>{inchLabel(rain)}</strong></> : null}
        {hasIrr ? <><span style={{ color: MUTED }}>Irrigation</span><strong style={{ textAlign: 'right', color: TEXT }}>{inchLabel(irrigation)}</strong></> : null}
        <span style={{ color: MUTED }}>Total</span><strong style={{ textAlign: 'right', color: TEXT }}>{inchLabel(total)}</strong>
        {Number.isFinite(target) ? <><span style={{ color: MUTED }}>Target range</span><strong style={{ textAlign: 'right', color: TEXT }}>~{inchLabel(Math.max(0, target - 0.25))}–{inchLabel(target + 0.25)}/wk</strong></> : null}
      </div>
      {/* Stacked bar with a target marker — segments grow on mount */}
      <div style={{ position: 'relative', height: 26, borderRadius: 8, background: '#F1EEE6', overflow: 'hidden' }}>
        {hasRain ? <div title="Rain" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: mounted ? pctOf(rain) : '0%', background: COLORS.teal, transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1)' }} /> : null}
        {hasIrr ? <div title="Irrigation" style={{ position: 'absolute', left: hasRain ? (mounted ? pctOf(rain) : '0%') : 0, top: 0, bottom: 0, width: mounted ? pctOf(irrigation) : '0%', background: '#7CB9E8', transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1) 0.1s, left 0.8s cubic-bezier(0.4,0,0.2,1)' }} /> : null}
        {Number.isFinite(target) ? (
          <div style={{ position: 'absolute', left: pctOf(target), top: -3, bottom: -3, width: 3, background: TEXT, borderRadius: 2, opacity: mounted ? 1 : 0, transition: 'opacity 0.4s ease 0.7s' }} title="Target" />
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11.5, color: MUTED }}>
        {hasRain ? <Legend color={COLORS.teal} label="Rain" /> : null}
        {hasIrr ? <Legend color="#7CB9E8" label="Irrigation" /> : null}
        {Number.isFinite(target) ? <Legend color={TEXT} label="Target" /> : null}
      </div>
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusPill status={status === 'unknown' ? 'tracking' : status} small />
        {water.confidence ? <ConfidenceTag confidence={water.confidence} /> : null}
      </div>
      {water.explanation ? (
        <p style={{ margin: '12px 0 0', fontSize: 14, color: BODY, lineHeight: 1.55 }}>{water.explanation}</p>
      ) : null}
      {/* Amount-adequate but a localized dry/uneven area → coverage, not "water more". */}
      {water.coverageWatch ? (
        <div className="lawn-callout-watch" style={{ marginTop: 10, padding: '9px 12px', background: COLORS.sand, border: `1px solid ${COLORS.orange}`, borderRadius: 8, fontSize: 13, color: BODY, lineHeight: 1.5 }}>
          <strong style={{ color: TEXT }}>Coverage watch:</strong> total weekly water looks adequate, but a few areas may not be getting even coverage — worth checking that your sprinklers reach those spots rather than watering the whole lawn more.
        </div>
      ) : null}
      {/* Watering after today, from the product label (or a safe default). */}
      {aftercare && aftercare.watering ? (
        <div className="lawn-callout-after" style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BORDER}`, fontSize: 13.5, color: BODY, lineHeight: 1.5 }}>
          <strong style={{ color: TEXT }}>After today’s visit:</strong> {aftercare.watering}
          {aftercare.reentry ? <div style={{ marginTop: 4, fontSize: 12.5, color: MUTED }}>{aftercare.reentry}</div> : null}
        </div>
      ) : null}
      {/* No usable irrigation schedule on file → a real CTA (not a text link)
          explaining the payoff (a precise reading) and deep-linking to the portal to
          add it. Keyed off water.scheduleOnFile alone (the server treats a
          0/absent/disabled schedule as "not on file"), so a finite-zero irrigation
          with a known rain status still shows the CTA; once a real schedule is
          added, scheduleOnFile flips true and this hides. */}
      {!water.scheduleOnFile && irrigationHref ? (
        <div className="lawn-water-cta" style={{ marginTop: 14, padding: '13px 15px', background: COLORS.sand, border: `1px solid ${BORDER}`, borderRadius: 12 }}>
          <div style={{ fontFamily: FONTS.heading, fontWeight: 800, fontSize: 14.5, color: TEXT }}>Get a water reading built for your lawn</div>
          <div style={{ fontSize: 13.5, color: BODY, lineHeight: 1.5, margin: '4px 0 11px' }}>
            We’re estimating right now because we don’t have your watering schedule yet. Add it once and every report is tailored to exactly what your lawn gets.
          </div>
          <a
            data-glass-accent=""
            href={irrigationHref}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              background: COLORS.blueDeeper, color: '#fff', textDecoration: 'none',
              fontFamily: FONTS.heading, fontWeight: 800, fontSize: 14,
              padding: '11px 18px', borderRadius: 999,
            }}
          >
            Add your watering schedule →
          </a>
        </div>
      ) : null}
    </Card>
  );
}

function Legend({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />{label}
    </span>
  );
}

function ConfidenceTag({ confidence }) {
  const map = { high: 'Verified data', medium: 'Estimated for your area', low: 'Limited data this week' };
  return <span style={{ fontSize: 12, color: MUTED, fontStyle: 'italic' }}>{map[confidence] || ''}</span>;
}

// ── 4. Rain in your area — last 7 days ───────────────────────────────────────────
export function RainLast7DaysChart({ days = [], confidence = null }) {
  const mounted = useMounted();
  const [active, setActive] = useState(null);
  const data = (days || []).filter((d) => d && Number.isFinite(Number(d.in)));
  if (!data.length) return null;
  const max = Math.max(0.25, ...data.map((d) => Number(d.in)));
  return (
    <Card>
      <CardTitle sub="Why we’re talking about watering. Tap a bar for the day’s total.">Rain in Your Area — Last 7 Days</CardTitle>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 116, marginTop: 4 }}>
        {data.map((d, i) => {
          const v = Number(d.in);
          const h = Math.round((v / max) * 74);
          const on = active === i;
          return (
            <div
              key={i}
              onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)} onClick={() => setActive((a) => (a === i ? null : i))}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: 'pointer' }}
            >
              <div style={{ fontSize: 10.5, color: on ? TEXT : MUTED, fontWeight: on ? 700 : 400 }}>{(on || v) ? inchLabel(v) || '0"' : ''}</div>
              <div style={{
                width: '100%', maxWidth: 26, height: Math.max(2, mounted ? h : 0),
                background: v ? (on ? COLORS.blueDeeper : COLORS.teal) : BORDER, borderRadius: 4,
                transition: `height 0.7s cubic-bezier(0.4,0,0.2,1) ${i * 45}ms, background 0.15s ease`,
              }} />
              <div style={{ fontSize: 11, color: on ? TEXT : MUTED, fontWeight: on ? 700 : 400 }}>{d.d}</div>
            </div>
          );
        })}
      </div>
      {/* City-collective fallback week (a single-cell model spike was smoothed out) →
          be honest that this is an area estimate, not a precise per-address reading. */}
      {confidence === 'low' ? (
        <div style={{ marginTop: 10 }}><ConfidenceTag confidence="low" /></div>
      ) : null}
    </Card>
  );
}

// ── 5. Mowing height gauge ───────────────────────────────────────────────────────
export function MowingHeightGauge({ mowing = {} }) {
  if (!mowing) return null; // explicit null bypasses the default — e.g. no turf reading this visit
  // Photo-only rows send measuredHeightInches: null — guard the null BEFORE Number()
  // (Number(null) === 0 would otherwise render a false 0-inch / "too short" gauge).
  const measured = mowing.measuredHeightInches == null ? NaN : Number(mowing.measuredHeightInches);
  const lo = Number(mowing.idealMinInches);
  const hi = Number(mowing.idealMaxInches);
  const hasGauge = Number.isFinite(measured) && Number.isFinite(lo) && Number.isFinite(hi);
  const photoUrl = mowing.photoUrl || null;
  // Nothing to show this visit — no numeric reading and no on-site lawn-length photo.
  if (!hasGauge && !photoUrl) return null;
  const axisMin = 0;
  const axisMax = hasGauge ? Math.max(hi + 1, measured + 0.5) : 0;
  const pct = (v) => `${clamp(((v - axisMin) / (axisMax - axisMin)) * 100)}%`;
  const status = hasGauge ? (mowing.status || (measured < lo ? 'too_short' : measured > hi ? 'too_tall' : 'ideal')) : null;
  return (
    <Card>
      <CardTitle sub="The maintained height of cut we measured before today’s visit.">Mowing Height</CardTitle>
      {hasGauge ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '4px 18px', fontSize: 14, color: BODY, marginBottom: 16 }}>
            <span style={{ color: MUTED }}>Measured</span><strong style={{ textAlign: 'right', color: TEXT }}>{inchLabel(measured)}</strong>
            <span style={{ color: MUTED }}>Ideal range</span><strong style={{ textAlign: 'right', color: TEXT }}>{inchLabel(lo)}–{inchLabel(hi)}</strong>
          </div>
          <div style={{ position: 'relative', height: 34 }}>
            <div style={{ position: 'absolute', left: 0, right: 0, top: 13, height: 8, borderRadius: 6, background: '#F1EEE6' }} />
            {/* ideal band */}
            <div style={{ position: 'absolute', left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})`, top: 13, height: 8, borderRadius: 6, background: COLORS.greenLight, border: `1px solid ${COLORS.green}` }} />
            {/* measured marker */}
            <div style={{ position: 'absolute', left: pct(measured), top: 4, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: 3, height: 26, background: statusMeta(status).color, borderRadius: 2 }} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: MUTED, marginTop: 4 }}>
            <span>Too short</span><span>Ideal</span><span>Too tall</span>
          </div>
          <div style={{ marginTop: 12 }}><StatusPill status={status} small /></div>
        </>
      ) : null}
      {photoUrl ? (
        <figure style={{ margin: hasGauge ? '16px 0 0' : 0 }}>
          <img src={photoUrl} alt="On-site lawn length" loading="lazy"
            style={{ width: '100%', borderRadius: 10, display: 'block', border: `1px solid ${COLORS.greenLight}` }} />
          <figcaption style={{ marginTop: 6, fontSize: 12, color: MUTED }}>On-site lawn length</figcaption>
        </figure>
      ) : null}
      {mowing.recommendation ? (
        <p style={{ margin: '12px 0 0', fontSize: 14, color: BODY, lineHeight: 1.55 }}>{mowing.recommendation}</p>
      ) : null}
    </Card>
  );
}

// ── 5b. What Waves did today (solutions / products applied) ──────────────────────
const KIND_DOT = {
  fungicide: COLORS.teal, herbicide: COLORS.orange, pre_emergent: COLORS.orange,
  insecticide: COLORS.red, fertilizer: COLORS.green, supplement: COLORS.green, other: COLORS.grayMid,
};

export function LawnTreatmentCard({ treatment = {} }) {
  const products = Array.isArray(treatment.products) ? treatment.products : [];
  const focus = Array.isArray(treatment.focus) ? treatment.focus : [];
  if (!products.length && !focus.length) return null;
  return (
    <Card>
      <CardTitle sub="The treatment and products applied on this visit.">What Waves did today</CardTitle>
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

// ── 5c. Visit timeline (visual, animated) ────────────────────────────────────────
const TIMELINE_ICON = {
  technician_en_route: '🚚', en_route: '🚚', arrived_on_site: '📍', technician_on_site: '📍',
  inspection_started: '🔍', service_started: '🌱', service_completed: '✓', report_published: '📋',
  quality_reviewed: '✓',
};
export function LawnVisitTimeline({ timeline = {} }) {
  const mounted = useMounted();
  const events = timeline && Array.isArray(timeline.events) ? timeline.events.filter(Boolean) : [];
  if (!events.length) return null;
  return (
    <Card>
      <CardTitle sub={timeline.intro || 'How today’s visit went, step by step.'}>{timeline.title || 'Visit Timeline'}</CardTitle>
      <div style={{ position: 'relative' }}>
        {events.map((e, i) => {
          const desc = e.customerVisibleDescription || e.customerDescription || '';
          const isLast = i === events.length - 1;
          return (
            <div
              key={e.id || i}
              style={{
                display: 'flex', gap: 14, position: 'relative', paddingBottom: isLast ? 0 : 20,
                opacity: mounted ? 1 : 0, transform: mounted ? 'none' : 'translateY(6px)',
                transition: `opacity 0.45s ease ${i * 90}ms, transform 0.45s ease ${i * 90}ms`,
              }}
            >
              {!isLast ? <span style={{ position: 'absolute', left: 13, top: 28, bottom: 0, width: 2, background: BORDER }} /> : null}
              <span style={{ flex: 'none', width: 28, height: 28, borderRadius: 999, background: COLORS.green, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 14, fontWeight: 800, zIndex: 1 }}>
                {TIMELINE_ICON[e.type] || '•'}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 14.5, color: TEXT }}>{e.label}</span>
                  {e.displayTime ? <span style={{ fontFamily: FONTS.mono, fontSize: 12.5, color: MUTED, flex: 'none' }}>{e.displayTime}</span> : null}
                </div>
                {desc ? <div style={{ fontSize: 13, color: BODY, lineHeight: 1.45, marginTop: 2 }}>{desc}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
      {timeline.footnote || timeline.disclaimer ? (
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 12, lineHeight: 1.45 }}>{timeline.footnote || timeline.disclaimer}</div>
      ) : null}
    </Card>
  );
}

// Score badge overlaid on a corner of the comparison image.
function ScoreBadge({ score, side }) {
  if (!Number.isFinite(toScore(score))) return null;
  return (
    <div style={{
      position: 'absolute', bottom: 10, [side]: 10, zIndex: 3,
      background: 'rgba(27,44,91,0.86)', color: '#fff', borderRadius: 999, padding: '3px 10px',
      fontFamily: FONTS.heading, fontWeight: 800, fontSize: 13, lineHeight: 1,
    }}>{Math.round(toScore(score))}</div>
  );
}
function CornerLabel({ text, side }) {
  return (
    <div style={{
      position: 'absolute', top: 10, [side]: 10, zIndex: 3,
      background: 'rgba(0,0,0,0.42)', color: '#fff', borderRadius: 6, padding: '3px 8px',
      fontSize: 11.5, fontWeight: 600, lineHeight: 1.2, maxWidth: '46%',
    }}>{text}</div>
  );
}

// Same-lawn BEFORE/AFTER wipe slider — drag the divider to reveal the first vs the
// latest treatment of the same lawn (with each photo's score). One image slides into
// the other. In print it falls back to a side-by-side pair (no drag in a PDF).
export function LawnProgressionSlider({ frames = [], note = null }) {
  const print = usePrint();
  const pics = (frames || []).filter((f) => f && f.url);
  const [pos, setPos] = useState(50);
  const ref = useRef(null);
  const dragging = useRef(false);
  if (pics.length < 2) return null;

  const before = pics[0];
  const after = pics[pics.length - 1];
  const delta = toScore(after.score) - toScore(before.score);
  const H = 260;

  const setFromX = (clientX) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  const onDown = (e) => { dragging.current = true; try { ref.current.setPointerCapture(e.pointerId); } catch (err) { /* noop */ } setFromX(e.clientX); };
  const onMove = (e) => { if (dragging.current) setFromX(e.clientX); };
  const onUp = () => { dragging.current = false; };

  return (
    <Card>
      <CardTitle sub={print ? 'The first and latest look at the same lawn.' : 'Drag the slider to compare the first and latest look at the same lawn.'}>Your progress</CardTitle>

      {print ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[['First visit', before], ['Now', after]].map(([lbl, f], i) => (
            <figure key={i} style={{ margin: 0, position: 'relative' }}>
              <img src={f.url} alt={lbl} style={{ width: '100%', height: 180, objectFit: 'cover', borderRadius: 10, border: `1px solid ${BORDER}`, display: 'block' }} />
              <figcaption style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: MUTED, marginTop: 6 }}>
                <span>{lbl}{f.label ? ` · ${f.label}` : ''}</span>
                {Number.isFinite(toScore(f.score)) ? <span style={{ fontWeight: 800, color: statusMeta(scoreStatus(f.score)).color }}>{Math.round(toScore(f.score))}</span> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div
          ref={ref}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          style={{ position: 'relative', height: H, borderRadius: 12, overflow: 'hidden', border: `1px solid ${BORDER}`, cursor: 'ew-resize', touchAction: 'none', userSelect: 'none' }}
        >
          {/* AFTER (latest) is the base layer */}
          <img src={after.url} alt="Now" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          {/* BEFORE (first) clipped to the divider position */}
          <img src={before.url} alt="First visit" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', clipPath: `inset(0 ${100 - pos}% 0 0)` }} />

          <CornerLabel text={`First visit${before.label ? ` · ${before.label}` : ''}`} side="left" />
          <CornerLabel text={`Now${after.label ? ` · ${after.label}` : ''}`} side="right" />
          <ScoreBadge score={before.score} side="left" />
          <ScoreBadge score={after.score} side="right" />

          {/* Divider + handle */}
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${pos}%`, width: 2, background: '#fff', boxShadow: '0 0 4px rgba(0,0,0,0.5)', zIndex: 4 }} />
          <div style={{
            position: 'absolute', top: '50%', left: `${pos}%`, transform: 'translate(-50%,-50%)', zIndex: 5,
            width: 38, height: 38, borderRadius: 999, background: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.4)',
            display: 'grid', placeItems: 'center', color: TEXT, fontSize: 16, fontWeight: 800,
          }}>↔</div>
        </div>
      )}

      {Number.isFinite(delta) && delta !== 0 ? (
        <div style={{ marginTop: 12, fontSize: 14.5, color: BODY }}>
          <strong style={{ color: delta > 0 ? COLORS.green : COLORS.orange }}>{delta > 0 ? '+' : ''}{delta} points</strong> overall since your first assessment.
        </div>
      ) : null}
      {note ? (
        <div style={{ marginTop: 10, padding: '9px 12px', background: COLORS.sand, border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, color: BODY, lineHeight: 1.5 }}>{note}</div>
      ) : null}
    </Card>
  );
}

// ── 6. Trends across visits ──────────────────────────────────────────────────────
// Reusable line chart. points = [{ label, value }]. Needs 2+ scored points to draw
// (a single visit has no trend — matches V1, which hides the trend until 2+ visits).
export function LawnTrendChart({ title, sub, points = [], domain, unit = '', accent = COLORS.teal, zeroLine = false, band = null, compact = false, footnote = null }) {
  const mounted = useMounted();
  const [active, setActive] = useState(null);
  const gidRef = useRef(`lg-${Math.random().toString(36).slice(2)}`);
  const pts = (points || []).map((p) => ({ label: p.label, value: toScore(p.value) }))
    .filter((p) => Number.isFinite(p.value));
  if (pts.length < 2) return null;

  const W = 300;
  const H = compact ? 96 : 132;
  const padX = 12;
  const padTop = 16;
  const padBottom = 22;
  const vals = pts.map((p) => p.value);
  let lo = domain ? domain[0] : Math.min(...vals);
  let hi = domain ? domain[1] : Math.max(...vals);
  if (zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { lo -= 1; hi += 1; }
  if (!domain) { const pad = (hi - lo) * 0.18 || 1; lo -= pad; hi += pad; }

  const x = (i) => padX + (i * (W - 2 * padX)) / (pts.length - 1);
  const y = (v) => padTop + (1 - (v - lo) / (hi - lo)) * (H - padTop - padBottom);
  const fmt = (v) => `${Number.isInteger(v) ? v : Number(v.toFixed(2))}${unit}`;
  const last = pts[pts.length - 1];
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const baseY = H - padBottom;
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;
  const gid = gidRef.current;
  const activePt = active != null ? pts[active] : null;
  const labelX = (i) => Math.max(padX + 14, Math.min(W - padX - 14, x(i)));

  return (
    <Card style={compact ? { marginBottom: 0, padding: 16 } : undefined}>
      <CardTitle sub={compact ? undefined : sub}>{title}</CardTitle>
      {compact ? <div style={{ fontSize: 12, color: MUTED, marginTop: -8, marginBottom: 8 }}>{sub}</div> : null}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${title} trend`} onMouseLeave={() => setActive(null)} style={{ touchAction: 'pan-y' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.28" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        {band && Number.isFinite(band[0]) && Number.isFinite(band[1]) ? (
          <rect x={padX} y={y(Math.min(band[1], hi))} width={W - 2 * padX}
                height={Math.max(0, y(Math.max(band[0], lo)) - y(Math.min(band[1], hi)))}
                fill={COLORS.greenLight} opacity="0.7" />
        ) : null}
        {zeroLine ? <line x1={padX} x2={W - padX} y1={y(0)} y2={y(0)} stroke={BORDER} strokeDasharray="3 3" /> : null}
        {/* gradient area fades in; line draws on mount */}
        <path d={area} fill={`url(#${gid})`} opacity={mounted ? 1 : 0} style={{ transition: 'opacity 0.6s ease 0.25s' }} />
        <path
          d={line} fill="none" stroke={accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          pathLength="1" strokeDasharray="1" strokeDashoffset={mounted ? 0 : 1}
          style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)' }}
        />
        {active != null ? <line x1={x(active)} x2={x(active)} y1={padTop - 4} y2={baseY} stroke={accent} strokeOpacity="0.3" strokeDasharray="3 3" /> : null}
        {pts.map((p, i) => (
          <g key={i}>
            <circle
              cx={x(i)} cy={y(p.value)} r={active === i ? 6 : (i === pts.length - 1 ? 4.5 : 3)}
              fill={active === i || i === pts.length - 1 ? accent : CARD} stroke={accent} strokeWidth="2"
              style={{ transition: 'r 0.15s ease' }}
            />
            {/* generous transparent hit target for hover/tap */}
            <circle cx={x(i)} cy={y(p.value)} r="13" fill="transparent" style={{ cursor: 'pointer' }}
              onMouseEnter={() => setActive(i)} onClick={() => setActive((a) => (a === i ? null : i))} />
          </g>
        ))}
        {activePt ? (
          <text x={labelX(active)} y={y(activePt.value) - 11} textAnchor="middle" style={{ fontFamily: FONTS.heading, fontWeight: 800, fill: accent }} fontSize="13">{fmt(activePt.value)}</text>
        ) : (
          <text x={x(pts.length - 1)} y={y(last.value) - 9} textAnchor="end" style={{ fontFamily: FONTS.heading, fontWeight: 800, fill: accent }} fontSize="13">{fmt(last.value)}</text>
        )}
        {pts.map((p, i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" style={{ fontFamily: FONTS.body, fill: active === i ? TEXT : MUTED, fontWeight: active === i ? 700 : 400 }} fontSize="10.5">{p.label}</text>
        ))}
      </svg>
      {footnote ? (
        <div style={{ marginTop: 8, padding: '8px 11px', background: COLORS.sand, border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12.5, color: BODY, lineHeight: 1.5 }}>{footnote}</div>
      ) : null}
    </Card>
  );
}

// Picks an accent color for a trend's latest point so the line reads at a glance.
function scoreAccent(v) { return statusMeta(scoreStatus(v)).color; }
function bandAccent(v, lo, hi) { return v >= lo && v <= hi ? COLORS.green : COLORS.orange; }
function gapAccent(v) { return Math.abs(Number(v)) <= 0.25 ? COLORS.green : COLORS.orange; }
const lastVal = (pts = []) => { const f = [...pts].reverse().find((p) => Number.isFinite(toScore(p.value))); return f ? toScore(f.value) : NaN; };

export function LawnTrends({ trends = {} }) {
  const { overall, waterGap, mowing, weed, stress, coverage, color, mowingBand = [3.5, 4.0], seasonalNote } = trends;
  const hasOverall = (overall || []).filter((p) => Number.isFinite(toScore(p.value))).length >= 2;
  const minis = [
    waterGap && { key: 'water', title: 'Water Gap', sub: 'vs. weekly target', points: waterGap, unit: '"', zeroLine: true, accent: gapAccent(lastVal(waterGap)) },
    mowing && { key: 'mow', title: 'Mowing Height', sub: 'vs. ideal band', points: mowing, unit: '"', band: mowingBand, accent: bandAccent(lastVal(mowing), mowingBand[0], mowingBand[1]) },
    weed && { key: 'weed', title: 'Weed Cleanliness', sub: 'higher is better', points: weed, domain: [0, 100], accent: scoreAccent(lastVal(weed)) },
    coverage && { key: 'cov', title: 'Turf Coverage', sub: 'higher is better', points: coverage, domain: [0, 100], accent: scoreAccent(lastVal(coverage)) },
    color && { key: 'color', title: 'Color & Vigor', sub: 'higher is better', points: color, domain: [0, 100], accent: scoreAccent(lastVal(color)) },
    stress && { key: 'stress', title: 'Stress / Damage', sub: 'higher is better', points: stress, domain: [0, 100], accent: scoreAccent(lastVal(stress)) },
  ].filter(Boolean).filter((m) => (m.points || []).filter((p) => Number.isFinite(toScore(p.value))).length >= 2);

  if (!hasOverall && !minis.length) return null;
  return (
    <>
      {hasOverall ? (
        <LawnTrendChart title="Lawn Health Trend" sub="Your overall lawn score across recent visits."
          points={overall} domain={[0, 100]} accent={scoreAccent(lastVal(overall))}
          footnote={seasonalNote} />
      ) : null}
      {minis.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 16 }}>
          {minis.map((m) => (
            <LawnTrendChart key={m.key} compact title={m.title} sub={m.sub} points={m.points}
              domain={m.domain} unit={m.unit} zeroLine={m.zeroLine} band={m.band} accent={m.accent} />
          ))}
        </div>
      ) : null}
    </>
  );
}
