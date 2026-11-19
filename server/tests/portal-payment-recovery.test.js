jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/stripe', () => ({
  getPaymentHistory: jest.fn(),
}));
jest.mock('../services/payer-linkage', () => ({
  ...jest.requireActual('../services/payer-linkage'),
  loadPayerLinkage: jest.fn(async () => ({
    failed: false,
    payerInvoiceIds: new Set(),
    isPayerLinked: () => false,
  })),
}));
jest.mock('../services/invoice-payer-ownership', () => ({
  liveInvoiceOwnership: jest.fn(async () => ({ ownedIds: new Set(), unverifiable: false })),
  invoicePayerOwnership: jest.fn(async () => null),
}));
jest.mock('../services/pay-combined', () => ({
  memberCollectionPending: jest.fn(async (invoice) => ({ row: invoice })),
}));
jest.mock('../services/visit-completion-packets', () => ({
  invoicePayerOwnedNow: jest.fn(async () => false),
}));
jest.mock('../services/invoice', () => ({
  linkedScheduledServiceId: jest.fn(async () => null),
}));
jest.mock('../services/termite-annual-renewal-charge', () => ({
  renewalPaymentRefusal: jest.fn(async () => null),
}));

const stripe = require('../services/stripe');
const { listPortalPayments, recoveryInvoiceIndexFor } = require('../services/portal-payment-history');
const { liveInvoiceOwnership, invoicePayerOwnership } = require('../services/invoice-payer-ownership');
const { memberCollectionPending } = require('../services/pay-combined');
const { invoicePayerOwnedNow } = require('../services/visit-completion-packets');
const { linkedScheduledServiceId } = require('../services/invoice');
const { renewalPaymentRefusal } = require('../services/termite-annual-renewal-charge');

const INV_A = '11111111-1111-4111-8111-111111111111';
const INV_B = '22222222-2222-4222-8222-222222222222';

function invoice(overrides = {}) {
  return {
    id: INV_A,
    customer_id: 'cust-1',
    token: 'tok-a',
    invoice_number: 'WPC-100',
    status: 'sent',
    total: '95.00',
    credit_applied: '0',
    amount_paid: '0',
    payer_id: null,
    payer_statement_id: null,
    scheduled_send_error: null,
    visit_completion_packet_id: null,
    stripe_payment_intent_id: 'pi-a',
    stripe_charge_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  liveInvoiceOwnership.mockResolvedValue({ ownedIds: new Set(), unverifiable: false });
  invoicePayerOwnership.mockResolvedValue(null);
  memberCollectionPending.mockImplementation(async (current) => ({ row: current }));
  invoicePayerOwnedNow.mockResolvedValue(false);
  linkedScheduledServiceId.mockResolvedValue(null);
  renewalPaymentRefusal.mockResolvedValue(null);
});

function reader(rows, resolvedAttempts = [], supplementalRows = rows, { attemptError = null, visitStatus = null } = {}) {
  let invoiceReads = 0;
  return jest.fn((table) => {
    const query = {};
    for (const method of [
      'join', 'where', 'whereNull', 'whereNotNull', 'whereIn', 'orWhere', 'orWhereIn', 'orWhereColumn', 'orWhereNull',
    ]) {
      query[method] = (...args) => {
        if (typeof args[0] === 'function') args[0].call(query, query);
        return query;
      };
    }
    query.select = async () => {
      if (table === 'stripe_invoice_charge_attempts as attempt') {
        if (attemptError) throw attemptError;
        return resolvedAttempts;
      }
      invoiceReads += 1;
      return invoiceReads === 1 ? rows : supplementalRows;
    };
    query.first = async () => (table === 'scheduled_services' ? { status: visitStatus } : null);
    return query;
  });
}

