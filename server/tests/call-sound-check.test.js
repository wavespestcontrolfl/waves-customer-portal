// The call sound check's model call (services/call-sound-check.js `hear`) and the note kept from its answer: what is
// sent to the model, and what is stored. llm/call.js is mocked: no network, no spend.
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn(), rejectCall: jest.fn() }));

const MODELS = require('../config/models');
const llm = require('../services/llm/call');
const { hear, normalizeNote } = require('../services/call-sound-check');

const AUDIO = Buffer.from('fixture bytes, not a real recording');
const ANSWER = {
  no_conversation: false, caller_tone_start: 'worried', caller_tone_end: 'calm', caller_upset: false,
  talk_over_count: 1, agent_sounded_rushed: false, risky_claim: { flag: true, what: 'Said the spray is safe for pets.' },
};

beforeEach(() => jest.clearAllMocks());

describe('hear: one model call for one recording', () => {
  test('sends the recording as audio on the sound check route and returns the note', async () => {
    llm.dispatch.mockResolvedValue({ ok: true, json: ANSWER, model: 'listening-model' });
    const { result, note } = await hear(AUDIO);
    expect([result.ok, note]).toEqual([true, ANSWER]);
    const [route, payload] = llm.dispatch.mock.calls[0];
    expect(route).toBe(MODELS.ROUTES.callSoundCheck);
    expect(payload).toMatchObject({
      audio: [{ mimeType: 'audio/mpeg', data: AUDIO.toString('base64') }], jsonMode: true, thinkingLevel: 'LOW', laneId: 'call_sound_check',
    });
    // structured output: every object closed, every key required
    for (const schema of [payload.jsonSchema, payload.jsonSchema.properties.risky_claim]) {
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    }
    expect(llm.rejectCall).not.toHaveBeenCalled();
  });

  test('an answer in the wrong shape gives no note and marks that call rejected', async () => {
    const answer = { ok: true, json: { ...ANSWER, talk_over_count: 'twice' }, model: 'listening-model' };
    llm.dispatch.mockResolvedValue(answer);
    expect((await hear(AUDIO)).note).toBeNull();
    expect(llm.rejectCall).toHaveBeenCalledWith(answer, 'invalid_note');
  });

  test('a failed model call gives no note and its reason, with nothing to reject', async () => {
    llm.dispatch.mockResolvedValue({ ok: false, reason: 'gemini_503' });
    expect(await hear(AUDIO)).toEqual({ result: { ok: false, reason: 'gemini_503' }, note: null });
    expect(llm.rejectCall).not.toHaveBeenCalled();
  });
});

describe('the stored note', () => {
  test('keeps only the fields asked for; its free text is scrubbed of a card number and cut', () => {
    expect(normalizeNote({ ...ANSWER, transcript: 'every word', coach_note: 'slow down' })).toEqual(ANSWER);
    const note = normalizeNote({
      ...ANSWER, caller_tone_start: 'x'.repeat(100), talk_over_count: 500,
      risky_claim: { flag: true, what: `The card 4111 1111 1111 1111 was read back. ${'y'.repeat(400)}` },
    });
    expect(note.pan_scrubbed).toBe(true);
    expect(note.risky_claim.what).not.toMatch(/4111 1111/);
    expect([note.caller_tone_start.length, note.risky_claim.what.length, note.talk_over_count]).toEqual([40, 240, 99]);
    expect(normalizeNote({ ...ANSWER, risky_claim: { flag: false, what: 'left over text' } }).risky_claim).toEqual({ flag: false, what: null });
    expect(normalizeNote({ ...ANSWER, no_conversation: true })).toEqual({ no_conversation: true });
  });

  test.each([
    ['null', null], ['an array', []], ['text', 'calm'], ['no risky_claim', { ...ANSWER, risky_claim: undefined }],
    ['a count that is text', { ...ANSWER, talk_over_count: '2' }], ['a negative count', { ...ANSWER, talk_over_count: -1 }],
    ['a yes/no that is text', { ...ANSWER, caller_upset: 'no' }], ['a flag that is text', { ...ANSWER, risky_claim: { flag: 'no', what: null } }],
  ])('an answer that is %s gives no note', (_label, json) => {
    expect(normalizeNote(json)).toBeNull();
  });
});
