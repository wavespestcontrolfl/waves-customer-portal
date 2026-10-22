// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20261019200000 publishes ONE new active version of fourteen live estimate
// email templates (GATE_ESTIMATE_EMAIL_PDF note line). The pre-migration
// content of each is the real shipped content, read from the migrated `public`
// schema (the version this migration superseded when it has already run
// there), so the test proves the migration against what production holds - and
// proves the gate-off promise: rendered with a payload that has no
// estimate_pdf_note, every template's html and text are byte-identical before
// and after.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `estimate_email_pdf_note_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20261019200000';
const NOTE = "Can't open the link? A PDF copy of this estimate is attached.";
let admin;
let db;
let migration;
let library;
let pre; // template_key -> { template, version } as shipped before this migration

const KEYS = () => migration._private.PLANS.map((p) => p.key);

const BASE_PAYLOAD = {
  first_name: 'Sam', estimate_url: 'https://example.test/estimate', estimate_accept_url: 'https://example.test/accept',
  price_summary: '$99/mo', service_summary: 'Pest control', property_address: '123 Example Street',
  next_step_summary: 'Open the estimate.', expires_date: 'October 30, 2026', new_expiry: 'October 30, 2026',
  new_expires_at: 'October 30, 2026', service_label: 'Pest control', company_phone: '(941) 555-0100',
};

