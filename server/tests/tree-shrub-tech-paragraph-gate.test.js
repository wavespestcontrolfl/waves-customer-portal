// The completion step and the PDF key for the tree & shrub "From your technician"
// paragraph (GATE_TS_TECH_PARAGRAPH). Gate off = no read and no call. A miss of
// any kind stores nothing and returns null, never a throw. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(),
  ensureReportToken: jest.fn(),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/tree-shrub-assessment', () => ({ loadLinkedTreeShrubAssessment: jest.fn() }));
jest.mock('../services/service-report/tree-shrub-tech-paragraph-inputs', () => ({ gatherTreeShrubTechParagraphInputs: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const { loadServiceRecordForPdf, ensureReportToken } = require('../services/service-report/pdf-queue');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { loadLinkedTreeShrubAssessment } = require('../services/tree-shrub-assessment');
const { gatherTreeShrubTechParagraphInputs } = require('../services/service-report/tree-shrub-tech-paragraph-inputs');
const logger = require('../services/logger');
const featureGates = require('../config/feature-gates');
const tech = require('../services/service-report/tree-shrub-tech-paragraph');
const {
  freezeTreeShrubTechParagraph, treeShrubTechParagraphPdfSignature,
} = require('../services/service-report/tree-shrub-tech-paragraph-gate');

const GATES = ['GATE_TS_TECH_PARAGRAPH', 'GATE_TS_TECH_FINDINGS_COPY'];
const saved = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
const gatesOn = () => { GATES.forEach((g) => { process.env[g] = 'true'; }); };
afterEach(() => { GATES.forEach((g) => { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; }); });

const SLOTS = { observed: [{ condition: 'scale', plant: 'hedges' }], maybe: [], confirmed: [], products: ['Merit 2F'], allClear: null };
const TEXT = tech.render(SLOTS);
const ENTRY = { v: 1, assessmentId: '77', text: TEXT, slots: SLOTS };
const GOOD = { ok: true, paragraph: TEXT, slots: SLOTS, inputsHash: 'h1' };
const SERVICE = { id: 'sr-1', customer_id: 'c1', scheduled_service_id: 'ss-1', service_line: 'tree_shrub', service_type: 'Tree & Shrub Care' };
const INPUTS = { technicianNote: 'Found scale on the hedge.', products: [{ name: 'Merit 2F' }] };

// The freeze statement the way Postgres applies it.
function fakeKnex(initial = {}) {
  const state = { notes: JSON.parse(JSON.stringify(initial)), reads: 0, updates: 0 };
  const knex = () => {
    const q = { guardKey: null };
    q.where = () => q;
    q.whereRaw = (_sql, bindings) => { q.guardKey = bindings[0]; return q; };
    q.first = async () => { state.reads += 1; return { structured_notes: JSON.stringify(state.notes) }; };
    q.update = async ({ structured_notes: raw }) => {
      state.updates += 1;
      if ((state.notes.treeShrubTechParagraph || {})[q.guardKey]) return 0;
      state.notes.treeShrubTechParagraph = { ...(state.notes.treeShrubTechParagraph || {}), ...JSON.parse(raw.bindings[0]) };
      return 1;
    };
    return q;
  };
  knex.raw = (sql, bindings) => ({ sql, bindings });
  return { knex, state };
}

beforeEach(() => {
  [dispatchWithFallback, loadServiceRecordForPdf, ensureReportToken, buildReportV1Data, loadLinkedTreeShrubAssessment, gatherTreeShrubTechParagraphInputs, logger.info, logger.warn]
    .forEach((m) => m.mockReset());
  loadServiceRecordForPdf.mockResolvedValue({ ...SERVICE, technician_notes: 'Found scale on the hedge.' });
  ensureReportToken.mockResolvedValue('tok');
  buildReportV1Data.mockResolvedValue({ reportV2: {} });
  loadLinkedTreeShrubAssessment.mockResolvedValue({ id: 77 });
  gatherTreeShrubTechParagraphInputs.mockResolvedValue(INPUTS);
});

describe('the gate reader', () => {
  test('dark by default, strict opt-in, and it needs the tech-findings gate too', () => {
    GATES.forEach((g) => { delete process.env[g]; });
    expect(featureGates.tsTechParagraphLive()).toBe(false);
    process.env.GATE_TS_TECH_PARAGRAPH = 'true';
    expect(featureGates.tsTechParagraphLive()).toBe(false); // findings gate still off
    process.env.GATE_TS_TECH_FINDINGS_COPY = 'true';
    expect(featureGates.tsTechParagraphLive()).toBe(true);
    process.env.GATE_TS_TECH_PARAGRAPH = '1';
    expect(featureGates.tsTechParagraphLive()).toBe(false); // exactly 'true'
    delete process.env.GATE_TS_TECH_PARAGRAPH;
    expect(featureGates.tsTechParagraphLive()).toBe(false);
  });
});

describe('freezeTreeShrubTechParagraph', () => {
  test('gate off: no read, no build, no model call, nothing stored', async () => {
    GATES.forEach((g) => { delete process.env[g]; });
    const { knex, state } = fakeKnex();
    expect(await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex })).toBeNull();
    expect(state.reads + state.updates).toBe(0);
    expect(loadLinkedTreeShrubAssessment).not.toHaveBeenCalled();
    expect(buildReportV1Data).not.toHaveBeenCalled();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a lawn visit does nothing even with the gate on', async () => {
    gatesOn();
    const { knex } = fakeKnex();
    expect(await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: { ...SERVICE, service_line: 'lawn' }, knex })).toBeNull();
    expect(loadLinkedTreeShrubAssessment).not.toHaveBeenCalled();
  });

  test('no confirmed assessment: no paragraph, no model call', async () => {
    gatesOn();
    loadLinkedTreeShrubAssessment.mockResolvedValue(null);
    const { knex, state } = fakeKnex();
    expect(await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex })).toBeNull();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(state.updates).toBe(0);
  });

  test('freezes one validated paragraph under the assessment id and hands the entry back', async () => {
    gatesOn();
    const { knex, state } = fakeKnex({ other: 'kept' });
    const out = await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate: jest.fn(async () => GOOD), now: () => new Date('2026-10-05T12:00:00Z') } });
    expect(Object.keys(out)).toEqual(['77']);
    expect(out['77']).toMatchObject({ v: 1, promptVersion: 'ts_tech_paragraph_v3', assessmentId: '77', text: TEXT, slots: SLOTS });
    expect(state.notes.treeShrubTechParagraph['77'].text).toBe(TEXT);
    expect(state.notes.other).toBe('kept');
    // The report was built from the joined record and a token, then the inputs were gathered from it.
    // The completion's own token is used; none is minted here.
    expect(ensureReportToken).not.toHaveBeenCalled();
    expect(buildReportV1Data.mock.calls[0][1]).toBe('tok');
    expect(buildReportV1Data).toHaveBeenCalledTimes(1);
    // The input gather is side-effect free: the narrative lane is never dispatched from the build.
    expect(buildReportV1Data.mock.calls[0][3]).toEqual({ skipNarrativeGeneration: true });
    expect(gatherTreeShrubTechParagraphInputs).toHaveBeenCalledWith(expect.objectContaining({ data: { reportV2: {} }, knex }));
  });

  test('a retried completion finds the freeze and spends no second call', async () => {
    gatesOn();
    const { knex } = fakeKnex({ treeShrubTechParagraph: { 77: ENTRY } });
    const generate = jest.fn();
    expect(await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate } })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(buildReportV1Data).not.toHaveBeenCalled();
  });

  test('a rejected paragraph, a failed read, a failed build and a thrown error all store nothing and never throw', async () => {
    gatesOn();
    const { knex, state } = fakeKnex();
    const rejected = jest.fn(async () => ({ ok: false, reason: 'rejected', problems: ['palm_crown'] }));
    expect(await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate: rejected } })).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('rejected (palm_crown)'));
    gatherTreeShrubTechParagraphInputs.mockRejectedValueOnce(new Error('read failed'));
    expect(await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate: jest.fn() } })).toBeNull();
    buildReportV1Data.mockRejectedValueOnce(new Error('build failed'));
    gatherTreeShrubTechParagraphInputs.mockResolvedValueOnce(null);
    expect(await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate: jest.fn() } })).toBeNull();
    loadLinkedTreeShrubAssessment.mockRejectedValueOnce(new Error('db down'));
    expect(await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex })).toBeNull();
    expect(state.updates).toBe(0);
  });

  test('the model is called on lane ts_tech_paragraph when no generator is injected; a model miss freezes the deterministic lines only', async () => {
    gatesOn();
    gatherTreeShrubTechParagraphInputs.mockResolvedValue(tech.normalizeInputs({
      technicianNote: 'Found scale on the back hedge and treated the hedges with Merit.',
      products: [{ name: 'Merit 2F' }],
      landscapeCondition: 'Good',
    }));
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    const { knex, state } = fakeKnex();
    const out = await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallback.mock.calls[0][1]).toMatchObject({ laneId: 'ts_tech_paragraph' });
    // The note was not read, so: the products line only. No observed line, no all-clear.
    expect(out['77'].text).toBe('Today we applied Merit 2F.');
    expect(state.notes.treeShrubTechParagraph['77'].slots.allClear).toBeNull();
  });

  test('a visit with no note makes no model call and still freezes the deterministic lines', async () => {
    gatesOn();
    gatherTreeShrubTechParagraphInputs.mockResolvedValue(tech.normalizeInputs({ technicianNote: '', products: [{ name: 'Merit 2F' }], landscapeCondition: 'Excellent' }));
    const { knex } = fakeKnex();
    const out = await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(out['77'].text).toBe('Today we applied Merit 2F. Your landscape looked excellent today.');
  });
});

