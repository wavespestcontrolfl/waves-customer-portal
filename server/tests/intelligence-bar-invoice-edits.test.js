/**
 * IB invoice edit cards (owner ruling 2026-10-12, Stage 3 cards): edit_invoice, apply_invoice_credit, archive_invoice,
 * unarchive_invoice and unvoid_invoice replay the Invoices page's own handlers in process behind a card, dark behind
 * GATE_IB_INVOICE_EDITS (needs GATE_IB_PLATFORM). What each card shows (before -> after, money, that nothing is sent),
 * pin drift, every refusal, gate off, admin only, and that the commit runs the page's handler once with the card's
 * invoice version. The handlers are mocked here; admin-invoices-edit-handler-replay.test.js,
 * admin-invoices-apply-credit-bar-replay.test.js and invoice-bar-expected-version.test.js cover the real ones.
 * Nothing here reaches a provider. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-invoices', () => ({
  editInvoiceFromBar: jest.fn(),
  applyCreditFromBar: jest.fn(),
  archiveInvoiceFromBar: jest.fn(),
  unarchiveInvoiceFromBar: jest.fn(),
  unvoidInvoiceFromBar: jest.fn(),
}));
const mockAssertNoCharge = jest.fn();
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: (...a) => mockAssertNoCharge(...a),
}));
const mockLinkedVisit = jest.fn();
const mockCalc = jest.fn();
const mockUnbacked = jest.fn();
const mockObligation = jest.fn();
jest.mock('../services/invoice', () => ({
  linkedScheduledServiceId: (...a) => mockLinkedVisit(...a),
  _unvoidObligationReason: (...a) => mockObligation(...a),
  _calculateUpdateFinancials: (...a) => mockCalc(...a),
  _invoiceHasUnbackedDocumentDiscount: (...a) => mockUnbacked(...a),
}));
const mockResolveTerm = jest.fn();
jest.mock('../services/invoice-prepay', () => ({ resolveInvoiceTermId: (...a) => mockResolveTerm(...a) }));
const mockBalance = jest.fn();
jest.mock('../services/customer-credit', () => ({ getBalance: (...a) => mockBalance(...a) }));

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
    payments: [], payer_statements: [], payment_plans: [], stripe_invoice_charge_attempts: [], annual_prepay_terms: [], projects: [], setup_fee_claims: [], dispatch_alerts: [],
    scheduled_services: [{ id: VISIT, status: 'completed', scheduled_date: '2099-01-01', window_start: '09:00:00', window_end: '11:00:00' }],
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
  apply_invoice_credit: '_verified_invoice_credit_version',
  archive_invoice: '_verified_invoice_archive_version',
  unarchive_invoice: '_verified_invoice_unarchive_version',
  unvoid_invoice: '_verified_invoice_unvoid_version',
};
const confirm = (tool, card, input = {}, ctx = ADMIN) => executeInvoiceEditTool(tool,
  { invoice_id: INV, ...input, confirmed: true, [VERSION_KEY[tool]]: card._version }, ctx);
const setInvoice = (changes) => { state.invoices[0] = { ...state.invoices[0], ...changes }; };
const nothingSent = (card) => expect(JSON.stringify(card.effects)).toMatch(/Nothing is sent/);

// Mocked arithmetic of InvoiceService._calculateUpdateFinancials: positive lines add up, residential tax is zero.
function calc({ lineItems, taxRate }) {
  const subtotal = lineItems.reduce((sum, li) => sum + Math.max(0, Math.round((Number(li.quantity) || 1) * (Number(li.unit_price) || 0) * 100) / 100), 0);
  const rate = Number(taxRate || 0);
  const tax = Math.round(subtotal * rate * 100) / 100;
  return { subtotal, discount_amount: 0, tax_rate: rate, tax_amount: tax, total: subtotal + tax };
}

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  mockAssertNoCharge.mockResolvedValue(undefined);
  mockLinkedVisit.mockResolvedValue(VISIT);
  mockResolveTerm.mockResolvedValue(null);
  mockUnbacked.mockResolvedValue(false);
  mockBalance.mockResolvedValue(500);
  mockCalc.mockImplementation(async (args) => calc(args));
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
  Invoices.applyCreditFromBar.mockResolvedValue({ status: 200, json: { ok: true, invoice: { id: INV, status: 'prepaid' }, applied: 129, balance: 371 } });
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

  test('the five tools are exactly the ones the module exports', () => {
    expect(INVOICE_EDIT_TOOL_NAMES).toEqual(['edit_invoice', 'apply_invoice_credit', 'archive_invoice', 'unarchive_invoice', 'unvoid_invoice']);
  });

  test('the discovery search finds each by the operator’s words', () => {
    const cases = [
      ['edit invoice', 'edit_invoice'], ['change the due date on this invoice', 'edit_invoice'],
      ['apply account credit to the invoice', 'apply_invoice_credit'], ['archive the voided invoice', 'archive_invoice'],
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
  test('a price change shows the line before -> after and the old total -> new total, and sends nothing', async () => {
    const card = await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 50 }] });
    expect(card).toMatchObject({ preview: true, tool: 'edit_invoice', invoice_number: 'WPC-2099-0001', customer_name: 'Robin Sample', old_total: '$129.00', new_total: '$149.00', sends_to_customer: false });
    expect(card.changes).toEqual(expect.arrayContaining([
      { field: 'Line 2', before: 'Interior add-on — 1 × $30.00 = $30.00', after: 'Interior add-on — 1 × $50.00 = $50.00' },
      { field: 'Total', before: '$129.00', after: '$149.00' },
    ]));
    expect(card.lines_after).toEqual(['1. Quarterly Pest Control — 1 × $99.00 = $99.00', '2. Interior add-on — 1 × $50.00 = $50.00']);
    nothingSent(card);
    // The body is only what changed; untouched lines keep their stored fields.
    expect(card._body.line_items[0]).toMatchObject({ client_id: 'li_a', category: 'service', amount: 99 });
    expect(card._body.line_items[1]).toMatchObject({ client_id: 'li_b', unit_price: 50, amount: 50 });
    expect(Object.keys(card._body)).toEqual(['line_items']);
    expect(state.writes).toEqual([]);
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('title, notes and due date: before -> after per field; a delivered invoice is NOT resent and the card says so', async () => {
    const card = await run('edit_invoice', { title: 'Spring service', notes: 'Gate code on file', due_date: '2099-02-01' });
    expect(card.changes).toEqual([
      { field: 'Title', before: 'Quarterly Pest Control', after: 'Spring service' },
      { field: 'Notes', before: '(empty)', after: 'Gate code on file' },
      { field: 'Due date', before: '2099-01-15', after: '2099-02-01' },
    ]);
    expect(card.old_total).toBe(card.new_total);
    expect(mockCalc).not.toHaveBeenCalled(); // no retotal
    const text = JSON.stringify(card.effects);
    expect(text).toMatch(/does NOT resend it/);
    expect(text).toMatch(/reminder dates move/);
    expect(card._body).toEqual({ title: 'Spring service', notes: 'Gate code on file', due_date: '2099-02-01' });
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

  test('a new line gets a stable id (the confirm re-derives the same body); remove drops a line', async () => {
    const input = { line_changes: [{ description: 'Wasp nest removal', unit_price: 75 }, { line_number: 2, remove: true }] };
    const a = await run('edit_invoice', input);
    const b = await run('edit_invoice', input);
    expect(a._body.line_items.map((li) => li.description)).toEqual(['Quarterly Pest Control', 'Wasp nest removal']);
    expect(a._body.line_items[1]).toMatchObject({ quantity: 1, unit_price: 75, amount: 75 });
    expect(a._body.line_items[1].client_id).toMatch(/^li_bar_[0-9a-f]{12}$/);
    expect(b._version).toEqual(a._version);
    expect(a.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['Line 2 (removed)', 'New line', 'Total']));
    expect(a.new_total).toBe('$174.00');
  });

  test('the same line added by two successive confirmed edits persists distinct ids (never a duplicate client_id)', async () => {
    const input = { line_changes: [{ description: 'Wasp nest removal', unit_price: 75 }] };
    const first = await run('edit_invoice', input);
    const firstId = first._body.line_items[2].client_id;
    // Stable while the invoice is unchanged: a re-derive at Confirm gives the same body and pin.
    expect((await run('edit_invoice', input))._version).toEqual(first._version);
    // The first edit lands; an identical addition is asked for again.
    setInvoice({ line_items: first._body.line_items, updated_at: new Date('2099-01-05T00:00:00Z') });
    const second = await run('edit_invoice', input);
    const secondId = second._body.line_items[3].client_id;
    expect(secondId).not.toBe(firstId);
    expect(secondId).toMatch(/^li_bar_[0-9a-f]{12}$/);
    const ids = second._body.line_items.map((li) => li.client_id);
    expect(new Set(ids).size).toBe(ids.length);
    // The second addition is also stable between its preview and its Confirm.
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { id: INV, status: 'sent', total: '279.00' } });
    const done = await confirm('edit_invoice', second, input);
    expect(done.success).toBe(true);
    expect(Invoices.editInvoiceFromBar.mock.calls[0][0].body.line_items[3].client_id).toBe(secondId);
    // A third, fourth... keep resolving to free ids.
    setInvoice({ line_items: second._body.line_items, updated_at: new Date('2099-01-06T00:00:00Z') });
    const third = await run('edit_invoice', input);
    const thirdIds = third._body.line_items.map((li) => li.client_id);
    expect(new Set(thirdIds).size).toBe(thirdIds.length);
  });

  test('two identical lines added in one edit get distinct ids; an id matching a line this edit removes is still not reused', async () => {
    const twice = await run('edit_invoice', { line_changes: [{ description: 'Gate repair', unit_price: 20 }, { description: 'Gate repair', unit_price: 20 }] });
    const ids = twice._body.line_items.map((li) => li.client_id);
    expect(new Set(ids).size).toBe(ids.length);
    // Seed the id the next identical addition would take on a line this edit removes: it must move on to a free one.
    const probe = await run('edit_invoice', { line_changes: [{ description: 'Gate repair', unit_price: 20 }] });
    const wouldBe = probe._body.line_items[2].client_id;
    setInvoice({ line_items: [...state.invoices[0].line_items, { client_id: wouldBe, description: 'Old gate repair', quantity: 1, unit_price: 20, amount: 20 }] });
    const next = await run('edit_invoice', { line_changes: [{ line_number: 3, remove: true }, { description: 'Gate repair', unit_price: 20 }] });
    expect(next._body.line_items.map((li) => li.client_id)).not.toContain(wouldBe);
  });

  test('a commercial customer’s tax rate: percent in, fraction out, tax shown in the totals', async () => {
    setInvoice({ tax_rate: '0.0700', tax_amount: '9.03', total: '138.03' });
    state.customers[0].property_type = 'commercial';
    const card = await run('edit_invoice', { tax_rate_percent: 6 });
    expect(card._body).toEqual({ tax_rate: 0.06 });
    expect(card.changes.find((c) => c.field === 'Tax rate')).toEqual({ field: 'Tax rate', before: '7.00%', after: '6.00%' });
    expect(mockCalc).toHaveBeenCalledWith(expect.objectContaining({ taxRate: 0.06 }));
  });

  test('a residential customer’s tax rate is refused (the page taxes only commercial customers)', async () => {
    mockCalc.mockImplementation(async (args) => ({ ...calc(args), tax_rate: 0, tax_amount: 0 }));
    expect(await run('edit_invoice', { tax_rate_percent: 7 })).toMatchObject({ code: 'tax_rate_not_applicable' });
  });

  test('refusals: nothing to change; an edit that changes nothing; bad input', async () => {
    const empty = await run('edit_invoice');
    expect(empty).toMatchObject({ code: 'nothing_to_change' });
    expect(await run('edit_invoice', { title: 'Quarterly Pest Control' })).toMatchObject({ code: 'no_change' });
    expect(await run('edit_invoice', { due_date: '2099-01-15' })).toMatchObject({ code: 'no_change' });
    expect(await run('edit_invoice', { due_date: '2099-02-30' })).toMatchObject({ code: 'invalid_due_date' });
    expect(await run('edit_invoice', { due_date: 'next week' })).toMatchObject({ code: 'invalid_due_date' });
    expect(await run('edit_invoice', { tax_rate_percent: 40 })).toMatchObject({ code: 'invalid_tax_rate' });
    expect(await run('edit_invoice', { notes: 'x'.repeat(2001) })).toMatchObject({ code: 'notes_too_long' });
    expect(await run('edit_invoice', { title: 'x'.repeat(301) })).toMatchObject({ code: 'title_too_long' });
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test.each([
    [{ line_changes: [{ line_number: 3, unit_price: 5 }] }, 'line_not_found'],
    [{ line_changes: [{ line_number: 1, remove: true }, { line_number: 2, remove: true }] }, 'invoice_empty'],
    [{ line_changes: [{ line_number: 1 }] }, 'invalid_line_change'],
    [{ line_changes: [{ line_number: 1, unit_price: 0 }] }, 'invalid_line_change'],
    [{ line_changes: [{ line_number: 1, unit_price: -5 }] }, 'invalid_line_change'],
    [{ line_changes: [{ line_number: 1, unit_price: 10.005 }] }, 'invalid_line_change'],
    [{ line_changes: [{ description: 'No price' }] }, 'invalid_line_change'],
    [{ line_changes: [{ line_number: 1, unit_price: 5 }, { line_number: 1, unit_price: 6 }] }, 'invalid_line_change'],
    [{ line_changes: [{ remove: true }] }, 'invalid_line_change'],
    [{ line_changes: [{ line_number: 1, remove: true, unit_price: 3 }] }, 'invalid_line_change'],
    [{ line_changes: [{ description: 'x'.repeat(301), unit_price: 5 }] }, 'invalid_line_change'],
  ])('line change %j is refused as %s', async (input, code) => {
    expect(await run('edit_invoice', input)).toMatchObject({ code });
  });

  test('a bad line number lists the invoice’s numbered lines so the operator can retry', async () => {
    const refused = await run('edit_invoice', { line_changes: [{ line_number: 9, unit_price: 5 }] });
    expect(refused.lines).toEqual(['1. Quarterly Pest Control — 1 × $99.00 = $99.00', '2. Interior add-on — 1 × $30.00 = $30.00']);
  });

  test('discount, deposit and dues lines are not edited here; a line with a discount attached cannot be removed', async () => {
    setInvoice({ line_items: [
      { client_id: 'li_a', description: 'Service', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'li_d', description: 'Loyalty discount', quantity: 1, unit_price: -10, amount: -10, discount_id: 'disc-1', discount_for: 'li_a' },
      { client_id: 'li_m', description: 'Dues', quantity: 1, unit_price: 50, amount: 50, membership_dues_month: '2099-01' },
    ] });
    expect(await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 5 }] })).toMatchObject({ code: 'needs_invoices_page' });
    setInvoice({ line_items: [
      { client_id: 'li_a', description: 'Service', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'li_d', description: 'Loyalty discount', quantity: 1, unit_price: -10, amount: -10, discount_id: 'disc-1', discount_for: 'li_a' },
    ] });
    expect(await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 5 }] })).toMatchObject({ code: 'line_not_editable' });
    expect(await run('edit_invoice', { line_changes: [{ line_number: 1, remove: true }] })).toMatchObject({ code: 'line_not_editable' });
    // A different field of the same invoice still edits.
    expect(await run('edit_invoice', { title: 'Renamed' })).toMatchObject({ preview: true });
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

  test('an active payment plan and a finalized payer statement refuse any edit', async () => {
    state.payment_plans = [{ id: 'plan-1', invoice_id: INV, status: 'active' }];
    expect(await run('edit_invoice', { title: 'X' })).toMatchObject({ code: 'not_editable', reason: 'payment_plan' });
    state.payment_plans = [];
    setInvoice({ payer_statement_id: 'stmt-1' });
    state.payer_statements = [{ id: 'stmt-1', status: 'finalized' }];
    expect(await run('edit_invoice', { title: 'X' })).toMatchObject({ code: 'not_editable', reason: 'finalized_statement' });
    state.payer_statements = [{ id: 'stmt-1', status: 'open' }];
    const open = await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 50 }] });
    expect(JSON.stringify(open.effects)).toMatch(/payer’s open monthly statement is recalculated/);
  });

  test.each([
    ['a recorded payment', { payment_recorded_at: new Date() }, 'by_owner_rule'],
    ['credit applied', { credit_applied: '10.00' }, 'not_editable'],
    ['a deposit credit line', { line_items: [{ description: 'Service', amount: 100 }, { description: 'Deposit', amount: -20, category: 'deposit_credit' }] }, 'not_editable'],
  ])('%s refuses an amount edit but not a title edit', async (_label, change, code) => {
    setInvoice(change);
    expect(await run('edit_invoice', { tax_rate_percent: 5 })).toMatchObject({ code });
    expect(await run('edit_invoice', { title: 'Renamed' })).toMatchObject({ preview: true });
  });

  test('a payment on file, an unresolved saved-card attempt and an unbacked document discount refuse an amount edit', async () => {
    state.payments = [{ id: 'pay-1', status: 'paid' }];
    expect(await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 50 }] })).toMatchObject({ code: 'by_owner_rule', reason: 'payment_on_file' });
    state.payments = [];
    state.stripe_invoice_charge_attempts = [{ id: 'att-1', invoice_id: INV, status: 'claimed', resolved_at: null }];
    expect(await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 50 }] })).toMatchObject({ code: 'by_owner_rule', reason: 'charge_in_progress' });
    state.stripe_invoice_charge_attempts = [];
    mockUnbacked.mockResolvedValue(true);
    expect(await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 50 }] })).toMatchObject({ code: 'needs_invoices_page', reason: 'unbacked_discount' });
  });

  test('the page’s own arithmetic can refuse (an invalid discount) and the card reports it', async () => {
    mockCalc.mockRejectedValueOnce(new Error('Invalid line-item discount'));
    expect(await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 50 }] })).toMatchObject({ code: 'edit_refused', error: expect.stringMatching(/Invalid line-item discount/) });
  });

  test('card lines carry each change as before -> after and end with the nothing-is-sent line (the contract)', async () => {
    const card = await run('edit_invoice', { line_changes: [{ line_number: 2, unit_price: 50 }], due_date: '2099-02-01' });
    const lines = cardLines('edit_invoice', card);
    expect(lines[0].text).toBe('Edit invoice WPC-2099-0001 for Robin Sample (sent): total $129.00 -> $149.00');
    expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Due date: 2099-01-15 -> 2099-02-01', before: '2099-01-15', after: '2099-02-01' })]));
    const contract = buildContract({ toolName: 'edit_invoice', params: { invoice_id: INV }, displayParams: {}, preview: card, summary: '' });
    const labels = JSON.stringify(contract);
    expect(labels).toMatch(/Edit invoice WPC-2099-0001/);
    expect(labels).toMatch(/Due date: 2099-01-15 -> 2099-02-01/);
    expect(labels).toMatch(/Nothing is sent/);
  });
});

describe('edit_invoice confirm', () => {
  const input = { line_changes: [{ line_number: 2, unit_price: 50 }] };

  test('runs the page handler once with the carded body, the actor and the invoice version', async () => {
    const card = await run('edit_invoice', input);
    const done = await confirm('edit_invoice', card, input);
    expect(done).toMatchObject({ success: true, status: 'sent', total: '$149.00', sent_to_customer: false, invoice_number: 'WPC-2099-0001' });
    expect(done.note).toMatch(/not sent the new version/);
    expect(Invoices.editInvoiceFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.editInvoiceFromBar).toHaveBeenCalledWith({
      invoiceId: INV, body: card._body, actor: { technicianId: 'staff-1', name: 'Pat Admin', email: 'admin@example.com' },
      expected: { status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null, newTotal: 149 },
    });
  });

  test.each([
    ['status', { status: 'viewed' }], ['edit time', { updated_at: new Date('2099-01-02T00:00:00Z') }], ['total', { total: '130.00' }],
    ['credit', { credit_applied: '5.00' }], ['a line', { line_items: [{ client_id: 'li_a', description: 'Quarterly Pest Control', quantity: 1, unit_price: 99, amount: 99 }, { client_id: 'li_b', description: 'Interior add-on', quantity: 1, unit_price: 31, amount: 31 }] }],
    ['the payer statement', { payer_statement_id: 'stmt-9' }],
  ])('a changed %s after the card refuses with preview_changed and runs nothing', async (_label, change) => {
    const card = await run('edit_invoice', input);
    setInvoice(change);
    state.payer_statements = [{ id: 'stmt-9', status: 'open' }];
    const refused = await confirm('edit_invoice', card, input);
    // Drift, or (when the change makes the edit refusable, as applied credit does) the refusal itself: never an edit.
    expect(refused).toMatchObject({ preview_changed: true });
    expect(Invoices.editInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a changed new total (a discount rule moved) is drift; a different body than the card’s is drift', async () => {
    const card = await run('edit_invoice', input);
    mockCalc.mockImplementation(async (args) => ({ ...calc(args), total: 150 }));
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ code: 'preview_changed' });
    mockCalc.mockImplementation(async (args) => calc(args));
    expect(await confirm('edit_invoice', card, { line_changes: [{ line_number: 2, unit_price: 51 }] })).toMatchObject({ code: 'preview_changed' });
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

  test('a throw after approval never invites a retry; an answer that does not match the card is unverified', async () => {
    const card = await run('edit_invoice', input);
    Invoices.editInvoiceFromBar.mockRejectedValueOnce(new Error('database down'));
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { id: INV, status: 'sent', total: '200.00' } });
    expect(await confirm('edit_invoice', card, input)).toMatchObject({ outcome_unknown: true, code: 'edit_unverified' });
  });

  test('a title-only edit passes no new total to the page (nothing was retotalled)', async () => {
    const card = await run('edit_invoice', { title: 'Renamed' });
    Invoices.editInvoiceFromBar.mockResolvedValueOnce({ status: 200, json: { id: INV, status: 'sent', total: '129.00' } });
    const done = await confirm('edit_invoice', card, { title: 'Renamed' });
    expect(done.success).toBe(true);
    expect(Invoices.editInvoiceFromBar.mock.calls[0][0].expected).not.toHaveProperty('newTotal');
  });
});

describe('apply_invoice_credit card', () => {
  test('shows the credit available, the amount applied, the balance due after and the credit left; no card, nothing sent', async () => {
    const card = await run('apply_invoice_credit');
    expect(card).toMatchObject({
      preview: true, tool: 'apply_invoice_credit', invoice_number: 'WPC-2099-0001', customer_name: 'Robin Sample',
      credit_available: '$500.00', amount_applied: '$129.00', balance_due_before: '$129.00', balance_due_after: '$0.00', credit_after: '$371.00', sends_to_customer: false,
    });
    const text = JSON.stringify(card.effects);
    expect(text).toMatch(/marked prepaid/);
    expect(text).toMatch(/No card is used/);
    nothingSent(card);
    const lines = cardLines('apply_invoice_credit', card);
    expect(lines[0].text).toBe('Apply account credit to invoice WPC-2099-0001 for Robin Sample: $129.00 of $500.00 available');
    expect(lines[1].text).toBe('Balance due: $129.00 -> $0.00; account credit: $500.00 -> $371.00');
    expect(card._expected).toEqual({ status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null, balanceAfterCents: 37100 });
    expect(Invoices.applyCreditFromBar).not.toHaveBeenCalled();
  });

  test('partial credit already applied: the amount is the balance still due', async () => {
    setInvoice({ credit_applied: '29.00' });
    expect(await run('apply_invoice_credit')).toMatchObject({ amount_applied: '$100.00', credit_after: '$400.00' });
  });

  test('an optional amount must equal the balance due', async () => {
    expect(await run('apply_invoice_credit', { amount: 129 })).toMatchObject({ preview: true });
    expect(await run('apply_invoice_credit', { amount: 50 })).toMatchObject({ code: 'partial_not_supported', balance_due: 129 });
    expect(await run('apply_invoice_credit', { amount: 200 })).toMatchObject({ code: 'amount_exceeds_balance' });
    expect(await run('apply_invoice_credit', { amount: -1 })).toMatchObject({ code: 'invalid_amount' });
    expect(await run('apply_invoice_credit', { amount: 12.345 })).toMatchObject({ code: 'invalid_amount' });
  });

  test('not enough credit: refused with the shortfall, nothing applied', async () => {
    mockBalance.mockResolvedValue(100);
    const refused = await run('apply_invoice_credit');
    expect(refused).toMatchObject({ code: 'insufficient_credit', credit_available: 100, balance_due: 129 });
    expect(refused.error).toMatch(/short by \$29\.00/);
  });

  test.each([
    ['a payer invoice', { payer_id: 'payer-1' }, 'payer_invoice'],
    ['a payer statement', { payer_statement_id: 'stmt-1' }, 'payer_invoice'],
    ['a paid invoice', { status: 'paid' }, 'already_paid'],
    ['a prepaid invoice', { status: 'prepaid' }, 'already_paid'],
    ['a void invoice', { status: 'void' }, 'invoice_not_collectible'],
    ['a send in progress', { status: 'sending' }, 'send_in_progress'],
    ['a zero-dollar invoice', { total: '0.00' }, 'nothing_due'],
    ['an invoice already covered', { credit_applied: '129.00' }, 'nothing_due'],
    ['an open card-payment session', { stripe_payment_intent_id: 'pi_test_1' }, 'needs_invoices_page'],
  ])('%s is refused as %s and nothing is offered', async (_label, change, code) => {
    setInvoice(change);
    expect(await run('apply_invoice_credit')).toMatchObject({ code });
    expect(Invoices.applyCreditFromBar).not.toHaveBeenCalled();
  });

  test('an annual-plan invoice, an unverifiable plan check, a held report and a cancelled visit are refused', async () => {
    mockResolveTerm.mockResolvedValueOnce('term-1');
    expect(await run('apply_invoice_credit')).toMatchObject({ code: 'needs_invoices_page', reason: 'annual_plan' });
    mockResolveTerm.mockRejectedValueOnce(new Error('boom'));
    expect(await run('apply_invoice_credit')).toMatchObject({ code: 'unverified' });
    // Any linked project refuses, held or not: a report hold is written without moving the invoice, so the card cannot pin it.
    for (const hold of ['held', 'releasing', null, 'released']) {
      state.projects = [{ id: 'proj-1', invoice_id: INV, report_hold_status: hold }];
      expect(await run('apply_invoice_credit')).toMatchObject({ code: 'needs_invoices_page', reason: 'report_project' });
    }
    state.projects = [];
    state.scheduled_services[0].status = 'cancelled';
    expect(await run('apply_invoice_credit')).toMatchObject({ code: 'visit_terminal' });
  });

  test('a saved-card charge in progress is refused as money; an unreadable check fails closed', async () => {
    mockAssertNoCharge.mockRejectedValueOnce(Object.assign(new Error('x'), { reconciliationRequired: true }));
    expect(await run('apply_invoice_credit')).toMatchObject({ code: 'by_owner_rule', reason: 'charge_in_progress' });
    mockAssertNoCharge.mockRejectedValueOnce(new Error('db down'));
    expect(await run('apply_invoice_credit')).toMatchObject({ code: 'unverified' });
  });

  test('the note is carried to the credit entry and capped', async () => {
    const card = await run('apply_invoice_credit', { note: 'Goodwill from the March visit' });
    expect(card.office_note).toBe('Goodwill from the March visit');
    expect(card._body).toEqual({ waiveSetupFee: false, note: 'Goodwill from the March visit' });
    expect(await run('apply_invoice_credit', { note: 'x'.repeat(401) })).toMatchObject({ code: 'note_too_long' });
    expect((await run('apply_invoice_credit'))._body).toEqual({ waiveSetupFee: false });
  });

  test('the exact note is on the card (effect line and the confirmation display) and in the pinned version', async () => {
    const note = 'Goodwill from the March visit';
    const card = await run('apply_invoice_credit', { note: `  ${note}  ` });
    expect(card.effects).toEqual(expect.arrayContaining([{ kind: 'operational', text: `Note saved with the credit entry: "${note}"` }]));
    expect(cardLines('apply_invoice_credit', card).map((l) => l.text)).toContain(`Note saved with the credit entry: "${note}"`);
    expect(JSON.stringify(buildContract({ toolName: 'apply_invoice_credit', params: { invoice_id: INV }, displayParams: {}, preview: card, summary: '' }))).toContain(note);
    const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');
    expect(confirmationDisplayParams('apply_invoice_credit', { invoice_id: INV, note }, card)).toMatchObject({ invoice: 'WPC-2099-0001', note, amount_applied: '$129.00' });
    // A different note is a different approval: the pin changes.
    expect((await run('apply_invoice_credit', { note: 'Another note' }))._version).not.toEqual(card._version);
    // No note: the display says so and the card has no note line.
    const bare = await run('apply_invoice_credit');
    expect(confirmationDisplayParams('apply_invoice_credit', { invoice_id: INV }, bare)).toMatchObject({ note: 'none' });
    expect(JSON.stringify(bare.effects)).not.toMatch(/Note saved/);
  });

  test('a project that gets linked after the card refuses at Confirm, before the handler', async () => {
    const card = await run('apply_invoice_credit');
    state.projects = [{ id: 'proj-1', invoice_id: INV, report_hold_status: null }];
    expect(await confirm('apply_invoice_credit', card)).toMatchObject({ code: 'needs_invoices_page', preview_changed: true });
    expect(Invoices.applyCreditFromBar).not.toHaveBeenCalled();
    state.projects = [];
    Invoices.applyCreditFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Cannot apply credit from the bar — …', code: 'NEEDS_INVOICES_PAGE' } });
    expect(await confirm('apply_invoice_credit', card)).toMatchObject({ failed: true, code: 'needs_invoices_page' });
  });

  test('a visit-completion invoice discloses the review follow-up; an active plan discloses its completion', async () => {
    setInvoice({ service_record_id: 'rec-1' });
    state.payment_plans = [{ id: 'plan-1', invoice_id: INV, status: 'active' }];
    const text = JSON.stringify((await run('apply_invoice_credit')).effects);
    expect(text).toMatch(/review-request follow-up/);
    expect(text).toMatch(/payment plan is completed/);
  });
});

describe('apply_invoice_credit confirm', () => {
  test('runs the page handler once with the carded body, the actor and the version incl. the credit left', async () => {
    const card = await run('apply_invoice_credit');
    const done = await confirm('apply_invoice_credit', card);
    expect(done).toMatchObject({ success: true, status: 'prepaid', applied: '$129.00', credit_after: '$371.00', sent_to_customer: false });
    expect(done.note).toMatch(/no card was charged/);
    expect(Invoices.applyCreditFromBar).toHaveBeenCalledWith({
      invoiceId: INV, body: { waiveSetupFee: false }, actor: { technicianId: 'staff-1', name: 'Pat Admin', email: 'admin@example.com' }, expected: card._expected,
    });
  });

  test.each([
    ['the invoice was edited', () => setInvoice({ updated_at: new Date('2099-01-02T00:00:00Z') })],
    ['the invoice total changed', () => setInvoice({ total: '140.00' })],
    ['a card-payment session started', () => setInvoice({ stripe_payment_intent_id: 'pi_new' })],
    ['the customer’s credit moved', () => mockBalance.mockResolvedValue(480)],
  ])('drift (%s) refuses with preview_changed and applies nothing', async (_label, change) => {
    const card = await run('apply_invoice_credit');
    change();
    expect(await confirm('apply_invoice_credit', card)).toMatchObject({ preview_changed: true });
    expect(Invoices.applyCreditFromBar).not.toHaveBeenCalled();
  });

  test('the page’s answers: drift, insufficient credit as refusal, throw, and an invoice that does not read prepaid', async () => {
    const card = await run('apply_invoice_credit');
    Invoices.applyCreditFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'Invoice changed while applying credit — re-check and retry', code: 'PREVIEW_CHANGED' } });
    expect(await confirm('apply_invoice_credit', card)).toMatchObject({ failed: true, code: 'preview_changed' });
    Invoices.applyCreditFromBar.mockResolvedValueOnce({ status: 400, json: { error: 'Insufficient account credit — balance is $0.00' } });
    expect(await confirm('apply_invoice_credit', card)).toMatchObject({ failed: true, code: 'refused_by_page' });
    Invoices.applyCreditFromBar.mockRejectedValueOnce(new Error('database down'));
    expect(await confirm('apply_invoice_credit', card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    Invoices.applyCreditFromBar.mockResolvedValueOnce({ status: 200, json: { ok: true, invoice: { id: INV, status: 'sent' }, applied: 129, balance: 371 } });
    expect(await confirm('apply_invoice_credit', card)).toMatchObject({ outcome_unknown: true, code: 'credit_unverified' });
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
    expect(card._expected).toEqual({ status: 'void', updatedAt: UPDATED.getTime(), archived: false });
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
    expect(card._expected).toEqual({ status: 'void', updatedAt: UPDATED.getTime() });
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
