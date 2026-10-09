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

const KEYS = ['GATE_LAWN_REPORT_FACTS', 'GATE_LAWN_VISIT_SUMMARY_V2', 'GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD'];
const tiesPrerequisites = () => { process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true'; process.env.GATE_LAWN_REPORT_COPY_V6 = 'true'; process.env.GATE_LAWN_REPORT_LEAD = 'true'; };
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

  test('the Visit Summary freezes version 4 with the ties frozen at completion, for its own assessment (all prerequisite gates live)', async () => {
    tiesPrerequisites();
    const { knex, state } = fakeKnex();
    await run(knex);
    expect(reportFacts.gatherAndFreezeReportFacts.mock.calls[0][0].withTies).toBe(true);
    expect(gatherVisitSummaryFacts.mock.calls[0][0].ties).toEqual([TIE]);
    expect(state.notes.lawnVisitSummary['77'].v).toBe(4);
  });

  describe('the tie part needs the Visit Summary AND the v6 copy gates (lawnReportTiesLive)', () => {
    test.each([
      ['the Visit Summary dark', { GATE_LAWN_REPORT_COPY_V6: 'true', GATE_LAWN_REPORT_LEAD: 'true' }],
      ['the v6 copy dark', { GATE_LAWN_VISIT_SUMMARY_V2: 'true' }],
      ['the lead dark (the v6 copy needs it)', { GATE_LAWN_VISIT_SUMMARY_V2: 'true', GATE_LAWN_REPORT_COPY_V6: 'true' }],
      ['both dark', {}],
    ])('%s: no tie is read, the summary stays v3 where it is written, and the re-entry freeze still runs', async (_label, env) => {
      Object.assign(process.env, env);
      // The real freeze stores no tie block while the tie part is not live.
      reportFacts.gatherAndFreezeReportFacts.mockImplementation(async ({ withTies }) => (withTies ? BLOCK : (({ ties, ...rest }) => rest)(BLOCK)));
      const { knex, state } = fakeKnex();
      const out = await run(knex);
      expect(reportFacts.gatherAndFreezeReportFacts.mock.calls[0][0].withTies).toBe(false);
      expect(out.reportFactsFreeze).toMatchObject({ v: 1, reentry: BLOCK.reentry });
      expect(out.reportFactsFreeze).not.toHaveProperty('ties');
      if (state.notes.lawnVisitSummary) {
        expect(gatherVisitSummaryFacts.mock.calls[0][0].ties).toEqual([]);
        expect(state.notes.lawnVisitSummary['77'].v).toBe(3);
      }
    });

    test('the helper is the one place the dependency lives', () => {
      const gates = require('../config/feature-gates');
      const set = (env) => { for (const key of KEYS) delete process.env[key]; Object.assign(process.env, env); };
      set({}); expect(gates.lawnReportTiesLive()).toBe(false);
      set({ GATE_LAWN_REPORT_FACTS: 'true' }); expect(gates.lawnReportTiesLive()).toBe(false);
      set({ GATE_LAWN_REPORT_FACTS: 'true', GATE_LAWN_VISIT_SUMMARY_V2: 'true' }); expect(gates.lawnReportTiesLive()).toBe(false);
      set({ GATE_LAWN_REPORT_FACTS: 'true', GATE_LAWN_REPORT_COPY_V6: 'true', GATE_LAWN_REPORT_LEAD: 'true' }); expect(gates.lawnReportTiesLive()).toBe(false);
      set({ GATE_LAWN_REPORT_FACTS: 'true', GATE_LAWN_VISIT_SUMMARY_V2: 'true', GATE_LAWN_REPORT_COPY_V6: 'true', GATE_LAWN_REPORT_LEAD: 'true' }); expect(gates.lawnReportTiesLive()).toBe(true);
      set({ GATE_LAWN_VISIT_SUMMARY_V2: 'true', GATE_LAWN_REPORT_COPY_V6: 'true', GATE_LAWN_REPORT_LEAD: 'true' }); expect(gates.lawnReportTiesLive()).toBe(false);
    });
  });

  test('ties frozen for another assessment are not used', async () => {
    tiesPrerequisites();
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

describe('a completion that resumes after the gates changed honors the ties its record already froze', () => {
  const { loadServiceRecordForPdf } = require('../services/service-report/pdf-queue');
  const frozenRecord = (block) => ({ id: 's1', service_line: 'lawn', structured_notes: JSON.stringify({ lawnReportFacts: block }), technician_notes: 'x' });

  test('the facts gate turned off after the freeze: the summary is still v4 with the frozen ties (the live gate only guards NEW facts)', async () => {
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    loadServiceRecordForPdf.mockResolvedValueOnce(frozenRecord(BLOCK));
    const { knex, state } = fakeKnex();
    await run(knex);
    expect(reportFacts.gatherAndFreezeReportFacts).not.toHaveBeenCalled();
    expect(gatherVisitSummaryFacts.mock.calls[0][0].ties).toEqual([TIE]);
    expect(state.notes.lawnVisitSummary['77'].v).toBe(4);
  });

  test('the v6 or lead gate turned off after the freeze: same', async () => {
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    process.env.GATE_LAWN_REPORT_FACTS = 'true';
    loadServiceRecordForPdf.mockResolvedValueOnce(frozenRecord(BLOCK));
    const { knex, state } = fakeKnex();
    await run(knex);
    expect(state.notes.lawnVisitSummary['77'].v).toBe(4);
  });

  test('a record frozen without a tie block (the tie part was never live) still gets the v3 entry', async () => {
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    const { ties: _ties, ...noTies } = BLOCK;
    loadServiceRecordForPdf.mockResolvedValueOnce(frozenRecord(noTies));
    const { knex, state } = fakeKnex();
    await run(knex);
    expect(state.notes.lawnVisitSummary['77'].v).toBe(3);
    expect(gatherVisitSummaryFacts.mock.calls[0][0].ties).toEqual([]);
  });

  test('ties frozen for another assessment do not select v4', async () => {
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    loadServiceRecordForPdf.mockResolvedValueOnce(frozenRecord({ ...BLOCK, ties: { assessmentId: '99', items: [TIE] } }));
    const { knex, state } = fakeKnex();
    await run(knex);
    expect(state.notes.lawnVisitSummary['77'].v).toBe(3);
  });
});

describe('the facts are frozen BEFORE anything can render or queue a render for the record', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
  const at = (needle) => source.indexOf(needle);

  test('freezeReportFactsOnly: the facts block and nothing else (no token, no build, no synthesis side effect)', async () => {
    process.env.GATE_LAWN_REPORT_FACTS = 'true';
    const gate = require('../services/service-report/lawn-report-write-gate');
    const { ensureReportToken } = require('../services/service-report/pdf-queue');
    const { knex, state } = fakeKnex();
    const block = await gate.freezeReportFactsOnly({ service: { id: 's1', service_line: 'lawn' }, knex });
    expect(block).toEqual(BLOCK);
    expect(reportFacts.gatherAndFreezeReportFacts).toHaveBeenCalledTimes(1);
    expect(ensureReportToken).not.toHaveBeenCalled();
    expect(buildReportV1Data).not.toHaveBeenCalled();
    expect(state.notes).toEqual({});
  });

  test('freezeReportFactsOnly does nothing off the lawn line or with the gate off', async () => {
    const gate = require('../services/service-report/lawn-report-write-gate');
    const { knex } = fakeKnex();
    expect(await gate.freezeReportFactsOnly({ service: { id: 's1', service_line: 'lawn' }, knex })).toBeNull();
    process.env.GATE_LAWN_REPORT_FACTS = 'true';
    expect(await gate.freezeReportFactsOnly({ service: { id: 's1', service_line: 'pest' }, knex })).toBeNull();
    expect(reportFacts.gatherAndFreezeReportFacts).not.toHaveBeenCalled();
  });

  test('the completion path freezes them before the report token is minted and before the PDF render is queued', () => {
    const freeze = at('.freezeReportFactsOnly({ service: record');
    const mint = at('reportToken = await ensureReportToken(record.id)');
    const enqueue = at('await enqueuePdfRenderJob({');
    const synthesis = at('finalizeLawnReportSynthesis({ service: record');
    expect(freeze).toBeGreaterThan(0);
    expect(mint).toBeGreaterThan(freeze);
    expect(enqueue).toBeGreaterThan(freeze);
    // The later synthesis call stays (it is a no-op for the facts once they are frozen).
    expect(synthesis).toBeGreaterThan(enqueue);
  });

  test('nothing else in the completion file mints a token or queues a render ahead of the freeze', () => {
    const freeze = at('.freezeReportFactsOnly({ service: record');
    const before = source.slice(0, freeze);
    expect(before).not.toMatch(/await enqueuePdfRenderJob\(/);
    expect(before).not.toMatch(/await ensureReportToken\(/);
    expect(before).not.toMatch(/buildReportV1Data\(/);
  });

  test('the freeze runs under the same conditions as the synthesis gate (auto-send, report v1, not a backfill)', () => {
    const freeze = at('earlyReportFactsFreeze = await');
    const guard = source.slice(source.lastIndexOf('if (', freeze), freeze);
    expect(guard).toContain("serviceReportV1Delivery && typedDeliveryMode === 'auto_send' && !isBackfillCompletion");
  });

  test('its freeze is folded into the in-memory notes beside the gate\'s, so a later whole-object write keeps the key', () => {
    expect(source).toContain('if (earlyReportFactsFreeze) recordStructuredNotes.lawnReportFacts = earlyReportFactsFreeze;');
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
    expect(source).toContain('tiedFamilies: reportFacts.frozenTiedFamilies(service.structured_notes, lawnAssessment.assessmentId)');
  });

  test('an incomplete closeout never reaches the lawn write gate (it returns before the report path), so no facts are frozen for it', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    const earlyReturn = source.indexOf('if (isIncompleteVisit) {\n      // Recurring plan refill');
    const gateCall = source.indexOf("finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate')");
    const delivery = require('../services/service-report/delivery');
    expect(earlyReturn).toBeGreaterThan(0);
    expect(gateCall).toBeGreaterThan(earlyReturn);
    expect(delivery.shouldSendServiceReportV1Delivery({ report_template_version: 'service_report_v1', status: 'incomplete' })).toBe(false);
  });
});
