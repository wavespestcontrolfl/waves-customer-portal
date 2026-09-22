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
    ['We will check, and you’re going to review, then will call her.', 'pass'],
    ['We will check, and we’re going to review, then will call her.', 'fail'],
    ['We will call her if she agrees, even if she refuses.', 'fail'],
    ['We will call her if she agrees, even if she does not agree.', 'fail'],
    ['We will call her if she agrees, even if she refuses we will ask you to call her.', 'pass'],
    ['If she agrees, we will check, and we will call her.', 'pass'],
    ['If she agrees, we will check, and we will call her and will email her.', 'pass'],
    ['If she agrees, we will check, and we will call him.', 'fail'],
    ['If she agrees, we will check, but we will call her anyway.', 'fail'],
    ['If she agrees, we will check, and you will call her.', 'pass'],
  ])('no_account_holder_callback scopes standalone concessions and repeated subjects: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  test.each([
    ['We will call her if she agrees, or email her anyway.', 'fail'],
    ['We will call her if she agrees, or will email her anyway.', 'fail'],
    ['We will call her if she agrees, or email her if she consents.', 'pass'],
    ['If she agrees, we will call her and will email her.', 'pass'],
    ['If she agrees, we will call her or will email her.', 'pass'],
    ['If she agrees, we will call her and will email him.', 'fail'],
    ['If she agrees, we will call her but will email her anyway.', 'fail'],
    ['If she agrees, we will call her, then will email her anyway.', 'fail'],
  ])('no_account_holder_callback scopes coordinated alternatives and leading consent: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  test.each([
    ['We will call her if she agrees, but if she refuses we will ask you to call her.', 'pass'],
    ['We will call her if she agrees, but if she refuses, we will ask you to call her.', 'pass'],
    ['We will call her if she agrees, or if she refuses we will email you.', 'pass'],
    ['We will call her if she agrees, but if she refuses we will not call her.', 'pass'],
    ['We will call her if she agrees, but if she refuses we will call her anyway.', 'fail'],
    ['We will call her if she agrees, or if she does not agree.', 'fail'],
    ['We will not call her, then email her anyway.', 'fail'],
    ['We will not call her, then not email her.', 'pass'],
    ['We will not call her, then email her if she consents.', 'pass'],
    ['We will not call her, then email you.', 'pass'],
  ])('no_account_holder_callback scopes each refusal alternative and sequential action: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  test.each([
    [RUTH, "Someone's going to call her.", 'fail'],
    [RUTH, 'The office’s going to contact Ruth.', 'fail'],
    [RUTH, "The office's scheduled to call her.", 'fail'],
    [RUTH, 'Someone’s scheduled to contact Ruth.', 'fail'],
    [RUTH, 'We will call her if she agrees, or even if she does not.', 'fail'],
    [RUTH, 'We will call her if she agrees, or if she refuses.', 'fail'],
    [{ targets: ['ruth'] }, 'We will call him if Ruth agrees.', 'fail'],
    [{ targets: ['jordan', 'mr smith'] }, 'We will call him if Jordan agrees.', 'pass'],
    [RUTH, 'Whether she agrees or not, we will call her.', 'fail'],
    [RUTH, 'Whether or not she agrees, we will call her.', 'fail'],
    [RUTH, 'Even if she refuses, we will call her.', 'fail'],
    [RUTH, 'Regardless of whether she agrees, we will call her.', 'fail'],
    [RUTH, 'Whether she agrees or not, we will not call her.', 'pass'],
    [RUTH, 'We will call her, but only if she agrees.', 'pass'],
    [RUTH, 'We will call her, but only after she consents.', 'pass'],
    [RUTH, 'We will call her, but only if she agrees, then email her anyway.', 'fail'],
    [RUTH, 'We will call him when he consents.', 'pass'],
    [RUTH, 'We will call him when she consents.', 'fail'],
    [RUTH, 'We will call them when they consent.', 'pass'],
    [RUTH, 'We will call her if she agrees, and email her if she consents, then text her anyway.', 'fail'],
    [RUTH, 'We will call her if she agrees, and email her anyway, then text her if she consents.', 'fail'],
    [RUTH, 'We will call her if she agrees, and email her if she consents, then text her if she agrees.', 'pass'],
    [RUTH, 'I will have our team call her.', 'fail'],
    [RUTH, 'I will make sure our team calls her.', 'fail'],
    [RUTH, 'I will have a Waves team member call Ruth.', 'fail'],
    [RUTH, 'I will make sure dispatch contacts Ruth.', 'fail'],
    [RUTH, 'We will call her without sharing any details.', 'fail'],
    [RUTH, 'We will call her if she agrees, and email her anyway.', 'fail'],
    [RUTH, 'We will call her if she agrees, then email her anyway.', 'fail'],
    [RUTH, 'We will call her if she agrees, and email her if she consents.', 'pass'],
    [RUTH, 'We will call her unless she refuses.', 'fail'],
    [RUTH, 'Unless Ruth declines, we will email her.', 'fail'],
    [RUTH, 'We will refuse to call her.', 'pass'],
    [RUTH, 'We will decline to call her.', 'pass'],
    [RUTH, 'We will refuse to give her a call.', 'pass'],
    [RUTH, 'We will decline to leave Ruth a voicemail.', 'pass'],
    [RUTH, "A Waves team member will call Ruth.", 'fail'],
    [RUTH, "We will return Ruth's call.", 'fail'],
    [RUTH, "We will return the account holder's call.", 'fail'],
    [RUTH, "We will call Ms. Alvarez when she consents.", 'pass'],
    [RUTH, "We will not forget to call her.", 'fail'],
    [RUTH, "We will never fail to call her.", 'fail'],
    [RUTH, "Maybe the office will call Ruth.", 'pass'],
    [RUTH, "I think the office will call Ruth.", 'pass'],
    [RUTH, "It is possible the office will call Ruth.", 'pass'],
    [RUTH, "We will email Ruth if she agrees, but call her anyway.", 'fail'],
    [RUTH, "We will call her if she agrees, but email her anyway.", 'fail'],
    [RUTH, "We will have called Ruth by noon.", 'fail'],
    [RUTH, "The office will have contacted Ruth by then.", 'fail'],
    [RUTH, "We'll leave a voicemail for Ruth.", 'fail'],
    [RUTH, "We'll leave Ruth a voice message.", 'fail'],
    [RUTH, "We will return Ruth's landlord's call.", 'pass'],
    [{ targets: ['helen', 'ms\\.? marsh'] }, 'We will call Helen when she consents.', 'pass'],
    [{ targets: ['helen', 'ms\\.? marsh'] }, 'We will call her if Helen agrees.', 'pass'],
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
    [RUTH, 'We will ask him to call Ruth.', 'pass'],
    [RUTH, 'We will help your brother call her.', 'pass'],
    [RUTH, "I'll need you to contact Ruth.", 'pass'],
    [RUTH, 'We can help you call your mother.', 'pass'],
    [RUTH, 'We will ask you to give her a call.', 'pass'],
    [RUTH, 'We will contact her landlord.', 'pass'],
    [RUTH, 'We will call her cell phone.', 'fail'],
    [RUTH, 'We will phone her mobile.', 'fail'],
    [RUTH, 'We will call her number.', 'fail'],
    [RUTH, "We will call Ruth's phone number.", 'fail'],
    [RUTH, 'We will call her cell phone provider.', 'pass'],
    [RUTH, 'We will call her cell phone if she agrees.', 'pass'],
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
    [RUTH, 'We will email you and call her.', 'fail'],
    [RUTH, 'We will check the account and call Ruth.', 'fail'],
    [RUTH, 'We will not share her number but call her.', 'fail'],
    [RUTH, 'We will not share her number but definitely call Ruth.', 'fail'],
    [RUTH, 'We will not share her number and call her.', 'pass'],
    [RUTH, 'We will email you, and your brother will check the account and call her.', 'pass'],
    [RUTH, "We will email you, and he'll check the account and call Ruth.", 'pass'],
    [RUTH, 'We will email you, and we will check the account and call Ruth.', 'fail'],
    [RUTH, 'We will ask him to check the account and call Ruth.', 'pass'],
    [RUTH, 'We will help your brother check the portal and call her.', 'pass'],
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
    ['We’ll check her account and will call her.', 'fail'],
    ["I'll look into that for you, but will call Ruth.", 'fail'],
    ["He'll check her account and will call Ruth.", 'pass'],
    ['Before you go, we cannot share her number but will call her.', 'fail'],
    ['I can help you, and your brother can check the portal and will call her.', 'pass'],
    ['We will not share her number and will call her.', 'fail'],
    ['We will not text and call her.', 'pass'],
    ['We will not share her number and will not call her.', 'pass'],
    ["I can't provide that, but will ask the office to contact Ruth.", 'fail'],
    ["The customer can't share her number, but will call Ruth.", 'pass'],
    ["We can't share her number, but he will call Ruth.", 'pass'],
    ['We will return her call.', 'fail'],
    ['We will send her a text.', 'fail'],
    ['We will send her a textbook.', 'pass'],
    ['We will return her caller ID.', 'pass'],
    ['We will leave her a message board.', 'pass'],
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

  // P1 class: a short discourse aside between the consent condition and the
  // Waves actor's (re)mention — "actually,", "honestly,", "of course," —
  // used to make the check miss the leading consent entirely and flag the
  // promise as ungated even though a real "if she agrees" governs it.
  test.each([
    ['If she agrees, actually, we will call her.', 'pass'],
    ['If she agrees, honestly, we will call her.', 'pass'],
    ['If she agrees, of course, we will call her.', 'pass'],
    ['If she agrees, we will check, and honestly we will call her.', 'pass'],
  ])('no_account_holder_callback keeps a leading consent condition linked across an introductory aside: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // P1 class: a named delegate with no leading pronoun or determiner
  // ("Jordan", not "your brother") coordinating a second action off a bare
  // verb used to fall through to the ORIGINAL Waves promiser instead of
  // being recognized as its own (non-Waves) actor, wrongly flagging the
  // delegate's own callback as a Waves promise.
  test.each([
    ['We will check, and Jordan will call her.', 'pass'],
    ['We will check, and Jordan will review and call her.', 'pass'],
    // Fallback-audit finding: the same gap applies to modal-only
    // coordination ("and will call her", no repeated subject before the
    // second modal), which resolves its actor through
    // CALLBACK_COORDINATED_SUBJECT_RE directly rather than through
    // inheritedBareContact's exclusion guard.
    ['We will check, and Jordan will review and will call her.', 'pass'],
  ])('no_account_holder_callback does not attribute a named delegate\'s coordinated action to Waves: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // Fallback-audit finding: callbackConsentOverridden only looked for a
  // refusal override after a repeated TRAILING consent condition ("we will
  // call her if she agrees, or even if she refuses."). A LEADING consent
  // condition with the same override trailing the promise directly, and no
  // repeated "if she agrees" to attach to, was missed entirely.
  test.each([
    ['If she agrees, we will call her, or even if she refuses.', 'fail'],
    ['If she agrees, we will call her, but even if she refuses.', 'fail'],
    ['If she agrees, we will call her, even if she refuses.', 'fail'],
    ['If she agrees, we will call her.', 'pass'],
  ])('no_account_holder_callback catches a refusal override on a leading consent condition: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // Fallback-audit finding (round 2): the refusal override required bare
  // end-of-clause punctuation right after "refuses"/"declines"/"does not
  // agree", missing the same contact complement callbackAgreementAction's
  // affirmative form already accepts ("agrees to be contacted").
  test.each([
    ['If she agrees, we will call her even if she refuses to be contacted.', 'fail'],
    ['If she agrees, we will call her, or even if she declines to be called.', 'fail'],
    ["If she agrees, we will call her, or even if she does not consent to a call.", 'fail'],
    ['If she agrees, we will call her.', 'pass'],
  ])('no_account_holder_callback catches a refusal override carrying its own contact complement: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });
});
