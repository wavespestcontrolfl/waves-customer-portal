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
const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');
const { buildTreatmentNarrativePrompt, validateNarrative } = require('../services/service-report/treatment-narrative');

describe('treatment narrative prompt + validator (owner 2026-07-21)', () => {
  const PRODUCTS = [
    { name: 'Safari 20 SG', kind: 'systemic', activeIngredient: 'Dinotefuran 20%', method: 'soil_drench', targets: ['Scale', 'Mealybugs'], whatItDoes: 'protects the plants from foliage-feeding pests' },
    { name: 'LESCO 90/10 Nonionic Surfactant', kind: 'other', activeIngredient: 'Nonionic surfactant', method: 'foliar_spray', targets: [] },
  ];

  test('prompt demands why/what/benefit grounded in findings and products', () => {
    const prompt = buildTreatmentNarrativePrompt({
      serviceLine: 'tree_shrub',
      products: PRODUCTS,
      findingsText: 'Scale and mealybug activity on the arboricola and entry palms.',
      photoSummary: 'White cottony buildup on stems.',
    });
    expect(prompt).toContain('WHY each product was chosen');
    expect(prompt).toContain('WHAT each product does');
    expect(prompt).toContain('BENEFIT');
    expect(prompt).toContain('Safari 20 SG — systemic; active: Dinotefuran 20%; method: soil drench; targets: Scale, Mealybugs');
    expect(prompt).toContain('Scale and mealybug activity on the arboricola');
    expect(prompt).toContain('Do not invent findings');
    expect(prompt).toContain('NEVER include application rates');
  });

  test('validator rejects over-claims, rates, and "chemical"; accepts grounded copy', () => {
    expect(validateNarrative('This treatment is completely safe and guaranteed.')).toBeTruthy();
    expect(validateNarrative('We applied 2 oz of product to the beds.')).toBeTruthy();
    expect(validateNarrative('These chemicals knock down the pests.')).toBeTruthy();
    expect(validateNarrative('')).toBe('empty');
    expect(validateNarrative(
      'Safari was applied as a soil drench — it is absorbed by the roots and carried through the plant, so the scale and mealybugs feeding on the stems take it in over the coming weeks. You should see the cottony buildup dry up as new growth comes in.',
    )).toBe(null);
  });
});

describe('buildTreatmentSummary (owner 2026-07-21)', () => {
  test('names products with methods and targets; surfactant becomes coverage copy', () => {
    const out = buildTreatmentSummary({ products: [
      { name: 'Safari 20 SG', kind: 'systemic', activeIngredient: 'Dinotefuran 20%', targets: ['Scale', 'Mealybugs'], method: 'soil_drench' },
      { name: 'Kontos Insecticide/Miticide', kind: 'insecticide', activeIngredient: 'Spirotetramat', targets: ['Scale', 'Mites'], method: 'foliar_spray' },
      { name: 'LESCO 90/10 Nonionic Surfactant', kind: 'other', targets: [], method: 'foliar_spray' },
    ] });
    // Actives, not brand names (owner 2026-07-21) — brands live on the cards.
    expect(out).toContain('dinotefuran (soil drench)');
    expect(out).not.toContain('Safari');
    expect(out).toContain('scale, mealybugs and mites');
    expect(out).toContain('spirotetramat (foliar spray)');
    expect(out).toContain('surfactant added');
    expect(out).toContain('systemic products are absorbed');
    // Surfactant is coverage copy, never a listed treatment.
    expect(out.indexOf('LESCO')).toBe(-1);
  });

  test('surfactant-only visits make no claim; no products → null', () => {
    expect(buildTreatmentSummary({ products: [{ name: 'LESCO 90/10 Nonionic Surfactant', kind: 'other', targets: [] }] })).toBe(null);
    expect(buildTreatmentSummary(null)).toBe(null);
  });
});

