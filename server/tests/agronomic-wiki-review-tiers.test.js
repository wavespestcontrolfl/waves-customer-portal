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
    for (const phrase of ['the June blackout window', 'per county ordinance', 'REI is 12 hours', 'do not apply to bahia', 'phytotoxicity risk']) {
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
});

describe('KB-copy trust propagation', () => {
  test('reviewPage block flips the synced KB copy to flagged', async () => {
    const page = { id: 'ke-1', slug: 'product/talstar-p', human_notes: null };
    const state = useDb({ knowledge_entries: [page], knowledge_base: [] });

    await wiki.reviewPage('product/talstar-p', { action: 'block', reviewedBy: 'admin' });

    expect(state.updates.knowledge_base).toEqual([
      expect.objectContaining({ status: 'flagged' }),
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
      expect.objectContaining({ status: 'active' }),
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
