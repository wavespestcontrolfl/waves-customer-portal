/**
 * IB create_invoice (owner ruling 2026-10-12, Stage 3 cards): the Invoices page "Create invoice" handler run in
 * process behind a card, dark behind GATE_IB_CREATE_INVOICE (needs GATE_IB_PLATFORM). What the card shows (customer
 * and city, every line, tax, total, due date, linked visit, that the draft is not sent), the refusals (no customer,
 * amounts at or below 0, no lines, too many lines, a visit that is not the customer's, a payer-billed customer, a
 * retention offer), pin drift, gate off, admin only, and that the commit runs the page's handler once with the card's
 * body and total. The handlers are mocked here; admin-invoices-create-handler-replay.test.js covers the real ones.
 * Nothing here reaches a provider. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-invoices', () => ({ createInvoiceFromBar: jest.fn(), createInvoiceFromServiceFromBar: jest.fn() }));
const mockMintLock = jest.fn(async () => {});
jest.mock('../services/scheduled-invoice-mint', () => ({ acquireScheduledInvoiceMintLock: (...a) => mockMintLock(...a) }));
const mockPreviewTotals = jest.fn();
jest.mock('../services/invoice', () => ({ previewInvoiceTotals: (...a) => mockPreviewTotals(...a) }));
const mockResolvePayer = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolvePayer(...a) }));

const db = require('../models/db');
const Invoices = require('../routes/admin-invoices');
const tools = require('../services/intelligence-bar/create-invoice-tools');
const { executeCreateInvoiceTool, CREATE_INVOICE_TOOLS, cardLines } = tools;
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const CUST = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const REC = '00000000-0000-4000-8000-0000000000e1';
const VISIT = '00000000-0000-4000-8000-0000000000d1';
const INV = '00000000-0000-4000-8000-0000000000a1';
const ADMIN = { isAdmin: true, technicianId: 'staff-1', operationId: 'op-1' };

let state;
function freshState() {
  return {
    customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample', city: 'Sampleton', property_type: 'residential', payer_id: null, deleted_at: null }],
    service_records: [{ id: REC, customer_id: CUST, service_type: 'Quarterly Pest Control', service_date: '2099-01-05', scheduled_service_id: VISIT }],
    invoices: [],
    retention_offers: [],
    scheduled_services: [{ id: VISIT, customer_id: CUST, payer_id: null }],
    payers: [{ id: 'payer-1' }],
    locks: [],
  };
}

// A small knex stand-in: plain-object where / whereNull / whereNotIn filter the seeded rows. Any write throws.
function makeDb() {
  function builder(table) {
    const q = { wheres: [], nulls: [], notIns: [], single: false };
    const rows = () => {
      const found = (state[table] || []).filter((row) => q.wheres.every((group) => group.some((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v))))
        && q.nulls.every((k) => row[k] == null)
        && q.notIns.every(([k, list]) => !list.includes(row[k])));
      return q.single ? found[0] : found;
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        // An object is one condition; a function is an OR-group of the conditions it adds (this.where / this.orWhere).
        if (prop === 'where') {
          return (arg) => {
            if (typeof arg === 'function') {
              const group = [];
              arg.call({ where: (o) => { group.push(o); }, orWhere: (o) => { group.push(o); } });
              q.wheres.push(group);
            } else if (arg && typeof arg === 'object') q.wheres.push([arg]);
            return b;
          };
        }
        if (prop === 'whereNull') return (k) => { q.nulls.push(k); return b; };
        if (prop === 'whereNotIn') return (k, list) => { q.notIns.push([k, list]); return b; };
        if (prop === 'first') return () => { q.single = true; return b; };
        if (prop === 'forShare') return () => { state.locks.push(table); return b; };
        if (prop === 'whereIn') return (k, list) => { q.wheres.push([{ [k]: list[0] }]); return b; };
        if (['insert', 'update', 'del', 'delete', 'upsert', 'transaction'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  }
  return (table) => builder(table);
}

function envGate(on) {
  if (on) { process.env.GATE_IB_CREATE_INVOICE = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_CREATE_INVOICE; delete process.env.GATE_IB_PLATFORM; }
}

const LINES = [
  { description: 'Extra visit', quantity: 1, unit_price: 85 },
  { description: 'Fire ant mound treatment', quantity: 2, unit_price: 20.5 },
];
const lineInput = (over = {}) => ({ customer_id: CUST, title: 'Extra work', line_items: LINES, due_date: '2099-02-01', ...over });
const visitInput = (over = {}) => ({ customer_id: CUST, service_record_id: REC, amount: 120, ...over });
const preview = (input = lineInput(), ctx = ADMIN) => executeCreateInvoiceTool('create_invoice', input, ctx);
const confirm = (card, input = lineInput(), ctx = ADMIN) => executeCreateInvoiceTool('create_invoice',
  { ...input, confirmed: true, _verified_invoice_create_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  mockResolvePayer.mockResolvedValue({ payerId: null, taxExempt: false, snapshot: null, paymentTerms: null });
  // The service's own mirror of create(): the sum of the lines, no tax for a residential customer.
  mockPreviewTotals.mockImplementation(async ({ amount }) => ({ subtotal: amount, tax_rate: 0, tax_amount: 0, total: amount }));
  Invoices.createInvoiceFromBar.mockResolvedValue({ status: 201, json: { id: INV, invoice_number: 'WPC-2099-0042', status: 'draft', total: '126.00', due_date: '2099-02-01' } });
  Invoices.createInvoiceFromServiceFromBar.mockResolvedValue({ status: 201, json: { id: INV, invoice_number: 'WPC-2099-0043', status: 'draft', total: '120.00', due_date: null } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step write, admin only, never owner-direct, with a record-scoped policy', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('create_invoice')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('create_invoice')).toBe(true);
    expect(registry.actions.get('create_invoice')).toMatchObject({ domain: 'customers', kind: 'internal_write', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'create-invoice-tools.js' });
    expect(registry.policyErrors).not.toContain('create_invoice');
    expect(require('../services/intelligence-bar/owner-direct').OWNER_DIRECT_TOOL_NAMES.has('create_invoice')).toBe(false);
    expect(CREATE_INVOICE_TOOLS[0].input_schema.required).toEqual(['customer_id']);
    expect(CREATE_INVOICE_TOOLS[0]._sideEffects).toBe(true);
  });

  test('the discovery search finds it by the operator’s words and says it only drafts', () => {
    for (const query of ['create invoice', 'make a draft invoice', 'bill this customer']) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'customers', fullAccess: false });
      expect(definitions.map((d) => d.name)).toContain('create_invoice');
    }
    expect(CREATE_INVOICE_TOOLS[0].description).toMatch(/DRAFT only/);
    expect(CREATE_INVOICE_TOOLS[0].description).toMatch(/send_invoice/);
  });

  test('gate off: not discoverable; the platform gate is needed; a technician never gets it', () => {
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('create_invoice'), { role: 'admin', context: 'customers' })).toBe(false);
    envGate(false);
    const { definitions } = registry.discover({ query: 'create invoice' }, { role: 'admin', context: 'customers', fullAccess: false });
    expect(definitions.map((d) => d.name)).not.toContain('create_invoice');
    envGate(true);
    expect(registry.allowed(registry.actions.get('create_invoice'), { role: 'technician', context: 'tech' })).toBe(false);
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses with gate_off and nothing runs', async () => {
    envGate(false);
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(await executeCreateInvoiceTool('create_invoice', { ...lineInput(), confirmed: true, _verified_invoice_create_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(Invoices.createInvoiceFromBar).not.toHaveBeenCalled();
    expect(Invoices.createInvoiceFromServiceFromBar).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('the strict value is required, and the platform gate alone or the create gate alone is not enough', async () => {
    process.env.GATE_IB_CREATE_INVOICE = '1';
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    process.env.GATE_IB_CREATE_INVOICE = 'true';
    delete process.env.GATE_IB_PLATFORM;
    expect(await preview()).toMatchObject({ code: 'gate_off' });
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await preview(lineInput(), { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, lineInput(), {})).toMatchObject({ code: 'permission_denied' });
    expect(await confirm(card, lineInput(), { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(Invoices.createInvoiceFromBar).not.toHaveBeenCalled();
  });
});

describe('the preview (lines)', () => {
  test('shows the customer and city, every line, tax, total, due date, and that it is a draft that sends nothing', async () => {
    const card = await preview();
    expect(card).toMatchObject({
      preview: true, tool: 'create_invoice', mode: 'lines', customer_id: CUST, customer_name: 'Robin Sample', customer_city: 'Sampleton',
      title: 'Extra work', subtotal: '$126.00', tax: '$0.00', total: '$126.00', due_date: '2099-02-01', status: 'draft',
      sends_to_customer: false, charges_card: false,
    });
    expect(card.lines).toEqual(['Extra visit: 1 x $85.00 = $85.00', 'Fire ant mound treatment: 2 x $20.50 = $41.00']);
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/Creates a DRAFT invoice for Robin Sample \(Sampleton\): \$126\.00/);
    expect(text).toMatch(/only a draft: nothing is sent/);
    expect(text).toMatch(/use send_invoice afterwards/);
    expect(text).toMatch(/No card is charged and no payment is recorded/);
    expect(text).toMatch(/not linked to a visit/);
    expect(card._body).toEqual({
      customerId: CUST, title: 'Extra work', notes: null, dueDate: '2099-02-01',
      lineItems: [
        { description: 'Extra visit', quantity: 1, unit_price: 85, amount: 85 },
        { description: 'Fire ant mound treatment', quantity: 2, unit_price: 20.5, amount: 41 },
      ],
    });
    expect(card._expectedTotalCents).toBe(12600);
    expect(card._approved).toEqual({ expectedTotalCents: 12600, customerId: CUST, customerPin: 'Robin Sample|Sampleton', mode: 'lines', serviceRecordId: null, scheduledServiceId: null, visitInvoices: [] });
    expect(Invoices.createInvoiceFromBar).not.toHaveBeenCalled();
    const lines = cardLines('create_invoice', card).map((l) => l.text).join('\n');
    expect(lines).toMatch(/Create a draft invoice for Robin Sample \(Sampleton\): \$126\.00, "Extra work"/);
    expect(lines).toMatch(/Line: Extra visit: 1 x \$85\.00 = \$85\.00/);
    expect(lines).toMatch(/Subtotal \$126\.00, tax \$0\.00, total \$126\.00/);
    expect(lines).toMatch(/Due: 2099-02-01/);
    const contract = buildContract({ toolName: 'create_invoice', params: lineInput(), displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/use send_invoice afterwards/);
    expect(JSON.stringify(contract)).not.toMatch(/Customer will be contacted/);
  });

  test('the full notes are on the card, the pinned display and the contract; they are part of the pin', async () => {
    const notes = 'Customer asked to bill the gate repair separately.\nPO 4471.';
    const card = await preview(lineInput({ notes }));
    expect(card.notes).toBe(notes);
    expect(cardLines('create_invoice', card).map((l) => l.text)).toContain(`Notes on the invoice: ${notes}`);
    const contract = buildContract({ toolName: 'create_invoice', params: lineInput({ notes }), displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toContain('Customer asked to bill the gate repair separately.');
    expect(JSON.stringify(contract)).toContain('PO 4471.');
    const none = await preview();
    expect(cardLines('create_invoice', none).map((l) => l.text).join('\n')).not.toMatch(/Notes on the invoice/);
  });

  test('uses the server-computed tax and total, not the model’s', async () => {
    state.customers[0].property_type = 'commercial';
    mockPreviewTotals.mockResolvedValue({ subtotal: 126, tax_rate: 0.07, tax_amount: 8.82, total: 134.82 });
    const card = await preview(lineInput({ tax_rate: 0.07 }));
    expect(card).toMatchObject({ subtotal: '$126.00', tax: '$8.82', total: '$134.82' });
    expect(mockPreviewTotals).toHaveBeenCalledWith(expect.objectContaining({ customerId: CUST, amount: 126, taxRate: 0.07, title: 'Extra work' }));
    expect(card._body.taxRate).toBe(0.07);
    expect(card._expectedTotalCents).toBe(13482);
  });

  test('the due date defaults to 30 days out and is carded explicitly; a bad date or rate is refused', async () => {
    const card = await preview(lineInput({ due_date: undefined }));
    expect(card.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(card._body.dueDate).toBe(card.due_date);
    expect(await preview(lineInput({ due_date: '2099-02-30' }))).toMatchObject({ code: 'invalid_input' });
    expect(await preview(lineInput({ service_date: 'tomorrow' }))).toMatchObject({ code: 'invalid_input' });
    expect(await preview(lineInput({ tax_rate: 7 }))).toMatchObject({ code: 'invalid_input' });
    expect(await preview(lineInput({ tax_rate: -0.01 }))).toMatchObject({ code: 'invalid_input' });
  });

  test('a linked visit is shown, must be this customer’s, and a live invoice on it is named', async () => {
    const card = await preview(lineInput({ service_record_id: REC, service_date: '2099-01-05' }));
    expect(card.linked_visit).toBe('Quarterly Pest Control 2099-01-05');
    expect(card._body.serviceRecordId).toBe(REC);
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/links the Quarterly Pest Control visit of 2099-01-05; the visit itself is not changed/);
    state.invoices.push({ id: INV, service_record_id: REC, invoice_number: 'WPC-2099-0001', status: 'sent', total: '90.00' });
    state.invoices.push({ id: OTHER, service_record_id: REC, invoice_number: 'WPC-2099-0002', status: 'void', total: '90.00' });
    const warned = await preview(lineInput({ service_record_id: REC }));
    expect(warned.effects.map((e) => e.text).join('\n')).toMatch(/WPC-2099-0001 \(sent, \$90\.00\) already bills this visit/);
    expect(warned.effects.map((e) => e.text).join('\n')).not.toMatch(/WPC-2099-0002/);
    state.service_records[0].customer_id = OTHER;
    expect(await preview(lineInput({ service_record_id: REC }))).toMatchObject({ code: 'record_unavailable' });
    expect(await preview(lineInput({ service_record_id: 'nope' }))).toMatchObject({ code: 'invalid_target' });
  });

  test('a title is required unless a visit is linked (the page names it from the visit)', async () => {
    expect(await preview(lineInput({ title: '' }))).toMatchObject({ code: 'invalid_input' });
    expect(await preview(lineInput({ title: '', service_record_id: REC }))).toMatchObject({ preview: true });
  });
});

describe('the preview (from a completed visit)', () => {
  test('shows the visit, the one amount and the server total; the body is the visit route’s', async () => {
    const card = await preview(visitInput({ description: 'Extra ant treatment' }));
    expect(card).toMatchObject({ preview: true, mode: 'from_visit', customer_name: 'Robin Sample', total: '$120.00', status: 'draft', linked_visit: 'Quarterly Pest Control 2099-01-05', due_date: null });
    expect(card.lines).toEqual(['Extra ant treatment: 1 x $120.00 = $120.00']);
    expect(card._body).toEqual({ serviceRecordId: REC, amount: 120, description: 'Extra ant treatment' });
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/bills the Quarterly Pest Control visit of 2099-01-05/);
    expect(mockPreviewTotals).toHaveBeenCalledWith(expect.objectContaining({ serviceRecordId: REC, amount: 120 }));
    expect(cardLines('create_invoice', card).map((l) => l.text).join('\n')).toMatch(/Due: 30 days after it is created/);
  });

  test('refuses what the visit route would ignore, a missing visit, and both modes at once', async () => {
    expect(await preview(visitInput({ title: 'x' }))).toMatchObject({ code: 'invalid_input' });
    expect(await preview(visitInput({ tax_rate: 0.07 }))).toMatchObject({ code: 'invalid_input' });
    expect(await preview({ customer_id: CUST, amount: 50 })).toMatchObject({ code: 'invalid_input' });
    expect(await preview(visitInput({ line_items: LINES }))).toMatchObject({ code: 'invalid_input' });
    state.service_records[0].customer_id = OTHER;
    expect(await preview(visitInput())).toMatchObject({ code: 'record_unavailable' });
  });

  test('a customer with a granted retention offer stays on the Invoices page', async () => {
    state.retention_offers.push({ id: 'r1', customer_id: CUST, status: 'granted' });
    expect(await preview(visitInput())).toMatchObject({ code: 'needs_invoices_page', reason: 'retention_offer' });
  });
});

describe('refusals', () => {
  test('no customer, a bad customer id, an unknown customer, a deleted customer', async () => {
    expect(await preview(lineInput({ customer_id: undefined }))).toMatchObject({ code: 'invalid_target' });
    expect(await preview(lineInput({ customer_id: 'nope' }))).toMatchObject({ code: 'invalid_target' });
    expect(await preview(lineInput({ customer_id: OTHER }))).toMatchObject({ code: 'customer_not_found' });
    state.customers[0].deleted_at = new Date();
    expect(await preview()).toMatchObject({ code: 'customer_not_found' });
  });

  test('amounts at or below 0, odd cents, no lines, and more than 25 lines', async () => {
    const bad = (line) => preview(lineInput({ line_items: [line] }));
    expect(await bad({ description: 'x', unit_price: 0 })).toMatchObject({ code: 'invalid_amount' });
    expect(await bad({ description: 'x', unit_price: -5 })).toMatchObject({ code: 'invalid_amount' });
    expect(await bad({ description: 'x', unit_price: 10.005 })).toMatchObject({ code: 'invalid_amount' });
    expect(await bad({ description: 'x', quantity: 0, unit_price: 5 })).toMatchObject({ code: 'invalid_amount' });
    expect(await bad({ description: 'x', quantity: -1, unit_price: 5 })).toMatchObject({ code: 'invalid_amount' });
    expect(await bad({ description: 'x', unit_price: 'free' })).toMatchObject({ code: 'invalid_amount' });
    expect(await bad({ description: '  ', unit_price: 5 })).toMatchObject({ code: 'invalid_input' });
    expect(await preview(lineInput({ line_items: [] }))).toMatchObject({ code: 'invalid_input' });
    expect(await preview(lineInput({ line_items: undefined }))).toMatchObject({ code: 'invalid_input' });
    const many = Array.from({ length: 26 }, (_, i) => ({ description: `Line ${i}`, unit_price: 1 }));
    expect(await preview(lineInput({ line_items: many }))).toMatchObject({ code: 'too_many_lines' });
    expect(await preview(lineInput({ line_items: many.slice(0, 25) }))).toMatchObject({ preview: true, total: '$25.00' });
    expect(await preview(visitInput({ amount: 0 }))).toMatchObject({ code: 'invalid_amount' });
    expect(await preview(visitInput({ amount: -20 }))).toMatchObject({ code: 'invalid_amount' });
  });

  test('a customer billed through a third-party payer stays on the Invoices page; an unreadable payer check refuses', async () => {
    mockResolvePayer.mockResolvedValue({ payerId: 'payer-1', taxExempt: false, snapshot: { name: 'Sample Builders' }, paymentTerms: 'net30' });
    expect(await preview()).toMatchObject({ code: 'needs_invoices_page', reason: 'payer_billed' });
    mockResolvePayer.mockRejectedValue(new Error('db down'));
    expect(await preview()).toMatchObject({ code: 'unverified' });
  });

  test('a totals preview that fails or is not above $0 refuses, and nothing is created', async () => {
    mockPreviewTotals.mockRejectedValue(new Error('Service record not found for customer'));
    expect(await preview()).toMatchObject({ code: 'unverified' });
    expect(Invoices.createInvoiceFromBar).not.toHaveBeenCalled();
  });
});

describe('the confirmed run', () => {
  test('runs the page’s handler once with exactly the carded body and total, and reports a draft that was not sent', async () => {
    const card = await preview();
    const result = await confirm(card);
    expect(Invoices.createInvoiceFromBar).toHaveBeenCalledTimes(1);
    expect(Invoices.createInvoiceFromBar).toHaveBeenCalledWith({ body: card._body, approved: card._approved });
    expect(Invoices.createInvoiceFromServiceFromBar).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true, status: 'draft', invoice_id: INV, invoice_number: 'WPC-2099-0042', amount: '$126.00', due_date: '2099-02-01',
      customer_id: CUST, customer_name: 'Robin Sample', sent_to_customer: false,
    });
    expect(result.note).toMatch(/Nothing was sent and no card was charged\. To send it, use send_invoice/);
  });

  test('a visit invoice runs the visit route with the visit body', async () => {
    const card = await preview(visitInput());
    const result = await confirm(card, visitInput());
    expect(Invoices.createInvoiceFromServiceFromBar).toHaveBeenCalledWith({ body: { serviceRecordId: REC, amount: 120 }, approved: card._approved });
    expect(Invoices.createInvoiceFromBar).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, invoice_number: 'WPC-2099-0043', amount: '$120.00' });
  });

  test('a confirm without the card’s pin never creates', async () => {
    expect(await executeCreateInvoiceTool('create_invoice', { ...lineInput(), confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    expect(Invoices.createInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('drift in a line, the notes, the due date, the customer, the tax or the server total refuses as preview_changed', async () => {
    const card = await preview();
    const drifts = [
      [lineInput({ line_items: [{ ...LINES[0], unit_price: 86 }, LINES[1]] }), () => {}],
      [lineInput({ notes: 'extra' }), () => {}],
      [lineInput({ due_date: '2099-02-02' }), () => {}],
      [lineInput(), () => { state.customers[0].city = 'Elsewhere'; }],
      [lineInput(), () => { mockPreviewTotals.mockResolvedValue({ subtotal: 126, tax_rate: 0.07, tax_amount: 8.82, total: 134.82 }); }],
    ];
    for (const [input, change] of drifts) {
      state = freshState();
      db.mockImplementation(makeDb());
      mockPreviewTotals.mockImplementation(async ({ amount }) => ({ subtotal: amount, tax_rate: 0, tax_amount: 0, total: amount }));
      change();
      expect(await confirm(card, input)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    }
    expect(Invoices.createInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('a refusal that appears at confirm (a payer assigned since the card) is passed on and nothing is created', async () => {
    const card = await preview();
    mockResolvePayer.mockResolvedValue({ payerId: 'payer-1', taxExempt: false, snapshot: {}, paymentTerms: 'net30' });
    expect(await confirm(card)).toMatchObject({ code: 'needs_invoices_page', preview_changed: true });
    expect(Invoices.createInvoiceFromBar).not.toHaveBeenCalled();
  });

  test('the handler’s own refusals come back as a failure, a total mismatch as preview_changed', async () => {
    const card = await preview();
    Invoices.createInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'This estimate is billed by its saved visit closeout.', code: 'VISIT_PACKET_OWNS_BILLING' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'create_refused', error: expect.stringMatching(/not created: This estimate is billed/) });
    Invoices.createInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'The invoice total differs from the one the card showed, so nothing was created.', code: 'IB_TOTAL_MISMATCH' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
  });

  test('a visit-route 409 (a deposit would apply) is a known no-create; any other throw is an unknown outcome, never a retry', async () => {
    const card = await preview(visitInput());
    Invoices.createInvoiceFromServiceFromBar.mockRejectedValueOnce(Object.assign(new Error('An estimate deposit credit would apply to this invoice — bill it from Billing Recovery.'), { status: 409 }));
    expect(await confirm(card, visitInput())).toMatchObject({ failed: true, code: 'create_refused' });
    Invoices.createInvoiceFromServiceFromBar.mockRejectedValueOnce(new Error('database down'));
    const unknown = await confirm(card, visitInput());
    expect(unknown).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    expect(unknown.success).toBeUndefined();
  });

  test('an answer that does not read as a draft is an unknown outcome', async () => {
    const card = await preview();
    Invoices.createInvoiceFromBar.mockResolvedValueOnce({ status: 201, json: { id: INV, status: 'sent', total: '126.00' } });
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'create_unverified' });
  });
});

describe('recheckApprovedScope (inside the create transaction)', () => {
  const approvedOf = async (input = lineInput({ service_record_id: REC })) => (await preview(input))._approved;
  const recheck = (approved) => tools.recheckApprovedScope(db, approved);

  test('passes while nothing changed, taking the visit’s mint lock first', async () => {
    const approved = await approvedOf();
    expect(approved).toMatchObject({ scheduledServiceId: VISIT, serviceRecordId: REC, visitInvoices: [] });
    await expect(recheck(approved)).resolves.toBeUndefined();
    expect(mockMintLock).toHaveBeenCalledWith(db, VISIT);
    const unlinked = await approvedOf(lineInput());
    mockMintLock.mockClear();
    await expect(recheck(unlinked)).resolves.toBeUndefined();
    expect(mockMintLock).not.toHaveBeenCalled();
  });

  test('the customer and the payer rows are held FOR SHARE before the payer is read, so a payer activation waits for the commit', async () => {
    const approved = await approvedOf();
    state.customers[0].payer_id = 'payer-1';
    state.locks.length = 0;
    const order = [];
    mockResolvePayer.mockImplementation(async () => { order.push(`resolve after ${state.locks.join(',')}`); return { payerId: null }; });
    await recheck(approved);
    expect(state.locks).toEqual(['customers', 'payers']);
    expect(order).toEqual(['resolve after customers,payers']);
    // A visit payer override is held too.
    state.scheduled_services[0].payer_id = 'payer-2';
    state.payers.push({ id: 'payer-2' });
    state.locks.length = 0;
    await recheck(approved);
    expect(state.locks).toEqual(['customers', 'payers']);
  });

  test('a payer assigned after the card is a 409 IB_SCOPE_CHANGED', async () => {
    const approved = await approvedOf();
    mockResolvePayer.mockResolvedValue({ payerId: 'payer-1', taxExempt: false, snapshot: {}, paymentTerms: 'net30' });
    await expect(recheck(approved)).rejects.toMatchObject({ statusCode: 409, code: 'IB_SCOPE_CHANGED', isOperational: true, message: expect.stringMatching(/third-party payer.*changed after the card was shown/) });
    mockResolvePayer.mockRejectedValue(new Error('db down'));
    await expect(recheck(approved)).rejects.toMatchObject({ code: 'IB_SCOPE_CHANGED' });
  });

  test('an invoice linked to the visit only through its scheduled visit counts too, on the card and at the recheck', async () => {
    state.invoices.push({ id: INV, service_record_id: null, scheduled_service_id: VISIT, invoice_number: 'WPC-2099-0008', status: 'sent', total: '70.00' });
    const card = await preview(lineInput({ service_record_id: REC }));
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/WPC-2099-0008 \(sent, \$70\.00\) already bills this visit/);
    state.invoices.length = 0;
    const approved = await approvedOf();
    state.invoices.push({ id: INV, service_record_id: null, scheduled_service_id: VISIT, invoice_number: 'WPC-2099-0008', status: 'draft', total: '70.00' });
    await expect(recheck(approved)).rejects.toMatchObject({ code: 'IB_SCOPE_CHANGED' });
  });

  test('an invoice that committed on the visit while the create waited is a 409', async () => {
    const approved = await approvedOf();
    state.invoices.push({ id: INV, service_record_id: REC, invoice_number: 'WPC-2099-0009', status: 'draft', total: '60.00' });
    await expect(recheck(approved)).rejects.toMatchObject({ code: 'IB_SCOPE_CHANGED', message: expect.stringMatching(/invoice on this visit changed/) });
    // A card that already named that invoice still passes while it is unchanged.
    const named = await approvedOf();
    await expect(recheck(named)).resolves.toBeUndefined();
    state.invoices[0].status = 'sent';
    await expect(recheck(named)).rejects.toMatchObject({ code: 'IB_SCOPE_CHANGED' });
  });

  test('a changed or deleted customer, a moved visit link, or a granted retention offer is a 409', async () => {
    const approved = await approvedOf();
    state.customers[0].city = 'Elsewhere';
    await expect(recheck(approved)).rejects.toMatchObject({ code: 'IB_SCOPE_CHANGED' });
    state.customers[0].city = 'Sampleton';
    state.service_records[0].scheduled_service_id = OTHER;
    await expect(recheck(approved)).rejects.toMatchObject({ code: 'IB_SCOPE_CHANGED', message: expect.stringMatching(/visit changed/) });
    state.service_records[0].scheduled_service_id = VISIT;
    state.customers[0].deleted_at = new Date();
    await expect(recheck(approved)).rejects.toMatchObject({ code: 'IB_SCOPE_CHANGED' });
    state.customers[0].deleted_at = null;
    const visitApproved = await approvedOf(visitInput());
    state.retention_offers.push({ id: 'r1', customer_id: CUST, status: 'granted' });
    await expect(recheck(visitApproved)).rejects.toMatchObject({ code: 'IB_SCOPE_CHANGED', message: expect.stringMatching(/retention offer/) });
  });

  test('the confirmed run reports a scope 409 from the handler as preview_changed', async () => {
    const card = await preview();
    Invoices.createInvoiceFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'x', code: 'IB_SCOPE_CHANGED' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
  });
});