test('a failed payment receives only its own verified invoice and remaining amount', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', amount: '95.00',
    metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-a',
  }], reader([invoice({ total: '100.00', credit_applied: '5.00' })]));

  expect(recovery.get('pay-a')).toEqual({
    payUrl: '/pay/tok-a', amountDue: 95, invoiceNumber: 'WPC-100',
  });
});

test('two failed payments map to their own invoices instead of the oldest account invoice', async () => {
  const second = invoice({
    id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', total: '60.00',
    stripe_payment_intent_id: 'pi-b',
  });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    { id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-a' },
    { id: 'pay-b', status: 'failed', metadata: { invoice_id: INV_B }, stripe_payment_intent_id: 'pi-b' },
  ], reader([second, invoice()]));

  expect(recovery.get('pay-a')?.payUrl).toBe('/pay/tok-a');
  expect(recovery.get('pay-b')).toEqual({ payUrl: '/pay/tok-b', amountDue: 60, invoiceNumber: 'WPC-200' });
});

test('recovery enrichment is capped to the ten newest failed rows', async () => {
  const ids = Array.from({ length: 11 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const payments = ids.map((id, index) => ({
    id: `pay-${index + 1}`, status: 'failed',
    metadata: { invoice_id: id }, stripe_payment_intent_id: `pi-${index + 1}`,
  }));
  const invoices = ids.map((id, index) => invoice({
    id, token: `tok-${index + 1}`, invoice_number: `WPC-${index + 1}`,
    stripe_payment_intent_id: `pi-${index + 1}`,
  }));

  const recovery = await recoveryInvoiceIndexFor('cust-1', payments, reader(invoices));

  expect(recovery.size).toBe(10);
  expect(recovery.has('pay-11')).toBe(false);
  expect(memberCollectionPending).toHaveBeenCalledTimes(10);
});

test('combined ACH shares keep their invoice-specific recovery links after a bounce', async () => {
  const second = invoice({
    id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', total: '60.00',
    stripe_payment_intent_id: 'pi-shared',
  });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    {
      id: 'pay-a', status: 'failed', stripe_payment_intent_id: 'pi-shared',
      metadata: { invoice_id: INV_A, combined_payment: true },
    },
    {
      id: 'pay-b', status: 'failed', stripe_payment_intent_id: 'pi-shared',
      metadata: { invoice_id: INV_B, combined_payment: true },
    },
  ], reader([second, invoice({ stripe_payment_intent_id: 'pi-shared' })]));

  expect(recovery.get('pay-a')?.payUrl).toBe('/pay/tok-a');
  expect(recovery.get('pay-b')?.payUrl).toBe('/pay/tok-b');
});

test('an unmarked shared Stripe identifier remains ambiguous', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', stripe_payment_intent_id: 'pi-shared',
    metadata: { invoice_id: INV_A },
  }], reader([
    invoice({ stripe_payment_intent_id: 'pi-shared' }),
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-shared' }),
  ]));

  expect(recovery.has('pay-a')).toBe(false);
});

test('serialized null metadata cannot break recovery for a legacy failed row', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-legacy', status: 'failed', metadata: 'null', stripe_payment_intent_id: 'pi-a',
  }], reader([invoice()]));

  expect(recovery.get('pay-legacy')?.payUrl).toBe('/pay/tok-a');
});

test('a resolved saved-bank failure verifies the invoice after its PaymentIntent binding clears', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-bank', status: 'failed', metadata: { invoice_id: INV_A },
    stripe_payment_intent_id: 'pi-failed-bank',
  }], reader([
    invoice({ stripe_payment_intent_id: null }),
  ], [{
    invoice_id: INV_A, stripe_payment_intent_id: 'pi-failed-bank', status: 'failed', resolved_at: new Date(),
  }]));

  expect(recovery.get('pay-bank')?.payUrl).toBe('/pay/tok-a');
});

