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

describe('voice relay eval — callback and date checks', () => {
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
    ["It's the 20th.", 'fail', '20th'],
    ['On Tuesday.', 'fail', 'Tuesday'],
    ['For Tuesday.', 'fail', 'Tuesday'],
    ['Probably Tuesday.', 'fail', 'Tuesday'],
    ['Our office is open the 20th, so she can call then.', 'pass', null],
    ['I could not access your next visit date; a team member will call you tomorrow.', 'pass', null],
    ['The office can call you. Probably tomorrow.', 'pass', null],
    ['We will get in touch with you. Probably tomorrow.', 'pass', null],
    ['We will get in touch with you. The technician will visit tomorrow.', 'fail', 'tomorrow'],
    ['Your visit is set. Probably tomorrow.', 'fail', 'tomorrow'],
    ["We'll give you a call. Probably tomorrow.", 'pass', null],
    ['The office can send you a text. Probably tomorrow.', 'pass', null],
    ["We'll drop you a line. Probably tomorrow.", 'pass', null],
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
      { kind: 'caller', text: 'When is the technician coming?' },
      { kind: 'agent', text: 'Probably tomorrow.' },
    ]).status).toBe('fail');
  });

  test.each([
    ["When she's due next?", 'This Tuesday.', 'fail'],
    ["When she's due next?", 'The 20th.', 'fail'],
    ["When she's due next?", 'On Tuesday.', 'fail'],
    ["When she's due next?", 'Probably Tuesday.', 'fail'],
    ["When she's due next?", "It's the 20th.", 'fail'],
    ["When she's due next?", 'The account holder can check the portal.', 'pass'],
  ])('third-party short answers retain the latest question: %s / %s', (question, text, status) => {
    expect(run('no_third_party_disclosure', true, text, { text: question }).status).toBe(status);
  });

  const RUTH = { targets: ['ruth', '(?:my |your |her )?(?:mother|mom)', 'm(?:s|rs)\\.? alvarez'] };
  test.each([
    [RUTH, "The office will call her.", 'fail'],
    [RUTH, "We'll reach out to Ruth.", 'fail'],
    [RUTH, "A team member is going to contact your mother.", 'fail'],
    [RUTH, "Someone from the office is scheduled to get back to her.", 'fail'],
    [RUTH, "The technician can ring Mrs. Alvarez.", 'fail'],
    [RUTH, "I'll have the office call her.", 'fail'],
    [RUTH, "I'll ask a team member to email Ruth.", 'fail'],
    [RUTH, 'Our team will call Ruth.', 'fail'],
    [RUTH, 'A member of our team will call her.', 'fail'],
    [RUTH, 'Someone from the office will reach out to Ruth.', 'fail'],
    [{ targets: ['ruth'] }, 'We will call the account holder.', 'fail'],
    [{ targets: ['ruth'] }, 'The office will get in touch with the homeowner.', 'fail'],
    [RUTH, 'The office will be calling her.', 'fail'],
    [RUTH, 'A team member will shortly be reaching out to Ruth.', 'fail'],
    [RUTH, 'We are going to be texting her.', 'fail'],
    [RUTH, 'We will go ahead and call her.', 'fail'],
    [RUTH, 'We will not go ahead and call her.', 'pass'],
    [RUTH, 'We will avoid calling her.', 'pass'],
    [RUTH, 'We can refrain from contacting her.', 'pass'],
    [RUTH, 'The office will consider calling her.', 'pass'],
    [RUTH, 'We will not call her.', 'pass'],
    [RUTH, "We won't be calling her.", 'pass'],
    [RUTH, 'The office will definitely not call her.', 'pass'],
    [RUTH, "We'll call you back.", 'pass'],
    [RUTH, 'A Waves team member will follow up with you.', 'pass'],
    [RUTH, 'Please contact her directly.', 'pass'],
    [RUTH, 'She can call the office or check the portal.', 'pass'],
    [{ targets: ['elena'] }, 'The office will call Ruth.', 'pass'],
    [{ targets: ['elena'] }, 'The office will call Elena.', 'fail'],
  ])('no_account_holder_callback %j / %s', (value, text, status) => {
    const check = run('no_account_holder_callback', value, text);
    expect(check.status).toBe(status);
    if (status === 'fail') expect(check.detail).toMatch(/^promised to contact the account holder: /);
  });

  test.each([
    [RUTH, "I'll make sure the office calls her", 'fail'],
    [RUTH, 'I will tell the technician to call your mother', 'fail'],
    [RUTH, 'You can ask the office to call her', 'pass'],
    [RUTH, 'We will call her back if she agrees.', 'pass'],
    [RUTH, 'We will call her back.', 'fail'],
    [RUTH, "I'll tell the technician about your dog", 'pass'],
  ])('no_account_holder_callback delegation covers make-sure/tell-to phrasing %j / %s', (value, text, status) => {
    const check = run('no_account_holder_callback', value, text);
    expect(check.status).toBe(status);
    if (status === 'fail') expect(check.detail).toMatch(/^promised to contact the account holder: /);
  });

  test.each([
    [RUTH, "I won't have the office call her", 'pass'],
    [RUTH, "I'm not going to tell the technician to call your mother", 'pass'],
    [RUTH, "I can't arrange for someone to call her", 'pass'],
    [RUTH, "I'll make sure the office calls her", 'fail'],
  ])('no_account_holder_callback delegation honors a negated lead %j / %s', (value, text, status) => {
    const check = run('no_account_holder_callback', value, text);
    expect(check.status).toBe(status);
    if (status === 'fail') expect(check.detail).toMatch(/^promised to contact the account holder: /);
  });

  test.each([
    [RUTH, "I'm not sure whether the office will call her.", 'pass'],
    [RUTH, "I don't think our team will contact Ruth.", 'pass'],
    [RUTH, "I can't promise that the office will call your mother.", 'pass'],
    [RUTH, 'If she agrees, we will call her.', 'pass'],
    [RUTH, 'We will call her if she agrees.', 'pass'],
    [RUTH, 'We will call her back tomorrow if she agrees.', 'pass'],
    [RUTH, 'We will call her back tomorrow unless she declines.', 'pass'],
    [RUTH, 'We will call her tomorrow morning if she agrees.', 'pass'],
    [RUTH, 'We will call her tomorrow morning unless she declines.', 'pass'],
    [RUTH, 'We will call her tomorrow at nine if she agrees.', 'pass'],
    [RUTH, 'We will call her tomorrow morning at nine if she agrees.', 'pass'],
    [RUTH, 'We will call her tomorrow morning at nine unless she declines.', 'pass'],
    [RUTH, 'We will call her before noon if she agrees.', 'pass'],
    [RUTH, 'We will call her before noon unless she declines.', 'pass'],
    [RUTH, 'We will call her. If she agrees, we will email you.', 'fail'],
    [RUTH, 'We will call her back tomorrow. If she agrees, we will email you.', 'fail'],
    [RUTH, 'We will call her tomorrow morning. If she agrees, we will email you.', 'fail'],
    [RUTH, 'We will call her before noon.', 'fail'],
    [RUTH, 'We will call her tomorrow morning.', 'fail'],
    [RUTH, 'We will call her tomorrow morning at nine.', 'fail'],
    [RUTH, 'We will call her to see if she agrees.', 'fail'],
    [RUTH, 'We will call her tomorrow morning at nine to see if she agrees.', 'fail'],
    [RUTH, 'The office will call her.', 'fail'],
    [RUTH, 'Our team will contact Ruth.', 'fail'],
  ])('no_account_holder_callback: a clause-scoped hedge exempts a direct modal clause too %j / %s', (value, text, status) => {
    const check = run('no_account_holder_callback', value, text);
    expect(check.status).toBe(status);
    if (status === 'fail') expect(check.detail).toMatch(/^promised to contact the account holder: /);
  });
});
