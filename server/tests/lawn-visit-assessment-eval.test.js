// Stage-2b eval scoring (services/eval/lawn-visit-assessment-eval.js): the
// exported case shape carries no personal data, selection is deterministic,
// the replay context never carries products or notes, deltas / rates / cost /
// variance are computed as documented, and the runner degrades honestly (a
// case whose photos cannot be read is skipped, never analyzed on partial input).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), clear: jest.fn().mockReturnValue({ add: jest.fn() }) }));
jest.mock('../models/db', () => { const db = () => ({}); db.raw = () => ({}); db.schema = {}; return db; });
jest.mock('../services/llm/call', () => ({ ...jest.requireActual('../services/llm/call'), dispatchWithFallback: jest.fn() }));
jest.mock('knex', () => jest.fn());
jest.mock('../services/photos', () => ({ getPhotoBase64: jest.fn() }));

const evalLib = require('../services/eval/lawn-visit-assessment-eval');
const { PROMPT_VERSION, PROMPT_DIGEST } = require('../services/lawn-visit-input');

const row = (overrides = {}) => ({
  id: 'a1', customer_id: 'c1', service_id: 's1', service_date: '2026-09-01', season: 'peak', observations: 'legacy obs mentioning the LOCKBOX 4471 and Mrs. Smith',
  composite_scores: JSON.stringify({ turf_density: 70, weed_suppression: 85, color_health: 75, fungus_control: 75, thatch_level: 60, stress_damage: 50 }),
  turf_density: 75, weed_suppression: 85, color_health: 80, fungus_control: 75, thatch_level: 60, stress_damage: 55,
  scheduled_date: '2026-08-30', first_name: 'MUST NOT LEAK', phone: '+15550000000', address_line1: '1 Private Way',
  ...overrides,
});
const photos = [{ id: 'p2', s3_key: 'k2', mime_type: 'image/jpeg', photo_order: 1, zone: null }, { id: 'p1', s3_key: 'k1', mime_type: 'image/png', photo_order: 0, zone: 'front' }];
const sig = (level) => ({ level, evidence: 'e', confidence: 'moderate' });
const analysis = (overrides = {}) => ({
  status: 'complete', reason: null, provider: 'gemini', model: 'gemini-3.8-flash', fallbackUsed: false, failures: [], latencyMs: 4200,
  usage: { input_tokens: 9000, output_tokens: 4000, reasoning_tokens: 1000 }, contextHash: 'h', observations: 'obs', grassType: 'st_augustine',
  photoQuality: [{ photo: 1, quality: 'adequate', issue: '' }],
  raw: { findings: [
    { finding_id: 'F1', name: 'Irregular browning along the edge', confidence: 'moderate' },
    { finding_id: 'F2', name: 'Chinch bug damage', confidence: 'low' },
  ] },
  findings: [
    { finding_id: 'F1', name: 'Irregular browning along the edge', label: 'a lawn condition we are monitoring', confidence: 'moderate', severity: 'moderate', urgency: 'follow_up', photo_refs: [1], zone: 'front', can_determine: true, cannot_determine_reason: '', observed_evidence: ['x'], negative_evidence: [], confirmation_step: 'float test' },
    { finding_id: 'F2', name: 'Chinch bug damage', label: 'general lawn stress', confidence: 'low', severity: 'mild', urgency: 'monitor', photo_refs: [], zone: 'unknown', can_determine: false, cannot_determine_reason: 'no close-up', observed_evidence: [], negative_evidence: [], confirmation_step: '' },
  ],
  severities: { fungal_activity: sig('minor'), insect_damage: sig('unknown'), drought_stress: sig('moderate'), mechanical_damage: sig('none'), thatch_visibility: sig('moderate'), overwatering_signal: sig('no') },
  scores: { turf_density: 70, weed_coverage: 20, color_health: null },
  ...overrides,
});

