// A lead reply that names BOTH services ("pest and lawn") is one request for both (owner 2026-11-19, "a"):
// classifyServiceIntent returns 'pest_lawn', so lead intake drafts one estimate naming both instead of
// stalling. Before this, the regex returned nothing for any reply with pest AND lawn words, and the model
// could only pick ONE service or "unknown" — 4 of 14 replies to the intake's service question stalled.
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { classifyServiceIntent } = require('../services/sms-service-intent');
const { SERVICE_TAIL_RE } = require('../services/service-pair-terms');

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({ ok: true, json: { interest: 'unknown', confidence: 0.4 } });
});

// Replies that are a pair request: the classifier's fast path takes each one,
// and the address tail drops each one whole (the last describe).
const PAIR_REPLIES = [
  'Residential pest & lawn care',
  'Lawn and pest',
  'Lawn fertilization and pest control',
  'Pest and lawn, like on the form',
  'pest control, and lawn care',
  'Pest + lawn please',
  'pest/lawn',
  // Polite filler and a form reference around the pair.
  'Pest and lawn as per form I filled out',
  'Both pest and lawn',
  "I'd like pest and lawn.",
  'I’d like pest and lawn',
  'pest&lawn',
  'Pest , and lawn',
  'Pest and lawn services, like on the form',
];

describe('a reply that is the pest + lawn pair classifies as both, with no model call', () => {
  test.each(PAIR_REPLIES)('%j => pest_lawn', async (body) => {
    await expect(classifyServiceIntent(body)).resolves.toEqual({ interest: 'pest_lawn', confidence: 0.9, method: 'regex' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('a pair inside other words, or both keyword sets without a pair, goes to the model', () => {
  test.each([
    // The pair inside a longer reply: only the context tells the request.
    ['I already have pest and lawn care. I only need mosquitoes.', 'pest'],
    ['100 Palm Ave, pest and lawn', 'pest_lawn'],
    // A question goes to the model too, and so does an emoji (it can mean "no").
    ['pest and lawn? how much', 'pest_lawn'],
    ['pest and lawn 👍', 'pest_lawn'],
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

  test('words in another script stay in the reply, so the model reads them (不要 = "don\'t want")', async () => {
    await expect(classifyServiceIntent('不要 pest and lawn')).resolves.toEqual({ interest: null, confidence: 0.4, method: 'ai' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
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

describe('a long reply cannot stall the event loop', () => {
  test('a pair followed by many filler words and a stray word is read at once and goes to the model', async () => {
    // Before, each separator had two ways to match and the regex tried them
    // all: this 147-character reply took several seconds.
    const body = `pest and lawn${' please both'.repeat(11)} x`;
    const startedAt = Date.now();
    await classifyServiceIntent(body);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('the shared address-tail pattern drops the whole pair request, and single-service tails as before', () => {
  const strip = (address) => {
    let out = address;
    while (SERVICE_TAIL_RE.test(out)) out = out.replace(SERVICE_TAIL_RE, '').replace(/[,\s]+$/, '').trim();
    return out;
  };
  test.each([
    ['123 Main St, pest and lawn', '123 Main St'],
    ['123 Main St, lawn fertilization and pest control', '123 Main St'],
    ['123 Main St, pest and lawn services', '123 Main St'],
    ['123 Main St, both pest and lawn', '123 Main St'],
    ['123 Main St, pest and lawn per the form', '123 Main St'],
    ['123 Main St, Sarasota, quarterly pest & lawn care', '123 Main St, Sarasota'],
    ['100 Palm Ave, Venice FL 34285, lawn/pest', '100 Palm Ave, Venice FL 34285'],
    ['123 Main St, pest control', '123 Main St'],
    ['123 Main St, pest service', '123 Main St'],
    ['45 Lawn Ave', '45 Lawn Ave'],
  ])('%j => %j', (address, street) => {
    expect(strip(address)).toBe(street);
  });

  test.each(PAIR_REPLIES)('a street line, then the fast-path reply %j: the street line keeps none of the reply', (reply) => {
    // Both address readers cut the text at its first clause end before the strip.
    expect(strip(`123 Main St, ${reply}`.split(/[.;!?\n]/)[0])).toBe('123 Main St');
  });

  test('a long run of commas or spaces is tried once, not from each of its characters', () => {
    // Before the lookbehind, 12,800 commas took about 4 s and 25,600 spaces about 1 s.
    const startedAt = Date.now();
    expect(strip(`1 Main St${', '.repeat(12800)}x`)).toMatch(/x$/);
    expect(strip(`1 Main St, pest and lawn${' '.repeat(25600)}x`)).toMatch(/x$/);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});

