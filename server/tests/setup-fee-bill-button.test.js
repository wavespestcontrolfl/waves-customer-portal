// The bell's Bill and send on a "Completed first visit needs manual billing" row (services/setup-fee-bill-button.js,
// kind setup_fee_bill, GATE_SETUP_FEE_BILL_BUTTON): what the row stores, which rows refuse, and how a tap runs the
// Intelligence Bar's create step and then its send step. The two steps themselves (locks, pins, the send claim) are
// tested with their cards; the runner (claim, record, close) is admin-alert-buttons.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/create-invoice-tools', () => ({ planDraftInvoice: jest.fn(), commitDraftInvoice: jest.fn() }));
jest.mock('../services/intelligence-bar/invoice-action-tools', () => ({
  planInvoiceSend: jest.fn(), commitInvoiceSend: jest.fn(), billingChannelState: jest.fn(), messagingHold: jest.fn(),
}));
let mockObligation = null;
jest.mock('../services/setup-fee-obligation', () => ({ findUnmintedSetupFeeObligation: jest.fn(async () => mockObligation), setupFeeSettledElsewhere: jest.fn(), carriesWaveguardFeeLine: jest.requireActual('../services/setup-fee-obligation').carriesWaveguardFeeLine }));
jest.mock('../services/setup-fee-alert-reconcile', () => ({
  reconcileSetupFeeAlert: jest.fn(async () => {}),
  acceptedEstimateIdFromNotes: (notes) => (String(notes || '').match(/accepted estimate #([0-9a-f-]{36})/i) || [])[1] || null,
}));
let mockTerm = null;
let mockBought = null;
jest.mock('../services/annual-prepay-renewals', () => ({
  coveredTermsAsOf: jest.fn(() => ({ where: () => ({ first: async () => mockTerm }) })),
  prepayYearBillingVisit: jest.fn(async () => mockBought),
}));

let mockVisit = null;
let mockRow = null;
let mockInvoice = null;
let mockLive = [];
let mockAddon = null;
let mockRetention = null;
let mockWouldDraw = false;
let mockLane = 'per_application';
let mockCustomer = null;
let mockPrefs = null;
let mockSuppressed = null;
let mockDues = false;
let mockMonthLock = true;
jest.mock('../services/billing-lane', () => ({
  resolveBillingLane: jest.fn(() => ({ mode: mockLane })),
  acquireMembershipDuesMonthLockBounded: jest.fn(async () => mockMonthLock),
  monthlyDuesCollected: jest.fn(async () => mockDues),
}));
let mockTemplateOn = true;
let mockDisposition = null;
jest.mock('../services/billing-recovery-bill', () => ({ currentDisposition: jest.fn(async () => mockDisposition) }));
jest.mock('../routes/admin-sms-templates', () => ({ isTemplateActive: jest.fn(async () => mockTemplateOn) }));
jest.mock('../services/customer-credit', () => ({ autoApplyWouldApply: jest.fn(async () => mockWouldDraw) }));
let mockDeposit = null;
jest.mock('../services/estimate-deposits', () => ({
  acquireEstimateDepositLedgerLock: jest.fn(async () => {}),
  pendingDepositCredit: jest.fn(async () => mockDeposit),
}));
const mockTable = (table) => {
  if (table === 'scheduled_service_addons') return { where: () => ({ first: async () => mockAddon }) };
  if (table === 'retention_offers') return { where: () => ({ first: async () => mockRetention }) };
  const q = {
    where: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNot: jest.fn(() => q), whereNotIn: jest.fn(() => q), orderBy: jest.fn(() => q), forUpdate: jest.fn(() => q),
    select: jest.fn(async () => mockLive),
    first: jest.fn(async () => ({ scheduled_services: mockVisit, notifications: mockRow, invoices: mockInvoice, customers: mockCustomer, notification_prefs: mockPrefs, messaging_suppression: mockSuppressed })[table]),
  };
  return q;
};
jest.mock('../models/db', () => jest.fn((table) => mockTable(table)));

const Create = require('../services/intelligence-bar/create-invoice-tools');
const Send = require('../services/intelligence-bar/invoice-action-tools');
const { setupFeeSettledElsewhere } = require('../services/setup-fee-obligation');
const { buttonViolations } = require('../services/admin-alert-compose');
const { buttonHandler, billButtons, _private: { APPLICATION_LINE, FEE_LINE } } = require('../services/setup-fee-bill-button');
const { _private: { KINDS } } = require('../services/admin-alert-buttons');

const EST = '00000000-0000-4000-8000-0000000e5701';
const VISIT = '00000000-0000-4000-8000-0000000a1501';
const RECORD = '00000000-0000-4000-8000-0000000c0001';
const CUST = '00000000-0000-4000-8000-0000000b0001';
const INV = '00000000-0000-4000-8000-0000000d0001';
const APP = 4500;
const FEE = 9900;
const EDITED = new Date('2026-11-24T12:00:00Z');
const PRICED = { estimated_price: '45.00', primary_line_price: null, scheduled_date: '2026-11-23' };

const meta = (over = {}) => ({
  dedupeKey: `unminted_setup_fee_manual_billing:${EST}`, sourceEstimateId: EST, scheduledServiceId: VISIT,
  serviceRecordId: RECORD, customerId: CUST, expectedSetupFeeCents: FEE,
  expectedApplicationCentsByVisit: { [VISIT]: APP }, buttons: billButtons({ applicationCents: APP, feeCents: FEE, visit: PRICED }), ...over,
});
const item = () => billButtons({ applicationCents: APP, feeCents: FEE, visit: PRICED }).items[0];
const tap = (metaOver = {}, itemOver = null) => buttonHandler.run({
  row: { id: 'n1', metadata: meta(metaOver) }, item: itemOver || item(), technicianId: 't-1',
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_SETUP_FEE_BILL_BUTTON = 'true';
  mockVisit = { id: VISIT, customer_id: CUST, source_estimate_id: EST, status: 'completed', ...PRICED };
  mockRow = { id: 'n1', done_at: null, metadata: meta() };
  mockLive = [];
  mockTerm = null;
  mockBought = null;
  mockAddon = null;
  mockRetention = null;
  mockDeposit = null;
  mockWouldDraw = false;
  mockObligation = { owed: true, setupFee: 99 };
  mockLane = 'per_application';
  mockDues = false;
  mockMonthLock = true;
  mockInvoice = {
    status: 'draft', total: '144.00', sent_at: null, updated_at: EDITED,
    line_items: [{ description: APPLICATION_LINE, amount: 45 }, { description: FEE_LINE, amount: 99 }],
  };
  setupFeeSettledElsewhere.mockResolvedValue({ settled: false, open: [] });
  Create.planDraftInvoice.mockResolvedValue({ _version: { v: 1 }, _approved: { visitInvoices: [], expectedTotalCents: APP + FEE, scheduledServiceId: VISIT } });
  Create.commitDraftInvoice.mockResolvedValue({ success: true, invoice_id: INV, invoice_number: 'WPC-T-1', amount: '$144.00', invoice_version: EDITED.getTime() });
  Send.planInvoiceSend.mockResolvedValue({ channel: 'text', _version: { total_cents: APP + FEE, invoice_version: EDITED.getTime() } });
  Send.commitInvoiceSend.mockResolvedValue({ text: { status: 'sent' } });
  Send.billingChannelState.mockResolvedValue({ supported: true });
  Send.messagingHold.mockResolvedValue(false);
  mockCustomer = { id: CUST, phone: '+19415550100' };
  mockPrefs = null;
  mockTemplateOn = true;
  mockDisposition = null;
  mockSuppressed = null;
});

afterAll(() => { delete process.env.GATE_SETUP_FEE_BILL_BUTTON; });

test('the row stores one Bill and send button within the button rules, and the runner knows its kind', () => {
  const buttons = billButtons({ applicationCents: APP, feeCents: FEE, visit: PRICED });
  expect(buttonViolations(buttons)).toEqual([]);
  expect(buttons.items[0]).toMatchObject({ id: 'bill_send', label: 'Bill and send $144.00', args: { applicationCents: APP, feeCents: FEE, priceCents: 4500, primaryCents: -1 } });
  expect(billButtons({ applicationCents: 0, feeCents: FEE, visit: PRICED })).toBeNull();
  expect(KINDS.setup_fee_bill().live()).toBe(true);
  process.env.GATE_SETUP_FEE_BILL_BUTTON = 'false';
  expect(KINDS.setup_fee_bill().live()).toBe(false);
});

test('a tap creates one invoice with the two named lines and the estimate notes, then sends it by text', async () => {
  const out = await tap();
  // keepOpen: the stamped-invoice reconcile, not the runner, decides when the row closes.
  expect(out).toMatchObject({ ok: true, keepOpen: true, message: 'Invoice WPC-T-1 for $144.00 was created and sent.' });
  const input = Create.planDraftInvoice.mock.calls[0][0];
  expect(input).toMatchObject({
    customer_id: CUST, service_record_id: RECORD, notes: `accepted estimate #${EST}`,
    line_items: [
      { description: APPLICATION_LINE, quantity: 1, unit_price: 45 },
      { description: FEE_LINE, quantity: 1, unit_price: 99 },
    ],
  });
  expect(Create.commitDraftInvoice).toHaveBeenCalledWith(expect.objectContaining({ _verified_invoice_create_version: { v: 1 }, _callerRecheck: expect.any(Function) }));
  expect(Send.commitInvoiceSend).toHaveBeenCalledWith(
    { invoice_id: INV, _verified_invoice_send_version: { total_cents: APP + FEE, invoice_version: EDITED.getTime() }, _callerVerify: expect.any(Function) },
    { isAdmin: true, technicianId: 't-1' },
  );
});

test('a customer who does not get invoices by text is refused before anything is created', async () => {
  Send.billingChannelState.mockResolvedValue({ supported: false });
  expect((await tap()).ok).toBe(false);
  expect(Create.commitDraftInvoice).not.toHaveBeenCalled();
});

test('a collections hold, no phone, or a visit not billed at its own price refuses before anything is created', async () => {
  Send.messagingHold.mockResolvedValueOnce(true);
  expect((await tap()).ok).toBe(false);
  mockTemplateOn = false;
  expect((await tap()).message).toMatch(/template is switched off/);
  mockTemplateOn = true;
  mockPrefs = { sms_enabled: false };
  expect((await tap()).message).toMatch(/opted out/);
  mockPrefs = null;
  mockSuppressed = { phone: '+19415550100' };
  expect((await tap()).message).toMatch(/Texts to this customer's phone are blocked/);
  mockSuppressed = null;
  mockCustomer = { id: CUST, phone: null };
  expect((await tap()).ok).toBe(false);
  mockCustomer = { id: CUST, phone: '+19415550100' };
  const ratePriced = { applicationCents: APP, feeCents: FEE, priceCents: -1, primaryCents: -1 };
  expect((await tap({}, { ...item(), args: ratePriced })).ok).toBe(false);
  expect(Create.commitDraftInvoice).not.toHaveBeenCalled();
});

test('the send refuses when another invoice now bills the visit or the fee (a $0 waiver included)', async () => {
  await tap();
  const verify = Send.commitInvoiceSend.mock.calls[0][0]._callerVerify;
  const database = (table) => mockTable(table);
  database.transaction = async (fn) => fn(database);
  database.raw = async () => {};
  mockLive = [{ id: 'other', line_items: [{ description: FEE_LINE, amount: 99 }] }];
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/now bills this visit or the setup fee/);
  mockLive = [{ id: 'waiver', line_items: [{ description: 'Membership setup fee (waived)', amount: 0 }] }];
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/now bills/);
  mockLive = [{ id: 'stamped', notes: `accepted estimate #${EST}`, line_items: [{ description: APPLICATION_LINE, amount: 45 }] }];
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/now bills/);
  mockLive = [{ id: 'visit-inv', scheduled_service_id: VISIT, line_items: [{ description: 'Quarterly Pest Control', amount: 45 }] }];
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/now bills/);
  mockLive = [];
  setupFeeSettledElsewhere.mockResolvedValueOnce({ settled: true });
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/now bills/);
  expect(await verify({ id: INV, customer_id: CUST }, database)).toBeNull();
});

