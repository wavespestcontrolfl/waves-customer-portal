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
  // The real selfPayAtDispatchMany returns a FUNCTION synchronously (to be
  // called later as preDispatchCheck/preSendCheck), not a promise — mirror
  // that shape so a test can actually invoke the wired check.
  selfPayAtDispatchMany: jest.fn(() => async () => ({ ok: true })),
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

const crypto = require('crypto');
const db = require('../models/db');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
const ContactLedger = require('../services/collections/contact-ledger');
const { buildPayBalanceLink } = require('../services/composer-customer-links');
const { billingEmailRecipient, billingEmailSendOutcome } = require('../services/billing-email-sender');
const { dispatchUnderBillingEmailAuthority } = require('../services/billing-channel-email-authority');
const invoiceHelpers = require('../services/invoice-helpers');
const { gates } = require('../config/feature-gates');
const StripeService = require('../services/stripe');
const { sendMicrodepositVerificationEmail } = require('../services/microdeposit-verification-email');
const { shortenOrPassthrough } = require('../services/short-url');
const { runPending } = require('../services/invoice-followups');

// Wednesday 2026-08-05 10:16 AM ET, inside the Tue–Fri send window.
const NOW = new Date('2026-08-05T14:16:00Z');
const tenAmET = (day) => new Date(`${day}T14:00:00Z`);