describe('fixture export shape', () => {
  test('carries ids, dates, keys, scores and agronomic context — never names, phones or addresses', () => {
    const c = evalLib.fixtureCase(row(), photos, { grassType: 'St. Augustine', irrigation: 'sprinkler, 1 in/wk', priorSummary: 'x'.repeat(500) });
    expect(c).toMatchObject({ assessmentId: 'a1', customerId: 'c1', serviceId: 's1', visitDate: '2026-08-30', month: 8, season: 'peak' });
    expect(c.confirmed).toEqual({ turf_density: 75, weed_suppression: 85, color_health: 80, fungus_control: 75, thatch_level: 60, stress_damage: 55 });
    expect(c.legacyAi.turf_density).toBe(70);
    expect(c.photos).toEqual([{ id: 'p1', s3Key: 'k1', mimeType: 'image/png', zone: 'front' }, { id: 'p2', s3Key: 'k2', mimeType: 'image/jpeg', zone: null }]); // ordered
    expect(c.context.priorSummary).toBeNull();
    // No names, phones, addresses — and no legacy observation text (it can echo technician context).
    expect(JSON.stringify(c)).not.toMatch(/MUST NOT LEAK|\+1555|Private Way|LOCKBOX|Smith|legacy obs/);
    expect(c.legacyObservations).toBeUndefined();
    expect(evalLib.contextFor({ ...c, context: { priorSummary: 'Unproven customer narrative' } })).not.toHaveProperty('priorSummary');
    // The exporter's own omissions ride along, and an unproven field is never silently absent.
    expect(evalLib.fixtureCase(row(), [], { omitted: [{ field: 'grassType', reason: 'profile_touched_since_visit' }] }).context.omitted).toEqual([{ field: 'grassType', reason: 'profile_touched_since_visit' }]);
    expect(evalLib.fixtureCase(row(), [], {}).context.omitted).toEqual([]);
    // A failed upload (a pending/ key) makes the whole case photo-less and flagged: never a partial replay.
    const partial = evalLib.fixtureCase(row(), [...photos, { id: 'p3', s3_key: 'pending/a1/3.jpg', photo_order: 2 }], {});
    expect(partial).toMatchObject({ incompletePhotos: true, photos: [] });
    expect(evalLib.fixtureCase(row(), photos, {})).toMatchObject({ incompletePhotos: false });
    // Fewer stored rows than the visit submitted (a swallowed insert failure) is incomplete too.
    expect(evalLib.fixtureCase(row({ photos: JSON.stringify([{ filename: 'a' }, { filename: 'b' }, { filename: 'c' }]) }), photos, {})).toMatchObject({ incompletePhotos: true, photos: [] });
    expect(evalLib.fixtureCase(row({ photos: JSON.stringify([{ filename: 'a' }, { filename: 'b' }]) }), photos, {})).toMatchObject({ incompletePhotos: false });
    expect(evalLib.fixtureCase(row(), photos, {}).photos).toHaveLength(2);
    expect(evalLib.fixtureCase(row({ scheduled_date: null, composite_scores: null }), []).visitDate).toBe('2026-09-01');
  });

  test('pg DATE values arrive as Date objects or strings; both become the ISO calendar day, never String(Date)', () => {
    expect(evalLib.dateString(new Date('2026-09-01T04:00:00.000Z'))).toBe('2026-09-01');
    expect(evalLib.dateString('2026-07-15')).toBe('2026-07-15');
    expect(evalLib.dateString('2026-07-15T00:00:00.000Z')).toBe('2026-07-15');
    expect(evalLib.dateString('Tue Sep 01 2026')).toBeNull();
    expect(evalLib.dateString(null)).toBeNull();
    const c = evalLib.fixtureCase(row({ scheduled_date: new Date('2026-01-15T05:00:00.000Z') }), [], {});
    expect(c.visitDate).toBe('2026-01-15');
    expect(c.month).toBe(1);
    expect(evalLib.contextFor(c).season).toBe('dormant');
  });

  test('selection is the explicit ids plus a deterministic sample, each case once in population order; neither asked for is every case', () => {
    const cases = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ assessmentId: id }));
    const ids = (selected) => selected.map((c) => c.assessmentId);
    expect(ids(evalLib.selectCases(cases, { ids: ['d', 'zz', 'a'] }))).toEqual(['a', 'd']);
    const s1 = ids(evalLib.selectCases(cases, { sample: 3 }));
    expect(s1).toHaveLength(3);
    expect(ids(evalLib.selectCases(cases.slice().reverse(), { sample: 3 })).sort()).toEqual(s1.slice().sort());
    // --ids … --sample N (the export recipe) is their union.
    expect(ids(evalLib.selectCases(cases, { ids: ['e', 'a'], sample: 3 }))).toEqual(ids(cases).filter((id) => ['a', 'e'].includes(id) || s1.includes(id)));
    expect(evalLib.selectCases(cases, {})).toHaveLength(5);
  });

  test('the replay context is the visit-dated season plus what was on file — the gauge reading included — no products, no notes', () => {
    const c = evalLib.fixtureCase(row({ scheduled_date: '2026-01-15' }), [], { grassType: 'Zoysia', irrigation: 'well, 0.5 in/wk', priorSummary: 'Prior.', turfHeightIn: '3.50' });
    expect(c.context.turfHeightIn).toBe(3.5);
    expect(evalLib.contextFor(c)).toEqual({ region: 'Southwest Florida', month: 1, season: 'dormant', grassType: 'Zoysia', turfHeightIn: 3.5, irrigation: 'well, 0.5 in/wk' });
    expect(evalLib.contextFor({ month: 7, context: {} })).toEqual({ region: 'Southwest Florida', month: 7, season: 'peak' });
    // The season is the route's classifier, never a parallel month map.
    const { getSeason } = require('../services/lawn-assessment');
    for (let month = 1; month <= 12; month += 1) expect(evalLib.contextFor({ month, context: {} }).season).toBe(getSeason(month));
    expect(evalLib.seasonOf).toBeUndefined();
    // No reading, or one outside the route's 0.5–8 in acceptance range, omits the line exactly as /assess does.
    expect(evalLib.fixtureCase(row(), [], {}).context.turfHeightIn).toBeNull();
    for (const value of [0.25, 9, 'tall', null]) expect(evalLib.fixtureCase(row(), [], { turfHeightIn: value }).context.turfHeightIn).toBeNull();
    expect(evalLib.contextFor(evalLib.fixtureCase(row(), [], { turfHeightIn: 9 }))).not.toHaveProperty('turfHeightIn');
  });
});

