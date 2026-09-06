/** Isolated PostgreSQL proof; never reads the application's DATABASE_URL. */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  return db;
});
jest.mock('../services/content-astro/github-client', () => ({ getPr: jest.fn(), retireBranch: jest.fn(async () => true) }));
jest.mock('../services/content/codex-remediation', () => ({ markPrTerminal: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const queue = require('../services/content/opportunity-queue');
const migration = require('../models/migrations/20260905000020_blog_queue_ownership');
const connection = process.env.BLOG_QUEUE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `blog_queue_${randomUUID().replaceAll('-', '')}`;
let admin;
let mockPg;

postgres('blog queue ownership on PostgreSQL', () => {
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
      t.integer('attempt_count').defaultTo(0); t.integer('score').defaultTo(90); t.jsonb('signal_metadata');
      for (const c of ['claimed_at', 'completed_at', 'updated_at', 'available_at', 'expires_at', 'mined_at']) t.timestamp(c, { useTz: true });
    });
    await mockPg.schema.createTable('autonomous_runs', (t) => {
      t.uuid('id').primary(); t.uuid('opportunity_id'); t.text('action_type'); t.text('outcome'); t.text('skip_reason');
      t.text('astro_pr_url'); t.text('published_url'); t.timestamp('claimed_at', { useTz: true });
      t.uuid('brief_id'); t.jsonb('draft_payload'); t.text('reviewer_notes'); t.text('poll_pending_reason'); t.text('trust_build_approved_by');
      for (const c of ['created_at', 'updated_at', 'astro_pr_merged_at', 'poll_pending_since', 'poll_pending_annotated_at', 'trust_build_approved_at']) t.timestamp(c, { useTz: true });
    });
    await mockPg.schema.createTable('content_briefs', (t) => {
      t.uuid('id').primary(); t.uuid('opportunity_id'); t.text('action_type'); t.timestamp('composed_at', { useTz: true });
    });
    await migration.up(mockPg);
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

  async function seed({ status = 'claimed', outcome = 'completed_published', legacy = false, runPatch = {}, queuePatch = {} } = {}) {
    const id = randomUUID();
    const claim = legacy ? null : randomUUID();
    await mockPg('opportunity_queue').insert({ id, status, action_type: 'new_supporting_blog', bucket: 'seasonal_rising', claim_id: claim,
      claimed_at: new Date(Date.now() - 3600000), mined_at: new Date(), ...queuePatch });
    const run = { id: randomUUID(), opportunity_id: id, queue_claim_id: claim, action_type: 'new_supporting_blog', outcome,
      claimed_at: new Date(), ...(outcome === 'completed_published' ? { published_url: 'https://example.test/article' }
        : { astro_pr_url: 'https://github.com/example/content/pull/1', skip_reason: 'astro_pr_pending_merge' }), ...runPatch };
    await mockPg('autonomous_runs').insert(run);
    return { id, claim, run };
  }

  test.each(['claimed', 'pending'])('recovers a completed publish left %s, idempotently', async (status) => {
    const { id } = await seed({ status });
    await queue.reconcilePublishedClaims();
    const row = await mockPg('opportunity_queue').where({ id }).first();
    expect(row.status).toBe('done');
    await queue.reconcilePublishedClaims();
    expect((await mockPg('opportunity_queue').where({ id }).first()).updated_at).toEqual(row.updated_at);
  });

  test('stale recovery preserves ownership and an external PR blocks a duplicate claim until reconciliation', async () => {
    const { id, claim } = await seed({ outcome: 'completed_pending_review' });
    expect(await queue.claimNext()).toBeNull();
    expect((await mockPg('opportunity_queue').where({ id }).first()).claim_id).toBe(claim);
    await queue.reconcilePublishedClaims();
    expect(await mockPg('opportunity_queue').where({ id }).first()).toMatchObject({ status: 'pending_review', skip_reason: 'astro_pr_pending_merge' });
  });

  test.each(['completed_published', 'completed_pending_review'])('repairs owned %s evidence after the daily expiration sweep', async (outcome) => {
    const { id, claim } = await seed({ status: 'pending', outcome, queuePatch: { expires_at: new Date(Date.now() - 1000) } });
    await queue.expireStale();
    expect((await mockPg('opportunity_queue').where({ id }).first()).status).toBe('expired');
    await queue.sweepExhaustedAttempts();
    expect(await mockPg('opportunity_queue').where({ id }).first()).toMatchObject({
      status: outcome === 'completed_published' ? 'done' : 'pending_review', claim_id: claim,
    });
  });

  test.each([null, randomUUID()])('expired requeued ownership is not overwritten (%s)', async (claim_id) => {
    const { id } = await seed({ status: 'expired', queuePatch: { claim_id } });
    await queue.reconcilePublishedClaims();
    expect((await mockPg('opportunity_queue').where({ id }).first()).status).toBe('expired');
  });

  test.each([null, randomUUID()])('does not overwrite a requeue or replacement owner (%s)', async (claim_id) => {
    const { id } = await seed({ status: 'pending', queuePatch: { claim_id } });
    await queue.reconcilePublishedClaims();
    expect((await mockPg('opportunity_queue').where({ id }).first()).status).toBe('pending');
  });

  test.each(['claimed', 'expired'])('an operator requeue wins while reconciliation waits on the %s row', async (status) => {
    const { id } = await seed({ status });
    const trx = await mockPg.transaction();
    await trx('opportunity_queue').where({ id }).forUpdate().first();
    const repair = queue.reconcilePublishedClaims();
    try {
      for (let attempt = 0; ; attempt++) {
        const waiting = await admin.raw("SELECT 1 FROM pg_stat_activity WHERE application_name = ? AND wait_event_type = 'Lock'", [schema]);
        if (waiting.rows.length) break;
        if (attempt >= 100) throw new Error('Reconciliation did not reach the locked row');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await trx('opportunity_queue').where({ id }).update({ status: 'pending', claim_id: null, claimed_at: null });
    } catch (error) { await trx.rollback(); await repair; throw error; }
    await trx.commit();
    await repair;
    expect((await mockPg('opportunity_queue').where({ id }).first()).status).toBe('pending');
  });

  test('unknown legacy claimed ownership stays fenced instead of guessing', async () => {
    const { id } = await seed({ legacy: true });
    await queue.reconcilePublishedClaims();
    expect((await mockPg('opportunity_queue').where({ id }).first()).status).toBe('claimed');
    expect(await queue.peek()).toEqual([]);
    expect(await queue.claimNext()).toBeNull();
  });

  test('legacy explicit failed-bookkeeping holds still reconcile', async () => {
    const { id } = await seed({ legacy: true, status: 'pending_review', queuePatch: { skip_reason: 'published_queue_complete_failed' } });
    await queue.reconcilePublishedClaims();
    expect((await mockPg('opportunity_queue').where({ id }).first()).status).toBe('done');
  });

  test.each([false, true])('only a verified retired historical PR releases a newer approval hold (retired=%s)', async (retired) => {
    const { id } = await seed({ status: 'pending_review', outcome: 'failed', queuePatch: { skip_reason: 'affiliate_review', claim_id: randomUUID() },
      runPatch: { astro_pr_retired_at: retired ? new Date() : null } });
    await mockPg('autonomous_runs').insert({ id: randomUUID(), opportunity_id: id, action_type: 'new_supporting_blog', outcome: 'completed_pending_review',
      skip_reason: 'affiliate_review', claimed_at: new Date(Date.now() + 1000) });
    expect((await queue.peek()).length).toBe(retired ? 1 : 0);
    const claimed = await queue.claimNext();
    expect(!!claimed).toBe(retired);
    if (claimed) expect(claimed.claim_id).toMatch(/^[a-f0-9-]{36}$/);
  });

  test('a published URL cannot be released by a retirement stamp', async () => {
    await seed({ status: 'pending', runPatch: { astro_pr_retired_at: new Date() } });
    expect(await queue.claimNext()).toBeNull();
  });

  test('a newer run prevents reconciliation by older finalized evidence', async () => {
    const { id } = await seed();
    await mockPg('autonomous_runs').insert({ id: randomUUID(), opportunity_id: id, action_type: 'new_supporting_blog', outcome: 'failed', claimed_at: new Date(Date.now() + 1000) });
    await queue.reconcilePublishedClaims();
    expect((await mockPg('opportunity_queue').where({ id }).first()).status).toBe('claimed');
  });

  test.each(['failed', 'completed_pending_review'])('the real poll query finds a historical %s fence and records verified retirement', async (outcome) => {
    const { id, run } = await seed({ status: 'pending_review', outcome, runPatch: { skip_reason: 'superseded_by_review_queue_action' }, queuePatch: { skip_reason: 'affiliate_review', claim_id: null } });
    const gh = require('../services/content-astro/github-client');
    gh.getPr.mockResolvedValue({ number: 1, state: 'closed', merged: false, head: { ref: 'content/fixture', sha: 'head' } });
    const poller = require('../services/content/autonomous-pr-poller');
    const result = await poller.pollPending();
    expect(result).toMatchObject({ count: 1, results: [{ id: run.id, retired: true }] });
    expect((await mockPg('autonomous_runs').where({ id: run.id }).first()).astro_pr_retired_at).toBeInstanceOf(Date);
    expect((await mockPg('opportunity_queue').where({ id }).first()).skip_reason).toBe('affiliate_review');
    expect((await queue.peek()).map((r) => r.id)).toContain(id);
  });

  test.each(['pending', 'pending_review'])('merged historical PRs leave polling while preserving the %s queue fence', async (status) => {
    const { id, run } = await seed({ status, outcome: 'failed', runPatch: { astro_pr_merged_at: new Date() },
      queuePatch: { skip_reason: 'affiliate_review', claim_id: null } });
    const gh = require('../services/content-astro/github-client');
    gh.getPr.mockClear();
    gh.getPr.mockResolvedValue({ number: 1, state: 'closed', merged: true, head: { ref: 'content/fixture', sha: 'head' } });
    const poller = require('../services/content/autonomous-pr-poller');
    expect(await poller.pollPending()).toMatchObject({ count: 1, results: [{ id: run.id, retired: false }] });
    const observed = await mockPg('autonomous_runs').where({ id: run.id }).first();
    expect(observed.poll_pending_reason).toBe('historical_pr_merged');
    expect(observed.astro_pr_retired_at).toBeNull();
    expect(await poller.pollPending()).toMatchObject({ count: 0 });
    expect(gh.getPr).toHaveBeenCalledTimes(1);
    expect(await queue.claimNext()).toBeNull();
    expect((await mockPg('opportunity_queue').where({ id }).first()).status).toBe(status);
  });

  test('a previously observed historical merge still retries failed terminal bookkeeping', async () => {
    const { run } = await seed({ status: 'pending', outcome: 'failed', runPatch: { astro_pr_merged_at: new Date() } });
    const gh = require('../services/content-astro/github-client');
    gh.getPr.mockResolvedValue({ number: 1, state: 'closed', merged: true });
    const rem = require('../services/content/codex-remediation');
    rem.markPrTerminal.mockResolvedValueOnce({ error: 'db down' });
    const poller = require('../services/content/autonomous-pr-poller');
    await poller.pollPending();
    expect((await mockPg('autonomous_runs').where({ id: run.id }).first()).poll_pending_reason).toBeNull();
    expect(await poller.pollPending()).toMatchObject({ count: 1 });
    expect(await poller.pollPending()).toMatchObject({ count: 0 });
    expect(await queue.claimNext()).toBeNull();
  });

  test('migration rollback and reapply are idempotent inside a rolled-back transaction', async () => {
    const trx = await mockPg.transaction();
    await migration.down(trx); await migration.down(trx);
    expect(await trx.schema.hasColumn('opportunity_queue', 'claim_id')).toBe(false);
    await migration.up(trx); await migration.up(trx);
    expect(await trx.schema.hasColumn('autonomous_runs', 'astro_pr_retired_at')).toBe(true);
    await trx.rollback();
    expect(await mockPg.schema.hasColumn('opportunity_queue', 'claim_id')).toBe(true);
  });
});
