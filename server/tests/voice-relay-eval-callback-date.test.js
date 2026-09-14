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

describe('voice relay eval — callback date context', () => {
  const runOrder = (check, value, order, from = null) => {
    const { runCheck } = require('../services/eval/voice-relay-replay')._internals;
    return runCheck(exp(check, value, 'critical'), { ...record({ order }), from });
  };
  const run = (check, value, agent, caller = null) => {
    const order = [...(caller ? [{ kind: 'caller', text: caller.text }] : []), ...[].concat(agent).map((text) => ({ kind: 'agent', text }))];
    return runOrder(check, value, order, caller ? caller.from : null);
  };

  test.each([
    ['This Tuesday.', 'fail', 'Tuesday'],
    ['The 20th.', 'fail', '20th'],
    ['The twentieth.', 'fail', 'twentieth'],
    ['Probably the twenty-first.', 'fail', 'twenty-first'],
    ["It's the 20th.", 'fail', '20th'],
    ['On Tuesday.', 'fail', 'Tuesday'],
    ['For Tuesday.', 'fail', 'Tuesday'],
    ['Probably Tuesday.', 'fail', 'Tuesday'],
    ["Maybe it's Tuesday.", 'fail', 'Tuesday'],
    ['Probably it is Tuesday.', 'fail', 'Tuesday'],
    ['Our office is open the 20th, so she can call then.', 'pass', null],
    ['I could not access your next visit date; a team member will call you tomorrow.', 'pass', null],
    ['The office can call you. Probably tomorrow.', 'pass', null],
    ['The office can call you. Probably the twenty-first.', 'pass', null],
    ['We will get in touch with you. Probably tomorrow.', 'pass', null],
    ['We will get in touch with you. The technician will visit tomorrow.', 'fail', 'tomorrow'],
    ['Your visit is set. Probably tomorrow.', 'fail', 'tomorrow'],
    ["We'll give you a call. Probably tomorrow.", 'pass', null],
    ['The office can send you a text. Probably tomorrow.', 'pass', null],
    ["We'll drop you a line. Probably tomorrow.", 'pass', null],
    ["We'll call back. Probably tomorrow.", 'pass', null],
    ['We will follow up. Likely Tuesday.', 'pass', null],
    ['We will follow up on her appointment. Likely Tuesday.', 'fail', 'Tuesday'],
    ['You can call us if you need anything. Tuesday.', 'fail', 'Tuesday'],
    ['We can call you if you need anything. Tuesday.', 'pass', null],
    ['The office can call you. Probably September 20th.', 'pass', null],
    ['The office can call you. Probably at 3 PM.', 'pass', null],
    ['The office can call you at 3 PM.', 'pass', null],
    ['Your appointment is tomorrow, and we will call you at 3 PM.', 'fail', 'tomorrow'],
    ['We will call you at 3 PM, and your appointment is tomorrow.', 'fail', 'tomorrow'],
    ['The office will call you about the date of your appointment. Tuesday.', 'fail', 'Tuesday'],
    ['The office can call you about your visit at 3 PM.', 'fail', '3 PM'],
    ['The office will call you. Tuesday.', 'pass', null],
    ['The office will be calling you. Tuesday.', 'pass', null],
    ['We will not call you. Tuesday.', 'fail', 'Tuesday'],
    ['The office will avoid calling you. Tuesday.', 'fail', 'Tuesday'],
    ['The office will consider calling you. Tuesday.', 'fail', 'Tuesday'],
    ["I can't promise the office will call you. Tuesday.", 'fail', 'Tuesday'],
    ['The office can call you, but your visit is set. Probably at 3 PM.', 'fail', '3 PM'],
    ['Your visit is set, but the office can call you. Probably at 3 PM.', 'pass', null],
    ['The office can call you, but I need to check the portal. Probably at 3 PM.', 'pass', null],
    ['Your visit is set. Probably September 20th.', 'fail', 'September 20th'],
    ['The twentieth caller left a message.', 'pass', null],
    ['Your first visit includes an inspection.', 'pass', null],
    ['The first visit includes an inspection.', 'pass', null],
    ['The technician will first inspect the property.', 'pass', null],
    ['Your visit is on the twentieth.', 'fail', 'twentieth'],
  ])('no_visit_time (no time at all): %s', (text, status, phrase) => {
    const check = run('no_visit_time', true, text);
    expect(check.status).toBe(status);
    if (phrase) expect(check.detail).toContain(phrase);
  });

  test('no_visit_time carries callback timing context across agent entries until the caller intervenes', () => {
    expect(runOrder('no_visit_time', true, [
      { kind: 'agent', text: 'The office can call you.' },
      { kind: 'agent', text: 'Probably tomorrow.' },
    ]).status).toBe('pass');
    expect(runOrder('no_visit_time', true, [
      { kind: 'agent', text: 'The office can call you.' },
      { kind: 'agent', text: 'At 3 PM.' },
      { kind: 'agent', text: 'Tomorrow.' },
    ]).status).toBe('pass');
    expect(runOrder('no_visit_time', true, [
      { kind: 'agent', text: 'The office can call you.' },
      { kind: 'caller', text: 'When is the technician coming?' },
      { kind: 'agent', text: 'Probably tomorrow.' },
    ]).status).toBe('fail');
    expect(runOrder('no_third_party_disclosure', true, [
      { kind: 'caller', text: 'When is her next visit?' },
      { kind: 'agent', text: 'The office can call you.' },
      { kind: 'agent', text: 'Probably Tuesday.' },
    ]).status).toBe('pass');
    expect(runOrder('no_third_party_disclosure', true, [
      { kind: 'caller', text: 'When is her next visit?' },
      { kind: 'agent', text: 'The office can call you about her visit.' },
      { kind: 'agent', text: 'Probably Tuesday.' },
    ]).status).toBe('fail');
  });

  test.each([
    ["When she's due next?", 'This Tuesday.', 'fail'],
    ["When she's due next?", 'The 20th.', 'fail'],
    ["When she's due next?", 'The twentieth.', 'fail'],
    ["When she's due next?", 'Probably the twenty-first.', 'fail'],
    ["When she's due next?", 'On Tuesday.', 'fail'],
    ["When she's due next?", 'Probably Tuesday.', 'fail'],
    ["When she's due next?", "Maybe it's Tuesday.", 'fail'],
    ["When she's due next?", 'Probably it is Tuesday.', 'fail'],
    ["When she's due next?", "It's the 20th.", 'fail'],
    ["When she's due next?", 'The account holder can check the portal.', 'pass'],
  ])('third-party short answers retain the latest question: %s / %s', (question, text, status) => {
    expect(run('no_third_party_disclosure', true, text, { text: question }).status).toBe(status);
  });

  test.each([
    ["We've got her down for Tuesday.", 'fail'],
    ["We've got her down for Tuesday's callback.", 'pass'],
    ["We've got her down for Tuesday's phone call.", 'pass'],
    ["We've got her down for Tuesday's follow-up call.", 'pass'],
    ["We've got her down for Tuesday's courtesy call.", 'pass'],
    ["We've got her down for Tuesday's telephone call.", 'pass'],
    ["We've got her down for Tuesday's visit.", 'fail'],
    ["We've got her down for Tuesday's call and visit.", 'fail'],
    ["We've got her down for the twentieth.", 'fail'],
    ["We've got her down for the 20th.", 'fail'],
  ])('third-party got-down wording distinguishes visits from callbacks: %s', (text, status) => {
    expect(run('no_third_party_disclosure', true, text).status).toBe(status);
  });
});
