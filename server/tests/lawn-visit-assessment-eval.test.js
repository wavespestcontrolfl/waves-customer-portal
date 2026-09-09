// Stage-2b eval scoring (services/eval/lawn-visit-assessment-eval.js): the
// exported case shape carries no personal data, selection is deterministic,
// the replay context never carries products or notes, deltas / rates / cost /
// variance are computed as documented, and the runner degrades honestly (a
// case whose photos cannot be read is skipped, never analyzed on partial input).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => { const db = () => ({}); db.raw = () => ({}); db.schema = {}; return db; });
jest.mock('../services/llm/call', () => ({ ...jest.requireActual('../services/llm/call'), dispatchWithFallback: jest.fn() }));

const evalLib = require('../services/eval/lawn-visit-assessment-eval');

const row = (overrides = {}) => ({
  id: 'a1', customer_id: 'c1', service_id: 's1', service_date: '2026-09-01', season: 'peak', observations: 'legacy obs mentioning the LOCKBOX 4471 and Mrs. Smith',
  composite_scores: JSON.stringify({ turf_density: 70, weed_suppression: 85, color_health: 75, fungus_control: 75, thatch_level: 60, stress_damage: 50 }),
  turf_density: 75, weed_suppression: 85, color_health: 80, fungus_control: 75, thatch_level: 60, stress_damage: 55,
  scheduled_date: '2026-08-30', first_name: 'MUST NOT LEAK', phone: '+15550000000', address_line1: '1 Private Way',
  ...overrides,
});
const photos = [{ id: 'p2', s3_key: 'k2', mime_type: 'image/jpeg', photo_order: 1, zone: null }, { id: 'p1', s3_key: 'k1', mime_type: 'image/png', photo_order: 0, zone: 'front' }, { id: 'p0', s3_key: 'pending/x', photo_order: 2 }];
const sig = (level) => ({ level, evidence: 'e', confidence: 'moderate' });
const analysis = (overrides = {}) => ({
  status: 'complete', reason: null, provider: 'gemini', model: 'gemini-3.8-flash', fallbackUsed: false, failures: [], latencyMs: 4200,
  usage: { input_tokens: 9000, output_tokens: 4000, reasoning_tokens: 1000 }, contextHash: 'h', observations: 'obs', grassType: 'st_augustine',
  photoQuality: [{ photo: 1, quality: 'adequate', issue: '' }],
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
    expect(c.photos).toEqual([{ id: 'p1', s3Key: 'k1', mimeType: 'image/png', zone: 'front' }, { id: 'p2', s3Key: 'k2', mimeType: 'image/jpeg', zone: null }]); // pending/ dropped, ordered
    expect(c.context.priorSummary).toHaveLength(400);
    // No names, phones, addresses — and no legacy observation text (it can echo technician context).
    expect(JSON.stringify(c)).not.toMatch(/MUST NOT LEAK|\+1555|Private Way|LOCKBOX|Smith|legacy obs/);
    expect(c.legacyObservations).toBeUndefined();
    // The prior summary was written with the customer's name in the prompt: names, phones and addresses are scrubbed before export.
    const named = evalLib.fixtureCase(row(), [], { priorSummary: "Mrs. Smith's lawn at 12 Private Way improved; Jane Smith asked us to call 941-555-0100.", customerNames: ['Jane', 'Smith'] });
    expect(named.context.priorSummary).not.toMatch(/Smith|Jane|Private Way|941/);
    expect(named.context.priorSummary).toMatch(/^the customer's lawn at the property improved; the customer asked us to call/);
    expect(named.context.priorSummary).not.toMatch(/the customer the customer/);
    expect(evalLib.scrubPriorSummary('  ', ['x'])).toBeNull();
    expect(evalLib.scrubPriorSummary(null)).toBeNull();
    expect(evalLib.scrubPriorSummary('Fine lawn.', [null, 'A'])).toBe('Fine lawn.');
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

  test('selection is by explicit ids first, else a deterministic sample', () => {
    const cases = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ assessmentId: id }));
    expect(evalLib.selectCases(cases, { ids: ['d', 'zz', 'a'] }).map((c) => c.assessmentId)).toEqual(['a', 'd']);
    const s1 = evalLib.selectCases(cases, { sample: 3 }).map((c) => c.assessmentId);
    expect(s1).toHaveLength(3);
    expect(evalLib.selectCases(cases.slice().reverse(), { sample: 3 }).map((c) => c.assessmentId)).toEqual(s1);
    expect(evalLib.selectCases(cases, {})).toHaveLength(5);
  });

  test('the replay context is the visit-dated season plus what was on file — no products, no notes', () => {
    const c = evalLib.fixtureCase(row({ scheduled_date: '2026-01-15' }), [], { grassType: 'Zoysia', irrigation: 'well, 0.5 in/wk', priorSummary: 'Prior.' });
    expect(evalLib.contextFor(c)).toEqual({ region: 'Southwest Florida', month: 1, season: 'dormant', grassType: 'Zoysia', irrigation: 'well, 0.5 in/wk', priorSummary: 'Prior.' });
    expect(evalLib.contextFor({ month: 7, context: {} })).toEqual({ region: 'Southwest Florida', month: 7, season: 'peak' });
  });
});

