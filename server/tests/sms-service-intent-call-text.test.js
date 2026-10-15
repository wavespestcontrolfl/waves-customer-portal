// A bare CALL / TEXT reply to the lead auto-reply names no service: the parser
// matches it strictly, and classifyServiceIntent never classifies it (no regex
// hit, no paid model call), whatever the model would say and whatever the gate.
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { parseCallTextReply, classifyServiceIntent } = require('../services/sms-service-intent');

beforeEach(() => {
  mockDispatch.mockReset();
  // A model that WOULD classify a real service if it were asked.
  mockDispatch.mockResolvedValue({ ok: true, json: { interest: 'pest', confidence: 0.9 } });
});

describe('parseCallTextReply', () => {
  test.each([
    ['call', 'call'], ['CALL', 'call'], ['Call.', 'call'], ['  call me  ', 'call'],
    ['Please call!', 'call'], ['call please', 'call'], ['"Call"', 'call'], ['call   me', 'call'],
    ['text', 'text'], ['TEXT', 'text'], ['Text me', 'text'], ['text please', 'text'], ['Please text', 'text'], ['please text.', 'text'],
    ['Texting', 'text'], ['txt', 'text'], ['Text!!', 'text'],
  ])('%j => %s', (input, expected) => {
    expect(parseCallTextReply(input)).toBe(expected);
  });

  test.each([
    'call me after 5', 'ants in kitchen', 'text me the quote', 'please call me tomorrow',
    'call or text', 'please text me tomorrow', 'no call', 'do not text', '', '   ', '...', 'recall', 'context', '100 Palm Ave',
    null, undefined, 42, {},
  ])('%j => null', (input) => {
    expect(parseCallTextReply(input)).toBeNull();
  });
});


describe('classifyServiceIntent', () => {
  test.each(['CALL', 'call', 'Call me', 'please call', 'TEXT', 'text me', 'Please text', 'txt'])(
    '%j classifies as no service and never reaches the model',
    async (body) => {
      await expect(classifyServiceIntent(body)).resolves.toEqual({ interest: null, confidence: 0, method: 'none' });
      expect(mockDispatch).not.toHaveBeenCalled();
    },
  );

  test('a real service reply still classifies (model path unchanged)', async () => {
    await expect(classifyServiceIntent('I keep seeing something odd by the garage')).resolves.toMatchObject({ interest: 'pest', method: 'ai' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('a longer reply that starts with call still goes to the classifier', async () => {
    await classifyServiceIntent('call me about ants');
    // regex hit or model call; either way it is not short-circuited as a bare choice
    expect(parseCallTextReply('call me about ants')).toBeNull();
  });
});