// Mirrors invoice-followups.js's own combined-touch key digest exactly
// (Codex r1 P1 — a stable 16-hex SHA-256 prefix of the sorted, comma-joined
// included invoice ids, never the raw UUID list): used to build the SAME
// idempotency keys the production code computes, without hardcoding a
// magic hex string into the test.
function combinedIdsKey(ids) {
  return crypto.createHash('sha256').update([...ids].map(String).sort().join(',')).digest('hex').slice(0, 16);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  delete process.env.GATE_DUNNING_COMBINED_MESSAGE;
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_COLLECTIONS_POLICY;
  gates.divertMicrodepositDunning = false;
  StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(false);
  sendMicrodepositVerificationEmail.mockResolvedValue({ ok: true });
  collectionsChannelPermitted.mockResolvedValue({ allowed: true, durable: false });
  ContactLedger.recordContact.mockImplementation(async ({ idempotencyKey }) => ({ id: `ledger-${idempotencyKey}` }));
  // Matches the two-invoice group's included set EXACTLY by default (never
  // a superset — the combined path now requires an exact match, not just
  // coverage) — the one "coverage falls short" scenario below overrides it.
  buildPayBalanceLink.mockResolvedValue({
    url: 'https://portal.wavespestcontrol.com/pay/combined',
    coveredInvoiceIds: ['inv-A', 'inv-B'],
    // The pay page's OWN reported balance — total_due is now derived from
    // THIS, not a separately-summed invoiceAmountDue() total (Claude
    // fallback-audit P1). 150 (inv-A) + 80 (inv-B: 80.5 total − 0.5
    // credit_applied) = 230.00, matching the two-invoice group's default.
    balance: { total: 230, count: 2 },
  });
  smsTemplatesRouter.getTemplate.mockResolvedValue('rendered sms body');
  sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
  billingEmailRecipient.mockResolvedValue({ recipient: { name: 'Taylor', email: 'taylor@example.com' }, to: 'taylor@example.com' });
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, message: {} });
  billingEmailSendOutcome.mockImplementation(async (result) => ({ ok: !!result.sent }));
  // Reset to the default pass-through — jest.clearAllMocks() clears
  // mock.calls but NOT a mockImplementation a prior test installed (e.g.
  // the individual-fallback failure test below), so every test that
  // customizes this must be able to rely on a clean slate here too.
  shortenOrPassthrough.mockImplementation(async (url) => url);
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
    // Some callers (currentStepLedgerIds/currentCombinedStepLedgerIds)
    // await the query directly, with no .first()/.update() — same
    // thenable shape the batch-select mock already uses.
    q.then = (resolve, reject) => Promise.resolve(matches(filters)).then(resolve, reject);
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
function setupCombinedDb({
  batchRows, invoices, customers = [{ id: 'cust-1', first_name: 'Taylor', phone: '+19410000000', deleted_at: null }],
  ledgerRows = [],
}) {
  const seqTable = fakeTable(batchRows);
  const invoiceTable = fakeTable(invoices);
  const customerTable = fakeTable(customers);
  const notificationPrefsTable = fakeTable([]);
  const customerInteractionsTable = fakeTable([]);
  const contactLedgerTable = fakeTable(ledgerRows);
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
    if (table === 'collections_contact_ledger') return contactLedgerTable.query();
    throw new Error(`unexpected table in test: ${table}`);
  });
  return {
    seqTable, invoiceTable, customerTable, contactLedgerTable,
  };
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

    // Ledger: one row per channel, both invoice ids, combined idempotency
    // key — a stable digest of the included set, no date component (Codex
    // r1 P1 + Fable review P2: the key must fit collections_contact_ledger's
    // varchar(120) even with real UUID ids, AND stay stable across a
    // held-then-retried touch spanning a day boundary).
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(2);
    const idsKey = combinedIdsKey(['inv-A', 'inv-B']);
    const smsCall = ContactLedger.recordContact.mock.calls.find((c) => c[0].channel === 'sms')[0];
    const emailCall = ContactLedger.recordContact.mock.calls.find((c) => c[0].channel === 'email')[0];
    expect(smsCall.invoiceIds.sort()).toEqual(['inv-A', 'inv-B']);
    expect(smsCall.idempotencyKey).toBe(`invoice_followups:combined:cust-1:d3_friendly:${idsKey}:sms`);
    expect(smsCall.metadata).toMatchObject({ combined: true, step_id: 'd3_friendly' });
    expect(emailCall.invoiceIds.sort()).toEqual(['inv-A', 'inv-B']);
    expect(emailCall.idempotencyKey).toBe(`invoice_followups:combined:cust-1:d3_friendly:${idsKey}:email`);

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

  test('the email template idempotency key is scoped to the included invoice set (as a digest), not just customer+step', async () => {
    twoInvoiceSetup();
    await runPending();
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    const idsKey = combinedIdsKey(['inv-A', 'inv-B']);
    expect(call.idempotencyKey).toBe(`invoice_followup_combined_email:cust-1:d3_friendly:${idsKey}`);
    expect(call.triggerEventId).toBe(`invoice_followup_combined:cust-1:d3_friendly:${idsKey}`);
  });

  test('the combined idempotency key stays within collections_contact_ledger.idempotency_key (varchar(120)) even with real UUID-length invoice ids', async () => {
    process.env.GATE_DUNNING_COMBINED_MESSAGE = 'true';
    const invIdA = '11111111-1111-1111-1111-111111111111';
    const invIdB = '22222222-2222-2222-2222-222222222222';
    const rowA = seqRow({
      id: 'seq-A', invoice_id: invIdA, customer_id: '33333333-3333-3333-3333-333333333333',
      next_touch_at: tenAmET('2026-08-05'), invoice_sent_at: tenAmET('2026-07-29'),
    });
    const rowB = seqRow({
      id: 'seq-B', invoice_id: invIdB, customer_id: '33333333-3333-3333-3333-333333333333',
      next_touch_at: tenAmET('2026-08-05'), invoice_sent_at: tenAmET('2026-07-30'),
    });
    setupCombinedDb({
      batchRows: [rowA, rowB],
      invoices: [invoiceRow({ id: invIdA, customer_id: '33333333-3333-3333-3333-333333333333' }),
        invoiceRow({ id: invIdB, customer_id: '33333333-3333-3333-3333-333333333333' })],
      customers: [{ id: '33333333-3333-3333-3333-333333333333', first_name: 'Taylor', phone: '+19410000000', deleted_at: null }],
    });
    buildPayBalanceLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/pay/combined', coveredInvoiceIds: [invIdA, invIdB], balance: { total: 200, count: 2 },
    });
    await runPending();
    const smsCall = ContactLedger.recordContact.mock.calls.find((c) => c[0].channel === 'sms')[0];
    expect(smsCall.idempotencyKey.length).toBeLessThanOrEqual(120);
  });

  test('when no link covers every included invoice, the combined message is never sent — every included invoice falls back to its own per-invoice touch instead', async () => {
    const { seqTable } = twoInvoiceSetup();
    // The balance link only covers inv-A (e.g. GATE_PAY_INCLUDE_BALANCE off,
    // or inv-B excluded from the combined charge for its own reason) — never
    // send a "pay them all" combined message whose link can't settle inv-B.
    buildPayBalanceLink.mockResolvedValue({ url: 'https://portal.wavespestcontrol.com/pay/combined', coveredInvoiceIds: ['inv-A'] });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    // No combined SMS template render at all; each invoice fires through
    // sendCustomerMessage/sendTemplate independently (2 calls, not 1).
    expect(smsTemplatesRouter.getTemplate).not.toHaveBeenCalledWith('invoice_followup_combined_3day', expect.anything(), expect.anything());
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(2);
    expect(seqTable.rows.get('seq-A').step_index).toBe(1);
    expect(seqTable.rows.get('seq-B').step_index).toBe(1);
  });

  test('one leg delivers but the other is only transiently policy-denied: the whole touch holds, neither sequence advances', async () => {
    const { seqTable } = twoInvoiceSetup();
    // email permitted+delivers; sms transiently denied (not durable) this run.
    collectionsChannelPermitted.mockImplementation(async ({ channel }) => (
      channel === 'sms' ? { allowed: false, durable: false } : { allowed: true, durable: false }
    ));
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1); // email still attempted and delivered
    expect(seqTable.rows.get('seq-A').step_index).toBe(0); // held — not advanced
    expect(seqTable.rows.get('seq-B').step_index).toBe(0);
  });

  test('an uncertain SMS outcome holds and does NOT mark the ledger reservation send_failed (no duplicate-text risk on retry)', async () => {
    const { seqTable } = twoInvoiceSetup();
    sendCustomerMessage.mockResolvedValue({ deliveryOutcome: 'uncertain' });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    expect(seqTable.rows.get('seq-A').step_index).toBe(0);
    expect(seqTable.rows.get('seq-B').step_index).toBe(0);
  });

  test('the combined touch excludes its OWN prior combined-keyed ledger reservations from the policy consult (not just per-invoice keys)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const idsKey = combinedIdsKey(['inv-A', 'inv-B']);
    const priorLedgerRow = {
      id: 'ledger-99', source: 'invoice_followups',
      idempotency_key: `invoice_followups:combined:cust-1:d3_friendly:${idsKey}:sms`,
    };
    twoInvoiceSetup({ ledgerRows: [priorLedgerRow] });
    await runPending();
    for (const call of collectionsChannelPermitted.mock.calls) {
      expect(call[0].excludeLedgerIds).toContain('ledger-99');
    }
  });

  test('the combined-keyed reservation carries NO date component — a same-day-format key still matches a reservation written on an EARLIER day (a held touch re-timed to today must still recognize yesterday\'s partial attempt)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const idsKey = combinedIdsKey(['inv-A', 'inv-B']);
    // Written "yesterday" (no day segment in the key at all — this is the
    // exact key an attempt on 2026-08-04 would have produced too).
    const priorLedgerRow = {
      id: 'ledger-yesterday', source: 'invoice_followups',
      idempotency_key: `invoice_followups:combined:cust-1:d3_friendly:${idsKey}:email`,
    };
    twoInvoiceSetup({ ledgerRows: [priorLedgerRow] });
    await runPending();
    for (const call of collectionsChannelPermitted.mock.calls) {
      expect(call[0].excludeLedgerIds).toContain('ledger-yesterday');
    }
  });

  test('a retryable (non-terminal) email refusal holds the touch even though SMS delivered', async () => {
    const { seqTable } = twoInvoiceSetup();
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: false, blocked: false, message: {} });
    // A plain not-terminal refusal: not blocked, no deliveryOutcome/retryable
    // markers that would read as "uncertain" either — an ordinary retryable
    // failure settleFollowupEmailLedger alone would treat as "settled".
    billingEmailSendOutcome.mockImplementation(async () => ({ ok: false, reason: 'transient_provider_error' }));
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1); // SMS attempted and delivered
    expect(seqTable.rows.get('seq-A').step_index).toBe(0); // held anyway — email still pending
    expect(seqTable.rows.get('seq-B').step_index).toBe(0);
  });

  test('a pay link covering MORE than the included set (a superset) is also rejected, not just an undershoot', async () => {
    const { seqTable } = twoInvoiceSetup();
    // The linked page would also charge inv-C, which isn't due and isn't
    // in this message's invoice_count/total_due — an exact match is
    // required, not merely "covers everything we listed".
    buildPayBalanceLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/pay/combined', coveredInvoiceIds: ['inv-A', 'inv-B', 'inv-C'],
    });
    await runPending();
    expect(smsTemplatesRouter.getTemplate).not.toHaveBeenCalledWith('invoice_followup_combined_3day', expect.anything(), expect.anything());
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2); // individual fallback
    expect(seqTable.rows.get('seq-A').step_index).toBe(1);
  });

  test('the last-minute re-verification re-reads every included invoice right before dispatch (not just the anchor)', async () => {
    const { invoiceTable } = twoInvoiceSetup();
    const readsPerInvoice = { 'inv-A': 0, 'inv-B': 0 };
    const originalQuery = invoiceTable.query;
    invoiceTable.query = () => {
      const q = originalQuery();
      const originalFirst = q.first;
      q.first = jest.fn(async (...args) => {
        const found = await originalFirst(...args);
        if (found && readsPerInvoice[found.id] !== undefined) readsPerInvoice[found.id] += 1;
        return found;
      });
      return q;
    };
    await runPending();
    // At least one read after the guard pass's own read (the guard pass
    // already reads each invoice once) — proves the last-minute check
    // covers inv-B too, not only the anchor (inv-A).
    expect(readsPerInvoice['inv-A']).toBeGreaterThanOrEqual(2);
    expect(readsPerInvoice['inv-B']).toBeGreaterThanOrEqual(2);
  });

  test('an invoice found ineligible at the last-minute re-check abandons the combined send; every included invoice falls back to its own touch', async () => {
    const { seqTable, invoiceTable } = twoInvoiceSetup();
    invoiceTable.rows.get('inv-B').payer_id = 'payer-1';
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(smsTemplatesRouter.getTemplate).not.toHaveBeenCalledWith('invoice_followup_combined_3day', expect.anything(), expect.anything());
    // inv-A is still legitimate and gets its own touch; inv-B's own guard
    // (fireTouch's Bill-To check) pauses it.
    expect(seqTable.rows.get('seq-A').step_index).toBe(1);
    expect(seqTable.rows.get('seq-B').status).toBe('paused');
  });

  test('an SMS deferred/retryable rejection holds the touch, even though it is a "definite" not_sent outcome', async () => {
    const { seqTable } = twoInvoiceSetup();
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', deferred: true, code: 'QUIET_HOURS_HOLD' });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(seqTable.rows.get('seq-A').step_index).toBe(0); // held, not advanced
    expect(seqTable.rows.get('seq-B').step_index).toBe(0);
  });

  test('every included row awaiting micro-deposit verification is dispatched through its own diversion reminder, not silently dropped', async () => {
    gates.divertMicrodepositDunning = true;
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    twoInvoiceSetup();
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    // Both excluded from the combined message (no combined send at all)...
    expect(smsTemplatesRouter.getTemplate).not.toHaveBeenCalledWith('invoice_followup_combined_3day', expect.anything(), expect.anything());
    // ...but each still gets its own micro-deposit verification reminder,
    // not left to rot until the group re-forms and excludes them again.
    expect(sendMicrodepositVerificationEmail).toHaveBeenCalledTimes(2);
    expect(StripeService.isInvoiceAwaitingMicrodepositVerification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-A' }),
    );
    expect(StripeService.isInvoiceAwaitingMicrodepositVerification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-B' }),
    );
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

  // Fable review P1: a held combined touch left next_touch_at at its
  // already-elapsed due date, so the NEXT run's isStaleTouch check would
  // read it as stale and skip the step without ever sending it.
  test('a held combined touch re-times next_touch_at forward to the held-touch floor, on every included sequence', async () => {
    const { seqTable } = twoInvoiceSetup();
    // Transient, non-durable SMS denial — holds the whole touch (same as
    // the earlier "one leg delivers but the other is only transiently
    // policy-denied" test, which proves step_index stays put); here we
    // check the RE-TIMING of next_touch_at instead. The email leg still
    // resolves normally (it delivers) — smsHold alone is enough to hold
    // the whole combined touch and trigger the re-time.
    collectionsChannelPermitted.mockImplementation(async ({ channel }) => (
      channel === 'sms' ? { allowed: false, durable: false } : { allowed: true, durable: false }
    ));
    await runPending();
    // heldTouchFloor(now) = midnight NY on the day AFTER `now` — for our
    // fixed NOW (2026-08-05 10:16 ET, EDT/UTC-4) that is 2026-08-06T04:00Z.
    const expectedFloor = new Date('2026-08-06T04:00:00Z').getTime();
    expect(seqTable.rows.get('seq-A').step_index).toBe(0); // still held at its step
    expect(seqTable.rows.get('seq-B').step_index).toBe(0);
    expect(new Date(seqTable.rows.get('seq-A').next_touch_at).getTime()).toBe(expectedFloor);
    expect(new Date(seqTable.rows.get('seq-B').next_touch_at).getTime()).toBe(expectedFloor);
  });

  // Fable review P2: the aggregate policy check requires EVERY included
  // invoice to be eligible — one ineligible sibling used to deny the
  // channel (and thus hold the whole touch) for invoices that are
  // individually perfectly fine.
  test('one sibling ineligible under the aggregate policy check does not hold the eligible sibling hostage — falls back to individual touches and the eligible one still sends', async () => {
    const { seqTable } = twoInvoiceSetup();
    // Aggregate (invoiceIds present) denies every channel; a PER-INVOICE
    // check (fireTouch's own single-invoice call, no invoiceIds) allows.
    collectionsChannelPermitted.mockImplementation(async ({ invoiceIds }) => (
      invoiceIds ? { allowed: false, durable: false } : { allowed: true, durable: false }
    ));
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    // No combined send was attempted...
    expect(smsTemplatesRouter.getTemplate).not.toHaveBeenCalledWith('invoice_followup_combined_3day', expect.anything(), expect.anything());
    // ...but BOTH invoices still got their own individual touch, and both
    // succeeded (their own per-invoice policy check allows).
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(seqTable.rows.get('seq-A').step_index).toBe(1);
    expect(seqTable.rows.get('seq-B').step_index).toBe(1);
  });

  // Fable review P2: excludeLedgerIds checked every row against the
  // ANCHOR's step id only — a non-anchor sibling at a DIFFERENT point of
  // its own cadence has its legacy per-invoice reservation under ITS OWN
  // step id, which the anchor-only check would never match.
  test('excludeLedgerIds excludes a non-anchor sibling\'s own-step legacy reservation, not just one keyed to the anchor\'s step', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    process.env.GATE_DUNNING_COMBINED_MESSAGE = 'true';
    // seq-A (anchor, oldest) is at step 0 (d3_friendly); seq-B is a sibling
    // already at step 1 (d7_reminder) — a different point of its cadence.
    const rowA = seqRow({
      id: 'seq-A', invoice_id: 'inv-A', next_touch_at: tenAmET('2026-08-05'),
      invoice_sent_at: tenAmET('2026-07-29'), step_index: 0,
    });
    const rowB = seqRow({
      id: 'seq-B', invoice_id: 'inv-B', next_touch_at: tenAmET('2026-08-05'),
      invoice_sent_at: tenAmET('2026-07-30'), step_index: 1,
    });
    // seq-B's OWN legacy per-invoice key at ITS OWN step (d7_reminder) —
    // must be excluded from the aggregate policy consult even though the
    // combined message being sent right now is keyed to the ANCHOR's step
    // (d3_friendly).
    const siblingsOwnStepLedgerRow = {
      id: 'ledger-sibling-own-step', source: 'invoice_followups',
      idempotency_key: 'invoice_followups:seq-B:d7_reminder:sms',
    };
    setupCombinedDb({
      batchRows: [rowA, rowB],
      invoices: [invoiceRow({ id: 'inv-A' }), invoiceRow({ id: 'inv-B' })],
      ledgerRows: [siblingsOwnStepLedgerRow],
    });
    await runPending();
    for (const call of collectionsChannelPermitted.mock.calls) {
      expect(call[0].excludeLedgerIds).toContain('ledger-sibling-own-step');
    }
  });

  // Fable review P2: a sibling already at ITS OWN final-notice step must
  // never be folded into a combined touch rendered from an EARLIER anchor
  // step's copy — the sequence would be silently retired (advanced past
  // its final step) without that invoice's real final notice ever having
  // been represented.
  test('a sibling already at its own final-notice step is pulled out and fired through its own real final-notice touch, while the rest still combine', async () => {
    process.env.GATE_DUNNING_COMBINED_MESSAGE = 'true';
    // Legacy (gate-off ladder) cadence: steps are d3/d7/d14/d30_final —
    // index 3 (d30_final) is the last step.
    const rowA = seqRow({ // anchor (oldest), early step
      id: 'seq-A', invoice_id: 'inv-A', next_touch_at: tenAmET('2026-08-05'),
      invoice_sent_at: tenAmET('2026-07-01'), step_index: 0,
    });
    const rowB = seqRow({ // at its OWN final-notice step
      id: 'seq-B', invoice_id: 'inv-B', next_touch_at: tenAmET('2026-08-05'),
      invoice_sent_at: tenAmET('2026-07-15'), step_index: 3,
    });
    const rowC = seqRow({ // another early-step sibling, so 2 remain after B is pulled
      id: 'seq-C', invoice_id: 'inv-C', next_touch_at: tenAmET('2026-08-05'),
      invoice_sent_at: tenAmET('2026-07-20'), step_index: 0,
    });
    setupCombinedDb({
      batchRows: [rowA, rowB, rowC],
      invoices: [invoiceRow({ id: 'inv-A' }), invoiceRow({ id: 'inv-B' }), invoiceRow({ id: 'inv-C' })],
    });
    buildPayBalanceLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/pay/combined', coveredInvoiceIds: ['inv-A', 'inv-C'], balance: { total: 200, count: 2 },
    });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    // The combined send used the anchor's own (early) step template, never
    // the final-notice one — B was never folded into it.
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith(
      'invoice_followup_combined_3day', expect.objectContaining({ invoice_count: '2' }), expect.anything(),
    );
    // B got its OWN individual touch (its real final-notice template), not
    // a combined one — and it is not one of the two sms/email calls the
    // combined send made (fireTouch renders through the SAME
    // sendCustomerMessage mock, so we check the total count instead: 1
    // combined SMS + 1 individual SMS for B = 2).
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith(
      'invoice_followup_30day', expect.anything(), expect.anything(),
    );
  });

  // Fable review P2: the fallback loops (pay-link mismatch, ownership
  // recheck, final-notice split) fired each row with a bare await — one
  // invoice's fireTouch throwing aborted every invoice queued after it in
  // the SAME loop.
  test('the individual-touch fallback continues past one invoice\'s failure — the other invoice still gets its touch', async () => {
    const { seqTable } = twoInvoiceSetup();
    // Force the pay-link-mismatch fallback (both invoices fire individually).
    buildPayBalanceLink.mockResolvedValue({ url: 'https://portal.wavespestcontrol.com/pay/combined', coveredInvoiceIds: ['inv-A'] });
    // inv-B's individual fireTouch throws deep inside (shortenOrPassthrough,
    // uncaught within fireTouch itself) — inv-A must still be attempted.
    // (beforeEach restores the default pass-through for every other test.)
    shortenOrPassthrough.mockImplementation(async (url, { entityId }) => {
      if (entityId === 'inv-B') throw new Error('short-url service unavailable');
      return url;
    });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    // inv-A's individual touch still went out despite inv-B's failure.
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(seqTable.rows.get('seq-A').step_index).toBe(1);
    // inv-B's own sequence is untouched (its touch threw before any write) —
    // it stays due and is retried on the next run rather than the whole
    // fallback silently stopping at inv-A alone.
    expect(seqTable.rows.get('seq-B').step_index).toBe(0);
  });

  // Codex r1 P1: every included invoice, not just the anchor, must be
  // re-verified at the actual provider handoff.
  test('the SMS/push provider handoff re-verifies EVERY included invoice, not just the anchor', async () => {
    twoInvoiceSetup();
    await runPending();
    expect(invoiceHelpers.selfPayAtDispatchMany).toHaveBeenCalledWith(
      expect.arrayContaining(['inv-A', 'inv-B']), expect.anything(),
    );
    const call = invoiceHelpers.selfPayAtDispatchMany.mock.calls.find(
      (c) => Array.isArray(c[0]) && c[0].includes('inv-A') && c[0].includes('inv-B'),
    );
    expect(call).toBeDefined();
  });

  test('the email provider handoff wires a preSendCheck covering EVERY included invoice, not just the anchor', async () => {
    // Make the mocked email library actually invoke withProviderHandoff, the
    // way the real EmailTemplateLibrary.sendTemplate does, so
    // dispatchUnderBillingEmailAuthority is really called with our options.
    EmailTemplateLibrary.sendTemplate.mockImplementation(async ({ withProviderHandoff }) => {
      await withProviderHandoff(async () => ({ sent: true }));
      return { sent: true, message: {} };
    });
    twoInvoiceSetup();
    await runPending();
    expect(dispatchUnderBillingEmailAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ preSendCheck: expect.any(Function) }),
    );
    const [{ preSendCheck }] = dispatchUnderBillingEmailAuthority.mock.calls[0];
    await preSendCheck();
    expect(invoiceHelpers.selfPayAtDispatchMany).toHaveBeenCalledWith(
      expect.arrayContaining(['inv-A', 'inv-B']), expect.anything(),
    );
  });

  // Claude fallback-audit P1 (Codex was over its usage limit for this
  // round): total_due must be the pay link's OWN reported balance, not a
  // separately-summed invoiceAmountDue() total — the two can diverge by a
  // cent on rounding order even over the IDENTICAL invoice set, and the
  // message must never quote an amount the linked page itself would not
  // also show.
  test('total_due is taken from the pay link\'s own reported balance, not re-derived from invoiceAmountDue — even when the two would disagree', async () => {
    const { invA, invB } = twoInvoiceSetup();
    // invoiceAmountDue would sum these to 230.00 (150 + 80), but the pay
    // page's own cents-based balance disagrees by a cent — simulating a
    // real per-invoice rounding-order divergence.
    buildPayBalanceLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/pay/combined',
      coveredInvoiceIds: ['inv-A', 'inv-B'],
      balance: { total: 230.01, count: 2 },
    });
    await runPending();
    const smsVars = smsTemplatesRouter.getTemplate.mock.calls[0][1];
    expect(smsVars.total_due).toBe('230.01'); // the pay link's figure, not the independently-summed 230.00
    const emailPayload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(emailPayload.total_due).toBe('$230.01');
    void invA; void invB;
  });

  test('the combined send never quotes an amount when the pay link reports no positive balance — falls back to individual touches', async () => {
    const { seqTable } = twoInvoiceSetup();
    buildPayBalanceLink.mockResolvedValue({
      url: 'https://portal.wavespestcontrol.com/pay/combined',
      coveredInvoiceIds: ['inv-A', 'inv-B'],
      balance: { total: 0, count: 2 },
    });
    const result = await runPending();
    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(smsTemplatesRouter.getTemplate).not.toHaveBeenCalledWith('invoice_followup_combined_3day', expect.anything(), expect.anything());
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2); // individual fallback
    expect(seqTable.rows.get('seq-A').step_index).toBe(1);
  });
});
