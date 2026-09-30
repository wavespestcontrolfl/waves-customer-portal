// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20260930120000 follows the frozen 20260930090000 / 20260930100100. The first
// treated a {{property_full_address}} reference as the only sign a template was
// done, so a template where staff had added (say) only {{payment_method}} was
// given the FULL plan and published with that row twice. The follow-up removes
// the plan's duplicate row from a version the first migration published and
// nobody has republished, keeps the staff row, and leaves everything else.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.setTimeout(90000);

const knex = require('knex');
const { randomUUID } = require('node:crypto');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_email_dedupe_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20260930120000';
let MARKERS;
let admin;
let db;
let first;
let second;
let fillMissing;
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

// The shipped content where staff had already added ONE plan variable (label
// "Card"/"When"), but not the Property row.
function staffRow(key, value, label) {
  const plan = PLANS().find((p) => p.key === key);
  const blocks = JSON.parse(JSON.stringify(pre[key].version.blocks));
  const row = { label, value };
  if (plan.rowsInto) {
    const i = first._private.findDetailsBlock(blocks, plan.rowsInto.anchorValue);
    blocks[i].rows.push(row);
    return blocks;
  }
  blocks.splice(1, 0, { type: 'details', rows: [row] });
  return blocks;
}

// Publishes the duplicate exactly as the first migration did.
async function withDuplicate(key, value, label) {
  const ids = await clone(key, { blocks: staffRow(key, value, label) });
  await first.up(db);
  return ids;
}

const countOf = (blocks, value) => rowsOf(blocks).filter((r) => r.endsWith(`=${value}`)).length;

