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
const { appointmentClaimProblems } = require('../services/service-report/next-visit-claims');

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

test('model output must include the supplied next visit', async () => {
  const args = input();
  const summary = 'We refreshed the perimeter and entry points today, and activity has continued to trend down.';
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test.each([
  'Friday, October 2, 2027',
  'Friday, October 2 in 2027',
  'Friday, October 2 of 2027',
  'Friday, October 2 (2027)',
  'Friday, October 2, in 2027',
  'Friday, October 2nd, 2027',
  'Friday, October 2nd in 2027',
  'Friday, October 2nd (2027)',
  'Friday, October 2ND, in 2027',
])('model output cannot add a year to the supplied next-visit date: %s', async (date) => {
  const args = input();
  const summary = `We refreshed the perimeter and entry points today. Your next visit is ${date}, arriving 8–10 AM.`;
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test.each(['1st', '2nd', '3rd', '4th', '21st', '22nd', '23rd', '31st'])('ordinal dates retain date and year validation: %s', (ordinal) => {
  const day = Number.parseInt(ordinal, 10);
  const facts = { nextVisit: { date: `October ${day}`, window: '8–10 AM' } };
  expect(appointmentClaimProblems(`Your next visit is October ${ordinal}, arriving 8–10 AM.`, facts)).toEqual([]);
  expect(appointmentClaimProblems(`Your next visit is October ${ordinal}, 2027, arriving 8–10 AM.`, facts))
    .toEqual(expect.arrayContaining([expect.stringContaining('ungrounded_date:')]));
  expect(appointmentClaimProblems(`Your next visit is October ${ordinal}, arriving 8–10 AM.`, {
    nextVisit: { date: `October ${day === 31 ? 30 : day + 1}`, window: '8–10 AM' },
  })).toEqual(expect.arrayContaining([expect.stringContaining('ungrounded_date:')]));
});

test.each([
  "Friday, October 2, '27",
  'Friday, October 2, ’27',
  "Friday, October 2nd, '27",
  "Friday, October 2 in '27",
  'Friday, October 2, 27',
  'Friday, October 2nd (27)',
])('model output cannot add an abbreviated year to the supplied next-visit date: %s', (date) => {
  const facts = { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } };
  expect(appointmentClaimProblems(`Your next visit is ${date}, arriving 8–10 AM.`, facts))
    .toEqual(expect.arrayContaining([expect.stringContaining('ungrounded_date:')]));
});

test.each(['8 AM', '10 AM', '10 a.m.', '8 p.m.', '10 A.M.', '10 a.m'])('a grounded range does not authorize an exact %s arrival promise', (time) => {
  const facts = { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } };
  expect(appointmentClaimProblems(
    `Your next visit is Friday, October 2, arriving 8–10 AM, specifically at ${time}.`,
    facts,
  )).toEqual(expect.arrayContaining([expect.stringContaining('ungrounded_time:')]));
});

test.each([
  ['The technician will arrive at8PM.', '8 PM'],
  ['The technician will arrive at 8PM.', '8 PM'],
  ['Your specialist expects to be there at 10 a.m.', '10 AM'],
  ['A crew member plans to reach the property at 8 p.m.', '8 PM'],
])('exact arrival times are rejected independently of the sentence subject: %s', (extra, normalizedTime) => {
  const facts = { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } };
  expect(appointmentClaimProblems(
    `Your next visit is Friday, October 2, arriving 8–10 AM. ${extra}`,
    facts,
  )).toContain(`ungrounded_time:${normalizedTime}`);
});

test('a subject-qualified exact arrival makes model copy fall back deterministically', async () => {
  const args = input();
  const summary = 'Your next visit is Friday, October 2, arriving 8–10 AM. The technician will arrive at8PM.';
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test('arrival windows are validated independently of the sentence subject', () => {
  const facts = { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } };
  expect(appointmentClaimProblems(
    'Your next visit is Friday, October 2, arriving 8–10 AM. The technician expects a 1–3 PM arrival window.',
    facts,
  )).toContain('ungrounded_window:1–3 PM');
});

test.each(['specifically at 10 a.m.', 'and specifically at 10 p.m.'])(
  'dotted arrival windows retain their exact-arrival continuation: %s', (continuation) => {
    expect(appointmentClaimProblems(
      `Your next visit is Friday, October 2, arriving 8–10 a.m. ${continuation}`,
      { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } },
    )).toEqual(expect.arrayContaining([expect.stringContaining('ungrounded_time:')]));
  },
);

test.each([
  'Your next visit is Friday, October 2, arriving 8–10 AM.',
  'Your next visit is Friday, October 2, arriving 8–10 AM, and keep pets away until 8 AM.',
  'Your next visit is Friday, October 2, arriving 8–10 AM, and keep pets away until 10 AM.',
  'Your next visit is Friday, October 2, arriving 8–10 a.m.',
  'Your next visit is Friday, October 2, arriving 8–10 AM, and keep pets away until 10 a.m.',
  'Your next visit is Friday, October 2, arriving 8–10 a.m. and keep pets away until 4 p.m.',
])('grounded range copy remains valid without a year or exact arrival promise: %s', (summary) => {
  expect(appointmentClaimProblems(
    summary,
    { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } },
  )).toEqual([]);
});

