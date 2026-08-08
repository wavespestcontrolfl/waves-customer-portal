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

  test('inserts a BARE token after the existing paragraph break before Reply STOP (prod review_request body)', () => {
    const prod = 'Hello {first_name}! How was your service? Your feedback helps us: {review_url}\n\nReply STOP to opt out.';
    const out = migration.appendPlaceholder(prod);
    expect(out).toBe('Hello {first_name}! How was your service? Your feedback helps us: {review_url}\n\n{reservice_line}Reply STOP to opt out.');
  });

  test('appends on its own paragraph when no anchor exists (prod service_complete body)', () => {
    const prod = 'Hello {first_name}! Your service report is ready: {portal_url}';
    expect(migration.appendPlaceholder(prod))
      .toBe('Hello {first_name}! Your service report is ready: {portal_url}\n\n{reservice_line}');
  });

  test('BYTE-IDENTICAL when the clause renders empty — the gate-dark contract', () => {
    // Mirror getTemplate's post-processing: token → '', collapse \n{3,}, trim.
    const renderEmpty = (body) => body.split('{reservice_line}').join('').replace(/\n{3,}/g, '\n\n').trim();
    const prodBodies = [
      'Hello {first_name}! How was your service? Your feedback helps us: {review_url}\n\nReply STOP to opt out.',
      'Hello {first_name}! Your service report is ready: {portal_url}',
      'Hello {first_name}! Thanks for your payment today. Your {service_type} report is ready: {portal_url}',
      'Hello {first_name}! Payment received, ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\nReceipt: {receipt_url}',
      'Hello {first_name}! Your {service_type} report is ready: {report_url}\n\nInvoice for today\'s visit: {pay_url}',
    ];
    for (const body of prodBodies) {
      expect(renderEmpty(migration.appendPlaceholder(body))).toBe(body.trim());
    }
  });

  test('clause renders on its own paragraph when non-empty (clause carries its trailing separator)', () => {
    const clause = 'If a covered issue comes back, book a free re-service: https://x/y\n\n';
    const render = (body) => body.split('{reservice_line}').join(clause).replace(/\n{3,}/g, '\n\n').trim();
    const withStop = migration.appendPlaceholder('Hi! Link: {review_url}\n\nReply STOP to opt out.');
    expect(render(withStop)).toBe('Hi! Link: {review_url}\n\nIf a covered issue comes back, book a free re-service: https://x/y\n\nReply STOP to opt out.');
    const plain = migration.appendPlaceholder('Hi! Report: {portal_url}');
    expect(render(plain)).toBe('Hi! Report: {portal_url}\n\nIf a covered issue comes back, book a free re-service: https://x/y');
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
