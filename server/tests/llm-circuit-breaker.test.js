'use strict';

const MODELS = require('../config/models');
const circuitBreaker = require('../services/llm/circuit-breaker');
const { classifyFailure } = require('../services/agent-control/taxonomy');

describe('llm/circuit-breaker', () => {
  const savedEnv = {
    GATE_LLM_CIRCUIT_BREAKER: process.env.GATE_LLM_CIRCUIT_BREAKER,
    LLM_CIRCUIT_FAILURE_THRESHOLD: process.env.LLM_CIRCUIT_FAILURE_THRESHOLD,
    LLM_CIRCUIT_WINDOW_MS: process.env.LLM_CIRCUIT_WINDOW_MS,
    LLM_CIRCUIT_COOLDOWN_MS: process.env.LLM_CIRCUIT_COOLDOWN_MS,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GATE_LLM_DISPATCH_METRICS: process.env.GATE_LLM_DISPATCH_METRICS,
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
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: 1020 })).toEqual({ allow: true, isProbe: false, probeId: null });
  });

  test('classifies only 429, 5xx, and provider timeouts as outage failures', () => {
    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_500')).toBe(true);
    expect(circuitBreaker.isProviderOutageReason('anthropic', 'anthropic_529')).toBe(true);
    expect(circuitBreaker.isProviderOutageReason('gemini', 'gemini_429')).toBe(true);
    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_timeout')).toBe(true);
    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_timeout', { legMs: 15_000 })).toBe(true);
    // Tight caller deadlines (e.g. Report Ask 5s cap) must not trip the global provider circuit.
    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_timeout', { legMs: 5_000 })).toBe(false);
    // Explicit 429/5xx provider errors still count even on a short leg.
    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_503', { legMs: 5_000 })).toBe(true);

    expect(circuitBreaker.isProviderOutageReason('openai', 'openai_400')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('anthropic', 'anthropic_401')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('anthropic', 'anthropic_refusal')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('openai', 'no_key')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('openai', 'empty_json')).toBe(false);
    expect(circuitBreaker.isProviderOutageReason('openai', 'anthropic_500')).toBe(false);
    expect(classifyFailure('circuit_open')).toBe('provider');
  });

  test('keeps in-window failures across ordinary successes until window expires', () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    process.env.LLM_CIRCUIT_WINDOW_MS = '60000';

    const t0 = 50_000;
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_503', now: t0 });
    circuitBreaker.afterAttempt('openai', { ok: true, now: t0 + 200 });
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_503', now: t0 + 500 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 600 })).toMatchObject({ allow: false, reason: 'circuit_open' });
  });

  test('opens after threshold outage failures in window, skips only when hasBackup=true, and only active probe settles recovery', () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '3';
    process.env.LLM_CIRCUIT_COOLDOWN_MS = '30000';

    const t0 = 100_000;
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_503', now: t0 });
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_timeout', now: t0 + 1000 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 1500 })).toEqual({ allow: true, isProbe: false, probeId: null });

    // Third failure opens the circuit.
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_429', now: t0 + 2000 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 3000 })).toMatchObject({ allow: false, reason: 'circuit_open' });
    // Never short-circuits when there is no backup route.
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: false, now: t0 + 3000 })).toEqual({ allow: true, isProbe: false, probeId: null });

    // An unrelated in-flight success (started pre-open or no-backup leg) during cooldown must NOT close the circuit.
    circuitBreaker.afterAttempt('openai', { ok: true, probeId: null, now: t0 + 4000 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 4500 })).toMatchObject({ allow: false, reason: 'circuit_open' });

    // After cooldown, exactly one probe is admitted; concurrent callers still skip.
    const probeAt = t0 + 2000 + 30_000;
    const probe1 = circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: probeAt });
    expect(probe1).toMatchObject({ allow: true, isProbe: true });
    expect(typeof probe1.probeId).toBe('number');
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: probeAt + 10 })).toMatchObject({ allow: false, reason: 'circuit_open' });

    // An unrelated completion while the probe is active must NOT settle or override the probe.
    circuitBreaker.afterAttempt('openai', { ok: true, probeId: null, now: probeAt + 15 });
    expect(circuitBreaker.getCircuitBreakerSnapshot(probeAt + 15).openai).toMatchObject({ state: 'half_open', probeInFlight: true });

    // Active probe failure re-opens immediately.
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_502', probeId: probe1.probeId, now: probeAt + 20 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: probeAt + 1000 })).toMatchObject({ allow: false, reason: 'circuit_open' });

    // Next cooldown elapsed -> active probe succeeds -> closes cleanly.
    const recoverAt = probeAt + 20 + 30_000;
    const probe2 = circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: recoverAt });
    expect(probe2).toMatchObject({ allow: true, isProbe: true });
    circuitBreaker.afterAttempt('openai', { ok: true, probeId: probe2.probeId, now: recoverAt + 50 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: recoverAt + 60 })).toEqual({ allow: true, isProbe: false, probeId: null });
    expect(circuitBreaker.getCircuitBreakerSnapshot(recoverAt + 60).openai).toMatchObject({ state: 'closed', recentFailures: 0 });
  });

  test('disabling the gate mid-probe still releases the probe slot so re-enabling can recover', () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    process.env.LLM_CIRCUIT_COOLDOWN_MS = '30000';

    const t0 = 200_000;
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_503', now: t0 });
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_503', now: t0 + 100 });
    const probe = circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 31_000 });
    expect(probe).toMatchObject({ allow: true, isProbe: true });

    // Gate turns off while probe is in flight; completion still clears activeProbeId.
    delete process.env.GATE_LLM_CIRCUIT_BREAKER;
    circuitBreaker.afterAttempt('openai', { ok: true, probeId: probe.probeId, now: t0 + 31_050 });

    // Re-enabling the gate admits a fresh recovery probe instead of staying wedged.
    process.env.GATE_LLM_CIRCUIT_BREAKER = 'true';
    const nextProbe = circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 31_100 });
    expect(nextProbe).toMatchObject({ allow: true, isProbe: true });
    expect(nextProbe.probeId).not.toBe(probe.probeId);
  });

  test('caller-aborted requests, short caller-budget timeouts, and 4xx errors never trip the circuit', () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_503', aborted: true, now: 10_000 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_503', aborted: true, now: 10_100 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_timeout', legMs: 5_000, now: 10_150 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_timeout', legMs: 5_000, now: 10_175 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_400', now: 10_200 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_refusal', now: 10_300 });
    expect(circuitBreaker.beforeAttempt('anthropic', { hasBackup: true, now: 10_400 })).toEqual({ allow: true, isProbe: false, probeId: null });
  });

  test('dispatchWithFallback skips open primary only when backup can serve the request, and never masks backup failure in metrics', async () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    process.env.GEMINI_API_KEY = 'test-gemini';
    process.env.GATE_LLM_DISPATCH_METRICS = 'true';

    jest.resetModules();
    const insertedRows = [];
    jest.doMock('../models/db', () => jest.fn(() => ({
      insert: async (row) => {
        insertedRows.push(row);
        return [1];
      },
    })));
    const mockAnthropicCreate = jest.fn().mockResolvedValue({
      id: 'msg_fallback',
      model: MODELS.WORKHORSE,
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
        primary: { provider: 'openai', model: MODELS.OPENAI_FAST },
        fallback: { provider: 'anthropic', model: MODELS.WORKHORSE },
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

      // When backup lacks credentials, primary is NOT skipped even while open.
      delete process.env.ANTHROPIC_API_KEY;
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_ok', status: 'completed', output_text: '{"ok":true}', usage: { input_tokens: 5, output_tokens: 5 } }),
      });
      const rNoKeyBackup = await llm.dispatchWithFallback(policy, { text: 'hi', jsonMode: true });
      expect(rNoKeyBackup.ok).toBe(true);
      expect(rNoKeyBackup.provider).toBe('openai');
      expect(global.fetch).toHaveBeenCalledTimes(3);

      // When backup cannot support the payload (Gemini does not support PDF documents), primary is NOT skipped.
      const pdfPolicy = {
        name: 'testPdfCircuit',
        primary: { provider: 'openai', model: MODELS.OPENAI_FAST },
        fallback: { provider: 'gemini', model: MODELS.GEMINI_FAST },
      };
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_pdf', status: 'completed', output_text: '{"ok":true}', usage: { input_tokens: 5, output_tokens: 5 } }),
      });
      const rPdf = await llm.dispatchWithFallback(pdfPolicy, {
        text: 'read pdf',
        documents: [{ mimeType: 'application/pdf', data: 'JVBERi0=' }],
        jsonMode: true,
      });
      expect(rPdf.ok).toBe(true);
      expect(rPdf.provider).toBe('openai');
      expect(global.fetch).toHaveBeenCalledTimes(4);

      // When primary is skipped (circuit_open) and backup fails with a timeout,
      // the dispatch row keeps circuit_open in failure_reasons AND classifies error_class from the backup's timeout.
      process.env.ANTHROPIC_API_KEY = 'test-anthropic';
      const timeoutErr = Object.assign(new Error('Request timed out'), { name: 'APIConnectionTimeoutError' });
      mockAnthropicCreate.mockRejectedValueOnce(timeoutErr);
      insertedRows.length = 0;
      const rBothFailed = await llm.dispatchWithFallback(policy, { text: 'hi', jsonMode: true });
      await new Promise((r) => setImmediate(r));
      expect(rBothFailed.ok).toBe(false);
      expect(rBothFailed.failures.map((f) => f.reason)).toEqual(['circuit_open', 'anthropic_timeout']);
      const chainRow = insertedRows.find((r) => r.row_kind === 'chain');
      expect(chainRow).toMatchObject({ ok: false, error_class: 'timeout' });
      expect(JSON.parse(chainRow.failure_reasons).map((f) => f.reason)).toEqual(['circuit_open', 'anthropic_timeout']);
    } finally {
      global.fetch = savedFetch;
      jest.dontMock('../models/db');
      jest.dontMock('@anthropic-ai/sdk');
      jest.resetModules();
    }
  });
});
