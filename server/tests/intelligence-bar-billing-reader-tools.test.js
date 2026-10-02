/**
 * W9 billing readers — definitions, registration and request guards. No
 * database: the evidence rules (balances, attempts vs received, isolation)
 * are proven against Postgres in intelligence-bar-billing-reader-db.test.js.
 */
process.env.JWT_SECRET = 'synthetic-ib-test';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { BILLING_READER_TOOLS, executeBillingReaderTool } = require('../services/intelligence-bar/billing-reader-tools');

const NAMES = ['get_customer_invoices', 'get_invoice_detail'];
const CUSTOMER = '10000000-0000-4000-8000-0000000000aa';
const INVOICE = '10000000-0000-4000-8000-0000000000bb';

describe('billing reader definitions', () => {
  test('exactly the two read tools, with selector and pagination inputs', () => {
    expect(BILLING_READER_TOOLS.map((tool) => tool.name)).toEqual(NAMES);
    const list = BILLING_READER_TOOLS[0].input_schema.properties;
    expect(Object.keys(list)).toEqual(expect.arrayContaining(['customer_id', 'customer_name', 'limit', 'offset']));
    // No phone selector: an unscoped phone cannot be bound to a billing read by the current-request grammar.
    expect(Object.keys(list)).not.toContain('phone');
    expect(list.customer_id.format).toBe('uuid');
    const detail = BILLING_READER_TOOLS[1].input_schema;
    expect(detail.required).toEqual(['invoice_id']);
    expect(detail.properties.invoice_id.format).toBe('uuid');
  });

  test('descriptions tell the model: read only, balance only when collectible, otherwise the Invoices page with the reason', () => {
    for (const tool of BILLING_READER_TOOLS) {
      expect(tool.description).toMatch(/Read only/);
      expect(tool.description).toMatch(/ONLY when the invoice passes the payment paths' own collectibility checks \(collectible: true\)/);
      expect(tool.description).toMatch(/balance_due is null with the reason/);
      expect(tool.description).toMatch(/send staff to the Invoices page/);
      expect(tool.description).toMatch(/never suggest collecting or retrying a charge/);
      expect(tool.description).toMatch(/informational rows, not a verdict on receipt/);
      expect(tool.description).toMatch(/Admin-only/);
      expect(tool.description).toMatch(/never changes anything/);
    }
    expect(BILLING_READER_TOOLS[0].description).toMatch(/total_due adds up ONLY the invoices that are collectible/);
    expect(BILLING_READER_TOOLS[1].description).toMatch(/needs reconciliation — check the Invoices page/);
  });

  test('no underscore metadata, no model-facing confirmed field', () => {
    for (const tool of BILLING_READER_TOOLS) {
      expect(Object.keys(tool).filter((key) => key.startsWith('_'))).toEqual([]);
      expect(Object.keys(tool.input_schema.properties)).not.toContain('confirmed');
    }
  });
});

describe('billing readers are reads, admin-only, record-scoped', () => {
  test('registered as admin reads with a record scope and no approval', () => {
    for (const name of NAMES) {
      expect(registry.actions.get(name)).toMatchObject({ kind: 'read', role: 'admin', approval: null, scope: 'record', module: 'billing-reader-tools.js' });
    }
  });

  test('in no write-gate set', () => {
    const sets = [gates.WRITE_TWO_STEP_TOOL_NAMES, gates.LEGACY_BARE_WRITE_TOOL_NAMES, gates.CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES,
      gates.UI_GATED_WRITE_TOOL_NAMES, gates.OUTSIDE_WRITE_TOOL_NAMES, gates.FULL_ACCESS_TWO_STEP_TOOL_NAMES];
    for (const name of NAMES) for (const set of sets) expect(set.has(name)).toBe(false);
  });

  test('a technician gets neither tool, in a list or by forced call', async () => {
    for (const context of ['tech', 'customers', 'platform']) {
      expect(registry.initialTools(context, { role: 'technician' }).map((tool) => tool.name)).not.toEqual(expect.arrayContaining(NAMES));
    }
    for (const name of NAMES) {
      expect(registry.allowed(registry.actions.get(name), { role: 'technician', context: 'tech' })).toBe(false);
      expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'tech' })).toBe(false);
      expect(await registry.execute(name, { invoice_id: INVOICE }, { role: 'technician', context: 'tech', techContext: { techId: 'tech-1' } }))
        .toMatchObject({ code: 'permission_denied' });
    }
  });

  test('an admin has them in the customers context and through discovery', () => {
    const offered = registry.initialTools('customers', { role: 'admin' }).map((tool) => tool.name);
    for (const name of NAMES) expect(offered).toContain(name);
    const found = registry.discover({ query: 'what does this customer owe invoice payment' }, { role: 'admin', context: 'platform' });
    expect(found.definitions.map((tool) => tool.name)).toEqual(expect.arrayContaining(NAMES));
  });

  test('schema validation rejects extra, malformed and missing inputs', () => {
    const admin = { role: 'admin', context: 'platform' };
    expect(registry.validateInput('get_invoice_detail', { invoice_id: INVOICE }, admin)).toBeNull();
    expect(registry.validateInput('get_invoice_detail', {}, admin)).toMatchObject({ code: 'invalid_input' });
    expect(registry.validateInput('get_invoice_detail', { invoice_id: 'not-a-uuid' }, admin)).toMatchObject({ code: 'invalid_input' });
    expect(registry.validateInput('get_invoice_detail', { invoice_id: INVOICE, charge: true }, admin)).toMatchObject({ code: 'invalid_input' });
    expect(registry.validateInput('get_customer_invoices', { customer_id: CUSTOMER, limit: 10, offset: 0, status: 'overdue' }, admin)).toBeNull();
    expect(registry.validateInput('get_customer_invoices', { customer_id: CUSTOMER, status: 'refund_it' }, admin)).toMatchObject({ code: 'invalid_input' });
    expect(registry.validateInput('get_customer_invoices', { customer_id: CUSTOMER, confirmed: true }, admin)).toMatchObject({ code: 'invalid_input' });
  });
});

describe('executor guards (no database reached)', () => {
  test('a non-admin actor is refused before anything is read', async () => {
    expect(await executeBillingReaderTool('get_customer_invoices', { customer_id: CUSTOMER }, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(await executeBillingReaderTool('get_invoice_detail', { invoice_id: INVOICE }, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
  });

  test('a customer read needs a selector and a well-formed id', async () => {
    expect(await executeBillingReaderTool('get_customer_invoices', {}, {})).toMatchObject({ code: 'selector_required' });
    expect(await executeBillingReaderTool('get_customer_invoices', { customer_id: 'nope' }, {})).toMatchObject({ code: 'invalid_target' });
  });

  test('an invoice read needs a well-formed invoice id and customer id', async () => {
    expect(await executeBillingReaderTool('get_invoice_detail', {}, {})).toMatchObject({ code: 'invalid_target' });
    expect(await executeBillingReaderTool('get_invoice_detail', { invoice_id: 'nope' }, {})).toMatchObject({ code: 'invalid_target' });
    expect(await executeBillingReaderTool('get_invoice_detail', { invoice_id: INVOICE, customer_id: 'nope' }, {})).toMatchObject({ code: 'invalid_target' });
  });

  test('an unknown tool name is an error, not a read', async () => {
    expect(await executeBillingReaderTool('refund_invoice', { invoice_id: INVOICE }, {})).toMatchObject({ error: expect.stringContaining('Unknown tool') });
  });
});
