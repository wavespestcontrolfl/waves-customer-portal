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
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
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
const AppointmentEmail = require('../services/appointment-email');
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
function installDb({ rows, visitIdByService = {}, holdUntil = null, prefsRow = {} }) {
  const state = { reminderUpdates: [], arChains: [], ssChains: [] };
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
      // move-hold checks + flag updates. A function-valued holdUntil is
      // read per check, so a test can raise the hold mid-flight (after
      // the SMS handoff, before the email fallback's own recheck).
      const hold = typeof holdUntil === 'function' ? holdUntil() : holdUntil;
      const c = genericChain(hold ? { move_hold_until: hold } : null);
      const holdRead = c.first.getMockImplementation();
      c.first.mockImplementation((...cols) => cols.length === 1 && cols[0] === 'id'
        ? rows.find((row) => row.id === c._where[0]?.[0]?.id) || null
        : holdRead(...cols));
      return c;
    }
    if (table === 'appointment_reminders as ar') {
      // Reminder-row-sourced scans (closeVisitTierRows' member close; the
      // legacy exact-slot label merge): a member with NO reminder row
      // (appointment_time null) is invisible here, as in the real table.
      const c = genericChain();
      c.select = jest.fn(async () => (state.visitMemberRows || []).filter((r) => r.appointment_time != null));
      state.arChains.push(c);
      return c;
    }
    if (table === 'scheduled_services as ss') {
      // visitReminderCopyInputs' member scan (scheduled_services-driven,
      // reminder row optional) — chains recorded so the predicates can be
      // asserted.
      const c = genericChain();
      c.select = jest.fn().mockResolvedValue(state.visitMemberRows || []);
      state.ssChains.push(c);
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
      return genericChain({ sms_enabled: true, service_reminder_24h: true, service_reminder_72h: true, ...prefsRow });
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
    // After the send the owner closes EVERY member row of the occurrence
    // (both visitMemberRows — GH codex r6 P2: an armed sibling split off
    // before its own iteration would otherwise resend), then its own flag;
    // the covered loser still runs its own guarded close.
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(4);
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

  test('retryable provider failure on the grouped send, no fallback delivery: claim released as retryable, row unmarked — never suppressed (GH codex r6 P1)', async () => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT } });
    // Twilio 5xx-shaped outcome; the customer has no email on file, so the
    // fallback email cannot deliver either.
    sendCustomerMessage.mockResolvedValue({ sent: false, retryable: true, code: 'PROVIDER_ERROR' });
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'missing_email' });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.sent24h).toBe(0);
    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledTimes(1);
    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledWith(
      VISIT, 'reminder_24h', 'retry', expect.any(Date), 'tok-1',
      { dedupeKey: `${VISIT}:reminder_24h:2026-05-07` },
    );
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(0);
  });

  test('deterministic non-delivery (not retryable) still finalizes suppressed and closes the row', async () => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT } });
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'OPTED_OUT' });
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'missing_email' });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });

    await AppointmentReminders.checkAndSendReminders();

    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledWith(
      VISIT, 'reminder_24h', 'suppressed', expect.any(Date), 'tok-1',
      { dedupeKey: `${VISIT}:reminder_24h:2026-05-07` },
    );
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(1);
  });

  test('a live sibling with NO reminder row still sets the earliest arrival + its hold line (GH codex r8 P1)', async () => {
    // svc-2 has no appointment_reminders row (registration failed / self-heal
    // backlog); its time composes from scheduled_date + window_start and it
    // is EARLIER than the owner.
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT } });
    state.visitMemberRows = [
      { scheduled_service_id: 'svc-1', scheduled_date: '2026-05-07', window_start: '09:00:00', appointment_time: new Date('2026-05-07T13:00:00.000Z'), label: 'Quarterly Pest Control' },
      { scheduled_service_id: 'svc-2', scheduled_date: '2026-05-07', window_start: '08:00:00', appointment_time: null, label: 'Mosquito Treatment' },
    ];
    const { cardHoldReminderLine } = require('../services/estimate-card-holds');
    cardHoldReminderLine.mockImplementation(async (id) => (id === 'svc-2' ? 'Unregistered sibling hold clause.' : ''));
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });

    await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith(
      'reminder_24h',
      // The label lists the unregistered sibling too (pre-push codex r8 P1:
      // the grouped label is sourced from visit membership, not reminder rows).
      expect.objectContaining({ time: '8:00 AM', card_hold_policy_line: 'Unregistered sibling hold clause.', service_type: 'Quarterly Pest Control & Mosquito Treatment' }),
      expect.anything(),
    );
    cardHoldReminderLine.mockImplementation(async () => '');
  });

  test("'both' channel, SMS held at the quiet-hours boundary AFTER the email leg went out: the email is sent under the VISIT-scoped key so a sibling's retry dedupes (GH codex r7 P1)", async () => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT }, prefsRow: { service_reminder_24h_channel: 'both', email_enabled: true } });
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD' });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(result.sent24h).toBe(0);
    // Email leg went out now, keyed by visit + tier + occurrence — NOT the
    // owner's scheduled_service_id.
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledWith(expect.objectContaining({
      kind: '24h',
      scheduledServiceId: 'svc-1',
      idempotencyKey: `appointment.reminder_24h:visit:${VISIT}:reminder_24h:2026-05-07`,
    }));
    // SMS leg deferred: claim released as retryable, row unmarked.
    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledWith(
      VISIT, 'reminder_24h', 'retry', expect.any(Date), 'tok-1',
      { dedupeKey: `${VISIT}:reminder_24h:2026-05-07` },
    );
    expect(flagUpdates(state, 'reminder_24h_sent')).toHaveLength(0);
  });

  test('ungrouped row keeps the per-service email key (no visit override)', async () => {
    installDb({ rows: [reminderRow()], prefsRow: { service_reminder_24h_channel: 'both', email_enabled: true } });

    await AppointmentReminders.checkAndSendReminders();

    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail.mock.calls[0][0].idempotencyKey).toBeUndefined();
  });

  test('grouped copy inputs read SENDABLE members only: a pending-rebook sibling cannot set the advertised arrival (GH codex r5 P1)', async () => {
    const state = installDb({ rows: [reminderRow()], visitIdByService: { 'svc-1': VISIT } });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });

    await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // The member scan joins scheduled_services and filters to the same
    // sendable statuses buildMergedServiceLabel uses — a 'rescheduled'
    // placeholder that kept its visit_id is excluded from the earliest-
    // arrival pick, not just from the label.
    const memberScan = state.ssChains.find((c) => c.whereIn.mock.calls.some(([col]) => col === 'ss.status'));
    expect(memberScan).toBeDefined();
    // Membership comes from scheduled_services; the reminder row is a
    // LEFT join (GH codex r8 P1 — a live sibling with no reminder row
    // still shapes the grouped copy).
    expect(memberScan.leftJoin).toHaveBeenCalledWith('appointment_reminders as ar', expect.any(Function));
    expect(memberScan.whereIn).toHaveBeenCalledWith('ss.status', ['pending', 'confirmed', 'en_route', 'on_site']);
    expect(memberScan.whereNotNull).toHaveBeenCalledWith('ss.window_start');
  });

  test('SMS failed, fallback email HELD by a move at its handoff: claim released as retryable, row unmarked — never suppressed (GH codex r5 P1)', async () => {
    // The hold appears only AFTER the SMS provider handoff: the entry and
    // pre-dispatch checks pass, the text fails, and the email fallback's
    // own handoff recheck sees the in-progress move.
    const state = installDb({
      rows: [reminderRow()],
      visitIdByService: { 'svc-1': VISIT },
      holdUntil: () => (sendCustomerMessage.mock.calls.length > 0 ? new Date(fixedNow.getTime() + 3600000) : null),
    });
    sendCustomerMessage.mockResolvedValue({ sent: false, code: 'PROVIDER_ERROR', retryable: true });
    VisitGroups.claimVisitNotification.mockResolvedValue({ state: 'owner', token: 'tok-1', dedupeKey: `${VISIT}:reminder_24h:2026-05-07` });

    const result = await AppointmentReminders.checkAndSendReminders();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.sent24h).toBe(0);
    expect(VisitGroups.finalizeVisitNotification).toHaveBeenCalledTimes(1);
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

describe('round-3 wiring pins (source contracts)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/appointment-reminders'), 'utf8');

  test('the SMS-fallback email carries the aggregated grouped hold note', () => {
    expect(src).toContain("async function deliverAppointmentEmailFallback({ kind, customerId, scheduledServiceId = null, apptTime = null, serviceLabel = 'service', cardHoldNote = null, smsOutcome = null, emailIdempotencyKey = null })");
    expect(src).toContain('sendAppointmentNoticeEmail({ kind, customerId, scheduledServiceId, apptTime, serviceLabel, cardHoldNote, emailIdempotencyKey })');
  });

  test('the night-email leg rechecks the grouped date before sending', () => {
    expect(src).toMatch(/if \(nightCopy && etDateString\(nightCopy\.apptTime\) !== tomorrowET\) \{[\s\S]{0,400}finalizeVisitNotification\(svcVisitId, 'reminder_24h', 'retry'/);
  });
});
