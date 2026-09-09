// SMS solicitation classifier: dark by default, shadow records only, enforce
// needs a regex hit or a confident model verdict, and nothing is ever sent.
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { fastStructured: 'fast-structured-policy' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  screenInboundSms, classifySolicitation, classifierMode, isSolicitationPitch, ENFORCE_CONFIDENCE,
} = require('../services/sms-solicitation-classifier');

// Synthetic texts in the shape of the 2026-09 audit corpus (vocabulary only).
const PITCH = 'Hey Waves, our holiday deal for home-service leads gets you a free setup, no monthly cost, and we fund your ads.';
const SOFT_PITCH = "Hi, this is a rep from a software company. I wasn't able to reach anyone when I called earlier, so I thought I'd send a quick message instead.";
const HOMEOWNER = 'Hi - do you provide organic options to keep the bugs under control in my yard? It is a small front and side yard.';

beforeEach(() => { mockDispatch.mockReset(); delete process.env.GATE_SMS_SPAM_CLASSIFIER; });

describe('gate', () => {
  test('unset, empty, and unknown values are off', () => {
    expect(classifierMode()).toBe('off');
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'on';
    expect(classifierMode()).toBe('off');
  });
  test('off: nothing runs, nothing returned', async () => {
    expect(await screenInboundSms({ body: PITCH, hasCustomer: false, isReaction: false })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
  test('a known sender, a reaction, the AI line, a bare carrier command, or an empty body is never screened', async () => {
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    expect(await screenInboundSms({ body: PITCH, hasCustomer: true, isReaction: false })).toBeNull();
    expect(await screenInboundSms({ body: 'Liked "…"', hasCustomer: false, isReaction: true })).toBeNull();
    expect(await screenInboundSms({ body: PITCH, hasCustomer: false, isReaction: false, isAiLine: true })).toBeNull();
    for (const cmd of ['STOP', 'stop.', ' Start ', 'HELP', 'Yes', 'unsubscribe', 'REMOVE', 'OPT OUT', 'do not text', 'SUBSCRIBE', 'optin']) {
      expect(await screenInboundSms({ body: cmd, hasCustomer: false, isReaction: false })).toBeNull();
    }
    expect(await screenInboundSms({ body: '  ', hasCustomer: false, isReaction: false })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('regex layer', () => {
  test.each([
    'Pest control service is being requested by the tenant; can you quote it?',
    'Can I get more estimates for my other rentals?',
    'Can you quote termite service? I can connect you with the property manager for access.',
    'Your AI receptionist said you would send me a quote for termite treatment.',
    'I tried to request an estimate but the link leads to your home page.',
    'Can you handle more lawn jobs at my rentals? Would you like more details?',
    'Can I get termite service with no upfront cost? Reply NO if you cannot do that.',
    'Do you offer exclusive rates for new customers?',
    'Can I get unlimited estimates for my rental properties?',
    'Do qualified customers get a discount on pest control?',
  ])('a customer request reaches the model and remains actionable: %s', async (body) => {
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    mockDispatch.mockResolvedValue({ ok: true, json: { solicitation: false, confidence: 0.97 } });
    expect(await screenInboundSms({ body, hasCustomer: false, isReaction: false }))
      .toMatchObject({ solicitation: false, method: 'model', enforced: false });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
  test('explicit vendor phrasing is a verdict without a model call', async () => {
    const v = await classifySolicitation({ body: PITCH });
    expect(v).toMatchObject({ solicitation: true, confidence: 1, method: 'regex' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
  test('a pitch with a natural-language stop footer is still screened (not a carrier command)', async () => {
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    const v = await screenInboundSms({ body: 'Are you open to more booked jobs? Reply "NO" if you need me to stop texting', hasCustomer: false, isReaction: false });
    expect(v).toMatchObject({ solicitation: true, method: 'regex', enforced: true });
  });
  test('a homeowner ask that shares vocabulary does not match; a single weak marker is not a pitch', () => {
    expect(isSolicitationPitch('Can you give me a free estimate on lawn treatment for my new house?')).toBe(false);
    expect(isSolicitationPitch('How much do you charge for a monthly pest plan? No contract preferred.')).toBe(false);
    expect(isSolicitationPitch(HOMEOWNER)).toBe(false);
    expect(isSolicitationPitch('I have termites at my new house. Would you like more details?')).toBe(false);
    expect(isSolicitationPitch('I need pest control Tuesday; reply NO if you cannot make it.')).toBe(false);
    expect(isSolicitationPitch('Can I get termite service with no upfront cost?')).toBe(false);
    expect(isSolicitationPitch('Our network offers exclusive lawn jobs.')).toBe(false);
    expect(isSolicitationPitch('We provide unlimited estimates for contractors.')).toBe(false);
    expect(isSolicitationPitch('Our network offers exclusive lawn jobs. Reply NO to opt out.')).toBe(true);
    expect(isSolicitationPitch('$0 upfront cost for our marketing package. Want more details?')).toBe(true);
  });
});

describe('model layer', () => {
  test('a confident solicitation verdict enforces only in enforce mode', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { solicitation: true, confidence: 0.93 } });
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'shadow';
    const shadow = await screenInboundSms({ body: SOFT_PITCH, hasCustomer: false, isReaction: false });
    expect(shadow).toMatchObject({ solicitation: true, method: 'model', mode: 'shadow', confident: true, enforced: false });
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    const enforce = await screenInboundSms({ body: SOFT_PITCH, hasCustomer: false, isReaction: false });
    expect(enforce).toMatchObject({ mode: 'enforce', confident: true, enforced: true });
    expect(mockDispatch).toHaveBeenCalledWith('fast-structured-policy', expect.objectContaining({
      laneId: 'sms_solicitation', jsonMode: true, timeoutMs: 3500,
    }));
  });
  test('below the confidence floor nothing is enforced', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { solicitation: true, confidence: ENFORCE_CONFIDENCE - 0.05 } });
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    const v = await screenInboundSms({ body: SOFT_PITCH, hasCustomer: false, isReaction: false });
    expect(v).toMatchObject({ solicitation: true, confident: false, enforced: false });
  });
  test('a homeowner verdict is recorded as not a solicitation', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { solicitation: false, confidence: 0.97 } });
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    const v = await screenInboundSms({ body: HOMEOWNER, hasCustomer: false, isReaction: false });
    expect(v).toMatchObject({ solicitation: false, enforced: false });
  });
  test('model failure, timeout, or malformed output fails to not-spam', async () => {
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    mockDispatch.mockResolvedValueOnce({ ok: false });
    expect(await screenInboundSms({ body: SOFT_PITCH, hasCustomer: false, isReaction: false })).toMatchObject({ solicitation: false, method: 'model_failed', enforced: false });
    mockDispatch.mockRejectedValueOnce(new Error('timeout'));
    expect(await screenInboundSms({ body: SOFT_PITCH, hasCustomer: false, isReaction: false })).toMatchObject({ solicitation: false, method: 'model_failed', enforced: false });
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { solicitation: true, confidence: 'high' } });
    expect(await screenInboundSms({ body: SOFT_PITCH, hasCustomer: false, isReaction: false })).toMatchObject({ solicitation: true, confidence: 0, enforced: false });
  });
});
