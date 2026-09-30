/**
 * Plan holds (cancellation-resolution/holds.js) against live Postgres, where
 * DATE columns arrive the way production gets them: pg hydrates
 * scheduled_date, resume_on and tier_protected_until as a Date, and String()
 * of one reads "Mon Oct 05 …". cancellation-holds-and-scoped.test.js seeds
 * those as strings, which is how every date read below hid: startHold threw
 * on the first visit, tier protection could keep an earlier date, and the
 * restart text said "Invalid Date" for the visit it names. The visit mover,
 * the text sender and the admin bell are stood in, so nothing moves a real
 * visit and nothing reaches a customer.
 * Every row these tests insert is deleted afterwards.
 */
const { etDateString, addETDays, dateOnlyString } = require('../utils/datetime-et');

jest.mock('../services/rebooker', () => ({ reschedule: jest.fn(async () => ({ technicianId: null })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'body') }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n' })) }));

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

// It writes customers, visits and holds, so only a disposable database: CI's
// localhost waves_test, or this worktree's own QA database.
function disposableDatabase(connection) {
  const url = new URL(connection);
  const localCi = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
  const ownedQa = process.env.WAVES_LOCAL_DEV === '1'
    && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
  return localCi || ownedQa;
}

// ET calendar dates relative to today (AGENTS.md near-today rule).
const day = (offset) => etDateString(addETDays(new Date(), offset));
const display = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

maybeDescribe('plan holds read DATE columns as dates (live Postgres)', () => {
  let db;
  let holds;
  const rebooker = require('../services/rebooker');
  const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
  const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
  const { notifyAdmin } = require('../services/notification-service');
  const made = { plan_holds: [], scheduled_services: [], customers: [] };
  let n = 0;

  beforeAll(() => {
    if (!disposableDatabase(process.env.DATABASE_URL)) throw new Error('Use disposable CI or this worktree\'s private QA database');
    db = require('../models/db');
    holds = require('../services/cancellation-resolution/holds');
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => {
    if (!db) return;
    if (made.customers.length) await db('customer_interactions').whereIn('customer_id', made.customers).del();
    for (const table of ['plan_holds', 'scheduled_services', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
    await db.destroy();
  });

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  // Per-visit billing: no monthly component to suspend, so a hold needs none.
  const customer = (over = {}) => {
    n += 1;
    return insert('customers', { first_name: 'Hold', last_name: `Probe ${n}`, phone: `+1555558${String(1000 + n)}`,
      pipeline_stage: 'active_customer', active: true, billing_mode: 'per_visit', ...over });
  };
  const lawnVisit = (c, scheduledDate) => insert('scheduled_services', {
    customer_id: c.id, scheduled_date: scheduledDate, service_type: 'Lawn Care', status: 'confirmed', window_start: '08:00', window_end: '10:00',
  });
  const holdRow = async (id) => db('plan_holds').where({ id }).first();

  test('startHold hands back the visits inside the pause to skip (moving none), and protects the tier through the return date', async () => {
    const c = await customer({ tier_protected_until: day(5) });
    const first = await lawnVisit(c, day(10));
    const second = await lawnVisit(c, day(20));
    const back = await lawnVisit(c, day(40));
    const result = await holds.startHold({ customerId: c.id, caseId: null, familyKey: 'lawn_care', resumeOn: day(30) });
    made.plan_holds.push(result.holdId);
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(result.pendingSkips.map((v) => [v.id, v.from])).toEqual([[first.id, day(10)], [second.id, day(20)]]);
    // startHold leaves every visit as it was; skipping happens after the whole accept stands.
    const rows = await db('scheduled_services').whereIn('id', [first.id, second.id, back.id]).select('id', 'status', 'scheduled_date');
    expect(rows.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    const hold = await holdRow(result.holdId);
    expect(dateOnlyString(hold.resume_on)).toBe(day(30));
    const record = typeof hold.moved_visits === 'string' ? JSON.parse(hold.moved_visits) : hold.moved_visits;
    expect(record.moved).toEqual([]);
    expect(record.toSkip.map((v) => [v.id, v.from])).toEqual([[first.id, day(10)], [second.id, day(20)]]);
    // An earlier protection date gives way to the resume date; a later one stands.
    expect(dateOnlyString((await db('customers').where({ id: c.id }).first('tier_protected_until')).tier_protected_until)).toBe(day(30));
    const later = await customer({ tier_protected_until: day(90) });
    await lawnVisit(later, day(12));
    made.plan_holds.push((await holds.startHold({ customerId: later.id, caseId: null, familyKey: 'lawn_care', resumeOn: day(30) })).holdId);
    expect(dateOnlyString((await db('customers').where({ id: later.id }).first('tier_protected_until')).tier_protected_until)).toBe(day(90));
  });

  test('a pause with no visit inside it writes no hold and names the next visit, read from a Date column', async () => {
    const c = await customer();
    await lawnVisit(c, day(45));
    expect(await holds.startHold({ customerId: c.id, caseId: null, familyKey: 'lawn_care', resumeOn: day(30) }))
      .toEqual({ notNeeded: true, familyKey: 'lawn_care', nextVisitOn: day(45), nextVisitDisplay: display(day(45)) });
    expect(await db('plan_holds').where({ customer_id: c.id }).first()).toBeUndefined();
  });

  // A hold whose pause is over or nearly so, with its first visit back on `visitDay`.
  const heldWithVisitBack = async (resumeDay, visitDay, status = 'active') => {
    const c = await customer();
    const visit = await lawnVisit(c, day(visitDay));
    const hold = await insert('plan_holds', { customer_id: c.id, family_key: 'lawn_care', starts_on: day(-20), resume_on: day(resumeDay),
      status, moved_visits: JSON.stringify({ moved: [], toSkip: [], skipped: [] }) });
    return { c, hold, visit };
  };

  test('the restart text names the first visit back (a Date column, not "Invalid Date"), stamps once, and moves nothing', async () => {
    const { hold, visit } = await heldWithVisitBack(3, 5);
    sendCustomerMessage.mockResolvedValue({ sent: true });
    await holds.runPlanHoldLifecycle({ today: day(0) });
    expect(renderRequiredSmsTemplate).toHaveBeenCalledWith('plan_hold_restart_first_visit',
      expect.objectContaining({ visit_date: display(day(5)) }), expect.anything());
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ plan_hold_id: hold.id, visit_id: visit.id }) }));
    expect((await holdRow(hold.id)).reminder_sent_at).toBeTruthy();
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    await holds.runPlanHoldLifecycle({ today: day(0) });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a resumed hold whose first visit back is still ahead gets its text; dues resume on the return date without one', async () => {
    const owed = await heldWithVisitBack(-2, 4, 'resumed');
    sendCustomerMessage.mockResolvedValue({ sent: true });
    const out = await holds.runPlanHoldLifecycle({ today: day(0) });
    expect(out.reminded).toBeGreaterThanOrEqual(1);
    expect((await holdRow(owed.hold.id)).reminder_sent_at).toBeTruthy();

    // No visit booked after the return date: it resumes, texts nothing, and the office is told.
    sendCustomerMessage.mockClear();
    const c = await customer();
    const bare = await insert('plan_holds', { customer_id: c.id, family_key: 'lawn_care', starts_on: day(-20), resume_on: day(0),
      status: 'active', moved_visits: JSON.stringify({ moved: [], toSkip: [], skipped: [] }) });
    await holds.runPlanHoldLifecycle({ today: day(0) });
    expect((await holdRow(bare.id)).status).toBe('resumed');
    expect(sendCustomerMessage).not.toHaveBeenCalledWith(expect.objectContaining({ customerId: c.id }));
    expect(notifyAdmin).toHaveBeenCalledWith('service', 'Plan hold: no visit booked after the pause', expect.any(String), expect.objectContaining({ bell: true, dedupeKey: `plan_hold_no_visit_back:${bare.id}` }));
  });

  test('an undeliverable restart text is left unstamped for tomorrow and rings the office when the visit is tomorrow', async () => {
    const { hold } = await heldWithVisitBack(1, 1);
    sendCustomerMessage.mockResolvedValue({ sent: false });
    await holds.runPlanHoldLifecycle({ today: day(0) });
    expect((await holdRow(hold.id)).reminder_sent_at).toBeNull();
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledWith('service', 'Plan hold: restart text not delivered', expect.any(String), expect.objectContaining({ bell: true, dedupeKey: `plan_hold_restart_text_undelivered:${hold.id}` }));
  });
});
