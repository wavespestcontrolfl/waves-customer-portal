/**
 * Staff-edited (and pre-v12) bodies at send time (PR #5331): a Zelle CONTACT in the body must be the current recipient and the
 * decision's target invoice must still take Zelle; every figure is judged by main's owed-amount rule. (The clause grammar that
 * used to classify Zelle offers / denials, and bind each to the invoice it named, is gone: Zelle now reaches a customer only as a
 * copy of a rendered sentence - tests/sms-amount-recheck.test.js, tests/payment-status-contract.test.js.)
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({
  ...jest.requireActual('../services/context-aggregator'),
  getContextForCustomer: jest.fn(),
}));
const ContextAggregator = require('../services/context-aggregator');

// A STAFF-EDITED (or pre-v12) body is the staff member's own wording: a Zelle CONTACT in it must be the current recipient AND the decision's
// target invoice (the persisted zelleInvoiceId) must still take Zelle; a Zelle mention with no contact is the staff member's own words.
describe('a staff Zelle contact is rechecked against the decision\'s target invoice', () => {
  const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const pay = require('../routes/pay-v2');
  const open = [
    { id: 'inv-A', invoiceNumber: 'WPC-2026-0001', status: 'sent', amountDue: 95 },
    { id: 'inv-B', invoiceNumber: 'WPC-2026-0002', status: 'sent', amountDue: 210 },
  ];
  const withOpen = { billing: { outstandingBalance: 0, recentPayments: [], openInvoice: open[0], openInvoices: open } };
  let visibility;
  const checked = [];
  const idDb = (table) => ({ where: (w) => ({ first: async () => {
    if (table === 'invoices') checked.push(w.id);
    return table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent', invoice_number: w.id === 'inv-A' ? 'WPC-2026-0001' : 'WPC-2026-0002' } : { id: 'c1' };
  } }) });
  beforeEach(() => {
    checked.length = 0;
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    visibility = jest.spyOn(pay, 'payPageZelleVisibility').mockImplementation(async ({ invoice }) => ({ visible: invoice.id === 'inv-A' || invoice.id === 'inv-B', reason: null }));
    ContextAggregator.getContextForCustomer.mockResolvedValue(withOpen);
  });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; visibility.mockRestore(); });
  const run = (body, zelleInvoiceId, extra = {}) => outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v11', zelleInvoiceId, inboundMessage: null, trustOwedAmounts: true, dbh: idDb, ...extra });

  test('the decision\'s target invoice is the one checked; a pass carries the live Zelle facts', async () => {
    await expect(run('You can Zelle us at pay@example.com.', 'inv-A')).resolves.toEqual({
      stale: false, zelle: { state: 'offer', invoiceId: 'inv-A', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' },
    });
    expect([...new Set(checked)]).toEqual(['inv-A']);
  });
  test('the target invoice no longer takes Zelle => blocked (zelle_invoice_ineligible), even though another invoice still does', async () => {
    visibility.mockImplementation(async ({ invoice }) => ({ visible: invoice.id !== 'inv-A', reason: 'not_eligible' }));
    await expect(run('You can Zelle us at pay@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });
  test('no target invoice on the decision (a body a person typed Zelle into) => blocked, never guessed from the account', async () => {
    await expect(run('You can Zelle us at pay@example.com.', null)).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
    expect(checked).toEqual([]);
  });
  test('a target invoice that no longer resolves for this customer, or an unverifiable eligibility read, blocks too', async () => {
    const gone = (table) => ({ where: () => ({ first: async () => (table === 'invoices' ? null : { id: 'c1' }) }) });
    await expect(run('You can Zelle us at pay@example.com.', 'inv-A', { dbh: gone })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
    // an unverifiable read is an outage: still blocked, but retryable (Codex round-71 P2)
    visibility.mockRejectedValue(new Error('stripe down'));
    await expect(run('You can Zelle us at pay@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_recheck_failed' });
  });
  // Codex round-71 P1: an edit that re-targets by Zelle transfer amount alone is checked against THAT invoice
  test('the edit names only a Zelle transfer amount: it re-targets to the invoice with that amount', () => {
    const { explicitInvoiceReference } = require('../services/zelle-target-invoice');
    expect(explicitInvoiceReference('Zelle $200 to pay@example.com')).toBe(true);
    expect(explicitInvoiceReference('You can send 200 dollars by Zelle.')).toBe(true);
    expect(explicitInvoiceReference('You can Zelle us at pay@example.com.')).toBe(false);
  });
  test('"Zelle $210 to ..." on a decision targeted at the $95 invoice A: invoice B ($210) is the one checked', async () => {
    await expect(run('Zelle $210 to pay@example.com', 'inv-A')).resolves.toMatchObject({ stale: false, zelle: { invoiceId: 'inv-B' } });
    visibility.mockImplementation(async ({ invoice }) => ({ visible: invoice.id === 'inv-A', reason: 'not_eligible' }));
    await expect(run('Zelle $210 to pay@example.com', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });
  // a reviewer edit that NAMES another invoice re-targets the instructions (Codex rounds 29/30): THAT invoice is checked
  test('the edit names invoice B while the target is A: B is checked, and blocks when B no longer takes Zelle', async () => {
    await expect(run('You can Zelle invoice WPC-2026-0002 to pay@example.com.', 'inv-A')).resolves.toMatchObject({ stale: false, zelle: { invoiceId: 'inv-B' } });
    visibility.mockImplementation(async ({ invoice }) => ({ visible: invoice.id === 'inv-A', reason: 'not_eligible' }));
    await expect(run('You can Zelle invoice WPC-2026-0002 to pay@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });
  test('no target on the decision: the invoice the customer named is resolved and checked', async () => {
    await expect(run('You can Zelle us at pay@example.com.', null, { inboundMessage: 'Can I Zelle invoice WPC-2026-0001?' })).resolves.toMatchObject({ stale: false, zelle: { invoiceId: 'inv-A' } });
  });
  test('a wrong or removed recipient blocks first (zelle_recipient_stale), without the eligibility read', async () => {
    await expect(run('You can Zelle us at old@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_recipient_stale' });
    delete process.env.ZELLE_RECIPIENT;
    await expect(run('You can Zelle us at pay@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_recipient_stale' });
    expect(checked).toEqual([]);
  });
  test('a Zelle mention with NO contact is the staff member\'s own wording: it passes with no reads', async () => {
    await expect(run('Yes, we take Zelle - just put your name in the memo.', null)).resolves.toEqual({ stale: false });
    await expect(run('We do not take Zelle for that one.', 'inv-A')).resolves.toEqual({ stale: false });
    expect(checked).toEqual([]);
  });
});

// Local Codex review pass 2: a STAFF EDIT's copied sentences are not re-verified by the contract, so every figure in it is judged by
// main's rule (owed, plus settled payments in an acknowledgement)
describe('staff-edited real-answers bodies: amounts judged against live billing', () => {
  const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const V12 = 'house_voice_v12_real_answers5_cflvp';
  const dbh = (table) => ({ where: () => ({ first: async () => (table === 'customers' ? { id: 'c1' } : null) }) });
  const live = (billing) => ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [], ...billing } });
  const staff = (body) => outgoingAmountsStale({ customerId: 'c1', body, promptVersion: V12, humanEditedBody: true, paymentStatusSnapshot: { sentences: ['Your account balance is $95.00.'] }, dbh });
  test('a copied balance kept in a staff edit is stale once the customer has paid it (live balance $0)', async () => {
    live({ outstandingBalance: 0 });
    await expect(staff('Your account balance is $95.00. Thanks!')).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
    live({ outstandingBalance: 95 });
    await expect(staff('Your account balance is $95.00. Thanks!')).resolves.toEqual({ stale: false });
  });
  test('a staff-written receipt amount backed by a settled payment sends; an unbacked one is stale', async () => {
    live({ recentPayments: [{ id: 'p1', amount: 120, status: 'paid', payment_date: '2026-09-12' }] });
    await expect(staff('Thanks, we received your $120.00 payment.')).resolves.toEqual({ stale: false });
    await expect(staff('Thanks, we received your $150.00 payment.')).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
});

// Codex round-73: verb-led figures re-target a staff edit too; a figure that matches no invoice keeps the decision's target
describe('staff Zelle edit re-targeting by figure (round 73)', () => {
  test('explicitInvoiceReference: any dollar figure counts', () => {
    const { explicitInvoiceReference } = require('../services/zelle-target-invoice');
    expect(explicitInvoiceReference('You can use Zelle to send $200 to pay@example.com.')).toBe(true);
    expect(explicitInvoiceReference('Make a $200 Zelle payment to pay@example.com.')).toBe(true);
  });
});
