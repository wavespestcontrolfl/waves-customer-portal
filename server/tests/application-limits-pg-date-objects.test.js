// product_limits.season_start/season_end and
// property_application_history.application_date are pg `date` columns. With
// no type parser configured, node-pg hands them back as JS Date objects, and
// String(date).slice(5, 10) yields "Jun 0" instead of "06-01" — so the
// seasonal nitrogen blackout and min_interval_days limits never fired.
// These tests feed Date objects through the same mocked-db path and assert
// the limits fire; string inputs are covered too so the fix is a superset.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const applicationLimits = require('../services/application-limits');
const ComplianceService = require('../services/compliance');

function chain({ rows = [], first: firstVal } = {}) {
  const q = {};
  for (const m of [
    'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'andWhere',
    'select', 'orderBy', 'limit', 'leftJoin', 'count',
  ]) {
    q[m] = jest.fn(() => q);
  }
  q.first = jest.fn(async () => firstVal);
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

// node-pg's default `date` parser: local-midnight Date for the calendar day.
const pgDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const NITROGEN_PRODUCT = {
  id: 'prod-n', name: 'Lawn Fertilizer 24-0-11', moa_group: null,
  category: 'fertilizer', active_ingredient: 'Nitrogen (urea)',
};

function blackoutLimit(start, end) {
  return {
    id: 'lim-blackout', product_id: null, match_type: 'nitrogen', match_value: null,
    limit_type: 'seasonal_blackout', limit_value: null, severity: 'hard_block',
    jurisdiction: 'sarasota_county', season_start: start, season_end: end,
    description: 'Sarasota County fertilizer ordinance: no nitrogen Jun 1 - Sep 30.',
  };
}

describe('application-limits with pg date columns as JS Date objects', () => {
  beforeEach(() => db.mockReset());

  function mockNitrogenCheck(limit) {
    db
      .mockReturnValueOnce(chain({ first: NITROGEN_PRODUCT }))                        // products_catalog
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', city: 'Sarasota' } }))       // customers
      .mockReturnValueOnce(chain({ rows: [] }))                                         // product history
      .mockReturnValueOnce(chain({ rows: [] }))                                         // product_limits (product)
      .mockReturnValueOnce(chain({ rows: [limit] }));                                   // product_limits (nitrogen)
  }

  test('(a) Date-object season window: 2026-07-15 nitrogen app inside Jun 1 - Sep 30 is hard-blocked', async () => {
    mockNitrogenCheck(blackoutLimit(pgDate('2026-06-01'), pgDate('2026-09-30')));

    const result = await applicationLimits.checkLimits('cust-1', 'prod-n', new Date('2026-07-15T16:00:00Z'));

    expect(result.allowed).toBe(false);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ type: 'seasonal_blackout', current: 'in_blackout' });
    expect(result.blocks[0].message).toContain('06/01 — 09/30');
  });

  test('(c) string season window still works and dates outside the window are allowed', async () => {
    mockNitrogenCheck(blackoutLimit('2026-06-01', '2026-09-30'));
    const inside = await applicationLimits.checkLimits('cust-1', 'prod-n', new Date('2026-07-15T16:00:00Z'));
    expect(inside.allowed).toBe(false);
    expect(inside.blocks[0]).toMatchObject({ type: 'seasonal_blackout' });

    mockNitrogenCheck(blackoutLimit(pgDate('2026-06-01'), pgDate('2026-09-30')));
    const outside = await applicationLimits.checkLimits('cust-1', 'prod-n', new Date('2026-03-15T16:00:00Z'));
    expect(outside.allowed).toBe(true);
    expect(outside.blocks).toHaveLength(0);
  });

  test('(b) min_interval_days: Date-object last application 10 days ago flags when minDays=14', async () => {
    const product = { id: 'prod-h', name: 'Headway G', moa_group: null, category: 'fungicide' };
    const limit = {
      id: 'lim-int', product_id: 'prod-h', match_type: 'product', limit_type: 'min_interval_days',
      limit_value: 14, severity: 'hard_block', description: 'Headway: 14-day minimum retreatment interval.',
    };
    db
      .mockReturnValueOnce(chain({ first: product }))
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', city: 'Bradenton' } }))
      .mockReturnValueOnce(chain({ rows: [{ id: 'pah-1', product_id: 'prod-h', application_date: pgDate('2026-07-05'), application_rate: '1' }] }))
      .mockReturnValueOnce(chain({ rows: [limit] }));

    const result = await applicationLimits.checkLimits('cust-1', 'prod-h', new Date('2026-07-15T16:00:00Z'));

    expect(result.allowed).toBe(false);
    expect(result.blocks[0]).toMatchObject({ type: 'min_interval_days', current: 10, max: 14 });
    expect(result.blocks[0].message).not.toContain('NaN');
  });

  test('(b2) min_interval_days: first legal ET day before 08:00 ET counts whole calendar days (not blocked)', async () => {
    const product = { id: 'prod-h', name: 'Headway G', moa_group: null, category: 'fungicide' };
    const limit = {
      id: 'lim-int', product_id: 'prod-h', match_type: 'product', limit_type: 'min_interval_days',
      limit_value: 14, severity: 'hard_block', description: 'Headway: 14-day minimum retreatment interval.',
    };
    db
      .mockReturnValueOnce(chain({ first: product }))
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', city: 'Bradenton' } }))
      .mockReturnValueOnce(chain({ rows: [{ id: 'pah-1', product_id: 'prod-h', application_date: pgDate('2026-07-05'), application_rate: '1' }] }))
      .mockReturnValueOnce(chain({ rows: [limit] }));

    // 2026-07-19 04:00Z is 00:00 ET on July 19 — exactly 14 calendar days later.
    const result = await applicationLimits.checkLimits('cust-1', 'prod-h', new Date('2026-07-19T04:00:00Z'));

    expect(result.allowed).toBe(true);
    expect(result.blocks).toHaveLength(0);
    expect(result.warnings[0]).toMatchObject({ type: 'min_interval_days', current: 14, max: 14 });
  });
});

