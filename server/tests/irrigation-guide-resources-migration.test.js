const migration = require('../models/migrations/20260907000010_irrigation_guide_resources');
const { BLOCK: legacyLinks } = require('../models/migrations/20260803000000_irrigation_blog_links').__private;
const { TEMPLATE } = require('../models/migrations/20260828000004_seed_irrigation_week_plan_email_template').__private;
const { HEADING, GUIDES, updatedBlocks, updatedText } = migration.__private;
const SKIP = !process.env.DATABASE_URL;

describe('irrigation guide resources', () => {
  test('puts all four links below the existing CTA without changing the plan copy', () => {
    const before = structuredClone(TEMPLATE.blocks);
    const after = updatedBlocks(before);
    const cta = after.findIndex((block) => block.type === 'cta');
    expect(after[cta + 1]).toEqual({ type: 'heading', content: HEADING });
    expect(after.slice(cta + 2, cta + 6).map((block) => block.content))
      .toEqual(GUIDES.map(({ label, url }) => `[${label}](${url})`));
    expect(after.find((block) => block.type === 'callout')).toEqual(before.find((block) => block.type === 'callout'));
    expect(before).toEqual(TEMPLATE.blocks);
    expect(JSON.stringify(after)).not.toContain('Turn off Seasonal Lawn Tips');
    expect(JSON.stringify(after)).toContain('Weekly target for {{grass_label}}');
  });

  test('replaces the exact legacy links once and preserves a staff note', () => {
    const staff = { type: 'small_note', content: 'Staff-authored context stays here.' };
    const after = updatedBlocks([...TEMPLATE.blocks, legacyLinks, staff]);
    for (const { url } of GUIDES) expect(JSON.stringify(after).split(url)).toHaveLength(2);
    expect(after).toContainEqual(staff);
    expect(after).not.toContainEqual(legacyLinks);
    expect(updatedBlocks(after)).toEqual(after);
  });

  test('preserves a customized resource block without duplicating its links', () => {
    const staff = { type: 'paragraph', content: `Our office recommends this background: ${GUIDES[2].url}` };
    const after = updatedBlocks([...TEMPLATE.blocks, staff]);
    expect(after).toContainEqual(staff);
    for (const { url } of GUIDES) expect(JSON.stringify(after).split(url)).toHaveLength(2);
  });

  test('keeps other template fields and staff-authored opt-out wording untouched', () => {
    const blocks = [{ type: 'heading', content: 'A custom heading' }, { type: 'small_note', content: 'Reply to the office to adjust these emails.' }];
    expect(updatedBlocks(JSON.stringify(blocks))).toEqual(expect.arrayContaining(blocks));
    expect(updatedBlocks([])).toBeNull();
  });

  test('custom plain text retains its staff copy and includes each destination once', () => {
    const before = `A staff-authored plain-text message.\n\n${legacyLinks.content}`;
    const after = updatedText(before);
    expect(after).toContain('A staff-authored plain-text message.');
    expect(after).toContain(HEADING.toUpperCase());
    expect(after).not.toContain(legacyLinks.content);
    for (const { url } of GUIDES) expect(after.split(url)).toHaveLength(2);
    expect(updatedText(after)).toBe(after);
  });

  test('keeps automatic plain text derived from the updated blocks', () => {
    expect(updatedText(null)).toBeNull();
    expect(updatedText('')).toBe('');
  });
});

(SKIP ? describe.skip : describe)('irrigation resource publication against PostgreSQL', () => {
  let database;
  let trx;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => {
    await database?.destroy();
    await require('../models/db').destroy();
  });

  test('publishes all seven versions atomically, preserves history and disabled state, and does not republish on retry', async () => {
    const templates = await trx('email_templates').whereIn('template_key', migration.__private.TEMPLATE_KEYS);
    expect(templates).toHaveLength(7);
    const before = [];
    for (const template of templates) {
      const latest = await trx('email_template_versions').where({ template_id: template.id })
        .max('version_number as max').first();
      await trx('email_template_versions').where({ template_id: template.id, status: 'active' }).update({ status: 'archived' });
      const [version] = await trx('email_template_versions').insert({
        template_id: template.id, version_number: Number(latest.max) + 1,
        status: 'active', subject: 'Staff-authored subject', preview_text: 'Staff-authored preview',
        blocks: JSON.stringify([...TEMPLATE.blocks, legacyLinks]),
        text_body: `Staff-authored plain text.\n\n${legacyLinks.content}`, published_at: new Date(),
      }).returning('*');
      await trx('email_templates').where({ id: template.id }).update({ active_version_id: version.id, status: 'disabled' });
      before.push(version);
    }
    const auditBefore = await trx('audit_log').count('* as count').first();
    await migration.up(trx);
    const published = [];
    for (const original of before) {
      const template = await trx('email_templates').where({ id: original.template_id }).first();
      expect(template.status).toBe('disabled');
      const current = await trx('email_template_versions').where({ id: template.active_version_id }).first();
      const previous = await trx('email_template_versions').where({ id: original.id }).first();
      expect(previous.blocks).toEqual(original.blocks);
      expect(previous.text_body).toBe(original.text_body);
      expect(previous.status).toBe('archived');
      expect(current.subject).toBe(original.subject);
      expect(current.preview_text).toBe(original.preview_text);
      expect(current.version_number).toBe(original.version_number + 1);
      for (const { url } of GUIDES) {
        expect(JSON.stringify(current.blocks).split(url)).toHaveLength(2);
        expect(current.text_body.split(url)).toHaveLength(2);
      }
      const active = await trx('email_template_versions').where({ template_id: template.id, status: 'active' });
      expect(active).toHaveLength(1);
      published.push(current.id);
    }
    const auditAfter = await trx('audit_log').count('* as count').first();
    expect(Number(auditAfter.count) - Number(auditBefore.count)).toBe(7);
    await migration.up(trx);
    const retried = await trx('email_templates').whereIn('template_key', migration.__private.TEMPLATE_KEYS);
    expect(retried.map((row) => row.active_version_id).sort()).toEqual(published.sort());
  }, 90000);
});
