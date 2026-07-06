// Guards the agronomic-wiki hardening pass:
//  - a failed AI call never overwrites an existing page with the placeholder
//  - unchanged data skips regeneration instead of paying for a rewrite
//  - product pages key on the canonical catalog product (alias-aware) with
//    LIKE-escaped matching, and variant-named duplicates fold into it
//  - zero-outcome months don't generate seasonal pages
//  - weeklyRefreshIfDue enforces weekly cadence from a daily cron and a
//    failed refresh leaves an error row in the update log
//  - assessment pairing applies recency windows

jest.mock('../models/db', () => {
  const fn = (table) => global.__wikiDbMock(table);
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/lawn-grass-context', () => ({
  loadCustomerGrassContext: jest.fn(async () => ({
    trackKey: 'st_augustine',
    grassType: 'St. Augustine',
    propertySqft: 10000,
    sunExposure: null,
    irrigationSystem: null,
  })),
  irrigationTypeHasSystem: jest.fn(() => null),
}));
jest.mock('@anthropic-ai/sdk', () => {
  return class MockAnthropic {
    constructor() {
      this.messages = {
        create: (...args) => global.__anthropicCreate(...args),
      };
    }
  };
});

const wiki = require('../services/agronomic-wiki');
const { escapeLike, extractSummary, sameSourceIds } = wiki.__private;

// ── chainable knex-ish mock ────────────────────────────────────────────────
function makeDb(responses = {}) {
  const state = {
    responses,
    calls: {},
    inserts: {},
    updates: {},
    deletes: {},
  };
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
    for (const m of ['where', 'andWhere', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereIn', 'orderBy', 'orderByRaw', 'limit', 'offset', 'select', 'groupBy']) {
      b[m] = (...args) => {
        rec.ops.push([m, args]);
        if (typeof args[0] === 'function') args[0].call(b);
        return b;
      };
    }
    b.first = async (...args) => {
      rec.ops.push(['first', args]);
      const rows = resolveRows();
      return rows[0] ?? null;
    };
    b.count = (...args) => {
      rec.ops.push(['count', args]);
      return b;
    };
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
    b.del = async () => {
      rec.ops.push(['del', []]);
      state.deletes[table] = (state.deletes[table] || 0) + 1;
      return 1;
    };
    b.then = (res, rej) => {
      let rows;
      try {
        rows = resolveRows();
      } catch (err) {
        return Promise.reject(err).then(res, rej);
      }
      return Promise.resolve(rows).then(res, rej);
    };
    return b;
  };
  dbFn.state = state;
  return dbFn;
}

function useDb(responses) {
  const dbFn = makeDb(responses);
  global.__wikiDbMock = dbFn;
  return dbFn.state;
}

beforeEach(() => {
  global.__anthropicCreate = jest.fn(async () => ({
    content: [{ text: '# Generated Page\n\nReal generated prose about outcomes.' }],
    usage: { input_tokens: 10, output_tokens: 20 },
    model: 'test-model',
  }));
});

// ── helpers ────────────────────────────────────────────────────────────────

describe('helpers', () => {
  test('escapeLike escapes %, _ and backslash', () => {
    expect(escapeLike('AM 1% Mg 5.75% S')).toBe('AM 1\\% Mg 5.75\\% S');
    expect(escapeLike('a_b\\c')).toBe('a\\_b\\\\c');
  });

  test('extractSummary skips headings, metadata lines, callouts and rules', () => {
    const content = [
      '# July — Seasonal Intelligence',
      '',
      '**Category:** Seasonal',
      '**Region:** Southwest Florida',
      '',
      '---',
      '',
      '> ⚠️ **Data Limitation Notice**',
      '',
      'July falls within the peak growing season.',
    ].join('\n');
    expect(extractSummary(content)).toBe('July falls within the peak growing season.');
  });

  test('sameSourceIds compares regardless of order and tolerates JSON strings', () => {
    expect(sameSourceIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSourceIds('["a","b"]', ['a', 'b'])).toBe(true);
    expect(sameSourceIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameSourceIds(null, [])).toBe(false);
    expect(sameSourceIds('not json', ['a'])).toBe(false);
  });
});

