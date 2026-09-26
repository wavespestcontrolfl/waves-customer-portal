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
const { buildPestPressureCustomerView } = require('../services/pest-pressure/customer-view');
const { sanitizeRecap } = require('../services/completion-recap');
const { appointmentClaimProblems } = require('../services/service-report/next-visit-claims');

const {
  groundingFacts,
  deterministicSummary,
  formatNextVisitDate,
  formatArrivalWindow,
  buildUserMessage,
  recapWithoutStaleAppointment,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
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
  expect(facts.pressure).toEqual({ label: 'Low', trend: 'improving', isZero: false });
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

test('reviewed prompt keeps pressure qualitative and treats missing or zero pressure correctly', () => {
  const pressure = buildPestPressureCustomerView({
    config: { enabled: true, showOnCustomerReport: true },
    scoreRow: { displayed_score: 0, label_name: 'No visible activity', trend: 'first_marker' },
  });
  expect(pressure.displayScore).toBe('0.0');
  const zero = groundingFacts(input({
    pestPressure: pressure,
    serviceTypeDisplay: 'One-Time Pest Control',
  }));
  expect(zero.pressure).toEqual({ label: 'No visible activity', trend: 'first_marker', isZero: true });
  expect(groundingFacts(input({
    pestPressure: { enabled: true, displayScore: 0.3, label: 'None' },
  })).pressure).toEqual({ label: 'None', trend: null, isZero: false });
  expect(buildUserMessage(zero)).toContain('"serviceTypeDisplay": "One-Time Pest Control"');
  expect(buildUserMessage(zero)).not.toContain('"displayScore"');
  expect(groundingFacts(input({ pestPressure: { enabled: true, displayScore: null } })).pressure).toBeNull();
  expect(SYSTEM_PROMPT).toContain('for a Waves pest control service.');
  expect(SYSTEM_PROMPT).toContain('within the assessed scope');
  expect(SYSTEM_PROMPT).toContain('Missing pressure is unknown, not zero');
  expect(SYSTEM_PROMPT).toContain('Report change only when supplied');
  expect(SYSTEM_PROMPT).toContain('Mention at most one customer-visible finding');
  expect(SYSTEM_PROMPT).toContain('Never blame the customer');
  expect(PROMPT_VERSION).toBe('pest_visit_summary_narrative_v3');
});

test('current next visit replaces stale recap appointment in model facts and fallback', () => {
  const staleRecap = [
    'We treated the perimeter and entry points today.',
    'Keep people and pets away from treated surfaces until dry.',
    'Your next visit is scheduled for Thursday, September 24, arriving 1–3 PM.',
  ].join(' ');
  const facts = groundingFacts(input({ recap: staleRecap }));
  const fallback = deterministicSummary(facts);

  expect(facts.recap).toContain('treated the perimeter');
  expect(facts.recap).toContain('until dry');
  expect(facts.recap).not.toContain('September 24');
  expect(buildUserMessage(facts)).not.toContain('September 24');
  expect(fallback).toContain('Friday, October 2, arriving 8–10 AM');
  expect(fallback).not.toContain('September 24');
});

test('current appointment appears once and null nextVisit leaves recap appointment untouched', () => {
  const current = 'We completed the perimeter service. Your next visit is scheduled for Friday, October 2, arriving 8–10 AM.';
  const facts = groundingFacts(input({ recap: current }));
  expect((deterministicSummary(facts).match(/Friday, October 2/g) || [])).toHaveLength(1);

  const withoutNext = groundingFacts(input({ recap: current, nextAppointment: null }));
  expect(withoutNext.recap).toBe(current);
  expect(deterministicSummary(withoutNext)).toBe(current);
});

test('appointment sanitizer preserves work and bare next-visit care plans', () => {
  const recap = 'We sealed a 1.5-foot gap, and your next appointment is booked for Sep 24 at 1 p.m. We will recheck the garage next visit.';
  expect(recapWithoutStaleAppointment(recap, { date: 'Friday, October 2' })).toBe(
    'We sealed a 1.5-foot gap. We will recheck the garage next visit.',
  );
});

test('appointment sanitizer preserves unrelated decimal and AM/PM work and advice', () => {
  const recap = 'We documented a 1.5-foot gap at 8 a.m. Your next visit is scheduled for Sep 24, arriving 1–3 p.m. Keep pets away until 4 p.m.';
  expect(recapWithoutStaleAppointment(recap, { date: 'Friday, October 2' })).toBe(
    'We documented a 1.5-foot gap at 8 a.m. Keep pets away until 4 p.m.',
  );
});

test.each([
  'We will see you again on Thursday, September 24, arriving 1–3 PM.',
  'See you Sep 24, arriving 1–3 p.m.',
])('common writer appointment form is replaced: %s', (appointmentCopy) => {
  const recap = `We treated the perimeter today. ${appointmentCopy} Keep people and pets away until dry.`;
  const facts = groundingFacts(input({ recap }));
  expect(facts.recap).toBe('We treated the perimeter today. Keep people and pets away until dry.');
  expect(deterministicSummary(facts)).toContain('Friday, October 2, arriving 8–10 AM');
});

test.each([
  ['Your next visit is scheduled for Oct 2 and keep pets off treated surfaces until dry.', 'Keep pets off treated surfaces until dry.'],
  ['We treated the perimeter. Your next visit is scheduled for Oct 2 and 3 entry points should remain clear.', 'We treated the perimeter. 3 entry points should remain clear.'],
  ['We treated the perimeter. Your next visit is scheduled for Oct 2 and keep pets off treated surfaces until dry.', 'We treated the perimeter. Keep pets off treated surfaces until dry.'],
  ['We treated the perimeter. Your next visit is scheduled for Oct 2, and keep pets off treated surfaces until dry.', 'We treated the perimeter. Keep pets off treated surfaces until dry.'],
  ['We treated the perimeter, and your next visit is scheduled for Oct 2 and keep pets off treated surfaces until dry.', 'We treated the perimeter. Keep pets off treated surfaces until dry.'],
])('same-sentence aftercare survives appointment removal: %s', (recap, expected) => {
  expect(recapWithoutStaleAppointment(recap, { date: 'Friday, October 9' })).toBe(
    expected,
  );
});

test.each([
  ['Your next visit is scheduled for Oct 2. Keep pets off treated surfaces until dry.', 'Keep pets off treated surfaces until dry.'],
  ['The next visit is scheduled for Oct 2. Keep pets off treated surfaces until dry.', 'Keep pets off treated surfaces until dry.'],
  ['We treated the perimeter. Your next visit is scheduled for Oct 2. - Waves', 'We treated the perimeter.'],
  ['We treated the perimeter. Your next visit is scheduled for Oct 2, 1–3 PM.', 'We treated the perimeter.'],
  ['We sealed a 1.5-foot gap, and your next appointment is booked for Sep 24 at 1 p.m.', 'We sealed a 1.5-foot gap.'],
  [sanitizeRecap('We sealed a gap, and your next appointment is booked for Sep 24 at 1 p.m.'), 'We sealed a gap.'],
  [sanitizeRecap('We treated the perimeter, and your next appointment is booked for Sep 24'), 'We treated the perimeter.'],
])('appointment removal preserves sentence boundaries: %s', (recap, expected) => {
  expect(recapWithoutStaleAppointment(recap, { date: 'Friday, October 9' })).toBe(expected);
});

test.each([
  'We discussed whether the next visit is scheduled for Oct 2 and agreed to confirm with the office.',
  'Your next visit is scheduled for October 2026.',
])('unsupported appointment prose remains intact: %s', (recap) => {
  expect(recapWithoutStaleAppointment(recap, { date: 'Friday, October 9' })).toBe(recap);
});

test.each([
  'Your next visit is scheduled for Oct 2 at 1 p.m.',
  sanitizeRecap('Your next visit is scheduled for Oct 2 at 1 p.m.'),
  sanitizeRecap('Your next visit is scheduled for Oct 2.'),
])('appointment-only recap retains the authoritative appointment without calling a provider: %s', async (recap) => {
  const callModel = jest.fn();
  const out = await applyVisitSummaryNarrative(input({
    recap,
  }), { callModel });
  expect(out).toBe('Your next visit is scheduled for Friday, October 2, arriving 8–10 AM.');
  expect(callModel).not.toHaveBeenCalled();
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
  expect(callModel).toHaveBeenCalledWith(expect.objectContaining({
    jsonMode: true,
    maxTokens: 400,
    promptVersion: 'pest_visit_summary_narrative_v3',
  }));
});

test.each([
  ['a mismatched date', 'We refreshed the perimeter today. Your next visit will be Saturday, October 3, arriving 8–10 AM.'],
  ['a mismatched window', 'We refreshed the perimeter today. Your next visit is scheduled for Friday, October 2, arriving 1–3 PM.'],
  ['an unsupported appointment form', 'We refreshed the perimeter today. Your next visit is scheduled soon, and we will keep monitoring the treated areas.'],
  ['an unsupported relative date', 'We refreshed the perimeter today. Your next appointment is tomorrow, arriving 8–10 AM.'],
  ['a mismatched appointment label', 'We refreshed the perimeter today. Next visit: Saturday, October 3, arriving 8–10 AM.'],
])('model output with %s falls back to grounded copy', async (_label, summary) => {
  const args = input();
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test('model cannot invent an appointment when no next visit was supplied', async () => {
  const args = input({ nextAppointment: null });
  const summary = 'We refreshed the perimeter and entry points today. Your next visit is scheduled for Friday, October 2, arriving 8–10 AM.';
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test('appointment guard ignores grounded work numbers, aftercare times, and unrelated dates', async () => {
  expect(appointmentClaimProblems(
    'We treated 3 entry points after reviewing the September 18 note. Keep pets away until 4 PM.',
    { nextVisit: null },
  )).toEqual([]);
  expect(appointmentClaimProblems(
    'We will recheck the garage next visit.',
    { nextVisit: null },
  )).toEqual([]);

  const summary = 'We treated 3 entry points after reviewing the September 18 note. Keep the threshold clear until the sealant dries.';
  const args = input({ recap: summary, nextAppointment: null });
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(summary);
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
