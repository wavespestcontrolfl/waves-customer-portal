// Guards the exception-based review-tier system (owner directive 2026-07-06:
// "exception-based review, not manual approval of everything"):
//  - classifier maps confidence + compliance signals + contradictions to
//    green/yellow/red with auditable flags
//  - generatePage stamps tier/status; red → pending_review; approval is
//    sticky while the risk reasons are unchanged; a human block holds; a
//    manual tier pin survives regeneration
//  - reviewPage / setTierOverride / getReviewQueue service methods
//  - trusted filters: searchWiki({trustedOnly}) and the estimate/knowledge
//    consumers only read auto/approved pages

jest.mock('../models/db', () => {
  const fn = (table) => global.__tierDbMock(table);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/lawn-grass-context', () => ({
  loadCustomerGrassContext: jest.fn(async () => ({})),
  irrigationTypeHasSystem: jest.fn(() => null),
}));
jest.mock('@anthropic-ai/sdk', () => {
  return class MockAnthropic {
    constructor() {
      this.messages = { create: (...args) => global.__anthropicCreate(...args) };
    }
  };
});

const wiki = require('../services/agronomic-wiki');
const { classifyReviewTier, sameFlagSets } = wiki.__private;

function makeDb(responses = {}) {
  const state = { responses, calls: {}, inserts: {}, updates: {}, deletes: {} };
  const dbFn = (table) => {
    const rec = { table, ops: [] };
    (state.calls[table] = state.calls[table] || []).push(rec);
    const callIdx = state.calls[table].length - 1;
    const resolveRows = () => {
      const conf = state.responses[table];
      if (typeof conf === 'function') return conf(rec, callIdx) || [];
      if (Array.isArray(conf)) return conf;
      return [];
    };
    const b = {};
    for (const m of ['where', 'andWhere', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereIn', 'whereNotIn', 'orderBy', 'orderByRaw', 'limit', 'offset', 'select', 'groupBy']) {
      b[m] = (...args) => {
        rec.ops.push([m, args]);
        if (typeof args[0] === 'function') args[0].call(b);
        return b;
      };
    }
    b.first = async (...args) => { rec.ops.push(['first', args]); return resolveRows()[0] ?? null; };
    b.insert = (row) => {
      rec.ops.push(['insert', [row]]);
      (state.inserts[table] = state.inserts[table] || []).push(row);
      return {
        returning: async () => [{ id: `${table}-${(state.inserts[table] || []).length}`, ...row }],
        then: (res, rej) => Promise.resolve([1]).then(res, rej),
      };
    };
    b.update = (patch) => {
      rec.ops.push(['update', [patch]]);
      (state.updates[table] = state.updates[table] || []).push(patch);
      return {
        returning: async () => [{ ...(resolveRows()[0] || {}), ...patch }],
        then: (res, rej) => Promise.resolve(1).then(res, rej),
      };
    };
    b.del = async () => { state.deletes[table] = (state.deletes[table] || 0) + 1; return 1; };
    b.then = (res, rej) => {
      let rows;
      try { rows = resolveRows(); } catch (err) { return Promise.reject(err).then(res, rej); }
      return Promise.resolve(rows).then(res, rej);
    };
    return b;
  };
  dbFn.state = state;
  return dbFn;
}

function useDb(responses) {
  const dbFn = makeDb(responses);
  global.__tierDbMock = dbFn;
  return dbFn.state;
}

const CLEAN_TEXT = '# Page\n\n*Field intelligence from Waves treatment outcomes — not label guidance.*\n\nOutcome prose.';

beforeEach(() => {
  global.__anthropicCreate = jest.fn(async () => ({
    content: [{ text: CLEAN_TEXT }],
    usage: { input_tokens: 10, output_tokens: 20 },
    model: 'test-model',
  }));
});

// ── classifier ─────────────────────────────────────────────────────────────

describe('classifyReviewTier', () => {
  test('low confidence → red with low_confidence flag', () => {
    expect(classifyReviewTier({ confidence: 'low', content: 'plain prose' }))
      .toEqual({ tier: 'red', flags: ['low_confidence'] });
  });

  test('moderate confidence → yellow', () => {
    expect(classifyReviewTier({ confidence: 'moderate', content: 'plain prose' }).tier).toBe('yellow');
  });

  test('high confidence, clean content → green', () => {
    expect(classifyReviewTier({ confidence: 'high', content: 'plain prose' }))
      .toEqual({ tier: 'green', flags: [] });
  });

  test('compliance signals force red at any confidence', () => {
    for (const phrase of ['the June blackout window', 'per county ordinance', 'local ordinances require', 'REI is 12 hours', 'rei is 12 hours', 're-entry interval of 4 hours', 'reentry interval of 4 hours', 'do not apply to bahia', 'do-not-apply on bahia', 'phytotoxicity risk']) {
      const { tier, flags } = classifyReviewTier({ confidence: 'very_high', content: phrase });
      expect(tier).toBe('red');
      expect(flags).toContain('compliance_content');
    }
  });

  test('open contradiction and external source force red', () => {
    expect(classifyReviewTier({ confidence: 'high', content: 'x', hasOpenContradiction: true }).tier).toBe('red');
    expect(classifyReviewTier({ confidence: 'high', content: 'x', externalSource: true }).tier).toBe('red');
  });

  test('sameFlagSets is order-insensitive and parses JSON strings', () => {
    expect(sameFlagSets(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameFlagSets('["a"]', ['a'])).toBe(true);
    expect(sameFlagSets(['a'], ['a', 'b'])).toBe(false);
  });
});

// ── generatePage stamping ──────────────────────────────────────────────────

describe('generatePage review stamping', () => {
  test('new low-confidence page → red / pending_review with flags stored', async () => {
    const state = useDb({ knowledge_entries: [] });

    await wiki.generatePage('product/new-thing', 'product', { outcomes: [{ id: 'o1' }] }, 'Product: New Thing');

    const row = state.inserts.knowledge_entries[0];
    expect(row.review_tier).toBe('red');
    expect(row.review_status).toBe('pending_review');
    expect(JSON.parse(row.risk_flags)).toContain('low_confidence');
  });

  test('approval is sticky while risk reasons are unchanged', async () => {
    const existing = {
      id: 'ke-1', slug: 'product/talstar-p',
      content: '# Old\n\nReal content.', data_point_count: 2,
      source_treatment_ids: ['o1', 'o2'], stale_flag: false,
      review_tier: 'red', review_status: 'approved', risk_flags: ['low_confidence'],
    };
    const state = useDb({ knowledge_entries: [existing], knowledge_contradictions: [] });

    await wiki.generatePage('product/talstar-p', 'product', { outcomes: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }] }, 'Product: Talstar P');

    const patch = state.updates.knowledge_entries[0];
    expect(patch.review_tier).toBe('red');
    expect(patch.review_status).toBe('approved'); // same reasons → no re-block
  });

  test('a NEW risk reason re-blocks an approved page', async () => {
    const existing = {
      id: 'ke-1', slug: 'product/talstar-p',
      content: '# Old\n\nReal content.', data_point_count: 2,
      source_treatment_ids: ['o1', 'o2'], stale_flag: false,
      review_tier: 'red', review_status: 'approved', risk_flags: ['low_confidence'],
    };
    const state = useDb({
      knowledge_entries: [existing],
      knowledge_contradictions: [{ id: 'kc-1' }], // an open contradiction appeared
    });

    await wiki.generatePage('product/talstar-p', 'product', { outcomes: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }] }, 'Product: Talstar P');

    const patch = state.updates.knowledge_entries[0];
    expect(patch.review_status).toBe('pending_review');
    expect(JSON.parse(patch.risk_flags)).toContain('open_contradiction');
  });

  test('a human block holds through regeneration', async () => {
    const existing = {
      id: 'ke-1', slug: 'product/talstar-p',
      content: '# Old\n\nReal content.', data_point_count: 2,
      source_treatment_ids: ['o1', 'o2'], stale_flag: false,
      review_tier: 'yellow', review_status: 'blocked', risk_flags: ['moderate_confidence'],
    };
    const state = useDb({ knowledge_entries: [existing], knowledge_contradictions: [] });

    await wiki.generatePage('product/talstar-p', 'product', { outcomes: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }] }, 'Product: Talstar P');

    expect(state.updates.knowledge_entries[0].review_status).toBe('blocked');
  });

  test('a manual tier pin survives regeneration untouched', async () => {
    const existing = {
      id: 'ke-1', slug: 'product/talstar-p',
      content: '# Old\n\nReal content.', data_point_count: 2,
      source_treatment_ids: ['o1', 'o2'], stale_flag: false,
      review_tier: 'green', review_status: 'auto', risk_flags: ['low_confidence', 'manual_override'],
    };
    const state = useDb({ knowledge_entries: [existing], knowledge_contradictions: [] });

    await wiki.generatePage('product/talstar-p', 'product', { outcomes: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }] }, 'Product: Talstar P');

    const patch = state.updates.knowledge_entries[0];
    expect(patch.review_tier).toBe('green');
    expect(patch.review_status).toBe('auto');
    expect(JSON.parse(patch.risk_flags)).toContain('manual_override');
  });

  test('a successful regeneration drops the stale generation_stub flag from a red-pinned stub', async () => {
    // Red-pinned stub → retry succeeds with real content. The stub flag must
    // not outlive the placeholder, or approve/pin actions stay locked out.
    const existing = {
      id: 'ke-1', slug: 'product/talstar-p',
      content: '# Product: Talstar P\n\n*Pending AI generation — 2 data points available.*',
      data_point_count: 2, source_treatment_ids: ['o1'], stale_flag: false,
      review_tier: 'red', review_status: 'pending_review',
      risk_flags: ['generation_stub', 'manual_override'],
    };
    const state = useDb({ knowledge_entries: [existing], knowledge_contradictions: [], knowledge_base: [] });

    await wiki.generatePage('product/talstar-p', 'product', { outcomes: [{ id: 'o1' }, { id: 'o2' }] }, 'Product: Talstar P');

    const patch = state.updates.knowledge_entries[0];
    const flags = JSON.parse(patch.risk_flags);
    expect(flags).not.toContain('generation_stub');
    expect(flags).toContain('manual_override'); // the pin itself survives
  });
});