test.each([
  ['a resolved row', { resolvedCovered: true }],
  ['a second unbilled visit on the estimate', { parkedVisitIds: [VISIT, '00000000-0000-4000-8000-0000000a1502'] }],
  ['another invoice beside the visit', { liveBesideInvoiceId: INV }],
  ['amounts that changed since the row was raised', { expectedSetupFeeCents: 5000 }],
  ['a row of another kind', { dedupeKey: 'other:1' }],
])('%s creates nothing', async (_name, over) => {
  const out = await tap(over);
  expect(out.ok).toBe(false);
  expect(Create.commitDraftInvoice).not.toHaveBeenCalled();
  expect(Send.commitInvoiceSend).not.toHaveBeenCalled();
});

test('a visit that changed, a row the reconcile resolved, a taxed total, or an invoice already on the visit creates nothing', async () => {
  mockVisit = { ...mockVisit, status: 'cancelled' };
  expect((await tap()).ok).toBe(false);
  mockVisit = { ...mockVisit, status: 'completed' };
  mockRow = { id: 'n1', done_at: null, metadata: meta({ resolvedCovered: true }) };
  const resolved = await tap();
  expect(resolved).toMatchObject({ ok: false, code: 'office' });
  expect(resolved.close).toBeUndefined();
  mockRow = { id: 'n1', done_at: null, metadata: meta() };
  Create.planDraftInvoice.mockResolvedValueOnce({ _version: {}, _approved: { visitInvoices: [], expectedTotalCents: APP + FEE + 1008, scheduledServiceId: VISIT } });
  expect((await tap()).ok).toBe(false);
  Create.planDraftInvoice.mockResolvedValueOnce({ _version: {}, _approved: { visitInvoices: ['WPC-1:open'], expectedTotalCents: APP + FEE, scheduledServiceId: VISIT } });
  expect((await tap()).ok).toBe(false);
  expect(Create.commitDraftInvoice).not.toHaveBeenCalled();
});

