// Lawn paired-photo recheck under GATE_LAWN_LIGHTING (owner 2026-10-04):
// lawn-paired-recheck-v3. Each pair carries its two photos' stored light and
// whether color may be compared; color is dropped from any pair in different or
// unknown light, both in the prompt and in code. Gate off = the v2 request and
// v2 stored record, byte for byte. Fakes only: no provider, no S3, no database.
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/service-report/lawn-visit-memory', () => ({ recordPairedRecheck: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const { recordPairedRecheck } = require('../services/service-report/lawn-visit-memory');
const recheck = require('../services/lawn-paired-recheck');
const shotList = require('../services/lawn-photo-shots');

const GATES = ['GATE_LAWN_PAIRED_RECHECK', 'GATE_LAWN_VISIT_MEMORY', 'GATE_LAWN_PROPERTY_HISTORY', 'GATE_LAWN_LIGHTING', 'GATE_LAWN_VISIT_ASSESSMENT'];
const saved = {};
beforeAll(() => GATES.forEach((g) => { saved[g] = process.env[g]; }));
afterAll(() => GATES.forEach((g) => { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; }));
beforeEach(() => {
  dispatchWithFallback.mockReset();
  recordPairedRecheck.mockReset();
  recordPairedRecheck.mockResolvedValue({ written: [], photoPairs: true });
  process.env.GATE_LAWN_PAIRED_RECHECK = 'true';
  process.env.GATE_LAWN_VISIT_MEMORY = 'true';
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  delete process.env.GATE_LAWN_LIGHTING;
  delete process.env.GATE_LAWN_VISIT_ASSESSMENT;
});

const CUR = 'as-cur';
const PRIOR = 'as-prior';
const MARK = JSON.stringify([{ filename: 'a.jpg', photoVocabulary: shotList.PHOTO_VOCABULARY }]);
const assessment = (id) => ({ id, customer_id: 'cust-1', property_id: 'prop-1', photos: MARK });
const photoRow = (assessmentId, zone) => ({
  id: `${assessmentId}-${zone}`, assessment_id: assessmentId, zone, s3_key: `lawn/${assessmentId}/${zone}.jpg`, mime_type: 'image/jpeg',
  quality_score: '80.00', quality_gate_passed: true, turf_density: null, weed_coverage: null, color_health: null, photo_order: 0,
});
const lightRun = (assessmentId, front, back) => ({
  assessment_id: assessmentId,
  photo_ids: [`${assessmentId}-front`, `${assessmentId}-back`],
  photo_quality: [
    { photo: 1, quality: 'adequate', issue: '', ...front },
    { photo: 2, quality: 'adequate', issue: '', ...back },
  ],
});
const SUN = { lighting: 'full_sun', hard_shadows: 'no' };
const CLOUD = { lighting: 'overcast', hard_shadows: 'no' };
const SHADOWY = { lighting: 'full_sun', hard_shadows: 'yes' };

