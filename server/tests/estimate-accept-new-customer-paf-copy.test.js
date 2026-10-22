process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Owner 2026-10-21: "why when it says estimates accepted does it say send the
// invoice, the invoice is collected after the application". A NEW customer on
// the card-on-file lane (pay after the first visit) reached the generic
// "Invoice follow-up needed" fall-through because only the existing-customer
// flag (afterVisitBilling) had its own branch. Copy only: no billing change.

const { buildAcceptNotificationPayload } = require('../routes/estimate-public');

describe('accept notification copy (new customer, pay after first visit)', () => {
  const base = {
    customerName: 'Pat Tester', waveguardTier: 'Bronze', monthlyTotal: 49,
    invoiceMode: false, invoicePayUrl: null, cardLaneAfterVisit: true,
  };

  test('first visit not booked: billed after the visit, and the one task is booking it', () => {
    const payload = buildAcceptNotificationPayload(base);
    expect(payload.adminBody).toBe('Bronze WaveGuard $49.00/mo approved. Billed after the first visit; nothing is charged today. No first visit is booked yet.');
    expect(payload.adminNext).toBe('Next: book the first visit');
    expect(payload.adminDoneWhen).toBe('visit_booked');
    expect(payload.adminWhy).toBe('Next: book the first visit.');
    expect(payload.customerBody).toBe('Your Bronze WaveGuard plan is confirmed. Nothing is charged today — you pay after your first visit.');
    expect(payload.adminBody + payload.adminNext + payload.customerBody).not.toMatch(/invoice/i);
  });

  test('first visit booked with a date: names the day and asks for nothing', () => {
    const payload = buildAcceptNotificationPayload({ ...base, reservationCommitted: true, firstVisitDate: '2026-10-24' });
    expect(payload.adminBody).toBe('Bronze WaveGuard $49.00/mo approved. Billed after the first visit; nothing is charged today. First visit: Oct 24.');
    expect(payload.adminNext).toBe('Billed after the first visit; nothing to do');
    expect(payload.adminDoneWhen).toBeNull();
    expect(payload.customerBody).toBe('Your Bronze WaveGuard plan is confirmed. Nothing is charged today — you pay after your first visit.');
  });

  test('booked without a known date, and a date without the committed flag, both count as booked', () => {
    const noDate = buildAcceptNotificationPayload({ ...base, reservationCommitted: true });
    expect(noDate.adminNext).toBe('Billed after the first visit; nothing to do');
    expect(noDate.adminBody).not.toMatch(/First visit:|No first visit/);
    const dateOnly = buildAcceptNotificationPayload({ ...base, firstVisitDate: new Date('2026-11-02T00:00:00Z') });
    expect(dateOnly.adminBody).toMatch(/First visit: Nov 2\.$/);
    expect(dateOnly.adminDoneWhen).toBeNull();
  });

  test('a malformed date is ignored, not printed', () => {
    const payload = buildAcceptNotificationPayload({ ...base, firstVisitDate: 'soon' });
    expect(payload.adminBody).not.toMatch(/soon/);
    expect(payload.adminNext).toBe('Next: book the first visit');
  });

  test('the headline keeps the "<name> accepted <tier> $X/mo" shape', () => {
    const payload = buildAcceptNotificationPayload(base);
    expect(payload.adminAction).toBe('Pat Tester accepted Bronze $49.00/mo');
  });

  test('flag off: the true fall-through is unchanged', () => {
    const payload = buildAcceptNotificationPayload({ ...base, cardLaneAfterVisit: false });
    expect(payload.adminBody).toBe('Bronze WaveGuard $49.00/mo approved. Invoice follow-up needed.');
    expect(payload.adminNext).toBe('Next: send the invoice and check the first visit is booked');
    expect(payload.adminDoneWhen).toBe('invoice_followed_up');
    expect(payload.customerBody).toBe('Your Bronze WaveGuard plan is confirmed. Our team will follow up with the invoice details.');
  });

  test('earlier branches still win: a payable invoice, an existing-customer rail, a deferred setup fee, a third-party payer', () => {
    expect(buildAcceptNotificationPayload({ ...base, invoiceMode: true, invoiceLinkDelivered: true, invoicePayUrl: '/pay/tok' }).adminBody)
      .toMatch(/Invoice pay link sent\./);
    expect(buildAcceptNotificationPayload({ ...base, afterVisitBilling: true }).adminBody)
      .toMatch(/Existing customer on the card rail/);
    expect(buildAcceptNotificationPayload({ ...base, setupFeeDeferred: true }).adminBody)
      .toMatch(/setup fee stamped on the first visit/);
    expect(buildAcceptNotificationPayload({ ...base, payerBilled: true, invoiceMode: true, invoiceLinkDelivered: true }).adminBody)
      .toMatch(/third-party payer/);
  });
});