test('the check inside the create transaction refuses any coverage that landed since the tap read the records', async () => {
  await tap();
  const recheck = Create.commitDraftInvoice.mock.calls[0][0]._callerRecheck;
  const trx = (table) => mockTable(table);
  trx.transaction = async (fn) => fn(trx);
  trx.raw = jest.fn(async () => {});
  await expect(recheck(trx)).resolves.toBeUndefined();
  mockLive = [{ id: 'i1', notes: `accepted estimate #${EST}` }];
  await expect(recheck(trx)).rejects.toMatchObject({ statusCode: 409 });
  // A draft for ANOTHER estimate that carries the fee (an earlier tap whose send failed).
  mockLive = [{ id: 'i4', notes: 'accepted estimate #00000000-0000-4000-8000-0000000e5799', line_items: [{ description: FEE_LINE, amount: 99 }] }];
  await expect(recheck(trx)).rejects.toThrow(/is already on an invoice/);
  mockLive = [];
  setupFeeSettledElsewhere.mockResolvedValueOnce({ settled: false, open: [{ id: 'i2' }] });
  await expect(recheck(trx)).rejects.toMatchObject({ statusCode: 409 });
  setupFeeSettledElsewhere.mockResolvedValueOnce({ settled: false, partial: [{ id: 'i3', cents: 4000 }], open: [] });
  await expect(recheck(trx)).rejects.toMatchObject({ statusCode: 409 });
  mockTerm = { id: 't1' };
  await expect(recheck(trx)).rejects.toMatchObject({ statusCode: 409 });
  mockTerm = null;
  mockRow = { id: 'n1', done_at: new Date(), metadata: meta() };
  await expect(recheck(trx)).rejects.toMatchObject({ statusCode: 409 });
  mockRow = { id: 'n1', done_at: null, metadata: meta() };
  mockAddon = { id: 'a1' };
  await expect(recheck(trx)).rejects.toThrow(/add-ons/);
  mockAddon = null;
  mockVisit = { ...mockVisit, prepaid_amount: '20.00' };
  await expect(recheck(trx)).rejects.toThrow(/prepayment/);
  mockVisit = { ...mockVisit, prepaid_amount: null };
  mockBought = { id: 'term-2' };
  await expect(recheck(trx)).rejects.toThrow(/prepay year/);
  mockBought = null;
  const Prepay = require('../services/annual-prepay-renewals');
  Prepay.prepayYearBillingVisit.mockRejectedValueOnce(new Error('db down'));
  await expect(recheck(trx)).rejects.toThrow(/prepay check failed/);
  mockRetention = { id: 'r1' };
  await expect(recheck(trx)).rejects.toThrow(/retention/);
  mockRetention = null;
  mockDeposit = { amount: 25 };
  await expect(recheck(trx)).rejects.toThrow(/deposit/);
  mockDeposit = null;
  // Re-parked after the tap: a second visit, or new amounts.
  mockRow = { id: 'n1', done_at: null, metadata: meta({ parkedVisitIds: [VISIT, '00000000-0000-4000-8000-0000000a1502'] }) };
  await expect(recheck(trx)).rejects.toThrow(/changed after the tap/);
  mockRow = { id: 'n1', done_at: null, metadata: meta({ expectedSetupFeeCents: 5000 }) };
  await expect(recheck(trx)).rejects.toThrow(/changed after the tap/);
  mockRow = { id: 'n1', done_at: null, metadata: meta() };
  await expect(recheck(trx)).resolves.toBeUndefined();
  // A price corrected after the completion.
  mockVisit = { ...mockVisit, estimated_price: '60.00' };
  await expect(recheck(trx)).rejects.toThrow(/price changed/);
  mockVisit = { ...mockVisit, ...PRICED };
  // A fee line named only by its category on another draft; a bait-station setup fee does not block.
  mockLive = [{ id: 'i5', notes: '', line_items: [{ description: 'Quarterly Pest Control', category: 'WaveGuard Membership', amount: 99 }] }];
  await expect(recheck(trx)).rejects.toThrow(/is already on an invoice/);
  mockLive = [{ id: 'i6', notes: '', line_items: [{ description: 'Bait station setup fee', amount: 75 }] }];
  await expect(recheck(trx)).resolves.toBeUndefined();
  mockLive = [];
  mockWouldDraw = true;
  await expect(recheck(trx)).rejects.toThrow(/Account credit/);
  mockWouldDraw = false;
  mockObligation = { owed: false, deferredToFirstVisit: true };
  await expect(recheck(trx)).rejects.toThrow(/no longer owed/);
  mockObligation = { owed: true, setupFee: 99 };
  mockVisit = { ...mockVisit, pending_setup_fee: '99.00' };
  await expect(recheck(trx)).rejects.toThrow(/queued on this plan/);
  mockVisit = { ...mockVisit, pending_setup_fee: null };
  mockLane = 'monthly_membership';
  await expect(recheck(trx)).rejects.toThrow(/Monthly dues or a prepay/);
  mockLane = 'per_application';
  mockDues = true;
  await expect(recheck(trx)).rejects.toThrow(/dues already cover/);
  mockDues = false;
  mockMonthLock = false;
  await expect(recheck(trx)).rejects.toThrow(/busy/);
  mockMonthLock = true;
  mockObligation = { owed: true, setupFee: 99, unconsumableStamps: [{ seriesId: 'other' }] };
  await expect(recheck(trx)).rejects.toThrow(/no longer owed/);
  mockObligation = { owed: true, setupFee: 99 };
  mockVisit = { ...mockVisit, source_estimate_id: '00000000-0000-4000-8000-0000000e5799' };
  await expect(recheck(trx)).rejects.toThrow(/visit changed/);
});

