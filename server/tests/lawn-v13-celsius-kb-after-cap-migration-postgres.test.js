// 20261007173000 told techs nearing the Celsius cap to switch to "Dismiss, Certainty, or manual pulling".
// Certainty goes WITH Celsius and shares the 2-per-lawn cap under v13; the recipe says "use Blindside
// after the Celsius cap" (Blindside is capped at 2 too). 20261007176000 corrects the two lines.
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');

const first = require('../models/migrations/20261007173000_lawn_v13_celsius_kb_article');
const migration = require('../models/migrations/20261007176000_lawn_v13_celsius_kb_after_cap');

const SLUG = migration._KB_SLUG;
const [FLAG, CERTAINTY] = migration._REPLACEMENTS;
const AUDIT = migration._AUDIT_ACTION;
const AUDIT_DOWN = migration._AUDIT_ACTION_DOWN;
const seedScript = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'seed-knowledge-base.js'), 'utf8');

function seedArticle() {
  const start = seedScript.indexOf(`slug: '${SLUG}'`);
  const open = seedScript.indexOf('content: `', start) + 'content: `'.length;
  return seedScript.slice(open, seedScript.indexOf('`,', open));
}
// The article as 173000 left it.
const afterFirst = () => migration._REPLACEMENTS.reduce((content, row) => content.replace(row.next, () => row.old), seedArticle());

describe('the seed script and the migration agree (no database)', () => {
  test('the seed carries the corrected lines: Blindside after the cap, Certainty not the switch', () => {
    const content = seedArticle();
    expect(content).toContain(FLAG.next);
    expect(content).toContain(CERTAINTY.next);
    expect(content).not.toContain('switch to alternative (Dismiss, Certainty, or manual pulling)');
    expect(FLAG.next).toMatch(/use Blindside \(also capped at 2 applications per lawn per year under v13\)/);
    expect(FLAG.next).toMatch(/Certainty goes with Celsius and shares the same 2 per lawn per year, so it is not the switch/);
  });

  test('the old lines are exactly what 20261007173000 wrote', () => {
    expect(first._REPLACEMENTS[2].next).toBe(FLAG.old);
    const old = afterFirst();
    expect(old).toContain(FLAG.old);
    expect(old).toContain(CERTAINTY.old);
  });
});

const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('20261007176000_lawn_v13_celsius_kb_after_cap on PostgreSQL', () => {
  let database;
  const schema = `kb_after_cap_${randomUUID().replaceAll('-', '')}`;
  const tables = ['knowledge_base', 'knowledge_embeddings', 'audit_log'];
  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING DEFAULTS INCLUDING GENERATED)', [schema, table, table]);
  });
  afterEach(async () => { for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]); });
  afterAll(async () => { await database.raw('DROP SCHEMA ?? CASCADE', [schema]); await database.destroy(); });

  const insert = (content = afterFirst()) => database('knowledge_base').insert({
    id: randomUUID(), slug: SLUG, path: `kb/chemicals/${SLUG}.md`, title: 'Celsius WG — Application Limits', category: 'chemicals',
    content, tags: JSON.stringify(['celsius']), confidence: 'high', last_verified_at: new Date('2026-10-07T00:00:00Z'), verified_by: 'migration-lawn-v13-celsius-kb-article',
  }).returning('*').then(([row]) => row);
  const chunk = (sourceId, index = 0) => database('knowledge_embeddings').insert({ source: 'kb', source_id: sourceId, chunk_index: index, title: 't', content: 'old chunk', content_hash: `${sourceId}-${index}`, embedded_at: new Date() });
  const article = () => database('knowledge_base').where({ slug: SLUG }).first();
  const events = (action = AUDIT) => database('audit_log').where({ action });

  test('rewrites the two lines to the current seed text, keeps the rest, purges only this article\'s chunks, audits once', async () => {
    const row = await insert();
    await chunk(SLUG, 0); await chunk(SLUG, 1); await chunk('other-article', 0);
    await migration.up(database);
    expect((await article()).content).toBe(seedArticle());
    expect((await article()).content).toContain('use Blindside (also capped');
    expect((await article()).verified_by).toBe('migration-lawn-v13-celsius-kb-after-cap');
    expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: SLUG })).toHaveLength(0);
    expect(await database('knowledge_embeddings').where({ source_id: 'other-article' })).toHaveLength(1);
    const logged = await events();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ resource_id: String(row.id) });
    expect(logged[0].metadata.changed).toHaveLength(2);
  });

  test('a second run changes nothing (the new Certainty line starts with the old one and is not rewritten twice)', async () => {
    await insert();
    await migration.up(database);
    const once = (await article()).content;
    await chunk(SLUG, 0);
    await migration.up(database);
    expect((await article()).content).toBe(once);
    expect(await events()).toHaveLength(1);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(1);
  });

  test('a line an admin edited keeps its edit; an article without 173000 text, a missing row or a missing table is a no-op', async () => {
    const edited = afterFirst().replace(FLAG.old, '- Our own rule for the cap.');
    await insert(edited);
    await migration.up(database);
    expect((await article()).content).toContain('- Our own rule for the cap.');
    expect((await article()).content).toContain(CERTAINTY.next);
    expect((await events())[0].metadata.changed).toHaveLength(1);
    await database('knowledge_base').del();
    await database('audit_log').del();
    await expect(migration.up(database)).resolves.toBeUndefined();
    await insert('# Celsius\n\nOur own notes.');
    await migration.up(database);
    expect(await events()).toHaveLength(0);
  });

  test('down restores exactly the 173000 lines, purges and audits; an edited new line stays; a repeat is a no-op', async () => {
    await insert();
    await migration.up(database);
    await chunk(SLUG, 0);
    await migration.down(database);
    expect((await article()).content).toBe(afterFirst());
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(0);
    expect(await events(AUDIT_DOWN)).toHaveLength(1);
    await migration.down(database);
    expect(await events(AUDIT_DOWN)).toHaveLength(1);
    await migration.up(database);
    await database('knowledge_base').where({ slug: SLUG }).update({ content: (await article()).content.replace(FLAG.next, '- Admin wording.') });
    await migration.down(database);
    const reverted = (await article()).content;
    expect(reverted).toContain('- Admin wording.');
    expect(reverted).toContain(CERTAINTY.old);
  });
});
