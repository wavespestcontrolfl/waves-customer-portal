/**
 * IB invoice reminders and scheduled sends (owner ruling 2026-10-12, Stage 3 cards): pause_invoice_reminders,
 * resume_invoice_reminders, stop_invoice_reminders, send_invoice_reminder_now and schedule_invoice_send. Each runs the
 * Invoices page's own handler in process behind a card, dark behind GATE_IB_INVOICE_REMINDERS (needs GATE_IB_PLATFORM).
 * What each card shows (the channel, the masked recipient and the exact message for the two that reach the customer),
 * pin drift, the refusals, gate off, admin only, and that the commit runs the handler once with the card's pin. The
 * handlers themselves are mocked here (admin-invoices-reminder-plan-handler-replay.test.js covers the real ones).
 * Nothing here reaches a provider. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-invoices', () => ({
  followupControlFromBar: jest.fn(),
  sendReminderNowFromBar: jest.fn(),
  scheduleSendFromBar: jest.fn(),
  getInvoiceDeliveryRecipients: jest.fn(),
}));

const { approvalDigest } = require('../utils/approval-digest');
const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const Wiring = require('../services/customer-dunning/wiring');
const SendWindow = require('../services/messaging/send-window');
const CollectionHold = require('../services/collections/collection-hold');
const CustomerCredit = require('../services/customer-credit');
const SmsTemplates = require('../routes/admin-sms-templates');
const SmsVariants = require('../services/sms-template-variants');
const BillingEmailSender = require('../services/billing-email-sender');
const EmailLibrary = require('../services/email-template-library');
const PayerOwnership = require('../services/invoice-payer-ownership');
const tools = require('../services/intelligence-bar/invoice-reminder-tools');
const { executeInvoiceReminderTool, INVOICE_REMINDER_TOOLS, cardLines } = tools;
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const ownerDirect = require('../services/intelligence-bar/owner-direct');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const INV = '00000000-0000-4000-8000-0000000000b1';
const CUST = '00000000-0000-4000-8000-0000000000c2';
const SEQ = '00000000-0000-4000-8000-0000000000e1';
const ADMIN = { isAdmin: true, technicianId: 'staff-1', operationId: 'op-1' };
const NAMES = ['pause_invoice_reminders', 'resume_invoice_reminders', 'stop_invoice_reminders', 'send_invoice_reminder_now', 'schedule_invoice_send'];
const FUTURE = '2099-01-15T09:30';

let state;
function freshState() {
  return {
    invoices: [{
      id: INV, invoice_number: 'WPC-2099-0002', customer_id: CUST, status: 'sent', total: '129.00', credit_applied: '0.00',
      updated_at: new Date('2099-01-01T12:00:00.123Z'), sent_at: new Date('2098-12-01T12:00:00Z'), payer_id: null, payer_statement_id: null,
      stripe_payment_intent_id: null, title: 'Quarterly Pest Control', due_date: '2098-12-15', service_date: '2098-11-30', scheduled_send_at: null,
    }],
    customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample', phone: '+19415550142', email: 'robin.sample@example.com', deleted_at: null }],
    invoice_followup_sequences: [{
      id: SEQ, invoice_id: INV, customer_id: CUST, status: 'active', step_index: 0, touches_sent: 0,
      next_touch_at: new Date('2099-01-05T15:00:00Z'), anchor_at: new Date('2098-12-01T12:00:00Z'), touch_claimed_at: null,
      stopped_reason: null, paused_reason: null, is_autopay_held: false,
    }],
    payment_plans: [],
  };
}

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
  if (on) { process.env.GATE_IB_INVOICE_REMINDERS = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_INVOICE_REMINDERS; delete process.env.GATE_IB_PLATFORM; }
}

const call = (name, input = {}, ctx = ADMIN) => executeInvoiceReminderTool(name, { invoice_id: INV, ...input }, ctx);
const confirm = (name, card, input = {}, ctx = ADMIN) => executeInvoiceReminderTool(name,
  { invoice_id: INV, ...input, confirmed: true, _verified_invoice_reminder_version: card._version }, ctx);
const effectText = (card) => card.effects.map((e) => e.text).join('\n');

let spies;
beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  spies = [
    jest.spyOn(Wiring, 'customerScheduleSummary').mockResolvedValue(null),
    jest.spyOn(Wiring, 'customerScheduleSummaryForInvoice').mockResolvedValue(null),
    jest.spyOn(SendWindow, 'isWithinSendWindowET').mockReturnValue(true),
    jest.spyOn(CollectionHold, 'customerHasActiveMessagingHoldChecked').mockResolvedValue(false),
    jest.spyOn(CustomerCredit, 'autoApplyWouldApply').mockResolvedValue(false),
    jest.spyOn(SmsTemplates, 'getTemplate').mockResolvedValue('Hi Robin, a friendly reminder about your $129.00 invoice: [pay link]'),
    jest.spyOn(SmsVariants, 'activeVariants').mockResolvedValue([]),
    jest.spyOn(BillingEmailSender, 'operatorEmailRecipient').mockResolvedValue({ recipient: { name: 'Robin Sample', email: 'robin.sample@example.com' }, to: 'robin.sample@example.com' }),
    jest.spyOn(EmailLibrary, 'loadTemplateByKey').mockResolvedValue({ template: { template_key: 'invoice.followup_3_day', name: 'Reminder' }, activeVersion: { id: 'v1' } }),
    jest.spyOn(EmailLibrary, 'renderTemplate').mockReturnValue({ subject: 'A friendly reminder about your invoice', text: 'Hi Robin, your invoice WPC-2099-0002 has a balance of $129.00.' }),
    jest.spyOn(EmailLibrary, 'templateContentHash').mockReturnValue('hash-1'),
    jest.spyOn(PayerOwnership, 'invoicePayerOwnership').mockResolvedValue(null),
  ];
  Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ customerName: 'Robin Sample', primaryContact: { phone: '+19415550142' }, emailRecipient: { email: 'robin.sample@example.com' } });
  Invoices.followupControlFromBar.mockImplementation(async ({ control }) => {
    state.invoice_followup_sequences[0].status = { pause: 'paused', resume: 'active', stop: 'stopped' }[control];
    return { status: 200, json: { ok: true } };
  });
  Invoices.sendReminderNowFromBar.mockImplementation(async () => ({
    status: 200, json: { ok: true, reminder: { legs: { sms: { state: 'sent' }, email: { state: 'sent' } } } },
  }));
  Invoices.scheduleSendFromBar.mockImplementation(async ({ approvedSchedule }) => ({
    status: 200, json: { ok: true, invoice: { id: INV, status: 'scheduled', scheduled_send_at: new Date('2099-01-15T14:30:00Z'), approved: approvedSchedule } },
  }));
});
afterEach(() => { envGate(false); spies.forEach((spy) => spy.mockRestore()); });

describe('registration', () => {
  test('two-step writes, admin only, never owner-direct, record-scoped; the two that reach the customer are external actions', () => {
    for (const name of NAMES) {
      expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
      expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(name)).toBe(true);
      const want = ['send_invoice_reminder_now', 'schedule_invoice_send'].includes(name) ? 'external_action' : 'internal_write';
      expect(registry.actions.get(name)).toMatchObject({ domain: 'customers', role: 'admin', approval: 'ui_confirm', scope: 'record', kind: want, module: 'invoice-reminder-tools.js' });
      expect(registry.policyErrors).not.toContain(name);
      expect(ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(name)).toBe(false);
    }
    expect(INVOICE_REMINDER_TOOLS.map((t) => t.name)).toEqual(NAMES);
    expect(INVOICE_REMINDER_TOOLS.every((t) => t._sideEffects === true)).toBe(true);
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

  test('the schemas take only the documented fields', () => {
    const props = Object.fromEntries(INVOICE_REMINDER_TOOLS.map((t) => [t.name, Object.keys(t.input_schema.properties)]));
    expect(props.pause_invoice_reminders).toEqual(['invoice_id', 'invoice_number', 'reason']);
    expect(props.resume_invoice_reminders).toEqual(['invoice_id', 'invoice_number']);
    expect(props.send_invoice_reminder_now).toEqual(['invoice_id', 'invoice_number']);
    expect(props.schedule_invoice_send).toEqual(['invoice_id', 'invoice_number', 'send_at_et']);
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses with gate_off and changes nothing', async () => {
    envGate(false);
    for (const name of NAMES) {
      expect(await call(name, name === 'schedule_invoice_send' ? { send_at_et: FUTURE } : {})).toMatchObject({ code: 'gate_off' });
      expect(await executeInvoiceReminderTool(name, { invoice_id: INV, confirmed: true, _verified_invoice_reminder_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    }
    for (const fn of ['followupControlFromBar', 'sendReminderNowFromBar', 'scheduleSendFromBar']) expect(Invoices[fn]).not.toHaveBeenCalled();
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    for (const name of NAMES) {
      expect(await call(name, {}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
      expect(await executeInvoiceReminderTool(name, { invoice_id: INV, confirmed: true, _verified_invoice_reminder_version: {} }, {})).toMatchObject({ code: 'permission_denied' });
    }
    expect(Invoices.followupControlFromBar).not.toHaveBeenCalled();
    expect(Invoices.sendReminderNowFromBar).not.toHaveBeenCalled();
  });

  test('a forced call to an unknown tool, and a confirm with no card pin, change nothing', async () => {
    expect(await executeInvoiceReminderTool('void_invoice', { invoice_id: INV }, ADMIN)).toMatchObject({ error: 'Unknown tool: void_invoice' });
    for (const name of NAMES) {
      expect(await executeInvoiceReminderTool(name, { invoice_id: INV, send_at_et: FUTURE, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    }
    expect(Invoices.followupControlFromBar).not.toHaveBeenCalled();
    expect(Invoices.sendReminderNowFromBar).not.toHaveBeenCalled();
    expect(Invoices.scheduleSendFromBar).not.toHaveBeenCalled();
  });

  test('names the invoice by number too, and exactly one of the two', async () => {
    expect(await executeInvoiceReminderTool('pause_invoice_reminders', { invoice_number: 'wpc-2099-0002' }, ADMIN)).toMatchObject({ preview: true, invoice_id: INV });
    expect(await executeInvoiceReminderTool('pause_invoice_reminders', { invoice_id: INV, invoice_number: 'WPC-2099-0002' }, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeInvoiceReminderTool('pause_invoice_reminders', {}, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeInvoiceReminderTool('pause_invoice_reminders', { invoice_id: 'nope' }, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeInvoiceReminderTool('pause_invoice_reminders', { invoice_number: 'WPC-0000' }, ADMIN)).toMatchObject({ code: 'invoice_not_found' });
  });
});

describe('pause, resume and stop', () => {
  test('pause: the preview names the invoice and sends nothing; Confirm runs the panel handler once with the reason', async () => {
    const card = await call('pause_invoice_reminders', { reason: '  customer   says Friday ' });
    expect(card).toMatchObject({ preview: true, tool: 'pause_invoice_reminders', invoice_number: 'WPC-2099-0002', customer_name: 'Robin Sample', reminder_status: 'active', reason: 'customer says Friday', sends_to_customer: false });
    expect(effectText(card)).toMatch(/Automatic reminders for invoice WPC-2099-0002 stop going out until they are resumed/);
    expect(effectText(card)).toMatch(/Nothing is sent to the customer or anyone else/);
    expect(Invoices.followupControlFromBar).not.toHaveBeenCalled();
    const lines = cardLines('pause_invoice_reminders', card).map((l) => l.text).join('\n');
    expect(lines).toMatch(/Pause reminders on invoice WPC-2099-0002 for Robin Sample/);
    expect(lines).toMatch(/Reason noted: "customer says Friday"/);

    const result = await confirm('pause_invoice_reminders', card, { reason: '  customer   says Friday ' });
    expect(result).toMatchObject({ success: true, reminder_status: 'paused', sent_to_customer: false });
    expect(Invoices.followupControlFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.followupControlFromBar).toHaveBeenCalledWith({ invoiceId: INV, control: 'pause', body: { reason: 'customer says Friday' }, actor: { technicianId: 'staff-1' }, approved: { sequenceId: SEQ, status: 'active', stepIndex: 0 } });
  });

  test('resume: names the next reminder and warns when it is already due; only a paused sequence resumes', async () => {
    expect(await call('resume_invoice_reminders')).toMatchObject({ code: 'wrong_reminder_state', reminder_status: 'active' });
    state.invoice_followup_sequences[0].status = 'paused';
    state.invoice_followup_sequences[0].anchor_at = new Date('2020-01-01T12:00:00Z');
    const card = await call('resume_invoice_reminders');
    expect(card).toMatchObject({ preview: true, control: 'resume', sends_to_customer: false });
    expect(effectText(card)).toMatch(/start again\. The next one/);
    expect(effectText(card)).toMatch(/already passed, so the reminder can go out to the customer at the next reminder run/);
    expect(effectText(card)).toMatch(/Nothing is sent right now/);
    const result = await confirm('resume_invoice_reminders', card);
    expect(result).toMatchObject({ success: true, reminder_status: 'active' });
    expect(Invoices.followupControlFromBar).toHaveBeenCalledWith({ invoiceId: INV, control: 'resume', body: {}, actor: { technicianId: 'staff-1' }, approved: { sequenceId: SEQ, status: 'paused', stepIndex: 0 } });
  });

  test('resume is refused for reminders held for a payer (Bill-To withdrawal), however they are marked', async () => {
    state.invoice_followup_sequences[0].status = 'paused';
    state.invoice_followup_sequences[0].paused_reason = 'payer_billed';
    expect(await call('resume_invoice_reminders')).toMatchObject({ code: 'payer_owned' });
    state.invoice_followup_sequences[0].paused_reason = null;
    state.invoices[0].payer_id = 'payer-1';
    expect(await call('resume_invoice_reminders')).toMatchObject({ code: 'payer_owned' });
    expect(Invoices.followupControlFromBar).not.toHaveBeenCalled();
  });

  test('stop is marked irreversible on its card; pause is not', async () => {
    const stop = await call('stop_invoice_reminders');
    expect(buildContract({ toolName: 'stop_invoice_reminders', params: { invoice_id: INV }, displayParams: {}, preview: stop, summary: 'x' }).irreversible).toBe(true);
    const pause = await call('pause_invoice_reminders');
    expect(buildContract({ toolName: 'pause_invoice_reminders', params: { invoice_id: INV }, displayParams: {}, preview: pause, summary: 'x' }).irreversible).toBeFalsy();
  });

  test('resume on a future-due reminder does not promise an early send', async () => {
    state.invoice_followup_sequences[0].status = 'paused';
    state.invoice_followup_sequences[0].anchor_at = new Date('2099-06-01T12:00:00Z');
    expect(effectText(await call('resume_invoice_reminders'))).not.toMatch(/already passed/);
  });

  test('stop: allowed on an active or a paused sequence, final, names the combined-session release only when a session exists', async () => {
    const card = await call('stop_invoice_reminders', { reason: 'disputed' });
    expect(effectText(card)).toMatch(/stop for good\. The bar cannot restart a stopped reminder sequence/);
    expect(effectText(card)).not.toMatch(/combined card payment/);
    state.invoice_followup_sequences[0].status = 'paused';
    state.invoices[0].stripe_payment_intent_id = 'pi_test_1';
    const paused = await call('stop_invoice_reminders');
    expect(paused).toMatchObject({ preview: true, reminder_status: 'paused' });
    expect(effectText(paused)).toMatch(/combined card payment that is still unpaid, the bar does not stop it .* leaves the stop to the Invoices page/);
    expect(await confirm('stop_invoice_reminders', paused)).toMatchObject({ success: true, reminder_status: 'stopped' });
    expect(Invoices.followupControlFromBar).toHaveBeenCalledWith(expect.objectContaining({ control: 'stop', body: {} }));
  });

  test.each([
    ['pause_invoice_reminders', (s) => { s.invoice_followup_sequences = []; }, 'no_reminders'],
    ['pause_invoice_reminders', (s) => { s.invoice_followup_sequences[0].status = 'paused'; }, 'wrong_reminder_state'],
    ['pause_invoice_reminders', (s) => { s.invoice_followup_sequences[0].status = 'stopped'; }, 'wrong_reminder_state'],
    ['pause_invoice_reminders', (s) => { s.invoice_followup_sequences[0].status = 'autopay_hold'; }, 'wrong_reminder_state'],
    ['pause_invoice_reminders', (s) => { s.invoice_followup_sequences[0].touch_claimed_at = new Date(); }, 'send_in_progress'],
    ['pause_invoice_reminders', (s) => { s.invoices[0].status = 'paid'; }, 'invoice_terminal'],
    ['stop_invoice_reminders', (s) => { s.invoices[0].status = 'void'; }, 'invoice_terminal'],
    ['stop_invoice_reminders', (s) => { s.invoice_followup_sequences[0].status = 'stopped'; }, 'wrong_reminder_state'],
    ['resume_invoice_reminders', (s) => { s.invoice_followup_sequences[0].status = 'autopay_hold'; }, 'wrong_reminder_state'],
    ['resume_invoice_reminders', (s) => { s.invoice_followup_sequences[0].status = 'stopped'; }, 'wrong_reminder_state'],
  ])('%s is refused when the invoice or its reminders are not in a state the panel allows (%#)', async (name, mutate, code) => {
    mutate(state);
    expect(await call(name)).toMatchObject({ code });
    expect(Invoices.followupControlFromBar).not.toHaveBeenCalled();
  });

  test('a customer on combined reminders stays on the Invoices page', async () => {
    Wiring.customerScheduleSummary.mockResolvedValue({ id: 'sched-1', customerId: CUST, status: 'active', invoiceCount: 2 });
    for (const name of ['pause_invoice_reminders', 'stop_invoice_reminders', 'send_invoice_reminder_now']) {
      expect(await call(name)).toMatchObject({ code: 'combined_reminders' });
    }
    state.invoice_followup_sequences = [];
    Wiring.customerScheduleSummary.mockResolvedValue(null);
    Wiring.customerScheduleSummaryForInvoice.mockResolvedValue({ id: 'sched-1', customerId: CUST, status: 'active', invoiceCount: 2 });
    expect(await call('pause_invoice_reminders')).toMatchObject({ code: 'combined_reminders' });
  });

  test('an unreadable reminder state refuses (fail closed)', async () => {
    Wiring.customerScheduleSummary.mockRejectedValue(new Error('db down'));
    expect(await call('pause_invoice_reminders')).toMatchObject({ code: 'unverified' });
  });

  test('drift after the card refuses at Confirm and runs nothing', async () => {
    const card = await call('pause_invoice_reminders');
    state.invoice_followup_sequences[0].step_index = 1;
    expect(await confirm('pause_invoice_reminders', card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    state.invoice_followup_sequences[0].step_index = 0;
    state.invoices[0].updated_at = new Date('2099-01-02T00:00:00Z');
    expect(await confirm('pause_invoice_reminders', card)).toMatchObject({ code: 'preview_changed' });
    state.invoices[0].updated_at = new Date('2099-01-01T12:00:00.123Z');
    state.invoice_followup_sequences[0].status = 'paused';
    expect(await confirm('pause_invoice_reminders', card)).toMatchObject({ preview_changed: true });
    expect(await confirm('pause_invoice_reminders', card, { reason: 'a different reason' })).toMatchObject({ preview_changed: true });
    expect(Invoices.followupControlFromBar).not.toHaveBeenCalled();
  });

  test('resume after a stop that landed since the card: the handler refuses the pin (409 PREVIEW_CHANGED) and the card reports nothing changed', async () => {
    state.invoice_followup_sequences[0].status = 'paused';
    const card = await call('resume_invoice_reminders');
    // Another operator stops the reminders after the card was shown but before the service runs: the service sees the stop.
    Invoices.followupControlFromBar.mockImplementationOnce(async ({ approved }) => {
      state.invoice_followup_sequences[0].status = 'stopped';
      expect(approved).toEqual({ sequenceId: SEQ, status: 'paused', stepIndex: 0 });
      return { status: 409, json: { error: 'The invoice reminders changed after the card was shown, so nothing was changed.', code: 'PREVIEW_CHANGED' } };
    });
    const result = await confirm('resume_invoice_reminders', card);
    expect(result).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    expect(result.error).toMatch(/^Nothing was changed:/);
    expect(result.success).toBeUndefined();
    expect(state.invoice_followup_sequences[0].status).toBe('stopped');
  });

  test('a stop the service refuses because it would cancel a combined card session is reported as needing the Invoices page', async () => {
    const card = await call('stop_invoice_reminders');
    Invoices.followupControlFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'This invoice is part of another invoice’s combined card payment that is still unpaid. Stopping it cancels that payment session, which the bar does not do.', code: 'NEEDS_INVOICES_PAGE' } });
    const result = await confirm('stop_invoice_reminders', card);
    expect(result).toMatchObject({ failed: true, code: 'needs_invoices_page' });
    expect(result.error).toMatch(/Stop it from the Invoices page\.$/);
    expect(result.success).toBeUndefined();
  });

  test('a card for one tool cannot approve another', async () => {
    const card = await call('pause_invoice_reminders');
    expect(await confirm('stop_invoice_reminders', card)).toMatchObject({ preview_changed: true });
    expect(Invoices.followupControlFromBar).not.toHaveBeenCalled();
  });

  test('a refused handler is reported as failed; a throw is read back, never a blind retry', async () => {
    const card = await call('pause_invoice_reminders');
    Invoices.followupControlFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'nope' } });
    expect(await confirm('pause_invoice_reminders', card)).toMatchObject({ failed: true, error: 'The reminders were not changed: nope' });
    Invoices.followupControlFromBar.mockRejectedValueOnce(new Error('boom'));
    expect(await confirm('pause_invoice_reminders', card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    Invoices.followupControlFromBar.mockImplementationOnce(async () => { state.invoice_followup_sequences[0].status = 'paused'; throw new Error('late failure'); });
    expect(await confirm('pause_invoice_reminders', card)).toMatchObject({ success: true, warning: true, reminder_status: 'paused' });
    Invoices.followupControlFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true } });
    state.invoice_followup_sequences[0].status = 'active';
    Invoices.followupControlFromBar.mockImplementationOnce(async () => ({ status: 200, json: { ok: true } }));
    expect(await confirm('pause_invoice_reminders', card)).toMatchObject({ outcome_unknown: true, code: 'reminder_unverified' });
  });

  test('the contract: nothing is sent, nothing is irreversible-by-message', async () => {
    const card = await call('pause_invoice_reminders');
    const contract = buildContract({ toolName: 'pause_invoice_reminders', params: { invoice_id: INV }, displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/Nothing is sent/);
    expect(contract.notifies_customer).toBeFalsy();
  });
});

describe('send_invoice_reminder_now', () => {
  test('the preview shows each channel, the masked recipient and the exact message; nothing is sent', async () => {
    const card = await call('send_invoice_reminder_now');
    expect(card).toMatchObject({ preview: true, tool: 'send_invoice_reminder_now', invoice_number: 'WPC-2099-0002', customer_name: 'Robin Sample', amount_due: '$129.00', channels: 'text and email', sends_to_customer: true });
    expect(card.step).toMatch(/^1 of \d+/);
    expect(card.text_line).toBe('Text to ***0142: "Hi Robin, a friendly reminder about your $129.00 invoice: [pay link]" Not sent if the customer opted out of texts.');
    expect(card.email_line).toBe('Email to r***@example.com, subject "A friendly reminder about your invoice". Not sent if the customer’s email is suppressed.');
    expect(card.email_body).toBe('Hi Robin, your invoice WPC-2099-0002 has a balance of $129.00.');
    expect(JSON.stringify(card)).not.toMatch(/9415550142|robin\.sample@/);
    expect(effectText(card)).toMatch(/Sends reminder step 1 of \d+/);
    expect(effectText(card)).toMatch(/unless the customer opted out, the collections policy blocks it, or that step was already delivered/);
    expect(effectText(card)).toMatch(/8 AM to 8 PM Eastern text window is checked again when you confirm/);
    expect(Invoices.sendReminderNowFromBar).not.toHaveBeenCalled();
    const [render] = SmsTemplates.getTemplate.mock.calls;
    expect(render[1]).toMatchObject({ first_name: 'Robin', amount: '129.00', pay_url: '[pay link]' });
    expect(render[3]).toEqual({ noVariants: true, audit: false });
    const lines = cardLines('send_invoice_reminder_now', card);
    expect(lines.map((l) => l.text).join('\n')).toMatch(/Send the next reminder on invoice WPC-2099-0002 to Robin Sample now/);
    expect(lines.find((l) => l.more)).toMatchObject({ kind: 'comms' });
    const contract = buildContract({ toolName: 'send_invoice_reminder_now', params: { invoice_id: INV }, displayParams: {}, preview: card, summary: 'x' });
    expect(contract.notifies_customer).toBe(true);
    expect(contract.irreversible).toBe(true);
    expect(JSON.stringify(contract)).toMatch(/Text to \*\*\*0142/);
  });

  test('the card does not depend on the clock: a later minute fingerprints the same, so an open card still confirms', async () => {
    const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    try {
      jest.setSystemTime(new Date('2098-12-31T15:00:10Z'));
      const first = await call('send_invoice_reminder_now');
      jest.setSystemTime(new Date('2098-12-31T15:07:50Z'));
      const later = await call('send_invoice_reminder_now');
      expect(previewFingerprint(later)).toBe(previewFingerprint(first));
    } finally {
      jest.useRealTimers();
    }
  });

  test('the card pins the whole rendered email: a different greeting or amount changes the pin and the approval digest', async () => {
    const before = await call('send_invoice_reminder_now');
    EmailLibrary.renderTemplate.mockReturnValue({ subject: 'A friendly reminder about your invoice', text: 'Hi Robin, your invoice WPC-2099-0002 has a balance of $99.00.' });
    const after = await call('send_invoice_reminder_now');
    expect(after._approved.emailRenderedDigest).not.toBe(before._approved.emailRenderedDigest);
    expect(after._version.email_text).toBe(after._approved.emailRenderedDigest);
    expect(after._version.email_text).not.toBe(before._version.email_text);
  });

  test('only one channel when the customer has no phone, or no usable email', async () => {
    state.customers[0].phone = null;
    const emailOnly = await call('send_invoice_reminder_now');
    expect(emailOnly).toMatchObject({ channels: 'email' });
    expect(emailOnly.text_line).toBe('No text: no phone is on file.');
    // The approval names exactly the channels on the card: a missing channel is not offered to the send.
    expect(emailOnly._approved).toMatchObject({ channels: { sms: false, email: true }, smsBody: null, emailContentHash: 'hash-1' });
    state.customers[0].phone = '+19415550142';
    BillingEmailSender.operatorEmailRecipient.mockResolvedValue({ refusal: { reason: 'missing_email' } });
    const textOnly = await call('send_invoice_reminder_now');
    expect(textOnly).toMatchObject({ channels: 'text' });
    expect(textOnly.email_line).toBe('No email: no usable email is on file.');
    expect(textOnly.email_body).toBeNull();
    expect(textOnly._approved).toMatchObject({ channels: { sms: true, email: false }, emailContentHash: null });
    expect(textOnly._approved.smsBody).toMatch(/\[pay link\]$/);
    state.customers[0].phone = null;
    expect(await call('send_invoice_reminder_now')).toMatchObject({ code: 'invoice_no_channel' });
  });

  test.each([
    ['outside the 8 AM to 8 PM window', () => SendWindow.isWithinSendWindowET.mockReturnValue(false), 'outside_send_window'],
    ['a paused reminder', () => { state.invoice_followup_sequences[0].status = 'paused'; }, 'wrong_reminder_state'],
    ['a stopped reminder', () => { state.invoice_followup_sequences[0].status = 'stopped'; }, 'wrong_reminder_state'],
    ['no reminder sequence', () => { state.invoice_followup_sequences = []; }, 'no_reminders'],
    ['a reminder being sent', () => { state.invoice_followup_sequences[0].touch_claimed_at = new Date(); }, 'send_in_progress'],
    ['a paid invoice', () => { state.invoices[0].status = 'paid'; }, 'invoice_terminal'],
    ['a payer-billed invoice', () => { state.invoices[0].payer_id = 'payer-1'; }, 'payer_owned'],
    ['a payer found by the live resolver', () => PayerOwnership.invoicePayerOwnership.mockResolvedValue('payer_owned'), 'payer_owned'],
    ['an owner that cannot be verified', () => PayerOwnership.invoicePayerOwnership.mockRejectedValue(new Error('x')), 'unverified'],
    ['nothing due', () => { state.invoices[0].total = '20.00'; state.invoices[0].credit_applied = '20.00'; }, 'nothing_due'],
    ['a deleted customer', () => { state.customers[0].deleted_at = new Date(); }, 'customer_unavailable'],
    ['a collections hold', () => CollectionHold.customerHasActiveMessagingHoldChecked.mockResolvedValue(true), 'collection_hold'],
    ['a hold that cannot be read', () => CollectionHold.customerHasActiveMessagingHoldChecked.mockRejectedValue(new Error('x')), 'unverified'],
    ['account credit that would be applied first', () => CustomerCredit.autoApplyWouldApply.mockResolvedValue(true), 'credit_would_apply'],
    ['a reminder text with alternate wordings', () => SmsVariants.activeVariants.mockResolvedValue([{ id: 'v1', weight: 1 }]), 'text_varies'],
    ['a step past the last one', () => { state.invoice_followup_sequences[0].step_index = 99; }, 'nothing_to_send'],
  ])('refused: %s', async (_label, mutate, code) => {
    mutate();
    expect(await call('send_invoice_reminder_now')).toMatchObject({ code });
    expect(Invoices.sendReminderNowFromBar).not.toHaveBeenCalled();
  });

  test('the same refusals hold at Confirm, so a card cannot outlive the window', async () => {
    const card = await call('send_invoice_reminder_now');
    SendWindow.isWithinSendWindowET.mockReturnValue(false);
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ code: 'outside_send_window', preview_changed: true });
    expect(Invoices.sendReminderNowFromBar).not.toHaveBeenCalled();
  });

  test('Confirm sends once through the panel handler with the card’s invoice edit time and reminder step, and reports a send', async () => {
    const card = await call('send_invoice_reminder_now');
    const result = await confirm('send_invoice_reminder_now', card);
    expect(result).toMatchObject({ success: true, sent_to_customer: true, invoice_number: 'WPC-2099-0002' });
    expect(result.note).toMatch(/^Reminder step 1 of \d+.* Text: sent\. Email: sent\.$/);
    expect(result.legs).toEqual({ text: { state: 'sent' }, email: { state: 'sent' } });
    expect(Invoices.sendReminderNowFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.sendReminderNowFromBar).toHaveBeenCalledWith({
      invoiceId: INV, actor: { technicianId: 'staff-1' },
      approvedReminder: {
        invoiceUpdatedAtMs: new Date('2099-01-01T12:00:00.123Z').getTime(), sequenceId: SEQ, status: 'active', stepIndex: 0, emailContentHash: 'hash-1', dueCents: 12900,
        emailRenderedDigest: card._version.email_text,
        // What may go out, and the exact text: the send uses it as it is.
        channels: { sms: true, email: true }, smsBody: 'Hi Robin, a friendly reminder about your $129.00 invoice: [pay link]',
        // Digests only: the pin never carries the phone, the address or the text itself.
        phoneDigest: approvalDigest('19415550142'), emailDigest: approvalDigest('robin.sample@example.com'), smsDigest: approvalDigest(card.text_line.match(/"(.*)" Not sent/)[1]),
      },
    });
  });

  const answer = (reminder) => ({ status: 200, json: { ok: true, reminder } });

  test('the result is the handler’s per-channel outcome: a held text and a sent email', async () => {
    const card = await call('send_invoice_reminder_now');
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce(answer({ legs: { sms: { state: 'held', reason: 'collections_policy_denied' }, email: { state: 'sent' } } }));
    const result = await confirm('send_invoice_reminder_now', card);
    expect(result).toMatchObject({ success: true, sent_to_customer: true, legs: { text: { state: 'held' }, email: { state: 'sent' } } });
    expect(result.note).toMatch(/Text: held \(held by the collections policy\), not sent; the reminder stays on its schedule\. Email: sent\./);
  });

  test('both channels held by the collections policy before any sender ran: nothing was sent, not an unknown delivery', async () => {
    const card = await call('send_invoice_reminder_now');
    const held = { state: 'held', reason: 'collections_policy_denied' };
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce(answer({ legs: { sms: held, email: held } }));
    const result = await confirm('send_invoice_reminder_now', card);
    expect(result).toMatchObject({ success: true, sent_to_customer: false, code: 'not_sent' });
    expect(result).not.toHaveProperty('outcome_unknown');
    expect(result.note).toMatch(/^Nothing was sent to the customer\. Text: held \(held by the collections policy\), not sent; the reminder stays on its schedule\. Email: held/);
  });

  test('both channels known not to have gone out: "Nothing was sent", with each reason', async () => {
    const card = await call('send_invoice_reminder_now');
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce(answer({ legs: { sms: { state: 'not_sent', reason: 'CUSTOMER_OPTED_OUT' }, email: { state: 'skipped', reason: 'missing_email' } } }));
    const result = await confirm('send_invoice_reminder_now', card);
    expect(result).toMatchObject({ success: true, sent_to_customer: false, code: 'not_sent' });
    expect(result.note).toMatch(/^Nothing was sent to the customer\. Text: not sent \(CUSTOMER OPTED OUT\)\. Email: skipped \(no usable email on file\), not sent\.$/);
  });

  test('a leg delivered earlier is not called a new send, and a queued text is not called sent', async () => {
    const card = await call('send_invoice_reminder_now');
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce(answer({ legs: { sms: { state: 'queued', reason: 'send_window' }, email: { state: 'already_delivered' } } }));
    const result = await confirm('send_invoice_reminder_now', card);
    expect(result).toMatchObject({ success: true, sent_to_customer: false });
    expect(result.note).toMatch(/Text: queued \(it waits for the 8 AM text window\), not sent yet\. Email: already delivered earlier, not sent again\./);
  });

  test('an uncertain channel is "unknown, check the invoice timeline" — never "nothing went out" — even when the other channel sent', async () => {
    const card = await call('send_invoice_reminder_now');
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce(answer({ legs: { sms: { state: 'sent' }, email: { state: 'unknown', reason: 'provider_unconfirmed' } } }));
    const result = await confirm('send_invoice_reminder_now', card);
    expect(result).toMatchObject({ outcome_unknown: true, code: 'delivery_unknown', sent_to_customer: true });
    expect(result.error).toMatch(/Text: sent\. Email: unknown, check the invoice timeline/);
    expect(JSON.stringify(result)).not.toMatch(/Nothing (went out|was sent)/);
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce(answer({ legs: { sms: { state: 'unknown' }, email: { state: 'held', reason: 'collection_hold' } } }));
    const both = await confirm('send_invoice_reminder_now', card);
    expect(both).toMatchObject({ outcome_unknown: true, sent_to_customer: false });
    expect(JSON.stringify(both)).not.toMatch(/Nothing (went out|was sent)/);
  });

  test('no report from the handler (the run could not establish it) is unknown, not "not sent"', async () => {
    const card = await call('send_invoice_reminder_now');
    for (const reminder of [undefined, { legs: null }, { legs: { sms: { state: 'sent' } } }]) {
      Invoices.sendReminderNowFromBar.mockResolvedValueOnce(answer(reminder));
      const result = await confirm('send_invoice_reminder_now', card);
      expect(result).toMatchObject({ outcome_unknown: true, code: 'delivery_unknown' });
      expect(result.error).toMatch(/unknown\. Check the invoice timeline/);
      expect(result.success).toBeUndefined();
    }
  });

  test('a run that did not get the reminder (another run held it) says nothing was sent by this click', async () => {
    const card = await call('send_invoice_reminder_now');
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce(answer({ notClaimed: true }));
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ failed: true, code: 'reminder_busy', sent_to_customer: false });
  });

  test('a handler 409 PREVIEW_CHANGED, another refusal, and a throw each stop short of "sent"', async () => {
    const card = await call('send_invoice_reminder_now');
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'The invoice or its reminder changed', code: 'PREVIEW_CHANGED' } });
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    Invoices.sendReminderNowFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Not sent: this invoice is paid or its reminders are finished.', code: 'NOT_SENT' } });
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ failed: true, code: 'reminder_refused' });
    Invoices.sendReminderNowFromBar.mockRejectedValueOnce(new Error('provider timeout'));
    const thrown = await confirm('send_invoice_reminder_now', card);
    expect(thrown).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    expect(thrown.error).toMatch(/may or may not have gone out/);
  });

  test('drift in the message text, a recipient, the step or the amount refuses at Confirm', async () => {
    const card = await call('send_invoice_reminder_now');
    SmsTemplates.getTemplate.mockResolvedValue('A newly edited reminder text: [pay link]');
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ preview_changed: true });
    SmsTemplates.getTemplate.mockResolvedValue('Hi Robin, a friendly reminder about your $129.00 invoice: [pay link]');
    EmailLibrary.renderTemplate.mockReturnValue({ subject: 'A different subject', text: 'Hi Robin, your invoice WPC-2099-0002 has a balance of $129.00.' });
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ preview_changed: true });
    EmailLibrary.renderTemplate.mockReturnValue({ subject: 'A friendly reminder about your invoice', text: 'Hi Robin, your invoice WPC-2099-0002 has a balance of $129.00.' });
    state.customers[0].phone = '+19415550199';
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ preview_changed: true });
    state.customers[0].phone = '+19415550142';
    state.invoices[0].credit_applied = '10.00';
    state.invoices[0].updated_at = new Date('2099-01-03T00:00:00Z');
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ preview_changed: true });
    expect(Invoices.sendReminderNowFromBar).not.toHaveBeenCalled();
  });

  test('an HTML-block edit with the subject and plain text unchanged still refuses: the pin carries the whole email’s content hash', async () => {
    const card = await call('send_invoice_reminder_now');
    expect(card._approved.emailContentHash).toBe('hash-1');
    // The same rendered subject and text (renderTemplate is unchanged), a different template content hash.
    EmailLibrary.templateContentHash.mockReturnValue('hash-2');
    expect(await confirm('send_invoice_reminder_now', card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(Invoices.sendReminderNowFromBar).not.toHaveBeenCalled();
    // Back to the reviewed content: it sends, handing the service the hash to enforce at the email send.
    EmailLibrary.templateContentHash.mockReturnValue('hash-1');
    await confirm('send_invoice_reminder_now', card);
    expect(Invoices.sendReminderNowFromBar.mock.calls[0][0].approvedReminder.emailContentHash).toBe('hash-1');
  });

  test('a card with no email leg carries no hash', async () => {
    BillingEmailSender.operatorEmailRecipient.mockResolvedValue({ refusal: { reason: 'missing_email' } });
    const card = await call('send_invoice_reminder_now');
    expect(card._approved.emailContentHash).toBeNull();
  });

  test('a bank-verification invoice stays on the page, and an unreadable check refuses', async () => {
    const gatesModule = require('../config/feature-gates');
    const original = gatesModule.gates.divertMicrodepositDunning;
    gatesModule.gates.divertMicrodepositDunning = true;
    const Stripe = require('../services/stripe');
    const check = jest.spyOn(Stripe, 'isInvoiceAwaitingMicrodepositVerification').mockResolvedValue(true);
    try {
      state.invoices[0].stripe_payment_intent_id = 'pi_test_1';
      expect(await call('send_invoice_reminder_now')).toMatchObject({ code: 'bank_verification' });
      check.mockRejectedValue(new Error('stripe down'));
      expect(await call('send_invoice_reminder_now')).toMatchObject({ code: 'unverified' });
    } finally {
      check.mockRestore();
      gatesModule.gates.divertMicrodepositDunning = original;
    }
  });
});

describe('schedule_invoice_send', () => {
  beforeEach(() => { state.invoices[0].status = 'draft'; state.invoices[0].sent_at = null; });

  test('the preview shows the Eastern time, the channels and the masked recipients; nothing is scheduled', async () => {
    const card = await call('schedule_invoice_send', { send_at_et: FUTURE });
    expect(card).toMatchObject({ preview: true, tool: 'schedule_invoice_send', invoice_number: 'WPC-2099-0002', amount_due: '$129.00', channels: 'text and email', send_at_et: FUTURE, sends_to_customer: false });
    expect(card.send_at_text).toMatch(/9:30\s*AM ET$/);
    const text = effectText(card);
    expect(text).toMatch(/Nothing is sent now\. The invoice scheduler sends invoice WPC-2099-0002 \(\$129\.00 due\) at .*9:30\s*AM ET/);
    expect(text).toMatch(/pay-link text to \*\*\*0142 and the invoice email to r\*\*\*@example\.com/);
    expect(text).toMatch(/text waits for the 8 AM to 8 PM Eastern window/);
    expect(text).toMatch(/No review request is asked for/);
    expect(JSON.stringify(card)).not.toMatch(/9415550142|robin\.sample@/);
    expect(Invoices.scheduleSendFromBar).not.toHaveBeenCalled();
    expect(cardLines('schedule_invoice_send', card).map((l) => l.text).join('\n')).toMatch(/Schedule invoice WPC-2099-0002 for Robin Sample \(\$129\.00 due\) to send at/);
    const contract = buildContract({ toolName: 'schedule_invoice_send', params: { invoice_id: INV, send_at_et: FUTURE }, displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/Nothing is sent now/);
  });

  test('an already-scheduled invoice is rescheduled, and the card names the old time', async () => {
    state.invoices[0].status = 'scheduled';
    state.invoices[0].scheduled_send_at = new Date('2099-01-10T14:00:00Z');
    expect(effectText(await call('schedule_invoice_send', { send_at_et: FUTURE }))).toMatch(/it replaces the time/);
  });

  test.each([
    ['a sent invoice', () => { state.invoices[0].status = 'sent'; }, { send_at_et: FUTURE }, 'not_schedulable'],
    ['a paid invoice', () => { state.invoices[0].status = 'paid'; }, { send_at_et: FUTURE }, 'not_schedulable'],
    ['no time', () => {}, {}, 'invalid_time'],
    ['a time with a zone', () => {}, { send_at_et: '2099-01-15T09:30:00Z' }, 'invalid_time'],
    ['a made-up date', () => {}, { send_at_et: '2099-13-45T09:30' }, 'invalid_time'],
    ['a time in the past', () => {}, { send_at_et: '2020-01-15T09:30' }, 'time_not_future'],
    ['a time the clocks fall back over (1:30 AM happens twice)', () => {}, { send_at_et: '2099-11-01T01:30' }, 'invalid_time'],
    ['a time the clocks spring forward over (2:30 AM never happens)', () => {}, { send_at_et: '2099-03-08T02:30' }, 'invalid_time'],
    ['a payer statement', () => { state.invoices[0].payer_statement_id = 'stmt-1'; }, { send_at_et: FUTURE }, 'payer_statement'],
    ['a payer-billed invoice', () => { state.invoices[0].payer_id = 'payer-1'; }, { send_at_et: FUTURE }, 'payer_owned'],
    ['a payer found by the live resolver', () => PayerOwnership.invoicePayerOwnership.mockResolvedValue('payer_owned'), { send_at_et: FUTURE }, 'payer_owned'],
    ['nothing due', () => { state.invoices[0].total = '0.00'; }, { send_at_et: FUTURE }, 'nothing_due'],
    ['no phone and no email', () => Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ customerName: 'Robin Sample', primaryContact: { phone: '' }, emailRecipient: null }), { send_at_et: FUTURE }, 'invoice_no_channel'],
  ])('refused: %s', async (_label, mutate, input, code) => {
    mutate();
    expect(await call('schedule_invoice_send', input)).toMatchObject({ code });
    expect(Invoices.scheduleSendFromBar).not.toHaveBeenCalled();
  });

  test('only the channel that has a recipient is named', async () => {
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ customerName: 'Robin Sample', primaryContact: { phone: '' }, emailRecipient: { email: 'robin.sample@example.com' } });
    const card = await call('schedule_invoice_send', { send_at_et: FUTURE });
    expect(card.channels).toBe('email');
    expect(effectText(card)).toMatch(/no phone on file, so no text/);
  });

  test('Confirm schedules once through the handler with the card’s time and invoice edit time', async () => {
    const card = await call('schedule_invoice_send', { send_at_et: FUTURE });
    const result = await confirm('schedule_invoice_send', card, { send_at_et: FUTURE });
    expect(result).toMatchObject({ success: true, status: 'scheduled', sent_to_customer: false });
    expect(result.note).toMatch(/Nothing was sent now/);
    expect(Invoices.scheduleSendFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.scheduleSendFromBar).toHaveBeenCalledWith({
      invoiceId: INV, body: { scheduledFor: FUTURE }, actor: { technicianId: 'staff-1' },
      approvedSchedule: { updatedAtMs: new Date('2099-01-01T12:00:00.123Z').getTime() },
    });
  });

  test('a different time at Confirm, a changed invoice, or changed recipients refuse', async () => {
    const card = await call('schedule_invoice_send', { send_at_et: FUTURE });
    expect(await confirm('schedule_invoice_send', card, { send_at_et: '2099-01-15T10:30' })).toMatchObject({ preview_changed: true });
    state.invoices[0].updated_at = new Date('2099-01-03T00:00:00Z');
    expect(await confirm('schedule_invoice_send', card, { send_at_et: FUTURE })).toMatchObject({ preview_changed: true });
    state.invoices[0].updated_at = new Date('2099-01-01T12:00:00.123Z');
    Invoices.getInvoiceDeliveryRecipients.mockResolvedValue({ customerName: 'Robin Sample', primaryContact: { phone: '+19415550199' }, emailRecipient: { email: 'robin.sample@example.com' } });
    expect(await confirm('schedule_invoice_send', card, { send_at_et: FUTURE })).toMatchObject({ preview_changed: true });
    expect(Invoices.scheduleSendFromBar).not.toHaveBeenCalled();
  });

  test('a handler 409, a mismatched answer and a throw are reported honestly', async () => {
    const card = await call('schedule_invoice_send', { send_at_et: FUTURE });
    const run = () => confirm('schedule_invoice_send', card, { send_at_et: FUTURE });
    Invoices.scheduleSendFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'The invoice changed after the card was shown, so nothing was scheduled.', code: 'PREVIEW_CHANGED' } });
    expect(await run()).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    Invoices.scheduleSendFromBar.mockResolvedValueOnce({ status: 400, json: { error: 'scheduledFor must be in the future' } });
    expect(await run()).toMatchObject({ failed: true, code: 'schedule_refused' });
    Invoices.scheduleSendFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, invoice: { id: INV, status: 'scheduled', scheduled_send_at: new Date('2099-02-01T00:00:00Z') } } });
    expect(await run()).toMatchObject({ outcome_unknown: true, code: 'schedule_unverified' });
    Invoices.scheduleSendFromBar.mockRejectedValueOnce(new Error('boom'));
    expect(await run()).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });
});
