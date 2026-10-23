// Bid Desk SAM.gov reader (GATE_BID_DESK_SAM) through PostgreSQL: the migration (down, up), filing a notice once, the
// cursor, the one notification per new bid and its retry. A fake fetch stands in for SAM.gov. Every write runs in a
// transaction that is rolled back. Synthetic notices only. Skips without DATABASE_URL (CI runs it).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(),
}));

const knex = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261022190000_bid_desk_sam_gov');
const owedMigration = require('../models/migrations/20261023010000_bid_desk_bid_owed_alerts');
const service = require('../services/bid-desk');
const sam = require('../services/bid-desk/sam-gov');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;

const NOW = new Date('2026-10-22T12:00:00Z');

function notice(id, overrides = {}) {
  return {
    noticeId: id,
    title: `Pest Control Services ${id}`,
    solicitationNumber: `SOL-${id}`,
    fullParentPathName: 'SAMPLE DEPARTMENT.SAMPLE OFFICE',
    type: 'Solicitation',
    active: 'Yes',
    responseDeadLine: '2026-11-05T14:00:00-05:00',
    placeOfPerformance: { city: { name: 'Sampleville' }, state: { code: 'FL' }, zip: '34200' },
    uiLink: `https://sam.gov/opp/${id}/view`,
    ...overrides,
  };
}

// A fake SAM.gov: the same notices for every NAICS code (the reader de-duplicates them by notice id).
function fakeFetch(notices) {
  return jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ totalRecords: notices.length, opportunitiesData: notices }) }));
}

