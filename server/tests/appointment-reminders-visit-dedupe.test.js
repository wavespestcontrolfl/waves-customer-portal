/**
 * Grouped-visit reminder dedupe (spec §4: 72h/24h fire ONCE PER VISIT via
 * visit_effects(reminder_72h/24h)). The claim machinery itself is covered
 * by visit-groups-core/live-fanout; here the CRON WIRING is pinned against
 * a mocked visit-groups module:
 *   - owner sends, finalizes sent with its token+key, closes its row
 *   - taken closes its own row only, no send
 *   - in_flight / error: no send, row left unmarked (next tick re-decides)
 *   - detached: per-row send proceeds (over-notify, never silence)
 *   - visit_id NULL: the claim is never consulted at all (byte-identical
 *     ungrouped path, gate on or off)
 *   - MOVE_HOLD at the provider handoff: claim released as retryable
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
  cardHoldReminderNote: jest.fn(async () => ''),
}));
jest.mock('../services/visit-groups', () => ({
  claimVisitNotification: jest.fn(),
  finalizeVisitNotification: jest.fn(async () => ({ ok: true })),
  renewNotificationLease: jest.fn(async () => true),
  notificationLeaseLive: jest.fn(async () => true),
  windowedMembersConnected: jest.fn(() => true),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const VisitGroups = require('../services/visit-groups');
const AppointmentReminders = require('../services/appointment-reminders');

const fixedNow = new Date('2026-05-06T14:00:00.000Z'); // 10:00 AM ET
const VISIT = 'visit-1';

function reminderRow(overrides = {}) {
  return {
    id: 'rem-1',
    scheduled_service_id: 'svc-1',
    customer_id: 'customer-1',
    appointment_time: new Date('2026-05-07T13:00:00.000Z'), // 9:00 AM ET tomorrow → 24h band
    created_at: new Date('2026-05-01T13:00:00.000Z'),
    service_type: 'Quarterly Pest Control',
    cancelled: false,
    confirmation_sent: true,
    reminder_72h_sent: true,
    reminder_24h_sent: false,
    ...overrides,
  };
}

/**
 * Table-dispatching db mock. appointment_reminders serves, in order: the
 * stranded-confirmation sweep ([]), the reminder list, then generic chains
 * whose `first` resolves null (move-hold check) and whose updates are
 * recorded into `state.reminderUpdates` with the preceding where args.
 */
function installDb({ rows, visitIdByService = {}, holdUntil = null }) {
  const state = { reminderUpdates: [] };
  let arCalls = 0;
  const genericChain = (firstValue = null) => {
    const c = {
      _where: [],
      where: jest.fn(function w(...a) { c._where.push(a); return c; }),
      andWhere: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      whereExists: jest.fn().mockReturnThis(),
      whereNotExists: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      join: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      modify: jest.fn((fn) => { fn(c); return c; }),
      whereRaw: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([]),
      pluck: jest.fn().mockResolvedValue([]),
      first: jest.fn().mockResolvedValue(firstValue),
      update: jest.fn((patch) => { state.reminderUpdates.push({ where: c._where, patch }); return Promise.resolve(1); }),
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
    };
    return c;
  };
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') {
      arCalls += 1;
      if (arCalls === 1) return genericChain(); // stranded sweep (select → [])
      if (arCalls === 2) { const c = genericChain(); c.select = jest.fn().mockResolvedValue(rows); return c; }
      // move-hold checks + flag updates
      return genericChain(holdUntil ? { move_hold_until: holdUntil } : null);
    }
    if (table === 'appointment_reminders as ar') {
      // closeVisitTierRows' member-row scan (durable sent-state fallback).
      const c = genericChain();
      c.select = jest.fn().mockResolvedValue(state.visitMemberRows || []);
      return c;
    }
    if (String(table).startsWith('scheduled_services')) {
      const c = genericChain();
      c.first = jest.fn(async (...cols) => {
        // The live-status guard read; also serves getCustomerAndTech's tech
        // lookup shape harmlessly.
        const svcId = (c._where[0] && c._where[0][0] && c._where[0][0].id) || null;
        return { status: 'confirmed', visit_id: visitIdByService[svcId] ?? null, tech_name: 'Sam' };
      });
      return c;
    }
    if (table === 'notification_prefs') {
      return genericChain({ sms_enabled: true, service_reminder_24h: true, service_reminder_72h: true });
    }
    if (String(table).startsWith('customers')) {
      return genericChain({ id: 'customer-1', first_name: 'Ada', phone: '+19415551212' });
    }
    return genericChain();
  });
  db.raw = jest.fn().mockResolvedValue();
  db.transaction = jest.fn(async (cb) => cb(db));
  return state;
}

