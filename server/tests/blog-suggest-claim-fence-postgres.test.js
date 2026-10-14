/**
 * "Suggest a post" claim fence on real PostgreSQL (GATE_BLOG_SEARCH_SUGGEST;
 * GitHub Codex P1 on e8a1e9e876): with the gate off the queue claims no row a
 * suggestion wrote (signal_metadata.source tech_blog_search) and still claims
 * every other row, one with no signal_metadata or no source included; with
 * the gate back on the waiting suggestion is claimed as any row is. Isolated
 * schema on a loopback waves_test database (same harness as
 * aeo-question-claim-fence-postgres); never reads the application's
 * DATABASE_URL.
 */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Every other lane open: the suggestion gate is the only thing under test.
let mockSuggestLive = false;
jest.mock('../config/feature-gates', () => ({
  gateEnvTimestamp: () => null,
  isEnabled: () => true,
  blogSearchSuggestLive: () => mockSuggestLive,
}));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const queue = require('../services/content/opportunity-queue');
const { suggestionRow } = require('../services/service-report/report-blog-suggestion');
const migration = require('../models/migrations/20260905000020_blog_queue_ownership');

const connection = process.env.REPORT_BLOG_SEARCH_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `suggest_fence_${randomUUID().replaceAll('-', '')}`;
let admin;
let mockPg;

postgres('"Suggest a post" claim fence on PostgreSQL', () => {
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
      t.text('page_url'); t.text('dedupe_key'); t.text('query'); t.text('service'); t.text('city');
      t.integer('attempt_count').defaultTo(0); t.integer('score').defaultTo(90);
      t.jsonb('score_breakdown'); t.jsonb('signal_metadata');
      for (const c of ['claimed_at', 'completed_at', 'updated_at', 'available_at', 'expires_at', 'mined_at']) t.timestamp(c, { useTz: true });
    });
    await mockPg.schema.createTable('autonomous_runs', (t) => {
      t.uuid('id').primary(); t.uuid('opportunity_id'); t.text('action_type');
      t.text('astro_pr_url'); t.text('published_url'); t.timestamp('claimed_at', { useTz: true });
      t.text('outcome'); t.text('skip_reason'); t.timestamp('created_at', { useTz: true }).defaultTo(mockPg.fn.now());
    });
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
    mockSuggestLive = false;
    await mockPg('autonomous_runs').del();
    await mockPg('opportunity_queue').del();
  });

  // The suggestion exactly as the route writes it, and new-blog rows other
  // lanes write: one with a source, one with metadata but no source, one with
  // no metadata at all.
  const suggestion = (phrase) => {
    const row = suggestionRow(phrase, { actorId: 'admin-1', scheduledServiceId: randomUUID() });
    return {
      ...row, id: randomUUID(), mined_at: new Date(),
      signal_metadata: JSON.stringify(row.signal_metadata), score_breakdown: JSON.stringify(row.score_breakdown),
    };
  };
  const otherBlog = (signalMetadata) => ({
    id: randomUUID(), status: 'pending', action_type: 'new_supporting_blog', bucket: 'no_content_yet', score: 80,
    query: `topic ${randomUUID()}`, dedupe_key: `other:${randomUUID()}`, mined_at: new Date(),
    signal_metadata: signalMetadata === null ? null : JSON.stringify(signalMetadata),
  });
  async function claimAll() {
    const claimed = [];
    for (;;) {
      const row = await queue.claimNext({ minScore: 0 });
      if (!row) return claimed;
      claimed.push(row.id);
    }
  }

  test('gate off: every other row is claimed, a queued suggestion waits; back on, it is claimed', async () => {
    const waiting = suggestion('standing water');
    const others = [otherBlog({ source: 'gsc_miner' }), otherBlog({}), otherBlog(null)];
    await mockPg('opportunity_queue').insert([waiting, ...others]);

    expect((await queue.peek({ limit: 10 })).map((row) => row.id)).not.toContain(waiting.id);
    expect((await claimAll()).sort()).toEqual(others.map((row) => row.id).sort());
    expect(await mockPg('opportunity_queue').where({ id: waiting.id }).first('status')).toEqual({ status: 'pending' });

    mockSuggestLive = true;
    expect((await queue.peek({ limit: 10 })).map((row) => row.id)).toEqual([waiting.id]);
    expect(await claimAll()).toEqual([waiting.id]);
  });

  test('gate on: a suggestion is claimed by its score like any row', async () => {
    mockSuggestLive = true;
    const first = suggestion('standing water');
    const other = otherBlog(null);
    await mockPg('opportunity_queue').insert([first, other]);
    expect(await claimAll()).toEqual([other.id, first.id]);
  });
});
