/**
 * inventory-count-guard.js — decides when a visit's usage was already counted out of stock.
 * Fixtures are real production (source | reason) pairs from product_inventory_movements.
 */
const {
  isCountCorrection, countTime, latestCount, visitStartedAt, usedBeforeCount, stockHoldFor, loadVisit,
} = require('../services/inventory-count-guard');

const GATE = 'GATE_STOCK_COUNT_AWARE_USAGE';
const correction = (source, reason, extra = {}) => ({
  id: 'mv', movement_type: 'correction', created_at: new Date('2026-10-28T23:00:00Z'),
  metadata: { ...(source ? { source } : {}), reason, ...extra },
});

describe('isCountCorrection — production fixtures', () => {
  const COUNTS = [
    ['video_inventory_intake_2026_07_28', 'Initial physical inventory 2026-07-28 (s...', {}],
    ['admin_manual_adjustment', 'physical_count_2026_10_28', { setTotal: 150, countedAt: '2026-10-28T22:00:00Z' }],
    ['admin_product_create', 'Initial stock', {}],
    ['admin_manual_adjustment', 'physical count 2026-09-11', {}],
    ['admin_manual_adjustment', 'Physical count', {}],
    ['intelligence_bar_adjust_stock', 'Physical inventory count 2026-08-27', {}],
    ['intelligence_bar_adjust_stock', 'Physical shelf count 2026-08-18', {}],
    ['owner_count', '', {}],
    ['owner_count_via_claude', 'Owner count 2026-10-26: two full 96 fl o...', {}],
    ['admin_manual_adjustment', 'Count correction', {}],
  ];
  const NOT_COUNTS = [
    ['inventory_unit_review_fix', 'Inventory unit normalization', {}],
    ['siteone_invoice', '', { setTotal: 40 }],
    ['admin_manual_adjustment', 'Sticker Mule order R625853227 (500) appr...', {}],
    ['admin_manual_adjustment', 'Duplicate receipt', {}],
    ['admin_inline_stock_edit', 'Inline product stock edit', {}],
    [null, 'Unrecorded restock correction 2026-08-13', {}],
  ];

  test.each(COUNTS)('count: %s | %s', (source, reason, extra) => {
    expect(isCountCorrection(correction(source, reason, extra))).toBe(true);
  });

  test.each(NOT_COUNTS)('not a count: %s | %s', (source, reason, extra) => {
    expect(isCountCorrection(correction(source, reason, extra))).toBe(false);
  });

  test('the excluded sources win over countedAt and a "count" reason', () => {
    for (const source of ['siteone_invoice', 'amazon_delivery', 'inventory_unit_review_fix']) {
      expect(isCountCorrection(correction(source, 'physical count', { countedAt: '2026-10-28T22:00:00Z' }))).toBe(false);
    }
  });

  test('only a correction can be a count', () => {
    expect(isCountCorrection({ movement_type: 'usage', metadata: { source: 'owner_count' } })).toBe(false);
    expect(isCountCorrection({ movement_type: 'restock', metadata: { reason: 'physical count' } })).toBe(false);
    expect(isCountCorrection(null)).toBe(false);
  });

  test('metadata may be a JSON string, or missing', () => {
    expect(isCountCorrection({ movement_type: 'correction', metadata: JSON.stringify({ source: 'owner_count' }) })).toBe(true);
    expect(isCountCorrection({ movement_type: 'correction', metadata: 'not json' })).toBe(false);
    expect(isCountCorrection({ movement_type: 'correction', metadata: null })).toBe(false);
  });

  test('an unparseable countedAt is not evidence of a count', () => {
    expect(isCountCorrection(correction('admin_manual_adjustment', 'Duplicate receipt', { countedAt: 'later' }))).toBe(false);
  });
});

describe('countTime', () => {
  test('uses metadata.countedAt when it parses', () => {
    const m = correction('owner_count', '', { countedAt: '2026-10-28T22:15:00Z' });
    expect(countTime(m).toISOString()).toBe('2026-10-28T22:15:00.000Z');
  });
  test('falls back to created_at when countedAt is missing or invalid', () => {
    expect(countTime(correction('owner_count', '')).toISOString()).toBe('2026-10-28T23:00:00.000Z');
    expect(countTime(correction('owner_count', '', { countedAt: 'garbage' })).toISOString()).toBe('2026-10-28T23:00:00.000Z');
  });
});

