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

describe('unbilledVisitAlert (day-view money-gap flag)', () => {
  const { unbilledVisitAlert } = adminScheduleRouter._test;

  const gapPrediction = { kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'no_amount_on_file' };

  test('flags a visit that will bill nothing for lack of a number', () => {
    expect(unbilledVisitAlert({ hasChargeableMethod: false, prediction: gapPrediction }))
      .toEqual({ type: 'unbilled_visit', text: 'NOTHING WILL BILL — no rate set and no card on file' });
  });

  test('drops the card clause when the customer HAS a chargeable method', () => {
    expect(unbilledVisitAlert({ hasChargeableMethod: true, prediction: gapPrediction }))
      .toEqual({ type: 'unbilled_visit', text: 'NOTHING WILL BILL — no rate or price set for this visit' });
  });

  test('never claims "no card on file" when the wallet was not read', () => {
    expect(unbilledVisitAlert({ prediction: gapPrediction }).text)
      .toBe('NOTHING WILL BILL — no rate or price set for this visit');
  });

  test('stays silent on visits that are free BY DESIGN', () => {
    for (const reason of ['callback', 'always_free_service_type', 'annual_renewal_owned']) {
      expect(unbilledVisitAlert({
        hasChargeableMethod: false,
        prediction: { ...gapPrediction, reason },
      })).toBeNull();
    }
  });

  test('stays silent whenever money IS moving', () => {
    for (const kind of ['invoice', 'auto_charge', 'payer', 'prepaid', 'covered_membership', 'covered_annual']) {
      expect(unbilledVisitAlert({
        hasChargeableMethod: false,
        prediction: { kind, amount: 183, conflictStampedPrice: false },
      })).toBeNull();
    }
    expect(unbilledVisitAlert({ hasChargeableMethod: false, prediction: null })).toBeNull();
  });
});
