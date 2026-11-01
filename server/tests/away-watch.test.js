/**
 * Away Watch + Welcome Home (GATE_AWAY_WATCH, owner approved 2026-10-31): the shared writer rules, the gate-off
 * silence of both responses, and the tech job-card lines. The closeout photo minimum runs through the real
 * completeScheduledService in away-watch-closeout-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = () => ({});
  fn.raw = () => ({});
  fn.schema = { hasTable: async () => true };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(), hasIrrigationEmailOptIn: jest.fn(async () => false) }));

const { validatePrefsBody, PREFS_FIELD_SCHEMAS } = require('../services/property-preferences-schema');
const AwayWatch = require('../services/away-watch');
const jobCard = require('../services/job-card');
const { etDateString, addETDays } = require('../utils/datetime-et');

const day = (offset) => etDateString(addETDays(new Date(), offset));
const GATE = 'GATE_AWAY_WATCH';

afterEach(() => { delete process.env[GATE]; });

describe('writer rules (shared by the customer and the admin writer)', () => {
  const run = (body) => validatePrefsBody(PREFS_FIELD_SCHEMAS, body);
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('a valid pair saves as plain ET day strings', () => {
    const out = run({ awayWatchFrom: day(1), awayWatchUntil: day(30) });
    expect(out.rejected).toEqual([]);
    expect(out.value).toEqual({ awayWatchFrom: day(1), awayWatchUntil: day(30) });
  });

  test('a pair of nulls (or empty strings) clears both', () => {
    expect(run({ awayWatchFrom: null, awayWatchUntil: null }).value).toEqual({ awayWatchFrom: null, awayWatchUntil: null });
    expect(run({ awayWatchFrom: '', awayWatchUntil: '' }).value).toEqual({ awayWatchFrom: null, awayWatchUntil: null });
  });

  test.each([
    ['one date only', { awayWatchFrom: day(1) }],
    ['one date set, one cleared', { awayWatchFrom: day(1), awayWatchUntil: null }],
  ])('both or neither: %s is refused, nothing is saved, and both dates are named', (_label, body) => {
    const out = run({ ...body, parkingNotes: 'Driveway' });
    expect(out.value).toEqual({ parkingNotes: 'Driveway' });
    expect(out.rejected).toEqual([{ field: 'awayWatchFrom', message: AwayWatch.MESSAGES.together }, { field: 'awayWatchUntil', message: AwayWatch.MESSAGES.together }]);
  });

  test('the leave day cannot be after the back day; the same day is allowed', () => {
    expect(run({ awayWatchFrom: day(10), awayWatchUntil: day(5) }).rejected).toEqual([{ field: 'awayWatchFrom', message: AwayWatch.MESSAGES.order }, { field: 'awayWatchUntil', message: AwayWatch.MESSAGES.order }]);
    expect(run({ awayWatchFrom: day(10), awayWatchUntil: day(10) }).rejected).toEqual([]);
  });

  test('the window is at most 240 days (240 passes, 241 is refused)', () => {
    expect(run({ awayWatchFrom: day(0), awayWatchUntil: day(240) }).rejected).toEqual([]);
    expect(run({ awayWatchFrom: day(0), awayWatchUntil: day(241) }).rejected).toEqual([{ field: 'awayWatchFrom', message: AwayWatch.MESSAGES.tooLong }, { field: 'awayWatchUntil', message: AwayWatch.MESSAGES.tooLong }]);
  });

  test('the back day cannot be before today in ET; leaving in the past is fine while the member is still away', () => {
    expect(run({ awayWatchFrom: day(-20), awayWatchUntil: day(-1) }).rejected).toEqual([{ field: 'awayWatchFrom', message: AwayWatch.MESSAGES.past }, { field: 'awayWatchUntil', message: AwayWatch.MESSAGES.past }]);
    expect(run({ awayWatchFrom: day(-20), awayWatchUntil: day(0) }).rejected).toEqual([]);
  });

  test.each(['2026-02-31', 'next week', '2026-6-1', 20260601])('%p is not a calendar day: both dates are dropped and one message names it', (bad) => {
    const out = run({ awayWatchFrom: bad, awayWatchUntil: day(20) });
    expect(out.value).toEqual({});
    // The bad day keeps its own message; the good one is dropped with it and named too, with the same words.
    expect(out.rejected).toHaveLength(2);
    expect(out.rejected.map((r) => r.field)).toEqual(['awayWatchFrom', 'awayWatchUntil']);
    expect(out.rejected[1].message).toBe(out.rejected[0].message);
  });

  test('the cancel-flow Away Mode column is not a field here', () => {
    expect(run({ awayModeUntil: day(5) })).toMatchObject({ value: {}, presentCount: 0 });
  });

  test('gate off: both keys are unknown fields, stripped without a message, like any other unknown key', () => {
    delete process.env[GATE];
    const out = run({ awayWatchFrom: day(1), awayWatchUntil: day(30), parkingNotes: 'Driveway' });
    expect(out).toMatchObject({ value: { parkingNotes: 'Driveway' }, rejected: [], presentCount: 1 });
    process.env[GATE] = 'TRUE';
    expect(run({ awayWatchFrom: day(1), awayWatchUntil: day(30) })).toMatchObject({ value: {}, rejected: [], presentCount: 0 });
  });
});

describe('responses', () => {
  const row = { id: 'p1', away_watch_from: new Date('2026-06-01T00:00:00Z'), away_watch_until: '2026-09-15', parking_notes: 'x' };

  const member = { waveguard_tier: 'Gold' };
  const nonMember = { waveguard_tier: null, monthly_rate: 0 };

  test('gate off: the two fields are removed from a row (snake or camel), member or not', () => {
    expect(AwayWatch.awayWatchFieldsFor(member, row)).toEqual({ id: 'p1', parking_notes: 'x' });
    expect(AwayWatch.awayWatchFieldsFor(member, { awayWatchFrom: null, awayWatchUntil: null, a: 1 })).toEqual({ a: 1 });
    expect(AwayWatch.awayWatchFieldsFor(member, null)).toBeNull();
  });

  test('gate on: a member gets the fields as plain ET day strings; a non-member never sees them', () => {
    process.env[GATE] = 'true';
    expect(AwayWatch.awayWatchFieldsFor(member, row)).toMatchObject({ away_watch_from: '2026-06-01', away_watch_until: '2026-09-15', parking_notes: 'x' });
    expect(AwayWatch.awayWatchFieldsFor(nonMember, row)).toEqual({ id: 'p1', parking_notes: 'x' });
    expect(AwayWatch.awayWatchFieldsFor(null, row)).toEqual({ id: 'p1', parking_notes: 'x' });
  });

  test('gate off: withAwayWatchDays leaves the row alone', () => {
    expect(AwayWatch.withAwayWatchDays(row)).toBe(row);
  });
});


describe('awayWatchClosePhotoCount', () => {
  const fakeKnex = (count, seen = [], wheres = []) => (table) => {
    seen.push(table);
    const builder = { where: (w) => { wheres.push(w); return builder; }, whereNotNull: () => builder, whereNot: () => builder, count: () => builder, first: async () => ({ n: String(count) }) };
    return builder;
  };

  test('body photos (the upload\'s unique count) plus staged photos the upload did not dedupe onto', async () => {
    const seen = [];
    // The body uploaded 2 unique photos; one of them deduped onto staged photo p2, so p2 is not counted twice.
    const n = await AwayWatch.awayWatchClosePhotoCount(fakeKnex(0, seen), {
      promotedIds: ['p1', 'p2'],
      uploadResult: { uniqueUploaded: 2, photos: [{ id: 'p2' }, { id: 'u1' }, null] },
    });
    expect(n).toBe(3);
    expect(seen).toEqual([]);
    expect(await AwayWatch.awayWatchClosePhotoCount(fakeKnex(0), { promotedIds: ['p1', 'p2', 'p3'] })).toBe(3);
    expect(await AwayWatch.awayWatchClosePhotoCount(fakeKnex(0), { uploadResult: { uploaded: 1 } })).toBe(1);
  });

  test('a linked lawn assessment adds its uploaded, customer-visible photos only', async () => {
    const seen = [];
    const wheres = [];
    expect(await AwayWatch.awayWatchClosePhotoCount(fakeKnex(4, seen, wheres), { lawnAssessmentId: 'la1' })).toBe(4);
    expect(seen).toEqual(['lawn_assessment_photos']);
    // Hidden rows (customer_visible = false: failed quality, suppressed) never count.
    expect(wheres).toContainEqual({ assessment_id: 'la1', customer_visible: true });
    expect(await AwayWatch.awayWatchClosePhotoCount(fakeKnex(2), { promotedIds: ['p1'], lawnAssessmentId: 'la1' })).toBe(3);
    expect(await AwayWatch.awayWatchClosePhotoCount(fakeKnex(1), { uploadResult: { uniqueUploaded: 2 }, lawnAssessmentId: 'la1' })).toBe(3);
  });
});

describe('tech job-card lines', () => {
  const AWAY = 'Away Watch: member away until 2026-09-30. Take 3 photos of the outside of the home from the ground and note standing water.';
  const WELCOME = 'Welcome Home: last visit before the member is back. Do a lanai cobweb sweep (no product).';
  // The visit row (the visit joined to its customer's membership facts and away dates, with address_diverges)
  // answers the first .first(); the next-visit lookup answers .first('ss.scheduled_date').
  const fakeDb = ({ prefs, next = null, visitDay = '2026-09-04' }) => {
    const reads = [];
    const dbh = (table) => {
      reads.push(table);
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'whereNotIn', 'whereRaw', 'orderBy']) chain[m] = () => chain;
      chain.first = async (...cols) => (cols[0] === 'ss.scheduled_date'
        ? next
        : (prefs && { customer_id: 'c1', scheduled_date: visitDay, address_diverges: false, ...prefs }));
      return chain;
    };
    dbh.raw = (sql) => sql;
    dbh.reads = reads;
    return dbh;
  };
  const prefs = { away_watch_from: '2026-09-01', away_watch_until: '2026-09-30', waveguard_tier: 'Gold', monthly_rate: 0 };
  const lines = (visitDay, over = {}) => AwayWatch.awayWatchCardLines(fakeDb({ prefs, visitDay, ...over }), 'svc1');

  beforeEach(() => { process.env[GATE] = 'true'; });

  test('inside the window: the Away Watch line names the back day', async () => {
    expect(await lines('2026-09-04', { next: { scheduled_date: '2026-09-18' } })).toEqual({ lines: [AWAY] });
  });

  test('the leave day is inside, the back day is not', async () => {
    expect(await lines('2026-09-01', { next: { scheduled_date: '2026-09-18' } })).toEqual({ lines: [AWAY] });
    expect(await lines('2026-09-30')).toBeNull();
    expect(await lines('2026-08-31')).toBeNull();
  });

  test('the last visit before the back day also gets Welcome Home: no later visit, or the next one is on or after the back day', async () => {
    expect(await lines('2026-09-20')).toEqual({ lines: [AWAY, WELCOME] });
    expect(await lines('2026-09-20', { next: { scheduled_date: '2026-09-30' } })).toEqual({ lines: [AWAY, WELCOME] });
    expect(await lines('2026-09-20', { next: { scheduled_date: new Date('2026-10-14T00:00:00Z') } })).toEqual({ lines: [AWAY, WELCOME] });
  });

  test('a visit with another one still before the back day does not get Welcome Home', async () => {
    expect((await lines('2026-09-20', { next: { scheduled_date: '2026-09-29' } })).lines).toEqual([AWAY]);
  });

  test('Away Watch is a member perk: dates on a non-member\'s row add nothing; a legacy member with a monthly rate counts', async () => {
    expect(await lines('2026-09-04', { prefs: { ...prefs, waveguard_tier: null, monthly_rate: 0 } })).toBeNull();
    expect(await lines('2026-09-04', { prefs: { ...prefs, waveguard_tier: 'none', monthly_rate: 0 } })).toBeNull();
    expect(await lines('2026-09-04', { prefs: { ...prefs, waveguard_tier: null, monthly_rate: 89 }, next: { scheduled_date: '2026-09-18' } })).toEqual({ lines: [AWAY] });
  });

  test('a visit stamped at another address gets nothing: the home\'s away window never follows a visit elsewhere', async () => {
    expect(await lines('2026-09-04', { prefs: { ...prefs, address_diverges: true } })).toBeNull();
  });

  test('one date missing, no row: nothing', async () => {
    expect(await lines('2026-09-04', { prefs: { ...prefs, away_watch_until: null } })).toBeNull();
    expect(await lines('2026-09-04', { prefs: undefined })).toBeNull();
  });

  test('gate off: nothing, and the database is not read', async () => {
    delete process.env[GATE];
    const dbh = fakeDb({ prefs });
    expect(await AwayWatch.awayWatchCardLines(dbh, 'svc1')).toBeNull();
    expect(await AwayWatch.visitInAwayWatchWindow(dbh, 'svc1')).toBe(false);
    expect(dbh.reads).toEqual([]);
  });

  describe('on the full card', () => {
    const factsDb = (rows) => {
      const dbh = (table) => {
        const chain = {};
        for (const m of ['join', 'leftJoin', 'where', 'whereNotIn', 'whereIn', 'whereRaw', 'modify', 'orderBy', 'orderByRaw', 'select', 'limit', 'whereNotNull']) chain[m] = () => chain;
        // The Away Watch next-visit lookup selects 'ss.scheduled_date'; every other .first() reads the table's row.
        chain.first = (...cols) => {
          const value = cols[0] === 'ss.scheduled_date' ? rows.next : rows[table];
          return Object.assign(Promise.resolve(value ?? null), { catch: async () => value ?? null });
        };
        const value = rows[table];
        chain.catch = async () => (Array.isArray(value) ? value : []);
        return Object.assign(chain, { update: () => ({ catch: async () => null }) });
      };
      dbh.raw = (sql) => sql;
      return dbh;
    };
    const visit = (scheduled_date) => ({ id: 'svc1', customer_id: 'c1', scheduled_date, service_type: 'Quarterly Pest Control', first_name: 'A', last_name: 'B', address_diverges: false, ...prefs });
    const card = (scheduledDate, rows = {}) => jobCard.buildJobCard('svc1', {
      dbh: factsDb({ 'scheduled_services as ss': visit(scheduledDate), property_preferences: prefs, ...rows }),
      deps: { getRecentCalls: async () => [], getHourly: async () => null, protocols: { programs: [] } },
      now: new Date('2026-09-04T12:00:00Z'),
    });

    test('inside the window the card carries the lines; outside it, and with the gate off, it has no awayWatch key', async () => {
      expect((await card('2026-09-04', { next: { scheduled_date: '2026-09-18' } })).awayWatch).toEqual({ lines: [AWAY] });
      expect((await card('2026-09-22')).awayWatch).toEqual({ lines: [AWAY, WELCOME] });
      expect(await card('2026-10-02')).not.toHaveProperty('awayWatch');
      delete process.env[GATE];
      expect(await card('2026-09-04')).not.toHaveProperty('awayWatch');
    });

    test('the dispatch readiness poll never reads it', async () => {
      const ready = await jobCard.buildJobCard('svc1', {
        dbh: factsDb({ 'scheduled_services as ss': visit('2026-09-04'), property_preferences: prefs }),
        readinessOnly: true,
        deps: { getRecentCalls: async () => [], getHourly: async () => null, protocols: {} },
        now: new Date('2026-09-04T12:00:00Z'),
      });
      expect(ready).not.toHaveProperty('awayWatch');
    });
  });
});
