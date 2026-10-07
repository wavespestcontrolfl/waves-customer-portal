// The live staff knowledge-base article "Celsius WG — Application Limits" said "Max 3 Applications
// Per Property Per Year" and told techs to stop only after the 3rd. Under the v13 lawn program the
// limit is 2 per lawn per year (owner 2026-10-06), so 20261007173000 rewrites four seeded lines in
// place, purges the article's search chunks and audits it.
//
// The first block needs no database. The DB block self-skips without DATABASE_URL; its fixture rows
// live in a unique schema dropped after the suite.
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261007173000_lawn_v13_celsius_kb_article');

const SLUG = migration._KB_SLUG;
const REPLACEMENTS = migration._REPLACEMENTS;
const KEY_OLD = migration._KEY_OLD;
const AUDIT = migration._AUDIT_ACTION;
const AUDIT_DOWN = migration._AUDIT_ACTION_DOWN;

const seedScript = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'seed-knowledge-base.js'), 'utf8');
function seededArticleContent() {
  const start = seedScript.indexOf(`slug: '${SLUG}'`);
  const open = seedScript.indexOf('content: `', start) + 'content: `'.length;
  return seedScript.slice(open, seedScript.indexOf('`,', open));
}
// The article as 20260808000001 left it live: the OLD seeded lines (the new seed, reversed line by line).
const oldContent = () => REPLACEMENTS.reduceRight((content, row) => content.replace(row.next, () => row.old), seededArticleContent());

describe('the seed script and the migration agree (no database)', () => {
  test('the seed script carries the new text: both numbers, no plan for a third', () => {
    const content = seededArticleContent();
    expect(content).toContain(migration._V13_SENTENCE);
    for (const row of REPLACEMENTS) expect(content).toContain(row.next);
    expect(content).not.toMatch(/Max 3 Applications Per Property Per Year\n/);
    expect(content).not.toContain('approaching 3rd application');
  });

  test('every old line the migration matches is exactly the line the seed used to carry', () => {
    const old = oldContent();
    for (const row of REPLACEMENTS) expect(old).toContain(row.old);
    expect(old).toContain(KEY_OLD);
    expect(old).not.toContain(migration._V13_SENTENCE);
  });

  test('the new text states the label figure and the v13 figure, gate-neutral', () => {
    expect(migration._V13_SENTENCE).toBe('Label maximum: 3 applications per year per property. Waves lawn program (v13): max 2 applications per lawn per year — do not plan a third.');
  });
});

