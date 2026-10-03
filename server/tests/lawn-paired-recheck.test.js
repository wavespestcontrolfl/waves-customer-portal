// Lawn paired-photo recheck (lawn report rebuild P19b, GATE_LAWN_PAIRED_RECHECK;
// owner ruling 2026-09-29 round 3b). Synthetic data only; no real provider, no
// real S3, no real database: the dispatcher, the photo store and knex are fakes.
//
// Pins: gate off = no call, no read, no write; same-premises / same-shot pair
// formation off the frozen prior; usable photos only; trouble never pairs; the
// request carries no score, product or prior verdict; the schema has no numeric
// bounds; verdict -> stored recheck -> the progress engine's states; cannot_tell
// writes nothing; fail-open on every miss.

jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const logger = require('../services/logger');
const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const shotList = require('../services/lawn-photo-shots');
const recheck = require('../services/lawn-paired-recheck');
const { buildLawnProgress } = require('../services/service-report/lawn-progress');
const { storedVisitMemoryFor, publicSinceLast } = require('../services/service-report/lawn-visit-memory');

const GATES = ['GATE_LAWN_PAIRED_RECHECK', 'GATE_LAWN_VISIT_MEMORY'];
const saved = {};
beforeAll(() => GATES.forEach((g) => { saved[g] = process.env[g]; }));
afterAll(() => GATES.forEach((g) => { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; }));
const gateOn = () => { process.env.GATE_LAWN_PAIRED_RECHECK = 'true'; process.env.GATE_LAWN_VISIT_MEMORY = 'true'; };
const gateOff = () => { delete process.env.GATE_LAWN_PAIRED_RECHECK; process.env.GATE_LAWN_VISIT_MEMORY = 'true'; };

const SHOT_LIST_META = [{ filename: 'a.jpg', photoVocabulary: shotList.PHOTO_VOCABULARY }];
const assessment = (id, over = {}) => ({ id, customer_id: 'cust-1', property_id: 'prop-1', photos: JSON.stringify(SHOT_LIST_META), ...over });
const photo = (assessmentId, zone, over = {}) => ({
  id: `${assessmentId}-${zone}`, assessment_id: assessmentId, zone, s3_key: `lawn/${assessmentId}/${zone}.jpg`, mime_type: 'image/jpeg',
  quality_score: '80.00', quality_gate_passed: true, turf_density: null, weed_coverage: null, color_health: null, photo_order: 0, ...over,
});
const CUR = 'as-cur';
const PRIOR = 'as-prior';
const fullWorld = () => ({
  current: assessment(CUR),
  prior: assessment(PRIOR),
  currentPhotos: ['front', 'back', 'side', 'close_up', 'trouble'].map((z) => photo(CUR, z)),
  priorPhotos: ['front', 'back', 'side', 'close_up', 'trouble'].map((z) => photo(PRIOR, z)),
});

