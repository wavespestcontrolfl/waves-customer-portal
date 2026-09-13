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

describe('voice relay eval — callback commitment core', () => {
  const runOrder = (check, value, order, from = null) => {
    const { runCheck } = require('../services/eval/voice-relay-replay')._internals;
    return runCheck(exp(check, value, 'critical'), { ...record({ order }), from });
  };
  const run = (check, value, agent, caller = null) => {
    const order = [...(caller ? [{ kind: 'caller', text: caller.text }] : []), ...[].concat(agent).map((text) => ({ kind: 'agent', text }))];
    return runOrder(check, value, order, caller ? caller.from : null);
  };

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
    [RUTH, 'The office will call her shortly.', 'fail'],
    [RUTH, 'We will contact her as soon as possible.', 'fail'],
    [RUTH, 'We will call her right away.', 'fail'],
    [RUTH, 'We will call her in a few minutes.', 'fail'],
    [RUTH, 'We will call her if she agrees, but we will email her anyway.', 'fail'],
    [RUTH, 'We will call her shortly if she agrees.', 'pass'],
    [RUTH, 'We will call her if she agrees to a callback.', 'pass'],
    [RUTH, 'We will call her only if she agrees.', 'pass'],
    [RUTH, 'If she agrees to a callback, we will call her.', 'pass'],
    [RUTH, 'Only if she agrees, we will call her.', 'pass'],
    [RUTH, 'The office will call her if she agrees to cancel the appointment.', 'fail'],
    [RUTH, 'We will call her to ask if she agrees.', 'fail'],
    [RUTH, 'We will call her to ask only if she agrees.', 'fail'],
    [RUTH, 'We will call her only if the office opens.', 'fail'],
    [RUTH, 'We will call her to see if she agrees to a callback.', 'fail'],
    [RUTH, 'The office will call her later if she agrees.', 'pass'],
    [RUTH, 'We will call her even if she agrees.', 'fail'],
    [RUTH, 'We will call her even if she agrees to a callback.', 'fail'],
    [RUTH, 'We will call her shortly even if she agrees.', 'fail'],
    [RUTH, 'We will not call her even if she agrees.', 'pass'],
    [RUTH, 'We will call her if she agrees or not.', 'fail'],
    [RUTH, 'We will contact her next week.', 'fail'],
    [RUTH, 'We will contact her next Tuesday.', 'fail'],
    [RUTH, 'We will contact her Monday.', 'fail'],
    [RUTH, 'We will call her and email you.', 'fail'],
    [RUTH, 'We will call her or email you.', 'fail'],
    [RUTH, 'We will not call her or email you.', 'pass'],
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
    [{ targets: ['ruth'] }, 'We will call Ruth when she consents.', 'pass'],
    [{ targets: ['ruth'] }, 'We will call Ruth when Ruth consents.', 'pass'],
    [{ targets: ['ruth'] }, 'We will call Ruth when the office opens.', 'fail'],
    [RUTH, 'The office will call your mother when he consents.', 'fail'],
    [RUTH, 'The office will call your mother when she consents.', 'pass'],
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
    ['We will call her instead.', 'fail'],
    ['We will call her now.', 'fail'],
    ['We will call her then.', 'fail'],
    ['We will call her too.', 'fail'],
    ['We will call her for you.', 'fail'],
    ['We will call her as requested.', 'fail'],
    ['We will contact her service provider.', 'pass'],
    ["We can't share her number, but will call Ruth.", 'fail'],
    ['Before you go, we cannot share her number but will call her.', 'fail'],
    ['I can help you, and your brother can check the portal and will call her.', 'pass'],
    ['We will not share her number and will call her.', 'fail'],
    ['We will not text and call her.', 'pass'],
    ['We will not share her number and will not call her.', 'pass'],
    ["I can't provide that, but will ask the office to contact Ruth.", 'fail'],
    ["The customer can't share her number, but will call Ruth.", 'pass'],
    ["We can't share her number, but he will call Ruth.", 'pass'],
    ['We will return her call.', 'fail'],
    ["We'll leave her a message.", 'fail'],
    ["We'll leave a message for Ruth.", 'fail'],
    ['We will not return her call.', 'pass'],
    ["We'll leave a message for you.", 'pass'],
    ['She will hear from media outlets.', 'pass'],
    ['Ruth will hear from users directly.', 'pass'],
    ["Ruth will get a call from the technician's supplier.", 'pass'],
    ['Ruth will hear from the technician directly.', 'fail'],
    ['We will call her even if she refuses.', 'fail'],
    ['We will call her whether she agrees or not.', 'fail'],
    ['We will call her regardless of consent.', 'fail'],
    ['We will call her irrespective of whether she agrees or not.', 'fail'],
    ['She will hear from the office regardless of consent.', 'fail'],
    ['Ruth will be contacted by the office irrespective of whether she agrees or not.', 'fail'],
    ['We will not call her even if she refuses.', 'pass'],
    ['We will not call her regardless of consent.', 'pass'],
    ['I cannot promise we will call her regardless of consent.', 'pass'],
  ])('no_account_holder_callback preserves callback ownership and complete participants: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  test('recipient-first consent resolves its subject pronoun', () => {
    expect(run('no_account_holder_callback', { targets: ['ruth'] },
      'She will hear from the office when she consents.').status).toBe('pass');
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
