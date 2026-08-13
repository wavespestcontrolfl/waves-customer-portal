const adminScheduleRouter = require('../routes/admin-schedule');

describe('noCardOnFileAlert (day-view propertyAlerts payment flag)', () => {
  const { noCardOnFileAlert } = adminScheduleRouter._test;

  const invoiceDue = { kind: 'invoice', amount: 183, conflictStampedPrice: false };

  test('flags an empty wallet when completion will cut an invoice', () => {
    expect(noCardOnFileAlert({ hasChargeableMethod: false, prediction: invoiceDue }))
      .toEqual({ type: 'no_card_on_file', text: 'NO CARD ON FILE — collect payment on site' });
  });

  test('stays silent when a chargeable method exists', () => {
    expect(noCardOnFileAlert({ hasChargeableMethod: true, prediction: invoiceDue })).toBeNull();
  });

  test('stays silent for every non-invoice prediction kind', () => {
    // payer AR, prepaid/paid, dues- or annual-covered, and free
    // callback/follow-up visits — nothing to collect at the door.
    for (const kind of ['payer', 'prepaid', 'covered_membership', 'covered_annual', 'auto_charge', 'no_charge']) {
      expect(noCardOnFileAlert({
        hasChargeableMethod: false,
        prediction: { kind, amount: 183, conflictStampedPrice: false },
      })).toBeNull();
    }
  });

  test('stays silent on a zero/absent invoice amount or missing prediction', () => {
    expect(noCardOnFileAlert({
      hasChargeableMethod: false,
      prediction: { kind: 'invoice', amount: 0, conflictStampedPrice: false },
    })).toBeNull();
    expect(noCardOnFileAlert({
      hasChargeableMethod: false,
      prediction: { kind: 'invoice', amount: null, conflictStampedPrice: false },
    })).toBeNull();
    expect(noCardOnFileAlert({ hasChargeableMethod: false, prediction: null })).toBeNull();
  });
});
