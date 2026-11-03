// Migration 20261102230000_current_customer_quote_text (GATE_CURRENT_CUSTOMER_QUOTE_TEXT, owner
// 2026-11-02 "text and bell"): the once-a-day claim table and the admin-editable text. The claim
// SQL itself runs against real Postgres in lead-call-text-followup-postgres / -scheduler-postgres
// (they read the table) and was replayed by hand on a migrated copy before the first push.
const mockRecordAuditEvent = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const migration = require('../models/migrations/20261102230000_current_customer_quote_text');

beforeEach(() => mockRecordAuditEvent.mockClear());

function makeKnex({ hasClaimTable = false, hasTemplates = true, hasAuditLog = true, existingTemplate = null } = {}) {
  const calls = { created: null, columns: [], inserted: null, conflictOn: null, dropped: [] };
  const column = (name, type, args) => {
    const col = { name, type, args, primary: false, notNull: false, default: undefined };
    calls.columns.push(col);
    const chain = {
      primary: () => { col.primary = true; return chain; },
      notNullable: () => { col.notNull = true; return chain; },
      defaultTo: (v) => { col.default = v; return chain; },
    };
    return chain;
  };
  calls.indexes = [];
  // insert(...).onConflict('template_key').ignore().returning('id'): a row already there inserts nothing.
  const query = {
    insert: jest.fn((row) => {
      calls.inserted = row;
      const chain = {
        onConflict: (col) => { calls.conflictOn = col; return chain; },
        ignore: () => chain,
        returning: async () => (existingTemplate ? [] : [{ id: 't-new' }]),
      };
      return chain;
    }),
    del: jest.fn(async () => 1),
  };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    return query;
  });
  knex.fn = { now: () => 'NOW()' };
  knex.raw = (sql) => `RAW(${sql})`;
  knex.schema = {
    hasTable: jest.fn(async (t) => ({ current_customer_quote_texts: hasClaimTable, audit_log: hasAuditLog }[t] ?? hasTemplates)),
    createTable: jest.fn(async (t, build) => {
      calls.created = t;
      build({
        string: (n, len) => column(n, 'string', [len]),
        uuid: (n) => column(n, 'uuid', []),
        timestamp: (n, opts) => column(n, 'timestamp', [opts]),
        index: (cols) => { calls.indexes.push(cols); },
      });
    }),
    dropTableIfExists: jest.fn(async (t) => { calls.dropped.push(t); }),
  };
  return { knex, query, calls };
}

test('creates the claim table: one row per send attempt, read by phone and time', async () => {
  const { knex, calls } = makeKnex();
  await migration.up(knex);
  expect(calls.created).toBe('current_customer_quote_texts');
  expect(calls.columns).toEqual([
    expect.objectContaining({ name: 'id', type: 'uuid', primary: true, default: 'RAW(gen_random_uuid())' }),
    expect.objectContaining({ name: 'phone_digits', type: 'string', args: [10], primary: false, notNull: true }),
    expect.objectContaining({ name: 'customer_id', type: 'uuid' }),
    expect.objectContaining({ name: 'twilio_sid', type: 'string', args: [64] }),
    expect.objectContaining({ name: 'claimed_at', type: 'timestamp', args: [{ useTz: true }], notNull: true, default: 'NOW()' }),
  ]);
  expect(calls.indexes).toEqual([['phone_digits', 'claimed_at']]);
});

test('seeds the text active, in the leads category: the lead text\'s words without the STOP line', async () => {
  const { knex, calls } = makeKnex();
  await migration.up(knex);
  expect(calls.conflictOn).toBe('template_key');
  expect(calls.inserted).toEqual({
    template_key: 'current_customer_quote_text',
    name: 'Quote Form Reply (Current Customer)',
    category: 'leads',
    body: "Hello {first_name}, Waves here. We got your quote request. Reply CALL and we'll call you shortly, or TEXT to handle it right here.",
    variables: JSON.stringify(['first_name']),
    sort_order: 22,
    is_active: true,
  });
  // A customer, not a cold first touch (docs/sms-stop-line-policy.md, test 2).
  expect(calls.inserted.body).not.toMatch(/STOP/);
  // The CALL ring and the follow-ups find our text by these words.
  expect(calls.inserted.body).toMatch(/Reply CALL/);
  // The seed records itself (waves-db §4), in the migration's own transaction.
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
  expect(mockRecordAuditEvent).toHaveBeenCalledWith({
    actor_type: 'system', action: 'sms_template.seeded', resource_type: 'sms_template', resource_id: 't-new',
    metadata: { templateKey: 'current_customer_quote_text', migration: '20261102230000_current_customer_quote_text' },
    trx: knex, critical: true,
  });
});

test('no audit_log table: the text is still seeded, with no audit event', async () => {
  const { knex, calls } = makeKnex({ hasAuditLog: false });
  await migration.up(knex);
  expect(calls.inserted).toMatchObject({ template_key: 'current_customer_quote_text' });
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('is idempotent: an existing table and an existing (possibly edited) row are left alone', async () => {
  const { knex } = makeKnex({ hasClaimTable: true, existingTemplate: { id: 't-1' } });
  await migration.up(knex);
  expect(knex.schema.createTable).not.toHaveBeenCalled();
  // ON CONFLICT DO NOTHING: the row is never overwritten, and nothing new is recorded.
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('no sms_templates table: creates the claim table only', async () => {
  const { knex, calls } = makeKnex({ hasTemplates: false });
  await migration.up(knex);
  expect(calls.created).toBe('current_customer_quote_texts');
  expect(knex).not.toHaveBeenCalled();
});

test('down() drops the claim table and never deletes the admin-editable text', async () => {
  const { knex, query, calls } = makeKnex({ hasClaimTable: true, existingTemplate: { id: 't-1' } });
  await migration.down(knex);
  expect(calls.dropped).toEqual(['current_customer_quote_texts']);
  expect(query.del).not.toHaveBeenCalled();
});
