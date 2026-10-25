/**
 * Plan-rate ledger invariant reconcile against live Postgres: the SQL the unit suite
 * (plan-rate-ledger-reconcile.test.js) can only fake.
 *   - the candidate scan: live customer stages, not deleted, lines present, a one-cent
 *     difference counts, a NULL bill counts as zero, ordered by id;
 *   - the shortfall upsert: a new 'unattributed' line, or the gap ADDED to an existing one whose
 *     source and stamps stay as they were (ON CONFLICT ... DO UPDATE of monthly_rate only);
 *   - customers.monthly_rate is never written; an overshoot writes no line;
 *   - the alert through the real episode helpers on the repair's transaction, once per gap; an
 *     overshoot alert closes once its lines are corrected and rings again when the same gap returns;
 *   - a customer whose rung-6 (customer-comms) lock is held waits, and judges the gap again once
 *     it gets the lock.
 * The full run (gate, alert budget, failure isolation) is in the unit suite: run against a
 * shared test database it would also meet other suites' rows. Every row these tests insert is
 * deleted afterwards. All fixture identities are synthetic.
 */
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('plan-rate ledger reconcile (live Postgres)', () => {
  let db;
  let reconcile;
  const created = [];
  const STAMP = '2026-09-01T12:00:00.000Z';

  beforeAll(() => {
    db = require('../models/db');
    reconcile = require('../services/plan-rate-ledger-reconcile')._private;
  });
  afterAll(async () => {
    if (!created.length) return;
    await db('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'customerId' = ANY(?::text[])", [created]).del();
    await db('customer_plan_rates').whereIn('customer_id', created).del();
    await db('customers').whereIn('id', created).del();
  });

  async function seed({ bill, stage = 'active_customer', deleted = false, active = true, lines = [] }) {
    const id = randomUUID();
    created.push(id);
    await db('customers').insert({
      id,
      first_name: 'Synthetic',
      last_name: 'Ledger',
      phone: `fixture-${id.slice(0, 8)}`,
      active,
      pipeline_stage: stage,
      monthly_rate: bill,
      deleted_at: deleted ? new Date(STAMP) : null,
    });
    for (const [familyKey, rate, extra = {}] of lines) {
      await db('customer_plan_rates').insert({
        customer_id: id, family_key: familyKey, monthly_rate: rate, source: 'backfill', effective_at: new Date(STAMP), updated_at: new Date(STAMP), ...extra,
      });
    }
    return id;
  }
  const linesOf = (id) => db('customer_plan_rates').where({ customer_id: id }).orderBy('family_key')
    .select('family_key', 'monthly_rate', 'source', 'source_estimate_id', 'effective_at', 'updated_at');
  const billOf = async (id) => (await db('customers').where({ id }).first('monthly_rate')).monthly_rate;
  const alertsFor = (id) => db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'customerId' = ?", [id]).select('id', 'category', 'title', 'body', 'detail', 'link', 'metadata');

  test('the scan: live customers only (active, customer stage, not deleted), lines present, a one-cent difference counts, a NULL bill is zero, ordered by id', async () => {
    const shortfall = await seed({ bill: '86.60', lines: [['pest_control', '45.00']] });
    const overshoot = await seed({ bill: '50.00', stage: 'won', lines: [['pest_control', '45.00'], ['lawn_care', '45.00']] });
    const nullBill = await seed({ bill: null, stage: 'at_risk', lines: [['pest_control', '45.00']] });
    const oneCent = await seed({ bill: '45.01', lines: [['pest_control', '45.00']] });
    const balanced = await seed({ bill: '90.00', lines: [['pest_control', '45.00'], ['lawn_care', '45.00']] });
    const heldAtZero = await seed({ bill: '0.00', lines: [['pest_control', '0.00', { source: 'plan_hold' }]] });
    const noLines = await seed({ bill: '86.60' });
    const churned = await seed({ bill: '86.60', stage: 'churned', lines: [['pest_control', '45.00']] });
    const lead = await seed({ bill: '86.60', stage: 'new_lead', lines: [['pest_control', '45.00']] });
    const deleted = await seed({ bill: '86.60', deleted: true, lines: [['pest_control', '45.00']] });
    const inactive = await seed({ bill: '86.60', active: false, lines: [['pest_control', '45.00']] });

    const found = (await reconcile.divergentCustomersQuery(db)).map((row) => row.id);
    const mine = new Set([shortfall, overshoot, nullBill, oneCent, balanced, heldAtZero, noLines, churned, lead, deleted, inactive]);
    expect(found.filter((id) => mine.has(id)).sort()).toEqual([shortfall, overshoot, nullBill, oneCent].sort());
    expect(found).toEqual([...found].sort());
  });

  test('a shortfall onto an existing human-source line: the gap is added, the line keeps its source and stamps, the bill is untouched, one alert', async () => {
    const estimateId = randomUUID();
    const id = await seed({
      bill: '75.00',
      lines: [
        ['pest_control', '40.00', { source: 'estimate_accept' }],
        ['unattributed', '10.00', { source: 'admin_edit', source_estimate_id: estimateId }],
      ],
    });
    const before = await linesOf(id);

    const first = await reconcile.reconcileCustomer(db, id);
    expect(first.outcome).toBe('parked');
    expect(first.alert).toMatchObject({ deduped: false });
    expect(first.alert.id).toBeTruthy();

    const after = await linesOf(id);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({ ...before[1], monthly_rate: '35.00' });
    expect(after[1]).toMatchObject({ source: 'admin_edit', source_estimate_id: estimateId });
    expect(await billOf(id)).toBe('75.00');

    const alerts = await alertsFor(id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      category: 'billing',
      title: "Billing — check Synthetic Ledger's monthly bill by service",
      body: 'Billed $75.00 a month but the service lines added up to $50.00; the gap is now an unsplit line.',
      link: `/admin/customers?customerId=${id}`,
    });
    expect(alerts[0].detail).toContain('Earlier rate (not split by service) $10.00');
    expect(alerts[0].metadata).toMatchObject({
      dedupeKey: `plan-rate-invariant:shortfall:${id}:7500:5000`, customerId: id, gap: 'shortfall', parkedCents: 2500, area: 'Billing', severity: 'needs-you', who: 'person',
    });

    // The lines add up to the bill again: a second pass finds nothing to do and raises nothing.
    expect(await reconcile.reconcileCustomer(db, id)).toEqual({ outcome: 'converged' });
    expect(await alertsFor(id)).toHaveLength(1);
  });

  test('a shortfall with no unattributed line inserts one with the repair source', async () => {
    const id = await seed({ bill: '86.60', lines: [['pest_control', '45.00']] });
    expect((await reconcile.reconcileCustomer(db, id)).outcome).toBe('parked');
    const lines = await linesOf(id);
    expect(lines.map((row) => [row.family_key, row.monthly_rate, row.source])).toEqual([
      ['pest_control', '45.00', 'backfill'],
      ['unattributed', '41.60', 'invariant_repair'],
    ]);
    expect(await billOf(id)).toBe('86.60');
  });

  test('an account deactivated after the scan is left alone by the locked read', async () => {
    const id = await seed({ bill: '86.60', lines: [['pest_control', '45.00']] });
    expect((await reconcile.divergentCustomersQuery(db)).map((row) => row.id)).toContain(id);
    await db('customers').where({ id }).update({ active: false });
    expect(await reconcile.reconcileCustomer(db, id)).toEqual({ outcome: 'not_live' });
    expect((await linesOf(id)).map((row) => [row.family_key, row.monthly_rate])).toEqual([['pest_control', '45.00']]);
    expect(await alertsFor(id)).toHaveLength(0);
  });

  test('an overshoot writes no line and alerts once across two passes', async () => {
    const id = await seed({ bill: '50.00', lines: [['pest_control', '45.00'], ['lawn_care', '45.00']] });
    const before = await linesOf(id);
    const first = await reconcile.reconcileCustomer(db, id);
    const second = await reconcile.reconcileCustomer(db, id);
    expect([first.outcome, second.outcome]).toEqual(['overshoot', 'overshoot']);
    expect(first.alert.deduped).toBe(false);
    expect(second.alert.deduped).toBe(true);
    expect(await linesOf(id)).toEqual(before);
    expect(await billOf(id)).toBe('50.00');
    const alerts = await alertsFor(id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].metadata).toMatchObject({ dedupeKey: `plan-rate-invariant:overshoot:${id}:5000:9000`, gap: 'overshoot', parkedCents: 0 });
  });

  test('an overshoot alert closes once the lines are corrected, and rings again when the same gap returns', async () => {
    const id = await seed({ bill: '50.00', lines: [['pest_control', '45.00'], ['lawn_care', '45.00']] });
    const key = `plan-rate-invariant:overshoot:${id}:5000:9000`;
    const first = await reconcile.reconcileCustomer(db, id);
    expect(first.alert).toMatchObject({ deduped: false, rang: true });

    await db('customer_plan_rates').where({ customer_id: id, family_key: 'lawn_care' }).update({ monthly_rate: '5.00' });
    await reconcile.closeSettledOvershootAlerts(db);
    const [closed] = await alertsFor(id);
    expect(closed.metadata).toMatchObject({ dedupeKey: key, autoCleared: true, autoClearedReason: 'the plan lines add up to the bill' });
    const closedRow = await db('notifications').where({ id: closed.id }).first('done_at', 'done_by', 'resolution', 'read_at');
    expect(closedRow).toMatchObject({ done_by: 'episodes', resolution: 'Cleared: the plan lines add up to the bill' });
    expect(closedRow.done_at).not.toBeNull();

    await db('customer_plan_rates').where({ customer_id: id, family_key: 'lawn_care' }).update({ monthly_rate: '45.00' });
    const again = await reconcile.reconcileCustomer(db, id);
    expect(again.alert.rang).toBe(true);
    const rows = await alertsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ dedupeKey: key, autoCleared: false, recurrenceGeneration: 1 });
    const reopened = await db('notifications').where({ id: rows[0].id }).first('done_at', 'read_at');
    expect(reopened).toEqual({ done_at: null, read_at: null });
    expect(await billOf(id)).toBe('50.00');
  });

  test('a customer whose rung-6 lock is held waits, then judges the gap again under the lock', async () => {
    const id = await seed({ bill: '86.60', lines: [['pest_control', '45.00']] });
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let holding;
    const held = new Promise((resolve) => { holding = resolve; });
    // A concurrent ledger writer (an accept adding the missing lawn line) holds the customer-comms key.
    const writer = db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`customer-comms:${id}`]);
      holding();
      await released;
      await trx('customer_plan_rates').insert({ customer_id: id, family_key: 'lawn_care', monthly_rate: '41.60', source: 'estimate_accept' });
    });
    await held;
    let settled = false;
    const pending = reconcile.reconcileCustomer(db, id).finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
    } finally {
      // Always let the writer commit, or a failed expectation leaves its connection open forever.
      release();
      await writer;
    }
    expect(await pending).toEqual({ outcome: 'converged' });
    expect((await linesOf(id)).map((row) => [row.family_key, row.monthly_rate])).toEqual([['lawn_care', '41.60'], ['pest_control', '45.00']]);
    expect(await alertsFor(id)).toHaveLength(0);
    expect(await billOf(id)).toBe('86.60');
  });
});
