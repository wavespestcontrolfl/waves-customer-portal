// GATE_TS_LIGHTING (owner 2026-10-23, "add to tree and shrub"): the lawn lighting-aware
// color rule applied to Tree & Shrub photo reads. Gate off = prompt, validation, stored
// data, preview response and report payload byte-identical. Gate on = the read also
// answers the photo's light (a bad answer is `unknown`, never a failed read), the light
// is stored inside composite_scores (no migration), and the Leaf Color & Vigor trend is
// dropped unless the latest two visits were read in known, compatible light.
// Synthetic data only.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const gates = require('../config/feature-gates');
const {
  VISION_PROMPT, visionPromptText, analyzePhoto, previewTreeShrubAssessment, isValidTreeShrubScores,
  normalizeTreeShrubScores, averageScores, mergePhotoComposites, scoreAndStoreTreeShrubAssessment,
  storeTreeShrubAssessmentFromReview, buildTreeShrubAssessmentReportData,
} = require('../services/tree-shrub-assessment');
const lighting = require('../services/tree-shrub-lighting');
const { buildTreeShrubReportV2 } = require('../services/service-report/tree-shrub-report-v2');
const { PALM_CROWN_PROMPT_RULE } = require('../services/service-report/tree-shrub-tech-findings');

const SCORES = {
  foliage_fullness: 70, leaf_color_vigor: 64,
  pest_signals: 'minor', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none',
  observations: 'Some thin foliage with scale-like bumps on a few leaves.',
};
const geminiResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
});
const promptOf = (call) => JSON.parse(call[1].body).contents[0].parts[1].text;

