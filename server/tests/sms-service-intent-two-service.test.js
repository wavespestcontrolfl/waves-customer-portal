// A lead reply that names BOTH services ("pest and lawn") is one request for both (owner 2026-11-19, "a"):
// classifyServiceIntent returns 'pest_lawn', so lead intake drafts one estimate naming both instead of
// stalling. Before this, the regex returned nothing for any reply with pest AND lawn words, and the model
// could only pick ONE service or "unknown" — 4 of 14 replies to the intake's service question stalled.
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { classifyServiceIntent } = require('../services/sms-service-intent');

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({ ok: true, json: { interest: 'unknown', confidence: 0.4 } });
});

describe('an explicit pest + lawn pair classifies as both, with no model call', () => {
  test.each([
    'Residential pest & lawn care',
    'Lawn and pest',
    'Lawn fertilization and pest control',
    'Pest and lawn, like on the form',
    'pest control, and lawn care',
    'Pest + lawn please',
    'pest/lawn',
  ])('%j => pest_lawn', async (body) => {
    await expect(classifyServiceIntent(body)).resolves.toEqual({ interest: 'pest_lawn', confidence: 0.9, method: 'regex' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('both keyword sets without an explicit pair still go to the model', () => {
  test.each([
    // One service, worded with words from both lists.
    ['I have got bugs in my yard', 'pest'],
    ['chinch bugs in the lawn', 'lawn'],
    // The lawn-line turf-pest product, not two services.
    ['Lawn pest control', 'lawn'],
  ])('%j => the model decides (%s)', async (body, modelInterest) => {
    mockDispatch.mockResolvedValue({ ok: true, json: { interest: modelInterest, confidence: 0.8 } });
    await expect(classifyServiceIntent(body)).resolves.toEqual({ interest: modelInterest, confidence: 0.8, method: 'ai' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('the model can answer pest_lawn for a looser two-service reply', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { interest: 'pest_lawn', confidence: 0.85 } });
    await expect(classifyServiceIntent('Need weed spraying for the yard first, mosquito spray second'))
      .resolves.toEqual({ interest: 'pest_lawn', confidence: 0.85, method: 'ai' });
    const [, request] = mockDispatch.mock.calls[0];
    expect(request.jsonSchema.properties.interest.enum).toEqual(['pest', 'lawn', 'pest_lawn', 'one_time', 'unknown']);
    expect(request.text).toContain('"pest_lawn" — BOTH recurring pest control AND lawn care');
  });

  test('"unknown" from the model is still no service', async () => {
    await expect(classifyServiceIntent('I have got bugs in my yard')).resolves.toEqual({ interest: null, confidence: 0.4, method: 'ai' });
  });
});

describe('unchanged single-service and one-time answers', () => {
  test.each([
    ['Lawn care', 'lawn'],
    ['quarterly pest control please', 'pest'],
    // An explicit cadence still wins over the pair.
    ['one-time pest and lawn', 'one_time'],
    // "lawnmower" is not the lawn service, so this is not a pair.
    ['pest and lawnmower repair', 'pest'],
  ])('%j => %s', async (body, interest) => {
    await expect(classifyServiceIntent(body)).resolves.toMatchObject({ interest, method: 'regex' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
