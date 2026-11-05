/**
 * Owner ruling D2 A (2026-11-04): a technician's day and week schedule rows keep
 * the balance-due facts and the per-visit prices checkout reads, and lose the
 * customer's monthly rate (row and billingLane) and lead score. An admin's rows
 * stay exactly as they were. The feed wiring is pinned against real PostgreSQL in
 * admin-schedule-technician-money-feed.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { stripTechOwnerOnlyMoney } = require('../routes/admin-schedule');

function row() {
  return {
    id: 'svc-1',
    monthlyRate: 89,
    leadScore: 70,
    estimatedPrice: 120,
    prepaidAmount: 0,
    checkoutInvoiceTotal: 120,
    billingLane: {
      mode: 'monthly_membership',
      monthlyRate: 89,
      openBalance: 45,
      openInvoiceCount: 1,
      hasOverdue: true,
      duesPaidThisMonth: true,
      prediction: { kind: 'invoice', amount: 120 },
    },
  };
}

describe('stripTechOwnerOnlyMoney', () => {
  test('a technician gets no monthlyRate or leadScore, on the row or in billingLane', () => {
    const rows = [row()];
    stripTechOwnerOnlyMoney({ techRole: 'technician', technicianId: 't1' }, rows);
    expect(rows[0]).not.toHaveProperty('monthlyRate');
    expect(rows[0]).not.toHaveProperty('leadScore');
    expect(rows[0].billingLane).not.toHaveProperty('monthlyRate');
  });

  test('a technician still gets the balance due, the dues flag and the per-visit prices', () => {
    const rows = [row()];
    stripTechOwnerOnlyMoney({ techRole: 'technician', technicianId: 't1' }, rows);
    expect(rows[0].billingLane).toMatchObject({
      openBalance: 45, openInvoiceCount: 1, hasOverdue: true, duesPaidThisMonth: true,
      prediction: { kind: 'invoice', amount: 120 },
    });
    expect(rows[0]).toMatchObject({ estimatedPrice: 120, checkoutInvoiceTotal: 120 });
  });

  test('a row with no billingLane does not throw', () => {
    const rows = [{ id: 'svc-2', monthlyRate: 10 }];
    expect(() => stripTechOwnerOnlyMoney({ techRole: 'technician' }, rows)).not.toThrow();
    expect(rows[0]).not.toHaveProperty('monthlyRate');
  });

  test('an admin still gets every field', () => {
    const rows = [row()];
    stripTechOwnerOnlyMoney({ techRole: 'admin' }, rows);
    expect(rows[0]).toEqual(row());
  });
});
