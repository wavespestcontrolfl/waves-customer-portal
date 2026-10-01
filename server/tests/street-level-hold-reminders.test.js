// Owner ruling 2026-09-30: no 72h/24h reminder for a street-level address hold
// until the office confirms. The registration self-heal skips it, the reminder
// send pass cannot send for it even if a reminder row already exists, and the
// office confirm hook arms the reminders. Scoped to the hold only. Synthetic data.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/estimate-card-holds', () => ({ cardHoldReminderLine: jest.fn(async () => '') }));

const fs = require('fs');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentReminders = require('../services/appointment-reminders');
const { heldVisitSubquery, isStreetLevelHoldVisit } = require('../services/street-level-hold');

function chain(overrides = {}) {
  const c = {
    where: jest.fn().mockReturnThis(), whereIn: jest.fn().mockReturnThis(), whereExists: jest.fn().mockReturnThis(),
    whereNotExists: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), from: jest.fn().mockReturnThis(),
    first: jest.fn(), update: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
  return c;
}

describe('the hold subquery', () => {
  test('matches the unconfirmed street-level card for the outer visit and releases on cancel / skip / reschedule', () => {
    const q = chain();
    heldVisitSubquery(q, 'ss');
    expect(q.from).toHaveBeenCalledWith('triage_items as hold_ti');
    expect(q.where).toHaveBeenCalledWith('hold_ti.reason_code', 'outbound_booking_review');
    const raws = q.whereRaw.mock.calls.map(([sql]) => sql);
    expect(raws).toContain("COALESCE(hold_ti.payload->>'street_level_address', '') = 'true'");
    expect(raws).toContain("hold_ti.payload->>'scheduled_service_id' = ss.id::text");
    expect(raws).toContain('ss.customer_confirmed = false');
    expect(raws).toContain("ss.status NOT IN ('cancelled', 'skipped', 'rescheduled')");
  });
});

describe('registration self-heal', () => {
  test('excludes street-level holds only (a whereNotExists on the hold subquery), leaving every other pending row armed', () => {
    const src = fs.readFileSync(require.resolve('../services/appointment-reminders.js'), 'utf8');
    const heal = src.slice(src.indexOf('async selfHealMissingReminderRows()'));
    const block = heal.slice(0, heal.indexOf('.limit(SELF_HEAL_REGISTRATION_LIMIT)'));
    expect(block).toContain(".whereNotExists(function () { heldVisitSubquery(this, 'ss'); })");
    // The owner ruling 2026-08-17 carve-out removal is intact: no blanket pending exclusion.
    expect(block).not.toMatch(/whereNot(In)?\('ss\.status', \[?'pending'/);
    expect(block).not.toContain("customer_confirmed', false");
  });
});

describe('reminder send pass', () => {
  const fixedNow = new Date('2026-05-06T13:00:00.000Z');
  beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers().setSystemTime(fixedNow); });
  afterEach(() => { jest.useRealTimers(); });

  const armedReminder = (overrides = {}) => ({
    id: 'reminder-hold', scheduled_service_id: 'svc-hold', customer_id: 'customer-1',
    appointment_time: new Date('2026-05-07T13:00:00.000Z'), created_at: new Date('2026-05-01T13:45:00.000Z'),
    service_type: 'Pest Control', cancelled: false, confirmation_sent: true, reminder_72h_sent: true, reminder_24h_sent: false,
    ...overrides,
  });

  const run = async ({ svcRow, holdRow }) => {
    const reminderList = chain({ select: jest.fn().mockResolvedValue([armedReminder()]) });
    const stranded = chain({ select: jest.fn().mockResolvedValue([]) });
    const mustNotUpdate = chain();
    const reminderQueries = [stranded, reminderList, mustNotUpdate];
    const svcQuery = chain({ first: jest.fn().mockResolvedValue(svcRow) });
    const holdQuery = chain({ first: jest.fn().mockResolvedValue(holdRow) });
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'scheduled_services') return svcQuery;
      if (table === 'scheduled_services as ss') return holdQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });
    const result = await AppointmentReminders.checkAndSendReminders();
    return { result, mustNotUpdate, holdQuery, svcQuery };
  };

  test('an unconfirmed street-level hold is skipped even though its reminder row is armed: nothing sent, row left armed', async () => {
    const { result, mustNotUpdate, holdQuery } = await run({
      svcRow: { status: 'pending', visit_id: null, customer_confirmed: false, source_action: 'voice_agent' },
      holdRow: { id: 'svc-hold' },
    });
    expect(holdQuery.where).toHaveBeenCalledWith('ss.id', 'svc-hold');
    expect(result.sent24h).toBe(0);
    expect(result.skipped).toBe(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(mustNotUpdate.update).not.toHaveBeenCalled();
  });

  test('a voice-agent pending row that is NOT a street-level hold is not held (the lookup finds no card)', async () => {
    await expect(isStreetLevelHoldVisit('svc-plain', () => chain({ first: jest.fn().mockResolvedValue(undefined) }))).resolves.toBe(false);
  });

  test('other rows never even run the lookup (confirmed, or not a voice_agent-source row)', async () => {
    for (const svcRow of [
      { status: 'terminal-check', visit_id: null, customer_confirmed: true, source_action: 'voice_agent' },
      { status: 'terminal-check', visit_id: null, customer_confirmed: false, source_action: 'ai_call_pipeline' },
    ]) {
      const { holdQuery } = await run({ svcRow: { ...svcRow, status: 'cancelled' }, holdRow: { id: 'x' } });
      expect(holdQuery.where).not.toHaveBeenCalled();
    }
  });

  test('a lookup failure holds the reminder (fail closed)', async () => {
    await expect(isStreetLevelHoldVisit('svc-hold', () => { throw new Error('db down'); })).resolves.toBe(true);
  });
});

describe('the office confirm arms the reminders', () => {
  test('runOutboundReviewConfirmHook registers the visit reminder (no booking-confirmation text), after which the hold predicate no longer applies', () => {
    const src = fs.readFileSync(require.resolve('../services/outbound-review-confirm.js'), 'utf8');
    expect(src).toContain('AppointmentReminders.registerAppointment(');
    expect(src).toContain('sendConfirmation: false');
    // The hold lasts only while customer_confirmed is false; the hook's stamp releases it.
    expect(src).toContain('.update({ customer_confirmed: true, confirmed_at: stampedAt })');   // the guarded stamp (stampCustomerConfirmed)
  });
});
