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

  test('buildAcceptNotificationPayload: an ordinary prepay accept keeps its existing copy', () => {
    const { buildAcceptNotificationPayload } = require('../routes/estimate-public');
    const payload = buildAcceptNotificationPayload({ customerName: 'Customer', billingTerm: 'prepay_annual' });
    expect(payload.adminBody).toMatch(/Invoice follow-up needed/);
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
