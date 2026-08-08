/**
 * Contract-half migration for {reservice_line} (20260808030000) — placement
 * and idempotency contracts, against the VERBATIM prod bodies (read-only
 * verified 2026-08-08). The append must land the clause on its own paragraph
 * before any trailing opt-out notice, survive double-application, and strip
 * cleanly on down.
 */

const migration = require('../models/migrations/20260808030000_reservice_line_sms_templates');

describe('reservice_line template migration', () => {
  test('covers exactly the owner-ruled key set — service_complete_with_invoice (legacy fallback lane, never in the ruling) excluded', () => {
    expect(migration.KEYS).toEqual([
      'service_complete',
      'service_complete_prepaid',
      'service_complete_annual_prepay',
      'service_complete_paid_receipt',
      'service_report_v1',
      'service_report_v1_with_invoice',
      'review_request',
    ]);
    expect(migration.KEYS).not.toContain('service_complete_with_invoice');
  });

  test('inserts before a trailing Reply STOP notice (prod review_request body)', () => {
    const prod = 'Hello {first_name}! How was your service? Your feedback helps us: {review_url}\n\nReply STOP to opt out.';
    const out = migration.appendPlaceholder(prod);
    expect(out).toBe('Hello {first_name}! How was your service? Your feedback helps us: {review_url}\n\n{reservice_line}\n\nReply STOP to opt out.');
  });

  test('appends on its own paragraph when no anchor exists (prod service_complete body)', () => {
    const prod = 'Hello {first_name}! Your service report is ready: {portal_url}';
    expect(migration.appendPlaceholder(prod))
      .toBe('Hello {first_name}! Your service report is ready: {portal_url}\n\n{reservice_line}');
  });

  test('strip is the exact inverse for both placements', () => {
    const bodies = [
      'Hello {first_name}! Your service report is ready: {portal_url}',
      'Hello {first_name}! How was your service? Your feedback helps us: {review_url}\n\nReply STOP to opt out.',
      'Hello {first_name}! Payment received, ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\nReceipt: {receipt_url}',
    ];
    for (const body of bodies) {
      expect(migration.stripPlaceholder(migration.appendPlaceholder(body))).toBe(body);
    }
  });

  test('single-brace token only — double braces would block every send at write-validation', () => {
    expect(migration.PLACEHOLDER).toBe('{reservice_line}');
    expect(migration.PLACEHOLDER).not.toMatch(/\{\{/);
  });
});