const ENV = ['GATE_TS_LIGHTING', 'GATE_TS_TECH_FINDINGS_COPY', 'GATE_TS_WATCH_LIST'];
const saved = {};
beforeEach(() => {
  jest.clearAllMocks();
  ENV.forEach((name) => { saved[name] = process.env[name]; delete process.env[name]; });
});
afterEach(() => {
  ENV.forEach((name) => { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
});
const gateOn = () => { process.env.GATE_TS_LIGHTING = 'true'; };

describe('tsLightingLive', () => {
  test('strict opt-in, read at call time', () => {
    expect(gates.tsLightingLive()).toBe(false);
    for (const value of ['1', 'TRUE', 'yes', ' true', 'false', '']) {
      process.env.GATE_TS_LIGHTING = value;
      expect(gates.tsLightingLive()).toBe(false);
    }
    gateOn();
    expect(gates.tsLightingLive()).toBe(true);
  });
});

describe('gate off: nothing changes', () => {
  test('prompt is exactly today\'s, with and without the tech-findings rule', () => {
    expect(visionPromptText()).toBe(VISION_PROMPT);
    expect(visionPromptText()).not.toMatch(/hard_shadows|LIGHT IN THE PHOTO/);
    process.env.GATE_TS_TECH_FINDINGS_COPY = 'true';
    const withRule = visionPromptText();
    expect(withRule).toBe(VISION_PROMPT.replace('Return this exact JSON structure', (m) => `${PALM_CROWN_PROMPT_RULE} In "observations", never call a palm's crown, spear leaf or newest fronds healthy, fine or normal; if only the crown is in view, say it is not clearly visible.\n\n${m}`));
    expect(withRule).not.toMatch(/hard_shadows/);
  });

  test('a light answer in a reply is ignored: no key added, merge and store carry none', async () => {
    const parsed = normalizeTreeShrubScores({ ...SCORES });
    expect(parsed).toEqual(SCORES);
    const read = { ...SCORES, lighting: 'full_sun', hard_shadows: 'no' };
    expect(averageScores(read, read).composite).not.toHaveProperty('lighting');
    expect(mergePhotoComposites([read])).not.toHaveProperty('light');
    expect(mergePhotoComposites([read])).not.toHaveProperty('photo_lights');
    const preview = await previewTreeShrubAssessment({
      photos: [{}], loadImage: async () => ({ base64: 'x' }), analyze: async () => ({ composite: read }),
    });
    expect(preview).not.toHaveProperty('photoLights');
  });

  test('a signed light is not stored and the stored object is {ai, reviewed} only', async () => {
    const review = { photoLights: [{ lighting: 'full_sun', hard_shadows: false }], lightSignature: lighting.lightSignature([{ lighting: 'full_sun', hard_shadows: false }], 's1', 'h') };
    expect(lighting.verifiedLightFromReview(review, 's1', 'h')).toBeNull();
    const inserts = [];
    const knex = (table) => ({
      where() { return { first: () => Promise.resolve(null), catch: () => Promise.resolve(null) }; },
      insert(row) { if (table === 'tree_shrub_assessments') inserts.push(row); return { returning: () => Promise.resolve([{ id: 'a1' }]), catch: () => Promise.resolve([{ id: 'a1' }]) }; },
    });
    await storeTreeShrubAssessmentFromReview({ service: { id: 'r1', customer_id: 'c1' }, scores: { pestActivity: 50 }, decisions: [], photos: [], knex });
    expect(inserts[0].composite_scores).toBe(JSON.stringify({ ai: { pestActivity: 50 }, reviewed: [] }));
  });
});

describe('gate on: the read', () => {
  test('both models are asked for the light, after the plant rules and inside the JSON block', async () => {
    gateOn();
    const prompt = visionPromptText();
    expect(prompt).toContain('LIGHT IN THE PHOTO');
    expect(prompt).toContain('"lighting": <"full_sun" | "overcast" | "open_shade" | "mixed_sun_shade" | "low_light" | "unknown">');
    expect(prompt).toContain('"hard_shadows": <"yes" | "no" | "unknown">');
    expect(prompt.indexOf('LIGHT IN THE PHOTO')).toBeLessThan(prompt.indexOf('Return this exact JSON structure'));
    expect(prompt.endsWith('"hard_shadows": <"yes" | "no" | "unknown">\n}')).toBe(true);
    expect(prompt.startsWith(VISION_PROMPT.slice(0, 400))).toBe(true);

    global.fetch = jest.fn(async () => geminiResponse(SCORES));
    await analyzePhoto('abc', 'image/jpeg');
    expect(promptOf(global.fetch.mock.calls[0])).toBe(prompt);

    // Gemini miss: the Claude stand-in gets the same ask.
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, statusText: 'x' }));
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ ...SCORES, lighting: 'overcast', hard_shadows: 'no' }) }] });
    const out = await analyzePhoto('abc', 'image/jpeg');
    expect(mockAnthropicCreate.mock.calls[0][0].messages[0].content[1].text).toBe(prompt);
    expect(out.composite).toMatchObject({ lighting: 'overcast', hard_shadows: 'no' });
  });

  test('a missing or invalid light answer becomes unknown and the read is still accepted', async () => {
    gateOn();
    for (const bad of [{}, { lighting: 'sunny', hard_shadows: 'maybe' }, { lighting: 7, hard_shadows: null }, { lighting: '', hard_shadows: [] }]) {
      global.fetch = jest.fn(async () => geminiResponse({ ...SCORES, ...bad }));
      const out = await analyzePhoto('abc', 'image/jpeg');
      expect(out).toBeTruthy();
      expect(out.gemini).toMatchObject({ lighting: 'unknown', hard_shadows: 'unknown' });
      expect(out.composite).toMatchObject({ lighting: 'unknown', hard_shadows: 'unknown' });
      expect(isValidTreeShrubScores(out.gemini)).toBe(true);
    }
    // A valid answer is kept, trimmed and lowercased.
    global.fetch = jest.fn(async () => geminiResponse({ ...SCORES, lighting: ' Open_Shade ', hard_shadows: 'NO' }));
    expect((await analyzePhoto('abc', 'image/jpeg')).composite).toMatchObject({ lighting: 'open_shade', hard_shadows: 'no' });
  });
});

