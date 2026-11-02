// Runs with the existing CI PostgreSQL pass; never a production connection.
// Pins the real claim SQL of the store rating pop-up (GATE_APP_RATING_PROMPT):
// a finished visit is required, one ask per mode per 120 days, shadow rows
// never block a live ask, and the migration's CHECKs hold.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

let mockPg;
jest.mock('../models/db', () => ({ raw: (...a) => mockPg.raw(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const migration = require('../models/migrations/20261102060000_app_rating_asks');
const { claimAppRatingAsk, SPACING_DAYS } = require('../services/app-rating-prompt');

(SKIP ? describe.skip : describe)('app_rating_asks PostgreSQL contracts', () => {
  const schema = `app_rating_${randomUUID().replaceAll('-', '')}`;
  const savedGate = process.env.GATE_APP_RATING_PROMPT;
  let admin;

  async function customer({ visit = 'completed' } = {}) {
    const id = randomUUID();
    await mockPg('customers').insert({ id });
    if (visit) await mockPg('scheduled_services').insert({ id: randomUUID(), customer_id: id, status: visit });
    return id;
  }
  const rows = (customerId) => mockPg('app_rating_asks').where({ customer_id: customerId }).orderBy('created_at');
  const ageRows = (customerId, days) => mockPg.raw(
    "UPDATE app_rating_asks SET created_at = now() - (?::int * interval '1 day') WHERE customer_id = ?::uuid",
    [days, customerId],
  );

  beforeAll(async () => {
    admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    mockPg = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await mockPg.schema.createTable('customers', (t) => { t.uuid('id').primary(); });
    await mockPg.schema.createTable('scheduled_services', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id').notNullable();
      t.string('status', 20).notNullable();
    });
    await migration.up(mockPg);
  });

  beforeEach(() => { process.env.GATE_APP_RATING_PROMPT = 'true'; });

  afterAll(async () => {
    if (savedGate === undefined) delete process.env.GATE_APP_RATING_PROMPT; else process.env.GATE_APP_RATING_PROMPT = savedGate;
    if (mockPg) await mockPg.destroy();
    if (admin) {
      await admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await admin.destroy();
    }
  });

  test('the migration is re-runnable, its CHECKs refuse other platforms and modes, and it rolls back', async () => {
    await migration.up(mockPg);
    const id = await customer();
    await expect(mockPg('app_rating_asks').insert({ customer_id: id, platform: 'web', mode: 'on' })).rejects.toThrow(/app_rating_asks_platform_check/);
    await expect(mockPg('app_rating_asks').insert({ customer_id: id, platform: 'ios', mode: 'true' })).rejects.toThrow(/app_rating_asks_mode_check/);
    await migration.down(mockPg);
    expect(await mockPg.schema.hasTable('app_rating_asks')).toBe(false);
    await migration.up(mockPg);
    expect(await mockPg.schema.hasTable('app_rating_asks')).toBe(true);
  });

  test('on: a customer with a finished visit is asked once, then not again inside the window', async () => {
    const id = await customer();
    expect(await claimAppRatingAsk({ customerId: id, platform: 'ios' })).toEqual({ ask: true, mode: 'on' });
    expect(await claimAppRatingAsk({ customerId: id, platform: 'android' })).toEqual({ ask: false, mode: 'on' });
    const written = await rows(id);
    expect(written.map((r) => [r.platform, r.mode])).toEqual([['ios', 'on']]);
  });

  test.each([['pending'], ['cancelled'], [null]])('on: no finished visit (%p) means no ask and no row', async (visit) => {
    const id = await customer({ visit });
    expect(await claimAppRatingAsk({ customerId: id, platform: 'ios' })).toEqual({ ask: false, mode: 'on' });
    expect(await rows(id)).toHaveLength(0);
  });

  test(`the window is ${SPACING_DAYS} days: an older ask allows a new one, a newer one does not`, async () => {
    const id = await customer();
    expect((await claimAppRatingAsk({ customerId: id, platform: 'ios' })).ask).toBe(true);
    await ageRows(id, SPACING_DAYS - 1);
    expect((await claimAppRatingAsk({ customerId: id, platform: 'ios' })).ask).toBe(false);
    await ageRows(id, SPACING_DAYS + 1);
    expect((await claimAppRatingAsk({ customerId: id, platform: 'ios' })).ask).toBe(true);
    expect(await rows(id)).toHaveLength(2);
  });

  test('shadow records one would-ask row per window and never blocks the first live ask', async () => {
    const id = await customer();
    process.env.GATE_APP_RATING_PROMPT = 'shadow';
    expect(await claimAppRatingAsk({ customerId: id, platform: 'android' })).toEqual({ ask: false, mode: 'shadow' });
    expect(await claimAppRatingAsk({ customerId: id, platform: 'android' })).toEqual({ ask: false, mode: 'shadow' });
    process.env.GATE_APP_RATING_PROMPT = 'true';
    expect(await claimAppRatingAsk({ customerId: id, platform: 'android' })).toEqual({ ask: true, mode: 'on' });
    expect((await rows(id)).map((r) => r.mode)).toEqual(['shadow', 'on']);
  });

  test('off writes nothing', async () => {
    const id = await customer();
    delete process.env.GATE_APP_RATING_PROMPT;
    expect(await claimAppRatingAsk({ customerId: id, platform: 'ios' })).toEqual({ ask: false, mode: 'off' });
    expect(await rows(id)).toHaveLength(0);
  });

  test('a deleted customer row takes its asks with it', async () => {
    const id = await customer();
    expect((await claimAppRatingAsk({ customerId: id, platform: 'ios' })).ask).toBe(true);
    await mockPg('scheduled_services').where({ customer_id: id }).del();
    await mockPg('customers').where({ id }).del();
    expect(await rows(id)).toHaveLength(0);
  });
});