describe('scoring', () => {
  const testCase = evalLib.fixtureCase(row(), photos, {});

  test('cost uses the listed prices per model; Gemini thoughts are added, OpenAI reasoning is already inside output_tokens; unknown model → null', () => {
    expect(evalLib.costUsd('gemini-3.8-flash', { input_tokens: 1_000_000, output_tokens: 500_000, reasoning_tokens: 500_000 })).toBe(0.75 + 3.75);
    expect(evalLib.costUsd('gpt-6-astra', { input_tokens: 100_000, output_tokens: 10_000, reasoning_tokens: 8_000 })).toBe(1.5); // reasoning not billed twice
    expect(evalLib.costUsd('mystery', { input_tokens: 1 })).toBeNull();
    expect(evalLib.costUsd('gpt-6-astra', null)).toBeNull();
    // A usage object with null counts (provider omitted its metadata) is an unknown charge, never $0.
    expect(evalLib.costUsd('gpt-6-astra', { input_tokens: null, output_tokens: null, reasoning_tokens: null })).toBeNull();
    expect(evalLib.costUsd('gpt-6-astra', { input_tokens: 100, output_tokens: null })).toBeNull();
    expect(evalLib.costUsd('gemini-3.8-flash', { input_tokens: 100, output_tokens: 10, reasoning_tokens: null })).toBe(evalLib.costUsd('gemini-3.8-flash', { input_tokens: 100, output_tokens: 10, reasoning_tokens: 0 }));
    const nullUsage = evalLib.scoreResult(testCase, analysis({ usage: { input_tokens: null, output_tokens: null, reasoning_tokens: null } }), { adjust: (s) => s });
    expect(nullUsage.costUsd).toBeNull();
    expect(nullUsage.unpricedLegs).toBe(1);
  });

  test('a complete replay scores deltas per known metric, reports undeterminable keys and the model\'s naming discipline', () => {
    const r = evalLib.scoreResult(testCase, analysis(), { adjust: (scores) => ({ ...scores, turf_density: scores.turf_density + 5 }) });
    expect(r.status).toBe('complete');
    // derived: turf 70, weeds 80, color null, fungus 75 (minor), thatch 60 (moderate), stress 50 (drought moderate; insect unknown ignored)
    expect(r.derived).toMatchObject({ turf_density: 70, weed_suppression: 80, color_health: null, fungus_control: 75, thatch_level: 60, stress_damage: 50 });
    expect(r.adjusted.turf_density).toBe(75);
    expect(r.adjusted.color_health).toBeNull();
    expect(r.deltas.vsConfirmed).toEqual({ turf_density: 0, weed_suppression: -5, fungus_control: 0, thatch_level: 0, stress_damage: -5 });
    expect(r.deltas.vsLegacyAi).toEqual({ turf_density: 0, weed_suppression: -5, fungus_control: 0, thatch_level: 0, stress_damage: 0 });
    expect(r.undeterminable).toEqual(['color_health']);
    expect(r.causeNamedBelowModerate).toEqual([{ finding_id: 'F2', name: 'Chinch bug damage', confidence: 'low', label: undefined }]);
    // The vocabulary is the production governed-cause lexicon, generic classes included: a low "fungal activity",
    // "disease pressure" or "insect damage" counts; a symptom-only name never does.
    const low = (name) => ({ finding_id: 'F9', name, confidence: 'low', label: 'general lawn stress' });
    expect(evalLib.causeNamedBelowModerate([low('Fungal activity'), low('Disease pressure in the shade'), low('Insect damage'), low('Irregular browning along the edge'), { ...low('Fungal activity'), confidence: 'moderate' }]).map((f) => f.name))
      .toEqual(['Fungal activity', 'Disease pressure in the shade', 'Insect damage']);
    expect(r.costUsd).toBe(0.0255); // (9000 × 0.75 + 5000 × 3.75) / 1e6, reasoning billed as output
    expect(r.findings).toHaveLength(2);
    expect(r.findings[1]).toMatchObject({ can_determine: false, cannot_determine_reason: 'no close-up' });
  });

  test('naming discipline uses raw confidence while reported findings retain the evidence gate', () => {
    const answer = analysis({ raw: { findings: [{ finding_id: 'model-1', name: 'Chinch bug damage', confidence: 'high', photo_refs: [], can_determine: true }] } });
    const normalized = require('../services/lawn-visit-result').normalizeAssessment({ findings: answer.raw.findings, photo_quality: [{ photo: 1, quality: 'adequate' }], severities: answer.severities, scores: answer.scores }, 1);
    const result = evalLib.scoreResult(testCase, { ...answer, findings: normalized.findings });
    expect(result.causeNamedBelowModerate).toEqual([]);
    expect(result.findings[0]).toMatchObject({ confidence: 'unknown', can_determine: false, label: 'general lawn stress' });
    answer.raw.findings[0].confidence = 'low';
    expect(evalLib.scoreResult(testCase, { ...answer, findings: normalized.findings }).causeNamedBelowModerate).toEqual([
      expect.objectContaining({ name: 'Chinch bug damage', confidence: 'low' }),
    ]);
  });

  test('an unavailable replay carries the reason and no scores', () => {
    const r = evalLib.scoreResult(testCase, { status: 'unavailable', reason: 'all_providers_failed', failures: [{ provider: 'gemini', reason: 'no_key' }], latencyMs: 900, usage: null });
    expect(r).toMatchObject({ status: 'unavailable', unavailableReason: 'all_providers_failed', derived: null, deltas: null, costUsd: null, usage: null, legs: [], findings: [] });
    expect(r.undeterminable).toEqual(evalLib.SCORE_KEYS);
  });

  test('every billed leg counts: a rejected primary answer and both legs of an unavailable run add their tokens and cost', () => {
    const rejected = { provider: 'gemini', model: 'gemini-3.8-flash', reason: 'empty_findings', validator: true, usage: { input_tokens: 9000, output_tokens: 1000, reasoning_tokens: 500 } };
    const won = { ...analysis(), provider: 'openai', model: 'gpt-6-astra', fallbackUsed: true, failures: [rejected], usage: { input_tokens: 10000, output_tokens: 2000, reasoning_tokens: 1500 } };
    const r = evalLib.scoreResult(testCase, won);
    expect(r.legs).toEqual([
      { provider: 'gemini', model: 'gemini-3.8-flash', reason: 'empty_findings', usage: rejected.usage },
      { provider: 'openai', model: 'gpt-6-astra', reason: null, usage: won.usage },
    ]);
    expect(r.usage).toEqual({ input_tokens: 19000, output_tokens: 3000, reasoning_tokens: 2000 });
    // gemini: (9000 × 0.75 + 1500 × 3.75) / 1e6 = 0.012375; astra: (10000 × 5 + 2000 × 25) / 1e6 = 0.1 → 0.1124 (4 dp)
    expect(r.costUsd).toBe(evalLib.costUsd('gemini-3.8-flash', rejected.usage) + evalLib.costUsd('gpt-6-astra', won.usage));
    // Both legs failed after billing: still spent.
    const both = evalLib.scoreResult(testCase, { status: 'unavailable', reason: 'all_providers_failed', failures: [rejected, { provider: 'openai', model: 'gpt-6-astra', reason: 'openai_incomplete', usage: { input_tokens: 100, output_tokens: 50 } }], usage: null });
    expect(both.legs).toHaveLength(2);
    expect(both.usage).toEqual({ input_tokens: 9100, output_tokens: 1050, reasoning_tokens: 500 });
    expect(both.costUsd).toBe(evalLib.costUsd('gemini-3.8-flash', rejected.usage) + evalLib.costUsd('gpt-6-astra', { input_tokens: 100, output_tokens: 50 }));
    // A missing-key failure never reached the model and is not a leg; a chain with an unpriced leg has an UNKNOWN cost
    // (never the priced legs presented as the total), while its tokens still count.
    const mixed = evalLib.scoreResult(testCase, { ...analysis(), failures: [{ provider: 'gemini', reason: 'no_key' }, { provider: 'openai', model: 'mystery', reason: 'x', usage: { input_tokens: 1, output_tokens: 1 } }] });
    expect(mixed.legs.map((leg) => leg.model)).toEqual(['mystery', 'gemini-3.8-flash']);
    expect(mixed.costUsd).toBeNull();
    expect(mixed.unpricedLegs).toBe(1);
    expect(mixed.usage.input_tokens).toBe(9001);
    expect(evalLib.legsCostUsd([])).toBeNull();
    expect(both.unpricedLegs).toBe(0);
  });

  test('executed legs without token metadata remain unpriced, including the winning answer', () => {
    for (const failure of [
      { reason: 'invalid_shape', validator: true },
      { reason: 'empty_json' },
      { reason: 'gemini_timeout' },
    ]) {
      const result = evalLib.scoreResult(testCase, analysis({ failures: [{ provider: 'gemini', model: 'gemini-3.8-flash', ...failure }] }));
      expect(result.legs).toHaveLength(2);
      expect(result.legs[0].usage).toBeNull();
      expect(result.unpricedLegs).toBe(1);
      expect(result.costUsd).toBeNull();
      expect(result.usage.input_tokens).toBe(9000);
    }
    const missingWinnerUsage = evalLib.scoreResult(testCase, analysis({ usage: null }));
    expect(missingWinnerUsage.legs).toHaveLength(1);
    expect(missingWinnerUsage.unpricedLegs).toBe(1);
    expect(missingWinnerUsage.costUsd).toBeNull();
    expect(evalLib.billedLegs({ status: 'unavailable', failures: [
      { reason: 'no_key' }, { reason: 'no_route' }, { reason: 'unsupported_pdf_provider' },
      { reason: 'timeout_budget_exhausted' }, { reason: 'unknown_provider_example' },
    ] })).toEqual([]);
  });

  test('summary: MAE + bias per metric, undeterminable and unavailable rates, provider mix, percentiles, cost, repeat variance', () => {
    const a1 = evalLib.scoreResult(testCase, analysis(), { adjust: (s) => s });
    const a2 = evalLib.scoreResult(testCase, analysis({ scores: { turf_density: 80, weed_coverage: 20, color_health: 8 }, latencyMs: 6000, provider: 'openai', model: 'gpt-6-astra', fallbackUsed: true }), { adjust: (s) => s });
    const u = evalLib.scoreResult({ ...testCase, assessmentId: 'a2' }, { status: 'unavailable', reason: 'all_providers_failed', latencyMs: 500 });
    const summary = evalLib.summarize([a1, a2, u]);
    expect(summary).toMatchObject({ runs: 3, cases: 2, unavailable: 1, unavailableRate: 0.333 });
    expect(summary.byProvider).toEqual({ 'gemini:gemini-3.8-flash': 1, 'openai:gpt-6-astra (fallback)': 1, unavailable: 1 });
    // turf: |70-75| = 5 and |80-75| = 5 → MAE 5, bias (−5 + 5)/2 = 0
    expect(summary.mae.vsConfirmed.turf_density).toEqual({ mae: 5, bias: 0, n: 2 });
    expect(summary.mae.vsLegacyAi.turf_density).toEqual({ mae: 5, bias: 5, n: 2 });
    // No priced leg is an unknown spend, never $0.
    const unpriced = evalLib.summarize([evalLib.scoreResult(testCase, analysis({ model: 'gemini-override' }), { adjust: (s) => s })]);
    expect(unpriced.costUsd).toEqual({ total: null, perRun: null, priced: 0, unpriced: 1 });
    expect(evalLib.renderMarkdown(unpriced)).toMatch(/est\. cost \$n\/a .*1 with an unpriced leg — spend unknown/);
    // A partially priced chain sits outside the total and is disclosed next to it.
    const partial = evalLib.summarize([a1, evalLib.scoreResult(testCase, analysis({ failures: [{ provider: 'gemini', model: 'gemini-override', reason: 'x', usage: { input_tokens: 5, output_tokens: 5 } }] }), { adjust: (s) => s })]);
    expect(partial.costUsd).toEqual({ total: 0.0255, perRun: 0.0255, priced: 1, unpriced: 1 });
    // Omitted context is counted per field and disclosed in the report.
    const omittedCase = { ...testCase, context: { ...testCase.context, omitted: [{ field: 'grassType', reason: 'profile_touched_since_visit' }, { field: 'irrigation', reason: 'no_profile' }] } };
    const omittedSummary = evalLib.summarize([{ ...a1, contextOmitted: omittedCase.context.omitted }, a2]);
    expect(omittedSummary.contextOmitted).toEqual({ runs: 1, byField: { grassType: 1, irrigation: 1 } });
    expect(evalLib.renderMarkdown(omittedSummary)).toMatch(/context omitted \(not provably visit-time\) in 1 run\(s\): grassType ×1, irrigation ×1/);
    expect(evalLib.renderMarkdown(summary)).toMatch(/no context omitted/);
    // Provenance is on every report: the prompt version and digest, and the fixture's property-history branch.
    expect(evalLib.renderMarkdown(summary, [], { promptVersion: 'lawn-visit-v1', promptDigest: 'abcdef0123456789', propertyHistory: false })).toMatch(/\nprompt lawn-visit-v1 · digest abcdef0123456789 · fixture property history off\n/);
    expect(evalLib.provenanceLine({})).toBe('prompt unknown · digest unknown · fixture property history unknown');
    expect(evalLib.provenanceLine({ promptVersion: 'v', promptDigest: 'd', propertyHistory: true })).toBe('prompt v · digest d · fixture property history on');
    expect(summary.mae.vsConfirmed.color_health).toEqual({ mae: 0, bias: 0, n: 1 }); // a2 color 8 → 80 = confirmed 80; a1 undeterminable
    expect(summary.undeterminableRate.color_health).toBe(0.5);
    expect(summary.causeNamedBelowModerate).toBe(2);
    expect(summary.latencyMs).toEqual({ p50: 4200, p95: 6000 });
    expect(summary.tokens).toEqual({ input: 18000, output: 8000, reasoning: 2000 });
    expect(summary.costUsd.priced).toBe(2);
    expect(summary.repeatVariance.turf_density).toBe(7.1); // stddev of [70, 80]
    expect(summary.repeatVariance.color_health).toBeNull(); // only one determinable value
  });

  test('the markdown report names the run, the metric table and one row per replay', () => {
    const r = { ...evalLib.scoreResult(testCase, analysis(), { adjust: (s) => s }), inputHash: 'a'.repeat(64), contextHash: 'b'.repeat(64), repeatIndex: 1 };
    const md = evalLib.renderMarkdown(evalLib.summarize([r]), [r], { title: 'T' });
    expect(md).toContain('## T');
    expect(md).toContain('| turf_density | 5 |');
    expect(md).toMatch(/\| a1 \| 2026-08-30 \| 2 \| complete \| gemini \| 4200 \| 70 \(-5\) \| 80 \(-5\) \| n\/d \|/);
    expect(md).toContain('general lawn stress @ low (n/d)');
    expect(md).toContain(`| a1 | 2 | ${'a'.repeat(64)} | ${'b'.repeat(64)} |`);
  });
});

