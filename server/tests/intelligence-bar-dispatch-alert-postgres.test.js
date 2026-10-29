/**
 * IB resolve_dispatch_alert against real Postgres (committed fixture rows, cleaned up): the confirmed run re-reads the
 * alert FOR UPDATE inside the write's transaction, so a card whose alert was resolved, changed or removed by someone
 * else (even in the gap between the pre-check and the lock) refuses with preview_changed and writes nothing, and a
 * concurrent resolve holding the row makes the confirm WAIT and then refuse instead of resolving twice. Also runs the
 * shared resolveAlertAsDispatcher (the board route's and the bar's one function) on real rows. Synthetic names only.
 */
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockEmit = jest.fn();
jest.mock('../sockets', () => ({ getIo: () => ({ to: () => ({ emit: (...a) => mockEmit(...a) }) }) }));

const LOCAL = (() => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();

(SKIP || !LOCAL ? describe.skip : describe)('IB resolve_dispatch_alert (real PG)', () => {
  let db;
  let executeDispatchAlertTool;
  let dispatchAlerts;
  const created = { alerts: [], visits: [], customers: [], techs: [] };
  let techId;
  let customerId;

  beforeAll(async () => {
    process.env.GATE_IB_RESOLVE_DISPATCH_ALERT = 'true';
    process.env.GATE_IB_PLATFORM = 'true';
    db = require('../models/db');
    ({ executeDispatchAlertTool } = require('../services/intelligence-bar/dispatch-alert-tools'));
    dispatchAlerts = require('../services/dispatch-alerts');
    techId = randomUUID();
    await db('technicians').insert({ id: techId, name: 'Fixture Alert Tech', email: `${techId}@example.invalid`, active: true });
    created.techs.push(techId);
    customerId = randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Fixture', last_name: 'AlertCust', phone: '+12025550177', email: `${customerId}@example.invalid`, property_type: 'residential' });
    created.customers.push(customerId);
  });

  afterAll(async () => {
    delete process.env.GATE_IB_RESOLVE_DISPATCH_ALERT;
    delete process.env.GATE_IB_PLATFORM;
    if (!db) return;
    if (created.alerts.length) await db('dispatch_alerts').whereIn('id', created.alerts).del();
    if (created.visits.length) await db('scheduled_services').whereIn('id', created.visits).del();
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
    if (created.techs.length) await db('technicians').whereIn('id', created.techs).del();
    await db.destroy();
  });

  beforeEach(() => mockEmit.mockClear());

  async function visit() {
    const id = randomUUID();
    await db('scheduled_services').insert({ id, customer_id: customerId, technician_id: techId, service_type: 'Fixture General Pest Control', scheduled_date: '2099-01-15', window_start: '09:00:00', window_end: '11:00:00', status: 'confirmed' });
    created.visits.push(id);
    return id;
  }

  async function alertRow(fields = {}) {
    const [row] = await db('dispatch_alerts').insert({
      type: 'tech_late', severity: 'warn', tech_id: techId, job_id: await visit(),
      payload: JSON.stringify({ delay_minutes: 25, message: 'Fixture running behind' }), ...fields,
    }).returning('*');
    created.alerts.push(row.id);
    return row;
  }

  const ADMIN = { isAdmin: true, technicianId: null };
  const card = (alertId) => executeDispatchAlertTool('resolve_dispatch_alert', { alert_id: alertId }, ADMIN);
  const confirm = (alertId, preview) => executeDispatchAlertTool('resolve_dispatch_alert', { alert_id: alertId, confirmed: true, _verified_dispatch_alert_version: preview._version }, { ...ADMIN, technicianId: techId });
  const read = (id) => db('dispatch_alerts').where({ id }).first();
  const settle = () => new Promise((r) => setTimeout(r, 50));

  test('the card resolves the alert as the confirming admin, once, and broadcasts after commit', async () => {
    const alert = await alertRow();
    const preview = await card(alert.id);
    expect(preview).toMatchObject({ preview: true, alert_label: 'Tech late', customer_name: 'Fixture AlertCust', technician_name: 'Fixture Alert Tech', message: 'Fixture running behind' });
    expect(await read(alert.id)).toMatchObject({ resolved_at: null });
    expect(await confirm(alert.id, preview)).toMatchObject({ success: true, sent_to_customer: false });
    expect(await read(alert.id)).toMatchObject({ resolved_by: techId });
    expect((await read(alert.id)).resolved_at).not.toBeNull();
    await settle();
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith('dispatch:alert_resolved', expect.objectContaining({ id: alert.id, resolved_by: techId }));
  });

  test('a decision-only card is refused at the card; nothing written', async () => {
    const alert = await alertRow({ type: 'visit_not_closed_out' });
    expect(await card(alert.id)).toMatchObject({ code: 'needs_decision' });
    expect(await read(alert.id)).toMatchObject({ resolved_at: null });
  });

  test.each([
    ['resolved by someone else', (id) => db('dispatch_alerts').where({ id }).update({ resolved_at: db.fn.now() }), 'already_resolved'],
    ['changed by a detector', (id) => db('dispatch_alerts').where({ id }).update({ payload: JSON.stringify({ delay_minutes: 70, message: 'Fixture running far behind' }) }), 'preview_changed'],
    ['removed', (id) => db('dispatch_alerts').where({ id }).del(), 'alert_not_found'],
  ])('an alert %s after the card: refused, nothing written, no broadcast', async (_label, change, code) => {
    const alert = await alertRow();
    const preview = await card(alert.id);
    await change(alert.id);
    expect(await confirm(alert.id, preview)).toMatchObject({ code, preview_changed: true });
    const after = await read(alert.id);
    if (code !== 'alert_not_found') expect(after.resolved_by).toBeNull();
    else expect(after).toBeUndefined();
    await settle();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('a resolve landing in the gap between the pre-check and the lock (the other dispatcher holds the row): the confirm waits, then refuses; nothing doubled', async () => {
    const alert = await alertRow();
    const preview = await card(alert.id);
    let confirmDone = false;
    let confirming;
    await db.transaction(async (trx) => {
      await trx('dispatch_alerts').where({ id: alert.id }).forUpdate().first();
      confirming = confirm(alert.id, preview).then((r) => { confirmDone = true; return r; });
      await settle();
      await new Promise((r) => setTimeout(r, 300));
      expect(confirmDone).toBe(false);
      // The other dispatcher's resolve lands while the confirm waits for the lock.
      await trx('dispatch_alerts').where({ id: alert.id }).update({ resolved_at: trx.fn.now(), resolved_by: techId });
    });
    // The confirm's pre-check ran before the lock, so it is the locked re-read that refuses.
    expect(await confirming).toMatchObject({ preview_changed: true, code: 'preview_changed' });
    await settle();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('a request about one customer: only an alert on that customer\'s own visit passes validateRecordTarget (real rows)', async () => {
    const TaskContext = require('../services/intelligence-bar/task-context');
    const otherCustomerId = randomUUID();
    await db('customers').insert({ id: otherCustomerId, first_name: 'Fixture', last_name: 'OtherCust', phone: '+12025550178', email: `${otherCustomerId}@example.invalid`, property_type: 'residential' });
    created.customers.push(otherCustomerId);
    const otherVisit = randomUUID();
    await db('scheduled_services').insert({ id: otherVisit, customer_id: otherCustomerId, technician_id: techId, service_type: 'Fixture Lawn', scheduled_date: '2099-01-15', window_start: '09:00:00', window_end: '11:00:00', status: 'confirmed' });
    created.visits.push(otherVisit);
    const mine = await alertRow();
    const theirs = await alertRow({ job_id: otherVisit });
    const none = await alertRow({ job_id: null });
    const forCustomer = { targets: [{ customer_id: customerId }] };
    const check = (params, context) => TaskContext.validateRecordTarget(params, context, { toolName: 'resolve_dispatch_alert' });
    expect(await check({ alert_id: mine.id }, forCustomer)).toBeNull();
    expect(await check({ job_id: mine.job_id }, forCustomer)).toBeNull();
    expect(await check({ alert_id: theirs.id }, forCustomer)).toMatchObject({ code: 'target_clarification_required' });
    expect(await check({ alert_id: none.id }, forCustomer)).toMatchObject({ code: 'customer_scope_required' });
    expect(await check({ alert_id: theirs.id }, {})).toBeNull();
    expect(await check({ alert_id: none.id }, {})).toBeNull();
  });

  test('resolveAlertAsDispatcher: resolved, then already_resolved without a second write or broadcast, then not_found', async () => {
    const alert = await alertRow();
    expect(await dispatchAlerts.resolveAlertAsDispatcher({ id: alert.id, resolvedBy: techId })).toMatchObject({ outcome: 'resolved' });
    const firstAt = (await read(alert.id)).resolved_at;
    expect(await dispatchAlerts.resolveAlertAsDispatcher({ id: alert.id, resolvedBy: techId })).toMatchObject({ outcome: 'already_resolved' });
    expect((await read(alert.id)).resolved_at).toEqual(firstAt);
    expect(await dispatchAlerts.resolveAlertAsDispatcher({ id: randomUUID(), resolvedBy: techId })).toEqual({ outcome: 'not_found' });
    await settle();
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const decision = await alertRow({ type: 'visit_not_closed_out' });
    expect(await dispatchAlerts.resolveAlertAsDispatcher({ id: decision.id, resolvedBy: techId })).toEqual({ outcome: 'decision_required' });
    expect((await read(decision.id)).resolved_at).toBeNull();
  });
});