describe('pair formation', () => {
  test('same premises, same shot: front, back and side pair; close-up and problem-area never do', () => {
    const pairs = recheck.formPairs(fullWorld());
    expect(pairs.map((p) => p.zone)).toEqual(['front', 'back', 'side']);
    expect(pairs.map((p) => p.label)).toEqual(['Front overview', 'Back overview', 'Side overview']);
    for (const p of pairs) {
      expect(p.before.assessment_id).toBe(PRIOR);
      expect(p.after.assessment_id).toBe(CUR);
      expect(p.before.zone).toBe(p.after.zone);
    }
  });

  test('a problem-area photo on both visits is NOT paired: nothing in a stored photo says it is the same item (no guess)', () => {
    const world = fullWorld();
    world.currentPhotos = [photo(CUR, 'trouble'), photo(CUR, 'trouble', { id: 'x2', photo_order: 1 })];
    world.priorPhotos = [photo(PRIOR, 'trouble'), photo(PRIOR, 'trouble', { id: 'y2', photo_order: 1 })];
    expect(recheck.formPairs(world)).toEqual([]);
  });

  test('never a different customer or a different / unrecorded property', () => {
    expect(recheck.formPairs({ ...fullWorld(), prior: assessment(PRIOR, { customer_id: 'cust-2' }) })).toEqual([]);
    expect(recheck.formPairs({ ...fullWorld(), prior: assessment(PRIOR, { property_id: 'prop-2' }) })).toEqual([]);
    expect(recheck.formPairs({ ...fullWorld(), prior: assessment(PRIOR, { property_id: null }) })).toEqual([]);
    expect(recheck.formPairs({ ...fullWorld(), current: assessment(CUR, { property_id: null }), prior: assessment(PRIOR, { property_id: null }) })).toEqual([]);
    expect(recheck.formPairs({ ...fullWorld(), prior: null })).toEqual([]);
    expect(recheck.formPairs({ ...fullWorld(), prior: assessment(CUR) })).toEqual([]);
  });

  test('back and side pair only when BOTH visits were captured under the shot list; front always', () => {
    const noMarker = (id) => assessment(id, { photos: JSON.stringify([{ filename: 'a.jpg' }]) });
    for (const world of [
      { ...fullWorld(), prior: noMarker(PRIOR) },
      { ...fullWorld(), current: noMarker(CUR) },
      { ...fullWorld(), current: noMarker(CUR), prior: noMarker(PRIOR) },
    ]) {
      expect(recheck.formPairs(world).map((p) => p.zone)).toEqual(['front']);
    }
  });

  test('only a usable photo counts, on BOTH sides: poor, unrated and gate-failed photos form no pair', () => {
    for (const bad of [
      { quality_score: '20.00' }, { quality_score: '0' }, { quality_score: null }, { quality_gate_passed: false }, { s3_key: 'pending/as-cur/a.jpg' }, { s3_key: null },
    ]) {
      const afterBad = { ...fullWorld(), currentPhotos: [photo(CUR, 'front', bad)] };
      const beforeBad = { ...fullWorld(), priorPhotos: [photo(PRIOR, 'front', bad)] };
      expect(recheck.formPairs(afterBad)).toEqual([]);
      expect(recheck.formPairs(beforeBad)).toEqual([]);
    }
    // limited (55) is usable
    const limited = { ...fullWorld(), currentPhotos: [photo(CUR, 'front', { quality_score: '55.00' })], priorPhotos: [photo(PRIOR, 'front', { quality_score: '45' })] };
    expect(recheck.formPairs(limited).map((p) => p.zone)).toEqual(['front']);
  });

  test('a shot on only one side forms no pair; the best usable photo of a shot is chosen', () => {
    const one = { ...fullWorld(), currentPhotos: [photo(CUR, 'front')], priorPhotos: [photo(PRIOR, 'back')] };
    expect(recheck.formPairs(one)).toEqual([]);
    const dup = {
      ...fullWorld(),
      currentPhotos: [photo(CUR, 'front', { id: 'lo', quality_score: '60' }), photo(CUR, 'front', { id: 'hi', quality_score: '90' }), photo(CUR, 'front', { id: 'poor', quality_score: '10' })],
      priorPhotos: [photo(PRIOR, 'front')],
    };
    expect(recheck.formPairs(dup)[0].after.id).toBe('hi');
  });

  test('the pair cap holds and matches the pairable shots', () => {
    expect(recheck.MAX_PAIRS).toBe(shotList.PAIRABLE_SHOT_ZONES.length);
    expect(recheck.formPairs(fullWorld()).length).toBeLessThanOrEqual(recheck.MAX_PAIRS);
  });
});

describe('watch items', () => {
  test('known topics only, once each, none that already carry a recheck or an override', () => {
    const items = recheck.watchItemsFrom({
      checks: [
        { key: 'weeds', status: 'watch' }, { key: 'weeds', status: 'watch' }, { key: 'water', status: 'needs_attention', recheck: { verdict: 'same', source: 'office_review' } },
        { key: 'coverage', status: 'watch', recheckOverride: { verdict: 'worse', source: 'office_review' } }, { key: 'mystery', status: 'watch' }, { key: 'damage', status: 'watch' },
        { key: 'mowing', status: 'watch' }, null,
      ],
    });
    expect(items).toEqual([{ key: 'weeds', name: recheck.ITEM_NAMES.weeds }, { key: 'damage', name: recheck.ITEM_NAMES.damage }]);
    expect(recheck.watchItemsFrom(null)).toEqual([]);
  });

  test('label table: every label is neutral about cause and direction; mowing is never put to the model', () => {
    expect(recheck.ITEM_NAMES).toEqual({
      water: 'areas with a watering problem (too dry or too wet)',
      weeds: 'weeds growing among the turf',
      damage: 'areas of turf showing stress or damage (cause not known)',
      coverage: 'thin or uneven-colored areas of turf',
    });
    // the frozen water check stores only { key, status } (no moisture direction), so the label names neither
    expect(recheck.ITEM_NAMES.water).toMatch(/too dry or too wet/);
    for (const label of Object.values(recheck.ITEM_NAMES)) {
      expect(label).not.toMatch(/drought|overwater|disease|fung|insect|chinch|bare|scalp|mow|irrigat|sprinkler/i);
    }
    expect(recheck.ITEM_NAMES.mowing).toBeUndefined();
    expect(recheck.watchItemsFrom({ checks: [{ key: 'mowing', status: 'watch' }] })).toEqual([]);
  });

  test('the prompt tells the model to answer better / same / worse only, never direction or cause', () => {
    expect(recheck.SYSTEM_PROMPT).toMatch(/Never say which direction the problem runs/);
    expect(recheck.SYSTEM_PROMPT).toMatch(/using its key exactly as given/);
  });
});

