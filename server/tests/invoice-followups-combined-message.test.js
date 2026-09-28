// Combined dunning message (dunning unification PR 2b,
// GATE_DUNNING_COMBINED_MESSAGE): a customer with 2+ overdue invoices whose
// follow-up touches are due in the same run gets ONE combined text and ONE
// combined email instead of one per invoice. Gate off: byte-identical to
// today (mocking style follows invoice-followups-ladder-90.test.js).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: (invoice) => Number(invoice?.total || 0) - Number(invoice?.credit_applied || 0),
  invoiceWithdrawnFromCustomer: (invoice) => /^payer_billed:/.test(String(invoice?.scheduled_send_error || '')),
  selfPayAtDispatch: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: { divertMicrodepositDunning: false } }));
jest.mock('../services/stripe', () => ({ isInvoiceAwaitingMicrodepositVerification: jest.fn(async () => false) }));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.wavespestcontrol.com') }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/customer-contact', () => ({ getInvoiceEmailRecipients: jest.fn() }));
jest.mock('../services/email-template', () => ({ currency: (n) => `$${Number(n || 0).toFixed(2)}` }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn(() => '') }));
jest.mock('../services/billing-email-sender', () => ({
  billingEmailRecipient: jest.fn(),
  operatorEmailRecipient: jest.fn(),
  selfPayOnlyHandoff: jest.fn(),
  billingEmailSendOutcome: jest.fn(),
  billingEmailSendFailure: jest.fn(),
}));
jest.mock('../services/billing-channel-email-authority', () => ({ dispatchUnderBillingEmailAuthority: jest.fn() }));
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: jest.fn() }));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
  markDelivered: jest.fn(async () => true),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../services/composer-customer-links', () => ({ buildPayBalanceLink: jest.fn() }));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => ({ applied: 0 })),
  reverseAppliedCredit: jest.fn(async () => {}),
}));

const db = require('../models/db');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
const ContactLedger = require('../services/collections/contact-ledger');
const { buildPayBalanceLink } = require('../services/composer-customer-links');
const { billingEmailRecipient, billingEmailSendOutcome } = require('../services/billing-email-sender');
const { runPending } = require('../services/invoice-followups');

// Wednesday 2026-08-05 10:16 AM ET, inside the Tue–Fri send window.
const NOW = new Date('2026-08-05T14:16:00Z');
const tenAmET = (day) => new Date(`${day}T14:00:00Z`);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  delete process.env.GATE_DUNNING_COMBINED_MESSAGE;
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_COLLECTIONS_POLICY;
  collectionsChannelPermitted.mockResolvedValue({ allowed: true, durable: false });
  ContactLedger.recordContact.mockImplementation(async ({ idempotencyKey }) => ({ id: `ledger-${idempotencyKey}` }));
  buildPayBalanceLink.mockResolvedValue({ url: 'https://portal.wavespestcontrol.com/pay/combined' });
  smsTemplatesRouter.getTemplate.mockResolvedValue('rendered sms body');
  sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
  billingEmailRecipient.mockResolvedValue({ recipient: { name: 'Taylor', email: 'taylor@example.com' }, to: 'taylor@example.com' });
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, message: {} });
  billingEmailSendOutcome.mockImplementation(async (result) => ({ ok: !!result.sent }));
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_DUNNING_COMBINED_MESSAGE;
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_COLLECTIONS_POLICY;
});

// A small in-memory fake table: supports the where/whereIn/forUpdate/first/
// update shapes invoice-followups.js actually issues against these tables,
// and lets updates be observed (and, for invoice_followup_sequences,
// re-read) like a real one.
function fakeTable(initialRows) {
  const rows = new Map(initialRows.map((r) => [String(r.id), { ...r }]));
  const updateCalls = [];
  function matches(filters) {
    let list = [...rows.values()];
    if (filters.id !== undefined) list = list.filter((r) => String(r.id) === String(filters.id));
    if (filters.__whereIn) {
      const { col, vals } = filters.__whereIn;
      list = list.filter((r) => vals.map(String).includes(String(r[col])));
    }
    for (const [k, v] of Object.entries(filters)) {
      if (k === 'id' || k === '__whereIn') continue;
      list = list.filter((r) => r[k] === v);
    }
    return list;
  }
  function query() {
    const filters = {};
    const q = {};
    q.where = jest.fn((...args) => {
      if (typeof args[0] === 'function') return q; // TTL/OR sub-clauses: fresh rows always pass
      if (args.length === 1 && typeof args[0] === 'object') Object.assign(filters, args[0]);
      else if (args.length === 2) filters[args[0]] = args[1];
      return q;
    });
    q.whereIn = jest.fn((col, vals) => { filters.__whereIn = { col, vals }; return q; });
    q.whereNull = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    q.first = jest.fn(async () => {
      const found = matches(filters)[0];
      return found ? { ...found } : undefined;
    });
    q.update = jest.fn(async (patch) => {
      const found = matches(filters);
      for (const row of found) Object.assign(rows.get(String(row.id)), patch);
      updateCalls.push({ filters: { ...filters }, patch });
      return found.length;
    });
    q.insert = jest.fn(async () => [{ id: 'interaction-1' }]);
    return q;
  }
  return { query, rows, updateCalls };
}