test('the create takes the customer row FOR UPDATE before the card\'s own locks', async () => {
  await tap();
  const { _callerPreLock: preLock } = Create.commitDraftInvoice.mock.calls[0][0];
  const order = [];
  const forUpdate = jest.fn(() => ({ first: async () => ({ id: CUST }), select: async () => [] }));
  const chain = { whereNotIn: () => chain, orderBy: () => chain, forUpdate };
  const where = jest.fn(() => ({ ...chain, forUpdate }));
  const trx = jest.fn((table) => { order.push(table); return { where }; });
  trx.raw = jest.fn(async () => {});
  await preLock(trx);
  // The customer row first (as an invoice send takes it), then its live invoices; both waits bounded.
  expect(order).toEqual(['customers', 'invoices']);
  expect(trx.raw.mock.calls.map((c) => c[0])).toEqual(["SET LOCAL lock_timeout = '3s'", 'SET LOCAL lock_timeout TO DEFAULT']);
  // Contention refuses retryably.
  forUpdate.mockImplementationOnce(() => ({ first: async () => { throw Object.assign(new Error('lock timeout'), { code: '55P03' }); } }));
  await expect(preLock(trx)).rejects.toMatchObject({ statusCode: 409 });
  expect(where).toHaveBeenCalledWith({ id: CUST });
  expect(forUpdate).toHaveBeenCalled();
});

