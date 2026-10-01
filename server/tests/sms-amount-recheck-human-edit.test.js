/**
 * Zelle target resolution at send time (Codex rounds 29-32, PR #5331): an edited Zelle offer that names another invoice is
 * rechecked against THAT invoice, the body's explicit target beats the customer's message, and an offer plus a denial in one
 * reply are both rechecked. (The free-text payment-claim binders that used to share this file are gone: a payment status now
 * reaches a customer only as a copy of a rendered sentence - tests/sms-amount-recheck.test.js, tests/payment-status-contract.test.js.)
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({
  ...jest.requireActual('../services/context-aggregator'),
  getContextForCustomer: jest.fn(),
}));
const ContextAggregator = require('../services/context-aggregator');

describe('an edited Zelle offer that names another invoice is rechecked against THAT invoice', () => {
  const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const pay = require('../routes/pay-v2');
  const open = [
    { id: 'inv-A', invoiceNumber: 'WPC-2026-0001', status: 'sent', amountDue: 95 },
    { id: 'inv-B', invoiceNumber: 'WPC-2026-0002', status: 'sent', amountDue: 210 },
  ];
  const withOpen = { billing: { outstandingBalance: 0, recentPayments: [], openInvoice: open[0], openInvoices: open } };
  let visibility;
  beforeEach(() => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    visibility = jest.spyOn(pay, 'payPageZelleVisibility').mockImplementation(async ({ invoice }) => ({ visible: invoice.id === 'inv-A' || invoice.id === 'inv-B', reason: null }));
    ContextAggregator.getContextForCustomer.mockResolvedValue(withOpen);
  });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; visibility.mockRestore(); });
  const idDb = (table) => ({ where: (w) => ({ first: async () => (table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent' } : { id: 'c1' }) }) });
  const run = (body, snapshotId) => outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v11', zelleInvoiceId: snapshotId, inboundMessage: null, trustOwedAmounts: true, dbh: idDb });

  test('the edit names invoice B while the snapshot is A: B is checked (not A)', async () => {
    const checked = [];
    const dbh = (table) => ({ where: (w) => ({ first: async () => { if (table === 'invoices') checked.push(w.id); return table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent' } : { id: 'c1' }; } }) });
    await outgoingAmountsStale({ customerId: 'c1', body: 'You can Zelle invoice WPC-2026-0002 to pay@example.com.', promptVersion: 'house_voice_v11', zelleInvoiceId: 'inv-A', trustOwedAmounts: true, dbh });
    expect(checked).toEqual(['inv-B']);
  });
  test('B is not eligible => the edited offer blocks even though the snapshot invoice A still is', async () => {
    visibility.mockImplementation(async ({ invoice }) => ({ visible: invoice.id !== 'inv-B', reason: 'not_eligible' }));
    await expect(run('You can Zelle invoice #0002 to pay@example.com.', 'inv-A')).resolves.toMatchObject({ stale: true, reason: 'zelle_invoice_ineligible' });
  });
  test('the edit names an invoice that is not open / cannot be resolved => blocked (unresolved)', async () => {
    await expect(run('You can Zelle invoice WPC-2026-0999 to pay@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
    await expect(run('You can Zelle the $77 invoice to pay@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
  });
  test('the edit names the SAME invoice as the snapshot, or no invoice at all: the snapshot is used as before', async () => {
    const checked = [];
    const dbh = (table) => ({ where: (w) => ({ first: async () => { if (table === 'invoices') checked.push(w.id); return table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent' } : { id: 'c1' }; } }) });
    await outgoingAmountsStale({ customerId: 'c1', body: 'You can Zelle invoice WPC-2026-0001 to pay@example.com.', promptVersion: 'house_voice_v11', zelleInvoiceId: 'inv-A', trustOwedAmounts: true, dbh });
    await outgoingAmountsStale({ customerId: 'c1', body: 'You can Zelle us at pay@example.com.', promptVersion: 'house_voice_v11', zelleInvoiceId: 'inv-A', trustOwedAmounts: true, dbh });
    expect(checked).toEqual(['inv-A', 'inv-A']);
    await expect(run('You can Zelle us at pay@example.com.', 'inv-A')).resolves.toEqual({ stale: false, zelleInvoiceId: 'inv-A' });
  });
});

// Codex round-30 P1 (2): pre-v12 non-human scheduled bodies get the clause-aware status / receipt check when asked.

describe('no snapshot: the body\'s explicit target beats the inbound\'s', () => {
  const { outgoingAmountsStale, zelleDenialStale } = require('../services/sms-amount-recheck');
  const pay = require('../routes/pay-v2');
  const open = [
    { id: 'inv-A', invoiceNumber: 'WPC-2026-0001', status: 'sent', amountDue: 95 },
    { id: 'inv-B', invoiceNumber: 'WPC-2026-0002', status: 'sent', amountDue: 210 },
  ];
  let visibility;
  const checkedIds = [];
  const idDb = (table) => ({ where: (w) => ({ first: async () => { if (table === 'invoices') checkedIds.push(w.id); return table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent' } : { id: 'c1' }; } }) });
  beforeEach(() => {
    checkedIds.length = 0;
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    visibility = jest.spyOn(pay, 'payPageZelleVisibility').mockImplementation(async () => ({ visible: true, reason: null }));
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [], openInvoice: open[0], openInvoices: open } });
  });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; visibility.mockRestore(); });
  const run = (body, inboundMessage) => outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v11', zelleInvoiceId: null, inboundMessage, trustOwedAmounts: true, dbh: idDb });

  test('body names B, inbound names A => B is checked', async () => {
    await run('You can Zelle invoice WPC-2026-0002 to pay@example.com.', 'Can I pay invoice WPC-2026-0001 by Zelle?');
    expect(checkedIds).toEqual(['inv-B']);
  });
  test('body names none => the inbound\'s invoice decides (as before)', async () => {
    await run('You can Zelle us at pay@example.com.', 'Can I pay invoice WPC-2026-0001 by Zelle?');
    expect(checkedIds).toEqual(['inv-A']);
  });
  test('body names an unresolvable invoice => blocked even though the inbound resolves', async () => {
    await expect(run('You can Zelle invoice WPC-2026-0999 to pay@example.com.', 'Can I pay invoice WPC-2026-0001 by Zelle?')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
  });
  test('a Zelle denial naming an invoice is judged for THAT invoice', async () => {
    visibility.mockImplementation(async ({ invoice }) => ({ visible: invoice.id === 'inv-B', reason: 'not_eligible' }));
    // denial about B (eligible now) => stale, even though the inbound named A (ineligible)
    await expect(zelleDenialStale({ customerId: 'c1', dbh: idDb, inboundMessage: 'Can I pay invoice WPC-2026-0001 by Zelle?', body: 'Zelle is not available for invoice WPC-2026-0002.' })).resolves.toEqual({ stale: true, reason: 'zelle_now_available' });
    // no reference in the body => the inbound (A, ineligible) => the denial stands
    await expect(zelleDenialStale({ customerId: 'c1', dbh: idDb, inboundMessage: 'Can I pay invoice WPC-2026-0001 by Zelle?', body: "Zelle isn't available for this account right now." })).resolves.toEqual({ stale: false, zelleDenial: { invoiceId: 'inv-A' } });
  });
});


describe('a Zelle offer AND a denial in one reply are both rechecked', () => {
  const { outgoingAmountsStale, zelleClauseTexts } = require('../services/sms-amount-recheck');
  const pay = require('../routes/pay-v2');
  const open = [
    { id: 'inv-A', invoiceNumber: 'WPC-2026-0001', status: 'sent', amountDue: 95 },
    { id: 'inv-B', invoiceNumber: 'WPC-2026-0002', status: 'sent', amountDue: 210 },
  ];
  let visibility;
  const checkedIds = [];
  const idDb = (table) => ({ where: (w) => ({ first: async () => { if (table === 'invoices') checkedIds.push(w.id); return table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent' } : { id: 'c1' }; } }) });
  beforeEach(() => {
    checkedIds.length = 0;
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [], openInvoice: open[0], openInvoices: open } });
  });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; if (visibility) visibility.mockRestore(); });
  const BODY = "Zelle isn't available for invoice WPC-2026-0001. You can Zelle invoice WPC-2026-0002 to pay@example.com.";
  const run = () => outgoingAmountsStale({ customerId: 'c1', body: BODY, promptVersion: 'house_voice_v11', zelleInvoiceId: null, inboundMessage: null, trustOwedAmounts: true, dbh: idDb });

  test('clause texts are separated: each clause targets its own invoice', () => {
    const t = zelleClauseTexts(BODY);
    expect(t.denialText).toContain('WPC-2026-0001');
    expect(t.denialText).not.toContain('WPC-2026-0002');
    expect(t.offerText).toContain('WPC-2026-0002');
    expect(t.offerText).not.toContain('WPC-2026-0001');
  });
  test('offer to B is eligible and A is ineligible => the DENIAL about A stands, the reply is fine', async () => {
    visibility = jest.spyOn(pay, 'payPageZelleVisibility').mockImplementation(async ({ invoice }) => ({ visible: invoice.id === 'inv-B', reason: 'not_eligible' }));
    await expect(run()).resolves.toEqual({ stale: false, zelleInvoiceId: 'inv-B', zelleDenial: { invoiceId: 'inv-A' } });
    expect([...new Set(checkedIds)].sort()).toEqual(['inv-A', 'inv-B']); // (the denial's PaymentIntent baseline reads A once more)
  });
  test('the denial about A is now STALE (A became eligible) — caught even though the offer branch passed', async () => {
    visibility = jest.spyOn(pay, 'payPageZelleVisibility').mockImplementation(async () => ({ visible: true, reason: null }));
    await expect(run()).resolves.toEqual({ stale: true, reason: 'zelle_now_available' });
  });
  test('the OFFER is stale (B ineligible) => blocked before the denial is even needed', async () => {
    visibility = jest.spyOn(pay, 'payPageZelleVisibility').mockImplementation(async ({ invoice }) => ({ visible: invoice.id === 'inv-A' ? false : false, reason: 'not_eligible' }));
    await expect(run()).resolves.toMatchObject({ stale: true, reason: 'zelle_invoice_ineligible' });
  });
});