function seqRow(overrides = {}) {
  return {
    id: 'seq-1', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'active',
    step_index: 0, touches_sent: 0, anchor_at: null, touch_claimed_at: null,
    created_at: tenAmET('2026-07-29'),
    invoice_sent_at: tenAmET('2026-07-29'), invoice_sms_sent_at: null, invoice_created_at: tenAmET('2026-07-29'),
    ...overrides,
  };
}

function invoiceRow(overrides = {}) {
  return {
    id: 'inv-1', customer_id: 'cust-1', payer_id: null, scheduled_send_error: null,
    total: 100, credit_applied: 0, status: 'sent', title: 'Pest Control', token: 'tok-1',
    due_date: null, invoice_number: 'WPC-1', stripe_payment_intent_id: null, service_date: null,
    created_at: tenAmET('2026-07-29'),
    ...overrides,
  };
}

// Wires up the batch-select ('invoice_followup_sequences as s'), the claim/
// advance table ('invoice_followup_sequences'), invoices, and customers.
function setupCombinedDb({ batchRows, invoices, customers = [{ id: 'cust-1', first_name: 'Taylor', phone: '+19410000000', deleted_at: null }] }) {
  const seqTable = fakeTable(batchRows);
  const invoiceTable = fakeTable(invoices);
  const customerTable = fakeTable(customers);
  const notificationPrefsTable = fakeTable([]);
  const customerInteractionsTable = fakeTable([]);
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = jest.fn(async (cb) => cb(db));
  db.mockImplementation((table) => {
    if (table === 'invoice_followup_sequences as s') {
      const rows = batchRows;
      const q = { wheres: [] };
      for (const method of ['join', 'whereNotIn', 'whereNull', 'select']) q[method] = jest.fn(() => q);
      q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    }
    if (table === 'invoice_followup_sequences') return seqTable.query();
    if (table === 'invoices') return invoiceTable.query();
    if (table === 'customers') return customerTable.query();
    if (table === 'notification_prefs') return notificationPrefsTable.query();
    if (table === 'customer_interactions') return customerInteractionsTable.query();
    throw new Error(`unexpected table in test: ${table}`);
  });
  return { seqTable, invoiceTable, customerTable };
}

