/**
 * Event auto-curation — the approval step of the autonomous newsletter
 * lane, on the 2026-07-28 editorial rubric. Pure pieces only: prompt
 * construction, response parsing (fail-closed), fallbacks, kill switch.
 */

const {
  buildCurationPrompt,
  parseCurationResponse,
  missingAssessmentFallbacks,
  curationEnabled,
  buildCurationCandidateQuery,
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
    expect(prompt).toContain('"assessments"');
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

  test('flattens whitespace and truncates long descriptions', () => {
    const long = buildCurationPrompt([
      { ...EVENTS[0], description: `line1\nline2\t${'x'.repeat(500)}` },
    ], '2026-06-11');
    expect(long).toContain('line1 line2');
    expect(long).not.toContain('x'.repeat(301));
  });
});

describe('event-curation parseCurationResponse', () => {
  test('accepts valid assessments keyed by exact id', () => {
    const assessments = parseCurationResponse(JSON.stringify({
      assessments: [VALID_ASSESSMENT(IDS[0]), VALID_ASSESSMENT(IDS[1], { rejection_codes: ['government_civic'] })],
    }), IDS);
    expect(assessments).toHaveLength(2);
    expect(assessments[0].id).toBe(IDS[0]);
    expect(assessments[1].rejection_codes).toEqual(['government_civic']);
  });

  test('drops unknown and duplicate ids (hallucination guard)', () => {
    const assessments = parseCurationResponse(JSON.stringify({
      assessments: [
        VALID_ASSESSMENT('ffffffff-dead-beef-0000-000000000000'),
        VALID_ASSESSMENT(IDS[0]),
        VALID_ASSESSMENT(IDS[0], { editorial_reason: 'duplicate' }),
      ],
    }), IDS);
    expect(assessments).toHaveLength(1);
    expect(assessments[0].id).toBe(IDS[0]);
    expect(assessments[0].editorial_reason).not.toBe('duplicate');
  });

  test('tolerates prose around the JSON but throws when none is present', () => {
    const wrapped = `Here you go:\n${JSON.stringify({ assessments: [VALID_ASSESSMENT(IDS[0])] })}`;
    expect(parseCurationResponse(wrapped, IDS)).toHaveLength(1);
    expect(() => parseCurationResponse('no json here', IDS)).toThrow(/JSON/);
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
