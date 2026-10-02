// Lawn report v6 copy writer (lawn report rebuild P14, GATE_LAWN_REPORT_COPY_V6).
// The model is injected everywhere: no production LLM API is ever called.
// Postgres first-writer-wins races run in lawn-copy-v6.db.test.js (CI only).
// Synthetic data only.

jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const featureGates = require('../config/feature-gates');
const {
  PROMPT_VERSION, FIELD_CAPS, MODEL_WORDS_TOTAL_CAP, FREEZE_KEY,
  writeLawnCopyV6, resolveLawnCopyV6ForRender, storedLawnCopyV6For, freezeLawnCopyV6, _test,
} = require('../services/service-report/lawn-copy-v6');
const { buildLawnExpectations } = require('../services/service-report/lawn-expectations');

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;

const reportV2 = (over = {}) => ({
  snapshot: { status: 'watch', statusHeadline: 'Stable, watching weeds', treatmentSummary: 'Applied a weed control.' },
  diagnosis: [{ key: 'weed_pressure', label: 'Weed control', status: 'watch' }],
  treatment: { products: [{ name: 'Celsius WG', activeIngredient: 'Thiencarbazone-methyl', kind: 'herbicide', targets: ['Dollarweed'], method: 'spot_treatment' }] },
  insights: [{ category: 'weeds', status: 'watch', priority: 1 }],
  ...over,
});

const GOOD = {
  headline: 'Healthy overall, with a few spots to watch',
  whatWeDid: 'We spot-treated the broadleaf weeds with a selective weed control.',
  watching: 'Thin areas along the driveway edge, which may be signs of heat stress.',
};

// An APPROVED fixture row (today's table ships every row approved:false).
const WEEDS_ROW = {
  id: 'herbicide_broadleaf',
  approved: true,
  appliesTo: 'selective weed control',
  sentences: [
    { key: 'visibleChange', text: 'Weeds usually start to yellow or curl within about 3 to 7 days, then brown and die back over about 2 to 3 weeks.' },
    { key: 'secondApp', text: 'Larger or deeper-rooted weeds can need a second application at a later visit.' },
    { key: 'byNextVisit', text: 'By your next visit, most treated weeds should be browning or fading.' },
    { key: 'contactTrigger', text: 'If treated weeds are still fully green after about 3 weeks, let us know.' },
  ],
};
const FEED_ROW = {
  id: 'potassium_feed',
  approved: true,
  appliesTo: 'liquid potassium feed',
  sentences: [
    { key: 'visibleChange', text: 'Potassium works gradually, showing as color that holds up through heat.' },
    { key: 'byNextVisit', text: 'By your next visit, expect color about like it is now.' },
  ],
};
const engine = (...rows) => () => ({ rows });
const withRows = (...rows) => ({ buildExpectations: engine(...rows) });
const modelReturning = (json) => ({ callModel: jest.fn(async () => ({ ok: true, json })) });

beforeEach(() => { _test._cache.clear(); jest.clearAllMocks(); });

describe('the gate reader', () => {
  const ENV = ['GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD'];
  const saved = {};
  beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  test('off by default; needs BOTH gates; read at call time', () => {
    expect(featureGates.lawnReportCopyV6Live()).toBe(false);
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    expect(featureGates.lawnReportCopyV6Live()).toBe(false); // lead gate off
    process.env.GATE_LAWN_REPORT_LEAD = 'true';
    expect(featureGates.lawnReportCopyV6Live()).toBe(true);
    delete process.env.GATE_LAWN_REPORT_COPY_V6;
    expect(featureGates.lawnReportCopyV6Live()).toBe(false);
  });

  test('is on the gates map and exported on its own line', () => {
    expect(Object.prototype.hasOwnProperty.call(featureGates.gates || {}, 'lawnReportCopyV6')).toBe(true);
    const src = require('fs').readFileSync(require.resolve('../config/feature-gates'), 'utf8');
    expect(src).toMatch(/^module\.exports\.lawnReportCopyV6Live = lawnReportCopyV6Live;$/m);
    expect(src).toMatch(/GATE_LAWN_REPORT_COPY_V6=true/);
  });
});

