// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20261024140000 publishes ONE new active version of estimate.proposal_delivery
// (owner-approved copy, 2026-10-24). The pre-migration template is rebuilt from the
// copy the migration supersedes (the 20260619000000 seed), so the test proves the
// publish, the admin-edit rules, the skip rule and idempotence against that content.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `proposal_delivery_copy_${randomUUID().replaceAll('-', '')}`;
const migration = require('../models/migrations/20261024140000_estimate_proposal_delivery_copy');
const { OLD, NEW, NEXT_STEP, KEY, MARKER } = migration._private;

const OLD_FIXTURE = { first_name: 'Taylor', next_step_summary: OLD.nextStep, price_summary: '$2,361/mo' };
const PAYLOAD = {
  first_name: 'Taylor',
  estimate_url: 'https://example.test/estimate/sample',
  service_summary: 'Commercial pest control',
  property_address: '100 Example Rd, Sample City, FL 34200',
  price_summary: '$2,361/mo',
  next_step_summary: NEXT_STEP,
};

let admin;
let db;
let library;
let publicTemplate;

// The template as it stood before this migration: the seed copy, active, version 1.
async function seedTemplate({ subject = OLD.subject, preview = OLD.preview, blocks = OLD.blocks, textBody = null, ctaLabel = OLD.ctaLabel, fixture = OLD_FIXTURE } = {}) {
  const templateId = randomUUID();
  const versionId = randomUUID();
  const { id: _i, active_version_id: _a, ...cols } = publicTemplate;
  // json columns holding arrays must be sent as text (node-pg would turn a JS array into a PG array).
  for (const col of ['allowed_variables', 'optional_variables', 'required_variables']) cols[col] = JSON.stringify(cols[col] ?? []);
  await db('email_templates').insert({ ...cols, id: templateId, active_version_id: null, default_cta_label: ctaLabel });
  await db('email_template_versions').insert({
    id: versionId, template_id: templateId, version_number: 1, status: 'active',
    subject, preview_text: preview, blocks: JSON.stringify(blocks), text_body: textBody, published_at: new Date(),
  });
  await db('email_templates').where({ id: templateId }).update({ active_version_id: versionId });
  if (fixture) {
    await db('email_template_fixtures').insert({ template_id: templateId, name: 'Happy path', is_default: true, payload: JSON.stringify(fixture), updated_at: new Date() });
  }
  return { templateId, versionId };
}

const activeOf = async () => {
  const template = await db('email_templates').where({ template_key: KEY }).first();
  const version = await db('email_template_versions').where({ id: template.active_version_id }).first();
  return { template, version };
};

async function clearSchema() {
  await db('email_template_fixtures').del();
  await db('email_template_versions').del();
  await db('email_templates').del();
  await db('audit_log').del();
}

describe('estimate proposal delivery copy: block replacement (pure)', () => {
  const { replaceSeededBlocks } = migration._private;

  test('the approved strings are exactly the owner copy', () => {
    expect(NEW.subject).toBe('Your pest control proposal from Waves');
    expect(NEW.preview).toBe('Your proposal is attached. Here is how to get started.');
    expect(NEXT_STEP).toBe('To get started, reply to this email or call us at (941) 297-5749. We will confirm your start date and send your service agreement to sign.');
    expect(NEW.blocks).toEqual([
      { type: 'paragraph', content: 'Hi {{first_name}}, thank you for calling Waves Pest Control. Your proposal is attached as a PDF, and you can also open it online.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{service_summary}}' },
        { label: 'Property', value: '{{property_address}}' },
        { label: 'Price', value: '{{price_summary}}' },
      ] },
      { type: 'paragraph', content: '{{next_step_summary}}' },
      { type: 'cta', label: 'View your proposal', url_variable: 'estimate_url' },
      { type: 'small_note', content: 'Questions? Reply to this email or call (941) 297-5749.' },
    ]);
    expect(NEW.ctaLabel).toBe('View your proposal');
  });

  test('the seeded blocks become the new blocks (the next-step paragraph is the same in both); the new blocks are left alone', () => {
    expect(replaceSeededBlocks(OLD.blocks)).toEqual({ blocks: NEW.blocks, replaced: 4, kept: 0 });
    expect(replaceSeededBlocks(NEW.blocks)).toEqual({ blocks: NEW.blocks, replaced: 0, kept: 0 });
  });

  test('blocks compare by content, not key order (jsonb returns keys sorted)', () => {
    const reordered = OLD.blocks.map((b) => Object.fromEntries(Object.entries(b).reverse()));
    expect(replaceSeededBlocks(reordered)).toMatchObject({ replaced: 4, kept: 0 });
  });

  test('an admin-edited block is kept and counted; its neighbours still move to the new copy', () => {
    const edited = OLD.blocks.map((b, i) => (i === 4 ? { type: 'small_note', content: 'Admin closing line.' } : b));
    const out = replaceSeededBlocks(edited);
    expect(out.replaced).toBe(3);
    expect(out.kept).toBe(1);
    expect(out.blocks.slice(0, 4)).toEqual(NEW.blocks.slice(0, 4));
    expect(out.blocks[4]).toEqual({ type: 'small_note', content: 'Admin closing line.' });
  });
});

