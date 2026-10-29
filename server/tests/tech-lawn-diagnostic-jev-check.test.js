/**
 * GATE_LAWN_JEV_TIMING_CHECK on the tech lawn diagnostic persist (POST /): only a
 * summary restored from the verified MODEL run record is checked; a technician's
 * typed aiSummary is never asked about or changed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const inserts = [];
let mockRun = null;
function builder(table) {
  const b = {
    where: () => b,
    first: async () => (table === 'lawn_diagnostic_runs' ? mockRun : null),
    insert: (row) => {
      if (table === 'lawn_diagnostics') inserts.push(row);
      return { returning: async () => [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: row.mode, status: row.status }] };
    },
  };
  return b;
}
const mockDb = jest.fn((table) => builder(table));
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'tech-1', role: 'technician' }; req.technicianId = 'tech-1'; req.techRole = 'technician'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
let mockJevMode = 'off';
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false, lawnJevTimingCheckMode: () => mockJevMode }));
const mockAsk = jest.fn();
jest.mock('../services/typed-decisions/jev', () => ({ askPackage: (...a) => mockAsk(...a) }));
const mockRecord = jest.fn(async () => ({ recorded: 1 }));
jest.mock('../services/typed-decisions/shadow-recorder', () => ({ recordDecisions: (...a) => mockRecord(...a) }));

const express = require('express');
const router = require('../routes/tech-lawn-diagnostic');
const { buildDiagnosticReportContract } = require('../services/lawn-diagnostic-report');

const RUN_ID = '99999999-9999-4999-8999-999999999999';
const S1 = 'Your lawn shows thinning along the sunny edge near the driveway.';
const S2 = 'By mid-November the color should be much better.';
const S3 = 'We will keep watching the area on each visit.';
const MODEL_SUMMARY = `${S1} ${S2} ${S3}`;
const FINDINGS = [{ finding_id: 'F1', name: 'Thin turf density', confidence: 'moderate', severity: 'moderate', urgency: 'follow_up', observed_evidence: ['edge thinning'], negative_evidence: [], confirmation_step: 'check shade' }];
const PHOTOS = [{ photo_id: 'p1', quality: 'adequate' }];

function withRun() {
  const contract = buildDiagnosticReportContract({ photos: PHOTOS, findings: FINDINGS, products: [], compliance: {}, seasonal_context: '' });
  mockRun = {
    id: RUN_ID, challenge_status: 'passed', perception_mode: 'multimodal_challenged', customer_summary: MODEL_SUMMARY,
    summary_inputs_hash: router._test.hashSummaryInputs(contract), created_by_technician_id: 'tech-1', writer_model: 'writer-sentinel',
  };
}
async function persist(extra = {}) {
  const app = express();
  app.use(express.json());
  app.use('/tech/lawn-diagnostic', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/tech/lawn-diagnostic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photos: PHOTOS, findings: FINDINGS, diagnosisRunId: RUN_ID, ...extra }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const jev = (flagged = []) => async (packageId, state) => ({
  ok: true, answers: { states_result_timing: { p: flagged.includes(state.sentence) ? 0.97 : 0.02, yes: flagged.includes(state.sentence), confident: true } },
  servedModel: 'jev-1.13.0', packageId, packageHash: 'h'.repeat(64), provider: 'typesafe',
});
const summaryIn = (row) => JSON.parse(row.report_contract).customer_summary;
const settle = async (fn) => { for (let i = 0; i < 40 && !fn(); i += 1) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  inserts.length = 0; mockRun = null; mockJevMode = 'off'; mockAsk.mockReset(); mockRecord.mockClear();
});

test('the run fixture is accepted (the model summary is restored and stored)', async () => {
  withRun();
  const { status } = await persist();
  expect(status).toBe(201);
  expect(summaryIn(inserts[0])).toBe(MODEL_SUMMARY);
  expect(inserts[0].ai_summary).toBe(MODEL_SUMMARY);
  expect(mockAsk).not.toHaveBeenCalled();
});

test('shadow: stored unchanged, same response, verdict recorded after the insert', async () => {
  withRun();
  const off = await persist();
  const offRow = inserts[0];
  inserts.length = 0;
  mockJevMode = 'shadow';
  mockAsk.mockImplementation(jev([S2]));
  const { status, body } = await persist();
  expect(status).toBe(201);
  expect(body).toEqual(off.body);
  expect(inserts[0].report_contract).toBe(offRow.report_contract);
  expect(inserts[0].ai_summary).toBe(offRow.ai_summary);
  await settle(() => mockRecord.mock.calls.length);
  expect(mockRecord.mock.calls[0][0]).toMatchObject({ subjectType: 'lawn_diagnostics', subjectId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
});

test('enforce: the flagged sentence is dropped from report_contract and from the ai_summary copy of it', async () => {
  withRun();
  mockJevMode = 'enforce';
  mockAsk.mockImplementation(jev([S2]));
  const { status } = await persist();
  expect(status).toBe(201);
  expect(summaryIn(inserts[0])).toBe(`${S1} ${S3}`);
  expect(inserts[0].ai_summary).toBe(`${S1} ${S3}`);
});

test('enforce: a failed Jev call keeps the text', async () => {
  withRun();
  mockJevMode = 'enforce';
  mockAsk.mockImplementation(async () => ({ ok: false, reason: 'error' }));
  await persist();
  expect(summaryIn(inserts[0])).toBe(MODEL_SUMMARY);
  expect(inserts[0].ai_summary).toBe(MODEL_SUMMARY);
});

test('enforce: a technician-typed aiSummary is stored exactly as typed and never asked about', async () => {
  withRun();
  mockJevMode = 'enforce';
  mockAsk.mockImplementation(jev([S2]));
  const typed = 'Typed by the tech: it should green up in two weeks.';
  await persist({ aiSummary: typed });
  expect(inserts[0].ai_summary).toBe(typed);
  // the model's own contract summary is still checked
  expect(summaryIn(inserts[0])).toBe(`${S1} ${S3}`);
  expect(mockAsk.mock.calls.map((c) => c[1].sentence)).not.toContain(typed);
});

test('enforce: with no verified model run the deterministic summary stands and nothing is asked', async () => {
  mockJevMode = 'enforce';
  mockAsk.mockImplementation(jev([S2]));
  const { status } = await persist({ diagnosisRunId: undefined });
  expect(status).toBe(201);
  expect(mockAsk).not.toHaveBeenCalled();
});