describe('what the model is offered', () => {
  test("today's real table offers no row: every row ships approved:false, so whatToExpect is always null", async () => {
    expect(_test.approvedRowsFor(reportV2(), {}, {})).toEqual([]);
    const deps = modelReturning({ ...GOOD, expectRows: [{ id: 'herbicide_broadleaf', sentences: ['visibleChange'] }] });
    const out = await writeLawnCopyV6(reportV2(), {}, deps);
    expect(out.fields.whatToExpect).toBeNull();
    expect(out.expectRows).toEqual([]);
    // No row, so the schema has no expectRows field at all.
    const schema = deps.callModel.mock.calls[0][0].jsonSchema;
    expect(schema.properties.expectRows).toBeUndefined();
    expect(schema.required).toEqual(['headline', 'whatWeDid', 'watching']);
  });

  test('the real engine with an unapproved row (preview mode) still offers nothing through this path', () => {
    const preview = buildLawnExpectations({ applications: [{ name: 'Celsius WG' }], nextVisitGapDays: 28 }, { includeUnapproved: true });
    expect(preview.rows.length).toBeGreaterThan(0);
    expect(preview.rows[0].sentences.map((s) => s.key)).toContain('visibleChange');
    // ... but the default (production) call withholds it, and an unapproved row handed in is filtered.
    expect(buildLawnExpectations({ applications: [{ name: 'Celsius WG' }], nextVisitGapDays: 28 }).rows).toEqual([]);
    expect(_test.approvedRowsFor(reportV2(), {}, { buildExpectations: () => preview })).toEqual([]);
  });

  test('an approved row is offered with its keyed sentences, as a closed enum in the schema', async () => {
    const deps = { ...withRows(WEEDS_ROW, FEED_ROW), ...modelReturning(GOOD) };
    await writeLawnCopyV6(reportV2(), {}, deps);
    const [call] = deps.callModel.mock.calls[0];
    const facts = JSON.parse(call.text.slice(call.text.indexOf('{')));
    expect(facts.approvedExpectationRows.map((r) => r.id)).toEqual(['herbicide_broadleaf', 'potassium_feed']);
    expect(facts.approvedExpectationRows[0].sentences[0]).toEqual({ key: 'visibleChange', text: WEEDS_ROW.sentences[0].text });
    const { items } = call.jsonSchema.properties.expectRows;
    expect(items.properties.id.enum).toEqual(['herbicide_broadleaf', 'potassium_feed']);
    expect(items.properties.sentences.items.enum).toEqual(expect.arrayContaining(['visibleChange', 'byNextVisit']));
    expect(call.jsonSchema.required).toContain('expectRows');
  });

  test('no products applied: no engine call, no row, whatWeDid never asked for', async () => {
    const build = jest.fn(() => ({ rows: [WEEDS_ROW] }));
    const out = await writeLawnCopyV6(reportV2({ treatment: { products: [] } }), {}, { buildExpectations: build, ...modelReturning(GOOD) });
    expect(build).not.toHaveBeenCalled();
    expect(out.fields.whatWeDid).toBeNull();
    expect(out.fields.whatToExpect).toBeNull();
  });

  test('the engine is handed the applied names and tags, the visit gap, and the Celsius cap (YTD unknown = capped line)', async () => {
    const build = jest.fn(() => ({ rows: [] }));
    await writeLawnCopyV6(reportV2(), { visitDate: '2026-09-30', nextVisitGapDays: 28 }, { buildExpectations: build, ...modelReturning(GOOD) });
    expect(build).toHaveBeenCalledWith(expect.objectContaining({
      applications: [{ name: 'Celsius WG', targets: ['Dollarweed'] }],
      visitDate: '2026-09-30',
      nextVisitGapDays: 28,
      celsiusYtdCount: 3,
    }));
  });
});