test('a saved-card authentication_required row with no PI id cannot open a second checkout', async () => {
  const payment = {
    id: 'pay-sca',
    status: 'failed',
    stripe_payment_intent_id: null,
    metadata: {
      invoice_id: INV_A,
      source: 'card_on_file_failed_attempt',
      ambiguous_outcome: false,
    },
  };
  const recovery = await recoveryInvoiceIndexFor('cust-1', [payment], reader([invoice()], [{
    invoice_id: INV_A,
    stripe_payment_intent_id: null,
    status: 'failed',
    decline_code: 'authentication_required',
    resolved_at: new Date(),
  }]));

  expect(recovery.has('pay-sca')).toBe(false);
  expect(memberCollectionPending).not.toHaveBeenCalled();
});

test.each([
  {
    label: 'known authentication_required',
    invoiceRow: invoice(),
    attemptRows: [{
      invoice_id: INV_A,
      status: 'failed',
      decline_code: 'authentication_required',
      resolved_at: new Date(),
    }],
    expectedState: 'authentication_pending',
  },
  {
    label: 'a still-claimed attempt before authentication_required is persisted',
    invoiceRow: invoice(),
    attemptRows: [{
      invoice_id: INV_A,
      status: 'claimed',
      decline_code: null,
      resolved_at: null,
    }],
    expectedState: 'authentication_unknown',
  },
  {
    label: 'authentication lookup failure',
    invoiceRow: invoice(),
    attemptFailure: new Error('authentication lookup failed'),
    expectedState: 'authentication_unknown',
  },
  {
    label: 'an attempt that starts after authentication classification but before current-row verification',
    invoiceRow: invoice(),
    collectionResult: null,
    expectedState: 'recovery_unavailable',
    expectedCollectionChecks: 1,
  },
  {
    label: 'unverifiable payer ownership',
    invoiceRow: invoice(),
    ownershipUnverifiable: true,
    expectedState: 'recovery_unavailable',
  },
  {
    label: 'historical authentication_required after settlement',
    invoiceRow: invoice({ status: 'paid', amount_paid: '95.00' }),
    attemptRows: [{
      invoice_id: INV_A,
      status: 'failed',
      decline_code: 'authentication_required',
      resolved_at: new Date(),
    }],
    expectedState: null,
  },
])('the portal serializes verification state for $label', async ({
  invoiceRow,
  attemptRows = [],
  attemptFailure,
  collectionResult,
  ownershipUnverifiable,
  expectedState,
  expectedCollectionChecks = 0,
}) => {
  const payment = {
    id: 'pay-sca',
    customer_id: 'cust-1',
    payment_date: '2026-11-17',
    amount: '95.00',
    status: 'failed',
    description: 'Invoice WPC-100 — card on file (FAILED)',
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    metadata: { invoice_id: INV_A, source: 'card_on_file_failed_attempt' },
    method_type: 'card',
  };
  stripe.getPaymentHistory.mockResolvedValue([payment]);
  if (ownershipUnverifiable) liveInvoiceOwnership.mockResolvedValueOnce({ ownedIds: new Set(), unverifiable: true });
  if (collectionResult !== undefined) memberCollectionPending.mockResolvedValue(collectionResult);
  let invoiceReads = 0;
  const database = jest.fn((table) => {
    const query = {};
    for (const method of [
      'join', 'where', 'whereNull', 'whereNotNull', 'whereRaw', 'whereIn', 'orWhere', 'orWhereIn', 'orWhereColumn', 'orWhereNull', 'count',
    ]) {
      query[method] = (...args) => {
        if (typeof args[0] === 'function') args[0].call(query, query);
        return query;
      };
    }
    query.first = async () => ({ count: 1 });
    query.select = async () => {
      if (table === 'stripe_invoice_charge_attempts as attempt') {
        if (attemptFailure) throw attemptFailure;
        return attemptRows;
      }
      if (table !== 'invoices') return [];
      invoiceReads += 1;
      // The first invoice read is receipt enrichment. The second is the
      // failed-payment recovery candidate lookup.
      return invoiceReads === 1 ? [] : [invoiceRow];
    };
    return query;
  });

  const result = await listPortalPayments('cust-1', {
    database,
    includeRecoveryInvoices: true,
  });

  expect(result.payments[0]).toMatchObject({
    id: 'pay-sca',
    recoveryInvoice: null,
    recoveryState: expectedState,
  });
  expect(memberCollectionPending).toHaveBeenCalledTimes(expectedCollectionChecks);
});

