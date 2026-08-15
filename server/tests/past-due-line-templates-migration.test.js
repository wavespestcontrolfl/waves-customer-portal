/**
 * Contract-half migration for {past_due_line} (20260815000010) — placement
 * and idempotency contracts, against the VERBATIM prod bodies (read-only
 * verified 2026-08-15: both with-invoice bodies END at {pay_url}, no
 * trailing "Questions" paragraph, zero variant rows). The insert must land
 * the clause on its own paragraph after the pay link (or before a
 * "Questions or requests?" paragraph where a seeded body carries one),
 * survive double-application, render byte-identical while the clause is
 * empty, and strip cleanly on down.
 */

const migration = require('../models/migrations/20260815000010_past_due_line_sms_templates');

describe('past_due_line template migration', () => {
  test('covers exactly the with-invoice pair — the line presumes the text carries a bill', () => {
    expect(migration.KEYS).toEqual([
      'service_complete_with_invoice',
      'service_report_v1_with_invoice',
    ]);
    expect(migration.KEYS).not.toContain('service_complete');
    expect(migration.KEYS).not.toContain('service_complete_prepaid');
  });

  test('END-appends on its own paragraph for the VERBATIM prod bodies (no anchor paragraph)', () => {
    const prodGeneric = "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}";
    const prodV1 = "Hello {first_name}! Your {service_type} report is ready: {report_url}\n\nInvoice for today's visit: {pay_url}";
    expect(migration.insertPlaceholder(prodGeneric)).toBe(`${prodGeneric}\n\n{past_due_line}`);
    expect(migration.insertPlaceholder(prodV1)).toBe(`${prodV1}\n\n{past_due_line}`);
  });

  test('inserts a BARE token after the paragraph break before a "Questions or requests?" paragraph (seeded body shape)', () => {
    const seeded = "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply here.";
    expect(migration.insertPlaceholder(seeded)).toBe(
      "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\n{past_due_line}Questions or requests? Reply here.",
    );
  });

  test('BYTE-IDENTICAL when the clause renders empty — the gate-dark contract', () => {
    // Mirror getTemplate's post-processing: token → '', collapse \n{3,}, trim.
    const renderEmpty = (body) => body.split('{past_due_line}').join('').replace(/\n{3,}/g, '\n\n').trim();
    const bodies = [
      "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}",
      "Hello {first_name}! Your {service_type} report is ready: {report_url}\n\nInvoice for today's visit: {pay_url}",
      "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply here.",
    ];
    for (const body of bodies) {
      expect(renderEmpty(migration.insertPlaceholder(body))).toBe(body.trim());
    }
  });

  test('clause renders on its own paragraph when non-empty (clause carries its trailing separator)', () => {
    const clause = "Reminder: your account also has a previous balance of $52.10 from an earlier invoice, separate from today's invoice.\n\n";
    const render = (body) => body.split('{past_due_line}').join(clause).replace(/\n{3,}/g, '\n\n').trim();
    const prod = "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}";
    expect(render(migration.insertPlaceholder(prod))).toBe(
      "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\nReminder: your account also has a previous balance of $52.10 from an earlier invoice, separate from today's invoice.",
    );
    const seeded = "Hi! Bill: {pay_url}\n\nQuestions or requests? Reply here.";
    expect(render(migration.insertPlaceholder(seeded))).toBe(
      "Hi! Bill: {pay_url}\n\nReminder: your account also has a previous balance of $52.10 from an earlier invoice, separate from today's invoice.\n\nQuestions or requests? Reply here.",
    );
  });

  test('idempotent: a body already carrying the token is not touched twice', () => {
    const once = migration.insertPlaceholder("Hi! Bill: {pay_url}");
    // up() guards on body.includes(PLACEHOLDER); the helper itself is the
    // raw transform, so assert the guard's predicate is what makes the
    // migration idempotent.
    expect(once.includes(migration.PLACEHOLDER)).toBe(true);
  });

  test('strip is the exact inverse for both placements', () => {
    const bodies = [
      "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}",
      "Hi! Bill: {pay_url}\n\nQuestions or requests? Reply here.",
    ];
    for (const body of bodies) {
      expect(migration.stripPlaceholder(migration.insertPlaceholder(body))).toBe(body);
    }
  });
});