postgres('estimate proposal delivery copy migration (PostgreSQL)', () => {
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
    library = jest.requireActual('../services/email-template-library');
    publicTemplate = await admin('email_templates').where({ template_key: KEY }).first();
    if (!publicTemplate) throw new Error(`Template ${KEY} is not in the migrated public schema`);
  }, 60000);

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  beforeEach(async () => { await clearSchema(); jest.restoreAllMocks(); });

  test('publishes one new active version: compare-and-swap on the active version, only the replaced one archived', async () => {
    const { templateId } = await seedTemplate();
    await migration.up(db);

    const { template, version } = await activeOf();
    const versions = await db('email_template_versions').where({ template_id: templateId }).orderBy('version_number');
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version_number: 1, status: 'archived', subject: OLD.subject });
    expect(versions[1]).toMatchObject({ id: version.id, version_number: 2, status: 'active' });
    expect(template.active_version_id).toBe(version.id);
    expect(template.default_cta_label).toBe('View your proposal');
    expect(version.subject).toBe('Your pest control proposal from Waves');
    expect(version.preview_text).toBe('Your proposal is attached. Here is how to get started.');
    expect(version.blocks).toEqual(NEW.blocks);
    expect(version.text_body).toBeNull();
    expect(version.validation_snapshot).toMatchObject({ ok: true, source: MARKER, supersedes_version: 1 });
    expect(library.validationFor(template, version).ok).toBe(true);
    expect(await db('audit_log').where({ action: `${MARKER}:publish` })).toHaveLength(1);
  });

  test('the published email renders the approved copy and no "no online checkout" line', async () => {
    await seedTemplate();
    await migration.up(db);
    const { template, version } = await activeOf();
    const out = library.renderTemplate({ template, version, payload: PAYLOAD });
    expect(out.subject).toBe('Your pest control proposal from Waves');
    for (const text of [out.html, out.text]) {
      expect(text).toContain('thank you for calling Waves Pest Control. Your proposal is attached as a PDF, and you can also open it online.');
      expect(text).toContain('Price');
      expect(text).toContain(NEXT_STEP);
      expect(text).toContain('Questions? Reply to this email or call (941) 297-5749.');
      expect(text).not.toMatch(/online checkout|Proposal estimate/i);
    }
    expect(out.html).toContain('View your proposal');
  });

  test('read-modify-write: an admin-edited subject and block survive; the untouched blocks move to the new copy', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = OLD.blocks.map((b, i) => (i === 4 ? { type: 'small_note', content: 'Admin closing line.' } : b));
    await seedTemplate({ subject: 'Admin subject', blocks });
    await migration.up(db);
    const { version } = await activeOf();
    expect(version.subject).toBe('Admin subject');
    expect(version.preview_text).toBe(NEW.preview);
    expect(version.blocks.slice(0, 4)).toEqual(NEW.blocks.slice(0, 4));
    expect(version.blocks[4]).toEqual({ type: 'small_note', content: 'Admin closing line.' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('admin-edited parts kept'));
  });

  test('a custom plain-text body is left whole and logged, never half-patched', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await seedTemplate({ textBody: 'Custom text body.' });
    await migration.up(db);
    const { template, version } = await activeOf();
    expect(version).toMatchObject({ version_number: 1, status: 'active', subject: OLD.subject });
    expect(version.blocks).toEqual(OLD.blocks);
    expect(template.default_cta_label).toBe(OLD.ctaLabel);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custom plain-text body present'));
    expect(await db('email_template_versions')).toHaveLength(1);
  });

  test('is idempotent: a second run publishes nothing new', async () => {
    await seedTemplate();
    await migration.up(db);
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await migration.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('is idempotent after a partial publish over admin edits: nothing more changes on a re-run', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = OLD.blocks.map((b, i) => (i === 4 ? { type: 'small_note', content: 'Admin closing line.' } : b));
    await seedTemplate({ blocks });
    await migration.up(db);
    const snapshot = await db('email_template_versions').select('id', 'status').orderBy('id');
    await migration.up(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(snapshot);
  });

  test('the preview fixture gets the new sentence; an admin-edited sentence is never overwritten', async () => {
    await seedTemplate();
    await migration.up(db);
    const fixture = await db('email_template_fixtures').first();
    expect(fixture.payload.next_step_summary).toBe(NEXT_STEP);
    expect(fixture.payload.first_name).toBe('Taylor');

    await clearSchema();
    await seedTemplate({ fixture: { ...OLD_FIXTURE, next_step_summary: 'Admin sentence.' } });
    await migration.up(db);
    expect((await db('email_template_fixtures').first()).payload.next_step_summary).toBe('Admin sentence.');
  });

  test('the admin preview renders from the updated fixture', async () => {
    await seedTemplate();
    await migration.up(db);
    const { template, version } = await activeOf();
    const fixture = await db('email_template_fixtures').first();
    const out = library.renderTemplate({ template, version, payload: fixture.payload });
    expect(out.text).toContain(NEXT_STEP);
    expect(out.text).not.toMatch(/online checkout/i);
  });

  test('a missing template, or one with no active version, is tolerated', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    const { templateId } = await seedTemplate();
    await db('email_templates').where({ id: templateId }).update({ active_version_id: null });
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db('email_template_versions').where({ template_id: templateId })).toHaveLength(1);
  });

  test('down is a documented no-op that keeps operator edits', async () => {
    await seedTemplate();
    await migration.up(db);
    const before = await db('email_template_versions').select('id', 'status').orderBy('id');
    await db('email_templates').where({ template_key: KEY }).update({ name: 'Operator proposal email' });
    await migration.down(db);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(before);
    expect(await db('email_templates').where({ template_key: KEY }).first()).toMatchObject({ name: 'Operator proposal email' });
  });
});
