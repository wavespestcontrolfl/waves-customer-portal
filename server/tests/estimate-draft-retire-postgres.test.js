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
    const staffDraft = await estimate(c, { createdAt: minutesAgo(45), source: 'manual' });
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

  test('drafts with a booking handoff, a clarify text or a website quote are kept; a closed lead also keeps its draft; bells close', async () => {
    const { autoDraft, staffDraft } = await sentAfterTwoDrafts();
    const leadId = randomUUID();
    await mockPg('leads').insert({ id: leadId, estimate_id: autoDraft, status: 'lost', first_name: 'Fixture', last_name: 'Retire' });
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
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(2);
    expect((await row(oldClarify)).archived_at).not.toBeNull();
    expect((await row(staffDraft)).archived_at).not.toBeNull();
    expect((await row(autoDraft)).archived_at).toBeNull();
    expect((await mockPg('leads').where({ id: leadId }).first()).estimate_id).toBe(autoDraft);
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

  test('a draft with an uncertain send attempt is kept', async () => {
    const c = await customer();
    const uncertain = await estimate(c, { createdAt: minutesAgo(90), data: { manualSendAttempts: [{ key: 'k1', startedAt: minutesAgo(80).toISOString() }] } });
    const resolved = await estimate(c, { createdAt: minutesAgo(90), data: { manualSendAttempts: [{ key: 'k2', startedAt: minutesAgo(80).toISOString(), result: { sent: false } }] } });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(uncertain)).archived_at).toBeNull();
    expect((await row(resolved)).archived_at).not.toBeNull();
  });

  test('an open lead keeps its draft for staff, and the sweep writes nothing to leads', async () => {
    const c = await customer();
    const kept = await estimate(c, { createdAt: minutesAgo(90) });
    const sent = await estimate(c, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    const leadId = randomUUID();
    await mockPg('leads').insert({ id: leadId, estimate_id: kept, status: 'contacted', first_name: 'Fixture', last_name: 'Retire' });
    const c2 = await customer();
    const other = await estimate(c2, { createdAt: minutesAgo(90) });
    await estimate(c2, { status: 'sent', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    const before = await mockPg('leads').where({ id: leadId }).first();
    expect((await retireDraftsReplacedBySentEstimate({ limit: 1 })).retired).toBe(1);
    expect((await row(kept)).archived_at).toBeNull();
    expect((await row(other)).archived_at).not.toBeNull();
    expect((await row(sent)).archived_at).toBeNull();
    const after = await mockPg('leads').where({ id: leadId }).first();
    expect(after.estimate_id).toBe(kept);
    expect(after.status).toBe('contacted');
    expect(String(after.updated_at)).toBe(String(before.updated_at));
  });

  test('an undelivered report or restart mint is not a send; a declined real send still retires a draft', async () => {
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(90) });
    await estimate(c, { status: 'sent', source: 'service_report_cta', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    await estimate(c, { status: 'sent', source: 'plan_restart', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    await estimate(c, { status: 'sent', source: 'quote_wizard', createdAt: minutesAgo(20), sentAt: minutesAgo(10) });
    const c2 = await customer();
    const draft2 = await estimate(c2, { createdAt: minutesAgo(90), customer_phone: '+12025550199' });
    await estimate(c2, { status: 'declined', createdAt: minutesAgo(20), sentAt: minutesAgo(10), customer_phone: '+12025550199' });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(draft)).archived_at).toBeNull();
    expect((await row(draft2)).archived_at).not.toBeNull();
  });

  test('six newer other-door sends with property ids do not outrank the same-address send', async () => {
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(200) });
    const sameDoor = await estimate(c, { status: 'sent', createdAt: minutesAgo(190), sentAt: minutesAgo(180) });
    // The draft has no property_id, so the property match is NULL for these.
    const otherProperty = randomUUID();
    await mockPg('customer_properties').insert({ id: otherProperty, customer_id: c });
    for (let i = 0; i < 6; i += 1) {
      await estimate(c, { status: 'sent', createdAt: minutesAgo(100 - i), sentAt: minutesAgo(90 - i), address: `${700 + i} Elsewhere Blvd, Testville, FL 34000`, property_id: otherProperty });
    }
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(draft)).estimate_data.retiredBySentEstimate.estimate_id).toBe(sameDoor);
  });

  test('a deleted lead being restored in another transaction makes the sweep skip its draft', async () => {
    const c = randomUUID();
    const draft = randomUUID();
    const sent = randomUUID();
    const leadId = randomUUID();
    await database('customers').insert({ id: c, first_name: 'Fixture', last_name: 'RetireReopen', phone: '+12025550123', email: `${c}@example.invalid`, property_type: 'residential' });
    const base = { customer_id: c, customer_name: 'Fixture RetireReopen', address: '100 Fixture Way, Testville, FL 34000', estimate_data: '{}' };
    await database('estimates').insert([
      { ...base, id: draft, status: 'draft', token: randomUUID().replace(/-/g, ''), created_at: minutesAgo(60), updated_at: minutesAgo(60) },
      { ...base, id: sent, status: 'sent', token: randomUUID().replace(/-/g, ''), created_at: minutesAgo(20), updated_at: minutesAgo(10), sent_at: minutesAgo(10) },
    ]);
    await database('leads').insert({ id: leadId, estimate_id: draft, status: 'lost', first_name: 'Fixture', last_name: 'RetireReopen', deleted_at: minutesAgo(5) });
    const reopen = await database.transaction();
    try {
      await reopen('leads').where({ id: leadId }).update({ deleted_at: null });
      const result = await retireDraftsReplacedBySentEstimate();
      expect(result.rows.find((r) => r.id === draft)).toBeUndefined();
      expect((await database('estimates').where({ id: draft }).first()).archived_at).toBeNull();
    } finally {
      await reopen.rollback();
      await database('leads').where({ id: leadId }).del();
      await database('estimates').whereIn('id', [draft, sent]).del();
      await database('customers').where({ id: c }).del();
    }
  });

  test('a replacement another transaction holds locked is skipped, not waited on', async () => {
    // Needs two real connections, so this case commits its own fixtures and cleans them up.
    const c = randomUUID();
    const draft = randomUUID();
    const sent = randomUUID();
    await database('customers').insert({ id: c, first_name: 'Fixture', last_name: 'RetireLock', phone: '+12025550123', email: `${c}@example.invalid`, property_type: 'residential' });
    const base = { customer_id: c, customer_name: 'Fixture RetireLock', address: '100 Fixture Way, Testville, FL 34000', estimate_data: '{}' };
    await database('estimates').insert([
      { ...base, id: draft, status: 'draft', token: randomUUID().replace(/-/g, ''), created_at: minutesAgo(60), updated_at: minutesAgo(60) },
      { ...base, id: sent, status: 'sent', token: randomUUID().replace(/-/g, ''), created_at: minutesAgo(20), updated_at: minutesAgo(10), sent_at: minutesAgo(10) },
    ]);
    const holder = await database.transaction();
    try {
      await holder('estimates').where({ id: sent }).forUpdate().first('id');
      const started = Date.now();
      // Runs in this test's own transaction (rolled back in afterEach), so the
      // sweep can never persist a change to another suite's rows.
      const result = await retireDraftsReplacedBySentEstimate();
      expect(result.rows.find((r) => r.id === draft)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(10000);
      expect((await database('estimates').where({ id: draft }).first()).archived_at).toBeNull();
    } finally {
      await holder.rollback();
      await database('estimates').whereIn('id', [draft, sent]).del();
      await database('customers').where({ id: c }).del();
    }
  });

  test('a draft younger than the settle window is kept', async () => {
    const c = await customer();
    const fresh = await estimate(c, { createdAt: minutesAgo(12), updatedAt: minutesAgo(12) });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(8), sentAt: minutesAgo(5) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(0);
    expect((await row(fresh)).archived_at).toBeNull();
  });

  test('the fence is the last real delivery, not a sent_at a failed resend moved', async () => {
    const c = await customer();
    // Delivered 60 min ago; the draft was edited 30 min ago; a resend that delivered nothing stamped sent_at 5 min ago.
    const edited = await estimate(c, { createdAt: minutesAgo(200), updatedAt: minutesAgo(30) });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(100), sentAt: minutesAgo(5), data: { deliveryState: { firstDeliveredAt: minutesAgo(60).toISOString(), lastDeliveredAt: minutesAgo(60).toISOString() } } });
    // A suppressed first send: delivery tracking exists, nothing was delivered.
    const c2 = await customer();
    const draft2 = await estimate(c2, { createdAt: minutesAgo(200) });
    await estimate(c2, { status: 'sent', createdAt: minutesAgo(100), sentAt: minutesAgo(90), data: { deliveryState: { attemptedAt: minutesAgo(90).toISOString(), sentChannels: [], failedChannels: ['sms'] } } });
    // The older tracking shape: sent channels listed, no lastDeliveredAt. It is a real send.
    const c3 = await customer();
    const draft3 = await estimate(c3, { createdAt: minutesAgo(200) });
    await estimate(c3, { status: 'viewed', createdAt: minutesAgo(100), sentAt: minutesAgo(90), viewed_at: minutesAgo(80), data: { deliveryState: { attemptedAt: minutesAgo(90).toISOString(), sentChannels: ['sms'], failedChannels: [] } } });
    // The same shape never opened by the customer may be a suppressed send: not proof.
    const c4 = await customer();
    const draft4 = await estimate(c4, { createdAt: minutesAgo(200) });
    await estimate(c4, { status: 'sent', createdAt: minutesAgo(100), sentAt: minutesAgo(90), data: { deliveryState: { attemptedAt: minutesAgo(90).toISOString(), sentChannels: ['sms'], failedChannels: [] } } });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(draft3)).archived_at).not.toBeNull();
    expect((await row(draft4)).archived_at).toBeNull();
    expect((await row(edited)).archived_at).toBeNull();
    expect((await row(draft2)).archived_at).toBeNull();
  });

  test('a soft-deleted lead is no hold and keeps its link; the newest same-door send is the one recorded', async () => {
    const c = await customer();
    const draft = await estimate(c, { createdAt: minutesAgo(300) });
    await estimate(c, { status: 'sent', createdAt: minutesAgo(250), sentAt: minutesAgo(240) });
    const newest = await estimate(c, { status: 'accepted', createdAt: minutesAgo(100), sentAt: minutesAgo(90) });
    const leadId = randomUUID();
    await mockPg('leads').insert({ id: leadId, estimate_id: draft, status: 'new', first_name: 'Fixture', last_name: 'Retire', deleted_at: minutesAgo(50) });
    expect((await retireDraftsReplacedBySentEstimate()).retired).toBe(1);
    expect((await row(draft)).estimate_data.retiredBySentEstimate.estimate_id).toBe(newest);
    expect((await mockPg('leads').where({ id: leadId }).first()).estimate_id).toBe(draft);
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
