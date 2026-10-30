// Real migrated PostgreSQL, rolled back after every test: the kept EPA label check (owner 2026-10-30, 7 days) writes
// its answer to system_settings, and a retried older answer never replaces a newer one another process stored
// (pre-push audit P1).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => ({}));
jest.mock('../services/epa-product-label', () => ({ checkEpaSource: jest.fn() }));
const { checkEpaSource } = require('../services/epa-product-label');
const { keptEpaSourceStatus, _test } = require('../services/epa-label-check-keep');

postgres('kept EPA label check against migrated PostgreSQL', () => {
  let database;
  let trx;
  let clock;
  let now;
  const source = { registration: '123-456', filename: '000123-00456-20400101.pdf', sha256: 'f'.repeat(64) };
  const stored = async () => JSON.parse((await trx('system_settings').where({ key: _test.keyOf(source) }).first()).value);
  // EPA answers in order, each given at the moment of the call; then no answer.
  const answers = (...statuses) => checkEpaSource.mockImplementation(async () => ({ status: statuses.shift() || 'unavailable', checkedAt: Date.now() }));

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
    _test.seen.clear();
    checkEpaSource.mockReset();
    now = Date.parse('2040-01-01T12:00:00Z');
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(async () => {
    clock.mockRestore();
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  test('an answer is stored, a newer one replaces it, and an outage after a deploy reads it back', async () => {
    answers('current', 'inactive');
    expect(await keptEpaSourceStatus(source, { dbh: trx })).toBe('current');
    expect(await stored()).toMatchObject({ status: 'current', checkedAt: '2040-01-01T12:00:00.000Z' });
    now += 60000;
    expect(await keptEpaSourceStatus(source, { dbh: trx })).toBe('inactive');
    expect(await stored()).toMatchObject({ status: 'inactive', checkedAt: '2040-01-01T12:01:00.000Z' });
    _test.seen.clear();
    expect(await keptEpaSourceStatus(source, { dbh: trx })).toBe('inactive');
  });

  test('a retried older answer from another process never replaces a newer stored one', async () => {
    // Process B stored 'inactive' at 12:05.
    now = Date.parse('2040-01-01T12:05:00Z');
    answers('inactive');
    await keptEpaSourceStatus(source, { dbh: trx });
    // Process A got 'current' at 12:00 but could not save it; it retries during an outage at 12:10.
    _test.seen.clear();
    _test.seen.set(_test.keyOf(source), { status: 'current', at: Date.parse('2040-01-01T12:00:00Z'), savedAt: null });
    now = Date.parse('2040-01-01T12:10:00Z');
    expect(await keptEpaSourceStatus(source, { dbh: trx })).toBe('inactive');
    expect(await stored()).toMatchObject({ status: 'inactive', checkedAt: '2040-01-01T12:05:00.000Z' });
  });
});
