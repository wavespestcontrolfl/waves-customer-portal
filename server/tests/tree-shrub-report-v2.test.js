// Unit tests for the Tree & Shrub Report V2 layer (visual categories → insights →
// aggregator). Asserts the trust-critical behavior: photo AI emits SIGNALS, never a
// confirmed pest/disease ("pest-pressure signals" / "leaf-spot signals", never
// "infestation"/"diseased"); a null score reads "Tracking", not 0; every issue card
// carries a Waves action AND a customer action or next-visit plan; the snapshot
// headline reflects the most severe insight; and the section is null with no
// assessment. Synthetic payloads only (no customer PII).

const { buildTreeShrubVisualCategories, scoreStatus } = require('../services/service-report/tree-shrub-visual-categories');
const { buildTreeShrubInsightCards } = require('../services/service-report/tree-shrub-report-insights');
const { buildTreeShrubReportV2 } = require('../services/service-report/tree-shrub-report-v2');

// Spec example scores: Foliage 84, Color 76, Pest 58 (Watch), Disease 88 (Strong),
// Water 72 — overall "Healthy — monitoring light pest pressure".
function assessment(overrides = {}) {
  return {
    assessmentDate: '2026-06-23',
    scores: {
      foliageFullness: 84,
      leafColorVigor: 76,
      pestActivity: 58,
      diseaseLeafSpot: 88,
      waterHeatStress: 72,
      overallScore: 76,
    },
    observations: 'Front entry shrubs show light pest-pressure signals on some foliage.',
    photos: [
      { url: 'https://example.com/a.jpg', isBest: true, qualityScore: 90, zone: 'Front entry shrubs' },
      { url: 'https://example.com/b.jpg', qualityScore: 60, zone: 'Palms' },
    ],
    plantGroups: [],
    trend: [],
    ...overrides,
  };
}

describe('scoreStatus — bands match the lawn report (85/70/55) + tracking', () => {
  it.each([
    [95, 'strong'], [85, 'strong'], [72, 'healthy'], [70, 'healthy'],
    [58, 'watch'], [55, 'watch'], [40, 'needs_attention'], [0, 'needs_attention'],
  ])('%i → %s', (score, expected) => {
    expect(scoreStatus(score)).toBe(expected);
  });

  it('null/undefined/empty → tracking (never 0 → needs_attention)', () => {
    expect(scoreStatus(null)).toBe('tracking');
    expect(scoreStatus(undefined)).toBe('tracking');
    expect(scoreStatus('')).toBe('tracking');
  });
});

describe('buildTreeShrubVisualCategories — five categories + signal guardrails', () => {
  const cats = buildTreeShrubVisualCategories({ scores: assessment().scores });

  it('returns exactly the five spec categories in order', () => {
    expect(cats.map((c) => c.key)).toEqual([
      'foliage_fullness', 'leaf_color_vigor', 'pest_activity', 'disease_leaf_spot', 'water_heat_mechanical_stress',
    ]);
    expect(cats.map((c) => c.label)).toEqual([
      'Foliage Fullness', 'Leaf Color & Vigor', 'Pest Activity Signals', 'Disease / Leaf Spot Signals', 'Water, Heat & Pruning Stress',
    ]);
  });

  it('maps the spec example scores to the right status bands', () => {
    const byKey = Object.fromEntries(cats.map((c) => [c.key, c]));
    expect(byKey.pest_activity.status).toBe('watch');     // 58
    expect(byKey.disease_leaf_spot.status).toBe('strong'); // 88
    expect(byKey.foliage_fullness.status).toBe('healthy'); // 84 -> healthy band
    expect(byKey.water_heat_mechanical_stress.status).toBe('healthy'); // 72
  });

  it('pest + disease copy never asserts a confirmed pest/disease', () => {
    const all = buildTreeShrubVisualCategories({
      scores: { foliageFullness: 30, leafColorVigor: 30, pestActivity: 30, diseaseLeafSpot: 30, waterHeatStress: 30 },
    });
    const text = all.map((c) => c.customerExplanation).join(' ').toLowerCase();
    expect(text).not.toMatch(/infestation|infested|confirmed pest/);
    expect(text).not.toMatch(/diseased|confirmed disease/);
    expect(text).toMatch(/pest-pressure signals/);
    expect(text).toMatch(/leaf-spot signals/);
  });

  it('null score reads tracking, not 0, with neutral (empty) copy — never worst-case', () => {
    const [foliage] = buildTreeShrubVisualCategories({ scores: { foliageFullness: null } });
    expect(foliage.score).toBeNull();
    expect(foliage.status).toBe('tracking');
    // A tracking row must NOT inherit the needs_attention copy via bandOf().
    expect(foliage.customerExplanation).toBe('');
  });
});