// ── generatePage ───────────────────────────────────────────────────────────

describe('generatePage', () => {
  test('preserves existing content when the AI call fails', async () => {
    const existing = {
      id: 'ke-1',
      slug: 'product/talstar-p',
      content: '# Talstar P\n\nHard-won existing analysis.',
      data_point_count: 3,
      source_treatment_ids: ['o1', 'o2', 'o3'],
      stale_flag: false,
    };
    const state = useDb({ knowledge_entries: [existing] });
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    const result = await wiki.generatePage(
      'product/talstar-p', 'product',
      { outcomes: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }, { id: 'o4' }] },
      'Product: Talstar P'
    );

    expect(result.writeState).toBe('failed');
    expect(result.entry.content).toBe(existing.content);
    // the failure path may re-resolve review fields, but must never touch content
    const contentPatch = (state.updates.knowledge_entries || []).find((u) => 'content' in u);
    expect(contentPatch).toBeUndefined();
    const errorLog = (state.inserts.knowledge_update_log || []).find((r) => r.action === 'error');
    expect(errorLog).toBeTruthy();
    expect(errorLog.description).toMatch(/existing content preserved/);
  });

  test('still creates a placeholder stub for a brand-new page when the AI call fails', async () => {
    const state = useDb({ knowledge_entries: [] });
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    const result = await wiki.generatePage('product/new-thing', 'product', { outcomes: [{ id: 'o1' }] }, 'Product: New Thing');

    expect(result?.entry).toBeTruthy();
    expect(result?.writeState).toBe('stub');
    expect(state.inserts.knowledge_entries).toHaveLength(1);
    expect(state.inserts.knowledge_entries[0].content).toContain('Pending AI generation');
  });

  test('skips regeneration when data points are unchanged, clearing the stale flag and advancing the watermark', async () => {
    const existing = {
      id: 'ke-1',
      slug: 'product/talstar-p',
      content: '# Talstar P\n\nExisting analysis.',
      data_point_count: 2,
      source_treatment_ids: ['o1', 'o2'],
      stale_flag: true,
    };
    const state = useDb({ knowledge_entries: [existing] });

    const result = await wiki.generatePage(
      'product/talstar-p', 'product',
      { outcomes: [{ id: 'o2' }, { id: 'o1' }] },
      'Product: Talstar P'
    );

    // the returned entry carries the POST-update review fields on top of the
    // existing row (callers act on its trust)
    expect(result.writeState).toBe('skipped');
    expect(result.entry).toEqual(expect.objectContaining({ id: 'ke-1', content: existing.content }));
    expect(global.__anthropicCreate).not.toHaveBeenCalled();
    // last_data_update advances so the page doesn't get re-marked stale and
    // re-skipped on every subsequent weekly refresh
    expect(state.updates.knowledge_entries).toEqual([
      expect.objectContaining({ stale_flag: false, last_data_update: expect.any(Date) }),
    ]);
    const skipLog = (state.inserts.knowledge_update_log || []).find((r) => r.action === 'skip');
    expect(skipLog).toBeTruthy();
  });

  test('fingerprints the full outcome set, not the 50-outcome prompt slice', async () => {
    const existing = {
      id: 'ke-1',
      slug: 'track/st-augustine',
      content: '# Track\n\nExisting analysis.',
      data_point_count: 60,
      source_treatment_ids: Array.from({ length: 60 }, (_, i) => `o${i}`),
      stale_flag: false,
    };
    useDb({ knowledge_entries: [existing] });

    // Same newest-50 slice, but one id changed outside the slice (o55 → oX)
    const allIds = Array.from({ length: 60 }, (_, i) => (i === 55 ? 'oX' : `o${i}`));
    await wiki.generatePage('track/st-augustine', 'track', {
      outcomes: allIds.slice(0, 50).map((id) => ({ id })),
      totalOutcomeCount: 60,
      allOutcomeIds: allIds,
    }, 'Track st_augustine Performance');

    expect(global.__anthropicCreate).toHaveBeenCalled();
  });

  test('placeholder stubs are always retried, never treated as unchanged', async () => {
    const existing = {
      id: 'ke-1',
      slug: 'product/talstar-p',
      content: '# Product: Talstar P\n\n*Pending AI generation — 2 data points available.*',
      data_point_count: 2,
      source_treatment_ids: ['o1', 'o2'],
      stale_flag: false,
    };
    useDb({ knowledge_entries: [existing] });

    await wiki.generatePage('product/talstar-p', 'product', { outcomes: [{ id: 'o1' }, { id: 'o2' }] }, 'Product: Talstar P');

    expect(global.__anthropicCreate).toHaveBeenCalled();
  });
});

