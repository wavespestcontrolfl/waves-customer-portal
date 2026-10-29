jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/lawn-protocol-operating-layer', () => ({
  getProtocolWindowContext: jest.fn(async () => ({
    protocol: { grass_track: 'zoysia' }, window: null, products: [], gates: {},
  })),
  summarizeProtocolContext: jest.fn((ctx) => (ctx?.protocol ? { grassTrack: ctx.protocol.grass_track } : null)),
}));

const { getProtocolWindowContext } = require('../services/lawn-protocol-operating-layer');
const { buildLawnProtocolReportContext } = require('../services/service-report/dynamic-context');

// Generic table-agnostic knex stand-in: every chain resolves to the seeded rows
// for that table (default: none), so the internal loaders return null/empty
// unless a row is provided.
function makeKnex(rowsByTable = {}) {
  const knex = (table) => {
    const rows = rowsByTable[table] || [];
    const q = {
      where: () => q, andWhere: () => q, whereIn: () => q, whereNull: () => q, whereNot: () => q,
      orderBy: () => q, leftJoin: () => q, join: () => q, select: () => q, limit: () => q,
      columnInfo: () => Promise.resolve({}),
      first: () => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows[0] || null)),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return q;
  };
  // Completion/assignment loaders guard on knex.schema.hasTable — resolve false
  // so they short-circuit to null (no completion, no assignment).
  knex.schema = { hasTable: () => Promise.resolve(false) };
  return knex;
}

const RECORD = { id: 'rec-1', customer_id: 'cust-1', service_date: '2026-06-15', scheduled_service_id: 'ss-1' };

describe('lawn protocol report context — never assume a grass', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns null (no speculative protocol copy) when grass is unknown', async () => {
    // No turf profile, no assigned protocol, no completion/assignment.
    const knex = makeKnex({});
    const result = await buildLawnProtocolReportContext(RECORD, knex, new Date('2026-06-15T12:00:00Z'));
    expect(result).toBeNull();
    // Critically: we never fetch a defaulted (St. Augustine) protocol window.
    expect(getProtocolWindowContext).not.toHaveBeenCalled();
  });

  test('uses the customer real turf track, never defaulting to st_augustine', async () => {
    const knex = makeKnex({ customer_turf_profiles: [{ track_key: 'zoysia', active: true }] });
    await buildLawnProtocolReportContext(RECORD, knex, new Date('2026-06-15T12:00:00Z'));
    expect(getProtocolWindowContext).toHaveBeenCalledTimes(1);
    const [, opts] = getProtocolWindowContext.mock.calls[0];
    expect(opts.grassTrack).toBe('zoysia');
    expect(opts.grassTrack).not.toBe('st_augustine');
  });

  test('falls back to legacy customers.lawn_type when there is no turf profile (keeps the card)', async () => {
    // No turf profile, but the customer's grass IS known from the legacy
    // free-text lawn_type — resolve the real track instead of dropping the card.
    const knex = makeKnex({ customers: [{ id: 'cust-1', lawn_type: 'Floratam' }] });
    const result = await buildLawnProtocolReportContext(RECORD, knex, new Date('2026-06-15T12:00:00Z'));
    expect(result).not.toBeNull();
    expect(getProtocolWindowContext).toHaveBeenCalledTimes(1);
    const [, opts] = getProtocolWindowContext.mock.calls[0];
    expect(opts.grassTrack).toBe('st_augustine'); // normalized from 'Floratam', a real known grass
  });
});

describe('lawn protocol report context — service date', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['a YYYY-MM-DD string', '2026-06-15'],
    ['the Date pg hands back for a DATE column', new Date(2026, 5, 15)],
  ])('%s resolves the protocol window for that day', async (_label, serviceDate) => {
    const knex = makeKnex({ customer_turf_profiles: [{ track_key: 'zoysia', active: true }] });
    await buildLawnProtocolReportContext({ ...RECORD, service_date: serviceDate }, knex, new Date('2026-10-05T12:00:00Z'));
    const [, opts] = getProtocolWindowContext.mock.calls[0];
    expect(Number.isNaN(opts.serviceDate.getTime())).toBe(false);
    expect([opts.serviceDate.getFullYear(), opts.serviceDate.getMonth(), opts.serviceDate.getDate()]).toEqual([2026, 5, 15]);
  });

  test('a record with no usable service date falls back to now', async () => {
    const knex = makeKnex({ customer_turf_profiles: [{ track_key: 'zoysia', active: true }] });
    const now = new Date('2026-10-05T12:00:00Z');
    await buildLawnProtocolReportContext({ ...RECORD, service_date: null }, knex, now);
    expect(getProtocolWindowContext.mock.calls[0][1].serviceDate).toBe(now);
  });
});

