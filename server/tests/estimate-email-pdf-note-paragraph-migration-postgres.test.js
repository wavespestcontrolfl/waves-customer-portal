// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20261019210000 retypes the `{{estimate_pdf_note}}` small_note block (13px,
// under the 14px customer floor) to a paragraph (15px) on every live template
// that carries it. The pre-migration content of each is the real shipped
// content: the version 20261019200000 published, read from the migrated
// `public` schema's history, so the test proves the migration against what
// production holds - and proves the gate-off promise: rendered with no
// estimate_pdf_note, every template's html and text are byte-identical before
// and after.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `estimate_email_pdf_para_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20261019210000';
const FIRST_MARKER = 'migration:20261019200000';
const NOTE = "Can't open the link? A PDF copy of this estimate is attached.";
const NOTE_BLOCK = { type: 'small_note', content: '{{estimate_pdf_note}}' };
let admin;
let db;
let migration;
let library;
let pre; // template_key -> { template, version } as 20261019200000 left it (small_note)

const KEYS = () => Object.keys(pre);

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

const activeOf = async (key) => {
  const template = await db('email_templates').where({ template_key: key }).first();
  const version = await db('email_template_versions').where({ id: template.active_version_id }).first();
  return { template, version };
};

const noteFont = (html) => {
  const at = html.indexOf('A PDF copy of this estimate is attached.');
  return /font-size:(\d+)px/.exec(html.slice(html.lastIndexOf('<p', at), at))?.[1];
};

async function clearSchema() {
  await db('email_template_fixtures').del();
  await db('email_template_versions').del();
  await db('email_templates').del();
  await db('audit_log').del();
}

