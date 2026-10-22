/**
 * IB invoice edit cards (owner ruling 2026-10-12, Stage 3 cards): edit_invoice (title, notes and due date only),
 * archive_invoice, unarchive_invoice and unvoid_invoice replay the Invoices page's own handlers in process behind a card, dark behind
 * GATE_IB_INVOICE_EDITS (needs GATE_IB_PLATFORM). What each card shows (before -> after, money, that nothing is sent),
 * pin drift, every refusal, gate off, admin only, and that the commit runs the page's handler once with the card's
 * invoice version. The handlers are mocked here; admin-invoices-edit-handler-replay.test.js and
 * invoice-bar-expected-version.test.js cover the real ones.
 * Nothing here reaches a provider. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-invoices', () => ({
  editInvoiceFromBar: jest.fn(),
  archiveInvoiceFromBar: jest.fn(),
  unarchiveInvoiceFromBar: jest.fn(),
  unvoidInvoiceFromBar: jest.fn(),
}));
const mockAssertNoCharge = jest.fn();
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: (...a) => mockAssertNoCharge(...a),
}));
const mockLinkedVisit = jest.fn();
const mockObligation = jest.fn();
const mockUnvoidableVisit = jest.fn(async () => undefined);
jest.mock('../services/invoice', () => ({
  linkedScheduledServiceId: (...a) => mockLinkedVisit(...a),
  _unvoidObligationReason: (...a) => mockObligation(...a),
  _assertUnvoidableLinkedVisit: (...a) => mockUnvoidableVisit(...a),
}));
const mockResolveTerm = jest.fn();
jest.mock('../services/invoice-prepay', () => ({ resolveInvoiceTermId: (...a) => mockResolveTerm(...a) }));

const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const tools = require('../services/intelligence-bar/invoice-edit-tools');
const { executeInvoiceEditTool, INVOICE_EDIT_TOOLS, INVOICE_EDIT_TOOL_NAMES, cardLines } = tools;
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');
const { OWNER_DIRECT_TOOL_NAMES } = require('../services/intelligence-bar/owner-direct');

const INV = '00000000-0000-4000-8000-0000000000a1';
const CUST = '00000000-0000-4000-8000-0000000000c1';
const VISIT = '00000000-0000-4000-8000-0000000000d1';
const ADMIN = { isAdmin: true, technicianId: 'staff-1', operationId: 'op-1' };
const UPDATED = new Date('2099-01-01T12:00:00.123Z');

let state;
function freshState() {
  return {
    invoices: [{
      id: INV, invoice_number: 'WPC-2099-0001', customer_id: CUST, status: 'sent', title: 'Quarterly Pest Control', notes: null,
      subtotal: '129.00', discount_amount: '0.00', tax_rate: '0.0000', tax_amount: '0.00', total: '129.00', credit_applied: '0.00',
      due_date: new Date('2099-01-15T00:00:00Z'), updated_at: UPDATED, archived_at: null, stripe_payment_intent_id: null,
      payment_recorded_at: null, payer_id: null, payer_statement_id: null, scheduled_service_id: VISIT, annual_prepay_term_id: null,
      line_items: [
        { client_id: 'li_a', description: 'Quarterly Pest Control', quantity: 1, unit_price: 99, amount: 99, category: 'service' },
        { client_id: 'li_b', description: 'Interior add-on', quantity: 1, unit_price: 30, amount: 30 },
      ],
    }],
    customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample', property_type: 'residential' }],
    payments: [], payer_statements: [], payment_plans: [], stripe_invoice_charge_attempts: [], annual_prepay_terms: [], projects: [], setup_fee_claims: [], dispatch_alerts: [], payers: [],
    scheduled_services: [{ id: VISIT, customer_id: CUST, payer_id: null, self_pay_override: false, status: 'completed', scheduled_date: '2099-01-01', window_start: '09:00:00', window_end: '11:00:00' }],
    technicians: [{ id: 'staff-1', name: 'Pat Admin', email: 'admin@example.com' }],
    writes: [],
  };
}

// A small knex stand-in: plain-object where / whereNot / whereNull filter the seeded rows; callback and raw wheres are
// ignored, so the linkage tables (payments, plans, attempts, projects) hold exactly the rows linked to the invoice.
// Any write throws.
function makeDb() {
  function builder(table) {
    const q = { wheres: [], nots: [], nulls: [], likes: [], notIns: [], single: false };
    const rows = () => {
      const found = (state[table] || []).filter((row) => q.wheres.every((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v)))
        && q.nots.every(([k, v]) => String(row[k]) !== String(v))
        && q.nulls.every((k) => row[k] == null)
        && q.likes.every(([k, text]) => String(row[k] || '').includes(text))
        && q.notIns.every(([k, values]) => !values.includes(row[k])));
      return q.single ? found[0] : found;
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'where') return (arg, op, value) => {
          if (arg && typeof arg === 'object' && typeof arg !== 'function') q.wheres.push(arg);
          // A LIKE on a text column (the rebill marker in notes) is matched on the seeded rows.
          if (typeof arg === 'string' && String(op).toLowerCase() === 'like') q.likes.push([arg, String(value).replace(/%/g, '')]);
          return b;
        };
        if (prop === 'whereNotIn') return (k, v) => { q.notIns.push([k, v]); return b; };
        if (prop === 'whereNot') return (k, v) => { q.nots.push([k, v]); return b; };
        if (prop === 'whereNull') return (k) => { q.nulls.push(k); return b; };
        if (prop === 'first') return () => { q.single = true; return b; };
        if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) { state.writes.push(`${String(prop)} ${table}`); throw new Error(`unexpected ${String(prop)} on ${table}`); }
        return () => b;
      },
    });
    return b;
  }
  return (table) => builder(table);
}

function envGate(on) {
  if (on) { process.env.GATE_IB_INVOICE_EDITS = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_INVOICE_EDITS; delete process.env.GATE_IB_PLATFORM; }
}

const run = (tool, input = {}, ctx = ADMIN) => executeInvoiceEditTool(tool, { invoice_id: INV, ...input }, ctx);
const VERSION_KEY = {
  edit_invoice: '_verified_invoice_edit_version',
  archive_invoice: '_verified_invoice_archive_version',
  unarchive_invoice: '_verified_invoice_unarchive_version',
  unvoid_invoice: '_verified_invoice_unvoid_version',
};
const confirm = (tool, card, input = {}, ctx = ADMIN) => executeInvoiceEditTool(tool,
  { invoice_id: INV, ...input, confirmed: true, [VERSION_KEY[tool]]: card._version }, ctx);
const setInvoice = (changes) => { state.invoices[0] = { ...state.invoices[0], ...changes }; };
const nothingSent = (card) => expect(JSON.stringify(card.effects)).toMatch(/Nothing is sent/);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  mockAssertNoCharge.mockResolvedValue(undefined);
  mockLinkedVisit.mockResolvedValue(VISIT);
  mockResolveTerm.mockResolvedValue(null);
  // The same provenance reads as InvoiceService._unvoidObligationReason (covered against the real one in
  // invoice-bar-expected-version.test.js), run on this file's fake database.
  mockObligation.mockImplementation(async (conn, invoice) => {
    const lines = Array.isArray(invoice.line_items) ? invoice.line_items : [];
    if (invoice.visit_completion_packet_id) return 'packet_invoice';
    if (invoice.payer_id || /^payer_billed:/.test(String(invoice.scheduled_send_error || ''))) return 'payer_billed';
    if (invoice.payer_statement_id) return 'payer_statement';
    if (lines.some((li) => li && li.membership_dues_month)) return 'membership_dues';
    if (lines.some((li) => /^Bait Station Setup — one-time setup fee$/.test(String(li?.description || '').trim()))) return 'setup_fee';
    if (await conn('setup_fee_claims').where({ invoice_id: invoice.id }).first()) return 'setup_fee';
    if (await conn('dispatch_alerts').where({ type: 'setup_fee_office_billing' }).first()) return 'setup_fee';
    if (await conn('invoices').where('notes', 'like', `%[rodent-setup-rebill:${invoice.id}]%`).whereNotIn('status', ['void']).first()) return 'setup_fee';
    return null;
  });
  Invoices.editInvoiceFromBar.mockResolvedValue({ status: 200, json: { id: INV, status: 'sent', total: '149.00' } });
  Invoices.archiveInvoiceFromBar.mockResolvedValue({ status: 200, json: { id: INV, status: 'void', archived_at: '2099-01-02T00:00:00Z' } });
  Invoices.unarchiveInvoiceFromBar.mockResolvedValue({ status: 200, json: { id: INV, status: 'void', archived_at: null } });
  Invoices.unvoidInvoiceFromBar.mockResolvedValue({ status: 200, json: { id: INV, status: 'draft' } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test.each(INVOICE_EDIT_TOOL_NAMES)('%s is a two-step write, admin only, never owner-direct, record-scoped, one module', (name) => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(name)).toBe(true);
    expect(OWNER_DIRECT_TOOL_NAMES.has(name)).toBe(false);
    expect(registry.actions.get(name)).toMatchObject({ domain: 'customers', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'invoice-edit-tools.js' });
    expect(registry.policyErrors).not.toContain(name);
    expect(INVOICE_EDIT_TOOLS.find((t) => t.name === name)._sideEffects).toBe(true);
    expect(INVOICE_EDIT_TOOLS.find((t) => t.name === name).description).toMatch(/Nothing is sent|sent to the customer/);
  });

  test('the four tools are exactly the ones the module exports', () => {
    expect(INVOICE_EDIT_TOOL_NAMES).toEqual(['edit_invoice', 'archive_invoice', 'unarchive_invoice', 'unvoid_invoice']);
  });

  test('the discovery search finds each by the operator’s words', () => {
    const cases = [
      ['edit invoice', 'edit_invoice'], ['change the due date on this invoice', 'edit_invoice'],
      ['archive the voided invoice', 'archive_invoice'],
      ['unarchive invoice', 'unarchive_invoice'], ['unvoid this invoice', 'unvoid_invoice'],
    ];
    for (const [query, expected] of cases) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'customers', fullAccess: false });
      expect(definitions.map((d) => d.name)).toContain(expected);
    }
  });

  test('gate off: not allowed anywhere; the platform gate is needed; a technician never gets them', () => {
    delete process.env.GATE_IB_PLATFORM;
    for (const name of INVOICE_EDIT_TOOL_NAMES) expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'customers' })).toBe(false);
    envGate(false);
    for (const name of INVOICE_EDIT_TOOL_NAMES) expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'customers' })).toBe(false);
    envGate(true);
    for (const name of INVOICE_EDIT_TOOL_NAMES) {
      expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'customers' })).toBe(true);
      expect(registry.allowed(registry.actions.get(name), { role: 'technician', context: 'tech' })).toBe(false);
    }
    process.env.GATE_IB_INVOICE_EDITS = 'TRUE';
    expect(registry.allowed(registry.actions.get('edit_invoice'), { role: 'admin', context: 'customers' })).toBe(false);
  });

  test('the Invoices / Revenue page offers them first-hand when the gate is on, and not when it is off', () => {
    const names = (context) => registry.initialTools(context, { role: 'admin', fullAccess: false }).map((t) => t.name);
    for (const name of INVOICE_EDIT_TOOL_NAMES) expect(names('revenue')).toContain(name);
    envGate(false);
    for (const name of INVOICE_EDIT_TOOL_NAMES) expect(names('revenue')).not.toContain(name);
  });
});

describe('gate off and permissions', () => {
  test.each(INVOICE_EDIT_TOOL_NAMES)('%s: gate off refuses with gate_off and touches nothing (preview and a forced confirmed call)', async (name) => {
    envGate(false);
    expect(await run(name)).toMatchObject({ code: 'gate_off' });
    expect(await run(name, { confirmed: true, [VERSION_KEY[name]]: {} })).toMatchObject({ code: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    for (const fn of Object.values(Invoices)) expect(fn).not.toHaveBeenCalled();
  });

  test.each(INVOICE_EDIT_TOOL_NAMES)('%s: a non-admin is refused, and a confirmed run needs a positive admin flag', async (name) => {
    expect(await run(name, {}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(await run(name, { confirmed: true, [VERSION_KEY[name]]: {} }, {})).toMatchObject({ code: 'permission_denied' });
    expect(db).not.toHaveBeenCalled();
  });

  test('an unknown tool name is refused', async () => {
    expect(await executeInvoiceEditTool('void_everything', { invoice_id: INV }, ADMIN)).toEqual({ error: 'Unknown tool: void_everything' });
  });

  test.each(INVOICE_EDIT_TOOL_NAMES)('%s: a confirmed call with no card pin is refused (approval_required)', async (name) => {
    expect(await executeInvoiceEditTool(name, { invoice_id: INV, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    for (const fn of Object.values(Invoices)) expect(fn).not.toHaveBeenCalled();
  });

  test.each(INVOICE_EDIT_TOOL_NAMES)('%s: names exactly one of invoice_id / invoice_number; an unknown invoice is not found', async (name) => {
    expect(await executeInvoiceEditTool(name, {}, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeInvoiceEditTool(name, { invoice_id: INV, invoice_number: 'WPC-2099-0001' }, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeInvoiceEditTool(name, { invoice_id: 'nope' }, ADMIN)).toMatchObject({ code: 'invalid_target' });
    expect(await executeInvoiceEditTool(name, { invoice_id: '00000000-0000-4000-8000-0000000000ff' }, ADMIN)).toMatchObject({ code: 'invoice_not_found' });
    const byNumber = await executeInvoiceEditTool(name, { invoice_number: 'wpc-2099-9999' }, ADMIN);
    expect(byNumber).toMatchObject({ code: 'invoice_not_found' });
  });
});

describe('edit_invoice card', () => {
  test('title, notes and due date: before -> after per field, the total never moves, a delivered invoice is NOT resent and the card says so', async () => {
    const card = await run('edit_invoice', { title: 'Spring service', notes: 'Gate code on file', due_date: '2099-02-01' });
    expect(card).toMatchObject({ preview: true, tool: 'edit_invoice', invoice_number: 'WPC-2099-0001', customer_name: 'Robin Sample', amount: '$129.00', sends_to_customer: false });
    expect(card).not.toHaveProperty('old_total');
    expect(card).not.toHaveProperty('new_total');
    expect(card.changes).toEqual([
      { field: 'Title', before: 'Quarterly Pest Control', after: 'Spring service' },
      { field: 'Notes', before: '(empty)', after: 'Gate code on file' },
      { field: 'Due date', before: '2099-01-15', after: '2099-02-01' },
    ]);
    const text = JSON.stringify(card.effects);
    expect(text).toMatch(/does NOT resend it/);
    expect(text).toMatch(/reminder dates move/);
    nothingSent(card);
    expect(card._body).toEqual({ title: 'Spring service', notes: 'Gate code on file', due_date: '2099-02-01' });
    expect(state.writes).toEqual([]);
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the card pins the customer, in the version and in what the handler is handed', async () => {
    const card = await run('edit_invoice', { title: 'Spring service' });
    expect(card._version.customer_id).toBe(CUST);
    expect(card._expected).toEqual({ status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null, customerId: CUST });
  });

  test('line items and the tax rate are not accepted: they stay on the Invoices page', async () => {
    expect(INVOICE_EDIT_TOOLS.find((t) => t.name === 'edit_invoice').input_schema.properties).not.toHaveProperty('line_changes');
    expect(INVOICE_EDIT_TOOLS.find((t) => t.name === 'edit_invoice').input_schema.properties).not.toHaveProperty('tax_rate_percent');
    // Given alone they change nothing; given beside a title they are ignored, never sent to the page.
    expect(await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 50 }] })).toMatchObject({ code: 'nothing_to_change' });
    expect(await run('edit_invoice', { tax_rate_percent: 6 })).toMatchObject({ code: 'nothing_to_change' });
    const card = await run('edit_invoice', { title: 'Renamed', line_changes: [{ line_number: 2, unit_price: 50 }], tax_rate_percent: 6 });
    expect(card._body).toEqual({ title: 'Renamed' });
    expect(card.changes).toHaveLength(1);
  });

  test('an annual-plan anchor linked only through its visit (no term id on the row yet) is refused; an unverifiable check refuses too', async () => {
    mockResolveTerm.mockResolvedValueOnce('term-1');
    expect(await run('edit_invoice', { title: 'New title' })).toMatchObject({ code: 'needs_invoices_page', reason: 'annual_plan' });
    expect(mockResolveTerm).toHaveBeenCalledWith(expect.objectContaining({ id: INV }), expect.anything(), { strict: true });
    mockResolveTerm.mockRejectedValueOnce(new Error('db down'));
    expect(await run('edit_invoice', { title: 'New title' })).toMatchObject({ code: 'unverified' });
  });

  test('an invoice tied to an accepted estimate discloses the setup-fee alert re-check; an untied one still names it as conditional', async () => {
    const untied = await run('edit_invoice', { title: 'New title' });
    expect(untied.effects.map((e) => e.text).join(' ')).toMatch(/If this invoice is linked to an accepted estimate when it is saved, confirming re-checks/);
    state.scheduled_services[0].source_estimate_id = 'est-1';
    const tied = await run('edit_invoice', { title: 'New title' });
    expect(tied.effects).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'operational', text: expect.stringMatching(/setup fee: that alert may close, reopen or change/) })]));
  });

  test('titles compare with the same trimming on both sides: a spacing-only fix is a change, an identical title is not', async () => {
    setInvoice({ title: 'Quarterly  Service' });
    expect(await run('edit_invoice', { title: 'Quarterly Service' })).toMatchObject({ preview: true, _body: { title: 'Quarterly Service' } });
    expect(await run('edit_invoice', { title: 'Quarterly  Service' })).toMatchObject({ code: 'no_change' });
  });

  test('"" clears the title and notes (the page sends null)', async () => {
    setInvoice({ notes: 'old note' });
    const card = await run('edit_invoice', { title: '', notes: '' });
    expect(card._body).toEqual({ title: null, notes: null });
    expect(card.changes).toEqual([
      { field: 'Title', before: 'Quarterly Pest Control', after: '(empty)' },
      { field: 'Notes', before: 'old note', after: '(empty)' },
    ]);
  });

  test('a draft needs no resend line; a scheduled invoice says its scheduled send carries the edit', async () => {
    setInvoice({ status: 'draft' });
    expect(JSON.stringify((await run('edit_invoice', { title: 'X' })).effects)).not.toMatch(/already received/);
    setInvoice({ status: 'scheduled' });
    expect(JSON.stringify((await run('edit_invoice', { title: 'X' })).effects)).toMatch(/scheduled send carries the edited version/);
  });

  test('refusals: nothing to change; an edit that changes nothing; bad input', async () => {
    expect(await run('edit_invoice')).toMatchObject({ code: 'nothing_to_change', error: expect.stringMatching(/Invoices page/) });
    expect(await run('edit_invoice', { title: 'Quarterly Pest Control' })).toMatchObject({ code: 'no_change' });
    expect(await run('edit_invoice', { due_date: '2099-01-15' })).toMatchObject({ code: 'no_change' });
    expect(await run('edit_invoice', { due_date: '2099-02-30' })).toMatchObject({ code: 'invalid_due_date' });
    expect(await run('edit_invoice', { due_date: 'next week' })).toMatchObject({ code: 'invalid_due_date' });
    expect(await run('edit_invoice', { notes: 'x'.repeat(2001) })).toMatchObject({ code: 'notes_too_long' });
    expect(await run('edit_invoice', { title: 'x'.repeat(301) })).toMatchObject({ code: 'title_too_long' });
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['paid', 'by_owner_rule'], ['prepaid', 'by_owner_rule'], ['processing', 'by_owner_rule'], ['refunded', 'by_owner_rule'],
    ['void', 'not_editable'], ['canceled', 'not_editable'], ['sending', 'not_editable'],
  ])('a %s invoice is refused as %s', async (status, code) => {
    setInvoice({ status });
    expect(await run('edit_invoice', { title: 'X' })).toMatchObject({ code });
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['an open card-payment session', { stripe_payment_intent_id: 'pi_test_1' }, 'not_editable'],
    ['an annual prepay term', { annual_prepay_term_id: 'term-1' }, 'needs_invoices_page'],
  ])('%s refuses any edit', async (_label, change, code) => {
    setInvoice(change);
    expect(await run('edit_invoice', { title: 'X' })).toMatchObject({ code });
  });

  test('an active payment plan and a finalized payer statement refuse any edit; an open statement does not', async () => {
    state.payment_plans = [{ id: 'plan-1', invoice_id: INV, status: 'active' }];
    expect(await run('edit_invoice', { title: 'X' })).toMatchObject({ code: 'not_editable', reason: 'payment_plan' });
    state.payment_plans = [];
    setInvoice({ payer_statement_id: 'stmt-1' });
    state.payer_statements = [{ id: 'stmt-1', status: 'finalized' }];
    expect(await run('edit_invoice', { title: 'X' })).toMatchObject({ code: 'not_editable', reason: 'finalized_statement' });
    state.payer_statements = [{ id: 'stmt-1', status: 'open' }];
    expect(await run('edit_invoice', { title: 'X' })).toMatchObject({ preview: true });
  });

  test('card lines carry each change as before -> after and end with the nothing-is-sent line (the contract)', async () => {
    const card = await run('edit_invoice', { title: 'Spring service', due_date: '2099-02-01' });
    const lines = cardLines('edit_invoice', card);
    expect(lines[0].text).toBe('Edit invoice WPC-2099-0001 for Robin Sample (sent, $129.00): title, notes or due date only');
    expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Due date: 2099-01-15 -> 2099-02-01', before: '2099-01-15', after: '2099-02-01' })]));
    const contract = buildContract({ toolName: 'edit_invoice', params: { invoice_id: INV }, displayParams: {}, preview: card, summary: '' });
    const labels = JSON.stringify(contract);
    expect(labels).toMatch(/Edit invoice WPC-2099-0001/);
    expect(labels).toMatch(/Due date: 2099-01-15 -> 2099-02-01/);
    expect(labels).toMatch(/Nothing is sent/);
  });
});

describe('edit_invoice confirm', () => {
  const input = { title: 'Spring service', due_date: '2099-02-01' };

  test('runs the page handler once with the carded body, the actor and the invoice version (customer included)', async () => {
    const card = await run('edit_invoice', input);
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { id: INV, status: 'sent', total: '129.00' } });
    const done = await confirm('edit_invoice', card, input);
    expect(done).toMatchObject({ success: true, status: 'sent', total: '$129.00', sent_to_customer: false, invoice_number: 'WPC-2099-0001' });
    expect(done.note).toMatch(/not sent the new version/);
    expect(Invoices.editInvoiceFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.editInvoiceFromBar).toHaveBeenCalledWith({
      invoiceId: INV, body: card._body, actor: { technicianId: 'staff-1', name: 'Pat Admin', email: 'admin@example.com' },
      expected: { status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null, customerId: CUST },
    });
    expect(Invoices.editInvoiceFromBar.mock.calls[0][0].expected).not.toHaveProperty('newTotal');
    expect(Invoices.editInvoiceFromBar.mock.calls[0][0].expected).not.toHaveProperty('selfPayLive');
  });

  test('an estimate link that appears after the card (it changes the setup-fee disclosure) refuses at Confirm as changed', async () => {
    const card = await run('edit_invoice', input);
    expect(card._version.setup_fee_tied).toBe(false);
    state.scheduled_services[0].source_estimate_id = 'est-1';
    const refused = await confirm('edit_invoice', card, input);
    expect(refused).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
    // The same card, re-asked with the link in place, pins the tie and confirms.
    const tied = await run('edit_invoice', input);
    expect(tied._version.setup_fee_tied).toBe(true);
    expect(await confirm('edit_invoice', tied, input)).toMatchObject({ success: true });
  });

  test.each([
    ['status', { status: 'viewed' }], ['edit time', { updated_at: new Date('2099-01-02T00:00:00Z') }], ['total', { total: '130.00' }],
    ['credit', { credit_applied: '5.00' }], ['a line', { line_items: [{ client_id: 'li_a', description: 'Quarterly Pest Control', quantity: 1, unit_price: 99, amount: 99 }, { client_id: 'li_b', description: 'Interior add-on', quantity: 1, unit_price: 31, amount: 31 }] }],
    ['the payer statement', { payer_statement_id: 'stmt-9' }],
    ['the customer (a merge repoints it without moving the edit time)', { customer_id: '00000000-0000-4000-8000-0000000000c2' }],
  ])('a changed %s after the card refuses with preview_changed and runs nothing', async (_label, change) => {
    const card = await run('edit_invoice', input);
    setInvoice(change);
    state.payer_statements = [{ id: 'stmt-9', status: 'open' }];
    state.customers.push({ id: '00000000-0000-4000-8000-0000000000c2', first_name: 'Sam', last_name: 'Other', property_type: 'residential' });
    const refused = await confirm('edit_invoice', card, input);
    // Drift, or (when the change makes the edit refusable, as applied credit does) the refusal itself: never an edit.
    expect(refused).toMatchObject({ preview_changed: true });
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a different body than the card’s is drift', async () => {
    const card = await run('edit_invoice', input);
    expect(await confirm('edit_invoice', card, { title: 'Another title', due_date: '2099-02-01' })).toMatchObject({ code: 'preview_changed' });
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('an invoice that became refusable after the card is refused at Confirm, not edited', async () => {
    const card = await run('edit_invoice', input);
    setInvoice({ status: 'paid' });
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ code: 'by_owner_rule', preview_changed: true });
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the page’s refusals come back in the card’s words: drift, money, other, not found', async () => {
    const card = await run('edit_invoice', input);
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Invoice changed while editing — re-check and retry', code: 'PREVIEW_CHANGED' } });
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Cannot edit amounts on an invoice with payment already applied' } });
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ failed: true, code: 'by_owner_rule' });
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'A payment reminder for this invoice is sending right now — try again in a minute' } });
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ failed: true, code: 'refused_by_page', error: expect.stringMatching(/sending right now/) });
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 404, json: { error: 'Not found' } });
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ failed: true, code: 'not_found', preview_changed: true });
  });

  test('a throw after approval never invites a retry; an answer for another invoice is unverified', async () => {
    const card = await run('edit_invoice', input);
    Invoices.editInvoiceFromBar.mockRejectedValueOnce(new Error('database down'));
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { id: 'another-invoice', status: 'sent', total: '129.00' } });
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ outcome_unknown: true, code: 'edit_unverified' });
  });
});

describe('archive_invoice / unarchive_invoice', () => {
  beforeEach(() => setInvoice({ status: 'void' }));

  test('archive: the card says the invoice leaves the default list and nothing else changes; nothing is sent', async () => {
    const card = await run('archive_invoice');
    expect(card).toMatchObject({ preview: true, tool: 'archive_invoice', status: 'void', amount: '$129.00', sends_to_customer: false });
    expect(JSON.stringify(card.effects)).toMatch(/leaves the default invoice list/);
    nothingSent(card);
    expect(cardLines('archive_invoice', card)[0].text).toBe('Archive invoice WPC-2099-0001 for Robin Sample (void, $129.00)');
    expect(card._expected).toEqual({ status: 'void', updatedAt: UPDATED.getTime(), archived: false, customerId: CUST });
  });

  test('archive: only a voided invoice, and not twice', async () => {
    setInvoice({ status: 'sent' });
    expect(await run('archive_invoice')).toMatchObject({ code: 'not_voided' });
    setInvoice({ status: 'void', archived_at: new Date() });
    expect(await run('archive_invoice')).toMatchObject({ code: 'already_archived' });
  });

  test('unarchive: only an archived invoice', async () => {
    expect(await run('unarchive_invoice')).toMatchObject({ code: 'not_archived' });
    setInvoice({ archived_at: new Date('2099-01-02T00:00:00Z') });
    const card = await run('unarchive_invoice');
    expect(card).toMatchObject({ preview: true, tool: 'unarchive_invoice' });
    expect(JSON.stringify(card.effects)).toMatch(/goes back into the default invoice list/);
    expect(card._expected.archived).toBe(true);
  });

  test('confirm runs the handler once with the version; drift refuses before it', async () => {
    const card = await run('archive_invoice');
    const done = await confirm('archive_invoice', card);
    expect(done).toMatchObject({ success: true, archived: true, sent_to_customer: false });
    expect(Invoices.archiveInvoiceFromBar).toHaveBeenCalledWith({ invoiceId: INV, expected: card._expected });
    Invoices.archiveInvoiceFromBar.mockClear();
    setInvoice({ updated_at: new Date('2099-01-02T00:00:00Z') });
    expect(await confirm('archive_invoice', card)).toMatchObject({ code: 'preview_changed' });
    expect(Invoices.archiveInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('unarchive confirm: runs the handler; the page’s drift answer and a wrong final state are reported', async () => {
    setInvoice({ archived_at: new Date('2099-01-02T00:00:00Z') });
    const card = await run('unarchive_invoice');
    expect(await confirm('unarchive_invoice', card)).toMatchObject({ success: true, archived: false });
    expect(Invoices.unarchiveInvoiceFromBar).toHaveBeenCalledWith({ invoiceId: INV, expected: card._expected });
    Invoices.unarchiveInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Invoice changed while unarchiving — re-check and retry', code: 'PREVIEW_CHANGED' } });
    expect(await confirm('unarchive_invoice', card)).toMatchObject({ failed: true, code: 'preview_changed' });
    Invoices.unarchiveInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { id: INV, status: 'void', archived_at: '2099-01-03T00:00:00Z' } });
    expect(await confirm('unarchive_invoice', card)).toMatchObject({ outcome_unknown: true, code: 'archive_unverified' });
    Invoices.unarchiveInvoiceFromBar.mockRejectedValueOnce(new Error('db'));
    expect(await confirm('unarchive_invoice', card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });
});

describe('unvoid_invoice', () => {
  beforeEach(() => setInvoice({ status: 'void', archived_at: new Date('2099-01-02T00:00:00Z') }));

  test('the card says the invoice becomes a draft (editable, collectible), reminders do not restart until it is sent, nothing queued is cancelled or handed over, nothing is sent', async () => {
    const card = await run('unvoid_invoice');
    expect(card).toMatchObject({ preview: true, tool: 'unvoid_invoice', status: 'void', amount: '$129.00', becomes: 'draft (editable, collectible again)', reminders_restart: false, sends_to_customer: false });
    const text = JSON.stringify(card.effects);
    expect(text).toMatch(/becomes a draft again: editable and payable/);
    expect(text).toMatch(/reminders do NOT restart now/);
    expect(text).toMatch(/Nothing queued for it is cancelled or handed over/);
    expect(text).toMatch(/leaves the archive/);
    expect(text).toMatch(/linked visit \(2099-01-01, completed\)/);
    nothingSent(card);
    expect(cardLines('unvoid_invoice', card)[0].text).toBe('Unvoid invoice WPC-2099-0001 for Robin Sample: $129.00, void -> draft');
    expect(card._expected).toEqual({ status: 'void', updatedAt: UPDATED.getTime(), customerId: CUST });
  });

  test('a voided invoice tied to an accepted estimate discloses the setup-fee alert re-check; an untied one still names it as conditional', async () => {
    expect(JSON.stringify((await run('unvoid_invoice')).effects)).toMatch(/If this invoice is linked to an accepted estimate when it is saved/);
    state.scheduled_services[0].source_estimate_id = 'est-1';
    expect(JSON.stringify((await run('unvoid_invoice')).effects)).toMatch(/Confirming re-checks the staff alert that asks the office to bill its setup fee/);
    state.scheduled_services[0].source_estimate_id = null;
    setInvoice({ notes: 'Accepted estimate #est-2' });
    const stamped = (await run('unvoid_invoice'));
    const { acceptedEstimateIdFromNotes } = require('../services/setup-fee-alert-reconcile');
    expect(JSON.stringify(stamped.effects).includes('This invoice belongs to an accepted estimate')).toBe(Boolean(acceptedEstimateIdFromNotes('Accepted estimate #est-2')));
  });

  test('an estimate link that appears after the card (it changes the setup-fee disclosure) refuses at Confirm as changed', async () => {
    const card = await run('unvoid_invoice');
    expect(card._version.setup_fee_tied).toBe(false);
    state.scheduled_services[0].source_estimate_id = 'est-1';
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(Invoices.unvoidInvoiceFromBar).not.toHaveBeenCalled();
    const tied = await run('unvoid_invoice');
    expect(tied._version.setup_fee_tied).toBe(true);
    expect(await confirm('unvoid_invoice', tied)).toMatchObject({ success: true });
  });

  test('a linked visit the unvoid itself refuses (cancelled, free re-service, $0, prepaid) is refused at preview, never carded', async () => {
    mockUnvoidableVisit.mockRejectedValueOnce(new Error('the linked visit was cancelled'));
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'visit_refuses_unvoid', error: expect.stringMatching(/linked visit was cancelled/) });
    mockUnvoidableVisit.mockRejectedValueOnce(Object.assign(new Error(''), {}));
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'visit_refuses_unvoid' });
    expect(mockUnvoidableVisit).toHaveBeenCalledWith(db, expect.objectContaining({ id: INV }));
    expect(state.writes).toEqual([]);
  });

  test('an invoice with an old pay-session stamp says it is checked with Stripe; one on a payer statement stays on the page', async () => {
    setInvoice({ stripe_payment_intent_id: 'pi_test_1' });
    expect(JSON.stringify((await run('unvoid_invoice')).effects)).toMatch(/old card-payment session is checked with Stripe/);
    setInvoice({ stripe_payment_intent_id: null, payer_statement_id: 'stmt-1' });
    state.payer_statements = [{ id: 'stmt-1', status: 'open' }];
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page', reason: 'payer_statement' });
  });

  test.each([
    ['a scheduled or sending message (any kind) tied to it', 'queued_message'],
    ['an active reminder sequence', 'followup_sequence'],
    ['a visit-linked invoice a payer now owns', 'linked_payer_owner'],
  ])('%s leaves it to the Invoices page (reasons come from InvoiceService._unvoidObligationReason, tested for real in invoice-bar-expected-version)', async (_label, reason) => {
    mockObligation.mockResolvedValueOnce(reason);
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page', reason });
    expect(Invoices.unvoidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['not void', { status: 'sent' }, 'not_voided'],
    ['an annual prepay term', { annual_prepay_term_id: 'term-1' }, 'needs_invoices_page'],
    ['annual coverage', { annual_prepay_covered_term_id: 'term-1' }, 'needs_invoices_page'],
    ['an annual prepay title', { title: 'Annual Prepay 2099' }, 'needs_invoices_page'],
    ['a prepay-switch marker', { notes: 'x [prepay-switch-superseded-by:abc] y' }, 'needs_invoices_page'],
    ['a deposit credit', { line_items: [{ description: 'Service', amount: 100 }, { description: 'Deposit', amount: -20, category: 'deposit_credit' }] }, 'needs_invoices_page'],
    ['a recorded payment', { payment_recorded_at: new Date() }, 'by_owner_rule'],
  ])('%s is refused as %s', async (_label, change, code) => {
    setInvoice(change);
    expect(await run('unvoid_invoice')).toMatchObject({ code });
    expect(Invoices.unvoidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['a bait-station setup fee line', { line_items: [{ description: 'Bait Station Setup — one-time setup fee', amount: 99 }] }],
    ['a membership-dues month', { line_items: [{ description: 'Dues', amount: 50, membership_dues_month: '2099-01' }] }],
  ])('%s is left to the Invoices page: the restore also changes other records', async (_label, change) => {
    setInvoice(change);
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page' });
    expect(Invoices.unvoidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a setup-fee claim, an office handoff alert and a live replacement draft each leave it to the Invoices page, even with a renamed line', async () => {
    state.setup_fee_claims = [{ id: 'claim-1', invoice_id: INV }];
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page', reason: 'setup_fee' });
    state.setup_fee_claims = [];
    state.dispatch_alerts = [{ id: 'alert-1', type: 'setup_fee_office_billing' }];
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page', reason: 'setup_fee' });
    state.dispatch_alerts = [];
    state.invoices.push({ id: 'inv-rebill', status: 'draft', notes: `Re-billed after invoice ${INV} was voided [rodent-setup-rebill:${INV}]` });
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page', reason: 'setup_fee' });
  });

  test.each([
    ['a combined-visit (packet) invoice', { visit_completion_packet_id: 'packet-1' }, 'packet_invoice'],
    ['a payer-billed invoice', { payer_id: 'payer-1' }, 'payer_billed'],
    ['a withdrawn invoice whose payer was removed (the stamp stays)', { scheduled_send_error: 'payer_billed:payer-1' }, 'payer_billed'],
    ['a withdrawn invoice with a hold / park flag', { scheduled_send_error: 'payer_billed:payer-1:park:hold' }, 'payer_billed'],
  ])('%s is left to the Invoices page: the restore re-checks Bill-To and can release it to the send queue', async (_label, change, reason) => {
    setInvoice(change);
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page', reason });
    expect(Invoices.unvoidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a stamp that appears after the card refuses at Confirm, before the handler', async () => {
    const card = await run('unvoid_invoice');
    setInvoice({ scheduled_send_error: 'payer_billed:payer-1', payer_id: null });
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ code: 'needs_invoices_page', preview_changed: true });
    expect(Invoices.unvoidInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('an unreadable obligation check fails closed', async () => {
    mockObligation.mockRejectedValueOnce(new Error('db down'));
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'unverified' });
  });

  test('a setup-fee claim that appears after the card refuses at Confirm, before the handler; the restore’s own fence maps to the page', async () => {
    const card = await run('unvoid_invoice');
    state.setup_fee_claims = [{ id: 'claim-1', invoice_id: INV }];
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ code: 'needs_invoices_page', preview_changed: true });
    expect(Invoices.unvoidInvoiceFromBar).not.toHaveBeenCalled();
    state.setup_fee_claims = [];
    Invoices.unvoidInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Cannot unvoid from the bar — this invoice carries a bait-station setup fee or a membership-dues month; restore it from the Invoices page' } });
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ failed: true, code: 'needs_invoices_page' });
  });

  test('a payment on file, an owning annual term, a finalized statement and a charge in progress are refused', async () => {
    state.payments = [{ id: 'pay-1', status: 'paid' }];
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'by_owner_rule', reason: 'payment_on_file' });
    state.payments = [];
    state.annual_prepay_terms = [{ id: 'term-1', prepay_invoice_id: INV }];
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page' });
    state.annual_prepay_terms = [];
    setInvoice({ payer_statement_id: 'stmt-1' });
    state.payer_statements = [{ id: 'stmt-1', status: 'sent' }];
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'needs_invoices_page', reason: 'finalized_statement' });
    state.payer_statements = [];
    setInvoice({ payer_statement_id: null });
    mockAssertNoCharge.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }));
    expect(await run('unvoid_invoice')).toMatchObject({ code: 'by_owner_rule', reason: 'charge_in_progress' });
  });

  test('confirm runs the handler once with the version; drift refuses before it; the handler’s own refusal is reported', async () => {
    const card = await run('unvoid_invoice');
    const done = await confirm('unvoid_invoice', card);
    expect(done).toMatchObject({ success: true, status: 'draft', sent_to_customer: false });
    expect(done.note).toMatch(/reminders restart only when it is sent/);
    expect(Invoices.unvoidInvoiceFromBar).toHaveBeenCalledWith({ invoiceId: INV, expected: card._expected });
    Invoices.unvoidInvoiceFromBar.mockClear();
    setInvoice({ updated_at: new Date('2099-01-05T00:00:00Z') });
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ code: 'preview_changed' });
    setInvoice({ updated_at: UPDATED });
    Invoices.unvoidInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'This invoice still has a live payment session (requires_payment_method); resolve it before unvoiding' } });
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ failed: true, code: 'refused_by_page', error: expect.stringMatching(/live payment session/) });
    Invoices.unvoidInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Invoice status changed while unvoiding — re-check and retry' } });
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ failed: true, code: 'preview_changed' });
  });

  test('a throw after the restore committed reads the invoice back; otherwise it is an unknown outcome', async () => {
    const card = await run('unvoid_invoice');
    Invoices.unvoidInvoiceFromBar.mockImplementationOnce(async () => { setInvoice({ status: 'draft' }); throw new Error('post-commit step failed'); });
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ success: true, warning: true, status: 'draft' });
    setInvoice({ status: 'void' });
    Invoices.unvoidInvoiceFromBar.mockRejectedValueOnce(new Error('db down'));
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    Invoices.unvoidInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { id: INV, status: 'sent' } });
    expect(await confirm('unvoid_invoice', card)).toMatchObject({ outcome_unknown: true, code: 'unvoid_unverified' });
  });
});

describe('every card pins the customer (a merge repoints invoices.customer_id without moving the edit time)', () => {
  const OTHER = '00000000-0000-4000-8000-0000000000c2';
  test.each([
    ['archive_invoice', { status: 'void' }],
    ['unarchive_invoice', { status: 'void', archived_at: new Date('2099-01-02T00:00:00Z') }],
    ['unvoid_invoice', { status: 'void' }],
  ])('%s: the handler is handed the customer, and a repoint after the card refuses at Confirm', async (tool, change) => {
    setInvoice(change);
    const card = await run(tool);
    expect(card._expected.customerId).toBe(CUST);
    expect(card._version.customer_id).toBe(CUST);
    setInvoice({ customer_id: OTHER });
    state.customers.push({ id: OTHER, first_name: 'Sam', last_name: 'Other', property_type: 'residential' });
    expect(await confirm(tool, card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    for (const fn of Object.values(Invoices)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('no write from the tool itself', () => {
  test.each(INVOICE_EDIT_TOOL_NAMES)('%s: preview and confirm never write through the tool’s own database handle', async (name) => {
    setInvoice(['archive_invoice', 'unarchive_invoice', 'unvoid_invoice'].includes(name) ? { status: 'void', archived_at: name === 'archive_invoice' ? null : new Date('2099-01-02T00:00:00Z') } : {});
    const input = name === 'edit_invoice' ? { title: 'Renamed' } : {};
    const card = await run(name, input);
    expect(card.preview).toBe(true);
    await confirm(name, card, input);
    expect(state.writes).toEqual([]);
  });
});