test.each([
  'Keep pets away until 4 PM.',
  'Leave treated surfaces alone until 4 p.m.',
  'Avoid treated areas until 4 PM.',
  'Do not re-enter until 4 p.m.',
])('a bounded aftercare instruction may retain its supported clock time: %s', (instruction) => {
  expect(appointmentClaimProblems(instruction, { nextVisit: null })).toEqual([]);
});

test.each([
  ['with the grounded slot', { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } }],
  ['without a grounded slot', { nextVisit: null }],
])('an instruction prefix cannot hide embedded appointment times %s', (_label, facts) => {
  const prefix = facts.nextVisit
    ? 'Your next visit is Friday, October 2, arriving 8–10 AM. '
    : '';
  expect(appointmentClaimProblems(
    `${prefix}Leave the gate open for the technician, who will arrive at 8 PM and stay until 10 PM.`,
    facts,
  )).toEqual(expect.arrayContaining([
    'ungrounded_time:8 PM',
    'ungrounded_time:10 PM',
  ]));
});

test.each([
  ['with the grounded slot', input(), 'Your next visit is Friday, October 2, arriving 8–10 AM. '],
  ['without a grounded slot', input({ nextAppointment: null }), ''],
])('embedded appointment times force deterministic fallback %s', async (_label, args, prefix) => {
  const summary = `${prefix}Leave the gate open for the technician, who will arrive at 8 PM and stay until 10 PM.`;
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test.each([
  'Your next visit is Friday, October 2, arriving 8–10 AM. The technician will arrive during the 8–10 AM window.',
  'The technician said to keep pets away until 4 PM. Your next visit is Friday, October 2, arriving 8–10 AM.',
  'Your next visit is Friday, October 2, arriving 8–10 AM. The technician’s arrival window remains 8–10 AM. Leave treated surfaces alone until 4 p.m.',
])('subject-independent validation preserves the supplied window and explicit aftercare times: %s', (summary) => {
  expect(appointmentClaimProblems(
    summary,
    { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } },
  )).toEqual([]);
});

test('each appointment promise must independently match the authoritative slot', async () => {
  const args = input();
  const summary = 'We refreshed the perimeter today. Your next visit is Friday, October 2, arriving 8–10 AM. We will return next week to inspect again.';
  const problems = appointmentClaimProblems(summary, groundingFacts(args));
  expect(problems).toEqual(expect.arrayContaining([
    'duplicate_appointment_claim',
    'unsupported_appointment_date',
    'unsupported_appointment_window',
  ]));
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test('a subject-qualified future return cannot append a second appointment date', async () => {
  const args = input();
  const summary = 'Your next visit is Friday, October 2, arriving 8–10 AM. The technician will return on Monday, October 5.';
  expect(appointmentClaimProblems(summary, groundingFacts(args))).toEqual(expect.arrayContaining([
    'duplicate_appointment_claim',
    'ungrounded_weekday:Monday',
    'unsupported_appointment_date',
    'unsupported_appointment_window',
  ]));
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test.each([
  'A specialist will arrive on Monday, October 5.',
  'Your service team will be back Monday, October 5.',
  'They’ll come back on Monday, October 5.',
])('future return and arrival actions are claims without a subject allowlist: %s', (promise) => {
  const facts = { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } };
  const problems = appointmentClaimProblems(
    `Your next visit is Friday, October 2, arriving 8–10 AM. ${promise}`,
    facts,
  );
  expect(problems).toEqual(expect.arrayContaining([
    'duplicate_appointment_claim',
    'ungrounded_weekday:Monday',
  ]));
});

test('a negated subject-qualified return remains a rejected appointment claim', () => {
  const facts = { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } };
  expect(appointmentClaimProblems(
    'Your next visit is Friday, October 2, arriving 8–10 AM. The technician will not return on Monday, October 5.',
    facts,
  )).toEqual(expect.arrayContaining([
    'duplicate_appointment_claim',
    'negated_appointment_claim',
    'ungrounded_weekday:Monday',
  ]));
});

test.each([
  'Your next visit is not scheduled for Friday, October 2, arriving 8–10 AM.',
  'Your next visit is cancelled for Friday, October 2, arriving 8–10 AM.',
  'Your next visit is canceled for Friday, October 2, arriving 8–10 AM.',
  'Your next visit has been cancelled for Friday, October 2, arriving 8–10 AM.',
  'Your next visit is no longer scheduled for Friday, October 2, arriving 8–10 AM.',
])('a non-affirmative statement of the authoritative slot falls back: %s', async (appointment) => {
  const args = input();
  const summary = `We refreshed the perimeter today. ${appointment}`;
  expect(appointmentClaimProblems(summary, groundingFacts(args))).toContain('negated_appointment_claim');
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(deterministicSummary(groundingFacts(args)));
});

test.each([
  'We treated a gap first noted on September 18, and your next visit is Friday, October 2, arriving 8–10 AM.',
  'Keep pets away until 4 PM, and your next visit is Friday, October 2, arriving 8–10 AM.',
  'Keep pets away until 8 AM, and your next visit is Friday, October 2, arriving 8–10 AM.',
])('appointment guard ignores dates and times before the appointment clause: %s', (summary) => {
  expect(appointmentClaimProblems(summary, {
    nextVisit: { date: 'Friday, October 2', window: '8–10 AM' },
  })).toEqual([]);
});

test('model output keeps an unrelated work date before the grounded appointment', async () => {
  const args = input();
  const summary = 'We treated a gap first noted on September 18, and your next visit is Friday, October 2, arriving 8–10 AM.';
  const out = await applyVisitSummaryNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toBe(summary);
});

test.each([
  ['a mismatched date', 'We refreshed the perimeter today. Your next visit will be Saturday, October 3, arriving 8–10 AM.'],
  ['a mismatched window', 'We refreshed the perimeter today. Your next visit is scheduled for Friday, October 2, arriving 1–3 PM.'],
  ['an unsupported appointment form', 'We refreshed the perimeter today. Your next visit is scheduled soon, and we will keep monitoring the treated areas.'],
  ['an unsupported relative date', 'We refreshed the perimeter today. Your next appointment is tomorrow, arriving 8–10 AM.'],
  ['a mismatched appointment label', 'We refreshed the perimeter today. Next visit: Saturday, October 3, arriving 8–10 AM.'],
  ['a contradictory arrival sentence', 'Your next visit is Friday, October 2, arriving 8–10 AM. Arrival is at 8 PM.'],
  ['a contradictory arrival window sentence', 'Your next visit is Friday, October 2, arriving 8–10 AM. Your arrival window is 8–10 PM.'],
  ['a contradictory arrival label', 'Your next visit is Friday, October 2, arriving 8–10 AM. Arrival time: 8 PM.'],
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

test.each([
  'We’ll come back next week to inspect again.',
  "We'll check back next week to inspect again.",
  'We will check back next week to inspect again.',
  "We'll follow up next week to inspect again.",
  'We’ll follow-up next week to inspect again.',
  'The technician will return next week to inspect again.',
  'Your next follow-up is next week.',
  'The upcoming follow up is tomorrow.',
  'Arrival is at 8 PM.',
])('model cannot invent an appointment promise without a next visit: %s', async (promise) => {
  const args = input({ nextAppointment: null });
  const summary = `We refreshed the perimeter and entry points today. ${promise}`;
  expect(appointmentClaimProblems(summary, groundingFacts(args))).toContain('ungrounded_appointment_claim');
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
  expect(appointmentClaimProblems(
    'The technician returned on Monday, September 28 after documenting the garage. Your next visit is Friday, October 2, arriving 8–10 AM.',
    { nextVisit: { date: 'Friday, October 2', window: '8–10 AM' } },
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
