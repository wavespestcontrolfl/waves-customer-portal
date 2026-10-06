// Owner ruling 2026-10-06: the Recognition + Fusilade II KB article must not say
// the mix kills zoysiagrass (Syngenta FIFRA 2(ee) 2023-03-28 lists FL zoysia).
// 20261007110000_kb_bermuda_zoysia_2ee replaces that one line in place.
//
// The first block needs no database. The DB block self-skips without
// DATABASE_URL; CI's DB-gated pass runs it. Fixture rows live in a unique
// schema dropped after the suite.
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261007110000_kb_bermuda_zoysia_2ee');

const { _OLD_LINE: OLD_LINE, _NEW_LINES: NEW_LINES, _OLD_TITLE: OLD_TITLE, _NEW_TITLE: NEW_TITLE, _AUDIT_ACTION: AUDIT_ACTION } = migration;
const SLUG = 'fusilade-ii-bermuda-bahia-eradication';

const BEFORE_TEXT = '## Field rules\n- No mowing 7 days before OR after application.\n\n## Critical warnings\n';
const AFTER_TEXT = '\n- Bahiagrass is NOT in the 2026 Fusilade II weed table.\n- Single-MOA for bermuda: never exceed the 2-application season ceiling.\n';
const seededContent = `# Article\n\n${BEFORE_TEXT}${OLD_LINE}${AFTER_TEXT}`;

describe('kb-bermuda-zoysia-2ee source text', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

  test('the old line is exactly what 20260808000001 seeded, so the exact-line match can hit prod', () => {
    expect(read('server/models/migrations/20260808000001_fix_bermuda_protocol_kb_seed_product.js')).toContain(OLD_LINE);
    expect(read('server/models/migrations/20260808000001_fix_bermuda_protocol_kb_seed_product.js')).toContain(`title: '${OLD_TITLE}'`);
  });

  test('the seed script carries the corrected lines for fresh environments', () => {
    const seed = read('scripts/seed-knowledge-base.js');
    expect(seed).not.toContain(OLD_LINE);
    expect(seed).toContain(NEW_LINES);
    expect(seed).toContain(`title: '${NEW_TITLE}'`);
  });

  test('the new text names the 2(ee) rates, the not-a-label caveat and the solo-Fusilade injury', () => {
    expect(NEW_LINES).toContain('0.03–0.045 oz');
    expect(NEW_LINES).toContain('0.367–0.55 oz');
    expect(NEW_LINES).toContain('A 2(ee) is not the printed label');
    expect(NEW_LINES).toContain('Fusilade II ALONE injures zoysia');
    expect(NEW_LINES).not.toMatch(/AND zoysiagrass/);
  });

  test('down is a documented no-op', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});

const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('20261007110000_kb_bermuda_zoysia_2ee on PostgreSQL', () => {
  let database;
  const schema = `kb_zoysia_${randomUUID().replaceAll('-', '')}`;
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

  const seedArticle = (overrides = {}) => database('knowledge_base').insert({
    id: randomUUID(),
    slug: SLUG,
    path: `kb/chemicals/${SLUG}.md`,
    title: OLD_TITLE,
    category: 'chemicals',
    content: seededContent,
    tags: JSON.stringify(['fusilade', 'recognition', 'bermuda', 'st-augustine', 'tank-mix', '2ee']),
    confidence: 'high',
    last_verified_at: new Date('2026-08-08T00:00:00Z'),
    verified_by: 'migration-bermuda-tank-mix-protocol',
    ...overrides,
  }).returning('*').then(([row]) => row);
  const seedChunk = (sourceId, chunkIndex = 0) => database('knowledge_embeddings').insert({
    source: 'kb', source_id: sourceId, chunk_index: chunkIndex, title: 't', content: 'c', content_hash: `${sourceId}-${chunkIndex}`,
  });
  const article = () => database('knowledge_base').where({ slug: SLUG }).first();
  const events = () => database('audit_log').where({ action: AUDIT_ACTION });

  test('replaces only the wrong line, keeps the rest, fixes title and tags, purges chunks, audits once', async () => {
    const row = await seedArticle();
    await seedChunk(SLUG, 0);
    await seedChunk(SLUG, 1);
    await seedChunk('some-other-article', 0);

    await migration.up(database);

    const after = await article();
    expect(after.content).toBe(`# Article\n\n${BEFORE_TEXT}${NEW_LINES}${AFTER_TEXT}`);
    expect(after.content).not.toContain(OLD_LINE);
    expect(after.title).toBe(NEW_TITLE);
    expect(after.tags).toEqual(['fusilade', 'recognition', 'bermuda', 'st-augustine', 'tank-mix', '2ee', 'zoysia']);
    expect(after.verified_by).toBe('migration-kb-bermuda-zoysia-2ee');

    expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: SLUG })).toHaveLength(0);
    expect(await database('knowledge_embeddings').where({ source_id: 'some-other-article' })).toHaveLength(1);

    const logged = await events();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actor_type: 'system', resource_type: 'knowledge_base', resource_id: String(row.id) });
    expect(logged[0].metadata.before.line).toBe(OLD_LINE);
  });

  test('a second run changes nothing and writes no second audit event', async () => {
    await seedArticle();
    await migration.up(database);
    const once = await article();
    await seedChunk(SLUG, 0);

    await migration.up(database);

    const twice = await article();
    expect(twice.content).toBe(once.content);
    expect(twice.title).toBe(once.title);
    expect(twice.tags).toEqual(once.tags);
    expect(await events()).toHaveLength(1);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(1);
  });

  test('a row whose line an admin already edited is left alone (no write, no audit, chunks kept)', async () => {
    const edited = seededContent.replace(OLD_LINE, '- The mix kills bermudagrass; zoysia needs a test patch first.');
    await seedArticle({ content: edited });
    await seedChunk(SLUG, 0);

    await migration.up(database);

    const after = await article();
    expect(after.content).toBe(edited);
    expect(after.title).toBe(OLD_TITLE);
    expect(after.verified_by).toBe('migration-bermuda-tank-mix-protocol');
    expect(await events()).toHaveLength(0);
    expect(await database('knowledge_embeddings').where({ source_id: SLUG })).toHaveLength(1);
  });

  test('an admin-renamed title and extra tags survive; only missing tags are added', async () => {
    await seedArticle({
      title: 'Bermuda Tank Mix (admin title)',
      tags: JSON.stringify(['fusilade', 'zoysia', 'admin-tag']),
    });

    await migration.up(database);

    const after = await article();
    expect(after.title).toBe('Bermuda Tank Mix (admin title)');
    expect(after.tags).toEqual(['fusilade', 'zoysia', 'admin-tag', '2ee']);
    expect(after.content).toContain(NEW_LINES);
  });

  test('a missing article is a quiet no-op', async () => {
    await expect(migration.up(database)).resolves.toBeUndefined();
    expect(await events()).toHaveLength(0);
  });
});
