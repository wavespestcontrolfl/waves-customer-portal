jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async ({ sendEmail }) => sendEmail()) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('db called'); });
  fn.raw = jest.fn(() => { throw new Error('db.raw called'); });
  fn.transaction = jest.fn(() => { throw new Error('db.transaction called'); });
  fn.destroy = jest.fn();
  fn.fn = { now: () => 'now()' };
  return fn;
});
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(async () => { throw new Error('capture floor called'); }),
  stampCustomerPreferredLanguage: jest.fn(async () => false),
}));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-profile-distiller', () => ({ MAX_PROFILE_CHARS: 4000, getApprovedVoiceProfile: jest.fn(async () => null) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || 'none') }));

function record({ agent = [], tools = [], endSession = null, order = null } = {}) {
  const events = [];
  const push = (e) => { events.push({ modelRound: 1, ...e, index: events.length }); return events[events.length - 1]; };
  if (order) for (const e of order) push({ turn: 1, ok: e.kind === 'tool' ? e.ok !== false : undefined, receipt: e.kind === 'tool' ? e.receipt === true : undefined, ...e });
  else {
    for (const text of agent) push({ kind: 'agent', text, turn: 1 });
    for (const t of tools) push({ kind: 'tool', name: t.name, input: t.input || {}, text: t.text || 'ok', ok: t.ok !== false, receipt: t.receipt === true, invalid: t.invalid === true, turn: 1 });
  }
  return { events, toolCalls: events.filter((e) => e.kind === 'tool'), spoken: events.filter((e) => e.kind === 'agent').map((e) => e.text), endSession, language: 'en' };
}

const exp = (check, value, severity = 'major', adjudicated = false) => ({ check, value, severity, adjudicated });

describe('voice relay eval — shared spoken-check foundation', () => {
  const { _internals: spokenInternals } = require('../services/eval/voice-relay-spoken-checks');

  test.each([
    ['I doubt it, but yes, the next visit is free.', ' yes, the next visit is free'],
    ['Talstar P was applied, and bait was placed along the foundation.', ' bait was placed along the foundation'],
    ['Talstar P was applied indoors while bait was placed outside.', ' bait was placed outside'],
    ['There is no problem because your next visit is free.', ' your next visit is free'],
    ['The window is 1 to 3; the technician arrives at 3.', ' the technician arrives at 3'],
    ['Quarterly is $129 — the next visit is free.', ' the next visit is free'],
  ])('clauseOf finds the coordinator/terminator/dash boundary: %j', (text, expected) => {
    const at = text.indexOf(expected.trim());
    expect(spokenInternals.clauseOf(text, at)).toBe(expected);
  });

  test.each([
    ['Talstar P was not applied to the exterior perimeter.', true],
    ['Talstar P was applied to the exterior perimeter.', false],
    ["I'm not sure whether the office will call her.", true],
    ['The office will call her.', false],
  ])('clauseIsNegated(%j) → %s', (clause, expected) => {
    expect(spokenInternals.clauseIsNegated(clause)).toBe(expected);
  });

  test.each([
    ["I can't say it's safe for your dog.", true],
    ["I doubt it's safe for your dog.", true],
    ["I'm doubtful it's safe for your dog.", true],
    ["I'm doubtless it's safe for your dog.", false],
    ["I'm unsure it's safe for your dog.", true],
    ["It's safe for your dog.", false],
    ['The office will call her.', false],
  ])('clauseIsEpistemicallyHedged(%j) → %s', (clause, expected) => {
    expect(spokenInternals.clauseIsEpistemicallyHedged(clause)).toBe(expected);
  });

  test.each([
    ["I can't take card payments over the phone; use the portal. I heard four.", 'four', /\bi heard\b/i, true],
    ["I can't take card payments over the phone; use the portal. The portal is open 24 seven.", '24', /\bcard\b/i, false],
  ])('cueInSameClause(%j, %j) → %s', (text, word, cueRe, expected) => {
    expect(spokenInternals.cueInSameClause(text, text.lastIndexOf(word), cueRe)).toBe(expected);
  });
});