describe('what the model is told', () => {
  test('facts carry roles and tags, never product names, ingredients, scores or free-text notes', async () => {
    const deps = modelReturning(GOOD);
    await writeLawnCopyV6(reportV2({ snapshot: { status: 'watch', overallScore: 68 } }), { grassLabel: 'St. Augustine lawn' }, deps);
    const text = deps.callModel.mock.calls[0][0].text;
    expect(text).not.toMatch(/Celsius|Thiencarbazone|68/);
    expect(text).toContain('selective weed control');
    expect(text).toContain('Dollarweed');
  });

  test("another lane's since-last lines ride only as a do-not-restate fact", async () => {
    const deps = modelReturning(GOOD);
    const withSince = reportV2({ lead: { sinceLast: { priorDate: '2026-08-01', lines: ['Your overall score is up since August.'] } } });
    await writeLawnCopyV6(withSince, {}, deps);
    const facts = _test.buildFacts(withSince, {}, []);
    expect(facts.doNotRestate).toEqual(['Your overall score is up since August.']);
    expect(Object.keys(facts)).not.toContain('sinceLast');
    expect(_test.buildFacts(reportV2(), {}, []).doNotRestate).toBeUndefined();
  });

  test('the prompt composes the shared core and the v6 adapter, with the right business name and no timing licence', () => {
    const p = _test.SYSTEM_PROMPT;
    expect(p).toContain('OUTPUT CONTRACT');
    expect(p).toContain('Waves Pest Control');
    expect(p).not.toMatch(/Waves Pest Control & Lawn Care/i);
    expect(p).toMatch(/You do not write about timing/);
  });

  test('the schema has no numeric bounds (Anthropic rejects them) and is closed', () => {
    const schema = _test.buildSchema([{ id: 'a', sentences: [{ key: 'visibleChange', text: 't' }] }]);
    const flat = JSON.stringify(schema);
    expect(flat).not.toMatch(/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|minItems|maxItems|minLength|maxLength|multipleOf)"/);
    expect(schema.additionalProperties).toBe(false);
  });

  test('PROMPT_VERSION is the v6 structural version and rides the call', async () => {
    expect(PROMPT_VERSION).toBe('lawn_report_v6_structural_1');
    expect(PROMPT_VERSION).not.toBe(require('../services/service-report/lawn-report-narrative')._test.PROMPT_VERSION);
  });
});

describe('whatToExpect is SELECTION ONLY', () => {
  const run = (expectRows, rows = [WEEDS_ROW, FEED_ROW]) => writeLawnCopyV6(reportV2(), {}, { ...withRows(...rows), ...modelReturning({ ...GOOD, expectRows }) });

  test('prints the chosen sentences verbatim, in the row\'s own order', async () => {
    const out = await run([{ id: 'herbicide_broadleaf', sentences: ['byNextVisit', 'visibleChange'] }]);
    expect(out.fields.whatToExpect).toBe(`${WEEDS_ROW.sentences[0].text} ${WEEDS_ROW.sentences[2].text}`);
    expect(out.expectRows).toEqual([{ id: 'herbicide_broadleaf', keys: ['visibleChange', 'byNextVisit'] }]);
  });

  test('model-written text is never used: extra text fields are ignored, only ids and keys count', async () => {
    const out = await run([{ id: 'herbicide_broadleaf', sentences: ['visibleChange'], text: 'Weeds die in two days, guaranteed.', sentence: 'Everything clears in 24 hours.' }]);
    expect(out.fields.whatToExpect).toBe(WEEDS_ROW.sentences[0].text);
    expect(out.fields.whatToExpect).not.toMatch(/guaranteed|24 hours/);
  });

  test('unknown ids, unapproved ids and duplicates are dropped; unknown keys fall to the default sentences', async () => {
    const out = await run([
      { id: 'made_up_row', sentences: ['visibleChange'] },
      { id: 'issue_dry_spot', sentences: ['visibleChange'] }, // a real row id that was never offered
      { id: 'herbicide_broadleaf', sentences: ['not_a_key'] },
      { id: 'herbicide_broadleaf', sentences: ['contactTrigger'] }, // duplicate id
    ]);
    // The first copy of the row won; its unknown key fell to the default sentences,
    // which both fit the 42-word cap.
    expect(out.expectRows).toEqual([{ id: 'herbicide_broadleaf', keys: ['visibleChange', 'byNextVisit'] }]);
    expect(out.fields.whatToExpect).toBe(`${WEEDS_ROW.sentences[0].text} ${WEEDS_ROW.sentences[2].text}`);
  });

  test('only unknown ids: the field is null', async () => {
    const out = await run([{ id: 'nope', sentences: [] }, 'garbage', null, 42]);
    expect(out.fields.whatToExpect).toBeNull();
    expect(out.expectRows).toEqual([]);
  });

  test('at most two rows', async () => {
    const third = { ...FEED_ROW, id: 'iron_micros', sentences: [{ key: 'visibleChange', text: 'Iron deepens color within about a few days.' }] };
    const out = await run([{ id: 'herbicide_broadleaf', sentences: ['byNextVisit'] }, { id: 'potassium_feed', sentences: ['byNextVisit'] }, { id: 'iron_micros', sentences: ['visibleChange'] }], [WEEDS_ROW, FEED_ROW, third]);
    expect(out.expectRows.map((r) => r.id)).toEqual(['herbicide_broadleaf', 'potassium_feed']);
  });

  test('the 42-word cap skips a sentence that would overflow, whole, never cutting mid-sentence', async () => {
    const out = await run([{ id: 'herbicide_broadleaf', sentences: ['visibleChange', 'secondApp', 'byNextVisit', 'contactTrigger'] }]);
    const text = out.fields.whatToExpect;
    expect(words(text)).toBeLessThanOrEqual(FIELD_CAPS.whatToExpect);
    // Every printed sentence is one of the row's own, complete.
    for (const sentence of text.split(/(?<=\.)\s+/)) expect(WEEDS_ROW.sentences.map((s) => s.text)).toContain(sentence);
    expect(out.expectRows[0].keys.length).toBeLessThan(4);
  });

  test('a sentence the second layer refuses is left out whole while the row\'s other sentences print; P11 reads "second application" as a sub-day duration', async () => {
    const out = await run([{ id: 'herbicide_broadleaf', sentences: ['secondApp', 'byNextVisit'] }]);
    expect(out.fields.whatToExpect).toBe(WEEDS_ROW.sentences[2].text);
    expect(out.expectRows).toEqual([{ id: 'herbicide_broadleaf', keys: ['byNextVisit'] }]);
    _test._cache.clear(); // same facts, a different model answer
    const onlySecond = await run([{ id: 'herbicide_broadleaf', sentences: ['secondApp'] }]);
    expect(onlySecond.fields.whatToExpect).toBeNull();
  });

  test('a row sentence that trips the second layer (a watering word) nulls the whole field', async () => {
    const wet = { ...WEEDS_ROW, sentences: [{ key: 'visibleChange', text: 'Weeds yellow within about 3 to 7 days after you water the lawn.' }] };
    const out = await run([{ id: 'herbicide_broadleaf', sentences: ['visibleChange'] }], [wet]);
    expect(out.fields.whatToExpect).toBeNull();
    expect(out.expectRows).toEqual([]);
  });

  test('approved sentences keep their own windows (the exemption is for printed row text only)', async () => {
    const out = await run([{ id: 'herbicide_broadleaf', sentences: ['visibleChange'] }]);
    expect(out.fields.whatToExpect).toMatch(/about 3 to 7 days/);
    // The same words written by the MODEL as free text are rejected.
    expect(_test.guardFreeText('Weeds start to yellow within about 3 to 7 days.', 'watching', { facts: _test.p11Facts({}) })).toBeNull();
  });
});

