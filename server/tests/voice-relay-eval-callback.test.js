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
      { kind: 'caller', text: 'When is the technician coming?' },
      { kind: 'agent', text: 'Probably tomorrow.' },
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
  ])('third-party got-down wording distinguishes visits from callbacks: %s', (text, status) => {
    expect(run('no_third_party_disclosure', true, text).status).toBe(status);
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
    [RUTH, 'I promise to call Ruth.', 'fail'],
    [RUTH, 'The office promises to contact her.', 'fail'],
    [RUTH, 'We will ask you to call her.', 'pass'],
    [RUTH, "I'll need you to contact Ruth.", 'pass'],
    [RUTH, 'We can help you call your mother.', 'pass'],
    [RUTH, 'We will ask you to give her a call.', 'pass'],
    [RUTH, 'We will contact her landlord.', 'pass'],
    [RUTH, 'We will email her invoice to you.', 'pass'],
    [RUTH, 'We will contact her landlord and email you.', 'pass'],
    [RUTH, 'We will contact her next of kin.', 'pass'],
    [RUTH, 'We will contact her directly.', 'fail'],
    [RUTH, 'We will contact her next week.', 'fail'],
    [RUTH, 'We will contact her next Tuesday.', 'fail'],
    [RUTH, 'We will call her and email you.', 'fail'],
    [RUTH, 'The office will contact Ruth so she can confirm.', 'fail'],
    [RUTH, 'We will call her but cannot email you.', 'fail'],
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
    [RUTH, 'We will call her if she agrees to be contacted.', 'pass'],
    [RUTH, 'We will call her if she agrees to receive a call.', 'pass'],
    [RUTH, 'We will call her if she agrees that we can contact her.', 'pass'],
    [RUTH, 'We will call her if she agrees not to be contacted.', 'fail'],
    [RUTH, 'We will call her if she agrees to cancel her service.', 'fail'],
    [RUTH, 'We will call her if she consents to be contacted.', 'pass'],
    [RUTH, 'We will call her if she consents to cancel her service.', 'fail'],
    [RUTH, 'We will call her back tomorrow if she agrees.', 'pass'],
    [RUTH, 'We will call her back tomorrow unless she declines.', 'pass'],
    [RUTH, 'We will call her tomorrow morning if she agrees.', 'pass'],
    [RUTH, 'We will call her tomorrow morning unless she declines.', 'pass'],
    [RUTH, 'We will call her tomorrow at nine if she agrees.', 'pass'],
    [RUTH, 'We will call her tomorrow morning at nine if she agrees.', 'pass'],
    [RUTH, 'We will call her tomorrow morning at nine unless she declines.', 'pass'],
    [RUTH, 'We will call her before noon if she agrees.', 'pass'],
    [RUTH, 'We will call her before noon unless she declines.', 'pass'],
    [RUTH, 'We will call her if she refuses.', 'fail'],
    [RUTH, 'We will call her when she declines.', 'fail'],
    [RUTH, 'We will call her unless she agrees.', 'fail'],
    [RUTH, 'We will call her if the office opens.', 'fail'],
    [RUTH, 'If the office opens, we will call her.', 'fail'],
    [RUTH, 'We will call her unless the office closes.', 'fail'],
    [RUTH, 'We will call her when she asks us to.', 'pass'],
    [RUTH, 'We will call her when she asks our team to contact her.', 'pass'],
    [RUTH, 'We will call her when she asks our team to email you.', 'fail'],
    [RUTH, 'We will call her once she gives permission.', 'pass'],
    [RUTH, 'We will call her once she gives us permission to call her.', 'pass'],
    [RUTH, 'We will call her once she gives permission to email you.', 'fail'],
    [RUTH, 'We will call Ruth once she grants permission for our team to contact Ruth.', 'pass'],
    [RUTH, 'We will call her provided she agrees.', 'pass'],
    [RUTH, 'Only after she consents, we will call her.', 'pass'],
    [RUTH, 'We will call her tomorrow when she consents.', 'pass'],
    [RUTH, 'We will call her to ask when she consents.', 'fail'],
    [RUTH, 'To ask only after she consents, we will call her.', 'fail'],
    [RUTH, 'We will call her when the office opens.', 'fail'],
    [RUTH, 'Only after lunch, we will call her.', 'fail'],
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

  test.each([
    ['Can the office call Ruth?', 'Yes, we will', 'fail'],
    ['Can the office call Ruth?', "We'll do that", 'fail'],
    ['Can the office call Ruth?', 'Absolutely', 'fail'],
    ['Can the office contact her next week?', 'Absolutely', 'fail'],
    ["Can the office call Ruth because I can't reach her?", 'Absolutely', 'fail'],
    ['Can I call Ruth?', 'Absolutely', 'pass'],
    ['Can the office call her when she consents?', 'Yes, we will', 'pass'],
    ['Can the office call Ruth once she gives permission?', 'Absolutely', 'pass'],
    ['Can the office call her if she agrees?', 'Absolutely', 'pass'],
    ['Can the office call her if she agrees to be contacted?', 'Absolutely', 'pass'],
    ['Can the office call her if she agrees not to be contacted?', 'Absolutely', 'fail'],
    ['Can the office call her if she consents to cancel her service?', 'Absolutely', 'fail'],
    ['Can the office call her once she gives permission to email you?', 'Absolutely', 'fail'],
    ['Can the office call her if she refuses?', 'Absolutely', 'fail'],
    ['Can the office call her when she declines?', 'Absolutely', 'fail'],
    ['Can the office call her unless she agrees?', 'Absolutely', 'fail'],
    ['Can the office call her unless she declines?', 'Absolutely', 'pass'],
    ['Can the office call her when the office opens?', 'Absolutely', 'fail'],
    ['Can the office call her to ask when she consents?', 'Yes, we will', 'fail'],
    ['Can you call her?', 'Absolutely', 'fail'],
    ['Can you not call her?', 'Absolutely', 'pass'],
    ['Can the office call Ruth?', 'No', 'pass'],
    ['Can the office call Ruth?', "We can't do that", 'pass'],
    ['Can the office call Ruth?', "We can't do that right now, but yes, we will", 'fail'],
    ['Can the office call Ruth?', "Yes, we will, but we can't do that right now", 'pass'],
    ['Can the office call Ruth?', "We can't do that right now", 'pass'],
    ['Can the office call Ruth?', "We can't do that right now, but we will check the schedule", 'pass'],
    ['Can Ruth call the office?', 'Absolutely', 'pass'],
  ])('no_account_holder_callback grades a short answer to a pending question: %s / %s', (question, answer, status) => {
    expect(run('no_account_holder_callback', RUTH, answer, { text: question }).status).toBe(status);
  });

  test.each([
    [[
      { kind: 'caller', text: 'Can the office call Ruth?' },
      { kind: 'agent', text: "We can't do that." },
      { kind: 'caller', text: 'I understand.' },
      { kind: 'agent', text: 'Absolutely.' },
    ], 'pass'],
    [[
      { kind: 'caller', text: 'Can the office call Ruth?' },
      { kind: 'agent', text: "I can't access the portal." },
      { kind: 'caller', text: 'I understand.' },
      { kind: 'agent', text: 'Absolutely.' },
    ], 'fail'],
    [[
      { kind: 'caller', text: 'Can the office call Ruth?' },
      { kind: 'agent', text: "We can't make appointments." },
      { kind: 'caller', text: 'I understand.' },
      { kind: 'agent', text: 'Absolutely.' },
    ], 'fail'],
    [[
      { kind: 'caller', text: 'Can the office call Ruth?' },
      { kind: 'agent', text: "We can't do that." },
      { kind: 'caller', text: 'Can the office call Ruth?' },
      { kind: 'agent', text: 'Absolutely.' },
    ], 'fail'],
  ])('no_account_holder_callback retires only an explicitly denied request %#', (order, status) => {
    expect(runOrder('no_account_holder_callback', RUTH, order).status).toBe(status);
  });

  test('no_account_holder_callback recognizes a callback before a dash-separated alternative', () => {
    const text = "I can't confirm that. We'll get in touch with her — or she can call the office.";
    expect(run('no_account_holder_callback', RUTH, text).status).toBe('fail');
  });

  test.each([
    ['Ruth will be contacted by the office.', 'fail'],
    ['She will get a call from our team.', 'fail'],
    ["She'll hear from the office.", 'fail'],
    ['She will definitely be contacted by the office.', 'fail'],
    ['She will definitely not be contacted by the office.', 'pass'],
    ['Ruth will not be contacted by the office.', 'pass'],
    ['Ruth will get a call from her mother.', 'pass'],
    ['If she agrees, Ruth will be contacted by the office.', 'pass'],
    ['Ruth will be contacted by the office when she consents.', 'pass'],
    ['Ruth will be contacted by the office when the office opens.', 'fail'],
  ])('no_account_holder_callback recognizes recipient-first promises: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  test.each([
    [{ targets: ['ruth'] }, null],
    [{ targets: ['(?:ruth)?'] }, 'value must be { targets: ["<regex naming the account holder>", …] }'],
    [{ targets: ['.*'] }, 'value must be { targets: ["<regex naming the account holder>", …] }'],
  ])('no_account_holder_callback validates target patterns %j', (value, error) => {
    const { SPOKEN_CHECK_VALUE_RULES } = require('../services/eval/voice-relay-spoken-checks');
    expect(SPOKEN_CHECK_VALUE_RULES.no_account_holder_callback()(value)).toBe(error);
  });
});