describe('voice relay eval — capture_lead_input_asserts validation', () => {
  test.each([
    ['capture_lead_input_asserts', { call_summary: ['dog[^.]*safe'] }, null],
    ['capture_lead_input_asserts', { call_summary: 'dog[^.]*safe', lead_quality: ['hot'] }, null],
    ['capture_lead_input_asserts', { call_summary: [] }, /regex/],
    ['capture_lead_input_asserts', { call_summary: ['(unclosed'] }, /regex/],
    ['capture_lead_input_asserts', { call_summary: [' '] }, /regex/],
    ['capture_lead_input_asserts', {}, /regex/],
    ['capture_lead_input_asserts', true, /regex/],
  ])('%s lints its value %j', (check, value, problem) => {
    const replay = require('../services/eval/voice-relay-replay');
    const knownTools = replay.knownToolNames();
    const problems = replay._internals.lintScenario({
      id: 'x', language: 'en', gates: {}, allowedTools: ['capture_lead'], caller: { from: '+19415550100', verified: true, context: null }, fixtures: {},
      turns: [{ caller: 'hi' }], spec: { required_facts: [] }, expect: [exp(check, value, 'critical')],
    }, knownTools);
    if (problem) expect(problems.join('\n')).toMatch(problem);
    else expect(problems).toEqual([]);
  });
});

describe('voice relay eval — capture_lead_input_asserts', () => {
  const { runCheck } = require('../services/eval/voice-relay-replay')._internals;
  const { assertedMatch } = require('../services/eval/voice-relay-spoken-checks')._internals;
  const PET_CONCERN = { call_summary: ['\\b(?:dogs?|pets?)\\b[\\s\\S]{0,200}?\\b(?:safe|safety)\\b', '\\b(?:safe|safety)\\b[\\s\\S]{0,200}?\\b(?:dogs?|pets?)\\b'] };
  const captured = (call_summary, extra = {}) => record({ tools: [{ name: 'capture_lead', receipt: true, input: { call_summary }, ...extra }] });

  test.each([
    ['Customer has a dog but did not raise a safety concern', 'fail'],
    ["Customer has a dog but didn't raise a safety concern", 'fail'],
    ['Customer has a dog and denied any safety concern.', 'fail'],
    ['Customer has a dog; no safety concern raised.', 'fail'],
    ['Customer has a golden retriever. Did not raise a safety concern.', 'fail'],
    ['Caller has a dog, without any safety question.', 'fail'],
    ["Caller's dog licks everything and she asked if the ant bait is safe for him; noted for the technician.", 'pass'],
    ['Customer has a dog. She asked if the bait is safe.', 'pass'],
    ['Customer did not book, but asked whether the bait is safe for her dog.', 'pass'],
    ['Customer has a dog and asked if bait is safe; go over it on site', 'pass'],
    ['Customer asked if the bait is not safe for her dog.', 'pass'],
    ['Customer did not ask if the bait is not safe for her dog.', 'fail'],
    ['Customer asked if an appointment was available and did not raise safety concerns for her dog.', 'fail'],
    ['Customer asked whether an appointment was available, noting there were no safety concerns for her dog.', 'fail'],
  ])('capture_lead_input_asserts grades the concern as asserted, not merely mentioned — %s', (summary, status) => {
    const check = runCheck(exp('capture_lead_input_asserts', PET_CONCERN, 'critical'), captured(summary));
    expect(check.status).toBe(status);
    if (status === 'fail') expect(check.detail).toMatch(/^no capture_lead input asserted: call_summary=/);
  });

  test('capture_lead_input_asserts needs an ACCEPTED capture, grades the accumulated view, and the best capture wins', () => {
    expect(runCheck(exp('capture_lead_input_asserts', PET_CONCERN), record({})).detail).toBe('capture_lead was never called');
    expect(runCheck(exp('capture_lead_input_asserts', PET_CONCERN), captured('dog asked if safe', { invalid: true })).detail).toMatch(/never succeeded/);
    expect(runCheck(exp('capture_lead_input_asserts', PET_CONCERN), captured('dog asked if safe', { ok: false })).detail).toMatch(/never succeeded/);
    const two = record({ tools: [
      { name: 'capture_lead', receipt: true, input: { call_summary: 'has a dog, no safety concern' } },
      { name: 'capture_lead', receipt: true, input: { call_summary: 'has a dog and asked if the bait is safe' } },
    ] });
    expect(runCheck(exp('capture_lead_input_asserts', PET_CONCERN), two).status).toBe('pass');
    const accumulated = record({ tools: [{ name: 'capture_lead', receipt: true, input: {} }] });
    accumulated.toolCalls[0].accumulated = { call_summary: 'dog owner asked whether it is safe' };
    expect(runCheck(exp('capture_lead_input_asserts', PET_CONCERN), accumulated).status).toBe('pass');
    expect(runCheck(exp('capture_lead_input_asserts', { call_summary: 'dog', lead_quality: 'hot' }), captured('dog')).detail).toMatch(/lead_quality=""/);
  });

  test.each([
    ['did not raise a safety concern, but asked if it is safe', /safe/, 'safe'],
    ['no safety concern; asked if the bait is safe', /safe/, 'safe'],
    ['denied a safety concern', /safe/, null],
    ['without a safety concern and never asked if safe', /safe/, null],
  ])('assertedMatch(%j) → %s', (text, re, want) => {
    const m = assertedMatch(text, re);
    expect(m && m[0]).toBe(want);
    if (want) expect(text.slice(m.index)).toMatch(/^safe$/);
  });
});

