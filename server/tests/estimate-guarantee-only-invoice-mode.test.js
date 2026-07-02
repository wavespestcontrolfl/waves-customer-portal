process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const {
  buildEstimateAcceptanceContract,
  isRodentGuaranteeOnlyEstimate,
  resolveEstimateInvoiceMode,
} = require('../routes/estimate-public');

// Guarantee-only renewals (annual rodent guarantee with nothing else on the
// estimate) accept through the invoice-mode payment-only path: no slot pick,
// no card hold, invoice minted at accept. These tests pin the derived
// classification — the accept handler, /:token/data, deposit-intent and
// card-hold-intent all key off resolveEstimateInvoiceMode.

const GUARANTEE_ROW = {
  service: 'rodent_guarantee',
  name: 'Rodent Guarantee (standard)',
  price: 199,
  detail: '$199/yr — 12-month re-entry warranty, renewable annually (standard tier)',
};

function estDataWith({ specItems = [], items = [], recurringServices = [] } = {}) {
  return {
    result: {
      recurring: { services: recurringServices },
      oneTime: { items, specItems },
    },
  };
}

describe('isRodentGuaranteeOnlyEstimate', () => {
  test('true for a guarantee-only estimate (the annual renewal case)', () => {
    const estData = estDataWith({ specItems: [GUARANTEE_ROW] });
    expect(isRodentGuaranteeOnlyEstimate({}, estData)).toBe(true);
  });

  test('false when the guarantee is bundled with another one-time service — booking path stays', () => {
    const estData = estDataWith({
      specItems: [GUARANTEE_ROW],
      items: [{ service: 'pest_initial', name: 'One-Time Pest Control', price: 150 }],
    });
    expect(isRodentGuaranteeOnlyEstimate({}, estData)).toBe(false);
  });

  test('a discounted renewal is still a renewal — discount rows do not re-grow the booking path', () => {
    // A manual discount's one-time slice lands as a negative (kind: discount)
    // breakdown row; it is not a service needing a visit.
    const estData = estDataWith({
      specItems: [GUARANTEE_ROW],
      items: [{ service: 'manual_discount', name: 'Manual discount', price: -20 }],
    });
    expect(isRodentGuaranteeOnlyEstimate({}, estData)).toBe(true);
  });

  test('a discount row alone is NOT a renewal (no guarantee charge row)', () => {
    const estData = estDataWith({
      items: [{ service: 'manual_discount', name: 'Manual discount', price: -20 }],
    });
    expect(isRodentGuaranteeOnlyEstimate({}, estData)).toBe(false);
  });

  test('a discount row does not mask a bundled service — booking path stays', () => {
    const estData = estDataWith({
      specItems: [GUARANTEE_ROW],
      items: [
        { service: 'pest_initial', name: 'One-Time Pest Control', price: 150 },
        { service: 'manual_discount', name: 'Manual discount', price: -20 },
      ],
    });
    expect(isRodentGuaranteeOnlyEstimate({}, estData)).toBe(false);
  });

  test('false for the guarantee COMBO (carries real exclusion work — a visit is wanted)', () => {
    const estData = estDataWith({
      specItems: [{ ...GUARANTEE_ROW, service: 'rodent_guarantee_combo', name: 'Rodent Guarantee', price: 1299 }],
    });
    expect(isRodentGuaranteeOnlyEstimate({}, estData)).toBe(false);
  });

  test('false when a recurring plan is on the estimate (not structural one-time)', () => {
    const estData = estDataWith({
      specItems: [GUARANTEE_ROW],
      recurringServices: [{ name: 'Pest Control', mo: 60 }],
    });
    expect(isRodentGuaranteeOnlyEstimate({}, estData)).toBe(false);
  });

  test('false for an empty estimate', () => {
    expect(isRodentGuaranteeOnlyEstimate({}, estDataWith())).toBe(false);
  });

  test('parses estimate_data itself when estData is not supplied (accept-handler call shape)', () => {
    const estimate = { estimate_data: JSON.stringify(estDataWith({ specItems: [GUARANTEE_ROW] })) };
    expect(isRodentGuaranteeOnlyEstimate(estimate)).toBe(true);
  });

  test('malformed estimate_data fails closed to the booking path', () => {
    expect(isRodentGuaranteeOnlyEstimate({ estimate_data: '{not json' })).toBe(false);
  });
});

