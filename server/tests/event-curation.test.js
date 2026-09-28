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
  CURATION_FRESHNESS_EXCLUSIONS,
  CURATION_RUN_BUDGET_MS,
  curationDeadline,
  batchFitsDeadline,
} = require('../services/event-curation');
const { FACTOR_MAXES, REJECTION_CODES } = require('../services/event-scoring');

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

  // Codex P1, 2026-09-27: "Revalidate content before initial auto-approval"
  // — applyDecision pins its write to this exact updated_at, so the
  // candidate fetch must select it.
  test('selects updated_at for applyDecision\'s version-pinned approval/assessment write', () => {
    const { sql } = buildCurationCandidateQuery(25).toSQL();
    expect(sql).toMatch(/"e"\."updated_at"/);
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

describe('event-curation hard freshness exclusions', () => {
  test('hard-excludes only expired and needs_review; stale_recurring is left to the first-of-year gate', () => {
    expect(CURATION_FRESHNESS_EXCLUSIONS).toEqual(['expired', 'needs_review']);
  });
});

describe('event-curation deadline (finishes before the 7 AM autopilot)', () => {
  const { parseETDateTime } = require('../utils/datetime-et');
  const et = (clock) => parseETDateTime(`2026-10-06T${clock}`);

  test('an on-time 6:15 run is capped at 6:55 ET', () => {
    expect(curationDeadline(et('06:15:00'))).toBe(et('06:55:00').getTime());
  });

  test('a run the cron lock delayed to 6:25 still ends by 6:55 ET, not 7:05', () => {
    expect(curationDeadline(et('06:25:00'))).toBe(et('06:55:00').getTime());
  });

  test('a run starting after the autopilot gets the plain 40-minute budget', () => {
    expect(curationDeadline(et('09:00:00'))).toBe(et('09:00:00').getTime() + CURATION_RUN_BUDGET_MS);
  });

  test('a batch starts only when its full 10-minute allowance ends by the deadline', () => {
    const deadline = et('06:55:00').getTime();
    expect(batchFitsDeadline(et('06:45:00').getTime(), deadline)).toBe(true);
    expect(batchFitsDeadline(et('06:45:00').getTime() + 1, deadline)).toBe(false);
    expect(batchFitsDeadline(et('06:15:00').getTime(), deadline)).toBe(true);
  });
});
