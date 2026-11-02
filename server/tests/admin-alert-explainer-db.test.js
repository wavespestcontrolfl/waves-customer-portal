/**
 * The bell's "What to do" against live Postgres (GATE_ALERT_EXPLAINER): the customer an alert names is read from the
 * record behind it (a customer id, a visit, an estimate or lead with no customer, a customer page link), a saved
 * summary never changes the row's content version (so Done and button taps stay fenced on the text shown), a summary
 * is saved only while the row still shows the text it was written from, and a second open reads it back without a
 * model call. The model is mocked; everything else is the real database. Rows are this run's own and are removed.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

maybeDescribe('alert explainer (live Postgres)', () => {
  let db;
  let NotificationService;
  let customersForAlerts;
  let explainer;
  let dispatchWithFallback;
  const RUN = `alert-explainer-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = () => `+1941${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const made = { customers: [], visits: [], estimates: [], leads: [] };

  beforeAll(async () => {
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    ({ customersForAlerts } = require('../services/admin-alert-customer'));
    explainer = require('../services/admin-alert-explainer');
    ({ dispatchWithFallback } = require('../services/llm/call'));
  });
  afterAll(async () => {
    await db('notifications').whereRaw("metadata->>'run' = ?", [RUN]).del();
    if (made.visits.length) await db('scheduled_services').whereIn('id', made.visits).del();
    if (made.estimates.length) await db('estimates').whereIn('id', made.estimates).del();
    if (made.leads.length) await db('leads').whereIn('id', made.leads).del();
    if (made.customers.length) await db('customers').whereIn('id', made.customers).del();
    await db.destroy();
  });

  const customer = async (first, last) => {
    const [row] = await db('customers').insert({ first_name: first, last_name: last, phone: phone() }).returning('id');
    made.customers.push(row.id);
    return row.id;
  };
  const alertRow = async (over = {}) => {
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: 'Accepted recurring plan needs schedule review',
      body: 'The accepted pest control plan calls for quarterly service.', link: '/admin/dispatch',
      ...over,
      metadata: JSON.stringify({ run: RUN, ...(over.metadata || {}) }),
    }).returning('*');
    return row;
  };

  test('names the customer from a customer id, a visit, a customer link, and an estimate or lead that has no customer', async () => {
    const jane = await customer('Jane', 'Doe');
    const bob = await customer('Bob', 'Smith');
    const [visit] = await db('scheduled_services').insert({ customer_id: bob, scheduled_date: '2026-11-20', service_type: 'Pest Control' }).returning('id');
    made.visits.push(visit.id);
    const [estimate] = await db('estimates').insert({ customer_name: 'Carla Ruiz' }).returning('id');
    made.estimates.push(estimate.id);
    const [lead] = await db('leads').insert({ first_name: 'Dan', last_name: 'Wu' }).returning('id');
    made.leads.push(lead.id);

    const byId = await alertRow({ metadata: { customer_id: jane } });
    const byVisit = await alertRow({ metadata: { scheduledServiceId: visit.id } });
    const byLink = await alertRow({ link: `/admin/customers/${jane}` });
    const byEstimate = await alertRow({ metadata: { estimate_id: estimate.id } });
    const byLead = await alertRow({ metadata: { payload: { leadId: lead.id } } });
    const nobody = await alertRow({ metadata: { customerId: 'not-a-uuid' } });

    const names = await customersForAlerts(db, [byId, byVisit, byLink, byEstimate, byLead, nobody]);
    expect(names.get(byId.id)).toEqual({ id: jane, name: 'Jane Doe' });
    expect(names.get(byVisit.id)).toEqual({ id: bob, name: 'Bob Smith' });
    expect(names.get(byLink.id)).toEqual({ id: jane, name: 'Jane Doe' });
    expect(names.get(byEstimate.id)).toEqual({ id: null, name: 'Carla Ruiz' });
    expect(names.get(byLead.id)).toEqual({ id: null, name: 'Dan Wu' });
    expect(names.has(nobody.id)).toBe(false);
  });

  test('a saved summary keeps the row\'s version, and is saved only for the text it was written from', async () => {
    const row = await alertRow();
    const loaded = await NotificationService.getAdminNotificationForExplainer(row.id, { role: 'admin' });
    expect(loaded.version).toMatch(/^[0-9a-f]{32}$/);

    expect(await NotificationService.saveAdminExplainer(row.id, loaded.version, { v: 1, version: loaded.version, happened: 'x', steps: ['y'], fixer: 'you' })).toBe(1);
    const state = await NotificationService.getAdminNotificationState(row.id, { role: 'admin' });
    expect(state.version).toBe(loaded.version);

    await db('notifications').where({ id: row.id }).update({ body: 'The accepted lawn plan calls for 9 visits.' });
    expect(await NotificationService.saveAdminExplainer(row.id, loaded.version, { v: 1, version: loaded.version, happened: 'stale', steps: ['y'], fixer: 'you' })).toBe(0);
    const stored = await db('notifications').where({ id: row.id }).first('explainer');
    expect(stored.explainer.happened).toBe('x');
  });

  test('the first open writes and saves the summary; the next reads it back; new text gets a new one', async () => {
    const jane = await customer('Jane', 'Doe');
    const row = await alertRow({ metadata: { customer_id: jane } });
    const answer = { happened: 'Jane Doe\'s schedule has one visit more than her plan.', steps: ['Open Jane Doe\'s schedule.'], fixer: 'you' };
    dispatchWithFallback.mockReset();
    dispatchWithFallback.mockResolvedValue({ ok: true, json: answer, provider: 'anthropic', model: 'routine-model' });

    const first = await explainer.explainAdminAlert(row.id, { role: 'admin' });
    expect(first).toEqual({ status: 200, body: { explainer: answer, customer: { id: jane, name: 'Jane Doe' } } });
    const second = await explainer.explainAdminAlert(row.id, { role: 'admin' });
    expect(second.body.explainer).toEqual(answer);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);

    await db('notifications').where({ id: row.id }).update({ body: 'The accepted plan now has 6 visits.' });
    await explainer.explainAdminAlert(row.id, { role: 'admin' });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(2);
  });

  test('a technician cannot read an admin row that is not tech-visible', async () => {
    const row = await alertRow();
    expect(await explainer.explainAdminAlert(row.id, { role: 'technician', technicianId: '00000000-0000-4000-8000-000000000001' }))
      .toEqual({ status: 404, body: { error: 'not_found' } });
  });
});