test('the bell serves the button only while the row reads as the plain case', async () => {
  const rows = [
    { id: 'a', metadata: meta() },
    { id: 'b', metadata: meta({ feeCovered: true }) },
    { id: 'c', metadata: meta({ parkedVisitIds: [VISIT, '00000000-0000-4000-8000-0000000a1502'] }) },
    { id: 'd', metadata: meta({ resolvedCovered: true }) },
    { id: 'e', metadata: meta({ feeOnOpenInvoice: true }) },
    { id: 'f', metadata: meta({ coveredFeeCents: 4000 }) },
  ];
  const served = await buttonHandler.visibleItems(rows);
  expect([...served.keys()]).toEqual(['a']);
});

test('a service record that now links another visit creates nothing', async () => {
  Create.planDraftInvoice.mockResolvedValueOnce({ _version: {}, _approved: { visitInvoices: [], expectedTotalCents: APP + FEE, scheduledServiceId: '00000000-0000-4000-8000-0000000a1599' } });
  expect((await tap()).ok).toBe(false);
  expect(Create.commitDraftInvoice).not.toHaveBeenCalled();
});

test('a refused send on a draft someone else sent meanwhile says to check delivery, never to resend', async () => {
  Send.commitInvoiceSend.mockImplementationOnce(async () => { mockInvoice = { ...mockInvoice, status: 'open', sent_at: new Date() }; return { failed: true, code: 'preview_changed', error: 'changed' }; });
  expect((await tap()).message).toMatch(/changed or sent by someone else/);
});