describe('KB-copy trust propagation', () => {
  test('reviewPage block flips the synced KB copy to flagged', async () => {
    const page = { id: 'ke-1', slug: 'product/talstar-p', human_notes: null };
    const state = useDb({ knowledge_entries: [page], knowledge_base: [] });

    await wiki.reviewPage('product/talstar-p', { action: 'block', reviewedBy: 'admin' });

    expect(state.updates.knowledge_base).toEqual([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]);
    const kbCall = state.calls.knowledge_base[0];
    const whereObj = kbCall.ops.find(([m, a]) => m === 'where' && typeof a[0] === 'object')[1][0];
    expect(whereObj).toEqual({ wiki_entry_id: 'ke-1', source: 'wiki-sync' });
  });

  test('reviewPage approve flips the synced KB copy back to active', async () => {
    const page = { id: 'ke-1', slug: 'product/talstar-p', human_notes: null };
    const state = useDb({ knowledge_entries: [page], knowledge_base: [] });

    await wiki.reviewPage('product/talstar-p', { action: 'approve', reviewedBy: 'admin' });

    expect(state.updates.knowledge_base).toEqual([
      expect.objectContaining({ status: 'active', active: true }),
    ]);
  });

  test('AI failure on a page with a new contradiction re-gates it and flags the KB copy', async () => {
    const existing = {
      id: 'ke-1', slug: 'track/st-augustine',
      content: '# Track\n\nReal content.', data_point_count: 22, confidence: 'high',
      source_treatment_ids: ['o1'], stale_flag: false,
      review_tier: 'green', review_status: 'auto', risk_flags: [],
    };
    const state = useDb({
      knowledge_entries: [existing],
      knowledge_contradictions: [{ id: 'kc-1' }],
      knowledge_base: [],
    });
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    // different ids → not the skip path; failure path must still re-resolve
    const result = await wiki.generatePage('track/st-augustine', 'track', {
      outcomes: [{ id: 'oX' }], totalOutcomeCount: 23, allOutcomeIds: ['oX'],
    }, 'Track st_augustine Performance');

    expect(result.writeState).toBe('failed');
    expect(result.entry.review_status).toBe('pending_review');
    const patch = state.updates.knowledge_entries.find((u) => u.review_status);
    expect(patch.review_status).toBe('pending_review');
    expect(state.updates.knowledge_base).toEqual([
      expect.objectContaining({ status: 'flagged' }),
    ]);
  });

  test('a generation stub is never trusted, whatever its confidence', async () => {
    const state = useDb({ knowledge_entries: [], knowledge_base: [] });
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    // 60 data points → very_high confidence, but the content is a stub
    await wiki.generatePage('track/st-augustine', 'track', {
      outcomes: Array.from({ length: 50 }, (_, i) => ({ id: `o${i}` })),
      totalOutcomeCount: 60,
      allOutcomeIds: Array.from({ length: 60 }, (_, i) => `o${i}`),
    }, 'Track st_augustine Performance');

    const row = state.inserts.knowledge_entries[0];
    expect(row.content).toContain('Pending AI generation');
    expect(row.review_tier).toBe('red');
    expect(row.review_status).toBe('pending_review');
    expect(JSON.parse(row.risk_flags)).toContain('generation_stub');
  });
});

