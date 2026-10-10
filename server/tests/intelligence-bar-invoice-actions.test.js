/**
 * IB send_invoice / charge_invoice (owner ruling 2026-10-07): an existing
 * invoice only, always a card, admin only, dark behind GATE_IB_INVOICE_ACTIONS.
 * Card content, the reused route refusals, the $500 / $1,500 caps (preview,
 * commit, and the recheck inside the charge transaction with two cards at
 * once), pin drift, gate off, admin only, and that the commit calls the
 * Invoices page handlers with the page's own arguments. Stripe and the route
 * handlers are mocked; nothing here reaches a provider. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-invoices', () => ({
  getInvoiceDeliveryRecipients: jest.fn(),
  sendInvoiceFromBar: jest.fn(),
  chargeInvoiceFromBar: jest.fn(),
}));
jest.mock('../services/stripe', () => ({ quoteInvoiceSavedCardCharge: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ issuedCloseoutTarget: jest.fn(async () => null) }));
jest.mock('../services/collections/collection-hold', () => ({
  customerHasActiveCollectionHoldChecked: jest.fn(async () => false),
  customerHasActiveMessagingHoldChecked: jest.fn(async () => false),
  assertNoCollectionHold: jest.fn(async () => {}),
}));

const fs = require('fs');
const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const StripeService = require('../services/stripe');
const CollectionHold = require('../services/collections/collection-hold');
const { issuedCloseoutTarget } = require('../services/invoice-issued-closeout');
const tools = require('../services/intelligence-bar/invoice-action-tools');
const { executeInvoiceActionTool, INVOICE_ACTION_TOOLS, cardLines, chargeLockGuard, chargedTodayCents } = tools;
const gates = require('../services/intelligence-bar/write-gates');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');
const { etDateString } = require('../utils/datetime-et');

const INV = '00000000-0000-4000-8000-0000000000a1';
const INV2 = '00000000-0000-4000-8000-0000000000a2';
const CARD = '00000000-0000-4000-8000-0000000000c1';
const CARD2 = '00000000-0000-4000-8000-0000000000c2';
const TODAY = etDateString();
const ADMIN = { isAdmin: true, technicianId: 'staff-1', operationId: 'op-1' };

let state;
function invoiceRow(overrides = {}) {
  return {
    id: INV, invoice_number: 'WPC-2099-0001', customer_id: 'cust-1', status: 'draft', total: '129.00', credit_applied: '0.00',
    payer_id: null, payer_statement_id: null, sent_at: null, updated_at: new Date('2099-01-01T12:00:00Z'),
    line_items: JSON.stringify([{ description: 'Quarterly Pest Control', amount: 99 }, { description: 'Mosquito add-on', amount: 30 }]),
    ...overrides,
  };
}
function cardRow(overrides = {}) {
  return {
    id: CARD, customer_id: 'cust-1', method_type: 'card', card_brand: 'Visa', last_four: '4242', exp_month: 12, exp_year: 2032,
    is_default: true, stripe_payment_method_id: 'pm_synthetic_1', ...overrides,
  };
}
function freshState() {
  return {
    invoices: [invoiceRow(), invoiceRow({ id: INV2, invoice_number: 'WPC-2099-0002' })],
    customers: [{ id: 'cust-1', first_name: 'Robin', last_name: 'Sample' }],
    payment_methods: [cardRow()],
    stripe_invoice_charge_attempts: [],
    payments: [],
    ib_pending_actions: [],
    scheduled_services: [],
    service_records: [],
  };
}

// A small knex stand-in: plain-object where / whereIn / whereNull filter the
// seeded rows; the two cap reads (payments sum, uncertain approvals count)
// are answered from the seeded rows the same way the SQL selects them.
function makeDb() {
  function builder(table, raws = []) {
    const q = { table, wheres: [], ins: [], nulls: [], raws, single: false, agg: null };
    const resolveRows = () => {
      if (q.agg === 'sum' && table === 'payments') {
        const day = q.wheres.find((w) => w.payment_date)?.payment_date;
        const total = state.payments
          .filter((p) => p.metadata?.initiated_via === 'intelligence_bar' && p.payment_date === day && !['failed', 'canceled', 'cancelled'].includes(p.status))
          .reduce((sum, p) => sum + Number(p.amount), 0);
        return { total: String(total) };
      }
      if (q.agg === 'count' && table === 'ib_pending_actions') {
        const day = q.raws.find((r) => /AT TIME ZONE/.test(r.sql))?.bindings?.[0];
        const exclude = q.raws.find((r) => /params->>'invoice_id'/.test(r.sql))?.bindings?.[0];
        // Counts only an approval whose invoice has an unresolved saved-card charge claim and no bar payment row yet.
        const claimed = (a) => state.stripe_invoice_charge_attempts.some((c) => String(c.invoice_id) === String(a.params?.invoice_id)
          && ['claimed', 'ambiguous'].includes(c.status) && !c.resolved_at);
        const paidAlready = (a) => state.payments.some((p) => String(p.invoice_id) === String(a.params?.invoice_id)
          && p.metadata?.initiated_via === 'intelligence_bar' && p.payment_date === day && !['failed', 'canceled', 'cancelled'].includes(p.status));
        const n = state.ib_pending_actions.filter((a) => a.tool_name === 'charge_invoice' && a.status === 'confirmed'
          && claimed(a) && !paidAlready(a)
          && a.consumed_day === day && (a.result == null || a.result.outcome_unknown === true)
          && (!exclude || String(a.params?.invoice_id || '') !== exclude)).length;
        return { n: String(n) };
      }
      const rows = (state[table] || []).filter((row) => q.wheres.every((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v)))
        && q.ins.every(([k, vals]) => vals.includes(row[k])) && q.nulls.every((k) => row[k] == null));
      return q.single ? rows[0] : rows;
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(resolveRows).then(res, rej);
        if (prop === 'where') return (arg) => { if (arg && typeof arg === 'object') q.wheres.push(arg); return b; };
        if (prop === 'whereIn') return (k, vals) => { q.ins.push([k, vals]); return b; };
        if (prop === 'whereNull') return (k) => { q.nulls.push(k); return b; };
        if (prop === 'whereRaw') return (sql, bindings) => { q.raws.push({ sql, bindings }); return b; };
        if (prop === 'first') return () => { q.single = true; return b; };
        if (prop === 'sum') return () => { q.agg = 'sum'; return b; };
        if (prop === 'count') return () => { q.agg = 'count'; return b; };
        if (MUTATIONS.has(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  }
  const MUTATIONS = new Set(['insert', 'update', 'del', 'delete', 'upsert']);
  return (table) => builder(table);
}

const recipients = (overrides = {}) => ({
  customerName: 'Robin Sample', payerBilled: false,
  primaryContact: { phone: '9415550100' }, emailRecipient: { email: 'Robin@Example.com' }, ...overrides,
});
const quote = (overrides = {}) => ({ base: 129, surcharge: 3.87, total: 132.87, rateBps: 300, funding: 'credit', projectedCreditApplied: 0, coveredByCredit: false, ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_INVOICE_ACTIONS = 'true';
  state = freshState();
  db.mockImplementation(makeDb());
  // db.transaction models pg_advisory_xact_lock: a later transaction waits for the earlier holder of
  // the same key until that transaction's callback returns.
  const lockTails = new Map();
  db.transaction = jest.fn(async (callback) => {
    let release = () => {};
    const trx = { raw: jest.fn(async (sql, bindings) => {
      if (!/pg_advisory_xact_lock/.test(sql)) return undefined;
      const key = bindings[0];
      const prior = lockTails.get(key) || Promise.resolve();
      lockTails.set(key, new Promise((resolve) => { release = resolve; }));
      await prior;
      return undefined;
    }) };
    try { return await callback(trx); } finally { release(); }
  });
  Invoices.getInvoiceDeliveryRecipients.mockImplementation(async () => recipients());
  StripeService.quoteInvoiceSavedCardCharge.mockImplementation(async () => quote());
  issuedCloseoutTarget.mockReset();
  issuedCloseoutTarget.mockResolvedValue(null);
  CollectionHold.customerHasActiveCollectionHoldChecked.mockResolvedValue(false);
  CollectionHold.customerHasActiveMessagingHoldChecked.mockResolvedValue(false);
  CollectionHold.assertNoCollectionHold.mockResolvedValue(undefined);
});
afterAll(() => { delete process.env.GATE_IB_INVOICE_ACTIONS; });

const preview = (tool, input) => executeInvoiceActionTool(tool, input, ADMIN);
async function confirmWith(tool, input, versionKey) {
  const card = await preview(tool, input);
  expect(card.preview).toBe(true);
  return { card, run: () => executeInvoiceActionTool(tool, { ...input, confirmed: true, [versionKey]: card._version }, ADMIN) };
}

describe('registration', () => {
  test('both tools are two-step writes, never owner-direct, flagged side-effecting, uuid params typed', () => {
    for (const name of ['send_invoice', 'charge_invoice']) expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
    const ownerDirect = require('../services/intelligence-bar/owner-direct');
    for (const name of ['send_invoice', 'charge_invoice']) expect(ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(name)).toBe(false);
    for (const tool of INVOICE_ACTION_TOOLS) {
      expect(tool._sideEffects).toBe(true);
      expect(tool.input_schema.properties.invoice_id.format).toBe('uuid');
      expect(tool.input_schema.properties.confirmed).toBeUndefined();
    }
    const policy = require('../services/intelligence-bar/action-policy.json');
    expect(policy.send_invoice).toMatchObject({ role: 'admin', approval: 'ui_confirm', kind: 'external_action' });
    expect(policy.charge_invoice).toMatchObject({ role: 'admin', approval: 'ui_confirm', kind: 'external_action' });
  });

  test('the contract marks both irreversible, customer-contacting, with the curated card lines', async () => {
    for (const tool of ['send_invoice', 'charge_invoice']) {
      const p = await preview(tool, { invoice_id: INV });
      const contract = buildContract({ toolName: tool, params: { invoice_id: INV }, displayParams: {}, preview: p });
      expect(contract.irreversible).toBe(true);
      expect(contract.notifies_customer).toBe(true);
      const labels = contract.effects.map((e) => e.label);
      for (const line of cardLines(tool, p)) expect(labels).toContain(line.text);
      // Curated: never the generic one-line-per-preview-key dump.
      expect(labels.some((l) => /^Version|^_version|^Note:/i.test(l))).toBe(false);
    }
  });
});

describe('gate and role', () => {
  test('gate off: every call refuses and nothing is read or sent', async () => {
    delete process.env.GATE_IB_INVOICE_ACTIONS;
    for (const tool of ['send_invoice', 'charge_invoice']) {
      await expect(executeInvoiceActionTool(tool, { invoice_id: INV }, ADMIN)).resolves.toMatchObject({ code: 'gate_off' });
      await expect(executeInvoiceActionTool(tool, { invoice_id: INV, confirmed: true }, ADMIN)).resolves.toMatchObject({ code: 'gate_off' });
    }
    expect(db).not.toHaveBeenCalled();
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
    expect(Invoices.chargeInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a technician is refused; a confirmed run needs a positive admin flag', async () => {
    await expect(executeInvoiceActionTool('send_invoice', { invoice_id: INV }, { isAdmin: false })).resolves.toMatchObject({ code: 'permission_denied' });
    await expect(executeInvoiceActionTool('charge_invoice', { invoice_id: INV, confirmed: true, _verified_invoice_charge_version: {} }, {}))
      .resolves.toMatchObject({ code: 'permission_denied' });
    expect(Invoices.chargeInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the route offers them only to admins on the Customers, Revenue and dashboard pages while the gate is on', () => {
    const route = require('../routes/admin-intelligence-bar');
    const names = (ctx, admin) => route.getToolsForContext(ctx, admin).map((t) => t.name);
    for (const ctx of ['customers', 'revenue', 'dashboard']) expect(names(ctx, true)).toEqual(expect.arrayContaining(['send_invoice', 'charge_invoice']));
    expect(names('seo', true)).not.toContain('charge_invoice');
    expect(names('tech', false)).not.toContain('charge_invoice');
    expect(names('customers', false)).not.toContain('send_invoice');
    delete process.env.GATE_IB_INVOICE_ACTIONS;
    expect(names('customers', true)).not.toContain('send_invoice');
    expect(route.ADMIN_ONLY_TOOL_NAMES === undefined || route.ADMIN_ONLY_TOOL_NAMES.has('charge_invoice')).toBe(true);
  });
});

describe('send_invoice card', () => {
  test('names the invoice, the money, the lines, each channel with its masked recipient and the message', async () => {
    const p = await preview('send_invoice', { invoice_number: 'wpc-2099-0001' });
    expect(p).toMatchObject({
      preview: true, invoice_number: 'WPC-2099-0001', customer_name: 'Robin Sample', amount_due: '$129.00', total: '$129.00',
      lines: ['Quarterly Pest Control $99.00', 'Mosquito add-on $30.00'], channels: 'text and email', send_note: 'Not sent before.',
      review_request: 'No review request is sent.',
    });
    expect(p.text).toBe('Text to ***0100: the invoice text (template invoice_sent, or its pre-service or annual-prepay variant when that applies) with the pay link. Not sent if the customer opted out of texts.');
    expect(p.email).toBe('Email to r***@example.com: the invoice email (template invoice.sent), subject "Invoice WPC-2099-0001 — $129.00", with the invoice PDF and the pay link.');
    const lines = cardLines('send_invoice', p).map((l) => l.text);
    expect(lines).toEqual(expect.arrayContaining(['Amount due: $129.00 (invoice total $129.00)', 'Line: Quarterly Pest Control $99.00', p.text, p.email,
      'No account credit is applied by this send. If the visit is cancelled before the send runs, nothing is sent and the invoice is held for review (never voided by the bar).']));
    expect(JSON.stringify(p)).not.toContain('9415550100');
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a payer-billed invoice goes to the payer inbox only; a sent invoice says it sends again', async () => {
    state.invoices[0] = invoiceRow({ payer_id: 'payer-1', sent_at: new Date('2099-01-02T15:00:00Z') });
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValue(recipients({ payerBilled: true, primaryContact: { phone: '' }, emailRecipient: { email: 'ap@payer.example' } }));
    const p = await preview('send_invoice', { invoice_id: INV });
    expect(p.text).toBe('No text: a payer-billed invoice is never texted.');
    expect(p.email).toMatch(/^Email to a\*\*\*@payer\.example \(the payer's billing inbox\)/);
    expect(p.send_note).toMatch(/^Already sent on 2099-01-02 .* This sends it again\.$/);
  });

  test.each([
    ['paid', { status: 'paid' }, 'Invoice already paid'],
    ['void', { status: 'void' }, 'Invoice is void and cannot be paid'],
    ['processing', { status: 'processing' }, 'Bank payment is already processing'],
    ['payer statement', { payer_statement_id: 'stmt-1' }, 'Invoice is billed on the payer’s monthly statement; not sent individually.'],
    ['nothing due', { credit_applied: '129.00' }, 'Nothing is due on this invoice, so there is no pay link to send.'],
    ['an annual-plan invoice', { annual_prepay_term_id: 'term-1' }, 'This is an annual-plan invoice. Send it from the Invoices page.'],
  ])('refuses %s with the route text', async (_label, overrides, text) => {
    state.invoices[0] = invoiceRow(overrides);
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ error: text });
  });

  test('a linked visit that never ran is refused with the route text', async () => {
    state.invoices[0] = invoiceRow({ scheduled_service_id: 'svc-1' });
    state.scheduled_services = [{ id: 'svc-1', status: 'cancelled' }];
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({
      code: 'visit_terminal', error: 'Linked visit is cancelled; delivery not attempted. Void or keep this invoice from the Invoices page.',
    });
    state.invoices[0] = invoiceRow({ scheduled_service_id: null, service_record_id: 'rec-1' });
    state.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1' }];
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'visit_terminal' });
    state.scheduled_services = [{ id: 'svc-1', status: 'completed' }];
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ preview: true });
  });

  test('refuses a dispute hold, no recipient, an unknown invoice and a double target', async () => {
    CollectionHold.customerHasActiveMessagingHoldChecked.mockResolvedValueOnce(true);
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'collection_hold' });
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValueOnce(recipients({ primaryContact: { phone: '' }, emailRecipient: null }));
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'no_recipient' });
    await expect(preview('send_invoice', { invoice_number: 'WPC-0000-0000' })).resolves.toMatchObject({ error: 'Invoice not found' });
    await expect(preview('send_invoice', { invoice_id: INV, invoice_number: 'WPC-2099-0001' })).resolves.toMatchObject({ code: 'invalid_target' });
  });
});

describe('the confirmation card headline', () => {
  test('names the invoice, customer and money for both tools (never raw ids)', async () => {
    const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');
    const send = await preview('send_invoice', { invoice_id: INV });
    expect(confirmationDisplayParams('send_invoice', { invoice_id: INV }, send)).toEqual({
      invoice: 'WPC-2099-0001', customer: 'Robin Sample', amount_due: '$129.00', send_by: 'text and email', sent_before: 'Not sent before.',
    });
    const charge = await preview('charge_invoice', { invoice_id: INV });
    expect(confirmationDisplayParams('charge_invoice', { invoice_id: INV }, charge)).toEqual({
      invoice: 'WPC-2099-0001', customer: 'Robin Sample', card: 'Visa •••• 4242 (exp 12/32)', balance: '$129.00',
      surcharge: '$3.87 card surcharge (3.00%)', total_charged: '$132.87', bar_today: '$0.00 charged from the bar today',
    });
  });
});

describe('send_invoice commit', () => {
  test('calls the Send handler with the page body and the pinned total, and reports each channel', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    const result = await run();
    expect(Invoices.sendInvoiceFromBar).toHaveBeenCalledWith({
      invoiceId: INV, body: { requestReview: false, firstDelivery: true }, actor: { technicianId: 'staff-1' },
      approvedSend: {
        expectedTotal: 129, recipients: { phone: '9415550100', email: 'robin@example.com' },
        version: { updatedAtMs: new Date('2099-01-01T12:00:00Z').getTime(), digest: expect.stringMatching(/^[0-9a-f]{32}$/) },
      },
    });
    // The exact recipients ride only to the send, never into the result.
    expect(JSON.stringify(result)).not.toMatch(/9415550100|robin@example\.com/);
    expect(result).toMatchObject({ success: true, text: { status: 'sent' }, email: { status: 'sent' } });
    expect(executionOutcome(result)).toBe('completed');
  });

  test('one channel failing is partial; the route refusal text passes through', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, sms: { ok: false, error: 'Customer has no phone number' }, email: { ok: true } } });
    let { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    await expect(run()).resolves.toMatchObject({ partial: true, text: { status: 'not_sent', detail: 'Customer has no phone number' } });
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 400, json: { error: 'Invoice already paid' } });
    ({ run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version'));
    await expect(run()).resolves.toMatchObject({ error: 'The invoice was not sent: Invoice already paid', failed: true });
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 400, json: { error: 'Invoice total is $140.00, not the approved $129.00 — not sent', code: 'total_changed' } });
    ({ run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version'));
    await expect(run()).resolves.toMatchObject({ code: 'total_changed', preview_changed: true });
  });

  test.each([
    ['the total', () => { state.invoices[0].total = '140.00'; }],
    ['the status', () => { state.invoices[0].status = 'viewed'; }],
    ['the credit applied (amount due, same total)', () => { state.invoices[0].credit_applied = '25.00'; }],
    ['the lines (same total)', () => { state.invoices[0].line_items = JSON.stringify([{ description: 'Quarterly Pest Control', amount: 129 }]); }],
    ['the row version', () => { state.invoices[0].updated_at = new Date('2099-01-03T00:00:00Z'); }],
    ['the email recipient', () => { Invoices.getInvoiceDeliveryRecipients.mockResolvedValue(recipients({ emailRecipient: { email: 'other@example.com' } })); }],
  ])('drift in %s refuses with preview_changed and sends nothing', async (_label, mutate) => {
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    mutate();
    await expect(run()).resolves.toMatchObject({ preview_changed: true });
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the card pins the approved version, and a claim that finds it changed reports preview_changed with nothing sent', async () => {
    const { card, run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    expect(card._version).toMatchObject({ invoice_version: new Date('2099-01-01T12:00:00Z').getTime(), version_digest: expect.stringMatching(/^[0-9a-f]{32}$/), first_delivery: true });
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 400, json: { ok: false, code: 'approved_version_changed', error: 'Invoice changed after it was approved — not sent' } });
    await expect(run()).resolves.toMatchObject({ code: 'approved_version_changed', failed: true, preview_changed: true });
  });

  test.each(['sent', 'viewed', 'overdue'])('an invoice at status %s with no sent_at stamp is delivered: a resend, and the card says so', async (status) => {
    state.invoices[0].status = status;
    const card = await preview('send_invoice', { invoice_id: INV });
    expect(card.send_note).toBe(`Already delivered (invoice status ${status}). This sends it again.`);
    expect(card._version.first_delivery).toBe(false);
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    await run();
    expect(Invoices.sendInvoiceFromBar.mock.calls[0][0].body).toEqual({ requestReview: false });
  });

  test('a draft with no delivery stamp is a first delivery: "Not sent before"', async () => {
    state.invoices[0].status = 'draft';
    const card = await preview('send_invoice', { invoice_id: INV });
    expect(card.send_note).toBe('Not sent before.');
    expect(card._version.first_delivery).toBe(true);
  });

  test('the visit closeout the send would run is probed with the closeout\'s own function, named on the card, pinned, and refused as preview_changed when it differs', async () => {
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-1', serviceType: 'Quarterly Pest Control', date: '2099-01-02', resuming: false });
    const { card, run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    expect(issuedCloseoutTarget).toHaveBeenCalledWith(expect.objectContaining({ id: INV }), { trigger: 'sent' });
    expect(card.visit_closeout).toBe('Sending this invoice also completes the linked visit (Quarterly Pest Control on 2099-01-02) and creates its service record; no completion text, report, review request or charge');
    expect(cardLines('send_invoice', card).map((l) => l.text)).toContain(card.visit_closeout);
    expect(card._version).toMatchObject({ closeout_visit: 'visit-1', closeout_resuming: false });
    // The visit is gone (or another one is linked) by the time the card is confirmed.
    issuedCloseoutTarget.mockResolvedValue(null);
    await expect(run()).resolves.toMatchObject({ preview_changed: true });
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a closeout already started is disclosed as a resume; a probe that cannot read refuses the send', async () => {
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-1', serviceType: 'Mosquito', date: '2099-01-02', resuming: true });
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ visit_closeout: expect.stringMatching(/^Sending this invoice also finishes a closeout already started/) });
    issuedCloseoutTarget.mockRejectedValue(new Error('profile read failed'));
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'closeout_check_failed' });
    issuedCloseoutTarget.mockResolvedValue(null);
    const card = await preview('send_invoice', { invoice_id: INV });
    expect(card.visit_closeout).toBeUndefined();
    expect(card._version).toMatchObject({ closeout_visit: null });
  });

  test('an invoice sent before is a resend: no first-delivery flag', async () => {
    state.invoices[0].sent_at = new Date('2098-12-01T00:00:00Z');
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    await run();
    expect(Invoices.sendInvoiceFromBar.mock.calls[0][0].body).toEqual({ requestReview: false });
  });

  test.each([
    ['a live claim 409 with the route code', { status: 409, json: { error: 'Invoice INV is already being delivered by another request — not sent again', code: 'delivery_in_progress' } }],
    ['a live claim 409 with no code (a resend)', { status: 409, json: { error: 'Invoice send already in progress' } }],
    ['a first delivery the route answered as in progress', { status: 200, json: { ok: true, in_progress: true, sms: { ok: false, code: 'delivery_in_progress' }, email: { ok: false, code: 'delivery_in_progress' } } }],
  ])('another send owning the claim (%s) is uncertain and never invites a retry or a fresh card', async (_label, reply) => {
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce(reply);
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    const result = await run();
    expect(result).toMatchObject({ outcome_unknown: true, code: 'delivery_in_progress', error: expect.stringMatching(/Another send of this invoice is in progress.*check the invoice page/) });
    expect(result.preview_changed).toBeUndefined();
    expect(result.failed).toBeUndefined();
    expect(result.success).toBeUndefined();
    expect(executionOutcome(result)).toBe('outcome_unknown');
  });

  test('a first delivery another request already completed is a no-op success', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, already_delivered: true, sms: { ok: false, code: 'already_delivered' }, email: { ok: false, code: 'already_delivered' } } });
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    await expect(run()).resolves.toMatchObject({ success: true, note: expect.stringMatching(/already delivered/) });
  });

  test('an uncertain delivery is reported as unknown, never as not sent', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 400, json: { ok: false, code: 'INVOICE_DELIVERY_OUTCOME_UNCERTAIN', error: 'x',
      sms: { ok: false, deliveryOutcome: 'uncertain' }, email: { ok: false, error: 'bounced' } } });
    let { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    let result = await run();
    expect(result).toMatchObject({ outcome_unknown: true, code: 'INVOICE_DELIVERY_OUTCOME_UNCERTAIN', text: { status: 'unknown' } });
    expect(result.failed).toBeUndefined();
    expect(executionOutcome(result)).toBe('outcome_unknown');
    Invoices.sendInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, sms: { ok: false, deliveryOutcome: 'uncertain' }, email: { ok: true } } });
    ({ run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version'));
    result = await run();
    expect(result).toMatchObject({ partial: true, text: { status: 'unknown' }, email: { status: 'sent' } });
    expect(result.note).toMatch(/could not be confirmed/);
  });

  test('a visit cancelled between the check and the send: the handler refuses (held for review), nothing voided or sent', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 409, json: { ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED', error: 'Linked visit is cancelled; delivery not attempted' } });
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    await expect(run()).resolves.toMatchObject({ code: 'INVOICE_VISIT_TERMINAL_UNVOIDED', preview_changed: true, error: 'Nothing was sent: Linked visit is cancelled; delivery not attempted' });
  });

  test('without the card pin, or after a throw, it never invites a retry', async () => {
    await expect(executeInvoiceActionTool('send_invoice', { invoice_id: INV, confirmed: true }, ADMIN)).resolves.toMatchObject({ code: 'approval_required' });
    Invoices.sendInvoiceFromBar.mockRejectedValue(new Error('socket hang up'));
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    await expect(run()).resolves.toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });
});

describe('charge_invoice card', () => {
  test('names the card, the balance, the surcharge and the total exactly as the quote gives them', async () => {
    const p = await preview('charge_invoice', { invoice_id: INV });
    expect(StripeService.quoteInvoiceSavedCardCharge).toHaveBeenCalledWith(INV, CARD);
    expect(p).toMatchObject({
      preview: true, invoice_number: 'WPC-2099-0001', customer_name: 'Robin Sample', payment_method_id: CARD,
      card: 'Visa •••• 4242 (exp 12/32)', balance: '$129.00', surcharge: '$3.87 card surcharge (3.00%)', total_charged: '$132.87',
      limits: 'At most $500.00 per charge and $1500.00 a day from the bar.', _charged_today: '$0.00 charged from the bar today',
    });
    expect(p.receipt).toMatch(/payment receipt/);
    expect(p._version).toMatchObject({ payment_method_id: CARD, base_cents: 12900, surcharge_cents: 387, charge_cents: 13287 });
    expect(cardLines('charge_invoice', p).map((l) => l.text)).toEqual(expect.arrayContaining([
      'Card: Visa •••• 4242 (exp 12/32)', 'Invoice balance: $129.00', 'Surcharge: $3.87 card surcharge (3.00%)', 'TOTAL CHARGED: $132.87',
    ]));
  });

  test.each(['cash', 'check', 'other', 'zelle', 'venmo', 'paypal', 'bank', 'bank_account', 'ach', null, ''])(
    'a saved method of type %p is not a card: refused by id and by last 4, never quoted, and never auto-picked',
    async (type) => {
      state.payment_methods = [cardRow({ method_type: type })];
      await expect(preview('charge_invoice', { invoice_id: INV, payment_method_id: CARD })).resolves.toMatchObject({ code: 'not_card_method' });
      await expect(preview('charge_invoice', { invoice_id: INV, card_last4: '4242' })).resolves.toMatchObject({ code: 'not_card_method' });
      // The only saved method is not a card, so there is no card to pick.
      await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'no_saved_card' });
      expect(StripeService.quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
    },
  );

  test('a card type (including a new Stripe wallet type the surcharge path treats as a card) still builds the card', async () => {
    for (const type of ['card', 'apple_pay']) {
      state.payment_methods = [cardRow({ method_type: type })];
      await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ preview: true, payment_method_id: CARD });
    }
  });

  test('account credit applied first is named; a debit card shows no surcharge', async () => {
    StripeService.quoteInvoiceSavedCardCharge.mockResolvedValue(quote({ base: 104, surcharge: 0, total: 104, rateBps: 0, funding: 'debit', projectedCreditApplied: 25 }));
    const p = await preview('charge_invoice', { invoice_id: INV });
    expect(p).toMatchObject({ account_credit: '$25.00 of account credit is applied first', surcharge: 'No card surcharge', total_charged: '$104.00' });
  });

  test('the tool does no surcharge math of its own (computeChargeAmount stays the one path)', () => {
    const src = fs.readFileSync(require.resolve('../services/intelligence-bar/invoice-action-tools'), 'utf8');
    // The one stripe-pricing import is the card-type classifier (no math).
    const withoutClassifier = src.replace("const { isCardMethodType } = require('../stripe-pricing');", '');
    expect(withoutClassifier).not.toMatch(/computeChargeAmount\(|require\([^)]*stripe-pricing|rateBps\)?\s*\*/);
    expect(src).toContain('quoteInvoiceSavedCardCharge(invoice.id, card.id)');
  });

  test.each([
    ['paid', { status: 'paid' }, 'Invoice already paid'],
    ['prepaid', { status: 'prepaid' }, 'Invoice is already prepaid'],
    ['refunded', { status: 'refunded' }, 'Invoice has been refunded and cannot be paid'],
    ['processing', { status: 'processing' }, 'Bank payment is already processing'],
    ['payer billed', { payer_id: 'payer-1' }, 'Invoice is billed to a third-party payer — collect from the payer, not a saved card on the service account'],
  ])('refuses %s with the route text', async (_label, overrides, text) => {
    state.invoices[0] = invoiceRow(overrides);
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ error: text });
    expect(StripeService.quoteInvoiceSavedCardCharge).not.toHaveBeenCalled();
  });

  test('refuses a charge already in flight, a dispute hold, a bank account, another customer\'s card and two unnamed cards', async () => {
    state.stripe_invoice_charge_attempts = [{ invoice_id: INV, status: 'ambiguous', resolved_at: null }];
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({
      error: 'A saved-card charge is already in progress or awaiting reconciliation. DO NOT charge again until an admin verifies it.',
    });
    state.stripe_invoice_charge_attempts = [];
    CollectionHold.customerHasActiveCollectionHoldChecked.mockResolvedValueOnce(true);
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'collection_hold', error: expect.stringMatching(/^Collection is on hold for this customer \(billing dispute\)/) });
    state.payment_methods = [cardRow({ method_type: 'us_bank_account', last_four: '6789' })];
    await expect(preview('charge_invoice', { invoice_id: INV, card_last4: '6789' })).resolves.toMatchObject({ code: 'not_card_method' });
    state.payment_methods = [cardRow({ customer_id: 'cust-2' })];
    await expect(preview('charge_invoice', { invoice_id: INV, payment_method_id: CARD })).resolves.toMatchObject({ error: 'Payment method does not belong to invoice customer' });
    state.payment_methods = [cardRow(), cardRow({ id: CARD2, last_four: '1881', is_default: false })];
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'card_ambiguous' });
    await expect(preview('charge_invoice', { invoice_id: INV, card_last4: '1881' })).resolves.toMatchObject({ payment_method_id: CARD2 });
    expect(StripeService.quoteInvoiceSavedCardCharge).toHaveBeenCalledTimes(1);
  });

  test('a quote refusal passes through; full credit coverage is refused (the card would charge nothing)', async () => {
    StripeService.quoteInvoiceSavedCardCharge.mockRejectedValueOnce(new Error('Payment method has no Stripe id'));
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ error: 'Payment method has no Stripe id' });
    StripeService.quoteInvoiceSavedCardCharge.mockResolvedValueOnce(quote({ base: 0, surcharge: 0, total: 0, coveredByCredit: true }));
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'covered_by_credit' });
  });
});

