const adminScheduleRouter = require('../routes/admin-schedule');

describe('noCardOnFileAlert (day-view propertyAlerts payment flag)', () => {
  const { noCardOnFileAlert } = adminScheduleRouter._test;

  test('flags a customer with nothing saved and homeowner-billed visit', () => {
    expect(noCardOnFileAlert({
      hasMethodOnFile: false,
      billedToPayerId: null,
      prepaidMethod: null,
      checkoutInvoicePaid: false,
    })).toEqual({ type: 'no_card_on_file', text: 'NO CARD ON FILE — collect payment on site' });
  });

  test('stays silent when any saved payment method exists', () => {
    expect(noCardOnFileAlert({
      hasMethodOnFile: true,
      billedToPayerId: null,
      prepaidMethod: null,
      checkoutInvoicePaid: false,
    })).toBeNull();
  });

  test('stays silent for third-party-billed visits — that AR is the payer\'s', () => {
    expect(noCardOnFileAlert({
      hasMethodOnFile: false,
      billedToPayerId: 'payer-uuid',
      prepaidMethod: null,
      checkoutInvoicePaid: false,
    })).toBeNull();
  });

  test('stays silent when the visit is prepaid (incl. annual-prepay stamp)', () => {
    expect(noCardOnFileAlert({
      hasMethodOnFile: false,
      billedToPayerId: null,
      prepaidMethod: 'annual_prepay_invoice',
      checkoutInvoicePaid: false,
    })).toBeNull();
  });

  test('stays silent once the checkout invoice is paid — collection already happened', () => {
    expect(noCardOnFileAlert({
      hasMethodOnFile: false,
      billedToPayerId: null,
      prepaidMethod: null,
      checkoutInvoicePaid: true,
    })).toBeNull();
  });
});
