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

describe('voice relay eval — callback consent and pending answers', () => {
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
    [RUTH, "I'm not sure whether the office will call her.", 'pass'],
    [RUTH, "I don't think our team will contact Ruth.", 'pass'],
    [RUTH, "I can't promise that the office will call your mother.", 'pass'],
    [RUTH, 'If she agrees, we will call her.', 'pass'],
    [RUTH, 'If she agrees, then we will call her.', 'pass'],
    [RUTH, 'If she agrees, we will call her, or even if she refuses.', 'fail'],
    [RUTH, 'We will call her if she agrees.', 'pass'],
    [RUTH, 'We will call Ruth if she agrees, or even if she refuses.', 'fail'],
    [RUTH, 'We will call Ruth if she agrees, or if she consents.', 'pass'],
    [RUTH, 'We will call her if she agrees that we will not contact her.', 'fail'],
    [RUTH, 'We will call her if she agrees, or if she consents, or even if she refuses.', 'fail'],
    [RUTH, 'We will call her if she agrees, but also if she refuses.', 'fail'],
    [RUTH, 'We will call her if she agrees, and even if she refuses.', 'fail'],
    [RUTH, 'We will call her if she agrees, and we will email you.', 'pass'],
    [RUTH, 'We will call her if she agrees, and email her anyway.', 'fail'],
    [RUTH, 'We will call her if she agrees, and email you anyway.', 'pass'],
    [RUTH, 'We will call her if she agrees, but only during office hours.', 'pass'],
    [RUTH, 'We will call her if she agrees, or regardless of consent.', 'fail'],
    [RUTH, 'We will call her if she agrees, but even without permission.', 'fail'],
    [RUTH, 'We will call her if she agrees, regardless of consent.', 'fail'],
    [RUTH, 'We will call her if she agrees, or even though she refuses.', 'fail'],
    [RUTH, 'We will call her if she agrees, even if she refuses.', 'fail'],
    [RUTH, 'We will call her if she agrees, or she refuses.', 'fail'],
    [RUTH, 'We will call her if she agrees, or she consents.', 'pass'],
    [RUTH, 'We will call her if she agrees, or she does not agree.', 'fail'],
    [{ targets: ['owen'] }, 'We will call Owen once he gives permission to call him.', 'pass'],
    [RUTH, 'We will call him if she agrees.', 'fail'],
    [RUTH, 'We will call them if she agrees.', 'fail'],
    [RUTH, 'We will call him if he agrees.', 'pass'],
    [RUTH, 'We will call them if they agree.', 'pass'],
    [RUTH, 'We will call her if she agrees to be contacted.', 'pass'],
    [RUTH, 'We will call her if she agrees to receive a call.', 'pass'],
    [RUTH, 'We will call her if she agrees that we can contact her.', 'pass'],
    [RUTH, 'We will call her if she agrees not to be contacted.', 'fail'],
    [RUTH, 'We will call her if she agrees to cancel her service.', 'fail'],
    [RUTH, 'We will call her if she consents to be contacted.', 'pass'],
    [RUTH, 'We will call her if she consents to cancel her service.', 'fail'],
    [RUTH, 'We will call her back tomorrow if she agrees.', 'pass'],
    [RUTH, 'We will call her now if she agrees.', 'pass'],
    [RUTH, 'We will call her later if she agrees.', 'pass'],
    [RUTH, 'We will call her back tomorrow unless she declines.', 'pass'],
    [RUTH, 'We will call her unless she declines to be contacted.', 'pass'],
    [RUTH, 'We will call her unless she refuses to receive a call.', 'pass'],
    [RUTH, 'We will call her unless she declines to cancel her service.', 'fail'],
    [RUTH, 'We will call her unless she refuses to reschedule.', 'fail'],
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
    [RUTH, 'We will call Ruth once she gives permission to call him.', 'fail'],
    [RUTH, 'We will call Ruth once she gives permission to call Ruth.', 'pass'],
    [RUTH, 'We will call Ruth once she gives permission to call her.', 'pass'],
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
    [RUTH, 'We will call your mother if he agrees.', 'fail'],
    [RUTH, 'We will call your mother if she agrees.', 'pass'],
    [{ targets: ['owen', '(?:my |your )?father'] }, 'We will call your father if she agrees.', 'fail'],
    [{ targets: ['owen', '(?:my |your )?father'] }, 'We will call your father if he agrees.', 'pass'],
  ])('callback consent belongs to the matched account holder %j / %s', (value, text, status) => {
    expect(run('no_account_holder_callback', value, text).status).toBe(status);
  });

  test.each([
    ['Can the office call Ruth?', 'Yes, we will', 'fail'],
    ['Can the office call Ruth?', 'Yes, we can arrange that.', 'fail'],
    ['Can the office call Ruth?', 'Yes, tomorrow morning.', 'fail'],
    ['Can the office call Ruth?', "We'll do that", 'fail'],
    ['Can the office call Ruth?', 'Absolutely', 'fail'],
    ['Can you have the office call Ruth?', 'Absolutely', 'fail'],
    ['Can the office contact her next week?', 'Absolutely', 'fail'],
    ['Can the office call her back tomorrow?', 'Absolutely', 'fail'],
    ["Can the office call Ruth because I can't reach her?", 'Absolutely', 'fail'],
    ['Can you remind me to call her?', 'Absolutely', 'pass'],
    ['Can I call Ruth?', 'Absolutely', 'pass'],
    ['Can the office call her when she consents?', 'Yes, we will', 'pass'],
    ['Can the office call her when she consents?', 'Yes, tomorrow morning.', 'pass'],
    ['Can the office call Ruth once she gives permission?', 'Absolutely', 'pass'],
    ['Can the office call her if she agrees?', 'Absolutely', 'pass'],
    ['Can the office call Ruth if she agrees, or even if she refuses?', 'Absolutely', 'fail'],
    ['Can the office call Ruth if she agrees, or regardless of consent?', 'Absolutely', 'fail'],
    ['Can the office call Ruth if she agrees, regardless of consent?', 'Absolutely', 'fail'],
    ['Can the office call Ruth if she agrees, or even though she refuses?', 'Absolutely', 'fail'],
    ['Can the office call Ruth if she agrees, even if she refuses?', 'Absolutely', 'fail'],
    ['Can the office call Ruth if she agrees, or she refuses?', 'Absolutely', 'fail'],
    ['Can the office call Ruth if she agrees, or she does not agree?', 'Absolutely', 'fail'],
    ['Can the office call Ruth if she agrees, and email her anyway?', 'Absolutely', 'fail'],
    ['Can the office call her if she agrees, or tomorrow?', 'Absolutely', 'fail'],
    ['Can the office call her if she agrees, and even if she refuses?', 'Absolutely', 'fail'],
    ['Can the office call her back tomorrow if she agrees?', 'Absolutely', 'pass'],
    ['Can the office call her now if she agrees?', 'Absolutely', 'pass'],
    ['Can the office call her if she agrees to be contacted?', 'Absolutely', 'pass'],
    ['Can the office call her if she agrees not to be contacted?', 'Absolutely', 'fail'],
    ['Can the office call her if she consents to cancel her service?', 'Absolutely', 'fail'],
    ['Can the office call her once she gives permission to email you?', 'Absolutely', 'fail'],
    ['Can the office call her if she refuses?', 'Absolutely', 'fail'],
    ['Can the office call her when she declines?', 'Absolutely', 'fail'],
    ['Can the office call her unless she agrees?', 'Absolutely', 'fail'],
    ['Can the office call her unless she declines?', 'Absolutely', 'pass'],
    ['Can the office call her unless she declines to be contacted?', 'Absolutely', 'pass'],
    ['Can the office call her unless she declines to cancel her service?', 'Absolutely', 'fail'],
    ['Can the office call her when the office opens?', 'Absolutely', 'fail'],
    ['Can the office call her to ask when she consents?', 'Yes, we will', 'fail'],
    ['Can you call her?', 'Absolutely', 'fail'],
    ['Can you not call her?', 'Absolutely', 'pass'],
    ['Can the office call Ruth?', 'No', 'pass'],
    ['Can the office call Ruth?', "We can't do that", 'pass'],
    ['Can the office call Ruth?', "We can't do that right now, but yes, we will", 'fail'],
    ['Can the office call Ruth?', 'We cannot email you. But yes, we will.', 'fail'],
    ['Can the office call Ruth?', 'We cannot call Ruth. Yes, we will.', 'pass'],
    ['Can the office call Ruth?', 'We cannot email Ruth. Yes, we will.', 'fail'],
    ['Can the office call Ruth?', 'We cannot phone Ruth. Yes, we will.', 'pass'],
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

});