describe('the request', () => {
  const loaded = () => recheck.formPairs(fullWorld()).slice(0, 2).map((p) => ({ ...p, beforeImage: { data: 'QkVGT1JF', mimeType: 'image/jpeg' }, afterImage: { data: 'QUZURVI=', mimeType: 'image/png' } }));
  const items = [{ key: 'weeds', name: recheck.ITEM_NAMES.weeds }, { key: 'water', name: recheck.ITEM_NAMES.water }];

  test('one request: before then after per pair, labeled by view; photos, view names and watch names only', () => {
    const payload = recheck.buildRequest({ pairs: loaded(), items });
    expect(payload.images.map((i) => i.label)).toEqual([
      'Pair 1 BEFORE (Front overview)', 'Pair 1 AFTER (Front overview)', 'Pair 2 BEFORE (Back overview)', 'Pair 2 AFTER (Back overview)',
    ]);
    expect(payload.images[3]).toMatchObject({ data: 'QUZURVI=', mimeType: 'image/png' });
    expect(payload).toMatchObject({ jsonMode: true, laneId: 'lawn_paired_recheck', promptVersion: recheck.PROMPT_VERSION, jsonSchema: recheck.RESPONSE_SCHEMA });
    expect(payload.text).toContain('- weeds: weeds growing among the turf');
    expect(payload.text).toContain('- Pair 2: Back overview');
  });

  test('perception hygiene: no score, product, prior status or verdict anywhere in what the model is sent', () => {
    const payload = recheck.buildRequest({ pairs: loaded(), items });
    // Everything that varies per visit: the text and the photo labels.
    const dynamic = JSON.stringify({ text: payload.text, labels: payload.images.map(({ label }) => label) });
    expect(dynamic).not.toMatch(/score|product|applied|fungicide|herbicide|insecticide|needs_attention|improv|on.track|behind|checked_|prior|verdict/i);
    expect(dynamic).not.toMatch(/\b\d{2,3}(\.\d+)?\b/); // no number the size of a score (pair numbers are single digits)
    // The fixed prompt tells the model it knows nothing else and names no product or class.
    expect(recheck.SYSTEM_PROMPT).toMatch(/no scores, no treatments, no earlier opinion/);
    expect(recheck.SYSTEM_PROMPT).not.toMatch(/fungicide|herbicide|insecticide|fertilizer|celsius|talstar/i);
  });

  test('the response schema has no numeric minimum / maximum bound anywhere, and closes every object', () => {
    const walk = (node, visit) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
      if (node && typeof node === 'object') { visit(node); Object.values(node).forEach((n) => walk(n, visit)); }
      return null;
    };
    const keys = new Set();
    const objects = [];
    walk(recheck.RESPONSE_SCHEMA, (node) => { Object.keys(node).forEach((k) => keys.add(k)); if (node.type === 'object') objects.push(node); });
    for (const banned of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'multipleOf']) {
      expect(keys.has(banned)).toBe(false);
    }
    for (const node of objects) {
      expect(node.additionalProperties).toBe(false);
      expect([...(node.required || [])].sort()).toEqual(Object.keys(node.properties).sort());
    }
  });

  test('the lane is registered on the vision policy: Gemini then Sol, the lawn photo lane\'s models', () => {
    const policy = MODELS.TEXT_POLICIES.lawnPairedRecheck;
    expect(policy.primary).toEqual(MODELS.TEXT_POLICIES.lawnVisitAssessment.primary);
    expect(policy.fallback).toEqual(MODELS.TEXT_POLICIES.lawnVisitAssessment.fallback);
    expect(policy.primary.provider).toBe('gemini');
    expect(policy.fallback.provider).toBe('openai');
  });
});

