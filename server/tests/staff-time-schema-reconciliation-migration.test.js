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

function canonicalShapeRows(overrides = {}) {
  return migration.AUDITED_COLUMN_SHAPES.map((shape) => {
    const defaultByKind = {
      none: null,
      text: `'${shape.defaultValue}'::${shape.dataType}`,
      zero: "'0'::numeric",
      current_timestamp: 'now()',
    };
    const key = `${shape.table}.${shape.column}`;
    return {
      table_name: shape.table,
      column_name: shape.column,
      data_type: shape.dataType,
      character_maximum_length: shape.characterMaximumLength ?? null,
      numeric_precision: shape.numericPrecision ?? null,
      numeric_scale: shape.numericScale ?? null,
      is_nullable: shape.nullable ? 'YES' : 'NO',
      column_default: defaultByKind[shape.defaultKind],
      ...(overrides[key] || {}),
    };
  });
}

function canonicalConstraintRows() {
  return [
    {
      conname: 'time_entries_entry_type_check',
      convalidated: true,
      connoinherit: false,
      definition: "CHECK ((entry_type = ANY (ARRAY['shift'::text, 'job'::text, 'break'::text, 'drive'::text, 'admin_time'::text])))",
    },
    {
      conname: 'time_entries_status_check',
      convalidated: true,
      connoinherit: false,
      definition: "CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'edited'::text, 'voided'::text])))",
    },
    {
      conname: 'time_entries_staff_active_write_generation_check',
      convalidated: true,
      connoinherit: false,
      definition: "CHECK (((status <> 'active'::text) OR (staff_write_generation IS NOT DISTINCT FROM 1)))",
    },
  ];
}

