// The customer-dunning SMS render reads the template (and its variants) through the handle the run was given,
// never the process-wide pool: the probe (Render.channelsWithTemplates) and the render must see the same snapshot.
// Real admin-sms-templates + sms-template-variants; the default pool is poisoned.
jest.mock('../models/db', () => {
  const pool = jest.fn(() => { throw new Error('the default pool was used'); });
  pool.schema = { hasTable: jest.fn(() => { throw new Error('the default pool was used'); }) };
  pool.raw = jest.fn(() => { throw new Error('the default pool was used'); });
  return pool;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.test' }));

const Render = require('../services/customer-dunning/render');
const config = require('../config/invoice-followups');

const step = config.stepsThrough90[4];
const set = {
  kind: 'multi', anchor: { id: 'inv-a', title: 't', service_date: '2026-08-01', due_date: '2026-08-15' },
  members: [{ cents: 10000 }, { cents: 10000 }], totalCents: 20000,
};
const customer = { id: 'cust-1', first_name: 'Pat' };

// A handle serving the template row and (optionally) variants; records every table it is asked for.
function handleWith({ variants = [] } = {}) {
  const tables = [];
  const handle = jest.fn((table) => {
    tables.push(table);
    const q = {};
    q.where = () => q;
    q.orderBy = async () => variants;
    q.first = async () => (table === 'sms_templates'
      ? { template_key: 'invoice_followup_combined_60day', body: 'Waves: {invoice_count} open invoices, ${total_due} due. {pay_url}', is_active: true }
      : undefined);
    return q;
  });
  handle.schema = { hasTable: jest.fn(async () => true) };
  handle.tables = tables;
  return handle;
}

describe('SMS render reads on the injected handle', () => {
  test('template row and variant lookup both use the handle; the poisoned pool is never touched', async () => {
    const database = handleWith();
    const body = await Render.renderSms({ step, set, customer, payUrl: 'https://s.example.test/x', database });
    expect(body).toContain('2 open invoices');
    expect(database.schema.hasTable).toHaveBeenCalledWith('sms_templates');
    expect(database.tables).toEqual(expect.arrayContaining(['sms_templates', 'sms_template_variants']));
  });

  test('a variant read from the handle is the one rendered (probe and render see one snapshot)', async () => {
    const database = handleWith({ variants: [{ body: 'Variant: {invoice_count} invoices {pay_url}', weight: 1, status: 'active' }] });
    const body = await Render.renderSms({ step, set, customer, payUrl: 'https://s.example.test/x', database });
    expect(body).toContain('Variant: 2 invoices');
  });

  test('without a handle (every other caller) the default pool is used, as before', async () => {
    await expect(Render.renderSms({ step, set, customer, payUrl: 'x' })).resolves.toBeNull(); // pool poisoned => the render error path returns null
  });
});
