const migration = require('../models/migrations/20260716000001_appointment_card_requests');

function buildKnex({ hasColumn = false, hasTables = {} } = {}) {
  const state = { upserted: [], deleted: [], createdTables: [], droppedTables: [], alteredTables: [] };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    const query = {
      insert: jest.fn((row) => { query.__inserted = row; return query; }),
      onConflict: jest.fn((col) => { expect(col).toBe('template_key'); return query; }),
      merge: jest.fn(async (row) => { state.upserted.push({ ...query.__inserted, ...row }); }),
      where: jest.fn((criteria) => { query.__where = criteria; return query; }),
      del: jest.fn(async () => { state.deleted.push(query.__where); return 1; }),
    };
    return query;
  });
  knex.raw = jest.fn((s) => s);
  knex.fn = { now: jest.fn(() => 'NOW') };
  knex.schema = {
    hasTable: jest.fn(async (t) => (t in hasTables ? hasTables[t] : true)),
    hasColumn: jest.fn(async () => hasColumn),
    alterTable: jest.fn(async (t) => { state.alteredTables.push(t); }),
    createTable: jest.fn(async (t) => { state.createdTables.push(t); }),
    dropTable: jest.fn(async (t) => { state.droppedTables.push(t); }),
  };
  return { knex, state };
}

describe('appointment card requests migration', () => {
  test('adds the claim column, creates the request table, seeds the template INACTIVE', async () => {
    const { knex, state } = buildKnex({ hasTables: { appointment_card_requests: false } });
    await migration.up(knex);

    expect(state.alteredTables).toEqual(['scheduled_services']);
    expect(state.createdTables).toEqual(['appointment_card_requests']);

    const row = state.upserted.find((r) => r.template_key === 'secure_appointment_card');
    expect(row).toBeTruthy();
    // Dark lever: the request service refuses to send while inactive, so
    // this migration changes NOTHING until the owner reviews the copy.
    expect(row.is_active).toBe(false);
    expect(JSON.parse(row.variables)).toEqual(['first_name', 'service_type', 'date_line', 'secure_link']);
    // Copy contract: $0-today honesty, the no-card-by-phone policy line,
    // the capture link, and the opt-out line — all GSM-7-safe (no em-dash/
    // curly quotes: the unshortened 64-hex link already costs ~100 chars,
    // and a UCS-2 body would blow the 3-segment budget).
    expect(row.body).toContain('Nothing is charged today');
    expect(row.body).toContain('{secure_link}');
    expect(row.body).toContain('We never take card numbers by phone');
    expect(row.body).toContain('Reply STOP to opt out');
    expect(row.body).not.toMatch(/[—’“”]/);
  });

  test('is idempotent: existing column and table are left alone', async () => {
    const { knex, state } = buildKnex({ hasColumn: true, hasTables: { appointment_card_requests: true } });
    await migration.up(knex);
    expect(state.alteredTables).toEqual([]);
    expect(state.createdTables).toEqual([]);
    // Template upsert still merges (owner copy-edit workflow owns the body).
    expect(state.upserted).toHaveLength(1);
  });

  test('down removes the template, the table, and the column symmetrically', async () => {
    const { knex, state } = buildKnex({ hasColumn: true });
    await migration.down(knex);
    expect(state.deleted).toEqual([{ template_key: 'secure_appointment_card' }]);
    expect(state.droppedTables).toEqual(['appointment_card_requests']);
    expect(state.alteredTables).toEqual(['scheduled_services']);
  });
});