function canonicalKnex({
  omit,
  dailyCount = 0,
  weeklyCount = 0,
  activeTimer = false,
  allowAlterTable = false,
  shapeOverrides = {},
  constraintRows = canonicalConstraintRows(),
  invalidEditedByCount = 0,
  nullCounts = {},
} = {}) {
  const rawCalls = [];
  const addedColumns = [];
  const columnBuilder = (tableName, type, name, args = []) => {
    const definition = {
      tableName,
      type,
      name,
      args,
      nullable: undefined,
      defaultValue: undefined,
    };
    addedColumns.push(definition);
    const chain = {
      nullable: jest.fn(() => {
        definition.nullable = true;
        return chain;
      }),
      defaultTo: jest.fn((value) => {
        definition.defaultValue = value;
        return chain;
      }),
    };
    return chain;
  };
  const tableBuilder = (tableName) => ({
    uuid: (name) => columnBuilder(tableName, 'uuid', name),
    timestamp: (name) => columnBuilder(tableName, 'timestamp', name),
    text: (name) => columnBuilder(tableName, 'text', name),
    string: (name, length) => columnBuilder(tableName, 'string', name, [length]),
    integer: (name) => columnBuilder(tableName, 'integer', name),
    decimal: (name, precision, scale) => (
      columnBuilder(tableName, 'decimal', name, [precision, scale])
    ),
  });
  const knex = {
    schema: {
      hasTable: jest.fn(async () => true),
      alterTable: jest.fn(async (tableName, callback) => {
        if (!allowAlterTable) throw new Error('canonical fixture must not alter a table');
        callback(tableBuilder(tableName));
      }),
    },
    raw: jest.fn(async (sql, bindings) => {
      rawCalls.push({ sql, bindings });
      if (sql.includes('AS invalid_count')) {
        return { rows: [{ invalid_count: invalidEditedByCount }] };
      }
      if (sql.includes('AS null_count')) {
        const table = sql.match(/FROM\s+(\w+)/)?.[1];
        const column = sql.match(/WHERE\s+(\w+) IS NULL/)?.[1];
        return { rows: [{ null_count: nullCounts[`${table}.${column}`] || 0 }] };
      }
      if (sql.includes('SELECT column_default')) {
        return { rows: [{ column_default: 'gen_random_uuid()' }] };
      }
      if (sql.includes("WHERE status = 'active'")) {
        return { rows: [{ exists: activeTimer }] };
      }
      if (sql.includes('pg_get_constraintdef')) {
        const names = bindings?.[1] || [];
        return { rows: constraintRows.filter(({ conname }) => names.includes(conname)) };
      }
      if (sql.includes('character_maximum_length')) {
        return { rows: canonicalShapeRows(shapeOverrides) };
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
      if (sql.includes('NOT IN')) {
        return { rows: [{ exists: false }] };
      }
      return { rows: [] };
    }),
  };
  return { knex, rawCalls, addedColumns };
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

  test('adds canonical weekly approval and sign-off columns to an empty legacy table', async () => {
    const { knex, addedColumns } = canonicalKnex({
      omit: { time_weekly_summary: migration.REQUIRED_COLUMNS.time_weekly_summary },
      allowAlterTable: true,
    });

    await migration.up(knex);

    expect(addedColumns.filter(({ name }) => [
      'approved_by',
      'approved_at',
      'approval_notes',
      'tech_signed_at',
      'tech_signature',
    ].includes(name))).toEqual([
      {
        tableName: 'time_weekly_summary',
        type: 'uuid',
        name: 'approved_by',
        args: [],
        nullable: true,
        defaultValue: undefined,
      },
      {
        tableName: 'time_weekly_summary',
        type: 'timestamp',
        name: 'approved_at',
        args: [],
        nullable: true,
        defaultValue: undefined,
      },
      {
        tableName: 'time_weekly_summary',
        type: 'text',
        name: 'approval_notes',
        args: [],
        nullable: true,
        defaultValue: undefined,
      },
      {
        tableName: 'time_weekly_summary',
        type: 'timestamp',
        name: 'tech_signed_at',
        args: [],
        nullable: true,
        defaultValue: undefined,
      },
      {
        tableName: 'time_weekly_summary',
        type: 'string',
        name: 'tech_signature',
        args: [200],
        nullable: true,
        defaultValue: undefined,
      },
    ]);
  });

  test('adds nullable weekly audit fields safely when historical rows exist', async () => {
    const auditColumns = [
      'approved_by',
      'approved_at',
      'approval_notes',
      'tech_signed_at',
      'tech_signature',
    ];
    const { knex, rawCalls, addedColumns } = canonicalKnex({
      omit: { time_weekly_summary: auditColumns },
      weeklyCount: 7,
      allowAlterTable: true,
    });

    await migration.up(knex);

    expect(addedColumns.map(({ name }) => name)).toEqual(auditColumns);
    expect(rawCalls.some(({ sql }) => sql.includes('AS daily_count'))).toBe(false);
  });

  test('restores omitted entry approval fields without inventing historical approval state', async () => {
    const approvalColumns = [
      'approval_status',
      'approved_by',
      'approved_at',
      'approval_notes',
    ];
    const { knex, rawCalls, addedColumns } = canonicalKnex({
      omit: { time_entries: approvalColumns },
      allowAlterTable: true,
      shapeOverrides: {
        'time_entries.approval_status': { column_default: null },
      },
    });

    await migration.up(knex);

    expect(addedColumns.filter(({ name }) => approvalColumns.includes(name))).toEqual([
      expect.objectContaining({ name: 'approval_status', type: 'string', nullable: true }),
      expect.objectContaining({ name: 'approved_by', type: 'uuid', nullable: true }),
      expect.objectContaining({ name: 'approved_at', type: 'timestamp', nullable: true }),
      expect.objectContaining({ name: 'approval_notes', type: 'text', nullable: true }),
    ]);
    expect(rawCalls.map(({ sql }) => sql).join('\n')).toMatch(
      /ALTER COLUMN approval_status SET DEFAULT 'pending'/,
    );
  });

  test('rejects a nonempty weekly table when a derived total is missing', async () => {
    const { knex } = canonicalKnex({
      omit: {
        time_weekly_summary: ['total_job_minutes', 'approved_by', 'tech_signed_at'],
      },
      weeklyCount: 1,
      allowAlterTable: true,
    });

    await expect(migration.up(knex)).rejects.toThrow(
      /weekly_summary contains rows but lacks derived payroll columns/,
    );
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('closes the audit-to-auth race by rejecting an active timer under lock', async () => {
    const { knex } = canonicalKnex({ activeTimer: true });

    await expect(migration.up(knex)).rejects.toThrow(/Active Staff timers/);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('widens known route-era columns and restores canonical defaults without rewriting rows', async () => {
    const { knex, rawCalls } = canonicalKnex({
      shapeOverrides: {
        'time_entries.entry_type': {
          data_type: 'character varying',
          character_maximum_length: 20,
          column_default: "'shift'::character varying",
        },
        'time_entries.duration_minutes': {
          numeric_precision: 8,
        },
        'time_entries.service_type': {
          character_maximum_length: 50,
        },
        'time_entries.pay_type': {
          character_maximum_length: 20,
          column_default: "'regular'::character varying",
        },
        'time_entries.edited_by': {
          data_type: 'character varying',
          character_maximum_length: 100,
        },
        'time_entries.source': {
          character_maximum_length: 20,
          column_default: "'tech_app'::character varying",
        },
        'time_entry_daily_summary.total_shift_minutes': {
          numeric_precision: 8,
        },
      },
    });

    await migration.up(knex);

    const sql = rawCalls.map((call) => call.sql).join('\n');
    expect(sql).toMatch(/ALTER COLUMN entry_type TYPE text/);
    expect(sql).toMatch(/ALTER COLUMN duration_minutes TYPE numeric\(10, 2\)/);
    expect(sql).toMatch(/ALTER COLUMN service_type TYPE varchar\(255\)/);
    expect(sql).toMatch(/ALTER COLUMN edited_by TYPE uuid[\s\S]*USING edited_by::uuid/);
    expect(sql).toMatch(/ALTER COLUMN entry_type DROP DEFAULT/);
    expect(sql).toMatch(/ALTER COLUMN pay_type SET DEFAULT 'hourly'/);
    expect(sql).toMatch(/ALTER COLUMN source SET DEFAULT 'app'/);
    expect(sql).toMatch(/pg_input_is_valid\(BTRIM\(edited_by::text\), 'uuid'\)/);
  });

  test('blocks edited_by conversion when PostgreSQL cannot parse every legacy value as UUID', async () => {
    const { knex, rawCalls } = canonicalKnex({
      shapeOverrides: {
        'time_entries.edited_by': {
          data_type: 'character varying',
          character_maximum_length: 100,
        },
      },
      invalidEditedByCount: 2,
    });

    await expect(migration.up(knex)).rejects.toThrow(
      /edited_by contains 2 non-UUID value\(s\)/,
    );
    expect(rawCalls.map(({ sql }) => sql).join('\n')).not.toMatch(
      /ALTER COLUMN edited_by TYPE uuid/,
    );
  });

  test.each(['time_entry_daily_summary', 'time_weekly_summary'])(
    'blocks %s status hardening until legacy NULL statuses are explicitly backfilled',
    async (table) => {
      const { knex } = canonicalKnex({
        shapeOverrides: {
          [`${table}.status`]: {
            is_nullable: 'YES',
            column_default: null,
          },
        },
        nullCounts: { [`${table}.status`]: 3 },
      });

      await expect(migration.up(knex)).rejects.toThrow(
        new RegExp(`${table}\\.status contains 3 NULL value`),
      );
    },
  );

  test('repairs nullable summary status only after a clean preflight', async () => {
    const { knex, rawCalls } = canonicalKnex({
      shapeOverrides: {
        'time_entry_daily_summary.status': {
          is_nullable: 'YES',
          column_default: null,
        },
      },
    });

    await migration.up(knex);

    const sql = rawCalls.map((call) => call.sql).join('\n');
    expect(sql).toMatch(/FROM time_entry_daily_summary[\s\S]*WHERE status IS NULL/);
    expect(sql).toMatch(/ALTER COLUMN status SET NOT NULL/);
    expect(sql).toMatch(/ALTER COLUMN status SET DEFAULT 'pending'/);
  });

  test('replaces familiar check names whose catalog definitions have wrong semantics', async () => {
    const wrongConstraints = canonicalConstraintRows().map((constraint) => {
      if (constraint.conname === 'time_entries_entry_type_check') {
        return { ...constraint, definition: "CHECK (entry_type = 'shift'::text)" };
      }
      if (constraint.conname === 'time_entries_staff_active_write_generation_check') {
        return { ...constraint, definition: "CHECK (status <> 'active'::text)" };
      }
      return constraint;
    });
    const { knex, rawCalls } = canonicalKnex({ constraintRows: wrongConstraints });

    await migration.up(knex);

    const sql = rawCalls.map((call) => call.sql).join('\n');
    expect(sql).toMatch(/pg_get_constraintdef\(c\.oid, true\)/);
    expect(sql).toMatch(/DROP CONSTRAINT time_entries_entry_type_check/);
    expect(sql).toMatch(/ADD CONSTRAINT time_entries_staff_entry_type_check/);
    expect(sql).toMatch(/DROP CONSTRAINT time_entries_staff_active_write_generation_check/);
    expect(sql).toMatch(
      /staff_write_generation IS NOT DISTINCT FROM 1/,
    );
  });

  test('treats PostgreSQL server spelling of IS NOT DISTINCT FROM as exact', () => {
    const actual = {
      convalidated: true,
      connoinherit: false,
      definition: "CHECK (status <> 'active'::text OR NOT staff_write_generation IS DISTINCT FROM 1)",
    };

    expect(migration.exactCheckConstraint(
      actual,
      "CHECK (status <> 'active' OR staff_write_generation IS NOT DISTINCT FROM 1)",
    )).toBe(true);
  });

  test('refuses unrecognized narrowing instead of coercing payroll values', async () => {
    const { knex } = canonicalKnex({
      shapeOverrides: {
        'time_entry_daily_summary.total_shift_minutes': {
          numeric_precision: 12,
        },
      },
    });

    await expect(migration.up(knex)).rejects.toThrow(
      /total_shift_minutes has unsupported type numeric; expected numeric\(10, 2\)/,
    );
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
    expect(service.match(/staff_write_generation: ACTIVE_WRITE_GENERATION/g)).toHaveLength(4);
    expect(notifications).toMatch(
      /undo-stop[\s\S]*db\.transaction[\s\S]*\.forUpdate\(\)[\s\S]*reopenStoppedEntryInTransaction[\s\S]*whereNull\('dismissed_at'\)[\s\S]*\.update\(/,
    );
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
    expect(startJob).toMatch(/lockActiveShift\(trx, technicianId\)/);
    expect(service).toMatch(
      /async function lockActiveShift[\s\S]*entry_type: 'shift'[\s\S]*\.forUpdate\(\)/,
    );
    expect(startJob).toMatch(/await trx\('time_entries'\)[\s\S]*?\.update\(/);
    expect(startJob).toMatch(/await trx\('time_entries'\)[\s\S]*?\.insert\(/);
  });
});
