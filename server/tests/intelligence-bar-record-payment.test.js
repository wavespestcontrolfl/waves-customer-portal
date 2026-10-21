/**
 * IB record_payment (owner ruling 2026-10-12): the Invoices page "Record payment" handler run in process
 * behind a card, dark behind GATE_IB_RECORD_PAYMENT (needs GATE_IB_PLATFORM). What the card shows (invoice,
 * customer, balance, method, every change, whether a receipt goes out), the refusals (over-balance, partial,
 * paid / void / statement / payer-owned / annual-plan invoices, card methods, refunds, other dates), pin
 * drift, gate off, admin only, and that the commit runs the page's handler once with exactly the carded
 * body and the pins. The handler itself is mocked here; admin-invoices-record-payment-bar-replay.test.js
 * runs the real one. Nothing here reaches a provider. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-manual-payment', () => ({
  VALID_PAYMENT_METHODS: ['cash', 'check', 'zelle', 'venmo', 'paypal', 'other'],
}));
jest.mock('../routes/admin-invoices', () => ({ recordPaymentFromBar: jest.fn(), getInvoiceDeliveryRecipients: jest.fn() }));
jest.mock('../services/invoice-email', () => ({ resolveReceiptEmailRecipient: jest.fn() }));
jest.mock('../services/open-balance', () => ({ rowIsSelfPayDue: jest.fn() }));
jest.mock('../services/invoice-prepay', () => ({ resolveInvoiceTermId: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ issuedCloseoutTarget: jest.fn(), visitJobTimerRunning: jest.fn(async () => false) }));

const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const { resolveReceiptEmailRecipient } = require('../services/invoice-email');
const { rowIsSelfPayDue } = require('../services/open-balance');
const { resolveInvoiceTermId } = require('../services/invoice-prepay');
const { issuedCloseoutTarget, visitJobTimerRunning } = require('../services/invoice-issued-closeout');
const { etDateString } = require('../utils/datetime-et');
const tools = require('../services/intelligence-bar/record-payment-tools');
const { executeRecordPaymentTool, RECORD_PAYMENT_TOOLS, cardLines } = tools;
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const INV = '00000000-0000-4000-8000-0000000000a1';
const CUST = '00000000-0000-4000-8000-0000000000c1';
const ADMIN = { isAdmin: true, technicianId: 'staff-1', operationId: 'op-1' };
const EDITED = new Date('2099-01-01T12:00:00.123Z');

let state;
function freshState() {
  return {
    invoices: [{
      id: INV, invoice_number: 'WPC-2099-0001', customer_id: CUST, status: 'sent', total: '117.00', credit_applied: '0',
      payer_id: null, payer_statement_id: null, scheduled_service_id: null, stripe_payment_intent_id: null,
      service_record_id: null, visit_completion_packet_id: null, updated_at: EDITED,
    }],
    customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample', phone: '(941) 555-0142' }],
    scheduled_services: [],
    projects: [],
    technicians: [{ id: 'staff-1', name: 'Ava Admin', email: 'ava@example.test' }],
  };
}

// A small knex stand-in: plain-object where filters the seeded rows. Any write throws.
function makeDb() {
  return (table) => {
    const q = { wheres: [], ins: [], single: false };
    const rows = () => {
      const found = (state[table] || []).filter((row) => q.wheres.every((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v)))
        && q.ins.every(([k, vals]) => vals.includes(row[k])));
      return q.single ? found[0] : found;
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'where') return (arg) => { if (arg && typeof arg === 'object') q.wheres.push(arg); return b; };
        if (prop === 'whereIn') return (k, vals) => { q.ins.push([k, vals]); return b; };
        if (prop === 'first') return () => { q.single = true; return b; };
        if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  };
}

function envGate(on) {
  if (on) { process.env.GATE_IB_RECORD_PAYMENT = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_RECORD_PAYMENT; delete process.env.GATE_IB_PLATFORM; }
}

const BASE = { invoice_id: INV, amount: 117, method: 'check', reference: '1042' };
const preview = (input = {}, ctx = ADMIN) => executeRecordPaymentTool('record_payment', { ...BASE, ...input }, ctx);
const confirm = (card, input = {}, ctx = ADMIN) => executeRecordPaymentTool('record_payment',
  { ...BASE, ...input, confirmed: true, _verified_record_payment_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  rowIsSelfPayDue.mockResolvedValue(true);
  resolveInvoiceTermId.mockResolvedValue(null);
  issuedCloseoutTarget.mockResolvedValue(null);
  resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'Robin@Example.test' } });
  Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({
    payerBilled: false, emailRecipient: { email: 'robin@example.test' }, smsRecipient: { phone: '+19415550142' },
  });
  Invoices.recordPaymentFromBar.mockResolvedValue({ status: 200, json: { ok: true, invoice: { id: INV, status: 'paid' }, receipt: null } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step external action: admin only, never owner-direct, customers domain, record scope', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('record_payment')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('record_payment')).toBe(true);
    const action = registry.actions.get('record_payment');
    expect(action).toMatchObject({ domain: 'customers', kind: 'external_action', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'record-payment-tools.js' });
    expect(registry.policyErrors).not.toContain('record_payment');
    expect(Object.keys(RECORD_PAYMENT_TOOLS[0].input_schema.properties)).not.toContain('confirmed');
    expect(require('../services/intelligence-bar/owner-direct')).toBeDefined();
  });

  test('the discovery search finds it by the operator’s words', () => {
    for (const query of ['record a payment', 'mark paid by check', 'customer paid cash']) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'customers', fullAccess: false });
      expect(definitions.map((d) => d.name)).toContain('record_payment');
    }
  });

  test('the customers, Invoices and dashboard pages offer it while the gate is on; no page does with it off', () => {
    for (const page of ['customers', 'revenue', 'dashboard']) {
      expect(registry.initialTools(page, { role: 'admin', fullAccess: false }).map((t) => t.name)).toContain('record_payment');
    }
    envGate(false);
    for (const page of ['customers', 'revenue', 'dashboard']) {
      expect(registry.initialTools(page, { role: 'admin', fullAccess: false }).map((t) => t.name)).not.toContain('record_payment');
    }
    const { definitions } = registry.discover({ query: 'record a payment' }, { role: 'admin', context: 'customers', fullAccess: false });
    expect(definitions.map((d) => d.name)).not.toContain('record_payment');
  });

  test('it needs the platform gate, and a technician never gets it', () => {
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('record_payment'), { role: 'admin', context: 'customers' })).toBe(false);
    envGate(true);
    expect(registry.allowed(registry.actions.get('record_payment'), { role: 'technician', context: 'tech' })).toBe(false);
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses and nothing is run', async () => {
    envGate(false);
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(await executeRecordPaymentTool('record_payment', { ...BASE, confirmed: true, _verified_record_payment_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });

  test('the record gate alone is not enough: it needs the platform gate', async () => {
    delete process.env.GATE_IB_PLATFORM;
    expect(await preview()).toMatchObject({ code: 'gate_off' });
  });

  test('a technician is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await preview({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, {}, { technicianId: 'staff-1' })).toMatchObject({ code: 'permission_denied' });
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });

  test('a confirmed call with no card pin is refused', async () => {
    const res = await executeRecordPaymentTool('record_payment', { ...BASE, confirmed: true }, ADMIN);
    expect(res).toMatchObject({ code: 'approval_required' });
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  test('names the invoice, the customer, the balance, the method and every change; writes nothing and sends nothing', async () => {
    const card = await preview({ note: 'check left at the office' });
    expect(card).toMatchObject({
      preview: true, tool: 'record_payment', invoice_number: 'WPC-2099-0001', customer_name: 'Robin Sample',
      balance_due: 117, amount: 117, method: 'check', reference: '1042', payment_date: etDateString(), sends_to_customer: false,
      receipt: 'No receipt is sent',
    });
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/→ paid, \$117\.00 by check, reference 1042/);
    expect(text).toMatch(/No card is charged, no Stripe payment is created, and nothing is refunded or voided/);
    expect(text).toMatch(/Nothing is sent to the customer/);
    expect(text).toMatch(/check left at the office/);
    expect(text).toMatch(/reminder sequence stops/);
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });

  test('the body is the page’s body: method, reference, note, an explicit sendReceipt false and no via', async () => {
    const card = await preview({ note: 'n' });
    expect(card._body).toEqual({ method: 'check', reference: '1042', note: 'n', sendReceipt: false });
    expect(card._approved).toEqual({ expectedAmountCents: 11700, settlementFence: expect.any(Function) });
  });

  test('a balance net of account credit is the amount due', async () => {
    state.invoices[0].credit_applied = '17.00';
    expect(await preview({ amount: 100 })).toMatchObject({ balance_due: 100, amount: 100 });
    expect(await preview({ amount: 117 })).toMatchObject({ code: 'amount_exceeds_balance' });
  });

  test('a receipt is named, with masked recipients and the channels the page would use; it is a customer message', async () => {
    const card = await preview({ send_receipt: true });
    expect(card).toMatchObject({ sends_to_customer: true, receipt: 'Receipt sent now by email and text' });
    expect(card._body).toEqual({ method: 'check', reference: '1042', sendReceipt: true, via: 'both' });
    const comms = card.effects.find((e) => e.kind === 'comms').text;
    expect(comms).toMatch(/email to r\*\*\*@example\.test and text to \*\*\*0142/);
    expect(comms).not.toMatch(/robin@example\.test|9415550142/);
    const contract = buildContract({ toolName: 'record_payment', params: { ...BASE, send_receipt: true }, preview: card, summary: 'x' });
    expect(contract.notifies_customer).toBe(true);
    expect(contract.irreversible).toBe(true);
  });

  test('email only or text only follows what the invoice has', async () => {
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ payerBilled: false, emailRecipient: { email: 'robin@example.test' }, smsRecipient: null });
    expect((await preview({ send_receipt: true }))._body.via).toBe('email');
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ payerBilled: false, emailRecipient: null, smsRecipient: { phone: '+19415550142' } });
    expect((await preview({ send_receipt: true }))._body.via).toBe('sms');
  });

  test('the card names and pins the senders’ own destinations, not the page’s: a page email the sender does not resolve is not promised', async () => {
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: false, error: 'No receipt recipient email' });
    const card = await preview({ send_receipt: true });
    const comms = card.effects.find((e) => e.kind === 'comms').text;
    expect(comms).toMatch(/text to \*\*\*0142/);
    expect(comms).not.toMatch(/email to/);
    state.customers[0].phone = null;
    expect(await preview({ send_receipt: true })).toMatchObject({ code: 'no_receipt_contact' });
  });

  describe('an automatic receipt job already owns the invoice\'s receipt (Codex r5: closed structurally, never claimed under the card)', () => {
    test.each(['queued', 'retry_scheduled', 'running'])('a %s job refuses the receipt at the preview, naming the way forward', async (status) => {
      state.receipt_delivery_jobs = [{ invoice_id: INV, status }];
      const res = await preview({ send_receipt: true });
      expect(res).toMatchObject({ code: 'receipt_already_queued' });
      expect(res.error).toBe('A receipt for this invoice is already queued; record the payment without a receipt here, or send it from the Invoices page.');
      expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
    });

    test('the same payment without a receipt is fine, and a finished or other invoice\'s job does not block', async () => {
      state.receipt_delivery_jobs = [{ invoice_id: INV, status: 'queued' }];
      expect(await preview()).toMatchObject({ preview: true, sends_to_customer: false });
      state.receipt_delivery_jobs = [{ invoice_id: INV, status: 'completed' }, { invoice_id: INV, status: 'failed' }, { invoice_id: 'other', status: 'queued' }];
      expect(await preview({ send_receipt: true })).toMatchObject({ preview: true, sends_to_customer: true });
    });

    test('Confirm refuses when a job was queued after the card, and the settlement fence refuses one that appears by the lock', async () => {
      db.schema = { hasTable: jest.fn(async () => false) };
      const card = await preview({ send_receipt: true });
      state.receipt_delivery_jobs = [{ invoice_id: INV, status: 'queued' }];
      expect(await confirm(card, { send_receipt: true })).toMatchObject({ code: 'receipt_already_queued', preview_changed: true });
      state.receipt_delivery_jobs = [];
      await confirm(card, { send_receipt: true });
      const { settlementFence } = Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment;
      await expect(settlementFence(db)).resolves.toBe(true);
      state.receipt_delivery_jobs = [{ invoice_id: INV, status: 'retry_scheduled' }];
      await expect(settlementFence(db)).rejects.toMatchObject({ statusCode: 409, drift: true, message: expect.stringMatching(/receipt for this invoice is already queued/) });
      delete db.schema;
    });

    test('a card without a receipt does not look at the queue in its fence', async () => {
      db.schema = { hasTable: jest.fn(async () => false) };
      const card = await preview();
      await confirm(card);
      const { settlementFence } = Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment;
      state.receipt_delivery_jobs = [{ invoice_id: INV, status: 'queued' }];
      await expect(settlementFence(db)).resolves.toBe(true);
      delete db.schema;
    });

    test('a receipt the queue reports as queued after the settlement is reported as such, not as sent by the card', async () => {
      const card = await preview({ send_receipt: true });
      Invoices.recordPaymentFromBar.mockResolvedValue({ status: 200, json: { ok: true, invoice: { status: 'paid' }, receipt: { queued: true } } });
      const res = await confirm(card, { send_receipt: true });
      expect(res).toMatchObject({ success: true, sent_to_customer: false, receipt: { requested: true, queued: true } });
      expect(res.note).toMatch(/goes out on its own, and this card did not send one/);
    });
  });

  test('a receipt with nobody to send it to is refused; without send_receipt the same invoice is fine', async () => {
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ payerBilled: false, emailRecipient: null, smsRecipient: null });
    expect(await preview({ send_receipt: true })).toMatchObject({ code: 'no_receipt_contact' });
    expect(await preview()).toMatchObject({ preview: true, sends_to_customer: false });
  });

  test('the card without a receipt is not a customer message', async () => {
    const card = await preview();
    const contract = buildContract({ toolName: 'record_payment', params: BASE, preview: card, summary: 'x' });
    expect(contract.notifies_customer).toBe(false);
    expect(contract.irreversible).toBe(true);
    expect(cardLines('record_payment', card).map((l) => l.text).join('\n')).toMatch(/Balance due before: \$117\.00; after: \$0\.00/);
  });

  test('the linked visit closeout and the review enrolment are disclosed when they apply', async () => {
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'v1', serviceType: 'Pest Control', date: '2099-01-01', resuming: false });
    state.invoices[0].service_record_id = 'sr-1';
    const text = (await preview()).effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/completes the linked visit \(Pest Control on 2099-01-01\) quietly/);
    expect(text).toMatch(/enrolled in the review-request follow-up/);
  });

  test('an open pay-page card session is disclosed as cancelled, never charged', async () => {
    state.invoices[0].stripe_payment_intent_id = 'pi_open_1';
    const text = (await preview()).effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/open pay-page card session.*cancelled first/);
  });

  test('a closeout probe that cannot read refuses (fail closed)', async () => {
    issuedCloseoutTarget.mockRejectedValue(new Error('db'));
    expect(await preview()).toMatchObject({ code: 'effects_check_failed' });
  });

  test('the model-visible preview never carries a raw phone or email', async () => {
    const json = JSON.stringify(await preview({ send_receipt: true }));
    expect(json).not.toMatch(/robin@example\.test|9415550142|\+1941/);
  });
});

describe('refusals', () => {
  test.each([
    ['an amount over the balance', { amount: 150 }, 'amount_exceeds_balance', /balance due is \$117\.00.*takes no overpayment/],
    ['an amount under the balance', { amount: 50 }, 'partial_not_supported', /no partial payment/],
    ['a negative amount (a refund)', { amount: -117 }, 'refund_not_supported', /does not refund/],
    ['a zero amount', { amount: 0 }, 'invalid_amount', /more than \$0/],
    ['a missing amount', { amount: undefined }, 'invalid_amount', /amount is required/],
    ['an amount with fractions of a cent', { amount: 116.999 }, 'invalid_amount', /two decimals/],
    ['a card method', { method: 'credit card' }, 'card_not_supported', /does not take card payments/],
    ['a Stripe method', { method: 'stripe' }, 'card_not_supported', /charge a card/],
    ['an unknown method', { method: 'bitcoin' }, 'invalid_method', /method must be one of: cash, check, zelle, venmo, paypal, other/],
    ['a date other than today', { payment_date: '2020-01-02' }, 'date_not_supported', /as of today/],
    ['a reference over the limit', { reference: 'x'.repeat(201) }, 'reference_too_long', /200 characters/],
    ['a note over the limit', { note: 'x'.repeat(401) }, 'note_too_long', /400 characters/],
  ])('%s is refused with nothing recorded', async (_name, input, code, message) => {
    const res = await preview(input);
    expect(res).toMatchObject({ code });
    expect(res.error).toMatch(message);
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });

  test('today’s date and a Zelle or Venmo method are accepted', async () => {
    expect(await preview({ payment_date: etDateString(), method: 'zelle' })).toMatchObject({ preview: true, method: 'zelle' });
    expect(await preview({ method: 'Venmo' })).toMatchObject({ preview: true, method: 'venmo' });
  });

  test.each([
    ['paid', { status: 'paid' }, 'already_paid'],
    ['prepaid', { status: 'prepaid' }, 'already_paid'],
    ['void', { status: 'void' }, 'invoice_not_collectible'],
    ['refunded', { status: 'refunded' }, 'invoice_not_collectible'],
    ['processing a bank payment', { status: 'processing' }, 'invoice_not_collectible'],
    ['held on a payer statement', { payer_statement_id: 'stmt-1' }, 'payer_statement'],
    ['a $0 invoice', { total: '0.00' }, 'nothing_due'],
  ])('an invoice that is %s is refused', async (_name, patch, code) => {
    Object.assign(state.invoices[0], patch);
    expect(await preview()).toMatchObject({ code });
  });

  test('an invoice billed to a payer, or one whose owner cannot be verified, is refused', async () => {
    rowIsSelfPayDue.mockResolvedValue(false);
    expect(await preview()).toMatchObject({ code: 'payer_owned' });
    rowIsSelfPayDue.mockRejectedValue(new Error('resolver down'));
    expect(await preview()).toMatchObject({ code: 'payer_owned' });
  });

  test('an annual-plan invoice, or one that cannot be checked, is refused', async () => {
    resolveInvoiceTermId.mockResolvedValue('term-1');
    expect(await preview()).toMatchObject({ code: 'annual_plan_invoice' });
    resolveInvoiceTermId.mockRejectedValue(new Error('x'));
    expect(await preview()).toMatchObject({ code: 'annual_plan_invoice' });
  });

  test('a cancelled visit is refused with the handler’s reason', async () => {
    state.invoices[0].scheduled_service_id = 'sv-1';
    state.scheduled_services.push({ id: 'sv-1', status: 'cancelled' });
    expect(await preview()).toMatchObject({ code: 'visit_terminal' });
  });

  test.each(['held', 'releasing'])('an invoice a %s report waits on is refused at the preview and at Confirm (it would release the report to the customer)', async (status) => {
    const clean = await preview();
    state.projects.push({ id: 'p1', invoice_id: INV, report_hold_status: status });
    const res = await preview();
    expect(res).toMatchObject({ code: 'payment_releases_report_unsupported' });
    expect(res.error).toBe('Recording this payment releases a held report to the customer, which the bar can\'t do from here yet; record it on the Invoices page.');
    expect(await confirm(clean)).toMatchObject({ code: 'payment_releases_report_unsupported', preview_changed: true });
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });

  test('a report already released, or held for a different invoice, does not block', async () => {
    state.projects.push({ id: 'p1', invoice_id: INV, report_hold_status: 'released' }, { id: 'p2', invoice_id: 'other', report_hold_status: 'held' });
    expect(await preview()).toMatchObject({ preview: true });
  });

  test('a held-report lookup that fails refuses (fail closed)', async () => {
    const base = makeDb();
    db.mockImplementation((table) => { if (table === 'projects') throw new Error('column report_hold_status does not exist'); return base(table); });
    const res = await preview();
    expect(res).toMatchObject({ code: 'payment_releases_report_unsupported' });
    expect(res.error).toMatch(/could not check/);
  });

  test('target errors: both or neither of id and number, a bad id, an unknown invoice', async () => {
    expect(await preview({ invoice_number: 'WPC-2099-0001' })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ invoice_id: undefined })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ invoice_id: 'nope' })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ invoice_id: '00000000-0000-4000-8000-0000000000ff' })).toMatchObject({ code: 'invoice_not_found' });
    expect(await preview({ invoice_id: undefined, invoice_number: 'wpc-2099-0001' })).toMatchObject({ preview: true, invoice_id: INV });
  });
});

describe('confirm', () => {
  test('replays the page handler once with exactly the carded body and the pins', async () => {
    const card = await preview({ note: 'n', send_receipt: true });
    const res = await confirm(card, { note: 'n', send_receipt: true });
    expect(res).toMatchObject({ success: true, status: 'paid', invoice_number: 'WPC-2099-0001', method: 'check', amount: 117 });
    expect(Invoices.recordPaymentFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.recordPaymentFromBar).toHaveBeenCalledWith({
      invoiceId: INV,
      body: { method: 'check', reference: '1042', note: 'n', sendReceipt: true, via: 'both' },
      actor: { technicianId: 'staff-1', name: 'Ava Admin', email: 'ava@example.test' },
      approvedPayment: { expectedAmountCents: 11700, settlementFence: expect.any(Function), receiptGuard: { check: expect.any(Function), relabel: expect.any(Function), claimOptions: { refuseQueuedJob: true } } },
    });
    // The receipt guard it hands over allows exactly the destinations the card showed.
    const { receiptGuard } = Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment;
    expect(await receiptGuard.check({ channel: 'email', to: 'ROBIN@example.test', optedOut: false })).toBe(true);
    expect(await receiptGuard.check({ channel: 'email', to: 'ROBIN@example.test', optedOut: true })).toBe(false);
    expect(await receiptGuard.check({ channel: 'email', to: 'ROBIN@example.test', optedOut: null })).toBe(false);
    expect(await receiptGuard.check({ channel: 'email', to: 'ROBIN@example.test' })).toBe(false);
    expect(await receiptGuard.check({ channel: 'sms', to: '+19415550142' })).toBe(true);
    expect(await receiptGuard.check({ channel: 'email', to: 'other@example.test', optedOut: false })).toBe(false);
    expect(await receiptGuard.check({ channel: 'app', to: null })).toBe(false);
  });

  test('the settlement fence it hands over is pinned to the invoice the card showed', async () => {
    db.schema = { hasTable: jest.fn(async () => false) };
    const card = await preview();
    await confirm(card);
    const { settlementFence } = Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment;
    // Before the lock (the plain connection): the same invoice passes, the strict edit time included.
    await expect(settlementFence(db)).resolves.toBe(true);
    // A change after the card refuses with a 409 the route answers as PREVIEW_CHANGED.
    state.invoices[0].customer_id = '00000000-0000-4000-8000-0000000000c9';
    await expect(settlementFence(db)).rejects.toMatchObject({ statusCode: 409, drift: true });
    state.invoices[0].customer_id = CUST;
    state.invoices[0].updated_at = new Date('2099-01-02T00:00:00Z');
    await expect(settlementFence(db)).rejects.toMatchObject({ drift: true });
    // Under the lock the edit time is not compared (the combined-session release rewrites it); the pinned columns still are.
    await expect(settlementFence(db, { ...state.invoices[0] })).resolves.toBe(true);
    await expect(settlementFence(db, { ...state.invoices[0], total: '99.00' })).rejects.toMatchObject({ drift: true });
    delete db.schema;
  });

  test('the fence carries the closeout target the card showed: the visit it named, or none', async () => {
    const none = await preview();
    await confirm(none);
    expect(Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment.settlementFence.closeoutTarget).toBe('none');
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-77', serviceType: 'Pest Control', date: '2099-01-01', resuming: false });
    const named = await preview();
    await confirm(named);
    expect(Invoices.recordPaymentFromBar.mock.calls[1][0].approvedPayment.settlementFence.closeoutTarget).toBe('visit-77');
  });

  describe('the visit and the day the card showed (Codex r4)', () => {
    const VISIT_EDITED = new Date('2099-01-01T09:00:00.000Z');
    const closeout = { visitId: 'visit-77', serviceType: 'Pest Control', date: '2099-01-01', updatedAt: VISIT_EDITED, resuming: false };
    const visitRow = (over = {}) => ({ id: 'visit-77', service_type: 'Pest Control', scheduled_date: new Date('2099-01-01T00:00:00Z'), updated_at: VISIT_EDITED, ...over });
    afterEach(() => jest.useRealTimers());

    async function fenceOf() {
      db.schema = { hasTable: jest.fn(async () => false) };
      const card = await preview();
      await confirm(card);
      return Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment.settlementFence;
    }

    test('a visit edited after the card (edit time, scheduled date or service type), or gone, refuses with drift', async () => {
      issuedCloseoutTarget.mockResolvedValue(closeout);
      state.scheduled_services.push(visitRow());
      const fence = await fenceOf();
      await expect(fence(db)).resolves.toBe(true);
      for (const patch of [{ updated_at: new Date('2099-01-01T10:00:00Z') }, { scheduled_date: new Date('2099-01-05T00:00:00Z') }, { service_type: 'Lawn Care' }]) {
        Object.assign(state.scheduled_services[0], patch);
        await expect(fence(db)).rejects.toMatchObject({ statusCode: 409, drift: true });
        Object.assign(state.scheduled_services[0], visitRow());
      }
      state.scheduled_services.length = 0;
      await expect(fence(db)).rejects.toMatchObject({ drift: true });
      delete db.schema;
    });

    test('a job timer started on the carded visit after the card refuses with the timer wording; the fence asks the closeout\'s own predicate about the carded visit', async () => {
      issuedCloseoutTarget.mockResolvedValue(closeout);
      state.scheduled_services.push(visitRow());
      const fence = await fenceOf();
      await expect(fence(db)).resolves.toBe(true);
      expect(visitJobTimerRunning).toHaveBeenLastCalledWith(db, 'visit-77');
      visitJobTimerRunning.mockResolvedValueOnce(true);
      await expect(fence(db, { ...state.invoices[0] })).rejects.toMatchObject({ statusCode: 409, drift: true, message: 'A technician started the visit timer since this card; try again after the visit — nothing was recorded' });
      delete db.schema;
    });

    test('a card with no closeout visit never asks about a timer', async () => {
      db.schema = { hasTable: jest.fn(async () => false) };
      visitJobTimerRunning.mockClear();
      const card = await preview();
      await confirm(card);
      const { settlementFence } = Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment;
      await expect(settlementFence(db)).resolves.toBe(true);
      expect(visitJobTimerRunning).not.toHaveBeenCalled();
      delete db.schema;
    });

    test('the visit’s facts are in the pin: a visit edited between the card and Confirm refuses with preview_changed', async () => {
      issuedCloseoutTarget.mockResolvedValue(closeout);
      const card = await preview();
      issuedCloseoutTarget.mockResolvedValue({ ...closeout, updatedAt: new Date('2099-01-01T10:00:00Z') });
      expect(await confirm(card)).toMatchObject({ preview_changed: true });
      issuedCloseoutTarget.mockResolvedValue({ ...closeout, date: '2099-01-09' });
      expect(await confirm(card)).toMatchObject({ preview_changed: true });
      expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
    });

    test('a card with no closeout visit has no visit to re-assert (a visit that becomes closable later is the closeout target guard’s)', async () => {
      db.schema = { hasTable: jest.fn(async () => false) };
      const card = await preview();
      expect(card._version.closeout_facts).toBeNull();
      await confirm(card);
      const { settlementFence } = Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment;
      await expect(settlementFence(db)).resolves.toBe(true);
      delete db.schema;
    });

    // Fake only the clock; the rest of the event loop stays real.
    const clockAt = (iso) => jest.useFakeTimers({ now: new Date(iso), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'performance'] });

    test('the card is stamped with its ET day; a settlement after midnight ET refuses; before midnight it passes', async () => {
      db.schema = { hasTable: jest.fn(async () => false) };
      clockAt('2099-01-02T04:59:00Z'); // 11:59 PM ET on Jan 1
      const card = await preview();
      expect(card.payment_date).toBe('2099-01-01');
      expect(card._version.payment_date).toBe('2099-01-01');
      await confirm(card);
      const { settlementFence } = Invoices.recordPaymentFromBar.mock.calls[0][0].approvedPayment;
      clockAt('2099-01-02T04:59:59Z');
      await expect(settlementFence(db)).resolves.toBe(true);
      clockAt('2099-01-02T05:00:01Z'); // 12:00:01 AM ET on Jan 2
      await expect(settlementFence(db)).rejects.toMatchObject({ statusCode: 409, drift: true });
      delete db.schema;
    });

    test('Confirm after midnight ET sees a new day in the re-derived card: preview_changed, nothing run', async () => {
      clockAt('2099-01-02T04:59:00Z');
      const card = await preview();
      clockAt('2099-01-02T05:01:00Z');
      expect(await confirm(card)).toMatchObject({ preview_changed: true });
      expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
    });
  });

  test('the card’s customer label says a receipt is attempted by its channels, not that one will be sent', async () => {
    const card = await preview({ send_receipt: true });
    const contract = buildContract({ toolName: 'record_payment', params: { ...BASE, send_receipt: true }, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/A receipt will be attempted by email and text/);
    expect(JSON.stringify(contract)).not.toMatch(/will be sent a receipt/);
  });

  test('without a receipt the result says nothing was sent; with one it reports each leg from the handler’s own answer', async () => {
    const card = await preview();
    expect(await confirm(card)).toMatchObject({ success: true, sent_to_customer: false, receipt: { requested: false }, note: expect.stringMatching(/Nothing was sent to the customer/) });
    const withReceipt = await preview({ send_receipt: true });
    Invoices.recordPaymentFromBar.mockResolvedValue({ status: 200, json: { ok: true, invoice: { status: 'paid' }, receipt: { email: { ok: true }, sms: { ok: false, error: 'opted out' } } } });
    expect(await confirm(withReceipt, { send_receipt: true })).toMatchObject({
      success: true, sent_to_customer: true, receipt: { requested: true, email: 'sent', text: 'not_sent' },
    });
    Invoices.recordPaymentFromBar.mockResolvedValue({ status: 200, json: { ok: true, invoice: { status: 'paid' }, receipt: { email: { ok: false }, sms: { ok: false } } } });
    expect(await confirm(withReceipt, { send_receipt: true })).toMatchObject({ success: true, sent_to_customer: false, note: expect.stringMatching(/receipt was not sent/) });
  });

  test.each([
    ['the invoice edited after the card', (s) => { s.invoices[0].updated_at = new Date('2099-01-01T12:05:00Z'); }],
    ['the invoice paid after the card', (s) => { s.invoices[0].status = 'paid'; }],
    ['the total changed', (s) => { s.invoices[0].total = '120.00'; }],
    ['the invoice moved to another customer (a merge)', (s) => { s.invoices[0].customer_id = '00000000-0000-4000-8000-0000000000c9'; }],
    ['account credit applied', (s) => { s.invoices[0].credit_applied = '10.00'; }],
    ['a payer assigned', (s) => { s.invoices[0].payer_id = 'payer-1'; }],
    ['a card session minted', (s) => { s.invoices[0].stripe_payment_intent_id = 'pi_new'; }],
    ['the visit link changed', (s) => { s.invoices[0].scheduled_service_id = 'sv-9'; s.scheduled_services.push({ id: 'sv-9', status: 'scheduled' }); }],
  ])('drift after the card (%s) refuses with preview_changed and runs nothing', async (_name, mutate) => {
    const card = await preview();
    mutate(state);
    const res = await confirm(card);
    expect(res).toMatchObject({ preview_changed: true });
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });

  test('drift in the receipt recipients or the closeout visit refuses', async () => {
    const card = await preview({ send_receipt: true });
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'other@example.test' } });
    expect(await confirm(card, { send_receipt: true })).toMatchObject({ preview_changed: true });
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'Robin@Example.test' } });
    state.customers[0].phone = '(941) 555-0999';
    expect(await confirm(card, { send_receipt: true })).toMatchObject({ preview_changed: true });
    const plain = await preview();
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'v1', serviceType: 'Pest', date: '2099-01-01', resuming: false });
    expect(await confirm(plain)).toMatchObject({ preview_changed: true });
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });

  test('a changed method, reference or amount than the card showed is drift', async () => {
    const card = await preview();
    expect(await confirm(card, { method: 'cash' })).toMatchObject({ preview_changed: true });
    expect(await confirm(card, { reference: '9999' })).toMatchObject({ preview_changed: true });
    expect(await confirm(card, { send_receipt: true })).toMatchObject({ preview_changed: true });
    expect(Invoices.recordPaymentFromBar).not.toHaveBeenCalled();
  });

  test('the settlement’s own pin refusal (a change under the row lock) is preview_changed, not a failure to retry', async () => {
    const card = await preview();
    Invoices.recordPaymentFromBar.mockResolvedValue({ status: 409, json: { error: 'The invoice changed after the confirmation card was shown — nothing was recorded', code: 'PREVIEW_CHANGED' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
  });

  test('any other refusal of the handler is reported with its own words and no success', async () => {
    const card = await preview();
    Invoices.recordPaymentFromBar.mockResolvedValue({ status: 409, json: { error: 'A payment is already in flight (processing); wait for it to settle' } });
    const res = await confirm(card);
    expect(res).toMatchObject({ failed: true, code: 'record_refused' });
    expect(res.error).toMatch(/already in flight/);
    expect(res.success).toBeUndefined();
    Invoices.recordPaymentFromBar.mockResolvedValue({ status: 404, json: { error: 'Invoice not found' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'not_found' });
  });

  test('an answer that does not read as paid is an unknown outcome, never a retry invitation', async () => {
    const card = await preview();
    Invoices.recordPaymentFromBar.mockResolvedValue({ status: 200, json: { ok: true, invoice: { status: 'sent' } } });
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'record_unverified' });
  });

  test('a throw after the approval is an interrupted, unknown outcome', async () => {
    const card = await preview();
    Invoices.recordPaymentFromBar.mockRejectedValue(new Error('boom'));
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });

  test('a second confirm of the same card after it paid is refused: the invoice is no longer open', async () => {
    const card = await preview();
    await confirm(card);
    state.invoices[0].status = 'paid';
    expect(await confirm(card)).toMatchObject({ preview_changed: true });
    expect(Invoices.recordPaymentFromBar).toHaveBeenCalledTimes(1);
  });
});

describe('what the tool can never do', () => {
  test('it has no way to name a card, a refund or a void: no such parameter and no call into those paths', () => {
    const props = Object.keys(RECORD_PAYMENT_TOOLS[0].input_schema.properties);
    expect(props).toEqual(['invoice_id', 'invoice_number', 'amount', 'method', 'reference', 'note', 'payment_date', 'send_receipt']);
    expect(RECORD_PAYMENT_TOOLS[0].input_schema.properties.method.enum).toEqual(['cash', 'check', 'zelle', 'venmo', 'paypal', 'other']);
    const source = require('fs').readFileSync(require('path').join(__dirname, '../services/intelligence-bar/record-payment-tools.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/services\/stripe|refund\(|createRefund|voidInvoice|paymentIntents|chargeCard|charge\(/i);
  });
});