describe('answer validation and normalization', () => {
  const pairs = [{ zone: 'front' }, { zone: 'back' }];
  const items = [{ key: 'weeds' }, { key: 'water' }];
  const answer = (over = {}) => ({
    pairs: [{ pair: 1, verdict: 'better', what_changed: ['color', 'patch_size'] }, { pair: 2, verdict: 'cannot_tell', what_changed: [] }],
    items: [
      { item: 'weeds', verdict: 'better', what_changed: ['patch_size', 'color'], pairs: [1] },
      { item: 'water', verdict: 'same', what_changed: ['edge'], pairs: [1, 2] },
    ],
    ...over,
  });

  const ASKED = { pairCount: 2, itemKeys: ['weeds', 'water'] };

  test('a conforming answer passes; bad enums, pair numbers and shapes are rejected (so the fallback gets its turn)', () => {
    expect(recheck.answerProblem(answer(), ASKED)).toBeNull();
    expect(recheck.answerProblem(null, ASKED)).toBe('schema_invalid');
    expect(recheck.answerProblem({ pairs: [] }, ASKED)).toBe('schema_invalid');
    const bad = [
      answer({ pairs: [{ pair: 3, verdict: 'better', what_changed: [] }] }),
      answer({ pairs: [{ pair: 0, verdict: 'better', what_changed: [] }] }),
      answer({ pairs: [{ pair: 1.5, verdict: 'better', what_changed: [] }] }),
      answer({ pairs: [{ pair: 1, verdict: 'much better', what_changed: [] }, { pair: 2, verdict: 'same', what_changed: [] }] }),
      answer({ pairs: [{ pair: 1, verdict: 'better', what_changed: ['the grass looks lovely'] }, { pair: 2, verdict: 'same', what_changed: [] }] }),
      answer({ items: [{ item: 'weeds', verdict: 'better', what_changed: [], pairs: [5] }, { item: 'water', verdict: 'same', what_changed: [], pairs: [1] }] }),
      answer({ items: [{ item: 'weeds', verdict: 'maybe', what_changed: [], pairs: [1] }, { item: 'water', verdict: 'same', what_changed: [], pairs: [1] }] }),
    ];
    for (const b of bad) expect(recheck.answerProblem(b, ASKED)).not.toBeNull();
  });

  test('EXACT coverage: a missing, extra, duplicate or empty pair / item list is rejected', () => {
    const p = (n) => ({ pair: n, verdict: 'same', what_changed: [] });
    const i = (item) => ({ item, verdict: 'same', what_changed: [], pairs: [1] });
    const cases = {
      'missing pair': [answer({ pairs: [p(1)] }), 'incomplete_pairs'],
      'extra pair': [answer({ pairs: [p(1), p(2), p(3)] }), 'invalid_pair'],
      'duplicate pair': [answer({ pairs: [p(1), p(1)] }), 'invalid_pair'],
      'empty pairs': [answer({ pairs: [] }), 'incomplete_pairs'],
      'missing item': [answer({ items: [i('weeds')] }), 'incomplete_items'],
      'unknown item': [answer({ items: [i('weeds'), i('water'), i('mowing')] }), 'unknown_item'],
      'only unknown items': [answer({ items: [i('mowing'), i('lawn')] }), 'unknown_item'],
      'duplicate item': [answer({ items: [i('weeds'), i('weeds')] }), 'invalid_item'],
      'duplicate item by case': [answer({ items: [i('weeds'), i(' WEEDS ')] }), 'invalid_item'],
      'empty items': [answer({ items: [] }), 'incomplete_items'],
      'both empty': [{ pairs: [], items: [] }, 'incomplete_pairs'],
    };
    for (const [name, [json, reason]] of Object.entries(cases)) expect([name, recheck.answerProblem(json, ASKED)]).toEqual([name, reason]);
    // key matching is trim + lowercase, the way the request sends keys; any order is fine
    const loose = answer({ items: [i(' Water '), i('WEEDS')], pairs: [p(2), p(1)] });
    expect(recheck.answerProblem(loose, ASKED)).toBeNull();
    // no request context, no validation to pass
    expect(recheck.answerProblem(answer(), { pairCount: 2 })).toBe('no_request_context');
  });

  test('better / worse / same earn a record naming the closed change set and the zones used; same names no change', () => {
    const out = recheck.normalizeAnswer(answer(), { pairs, items });
    expect(out.rechecks.weeds).toEqual({
      verdict: 'better', source: 'photo_pair', whatChanged: ['patch_size', 'color'], pairs: ['front'], promptVersion: recheck.PROMPT_VERSION,
    });
    // pair 2 was cannot_tell, so only pair 1 counts for the "same" item
    expect(out.rechecks.water).toMatchObject({ verdict: 'same', whatChanged: [], pairs: ['front'] });
    expect(out.photoPairs).toEqual([{ zone: 'front', verdict: 'better', whatChanged: ['patch_size', 'color'] }]);
  });

  test('cannot_tell, an item citing no readable pair, and a better / worse with no named change write NOTHING', () => {
    const out = recheck.normalizeAnswer(answer({
      items: [
        { item: 'weeds', verdict: 'cannot_tell', what_changed: [], pairs: [] },
        { item: 'water', verdict: 'worse', what_changed: ['color'], pairs: [2] },
        { item: 'damage', verdict: 'better', what_changed: ['color'], pairs: [2] },
      ],
    }), { pairs, items: [...items, { key: 'damage' }] });
    expect(out.rechecks).toEqual({});
    const noChange = recheck.normalizeAnswer(answer({ items: [{ item: 'weeds', verdict: 'better', what_changed: [], pairs: [1] }] }), { pairs, items });
    expect(noChange.rechecks).toEqual({});
    const unasked = recheck.normalizeAnswer(answer({ items: [{ item: 'mowing', verdict: 'better', what_changed: ['color'], pairs: [1] }] }), { pairs, items });
    expect(unasked.rechecks).toEqual({});
  });
});

