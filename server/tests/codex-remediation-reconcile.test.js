const { reconcileAutonomousPr } = require('../services/content/codex-remediation');
const fm = require('../services/content-astro/frontmatter');

const RUN = '00000000-0000-4000-8000-000000000001';
const OPP = '00000000-0000-4000-8000-000000000002';
const PIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const HOLD = 'd'.repeat(40);
const BRANCH = 'content/reconciliation-fixture';
const SLUG = 'pest-control/reconciliation-fixture';
const PATH = `src/content/blog/${SLUG}.mdx`;
const OPTIONS = { runId: RUN, prNumber: 999, headSha: HEAD, approvedBy: 'test-operator' };
const META = { title: 'Original title', slug: `/${SLUG}/`, canonical: `https://www.wavespestcontrol.com/${SLUG}/`,
  reading_time_min: 7, category: 'pest-control', domains: ['wavespestcontrol.com'], schema_types: ['Article', 'BreadcrumbList'],
  hero_image: { src: `/images/blog/${SLUG}/hero.webp`, alt: 'Original alt' } };

function fixture() {
  let tables = {
    opportunity_queue: [{ id: OPP, status: 'pending_review', skip_reason: 'astro_pr_pending_merge' }],
    autonomous_runs: [{ id: RUN, opportunity_id: OPP, claimed_at: '2020-01-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z',
      action_type: 'new_supporting_blog', shadow_mode: false, outcome: 'completed_pending_review',
      skip_reason: 'astro_pr_pending_merge', astro_pr_url: 'https://github.com/owner/astro/pull/999',
      comparison_table_result: { requiresHumanReview: true },
      draft_payload: { autopublish_head_sha: PIN, body: 'Original body', frontmatter: META } }],
    codex_remediation_state: [{ pr_number: 999, status: 'parked', branch: BRANCH,
      sync_pending_sha: HOLD, synced_sha: null, rounds: 2, last_push_sha: HOLD, park_reason: 'sync withheld' }],
  };
  let failStateWrite = false;
  const connect = (read) => (table) => {
    const filters = [];
    let ordered = false;
    const rows = () => {
      const result = read()[table].filter(row => filters.every(f => f(row)));
      return ordered ? result.sort((a, b) => b.claimed_at.localeCompare(a.claimed_at)) : result;
    };
    const q = {
      where(key, op, value) {
        if (typeof key === 'object') filters.push(row => Object.entries(key).every(([k, v]) => row[k] === v));
        else filters.push(row => value === undefined ? row[key] === op : row[key] > value);
        return q;
      },
      whereNot(key, value) { filters.push(row => row[key] !== value); return q; },
      forUpdate() { return q; },
      orderBy() { ordered = true; return q; },
      async first() { return structuredClone(rows()[0]); },
      async update(patch) {
        if (table === 'codex_remediation_state' && failStateWrite) throw new Error('simulated sync release failure');
        const found = rows(); found.forEach(row => Object.assign(row, patch)); return found.length;
      },
    };
    return q;
  };
  const db = connect(() => tables);
  db.transaction = async (fn) => {
    const local = structuredClone(tables);
    const result = await fn(connect(() => local));
    tables = local;
    return result;
  };
  let candidate = fm.stringify({ ...META, title: 'Repaired title', reading_time_min: 9, updated: '2026-09-06',
    meta_description: 'Repaired summary', hero_image: { ...META.hero_image, alt: 'Refreshed photo' },
    schema_types: ['Article', 'BreadcrumbList', 'FAQPage'] }, 'Repaired body with refreshed image references.');
  const pr = { state: 'open', head: { sha: HEAD, ref: BRANCH }, base: { ref: 'main' } };
  const deps = {
    db,
    gh: {
      env: () => ({ owner: 'owner', repo: 'astro', defaultBranch: 'main' }),
      getPr: jest.fn(async () => structuredClone(pr)),
      getBranchSha: jest.fn(async branch => branch === 'main' ? BASE : pr.head.sha),
      compareFiles: jest.fn(async (_head, base) => ({ mergeBaseSha: base,
        files: [PATH, `public/images/blog/${SLUG}/hero.webp`] })),
      getFile: jest.fn(async (_path, ref) => ({ content: ref === PIN ? fm.stringify(META, 'Original body') : candidate })),
    },
    publisher: { _internals: { categoryRouteSlug: s => s, slugPathFromFrontmatter: () => SLUG, normalizeAutonomousCategory: () => 'pest-control' } },
    autonomousRunner: { _loadReviewedBrief: async () => ({}), _deriveGuardrailOptions: async () => ({}),
      _internals: { operatorBriefTextForComparisonGate: () => null } },
    validateFixedBlogFile: jest.fn(async () => ({ ok: true })),
    validateAutonomousRunGates: jest.fn(async () => ({ ok: true, comparisonResult: { requiresHumanReview: false } })),
  };
  return { deps, pr, get tables() { return tables; }, set candidate(v) { candidate = v; },
    failStateWrite() { failStateWrite = true; } };
}

