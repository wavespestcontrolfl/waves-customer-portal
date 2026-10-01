// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// scripts/rider-series-apply-approved.js — the ONE-TIME, owner-approved,
// silent move of quarterly pest visits onto the customer's lawn dates.
// Proves: a dry run writes nothing; an apply moves exactly the approved set
// (host window/tech, no grouping, no insert); drift / occupancy / add-on /
// lock refusals skip the whole pair and write nothing; rollback restores and
// refuses a row that changed since; and NO message-side table gets a row.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { previewRiderPair, TARGET_GAP_DAYS } = require('../services/rider-series-preview');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { applyApproved, rollbackApplied } = require('../../scripts/rider-series-apply-approved');

function addDays(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}

jest.setTimeout(180000);

// Every table a message, notice, tech push or series-move effect would land in.
const SILENT_TABLES = ['outbox_messages', 'series_moves', 'sms_log', 'messaging_audit_log', 'reschedule_log', 'job_status_history'];

postgres('rider-series one-time apply against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let techId;
  let tmpDir;

  const LAWN_START = '2098-01-08';
  const ANCHOR = addDays(LAWN_START, -TARGET_GAP_DAYS);

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !ownedQA && !privateQa) throw new Error("Use disposable CI or this worktree's private QA database");
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rider-apply-'));
  });

  // The apply path lazily loads the schedule route and its service graph; pay
  // that cost once here rather than inside the first test's timeout.
  beforeAll(() => {
    require('../routes/admin-schedule');
    for (const m of ['cancellation-processor', 'no-show-detector', 'recurring-appointment-seeder', 'self-booking-plan-sync', 'complete-scheduled-service', 'billing-lane', 'series-customer-eligibility']) {
      require(`../services/${m}`);
    }
  }, 300000);

  beforeEach(async () => {
    trx = await database.transaction();
    customerId = randomUUID();
    techId = randomUUID();
    await trx('technicians').insert({
      id: techId, name: 'Synthetic tech', employment_status: 'active', field_dispatchable: true,
    });
    await trx('customers').insert({
      id: customerId,
      first_name: 'Rider-apply',
      last_name: 'Fixture',
      email: `${customerId}@example.invalid`,
      phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      address_line1: '100 Test Lane',
      city: 'Test City',
      zip: '00000',
      active: true,
      pipeline_stage: 'active_customer',
    });
  });

  afterEach(async () => { if (trx && !trx.isCompleted()) await trx.rollback().catch(() => {}); });
  afterAll(async () => {
    await database?.destroy();
    await require('../models/db').destroy();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function row(overrides = {}) {
    const [r] = await trx('scheduled_services').insert({
      id: randomUUID(),
      customer_id: customerId,
      status: 'confirmed',
      is_recurring: true,
      recurring_ongoing: false,
      service_type: 'Test Service',
      ...overrides,
    }).returning('*');
    return r;
  }

  // Lawn host (every 6 weeks, 09:00-10:00, tech) + pest rider (quarterly,
  // completed anchor + two pending children the plan moves onto lawn dates).
  async function buildPair({ pestTech = null } = {}) {
    const lawnParent = await row({
      recurring_ongoing: true,
      recurring_pattern: 'every_6_weeks',
      service_type: 'Lawn Care - Every 6 Weeks',
      scheduled_date: LAWN_START,
      window_start: '09:00',
      window_end: '10:00',
      technician_id: techId,
    });
    for (let i = 1; i <= 6; i++) {
      await row({
        recurring_parent_id: lawnParent.id,
        recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks',
        service_type: 'Lawn Care - Every 6 Weeks',
        scheduled_date: addDays(LAWN_START, i * 42),
        window_start: '09:00',
        window_end: '10:00',
        technician_id: techId,
      });
    }
    const pestParent = await row({
      status: 'completed',
      recurring_ongoing: true,
      recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control',
      scheduled_date: ANCHOR,
      estimated_price: 100,
      create_invoice_on_complete: true,
      window_start: '14:00',
      window_end: '15:00',
    });
    const kids = [];
    for (const off of [91, 182]) {
      kids.push(await row({
        recurring_parent_id: pestParent.id,
        recurring_ongoing: true,
        status: 'pending',
        recurring_pattern: 'quarterly',
        service_type: 'Quarterly Pest Control',
        scheduled_date: addDays(ANCHOR, off),
        estimated_price: 100,
        create_invoice_on_complete: true,
        window_start: '14:00',
        window_end: '15:00',
        route_order: 3,
        technician_id: pestTech,
      }));
    }
    return { lawnParent, pestParent, kids };
  }

  async function approvedFor({ lawnParent, pestParent }) {
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.reasons).toEqual([]);
    expect(preview.eligible).toBe(true);
    return {
      generatedAt: new Date().toISOString(),
      results: [{
        lawnParentId: lawnParent.id, pestParentId: pestParent.id, customerId, propertyId: null, extraReasons: [], ...preview,
      }],
    };
  }

  const dateOnly = (v) => (v instanceof Date ? require('../utils/datetime-et').etCalendarDayOf(v) : String(v).slice(0, 10));

  async function silentCounts() {
    const out = {};
    for (const t of SILENT_TABLES) out[t] = Number((await trx(t).count('* as n').first()).n);
    return out;
  }

  async function snapshot() {
    return JSON.stringify(await trx('scheduled_services').select('*').orderBy('id'));
  }

  function rollbackPath() { return path.join(tmpDir, `rollback-${randomUUID()}.json`); }

  test('dry run writes and locks nothing and reports the approved moves', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const before = await snapshot();
    const res = await applyApproved(trx, approved, { apply: false });
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0]).toMatchObject({ status: 'would_apply' });
    expect(res.pairs[0].moves.map((m) => [m.from, m.to])).toEqual(
      approved.results[0].move.map((m) => [m.from, m.to]),
    );
    expect(res.pairs[0].insertDeferred).toEqual(approved.results[0].insert);
    expect(await snapshot()).toBe(before);
    // The outer connection is read-write again after the forced dry-run rollback.
    await row({ service_type: 'still writable', scheduled_date: LAWN_START });
  });

  test('apply moves exactly the approved rows onto the host window and tech, inserts nothing, groups nothing, messages nothing', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const rowsBefore = await trx('scheduled_services').select('id');
    const silentBefore = await silentCounts();
    const out = rollbackPath();
    const res = await applyApproved(trx, approved, { apply: true, rollbackOut: out });
    expect(res.pairs[0]).toMatchObject({ status: 'applied' });
    expect(res.moved).toBe(2);

    for (const m of approved.results[0].move) {
      const after = await trx('scheduled_services').where({ id: m.id }).first();
      expect(dateOnly(after.scheduled_date)).toBe(m.to);
      expect(String(after.window_start).slice(0, 5)).toBe('09:00');
      expect(String(after.window_end).slice(0, 5)).toBe('10:00');
      expect(after.technician_id).toBe(techId);
      expect(after.route_order).toBeNull();
      expect(after.visit_id).toBeNull();
      expect(after.status).toBe('pending');
      expect(Number(after.estimated_price)).toBe(100);
    }
    // No insert (the approved file has two), no other row touched.
    expect(await trx('scheduled_services').select('id')).toEqual(rowsBefore);
    const moved = new Set(approved.results[0].move.map((m) => m.id));
    const untouched = await trx('scheduled_services').whereNotIn('id', [...moved]).whereNotNull('visit_id');
    expect(untouched).toEqual([]);
    // Pin: nothing that messages, notifies or journals a move was written.
    expect(await silentCounts()).toEqual(silentBefore);

    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(doc.moves.map((e) => e.id).sort()).toEqual([...moved].sort());
    expect(JSON.stringify(doc)).not.toMatch(/Rider-apply|Fixture/);
  });

  test('a drifted move set skips the pair and writes nothing', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    approved.results[0].move[0] = { ...approved.results[0].move[0], to: addDays(approved.results[0].move[0].to, 42) };
    const before = await snapshot();
    const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'move_set_drift' });
    expect(await snapshot()).toBe(before);
  });

  test('a pair that stopped being eligible is skipped', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    await trx('customers').where({ id: customerId }).update({ pipeline_stage: 'churned' });
    const before = await snapshot();
    const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0].status).toBe('skipped');
    expect(await snapshot()).toBe(before);
  });

  test('another pest visit already on the target date is refused (no duplicate row)', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const target = approved.results[0].move[0].to;
    await row({ is_recurring: false, service_type: 'Pest Control Service', scheduled_date: target, status: 'pending' });
    const before = await snapshot();
    const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'pest_visit_already_on_target_date' });
    expect(await snapshot()).toBe(before);
  });

  test('an occurrence-only add-on on a moving row is refused, not dropped', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    await trx('scheduled_service_addons').insert({
      scheduled_service_id: approved.results[0].move[0].id, service_name: 'Occurrence-only add-on', estimated_price: 25,
    });
    const before = await snapshot();
    const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'addon_set_differs_on_target_date' });
    expect(await snapshot()).toBe(before);
  });

  test('a windowless host visit on the target date is refused', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    await trx('scheduled_services').where({ scheduled_date: approved.results[0].move[0].to, service_type: 'Lawn Care - Every 6 Weeks' })
      .update({ window_start: null, window_end: null });
    const before = await snapshot();
    const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'host_visit_windowless' });
    expect(await snapshot()).toBe(before);
  });

  test('a series lock held elsewhere skips the pair', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const other = await database.transaction();
    try {
      await other.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['recurring-series-maintenance', String(pair.pestParent.id)]);
      const before = await snapshot();
      const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'pest_series_locked' });
      expect(await snapshot()).toBe(before);
    } finally {
      await other.rollback();
    }
  });

  test('any booking over the moved window (another customer, same, NULL or different technician) refuses the pair', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const target = approved.results[0].move[0].to;
    const otherCustomer = randomUUID();
    await trx('customers').insert({
      id: otherCustomer, first_name: 'Other', last_name: 'Fixture', email: `${otherCustomer}@example.invalid`,
      phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      address_line1: '200 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    // Same technician, overlapping the pest window (09:00 + pest duration).
    const booked = await row({
      customer_id: otherCustomer, is_recurring: false, service_type: 'Lawn Care Visit', scheduled_date: target,
      status: 'confirmed', window_start: '09:30', window_end: '10:30', technician_id: techId,
    });
    const before = await snapshot();
    let res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'window_occupied' });
    expect(await snapshot()).toBe(before);

    // Mirror guard: a technician-NULL row collides with any technician.
    await trx('scheduled_services').where({ id: booked.id }).update({ technician_id: null });
    res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'window_occupied' });
    expect(await snapshot()).toContain(booked.id);

    // The global probe: a DIFFERENT technician's booking in the window refuses too.
    const otherTech = randomUUID();
    await trx('technicians').insert({
      id: otherTech, name: 'Other synthetic tech', employment_status: 'active', field_dispatchable: true,
    });
    await trx('scheduled_services').where({ id: booked.id }).update({ technician_id: otherTech });
    res = await applyApproved(trx, approved, { apply: false });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'window_occupied' });

    // Outside the window (or cancelled) it does not.
    await trx('scheduled_services').where({ id: booked.id }).update({ window_start: '13:00', window_end: '13:30' });
    res = await applyApproved(trx, approved, { apply: false });
    expect(res.pairs[0]).toMatchObject({ status: 'would_apply' });
  });

  test('rollback refuses a row that picked up lifecycle evidence after the move (never rewinds)', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const out = rollbackPath();
    await applyApproved(trx, approved, { apply: true, rollbackOut: out });
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    const [stale] = doc.moves;
    await trx('scheduled_services').where({ id: stale.id }).update({ en_route_at: new Date() });
    const before = await snapshot();

    const res = await rollbackApplied(trx, { ...doc, moves: [stale] }, { apply: true });
    expect(res.results[0]).toMatchObject({ status: 'skipped', reason: 'row_has_lifecycle_evidence' });
    expect(await snapshot()).toBe(before);
  });

  test('rollback refuses a row that gained an invoice, a customer confirmation, or whose original date is now near-term', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const out = rollbackPath();
    await applyApproved(trx, approved, { apply: true, rollbackOut: out });
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    const [invoiced, confirmed] = doc.moves;

    await trx('invoices').insert({
      id: randomUUID(), customer_id: customerId, scheduled_service_id: invoiced.id, status: 'sent',
      invoice_number: `TEST-${Date.now()}`, total: 100, subtotal: 100, token: randomUUID().replaceAll('-', ''),
    });
    await trx('scheduled_services').where({ id: confirmed.id }).update({ customer_confirmed: true });
    const before = await snapshot();

    const res = await rollbackApplied(trx, doc, { apply: true });
    expect(res.results.find((r) => r.id === invoiced.id)).toMatchObject({ status: 'skipped', reason: 'row_no_longer_movable', detail: 'invoice' });
    expect(res.results.find((r) => r.id === confirmed.id)).toMatchObject({ status: 'skipped', reason: 'row_no_longer_movable', detail: 'customer_confirmed' });
    expect(await snapshot()).toBe(before);

    // A recorded original date that is already inside the near-term window is never restored.
    await trx('scheduled_services').where({ id: confirmed.id }).update({ customer_confirmed: false });
    const settled = await snapshot();
    const nearTerm = await rollbackApplied(trx, {
      ...doc,
      moves: [{ ...confirmed, before: { ...confirmed.before, scheduled_date: etDateString() } }],
    }, { apply: true });
    expect(nearTerm.results[0]).toMatchObject({ status: 'skipped', reason: 'target_within_near_term' });
    expect(await snapshot()).toBe(settled);
  });

  test('a target date whose occupancy lock is held elsewhere skips the pair (forward and rollback)', async () => {
    const { tryAcquireOccupancyLock } = require('../services/scheduling/occupancy');
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const target = approved.results[0].move[0].to;
    const other = await database.transaction();
    try {
      expect(await tryAcquireOccupancyLock(other, target)).toBe(true);
      const before = await snapshot();
      const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'occupancy_date_locked', detail: target });
      expect(await snapshot()).toBe(before);
    } finally {
      await other.rollback();
    }

    // Rollback: lock the ORIGINAL date of an applied move.
    const out = rollbackPath();
    await applyApproved(trx, approved, { apply: true, rollbackOut: out });
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    const held = await database.transaction();
    try {
      expect(await tryAcquireOccupancyLock(held, doc.moves[0].before.scheduled_date)).toBe(true);
      const res = await rollbackApplied(trx, doc, { apply: true });
      expect(res.results.find((r) => r.id === doc.moves[0].id)).toMatchObject({ status: 'skipped', reason: 'occupancy_date_locked' });
      expect(res.results.find((r) => r.id === doc.moves[1].id).status).toBe('reverted');
    } finally {
      await held.rollback();
    }
  });

  test('the chosen host occurrence is row-locked NOWAIT (apply only) before it is planned against', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const target = approved.results[0].move[0].to;
    const host = await trx('scheduled_services').where({ scheduled_date: target, service_type: 'Lawn Care - Every 6 Weeks' }).first('id');
    const seen = [];
    const onQuery = (q) => { if (/for update nowait/i.test(q.sql)) seen.push({ sql: q.sql, bindings: q.bindings }); };
    database.client.on('query', onQuery);
    try {
      await applyApproved(trx, approved, { apply: false });
      expect(seen.filter((q) => (q.bindings || []).includes(host.id))).toEqual([]);
      await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    } finally {
      database.client.removeListener('query', onQuery);
    }
    // One lock per host pick and one more per re-select is not needed: the row is locked once, then re-read.
    expect(seen.filter((q) => (q.bindings || []).includes(host.id)).length).toBeGreaterThanOrEqual(1);
  });

  test('a rider occurrence at a different property than the pair is refused', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const moving = approved.results[0].move[0].id;
    await trx('scheduled_services').where({ id: moving }).update({
      service_address_line1: '999 Elsewhere Road', service_address_city: 'Other City', service_address_state: 'FL', service_address_zip: '11111',
    });
    const before = await snapshot();
    const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'row_property_differs' });
    expect(await snapshot()).toBe(before);
  });

  // Unstamped roots (no property_id, no stamped address: scope resolves from
  // the customer's primary address KEY) whose child rows carry only a stamped
  // property_id. The mixed shapes used to read as 'different', so findHostRow
  // dropped every child lawn row (no_host_visit_on_target_date).
  describe('unstamped roots with id-stamped child rows', () => {
    async function propertyAt(fields) {
      const [p] = await trx('customer_properties').insert({
        id: randomUUID(), customer_id: customerId, ...fields,
      }).returning('*');
      return p.id;
    }
    const stampChildren = (parentId, propertyId) => trx('scheduled_services')
      .where({ recurring_parent_id: parentId }).update({ property_id: propertyId });
    const SAME_ADDRESS = { address_line1: '100 Test Lane', city: 'Test City', zip: '00000' };

    test('lawn AND pest children stamped at the same property: the host row is found and the pair applies', async () => {
      const pair = await buildPair();
      const same = await propertyAt(SAME_ADDRESS);
      await stampChildren(pair.lawnParent.id, same);
      await stampChildren(pair.pestParent.id, same);
      const approved = await approvedFor(pair);
      const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      expect(res.pairs[0]).toMatchObject({ status: 'applied' });
      for (const m of approved.results[0].move) {
        const moved = await trx('scheduled_services').where({ id: m.id }).first();
        expect(dateOnly(moved.scheduled_date)).toBe(m.to);
        expect(moved.technician_id).toBe(techId);
      }
    });

    test('lawn children restamped at a DIFFERENT property after approval: no host visit, nothing written', async () => {
      const pair = await buildPair();
      const same = await propertyAt(SAME_ADDRESS);
      await stampChildren(pair.lawnParent.id, same);
      const approved = await approvedFor(pair);
      const other = await propertyAt({ address_line1: '999 Elsewhere Road', city: 'Other City', zip: '11111' });
      await stampChildren(pair.lawnParent.id, other);
      const before = await snapshot();
      const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'no_host_visit_on_target_date' });
      expect(await snapshot()).toBe(before);
    });

    test('lawn children restamped at a property with no address: no host visit (fail closed)', async () => {
      const pair = await buildPair();
      const same = await propertyAt(SAME_ADDRESS);
      await stampChildren(pair.lawnParent.id, same);
      const approved = await approvedFor(pair);
      const blank = await propertyAt({ address_line1: null, city: null, zip: null, state: null });
      await stampChildren(pair.lawnParent.id, blank);
      const before = await snapshot();
      const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'no_host_visit_on_target_date' });
      expect(await snapshot()).toBe(before);
    });

    test('a pest occurrence stamped at a different property than the unstamped pest root is still refused', async () => {
      const pair = await buildPair();
      const approved = await approvedFor(pair);
      const other = await propertyAt({ address_line1: '999 Elsewhere Road', city: 'Other City', zip: '11111' });
      await trx('scheduled_services').where({ id: approved.results[0].move[0].id }).update({ property_id: other });
      const before = await snapshot();
      const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'row_property_differs' });
      expect(await snapshot()).toBe(before);
    });
  });

  test('a compatible second pest root introduced after approval makes the pair ambiguous and skips it', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    await row({
      status: 'pending', recurring_ongoing: true, recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control',
      scheduled_date: addDays(ANCHOR, 30),
    });
    const before = await snapshot();
    const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
    expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'candidate_pair_ambiguous' });
    expect(await snapshot()).toBe(before);
  });

  describe('rollback is a reschedule through the same validation', () => {
    async function applied(opts) {
      const pair = await buildPair(opts);
      const approved = await approvedFor(pair);
      const out = rollbackPath();
      await applyApproved(trx, approved, { apply: true, rollbackOut: out });
      const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
      return { pair, doc, entry: doc.moves[0] };
    }

    test('refuses when a new booking now sits in the original window (unassigned original = every row collides)', async () => {
      const { entry, doc } = await applied();
      const otherCustomer = randomUUID();
      await trx('customers').insert({
        id: otherCustomer, first_name: 'Other', last_name: 'Fixture', email: `${otherCustomer}@example.invalid`,
        phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
        address_line1: '200 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
      });
      await row({
        customer_id: otherCustomer, is_recurring: false, service_type: 'Lawn Care Visit', scheduled_date: entry.before.scheduled_date,
        status: 'confirmed', window_start: '14:30', window_end: '15:30', technician_id: techId,
      });
      const res = await rollbackApplied(trx, doc, { apply: true });
      expect(res.results.find((r) => r.id === entry.id)).toMatchObject({ status: 'skipped', reason: 'window_occupied' });
      const stayed = await trx('scheduled_services').where({ id: entry.id }).first();
      expect(dateOnly(stayed.scheduled_date)).toBe(entry.after.scheduled_date);
    });

    test('refuses when an occurrence-only add-on has been attached since the apply', async () => {
      const { entry, doc } = await applied();
      await trx('scheduled_service_addons').insert({ scheduled_service_id: entry.id, service_name: 'Occurrence-only add-on', estimated_price: 25 });
      const res = await rollbackApplied(trx, doc, { apply: true });
      expect(res.results.find((r) => r.id === entry.id)).toMatchObject({ status: 'skipped', reason: 'addon_set_differs_on_target_date' });
      expect(dateOnly((await trx('scheduled_services').where({ id: entry.id }).first()).scheduled_date)).toBe(entry.after.scheduled_date);
    });

    test('refuses when the original technician is no longer assignable (never restores unassigned)', async () => {
      const { entry, doc } = await applied({ pestTech: techId });
      expect(entry.before.technician_id).toBe(techId);
      await trx('technicians').where({ id: techId }).update({ field_dispatchable: false });
      const res = await rollbackApplied(trx, doc, { apply: true });
      expect(res.results.find((r) => r.id === entry.id)).toMatchObject({ status: 'skipped', reason: 'original_technician_not_assignable' });
      const now = await trx('scheduled_services').where({ id: entry.id }).first();
      expect(dateOnly(now.scheduled_date)).toBe(entry.after.scheduled_date);
    });

    test('refuses when the row changed customer since the apply', async () => {
      const { entry, doc } = await applied();
      const otherCustomer = randomUUID();
      await trx('customers').insert({
        id: otherCustomer, first_name: 'Other', last_name: 'Fixture', email: `${otherCustomer}@example.invalid`,
        phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
        address_line1: '200 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
      });
      await trx('scheduled_services').where({ id: entry.id }).update({ customer_id: otherCustomer });
      const res = await rollbackApplied(trx, doc, { apply: true });
      expect(res.results.find((r) => r.id === entry.id)).toMatchObject({ status: 'skipped', reason: 'row_customer_changed' });
      expect(dateOnly((await trx('scheduled_services').where({ id: entry.id }).first()).scheduled_date)).toBe(entry.after.scheduled_date);
    });
  });

  describe('the move mirrors the bulk mover', () => {
    test('stamps a date exception, resets stale lifecycle evidence, clears legacy labels, refreshes the token expiry', async () => {
      const pair = await buildPair();
      const approved = await approvedFor(pair);
      const [first, second] = approved.results[0].move;
      await trx('scheduled_services').where({ id: first.id }).update({
        time_window: '9-12', window_display: 'Morning', en_route_at: new Date('2098-01-01T12:00:00Z'), arrival_sms_sent_at: null,
      });
      const untouchedBefore = await trx('scheduled_services').where({ id: second.id }).first();
      await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });

      const moved = await trx('scheduled_services').where({ id: first.id }).first();
      // Stamp: this-visit-only exception, cadence position = the date it left.
      expect(moved.date_exception).toBe(true);
      expect(moved.date_exception_source).toBe('rider_onetime_move');
      expect(dateOnly(moved.date_exception_cadence_date)).toBe(first.from);
      expect(moved.date_exception_at).toBeTruthy();
      // Lifecycle: stale evidence rewound under the lock, status untouched.
      expect(moved.en_route_at).toBeNull();
      expect(moved.track_state).toBe('scheduled');
      expect(moved.status).toBe('pending');
      // Legacy labels cleared with the window.
      expect(moved.time_window).toBeNull();
      expect(moved.window_display).toBeNull();
      // Track token expiry recomputed for the new date/window end (ET end of day + 1 day).
      expect(new Date(moved.track_token_expires_at).getTime()).toBeGreaterThan(new Date(`${first.to}T12:00:00Z`).getTime());
      expect(moved.route_order).toBeNull();
      // A second row with no stale evidence keeps its (already reset) lifecycle: no rewind needed.
      const other = await trx('scheduled_services').where({ id: second.id }).first();
      expect(other.date_exception).toBe(true);
      expect(other.track_state).toBe(untouchedBefore.track_state);
    });

    test('rollback restores the stamp, labels, token expiry and due date verbatim, and does not "rewind" back', async () => {
      const pair = await buildPair();
      const approved = await approvedFor(pair);
      const [first] = approved.results[0].move;
      await trx('scheduled_services').where({ id: first.id }).update({
        time_window: '9-12', window_display: 'Morning', en_route_at: new Date('2098-01-01T12:00:00Z'),
      });
      const original = await trx('scheduled_services').where({ id: first.id }).first();
      const out = rollbackPath();
      await applyApproved(trx, approved, { apply: true, rollbackOut: out });
      const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
      const entry = doc.moves.find((e) => e.id === first.id);
      expect(entry.before).toMatchObject({ time_window: '9-12', window_display: 'Morning', date_exception: false });
      expect(entry.after).toMatchObject({ time_window: null, window_display: null, date_exception: true, date_exception_source: 'rider_onetime_move' });

      const res = await rollbackApplied(trx, doc, { apply: true });
      expect(res.results.find((r) => r.id === first.id).status).toBe('reverted');
      const back = await trx('scheduled_services').where({ id: first.id }).first();
      expect(back.time_window).toBe('9-12');
      expect(back.window_display).toBe('Morning');
      expect(back.date_exception).toBe(original.date_exception);
      expect(back.date_exception_source).toBeNull();
      expect(back.date_exception_cadence_date).toBeNull();
      expect(new Date(back.track_token_expires_at).getTime()).toBe(new Date(original.track_token_expires_at).getTime());
      // The lifecycle reset is not undone (nothing live to go back to).
      expect(back.en_route_at).toBeNull();
      expect(dateOnly(back.scheduled_date)).toBe(first.from);
    });

    test('takes the source and destination tech-day fences, after the date lock and before customer-comms', async () => {
      const pair = await buildPair({ pestTech: techId });
      const approved = await approvedFor(pair);
      const [first] = approved.results[0].move;
      const seen = [];
      const onQuery = (q) => {
        if (/pg_(try_)?advisory_xact_lock/i.test(q.sql)) seen.push((q.bindings || []).map(String).join('|'));
      };
      database.client.on('query', onQuery);
      try {
        await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      } finally {
        database.client.removeListener('query', onQuery);
      }
      const at = (needle) => seen.findIndex((k) => k.includes(needle));
      const dateLock = at(`occupancy:${first.to}`);
      const source = at(`${techId}:${first.from}`);
      const dest = at(`${techId}:${first.to}`);
      const unassignedDest = at(`unassigned:${first.to}`);
      const comms = at(`customer-comms:${customerId}`);
      expect(dateLock).toBeGreaterThanOrEqual(0);
      expect(source).toBeGreaterThan(dateLock);
      expect(dest).toBeGreaterThan(dateLock);
      expect(unassignedDest).toBeGreaterThan(dateLock);
      expect(comms).toBeGreaterThan(Math.max(source, dest, unassignedDest));
    });

    test('a tech-day fence held elsewhere skips the pair', async () => {
      const { lockTechDays } = require('../services/scheduling/tech-day-lock');
      const pair = await buildPair({ pestTech: techId });
      const approved = await approvedFor(pair);
      const other = await database.transaction();
      try {
        await lockTechDays(other, [{ techId, date: approved.results[0].move[0].from }]);
        const before = await snapshot();
        const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
        expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'technician_day_locked' });
        expect(await snapshot()).toBe(before);
      } finally {
        await other.rollback();
      }
    });

    test('the next series extension anchors on the cadence slot, not the moved date (seriesExtendAnchor uses the stamp)', async () => {
      const { seriesExtendAnchor } = require('../routes/admin-schedule')._test;
      const { recurrenceOrdinalOptions } = require('../services/rebooker');
      const pair = await buildPair();
      const approved = await approvedFor(pair);
      const [first] = approved.results[0].move;
      await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      const moved = await trx('scheduled_services').where({ id: first.id }).first();
      const rOpts = { ...recurrenceOrdinalOptions(pair.pestParent.scheduled_date, {}), intervalDays: null };
      expect(seriesExtendAnchor(moved, 'quarterly', rOpts)).toBe(first.from);
      // Without the stamp the lawn landing would have become the cadence position.
      expect(seriesExtendAnchor({ ...moved, date_exception: false, date_exception_cadence_date: null }, 'quarterly', rOpts)).toBe(first.to);
    });
  });

  describe('refusals that close the round-4 findings', () => {
    test('a legacy child with is_recurring NULL (cannot be stamped as a date exception) is refused', async () => {
      const pair = await buildPair();
      await trx('scheduled_services').where({ id: pair.kids[0].id }).update({ is_recurring: null });
      const approved = await approvedFor(pair);
      expect(approved.results[0].move.map((m) => m.id)).toContain(pair.kids[0].id);
      const before = await snapshot();
      const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'row_not_stampable' });
      expect(await snapshot()).toBe(before);
    });

    test('the series root row is never moved', async () => {
      const pair = await buildPair();
      const approved = await approvedFor(pair);
      const rootMove = { id: pair.pestParent.id, from: dateOnly(pair.pestParent.scheduled_date), to: approved.results[0].move[0].to };
      approved.results[0].move = [rootMove];
      const preview = require('../services/rider-series-preview');
      const real = preview.previewRiderPair;
      const spy = jest.spyOn(preview, 'previewRiderPair').mockImplementation(async (...a) => ({ ...(await real(...a)), move: [rootMove] }));
      try {
        const before = await snapshot();
        const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
        expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'series_root_not_moved' });
        expect(await snapshot()).toBe(before);
      } finally {
        spy.mockRestore();
      }
    });

    test('a pest series pinned to a technician other than the host lawn stop is refused (host is not exempted)', async () => {
      const pair = await buildPair();
      const otherTech = randomUUID();
      await trx('technicians').insert({
        id: otherTech, name: 'Pinned synthetic tech', employment_status: 'active', field_dispatchable: true,
      });
      await trx('scheduled_services').where({ id: pair.pestParent.id }).update({
        recurring_technician_id: otherTech, recurring_technician_override: true,
      });
      const approved = await approvedFor(pair);
      const before = await snapshot();
      const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
      expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'technician_differs_from_host' });
      expect(await snapshot()).toBe(before);
    });

    test('a missed tech-day fence releases the keys it had already taken', async () => {
      const { lockTechDays } = require('../services/scheduling/tech-day-lock');
      const pair = await buildPair({ pestTech: techId });
      const approved = await approvedFor(pair);
      const [first] = approved.results[0].move;
      const holder = await database.transaction();
      const probe = await database.transaction();
      try {
        // 'unassigned:<to>' sorts after the technician keys, so the earlier keys
        // are acquired before the miss.
        await lockTechDays(holder, [{ techId: null, date: first.to }]);
        const res = await applyApproved(trx, approved, { apply: true, rollbackOut: rollbackPath() });
        expect(res.pairs[0]).toMatchObject({ status: 'skipped', reason: 'technician_day_locked' });
        // Another connection can take the earlier keys while the run's transaction is still open.
        expect(await lockTechDays(probe, [{ techId, date: first.from }, { techId, date: first.to }], { wait: false })).not.toBe(false);
      } finally {
        await holder.rollback();
        await probe.rollback();
      }
    });

    test('a rollback entry whose tech-day fence misses releases its partial keys too', async () => {
      const { lockTechDays } = require('../services/scheduling/tech-day-lock');
      const pair = await buildPair({ pestTech: techId });
      const approved = await approvedFor(pair);
      const out = rollbackPath();
      await applyApproved(trx, approved, { apply: true, rollbackOut: out });
      const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
      // The forward apply above still holds its own fences in this transaction, so
      // point the entry at a day it never fenced: '<techId>:<day>' is taken, then
      // 'unassigned:<day>' misses.
      const day = '2099-06-15';
      const entry = { ...doc.moves[0], before: { ...doc.moves[0].before, scheduled_date: day, technician_id: techId } };
      const holder = await database.transaction();
      const probe = await database.transaction();
      try {
        await lockTechDays(holder, [{ techId: null, date: day }]);
        const res = await rollbackApplied(trx, { ...doc, moves: [entry] }, { apply: true });
        expect(res.results[0]).toMatchObject({ status: 'skipped', reason: 'technician_day_locked' });
        expect(await lockTechDays(probe, [{ techId, date: day }], { wait: false })).not.toBe(false);
      } finally {
        await holder.rollback();
        await probe.rollback();
      }
    });
  });

  test('rollback restores every moved row, and refuses a row that changed since the apply', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const originals = await trx('scheduled_services').whereIn('id', approved.results[0].move.map((m) => m.id)).orderBy('id');
    const out = rollbackPath();
    await applyApproved(trx, approved, { apply: true, rollbackOut: out });
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));

    // One row is edited by someone after the apply: it must be left alone.
    const [first, second] = doc.moves;
    await trx('scheduled_services').where({ id: first.id }).update({ window_start: '11:00', window_end: '12:00' });

    const dry = await rollbackApplied(trx, doc, { apply: false });
    expect(dry.results.find((r) => r.id === second.id).status).toBe('would_revert');
    expect(dry.results.find((r) => r.id === first.id)).toMatchObject({ status: 'skipped', reason: 'row_changed_since_apply' });

    const res = await rollbackApplied(trx, doc, { apply: true });
    expect(res.results.find((r) => r.id === second.id).status).toBe('reverted');
    expect(res.results.find((r) => r.id === first.id).status).toBe('skipped');

    const restored = await trx('scheduled_services').where({ id: second.id }).first();
    const original = originals.find((o) => o.id === second.id);
    expect(dateOnly(restored.scheduled_date)).toBe(dateOnly(original.scheduled_date));
    expect(String(restored.window_start)).toBe(String(original.window_start));
    expect(String(restored.window_end)).toBe(String(original.window_end));
    expect(restored.technician_id).toBe(original.technician_id);
    expect(restored.route_order).toBe(original.route_order);
    // The edited row kept its post-apply state.
    const kept = await trx('scheduled_services').where({ id: first.id }).first();
    expect(String(kept.window_start).slice(0, 5)).toBe('11:00');
  });

  test('a full rollback returns the whole set to the original values', async () => {
    const pair = await buildPair();
    const approved = await approvedFor(pair);
    const ids = approved.results[0].move.map((m) => m.id);
    const before = JSON.stringify(await trx('scheduled_services').whereIn('id', ids).orderBy('id')
      .select('id', 'scheduled_date', 'window_start', 'window_end', 'technician_id', 'route_order', 'recurring_dispatch_due_date'));
    const out = rollbackPath();
    await applyApproved(trx, approved, { apply: true, rollbackOut: out });
    const silent = await silentCounts();
    const res = await rollbackApplied(trx, JSON.parse(fs.readFileSync(out, 'utf8')), { apply: true });
    expect(res.results).toHaveLength(2);
    expect(res.results.every((r) => r.status === 'reverted')).toBe(true);
    const after = JSON.stringify(await trx('scheduled_services').whereIn('id', ids).orderBy('id')
      .select('id', 'scheduled_date', 'window_start', 'window_end', 'technician_id', 'route_order', 'recurring_dispatch_due_date'));
    expect(after).toBe(before);
    expect(await silentCounts()).toEqual(silent);
  });
});