describe('gate off: byte-identical — two due rows for one customer fire two per-invoice touches', () => {
  test('each row is claimed and fired independently, not grouped', async () => {
    const rowA = seqRow({ id: 'seq-A', invoice_id: 'inv-A', next_touch_at: tenAmET('2026-08-05') });
    const rowB = seqRow({ id: 'seq-B', invoice_id: 'inv-B', next_touch_at: tenAmET('2026-08-05') });
    const { invoiceTable } = setupCombinedDb({
      batchRows: [rowA, rowB],
      invoices: [invoiceRow({ id: 'inv-A' }), invoiceRow({ id: 'inv-B' })],
    });
    const result = await runPending();
    // Both claims succeed (customers/invoices/policy all wired to allow),
    // so both fire through the per-invoice path — sendCustomerMessage is
    // called twice, once per invoice, never once for both combined.
    expect(result).toEqual({ sent: 2, skipped: 0 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(2);
    expect(invoiceTable.rows.get('inv-A').status).toBe('sent');
  });
});

describe('gate on: a customer with one due row is unchanged', () => {
  test('goes through the per-invoice path, not fireCombinedTouch', async () => {
    process.env.GATE_DUNNING_COMBINED_MESSAGE = 'true';
    const row = seqRow({ next_touch_at: tenAmET('2026-08-05') });
    setupCombinedDb({ batchRows: [row], invoices: [invoiceRow()] });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // The per-invoice template key, not a combined one.
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith(
      'invoice_followup_3day', expect.anything(), expect.anything(),
    );
  });
});

describe('gate on: a customer with 2 due rows gets ONE combined message', () => {
  function twoInvoiceSetup(overrides = {}) {
    process.env.GATE_DUNNING_COMBINED_MESSAGE = 'true';
    const rowA = seqRow({
      id: 'seq-A', invoice_id: 'inv-A', next_touch_at: tenAmET('2026-08-05'),
      invoice_sent_at: tenAmET('2026-07-29'), // oldest — anchors the step
    });
    const rowB = seqRow({
      id: 'seq-B', invoice_id: 'inv-B', next_touch_at: tenAmET('2026-08-05'),
      invoice_sent_at: tenAmET('2026-07-30'),
    });
    const invA = invoiceRow({ id: 'inv-A', total: 150, credit_applied: 0, invoice_number: 'WPC-A', due_date: tenAmET('2026-08-01') });
    const invB = invoiceRow({ id: 'inv-B', total: 80.5, credit_applied: 0.5, invoice_number: 'WPC-B', due_date: tenAmET('2026-08-02') });
    const dbHandles = setupCombinedDb({ batchRows: [rowA, rowB], invoices: [invA, invB], ...overrides });
    return { rowA, rowB, invA, invB, ...dbHandles };
  }

  test('one combined SMS + one combined email; rail guard called once per channel with both invoice ids; one ledger row per channel with both ids and the combined key; invoice_count/total_due/pay_url correct; both sequences advanced from the oldest invoice\'s step', async () => {
    const { seqTable } = twoInvoiceSetup();
    const result = await runPending();

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);

    // Rail guard: once per channel (sms, email), invoiceIds carrying both.
    expect(collectionsChannelPermitted).toHaveBeenCalledTimes(2);
    for (const call of collectionsChannelPermitted.mock.calls) {
      expect(call[0].invoiceIds).toEqual(expect.arrayContaining(['inv-A', 'inv-B']));
      expect(call[0].invoiceIds).toHaveLength(2);
      expect(call[0].purpose).toBe('late_payment');
    }

    // Ledger: one row per channel, both invoice ids, combined idempotency key.
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(2);
    const etDay = '2026-08-05';
    const smsCall = ContactLedger.recordContact.mock.calls.find((c) => c[0].channel === 'sms')[0];
    const emailCall = ContactLedger.recordContact.mock.calls.find((c) => c[0].channel === 'email')[0];
    expect(smsCall.invoiceIds.sort()).toEqual(['inv-A', 'inv-B']);
    expect(smsCall.idempotencyKey).toBe(`invoice_followups:combined:cust-1:d3_friendly:${etDay}:sms`);
    expect(smsCall.metadata).toMatchObject({ combined: true, step_id: 'd3_friendly' });
    expect(emailCall.invoiceIds.sort()).toEqual(['inv-A', 'inv-B']);
    expect(emailCall.idempotencyKey).toBe(`invoice_followups:combined:cust-1:d3_friendly:${etDay}:email`);

    // SMS vars: invoice_count/total_due/pay_url. total_due = (150) + (80.5-0.5) = 230.00
    const smsVars = smsTemplatesRouter.getTemplate.mock.calls[0][1];
    expect(smsTemplatesRouter.getTemplate.mock.calls[0][0]).toBe('invoice_followup_combined_3day');
    expect(smsVars).toEqual({
      first_name: 'Taylor', invoice_count: '2', total_due: '230.00', pay_url: 'https://portal.wavespestcontrol.com/pay/combined',
    });

    // Email payload: same total (with $), invoice_count, pay_url, and one
    // invoices[] entry per included invoice.
    const emailPayload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(emailPayload.invoice_count).toBe('2');
    expect(emailPayload.total_due).toBe('$230.00');
    expect(emailPayload.pay_url).toBe('https://portal.wavespestcontrol.com/pay/combined');
    expect(emailPayload.invoices).toEqual(expect.arrayContaining([
      expect.objectContaining({ invoice_number: 'WPC-A' }),
      expect.objectContaining({ invoice_number: 'WPC-B' }),
    ]));
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].templateKey).toBe('invoice.followup_combined_3_day');

    // Both sequences advanced from step 0 (d3_friendly) to step 1, each on
    // its OWN anchor (invoice_sent_at), touches_sent incremented.
    expect(seqTable.rows.get('seq-A').step_index).toBe(1);
    expect(seqTable.rows.get('seq-A').touches_sent).toBe(1);
    expect(seqTable.rows.get('seq-B').step_index).toBe(1);
    expect(seqTable.rows.get('seq-B').touches_sent).toBe(1);
  });

  test('an excluded row (billed to a third-party payer) drops out, and the remaining single row goes the per-invoice path', async () => {
    const { invA, invB, seqTable, invoiceTable } = twoInvoiceSetup();
    // inv-B is billed to a payer — fireCombinedTouchClaimed's guard pass
    // must exclude it and pause its sequence, same as fireTouch would.
    invoiceTable.rows.get('inv-B').payer_id = 'payer-1';
    const result = await runPending();

    expect(result).toEqual({ sent: 1, skipped: 0 });
    // Only ONE invoice went out, through the per-invoice path (not combined).
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(seqTable.rows.get('seq-B').status).toBe('paused');
    expect(seqTable.rows.get('seq-B').next_touch_at).toBeNull();
    expect(seqTable.rows.get('seq-A').step_index).toBe(1);
    void invA; void invB;
  });

  test('a send failure (both legs fail) advances neither sequence', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'undeliverable' });
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: false, blocked: true, message: {} });
    billingEmailSendOutcome.mockImplementation(async (result) => ({ ok: false, blocked: true, reason: 'blocked' }));
    const { seqTable } = twoInvoiceSetup();
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 }); // runPending still counts the attempt
    expect(seqTable.rows.get('seq-A').step_index).toBe(0); // unadvanced
    expect(seqTable.rows.get('seq-B').step_index).toBe(0); // unadvanced
    expect(seqTable.rows.get('seq-A').touches_sent).toBe(0);
  });
});
