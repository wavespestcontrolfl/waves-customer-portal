// PROTOTYPE ONLY. Lawn Visit Summary (GATE_LAWN_VISIT_SUMMARY_V2), FIXED SENTENCES, NO MODEL
// (owner 2026-10-07): the facts builder, the closed phrase tables and the composer, the
// first-writer-wins freeze and the read-time guard. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const summary = require('../services/service-report/lawn-visit-summary');
const { gatherVisitSummaryFacts, wateringFacts, seasonOf } = require('../services/service-report/lawn-visit-summary-inputs');
const { lawnResultTimingViolation } = require('../services/service-report/report-writer-rules');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const { splitSentences } = require('../services/service-report/next-visit-claims');
const featureGates = require('../config/feature-gates');

const areas = (o) => Object.entries(o).map(([key, status]) => ({ key, status }));

// Names, brands and actives that must never reach the text.
const PRODUCT_WORDS = ['Stonewall', 'Prodiamine', 'prodiamine', 'Arena', 'clothianidin', 'LESCO', 'Celsius', 'Talstar', 'bifenthrin', 'Insecticide X', 'Fungicide Y', 'Liquid Z'];

// The fact sets the owner reads. Every `expected` is the exact paragraph.
const CASES = {
  stonewallCombinationFall: {
    facts: {
      season: 'fall',
      applied: [
        { name: 'Stonewall 0.43% + 15-0-15', activeIngredient: 'prodiamine 0.43% + 15-0-15', kind: 'pre_emergent' },
        { name: 'Arena 50 WDG', activeIngredient: 'clothianidin', kind: 'insecticide' },
      ],
      areas: areas({ weed_pressure: 'strong', coverage: 'healthy', color_vigor: 'healthy', damage_disease_signals: 'watch' }),
      findings: [],
      watering: { state: 'water_in', inches: 0.5, hours: 24 },
      watchNext: [],
    },
    expected: 'Today we applied a feeding with a pre-emergent weed barrier and insect control, which fits the fall season. '
      + 'Our photo read shows few weeds, thick coverage and good color, along with a few areas showing stress we are keeping an eye on. '
      + 'Results from treatments like these build gradually, and each visit adds to the last one. '
      + 'Please water the treated lawn in with 0.5 inches of water within 24 hours of today’s visit. '
      + 'At the next visit we will look at stressed areas.',
  },
  insectOnlySummer: {
    facts: {
      season: 'summer',
      applied: [{ name: 'Insecticide X', kind: 'insecticide' }],
      areas: areas({ damage_disease_signals: 'watch' }),
      findings: [{ label: 'general lawn stress', confidence: 'moderate' }],
      watering: { state: 'water_in', inches: 0.25, hours: 24 },
      watchNext: [],
    },
    expected: 'Today we applied insect control, which fits the summer season. '
      + 'In the photos we noticed some general lawn stress. '
      + 'Results from treatments like these build gradually, and each visit adds to the last one. '
      + 'Please water the treated lawn in with 0.25 inches of water within 24 hours of today’s visit. '
      + 'At the next visit we will look at stressed areas.',
  },
  fungicideOnlyWaterIn: {
    facts: { season: 'spring', applied: [{ name: 'Fungicide Y', kind: 'fungicide' }], areas: [], findings: [], watering: { state: 'water_in', inches: 1, hours: 12 }, watchNext: [] },
    expected: 'Today we applied disease protection, which fits the spring season. '
      + 'Results from treatments like these build gradually, and each visit adds to the last one. '
      + 'Please water the treated lawn in with 1 inch of water within 12 hours of today’s visit.',
  },
  holdWithFinding: {
    facts: {
      season: 'winter',
      applied: [{ name: 'Liquid Z', kind: 'herbicide' }],
      areas: areas({ weed_pressure: 'watch' }),
      findings: [{ label: 'weed pressure', confidence: 'high' }],
      watering: { state: 'hold' },
      watchNext: ['mowing'],
    },
    expected: 'Today we applied weed control, which fits the winter season. '
      + 'In the photos we noticed some weed pressure. '
      + 'Results from treatments like these build gradually, and each visit adds to the last one. '
      + 'Please hold off on watering the treated lawn for now. The watering note in this report says when to start again. '
      + 'At the next visit we will look at weeds and mowing height.',
  },
  holdThenWaterIn: {
    facts: {
      season: 'fall',
      applied: [{ name: 'LESCO 24-0-11', kind: 'fertilizer' }, { name: 'Micro blend', kind: 'supplement' }],
      areas: areas({ color_vigor: 'needs_attention', coverage: 'watch' }),
      findings: [{ label: 'color and nutrient stress', confidence: 'low' }, { label: 'thinning turf', confidence: 'unknown' }],
      watering: { state: 'hold_then_water_in' },
      watchNext: [],
    },
    expected: 'Today we applied a feeding and a micronutrient and color boost, which fits the fall season. '
      + 'In the photos we noticed what may be some color and nutrient stress and what may be some thinning turf. '
      + 'Results from treatments like these build gradually, and each visit adds to the last one. '
      + 'Please follow the watering note in this report: hold off first, then water the treatment in when it says. '
      + 'At the next visit we will look at thin areas and lawn color.',
  },
  noFindingsNoWatering: {
    facts: { season: 'fall', applied: [{ name: 'LESCO 24-0-11', kind: 'fertilizer' }], areas: areas({ weed_pressure: 'healthy' }), findings: [], watering: null, watchNext: [] },
    expected: 'Today we applied a feeding, which fits the fall season. '
      + 'Our photo read shows few weeds. '
      + 'Results from treatments like these build gradually, and each visit adds to the last one.',
  },
  lowConfidenceThinning: {
    facts: {
      season: 'fall',
      applied: [{ name: 'LESCO 24-0-11', kind: 'fertilizer' }],
      areas: areas({ coverage: 'watch', color_vigor: 'healthy' }),
      findings: [{ label: 'thinning turf', confidence: 'low' }],
      watering: null,
      watchNext: [],
    },
    expected: 'Today we applied a feeding, which fits the fall season. '
      + 'Our photo read shows good color. '
      + 'In the photos we noticed what may be some thinning turf. '
      + 'Results from treatments like these build gradually, and each visit adds to the last one. '
      + 'At the next visit we will look at thin areas.',
  },
};
// Every case below is a recurring plan visit with a booked next visit, unless a test says otherwise.
for (const c of Object.values(CASES)) c.facts = { ...c.facts, recurring: true, nextVisitBooked: true };
const composeCase = (name) => summary.composeVisitSummary(CASES[name].facts);