describe('ops/agents/lawn-visit-assessment-eval.js (the operator script)', () => {
  const fs = require('fs');
  const path = require('path');
  const scriptPath = path.join(__dirname, '../../ops/agents/lawn-visit-assessment-eval.js');
  const { _internals: { parseArgs, exportFixture, runReplay } } = require(scriptPath);

  test('count flags are finite positive whole numbers or the script stops before any export or paid call', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(parseArgs(['node', 'x', '--run', 'f.json', '--limit', '5', '--repeat', '2', '--concurrency', '4'])).toMatchObject({ run: 'f.json', limit: 5, repeat: 2, concurrency: 4 });
      expect(parseArgs(['node', 'x', '--export', '--sample', '3'])).toMatchObject({ export: true, sample: 3 });
      // --sample is an export option: a replay accepting it would look bounded while replaying the whole fixture.
      expect(() => parseArgs(['node', 'x', '--run', 'f.json', '--sample', '3'])).toThrow('exit 2');
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--sample is an export option'));
      for (const [flag, value] of [['--sample', '-1'], ['--limit', '0'], ['--repeat', 'Infinity'], ['--concurrency', '1.5'], ['--sample', 'ten'], ['--repeat', undefined]]) {
        expect(() => parseArgs(['node', 'x', '--run', 'f.json', flag, ...(value === undefined ? [] : [value])])).toThrow('exit 2');
        expect(error).toHaveBeenLastCalledWith(expect.stringContaining(`${flag} needs a positive whole number`));
      }
      expect(exit).toHaveBeenCalledTimes(7);
      // --thinking reaches the Gemini leg only, so it cannot be combined with a forced fallback.
      expect(() => parseArgs(['node', 'x', '--run', 'f.json', '--force-fallback', '--thinking', 'HIGH'])).toThrow('exit 2');
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--thinking has no effect with --force-fallback'));
      expect(parseArgs(['node', 'x', '--run', 'f.json', '--force-fallback'])).toMatchObject({ forceFallback: true, thinking: null });
    } finally { exit.mockRestore(); error.mockRestore(); }
  });

  test('--thinking is LOW, MEDIUM or HIGH in any case or the script stops; --limit unset replays every selected case', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(parseArgs(['node', 'x', '--run', 'f.json', '--thinking', 'low'])).toMatchObject({ thinking: 'LOW', limit: Infinity });
      expect(() => parseArgs(['node', 'x', '--run', 'f.json', '--thinking', 'max'])).toThrow('exit 2');
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--thinking must be LOW, MEDIUM or HIGH, got "max"'));
    } finally { exit.mockRestore(); error.mockRestore(); }
  });

  test.each([true, false])('legacy export reports missing prompt context and excludes new-pipeline rows when the run table exists: %s', async (hasRunTable) => {
    const db = jest.requireActual('knex')({ client: 'pg' });
    const queries = [];
    // Compile real Knex queries while supplying synthetic rows; no database
    // connection or current customer/profile/completion data is available.
    jest.spyOn(db.client, 'runner').mockImplementation((builder) => ({
      run: async () => {
        const compiled = [].concat(builder.toSQL());
        queries.push(...compiled);
        const sql = compiled[0].sql;
        if (sql.includes('information_schema.tables')) return hasRunTable;
        if (sql.includes('from "lawn_assessments" as "la"')) return [row({ created_at: '2026-09-01T13:00:00Z' })];
        if (sql.includes('from "lawn_assessment_photos"')) return photos;
        throw new Error(`Unexpected export query: ${sql}`);
      },
    }));
    require('knex').mockReturnValue(db);
    const env = process.env;
    process.env = { ...env, DATABASE_PUBLIC_URL: 'postgresql://localhost/unused_eval_test', GATE_LAWN_PROPERTY_HISTORY: String(hasRunTable) };
    const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await exportFixture(parseArgs(['node', 'eval', '--export', '--all']));
      const fixture = JSON.parse(write.mock.calls[0][0]);
      expect(fixture).toMatchObject({ fixtureVersion: 1, propertyHistory: hasRunTable, population: 1, cases: [{ assessmentId: 'a1', context: {
        grassType: null, irrigation: null, turfHeightIn: null, priorSummary: null,
        omitted: [
          { field: 'grassType', reason: 'legacy_assessment_has_no_prompt_snapshot' },
          { field: 'irrigation', reason: 'legacy_assessment_has_no_prompt_snapshot' },
          { field: 'turfHeightIn', reason: 'legacy_assessment_has_no_prompt_snapshot' },
          { field: 'priorSummary', reason: 'legacy_assessment_has_no_prompt_snapshot' },
          { field: 'technicianNotes', reason: 'legacy_assessment_has_no_prompt_snapshot' },
        ],
      } }] });
      expect(fixture.cases[0].photos.map((photo) => photo.s3Key)).toEqual(['k1', 'k2']);
      expect(evalLib.contextFor(fixture.cases[0])).toEqual({ region: 'Southwest Florida', month: 8, season: 'peak' });
      const population = queries.find((query) => query.sql.includes('from "lawn_assessments" as "la"'));
      expect(population.sql).toContain('not exists (select 1 from "lawn_assessment_photos"');
      expect(population.bindings).toEqual([true, 'pending/%', 'pending/%']);
      expect(population.sql.includes('not exists (select 1 from "lawn_assessment_runs" as "r"')).toBe(hasRunTable);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('context omitted (not provably visit-time) in 1 of 1 case(s)'));
      const { summary } = await evalLib.runEval(fixture.cases, {
        analyzeVisit: async () => analysis(),
        loadPhoto: async () => ({ data: 'test-photo', mimeType: 'image/jpeg' }),
      });
      expect(summary.contextOmitted).toEqual({ runs: 1, byField: { grassType: 1, irrigation: 1, turfHeightIn: 1, priorSummary: 1, technicianNotes: 1 } });
      expect(evalLib.renderMarkdown(summary)).toContain('grassType ×1, irrigation ×1, turfHeightIn ×1, priorSummary ×1, technicianNotes ×1');
    } finally {
      process.env = env;
      write.mockRestore(); error.mockRestore();
      await db.destroy();
    }
  });

  test.each([true, false, undefined])('both report formats retain fixture history %s and the full prompt digest', async (propertyHistory) => {
    const config = require('../config');
    const bucket = config.s3.bucket;
    config.s3.bucket = 'eval-test';
    const env = process.env;
    process.env = { ...env, GATE_LAWN_PROPERTY_HISTORY: String(!propertyHistory) };
    const readFile = fs.readFileSync;
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation((filename, ...args) => (
      filename === 'eval-fixture.json' ? JSON.stringify({ fixtureVersion: 1, propertyHistory, cases: [evalLib.fixtureCase(row(), photos)] }) : readFile(filename, ...args)
    ));
    const run = jest.spyOn(evalLib, 'runEval').mockResolvedValue({ results: [], skipped: [], summary: evalLib.summarize([]) });
    const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runReplay(parseArgs(['node', 'eval', '--run', 'eval-fixture.json', '--json']));
      expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
        promptVersion: PROMPT_VERSION, promptDigest: PROMPT_DIGEST, propertyHistory: propertyHistory ?? null,
      });
      await runReplay(parseArgs(['node', 'eval', '--run', 'eval-fixture.json']));
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`prompt ${PROMPT_VERSION} · digest ${PROMPT_DIGEST} · fixture property history ${propertyHistory === undefined ? 'unknown' : propertyHistory ? 'on' : 'off'}`));
    } finally {
      config.s3.bucket = bucket;
      process.env = env;
      read.mockRestore(); run.mockRestore(); write.mockRestore(); log.mockRestore(); error.mockRestore();
    }
  });

  test('pre-provenance and unsupported fixtures are rejected before reading photos or calling a model', async () => {
    const config = require('../config');
    const visit = require('../services/lawn-visit-assessment');
    const photoService = require('../services/photos');
    const bucket = config.s3.bucket;
    config.s3.bucket = 'eval-test';
    const env = process.env;
    process.env = { ...env };
    let fixtureVersion;
    const readFile = fs.readFileSync;
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation((filename, ...args) => (
      filename === 'old-eval-fixture.json'
        ? JSON.stringify({ fixtureVersion, cases: [evalLib.fixtureCase(row(), photos, { grassType: 'Zoysia', priorSummary: 'A later summary.' })] })
        : readFile(filename, ...args)
    ));
    const analyze = jest.spyOn(visit, 'analyzeVisit');
    photoService.getPhotoBase64.mockClear();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (fixtureVersion of [undefined, 0, 2, '1', null]) {
        await expect(runReplay(parseArgs(['node', 'eval', '--run', 'old-eval-fixture.json']))).rejects.toThrow('Unsupported evaluation fixture; re-export');
      }
      expect(photoService.getPhotoBase64).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
    } finally {
      config.s3.bucket = bucket;
      process.env = env;
      read.mockRestore(); analyze.mockRestore(); error.mockRestore();
    }
  });

  test('the CLI clears ledger gates after config loads and checks them around replay imports', () => {
    const src = fs.readFileSync(scriptPath, 'utf8');
    // The read-only promise: dotenv (server/config) loads BEFORE the ledger gates are cleared, and the gates are verified
    // before and after every import the replay uses.
    const run = src.slice(src.indexOf('async function runReplay('), src.indexOf('const fixture = JSON.parse('));
    expect(run.indexOf("require(path.join(REPO, 'server/config'))")).toBeLessThan(run.indexOf('for (const gate of LEDGER_GATES) delete process.env[gate];'));
    expect(run.indexOf("assertNoLedgerWrites(gates, 'before imports')")).toBeLessThan(run.indexOf("require(path.join(REPO, 'server/config/models'))"));
    expect(run.indexOf("assertNoLedgerWrites(gates, 'after imports')")).toBeGreaterThan(run.indexOf("require(path.join(REPO, 'server/services/eval/lawn-visit-assessment-eval'))"));
    expect(src).toMatch(/const LEDGER_GATES = \['GATE_LLM_DISPATCH_METRICS', 'GATE_LLM_CALL_LEDGER', 'GATE_LLM_CALL_TRACES'\];/);
    // The script is a module for tests and a program for operators.
    expect(src).toMatch(/if \(require\.main === module\) \{/);
  });
});