// ── the job, against fakes ────────────────────────────────────────────────
function makeWorld({ world = fullWorld(), sinceLast, notes } = {}) {
  const entry = {
    v: 1, assessmentId: CUR, serviceDate: '2026-09-30', applied: [{ name: 'Test Fungicide A', kind: 'fungicide', tag: 'fungus protection', targets: [], activeIngredient: 'Test Active 10%' }],
    checks: [{ key: 'weeds', status: 'watch' }],
    sinceLast: sinceLast === undefined ? {
      v: 1, priorAssessmentId: PRIOR, priorDate: '2026-08-30',
      applied: [{ name: 'Test Herbicide B', activeIngredient: 'Test Active 20%', kind: 'herbicide', tag: 'weed control', targets: ['weeds'] }],
      checks: [{ key: 'weeds', status: 'needs_attention' }, { key: 'water', status: 'watch' }],
    } : sinceLast,
  };
  const records = { 'svc-cur': { structured_notes: notes || { keep: 'me', lawnVisitMemory: { [CUR]: entry } } } };
  const log = { tables: [], updates: [] };
  const state = { beforeUpdate: null };
  const knex = (table) => {
    log.tables.push(table);
    const ctx = { where: {}, raw: null };
    const chain = {
      whereIn(_col, ids) {
        ctx.ids = ids.map(String);
        return chain;
      },
      select() {
        if (table === 'lawn_assessments') return Promise.resolve([world.current, world.prior].filter((r) => r && ctx.ids.includes(String(r.id))));
        return Promise.resolve([...world.currentPhotos, ...world.priorPhotos].filter((r) => ctx.ids.includes(String(r.assessment_id))));
      },
      where(cond) { Object.assign(ctx.where, cond); return chain; },
      whereRaw(_sql, bindings) { ctx.raw = bindings; return chain; },
      async first() { return { structured_notes: records[ctx.where.id].structured_notes }; },
      async update(patch) {
        if (state.beforeUpdate) { const hook = state.beforeUpdate; state.beforeUpdate = null; hook(); }
        const rec = records[ctx.where.id];
        const map = rec.structured_notes.lawnVisitMemory || {};
        const [aid, expected] = ctx.raw;
        // compare-and-set on the entry as read (jsonb equality)
        if (JSON.stringify(canonical(map[aid])) !== JSON.stringify(canonical(JSON.parse(expected)))) return 0;
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        rec.structured_notes = { ...rec.structured_notes, lawnVisitMemory: { ...map, ...add } };
        log.updates.push(add);
        return 1;
      },
    };
    return chain;
  };
  knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return { knex, records, entry, log, state };
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => ({ ...o, [k]: canonical(v[k]) }), {});
  return v;
}
const photoService = () => ({ getPhotoBase64: jest.fn(async (key) => ({ data: Buffer.from(key).toString('base64'), mimeType: 'image/jpeg' })) });
const okAnswer = (json) => ({ ok: true, json, provider: 'gemini', model: 'test-model', fallbackUsed: false, usage: { input_tokens: 9000, output_tokens: 300 }, failures: [] });
const goodJson = () => ({
  pairs: [
    { pair: 1, verdict: 'better', what_changed: ['color'] },
    { pair: 2, verdict: 'same', what_changed: [] },
    { pair: 3, verdict: 'cannot_tell', what_changed: [] },
  ],
  items: [
    { item: 'weeds', verdict: 'better', what_changed: ['patch_size'], pairs: [1, 2] },
    { item: 'water', verdict: 'cannot_tell', what_changed: [], pairs: [] },
  ],
});
const ctxOf = (w) => ({ serviceRecordId: 'svc-cur', customerId: 'cust-1', assessmentId: CUR, entry: w.entry });

beforeEach(() => { dispatchWithFallback.mockReset(); jest.clearAllMocks(); gateOn(); });

describe('gate off', () => {
  test('no model call, no photo read, no database touch, no write; the schedule hook is inert', async () => {
    gateOff();
    const w = makeWorld();
    const ps = photoService();
    expect(await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: ps, dispatch: dispatchWithFallback })).toEqual({ status: 'off' });
    expect(recheck.scheduleAfterFreeze(ctxOf(w), { knex: w.knex, photoService: ps })).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(ps.getPhotoBase64).not.toHaveBeenCalled();
    expect(w.log.tables).toEqual([]);
    expect(w.log.updates).toEqual([]);
  });

  test('the gate needs the visit memory it writes onto', async () => {
    process.env.GATE_LAWN_VISIT_MEMORY = 'false';
    const w = makeWorld();
    expect(await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, dispatch: dispatchWithFallback })).toEqual({ status: 'off' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});

