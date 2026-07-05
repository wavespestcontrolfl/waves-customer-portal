// Pest Visit Summary narrative (env-gated report-time enrichment).
//
// Load-bearing behaviors: the model NEVER speaks unguarded (banned copy or a
// miss falls back to the deterministic summary), the deterministic summary is
// the tech's recap plus a plain next-visit sentence, and generation caches on
// the grounding-facts hash so a permanent report token re-views the same copy.

const {
  applyVisitSummaryNarrative,
  _test,
} = require('../services/service-report/visit-summary-narrative');

const {
  groundingFacts,
  deterministicSummary,
  formatNextVisitDate,
  formatArrivalWindow,
  _cache,
} = _test;

const RECAP = 'Your quarterly pest control visit is complete! We treated the perimeter and entry points.';

// distinct recaps keep the module-level fact-hash cache from bleeding between tests
let seq = 0;
function input(overrides = {}) {
  seq += 1;
  return {
    recap: `${RECAP} (case ${seq})`,
    serviceTypeDisplay: 'Quarterly Pest Control',
    areasServiced: ['Perimeter', 'Entry points'],
    pestPressure: {
      enabled: true,
      displayScore: 1.8,
      maxScore: 5,
      label: 'Low',
      trend: 'improving',
      trendDelta: -0.6,
      summary: 'Pest Pressure is trending down since your last visit.',
    },
    findings: [{ title: 'Ant trail at garage threshold', severity: 'medium', recommendation: 'Keep the threshold clear' }],
    nextAppointment: { serviceType: 'Quarterly Pest Control Service', scheduledDate: '2026-10-02', windowStart: '08:00' },
    ...overrides,
  };
}

beforeEach(() => _cache.clear());

test('formatNextVisitDate / formatArrivalWindow render the customer-facing forms', () => {
  expect(formatNextVisitDate('2026-10-02')).toBe('Friday, October 2');
  expect(formatNextVisitDate('2026-10-02T00:00:00.000Z')).toBe('Friday, October 2');
  expect(formatNextVisitDate('not-a-date')).toBeNull();
  // arrival window is ALWAYS window_start + 2 hours
  expect(formatArrivalWindow('08:00')).toBe('8–10 AM');
  expect(formatArrivalWindow('11:00')).toBe('11 AM–1 PM');
  expect(formatArrivalWindow('23:00')).toBe('11 PM–1 AM');
  // half-hour starts keep their minutes — "1–3 PM" for a 1:30 arrival is wrong
  expect(formatArrivalWindow('13:30')).toBe('1:30–3:30 PM');
  expect(formatArrivalWindow('08:30')).toBe('8:30–10:30 AM');
  expect(formatArrivalWindow('')).toBeNull();
  expect(formatArrivalWindow('nope')).toBeNull();
});

test('groundingFacts keeps only usable facts', () => {
  const facts = groundingFacts(input());
  expect(facts.pressure).toMatchObject({ displayScore: 1.8, trend: 'improving' });
  expect(facts.findings).toHaveLength(1);
  expect(facts.nextVisit).toEqual({ date: 'Friday, October 2', window: '8–10 AM' });

  // pressure hidden when the view is disabled or has no score
  expect(groundingFacts(input({ pestPressure: { enabled: true, displayScore: null } })).pressure).toBeNull();
  expect(groundingFacts(input({ pestPressure: null })).pressure).toBeNull();
  // findings without titles drop; list caps at 3
  const many = Array.from({ length: 5 }, (_, i) => ({ title: `Finding ${i}` }));
  expect(groundingFacts(input({ findings: [...many, { title: '' }] })).findings).toHaveLength(3);
  // next visit needs a real date
  expect(groundingFacts(input({ nextAppointment: { scheduledDate: 'garbage' } })).nextVisit).toBeNull();
});

test('deterministic summary = recap + plain next-visit sentence', () => {
  const facts = groundingFacts(input());
  expect(deterministicSummary(facts)).toBe(
    `${facts.recap} Your next visit is scheduled for Friday, October 2, arriving 8–10 AM.`,
  );
  const noNext = groundingFacts(input({ nextAppointment: null }));
  expect(deterministicSummary(noNext)).toBe(noNext.recap);
});

