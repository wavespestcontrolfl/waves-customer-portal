const adminInvoicesRoute = require('../routes/admin-invoices');

const { invoiceRecipientOverrideError } = adminInvoicesRoute._private;

describe('admin invoice recipient override validation', () => {
  test('rejects invalid invoice recipient email format', () => {
    expect(invoiceRecipientOverrideError('not-an-email', false))
      .toBe('Enter a valid invoice recipient email.');
  });

  test('rejects non-boolean save-as-default flags', () => {
    expect(invoiceRecipientOverrideError('billing@example.com', 'false'))
      .toBe('saveBillingRecipient must be true or false.');
  });

  test('rejects over-length billing recipient email when saving as default', () => {
    const localPart = 'a'.repeat(190);

    expect(invoiceRecipientOverrideError(`${localPart}@example.com`, true))
      .toBe('Billing recipient email must be 200 characters or fewer.');
  });

  test('rejects over-length one-time invoice recipient email', () => {
    const localPart = 'a'.repeat(190);

    expect(invoiceRecipientOverrideError(`${localPart}@example.com`, false))
      .toBe('Invoice recipient email must be 200 characters or fewer.');
  });
});
