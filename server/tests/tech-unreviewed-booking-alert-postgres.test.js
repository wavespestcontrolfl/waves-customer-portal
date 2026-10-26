/**
 * GATE_TECH_STAFF_GUARDS, M6 (census 2026-10-25): the one office notice for a booking a technician
 * tried to start before the office reviewed it, against live Postgres. One row per visit however many
 * times the technician taps; the rule's eight parts are present; confirming the booking closes it
 * done. Every row and customer these tests insert is deleted afterwards. Push is mocked; nothing is sent.
 */
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/push-notifications');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('tech-unreviewed-booking-alert (live Postgres)', () => {
  let db;
  let alert;
  const visits = [];
  const customers = [];

  beforeAll(() => {
    db = require('../models/db');
    alert = require('../services/tech-unreviewed-booking-alert');
  });
  afterEach(async () => {
    for (const id of visits.splice(0)) {
      await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [alert.keyFor(id)]).del();
      await db('scheduled_services').where({ id }).del();
    }
    for (const id of customers.splice(0)) await db('customers').where({ id }).del();
  });

  // A real visit row: the raise locks and re-reads it. Pending, from a phone booking, not confirmed.
  const newVisit = async (name = ['Ana', 'Lee']) => {
    const id = randomUUID();
    const customerId = randomUUID();
    visits.push(id);
    customers.push(customerId);
    await db('customers').insert({ id: customerId, first_name: name ? name[0] : '', last_name: name ? name[1] : '', phone: '+19415550188' });
    await db('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: '2026-10-26', service_type: 'General Pest Control',
      status: 'pending', customer_confirmed: false, source_action: 'voice_agent',
    });
    return { id, customer_id: customerId, scheduled_date: '2026-10-26' };
  };
  const rows = (id) => db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [alert.keyFor(id)]).select('*');

  test('a refused tap raises one Schedule needs-you notice with the eight parts', async () => {
    const visit = await newVisit();
    await alert.raiseForVisit(visit, 'En Route');
    const found = await rows(visit.id);
    expect(found).toHaveLength(1);
    const [row] = found;
    expect(row.recipient_type).toBe('admin');
    expect(row.category).toBe('schedule');
    expect(row.title).toBe('Schedule — review Ana Lee\'s booking before the visit');
    expect(row.body).toBe('The technician tapped En Route, but the office has not reviewed this booking.');
    expect(row.body.length).toBeLessThanOrEqual(110);
    expect(row.link).toBe(`/admin/dispatch?tab=schedule&date=2026-10-26&appointment=${visit.id}`);
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    expect(meta).toMatchObject({
      area: 'Schedule', severity: 'needs-you', subject: { type: 'visit', id: visit.id },
      doneWhen: 'visit_confirmed', who: 'person', scheduledServiceId: visit.id,
    });
    expect(row.done_at).toBeNull();
    expect(row.read_at).toBeNull();
  });

  test('a booking the office confirmed after the technician read it raises no notice', async () => {
    const visit = await newVisit();
    // The technician's request read the pending row; the office confirmed before the raise.
    await db('scheduled_services').where({ id: visit.id }).update({ status: 'confirmed', customer_confirmed: true });
    expect(await alert.raiseForVisit(visit, 'En Route')).toBeNull();
    expect(await rows(visit.id)).toHaveLength(0);
  });

  test('a moved booking the office never reviewed (confirmed, not customer-confirmed) still raises its notice', async () => {
    const visit = await newVisit();
    await db('scheduled_services').where({ id: visit.id }).update({ status: 'confirmed', customer_confirmed: false });
    await alert.raiseForVisit(visit, 'En Route');
    expect(await rows(visit.id)).toHaveLength(1);
  });

  test('the close sweep closes a cancelled visit\'s notice done and leaves a still-pending one open', async () => {
    const cancelled = await newVisit();
    const pending = await newVisit(['Bo', 'Ray']);
    await alert.raiseForVisit(cancelled, 'En Route');
    await alert.raiseForVisit(pending, 'En Route');
    await db('scheduled_services').where({ id: cancelled.id }).update({ status: 'cancelled' });
    expect(await alert.closeResolved()).toBe(1);
    const [closedRow] = await rows(cancelled.id);
    expect(closedRow.done_at).not.toBeNull();
    expect(closedRow.resolution).toBe('The visit was cancelled.');
    const [openRow] = await rows(pending.id);
    expect(openRow.done_at).toBeNull();
    expect(await alert.closeResolved()).toBe(0);
  });

  test('a second tap (either leg) rings nothing new', async () => {
    const visit = await newVisit();
    await alert.raiseForVisit(visit, 'En Route');
    await alert.raiseForVisit(visit, 'En Route');
    await alert.raiseForVisit(visit, 'On Site');
    const found = await rows(visit.id);
    expect(found).toHaveLength(1);
    expect(found[0].body).toContain('En Route');
  });

  test('another visit gets its own notice', async () => {
    const a = await newVisit();
    const b = await newVisit(['Synthetic', 'Other']);
    await alert.raiseForVisit(a, 'En Route');
    await alert.raiseForVisit(b, 'On Site');
    expect(await rows(a.id)).toHaveLength(1);
    expect(await rows(b.id)).toHaveLength(1);
  });

  test('confirming the booking closes its notice done, and only that one', async () => {
    const a = await newVisit();
    const b = await newVisit(['Synthetic', 'Other']);
    await alert.raiseForVisit(a, 'En Route');
    await alert.raiseForVisit(b, 'En Route');
    expect(await alert.closeForVisit(a.id)).toBe(1);
    const [closed] = await rows(a.id);
    expect(closed.done_at).not.toBeNull();
    expect(closed.done_by).toBe('episodes');
    expect(closed.resolution).toBe('The office confirmed the booking.');
    expect((await rows(b.id))[0].done_at).toBeNull();
    // Closing again, or a visit with no notice, is a no-op.
    expect(await alert.closeForVisit(a.id)).toBe(0);
    expect(await alert.closeForVisit(randomUUID())).toBe(0);
  });

  test('a name that is too long for the full headline uses the shorter one', async () => {
    const visit = await newVisit(['Synthetic', 'Customer']);
    await alert.raiseForVisit(visit, 'En Route');
    const [row] = await rows(visit.id);
    expect(row.title).toBe('Schedule — review Synthetic Customer\'s booking');
  });

  test('a customer with no name on file still gets a plain headline', async () => {
    const visit = await newVisit(null);
    await alert.raiseForVisit(visit, 'On Site');
    const [row] = await rows(visit.id);
    expect(row.title).toBe('Schedule — review a booking before the visit');
  });

  test('a long name gives way to fit the 60-character headline', async () => {
    const visit = await newVisit(['Synthetic', 'Extraordinarily Long Hyphenated Surname']);
    await alert.raiseForVisit(visit, 'En Route');
    const [row] = await rows(visit.id);
    expect(row.title.length).toBeLessThanOrEqual(60);
    expect(row.title.startsWith('Schedule — review ')).toBe(true);
  });
});
