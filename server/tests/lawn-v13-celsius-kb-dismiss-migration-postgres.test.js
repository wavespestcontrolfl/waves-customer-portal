// Dismiss NXT is retired (#6098: use up existing stock on green kyllinga only, do not reorder), yet the
// "Celsius WG — Application Limits" article still lists it as an alternative after the cap
// ("different MOA, no annual cap concern"). 20261007177000 rewrites that one line.
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261007177000_lawn_v13_cap_clamp_and_kb_dismiss');
const keep = require('../models/migrations/20261007179500_lawn_v13_keep_dismiss_retired');
const afterCap = require('../models/migrations/20261007176000_lawn_v13_celsius_kb_after_cap');
const first = require('../models/migrations/20261007173000_lawn_v13_celsius_kb_article');

const SLUG = migration._KB_SLUG;
const { old: OLD, next: NEXT } = migration._DISMISS;
const seedScript = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'seed-knowledge-base.js'), 'utf8');

function seedArticle() {
  const start = seedScript.indexOf(`slug: '${SLUG}'`);
  const open = seedScript.indexOf('content: `', start) + 'content: `'.length;
  return seedScript.slice(open, seedScript.indexOf('`,', open));
}
// The article as 176000 left it: the seed with the Dismiss line put back.
const beforeDismiss = () => seedArticle().replace(NEXT, () => OLD);

describe('the seed script and the migration agree (no database)', () => {
  test('the seed no longer recommends Dismiss: its one mention says retired, do not reorder, kyllinga only', () => {
    const content = seedArticle();
    expect(content).toContain(NEXT);
    expect(content).not.toContain(OLD);
    const mentions = content.split('\n').filter((line) => /dismiss/i.test(line));
    expect(mentions).toEqual([NEXT]);
    expect(NEXT).toMatch(/retired: do not reorder/);
    expect(NEXT).toMatch(/green kyllinga under 85°F only/);
    expect(NEXT).toMatch(/not an alternative after the Celsius cap/);
    expect(NEXT).not.toMatch(/no annual cap concern/);
  });

  test('the line 20261007173000 wrote (which named Dismiss) is superseded by 20261007176000; nothing 176000 wrote names Dismiss', () => {
    expect(first._REPLACEMENTS[2].next).toMatch(/Dismiss/);
    for (const row of afterCap._REPLACEMENTS) expect(row.next).not.toMatch(/Dismiss/);
    expect(seedArticle()).toContain(afterCap._REPLACEMENTS[0].next);
  });
});

