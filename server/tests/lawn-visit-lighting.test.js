/**
 * Lawn lighting-aware color, part 1 (GATE_LAWN_LIGHTING, owner 2026-10-04): the
 * visit assessment reads each photo's light under its own prompt variants.
 * Gate off = prompt, schema, version, digest, hash, stored rows byte-identical
 * (pinned against the original constants). Gate on = enum-only light read per
 * photo, no numeric bounds, the instruction to judge color in even light, stored
 * beside the photo's quality and kept off the technician's response.
 * No provider call: llm/call is mocked.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn(), dispatch: jest.fn(), rejectCall: jest.fn() }));

const crypto = require('crypto');
const { dispatchWithFallback } = require('../services/llm/call');
const input = require('../services/lawn-visit-input');
const result = require('../services/lawn-visit-result');
const { analyzeVisit } = require('../services/lawn-visit-assessment');
const { refereeVisit } = require('../services/lawn-visit-referee');
const { runRowFor, responseForRun } = require('../services/lawn-visit-runs');
const { lawnLightingLive } = require('../config/feature-gates');
const MODELS = require('../config/models');
const { photo, answer, finding } = require('./helpers/lawn-visit-fixtures');

const GATE = 'GATE_LAWN_LIGHTING';
const ASSESS = 'GATE_LAWN_VISIT_ASSESSMENT';
const saved = { [GATE]: process.env[GATE], [ASSESS]: process.env[ASSESS] };
const restore = (name) => { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; };
afterEach(() => { restore(GATE); restore(ASSESS); });
beforeEach(() => { dispatchWithFallback.mockReset(); delete process.env[GATE]; delete process.env[ASSESS]; });
// The reader needs BOTH gates: the light is read only by the one-call visit assessment.
const on = () => { process.env[GATE] = 'true'; process.env[ASSESS] = 'true'; };

const sha = (...parts) => { const h = crypto.createHash('sha256'); for (const part of parts) h.update(part); return h.digest('hex'); };
const lit = (rows) => rows.map(([photoNumber, quality, lighting, hardShadows]) => ({ photo: photoNumber, quality, issue: '', lighting, hard_shadows: hardShadows }));
const lightAnswer = () => answer({ photo_quality: lit([[1, 'adequate', 'full_sun', 'yes'], [2, 'limited', 'overcast', 'no']]) });
const okOutcome = (json) => ({ ok: true, json, provider: 'gemini', model: MODELS.GEMINI_VISION_BEST, fallbackUsed: false, usage: null, failures: [] });

describe('the gate', () => {
  test('is dark: on only for exactly "true" AND the visit assessment gate on, read at call time (truth table)', () => {
    const cases = [
      [undefined, undefined, false], ['true', undefined, false], [undefined, 'true', false], ['true', 'true', true],
      ['true', 'on', true], ['true', '1', true], ['true', 'false', false], ['true', '', false],
      ['1', 'true', false], ['on', 'true', false], ['TRUE', 'true', false], ['yes', 'true', false], ['', 'true', false],
    ];
    for (const [light, assess, expected] of cases) {
      if (light === undefined) delete process.env[GATE]; else process.env[GATE] = light;
      if (assess === undefined) delete process.env[ASSESS]; else process.env[ASSESS] = assess;
      expect([light, assess, lawnLightingLive()]).toEqual([light, assess, expected]);
    }
    on();
    expect(lawnLightingLive()).toBe(true);
    delete process.env[GATE];
    expect(lawnLightingLive()).toBe(false);
  });

  test('without the visit assessment gate no effect can run: analyzeVisit reads the legacy variant even with GATE_LAWN_LIGHTING set', async () => {
    process.env[GATE] = 'true';
    dispatchWithFallback.mockResolvedValue(okOutcome(answer()));
    expect((await analyzeVisit({ photos: [photo('YQ==')] })).promptVersion).toBe('lawn-visit-v1');
  });
});

describe('gate off: byte-identical to before', () => {
  test('the four original variants are unchanged and know nothing about light', () => {
    expect(input.promptFor()).toEqual({ version: 'lawn-visit-v1', system: input.SYSTEM_PROMPT, schema: input.RESPONSE_SCHEMA, digest: input.PROMPT_DIGEST });
    expect(input.promptFor({ shotList: true }).version).toBe('lawn-visit-v1-shot-list');
    expect(input.promptFor({ lighting: false })).toEqual(input.promptFor());
    expect(input.PROMPT_DIGEST).toBe(sha(input.SYSTEM_PROMPT, '\n', JSON.stringify(input.RESPONSE_SCHEMA)));
    for (const text of [input.SYSTEM_PROMPT, input.SHOT_LIST_SYSTEM_PROMPT, JSON.stringify(input.RESPONSE_SCHEMA), JSON.stringify(input.SHOT_LIST_RESPONSE_SCHEMA)]) {
      expect(text).not.toMatch(/LIGHT IN THE PHOTOS|hard_shadows|full_sun/);
    }
    expect(input.RESPONSE_SCHEMA.properties.photo_quality.items.required).toEqual(['photo', 'quality', 'issue']);
    // the context hash seeds with the version + digest, so the legacy hash is untouched
    const photos = [photo('a'), photo('b')];
    const args = { photos, photoZones: ['front', null], visionContext: { season: 'peak' } };
    expect(input.contextHash({ ...args, lighting: false })).toBe(input.contextHash(args));
  });

  test('analyzeVisit sends the legacy prompt, schema and version, validates the legacy shape and stores rows with no light keys', async () => {
    dispatchWithFallback.mockResolvedValue(okOutcome(answer({ findings: [finding({ photo_refs: [1] })] })));
    const out = await analyzeVisit({ photos: [photo('YQ==', 'front'), photo('Yg==')] });
    const [, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(payload).toMatchObject({ system: input.SYSTEM_PROMPT, jsonSchema: input.RESPONSE_SCHEMA, promptVersion: 'lawn-visit-v1' });
    expect(out.promptVersion).toBe('lawn-visit-v1');
    expect(out.photoQuality).toEqual([
      { photo: 1, quality: 'adequate', issue: '' },
      { photo: 2, quality: 'poor', issue: 'blurred' },
    ]);
    expect(Object.keys(out.photoQuality[0])).toEqual(['photo', 'quality', 'issue']);
    // the legacy validator rejects a light key it never asked for (closed shape), as before
    expect(options.validate({ json: lightAnswer() })).toBe('malformed_assessment');
    expect(options.validate({ json: answer() })).toBeNull();
  });

  test('unavailable and unrated rows carry no light keys either', () => {
    expect(result.emptyAnalysis(2).photoQuality[0]).toEqual({ photo: 1, quality: 'unrated', issue: 'not rated (analysis unavailable)' });
    expect(result.normalizeAssessment(answer({ photo_quality: [] }), 2, []).photoQuality[1]).toEqual({ photo: 2, quality: 'unrated', issue: 'not rated by the model' });
  });
});

describe('gate on: the light read', () => {
  const variant = input.promptFor({ lighting: true });
  const shotVariant = input.promptFor({ lighting: true, shotList: true });

  test('own prompt versions, digests and hash for each capture mode', () => {
    expect(variant.version).toBe('lawn-visit-v1-lighting');
    expect(shotVariant.version).toBe('lawn-visit-v1-shot-list-lighting');
    expect(input.LIGHTING_PROMPT_VERSION).toBe(variant.version);
    expect(input.SHOT_LIST_LIGHTING_PROMPT_VERSION).toBe(shotVariant.version);
    const digests = [input.PROMPT_DIGEST, input.SHOT_LIST_PROMPT_DIGEST, variant.digest, shotVariant.digest];
    expect(new Set(digests).size).toBe(4);
    expect(variant.digest).toBe(sha(variant.system, '\n', JSON.stringify(variant.schema)));
    const photos = [photo('a'), photo('b')];
    const args = { photos, photoZones: ['front', null], visionContext: { season: 'peak' } };
    expect(input.contextHash({ ...args, lighting: true })).not.toBe(input.contextHash(args));
    expect(input.variantOfVersion('lawn-visit-v1-shot-list-lighting')).toEqual({ shotList: true, lighting: true });
    expect(input.variantOfVersion('lawn-visit-v1-lighting')).toEqual({ shotList: false, lighting: true });
    expect(input.variantOfVersion('lawn-visit-v1-shot-list')).toEqual({ shotList: true, lighting: false });
    expect(input.variantOfVersion(undefined)).toEqual({ shotList: false, lighting: false });
  });

  test('the prompt is the original plus a LIGHT block: the six values, hard shadows, judge color in even light, never read shade as thinner or sun as yellower', () => {
    expect(variant.system.startsWith(input.SYSTEM_PROMPT.slice(0, input.SYSTEM_PROMPT.indexOf('# FINDINGS (evidence-first)')))).toBe(true);
    expect(variant.system.replace(/# LIGHT IN THE PHOTOS[\s\S]*?Light is never a finding by itself\.\n\n/, '')).toBe(input.SYSTEM_PROMPT);
    for (const value of ['full_sun', 'overcast', 'open_shade', 'mixed_sun_shade', 'low_light', 'unknown']) expect(variant.system).toContain(value);
    expect(variant.system).toMatch(/hard_shadows: yes/);
    expect(variant.system).toMatch(/Judge color_health from turf in even light/);
    expect(variant.system).toMatch(/never read\s+shadowed turf as darker, thinner or more stressed turf/);
    expect(variant.system).toMatch(/never read sunlit turf as\s+yellower or paler turf/);
    expect(variant.system).toMatch(/Never infer it from the season/);
    // no new technician step: color is never made undeterminable by the light
    expect(variant.system).toMatch(/still give your\s+best color_health/);
    // the shot-list variant keeps its guide, in front of the light block
    expect(shotVariant.system).toContain('SHOT GUIDE');
    expect(shotVariant.system.indexOf('SHOT GUIDE')).toBeLessThan(shotVariant.system.indexOf('LIGHT IN THE PHOTOS'));
    expect(shotVariant.system.indexOf('LIGHT IN THE PHOTOS')).toBeLessThan(shotVariant.system.indexOf('# FINDINGS (evidence-first)'));
  });

  test('the schema reads the light as closed enums on each photo_quality row, every key required, no numeric bounds, no nullable types', () => {
    for (const schema of [variant.schema, shotVariant.schema]) {
      const row = schema.properties.photo_quality.items;
      expect(row).toMatchObject({ additionalProperties: false, required: ['photo', 'quality', 'issue', 'lighting', 'hard_shadows'] });
      expect(row.properties.lighting.enum).toEqual(['full_sun', 'overcast', 'open_shade', 'mixed_sun_shade', 'low_light', 'unknown']);
      expect(row.properties.hard_shadows.enum).toEqual(['yes', 'no', 'unknown']);
      expect(JSON.stringify(row)).not.toMatch(/minimum|maximum|nullable|"null"/);
    }
    // the original numeric score bounds elsewhere in the schema are not touched by this change
    expect(JSON.stringify(variant.schema.properties.scores)).toBe(JSON.stringify(input.RESPONSE_SCHEMA.properties.scores));
    expect(shotVariant.schema.properties.findings.items.properties.zone.enum).toContain('blade_crown');
  });

  test('analyzeVisit with the gate env on reads under the lighting variant, validates its shape, and stores a normalized read per photo', async () => {
    on();
    dispatchWithFallback.mockResolvedValue(okOutcome(lightAnswer()));
    const out = await analyzeVisit({ photos: [photo('YQ==', 'front'), photo('Yg==')] });
    const [, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(payload).toMatchObject({ system: variant.system, jsonSchema: variant.schema, promptVersion: 'lawn-visit-v1-lighting' });
    expect(out.promptVersion).toBe('lawn-visit-v1-lighting');
    expect(out.contextHash).toBe(input.contextHash({ photos: [photo('YQ==', 'front'), photo('Yg==')], photoZones: ['front', null], visionContext: {}, lighting: true }));
    expect(out.photoQuality).toEqual([
      { photo: 1, quality: 'adequate', issue: '', lighting: 'full_sun', hard_shadows: true },
      { photo: 2, quality: 'limited', issue: '', lighting: 'overcast', hard_shadows: false },
    ]);
    expect(options.validate({ json: lightAnswer() })).toBeNull();
    expect(options.validate({ json: answer() })).toBeNull(); // an answer with no light keys still conforms to the closed shape
    expect(options.validate({ json: answer({ photo_quality: [{ photo: 1, quality: 'adequate', issue: '', lighting: 'sunny', extra: 1 }, { photo: 2, quality: 'adequate', issue: '' }] }) })).toBe('malformed_assessment');
    // an unlisted word or a missing key reads as unknown, never as a guessed light
    const odd = result.normalizeAssessment(answer({ photo_quality: [{ photo: 1, quality: 'adequate', issue: '', lighting: 'sunny', hard_shadows: 'maybe' }, { photo: 2, quality: 'adequate', issue: '' }] }), 2, [], { lighting: true });
    expect(odd.photoQuality).toEqual([
      { photo: 1, quality: 'adequate', issue: '', lighting: 'unknown', hard_shadows: null },
      { photo: 2, quality: 'adequate', issue: '', lighting: 'unknown', hard_shadows: null },
    ]);
    expect(result.normalizeAssessment(answer({ photo_quality: [] }), 1, [], { lighting: true }).photoQuality[0])
      .toEqual({ photo: 1, quality: 'unrated', issue: 'not rated by the model', lighting: 'unknown', hard_shadows: null });
  });

  test('a shot-list capture reads under the shot-list lighting variant', async () => {
    on();
    dispatchWithFallback.mockResolvedValue(okOutcome(lightAnswer()));
    const out = await analyzeVisit({ photos: [photo('YQ==', 'front'), photo('Yg==', 'back')], shotList: true });
    expect(dispatchWithFallback.mock.calls[0][1]).toMatchObject({ system: shotVariant.system, promptVersion: 'lawn-visit-v1-shot-list-lighting' });
    expect(out.promptVersion).toBe('lawn-visit-v1-shot-list-lighting');
  });

  test('an explicit lighting argument wins over the env, so a caller can decide once', async () => {
    on();
    dispatchWithFallback.mockResolvedValue(okOutcome(answer()));
    expect((await analyzeVisit({ photos: [photo('YQ==')], lighting: false })).promptVersion).toBe('lawn-visit-v1');
  });

  test('the second opinion is validated against the same lighting shape the first read used', async () => {
    const payload = { system: 's', jsonSchema: variant.schema, promptVersion: 'lawn-visit-v1-lighting' };
    const geminiJson = answer({ photo_quality: lit([[1, 'adequate', 'full_sun', 'no'], [2, 'adequate', 'full_sun', 'no']]), findings: [finding({ confidence: 'low', photo_refs: [1], zone: 'front' })] });
    const { dispatch, rejectCall } = require('../services/llm/call');
    dispatch.mockReset();
    rejectCall.mockReset();
    dispatch.mockResolvedValue({ ok: true, json: geminiJson, model: 'sol', usage: null });
    const run = (lighting) => refereeVisit({ policy: MODELS.TEXT_POLICIES.lawnVisitAssessment, payload, geminiJson, visit: { photoCount: 2, images: [], context: {}, lighting } });
    expect((await run(true)).referee.secondOpinion).toMatchObject({ called: true });
    expect((await run(true)).referee.reason).not.toBe('second_opinion_failed');
    expect((await run(false)).referee.reason).toBe('second_opinion_failed'); // the closed legacy shape rejects the light keys
  });
});

describe('where the read is stored, and who sees it', () => {
  const analysis = {
    status: 'complete', promptVersion: 'lawn-visit-v1-lighting', contextHash: 'h', provider: 'gemini', model: 'm', fallbackUsed: false,
    findings: [], severities: {}, scores: {}, observations: 'o', raw: {}, failures: [],
    photoQuality: [{ photo: 1, quality: 'adequate', issue: '', lighting: 'overcast', hard_shadows: false }],
  };

  test('the run row keeps the light inside photo_quality, next to the quality, with the new prompt version', () => {
    const row = runRowFor({ assessment: { id: 'a', customer_id: 'c' }, analysis, photoRecords: [{ id: 'p1' }] });
    expect(row.prompt_version).toBe('lawn-visit-v1-lighting');
    expect(JSON.parse(row.photo_quality)).toEqual(analysis.photoQuality);
    expect(JSON.parse(row.photo_ids)).toEqual(['p1']);
  });

  test('the technician response never carries the light read; a pre-gate row passes through untouched', () => {
    const stored = [
      { photo: 1, quality: 'adequate', issue: '', lighting: 'overcast', hard_shadows: false },
      { photo: 2, quality: 'poor', issue: 'blurred' },
    ];
    const response = responseForRun({ id: 'r', status: 'complete', photo_quality: stored, findings: [] });
    expect(response.photoQuality).toEqual([{ photo: 1, quality: 'adequate', issue: '' }, { photo: 2, quality: 'poor', issue: 'blurred' }]);
    expect(JSON.stringify(response)).not.toMatch(/lighting|hard_shadows|overcast/);
    expect(stored[0].lighting).toBe('overcast'); // the stored row itself is not mutated
    expect(responseForRun({ id: 'r', status: 'pending' }).photoQuality).toEqual([]);
  });
});

describe('the PDF document prints no color trend (so the trend rule needs no PDF cache stamp)', () => {
  const fs = require('fs');
  const path = require('path');
  test('mode=pdf renders ServiceReportDocument, which never mounts the lawn trends', () => {
    const client = path.join(__dirname, '../../client/src');
    const doc = fs.readFileSync(path.join(client, 'pages/ServiceReportDocument.jsx'), 'utf8');
    const code = doc.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/LawnTrends|LawnReportV2Section|\.trends\b|reportV2\??\.trends/);
    const view = fs.readFileSync(path.join(client, 'pages/ReportViewPage.jsx'), 'utf8');
    expect(view).toMatch(/if \(mode === 'pdf'\) return <ServiceReportDocument data=\{data\} token=\{token\} \/>;/);
  });
});

describe('every reader of the gate is listed in the public route contract', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'tests' || e.name === 'node_modules' || e.name === 'migrations' ? [] : walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });

  test('only these server files CALL lawnLightingLive() or read the env var, and the contract names each', () => {
    const readers = walk(root)
      .filter((file) => /lawnLightingLive\(|process\.env\.GATE_LAWN_LIGHTING/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
      .sort();
    expect(readers).toEqual([
      'config/feature-gates.js',
      'routes/lawn-health.js',
      'services/lawn-paired-recheck.js',
      'services/lawn-visit-assessment.js',
      'services/service-report/report-copy-context.js',
      'services/service-report/report-data.js',
    ]);
    const contract = fs.readFileSync(path.join(root, '../docs/public-route-contracts.md'), 'utf8');
    for (const file of readers.filter((f) => f !== 'config/feature-gates.js')) expect(contract).toContain(`server/${file}`);
  });
});
