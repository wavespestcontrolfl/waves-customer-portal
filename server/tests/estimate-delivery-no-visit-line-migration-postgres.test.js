// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20261122030000 publishes ONE new active version of the live estimate email (estimate.delivery) with the owner's
// "no visit needed" sentence under the price rows. The pre-migration content is the real shipped content, read from
// the migrated `public` schema (the version this migration superseded when it has already run there), so the test
// proves the migration against what production holds.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `estimate_no_visit_line_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20261122030000';
const KEY = 'estimate.delivery';
const LINE = 'We measure your home and yard from county records and satellite images, so most quotes need no visit.';
const PARAGRAPH = { type: 'paragraph', content: LINE };
let admin;
let db;
let migration;
let library;
let pre; // { template, version } as shipped before this migration

const PAYLOAD = {
  first_name: 'Sam', estimate_url: 'https://example.test/estimate', price_summary: '$99/mo',
  service_summary: 'Pest control', property_address: '123 Example Street', next_step_summary: 'Open the estimate.',
};

async function cloneTemplate({ text_body = null, blocksOf = null } = {}) {
  const { template, version } = pre;
  const templateId = randomUUID();
  const versionId = randomUUID();
  const { id: _i, active_version_id: _a, ...templateCols } = template;
  for (const col of ['allowed_variables', 'optional_variables', 'required_variables']) {
    templateCols[col] = JSON.stringify(templateCols[col] ?? []);
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

const active = async () => {
  const template = await db('email_templates').where({ template_key: KEY }).first();
  const version = await db('email_template_versions').where({ id: template.active_version_id }).first();
  return { template, version };
};

postgres('estimate email "no visit needed" line migration (PostgreSQL)', () => {
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
    for (const table of ['email_templates', 'email_template_versions', 'audit_log']) {
      await db.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    await db.raw('ALTER TABLE email_template_versions ADD CONSTRAINT v_tpl_fk FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE CASCADE');

    migration = require('../models/migrations/20261122030000_estimate_delivery_no_visit_line');
    library = jest.requireActual('../services/email-template-library');

    const template = await admin('email_templates').where({ template_key: KEY }).first();
    if (!template) throw new Error(`Template ${KEY} is not in the migrated public schema`);
    // A later data migration can publish on top of this one, so find this migration's own version anywhere in the
    // template's history, not only as the active one, and start from the version it replaced.
    let version = await admin('email_template_versions').where({ id: template.active_version_id }).first();
    const published = (await admin('email_template_versions').where({ template_id: template.id }))
      .find((v) => v.validation_snapshot?.source === MARKER);
    if (published) {
      version = await admin('email_template_versions').where({ template_id: template.id, version_number: published.validation_snapshot.supersedes_version }).first();
    }
    pre = { template, version };
  }, 60000);

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    await db('email_template_versions').del();
    await db('email_templates').del();
    await db('audit_log').del();
    jest.clearAllMocks();
  });

  test('the shipped estimate email has price rows and does not carry the line yet', () => {
    expect(pre.version.blocks.some((b) => b.type === 'details')).toBe(true);
    expect(JSON.stringify(pre.version.blocks)).not.toContain(LINE);
  });

  test('publishes one new active version: compare-and-swap on the active version, only the replaced one archived', async () => {
    await cloneTemplate();
    await migration.up(db);

    const { template, version } = await active();
    const versions = await db('email_template_versions').where({ template_id: template.id }).orderBy('version_number');
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version_number: pre.version.version_number, status: 'archived' });
    expect(versions[1]).toMatchObject({ id: version.id, version_number: pre.version.version_number + 1, status: 'active' });
    expect(version.subject).toBe(pre.version.subject);
    expect(version.preview_text).toBe(pre.version.preview_text);
    expect(version.text_body).toBeNull();
    expect(version.validation_snapshot).toMatchObject({ ok: true, source: MARKER, supersedes_version: pre.version.version_number });
    expect(library.validationFor(template, version).ok).toBe(true);
    for (const col of ['allowed_variables', 'optional_variables', 'required_variables']) {
      expect(template[col]).toEqual(pre.template[col] ?? []);
    }
    const audits = await db('audit_log').where({ action: `${MARKER}:publish` });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ resource_type: 'email_template', resource_id: template.id });
    expect(audits[0].metadata).toEqual({
      results: { [KEY]: 'published' },
      from_version: pre.version.version_number,
      to_version: pre.version.version_number + 1,
      added_paragraph: LINE,
    });
  });

  test('the email gains the one paragraph directly under the price rows and loses nothing', async () => {
    await cloneTemplate();
    await migration.up(db);
    const before = pre.version.blocks;
    const after = (await active()).version.blocks;
    expect(after.filter((b) => b.content === LINE)).toEqual([PARAGRAPH]);
    expect(after.filter((b) => b.content !== LINE)).toEqual(before);
    expect(after[before.findIndex((b) => b.type === 'details') + 1]).toEqual(PARAGRAPH);
  });

  test('the line renders once in the html and in the plain text, between the price rows and the button', async () => {
    await cloneTemplate();
    await migration.up(db);
    const { template, version } = await active();
    const before = library.renderTemplate({ template: pre.template, version: pre.version, payload: PAYLOAD });
    const after = library.renderTemplate({ template, version, payload: PAYLOAD });
    expect(after.subject).toBe(before.subject);
    expect(before.text).not.toContain(LINE);
    expect(after.text.split(LINE)).toHaveLength(2);
    expect(after.html.split(LINE)).toHaveLength(2);
    expect(after.text.indexOf('$99/mo')).toBeLessThan(after.text.indexOf(LINE));
    expect(after.text.indexOf(LINE)).toBeLessThan(after.text.indexOf('https://example.test/estimate'));
  });

  test('is idempotent: a second run publishes nothing new', async () => {
    await cloneTemplate();
    await migration.up(db);
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await migration.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('read-modify-write: an admin edit made before the migration survives it', async () => {
    const edited = [...pre.version.blocks, { type: 'small_note', content: 'Admin-added closing line.' }];
    await cloneTemplate({ blocksOf: edited });
    await migration.up(db);
    const { version } = await active();
    expect(version.blocks.at(-1)).toEqual({ type: 'small_note', content: 'Admin-added closing line.' });
    expect(version.blocks.filter((b) => b.content === LINE)).toEqual([PARAGRAPH]);
  });

  test('a template rebuilt without price rows gets the line above its button; with no button, at the end', async () => {
    await cloneTemplate({ blocksOf: [{ type: 'paragraph', content: 'Hi {{first_name}}.' }, { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' }] });
    await migration.up(db);
    expect((await active()).version.blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'cta']);
    expect((await active()).version.blocks[1]).toEqual(PARAGRAPH);

    await db('email_template_versions').del();
    await db('email_templates').del();
    await cloneTemplate({ blocksOf: [{ type: 'paragraph', content: 'Hi {{first_name}}: {{estimate_url}}' }] });
    await migration.up(db);
    expect((await active()).version.blocks.at(-1)).toEqual(PARAGRAPH);
  });

  test('a template that already carries the sentence is left whole', async () => {
    await cloneTemplate({ blocksOf: [...pre.version.blocks, { type: 'small_note', content: `Good to know: ${LINE}` }] });
    await migration.up(db);
    const { version } = await active();
    expect(version.version_number).toBe(pre.version.version_number);
    expect(version.status).toBe('active');
    expect((await db('audit_log').where({ action: `${MARKER}:publish` }))[0].metadata).toEqual({ results: { [KEY]: 'already' }, from_version: null, to_version: null, added_paragraph: null });
  });

  test('a custom plain-text body is left whole and logged, never half-patched', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await cloneTemplate({ text_body: 'Custom text body: {{estimate_url}}' });
    await migration.up(db);
    const { version } = await active();
    expect(version.version_number).toBe(pre.version.version_number);
    expect(JSON.stringify(version.blocks)).not.toContain(LINE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custom plain-text body present'));
    warn.mockRestore();
  });

  test('a missing template, or one with no active version, is tolerated', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    const { templateId } = await cloneTemplate();
    await db('email_templates').where({ id: templateId }).update({ active_version_id: null });
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db('email_template_versions').where({ template_id: templateId })).toHaveLength(1);
  });

  test('down is a documented no-op that keeps operator edits', async () => {
    await cloneTemplate();
    await migration.up(db);
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await db('email_templates').where({ template_key: KEY }).update({ name: 'Operator estimate email' });
    await migration.down(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
    expect(await db('email_templates').where({ template_key: KEY }).first()).toMatchObject({ name: 'Operator estimate email' });
  });
});