const flagUpdates = (state, key) => state.reminderUpdates.filter((u) => u.patch && u.patch[key]);

describe('grouped-visit reminder dedupe (24h tier wiring)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(fixedNow);
    smsTemplatesRouter.getTemplate.mockResolvedValue('24-hour appointment reminder');
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });
  afterEach(() => jest.useRealTimers());

  test('two grouped members, different rows: exactly ONE send with the EARLIEST window + every member\'s hold line; loser closes its own row', async () => {
    // The LATER member (10:00 AM ET) wins the claim — the notice must
    // still advertise the stop's earliest arrival (9:00 AM ET) and carry
    // both members' card-hold disclosures (GH codex r1, two P1s).
    const rows = [
      reminderRow({ id: 'rem-1', scheduled_service_id: 'svc-1' }), // 9:00 AM ET
      reminderRow({ id: 'rem-2', scheduled_service_id: 'svc-2', appointment_time: new Date('2026-05-07T14:00:00.000Z') }), // 10:00 AM ET
    ];
    const state = installDb({ rows, visitIdByService: { 'svc-1': VISIT, 'svc-2': VISIT } });
    state.visitMemberRows = [
      { appointment_time: new Date('2026-05-07T13:00:00.000Z'), scheduled_service_id: 'svc-1' },
      { appointment_time: new Date('2026-05-07T14:00:00.000Z'), scheduled_service_id: 'svc-2' },
    ];
    const { cardHoldReminderLine } = require('../services/estimate-card-holds');
    cardHoldReminderLine.mockImplementation(async (id) => (id === 'svc-1' ? 'Held booking fee clause.' : ''));
    VisitGroups.claimVisitNotification
      .mockResolvedValueOnce({ state: 'taken', token: null, dedupeKey: `${VISIT}:reminder_24h:2026-05-07` })
      .mockResolvedValueOnce({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.sent24h).toBe(1);
    expect(result.skipped).toBe(1);
    expect(VisitGroups.claimVisitNotification).toHaveBeenCalledTimes(2);
    expect(VisitGroups.claimVisitNotification).toHaveBeenCalledWith({ id: 'svc-2', visit_id: VISIT }, 'reminder_24h');
    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledTimes(1);
    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledWith(
      VISIT, 'reminder_24h', 'sent', expect.any(Date), 'tok-1',
      { dedupeKey: `${VISIT}:reminder_24h:2026-05-07` },
    );
    // The rendered copy carries the EARLIEST member's time and the held
    // sibling's fee clause even though svc-2 owned the send.
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith(
      'reminder_24h',
      expect.objectContaining({ time: '9:00 AM', card_hold_policy_line: 'Held booking fee clause.' }),
      expect.anything(),
    );
    expect(cardHoldReminderLine).toHaveBeenCalledWith('svc-1');
    expect(cardHoldReminderLine).toHaveBeenCalledWith('svc-2');
    // Both rows closed their own 24h flag (owner post-send, loser covered).
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(2);
    cardHoldReminderLine.mockImplementation(async () => '');
  });

  test('ungrouped row (visit_id null): the claim is never consulted — byte-identical per-row path', async () => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': null } });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(VisitGroups.claimVisitNotification).not.toHaveBeenCalled();
    expect(VisitGroups.finalizeVisitNotification).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.sent24h).toBe(1);
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(1);
  });

  test.each(['in_flight', 'error'])('%s claim: no send, row left unmarked (next tick re-decides)', async (claimState) => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT } });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: claimState, token: null, dedupeKey: null });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(result.sent24h).toBe(0);
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(0);
  });

  test('detached claim: per-row send proceeds (over-notify, never silence) with no visit finalize', async () => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT } });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'detached', token: null, dedupeKey: null });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.sent24h).toBe(1);
    expect(VisitGroups.finalizeVisitNotification).not.toHaveBeenCalled();
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(1);
  });

  test('lease lost before the provider handoff: no send, row left unmarked', async () => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT } });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });
    VisitGroups.renewNotificationLease.mockResolvedValueOnce(false);

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(VisitGroups.renewNotificationLease).toHaveBeenCalledWith(
      VISIT, 'reminder_24h', 'tok-1', { dedupeKey: `${VISIT}:reminder_24h:2026-05-07` },
    );
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(result.sent24h).toBe(0);
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(0);
    expect(VisitGroups.finalizeVisitNotification).not.toHaveBeenCalled();
  });

  test('finalize failure AFTER a real send: every member row is closed as the durable sent state', async () => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT } });
    state.visitMemberRows = [{ id: 'rem-sibling', appointment_time: new Date('2026-05-07T14:00:00.000Z') }];
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });
    VisitGroups.finalizeVisitNotification.mockResolvedValueOnce({ ok: false, reason: 'effect finalize failed' });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.sent24h).toBe(1);
    // Sibling row closed by the fallback + owner's own flag close.
    const closes = flagUpdates(state, 'reminder_24h_sent');
    expect(closes).toHaveLength(2);
  });

  test('MOVE_HOLD at the provider handoff: owner releases the claim as retryable, row unmarked', async () => {
    // moveHoldActive sees an active hold → deliverAppointmentNotice blocks
    // with MOVE_HOLD → the boundary-hold branch finalizes 'retry'.
    const state = installDb({
      rows: [reminderRow()],
      visitIdByService: { 'svc-1': VISIT },
      holdUntil: new Date(fixedNow.getTime() + 3600000),
    });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(result.sent24h).toBe(0);
    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledWith(
      VISIT, 'reminder_24h', 'retry', expect.any(Date), 'tok-1',
      { dedupeKey: `${VISIT}:reminder_24h:2026-05-07` },
    );
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(0);
  });
});

