/**
 * save_weekly_report — the operations_section carries the ops KPI table
 * (Codex P2, bi-agent-config.js:151). A missing/blank value must be rejected
 * WITHOUT inserting, rather than saving a report with no ops record.
 */

// jest.mock factories can't close over ordinary top-level variables (only
// `mock`-prefixed ones survive hoisting), so the insert capture lives inside
// the factory and is published on the mock db function itself.
jest.mock('../models/db', () => {
  const mockInsertedRows = [];
  const db = jest.fn((table) => {
    expect(table).toBe('weekly_bi_reports');
    return {
      insert(row) {
        mockInsertedRows.push(row);
        return { returning: () => Promise.resolve([{ id: 'report-1', ...row }]) };
      },
    };
  });
  db.__mockInsertedRows = mockInsertedRows;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { executeBITool } = require('../services/bi-agent-tools');
const fakeDb = require('../models/db');

function validInput(overrides = {}) {
  return {
    summary: 'Solid week.',
    revenue_section: 'MRR up 2%.',
    customer_section: 'Active 210, +3 this month.',
    operations_section: 'Completion 82% (tgt 85%) — warn.',
    ads_section: 'CPA $18, ROAS 4.2x.',
    reviews_section: '4.8★, 2 unresponded.',
    content_seo_section: '2 published, 0 decaying.',
    anomalies_section: 'None.',
    action_items: 'Follow up with at-risk accounts.',
    ...overrides,
  };
}

describe('save_weekly_report — operations_section is required', () => {
  let insertedRows;

  beforeEach(() => {
    fakeDb.__mockInsertedRows.length = 0;
    insertedRows = fakeDb.__mockInsertedRows;
  });

  it('saves normally when operations_section is a non-blank string', async () => {
    const result = await executeBITool('save_weekly_report', validInput());
    expect(result).toEqual({ saved: true, reportId: 'report-1' });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].operations_section).toBe('Completion 82% (tgt 85%) — warn.');
  });

  it('rejects a missing operations_section without inserting', async () => {
    const input = validInput();
    delete input.operations_section;
    const result = await executeBITool('save_weekly_report', input);
    expect(result).toEqual({ error: 'operations_section is required', validationError: true });
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects a null operations_section without inserting', async () => {
    const result = await executeBITool('save_weekly_report', validInput({ operations_section: null }));
    expect(result).toEqual({ error: 'operations_section is required', validationError: true });
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects a whitespace-only operations_section without inserting', async () => {
    const result = await executeBITool('save_weekly_report', validInput({ operations_section: '   \n  ' }));
    expect(result).toEqual({ error: 'operations_section is required', validationError: true });
    expect(insertedRows).toHaveLength(0);
  });
});