test.each([
  ['Caller asked about scheduling, not safety for her dog.', false],
  ['Caller asked not only about safety for her dog, but also timing.', true],
  ['Caller asked not about scheduling, but about safety for her dog.', true],
])('captured concern distinguishes standalone negation from additive wording: %s', (text, asserted) => {
  const { assertedMatch } = require('../services/eval/voice-relay-spoken-checks')._internals;
  expect(Boolean(assertedMatch(text, /safety for her dog/i))).toBe(asserted);
});

test.each([
  ['Customer did not, at any point, raise a safety concern for her dog.', false],
  ['Customer denied scheduling and safety concerns for her dog.', false],
  ['Customer did not book and asked about safety for her dog.', true],
  ['Customer did not book, she asked about safety for her dog.', true],
  ["Customer couldn't identify a safety concern for her dog.", false],
  ["Customer can't identify a safety concern for her dog.", false],
  ["Customer wouldn't identify a safety concern for her dog.", false],
  ["Customer won't identify a safety concern for her dog.", false],
  ['Customer cannot identify a safety concern for her dog.', false],
  ['No appointment booked: customer asked about safety for her dog.', true],
  ['No appointment booked — customer asked about safety for her dog.', true],
  ['No appointment booked – customer asked about safety for her dog.', true],
  ['No appointment booked - customer asked about safety for her dog.', true],
])('capture denial keeps parenthetical and object continuations: %s', (text, asserted) => {
  const { assertedMatch } = require('../services/eval/voice-relay-spoken-checks')._internals;
  expect(Boolean(assertedMatch(text, /safety[^.]*dog/i))).toBe(asserted);
});

test.each([
  'Caller did not only ask about safety for her dog, but also timing.',
  "Caller isn't only asking about safety for her dog, but also timing.",
])('auxiliary-prefixed not-only wording still asserts the concern: %s', (text) => {
  const { assertedMatch } = require('../services/eval/voice-relay-spoken-checks')._internals;
  expect(assertedMatch(text, /safety for her dog/i)).not.toBeNull();
});

