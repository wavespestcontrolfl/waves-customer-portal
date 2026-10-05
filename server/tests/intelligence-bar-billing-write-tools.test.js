/**
 * IB billing writes: remove_saved_payment_method (with the staff Auto Pay-off
 * step) and correct_invoice_address. Pins: the unconfirmed call is a plan that
 * changes nothing; Auto Pay in use asks instead of acting; the confirmed run
 * executes exactly the pinned steps in order and reports each one; drift and a
 * wrong role refuse.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), ibStaffAutopayOffLive: jest.fn(() => true) }));
jest.mock('../services/autopay-eligibility', () => ({
  ...jest.requireActual('../services/autopay-eligibility'),
  getAutopaySelectedMethodIds: jest.fn(),
}));
jest.mock('../services/autopay-disable', () => ({
  AUTOPAY_OFF_UPDATES: { autopay_enabled: false, autopay_paused_until: null, autopay_pause_reason: null },
  disableAutopayInTransaction: jest.fn(),
  sendAutopayDisabledNotice: jest.fn(),
}));
jest.mock('../services/payment-method-removal', () => ({ removePaymentMethod: jest.fn(), removalPreview: jest.fn() }));
jest.mock('../services/payment-method-removal-audit', () => ({ auditStaffPaymentMethodRemoval: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const db = require('../models/db');
const { isEnabled, ibStaffAutopayOffLive } = require('../config/feature-gates');
const { getAutopaySelectedMethodIds } = require('../services/autopay-eligibility');
const { disableAutopayInTransaction, sendAutopayDisabledNotice } = require('../services/autopay-disable');
const { removePaymentMethod, removalPreview } = require('../services/payment-method-removal');
const { auditStaffPaymentMethodRemoval } = require('../services/payment-method-removal-audit');
const { recordAuditEvent } = require('../services/audit-log');
const InvoiceAddress = require('../services/invoice-address');
const { BILLING_WRITE_TOOLS, executeBillingWriteTool } = require('../services/intelligence-bar/billing-write-tools');
const gates = require('../services/intelligence-bar/write-gates');
const OwnerDirect = require('../services/intelligence-bar/owner-direct');
const { buildContract, previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
const ActionRegistry = require('../services/intelligence-bar/action-registry');
const policy = require('../services/intelligence-bar/action-policy.json');

const CUST = '00000000-0000-0000-0000-00000000a001';
const PM1 = '00000000-0000-0000-0000-00000000b001';
const PM2 = '00000000-0000-0000-0000-00000000b002';
const INV = '00000000-0000-0000-0000-00000000c001';

const CARD1 = { id: PM1, customer_id: CUST, method_type: 'card', card_brand: 'Visa', last_four: '4242', exp_month: 12, exp_year: 2032, is_default: true, autopay_enabled: true };
const CARD2 = { id: PM2, customer_id: CUST, method_type: 'card', card_brand: 'Mastercard', last_four: '1881', exp_month: 3, exp_year: 2030, is_default: false, autopay_enabled: false };
const BANK = { id: PM2, customer_id: CUST, method_type: 'us_bank_account', bank_name: 'Synthetic Bank', bank_last_four: '6789', ach_status: 'verified', is_default: false };

let tables;
function chainFor(table) {
  const c = {
    where: () => c, whereNull: () => c, orderBy: () => c, forUpdate: () => c,
    first: async () => (tables[table] || [])[0],
    then: (resolve, reject) => Promise.resolve(tables[table] || []).then(resolve, reject),
  };
  return c;
}

const base = () => ({
  customers: [{ id: CUST, first_name: 'Card', last_name: 'Fixture', email: 'card@example.com', autopay_enabled: true, autopay_payment_method_id: PM1, autopay_paused_until: null }],
  payment_methods: [CARD1],
  notification_prefs: [],
});

let calls;
beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  ibStaffAutopayOffLive.mockReturnValue(true);
  tables = base();
  calls = [];
  db.mockImplementation(chainFor);
  db.transaction = jest.fn(async (work) => work(chainFor));
  getAutopaySelectedMethodIds.mockResolvedValue([PM1]);
  removalPreview.mockResolvedValue({ holdsAppointment: null, holdLookupFailed: false });
  disableAutopayInTransaction.mockImplementation(async () => { calls.push('disable'); return { transition: true, methodId: PM1 }; });
  sendAutopayDisabledNotice.mockImplementation(async () => { calls.push('notice'); });
  removePaymentMethod.mockImplementation(async () => { calls.push('remove'); return { status: 200, body: { success: true }, removedMethod: CARD1 }; });
  auditStaffPaymentMethodRemoval.mockResolvedValue(undefined);
});

const run = (name, input, ctx) => executeBillingWriteTool(name, input, ctx);
const plan = (input) => run('remove_saved_payment_method', { customer_id: CUST, ...input });
const confirmed = async (input, over = {}) => {
  const preview = await plan(input);
  return run('remove_saved_payment_method', { customer_id: CUST, ...input }, {
    confirmed: true, technicianId: 'admin-1', executionPins: { _verified_removal_plan: preview, ...over },
  });
};

describe('registration', () => {
  test('both are two-step carded writes, never owner-direct, admin-only, scope record', () => {
    for (const name of ['remove_saved_payment_method', 'correct_invoice_address']) {
      expect(BILLING_WRITE_TOOLS.some((t) => t.name === name)).toBe(true);
      expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
      expect(OwnerDirect.OWNER_DIRECT_TOOL_NAMES.has(name)).toBe(false);
      expect(OwnerDirect.executesWithoutCard(name, {}, {})).toBe(false);
      expect(policy[name]).toMatchObject({ module: 'billing-write-tools.js', role: 'admin', approval: 'ui_confirm', scope: 'record' });
      expect(JSON.stringify(BILLING_WRITE_TOOLS.find((t) => t.name === name).input_schema)).not.toContain('confirmed');
    }
    const props = BILLING_WRITE_TOOLS[0].input_schema.properties;
    expect(props.customer_id.format).toBe('uuid');
    expect(props.payment_method_id.format).toBe('uuid');
    expect(BILLING_WRITE_TOOLS[1].input_schema.properties.invoice_id.format).toBe('uuid');
  });

  test('a technician is refused by the registry and the schema rejects extra fields (no model-supplied approval)', async () => {
    const asTech = await ActionRegistry.execute('remove_saved_payment_method', { customer_id: CUST }, { role: 'technician', context: 'tech', techContext: { techId: 't-1' } });
    expect(asTech).toMatchObject({ code: 'permission_denied' });
    const asTechAddress = await ActionRegistry.execute('correct_invoice_address', { invoice_id: INV }, { role: 'technician', context: 'tech', techContext: { techId: 't-1' } });
    expect(asTechAddress).toMatchObject({ code: 'permission_denied' });
    const extra = await ActionRegistry.execute('remove_saved_payment_method', { customer_id: CUST, confirmed: true }, { role: 'admin', context: 'customers' });
    expect(extra).toMatchObject({ code: 'invalid_input' });
  });
});

describe('remove_saved_payment_method — the plan changes nothing', () => {
  test('a lone card not used by Auto Pay: one removal step, the method facts, and the portal notices named', async () => {
    getAutopaySelectedMethodIds.mockResolvedValue([]);
    tables.customers[0].autopay_enabled = false;
    const preview = await plan({});
    expect(preview).toMatchObject({
      preview: true, customer_id: CUST, customer_name: 'Card Fixture',
      method: { id: PM1, label: 'Visa ending 4242', expires: '12/2032', last_four: '4242' },
      autopay: { state: 'off', uses_this_method: false },
      notifies_customer: true,
    });
    expect(preview.steps).toEqual([expect.objectContaining({ position: 1, step: 'remove_payment_method', method_id: PM1 })]);
    expect(preview.customer_emails.summary).toContain('c***@example.com');
    expect(preview.customer_emails.notices).toEqual(['Payment method removed']);
    expect(disableAutopayInTransaction).not.toHaveBeenCalled();
    expect(removePaymentMethod).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('the customer-email line is honest: gate off, or no email on file, means nothing is emailed', async () => {
    getAutopaySelectedMethodIds.mockResolvedValue([]);
    tables.customers[0].autopay_enabled = false;
    isEnabled.mockReturnValue(false);
    let preview = await plan({});
    expect(preview.notifies_customer).toBe(false);
    expect(preview.customer_emails.summary).toMatch(/switched off \(GATE_PAYMENT_METHOD_CHANGE_EMAILS\)/);
    isEnabled.mockReturnValue(true);
    tables.customers[0].email = null;
    preview = await plan({});
    expect(preview.notifies_customer).toBe(false);
    expect(preview.customer_emails.summary).toMatch(/no email address on file/);
  });

  test('removal notes: a verified bank warns about the 3-business-day stop; a card holding a future visit names it and the fee; a failed lookup says so', async () => {
    getAutopaySelectedMethodIds.mockResolvedValue([]);
    tables.payment_methods = [BANK];
    let preview = await plan({});
    expect(preview.disclosures.bank_note).toMatch(/up to 3 business days/);
    expect(preview.method).toMatchObject({ kind: 'bank', label: 'Synthetic Bank ending 6789', verified_bank: true });

    tables.payment_methods = [CARD1];
    removalPreview.mockResolvedValue({ holdsAppointment: { start: '2026-10-08T13:00:00.000Z', serviceType: 'Pest Control', feeAmount: 49 }, holdLookupFailed: false });
    preview = await plan({});
    expect(preview.disclosures.holds_appointment).toMatchObject({ service_type: 'Pest Control', fee_amount: 49 });
    expect(preview.disclosures.holds_appointment.text).toMatch(/does not cancel the visit or the \$49\.00 late-cancel fee.*can no longer be charged to this card/);

    removalPreview.mockResolvedValue({ holdsAppointment: null, holdLookupFailed: true });
    preview = await plan({});
    expect(preview.disclosures).toMatchObject({ hold_lookup_failed: true, holds_appointment: null });
  });

  test('several methods and none named: lists them with whether Auto Pay uses each, and asks which — no card', async () => {
    tables.payment_methods = [CARD1, CARD2];
    const res = await plan({});
    expect(res).toMatchObject({ code: 'method_required' });
    expect(res.preview).toBeUndefined();
    expect(res.methods).toEqual([
      expect.objectContaining({ payment_method_id: PM1, label: 'Visa ending 4242', autopay_uses_it: true }),
      expect.objectContaining({ payment_method_id: PM2, label: 'Mastercard ending 1881', autopay_uses_it: false }),
    ]);
  });

  test("another customer's method, no methods, no customer: refused with nothing proposed", async () => {
    expect(await plan({ payment_method_id: PM2 })).toMatchObject({ code: 'method_not_found' });
    tables.payment_methods = [];
    expect(await plan({})).toMatchObject({ code: 'no_saved_methods' });
    tables.customers = [];
    expect(await plan({})).toMatchObject({ code: 'customer_not_found' });
  });

  test('Auto Pay is using the method and the operator has not said to turn it off: ask in the bar, never refuse to another screen', async () => {
    const res = await plan({});
    expect(res).toMatchObject({ code: 'autopay_uses_method', autopay_uses_method: true });
    expect(res.preview).toBeUndefined();
    expect(res.error).toMatch(/Ask the operator, here in the bar/);
    expect(res.error).toMatch(/turn_off_autopay: true/);
    expect(res.error).toMatch(/Do not send them to another screen/);
    expect(res.error).not.toMatch(/Customer 360|Billing page|portal/i);
  });

  test('a paused Auto Pay that is using the method is said to be paused, not off', async () => {
    tables.customers[0].autopay_paused_until = '2099-01-01';
    expect((await plan({})).error).toMatch(/paused, not off/);
  });

  test('with the gate off the in-use card cannot be removed from the bar — plainly stated, nothing changed', async () => {
    ibStaffAutopayOffLive.mockReturnValue(false);
    for (const flag of [false, true]) {
      const res = await plan({ turn_off_autopay: flag });
      expect(res).toMatchObject({ code: 'autopay_off_not_enabled' });
      expect(res.error).toMatch(/GATE_IB_STAFF_AUTOPAY_OFF/);
    }
  });

  test('turn_off_autopay true while Auto Pay uses the method: ONE plan, two ordered steps, both notices named', async () => {
    const preview = await plan({ turn_off_autopay: true });
    expect(preview.steps.map((s) => [s.position, s.step])).toEqual([[1, 'turn_off_autopay'], [2, 'remove_payment_method']]);
    expect(preview.steps[0].effect).toMatch(/^Step 1 of 2: Turn Auto Pay OFF for the whole account/);
    expect(preview.steps[1].effect).toMatch(/^Step 2 of 2: Remove Visa ending 4242/);
    expect(preview.customer_emails.notices).toEqual(['Auto Pay turned off', 'Payment method removed']);
    expect(preview.autopay).toMatchObject({ state: 'on', uses_this_method: true, method_ids: [PM1] });
    expect(disableAutopayInTransaction).not.toHaveBeenCalled();
  });

  test('turn_off_autopay true but Auto Pay runs on a DIFFERENT method: left alone, removal only, and the plan says why', async () => {
    tables.payment_methods = [CARD1, CARD2];
    getAutopaySelectedMethodIds.mockResolvedValue([PM1]);
    const preview = await plan({ payment_method_id: PM2, turn_off_autopay: true });
    expect(preview.steps.map((s) => s.step)).toEqual(['remove_payment_method']);
    expect(preview.autopay_note).toMatch(/different payment method.*left on and unchanged/);
    expect(preview.customer_emails.notices).toEqual(['Payment method removed']);
  });

  test('turn_off_autopay true but Auto Pay is already off: the plan is the removal only and says so', async () => {
    tables.customers[0].autopay_enabled = false;
    getAutopaySelectedMethodIds.mockResolvedValue([]);
    const preview = await plan({ turn_off_autopay: true });
    expect(preview.steps.map((s) => s.step)).toEqual(['remove_payment_method']);
    expect(preview.autopay_note).toMatch(/already off/);
  });

  test('an unreadable Auto Pay state is a refusal, never a guess (fail closed like the removal guard)', async () => {
    getAutopaySelectedMethodIds.mockRejectedValue(new Error('read failed'));
    expect(await plan({})).toMatchObject({ code: 'autopay_unreadable' });
    expect(getAutopaySelectedMethodIds).toHaveBeenCalledWith(expect.anything(), db, { rethrow: true });
  });
});

describe('remove_saved_payment_method — the confirmed run', () => {
  test('runs exactly the pinned steps in order (off, notice, remove, audit) and itemizes them', async () => {
    const res = await confirmed({ turn_off_autopay: true });
    expect(calls).toEqual(['disable', 'notice', 'remove']);
    expect(disableAutopayInTransaction).toHaveBeenCalledWith(expect.anything(), CUST, expect.objectContaining({
      details: { source: 'intelligence_bar', actor_id: 'admin-1' },
      updates: { autopay_enabled: false, autopay_paused_until: null, autopay_pause_reason: null },
    }));
    expect(sendAutopayDisabledNotice).toHaveBeenCalledWith({ customerId: CUST, paymentMethodId: PM1 });
    // The Auto Pay guard stays ON: the removal is the shared guarded path.
    expect(removePaymentMethod).toHaveBeenCalledWith({ customerId: CUST, methodId: PM1, guard: true, source: 'intelligence_bar' });
    expect(auditStaffPaymentMethodRemoval).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-1', customerId: CUST, removedMethod: CARD1, extraMetadata: { via: 'intelligence_bar' } }));
    expect(res).toMatchObject({ success: true, state: { autopay_turned_off: true, card_removed: true } });
    expect(res.receipt.map((r) => [r.step, r.status])).toEqual([['turn_off_autopay', 'completed'], ['remove_payment_method', 'completed']]);
  });

  test('a removal-only plan never touches Auto Pay', async () => {
    getAutopaySelectedMethodIds.mockResolvedValue([]);
    tables.customers[0].autopay_enabled = false;
    const res = await confirmed({});
    expect(calls).toEqual(['remove']);
    expect(res.success).toBe(true);
  });

  test('no Auto Pay-off notice when the disable was not a real transition', async () => {
    disableAutopayInTransaction.mockImplementation(async () => { calls.push('disable'); return { transition: false, methodId: PM1 }; });
    const res = await confirmed({ turn_off_autopay: true });
    expect(sendAutopayDisabledNotice).not.toHaveBeenCalled();
    expect(res.receipt[0].detail).toMatch(/already off/);
  });

  test('Auto Pay off fails: the removal is NOT attempted and the result says nothing completed', async () => {
    disableAutopayInTransaction.mockRejectedValue(new Error('db down'));
    const res = await confirmed({ turn_off_autopay: true });
    expect(removePaymentMethod).not.toHaveBeenCalled();
    expect(res).toMatchObject({ failed: true, error: 'No step completed.' });
    expect(res.receipt.map((r) => [r.step, r.status])).toEqual([['turn_off_autopay', 'failed'], ['remove_payment_method', 'not_attempted']]);
    expect(res.state).toEqual({ autopay_turned_off: false, card_removed: false });
  });

  test.each([
    ['a Stripe detach refusal', async () => { throw new Error('Could not remove the payment method — please try again.'); }, /Could not remove the payment method/],
    ['the guard refusing', async () => ({ status: 409, body: { code: 'autopay_method_in_use', error: 'This payment method is currently used for Auto Pay.' }, removedMethod: null }), /currently used for Auto Pay/],
  ])('Auto Pay off succeeds, then %s: reported exactly — Auto Pay is off, the card is still on file', async (_label, impl, detail) => {
    removePaymentMethod.mockImplementation(impl);
    const res = await confirmed({ turn_off_autopay: true });
    expect(res.partial).toBe(true);
    expect(res.state).toEqual({ autopay_turned_off: true, card_removed: false });
    expect(res.receipt.map((r) => [r.step, r.status])).toEqual([['turn_off_autopay', 'completed'], ['remove_payment_method', 'failed']]);
    expect(res.receipt[1].detail).toMatch(detail);
    expect(res.note).toMatch(/Auto Pay is OFF, but Visa ending 4242 is still on file/);
    expect(auditStaffPaymentMethodRemoval).not.toHaveBeenCalled();
  });

  test('a lost audit row never fails a completed removal', async () => {
    auditStaffPaymentMethodRemoval.mockRejectedValue(new Error('audit down'));
    const res = await confirmed({ turn_off_autopay: true });
    await new Promise((r) => setImmediate(r));
    expect(res.success).toBe(true);
  });

  test('no verified plan, or a plan that no longer matches (Auto Pay moved to another method), refuses before any write', async () => {
    const preview = await plan({ turn_off_autopay: true });
    const ctx = (pins) => ({ confirmed: true, technicianId: 'admin-1', executionPins: pins });
    expect(await run('remove_saved_payment_method', { customer_id: CUST, turn_off_autopay: true }, ctx({}))).toMatchObject({ preview_changed: true });
    // Auto Pay moved: the live plan now reads a different in-use method set.
    tables.payment_methods = [CARD1, CARD2];
    getAutopaySelectedMethodIds.mockResolvedValue([PM2]);
    const drifted = await run('remove_saved_payment_method', { customer_id: CUST, payment_method_id: PM1, turn_off_autopay: true }, ctx({ _verified_removal_plan: preview }));
    // PM1 is no longer in use, so the live plan has the removal step alone.
    expect(drifted).toMatchObject({ preview_changed: true });
    expect(disableAutopayInTransaction).not.toHaveBeenCalled();
    expect(removePaymentMethod).not.toHaveBeenCalled();
  });

  test('Auto Pay changing between the re-plan and the lock rolls the off step back untouched; the removal is not attempted', async () => {
    const preview = await plan({ turn_off_autopay: true });
    getAutopaySelectedMethodIds.mockReset();
    getAutopaySelectedMethodIds.mockResolvedValueOnce([PM1]).mockResolvedValueOnce([PM2]);
    const res = await run('remove_saved_payment_method', { customer_id: CUST, turn_off_autopay: true }, {
      confirmed: true, technicianId: 'admin-1', executionPins: { _verified_removal_plan: preview },
    });
    expect(disableAutopayInTransaction).not.toHaveBeenCalled();
    expect(removePaymentMethod).not.toHaveBeenCalled();
    expect(res.receipt.map((r) => [r.step, r.status])).toEqual([['turn_off_autopay', 'failed'], ['remove_payment_method', 'not_attempted']]);
    expect(res.receipt[0].detail).toMatch(/Auto Pay changed since the card was shown/);
  });
});

describe('remove_saved_payment_method — the card the operator approves', () => {
  test('the contract lists the ordered steps, names the emails, and is irreversible; the fingerprint binds the Auto Pay state and step order', async () => {
    const preview = await plan({ turn_off_autopay: true });
    const contract = buildContract({ toolName: 'remove_saved_payment_method', params: { customer_id: CUST, payment_method_id: PM1, turn_off_autopay: true }, displayParams: {}, preview, summary: 's' });
    const labels = contract.effects.map((e) => e.label);
    expect(labels.findIndex((l) => l.startsWith('Step 1 of 2'))).toBeLessThan(labels.findIndex((l) => l.startsWith('Step 2 of 2')));
    expect(contract.effects).toContainEqual(expect.objectContaining({ kind: 'comms', label: expect.stringContaining('"Auto Pay turned off", then "Payment method removed"') }));
    expect(contract).toMatchObject({ tier: 'yellow', action_label: 'Remove a saved payment method', irreversible: true, notifies_customer: true });
    // Different Auto Pay state / step list = different approval.
    const removalOnly = await plan({});
    expect(previewFingerprint(removalOnly)).not.toBe(previewFingerprint(preview));
    expect(previewFingerprint(await plan({ turn_off_autopay: true }))).toBe(previewFingerprint(preview));
    getAutopaySelectedMethodIds.mockResolvedValue([PM1, PM2]);
    expect(previewFingerprint(await plan({ turn_off_autopay: true }))).not.toBe(previewFingerprint(preview));
  });

  test('when no email can go out the contract says no customer contact', async () => {
    isEnabled.mockReturnValue(false);
    const preview = await plan({ turn_off_autopay: true });
    const contract = buildContract({ toolName: 'remove_saved_payment_method', params: {}, displayParams: {}, preview, summary: 's' });
    expect(contract.notifies_customer).toBe(false);
    expect(contract.effects).toContainEqual(expect.objectContaining({ label: expect.stringContaining('No customer email') }));
  });
});

describe('correct_invoice_address', () => {
  const NEW = { address_line1: '9 New Street  Apt 4', city: 'Bradenton', state: 'fl', zip: '34203' };
  const invoice = (over = {}) => ({
    id: INV, invoice_number: 'WPC-2099-0001', status: 'paid', customer_id: CUST,
    customer_address_snapshot: { address_line1: '1 Old Street', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34201' }, ...over,
  });
  const seed = (inv = invoice()) => {
    tables.invoices = [inv];
    tables.customers = [{ id: CUST, first_name: 'Card', last_name: 'Fixture', address_line1: '55 Live Ave', city: 'Venice', state: 'FL', zip: '34285' }];
  };
  let audited;
  beforeEach(() => {
    seed();
    audited = jest.spyOn(InvoiceAddress, 'correctInvoiceAddressAudited').mockResolvedValue({
      invoice: invoice(), before: {}, after: { address_line1: '9 New Street Apt 4', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34203', corrected_at: 'x' },
    });
  });
  afterEach(() => audited.mockRestore());
  const prev = (input = {}) => run('correct_invoice_address', { invoice_id: INV, ...NEW, ...input });

  test('the plan shows the address printed now and the corrected one, states what it does and does not do, and writes nothing', async () => {
    const preview = await prev();
    expect(preview).toMatchObject({
      preview: true, invoice_id: INV, invoice_number: 'WPC-2099-0001', invoice_status: 'paid', customer_name: 'Card Fixture',
      address_printed_now: { address_line1: '1 Old Street', city: 'Sarasota' },
      address_after_correction: { address_line1: '9 New Street Apt 4', city: 'Bradenton', state: 'FL', zip: '34203', address_line2: null },
      printed_now_text: '1 Old Street Sarasota, FL 34201',
    });
    expect(preview.does).toMatch(/Rewrites only this invoice's address snapshot/);
    expect(preview.does_not).toMatch(/Amounts, status, the customer's profile, saved properties and payer bill-to are untouched, and nothing is re-sent/);
    expect(audited).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('invoice_number resolves the invoice; exactly one identifier is required', async () => {
    expect((await run('correct_invoice_address', { invoice_number: ' WPC-2099-0001 ', ...NEW })).invoice_id).toBe(INV);
    expect(await run('correct_invoice_address', { ...NEW })).toMatchObject({ error: 'Give exactly one of invoice_id or invoice_number.' });
    expect(await prev({ invoice_number: 'WPC-2099-0001' })).toMatchObject({ error: 'Give exactly one of invoice_id or invoice_number.' });
    tables.invoices = [];
    expect(await prev()).toMatchObject({ code: 'invoice_not_found' });
  });

  test("validation is the route's own: a bad ZIP or state, or a missing street, is refused with nothing proposed", async () => {
    expect(await prev({ zip: 'abc' })).toMatchObject({ code: 'invalid_address', error: expect.stringMatching(/ZIP/) });
    expect(await prev({ state: 'Florida' })).toMatchObject({ code: 'invalid_address' });
    expect(await prev({ address_line1: '  ' })).toMatchObject({ code: 'invalid_address' });
  });

  test('a void invoice is refused; an address the invoice already prints is a no-op, not a card', async () => {
    seed(invoice({ status: 'void' }));
    expect(await prev()).toMatchObject({ code: 'invoice_void' });
    seed();
    expect(await prev({ address_line1: '1 Old Street', city: 'Sarasota', state: 'FL', zip: '34201' })).toMatchObject({ code: 'no_change' });
  });

  test('confirm writes through the shared audited correction (one transaction, critical audit row) and says nothing was re-sent', async () => {
    const preview = await prev();
    const res = await run('correct_invoice_address', { invoice_id: INV, ...NEW }, { confirmed: true, technicianId: 'admin-1', executionPins: { _verified_address_correction: preview } });
    expect(audited).toHaveBeenCalledWith(db, INV, expect.objectContaining(NEW), {
      actorId: 'admin-1', via: 'intelligence_bar', expect: { before: expect.objectContaining({ address_line1: '1 Old Street' }) },
    });
    expect(res).toMatchObject({ success: true, invoice_number: 'WPC-2099-0001', address_now: { address_line1: '9 New Street Apt 4' }, address_before: { address_line1: '1 Old Street' } });
    expect(res.note).toMatch(/nothing was re-sent to the customer/);
    // A paid invoice: the bar is told to offer the resend (its own card), never to send it.
    expect(res.next_step).toMatch(/resend_receipt/);
  });
  test('an unpaid invoice gets no resend offer: there is no receipt to send', async () => {
    seed(invoice({ status: 'sent' }));
    const preview = await prev();
    const res = await run('correct_invoice_address', { invoice_id: INV, ...NEW }, { confirmed: true, technicianId: 'admin-1', executionPins: { _verified_address_correction: preview } });
    expect(res.success).toBe(true);
    expect(res).not.toHaveProperty('next_step');
  });


  test('drift (the invoice went void, or its printed address changed) or a missing pin refuses before any write', async () => {
    const preview = await prev();
    const ctx = { confirmed: true, technicianId: 'admin-1', executionPins: { _verified_address_correction: preview } };
    expect(await run('correct_invoice_address', { invoice_id: INV, ...NEW }, { confirmed: true, executionPins: {} })).toMatchObject({ preview_changed: true });
    seed(invoice({ customer_address_snapshot: { address_line1: '2 Another Street', city: 'Sarasota', state: 'FL', zip: '34201' } }));
    expect(await run('correct_invoice_address', { invoice_id: INV, ...NEW }, ctx)).toMatchObject({ preview_changed: true });
    seed(invoice({ status: 'void' }));
    expect(await run('correct_invoice_address', { invoice_id: INV, ...NEW }, ctx)).toMatchObject({ code: 'invoice_void' });
    expect(audited).not.toHaveBeenCalled();
  });

  test('drift found under the writer lock (void, or a newer address) comes back as preview_changed and claims no success', async () => {
    const preview = await prev();
    const ctx = { confirmed: true, technicianId: 'admin-1', executionPins: { _verified_address_correction: preview } };
    audited.mockResolvedValueOnce({ drift: 'void' });
    expect(await run('correct_invoice_address', { invoice_id: INV, ...NEW }, ctx)).toMatchObject({ code: 'invoice_void', preview_changed: true });
    audited.mockResolvedValueOnce({ drift: 'address' });
    const res = await run('correct_invoice_address', { invoice_id: INV, ...NEW }, ctx);
    expect(res).toMatchObject({ preview_changed: true, error: expect.stringMatching(/printed address changed/) });
    expect(res.success).toBeUndefined();
  });

  test('the contract: carded, not irreversible, no customer contact, lists what changes and what does not', async () => {
    const preview = await prev();
    const contract = buildContract({ toolName: 'correct_invoice_address', params: { invoice_id: INV, ...NEW }, displayParams: {}, preview, summary: 's' });
    expect(contract).toMatchObject({ tier: 'yellow', action_label: 'Correct the address printed on an invoice', irreversible: false, notifies_customer: false });
    expect(contract.effects.map((e) => e.label).join('\n')).toMatch(/nothing is re-sent to the customer/);
    expect(contract.effects.map((e) => e.label).join('\n')).toMatch(/audit row/);
  });
});

describe('correctInvoiceAddressAudited (the one writer behind the PUT route and the bar)', () => {
  const INPUT = { address_line1: '9 New Street', city: 'Bradenton', state: 'FL', zip: '34203' };
  const OLD = { address_line1: '1 Old Street', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34201' };
  // The row as read under the FOR UPDATE lock (what a concurrent commit leaves).
  function harness(locked) {
    const written = [];
    const trx = (table) => ({
      where: () => ({
        forUpdate: () => ({ first: async () => (table === 'invoices' ? { id: INV, customer_id: CUST, ...locked } : undefined) }),
        first: async () => ({ address_line1: '55 Live Ave', city: 'Venice', state: 'FL', zip: '34285' }),
        update: async (patch) => { written.push({ table, patch }); },
      }),
    });
    trx.fn = { now: () => 'NOW()' };
    return { written, trx, conn: { transaction: jest.fn(async (work) => work(trx)) } };
  }

  test('commits the snapshot and a critical before/after audit row in one transaction, marking the bar as the surface', async () => {
    const { written, trx, conn } = harness({ status: 'paid', customer_address_snapshot: null });
    const result = await InvoiceAddress.correctInvoiceAddressAudited(conn, INV, INPUT, { actorId: 'admin-1', via: 'intelligence_bar' });
    expect(result.after).toMatchObject({ address_line1: '9 New Street', corrected_at: expect.any(String) });
    expect(written).toEqual([{ table: 'invoices', patch: expect.objectContaining({ customer_address_snapshot: expect.objectContaining({ city: 'Bradenton' }) }) }]);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.address.correct', actor_id: 'admin-1', resource_id: INV, critical: true, trx,
      metadata: expect.objectContaining({ customerId: CUST, via: 'intelligence_bar', before: expect.objectContaining({ address_line1: '55 Live Ave' }), after: expect.objectContaining({ city: 'Bradenton' }) }),
    }));
  });

  test('an approved expectation that still holds under the lock writes normally', async () => {
    const { written, conn } = harness({ status: 'paid', customer_address_snapshot: OLD });
    const result = await InvoiceAddress.correctInvoiceAddressAudited(conn, INV, INPUT, { expect: { before: OLD } });
    expect(result.after.city).toBe('Bradenton');
    expect(written).toHaveLength(1);
  });

  test('another correction landed between preview and lock: nothing is written, no audit row, drift address', async () => {
    const newer = { ...OLD, address_line1: '2 Newer Street' };
    const { written, conn } = harness({ status: 'paid', customer_address_snapshot: newer });
    const result = await InvoiceAddress.correctInvoiceAddressAudited(conn, INV, INPUT, { expect: { before: OLD } });
    expect(result).toEqual({ drift: 'address' });
    expect(written).toEqual([]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('the invoice was voided between preview and lock: nothing is written, no audit row, drift void', async () => {
    const { written, conn } = harness({ status: 'void', customer_address_snapshot: OLD });
    const result = await InvoiceAddress.correctInvoiceAddressAudited(conn, INV, INPUT, { expect: { before: OLD } });
    expect(result).toEqual({ drift: 'void' });
    expect(written).toEqual([]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('the PUT route passes no expectation and keeps its behavior (any status, any prior address)', async () => {
    const { written, conn } = harness({ status: 'void', customer_address_snapshot: { ...OLD, address_line1: 'Anything' } });
    const result = await InvoiceAddress.correctInvoiceAddressAudited(conn, INV, INPUT);
    expect(result.after.city).toBe('Bradenton');
    expect(written).toHaveLength(1);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });
});
