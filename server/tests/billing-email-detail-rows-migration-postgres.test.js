// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20260930090000 publishes ONE new active version of thirteen live templates
// (GATE_BILLING_EMAIL_DETAILS rows). The pre-migration content of each is the
// real shipped content, read from the migrated `public` schema (the version
// this migration superseded when it has already run there), so the test proves
// the migration against what production actually holds - and proves the gate-off
// promise: rendered with a payload that has none of the new variables, every
// template's html and text are byte-identical before and after.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_email_detail_rows_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20260930090000';
let admin;
let db;
let migration;
let library;
let pre; // template_key -> { template, version } as shipped before this migration

const KEYS = () => migration._private.PLANS.map((p) => p.key);

// A payload with every variable the thirteen templates use EXCEPT the new ones.
const BASE_PAYLOAD = {
  first_name: 'Sam', invoice_url: 'https://example.test/pay', receipt_url: 'https://example.test/receipt',
  invoice_number: 'WPC-2026-0001', amount_due: '$10.00', amount_paid: '$10.00', paid_at: 'September 1, 2026',
  due_date: 'September 15, 2026', estimate_url: 'https://example.test/estimate', estimate_accept_url: 'https://example.test/accept',
  notification_body: 'Body text.', category_label: 'Payment receipt', billing_url: 'https://example.test/billing',
  expires_date: 'October 1, 2026', deposit_amount: '50.00', company_phone: '(941) 555-0100',
  service_label: 'Quarterly Pest Control', service_date: '', payment_method: '',
};
const NEW_PAYLOAD = {
  ...BASE_PAYLOAD,
  property_full_address: '123 Example Street, Bradenton, FL 34205',
  service_date: 'September 29, 2026',
  payment_method: 'VISA ···· 4242',
};

async function cloneTemplate(key, { text_body = null, blocksOf = null, activeStatus = 'active' } = {}) {
  const { template, version } = pre[key];
  const templateId = randomUUID();
  const versionId = randomUUID();
  const { id: _i, active_version_id: _a, ...templateCols } = template;
  // The public schema has usually run this migration already; the clone must look
  // like the template BEFORE it (the new variables were not yet allowed).
  const NEW_VARS = new Set(migration._private.PLANS.flatMap((p) => p.variables).filter((v) => v === 'property_full_address'));
  for (const col of ['allowed_variables', 'optional_variables', 'required_variables']) {
    templateCols[col] = JSON.stringify((templateCols[col] ?? []).filter((v) => !NEW_VARS.has(v)));
  }
  await db('email_templates').insert({ ...templateCols, id: templateId, active_version_id: null });
  await db('email_template_versions').insert({
    id: versionId, template_id: templateId, version_number: version.version_number, status: activeStatus,
    subject: version.subject, preview_text: version.preview_text,
    blocks: JSON.stringify(blocksOf || version.blocks), text_body, published_at: new Date(),
  });
  await db('email_templates').where({ id: templateId }).update({ active_version_id: versionId });
  return { templateId, versionId };
}

const activeOf = async (key) => {
  const template = await db('email_templates').where({ template_key: key }).first();
  const version = await db('email_template_versions').where({ id: template.active_version_id }).first();
  return { template, version };
};

async function clearSchema() {
  await db('email_template_fixtures').del();
  await db('email_template_versions').del();
  await db('email_templates').del();
  await db('audit_log').del();
}

