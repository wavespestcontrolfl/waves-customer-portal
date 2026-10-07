// The completion gate makes the tech paragraph's one model call and freezes it
// under its own key (GATE_LAWN_TECH_PARAGRAPH). Gate off = no read, no call, and
// a result with no extra key. Never a real model call: llm/call is mocked.

jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(async (id) => ({ id, service_line: 'lawn', structured_notes: '{}', first_name: 'Sam', technician_notes: 'x' })),
  ensureReportToken: jest.fn(async () => 'c'.repeat(32)),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/service-report/report-consistency', () => ({ reconcileLawnReport: jest.fn(() => ({ warnings: [] })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/service-report/lawn-tech-paragraph-inputs', () => ({ gatherTechParagraphInputs: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { dispatchWithFallback } = require('../services/llm/call');
const { gatherTechParagraphInputs } = require('../services/service-report/lawn-tech-paragraph-inputs');
const logger = require('../services/logger');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/fixtures/lawn-tech-paragraph/chinch-bug-arena.json'), 'utf8'));
// Fixed sentences (owner 2026-10-06): the model only extracts; code writes every word.
const TEXT = 'Our technician saw chinch bugs. Today we applied Arena 50 WDG and LESCO 24-0-11.';
const PRODUCTS_ONLY = 'Today we applied Arena 50 WDG and LESCO 24-0-11.';
const CHINCH = [{ condition: 'chinch_bugs', place: 'none', quote: 'There are chinch bugs', seenToday: true }];

// Applies the lawnReportV2 merge and the first-writer-wins tech freeze the way Postgres does.
function fakeKnex(initialNotes = {}) {
  const state = { notes: JSON.parse(JSON.stringify(initialNotes)), freezes: 0 };
  const knex = () => {
    const q = { guardKey: null };
    q.where = () => q;
    q.whereRaw = (sql, bindings) => { q.guardKey = Array.isArray(bindings) ? bindings[0] : null; return q; };
    q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
    q.update = async ({ structured_notes: raw }) => {
      const patch = JSON.parse(raw.bindings[0]);
      if (raw.sql.includes("'lawnTechParagraph'")) {
        state.freezes += 1;
        if ((state.notes.lawnTechParagraph || {})[q.guardKey]) return 0;
        state.notes.lawnTechParagraph = { ...(state.notes.lawnTechParagraph || {}), ...patch };
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

const report = () => buildReportV1Data.mockImplementation(async () => ({
  lawnAssessment: { assessmentId: 77 },
  reportV2: { smsSummary: 'sms', snapshot: { statusHeadline: 'Looking great' } },
}));
const run = (knex) => finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });
const modelAnswers = (observations) => dispatchWithFallback.mockImplementation(async (_policy, _payload, options) => {
  const result = { ok: true, json: { observations } };
  return options.validate(result) ? { ok: false, reason: 'all_providers_failed' } : result;
});

beforeEach(() => {
  jest.clearAllMocks();
  buildReportV1Data.mockReset();
  report();
  gatherTechParagraphInputs.mockResolvedValue(FIXTURE);
  delete process.env.GATE_LAWN_TECH_PARAGRAPH;
  delete process.env.GATE_LAWN_REPORT_LEAD;
});
afterAll(() => { delete process.env.GATE_LAWN_TECH_PARAGRAPH; delete process.env.GATE_LAWN_REPORT_LEAD; });

test('gate off: no read, no model call, no extra key in the result or the record', async () => {
  const { knex, state } = fakeKnex({});
  const result = await run(knex);
  expect(result.persisted).toBe(true);
  expect(result).not.toHaveProperty('techParagraphFreeze');
  expect(gatherTechParagraphInputs).not.toHaveBeenCalled();
  expect(dispatchWithFallback).not.toHaveBeenCalled();
  expect(state.notes).not.toHaveProperty('lawnTechParagraph');
});

test('the paragraph gate needs the lead gate too: tech gate alone does nothing', async () => {
  process.env.GATE_LAWN_TECH_PARAGRAPH = 'true';
  const { knex } = fakeKnex({});
  await run(knex);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_LAWN_TECH_PARAGRAPH = 'true'; process.env.GATE_LAWN_REPORT_LEAD = 'true'; });

  test('one call, frozen under lawnTechParagraph[assessment], beside (never inside) lawnReportV2', async () => {
    modelAnswers(CHINCH);
    const { knex, state } = fakeKnex({});
    const result = await run(knex);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallback.mock.calls[0][1].laneId).toBe('lawn_tech_paragraph');
    expect(state.notes.lawnTechParagraph['77']).toMatchObject({ v: 2, text: TEXT, assessmentId: '77' });
    expect(state.notes.lawnTechParagraph['77'].slots.observed).toEqual([{ condition: 'chinch_bugs', place: 'none' }]);
    expect(state.notes.lawnReportV2).not.toHaveProperty('techParagraph');
    expect(result.techParagraphFreeze).toEqual({ 77: state.notes.lawnTechParagraph['77'] });
  });

  test('a retried completion finds the freeze and spends no second call', async () => {
    modelAnswers(CHINCH);
    const { knex } = fakeKnex({});
    await run(knex);
    await run(knex);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('a model miss or a malformed answer completes with the deterministic lines only', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'all_providers_failed' });
    const first = fakeKnex({});
    expect((await run(first.knex)).persisted).toBe(true);
    expect(first.state.notes.lawnTechParagraph['77'].text).toBe(PRODUCTS_ONLY);
    modelAnswers([{ condition: 'take_all', place: 'none', quote: 'take-all', seenToday: true }]);
    const second = fakeKnex({});
    await run(second.knex);
    expect(second.state.notes.lawnTechParagraph['77'].text).toBe(PRODUCTS_ONLY);
  });

  test('a failed read completes with no paragraph and no freeze', async () => {
    gatherTechParagraphInputs.mockRejectedValueOnce(new Error('read failed'));
    const { knex, state } = fakeKnex({});
    const result = await run(knex);
    expect(result.persisted).toBe(true);
    expect(result).not.toHaveProperty('techParagraphFreeze');
    expect(state.notes).not.toHaveProperty('lawnTechParagraph');
    expect(logger.info.mock.calls.flat().join(' ')).toMatch(/none for service_record s1/);
  });

  test('a degraded build (no inputs) makes no call', async () => {
    gatherTechParagraphInputs.mockResolvedValueOnce(null);
    const { knex } = fakeKnex({});
    await run(knex);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a throw anywhere in the step never fails the synthesis', async () => {
    gatherTechParagraphInputs.mockImplementation(() => { throw new Error('sync boom'); });
    const { knex } = fakeKnex({});
    expect((await run(knex)).persisted).toBe(true);
  });
});
