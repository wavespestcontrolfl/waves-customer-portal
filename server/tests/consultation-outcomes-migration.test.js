/**
 * consultation_outcomes lead_id FK — split across two migrations (round 6→7):
 *
 *   - 20260923000010_consultation_outcomes.js creates the table and DOES
 *     declare lead_id -> leads (a foreign key is correct there — it's what
 *     the table originally shipped with, and it is ALREADY on this PR's
 *     pushed branch, so it can never be edited again: Railway's preview has
 *     run it, and the pre-push migration guard blocks any edit to an
 *     already-pushed migration file).
 *   - 20260924000004_drop_consultation_outcomes_lead_fk.js is the NEW,
 *     separate migration that removes the FK (round 6's original fix — see
 *     the comment above lockCustomerRow in
 *     server/services/consultation-outcomes.js for why: recordOutcome's
 *     insert into consultation_outcomes would otherwise take an implicit FK
 *     KEY SHARE lock on the referenced lead row, which forms a real ABBA
 *     deadlock against estimate-manual-acceptance.js's call-linkage-
 *     correction guard).
 *
 * This file simulates BOTH migrations against one shared fake-knex schema
 * state (columns + a `constraints` map seeded by createTable's
 * .references()/.inTable()/.onDelete() chains and mutated by the new
 * migration's raw ALTER TABLE ... DROP/ADD CONSTRAINT statements) so the
 * end-to-end claim — no FK to leads once both migrations have run — is a
 * real assertion, not two separate migrations tested in isolation. No live
 * Postgres was available in this sandbox; this is the same static,
 * schema-builder/raw-SQL-call-recording approach other migration tests in
 * this repo use for non-DB migration assertions.
 */

const migration0010 = require('../models/migrations/20260923000010_consultation_outcomes');
const migrationDropFk = require('../models/migrations/20260924000004_drop_consultation_outcomes_lead_fk');

const LEAD_FK_NAME = 'consultation_outcomes_lead_id_foreign';

// A column builder that records every chained call ({ method, args }) and
// returns itself so `.references('id').inTable('leads').onDelete('SET NULL')`
// chains resolve exactly as they would against real knex.
function makeColumnRecorder(columnsForTable, name) {
  const rec = { name, calls: [] };
  columnsForTable[name] = rec;
  const methods = [
    'primary', 'unique', 'notNullable', 'nullable', 'defaultTo',
    'references', 'inTable', 'onDelete', 'checkIn',
  ];
  const builder = {};
  methods.forEach((m) => {
    builder[m] = (...args) => { rec.calls.push({ method: m, args }); return builder; };
  });
  return builder;
}

// Only the column-type methods 0010 actually calls — a generic catch-all
// isn't needed since this test targets two known migration files.
function makeTableBuilder(columnsForTable) {
  const t = {};
  ['uuid', 'string', 'jsonb', 'decimal', 'text', 'timestamp'].forEach((typeMethod) => {
    t[typeMethod] = (name) => makeColumnRecorder(columnsForTable, name);
  });
  t.timestamps = () => {};
  t.index = () => {};
  return t;
}

function referencedTable(column) {
  const inTableCall = column && column.calls.find((c) => c.method === 'inTable');
  return inTableCall ? inTableCall.args[0] : null;
}

