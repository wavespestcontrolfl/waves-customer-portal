/**
 * GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): completion-charge-verdict's
 * two auto-charge cap anchors must never fall back to the dues rate / the
 * per-application fee for a visit now stamped $0 — only an independently
 * authorized setup fee (setupFeeAllowance, untouched by this gate) can still
 * clear the cap. Off, both anchors are byte-identical to today.
 */

// A minimal chainable knex-style query builder: enough surface for the two
// functions under test (where/whereIn/whereNot/first, nested as a subquery
// argument to whereIn). No table has any matching row unless `rowsFor`
// supplies one, so every conn call resolves to "nothing found" by default.
function makeConn(rowsByTable = {}) {
  function chain(table) {
    const q = {};
    const methods = ['where', 'whereIn', 'whereNot', 'whereNotIn', 'orWhere', 'andWhere'];
    methods.forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => (rowsByTable[table] && rowsByTable[table][0]) || null);
    q.select = jest.fn(() => q);
    return q;
  }
  return jest.fn((table) => chain(table));
}

describe('resolveCompletionChargeCap — per-application stamped $0 anchor', () => {
  afterEach(() => { delete process.env.GATE_STAMPED_ZERO_FREE; });

  test('off: a bare stamped 0 still anchors at the per_application_fee (today\'s behavior)', () => {
    const { resolveCompletionChargeCap } = require('../services/completion-charge-verdict');
    return resolveCompletionChargeCap({
      svc: { estimated_price: 0, primary_line_price: null, cust_per_application_fee: 97.2 },
      invoice: { subtotal: 40, total: 40, discount_amount: 0, notes: '', line_items: [] },
      perApplicationBilling: true,
      apptCardOneTimeCharge: false,
      apptCardAcceptedAmount: null,
      extendedLaneAnchor: null,
      secureSetupFee: null,
      conn: makeConn(),
    }).then((cap) => {
      expect(cap.acceptedPerVisit).toBe(97.2);
      expect(cap.verdict).toBe('ok'); // $40 checkout extra is well under the $97.20 fee anchor
    });
  });

  test('on: a bare stamped 0 anchors at a ZERO base — a $40 extra is over cap, never the fee', async () => {
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    const { resolveCompletionChargeCap } = require('../services/completion-charge-verdict');
    const cap = await resolveCompletionChargeCap({
      svc: { estimated_price: 0, primary_line_price: null, cust_per_application_fee: 97.2 },
      invoice: { subtotal: 40, total: 40, discount_amount: 0, notes: '', line_items: [] },
      perApplicationBilling: true,
      apptCardOneTimeCharge: false,
      apptCardAcceptedAmount: null,
      extendedLaneAnchor: null, // resolveExtendedLane never computes this for a per-application visit
      secureSetupFee: null,
      conn: makeConn(),
    });
    expect(cap.acceptedPerVisit).toBe(0);
    expect(cap.capCeiling).toBe(0);
    expect(cap.verdict).toBe('above_cap');
  });

  // Codex r3 P1 on #5256: a null base sent an AUTHORIZED setup-only invoice
  // to office review while attachedInvoiceAutoChargeLikely promised the
  // charge. The zero base lets the independent allowance form the cap.
  test('on: a stamped 0 with an authorized setup fee caps at exactly that fee', async () => {
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    const { resolveCompletionChargeCap } = require('../services/completion-charge-verdict');
    const setupLine = { description: 'One-time setup fee', amount: 99, quantity: 1, unit_price: 99 };
    const args = {
      svc: { estimated_price: 0, primary_line_price: null, cust_per_application_fee: 97.2 },
      perApplicationBilling: true,
      apptCardOneTimeCharge: false,
      apptCardAcceptedAmount: null,
      extendedLaneAnchor: null,
      secureSetupFee: { amount: 99 },
      conn: makeConn(),
    };
    const ok = await resolveCompletionChargeCap({
      ...args, invoice: { id: 'inv-1', subtotal: 99, total: 99, discount_amount: 0, notes: '', line_items: [setupLine] },
    });
    expect(ok.acceptedPerVisit).toBe(0);
    expect(ok.setupFeeAllowance).toBe(99);
    expect(ok.verdict).toBe('ok');
    const over = await resolveCompletionChargeCap({
      ...args, invoice: { id: 'inv-1', subtotal: 139, total: 139, discount_amount: 0, notes: '', line_items: [setupLine, { description: 'Extra', amount: 40 }] },
    });
    expect(over.verdict).toBe('above_cap');
  });

  test('on: a genuinely NULL (never-priced) row is unaffected — still anchors at the fee', async () => {
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    const { resolveCompletionChargeCap } = require('../services/completion-charge-verdict');
    const cap = await resolveCompletionChargeCap({
      svc: { estimated_price: null, primary_line_price: null, cust_per_application_fee: 97.2 },
      invoice: { subtotal: 40, total: 40, discount_amount: 0, notes: '', line_items: [] },
      perApplicationBilling: true,
      apptCardOneTimeCharge: false,
      apptCardAcceptedAmount: null,
      extendedLaneAnchor: null,
      secureSetupFee: null,
      conn: makeConn(),
    });
    expect(cap.acceptedPerVisit).toBe(97.2);
  });

  test('on: a POSITIVE stamped price always wins, gate or not', async () => {
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    const { resolveCompletionChargeCap } = require('../services/completion-charge-verdict');
    const cap = await resolveCompletionChargeCap({
      svc: { estimated_price: 55, primary_line_price: null, cust_per_application_fee: 97.2 },
      invoice: { subtotal: 55, total: 55, discount_amount: 0, notes: '', line_items: [] },
      perApplicationBilling: true,
      apptCardOneTimeCharge: false,
      apptCardAcceptedAmount: null,
      extendedLaneAnchor: null,
      secureSetupFee: null,
      conn: makeConn(),
    });
    expect(cap.acceptedPerVisit).toBe(55);
  });
});

