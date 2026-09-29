/**
 * Plan holds (cancellation-resolution/holds.js) against live Postgres, where
 * DATE columns arrive the way production gets them: pg hydrates
 * scheduled_date, resume_on and tier_protected_until as a Date, and String()
 * of one reads "Mon Oct 05 …". cancellation-holds-and-scoped.test.js seeds
 * those as strings, which is how every date read below hid: startHold threw
 * on the first visit, tier protection could keep an earlier date, the 7-day
 * restart text said "Invalid Date", and a late or undeliverable notice never
 * pushed the restart. The visit mover, the text sender and the admin bell are
 * stood in, so nothing moves a real visit and nothing reaches a customer.
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
  const WINDOW = { start: '08:00:00', end: '10:00:00' }; // TIME columns read back with seconds

  test('startHold shifts the series by whole days onto the resume date and protects the tier through it', async () => {
    const c = await customer({ tier_protected_until: day(5) });
    const first = await lawnVisit(c, day(10));
    const second = await lawnVisit(c, day(40));
    const result = await holds.startHold({ customerId: c.id, caseId: null, familyKey: 'lawn_care', resumeOn: day(30) });
    made.plan_holds.push(result.holdId);
    expect(rebooker.reschedule).toHaveBeenCalledWith(first.id, day(30), WINDOW, 'plan_hold', 'customer', { suppressTechNotice: true });
    expect(rebooker.reschedule).toHaveBeenCalledWith(second.id, day(60), WINDOW, 'plan_hold', 'customer', { suppressTechNotice: true });
    const hold = await holdRow(result.holdId);
    expect(dateOnlyString(hold.resume_on)).toBe(day(30));
    const moved = (typeof hold.moved_visits === 'string' ? JSON.parse(hold.moved_visits) : hold.moved_visits).moved;
    expect(moved.map((m) => [m.from, m.to])).toEqual([[day(10), day(30)], [day(40), day(60)]]);
    // An earlier protection date gives way to the resume date; a later one stands.
    expect(dateOnlyString((await db('customers').where({ id: c.id }).first('tier_protected_until')).tier_protected_until)).toBe(day(30));
    const later = await customer({ tier_protected_until: day(90) });
    await lawnVisit(later, day(12));
    made.plan_holds.push((await holds.startHold({ customerId: later.id, caseId: null, familyKey: 'lawn_care', resumeOn: day(30) })).holdId);
    expect(dateOnlyString((await db('customers').where({ id: later.id }).first('tier_protected_until')).tier_protected_until)).toBe(day(90));
  });

  // A hold whose restart is today, its 7-day text not yet sent, one visit parked on it.
  const dueHold = async () => {
    const c = await customer();
    const parked = await lawnVisit(c, day(0));
    const hold = await insert('plan_holds', { customer_id: c.id, family_key: 'lawn_care', starts_on: day(-20), resume_on: day(0),
      status: 'active', moved_visits: JSON.stringify({ moved: [] }) });
    return { hold, parked };
  };

  test('a restart text delivered late names the real date and pushes the restart, and its parked visit, seven days out', async () => {
    const { hold, parked } = await dueHold();
    sendCustomerMessage.mockResolvedValue({ sent: true });
    await holds.runPlanHoldLifecycle({ today: day(0) });
    expect(renderRequiredSmsTemplate).toHaveBeenCalledWith('plan_hold_resume_reminder', expect.objectContaining({ resume_date: display(day(0)) }), expect.anything());
    expect(rebooker.reschedule).toHaveBeenCalledWith(parked.id, day(7), WINDOW, 'plan_hold_notice', 'system', {});
    expect(dateOnlyString((await holdRow(hold.id)).resume_on)).toBe(day(7));
  });

  test('an undeliverable restart text pushes the restart a week and rings the office', async () => {
    const { hold, parked } = await dueHold();
    sendCustomerMessage.mockResolvedValue({ sent: false });
    await holds.runPlanHoldLifecycle({ today: day(0) });
    expect(rebooker.reschedule).toHaveBeenCalledWith(parked.id, day(7), WINDOW, 'plan_hold_notice', 'system', {});
    expect(dateOnlyString((await holdRow(hold.id)).resume_on)).toBe(day(7));
    expect(notifyAdmin).toHaveBeenCalledWith('service', 'Plan hold cannot auto-resume: restart text undeliverable', expect.any(String), expect.objectContaining({ bell: true }));
  });
});
