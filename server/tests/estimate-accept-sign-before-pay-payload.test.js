// Termite annual plan sign-before-pay — the accept route's customer-facing
// payloads (codex round 3 on #4819): the durable accept notifications point
// the customer at the signature instead of "approved, invoice to follow",
// and the already-accepted retry builder reports 'activation_pending' (not
// the impossible 'sign_agreement') once the agreement is signed but the
// plan has not finished activating.
describe('estimate accept — sign-before-pay payloads', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../models/db');
  });

  // Table-routed chainable knex double: `first()` answers per table,
  // awaiting the builder itself answers [].
  function fakeDb(firstByTable = {}) {
    const calls = [];
    const db = jest.fn((table) => {
      const builder = {};
      const chain = () => builder;
      ['where', 'whereRaw', 'whereNot', 'whereNotNull', 'whereNull', 'whereIn', 'orderBy', 'select', 'limit'].forEach((m) => {
        builder[m] = jest.fn((...args) => { calls.push({ table, method: m, args }); return chain(); });
      });
      builder.first = jest.fn(async () => (typeof firstByTable[table] === 'function' ? firstByTable[table]() : (firstByTable[table] ?? null)));
      builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return builder;
    });
    db.raw = jest.fn();
    db.calls = calls;
    return db;
  }

  const parkedEstimate = {
    id: 'est-1',
    status: 'accepted',
    customer_id: 'cust-1',
    accepted_service_mode: 'recurring',
    annual_plan_activation_status: 'awaiting_signature',
    estimate_data: { recurring: { services: [{ service: 'termite_bait', name: 'Termite Bait' }] } },
  };

  test('buildAcceptSuccessPayload: deferred → sign_agreement; signed-not-yet-active → activation_pending', () => {
    const { buildAcceptSuccessPayload } = require('../routes/estimate-public');
    expect(buildAcceptSuccessPayload({ billingTerm: 'prepay_annual', invoiceKind: 'annual_prepay_deferred' }).nextStep).toBe('sign_agreement');
    expect(buildAcceptSuccessPayload({ billingTerm: 'prepay_annual', invoiceKind: 'annual_prepay_activation_pending' }).nextStep).toBe('activation_pending');
  });

  // Slice 3b: the customer never signed within the abandon window — the
  // offer closed automatically. Never 'sign_agreement' (that link is dead).
  test('buildAcceptSuccessPayload: signature_expired → offer_closed, never sign_agreement', () => {
    const { buildAcceptSuccessPayload } = require('../routes/estimate-public');
    expect(buildAcceptSuccessPayload({ billingTerm: 'prepay_annual', invoiceKind: 'annual_prepay_signature_expired' }).nextStep).toBe('offer_closed');
  });

  test('buildAcceptNotificationPayload: a deferred accept tells the customer to sign — never "approved" with invoice follow-up', () => {
    const { buildAcceptNotificationPayload } = require('../routes/estimate-public');
    const payload = buildAcceptNotificationPayload({
      customerName: 'Customer', billingTerm: 'prepay_annual', invoiceKind: 'annual_prepay_deferred', annualPrepayAmount: 449,
    });
    expect(payload.customerBody).toBe("Next step: sign your plan agreement. We'll send you the signing link. Signing starts your plan; your 12-month coverage begins on your installation date.");
    // Codex #4819 r6 P2: coverage begins at installation, never at signature.
    expect(payload.customerBody).toMatch(/coverage begins on your installation date/);
    expect(payload.adminBody).toMatch(/coverage year begins on the installation date/);
    expect(payload.customerBody).not.toMatch(/approved|invoice/i);
    expect(payload.adminBody).toMatch(/waiting on the customer's signature/);
    expect(payload.adminBody).not.toMatch(/Invoice follow-up needed/);
  });

  test('buildAcceptNotificationPayload: an after-installation agreement tells the office the charge follows the installation, not the signature', () => {
    const { buildAcceptNotificationPayload } = require('../routes/estimate-public');
    const args = { customerName: 'Customer', billingTerm: 'prepay_annual', invoiceKind: 'annual_prepay_deferred', annualPrepayAmount: 449 };

    expect(buildAcceptNotificationPayload(args).adminBody).toContain('at signature the saved payment method is charged, or the pay link sent');
    const after = buildAcceptNotificationPayload({ ...args, annualChargeAfterInstallation: true }).adminBody;
    expect(after).toContain('nothing is charged at signature either: after the station installation is completed the saved payment method is charged, or the pay link sent');
    expect(after).not.toContain('at signature the saved payment method is charged');
  });

  test('buildAcceptNotificationPayload: an ordinary prepay accept keeps its existing copy', () => {
    const { buildAcceptNotificationPayload } = require('../routes/estimate-public');
    const payload = buildAcceptNotificationPayload({ customerName: 'Customer', billingTerm: 'prepay_annual' });
    expect(payload.adminBody).toMatch(/Invoice follow-up needed/);
  });

  // GATE_PAF_PREPAY: the after-first-visit notice names the bound tender.
  test('buildAcceptNotificationPayload: a prepay charged after the first visit names the card or the bank debit', () => {
    const { buildAcceptNotificationPayload } = require('../routes/estimate-public');
    const card = buildAcceptNotificationPayload({ customerName: 'Customer', billingTerm: 'prepay_annual', prepayChargeOutcome: 'after_first_visit', prepayChargeMethodType: 'card' });
    expect(card.customerBody).toMatch(/charged to your card on file after your first visit/);
    const bank = buildAcceptNotificationPayload({ customerName: 'Customer', billingTerm: 'prepay_annual', prepayChargeOutcome: 'after_first_visit', prepayChargeMethodType: 'us_bank_account' });
    expect(bank.customerBody).toMatch(/debited from your saved bank account after your first visit/);
    expect(bank.customerBody).not.toMatch(/card/);
    expect(bank.adminBody).toMatch(/saved bank account is debited/);
  });

  test('retry builder: parked and NOT yet signed → sign_agreement', async () => {
    const db = fakeDb({ customer_contracts: null });
    jest.doMock('../models/db', () => db);
    const { buildAlreadyAcceptedSuccessPayload } = require('../routes/estimate-public');

    const payload = await buildAlreadyAcceptedSuccessPayload(parkedEstimate);

    expect(payload.nextStep).toBe('sign_agreement');
    expect(payload.invoiceKind).toBe('annual_prepay_deferred');
  });

  test('codex round-3 P2: retry builder — signed but no term yet → activation_pending, never the burned signing step', async () => {
    const db = fakeDb({ customer_contracts: { id: 'contract-1' } });
    jest.doMock('../models/db', () => db);
    const { buildAlreadyAcceptedSuccessPayload } = require('../routes/estimate-public');

    const payload = await buildAlreadyAcceptedSuccessPayload(parkedEstimate);

    expect(payload.nextStep).toBe('activation_pending');
    expect(payload.invoiceKind).toBe('annual_prepay_activation_pending');
    const contractLookup = db.calls.filter((c) => c.table === 'customer_contracts');
    expect(contractLookup.find((c) => c.method === 'where').args[0])
      .toEqual({ document_template_key: 'service_agreement.termite_annual_protection', status: 'signed' });
    expect(contractLookup.find((c) => c.method === 'whereRaw').args[1]).toEqual(['est-1']);
  });

  // GATE_PAF_TERMITE (GitHub Codex #5816 r3): signing mints the term and the
  // invoice, so a retry after the signature reads as an ordinary annual
  // prepay. While the charge waits for the installation it must never hand
  // the customer the pay link.
  describe('retry builder — signed plan whose charge waits for the installation', () => {
    const activated = (charge) => ({
      ...parkedEstimate,
      annual_plan_activation_status: 'activated',
      accepted_billing_term: 'prepay_annual',
      annual_plan_signature_charge: charge,
    });
    const tables = {
      annual_prepay_terms: { id: 'term-1', prepay_invoice_id: 'inv-1', status: 'payment_pending' },
      invoices: { id: 'inv-1', token: 'tok-1', status: 'draft', total: 449, customer_id: 'cust-1' },
    };
    async function retry(charge) {
      jest.doMock('../models/db', () => fakeDb(tables));
      const { buildAlreadyAcceptedSuccessPayload } = require('../routes/estimate-public');
      return buildAlreadyAcceptedSuccessPayload(activated(charge));
    }

    test.each([
      ['awaiting_installation', { status: 'awaiting_installation', invoice_id: 'inv-1' }],
      ['awaiting_installation (stored as a string)', JSON.stringify({ status: 'awaiting_installation', invoice_id: 'inv-1' })],
      ['the after-installation charge in flight', { status: 'claimed', trigger: 'installation_complete' }],
    ])('%s: no pay link, no pay step, after_installation', async (_label, charge) => {
      const payload = await retry(charge);

      expect(payload.invoicePayUrl).toBeNull();
      expect(payload.invoiceMode).toBe(false);
      expect(payload.nextStep).toBe('confirmed');
      expect(payload.invoiceSettled).toBe(true);
      expect(payload.prepayChargeStatus).toBe('after_installation');
    });

    test.each([
      ['held for the office (a cancelled agreement)', { status: 'deferred', reason: 'agreement_no_longer_signed', trigger: 'installation_complete' }],
      ['possibly through', { status: 'ambiguous', trigger: 'installation_complete' }],
      ['an at-signing charge in flight', { status: 'claimed', trigger: 'signature' }],
    ])('%s: no pay link, the neutral confirming copy', async (_label, charge) => {
      const payload = await retry(charge);

      expect(payload.invoicePayUrl).toBeNull();
      expect(payload.invoiceMode).toBe(false);
      expect(payload.nextStep).toBe('confirmed');
      expect(payload.prepayChargeStatus).toBe('ambiguous');
    });

    test('a declined after-installation charge: the pay link is back', async () => {
      const payload = await retry({ status: 'declined', trigger: 'installation_complete' });

      expect(payload.invoicePayUrl).toMatch(/^\/pay\/tok-1/);
      expect(payload.prepayChargeStatus).not.toBe('after_installation');
    });

    test('an at-signing plan (no wait record) keeps its pay step', async () => {
      const payload = await retry(null);

      expect(payload.invoicePayUrl).toMatch(/^\/pay\/tok-1/);
      expect(payload.prepayChargeStatus).not.toBe('after_installation');
    });
  });

  test('slice 3b: retry builder — signature_expired → offer_closed, never re-offers sign_agreement, no total reported', async () => {
    const db = fakeDb({ customer_contracts: null, invoices: null, annual_prepay_terms: null });
    jest.doMock('../models/db', () => db);
    const { buildAlreadyAcceptedSuccessPayload } = require('../routes/estimate-public');
    const expiredEstimate = { ...parkedEstimate, annual_plan_activation_status: 'signature_expired' };

    const payload = await buildAlreadyAcceptedSuccessPayload(expiredEstimate);

    expect(payload.nextStep).toBe('offer_closed');
    expect(payload.invoiceKind).toBe('annual_prepay_signature_expired');
    expect(payload.billingTerm).toBe('prepay_annual');
    expect(payload.invoiceAmount).toBeNull();
    expect(payload.invoiceServiceLabel).toBe('Annual prepay — signing window closed');
    // The "signed?" contract lookup only ever fires for awaiting_signature —
    // a closed offer never queries it.
    expect(db.calls.filter((c) => c.table === 'customer_contracts')).toHaveLength(0);
  });

  test('codex round-3 P1: a sign-before-pay accept commits no reservation and adopts no appointment — the pick is only a preference', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src).toContain('if (reservationRow && customerId && !isTermiteAnnualSignBeforePay) {');
    expect(src).toContain('if (existingAppointmentRow && customerId && !isTermiteAnnualSignBeforePay) {');
    expect(src).toContain('slotReservation.releaseReservation({ scheduledServiceId: heldRowId, estimateId: estimate.id })');

    const { requestedFirstVisitFromRow } = require('../routes/estimate-public');
    expect(requestedFirstVisitFromRow({
      id: 'hold-1', scheduled_date: '2026-10-14', window_start: '09:00:00', window_end: '11:00:00', technician_id: 'tech-1', reservation_expires_at: new Date().toISOString(),
    })).toEqual({
      date: '2026-10-14', windowStart: '09:00:00', windowEnd: '11:00:00', technicianId: 'tech-1', existingAppointmentId: null,
    });
    expect(requestedFirstVisitFromRow({ scheduled_date: null })).toBeNull();
  });
});
