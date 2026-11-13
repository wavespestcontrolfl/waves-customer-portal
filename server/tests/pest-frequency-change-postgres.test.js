// One-touch pest frequency change end to end on real migrated PostgreSQL. The plan reader, the
// re-booking (routes/admin-schedule.js changeSeriesFrequencyWithLocks: the plan trim, the template
// stamp and the top-up's own extension loop), the plan-rate ledger and both records run for real.
// Only the outbound entry points are stubbed (office bell, reminders, cancellation follow-through).
// Synthetic records, rolled back after every test. Runs in the DB-gated CI step.
//
// What only this suite can prove:
//   1. A preview writes nothing and a confirm books exactly what the preview showed.
//   2. The new visits carry the new cadence, service and price, and so does the plan's template
//      (the visits the nightly top-up books later).
//   3. A first visit that is near, confirmed or moved on purpose stays exactly as booked.
//   4. An account outside the rules is refused with nothing written.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.setTimeout(120000);

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Nothing may reach a customer or the office from a test. Each module keeps its real exports; only the
// sending entry points are replaced (one-tap-purchase-postgres.test.js, same helper).
function mockSending(path, names, result = {}) {
  const actual = jest.requireActual(path);
  for (const name of names) actual[name] = jest.fn(async () => result);
  return actual;
}
jest.mock('../services/notification-service', () => mockSending('../services/notification-service', ['notifyAdmin', 'notifyCustomer']));
jest.mock('../services/notification-triggers', () => mockSending('../services/notification-triggers', ['triggerNotification']));
jest.mock('../services/appointment-reminders', () => mockSending('../services/appointment-reminders', ['registerAppointment', 'handleSeriesCancellation']));
jest.mock('../services/appointment-tagger', () => mockSending('../services/appointment-tagger', ['onServiceScheduled']));
jest.mock('../services/visit-cancellation-followthrough', () => mockSending('../services/visit-cancellation-followthrough', ['runVisitCancellationFollowThrough']));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: async () => {}, notifyAssignmentChange: async () => {} }));
jest.mock('../services/messaging/send-customer-message', () => mockSending('../services/messaging/send-customer-message', ['sendCustomerMessage']));

const { randomUUID } = require('node:crypto');
const { addETDays, etDateString } = require('../utils/datetime-et');
const { gates } = require('../config/feature-gates');
const NotificationService = require('../services/notification-service');
const AppointmentReminders = require('../services/appointment-reminders');
const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const pestFrequency = require('../services/pest-frequency-change');