describe('buildTreeShrubInsightCards — action ownership + signal language', () => {
  const cats = buildTreeShrubVisualCategories({ scores: assessment().scores });
  const cards = buildTreeShrubInsightCards({ categories: cats });

  it('every issue card carries a Waves action AND (customer action or next-visit plan)', () => {
    for (const c of cards) {
      expect(c.wavesAction && c.wavesAction.length).toBeTruthy();
      if (c.status === 'watch' || c.status === 'needs_attention' || c.status === 'urgent') {
        expect(Boolean(c.customerAction) || Boolean(c.nextVisitPlan)).toBe(true);
      }
    }
  });

  it('leads with the pest-pressure card for the spec example and never says infestation', () => {
    expect(cards[0].category).toBe('pest_pressure');
    expect(cards[0].status).toBe('watch');
    const text = JSON.stringify(cards).toLowerCase();
    expect(text).not.toMatch(/infestation|diseased/);
  });

  it('emits a single reassurance card when nothing needs attention', () => {
    const healthy = buildTreeShrubVisualCategories({
      scores: { foliageFullness: 92, leafColorVigor: 90, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 90 },
    });
    const out = buildTreeShrubInsightCards({ categories: healthy });
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('overall');
    expect(out[0].status).toBe('good');
  });

  it('localized dry → coverage advice, never "water the whole property more"', () => {
    const out = buildTreeShrubInsightCards({ categories: cats, water: { localizedDry: true } });
    const waterCard = out.find((c) => c.category === 'water_stress');
    expect(waterCard).toBeTruthy();
    expect(waterCard.customerAction.toLowerCase()).toMatch(/even|coverage|that bed|that area/);
    expect(JSON.stringify(out).toLowerCase()).not.toMatch(/water the whole (yard|property) more/);
  });
});