describe('resync trust preservation', () => {
  test('syncToClaudeopedia writes mirrors gated by the source page trust', async () => {
    const KnowledgeBridge = require('../services/knowledge-bridge');
    const state = useDb({
      knowledge_entries: [
        { id: 'w1', slug: 'product/trusted', title: 'Product: Trusted', category: 'product', summary: 's', data_point_count: 9, confidence: 'moderate', content: '# Real', review_status: 'auto' },
        { id: 'w2', slug: 'product/red', title: 'Product: Red', category: 'product', summary: 's', data_point_count: 2, confidence: 'low', content: '# Real too', review_status: 'pending_review' },
      ],
      knowledge_base: [],
      knowledge_bridge: [],
    });

    await KnowledgeBridge.syncToClaudeopedia();

    const rows = state.inserts.knowledge_base || [];
    const trusted = rows.find((r) => r.slug === 'outcomes-product-trusted');
    const red = rows.find((r) => r.slug === 'outcomes-product-red');
    expect(trusted).toMatchObject({ status: 'active', active: true });
    // a resync must never resurrect (or freshly create) an ungated mirror
    // of an untrusted page — both the status field and the active boolean
    expect(red).toMatchObject({ status: 'flagged', active: false });
  });

  test('a failed refresh classifies with the FRESH confidence, not the stored one', async () => {
    const existing = {
      id: 'ke-1', slug: 'track/st-augustine',
      content: '# Track\n\nReal content.', data_point_count: 22, confidence: 'high',
      source_treatment_ids: Array.from({ length: 22 }, (_, i) => `o${i}`), stale_flag: false,
      review_tier: 'green', review_status: 'auto', risk_flags: [],
    };
    const state = useDb({
      knowledge_entries: [existing],
      knowledge_contradictions: [],
      knowledge_base: [],
    });
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    // the source set shrank to 2 points → fresh confidence is 'low' → red
    await wiki.generatePage('track/st-augustine', 'track', {
      outcomes: [{ id: 'oA' }, { id: 'oB' }], totalOutcomeCount: 2, allOutcomeIds: ['oA', 'oB'],
    }, 'Track st_augustine Performance');

    const patch = (state.updates.knowledge_entries || []).find((u) => u.review_status);
    expect(patch.review_tier).toBe('red');
    expect(patch.review_status).toBe('pending_review');
    expect(JSON.parse(patch.risk_flags)).toContain('low_confidence');
  });
});

