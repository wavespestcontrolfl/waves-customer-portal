/**
 * Real migrated PostgreSQL, synthetic records, rolled back after every test.
 *
 * availability.js's candidate-identity resolution (getAvailableSlots'
 * candidateServiceType, confirmBooking's serviceType) selects columns off
 * `estimates`. A prior version selected `services`/`service_type` — NEITHER
 * of which exists on the real table (it has `service_interest`, a free-text
 * summary column) — so Postgres threw "column does not exist", caught by
 * getAvailableSlots' own try/catch, which silently nulled the ENTIRE
 * travel-gap mirror for every estimate-linked call (Codex r4 P1). Every
 * other test in this suite mocks `db('estimates')`, so a mock fixture happily
 * returns whatever shape the test hands it regardless of the real schema —
 * this file is the one guard that would have caught the nonexistent column
 * against the actual migrated table.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('availability.js estimate-identity columns against migrated PostgreSQL', () => {
  let database;
  let trx;
  let estimateId;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    estimateId = randomUUID();
    await trx('estimates').insert({
      id: estimateId, status: 'sent', service_interest: 'Quarterly Pest Control',
    });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  test('the real columns availability.js now selects (customer_id, service_interest) resolve cleanly', async () => {
    const row = await trx('estimates').where('id', estimateId).first('customer_id', 'service_interest');
    expect(row.service_interest).toBe('Quarterly Pest Control');
    expect(row.customer_id).toBeNull();
  });

  test('the columns the prior (buggy) code selected — services, service_type — do not exist and throw', async () => {
    await expect(
      trx('estimates').where('id', estimateId).first('customer_id', 'services', 'service_type'),
    ).rejects.toThrow(/column .* does not exist/i);
  });
});
