/**
 * Event auto-curation — the approval step of the autonomous newsletter
 * lane, on the 2026-07-28 editorial rubric. Pure pieces only: prompt
 * construction, response parsing (fail-closed), fallbacks, kill switch.
 */

const {
  buildCurationPrompt,
  CURATION_SCHEMA,
  parseCurationResponse,
  missingAssessmentFallbacks,
  curationEnabled,
  buildCurationCandidateQuery,
  buildRescoreCandidateQuery,
  rescoreCuratedEvent,
} = require('../services/event-curation');
const { FACTOR_MAXES, REJECTION_CODES, featureScoreFloor } = require('../services/event-scoring');

const EVENTS = [
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    title: 'Karaoke with Fitz',
    description: 'Weekly karaoke night at The Freckled Fin.',
    start_at: '2026-06-15T23:30:00.000Z',
    venue_name: 'The Freckled Fin',
    city: 'anna-maria',
    source_name: 'Anna Maria Island Chamber — Island Events',
    is_free: true,
    family_friendly: null,
    price_text: null,
  },
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000002',
    title: 'City Council Regular Agenda',
    description: 'Regular agenda for the city council meeting.',
    start_at: '2026-06-16T14:00:00.000Z',
    venue_name: null,
    city: 'tampa',
    source_name: 'City of Tampa — All Events',
    is_free: null,
    family_friendly: null,
    price_text: null,
  },
];
const IDS = EVENTS.map((e) => e.id);

const VALID_ASSESSMENT = (id, extra = {}) => ({
  id,
  event_type: 'touring_performance',
  novelty_type: 'touring',
  family_status: 'confirmed',
  audience_tags: ['parents_night'],
  scores: {
    specialness: 23, reader_pull: 17, audience_fit: 12, planning_value: 13,
    local_relevance: 8, source_confidence: 10, accessibility: 3,
  },
  penalty_flags: [],
  rejection_codes: [],
  editorial_reason: 'Rare local stop by an internationally touring performer.',
  evidence: ['Official event page identifies the performer and one-night date.'],
  ...extra,
});

describe('event-curation buildCurationPrompt', () => {
  const prompt = buildCurationPrompt(EVENTS, '2026-06-11');

  test('leads with the two owner editorial questions, not "would a reader go"', () => {
    expect(prompt).toContain('DISAPPOINTED that we failed to tell them');
    expect(prompt).toContain('SPECIAL enough to justify');
    expect(prompt).not.toContain('would actually go');
    expect(prompt).not.toContain('Fresh This Week');
    expect(prompt).toContain("Today's date: 2026-06-11");
  });

  test('lists every factor with its exact maximum', () => {
    for (const [name, max] of Object.entries(FACTOR_MAXES)) {
      expect(prompt).toContain(`${name}: 0-${max}`);
    }
  });

  test('lists every hard-policy rejection code and all three penalty flags', () => {
    for (const code of REJECTION_CODES) expect(prompt).toContain(code);
    expect(prompt).toContain('generic_class');
    expect(prompt).toContain('retail_promo');
    expect(prompt).toContain('ordinary_screening');
  });

  test('demands evidence-only scoring and fail-closed uncertainty', () => {
    expect(prompt).toContain('never invent prices');
    expect(prompt).toContain('score it LOW');
    // The output shape is provider-enforced now (jsonSchema), not prose.
    expect(CURATION_SCHEMA.required).toEqual(['assessments']);
    expect(CURATION_SCHEMA.properties.assessments.items.required).toEqual(expect.arrayContaining(['id', 'scores', 'rejection_codes', 'evidence']));
  });

  test('lists every event with its exact id, price/family signals, and source', () => {
    for (const e of EVENTS) {
      expect(prompt).toContain(`id: ${e.id}`);
      expect(prompt).toContain(`title: ${e.title}`);
    }
    expect(prompt).toContain('The Freckled Fin (anna-maria)');
    expect(prompt).toContain('free: yes');
    expect(prompt).toContain('family-friendly: unknown');
  });

  test('renders dates as Eastern wall-clock with the weekday — never raw UTC ISO', () => {
    // 2026-06-15T23:30:00Z = Monday, June 15, 7:30 PM EDT. A raw
    // toISOString() would show it as 23:30 UTC and push evening events
    // onto the wrong weekday, moving Friday–Sunday planning points.
    expect(prompt).toContain('Monday, June 15, 7:30 PM ET');
    expect(prompt).not.toContain('2026-06-15T23:30:00.000Z');
  });

  test('flattens whitespace and truncates long descriptions', () => {
    const long = buildCurationPrompt([
      { ...EVENTS[0], description: `line1\nline2\t${'x'.repeat(500)}` },
    ], '2026-06-11');
    expect(long).toContain('line1 line2');
    expect(long).not.toContain('x'.repeat(301));
  });

  // 2026-09-27 calibration (owner ruling): the model was underscoring
  // source_confidence/accessibility/audience_fit for exactly the events the
  // rubric wants approved — an official venue publishing its own event, a
  // major touring headliner or pro sports match, an event that just doesn't
  // state a price or age range. Anchors added to stop that without touching
  // the hard-policy rejection codes or penalty flags.
  test('calibrates source_confidence, accessibility, audience_fit and specialness so the model stops underscoring official/major events', () => {
    expect(prompt).toMatch(/source_confidence.*9.?[-–]10|9-10.*source_confidence/is);
    expect(prompt).toContain('official venue');
    expect(prompt).toMatch(/museum|performing-arts|tourism board|municipal calendar/);
    expect(prompt).toMatch(/do NOT zero or heavily penalize/i);
    expect(prompt).toMatch(/touring headliner|pro sports/i);
    expect(prompt).toMatch(/do not dock audience_fit/i);
    // The hard-policy codes and penalty flags are untouched by the calibration pass.
    for (const code of REJECTION_CODES) expect(prompt).toContain(code);
    expect(prompt).toContain('generic_class');
  });
});

