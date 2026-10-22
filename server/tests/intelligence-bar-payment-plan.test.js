/**
 * IB payment plans (owner ruling 2026-10-12, Stage 3 cards): create_payment_plan and cancel_payment_plan. Each runs the
 * Invoices page's own handler in process behind a card, dark behind GATE_IB_PAYMENT_PLAN (needs GATE_IB_PLATFORM). What
 * the create card shows (every installment date and amount, the total = balance due, that NO card is charged, the
 * customer email), the screen's refusals, pin drift, cancel naming the exact plan and how reminders re-arm, gate off,
 * admin only, and that the commit runs the handler once with the card's pin. The handlers themselves are mocked here
 * (admin-invoices-reminder-plan-handler-replay.test.js covers the real ones). Nothing here reaches a provider.
 * Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-invoices', () => ({
  createPaymentPlanFromBar: jest.fn(),
  cancelPaymentPlanFromBar: jest.fn(),
  getInvoiceDeliveryRecipients: jest.fn(),
}));

const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const tools = require('../services/intelligence-bar/payment-plan-tools');
const { executePaymentPlanTool, PAYMENT_PLAN_TOOLS, cardLines, installmentsFor } = tools;
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const ownerDirect = require('../services/intelligence-bar/owner-direct');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const INV = '00000000-0000-4000-8000-0000000000b2';
const CUST = '00000000-0000-4000-8000-0000000000c3';
const PLAN = '00000000-0000-4000-8000-0000000000f1';
const ADMIN = { isAdmin: true, technicianId: 'staff-1', operationId: 'op-1' };
const NAMES = ['create_payment_plan', 'cancel_payment_plan'];
const TERMS = { payment_amount: 50, payment_frequency: 'monthly', next_payment_date: '2099-02-01' };

let state;
function freshState() {
  return {
    invoices: [{
      id: INV, invoice_number: 'WPC-2099-0003', customer_id: CUST, status: 'sent', total: '129.00', credit_applied: '0.00',
      updated_at: new Date('2099-01-01T12:00:00.123Z'), payer_id: null,
    }],
    customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample' }],
    payment_plans: [],
    invoice_followup_sequences: [{
      id: 'seq-1', invoice_id: INV, customer_id: CUST, status: 'active', step_index: 1, next_touch_at: new Date('2099-01-05T15:00:00Z'),
      stopped_reason: null, paused_reason: null, is_autopay_held: false,
    }],
    technicians: [{ id: 'staff-1', name: 'Pat Staff', email: 'pat.staff@example.com' }],
  };
}
const activePlan = (over = {}) => ({
  id: PLAN, invoice_id: INV, status: 'active', total_balance: '129.00', payment_amount: '50.00', payment_frequency: 'monthly', next_payment_date: '2099-02-01', ...over,
});

// A small knex stand-in: plain-object where filters the seeded rows; any write throws.
function makeDb() {
  function builder(table) {
    const q = { wheres: [], single: false };
    const rows = () => {
      const found = (state[table] || []).filter((row) => q.wheres.every((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v))));
      return q.single ? found[0] : found;
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'where') return (arg) => { if (arg && typeof arg === 'object') q.wheres.push(arg); return b; };
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
  if (on) { process.env.GATE_IB_PAYMENT_PLAN = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_PAYMENT_PLAN; delete process.env.GATE_IB_PLATFORM; }
}

const create = (input = {}, ctx = ADMIN) => executePaymentPlanTool('create_payment_plan', { invoice_id: INV, ...TERMS, ...input }, ctx);
const cancel = (input = {}, ctx = ADMIN) => executePaymentPlanTool('cancel_payment_plan', { invoice_id: INV, ...input }, ctx);
const confirmCreate = (card, input = {}, ctx = ADMIN) => executePaymentPlanTool('create_payment_plan',
  { invoice_id: INV, ...TERMS, ...input, confirmed: true, _verified_payment_plan_version: card._version }, ctx);
const confirmCancel = (card, input = {}, ctx = ADMIN) => executePaymentPlanTool('cancel_payment_plan',
  { invoice_id: INV, ...input, confirmed: true, _verified_payment_plan_version: card._version }, ctx);
const effectText = (card) => card.effects.map((e) => e.text).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ customerName: 'Robin Sample', primaryContact: { phone: '+19415550142' }, emailRecipient: { email: 'robin.sample@example.com' } });
  Invoices.createPaymentPlanFromBar.mockResolvedValue({ status: 201, json: { ok: true, paymentPlan: { id: PLAN, status: 'active' }, email: { ok: true } } });
  Invoices.cancelPaymentPlanFromBar.mockResolvedValue({ status: 200, json: { ok: true, paymentPlan: { id: PLAN, status: 'cancelled' } } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('two-step writes, admin only, never owner-direct, record-scoped; create emails the customer so it is an external action', () => {
    for (const name of NAMES) {
      expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
      expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(name)).toBe(true);
      expect(registry.actions.get(name)).toMatchObject({ domain: 'customers', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'payment-plan-tools.js',
        kind: name === 'create_payment_plan' ? 'external_action' : 'internal_write' });
      expect(registry.policyErrors).not.toContain(name);
      expect(ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(name)).toBe(false);
    }
    expect(PAYMENT_PLAN_TOOLS.map((t) => t.name)).toEqual(NAMES);
    expect(PAYMENT_PLAN_TOOLS.every((t) => t._sideEffects === true)).toBe(true);
  });

  test('the schemas take only the documented fields, with no numeric bounds (the model API rejects them)', () => {
    expect(Object.keys(PAYMENT_PLAN_TOOLS[0].input_schema.properties)).toEqual(
      ['invoice_id', 'invoice_number', 'payment_amount', 'payment_frequency', 'next_payment_date', 'plan_start_date', 'notes']);
    expect(Object.keys(PAYMENT_PLAN_TOOLS[1].input_schema.properties)).toEqual(['invoice_id', 'invoice_number', 'reason']);
    expect(JSON.stringify(PAYMENT_PLAN_TOOLS)).not.toMatch(/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)"/);
    // The tool takes no payment method and no card: a plan never charges one.
    expect(JSON.stringify(PAYMENT_PLAN_TOOLS)).not.toMatch(/payment_method|paymentMethod/);
  });

  test('gate off: not offered; the platform gate is needed; a technician never gets them', () => {
    for (const name of NAMES) expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'customers' })).toBe(true);
    delete process.env.GATE_IB_PLATFORM;
    for (const name of NAMES) expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'customers' })).toBe(false);
    envGate(false);
    for (const name of NAMES) expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'customers' })).toBe(false);
    envGate(true);
    for (const name of NAMES) expect(registry.allowed(registry.actions.get(name), { role: 'technician', context: 'tech' })).toBe(false);
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses with gate_off and changes nothing', async () => {
    envGate(false);
    expect(await create()).toMatchObject({ code: 'gate_off' });
    expect(await cancel()).toMatchObject({ code: 'gate_off' });
    expect(await executePaymentPlanTool('create_payment_plan', { invoice_id: INV, confirmed: true, _verified_payment_plan_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(await executePaymentPlanTool('cancel_payment_plan', { invoice_id: INV, confirmed: true, _verified_payment_plan_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(Invoices.createPaymentPlanFromBar).not.toHaveBeenCalled();
    expect(Invoices.cancelPaymentPlanFromBar).not.toHaveBeenCalled();
  });

  test('a non-admin is refused, a confirmed run needs a positive admin flag, and a confirm with no card pin runs nothing', async () => {
    expect(await create({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(await confirmCreate({ _version: {} }, {}, {})).toMatchObject({ code: 'permission_denied' });
    expect(await cancel({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(await executePaymentPlanTool('create_payment_plan', { invoice_id: INV, ...TERMS, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    expect(await executePaymentPlanTool('cancel_payment_plan', { invoice_id: INV, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    expect(Invoices.createPaymentPlanFromBar).not.toHaveBeenCalled();
    expect(Invoices.cancelPaymentPlanFromBar).not.toHaveBeenCalled();
    expect(await executePaymentPlanTool('void_invoice', { invoice_id: INV }, ADMIN)).toMatchObject({ error: 'Unknown tool: void_invoice' });
  });

  test('names the invoice by number too, and exactly one of the two', async () => {
    expect(await create({ invoice_id: undefined, invoice_number: 'wpc-2099-0003' })).toMatchObject({ preview: true, invoice_id: INV });
    expect(await create({ invoice_number: 'WPC-2099-0003' })).toMatchObject({ code: 'invalid_target' });
    expect(await executePaymentPlanTool('create_payment_plan', TERMS, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await create({ invoice_id: 'nope' })).toMatchObject({ code: 'invalid_target' });
    expect(await create({ invoice_id: undefined, invoice_number: 'WPC-0000' })).toMatchObject({ code: 'invoice_not_found' });
  });
});

describe('create_payment_plan preview', () => {
  test('lists each installment, the total = balance due, says no card is charged, and names the customer email', async () => {
    const card = await create();
    expect(card).toMatchObject({
      preview: true, tool: 'create_payment_plan', invoice_number: 'WPC-2099-0003', customer_name: 'Robin Sample', amount_due: '$129.00', total: '$129.00',
      frequency: 'monthly', next_payment_date: '2099-02-01', installment_count: 3, charges_card: false, emails_customer: true,
    });
    expect(card.installments).toEqual(['1. Sun, Feb 1, 2099 — $50.00', '2. Sun, Mar 1, 2099 — $50.00', '3. Wed, Apr 1, 2099 — $29.00']);
    const text = effectText(card);
    expect(text).toMatch(/Records a monthly payment plan on invoice WPC-2099-0003: 3 installments totaling \$129\.00/);
    expect(text).toMatch(/NO card is charged\. The plan attaches no saved card, and nothing collects the installments automatically: staff record each payment/);
    expect(text).toMatch(/automatic payment reminders stop while the plan is active \(cancelling the plan re-arms them\)/);
    expect(text).toMatch(/locked against edits/);
    expect(text).toMatch(/Emails the customer \(r\*\*\*@example\.com\) the payment plan confirmation: total \$129\.00, \$50\.00 monthly, next payment/);
    expect(JSON.stringify(card)).not.toMatch(/robin\.sample@/);
    // The handler body is the page's own body shape, with no payment method.
    expect(card._body).toEqual({ totalBalance: 129, paymentAmount: 50, paymentFrequency: 'monthly', planStartDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), nextPaymentDate: '2099-02-01' });
    expect(Invoices.createPaymentPlanFromBar).not.toHaveBeenCalled();

    const lines = cardLines('create_payment_plan', card);
    const joined = lines.map((l) => l.text).join('\n');
    expect(joined).toMatch(/Payment plan on invoice WPC-2099-0003 for Robin Sample: \$129\.00 due, monthly, 3 installments/);
    expect(joined).toMatch(/Total of the plan = balance due \$129\.00/);
    expect(joined).toMatch(/Installment 1\. Sun, Feb 1, 2099 — \$50\.00/);
    expect(joined).toMatch(/Charges a card: NO\./);
    const contract = buildContract({ toolName: 'create_payment_plan', params: { invoice_id: INV, ...TERMS }, displayParams: {}, preview: card, summary: 'x' });
    expect(contract.notifies_customer).toBe(true);
    expect(contract.irreversible).toBe(true);
    expect(JSON.stringify(contract)).toMatch(/NO card is charged/);
  });

  test('the total is the balance due: account credit already applied lowers it', async () => {
    state.invoices[0].credit_applied = '29.00';
    const card = await create();
    expect(card.amount_due).toBe('$100.00');
    expect(card.installments).toEqual(['1. Sun, Feb 1, 2099 — $50.00', '2. Sun, Mar 1, 2099 — $50.00']);
    expect(effectText(card)).toMatch(/\$129\.00 total less \$29\.00 account credit/);
  });

  test('long schedules show the first few on the card and the rest under Show more', async () => {
    state.invoices[0].total = '800.00';
    const card = await create({ payment_amount: 100 });
    expect(card.installment_count).toBe(8);
    const lines = cardLines('create_payment_plan', card);
    expect(lines.filter((l) => l.more)).toHaveLength(2);
    expect(lines.map((l) => l.text).join('\n')).toMatch(/All 8 installments are listed; installments 7 on are under "Show more"/);
  });

  test('weekly and biweekly step by days; monthly keeps the original day and clamps month ends', () => {
    const dates = (frequency, firstYmd, count) => installmentsFor({ totalCents: 1000 * count, paymentCents: 1000, frequency, firstYmd }).map((r) => r.date);
    expect(dates('weekly', '2099-01-29', 3)).toEqual(['2099-01-29', '2099-02-05', '2099-02-12']);
    expect(dates('biweekly', '2099-01-29', 3)).toEqual(['2099-01-29', '2099-02-12', '2099-02-26']);
    expect(dates('monthly', '2099-01-31', 4)).toEqual(['2099-01-31', '2099-02-28', '2099-03-31', '2099-04-30']);
    expect(dates('monthly', '2096-01-31', 2)).toEqual(['2096-01-31', '2096-02-29']);
    const rows = installmentsFor({ totalCents: 12900, paymentCents: 5000, frequency: 'weekly', firstYmd: '2099-02-01' });
    expect(rows.map((r) => r.cents)).toEqual([5000, 5000, 2900]);
    expect(rows.reduce((sum, r) => sum + r.cents, 0)).toBe(12900);
  });

  test('a note and an explicit start date ride the body; no email on file says so', async () => {
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ customerName: 'Robin Sample', primaryContact: { phone: '+19415550142' }, emailRecipient: null });
    const card = await create({ notes: '  Customer asked   for three payments ', plan_start_date: '2099-01-20' });
    expect(card).toMatchObject({ notes: 'Customer asked for three payments', plan_start_date: '2099-01-20', emails_customer: false, sends_to_customer: false });
    expect(card._body).toMatchObject({ planStartDate: '2099-01-20', notes: 'Customer asked for three payments' });
    expect(effectText(card)).toMatch(/No usable email is on file, so no confirmation is sent; no text is sent either/);
  });

  test.each([
    ['a payer-billed invoice', (s) => { s.invoices[0].payer_id = 'payer-1'; }, {}, 'payer_owned'],
    ['a paid invoice', (s) => { s.invoices[0].status = 'paid'; }, {}, 'invoice_not_collectible'],
    ['a prepaid invoice', (s) => { s.invoices[0].status = 'prepaid'; }, {}, 'invoice_not_collectible'],
    ['a void invoice', (s) => { s.invoices[0].status = 'void'; }, {}, 'invoice_not_collectible'],
    ['a bank payment processing', (s) => { s.invoices[0].status = 'processing'; }, {}, 'invoice_not_collectible'],
    ['a refunded invoice', (s) => { s.invoices[0].status = 'refunded'; }, {}, 'invoice_not_collectible'],
    ['a draft invoice', (s) => { s.invoices[0].status = 'draft'; }, {}, 'invoice_draft'],
    ['a $0 invoice', (s) => { s.invoices[0].total = '0.00'; }, {}, 'nothing_due'],
    ['a balance covered by credit', (s) => { s.invoices[0].credit_applied = '129.00'; }, {}, 'nothing_due'],
    ['an active plan already there', (s) => { s.payment_plans = [activePlan()]; }, {}, 'plan_exists'],
    ['a frequency that is not offered', () => {}, { payment_frequency: 'daily' }, 'invalid_plan'],
    ['no frequency', () => {}, { payment_frequency: undefined }, 'invalid_plan'],
    ['an installment of zero', () => {}, { payment_amount: 0 }, 'invalid_plan'],
    ['a negative installment', () => {}, { payment_amount: -5 }, 'invalid_plan'],
    ['a fraction of a cent', () => {}, { payment_amount: 0.001 }, 'invalid_plan'],
    ['an installment above the balance', () => {}, { payment_amount: 129.01 }, 'invalid_plan'],
    ['no first payment date', () => {}, { next_payment_date: undefined }, 'invalid_plan'],
    ['a made-up first payment date', () => {}, { next_payment_date: '2099-02-30' }, 'invalid_plan'],
    ['a first payment in the past', () => {}, { next_payment_date: '2020-01-01' }, 'invalid_plan'],
    ['a first payment before the start', () => {}, { plan_start_date: '2099-03-01' }, 'invalid_plan'],
    ['a made-up start date', () => {}, { plan_start_date: '2099-13-01' }, 'invalid_plan'],
    ['more than 60 installments', (s) => { s.invoices[0].total = '5000.00'; }, { payment_amount: 50 }, 'too_many_installments'],
  ])('refused: %s', async (_label, mutate, input, code) => {
    mutate(state);
    expect(await create(input)).toMatchObject({ code });
    expect(Invoices.createPaymentPlanFromBar).not.toHaveBeenCalled();
  });

  test('60 installments is the most a card lists', async () => {
    state.invoices[0].total = '3000.00';
    expect(await create({ payment_amount: 50 })).toMatchObject({ preview: true, installment_count: 60 });
  });
});

describe('create_payment_plan Confirm', () => {
  test('runs the page handler once with the card’s body, the staff identity and the invoice edit time, and says no card was charged', async () => {
    const card = await create();
    const result = await confirmCreate(card);
    expect(result).toMatchObject({ success: true, payment_plan_id: PLAN, charged_card: false, sent_to_customer: true, invoice_number: 'WPC-2099-0003' });
    expect(result.note).toMatch(/No card was charged\. The confirmation email was sent\./);
    expect(Invoices.createPaymentPlanFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.createPaymentPlanFromBar).toHaveBeenCalledWith({
      invoiceId: INV, body: card._body,
      actor: { technicianId: 'staff-1', name: 'Pat Staff', email: 'pat.staff@example.com' },
      approvedPlan: { updatedAtMs: new Date('2099-01-01T12:00:00.123Z').getTime() },
    });
    // The body is the page dialog's shape and never carries a payment method.
    expect(Object.keys(Invoices.createPaymentPlanFromBar.mock.calls[0][0].body)).not.toContain('paymentMethodId');
  });

  test('an email the handler did not send is not reported as sent', async () => {
    const card = await create();
    Invoices.createPaymentPlanFromBar.mockResolvedValueOnce({ status: 201, json: { ok: true, paymentPlan: { id: PLAN, status: 'active' }, email: { ok: false, skipped: true, reason: 'missing_email' } } });
    const result = await confirmCreate(card);
    expect(result).toMatchObject({ success: true, sent_to_customer: false });
    expect(result.note).toMatch(/confirmation email was not sent/);
  });

  test('drift in the invoice, the balance, the terms, the reminder row or the recipient refuses and runs nothing', async () => {
    const card = await create();
    state.invoices[0].updated_at = new Date('2099-01-03T00:00:00Z');
    expect(await confirmCreate(card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    state.invoices[0].updated_at = new Date('2099-01-01T12:00:00.123Z');
    state.invoices[0].credit_applied = '10.00';
    expect(await confirmCreate(card)).toMatchObject({ preview_changed: true });
    state.invoices[0].credit_applied = '0.00';
    expect(await confirmCreate(card, { payment_amount: 60 })).toMatchObject({ preview_changed: true });
    expect(await confirmCreate(card, { payment_frequency: 'weekly' })).toMatchObject({ preview_changed: true });
    expect(await confirmCreate(card, { next_payment_date: '2099-02-02' })).toMatchObject({ preview_changed: true });
    state.invoice_followup_sequences[0].status = 'paused';
    expect(await confirmCreate(card)).toMatchObject({ preview_changed: true });
    state.invoice_followup_sequences[0].status = 'active';
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ customerName: 'Robin Sample', primaryContact: {}, emailRecipient: { email: 'someone.else@example.com' } });
    expect(await confirmCreate(card)).toMatchObject({ preview_changed: true });
    expect(Invoices.createPaymentPlanFromBar).not.toHaveBeenCalled();
  });

  test('a plan created in the meantime, or an invoice paid in the meantime, refuses at Confirm', async () => {
    const card = await create();
    state.payment_plans = [activePlan()];
    expect(await confirmCreate(card)).toMatchObject({ preview_changed: true, code: 'plan_exists' });
    state.payment_plans = [];
    state.invoices[0].status = 'paid';
    expect(await confirmCreate(card)).toMatchObject({ preview_changed: true });
    expect(Invoices.createPaymentPlanFromBar).not.toHaveBeenCalled();
  });

  test('a card for the cancel tool cannot approve a create', async () => {
    state.payment_plans = [activePlan()];
    const cancelCard = await cancel();
    state.payment_plans = [];
    expect(await confirmCreate(cancelCard)).toMatchObject({ preview_changed: true });
    expect(Invoices.createPaymentPlanFromBar).not.toHaveBeenCalled();
  });

  test('handler answers: 409 PREVIEW_CHANGED, another refusal, an unreadable answer and a throw are each reported honestly', async () => {
    const card = await create();
    Invoices.createPaymentPlanFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'The invoice changed after the card was shown, so no payment plan was created.', code: 'PREVIEW_CHANGED' } });
    expect(await confirmCreate(card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    Invoices.createPaymentPlanFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Invoice already has an active payment plan' } });
    expect(await confirmCreate(card)).toMatchObject({ failed: true, code: 'plan_refused', error: 'The payment plan was not created: Invoice already has an active payment plan' });
    Invoices.createPaymentPlanFromBar.mockResolvedValueOnce({ status: 201, json: { ok: true, paymentPlan: { id: PLAN, status: 'cancelled' } } });
    expect(await confirmCreate(card)).toMatchObject({ outcome_unknown: true, code: 'plan_unverified' });
    Invoices.createPaymentPlanFromBar.mockRejectedValueOnce(new Error('boom'));
    expect(await confirmCreate(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    // A throw after the plan row exists is read back.
    Invoices.createPaymentPlanFromBar.mockImplementationOnce(async () => { state.payment_plans = [activePlan()]; throw new Error('late'); });
    const readBack = await confirmCreate(card);
    expect(readBack).toMatchObject({ success: true, warning: true, payment_plan_id: PLAN });
    expect(readBack.note).toMatch(/confirmation email may not have gone out/);
  });
});

describe('cancel_payment_plan', () => {
  beforeEach(() => {
    state.payment_plans = [activePlan()];
    state.invoice_followup_sequences[0].status = 'stopped';
    state.invoice_followup_sequences[0].stopped_reason = `payment_plan_created:${PLAN}:prev=active`;
  });

  test('the preview names the exact plan, what cancel does and how the reminders re-arm; nothing is changed or sent', async () => {
    const card = await cancel({ reason: ' customer paid by check ' });
    expect(card).toMatchObject({ preview: true, tool: 'cancel_payment_plan', invoice_number: 'WPC-2099-0003', payment_plan_id: PLAN, plan_summary: '$50.00 monthly toward $129.00', reason: 'customer paid by check', rearm: 'resumed', sends_to_customer: false });
    const text = effectText(card);
    expect(text).toMatch(/Cancels the monthly payment plan on invoice WPC-2099-0003: \$50\.00 installments toward \$129\.00, next payment Sun, Feb 1, 2099/);
    expect(text).toMatch(/reopens for normal collection and editing\. No card is charged and nothing is refunded/);
    expect(text).toMatch(/The reminders restart, so a reminder can go out to the customer at the next reminder run/);
    expect(text).toMatch(/Nothing is sent to the customer right now/);
    expect(card._body).toEqual({ paymentPlanId: PLAN, reason: 'customer paid by check' });
    expect(Invoices.cancelPaymentPlanFromBar).not.toHaveBeenCalled();
    expect(cardLines('cancel_payment_plan', card).map((l) => l.text).join('\n')).toMatch(/Cancel the payment plan on invoice WPC-2099-0003 for Robin Sample/);
    const contract = buildContract({ toolName: 'cancel_payment_plan', params: { invoice_id: INV }, displayParams: {}, preview: card, summary: 'x' });
    expect(contract.notifies_customer).toBeFalsy();
  });

  test.each([
    ['a pre-plan pause comes back paused', (s) => { s.invoice_followup_sequences[0].stopped_reason = `payment_plan_created:${PLAN}:prev=paused`; }, 'restored_pause', /go back to PAUSED/],
    ['an Auto Pay customer returns to the hold', (s) => { s.invoice_followup_sequences[0].is_autopay_held = true; }, 'held', /go back to the Auto Pay hold/],
    ['no sequence starts a new one', (s) => { s.invoice_followup_sequences = []; }, 'schedule', /a new one is started/],
    ['a stop that was not the plan’s is left alone', (s) => { s.invoice_followup_sequences[0].stopped_reason = 'waived'; }, 'untouched', /not changed by the cancel/],
  ])('reminders: %s', async (_label, mutate, rearm, pattern) => {
    mutate(state);
    const card = await cancel();
    expect(card.rearm).toBe(rearm);
    expect(effectText(card)).toMatch(pattern);
  });

  test.each([
    ['no active plan', (s) => { s.payment_plans = [activePlan({ status: 'cancelled' })]; }, 'no_active_plan'],
    ['a bank payment processing', (s) => { s.invoices[0].status = 'processing'; }, 'payment_processing'],
    ['a paid invoice', (s) => { s.invoices[0].status = 'paid'; }, 'invoice_settled'],
    ['a prepaid invoice', (s) => { s.invoices[0].status = 'prepaid'; }, 'invoice_settled'],
  ])('refused: %s', async (_label, mutate, code) => {
    mutate(state);
    expect(await cancel()).toMatchObject({ code });
    expect(Invoices.cancelPaymentPlanFromBar).not.toHaveBeenCalled();
  });

  test('Confirm runs the page handler once with the exact plan id and the staff identity', async () => {
    const card = await cancel({ reason: 'paid by check' });
    const result = await confirmCancel(card, { reason: 'paid by check' });
    expect(result).toMatchObject({ success: true, sent_to_customer: false, payment_plan_id: PLAN });
    expect(result.note).toMatch(/cancelled and the invoice is open for collection again\. Nothing was sent now/);
    expect(Invoices.cancelPaymentPlanFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.cancelPaymentPlanFromBar).toHaveBeenCalledWith({
      invoiceId: INV, body: { paymentPlanId: PLAN, reason: 'paid by check' },
      actor: { technicianId: 'staff-1', name: 'Pat Staff', email: 'pat.staff@example.com' },
    });
  });

  test('a replacement plan, a changed plan, a changed reminder row or a changed invoice refuses at Confirm', async () => {
    const card = await cancel();
    state.payment_plans = [activePlan({ id: '00000000-0000-4000-8000-0000000000f2' })];
    expect(await confirmCancel(card)).toMatchObject({ preview_changed: true });
    state.payment_plans = [activePlan({ payment_amount: '60.00' })];
    expect(await confirmCancel(card)).toMatchObject({ preview_changed: true });
    state.payment_plans = [activePlan()];
    state.invoice_followup_sequences[0].stopped_reason = 'waived';
    expect(await confirmCancel(card)).toMatchObject({ preview_changed: true });
    state.invoice_followup_sequences[0].stopped_reason = `payment_plan_created:${PLAN}:prev=active`;
    state.invoices[0].updated_at = new Date('2099-01-09T00:00:00Z');
    expect(await confirmCancel(card)).toMatchObject({ preview_changed: true });
    expect(Invoices.cancelPaymentPlanFromBar).not.toHaveBeenCalled();
  });

  test('handler answers: completed instead of cancelled, reminders not re-armed, a refusal, an unreadable answer and a throw', async () => {
    const card = await cancel();
    Invoices.cancelPaymentPlanFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, completedInsteadOfCancelled: true, paymentPlan: { id: PLAN, status: 'completed' } } });
    expect(await confirmCancel(card)).toMatchObject({ success: true, completed_instead: true });
    Invoices.cancelPaymentPlanFromBar.mockResolvedValueOnce({ status: 502, json: { error: 'The payment plan was cancelled, but re-arming invoice reminders failed', paymentPlan: { id: PLAN, status: 'cancelled' } } });
    expect(await confirmCancel(card)).toMatchObject({ success: true, warning: true, code: 'reminders_not_rearmed' });
    Invoices.cancelPaymentPlanFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Invoice has no active payment plan' } });
    expect(await confirmCancel(card)).toMatchObject({ failed: true, code: 'cancel_refused' });
    Invoices.cancelPaymentPlanFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, paymentPlan: { id: PLAN, status: 'active' } } });
    expect(await confirmCancel(card)).toMatchObject({ outcome_unknown: true, code: 'cancel_unverified' });
    Invoices.cancelPaymentPlanFromBar.mockRejectedValueOnce(new Error('boom'));
    expect(await confirmCancel(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    Invoices.cancelPaymentPlanFromBar.mockImplementationOnce(async () => { state.payment_plans = [activePlan({ status: 'cancelled' })]; throw new Error('late'); });
    expect(await confirmCancel(card)).toMatchObject({ success: true, warning: true });
  });
});
