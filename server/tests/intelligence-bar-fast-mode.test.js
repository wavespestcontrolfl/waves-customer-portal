/**
 * fast-mode.js (GATE_IB_FAST_MODE + INTELLIGENCE_BAR_EFFORT): which request the
 * Intelligence Bar sends, the one standard-speed retry, and the IB-only effort.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { createIbMessage, ibRequestedEffort, FAST_MODE_BETA } = require('../services/intelligence-bar/fast-mode');
const { anthropicEffortConfig } = require('../services/llm/anthropic-wire');
const MODELS = require('../config/models');
const FeatureGates = require('../config/feature-gates');

function client() {
  return {
    messages: { create: jest.fn(async () => ({ content: [], usage: {} })) },
    beta: { messages: { create: jest.fn(async () => ({ content: [], usage: { speed: 'fast' } })) } },
  };
}
const apiError = (status, message = '') => Object.assign(new Error(message), { status });
const params = (model = 'claude-opus-5-5') => ({
  model, max_tokens: 4096, system: [{ type: 'text', text: 's' }], tools: [], messages: [{ role: 'user', content: 'hi' }],
});

describe('createIbMessage', () => {
  const saved = process.env.GATE_IB_FAST_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_IB_FAST_MODE; else process.env.GATE_IB_FAST_MODE = saved;
    jest.clearAllMocks();
  });

  test('gate off: the plain create call with the same params and options', async () => {
    delete process.env.GATE_IB_FAST_MODE;
    const anthropic = client();
    const p = params();
    const options = { headers: { 'anthropic-beta': 'inline-tools-2026-09-15' } };
    await createIbMessage(anthropic, p, options);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(anthropic.messages.create.mock.calls[0][0]).toBe(p);
    expect(anthropic.messages.create.mock.calls[0][1]).toBe(options);
    expect(anthropic.beta.messages.create).not.toHaveBeenCalled();
  });

  test('gate set to anything but "true" stays off', async () => {
    process.env.GATE_IB_FAST_MODE = '1';
    const anthropic = client();
    await createIbMessage(anthropic, params());
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(anthropic.beta.messages.create).not.toHaveBeenCalled();
  });

  test('gate on + Opus 5.5: the beta call with speed fast and the fast-mode beta', async () => {
    process.env.GATE_IB_FAST_MODE = 'true';
    const anthropic = client();
    const p = params();
    const out = await createIbMessage(anthropic, p, undefined);
    expect(out.usage.speed).toBe('fast');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    const [body, options] = anthropic.beta.messages.create.mock.calls[0];
    expect(body).toEqual({ ...p, speed: 'fast', betas: [FAST_MODE_BETA] });
    expect(options).toBeUndefined();
    expect(p.speed).toBeUndefined(); // the caller's params are not mutated
  });

  test('gate on: a tool-additions beta header joins betas instead of replacing it', async () => {
    process.env.GATE_IB_FAST_MODE = 'true';
    const anthropic = client();
    await createIbMessage(anthropic, params(), { headers: { 'anthropic-beta': 'inline-tools-2026-09-15', 'x-other': '1' }, timeout: 5 });
    const [body, options] = anthropic.beta.messages.create.mock.calls[0];
    expect(body.betas).toEqual([FAST_MODE_BETA, 'inline-tools-2026-09-15']);
    expect(options).toEqual({ headers: { 'x-other': '1' }, timeout: 5 });
  });

  test.each(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-5', ''])('gate on + %j (no fast mode): the plain call', async (model) => {
    process.env.GATE_IB_FAST_MODE = 'true';
    const anthropic = client();
    const p = params(model);
    await createIbMessage(anthropic, p);
    expect(anthropic.messages.create).toHaveBeenCalledWith(p, undefined);
    expect(anthropic.beta.messages.create).not.toHaveBeenCalled();
  });

  test('429 on fast: one standard retry with today\'s exact request, and a log line', async () => {
    process.env.GATE_IB_FAST_MODE = 'true';
    const anthropic = client();
    anthropic.beta.messages.create.mockRejectedValueOnce(apiError(429, 'rate limited'));
    const p = params();
    const options = { headers: { 'anthropic-beta': 'inline-tools-2026-09-15' } };
    const out = await createIbMessage(anthropic, p, options);
    expect(out.usage).toEqual({});
    expect(anthropic.beta.messages.create).toHaveBeenCalledTimes(1);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(anthropic.messages.create.mock.calls[0][0]).toBe(p);
    expect(anthropic.messages.create.mock.calls[0][1]).toBe(options);
    expect(logger.warn).toHaveBeenCalledWith('[intelligence-bar] fast mode fell back to standard (429)');
  });

  test.each([
    ['fast mode is not supported for this model'], ['speed: fast is not enabled for your account'], ['Fast-mode beta not available'],
  ])('400 that rejects the speed (%s): one standard retry', async (message) => {
    process.env.GATE_IB_FAST_MODE = 'true';
    const anthropic = client();
    anthropic.beta.messages.create.mockRejectedValueOnce(apiError(400, message));
    await createIbMessage(anthropic, params());
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[intelligence-bar] fast mode fell back to standard (400)');
  });

  test.each([
    ['other 400', apiError(400, 'messages.3: tool_use ids must be unique')],
    ['credit 400', apiError(400, 'Your credit balance is too low to access the Anthropic API')],
    ['500', apiError(500, 'boom')],
    ['529', apiError(529, 'overloaded')],
    ['401', apiError(401, 'bad key')],
    ['connection error', Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })],
  ])('%s: rethrown as is, no retry', async (_label, err) => {
    process.env.GATE_IB_FAST_MODE = 'true';
    const anthropic = client();
    anthropic.beta.messages.create.mockRejectedValueOnce(err);
    await expect(createIbMessage(anthropic, params())).rejects.toBe(err);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('the standard retry failing propagates its own error', async () => {
    process.env.GATE_IB_FAST_MODE = 'true';
    const anthropic = client();
    const second = apiError(529, 'overloaded');
    anthropic.beta.messages.create.mockRejectedValueOnce(apiError(429));
    anthropic.messages.create.mockRejectedValueOnce(second);
    await expect(createIbMessage(anthropic, params())).rejects.toBe(second);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  });

  test('gate off: an error from the plain call propagates untouched', async () => {
    delete process.env.GATE_IB_FAST_MODE;
    const anthropic = client();
    const err = apiError(429);
    anthropic.messages.create.mockRejectedValueOnce(err);
    await expect(createIbMessage(anthropic, params())).rejects.toBe(err);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  });
});

describe('ibRequestedEffort', () => {
  test.each(['low', 'medium', 'high', 'xhigh', 'max'])('%s is accepted', (level) => {
    expect(ibRequestedEffort({ INTELLIGENCE_BAR_EFFORT: level })).toBe(level);
  });
  test('case and spaces are forgiven', () => {
    expect(ibRequestedEffort({ INTELLIGENCE_BAR_EFFORT: ' XHigh ' })).toBe('xhigh');
  });
  test.each([undefined, '', 'ultra', 'none', 'true'])('%j is ignored', (value) => {
    expect(ibRequestedEffort({ INTELLIGENCE_BAR_EFFORT: value })).toBeUndefined();
  });

  test('a valid level wins over the global pin on an effort-capable model; invalid keeps the pin', () => {
    const pinned = MODELS.ANTHROPIC_EFFORT;
    const effort = (requested) => (anthropicEffortConfig('claude-opus-5-5', requested).output_config || {}).effort;
    expect(effort(ibRequestedEffort({ INTELLIGENCE_BAR_EFFORT: 'low' }))).toBe('low');
    expect(effort(ibRequestedEffort({ INTELLIGENCE_BAR_EFFORT: 'bogus' }))).toBe(pinned);
  });
});

describe('gate + model registry', () => {
  test('ibFastModeLive is strict "true" and read at call time', () => {
    const saved = process.env.GATE_IB_FAST_MODE;
    delete process.env.GATE_IB_FAST_MODE;
    expect(FeatureGates.ibFastModeLive()).toBe(false);
    process.env.GATE_IB_FAST_MODE = 'false';
    expect(FeatureGates.ibFastModeLive()).toBe(false);
    process.env.GATE_IB_FAST_MODE = 'true';
    expect(FeatureGates.ibFastModeLive()).toBe(true);
    if (saved === undefined) delete process.env.GATE_IB_FAST_MODE; else process.env.GATE_IB_FAST_MODE = saved;
  });

  test('fast mode ids: Opus 5.5, Opus 5, Opus 4.8 only', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']) expect(MODELS.anthropicSupportsFastMode(id)).toBe(true);
    for (const id of ['claude-sonnet-5-5', 'claude-opus-4-7', 'claude-opus-5-5-preview', undefined, '']) expect(MODELS.anthropicSupportsFastMode(id)).toBe(false);
  });
});