test('the send carries a credit check that runs under its claim', async () => {
  await tap();
  const verify = Send.commitInvoiceSend.mock.calls[0][0]._callerVerify;
  mockWouldDraw = true;
  const database = (t) => mockTable(t);
  database.transaction = async (fn) => fn(database);
  database.raw = async () => {};
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/Account credit would apply/);
  mockWouldDraw = false;
  // Visit-side coverage that landed after the create: dues for the visit's month, a prepayment.
  mockDues = true;
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/dues already cover/);
  mockDues = false;
  mockVisit = { ...mockVisit, prepaid_amount: '10.00' };
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/prepayment/);
  mockVisit = { ...mockVisit, prepaid_amount: null };
  mockDisposition = { disposition: 'intentionally_free', stale: false };
  expect(await verify({ id: INV, customer_id: CUST }, database)).toMatch(/Billing Recovery already handled/);
});

test('a send refused because coverage changed says to reconcile, never to send it by hand', async () => {
  Send.commitInvoiceSend.mockImplementationOnce(async (input) => {
    mockDues = true;
    const why = await input._callerVerify({ id: INV, customer_id: CUST }, Object.assign((t) => mockTable(t), { raw: async () => {}, transaction: async (fn) => fn(Object.assign((t) => mockTable(t), { raw: async () => {} })) }));
    return { error: why };
  });
  const out = await tap();
  expect(out.message).toMatch(/Reconcile it/);
  expect(out.message).not.toMatch(/Send it from the Invoices page/);
});

