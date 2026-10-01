/**
 * aeo_question_gap route fence at the claim chokepoint, on real PostgreSQL.
 * Isolated schema on a loopback waves_test database; never reads the
 * application's DATABASE_URL (same harness as blog-queue-ownership-postgres).
 */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Every lane open: the fence under test is the only thing that can hold a row.
jest.mock('../config/feature-gates', () => ({ gateEnvTimestamp: () => null, isEnabled: () => true }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const queue = require('../services/content/opportunity-queue');
const migration = require('../models/migrations/20260905000020_blog_queue_ownership');

const connection = process.env.BLOG_QUEUE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `aeo_fence_${randomUUID().replaceAll('-', '')}`;
const HUB = 'https://www.wavespestcontrol.com';
const SLUG = '/lawn-care/large-patch-fungus-lakewood-ranch-fl/';
let admin;
let mockPg;

postgres('aeo_question_gap claim fence on PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/waves_test') {
      throw new Error('Use an isolated loopback waves_test database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema }, searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockPg.schema.createTable('opportunity_queue', (t) => {
      t.uuid('id').primary(); t.text('status'); t.text('action_type'); t.text('skip_reason'); t.text('bucket');
      t.text('page_url'); t.text('dedupe_key');
      t.integer('attempt_count').defaultTo(0); t.integer('score').defaultTo(90); t.jsonb('signal_metadata');
      for (const c of ['claimed_at', 'completed_at', 'updated_at', 'available_at', 'expires_at', 'mined_at']) t.timestamp(c, { useTz: true });
    });
    await mockPg.schema.createTable('autonomous_runs', (t) => {
      t.uuid('id').primary(); t.uuid('opportunity_id'); t.text('action_type');
      t.text('astro_pr_url'); t.text('published_url'); t.timestamp('claimed_at', { useTz: true });
      // Real columns (phase_11 runs migration) that stale-claim recovery's
      // current-claim PR probe reads; Postgres resolves them even on 0 rows.
      t.text('outcome'); t.text('skip_reason'); t.timestamp('created_at', { useTz: true }).defaultTo(mockPg.fn.now());
    });
    // migration.up adds autonomous_runs.astro_pr_retired_at (and claim_id).
    await mockPg.schema.createTable('content_briefs', (t) => {
      t.uuid('id').primary(); t.uuid('opportunity_id'); t.text('action_type'); t.timestamp('composed_at', { useTz: true });
    });
    await migration.up(mockPg);
  });
  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => {
    await mockPg('autonomous_runs').del();
    await mockPg('opportunity_queue').del();
  });

  // Question gaps only ever queue a refresh of the live target page.
  const questionRefresh = (patch = {}) => ({
    id: randomUUID(), status: 'pending', action_type: 'refresh_existing_page', bucket: 'aeo_question_gap', score: 80,
    page_url: `${HUB}${SLUG}`, dedupe_key: `aeo_question_gap::Q19::${randomUUID()}`,
    signal_metadata: JSON.stringify({ benchmark_id: 'Q19', target_path: SLUG }), mined_at: new Date(), ...patch,
  });
  const categorySeed = (patch = {}) => ({
    id: randomUUID(), status: 'pending', action_type: 'new_supporting_blog', bucket: 'operator_intercept', score: 90,
    dedupe_key: `catseed:v1:L17:${randomUUID()}`,
    signal_metadata: JSON.stringify({ category_brief: { id: 'L17', slug: SLUG } }), mined_at: new Date(), ...patch,
  });
  const interceptSeed = (patch = {}) => categorySeed({
    signal_metadata: JSON.stringify({ intercept_brief: { slug: SLUG } }), dedupe_key: `intercept:${randomUUID()}`, ...patch,
  });
  const decayRefresh = (page, patch = {}) => ({
    id: randomUUID(), status: 'pending', action_type: 'refresh_existing_page', bucket: 'decay_refresh', score: 85,
    page_url: page, dedupe_key: `decay_refresh::${randomUUID()}`, signal_metadata: '{}', mined_at: new Date(), ...patch,
  });

  async function claimAll() {
    const claimed = [];
    for (;;) {
      const row = await queue.claimNext({ minScore: 0 });
      if (!row) return claimed;
      claimed.push(row.id);
    }
  }

  test.each([
    ['question first, category seed seeded after', () => [questionRefresh(), categorySeed()]],
    ['category seed first, question seeded after', () => [categorySeed(), questionRefresh()]],
    ['question first, intercept seed seeded after', () => [questionRefresh(), interceptSeed()]],
  ])('%s: whichever is claimed first blocks the other', async (_label, rows) => {
    for (const r of rows()) await mockPg('opportunity_queue').insert(r);
    const claimed = await claimAll();
    expect(claimed).toHaveLength(1);
    // The held row is still pending, not deleted or skipped.
    expect(await mockPg('opportunity_queue').where({ status: 'pending' }).count('* as n').first()).toEqual({ n: '1' });
  });

  test('a claimed or in-review row of either kind blocks the other', async () => {
    for (const [holder, waiter] of [
      [questionRefresh({ status: 'claimed', claimed_at: new Date() }), categorySeed()],
      [categorySeed({ status: 'claimed', claimed_at: new Date() }), questionRefresh()],
      [questionRefresh({ status: 'pending_review' }), decayRefresh(`${HUB}${SLUG}`)],
      [decayRefresh(`${HUB}${SLUG}`, { status: 'pending_review' }), questionRefresh()],
    ]) {
      await mockPg('opportunity_queue').del();
      await mockPg('opportunity_queue').insert([holder, waiter]);
      expect(await queue.claimNext({ minScore: 0 })).toBeNull();
      const peeked = await queue.peek({ limit: 10 });
      expect(peeked.map((r) => r.id)).not.toContain(waiter.id);
    }
  });

  test('a question refresh fences a pinned seed article for the same route (www / slash variants)', async () => {
    await mockPg('opportunity_queue').insert([
      questionRefresh({ status: 'claimed', claimed_at: new Date(), page_url: `https://wavespestcontrol.com${SLUG.slice(0, -1)}` }),
      categorySeed(),
    ]);
    expect(await queue.claimNext({ minScore: 0 })).toBeNull();
  });

  test('a question row waits out the cooldown after another row wrote its route; the reverse is not held', async () => {
    await mockPg('opportunity_queue').insert([categorySeed({ status: 'done', updated_at: new Date() }), questionRefresh()]);
    expect(await queue.claimNext({ minScore: 0 })).toBeNull();
    await mockPg('opportunity_queue').where({ status: 'done' }).update({ updated_at: new Date(Date.now() - 40 * 86400_000) });
    expect(await queue.claimNext({ minScore: 0 })).not.toBeNull();

    await mockPg('opportunity_queue').del();
    await mockPg('opportunity_queue').insert([questionRefresh({ status: 'done', updated_at: new Date() }), categorySeed()]);
    expect(await queue.claimNext({ minScore: 0 })).not.toBeNull();
  });

  test('an open PR holds its route after stale-claim recovery left the row pending (either kind)', async () => {
    const run = (opportunityId, patch = {}) => ({
      id: randomUUID(), opportunity_id: opportunityId, action_type: 'new_supporting_blog', claimed_at: new Date(),
      astro_pr_url: 'https://github.com/example/content/pull/9', ...patch,
    });
    for (const [crashed, other] of [[questionRefresh(), categorySeed()], [categorySeed(), questionRefresh()]]) {
      await mockPg('autonomous_runs').del();
      await mockPg('opportunity_queue').del();
      // The worker opened the PR, then crashed; recovery set the row back to
      // pending. Its own row stays fenced by claimableStatusSql; the route
      // fence must also hold the OTHER producer's row.
      await mockPg('opportunity_queue').insert([crashed, other]);
      await mockPg('autonomous_runs').insert(run(crashed.id));
      expect(await queue.claimNext({ minScore: 0 })).toBeNull();
      // Retired (closed, branch removed) → the route frees: one write at a
      // time again (whichever claims first holds the other).
      await mockPg('autonomous_runs').update({ astro_pr_retired_at: new Date() });
      expect(await claimAll()).toHaveLength(1);
    }
    // A PUBLISHED run no longer holds the route through this clause.
    await mockPg('autonomous_runs').del();
    await mockPg('opportunity_queue').del();
    const seed = categorySeed({ status: 'expired' });
    const question = questionRefresh();
    await mockPg('opportunity_queue').insert([seed, question]);
    await mockPg('autonomous_runs').insert(run(seed.id, { published_url: `${HUB}${SLUG}` }));
    expect((await queue.claimNext({ minScore: 0 }))?.id).toBe(question.id);
  });

  test('a question refresh whose own worker crashed after opening its PR is not re-claimable until the PR is retired', async () => {
    // Stale-claim recovery set the row back to pending; its run still owns
    // an open, unmerged PR for the page.
    const row = questionRefresh();
    await mockPg('opportunity_queue').insert(row);
    await mockPg('autonomous_runs').insert({ id: randomUUID(), opportunity_id: row.id, action_type: 'refresh_existing_page',
      claimed_at: new Date(), astro_pr_url: 'https://github.com/example/content/pull/11' });
    expect(await queue.claimNext({ minScore: 0 })).toBeNull();
    expect((await queue.peek({ limit: 10 })).map((r) => r.id)).not.toContain(row.id);
    // Published: the refresh already landed — still not re-claimed (same
    // own-run rule as blog rows; the row ages out via expireStale).
    await mockPg('autonomous_runs').update({ published_url: `${HUB}${SLUG}` });
    expect(await queue.claimNext({ minScore: 0 })).toBeNull();
    // A retired PR (closed, branch removed) with no publish frees the row.
    await mockPg('autonomous_runs').update({ published_url: null, astro_pr_retired_at: new Date() });
    expect((await queue.claimNext({ minScore: 0 }))?.id).toBe(row.id);
  });

  test('overlapping claims are serialized: two concurrent claimers take one same-route row, never both', async () => {
    await mockPg('opportunity_queue').insert([questionRefresh(), categorySeed()]);
    // Hold the claim lock from another session so both claimers start and
    // queue up at the same moment, then release it.
    const holder = await mockPg.client.acquireConnection();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('opportunity_queue_claim'))");
      let settled = 0;
      const claims = [queue.claimNext({ minScore: 0 }), queue.claimNext({ minScore: 0 })]
        .map((p) => p.then((r) => { settled += 1; return r; }));
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(0); // both are waiting on the lock, not racing
      await holder.query('COMMIT');
      const results = await Promise.all(claims);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await mockPg('opportunity_queue').where({ status: 'claimed' }).count('* as n').first()).toEqual({ n: '1' });
    } finally {
      await mockPg.client.releaseConnection(holder);
    }
  });

  test('unrelated routes and rows without a question are unaffected', async () => {
    await mockPg('opportunity_queue').insert([
      questionRefresh({ status: 'claimed', claimed_at: new Date() }),
      decayRefresh(`${HUB}/termite/termite-bond/`),
      categorySeed({ signal_metadata: JSON.stringify({ category_brief: { slug: '/pest-control/other-post/' } }) }),
    ]);
    expect(await claimAll()).toHaveLength(2);

    // Two non-question rows on one route: no fence (existing behavior).
    await mockPg('opportunity_queue').del();
    await mockPg('opportunity_queue').insert([
      decayRefresh(`${HUB}${SLUG}`, { status: 'claimed', claimed_at: new Date() }),
      categorySeed(),
    ]);
    expect(await claimAll()).toHaveLength(1);
  });
});
