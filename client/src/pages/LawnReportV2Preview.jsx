// DEV-ONLY preview for the Lawn Report V2 visual layer (route: /report-v2-preview).
// Renders the V2 components against mock data shaped like the eventual
// GET /api/reports/:token/data lawn payload, so we can iterate on the visuals in
// Chrome DevTools without the backend or DB. Mirrors the /track-preview pattern.
// Not linked anywhere; safe to leave out of production builds.

import { useState } from 'react';
import { COLORS, FONTS } from '../theme-brand';
import {
  LawnSnapshotHero,
  LawnInsightCards,
  VisualDiagnosisCards,
  WaterIntakeBar,
  RainLast7DaysChart,
  MowingHeightGauge,
  LawnTreatmentCard,
  LawnTrends,
} from '../components/report/lawnV2/LawnReportV2';

const BG = '#FAF8F3';
const BORDER = '#E7E2D7';
const TEXT = '#1B2C5B';

// Scenario A — healthy lawn, one thing to watch (water coverage).
const HEALTHY = {
  city: 'Lakewood Ranch',
  snapshot: {
    overallScore: 82,
    status: 'healthy',
    statusHeadline: 'Stable — watching water coverage',
    todaysFocus: ['Seasonal stress support', 'Color support', 'Pest scouting'],
    mainWatch: 'A dry-looking area near the front/right zone.',
    customerAction: 'Check sprinkler coverage in that area. No other action needed right now.',
  },
  diagnosis: [
    { key: 'coverage', label: 'Turf Coverage', score: 86, explanation: 'Thick and well covered — no bare spots showing.' },
    { key: 'color_vigor', label: 'Color & Vigor', score: 78, explanation: 'Healthy, fairly even green across the lawn.' },
    { key: 'weed_pressure', label: 'Weed Pressure', score: 91, explanation: 'Very little weed activity visible today.' },
    { key: 'water_moisture_stress', label: 'Water / Moisture', score: 62, explanation: 'One area looks dry — likely a coverage gap, not total watering.' },
    { key: 'damage_disease_signals', label: 'Damage Signals', score: 74, explanation: 'No clear stress patterns to monitor right now.' },
  ],
  water: {
    rainInches: 0.9, irrigationInches: 0.7, totalInches: 1.6, targetInches: 1.5,
    status: 'balanced', confidence: 'medium',
    explanation: 'Your area received about 0.9" of rain this week, and the irrigation schedule on file adds about 0.7". Total water is about 1.6" — close to target. Because one area still looks dry, we recommend checking sprinkler coverage there rather than watering the whole yard more.',
  },
  rain7d: [
    { d: 'Mon', in: 0.0 }, { d: 'Tue', in: 0.2 }, { d: 'Wed', in: 0.0 }, { d: 'Thu', in: 0.7 },
    { d: 'Fri', in: 0.0 }, { d: 'Sat', in: 0.1 }, { d: 'Sun', in: 0.0 },
  ],
  mowing: {
    measuredHeightInches: 2.75, idealMinInches: 3.5, idealMaxInches: 4.0, grassType: 'st_augustine',
    status: 'too_short',
    recommendation: 'Your lawn is being kept a bit shorter than ideal. Short mowing makes turf show heat and dry stress faster — consider raising the mower one setting.',
  },
  insights: [
    {
      priority: 1, status: 'watch', confidence: 'area_estimated',
      headline: 'Water coverage is the main thing to watch',
      whatWeSaw: 'One area near the front/right still looks dry even though total water for the week is on target.',
      whyItMatters: 'That pattern usually points to uneven sprinkler coverage, not under-watering the whole lawn.',
      wavesAction: 'We documented the dry area and will recheck it next visit.',
      customerAction: 'Check sprinkler coverage in that zone.',
    },
    {
      priority: 2, status: 'watch', confidence: 'measured',
      headline: 'Lawn is being mowed a bit short',
      whatWeSaw: 'Measured 2.75" against the 3.5–4" ideal range for St. Augustine.',
      whyItMatters: 'Short mowing makes turf show heat and dry stress faster.',
      wavesAction: 'Logged the height for your file — we don’t mow, so this is a heads-up.',
      customerAction: 'Raise the mower one setting.',
    },
    {
      priority: 3, status: 'healthy', confidence: 'ai_supported',
      headline: 'Color and density are holding well',
      whatWeSaw: 'Coverage scored 86 and color 78 — strong and fairly even.',
      whyItMatters: 'Your lawn is responding well to the seasonal program.',
      wavesAction: 'Applied seasonal stress and color support today.',
      nextVisitPlan: 'Continue the program and recheck the dry zone.',
    },
  ],
  treatment: {
    focus: ['Color & growth', 'Weed prevention', 'Pest scouting'],
    kinds: ['fertilizer', 'pre_emergent'],
    products: [
      { name: 'Slow-release lawn fertilizer', activeIngredient: '16-4-8 w/ iron', kind: 'fertilizer', whatItDoes: 'Feeds the lawn to support density, color, and recovery heading into the active growth season.', targets: ['turf'], area: '6,200 sqft' },
      { name: 'Pre-emergent herbicide', activeIngredient: 'prodiamine', kind: 'pre_emergent', whatItDoes: 'A pre-emergent that stops crabgrass and many weeds before they sprout.', targets: ['weeds'], area: '6,200 sqft' },
    ],
  },
  trends: {
    overall: [{ label: 'Apr', value: 72 }, { label: 'May', value: 76 }, { label: 'Jun 1', value: 81 }, { label: 'Jun 22', value: 82 }],
    waterGap: [{ label: 'Apr', value: -0.3 }, { label: 'May', value: 0.1 }, { label: 'Jun 1', value: 0.0 }, { label: 'Jun 22', value: 0.1 }],
    mowing: [{ label: 'Apr', value: 3.6 }, { label: 'May', value: 3.2 }, { label: 'Jun 1', value: 2.9 }, { label: 'Jun 22', value: 2.75 }],
    weed: [{ label: 'Apr', value: 84 }, { label: 'May', value: 88 }, { label: 'Jun 1', value: 90 }, { label: 'Jun 22', value: 91 }],
    mowingBand: [3.5, 4.0],
  },
};