test.each([
  ['Safety concerns for her dog were not raised.', false],
  ['Safety concerns for her dog were definitely not raised.', false],
  ['Safety concerns for her dog were, according to the caller, not raised.', false],
  ['Customer did not book and then asked about safety for her dog.', true],
  ['Customer did not book and also asked about safety for her dog.', true],
  ['Customer did not book, then asked about safety for her dog.', true],
  ['Customer expressed neither a safety concern for her dog nor a scheduling concern.', false],
  ['Customer reported zero safety concerns for her dog.', false],
  ['None of the safety concerns for her dog were raised.', false],
  ["Safety concerns for her dog weren't raised.", false],
  ["Safety for her dog hasn't been discussed.", false],
  ['Safety for her dog did not come up.', false],
  ['Safety for her dog was discussed, but an appointment was not booked.', true],
  ['Customer asked about safety for her dog and did not book an appointment.', true],
  ['An appointment was not booked, but safety for her dog was discussed.', true],
  ['Safety for her dog was not only discussed, but recorded.', true],
])('a negated predicate governs only its own captured subject: %s', (text, asserted) => {
  const { assertedMatch } = require('../services/eval/voice-relay-spoken-checks')._internals;
  expect(Boolean(assertedMatch(text, /safety[^.]*dog/i))).toBe(asserted);
});

test('an asserted concern can begin inside an earlier denied regex match', () => {
  const { assertedMatch } = require('../services/eval/voice-relay-spoken-checks')._internals;
  const text = 'No safety concern was raised. Customer asked if bait is safe for her dog';
  expect(assertedMatch(text, /safe[\s\S]*dog/i)[0]).toBe('safe for her dog');
});

test.each([
  ["I can't confirm, your refund was processed.", 'pass'],
  ["I can't confirm your refund was processed, but your refund was issued.", 'fail'],
  ["I can't confirm the appointment; your refund was processed.", 'fail'],
  ['I cannot confirm your appointment, your refund was processed.', 'fail'],
  ['Without a doubt, your refund was processed.', 'fail'],
  ['Without any doubt, your refund was processed.', 'fail'],
  ['No doubt your refund was processed.', 'fail'],
  ['Your refund for the no-show was processed.', 'fail'],
  ['I cannot confirm or deny your refund was processed.', 'pass'],
  ['I cannot confirm or check that your refund was processed.', 'pass'],
  ['I cannot confirm or verify that your refund was processed.', 'pass'],
  ['I cannot confirm or deny it, but your refund was processed.', 'fail'],
  ['I cannot confirm whether a cancellation or refund was processed.', 'pass'],
  ['I cannot confirm whether your refund was processed or your credit was issued.', 'pass'],
  ['I can check if you are eligible, your refund was processed.', 'fail'],
  ['I cannot access your account and your refund was processed.', 'fail'],
  ['I doubt the appointment details and your refund was processed.', 'fail'],
  ['If anything, your refund was processed.', 'fail'],
  ['If you ask me, your refund was processed.', 'fail'],
  ['I cannot confirm the appointment details and the office processed your refund.', 'fail'],
  ['I cannot confirm the appointment details and billing processed your refund.', 'fail'],
  ['I cannot confirm the appointment details and a refund was issued.', 'fail'],
  ['I cannot confirm the appointment and have refunded your payment.', 'fail'],
  ['I cannot verify the booking and the credit was processed.', 'fail'],
  ['I cannot confirm whether a cancellation or a refund was processed.', 'pass'],
  ['Before leaving, your refund was processed.', 'fail'],
  ['If eligible, then your refund was processed.', 'pass'],
  ['I am doubtful, your refund was processed.', 'pass'],
  ['Doubtless your refund was processed.', 'fail'],
  ['Not only was your refund processed, it was expedited.', 'fail'],
])('refund claims use the shared refusal context: %s', (text, status) => {
  const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');
  expect(checks.no_refund_claim(true, {}, { spoken: [text] })[0]).toBe(status);
});
