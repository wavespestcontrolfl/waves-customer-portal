'use strict';

const circuitBreaker = require('../services/llm/circuit-breaker');

describe('llm/circuit-breaker', () => {
  const savedEnv = {
    GATE_LLM_CIRCUIT_BREAKER: process.env.GATE_LLM_CIRCUIT_BREAKER,
    LLM_CIRCUIT_FAILURE_THRESHOLD: process.env.LLM_CIRCUIT_FAILURE_THRESHOLD,
    LLM_CIRCUIT_WINDOW_MS: process.env.LLM_CIRCUIT_WINDOW_MS,
    LLM_CIRCUIT_COOLDOWN_MS: process.env.LLM_CIRCUIT_COOLDOWN_MS,
  };

  beforeEach(() => {
    circuitBreaker.resetCircuitBreakers();
    process.env.GATE_LLM_CIRCUIT_BREAKER = 'true';
    delete process.env.LLM_CIRCUIT_FAILURE_THRESHOLD;
    delete process.env.LLM_CIRCUIT_WINDOW_MS;
    delete process.env.LLM_CIRCUIT_COOLDOWN_MS;
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    circuitBreaker.resetCircuitBreakers();
  });

  test('is inert when GATE_LLM_CIRCUIT_BREAKER is not true', () => {
    delete process.env.GATE_LLM_CIRCUIT_BREAKER;
    for (let i = 0; i < 10; i += 1) {
      circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_503', now: 1000 + i });
    }
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: 1020 })).toEqual({ allow: true, isProbe: false });
  });

  test('classifies only 429, 5xx, and provider timeouts as outage failures', () => {
    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_500')).toBe(true);
    expect(circuitBreaker.isProviderOutageReason('anthropic', 'anthropic_529')).toBe(true);
    expect(circuitBreaker.isProviderOutageReason('gemini', 'gemini_429')).toBe(true);
    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_timeout')).toBe(true);

    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_400')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('anthropic', 'anthropic_401')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('anthropic', 'anthropic_refusal')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('openai', 'no_key')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('openai', 'empty_json')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('openai', 'anthropic_500')).toBe(false);
  });

  test('opens after threshold outage failures in window, skips only when hasBackup=true, and recovers via single half-open probe', () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '3';
    process.env.LLM_CIRCUIT_COOLDOWN_MS = '30000';

    const t0 = 100_000;
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_503', now: t0 });
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_timeout', now: t0 + 1000 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 1500 })).toEqual({ allow: true, isProbe: false });

    // Third failure opens the circuit.
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_429', now: t0 + 2000 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 3000 })).toEqual({ allow: false, reason: 'circuit_open' });
    // Never short-circuits when there is no backup route.
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: false, now: t0 + 3000 })).toEqual({ allow: true, isProbe: false });

    // After cooldown, exactly one probe is admitted; concurrent callers still skip.
    const probeAt = t0 + 2000 + 30_000;
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: probeAt })).toEqual({ allow: true, isProbe: true });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: probeAt + 10 })).toEqual({ allow: false, reason: 'circuit_open' });

    // Probe failure re-opens immediately.
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_502', isProbe: true, now: probeAt + 20 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: probeAt + 1000 })).toEqual({ allow: false, reason: 'circuit_open' });

    // Next cooldown elapsed -> probe succeeds -> closes cleanly.
    const recoverAt = probeAt + 20 + 30_000;
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: recoverAt })).toEqual({ allow: true, isProbe: true });
    circuitBreaker.afterAttempt('openai', { ok: true, isProbe: true, now: recoverAt + 50 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: recoverAt + 60 })).toEqual({ allow: true, isProbe: false });
    expect(circuitBreaker.getCircuitBreakerSnapshot(recoverAt + 60).openai).toMatchObject({ state: 'closed', recentFailures: 0 });
  });

  test('caller-aborted requests and 4xx errors never trip the circuit', () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_503', aborted: true, now: 10_000 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_503', aborted: true, now: 10_100 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_400', now: 10_200 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_refusal', now: 10_300 });
    expect(circuitBreaker.beforeAttempt('anthropic', { hasBackup: true, now: 10_400 })).toEqual({ allow: true, isProbe: false });
  });

  test('dispatchWithFallback skips open primary immediately and falls back to secondary', async () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';

    jest.resetModules();
    const mockAnthropicCreate = jest.fn().mockResolvedValue({
      id: 'msg_fallback',
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    jest.doMock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
      messages: { create: mockAnthropicCreate },
    })));

    const savedFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'down' }));
    try {
      const llm = require('../services/llm/call');
      const cb = require('../services/llm/circuit-breaker');
      cb.resetCircuitBreakers();
      const policy = {
        name: 'testCircuit',
        primary: { provider: 'openai', model: 'gpt-5-mini' },
        fallback: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      };

      // Calls 1 & 2 hit OpenAI (503) and fail over to Anthropic, tripping the OpenAI circuit.
      const r1 = await llm.dispatchWithFallback(policy, { text: 'hi', jsonMode: true });
      const r2 = await llm.dispatchWithFallback(policy, { text: 'hi', jsonMode: true });
      expect(r1.ok && r1.fallbackUsed).toBe(true);
      expect(r2.ok && r2.fallbackUsed).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // Call 3 skips OpenAI immediately without calling fetch at all.
      const r3 = await llm.dispatchWithFallback(policy, { text: 'hi', jsonMode: true });
      expect(r3.ok).toBe(true);
      expect(r3.fallbackUsed).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(r3.failures[0]).toMatchObject({ provider: 'openai', reason: 'circuit_open' });
    } finally {
      global.fetch = savedFetch;
      jest.resetModules();
    }
  });
});