// Water 72 — overall "Healthy — monitoring pest pressure" (no severity words
// in ISSUE_TOPIC — the status prefix carries severity).
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

  it('severe pest signals claim "treated today" ONLY when an insect application happened (audit 2026-07-18 P2)', () => {
    const severeScores = { foliageFullness: 80, leafColorVigor: 80, pestActivity: 20, diseaseLeafSpot: 80, waterHeatStress: 80 };
    const untreated = buildTreeShrubVisualCategories({ scores: severeScores });
    const pestUntreated = untreated.find((c) => c.key === 'pest_activity');
    expect(pestUntreated.status).toBe('needs_attention');
    expect(pestUntreated.customerExplanation).toMatch(/documented today/);
    expect(pestUntreated.customerExplanation).not.toMatch(/treated today/);

    const treated = buildTreeShrubVisualCategories({ scores: severeScores, pestTreatedToday: true });
    const pestTreated = treated.find((c) => c.key === 'pest_activity');
    expect(pestTreated.customerExplanation).toMatch(/treated today/);
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
    expect(v2.snapshot.statusHeadline).toBe('Healthy — monitoring pest pressure');
    expect(v2.snapshot.status).toBe('healthy');
    expect(v2.diagnosis).toHaveLength(5);
    expect(v2.snapshot.peaceOfMind).toMatch(/No urgent plant decline/);
  });

  it('peace-of-mind on a clean INSPECTION-ONLY visit never claims a treatment happened', () => {
    // No applications → "scheduled treatment is complete / protected" would
    // fabricate a treatment (audit 2026-07-16 P3).
    const v2 = buildTreeShrubReportV2({
      treeShrubAssessment: assessment({
        scores: { foliageFullness: 92, leafColorVigor: 90, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 90, overallScore: 92 },
        observations: 'All plant groups look healthy and full.',
      }),
    });
    expect(v2.snapshot.noActionNeeded).toBe(true);
    expect(v2.snapshot.statusHeadline).toBe('Landscape looking great');
    expect(v2.snapshot.peaceOfMind).toMatch(/No urgent plant decline/);
    expect(v2.snapshot.peaceOfMind).toMatch(/inspection/);
    expect(v2.snapshot.peaceOfMind).not.toMatch(/treatment is complete|protected/);
  });

  it('peace-of-mind stays inspection-only when only protocol ACTIONS (no products) were recorded', () => {
    // buildTreatment returns a truthy focus-carrying object for action-only
    // visits — treatment truthiness must not trigger "treatment is complete"
    // (codex P2 r4).
    const v2 = buildTreeShrubReportV2({
      treeShrubAssessment: assessment({
        scores: { foliageFullness: 92, leafColorVigor: 90, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 90, overallScore: 92 },
        observations: 'All plant groups look healthy and full.',
      }),
      actions: ['Pruned dead fronds'],
    });
    expect(v2.snapshot.peaceOfMind).toMatch(/inspection/);
    expect(v2.snapshot.peaceOfMind).not.toMatch(/treatment is complete|protected/);
  });

  it('peace-of-mind keeps the treatment copy when products were actually applied', () => {
    const v2 = buildTreeShrubReportV2({
      treeShrubAssessment: assessment({
        scores: { foliageFullness: 92, leafColorVigor: 90, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 90, overallScore: 92 },
        observations: 'All plant groups look healthy and full.',
      }),
      applications: [{ product: { name: 'Merit 2F', active_ingredient: 'Imidacloprid', category: 'systemic insecticide' } }],
    });
    expect(v2.snapshot.noActionNeeded).toBe(true);
    expect(v2.snapshot.peaceOfMind).toMatch(/treatment is complete/);
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

  it('diagnosis pest row mirrors the insight treatment gate (audit 2026-07-18 P2)', () => {
    const severe = { foliageFullness: 80, leafColorVigor: 80, pestActivity: 20, diseaseLeafSpot: 80, waterHeatStress: 80, overallScore: 68 };
    const inspectionOnly = buildTreeShrubReportV2({ treeShrubAssessment: assessment({ scores: severe }) });
    expect(inspectionOnly.diagnosis.find((d) => d.key === 'pest_activity').explanation).toMatch(/documented today/);

    const treated = buildTreeShrubReportV2({
      treeShrubAssessment: assessment({ scores: severe }),
      applications: [{ product: { name: 'Merit 2F', active_ingredient: 'Imidacloprid', category: 'systemic insecticide' } }],
    });
    expect(treated.diagnosis.find((d) => d.key === 'pest_activity').explanation).toMatch(/treated today/);
  });

  it('seaweed biostimulants classify supplement, never herbicide (codex P2 r2)', () => {
    const healthy = { foliageFullness: 90, leafColorVigor: 88, pestActivity: 92, diseaseLeafSpot: 92, waterHeatStress: 90, overallScore: 90 };
    const v2 = buildTreeShrubReportV2({
      treeShrubAssessment: assessment({ scores: healthy, observations: 'All plant groups look healthy and full.' }),
      applications: [{ product: { name: 'Seaweed Extract Biostimulant' } }],
    });
    expect(v2.treatment.products[0].kind).toBe('supplement');
    expect(v2.treatment.products[0].whatItDoes).not.toMatch(/weed/i);
  });

  it('a systemic HERBICIDE never satisfies the pest treatment gate (codex P2 r1)', () => {
    const severe = { foliageFullness: 80, leafColorVigor: 80, pestActivity: 20, diseaseLeafSpot: 80, waterHeatStress: 80, overallScore: 68 };
    const v2 = buildTreeShrubReportV2({
      treeShrubAssessment: assessment({ scores: severe }),
      applications: [{ product: { name: 'Systemic Weed Preventer', category: 'herbicide' } }],
    });
    expect(v2.treatment.products[0].kind).toBe('herbicide');
    expect(v2.diagnosis.find((d) => d.key === 'pest_activity').explanation).toMatch(/documented today/);
    expect(v2.diagnosis.find((d) => d.key === 'pest_activity').explanation).not.toMatch(/treated today/);
    // The pest insight card must not claim treatment off a weed product either.
    const pestCard = v2.insights.find((i) => i.category === 'pest_pressure');
    if (pestCard) expect(pestCard.wavesAction).not.toMatch(/Treated the affected foliage/);
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