// Scenario B — a lawn with a real problem, to review the amber/red states.
const NEEDS_ATTENTION = {
  city: 'Bradenton',
  snapshot: {
    overallScore: 54,
    status: 'needs_attention',
    statusHeadline: 'Needs attention — likely over-watering',
    todaysFocus: ['Fungus pressure support', 'Weed control', 'Moisture management'],
    mainWatch: 'Mushrooms and damp patches that point to too much water.',
    customerAction: 'Reduce irrigation runtime by one cycle and let us know if it stays soggy.',
  },
  diagnosis: [
    { key: 'coverage', label: 'Turf Coverage', score: 58, explanation: 'Some thinning and patchiness in the wetter areas.' },
    { key: 'color_vigor', label: 'Color & Vigor', score: 49, explanation: 'Uneven color with yellowing in spots.' },
    { key: 'weed_pressure', label: 'Weed Pressure', score: 44, explanation: 'Noticeable weed activity competing with the turf.' },
    { key: 'water_moisture_stress', label: 'Water / Moisture', score: 31, explanation: 'Mushrooms and damp areas suggest the lawn is staying too wet.' },
    { key: 'damage_disease_signals', label: 'Damage Signals', score: null, explanation: '' },
  ],
  water: {
    rainInches: 1.6, irrigationInches: 1.2, totalInches: 2.8, targetInches: 1.5,
    status: 'high', confidence: 'high',
    explanation: 'Your area received about 1.6" of rain this week and the irrigation schedule adds about 1.2", for roughly 2.8" total — well above the ~1.5" target. The mushrooms in today’s photos line up with over-watering, so easing back on irrigation should help reduce fungus and weed pressure.',
  },
  rain7d: [
    { d: 'Mon', in: 0.3 }, { d: 'Tue', in: 0.6 }, { d: 'Wed', in: 0.1 }, { d: 'Thu', in: 0.4 },
    { d: 'Fri', in: 0.0 }, { d: 'Sat', in: 0.2 }, { d: 'Sun', in: 0.0 },
  ],
  mowing: {
    measuredHeightInches: 3.75, idealMinInches: 3.5, idealMaxInches: 4.0, grassType: 'st_augustine',
    status: 'ideal',
    recommendation: 'Mowing height looks good — right in the ideal range for St. Augustine.',
  },
  insights: [
    {
      priority: 1, status: 'needs_attention', confidence: 'tech_confirmed',
      headline: 'The lawn is likely getting too much water',
      whatWeSaw: 'Mushrooms and damp patches in today’s photos, with about 2.8" of total water this week against a ~1.5" target.',
      whyItMatters: 'Staying too wet drives fungus, mushrooms, and weed pressure and weakens the turf.',
      wavesAction: 'Treated for fungus pressure and flagged the moisture for follow-up.',
      customerAction: 'Reduce irrigation by one cycle and let us know if it stays soggy.',
    },
    {
      priority: 2, status: 'needs_attention', confidence: 'ai_supported',
      headline: 'Weed pressure is climbing',
      whatWeSaw: 'Noticeable weeds competing with thinning turf in the wetter areas.',
      whyItMatters: 'Wet, weak turf gives weeds room to take hold.',
      wavesAction: 'Spot-treated weeds and adjusted the plan toward recovery.',
      customerAction: 'Hold off on any extra watering for now.',
    },
    {
      priority: 3, status: 'watch', confidence: 'ai_supported',
      headline: 'Some thinning and uneven color',
      whatWeSaw: 'Coverage scored 58 and color 49, mostly in the soggier spots.',
      whyItMatters: 'Turf thins out when it can’t dry between waterings.',
      wavesAction: 'Shifted the program toward density recovery.',
      nextVisitPlan: 'Recheck density once the moisture eases.',
    },
  ],
  treatment: {
    focus: ['Fungus protection', 'Weed control', 'Moisture management'],
    kinds: ['fungicide', 'herbicide'],
    products: [
      { name: 'Systemic fungicide', activeIngredient: 'azoxystrobin', kind: 'fungicide', whatItDoes: 'Helps protect turf where fungus pressure or wet conditions call for it.', targets: ['fungus'], area: '5,400 sqft' },
      { name: 'Selective post-emergent', activeIngredient: 'celsius wg', kind: 'herbicide', whatItDoes: 'Targets actively growing broadleaf and grassy weeds in warm-season turf.', targets: ['weeds'], area: 'spot-treat' },
    ],
  },
  trends: {
    overall: [{ label: 'Apr', value: 68 }, { label: 'May', value: 62 }, { label: 'Jun 1', value: 58 }, { label: 'Jun 22', value: 54 }],
    waterGap: [{ label: 'Apr', value: 0.4 }, { label: 'May', value: 0.8 }, { label: 'Jun 1', value: 1.0 }, { label: 'Jun 22', value: 1.3 }],
    mowing: [{ label: 'Apr', value: 3.7 }, { label: 'May', value: 3.8 }, { label: 'Jun 1', value: 3.75 }, { label: 'Jun 22', value: 3.75 }],
    weed: [{ label: 'Apr', value: 60 }, { label: 'May', value: 52 }, { label: 'Jun 1', value: 47 }, { label: 'Jun 22', value: 44 }],
    mowingBand: [3.5, 4.0],
  },
};

