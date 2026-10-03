/**
 * Lawn report rebuild P19a: the lawn visit read understands the shot list.
 * A shot-list capture reads under its own prompt variant (shot guide generated
 * from shared/lawn-photo-shots.json, own version and hash) and two evidence
 * rules run in code; a legacy capture is byte-identical to before.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const crypto = require('crypto');
const { dispatchWithFallback } = require('../services/llm/call');
const input = require('../services/lawn-visit-input');
const shots = require('../services/lawn-photo-shots');
const result = require('../services/lawn-visit-result');
const { analyzeVisit } = require('../services/lawn-visit-assessment');
const definition = require('../../shared/lawn-photo-shots.json');
const MODELS = require('../config/models');
const { photo, answer, finding } = require('./helpers/lawn-visit-fixtures');

const sha = (...parts) => { const h = crypto.createHash('sha256'); for (const part of parts) h.update(part); return h.digest('hex'); };
const FULL = ['front', 'back', 'side', 'close_up', 'blade_crown', 'hot_edge', 'shade', 'trouble'];

describe('gate off / legacy capture is unchanged', () => {
  test('prompt, schema, version, digest, user text and hash are the legacy values (pinned)', () => {
    expect(input.PROMPT_VERSION).toBe('lawn-visit-v1');
    expect(input.promptFor()).toEqual({ version: 'lawn-visit-v1', system: input.SYSTEM_PROMPT, schema: input.RESPONSE_SCHEMA, digest: input.PROMPT_DIGEST });
    expect(input.promptFor({ shotList: false }).system).toBe(input.SYSTEM_PROMPT);
    expect(input.SYSTEM_PROMPT).not.toMatch(/SHOT GUIDE/);
    expect(input.SYSTEM_PROMPT).toContain('(front / close_up / trouble)');
    expect(input.RESPONSE_SCHEMA.properties.findings.items.properties.zone.enum).toEqual(['front', 'close_up', 'trouble', 'unknown']);
    expect(input.PROMPT_DIGEST).toBe(sha(input.SYSTEM_PROMPT, '\n', JSON.stringify(input.RESPONSE_SCHEMA)));
    expect(input.buildUserText(2, {})).toBe('Assess the lawn in the 2 numbered photos of this visit.');
    expect(input.buildUserText(2, {}, { shotList: false, zones: ['front'] })).toBe(input.buildUserText(2, {}));
    const photos = [photo('a'), photo('b')];
    const legacy = input.contextHash({ photos, photoZones: ['front', null], visionContext: { season: 'peak' } });
    expect(input.contextHash({ photos, photoZones: ['front', null], visionContext: { season: 'peak' }, shotList: false })).toBe(legacy);
  });

  test('analyzeVisit without shotList sends the legacy system prompt, schema and version, and adds no evidence fields', async () => {
    dispatchWithFallback.mockReset();
    dispatchWithFallback.mockResolvedValue({ ok: true, json: answer({ findings: [finding({ name: 'Chinch bug damage', confidence: 'high', photo_refs: [1] })] }), provider: 'gemini', model: MODELS.GEMINI_VISION_BEST, fallbackUsed: false, usage: null, failures: [] });
    const out = await analyzeVisit({ photos: [photo('YQ==', 'front'), photo('Yg==')] });
    const payload = dispatchWithFallback.mock.calls[0][1];
    expect(payload).toMatchObject({ system: input.SYSTEM_PROMPT, jsonSchema: input.RESPONSE_SCHEMA, promptVersion: 'lawn-visit-v1' });
    expect(payload.text).toBe('Assess the lawn in the 2 numbered photos of this visit.');
    expect(out.promptVersion).toBe('lawn-visit-v1');
    expect(out.findings[0].confidence).toBe('high');
    expect(Object.keys(out.findings[0])).not.toEqual(expect.arrayContaining(['localized']));
    expect(out.findings[0].confidence_cap).toBeUndefined();
  });
});

describe('shot guide (shot-list captures)', () => {
  const variant = input.promptFor({ shotList: true });

  test('own version; prompt, schema, digest and hash differ from legacy', () => {
    expect(input.SHOT_LIST_PROMPT_VERSION).toBe('lawn-visit-v1-shot-list');
    expect(variant.version).toBe(input.SHOT_LIST_PROMPT_VERSION);
    expect(variant.version).not.toBe(input.PROMPT_VERSION);
    expect(variant.system).not.toBe(input.SYSTEM_PROMPT);
    expect(variant.digest).not.toBe(input.PROMPT_DIGEST);
    expect(variant.digest).toBe(sha(variant.system, '\n', JSON.stringify(variant.schema)));
    expect(variant.schema.properties.findings.items.properties.zone.enum).toEqual([...FULL, 'unknown']);
    const photos = [photo('a'), photo('b')];
    const args = { photos, photoZones: ['front', 'close_up'], visionContext: { season: 'peak' } };
    expect(input.contextHash({ ...args, shotList: true })).not.toBe(input.contextHash(args));
    expect(input.contextHash({ ...args, shotList: true })).toBe(input.contextHash({ ...args, shotList: true }));
  });

  test('the guide names every shot in the definition, in order, and sits between the photos and findings sections', () => {
    const guide = shots.shotGuideText();
    let last = -1;
    for (const shot of definition.shots) {
      const at = guide.indexOf(`- ${shot.key} (${shot.label};`);
      expect(at).toBeGreaterThan(last);
      expect(guide).toContain(shot.guide);
      last = at;
    }
    expect(variant.system).toContain(guide);
    expect(variant.system.indexOf('# THE PHOTOS')).toBeLessThan(variant.system.indexOf('# SHOT GUIDE'));
    expect(variant.system.indexOf('# SHOT GUIDE')).toBeLessThan(variant.system.indexOf('# FINDINGS (evidence-first)'));
    expect(variant.system).not.toContain('(front / close_up / trouble)');
  });

  test('the guide is generated from the definition: a changed label, weight or cause flag changes the text', () => {
    const edit = (fn) => { const copy = JSON.parse(JSON.stringify(definition)); fn(copy); return shots.shotGuideText(copy); };
    const base = shots.shotGuideText();
    expect(edit((d) => { d.shots[0].label = 'Curb view'; })).toContain('- front (Curb view;');
    expect(edit((d) => { d.shots[0].guide = 'Edited sentence.'; })).toContain('Edited sentence.');
    expect(edit((d) => { d.shots.find((s) => s.key === 'shade').areaWeight = 0; })).not.toBe(base);
    expect(edit((d) => { d.shots.find((s) => s.key === 'close_up').supportsCause = true; })).toContain('a close_up, blade_crown or trouble photo');
  });

  test('the guide states the compositing rules', () => {
    const guide = shots.shotGuideText();
    expect(guide).toContain('come from the overview shots (front, back and side). hot_edge and shade count at half weight.');
    expect(guide).toContain('Detail shots (close_up, blade_crown and trouble) never raise or lower an area score on their own.');
    expect(guide).toContain('worst level across all photos');
    expect(guide).toContain('LOCALIZED');
    expect(guide).toContain('unless a blade_crown or trouble photo is among its photo_refs');
    expect(guide).toContain('A photo with no shot label is an overview.');
  });

  test.each([
    [FULL, 'All four minimum shots are present.'],
    [['front', 'back', 'close_up', 'blade_crown'], 'All four minimum shots are present.'],
    [['front', 'side', 'close_up', 'blade_crown'], 'All four minimum shots are present.'],
    [['front', 'close_up', 'hot_edge'], 'Minimum shots NOT in this set: back or side (Back overview or Side overview); blade_crown (Blade and crown). Report reduced confidence for what they would have shown.'],
    [['trouble', null, null], 'Minimum shots NOT in this set: front (Front overview); back or side (Back overview or Side overview); close_up (Canopy close-up); blade_crown (Blade and crown). Report reduced confidence for what they would have shown.'],
    [[], 'Minimum shots NOT in this set: front (Front overview); back or side (Back overview or Side overview); close_up (Canopy close-up); blade_crown (Blade and crown). Report reduced confidence for what they would have shown.'],
  ])('missing-shot line for %j', (zones, line) => {
    expect(shots.missingShotsText(zones)).toBe(line);
    expect(input.buildUserText(zones.length, {}, { shotList: true, zones })).toBe(`Assess the lawn in the ${zones.length} numbered photos of this visit.\n\n${line}`);
  });

  test('context lines still follow the missing-shot line, and products never enter', () => {
    const text = input.buildUserText(3, { season: 'peak', productsApplied: ['Celsius WG'], priorSummary: 'Last visit was 72.' }, { shotList: true, zones: ['front', 'back', 'close_up'] });
    expect(text).toContain('Minimum shots NOT in this set: blade_crown');
    expect(text).toContain('KNOWN VISIT CONTEXT');
    expect(text).not.toMatch(/Celsius/);
    expect(variant.system).not.toMatch(/prior score|last visit.s score/i);
  });

  test('analyzeVisit with shotList sends the variant, the missing-shot text, its own version and hash', async () => {
    dispatchWithFallback.mockReset();
    dispatchWithFallback.mockResolvedValue({ ok: true, json: answer(), provider: 'gemini', model: MODELS.GEMINI_VISION_BEST, fallbackUsed: false, usage: null, failures: [] });
    const photos = [photo('YQ==', 'front'), photo('Yg==', 'close_up'), photo('Yw==', 'hot_edge')];
    const out = await analyzeVisit({ photos, shotList: true, visionContext: { season: 'peak' } });
    const payload = dispatchWithFallback.mock.calls[0][1];
    expect(payload).toMatchObject({ system: variant.system, jsonSchema: variant.schema, promptVersion: 'lawn-visit-v1-shot-list' });
    expect(payload.text).toContain('Minimum shots NOT in this set: back or side (Back overview or Side overview); blade_crown (Blade and crown).');
    expect(payload.images.map((i) => i.label)).toEqual(['Photo 1 (front)', 'Photo 2 (close_up)', 'Photo 3 (hot_edge)']);
    expect(out.promptVersion).toBe('lawn-visit-v1-shot-list');
    expect(out.contextHash).toBe(input.contextHash({ photos, photoZones: ['front', 'close_up', 'hot_edge'], visionContext: { season: 'peak' }, shotList: true }));
    expect(out.contextHash).not.toBe(input.contextHash({ photos, photoZones: ['front', 'close_up', 'hot_edge'], visionContext: { season: 'peak' } }));
  });
});

describe('server-side evidence rules (shot-list captures only)', () => {
  const rated = (...qualities) => qualities.map((quality, i) => ({ photo: i + 1, quality, issue: '' }));
  const two = (overrides, quality = rated('adequate', 'adequate', 'adequate')) => answer({ photo_quality: quality, findings: [finding(overrides)] });
  const run = (zones, overrides, opts, quality) => result.normalizeAssessment(two(overrides, quality), 3, zones, opts).findings[0];
  const ON = { shotList: true };

  test.each([
    // [zones, refs, localized]
    [['front', 'close_up', 'trouble'], [2], true],
    [['front', 'close_up', 'trouble'], [2, 3], true],
    [['front', 'close_up', 'trouble'], [1, 2], false],
    [['front', 'close_up', 'trouble'], [1], false],
    [['hot_edge', 'shade', 'blade_crown'], [1, 2], false],
    [[null, 'close_up', 'trouble'], [1, 2], false],
    [[null, 'close_up', 'trouble'], [1], false],
    [['front', 'close_up', 'trouble'], [], false],
  ])('localized: zones %j refs %j -> %s', (zones, refs, localized) => {
    expect(run(zones, { name: 'Thinning turf', confidence: 'low', photo_refs: refs }, ON).localized).toBe(localized);
  });

  test.each([
    // [name, confidence, zones, refs, expected confidence, capped]
    ['Chinch bug damage', 'high', ['front', 'close_up', 'blade_crown'], [1, 2], 'low', true],
    ['Chinch bug damage', 'moderate', ['front', 'close_up', 'blade_crown'], [1], 'low', true],
    ['Chinch bug damage', 'high', ['front', 'close_up', 'blade_crown'], [1, 3], 'high', false],
    ['Gray leaf spot', 'moderate', ['front', 'close_up', 'trouble'], [3], 'moderate', false],
    ['Large patch', 'high', [null, null, null], [1, 2], 'low', true],
    ['Nutsedge pressure', 'moderate', ['front', 'close_up', 'blade_crown'], [1, 2], 'low', true],
    ['Chinch bug damage', 'low', ['front', 'close_up', 'blade_crown'], [1], 'low', false],
    ['Chinch bug damage', 'unknown', ['front', 'close_up', 'blade_crown'], [1], 'unknown', false],
    ['Thinning turf', 'high', ['front', 'close_up', 'blade_crown'], [1], 'high', false],
    ['No chinch bugs seen, healthy turf', 'high', ['front', 'close_up', 'blade_crown'], [1], 'high', false],
  ])('named-cause cap: %s (%s) refs %j', (name, confidence, zones, refs, expected, capped) => {
    const f = run(zones, { name, confidence, photo_refs: refs }, ON);
    expect(f.confidence).toBe(expected);
    expect(f.confidence_cap).toBe(capped ? 'named_cause_without_close_up' : undefined);
    // The customer label follows the capped confidence through the naming gate.
    if (capped && /chinch|patch|spot/i.test(name)) expect(f.label).toBe('general lawn stress');
  });

  test('a capped finding keeps determinability and its cited photos; a localized named cause is both localized and capped', () => {
    const f = run(['front', 'close_up', 'blade_crown'], { name: 'Dollar spot', confidence: 'high', photo_refs: [2] }, ON);
    expect(f).toMatchObject({ can_determine: true, photo_refs: [2], localized: true, confidence: 'low', zone: 'close_up' });
  });

  describe('only usable cited close-ups lift the cap', () => {
    const zones = ['front', 'blade_crown', 'trouble'];
    const chinch = (refs) => ({ name: 'Chinch bug damage', confidence: 'high', photo_refs: refs });
    test.each([
      ['usable blade_crown lifts it', [1, 2], rated('adequate', 'adequate', 'adequate'), 'high'],
      ['limited counts as usable', [1, 2], rated('adequate', 'limited', 'adequate'), 'high'],
      ['unusable (poor) blade_crown does not', [1, 2], rated('adequate', 'poor', 'adequate'), 'low'],
      ['unrated (no quality for that photo) does not', [1, 2], [{ photo: 1, quality: 'adequate', issue: '' }, { photo: 3, quality: 'adequate', issue: '' }], 'low'],
      // No quality read at all: the existing unsupported-photo gate already makes it undeterminable (unknown), below the cap.
      ['no quality info at all does not', [1, 2], [], 'unknown'],
      ['one unusable trouble + one usable blade_crown lifts it', [1, 2, 3], rated('adequate', 'adequate', 'poor'), 'high'],
      ['one usable trouble + one unusable blade_crown lifts it', [1, 2, 3], rated('adequate', 'poor', 'limited'), 'high'],
      ['both close-ups unusable does not', [1, 2, 3], rated('adequate', 'poor', 'poor'), 'low'],
      ['an out-of-range ref is ignored (cap stays)', [1, 9], rated('adequate', 'adequate', 'adequate'), 'low'],
      ['a tagged but uncited trouble photo does not lift it', [1], rated('adequate', 'adequate', 'adequate'), 'low'],
    ])('%s', (_name, refs, quality, expected) => {
      const f = run(zones, chinch(refs), ON, quality);
      expect(f.confidence).toBe(expected);
    });

    test('a finding citing only unusable photos is undeterminable and not localized; an unusable overview does not widen a usable close-up\'s scope', () => {
      const none = run(['close_up', 'close_up', 'close_up'], { name: 'Thinning turf', confidence: 'moderate', photo_refs: [1] }, ON, rated('poor', 'adequate', 'adequate'));
      expect(none).toMatchObject({ can_determine: false, localized: false });
      const f = run(['front', 'close_up', null], { name: 'Thinning turf', confidence: 'moderate', photo_refs: [1, 2] }, ON, rated('poor', 'adequate', 'adequate'));
      expect(f.localized).toBe(true);
      const g = run(['front', 'close_up', null], { name: 'Thinning turf', confidence: 'moderate', photo_refs: [1, 2] }, ON, rated('adequate', 'poor', 'adequate'));
      expect(g.localized).toBe(false);
    });
  });

  test('without the shot-list option the same answer is untouched: no cap, no marker', () => {
    const f = run(['front', 'close_up', 'blade_crown'], { name: 'Chinch bug damage', confidence: 'high', photo_refs: [2] });
    expect(f.confidence).toBe('high');
    expect(Object.keys(f)).not.toContain('localized');
    expect(Object.keys(f)).not.toContain('confidence_cap');
    const off = run(['front', 'close_up', 'blade_crown'], { name: 'Chinch bug damage', confidence: 'high', photo_refs: [2] }, { shotList: false });
    expect(off).toEqual(f);
  });
});

describe('eval replay picks the prompt variant from the stored capture mode', () => {
  const evalLib = require('../services/eval/lawn-visit-assessment-eval');
  const rows = (zones) => zones.map((zone, i) => ({ id: `p${i}`, s3_key: `k${i}`, photo_order: i, zone }));
  const stored = (id, meta) => ({ id, customer_id: 'c', scheduled_date: '2026-10-01', photos: meta, composite_scores: {} });
  const replay = async (testCase) => {
    dispatchWithFallback.mockReset();
    dispatchWithFallback.mockResolvedValue({ ok: true, json: answer(), provider: 'gemini', model: MODELS.GEMINI_VISION_BEST, fallbackUsed: false, usage: null, failures: [] });
    const out = await evalLib.runEval([testCase], { analyzeVisit, loadPhoto: async () => ({ data: 'YQ==', mimeType: 'image/jpeg' }) });
    return { out, payload: dispatchWithFallback.mock.calls[0][1] };
  };

  test('a marked shot-list capture replays under the shot-list prompt, version and hash', async () => {
    const meta = [{ photoVocabulary: 'shot_list_v1' }, { photoVocabulary: 'shot_list_v1' }, { photoVocabulary: 'shot_list_v1' }];
    const { out, payload } = await replay(evalLib.fixtureCase(stored('marked', meta), rows(['front', 'back', 'close_up']), {}));
    expect(payload).toMatchObject({ system: input.promptFor({ shotList: true }).system, promptVersion: 'lawn-visit-v1-shot-list' });
    expect(out.results[0].promptVersion).toBe('lawn-visit-v1-shot-list');
    expect(out.results[0].inputHash).toBe(out.results[0].contextHash);
  });

  test('a legacy capture replays under the legacy prompt, version and hash', async () => {
    const { out, payload } = await replay(evalLib.fixtureCase(stored('legacy', [{}, {}]), rows(['front', 'close_up']), {}));
    expect(payload).toMatchObject({ system: input.SYSTEM_PROMPT, promptVersion: 'lawn-visit-v1' });
    expect(out.results[0].promptVersion).toBe('lawn-visit-v1');
    expect(out.results[0].inputHash).toBe(out.results[0].contextHash);
  });
});
