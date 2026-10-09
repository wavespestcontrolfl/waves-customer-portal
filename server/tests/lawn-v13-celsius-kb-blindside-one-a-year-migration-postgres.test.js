// 20261007176000 wrote "Blindside (also capped at 2 applications per lawn per year under v13)" into the live Celsius article.
// Blindside is held to one application a year at 0.149 oz, so 20261009152000 replaces that one statement. Same mechanism as 176000:
// an exact-text replacement, a person's edit left, the article's search chunks purged, one audit event; down puts the old text back.
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');

const afterCap = require('../models/migrations/20261007176000_lawn_v13_celsius_kb_after_cap');
const migration = require('../models/migrations/20261009152000_lawn_v13_celsius_kb_blindside_one_a_year');

const SLUG = migration._KB_SLUG;
const { _OLD: OLD, _NEXT: NEXT } = migration;
const AUDIT = migration._AUDIT_ACTION;
const AUDIT_DOWN = migration._AUDIT_ACTION_DOWN;
const seedScript = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'seed-knowledge-base.js'), 'utf8');

function seedArticle() {
  const start = seedScript.indexOf(`slug: '${SLUG}'`);
  const open = seedScript.indexOf('content: `', start) + 'content: `'.length;
  return seedScript.slice(open, seedScript.indexOf('`,', open));
}
// The article as 176000 left it.
const afterCapContent = () => seedArticle().replace(NEXT, () => OLD);

describe('the seed script and the migration agree (no database)', () => {
  test('the seed carries the one-a-year Blindside statement and no "capped at 2" for Blindside; the old text is exactly what 176000 wrote', () => {
    const content = seedArticle();
    expect(content).toContain(NEXT);
    expect(content).not.toContain(OLD);
    expect(content).not.toMatch(/Blindside \(also capped at 2/);
    expect(afterCap._REPLACEMENTS[0].next).toContain(OLD);
    expect(afterCapContent()).toContain(afterCap._REPLACEMENTS[0].next);
    expect(NEXT).toMatch(/1 application per lawn per year at 0\.149 oz per 1,000 sq ft; label: warm-season rate 0\.149 to 0\.23 oz a pass, no more than 0\.23 oz per 1,000 sq ft a year/);
  });

  test('176000\'s own down() skips the Flag line once this text is written (the full line no longer matches), and still reverses the Certainty line', () => {
    const [flag, certainty] = afterCap._REPLACEMENTS;
    const written = afterCapContent().replace(OLD, () => NEXT);
    expect(written.includes(flag.next)).toBe(false);
    expect(written.includes(certainty.next)).toBe(true);
  });
});

const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('20261009152000_lawn_v13_celsius_kb_blindside_one_a_year on PostgreSQL', () => {
  let database;
  const schema = `kb_one_a_year_${randomUUID().replaceAll('-', '')}`;
  const tables = ['knowledge_base', 'knowledge_embeddings', 'audit_log'];
  let log;
  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING DEFAULTS INCLUDING GENERATED)', [schema, table, table]);
  });
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(async () => { log.mockRestore(); for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]); });
  afterAll(async () => { await database.raw('DROP SCHEMA ?? CASCADE', [schema]); await database.destroy(); });

  const insert = (content = afterCapContent()) => database('knowledge_base').insert({
    id: randomUUID(), slug: SLUG, path: `kb/chemicals/${SLUG}.md`, title: 'Celsius WG — Application Limits', category: 'chemicals',
    content, tags: JSON.stringify(['celsius']), confidence: 'high', last_verified_at: new Date('2026-10-07T00:00:00Z'), verified_by: 'migration-lawn-v13-celsius-kb-after-cap',
  }).returning('*').then(([row]) => row);
  const chunk = (sourceId, index = 0) => database('knowledge_embeddings').insert({ source: 'kb', source_id: sourceId, chunk_index: index, title: 't', content: 'old chunk', content_hash: `${sourceId}-${index}`, embedded_at: new Date() });
  const article = () => database('knowledge_base').where({ slug: SLUG }).first();
  const events = (action = AUDIT) => database('audit_log').where({ action });

  test('replaces only the Blindside statement, keeps the rest, purges only this article\'s chunks, audits once', async () => {
    const row = await insert();
    await chunk(SLUG, 0); await chunk(SLUG, 1); await chunk('other-article', 0);
    await migration.up(database);
    expect((await article()).content).toBe(seedArticle());
    expect((await article()).verified_by).toBe('migration-lawn-v13-celsius-kb-blindside-one-a-year');
    expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: SLUG })).toHaveLength(0);
    expect(await database('knowledge_embeddings').where({ source_id: 'other-article' })).toHaveLength(1);
    const logged = await events();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ resource_id: String(row.id) });
    expect(logged[0].metadata.changed).toEqual([{ before: OLD, after: NEXT }]);
  });

  test('a second run changes nothing and does not purge or audit again', async () => {
    await insert();
    await migration.up(database);
    const once = (await article()).content;
    await chunk(SLUG, 0);
    await migration.up(database);
    expect((await article()).content).toBe(once);
    expect(await events()).toHaveLength(1);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(1);
  });

  test('a line a person edited keeps its edit and is logged; a missing article, an article without the line and a missing table are no-ops', async () => {
    const edited = afterCapContent().replace(OLD, 'use Blindside as our own notes say');
    await insert(edited);
    await migration.up(database);
    expect((await article()).content).toBe(edited);
    expect(await events()).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('article left as it is'));
    await database('knowledge_base').del();
    await expect(migration.up(database)).resolves.toBeUndefined();
    await insert('# Celsius\n\nOur own notes.');
    await migration.up(database);
    expect(await events()).toHaveLength(0);
  });

  test('down restores exactly the 176000 text, purges and audits; a repeat is a no-op; an edited new text stays and is logged', async () => {
    await insert();
    await migration.up(database);
    await chunk(SLUG, 0);
    await migration.down(database);
    expect((await article()).content).toBe(afterCapContent());
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(0);
    expect(await events(AUDIT_DOWN)).toHaveLength(1);
    await migration.down(database);
    expect(await events(AUDIT_DOWN)).toHaveLength(1);
    await migration.up(database);
    await database('knowledge_base').where({ slug: SLUG }).update({ content: (await article()).content.replace(NEXT, 'use our own wording') });
    await migration.down(database);
    expect((await article()).content).toContain('use our own wording');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the new Blindside statement is gone'));
  });

  test('176000\'s down() after this write: the Flag line stays corrected (skipped), the Certainty line goes back to the 173000 text', async () => {
    await insert();
    await migration.up(database);
    await afterCap.down(database);
    const content = (await article()).content;
    expect(content).toContain(NEXT);
    expect(content).toContain(afterCap._REPLACEMENTS[1].old);
    expect(content).not.toContain(afterCap._REPLACEMENTS[1].next);
  });
});
