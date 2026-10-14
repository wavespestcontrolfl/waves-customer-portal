// GATE_LAWN_V13 and the persisted knowledge (Codex r3 on #5942): the lawn protocol
// KB entries and the knowledge-index chunks must follow the gate both ways, not
// wait for the nightly runs. Synthetic in-memory tables: no database.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const protocolsJson = require('../config/protocols.json');
const v13 = require('../config/lawn-protocol-v13.json');
const KB = require('../services/knowledge-base');
const { syncCorpus } = require('../services/knowledge-index/ingest');
const { CONNECTORS } = require('../services/knowledge-index/connectors');

const TRACKS = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
// The v13 program has no bahia track (owner 2026-10-06): its KB set is these three.
const V13_TRACKS = Object.keys(v13);
// The corpus marker of the v13 program names its track set, so a track change marks a corpus stale.
const V13_MARKER = `v13:${[...V13_TRACKS].sort().join(',')}`;
const slugOf = (track) => `protocol-${track.replace(/_/g, '-')}`;

function withGate(value, fn) {
  const saved = process.env.GATE_LAWN_V13;
  if (value === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = value;
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
  });
}

// Minimal table-backed knex for knowledge_base and knowledge_embeddings.
function makeDb(tables) {
  let id = 0;
  db.fn = { now: () => 'now' };
  db.raw = (sql, args) => ({ raw: sql, args });
  db.mockImplementation((table) => {
    const rows = tables[table] || (tables[table] = []);
    const conds = [];
    const match = (row) => conds.every((c) => c(row));
    const b = {
      where(arg, val) {
        if (typeof arg === 'function') { const alts = []; const inner = { where: (o) => { alts.push(o); return inner; }, orWhere: (o) => { alts.push(o); return inner; } }; arg.call(inner); conds.push((r) => alts.some((o) => Object.entries(o).every(([k, v]) => r[k] === v))); return b; }
        const o = typeof arg === 'string' ? { [arg]: val } : arg;
        conds.push((r) => Object.entries(o).every(([k, v]) => r[k] === v));
        return b;
      },
      whereNot(o) { conds.push((r) => Object.entries(o).every(([k, v]) => r[k] !== v)); return b; },
      whereIn(col, vals) { conds.push((r) => vals.includes(r[col])); return b; },
      whereRaw() { return b; },
      orWhere(o) { const prev = conds.splice(0); conds.push((r) => prev.every((c) => c(r)) || Object.entries(o).every(([k, v]) => r[k] === v)); return b; },
      select() { return Promise.resolve(rows.filter(match)); },
      first() { return Promise.resolve(rows.find(match)); },
      update(p) { return Promise.resolve(rows.filter(match).map((r) => Object.assign(r, p)).length); },
      del() { const keep = rows.filter((r) => !match(r)); const n = rows.length - keep.length; tables[table] = keep; return Promise.resolve(n); },
      insert(r) { const made = { id: `${table}-${++id}`, ...r }; rows.push(made); return Promise.resolve([made]); },
    };
    return b;
  });
}

const kbRow = (tables, slug) => tables.knowledge_base.find((r) => r.slug === slug);
const tagsOf = (row) => (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags);

beforeEach(() => { jest.clearAllMocks(); });

