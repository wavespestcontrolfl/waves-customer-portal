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

// Codex round 1 on #6412.
const { resolveCardLaneAfterVisit, resolveAcceptedFirstVisit } = require('../routes/estimate-public');

// Minimal knex stand-in: table -> row (or Error) for .where().[whereNotIn()].first().
const fakeDb = (tables) => (table) => {
  const chain = {
    where: () => chain,
    whereNotIn: () => chain,
    first: async () => {
      const value = tables[table];
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return chain;
};

describe('resolveCardLaneAfterVisit (billing lane the accept left on the customer)', () => {
  const args = { recurringCardLaneActive: true, treatAsOneTime: false, customerId: 'c1' };

  test('per_application customer: after-visit copy applies', async () => {
    const db = fakeDb({ customers: { billing_mode: 'per_application', waveguard_tier: 'Bronze', monthly_rate: 49, per_application_fee: 49 } });
    await expect(resolveCardLaneAfterVisit(args, db)).resolves.toBe(true);
  });

  test('per_application with nothing collectible (no fee, no priced first visit, no attached invoice): generic copy, which still asks a person to follow up', async () => {
    const db = fakeDb({ customers: { billing_mode: 'per_application', waveguard_tier: 'Bronze', monthly_rate: 49, per_application_fee: null } });
    await expect(resolveCardLaneAfterVisit(args, db)).resolves.toBe(false);
    await expect(resolveCardLaneAfterVisit({ ...args, attachedInvoiceTotal: 0, firstVisitPriced: false }, db)).resolves.toBe(false);
    const fallthrough = buildAcceptNotificationPayload({ customerName: 'Pat Tester', waveguardTier: 'Bronze', monthlyTotal: 49, cardLaneAfterVisit: false });
    expect(fallthrough.adminDoneWhen).toBe('invoice_followed_up');
  });

  test('each piece of collection evidence is enough on its own', async () => {
    const noFee = fakeDb({ customers: { billing_mode: 'per_application', per_application_fee: null } });
    await expect(resolveCardLaneAfterVisit({ ...args, attachedInvoiceTotal: 49 }, noFee)).resolves.toBe(true);
    await expect(resolveCardLaneAfterVisit({ ...args, firstVisitPriced: true }, noFee)).resolves.toBe(true);
    const zeroFee = fakeDb({ customers: { billing_mode: 'per_visit', per_application_fee: '0.00' } });
    await expect(resolveCardLaneAfterVisit(args, zeroFee)).resolves.toBe(false);
    const fee = fakeDb({ customers: { billing_mode: 'per_visit', per_application_fee: '65.00' } });
    await expect(resolveCardLaneAfterVisit(args, fee)).resolves.toBe(true);
  });

  test('monthly_membership accept (pinned legacy rodent-only plan, or a monthly member adding a service): no after-visit copy', async () => {
    const db = fakeDb({ customers: { billing_mode: 'monthly_membership', waveguard_tier: 'Bronze', monthly_rate: 49, per_application_fee: 49 } });
    await expect(resolveCardLaneAfterVisit({ ...args, attachedInvoiceTotal: 49, firstVisitPriced: true }, db)).resolves.toBe(false);
  });

  test('an unstamped legacy member (NULL mode, real tier, monthly rate) resolves to monthly dues: no after-visit copy', async () => {
    const db = fakeDb({ customers: { billing_mode: null, waveguard_tier: 'Silver', monthly_rate: 60 } });
    await expect(resolveCardLaneAfterVisit(args, db)).resolves.toBe(false);
  });

  test('annual prepay lane, missing row, read error, lane off, one-time and no customer all fail closed', async () => {
    await expect(resolveCardLaneAfterVisit(args, fakeDb({ customers: { billing_mode: 'annual_prepay' } }))).resolves.toBe(false);
    await expect(resolveCardLaneAfterVisit(args, fakeDb({ customers: undefined }))).resolves.toBe(false);
    await expect(resolveCardLaneAfterVisit(args, fakeDb({ customers: new Error('boom') }))).resolves.toBe(false);
    const ok = fakeDb({ customers: { billing_mode: 'per_application', per_application_fee: 49 } });
    await expect(resolveCardLaneAfterVisit({ ...args, recurringCardLaneActive: false }, ok)).resolves.toBe(false);
    await expect(resolveCardLaneAfterVisit({ ...args, treatAsOneTime: true }, ok)).resolves.toBe(false);
    await expect(resolveCardLaneAfterVisit({ ...args, customerId: null }, ok)).resolves.toBe(false);
  });
});

describe('resolveAcceptedFirstVisit (converter-created visits count)', () => {
  test('a committed appointment wins; earliest date is used', async () => {
    const out = await resolveAcceptedFirstVisit({
      acceptedAppointments: [{ scheduled_date: '2026-10-30' }, { scheduled_date: new Date('2026-10-24T00:00:00Z') }],
      conversionVisitId: 'ss1',
    }, fakeDb({}));
    expect(out).toEqual({ firstVisitDate: '2026-10-24', firstVisitBooked: true, firstVisitPriced: false });
  });

  test('no reservation: the converter-scheduled visit supplies the date', async () => {
    const out = await resolveAcceptedFirstVisit({
      acceptedAppointments: [], conversionVisitId: 'ss1',
    }, fakeDb({ scheduled_services: { scheduled_date: new Date('2026-11-03T00:00:00Z') } }));
    expect(out).toEqual({ firstVisitDate: '2026-11-03', firstVisitBooked: true, firstVisitPriced: false });
    const payload = buildAcceptNotificationPayload({
      customerName: 'Pat Tester', waveguardTier: 'Bronze', monthlyTotal: 49, cardLaneAfterVisit: true, ...out,
    });
    expect(payload.adminBody).toMatch(/First visit: Nov 3\.$/);
    expect(payload.adminBody).not.toMatch(/No first visit/);
    expect(payload.adminDoneWhen).toBeNull();
  });

  test('converter visit unreadable: still booked, no date, no visit_booked alert', async () => {
    const out = await resolveAcceptedFirstVisit({
      acceptedAppointments: [], conversionVisitId: 'ss1',
    }, fakeDb({ scheduled_services: new Error('boom') }));
    expect(out).toEqual({ firstVisitDate: null, firstVisitBooked: true, firstVisitPriced: false });
    const payload = buildAcceptNotificationPayload({
      customerName: 'Pat Tester', waveguardTier: 'Bronze', monthlyTotal: 49, cardLaneAfterVisit: true, ...out,
    });
    expect(payload.adminNext).toBe('Billed after the first visit; nothing to do');
    expect(payload.adminDoneWhen).toBeNull();
  });

  test('converter visit cancelled / gone, or no visit at all: not booked', async () => {
    expect(await resolveAcceptedFirstVisit({ acceptedAppointments: [], conversionVisitId: 'ss1' }, fakeDb({ scheduled_services: undefined })))
      .toEqual({ firstVisitDate: null, firstVisitBooked: false, firstVisitPriced: false });
    expect(await resolveAcceptedFirstVisit({ acceptedAppointments: undefined, conversionVisitId: null }, fakeDb({})))
      .toEqual({ firstVisitDate: null, firstVisitBooked: false, firstVisitPriced: false });
  });
});

describe('resolveAcceptedFirstVisit (earliest converter unit, priced flag)', () => {
  test('two units, the first inserted rolls later: the label shows the earlier date', async () => {
    // firstScheduledServiceId points at the seasonal unit inserted first (Feb);
    // the converter reports the earliest inserted unit date (Oct 29).
    const out = await resolveAcceptedFirstVisit({
      acceptedAppointments: [],
      conversionVisitId: 'ss-seasonal',
      conversionEarliestDate: '2026-10-29',
    }, fakeDb({ scheduled_services: { scheduled_date: '2027-02-08', estimated_price: 40 } }));
    expect(out.firstVisitDate).toBe('2026-10-29');
    expect(out.firstVisitBooked).toBe(true);
    const payload = buildAcceptNotificationPayload({
      customerName: 'Pat Tester', waveguardTier: 'Bronze', monthlyTotal: 49, cardLaneAfterVisit: true, ...out,
    });
    expect(payload.adminBody).toMatch(/First visit: Oct 29\.$/);
    expect(payload.adminBody).not.toMatch(/Feb/);
  });

  test('earliest date as a Date, and with the id row unreadable, still wins', async () => {
    const out = await resolveAcceptedFirstVisit({
      acceptedAppointments: [], conversionVisitId: 'ss1', conversionEarliestDate: new Date('2026-11-03T00:00:00Z'),
    }, fakeDb({ scheduled_services: new Error('boom') }));
    expect(out).toEqual({ firstVisitDate: '2026-11-03', firstVisitBooked: true, firstVisitPriced: false });
  });

  test('without the earliest date the id row date is the fallback', async () => {
    const out = await resolveAcceptedFirstVisit({
      acceptedAppointments: [], conversionVisitId: 'ss1',
    }, fakeDb({ scheduled_services: { scheduled_date: '2026-11-05', estimated_price: '49.00' } }));
    expect(out).toEqual({ firstVisitDate: '2026-11-05', firstVisitBooked: true, firstVisitPriced: true });
  });

  test('priced flag follows the committed appointment or the converter row', async () => {
    expect((await resolveAcceptedFirstVisit({ acceptedAppointments: [{ scheduled_date: '2026-10-24', estimated_price: 49 }] }, fakeDb({}))).firstVisitPriced).toBe(true);
    expect((await resolveAcceptedFirstVisit({ acceptedAppointments: [{ scheduled_date: '2026-10-24', estimated_price: null }] }, fakeDb({}))).firstVisitPriced).toBe(false);
    expect((await resolveAcceptedFirstVisit({ acceptedAppointments: [], conversionVisitId: 'ss1' }, fakeDb({ scheduled_services: { scheduled_date: '2026-11-05', estimated_price: null } }))).firstVisitPriced).toBe(false);
  });
});
