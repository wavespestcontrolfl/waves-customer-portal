// The call sound check's model call (services/call-sound-check.js `hear`) and the note kept from its answer: what is
// sent to the model, what comes back to the caller, and what is fit to store. llm/call.js is mocked: no network, no spend.
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn(), rejectCall: jest.fn() }));

const MODELS = require('../config/models');
const llm = require('../services/llm/call');
const { hear, normalizeNote } = require('../services/call-sound-check');

const AUDIO = Buffer.from('fixture bytes, not a real recording');
const ANSWER = {
  no_conversation: false, caller_tone_start: 'worried', caller_tone_end: 'calm', caller_upset: false,
  talk_over_count: 1, agent_sounded_rushed: false, risky_claim: { flag: true, what: 'Said the spray is safe for pets.' },
};
const USAGE = { input_tokens: 4000, output_tokens: 120, reasoning_tokens: 400 };
// What the adapter hands back for a good call: the parsed answer, its raw text, the model and the token counts.
const reply = (json) => ({ ok: true, json, text: JSON.stringify(json), model: 'asked-model', servedModel: 'served-model', usage: USAGE });

beforeEach(() => jest.clearAllMocks());

describe('hear: one model call for one recording', () => {
  test('sends the recording as audio on the sound check route and returns the note, the model and the token counts', async () => {
    llm.dispatch.mockResolvedValue(reply(ANSWER));
    expect(await hear(AUDIO)).toEqual({ note: ANSWER, reason: null, model: 'served-model', usage: USAGE });
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

  test('the raw reply never comes back: a card number the model repeated is only in the scrubbed note', async () => {
    const spoken = { ...ANSWER, risky_claim: { flag: true, what: 'Read the card 4111 1111 1111 1111 back to the caller.' }, transcript: 'card 4111 1111 1111 1111' };
    llm.dispatch.mockResolvedValue(reply(spoken));
    const heard = await hear(AUDIO);
    expect(Object.keys(heard).sort()).toEqual(['model', 'note', 'reason', 'usage']);
    expect(heard.note.pan_scrubbed).toBe(true);
    expect(JSON.stringify(heard)).not.toMatch(/4111|transcript/);
  });

  test('an answer in the wrong shape gives no note, marks that call rejected and still reports its token counts', async () => {
    const answer = reply({ ...ANSWER, talk_over_count: 'twice' });
    llm.dispatch.mockResolvedValue(answer);
    expect(await hear(AUDIO)).toEqual({ note: null, reason: 'invalid_note', model: 'served-model', usage: USAGE });
    expect(llm.rejectCall).toHaveBeenCalledWith(answer, 'invalid_note');
  });

  test.each([
    ['with the tokens it used', { ok: false, reason: 'gemini_incomplete', usage: USAGE }, { note: null, reason: 'gemini_incomplete', model: null, usage: USAGE }],
    ['that never reached the model', { ok: false, reason: 'no_key' }, { note: null, reason: 'no_key', model: null, usage: null }],
  ])('a failed model call %s gives no note and its reason, with nothing to reject', async (_label, failure, expected) => {
    llm.dispatch.mockResolvedValue(failure);
    expect(await hear(AUDIO)).toEqual(expected);
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

  test('a mood the model could not name stays empty', () => {
    expect(normalizeNote({ ...ANSWER, caller_tone_start: null, caller_tone_end: '  ' })).toEqual({ ...ANSWER, caller_tone_start: null, caller_tone_end: null });
  });

  test.each([
    ['null', null], ['an array', []], ['text', 'calm'], ['no risky_claim', { ...ANSWER, risky_claim: undefined }],
    ['a count that is text', { ...ANSWER, talk_over_count: '2' }], ['a negative count', { ...ANSWER, talk_over_count: -1 }],
    ['a yes/no that is text', { ...ANSWER, caller_upset: 'no' }], ['a flag that is text', { ...ANSWER, risky_claim: { flag: 'no', what: null } }],
    ['a mood that is a number', { ...ANSWER, caller_tone_end: 3 }], ['no mood key', { ...ANSWER, caller_tone_start: undefined }],
    ['a claim text that is a number', { ...ANSWER, risky_claim: { flag: false, what: 7 } }], ['no claim text key', { ...ANSWER, risky_claim: { flag: false } }],
    ['a flagged claim with no text', { ...ANSWER, risky_claim: { flag: true, what: null } }],
    ['a flagged claim with blank text', { ...ANSWER, risky_claim: { flag: true, what: '   ' } }],
  ])('an answer that is %s gives no note', (_label, json) => {
    expect(normalizeNote(json)).toBeNull();
  });
});
