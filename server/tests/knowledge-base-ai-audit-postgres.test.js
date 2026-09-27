/**
 * The weekly KB AI audit on PostgreSQL: who owns a flag, and what a verdict
 * may change. Before this, every flag hid the entry for good (176 of 296 in
 * prod) and a verdict was written from a snapshot taken before the slow model
 * call, so a person's flag landing mid-call could be cleared.
 */
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const mockVerdicts = new Map();
let mockDuringCall = null;
jest.mock('../services/llm/deep', () => ({
  createDeepMessage: jest.fn(async (_client, { messages }) => {
    const title = /Title: (.*)/.exec(messages[0].content)[1];
    if (mockDuringCall) await mockDuringCall(title);
    const verdict = mockVerdicts.get(title) || { status: 'pass', confidence: 'high' };
    return { content: [{ type: 'text', text: JSON.stringify(verdict) }] };
  }),
}));

describeOrSkip('KB AI audit on PostgreSQL', () => {
  let db;
  let KB;
  const tag = `kbaudit-${Date.now()}`;
  const ids = [];

  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
    db = require('../models/db');
    KB = require('../services/knowledge-base');
  });
  afterEach(() => { mockVerdicts.clear(); mockDuringCall = null; });
  afterAll(async () => {
    if (ids.length) {
      await db('knowledge_base_audits').whereIn('kb_entry_id', ids).del();
      await db('knowledge_base').whereIn('id', ids).del();
    }
    await db.destroy();
  });

  // Every run is scoped to this suite's rows (ids) so the shared test
  // database's other entries are never selected or written.
  async function entry(name, { source = 'manual', status = 'active', slug } = {}) {
    const title = `${tag} ${name}`;
    const s = slug || `${tag}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const [row] = await db('knowledge_base').insert({
      title, slug: s, path: `kb/test/${s}.md`, content: `${name} body`, category: 'test',
      source, status, confidence: 'medium', last_verified_at: new Date('2000-01-01'),
    }).returning('*');
    ids.push(row.id);
    return row;
  }
  const reload = (id) => db('knowledge_base').where({ id }).first();
  const audits = (id) => db('knowledge_base_audits').where({ kb_entry_id: id }).orderBy('created_at');

  test('a generated entry stays searchable and its finding names the source', async () => {
    const row = await entry('Product', { source: 'auto-sync', slug: `product-${tag}` });
    mockVerdicts.set(row.title, { status: 'flag', confidence: 'low', issues: ['formulation'], summary: 'fix formulation' });
    const out = await KB.runAIAudit({ ids, maxEntries: 1 });
    expect(out.results[0]).toMatchObject({ fixIn: 'products_catalog', fixLink: '/admin/inventory?tab=products' });
    const after = await reload(row.id);
    expect(after.status).toBe('active');
    expect(after.last_verified_at.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    const [a] = await audits(row.id);
    expect(a.result).toBe('flagged-source');
  });

  test('an AI-hidden entry returns when its content is edited or a re-audit passes', async () => {
    const edited = await entry('Edited');
    const reaudited = await entry('Reaudited');
    mockVerdicts.set(edited.title, { status: 'flag', summary: 'x' });
    mockVerdicts.set(reaudited.title, { status: 'update-needed', summary: 'y' });
    await KB.runAIAudit({ ids, maxEntries: 2 });
    expect((await reload(edited.id)).status).toBe('flagged');
    expect((await reload(reaudited.id)).status).toBe('flagged');

    await KB.update(edited.id, { content: 'Edited body, corrected' });
    expect((await reload(edited.id)).status).toBe('active');

    mockVerdicts.set(reaudited.title, { status: 'pass', confidence: 'high' });
    const out = await KB.runAIAudit({ ids, flaggedOnly: true, maxEntries: 5 });
    expect(out.passed).toBe(1);
    expect((await reload(reaudited.id)).status).toBe('active');
  });

  test("a person's flag is never cleared by an edit or a re-audit", async () => {
    const row = await entry('Manual');
    await KB.flag(row.id, 'rate looks wrong');
    await KB.update(row.id, { content: 'Manual body v2' });
    expect((await reload(row.id)).status).toBe('flagged');
    const out = await KB.runAIAudit({ ids, flaggedOnly: true, maxEntries: 5 });
    expect(out.results.map((r) => r.id)).not.toContain(row.id);
  });

  test('a person verifying during the model call wins over an AI flag', async () => {
    const row = await entry('Verified');
    mockVerdicts.set(row.title, { status: 'flag', summary: 'x' });
    mockDuringCall = async (title) => { if (title === row.title) await KB.verify(row.id); };
    const out = await KB.runAIAudit({ ids: [row.id], maxEntries: 1 });
    expect(out.results[0]).toMatchObject({ id: row.id, status: 'stale' });
    expect((await reload(row.id)).status).toBe('active');
  });

  test('a person flagging during the model call wins; the verdict is recorded stale', async () => {
    const row = await entry('Race');
    mockDuringCall = async (title) => { if (title === row.title) await KB.flag(row.id, 'mid-call'); };
    const out = await KB.runAIAudit({ ids, maxEntries: 1 });
    expect(out.results[0]).toMatchObject({ id: row.id, status: 'stale' });
    expect((await reload(row.id)).status).toBe('flagged');
    const rows = await audits(row.id);
    expect(rows.map((a) => [a.audit_type, a.result])).toEqual([['manual-flag', 'flagged'], ['ai-review', 'stale']]);
    mockDuringCall = null;
    const again = await KB.runAIAudit({ ids, flaggedOnly: true, maxEntries: 5 });
    expect(again.results.map((r) => r.id)).not.toContain(row.id);
  });

  test('Verify clears a flag but never an archive or a wiki mirror gate', async () => {
    const flaggedRow = await entry('VerifyFlagged');
    await KB.flag(flaggedRow.id, 'check');
    await KB.verify(flaggedRow.id);
    expect((await reload(flaggedRow.id)).status).toBe('active');

    const archived = await entry('VerifyArchived', { status: 'archived' });
    await KB.verify(archived.id);
    expect((await reload(archived.id)).status).toBe('archived');

    const mirror = await entry('VerifyMirror', { source: 'wiki-sync', status: 'flagged' });
    await db('knowledge_base_audits').insert({ kb_entry_id: mirror.id, audit_type: 'ai-review', result: 'flagged', findings: '{}', audited_by: 'ai-cron' });
    await KB.verify(mirror.id);
    await KB.update(mirror.id, { content: 'mirror body v2' });
    expect((await reload(mirror.id)).status).toBe('flagged');
    const out = await KB.runAIAudit({ ids, flaggedOnly: true, maxEntries: 10 });
    expect(out.results.map((r) => r.id)).not.toContain(mirror.id);
  });

  test('any writer that changes an AI-hidden entry returns it; a person\'s flag stays', async () => {
    const aiHidden = await entry('DirectWriter');
    mockVerdicts.set(aiHidden.title, { status: 'flag', summary: 'x' });
    await KB.runAIAudit({ ids: [aiHidden.id], maxEntries: 1 });
    expect((await reload(aiHidden.id)).status).toBe('flagged');
    // A direct write, as the wiki compiler and WikiQA file-back do.
    await db('knowledge_base').where({ id: aiHidden.id }).update({ content: 'rewritten' });
    expect((await reload(aiHidden.id)).status).toBe('active');

    const personHidden = await entry('DirectWriterManual');
    await KB.flag(personHidden.id, 'hold');
    await db('knowledge_base').where({ id: personHidden.id }).update({ content: 'rewritten' });
    expect((await reload(personHidden.id)).status).toBe('flagged');
  });

  test('an unparsed verdict changes nothing', async () => {
    const row = await entry('Unparsed');
    mockVerdicts.set(row.title, { status: 'looks fine' });
    const out = await KB.runAIAudit({ ids, maxEntries: 1 });
    expect(out).toMatchObject({ flagged: 0, passed: 0 });
    const after = await reload(row.id);
    expect(after.status).toBe('active');
    expect(after.last_verified_at.toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });
});
