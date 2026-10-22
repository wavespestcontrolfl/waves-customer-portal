const { countProcessedInvoices } = require('../services/email/invoice-outcome');

test('daily digest counts only vendor invoices linked to an expense', () => {
  const emails = [
    { classification: 'vendor_invoice', auto_action: 'expense_created:10', expense_id: 'e1' },
    { classification: 'vendor_invoice', auto_action: 'expense_duplicate:10', expense_id: 'e2' },
    { classification: 'vendor_invoice', auto_action: 'invoice_detected:unauthenticated', expense_id: 'e3' },
    { classification: 'vendor_invoice', auto_action: null },
    { classification: 'vendor_invoice', auto_action: 'operational_sender_skipped' },
    { classification: 'vendor_invoice', auto_action: 'invoice_detected:unauthenticated' },
    { classification: 'vendor_invoice', auto_action: 'invoice_detected:not_paid' },
    { classification: 'lead_inquiry', auto_action: null, expense_id: 'e9' },
  ];
  expect(countProcessedInvoices(emails)).toBe(3);
  expect(countProcessedInvoices([])).toBe(0);
});