postgres('estimate email PDF note paragraph migration (PostgreSQL)', () => {
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

    migration = require('../models/migrations/20261019210000_estimate_email_pdf_note_paragraph');
    library = jest.requireActual('../services/email-template-library');

    pre = {};
    const firstPlans = require('../models/migrations/20261019200000_estimate_email_pdf_note')._private.PLANS;
    for (const { key } of firstPlans) {
      const template = await admin('email_templates').where({ template_key: key }).first();
      if (!template) throw new Error(`Template ${key} is not in the migrated public schema`);
      // The version 20261019200000 published (small_note), found in the history
      // whether or not this migration has already published on top of it.
      const version = (await admin('email_template_versions').where({ template_id: template.id }))
        .find((v) => v.validation_snapshot?.source === FIRST_MARKER);
      if (!version) throw new Error(`Template ${key} has no version published by ${FIRST_MARKER}`);
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

  test('the shipped versions it starts from carry the note as a small_note', () => {
    expect(KEYS()).toHaveLength(14);
    for (const key of KEYS()) {
      expect(pre[key].version.blocks.filter((b) => b.content === '{{estimate_pdf_note}}')).toEqual([NOTE_BLOCK]);
    }
  });

  test('finds every template that carries the note and publishes one new active version each (compare-and-swap, only the replaced version archived)', async () => {
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
      expect(template.allowed_variables).toEqual(pre[key].template.allowed_variables);
      expect(template.required_variables).toEqual(pre[key].template.required_variables);
    }
    const audit = await db('audit_log').where({ action: `${MARKER}:publish` });
    expect(audit).toHaveLength(1);
  });

  test('only the note block changes: small_note becomes paragraph, in the same place, every other block untouched', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    for (const key of KEYS()) {
      const before = pre[key].version.blocks;
      const after = (await activeOf(key)).version.blocks;
      expect(after).toHaveLength(before.length);
      after.forEach((block, i) => {
        if (before[i].content === '{{estimate_pdf_note}}') expect(block).toEqual({ type: 'paragraph', content: '{{estimate_pdf_note}}' });
        else expect(block).toEqual(before[i]);
      });
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

  test('gate on: the note renders at 15px (was 13px) and the plain text is unchanged', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    for (const key of KEYS()) {
      const { template, version } = await activeOf(key);
      const payload = { ...BASE_PAYLOAD, estimate_pdf_note: NOTE };
      const before = library.renderTemplate({ template: pre[key].template, version: pre[key].version, payload });
      const after = library.renderTemplate({ template, version, payload });
      expect(noteFont(before.html)).toBe('13');
      expect(noteFont(after.html)).toBe('15');
      expect(after.text).toBe(before.text);
      expect(after.text).toContain('A PDF copy of this estimate is attached.');
    }
  });

  test('is idempotent: a second run publishes nothing new', async () => {
    for (const key of KEYS()) await cloneTemplate(key);
    await migration.up(db);
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await migration.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('a template whose note is already a paragraph is left whole', async () => {
    const blocks = pre['estimate.delivery'].version.blocks.map((b) => (b.content === '{{estimate_pdf_note}}' ? { type: 'paragraph', content: b.content } : b));
    await cloneTemplate('estimate.delivery', { blocksOf: blocks });
    await migration.up(db);
    const { template, version } = await activeOf('estimate.delivery');
    expect(version.version_number).toBe(pre['estimate.delivery'].version.version_number);
    expect(await db('email_template_versions').where({ template_id: template.id })).toHaveLength(1);
  });

  test('templates that do not carry the note, and blocks that only mention it, are never touched', async () => {
    const plain = (await admin('email_templates').where({ template_key: 'estimate.accepted_confirmation' }).first());
    if (plain) {
      const version = await admin('email_template_versions').where({ id: plain.active_version_id }).first();
      const { id: _i, active_version_id: _a, ...cols } = plain;
      const templateId = randomUUID();
      for (const col of ['allowed_variables', 'optional_variables', 'required_variables']) cols[col] = JSON.stringify(cols[col] ?? []);
      await db('email_templates').insert({ ...cols, id: templateId, active_version_id: null });
      const versionId = randomUUID();
      await db('email_template_versions').insert({ id: versionId, template_id: templateId, version_number: version.version_number, status: 'active', subject: version.subject, blocks: JSON.stringify(version.blocks), published_at: new Date() });
      await db('email_templates').where({ id: templateId }).update({ active_version_id: versionId });
    }
    const mention = [...pre['estimate.delivery'].version.blocks.filter((b) => b.content !== '{{estimate_pdf_note}}'), { type: 'small_note', content: 'Note: {{estimate_pdf_note}}' }];
    await cloneTemplate('estimate.delivery', { blocksOf: mention });
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await migration.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
  });

  test('read-modify-write: admin edits made before the migration survive it', async () => {
    const key = 'estimate.delivery';
    const edited = [...pre[key].version.blocks, { type: 'small_note', content: 'Admin-added closing line.' }];
    await cloneTemplate(key, { blocksOf: edited });
    await migration.up(db);
    const { version } = await activeOf(key);
    expect(version.blocks.at(-1)).toEqual({ type: 'small_note', content: 'Admin-added closing line.' });
    expect(version.blocks.filter((b) => b.content === '{{estimate_pdf_note}}')).toEqual([{ type: 'paragraph', content: '{{estimate_pdf_note}}' }]);
  });

  test('a custom plain-text body is left whole and logged, never half-patched', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await cloneTemplate('estimate.delivery', { text_body: 'Custom text body.' });
    await migration.up(db);
    const { version } = await activeOf('estimate.delivery');
    expect(version.version_number).toBe(pre['estimate.delivery'].version.version_number);
    expect(version.blocks.filter((b) => b.content === '{{estimate_pdf_note}}')).toEqual([NOTE_BLOCK]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custom plain-text body present'));
    warn.mockRestore();
  });

  test('blocks that are not a list are left whole and logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await cloneTemplate('estimate.delivery', { blocksOf: { odd: '{{estimate_pdf_note}}' } });
    await migration.up(db);
    const { version } = await activeOf('estimate.delivery');
    expect(version.version_number).toBe(pre['estimate.delivery'].version.version_number);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('active blocks unreadable'));
    warn.mockRestore();
  });

  test('a template with no active version is tolerated', async () => {
    const { templateId } = await cloneTemplate('estimate.delivery');
    await db('email_templates').where({ id: templateId }).update({ active_version_id: null });
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db('email_template_versions').where({ template_id: templateId })).toHaveLength(1);
  });

  test('an empty database is a no-op', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db('email_template_versions')).toHaveLength(0);
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