describe('event-curation rescoreCuratedEvent (deterministic, no model call)', () => {
  const STORED_ROW = (overrides = {}) => ({
    id: 'e-rescore-1',
    start_at: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(),
    score_breakdown: JSON.stringify({
      factors: {
        specialness: 23, reader_pull: 17, audience_fit: 12, planning_value: 13,
        local_relevance: 8, source_confidence: 10, accessibility: 3,
      },
      penalty_flags: [],
      // A stored row from before the 2026-09-27 removal still carries the
      // retired derived flags — the rescore must recompute WITHOUT them.
      derived_penalty_flags: ['missing_price', 'unclear_age'],
      final: 73,
      tier: 'shortlist',
      family_status: 'confirmed',
    }),
    rejection_codes: '[]',
    audience_tags: '["parents_night"]',
    novelty_type: 'touring',
    editorial_evidence: '["Official event page identifies the performer and one-night date."]',
    curation_note: 'Scored 73/100',
    ...overrides,
  });

  test('a row penalized under the retired rules now recomputes above the old stored score and clears the floor', () => {
    const decision = rescoreCuratedEvent(STORED_ROW());
    // 23+17+12+13+8+10+3 = 86, no penalties apply any more (short_notice
    // doesn't fire 10 days out) — well above the stored 73 and the feature floor.
    expect(decision.score).toBe(86);
    expect(decision.score).toBeGreaterThan(73);
    expect(decision.approve).toBe(true);
    expect(decision.score).toBeGreaterThanOrEqual(featureScoreFloor());
    // The retired flags are gone from the recomputed breakdown.
    expect(decision.breakdown.derived_penalty_flags).toEqual([]);
  });

  test('short_notice still applies on rescore — it is not one of the retired flags', () => {
    const soon = STORED_ROW({ start_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString() });
    const decision = rescoreCuratedEvent(soon);
    expect(decision.breakdown.derived_penalty_flags).toEqual(['short_notice']);
    expect(decision.score).toBe(76); // 86 - 10
  });

  test('a hard-policy rejection code from the original assessment still blocks approval on rescore', () => {
    const rejected = STORED_ROW({ rejection_codes: '["retail_promotion"]' });
    const decision = rescoreCuratedEvent(rejected);
    expect(decision.approve).toBe(false);
    expect(decision.tier).toBe('rejected_policy');
  });

  test('a model-asserted penalty flag from the original assessment is preserved on rescore', () => {
    const withPenalty = STORED_ROW({
      score_breakdown: JSON.stringify({
        factors: {
          specialness: 10, reader_pull: 10, audience_fit: 10, planning_value: 10,
          local_relevance: 10, source_confidence: 10, accessibility: 5,
        },
        penalty_flags: ['generic_class'],
        derived_penalty_flags: [],
        final: 50,
        tier: 'below_shortlist',
      }),
    });
    const decision = rescoreCuratedEvent(withPenalty);
    // 65 - 15 (generic_class) = 50, unchanged — the model penalty isn't retired.
    expect(decision.score).toBe(50);
  });

  test('missing or malformed score_breakdown returns null — left for a human, nothing thrown', () => {
    expect(rescoreCuratedEvent(STORED_ROW({ score_breakdown: null }))).toBeNull();
    expect(rescoreCuratedEvent(STORED_ROW({ score_breakdown: '{}' }))).toBeNull();
    expect(rescoreCuratedEvent(STORED_ROW({ score_breakdown: 'not json' }))).toBeNull();
    // An unknown rejection code can't actually reach a stored row in practice
    // (the column is always written from a pre-filtered normalizeAssessment
    // result), but the same fail-closed allowlist check applies here too —
    // never trust an unrecognized code enough to reason about approval.
    expect(rescoreCuratedEvent(STORED_ROW({ rejection_codes: '["not_a_real_code"]' }))).toBeNull();
  });

  test('accepts already-parsed object/array columns (not just JSON strings)', () => {
    const parsed = STORED_ROW({
      score_breakdown: {
        factors: {
          specialness: 25, reader_pull: 20, audience_fit: 15, planning_value: 15,
          local_relevance: 10, source_confidence: 10, accessibility: 5,
        },
        penalty_flags: [],
        derived_penalty_flags: [],
      },
      rejection_codes: [],
      audience_tags: [],
      editorial_evidence: [],
    });
    const decision = rescoreCuratedEvent(parsed);
    expect(decision.score).toBe(100);
  });
});

