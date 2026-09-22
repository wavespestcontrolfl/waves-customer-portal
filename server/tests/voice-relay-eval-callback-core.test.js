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
    // GitHub round-4 audit on #4583 P2 (spoken-checks.js:1902): a target
    // that compiles fine in ISOLATION can still break once
    // no_account_holder_callback interpolates it into a larger composed
    // regex — a named capture group throws "Duplicate capture group
    // name" once it is embedded more than once (it already is, in the
    // alternative-grantor override's "if" and "with" branches); a
    // backreference silently points at the wrong group once real group
    // numbering shifts. Both must be rejected as an invalid fixture here,
    // not surfaced as a crash mid-evaluation.
    [{ targets: ['(?<person>ruth)'] }, 'value must be { targets: ["<regex naming the account holder>", …] }'],
    [{ targets: ['(ruth)\\1'] }, 'value must be { targets: ["<regex naming the account holder>", …] }'],
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

  // Fallback-audit finding (round 3): refusalOverride only recognized
  // "even if"/"even when" overrides. A trailing "whether she agrees or
  // not" / "regardless of whether she agrees" / "irrespective of ...
  // consent" — the same CALLBACK_CONCESSION forms candidate recognition
  // already treats as unconditional — must override a leading consent
  // condition the same way.
  test.each([
    ['If she agrees, we will call her whether she agrees or not.', 'fail'],
    ['If she agrees, we will call her whether or not she agrees.', 'fail'],
    ['If she agrees, we will call her regardless of whether she agrees.', 'fail'],
    ['If she agrees, we will call her irrespective of whether she agrees or not.', 'fail'],
    ['If she agrees, we will call her regardless of her consent.', 'fail'],
    ['If she agrees, we will call her.', 'pass'],
  ])('no_account_holder_callback catches a whether/regardless concession override on a leading consent condition: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // Push-audit finding: concessionOverride's bareAgree accepted only a bare
  // "agrees"/"consents", missing the same contact complement
  // callbackAgreementAction()'s affirmative form already accepts ("agrees
  // to be contacted") — a contact complement between "agrees" and "or not"
  // hid the override, leaving the leading consent gate wrongly effective.
  test.each([
    ['If she agrees, we will call her whether she agrees to be contacted or not.', 'fail'],
    ['If she agrees, we will call her regardless of whether she agrees to a call.', 'fail'],
    ['If she agrees, we will call her.', 'pass'],
  ])('no_account_holder_callback catches a concession override carrying its own contact complement: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // Fallback-audit finding: concessionOverride's final branch required the
  // recipient's own possessive before "consent" ("her consent"), missing
  // the equally common target-less forms ("regardless of consent") and
  // "permission" as a synonym for consent.
  test.each([
    ['If she agrees, we will call her regardless of consent.', 'fail'],
    ['If she agrees, we will call her irrespective of consent.', 'fail'],
    ['If she agrees, we will call her regardless of permission.', 'fail'],
    ['If she agrees, we will call her.', 'pass'],
  ])('no_account_holder_callback catches a target-less regardless/irrespective consent override: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-1 P1 (candidates.js:55): a subjectless adverbial
  // directly before a modal in a coordinated clause ("and tomorrow will
  // review") was itself being treated as a new (unresolved) subject,
  // wrongly excusing the ORIGINAL Waves promiser's own unconditional
  // promise. "We" still governs either construction.
  test.each([
    ['We will check, and tomorrow will review and call Ruth.', 'fail'],
    ['We will check, and tomorrow will review, and will call Ruth.', 'fail'],
    // Controls: a real named delegate still correctly excuses Waves.
    ['We will check, and Jordan will review and call Ruth.', 'pass'],
    ['We will check, and Jordan will review, and will call Ruth.', 'pass'],
  ])('no_account_holder_callback does not treat a bare adverbial as a coordinated subject: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-1 P1 (spoken-checks.js:1450): a name-only recipient
  // config ({ targets: ['ruth'] }, no gender hint) widened its consent
  // condition to accept ALL THREE pronouns, so another person's own
  // agreement satisfied Ruth's consent whenever a competing antecedent was
  // named earlier in the same utterance.
  test.each([
    [{ targets: ['ruth'] }, 'John is handling this. We will call Ruth if he agrees.', 'fail'],
    // Controls: no competing antecedent still leaves the pronoun free to
    // mean the only person the callback itself names.
    [{ targets: ['ruth'] }, 'We will call Ruth if he agrees.', 'pass'],
    [{ targets: ['ruth'] }, 'We will call Ruth when she consents.', 'pass'],
  ])('no_account_holder_callback does not let a competing antecedent satisfy a name-only recipient\'s consent %j / %s', (value, text, status) => {
    expect(run('no_account_holder_callback', value, text).status).toBe(status);
  });

  // GitHub Codex round-1 P1 (spoken-checks.js:1543): the introductory-aside
  // pattern had no exclusion for words that REVERSE the consent condition
  // ("otherwise", "if not", "without consent") — they were consumed as
  // asides, letting a leading "if she agrees" wrongly gate a callback that
  // actually fires when she does NOT agree.
  test.each([
    ['If she agrees, we will check, and otherwise we will call Ruth.', 'fail'],
    ['If she agrees, we will check, and if not we will call Ruth.', 'fail'],
    ['If she agrees, we will check, and without consent we will call Ruth.', 'fail'],
    // Control: a genuine discourse aside still keeps the leading gate.
    ['If she agrees, we will check, and honestly we will call Ruth.', 'pass'],
  ])('no_account_holder_callback rejects condition-reversing words as an introductory aside: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-1 P1 (spoken-checks.js:1505) — the class-3 repro
  // ("alternative caller-permission conditions bypassing account-holder
  // consent") that could not be found earlier in this lane: an "or"
  // alternative naming a DIFFERENT grantor — a named third party, or "the
  // caller's permission" — lets the callback proceed without the account
  // holder's own consent. The elliptical alternative ("or if John asks")
  // has no repeated callback verb, so it never becomes its own graded
  // candidate; it has to be read as an override on the first one instead.
  test.each([
    ['We will call Ruth if she agrees, or if John asks.', 'fail'],
    ["We will call Ruth if she agrees, or with the caller's permission.", 'fail'],
    // Controls: the SAME grantor (her own name/pronoun) is not an
    // alternative at all.
    ['We will call Ruth if she agrees, or if she asks.', 'pass'],
    ["We will call Ruth if she agrees, or with her permission.", 'pass'],
    ['We will call Ruth if she agrees.', 'pass'],
  ])('no_account_holder_callback treats an alternative grantor as a consent override: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-1 P2 (spoken-checks.js:1558): a trailing consent was
  // only accepted when EVERYTHING between the recipient and the condition
  // matched the visit/timing allowlists, so an ordinary topic ("about the
  // appointment") or manner adverb ("directly") falsely broke the gate.
  // An infinitive purpose clause ("to ask") legitimately still breaks it —
  // it conditions the asking, not the call.
  test.each([
    ['We will call Ruth about the appointment if Ruth agrees.', 'pass'],
    ['We will call her directly if she agrees.', 'pass'],
    // Controls: an infinitive purpose clause still correctly breaks the gate.
    ['We will call her to ask if she agrees.', 'fail'],
    ['We will call her to see if she agrees to a callback.', 'fail'],
  ])('no_account_holder_callback keeps a trailing consent condition after an ordinary topic/manner modifier: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-1 P2 (spoken-checks.js:1565): the speculative-prefix
  // check required the hedge to be followed immediately by whitespace, so
  // "Maybe, we will call Ruth." (comma after the hedge) was graded as a
  // definite promise instead of the same speculative statement as "Maybe
  // we will call Ruth."
  test.each([
    ['Maybe, we will call Ruth.', 'pass'],
    ['Perhaps, we will call Ruth.', 'pass'],
    // Control: no hedge at all is still a definite promise.
    ['We will call Ruth.', 'fail'],
  ])('no_account_holder_callback recognizes a punctuated introductory hedge: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-1 P2 (spoken-checks.js:1568): the final verdict
  // never checked whether the candidate sits inside a question — Sandy
  // asking or repeating a question is not committing Waves to anything.
  test.each([
    ['We will call Ruth?', 'pass'],
    ['Did you say we will call Ruth?', 'pass'],
    ['Do you think we will call Ruth?', 'pass'],
    // Control: the same clause with a period is still a definite promise.
    ['We will call Ruth.', 'fail'],
  ])('no_account_holder_callback excludes interrogative callback wording from a promise: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-2 P1 (spoken-checks.js:1527): alternativeGrantorOverride
  // treated "and" the same as "or", so an ADDITIONAL required approval
  // ("if she agrees, and if John agrees" — both are needed) was wrongly
  // read as an alternative that excuses her own consent.
  test.each([
    ['We will call Ruth if she agrees, and if John agrees.', 'pass'],
    // Control: "or" is still a genuine alternative.
    ['We will call Ruth if she agrees, or if John asks.', 'fail'],
  ])('no_account_holder_callback keeps consent mandatory when "and" adds a second required approval: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-2 P1 (spoken-checks.js:1621): interrogative
  // detection scanned for the next ./!/? and skipped right past a
  // semicolon, so a LATER unrelated question suppressed a violation the
  // callback's own (semicolon-terminated) clause already committed.
  test.each([
    ['We will call Ruth; what else can I help with?', 'fail'],
    // Control: the candidate's own clause really is a question.
    ['We will call Ruth?', 'pass'],
  ])('no_account_holder_callback bounds interrogative detection to the callback\'s own clause: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-3 P1 (spoken-checks.js:1629): a comma-joined
  // trailing question ("we will call Ruth tomorrow, can I help with
  // anything else?") is the SAME class of unrelated later question as the
  // semicolon case above, just punctuated with a comma — the next
  // terminator was still '?', so the definite callback before it was
  // wrongly suppressed. Only a comma whose own follow-on clause has
  // interrogative structure (an aux verb leading, "can I help…") counts;
  // an ordinary comma-joined continuation keeps scanning as before.
  test.each([
    ['We will call Ruth tomorrow, can I help with anything else?', 'fail'],
    // Control: the candidate's own clause really is a question.
    ['We will call Ruth?', 'pass'],
  ])('no_account_holder_callback bounds interrogative detection past a comma-joined trailing question: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-3 P1 (spoken-checks.js:1538): the override patterns
  // (refusal, concession, alternative grantor) were anchored immediately
  // after the recipient, so a timing modifier between them and the
  // override ("we will call her TOMORROW even if she refuses") prevented
  // the match and left the leading consent gate wrongly credited.
  test.each([
    ['If she agrees, we will call her tomorrow even if she refuses.', 'fail'],
    // Control: no timing modifier, already covered, still correct.
    ['If she agrees, we will call her even if she refuses.', 'fail'],
  ])('no_account_holder_callback recognizes a refusal override after a timing modifier: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-4 P1 (spoken-checks.js:1645, wider sibling of the
  // round-3 fix): QUESTION_LEAD_RE only covers the aux-led half of the
  // file's question-lead grammar. A WH-led trailing question after a
  // comma ("we will call Ruth tomorrow, what else can I help with?") is
  // the same kind of separate, later question as an aux-led one
  // ("...can I help...?") and must be excluded the same way.
  test.each([
    ['We will call Ruth tomorrow, what else can I help with?', 'fail'],
    // Control: the candidate's own clause really is a question.
    ['We will call Ruth?', 'pass'],
  ])('no_account_holder_callback bounds interrogative detection past a wh-led trailing question: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub Codex round-4 P1 (spoken-checks.js:1498, wider sibling of the
  // round-3 fix): CONSENT_OVERRIDE_TIMING_PREFIX accepted only a single
  // timing component, so a compound timing phrase ("tomorrow morning",
  // "later this week") between the recipient and the override still hid
  // it, the same gap a single timing word had before.
  test.each([
    ['If she agrees, we will call her tomorrow morning even if she refuses.', 'fail'],
    ['If she agrees, we will call her later this week even if she refuses.', 'fail'],
    // Control: a single timing component, already covered, still correct.
    ['If she agrees, we will call her tomorrow even if she refuses.', 'fail'],
  ])('no_account_holder_callback recognizes a refusal override after a compound timing phrase: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-2 audit on #4583 P1 (spoken-checks.js:1512): the override
  // prefix accepted only timing phrases, missing the same manner/topic
  // modifiers consentModifierIsSafe already allows before a TRAILING
  // consent condition — "directly", "about the appointment" hid the
  // override just as a timing word once did.
  test.each([
    ['If she agrees, we will call her directly even if she refuses.', 'fail'],
    ['If she agrees, we will call her about the appointment even if she refuses.', 'fail'],
    // Control: no modifier at all, already covered, still correct.
    ['If she agrees, we will call her even if she refuses.', 'fail'],
  ])('no_account_holder_callback recognizes a refusal override after an ordinary manner/topic modifier: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-2 audit on #4583 P1 (spoken-checks.js:1658): only the
  // FIRST comma after the callback was inspected for a trailing question
  // lead. An intervening comma-joined aside of its own ("tomorrow, as
  // promised, can I help...?") sits before the real question's comma, so
  // checking only the first one missed it entirely.
  test.each([
    ['We will call Ruth tomorrow, as promised, can I help with anything else?', 'fail'],
    // Control: an aside with no separate question after it — the
    // interrogative lead is already BEFORE the candidate, so the aside's
    // own comma must not be mistaken for introducing a new question.
    ['Did you say we will call Ruth, as promised?', 'pass'],
  ])('no_account_holder_callback checks every comma boundary for a trailing question, not just the first: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-3 audit on #4583 P1 (candidates.js:74) — REGRESSION from
  // the round-1 adverbial fix: a non-timing discourse adverb ("otherwise")
  // was not excluded from the coordinated-subject-shift guard the same
  // way a timing adverb ("tomorrow") already was, so it was itself read
  // as a new (unresolved) subject and wrongly cleared the Waves actor.
  test.each([
    ['We will check, and otherwise will review, and will call Ruth.', 'fail'],
    ['We will check, and otherwise will review and call Ruth.', 'fail'],
    // Controls: round-1's timing-adverb and named-delegate cases stay green.
    ['We will check, and tomorrow will review and call Ruth.', 'fail'],
    ['We will check, and tomorrow will review, and will call Ruth.', 'fail'],
    ['We will check, and Jordan will review and call Ruth.', 'pass'],
    ['We will check, and Jordan will review, and will call Ruth.', 'pass'],
  ])('no_account_holder_callback does not treat a discourse adverb as a coordinated subject: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-3 audit on #4583 P1 (spoken-checks.js:1555): the grantor
  // exclusion rejected any phrase merely STARTING with "her"/"him"/
  // "their", so a possessive third-party grantor ("her son") was blocked
  // outright instead of being recognized as someone else. Only a grantor
  // that reduces to EXACTLY the recipient's own reference is excluded;
  // "her" as a possessive modifier inside a longer phrase names someone
  // else and still overrides.
  test.each([
    ['We will call Ruth if she agrees, or if her son agrees.', 'fail'],
    ["We will call Ruth if she agrees, or with her son's permission.", 'fail'],
    // Controls: the recipient's own reference, bare or possessive-marked,
    // is still not an alternative grantor.
    ['We will call Ruth if she agrees, or if she asks.', 'pass'],
    ["We will call Ruth if she agrees, or with her permission.", 'pass'],
    ["We will call Ruth if she agrees, or with Ruth's permission.", 'pass'],
  ])('no_account_holder_callback matches a complete possessive/multiword grantor phrase: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-4 audit on #4583 P1 (candidates.js:81) — the adverbial
  // seam's THIRD appearance: the guard was still an excluded-word list
  // (timing adverbs, then discourse adverbs), so ANY new lowercase
  // adverbial the list hadn't named yet ("after lunch", "unfortunately",
  // "eventually", "if necessary") kept being read as a new subject and
  // clearing the Waves actor. Closed structurally: a coordinated token
  // before a modal now counts as a new subject only when it is itself
  // NP-shaped (the file's promiser/actor-head grammar, or a capitalized
  // name) — no further word-list entries needed for the next adverb.
  test.each([
    ['We will check, and after lunch will review and call Ruth.', 'fail'],
    ['We will check, and unfortunately will review and call Ruth.', 'fail'],
    ['We will check, and eventually will review and call Ruth.', 'fail'],
    ['We will check, and if necessary will review and call Ruth.', 'fail'],
    // Controls: every prior adverbial/delegate case from rounds 1 and 3
    // stays green — both bare and modal coordination.
    ['We will check, and otherwise will review, and will call Ruth.', 'fail'],
    ['We will check, and otherwise will review and call Ruth.', 'fail'],
    ['We will check, and tomorrow will review and call Ruth.', 'fail'],
    ['We will check, and tomorrow will review, and will call Ruth.', 'fail'],
    ['We will check, and Jordan will review and call Ruth.', 'pass'],
    ['We will check, and Jordan will review, and will call Ruth.', 'pass'],
  ])('no_account_holder_callback treats any bare adverbial, not just a listed one, as preserving the Waves subject: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-4 audit on #4583 P1 (spoken-checks.js:1559): the
  // possessive exemption hard-coded her|him|their unconditionally, so
  // ANOTHER person's actual pronoun could pass as if it were the
  // recipient's own — with a male recipient (Jordan / Mr. Smith), "her
  // permission" is someone ELSE's permission and must still override.
  // Derived from whichever pronoun(s) conditionTarget itself already
  // resolved to, so the recipient's own possessive/object pronoun (his,
  // for a male recipient) still correctly exempts.
  test.each([
    [{ targets: ['jordan', 'mr smith'] }, "We will call him if he agrees, or with her permission.", 'fail'],
    [{ targets: ['jordan', 'mr smith'] }, "We will call him if he agrees, or with his permission.", 'pass'],
    // Control: the recipient's own bare-pronoun possessive still exempts
    // for a name-only recipient with a gender hint too.
    [RUTH, "We will call Ruth if she agrees, or with her permission.", 'pass'],
  ])('no_account_holder_callback resolves the possessive exemption from the actual recipient %j / %s', (value, text, status) => {
    expect(run('no_account_holder_callback', value, text).status).toBe(status);
  });

  // GitHub round-4 audit on #4583 P1 (spoken-checks.js:1686): a
  // sentence-initial Waves subject whose FIRST predicate carries no
  // auxiliary ("We checked the account and will call Ruth.", "We know
  // the answer and will call Ruth.") produced an actor-less coordinated
  // candidate, since CALLBACK_COORDINATED_SUBJECT_RE requires a modal
  // right after the subject — a bare past/present-tense verb isn't one.
  test.each([
    ['We checked the account and will call Ruth.', 'fail'],
    ['We know the answer and will call Ruth.', 'fail'],
    // Control: an auxiliary-bearing first predicate already worked.
    ['We have checked the account and will call Ruth.', 'fail'],
  ])('no_account_holder_callback resolves a sentence-initial Waves subject before a coordinated modal with no auxiliary of its own: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-4 audit on #4583 P2 (spoken-checks.js:1568): the
  // fallback consent search (rawConsent) scanned the entire REMAINDER of
  // the utterance, not just the callback's own sentence, so a LATER,
  // unrelated sentence's condition and alternative grantor could revoke
  // consent that correctly gates an EARLIER, already-resolved callback.
  test.each([
    ['If she agrees, we will call Ruth. John can help if she agrees, or if Mary asks.', 'pass'],
    // Controls: same-sentence overrides still correctly apply.
    ['We will call her if she agrees, or even if she refuses.', 'fail'],
    ['If she agrees, we will call her, or even if she refuses.', 'fail'],
  ])('no_account_holder_callback bounds the fallback consent search to the callback\'s own sentence: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-4 audit on #4583 P2 (spoken-checks.js:1687): scheduled-
  // call candidates included past-tense "was"/"were", so a historical
  // statement ("Ruth was scheduled for a call with us, but it was
  // canceled.", or even the bare "I was scheduled for a call with
  // Ruth." with no cancellation context at all) was graded as a current
  // commitment. Excluded at recognition — never a candidate at all,
  // rather than one whose past tense a downstream check has to notice.
  test.each([
    ['Ruth was scheduled for a call with us, but it was canceled.', 'pass'],
    ['I was scheduled for a call with Ruth.', 'pass'],
    // Control: present tense is still a current commitment.
    ['Ruth is scheduled for a call with us.', 'fail'],
  ])('no_account_holder_callback excludes a past-tense scheduled call from a current promise: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });

  // GitHub round-5 audit on #4583 P1 (candidates.js:335): the fallback
  // sentence-initial subject was anchored immediately after sentenceStart,
  // which points right after the PRECEDING sentence's own terminator, not
  // after the whitespace following it, whenever the callback isn't in the
  // text's first sentence.
  test.each([
    ['Okay. We checked the account and will call Ruth.', 'fail'],
    // Control: the first-sentence case (no leading whitespace to allow
    // for) still resolves the same way.
    ['We checked the account and will call Ruth.', 'fail'],
  ])('no_account_holder_callback resolves a sentence-initial Waves subject after a preceding sentence: %s', (text, status) => {
    expect(run('no_account_holder_callback', RUTH, text).status).toBe(status);
  });
});
