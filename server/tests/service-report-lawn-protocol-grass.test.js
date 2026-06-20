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
      first: () => Promise.resolve(rows[0] || null),
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