const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('20261007177000 (the Dismiss line) on PostgreSQL', () => {
  let database;
  const schema = `kb_dismiss_${randomUUID().replaceAll('-', '')}`;
  const tables = ['knowledge_base', 'knowledge_embeddings', 'audit_log'];
  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING DEFAULTS INCLUDING GENERATED)', [schema, table, table]);
  });
  afterEach(async () => { for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]); });
  afterAll(async () => { await database.raw('DROP SCHEMA ?? CASCADE', [schema]); await database.destroy(); });

  const insert = (content = beforeDismiss()) => database('knowledge_base').insert({
    id: randomUUID(), slug: SLUG, path: `kb/chemicals/${SLUG}.md`, title: 'Celsius WG — Application Limits', category: 'chemicals',
    content, tags: JSON.stringify(['celsius']), confidence: 'high', last_verified_at: new Date('2026-10-07T00:00:00Z'), verified_by: 'migration-lawn-v13-celsius-kb-after-cap',
  }).returning('*').then(([row]) => row);
  const chunk = (sourceId, index = 0) => database('knowledge_embeddings').insert({ source: 'kb', source_id: sourceId, chunk_index: index, title: 't', content: 'old chunk', content_hash: `${sourceId}-${index}`, embedded_at: new Date() });
  const article = () => database('knowledge_base').where({ slug: SLUG }).first();
  const events = (action = migration._KB_ACTION) => database('audit_log').where({ action });

  test('rewrites only the Dismiss line, purges this article\'s chunks only, audits once', async () => {
    const row = await insert();
    await chunk(SLUG, 0); await chunk('other-article', 0);
    await migration.up(database);
    expect((await article()).content).toBe(seedArticle());
    expect((await article()).verified_by).toBe('migration-lawn-v13-celsius-dismiss-retired');
    expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: SLUG })).toHaveLength(0);
    expect(await database('knowledge_embeddings').where({ source_id: 'other-article' })).toHaveLength(1);
    const logged = await events();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ resource_id: String(row.id) });
    expect(logged[0].metadata).toMatchObject({ before: OLD, after: NEXT });
  });

  test('a second run changes nothing, and the line is never rewritten twice', async () => {
    await insert();
    await migration.up(database);
    const once = (await article()).content;
    await chunk(SLUG, 0);
    await migration.up(database);
    expect((await article()).content).toBe(once);
    expect(await events()).toHaveLength(1);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(1);
  });

  test('an admin-edited line, a missing article and a missing table are no-ops', async () => {
    const edited = beforeDismiss().replace(OLD, '- Dismiss NXT: our own note.');
    await insert(edited);
    await chunk(SLUG, 0);
    await migration.up(database);
    expect((await article()).content).toBe(edited);
    expect(await events()).toHaveLength(0);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(1);
    await database('knowledge_base').del();
    await expect(migration.up(database)).resolves.toBeUndefined();
  });

  test('down puts the old line back only while the exact new line is present, purges and audits; an edited line stays', async () => {
    await insert();
    await migration.up(database);
    await chunk(SLUG, 0);
    await migration.down(database);
    expect((await article()).content).toBe(beforeDismiss());
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(0);
    expect(await events(migration._KB_ACTION_DOWN)).toHaveLength(1);
    await migration.down(database);
    expect(await events(migration._KB_ACTION_DOWN)).toHaveLength(1);
    await migration.up(database);
    await database('knowledge_base').where({ slug: SLUG }).update({ content: (await article()).content.replace(NEXT, '- Dismiss: admin wording.') });
    await migration.down(database);
    expect((await article()).content).toContain('- Dismiss: admin wording.');
  });

  test('rolling back newest-first (179500 then 177000) never restores the retired Dismiss recommendation', async () => {
    await insert();
    await migration.up(database); // 177000's state
    await chunk(SLUG, 0);
    await keep.down(database);
    const kept = (await article()).content;
    expect(kept).toContain(keep._KEPT);
    expect(kept).not.toContain(NEXT);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(0);
    expect(await events(keep._KB_ACTION)).toHaveLength(1);
    await migration.down(database); // 177000's rollback now finds nothing to restore
    const after = (await article()).content;
    expect(after).toBe(kept);
    expect(after).not.toContain(OLD);
    expect(after).not.toMatch(/no annual cap concern/);
    expect(after).toMatch(/Dismiss NXT .* retired/);
    expect(await events(migration._KB_ACTION_DOWN)).toHaveLength(0);
  });

  test('179500: up changes nothing; down leaves an admin-edited line, a missing article and a repeat alone; the wording differs from 177000\'s line', async () => {
    await insert();
    await migration.up(database);
    const before = (await article()).content;
    await keep.up(database);
    expect((await article()).content).toBe(before);
    await database('knowledge_base').where({ slug: SLUG }).update({ content: before.replace(NEXT, '- Dismiss: admin wording.') });
    await keep.down(database);
    expect((await article()).content).toContain('- Dismiss: admin wording.');
    expect(await events(keep._KB_ACTION)).toHaveLength(0);
    await database('knowledge_base').del();
    await expect(keep.down(database)).resolves.toBeUndefined();
    expect(keep._KEPT.includes(NEXT)).toBe(false);
    expect(NEXT.includes(keep._KEPT)).toBe(false);
  });
});
