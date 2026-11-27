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
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: 1020 })).toEqual({ allow: true, isProbe: false, probeId: null, generation: null, disabled: true });
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

    // Lawn assessment eval excludes circuit_open skips from billed legs so backup usage still prices cleanly.
    const evalLib = require('../services/eval/lawn-visit-assessment-eval');
    const analysis = {
      status: 'complete',
      provider: 'openai',
      model: 'gpt-6-sol',
      usage: { input_tokens: 1000, output_tokens: 500, reasoning_tokens: 0 },
      failures: [{ provider: 'gemini', model: 'gemini-3.8-flash', reason: 'circuit_open' }],
    };
    const legs = evalLib.billedLegs(analysis);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ model: 'gpt-6-sol' });
    expect(evalLib.legsCostUsd(legs)).toBeGreaterThan(0);
    expect(evalLib.unpricedLegCount(legs)).toBe(0);

    // Daily digest distinguishes circuit-skipped failures from unconfigured single-leg policies and both-provider failures.
    const metrics = require('../services/llm-dispatch-metrics');
    const exCircuit = metrics.detectExceptions([{ policy: 'customerCopy', total: 10, fallbacks: 0, failed: 2, singleLeg: false, circuitSkippedFailed: 1 }], []);
    expect(exCircuit[0].detail).toContain('1 skipped primary via open circuit and failed on backup');
    expect(exCircuit[0].detail).not.toContain('no fallback configured');
    expect(exCircuit[0].detail).not.toContain('BOTH providers');
    const exSingle = metrics.detectExceptions([{ policy: 'smsShadow:anthropic:sealed', total: 10, fallbacks: 0, failed: 2, singleLeg: true, circuitSkippedFailed: 0 }], []);
    expect(exSingle[0].detail).toContain('no fallback configured');
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
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 1500 })).toEqual({ allow: true, isProbe: false, probeId: null, generation: 0 });

    // Third failure opens the circuit.
    circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_429', now: t0 + 2000 });
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: t0 + 3000 })).toMatchObject({ allow: false, reason: 'circuit_open' });
    // Never short-circuits when there is no backup route.
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: false, now: t0 + 3000 })).toEqual({ allow: true, isProbe: false, probeId: null, generation: 0 });

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
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: recoverAt + 60 })).toEqual({ allow: true, isProbe: false, probeId: null, generation: 1 });
    expect(circuitBreaker.getCircuitBreakerSnapshot(recoverAt + 60).openai).toMatchObject({ state: 'closed', recentFailures: 0 });

    // Stale pre-recovery completions (generation 0) arriving after recovery must NOT reopen the circuit.
    for (let i = 0; i < 5; i += 1) {
      circuitBreaker.afterAttempt('openai', { ok: false, reason: 'openai_timeout', generation: 0, now: recoverAt + 70 + i });
    }
    expect(circuitBreaker.beforeAttempt('openai', { hasBackup: true, now: recoverAt + 100 })).toEqual({ allow: true, isProbe: false, probeId: null, generation: 1 });

    // A mandatory final leg (hasBackup=false) still claims a free probe after cooldown so a failing backup re-opens.
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529', now: 400_000 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529', now: 400_100 });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529', now: 400_200 });
    expect(circuitBreaker.isAvailable('anthropic', { now: 405_000 })).toBe(false);
    expect(circuitBreaker.isAvailable('anthropic', { now: 431_000 })).toBe(true);
    const finalLegProbe = circuitBreaker.beforeAttempt('anthropic', { hasBackup: false, now: 431_000 });
    expect(finalLegProbe).toMatchObject({ allow: true, isProbe: true });
    circuitBreaker.afterAttempt('anthropic', { ok: false, reason: 'anthropic_503', probeId: finalLegProbe.probeId, now: 431_050 });
    expect(circuitBreaker.isAvailable('anthropic', { now: 435_000 })).toBe(false);
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
    expect(circuitBreaker.beforeAttempt('anthropic', { hasBackup: true, now: 10_400 })).toEqual({ allow: true, isProbe: false, probeId: null, generation: 0 });
  });

  test('when both primary and backup circuits are open, preserves primary-first ordering without claiming backup probe', async () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    process.env.LLM_CIRCUIT_COOLDOWN_MS = '30000';
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';

    jest.resetModules();
    const mockAnthropicCreate = jest.fn().mockRejectedValue(Object.assign(new Error('529'), { status: 529 }));
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
        name: 'testBothOpen',
        primary: { provider: 'openai', model: MODELS.OPENAI_FAST },
        fallback: { provider: 'anthropic', model: MODELS.WORKHORSE },
      };

      // Trip both primary (openai) and backup (anthropic) circuits.
      cb.afterAttempt('openai', { ok: false, reason: 'openai_503' });
      cb.afterAttempt('openai', { ok: false, reason: 'openai_503' });
      cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529' });
      cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529' });
      expect(cb.isAvailable('openai')).toBe(false);
      expect(cb.isAvailable('anthropic')).toBe(false);

      // Because backup is also cooling down, primary is NOT skipped (primary-first ordering preserved).
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_prim_recovered', status: 'completed', output_text: '{"ok":true}', usage: { input_tokens: 5, output_tokens: 5 } }),
      });
      const res = await llm.dispatchWithFallback(policy, { text: 'hi', jsonMode: true });
      expect(res.ok).toBe(true);
      expect(res.provider).toBe('openai');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mockAnthropicCreate).not.toHaveBeenCalled();

      // Concurrent chains when primary is cooling down and backup has one free probe:
      // only the first chain atomically reserves the backup probe and skips primary;
      // the second chain sees the probe claimed and keeps primary-first ordering.
      cb.resetCircuitBreakers();
      const now = Date.now();
      cb.afterAttempt('openai', { ok: false, reason: 'openai_503', now: now - 1_000 });
      cb.afterAttempt('openai', { ok: false, reason: 'openai_503', now: now - 500 });
      cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529', now: now - 35_000 });
      cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529', now: now - 34_000 });

      let releaseBackup;
      const backupBlocked = new Promise((resolve) => { releaseBackup = resolve; });
      mockAnthropicCreate.mockImplementationOnce(async () => {
        await backupBlocked;
        return {
          id: 'msg_probe',
          model: MODELS.WORKHORSE,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      });
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_prim_second', status: 'completed', output_text: '{"ok":true}', usage: { input_tokens: 5, output_tokens: 5 } }),
      });

      const firstPromise = llm.dispatchWithFallback(policy, { text: 'first', jsonMode: true });
      const secondPromise = llm.dispatchWithFallback(policy, { text: 'second', jsonMode: true });
      const secondRes = await secondPromise;
      expect(secondRes.ok).toBe(true);
      expect(secondRes.provider).toBe('openai');
      releaseBackup();
      const firstRes = await firstPromise;
      expect(firstRes.ok).toBe(true);
      expect(firstRes.provider).toBe('anthropic');
      expect(firstRes.failures[0]).toMatchObject({ provider: 'openai', reason: 'circuit_open' });

      // A primary route missing its provider must still fall back to secondary (never throw on empty reservation).
      delete process.env.GATE_LLM_CIRCUIT_BREAKER;
      mockAnthropicCreate.mockResolvedValueOnce({
        id: 'msg_fallback_missing_provider',
        model: MODELS.WORKHORSE,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const rMissingProvider = await llm.dispatchWithFallback({
        name: 'testMissingProvider',
        primary: { model: MODELS.OPENAI_FAST },
        fallback: { provider: 'anthropic', model: MODELS.WORKHORSE },
      }, { text: 'hi', jsonMode: true });
      expect(rMissingProvider.ok).toBe(true);
      expect(rMissingProvider.provider).toBe('anthropic');
      expect(rMissingProvider.failures[0]).toMatchObject({ reason: 'no_route' });
    } finally {
      global.fetch = savedFetch;
      jest.dontMock('@anthropic-ai/sdk');
      jest.resetModules();
    }
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
        fallback: { provider: 'gemini', model: MODELS.GEMINI_VISION_BEST },
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

      // Text-only backup model (gpt-6-luna lacks 'vision' cap) cannot serve image payloads, so open Gemini primary is NOT skipped.
      cb.afterAttempt('gemini', { ok: false, reason: 'gemini_503' });
      cb.afterAttempt('gemini', { ok: false, reason: 'gemini_503' });
      const textOnlyBackupPolicy = {
        name: 'testVisionCapCircuit',
        primary: { provider: 'gemini', model: MODELS.GEMINI_VISION_BEST },
        fallback: { provider: 'openai', model: 'gpt-6-luna' },
      };
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
      });
      const rImg = await llm.dispatchWithFallback(textOnlyBackupPolicy, {
        text: 'inspect photo',
        images: [{ mimeType: 'image/jpeg', data: 'AA==' }],
        jsonMode: true,
      });
      expect(rImg.ok).toBe(true);
      expect(rImg.provider).toBe('gemini');
      expect(global.fetch).toHaveBeenCalledTimes(5);

      // Unknown backup model ID (no affirmative MODEL_CATALOG capability evidence) and
      // text-only backup for PDF documents do NOT qualify to skip an open primary.
      process.env.ANTHROPIC_API_KEY = 'test-anthropic';
      const unknownBackupPolicy = {
        name: 'testUnknownBackupCircuit',
        primary: { provider: 'openai', model: MODELS.OPENAI_FAST },
        fallback: { provider: 'anthropic', model: 'unlisted-typo-model' },
      };
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_unknown_backup', status: 'completed', output_text: '{"ok":true}', usage: { input_tokens: 5, output_tokens: 5 } }),
      });
      const rUnknownBackup = await llm.dispatchWithFallback(unknownBackupPolicy, { text: 'hi', jsonMode: true });
      expect(rUnknownBackup.ok).toBe(true);
      expect(rUnknownBackup.provider).toBe('openai');
      expect(global.fetch).toHaveBeenCalledTimes(6);

      // Text-only backup model (gpt-6-luna) also cannot serve PDF documents.
      cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529' });
      cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529' });
      const pdfTextOnlyPolicy = {
        name: 'testPdfTextOnlyBackup',
        primary: { provider: 'anthropic', model: MODELS.WORKHORSE },
        fallback: { provider: 'openai', model: 'gpt-6-luna' },
      };
      const rPdfTextOnly = await llm.dispatchWithFallback(pdfTextOnlyPolicy, {
        text: 'read pdf',
        documents: [{ mimeType: 'application/pdf', data: 'JVBERi0=' }],
        jsonMode: true,
      });
      expect(rPdfTextOnly.ok).toBe(true);
      expect(rPdfTextOnly.provider).toBe('anthropic');
      cb.resetCircuitBreakers();

      // When payload requires tools (Anthropic-only in dispatch()), OpenAI backup is closed/healthy
      // yet still cannot serve tools, so Anthropic primary is NOT skipped.
      cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529' });
      cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_529' });
      const toolsPolicy = {
        name: 'testToolsCircuit',
        primary: { provider: 'anthropic', model: MODELS.WORKHORSE },
        fallback: { provider: 'openai', model: MODELS.OPENAI_FAST },
      };
      const rTools = await llm.dispatchWithFallback(toolsPolicy, {
        text: 'search web',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        jsonMode: true,
      });
      expect(rTools.ok).toBe(true);
      expect(rTools.provider).toBe('anthropic');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(5);
      cb.resetCircuitBreakers();
      cb.afterAttempt('openai', { ok: false, reason: 'openai_503' });
      cb.afterAttempt('openai', { ok: false, reason: 'openai_503' });

      // When primary is skipped (circuit_open) and backup fails with a timeout,
      // the dispatch row keeps circuit_open in failure_reasons AND classifies error_class from the backup's timeout.
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

  test('half-open probe closes on confirmed model response (refusal/incomplete/empty_json) while 400 only releases the probe', () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    process.env.LLM_CIRCUIT_COOLDOWN_MS = '10000';
    const cb = require('../services/llm/circuit-breaker');

    for (const reason of ['openai_refusal', 'openai_incomplete', 'empty_json', 'empty_text']) {
      cb.resetCircuitBreakers();
      cb.afterAttempt('openai', { ok: false, reason: 'openai_503', now: 1000 });
      cb.afterAttempt('openai', { ok: false, reason: 'openai_503', now: 1100 });
      expect(cb.getCircuitBreakerSnapshot(1200).openai.state).toBe('open');

      const probe = cb.beforeAttempt('openai', { hasBackup: true, now: 12000 });
      expect(probe.allow).toBe(true);
      expect(probe.isProbe).toBe(true);

      // A confirmed model response closes the circuit (proving the provider answered)
      // while the individual call still returns ok: false and falls back normally.
      cb.afterAttempt('openai', { ok: false, reason, probeId: probe.probeId, generation: probe.generation, now: 12100 });
      expect(cb.getCircuitBreakerSnapshot(12200).openai).toMatchObject({
        state: 'closed',
        recentFailures: 0,
        probeInFlight: false,
      });
    }

    // By contrast, a 400/no_key error does NOT prove healthy model responses: it releases the probe slot only.
    cb.resetCircuitBreakers();
    cb.afterAttempt('openai', { ok: false, reason: 'openai_503', now: 1000 });
    cb.afterAttempt('openai', { ok: false, reason: 'openai_503', now: 1100 });
    const probe400 = cb.beforeAttempt('openai', { hasBackup: true, now: 12000 });
    cb.afterAttempt('openai', { ok: false, reason: 'openai_400', probeId: probe400.probeId, generation: probe400.generation, now: 12100 });
    expect(cb.getCircuitBreakerSnapshot(12200).openai).toMatchObject({
      state: 'half_open',
      probeInFlight: false,
    });
  });

  test('backups with recent 401/403 credential failures are temporarily excluded without tripping provider outage counting', () => {
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
    process.env.LLM_CIRCUIT_COOLDOWN_MS = '10000';
    process.env.ANTHROPIC_API_KEY = 'bad-key-1';
    const cb = require('../services/llm/circuit-breaker');
    cb.resetCircuitBreakers();

    // Trip OpenAI (primary) at t=1100 (cooldown expires at t=11100).
    cb.afterAttempt('openai', { ok: false, reason: 'openai_503', now: 1000 });
    cb.afterAttempt('openai', { ok: false, reason: 'openai_503', now: 1100 });
    expect(cb.getCircuitBreakerSnapshot(1200).openai.state).toBe('open');

    // Anthropic backup returns 401: excluded temporarily from backup selection,
    // while its outage breaker stays closed with zero outage failures.
    cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_401', now: 1500 });
    expect(cb.getCircuitBreakerSnapshot(1600).anthropic).toMatchObject({ state: 'closed', recentFailures: 0 });
    expect(cb.isAvailable('anthropic', { now: 1600 })).toBe(false);
    expect(cb.beforeAttempt('openai', { backupProviders: ['anthropic'], now: 1600 }).allow).toBe(true);

    // Rotating the credential clears the exclusion immediately even inside cooldown,
    // so OpenAI (still cooling down at t=2600) now skips cleanly to Anthropic.
    cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_401', now: 2000 });
    expect(cb.isAvailable('anthropic', { now: 2500 })).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'rotated-key-2';
    expect(cb.isAvailable('anthropic', { now: 2600 })).toBe(true);
    expect(cb.beforeAttempt('openai', { backupProviders: ['anthropic'], now: 2600 }).allow).toBe(false);

    // 403 and 404 are model-specific: failing one model on a credential must NOT
    // block other models on that same credential, while that failed model IS excluded.
    cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_403', model: 'claude-restricted', now: 2700 });
    expect(cb.isAvailable('anthropic', { model: 'claude-restricted', now: 2750 })).toBe(false);
    expect(cb.isAvailable('anthropic', { model: MODELS.WORKHORSE, now: 2750 })).toBe(true);
    expect(cb.beforeAttempt('openai', {
      backupProviders: [{ provider: 'anthropic', model: 'claude-restricted' }],
      now: 2750,
    }).allow).toBe(true);
    expect(cb.beforeAttempt('openai', {
      backupProviders: [{ provider: 'anthropic', model: MODELS.WORKHORSE }],
      now: 2750,
    }).allow).toBe(false);

    cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_404', model: 'claude-missing', now: 2800 });
    expect(cb.isAvailable('anthropic', { model: 'claude-missing', now: 2850 })).toBe(false);
    expect(cb.isAvailable('anthropic', { model: MODELS.WORKHORSE, now: 2850 })).toBe(true);
    // Rotating the key clears model-access cooldowns for the old credential too.
    process.env.ANTHROPIC_API_KEY = 'rotated-key-2b';
    expect(cb.isAvailable('anthropic', { model: 'claude-restricted', now: 2900 })).toBe(true);
    expect(cb.isAvailable('anthropic', { model: 'claude-missing', now: 2900 })).toBe(true);

    // After auth cooldown expires without key rotation, Anthropic is eligible again.
    cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_401', now: 3000 });
    expect(cb.isAvailable('anthropic', { now: 12999 })).toBe(false);
    expect(cb.isAvailable('anthropic', { now: 13000 })).toBe(true);

    // A delayed 401 bound to a pre-rotation credential never poisons the replacement key.
    process.env.ANTHROPIC_API_KEY = 'replacement-key-3';
    cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_401', now: 14000, credential: 'rotated-key-2' });
    expect(cb.isAvailable('anthropic', { now: 14100 })).toBe(true);

    // An injected client returning 401 cools down THAT client instance without
    // suppressing unrelated injected clients or the shared env credential;
    // 403/404 on an injected client cools down only that (client, model) pair.
    const injectedA = { messages: { create: jest.fn() } };
    const injectedB = { messages: { create: jest.fn() } };
    cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_403', model: 'claude-restricted', now: 14150, credential: injectedA });
    expect(cb.isAvailable('anthropic', { now: 14160, model: 'claude-restricted', credential: injectedA })).toBe(false);
    expect(cb.isAvailable('anthropic', { now: 14160, model: MODELS.WORKHORSE, credential: injectedA })).toBe(true);
    expect(cb.isAvailable('anthropic', { now: 14160, model: 'claude-restricted', credential: injectedB })).toBe(true);
    cb.afterAttempt('anthropic', { ok: false, reason: 'anthropic_401', now: 14200, credential: injectedA });
    expect(cb.isAvailable('anthropic', { now: 14300, credential: injectedA })).toBe(false);
    expect(cb.isAvailable('anthropic', { now: 14300, credential: injectedB })).toBe(true);
    expect(cb.isAvailable('anthropic', { now: 14300 })).toBe(true);
    expect(cb.isAvailable('anthropic', { now: 24200, credential: injectedA })).toBe(true);

    // Completions from calls admitted while the gate was OFF must be ignored
    // even if the gate turns ON before they finish (never bypass generation guard).
    delete process.env.GATE_LLM_CIRCUIT_BREAKER;
    const disabledGate = cb.beforeAttempt('openai', { hasBackup: true, now: 25000 });
    expect(disabledGate.disabled).toBe(true);
    process.env.GATE_LLM_CIRCUIT_BREAKER = 'true';
    cb.resetCircuitBreakers();
    cb.afterAttempt('openai', { ok: false, reason: 'openai_503', disabled: disabledGate.disabled, generation: disabledGate.generation, now: 25100 });
    cb.afterAttempt('openai', { ok: false, reason: 'openai_503', disabled: disabledGate.disabled, generation: disabledGate.generation, now: 25200 });
    expect(cb.getCircuitBreakerSnapshot(25300).openai).toBeUndefined();

    // Cloudflare uses CF_ACCOUNT_ID + CF_WORKERS_AI_TOKEN / CF_API_TOKEN (matching callWorkersAIDecision).
    const savedCfAcct = process.env.CF_ACCOUNT_ID;
    const savedCfTok = process.env.CF_WORKERS_AI_TOKEN;
    const savedCfApi = process.env.CF_API_TOKEN;
    try {
      process.env.CF_ACCOUNT_ID = 'acct-1';
      process.env.CF_WORKERS_AI_TOKEN = 'bad-cf-tok';
      delete process.env.CF_API_TOKEN;
      cb.afterAttempt('cloudflare', { ok: false, reason: 'cloudflare_401', now: 15000 });
      expect(cb.isAvailable('cloudflare', { now: 15100 })).toBe(false);
      process.env.CF_WORKERS_AI_TOKEN = 'fixed-cf-tok';
      expect(cb.isAvailable('cloudflare', { now: 15200 })).toBe(true);
    } finally {
      if (savedCfAcct === undefined) delete process.env.CF_ACCOUNT_ID; else process.env.CF_ACCOUNT_ID = savedCfAcct;
      if (savedCfTok === undefined) delete process.env.CF_WORKERS_AI_TOKEN; else process.env.CF_WORKERS_AI_TOKEN = savedCfTok;
      if (savedCfApi === undefined) delete process.env.CF_API_TOKEN; else process.env.CF_API_TOKEN = savedCfApi;
    }
  });
});