test('empty recap short-circuits without calling the model', async () => {
  const callModel = jest.fn();
  const out = await applyVisitSummaryNarrative(input({ recap: '' }), { callModel });
  expect(out).toBe('');
  expect(callModel).not.toHaveBeenCalled();
});

test('clean model output is used verbatim', async () => {
  const text = 'Great news — activity around your perimeter has been trending down since our last visit. We refreshed the treated areas today. We will see you again on Friday, October 2, arriving 8–10 AM.';
  const callModel = jest.fn().mockResolvedValue({ ok: true, json: { summary: text } });
  const out = await applyVisitSummaryNarrative(input(), { callModel });
  expect(out).toBe(text);
  expect(callModel).toHaveBeenCalledTimes(1);
});

test('banned copy in model output falls back to the deterministic summary', async () => {
  const callModel = jest.fn().mockResolvedValue({ ok: true, json: { summary: 'All pests are eliminated and your home is guaranteed pest-free for the season, with plenty more reassuring words to satisfy the minimum length check.' } });
  const args = input();
  const out = await applyVisitSummaryNarrative(args, { callModel });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test('prompt-only banned words are enforced too, not just the shared guard', async () => {
  // findBannedCustomerCopy catches "no infestation" but not bare
  // "infestation" — the module's extra list must catch what the prompt bans
  for (const word of ['infestation', 'toxic', 'poison', 'dangerous', 'safe', 'solved']) {
    const args = input();
    const callModel = jest.fn().mockResolvedValue({ ok: true, json: { summary: `We looked closely at the ${word} conditions around your home today and refreshed all treated areas so everything stays in good shape between visits.` } });
    const out = await applyVisitSummaryNarrative(args, { callModel });
    expect(out).toBe(deterministicSummary(groundingFacts(args)));
  }
  // "safety" must NOT trip the \bsafe\b rule
  const okArgs = input();
  const okText = 'We reviewed the safety instructions with you today and refreshed every treated area so things stay in good shape between visits. See you Friday, October 2, arriving 8–10 AM.';
  const callModel = jest.fn().mockResolvedValue({ ok: true, json: { summary: okText } });
  expect(await applyVisitSummaryNarrative(okArgs, { callModel })).toBe(okText);
});

test('model failure and short/garbage output fall back to the deterministic summary', async () => {
  const boom = input();
  const out1 = await applyVisitSummaryNarrative(boom, { callModel: jest.fn().mockRejectedValue(new Error('provider down')) });
  expect(out1).toBe(deterministicSummary(groundingFacts(boom)));

  const short = input();
  const out2 = await applyVisitSummaryNarrative(short, { callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: 'Too short.' } }) });
  expect(out2).toBe(deterministicSummary(groundingFacts(short)));

  const miss = input();
  const out3 = await applyVisitSummaryNarrative(miss, { callModel: jest.fn().mockResolvedValue({ ok: false, reason: 'json_parse' }) });
  expect(out3).toBe(deterministicSummary(groundingFacts(miss)));
});

test('same grounding facts hit the cache (permanent tokens re-view identical copy)', async () => {
  const text = 'Everything went smoothly today and activity has stayed low between visits at your home. We refreshed the perimeter and entry points. See you Friday, October 2, arriving 8–10 AM.';
  const callModel = jest.fn().mockResolvedValue({ ok: true, json: { summary: text } });
  const args = input();
  await applyVisitSummaryNarrative(args, { callModel });
  const again = await applyVisitSummaryNarrative(args, { callModel });
  expect(again).toBe(text);
  expect(callModel).toHaveBeenCalledTimes(1);

  // a reschedule changes the facts hash → fresh generation
  await applyVisitSummaryNarrative(
    { ...args, nextAppointment: { ...args.nextAppointment, scheduledDate: '2026-10-09' } },
    { callModel },
  );
  expect(callModel).toHaveBeenCalledTimes(2);
});
