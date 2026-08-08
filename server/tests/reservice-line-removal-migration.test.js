/**
 * Removal migration for {reservice_line} (20260808060000) — the exact inverse
 * of the 20260808030000 append, over the VERBATIM prod bodies. Stripping must
 * restore the pre-clause body byte-for-byte (both placements), leave a
 * paragraph break the ORIGINAL body owns intact, and stay idempotent.
 */

const removal = require('../models/migrations/20260808060000_remove_reservice_line_sms_templates');
const append = require('../models/migrations/20260808030000_reservice_line_sms_templates');

// Verified read-only 2026-08-08 (see 20260808030000's own contract test).
const PROD_BODIES = [
  'Hello {first_name}! Your service report is ready: {portal_url}',
  'Thanks for having us out, {first_name}! A Google review would mean a lot: {review_url}\n\nReply STOP to opt out.',
  'Hello {first_name}! Thanks for your payment today. Your {service_type} report is ready: {portal_url}',
  'Hello {first_name}! Payment received, ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\nReceipt: {receipt_url}',
  "Hello {first_name}! Your {service_type} report is ready: {report_url}\n\nInvoice for today's visit: {pay_url}",
];

describe('reservice_line removal migration', () => {
  test('covers the same key set the append targeted — nothing left carrying the token', () => {
    expect(removal.KEYS).toEqual(append.KEYS);
    expect(removal.PLACEHOLDER).toBe('{reservice_line}');
    expect(removal.VAR_NAME).toBe('reservice_line');
  });

  test('restores every prod body byte-for-byte after the append', () => {
    for (const body of PROD_BODIES) {
      expect(removal.stripPlaceholder(append.appendPlaceholder(body))).toBe(body);
    }
  });

  test('keeps the paragraph break the original body owns (mid-body placement)', () => {
    const appended = append.appendPlaceholder('Hi! Link: {review_url}\n\nReply STOP to opt out.');
    expect(appended).toContain('\n\n{reservice_line}Reply STOP');
    expect(removal.stripPlaceholder(appended)).toBe('Hi! Link: {review_url}\n\nReply STOP to opt out.');
  });

  test('drops the trailing break the append added (end placement)', () => {
    const appended = append.appendPlaceholder('Hi! Report: {portal_url}');
    expect(removal.stripPlaceholder(appended)).toBe('Hi! Report: {portal_url}');
  });

  test('idempotent — stripping a body without the token is a no-op', () => {
    for (const body of PROD_BODIES) {
      expect(removal.stripPlaceholder(body)).toBe(body);
      expect(removal.stripPlaceholder(removal.stripPlaceholder(append.appendPlaceholder(body)))).toBe(body);
    }
  });

  test('down re-appends exactly what the original migration wrote', () => {
    for (const body of PROD_BODIES) {
      expect(removal.appendPlaceholder(body)).toBe(append.appendPlaceholder(body));
    }
  });

  test('no re-service clause survives a render of the stripped bodies', () => {
    // Mirror getTemplate's post-processing on a body that still carries the
    // token (migration pending) with the retired helper's '' value.
    const renderEmpty = (b) => b.split('{reservice_line}').join('').replace(/\n{3,}/g, '\n\n').trim();
    for (const body of PROD_BODIES) {
      const stripped = removal.stripPlaceholder(append.appendPlaceholder(body));
      expect(renderEmpty(append.appendPlaceholder(body))).toBe(stripped.trim());
      expect(stripped).not.toContain('re-service');
    }
  });
});