describe('buildTreeShrubReportV2 — aggregator', () => {
  it('returns null with no assessment', () => {
    expect(buildTreeShrubReportV2({ treeShrubAssessment: null })).toBeNull();
  });

  it('builds the snapshot headline from the most severe insight (spec example)', () => {
    const v2 = buildTreeShrubReportV2({ treeShrubAssessment: assessment() });
    expect(v2).toBeTruthy();
    expect(v2.snapshot.statusHeadline).toBe('Healthy — monitoring light pest pressure');
    expect(v2.snapshot.status).toBe('healthy');
    expect(v2.diagnosis).toHaveLength(5);
    expect(v2.snapshot.peaceOfMind).toMatch(/No urgent plant decline/);
  });

  it('peace-of-mind reads clean when everything is healthy', () => {
    const v2 = buildTreeShrubReportV2({
      treeShrubAssessment: assessment({
        scores: { foliageFullness: 92, leafColorVigor: 90, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 90, overallScore: 92 },
        observations: 'All plant groups look healthy and full.',
      }),
    });
    expect(v2.snapshot.noActionNeeded).toBe(true);
    expect(v2.snapshot.statusHeadline).toBe('Landscape looking great');
    expect(v2.snapshot.peaceOfMind).toMatch(/protected/);
  });

  it('surfaces applied products as treatment focus + kinds', () => {
    const v2 = buildTreeShrubReportV2({
      treeShrubAssessment: assessment(),
      applications: [{ product: { name: 'Merit 2F', active_ingredient: 'Imidacloprid', category: 'systemic insecticide' } }],
    });
    expect(v2.treatment).toBeTruthy();
    expect(v2.treatment.kinds).toContain('systemic');
  });

  it('scrubs an over-claiming LLM observation from the customer photo summary', () => {
    const ok = buildTreeShrubReportV2({ treeShrubAssessment: assessment({ observations: 'Light pest-pressure signals on the front shrubs.' }) });
    expect(ok.photoSummary).toMatch(/pest-pressure signals/);
    // banned confirmed-diagnosis wording → dropped; deterministic copy carries the report
    for (const obs of [
      'The shrubs have a confirmed scale infestation.',
      'The shrubs show a fungal infection on the lower leaves.',
      'Several infected leaves were visible on the hedge.',
      'The plant is diseased.',
    ]) {
      const bad = buildTreeShrubReportV2({ treeShrubAssessment: assessment({ observations: obs }) });
      expect(bad.photoSummary).toBeNull();
    }
    const sample = buildTreeShrubReportV2({ treeShrubAssessment: assessment({ observations: 'The shrubs have a confirmed scale infestation.' }) });
    expect(JSON.stringify(sample).toLowerCase()).not.toMatch(/infestation/);
  });

  it('does NOT downgrade water/stress on a negated "no dry" observation (false-positive guard)', () => {
    const healthy = { foliageFullness: 90, leafColorVigor: 88, pestActivity: 92, diseaseLeafSpot: 92, waterHeatStress: 90, overallScore: 90 };
    const v2 = buildTreeShrubReportV2({ treeShrubAssessment: assessment({ scores: healthy, observations: 'No dry margins, wilt, or moisture stress were observed. Plants look healthy.' }) });
    const stress = v2.diagnosis.find((c) => c.key === 'water_heat_mechanical_stress');
    expect(stress.status).not.toBe('watch');
    expect(v2.insights.some((i) => i.category === 'water_stress')).toBe(false);
  });
  it('DOES downgrade water/stress on a real dry observation', () => {
    const healthy = { foliageFullness: 90, leafColorVigor: 88, pestActivity: 92, diseaseLeafSpot: 92, waterHeatStress: 90, overallScore: 90 };
    const v2 = buildTreeShrubReportV2({ treeShrubAssessment: assessment({ scores: healthy, observations: 'Some dry margins on the east bed.' }) });
    expect(v2.diagnosis.find((c) => c.key === 'water_heat_mechanical_stress').status).toBe('watch');
  });

  it('suppresses the "stable overall" line for a genuinely poor visit (multi-low / low overall)', () => {
    const v2 = buildTreeShrubReportV2({ treeShrubAssessment: assessment({ scores: { foliageFullness: 40, leafColorVigor: 35, pestActivity: 45, diseaseLeafSpot: 50, waterHeatStress: 48, overallScore: 30 } }) });
    expect(v2.snapshot.scoreExplanation).toBeNull();
  });
  it('emits the "stable overall" line only when overall is healthy and a single category is low', () => {
    const v2 = buildTreeShrubReportV2({ treeShrubAssessment: assessment({ scores: { foliageFullness: 88, leafColorVigor: 85, pestActivity: 50, diseaseLeafSpot: 90, waterHeatStress: 86, overallScore: 78 } }) });
    expect(v2.snapshot.scoreExplanation).toMatch(/stable overall/);
  });

  it('emits an SMS summary under 280 chars', () => {
    const v2 = buildTreeShrubReportV2({ treeShrubAssessment: assessment() });
    expect(typeof v2.smsSummary).toBe('string');
    expect(v2.smsSummary.length).toBeLessThanOrEqual(280);
    expect(v2.smsSummary).toMatch(/tree & shrub report/i);
  });
});
