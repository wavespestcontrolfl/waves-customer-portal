// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// pest-rides-the-lawn-rhythm READ-ONLY PREVIEW (owner decision 2026-09-28:
// ship the preview first — the write engine is PR #5268, paused). Proves
// services/rider-series-preview.js#previewRiderPair against a real lawn
// every-6-weeks host + pest quarterly rider pair: the clean-pair diff, every
// pair/customer/series gate reason, the immovable-row classification rules,
// anchor rules, host booster/property exclusion, and — the one thing this
// whole module exists to guarantee — that it writes NOTHING.
//
// No route/service mocking: previewRiderPair takes `conn` directly and
// every function on its call path (including the lazily-required
// admin-schedule.js#topupSeriesSkipReason chain) takes and uses that same
// `conn` — never the global db singleton — so a plain migrated transaction
// is enough (same posture recurring-series-topup.test.js's own PG coverage
// and accepted-recurring-schedule-postgres.test.js rely on).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const {
  previewRiderPair, TARGET_GAP_DAYS,
} = require('../services/rider-series-preview');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

function addDays(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}

jest.setTimeout(30000);

postgres('rider-series preview against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;

  // Fixed, far-future anchor so every date in this suite is always
  // "future" relative to whenever the suite actually runs, and the plan's
  // own math never depends on real wall-clock today except for the
  // near-term/planFloor computation, which every fixture date sits well
  // past.
  const LAWN_START = '2098-01-08';
  const ANCHOR = addDays(LAWN_START, -TARGET_GAP_DAYS); // pest's own completed anchor, exactly 84 days before the first lawn date

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !ownedQA && !privateQa) throw new Error("Use disposable CI or this worktree's private QA database");
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId,
      first_name: 'Rider-preview',
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
  // The preview lazily loads modules that open the shared models/db pool;
  // close it too, or Jest never exits (CI runs without --forceExit).
  afterAll(async () => { await database?.destroy(); await require('../models/db').destroy(); });

  // --- fixture helpers ------------------------------------------------------
  function dateOnlyStr(d) {
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  }

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

  async function property() {
    const [p] = await trx('customer_properties').insert({
      id: randomUUID(), customer_id: customerId, address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
    }).returning('*');
    return p.id;
  }

  async function serviceVisit() {
    const [v] = await trx('service_visits').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: ANCHOR, stop_base_key: randomUUID(), created_by: 'test',
    }).returning('*');
    return v.id;
  }

  // Builds a fully eligible lawn (host) + pest (rider) pair: lawn parent +
  // 6 every-42-day children (LAWN_START .. LAWN_START+252), pest parent
  // COMPLETED at ANCHOR (the anchor), plus 2 pest children on the series'
  // own (unaligned) quarterly cadence — the rows a clean sync would move.
  async function buildValidPair({ pestChildren = true, lawnPropertyId = null, pestPropertyId = null } = {}) {
    const lawnParent = await row({
      status: 'confirmed',
      is_recurring: true,
      recurring_ongoing: true,
      recurring_pattern: 'every_6_weeks',
      service_type: 'Lawn Care - Every 6 Weeks',
      scheduled_date: LAWN_START,
      property_id: lawnPropertyId,
    });
    for (let i = 1; i <= 6; i++) {
      await row({
        recurring_parent_id: lawnParent.id,
        status: 'confirmed',
        is_recurring: true,
        recurring_pattern: 'every_6_weeks',
        service_type: 'Lawn Care - Every 6 Weeks',
        scheduled_date: addDays(LAWN_START, i * 42),
        property_id: lawnPropertyId,
      });
    }
    const pestParent = await row({
      status: 'completed',
      is_recurring: true,
      recurring_ongoing: true,
      recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control',
      scheduled_date: ANCHOR,
      property_id: pestPropertyId,
    });
    if (pestChildren) {
      await row({
        recurring_parent_id: pestParent.id,
        status: 'pending',
        is_recurring: true,
        recurring_pattern: 'quarterly',
        service_type: 'Quarterly Pest Control',
        scheduled_date: addDays(ANCHOR, 91),
        property_id: pestPropertyId,
      });
      await row({
        recurring_parent_id: pestParent.id,
        status: 'pending',
        is_recurring: true,
        recurring_pattern: 'quarterly',
        service_type: 'Quarterly Pest Control',
        scheduled_date: addDays(ANCHOR, 182),
        property_id: pestPropertyId,
      });
    }
    return { lawnParent, pestParent };
  }

  async function tableSnapshot() {
    const rows = await trx('scheduled_services').select('*').orderBy('id');
    return JSON.stringify(rows);
  }

  // --- clean pair -------------------------------------------------------
  test('a clean pair is eligible and moves pest onto every 2nd lawn date', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.eligible).toBe(true);
    expect(preview.reasons).toEqual([]);
    expect(preview.anchor).toBe(ANCHOR);
    expect(preview.plan).toEqual([
      addDays(ANCHOR, 84), addDays(ANCHOR, 168), addDays(ANCHOR, 252), addDays(ANCHOR, 336),
    ]);
    // Every planned date is itself a host (lawn) date — pest never invents
    // a standalone date while the lawn series is healthy.
    const lawnDates = new Set([LAWN_START, ...[1, 2, 3, 4, 5, 6].map((i) => addDays(LAWN_START, i * 42))]);
    for (const d of preview.plan) expect(lawnDates.has(d)).toBe(true);
    expect(preview.move).toEqual([
      { id: expect.any(String), from: addDays(ANCHOR, 91), to: addDays(ANCHOR, 84) },
      { id: expect.any(String), from: addDays(ANCHOR, 182), to: addDays(ANCHOR, 168) },
    ]);
    expect(preview.insert).toEqual([addDays(ANCHOR, 252), addDays(ANCHOR, 336)]);
    expect(preview.cancel).toEqual([]);
    expect(preview.keep).toEqual([]);
    expect(preview.pinned).toEqual([]); // the completed anchor row is history, not "pinned"
  });

  test('a failed series-gate read is isolated: reported as series_check_error, and the caller transaction stays usable', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const adminSchedule = require('../routes/admin-schedule');
    // previewRiderPair reads the all-hits variant (topupAllSeriesSkipReasons)
    // so `reasons` can list every applicable series gate, not just the
    // first — topupSeriesSkipReason itself (the nightly top-up's own
    // first-hit function) stays untouched.
    const spy = jest.spyOn(adminSchedule, 'topupAllSeriesSkipReasons').mockImplementation(async (sp) => sp.raw('SELECT 1/0'));
    try {
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('series_check_error');
      expect(preview.error).toBeUndefined();
      const [{ ok }] = (await trx.raw('SELECT 1 AS ok')).rows;
      expect(ok).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('the preview writes nothing — a full scheduled_services snapshot is byte-identical before and after', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const before = await tableSnapshot();
    await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    const after = await tableSnapshot();
    expect(after).toBe(before);
    // Also true for an INELIGIBLE pair — every gate path returns just as
    // read-only as the eligible one.
    await trx('customers').where({ id: customerId }).update({ active: false });
    const before2 = await tableSnapshot();
    await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    const after2 = await tableSnapshot();
    expect(after2).toBe(before2);
  });

  // --- structural / pair gates -------------------------------------------
  describe('pair gates', () => {
    test('self_link: a series cannot ride itself', async () => {
      const { pestParent } = await buildValidPair();
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: pestParent.id });
      expect(preview.eligible).toBe(false);
      expect(preview.reasons).toContain('self_link');
      expect(preview.plan).toEqual([]);
    });

    test('host_is_rider: refuses to chain through a host that itself rides another series', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const thirdParent = await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', scheduled_date: addDays(LAWN_START, -100),
      });
      await trx('scheduled_services').where({ id: lawnParent.id }).update({ rides_parent_id: thirdParent.id });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('host_is_rider');
      expect(preview.plan).toEqual([]);
    });

    test('cross_customer: rider and host must belong to the same customer', async () => {
      const { pestParent } = await buildValidPair();
      const otherCustomer = randomUUID();
      await trx('customers').insert({
        id: otherCustomer, first_name: 'Other', last_name: 'Customer', phone: `fixture-${otherCustomer.slice(0, 8)}`,
        address_line1: '200 Test Lane', city: 'Test City', zip: '00000', active: true,
      });
      const otherLawn = await row({
        customer_id: otherCustomer, status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', scheduled_date: LAWN_START,
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: otherLawn.id });
      expect(preview.reasons).toContain('cross_customer');
      expect(preview.plan).toEqual([]);
    });

    test('different_property: rider and host at different stamped properties never pair, even with the plan otherwise computable', async () => {
      const propA = await property();
      const propB = await property();
      const { lawnParent, pestParent } = await buildValidPair({ lawnPropertyId: propA, pestPropertyId: propB });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('different_property');
      // different_property is NOT a structural blocker — the plan is still shown.
      expect(preview.eligible).toBe(false);
      expect(preview.plan.length).toBeGreaterThan(0);
    });

    test('not_series_root: a rider id that is actually a child row is refused', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const pestChild = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).first('id');
      const preview = await previewRiderPair(trx, { riderParentId: pestChild.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('not_series_root');
      // Structural blocker: no plan is computed for a child row.
      expect(preview.anchor).toBeNull();
      expect(preview.plan).toEqual([]);
      expect([...preview.move, ...preview.cancel, ...preview.insert]).toEqual([]);
    });

    test('not_recurring: a rider with no recurring pattern is structurally blocked', async () => {
      const { lawnParent } = await buildValidPair();
      const notRecurring = await row({
        status: 'confirmed', is_recurring: false, recurring_pattern: null, scheduled_date: ANCHOR,
      });
      const preview = await previewRiderPair(trx, { riderParentId: notRecurring.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('not_recurring');
      expect(preview.plan).toEqual([]);
    });

    test('not_ongoing: a fixed (non-ongoing) rider is not eligible but its plan still shows', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      await trx('scheduled_services').where({ id: pestParent.id }).update({ recurring_ongoing: false });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('not_ongoing');
      expect(preview.eligible).toBe(false);
      expect(preview.plan.length).toBeGreaterThan(0);
    });

    test('plan_stopped: cancel_series and let_lapse decisions both block eligibility', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      await trx('recurring_plan_alerts').insert({
        customer_id: customerId, recurring_parent_id: pestParent.id,
        alert_type: 'plan_lapsed', resolved_action: 'cancel_series', resolved_at: new Date(),
      });
      const cancelPreview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(cancelPreview.reasons).toContain('plan_stopped');

      await trx('recurring_plan_alerts').where({ recurring_parent_id: pestParent.id }).del();
      await trx('recurring_plan_alerts').insert({
        customer_id: customerId, recurring_parent_id: pestParent.id,
        alert_type: 'plan_lapsed', resolved_action: 'let_lapse', resolved_at: new Date(),
      });
      const lapsePreview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(lapsePreview.reasons).toContain('plan_stopped');
    });
  });

  // --- customer gates -----------------------------------------------------
  describe('customer gates', () => {
    test('customer_deleted', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      await trx('customers').where({ id: customerId }).update({ deleted_at: new Date() });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('customer_deleted');
    });

    test('customer_service_held: a GENUINE hand-set hold blocks; autopay_final_failure alone does not', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      await trx('customers').where({ id: customerId }).update({
        service_paused_at: new Date(), service_pause_reason: 'owner_directed_pause',
      });
      const held = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(held.reasons).toContain('customer_service_held');

      await trx('customers').where({ id: customerId }).update({
        service_paused_at: new Date(), service_pause_reason: 'autopay_final_failure',
      });
      const autopayOnly = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(autopayOnly.reasons).not.toContain('customer_service_held');
    });

    test('customer_inactive', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      await trx('customers').where({ id: customerId }).update({ active: false });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('customer_inactive');
    });

    test('customer_churned', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      await trx('customers').where({ id: customerId }).update({ pipeline_stage: 'churned' });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('customer_churned');
    });
  });

  // --- series gates (reused, read-only, from admin-schedule.js) -----------
  describe('series gates', () => {
    test('an annual-prepay rider still rides (owner ruling 2026-09-29): no annual_prepay_series refusal, the prepaid visit stays pinned', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const [prepaidRow] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc');
      await trx('scheduled_services').where({ id: prepaidRow.id })
        .update({ prepaid_method: 'annual_prepay_invoice', prepaid_amount: 120 });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).not.toContain('annual_prepay_series');
      expect(preview.eligible).toBe(true);
      expect(preview.pinned).toEqual(expect.arrayContaining([expect.objectContaining({ id: prepaidRow.id, why: 'prepaid' })]));
    });

    test('duplicate_series: a second active ongoing pest series for the same customer blocks both', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control',
        scheduled_date: addDays(ANCHOR, 400),
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('duplicate_series');
    });

    // pest_control is not a HOLDABLE_FAMILIES member (cancellation-resolution/holds.js
    // — only lawn_care / mosquito / tree_shrub), so a real lawn-rides-lawn pair
    // proves the plan_hold gate's own wiring fires (through the SAME reused
    // topupSeriesSkipReason) without asserting a business scenario this repo
    // would ever actually build (pest never becomes plan_hold-eligible as a rider).
    test('plan_hold: a holdable family rider (proving the reused gate wiring, not a real lawn+pest scenario)', async () => {
      const host = await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', service_type: 'Lawn Care - Every 6 Weeks', scheduled_date: LAWN_START,
      });
      const holdableRider = await row({
        status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'quarterly', service_type: 'Tree and Shrub Quarterly', scheduled_date: ANCHOR,
      });
      await trx('plan_holds').insert({
        customer_id: customerId, family_key: 'tree_shrub', status: 'active',
        starts_on: addDays(ANCHOR, -30), resume_on: addDays(ANCHOR, 100),
      });
      const preview = await previewRiderPair(trx, { riderParentId: holdableRider.id, hostParentId: host.id });
      expect(preview.reasons).toContain('plan_hold');
    });
  });

  // --- immovable classification -------------------------------------------
  describe('immovable classification', () => {
    test('invoice pins a row', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const target = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id })
        .orderBy('scheduled_date', 'asc').first('id');
      await trx('invoices').insert({
        id: randomUUID(), token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        customer_id: customerId, scheduled_service_id: target.id,
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      const pin = preview.pinned.find((p) => p.id === target.id);
      expect(pin).toBeTruthy();
      expect(pin.why).toBe('invoice');
    });

    test('a LIVE card request pins a row; a DEAD one does not', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const [live, dead] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id })
        .orderBy('scheduled_date', 'asc').select('id');
      await trx('appointment_card_requests').insert({
        id: randomUUID(), scheduled_service_id: live.id, customer_id: customerId, status: 'pending',
      });
      await trx('appointment_card_requests').insert({
        id: randomUUID(), scheduled_service_id: dead.id, customer_id: customerId, status: 'released',
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.pinned.find((p) => p.id === live.id)?.why).toBe('card_request');
      expect(preview.pinned.find((p) => p.id === dead.id)).toBeUndefined();
    });

    test('a real sent message pins a row; a bookkeeping-only appointment_reminders flag does not', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const [messaged, bookkeepingOnly] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id })
        .orderBy('scheduled_date', 'asc').select('id');
      await trx('messaging_audit_log').insert({
        id: randomUUID(), to_hash: 'x'.repeat(64), to_last4: '1234', body_hash: 'y'.repeat(64), customer_id: customerId,
        appointment_id: messaged.id, audience: 'customer', purpose: 'appointment_reminder_72h',
        channel: 'sms', sent_at: new Date(), provider_message_id: `SM${'a'.repeat(32)}`,
      });
      // Bookkeeping-only: every appointment_reminders flag stamped true, but
      // NO messaging_audit_log row at all for this appointment — the exact
      // shape a sibling-suppressed registration takes (see
      // rider-series-preview.js's own messagedRowIds comment).
      await trx('appointment_reminders').insert({
        scheduled_service_id: bookkeepingOnly.id, customer_id: customerId,
        appointment_time: new Date(`${ANCHOR}T08:00:00Z`), source: 'test',
        confirmation_sent: true, confirmation_sent_at: new Date(),
        reminder_72h_sent: true, reminder_72h_sent_at: new Date(),
        reminder_24h_sent: true, reminder_24h_sent_at: new Date(),
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.pinned.find((p) => p.id === messaged.id)?.why).toBe('messaged');
      expect(preview.pinned.find((p) => p.id === bookkeepingOnly.id)).toBeUndefined();
    });

    test('an appointment_cancellation-purpose message does NOT pin (non-pinning purpose)', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const target = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id })
        .orderBy('scheduled_date', 'asc').first('id');
      await trx('messaging_audit_log').insert({
        id: randomUUID(), to_hash: 'x'.repeat(64), to_last4: '1234', body_hash: 'y'.repeat(64), customer_id: customerId,
        appointment_id: target.id, audience: 'customer', purpose: 'appointment_cancellation',
        channel: 'sms', sent_at: new Date(),
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.pinned.find((p) => p.id === target.id)).toBeUndefined();
    });

    test('near-term: a movable-status row inside the 7-day window pins as near_term', async () => {
      const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
      const today = etDateString();
      const nearTerm = await row({
        recurring_parent_id: pestParent.id, status: 'confirmed', is_recurring: true,
        recurring_pattern: 'quarterly', scheduled_date: addDays(today, 3),
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.pinned.find((p) => p.id === nearTerm.id)?.why).toBe('near_term');
    });

    test('visit_id pins a row', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const target = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id })
        .orderBy('scheduled_date', 'asc').first('id');
      const visitId = await serviceVisit();
      await trx('scheduled_services').where({ id: target.id }).update({ visit_id: visitId });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.pinned.find((p) => p.id === target.id)?.why).toBe('visit_id');
    });

    test('null-status: a legacy base row with no stamped status pins as null_status and can anchor', async () => {
      const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
      const nullStatus = await row({
        recurring_parent_id: pestParent.id, status: null, is_recurring: true,
        recurring_pattern: 'quarterly', scheduled_date: addDays(ANCHOR, 50),
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.pinned.find((p) => p.id === nullStatus.id)?.why).toBe('null_status');
      // The null-status row is LATER than the completed parent's own
      // anchor date, so it becomes the new (later) anchor.
      expect(preview.anchor).toBe(addDays(ANCHOR, 50));
    });
  });

  // --- anchor rules ---------------------------------------------------------
  describe('anchor rules', () => {
    test('a cancelled row never anchors, however recent or otherwise-immovable-looking', async () => {
      const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
      const visitId = await serviceVisit();
      await row({
        recurring_parent_id: pestParent.id, status: 'cancelled', is_recurring: true,
        recurring_pattern: 'quarterly', scheduled_date: addDays(ANCHOR, 60), visit_id: visitId,
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      // The cancelled row is later than ANCHOR but must be ignored — the
      // anchor stays the completed parent's own date.
      expect(preview.anchor).toBe(ANCHOR);
    });

    test('a lapsed rider (old anchor) never plans before the near-term floor', async () => {
      const lawnParent = await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', service_type: 'Lawn Care - Every 6 Weeks',
        scheduled_date: addDays(etDateString(), 20),
      });
      for (let i = 1; i <= 6; i++) {
        await row({
          recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: true,
          recurring_pattern: 'every_6_weeks', scheduled_date: addDays(etDateString(), 20 + i * 42),
        });
      }
      // A LAPSED anchor: over a year in the past relative to today.
      const staleAnchor = addDays(etDateString(), -400);
      const pestParent = await row({
        status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control', scheduled_date: staleAnchor,
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.anchor).toBe(staleAnchor);
      expect(preview.plan.every((d) => d >= preview.planFloor)).toBe(true);
      expect(preview.planFloor > staleAnchor).toBe(true);
    });
  });

  // --- host row exclusions ---------------------------------------------------
  test('a host booster row (is_recurring=false) is ignored as a host date', async () => {
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
    const boosterDate = addDays(ANCHOR, 90); // inside the walk window if wrongly counted
    await row({
      recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: false,
      scheduled_date: boosterDate,
    });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.plan).not.toContain(boosterDate);
  });

  test('a host row on another property is ignored as a host date', async () => {
    const lawnPropertyId = await property();
    const otherPropertyId = await property();
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false, lawnPropertyId, pestPropertyId: lawnPropertyId });
    const otherPropertyDate = addDays(ANCHOR, 90);
    await row({
      recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: true,
      recurring_pattern: 'every_6_weeks', scheduled_date: otherPropertyDate, property_id: otherPropertyId,
    });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.plan).not.toContain(otherPropertyDate);
  });

  test('an explicit hostParentId previews a pairing with no rides_parent_id set at all (the ops report\'s own candidate-pair use)', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const stillNull = await trx('scheduled_services').where({ id: pestParent.id }).first('rides_parent_id');
    expect(stillNull.rides_parent_id).toBeNull();
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.eligible).toBe(true);
  });

  test('no hostParentId and no rides_parent_id column value is not_a_rider', async () => {
    const { pestParent } = await buildValidPair();
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id });
    expect(preview.reasons).toContain('not_a_rider');
    expect(preview.plan).toEqual([]);
  });

  // --- promise evidence (Codex P1 round on PR #5290: reuse loadPromiseEvents) ---
  describe('promise evidence pins beyond a plain appointment_id-scoped message', () => {
    test('a messaging_audit_log row linked ONLY by metadata.scheduled_service_id (the pre-2026-08-06 legacy shape) pins', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const target = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id })
        .orderBy('scheduled_date', 'asc').first('id');
      // No appointment_id at all — the OLD messagedRowIds scan (whereIn
      // appointment_id) can never see this row. provider: 'push' proves
      // delivery on its own (loadPromiseEvents' textActuallyWentOut), so no
      // sms_log row is needed.
      await trx('messaging_audit_log').insert({
        id: randomUUID(), to_hash: 'x'.repeat(64), to_last4: '1234', body_hash: 'y'.repeat(64), customer_id: customerId,
        appointment_id: null, metadata: JSON.stringify({ scheduled_service_id: target.id }),
        audience: 'customer', purpose: 'appointment_confirmation', channel: 'sms', provider: 'push', sent_at: new Date(),
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.pinned.find((p) => p.id === target.id)?.why).toBe('messaged');
    });

    test('a delivered appointment CONFIRMATION EMAIL (no messaging_audit_log/sms row at all) pins', async () => {
      const { lawnParent, pestParent } = await buildValidPair();
      const target = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id })
        .orderBy('scheduled_date', 'asc').first('id');
      await trx('customer_interactions').insert({
        id: randomUUID(), customer_id: customerId, interaction_type: 'email_outbound',
        subject: 'Appointment confirmed', created_at: new Date(),
        metadata: JSON.stringify({ event_type: 'appointment.confirmation', scheduled_service_id: target.id, status: 'sent' }),
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.pinned.find((p) => p.id === target.id)?.why).toBe('messaged');
    });
  });

  // --- rescheduled rider rows (Codex P1 round on PR #5290) -----------------
  describe('a rescheduled rider row', () => {
    test('is a LIVE pinned row (why: rescheduled_pending), never anchors, and blocks eligibility with rider_reschedule_pending', async () => {
      const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
      const rescheduled = await row({
        recurring_parent_id: pestParent.id, status: 'rescheduled', is_recurring: true,
        recurring_pattern: 'quarterly', scheduled_date: addDays(ANCHOR, 50),
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      // Pinned and labeled, not silently dropped as history.
      expect(preview.pinned.find((p) => p.id === rescheduled.id)?.why).toBe('rescheduled_pending');
      // Its date (ANCHOR+50) is STALE — must never become the anchor even
      // though it is later than the completed parent's own ANCHOR date.
      expect(preview.anchor).toBe(ANCHOR);
      // Never movable/cancellable: it must not appear in move/cancel/keep.
      expect(preview.move.find((m) => m.id === rescheduled.id)).toBeUndefined();
      expect(preview.cancel.find((c) => c.id === rescheduled.id)).toBeUndefined();
      expect(preview.keep.find((k) => k.id === rescheduled.id)).toBeUndefined();
      // Blocks eligibility so the office can't plan an insert that
      // duplicates it, but is NOT a structural blocker — the plan still
      // shows (same "still shows what the plan WOULD be" posture as every
      // other policy gate).
      expect(preview.reasons).toContain('rider_reschedule_pending');
      expect(preview.eligible).toBe(false);
      expect(preview.plan.length).toBeGreaterThan(0);
    });
  });

  // --- property scope resolution (Codex P1 round on PR #5290) --------------
  describe('property scope resolution', () => {
    test('property_unresolved: neither root has a property_id or ANY resolvable address (conservative refusal)', async () => {
      const bareCustomer = randomUUID();
      await trx('customers').insert({
        id: bareCustomer, first_name: 'Bare', last_name: 'Address', phone: `fixture-${bareCustomer.slice(0, 8)}`,
        active: true, pipeline_stage: 'active_customer',
        // Deliberately no address_line1/city/zip at all — topUpScopeInput's
        // customer-primary-address fallback has nothing to resolve.
      });
      const bareRow = async (overrides) => {
        const [r] = await trx('scheduled_services').insert({
          id: randomUUID(), customer_id: bareCustomer, status: 'confirmed', is_recurring: true,
          recurring_ongoing: false, service_type: 'Test Service', ...overrides,
        }).returning('*');
        return r;
      };
      const lawnParent = await bareRow({
        is_recurring: true, recurring_ongoing: true, recurring_pattern: 'every_6_weeks',
        service_type: 'Lawn Care - Every 6 Weeks', scheduled_date: LAWN_START,
      });
      const pestParent = await bareRow({
        status: 'completed', is_recurring: true, recurring_ongoing: true, recurring_pattern: 'quarterly',
        service_type: 'Quarterly Pest Control', scheduled_date: ANCHOR,
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toContain('property_unresolved');
      expect(preview.reasons).not.toContain('different_property');
      // Not a structural blocker — the plan still shows.
      expect(preview.eligible).toBe(false);
      expect(preview.plan.length).toBeGreaterThan(0);
    });
  });

  // --- unstamped parent + id-stamped children ---------------------------------
  // A series root with no property_id and no stamped address resolves from
  // the customer's primary address (an address KEY only); its child rows
  // carry only a stamped property_id. The two shapes are not directly
  // comparable, so every child row used to be dropped from the host dates
  // (the planner then fell back to standalone +84-day dates).
  describe('an unstamped host parent with id-stamped child rows (mixed scope shapes)', () => {
    const LAWN_CHILD = addDays(LAWN_START, 96); // inside the 77..105 walk window, off the standalone +84 date
    const STANDALONE = addDays(LAWN_START, 84);

    async function propertyAt(fields) {
      const [p] = await trx('customer_properties').insert({
        id: randomUUID(), customer_id: customerId, ...fields,
      }).returning('*');
      return p.id;
    }

    async function pairWithLawnChildAt(propertyId, childFields = {}) {
      const lawnParent = await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', service_type: 'Lawn Care - Every 6 Weeks',
        scheduled_date: LAWN_START, // no property_id, no stamped address
      });
      await row({
        recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: true,
        recurring_pattern: 'every_6_weeks', scheduled_date: LAWN_CHILD, property_id: propertyId, ...childFields,
      });
      const pestParent = await row({
        status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control', scheduled_date: ANCHOR,
      });
      return { lawnParent, pestParent };
    }

    test('children stamped with the SAME property as the customer primary address stay host dates', async () => {
      const same = await propertyAt({ address_line1: '100 Test Lane', city: 'Test City', zip: '00000' });
      const { lawnParent, pestParent } = await pairWithLawnChildAt(same);
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toEqual([]);
      expect(preview.plan).toContain(LAWN_CHILD);
      expect(preview.plan).not.toContain(STANDALONE);
    });

    test('the reverse shape (id-only host parent, address-only child rows) is also comparable', async () => {
      const same = await propertyAt({ address_line1: '100 Test Lane', city: 'Test City', zip: '00000' });
      const lawnParent = await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', service_type: 'Lawn Care - Every 6 Weeks',
        scheduled_date: LAWN_START, property_id: same,
      });
      await row({
        recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: true,
        recurring_pattern: 'every_6_weeks', scheduled_date: LAWN_CHILD,
        service_address_line1: '100 Test Lane', service_address_city: 'Test City', service_address_state: 'FL', service_address_zip: '00000',
      });
      const pestParent = await row({
        status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control', scheduled_date: ANCHOR,
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toEqual([]);
      expect(preview.plan).toContain(LAWN_CHILD);
      expect(preview.plan).not.toContain(STANDALONE);
    });

    test('a child stamped with a DIFFERENT property is still dropped from the host dates', async () => {
      const other = await propertyAt({ address_line1: '999 Elsewhere Road', city: 'Other City', zip: '11111' });
      const { lawnParent, pestParent } = await pairWithLawnChildAt(other);
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.plan).not.toContain(LAWN_CHILD);
      expect(preview.plan).toContain(STANDALONE);
    });

    test('a child stamped with a property that has no address is dropped (fail closed, never guessed)', async () => {
      const blank = await propertyAt({ address_line1: null, city: null, zip: null, state: null });
      const { lawnParent, pestParent } = await pairWithLawnChildAt(blank);
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.plan).not.toContain(LAWN_CHILD);
      expect(preview.plan).toContain(STANDALONE);
    });

    test('candidate pairing: an unstamped lawn root and an id-stamped pest root at the same property pair; a different property does not', async () => {
      const { findCandidatePairs } = require('../services/rider-series-candidates');
      const same = await propertyAt({ address_line1: '100 Test Lane', city: 'Test City', zip: '00000' });
      const other = await propertyAt({ address_line1: '999 Elsewhere Road', city: 'Other City', zip: '11111' });
      const lawnParent = await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', service_type: 'Lawn Care - Every 6 Weeks', scheduled_date: LAWN_START,
      });
      const pestAt = (propertyId) => row({
        status: 'completed', is_recurring: true, recurring_ongoing: true, recurring_pattern: 'quarterly',
        service_type: 'Quarterly Pest Control', scheduled_date: ANCHOR, property_id: propertyId,
      });
      const pestSame = await pestAt(same);
      let pairs = await findCandidatePairs(trx, { customerId });
      expect(pairs.map((p) => [p.lawnParentId, p.pestParentId])).toEqual([[lawnParent.id, pestSame.id]]);
      await trx('scheduled_services').where({ id: pestSame.id }).update({ property_id: other });
      pairs = await findCandidatePairs(trx, { customerId });
      expect(pairs).toEqual([]);
    });

    test('a child whose property row cannot be read at all (dangling id) is dropped', async () => {
      const { withComparableKeys } = require('../services/rider-series-preview');
      const idOnly = { propertyId: randomUUID(), key: null, resolved: true };
      const keyOnly = { propertyId: null, key: { street: 'x', city: '', zip: '' }, resolved: true };
      const [a, b] = await withComparableKeys(trx, [idOnly, keyOnly]);
      expect(a.key).toBeNull();
      expect(b).toBe(keyOnly);
      const { seriesPropertyVerdict } = require('../services/rider-series-preview');
      expect(seriesPropertyVerdict(a, b)).toBe('different');
    });
  });

  // --- Codex P2 round #2 on PR #5290 --------------------------------------
  describe('host dates use the EFFECTIVE (override-aware) host scope, not the raw stale property_id', () => {
    test('a moved host (override to a new address) keeps the new-address lawn dates and drops the old-address ones', async () => {
      const propOld = await property();
      const propNew = await property();
      const lawnParent = await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', service_type: 'Lawn Care - Every 6 Weeks',
        scheduled_date: LAWN_START, property_id: propOld,
        // The host's raw property_id column is left at the OLD address —
        // exactly what an override move looks like: only
        // recurring_template_overrides.appointment_address changes, never
        // the parent row's own stamped columns (see this module's own
        // header on why the completed first visit stays historical).
        recurring_template_overrides: JSON.stringify({ appointment_address: { property_id: propNew } }),
      });
      // Spawned BEFORE the move: stamped with the OLD property (the shape
      // copyStampedServiceAddressFields leaves on a pre-move child row).
      const oldDate = addDays(LAWN_START, 81);
      await row({
        recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: true,
        recurring_pattern: 'every_6_weeks', scheduled_date: oldDate, property_id: propOld,
      });
      // Spawned AFTER the move: stamped with the NEW property.
      const newDate = addDays(LAWN_START, 96);
      await row({
        recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: true,
        recurring_pattern: 'every_6_weeks', scheduled_date: newDate, property_id: propNew,
      });
      const pestParent = await row({
        status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control',
        scheduled_date: ANCHOR, property_id: propNew,
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      // Both dates fall inside the SAME walk window (MIN_GAP_DAYS 77..
      // MAX_WAIT_DAYS 105 past the first lawn date); only the property
      // filter decides which one the plan picks.
      expect(preview.plan).toContain(newDate);
      expect(preview.plan).not.toContain(oldDate);
    });

    test('a host row with no property_id or address of its own (the ordinary case) still inherits the host scope', async () => {
      const propNew = await property();
      const lawnParent = await row({
        status: 'confirmed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'every_6_weeks', service_type: 'Lawn Care - Every 6 Weeks',
        scheduled_date: LAWN_START, property_id: propNew,
      });
      const unstampedDate = addDays(LAWN_START, 96);
      await row({
        recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: true,
        recurring_pattern: 'every_6_weeks', scheduled_date: unstampedDate, // no property_id at all
      });
      const pestParent = await row({
        status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control',
        scheduled_date: ANCHOR, property_id: propNew,
      });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.plan).toContain(unstampedDate);
    });
  });

  describe('series gates read the OVERLAID rider parent, same as the top-up (Codex P2 round #2 on PR #5290)', () => {
    test('a price/service override that redirects the series into a HOLDABLE family is caught by plan_hold', async () => {
      const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
      // Raw service_type stays 'Quarterly Pest Control' (pest_control is
      // NOT a HOLDABLE_FAMILIES member); the override redirects it to a
      // holdable family, exactly like a real series-scope price/service
      // edit under GATE_EDIT_APPT_PRICE_SERVICE_SCOPE would.
      await trx('scheduled_services').where({ id: pestParent.id }).update({
        recurring_template_overrides: JSON.stringify({ service_type: 'Tree and Shrub Quarterly' }),
      });
      await trx('plan_holds').insert({
        customer_id: customerId, family_key: 'tree_shrub', status: 'active',
        starts_on: addDays(ANCHOR, -30), resume_on: addDays(ANCHOR, 100),
      });
      const previous = process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE;
      process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';
      try {
        await jest.isolateModulesAsync(async () => {
          const { previewRiderPair: freshPreviewRiderPair } = require('../services/rider-series-preview');
          try {
            const preview = await freshPreviewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
            expect(preview.reasons).toContain('plan_hold');
          } finally {
            // This isolated registry has its own models/db pool; close it.
            await require('../models/db').destroy();
          }
        });
      } finally {
        if (previous === undefined) delete process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE;
        else process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = previous;
      }
    });
  });

  describe('a rider PARENT that is itself the pending-reschedule row (Codex P2 round #2 on PR #5290)', () => {
    test('never falls back to its own stale scheduled_date: no_anchor alongside rider_reschedule_pending, empty plan', async () => {
      const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
      await trx('scheduled_services').where({ id: pestParent.id }).update({ status: 'rescheduled' });
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.reasons).toEqual(expect.arrayContaining(['rider_reschedule_pending', 'no_anchor']));
      expect(preview.anchor).toBeNull();
      expect(preview.plan).toEqual([]);
      expect(preview.eligible).toBe(false);
      // The rescheduled parent is still reported as a live pinned visit.
      expect(preview.pinned).toEqual([expect.objectContaining({ id: pestParent.id, why: 'rescheduled_pending' })]);
    });
  });

  test('a movable visit dated before a later pinned visit is reported as retained, never dropped from every list', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const children = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc');
    const [earlier, later] = children;
    await trx('invoices').insert({
      id: randomUUID(), token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      customer_id: customerId, scheduled_service_id: later.id,
    });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.anchor).toBe(dateOnlyStr(later.scheduled_date));
    expect(preview.retained).toEqual([{ id: earlier.id, date: dateOnlyStr(earlier.scheduled_date) }]);
    const listed = [...preview.keep, ...preview.move, ...preview.cancel].map((r) => r.id);
    expect(listed).not.toContain(earlier.id);
  });

  test.each(['skipped', 'no_show'])('a %s rider parent with nothing else to anchor gives no_anchor, never its missed date', async (status) => {
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ status });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.reasons).toContain('no_anchor');
    expect(preview.anchor).toBeNull();
    expect(preview.plan).toEqual([]);
  });

  test('the report excludes exactly the root statuses findActiveRecurringSeries excludes', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { EXCLUDED_ROOT_STATUSES } = require('../services/recurring-appointment-seeder');
    const seeder = fs.readFileSync(path.join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    const literal = seeder.match(/\.whereNull\('recurring_parent_id'\)[\s\S]{0,900}?\.whereNotIn\('status', (\[[^\]]*\])\)/);
    expect(literal).toBeTruthy();
    expect(EXCLUDED_ROOT_STATUSES).toEqual(JSON.parse(literal[1].replace(/'/g, '"')));
  });

  test('plan rows follow isPlanSeriesRow: a legacy NULL-flag child is a real visit, a callback child is not', async () => {
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
    const legacy = await row({
      recurring_parent_id: pestParent.id, status: 'pending', is_recurring: null, recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control', scheduled_date: addDays(ANCHOR, 91),
    });
    const callback = await row({
      recurring_parent_id: pestParent.id, status: 'pending', is_recurring: true, is_callback: true, recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control', scheduled_date: addDays(ANCHOR, 100),
    });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    const acted = [...preview.keep, ...preview.move, ...preview.cancel, ...preview.retained, ...preview.pinned].map((r) => r.id);
    expect(acted).toContain(legacy.id);
    expect(acted).not.toContain(callback.id);
  });

  test('tracker state wins over a lagging status: a confirmed row tracked complete is finished, one tracked en_route is in progress', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const [done, enRoute] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc');
    await trx('scheduled_services').where({ id: done.id }).update({ status: 'confirmed', track_state: 'complete' });
    await trx('scheduled_services').where({ id: enRoute.id }).update({ status: 'confirmed', track_state: 'en_route' });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    const actedOn = [...preview.move, ...preview.cancel, ...preview.keep].map((r) => r.id);
    expect(actedOn).not.toContain(done.id);
    expect(actedOn).not.toContain(enRoute.id);
    expect(preview.pinned).toEqual(expect.arrayContaining([expect.objectContaining({ id: enRoute.id, why: 'in_progress' })]));
    expect(preview.pinned.map((r) => r.id)).not.toContain(done.id);
  });

  test('a host row tracked complete is not a host date', async () => {
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
    // An off-cadence lawn visit inside the 77-105 day window, so the host
    // date (ANCHOR+80) differs from pest's own fallback date (ANCHOR+84).
    const offCadence = await row({
      recurring_parent_id: lawnParent.id, status: 'confirmed', is_recurring: true, recurring_pattern: 'every_6_weeks',
      service_type: 'Lawn Care - Every 6 Weeks', scheduled_date: addDays(ANCHOR, 80),
    });
    const hostDate = dateOnlyStr(offCadence.scheduled_date);
    const before = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(before.plan[0]).toBe(hostDate);
    await trx('scheduled_services').where({ id: offCadence.id }).update({ track_state: 'complete' });
    const after = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(after.plan[0]).not.toBe(hostDate);
  });

  test('derived rider state is tracker-aware: a tracker-cancelled "rescheduled" row is no pending reschedule, a tracker-completed "confirmed" row anchors', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const [first, second] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc');
    await trx('scheduled_services').where({ id: first.id }).update({ status: 'rescheduled', track_state: 'cancelled' });
    await trx('scheduled_services').where({ id: second.id }).update({ status: 'confirmed', track_state: 'complete' });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.reasons).not.toContain('rider_reschedule_pending');
    expect(preview.anchor).toBe(dateOnlyStr(second.scheduled_date));
  });

  test('a tracker-cancelled rider parent with a lagging live status never becomes the fallback anchor', async () => {
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ status: 'pending', track_state: 'cancelled' });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.reasons).toContain('no_anchor');
    expect(preview.plan).toEqual([]);
  });

  test('a swallowed read error inside the property-scope lookup leaves the caller transaction usable', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const adminSchedule = require('../routes/admin-schedule');
    const real = adminSchedule.topUpScopeInput;
    const spy = jest.spyOn(adminSchedule, 'topUpScopeInput').mockImplementation(async (sp, parent) => {
      await sp.raw('SELECT 1/0').catch(() => {});
      return real(sp, parent);
    });
    try {
      const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
      expect(preview.error).toBeUndefined();
      expect(preview.reasons).not.toContain('error');
      // A failed lookup is unresolved, never guessed.
      expect(preview.reasons).toContain('property_unresolved');
      const [{ ok }] = (await trx.raw('SELECT 1 AS ok')).rows;
      expect(ok).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test.each(['cancelled', 'skipped', 'no_show'])('a %s row whose tracker still reads complete never anchors', async (status) => {
    const { lawnParent, pestParent } = await buildValidPair();
    const [, second] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc');
    await trx('scheduled_services').where({ id: second.id }).update({ status, track_state: 'complete' });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.anchor).not.toBe(dateOnlyStr(second.scheduled_date));
  });

  test('a rescheduled row whose tracker still reads complete is a pending reschedule, never an anchor', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const [, second] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc');
    await trx('scheduled_services').where({ id: second.id }).update({ status: 'rescheduled', track_state: 'complete' });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.reasons).toContain('rider_reschedule_pending');
    expect(preview.anchor).not.toBe(dateOnlyStr(second.scheduled_date));
  });

  test('an overdue unperformed row (still pending, dated before today) is reported overdue and never anchors', async () => {
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
    const today = etDateString();
    const lastDone = addDays(today, -200);
    const overdueDate = addDays(today, -30);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ status: 'completed', scheduled_date: lastDone });
    const overdue = await row({
      recurring_parent_id: pestParent.id, status: 'pending', is_recurring: true, recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control', scheduled_date: overdueDate,
    });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.anchor).toBe(lastDone);
    expect(preview.pinned).toEqual(expect.arrayContaining([expect.objectContaining({ id: overdue.id, why: 'overdue' })]));
  });

  test('an in-progress visit that crossed midnight still anchors', async () => {
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
    const today = etDateString();
    const lastDone = addDays(today, -200);
    const yesterday = addDays(today, -1);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ status: 'completed', scheduled_date: lastDone });
    await row({
      recurring_parent_id: pestParent.id, status: 'on_site', is_recurring: true, recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control', scheduled_date: yesterday,
    });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.anchor).toBe(yesterday);
  });

  test('an overdue parent (still pending, dated before today) never becomes the fallback anchor', async () => {
    const { lawnParent, pestParent } = await buildValidPair({ pestChildren: false });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ status: 'pending', scheduled_date: addDays(etDateString(), -30) });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.reasons).toContain('no_anchor');
    expect(preview.plan).toEqual([]);
  });

  test('a failed blackout lookup still plans but flags blackout_check_error, so the pair is not eligible', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../services/scheduling/blackout-dates', () => ({
        ...jest.requireActual('../services/scheduling/blackout-dates'),
        getBlackoutLayers: jest.fn(async () => { throw new Error('synthetic blackout read failure'); }),
      }));
      const { previewRiderPair: freshPreviewRiderPair } = require('../services/rider-series-preview');
      try {
        const preview = await freshPreviewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
        expect(preview.reasons).toContain('blackout_check_error');
        expect(preview.eligible).toBe(false);
        expect(preview.plan.length).toBeGreaterThan(0);
      } finally {
        // This isolated registry has its own models/db pool; close it.
        await require('../models/db').destroy();
      }
    });
    jest.dontMock('../services/scheduling/blackout-dates');
  });

  test.each([
    ['owner-silence', null],
    [`SM${'b'.repeat(32)}`, 'undelivered'],
  ])('a send with provider id %s (sms_log status %s) never pins the row', async (providerId, smsStatus) => {
    const { lawnParent, pestParent } = await buildValidPair();
    const [target] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc');
    await trx('messaging_audit_log').insert({
      id: randomUUID(), to_hash: 'x'.repeat(64), to_last4: '1234', body_hash: 'y'.repeat(64), customer_id: customerId,
      appointment_id: target.id, audience: 'customer', purpose: 'appointment_confirmation',
      channel: 'sms', sent_at: new Date(), provider_message_id: providerId,
    });
    if (smsStatus) {
      await trx('sms_log').insert({ id: randomUUID(), customer_id: customerId, twilio_sid: providerId, status: smsStatus, direction: 'outbound', message_body: 'synthetic', from_phone: '+19415550000', to_phone: '+19415550001' });
    }
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.pinned.find((p) => p.id === target.id)).toBeUndefined();
  });

  test('a lawn visit awaiting reschedule blocks the pair (host_reschedule_pending)', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const [lawnChild] = await trx('scheduled_services').where({ recurring_parent_id: lawnParent.id }).orderBy('scheduled_date', 'asc');
    await trx('scheduled_services').where({ id: lawnChild.id }).update({ status: 'rescheduled' });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(preview.reasons).toContain('host_reschedule_pending');
    expect(preview.eligible).toBe(false);
  });

  test('a movable visit after the horizon is reported beyond the lawn schedule, never as a cancellation', async () => {
    const { lawnParent, pestParent } = await buildValidPair();
    const far = await row({
      recurring_parent_id: pestParent.id, status: 'pending', is_recurring: true, recurring_pattern: 'quarterly',
      service_type: 'Quarterly Pest Control', scheduled_date: addDays(ANCHOR, 500),
    });
    const preview = await previewRiderPair(trx, { riderParentId: pestParent.id, hostParentId: lawnParent.id });
    expect(dateOnlyStr(far.scheduled_date) > preview.horizon).toBe(true);
    expect(preview.beyondSchedule).toEqual([{ id: far.id, date: dateOnlyStr(far.scheduled_date) }]);
    expect(preview.cancel.map((c) => c.id)).not.toContain(far.id);
  });
});