describe('free-text guards: any failure falls back (null; the lead then uses its deterministic sentence)', () => {
  const g = (over = {}) => ({ facts: _test.p11Facts({}), brandRe: _test.brandRegex(reportV2().treatment.products), ...over });
  const pass = (text, field = 'whatWeDid', gg = g()) => _test.guardFreeText(text, field, gg);

  test('plain, grounded copy passes', () => {
    expect(pass(GOOD.headline, 'headline')).toBe(GOOD.headline);
    expect(pass(GOOD.whatWeDid)).toBe(GOOD.whatWeDid);
    expect(pass(GOOD.watching, 'watching')).toBe(GOOD.watching);
  });

  const FAILURES = [
    ['a digit', 'We applied 2 products to the lawn.'],
    ['a number word', 'We applied two products to the lawn.'],
    ['a fraction word', 'We treated half of the front lawn.'],
    ['a time word', 'We applied a weed control that works within a week.'],
    ['today', 'Today we applied a weed control to the lawn.'],
    ['a clock time', 'We finished around noon.'],
    ['a watering word', 'We applied a feed, so keep the sprinklers on.'],
    ['a moisture word', 'We applied a weed control and the moisture looks fine.'],
    ['dry', 'We found a dry patch near the walk.'],
    ['rain', 'We applied a feed after the rain.'],
    ['mowing', 'Raise your mowing height a little.'],
    ['a banned claim', 'We guaranteed the weeds are gone.'],
    ['an overpromise', 'This will eliminate the weeds.'],
    ['a safety claim', 'We applied a pet-safe weed control.'],
    ['cleared', 'The weeds have cleared.'],
    ['a progress word with no supporting state', 'The lawn is improving.'],
    ['a brand name', 'We applied Celsius to the weeds.'],
    ['a brand name, any case', 'We applied celsius to the weeds.'],
    ['an ingredient name', 'We applied thiencarbazone to the weeds.'],
    ['another catalog brand', 'We applied Prodiamine along the edges.'],
    ['a named cause', 'We treated for chinch bugs along the driveway.'],
    ['markdown', 'We applied a **weed control** today\'s.'],
    ['an em dash', 'We applied a weed control — a selective one.'],
    ['a link', 'See www.example.com for the weed control.'],
    ['an empty string', '   '],
    ['not a string', 42],
  ];
  test.each(FAILURES)('%s', (_name, text) => {
    expect(pass(text)).toBeNull();
  });

  test('a field over its cap is discarded whole, never truncated', () => {
    const nine = 'Healthy overall with several small spots that need attention soon';
    expect(words(nine)).toBeGreaterThan(FIELD_CAPS.headline);
    expect(pass(nine, 'headline')).toBeNull();
    const long = Array(FIELD_CAPS.whatWeDid + 1).fill('lawn').join(' ');
    expect(pass(long)).toBeNull();
    expect(pass(Array(FIELD_CAPS.whatWeDid).fill('lawn').join(' '))).not.toBeNull();
  });

  test('a progress word passes only when the progress engine says so', () => {
    const up = _test.p11Facts({ progress: { overall: { direction: 'up' }, items: [] } });
    expect(pass('The lawn color is improving.', 'headline', g({ facts: up }))).toBe('The lawn color is improving.');
    expect(pass('The lawn color is improving.', 'headline', g({ facts: _test.p11Facts({ progress: { overall: { direction: 'flat' }, items: [] } }) }))).toBeNull();
    expect(pass('The lawn color is improving.', 'headline', g({ facts: _test.p11Facts({}) }))).toBeNull();
  });

  test('the caller\'s own contradiction guard can veto', () => {
    expect(pass(GOOD.whatWeDid, 'whatWeDid', g({ extraGuard: () => true }))).toBeNull();
    expect(pass(GOOD.whatWeDid, 'whatWeDid', g({ extraGuard: () => false }))).toBe(GOOD.whatWeDid);
  });

  test('plain nutrient words stay usable even when they are an active ingredient', () => {
    const brand = _test.brandRegex([{ name: 'K-Flow 0-0-25', activeIngredient: 'Potassium' }]);
    expect(_test.guardFreeText('We applied a liquid potassium feed.', 'whatWeDid', g({ brandRe: brand }))).toBe('We applied a liquid potassium feed.');
  });

  test('field-level wiring: failures null only that field, the others survive', async () => {
    const out = await writeLawnCopyV6(reportV2(), {}, modelReturning({ ...GOOD, headline: 'Healthy, up 5 points', watching: 'Thin areas near the driveway edge.' }));
    expect(out.fields.headline).toBeNull();
    expect(out.fields.whatWeDid).toBe(GOOD.whatWeDid);
    expect(out.fields.watching).toBe('Thin areas near the driveway edge.');
    expect(out.modelOk).toBe(true);
  });

  test('every field failing leaves the deterministic path: all null', async () => {
    const out = await writeLawnCopyV6(reportV2(), {}, modelReturning({ headline: 'Up 5 points', whatWeDid: 'Today we applied Celsius.', watching: 'Chinch bugs within a week.' }));
    expect(out.fields).toEqual({ headline: null, whatWeDid: null, whatToExpect: null, watching: null });
    expect(out.modelOk).toBe(true);
  });

  test('watching is null unless an issue exists, even when the model wrote one', async () => {
    const out = await writeLawnCopyV6(reportV2({ insights: [{ category: 'color', status: 'good', priority: 1 }] }), {}, modelReturning(GOOD));
    expect(out.fields.watching).toBeNull();
    expect(out.fields.headline).toBe(GOOD.headline);
  });
});

