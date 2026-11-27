// Sync the two live dispatch wiki articles in `knowledge_base` (and purge stale
// `knowledge_embeddings` chunks) to match the 2026-11-26 staffing-days and
// pest-overflow updates in `wiki/techs/technician-profiles.md` and
// `wiki/protocols/routing-rules.md`.
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261128140000_wiki_dispatch_staffing_days');

const { _ARTICLES: ARTICLES, _AUDIT_ACTION: AUDIT, _AUDIT_ACTION_DOWN: AUDIT_DOWN } = migration;
const REPO_ROOT = path.join(__dirname, '..', '..');

function readWiki(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function beforeContent(article) {
  let text = readWiki(article.path);
  for (const r of article.replacements) {
    text = text.replace(r.next, () => r.old);
  }
  return text;
}

describe('wiki files and 20261128140000_wiki_dispatch_staffing_days agree (no database)', () => {
  test('both wiki files on disk carry the new wording, omit the superseded lines, and round-trip cleanly', () => {
    for (const article of ARTICLES) {
      const disk = readWiki(article.path);
      for (const r of article.replacements) {
        expect(disk).toContain(r.next);
        expect(disk).not.toContain(r.old);
      }
      const prior = beforeContent(article);
      expect(prior).not.toBe(disk);
      let rebuilt = prior;
      for (const r of article.replacements) {
        expect(rebuilt).toContain(r.old);
        rebuilt = rebuilt.replace(r.old, () => r.next);
      }
      expect(rebuilt).toBe(disk);
    }
  });

  test('technician-readable routing-rules.md keeps coworker weekly capacity numbers and admin-only techs links out', () => {
    const routing = readWiki('wiki/protocols/routing-rules.md');
    expect(routing).not.toContain('wiki/techs/');
    expect(routing).not.toContain('technician-profiles');
    expect(routing).not.toMatch(/\b48\b/);
    expect(routing).not.toMatch(/60\s+total\s+stops|60\s+stops/i);
  });

  test('technician-profiles.md distinguishes Adam total capacity from pest overflow and states the 2026-11-26 schedule', () => {
    const profiles = readWiki('wiki/techs/technician-profiles.md');
    expect(profiles).toContain('Wed–Sun, Mon–Tue off');
    expect(profiles).toContain('4 days a week, Mon–Thu');
    expect(profiles).toContain('~60 total stops/week across all of Adam\'s service lines');
    expect(profiles).toContain('48-stop weekly target');
    expect(profiles).toContain('within his remaining weekly capacity');
  });
});

const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('20261128140000_wiki_dispatch_staffing_days on PostgreSQL', () => {
  let database;
  const schema = `kb_wiki_staffing_${randomUUID().replaceAll('-', '')}`;
  const tables = ['knowledge_base', 'knowledge_embeddings', 'audit_log'];
  let log;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) {
      await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING DEFAULTS INCLUDING GENERATED)', [schema, table, table]);
    }
  });

  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(async () => {
    log.mockRestore();
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const insertArticle = (article, { content = beforeContent(article), slug = article.slug, articlePath = article.path } = {}) =>
    database('knowledge_base').insert({
      id: randomUUID(),
      path: articlePath,
      slug,
      title: article.path,
      category: article.path.includes('/techs/') ? 'operations' : 'protocols',
      content,
      tags: JSON.stringify(['dispatch']),
      confidence: 'high',
      last_verified_at: new Date('2026-11-24T00:00:00Z'),
      verified_by: 'wiki-import',
    }).returning('*').then(([row]) => row);

  const insertChunk = (source, sourceId, content, index = 0) =>
    database('knowledge_embeddings').insert({
      source,
      source_id: sourceId,
      chunk_index: index,
      title: sourceId,
      content,
      content_hash: `${source}-${sourceId}-${index}`,
      embedded_at: new Date(),
    });

  const byPath = (articlePath) => database('knowledge_base').where({ path: articlePath }).first();
  const events = (action = AUDIT) => database('audit_log').where({ action });

  test('updates both articles, preserves unrelated Q&A edits, purges matching kb and stale ops_rule chunks, and audits once per article', async () => {
    const qaNote = '\n\n---\n## Q&A (filed 11/25/2026)\n**Q:** Custom staff note?\n\n**A:** Keep this intact.';
    const rows = [];
    for (const article of ARTICLES) {
      rows.push(await insertArticle(article, { content: beforeContent(article) + qaNote }));
      await insertChunk('kb', article.slug, 'old kb chunk', 0);
      await insertChunk('ops_rule', article.opsRuleSourceId, beforeContent(article), 0);
    }
    await insertChunk('kb', 'unrelated-article', 'keep kb chunk', 0);
    await insertChunk('ops_rule', 'protocols/job-scoring.md', 'keep ops chunk', 0);

    await migration.up(database);

    for (const article of ARTICLES) {
      const updated = await byPath(article.path);
      expect(updated.content).toBe(readWiki(article.path) + qaNote);
      expect(updated.verified_by).toBe('migration-wiki-dispatch-staffing-days');
      expect(updated.word_count).toBeGreaterThan(0);
      expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: article.slug })).toHaveLength(0);
      expect(await database('knowledge_embeddings').where({ source: 'ops_rule', source_id: article.opsRuleSourceId })).toHaveLength(0);
    }
    expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: 'unrelated-article' })).toHaveLength(1);
    expect(await database('knowledge_embeddings').where({ source: 'ops_rule', source_id: 'protocols/job-scoring.md' })).toHaveLength(1);

    const logged = await events();
    expect(logged).toHaveLength(ARTICLES.length);
    expect(logged.map((e) => e.resource_id).sort()).toEqual(rows.map((r) => String(r.id)).sort());
  });

  test('a second up() run is a no-op and leaves freshly rebuilt embeddings and audit log untouched', async () => {
    for (const article of ARTICLES) await insertArticle(article);
    await migration.up(database);
    for (const article of ARTICLES) {
      await insertChunk('kb', article.slug, readWiki(article.path), 0);
      await insertChunk('ops_rule', article.opsRuleSourceId, readWiki(article.path), 0);
    }
    await migration.up(database);
    expect(await events()).toHaveLength(ARTICLES.length);
    for (const article of ARTICLES) {
      expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: article.slug })).toHaveLength(1);
      expect(await database('knowledge_embeddings').where({ source: 'ops_rule', source_id: article.opsRuleSourceId })).toHaveLength(1);
    }
  });

  test('preserves manual human edits on targeted lines and handles missing articles gracefully', async () => {
    const [profiles, routing] = ARTICLES;
    const customProfiles = beforeContent(profiles).replace(profiles.replacements[0].old, 'Custom owner dispatch wording.');
    await insertArticle(profiles, { content: customProfiles });
    await migration.up(database);

    const updated = await byPath(profiles.path);
    expect(updated.content).toContain('Custom owner dispatch wording.');
    expect(updated.content).toContain(profiles.replacements[1].next);
    expect(updated.content).toContain(profiles.replacements[2].next);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('line left as it is'));
    expect(await byPath(routing.path)).toBeUndefined();
    expect(await events()).toHaveLength(1);
  });

  test('matches rows by path even with a legacy slug and purges that row\'s actual slug chunks', async () => {
    const [profiles] = ARTICLES;
    await insertArticle(profiles, { slug: 'adam-benetti-technician-profile' });
    await insertChunk('kb', 'adam-benetti-technician-profile', 'legacy slug chunk', 0);

    await migration.up(database);

    expect((await byPath(profiles.path)).content).toBe(readWiki(profiles.path));
    expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: 'adam-benetti-technician-profile' })).toHaveLength(0);
  });

  test('down() restores prior text, preserves unrelated edits, purges chunks, audits once, and skips manually edited new lines', async () => {
    const qaNote = '\n\n---\n## Q&A\nKeep me.';
    for (const article of ARTICLES) {
      await insertArticle(article, { content: beforeContent(article) + qaNote });
    }
    await migration.up(database);
    for (const article of ARTICLES) {
      await insertChunk('kb', article.slug, readWiki(article.path), 0);
      await insertChunk('ops_rule', article.opsRuleSourceId, readWiki(article.path), 0);
    }

    await migration.down(database);

    for (const article of ARTICLES) {
      expect((await byPath(article.path)).content).toBe(beforeContent(article) + qaNote);
      expect(await database('knowledge_embeddings').where({ source: 'kb', source_id: article.slug })).toHaveLength(0);
      expect(await database('knowledge_embeddings').where({ source: 'ops_rule', source_id: article.opsRuleSourceId })).toHaveLength(0);
    }
    expect(await events(AUDIT_DOWN)).toHaveLength(ARTICLES.length);

    // Repeat down() is a no-op
    await migration.down(database);
    expect(await events(AUDIT_DOWN)).toHaveLength(ARTICLES.length);

    // Manual edit after up() is preserved on down()
    await migration.up(database);
    const [, routing] = ARTICLES;
    await database('knowledge_base').where({ path: routing.path }).update({
      content: (await byPath(routing.path)).content.replace(routing.replacements[0].next, '- **Adam:** custom human rule.'),
    });
    await migration.down(database);
    expect((await byPath(routing.path)).content).toContain('- **Adam:** custom human rule.');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('line left as it is'));
  });
});
