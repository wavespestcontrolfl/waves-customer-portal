/**
 * 20260923000010_consultation_outcomes — schema regression guard (round 6).
 *
 * lead_id must NEVER carry a foreign key to `leads`: recordOutcome's insert
 * would then take an implicit FK KEY SHARE lock on the referenced lead row,
 * which forms a real ABBA deadlock against estimate-manual-acceptance.js's
 * call-linkage-correction guard (locks `leads` FOR UPDATE before
 * `customers` — the opposite order from admin-leads.js, which locks
 * `customers` before `leads`; no lock order inside recordOutcome can
 * satisfy both). See the comment above lockCustomerRow in
 * server/services/consultation-outcomes.js for the full reasoning.
 *
 * This reads the REAL migration file's `up` against a fake knex that
 * records every schema-builder call, so a re-added `.references(...)
 * .inTable('leads')` on lead_id fails this test — not a live-Postgres
 * assertion (none is available in this sandbox), but the same
 * schema-builder-call-recording approach other migration tests in this
 * repo use for static (non-DB) migration assertions.
 */

const migration = require('../models/migrations/20260923000010_consultation_outcomes');

// A column builder that records every chained call ({ method, args }) and
// returns itself so `.references('id').inTable('leads').onDelete('SET NULL')`
// chains resolve exactly as they would against real knex.
function makeColumnRecorder(columns, name) {
  const rec = { name, calls: [] };
  columns.push(rec);
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

// Only the column-type methods this migration actually calls — a generic
// catch-all isn't needed since this test targets ONE known migration file.
function makeTableBuilder(columns, tableCalls) {
  const t = {};
  ['uuid', 'string', 'jsonb', 'decimal', 'text', 'timestamp'].forEach((typeMethod) => {
    t[typeMethod] = (name) => makeColumnRecorder(columns, name);
  });
  t.timestamps = (...args) => { tableCalls.push({ method: 'timestamps', args }); };
  t.index = (...args) => { tableCalls.push({ method: 'index', args }); };
  return t;
}

function fakeKnex() {
  const columns = [];
  const tableCalls = [];
  const knex = {
    raw: (sql) => sql,
    fn: { now: () => 'now()' },
    schema: {
      hasTable: async () => false,
      createTable: async (name, cb) => {
        tableCalls.push({ method: 'createTable', args: [name] });
        cb(makeTableBuilder(columns, tableCalls));
      },
      dropTableIfExists: async () => {},
    },
  };
  return { knex, columns, tableCalls };
}

function findColumn(columns, name) {
  return columns.find((c) => c.name === name);
}

function referencedTable(column) {
  const inTableCall = column.calls.find((c) => c.method === 'inTable');
  return inTableCall ? inTableCall.args[0] : null;
}

test('lead_id declares NO foreign key (regression guard — see lockCustomerRow in consultation-outcomes.js)', async () => {
  const { knex, columns } = fakeKnex();
  await migration.up(knex);

  const leadId = findColumn(columns, 'lead_id');
  expect(leadId).toBeDefined();
  expect(leadId.calls.some((c) => c.method === 'references')).toBe(false);
  expect(leadId.calls.some((c) => c.method === 'inTable')).toBe(false);
  expect(referencedTable(leadId)).toBeNull();
});

test('lead_id keeps its column and its index — only the FK was dropped', async () => {
  const { knex, columns, tableCalls } = fakeKnex();
  await migration.up(knex);

  expect(findColumn(columns, 'lead_id')).toBeDefined();
  const indexCalls = tableCalls.filter((c) => c.method === 'index');
  expect(indexCalls.some((c) => c.args[0].includes('lead_id') && c.args[1] === 'consultation_outcomes_lead_id_idx')).toBe(true);
});

// Companion regression guard, the OTHER direction: customer_id and
// scheduled_service_id are verified-safe (see the file comment) and must
// stay referencing FKs — this fails if a future edit strips them too,
// which was never asked for and would be a silent behavior change.
test('customer_id and scheduled_service_id keep their foreign keys — only lead_id was dropped', async () => {
  const { knex, columns } = fakeKnex();
  await migration.up(knex);

  const customerId = findColumn(columns, 'customer_id');
  expect(referencedTable(customerId)).toBe('customers');
  const scheduledServiceId = findColumn(columns, 'scheduled_service_id');
  expect(referencedTable(scheduledServiceId)).toBe('scheduled_services');
  const technicianId = findColumn(columns, 'technician_id');
  expect(referencedTable(technicianId)).toBe('technicians');
});

test('up() is a no-op when the table already exists (idempotent migration re-run)', async () => {
  const { knex, tableCalls } = fakeKnex();
  knex.schema.hasTable = async () => true;
  await migration.up(knex);
  expect(tableCalls).toEqual([]);
});
