const { assertInvoiceCollectible } = require('../services/invoice-helpers');

function shouldSkipClientPaymentErrorAlert(invoice) {
  if (!invoice) return false;
  try {
    assertInvoiceCollectible(invoice.status);
    return false;
  } catch {
    return true;
  }
}

module.exports = {
  shouldSkipClientPaymentErrorAlert,
};