describe('the lawn protocol knowledge follows GATE_LAWN_V13 both ways', () => {
  test('lawnKnowledgeStale: stored program vs the gate; nothing stored is not stale, a partial set is', async () => {
    const tables = { knowledge_base: [] };
    makeDb(tables);
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(false);
    tables.knowledge_base.push({ slug: slugOf('bermuda'), tags: JSON.stringify(['lawn', 'bermuda', 'lawn-v13']) });
    // A partial set (one of the program's tracks) is stale either way: the next sync completes it.
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    for (const track of V13_TRACKS.filter((t) => t !== 'bermuda')) tables.knowledge_base.push({ slug: slugOf(track), tags: JSON.stringify(['lawn', track, 'lawn-v13']) });
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(false);
    // The old program has a bahia entry too, so three v13 entries are a partial set to it.
    expect(await withGate(undefined, () => KB.lawnKnowledgeStale())).toBe(true);
    for (const row of tables.knowledge_base) row.tags = JSON.stringify(['lawn']);
    tables.knowledge_base.push({ slug: slugOf('bahia'), tags: JSON.stringify(['lawn', 'bahia']) });
    expect(await withGate(undefined, () => KB.lawnKnowledgeStale())).toBe(false);
    // With v13 live the old bahia entry is the other program's: stale until a sync removes it.
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    for (const row of tables.knowledge_base) row.tags = JSON.stringify(['lawn', 'lawn-v13']);
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    tables.knowledge_base = tables.knowledge_base.filter((row) => row.slug !== slugOf('bahia'));
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(false);
  });

  test('gate on then off: entries and index chunks go v13, then back to the old program with no v13 text left', async () => {
    const tables = {
      knowledge_base: [], knowledge_embeddings: [{ id: 'seed', source: 'protocol', source_id: 'x', chunk_index: 0, content_hash: 'h' }, { id: 'seed-kb', source: 'kb', source_id: 'y', chunk_index: 0, content_hash: 'h' }],
    };
    makeDb(tables);
    // Gate on with the index in use and no corpus marker yet: stale, so the first reconcile
    // creates the v13 entries and syncs both corpora.
    expect((await withGate('true', () => KB.reconcileLawnProtocolKnowledge())).stale).toBe(true);
    for (const track of V13_TRACKS) {
      const row = kbRow(tables, slugOf(track));
      expect(tagsOf(row)).toContain('lawn-v13');
      expect(row.content).toContain(v13[track].visits[0].primary.split('\n')[0]);
      expect(row.title).toBe(v13[track].name);
    }
    // The reconcile writes nothing to the KB but the lawn entries: three, no bahia.
    expect(tables.knowledge_base).toHaveLength(3);

    // Gate unset: stale now; the reconcile replaces every entry with the old program.
    const result = await withGate(undefined, () => KB.reconcileLawnProtocolKnowledge());
    expect(result.stale).toBe(true);
    expect(result.index.protocol).toMatchObject({ source: 'protocol' });
    expect(result.index.kb).toMatchObject({ source: 'kb' });
    for (const track of TRACKS) {
      const row = kbRow(tables, slugOf(track));
      expect(tagsOf(row)).not.toContain('lawn-v13');
      expect(row.title).toBe(protocolsJson.lawn[track].name);
      expect(row.content).toContain(protocolsJson.lawn[track].visits[0].primary.split('\n')[0]);
      expect(row.content).not.toContain('v13');
    }
    // Back on, and a second reconcile with nothing to change is a no-op.
    expect((await withGate('true', () => KB.reconcileLawnProtocolKnowledge())).stale).toBe(true);
    for (const track of V13_TRACKS) expect(tagsOf(kbRow(tables, slugOf(track)))).toContain('lawn-v13');
    // The old bahia entry the gate-off sync filed is gone again.
    expect(kbRow(tables, slugOf('bahia'))).toBeUndefined();
    expect((await withGate('true', () => KB.reconcileLawnProtocolKnowledge())).stale).toBe(false);
  });

  test('the index protocol corpus is rebuilt from lawnProtocols() each run: gate off drops the v13 chunks', async () => {
    const tables = { knowledge_embeddings: [] };
    makeDb(tables);
    const connector = CONNECTORS.find((c) => c.source === 'protocol');
    await withGate('true', () => syncCorpus(connector));
    const on = tables.knowledge_embeddings.filter((r) => r.source_id.startsWith('lawn.')).map((r) => r.content).join('\n');
    expect(on).toContain('Waves lawn program v13');
    await withGate(undefined, () => syncCorpus(connector));
    const off = tables.knowledge_embeddings.filter((r) => r.source_id.startsWith('lawn.')).map((r) => r.content).join('\n');
    expect(off).not.toContain('v13');
    expect(off).toContain(protocolsJson.lawn.bermuda.visits[0].primary.split('\n')[0]);
    // Same source ids both ways: replaced in place, nothing stale left behind.
    const ids = tables.knowledge_embeddings.filter((r) => r.source_id.startsWith('lawn.')).map((r) => `${r.source_id}/${r.chunk_index}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a corpus failure after the entries were rewritten is retried, not forgotten', () => {
  const ingest = require('../services/knowledge-index/ingest');
  const seeded = () => ({ knowledge_base: [], knowledge_embeddings: [{ id: 'seed', source: 'protocol', source_id: 'x', chunk_index: 0, content_hash: 'h' }, { id: 'seed-kb', source: 'kb', source_id: 'y', chunk_index: 0, content_hash: 'h' }] });
  const marker = (tables, key) => (tables.system_settings || []).find((r) => r.key === key)?.value;

  afterEach(() => jest.restoreAllMocks());

  test('syncCorpus throws once after the entries synced: the next tick finishes both corpora; then steady state is two small reads', async () => {
    const tables = seeded();
    makeDb(tables);
    const real = ingest.syncCorpus;
    const spy = jest.spyOn(ingest, 'syncCorpus').mockRejectedValueOnce(new Error('index down')).mockImplementation(real);
    await expect(withGate('true', () => KB.reconcileLawnProtocolKnowledge())).rejects.toThrow('index down');
    // The entries already match the gate, but no corpus marker was written.
    expect(V13_TRACKS.every((t) => tagsOf(kbRow(tables, slugOf(t))).includes('lawn-v13'))).toBe(true);
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBeUndefined();
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    // Next tick: retried and completed, both markers written.
    const retry = await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    expect(retry.stale).toBe(true);
    expect(Object.keys(retry.index)).toEqual(['protocol', 'kb']);
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe(V13_MARKER);
    expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBe(V13_MARKER);
    // Steady state: not stale, no corpus work, two table reads.
    spy.mockClear(); db.mockClear();
    expect((await withGate('true', () => KB.reconcileLawnProtocolKnowledge())).stale).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(db.mock.calls.map(([table]) => table)).toEqual(['knowledge_base', 'system_settings']);
  });

  test('the kb corpus fails after the protocol corpus finished: the retry runs only the kb corpus', async () => {
    const tables = seeded();
    makeDb(tables);
    const real = ingest.syncCorpus;
    let failKbOnce = true;
    const spy = jest.spyOn(ingest, 'syncCorpus').mockImplementation(async (connector) => {
      if (connector.source === 'kb' && failKbOnce) { failKbOnce = false; throw new Error('kb corpus down'); }
      return real(connector);
    });
    await expect(withGate('true', () => KB.reconcileLawnProtocolKnowledge())).rejects.toThrow('kb corpus down');
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe(V13_MARKER);
    expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBeUndefined();
    spy.mockClear();
    await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    expect(spy.mock.calls.map(([c]) => c.source)).toEqual(['kb']);
    expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBe(V13_MARKER);
  });

  test('gate flipped back off with a corpus failure: the legacy marker waits for the successful sync', async () => {
    const tables = seeded();
    makeDb(tables);
    await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    const real = ingest.syncCorpus;
    jest.spyOn(ingest, 'syncCorpus').mockRejectedValueOnce(new Error('index down')).mockImplementation(real);
    await expect(withGate(undefined, () => KB.reconcileLawnProtocolKnowledge())).rejects.toThrow('index down');
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe(V13_MARKER);
    expect(await withGate(undefined, () => KB.lawnKnowledgeStale())).toBe(true);
    await withGate(undefined, () => KB.reconcileLawnProtocolKnowledge());
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe('legacy');
    expect(await withGate(undefined, () => KB.lawnKnowledgeStale())).toBe(false);
  });

  test('a corpus sync that was SKIPPED (its connector failed to load) writes no marker, and the next tick retries it', async () => {
    const tables = seeded();
    makeDb(tables);
    const { CONNECTORS } = require('../services/knowledge-index/connectors');
    const kbConnector = CONNECTORS.find((c) => c.source === 'kb');
    jest.spyOn(kbConnector, 'load').mockRejectedValueOnce(new Error('loader failed'));
    const first = await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    expect(first.index.kb).toMatchObject({ source: 'kb', skipped: true });
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe(V13_MARKER);
    expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBeUndefined();
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    const spy = jest.spyOn(ingest, 'syncCorpus');
    const second = await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    expect(spy.mock.calls.map(([c]) => c.source)).toEqual(['kb']);
    expect(second.index.kb.skipped).toBeUndefined();
    expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBe(V13_MARKER);
  });

  test('the nightly writes the marker too, from the program it loaded: a gate-off nightly after a v13 reconcile leaves the next gate-on tick stale', async () => {
    const tables = seeded();
    makeDb(tables);
    const { CONNECTORS } = require('../services/knowledge-index/connectors');
    const corpus = (source) => CONNECTORS.find((c) => c.source === source);
    await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe(V13_MARKER);
    // An old-gate pod's nightly rebuilds both corpora with the gate off.
    await withGate(undefined, async () => { await ingest.syncCorpus(corpus('protocol')); await ingest.syncCorpus(corpus('kb')); });
    // The protocol corpus now holds the legacy program; the kb corpus holds the (still v13-tagged) entries.
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe('legacy');
    expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBe(V13_MARKER);
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    const spy = jest.spyOn(ingest, 'syncCorpus');
    await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    expect(spy.mock.calls.map(([c]) => c.source)).toEqual(['protocol']);
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe(V13_MARKER);
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(false);
  });

  test('the nightly with the gate off while the entries still hold v13: the kb marker says v13, so the gate-off tick is stale and rewrites the entries', async () => {
    const tables = seeded();
    makeDb(tables);
    await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    const { CONNECTORS } = require('../services/knowledge-index/connectors');
    await withGate(undefined, () => ingest.syncCorpus(CONNECTORS.find((c) => c.source === 'kb')));
    expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBe(V13_MARKER);
    expect(await withGate(undefined, () => KB.lawnKnowledgeStale())).toBe(true);
    await withGate(undefined, () => KB.reconcileLawnProtocolKnowledge());
    expect(TRACKS.every((t) => !tagsOf(kbRow(tables, slugOf(t))).includes('lawn-v13'))).toBe(true);
    expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBe('legacy');
    expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe('legacy');
  });

  test('an absent corpus marker is unknown, not legacy: gate off with the index in use and no marker is stale once, then settles', async () => {
    // Codex r4 on #5996: a v13 rebuild whose marker write failed, then a gate rollback,
    // must not read the unmarked corpus as already legacy.
    const tables = {
      knowledge_base: [], knowledge_embeddings: [{ id: 'seed', source: 'protocol', source_id: 'x', chunk_index: 0, content_hash: 'h' }],
    };
    makeDb(tables);
    expect(await withGate(undefined, () => KB.lawnKnowledgeStale())).toBe(true);
    await withGate(undefined, () => KB.reconcileLawnProtocolKnowledge());
    expect(tables.system_settings.find((r) => r.key === 'lawn_knowledge.protocol_corpus').value).toBe('legacy');
    expect(await withGate(undefined, () => KB.lawnKnowledgeStale())).toBe(false);
  });

  test('each corpus is checked on its own: kb chunks with no protocol chunks still make a stale kb marker count', async () => {
    // Codex r5 on #5996: the nightly can leave the kb corpus populated and the protocol corpus empty.
    const tables = {
      knowledge_base: [], knowledge_embeddings: [{ id: 'seed', source: 'kb', source_id: 'x', chunk_index: 0, content_hash: 'h' }],
    };
    makeDb(tables);
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    expect(tables.system_settings.find((r) => r.key === 'lawn_knowledge.kb_corpus').value).toBe(V13_MARKER);
  });

  test('a lawn entry whose insert fails: the reconcile stops before the corpora and the partial set stays stale', async () => {
    // Codex r6 on #5996: a non-duplicate insert failure reported 'skipped' and the kb corpus advanced on three entries.
    const tables = {
      knowledge_base: [], knowledge_embeddings: [{ id: 'seed', source: 'protocol', source_id: 'x', chunk_index: 0, content_hash: 'h' }, { id: 'seed-kb', source: 'kb', source_id: 'y', chunk_index: 0, content_hash: 'h' }],
    };
    makeDb(tables);
    const realImpl = db.getMockImplementation();
    let failOnce = true;
    db.mockImplementation((table) => {
      const b = realImpl(table);
      if (table !== 'knowledge_base') return b;
      const insert = b.insert;
      b.insert = (r) => (failOnce && r.slug === slugOf('zoysia') ? (failOnce = false, Promise.reject(new Error('connection reset'))) : insert(r));
      return b;
    });
    await expect(withGate('true', () => KB.reconcileLawnProtocolKnowledge())).rejects.toThrow('lawn KB entries incomplete');
    expect((tables.system_settings || []).length).toBe(0);
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
    expect(V13_TRACKS.every((track) => kbRow(tables, slugOf(track)))).toBe(true);
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(false);
  });

  // Upgrade: the four-track v13 program was already indexed (both markers say plain 'v13', a bahia KB
  // entry and bahia index chunks exist). The track set is part of the marker, so one tick rebuilds both
  // corpora and the removed bahia text leaves the protocol and kb indexes, with no wait for the nightly.
  describe('upgrading an already-indexed four-track v13 corpus', () => {
    const OLD_TRACKS = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
    const fourTrack = ({ withBahiaEntry = true } = {}) => ({
      knowledge_base: OLD_TRACKS.filter((t) => withBahiaEntry || t !== 'bahia').map((track, i) => ({
        id: `kb-${i}`, slug: slugOf(track), title: `v13 ${track}`, content: 'old v13 text', category: 'protocols',
        tags: JSON.stringify(['lawn', track, 'lawn-v13']), source: 'auto-sync', status: 'active',
      })),
      knowledge_embeddings: [
        ...OLD_TRACKS.map((t, i) => ({ id: `p-${i}`, source: 'protocol', source_id: `lawn.${t}`, chunk_index: 0, content_hash: 'old' })),
        ...OLD_TRACKS.map((t, i) => ({ id: `k-${i}`, source: 'kb', source_id: slugOf(t), chunk_index: 0, content_hash: 'old' })),
      ],
      system_settings: [
        { key: 'lawn_knowledge.protocol_corpus', value: 'v13' },
        { key: 'lawn_knowledge.kb_corpus', value: 'v13' },
      ],
    });
    const indexed = (tables, source) => tables.knowledge_embeddings.filter((r) => r.source === source).map((r) => r.source_id);

    test.each([[true], [false]])('bahia KB entry present: %s -> one tick rebuilds both corpora; no bahia entry or chunk is left', async (withBahiaEntry) => {
      const tables = fourTrack({ withBahiaEntry });
      makeDb(tables);
      expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
      const result = await withGate('true', () => KB.reconcileLawnProtocolKnowledge());
      expect(result.stale).toBe(true);
      expect(Object.keys(result.index)).toEqual(['protocol', 'kb']);
      expect(result.index.protocol.skipped).toBeUndefined();
      expect(result.index.kb.skipped).toBeUndefined();
      expect(kbRow(tables, slugOf('bahia'))).toBeUndefined();
      expect(indexed(tables, 'protocol')).not.toContain('lawn.bahia');
      expect(indexed(tables, 'kb')).not.toContain(slugOf('bahia'));
      expect(indexed(tables, 'protocol')).toEqual(expect.arrayContaining(V13_TRACKS.map((t) => `lawn.${t}`)));
      expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe(V13_MARKER);
      expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBe(V13_MARKER);
      // The next tick is a no-op.
      expect((await withGate('true', () => KB.reconcileLawnProtocolKnowledge())).stale).toBe(false);
    });

    test('markers alone (the entry set is already right) are enough to mark both corpora stale', async () => {
      const tables = fourTrack({ withBahiaEntry: false });
      makeDb(tables);
      expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(true);
    });

    test('gate off: the legacy marker and behavior are unchanged', async () => {
      const tables = seeded();
      makeDb(tables);
      await withGate(undefined, () => KB.reconcileLawnProtocolKnowledge());
      expect(marker(tables, 'lawn_knowledge.protocol_corpus')).toBe('legacy');
      expect(marker(tables, 'lawn_knowledge.kb_corpus')).toBe('legacy');
      expect(await withGate(undefined, () => KB.lawnKnowledgeStale())).toBe(false);
    });
  });

  test('the index not in use: markers are ignored (stale only by the entry tags)', async () => {
    const tables = { knowledge_base: [] };
    makeDb(tables);
    expect(await withGate('true', () => KB.lawnKnowledgeStale())).toBe(false);
  });
});
