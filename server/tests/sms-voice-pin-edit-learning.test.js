// GATE_SMS_VOICE_PROFILE_PIN + GATE_SMS_EDIT_LEARNING: gate readers and the prompt-version identity (no DB needed).
// The Postgres contract (pin resolution, miner, exemplar ranking) is in sms-voice-pin-edit-learning-postgres.test.js.
const GATES = ['GATE_SMS_VOICE_PROFILE_PIN', 'GATE_SMS_EDIT_LEARNING', 'GATE_SMS_REAL_ANSWERS', 'GATE_SMS_OFFERS_SCHEDULER',
  'GATE_SMS_AGENT_COMPLAINTS', 'GATE_SMS_AGENT_BILLING_DISPUTES', 'GATE_SMS_AGENT_CHEMICAL_MEDICAL', 'GATE_SMS_AGENT_LEGAL',
  'SHADOW_VOICE_PROFILE', 'SHADOW_FEWSHOT', 'SHADOW_DRAFT_VERIFY'];

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let saved;
beforeEach(() => {
  saved = GATES.map((k) => [k, process.env[k]]);
  GATES.forEach((k) => delete process.env[k]);
});
afterEach(() => {
  saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
});

// The kill switches (SHADOW_*) are read once at module load, so load a fresh copy under the env the test set.
function freshDrafter() {
  let drafter;
  jest.isolateModules(() => { drafter = require('../services/sms-shadow-drafter'); });
  return drafter;
}

describe('smsVoiceProfilePinVersion', () => {
  const { smsVoiceProfilePinVersion } = require('../config/feature-gates');
  test.each([
    [undefined, null], ['', null], ['  ', null], ['true', null], ['0', null], ['-3', null], ['5.5', null], ['v5', null],
    ['1234567890', null], ['5', 5], [' 12 ', 12], ['007', 7],
  ])('GATE_SMS_VOICE_PROFILE_PIN=%p reads as %p', (raw, expected) => {
    if (raw === undefined) delete process.env.GATE_SMS_VOICE_PROFILE_PIN; else process.env.GATE_SMS_VOICE_PROFILE_PIN = raw;
    expect(smsVoiceProfilePinVersion()).toBe(expected);
  });
});

describe('prompt version follows the pin and edit-learning gates', () => {
  test('both gates off: identities are exactly what they were before', () => {
    const d = freshDrafter();
    expect(d.currentPromptVersion()).toBe(d.PROMPT_VERSION);
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    expect(d.currentPromptVersion()).toBe(d.REAL_ANSWERS_PROMPT_VERSION);
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    expect(d.currentPromptVersion()).toBe(d.NEXT_OF_SERIES_PROMPT_VERSION);
  });

  test('a pin adds the v tag, edit learning the e tag, both sort together; real-answers on', () => {
    const d = freshDrafter();
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    process.env.GATE_SMS_VOICE_PROFILE_PIN = '4';
    expect(d.currentPromptVersion()).toBe(`${d.REAL_ANSWERS_PROMPT_VERSION}+v`);
    process.env.GATE_SMS_EDIT_LEARNING = 'true';
    expect(d.currentPromptVersion()).toBe(`${d.REAL_ANSWERS_PROMPT_VERSION}+ev`);
    delete process.env.GATE_SMS_VOICE_PROFILE_PIN;
    expect(d.currentPromptVersion()).toBe(`${d.REAL_ANSWERS_PROMPT_VERSION}+e`);
  });

  test('the identity follows the scheduler gate and the hand-off categories with the new tags', () => {
    const d = freshDrafter();
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    process.env.GATE_SMS_EDIT_LEARNING = 'true';
    process.env.GATE_SMS_AGENT_COMPLAINTS = 'true';
    expect(d.currentPromptVersion()).toBe(`${d.NEXT_OF_SERIES_PROMPT_VERSION}+ce`);
  });

  test('flip order never changes the identity (tags are sorted across categories and voice inputs)', () => {
    const d = freshDrafter();
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    process.env.GATE_SMS_AGENT_LEGAL = 'true';
    process.env.GATE_SMS_VOICE_PROFILE_PIN = '2';
    process.env.GATE_SMS_AGENT_BILLING_DISPUTES = 'true';
    const first = d.currentPromptVersion();
    GATES.forEach((k) => delete process.env[k]);
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    process.env.GATE_SMS_AGENT_BILLING_DISPUTES = 'true';
    process.env.GATE_SMS_VOICE_PROFILE_PIN = '2';
    process.env.GATE_SMS_AGENT_LEGAL = 'true';
    expect(d.currentPromptVersion()).toBe(first);
    expect(first).toBe(`${d.REAL_ANSWERS_PROMPT_VERSION}+blv`);
  });

  test('every gate on at once still fits the varchar(40) prompt_version columns', () => {
    const d = freshDrafter();
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    process.env.GATE_SMS_VOICE_PROFILE_PIN = '99';
    process.env.GATE_SMS_EDIT_LEARNING = 'true';
    for (const k of ['GATE_SMS_AGENT_COMPLAINTS', 'GATE_SMS_AGENT_BILLING_DISPUTES', 'GATE_SMS_AGENT_CHEMICAL_MEDICAL', 'GATE_SMS_AGENT_LEGAL']) process.env[k] = 'true';
    const v = d.currentPromptVersion();
    expect(v).toBe(`${d.NEXT_OF_SERIES_PROMPT_VERSION}+bcelmv`);
    expect(v.length).toBeLessThanOrEqual(40);
    expect(`${d.REAL_ANSWERS_PROMPT_VERSION}+bcelmv`.length).toBeLessThanOrEqual(40);
  });

  test('the bare v11 identity (real answers off) also follows the gates', () => {
    const d = freshDrafter();
    process.env.GATE_SMS_VOICE_PROFILE_PIN = '3';
    expect(d.currentPromptVersion()).toBe('house_voice_v11+v');
    process.env.GATE_SMS_EDIT_LEARNING = 'true';
    expect(d.currentPromptVersion()).toBe('house_voice_v11+ev');
  });

  test('the tag follows the input: no v with the profile kill switch off, no e when exemplars cannot reach the prompt', () => {
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    process.env.GATE_SMS_VOICE_PROFILE_PIN = '3';
    process.env.GATE_SMS_EDIT_LEARNING = 'true';
    process.env.SHADOW_VOICE_PROFILE = 'false';
    let d = freshDrafter();
    expect(d.currentPromptVersion()).toBe(`${d.REAL_ANSWERS_PROMPT_VERSION}+e`);
    delete process.env.SHADOW_VOICE_PROFILE;
    process.env.SHADOW_FEWSHOT = 'false';
    d = freshDrafter();
    expect(d.currentPromptVersion()).toBe(`${d.REAL_ANSWERS_PROMPT_VERSION}+v`);
    delete process.env.SHADOW_FEWSHOT;
    process.env.SHADOW_DRAFT_VERIFY = 'false';
    d = freshDrafter();
    expect(d.currentPromptVersion()).toBe(`${d.REAL_ANSWERS_PROMPT_VERSION}+v`);
  });

  test('sealed-eval reads the new tags as no fact marker: the contract is the same as the untagged identity', () => {
    const { requiredFactMarkers, forbiddenFactMarkers } = require('../services/sms-sealed-eval');
    const d = freshDrafter();
    const plain = d.REAL_ANSWERS_PROMPT_VERSION;
    expect(requiredFactMarkers(`${plain}+ev`)).toEqual(requiredFactMarkers(plain));
    expect(forbiddenFactMarkers(`${plain}+bcev`)).toEqual(forbiddenFactMarkers(`${plain}+bc`));
  });
});
