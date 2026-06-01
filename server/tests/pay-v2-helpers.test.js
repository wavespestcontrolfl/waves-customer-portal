const { shouldSkipClientPaymentErrorAlert } = require('../routes/pay-v2-helpers');

describe('pay-v2 helpers', () => {
  test('client payment error reports are allowed for collectible invoices', () => {
    expect(shouldSkipClientPaymentErrorAlert({ status: 'sent' })).toBe(false);
    expect(shouldSkipClientPaymentErrorAlert({ status: 'overdue' })).toBe(false);
    expect(shouldSkipClientPaymentErrorAlert({ status: null })).toBe(false);
  });

  test('client payment error reports skip non-collectible invoice links', () => {
    for (const status of ['paid', 'processing', 'void', 'refunded', 'canceled', 'cancelled']) {
      expect(shouldSkipClientPaymentErrorAlert({ status })).toBe(true);
    }
  });
});