export default function LawnReportV2Preview() {
  const [scenario, setScenario] = useState('healthy');
  const data = scenario === 'healthy' ? HEALTHY : NEEDS_ATTENTION;
  const placeLabel = data.city ? `your ${data.city} lawn` : 'your lawn';

  const tabBtn = (key, label) => (
    <button
      type="button"
      onClick={() => setScenario(key)}
      style={{
        padding: '7px 14px', borderRadius: 999, cursor: 'pointer',
        border: `1px solid ${scenario === key ? TEXT : BORDER}`,
        background: scenario === key ? TEXT : COLORS.white,
        color: scenario === key ? COLORS.white : TEXT,
        fontFamily: FONTS.heading, fontWeight: 700, fontSize: 14,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: '100vh', background: BG, fontFamily: FONTS.body, color: '#3F4A65' }}>
      <header style={{ background: COLORS.white, borderBottom: `1px solid ${BORDER}`, padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: FONTS.display, fontSize: 22, color: TEXT, letterSpacing: '0.01em' }}>Waves Pest Control &amp; Lawn</span>
        <span style={{ fontSize: 12, color: '#6B7280' }}>Lawn Report V2 · preview</span>
      </header>

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '12px 16px 0', display: 'flex', gap: 8 }}>
        {tabBtn('healthy', 'Healthy lawn')}
        {tabBtn('needs', 'Needs attention')}
      </div>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '12px 16px 48px' }}>
        <LawnSnapshotHero snapshot={data.snapshot} placeLabel={placeLabel} />
        <LawnInsightCards insights={data.insights} />
        <VisualDiagnosisCards categories={data.diagnosis} />
        <WaterIntakeBar water={data.water} />
        <RainLast7DaysChart days={data.rain7d} />
        <MowingHeightGauge mowing={data.mowing} />
        <LawnTreatmentCard treatment={data.treatment} />
        <LawnTrends trends={data.trends} />
      </main>
    </div>
  );
}
