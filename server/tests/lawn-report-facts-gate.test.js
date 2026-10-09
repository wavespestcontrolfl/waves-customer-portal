// GATE_LAWN_REPORT_FACTS at the lawn write gate: the facts are frozen BEFORE the first report build (so the v6
// copy's first freeze already reads them), the Visit Summary freezes version 4 with the ties, the result hands the
// freeze back to the completion path, and gate off is today's behavior exactly. Synthetic data only.

jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(async (id) => ({ id, service_line: 'lawn', structured_notes: '{"existing":"kept"}', technician_notes: 'x' })),
  ensureReportToken: jest.fn(async () => 'c'.repeat(32)),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/service-report/report-consistency', () => ({ reconcileLawnReport: jest.fn(() => ({ warnings: [] })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/service-report/lawn-visit-summary-inputs', () => ({ gatherVisitSummaryFacts: jest.fn() }));
jest.mock('../services/service-report/lawn-report-facts', () => ({
  ...jest.requireActual('../services/service-report/lawn-report-facts'),
  gatherAndFreezeReportFacts: jest.fn(),
}));

const { buildReportV1Data } = require('../services/service-report/report-data');
const { gatherVisitSummaryFacts } = require('../services/service-report/lawn-visit-summary-inputs');
const reportFacts = require('../services/service-report/lawn-report-facts');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');

const KEYS = ['GATE_LAWN_REPORT_FACTS', 'GATE_LAWN_VISIT_SUMMARY_V2'];
const TIE = { source: 'photo', kind: 'fungus', label: 'gray leaf spot', sure: true, product: 'fungicide' };
const BLOCK = {
  v: 1,
  frozenAt: '2026-10-08T20:00:00.000Z',
  reentry: { rule: 'dry', source: 'facts', products: [{ id: 'a', rule: 'dry', source: 'facts' }] },
  productUse: {},
  ties: { assessmentId: '77', items: [TIE] },
};
const FACTS = { season: 'fall', applied: [{ name: 'x', kind: 'fungicide' }], findings: [], areas: [], watchNext: [], recurring: false, nextVisitBooked: false };

function fakeKnex() {
  const state = { notes: {} };
  const knex = () => {
    const q = { guardKey: null };
    q.where = () => q;
    q.whereRaw = (_sql, bindings) => { q.guardKey = Array.isArray(bindings) ? bindings[0] : null; return q; };
    q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
    q.update = async ({ structured_notes: raw }) => {
      const patch = JSON.parse(raw.bindings[0]);
      if (raw.sql.includes("'lawnVisitSummary'")) {
        if ((state.notes.lawnVisitSummary || {})[q.guardKey]) return 0;
        state.notes.lawnVisitSummary = { ...(state.notes.lawnVisitSummary || {}), ...patch };
        return 1;
      }
      if (patch.lawnWateringFreeze && state.notes.lawnWateringFreeze) return 0;
      Object.assign(state.notes, patch);
      return 1;
    };
    return q;
  };
  knex.raw = (sql, bindings) => ({ sql, bindings });
  return { knex, state };
}

const run = (knex) => finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });

beforeEach(() => {
  jest.clearAllMocks();
  buildReportV1Data.mockReset();
  buildReportV1Data.mockImplementation(async () => ({
    lawnAssessment: { assessmentId: 77 },
    reportV2: { smsSummary: 'sms', snapshot: { statusHeadline: 'Looking great' } },
  }));
  gatherVisitSummaryFacts.mockResolvedValue(FACTS);
  reportFacts.gatherAndFreezeReportFacts.mockResolvedValue(BLOCK);
  for (const key of KEYS) delete process.env[key];
});
afterAll(() => { for (const key of KEYS) delete process.env[key]; });