// A single fake-knex instance whose schema state (tables/columns/FK
// constraints) both migrations mutate in sequence, exactly as a real
// `knex migrate:latest` run would apply them one after another against one
// database.
function makeSharedFakeKnex() {
  const tables = new Set();
  const columns = {}; // table -> { colName -> { name, calls } }
  const constraints = {}; // conname -> { table, column, targetTable, onDelete }
  const rawCalls = [];

  const knex = (tableName) => {
    if (tableName !== 'pg_constraint') throw new Error(`fakeKnex: unexpected table query ${tableName}`);
    return {
      where: (cond) => ({
        first: async () => (constraints[cond.conname] ? { conname: cond.conname } : undefined),
      }),
    };
  };

  knex.raw = (sql) => {
    const trimmed = String(sql).replace(/\s+/g, ' ').trim();
    rawCalls.push(trimmed);
    const dropMatch = trimmed.match(/^ALTER TABLE (\w+) DROP CONSTRAINT IF EXISTS (\w+)$/i);
    if (dropMatch) {
      delete constraints[dropMatch[2]];
      return trimmed;
    }
    const addMatch = trimmed.match(
      /^ALTER TABLE (\w+)\s+ADD CONSTRAINT (\w+)\s+FOREIGN KEY \((\w+)\) REFERENCES (\w+)\(\w+\)(?:\s+ON DELETE (\w+(?:\s+\w+)?))?$/i,
    );
    if (addMatch) {
      constraints[addMatch[2]] = {
        table: addMatch[1], column: addMatch[3], targetTable: addMatch[4], onDelete: addMatch[5] || null,
      };
      return trimmed;
    }
    return trimmed; // e.g. gen_random_uuid() inside defaultTo — not a DDL statement
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = {
    hasTable: async (name) => tables.has(name),
    hasColumn: async (table, col) => !!(columns[table] && columns[table][col]),
    createTable: async (name, cb) => {
      tables.add(name);
      columns[name] = {};
      cb(makeTableBuilder(columns[name]));
      // Seed the FK constraints map from the column chains, same naming
      // convention knex/Postgres use by default: <table>_<column>_foreign.
      Object.entries(columns[name]).forEach(([colName, rec]) => {
        const target = referencedTable(rec);
        if (!target) return;
        const onDeleteCall = rec.calls.find((c) => c.method === 'onDelete');
        constraints[`${name}_${colName}_foreign`] = {
          table: name, column: colName, targetTable: target, onDelete: onDeleteCall ? onDeleteCall.args[0] : null,
        };
      });
    },
    dropTableIfExists: async (name) => { tables.delete(name); delete columns[name]; },
  };

  return { knex, tables, columns, constraints, rawCalls };
}

describe('20260923000010_consultation_outcomes — unchanged (already pushed, never edited again)', () => {
  test('still declares lead_id -> leads as a foreign key — a FK there is fine; this migration is not touched by the round-6 fix', async () => {
    const { knex, columns } = makeSharedFakeKnex();
    await migration0010.up(knex);

    const leadId = columns.consultation_outcomes.lead_id;
    expect(referencedTable(leadId)).toBe('leads');
  });

  test('customer_id, scheduled_service_id, technician_id foreign keys and the lead_id index are all present, unchanged', async () => {
    const { knex, columns, constraints } = makeSharedFakeKnex();
    await migration0010.up(knex);

    expect(referencedTable(columns.consultation_outcomes.customer_id)).toBe('customers');
    expect(referencedTable(columns.consultation_outcomes.scheduled_service_id)).toBe('scheduled_services');
    expect(referencedTable(columns.consultation_outcomes.technician_id)).toBe('technicians');
    expect(constraints[LEAD_FK_NAME]).toMatchObject({ targetTable: 'leads', onDelete: 'SET NULL' });
  });

  test('up() is a no-op when the table already exists (idempotent migration re-run)', async () => {
    const { knex, tables } = makeSharedFakeKnex();
    tables.add('consultation_outcomes'); // simulate an already-applied table
    const before = new Set(tables);
    await migration0010.up(knex);
    expect(tables).toEqual(before);
  });
});

describe('20260924000004_drop_consultation_outcomes_lead_fk — the actual round-6 fix', () => {
  // Every test here runs 0010 FIRST (as `knex migrate:latest` would apply
  // both files in filename order against one real database), then the new
  // migration on the SAME schema state.

  test('drops exactly the lead_id foreign key and nothing else — every other constraint survives untouched', async () => {
    const { knex, constraints } = makeSharedFakeKnex();
    await migration0010.up(knex);
    const otherConstraintsBefore = { ...constraints };
    delete otherConstraintsBefore[LEAD_FK_NAME];

    await migrationDropFk.up(knex);

    expect(constraints[LEAD_FK_NAME]).toBeUndefined();
    // Nothing else moved — same set of OTHER constraints, same values.
    const otherConstraintsAfter = { ...constraints };
    expect(otherConstraintsAfter).toEqual(otherConstraintsBefore);
  });

  test('issues exactly one raw statement: ALTER TABLE ... DROP CONSTRAINT IF EXISTS on the lead FK name — no other DDL', async () => {
    const { knex, rawCalls } = makeSharedFakeKnex();
    await migration0010.up(knex);
    const rawCallsBeforeFix = rawCalls.length;

    await migrationDropFk.up(knex);

    const newCalls = rawCalls.slice(rawCallsBeforeFix);
    expect(newCalls).toEqual([`ALTER TABLE consultation_outcomes DROP CONSTRAINT IF EXISTS ${LEAD_FK_NAME}`]);
  });

  test('the column and its index survive — only the constraint is gone', async () => {
    const { knex, columns } = makeSharedFakeKnex();
    await migration0010.up(knex);
    await migrationDropFk.up(knex);

    // The column itself (and hasColumn, which the app's own reads don't
    // depend on but this migration's own idempotency guard does) is
    // unaffected by a constraint-only DROP.
    expect(await knex.schema.hasColumn('consultation_outcomes', 'lead_id')).toBe(true);
    expect(columns.consultation_outcomes.lead_id).toBeDefined();
  });

  // THE regression guard: after BOTH migrations run, in order, against one
  // database, there is no FK to `leads` anywhere on consultation_outcomes —
  // fails if lead_id's FK is ever re-added to either migration.
  test('REGRESSION GUARD: no FK to leads on consultation_outcomes after both migrations run', async () => {
    const { knex, constraints } = makeSharedFakeKnex();
    await migration0010.up(knex);
    await migrationDropFk.up(knex);

    const leadsFks = Object.values(constraints).filter((c) => c.table === 'consultation_outcomes' && c.targetTable === 'leads');
    expect(leadsFks).toEqual([]);
  });

  test('idempotent: running up() twice (a re-run, or the constraint never existed) does not throw and stays dropped', async () => {
    const { knex, constraints } = makeSharedFakeKnex();
    await migration0010.up(knex);
    await migrationDropFk.up(knex);
    await expect(migrationDropFk.up(knex)).resolves.not.toThrow();
    expect(constraints[LEAD_FK_NAME]).toBeUndefined();
  });

  test('no-op when the table or the column does not exist yet (guards before ALTER TABLE)', async () => {
    const { knex, rawCalls } = makeSharedFakeKnex();
    // 0010 never ran in this simulated environment.
    await expect(migrationDropFk.up(knex)).resolves.not.toThrow();
    expect(rawCalls).toEqual([]);
  });

  test('down() re-adds the FK with the original target and ON DELETE SET NULL', async () => {
    const { knex, constraints } = makeSharedFakeKnex();
    await migration0010.up(knex);
    await migrationDropFk.up(knex);
    expect(constraints[LEAD_FK_NAME]).toBeUndefined();

    await migrationDropFk.down(knex);

    expect(constraints[LEAD_FK_NAME]).toMatchObject({
      table: 'consultation_outcomes', column: 'lead_id', targetTable: 'leads', onDelete: 'SET NULL',
    });
  });

  test('down() is idempotent — a no-op when the FK is already present', async () => {
    const { knex, constraints, rawCalls } = makeSharedFakeKnex();
    await migration0010.up(knex); // FK already present (0010 never dropped it)
    const rawCallsBefore = rawCalls.length;

    await migrationDropFk.down(knex);

    expect(rawCalls.length).toBe(rawCallsBefore); // no ADD CONSTRAINT attempted
    expect(constraints[LEAD_FK_NAME]).toMatchObject({ targetTable: 'leads' });
  });
});