describe('resolveEstimateInvoiceMode', () => {
  test('admin bill_by_invoice opt-in still wins regardless of contents', () => {
    expect(resolveEstimateInvoiceMode({ bill_by_invoice: true }, estDataWith())).toBe(true);
  });

  test('guarantee-only derives invoice mode without the admin flag', () => {
    const estData = estDataWith({ specItems: [GUARANTEE_ROW] });
    expect(resolveEstimateInvoiceMode({ bill_by_invoice: false }, estData)).toBe(true);
  });

  test('a normal one-time estimate stays on the booking path', () => {
    const estData = estDataWith({
      items: [{ service: 'pest_initial', name: 'One-Time Pest Control', price: 150 }],
    });
    expect(resolveEstimateInvoiceMode({ bill_by_invoice: false }, estData)).toBe(false);
  });
});

describe('buildEstimateAcceptanceContract invoice_only mode', () => {
  test('invoiceOnly yields the payment-only contract (no slot pick)', () => {
    const contract = buildEstimateAcceptanceContract({ quoteRequirement: {}, invoiceOnly: true });
    expect(contract.mode).toBe('invoice_only');
  });

  test('quote_required takes precedence over invoiceOnly', () => {
    const contract = buildEstimateAcceptanceContract({
      quoteRequirement: { quoteRequired: true, reason: 'commercial_proposal' },
      invoiceOnly: true,
    });
    expect(contract.mode).toBe('quote_required');
  });

  test('an existing linked appointment takes precedence over invoiceOnly', () => {
    const contract = buildEstimateAcceptanceContract({
      quoteRequirement: {},
      existingAppointment: { id: 'a1', scheduled_date: '2026-07-10', window_start: '09:00' },
      invoiceOnly: true,
    });
    expect(contract.mode).toBe('existing_appointment');
  });

  test('default remains standard_slot_pick', () => {
    const contract = buildEstimateAcceptanceContract({ quoteRequirement: {} });
    expect(contract.mode).toBe('standard_slot_pick');
  });
});

describe('resolveDepositPolicy noVisit — plan-customer booking gate lifted for renewals', () => {
  // A guarantee renewal's primary audience IS an existing plan customer. Their
  // normal deposit exemption swaps in a booking commitment gate
  // (slotRequired) — but a no-visit accept has no appointment to book, so the
  // gate would 400 APPOINTMENT_REQUIRED on a UI with no slot picker. The
  // invoice minted at accept is the commitment instead.
  const { resolveDepositPolicy } = require('../services/estimate-deposits');
  const PLAN_CUSTOMER = { isExistingCustomer: true };

  let prevFlag;
  beforeAll(() => {
    prevFlag = process.env.ESTIMATE_DEPOSIT_REQUIRED;
    process.env.ESTIMATE_DEPOSIT_REQUIRED = 'true';
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.ESTIMATE_DEPOSIT_REQUIRED;
    else process.env.ESTIMATE_DEPOSIT_REQUIRED = prevFlag;
  });

  test('plan customer + noVisit → no deposit, NO booking requirement', () => {
    expect(resolveDepositPolicy({ estimate: {}, membership: PLAN_CUSTOMER, oneTime: true, noVisit: true }))
      .toEqual({ enforced: true, required: false, slotRequired: false, exemptReason: 'existing_plan_customer' });
  });

  test('plan customer without noVisit keeps the booking commitment gate (unchanged)', () => {
    expect(resolveDepositPolicy({ estimate: {}, membership: PLAN_CUSTOMER, oneTime: true }))
      .toEqual({ enforced: true, required: false, slotRequired: true, exemptReason: 'existing_plan_customer' });
  });

  test('non-plan customer: noVisit does not change the deposit itself', () => {
    const policy = resolveDepositPolicy({ estimate: {}, membership: null, oneTime: true, noVisit: true });
    expect(policy.required).toBe(true);
    expect(policy.slotRequired).toBe(false);
  });
});