describe('visitStartedAt', () => {
  const at = (h) => `2026-10-10T${h}:00:00Z`;
  test('takes the first present of arrived_at, check_in_time, actual_start_time, then the record started_at', () => {
    const scheduledService = { arrived_at: at('10'), check_in_time: at('11'), actual_start_time: at('12') };
    const serviceRecord = { started_at: at('13') };
    expect(visitStartedAt({ scheduledService, serviceRecord }).toISOString()).toBe('2026-10-10T10:00:00.000Z');
    expect(visitStartedAt({ scheduledService: { check_in_time: at('11'), actual_start_time: at('12') }, serviceRecord }).toISOString()).toBe('2026-10-10T11:00:00.000Z');
    expect(visitStartedAt({ scheduledService: { actual_start_time: at('12') }, serviceRecord }).toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(visitStartedAt({ scheduledService: {}, serviceRecord }).toISOString()).toBe('2026-10-10T13:00:00.000Z');
  });
  test('null when the visit recorded no start', () => {
    expect(visitStartedAt({ scheduledService: { arrived_at: null }, serviceRecord: { started_at: 'bad' } })).toBeNull();
    expect(visitStartedAt({})).toBeNull();
  });
});

describe('usedBeforeCount', () => {
  const count = { id: 'c1', countedAt: new Date('2026-10-28T22:00:00Z') }; // 6:00 PM ET on 10-28
  test('with a start time: earlier is before, later is not', () => {
    expect(usedBeforeCount({ scheduledService: { arrived_at: '2026-10-28T15:00:00Z' } }, count)).toBe(true);
    expect(usedBeforeCount({ scheduledService: { arrived_at: '2026-10-28T23:00:00Z' } }, count)).toBe(false);
  });
  test('a start time wins over the calendar day', () => {
    const visit = { scheduledService: { arrived_at: '2026-10-28T23:00:00Z', scheduled_date: '2026-10-02' } };
    expect(usedBeforeCount(visit, count)).toBe(false);
  });
  test('no start: an earlier Eastern day is before the count', () => {
    expect(usedBeforeCount({ serviceRecord: { service_date: '2026-10-27' } }, count)).toBe(true);
    expect(usedBeforeCount({ scheduledService: { scheduled_date: new Date('2026-10-02T00:00:00Z') } }, count)).toBe(true);
  });
  test('no start: a visit on the count\'s own Eastern day is NOT before the count', () => {
    expect(usedBeforeCount({ serviceRecord: { service_date: '2026-10-28' } }, count)).toBe(false);
    expect(usedBeforeCount({ scheduledService: { scheduled_date: '2026-10-28' } }, count)).toBe(false);
  });
  test('the count day is read in Eastern time (a 9 PM ET count lands on the next UTC day)', () => {
    const lateCount = { id: 'c2', countedAt: new Date('2026-10-29T01:30:00Z') }; // 9:30 PM ET on 10-28
    expect(usedBeforeCount({ serviceRecord: { service_date: '2026-10-28' } }, lateCount)).toBe(false);
    expect(usedBeforeCount({ serviceRecord: { service_date: '2026-10-27' } }, lateCount)).toBe(true);
  });
  test('service_records.service_date wins over scheduled_date', () => {
    const visit = { serviceRecord: { service_date: '2026-10-28' }, scheduledService: { scheduled_date: '2026-10-02' } };
    expect(usedBeforeCount(visit, count)).toBe(false);
  });
  test('no count, or no date and no start, is false', () => {
    expect(usedBeforeCount({ serviceRecord: { service_date: '2026-10-02' } }, null)).toBe(false);
    expect(usedBeforeCount({}, count)).toBe(false);
    expect(usedBeforeCount({ scheduledService: { scheduled_date: null } }, count)).toBe(false);
  });
});

// A conn whose movement read answers `rows` (newest first) and records the query it was asked.
function fakeConn(rows, tables = {}) {
  const calls = [];
  const conn = (table) => {
    const q = { table };
    calls.push(q);
    q.where = (w) => { q.where_ = w; return q; };
    q.orderBy = (...a) => { q.order = a; return q; };
    q.limit = (n) => { q.limit_ = n; return q; };
    q.select = (...cols) => { q.cols = cols; return Object.assign(Promise.resolve(rows), { first: async () => tables[table] ?? null }); };
    q.first = async () => (tables[table] ?? null);
    return q;
  };
  conn.calls = calls;
  return conn;
}

describe('latestCount', () => {
  test('returns the newest count correction and skips corrections that are not counts', async () => {
    const conn = fakeConn([
      { ...correction('siteone_invoice', '', { setTotal: 40 }), id: 'invoice-fix' },
      { ...correction('admin_manual_adjustment', 'Duplicate receipt'), id: 'dup' },
      { ...correction('owner_count', '', { countedAt: '2026-10-22T20:00:00Z' }), id: 'count-1' },
      { ...correction('owner_count', ''), id: 'count-0' },
    ]);
    const found = await latestCount(conn, 'prod-1');
    expect(found.id).toBe('count-1');
    expect(found.countedAt.toISOString()).toBe('2026-10-22T20:00:00.000Z');
    expect(conn.calls[0]).toMatchObject({
      table: 'product_inventory_movements', where_: { product_id: 'prod-1', movement_type: 'correction' }, order: ['created_at', 'desc'],
    });
  });
  test('null when the product was never counted or has no id', async () => {
    expect(await latestCount(fakeConn([correction(null, 'Unrecorded restock correction 2026-08-13')]), 'prod-1')).toBeNull();
    expect(await latestCount(fakeConn([]), 'prod-1')).toBeNull();
    expect(await latestCount(fakeConn([]), null)).toBeNull();
  });
});

describe('stockHoldFor', () => {
  const rows = [{ ...correction('owner_count', '', { countedAt: '2026-10-22T20:00:00Z' }), id: 'count-1' }];
  afterEach(() => { delete process.env[GATE]; });

  test('gate off: null, and nothing is read', async () => {
    const conn = fakeConn(rows);
    expect(await stockHoldFor(conn, 'prod-1', { serviceRecord: { service_date: '2026-10-02' } })).toBeNull();
    expect(conn.calls).toHaveLength(0);
  });
  test('gate on, visit before the count: the metadata to stamp', async () => {
    process.env[GATE] = 'true';
    expect(await stockHoldFor(fakeConn(rows), 'prod-1', { serviceRecord: { service_date: '2026-10-02' } })).toEqual({
      stockUnchanged: 'used_before_latest_count', countMovementId: 'count-1', countedAt: '2026-10-22T20:00:00.000Z',
    });
  });
  test('gate on, visit after the count: null', async () => {
    process.env[GATE] = 'true';
    expect(await stockHoldFor(fakeConn(rows), 'prod-1', { serviceRecord: { service_date: '2026-10-26' } })).toBeNull();
  });
  test('the visit may be a function, read only after a count exists', async () => {
    process.env[GATE] = 'true';
    const visit = jest.fn(async () => ({ serviceRecord: { service_date: '2026-10-02' } }));
    expect(await stockHoldFor(fakeConn([]), 'prod-1', visit)).toBeNull();
    expect(visit).not.toHaveBeenCalled();
    expect(await stockHoldFor(fakeConn(rows), 'prod-1', visit)).not.toBeNull();
    expect(visit).toHaveBeenCalledTimes(1);
  });
  test('any value but exactly "true" keeps the gate off', async () => {
    for (const value of ['TRUE', '1', '', 'yes']) {
      process.env[GATE] = value;
      expect(await stockHoldFor(fakeConn(rows), 'prod-1', { serviceRecord: { service_date: '2026-10-02' } })).toBeNull();
    }
  });
});

describe('loadVisit', () => {
  test('reads only the visit and record start fields, and tolerates missing ids', async () => {
    const conn = fakeConn([], { scheduled_services: { arrived_at: null, scheduled_date: '2026-10-02' }, service_records: { started_at: null, service_date: '2026-10-02' } });
    const visit = await loadVisit(conn, { scheduledServiceId: 's1', serviceRecordId: 'r1' });
    expect(visit.scheduledService.scheduled_date).toBe('2026-10-02');
    expect(visit.serviceRecord.service_date).toBe('2026-10-02');
    expect(await loadVisit(fakeConn([]), {})).toEqual({ scheduledService: null, serviceRecord: null });
  });
});
