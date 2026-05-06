const {
  validateEstimateDeliveryOptions,
} = require('../services/estimate-delivery-options');

describe('admin estimate delivery option validation', () => {
  test('rejects one-time option when estimate has no one-time total', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 0,
      monthlyTotal: 89,
      annualTotal: 1068,
    })).toMatch(/one-time total/i);
  });

  test('allows one-time option when estimate has a one-time total', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 250,
      monthlyTotal: 89,
      annualTotal: 1068,
    })).toBeNull();
  });

  test('rejects invoice mode when estimate has no billable total', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: false,
      billByInvoice: true,
      onetimeTotal: 0,
      monthlyTotal: 0,
      annualTotal: 0,
    })).toMatch(/billable/i);
  });

  test('allows invoice mode for recurring or one-time totals', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: false,
      billByInvoice: true,
      onetimeTotal: 0,
      monthlyTotal: 89,
      annualTotal: 1068,
    })).toBeNull();

    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: false,
      billByInvoice: true,
      onetimeTotal: 250,
      monthlyTotal: 0,
      annualTotal: 0,
    })).toBeNull();
  });
});
