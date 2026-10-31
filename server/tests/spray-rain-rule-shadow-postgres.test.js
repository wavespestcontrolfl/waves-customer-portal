// Real migrated PostgreSQL, synthetic records, rolled back after every test: the GATE_SPRAY_RAIN_RULES=shadow
// record keeps the worst read of a visit day, with that read's start time and service (Codex P2 on #6797).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => ({}));
const { randomUUID } = require('node:crypto');
const { recordSprayRainShadow } = require('../services/spray-rain-rule-shadow');

postgres('spray rain rule shadow record against migrated PostgreSQL', () => {
  let database;
  let trx;
  let serviceId;

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
    const customerId = randomUUID();
    serviceId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}` });
    await trx('scheduled_services').insert({ id: serviceId, customer_id: customerId, scheduled_date: '2040-09-04', service_type: 'Quarterly Pest Control', status: 'confirmed' });
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const read = (verdict, startIso, { liveHold = false, serviceType = 'Quarterly Pest Control' } = {}) => recordSprayRainShadow({
    dbh: trx,
    facts: { serviceId, scheduledDate: '2040-09-04', serviceType },
    products: [{ id: 'p1', name: 'Synthetic Spray' }],
    hourly: [],
    serviceInstant: new Date(startIso),
    live: { hold: liveHold, issue: null },
    shadow: { verdicts: [{ productId: 'p1', verdict, reason: `${verdict} read` }], issue: null },
  });
  const row = () => trx('spray_rain_rule_shadow').where({ scheduled_service_id: serviceId }).first();
  const startOf = async () => new Date((await row()).start_at).toISOString();

  test('a read that is not worse keeps the peak read\'s start and service; a worse read moves them', async () => {
    await read('caution', '2040-09-04T18:00:00Z');
    // Inside 10 minutes and not worse: not written.
    await read('caution', '2040-09-04T19:00:00Z', { serviceType: 'Renamed Pest Service' });
    expect(await row()).toMatchObject({ shadow_status: 'caution', reads: 1, service_type: 'Quarterly Pest Control' });
    expect(await startOf()).toBe('2040-09-04T18:00:00.000Z');
    // The 10-minute refresh counts the read; the peak columns stay those of the 2 pm read.
    await trx('spray_rain_rule_shadow').where({ scheduled_service_id: serviceId }).update({ last_seen_at: trx.raw("now() - interval '11 minutes'") });
    await read('ok', '2040-09-04T19:30:00Z', { serviceType: 'Renamed Pest Service' });
    expect(await row()).toMatchObject({ shadow_status: 'caution', reads: 2, service_type: 'Quarterly Pest Control' });
    expect(await startOf()).toBe('2040-09-04T18:00:00.000Z');
    // A worse read moves every peak column together, its start included.
    await read('hold', '2040-09-04T20:00:00Z');
    expect(await row()).toMatchObject({ shadow_status: 'hold', reads: 3, dose_hidden: true,
      products: [{ name: 'Synthetic Spray', verdict: 'hold', reason: 'hold read', source: null }] });
    expect(await startOf()).toBe('2040-09-04T20:00:00.000Z');
  });

  test('a Warning read replaces an earlier caution peak, and a plain caution does not replace a Warning (step 2)', async () => {
    const warning = (startIso) => recordSprayRainShadow({
      dbh: trx,
      facts: { serviceId, scheduledDate: '2040-09-04', serviceType: 'Quarterly Pest Control' },
      products: [{ id: 'p1', name: 'Synthetic Spray' }],
      hourly: [],
      serviceInstant: new Date(startIso),
      live: { hold: false, issue: null },
      shadow: { verdicts: [{ productId: 'p1', verdict: 'caution', level: 'warning', reason: 'warning read' }], issue: null },
    });
    await read('caution', '2040-09-04T18:00:00Z');
    await warning('2040-09-04T19:00:00Z');
    expect(await row()).toMatchObject({ shadow_status: 'caution', reads: 2, dose_hidden: false,
      products: [{ name: 'Synthetic Spray', verdict: 'caution', level: 'warning', reason: 'warning read', source: null }] });
    expect(await startOf()).toBe('2040-09-04T19:00:00.000Z');
    // Not worse and inside 10 minutes: not written, the Warning stays the peak.
    await read('caution', '2040-09-04T19:30:00Z');
    expect(await row()).toMatchObject({ reads: 2, products: [expect.objectContaining({ level: 'warning' })] });
  });

  test('a new live hold is kept inside the 10 minutes, without moving the peak', async () => {
    await read('caution', '2040-09-04T18:00:00Z');
    await read('ok', '2040-09-04T18:30:00Z', { liveHold: true });
    expect(await row()).toMatchObject({ live_hold: true, shadow_status: 'caution', reads: 2 });
    expect(await startOf()).toBe('2040-09-04T18:00:00.000Z');
  });
});