describe('event-curation buildRescoreCandidateQuery', () => {
  test('targets pending, already-curated, upcoming rows with a stored breakdown', () => {
    const { sql, bindings } = buildRescoreCandidateQuery(500).toSQL();
    expect(sql).toMatch(/"admin_status" = \?/);
    expect(bindings).toContain('pending');
    expect(sql).toMatch(/"curated_at" is not null/i);
    expect(sql).toMatch(/"score_breakdown" is not null/i);
    expect(sql).toMatch(/"merged_into" is null/i);
    expect(sql).toMatch(/"start_at" >= \?/);
  });
});

describe('event-curation parseCurationResponse', () => {
  test('accepts valid assessments keyed by exact id', () => {
    const assessments = parseCurationResponse({
      assessments: [VALID_ASSESSMENT(IDS[0]), VALID_ASSESSMENT(IDS[1], { rejection_codes: ['government_civic'] })],
    }, IDS);
    expect(assessments).toHaveLength(2);
    expect(assessments[0].id).toBe(IDS[0]);
    expect(assessments[1].rejection_codes).toEqual(['government_civic']);
  });

  test('drops unknown and duplicate ids (hallucination guard)', () => {
    const assessments = parseCurationResponse({
      assessments: [
        VALID_ASSESSMENT('ffffffff-dead-beef-0000-000000000000'),
        VALID_ASSESSMENT(IDS[0]),
        VALID_ASSESSMENT(IDS[0], { editorial_reason: 'duplicate' }),
      ],
    }, IDS);
    expect(assessments).toHaveLength(1);
    expect(assessments[0].id).toBe(IDS[0]);
    expect(assessments[0].editorial_reason).not.toBe('duplicate');
  });

  test('throws when the dispatcher hands back no JSON object', () => {
    expect(() => parseCurationResponse(null, IDS)).toThrow(/JSON/);
    expect(() => parseCurationResponse('no json here', IDS)).toThrow(/JSON/);
    expect(parseCurationResponse({ assessments: 'not-an-array' }, IDS)).toEqual([]);
  });
});

describe('event-curation missingAssessmentFallbacks', () => {
  test('omitted batch members become fail-closed examined markers', () => {
    const batch = [{ id: IDS[0] }, { id: IDS[1] }];
    const fallbacks = missingAssessmentFallbacks(batch, [VALID_ASSESSMENT(IDS[0])]);
    expect(fallbacks).toEqual([{ id: IDS[1], __missing: true }]);
  });

  test('full coverage yields no fallbacks', () => {
    const batch = [{ id: IDS[0] }];
    expect(missingAssessmentFallbacks(batch, [VALID_ASSESSMENT(IDS[0])])).toEqual([]);
  });
});

describe('event-curation candidate query recurrence gate', () => {
  test('excludes routine event and recurrence types before model curation', () => {
    const { sql, bindings } = buildCurationCandidateQuery(25).toSQL();
    expect(sql).toMatch(/event_type.*not in/i);
    expect(sql).toMatch(/recurrence_type.*not in/i);
    expect(bindings).toEqual(expect.arrayContaining([
      'recurring_series', 'ongoing', 'daily', 'weekly', 'monthly', 'custom',
    ]));
  });

  test('selects the price/family columns the derived penalties read', () => {
    const { sql } = buildCurationCandidateQuery(25).toSQL();
    expect(sql).toContain('price_text');
    expect(sql).toContain('is_free');
    expect(sql).toContain('family_friendly');
  });
});

describe('event-curation kill switch', () => {
  const prev = process.env.EVENT_AUTO_CURATION;
  afterEach(() => {
    if (prev === undefined) delete process.env.EVENT_AUTO_CURATION;
    else process.env.EVENT_AUTO_CURATION = prev;
  });

  test('defaults ON; only the literal string false disables it', () => {
    delete process.env.EVENT_AUTO_CURATION;
    expect(curationEnabled()).toBe(true);
    process.env.EVENT_AUTO_CURATION = 'false';
    expect(curationEnabled()).toBe(false);
    process.env.EVENT_AUTO_CURATION = 'true';
    expect(curationEnabled()).toBe(true);
  });
});