describe('charge caps', () => {
  test('per charge: a total over $500 (surcharge included) is refused', async () => {
    StripeService.quoteInvoiceSavedCardCharge.mockResolvedValue(quote({ base: 490, surcharge: 14.7, total: 504.7 }));
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({
      code: 'charge_limit', error: expect.stringMatching(/this charge is \$504\.70 with the card surcharge, and the bar charges at most \$500\.00/),
    });
    StripeService.quoteInvoiceSavedCardCharge.mockResolvedValue(quote({ base: 485.44, surcharge: 14.56, total: 500 }));
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ preview: true, total_charged: '$500.00' });
  });

  test('daily: today\'s stamped bar payments plus this total over $1,500 is refused; other days, other sources and failed rows do not count', async () => {
    state.payments = [
      { amount: '1400.00', payment_date: TODAY, status: 'paid', metadata: { initiated_via: 'intelligence_bar' } },
      { amount: '900.00', payment_date: TODAY, status: 'paid', metadata: { source: 'admin_card_on_file' } },
      { amount: '900.00', payment_date: '2000-01-01', status: 'paid', metadata: { initiated_via: 'intelligence_bar' } },
      { amount: '300.00', payment_date: TODAY, status: 'failed', metadata: { initiated_via: 'intelligence_bar' } },
    ];
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({
      code: 'charge_limit', error: expect.stringMatching(/the bar has charged \$1400\.00 today, and this \$132\.87 charge would pass the \$1500\.00 daily limit/),
    });
    state.payments[0].amount = '1367.13';
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ preview: true });
  });

  test('an approval for another invoice with an unknown or unrecorded outcome counts as $500; this invoice\'s own does not', async () => {
    state.payments = [{ amount: '900.00', payment_date: TODAY, status: 'paid', metadata: { initiated_via: 'intelligence_bar' } }];
    state.ib_pending_actions = [{ tool_name: 'charge_invoice', status: 'confirmed', consumed_day: TODAY, result: null, params: { invoice_id: INV } }];
    await expect(chargedTodayCents(db, { excludeInvoiceId: INV })).resolves.toBe(90000);
    state.ib_pending_actions.push({ tool_name: 'charge_invoice', status: 'confirmed', consumed_day: TODAY, result: { outcome_unknown: true }, params: { invoice_id: INV2 } });
    state.ib_pending_actions.push({ tool_name: 'charge_invoice', status: 'confirmed', consumed_day: TODAY, result: { success: true }, params: { invoice_id: 'inv-done' } });
    // An approval with no charge claim yet (still waiting its turn) is not a reservation; one with an unresolved claim is.
    await expect(chargedTodayCents(db, { excludeInvoiceId: INV })).resolves.toBe(90000);
    state.stripe_invoice_charge_attempts = [{ invoice_id: INV2, status: 'ambiguous', resolved_at: null }];
    await expect(chargedTodayCents(db, { excludeInvoiceId: INV })).resolves.toBe(140000);
    await expect(preview('charge_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'charge_limit' });
  });

  test('another bar charge between card and Confirm (or this approval being consumed) does not change the approval fingerprint', async () => {
    const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
    const before = await preview('charge_invoice', { invoice_id: INV });
    // Confirm consumes this card's own approval before the route re-runs the preview,
    // and another card for another invoice is in flight.
    state.ib_pending_actions = [
      { tool_name: 'charge_invoice', status: 'confirmed', consumed_day: TODAY, result: null, params: { invoice_id: INV } },
      { tool_name: 'charge_invoice', status: 'confirmed', consumed_day: TODAY, result: null, params: { invoice_id: INV2 } },
    ];
    state.stripe_invoice_charge_attempts = [{ invoice_id: INV2, status: 'claimed', resolved_at: null }];
    state.payments = [{ amount: '100.00', payment_date: TODAY, status: 'paid', metadata: { initiated_via: 'intelligence_bar' } }];
    const live = await preview('charge_invoice', { invoice_id: INV });
    expect(live._charged_today).toBe('$600.00 charged from the bar today');
    expect(previewFingerprint(live)).toBe(previewFingerprint(before));
  });

  test('the guard takes the advisory lock, then rechecks both caps and the dispute hold on the charge transaction', async () => {
    const trx = makeDb();
    trx.raw = jest.fn(async () => {});
    const guard = chargeLockGuard({ invoiceId: INV, customerId: 'cust-1' });
    await expect(guard(trx, { totalCents: 13287 })).resolves.toBeUndefined();
    expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['ib-invoice-charge-daily-cap']);
    expect(CollectionHold.assertNoCollectionHold).toHaveBeenCalledWith('cust-1', trx);
    await expect(guard(trx, { totalCents: 50001 })).rejects.toThrow(/^Bar charge limit: this charge is \$500\.01/);
    state.payments = [{ amount: '1450.00', payment_date: TODAY, status: 'processing', metadata: { initiated_via: 'intelligence_bar' } }];
    await expect(guard(trx, { totalCents: 5001 })).rejects.toThrow(/daily limit/);
  });

  test('two cards confirmed at once: the in-transaction recheck lets one charge and refuses the other', async () => {
    // $1,000 already charged from the bar today; two $400 cards for two invoices both pass their preview.
    state.payments = [{ amount: '1000.00', payment_date: TODAY, status: 'paid', metadata: { initiated_via: 'intelligence_bar' } }];
    StripeService.quoteInvoiceSavedCardCharge.mockResolvedValue(quote({ base: 388.35, surcharge: 11.65, total: 400 }));
    const a = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    const b = await confirmWith('charge_invoice', { invoice_id: INV2 }, '_verified_invoice_charge_version');
    // The charge path, simulated: one transaction per charge; pg_advisory_xact_lock
    // serializes them until the transaction (with its stamped payments insert) commits.
    let held = Promise.resolve();
    Invoices.chargeInvoiceFromBar.mockImplementation(async ({ invoiceId, body, chargeGuard }) => {
      let release;
      const trx = makeDb();
      trx.raw = jest.fn((sql) => {
        if (!/pg_advisory_xact_lock/.test(sql)) return Promise.resolve();
        const prior = held;
        held = new Promise((r) => { release = r; });
        return prior;
      });
      try {
        await chargeGuard(trx, { totalCents: Math.round(body.expectedTotal * 100) });
        await new Promise((r) => setImmediate(r)); // the Stripe call, lock held
        state.payments.push({ amount: String(body.expectedTotal), payment_date: TODAY, status: 'paid', metadata: { initiated_via: 'intelligence_bar' }, invoice_id: invoiceId });
        return { status: 200, json: { success: true, paymentId: `pay-${invoiceId}`, status: 'paid', amount: body.expectedTotal, brand: 'Visa', last4: '4242' } };
      } catch (err) {
        return { status: 400, json: { error: err.message } };
      } finally {
        release?.();
      }
    });
    const [ra, rb] = await Promise.all([a.run(), b.run()]);
    const results = [ra, rb];
    expect(results.filter((r) => r.success === true)).toHaveLength(1);
    expect(results.filter((r) => r.code === 'charge_limit' && r.blocked === true)).toHaveLength(1);
    expect(results.find((r) => r.code === 'charge_limit').error).toMatch(/^Nothing was charged: Bar charge limit: the bar has charged \$1400\.00 today/);
    expect(state.payments.filter((p) => p.payment_date === TODAY).reduce((s, p) => s + Number(p.amount), 0)).toBe(1400);
  });
});

