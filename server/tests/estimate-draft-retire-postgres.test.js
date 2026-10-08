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
      token: randomUUID().replace(/-/g, ''), customer_name: 'Fixture Retire', address: '100 Fixture Way, Testville, FL 34000', estimate_data: JSON.stringify(data), ...rest,
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
    const addressHold = await estimate(c, { createdAt: minutesAgo(60), data: { addressUnverified: true } });
    const oneTap = await estimate(c, { createdAt: minutesAgo(60), source: 'one_tap_purchase' });
    const otherAddress = await estimate(c, { createdAt: minutesAgo(60), address: '200 Other Rd, Testville, FL 34000' });
    const noAddress = await estimate(c, { createdAt: minutesAgo(60), address: null });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(0);
    for (const id of [loneDraft, scheduled, locked, grouped, repricing, delivering, addressHold, oneTap, otherAddress, noAddress]) {
      expect((await row(id)).archived_at).toBeNull();
    }
  });

  test('a cleared address hold does not block, and an invalidated send is not proof of a send', async () => {
    const c = await customer();
    const cleared = await estimate(c, { createdAt: minutesAgo(60), data: { addressUnverifiedFlag: null, addressUnverified: null } });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    const c2 = await customer();
    const kept = await estimate(c2, { createdAt: minutesAgo(60) });
    await estimate(c2, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10), data: { estimatorEngine: { linkage_invalidated_at: minutesAgo(5).toISOString() } } });
    await estimate(c2, { status: 'draft', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(cleared)).archived_at).not.toBeNull();
    expect((await row(kept)).archived_at).toBeNull();
  });

  test('the same door in another spelling matches; another unit does not', async () => {
    const c = await customer();
    const spelled = await estimate(c, { createdAt: minutesAgo(60), address: '100 Fixture Terrace, Testville, FL 34000' });
    const otherUnit = await estimate(c, { createdAt: minutesAgo(60), address: '100 Fixture Ter Apt 3, Testville, FL 34000' });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10), address: '100 Fixture Ter, Testville, FL 34000, USA' });
    const c2 = await customer();
    const unitAlias = await estimate(c2, { createdAt: minutesAgo(60), address: '9 Fixture Ct Unit 4, Testville, FL 34000' });
    await estimate(c2, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10), address: '9 Fixture Ct #4, Testville, FL 34000' });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(2);
    expect((await row(spelled)).archived_at).not.toBeNull();
    expect((await row(unitAlias)).archived_at).not.toBeNull();
    expect((await row(otherUnit)).archived_at).toBeNull();
  });

  test('a sent estimate moved to another address after the read does not archive the old draft', async () => {
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(60) });
    const sent = await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    // The move lands right after the pair read, before the write.
    const realRaw = mockPg.raw;
    mockPg.raw = async (...args) => {
      const out = await realRaw.apply(mockPg, args);
      mockPg.raw = realRaw;
      await mockPg('estimates').where({ id: sent }).update({ address: '500 Elsewhere Blvd, Testville, FL 34000' });
      return out;
    };
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(0);
    expect((await row(draft)).archived_at).toBeNull();
  });

  test('drafts with a booking handoff, a clarify text or a website quote are kept; a lead link is cleared; bells close', async () => {
    const { autoDraft, staffDraft } = await sentAfterTwoDrafts();
    const leadId = randomUUID();
    await mockPg('leads').insert({ id: leadId, estimate_id: autoDraft, first_name: 'Fixture', last_name: 'Retire' });
    const c = await customer();
    const handoff = await estimate(c, { createdAt: minutesAgo(60) });
    const clarify = await estimate(c, { createdAt: minutesAgo(60) });
    const wizard = await estimate(c, { createdAt: minutesAgo(60), source: 'quote_wizard' });
    const assessmentLinked = await estimate(c, { createdAt: minutesAgo(60), data: { scheduled_service_id: randomUUID() } });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    await mockPg('booking_intents').insert({ id: randomUUID(), phone: '+12025550123', pricing_estimate_id: handoff, suppressed: false });
    await mockPg('message_drafts').insert({ id: randomUUID(), intent: 'estimate_clarify', status: 'pending', flags: JSON.stringify({ estimate_id: clarify }) });
    // A rejected (terminal) clarification is history, not a live dependent.
    const oldClarify = await estimate(c, { createdAt: minutesAgo(60) });
    await mockPg('message_drafts').insert({ id: randomUUID(), intent: 'estimate_clarify', status: 'rejected', flags: JSON.stringify({ estimate_id: oldClarify }) });
    const bellId = randomUUID();
    await mockPg('notifications').insert({ id: bellId, recipient_type: 'admin', category: 'lead', title: 'Draft ready', metadata: JSON.stringify({ estimateId: staffDraft }) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(3);
    expect((await row(oldClarify)).archived_at).not.toBeNull();
    expect((await row(staffDraft)).archived_at).not.toBeNull();
    expect((await row(autoDraft)).archived_at).not.toBeNull();
    expect((await mockPg('leads').where({ id: leadId }).first()).estimate_id).toBeNull();
    for (const id of [handoff, clarify, wizard, assessmentLinked]) expect((await row(id)).archived_at).toBeNull();
    const bell = await mockPg('notifications').where({ id: bellId }).first();
    expect(bell.done_at).not.toBeNull();
    expect(bell.done_by).toBe('estimate-draft-retire');
    expect(bell.read_at).not.toBeNull();
    expect(bell.resolution).toContain('newer estimate was sent');
  });

  test('a newer send for another property does not hide the send that replaced the draft', async () => {
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(90) });
    const sameDoor = await estimate(c, { status: 'sent', createdAt: minutesAgo(60), sentAt: minutesAgo(50) });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10), address: '500 Elsewhere Blvd, Testville, FL 34000' });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(draft)).estimate_data.retiredBySentEstimate.estimate_id).toBe(sameDoor);
  });

  test('an unlinked lead is advanced to the sent estimate when it is the single contact match', async () => {
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(90), customer_phone: '+12025550177' });
    const sent = await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10), customer_phone: '+12025550177' });
    const leadId = randomUUID();
    await mockPg('leads').insert({ id: leadId, estimate_id: draft, status: 'new', phone: '+12025550177', first_name: 'Fixture', last_name: 'Retire', created_at: minutesAgo(120) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    const lead = await mockPg('leads').where({ id: leadId }).first();
    expect(lead.estimate_id).toBe(sent);
    expect(lead.status).toBe('estimate_sent');
  });

  test('no replay when a lead already owns the sent estimate', async () => {
    const { autoDraft, sent } = await sentAfterTwoDrafts();
    const draftLead = randomUUID();
    const sentLead = randomUUID();
    await mockPg('leads').insert([
      { id: draftLead, estimate_id: autoDraft, status: 'new', first_name: 'Fixture', last_name: 'Retire' },
      { id: sentLead, estimate_id: sent, status: 'estimate_sent', first_name: 'Fixture', last_name: 'Retire' },
    ]);
    const before = await mockPg('lead_activities').where({ lead_id: sentLead }).count('* as n').first();
    await retireDraftsReplacedBySentEstimate();
    expect((await mockPg('leads').where({ id: draftLead }).first()).estimate_id).toBeNull();
    expect((await mockPg('lead_activities').where({ lead_id: sentLead }).count('* as n').first()).n).toBe(before.n);
  });

  test('a draft with an uncertain send attempt is kept', async () => {
    const c = await customer();
    const uncertain = await estimate(c, { createdAt: minutesAgo(90), data: { manualSendAttempts: [{ key: 'k1', startedAt: minutesAgo(80).toISOString() }] } });
    const resolved = await estimate(c, { createdAt: minutesAgo(90), data: { manualSendAttempts: [{ key: 'k2', startedAt: minutesAgo(80).toISOString(), result: { sent: false } }] } });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(uncertain)).archived_at).toBeNull();
    expect((await row(resolved)).archived_at).not.toBeNull();
  });

  test('a viewed replacement advances the lead to viewed; an accepted one keeps a lead-linked draft', async () => {
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(90), customer_phone: '+12025550188' });
    await estimate(c, { status: 'viewed', createdAt: minutesAgo(20), sentAt: minutesAgo(10), customer_phone: '+12025550188' });
    const leadId = randomUUID();
    await mockPg('leads').insert({ id: leadId, estimate_id: draft, status: 'new', phone: '+12025550188', first_name: 'Fixture', last_name: 'Retire', created_at: minutesAgo(120) });
    const c2 = await customer();
    const keptDraft = await estimate(c2, { createdAt: minutesAgo(90) });
    await estimate(c2, { status: 'accepted', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    await mockPg('leads').insert({ id: randomUUID(), estimate_id: keptDraft, status: 'new', first_name: 'Fixture', last_name: 'Retire' });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await mockPg('leads').where({ id: leadId }).first()).status).toBe('estimate_viewed');
    expect((await row(keptDraft)).archived_at).toBeNull();
  });

  test('kept candidates do not use up the batch', async () => {
    const c = await customer();
    const kept = await estimate(c, { createdAt: minutesAgo(90) });
    await estimate(c, { status: 'accepted', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    await mockPg('leads').insert({ id: randomUUID(), estimate_id: kept, status: 'new', first_name: 'Fixture', last_name: 'Retire' });
    const c2 = await customer();
    const other = await estimate(c2, { createdAt: minutesAgo(90) });
    await estimate(c2, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    expect((await retireDraftsReplacedBySentEstimate({ limit: 1 })).retired).toBe(1);
    expect((await row(kept)).archived_at).toBeNull();
    expect((await row(other)).archived_at).not.toBeNull();
  });

  test('an undelivered report or restart mint is not a send; a declined replacement unlinks without a replay', async () => {
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(90) });
    await estimate(c, { status: 'sent', source: 'service_report_cta', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    await estimate(c, { status: 'sent', source: 'plan_restart', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    await estimate(c, { status: 'sent', source: 'quote_wizard', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    const c2 = await customer();
    const draft2 = await estimate(c2, { createdAt: minutesAgo(90), customer_phone: '+12025550199' });
    await estimate(c2, { status: 'declined', createdAt: minutesAgo(20), sentAt: minutesAgo(10), customer_phone: '+12025550199' });
    const leadId = randomUUID();
    await mockPg('leads').insert({ id: leadId, estimate_id: draft2, status: 'new', phone: '+12025550199', first_name: 'Fixture', last_name: 'Retire', created_at: minutesAgo(120) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(draft)).archived_at).toBeNull();
    const lead = await mockPg('leads').where({ id: leadId }).first();
    expect(lead.estimate_id).toBeNull();
    expect(lead.status).toBe('new');
  });

  test('a lead linked after the pair read keeps a draft whose replacement is accepted', async () => {
    const lateLink = async (draftId) => {
      const realRaw = mockPg.raw;
      mockPg.raw = async (...args) => {
        const out = await realRaw.apply(mockPg, args);
        mockPg.raw = realRaw;
        await mockPg('leads').insert({ id: randomUUID(), estimate_id: draftId, status: 'new', first_name: 'Fixture', last_name: 'Retire' });
        return out;
      };
    };
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(90) });
    await estimate(c, { status: 'accepted', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    await lateLink(draft);
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(0);
    expect((await row(draft)).archived_at).toBeNull();
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
