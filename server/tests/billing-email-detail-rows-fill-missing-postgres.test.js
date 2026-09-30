// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20260930100100 follows the frozen 20260930090000: that one treated any
// {{property_full_address}} reference as "template done", so a template where
// staff had added only the Property row never got the plan's other rows. The
// follow-up adds only the rows still missing, and is a no-op wherever the first
// migration did the full job.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.setTimeout(90000);

const knex = require('knex');
const { randomUUID } = require('node:crypto');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_email_fill_missing_${randomUUID().replaceAll('-', '')}`;
const MARKERS = ['migration:20260930090000', 'migration:20260930100100'];
const MARKER = 'migration:20260930100100';
let admin;
let db;
let first;
let second;
let library;
let pre;

const PLANS = () => first._private.PLANS;
const KEYS = () => PLANS().map((p) => p.key);

const BASE = {
  first_name: 'Sam', invoice_url: 'https://example.test/pay', receipt_url: 'https://example.test/receipt',
  invoice_number: 'WPC-2026-0001', amount_due: '$10.00', amount_paid: '$10.00', paid_at: 'September 1, 2026',
  due_date: 'September 15, 2026', notification_body: 'Body text.', category_label: 'Payment receipt',
  billing_url: 'https://example.test/billing', service_label: 'Quarterly Pest Control',
};
const FULL = {
  ...BASE, property_full_address: '123 Example Street, Bradenton, FL 34205',
  service_date: 'September 29, 2026', payment_method: 'VISA ···· 4242',
};

async function clone(key, { blocks = null, text_body = null } = {}) {
  const { template, version } = pre[key];
  const templateId = randomUUID();
  const versionId = randomUUID();
  const { id: _i, active_version_id: _a, ...cols } = template;
  const NEW_VARS = new Set(PLANS().flatMap((p) => p.variables).filter((v) => v === 'property_full_address'));
  for (const c of ['allowed_variables', 'optional_variables', 'required_variables']) {
    cols[c] = JSON.stringify((cols[c] ?? []).filter((v) => !NEW_VARS.has(v)));
  }
  await db('email_templates').insert({ ...cols, id: templateId, active_version_id: null });
  await db('email_template_versions').insert({
    id: versionId, template_id: templateId, version_number: version.version_number, status: 'active',
    subject: version.subject, preview_text: version.preview_text,
    blocks: JSON.stringify(blocks || version.blocks), text_body, published_at: new Date(),
  });
  await db('email_templates').where({ id: templateId }).update({ active_version_id: versionId });
  return { templateId, versionId };
}

const active = async (key) => {
  const template = await db('email_templates').where({ template_key: key }).first();
  return { template, version: await db('email_template_versions').where({ id: template.active_version_id }).first() };
};
const rowsOf = (blocks) => blocks.filter((b) => b.type === 'details').flatMap((b) => b.rows.map((r) => `${r.label}=${r.value}`));

// The shipped content with ONLY the Property row added by staff (label "Where").
function propertyOnly(key) {
  const plan = PLANS().find((p) => p.key === key);
  const blocks = JSON.parse(JSON.stringify(pre[key].version.blocks));
  const row = { label: 'Where', value: '{{property_full_address}}' };
  if (plan.rowsInto) {
    const i = first._private.findDetailsBlock(blocks, plan.rowsInto.anchorValue);
    blocks[i].rows.push(row);
    return blocks;
  }
  blocks.splice(1, 0, { type: 'details', rows: [row] });
  return blocks;
}

postgres('billing email detail rows fill-missing migration (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    db = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures', 'audit_log']) {
      await db.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    await db.raw('ALTER TABLE email_template_versions ADD CONSTRAINT v_tpl_fk FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE CASCADE');
    first = require('../models/migrations/20260930090000_billing_email_detail_rows');
    second = require('../models/migrations/20260930100100_billing_email_detail_rows_fill_missing');
    library = jest.requireActual('../services/email-template-library');

    pre = {};
    for (const key of KEYS()) {
      const template = await admin('email_templates').where({ template_key: key }).first();
      if (!template) throw new Error(`Template ${key} is not in the migrated public schema`);
      let version = await admin('email_template_versions').where({ id: template.active_version_id }).first();
      while (MARKERS.includes(version.validation_snapshot?.source)) {
        version = await admin('email_template_versions').where({ template_id: template.id, version_number: version.validation_snapshot.supersedes_version }).first();
      }
      pre[key] = { template, version };
    }
  }, 60000);

  afterAll(async () => {
    await db?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  beforeEach(async () => {
    for (const t of ['email_template_fixtures', 'email_template_versions', 'email_templates', 'audit_log']) await db(t).del();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('where the first migration did the full job this is a no-op: no new versions, no audit event', async () => {
    for (const key of KEYS()) await clone(key);
    await first.up(db);
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await second.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
    expect(await db('audit_log').where({ action: `${MARKER}:publish` })).toHaveLength(0);
  });

  test('a template where staff added only the Property row gets the missing rows, next to it, and keeps the staff row', async () => {
    const key = 'billing.receipt_notice';
    await clone(key, { blocks: propertyOnly(key) });
    await first.up(db); // skips: it sees the property reference and calls the template done
    expect((await active(key)).version.version_number).toBe(pre[key].version.version_number);

    await second.up(db);
    const { template, version } = await active(key);
    expect(version.version_number).toBe(pre[key].version.version_number + 1);
    expect(rowsOf(version.blocks)).toEqual([
      'Where={{property_full_address}}',
      'Service={{service_label}}',
      'Service date={{service_date}}',
      'Payment method={{payment_method}}',
    ]);
    expect(version.validation_snapshot).toMatchObject({ ok: true, source: MARKER, supersedes_version: pre[key].version.version_number });
    expect(template.allowed_variables).toEqual(expect.arrayContaining(['service_date', 'payment_method', 'property_full_address']));
    expect(template.required_variables).toEqual(pre[key].template.required_variables);
    const versions = await db('email_template_versions').where({ template_id: template.id }).orderBy('version_number');
    expect(versions.map((v) => v.status)).toEqual(['archived', 'active']);
    expect(library.validationFor(template, version).ok).toBe(true);
    expect(await db('audit_log').where({ action: `${MARKER}:publish` })).toHaveLength(1);
    const out = library.renderTemplate({ template, version, payload: FULL });
    expect(out.text).toContain('Where: 123 Example Street, Bradenton, FL 34205\nService: Quarterly Pest Control\nService date: September 29, 2026\nPayment method: VISA ···· 4242');
  });

  test('invoice.sent and invoice.receipt with only Property added gain only what is missing', async () => {
    await clone('invoice.sent', { blocks: propertyOnly('invoice.sent') });
    await clone('invoice.receipt', { blocks: propertyOnly('invoice.receipt') });
    await second.up(db);
    const sent = rowsOf((await active('invoice.sent')).version.blocks);
    const receipt = rowsOf((await active('invoice.receipt')).version.blocks);
    expect(sent.filter((r) => r.includes('property_full_address'))).toEqual(['Where={{property_full_address}}']);
    expect(sent).toContain('Payment method on file={{payment_method}}');
    expect(receipt.filter((r) => r.includes('property_full_address'))).toEqual(['Where={{property_full_address}}']);
    expect(receipt).toContain('Service date={{service_date}}');
    expect(new Set(receipt).size).toBe(receipt.length);
  });

  test('a property-only estimate follow-up is already complete; an untouched one is completed exactly as the first migration would', async () => {
    const done = 'estimate.engage_high_intent';
    const fresh = 'estimate.engage_expiring';
    await clone(done, { blocks: propertyOnly(done) });
    await clone(fresh);
    await second.up(db);
    expect((await active(done)).version.version_number).toBe(pre[done].version.version_number);
    const { version } = await active(fresh);
    expect(rowsOf(version.blocks)).toEqual(['Property={{property_full_address}}']);
  });

  test('a row staff placed anywhere under a different label counts as present, whatever its label', async () => {
    const key = 'invoice.receipt';
    const blocks = propertyOnly(key);
    const i = first._private.findDetailsBlock(blocks, '{{invoice_number}}');
    blocks[i].rows.push({ label: 'Day of visit', value: '{{service_date}}' });
    await clone(key, { blocks });
    await second.up(db);
    expect((await active(key)).version.version_number).toBe(pre[key].version.version_number);
  });

  test('a version staff republished after the first migration is judged by its rows, not by the marker', async () => {
    const key = 'invoice.receipt';
    await clone(key);
    await first.up(db);
    const { template, version } = await active(key);
    // Staff republish: keep everything but drop the Service date row they did not want.
    const blocks = version.blocks.map((b) => (b.type === 'details' ? { ...b, rows: b.rows.filter((r) => r.value !== '{{service_date}}') } : b));
    const [staff] = await db('email_template_versions').insert({
      template_id: template.id, version_number: 90, status: 'active', subject: version.subject, blocks: JSON.stringify(blocks),
      validation_snapshot: JSON.stringify({ ok: true }), published_at: new Date(),
    }).returning('*');
    await db('email_template_versions').where({ id: version.id }).update({ status: 'archived' });
    await db('email_templates').where({ id: template.id }).update({ active_version_id: staff.id });
    await second.up(db);
    // The plan's row is missing, so it is added once; a second run adds nothing more.
    const after = await active(key);
    expect(rowsOf(after.version.blocks)).toContain('Service date={{service_date}}');
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await second.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('is idempotent', async () => {
    await clone('billing.notice', { blocks: propertyOnly('billing.notice') });
    await second.up(db);
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await second.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('gate off is byte-identical: with the new variables unfilled the result renders as the property-only template did', async () => {
    const key = 'billing.receipt_notice';
    const { templateId, versionId } = await clone(key, { blocks: propertyOnly(key) });
    const before = { template: await db('email_templates').where({ id: templateId }).first(), version: await db('email_template_versions').where({ id: versionId }).first() };
    await second.up(db);
    const now = await active(key);
    const payload = { ...BASE, service_label: '' };
    const a = library.renderTemplate({ ...before, payload });
    const b = library.renderTemplate({ ...now, payload });
    expect(b.html).toBe(a.html);
    expect(b.text).toBe(a.text);
  });

  test('a custom plain-text body, or a template with no block to attach to, is left whole and logged', async () => {
    const warn = console.warn;
    await clone('billing.notice', { blocks: propertyOnly('billing.notice'), text_body: 'Custom.' });
    await clone('invoice.sent', { blocks: [{ type: 'paragraph', content: 'Hi {{first_name}} {{property_full_address}}' }] });
    await second.up(db);
    expect((await active('billing.notice')).version.status).toBe('active');
    expect((await active('billing.notice')).version.version_number).toBe(pre['billing.notice'].version.version_number);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custom plain-text body present'));
    expect((await active('invoice.sent')).version.version_number).toBe(pre['invoice.sent'].version.version_number);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no block to attach'));
  });

  test('a skipped template is not touched at all (variables included)', async () => {
    const { templateId } = await clone('billing.notice', { blocks: propertyOnly('billing.notice'), text_body: 'Custom.' });
    const before = await db('email_templates').where({ id: templateId }).first();
    await second.up(db);
    const after = await db('email_templates').where({ id: templateId }).first();
    expect(after.allowed_variables).toEqual(before.allowed_variables);
    expect(after.active_version_id).toBe(before.active_version_id);
  });

  test('compare-and-swap: an admin republish landing mid-migration wins; this migration archives its own version', async () => {
    const key = 'billing.notice';
    const { templateId, versionId } = await clone(key, { blocks: propertyOnly(key) });
    let adminVersionId;
    const racing = {
      schema: db.schema,
      transaction: (callback) => db.transaction((trx) => {
        const realNested = trx.transaction.bind(trx);
        Object.defineProperty(trx, 'transaction', { configurable: true, writable: true, value: async (nested) => {
          const out = await realNested(nested);
          if (adminVersionId) return out;
          const [row] = await trx('email_template_versions').insert({
            template_id: templateId, version_number: 99, status: 'active', subject: 'Admin republish',
            blocks: JSON.stringify([{ type: 'paragraph', content: 'Hi {{first_name}}, admin copy.' }]),
          }).returning('*');
          adminVersionId = row.id;
          await trx('email_template_versions').where({ id: versionId }).update({ status: 'archived' });
          await trx('email_templates').where({ id: templateId }).update({ active_version_id: row.id });
          return out;
        } });
        return callback(trx);
      }),
    };
    await second.up(racing);
    expect((await db('email_templates').where({ id: templateId }).first()).active_version_id).toBe(adminVersionId);
    const versions = await db('email_template_versions').where({ template_id: templateId });
    expect(versions.filter((v) => v.status === 'active').map((v) => v.id)).toEqual([adminVersionId]);
    expect(versions.find((v) => v.validation_snapshot?.source === MARKER)).toMatchObject({ status: 'archived' });
  });

  test('down is a documented no-op', async () => {
    await clone('billing.notice', { blocks: propertyOnly('billing.notice') });
    await second.up(db);
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await second.down(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
  });
});