describe('charge_invoice commit', () => {
  test('calls the charge-card handler with the page body (card + quoted total) and a cap guard; reports the payment', async () => {
    Invoices.chargeInvoiceFromBar.mockResolvedValue({ status: 200, json: { success: true, paymentId: 'pay-1', status: 'paid', amount: 132.87, brand: 'Visa', last4: '4242' } });
    const { run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    const result = await run();
    expect(Invoices.chargeInvoiceFromBar).toHaveBeenCalledWith({
      invoiceId: INV, body: { paymentMethodId: CARD, expectedTotal: 132.87 }, actor: { technicianId: 'staff-1' }, chargeGuard: expect.any(Function),
      version: { updatedAtMs: new Date('2099-01-01T12:00:00Z').getTime(), digest: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
    expect(result).toMatchObject({ success: true, charged: true, payment_id: 'pay-1', amount: '$132.87', card: 'Visa •••• 4242' });
    expect(executionOutcome(result)).toBe('completed');
    // The charge reported nothing about the receipt, so the bar says nothing about it.
    expect(result.note).toBe('Charged $132.87. The invoice is paid.');
  });

  test('the receipt is called queued only when the charge says so; a failed enqueue is stated plainly', async () => {
    const paid = { success: true, paymentId: 'pay-1', status: 'paid', amount: 132.87, brand: 'Visa', last4: '4242' };
    Invoices.chargeInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { ...paid, receiptQueued: true } });
    let { run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    await expect(run()).resolves.toMatchObject({ success: true, note: 'Charged $132.87. The invoice is paid; the receipt is queued.' });
    Invoices.chargeInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { ...paid, receiptQueued: false, receiptQueueError: 'queue down' } });
    ({ run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version'));
    const result = await run();
    expect(result).toMatchObject({ success: true, charged: true, receipt_queued: false, note: 'Charged $132.87. The invoice is paid, but the receipt was NOT queued. Send it from the invoice page.' });
    expect(result.note).not.toMatch(/receipt is queued/);
  });

  test('the approved version rides to the charge; a refusal under the invoice lock is preview_changed with nothing charged', async () => {
    Invoices.chargeInvoiceFromBar.mockResolvedValueOnce({ status: 400, json: { error: 'Invoice changed after it was approved (amount due, lines or edit time). Nothing was charged.', code: 'approved_version_changed' } });
    const { run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    const result = await run();
    expect(Invoices.chargeInvoiceFromBar.mock.calls[0][0].version).toEqual({ updatedAtMs: new Date('2099-01-01T12:00:00Z').getTime(), digest: expect.any(String) });
    expect(result).toMatchObject({ code: 'approved_version_changed', preview_changed: true });
    expect(result.charged).toBeUndefined();
  });

  test('two cards confirmed at once near the daily limit: one charges, the other is refused cleanly (neither counts the other as a reservation)', async () => {
    // $1,000 committed; two $500 cards. Each approval is already consumed (result not yet recorded).
    state.payments = [{ amount: '1000.00', payment_date: TODAY, status: 'paid', metadata: { initiated_via: 'intelligence_bar' } }];
    StripeService.quoteInvoiceSavedCardCharge.mockResolvedValue(quote({ base: 485.44, surcharge: 14.56, total: 500 }));
    const a = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    const b = await confirmWith('charge_invoice', { invoice_id: INV2 }, '_verified_invoice_charge_version');
    state.ib_pending_actions = [INV, INV2].map((id) => ({ tool_name: 'charge_invoice', status: 'confirmed', consumed_day: TODAY, result: null, params: { invoice_id: id } }));
    const order = [];
    Invoices.chargeInvoiceFromBar.mockImplementation(async ({ invoiceId, body, chargeGuard }) => {
      order.push(invoiceId);
      // The charge path's own durable claim, then its transaction, then the payment row and the resolved attempt.
      const attempt = { invoice_id: invoiceId, status: 'claimed', resolved_at: null };
      state.stripe_invoice_charge_attempts.push(attempt);
      try {
        await chargeGuard(Object.assign(makeDb(), { raw: jest.fn(async () => {}) }), { totalCents: Math.round(body.expectedTotal * 100) });
        await new Promise((r) => setImmediate(r)); // the Stripe call
        state.payments.push({ amount: String(body.expectedTotal), payment_date: TODAY, status: 'paid', metadata: { initiated_via: 'intelligence_bar' }, invoice_id: invoiceId });
        return { status: 200, json: { success: true, paymentId: `pay-${invoiceId}`, status: 'paid', amount: body.expectedTotal, brand: 'Visa', last4: '4242' } };
      } catch (err) {
        return { status: 400, json: { error: err.message } };
      } finally {
        attempt.status = 'succeeded'; attempt.resolved_at = new Date();
      }
    });
    const results = await Promise.all([a.run(), b.run()]);
    expect(results.filter((r) => r.success === true)).toHaveLength(1);
    const refused = results.find((r) => r.success !== true);
    // The loser saw the winner's COMMITTED $1,500, not a $500 reservation on top of it.
    expect(refused).toMatchObject({ code: 'charge_limit', blocked: true });
    expect(refused.error).toMatch(/the bar has charged \$1500\.00 today/);
    expect(order).toHaveLength(1);
  });

  test('a lock wait that times out charges nothing and says so, without calling the charge', async () => {
    const { run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    db.transaction.mockImplementationOnce(async (callback) => callback({ raw: jest.fn(async (sql) => { if (/pg_advisory_xact_lock/.test(sql)) throw Object.assign(new Error('lock timeout'), { code: '55P03' }); }) }));
    await expect(run()).resolves.toMatchObject({ code: 'charge_busy', error: expect.stringMatching(/nothing was charged/) });
    expect(Invoices.chargeInvoiceFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['the total', () => StripeService.quoteInvoiceSavedCardCharge.mockResolvedValue(quote({ surcharge: 3.9, total: 132.9 }))],
    ['the card', () => { state.payment_methods[0].exp_year = 2033; }],
    ['the invoice version', () => { state.invoices[0].updated_at = new Date('2099-02-01T00:00:00Z'); }],
    ['the credit applied', () => { state.invoices[0].credit_applied = '1.00'; }],
  ])('drift in %s refuses with preview_changed and charges nothing', async (_label, mutate) => {
    const { run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    mutate();
    await expect(run()).resolves.toMatchObject({ preview_changed: true });
    expect(Invoices.chargeInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the route\'s refusals and uncertain outcomes pass through with their text; nothing invites a retry', async () => {
    const cases = [
      [{ status: 400, json: { error: 'Invoice amount changed after the payment quote. Review the updated total before charging.' } }, { preview_changed: true, error: 'Nothing was charged: Invoice amount changed after the payment quote. Review the updated total before charging.' }],
      [{ status: 400, json: { error: 'Collection is on hold for this customer (billing dispute). Review before charging.' } }, { error: 'Nothing was charged: Collection is on hold for this customer (billing dispute). Review before charging.' }],
      [{ status: 409, json: { error: 'Charge outcome is uncertain — Stripe may have processed it. DO NOT charge again until an admin checks Stripe.', code: 'STRIPE_AMBIGUOUS_OUTCOME', ambiguous: true } }, { outcome_unknown: true, code: 'STRIPE_AMBIGUOUS_OUTCOME' }],
      [{ status: 409, json: { error: 'Charge succeeded at Stripe (PI pi_x) but could not be recorded. DO NOT charge again — an admin must reconcile it.', code: 'STRIPE_CHARGED_DB_FAILED', orphan: true } }, { outcome_unknown: true }],
      [{ status: 409, json: { error: 'A saved-card charge is already in progress or awaiting reconciliation. DO NOT charge again until an admin verifies it.', code: 'STRIPE_CHARGE_IN_PROGRESS', in_progress: true } }, { outcome_unknown: true }],
    ];
    for (const [reply, expected] of cases) {
      Invoices.chargeInvoiceFromBar.mockResolvedValueOnce(reply);
      const { run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
      await expect(run()).resolves.toMatchObject(expected);
    }
    Invoices.chargeInvoiceFromBar.mockRejectedValueOnce(new Error('connection reset'));
    const { run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    await expect(run()).resolves.toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });

  test('a cap reached between the card and the confirm is refused before the charge path runs', async () => {
    const { run } = await confirmWith('charge_invoice', { invoice_id: INV }, '_verified_invoice_charge_version');
    state.payments = [{ amount: '1450.00', payment_date: TODAY, status: 'paid', metadata: { initiated_via: 'intelligence_bar' } }];
    await expect(run()).resolves.toMatchObject({ code: 'charge_limit', blocked: true });
    expect(Invoices.chargeInvoiceFromBar).not.toHaveBeenCalled();
  });
});
