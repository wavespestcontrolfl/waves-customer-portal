/**
 * IB send_invoice (owner ruling 2026-10-07): an existing invoice only, always
 * a card, admin only, dark behind GATE_IB_INVOICE_ACTIONS. Card content, the
 * reused route refusals, who owes the invoice, pin drift, gate off, admin
 * only, and that the commit calls the Invoices page handler with the page's
 * own arguments. The route handler is mocked; nothing here reaches a provider.
 * Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-invoices', () => ({
  getInvoiceDeliveryRecipients: jest.fn(),
  sendInvoiceFromBar: jest.fn(),
}));
jest.mock('../services/invoice-issued-closeout', () => ({ issuedCloseoutTarget: jest.fn(async () => null) }));
// The sources the effects plan reads (each is the handler's own function; their own tests cover them).
jest.mock('../services/lead-estimate-link', () => ({ invoiceSentConversionTargets: jest.fn(async () => ({ leadIds: [] })) }));
jest.mock('../services/invoice-followups', () => ({
  planFollowupSequence: jest.fn(async () => ({ arms: true, state: 'active', cadence: [3, 7, 14, 30] })),
  activePaymentPlan: jest.fn(async () => null),
}));
jest.mock('../services/collections/collection-hold', () => ({
  customerHasActiveMessagingHoldChecked: jest.fn(async () => false),
}));
// Who owes the invoice: the canonical live resolver (its own tests cover it); the default answer is the customer.
jest.mock('../services/invoice-payer-ownership', () => ({ invoicePayerOwnership: jest.fn(async () => null) }));

const fs = require('fs');
const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const CollectionHold = require('../services/collections/collection-hold');
const { issuedCloseoutTarget } = require('../services/invoice-issued-closeout');
const LeadLink = require('../services/lead-estimate-link');
const Followups = require('../services/invoice-followups');
const { invoicePayerOwnership } = require('../services/invoice-payer-ownership');
const tools = require('../services/intelligence-bar/invoice-action-tools');
const { executeInvoiceActionTool, INVOICE_ACTION_TOOLS, cardLines } = tools;
const gates = require('../services/intelligence-bar/write-gates');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const INV = '00000000-0000-4000-8000-0000000000a1';
const INV2 = '00000000-0000-4000-8000-0000000000a2';
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
function freshState() {
  return {
    invoices: [invoiceRow(), invoiceRow({ id: INV2, invoice_number: 'WPC-2099-0002' })],
    customers: [{ id: 'cust-1', first_name: 'Robin', last_name: 'Sample' }],
    invoice_attachments: [],
    scheduled_services: [],
    service_records: [],
  };
}

// A small knex stand-in: plain-object where / whereIn / whereNull filter the seeded rows.
function makeDb() {
  function builder(rawTable) {
    const table = String(rawTable).split(' as ')[0];
    const q = { wheres: [], ins: [], nulls: [], single: false };
    const resolveRows = () => {
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
        if (prop === 'first') return () => { q.single = true; return b; };
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

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IB_INVOICE_ACTIONS = 'true';
  state = freshState();
  db.mockImplementation(makeDb());
  Invoices.getInvoiceDeliveryRecipients.mockImplementation(async () => recipients());
  invoicePayerOwnership.mockReset().mockResolvedValue(null);
  issuedCloseoutTarget.mockReset();
  issuedCloseoutTarget.mockResolvedValue(null);
  // The effects plan's sources start from "nothing else happens" in every test.
  LeadLink.invoiceSentConversionTargets.mockReset().mockResolvedValue({ leadIds: [] });
  Followups.planFollowupSequence.mockReset().mockResolvedValue({ arms: true, state: 'active', cadence: [3, 7, 14, 30] });
  Followups.activePaymentPlan.mockReset().mockResolvedValue(null);
  CollectionHold.customerHasActiveMessagingHoldChecked.mockResolvedValue(false);
});
afterAll(() => { delete process.env.GATE_IB_INVOICE_ACTIONS; });

const preview = (tool, input) => executeInvoiceActionTool(tool, input, ADMIN);
async function confirmWith(tool, input, versionKey, ctx = ADMIN) {
  const card = await preview(tool, input);
  expect(card.preview).toBe(true);
  return { card, run: () => executeInvoiceActionTool(tool, { ...input, confirmed: true, [versionKey]: card._version }, ctx) };
}
// The card's effect sentences, and one effect by key.
const effectTexts = (card) => (card.effects || []).map((e) => e.text);
const effectText = (card, key) => (card.effects || []).find((e) => e.key === key)?.text;


describe('registration', () => {
  test('send_invoice is a two-step write, never owner-direct, flagged side-effecting, uuid params typed, and there is no charge tool', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('send_invoice')).toBe(true);
    expect(INVOICE_ACTION_TOOLS.map((t) => t.name)).toEqual(['send_invoice']);
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('charge_invoice')).toBe(false);
    const ownerDirect = require('../services/intelligence-bar/owner-direct');
    expect(ownerDirect.OWNER_DIRECT_TOOL_NAMES.has('send_invoice')).toBe(false);
    for (const tool of INVOICE_ACTION_TOOLS) {
      expect(tool._sideEffects).toBe(true);
      expect(tool.input_schema.properties.invoice_id.format).toBe('uuid');
      expect(tool.input_schema.properties.confirmed).toBeUndefined();
    }
    const policy = require('../services/intelligence-bar/action-policy.json');
    expect(policy.send_invoice).toMatchObject({ role: 'admin', approval: 'ui_confirm', kind: 'external_action' });
    expect(policy.charge_invoice).toBeUndefined();
  });

  test('the contract marks the send irreversible, customer-contacting, with the curated card lines', async () => {
    for (const tool of ['send_invoice']) {
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
    for (const tool of ['send_invoice']) {
      await expect(executeInvoiceActionTool(tool, { invoice_id: INV }, ADMIN)).resolves.toMatchObject({ code: 'gate_off' });
      await expect(executeInvoiceActionTool(tool, { invoice_id: INV, confirmed: true }, ADMIN)).resolves.toMatchObject({ code: 'gate_off' });
    }
    expect(db).not.toHaveBeenCalled();
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a technician is refused; a confirmed run needs a positive admin flag', async () => {
    await expect(executeInvoiceActionTool('send_invoice', { invoice_id: INV }, { isAdmin: false })).resolves.toMatchObject({ code: 'permission_denied' });
    await expect(executeInvoiceActionTool('send_invoice', { invoice_id: INV, confirmed: true, _verified_invoice_send_version: {} }, {}))
      .resolves.toMatchObject({ code: 'permission_denied' });
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the route offers it only to admins on the Customers, Revenue and dashboard pages while the gate is on', () => {
    const route = require('../routes/admin-intelligence-bar');
    const names = (ctx, admin) => route.getToolsForContext(ctx, admin).map((t) => t.name);
    for (const ctx of ['customers', 'revenue', 'dashboard']) expect(names(ctx, true)).toContain('send_invoice');
    expect(names('seo', true)).not.toContain('send_invoice');
    expect(names('tech', false)).not.toContain('send_invoice');
    expect(names('customers', false)).not.toContain('send_invoice');
    delete process.env.GATE_IB_INVOICE_ACTIONS;
    expect(names('customers', true)).not.toContain('send_invoice');
    expect(route.ADMIN_ONLY_TOOL_NAMES === undefined || route.ADMIN_ONLY_TOOL_NAMES.has('send_invoice')).toBe(true);
  });
});

describe('send_invoice card', () => {
  test('names the invoice, the money, the lines, each channel with its masked recipient and the message', async () => {
    const p = await preview('send_invoice', { invoice_number: 'wpc-2099-0001' });
    expect(p).toMatchObject({
      preview: true, invoice_number: 'WPC-2099-0001', customer_name: 'Robin Sample', amount_due: '$129.00', total: '$129.00',
      lines: ['Quarterly Pest Control $99.00', 'Mosquito add-on $30.00'], channels: 'text and email', send_note: 'Not sent before.',
    });
    expect(effectTexts(p)).toEqual(expect.arrayContaining(['Not sent before.', 'No review request is sent.']));
    expect(p.text).toBe('Text to ***0100: the invoice text (template invoice_sent, or its pre-service or annual-prepay variant when that applies) with the pay link. Not sent if the customer opted out of texts.');
    expect(p.email).toBe('Email to r***@example.com: the invoice email (template invoice.sent), subject "Invoice WPC-2099-0001 — $129.00", with the invoice PDF and the pay link. The email carries the invoice only (no other-balance or account details).');
    const lines = cardLines('send_invoice', p).map((l) => l.text);
    expect(lines).toEqual(expect.arrayContaining(['Amount due: $129.00 (invoice total $129.00)', 'Line 1 of 2: Quarterly Pest Control $99.00', p.text, p.email,
      ...effectTexts(p),
      'No account credit is applied by this send. If the visit is cancelled before the send runs, nothing is sent and the invoice is held for review (never voided by the bar).']));
    expect(JSON.stringify(p)).not.toContain('9415550100');
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
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

  describe('the annual-plan check (round 9) uses the pay page\'s resolver and fails closed', () => {
    const Prepay = require('../services/invoice-prepay');
    afterEach(() => jest.restoreAllMocks());

    test('an invoice with no tag that is the anchor of its visit\'s annual term is refused (the resolver finds it)', async () => {
      state.invoices[0] = invoiceRow({ annual_prepay_term_id: null });
      const resolve = jest.spyOn(Prepay, 'resolveInvoiceTermId').mockResolvedValue('term-9');
      await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'annual_plan_invoice', error: 'This is an annual-plan invoice. Send it from the Invoices page.' });
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: INV }), db, { strict: true });
    });

    test('a resolver that throws refuses with the unverified text and builds no card', async () => {
      jest.spyOn(Prepay, 'resolveInvoiceTermId').mockRejectedValue(new Error('lookup failed'));
      await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'annual_plan_invoice', error: expect.stringMatching(/could not verify whether this is an annual-plan invoice/) });
    });

    test('the send claim asks again on the claimed row: a plan that appeared after the card, or a lookup that fails, refuses', async () => {
      Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
      const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
      await run();
      const { verifyOwner } = Invoices.sendInvoiceFromBar.mock.calls[0][0].approvedSend.version;
      const claimed = { ...state.invoices[0], status: 'draft' };
      await expect(verifyOwner(claimed, db)).resolves.toBeNull();
      const resolve = jest.spyOn(Prepay, 'resolveInvoiceTermId').mockResolvedValue('term-9');
      await expect(verifyOwner(claimed, db)).resolves.toMatch(/annual-plan invoice/);
      expect(resolve).toHaveBeenCalledWith(claimed, db, { strict: true });
      resolve.mockRejectedValue(new Error('lookup failed'));
      await expect(verifyOwner(claimed, db)).resolves.toMatch(/could not verify whether this is an annual-plan invoice/);
    });
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
  test('names the invoice, customer and money (never raw ids)', async () => {
    const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');
    const send = await preview('send_invoice', { invoice_id: INV });
    expect(confirmationDisplayParams('send_invoice', { invoice_id: INV }, send)).toEqual({
      invoice: 'WPC-2099-0001', customer: 'Robin Sample', amount_due: '$129.00', send_by: 'text and email', sent_before: 'Not sent before.',
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
        version: { updatedAtMs: new Date('2099-01-01T12:00:00Z').getTime(), digest: expect.stringMatching(/^[0-9a-f]{32}$/), attachments: expect.stringMatching(/^[0-9a-f]{32}$/), closeoutTarget: 'none', leadTargets: 'none', verifyOwner: expect.any(Function), verifyEffects: expect.any(Function) },
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
    ['the email-content gates (round 9 pin)', () => { jest.spyOn(require('../config/feature-gates'), 'isEnabled').mockImplementation((gate) => gate === 'balanceVisibility'); }],
  ])('drift in %s refuses with preview_changed and sends nothing', async (_label, mutate) => {
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    mutate();
    try {
      await expect(run()).resolves.toMatchObject({ preview_changed: true });
    } finally {
      // Only the gate spy of the round 9 row is a real spy; the rest are fakes the file resets itself.
      jest.spyOn(require('../config/feature-gates'), 'isEnabled').mockRestore();
    }
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
    expect(issuedCloseoutTarget).toHaveBeenCalledWith(expect.objectContaining({ id: INV }), { trigger: 'sent', conn: expect.anything() });
    const closeoutSentence = 'Sending this invoice also completes the linked visit (Quarterly Pest Control on 2099-01-02) and creates its service record; no completion text, report, review request or charge';
    expect(effectText(card, 'closeout')).toBe(closeoutSentence);
    expect(cardLines('send_invoice', card).map((l) => l.text)).toContain(closeoutSentence);
    expect(card._version.effects).toMatch(/^[0-9a-f]{32}$/);
    // The visit is gone (or another one is linked) by the time the card is confirmed.
    issuedCloseoutTarget.mockResolvedValue(null);
    await expect(run()).resolves.toMatchObject({ preview_changed: true });
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a closeout already started is disclosed as a resume; a probe that cannot read refuses the send', async () => {
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-1', serviceType: 'Mosquito', date: '2099-01-02', resuming: true });
    expect(effectText(await preview('send_invoice', { invoice_id: INV }), 'closeout')).toMatch(/^Sending this invoice also finishes a closeout already started/);
    issuedCloseoutTarget.mockRejectedValue(new Error('profile read failed'));
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'effects_check_failed' });
    issuedCloseoutTarget.mockResolvedValue(null);
    const card = await preview('send_invoice', { invoice_id: INV });
    expect(effectText(card, 'closeout')).toBeUndefined();
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

describe('round 3: lines', () => {
  test('every invoice line stays in the card payload; the first four show, the rest ride under "Show more", and the digest pins them', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ description: `Service line number ${i + 1} with a long description that used to be cut off at eighty characters, ending here ${i + 1}`, amount: 10 }));
    state.invoices[0].total = '70.00';
    state.invoices[0].line_items = JSON.stringify(items);
    const card = await preview('send_invoice', { invoice_id: INV });
    expect(card.lines).toHaveLength(7);
    expect(card.lines.join(' ')).not.toMatch(/\+\d+ more/);
    expect(card.lines[6]).toContain('ending here 7 $10.00');
    const contract = buildContract({ toolName: 'send_invoice', params: { invoice_id: INV }, displayParams: {}, preview: card });
    const shown = contract.effects.map((e) => e.label);
    expect(shown.filter((l) => /^Line \d of 7:/.test(l))).toHaveLength(4);
    expect(shown).toContain('All 7 invoice lines are listed; lines 5 on are under "Show more"');
    expect(contract.more_effects.map((e) => e.label)).toEqual([5, 6, 7].map((n) => expect.stringContaining(`Line ${n} of 7: Service line number ${n}`)));
    // Changing only a hidden line (same total) changes the approved version.
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    state.invoices[0].line_items = JSON.stringify(items.map((it, i) => (i === 6 ? { ...it, description: 'Other work' } : it)));
    await expect(run()).resolves.toMatchObject({ preview_changed: true });
  });
});

describe('round 4: one effects plan', () => {
  const claimedOnce = async (tool, versionKey) => {
    const { card, run } = await confirmWith(tool, { invoice_id: INV }, versionKey);
    return { card, run };
  };

  test('send: the card lists every post-delivery effect from the plan, pinned by one digest', async () => {
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: ['aaaaaaaa-0000-4000-8000-000000000001'] });
    Followups.planFollowupSequence.mockResolvedValue({ arms: true, state: 'autopay_hold', cadence: [3, 7, 14, 30] });
    const card = await preview('send_invoice', { invoice_id: INV });
    expect(card.effects.map((e) => e.key)).toEqual(['delivery', 'attachments', 'lead_conversion', 'followups', 'review', 'credit']);
    const lines = cardLines('send_invoice', card).map((l) => l.text);
    expect(lines).toEqual(expect.arrayContaining([
      'Sending this invoice also marks lead aaaaaaaa won',
      'Sending this invoice also arms billing reminders on Day 3, 7, 14, 30 unless Auto Pay or a payment plan suppresses them (currently: held: the customer is on Auto Pay)',
      'No review request is sent.',
    ]));
    expect(JSON.stringify(card)).not.toContain('aaaaaaaa-0000-4000-8000-000000000001');
    expect(card._version.effects).toMatch(/^[0-9a-f]{32}$/);
  });

  test.each([
    ['a lead appears', () => LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: ['aaaaaaaa-0000-4000-8000-000000000001'] })],
    ['the customer goes on Auto Pay', () => Followups.planFollowupSequence.mockResolvedValue({ arms: true, state: 'autopay_hold', cadence: [3, 7, 14, 30] })],
    ['a payment plan starts', () => Followups.planFollowupSequence.mockResolvedValue({ arms: false, state: 'payment_plan', cadence: [3, 7, 14, 30] })],
  ])('send: when %s after the card, Confirm refuses as preview_changed and sends nothing', async (_label, mutate) => {
    const { run } = await claimedOnce('send_invoice', '_verified_invoice_send_version');
    mutate();
    await expect(run()).resolves.toMatchObject({ preview_changed: true });
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('send: the claim\'s effects check recomputes the list on the claimed row and compares it with the card\'s digest', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    const { run } = await claimedOnce('send_invoice', '_verified_invoice_send_version');
    await run();
    const { verifyEffects } = Invoices.sendInvoiceFromBar.mock.calls[0][0].approvedSend.version;
    const claimed = { ...state.invoices[0], status: 'draft' };
    await expect(verifyEffects(claimed, db)).resolves.toBe(true);
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: ['aaaaaaaa-0000-4000-8000-000000000001'] });
    await expect(verifyEffects(claimed, db)).resolves.toBe(false);
  });
});

describe('round 5', () => {
  // Item 1: attachment writes touch only invoice_attachments, so the pin has to read that table.
  test('send: the card lists the attachments; one added, swapped or removed after the card refuses, and the claim\'s check sees it too', async () => {
    state.invoice_attachments = [{ id: 'att-1', invoice_id: INV, file_name: 'before.pdf', file_size_bytes: 10, updated_at: '2099-01-01T10:00:00Z' }];
    Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    const { card, run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    expect(effectText(card, 'attachments')).toBe('Attachments the customer can open from the online invoice: before.pdf');
    expect(cardLines('send_invoice', card).map((l) => l.text)).toContain('Attachments the customer can open from the online invoice: before.pdf');
    // An attachment added after the card: the confirmed run refuses before sending.
    state.invoice_attachments.push({ id: 'att-2', invoice_id: INV, file_name: 'extra.pdf', file_size_bytes: 20, updated_at: '2099-01-01T11:00:00Z' });
    await expect(run()).resolves.toMatchObject({ preview_changed: true });
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
    // Back to the approved set: the send runs, and the claim's own verify (run under the claim) reads the table again.
    state.invoice_attachments.pop();
    await run();
    const { verifyEffects } = Invoices.sendInvoiceFromBar.mock.calls[0][0].approvedSend.version;
    const claimed = { ...state.invoices[0], status: 'draft' };
    await expect(verifyEffects(claimed, db)).resolves.toBe(true);
    state.invoice_attachments[0] = { ...state.invoice_attachments[0], id: 'att-9' };
    await expect(verifyEffects(claimed, db)).resolves.toBe(false);
    state.invoice_attachments = [];
    await expect(verifyEffects(claimed, db)).resolves.toBe(false);
  });

  test('send: an invoice with no attachments says so on the card', async () => {
    const card = await preview('send_invoice', { invoice_id: INV });
    expect(effectText(card, 'attachments')).toBe('No attachments.');
  });
});

describe('round 6', () => {
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  // Item 2: the card shows the operator's own words, quoted; both are pinned.
  test('send: the card quotes the personal message and the notes verbatim, or says there are none', async () => {
    let card = await preview('send_invoice', { invoice_id: INV });
    expect(cardLines('send_invoice', card).map((l) => l.text)).toContain('No personal message. No notes.');
    state.invoices[0].email_message = 'Thanks for choosing us, Robin!';
    state.invoices[0].notes = 'Treated the lanai "twice".';
    card = await preview('send_invoice', { invoice_id: INV });
    const lines = cardLines('send_invoice', card).map((l) => l.text);
    expect(lines).toContain('Personal message in the email: "Thanks for choosing us, Robin!"');
    expect(lines).toContain('Notes on the invoice and PDF: "Treated the lanai "twice"."');
    expect(lines).not.toContain('No personal message. No notes.');
  });

  test('send: both fields are in the approved version digest, and an edit after the card refuses the confirmed send', async () => {
    const { approvedInvoiceVersionDigest } = require('../services/invoice-helpers');
    const base = approvedInvoiceVersionDigest(state.invoices[0]);
    expect(approvedInvoiceVersionDigest({ ...state.invoices[0], email_message: 'hi' })).not.toBe(base);
    expect(approvedInvoiceVersionDigest({ ...state.invoices[0], notes: 'hi' })).not.toBe(base);
    state.invoices[0].notes = 'First draft';
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    state.invoices[0].notes = 'Second draft';
    await expect(run()).resolves.toMatchObject({ preview_changed: true });
    expect(Invoices.sendInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('send: a message or notes longer than 600 characters refuses the card instead of cutting it', async () => {
    state.invoices[0].email_message = 'x'.repeat(601);
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'invoice_copy_too_long', error: expect.stringMatching(/send it from the Invoices page/) });
    state.invoices[0].email_message = 'x'.repeat(600);
    state.invoices[0].notes = 'y'.repeat(601);
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'invoice_copy_too_long' });
    state.invoices[0].notes = 'y'.repeat(600);
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ preview: true });
  });

  // Item 1: the attachment fence has two halves.
  test('send: the approved attachment digest rides to the email leg, which refuses a different list right before the provider call (source contract)', () => {
    expect(read('../services/invoice.js')).toMatch(/expectedVersion && expectedVersion\.attachments !== undefined \? \{ expectedAttachments: expectedVersion\.attachments \}/);
    const email = read('../services/invoice-email.js');
    expect(email).toMatch(/options\.expectedAttachments !== undefined && attachmentsFingerprintDigest\(attachmentRows\) !== options\.expectedAttachments/);
    expect(email.indexOf('attachmentsFingerprintDigest(attachmentRows) !== options.expectedAttachments')).toBeLessThan(email.indexOf('sendgrid.isConfigured()'));
  });
});

describe('round 7: who owes the invoice, and the closeout target', () => {
  // The invoice's payer columns are a snapshot from when it was minted: a payer assigned afterwards leaves both empty,
  // and only the live resolver sees it.
  test.each([
    ['a payer assigned after the invoice was minted (both payer columns empty)', 'payer_owned', /billed to a payer/, 'payer_owned'],
    ['an ownership answer that cannot be verified', 'payer_unverifiable', /could not verify who owes this invoice/, 'payer_owned'],
  ])('the card refuses %s', async (_label, verdict, message, code) => {
    invoicePayerOwnership.mockResolvedValue(verdict);
    expect(state.invoices[0].payer_id).toBeNull();
    expect(state.invoices[0].payer_statement_id).toBeNull();
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code, error: expect.stringMatching(message) });
    expect(Invoices.getInvoiceDeliveryRecipients).not.toHaveBeenCalled();
  });

  test('a resolver that throws is an unverifiable answer: the card refuses', async () => {
    invoicePayerOwnership.mockRejectedValue(new Error('payer tables unreadable'));
    await expect(preview('send_invoice', { invoice_id: INV })).resolves.toMatchObject({ code: 'payer_owned', error: expect.stringMatching(/could not verify who owes this invoice/) });
  });

  test('the resolver is asked about the invoice row, and a customer-owned answer builds the card', async () => {
    const card = await preview('send_invoice', { invoice_id: INV });
    expect(card.preview).toBe(true);
    expect(invoicePayerOwnership).toHaveBeenCalledWith(expect.objectContaining({ id: INV, customer_id: 'cust-1' }), db);
  });

  test('the send claim asks again on the claimed row: it passes a customer, and refuses a payer or an unreadable answer', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    const { run } = await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version');
    await run();
    const { verifyOwner } = Invoices.sendInvoiceFromBar.mock.calls[0][0].approvedSend.version;
    const claimed = { ...state.invoices[0], status: 'draft' };
    await expect(verifyOwner(claimed, db)).resolves.toBeNull();
    invoicePayerOwnership.mockResolvedValue('payer_owned');
    await expect(verifyOwner(claimed, db)).resolves.toMatch(/billed to a payer/);
    invoicePayerOwnership.mockResolvedValue('payer_unverifiable');
    await expect(verifyOwner(claimed, db)).resolves.toMatch(/could not verify who owes this invoice/);
    invoicePayerOwnership.mockRejectedValue(new Error('unreadable'));
    await expect(verifyOwner(claimed, db)).resolves.toMatch(/could not verify who owes this invoice/);
  });

  test('the visit the card said would close (or none) is handed to the send as the approved closeout target', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    let run = (await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version')).run;
    await run();
    expect(Invoices.sendInvoiceFromBar.mock.calls[0][0].approvedSend.version.closeoutTarget).toBe('none');
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-9', serviceType: 'Pest', date: '2099-01-02', resuming: false });
    run = (await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version')).run;
    await run();
    expect(Invoices.sendInvoiceFromBar.mock.calls[1][0].approvedSend.version.closeoutTarget).toBe('visit-9');
  });

  test('round 8: the leads the card named are handed to the send as an opaque set digest (or none), never as ids', async () => {
    Invoices.sendInvoiceFromBar.mockResolvedValue({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    let run = (await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version')).run;
    await run();
    expect(Invoices.sendInvoiceFromBar.mock.calls[0][0].approvedSend.version.leadTargets).toBe('none');
    const LEAD = 'aaaaaaaa-0000-4000-8000-000000000001';
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [LEAD] });
    run = (await confirmWith('send_invoice', { invoice_id: INV }, '_verified_invoice_send_version')).run;
    await run();
    const { leadTargets } = Invoices.sendInvoiceFromBar.mock.calls[1][0].approvedSend.version;
    expect(leadTargets).toBe(require('../services/invoice-helpers').leadSetDigest([LEAD]));
    expect(leadTargets).not.toContain(LEAD);
  });
});