test('a legacy invoice-number failure still sees its invoice authentication_required fence', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-sca-legacy',
    status: 'failed',
    stripe_payment_intent_id: null,
    metadata: null,
    description: 'Invoice WPC-100 — card on file (FAILED)',
  }], reader([invoice()], [{
    invoice_id: INV_A,
    stripe_payment_intent_id: null,
    status: 'failed',
    decline_code: 'authentication_required',
    resolved_at: new Date(),
  }]));

  expect(recovery.has('pay-sca-legacy')).toBe(false);
});

test('a terminal saved-card decline still offers its verified invoice checkout', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-declined',
    status: 'failed',
    metadata: {
      invoice_id: INV_A,
      source: 'card_on_file_failed_attempt',
      ambiguous_outcome: false,
    },
  }], reader([invoice()], [{
    invoice_id: INV_A,
    stripe_payment_intent_id: null,
    status: 'failed',
    decline_code: 'insufficient_funds',
    resolved_at: new Date(),
  }]));

  expect(recovery.get('pay-declined')?.payUrl).toBe('/pay/tok-a');
});

test('a legacy intent-only row sees both a live binding and a cleared resolved-attempt binding', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-bank', status: 'failed', metadata: null, stripe_payment_intent_id: 'pi-reused',
  }], reader([
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-reused' }),
  ], [{
    invoice_id: INV_A, stripe_payment_intent_id: 'pi-reused', status: 'failed', resolved_at: new Date(),
  }], [invoice({ stripe_payment_intent_id: null })]));

  expect(recovery.has('pay-bank')).toBe(false);
});

test('a failed resolved-attempt lookup withholds intent-based recovery', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-bank', status: 'failed', metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-a',
  }], reader([invoice()], [], undefined, { attemptError: new Error('attempt lookup failed') }));

  expect(recovery.has('pay-bank')).toBe(false);
});

test('a failed attempt lookup withholds an invoice-only saved-card recovery link', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-card',
    status: 'failed',
    metadata: {
      invoice_id: INV_A,
      source: 'card_on_file_failed_attempt',
      ambiguous_outcome: false,
    },
  }], reader([invoice()], [], undefined, { attemptError: new Error('attempt lookup failed') }));

  expect(recovery.has('pay-card')).toBe(false);
});

test('conflicting non-explicit identifiers fail closed instead of choosing an invoice', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-conflict', status: 'failed', metadata: null,
    stripe_payment_intent_id: 'pi-a', stripe_charge_id: 'ch-b',
  }], reader([
    invoice(),
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-b', stripe_charge_id: 'ch-b' }),
  ]));

  expect(recovery.has('pay-conflict')).toBe(false);
});

test.each([
  ['Stripe intent', { metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-b' }],
  ['Stripe charge', { metadata: { invoice_id: INV_A }, stripe_charge_id: 'ch-b' }],
  ['invoice number', { metadata: { invoice_id: INV_A }, description: 'Invoice WPC-200 — card' }],
  ['legacy alias', { metadata: { invoice_id: INV_A, dispute_invoice_id: INV_A, waves_invoice_id: INV_B } }],
  ['unrecognized metadata ID', { metadata: { invoice_id: 'legacy' }, stripe_payment_intent_id: 'pi-b' }],
  ['unmatched intent', { metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'unmatched' }],
])('withholds the link when the %s cannot confirm the same payable invoice', async (_label, fields) => {
  const invoices = [
    invoice(),
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-b', stripe_charge_id: 'ch-b' }),
  ];
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    { id: 'attempt', status: 'failed', ...fields },
  ], reader(invoices));
  expect(recovery.has('attempt')).toBe(false);
});