postgres('pest frequency change against migrated PostgreSQL', () => {
  let database;
  let trx;
  let catalog;
  const ids = {};
  const day = (n) => etDateString(addETDays(new Date(), n));
  const dayOf = (value) => etDateString(new Date(value));
  const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
  const planRows = () => trx('scheduled_services').where({ customer_id: ids.customer }).orderBy('scheduled_date', 'asc');
  const upcoming = async () => (await planRows()).filter((row) => ['pending', 'confirmed'].includes(row.status));

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  // A WaveGuard Bronze member billed per application: quarterly general pest at $117.00 a visit, the
  // fee and the plan rate that go with it, a completed first visit and four pending ones.
  async function seedPlan({ lastVisitDaysAgo = 20, frequency = 'quarterly', perVisit = 117, firstVisit = {} } = {}) {
    const gap = { quarterly: 91, bimonthly: 61 }[frequency];
    const service = catalog[frequency];
    const visit = (id, daysOut, extra) => ({ id, customer_id: ids.customer, technician_id: ids.technician,
      service_id: service.id, service_type: service.name, scheduled_date: day(daysOut), window_start: '09:00', window_end: '10:00',
      estimated_duration_minutes: 60, is_recurring: true, recurring_pattern: frequency, recurring_ongoing: true,
      estimated_price: perVisit, status: 'pending', ...extra });
    ids.root = randomUUID();
    ids.pending = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await trx('scheduled_services').insert([
      visit(ids.root, -lastVisitDaysAgo, { status: 'completed' }),
      ...ids.pending.map((id, i) => visit(id, gap * (i + 1) - lastVisitDaysAgo, { recurring_parent_id: ids.root, ...(i === 0 ? firstVisit : {}) })),
    ]);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    require('../models/db').connection = trx;
    gates.editApptPriceServiceScope = true;
    Object.assign(ids, { customer: randomUUID(), technician: randomUUID() });
    const rows = await trx('services').whereIn('service_key', ['pest_general_quarterly', 'pest_general_bimonthly', 'pest_general_monthly']);
    catalog = Object.fromEntries(rows.map((row) => [row.frequency, row]));
    await trx('technicians').insert({ id: ids.technician, name: 'Fixture technician', role: 'technician',
      active: true, employment_status: 'active', field_dispatchable: true });
    await trx('customers').insert({ id: ids.customer, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${ids.customer}@example.invalid`, phone: `fx-${ids.customer.slice(0, 12)}`,
      address_line1: '100 Test Lane', city: 'Bradenton', state: 'FL', zip: '34205',
      active: true, pipeline_stage: 'active_customer', billing_mode: 'per_application', waveguard_tier: 'Bronze',
      monthly_rate: 39, per_application_fee: 117 });
    await trx('customer_plan_rates').insert({ customer_id: ids.customer, family_key: 'pest_control', monthly_rate: 39, source: 'estimate_accept' });
  });

  afterEach(async () => {
    gates.editApptPriceServiceScope = false;
    gates.cancelNoticeHook = false;
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  test('the card: the plan today and both choices, priced along the engine curve from the customer\'s own price', async () => {
    await seedPlan();
    await expect(pestFrequency.status(ids.customer)).resolves.toEqual({
      available: true,
      current: { frequency: 'quarterly', visitsPerYear: 4, perVisit: 117, perYear: 468 },
      options: [
        { frequency: 'bimonthly', visitsPerYear: 6, perVisit: 102.96, perYear: 617.76 },
        { frequency: 'monthly', visitsPerYear: 12, perVisit: 91.26, perYear: 1095.12 },
      ],
    });
  });

  test('a customer on every two months sees monthly only, at the ratio of the two curve factors', async () => {
    await seedPlan({ frequency: 'bimonthly', perVisit: 102.96 });
    const card = await pestFrequency.status(ids.customer);
    expect(card.options).toEqual([{ frequency: 'monthly', visitsPerYear: 12, perVisit: 91.26, perYear: 1095.12 }]);
  });

  test('a preview writes nothing', async () => {
    await seedPlan();
    const before = JSON.stringify([await planRows(), await trx('customers').where({ id: ids.customer }).first(),
      await trx('customer_plan_rates').where({ customer_id: ids.customer }), await trx('activity_log').where({ customer_id: ids.customer })]);
    const shown = await pestFrequency.preview(ids.customer, 'monthly');
    expect(shown).toMatchObject({ frequency: 'monthly', perVisit: 91.26, perYear: 1095.12, today: { frequency: 'quarterly', perVisit: 117 } });
    expect(shown.newVisits.length).toBeGreaterThanOrEqual(11);
    const after = JSON.stringify([await planRows(), await trx('customers').where({ id: ids.customer }).first(),
      await trx('customer_plan_rates').where({ customer_id: ids.customer }), await trx('activity_log').where({ customer_id: ids.customer })]);
    expect(after).toBe(before);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });

  test('confirm books what the preview showed: the new schedule replaces the pending visits and counts from the last visit', async () => {
    await seedPlan({ lastVisitDaysAgo: 20 });
    // Each pending visit has its reminder row, and the cancellation-notice hook is on as in production.
    gates.cancelNoticeHook = true;
    await trx('appointment_reminders').insert(ids.pending.map((id, i) => ({ scheduled_service_id: id, customer_id: ids.customer,
      appointment_time: new Date(Date.now() + (71 + 91 * i) * 86400000), source: 'fixture' })));
    const shown = await pestFrequency.preview(ids.customer, 'monthly');
    // The last visit was 20 days ago and the next one was 71 days out: monthly brings it weeks sooner.
    expect(shown.keptVisit).toBeNull();
    expect(shown.replacedVisits).toHaveLength(4);
    expect(shown.newVisits[0] >= day(7)).toBe(true);
    expect(daysBetween(shown.newVisits[0], shown.replacedVisits[0])).toBeGreaterThanOrEqual(14);

    const result = await pestFrequency.confirm(ids.customer, 'monthly', { version: shown.version, ip: '203.0.113.9', userAgent: 'jest' });
    expect(result).toMatchObject({ success: true, newVisits: shown.newVisits, replacedVisits: shown.replacedVisits, version: shown.version });

    // The replaced visits are cancelled plan trims that a replay can never add back.
    const replaced = await trx('scheduled_services').whereIn('id', ids.pending);
    expect(replaced.map((row) => row.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    const declined = await trx('activity_log').where({ customer_id: ids.customer, action: 'recurring_cancel_reseed_declined' });
    expect(declined).toHaveLength(4);
    // No cancellation text can go out for them: each notice is closed as suppressed in the same transaction.
    const notices = await trx('appointment_reminders').whereIn('scheduled_service_id', ids.pending);
    expect(notices.map((row) => row.cancellation_notice_state)).toEqual(['suppressed', 'suppressed', 'suppressed', 'suppressed']);
    // The new visits: monthly, the monthly service, the new price, on the same plan.
    const booked = await upcoming();
    expect(booked.map((row) => dayOf(row.scheduled_date))).toEqual(shown.newVisits);
    for (const row of booked) {
      expect(row).toMatchObject({ recurring_parent_id: ids.root, recurring_pattern: 'monthly', recurring_ongoing: true, is_recurring: true,
        service_id: catalog.monthly.id, service_type: catalog.monthly.name, status: 'pending' });
      expect(Number(row.estimated_price)).toBe(91.26);
    }
    const gaps = booked.slice(1).map((row, i) => daysBetween(dayOf(booked[i].scheduled_date), dayOf(row.scheduled_date)));
    expect(gaps.every((gap) => gap >= 25 && gap <= 36)).toBe(true);
    // The template: what the nightly top-up books later.
    const root = await trx('scheduled_services').where({ id: ids.root }).first();
    expect(root).toMatchObject({ recurring_pattern: 'monthly', status: 'completed', service_id: catalog.quarterly.id });
    expect(Number(root.estimated_price)).toBe(117);
    expect(root.recurring_template_overrides).toMatchObject({ service_id: catalog.monthly.id, service_type: catalog.monthly.name,
      service_key_snapshot: 'pest_general_monthly', estimated_price: 91.26, primary_line_price: 91.26, line_discount_dollars: null });
    // The customer's own money fields follow by the real change: (1095.12 - 468.00) / 12 = 52.26 a month.
    const customer = await trx('customers').where({ id: ids.customer }).first();
    expect([Number(customer.per_application_fee), Number(customer.monthly_rate)]).toEqual([91.26, 91.26]);
    const ledger = await trx('customer_plan_rates').where({ customer_id: ids.customer });
    expect(ledger.map((row) => [row.family_key, Number(row.monthly_rate), row.source])).toEqual([['pest_control', 91.26, 'frequency_change']]);
    // Both records, and one office notice. Nothing to the customer.
    const [activity] = await trx('activity_log').where({ customer_id: ids.customer, action: 'pest_frequency_changed' });
    expect(activity.description).toMatch(/every three months to every month.*\$117\.00 to \$91\.26 a visit; 4 visit\(s\) replaced/);
    const [consent] = await trx('audit_log').where({ action: 'pest_frequency_change', actor_id: ids.customer });
    expect(consent).toMatchObject({ actor_type: 'customer', resource_id: ids.root, ip_address: '203.0.113.9', user_agent: 'jest' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, options] = NotificationService.notifyAdmin.mock.calls[0];
    expect([category, headline]).toEqual(['schedule', 'Schedule — Synthetic Fixture changed how often we visit']);
    expect(why).toBe('Pest control is now every month at $91.26 a visit, changed in the portal.');
    expect(options).toMatchObject({ bell: true, metadata: { severity: 'fyi', customerId: ids.customer } });
    expect(NotificationService.notifyCustomer).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // The cancels are closed with no text, and every new visit gets its reminder.
    expect(AppointmentReminders.handleSeriesCancellation).toHaveBeenCalledWith(ids.pending, ids.pending[0],
      expect.objectContaining({ sendNotification: false }));
    expect(runVisitCancellationFollowThrough).toHaveBeenCalledWith(expect.objectContaining({ targetIds: ids.pending, waiveFee: false }));
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledTimes(booked.length);
  });

  test('a near first visit stays exactly as booked and the new schedule counts from it', async () => {
    // The last visit was 86 days ago, so the next one is 5 days out: inside the lead time.
    await seedPlan({ lastVisitDaysAgo: 86 });
    const shown = await pestFrequency.preview(ids.customer, 'bimonthly');
    expect(shown.keptVisit).toEqual({ date: day(5), perVisit: 117 });
    expect(shown.replacedVisits).toHaveLength(3);
    await pestFrequency.confirm(ids.customer, 'bimonthly', { version: shown.version });

    const kept = await trx('scheduled_services').where({ id: ids.pending[0] }).first();
    expect(kept).toMatchObject({ status: 'pending', service_id: catalog.quarterly.id, recurring_pattern: 'bimonthly' });
    expect([dayOf(kept.scheduled_date), Number(kept.estimated_price)]).toEqual([day(5), 117]);
    const booked = (await upcoming()).filter((row) => row.id !== ids.pending[0]);
    expect(booked.map((row) => dayOf(row.scheduled_date))).toEqual(shown.newVisits);
    const firstGap = daysBetween(day(5), shown.newVisits[0]);
    expect(firstGap >= 55 && firstGap <= 66).toBe(true);
    for (const row of booked) expect([row.service_id, Number(row.estimated_price)]).toEqual([catalog.bimonthly.id, 102.96]);
  });

  test.each([
    ['a confirmed first visit', { status: 'confirmed' }],
    ['a first visit moved on purpose', { date_exception: true }],
  ])('%s stays as booked although the new schedule would come sooner', async (_name, firstVisit) => {
    await seedPlan({ lastVisitDaysAgo: 20, firstVisit });
    const shown = await pestFrequency.preview(ids.customer, 'monthly');
    expect(shown.keptVisit).toEqual({ date: day(71), perVisit: 117 });
    expect(shown.newVisits[0] > day(71)).toBe(true);
  });

  test('a confirm for an outcome the customer did not see is refused and writes nothing', async () => {
    await seedPlan();
    const shown = await pestFrequency.preview(ids.customer, 'monthly');
    await trx('scheduled_services').where({ id: ids.pending[3] }).update({ scheduled_date: day(360) });
    await expect(pestFrequency.confirm(ids.customer, 'monthly', { version: shown.version }))
      .rejects.toMatchObject({ status: 409, code: 'PREVIEW_CHANGED' });
    expect((await upcoming()).map((row) => row.id).sort()).toEqual([...ids.pending].sort());
    expect((await trx('scheduled_services').where({ id: ids.root }).first()).recurring_pattern).toBe('quarterly');
    expect(await trx('activity_log').where({ customer_id: ids.customer })).toEqual([]);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test.each([
    ['billed by monthly membership', 'billing_lane', async () => trx('customers').where({ id: ids.customer }).update({ billing_mode: 'monthly_membership' })],
    ['on annual prepay', 'billing_lane', async () => trx('customers').where({ id: ids.customer }).update({ billing_mode: 'annual_prepay' })],
    ['billed to another payer', 'account', async () => {
      const [payer] = await trx('payers').insert({ display_name: 'Fixture payer' }).returning('id');
      await trx('customers').where({ id: ids.customer }).update({ payer_id: payer.id });
    }],
    ['a visit priced differently', 'visit_prices', async () => trx('scheduled_services').where({ id: ids.pending[2] }).update({ estimated_price: 99 })],
    ['a visit with no price', 'visit_prices', async () => trx('scheduled_services').where({ id: ids.pending[1] }).update({ estimated_price: null })],
    ['a visit paid ahead', 'visit_holds_money', async () => trx('scheduled_services').where({ id: ids.pending[1] }).update({ prepaid_amount: 117, prepaid_at: new Date() })],
    ['a visit billed to another payer', 'plan_shape', async () => {
      const [payer] = await trx('payers').insert({ display_name: 'Fixture payer' }).returning('id');
      await trx('scheduled_services').where({ id: ids.pending[0] }).update({ payer_id: payer.id });
    }],
    ['a pending visit whose tracker is live', 'plan_shape', async () => trx('scheduled_services').where({ id: ids.pending[0] }).update({ track_state: 'en_route' })],
    // By status such a visit is not among the upcoming rows at all: the plan itself is asked.
    ['a technician on the way to a visit', 'visit_under_way', async () => trx('scheduled_services').where({ id: ids.pending[0] }).update({ status: 'en_route', scheduled_date: day(0) })],
    ['a technician at a visit', 'visit_under_way', async () => trx('scheduled_services').where({ id: ids.pending[0] }).update({ status: 'on_site', scheduled_date: day(0) })],
    ['a first visit that was never closed', 'visit_under_way', async () => trx('scheduled_services').where({ id: ids.root }).update({ status: 'on_site' })],
    ['an add-on line on a visit', 'plan_shape', async () => trx('scheduled_service_addons').insert({ scheduled_service_id: ids.pending[0], service_name: 'Fixture add-on' })],
    ['a plan that is not ongoing', 'plan_shape', async () => trx('scheduled_services').where({ id: ids.root }).update({ recurring_ongoing: false })],
    ['a plan whose first visit was cancelled', 'plan_shape', async () => trx('scheduled_services').where({ id: ids.root }).update({ status: 'cancelled' })],
    ['a second general pest plan', 'several_plans', async () => trx('scheduled_services').insert({ id: randomUUID(), customer_id: ids.customer,
      service_id: catalog.quarterly.id, service_type: catalog.quarterly.name, scheduled_date: day(40), is_recurring: true,
      recurring_pattern: 'quarterly', recurring_ongoing: true, estimated_price: 117, status: 'pending' })],
    ['a price-change notice still to apply', 'price_notice_open', async () => trx('price_change_notices').insert({ batch_id: randomUUID(), customer_id: ids.customer,
      current_amount_cents: 11700, new_amount_cents: 12500, effective_date: day(30), notice_token: randomUUID(), status: 'sent' })],
  ])('an account with %s keeps the office path', async (_name, reason, change) => {
    await seedPlan();
    await expect(pestFrequency._private.readPlan(trx, ids.customer)).resolves.toMatchObject({ reason: null });
    await change();
    const before = JSON.stringify(await planRows());
    await expect(pestFrequency._private.readPlan(trx, ids.customer)).resolves.toEqual({ plan: null, reason });
    await expect(pestFrequency.status(ids.customer)).resolves.toEqual({ available: false });
    await expect(pestFrequency.preview(ids.customer, 'monthly')).rejects.toMatchObject({ status: 409, code: 'FREQUENCY_CHANGE_UNAVAILABLE' });
    await expect(pestFrequency.confirm(ids.customer, 'monthly', { version: 'any' })).rejects.toMatchObject({ status: 409, code: 'FREQUENCY_CHANGE_UNAVAILABLE' });
    expect(JSON.stringify(await planRows())).toBe(before);
  });

  test('the schedule\'s own refusal reaches the customer as the one neutral answer', async () => {
    await seedPlan();
    // The series template overlay is off: the new price could not reach later visits.
    gates.editApptPriceServiceScope = false;
    await expect(pestFrequency.preview(ids.customer, 'monthly')).rejects.toMatchObject({
      status: 409, code: 'FREQUENCY_CHANGE_UNAVAILABLE', reason: 'FREQUENCY_CHANGE_UNSUPPORTED',
      message: 'This change is not available online for this plan.',
    });
  });

  test('a plan rate the ledger cannot split stays as it was, and the change still commits', async () => {
    await seedPlan();
    // A held pest line (a zero row) refuses the line edit.
    await trx('customer_plan_rates').where({ customer_id: ids.customer }).update({ monthly_rate: 0, source: 'plan_hold' });
    const shown = await pestFrequency.preview(ids.customer, 'monthly');
    await pestFrequency.confirm(ids.customer, 'monthly', { version: shown.version });
    const customer = await trx('customers').where({ id: ids.customer }).first();
    expect([Number(customer.per_application_fee), Number(customer.monthly_rate)]).toEqual([91.26, 39]);
    expect((await upcoming()).length).toBe(shown.newVisits.length);
    expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toMatch(/monthly rate on the customer record was not changed/);
  });
});