describe('resolveExtendedLane — extended (membership/self-pay) auto-charge anchor', () => {
  afterEach(() => {
    delete process.env.GATE_STAMPED_ZERO_FREE;
    delete process.env.GATE_COMPLETION_AUTOPAY_CHARGE;
    jest.resetModules();
  });

  // GATE_COMPLETION_AUTOPAY_CHARGE gates the WHOLE extended lane and is read
  // from a module-load-cached map entry (gates.completionAutopayCharge), so
  // it must be set BEFORE this module (and its feature-gates dependency)
  // is required. jest.resetModules() clears the whole registry so the
  // re-require below re-evaluates that map entry against the env var set
  // just above it.
  function loadWithExtendedLaneOn() {
    process.env.GATE_COMPLETION_AUTOPAY_CHARGE = 'true';
    jest.resetModules();
    return require('../services/completion-charge-verdict');
  }

  const baseArgs = {
    svc: { id: 'svc-1', is_callback: false, service_type: 'Pest Control', cust_monthly_rate: 33.33, cust_billing_mode: 'monthly_membership' },
    invoice: { id: 'inv-1', subtotal: 33.33, total: 33.33, discount_amount: 0, payer_id: null },
    alreadyPaid: false,
    visitPerformed: true,
    perApplicationBilling: false,
    apptCardOneTimeCharge: false,
    apptCardLaneUnresolved: false,
    customerAutopayActive: true,
  };

  test('off: a bare stamped 0 estimated_price still anchors at the monthly dues rate (today\'s behavior)', async () => {
    const { resolveExtendedLane } = loadWithExtendedLaneOn();
    const verdict = await resolveExtendedLane({
      ...baseArgs,
      svc: { ...baseArgs.svc, estimated_price: 0, primary_line_price: null },
      conn: makeConn(),
    });
    expect(verdict.extendedChargeCandidate).toBe(true);
    expect(verdict.extendedLaneAnchor).toBe(33.33);
    expect(verdict.extendedLaneOverCap).toBe(false); // $33.33 invoice <= $33.33 anchor
  });

  test('on: a bare stamped 0 estimated_price anchors at nothing — never the monthly dues rate', async () => {
    const { resolveExtendedLane } = loadWithExtendedLaneOn();
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    const verdict = await resolveExtendedLane({
      ...baseArgs,
      svc: { ...baseArgs.svc, estimated_price: 0, primary_line_price: null },
      conn: makeConn(),
    });
    expect(verdict.extendedLaneAnchor).toBeNull();
    expect(verdict.extendedLaneOverCap).toBe(true); // no anchor -> over cap -> office review
  });

  test('on: a genuinely NULL (never-priced) row is unaffected — still anchors at the monthly dues rate', async () => {
    const { resolveExtendedLane } = loadWithExtendedLaneOn();
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    const verdict = await resolveExtendedLane({
      ...baseArgs,
      svc: { ...baseArgs.svc, estimated_price: null, primary_line_price: null },
      conn: makeConn(),
    });
    expect(verdict.extendedLaneAnchor).toBe(33.33);
  });

  test('on: a POSITIVE stamped price always wins, gate or not', async () => {
    const { resolveExtendedLane } = loadWithExtendedLaneOn();
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    const verdict = await resolveExtendedLane({
      ...baseArgs,
      svc: { ...baseArgs.svc, estimated_price: 60, primary_line_price: null },
      invoice: { ...baseArgs.invoice, subtotal: 60, total: 60 },
      conn: makeConn(),
    });
    expect(verdict.extendedLaneAnchor).toBe(60);
  });
});