test('preview validates the exact head without updating business rows', async () => {
  const f = fixture(); const before = structuredClone(f.tables);
  const result = await reconcileAutonomousPr(OPTIONS, f.deps);
  expect(result.executed).toBe(false);
  expect(f.tables).toEqual(before);
  expect(f.deps.validateAutonomousRunGates).toHaveBeenCalledWith(expect.stringContaining('Repaired title'), expect.anything(), expect.objectContaining({ prHeadRef: HEAD }));
});

test('synchronizes full article and image alt, preserves governance and rounds, and releases atomically', async () => {
  const f = fixture();
  expect((await reconcileAutonomousPr({ ...OPTIONS, execute: true }, f.deps)).executed).toBe(true);
  const run = f.tables.autonomous_runs[0]; const draft = JSON.parse(run.draft_payload);
  expect(draft).toMatchObject({ autopublish_head_sha: PIN, trust_build_approved_head_sha: HEAD,
    title: 'Repaired title', body: 'Repaired body with refreshed image references.',
    frontmatter: { reading_time_min: 9, hero_image: { alt: 'Refreshed photo' }, schema_types: ['Article', 'BreadcrumbList', 'FAQPage'] } });
  expect(JSON.parse(run.comparison_table_result).requiresHumanReview).toBe(true);
  expect(run.trust_build_approved_by).toBe('test-operator');
  expect(f.tables.codex_remediation_state[0]).toMatchObject({ rounds: 2, last_push_sha: HOLD, synced_sha: HEAD, sync_pending_sha: null });
});

test.each(['file', 'run'])('%s gate failure preserves the hold', async gate => {
  const f = fixture(); const before = structuredClone(f.tables);
  f.deps[gate === 'file' ? 'validateFixedBlogFile' : 'validateAutonomousRunGates'].mockResolvedValue({ ok: false, reason: 'blocked' });
  await expect(reconcileAutonomousPr({ ...OPTIONS, execute: true }, f.deps)).rejects.toThrow('validation failed');
  expect(f.tables).toEqual(before);
});

test('release failure rolls back the draft approval and mirror too', async () => {
  const f = fixture(); const before = structuredClone(f.tables); f.failStateWrite();
  await expect(reconcileAutonomousPr({ ...OPTIONS, execute: true }, f.deps)).rejects.toThrow('simulated sync release failure');
  expect(f.tables).toEqual(before);
});

test.each(['close', 'move', 'ref'])('rejects PR %s during gate validation', async change => {
  const f = fixture(); const before = structuredClone(f.tables);
  f.deps.validateAutonomousRunGates.mockImplementation(async () => {
    if (change === 'close') f.pr.state = 'closed';
    if (change === 'move') f.pr.head.sha = 'e'.repeat(40);
    if (change === 'ref') f.deps.gh.getBranchSha.mockImplementation(async branch => branch === 'main' ? BASE : 'e'.repeat(40));
    return { ok: true, comparisonResult: {} };
  });
  await expect(reconcileAutonomousPr({ ...OPTIONS, execute: true }, f.deps)).rejects.toThrow('changed');
  expect(f.tables).toEqual(before);
});

test('replacement run during validation cannot inherit approval', async () => {
  const f = fixture();
  f.deps.validateAutonomousRunGates.mockImplementation(async () => {
    f.tables.autonomous_runs.push({ ...f.tables.autonomous_runs[0], id: 'replacement', claimed_at: '2020-01-02T00:00:00Z', created_at: '2020-01-02T00:00:00Z' });
    return { ok: true, comparisonResult: {} };
  });
  await expect(reconcileAutonomousPr({ ...OPTIONS, execute: true }, f.deps)).rejects.toThrow('current live pending blog');
  expect(f.tables.codex_remediation_state[0].sync_pending_sha).toBe(HOLD);
  expect(f.tables.autonomous_runs.every(r => !r.trust_build_approved_at)).toBe(true);
});

test.each(['src/pages/new.astro', 'public/images/blog/another-post/hero.webp'])('rejects foreign changed file %s', async file => {
  const f = fixture();
  f.deps.gh.compareFiles.mockResolvedValue({ mergeBaseSha: PIN, files: [PATH, file] });
  await expect(reconcileAutonomousPr(OPTIONS, f.deps)).rejects.toThrow('content-and-images-only');
  expect(f.deps.validateFixedBlogFile).not.toHaveBeenCalled();
});

