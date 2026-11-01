// CI's DB-gated pass runs this against PostgreSQL: the nightly lead repeat
// sweep end to end (services/lead-repeat-sweep.js). It covers the shared
// waiting queue, the last-10-digits phone match, the walk through an existing
// duplicate marker, and the row-locked filing with its jsonb marker merge and
// history row. Fixture tables live in a unique schema dropped after the suite;
// the funnel bridge is mocked (its own suites cover it).
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  leadRepeatSweepLive: jest.fn(() => true),
}));
jest.mock('../services/lead-funnel-bridge', () => ({
  ...jest.requireActual('../services/lead-funnel-bridge'),
  bridgeLeadFunnelStage: jest.fn(async () => ({ updated: 0 })),
}));

const { bridgeLeadFunnelStage } = require('../services/lead-funnel-bridge');
const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
const { runLeadRepeatSweep, fileRepeat, _test } = require('../services/lead-repeat-sweep');

const OCT = (day, time = '14:00') => new Date(`2026-10-${String(day).padStart(2, '0')}T${time}:00Z`);

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('lead repeat sweep on PostgreSQL', () => {
  let database;
  const schema = `lead_repeat_${randomUUID().replaceAll('-', '')}`;
  const tables = ['leads', 'lead_activities'];
  const customerA = randomUUID();

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    // CREATE TABLE ... AS copies columns only: restore what the history row relies on.
    await database.raw(`ALTER TABLE "${schema}".lead_activities ALTER COLUMN created_at SET DEFAULT now()`);
    mockConn = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  async function lead(fields = {}) {
    const firstContact = fields.first_contact_at || OCT(27, '14:22');
    const row = {
      id: randomUUID(),
      status: 'new',
      lead_type: 'quote_wizard',
      first_name: 'Pat',
      last_name: 'Sample',
      phone: '+19415550100',
      address: '12 Sample Ct, Parrish, FL 34219',
      city: 'Parrish',
      zip: '34219',
      customer_id: customerA,
      first_contact_at: firstContact,
      created_at: firstContact,
      updated_at: firstContact,
      ...fields,
    };
    if (row.extracted_data !== undefined && row.extracted_data !== null) row.extracted_data = JSON.stringify(row.extracted_data);
    await database('leads').insert(row);
    return row;
  }
  const read = (id) => database('leads').where({ id }).first();
  const markerOf = async (id) => (await read(id)).extracted_data?.duplicate_of_lead_id || null;

  test('files each quote-wizard rerun as a duplicate of the person\'s first open lead; the root stays waiting', async () => {
    const root = await lead({ lead_type: 'form', first_contact_at: OCT(27, '14:22') });
    const r1 = await lead({ first_contact_at: OCT(30, '14:25'), phone: '(941) 555-0100', extracted_data: { timeline: 'asap' } });
    const r2 = await lead({ first_contact_at: OCT(30, '14:37'), phone: '941.555.0100' });
    const r3 = await lead({ first_contact_at: OCT(30, '14:38'), first_name: 'pat', last_name: '' });

    const result = await runLeadRepeatSweep({ dbi: database });

    expect(result.filed).toBe(3);
    expect(result.filings).toEqual([
      { leadId: r1.id, rootId: root.id },
      { leadId: r2.id, rootId: root.id },
      { leadId: r3.id, rootId: root.id },
    ]);
    for (const repeat of [r1, r2, r3]) {
      const row = await read(repeat.id);
      expect(row.status).toBe('duplicate');
      expect(row.response_time_minutes).toBe(null);
      expect(row.extracted_data.duplicate_of_lead_id).toBe(root.id);
    }
    // The marker merge keeps what the row already carried.
    expect((await read(r1.id)).extracted_data.timeline).toBe('asap');
    expect((await read(root.id)).status).toBe('new');

    const history = await database('lead_activities').orderBy('lead_id');
    expect(history).toHaveLength(3);
    for (const row of history) {
      expect(row).toMatchObject({ activity_type: 'status_change', description: 'Status: new → duplicate', performed_by: 'Lead repeat sweep' });
      expect(row.metadata).toMatchObject({ status: 'duplicate', previous_status: 'new', duplicate_of_lead_id: root.id, source: 'lead_repeat_sweep' });
    }
    expect(bridgeLeadFunnelStage.mock.calls.map(([id, stage]) => [id, stage]))
      .toEqual([[r1.id, 'duplicate'], [r2.id, 'duplicate'], [r3.id, 'duplicate']]);
  });

  test('a repeat of an already-contacted lead files to it, and so does a second rerun the same night', async () => {
    const root = await lead({ status: 'contacted', lead_type: 'inbound_call', first_contact_at: OCT(9, '13:00'), response_time_minutes: 4 });
    const l1 = await lead({ first_contact_at: OCT(9, '23:51') });
    const l2 = await lead({ first_contact_at: OCT(9, '23:54') });
    const result = await runLeadRepeatSweep({ dbi: database });
    expect(result.filed).toBe(2);
    expect(await markerOf(l1.id)).toBe(root.id);
    expect(await markerOf(l2.id)).toBe(root.id);
  });

  test('follows an existing duplicate marker to its root', async () => {
    const a = await lead({ status: 'contacted', first_contact_at: OCT(20), response_time_minutes: 10 });
    await lead({ status: 'duplicate', first_contact_at: OCT(21), extracted_data: { duplicate_of_lead_id: a.id } });
    const c = await lead({ first_contact_at: OCT(22) });
    const result = await runLeadRepeatSweep({ dbi: database });
    expect(result.filed).toBe(1);
    expect(await markerOf(c.id)).toBe(a.id);
  });

  test('a won or lost earlier lead never makes a repeat: the person came back', async () => {
    await lead({ status: 'won', first_contact_at: OCT(10), response_time_minutes: 3 });
    const afterWon = await lead({ first_contact_at: OCT(25) });
    await lead({ status: 'lost', phone: '+19415550111', first_contact_at: OCT(10), response_time_minutes: 3 });
    const afterLost = await lead({ phone: '+19415550111', first_contact_at: OCT(25) });
    const result = await runLeadRepeatSweep({ dbi: database });
    expect(result.filed).toBe(0);
    expect(result.kept.no_open_same_person_root).toBe(2);
    expect((await read(afterWon.id)).status).toBe('new');
    expect((await read(afterLost.id)).status).toBe('new');
  });

  test('a different person, an unnamed pair, another customer row or another street stays waiting', async () => {
    const pairs = [
      [{ first_name: 'Sam' }, { first_name: 'Alex' }],
      [{ first_name: '', last_name: '' }, { first_name: '', last_name: '' }],
      [{ customer_id: randomUUID() }, { customer_id: randomUUID() }],
      [{ address: '12 Sample Ct, Parrish, FL 34219' }, { address: '40 Other Rd, Parrish, FL 34219' }],
    ];
    const later = [];
    for (const [index, [first, second]] of pairs.entries()) {
      const phone = `+1941555020${index}`;
      await lead({ ...first, phone, first_contact_at: OCT(20) });
      later.push(await lead({ ...second, phone, first_contact_at: OCT(21) }));
    }
    const result = await runLeadRepeatSweep({ dbi: database });
    expect(result.filed).toBe(0);
    for (const row of later) expect((await read(row.id)).status).toBe('new');
  });

  test('two open roots that both fit leave the lead for a person (a shared line)', async () => {
    await lead({ status: 'contacted', first_contact_at: OCT(18), response_time_minutes: 5 });
    await lead({ status: 'estimate_sent', first_contact_at: OCT(19), response_time_minutes: 5 });
    const waiting = await lead({ first_contact_at: OCT(25) });
    const result = await runLeadRepeatSweep({ dbi: database });
    expect(result.filed).toBe(0);
    expect(result.kept.ambiguous).toBe(1);
    expect((await read(waiting.id)).status).toBe('new');
  });

  test('an earlier lead outside the 30-day window is not a repeat', async () => {
    await lead({ status: 'contacted', first_contact_at: new Date('2026-09-01T14:00:00Z'), response_time_minutes: 5 });
    const waiting = await lead({ first_contact_at: new Date('2026-10-05T14:00:00Z') });
    const result = await runLeadRepeatSweep({ dbi: database });
    expect(result.filed).toBe(0);
    expect(result.kept.not_repeat).toBe(1);
    expect((await read(waiting.id)).status).toBe('new');
  });

  test('only the inbox waiting queue is touched: answered, too new, deleted and internal rows are skipped', async () => {
    const root = await lead({ status: 'contacted', first_contact_at: OCT(20), response_time_minutes: 5 });
    // Answered but still 'new' is out of the waiting queue. On the same phone it
    // would also be a second open root (the ambiguity test), so it gets its own.
    const answered = await lead({ first_contact_at: OCT(21), response_time_minutes: 12, phone: '+19415550300' });
    const tooNew = await lead({ first_contact_at: new Date(Date.now() - 5 * 60 * 1000) });
    const deleted = await lead({ first_contact_at: OCT(22), deleted_at: OCT(23) });
    const [internalFirst, ...internalRest] = INTERNAL_TEST_CUSTOMERS[0].split(' ');
    const internal = await lead({ first_contact_at: OCT(24), first_name: internalFirst, last_name: internalRest.join(' ') });
    const counted = await lead({ first_contact_at: OCT(25) });

    const result = await runLeadRepeatSweep({ dbi: database });
    expect(result.scanned).toBe(1);
    expect(result.filings).toEqual([{ leadId: counted.id, rootId: root.id }]);
    for (const row of [answered, tooNew, internal]) expect((await read(row.id)).status).toBe('new');
    expect((await read(deleted.id)).status).toBe('new');
  });

  test('a lead staff edited after the read is left as they left it (row-locked identity check)', async () => {
    const root = await lead({ status: 'contacted', first_contact_at: OCT(20), response_time_minutes: 5 });
    const waiting = await lead({ first_contact_at: OCT(21) });
    const staleRead = await read(waiting.id);
    await database('leads').where({ id: waiting.id }).update({ first_name: 'Robin' });

    const outcome = await fileRepeat(database, { lead: staleRead, root });
    expect(outcome).toEqual({ filed: false, reason: 'lead_changed' });
    expect((await read(waiting.id)).status).toBe('new');
    expect(await database('lead_activities')).toHaveLength(0);
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('a root closed after the read stops the filing', async () => {
    const root = await lead({ status: 'contacted', first_contact_at: OCT(20), response_time_minutes: 5 });
    const waiting = await lead({ first_contact_at: OCT(21) });
    const rootRead = await read(root.id);
    await database('leads').where({ id: root.id }).update({ status: 'lost' });
    const outcome = await fileRepeat(database, { lead: await read(waiting.id), root: rootRead });
    expect(outcome).toEqual({ filed: false, reason: 'root_changed' });
    expect((await read(waiting.id)).status).toBe('new');
  });

  test('extracted_data that is not a JSON object is left for a person', async () => {
    await lead({ status: 'contacted', first_contact_at: OCT(20), response_time_minutes: 5 });
    const waiting = await lead({ first_contact_at: OCT(21) });
    await database.raw('UPDATE ??.leads SET extracted_data = ?::jsonb WHERE id = ?', [schema, JSON.stringify('free text'), waiting.id]);
    const result = await runLeadRepeatSweep({ dbi: database });
    expect(result.filed).toBe(0);
    expect(result.kept.extracted_data_shape).toBe(1);
    expect((await read(waiting.id)).status).toBe('new');
  });

  test('constants the doc names', () => {
    expect(_test.REPEAT_WINDOW_DAYS).toBe(30);
    expect(_test.WRITE_CAP).toBe(50);
    expect(_test.SCAN_LIMIT).toBe(500);
  });
});