describe('the job', () => {
  test('one call over every pair; the verdict lands on the check in the frozen entry, first writer wins, nothing else changes', async () => {
    const w = makeWorld();
    dispatchWithFallback.mockResolvedValue(okAnswer(goodJson()));
    const ps = photoService();
    const out = await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: ps, dispatch: dispatchWithFallback });
    expect(out).toMatchObject({ status: 'stored', written: ['weeds'], photoPairs: true });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.lawnPairedRecheck);
    expect(payload.images).toHaveLength(6);
    expect(payload.laneId).toBe('lawn_paired_recheck');
    expect(options.validate({ json: goodJson() })).toBeNull();
    expect(options.validate({ json: { nope: true } })).toBe('schema_invalid');
    expect(options.validate({ json: { pairs: [], items: [] } })).toBe('incomplete_pairs');
    expect(options).toMatchObject({ reserveFallbackBudget: true, hardDeadline: true });
    // the pairs are last visit's (frozen prior) photo then today's, same shot
    expect(ps.getPhotoBase64.mock.calls.map(([k]) => k).slice(0, 2).sort()).toEqual([`lawn/${CUR}/front.jpg`, `lawn/${PRIOR}/front.jpg`]);

    const stored = storedVisitMemoryFor(w.records['svc-cur'].structured_notes, CUR);
    const weeds = stored.sinceLast.checks.find((c) => c.key === 'weeds');
    expect(weeds).toEqual({
      key: 'weeds', status: 'needs_attention',
      recheck: { verdict: 'better', source: 'photo_pair', whatChanged: ['patch_size'], pairs: ['front', 'back'], promptVersion: recheck.PROMPT_VERSION },
    });
    expect(stored.sinceLast.checks.find((c) => c.key === 'water')).toEqual({ key: 'water', status: 'watch' }); // cannot_tell wrote nothing
    expect(stored.sinceLast.photoPairs).toEqual([{ zone: 'front', verdict: 'better', whatChanged: ['color'] }, { zone: 'back', verdict: 'same', whatChanged: [] }]);
    // everything else in the entry and in structured_notes is untouched
    expect(stored.applied).toEqual(w.entry.applied);
    expect(stored.checks).toEqual(w.entry.checks);
    expect(w.records['svc-cur'].structured_notes.keep).toBe('me');
    // the public payload view of the block carries none of it
    expect(JSON.stringify(publicSinceLast(stored.sinceLast))).not.toMatch(/recheck|photoPairs|photo_pair/);
  });

  test('perception hygiene end to end: nothing the job sends names a score, a product or a prior status', async () => {
    const w = makeWorld({ world: { ...fullWorld(), current: assessment(CUR, { photos: JSON.stringify(SHOT_LIST_META) }) } });
    dispatchWithFallback.mockResolvedValue(okAnswer(goodJson()));
    await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch: dispatchWithFallback });
    const [, payload] = dispatchWithFallback.mock.calls[0];
    const sent = JSON.stringify({ ...payload, images: payload.images.map(({ label }) => ({ label })) });
    for (const secret of ['Test Herbicide B', 'Test Fungicide A', 'Test Active', 'needs_attention', 'weed control', 'fungus protection', '2026-08-30']) {
      expect(sent).not.toContain(secret);
    }
  });

  test('a recheck already on a check (an office decision) is never replaced, and is not even asked about', async () => {
    const w = makeWorld({
      sinceLast: {
        v: 1, priorAssessmentId: PRIOR, priorDate: '2026-08-30', applied: [],
        checks: [{ key: 'weeds', status: 'watch', recheck: { verdict: 'worse', source: 'office_review' } }, { key: 'water', status: 'watch' }],
      },
    });
    dispatchWithFallback.mockResolvedValue(okAnswer({
      pairs: [{ pair: 1, verdict: 'better', what_changed: ['color'] }, { pair: 2, verdict: 'better', what_changed: ['color'] }, { pair: 3, verdict: 'better', what_changed: ['color'] }],
      items: [{ item: 'water', verdict: 'better', what_changed: ['color'], pairs: [1] }],
    }));
    await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch: dispatchWithFallback });
    expect(dispatchWithFallback.mock.calls[0][1].text).not.toContain('- weeds');
    const stored = storedVisitMemoryFor(w.records['svc-cur'].structured_notes, CUR);
    expect(stored.sinceLast.checks[0].recheck).toEqual({ verdict: 'worse', source: 'office_review' });
    expect(stored.sinceLast.checks[1].recheck).toMatchObject({ verdict: 'better', source: 'photo_pair' });
  });

  test('a concurrent writer on the entry forces a re-read: the other writer\'s recheck survives', async () => {
    const w = makeWorld();
    dispatchWithFallback.mockResolvedValue(okAnswer(goodJson()));
    w.state.beforeUpdate = () => {
      const map = w.records['svc-cur'].structured_notes.lawnVisitMemory;
      map[CUR] = { ...map[CUR], sinceLast: { ...map[CUR].sinceLast, checks: map[CUR].sinceLast.checks.map((c) => (c.key === 'weeds' ? { ...c, recheck: { verdict: 'same', source: 'office_review' } } : c)) } };
    };
    const out = await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch: dispatchWithFallback });
    expect(out.status).toBe('stored');
    const stored = storedVisitMemoryFor(w.records['svc-cur'].structured_notes, CUR);
    expect(stored.sinceLast.checks.find((c) => c.key === 'weeds').recheck).toEqual({ verdict: 'same', source: 'office_review' });
    expect(out.written).toEqual([]);
  });

  test('no frozen entry: nothing is created (a degraded or missing render froze none)', async () => {
    const w = makeWorld({ notes: { keep: 'me' } });
    dispatchWithFallback.mockResolvedValue(okAnswer(goodJson()));
    const out = await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch: dispatchWithFallback });
    expect(out.status).toBe('not_stored');
    expect(w.records['svc-cur'].structured_notes).toEqual({ keep: 'me' });
  });

  test.each([
    ['no prior', { sinceLast: null }],
    ['no watch topics', { sinceLast: { v: 1, priorAssessmentId: PRIOR, applied: [], checks: [] } }],
  ])('%s: no call at all', async (_name, opts) => {
    const w = makeWorld(opts);
    const out = await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch: dispatchWithFallback });
    expect(['no_prior', 'no_items']).toContain(out.status);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(w.log.updates).toEqual([]);
  });

  test('no pair (different property, or no usable overview on a side): no call, no write', async () => {
    for (const world of [
      { ...fullWorld(), prior: assessment(PRIOR, { property_id: 'prop-9' }) },
      { ...fullWorld(), priorPhotos: [photo(PRIOR, 'close_up'), photo(PRIOR, 'trouble')] },
      { ...fullWorld(), currentPhotos: [photo(CUR, 'front', { quality_score: '10' })] },
    ]) {
      const w = makeWorld({ world });
      const out = await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch: dispatchWithFallback });
      expect(out.status).toBe('no_pairs');
      expect(w.log.updates).toEqual([]);
    }
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a pair with an unreadable photo is dropped; the rest still go in the one call', async () => {
    const w = makeWorld();
    dispatchWithFallback.mockResolvedValue(okAnswer({
      pairs: [{ pair: 1, verdict: 'worse', what_changed: ['edge'] }, { pair: 2, verdict: 'same', what_changed: [] }],
      items: [{ item: 'weeds', verdict: 'worse', what_changed: ['edge'], pairs: [1] }, { item: 'water', verdict: 'cannot_tell', what_changed: [], pairs: [] }],
    }));
    const ps = { getPhotoBase64: jest.fn(async (key) => { if (key.includes('front')) throw new Error('NoSuchKey'); return { data: 'QQ==', mimeType: 'image/jpeg' }; }) };
    const out = await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: ps, dispatch: dispatchWithFallback });
    expect(out.status).toBe('stored');
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallback.mock.calls[0][1].images).toHaveLength(4);
    expect(storedVisitMemoryFor(w.records['svc-cur'].structured_notes, CUR).sinceLast.checks[0].recheck).toMatchObject({ verdict: 'worse', pairs: ['back'] });
  });

  test('all cannot_tell: nothing written', async () => {
    const w = makeWorld();
    dispatchWithFallback.mockResolvedValue(okAnswer({
      pairs: [1, 2, 3].map((pair) => ({ pair, verdict: 'cannot_tell', what_changed: [] })),
      items: [{ item: 'weeds', verdict: 'cannot_tell', what_changed: [], pairs: [] }, { item: 'water', verdict: 'cannot_tell', what_changed: [], pairs: [] }],
    }));
    const out = await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch: dispatchWithFallback });
    expect(out.status).toBe('no_verdict');
    expect(w.log.updates).toEqual([]);
  });
});