// ── updateSeasonalPage ─────────────────────────────────────────────────────

describe('updateSeasonalPage', () => {
  test('returns null without generating when the month has no outcomes, pruning any filler page', async () => {
    const state = useDb({ treatment_outcomes: [], knowledge_entries: [] });

    const result = await wiki.updateSeasonalPage(2);

    expect(result).toBeNull();
    expect(global.__anthropicCreate).not.toHaveBeenCalled();
    expect(state.inserts.knowledge_entries).toBeUndefined();
    // an existing zero-outcome page is deleted so it can't clog the
    // stale-refresh budget (del returns 1 in the mock → prune logged)
    expect(state.deletes.knowledge_entries).toBe(1);
    const pruneLog = (state.inserts.knowledge_update_log || []).find((r) => r.action === 'prune');
    expect(pruneLog).toBeTruthy();
  });
});

// ── updateProductPage ──────────────────────────────────────────────────────

describe('updateProductPage', () => {
  const RAW_NAME = 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer';
  const CANONICAL = 'LESCO High Manganese Combo';
  const ALIAS = 'LESCO High Manganese Combo Chelated Micronutrients AM 1% Mg 5.75% S 3% Fe 4% Mn Micronutrient Liquid Soil Amendment';

  function productResponses() {
    return {
      // exact-name miss, then by-id hit
      products_catalog: (rec, idx) => (idx === 0 ? [] : [{ id: 'pc-1', name: CANONICAL }]),
      // alias hit first, then the alias listing for the canonical product
      product_aliases: (rec, idx) => (idx === 0
        ? [{ product_id: 'pc-1' }]
        : [{ alias_name: ALIAS }, { alias_name: RAW_NAME }]),
      treatment_outcomes: [
        { id: 'o1', treatment_date: '2026-07-04', grass_track: 'st_augustine', products_applied: [] },
      ],
      knowledge_entries: (rec) => {
        const whereObj = rec.ops.find(([m, a]) => m === 'where' && a[0] && typeof a[0] === 'object')?.[1][0];
        if (whereObj?.slug === `product/${ALIAS.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.substring(0, 198)) {
          return [{ id: 'ke-dupe', slug: whereObj.slug }];
        }
        return [];
      },
      knowledge_base: [],
      knowledge_bridge: (rec) => {
        const whereObj = rec.ops.find(([m, a]) => m === 'where' && a[0] && typeof a[0] === 'object')?.[1][0];
        if (whereObj?.wiki_entry_id === 'ke-dupe') {
          return [{ id: 'kb-link-1', kb_entry_id: 'kb-9', link_type: 'related' }];
        }
        return []; // no clash on the canonical side
      },
      knowledge_contradictions: [],
    };
  }

  test('keys the page on the canonical catalog name and escapes LIKE wildcards', async () => {
    const state = useDb(productResponses());

    await wiki.updateProductPage(RAW_NAME);

    // page created under the canonical slug/title
    expect(state.inserts.knowledge_entries).toHaveLength(1);
    expect(state.inserts.knowledge_entries[0].slug).toBe('product/lesco-high-manganese-combo');
    expect(state.inserts.knowledge_entries[0].title).toBe(`Product: ${CANONICAL}`);

    // outcome matching covers every variant, with literal % escaped
    const outcomeRec = state.calls.treatment_outcomes[0];
    const likeArgs = outcomeRec.ops.filter(([m]) => m === 'orWhereRaw').map(([, a]) => a[1][0]);
    expect(likeArgs.length).toBeGreaterThanOrEqual(3);
    expect(likeArgs.some((p) => p.includes('1\\% Mg'))).toBe(true);
  });

  test('folds variant-named duplicate pages into the canonical page, preserving cross-references', async () => {
    const state = useDb(productResponses());

    await wiki.updateProductPage(RAW_NAME);

    expect(state.deletes.knowledge_entries).toBe(1);
    // dangling knowledge_base pointer re-pointed at the canonical entry
    // (the update list also carries syncKbCopyTrust status flips)
    expect(state.updates.knowledge_base).toEqual(expect.arrayContaining([
      expect.objectContaining({ wiki_entry_id: expect.stringContaining('knowledge_entries-') }),
    ]));
    // bridge links move to the canonical page instead of dying to the FK
    // cascade, and the denormalized wiki_slug follows
    expect(state.updates.knowledge_bridge).toEqual(expect.arrayContaining([
      expect.objectContaining({
        wiki_entry_id: expect.stringContaining('knowledge_entries-'),
        wiki_slug: 'product/lesco-high-manganese-combo',
      }),
    ]));
    expect(state.updates.knowledge_contradictions).toEqual(expect.arrayContaining([
      expect.objectContaining({ wiki_entry_id: expect.stringContaining('knowledge_entries-') }),
    ]));
    const mergeLog = (state.inserts.knowledge_update_log || []).find((r) => r.action === 'merge');
    expect(mergeLog).toBeTruthy();
  });

  test('a stub canonical page never absorbs variant pages (AI-failure path)', async () => {
    const responses = productResponses();
    // canonical page already exists as a placeholder stub
    responses.knowledge_entries = (rec) => {
      const whereObj = rec.ops.find(([m, a]) => m === 'where' && a[0] && typeof a[0] === 'object')?.[1][0];
      if (whereObj?.slug === 'product/lesco-high-manganese-combo') {
        return [{
          id: 'ke-stub',
          slug: 'product/lesco-high-manganese-combo',
          content: '# Product: LESCO High Manganese Combo\n\n*Pending AI generation — 1 data points available.*',
          data_point_count: 0,
          source_treatment_ids: [],
          stale_flag: false,
        }];
      }
      return [{ id: 'ke-dupe', slug: whereObj?.slug }];
    };
    const state = useDb(responses);
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    await wiki.updateProductPage(RAW_NAME);

    // generation failed → canonical is still a stub → no variant deletion
    expect(state.deletes.knowledge_entries).toBeUndefined();
  });

  test('falls back to the raw name when no catalog match exists', async () => {
    const state = useDb({
      products_catalog: [],
      product_aliases: [],
      treatment_outcomes: [
        { id: 'o1', treatment_date: '2026-07-04', grass_track: 'st_augustine', products_applied: [] },
      ],
      knowledge_entries: [],
    });

    await wiki.updateProductPage('Talstar P');

    expect(state.inserts.knowledge_entries[0].slug).toBe('product/talstar-p');
    expect(state.deletes.knowledge_entries).toBeUndefined();
  });

  test('a failed refresh of a real canonical page does not absorb variants', async () => {
    const responses = productResponses();
    // canonical page exists with REAL (non-stub) content
    responses.knowledge_entries = (rec) => {
      const whereObj = rec.ops.find(([m, a]) => m === 'where' && a[0] && typeof a[0] === 'object')?.[1][0];
      if (whereObj?.slug === 'product/lesco-high-manganese-combo') {
        return [{
          id: 'ke-real',
          slug: 'product/lesco-high-manganese-combo',
          content: '# Real canonical analysis (predates variant data)',
          data_point_count: 99,
          source_treatment_ids: ['other'],
          stale_flag: false,
        }];
      }
      return [{ id: 'ke-dupe', slug: whereObj?.slug }];
    };
    const state = useDb(responses);
    global.__anthropicCreate = jest.fn(async () => { throw new Error('api down'); });

    await wiki.updateProductPage(RAW_NAME);

    // refresh failed → canonical content may predate the variant's data →
    // the variant page must survive
    expect(state.deletes.knowledge_entries).toBeUndefined();
  });
});

describe('generatePage condition-count fallback', () => {
  test('assessment-only condition pages keep a live fingerprint', async () => {
    const state = useDb({ knowledge_entries: [] });

    await wiki.generatePage('condition/dollar-spot', 'condition', {
      outcomes: [],
      totalOutcomeCount: 0,
      allOutcomeIds: [],
      assessmentCount: 7,
    }, 'Condition: Dollar Spot');

    // 0 outcomes must fall through to the assessment count, not freeze at 0
    expect(state.inserts.knowledge_entries[0].data_point_count).toBe(7);
  });

  test('updateConditionPage fingerprints assessment ids when no outcomes exist', async () => {
    const state = useDb({
      lawn_assessments: [{ id: 'a1', customer_id: 'c1' }, { id: 'a2', customer_id: 'c2' }],
      treatment_outcomes: [],
      knowledge_entries: [],
    });

    await wiki.updateConditionPage('dollar spot');

    // the fingerprint must be the assessment ids, not an empty set — a
    // changed assessment set with an equal count must invalidate the skip
    expect(JSON.parse(state.inserts.knowledge_entries[0].source_treatment_ids)).toEqual(['a1', 'a2']);
  });
});

describe('mergeVariantProductPages back-pointer', () => {
  test('carries kb_entry_id from the variant when the canonical lacks one', async () => {
    const CANON_SLUG = 'product/lesco-high-manganese-combo';
    const state = useDb({
      products_catalog: (rec, idx) => (idx === 0 ? [] : [{ id: 'pc-1', name: 'LESCO High Manganese Combo' }]),
      product_aliases: (rec, idx) => (idx === 0 ? [{ product_id: 'pc-1' }] : [{ alias_name: 'LESCO HMC Variant' }]),
      treatment_outcomes: [{ id: 'o1', treatment_date: '2026-07-04', grass_track: 'st_augustine', products_applied: [] }],
      knowledge_entries: (rec) => {
        const whereObj = rec.ops.find(([m, a]) => m === 'where' && a[0] && typeof a[0] === 'object')?.[1][0];
        if (whereObj?.slug && whereObj.slug !== CANON_SLUG) {
          return [{ id: 'ke-dupe', slug: whereObj.slug, kb_entry_id: 'kb-42' }];
        }
        return [];
      },
      knowledge_bridge: [],
      knowledge_base: [],
      knowledge_contradictions: [],
    });

    await wiki.updateProductPage('LESCO HMC Variant');

    // canonical was a fresh insert (no kb_entry_id) → variant's pointer copied
    expect(state.updates.knowledge_entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kb_entry_id: 'kb-42' }),
    ]));
    expect(state.deletes.knowledge_entries).toBe(1);
  });
});

// ── weeklyRefreshIfDue / weeklyRefresh ─────────────────────────────────────

describe('weeklyRefreshIfDue', () => {
  test('skips when a weekly_cron run happened in the last 6 days', async () => {
    useDb({ knowledge_update_log: [{ id: 'log-1' }] });

    const result = await wiki.weeklyRefreshIfDue();

    expect(result).toEqual({ skipped: true, refreshed: 0 });
  });

  test('runs the refresh when no recent weekly_cron row exists', async () => {
    useDb({ knowledge_update_log: [] });
    const spy = jest.spyOn(wiki, 'weeklyRefresh').mockResolvedValue({ refreshed: 2, staleFound: 2 });

    const result = await wiki.weeklyRefreshIfDue();

    expect(spy).toHaveBeenCalled();
    expect(result).toEqual({ refreshed: 2, staleFound: 2 });
    spy.mockRestore();
  });

  test('a failed refresh writes a weekly_cron_error row so the gap is diagnosable', async () => {
    const state = useDb({
      knowledge_entries: () => { throw new Error('db exploded'); },
      knowledge_update_log: [],
    });

    const result = await wiki.weeklyRefresh();

    expect(result.error).toBe('db exploded');
    const errorLog = (state.inserts.knowledge_update_log || []).find((r) => r.trigger_type === 'weekly_cron_error');
    expect(errorLog).toBeTruthy();
  });

  test('stale refresh only selects categories that have a refresh path', async () => {
    const state = useDb({
      knowledge_entries: [],
      treatment_outcomes: [],
      knowledge_update_log: [],
    });

    await wiki.weeklyRefresh();

    const staleSelect = state.calls.knowledge_entries.find((rec) => rec.ops.some(([m]) => m === 'whereIn'));
    expect(staleSelect).toBeTruthy();
    const whereIn = staleSelect.ops.find(([m]) => m === 'whereIn');
    expect(whereIn[1]).toEqual(['category', ['product', 'track', 'seasonal', 'condition']]);
  });
});

// ── linkTreatmentOutcome pairing windows ───────────────────────────────────

describe('linkTreatmentOutcome pairing windows', () => {
  test('bounds pre- and post-assessment lookups around the treatment date', async () => {
    const TREATMENT_DATE = '2026-07-01';
    const state = useDb({
      treatment_outcomes: [],
      service_records: [{
        id: 'sr-1', customer_id: 'c-1', service_date: TREATMENT_DATE,
        service_type: 'lawn', scheduled_service_id: null, visit_number: 1,
      }],
      lawn_assessments: (rec, idx) => (idx === 0
        ? [{ id: 'post-1', service_date: '2026-07-01', turf_density: 5, weed_suppression: 5, color_health: 5, fungus_control: 5, thatch_level: 5 }]
        : [{ id: 'pre-1', service_date: '2026-06-15', turf_density: 4, weed_suppression: 4, color_health: 4, fungus_control: 4, thatch_level: 4 }]),
      service_products: [],
      customers: [{ id: 'c-1' }],
      knowledge_update_log: [],
    });
    // keep the fire-and-forget page updates out of this test
    const spies = ['updateProductPage', 'updateTrackPage', 'updateSeasonalPage']
      .map((m) => jest.spyOn(wiki, m).mockResolvedValue(null));

    const outcome = await wiki.linkTreatmentOutcome('sr-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome).toBeTruthy();
    expect(state.inserts.treatment_outcomes[0].delta_turf_density).toBe(1);

    const [postRec, preRec] = state.calls.lawn_assessments;
    // post fallback: upper bound via nested andWhere
    const postUpper = postRec.ops.find(([m, a]) => m === 'andWhere' && a[0] === 'service_date' && a[1] === '<=');
    expect(postUpper).toBeTruthy();
    expect(postUpper[1][2]).toBeInstanceOf(Date);
    expect(postUpper[1][2].getTime()).toBe(new Date(TREATMENT_DATE).getTime() + 60 * 86400000);
    // pre: lower bound
    const preLower = preRec.ops.find(([m, a]) => m === 'where' && a[0] === 'service_date' && a[1] === '>=');
    expect(preLower).toBeTruthy();
    expect(preLower[1][2].getTime()).toBe(new Date(TREATMENT_DATE).getTime() - 180 * 86400000);

    spies.forEach((s) => s.mockRestore());
  });
});