const DIGIT_RE = /\d/;
const WATERING_SENTENCE_RE = /^Please /;
const TIME_WORD_RE = /\b(?:today|tomorrow|yesterday|tonight|week|weeks|month|months|day|days|soon|shortly|within\s+\d+\s+(?:days?|weeks?)|by\s+(?:next|the\s+next)|in\s+\d+)\b/i;
const FUTURE_TREATMENT_RE = /\bwe(?:['’]ll|\s+will)\s+(?!look at\b)|\bwill\s+(?:apply|treat|spray|return|come|schedule|re-?treat)|\bnext\s+(?:application|treatment|round)\b|\bfollow[\s-]?up\b/i;
const ALL_CLEAR_RE = /\bno\s+(?:\w+\s+)?(?:issues?|problems?|concerns?|pests?|damage|weeds?|disease|stress)\b|\bnothing\s+(?:wrong|to\s+worry|of\s+concern)|\ball\s+clear\b|\bperfect|\bflawless|significant|healthy\s+lawn|pest[\s-]?free|guarantee/i;
const RETIRED_NAME_RE = /&\s*lawn\s*care|lawn\s*care\s*&|Waves Pest Control & /i;

// Every rule the owner asked the paragraph to hold, on one composed text.
function expectOwnerRules(text) {
  const sentences = splitSentences(text);
  expect(sentences.length).toBeLessThanOrEqual(6);
  expect(text.split(/\s+/).length).toBeLessThanOrEqual(150);
  for (const name of PRODUCT_WORDS) expect(text).not.toContain(name);
  // Digits: only the frozen watering amounts, in a watering sentence.
  for (const s of sentences) if (!WATERING_SENTENCE_RE.test(s)) expect(s).not.toMatch(DIGIT_RE);
  // Time words: none outside the watering sentence ("today" opens the applied line and the visit possessive).
  for (const s of sentences) {
    if (WATERING_SENTENCE_RE.test(s)) continue;
    expect(lawnResultTimingViolation(s, { carePlanExempt: false })).toBe(false);
    expect(s.replace(/^Today we applied/, '')).not.toMatch(TIME_WORD_RE);
  }
  expect(lawnResultTimingViolation(text)).toBe(false);
  expect(text).not.toMatch(ALL_CLEAR_RE);
  expect(text).not.toMatch(FUTURE_TREATMENT_RE);
  expect(text).not.toMatch(RETIRED_NAME_RE);
  expect(text).not.toMatch(/\b(?:rain|rained|raining|forecast)\b/i);
  expect(customerCopyViolations(text)).toEqual([]);
  expect(summary._test.textProblem(text)).toBeNull();
}

beforeEach(() => { jest.clearAllMocks(); });

describe('the paragraphs the owner reads', () => {
  test.each(Object.keys(CASES))('%s: exact text, and every owner rule holds', (name) => {
    const result = composeCase(name);
    expect(result.ok).toBe(true);
    expect(result.paragraph).toBe(CASES[name].expected);
    expectOwnerRules(result.paragraph);
  });

  test('no model is ever called, and the same facts always give the same paragraph', () => {
    const a = composeCase('stonewallCombinationFall');
    const b = composeCase('stonewallCombinationFall');
    expect(a.paragraph).toBe(b.paragraph);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('nothing grounded (no product, no photo read, no finding that prints) composes nothing', () => {
    expect(summary.composeVisitSummary({ season: 'fall', applied: [], areas: areas({ weed_pressure: 'tracking' }), findings: [] })).toEqual({ ok: false, reason: 'nothing_to_ground' });
    expect(summary.composeVisitSummary({})).toEqual({ ok: false, reason: 'nothing_to_ground' });
    expect(summary.composeVisitSummary(null)).toEqual({ ok: false, reason: 'nothing_to_ground' });
  });

  test('a visit with a photo read and no product still gets one (no applied line, no results line)', () => {
    const r = summary.composeVisitSummary({ areas: areas({ weed_pressure: 'strong' }) });
    expect(r.paragraph).toBe('Our photo read shows few weeds.');
  });
});

describe('what the facts can and cannot say', () => {
  test('a photo finding prints only while the report’s own card for that topic shows a concern', () => {
    const base = { applied: [{ name: 'x', kind: 'fertilizer' }], findings: [{ label: 'thinning turf', confidence: 'low' }] };
    // Coverage reads healthy: "thick coverage" and "may be thinning turf" would contradict, so no finding.
    const healthy = summary.composeVisitSummary({ ...base, areas: areas({ coverage: 'healthy' }) }).paragraph;
    expect(healthy).toContain('thick coverage');
    expect(healthy).not.toMatch(/thinning/);
    // No card at all: no finding either.
    expect(summary.composeVisitSummary({ ...base, areas: [] }).paragraph).not.toMatch(/thinning/);
    // A concern on the card: the finding prints, hedged, and the card's own phrase steps aside.
    const watch = summary.composeVisitSummary({ ...base, areas: areas({ coverage: 'watch' }) }).paragraph;
    expect(watch).toContain('what may be some thinning turf');
    expect(watch).not.toContain('keeping an eye on');
  });

  test('confidence: moderate and high speak plainly, low and unknown hedge', () => {
    const text = (confidence) => summary.composeVisitSummary({ applied: [{ kind: 'herbicide', name: 'a' }], areas: areas({ weed_pressure: 'watch' }), findings: [{ label: 'weed pressure', confidence }] }).paragraph;
    expect(text('high')).toContain('we noticed some weed pressure');
    expect(text('moderate')).toContain('we noticed some weed pressure');
    expect(text('low')).toContain('we noticed what may be some weed pressure');
    expect(text('unknown')).toContain('we noticed what may be some weed pressure');
    expect(text(undefined)).toContain('what may be');
  });

  test('a finding label off the symptom allowlist (a named cause, a water or clean label) never prints', () => {
    const f = (label) => summary.normalizeFacts({ findings: [{ label, confidence: 'high' }] }).findings;
    for (const label of ['chinch bugs', 'insect damage', 'large patch', 'drought stress', 'no major visible stress', 'gray leaf spot', 'grubs']) expect(f(label)).toEqual([]);
    expect(f('weed pressure')).toHaveLength(1);
  });

  test('a healthy stress card says nothing (no "no stress" all clear); a watch stress card says so', () => {
    const t = (status) => summary.composeVisitSummary({ applied: [{ kind: 'fertilizer', name: 'a' }], areas: areas({ damage_disease_signals: status, weed_pressure: 'strong' }) }).paragraph;
    expect(t('healthy')).not.toMatch(/stress/);
    expect(t('watch')).toContain('a few areas showing stress we are keeping an eye on');
    expect(t('needs_attention')).toContain('some areas showing stress that need more attention');
  });

  test('the Water / Coverage card and a tracking status have no phrase', () => {
    const r = summary.composeVisitSummary({ applied: [{ kind: 'fertilizer', name: 'a' }], areas: [{ key: 'water_moisture_stress', status: 'watch' }, { key: 'coverage', status: 'tracking' }] });
    expect(r.paragraph).not.toMatch(/photo read/);
    expect(summary.normalizeFacts({ areas: [{ key: 'water_moisture_stress', status: 'watch' }] }).areas).toEqual([]);
  });

  test('score-card labels map to their card when a row has no key', () => {
    const f = summary.normalizeFacts({ areas: [{ label: 'Weed Pressure', status: 'strong' }, { label: 'Turf Coverage', status: 'watch' }, { label: 'Color & Vigor', status: 'healthy' }, { label: 'Stress / Damage Signals', status: 'watch' }, { label: 'Water / Coverage', status: 'watch' }] });
    expect(f.areas.map((a) => a.key)).toEqual(['weed_pressure', 'coverage', 'color_vigor', 'damage_disease_signals']);
  });

  test('a combination product keeps its feeding half; a plain feeding beside it folds in; "a lawn treatment" steps aside', () => {
    const t = (applied) => summary.composeVisitSummary({ applied }).paragraph;
    expect(t([{ name: 'Barrier 0.43% + 15-0-15', kind: 'pre_emergent' }])).toContain('Today we applied a feeding with a pre-emergent weed barrier.');
    expect(t([{ name: 'Barrier 0.43% + 15-0-15', kind: 'pre_emergent' }, { name: 'Plain feed', kind: 'fertilizer' }])).toContain('Today we applied a feeding with a pre-emergent weed barrier.');
    expect(t([{ name: 'Plain barrier', kind: 'pre_emergent' }, { name: 'Wetter', kind: 'other' }])).toContain('Today we applied a pre-emergent weed barrier.');
    expect(t([{ name: 'Wetter', kind: 'other' }])).toContain('Today we applied a lawn treatment.');
  });

  test('the technician note, program line, headline, product names and rain are not inputs: passing them changes nothing', () => {
    const facts = CASES.stonewallCombinationFall.facts;
    const noisy = {
      ...facts,
      technicianNote: 'Chinch bugs by the driveway. Front yard looks perfect. No issues. Used Celsius.',
      programLine: 'In October the program targets large patch and grubs.',
      headline: 'Your lawn is in good shape',
      recentRain: true,
      knownProductNames: ['Celsius WG'],
    };
    expect(summary.composeVisitSummary(noisy).paragraph).toBe(CASES.stonewallCombinationFall.expected);
    expect(Object.keys(summary.normalizeFacts(noisy)).sort()).toEqual(['applied', 'areas', 'findings', 'nextVisitBooked', 'recurring', 'season', 'watchNext', 'watering']);
  });

  test('a product enters the facts as its kind only: no name, active or rate survives', () => {
    const f = summary.normalizeFacts({ applied: [{ name: 'Stonewall 0.43% + 15-0-15', activeIngredient: 'prodiamine', kind: 'pre_emergent' }] });
    expect(f.applied).toEqual([{ kind: 'pre_emergent', alsoFeeds: true }]);
    expect(JSON.stringify(f)).not.toMatch(/Stonewall|prodiamine|0\.43/);
  });
});

describe('watering comes from the frozen instruction only', () => {
  const instruction = { state: 'water_in', waterInInches: 0.5, completedAt: '2026-10-06T14:40:00Z', waterInBy: '2026-10-07T14:40:00Z' };

  test('hours are the frozen deadline rounded DOWN, never up', () => {
    expect(wateringFacts(instruction)).toMatchObject({ state: 'water_in', inches: 0.5, hours: 24 });
    // 23 h 30 min left: 23, not 24.
    expect(wateringFacts({ ...instruction, waterInBy: '2026-10-07T14:10:00Z' })).toMatchObject({ state: 'water_in', inches: 0.5, hours: 23 });
    // A same-day cap shortens the window.
    expect(wateringFacts({ ...instruction, waterInBy: '2026-10-06T23:59:00Z' })).toMatchObject({ state: 'water_in', inches: 0.5, hours: 9 });
    // Under an hour, an unreadable deadline or no inches: no step (the banner owns it).
    expect(wateringFacts({ ...instruction, waterInBy: '2026-10-06T15:20:00Z' })).toBeNull();
    expect(wateringFacts({ ...instruction, waterInBy: null })).toBeNull();
    expect(wateringFacts({ ...instruction, waterInInches: null })).toBeNull();
  });

  test('the watering rule\'s own maximum window is honored: 96 h and 168 h keep their step, 169 h does not', () => {
    const at = '2026-10-06T14:00:00Z';
    const by = (h) => new Date(Date.parse(at) + h * 3600000).toISOString();
    const facts = (h) => summary.normalizeFacts({ watering: wateringFacts({ ...instruction, completedAt: at, waterInBy: by(h) }) }).watering;
    expect(facts(96)).toMatchObject({ state: 'water_in', inches: 0.5, hours: 96 });
    expect(facts(168).hours).toBe(168);
    expect(facts(169)).toBeNull();
    const text = summary.composeVisitSummary({ applied: [{ kind: 'fertilizer', name: 'a' }], watering: facts(96) }).paragraph;
    expect(text).toContain('Please water the treated lawn in with 0.5 inches of water within 96 hours of today’s visit.');
    expect(require('../services/service-report/lawn-watering-rule').MAX_HOURS).toBe(168);
  });

  test('hold has no numbers; none, null and an unknown state give no step', () => {
    expect(wateringFacts({ state: 'hold' })).toMatchObject({ state: 'hold' });
    // A hold before a water-in carries its own release condition in the report's note: no amounts here.
    expect(wateringFacts({ state: 'hold_then_water_in', waterInInches: 0.5, completedAt: '2026-10-06T14:40:00Z', waterInBy: '2026-10-07T14:40:00Z', holdUntil: '2026-10-06T20:00:00Z' })).toMatchObject({ state: 'hold_then_water_in' });
    expect(wateringFacts({ state: 'none' })).toBeNull();
    expect(wateringFacts({ state: null })).toBeNull();
    expect(wateringFacts(null)).toBeNull();
  });

  test('a half-known water-in step is dropped, never guessed', () => {
    expect(summary.normalizeFacts({ watering: { state: 'water_in', inches: 0.5 } }).watering).toBeNull();
    expect(summary.normalizeFacts({ watering: { state: 'water_in', inches: 0, hours: 24 } }).watering).toBeNull();
    expect(summary.normalizeFacts({ watering: { state: 'water_in', inches: 9, hours: 24 } }).watering).toBeNull();
    expect(summary.normalizeFacts({ watering: { state: 'bogus' } }).watering).toBeNull();
    expect(summary.normalizeFacts({ watering: { state: 'hold' } }).watering).toMatchObject({ state: 'hold', inches: null, hours: null });
    expect(summary.normalizeFacts({ watering: { state: 'hold_then_water_in', inches: 0.5, hours: 24 } }).watering).toMatchObject({ state: 'hold_then_water_in', inches: null, hours: null });
    // A fractional hour from a hand-built fact floors.
    expect(summary.normalizeFacts({ watering: { state: 'water_in', inches: 0.5, hours: 23.9 } }).watering.hours).toBe(23);
  });

  test('each state says its own action: water in, hold, or hold then water in', () => {
    const t = (watering) => summary.composeVisitSummary({ applied: [{ kind: 'fertilizer', name: 'a' }], watering }).paragraph;
    const waterIn = t({ state: 'water_in', inches: 0.5, hours: 24 });
    expect(waterIn).toContain('Please water the treated lawn in with 0.5 inches of water within 24 hours of today’s visit.');
    expect(waterIn).not.toMatch(/hold/);
    const hold = t({ state: 'hold' });
    expect(hold).toMatch(/hold off on watering/);
    expect(hold).not.toMatch(/\d/);
    expect(hold).not.toMatch(/water (?:it )?in/);
    // Hold then water in: the frozen hold's release condition and the deadline live in the report's
    // note, so the sentence defers to it, in order, with no amount, hour or clock time of its own.
    const both = t({ state: 'hold_then_water_in', inches: 1, hours: 24 });
    expect(both).toContain('Please follow the watering note in this report: hold off first, then water the treatment in when it says.');
    expect(both).not.toMatch(/\d|within|at first/);
    expect(both.indexOf('hold off')).toBeLessThan(both.indexOf('water the treatment in'));
    // No instruction: no watering sentence at all.
    expect(t(null)).not.toMatch(/water/i);
  });

  test('seasonOf', () => {
    expect([10, 7, 4, 1].map(seasonOf)).toEqual(['fall', 'summer', 'spring', 'winter']);
    expect(seasonOf(null)).toBeNull();
  });
});

describe('the closed tables', () => {
  const T = summary;
  const everyPhrase = () => [
    ...Object.values(T.APPLIED_PHRASES),
    ...Object.values(T.AREA_PHRASES).flatMap((p) => Object.values(p)),
    ...Object.values(T.FINDING_PHRASES).flatMap((p) => Object.values(p)),
    ...Object.values(T.TOPIC_PHRASES),
  ];

  test('no phrase carries a digit, a product name, a time word, an all clear or a promise', () => {
    for (const phrase of everyPhrase()) {
      expect(phrase).not.toMatch(DIGIT_RE);
      expect(phrase).not.toMatch(TIME_WORD_RE);
      expect(phrase).not.toMatch(ALL_CLEAR_RE);
      expect(phrase).not.toMatch(FUTURE_TREATMENT_RE);
      expect(phrase).not.toMatch(/\b(?:rain|forecast)\b/i);
      for (const name of PRODUCT_WORDS) expect(phrase).not.toContain(name);
    }
  });

  test('every phrase, in its own sentence, passes the customer-copy and result-timing screens', () => {
    const S = T.SENTENCE;
    const sentences = [
      ...Object.values(T.APPLIED_PHRASES).map((p) => S.applied(p, 'fall')),
      ...Object.values(T.AREA_PHRASES).flatMap((p) => Object.values(p)).flatMap((p) => [S.photoRead(p), S.photoReadMixed(p, p)]),
      ...Object.values(T.FINDING_PHRASES).flatMap((p) => Object.values(p)).map((p) => S.findings(p)),
      ...Object.values(T.TOPIC_PHRASES).map((p) => S.nextVisit(p)),
      S.results,
    ];
    for (const sentence of sentences) {
      expect(customerCopyViolations(sentence)).toEqual([]);
      expect(lawnResultTimingViolation(sentence.replace(/^Today we applied/, 'We applied'), { carePlanExempt: false })).toBe(false);
      expect(sentence).not.toMatch(ALL_CLEAR_RE);
    }
  });

  test('every watering sentence, for 1 and for many inches and hours, passes the screens', () => {
    for (const [inches, hours] of [[0.25, 1], [0.5, 24], [1, 12], [1.5, 72]]) {
      for (const text of [
        T.WATERING_SENTENCE.water_in(`${inches} ${inches === 1 ? 'inch' : 'inches'}`, `${hours} ${hours === 1 ? 'hour' : 'hours'}`),
        T.WATERING_SENTENCE.hold_then_water_in(),
        T.WATERING_SENTENCE.hold(),
      ]) {
        expect(customerCopyViolations(text)).toEqual([]);
        expect(lawnResultTimingViolation(text)).toBe(false);
        expect(text).not.toMatch(FUTURE_TREATMENT_RE);
      }
    }
  });

  test('the longest paragraph any valid slots can render fits the cap and the screens', () => {
    const slots = {
      season: 'winter',
      applied: ['combo_insecticide', 'supplement', 'herbicide', 'fungicide'],
      areas: [{ key: 'weed_pressure', band: 'needs_attention' }, { key: 'coverage', band: 'needs_attention' }, { key: 'color_vigor', band: 'needs_attention' }, { key: 'damage_disease_signals', band: 'needs_attention' }],
      findings: [{ label: 'color and nutrient stress', hedged: true }, { label: 'a lawn condition we are monitoring', hedged: true }, { label: 'general lawn stress', hedged: true }],
      watering: { state: 'hold_then_water_in' },
      watch: ['weeds', 'thin', 'color'],
    };
    const text = summary.render(slots);
    expect(text.length).toBeLessThanOrEqual(summary.MAX_TEXT_CHARS);
    expect(splitSentences(text).length).toBeLessThanOrEqual(6);
    expect(summary._test.textProblem(text)).toBeNull();
  });

  test('every status band of every area has the phrase the renderer needs, or none by design', () => {
    for (const key of Object.keys(T.AREA_PHRASES)) {
      const bands = Object.keys(T.AREA_PHRASES[key]);
      expect(bands).toEqual(expect.arrayContaining(['watch', 'needs_attention']));
    }
    expect(T.AREA_PHRASES.damage_disease_signals.good).toBeUndefined();
  });

  test('a render never prints an id outside the tables', () => {
    const text = summary.render({ season: 'monsoon', applied: ['__proto__', 'constructor', 'rodenticide'], areas: [{ key: 'toString', band: 'good' }], findings: [{ label: 'chinch bugs', hedged: false }], watering: { state: 'water_in', inches: 99, hours: 1000 }, watch: ['nothing'] });
    expect(text).toBe('');
  });
});

describe('gatherVisitSummaryFacts reads the report data the render uses', () => {
  const DATA = {
    lawnAssessment: { assessmentId: 77 },
    reportV2: {
      snapshot: { statusHeadline: 'Your lawn is in good shape', seasonalNote: 'The program targets large patch and grubs.', seasonalNoteSource: 'program', overallScore: 91 },
      diagnosis: [
        { key: 'coverage', label: 'Turf Coverage', score: 62, status: 'watch' },
        { key: 'color_vigor', label: 'Color & Vigor', score: 88, status: 'strong' },
        { key: 'water_moisture_stress', label: 'Water / Coverage', status: 'watch' },
      ],
      insights: [{ category: 'weeds', status: 'watch' }, { category: 'water', status: 'watch' }, { category: 'coverage', status: 'watch' }, { category: 'mowing', status: 'healthy' }],
      treatment: { products: [
        { name: 'LESCO 24-0-11', activeIngredient: 'nitrogen', kind: 'fertilizer', method: 'granular', targets: [] },
        { name: 'Wetting Agent', kind: 'other', activeIngredient: 'surfactant blend' },
      ] },
    },
  };
  const RECORD = { id: 's1', technician_notes: 'Chinch bugs by the driveway.', service_date: '2026-10-06', conditions: { rain_24h_in: 1.2 } };
  const instruction = { state: 'water_in', waterInInches: 0.5, completedAt: '2026-10-06T14:40:00Z', waterInBy: '2026-10-07T14:40:00Z' };
  const reads = [];
  const fakeKnex = () => (table) => {
    reads.push(table);
    if (table !== 'lawn_assessments' && table !== 'lawn_assessment_runs') throw new Error(`unexpected read of ${table}`);
    const q = { where: () => q };
    q.first = async () => (table === 'lawn_assessments'
      ? { id: 77, customer_id: 9, confirmed_by_tech: true }
      : { assessment_id: 77, customer_id: 9, reviewed_at: '2026-10-06T10:00:00Z', reviewed_findings: [{ label: 'thinning turf', confidence: 'low', keep: true }, { label: 'chinch bugs', confidence: 'high', keep: true }], added_details: [] });
    return q;
  };

  test('facts are kinds, statuses, kept symptom findings, topics and the frozen watering step; no catalog read', async () => {
    reads.length = 0;
    const facts = await gatherVisitSummaryFacts({ record: RECORD, data: DATA, instruction, knex: fakeKnex() });
    expect(reads).toEqual(['lawn_assessments', 'lawn_assessment_runs']);
    expect(facts).toEqual({
      season: 'fall',
      applied: [{ kind: 'fertilizer', alsoFeeds: false }],
      findings: [{ label: 'thinning turf', confidence: 'low', canDetermine: true }],
      areas: [{ key: 'coverage', status: 'watch' }, { key: 'color_vigor', status: 'strong' }],
      watering: { state: 'water_in', inches: 0.5, hours: 24, expiresAt: null },
      watchNext: ['weeds'],
      recurring: false,
      nextVisitBooked: false,
    });
    const json = JSON.stringify(facts);
    for (const leak of ['LESCO', 'nitrogen', 'Chinch', 'large patch', 'good shape', '1.2']) expect(json).not.toContain(leak);
  });

  test('the composed paragraph for that visit (recurring plan visit, next visit booked)', async () => {
    const facts = await gatherVisitSummaryFacts({ record: RECORD, data: DATA, instruction, programVisit: true, nextVisitBooked: true, knex: fakeKnex() });
    const { paragraph } = summary.composeVisitSummary(facts);
    expect(paragraph).toBe('Today we applied a feeding, which fits the fall season. '
      + 'Our photo read shows good color. '
      + 'In the photos we noticed what may be some thinning turf. '
      + 'Results from treatments like these build gradually, and each visit adds to the last one. '
      + 'Please water the treated lawn in with 0.5 inches of water within 24 hours of today’s visit. '
      + 'At the next visit we will look at weeds and thin areas.');
    expectOwnerRules(paragraph);
  });

  describe('photo findings only (Codex r3)', () => {
    const knexWithRun = (run) => (table) => {
      const q = { where: () => q };
      q.first = async () => (table === 'lawn_assessments' ? { id: 77, customer_id: 9, confirmed_by_tech: true } : { assessment_id: 77, customer_id: 9, reviewed_at: '2026-10-06T10:00:00Z', ...run });
      return q;
    };
    const gather = (run) => gatherVisitSummaryFacts({ record: RECORD, data: DATA, instruction: null, knex: knexWithRun(run) });

    test('a technician-added detail has no photo provenance and never becomes "In the photos we noticed"', async () => {
      const facts = await gather({
        reviewed_findings: [{ label: 'thinning turf', confidence: 'low', keep: true }],
        added_details: [{ label: 'weed pressure', confidence: 'high' }, { label: 'color stress', confidence: 'high' }],
      });
      expect(facts.findings.map((f) => f.label)).toEqual(['thinning turf']);
      const added = await gather({ reviewed_findings: [], added_details: [{ label: 'thinning turf', confidence: 'high' }] });
      expect(added.findings).toEqual([]);
      // A finding the technician unchecked is not kept either.
      expect((await gather({ reviewed_findings: [{ label: 'thinning turf', confidence: 'high', keep: false }], added_details: [] })).findings).toEqual([]);
    });

    test('a finding the photos could not determine is always hedged, whatever its confidence', async () => {
      const facts = await gather({ reviewed_findings: [{ label: 'thinning turf', confidence: 'high', can_determine: false, keep: true }], added_details: [] });
      expect(facts.findings).toEqual([{ label: 'thinning turf', confidence: 'high', canDetermine: false }]);
      expect(summary.composeVisitSummary({ ...facts, applied: [{ kind: 'fertilizer', name: 'a' }] }).paragraph).toContain('we noticed what may be some thinning turf');
      // The same finding, determinable and high confidence, speaks plainly.
      const plain = await gather({ reviewed_findings: [{ label: 'thinning turf', confidence: 'high', keep: true }], added_details: [] });
      expect(summary.composeVisitSummary({ ...plain, applied: [{ kind: 'fertilizer', name: 'a' }] }).paragraph).toContain('we noticed some thinning turf');
    });

    test('the same label twice keeps the more cautious read', () => {
      const f = summary.normalizeFacts({ findings: [{ label: 'thinning turf', confidence: 'high' }, { label: 'thinning turf', confidence: 'low', canDetermine: false }] }).findings;
      expect(f).toEqual([{ label: 'thinning turf', confidence: 'low', canDetermine: false }]);
    });
  });

  describe('recurring-plan promises (Codex r4)', () => {
    // nextVisit: the property-scoped answer the report build hands the gate (true = a scheduled booking).
    const NEXT = true;
    const paragraphFor = async ({ programVisit, nextVisit }) => {
      // snapshot.nextVisit is customer-wide while copy v6 is off: it is never the source.
      const data = { ...DATA, reportV2: { ...DATA.reportV2, snapshot: { ...DATA.reportV2.snapshot, nextVisit: { label: 'Oct 20', source: 'scheduled' } } } };
      const facts = await gatherVisitSummaryFacts({ record: RECORD, data, instruction: null, programVisit, nextVisitBooked: nextVisit, knex: fakeKnex() });
      return { facts, text: summary.composeVisitSummary(facts).paragraph };
    };
    const RESULTS = 'each visit adds to the last one';
    const NEXT_LINE = 'At the next visit we will look at';

    test('a one-time visit gets neither the results line nor the next-visit line, even with another visit booked', async () => {
      for (const programVisit of [false, undefined]) {
        const { facts, text } = await paragraphFor({ programVisit, nextVisit: NEXT });
        expect(facts).toMatchObject({ recurring: false, nextVisitBooked: true });
        expect(text).not.toContain(RESULTS);
        expect(text).not.toContain(NEXT_LINE);
        expect(text).toContain('Today we applied a feeding');
      }
    });

    test('a recurring plan visit with a booked next visit gets both', async () => {
      const { text } = await paragraphFor({ programVisit: true, nextVisit: NEXT });
      expect(text).toContain(RESULTS);
      expect(text).toContain(NEXT_LINE);
    });

    test('a recurring plan visit with no booking (or only a cadence estimate) gets results but no next-visit line', async () => {
      for (const nextVisit of [false, undefined]) {
        const { facts, text } = await paragraphFor({ programVisit: true, nextVisit });
        expect(facts).toMatchObject({ recurring: true, nextVisitBooked: false });
        expect(text).toContain(RESULTS);
        expect(text).not.toContain(NEXT_LINE);
      }
    });

    test('the decision is frozen in the slots: read-time equality holds, and a flipped flag no longer matches the text', async () => {
      const { facts } = await paragraphFor({ programVisit: true, nextVisit: NEXT });
      const { slots, paragraph } = summary.composeVisitSummary(facts);
      expect(slots).toMatchObject({ recurring: true, nextVisit: true });
      const one = summary.composeVisitSummary({ ...facts, recurring: false });
      expect(one.slots).toMatchObject({ recurring: false, nextVisit: false, watch: [] });
      expect(summary.render({ ...slots, recurring: false })).not.toBe(paragraph);
    });
  });

  describe('duplicate findings keep the least-confident evidence (Codex r4)', () => {
    const knexWith = (reviewed) => (table) => {
      const q = { where: () => q };
      q.first = async () => (table === 'lawn_assessments' ? { id: 77, customer_id: 9, confirmed_by_tech: true } : { assessment_id: 77, customer_id: 9, reviewed_at: '2026-10-06T10:00:00Z', reviewed_findings: reviewed, added_details: [] });
      return q;
    };
    const gather = (reviewed) => gatherVisitSummaryFacts({ record: RECORD, data: DATA, instruction: null, knex: knexWith(reviewed) });
    const row = (confidence) => ({ label: 'thinning turf', confidence, keep: true });

    test('high then low, and low then high, are both hedged', async () => {
      for (const order of [['high', 'low'], ['low', 'high']]) {
        const facts = await gather(order.map(row));
        expect(facts.findings).toEqual([{ label: 'thinning turf', confidence: 'low', canDetermine: true }]);
        expect(summary.composeVisitSummary({ ...facts, applied: [{ kind: 'fertilizer', name: 'a' }], areas: [{ key: 'coverage', status: 'watch' }] }).paragraph).toContain('what may be some thinning turf');
      }
      // Two high-confidence rows stay plain.
      expect((await gather(['high', 'moderate'].map(row))).findings[0].confidence).toMatch(/high|moderate/);
    });
  });

  test('gather then compose keeps a combination product\'s feeding (normalization is idempotent)', async () => {
    const data = { ...DATA, reportV2: { ...DATA.reportV2, treatment: { products: [{ name: 'Stonewall 0.43% + 15-0-15', activeIngredient: 'prodiamine 0.43% + 15-0-15', kind: 'pre_emergent' }] } } };
    const facts = await gatherVisitSummaryFacts({ record: RECORD, data, instruction, knex: fakeKnex() });
    expect(facts.applied).toEqual([{ kind: 'pre_emergent', alsoFeeds: true }]);
    expect(summary.normalizeFacts(summary.normalizeFacts(facts))).toEqual(facts);
    expect(summary.composeVisitSummary(facts).paragraph).toContain('Today we applied a feeding with a pre-emergent weed barrier, which fits the fall season.');
  });

  test('a failed product read writes nothing, with the watering gate off (no instruction, no productsLoadFailed)', async () => {
    const degraded = { ...DATA, lawnAssessment: { assessmentId: 77, productsReadFailed: true } };
    expect(await gatherVisitSummaryFacts({ record: RECORD, data: degraded, instruction: null, knex: fakeKnex() })).toBeNull();
    // Through the completion step: nothing frozen.
    const notes = { current: {} };
    const knex = Object.assign(() => ({ where: () => ({ first: async () => ({ structured_notes: notes.current }) }) }), { raw: () => ({}) });
    const out = await summary.createAndFreezeVisitSummary({
      serviceRecordId: 's1', assessmentId: 77, structuredNotes: {}, knex,
      gatherInputs: () => gatherVisitSummaryFacts({ record: RECORD, data: degraded, instruction: null, knex: fakeKnex() }),
    });
    expect(out.status).toBe('no_inputs');
    expect(out.entry).toBeUndefined();
  });

  test('a degraded report read, a missing assessment or a missing report writes no summary', async () => {
    expect(await gatherVisitSummaryFacts({ record: RECORD, data: { ...DATA, lawnAssessment: { assessmentId: 77, lawnCopyV6Unfrozen: true } }, knex: fakeKnex() })).toBeNull();
    expect(await gatherVisitSummaryFacts({ record: RECORD, data: { reportV2: DATA.reportV2, lawnAssessment: {} }, knex: fakeKnex() })).toBeNull();
    expect(await gatherVisitSummaryFacts({ record: RECORD, data: {}, knex: fakeKnex() })).toBeNull();
  });
});

describe('freeze and read-back', () => {
  function fakeKnex(initial = {}) {
    const state = { notes: JSON.parse(JSON.stringify(initial)) };
    const knex = () => {
      const q = { guardKey: null };
      q.where = () => q;
      q.whereRaw = (_sql, bindings) => { q.guardKey = Array.isArray(bindings) ? bindings[0] : null; return q; };
      q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
      q.update = async ({ structured_notes: raw }) => {
        const patch = JSON.parse(raw.bindings[0]);
        if ((state.notes.lawnVisitSummary || {})[q.guardKey]) return 0;
        state.notes.lawnVisitSummary = { ...(state.notes.lawnVisitSummary || {}), ...patch };
        return 1;
      };
      return q;
    };
    knex.raw = (sql, bindings) => ({ sql, bindings });
    return { knex, state };
  }
  const freeze = (knex, facts = CASES.stonewallCombinationFall.facts, extra = {}) => summary.createAndFreezeVisitSummary({
    serviceRecordId: 's1', assessmentId: 77, getStructuredNotes: async () => (await knex('x').first()).structured_notes, gatherInputs: async () => facts, knex, ...extra,
  });

  test('freezes { text, slots } under lawnVisitSummary[assessmentId]; a retry changes nothing; the render reads it back', async () => {
    const { knex, state } = fakeKnex();
    const out = await freeze(knex);
    expect(out.status).toBe('frozen');
    const entry = state.notes.lawnVisitSummary['77'];
    expect(entry).toMatchObject({ v: summary.FREEZE_VERSION, assessmentId: '77', text: CASES.stonewallCombinationFall.expected });
    expect(entry.slots).toMatchObject({ season: 'fall', applied: ['combo_pre_emergent', 'insecticide'] });
    expect(entry).not.toHaveProperty('sources');
    expect((await freeze(knex, CASES.holdWithFinding.facts)).status).toBe('already_frozen');
    expect(state.notes.lawnVisitSummary['77'].text).toBe(CASES.stonewallCombinationFall.expected);
    expect(summary.readFrozenVisitSummary(state.notes, 77)).toBe(CASES.stonewallCombinationFall.expected);
    expect(summary.visitSummarySignature(state.notes, 77)).toMatch(/^:tp=[0-9a-f]{8}$/);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('nothing to ground freezes nothing; a failed fact read freezes nothing', async () => {
    const a = fakeKnex();
    expect((await freeze(a.knex, { season: 'fall', applied: [], areas: [], findings: [] })).status).toBe('nothing_to_ground');
    expect(a.state.notes.lawnVisitSummary).toBeUndefined();
    const b = fakeKnex();
    const out = await summary.createAndFreezeVisitSummary({ serviceRecordId: 's1', assessmentId: 77, structuredNotes: {}, gatherInputs: async () => { throw new Error('read failed'); }, knex: b.knex });
    expect(out.status).toBe('read_failed');
    expect(b.state.notes.lawnVisitSummary).toBeUndefined();
  });

  describe('an expired watering note is no longer commanded (Codex r3)', () => {
    const EXPIRES = '2026-10-07T14:40:00.000Z';
    const before = new Date('2026-10-07T10:00:00Z');
    const after = new Date('2026-10-07T15:00:00Z');
    const frozenWith = async (watering) => {
      const { knex, state } = fakeKnex();
      await freeze(knex, { ...CASES.stonewallCombinationFall.facts, watering });
      return JSON.parse(JSON.stringify(state.notes));
    };
    const WATER_SENTENCE = 'Please water the treated lawn in with 0.5 inches of water within 24 hours of today’s visit. ';

    test('before expiry the watering sentence shows; after it the paragraph is the same minus that sentence', async () => {
      const notes = await frozenWith({ state: 'water_in', inches: 0.5, hours: 24, expiresAt: EXPIRES });
      const full = CASES.stonewallCombinationFall.expected;
      expect(summary.readFrozenVisitSummary(notes, 77, before)).toBe(full);
      const expired = summary.readFrozenVisitSummary(notes, 77, after);
      expect(expired).toBe(full.replace(WATER_SENTENCE, ''));
      expect(expired).not.toMatch(/water/i);
      expectOwnerRules(expired);
    });

    test('a hold ends the same way; with no known expiry (a drying hold) it stays', async () => {
      const hold = await frozenWith({ state: 'hold', expiresAt: EXPIRES });
      expect(summary.readFrozenVisitSummary(hold, 77, before)).toContain('hold off on watering');
      expect(summary.readFrozenVisitSummary(hold, 77, after)).not.toMatch(/hold off|water/i);
      const dry = await frozenWith({ state: 'hold', expiresAt: null });
      expect(summary.readFrozenVisitSummary(dry, 77, after)).toContain('hold off on watering');
    });

    test('the PDF key follows what prints, and the strict guard still applies after expiry', async () => {
      const notes = await frozenWith({ state: 'water_in', inches: 0.5, hours: 24, expiresAt: EXPIRES });
      expect(summary.visitSummarySignature(notes, 77, before)).not.toBe(summary.visitSummarySignature(notes, 77, after));
      expect(summary.visitSummarySignature(notes, 77, after)).toMatch(/^:tp=[0-9a-f]{8}$/);
      notes.lawnVisitSummary['77'].text = notes.lawnVisitSummary['77'].text.replace('few weeds', 'hardly any weeds');
      expect(summary.readFrozenVisitSummary(notes, 77, after)).toBeNull();
    });

    test('the facts carry the frozen instruction\'s expiry', () => {
      const instruction = { state: 'water_in', waterInInches: 0.5, completedAt: '2026-10-06T14:40:00Z', waterInBy: EXPIRES, expiresAt: EXPIRES };
      expect(wateringFacts(instruction).expiresAt).toBe(EXPIRES);
      expect(wateringFacts({ state: 'hold', expiresAt: EXPIRES }).expiresAt).toBe(EXPIRES);
      expect(wateringFacts({ state: 'hold' }).expiresAt).toBeNull();
    });
  });

  describe('the read-time guard prints nothing for an entry that no longer matches', () => {
    const entryOf = async () => {
      const { knex, state } = fakeKnex();
      await freeze(knex);
      return JSON.parse(JSON.stringify(state.notes));
    };
    const read = (notes) => summary.readFrozenVisitSummary(notes, 77);

    test('a hand-edited text (banned copy, an all clear, a product name)', async () => {
      for (const edit of [
        (t) => t.replace('Our photo read shows few weeds', 'There are no issues'),
        (t) => `${t} We guarantee results.`,
        (t) => t.replace('a feeding', 'Stonewall'),
      ]) {
        const notes = await entryOf();
        notes.lawnVisitSummary['77'].text = edit(notes.lawnVisitSummary['77'].text);
        expect(read(notes)).toBeNull();
      }
    });

    test('edited slots, a missing slots object, an old version or another assessment', async () => {
      let notes = await entryOf();
      notes.lawnVisitSummary['77'].slots.watering.inches = 2;
      expect(read(notes)).toBeNull();
      notes = await entryOf();
      delete notes.lawnVisitSummary['77'].slots;
      expect(read(notes)).toBeNull();
      notes = await entryOf();
      notes.lawnVisitSummary['77'].v = 1;
      expect(read(notes)).toBeNull();
      notes = await entryOf();
      expect(summary.readFrozenVisitSummary(notes, 78)).toBeNull();
    });

    test('a table change after the freeze: the stored text no longer equals what the tables render', async () => {
      const notes = await entryOf();
      notes.lawnVisitSummary['77'].text = notes.lawnVisitSummary['77'].text.replace('few weeds', 'hardly any weeds');
      expect(read(notes)).toBeNull();
    });

    test('an unchanged entry reads back', async () => {
      expect(read(await entryOf())).toBe(CASES.stonewallCombinationFall.expected);
    });
  });
});

describe('the PDF path keeps the whole frozen summary (Codex r5)', () => {
  test('reconciliation shortens todaysResult to a first sentence but leaves data.summary and its source whole', () => {
    const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
    const { paragraph } = composeCase('stonewallCombinationFall');
    const data = {
      serviceLine: 'lawn',
      summary: paragraph,
      summarySource: 'lawn_visit_summary',
      reportV2: { insights: [{ category: 'damage', status: 'watch', headline: 'Stress watch' }], snapshot: {} },
    };
    applyLawnReportReconciliation(data, null);
    expect(data.summary).toBe(paragraph);
    expect(data.summarySource).toBe('lawn_visit_summary');
    // The reconciled result is only the lead sentence: the document must print data.summary for this source.
    expect(String(data.reportV2.todaysResult).length).toBeLessThan(paragraph.length);
  });
});

describe('the gate', () => {
  test('dark by default, strict opt-in, read at call time', () => {
    delete process.env.GATE_LAWN_VISIT_SUMMARY_V2;
    expect(featureGates.lawnVisitSummaryV2Live()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'yes', '']) { process.env.GATE_LAWN_VISIT_SUMMARY_V2 = v; expect(featureGates.lawnVisitSummaryV2Live()).toBe(false); }
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    expect(featureGates.lawnVisitSummaryV2Live()).toBe(true);
    delete process.env.GATE_LAWN_VISIT_SUMMARY_V2;
  });
});