const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('20261007173000_lawn_v13_celsius_kb_article on PostgreSQL', () => {
  let database;
  const schema = `kb_celsius_${randomUUID().replaceAll('-', '')}`;
  const tables = ['knowledge_base', 'knowledge_embeddings', 'audit_log'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) {
      await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING DEFAULTS INCLUDING GENERATED)', [schema, table, table]);
    }
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const seedArticle = (content = oldContent(), overrides = {}) => database('knowledge_base').insert({
    id: randomUUID(),
    slug: SLUG,
    path: `kb/chemicals/${SLUG}.md`,
    title: 'Celsius WG — Application Limits',
    category: 'chemicals',
    content,
    tags: JSON.stringify(['celsius', 'herbicide']),
    confidence: 'high',
    last_verified_at: new Date('2026-08-08T00:00:00Z'),
    verified_by: 'seed',
    ...overrides,
  }).returning('*').then(([row]) => row);
  const seedChunk = (sourceId, chunkIndex = 0) => database('knowledge_embeddings').insert({
    source: 'kb', source_id: sourceId, chunk_index: chunkIndex, title: 't', content: 'old chunk text', content_hash: `${sourceId}-${chunkIndex}`,
    embedded_at: new Date(),
  });
  const article = () => database('knowledge_base').where({ slug: SLUG }).first();
  const events = (action = AUDIT) => database('audit_log').where({ action });

  test('rewrites the four seeded lines, keeps everything else, purges the article\'s chunks only, audits once', async () => {
    const row = await seedArticle();
    await seedChunk(SLUG, 0);
    await seedChunk(SLUG, 1);
    await seedChunk('some-other-article', 0);

    await migration.up(database);

    const after = await article();
    expect(after.content).toBe(seededArticleContent());
    expect(after.content).toContain(migration._V13_SENTENCE);
    expect(after.content).not.toContain('approaching 3rd application');
    expect(after.verified_by).toBe('migration-lawn-v13-celsius-kb-article');
    expect(after.title).toBe('Celsius WG — Application Limits');
    // The article's search chunks are gone (the next index sync re-chunks and re-embeds it); others stay.
    expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: SLUG })).toHaveLength(0);
    expect(await database('knowledge_embeddings').where({ source_id: 'some-other-article' })).toHaveLength(1);
    const logged = await events();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actor_type: 'system', resource_type: 'knowledge_base', resource_id: String(row.id) });
    expect(logged[0].metadata.changed).toHaveLength(4);
  });

  test('a second run changes nothing: no second audit event, chunks written since stay', async () => {
    await seedArticle();
    await migration.up(database);
    const once = await article();
    await seedChunk(SLUG, 0);
    await migration.up(database);
    expect((await article()).content).toBe(once.content);
    expect(await events()).toHaveLength(1);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(1);
  });

  test('an article an admin rewrote (the seeded restriction line is gone) is left alone: no write, no audit, chunks kept', async () => {
    const rewritten = '# Celsius WG\n\nOur own notes about Celsius.';
    await seedArticle(rewritten);
    await seedChunk(SLUG, 0);
    await migration.up(database);
    expect((await article()).content).toBe(rewritten);
    expect(await events()).toHaveLength(0);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(1);
  });

  test('a line an admin edited keeps its edit; the other seeded lines are still updated', async () => {
    const edited = oldContent().replace(REPLACEMENTS[3].old, '- Our own rule: never a third Celsius pass.');
    await seedArticle(edited);
    await migration.up(database);
    const after = (await article()).content;
    expect(after).toContain('- Our own rule: never a third Celsius pass.');
    expect(after).toContain(migration._V13_SENTENCE);
    expect(after).toContain(REPLACEMENTS[2].next);
    expect((await events())[0].metadata.changed).toHaveLength(3);
  });

  test('a missing article or a missing table is a no-op', async () => {
    await expect(migration.up(database)).resolves.toBeUndefined();
    expect(await events()).toHaveLength(0);
    await database.raw('DROP TABLE ??.??', [schema, 'knowledge_base']);
    await expect(migration.up(database)).resolves.toBeUndefined();
    await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING DEFAULTS INCLUDING GENERATED)', [schema, 'knowledge_base', 'knowledge_base']);
  });

  test('down puts the seeded lines back, purges the chunks again and audits; an edited new line is left as it is', async () => {
    await seedArticle();
    await migration.up(database);
    await seedChunk(SLUG, 0);
    await migration.down(database);
    expect((await article()).content).toBe(oldContent());
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(0);
    expect(await events(AUDIT_DOWN)).toHaveLength(1);
    await migration.down(database); // nothing left to revert
    expect(await events(AUDIT_DOWN)).toHaveLength(1);

    // Up again, then an admin edits one of the new lines: down leaves that line.
    await migration.up(database);
    const edited = (await article()).content.replace(REPLACEMENTS[3].next, '- Admin wording for the stop rule.');
    await database('knowledge_base').where({ slug: SLUG }).update({ content: edited });
    await migration.down(database);
    const reverted = (await article()).content;
    expect(reverted).toContain('- Admin wording for the stop rule.');
    expect(reverted).toContain(REPLACEMENTS[2].old);
    expect(reverted).not.toContain(migration._V13_SENTENCE);
  });

  test('down does not touch an article that never got the new text', async () => {
    const row = await seedArticle();
    await migration.down(database);
    expect((await article()).content).toBe(row.content);
    expect(await events(AUDIT_DOWN)).toHaveLength(0);
  });
});
