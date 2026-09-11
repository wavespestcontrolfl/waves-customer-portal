// Opt-in query regression on a verified private QA PostgreSQL database.
// Only temporary synthetic tables are used, then the transaction rolls back.
jest.mock('../models/db', () => ({ raw: (...args) => mockPg.raw(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({}));
jest.mock('../services/ops-digest', () => ({
  deliverOpsDigest: () => { throw new Error('No delivery in SQL verification'); },
}));

const { _private: { loadUnansweredThreads } } = require('../services/unworked-comms-watcher');
const connection = process.env.SMS_SOLICITATION_QA_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
let now;

postgres('solicitation evidence in the unanswered digest (PostgreSQL)', () => {
  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) {
      throw new Error('Use a verified private worktree QA database');
    }
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    mockPg = await database.transaction();
    await mockPg.raw(`
      CREATE TEMP TABLE customers (id uuid PRIMARY KEY, phone text, first_name text, last_name text, deleted_at timestamptz);
      CREATE TEMP TABLE sms_log (id uuid, customer_id uuid, direction text, from_phone text, to_phone text,
        message_body text, metadata jsonb, created_at timestamptz, message_type text, status text);
      CREATE TEMP TABLE message_drafts (sms_log_id uuid, customer_id uuid, flags jsonb, sent_at timestamptz);
      CREATE TEMP TABLE blocked_numbers (id uuid PRIMARY KEY, number varchar(32));
    `);
  });
  afterAll(async () => { await mockPg?.rollback(); await database?.destroy(); });
  beforeEach(async () => {
    await mockPg.raw('TRUNCATE sms_log');
    now = Date.now();
  });

  function seed(peer, metadata, age = 1000, endpoint = '+12025550199') {
    return mockPg('sms_log').insert({
      direction: 'inbound', from_phone: `+1${peer}`, to_phone: endpoint,
      message_body: 'Synthetic inbound requiring attention',
      metadata: metadata === null ? null : JSON.stringify(metadata),
      created_at: new Date(now - age), message_type: 'inbound', status: 'received',
    });
  }

  test('ordinary, shadow and low-confidence evidence remain actionable', async () => {
    await seed('2025550101', null);
    await seed('2025550102', { spam_verdict: { solicitation: true, mode: 'shadow' } });
    await seed('2025550103', { spam_verdict: { solicitation: true, confidence: 0.8, enforced: false } });
    await seed('2025550104', { spam_verdict: { enforced: true } });
    const rows = await loadUnansweredThreads(new Date(now));
    expect(rows.map((row) => row.peer).sort()).toEqual(['2025550101', '2025550102', '2025550103']);
  });

  test('the latest enforced pitch retires older inbound without hiding a later genuine reply', async () => {
    await seed('2025550101', null, 2000);
    await seed('2025550101', { spam_verdict: { enforced: true } });
    expect(await loadUnansweredThreads(new Date(now))).toEqual([]);
    await seed('2025550101', { spam_verdict: { solicitation: false, enforced: false } }, 100);
    expect((await loadUnansweredThreads(new Date(now))).map((row) => row.peer)).toEqual(['2025550101']);
  });

  test('enforcement on one business line leaves another conversation actionable', async () => {
    await seed('2025550101', null, 2000, '+12025550198');
    await seed('2025550101', { spam_verdict: { enforced: true } });
    expect(await loadUnansweredThreads(new Date(now))).toHaveLength(1);
  });
});