describe('post-merge contradiction recheck', () => {
  test('a contradiction inherited from a merged variant re-gates the canonical page', async () => {
    const CANON_SLUG = 'product/lesco-high-manganese-combo';
    const state = useDb({
      products_catalog: (rec, idx) => (idx === 0 ? [] : [{ id: 'pc-1', name: 'LESCO High Manganese Combo' }]),
      product_aliases: (rec, idx) => (idx === 0 ? [{ product_id: 'pc-1' }] : [{ alias_name: 'LESCO HMC Variant' }]),
      treatment_outcomes: Array.from({ length: 25 }, (_, i) => ({ id: `o${i}`, treatment_date: '2026-07-04', grass_track: 'st_augustine', products_applied: [] })),
      knowledge_entries: (rec) => {
        const whereObj = rec.ops.find(([m, a]) => m === 'where' && a[0] && typeof a[0] === 'object')?.[1][0];
        if (whereObj?.slug && whereObj.slug !== CANON_SLUG) return [{ id: 'ke-dupe', slug: whereObj.slug, kb_entry_id: null }];
        return [];
      },
      // the canonical page is NEW (no pre-merge contradiction lookup runs);
      // the variant's contradiction is discovered by the post-merge recheck
      knowledge_contradictions: [{ id: 'kc-1' }],
      knowledge_bridge: [],
      knowledge_base: [],
    });

    const entry = await wiki.updateProductPage('LESCO HMC Variant');

    // 25 pts + clean content → initially high/green, but the inherited
    // contradiction must re-gate it after the merge
    expect(entry.review_status).toBe('pending_review');
    const regate = (state.updates.knowledge_entries || []).find((u) => u.review_status === 'pending_review');
    expect(regate).toBeTruthy();
    expect(JSON.parse(regate.risk_flags)).toContain('open_contradiction');
    // and the unconditional post-merge mirror alignment flags moved mirrors
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]));
  });

  test('inherited contradiction flags persist even when the page is already red for another reason', async () => {
    // 3 outcomes → low confidence → the canonical page is red/pending_review
    // BEFORE the merge recheck. The inherited contradiction changes neither
    // tier nor status — but its identity must still enter risk_flags, or a
    // later approval's sticky snapshot silently absorbs it.
    const CANON_SLUG = 'product/lesco-high-manganese-combo';
    const state = useDb({
      products_catalog: (rec, idx) => (idx === 0 ? [] : [{ id: 'pc-1', name: 'LESCO High Manganese Combo' }]),
      product_aliases: (rec, idx) => (idx === 0 ? [{ product_id: 'pc-1' }] : [{ alias_name: 'LESCO HMC Variant' }]),
      treatment_outcomes: Array.from({ length: 3 }, (_, i) => ({ id: `o${i}`, treatment_date: '2026-07-04', grass_track: 'st_augustine', products_applied: [] })),
      knowledge_entries: (rec) => {
        const whereObj = rec.ops.find(([m, a]) => m === 'where' && a[0] && typeof a[0] === 'object')?.[1][0];
        if (whereObj?.slug && whereObj.slug !== CANON_SLUG) return [{ id: 'ke-dupe', slug: whereObj.slug, kb_entry_id: null }];
        return [];
      },
      knowledge_contradictions: [{ id: 'kc-1' }],
      knowledge_bridge: [],
      knowledge_base: [],
    });

    const entry = await wiki.updateProductPage('LESCO HMC Variant');

    expect(entry.review_status).toBe('pending_review'); // unchanged by the recheck
    const flagPatch = (state.updates.knowledge_entries || [])
      .map((u) => u.risk_flags && JSON.parse(u.risk_flags))
      .filter(Boolean)
      .find((f) => f.includes('contradiction:kc-1'));
    expect(flagPatch).toBeTruthy();
    expect(flagPatch).toEqual(expect.arrayContaining(['low_confidence', 'open_contradiction', 'contradiction:kc-1']));
  });
});