postgres('billing email detail rows dedupe migration (PostgreSQL)', () => {
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
    fillMissing = require('../models/migrations/20260930100100_billing_email_detail_rows_fill_missing');
    second = require('../models/migrations/20260930120000_billing_email_detail_rows_dedupe');
    library = jest.requireActual('../services/email-template-library');
    MARKERS = [second._private.FIRST_MARKER, MARKER, 'migration:20260930100100'];

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

  test('where the first migration did the full job (no duplicates) this is a no-op: no new versions, no audit event', async () => {
    for (const key of KEYS()) await clone(key);
    await first.up(db);
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await second.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
    expect(await db('audit_log').where({ action: `${MARKER}:publish` })).toHaveLength(0);
  });

  test('a staff Payment method row that got the plan\'s row added again is left with ONE row, the staff one', async () => {
    const key = 'billing.receipt_notice';
    await withDuplicate(key, '{{payment_method}}', 'Card');
    const dup = await active(key);
    expect(countOf(dup.version.blocks, '{{payment_method}}')).toBe(2); // the defect the first migration left

    await second.up(db);
    const { template, version } = await active(key);
    expect(countOf(version.blocks, '{{payment_method}}')).toBe(1);
    expect(rowsOf(version.blocks)).toEqual([
      'Card={{payment_method}}',
      'Property={{property_full_address}}',
      'Service={{service_label}}',
      'Service date={{service_date}}',
    ]);
    expect(version.version_number).toBe(dup.version.version_number + 1);
    expect(version.validation_snapshot).toMatchObject({ ok: true, source: MARKER, supersedes_version: dup.version.version_number });
    const versions = await db('email_template_versions').where({ template_id: template.id }).orderBy('version_number');
    // staff-shaped original, the first migration's duplicate version, this one
    expect(versions.map((v) => v.status)).toEqual(['archived', 'archived', 'active']);
    expect(library.validationFor(template, version).ok).toBe(true);
    expect(await db('audit_log').where({ action: `${MARKER}:publish` })).toHaveLength(1);
    const out = library.renderTemplate({ template, version, payload: FULL });
    expect((out.text.match(/VISA/g) || [])).toHaveLength(1);
  });

  test('invoice.sent with a staff Payment method row under another label: one payment row, plan\'s Property row kept', async () => {
    const key = 'invoice.sent';
    await withDuplicate(key, '{{payment_method}}', 'Card on file');
    await second.up(db);
    const { version } = await active(key);
    expect(countOf(version.blocks, '{{payment_method}}')).toBe(1);
    expect(rowsOf(version.blocks)).toContain('Card on file={{payment_method}}');
    expect(countOf(version.blocks, '{{property_full_address}}')).toBe(1);
  });

  test('a staff Service date row in another block of billing.notice: the plan\'s Service date row goes, the rest of the block stays', async () => {
    const key = 'billing.notice';
    await withDuplicate(key, '{{service_date}}', 'When');
    await second.up(db);
    const { version } = await active(key);
    expect(countOf(version.blocks, '{{service_date}}')).toBe(1);
    expect(rowsOf(version.blocks)).toEqual(expect.arrayContaining(['When={{service_date}}', 'Property={{property_full_address}}', 'Service={{service_label}}']));
  });

  test('a details block the removal empties is dropped with its rows', () => {
    const plan = PLANS().find((p) => p.key === 'estimate.engage_high_intent');
    const blocks = [
      { type: 'paragraph', content: 'Hi' },
      { type: 'details', rows: [{ label: 'Property', value: '{{property_full_address}}' }] },
      { type: 'details', rows: [{ label: 'Where', value: '{{property_full_address}}' }] },
    ];
    const out = second._private.dedupeBlocks(blocks, plan);
    expect(out.removed).toBe(1);
    expect(out.blocks).toEqual([blocks[0], blocks[2]]);
  });

  test('a version staff republished after the first migration is never touched, duplicates or not', async () => {
    const key = 'billing.receipt_notice';
    await withDuplicate(key, '{{payment_method}}', 'Card');
    const { template, version } = await active(key);
    const [staff] = await db('email_template_versions').insert({
      template_id: template.id, version_number: 90, status: 'active', subject: version.subject, blocks: JSON.stringify(version.blocks),
      validation_snapshot: JSON.stringify({ ok: true }), published_at: new Date(),
    }).returning('*');
    await db('email_template_versions').where({ id: version.id }).update({ status: 'archived' });
    await db('email_templates').where({ id: template.id }).update({ active_version_id: staff.id });
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await second.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
    expect((await active(key)).version.id).toBe(staff.id);
  });

  test('is idempotent', async () => {
    await withDuplicate('billing.receipt_notice', '{{payment_method}}', 'Card');
    await second.up(db);
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await second.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
    // The follow-up that fills missing rows also has nothing to add afterwards.
    await fillMissing.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('gate off is byte-identical: with the new variables unfilled the result renders as the duplicated template did', async () => {
    const key = 'billing.receipt_notice';
    await withDuplicate(key, '{{payment_method}}', 'Card');
    const before = await active(key);
    await second.up(db);
    const now = await active(key);
    const payload = { ...BASE, service_label: '' };
    const a = library.renderTemplate({ ...before, payload });
    const b = library.renderTemplate({ ...now, payload });
    expect(b.html).toBe(a.html);
    expect(b.text).toBe(a.text);
  });

  test('a custom plain-text body leaves the template whole and logged', async () => {
    const key = 'billing.receipt_notice';
    const { templateId, versionId } = await withDuplicate(key, '{{payment_method}}', 'Card');
    const dup = await active(key);
    await db('email_template_versions').where({ id: dup.version.id }).update({ text_body: 'Custom.' });
    await second.up(db);
    expect((await active(key)).version.id).toBe(dup.version.id);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('custom plain-text body present'));
    expect(templateId).toBeTruthy();
    expect(versionId).toBeTruthy();
  });

  test('compare-and-swap: an admin republish landing mid-migration wins; this migration archives its own version', async () => {
    const key = 'billing.receipt_notice';
    const { templateId } = await withDuplicate(key, '{{payment_method}}', 'Card');
    const dup = await active(key);
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
          await trx('email_template_versions').where({ id: dup.version.id }).update({ status: 'archived' });
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
    await withDuplicate('billing.receipt_notice', '{{payment_method}}', 'Card');
    await second.up(db);
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await second.down(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
  });
});