describe('lawn protocol report context — actuals rows recorded without a plan', () => {
  beforeEach(() => jest.clearAllMocks());
  const AT = new Date('2026-06-15T12:00:00Z');

  test('attribution none suppresses the seasonal protocol card even when the grass is known', async () => {
    const knex = makeKnex({
      customer_turf_profiles: [{ track_key: 'zoysia', active: true }],
      'lawn_protocol_service_completions as lpsc': [{ id: 'c-1', protocol_key: null, lawn_protocol_id: null, window_key: null, treated_sqft: 1500, metadata: { attribution: 'none', treatedSqftSource: 'visit' } }],
    });
    knex.schema = { hasTable: () => Promise.resolve(true) };
    expect(await buildLawnProtocolReportContext(RECORD, knex, AT)).toBeNull();
    expect(getProtocolWindowContext).not.toHaveBeenCalled();
  });

  test('a failed completion lookup fails closed instead of reading as "no completion" and inventing the calendar card', async () => {
    const knex = makeKnex({
      customer_turf_profiles: [{ track_key: 'zoysia', active: true }],
      'lawn_protocol_service_completions as lpsc': new Error('connection reset'),
    });
    knex.schema = { hasTable: () => Promise.resolve(true) };
    await expect(buildLawnProtocolReportContext(RECORD, knex, AT)).rejects.toThrow('connection reset');
    expect(getProtocolWindowContext).not.toHaveBeenCalled();
  });

  test('a failed table-existence probe fails closed the same way', async () => {
    const knex = makeKnex({ customer_turf_profiles: [{ track_key: 'zoysia', active: true }] });
    knex.schema = { hasTable: () => Promise.reject(new Error('probe timeout')) };
    await expect(buildLawnProtocolReportContext(RECORD, knex, AT)).rejects.toThrow('probe timeout');
    expect(getProtocolWindowContext).not.toHaveBeenCalled();
  });

  test('a protocol-attributed row still resolves its own protocol window', async () => {
    const knex = makeKnex({
      'lawn_protocol_service_completions as lpsc': [{ id: 'c-2', protocol_key: 'st_augustine', lawn_protocol_id: 'proto-1', window_key: 'summer_insect', metadata: { attribution: 'protocol' } }],
    });
    knex.schema = { hasTable: () => Promise.resolve(true) };
    await buildLawnProtocolReportContext(RECORD, knex, AT);
    expect(getProtocolWindowContext).toHaveBeenCalledTimes(1);
    expect(getProtocolWindowContext.mock.calls[0][1]).toMatchObject({ protocolId: 'proto-1', windowKey: 'summer_insect' });
  });
});

// A report for a visit on a 9x rounds series (recurring_pattern lawn_rounds_9, read with the record) states the protocol step of the
// visit's ROUND; any other visit's report reads the month of its service date as before.
describe('lawn protocol report context — 9x rounds visits', () => {
  const knex = () => makeKnex({ customer_turf_profiles: [{ track_key: 'st_augustine', active: true }] });
  const roundsRecord = (extra) => ({ ...RECORD, service_date: '2027-03-20', scheduled_recurring_pattern: 'lawn_rounds_9', scheduled_visit_date: '2027-03-20', ...extra });
  beforeEach(() => { jest.clearAllMocks(); process.env.GATE_LAWN_V13 = 'true'; });
  afterEach(() => { delete process.env.GATE_LAWN_V13; });

  test('an unpinned rounds visit asks for its round\'s step window (round 3 = February) and the real date\'s weed rows', async () => {
    await buildLawnProtocolReportContext(roundsRecord(), knex(), new Date('2027-03-21T12:00:00Z'));
    expect(getProtocolWindowContext.mock.calls[0][1].roundStep).toEqual({ round: 3, month: 2 });
  });

  test('round 2 reads April\'s window; round 8 October\'s', async () => {
    await buildLawnProtocolReportContext(roundsRecord({ service_date: '2027-02-10', scheduled_visit_date: '2027-02-10' }), knex(), new Date('2027-02-11T12:00:00Z'));
    expect(getProtocolWindowContext.mock.calls[0][1].roundStep).toEqual({ round: 2, month: 4 });
    await buildLawnProtocolReportContext(roundsRecord({ service_date: '2027-11-05', scheduled_visit_date: '2027-11-05' }), knex(), new Date('2027-11-06T12:00:00Z'));
    expect(getProtocolWindowContext.mock.calls[1][1].roundStep).toEqual({ round: 8, month: 10 });
  });

  test('a 12x, legacy 9x or one-time visit reads the month of its date: no round step', async () => {
    for (const pattern of ['monthly', 'every_6_weeks', 'custom', null, undefined]) {
      getProtocolWindowContext.mockClear();
      await buildLawnProtocolReportContext(roundsRecord({ scheduled_recurring_pattern: pattern }), knex(), new Date('2027-03-21T12:00:00Z'));
      expect(getProtocolWindowContext.mock.calls[0][1].roundStep).toBeUndefined();
    }
  });

  test('v13 off: the old program keeps the calendar month for a rounds row too', async () => {
    delete process.env.GATE_LAWN_V13;
    await buildLawnProtocolReportContext(roundsRecord(), knex(), new Date('2027-03-21T12:00:00Z'));
    expect(getProtocolWindowContext.mock.calls[0][1].roundStep).toBeUndefined();
  });
});