describe('skip-path reclassification', () => {
  test('a new contradiction re-gates a trusted page even when data is unchanged', async () => {
    const existing = {
      id: 'ke-1', slug: 'track/st-augustine',
      content: '# Track\n\nReal content.', data_point_count: 22,
      source_treatment_ids: ['o1', 'o2'], stale_flag: false,
      review_tier: 'green', review_status: 'auto', risk_flags: [],
    };
    const state = useDb({
      knowledge_entries: [existing],
      knowledge_contradictions: [{ id: 'kc-1' }], // appeared since last write
    });

    // same ids/count → skip path, but the review state must still update
    await wiki.generatePage('track/st-augustine', 'track', {
      outcomes: [{ id: 'o1' }, { id: 'o2' }],
      totalOutcomeCount: 22,
      allOutcomeIds: ['o1', 'o2'],
    }, 'Track st_augustine Performance');

    expect(global.__anthropicCreate).not.toHaveBeenCalled(); // still skipped
    const patch = state.updates.knowledge_entries[0];
    expect(patch.review_tier).toBe('red');
    expect(patch.review_status).toBe('pending_review');
    expect(JSON.parse(patch.risk_flags)).toContain('open_contradiction');
  });

  test('the skip path returns the POST-update review fields, not the stale row', async () => {
    // Page was gated by a contradiction that has since been resolved: the
    // skip path reclassifies it back to trusted. Callers (post-merge mirror
    // alignment) act on the returned entry's trust — a stale pre-update row
    // would immediately re-flag the mirror this skip pass just reactivated.
    const existing = {
      id: 'ke-1', slug: 'track/st-augustine',
      content: '# Track\n\nReal content.', data_point_count: 22,
      source_treatment_ids: ['o1', 'o2'], stale_flag: false,
      review_tier: 'red', review_status: 'pending_review',
      risk_flags: ['open_contradiction'],
    };
    const state = useDb({
      knowledge_entries: [existing],
      knowledge_contradictions: [], // resolved since the last write
      knowledge_base: [],
    });

    const result = await wiki.generatePage('track/st-augustine', 'track', {
      outcomes: [{ id: 'o1' }, { id: 'o2' }],
      totalOutcomeCount: 22,
      allOutcomeIds: ['o1', 'o2'],
    }, 'Track st_augustine Performance');

    expect(result.writeState).toBe('skipped');
    expect(result.entry.review_status).toBe('auto');
    expect(result.entry.review_tier).toBe('green');
    // and the skip path itself re-trusted the mirror
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'active', active: true }),
    ]));
  });
});

