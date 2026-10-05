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

const TEXT = 'Our technician found scale on the hedge along the back fence. Merit 2F went on the hedges, and Palm Gro 8-2-12 went on the palms.';
const GOOD = { ok: true, paragraph: TEXT, sources: [{ sentence: 'a', from: ['note'] }], inputsHash: 'h1' };
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
    expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex })).toBeNull();
    expect(state.reads + state.updates).toBe(0);
    expect(loadLinkedTreeShrubAssessment).not.toHaveBeenCalled();
    expect(buildReportV1Data).not.toHaveBeenCalled();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a lawn visit does nothing even with the gate on', async () => {
    gatesOn();
    const { knex } = fakeKnex();
    expect(await freezeTreeShrubTechParagraph({ service: { ...SERVICE, service_line: 'lawn' }, knex })).toBeNull();
    expect(loadLinkedTreeShrubAssessment).not.toHaveBeenCalled();
  });

  test('no confirmed assessment: no paragraph, no model call', async () => {
    gatesOn();
    loadLinkedTreeShrubAssessment.mockResolvedValue(null);
    const { knex, state } = fakeKnex();
    expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex })).toBeNull();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(state.updates).toBe(0);
  });

  test('freezes one validated paragraph under the assessment id and hands the entry back', async () => {
    gatesOn();
    const { knex, state } = fakeKnex({ other: 'kept' });
    const out = await freezeTreeShrubTechParagraph({ service: SERVICE, knex, deps: { generate: jest.fn(async () => GOOD), now: () => new Date('2026-10-05T12:00:00Z') } });
    expect(Object.keys(out)).toEqual(['77']);
    expect(out['77']).toMatchObject({ v: 1, promptVersion: 'ts_tech_paragraph_v1', assessmentId: '77', text: TEXT });
    expect(state.notes.treeShrubTechParagraph['77'].text).toBe(TEXT);
    expect(state.notes.other).toBe('kept');
    // The report was built from the joined record and a token, then the inputs were gathered from it.
    expect(ensureReportToken).toHaveBeenCalledWith('sr-1', knex);
    expect(buildReportV1Data).toHaveBeenCalledTimes(1);
    expect(gatherTreeShrubTechParagraphInputs).toHaveBeenCalledWith(expect.objectContaining({ data: { reportV2: {} }, knex }));
  });

  test('a retried completion finds the freeze and spends no second call', async () => {
    gatesOn();
    const { knex } = fakeKnex({ treeShrubTechParagraph: { 77: { v: 1, assessmentId: '77', text: TEXT } } });
    const generate = jest.fn();
    expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex, deps: { generate } })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(buildReportV1Data).not.toHaveBeenCalled();
  });

  test('a rejected paragraph, a failed read, a failed build and a thrown error all store nothing and never throw', async () => {
    gatesOn();
    const { knex, state } = fakeKnex();
    const rejected = jest.fn(async () => ({ ok: false, reason: 'rejected', problems: ['palm_crown'] }));
    expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex, deps: { generate: rejected } })).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('rejected (palm_crown)'));
    gatherTreeShrubTechParagraphInputs.mockRejectedValueOnce(new Error('read failed'));
    expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex, deps: { generate: jest.fn() } })).toBeNull();
    buildReportV1Data.mockRejectedValueOnce(new Error('build failed'));
    gatherTreeShrubTechParagraphInputs.mockResolvedValueOnce(null);
    expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex, deps: { generate: jest.fn() } })).toBeNull();
    loadLinkedTreeShrubAssessment.mockRejectedValueOnce(new Error('db down'));
    expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex })).toBeNull();
    expect(state.updates).toBe(0);
  });

  test('the model is called on lane ts_tech_paragraph when no generator is injected', async () => {
    gatesOn();
    gatherTreeShrubTechParagraphInputs.mockResolvedValue({
      technicianNote: 'Found scale on the back hedge and treated the hedges with Merit.',
      products: [{ name: 'Merit 2F', kind: 'systemic', targets: ['scale'] }],
      findings: [{ label: 'scale', confidence: 'high', source: 'seen' }],
    });
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    const { knex, state } = fakeKnex();
    expect(await freezeTreeShrubTechParagraph({ service: SERVICE, knex })).toBeNull();
    expect(dispatchWithFallback.mock.calls[0][1]).toMatchObject({ laneId: 'ts_tech_paragraph' });
    expect(state.updates).toBe(0);
  });
});

describe('treeShrubTechParagraphPdfSignature', () => {
  const frozen = { treeShrubTechParagraph: { 77: { v: 1, assessmentId: '77', text: TEXT } } };

  test('empty while the gate is off, for another service line, with no assessment and with no paragraph', async () => {
    const { knex, state } = fakeKnex(frozen);
    GATES.forEach((g) => { delete process.env[g]; });
    expect(await treeShrubTechParagraphPdfSignature(SERVICE, knex)).toBe('');
    expect(state.reads).toBe(0);
    gatesOn();
    expect(await treeShrubTechParagraphPdfSignature({ ...SERVICE, service_line: 'lawn' }, knex)).toBe('');
    loadLinkedTreeShrubAssessment.mockResolvedValueOnce(null);
    expect(await treeShrubTechParagraphPdfSignature(SERVICE, knex)).toBe('');
    expect(await treeShrubTechParagraphPdfSignature(SERVICE, fakeKnex({}).knex)).toBe('');
  });

  test('follows the frozen text while the gate is on', async () => {
    gatesOn();
    const a = await treeShrubTechParagraphPdfSignature(SERVICE, fakeKnex(frozen).knex);
    expect(a).toBe(tech.techParagraphSignature(frozen, 77));
    expect(a).toMatch(/^:tp=[0-9a-f]{8}$/);
    const other = { treeShrubTechParagraph: { 77: { v: 1, assessmentId: '77', text: `${TEXT} We also fed the palms.` } } };
    expect(await treeShrubTechParagraphPdfSignature(SERVICE, fakeKnex(other).knex)).not.toBe(a);
  });

  test('an unreadable record stamps a one-off key, never a stale hit', async () => {
    gatesOn();
    loadLinkedTreeShrubAssessment.mockRejectedValue(new Error('db down'));
    const a = await treeShrubTechParagraphPdfSignature(SERVICE, fakeKnex().knex);
    const b = await treeShrubTechParagraphPdfSignature(SERVICE, fakeKnex().knex);
    expect(a).toMatch(/^:tp=err[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});