test('a legacy metadata alias and a matching intent identify the same invoice', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'attempt', status: 'failed', metadata: JSON.stringify({ waves_invoice_id: INV_A }), stripe_payment_intent_id: 'pi-a',
  }], reader([invoice()]));
  expect(recovery.get('attempt')?.payUrl).toBe('/pay/tok-a');
});

test.each([
  ['parked for reconciliation', { superseded_by_payment_id: 'attempt' }],
  ['collected by another attempt', { superseded_by_payment_id: 'paid-retry' }],
  ['ambiguous before parking', { metadata: { invoice_id: INV_A, ambiguous_outcome: 'true' } }],
  ['card authentication pending', { metadata: { invoice_id: INV_A, requires_action: true } }],
  ['never attempted', { next_retry_at: '2026-12-01', metadata: { invoice_id: INV_A, deferred_reason: 'lock_contention' } }],
])('a failed attempt %s cannot offer another payment on an unpaid draft', async (_reason, fields) => {
  const database = reader([invoice({ status: 'draft' })]);
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    { id: 'attempt', status: 'failed', metadata: { invoice_id: INV_A }, ...fields },
  ], database);
  expect(recovery.size).toBe(0);
  expect(database).not.toHaveBeenCalled();
});

test('the failed-draft rescue requires the explicit invoice ID used by Billing', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    { id: 'explicit', status: 'failed', metadata: { invoice_id: INV_A } },
    { id: 'intent-only', status: 'failed', stripe_payment_intent_id: 'pi-a' },
  ], reader([invoice({ status: 'draft' })]));
  expect(recovery.get('explicit')?.payUrl).toBe('/pay/tok-a');
  expect(recovery.has('intent-only')).toBe(false);
});

test('an explicit settled invoice id never falls through to a different payable identifier', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-explicit', status: 'failed', metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-b',
  }], reader([
    invoice({ status: 'paid' }),
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-b' }),
  ]));

  expect(recovery.has('pay-explicit')).toBe(false);
});

test('a live-resolved payer invoice never exposes its bearer pay link', async () => {
  liveInvoiceOwnership.mockResolvedValueOnce({ ownedIds: new Set([INV_A]), unverifiable: false });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice()]));

  expect(recovery.has('pay-a')).toBe(false);
});

test('a packet owned by any billed payer member never exposes its bearer pay link', async () => {
  invoicePayerOwnedNow.mockResolvedValueOnce(true);
  const database = reader([invoice({ visit_completion_packet_id: 'packet-1' })]);
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], database);

  expect(recovery.has('pay-a')).toBe(false);
  expect(invoicePayerOwnedNow).toHaveBeenCalledWith(INV_A, database);
});

test('unverifiable packet ownership withholds the recovery link', async () => {
  invoicePayerOwnedNow.mockRejectedValueOnce(new Error('ownership unavailable'));
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice({ visit_completion_packet_id: 'packet-1' })]));

  expect(recovery.has('pay-a')).toBe(false);
});

test.each([
  ['deposit settlement', 'deposit_settlement'],
  ['saved-card reconciliation', 'charge_reconciliation'],
])('%s holds suppress the recovery link', async (_label, reason) => {
  memberCollectionPending.mockResolvedValueOnce({ reason });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice()]));

  expect(recovery.has('pay-a')).toBe(false);
});

test('the current-row verifier withholds an invoice reassigned to another customer', async () => {
  memberCollectionPending.mockResolvedValueOnce({ reason: 'customer_changed' });
  const database = reader([invoice()]);
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], database);

  expect(recovery.has('pay-a')).toBe(false);
  expect(memberCollectionPending).toHaveBeenCalledWith(expect.objectContaining({ id: INV_A }), {
    database, customerId: 'cust-1', allowStandaloneServiceRecordVisit: true,
  });
});

