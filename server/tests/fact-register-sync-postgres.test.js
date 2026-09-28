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

  test('the sync never touches status: a row the knowledge-base audit flagged stays flagged through an update', async () => {
    const facts = [fact(1)];
    await sync(facts);
    const before = await rowOf(facts[0].slug);
    await trx('knowledge_base').where({ id: before.id }).update({ status: 'flagged' });

    await sync([{ ...facts[0], content: 'New content.' }]);
    const after = await rowOf(facts[0].slug);
    expect(after.content).toBe('New content.');
    expect(after.status).toBe('flagged');
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
    expect(_internals.hasProvenance(after, '2026-09-28')).toBe(false); // synthetic slug is not in the register…
    expect(_internals.hasProvenance({ ...after, slug: 'fact-southern-chinch-bug' }, '2026-09-28')).toBe(true); // …but the row itself passes
  });

  test('an expired fact retires its untouched row once (active=false, status untouched), and is never seeded fresh', async () => {
    const facts = [fact(1)];
    await sync(facts);
    const before = await rowOf(facts[0].slug);

    const expired = [{ ...facts[0], expiresOn: '2026-09-28' }];
    const r = await sync(expired);
    expect(r.retired).toEqual([facts[0].slug]);
    const after = await rowOf(facts[0].slug);
    expect(after.active).toBe(false);
    expect(after.status).toBe('active');
    expect(after.metadata).toMatchObject({ retired_on: '2026-09-28', retired_reason: 'expired' });
    expect(await audits(before.id, 'knowledge_base.fact_retired')).toHaveLength(1);

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
    expect(back.metadata.expires_on).toBe('2026-12-01');
    expect(back.metadata.retired_on).toBeUndefined();
    expect(back.metadata.retired_reason).toBeUndefined();
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
    expect(stray.metadata).toMatchObject({ retired_reason: 'withdrawn_from_register' });
    expect(await audits(stray.id, 'knowledge_base.fact_retired')).toHaveLength(1);
    expect((await rowOf(facts[1].slug)).active).toBe(true);
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

  test('one bad fact does not stop the others', async () => {
    const good = fact(1);
    const bad = { ...fact(2), sourceUrls: null }; // rowValues throws on sourceUrls[0]
    const r = await sync([bad, good]);
    expect(r.errors).toEqual([{ slug: bad.slug, error: expect.any(String) }]);
    expect(r.inserted).toEqual([good.slug]);
    expect(await rowOf(good.slug)).toBeDefined();
  });
});