async function cloneTemplate(key, { text_body = null, blocksOf = null } = {}) {
  const { template, version } = pre[key];
  const templateId = randomUUID();
  const versionId = randomUUID();
  const { id: _i, active_version_id: _a, ...templateCols } = template;
  // The public schema has usually run this migration already; the clone must
  // look like the template BEFORE it (the new variable was not yet allowed).
  for (const col of ['allowed_variables', 'optional_variables', 'required_variables']) {
    templateCols[col] = JSON.stringify((templateCols[col] ?? []).filter((v) => v !== 'estimate_pdf_note'));
  }
  await db('email_templates').insert({ ...templateCols, id: templateId, active_version_id: null });
  await db('email_template_versions').insert({
    id: versionId, template_id: templateId, version_number: version.version_number, status: 'active',
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

postgres('estimate email PDF note migration (PostgreSQL)', () => {
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

    migration = require('../models/migrations/20261019200000_estimate_email_pdf_note');
    library = jest.requireActual('../services/email-template-library');

    pre = {};
    for (const key of KEYS()) {
      const template = await admin('email_templates').where({ template_key: key }).first();
      if (!template) throw new Error(`Template ${key} is not in the migrated public schema`);
      // Later data migrations (20261019210000 retypes the note to a paragraph)
      // publish on top of this one, so find this migration's own version
      // anywhere in the template's history, not only as the active one.
      let version = await admin('email_template_versions').where({ id: template.active_version_id }).first();
      const published = (await admin('email_template_versions').where({ template_id: template.id }))
        .find((v) => v.validation_snapshot?.source === MARKER);
      if (published) {
        version = await admin('email_template_versions').where({ template_id: template.id, version_number: published.validation_snapshot.supersedes_version }).first();
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

  test('covers exactly the open-estimate templates, never the money or accepted ones', () => {
    expect(KEYS()).toEqual(expect.arrayContaining(['estimate.delivery', 'estimate.engage_gone_quiet', 'estimate.extended', 'estimate.extension_notice']));
    for (const key of KEYS()) {
      expect(key).not.toMatch(/deposit_abandoned|payment_step_abandoned|accepted|proposal_delivery/);
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
      expect(template.allowed_variables).toContain('estimate_pdf_note');
      expect(template.optional_variables).toContain('estimate_pdf_note');
      expect(template.required_variables).toEqual(pre[key].template.required_variables);
    }
    expect(await db('audit_log').where({ action: `${MARKER}:publish` })).toHaveLength(1);
  });

  test('each template gains one small_note right after its first button and loses nothing', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    for (const key of KEYS()) {
      const before = pre[key].version.blocks;
      const after = (await activeOf(key)).version.blocks;
      const added = after.filter((b) => b.content === '{{estimate_pdf_note}}');
      expect(added).toEqual([{ type: 'small_note', content: '{{estimate_pdf_note}}' }]);
      expect(after.filter((b) => b.content !== '{{estimate_pdf_note}}')).toEqual(before);
      const firstCta = before.findIndex((b) => b.type === 'cta' && b.variant !== 'link');
      if (firstCta >= 0) expect(after[firstCta + 1]).toEqual({ type: 'small_note', content: '{{estimate_pdf_note}}' });
    }
  });

  test('gate off is byte-identical: without a note every template renders exactly as before', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    for (const key of KEYS()) {
      const { template, version } = await activeOf(key);
      const before = library.renderTemplate({ template: pre[key].template, version: pre[key].version, payload: BASE_PAYLOAD });
      const after = library.renderTemplate({ template, version, payload: BASE_PAYLOAD });
      expect(after.html).toBe(before.html);
      expect(after.text).toBe(before.text);
      expect(after.subject).toBe(before.subject);
    }
  });

  test('gate on: the note renders in the html and the plain text', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    for (const key of KEYS()) {
      const { template, version } = await activeOf(key);
      const out = library.renderTemplate({ template, version, payload: { ...BASE_PAYLOAD, estimate_pdf_note: NOTE } });
      expect(out.text).toContain('A PDF copy of this estimate is attached.');
      expect(out.html).toContain('A PDF copy of this estimate is attached.');
    }
  });

  test('is idempotent: a second run publishes nothing new', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await migration.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('read-modify-write: an admin edit made before the migration survives it', async () => {
    const key = 'estimate.delivery';
    const edited = [...pre[key].version.blocks, { type: 'small_note', content: 'Admin-added closing line.' }];
    await cloneTemplate(key, { blocksOf: edited });
    await migration.up(db);
    const { version } = await activeOf(key);
    expect(version.blocks.at(-1)).toEqual({ type: 'small_note', content: 'Admin-added closing line.' });
    expect(JSON.stringify(version.blocks)).toContain('{{estimate_pdf_note}}');
  });

  test('a template with no button gets the note at the end', async () => {
    await cloneTemplate('estimate.delivery', { blocksOf: [{ type: 'paragraph', content: 'Hi {{first_name}}.' }] });
    await migration.up(db);
    expect((await activeOf('estimate.delivery')).version.blocks.at(-1)).toEqual({ type: 'small_note', content: '{{estimate_pdf_note}}' });
  });

  test('a template that already references the variable is left whole', async () => {
    const blocks = [...pre['estimate.delivery'].version.blocks, { type: 'small_note', content: '{{estimate_pdf_note}}' }];
    await cloneTemplate('estimate.delivery', { blocksOf: blocks });
    await migration.up(db);
    const { version } = await activeOf('estimate.delivery');
    expect(version.version_number).toBe(pre['estimate.delivery'].version.version_number);
    expect(version.status).toBe('active');
  });

  test('a custom plain-text body is left whole and logged, never half-patched', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await cloneTemplate('estimate.delivery', { text_body: 'Custom text body.' });
    await migration.up(db);
    const { template, version } = await activeOf('estimate.delivery');
    expect(version.version_number).toBe(pre['estimate.delivery'].version.version_number);
    expect(JSON.stringify(version.blocks)).not.toContain('estimate_pdf_note');
    expect(template.allowed_variables).not.toContain('estimate_pdf_note');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custom plain-text body present'));
    warn.mockRestore();
  });

  test('templates that are missing, or have no active version, are tolerated', async () => {
    const { templateId } = await cloneTemplate('estimate.delivery');
    await db('email_templates').where({ id: templateId }).update({ active_version_id: null });
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db('email_template_versions').where({ template_id: templateId })).toHaveLength(1);
  });

  test('preview fixtures gain the sample line; an existing value is never overwritten', async () => {
    const { templateId } = await cloneTemplate('estimate.delivery');
    const { templateId: otherId } = await cloneTemplate('estimate.extended');
    await db('email_template_fixtures').insert([
      { template_id: templateId, name: 'Default', is_default: true, payload: JSON.stringify({ first_name: 'Sam' }), updated_at: new Date() },
      { template_id: otherId, name: 'Default', is_default: true, payload: JSON.stringify({ estimate_pdf_note: 'Admin-edited note' }), updated_at: new Date() },
    ]);
    await migration.up(db);
    const delivery = await db('email_template_fixtures').where({ template_id: templateId }).first();
    expect(delivery.payload.estimate_pdf_note).toMatch(/PDF copy of this estimate is attached/);
    expect(delivery.payload.first_name).toBe('Sam');
    expect((await db('email_template_fixtures').where({ template_id: otherId }).first()).payload.estimate_pdf_note).toBe('Admin-edited note');
  });

  test('down is a documented no-op that keeps operator edits', async () => {
    await cloneTemplate('estimate.delivery');
    await migration.up(db);
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await db('email_templates').where({ template_key: 'estimate.delivery' }).update({ name: 'Operator estimate email' });
    await migration.down(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
    expect(await db('email_templates').where({ template_key: 'estimate.delivery' }).first()).toMatchObject({ name: 'Operator estimate email' });
  });
});
