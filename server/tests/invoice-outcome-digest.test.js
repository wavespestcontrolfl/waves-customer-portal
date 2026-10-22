const { countProcessedInvoices, invoiceNotLogged } = require('../services/email/invoice-outcome');

test('daily digest counts only invoices that reached booking', () => {
  const emails = [
    { classification: 'vendor_invoice', auto_action: 'expense_created:10' },
    { classification: 'vendor_invoice', auto_action: 'expense_duplicate:10' },
    { classification: 'vendor_invoice', auto_action: null },
    { classification: 'vendor_invoice', auto_action: 'invoice_detected:unauthenticated' },
    { classification: 'vendor_invoice', auto_action: 'invoice_detected:not_paid' },
    { classification: 'vendor_invoice', auto_action: 'invoice_detected:unauthenticated', expense_id: 'e1' },
    { classification: 'lead_inquiry', auto_action: null },
  ];
  expect(countProcessedInvoices(emails)).toBe(4);
  expect(countProcessedInvoices([])).toBe(0);
});

test('invoiceNotLogged matches the invoice_detected stop-short markers only', () => {
  expect(invoiceNotLogged('invoice_detected:unauthenticated')).toBe(true);
  expect(invoiceNotLogged('expense_created:5')).toBe(false);
  expect(invoiceNotLogged(undefined)).toBe(false);
});