describe('fail-open: a miss writes nothing, is logged, and never throws', () => {
  const run = async (dispatch, extra = {}) => {
    const w = makeWorld();
    const out = await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch, ...extra });
    return { w, out };
  };

  test.each([
    ['provider miss', async () => ({ ok: false, reason: 'gemini_timeout', failures: [] })],
    ['provider throws', async () => { throw new Error('provider exploded'); }],
    ['garbage object', async () => okAnswer({ hello: 'world' })],
    ['garbage string', async () => okAnswer('not json')],
    ['invalid enum', async () => okAnswer({ pairs: [{ pair: 1, verdict: 'amazing', what_changed: [] }], items: [] })],
    ['empty arrays', async () => okAnswer({ pairs: [], items: [] })],
    ['only unknown item keys', async () => okAnswer({ pairs: [1, 2, 3].map((pair) => ({ pair, verdict: 'better', what_changed: ['color'] })), items: [{ item: 'mowing', verdict: 'better', what_changed: ['color'], pairs: [1] }] })],
    ['a missing item', async () => okAnswer({ pairs: [1, 2, 3].map((pair) => ({ pair, verdict: 'better', what_changed: ['color'] })), items: [{ item: 'weeds', verdict: 'better', what_changed: ['color'], pairs: [1] }] })],
    ['null result', async () => null],
  ])('%s', async (_name, dispatch) => {
    const { w, out } = await run(dispatch);
    expect(['unavailable']).toContain(out.status);
    expect(w.log.updates).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[lawn-paired-recheck]'));
  });

  test('a provider that never answers is cut off at the deadline', async () => {
    const { w, out } = await run(() => new Promise(() => {}), { deadlineMs: 20 });
    expect(out.status).toBe('unavailable');
    expect(w.log.updates).toEqual([]);
  });

  test('a database failure while loading is a logged miss too', async () => {
    const knex = () => { throw new Error('db down'); };
    const out = await recheck.runPairedRecheck({ serviceRecordId: 'svc-cur', assessmentId: CUR, entry: makeWorld().entry }, { knex, photoService: photoService(), dispatch: dispatchWithFallback });
    expect(out.status).toBe('unavailable');
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the schedule hook runs the job after the render returns and swallows a failure', async () => {
    const w = makeWorld();
    dispatchWithFallback.mockResolvedValue(okAnswer(goodJson()));
    const ps = photoService();
    const timer = recheck.scheduleAfterFreeze(ctxOf(w), { knex: w.knex, photoService: ps, dispatch: dispatchWithFallback });
    expect(timer).not.toBeNull();
    expect(dispatchWithFallback).not.toHaveBeenCalled(); // deferred: nothing ran inline
    for (let i = 0; i < 20 && !w.log.updates.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(w.log.updates).toHaveLength(1);
  });
});