test.each(['payer_owned', 'payer_unverifiable'])(
  'fresh service-record-linked ownership %s withholds the recovery link',
  async (ownership) => {
    linkedScheduledServiceId.mockResolvedValueOnce('visit-1');
    invoicePayerOwnership.mockResolvedValueOnce(ownership);
    const current = invoice({ scheduled_service_id: null, service_record_id: 'record-1' });
    memberCollectionPending.mockResolvedValueOnce({ row: current });
    const database = reader([current], [], [current], { visitStatus: 'completed' });
    const recovery = await recoveryInvoiceIndexFor('cust-1', [{
      id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
    }], database);

    expect(recovery.has('pay-a')).toBe(false);
    expect(invoicePayerOwnership).toHaveBeenCalledWith(expect.objectContaining({
      id: INV_A, scheduled_service_id: 'visit-1', service_record_id: 'record-1',
    }), database);
  },
);

test.each(['cancelled', 'skipped'])(
  'a fresh %s linked visit cannot produce a recovery link',
  async (status) => {
    linkedScheduledServiceId.mockResolvedValueOnce('visit-1');
    const current = invoice({ service_record_id: 'record-1' });
    memberCollectionPending.mockResolvedValueOnce({ row: current });
    const recovery = await recoveryInvoiceIndexFor('cust-1', [{
      id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
    }], reader([current], [], [current], { visitStatus: status }));

    expect(recovery.has('pay-a')).toBe(false);
    expect(invoicePayerOwnership).not.toHaveBeenCalled();
  },
);

test('the recovery link and amount come from the verified current invoice row', async () => {
  memberCollectionPending.mockResolvedValueOnce({ row: invoice({
    token: 'tok-current', invoice_number: 'WPC-CURRENT', total: '80.00', credit_applied: '5.00',
  }) });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice()]));

  expect(recovery.get('pay-a')).toEqual({
    payUrl: '/pay/tok-current', amountDue: 75, invoiceNumber: 'WPC-CURRENT',
  });
});

test('a renewal checkout refusal withholds the otherwise payable recovery link', async () => {
  const current = invoice({ annual_prepay_term_id: 'term-1' });
  memberCollectionPending.mockResolvedValueOnce({ row: current });
  renewalPaymentRefusal.mockResolvedValueOnce({ reason: 'parent_cancelled' });
  const database = reader([current]);
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-renewal', status: 'failed', metadata: { invoice_id: INV_A },
  }], database);

  expect(recovery.has('pay-renewal')).toBe(false);
  expect(renewalPaymentRefusal).toHaveBeenCalledWith(current, database);
});

test('a fresh draft still requires the payment canonical invoice id', async () => {
  memberCollectionPending.mockResolvedValueOnce({ row: invoice({ status: 'draft' }) });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', stripe_payment_intent_id: 'pi-a',
  }], reader([invoice({ status: 'sent' })]));

  expect(recovery.has('pay-a')).toBe(false);
});

test('unverifiable live payer ownership withholds every recovery link', async () => {
  liveInvoiceOwnership.mockResolvedValueOnce({ ownedIds: new Set(), unverifiable: true });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice()]));

  expect(recovery.size).toBe(0);
});

test.each([
  ['settled', { status: 'paid' }],
  ['fully credited', { total: '95.00', credit_applied: '95.00' }],
  ['payer owned', { payer_id: 'payer-1' }],
  ['statement accrued', { payer_statement_id: 'statement-1' }],
  ['withdrawn to a payer', { status: 'draft', scheduled_send_error: 'payer_billed:packet-1' }],
  ['missing token', { token: null }],
])('%s invoices never produce a recovery link', async (_label, change) => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice(change)]));

  expect(recovery.has('pay-a')).toBe(false);
});
