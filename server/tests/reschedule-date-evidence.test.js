const { verifyRescheduleDateClaims: verify, verifiedAppointmentIdentityClaims } = require('../services/reschedule-date-evidence');
const reference = new Date('2026-09-14T02:00:00Z'); // September 13 in Eastern.
const claim = (quote, parts, binding = 'appointment') => ({ quote, binding, ...parts });
const current = 'Caller: My September 20 appointment.';
const september20 = claim('September 20', { month: 9, day: 20 });

test('calendar evidence proves components and coverage independently of the model', () => {
  expect(verify([september20], current, reference)).toBe(true);
  expect(verify([], current, reference)).toBe(false);
  expect(verify([{ ...september20, day: 21 }], current, reference)).toBe(false);
  expect(verify([{ ...september20, month: 10 }], current, reference)).toBe(false);
  expect(verify([{ ...september20, year: 2026 }], current, reference)).toBe(false);
  expect(verify([claim('September 20', { month: 9 })], current, reference)).toBe(false);
  expect(verify([september20], `${current}\nCaller: My October 1 appointment.`, reference)).toBe(false);
  expect(verify([], 'Agent: I will text you a reschedule link for that appointment.', reference)).toBe(true);
});

test.each([
  ['Sep. 20th', { month: 9, day: 20 }],
  ['September 20, 2026', { year: 2026, month: 9, day: 20 }],
  ['9/20/2026', { year: 2026, month: 9, day: 20 }],
  ['2026-09-20', { year: 2026, month: 9, day: 20 }],
  ['Sunday, September 20', { weekday: 0, month: 9, day: 20 }],
  ['Wed the 20th', { weekday: 3, day: 20 }],
  ['the 20th', { day: 20 }],
  ['tomorrow', { year: 2026, month: 9, day: 14 }],
])('proves supported partial/calendar wording %s', (text, parts) => {
  expect(verify([claim(text, parts)], `Caller: My appointment is ${text}.`, reference)).toBe(true);
});

test.each(['February 30', 'next Friday', 'September twenty first', 'a week from now', 'Christmas', 'the following day', '20', '9-20'])('unproven wording %s cannot pass as an empty list', text => {
  expect(verify([], `Caller: My appointment is ${text}.`, reference)).toBe(false);
});

test('date roles come from complete clauses, including current versus requested', () => {
  const transcript = 'Caller: Please move my current Tuesday appointment to Friday.\nAgent: I will text the reschedule link tomorrow morning.';
  const claims = [claim('Tuesday', { weekday: 2 }), claim('Friday', { weekday: 5 }, 'requested'),
    claim('tomorrow', { year: 2026, month: 9, day: 14 }, 'delivery')];
  const timing = { due_at: '2026-09-14T09:00:00-04:00', due_type: 'floor' };
  expect(verify(claims, transcript, reference, timing)).toBe(true);
  for (let i = 0; i < claims.length; i++) {
    const swapped = claims.map((c, j) => i === j ? { ...c, binding: c.binding === 'appointment' ? 'delivery' : 'appointment' } : c);
    expect(verify(swapped, transcript, reference, timing)).toBe(false);
    expect(verify(claims.filter((_, j) => i !== j), transcript, reference, timing)).toBe(false);
  }
});

test.each([
  'My appointment is not September 20.',
  'Can my appointment be September 20?',
  'My appointment was September 20.',
  'My appointment is September 20?',
  'I want September 20 for my appointment.',
  'My September 20 appointment needs to move, perhaps Friday.',
  'Before I call on September 20, send the link.',
])('unsupported or ambiguous role parks: %s', text => {
  expect(verify([september20], `Caller: ${text}`, reference)).toBe(false);
});

test('relative dates need the call reference and use Eastern calendar rollover', () => {
  const transcript = 'Caller: My appointment is tomorrow.';
  const nextDay = claim('tomorrow', { year: 2026, month: 9, day: 14 });
  expect(verify([nextDay], transcript, reference)).toBe(true);
  expect(verify([nextDay], transcript, null)).toBe(false);
  expect(verify([{ ...nextDay, day: 15 }], transcript, reference)).toBe(false);
});

test.each([
  "I'll text the reschedule link after the office confirms the appointment.",
  'I will text the reschedule link when the technician confirms the visit.',
])('unresolved prerequisites cannot become permission to send: %s', promise => {
  expect(verify([], `Agent: ${promise}\nCaller: Thank you.`, reference)).toBe(false);
});

test.each([
  { due_at: '2026-09-14T09:00:00-04:00', due_type: 'deadline' },
  { due_at: '2026-09-13T09:00:00-04:00', due_type: 'floor' },
  { due_at: null, due_type: null },
  { due_at: '2026-09-14T15:00:00-04:00', due_type: 'floor' },
])('delivery components cannot conceal contradictory timing: %j', timing => {
  const transcript = 'Agent: I will text the reschedule link tomorrow morning.';
  expect(verify([claim('tomorrow', { year: 2026, month: 9, day: 14 }, 'delivery')], transcript, reference, timing)).toBe(false);
});

