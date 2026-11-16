// The contact decoder's output cap reaches the Gemini request through the real
// dispatcher (llm/call.js). Gemini 2.5 Pro thinks before it answers, and the
// thinking shares maxOutputTokens with the JSON. With no cap from the caller the
// shared Gemini call sends 2048, and 10 of 33 decoder legs Nov 1-5 stopped
// there (finishReason MAX_TOKENS), so OpenAI answered them instead.
// No real API call: global.fetch is mocked. Synthetic transcript.
jest.mock('../services/llm-dispatch-metrics', () => ({
  recordCall: jest.fn(() => null),
  failCall: jest.fn(),
  recordDispatch: jest.fn(),
  recordedPolicyLabel: jest.fn((policy) => policy?.name || null),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true })) }));

const { decodeDictatedContacts } = require('../services/contact-dictation');

const TRANSCRIPT = 'Agent: And a good email? Caller: B-R-I-G-H-T-O-N at gmail dot com.';
const DECODED = {
  emails: [{ raw_spoken: 'B-R-I-G-H-T-O-N at gmail dot com', candidates: [{ value: 'brighton@gmail.com', confidence: 0.97 }] }],
  addresses: [],
  names: [],
};

const savedEnv = { ...process.env };
const savedFetch = global.fetch;
let fetchMock;

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.OPENAI_API_KEY = 'test-openai';
  delete process.env.GEMINI_CONTACT_DECODER_MODEL;
  fetchMock = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(DECODED) }] } }] }),
      };
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  global.fetch = fetchMock;
});
afterAll(() => {
  process.env = savedEnv;
  global.fetch = savedFetch;
});

test('the Gemini leg asks for 8192 output tokens, not the shared 2048 default', async () => {
  const out = await decodeDictatedContacts({ transcript: TRANSCRIPT });
  expect(out.emails[0].candidates[0].value).toBe('brighton@gmail.com');
  const gemini = fetchMock.mock.calls.filter(([u]) => String(u).includes('generativelanguage'));
  expect(gemini).toHaveLength(1);
  expect(String(gemini[0][0])).toContain('gemini-2.5-pro');
  const body = JSON.parse(gemini[0][1].body);
  expect(body.generationConfig.maxOutputTokens).toBe(8192);
  expect(body.generationConfig.temperature).toBe(0);
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes('api.openai.com'))).toBe(false);
});