describe('the completion\'s report token', () => {
  test('no token: no paragraph, no build, no model call, and nothing minted', async () => {
    gatesOn();
    const { knex, state } = fakeKnex();
    const generate = jest.fn();
    for (const reportToken of [null, undefined, '']) {
      expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex, reportToken, deps: { generate } })).toBeNull();
    }
    expect(ensureReportToken).not.toHaveBeenCalled();
    expect(buildReportV1Data).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(state.updates).toBe(0);
  });
});

describe('completion wiring', () => {
  test('complete-scheduled-service passes its own report token (after the lawn gate may have recovered one)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const call = src.indexOf('await freezeTreeShrubTechParagraph({ service: record, knex: db, reportToken });');
    expect(call).toBeGreaterThan(src.indexOf('adoptRecoveredReportToken({ reportToken, gateToken: gate.reportToken, portalUrl })'));
  });
});

describe('a hung model call still freezes the deterministic lines inside the deadline', () => {
  afterEach(() => jest.useRealTimers());

  test('the model gets the deadline minus a 2 s reserve; the fallback build and freeze run in the reserve', async () => {
    gatesOn();
    jest.useFakeTimers();
    gatherTreeShrubTechParagraphInputs.mockResolvedValue(tech.normalizeInputs({ technicianNote: 'Found scale on the hedges.', products: [{ name: 'Merit 2F' }], landscapeCondition: 'Good' }));
    dispatchWithFallback.mockImplementation(() => new Promise(() => {}));
    const { knex, state } = fakeKnex();
    let out;
    freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex }).then((v) => { out = v; });
    await jest.advanceTimersByTimeAsync(12999);
    expect(out).toBeUndefined();
    expect(dispatchWithFallback.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(13000);
    await jest.advanceTimersByTimeAsync(2);
    // The model timer fired at 13 s; the deterministic lines froze before 15 s.
    await jest.advanceTimersByTimeAsync(10);
    expect(out && out['77'].text).toBe('Today we applied Merit 2F.');
    expect(state.notes.treeShrubTechParagraph['77'].slots.observed).toEqual([]);
    expect(state.notes.treeShrubTechParagraph['77'].slots.allClear).toBeNull();
  });
});
describe('one deadline for the whole step (the technician is waiting at Complete)', () => {
  afterEach(() => jest.useRealTimers());
  const settled = (promise) => { const state = { done: false, value: undefined }; promise.then((v) => { state.done = true; state.value = v; }); return state; };

  test('a stalled assessment lookup cannot hold the completion past 15 s, and nothing runs after it', async () => {
    gatesOn();
    jest.useFakeTimers();
    let release;
    loadLinkedTreeShrubAssessment.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { knex, state } = fakeKnex();
    const generate = jest.fn(async () => GOOD);
    const out = settled(freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate } }));
    await jest.advanceTimersByTimeAsync(14999);
    expect(out.done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(out.done).toBe(true);
    expect(out.value).toBeNull();
    // The lookup answering late starts nothing: no build, no model call, no write.
    release({ id: 77 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(generate).not.toHaveBeenCalled();
    expect(buildReportV1Data).not.toHaveBeenCalled();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(state.updates).toBe(0);
  });

  test('another assessment landing during the build: no paragraph, nothing generated (Codex r7)', async () => {
    gatesOn();
    loadLinkedTreeShrubAssessment.mockResolvedValueOnce({ id: 77 }).mockResolvedValueOnce({ id: 78 });
    const { knex } = fakeKnex();
    const generate = jest.fn(async () => GOOD);
    const out = await freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate } });
    expect(out).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(gatherTreeShrubTechParagraphInputs).not.toHaveBeenCalled();
  });

  test('a slow lookup shortens the engine\'s budget by what it spent', async () => {
    gatesOn();
    jest.useFakeTimers();
    loadLinkedTreeShrubAssessment.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ id: 77 }), 6000)));
    const { knex } = fakeKnex();
    const generate = jest.fn(async () => GOOD);
    const out = settled(freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate } }));
    await jest.advanceTimersByTimeAsync(6000);
    await jest.advanceTimersByTimeAsync(10);
    expect(out.done).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const budget = generate.mock.calls[0][1].budgetMs;
    // 15 s - 6 s spent on the lookup - the 2 s reserve for the fallback and the freeze.
    expect(budget).toBeLessThanOrEqual(7000);
    expect(budget).toBeGreaterThan(6000);
  });

  test('a lookup that leaves under a second runs nothing', async () => {
    gatesOn();
    jest.useFakeTimers();
    loadLinkedTreeShrubAssessment.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ id: 77 }), 14500)));
    const { knex } = fakeKnex();
    const generate = jest.fn(async () => GOOD);
    const out = settled(freezeTreeShrubTechParagraph({ reportToken: 'tok', service: SERVICE, knex, deps: { generate } }));
    await jest.advanceTimersByTimeAsync(14500);
    await jest.advanceTimersByTimeAsync(10);
    expect(out.done).toBe(true);
    expect(out.value).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('treeShrubTechParagraphPdfSignature', () => {
  const frozen = { treeShrubTechParagraph: { 77: ENTRY } };
  const withNotes = (notes) => ({ ...SERVICE, structured_notes: JSON.stringify(notes) });

  test('empty while the gate is off, for another service line, with no assessment and with no paragraph', async () => {
    const { knex, state } = fakeKnex(frozen);
    GATES.forEach((g) => { delete process.env[g]; });
    expect(await treeShrubTechParagraphPdfSignature(withNotes(frozen), knex)).toBe('');
    expect(state.reads).toBe(0);
    gatesOn();
    expect(await treeShrubTechParagraphPdfSignature({ ...withNotes(frozen), service_line: 'lawn' }, knex)).toBe('');
    loadLinkedTreeShrubAssessment.mockResolvedValueOnce(null);
    expect(await treeShrubTechParagraphPdfSignature(withNotes(frozen), knex)).toBe('');
    expect(await treeShrubTechParagraphPdfSignature(withNotes({}), knex)).toBe('');
  });

  test('follows the frozen text while the gate is on', async () => {
    gatesOn();
    const { knex } = fakeKnex();
    const a = await treeShrubTechParagraphPdfSignature(withNotes(frozen), knex);
    expect(a).toBe(tech.techParagraphSignature(frozen, 77));
    expect(a).toMatch(/^:tp=[0-9a-f]{8}$/);
    const slots = { ...SLOTS, products: ['Merit 2F', 'Palm Gro 8-2-12'] };
    const other = { treeShrubTechParagraph: { 77: { ...ENTRY, text: tech.render(slots), slots } } };
    expect(await treeShrubTechParagraphPdfSignature(withNotes(other), knex)).not.toBe(a);
  });

  test('RACE: the key follows the snapshot the render uses, not a fresh read of the row', async () => {
    gatesOn();
    // The caller loaded `service` before the paragraph froze; the row now holds it.
    const { knex, state } = fakeKnex(frozen);
    const staleSnapshot = withNotes({});
    expect(await treeShrubTechParagraphPdfSignature(staleSnapshot, knex)).toBe('');
    expect(state.reads).toBe(0);
    // And the reverse: the snapshot has it, the row (somehow) does not.
    const fresh = fakeKnex({});
    expect(await treeShrubTechParagraphPdfSignature(withNotes(frozen), fresh.knex)).toMatch(/^:tp=[0-9a-f]{8}$/);
  });

  test('a row loaded without structured_notes cannot be keyed: sentinel', async () => {
    gatesOn();
    expect(await treeShrubTechParagraphPdfSignature(SERVICE, fakeKnex().knex)).toMatch(/^:tp=err[0-9a-f]{8}$/);
  });

  test('a failed assessment lookup stamps a one-off sentinel, never the empty string (strict lookup)', async () => {
    gatesOn();
    loadLinkedTreeShrubAssessment.mockRejectedValue(new Error('db down'));
    const svc = withNotes(frozen);
    const a = await treeShrubTechParagraphPdfSignature(svc, fakeKnex().knex);
    const b = await treeShrubTechParagraphPdfSignature(svc, fakeKnex().knex);
    expect(a).toMatch(/^:tp=err[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(loadLinkedTreeShrubAssessment).toHaveBeenCalledWith(svc, expect.anything(), { strict: true });
  });
});