describe('grouped-visit reminder dedupe (72h tier wiring)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(fixedNow);
    smsTemplatesRouter.getTemplate.mockResolvedValue('72-hour appointment reminder');
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });
  afterEach(() => jest.useRealTimers());

  const row72 = () => reminderRow({
    appointment_time: new Date('2026-05-08T13:00:00.000Z'), // 47h out → inside the 72h band (24.25, 72.25]
    reminder_72h_sent: false,
    reminder_24h_sent: false,
  });

  test('owner sends once and finalizes with its token + date-bearing key; sibling is covered', async () => {
    const rows = [
      row72(),
      { ...row72(), id: 'rem-2', scheduled_service_id: 'svc-2' },
    ];
    const state = installDb({ rows, visitIdByService: { 'svc-1': VISIT, 'svc-2': VISIT } });
    VisitGroups.claimVisitNotification
      .mockResolvedValueOnce({ state: 'owner', token: 'tok-9', dedupeKey: `${VISIT}:reminder_72h:2026-05-08` })
      .mockResolvedValueOnce({ state: 'taken', token: null, dedupeKey: `${VISIT}:reminder_72h:2026-05-08` });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.sent72h).toBe(1);
    expect(result.skipped).toBe(1);
    expect(VisitGroups.claimVisitNotification).toHaveBeenCalledWith({ id: 'svc-1', visit_id: VISIT }, 'reminder_72h');
    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledWith(
      VISIT, 'reminder_72h', 'sent', expect.any(Date), 'tok-9',
      { dedupeKey: `${VISIT}:reminder_72h:2026-05-08` },
    );
    expect(flagUpdates(state, 'reminder_72h_sent')).toHaveLength(2);
  });
});
