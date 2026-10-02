// Lawn treatment memory (lawn report rebuild P12, GATE_LAWN_VISIT_MEMORY).
// Synthetic data only.
//
// Pins: the pure entry builder; prior-visit selection (a later-dated or same-day
// row is never the prior, a moved home has none); the first-writer-wins freezer
// including A -> B -> A (a re-render with different inputs never overwrites, and
// one assessment never destroys another's entry), the lost-race re-read and the
// failure path; the render orchestration (replay, no prior, prior with memory,
// prior read failure, freeze failure); and the gate: off = no reads, no writes
// and a payload that is key-for-key what it was. The real-Postgres race lives in
// lawn-visit-memory-postgres.test.js (CI only).

jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const logger = require('../services/logger');
const featureGates = require('../config/feature-gates');
const { classifyProduct, buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const {
  VISIT_MEMORY_VERSION, TAG_BY_KIND, buildVisitMemory, selectPriorVisit, storedVisitMemoryFor,
  buildSinceLast, freezeLawnVisitMemory, resolveVisitMemoryForRender,
} = require('../services/service-report/lawn-visit-memory');

const product = (over = {}) => ({
  name: 'Test Fungicide A', activeIngredient: 'Azoxystrobin 10%', kind: 'fungicide', targets: [], ...over,
});
const insight = (category, status, priority) => ({ category, status, priority });
const REPORT = (over = {}) => ({
  treatment: { products: [product()] },
  insights: [insight('weeds', 'watch', 2), insight('water', 'needs_attention', 1)],
  ...over,
});

describe('buildVisitMemory (pure)', () => {
  test('entry shape: applied from the treatment products, checks from watch / needs_attention insights in priority order', () => {
    const entry = buildVisitMemory({ reportV2: REPORT(), assessmentId: 'as-A', serviceDate: '2026-09-02' });
    expect(entry).toEqual({
      v: VISIT_MEMORY_VERSION,
      assessmentId: 'as-A',
      serviceDate: '2026-09-02',
      applied: [{ name: 'Test Fungicide A', activeIngredient: 'Azoxystrobin 10%', kind: 'fungicide', tag: 'fungus protection', targets: [] }],
      checks: [{ key: 'water', status: 'needs_attention' }, { key: 'weeds', status: 'watch' }],
    });
    expect(JSON.stringify(entry).length).toBeLessThan(2048);
  });

  test('a date value is normalized to YYYY-MM-DD and the entry is deterministic', () => {
    const a = buildVisitMemory({ reportV2: REPORT(), assessmentId: 'as-A', serviceDate: new Date('2026-09-02T00:00:00Z') });
    const b = buildVisitMemory({ reportV2: REPORT(), assessmentId: 'as-A', serviceDate: '2026-09-02' });
    expect(a.serviceDate).toBe('2026-09-02');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('targets are capped at three, applied at eight, check text trimmed; support products are never remembered', () => {
    const many = Array.from({ length: 12 }, (_, i) => product({ name: `Product ${i}` }));
    const entry = buildVisitMemory({
      reportV2: REPORT({
        treatment: {
          products: [
            product({ targets: ['a', 'b', 'c', 'd', 'e'] }),
            product({ name: 'Test Surfactant', activeIngredient: 'Nonionic surfactant', kind: 'other' }),
            product({ name: 'Test PGR', activeIngredient: 'Trinexapac-ethyl', kind: 'other' }),
            ...many,
          ],
        },
      }),
      assessmentId: 'as-A', serviceDate: '2026-09-02',
    });
    expect(entry.applied[0].targets).toEqual(['a', 'b', 'c']);
    expect(entry.applied.map((p) => p.name)).not.toContain('Test Surfactant');
    expect(entry.applied.map((p) => p.name)).not.toContain('Test PGR');
    expect(entry.applied).toHaveLength(8);
  });

  test('checks: only the five measurable categories, healthy / customer_concern / overall never, one per topic, at most three', () => {
    const insights = [
      insight('customer_concern', 'watch', 1),
      insight('overall', 'healthy', 2),
      insight('water', 'watch', 3),
      insight('water', 'needs_attention', 4),
      insight('weeds', 'healthy', 5),
      insight('damage', 'watch', 6),
      insight('coverage', 'watch', 7),
      insight('mowing', 'watch', 8),
    ];
    const entry = buildVisitMemory({ reportV2: REPORT({ insights }), assessmentId: 'as-A', serviceDate: '2026-09-02' });
    expect(entry.checks).toEqual([
      { key: 'water', status: 'watch' }, // the first (highest priority) water card names the topic
      { key: 'damage', status: 'watch' },
      { key: 'coverage', status: 'watch' },
    ]);
  });

  test('an unknown kind is stored as other, and no treatment or no insights is an empty list, not an error', () => {
    const entry = buildVisitMemory({
      reportV2: { treatment: { products: [product({ kind: 'bogus' })] } }, assessmentId: 'as-A', serviceDate: '2026-09-02',
    });
    expect(entry.applied[0]).toMatchObject({ kind: 'other', tag: 'lawn treatment' });
    expect(entry.checks).toEqual([]);
    expect(buildVisitMemory({ reportV2: {}, assessmentId: 'as-A', serviceDate: '2026-09-02' }).applied).toEqual([]);
  });

  test('nothing to freeze without a report, an assessment id or a usable date', () => {
    expect(buildVisitMemory({ assessmentId: 'as-A', serviceDate: '2026-09-02' })).toBeNull();
    expect(buildVisitMemory({ reportV2: REPORT(), serviceDate: '2026-09-02' })).toBeNull();
    expect(buildVisitMemory({ reportV2: REPORT(), assessmentId: 'as-A' })).toBeNull();
    expect(buildVisitMemory({ reportV2: REPORT(), assessmentId: 'as-A', serviceDate: 'not a date' })).toBeNull();
  });

  test('the kind -> tag table cannot drift from classifyProduct', () => {
    const samples = {
      fungicide: 'fungicide', pre_emergent: 'pre-emergent', herbicide: 'herbicide', insecticide: 'insecticide',
      supplement: 'micronutrient', fertilizer: 'fertilizer', other: 'zzz',
    };
    for (const [kind, category] of Object.entries(samples)) {
      const cls = classifyProduct({ product: { name: 'Test Product', category } });
      expect(cls.kind).toBe(kind);
      expect(cls.tag).toBe(TAG_BY_KIND[kind]);
    }
    expect(Object.keys(TAG_BY_KIND).sort()).toEqual(Object.keys(samples).sort());
  });

  test('built from a real buildLawnReportV2 output', () => {
    const v2 = buildLawnReportV2({
      lawnAssessment: {
        scores: { turfDensity: 55, weedSuppression: 40, colorHealth: 70, fungusControl: 80, thatchLevel: 80, stressDamage: 80, overall: 60 },
        serviceDate: '2026-09-02', assessmentDate: '2026-09-02', turfProfile: { grassType: 'st_augustine' },
        waterContext: {}, observations: '',
      },
      applications: [{ product: { name: 'Test Herbicide B', category: 'herbicide', active_ingredient: 'Metsulfuron' }, targets: ['broadleaf weeds'] }],
    });
    const entry = buildVisitMemory({ reportV2: v2, assessmentId: 'as-A', serviceDate: '2026-09-02' });
    expect(entry.applied).toEqual([{ name: 'Test Herbicide B', activeIngredient: 'Metsulfuron', kind: 'herbicide', tag: 'weed control', targets: ['broadleaf weeds'] }]);
    expect(Array.isArray(entry.checks)).toBe(true);
  });
});

describe('selectPriorVisit (pure)', () => {
  const row = (id, date, recordId = `rec-${id}`) => ({ id, service_date: date, history_record_id: recordId });

  test('the nearest strictly earlier visit is the prior', () => {
    const rows = [row('a1', '2026-07-01'), row('a2', '2026-08-01'), row('cur', '2026-09-01')];
    expect(selectPriorVisit(rows, 'cur')).toEqual({ assessmentId: 'a2', serviceRecordId: 'rec-a2', date: '2026-08-01' });
  });

  test('a later-dated row is NEVER the prior, wherever it sits in the list', () => {
    const rows = [row('a1', '2026-07-01'), row('future', '2026-10-01'), row('cur', '2026-09-01')];
    expect(selectPriorVisit(rows, 'cur').assessmentId).toBe('a1');
    expect(selectPriorVisit([row('cur', '2026-09-01'), row('future', '2026-10-01')], 'cur')).toBeNull();
  });

  test('a same-day row is not the prior (strictly earlier only); the walk falls back to the visit before it', () => {
    const rows = [row('a1', '2026-08-01'), row('same', '2026-09-01'), row('cur', '2026-09-01')];
    expect(selectPriorVisit(rows, 'cur').assessmentId).toBe('a1');
    expect(selectPriorVisit([row('same', '2026-09-01'), row('cur', '2026-09-01')], 'cur')).toBeNull();
  });

  test('ties on an earlier date resolve to the later row in list order; Date values compare as days', () => {
    const rows = [row('x1', '2026-08-01'), row('x2', new Date('2026-08-01T00:00:00Z')), row('cur', '2026-09-01')];
    expect(selectPriorVisit(rows, 'cur').assessmentId).toBe('x2');
  });

  test('a moved home: history scoped to the new property holds only the current visit, so there is no prior', () => {
    expect(selectPriorVisit([row('cur', '2026-09-01')], 'cur')).toBeNull();
    expect(selectPriorVisit([], 'cur')).toBeNull();
  });

  test('no prior when the current visit is not in the rows, has no date, or the earlier row has no record to read memory from', () => {
    expect(selectPriorVisit([row('a1', '2026-08-01')], 'cur')).toBeNull();
    expect(selectPriorVisit([row('a1', '2026-08-01'), { id: 'cur', service_date: null }], 'cur')).toBeNull();
    expect(selectPriorVisit([{ id: 'a1', service_date: '2026-08-01' }, row('cur', '2026-09-01')], 'cur')).toBeNull();
    expect(selectPriorVisit(null, 'cur')).toBeNull();
    expect(selectPriorVisit([row('a1', '2026-08-01')], null)).toBeNull();
  });

  test('legacy history rows carry service_record_id instead of history_record_id', () => {
    const rows = [{ id: 'a1', service_date: '2026-08-01', service_record_id: 'rec-legacy' }, row('cur', '2026-09-01')];
    expect(selectPriorVisit(rows, 'cur').serviceRecordId).toBe('rec-legacy');
  });
});

describe('storedVisitMemoryFor / buildSinceLast (pure)', () => {
  const entry = (over = {}) => ({ v: 1, assessmentId: 'as-A', serviceDate: '2026-08-01', applied: [{ name: 'P' }], checks: [{ key: 'water', status: 'watch' }], ...over });

  test('reads one assessment\'s entry out of the map, from an object or a JSON string', () => {
    const notes = { lawnVisitMemory: { 'as-A': entry(), 'as-B': entry({ assessmentId: 'as-B' }) }, other: 1 };
    expect(storedVisitMemoryFor(notes, 'as-A').assessmentId).toBe('as-A');
    expect(storedVisitMemoryFor(JSON.stringify(notes), 'as-B').assessmentId).toBe('as-B');
    expect(storedVisitMemoryFor(notes, 'as-C')).toBeNull();
    expect(storedVisitMemoryFor('not json', 'as-A')).toBeNull();
    expect(storedVisitMemoryFor(null, 'as-A')).toBeNull();
    expect(storedVisitMemoryFor(notes, null)).toBeNull();
  });

  test('an entry of another version, or filed under a mismatched assessment id, never replays', () => {
    expect(storedVisitMemoryFor({ lawnVisitMemory: { 'as-A': entry({ v: 2 }) } }, 'as-A')).toBeNull();
    expect(storedVisitMemoryFor({ lawnVisitMemory: { 'as-A': entry({ assessmentId: 'as-B' }) } }, 'as-A')).toBeNull();
    expect(storedVisitMemoryFor({ lawnVisitMemory: [entry()] }, 'as-A')).toBeNull();
  });

  test('sinceLast carries the prior\'s applied and checks, with no state words', () => {
    const block = buildSinceLast({ priorVisit: { assessmentId: 'as-A', date: '2026-08-01' }, priorMemory: entry() });
    expect(block).toEqual({
      v: 1, priorAssessmentId: 'as-A', priorDate: '2026-08-01', applied: [{ name: 'P' }], checks: [{ key: 'water', status: 'watch' }],
    });
    expect(JSON.stringify(block)).not.toMatch(/clear|improv|resolved|still/i);
  });

  test('null when there is no prior, no memory, a mismatched memory, or the prior recorded nothing', () => {
    const priorVisit = { assessmentId: 'as-A', date: '2026-08-01' };
    expect(buildSinceLast({ priorMemory: entry() })).toBeNull();
    expect(buildSinceLast({ priorVisit })).toBeNull();
    expect(buildSinceLast({ priorVisit, priorMemory: entry({ assessmentId: 'as-Z' }) })).toBeNull();
    expect(buildSinceLast({ priorVisit, priorMemory: entry({ v: 9 }) })).toBeNull();
    expect(buildSinceLast({ priorVisit, priorMemory: entry({ applied: [], checks: [] }) })).toBeNull();
    expect(buildSinceLast({ priorVisit, priorMemory: entry({ applied: [], checks: [{ key: 'water', status: 'watch' }] }) })).not.toBeNull();
  });
});

// ── an in-memory service_records table with the freeze's SQL semantics ──────────
// whereRaw carries the per-key absence predicate (its binding is the assessment
// id); update carries the two-level jsonb merge (its binding is the one-key map).
// The real SQL runs in the Postgres suite.
function makeStore(records) {
  const log = { updates: [], reads: [], tables: [] };
  const state = { failUpdate: false, failRead: false, beforeUpdate: null };
  const knex = (table) => {
    log.tables.push(table);
    const ctx = { where: {}, rawBinding: null };
    const chain = {
      where(cond) { Object.assign(ctx.where, cond); return chain; },
      whereRaw(_sql, bindings) { ctx.rawBinding = bindings?.[0] ?? null; return chain; },
      async update(patch) {
        if (state.failUpdate) throw new Error('update failed');
        if (state.beforeUpdate) { const hook = state.beforeUpdate; state.beforeUpdate = null; hook(); }
        const rec = records[ctx.where.id];
        if (!rec) return 0;
        const map = (rec.structured_notes && rec.structured_notes.lawnVisitMemory) || {};
        if (ctx.rawBinding != null && map[ctx.rawBinding] != null) return 0;
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        rec.structured_notes = { ...rec.structured_notes, lawnVisitMemory: { ...map, ...add } };
        log.updates.push(add);
        return 1;
      },
      async first() {
        log.reads.push({ ...ctx.where });
        if (state.failRead) throw new Error('read failed');
        const rec = records[ctx.where.id];
        if (!rec) return undefined;
        if (ctx.where.customer_id && rec.customer_id !== ctx.where.customer_id) return undefined;
        return { structured_notes: rec.structured_notes };
      },
    };
    return chain;
  };
  knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return { knex, log, state };
}

const ENTRY = (assessmentId, over = {}) => ({
  v: 1, assessmentId, serviceDate: '2026-09-02', applied: [{ name: 'First Product', activeIngredient: null, kind: 'other', tag: 'lawn treatment', targets: [] }],
  checks: [], sinceLast: null, ...over,
});

describe('freezeLawnVisitMemory', () => {
  beforeEach(() => jest.clearAllMocks());

  test('writes one key into the map with an ATOMIC two-level jsonb merge, guarded by that key\'s absence in the predicate', async () => {
    const calls = { raws: [], patches: [], wheres: [] };
    const knex = jest.fn(() => {
      const chain = {
        where: jest.fn((c) => { calls.wheres.push(c); return chain; }),
        whereRaw: jest.fn((sql, b) => { calls.raws.push([sql, b]); return chain; }),
        update: jest.fn(async (p) => { calls.patches.push(p); return 1; }),
      };
      return chain;
    });
    knex.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));

    await expect(freezeLawnVisitMemory('svc-1', ENTRY('as-A'), knex)).resolves.toEqual(ENTRY('as-A'));
    expect(calls.wheres[0]).toEqual({ id: 'svc-1' });
    expect(calls.raws).toHaveLength(1);
    expect(calls.raws[0][0]).toMatch(/-> 'lawnVisitMemory' -> \? IS NULL/);
    expect(calls.raws[0][1]).toEqual(['as-A']);
    const raw = calls.patches[0].structured_notes.__raw;
    expect(raw).toContain("jsonb_build_object('lawnVisitMemory'");
    expect(raw).toContain('||');
    expect(JSON.parse(calls.patches[0].structured_notes.bindings[0])).toEqual({ 'as-A': ENTRY('as-A') });
  });

  test('first writer wins: a second writer with different inputs gets the first entry back and writes nothing', async () => {
    const { knex, log } = makeStore({ 'svc-1': { structured_notes: { timeOnSiteAdjusted: true } } });
    const first = ENTRY('as-A');
    const second = ENTRY('as-A', { applied: [{ name: 'Second Product' }], checks: [{ key: 'water', status: 'watch' }] });
    await expect(freezeLawnVisitMemory('svc-1', first, knex)).resolves.toEqual(first);
    await expect(freezeLawnVisitMemory('svc-1', second, knex)).resolves.toEqual(first);
    expect(log.updates).toHaveLength(1);
  });

  test('A -> B -> A: each assessment keeps its own entry, and A\'s re-render never overwrites A', async () => {
    const records = { 'svc-1': { structured_notes: { keep: 'me' } } };
    const { knex, log } = makeStore(records);
    const a1 = ENTRY('as-A');
    const b = ENTRY('as-B', { applied: [{ name: 'Re-do Product' }] });
    const a2 = ENTRY('as-A', { applied: [{ name: 'Different Product' }] });
    await freezeLawnVisitMemory('svc-1', a1, knex);
    await expect(freezeLawnVisitMemory('svc-1', b, knex)).resolves.toEqual(b);
    await expect(freezeLawnVisitMemory('svc-1', a2, knex)).resolves.toEqual(a1);
    const map = records['svc-1'].structured_notes.lawnVisitMemory;
    expect(Object.keys(map).sort()).toEqual(['as-A', 'as-B']);
    expect(map['as-A']).toEqual(a1);
    expect(map['as-B']).toEqual(b);
    expect(records['svc-1'].structured_notes.keep).toBe('me');
    expect(log.updates).toHaveLength(2);
  });

  test('a lost race re-reads the winner: the entry a concurrent writer landed between our render and our write', async () => {
    const records = { 'svc-1': { structured_notes: {} } };
    const { knex, state } = makeStore(records);
    const winner = ENTRY('as-A', { applied: [{ name: 'Winner Product' }] });
    state.beforeUpdate = () => { records['svc-1'].structured_notes = { lawnVisitMemory: { 'as-A': winner } }; };
    await expect(freezeLawnVisitMemory('svc-1', ENTRY('as-A'), knex)).resolves.toEqual(winner);
  });

  test('failure (write or read-back) returns null and warns, never throws', async () => {
    const records = { 'svc-1': { structured_notes: {} } };
    const w = makeStore(records);
    w.state.failUpdate = true;
    await expect(freezeLawnVisitMemory('svc-1', ENTRY('as-A'), w.knex)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('freeze failed'));

    // Lost the race, then the read-back fails too.
    const r = makeStore({ 'svc-1': { structured_notes: { lawnVisitMemory: { 'as-A': ENTRY('as-A') } } } });
    r.state.failRead = true;
    await expect(freezeLawnVisitMemory('svc-1', ENTRY('as-A'), r.knex)).resolves.toBeNull();
  });

  test('a winner in a shape this version cannot read is not adopted (null, so the render is uncacheable)', async () => {
    const { knex } = makeStore({ 'svc-1': { structured_notes: { lawnVisitMemory: { 'as-A': { v: 99, assessmentId: 'as-A' } } } } });
    await expect(freezeLawnVisitMemory('svc-1', ENTRY('as-A'), knex)).resolves.toBeNull();
  });

  test('nothing to write without a record id, an assessment id or a knex handle', async () => {
    const { knex, log } = makeStore({});
    await expect(freezeLawnVisitMemory(null, ENTRY('as-A'), knex)).resolves.toBeNull();
    await expect(freezeLawnVisitMemory('svc-1', { ...ENTRY('as-A'), assessmentId: null }, knex)).resolves.toBeNull();
    await expect(freezeLawnVisitMemory('svc-1', ENTRY('as-A'), undefined)).resolves.toBeNull();
    expect(log.tables).toHaveLength(0);
  });
});

describe('resolveVisitMemoryForRender', () => {
  beforeEach(() => jest.clearAllMocks());
  const priorMemory = ENTRY('as-P', { serviceDate: '2026-08-01', applied: [{ name: 'Prior Product', activeIngredient: 'Azoxystrobin', kind: 'fungicide', tag: 'fungus protection', targets: [] }], checks: [{ key: 'water', status: 'watch' }] });
  const base = (records, over = {}) => ({
    serviceRecordId: 'svc-cur', customerId: 'cust-1', reportV2: REPORT(), assessmentId: 'as-C', serviceDate: '2026-09-02',
    priorVisit: { assessmentId: 'as-P', serviceRecordId: 'svc-prior', date: '2026-08-01' },
    structuredNotes: records['svc-cur']?.structured_notes,
    ...over,
  });
  const world = () => ({
    'svc-cur': { customer_id: 'cust-1', structured_notes: {} },
    'svc-prior': { customer_id: 'cust-1', structured_notes: { lawnVisitMemory: { 'as-P': priorMemory } } },
  });

  test('first render: builds this visit\'s entry, freezes it WITH the sinceLast from the prior\'s frozen entry', async () => {
    const records = world();
    const { knex } = makeStore(records);
    const out = await resolveVisitMemoryForRender({ ...base(records), knex });
    expect(out.unfrozen).toBe(false);
    expect(out.sinceLast).toMatchObject({ priorAssessmentId: 'as-P', priorDate: '2026-08-01', applied: [{ name: 'Prior Product' }], checks: [{ key: 'water', status: 'watch' }] });
    const frozen = records['svc-cur'].structured_notes.lawnVisitMemory['as-C'];
    expect(frozen).toMatchObject({ v: 1, assessmentId: 'as-C', serviceDate: '2026-09-02', sinceLast: out.sinceLast });
    expect(frozen.applied[0].name).toBe('Test Fungicide A');
  });

  test('a re-render replays the frozen entry byte for byte: no reads, no writes, even after the prior changes or a newer visit lands', async () => {
    const records = world();
    const s1 = makeStore(records);
    const first = await resolveVisitMemoryForRender({ ...base(records), knex: s1.knex });

    // The prior's memory is rewritten and a different prior is offered: none of it matters.
    records['svc-prior'].structured_notes = { lawnVisitMemory: { 'as-P': ENTRY('as-P', { applied: [{ name: 'Changed' }], checks: [] }) } };
    const s2 = makeStore(records);
    const again = await resolveVisitMemoryForRender({
      ...base(records, { priorVisit: { assessmentId: 'as-Q', serviceRecordId: 'svc-q', date: '2026-08-20' }, reportV2: REPORT({ insights: [] }) }),
      knex: s2.knex,
    });
    expect(JSON.stringify(again.sinceLast)).toBe(JSON.stringify(first.sinceLast));
    expect(s2.log.tables).toHaveLength(0);
  });

  test('the block serializes identically whichever path produced it (jsonb reorders keys when it stores them)', async () => {
    const records = world();
    const { knex } = makeStore(records);
    const first = await resolveVisitMemoryForRender({ ...base(records), knex });
    // Postgres hands the stored entry back with its own key order.
    const stored = records['svc-cur'].structured_notes.lawnVisitMemory['as-C'];
    const reverseKeys = (v) => {
      if (Array.isArray(v)) return v.map(reverseKeys);
      if (v && typeof v === 'object') return Object.keys(v).reverse().reduce((o, k) => ({ ...o, [k]: reverseKeys(v[k]) }), {});
      return v;
    };
    const reordered = { sinceLast: reverseKeys(stored.sinceLast) };
    expect(JSON.stringify(reordered.sinceLast)).not.toBe(JSON.stringify(stored.sinceLast));
    records['svc-cur'].structured_notes = { lawnVisitMemory: { 'as-C': { ...stored, ...reordered } } };
    const again = await resolveVisitMemoryForRender({ ...base(records), knex });
    expect(JSON.stringify(again.sinceLast)).toBe(JSON.stringify(first.sinceLast));
  });

  test('degraded inputs: nothing is written, the prior\'s block is still served read-only, the render is unfrozen', async () => {
    const records = world();
    const { knex, log } = makeStore(records);
    const out = await resolveVisitMemoryForRender({ ...base(records), knex, degraded: true });
    expect(out.unfrozen).toBe(true);
    expect(out.sinceLast).toMatchObject({ priorAssessmentId: 'as-P' });
    expect(log.updates).toHaveLength(0);
    expect(records['svc-cur'].structured_notes.lawnVisitMemory).toBeUndefined();
    // No prior read failure hides behind it either.
    const f = makeStore(world());
    f.state.failRead = true;
    expect(await resolveVisitMemoryForRender({ ...base(records), knex: f.knex, degraded: true })).toEqual({ sinceLast: null, unfrozen: true });
  });

  test('degraded inputs never block a replay of an existing entry', async () => {
    const records = world();
    const { knex } = makeStore(records);
    const first = await resolveVisitMemoryForRender({ ...base(records), knex });
    const s2 = makeStore(records);
    const again = await resolveVisitMemoryForRender({ ...base(records), knex: s2.knex, degraded: true });
    expect(again).toEqual({ sinceLast: first.sinceLast, unfrozen: false });
    expect(s2.log.tables).toHaveLength(0);
  });

  test('no prior: freezes the entry with sinceLast null, and returns none', async () => {
    const records = world();
    const { knex, log } = makeStore(records);
    const out = await resolveVisitMemoryForRender({ ...base(records, { priorVisit: null }), knex });
    expect(out).toEqual({ sinceLast: null, unfrozen: false });
    expect(records['svc-cur'].structured_notes.lawnVisitMemory['as-C'].sinceLast).toBeNull();
    expect(log.reads).toHaveLength(0);
  });

  test('a prior with no frozen memory gives no block, and never falls back to a live service_products read', async () => {
    const records = world();
    records['svc-prior'].structured_notes = {};
    const { knex, log } = makeStore(records);
    const out = await resolveVisitMemoryForRender({ ...base(records), knex });
    expect(out).toEqual({ sinceLast: null, unfrozen: false });
    expect(new Set(log.tables)).toEqual(new Set(['service_records']));
  });

  test('the prior record is read for this customer only', async () => {
    const records = world();
    records['svc-prior'].customer_id = 'someone-else';
    const { knex } = makeStore(records);
    const out = await resolveVisitMemoryForRender({ ...base(records), knex });
    expect(out.sinceLast).toBeNull();
  });

  test('a failed prior read is unknown, not absent: nothing is frozen and the render is unfrozen', async () => {
    const records = world();
    const { knex, state, log } = makeStore(records);
    state.failRead = true;
    const out = await resolveVisitMemoryForRender({ ...base(records), knex });
    expect(out).toEqual({ sinceLast: null, unfrozen: true });
    expect(log.updates).toHaveLength(0);
    expect(records['svc-cur'].structured_notes.lawnVisitMemory).toBeUndefined();
  });

  test('a failed freeze still serves the computed block but marks the render unfrozen', async () => {
    const records = world();
    const { knex, state } = makeStore(records);
    state.failUpdate = true;
    const out = await resolveVisitMemoryForRender({ ...base(records), knex });
    expect(out.unfrozen).toBe(true);
    expect(out.sinceLast).toMatchObject({ priorAssessmentId: 'as-P' });
  });

  test('a lost race adopts the winner\'s sinceLast, so both renders agree', async () => {
    const records = world();
    const { knex, state } = makeStore(records);
    const winnerSinceLast = { v: 1, priorAssessmentId: 'as-W', priorDate: '2026-07-01', applied: [{ name: 'Winner' }], checks: [] };
    state.beforeUpdate = () => {
      records['svc-cur'].structured_notes = { lawnVisitMemory: { 'as-C': ENTRY('as-C', { sinceLast: winnerSinceLast }) } };
    };
    const out = await resolveVisitMemoryForRender({ ...base(records), knex });
    expect(out).toEqual({ sinceLast: winnerSinceLast, unfrozen: false });
  });

  test('nothing to build (no report) freezes nothing and is not an error', async () => {
    const records = world();
    const { knex, log } = makeStore(records);
    const out = await resolveVisitMemoryForRender({ ...base(records, { reportV2: null }), knex });
    expect(out).toEqual({ sinceLast: null, unfrozen: false });
    expect(log.tables).toHaveLength(0);
  });
});

describe('GATE_LAWN_VISIT_MEMORY reader', () => {
  const OLD = process.env.GATE_LAWN_VISIT_MEMORY;
  afterEach(() => { if (OLD === undefined) delete process.env.GATE_LAWN_VISIT_MEMORY; else process.env.GATE_LAWN_VISIT_MEMORY = OLD; });

  test('dark by default, read at call time, 1/true/on', () => {
    delete process.env.GATE_LAWN_VISIT_MEMORY;
    expect(featureGates.lawnVisitMemoryLive()).toBe(false);
    for (const v of ['true', '1', 'on']) { process.env.GATE_LAWN_VISIT_MEMORY = v; expect(featureGates.lawnVisitMemoryLive()).toBe(true); }
    process.env.GATE_LAWN_VISIT_MEMORY = 'false';
    expect(featureGates.lawnVisitMemoryLive()).toBe(false);
  });
});

describe('fail-soft reads can report a failure without changing what they return', () => {
  const { getTurfHeightForVisit, getTurfHeightTrend } = require('../services/turf-height-service');
  const failing = () => jest.fn(() => { throw new Error('read failed'); });
  const returning = (row) => jest.fn(() => ({ where: () => ({ first: async () => row, orderBy: () => ({ limit: () => ({ select: async () => [row] }) }) }) }));

  test('turf height: a failure still returns null / [] and calls onFailure; an absence does not', async () => {
    const onFailure = jest.fn();
    await expect(getTurfHeightForVisit('svc-1', failing(), { onFailure })).resolves.toBeNull();
    await expect(getTurfHeightTrend('cust-1', 12, failing(), null, { onFailure })).resolves.toEqual([]);
    expect(onFailure).toHaveBeenCalledTimes(2);
    const quiet = jest.fn();
    await expect(getTurfHeightForVisit('svc-1', returning(null), { onFailure: quiet })).resolves.toBeNull();
    expect(quiet).not.toHaveBeenCalled();
    // The default call shape (no options) is unchanged.
    await expect(getTurfHeightForVisit('svc-1', failing())).resolves.toBeNull();
    await expect(getTurfHeightTrend('cust-1', 12, failing())).resolves.toEqual([]);
  });
});
