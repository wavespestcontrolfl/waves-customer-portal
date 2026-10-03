/**
 * review-click-guard: a visit's date-only anchor is ET midnight, not UTC
 * midnight (Railway runs TZ=UTC), so a click the evening BEFORE the visit
 * never suppresses that visit's ask (pre-push P1 on the neutral-reviews PR).
 */
const guard = require('../services/review-click-guard');

function fakeDb({ serviceDate = null, scheduledDate = null, clicks = [], saidReviewed = false } = {}) {
  return (table) => {
    if (table === 'review_sequences') {
      const q = { where: () => q, whereNotNull: () => q, whereRaw: () => q, first: async () => (saidReviewed ? { id: 'seq-1' } : null) };
      return q;
    }
    if (table === 'service_records') return { where: () => ({ first: async () => (serviceDate ? { service_date: serviceDate } : null) }) };
    if (table === 'scheduled_services') return { where: () => ({ first: async () => (scheduledDate ? { scheduled_date: scheduledDate } : null) }) };
    if (table === 'review_requests') {
      let since = null;
      const q = {
        where(arg) {
          if (typeof arg === 'function') {
            const b = { where: (_col, _op, value) => { since = value; return b; }, orWhere: () => b };
            arg(b);
          }
          return q;
        },
        whereNotNull: () => q,
        first: async () => (clicks.some((c) => new Date(c) >= new Date(since)) ? { id: 'rr-1' } : null),
      };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  };
}

describe('review-click-guard visit anchor', () => {
  test.each([
    ['a date string (EDT)', '2026-09-30', '2026-09-30T04:00:00.000Z'],
    ['a pg Date at UTC midnight (EDT)', new Date('2026-09-30T00:00:00Z'), '2026-09-30T04:00:00.000Z'],
    ['a date string (EST)', '2026-12-15', '2026-12-15T05:00:00.000Z'],
  ])('%s anchors at ET midnight', async (_label, serviceDate, expected) => {
    const anchor = await guard.visitAnchor({ serviceRecordId: 'sr-1' }, fakeDb({ serviceDate }));
    expect(anchor.toISOString()).toBe(expected);
  });

  test('the scheduled visit date anchors at ET midnight too', async () => {
    const anchor = await guard.visitAnchor({ scheduledServiceId: 'ss-1' }, fakeDb({ scheduledDate: '2026-09-30' }));
    expect(anchor.toISOString()).toBe('2026-09-30T04:00:00.000Z');
  });

  test('a 9 p.m. ET click the evening before the visit does NOT suppress the visit ask', async () => {
    // 2026-09-30T01:00Z = Sept 29, 9:00 p.m. EDT
    const db = fakeDb({ serviceDate: '2026-09-30', clicks: ['2026-09-30T01:00:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { serviceRecordId: 'sr-1' }, db)).toBe(false);
  });

  test('a cadence with no visit anchors at its own start (fallbackAnchor): only a click after it began counts', async () => {
    const started = '2026-09-20T15:00:00Z';
    const after = fakeDb({ clicks: ['2026-09-21T15:00:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { fallbackAnchor: started }, after)).toBe(true);
    const before = fakeDb({ clicks: ['2026-09-19T15:00:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { fallbackAnchor: started }, before)).toBe(false);
    // no visit and no fallback → no anchor → never suppressed
    expect(await guard.touchSuppressedByClick('cust-1', {}, after)).toBe(false);
  });

  test('a click just after ET midnight on the visit day DOES suppress it', async () => {
    // 2026-09-30T04:30Z = Sept 30, 12:30 a.m. EDT
    const db = fakeDb({ serviceDate: '2026-09-30', clicks: ['2026-09-30T04:30:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { serviceRecordId: 'sr-1' }, db)).toBe(true);
  });
});

describe('newestCompletedVisitAnchor ordering matches the anchor instant', () => {
  // The ORDER BY runs in Postgres (the unit fakes cannot evaluate it), so pin the
  // contract: same-day scheduled visits are ordered by the SAME instant
  // scheduledInstant() reads (actual end, then check-out, then completed_at).
  test('scheduled visits order same-day ties by COALESCE(actual_end_time, check_out_time, completed_at)', async () => {
    const raws = {};
    const fake = (table) => {
      const q = {
        where: () => q,
        orderBy: () => q,
        orderByRaw: (sql) => { raws[table] = sql; return q; },
        first: async () => (table === 'scheduled_services'
          ? { scheduled_date: '2026-09-25', actual_end_time: null, check_out_time: '2026-09-25T20:00:00Z', completed_at: '2026-09-25T13:00:00Z' }
          : null),
      };
      return q;
    };
    const anchor = await guard.newestCompletedVisitAnchor('cust-1', fake);
    expect(raws.scheduled_services).toMatch(/COALESCE\(\s*actual_end_time\s*,\s*check_out_time\s*,\s*completed_at\s*\)\s+DESC\s+NULLS\s+LAST/i);
    // ...and the anchor reads check_out_time before completed_at, like the ORDER BY.
    expect(anchor.toISOString()).toBe('2026-09-25T20:00:00.000Z');
  });
});

describe('a confirmed "I already left a review" text (GATE_REVIEW_ASK_TECH_VOICE)', () => {
  const gates = require('../config/feature-gates');
  afterEach(() => jest.restoreAllMocks());

  test('suppresses every ask at send time, a reserved one queued before the claim included', async () => {
    jest.spyOn(gates, 'isEnabled').mockImplementation((g) => g === 'reviewAskTechVoice');
    const db = fakeDb({ serviceDate: '2026-09-30', saidReviewed: true });
    expect(await guard.touchSuppressedByClick('cust-1', { serviceRecordId: 'sr-1' }, db)).toBe(true);
    expect(await guard.askSuppressedByClick({ customer_id: 'cust-1', service_record_id: 'sr-1' }, db)).toBe(true);
    expect(await guard.touchSuppressedByClick('cust-1', { serviceRecordId: 'sr-1' }, fakeDb({ serviceDate: '2026-09-30' }))).toBe(false);
  });

  test('switch off: the stored claim is never read', async () => {
    jest.spyOn(gates, 'isEnabled').mockReturnValue(false);
    const db = fakeDb({ serviceDate: '2026-09-30', saidReviewed: true });
    expect(await guard.touchSuppressedByClick('cust-1', { serviceRecordId: 'sr-1' }, db)).toBe(false);
  });
});