describe('gate off: today\'s behavior exactly', () => {
  test('nothing is read or written for the facts, and the result carries no extra key', async () => {
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    const { knex, state } = fakeKnex();
    const out = await run(knex);
    expect(reportFacts.gatherAndFreezeReportFacts).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('reportFactsFreeze');
    expect(Object.keys(state.notes).sort()).toEqual(['lawnReportV2', 'lawnVisitSummary']);
    expect(buildReportV1Data.mock.calls[0][0].structured_notes).toBe('{"existing":"kept"}');
  });

  test('the Visit Summary is the v3 entry and gets no ties', async () => {
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    const { knex, state } = fakeKnex();
    await run(knex);
    expect(state.notes.lawnVisitSummary['77'].v).toBe(3);
    expect(gatherVisitSummaryFacts.mock.calls[0][0].ties).toEqual([]);
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_LAWN_REPORT_FACTS = 'true'; });

  test('the facts are frozen BEFORE the first report build, and that build reads them from the record', async () => {
    const order = [];
    reportFacts.gatherAndFreezeReportFacts.mockImplementation(async () => { order.push('freeze'); return BLOCK; });
    buildReportV1Data.mockImplementation(async () => { order.push('build'); return { lawnAssessment: { assessmentId: 77 }, reportV2: { smsSummary: 's', snapshot: {} } }; });
    const { knex } = fakeKnex();
    await run(knex);
    expect(order).toEqual(['freeze', 'build']);
    const built = buildReportV1Data.mock.calls[0][0];
    expect(built.structured_notes).toEqual({ existing: 'kept', lawnReportFacts: BLOCK });
  });

  test('the result hands the freeze to the completion path (it folds it into its in-memory notes)', async () => {
    const { knex } = fakeKnex();
    const out = await run(knex);
    expect(out.reportFactsFreeze).toEqual(BLOCK);
    expect(out.persisted).toBe(true);
  });

  test('the Visit Summary freezes version 4 with the ties frozen at completion, for its own assessment', async () => {
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    const { knex, state } = fakeKnex();
    await run(knex);
    expect(gatherVisitSummaryFacts.mock.calls[0][0].ties).toEqual([TIE]);
    expect(state.notes.lawnVisitSummary['77'].v).toBe(4);
  });

  test('ties frozen for another assessment are not used', async () => {
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    reportFacts.gatherAndFreezeReportFacts.mockResolvedValue({ ...BLOCK, ties: { assessmentId: '99', items: [TIE] } });
    const { knex } = fakeKnex();
    await run(knex);
    expect(gatherVisitSummaryFacts.mock.calls[0][0].ties).toEqual([]);
  });

  test('a failed freeze (null) changes nothing: the build runs, the report renders as before', async () => {
    reportFacts.gatherAndFreezeReportFacts.mockResolvedValue(null);
    const { knex } = fakeKnex();
    const out = await run(knex);
    expect(out).not.toHaveProperty('reportFactsFreeze');
    expect(out.persisted).toBe(true);
    expect(buildReportV1Data.mock.calls[0][0].structured_notes).toBe('{"existing":"kept"}');
  });

  test('a build with no report still hands back what was frozen (the completion path must not lose the key)', async () => {
    buildReportV1Data.mockResolvedValue({ lawnAssessment: null, reportV2: null });
    const { knex } = fakeKnex();
    const out = await run(knex);
    expect(out.persisted).toBe(false);
    expect(out.reportFactsFreeze).toEqual(BLOCK);
  });

  test('a build that throws still hands back what was frozen', async () => {
    buildReportV1Data.mockRejectedValue(new Error('boom'));
    const { knex } = fakeKnex();
    const out = await run(knex);
    expect(out.reportFactsFreeze).toEqual(BLOCK);
  });

  test('only a lawn visit is read', async () => {
    const { knex } = fakeKnex();
    await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'pest' }, knex });
    expect(reportFacts.gatherAndFreezeReportFacts).not.toHaveBeenCalled();
  });
});

describe('the completion path folds the freeze back in', () => {
  test('complete-scheduled-service.js keeps lawnReportFacts in its in-memory notes, beside the other gate freezes', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    expect(source).toContain('if (gate.reportFactsFreeze) recordStructuredNotes.lawnReportFacts = gate.reportFactsFreeze;');
  });

  test('the report build hands the frozen tied families to the v6 copy (so its first freeze is curative where a tie exists)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'report-data.js'), 'utf8');
    expect(source).toContain('tiedFamilies: reportFacts.frozenTiedFamilies(service.structured_notes)');
  });
});