describe('contradiction gate recompute', () => {
  test('recomputeEntryReviewGate flips a trusted page and its KB mirror on a new contradiction', async () => {
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'green', review_status: 'auto', risk_flags: [],
      }],
      knowledge_contradictions: [{ id: 'kc-1' }],
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    const patch = (state.updates.knowledge_entries || [])[0];
    expect(patch.review_tier).toBe('red');
    expect(patch.review_status).toBe('pending_review');
    expect(JSON.parse(patch.risk_flags)).toEqual(expect.arrayContaining(['open_contradiction', 'contradiction:kc-1']));
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]));
  });

  test('a SECOND contradiction re-gates a page approved despite the first one', async () => {
    // Approval was granted while kc-1 was open (its identity is in the risk
    // state). kc-2 arriving changes the flag set, so sticky approval must
    // not absorb it.
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'red', review_status: 'approved',
        risk_flags: ['open_contradiction', 'contradiction:kc-1'],
      }],
      knowledge_contradictions: [{ id: 'kc-1' }, { id: 'kc-2' }],
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    const patch = (state.updates.knowledge_entries || [])[0];
    expect(patch.review_status).toBe('pending_review');
    expect(JSON.parse(patch.risk_flags)).toContain('contradiction:kc-2');
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]));
  });

  test('approval stays sticky while the SAME contradictions are open', async () => {
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'red', review_status: 'approved',
        risk_flags: ['open_contradiction', 'contradiction:kc-1'],
      }],
      knowledge_contradictions: [{ id: 'kc-1' }],
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    expect(state.updates.knowledge_entries).toBeUndefined(); // no state change
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'active', active: true }), // approved = trusted
    ]));
  });

  test('clearing the last contradiction un-gates the page and mirror immediately', async () => {
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'red', review_status: 'pending_review',
        risk_flags: ['open_contradiction', 'contradiction:kc-1'],
      }],
      knowledge_contradictions: [], // resolved/dismissed via the PATCH route
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    const patch = (state.updates.knowledge_entries || [])[0];
    expect(patch.review_tier).toBe('green');
    expect(patch.review_status).toBe('auto');
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'active', active: true }),
    ]));
  });

  test('approval survives a risk SHRINK — resolving one of two reasons keeps it approved', async () => {
    // Approved red page with two risk reasons; the contradiction is resolved,
    // low confidence remains. The new flag set is a SUBSET of the approved
    // one — no unapproved risk appeared, so the approval holds and the
    // mirror stays trusted.
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'low',
        review_tier: 'red', review_status: 'approved',
        risk_flags: ['low_confidence', 'open_contradiction', 'contradiction:kc-1'],
      }],
      knowledge_contradictions: [],
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    const patch = (state.updates.knowledge_entries || [])[0];
    expect(patch.review_status).toBe('approved'); // flags shrank → still approved
    expect(JSON.parse(patch.risk_flags)).toEqual(['low_confidence']);
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'active', active: true }),
    ]));
  });

  test('a placeholder stub stays gated through recomputes — clearing its contradiction cannot trust it', async () => {
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/talstar-p',
        content: '# Product: Talstar P\n\n*Pending AI generation — 30 data points available.*',
        confidence: 'high',
        review_tier: 'red', review_status: 'pending_review',
        risk_flags: ['generation_stub', 'open_contradiction', 'contradiction:kc-1'],
      }],
      knowledge_contradictions: [], // last blocker cleared
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    const patch = (state.updates.knowledge_entries || [])[0];
    expect(patch.review_tier).toBe('red');
    expect(patch.review_status).toBe('pending_review');
    expect(JSON.parse(patch.risk_flags)).toContain('generation_stub');
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]));
  });

  test('a NEW contradiction re-gates a green-pinned page (pins do not outrank live exceptions)', async () => {
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'green', review_status: 'auto',
        risk_flags: ['low_confidence', 'manual_override'],
      }],
      knowledge_contradictions: [{ id: 'kc-1' }],
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    const patch = (state.updates.knowledge_entries || [])[0];
    expect(patch.review_tier).toBe('red');
    expect(patch.review_status).toBe('pending_review');
    const flags = JSON.parse(patch.risk_flags);
    expect(flags).toEqual(expect.arrayContaining(['open_contradiction', 'contradiction:kc-1', 'manual_override']));
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]));
  });

  test('clearing a pinned page contradiction strips the identity flags but keeps it queued', async () => {
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'red', review_status: 'pending_review',
        risk_flags: ['manual_override', 'open_contradiction', 'contradiction:kc-1'],
      }],
      knowledge_contradictions: [],
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    const patch = (state.updates.knowledge_entries || [])[0];
    expect(JSON.parse(patch.risk_flags)).toEqual(['manual_override']);
    // status stays pending_review — a human closes out the exception
    expect(patch.review_status).toBe('pending_review');
  });

  test('recomputeEntryReviewGate RETHROWS write failures (detector dedup means no retry)', async () => {
    const inner = makeDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'green', review_status: 'auto', risk_flags: [],
      }],
      knowledge_contradictions: [{ id: 'kc-1' }],
      knowledge_base: [],
    });
    global.__tierDbMock = (table) => {
      const b = inner(table);
      if (table === 'knowledge_entries') {
        const origUpdate = b.update;
        b.update = (patch) => ({ then: (res, rej) => Promise.reject(new Error('write failed')).then(res, rej), returning: origUpdate(patch).returning });
      }
      return b;
    };

    await expect(wiki.recomputeEntryReviewGate('ke-1')).rejects.toThrow('write failed');
  });

  test('recomputeEntryReviewGate is a no-op without an entry id', async () => {
    const state = useDb({ knowledge_entries: [] });
    await wiki.recomputeEntryReviewGate(null);
    expect(state.updates.knowledge_entries).toBeUndefined();
  });

  test('assumeOpenIds gates a FIRST contradiction even when the lookup fails', async () => {
    // The detector just inserted kc-9 against a trusted page that has no
    // stored contradiction flags. The live lookup fails — the caller-known
    // id must still close the gate.
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'green', review_status: 'auto', risk_flags: [],
      }],
      knowledge_contradictions: () => { throw new Error('relation unavailable'); },
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1', { assumeOpenIds: ['kc-9'] });

    const patch = (state.updates.knowledge_entries || [])[0];
    expect(patch.review_status).toBe('pending_review');
    expect(JSON.parse(patch.risk_flags)).toEqual(expect.arrayContaining(['open_contradiction', 'contradiction:kc-9']));
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]));
  });

  test('a FAILED contradiction lookup preserves the existing gate (fail closed)', async () => {
    // The live query throws; the stored contradiction:kc-1 identity must be
    // treated as still open — the page stays gated and the mirror flagged,
    // instead of being silently trusted on lookup failure.
    const state = useDb({
      knowledge_entries: [{
        id: 'ke-1', slug: 'product/prodiamine',
        content: '# Product\n\nClean prose.', confidence: 'high',
        review_tier: 'red', review_status: 'pending_review',
        risk_flags: ['open_contradiction', 'contradiction:kc-1'],
      }],
      knowledge_contradictions: () => { throw new Error('relation unavailable'); },
      knowledge_base: [],
    });

    await wiki.recomputeEntryReviewGate('ke-1');

    // same reconstructed flag set → no state change, and crucially no
    // downgrade to auto/trusted
    expect(state.updates.knowledge_entries).toBeUndefined();
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]));
  });
});

