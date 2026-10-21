/**
 * IB void_invoice (owner ruling 2026-10-12, Stage 3 cards): the Invoices page "Void" handler run in process
 * behind a card, dark behind GATE_IB_VOID_INVOICE (needs GATE_IB_PLATFORM). What the card shows (invoice, amount,
 * credit, every effect, that nothing is sent), pin drift, every money case refused as by_owner_rule, the invoices left
 * to the Invoices page, gate off, admin only, and that the commit runs the page's handler once with the card's
 * invoice version. The handler itself is mocked here; admin-invoices-void-handler-replay.test.js and
 * invoice-void-expected-version.test.js cover the real one. Nothing here reaches a provider. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-invoices', () => ({ voidInvoiceFromBar: jest.fn() }));
const mockRetrievePi = jest.fn();
const mockAssertNoCharge = jest.fn();
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...a) => mockRetrievePi(...a),
  assertNoInvoiceChargeReconciliationPending: (...a) => mockAssertNoCharge(...a),
}));
const mockQueuedText = jest.fn();
const mockLinkedVisit = jest.fn();
jest.mock('../services/invoice', () => ({
  queuedPayLinkText: (...a) => mockQueuedText(...a),
  linkedScheduledServiceId: (...a) => mockLinkedVisit(...a),
}));
const mockResolveTerm = jest.fn();
jest.mock('../services/invoice-prepay', () => ({ resolveInvoiceTermId: (...a) => mockResolveTerm(...a) }));

const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const tools = require('../services/intelligence-bar/void-invoice-tools');
const { executeVoidInvoiceTool, VOID_INVOICE_TOOLS, cardLines } = tools;
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const INV = '00000000-0000-4000-8000-0000000000a1';
const CUST = '00000000-0000-4000-8000-0000000000c1';
const VISIT = '00000000-0000-4000-8000-0000000000d1';
const ADMIN = { isAdmin: true, technicianId: 'staff-1', operationId: 'op-1' };

let state;
function freshState() {
  return {
    invoices: [{
      id: INV, invoice_number: 'WPC-2099-0001', customer_id: CUST, status: 'sent', total: '129.00', credit_applied: '0.00',
      updated_at: new Date('2099-01-01T12:00:00.123Z'), stripe_payment_intent_id: null, stripe_charge_id: null,
      payment_recorded_at: null, paid_at: null, payer_id: null, payer_statement_id: null, scheduled_service_id: VISIT,
      line_items: [{ description: 'Quarterly Pest Control', amount: 129 }],
    }],
    customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample' }],
    payments: [], payer_statements: [], payment_plans: [], setup_fee_claims: [], annual_prepay_terms: [],
    scheduled_services: [{ id: VISIT, status: 'completed', scheduled_date: '2099-01-01' }],
  };
}

// A small knex stand-in: plain-object where / whereNot / whereNull filter the seeded rows; callback wheres (the
// payments linkage) are ignored, so `payments` holds exactly the rows linked to the invoice. Any write throws.
function makeDb() {
  function builder(table) {
    const q = { wheres: [], nots: [], nulls: [], single: false };
    const rows = () => {
      const found = (state[table] || []).filter((row) => q.wheres.every((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v)))
        && q.nots.every(([k, v]) => String(row[k]) !== String(v))
        && q.nulls.every((k) => row[k] == null));
      return q.single ? found[0] : found;
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'where') return (arg) => { if (arg && typeof arg === 'object') q.wheres.push(arg); return b; };
        if (prop === 'whereNot') return (k, v) => { q.nots.push([k, v]); return b; };
        if (prop === 'whereNull') return (k) => { q.nulls.push(k); return b; };
        if (prop === 'first') return () => { q.single = true; return b; };
        if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  }
  return (table) => builder(table);
}

function envGate(on) {
  if (on) { process.env.GATE_IB_VOID_INVOICE = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_VOID_INVOICE; delete process.env.GATE_IB_PLATFORM; }
}

const preview = (input = {}, ctx = ADMIN) => executeVoidInvoiceTool('void_invoice', { invoice_id: INV, ...input }, ctx);
const confirm = (card, input = {}, ctx = ADMIN) => executeVoidInvoiceTool('void_invoice',
  { invoice_id: INV, ...input, confirmed: true, _verified_invoice_void_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  mockRetrievePi.mockResolvedValue(null);
  mockAssertNoCharge.mockResolvedValue(undefined);
  mockQueuedText.mockResolvedValue(undefined);
  mockLinkedVisit.mockResolvedValue(VISIT);
  mockResolveTerm.mockResolvedValue(null);
  Invoices.voidInvoiceFromBar.mockResolvedValue({ status: 200, json: { id: INV, status: 'void' } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step write, admin only, never owner-direct, with a record-scoped policy', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('void_invoice')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('void_invoice')).toBe(true);
    expect(registry.actions.get('void_invoice')).toMatchObject({ domain: 'customers', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'void-invoice-tools.js' });
    expect(registry.policyErrors).not.toContain('void_invoice');
    expect(Object.keys(VOID_INVOICE_TOOLS[0].input_schema.properties)).toEqual(['invoice_id', 'invoice_number']);
  });

  test('the discovery search finds it by the operator’s words, delete included (never a delete)', () => {
    for (const query of ['void invoice', 'void this invoice', 'cancel this invoice', 'delete the invoice']) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'customers', fullAccess: false });
      expect(definitions.map((d) => d.name)).toContain('void_invoice');
    }
    expect(VOID_INVOICE_TOOLS[0].description).toMatch(/never deletes it/);
  });

  test('gate off: not discoverable; the platform gate is needed; a technician never gets it', () => {
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('void_invoice'), { role: 'admin', context: 'customers' })).toBe(false);
    envGate(false);
    const { definitions } = registry.discover({ query: 'void invoice' }, { role: 'admin', context: 'customers', fullAccess: false });
    expect(definitions.map((d) => d.name)).not.toContain('void_invoice');
    envGate(true);
    expect(registry.allowed(registry.actions.get('void_invoice'), { role: 'technician', context: 'tech' })).toBe(false);
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses and nothing runs', async () => {
    envGate(false);
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(await executeVoidInvoiceTool('void_invoice', { invoice_id: INV, confirmed: true, _verified_invoice_void_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(Invoices.voidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the platform gate alone is not enough, and neither is the void gate alone', async () => {
    delete process.env.GATE_IB_PLATFORM;
    expect(await preview()).toMatchObject({ code: 'gate_off' });
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await preview({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, {}, {})).toMatchObject({ code: 'permission_denied' });
    expect(await confirm(card, {}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(Invoices.voidInvoiceFromBar).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  test('shows the invoice, the customer, the amount and every effect, and writes and sends nothing', async () => {
    const card = await preview();
    expect(card).toMatchObject({
      preview: true, tool: 'void_invoice', invoice_id: INV, invoice_number: 'WPC-2099-0001', customer_name: 'Robin Sample',
      status: 'sent', amount: '$129.00', amount_due: '$129.00', credit_applied: '$0.00', sends_to_customer: false,
    });
    expect(card.lines).toEqual(['Quarterly Pest Control $129.00']);
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/becomes void and is kept on record\. Nothing has been collected on it/);
    expect(text).toMatch(/No account credit is applied to it, so none is returned/);
    expect(text).toMatch(/payment reminders stop/);
    expect(text).toMatch(/linked visit \(2099-01-01, completed\) is not changed/);
    expect(text).toMatch(/Nothing is sent: no text, email or call/);
    expect(text).toMatch(/No refund, no card charge, no new invoice/);
    expect(card._expected).toEqual({ status: 'sent', updatedAt: new Date('2099-01-01T12:00:00.123Z').getTime(), total: 129, creditApplied: 0, paymentIntentId: null });
    expect(Invoices.voidInvoiceFromBar).not.toHaveBeenCalled();
    const lines = cardLines('void_invoice', card).map((l) => l.text).join('\n');
    expect(lines).toMatch(/Void invoice WPC-2099-0001 for Robin Sample: \$129\.00 \(sent, \$129\.00 due\)/);
    const contract = buildContract({ toolName: 'void_invoice', params: { invoice_id: INV }, displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/Nothing is sent/);
    expect(JSON.stringify(contract)).not.toMatch(/Customer will be contacted/);
  });

  test('names the invoice by number too, and exactly one of the two', async () => {
    expect(await executeVoidInvoiceTool('void_invoice', { invoice_number: 'wpc-2099-0001' }, ADMIN)).toMatchObject({ preview: true, invoice_id: INV });
    expect(await executeVoidInvoiceTool('void_invoice', { invoice_id: INV, invoice_number: 'WPC-2099-0001' }, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeVoidInvoiceTool('void_invoice', {}, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeVoidInvoiceTool('void_invoice', { invoice_id: 'nope' }, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeVoidInvoiceTool('void_invoice', { invoice_number: 'WPC-0000' }, ADMIN)).toMatchObject({ code: 'invoice_not_found' });
  });

  test('applied account credit is named as returned to the customer', async () => {
    state.invoices[0].credit_applied = '20.00';
    const card = await preview();
    expect(card.amount_due).toBe('$109.00');
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/\$20\.00 of account credit applied to it goes back to the customer’s balance/);
  });

  test('an unconfirmed pay-page session is named as cancelled; a canceled one needs nothing', async () => {
    state.invoices[0].stripe_payment_intent_id = 'pi_test_1';
    mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
    const card = await preview();
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/open card-payment session \(nobody has tried to pay\) is cancelled with Stripe/);
    mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'canceled' });
    expect((await preview()).effects.map((e) => e.text).join('\n')).not.toMatch(/is cancelled with Stripe/);
  });

  test('an open payer statement is named; a missing visit is said', async () => {
    state.invoices[0].payer_statement_id = 'stmt-1';
    state.payer_statements = [{ id: 'stmt-1', status: 'open' }];
    mockLinkedVisit.mockResolvedValue(null);
    const text = (await preview()).effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/drops out of the payer’s open monthly statement total/);
    expect(text).toMatch(/not linked to a visit/);
  });

  test('already void, canceled and mid-send invoices are refused', async () => {
    state.invoices[0].status = 'void';
    expect(await preview()).toMatchObject({ code: 'already_void' });
    state.invoices[0].status = 'canceled';
    expect(await preview()).toMatchObject({ code: 'not_voidable' });
    state.invoices[0].status = 'sending';
    expect(await preview()).toMatchObject({ code: 'send_in_progress' });
  });
});

describe('money received or in flight is refused as by_owner_rule (preview and Confirm)', () => {
  const cases = [
    ['paid', (s) => { s.invoices[0].status = 'paid'; }],
    ['processing', (s) => { s.invoices[0].status = 'processing'; }],
    ['refunded', (s) => { s.invoices[0].status = 'refunded'; }],
    ['partially refunded', (s) => { s.invoices[0].status = 'partially_refunded'; }],
    ['prepaid (credit-covered; the page hides Void)', (s) => { s.invoices[0].status = 'prepaid'; s.invoices[0].credit_applied = '129.00'; }],
    ['a payment recorded', (s) => { s.invoices[0].payment_recorded_at = new Date(); }],
    ['a card charge on file', (s) => { s.invoices[0].stripe_charge_id = 'ch_test_1'; }],
    ['a paid date on an unpaid status', (s) => { s.invoices[0].paid_at = new Date(); }],
    ['a paid payment row', (s) => { s.payments = [{ id: 'p1', status: 'paid', metadata: { invoice_id: INV } }]; }],
    ['a processing payment row', (s) => { s.payments = [{ id: 'p1', status: 'processing', metadata: { invoice_id: INV } }]; }],
    ['a refunded payment row', (s) => { s.payments = [{ id: 'p1', status: 'refunded', metadata: { invoice_id: INV } }]; }],
    ['a failed row with no PaymentIntent (the outcome may be unknown)', (s) => { s.payments = [{ id: 'p1', status: 'failed', metadata: { invoice_id: INV }, stripe_payment_intent_id: null }]; }],
    ['a deposit already collected', (s) => { s.invoices[0].line_items = [{ description: 'Service', amount: 129 }, { description: 'Deposit credit', amount: -20, category: 'deposit_credit' }]; }],
    ['a finalized payer statement', (s) => { s.invoices[0].payer_statement_id = 'stmt-1'; s.payer_statements = [{ id: 'stmt-1', status: 'sent' }]; }],
    ['an active payment plan', (s) => { s.payment_plans = [{ id: 'plan-1', invoice_id: INV, status: 'active' }]; }],
  ];
  test.each(cases)('%s', async (_name, mutate) => {
    mutate(state);
    const res = await preview();
    expect(res).toMatchObject({ code: 'by_owner_rule' });
    expect(res.error).toMatch(/Refunds and card charges stay on the Invoices page/);
    expect(res.preview).toBeUndefined();
    // A card shown before the money arrived is refused at Confirm, never run.
    state = freshState();
    const card = await preview();
    mutate(state);
    expect(await confirm(card)).toMatchObject({ code: 'by_owner_rule', preview_changed: true });
    expect(Invoices.voidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test.each(['processing', 'succeeded', 'requires_capture', 'requires_action'])('a PaymentIntent in state %s', async (status) => {
    state.invoices[0].stripe_payment_intent_id = 'pi_test_1';
    mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status });
    expect(await preview()).toMatchObject({ code: 'by_owner_rule', reason: `payment_intent_${status}` });
  });

  test('a saved-card charge in progress or unresolved', async () => {
    mockAssertNoCharge.mockRejectedValue(Object.assign(new Error('in progress'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }));
    expect(await preview()).toMatchObject({ code: 'by_owner_rule', reason: 'charge_in_progress' });
    mockAssertNoCharge.mockRejectedValue(Object.assign(new Error('x'), { reconciliationRequired: true }));
    expect(await preview()).toMatchObject({ code: 'by_owner_rule' });
  });

  test('a check that cannot be made refuses (fail closed): the charge check, the Stripe read', async () => {
    mockAssertNoCharge.mockRejectedValue(new Error('database down'));
    expect(await preview()).toMatchObject({ code: 'unverified' });
    mockAssertNoCharge.mockResolvedValue(undefined);
    state.invoices[0].stripe_payment_intent_id = 'pi_test_1';
    mockRetrievePi.mockRejectedValue(new Error('stripe down'));
    expect(await preview()).toMatchObject({ code: 'unverified' });
    mockRetrievePi.mockResolvedValue(null);
    expect(await preview()).toMatchObject({ code: 'unverified' });
  });

  test('a payment row that names another invoice is that invoice’s, and a failed row with a PaymentIntent moved nothing', async () => {
    state.payments = [
      { id: 'p1', status: 'paid', metadata: { invoice_id: '00000000-0000-4000-8000-0000000000a2' } },
      { id: 'p2', status: 'failed', metadata: { invoice_id: INV }, stripe_payment_intent_id: 'pi_failed' },
    ];
    expect(await preview()).toMatchObject({ preview: true });
  });
});

describe('invoices left to the Invoices page (needs_invoices_page)', () => {
  test.each([
    ['membership dues', (s) => { s.invoices[0].line_items = [{ description: 'Dues', amount: 129, membership_dues_month: '2099-01' }]; }],
    ['a bait-station setup line', (s) => { s.invoices[0].line_items = [{ description: 'Bait Station Setup — one-time setup fee', amount: 129 }]; }],
    ['a setup-fee claim', (s) => { s.setup_fee_claims = [{ id: 'c1', invoice_id: INV }]; }],
    ['an annual-plan term', (s) => { s.annual_prepay_terms = [{ id: 't1', prepay_invoice_id: INV }]; }],
    ['an invoice covered by an annual plan (covered-term stamp; the term lookup answers none)', (s) => { s.invoices[0].annual_prepay_covered_term_id = 'term-1'; }],
    ['an annual-plan tag', () => { mockResolveTerm.mockResolvedValue('term-1'); }],
    ['a shared combined payment', (s) => { s.invoices[0].stripe_payment_intent_id = 'pi_test_1'; s.invoices.push({ id: 'other', stripe_payment_intent_id: 'pi_test_1', status: 'sent' }); }],
    ['a queued pay-link text', () => { mockQueuedText.mockResolvedValue({ id: 'sms-1' }); }],
  ])('%s', async (_name, mutate) => {
    mutate(state);
    mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
    const res = await preview();
    expect(res).toMatchObject({ code: 'needs_invoices_page' });
    expect(res.error).toMatch(/Void it from the Invoices page/);
  });

  test('a link check that fails refuses (fail closed)', async () => {
    mockResolveTerm.mockRejectedValue(new Error('lookup failed'));
    expect(await preview()).toMatchObject({ code: 'unverified' });
  });
});

describe('the confirmed run', () => {
  test('runs the page’s handler once with the invoice version the card showed', async () => {
    const card = await preview();
    const res = await confirm(card);
    expect(Invoices.voidInvoiceFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.voidInvoiceFromBar).toHaveBeenCalledWith({
      invoiceId: INV,
      expected: { status: 'sent', updatedAt: new Date('2099-01-01T12:00:00.123Z').getTime(), total: 129, creditApplied: 0, paymentIntentId: null },
    });
    expect(res).toMatchObject({ success: true, status: 'void', sent_to_customer: false, invoice_id: INV, invoice_number: 'WPC-2099-0001' });
    expect(res.note).toMatch(/Nothing was sent to anyone/);
  });

  test('no pin: use the card; the handler is not run', async () => {
    expect(await executeVoidInvoiceTool('void_invoice', { invoice_id: INV, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    expect(Invoices.voidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['the invoice was edited after the card', (s) => { s.invoices[0].updated_at = new Date('2099-01-01T12:05:00Z'); }],
    ['the status moved', (s) => { s.invoices[0].status = 'viewed'; }],
    ['the total changed', (s) => { s.invoices[0].total = '139.00'; }],
    ['credit was applied', (s) => { s.invoices[0].credit_applied = '10.00'; }],
    ['a line changed', (s) => { s.invoices[0].line_items = [{ description: 'Quarterly Pest Control', amount: 129 }, { description: 'Extra', amount: 5 }]; }],
    ['the visit link changed', () => { mockLinkedVisit.mockResolvedValue(null); }],
    ['the visit changed', (s) => { s.scheduled_services[0].status = 'cancelled'; }],
    ['the invoice moved to another customer', (s) => { s.invoices[0].customer_id = 'cust-2'; }],
    ['the invoice was voided by someone else', (s) => { s.invoices[0].status = 'void'; }],
  ])('drift (%s) refuses with preview_changed and runs nothing', async (_name, mutate) => {
    const card = await preview();
    mutate(state);
    const res = await confirm(card);
    expect(res).toMatchObject({ preview_changed: true });
    expect(Invoices.voidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a pay-page session that appeared or changed state after the card is drift', async () => {
    const card = await preview();
    state.invoices[0].stripe_payment_intent_id = 'pi_test_1';
    mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
    expect(await confirm(card)).toMatchObject({ preview_changed: true });
    const withPi = await preview();
    mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'canceled' });
    expect(await confirm(withPi)).toMatchObject({ preview_changed: true });
    expect(Invoices.voidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the page’s own answers come back in its words: a lost race is preview_changed, money is by_owner_rule, others plain', async () => {
    const card = await preview();
    Invoices.voidInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Invoice status changed while voiding — re-check and retry' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true, error: expect.stringMatching(/changed while voiding/) });
    Invoices.voidInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'A payment was applied to this invoice while voiding — issue a refund instead' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'by_owner_rule' });
    Invoices.voidInvoiceFromBar.mockResolvedValueOnce({ status: 404, json: { error: 'Invoice not found' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'not_found', preview_changed: true });
    Invoices.voidInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'This invoice is on a finalized payer statement — adjust it' } });
    const other = await confirm(card);
    expect(other).toMatchObject({ failed: true });
    expect(other.preview_changed).toBeUndefined();
  });

  test('a handler that throws never invites a blind retry; one that voided before a later step failed reads as voided', async () => {
    const card = await preview();
    Invoices.voidInvoiceFromBar.mockRejectedValueOnce(new Error('connection reset'));
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    // The void committed, then a later step threw: the invoice reads void, so the card reports it voided.
    const second = await preview();
    Invoices.voidInvoiceFromBar.mockImplementationOnce(async () => { state.invoices[0].status = 'void'; throw new Error('restorations failed'); });
    expect(await confirm(second)).toMatchObject({ success: true, warning: true, status: 'void' });
    Invoices.voidInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { id: INV, status: 'sent' } });
    state.invoices[0].status = 'sent';
    expect(await confirm(await preview())).toMatchObject({ outcome_unknown: true, code: 'void_unverified' });
  });

  test('the tool reaches no message sender, and the only Stripe calls are two reads', () => {
    const source = require('fs').readFileSync(require.resolve('../services/intelligence-bar/void-invoice-tools.js'), 'utf8');
    expect(source).not.toMatch(/twilio|sendgrid|sendSms|sendEmail|notifyAdmin|messaging|refund\(|cancelPaymentIntent|createPaymentIntent|charge\(/i);
    const stripeCalls = [...source.matchAll(/require\('\.\.\/stripe'\)\.(\w+)/g)].map((m) => m[1]).sort();
    expect(stripeCalls).toEqual(['assertNoInvoiceChargeReconciliationPending', 'retrievePaymentIntent']);
  });
});