describe('compliance service with pg date columns as JS Date objects', () => {
  beforeEach(() => db.mockReset());

  test('getNitrogenStatus: Date-object blackout window renders YYYY-MM-DD and flags county customers in-window', async () => {
    jest.useFakeTimers({ now: new Date('2026-07-15T16:00:00Z') });
    try {
      db
        .mockReturnValueOnce(chain({ rows: [blackoutLimit(pgDate('2026-06-01'), pgDate('2026-09-30'))] }))
        .mockReturnValueOnce(chain({ rows: [{ id: 'cust-1', first_name: 'A', last_name: 'B', city: 'Sarasota', zip: '34231', lawn_type: 'St. Augustine' }] }))
        .mockReturnValueOnce(chain({ first: { count: '2' } }));

      const status = await ComplianceService.getNitrogenStatus();

      expect(status.blackoutPeriods[0]).toMatchObject({ start: '2026-06-01', end: '2026-09-30' });
      expect(status.customers[0]).toMatchObject({ county: 'sarasota_county', blackoutActive: true, nitrogenAppsYTD: 2 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('getProductLimits: Date-object blackout window reports blackout_active', async () => {
    jest.useFakeTimers({ now: new Date('2026-07-15T16:00:00Z') });
    try {
      db
        .mockReturnValueOnce(chain({ first: { id: 'cust-1', first_name: 'A', last_name: 'B', zip: '34231' } }))
        .mockReturnValueOnce(chain({ rows: [] }))
        .mockReturnValueOnce(chain({ rows: [blackoutLimit(pgDate('2026-06-01'), pgDate('2026-09-30'))] }));

      const out = await ComplianceService.getProductLimits('cust-1');

      expect(out.limits[0]).toMatchObject({ limitType: 'seasonal_blackout', status: 'blackout_active' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('getProductLimits: another county\'s blackout stays ok for a Charlotte customer', async () => {
    jest.useFakeTimers({ now: new Date('2026-07-15T16:00:00Z') });
    try {
      db
        .mockReturnValueOnce(chain({ first: { id: 'cust-2', first_name: 'C', last_name: 'D', zip: '33948' } }))
        .mockReturnValueOnce(chain({ rows: [] }))
        .mockReturnValueOnce(chain({ rows: [blackoutLimit(pgDate('2026-06-01'), pgDate('2026-09-30'))] }));

      const out = await ComplianceService.getProductLimits('cust-2');

      expect(out.limits[0]).toMatchObject({ limitType: 'seasonal_blackout', status: 'ok' });
    } finally {
      jest.useRealTimers();
    }
  });
});
