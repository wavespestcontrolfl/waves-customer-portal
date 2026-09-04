const migration = require('../models/migrations/20260901000090_autopay_setup_link_requests');

function buildKnex({ hasColumns = {}, hasTables = {} } = {}) {
  const state = { raw: [], upserted: [], deleted: [], alteredTables: [], delWhere: [] };
  const knex = jest.fn((table) => {
    const query = {
      insert: jest.fn((row) => { query.__inserted = row; return query; }),
      onConflict: jest.fn((col) => { expect(col).toBe('template_key'); return query; }),
      merge: jest.fn(async (row) => { state.upserted.push({ table, ...query.__inserted, ...row }); }),
      where: jest.fn((criteria) => { query.__where = criteria; return query; }),
      del: jest.fn(async () => { state.deleted.push({ table, where: query.__where }); return 1; }),
    };
    return query;
  });
  knex.raw = jest.fn(async (sql) => { state.raw.push(sql.replace(/\s+/g, ' ').trim()); });
  knex.fn = { now: jest.fn(() => 'NOW') };
  knex.schema = {
    hasTable: jest.fn(async (t) => (t in hasTables ? hasTables[t] : true)),
    hasColumn: jest.fn(async (_t, c) => (c in hasColumns ? hasColumns[c] : false)),
    alterTable: jest.fn(async (t, cb) => {
      const cols = [];
      cb({
        string: (name) => { cols.push(name); return { notNullable: () => ({ defaultTo: () => {} }) }; },
        timestamp: (name) => { cols.push(name); },
        dropColumn: (name) => { cols.push(`-${name}`); },
      });
      state.alteredTables.push({ table: t, cols });
    }),
  };
  return { knex, state };
}

describe('autopay setup link migration (standalone mode of appointment_card_requests)', () => {
  test('up: nullable visit, kind + expires_at, partial unique on pending standalone rows, template seeded INACTIVE', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);

    expect(state.raw[0]).toBe('ALTER TABLE appointment_card_requests ALTER COLUMN scheduled_service_id DROP NOT NULL');
    expect(state.alteredTables).toEqual([
      { table: 'appointment_card_requests', cols: ['kind'] },
      { table: 'appointment_card_requests', cols: ['expires_at'] },
    ]);
    expect(state.raw[1]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_appt_card_requests_customer_pending_standalone');
    expect(state.raw[1]).toContain("WHERE kind = 'customer' AND status IN ('pending', 'completing')");

    const row = state.upserted.find((r) => r.template_key === 'autopay_setup_link');
    expect(row).toBeTruthy();
    expect(row.is_active).toBe(false);
    expect(JSON.parse(row.variables)).toEqual(['first_name', 'secure_link']);
    expect(row.body).toContain('{secure_link}');
    expect(row.body).toContain('Nothing is charged today');
    expect(row.body).toContain('We never take card numbers by phone');
    expect(row.body).toMatch(/Reply STOP to opt out\.$/);
    expect(row.body).not.toMatch(/[—’“”]/);
  });

  test('up is idempotent on the columns (raw statements are IF NOT EXISTS / DROP NOT NULL)', async () => {
    const { knex, state } = buildKnex({ hasColumns: { kind: true, expires_at: true } });
    await migration.up(knex);
    expect(state.alteredTables).toEqual([]);
    expect(state.upserted).toHaveLength(1);
  });

  test('up no-ops without the table', async () => {
    const { knex, state } = buildKnex({ hasTables: { appointment_card_requests: false } });
    await migration.up(knex);
    expect(state.raw).toEqual([]);
    expect(state.upserted).toEqual([]);
  });

  test('down: removes the template, index, standalone rows and columns, then restores NOT NULL', async () => {
    const { knex, state } = buildKnex({ hasColumns: { kind: true, expires_at: true } });
    await migration.down(knex);
    expect(state.deleted).toEqual([
      { table: 'sms_templates', where: { template_key: 'autopay_setup_link' } },
      { table: 'appointment_card_requests', where: { kind: 'customer' } },
    ]);
    expect(state.raw[0]).toContain('DROP INDEX IF EXISTS uq_appt_card_requests_customer_pending_standalone');
    expect(state.alteredTables).toEqual([
      { table: 'appointment_card_requests', cols: ['-kind'] },
      { table: 'appointment_card_requests', cols: ['-expires_at'] },
    ]);
    expect(state.raw[state.raw.length - 1]).toBe('ALTER TABLE appointment_card_requests ALTER COLUMN scheduled_service_id SET NOT NULL');
  });
});

describe('autopay setup link template — lane-neutral reword (20260903000040)', () => {
  const reword = require('../models/migrations/20260903000040_autopay_setup_link_template_lane_neutral');
  function updateKnex() {
    const state = { updates: [] };
    const knex = jest.fn((table) => {
      const q = {
        where: jest.fn((criteria) => { q.__where = criteria; return q; }),
        update: jest.fn(async (payload) => { state.updates.push({ table, where: q.__where, payload }); return 1; }),
      };
      return q;
    });
    knex.schema = { hasTable: jest.fn(async () => true) };
    return { knex, state };
  }

  test('up rewords ONLY the still-seeded body (an owner edit is never clobbered) and drops the visit-as-unit wording', async () => {
    const { knex, state } = updateKnex();
    await reword.up(knex);
    expect(state.updates).toHaveLength(1);
    const [u] = state.updates;
    expect(u.table).toBe('sms_templates');
    expect(u.where.template_key).toBe('autopay_setup_link');
    expect(u.where.body).toContain('each visit is paid automatically');
    expect(u.payload.body).toContain('each completed service is paid automatically');
    expect(u.payload.body).not.toMatch(/visit/);
    expect(u.payload.body).toContain('{secure_link}');
  });

  test('down restores the seeded body only where the neutral one still stands', async () => {
    const { knex, state } = updateKnex();
    await reword.down(knex);
    const [u] = state.updates;
    expect(u.where.body).toContain('each completed service');
    expect(u.payload.body).toContain('each visit is paid automatically');
  });
});
