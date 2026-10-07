// GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES: the coverage verdict is frozen once at
// completion by the lawn write gate (structured_notes.lawnCoverageVerdict, first
// writer wins, own guarded statement). Synthetic data only.

jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(async (id) => ({ id, service_line: 'lawn', structured_notes: '{}' })),
  ensureReportToken: jest.fn(async () => 'c'.repeat(32)),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/service-report/report-consistency', () => ({ reconcileLawnReport: jest.fn(() => ({ warnings: [] })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildReportV1Data } = require('../services/service-report/report-data');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');
const {
  readFrozenCoverageVerdict, frozenCoverageDefaultsOnly, coverageVerdictStamp, freezeCoverageVerdict,
} = require('../services/service-report/lawn-coverage-verdict');

const KEY = 'GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES';
afterEach(() => { delete process.env[KEY]; jest.clearAllMocks(); });

function fakeKnex(initialNotes = {}, { failVerdict = false } = {}) {
  const state = { notes: JSON.parse(JSON.stringify(initialNotes)), statements: [] };
  const knex = () => {
    const q = { guard: null };
    q.where = () => q;
    q.whereRaw = (sql) => { q.guard = sql; return q; };
    q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
    q.update = async ({ structured_notes: raw }) => {
      const patch = JSON.parse(raw.bindings[0]);
      const isVerdict = Object.prototype.hasOwnProperty.call(patch, 'lawnCoverageVerdict');
      state.statements.push({ guard: q.guard, keys: Object.keys(patch), isVerdict });
      if (isVerdict && failVerdict) throw new Error('write failed');
      if (isVerdict && state.notes.lawnCoverageVerdict) return 0;
      Object.assign(state.notes, patch);
      return 1;
    };
    return q;
  };
  knex.raw = (sql, bindings) => ({ sql, bindings });
  return { knex, state };
}

// What the report builder hands the gate through opts.lawnCoverageOut.
function buildWith(coverage, { reportV2 = { smsSummary: 'sms', snapshot: { statusHeadline: 'h' } } } = {}) {
  buildReportV1Data.mockImplementationOnce(async (_r, _t, _k, opts) => {
    if (coverage) Object.assign(opts.lawnCoverageOut, coverage);
    return { reportV2 };
  });
}
const run = (knex) => finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });

describe('freeze at completion (write gate)', () => {
  test('gate live + technician-marked zones: freezes defaultsOnly false', async () => {
    process.env[KEY] = 'true';
    buildWith({ readOk: true, defaultsOnly: false });
    const { knex, state } = fakeKnex({});
    await run(knex);
    expect(state.notes.lawnCoverageVerdict).toMatchObject({ v: 1, defaultsOnly: false });
    expect(Number.isNaN(Date.parse(state.notes.lawnCoverageVerdict.frozenAt))).toBe(false);
  });

  test('gate live + default zones: freezes defaultsOnly true, in its own guarded statement', async () => {
    process.env[KEY] = 'true';
    buildWith({ readOk: true, defaultsOnly: true });
    const { knex, state } = fakeKnex({});
    await run(knex);
    expect(state.notes.lawnCoverageVerdict).toMatchObject({ v: 1, defaultsOnly: true });
    const verdict = state.statements.find((s) => s.isVerdict);
    expect(verdict.keys).toEqual(['lawnCoverageVerdict']);
    expect(verdict.guard).toBe("(structured_notes::jsonb -> 'lawnCoverageVerdict') IS NULL");
    // lawnReportV2 keeps its own whole-object write and never carries the verdict.
    expect(state.notes.lawnReportV2).not.toHaveProperty('lawnCoverageVerdict');
  });

  test('a failed zone / geometry read freezes nothing', async () => {
    process.env[KEY] = 'true';
    buildWith({ readOk: false, defaultsOnly: true });
    const { knex, state } = fakeKnex({});
    const result = await run(knex);
    expect(result.persisted).toBe(true);
    expect(state.notes).not.toHaveProperty('lawnCoverageVerdict');
  });

  test('a failed joined-record load (no map center) freezes nothing (codex #6089 r7)', async () => {
    process.env[KEY] = 'true';
    const { loadServiceRecordForPdf } = require('../services/service-report/pdf-queue');
    loadServiceRecordForPdf.mockRejectedValueOnce(new Error('join failed'));
    buildWith({ readOk: true, defaultsOnly: false });
    const { knex, state } = fakeKnex({});
    await run(knex);
    expect(state.notes).not.toHaveProperty('lawnCoverageVerdict');
  });

  test('a failed completion zone sync freezes nothing (codex #6089)', async () => {
    process.env[KEY] = 'true';
    buildWith({ readOk: true, defaultsOnly: true });
    const { knex, state } = fakeKnex({});
    const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');
    await finalizeLawnReportSynthesis({ service: { id: 'svc-1', service_line: 'lawn', structured_notes: '{}' }, knex, zoneSyncOk: false });
    expect(state.notes).not.toHaveProperty('lawnCoverageVerdict');
  });

  test('gate off: no verdict statement is issued', async () => {
    buildWith({ readOk: true, defaultsOnly: true });
    const { knex, state } = fakeKnex({});
    await run(knex);
    expect(state.statements.some((s) => s.isVerdict)).toBe(false);
    expect(state.notes).not.toHaveProperty('lawnCoverageVerdict');
  });

  test('first writer wins: a later run with the opposite answer changes nothing', async () => {
    process.env[KEY] = 'true';
    const { knex, state } = fakeKnex({});
    buildWith({ readOk: true, defaultsOnly: true }); await run(knex);
    const first = JSON.stringify(state.notes.lawnCoverageVerdict);
    buildWith({ readOk: true, defaultsOnly: false }); await run(knex);
    expect(JSON.stringify(state.notes.lawnCoverageVerdict)).toBe(first);
    expect(state.notes.lawnCoverageVerdict.defaultsOnly).toBe(true);
  });

  test('freezes even when the visit has no reportV2 (no linked assessment)', async () => {
    process.env[KEY] = 'true';
    buildWith({ readOk: true, defaultsOnly: true }, { reportV2: null });
    const { knex, state } = fakeKnex({});
    await run(knex);
    expect(state.notes.lawnCoverageVerdict.defaultsOnly).toBe(true);
  });

  test('a failed verdict write never fails completion', async () => {
    process.env[KEY] = 'true';
    buildWith({ readOk: true, defaultsOnly: true });
    const { knex, state } = fakeKnex({}, { failVerdict: true });
    const result = await run(knex);
    expect(result.persisted).toBe(true);
    expect(state.notes).not.toHaveProperty('lawnCoverageVerdict');
  });

  test('a build that failed freezes nothing', async () => {
    process.env[KEY] = 'true';
    buildReportV1Data.mockImplementationOnce(async () => { throw new Error('build failed'); });
    const { knex, state } = fakeKnex({});
    await run(knex);
    expect(state.notes).not.toHaveProperty('lawnCoverageVerdict');
  });
});

describe('verdict helpers', () => {
  const notes = (v) => JSON.stringify({ lawnCoverageVerdict: v });
  test('reads only a v1 verdict with a boolean defaultsOnly', () => {
    expect(readFrozenCoverageVerdict(notes({ v: 1, defaultsOnly: true, frozenAt: 'x' }))).toMatchObject({ defaultsOnly: true });
    expect(readFrozenCoverageVerdict(notes({ v: 1, defaultsOnly: false }))).toMatchObject({ defaultsOnly: false });
    expect(readFrozenCoverageVerdict(notes({ v: 2, defaultsOnly: true }))).toBeNull();
    expect(readFrozenCoverageVerdict(notes({ v: 1, defaultsOnly: 'true' }))).toBeNull();
    expect(readFrozenCoverageVerdict('{}')).toBeNull();
    expect(readFrozenCoverageVerdict(null)).toBeNull();
    expect(readFrozenCoverageVerdict('not json')).toBeNull();
  });
  test('stamp is ":covhide=1" only for defaultsOnly true', () => {
    expect(coverageVerdictStamp(notes({ v: 1, defaultsOnly: true }))).toBe(':covhide=1');
    expect(coverageVerdictStamp(notes({ v: 1, defaultsOnly: false }))).toBe('');
    expect(coverageVerdictStamp('{}')).toBe('');
    expect(frozenCoverageDefaultsOnly({ lawnCoverageVerdict: { v: 1, defaultsOnly: true } })).toBe(true);
  });
  test('freezeCoverageVerdict ignores a non-boolean answer', async () => {
    const { knex, state } = fakeKnex({});
    expect(await freezeCoverageVerdict({ knex, serviceRecordId: 's1', defaultsOnly: undefined })).toEqual({ frozen: false });
    expect(state.statements).toEqual([]);
  });
});