describe('verdict -> stored recheck -> the progress engine', () => {
  const sides = (confidence) => ({
    current: {
      date: '2026-09-30', season: 'summer', isBaseline: false,
      scores: { turf_density: 70, weed_suppression: 70, color_health: 70, stress_damage: 70, overall: 70 }, confidence,
    },
    prior: {
      assessmentId: PRIOR, date: '2026-08-30', season: 'summer',
      scores: { turf_density: 70, weed_suppression: 70, color_health: 70, stress_damage: 70, overall: 70 }, confidence,
    },
  });
  const progressFor = (checks, confidence = { level: 'high', divergentMetrics: [] }) => buildLawnProgress({
    ...sides(confidence), sinceLast: { v: 1, priorAssessmentId: PRIOR, priorDate: '2026-08-30', applied: [], checks },
  });
  const stored = (verdict) => ({ verdict, source: 'photo_pair', whatChanged: ['color'], pairs: ['front'], promptVersion: recheck.PROMPT_VERSION });

  test.each([['better', 'improving', 'checked_better'], ['same', 'holding_steady', 'checked_same'], ['worse', 'behind', 'checked_worse']])(
    'a stored %s reads as %s',
    (verdict, state, status) => {
      const progress = progressFor([{ key: 'weeds', status: 'watch', recheck: stored(verdict) }]);
      expect(progress.items[0]).toMatchObject({ kind: 'check', key: 'weeds', state, recheck: status, source: 'photo_pair', gate: null });
    },
  );

  test('a visit whose photos cannot be compared still reads unclear, whatever the photo pair said', () => {
    for (const level of ['low', 'insufficient']) {
      const progress = progressFor([{ key: 'weeds', status: 'watch', recheck: stored('better') }], { level, divergentMetrics: [] });
      expect(progress.items[0]).toMatchObject({ state: 'unclear', gate: 'low_confidence' });
    }
  });

  test('a cannot_tell writes no recheck, so the check stays unclear as it is today', () => {
    const progress = progressFor([{ key: 'weeds', status: 'watch' }]);
    expect(progress.items[0]).toMatchObject({ state: 'unclear', gate: 'not_rechecked', recheck: 'not_recorded' });
  });

  test('an office_review override beats the stored photo_pair verdict', () => {
    const progress = progressFor([{ key: 'weeds', status: 'watch', recheck: stored('better'), recheckOverride: { verdict: 'worse', source: 'office_review' } }]);
    expect(progress.items[0]).toMatchObject({ state: 'behind', source: 'office_review' });
  });

  test('end to end: what the job stores is exactly what the engine reads', async () => {
    const w = makeWorld();
    dispatchWithFallback.mockResolvedValue(okAnswer(goodJson()));
    await recheck.runPairedRecheck(ctxOf(w), { knex: w.knex, photoService: photoService(), dispatch: dispatchWithFallback });
    const entry = storedVisitMemoryFor(w.records['svc-cur'].structured_notes, CUR);
    const progress = buildLawnProgress({ ...sides({ level: 'high', divergentMetrics: [] }), sinceLast: entry.sinceLast });
    const byKey = Object.fromEntries(progress.items.filter((i) => i.kind === 'check').map((i) => [i.key, i]));
    expect(byKey.weeds).toMatchObject({ state: 'improving', source: 'photo_pair' });
    expect(byKey.water).toMatchObject({ state: 'unclear', gate: 'not_rechecked' });
  });
});
