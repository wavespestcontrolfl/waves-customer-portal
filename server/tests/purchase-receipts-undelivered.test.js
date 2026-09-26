/**
 * purchase-receipts/undelivered-shipments.js — when an unconfirmed Amazon
 * shipment counts as one whose Delivered email was skipped. The phrases are
 * the forms every real "Shipped:" email used; each real Delivered email
 * came on or before its promised day, so the alert waits out that day and
 * the next, on the ET calendar. The DB side runs in
 * purchase-receipts-postgres.test.js.
 */
const { alertAfter } = require('../services/purchase-receipts/undelivered-shipments');

const at = (bodyText, receivedAt) => alertAfter({ body_text: bodyText, received_at: new Date(receivedAt) });

describe('alertAfter', () => {
  test.each([
    ['Arriving Wednesday', '2026-09-13T17:12:00Z', '2026-09-16', '2026-09-18T04:00:00.000Z'], // Sunday -> Wednesday
    ['Arriving today 10 AM – 3 PM', '2026-05-30T09:22:00Z', '2026-05-30', '2026-06-01T04:00:00.000Z'],
    ['Arriving tomorrow', '2026-09-09T00:54:00Z', '2026-09-09', '2026-09-11T04:00:00.000Z'], // 8:54 PM ET on Sep 8
    ['Arriving June 16 - June 18', '2026-06-14T12:26:00Z', '2026-06-18', '2026-06-20T04:00:00.000Z'], // a range: its last day
    ['Arriving Monday', '2026-08-03T09:45:00Z', '2026-08-10', '2026-08-12T04:00:00.000Z'], // sent on a Monday: next week
    ['Arriving January 2', '2026-12-30T15:00:00Z', '2027-01-02', '2027-01-04T05:00:00.000Z'], // across the new year, EST
  ])('"%s" shipped %s is due %s; alerts from %s', (text, shippedAt, due, alertFrom) => {
    const { promised, at: alertAt } = at(`Order #\n900-1\n${text}\n`, shippedAt);
    expect(promised.toISOString().slice(0, 10)).toBe(due);
    expect(alertAt.toISOString()).toBe(alertFrom);
  });

  test.each([
    ['an HTML-only email', { body_text: '', body_html: '<table><tr><td>Arriving Wednesday</td><td>Order placed September 10</td></tr></table>' }],
    ['a range followed by another date on the same line', { body_text: '', body_html: '<td>Arriving September 15 - September 16 Order placed September 10</td>' }],
  ])('%s still reads its promised day (September 16)', (_label, body) => {
    const { promised } = alertAfter({ ...body, received_at: new Date('2026-09-13T17:12:00Z') });
    expect(promised.toISOString().slice(0, 10)).toBe('2026-09-16');
  });

  test('no promised day: 3 days after the Shipped email', () => {
    expect(at('Order #\n900-1\n* Thing\n', '2026-09-13T17:12:00Z')).toEqual({ at: new Date('2026-09-16T17:12:00Z'), promised: null });
  });
});