postgres('billing email detail rows migration (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    db = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures', 'audit_log']) {
      await db.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    await db.raw('ALTER TABLE email_template_versions ADD CONSTRAINT v_tpl_fk FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE CASCADE');

    migration = require('../models/migrations/20260930090000_billing_email_detail_rows');
    library = jest.requireActual('../services/email-template-library');

    // What each template looked like BEFORE this migration, from the real data.
    pre = {};
    for (const key of KEYS()) {
      const template = await admin('email_templates').where({ template_key: key }).first();
      if (!template) throw new Error(`Template ${key} is not in the migrated public schema`);
      let version = await admin('email_template_versions').where({ id: template.active_version_id }).first();
      const supersedes = version.validation_snapshot?.source === MARKER ? version.validation_snapshot.supersedes_version : null;
      if (supersedes != null) {
        version = await admin('email_template_versions').where({ template_id: template.id, version_number: supersedes }).first();
      }
      pre[key] = { template, version };
    }
  }, 60000);

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  beforeEach(async () => { await clearSchema(); jest.clearAllMocks(); });

  test('the real migrated database carries the published versions, one per template, replacing only the shipped one', async () => {
    for (const key of KEYS()) {
      const template = await admin('email_templates').where({ template_key: key }).first();
      const versions = await admin('email_template_versions').where({ template_id: template.id }).orderBy('version_number');
      const active = versions.filter((v) => v.status === 'active');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(template.active_version_id);
      expect(JSON.stringify(active[0].blocks)).toContain('{{property_full_address}}');
      expect(active[0].validation_snapshot).toMatchObject({ ok: true, source: MARKER });
    }
  });

  test('publishes one new active version per template: compare-and-swap on the active version, only the replaced one archived', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);

    for (const key of KEYS()) {
      const { template, version } = await activeOf(key);
      const versions = await db('email_template_versions').where({ template_id: template.id }).orderBy('version_number');
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({ version_number: pre[key].version.version_number, status: 'archived' });
      expect(versions[1]).toMatchObject({ id: version.id, version_number: pre[key].version.version_number + 1, status: 'active' });
      expect(template.active_version_id).toBe(version.id);
      expect(version.subject).toBe(pre[key].version.subject);
      expect(version.text_body).toBeNull();
      expect(version.validation_snapshot).toMatchObject({ ok: true, source: MARKER, supersedes_version: pre[key].version.version_number });
      expect(library.validationFor(template, version).ok).toBe(true);
      // New variables are allowed and optional; required stays as it was.
      expect(template.allowed_variables).toContain('property_full_address');
      expect(template.optional_variables).toContain('property_full_address');
      expect(template.required_variables).toEqual(pre[key].template.required_variables);
      expect(template.required_variables).not.toContain('property_full_address');
    }
    expect(await db('audit_log').where({ action: `${MARKER}:publish` })).toHaveLength(1);
  });

  test('every template gains exactly the intended rows and loses nothing', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    const rowsOf = (blocks) => blocks.filter((b) => b.type === 'details').flatMap((b) => b.rows.map((r) => `${r.label}=${r.value}`));

    for (const key of KEYS()) {
      const before = rowsOf(pre[key].version.blocks);
      const after = rowsOf((await activeOf(key)).version.blocks);
      const added = after.filter((r) => !before.includes(r));
      expect(before.filter((r) => !after.includes(r))).toEqual([]);
      const expected = {
        'invoice.sent': ['Property={{property_full_address}}', 'Payment method on file={{payment_method}}'],
        'invoice.receipt': ['Service date={{service_date}}', 'Property={{property_full_address}}'],
        'billing.notice': ['Property={{property_full_address}}', 'Service={{service_label}}', 'Service date={{service_date}}'],
        'billing.receipt_notice': ['Property={{property_full_address}}', 'Service={{service_label}}', 'Service date={{service_date}}', 'Payment method={{payment_method}}'],
      }[key] || ['Property={{property_full_address}}'];
      expect(added.sort()).toEqual(expected.sort());
      // Non-details blocks are untouched, in order.
      const nonDetails = (blocks) => JSON.stringify(blocks.filter((b) => b.type !== 'details'));
      expect(nonDetails((await activeOf(key)).version.blocks)).toBe(nonDetails(pre[key].version.blocks));
    }
  });

  test('gate off is byte-identical: with none of the new variables filled, every template renders exactly as before', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    for (const key of KEYS()) {
      const { template, version } = await activeOf(key);
      // Without a value for the new rows every payload renders as the shipped version did.
      const payload = { ...BASE_PAYLOAD, service_date: '', payment_method: '', service_label: key === 'billing.notice' || key === 'billing.receipt_notice' ? '' : BASE_PAYLOAD.service_label };
      const before = library.renderTemplate({ template: pre[key].template, version: pre[key].version, payload });
      const after = library.renderTemplate({ template, version, payload });
      expect(after.html).toBe(before.html);
      expect(after.text).toBe(before.text);
      expect(after.subject).toBe(before.subject);
    }
  });

  test('gate on: the new rows render, and the Property row carries the full street address', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    for (const key of KEYS()) {
      const { template, version } = await activeOf(key);
      const out = library.renderTemplate({ template, version, payload: NEW_PAYLOAD });
      expect(out.text).toContain('Property: 123 Example Street, Bradenton, FL 34205');
      expect(out.html).toContain('123 Example Street, Bradenton, FL 34205');
    }
    const receipt = library.renderTemplate({ ...(await activeOf('invoice.receipt')), payload: NEW_PAYLOAD });
    expect(receipt.text).toMatch(/Service date: September 29, 2026\nProperty: 123 Example Street, Bradenton, FL 34205\nPayment method: VISA ···· 4242/);
    const sent = library.renderTemplate({ ...(await activeOf('invoice.sent')), payload: NEW_PAYLOAD });
    expect(sent.text).toContain('Payment method on file: VISA ···· 4242');
    expect(sent.text).toContain('Service date: September 29, 2026');
  });

  test('is idempotent: a second run publishes nothing new', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await migration.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('read-modify-write: an admin edit made before the migration survives it', async () => {
    const key = 'invoice.sent';
    const edited = [...pre[key].version.blocks, { type: 'small_note', content: 'Admin-added closing line.' }];
    await cloneTemplate(key, { blocksOf: edited });
    await migration.up(db);
    const { version } = await activeOf(key);
    expect(version.blocks.at(-1)).toEqual({ type: 'small_note', content: 'Admin-added closing line.' });
    expect(JSON.stringify(version.blocks)).toContain('{{property_full_address}}');
  });

  test('a custom plain-text body is left whole and logged, never half-patched', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await cloneTemplate('invoice.receipt', { text_body: 'Custom text body.' });
    await migration.up(db);
    const { template, version } = await activeOf('invoice.receipt');
    expect(version.version_number).toBe(pre['invoice.receipt'].version.version_number);
    expect(version.status).toBe('active');
    expect(JSON.stringify(version.blocks)).not.toContain('property_full_address');
    expect(template.allowed_variables).not.toContain('property_full_address');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custom plain-text body present'));
    warn.mockRestore();
  });

  test('a template reshaped so the anchor is gone is skipped with a log; the rest still publish', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await cloneTemplate('invoice.sent', { blocksOf: [{ type: 'paragraph', content: 'Hi {{first_name}}, only this.' }] });
    await cloneTemplate('invoice.receipt');
    await migration.up(db);
    expect(JSON.stringify((await activeOf('invoice.sent')).version.blocks)).not.toContain('property_full_address');
    expect(JSON.stringify((await activeOf('invoice.receipt')).version.blocks)).toContain('property_full_address');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected block not found'));
    warn.mockRestore();
  });

  test('templates that are missing, or have no active version, are tolerated', async () => {
    const { templateId } = await cloneTemplate('invoice.sent');
    await db('email_templates').where({ id: templateId }).update({ active_version_id: null });
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db('email_template_versions').where({ template_id: templateId })).toHaveLength(1);
  });

  test('preview fixtures gain sample values; an existing value is never overwritten', async () => {
    const { templateId } = await cloneTemplate('invoice.receipt');
    await db('email_template_fixtures').insert({
      template_id: templateId, name: 'Default', is_default: true,
      payload: JSON.stringify({ first_name: 'Sam', payment_method: 'Admin-edited method' }), updated_at: new Date(),
    });
    await migration.up(db);
    const fixture = await db('email_template_fixtures').where({ template_id: templateId }).first();
    expect(fixture.payload).toMatchObject({
      first_name: 'Sam',
      payment_method: 'Admin-edited method',
      property_full_address: '123 Example Street, Bradenton, FL 34205',
      service_date: 'September 29, 2026',
    });
  });

  test('a draft the admin editor already numbered does not collide: the published number is max + 1 and the draft is untouched', async () => {
    const { templateId } = await cloneTemplate('invoice.sent');
    const draftNumber = pre['invoice.sent'].version.version_number + 1;
    await db('email_template_versions').insert({
      template_id: templateId, version_number: draftNumber, status: 'draft', subject: 'Draft', blocks: JSON.stringify([]),
    });
    await migration.up(db);
    const template = await db('email_templates').where({ id: templateId }).first();
    const active = await db('email_template_versions').where({ id: template.active_version_id }).first();
    expect(active.version_number).toBe(draftNumber + 1);
    expect(await db('email_template_versions').where({ template_id: templateId, version_number: draftNumber }).first())
      .toMatchObject({ status: 'draft', subject: 'Draft' });
  });

  test('compare-and-swap: an admin republish that lands mid-migration wins; the migration archives its own version and touches nothing else', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { templateId, versionId } = await cloneTemplate('invoice.sent');
    let adminVersionId;
    const racing = {
      schema: db.schema,
      transaction: (callback) => db.transaction((trx) => {
        const realNested = trx.transaction.bind(trx);
        // After the migration's own version insert commits and BEFORE it swaps
        // the pointer, the admin publishes a version of their own.
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
    await migration.up(racing);
    const template = await db('email_templates').where({ id: templateId }).first();
    expect(template.active_version_id).toBe(adminVersionId);
    const versions = await db('email_template_versions').where({ template_id: templateId }).orderBy('version_number');
    expect(versions.filter((v) => v.status === 'active').map((v) => v.id)).toEqual([adminVersionId]);
    expect(versions.find((v) => v.validation_snapshot?.source === MARKER)).toMatchObject({ status: 'archived' });
    log.mockRestore();
  });

  test('down is a documented no-op that keeps operator edits', async () => {
    await cloneTemplate('invoice.sent');
    await migration.up(db);
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await db('email_templates').where({ template_key: 'invoice.sent' }).update({ name: 'Operator invoice email' });
    await migration.down(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
    expect(await db('email_templates').where({ template_key: 'invoice.sent' }).first()).toMatchObject({ name: 'Operator invoice email' });
  });
});
