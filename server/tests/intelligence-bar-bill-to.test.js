/**
 * IB set_customer_bill_to (owner ruling 2026-10-21, IB gaps #9 and #10): the customer page's Bill-To save run in
 * process behind a card, dark behind GATE_IB_SET_BILL_TO (needs GATE_IB_PLATFORM), for FUTURE billing only. What the
 * card shows (customer, payer, upcoming visits that keep their own Bill-To, that no invoice moves and nothing is
 * sent), the refusals (open invoices or checkouts, a customer who already has a payer, inactive or ambiguous payer),
 * pin drift, gate off, admin only, and that the commit runs the page's handler once with the card's in-transaction
 * re-check. The handler is mocked here; intelligence-bar-bill-to-postgres.test.js runs the real one. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-customers', () => ({ setCustomerBillToFromBar: jest.fn() }));
const mockGetPayer = jest.fn();
const mockListPayers = jest.fn();
jest.mock('../services/payer', () => ({
  listPayers: (...a) => mockListPayers(...a),
  scheduledServicesHasSelfPay: async () => true,
}));

const db = require('../models/db');
const Customers = require('../routes/admin-customers');
const { executeBillToTool, BILL_TO_TOOLS, cardLines } = require('../services/intelligence-bar/bill-to-tools');
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const CUST = '00000000-0000-4000-8000-0000000000c9';
const ADMIN = { isAdmin: true, technicianId: 'staff-1' };
const PAYER = { id: 7, display_name: 'Synthetic Property Co', company_name: null, active: true, payment_terms: 'net_30' };

let state;
function freshState() {
  return {
    customer: { id: CUST, first_name: 'Robin', last_name: 'Sample', company_name: null, payer_id: null },
    open: [],
    pinnedVisits: 0,
  };
}

// A small knex stand-in keyed on the table each read uses. Any write throws.
function makeDb() {
  function builder(table) {
    const q = { single: false, whereId: null };
    const rows = () => {
      if (table === 'customers') return q.single ? state.customer : [state.customer];
      if (table === 'payers') return mockGetPayer(q.whereId);
      if (table === 'invoices') return state.open;
      if (table === 'scheduled_services') return Array.from({ length: state.pinnedVisits }, (_v, i) => ({ id: `visit-${i}` }));
      return [];
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'first') return () => { q.single = true; return b; };
        if (prop === 'where') return (k) => { if (k && typeof k === 'object' && 'id' in k) q.whereId = k.id; return b; };
        if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  }
  const fn = (table) => builder(table);
  fn.raw = () => 'RAW';
  return fn;
}

function envGate(on) {
  if (on) { process.env.GATE_IB_SET_BILL_TO = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_SET_BILL_TO; delete process.env.GATE_IB_PLATFORM; }
}

const preview = (input = {}, ctx = ADMIN) => executeBillToTool('set_customer_bill_to', { customer_id: CUST, payer_id: '7', ...input }, ctx);
const confirm = (card, input = {}, ctx = ADMIN) => executeBillToTool('set_customer_bill_to',
  { customer_id: CUST, payer_id: '7', ...input, confirmed: true, _verified_bill_to_version: card._version }, ctx);
const OPEN = [{ id: 'i1', invoice_number: 'WPC-2099-0001', total: '90.00', status: 'sent' }];

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : null));
  mockListPayers.mockResolvedValue([PAYER]);
  Customers.setCustomerBillToFromBar.mockImplementation(async () => {
    state.customer = { ...state.customer, payer_id: 7 };
    return { status: 200, json: { success: true } };
  });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step write, admin only, with a record-scoped customers policy', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('set_customer_bill_to')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('set_customer_bill_to')).toBe(true);
    expect(registry.actions.get('set_customer_bill_to')).toMatchObject({ domain: 'customers', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'bill-to-tools.js' });
    expect(registry.policyErrors).not.toContain('set_customer_bill_to');
    expect(BILL_TO_TOOLS[0]._sideEffects).toBe(true);
  });

  test('discoverable by the operator\'s words while on; gone with either gate off; never for a technician', () => {
    for (const query of ['set bill-to payer', 'bill this customer to the property manager', 'payer on this account']) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'customers', fullAccess: false });
      expect(definitions.map((d) => d.name)).toContain('set_customer_bill_to');
    }
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('set_customer_bill_to'), { role: 'admin', context: 'customers' })).toBe(false);
    envGate(true);
    expect(registry.allowed(registry.actions.get('set_customer_bill_to'), { role: 'technician', context: 'tech' })).toBe(false);
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses and nothing runs', async () => {
    envGate(false);
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(await executeBillToTool('set_customer_bill_to', { customer_id: CUST, payer_id: '7', confirmed: true, _verified_bill_to_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await preview({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, {}, {})).toMatchObject({ code: 'permission_denied' });
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  test('shows the customer, the payer, that no invoice moves and nothing is sent; writes nothing; reversible', async () => {
    const card = await preview();
    expect(card).toMatchObject({
      preview: true, tool: 'set_customer_bill_to', customer_id: CUST, customer_name: 'Robin Sample', bill_to_now: 'The customer (self-pay)',
      payer_id: '7', payer_name: 'Synthetic Property Co', sends_to_customer: false,
    });
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/New invoices for Robin Sample bill to Synthetic Property Co \(terms: net 30\)/);
    expect(text).toMatch(/No existing invoice changes hands/);
    expect(text).toMatch(/To undo, set Bill-To back to the customer on the customer page/);
    expect(text).not.toMatch(/tax-exempt|keeps its own|keep their own/);
    expect(text).toMatch(/Nothing is sent/);
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
    expect(cardLines('set_customer_bill_to', card)[0].text).toBe('Bill-To for Robin Sample: The customer (self-pay) → Synthetic Property Co');
    const contract = buildContract({ toolName: 'set_customer_bill_to', params: { customer_id: CUST }, displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/Nothing is sent/);
    // Nothing is cancelled or moved, so the card does not claim "Cannot be undone".
    expect(contract.irreversible).toBe(false);
  });

  test('upcoming visits with their own Bill-To are named and pinned', async () => {
    state.pinnedVisits = 2;
    const card = await preview();
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/2 upcoming visits keep their own Bill-To/);
    state.pinnedVisits = 3;
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed' });
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
  });

  test('an open invoice or checkout goes to the customer page, listing it', async () => {
    state.open = OPEN;
    const refused = await preview();
    expect(refused).toMatchObject({ code: 'needs_customer_page', reason: 'open_invoices', invoices: ['WPC-2099-0001'] });
    expect(refused.error).toMatch(/1 unpaid invoice billed to them or with an open checkout \(WPC-2099-0001 \$90\.00 \(sent\)\)/);
  });

  test('a tax-exempt payer is shown and pinned', async () => {
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? { ...PAYER, tax_exempt: true } : null));
    const card = await preview();
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/Synthetic Property Co is tax-exempt: invoices billed to it carry no sales tax/);
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : null));
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed' });
  });

  test('a customer who already has a payer goes to the customer page; the same payer is a no-op', async () => {
    state.customer.payer_id = 9;
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : { id: 9, display_name: 'Other Payer Co', active: true }));
    expect(await preview()).toMatchObject({ code: 'needs_customer_page', reason: 'has_payer' });
    state.customer.payer_id = 7;
    expect(await preview()).toMatchObject({ code: 'already_set' });
  });

  test('payer checks: exactly one of id or name, inactive refused, a name must match one payer', async () => {
    expect(await preview({ payer_name: 'Synthetic' })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ payer_id: undefined })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ payer_id: '99' })).toMatchObject({ code: 'payer_not_found' });
    mockGetPayer.mockResolvedValue({ ...PAYER, active: false });
    expect(await preview()).toMatchObject({ code: 'payer_inactive' });
    expect(await preview({ payer_id: undefined, payer_name: 'synthetic property co' })).toMatchObject({ preview: true, payer_id: '7' });
    mockListPayers.mockResolvedValue([PAYER, { id: 8, display_name: 'Synthetic Property Co East', active: true }]);
    expect(await preview({ payer_id: undefined, payer_name: 'Synthetic' })).toMatchObject({ code: 'ambiguous_payer' });
    mockListPayers.mockResolvedValue([]);
    expect(await preview({ payer_id: undefined, payer_name: 'Nobody' })).toMatchObject({ code: 'payer_not_found' });
  });

  test('an unknown or malformed customer is refused', async () => {
    expect(await preview({ customer_id: 'nope' })).toMatchObject({ code: 'invalid_target' });
    state.customer = undefined;
    expect(await preview()).toMatchObject({ code: 'customer_not_found' });
  });
});

describe('the confirmed run', () => {
  test('runs the customer page handler once with the in-transaction re-check, and reads it back', async () => {
    const card = await preview();
    const done = await confirm(card);
    expect(done).toMatchObject({ success: true, sent_to_customer: false, customer_id: CUST, payer_id: '7' });
    expect(done.note).toMatch(/No existing invoice moved/);
    expect(Customers.setCustomerBillToFromBar).toHaveBeenCalledTimes(1);
    expect(Customers.setCustomerBillToFromBar).toHaveBeenCalledWith({
      customerId: CUST, payerId: '7', expectedPayerId: null, actor: { technicianId: 'staff-1' }, verifyPlan: expect.any(Function),
    });
  });

  test('the in-transaction re-check passes on an unchanged card and refuses on drift', async () => {
    const card = await preview();
    await confirm(card);
    const { verifyPlan } = Customers.setCustomerBillToFromBar.mock.calls[0][0];
    state.customer = { ...state.customer, payer_id: null };
    await expect(verifyPlan(db)).resolves.toBeUndefined();
    // An invoice or checkout that appeared after the card, or a renamed customer.
    state.open = OPEN;
    await expect(verifyPlan(db)).rejects.toMatchObject({ code: 'preview_changed' });
    state.open = [];
    state.customer = { ...state.customer, first_name: 'Robyn' };
    await expect(verifyPlan(db)).rejects.toMatchObject({ code: 'preview_changed' });
  });

  test('no pin, or drift since the card, refuses without running the handler', async () => {
    expect(await executeBillToTool('set_customer_bill_to', { customer_id: CUST, payer_id: '7', confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    const card = await preview();
    state.open = OPEN;
    expect(await confirm(card)).toMatchObject({ code: 'needs_customer_page', preview_changed: true });
    state.open = [];
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? { ...PAYER, payment_terms: 'net_15' } : null));
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed' });
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : null));
    state.customer = { ...state.customer, first_name: 'Robyn' };
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed' });
    state.customer = { ...state.customer, first_name: 'Robin', payer_id: 9 };
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : { id: 9, display_name: 'Other Payer Co', active: true }));
    expect(await confirm(card)).toMatchObject({ preview_changed: true });
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
  });

  test('the handler\'s locked-row refusal and its in-flight refusals are reported as not changed', async () => {
    const card = await preview();
    Customers.setCustomerBillToFromBar.mockRejectedValueOnce(Object.assign(new Error('The Bill-To changed after the card was shown.'), { code: 'preview_changed' }));
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed' });
    Customers.setCustomerBillToFromBar.mockRejectedValueOnce(Object.assign(new Error('A combined-visit invoice for this customer is being delivered.'), { code: 'invoice_send_in_flight' }));
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'bill_to_refused' });
    Customers.setCustomerBillToFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'contact_exists_on_another_account' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'bill_to_refused' });
  });

  test('an unknown failure with the Bill-To not written is outcome_unknown, never success', async () => {
    const card = await preview();
    Customers.setCustomerBillToFromBar.mockRejectedValueOnce(new Error('boom'));
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    Customers.setCustomerBillToFromBar.mockResolvedValueOnce({ status: 200, json: { success: true } });
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'bill_to_unverified' });
  });
});
