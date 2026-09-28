// Real migrated PostgreSQL, synthetic facts, rolled back after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
//
// The email-division fact register syncs its code data into knowledge_base.
// These tests pin the contract against the real table: insert-once with an
// audit row, update only an untouched row, hold (never overwrite) a row a
// person edited with exactly one hold audit, retire an expired or withdrawn
// fact, leave a foreign row under the same slug alone.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
const { randomUUID } = require('node:crypto');
const { syncFactRegister, SOURCE, _internals } = require('../services/email-division/fact-register');

postgres('email-division fact register sync against migrated PostgreSQL', () => {
  let database;
  let trx;
  let uid;
  const now = new Date('2026-09-28T12:00:00Z');

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    uid = randomUUID().slice(0, 8);
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  function fact(n, extra = {}) {
    return {
      slug: `fact-synthetic-${uid}-${n}`,
      title: `Synthetic fact ${n}`,
      tags: ['synthetic', `n${n}`],
      sourceUrls: [`https://example.invalid/source/${n}`],
      quote: `"Quoted source text ${n}."`,
      content: `Plain words for fact ${n}. The source states nothing else.`,
      ...extra,
    };
  }
  const sync = (facts, extra = {}) => syncFactRegister({ conn: trx, now, facts, retireStrays: false, ...extra });
  const rowOf = (slug) => trx('knowledge_base').where({ slug }).first();
  const audits = (id, action) => trx('audit_log').where({ resource_type: 'knowledge_base', resource_id: id, action }).orderBy('created_at', 'asc');

  test('first sync inserts every fact with its provenance and an audit row; the second sync changes nothing', async () => {
    const facts = [fact(1), fact(2)];
    const first = await sync(facts);
    expect(first.inserted.sort()).toEqual(facts.map((f) => f.slug).sort());
    expect(first.errors).toEqual([]);

    const row = await rowOf(facts[0].slug);
    expect(row).toMatchObject({
      category: 'facts', source: SOURCE, verified_by: SOURCE, status: 'active', active: true, version: 1,
      title: facts[0].title, summary: facts[0].quote, content: facts[0].content, confidence: 'high',
    });
    expect(row.tags).toEqual(facts[0].tags);
    expect(row.metadata).toMatchObject({
      source_url: facts[0].sourceUrls[0], source_urls: facts[0].sourceUrls, quote: facts[0].quote,
      register_hash: _internals.factFingerprint(facts[0]), derived: false, expires_on: null,
    });
    expect(row.path).toBe(`kb/facts/${facts[0].slug}.md`);
    expect(await audits(row.id, 'knowledge_base.fact_seeded')).toHaveLength(1);

    const second = await sync(facts);
    expect(second.inserted).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.sort()).toEqual(facts.map((f) => f.slug).sort());
    expect(await audits(row.id, 'knowledge_base.fact_seeded')).toHaveLength(1);
    expect((await rowOf(facts[0].slug)).version).toBe(1);
  });

  test('a row a person edited is held, never overwritten, with exactly one hold audit across repeated runs', async () => {
    const facts = [fact(1)];
    await sync(facts);
    const before = await rowOf(facts[0].slug);
    await trx('knowledge_base').where({ id: before.id }).update({ content: 'A person corrected this.', updated_at: new Date() });

    const shippedChange = [{ ...facts[0], content: 'The register now says something new.' }];
    const r1 = await sync(shippedChange);
    expect(r1.held).toEqual([{ slug: facts[0].slug, reason: 'edited_by_person' }]);
    expect(r1.updated).toEqual([]);
    const after = await rowOf(facts[0].slug);
    expect(after.content).toBe('A person corrected this.');
    expect(after.version).toBe(1);

    await sync(shippedChange);
    await sync(shippedChange);
    const holds = await audits(before.id, 'knowledge_base.fact_sync_held');
    expect(holds).toHaveLength(1);
    expect(holds[0].metadata).toMatchObject({
      slug: facts[0].slug, reason: 'edited_by_person',
      shipped_hash: _internals.factFingerprint(shippedChange[0]), row_hash: _internals.rowFingerprint(after),
    });

    // A further register change is a new situation: one more hold audit.
    await sync([{ ...facts[0], content: 'The register changed again.' }]);
    expect(await audits(before.id, 'knowledge_base.fact_sync_held')).toHaveLength(2);
  });

  test('an untouched row is updated when the register content changes: version bumps, hash restamped, audit written', async () => {
    const facts = [fact(1)];
    await sync(facts);
    const before = await rowOf(facts[0].slug);

    const changed = [{ ...facts[0], content: 'Corrected wording from the source.', tags: ['synthetic', 'corrected'] }];
    const r = await sync(changed);
    expect(r.updated).toEqual([facts[0].slug]);
    const after = await rowOf(facts[0].slug);
    expect(after.content).toBe('Corrected wording from the source.');
    expect(after.tags).toEqual(['synthetic', 'corrected']);
    expect(after.version).toBe(2);
    expect(after.metadata.register_hash).toBe(_internals.factFingerprint(changed[0]));
    expect(after.status).toBe('active');
    const updates = await audits(before.id, 'knowledge_base.fact_updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].metadata).toMatchObject({ legacy_row: false, previous_hash: before.metadata.register_hash });

    // and a person's later edit to the NEW content is again held
    await trx('knowledge_base').where({ id: before.id }).update({ title: 'Renamed by a person' });
    const r2 = await sync([{ ...changed[0], content: 'Another register change.' }]);
    expect(r2.held).toHaveLength(1);
    expect((await rowOf(facts[0].slug)).content).toBe('Corrected wording from the source.');
  });

  test.each([
    ['the weekly AI audit', 'ai-review', 'ai-cron'],
    ['a person', 'manual-flag', 'waves'],
  ])('a flag set by %s survives a wording update — the knowledge base\'s content-change trigger does not lift it for register rows', async (_who, auditType, auditedBy) => {
    const facts = [fact(1)];
    await sync(facts);
    const before = await rowOf(facts[0].slug);
    // A real flag: the audit row that makes kb_restore_ai_flag_on_content_change
    // treat the flag as AI-owned (for 'ai-review'), then the status itself.
    await trx('knowledge_base_audits').insert({
      kb_entry_id: before.id, audit_type: auditType, result: 'flagged', findings: 'synthetic doubt', audited_by: auditedBy,
    });
    await trx('knowledge_base').where({ id: before.id }).update({ status: 'flagged' });

    const r = await sync([{ ...facts[0], content: 'New wording from the source.' }]);
    expect(r.updated).toEqual([facts[0].slug]);
    const after = await rowOf(facts[0].slug);
    expect(after.content).toBe('New wording from the source.');
    expect(after.status).toBe('flagged');
    expect(after.version).toBe(2);
    // …and the row still carries exactly what the register wrote (a plain
    // row edited the same way by the KB's own writers WOULD be un-hidden).
    expect(_internals.rowFingerprint(after)).toBe(after.metadata.register_hash);
  });

  test('control: the knowledge base\'s trigger does un-hide a NON-register AI-flagged row on a content change (so the test above is not vacuous)', async () => {
    const slug = fact(7).slug;
    const [row] = await trx('knowledge_base').insert({
      path: `kb/manual/${slug}.md`, slug, title: 'Plain entry', category: 'facts', content: 'old', summary: 'x',
      tags: JSON.stringify([]), source: 'manual', status: 'active', active: true, version: 1, metadata: JSON.stringify({}),
    }).returning(['id']);
    await trx('knowledge_base_audits').insert({ kb_entry_id: row.id, audit_type: 'ai-review', result: 'flagged', findings: 'doubt', audited_by: 'ai-cron' });
    await trx('knowledge_base').where({ id: row.id }).update({ status: 'flagged' });
    await trx('knowledge_base').where({ id: row.id }).update({ content: 'new' });
    expect((await rowOf(slug)).status).toBe('active');
  });

  test('the knowledge-base audit\'s verified_by stamp is not an edit: the row stays unchanged for the sync and keeps its provenance', async () => {
    const facts = [fact(1)];
    await sync(facts);
    const before = await rowOf(facts[0].slug);
    await trx('knowledge_base').where({ id: before.id }).update({ verified_by: 'ai-cron', last_verified_at: new Date(), confidence: 'high' });

    const r = await sync(facts);
    expect(r.unchanged).toEqual([facts[0].slug]);
    expect(r.held).toEqual([]);
    const after = await rowOf(facts[0].slug);
    expect(after.verified_by).toBe('ai-cron');
    expect(after.version).toBe(1);
    expect(_internals.rowFingerprint(after)).toBe(after.metadata.register_hash); // the stamp still matches: not an edit
  });

  test('a person\'s reclassification of a register fact survives a wording update (codex round 14 P2)', async () => {
    const facts = [fact(1)];
    await sync(facts);
    await trx('knowledge_base').where({ slug: facts[0].slug }).update({ category: 'lawn-care' });
    const r = await sync([{ ...facts[0], content: `${facts[0].content} Reworded once more.` }]);
    expect(r.updated).toEqual([facts[0].slug]);
    expect(r.held).toEqual([]);
    const after = await rowOf(facts[0].slug);
    expect(after.category).toBe('lawn-care');
    expect(after.content).toContain('Reworded once more.');
    // (that the writer still lists it is the unit test's where-clause assertion:
    // listFacts selects register rows by source, not category)
  });

  test('a wording update drops the fact\'s hybrid-index chunks at once; a metadata-only restamp keeps them (codex round 13 P2)', async () => {
    const facts = [fact(1)];
    await sync(facts);
    const chunk = {
      source: 'kb', source_id: facts[0].slug, chunk_index: 0, title: facts[0].title, content: facts[0].content,
      content_hash: 'synthetic-hash', metadata: JSON.stringify({ category: 'facts' }),
    };
    await trx('knowledge_embeddings').insert(chunk);
    const reworded = [{ ...facts[0], content: `${facts[0].content} One more sentence.` }];
    const r = await sync(reworded);
    expect(r.updated).toEqual([facts[0].slug]);
    // the superseded wording is no longer retrievable through the index
    expect(await trx('knowledge_embeddings').where({ source: 'kb', source_id: facts[0].slug })).toHaveLength(0);

    await trx('knowledge_embeddings').insert({ ...chunk, content: reworded[0].content });
    const r2 = await sync([{ ...reworded[0], expiresOn: '2027-06-30' }]);
    expect(r2.updated).toEqual([facts[0].slug]);
    expect(await trx('knowledge_embeddings').where({ source: 'kb', source_id: facts[0].slug })).toHaveLength(1);
  });

  test('an expired fact retires its untouched row once (active=false + status archived, so shared search drops it), and is never seeded fresh', async () => {
    const facts = [fact(1)];
    await sync(facts);
    const before = await rowOf(facts[0].slug);
    // The hybrid index has chunked this fact; retirement must drop those chunks now.
    await trx('knowledge_embeddings').insert({
      source: 'kb', source_id: facts[0].slug, chunk_index: 0, title: facts[0].title, content: facts[0].content,
      content_hash: 'synthetic-hash', metadata: JSON.stringify({ category: 'facts' }),
    });

    const expired = [{ ...facts[0], expiresOn: '2026-09-28' }];
    const r = await sync(expired);
    expect(r.retired).toEqual([facts[0].slug]);
    const after = await rowOf(facts[0].slug);
    expect(after.active).toBe(false);
    expect(after.status).toBe('archived');
    expect(after.metadata).toMatchObject({ retired_on: '2026-09-28', retired_reason: 'expired', status_before_retire: 'active' });
    expect(await audits(before.id, 'knowledge_base.fact_retired')).toHaveLength(1);
    expect(await trx('knowledge_embeddings').where({ source: 'kb', source_id: facts[0].slug })).toHaveLength(0);
    // The shared knowledge-base search reads status: the retired fact is gone
    // from it. (search_vector covers title + content; the title carries
    // "Synthetic", and the still-live second fact proves the search works.)
    const KnowledgeBase = require('../services/knowledge-base');
    const hits = await KnowledgeBase.search('Synthetic', { category: 'facts', limit: 50 });
    expect(hits.map((h) => h.slug)).not.toContain(facts[0].slug);
    await sync([fact(2)]);
    const hitsAfter = await KnowledgeBase.search('Synthetic', { category: 'facts', limit: 50 });
    expect(hitsAfter.map((h) => h.slug)).toContain(fact(2).slug);

    const again = await sync(expired);
    expect(again.retired).toEqual([]);
    expect(again.unchanged).toEqual([facts[0].slug]);

    const fresh = await sync([fact(9, { expiresOn: '2026-01-01' })]);
    expect(fresh.skipped).toEqual([{ slug: fact(9).slug, reason: 'expired_never_seeded' }]);
    expect(await rowOf(fact(9).slug)).toBeUndefined();
  });

  test('an expiry-only change reaches the row, and an extended expiry brings a retired fact back without its retirement stamps', async () => {
    const f = fact(1, { expiresOn: '2026-09-20' });
    // Seed it live (before its expiry), then let it expire and retire.
    await syncFactRegister({ conn: trx, now: new Date('2026-09-01T12:00:00Z'), facts: [f], retireStrays: false });
    const retired = await sync([f]);
    expect(retired.retired).toEqual([f.slug]);
    expect((await rowOf(f.slug)).active).toBe(false);

    // The notice is extended: same wording, later expiry.
    const extended = { ...f, expiresOn: '2026-12-01' };
    const r = await sync([extended]);
    expect(r.updated).toEqual([f.slug]);
    const back = await rowOf(f.slug);
    expect(back.active).toBe(true);
    expect(back.status).toBe('active');
    expect(back.metadata.expires_on).toBe('2026-12-01');
    expect(back.metadata.retired_on).toBeUndefined();
    expect(back.metadata.retired_reason).toBeUndefined();
    expect(back.metadata.status_before_retire).toBeUndefined();
    expect(back.metadata.register_hash).toBe(_internals.factFingerprint(extended));
    const updates = await audits(back.id, 'knowledge_base.fact_updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].metadata).toMatchObject({ reactivated: true, metadata_only: true });

    // A further expiry-only change on the live row updates metadata again; an identical run is a no-op.
    const r2 = await sync([{ ...extended, expiresOn: '2027-01-01' }]);
    expect(r2.updated).toEqual([f.slug]);
    expect((await rowOf(f.slug)).metadata.expires_on).toBe('2027-01-01');
    const r3 = await sync([{ ...extended, expiresOn: '2027-01-01' }]);
    expect(r3.unchanged).toEqual([f.slug]);
  });

  test('retirement preserves a flag across the round trip, and never overrides a status a person set while the fact was retired', async () => {
    const flaggedFact = fact(1, { expiresOn: '2026-09-20' });
    const touchedFact = fact(2, { expiresOn: '2026-09-20' });
    await syncFactRegister({ conn: trx, now: new Date('2026-09-01T12:00:00Z'), facts: [flaggedFact, touchedFact], retireStrays: false });
    await trx('knowledge_base').where({ slug: flaggedFact.slug }).update({ status: 'flagged' });

    await sync([flaggedFact, touchedFact]); // both expire → archived
    expect((await rowOf(flaggedFact.slug))).toMatchObject({ active: false, status: 'archived' });
    expect((await rowOf(flaggedFact.slug)).metadata.status_before_retire).toBe('flagged');
    // A person re-opens the second one by hand while it is retired.
    await trx('knowledge_base').where({ slug: touchedFact.slug }).update({ status: 'active' });

    const extended = [{ ...flaggedFact, expiresOn: '2027-01-01' }, { ...touchedFact, expiresOn: '2027-01-01' }];
    const r = await sync(extended);
    expect(r.updated.sort()).toEqual([flaggedFact.slug, touchedFact.slug].sort());
    expect(await rowOf(flaggedFact.slug)).toMatchObject({ active: true, status: 'flagged' });
    expect(await rowOf(touchedFact.slug)).toMatchObject({ active: true, status: 'active' });
  });

  test('a register row whose slug left the register is retired; a foreign row under a register slug is held untouched', async () => {
    const facts = [fact(1), fact(2)];
    await sync(facts);
    const foreignSlug = fact(3).slug;
    await trx('knowledge_base').insert({
      path: `kb/manual/${foreignSlug}.md`, slug: foreignSlug, title: 'A person wrote this', category: 'facts',
      content: 'Not the register\'s.', summary: 'manual', tags: JSON.stringify(['manual']), source: 'manual',
      status: 'active', active: true, version: 1, metadata: JSON.stringify({}),
    });

    // Register now carries only fact 2 and a fact 3 that collides with the manual row.
    const r = await sync([fact(2), fact(3)], { retireStrays: true });
    expect(r.held).toEqual([{ slug: foreignSlug, reason: 'foreign_row' }]);
    const foreign = await rowOf(foreignSlug);
    expect(foreign).toMatchObject({ source: 'manual', title: 'A person wrote this', active: true });
    expect(r.retired).toContain(facts[0].slug);
    const stray = await rowOf(facts[0].slug);
    expect(stray.active).toBe(false);
    expect(stray.status).toBe('archived');
    expect(stray.metadata).toMatchObject({ retired_reason: 'withdrawn_from_register' });
    expect(await audits(stray.id, 'knowledge_base.fact_retired')).toHaveLength(1);
    expect((await rowOf(facts[1].slug)).active).toBe(true);
  });

  test('a withdrawn fact a person had deactivated is archived too, and stays off when the fact returns', async () => {
    const facts = [fact(1), fact(2)];
    await sync(facts);
    await trx('knowledge_base').where({ slug: facts[0].slug }).update({ active: false });

    const r = await sync([fact(2)], { retireStrays: true });
    expect(r.retired).toContain(facts[0].slug);
    const archived = await rowOf(facts[0].slug);
    expect(archived).toMatchObject({ active: false, status: 'archived' });
    expect(archived.metadata).toMatchObject({ retired_reason: 'withdrawn_from_register', deactivated_by_person: true });

    // The fact comes back into the register: the person's deactivation holds.
    const back = await sync(facts);
    expect(back.held).toEqual([{ slug: facts[0].slug, reason: 'deactivated_by_person' }]);
    expect((await rowOf(facts[0].slug)).active).toBe(false);
  });

  test('an edited row whose fact expires is archived with the edit intact', async () => {
    const f = fact(1, { expiresOn: '2026-09-20' });
    await syncFactRegister({ conn: trx, now: new Date('2026-09-01T12:00:00Z'), facts: [f], retireStrays: false });
    await trx('knowledge_base').where({ slug: f.slug }).update({ content: 'A person corrected this.' });

    const r = await sync([f]);
    expect(r.retired).toEqual([f.slug]);
    const row = await rowOf(f.slug);
    expect(row).toMatchObject({ active: false, status: 'archived', content: 'A person corrected this.' });
  });

  test('a withdrawn fact a person had EDITED is archived with the edit intact', async () => {
    const facts = [fact(1), fact(2)];
    await sync(facts);
    await trx('knowledge_base').where({ slug: facts[0].slug }).update({ content: 'A person corrected this.' });
    const r = await sync([fact(2)], { retireStrays: true });
    expect(r.retired).toContain(facts[0].slug);
    expect(await rowOf(facts[0].slug)).toMatchObject({ active: false, status: 'archived', content: 'A person corrected this.' });
  });

  test('a withdrawn fact a person had RE-FILED under another category is archived, category kept (codex round 11 P2)', async () => {
    const facts = [fact(1), fact(2)];
    await sync(facts);
    await trx('knowledge_base').where({ slug: facts[0].slug }).update({ category: 'lawn-care' });

    const r = await sync([fact(2)], { retireStrays: true });
    expect(r.retired).toContain(facts[0].slug);
    const row = await rowOf(facts[0].slug);
    expect(row).toMatchObject({ active: false, status: 'archived', category: 'lawn-care', source: SOURCE });
    expect(row.metadata).toMatchObject({ retired_reason: 'withdrawn_from_register' });
  });

  test('a legacy register row (no register_hash, from the pre-fingerprint seeds) is brought under management', async () => {
    const f = fact(1);
    const [legacy] = await trx('knowledge_base').insert({
      path: `kb/facts/${f.slug}.md`, slug: f.slug, title: 'Old seed title', category: 'facts',
      content: 'Retailer-sourced content from the first seed.', summary: 'old quote', tags: JSON.stringify(['old']),
      source: SOURCE, confidence: 'high', status: 'active', active: true, version: 1, verified_by: SOURCE,
      metadata: JSON.stringify({ source_url: 'https://www.domyown.com/x', quote: 'old quote', verified_on: '2026-09-27' }),
    }).returning(['id']);

    const r = await sync([f]);
    expect(r.updated).toEqual([f.slug]);
    const after = await rowOf(f.slug);
    expect(after).toMatchObject({ title: f.title, content: f.content, summary: f.quote, version: 2 });
    expect(after.metadata).toMatchObject({ source_url: f.sourceUrls[0], register_hash: _internals.factFingerprint(f) });
    const updates = await audits(legacy.id, 'knowledge_base.fact_updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].metadata).toMatchObject({ legacy_row: true });
  });

  test('a fact a person DELETED is not put back: held as deleted_by_person, audited once', async () => {
    const f = fact(1);
    await sync([f]);
    const before = await rowOf(f.slug);
    await trx('knowledge_base_audits').where({ kb_entry_id: before.id }).del();
    await trx('knowledge_base').where({ id: before.id }).del();

    const r1 = await sync([f]);
    expect(r1.held).toEqual([{ slug: f.slug, reason: 'deleted_by_person' }]);
    expect(r1.inserted).toEqual([]);
    expect(await rowOf(f.slug)).toBeUndefined();
    await sync([f]);
    const holds = await trx('audit_log').where({ action: 'knowledge_base.fact_sync_held' }).whereNull('resource_id')
      .whereRaw("metadata->>'slug' = ?", [f.slug]);
    expect(holds).toHaveLength(1);
  });

  test('a row a person DEACTIVATED (active=false, no retirement stamp) is held, never switched back on', async () => {
    const f = fact(1);
    await sync([f]);
    await trx('knowledge_base').where({ slug: f.slug }).update({ active: false });

    const r = await sync([f]);
    expect(r.held).toEqual([{ slug: f.slug, reason: 'deactivated_by_person' }]);
    expect((await rowOf(f.slug)).active).toBe(false);
  });

  test('an edit that landed on exactly the register\'s new wording converges: restamped as a metadata-only update, not held forever', async () => {
    const f = fact(1);
    await sync([f]);
    const before = await rowOf(f.slug);
    // A person corrects the row; the register later adopts the same words.
    await trx('knowledge_base').where({ id: before.id }).update({ content: 'The corrected sentence.' });
    const adopted = { ...f, content: 'The corrected sentence.' };
    const r = await sync([adopted]);
    expect(r.updated).toEqual([f.slug]);
    expect(r.held).toEqual([]);
    const after = await rowOf(f.slug);
    expect(after.content).toBe('The corrected sentence.');
    expect(after.metadata.register_hash).toBe(_internals.factFingerprint(adopted));
    const updates = await audits(before.id, 'knowledge_base.fact_updated');
    expect(updates[updates.length - 1].metadata).toMatchObject({ converged: true, metadata_only: true });
    expect((await sync([adopted])).unchanged).toEqual([f.slug]);
  });

  test('an insert blocked by a foreign row holding this fact\'s path is held, not thrown', async () => {
    const f = fact(1);
    await trx('knowledge_base').insert({
      path: `kb/facts/${f.slug}.md`, slug: `${f.slug}-renamed`, title: 'Renamed by a person', category: 'facts',
      content: 'x', summary: 'x', tags: JSON.stringify([]), source: 'manual', status: 'active', active: true, version: 1, metadata: JSON.stringify({}),
    });
    const r = await sync([f]);
    expect(r.held).toEqual([{ slug: f.slug, reason: 'insert_conflict' }]);
    expect(r.errors).toEqual([]);
    expect(await rowOf(f.slug)).toBeUndefined();
  });

  test('one bad fact does not stop the others', async () => {
    const good = fact(1);
    const bad = { ...fact(2), sourceUrls: null }; // rowValues throws on sourceUrls[0]
    const r = await sync([bad, good]);
    expect(r.errors).toEqual([{ slug: bad.slug, error: expect.any(String) }]);
    expect(r.inserted).toEqual([good.slug]);
    expect(await rowOf(good.slug)).toBeDefined();
  });
});
