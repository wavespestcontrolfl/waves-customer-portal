/** A sent estimate archives the same customer's older, untouched drafts (owner 2026-10-06), against a migrated database. */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');
const { retireDraftsReplacedBySentEstimate } = require('../services/estimate-draft-retire');

const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
jest.setTimeout(60000);

describe('estimate draft retire — wiring', () => {
  test('the gate is strict and read at call time, and the cron checks it each tick', () => {
    const gates = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(gates).toMatch(/function estimateDraftRetireOnSendLive\(\) \{\s*return process\.env\.GATE_ESTIMATE_DRAFT_RETIRE_ON_SEND === 'true';\s*\}/);
    const scheduler = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(scheduler).toMatch(/if \(!require\('\.\.\/config\/feature-gates'\)\.estimateDraftRetireOnSendLive\(\)\) return;\s*try \{\s*await runExclusive\('estimate-draft-retire'/);
  });
});

postgres('estimate draft retire (PostgreSQL)', () => {
  const minutesAgo = (n) => new Date(Date.now() - n * 60000);

  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
  });
  beforeEach(async () => { mockPg = await database.transaction(); });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  async function customer() {
    const id = randomUUID();
    await mockPg('customers').insert({ id, first_name: 'Fixture', last_name: 'Retire', phone: '+12025550123', email: `${id}@example.invalid`, property_type: 'residential' });
    return id;
  }
  async function estimate(customerId, { status = 'draft', createdAt, updatedAt = createdAt, sentAt = null, data = {}, ...rest } = {}) {
    const id = randomUUID();
    await mockPg('estimates').insert({
      id, customer_id: customerId, status, created_at: createdAt, updated_at: updatedAt, sent_at: sentAt,
      token: randomUUID().replace(/-/g, ''), customer_name: 'Fixture Retire', estimate_data: JSON.stringify(data), ...rest,
    });
    return id;
  }
  const row = (id) => mockPg('estimates').where({ id }).first();
  // The shape from the 2026-10-05 call: an auto draft at 11:22, a staff draft
  // at 5:28, then a third estimate created 5:53 and sent 5:54.
  async function sentAfterTwoDrafts() {
    const c = await customer();
    const autoDraft = await estimate(c, { createdAt: minutesAgo(400), source: 'lead_webhook' });
    const staffDraft = await estimate(c, { createdAt: minutesAgo(30), source: 'manual' });
    const sent = await estimate(c, { status: 'viewed', createdAt: minutesAgo(10), updatedAt: minutesAgo(9), sentAt: minutesAgo(9) });
    return { c, autoDraft, staffDraft, sent };
  }

  test('archives both older drafts and names the sent estimate; the sent one is untouched', async () => {
    const { autoDraft, staffDraft, sent } = await sentAfterTwoDrafts();
    const result = await retireDraftsReplacedBySentEstimate();
    expect(result.retired).toBe(2);
    for (const id of [autoDraft, staffDraft]) {
      const r = await row(id);
      expect(r.status).toBe('draft');
      expect(r.archived_at).not.toBeNull();
      expect(r.estimate_data.retiredBySentEstimate.estimate_id).toBe(sent);
    }
    expect((await row(sent)).archived_at).toBeNull();
    // Idempotent: a second pass finds nothing.
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(0);
  });

  test('keeps a draft started after the send, and a draft edited after the send', async () => {
    const c = await customer();
    const edited = await estimate(c, { createdAt: minutesAgo(60), updatedAt: minutesAgo(2) });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    const newer = await estimate(c, { createdAt: minutesAgo(5) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(0);
    expect((await row(edited)).archived_at).toBeNull();
    expect((await row(newer)).archived_at).toBeNull();
  });

  test('keeps drafts with no sent estimate, of another customer, or held by another flow', async () => {
    const lone = await customer();
    const loneDraft = await estimate(lone, { createdAt: minutesAgo(60) });
    const c = await customer();
    const scheduled = await estimate(c, { createdAt: minutesAgo(60), scheduled_at: minutesAgo(-60) });
    const locked = await estimate(c, { createdAt: minutesAgo(60), price_locked_at: minutesAgo(50) });
    const grouped = await estimate(c, { createdAt: minutesAgo(60), estimate_group_id: randomUUID() });
    const repricing = await estimate(c, { createdAt: minutesAgo(60), data: { estimatorEngine: { reprice_pending_at: minutesAgo(50).toISOString() } } });
    const delivering = await estimate(c, { createdAt: minutesAgo(60), data: { estimatorEngine: { delivering_at: new Date().toISOString() } } });
    const addressHold = await estimate(c, { createdAt: minutesAgo(60), data: { addressUnverifiedFlag: { reason: 'fixture' } } });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(0);
    for (const id of [loneDraft, scheduled, locked, grouped, repricing, delivering, addressHold]) {
      expect((await row(id)).archived_at).toBeNull();
    }
  });

  test('a retired draft comes back through the normal unarchive predicate (no permanent marker)', async () => {
    const { autoDraft } = await sentAfterTwoDrafts();
    await retireDraftsReplacedBySentEstimate();
    const restored = await mockPg('estimates')
      .where({ id: autoDraft })
      .whereNotNull('archived_at')
      .whereRaw("estimate_data->'estimatorEngine'->>'linkage_invalidated_at' IS NULL")
      .whereRaw("estimate_data->'estimatorEngine'->>'superseded_at' IS NULL")
      .update({ archived_at: null });
    expect(restored).toBe(1);
  });
});