test('rejects route changes even when the file path is unchanged', async () => {
  const f = fixture(); f.candidate = fm.stringify({ ...META, canonical: 'https://example.org/moved/' }, 'Body');
  await expect(reconcileAutonomousPr(OPTIONS, f.deps)).rejects.toThrow('cannot change frontmatter canonical');
});

test('rejects a held commit outside the selected history', async () => {
  const f = fixture();
  f.deps.gh.compareFiles.mockImplementation(async (_head, base) => ({ mergeBaseSha: PIN, files: [PATH] }));
  await expect(reconcileAutonomousPr(OPTIONS, f.deps)).rejects.toThrow('held push must be an ancestor');
});

const devConnection = process.env.BLOG_RECONCILE_TEST_DATABASE_URL;
const dbDescribe = devConnection ? describe : describe.skip;
dbDescribe('PostgreSQL reconciliation transaction', () => {
  const schema = `blog_reconcile_${require('crypto').randomBytes(6).toString('hex')}`;
  let db;
  beforeAll(async () => {
    db = require('knex')({ ...require('../knexfile').test, connection: devConnection,
      searchPath: [schema], pool: { min: 0, max: 2 } });
    await db.schema.createSchema(schema);
    await db.schema.createTable('opportunity_queue', t => {
      t.uuid('id').primary(); t.string('status'); t.string('skip_reason'); t.uuid('claim_id');
    });
    await db.schema.createTable('autonomous_runs', t => {
      t.uuid('id').primary(); t.uuid('opportunity_id'); t.timestamp('claimed_at'); t.timestamp('created_at'); t.uuid('queue_claim_id');
      t.string('action_type'); t.boolean('shadow_mode'); t.string('outcome'); t.string('skip_reason');
      t.text('astro_pr_url'); t.jsonb('comparison_table_result'); t.jsonb('draft_payload');
      t.timestamp('trust_build_approved_at'); t.string('trust_build_approved_by');
      t.text('reviewer_notes'); t.timestamp('updated_at');
    });
    await db.schema.createTable('codex_remediation_state', t => {
      t.integer('pr_number').primary(); t.string('status'); t.string('branch');
      t.string('sync_pending_sha'); t.string('synced_sha'); t.integer('rounds');
      t.string('last_push_sha'); t.text('park_reason'); t.string('parked_head_sha');
      t.string('park_phase'); t.timestamp('updated_at');
    });
  });
  afterAll(async () => {
    if (db) {
      await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await db.destroy();
    }
  });
  beforeEach(async () => {
    for (const table of ['autonomous_runs', 'opportunity_queue', 'codex_remediation_state']) await db(table).del();
    const f = fixture();
    for (const [table, rows] of Object.entries(f.tables)) {
      await db(table).insert(rows.map(row => {
        const next = { ...row };
        for (const key of ['draft_payload', 'comparison_table_result']) if (next[key]) next[key] = JSON.stringify(next[key]);
        return next;
      }));
    }
  });
  test('real JSONB mirrors and hold release commit together', async () => {
    const f = fixture(); f.deps.db = db;
    await reconcileAutonomousPr({ ...OPTIONS, execute: true }, f.deps);
    const run = await db('autonomous_runs').where({ id: RUN }).first();
    const state = await db('codex_remediation_state').where({ pr_number: OPTIONS.prNumber }).first();
    expect(run.draft_payload.frontmatter.hero_image.alt).toBe('Refreshed photo');
    expect(run.draft_payload.trust_build_approved_head_sha).toBe(HEAD);
    expect(state.sync_pending_sha).toBeNull(); expect(state.rounds).toBe(2);
  });
  test('a database release failure rolls back the preceding draft write', async () => {
    const f = fixture(); f.deps.db = db;
    await db.raw('ALTER TABLE ?? ADD CONSTRAINT keep_hold CHECK (sync_pending_sha IS NOT NULL)', ['codex_remediation_state']);
    try {
      await expect(reconcileAutonomousPr({ ...OPTIONS, execute: true }, f.deps)).rejects.toThrow('keep_hold');
      const run = await db('autonomous_runs').where({ id: RUN }).first();
      const state = await db('codex_remediation_state').where({ pr_number: OPTIONS.prNumber }).first();
      expect(run.draft_payload.body).toBe('Original body');
      expect(run.trust_build_approved_at).toBeNull();
      expect(state.sync_pending_sha).toBe(HOLD);
    } finally {
      await db.raw('ALTER TABLE ?? DROP CONSTRAINT keep_hold', ['codex_remediation_state']);
    }
  });
});


test('a superseding queue claim cannot be reconciled even without a newer run', async () => {
  const f = fixture(); f.tables.opportunity_queue[0].claim_id = 'new-claim';
  const before = structuredClone(f.tables);
  await expect(reconcileAutonomousPr({ ...OPTIONS, execute: true }, f.deps)).rejects.toThrow('queue claim');
  expect(f.tables).toEqual(before);
});
