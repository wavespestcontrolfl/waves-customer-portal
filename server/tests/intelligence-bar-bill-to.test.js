/**
 * IB set_customer_bill_to (owner ruling 2026-10-21, IB gaps #9 and #10): the customer page's Bill-To save run in
 * process behind a card, dark behind GATE_IB_SET_BILL_TO (needs GATE_IB_PLATFORM), for FUTURE billing only. What the
 * card shows (customer, payer, upcoming visits that keep their own Bill-To, that no invoice moves and nothing is
 * sent), the refusals (open invoices or checkouts, a customer who already has a payer, inactive or ambiguous payer),
 * pin drift, gate off, admin only, and that the commit runs the page's handler once with the card's in-transaction
 * re-check. The handler is mocked here; intelligence-bar-bill-to-postgres.test.js runs the real one. Synthetic names only.
 * IB gap #19: a payer that is not set up yet is added by the same card (new_payer_*), deduped by AP email.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-customers', () => ({ setCustomerBillToFromBar: jest.fn() }));
const mockGetPayer = jest.fn();
const mockListPayers = jest.fn();
// The new-payer reads and the insert (bill-to-tools.js existingPayers / addCardPayer).
const mockEmailHolders = jest.fn();
const mockSameName = jest.fn();
const mockInsertPayer = jest.fn();
jest.mock('../services/payer', () => ({
  listPayers: (...a) => mockListPayers(...a),
  scheduledServicesHasSelfPay: async () => true,
  buildPayerWrite: (...a) => jest.requireActual('../services/payer').buildPayerWrite(...a),
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
const mockRaw = jest.fn(() => 'RAW');
function freshState() {
  return {
    customer: { id: CUST, first_name: 'Robin', last_name: 'Sample', company_name: null, payer_id: null },
    open: [],
    pinnedVisits: 0,
    // payers rows by AP email (the new-payer dedupe lookup), and the active payers the exact-name lookup sees
    payersByEmail: {},
    activePayers: [],
  };
}

// A small knex stand-in keyed on the table each read uses. Any write throws.
function makeDb() {
  function builder(table) {
    const q = { single: false, whereId: null, email: null, names: null, inserted: null };
    const rows = () => {
      if (table === 'customers') return q.single ? state.customer : [state.customer];
      if (table === 'payers' && q.inserted) return [mockInsertPayer(q.inserted)];
      if (table === 'payers' && q.email) return mockEmailHolders(q.email);
      if (table === 'payers' && q.names) return mockSameName(q.names);
      if (table === 'payers') return mockGetPayer(q.whereId);
      if (table === 'invoices') return state.open;
      if (table === 'scheduled_services') return Array.from({ length: state.pinnedVisits }, (_v, i) => ({ id: `visit-${i}` }));
      return [];
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'first') return () => { q.single = true; return b; };
        if (prop === 'whereRaw') {
          return (sql, binds) => {
            if (/ap_email/.test(sql)) q.email = binds[0];
            if (/display_name/.test(sql)) q.names = binds;
            return b;
          };
        }
        // where(callback): run it against this builder so the callback's whereRaw calls land here.
        if (prop === 'where') return (k) => { if (typeof k === 'function') k(b); else if (k && typeof k === 'object' && 'id' in k) q.whereId = k.id; return b; };
        if (prop === 'insert' && table === 'payers') return (row) => { q.inserted = row; return b; };
        if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  }
  const fn = (table) => builder(table);
  fn.raw = mockRaw;
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
  // models/db is the mocked function itself: its transaction runs the work on the same stand-in.
  db.raw = mockRaw;
  db.transaction = async (work) => work(db);
  envGate(true);
  mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : null));
  mockListPayers.mockResolvedValue([PAYER]);
  mockEmailHolders.mockImplementation((email) => state.payersByEmail[email] || []);
  mockSameName.mockImplementation((names) => {
    const norm = (v) => String(v || '').trim().toLowerCase();
    return state.activePayers.filter((p) => names.includes(norm(p.display_name)) || names.includes(norm(p.company_name)));
  });
  mockInsertPayer.mockImplementation((row) => addedRow(row));
  Customers.setCustomerBillToFromBar.mockImplementation(async ({ payerId }) => {
    state.customer = { ...state.customer, payer_id: Number(payerId) };
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

  test('the route builds the confirmation card from this preview', async () => {
    const { confirmationDisplayParams } = jest.requireActual('../routes/admin-intelligence-bar');
    expect(confirmationDisplayParams('set_customer_bill_to', { customer_id: CUST }, await preview())).toEqual({
      customer: 'Robin Sample', bill_to_now: 'The customer (self-pay)', new_bill_to: 'Synthetic Property Co', invoices_moving: 'none', sends_to_customer: 'nothing',
    });
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
    // The checkout-session release's own pin refusal (pay-combined.js) is the same: nothing was changed.
    Customers.setCustomerBillToFromBar.mockRejectedValueOnce(Object.assign(new Error('sessions changed'), { previewChanged: true }));
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

// IB gap #19: the payer is not set up yet. The card adds it (the page's "New payer" form), then sets it.
const NEW = { payer_id: undefined, new_payer_name: 'Jordan Sample', new_payer_company: 'Sample Holdings', new_payer_email: ' AP@Sample-Holdings.test ', new_payer_phone: '941-555-0101' };
const ADDED_ID = 42;
function addedRow(body) {
  return { id: ADDED_ID, display_name: body.display_name, company_name: body.company_name ?? null, ap_email: body.ap_email ?? null, ap_phone: body.ap_phone ?? null,
    payment_terms: body.payment_terms || 'due_on_receipt', tax_exempt: false, active: true };
}
const ADDED = addedRow({ display_name: 'Jordan Sample', company_name: 'Sample Holdings', ap_email: 'ap@sample-holdings.test', ap_phone: '941-555-0101' });

describe('a new payer (IB gap #19)', () => {
  beforeEach(() => {
    mockListPayers.mockResolvedValue([PAYER]);
    // After the add, payer 42 reads back as the row the create stored.
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : String(id) === String(ADDED_ID) ? ADDED : null));
  });

  test('the card names the payer it adds, its invoice email and terms; writes nothing', async () => {
    const card = await preview(NEW);
    expect(card).toMatchObject({ preview: true, payer_id: null, payer_new: true, payer_name: 'Jordan Sample (Sample Holdings)', sends_to_customer: false });
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/Adds a new payer: Jordan Sample \(Sample Holdings\)\. Invoice email: ap@sample-holdings\.test\. Phone: 941-555-0101\./);
    expect(text).toMatch(/New invoices for Robin Sample bill to Jordan Sample \(Sample Holdings\) \(terms: due on receipt\)/);
    expect(text).toMatch(/The new payer stays in Finance → Payers/);
    expect(text).toMatch(/Nothing is sent/);
    expect(text).not.toMatch(/no invoice email/);
    expect(card._version).toMatchObject({ payer_after: 'new', payer_terms: 'due_on_receipt', payer_tax_exempt: false,
      new_payer: { display_name: 'Jordan Sample', company_name: 'Sample Holdings', ap_email: 'ap@sample-holdings.test', ap_phone: '941-555-0101' } });
    expect(cardLines('set_customer_bill_to', card)[0].text).toBe('Bill-To for Robin Sample: The customer (self-pay) → Jordan Sample (Sample Holdings) (new payer)');
    const { confirmationDisplayParams } = jest.requireActual('../routes/admin-intelligence-bar');
    expect(confirmationDisplayParams('set_customer_bill_to', { customer_id: CUST }, card)).toMatchObject({ new_bill_to: 'Jordan Sample (Sample Holdings) (new payer)' });
    expect(mockInsertPayer).not.toHaveBeenCalled();
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
  });

  test('no invoice email: the card says its invoices cannot be delivered yet', async () => {
    const card = await preview({ ...NEW, new_payer_email: undefined });
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/Jordan Sample \(Sample Holdings\) has no invoice email, so its invoices cannot be delivered/);
  });

  test('an invoice email an active payer holds uses that payer; a deactivated holder refuses', async () => {
    state.payersByEmail['ap@sample-holdings.test'] = [PAYER];
    const card = await preview(NEW);
    expect(card).toMatchObject({ preview: true, payer_id: '7', payer_new: false, payer_name: 'Synthetic Property Co' });
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/No new payer is added: ap@sample-holdings\.test already belongs to the payer Synthetic Property Co/);
    expect(await confirm(card, NEW)).toMatchObject({ success: true, payer_id: '7' });
    expect(mockInsertPayer).not.toHaveBeenCalled();
    expect(Customers.setCustomerBillToFromBar).toHaveBeenCalledWith(expect.objectContaining({ payerId: '7' }));
    state.payersByEmail['ap@sample-holdings.test'] = [{ ...PAYER, id: 8, active: false }];
    expect(await preview(NEW)).toMatchObject({ code: 'payer_inactive' });
  });

  test('an active payer with the same name or company refuses, naming it', async () => {
    state.activePayers = [{ id: 8, display_name: 'Other Name', company_name: ' sample holdings ', active: true }];
    expect(await preview(NEW)).toMatchObject({ code: 'payer_exists', candidates: [{ payer_id: '8', name: 'Other Name ( sample holdings )' }] });
    state.activePayers = [{ id: 10, display_name: 'JORDAN SAMPLE', company_name: null, active: true }];
    expect(await preview(NEW)).toMatchObject({ code: 'payer_exists', candidates: [{ payer_id: '10' }] });
    // A partial name match is not the same payer.
    state.activePayers = [{ id: 9, display_name: 'Jordan Samples Inc', active: true }];
    expect(await preview(NEW)).toMatchObject({ preview: true, payer_new: true });
  });

  test('input checks: one payer only, new_payer_* fields only with a name, a valid email', async () => {
    expect(await preview({ ...NEW, payer_id: '7' })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ ...NEW, new_payer_name: undefined, payer_name: 'Synthetic Property Co' })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ ...NEW, new_payer_email: 'not-an-email' })).toMatchObject({ code: 'invalid_payer' });
    expect(await preview({ ...NEW, new_payer_name: '   ' })).toMatchObject({ code: 'invalid_target' });
  });

  test('a customer who already has a payer, or open invoices, is refused before anything is added', async () => {
    state.open = OPEN;
    expect(await preview(NEW)).toMatchObject({ code: 'needs_customer_page', reason: 'open_invoices' });
    state.open = [];
    state.customer.payer_id = 7;
    expect(await preview(NEW)).toMatchObject({ code: 'needs_customer_page', reason: 'has_payer' });
  });

  test('confirm adds the payer under the email and name locks, then runs the page handler on it once', async () => {
    const card = await preview(NEW);
    const done = await confirm(card, NEW);
    expect(done).toMatchObject({ success: true, payer_created: true, payer_id: String(ADDED_ID), sent_to_customer: false });
    expect(done.note).toMatch(/Added the payer Jordan Sample \(Sample Holdings\), and Robin Sample now bills to it/);
    expect(mockInsertPayer).toHaveBeenCalledTimes(1);
    expect(mockInsertPayer).toHaveBeenCalledWith({
      display_name: 'Jordan Sample', company_name: 'Sample Holdings', ap_email: 'ap@sample-holdings.test', ap_phone: '941-555-0101', payment_terms: 'due_on_receipt',
    });
    // The email lock is payer.js findOrCreatePayerByEmail's own key; every key is taken in sorted order.
    const locked = mockRaw.mock.calls.filter(([sql]) => /pg_advisory_xact_lock/.test(sql)).map(([, binds]) => binds[0]);
    expect(locked).toEqual(['ap@sample-holdings.test', 'ib-bill-to-payer-name:jordan sample', 'ib-bill-to-payer-name:sample holdings']);
    expect(Customers.setCustomerBillToFromBar).toHaveBeenCalledTimes(1);
    expect(Customers.setCustomerBillToFromBar).toHaveBeenCalledWith(expect.objectContaining({ customerId: CUST, payerId: String(ADDED_ID), expectedPayerId: null }));
    // The in-transaction re-check judges the added payer against the card.
    const { verifyPlan } = Customers.setCustomerBillToFromBar.mock.calls[0][0];
    state.customer = { ...state.customer, payer_id: null };
    await expect(verifyPlan(db)).resolves.toBeUndefined();
    mockGetPayer.mockImplementation(async (id) => (String(id) === String(ADDED_ID) ? { ...ADDED, payment_terms: 'net_30' } : null));
    await expect(verifyPlan(db)).rejects.toMatchObject({ code: 'preview_changed' });
    // The added payer's invoice email or phone edited before the Bill-To transaction: refused too.
    mockGetPayer.mockImplementation(async (id) => (String(id) === String(ADDED_ID) ? { ...ADDED, ap_email: 'other@sample-holdings.test' } : null));
    await expect(verifyPlan(db)).rejects.toMatchObject({ code: 'preview_changed' });
    mockGetPayer.mockImplementation(async (id) => (String(id) === String(ADDED_ID) ? { ...ADDED, ap_phone: null } : null));
    await expect(verifyPlan(db)).rejects.toMatchObject({ code: 'preview_changed' });
  });

  test('no invoice email: confirm locks the names only and adds the payer with no email', async () => {
    const input = { ...NEW, new_payer_email: undefined };
    const card = await preview(input);
    mockGetPayer.mockImplementation(async (id) => (String(id) === String(ADDED_ID) ? { ...ADDED, ap_email: null } : null));
    expect(await confirm(card, input)).toMatchObject({ success: true, payer_created: true });
    expect(mockInsertPayer).toHaveBeenCalledWith(expect.objectContaining({ display_name: 'Jordan Sample', ap_email: null, payment_terms: 'due_on_receipt' }));
    expect(mockRaw.mock.calls.filter(([sql]) => /pg_advisory_xact_lock/.test(sql)).map(([, binds]) => binds[0]))
      .toEqual(['ib-bill-to-payer-name:jordan sample', 'ib-bill-to-payer-name:sample holdings']);
  });

  test('a payer that took the email after the card refuses with nothing added or set', async () => {
    const card = await preview(NEW);
    // Seen by the re-check: the card no longer matches.
    state.payersByEmail['ap@sample-holdings.test'] = [PAYER];
    expect(await confirm(card, NEW)).toMatchObject({ code: 'preview_changed' });
    state.payersByEmail = {};
    // Raced in between the re-check and the add: the check under the locks sees it (the re-check read nothing).
    mockEmailHolders.mockReturnValueOnce([]).mockReturnValueOnce([PAYER]);
    expect(await confirm(card, NEW)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    mockEmailHolders.mockReturnValueOnce([]).mockReturnValueOnce([{ ...PAYER, active: false }]);
    expect(await confirm(card, NEW)).toMatchObject({ code: 'preview_changed' });
    // Another card added the same name first (no email: only the name locks serialize them).
    const input = { ...NEW, new_payer_email: undefined };
    const card2 = await preview(input);
    mockSameName.mockReturnValueOnce([]).mockReturnValueOnce([{ id: 43, display_name: 'Jordan Sample', active: true }]);
    expect(await confirm(card2, input)).toMatchObject({ code: 'preview_changed' });
    expect(mockInsertPayer).not.toHaveBeenCalled();
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
  });

  test('the Bill-To save refusing after the add says the payer was added and stays', async () => {
    const card = await preview(NEW);
    Customers.setCustomerBillToFromBar.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'preview_changed' }));
    const failed = await confirm(card, NEW);
    expect(failed).toMatchObject({ failed: true, code: 'preview_changed', payer_created: true, payer_id: String(ADDED_ID) });
    expect(failed.error).toMatch(/The payer Jordan Sample \(Sample Holdings\) was added \(payer_id 42\) and stays in Finance → Payers/);
    // A stored row that is not the payer the card showed: the Bill-To is not set.
    mockInsertPayer.mockReturnValueOnce({ ...ADDED, tax_exempt: true });
    expect(await confirm(card, NEW)).toMatchObject({ failed: true, code: 'preview_changed', payer_created: true });
    mockInsertPayer.mockReturnValueOnce({ ...ADDED, ap_phone: '941-555-0199' });
    expect(await confirm(card, NEW)).toMatchObject({ failed: true, code: 'preview_changed', payer_created: true });
    expect(Customers.setCustomerBillToFromBar).toHaveBeenCalledTimes(1);
  });
});
