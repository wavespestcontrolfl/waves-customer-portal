// customer_dunning_schedules (dunning consolidation PR 1): the table and its
// two unique guards, proven on a real PostgreSQL in a disposable schema
// (skipped without APP_TEST_DATABASE_URL, run for real in CI).
//
//   UNIQUE (customer_id, episode)                  one row per episode
//   UNIQUE (customer_id) WHERE status IN (open)    at most ONE open episode —
//                                                  this index IS the ownership
//                                                  predicate the engine reads
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20260930010000_customer_dunning_schedules');
const { inReadOnlyTransaction } = require('../scripts/dunning-customer-schedule-dry-run');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `customer_dunning_${randomUUID().replaceAll('-', '')}`;
const TABLE = 'customer_dunning_schedules';

const uniqueViolation = async (promise) => {
  await expect(promise).rejects.toMatchObject({ code: '23505' });
};

postgres('customer_dunning_schedules (PostgreSQL)', () => {
  let admin;
  let app;
  const alice = randomUUID();
  const bob = randomUUID();

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await app.schema.createTable('customers', (t) => { t.uuid('id').primary(); });
    await app('customers').insert([{ id: alice }, { id: bob }]);
    await migration.up(app);
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  const row = (customerId, episode, status, extra = {}) => ({ customer_id: customerId, episode, status, ...extra });

  test('defaults: uuid id, step 0, zero touches, empty snapshot, timestamps', async () => {
    const [inserted] = await app(TABLE).insert(row(bob, 1, 'completed')).returning('*');
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted).toMatchObject({ step_index: 0, touches_sent: 0, next_touch_at: null, touch_claimed_at: null, link_digest: null });
    expect(inserted.seeded_from).toEqual([]);
    expect(inserted.created_at).toBeInstanceOf(Date);
    expect(inserted.updated_at).toBeInstanceOf(Date);
    await app(TABLE).where({ customer_id: bob }).del();
  });

  test('a customer has at most ONE open episode, whichever open status it holds', async () => {
    await app(TABLE).insert(row(alice, 1, 'active'));
    await uniqueViolation(app(TABLE).insert(row(alice, 2, 'active')));
    await uniqueViolation(app(TABLE).insert(row(alice, 2, 'held')));
    await uniqueViolation(app(TABLE).insert(row(alice, 2, 'paused')));
    await uniqueViolation(app(TABLE).insert(row(alice, 2, 'autopay_hold')));
    // ...and a different customer is unaffected.
    await app(TABLE).insert(row(bob, 1, 'active'));
  });

  test('a closed episode frees the customer for the next one', async () => {
    await app(TABLE).where({ customer_id: alice }).update({ status: 'completed', closed_reason: 'final_notice_delivered', closed_at: app.fn.now() });
    await app(TABLE).insert(row(alice, 2, 'active'));
    await app(TABLE).where({ customer_id: alice, episode: 2 }).update({ status: 'released', closed_reason: 'released_gate_off' });
    await app(TABLE).insert(row(alice, 3, 'held'));
    const open = await app(TABLE).where({ customer_id: alice }).whereIn('status', ['active', 'held', 'paused', 'autopay_hold']);
    expect(open).toHaveLength(1);
  });

  test('an episode number is used once per customer, closed or not', async () => {
    await uniqueViolation(app(TABLE).insert(row(alice, 1, 'completed')));
  });

  test('the partial index is the open-status predicate (and a due-scan index exists)', async () => {
    const { rows } = await app.raw(
      'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ? AND tablename = ?', [schema, TABLE],
    );
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.customer_dunning_schedules_open_uniq).toMatch(/UNIQUE INDEX .*\(customer_id\)/);
    for (const status of ['active', 'held', 'paused', 'autopay_hold']) {
      expect(byName.customer_dunning_schedules_open_uniq).toContain(`'${status}'`);
    }
    expect(byName.customer_dunning_schedules_open_uniq).not.toContain("'completed'");
    expect(byName.customer_dunning_schedules_status_next_touch_idx).toMatch(/\(status, next_touch_at\)/);
  });

  test('deleting the customer deletes its schedules', async () => {
    await app('customers').where({ id: bob }).del();
    expect(await app(TABLE).where({ customer_id: bob })).toHaveLength(0);
  });

  test('the dry-run script\'s READ ONLY transaction makes Postgres itself refuse any write, and rolls back', async () => {
    const before = (await app(TABLE).count('* as n').first()).n;
    await expect(inReadOnlyTransaction(app, (trx) => trx(TABLE).insert(row(alice, 99, 'completed'))))
      .rejects.toMatchObject({ code: '25006' }); // read_only_sql_transaction
    // reads work inside it, and nothing was ever committed
    const seen = await inReadOnlyTransaction(app, (trx) => trx(TABLE).count('* as n').first());
    expect(seen.n).toBe(before);
    expect((await app(TABLE).count('* as n').first()).n).toBe(before);
  });

  test('up is idempotent and down removes the table and its index', async () => {
    await migration.up(app);
    await migration.down(app);
    expect(await app.schema.hasTable(TABLE)).toBe(false);
    await migration.down(app);
    await migration.up(app);
    expect(await app.schema.hasTable(TABLE)).toBe(true);
  });
});