function makeKnex({ runs, failRuns = false }) {
  const reads = [];
  const knex = (table) => {
    reads.push(table);
    const ctx = {};
    const chain = {
      whereIn: (_c, ids) => { ctx.ids = ids.map(String); return chain; },
      select: async () => {
        if (table === 'lawn_assessments') return [assessment(CUR), assessment(PRIOR)].filter((r) => ctx.ids.includes(r.id));
        if (table === 'lawn_assessment_photos') return ['front', 'back'].flatMap((z) => [photoRow(CUR, z), photoRow(PRIOR, z)]).filter((r) => ctx.ids.includes(r.assessment_id));
        if (table === 'lawn_assessment_runs') {
          if (failRuns) throw new Error('runs read failed');
          return runs.filter((r) => ctx.ids.includes(r.assessment_id));
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    return chain;
  };
  return { knex, reads };
}
const photoService = () => ({ getPhotoBase64: jest.fn(async (key) => ({ data: Buffer.from(key).toString('base64'), mimeType: 'image/jpeg' })) });
const ok = (json) => ({ ok: true, json, provider: 'gemini', model: 'test-model', fallbackUsed: false, usage: null, failures: [] });
const entry = { sinceLast: { priorAssessmentId: PRIOR, checks: [{ key: 'coverage', status: 'watch' }, { key: 'weeds', status: 'watch' }] } };
const ctx = { serviceRecordId: 'svc-cur', customerId: 'cust-1', assessmentId: CUR, entry };
// pair 1 (front): color is the only change; pair 2 (back): density
const answerJson = () => ({
  pairs: [{ pair: 1, verdict: 'better', what_changed: ['color'] }, { pair: 2, verdict: 'better', what_changed: ['color', 'density'] }],
  items: [
    { item: 'coverage', verdict: 'better', what_changed: ['color'], pairs: [1] },
    { item: 'weeds', verdict: 'better', what_changed: ['color', 'patch_size'], pairs: [1, 2] },
  ],
});

describe('gate off: v2, byte for byte', () => {
  test('the request is the v2 prompt and version, no light text, no run read; the stored record is stamped v2', async () => {
    const { knex, reads } = makeKnex({ runs: [] });
    dispatchWithFallback.mockResolvedValue(ok(answerJson()));
    await recheck.runPairedRecheck(ctx, { knex, photoService: photoService(), dispatch: dispatchWithFallback });
    const payload = dispatchWithFallback.mock.calls[0][1];
    expect(payload.system).toBe(recheck.SYSTEM_PROMPT);
    expect(payload.promptVersion).toBe('lawn-paired-recheck-v2');
    expect(payload.text).not.toMatch(/light|may be compared|may NOT/i);
    expect(reads).not.toContain('lawn_assessment_runs');
    const stored = recordPairedRecheck.mock.calls[0][2];
    expect(stored.rechecks.coverage).toMatchObject({ verdict: 'better', whatChanged: ['color'], promptVersion: 'lawn-paired-recheck-v2' });
    expect(stored.photoPairs[0]).toEqual({ zone: 'front', verdict: 'better', whatChanged: ['color'] });
  });

  test('buildRequest with no lighting flag is the v2 request even for pairs that carry light marks', () => {
    const pairs = [{ label: 'Front overview', beforeLight: 'full_sun', afterLight: 'overcast', colorComparable: false, beforeImage: { data: 'a', mimeType: 'image/jpeg' }, afterImage: { data: 'b', mimeType: 'image/jpeg' } }];
    const request = recheck.buildRequest({ pairs, items: [{ key: 'weeds', name: 'weeds' }] });
    expect(request.system).toBe(recheck.SYSTEM_PROMPT);
    expect(request.promptVersion).toBe('lawn-paired-recheck-v2');
    expect(request.text).toBe('1 pair of same-spot photos follow, each labeled BEFORE then AFTER:\n- Pair 1: Front overview\n\nWatch items (answer each one by its key):\n- weeds: weeds');
  });
});

describe('gate on: v3', () => {
  beforeEach(() => { process.env.GATE_LAWN_LIGHTING = 'true'; process.env.GATE_LAWN_VISIT_ASSESSMENT = 'true'; });

  test('the prompt is v2 plus the light rule, and the version is v3', () => {
    expect(recheck.LIGHTING_PROMPT_VERSION).toBe('lawn-paired-recheck-v3');
    expect(recheck.LIGHTING_SYSTEM_PROMPT.startsWith(recheck.SYSTEM_PROMPT.replace(/\nReturn JSON only, matching the schema\.$/, ''))).toBe(true);
    expect(recheck.LIGHTING_SYSTEM_PROMPT).toMatch(/When a pair line says color may NOT be compared/);
    expect(recheck.LIGHTING_SYSTEM_PROMPT).toMatch(/Judge only density .*weeds and how far damaged patches reach/);
    expect(recheck.LIGHTING_SYSTEM_PROMPT).toMatch(/never list color in what_changed/);
    expect(recheck.LIGHTING_SYSTEM_PROMPT).toMatch(/Never read shadowed turf as thinner, darker or more stressed turf, and never read sunlit turf as yellower or paler turf/);
    expect(recheck.LIGHTING_SYSTEM_PROMPT.endsWith('Return JSON only, matching the schema.')).toBe(true);
    expect(recheck.SYSTEM_PROMPT).not.toMatch(/may NOT be compared/); // v2 untouched
    expect(JSON.stringify(recheck.RESPONSE_SCHEMA)).not.toMatch(/minimum|maximum/);
  });

  test('each pair line states both lights and the rule outcome; unknown lights say so and block color', async () => {
    const { knex } = makeKnex({ runs: [lightRun(PRIOR, SUN, CLOUD), lightRun(CUR, SUN, SHADOWY)] });
    dispatchWithFallback.mockResolvedValue(ok(answerJson()));
    await recheck.runPairedRecheck(ctx, { knex, photoService: photoService(), dispatch: dispatchWithFallback });
    const payload = dispatchWithFallback.mock.calls[0][1];
    expect(payload.promptVersion).toBe('lawn-paired-recheck-v3');
    expect(payload.system).toBe(recheck.LIGHTING_SYSTEM_PROMPT);
    expect(payload.text).toContain('- Pair 1: Front overview (BEFORE light: full_sun; AFTER light: full_sun; color may be compared)');
    // hard shadows across the after photo make it a mixed read, not full sun
    expect(payload.text).toContain('- Pair 2: Back overview (BEFORE light: overcast; AFTER light: mixed_sun_shade; color may NOT be compared)');
  });

  test('a photo from a run with no stored read (any visit before the gate) is unknown and blocks color', async () => {
    const preGate = { assessment_id: PRIOR, photo_ids: [`${PRIOR}-front`, `${PRIOR}-back`], photo_quality: [{ photo: 1, quality: 'adequate', issue: '' }, { photo: 2, quality: 'adequate', issue: '' }] };
    const { knex } = makeKnex({ runs: [preGate, lightRun(CUR, SUN, SUN)] });
    dispatchWithFallback.mockResolvedValue(ok(answerJson()));
    await recheck.runPairedRecheck(ctx, { knex, photoService: photoService(), dispatch: dispatchWithFallback });
    const text = dispatchWithFallback.mock.calls[0][1].text;
    expect(text).toContain('BEFORE light: unknown; AFTER light: full_sun; color may NOT be compared');
  });

  test('color never reaches storage for a pair in different light: dropped from what_changed, a color-only verdict is not written, an item resting on it writes nothing', async () => {
    // front: sun vs sun (color allowed); back: sun vs overcast (blocked)
    const { knex } = makeKnex({ runs: [lightRun(PRIOR, SUN, SUN), lightRun(CUR, SUN, CLOUD)] });
    dispatchWithFallback.mockResolvedValue(ok({
      pairs: [{ pair: 1, verdict: 'better', what_changed: ['color'] }, { pair: 2, verdict: 'better', what_changed: ['color'] }],
      items: [
        { item: 'coverage', verdict: 'better', what_changed: ['color'], pairs: [2] },
        { item: 'weeds', verdict: 'worse', what_changed: ['color', 'patch_size'], pairs: [1, 2] },
      ],
    }));
    await recheck.runPairedRecheck(ctx, { knex, photoService: photoService(), dispatch: dispatchWithFallback });
    const stored = recordPairedRecheck.mock.calls[0][2];
    // pair 1 is in matching light: its color verdict stands; pair 2 rested on color alone in different light: not written
    expect(stored.photoPairs).toEqual([{ zone: 'front', verdict: 'better', whatChanged: ['color'] }]);
    // coverage cited only the blocked pair: nothing. weeds cites a comparable pair, so color may stay beside patch_size
    expect(stored.rechecks.coverage).toBeUndefined();
    expect(stored.rechecks.weeds).toMatchObject({ verdict: 'worse', whatChanged: ['patch_size', 'color'], pairs: ['front'], promptVersion: 'lawn-paired-recheck-v3' });
  });

  test('a blocked pair keeps its non-color change and loses only the color word', async () => {
    const { knex } = makeKnex({ runs: [lightRun(PRIOR, SUN, SUN), lightRun(CUR, CLOUD, CLOUD)] });
    dispatchWithFallback.mockResolvedValue(ok(answerJson()));
    await recheck.runPairedRecheck(ctx, { knex, photoService: photoService(), dispatch: dispatchWithFallback });
    const stored = recordPairedRecheck.mock.calls[0][2];
    expect(stored.photoPairs).toEqual([{ zone: 'back', verdict: 'better', whatChanged: ['density'] }]); // pair 1 was color-only
    expect(stored.rechecks.coverage).toBeUndefined();
    expect(stored.rechecks.weeds).toMatchObject({ verdict: 'better', whatChanged: ['patch_size'], pairs: ['back'] });
    for (const record of Object.values(stored.rechecks)) expect(record.whatChanged).not.toContain('color');
  });

  test('with several cited pairs, color stays on an item only when a cited COMPATIBLE pair itself reported color', async () => {
    // front: sun vs sun (compatible) reports density only; back: sun vs overcast (blocked) reports color
    const { knex } = makeKnex({ runs: [lightRun(PRIOR, SUN, SUN), lightRun(CUR, SUN, CLOUD)] });
    dispatchWithFallback.mockResolvedValue(ok({
      pairs: [{ pair: 1, verdict: 'better', what_changed: ['density'] }, { pair: 2, verdict: 'better', what_changed: ['color', 'density'] }],
      items: [
        { item: 'coverage', verdict: 'better', what_changed: ['color', 'density'], pairs: [1, 2] },
        { item: 'weeds', verdict: 'better', what_changed: ['color'], pairs: [1, 2] },
      ],
    }));
    await recheck.runPairedRecheck(ctx, { knex, photoService: photoService(), dispatch: dispatchWithFallback });
    const stored = recordPairedRecheck.mock.calls[0][2];
    expect(stored.rechecks.coverage.whatChanged).toEqual(['density']); // color was seen only in the blocked pair
    expect(stored.rechecks.weeds).toBeUndefined(); // color was its only change: nothing left to write
  });

  test('a FAILED read of the stored light writes nothing (never frozen as a healthy recheck)', async () => {
    const { knex } = makeKnex({ runs: [], failRuns: true });
    const out = await recheck.runPairedRecheck(ctx, { knex, photoService: photoService(), dispatch: dispatchWithFallback });
    expect(out).toEqual({ status: 'unavailable' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(recordPairedRecheck).not.toHaveBeenCalled();
  });

  test('normalizeAnswer without light marks (gate-off pairs) strips nothing', () => {
    const pairs = [{ zone: 'front' }];
    const out = recheck.normalizeAnswer(
      { pairs: [{ pair: 1, verdict: 'better', what_changed: ['color'] }], items: [{ item: 'weeds', verdict: 'better', what_changed: ['color'], pairs: [1] }] },
      { pairs, items: [{ key: 'weeds' }] },
    );
    expect(out.rechecks.weeds).toMatchObject({ whatChanged: ['color'], promptVersion: 'lawn-paired-recheck-v2' });
    expect(out.photoPairs).toEqual([{ zone: 'front', verdict: 'better', whatChanged: ['color'] }]);
  });
});