describe('failed-retry stub gating', () => {
  test('a preserved placeholder stub is never trusted when the retry fails', async () => {
    const existing = {
      id: 'ke-1', slug: 'product/talstar-p',
      content: '# Product: Talstar P\n\n*Pending AI generation — 20 data points available.*',
      data_point_count: 10, source_treatment_ids: ['o1'],
      confidence: 'high',
      review_tier: 'red', review_status: 'pending_review', risk_flags: ['generation_stub'],
    };
    const state = useDb({
      knowledge_entries: [existing],
      knowledge_contradictions: [],
      knowledge_base: [],
    });
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    const result = await wiki.generatePage('product/talstar-p', 'product', {
      outcomes: Array.from({ length: 20 }, (_, i) => ({ id: `o${i}` })),
      totalOutcomeCount: 20,
      allOutcomeIds: Array.from({ length: 20 }, (_, i) => `o${i}`),
    }, 'Product: Talstar P');

    // stub + failed retry: high data-point confidence must NOT re-trust it
    expect(result.writeState).toBe('failed');
    expect(result.entry.review_tier).toBe('red');
    expect(result.entry.review_status).toBe('pending_review');
    expect(JSON.parse(result.entry.risk_flags)).toContain('generation_stub');
    const patch = (state.updates.knowledge_entries || [])[0];
    expect(patch.review_status).toBe('pending_review');
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'flagged', active: false }),
    ]));
  });
});

describe('extractSummary disclaimer handling', () => {
  test('the field-intelligence banner never becomes the summary', () => {
    const { extractSummary } = wiki.__private;
    const content = [
      '# Product: K-Flow',
      '',
      '*Field intelligence from Waves treatment outcomes — not label guidance.*',
      '',
      'Potassium-only base through the summer window.',
    ].join('\n');
    expect(extractSummary(content)).toBe('Potassium-only base through the summer window.');
  });
});

// ── review service methods ─────────────────────────────────────────────────