test.each(['9am', 'nine am'])('explicit clock %s and deadline wording must agree with the proposed timestamp', (clock) => {
  const claims = [claim('tomorrow', { year: 2026, month: 9, day: 14 }, 'delivery')];
  const due_at = '2026-09-14T09:00:00-04:00';
  expect(verify(claims, `Agent: I will text the reschedule link tomorrow at ${clock}.`, reference, { due_at, due_type: 'floor' })).toBe(true);
  expect(verify(claims, 'Agent: I will text the reschedule link tomorrow at 10am.', reference, { due_at, due_type: 'floor' })).toBe(false);
  expect(verify(claims, `Agent: I will text the reschedule link by tomorrow at ${clock}.`, reference, { due_at, due_type: 'deadline' })).toBe(true);
  const friday = [claim('Friday', { weekday: 5 }, 'delivery')];
  expect(verify(friday, 'Agent: I will text the reschedule link by Friday.', reference,
    { due_at: '2026-09-11T09:00:00-04:00', due_type: 'deadline' })).toBe(false);
});

test.each([
  ['Sunday September 20', { weekday: 0, month: 9, day: 20 }, true],
  ['Sept 20', { month: 9, day: 20 }, true],
  ['Monday September 20', { weekday: 1, month: 9, day: 20 }, false],
])('normalizes only validated delivery date grammar for the deadline parser: %s', (text, parts, expected) => {
  const claims = [claim(text, parts, 'delivery')];
  const transcript = `Agent: I will text the reschedule link ${text} at 9am.`;
  expect(verify(claims, transcript, reference,
    { due_at: '2026-09-20T09:00:00-04:00', due_type: 'floor' })).toBe(expected);
});

test.each([
  ['Tue', 2, '2026-09-15T09:00:00-04:00'], ['Tues', 2, '2026-09-15T09:00:00-04:00'],
  ['Thur', 4, '2026-09-17T09:00:00-04:00'], ['Thurs', 4, '2026-09-17T09:00:00-04:00'],
])('normalizes bare abbreviated delivery weekday %s', (text, weekday, due_at) => {
  const claims = [claim(text, { weekday }, 'delivery')];
  expect(verify(claims, `Agent: I will text the reschedule link ${text} at 9am.`, reference,
    { due_at, due_type: 'floor' })).toBe(true);
});

test.each(['floor', 'deadline'])('a day-only %s promise cannot prove a model-selected clock', (due_type) => {
  const prefix = due_type === 'deadline' ? 'by ' : '';
  const claims = [claim('tomorrow', { year: 2026, month: 9, day: 14 }, 'delivery')];
  const transcript = `Agent: I will text the reschedule link ${prefix}tomorrow.`;
  expect(verify(claims, transcript, reference, { due_at: '2026-09-14T23:59:00-04:00', due_type })).toBe(false);
});

test.each(['by', 'before', 'no later than'])('%s requires a deadline; untyped historical rows retain their floor', (prefix) => {
  const transcript = `Agent: I will text the reschedule link ${prefix} tomorrow at eight pm.`;
  const claims = [claim('tomorrow', { year: 2026, month: 9, day: 14 }, 'delivery')];
  const due_at = '2026-09-14T20:00:00-04:00';
  expect(verify(claims, transcript, reference, { due_at, due_type: 'floor' })).toBe(false);
  expect(verify(claims, transcript, reference, { due_at, due_type: 'deadline' })).toBe(true);
  expect(verify(claims, transcript, reference, { due_at, due_type: null })).toBe(true);
});

test('only an agent turn establishes delivery timing, including later sentences in the turn', () => {
  const claims = [claim('tomorrow', { year: 2026, month: 9, day: 14 }, 'delivery')];
  const timing = { due_at: '2026-09-14T09:00:00-04:00', due_type: 'floor' };
  const words = 'I will text the reschedule link tomorrow at 9am.';
  const agentPromise = 'Agent: I will text the reschedule link.';
  expect(verify(claims, `Caller: ${words}\n${agentPromise}`, reference, timing)).toBe(false);
  expect(verify(claims, `Customer: ${words}\n${agentPromise}`, reference, timing)).toBe(false);
  expect(verify(claims, `${words}\n${agentPromise}`, reference, timing)).toBe(false);
  expect(verify(claims, `Agent: Hello. ${words}`, reference, timing)).toBe(true);
});

test('separate proved identities survive incomplete coverage without authorizing sending', () => {
  const transcript = 'Caller: My Tuesday appointment. My Wednesday appointment.\nAgent: I will text the reschedule link.';
  const tuesday = claim('Tuesday', { weekday: 2 });
  const wednesday = claim('Wednesday', { weekday: 3 });
  for (const identity of [tuesday, wednesday]) {
    expect(verify([identity], transcript, reference)).toBe(false);
    expect(verifiedAppointmentIdentityClaims([identity], `${transcript}\nCaller: Unrecognized wording.`, reference)).toEqual([identity]);
  }
  expect(verifiedAppointmentIdentityClaims([{ ...tuesday, weekday: 3 }], transcript, reference)).toEqual([]);
  expect(verifiedAppointmentIdentityClaims([{ ...tuesday, quote: ['Tuesday'] }], transcript, reference)).toEqual([]);
});