describe('word totals', () => {
  test('headline 8 + whatWeDid 32 + whatToExpect 42 + watching 20 stays within 128', async () => {
    expect(FIELD_CAPS.headline + FIELD_CAPS.whatWeDid + FIELD_CAPS.whatToExpect + FIELD_CAPS.watching).toBeLessThanOrEqual(MODEL_WORDS_TOTAL_CAP);
    const full = {
      headline: 'Healthy overall with spots to watch carefully ok'.split(' ').slice(0, 8).join(' '),
      whatWeDid: `${Array(FIELD_CAPS.whatWeDid - 1).fill('feed').join(' ')} well.`,
      watching: Array(FIELD_CAPS.watching).fill('thin').join(' '),
    };
    const out = await writeLawnCopyV6(reportV2(), {}, { ...withRows(WEEDS_ROW), ...modelReturning({ ...full, expectRows: [{ id: 'herbicide_broadleaf', sentences: ['visibleChange', 'byNextVisit'] }] }) });
    const total = ['headline', 'whatWeDid', 'whatToExpect', 'watching'].reduce((n, f) => n + words(out.fields[f]), 0);
    expect(total).toBeLessThanOrEqual(MODEL_WORDS_TOTAL_CAP);
  });

  test('the defensive total cap drops watching, then whatToExpect, then whatWeDid, never cutting a field', () => {
    const big = (n) => Array(n).fill('word').join(' ');
    const out = _test.applyTotalCap({ headline: big(8), whatWeDid: big(60), whatToExpect: big(70), watching: big(40) });
    expect(out.watching).toBeNull();
    expect(out.whatToExpect).toBeNull();
    expect(out.whatWeDid).toBe(big(60));
    expect(out.headline).toBe(big(8));
  });
});