describe('scoring', () => {
  const testCase = evalLib.fixtureCase(row(), photos, {});

  test('cost uses the listed prices per model; Gemini thoughts are added, OpenAI reasoning is already inside output_tokens; unknown model → null', () => {
    expect(evalLib.costUsd('gemini-3.8-flash', { input_tokens: 1_000_000, output_tokens: 500_000, reasoning_tokens: 500_000 })).toBe(0.75 + 3.75);
    expect(evalLib.costUsd('gpt-6-astra', { input_tokens: 100_000, output_tokens: 10_000, reasoning_tokens: 8_000 })).toBe(1.5); // reasoning not billed twice
    expect(evalLib.costUsd('mystery', { input_tokens: 1 })).toBeNull();
    expect(evalLib.costUsd('gpt-6-astra', null)).toBeNull();
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
    expect(r.causeNamedBelowModerate).toEqual([{ finding_id: 'F2', name: 'Chinch bug damage', confidence: 'low', label: 'general lawn stress' }]);
    expect(r.costUsd).toBe(0.0255); // (9000 × 0.75 + 5000 × 3.75) / 1e6, reasoning billed as output
    expect(r.findings).toHaveLength(2);
    expect(r.findings[1]).toMatchObject({ can_determine: false, cannot_determine_reason: 'no close-up' });
  });

  test('an unavailable replay carries the reason and no scores', () => {
    const r = evalLib.scoreResult(testCase, { status: 'unavailable', reason: 'all_providers_failed', failures: [{ provider: 'gemini', reason: 'gemini_503' }], latencyMs: 900, usage: null });
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
    // A failure without usage (never reached the model) is not a leg; an unpriced model adds no cost but its tokens still count.
    const mixed = evalLib.scoreResult(testCase, { ...analysis(), failures: [{ provider: 'gemini', reason: 'gemini_503' }, { provider: 'openai', model: 'mystery', reason: 'x', usage: { input_tokens: 1, output_tokens: 1 } }] });
    expect(mixed.legs.map((leg) => leg.model)).toEqual(['mystery', 'gemini-3.8-flash']);
    expect(mixed.costUsd).toBe(0.0255);
    expect(mixed.usage.input_tokens).toBe(9001);
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
    const r = evalLib.scoreResult(testCase, analysis(), { adjust: (s) => s });
    const md = evalLib.renderMarkdown(evalLib.summarize([r]), [r], { title: 'T' });
    expect(md).toContain('## T');
    expect(md).toContain('| turf_density | 5 |');
    expect(md).toMatch(/\| a1 \| 2026-08-30 \| 2 \| complete \| gemini \| 4200 \| 70 \(-5\) \| 80 \(-5\) \| n\/d \|/);
    expect(md).toContain('general lawn stress @ low (n/d)');
  });
});

describe('ops/agents/lawn-visit-assessment-eval.js (the operator script)', () => {
  const fs = require('fs');
  const path = require('path');
  const scriptPath = path.join(__dirname, '../../ops/agents/lawn-visit-assessment-eval.js');
  const { _internals: { parseArgs } } = require(scriptPath);

  test('count flags are finite positive whole numbers or the script stops before any export or paid call', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(parseArgs(['node', 'x', '--run', 'f.json', '--sample', '3', '--limit', '5', '--repeat', '2', '--concurrency', '4'])).toMatchObject({ run: 'f.json', sample: 3, limit: 5, repeat: 2, concurrency: 4 });
      for (const [flag, value] of [['--sample', '-1'], ['--limit', '0'], ['--repeat', 'Infinity'], ['--concurrency', '1.5'], ['--sample', 'ten'], ['--repeat', undefined]]) {
        expect(() => parseArgs(['node', 'x', '--run', 'f.json', flag, ...(value === undefined ? [] : [value])])).toThrow('exit 2');
        expect(error).toHaveBeenLastCalledWith(expect.stringContaining(`${flag} needs a positive whole number`));
      }
      expect(exit).toHaveBeenCalledTimes(6);
    } finally { exit.mockRestore(); error.mockRestore(); }
  });

  test('the export takes the prior summary on the route\'s GATE_LAWN_PROPERTY_HISTORY branch and records it in the fixture', () => {
    const src = fs.readFileSync(scriptPath, 'utf8');
    expect(src).toMatch(/const propertyHistoryEnabled = require\(path\.join\(REPO, 'server\/config\/feature-gates'\)\)\.gateEnvValue\('GATE_LAWN_PROPERTY_HISTORY'\);/);
    expect(src).toMatch(/loadPriorSummary\(\{ customerId: row\.customer_id, serviceId: row\.service_id, scheduledService, visitDate, propertyHistoryEnabled \}, knex\)/);
    expect(src).not.toMatch(/historyBeforeVisit\(/);
    expect(src).toMatch(/propertyHistory: propertyHistoryEnabled, population: all\.length, cases \}/);
    // The script is a module for tests and a program for operators.
    expect(src).toMatch(/if \(require\.main === module\) \{/);
  });
});

describe('runner', () => {
  const cases = [
    evalLib.fixtureCase(row({ id: 'a1' }), photos, {}),
    evalLib.fixtureCase(row({ id: 'a2', scheduled_date: '2026-07-01' }), [{ id: 'p9', s3_key: 'broken', photo_order: 0 }], {}),
    evalLib.fixtureCase(row({ id: 'a3' }), [], {}),
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
    expect(calls[0].photoZones).toEqual(['front', null]);
    expect(calls[0].visionContext).toMatchObject({ month: 8, season: 'peak', region: 'Southwest Florida' });
    expect(calls[0].thinkingLevel).toBe('LOW');
    expect(out.results.map((r) => [r.assessmentId, r.repeatIndex])).toEqual([['a1', 0], ['a1', 1]]);
    expect(out.results[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.skipped.sort((a, b) => a.assessmentId.localeCompare(b.assessmentId))).toEqual([{ assessmentId: 'a2', reason: 'photo read failed: NoSuchKey' }, { assessmentId: 'a3', reason: 'no stored photos' }]);
    expect(out.summary.runs).toBe(2);
  });
});
