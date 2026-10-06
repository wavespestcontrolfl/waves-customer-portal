// PROTOTYPE ONLY. The completion gate makes the Visit Summary's one model call and
// freezes it under its own key (GATE_LAWN_VISIT_SUMMARY_V2). Gate off = no read, no
// call, no extra key. Never a real model call: llm/call is mocked.

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
const { splitSentences } = require('../services/service-report/next-visit-claims');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');

const FACTS = {
  season: 'fall',
  programLine: null,
  applied: [{ name: 'LESCO 24-0-11', kind: 'fertilizer', method: 'granular' }],
  findings: [{ label: 'weed pressure', confidence: 'moderate' }],
  areas: [{ label: 'Weed Pressure', status: 'watch' }],
  watering: { state: 'water_in', inches: 0.5, hours: 24 },
  recentRain: false,
  watchNext: ['weeds'],
  knownProductNames: ['LESCO 24-0-11'],
};
const TEXT = 'Today we put down a fall feeding to support the lawn this season. '
  + 'The photo read showed some weed pressure, and we are keeping an eye on it. '
  + 'Results from a feeding like this show up gradually, and each visit builds on the last one. '
  + 'Please water the treated lawn in with 0.5 inches within 24 hours. '
  + 'At the next visit we will look at the weeds again.';
const answer = { summary: TEXT, sources: splitSentences(TEXT).map((sentence) => ({ sentence, from: ['applied'] })) };

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
  const modelAnswers = (json) => dispatchWithFallback.mockImplementation(async (_policy, _payload, options) => {
    const result = { ok: true, json };
    return options.validate(result) ? { ok: false, reason: 'all_providers_failed' } : result;
  });

  test('one call on its own lane, frozen under lawnVisitSummary[assessment], beside the synthesis; a retry spends no second call', async () => {
    modelAnswers(answer);
    const { knex, state } = fakeKnex({});
    const result = await run(knex);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallback.mock.calls[0][1].laneId).toBe('lawn_visit_summary');
    expect(state.notes.lawnVisitSummary['77']).toMatchObject({ v: 1, text: TEXT, assessmentId: '77' });
    expect(state.notes.lawnReportV2).not.toHaveProperty('visitSummary');
    expect(result.visitSummaryFreeze).toEqual({ 77: state.notes.lawnVisitSummary['77'] });
    await run(knex);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('a model miss and a rejected answer both complete with no summary (the report keeps the generic recap)', async () => {
    const { knex, state } = fakeKnex({});
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'all_providers_failed' });
    expect((await run(knex)).persisted).toBe(true);
    modelAnswers({ ...answer, summary: TEXT.replace('weed pressure', 'chinch bugs') });
    const result = await run(knex);
    expect(result.persisted).toBe(true);
    expect(result).not.toHaveProperty('visitSummaryFreeze');
    expect(state.notes.lawnVisitSummary).toBeUndefined();
  });

  test('a failed fact read completes with no summary and no model call', async () => {
    gatherVisitSummaryFacts.mockRejectedValue(new Error('catalog read failed'));
    const { knex, state } = fakeKnex({});
    expect((await run(knex)).persisted).toBe(true);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(state.notes.lawnVisitSummary).toBeUndefined();
  });
});