describe('gate on: storage (existing composite_scores jsonb, no migration)', () => {
  const read = (lightingWord, hard = 'no') => ({ composite: { ...SCORES, lighting: lightingWord, hard_shadows: hard } });
  function captureKnex() {
    const inserts = { tree_shrub_assessments: [], tree_shrub_assessment_photos: [] };
    const knex = (table) => ({
      where() { return { first: () => Promise.resolve(null), catch: () => Promise.resolve(null) }; },
      insert(row) { inserts[table].push(row); return { returning: () => Promise.resolve([{ id: 'a1' }]), catch: () => Promise.resolve([{ id: 'a1' }]) }; },
    });
    return { knex, inserts };
  }
  async function autoScore(...reads) {
    const { knex, inserts } = captureKnex();
    let i = 0;
    await scoreAndStoreTreeShrubAssessment({
      service: { id: 'r1', customer_id: 'c1' },
      photos: reads.map((_, n) => ({ tag: `p${n}` })),
      loadImage: async (p) => ({ base64: p.tag }),
      analyze: async () => reads[i++],
      knex,
    });
    return JSON.parse(inserts.tree_shrub_assessments[0].composite_scores);
  }

  test('auto-score stores each photo\'s read and the visit light', async () => {
    gateOn();
    const stored = await autoScore(read('full_sun'), read('full_sun', 'yes'));
    expect(stored.light).toBe('mixed_sun_shade');
    expect(stored.photo_lights).toEqual([
      { lighting: 'full_sun', hard_shadows: false },
      { lighting: 'full_sun', hard_shadows: true },
    ]);
  });

  test('visit light follows the lawn rule: same, diffuse group, sun beside cloud, unknown', async () => {
    gateOn();
    expect((await autoScore(read('overcast'), read('overcast'))).light).toBe('overcast');
    expect((await autoScore(read('overcast'), read('open_shade'))).light).toBe('overcast');
    expect((await autoScore(read('full_sun'), read('overcast'))).light).toBe('mixed_light');
    expect((await autoScore(read('full_sun'), read('unknown'))).light).toBe('unknown');
    expect((await autoScore(read('overcast', 'yes'))).light).toBe('mixed_light'); // diffuse with hard shadows contradicts itself
    expect((await autoScore(read('low_light'))).light).toBe('low_light');
  });

  test('a photo with no read makes the visit light unknown', async () => {
    gateOn();
    const stored = await autoScore(read('full_sun'), { composite: { ...SCORES } });
    expect(stored.light).toBe('unknown');
  });

  test('preview carries the reads; the signed light is stored by the closeout path only if the signature holds', async () => {
    gateOn();
    const reads = [read('overcast'), read('open_shade')];
    let i = 0;
    const preview = await previewTreeShrubAssessment({
      photos: [{}, {}], loadImage: async () => ({ base64: 'x' }), analyze: async () => reads[i++],
    });
    expect(preview.photoLights).toEqual([
      { lighting: 'overcast', hard_shadows: false },
      { lighting: 'open_shade', hard_shadows: false },
    ]);
    const lightSignature = lighting.lightSignature(preview.photoLights, 's1', 'hash');
    const review = { photoLights: preview.photoLights, lightSignature };
    expect(lighting.verifiedLightFromReview(review, 's1', 'hash')).toEqual({ light: 'overcast', photo_lights: preview.photoLights });
    // Forged reads, another visit, another photo set, no signature: unknown (null).
    expect(lighting.verifiedLightFromReview({ ...review, photoLights: [{ lighting: 'full_sun' }, { lighting: 'full_sun' }] }, 's1', 'hash')).toBeNull();
    expect(lighting.verifiedLightFromReview(review, 's2', 'hash')).toBeNull();
    expect(lighting.verifiedLightFromReview(review, 's1', 'other')).toBeNull();
    expect(lighting.verifiedLightFromReview({ photoLights: preview.photoLights }, 's1', 'hash')).toBeNull();
    expect(lighting.verifiedLightFromReview({}, 's1', 'hash')).toBeNull();

    const { knex, inserts } = captureKnex();
    await storeTreeShrubAssessmentFromReview({
      service: { id: 'r1', customer_id: 'c1' }, scores: { pestActivity: 50 }, decisions: [], photos: [], knex,
      light: lighting.verifiedLightFromReview(review, 's1', 'hash'),
    });
    expect(JSON.parse(inserts.tree_shrub_assessments[0].composite_scores)).toEqual({
      ai: { pestActivity: 50 }, reviewed: [], light: 'overcast', photo_lights: preview.photoLights,
    });
  });
});

