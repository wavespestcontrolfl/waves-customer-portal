// PROTOTYPE ONLY. The completion gate composes the Visit Summary's fixed sentences with
// code (no model call) and freezes them under their own key (GATE_LAWN_VISIT_SUMMARY_V2).
// Gate off = no read, no extra key. llm/call is mocked to prove nothing calls a model.

jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(async (id) => ({ id, service_line: 'lawn', structured_notes: '{}', technician_notes: 'x' })),
  ensureReportToken: jest.fn(async () => 'c'.repeat(32)),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/service-report/report-consistency', () => ({ reconcileLawnReport: jest.fn(() => ({ warnings: [] })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/service-report/lawn-visit-summary-inputs', () => ({ gatherVisitSummaryFacts: jest.fn() }));

const { buildReportV1Data } = require('../services/service-report/report-data');
const { dispatchWithFallback } = require('../services/llm/call');
const { gatherVisitSummaryFacts } = require('../services/service-report/lawn-visit-summary-inputs');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');

const FACTS = {
  season: 'fall',
  applied: [{ kind: 'fertilizer', alsoFeeds: false }],
  findings: [{ label: 'weed pressure', confidence: 'moderate' }],
  areas: [{ key: 'weed_pressure', status: 'watch' }],
  watchNext: [],
  recurring: true,
  nextVisitBooked: true,
};
const TEXT = 'Today we applied a feeding, which fits the fall season. '
  + 'In the photos we noticed some weed pressure. '
  + 'Results from treatments like these build gradually, and each visit adds to the last one. '
  + 'At the next visit we will look at weeds.';

function fakeKnex(initialNotes = {}) {
  const state = { notes: JSON.parse(JSON.stringify(initialNotes)) };
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
      // The watering freeze is first writer wins (its UPDATE is guarded by IS NULL).
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
  delete process.env.GATE_LAWN_VISIT_SUMMARY_V2;
});
afterAll(() => { delete process.env.GATE_LAWN_VISIT_SUMMARY_V2; });

test('gate off: the report build is not asked for the plan identity (no extra read)', async () => {
  const { knex } = fakeKnex({});
  await run(knex);
  expect(buildReportV1Data.mock.calls[0][3]).toEqual({ wateringInstructionOut: expect.any(Object) });
});

test('gate off: no read, no model call, no extra key in the result or the record', async () => {
  const { knex, state } = fakeKnex({});
  const result = await run(knex);
  expect(result.persisted).toBe(true);
  expect(result).not.toHaveProperty('visitSummaryFreeze');
  expect(gatherVisitSummaryFacts).not.toHaveBeenCalled();
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(state.notes).not.toHaveProperty('lawnVisitSummary');
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true'; });

  test('composed by code, frozen under lawnVisitSummary[assessment] beside the synthesis; a retry changes nothing; no model call', async () => {
    const { knex, state } = fakeKnex({});
    const result = await run(knex);
    expect(state.notes.lawnVisitSummary['77']).toMatchObject({ v: 3, text: TEXT, assessmentId: '77' });
    expect(state.notes.lawnVisitSummary['77'].slots).toMatchObject({ season: 'fall', applied: ['fertilizer'] });
    expect(state.notes.lawnReportV2).not.toHaveProperty('visitSummary');
    expect(result.visitSummaryFreeze).toEqual({ 77: state.notes.lawnVisitSummary['77'] });
    await run(knex);
    expect(gatherVisitSummaryFacts).toHaveBeenCalledTimes(1); // the second run finds the freeze first
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the report\'s own recurring-plan answer reaches the facts; absent means not recurring', async () => {
    buildReportV1Data.mockImplementation(async (_record, _token, _knex, opts) => {
      opts.programVisitOut.programVisit = true;
      opts.programVisitOut.nextVisitBooked = true;
      return { lawnAssessment: { assessmentId: 77 }, reportV2: { smsSummary: 'sms', snapshot: {} } };
    });
    await run(fakeKnex({}).knex);
    expect(gatherVisitSummaryFacts.mock.calls[0][0]).toMatchObject({ programVisit: true, nextVisitBooked: true });
    gatherVisitSummaryFacts.mockClear();
    buildReportV1Data.mockImplementation(async () => ({ lawnAssessment: { assessmentId: 77 }, reportV2: { smsSummary: 'sms', snapshot: {} } }));
    await run(fakeKnex({}).knex);
    expect(gatherVisitSummaryFacts.mock.calls[0][0]).toMatchObject({ programVisit: false, nextVisitBooked: false });
  });

  test('nothing to ground completes with no summary', async () => {
    gatherVisitSummaryFacts.mockResolvedValue({ season: 'fall', applied: [], areas: [], findings: [] });
    const { knex, state } = fakeKnex({});
    const result = await run(knex);
    expect(result.persisted).toBe(true);
    expect(result).not.toHaveProperty('visitSummaryFreeze');
    expect(state.notes.lawnVisitSummary).toBeUndefined();
  });

  test('a failed fact read completes with no summary', async () => {
    gatherVisitSummaryFacts.mockRejectedValue(new Error('assessment read failed'));
    const { knex, state } = fakeKnex({});
    expect((await run(knex)).persisted).toBe(true);
    expect(state.notes.lawnVisitSummary).toBeUndefined();
  });

  test('a degraded product read writes no summary (the facts would be partial)', async () => {
    buildReportV1Data.mockImplementation(async (_record, _token, _knex, opts) => {
      opts.wateringInstructionOut.productsLoadFailed = true;
      return { lawnAssessment: { assessmentId: 77 }, reportV2: { smsSummary: 'sms', snapshot: {} } };
    });
    const { knex, state } = fakeKnex({});
    expect((await run(knex)).persisted).toBe(true);
    expect(gatherVisitSummaryFacts).not.toHaveBeenCalled();
    expect(state.notes.lawnVisitSummary).toBeUndefined();
  });
});