describeDb('Bid Desk SAM.gov reader (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
    process.env.GATE_BID_DESK = 'true';
    process.env.GATE_BID_DESK_SAM = 'true';
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    raiseAdminAlert.mockReset();
    raiseAdminAlert.mockImplementation(async (_category, spec) => { composeAdminAlert(spec); return { id: randomUUID(), deduped: false }; });
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_BID_DESK;
    delete process.env.GATE_BID_DESK_SAM;
    if (database) await database.destroy();
  });

  const samBids = () => mockPg('bid_opportunities').where({ source: 'sam_gov' }).orderBy('created_at');
  const cursor = async () => JSON.parse((await mockPg('system_settings').where({ key: sam.CURSOR_KEY }).first('value')).value).from;

  test('the migrations are reversible and the old sources still pass the check', async () => {
    await owedMigration.down(mockPg);
    expect(await mockPg.schema.hasColumn('bid_opportunities', 'owed_alert_kind')).toBe(false);
    await migration.down(mockPg);
    expect(await mockPg.schema.hasColumn('bid_opportunities', 'external_id')).toBe(false);
    await expect(mockPg.transaction((t) => t('bid_opportunities').insert({ source: 'sam_gov' }))).rejects.toThrow(/source_check/);
    await migration.up(mockPg);
    await owedMigration.up(mockPg);
    expect(await mockPg.schema.hasColumn('bid_opportunities', 'external_url')).toBe(true);
    expect(await mockPg.schema.hasColumn('bid_opportunities', 'owed_alert_kind')).toBe(true);
    await mockPg('bid_opportunities').insert({ source: 'gov_email' });
  });

  test('a notice is filed once, rings once, and the cursor moves to yesterday', async () => {
    const fetchImpl = fakeFetch([notice('n-1'), notice('n-2', { placeOfPerformance: { state: { code: 'FL' }, zip: '32202' } })]);
    const first = await sam.runSamGovPoll({ now: NOW, fetchImpl, apiKey: 'test-key' });
    expect(first).toMatchObject({ read: 2, filed: 1, rung: 1, skippedByReason: { outside_area: 1 } });
    expect(fetchImpl).toHaveBeenCalledTimes(sam.NAICS_CODES.length);
    const [bid] = await samBids();
    expect(bid).toMatchObject({ external_id: 'n-1', external_url: 'https://sam.gov/opp/n-1/view', due_confirmed: false, status: 'new' });
    expect(bid.notified_at).not.toBeNull();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][2].dedupeKey).toBe(`bid-desk:new:${bid.id}`);
    expect(await cursor()).toBe('2026-10-21');

    const second = await sam.runSamGovPoll({ now: NOW, fetchImpl, apiKey: 'test-key' });
    expect(second).toMatchObject({ filed: 0, rung: 0, skippedByReason: { already_filed: 1 } });
    expect(await samBids()).toHaveLength(1);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a failed bell stays owed and the 15-minute sweep rings it; a decided bid never rings', async () => {
    raiseAdminAlert.mockRejectedValueOnce(new Error('bell down'));
    const first = await sam.runSamGovPoll({ now: NOW, fetchImpl: fakeFetch([notice('n-3'), notice('n-4')]), apiKey: 'test-key' });
    expect(first.filed).toBe(2);
    expect(first.rung).toBe(1);
    const owed = (await samBids()).find((b) => b.owed_alert_kind === 'new');
    expect(owed).toBeTruthy();
    expect(owed.notified_at).toBeNull();

    // The email intake's own sweep delivers it, not only the next daily SAM.gov run.
    expect(await service.deliverOwedAlerts()).toBe(1);
    const rung = await mockPg('bid_opportunities').where({ id: owed.id }).first();
    expect(rung.notified_at).not.toBeNull();
    expect(rung.owed_alert_kind).toBeNull();

    const other = (await samBids()).find((b) => b.id !== owed.id);
    await mockPg('bid_opportunities').where({ id: other.id }).update({ status: 'no_bid', owed_alert_kind: 'new', owed_alert_key: `bid-desk:new:${other.id}` });
    raiseAdminAlert.mockClear();
    expect(await service.deliverOwedAlerts()).toBe(0);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect((await mockPg('bid_opportunities').where({ id: other.id }).first()).owed_alert_kind).toBeNull();
  });

  test('a republished notice refreshes the bid: a new deadline replaces an unconfirmed date and rings an addendum', async () => {
    await sam.runSamGovPoll({ now: NOW, fetchImpl: fakeFetch([notice('n-6')]), apiKey: 'test-key' });
    raiseAdminAlert.mockClear();
    const moved = notice('n-6', { title: 'Pest Control Services n-6 (amended)', responseDeadLine: '2026-11-12T14:00:00-05:00' });
    const result = await sam.runSamGovPoll({ now: NOW, fetchImpl: fakeFetch([moved]), apiKey: 'test-key' });
    expect(result).toMatchObject({ filed: 0, refreshed: 1, rung: 1 });
    const [bid] = await samBids();
    expect(bid.project_title).toBe('Pest Control Services n-6 (amended)');
    expect(new Date(bid.due_at).toISOString()).toBe('2026-11-12T19:00:00.000Z');
    expect(bid.due_confirmed).toBe(false);
    expect(bid.needs_date_confirmation).toBe(true);
    expect(raiseAdminAlert.mock.calls[0][2].dedupeKey).toBe(`bid-desk:addendum:${bid.id}:sam:2026-11-12T19:00:00.000Z`);
    expect(raiseAdminAlert.mock.calls[0][1].why).toMatch(/^SAM\.gov posted a different deadline/);

    // The same version again changes nothing and rings nothing.
    raiseAdminAlert.mockClear();
    expect(await sam.runSamGovPoll({ now: NOW, fetchImpl: fakeFetch([moved]), apiKey: 'test-key' })).toMatchObject({ refreshed: 0, rung: 0 });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a confirmed date is never overwritten by a republished deadline; the bid is flagged instead', async () => {
    await sam.runSamGovPoll({ now: NOW, fetchImpl: fakeFetch([notice('n-7')]), apiKey: 'test-key' });
    const [filed] = await samBids();
    await mockPg('bid_opportunities').where({ id: filed.id }).update({ due_confirmed: true, status: 'bid' });
    await sam.runSamGovPoll({ now: NOW, fetchImpl: fakeFetch([notice('n-7', { responseDeadLine: '2026-11-20T14:00:00-05:00' })]), apiKey: 'test-key' });
    const bid = await mockPg('bid_opportunities').where({ id: filed.id }).first();
    expect(new Date(bid.due_at).toISOString()).toBe('2026-11-05T19:00:00.000Z');
    expect(bid.due_confirmed).toBe(true);
    expect(bid.needs_date_confirmation).toBe(true);
    expect(bid.due_source_line).toBe('SAM.gov response deadline: 2026-11-20T14:00:00-05:00');
  });

  test('a cursor older than a year is clamped to the API window', async () => {
    await mockPg('system_settings').insert({ key: sam.CURSOR_KEY, value: JSON.stringify({ from: '2024-01-01' }), category: 'bid_desk' });
    const fetchImpl = fakeFetch([]);
    await sam.runSamGovPoll({ now: NOW, fetchImpl, apiKey: 'test-key' });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('postedFrom')).toBe('10/23/2025');
    expect(await cursor()).toBe('2026-10-21');
  });

  test('a no-data answer (HTTP 404) for one code is an empty result; the other code still files', async () => {
    const fetchImpl = jest.fn(async (url) => (new URL(url).searchParams.get('ncode') === sam.NAICS_CODES[0]
      ? { ok: true, status: 200, json: async () => ({ totalRecords: 1, opportunitiesData: [notice('n-5')] }) }
      : { ok: false, status: 404, json: async () => ({ error: 'No Data found' }) }));
    const result = await sam.runSamGovPoll({ now: NOW, fetchImpl, apiKey: 'test-key' });
    expect(result).toMatchObject({ read: 1, filed: 1, rung: 1 });
    expect(await cursor()).toBe('2026-10-21');
  });

  test('an API error leaves the cursor and files nothing', async () => {
    await mockPg('system_settings').insert({ key: sam.CURSOR_KEY, value: JSON.stringify({ from: '2026-10-10' }), category: 'bid_desk' });
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(sam.runSamGovPoll({ now: NOW, fetchImpl, apiKey: 'test-key' })).rejects.toThrow('HTTP 503');
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get('postedFrom')).toBe('10/10/2026');
    expect(url.searchParams.get('postedTo')).toBe('10/22/2026');
    expect(await cursor()).toBe('2026-10-10');
    expect(await samBids()).toHaveLength(0);
  });
});
