/**
 * Each web-search leg of the property lookup logs how long a SUCCESS took.
 *
 * The lookup waits for all three legs. A leg that fails logs its time; a
 * success of the OpenAI and Gemini legs logged nothing, so the wait those two
 * legs add could not be read from production logs (owner 2026-11-19: an 87 s
 * lookup, two legs at their 60 s limit). These tests pin the success line and
 * that it carries field names only: no value, no address.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { lookupPropertyFromOpenAI, lookupPropertyFromGemini } = require('../services/property-lookup/ai-property-lookup');

const ADDRESS = '120 Example Plaza Dr, Examplecity, FL 00000';
const FACTS = JSON.stringify({
  squareFootage: 2100, stories: 1, propertyType: 'Single Family', source: 'https://example.com/listing', confidence: 'medium',
});
const NO_FACTS = JSON.stringify({ source: null, confidence: 'low' });
const LEGS = [
  ['OpenAI', lookupPropertyFromOpenAI, (text) => ({ output_text: text })],
  ['Gemini', lookupPropertyFromGemini, (text) => ({ candidates: [{ content: { parts: [{ text }] } }] })],
];

const realFetch = global.fetch;
const realEnv = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(() => {
  global.fetch = realFetch;
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const successLine = (name) => logger.info.mock.calls.find(([message]) => message === `[ai-property] ${name} got facts`);

describe.each(LEGS)('%s web-search leg', (name, lookup, responseBody) => {
  test('a success logs its elapsed time and the names of the facts, nothing else about the property', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => responseBody(FACTS) }));

    const record = await lookup(ADDRESS);

    expect(record).toBeTruthy();
    const line = successLine(name);
    expect(line).toBeTruthy();
    expect(line[1]).toEqual({
      elapsedMs: expect.any(Number),
      confidence: 'medium',
      fields: expect.arrayContaining(['squareFootage', 'stories', 'propertyType']),
    });
    expect(JSON.stringify(line[1])).not.toMatch(/Example Plaza|2100|example\.com/);
  });

  test('a confidence that is not one of the three labels is not logged', async () => {
    const facts = JSON.stringify({ ...JSON.parse(FACTS), confidence: 'High: listing for 120 Example Plaza Dr matches' });
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => responseBody(facts) }));

    expect(await lookup(ADDRESS)).toBeTruthy();
    const line = successLine(name);
    expect(line[1].confidence).toBeNull();
    expect(JSON.stringify(line[1])).not.toMatch(/Example Plaza/i);
  });

  test('a reply with no usable facts keeps its own line and logs no success', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => responseBody(NO_FACTS) }));

    expect(await lookup(ADDRESS)).toBeNull();
    expect(successLine(name)).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(`[ai-property] ${name} found no usable facts`, expect.objectContaining({ elapsedMs: expect.any(Number) }));
  });
});