describe('model unavailable', () => {
  test.each([
    ['{ ok:false }', async () => ({ ok: false, reason: 'no_key' })],
    ['a thrown error', async () => { throw new Error('boom'); }],
    ['no json', async () => ({ ok: true })],
    ['a json array', async () => ({ ok: true, json: [] })],
  ])('%s -> deterministic: every field null, modelOk false', async (_name, impl) => {
    const out = await writeLawnCopyV6(reportV2(), {}, { callModel: jest.fn(impl), ...withRows(WEEDS_ROW) });
    expect(out).toEqual({ fields: { headline: null, whatWeDid: null, whatToExpect: null, watching: null }, expectRows: [], modelOk: false });
  });

  test('the default call goes through dispatchWithFallback on the customer-copy tier (no hardcoded model id)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/service-report/lawn-copy-v6'), 'utf8');
    expect(src).toMatch(/dispatchWithFallback\(\s*MODELS\.TEXT_POLICIES\.customerCopy/);
    expect(src).not.toMatch(/claude-|gpt-\d|gemini-/);
  });

  test('a repeat of the same facts reuses the model output; a failure is only remembered briefly', async () => {
    const ok = modelReturning(GOOD);
    await writeLawnCopyV6(reportV2(), {}, ok);
    await writeLawnCopyV6(reportV2(), {}, ok);
    expect(ok.callModel).toHaveBeenCalledTimes(1);
    _test._cache.clear();
    const bad = { callModel: jest.fn(async () => ({ ok: false })) };
    await writeLawnCopyV6(reportV2(), {}, bad);
    await writeLawnCopyV6(reportV2(), {}, bad);
    expect(bad.callModel).toHaveBeenCalledTimes(1);
    const [entry] = [..._test._cache.values()];
    expect(entry.json).toBeNull();
  });
});

// ── freeze: the same shape as the lawnWeekWeather / lawnVisitMemory freeze ────
// An in-memory service_records with the freeze's semantics; the real SQL runs in
// lawn-copy-v6.db.test.js.
function recordsKnex(records, hooks = {}) {
  const log = { updates: [], reads: [] };
  const knex = (table) => {
    if (table !== 'service_records') throw new Error(`unexpected table ${table}`);
    const ctx = { where: {}, binding: null };
    const chain = {
      where(cond) { Object.assign(ctx.where, cond); return chain; },
      whereRaw(_sql, bindings) { ctx.binding = bindings && bindings[0]; return chain; },
      async update(patch) {
        if (hooks.failUpdate) throw new Error('update failed');
        if (hooks.loseRace) { hooks.loseRace(); return 0; }
        const rec = records[ctx.where.id];
        if (!rec) return 0;
        const map = (rec.structured_notes && rec.structured_notes[FREEZE_KEY]) || {};
        if (map[ctx.binding] != null) return 0;
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        rec.structured_notes = { ...rec.structured_notes, [FREEZE_KEY]: { ...map, ...add } };
        log.updates.push(add);
        return 1;
      },
      async first() {
        log.reads.push({ ...ctx.where });
        const rec = records[ctx.where.id];
        return rec ? { structured_notes: rec.structured_notes } : undefined;
      },
    };
    return chain;
  };
  knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return { knex, log };
}

