const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { fastStructured: 'fast-structured-policy' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn() }));

const { screenInboundSms, classifierMode } = require('../services/sms-solicitation-classifier');
const savedGate = process.env.GATE_SMS_SPAM_CLASSIFIER;
const PITCH = 'We have exclusive pest leads for you.';
const SOFT_PITCH = 'Our software team would like to speak with you about a partnership.';

beforeEach(() => { mockDispatch.mockReset(); process.env.GATE_SMS_SPAM_CLASSIFIER = 'shadow'; });
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_SMS_SPAM_CLASSIFIER;
  else process.env.GATE_SMS_SPAM_CLASSIFIER = savedGate;
});

test.each([undefined, '', 'false', 'on', 'true'])('gate %s is off; enforcement is unavailable', async (gate) => {
  if (gate === undefined) delete process.env.GATE_SMS_SPAM_CLASSIFIER;
  else process.env.GATE_SMS_SPAM_CLASSIFIER = gate;
  expect(classifierMode()).toBe('off');
  expect(await screenInboundSms({ body: PITCH })).toBeNull();
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('known senders, reactions, the AI line and empty messages bypass the classifier', async () => {
  for (const args of [{ hasCustomer: true }, { isReaction: true }, { isAiLine: true }, { body: ' ' }]) {
    expect(await screenInboundSms({ body: PITCH, ...args })).toBeNull();
  }
  expect(mockDispatch).not.toHaveBeenCalled();
});

test.each(['STOP', 'stop.', 'STOPP', 'REMOVE', 'OPT OUT', 'DO NOT TEXT', 'START', 'SUBSCRIBE', 'OPTIN', 'HELP', 'INFO'])('carrier command %s bypasses the classifier', async (body) => {
  expect(await screenInboundSms({ body })).toBeNull();
  expect(mockDispatch).not.toHaveBeenCalled();
});

test.each([PITCH, 'We can send you more pest-control leads.', 'We can provide you with more lawn leads.'])('a deterministic pitch records a shadow verdict without a model call: %s', async (body) => {
  expect(await screenInboundSms({ body })).toMatchObject({ solicitation: true, confidence: 1, method: 'regex', mode: 'shadow' });
  expect(mockDispatch).not.toHaveBeenCalled();
});

test.each([
  'Do you offer exclusive rates for new customers?',
  'Can I get unlimited estimates for my rental properties?',
  'We manage several rentals and can fill your schedule; please quote pest control',
  'Can you quote termite service? I can connect you with the property manager for access.',
  'Pest control service is being requested by the tenant; can you quote it?',
  'I have two leads for you: my neighbors both need pest control. Can you quote them?',
  'I have more lawn leads for you from my neighbors. Can you quote them?',
  'I can send you more pest-control leads from my neighbors. Can you quote them?',
  'We can provide you with more lawn leads from our neighbors who need service.',
])('ambiguous service requests reach the bounded model: %s', async (body) => {
  mockDispatch.mockResolvedValue({ ok: true, json: { solicitation: false, confidence: 0.97 } });
  expect(await screenInboundSms({ body })).toMatchObject({ solicitation: false, method: 'model', mode: 'shadow' });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledWith('fast-structured-policy', expect.objectContaining({
    laneId: 'sms_solicitation', jsonMode: true, timeoutMs: 3500,
  }));
});

test('model confidence is recorded without taking an enforcement action', async () => {
  mockDispatch.mockResolvedValue({ ok: true, json: { solicitation: true, confidence: 0.93 } });
  expect(await screenInboundSms({ body: SOFT_PITCH })).toEqual({
    solicitation: true, confidence: 0.93, method: 'model', mode: 'shadow', version: 'sms-solicitation-v1',
  });
});

test('failed or malformed model output remains non-actionable evidence', async () => {
  mockDispatch.mockResolvedValueOnce({ ok: false });
  expect(await screenInboundSms({ body: SOFT_PITCH })).toMatchObject({ solicitation: false, method: 'model_failed' });
  mockDispatch.mockRejectedValueOnce(new Error('timeout'));
  expect(await screenInboundSms({ body: SOFT_PITCH })).toMatchObject({ solicitation: false, method: 'model_failed' });
  mockDispatch.mockResolvedValueOnce({ ok: true, json: { solicitation: true, confidence: 'high' } });
  expect(await screenInboundSms({ body: SOFT_PITCH })).toMatchObject({ solicitation: true, confidence: 0, method: 'model' });
});