describe('review service methods', () => {
  test('reviewPage approve stamps status, reviewer and log', async () => {
    const page = { id: 'ke-1', slug: 'product/talstar-p', human_notes: null };
    const state = useDb({ knowledge_entries: [page] });

    const updated = await wiki.reviewPage('product/talstar-p', { action: 'approve', notes: 'looks right', reviewedBy: 'admin' });

    expect(updated.review_status).toBe('approved');
    const patch = state.updates.knowledge_entries[0];
    expect(patch.review_status).toBe('approved');
    expect(patch.last_human_review).toBeInstanceOf(Date);
    expect(patch.reviewed_by).toBe('admin');
    const log = (state.inserts.knowledge_update_log || []).find((r) => r.action === 'review');
    expect(log.trigger_type).toBe('human_review');
  });

  test('reviewPage refuses to approve a generation stub (but can still block it)', async () => {
    const stub = {
      id: 'ke-1', slug: 'product/talstar-p', human_notes: null,
      content: '# Product: Talstar P\n\n*Pending AI generation — 30 data points available.*',
      risk_flags: ['generation_stub'],
    };
    const state = useDb({ knowledge_entries: [stub], knowledge_base: [] });

    await expect(wiki.reviewPage('product/talstar-p', { action: 'approve' }))
      .rejects.toMatchObject({ isOperational: true, statusCode: 409 });
    // nothing written, mirror untouched
    expect(state.updates.knowledge_entries).toBeUndefined();
    expect(state.updates.knowledge_base).toBeUndefined();

    // blocking a stub is still a valid human judgment
    const blocked = await wiki.reviewPage('product/talstar-p', { action: 'block' });
    expect(blocked.review_status).toBe('blocked');
  });

  test('setTierOverride refuses green/yellow pins on a generation stub (red pin allowed)', async () => {
    const stub = {
      id: 'ke-1', slug: 'product/talstar-p',
      content: '# Product: Talstar P\n\n*Pending AI generation — 30 data points available.*',
      risk_flags: ['generation_stub'],
    };
    const state = useDb({ knowledge_entries: [stub], knowledge_base: [] });

    await expect(wiki.setTierOverride('product/talstar-p', 'green'))
      .rejects.toMatchObject({ isOperational: true, statusCode: 409 });
    expect(state.updates.knowledge_entries).toBeUndefined();
    expect(state.updates.knowledge_base).toBeUndefined();

    // pinning red keeps it gated — valid
    const pinned = await wiki.setTierOverride('product/talstar-p', 'red');
    expect(pinned.review_status).toBe('pending_review');
  });

  test('a failed AI-refresh that also fails to WRITE the gate fails the whole call', async () => {
    // AI down AND the review-state write fails while the target state is
    // untrusted (open contradiction): returning writeState 'failed' would
    // read as \"gate applied\" — the call must fail outright instead.
    const existing = {
      id: 'ke-1', slug: 'product/talstar-p',
      content: '# Talstar P\n\nReal content.', data_point_count: 5,
      source_treatment_ids: ['o1'], stale_flag: false,
      review_tier: 'green', review_status: 'auto', risk_flags: [],
    };
    const inner = makeDb({
      knowledge_entries: [existing],
      knowledge_contradictions: [{ id: 'kc-1' }],
      knowledge_base: [],
    });
    global.__tierDbMock = (table) => {
      const b = inner(table);
      if (table === 'knowledge_entries') {
        b.update = () => ({ then: (res, rej) => Promise.reject(new Error('write failed')).then(res, rej) });
      }
      return b;
    };
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    const result = await wiki.generatePage('product/talstar-p', 'product', {
      outcomes: [{ id: 'o1' }, { id: 'o2' }],
    }, 'Product: Talstar P');

    expect(result).toBeNull(); // failed outright, not 'failed-but-gated'
  });

  test('a failed GATING mirror update propagates instead of reading as success', async () => {
    const page = { id: 'ke-1', slug: 'product/talstar-p', human_notes: null, content: '# Real content', risk_flags: [] };
    const inner = makeDb({ knowledge_entries: [page] });
    global.__tierDbMock = (table) => {
      const b = inner(table);
      if (table === 'knowledge_base') {
        b.update = () => ({ then: (res, rej) => Promise.reject(new Error('update failed')).then(res, rej) });
      }
      return b;
    };

    // block = un-trusting the mirror; a failure must surface
    await expect(wiki.reviewPage('product/talstar-p', { action: 'block' }))
      .rejects.toThrow('update failed');
    // approve = re-trusting; a failure is conservative (mirror stays
    // flagged) and must NOT abort the approval
    const approved = await wiki.reviewPage('product/talstar-p', { action: 'approve' });
    expect(approved.review_status).toBe('approved');
  });

  test('reviewPage rejects unknown actions and missing pages', async () => {
    useDb({ knowledge_entries: [] });
    await expect(wiki.reviewPage('x', { action: 'promote' })).rejects.toThrow(/Unsupported review action/);
    expect(await wiki.reviewPage('missing', { action: 'approve' })).toBeNull();
  });

  test('setTierOverride pins the tier and adds manual_override', async () => {
    const page = { id: 'ke-1', slug: 'product/talstar-p', risk_flags: ['low_confidence'] };
    const state = useDb({ knowledge_entries: [page] });

    await wiki.setTierOverride('product/talstar-p', 'green', { reviewedBy: 'admin' });

    const patch = state.updates.knowledge_entries[0];
    expect(patch.review_tier).toBe('green');
    expect(patch.review_status).toBe('auto');
    expect(JSON.parse(patch.risk_flags)).toEqual(expect.arrayContaining(['low_confidence', 'manual_override']));
  });

  test('getReviewQueue buckets pending, blocked and recent yellow', async () => {
    const state = useDb({
      knowledge_entries: (rec, idx) => {
        if (idx === 0) return [{ id: 'p1', review_status: 'pending_review' }];
        if (idx === 1) return [{ id: 'b1', review_status: 'blocked' }];
        return [{ id: 'y1', review_tier: 'yellow' }];
      },
    });

    const queue = await wiki.getReviewQueue();

    expect(queue.pending).toHaveLength(1);
    expect(queue.blocked).toHaveLength(1);
    expect(queue.recentYellow).toHaveLength(1);
    expect(state.calls.knowledge_entries).toHaveLength(3);
  });
});

// ── trusted read filters ───────────────────────────────────────────────────

describe('trusted read filters', () => {
  test('searchWiki filters to trusted statuses only when asked', async () => {
    const state = useDb({ knowledge_entries: [] });

    await wiki.searchWiki('large patch', { trustedOnly: true });
    await wiki.searchWiki('large patch');

    const [trusted, open] = state.calls.knowledge_entries;
    expect(trusted.ops.find(([m, a]) => m === 'whereIn' && a[0] === 'review_status')[1][1]).toEqual(['auto', 'approved']);
    expect(open.ops.find(([m, a]) => m === 'whereIn' && a[0] === 'review_status')).toBeUndefined();
  });

  test('TRUSTED_STATUSES is exported for consumers', () => {
    expect(wiki.TRUSTED_STATUSES).toEqual(['auto', 'approved']);
  });
});