test('a send whose record could not be finished says to check, even when a leg reads sent', async () => {
  Send.commitInvoiceSend.mockResolvedValueOnce({ outcome_unknown: true, code: 'INVOICE_DELIVERY_RECORD_FAILED', text: { status: 'sent' } });
  expect((await tap()).message).toMatch(/could not be confirmed/);
});

test('a draft edited after its creation (same amounts, new edit time) is never sent', async () => {
  mockInvoice = { ...mockInvoice, updated_at: new Date(EDITED.getTime() + 5000) };
  Send.planInvoiceSend.mockResolvedValue({ channel: 'text', _version: { total_cents: APP + FEE, invoice_version: EDITED.getTime() + 5000 } });
  expect((await tap()).message).toMatch(/changed or sent by someone else/);
  expect(Send.commitInvoiceSend).not.toHaveBeenCalled();
});

test('a draft edited between the create and the send is never sent, and the answer says to check its delivery', async () => {
  mockInvoice = { ...mockInvoice, total: '150.00' };
  const out = await tap();
  expect(out.ok).toBe(true);
  expect(out.message).toMatch(/changed or sent by someone else/);
  expect(Send.commitInvoiceSend).not.toHaveBeenCalled();
});

test('a send that needs no other delivery (scheduled pay-link text, already delivered) never asks for a manual send', async () => {
  Send.commitInvoiceSend.mockResolvedValueOnce({ code: 'invoice_send_queued', failed: true });
  expect((await tap()).message).toMatch(/already scheduled/);
  Send.planInvoiceSend.mockResolvedValueOnce({ error: 'A pay-link text is already scheduled', code: 'invoice_send_queued' });
  expect((await tap()).message).toMatch(/already scheduled/);

  Send.commitInvoiceSend.mockResolvedValueOnce({ success: true, note: 'Nothing new was sent: the invoice was already delivered or is being delivered.' });
  expect((await tap()).message).toMatch(/already delivered/);
});

test('a create whose outcome is unknown never sends and never invites a blind retry', async () => {
  Create.commitDraftInvoice.mockResolvedValue({ outcome_unknown: true });
  const out = await tap();
  expect(out).toMatchObject({ ok: false, code: 'unknown' });
  expect(Send.commitInvoiceSend).not.toHaveBeenCalled();
});

test('a created invoice whose send is refused leaves the row to the reconcile and says to send it from the Invoices page', async () => {
  Send.planInvoiceSend.mockResolvedValue({ error: 'no phone on file' });
  const out = await tap();
  expect(out.ok).toBe(true);
  expect(out.message).toMatch(/created but not sent .*Invoices page/);
  expect(Send.commitInvoiceSend).not.toHaveBeenCalled();
});
