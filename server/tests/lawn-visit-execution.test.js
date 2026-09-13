jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const { analyzeVisit } = require('../services/lawn-visit-assessment');
const input = require('../services/lawn-visit-input');
const { UNAVAILABLE_OBSERVATIONS } = require('../services/lawn-visit-result');
const MODELS = require('../config/models');
const { photo, answer, finding } = require('./helpers/lawn-visit-fixtures');

const photos = [photo('YQ==', 'Front'), photo('Yg==')];
const validAnswer = (overrides = {}) => answer({
  scores: { turf_density: { determinable: true, value: 72 }, weed_coverage: { determinable: true, value: 15 }, color_health: { determinable: false, value: 1 } },
  ...overrides,
});
const ok = (json = validAnswer(), extra = {}) => ({
  ok: true, json, provider: 'gemini', model: MODELS.GEMINI_VISION_BEST,
  fallbackUsed: false, usage: { input_tokens: 9000, output_tokens: 4000, reasoning_tokens: 1500 },
  failures: [], ...extra,
});

beforeEach(() => dispatchWithFallback.mockReset());

test.each([[], null, [photo('')], [photo('YQ==', 'garage')], Array.from({ length: 7 }, () => photos[0])].map((invalid) => [invalid]))(
  'rejects invalid visit photos before any paid dispatch (%j)', async (invalid) => {
    await expect(analyzeVisit({ photos: invalid })).rejects.toMatchObject({ code: 'INVALID_VISIT_PHOTOS', statusCode: 400 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  },
);

test('one numbered-photo chain uses the registered vision policy and validates the entire visit', async () => {
  dispatchWithFallback.mockResolvedValue(ok());
  const context = { season: 'peak', month: 7, region: 'Southwest Florida', productsApplied: ['private planned product'] };
  const result = await analyzeVisit({ photos, visionContext: context });
  expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
  expect(policy).toBe(MODELS.TEXT_POLICIES.lawnVisitAssessment);
  expect(policy.primary.provider).toBe('gemini');
  expect(policy.fallback).toEqual({ provider: 'openai', model: MODELS.OPENAI_FRONTIER });
  expect(payload).toMatchObject({
    system: input.SYSTEM_PROMPT, jsonMode: true, jsonSchema: input.RESPONSE_SCHEMA,
    maxTokens: input.MAX_OUTPUT_TOKENS, reasoningEffort: 'medium',
    laneId: 'lawn_visit_assessment', promptVersion: input.PROMPT_VERSION,
    images: [
      { data: 'YQ==', mimeType: 'image/jpeg', label: 'Photo 1 (front)' },
      { data: 'Yg==', mimeType: 'image/jpeg', label: 'Photo 2' },
    ],
  });
  expect(payload.thinkingLevel).toBeUndefined();
  expect(payload.text).not.toContain('private planned product');
  expect(options.validate({ json: validAnswer() })).toBeNull();
  expect(options.validate({ json: validAnswer({ photo_quality: [{ photo: 1, quality: 'adequate', issue: '' }] }) })).toBe('incomplete_photo_quality');
  expect(result).toMatchObject({
    status: 'complete', provider: 'gemini', fallbackUsed: false, usage: { reasoning_tokens: 1500 },
    visionContext: { season: 'peak', month: 7, region: 'Southwest Florida' }, technicianNotesPresent: false,
    scores: { turf_density: 72, weed_coverage: 15, color_health: null },
  });
  expect(result.contextHash).toBe(input.contextHash({ photos, photoZones: ['front', null], visionContext: context }));
});

test('preserves the fallback model and billed failed-leg usage without dispatching twice', async () => {
  const failures = [{ provider: 'gemini', reason: 'malformed_assessment', usage: { input_tokens: 2100, output_tokens: 600 } }];
  dispatchWithFallback.mockResolvedValue(ok(validAnswer(), { provider: 'openai', model: MODELS.OPENAI_FRONTIER, fallbackUsed: true, failures }));
  const result = await analyzeVisit({ photos, thinkingLevel: 'LOW', visionContext: null });
  expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  expect(dispatchWithFallback.mock.calls[0][1].thinkingLevel).toBe('LOW');
  expect(result).toMatchObject({ provider: 'openai', model: MODELS.OPENAI_FRONTIER, fallbackUsed: true, failures, visionContext: {} });
});

test('server IDs and technician photo zones govern the normalized answer', async () => {
  dispatchWithFallback.mockResolvedValue(ok(validAnswer({ findings: [
    finding({ finding_id: 'T1' }),
    finding({ finding_id: 'T1', name: 'Chinch bug damage', confidence: 'low', zone: 'back', photo_refs: [2] }),
  ] })));
  const result = await analyzeVisit({ photos });
  expect(result.findings.map((f) => f.finding_id)).toEqual(['F1', 'F2']);
  expect(result.findings[0]).toMatchObject({ model_finding_id: 'T1', photo_refs: [1, 2], zone: 'front' });
  expect(result.findings[1]).toMatchObject({ confidence: 'unknown', label: 'general lawn stress', zone: 'unknown' });
});

test('note-influenced prose stays in the internal raw answer, and the replay snapshot declares notes omitted', async () => {
  const json = validAnswer({ observations: 'Li asked us to hide the spare key.', findings: [finding({ confirmation_step: 'Ask Li about the spare key.' })] });
  dispatchWithFallback.mockResolvedValue(ok(json));
  const context = { season: 'peak', month: 7, technicianNotes: 'Li asked us to hide the spare key.', priorSummary: 'Turf was healthy.' };
  const result = await analyzeVisit({ photos, visionContext: context });
  expect(result.raw).toBe(json);
  expect(result.observations).toBe('');
  expect(result.findings.every((f) => f.confirmation_step === '')).toBe(true);
  expect(result.visionContext).toEqual({ season: 'peak', month: 7, priorSummary: 'Turf was healthy.' });
  expect(result.technicianNotesPresent).toBe(true);
  expect(result.contextHash).not.toBe(input.contextHash({ photos, photoZones: ['front', null], visionContext: result.visionContext }));
});

test('provider exhaustion preserves failures and produces unrated photos and NULL scores', async () => {
  const failures = [
    { provider: 'gemini', reason: 'malformed_assessment', usage: { input_tokens: 2000, output_tokens: 500 } },
    { provider: 'openai', reason: 'openai_timeout' },
  ];
  dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures });
  const result = await analyzeVisit({ photos });
  expect(result).toMatchObject({
    status: 'unavailable', reason: 'all_providers_failed', failures, provider: null, model: null,
    raw: null, usage: null, findings: [], severities: null, fallbackUsed: false,
    scores: { turf_density: null, weed_coverage: null, color_health: null }, observations: UNAVAILABLE_OBSERVATIONS,
  });
  expect(result.photoQuality.map((q) => q.quality)).toEqual(['unrated', 'unrated']);
  expect(result.contextHash).toMatch(/^[0-9a-f]{64}$/);
});
