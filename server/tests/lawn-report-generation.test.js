// Delivery recovery reads report_auto_generated / report_id as durable proof
// that the report step finished. The marker must therefore follow a real
// service_reports row, and the row and its marker must land together.
const state = { rows: [], assessmentUpdates: [], hasTable: true, assessmentCols: { report_auto_generated: {}, report_id: {}, updated_at: {} }, reportCols: { customer_id: {}, service_date: {}, report_data: {}, status: {}, generated_at: {} }, failUpdate: false };

jest.mock('../models/db', () => {
  const table = (name) => ({
    where: () => ({
      first: async () => (name === 'lawn_assessments'
        ? { id: 'a-1', customer_id: 'c-1', service_date: '2026-09-11', overall_score: 70 }
        : name === 'customers' ? { id: 'c-1', first_name: 'Pat' } : null),
      update: async (fields) => {
        if (state.failUpdate) throw new Error('marker write failed');
        state.assessmentUpdates.push(fields);
        return 1;
      },
    }),
    insert: (data) => ({ returning: async () => { const row = { id: `r-${state.rows.length + 1}`, ...data }; state.rows.push(row); return [row]; } }),
    columnInfo: async () => (name === 'lawn_assessments' ? state.assessmentCols : state.reportCols),
  });
  table.schema = { hasTable: async () => state.hasTable };
  // One shared fixture connection: a rolled-back transaction discards both writes.
  table.transaction = async (fn) => {
    const before = { rows: state.rows.length, updates: state.assessmentUpdates.length };
    try { return await fn(table); } catch (err) {
      state.rows.length = before.rows;
      state.assessmentUpdates.length = before.updates;
      throw err;
    }
  };
  return table;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const LawnIntel = require('../services/lawn-intelligence');

describe('generateServiceReport durability markers', () => {
  beforeEach(() => {
    state.rows = []; state.assessmentUpdates = []; state.hasTable = true; state.failUpdate = false;
    state.assessmentCols = { report_auto_generated: {}, report_id: {}, updated_at: {} };
    state.reportCols = { customer_id: {}, service_date: {}, report_data: {}, status: {}, generated_at: {} };
  });

  test('a generated report stamps the assessment with its id', async () => {
    const report = await LawnIntel.generateServiceReport('a-1');
    expect(report).toMatchObject({ id: 'r-1' });
    expect(state.assessmentUpdates).toEqual([expect.objectContaining({ report_auto_generated: true, report_id: 'r-1' })]);
  });

  test('no service_reports table still completes the step — there is nothing to insert', async () => {
    state.hasTable = false;
    await LawnIntel.generateServiceReport('a-1');
    expect(state.rows).toEqual([]);
    // This schema has no such table at all; withholding the marker would leave
    // delivery's report step owed forever and block the notification behind it.
    expect(state.assessmentUpdates).toEqual([expect.objectContaining({ report_auto_generated: true })]);
  });

  test('a service_reports table with no usable columns leaves the step owed', async () => {
    state.reportCols = {};
    await LawnIntel.generateServiceReport('a-1');
    expect(state.rows).toEqual([]);
    // Real migration lag: recovery should retry once the columns land.
    expect(state.assessmentUpdates).toEqual([]);
  });

  test('an assessment table with no marker column generates nothing at all', async () => {
    state.hasTable = true;
    state.assessmentCols = { updated_at: {} };
    // An unrecordable report would be re-inserted by every recovery sweep.
    await LawnIntel.generateServiceReport('a-1');
    expect(state.rows).toEqual([]);
    expect(state.assessmentUpdates).toEqual([]);
  });

  test('a failed marker write rolls the report row back instead of orphaning it', async () => {
    state.failUpdate = true;
    await LawnIntel.generateServiceReport('a-1');
    expect(state.rows).toEqual([]);
    expect(state.assessmentUpdates).toEqual([]);
  });
});
