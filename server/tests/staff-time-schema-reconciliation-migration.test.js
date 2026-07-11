const fs = require('fs');
const path = require('path');

const migration = require('../models/migrations/20260711000002_staff_time_schema_reconciliation');
const { ACTIVE_WRITE_GENERATION } = require('../constants/staff-time');

function canonicalColumnRows(omit = {}) {
  return Object.entries(migration.REQUIRED_COLUMNS).flatMap(([tableName, columns]) => (
    columns
      .filter((columnName) => !(omit[tableName] || []).includes(columnName))
      .map((columnName) => ({ table_name: tableName, column_name: columnName }))
  ));
}

function canonicalKnex({ omit, dailyCount = 0, weeklyCount = 0, activeTimer = false } = {}) {
  const rawCalls = [];
  const knex = {
    schema: {
      hasTable: jest.fn(async () => true),
      alterTable: jest.fn(async () => {
        throw new Error('canonical fixture must not alter a table');
      }),
    },
    raw: jest.fn(async (sql, bindings) => {
      rawCalls.push({ sql, bindings });
      if (sql.includes('SELECT column_default')) {
        return { rows: [{ column_default: 'gen_random_uuid()' }] };
      }
      if (sql.includes("WHERE status = 'active'")) {
        return { rows: [{ exists: activeTimer }] };
      }
      if (sql.includes("c.contype = 'c'")) {
        return { rows: [{ exists: true }] };
      }
      if (sql.includes("is_nullable = 'NO'")) {
        return { rows: [{ is_not_null: true }] };
      }
      if (sql.includes('SELECT table_name, column_name')) {
        return { rows: canonicalColumnRows(omit) };
      }
      if (sql.includes('AS daily_count')) {
        return { rows: [{ daily_count: dailyCount, weekly_count: weeklyCount }] };
      }
      if (sql.includes('AS null_id')) {
        return {
          rows: [{
            null_id: false,
            duplicate_id: false,
            null_unique_key: false,
            duplicate_unique_key: false,
          }],
        };
      }
      if (sql.includes('pg_get_serial_sequence')) {
        return {
          rows: [{
            sequence_name: 'public.existing_id_seq',
            column_default: "nextval('public.existing_id_seq'::regclass)",
          }],
        };
      }
      if (sql.includes('last_value::bigint')) {
        return { rows: [{ max_id: null, last_value: '1', is_called: false }] };
      }
      if (sql.includes('WITH index_shapes AS')) {
        return { rows: [{ exists: true }] };
      }
      return { rows: [] };
    }),
  };
  return { knex, rawCalls };
}

describe('Staff time schema reconciliation migration', () => {
  test('is idempotent on the canonical shape and never runs destructive down DDL', async () => {
    const { knex, rawCalls } = canonicalKnex();

    await migration.up(knex);
    await migration.up(knex);
    await migration.down(knex);

    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    const sql = rawCalls.map((call) => call.sql).join('\n');
    expect(sql).not.toMatch(/CREATE INDEX|ADD CONSTRAINT|DROP (?:COLUMN|INDEX|TABLE)/);
  });

  test('rejects nonempty derived summaries before adding missing columns', async () => {
    const { knex } = canonicalKnex({
      omit: { time_entry_daily_summary: ['total_admin_minutes'] },
      dailyCount: 1,
    });

    await expect(migration.up(knex)).rejects.toThrow(
      /daily_summary contains rows but lacks derived payroll columns/,
    );
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('closes the audit-to-auth race by rejecting an active timer under lock', async () => {
    const { knex } = canonicalKnex({ activeTimer: true });

    await expect(migration.up(knex)).rejects.toThrow(/Active Staff timers/);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('semantic index inspection binds ordered columns and integrity requirements', async () => {
    const raw = jest.fn(async () => ({ rows: [{ exists: true }] }));

    await expect(migration.indexShapeExists(
      { raw },
      'time_entries',
      ['technician_id', 'clock_in'],
      { unique: true, primary: false },
    )).resolves.toBe(true);

    expect(raw).toHaveBeenCalledWith(
      expect.stringMatching(/indisvalid[\s\S]*key_columns = \?::text\[\]/),
      ['time_entries', ['technician_id', 'clock_in'], true, false],
    );
  });

  test('escapes catalog-derived sequence names used in utility DDL', () => {
    expect(migration.sqlStringLiteral("odd'seq")).toBe("'odd''seq'");
  });

  test('Phase-A application stamps every create/reopen-active write', () => {
    expect(ACTIVE_WRITE_GENERATION).toBe(1);
    const service = fs.readFileSync(
      path.join(__dirname, '../services/time-tracking.js'),
      'utf8',
    );
    const notifications = fs.readFileSync(
      path.join(__dirname, '../routes/tech-notifications.js'),
      'utf8',
    );
    expect(service.match(/staff_write_generation: ACTIVE_WRITE_GENERATION/g)).toHaveLength(3);
    expect(notifications).toMatch(/status: 'active',[\s\S]*staff_write_generation: ACTIVE_WRITE_GENERATION/);
  });

  test('job replacement closes and creates the timer in one transaction', () => {
    const service = fs.readFileSync(
      path.join(__dirname, '../services/time-tracking.js'),
      'utf8',
    );
    const startJob = service.match(
      /async function startJob[\s\S]*?\n}\n\n\/\*\*\n \* End the active job entry/,
    )?.[0];

    expect(startJob).toMatch(/db\.transaction\(async \(trx\)/);
    expect(startJob).toMatch(/entry_type: 'shift',[\s\S]*?\.forUpdate\(\)/);
    expect(startJob).toMatch(/await trx\('time_entries'\)[\s\S]*?\.update\(/);
    expect(startJob).toMatch(/await trx\('time_entries'\)[\s\S]*?\.insert\(/);
  });
});