describe('freeze: first writer wins per assessment', () => {
  const NOW = { now: () => new Date('2026-09-30T18:00:00Z') };
  const resolve = (records, hooks, over = {}, deps = modelReturning(GOOD)) => {
    const { knex, log } = recordsKnex(records, hooks);
    const p = resolveLawnCopyV6ForRender({
      structuredNotes: records.s1.structured_notes, serviceRecordId: 's1', assessmentId: 'as-A', reportV2: reportV2(), knex, deps: { ...NOW, ...deps }, ...over,
    });
    return p.then((r) => ({ ...r, log, deps }));
  };

  test('the first render writes the model fields once, and returns them', async () => {
    const records = { s1: { structured_notes: { timeOnSiteAdjusted: true } } };
    const r = await resolve(records);
    expect(r.copy).toEqual({ headline: GOOD.headline, whatWeDid: GOOD.whatWeDid, whatToExpect: null, watching: GOOD.watching });
    expect(r.unfrozen).toBe(false);
    const entry = records.s1.structured_notes[FREEZE_KEY]['as-A'];
    expect(entry).toMatchObject({ v: 1, promptVersion: PROMPT_VERSION, assessmentId: 'as-A', frozenAt: '2026-09-30T18:00:00.000Z', expectRows: [] });
    expect(entry.fields).toEqual(r.copy);
    expect(records.s1.structured_notes.timeOnSiteAdjusted).toBe(true);
  });

  test('a frozen entry replays byte for byte and never calls the model, whatever the inputs now say', async () => {
    const records = { s1: { structured_notes: {} } };
    const first = await resolve(records);
    const other = modelReturning({ headline: 'Something else entirely', whatWeDid: 'We applied a feed.', watching: 'Thin areas.' });
    const again = await resolve(records, undefined, { reportV2: reportV2({ treatment: { products: [] } }) }, other);
    expect(JSON.stringify(again.copy)).toBe(JSON.stringify(first.copy));
    expect(other.callModel).not.toHaveBeenCalled();
    expect(again.log.updates).toHaveLength(0);
    expect(again.unfrozen).toBe(false);
  });

  test('a frozen entry with null fields replays as null fields (the deterministic sentences take over)', async () => {
    const records = { s1: { structured_notes: {} } };
    await resolve(records, undefined, {}, modelReturning({ headline: 'Up 5 points', whatWeDid: 'Today we applied Celsius.', watching: 'Chinch bugs.' }));
    const again = await resolve(records, undefined, {}, modelReturning(GOOD));
    expect(again.copy).toEqual({ headline: null, whatWeDid: null, whatToExpect: null, watching: null });
  });

  test('the frozen entry records which rows were selected, with the printed text', async () => {
    const records = { s1: { structured_notes: {} } };
    const deps = { ...withRows(WEEDS_ROW), ...modelReturning({ ...GOOD, expectRows: [{ id: 'herbicide_broadleaf', sentences: ['visibleChange'] }] }) };
    const r = await resolve(records, undefined, {}, deps);
    expect(r.copy.whatToExpect).toBe(WEEDS_ROW.sentences[0].text);
    expect(records.s1.structured_notes[FREEZE_KEY]['as-A'].expectRows).toEqual([{ id: 'herbicide_broadleaf', keys: ['visibleChange'] }]);
  });

  test('A -> B -> A: each assessment keeps its own entry and A is never overwritten', async () => {
    const records = { s1: { structured_notes: {} } };
    const a = await resolve(records);
    _test._cache.clear(); // a fresh model call for B
    const b = await resolve(records, undefined, { assessmentId: 'as-B' }, modelReturning({ headline: 'Doing well overall', whatWeDid: 'We applied a feed.', watching: 'Thin areas.' }));
    expect(Object.keys(records.s1.structured_notes[FREEZE_KEY]).sort()).toEqual(['as-A', 'as-B']);
    _test._cache.clear();
    const aAgain = await resolve(records, undefined, {}, modelReturning({ headline: 'A brand new headline', whatWeDid: 'We applied a feed.', watching: 'Thin areas.' }));
    expect(JSON.stringify(aAgain.copy)).toBe(JSON.stringify(a.copy));
    expect(b.copy.headline).toBe('Doing well overall');
    expect(records.s1.structured_notes[FREEZE_KEY]['as-B'].fields.headline).toBe('Doing well overall');
  });

  test('a lost race adopts the winner: the loser serves and returns the winner\'s fields', async () => {
    const winner = { v: 1, promptVersion: PROMPT_VERSION, assessmentId: 'as-A', frozenAt: 'x', fields: { headline: 'Winner headline', whatWeDid: null, whatToExpect: null, watching: null }, expectRows: [] };
    const records = { s1: { structured_notes: {} } };
    const r = await resolve(records, { loseRace: () => { records.s1.structured_notes = { [FREEZE_KEY]: { 'as-A': winner } }; } });
    expect(r.copy.headline).toBe('Winner headline');
    expect(r.unfrozen).toBe(false);
  });

  test('a freeze that fails serves the written copy and marks the render unfrozen (uncacheable)', async () => {
    const records = { s1: { structured_notes: {} } };
    const r = await resolve(records, { failUpdate: true });
    expect(r.copy.headline).toBe(GOOD.headline);
    expect(r.unfrozen).toBe(true);
    expect(records.s1.structured_notes[FREEZE_KEY]).toBeUndefined();
  });

  test('a degraded read never creates a freeze and never calls the model', async () => {
    const records = { s1: { structured_notes: {} } };
    const deps = modelReturning(GOOD);
    const r = await resolve(records, undefined, { degraded: true }, deps);
    expect(r).toMatchObject({ copy: null, unfrozen: true });
    expect(deps.callModel).not.toHaveBeenCalled();
    expect(r.log.updates).toHaveLength(0);
    expect(records.s1.structured_notes[FREEZE_KEY]).toBeUndefined();
  });

  test('a degraded read still replays what is frozen', async () => {
    const records = { s1: { structured_notes: {} } };
    const first = await resolve(records);
    const r = await resolve(records, undefined, { degraded: true });
    expect(r.copy).toEqual(first.copy);
    expect(r.unfrozen).toBe(false);
  });

  test('a model that was unavailable creates no freeze (the next render retries) and ships deterministic copy', async () => {
    const records = { s1: { structured_notes: {} } };
    const r = await resolve(records, undefined, {}, { callModel: jest.fn(async () => ({ ok: false })) });
    expect(r).toMatchObject({ copy: null, unfrozen: true });
    expect(r.log.updates).toHaveLength(0);
    // ... and the retry freezes.
    _test._cache.clear();
    const retry = await resolve(records);
    expect(retry.unfrozen).toBe(false);
    expect(records.s1.structured_notes[FREEZE_KEY]['as-A']).toBeTruthy();
  });

  test('no assessment id: nothing to key, nothing written', async () => {
    const records = { s1: { structured_notes: {} } };
    const r = await resolve(records, undefined, { assessmentId: null });
    expect(r).toMatchObject({ copy: null, unfrozen: true });
    expect(r.log.updates).toHaveLength(0);
  });

  test('storedLawnCopyV6For ignores another assessment, another version and a malformed entry', () => {
    const entry = { v: 1, assessmentId: 'as-A', fields: { headline: 'h' } };
    expect(storedLawnCopyV6For({ [FREEZE_KEY]: { 'as-A': entry } }, 'as-A')).toEqual(entry);
    expect(storedLawnCopyV6For({ [FREEZE_KEY]: { 'as-A': entry } }, 'as-B')).toBeNull();
    expect(storedLawnCopyV6For({ [FREEZE_KEY]: { 'as-A': { ...entry, v: 2 } } }, 'as-A')).toBeNull();
    expect(storedLawnCopyV6For({ [FREEZE_KEY]: { 'as-A': { ...entry, assessmentId: 'as-Z' } } }, 'as-A')).toBeNull();
    expect(storedLawnCopyV6For({ [FREEZE_KEY]: { 'as-A': { v: 1, assessmentId: 'as-A' } } }, 'as-A')).toBeNull();
    expect(storedLawnCopyV6For(JSON.stringify({ [FREEZE_KEY]: { 'as-A': entry } }), 'as-A')).toEqual(entry);
    expect(storedLawnCopyV6For({ [FREEZE_KEY]: [] }, 'as-A')).toBeNull();
    expect(storedLawnCopyV6For(null, 'as-A')).toBeNull();
    expect(storedLawnCopyV6For({}, null)).toBeNull();
  });

  test('freezeLawnCopyV6 refuses missing inputs and shapes its UPDATE as the sibling freezes do', async () => {
    await expect(freezeLawnCopyV6(null, { assessmentId: 'a' }, {})).resolves.toBeNull();
    await expect(freezeLawnCopyV6('s1', null, {})).resolves.toBeNull();
    await expect(freezeLawnCopyV6('s1', { v: 1 }, {})).resolves.toBeNull();
    const seen = {};
    const knex = () => ({
      where() { return this; },
      whereRaw(sql, b) { seen.where = [sql, b]; return this; },
      async update(patch) { seen.update = patch; return 1; },
    });
    knex.raw = (sql, bindings) => ({ sql, bindings });
    await freezeLawnCopyV6('s1', { v: 1, assessmentId: 'as-A', fields: {} }, knex);
    expect(seen.where[0]).toBe("COALESCE(structured_notes::jsonb, '{}'::jsonb) -> 'lawnCopyV6' -> ? IS NULL");
    expect(seen.where[1]).toEqual(['as-A']);
    expect(seen.update.structured_notes.sql).toContain("jsonb_build_object('lawnCopyV6'");
    expect(JSON.parse(seen.update.structured_notes.bindings[0])).toEqual({ 'as-A': { v: 1, assessmentId: 'as-A', fields: {} } });
  });
});
