/**
 * IB set_customer_bill_to (owner ruling 2026-10-21, IB gap #9): the customer page's Bill-To save run in process
 * behind a card, dark behind GATE_IB_SET_BILL_TO (needs GATE_IB_PLATFORM). What the card shows (customer, payer,
 * invoices that move and stay, that nothing is sent), the refusals (a customer who already has a payer, inactive or
 * ambiguous payer), pin drift, gate off, admin only, and that the commit runs the page's handler once with the Bill-To
 * the card showed. The handler and the withdrawal are mocked here; intelligence-bar-bill-to-postgres.test.js runs the
 * real ones. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-customers', () => ({ setCustomerBillToFromBar: jest.fn() }));
const mockGetPayer = jest.fn();
const mockListPayers = jest.fn();
jest.mock('../services/payer', () => ({
  getPayer: (...a) => mockGetPayer(...a),
  listPayers: (...a) => mockListPayers(...a),
  scheduledServicesHasSelfPay: async () => true,
}));
const mockTransitions = jest.fn();
const mockVisitOwners = jest.fn();
jest.mock('../services/visit-linked-invoice-withdrawal', () => ({
  ownerTransitions: (...a) => mockTransitions(...a),
  visitOwnerTransitions: (...a) => mockVisitOwners(...a),
}));
const mockInFlight = jest.fn();
jest.mock('../services/visit-completion-packets', () => ({ packetPayload: (p) => p.payload, packetInvoiceSendInFlight: (...a) => mockInFlight(...a) }));

const db = require('../models/db');
const Customers = require('../routes/admin-customers');
const { executeBillToTool, BILL_TO_TOOLS, cardLines } = require('../services/intelligence-bar/bill-to-tools');
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const CUST = '00000000-0000-4000-8000-0000000000c9';
const LINKED = '00000000-0000-4000-8000-0000000000a1';
const MANUAL = '00000000-0000-4000-8000-0000000000a2';
const ADMIN = { isAdmin: true, technicianId: 'staff-1' };
const PAYER = { id: 7, display_name: 'Synthetic Property Co', company_name: null, active: true, payment_terms: 'net_30' };

let state;
function freshState() {
  return {
    customer: { id: CUST, first_name: 'Robin', last_name: 'Sample', company_name: null, payer_id: null },
    invoices: {
      [LINKED]: { id: LINKED, invoice_number: 'WPC-2099-0001', total: '90.00', status: 'sent', credit_applied: '10.00', visit_completion_packet_id: null },
      [MANUAL]: { id: MANUAL, invoice_number: 'WPC-2099-0002', total: '40.00', status: 'sent' },
    },
    packetIds: [],
    staying: [MANUAL],
    pinnedVisits: 0,
    closedPackets: [],
  };
}

// A small knex stand-in keyed on the shape of each read the tool makes. Any write throws.
function makeDb() {
  function builder(table) {
    const q = { single: false, packet: false, ids: null, count: false, whereId: null };
    const rows = () => {
      if (table === 'customers') return q.single ? state.customer : [state.customer];
      if (table === 'scheduled_services') return Array.from({ length: state.pinnedVisits }, (_v, i) => ({ id: `visit-${i}` }));
      // Payer rows read by id: the payer fixture through mockGetPayer, so a test can change what the row says.
      if (table === 'payers') return mockGetPayer(q.whereId);
      if (table === 'visit_completion_packets' && q.ids) return q.ids.filter((id) => state.closedPackets.includes(id));
      if (table === 'visit_completion_packets') return { visit_id: 'sv-1', payload: { billingSnapshot: { billedServiceIds: ['visit-a', 'visit-b'] } } };
      if (table === 'invoices') {
        if (q.ids) return q.ids.map((id) => state.invoices[id]).filter(Boolean);
        if (q.packet) return state.packetIds.map((id) => ({ id, visit_completion_packet_id: `packet-${id}` }));
        return state.staying.map((id) => state.invoices[id]);
      }
      return [];
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'first') return () => { q.single = true; return b; };
        if (prop === 'whereNotNull') return (k) => { if (k === 'visit_completion_packet_id') q.packet = true; return b; };
        if (prop === 'where') return (k) => { if (k && typeof k === 'object' && 'id' in k) q.whereId = k.id; return b; };
        if (prop === 'whereIn') return (k, v) => { if (k === 'id' && Array.isArray(v)) q.ids = v; return b; };
        if (prop === 'raw') return () => 'RAW';
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

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : null));
  mockListPayers.mockResolvedValue([PAYER]);
  mockTransitions.mockResolvedValue([{ invoiceId: LINKED, moved: true, beforeOwner: null, afterOwner: '7' }]);
  mockInFlight.mockResolvedValue(false);
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
  test('shows the customer, the payer, what moves and stays, and that nothing is sent; writes nothing', async () => {
    const card = await preview();
    expect(card).toMatchObject({
      preview: true, tool: 'set_customer_bill_to', customer_id: CUST, customer_name: 'Robin Sample', bill_to_now: 'The customer (self-pay)',
      payer_id: '7', payer_name: 'Synthetic Property Co', invoices_moving: ['WPC-2099-0001'], invoices_staying: ['WPC-2099-0002'], sends_to_customer: false,
    });
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/New invoices for Robin Sample bill to Synthetic Property Co \(terms: net 30\)/);
    expect(text).toMatch(/1 unpaid invoice moves to Synthetic Property Co now/);
    expect(text).toMatch(/Moves to Synthetic Property Co: WPC-2099-0001 \$90\.00 \(sent\)/);
    expect(text).not.toMatch(/tax-exempt/);
    expect(text).toMatch(/\$10\.00 of account credit applied to those invoices goes back/);
    expect(text).toMatch(/1 unpaid invoice stays billed to the customer \(no visit, or a visit pinned to the customer\): WPC-2099-0002/);
    expect(text).toMatch(/Nothing is sent/);
    // The withdrawal module's own owner answer, with the pending customer write laid over it.
    expect(mockTransitions).toHaveBeenCalledWith(expect.anything(), { customerId: CUST },
      expect.objectContaining({ mode: 'pre', pending: { customerPatch: { customerId: CUST, payer_id: '7' } } }));
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
    expect(cardLines('set_customer_bill_to', card)[0].text).toBe('Bill-To for Robin Sample: The customer (self-pay) → Synthetic Property Co');
    const contract = buildContract({ toolName: 'set_customer_bill_to', params: { customer_id: CUST }, displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/Nothing is sent/);
    // Confirm cancels pay-page sessions in Stripe: the card carries "Cannot be undone".
    expect(contract.irreversible).toBe(true);
    expect(text).toMatch(/cancelled in Stripe\. That cannot be undone/);
  });

  test('a combined-visit send or payment in flight: no card is offered', async () => {
    mockInFlight.mockResolvedValue(true);
    expect(await preview()).toMatchObject({ code: 'invoice_send_in_flight' });
    expect(mockInFlight).toHaveBeenCalledWith({ customerId: CUST }, expect.anything(), { pending: { customerPatch: { customerId: CUST, payer_id: '7' } } });
  });

  test('the customer renamed after the card refuses', async () => {
    const card = await preview();
    state.customer = { ...state.customer, first_name: 'Robyn' };
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed' });
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
  });

  test('upcoming visits with their own Bill-To are named; a customer with nothing to move says so', async () => {
    state.pinnedVisits = 2;
    mockTransitions.mockResolvedValue([]);
    state.staying = [];
    const card = await preview();
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/2 upcoming visits keep their own Bill-To/);
    expect(text).toMatch(/No unpaid invoice moves to the payer/);
    expect(card.invoices_moving).toEqual([]);
  });

  test('a combined-visit invoice moves only when a visit it bills will resolve to a payer', async () => {
    const PACKET = '00000000-0000-4000-8000-0000000000a3';
    state.invoices[PACKET] = { id: PACKET, invoice_number: 'WPC-2099-0003', total: '120.00', status: 'sent', credit_applied: '0', visit_completion_packet_id: `packet-${PACKET}` };
    state.packetIds = [PACKET];
    // Every billed visit pinned to the customer: it stays.
    mockVisitOwners.mockResolvedValue([{ visitId: 'visit-a', afterOwner: null }, { visitId: 'visit-b', afterOwner: null }]);
    expect((await preview()).invoices_moving).toEqual(['WPC-2099-0001']);
    expect(mockVisitOwners).toHaveBeenCalledWith(expect.anything(), ['visit-a', 'visit-b'], { pending: { customerPatch: { customerId: CUST, payer_id: '7' } }, lock: false });
    // One billed visit resolves to the payer: it moves.
    mockVisitOwners.mockResolvedValue([{ visitId: 'visit-a', afterOwner: null }, { visitId: 'visit-b', afterOwner: '7' }]);
    const moved = await preview();
    expect(moved.invoices_moving).toEqual(['WPC-2099-0001', 'WPC-2099-0003']);
    const movedText = moved.effects.map((e) => e.text).join('\n');
    expect(movedText).toMatch(/1 combined-visit invoice moves: its visit goes on billing hold\.$/m);
    // A packet whose close already finished also gets the office review alert, and that is pinned.
    state.closedPackets = [`packet-${PACKET}`];
    const reviewed = await preview();
    expect(reviewed.effects.map((e) => e.text).join('\n')).toMatch(/That visit already closed, so the office gets a visit close-out review alert/);
    expect(await confirm(moved)).toMatchObject({ code: 'preview_changed' });
    state.closedPackets = [];
    // The first billed visit that resolves to a payer decides, in billed order: visit-a's own payer 9 here.
    mockVisitOwners.mockResolvedValue([{ visitId: 'visit-b', afterOwner: '7' }, { visitId: 'visit-a', afterOwner: '9' }]);
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : { id: 9, display_name: 'Other Payer Co', active: true }));
    const card = await preview();
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/2 unpaid invoices move to a payer \(named on each line\) now/);
    expect(text).toMatch(/Moves to Other Payer Co: WPC-2099-0003/);
    expect(text).toMatch(/Moves to Synthetic Property Co: WPC-2099-0001/);
    expect(card._invoices.find((i) => i.id === PACKET).to_payer_id).toBe('9');
    // The other payer renamed after the card: its line no longer names who gets the bill, so the pin refuses.
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : { id: 9, display_name: 'Other Payer Renamed', active: true }));
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed' });
    expect(Customers.setCustomerBillToFromBar).not.toHaveBeenCalled();
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
  test('runs the customer page handler once with the Bill-To the card showed, and reads it back', async () => {
    const card = await preview();
    const done = await confirm(card);
    expect(done).toMatchObject({ success: true, sent_to_customer: false, customer_id: CUST, payer_id: '7' });
    expect(Customers.setCustomerBillToFromBar).toHaveBeenCalledTimes(1);
    expect(Customers.setCustomerBillToFromBar).toHaveBeenCalledWith({
      customerId: CUST, payerId: '7', expectedPayerId: null, actor: { technicianId: 'staff-1' },
      expectedInvoices: [
        { id: LINKED, status: 'sent', total: '90.00', credit_applied: '10.00', to_payer_id: '7' },
        { id: MANUAL, status: 'sent', total: '40.00', credit_applied: undefined, to_payer_id: null },
      ],
      verifyPlan: expect.any(Function),
    });
  });

  test('no pin, or drift since the card, refuses without running the handler', async () => {
    expect(await executeBillToTool('set_customer_bill_to', { customer_id: CUST, payer_id: '7', confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    const card = await preview();
    mockTransitions.mockResolvedValue([]);
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    // A staying invoice's amount or the payer's terms changed after the card.
    mockTransitions.mockResolvedValue([{ invoiceId: LINKED, moved: true, beforeOwner: null, afterOwner: '7' }]);
    const card3 = await preview();
    state.invoices[MANUAL] = { ...state.invoices[MANUAL], total: '45.00' };
    expect(await confirm(card3)).toMatchObject({ code: 'preview_changed' });
    const card4 = await preview();
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? { ...PAYER, payment_terms: 'net_15' } : null));
    expect(await confirm(card4)).toMatchObject({ code: 'preview_changed' });
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : null));
    const card2 = await preview();
    state.customer.payer_id = 9;
    mockGetPayer.mockImplementation(async (id) => (String(id) === '7' ? PAYER : { id: 9, display_name: 'Other Payer Co', active: true }));
    expect(await confirm(card2)).toMatchObject({ preview_changed: true });
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