test('real provider logger keeps warning and error output out of the JSON document', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const child = spawnSync(process.execPath, ['-e', `
    require('./ops/agents/lawn-visit-assessment-eval')._internals.configureReplayLogging();
    const logger = require('./server/services/logger');
    logger.warn('synthetic provider fallback');
    logger.error('synthetic provider failure');
    logger.info('synthetic replay progress');
    process.stdout.write(JSON.stringify({ results: [], status: 'unavailable' }));
  `], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info' } });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ results: [], status: 'unavailable' });
  expect(child.stderr).toContain('synthetic provider fallback');
  expect(child.stderr).toContain('synthetic provider failure');
  expect(child.stderr).toContain('synthetic replay progress');
});

describe('runner', () => {
  test('invalid legacy photos do not abort valid cases or discard earlier paid repetitions', async () => {
    const { analyzeVisit } = require('../services/lawn-visit-assessment');
    const { dispatchWithFallback } = require('../services/llm/call');
    const { answer } = require('./helpers/lawn-visit-fixtures');
    const valid = evalLib.fixtureCase(row({ id: 'valid' }), [photos[0]]);
    const tooMany = evalLib.fixtureCase(row({ id: 'too-many' }), Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, s3_key: `many-${i}` })));
    const wrongType = evalLib.fixtureCase(row({ id: 'wrong-type' }), [{ id: 'bad', s3_key: 'gif' }]);
    const last = evalLib.fixtureCase(row({ id: 'last' }), [photos[0]]);
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, provider: 'gemini', model: 'gemini-3.8-flash', json: answer(), usage: { input_tokens: 100, output_tokens: 50 } });
    const out = await evalLib.runEval([valid, tooMany, wrongType, last], {
      analyzeVisit,
      loadPhoto: async key => ({ data: 'YQ==', mimeType: key === 'gif' ? 'image/gif' : 'image/jpeg' }),
    }, { concurrency: 2 });
    expect(out.results.map(r => r.assessmentId)).toEqual(['last', 'valid']);
    expect(out.skipped.map(r => r.assessmentId).sort()).toEqual(['too-many', 'wrong-type']);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(2);
    expect(out.summary.tokens.input).toBe(200);

    const analyze = jest.fn().mockResolvedValueOnce(analysis()).mockRejectedValueOnce(new Error('synthetic failure'));
    const repeated = await evalLib.runEval([valid], { analyzeVisit: analyze, loadPhoto: async () => ({ data: 'YQ==' }) }, { repeat: 3 });
    expect(repeated.results).toHaveLength(1);
    expect(repeated.summary.tokens.input).toBe(9000);
    expect(repeated.skipped).toEqual([{ assessmentId: 'valid', repeatIndex: 1, reason: 'analysis failed: synthetic failure' }]);
    expect(analyze).toHaveBeenCalledTimes(2);
    dispatchWithFallback.mockReset();
  });

  test('replays through the replacement service with matching prompt hashes and unknown-score handling', async () => {
    const { analyzeVisit } = require('../services/lawn-visit-assessment');
    const { dispatchWithFallback } = require('../services/llm/call');
    const { answer } = require('./helpers/lawn-visit-fixtures');
    const testCase = evalLib.fixtureCase(row(), [{ ...photos[1], zone: 'Front' }]);
    dispatchWithFallback.mockResolvedValueOnce({
      ok: true, provider: 'gemini', model: 'gemini-3.8-flash', failures: [],
      json: answer({ scores: {
        turf_density: { determinable: true, value: 70 },
        weed_coverage: { determinable: true, value: 20 },
        color_health: { determinable: false, value: null },
      } }),
      usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10 },
    }).mockResolvedValueOnce({ ok: false, reason: 'providers_unavailable', failures: [] });
    const output = await evalLib.runEval([testCase], {
      analyzeVisit,
      loadPhoto: async () => ({ data: 'YQ==', mimeType: 'image/jpeg' }),
    }, { repeat: 2 });
    expect(output.results[0]).toMatchObject({
      status: 'complete', derived: { turf_density: 70, weed_suppression: 80, color_health: null },
    });
    expect(output.results[1]).toMatchObject({ status: 'unavailable', derived: null });
    for (const result of output.results) expect(result.inputHash).toBe(result.contextHash);
    expect(output.summary.unavailable).toBe(1);
    dispatchWithFallback.mockReset();
  });

  const cases = [
    evalLib.fixtureCase(row({ id: 'a1' }), photos, {}),
    evalLib.fixtureCase(row({ id: 'a2', scheduled_date: '2026-07-01' }), [{ id: 'p9', s3_key: 'broken', photo_order: 0 }], {}),
    evalLib.fixtureCase(row({ id: 'a3' }), [], {}),
    evalLib.fixtureCase(row({ id: 'a4' }), [...photos, { id: 'p4', s3_key: 'pending/a4/3.jpg', photo_order: 2 }], {}),
  ];

  test('replays every case `repeat` times with numbered zones and the visit context, skips unreadable or photo-less cases', async () => {
    const calls = [];
    const deps = {
      analyzeVisit: async (input) => { calls.push(input); return analysis({ latencyMs: 100 + calls.length }); },
      loadPhoto: async (key) => { if (key === 'broken') throw new Error('NoSuchKey'); return { data: `data-${key}`, mimeType: 'image/jpeg' }; },
    };
    const out = await evalLib.runEval(cases, deps, { repeat: 2, concurrency: 3, thinkingLevel: 'LOW' });
    expect(calls).toHaveLength(2);
    expect(calls[0].photos.map((p) => p.data)).toEqual(['data-k1', 'data-k2']);
    expect(calls[0].photos.map((photo) => photo.zone)).toEqual(['front', null]);
    expect(calls[0].visionContext).toMatchObject({ month: 8, season: 'peak', region: 'Southwest Florida' });
    expect(calls[0].thinkingLevel).toBe('LOW');
    expect(out.results.map((r) => [r.assessmentId, r.repeatIndex])).toEqual([['a1', 0], ['a1', 1]]);
    expect(out.results[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.skipped.sort((a, b) => a.assessmentId.localeCompare(b.assessmentId))).toEqual([{ assessmentId: 'a2', reason: 'photo read failed: NoSuchKey' }, { assessmentId: 'a3', reason: 'no stored photos' }, { assessmentId: 'a4', reason: 'incomplete stored photo set' }]);
    expect(out.summary.runs).toBe(2);
  });
});
