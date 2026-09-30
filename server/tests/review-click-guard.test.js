/**
 * review-click-guard: a visit's date-only anchor is ET midnight, not UTC
 * midnight (Railway runs TZ=UTC), so a click the evening BEFORE the visit
 * never suppresses that visit's ask (pre-push P1 on the neutral-reviews PR).
 */
const guard = require('../services/review-click-guard');

function fakeDb({ serviceDate = null, scheduledDate = null, clicks = [] } = {}) {
  return (table) => {
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

  test('a click just after ET midnight on the visit day DOES suppress it', async () => {
    // 2026-09-30T04:30Z = Sept 30, 12:30 a.m. EDT
    const db = fakeDb({ serviceDate: '2026-09-30', clicks: ['2026-09-30T04:30:00Z'] });
    expect(await guard.touchSuppressedByClick('cust-1', { serviceRecordId: 'sr-1' }, db)).toBe(true);
  });
});
