/**
 * "Send to Claude" against live Postgres (GATE_ALERT_SEND_TO_CLAUDE): a send moves the row out of the bell into Claude's
 * queue only at the version the bell served, naming the customer from the record; a refresh of the same alert updates
 * its text but keeps it in Claude's queue while it is open; a refresh that rings after it was closed puts it back in the
 * bell without the stamp; and needs-me lists it with the customer's name and the sent mark. Everything is the real
 * database. Rows are this run's own and are removed.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('send to Claude (live Postgres)', () => {
  let db;
  let NotificationService;
  let sendAdminAlertToClaude;
  let listNeedsMe;
  const RUN = `send-to-claude-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const phone = () => `+1941${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const made = { customers: [] };
  const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);

  beforeAll(async () => {
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    ({ sendAdminAlertToClaude } = require('../services/admin-alert-send-to-claude'));
    ({ listNeedsMe } = require('../services/needs-me'));
  });
  afterAll(async () => {
    await db('notifications').whereRaw("metadata->>'run' = ?", [RUN]).del();
    if (made.customers.length) await db('customers').whereIn('id', made.customers).del();
    await db.destroy();
  });

  const customer = async (first, last) => {
    const [row] = await db('customers').insert({ first_name: first, last_name: last, phone: phone() }).returning('id');
    made.customers.push(row.id);
    return row.id;
  };
  // A keyed alert, written the way an emitter writes it, so a later emission refreshes the same row.
  const raise = (key, body, extra = {}) => NotificationService.notifyAdmin('schedule', 'Accepted recurring plan needs schedule review', body, {
    dedupeKey: key, refreshOnDedupe: true, link: '/admin/dispatch', metadata: { run: RUN, severity: 'needs-you', who: 'person', ...extra },
  });
  const served = async (id) => (await NotificationService.getAdminNotificationForExplainer(id, { role: 'admin' }));
  const inBell = async (id) => (await NotificationService.getAdminNotifications(200, 0, { role: 'admin' })).some((r) => r.id === id);

  test('a send moves the row to Claude\'s queue at the served version only, naming the customer', async () => {
    const jane = await customer('Jane', 'Doe');
    const key = `accepted-schedule:${RUN}:plan-a`;
    const alert = await raise(key, 'The plan calls for 4 visits; the schedule has 5.', { customerId: jane });
    const { version } = await served(alert.id);
    expect(await inBell(alert.id)).toBe(true);

    expect(await sendAdminAlertToClaude(alert.id, { version: 'f'.repeat(32), by: 'admin-1', role: 'admin' }))
      .toEqual({ status: 409, body: { error: 'changed' } });
    expect(await inBell(alert.id)).toBe(true);

    const out = await sendAdminAlertToClaude(alert.id, { version, by: 'admin-1', role: 'admin' });
    expect(out.status).toBe(200);
    expect(await inBell(alert.id)).toBe(false);
    const stamped = meta(await db('notifications').where({ id: alert.id }).first());
    expect(stamped).toEqual(expect.objectContaining({ feed: 'activity', who: 'claude', claudeQueue: 'sent-to-claude', dedupeKey: key, customerId: jane }));
    expect(stamped.sentToClaude).toEqual(expect.objectContaining({ by: 'admin-1', customer: { id: jane, name: 'Jane Doe' }, was: { who: 'person', severity: 'needs-you' } }));

    // Already off the bell: a second send is refused.
    expect((await sendAdminAlertToClaude(alert.id, { version: (await served(alert.id)).version, by: 'admin-1', role: 'admin' })).status).toBe(422);
  });

  test('a refresh updates the text of an open sent row and keeps it in Claude\'s queue; after Done a ring brings it back to the bell', async () => {
    const key = `accepted-schedule:${RUN}:plan-b`;
    const alert = await raise(key, 'The plan calls for 4 visits; the schedule has 5.');
    expect((await sendAdminAlertToClaude(alert.id, { version: (await served(alert.id)).version, by: 'admin-1', role: 'admin' })).status).toBe(200);

    const refreshed = await raise(key, 'The plan calls for 4 visits; the schedule has 6.');
    expect(refreshed.id).toBe(alert.id);
    const row = await db('notifications').where({ id: alert.id }).first();
    expect(row.body).toBe('The plan calls for 4 visits; the schedule has 6.');
    expect(meta(row)).toEqual(expect.objectContaining({ feed: 'activity', who: 'claude', claudeQueue: 'sent-to-claude' }));
    expect(meta(row).sentToClaude).toBeTruthy();
    expect(await inBell(alert.id)).toBe(false);

    expect(await NotificationService.markAdminDone([alert.id], { by: 'claude', resolution: 'Fixed the schedule.', role: 'admin' })).toBe(1);
    await raise(key, 'The plan calls for 4 visits; the schedule has 7.');
    const back = await db('notifications').where({ id: alert.id }).first();
    expect(back.done_at).toBeNull();
    expect(meta(back)).not.toHaveProperty('sentToClaude');
    expect(meta(back)).not.toHaveProperty('claudeQueue');
    expect(meta(back).feed).not.toBe('activity');
    expect(await inBell(alert.id)).toBe(true);
  });

  test('a customer-tied alert outside the reviewed checks is not sent (owner 2026-11-02, "A")', async () => {
    const carla = await customer('Carla', 'Ruiz');
    const alert = await NotificationService.notifyAdmin('service', 'Service request from Carla Ruiz', 'Please look at the side yard.', {
      link: '/admin/customers', metadata: { run: RUN, customerId: carla },
    });
    expect(await sendAdminAlertToClaude(alert.id, { version: (await served(alert.id)).version, by: 'admin-1', role: 'admin' }))
      .toEqual({ status: 422, body: { error: 'not_system_written' } });
    expect(await inBell(alert.id)).toBe(true);
  });

  test('a closed row is not sent', async () => {
    const alert = await raise(`accepted-schedule:${RUN}:plan-c`, 'The plan calls for 4 visits; the schedule has 5.');
    const { version } = await served(alert.id);
    await NotificationService.markAdminDone([alert.id], { by: 'admin-1', role: 'admin' });
    expect((await sendAdminAlertToClaude(alert.id, { version, by: 'admin-1', role: 'admin' })).status).toBe(422);
  });

  test('needs-me lists a sent row under Claude with the customer\'s name and the sent mark', async () => {
    const bob = await customer('Bob', 'Smith');
    const alert = await raise(`accepted-schedule:${RUN}:plan-d`, 'The plan calls for 4 visits; the schedule has 5.', { customerId: bob });
    await sendAdminAlertToClaude(alert.id, { version: (await served(alert.id)).version, by: 'admin-1', role: 'admin' });

    const listed = (await listNeedsMe({ who: 'claude', role: 'admin', customers: true })).items.find((i) => i.id === alert.id);
    expect(listed).toEqual(expect.objectContaining({ who: 'claude', sent: true, customer: { id: bob, name: 'Bob Smith' } }));
    // Not asked and the gate off: no names.
    const plain = (await listNeedsMe({ who: 'claude', role: 'admin' })).items.find((i) => i.id === alert.id);
    expect(plain).not.toHaveProperty('customer');
  });
});