describe('the Leaf Color & Vigor trend', () => {
  // Three visits, color moving 60 -> 70 -> 80; `lights` are the stored composite_scores.light of each.
  function loaderKnex(lights) {
    const rows = lights.map((light, n) => ({
      id: `a${n + 1}`, customer_id: 'c1', service_date: `2026-0${n + 3}-10`, confirmed_by_tech: true,
      foliage_fullness: 70 + n, leaf_color_vigor: 60 + 10 * n, pest_activity: 75, disease_leaf_spot: 90, water_heat_stress: 75, overall_score: 72 + n,
      composite_scores: light === undefined ? null : JSON.stringify({ light, photo_lights: [] }),
    }));
    const latest = rows[rows.length - 1];
    return (table) => {
      const data = table === 'tree_shrub_assessment_photos' ? [] : rows;
      const b = {
        where: () => b, orderBy: () => b, limit: () => b,
        first: () => Promise.resolve(table === 'tree_shrub_assessments' ? latest : null),
        then: (res) => Promise.resolve(data).then(res),
        catch: () => Promise.resolve(data),
      };
      return b;
    };
  }
  async function trendsFor(lights) {
    const data = await buildTreeShrubAssessmentReportData({ id: 'r3', customer_id: 'c1', service_date: '2026-05-10' }, 'tree_shrub', loaderKnex(lights));
    return { data, trends: buildTreeShrubReportV2({ treeShrubAssessment: data }).trends };
  }

  test('gate off: the color trend stays whatever the light, and the payload has no light key', async () => {
    const { data, trends } = await trendsFor(['full_sun', 'overcast', 'unknown']);
    expect(trends.color).toHaveLength(3);
    expect(data).not.toHaveProperty('colorTrendLightAware');
    expect(data.trend.every((p) => !('light' in p))).toBe(true);
    expect((await trendsFor([undefined, undefined, undefined])).trends.color).toHaveLength(3);
  });

  test('gate on: compatible light keeps the series (sun with sun-and-shadow, overcast with open shade)', async () => {
    gateOn();
    expect((await trendsFor(['full_sun', 'full_sun', 'mixed_sun_shade'])).trends.color).toHaveLength(3);
    expect((await trendsFor(['overcast', 'overcast', 'open_shade'])).trends.color).toHaveLength(3);
  });

  test('gate on: sun against overcast, unknown, no read and mixed light drop the series, nothing else', async () => {
    gateOn();
    for (const lights of [
      ['full_sun', 'full_sun', 'overcast'],
      ['overcast', 'overcast', 'full_sun'],
      ['full_sun', 'full_sun', 'unknown'],
      ['full_sun', 'full_sun', undefined], // newest visit has no read
      ['full_sun', undefined, 'full_sun'], // the visit before it has no read
      ['full_sun', 'full_sun', 'mixed_light'], // the visit's own photos disagree
      ['mixed_light', 'mixed_light', 'mixed_light'], // mixed light is compared with nothing
      ['full_sun', 'full_sun', 'low_light'],
    ]) {
      const { data, trends } = await trendsFor(lights);
      expect(data.colorTrendLightAware).toBe(true);
      expect(trends).not.toHaveProperty('color');
      expect(trends.overall).toHaveLength(3);
      expect(trends.foliage).toHaveLength(3);
      expect(trends.pest).toHaveLength(3);
      expect(trends.water).toHaveLength(3);
    }
  });

  test('gate on: only the latest two visits decide, older mismatches do not', async () => {
    gateOn();
    expect((await trendsFor(['overcast', 'full_sun', 'full_sun'])).trends.color).toHaveLength(3);
  });

  test('a non-numeric stored light word is unknown', () => {
    expect(lighting.storedVisitLight(JSON.stringify({ light: 'sunny' }))).toBe('unknown');
    expect(lighting.storedVisitLight('not json')).toBe('unknown');
    expect(lighting.storedVisitLight({ light: 'open_shade' })).toBe('open_shade');
  });
});
