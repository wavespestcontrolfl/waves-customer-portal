/**
 * Quick Move "let the customer pick a day" (GATE_QUICKMOVE_CUSTOMER_PICK, owner
 * 2026-11-01): RainOut.handOffToCustomer and RainOut.customerPickOffer.
 *
 * The real rain-out, template renderer (getTemplate on the template snapshot),
 * plan-taken-hour hand-off fields and rebooker stamps run here. The database is
 * a recording fake; the link builder, the text verdict validators, the send and
 * Auto-Dispatch's fallback switch are stubs. The transaction's real writes are
 * exercised against PostgreSQL in rain-out-customer-pick-postgres.test.js.
 *
 * The clock is pinned to Tuesday 2026-11-03 09:00 ET (Date only; timers stay
 * real), so today is 2026-11-03, the due date 2026-11-11 and the pick-by
 * deadline Wednesday 8 PM ET.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/rebooker', () => {
  const actual = jest.requireActual('../services/rebooker');
  return {
    findRescheduleOptions: jest.fn().mockResolvedValue([]),
    reschedule: jest.fn(),
    rescheduleSeries: jest.fn(),
    LIVE_LIFECYCLE_RESET: actual.LIVE_LIFECYCLE_RESET,
    needsLifecycleRewind: actual.needsLifecycleRewind,
    dateExceptionStamp: actual.dateExceptionStamp,
    applyLiveMoveHistory: jest.fn(actual.applyLiveMoveHistory),
    applyLiveMovePostCommitEffects: jest.fn().mockResolvedValue({ techCleared: true }),
  };
});
jest.mock('../services/appointment-reminders', () => ({
  precloseWindowlessReminderInTx: jest.fn().mockResolvedValue(1),
  smsServiceLabelStored: jest.requireActual('../services/appointment-reminders').smsServiceLabelStored,
}));
jest.mock('../services/not-closed-out', () => ({ resolveForService: jest.fn().mockResolvedValue({ resolved: 0 }) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyVisitRescheduled: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
  normalizeRecipient: (phone) => phone,
}));
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(),
  checkConsentForPurpose: jest.fn(),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(),
  checkSuppression: jest.fn(),
}));
jest.mock('../services/reschedule-link', () => ({ buildRescheduleLink: jest.fn() }));
jest.mock('../services/auto-dispatch/config', () => ({ isCustomerRecurringDispatchEnabled: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlook: jest.fn().mockResolvedValue(null),
  getHourlyRainOutlook: jest.fn().mockResolvedValue(null),
  forecastLinkForZip: jest.fn(() => null),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const AppointmentReminders = require('../services/appointment-reminders');
const { resolveForService } = require('../services/not-closed-out');
const { notifyVisitRescheduled } = require('../services/tech-visit-notifications');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const consent = require('../services/messaging/validators/consent');
const suppression = require('../services/messaging/validators/suppression');
const { buildRescheduleLink } = require('../services/reschedule-link');
const { isCustomerRecurringDispatchEnabled } = require('../services/auto-dispatch/config');
const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');
const { REQUIRED_TEMPLATE_PLACEHOLDERS } = require('../routes/admin-sms-templates');
const { BODY } = require('../models/migrations/20261101164500_rain_out_customer_pick')._test;
const RainOut = require('../services/rain-out');

const NOW = new Date('2026-11-03T14:00:00Z'); // Tue 9:00 AM EST
const TODAY = '2026-11-03';
const DUE = '2026-11-11';
const PICK_BY = new Date('2026-11-05T01:00:00Z'); // Wed 2026-11-04 8:00 PM EST
const LINK = 'https://portal.wavespestcontrol.com/l/k3j9m2x7qp';
const SID = `SM${'a'.repeat(32)}`;
const REFERENCE_TEXT = "Hi Maria - rain is moving through your area this morning, so we need to move your Quarterly Pest Control Service. Pick a new time here: portal.wavespestcontrol.com/l/k3j9m2x7qp\n\nPlease pick by Wed 8 PM. If we don't hear back, we'll book the best open time and text you. Questions? Reply here.";

// The visit columns (what the locked read returns) and the joined customer columns.
const VISIT = {
  id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'pending',
  scheduled_date: TODAY, window_start: '09:00:00', window_end: '10:00:00',
  is_recurring: true, recurring_parent_id: 'plan-1', visit_id: null, source_action: null,
  customer_confirmed: true, service_type: 'Quarterly Pest Control Service', service_id: 'catalog-1', property_id: 'prop-1',
  track_state: 'scheduled', en_route_at: null, arrived_at: null, actual_start_time: null, check_in_time: null,
  track_sms_sent_at: null, arrival_sms_sent_at: null, date_exception: false, date_exception_cadence_date: null,
};
const CUSTOMER = {
  first_name: 'Maria', phone: '+19415550100', zip: '34202', cust_id: 'cust-1',
  customer_active: true, customer_deleted_at: null,
};

// Recording fake: reads come from `state`, every write is kept in order.
let state;
function builder(table, inTrx) {
  const b = {
    where() { return b; }, leftJoin() { return b; }, select() { return b; }, forUpdate() { return b; },
    whereIn() { return b; }, whereNull() { return b; }, orderBy() { return b; },
    async first() {
      state.reads.push(`${inTrx ? 'trx:' : ''}${table}`);
      if (table === 'scheduled_services') {
        const row = inTrx ? state.locked : state.service;
        return row ? { ...row } : undefined;
      }
      if (table === 'sms_templates') {
        if (state.templateError) throw state.templateError;
        return state.template ? { ...state.template } : undefined;
      }
      return undefined;
    },
    async update(patch) { state.writes.push({ op: 'update', table, patch }); return 1; },
    async insert(row) { state.writes.push({ op: 'insert', table, row }); return [1]; },
  };
  return b;
}

beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'],
  });
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_QUICKMOVE_CUSTOMER_PICK = 'true';
  delete process.env.GATE_QUICKMOVE_EXTRA_REASONS;
  state = {
    service: { ...VISIT, ...CUSTOMER },
    locked: { ...VISIT },
    template: { body: BODY, is_active: true },
    templateError: null,
    reads: [],
    writes: [],
  };
  db.mockImplementation((table) => builder(table, false));
  db.transaction = jest.fn(async (run) => {
    const trx = (table) => builder(table, true);
    trx.raw = jest.fn(() => 'TRACK_EXPIRY_SQL');
    return run(trx);
  });
  db.schema = { hasTable: jest.fn(async () => true) };
  db.raw = jest.fn();
  db.fn = { now: () => 'NOW()' };
  isCustomerRecurringDispatchEnabled.mockReturnValue(true);
  consent.loadContactState.mockResolvedValue({ prefs: null, customer: { id: 'cust-1' }, lookupFailed: false });
  consent.checkConsentForPurpose.mockResolvedValue({ ok: true });
  suppression.loadSuppressionState.mockImplementation(async (_input, contactState) => ({ ...contactState, suppressionLoaded: true }));
  suppression.checkSuppression.mockResolvedValue({ ok: true });
  buildRescheduleLink.mockResolvedValue({ url: LINK, line: '' });
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: SID });
});
afterEach(() => {
  delete process.env.GATE_QUICKMOVE_CUSTOMER_PICK;
  delete process.env.GATE_QUICKMOVE_EXTRA_REASONS;
});

const handOff = (overrides = {}) => RainOut.handOffToCustomer({
  serviceId: 'svc-1', reasonCode: 'weather_rain', initiatedBy: 'tech', actorUserId: 'tech-1',
  requireAssignedTechnicianId: 'tech-1', operatorInitiated: true, ...overrides,
});
const writes = (table) => state.writes.filter((w) => w.table === table);
const sentBody = () => sendCustomerMessage.mock.calls[0][0].body;
// The hand-off's own writes: the visit, its log rows and its reminder. (A
// template defect still files its audit_log row, as for every render.)
function expectNothingWritten() {
  expect(state.writes.filter((w) => w.table !== 'audit_log')).toEqual([]);
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AppointmentReminders.precloseWindowlessReminderInTx).not.toHaveBeenCalled();
  expect(resolveForService).not.toHaveBeenCalled();
}

describe('rain_out_customer_pick_v1 template', () => {
  test('the seeded body is GSM-7 and carries every placeholder the flow requires', () => {
    expect(detectEncoding(BODY).encoding).toBe('GSM_7');
    const placeholders = [...BODY.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
    expect(placeholders).toEqual(['first_name', 'reason_lead', 'service_type', 'pick_url', 'pick_by']);
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS.rain_out_customer_pick_v1).toEqual(['pick_url', 'pick_by']);
  });

  test('the reference render is the exact text sent: 292 characters, GSM-7, 2 segments', async () => {
    const r = await handOff();
    expect(r.ok).toBe(true);
    expect(sentBody()).toBe(REFERENCE_TEXT);
    expect(REFERENCE_TEXT).toHaveLength(292);
    expect(countSegments(REFERENCE_TEXT)).toEqual(expect.objectContaining({ encoding: 'GSM_7', segmentCount: 2 }));
  });

  test('the deadline label and dates come from the ET calendar', () => {
    const { pickDates, pickByLabel } = RainOut._test;
    expect(pickDates(NOW)).toEqual({ dueDate: DUE, pickBy: PICK_BY });
    expect(pickByLabel(PICK_BY)).toBe('Wed 8 PM');
    // 11:30 PM ET on Sunday is still Sunday in ET (UTC is already Monday).
    const lateSunday = new Date('2026-11-09T04:30:00Z');
    expect(pickDates(lateSunday)).toEqual({ dueDate: '2026-11-16', pickBy: new Date('2026-11-10T01:00:00Z') });
    expect(pickByLabel(pickDates(lateSunday).pickBy)).toBe('Mon 8 PM');
  });
});

describe('handOffToCustomer refusals write nothing', () => {
  test('gate off: disabled, before any read', async () => {
    delete process.env.GATE_QUICKMOVE_CUSTOMER_PICK;
    expect(await handOff()).toEqual({ ok: false, reason: 'disabled' });
    expect(db).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  test.each([
    ['custom (the dispatcher-typed reason)', 'custom'],
    ['an unknown code', 'weather_snow'],
    ['an extra reason while its gate is off', 'running_late'],
  ])('bad_reason for %s', async (_label, reasonCode) => {
    expect(await handOff({ reasonCode })).toEqual({ ok: false, reason: 'bad_reason' });
    expectNothingWritten();
  });

  test('not_found when the visit is gone', async () => {
    state.service = null;
    expect(await handOff()).toEqual({ ok: false, reason: 'not_found' });
    expectNothingWritten();
  });

  test.each([
    ['a one-time visit', { is_recurring: false }, 'not_recurring_plan_visit'],
    ['a plan template row', { recurring_parent_id: null }, 'not_recurring_plan_visit'],
    ['a grouped stop', { visit_id: 'visit-9' }, 'grouped_stop'],
    ['an on-site visit', { status: 'on_site' }, 'status_not_eligible'],
    ['a completed visit', { status: 'completed' }, 'status_not_eligible'],
    ['a visit already moved to a later day', { scheduled_date: '2026-11-04' }, 'future_scheduled_date'],
    ['an inactive customer', { customer_active: false }, 'customer_inactive'],
    ['an archived customer', { customer_deleted_at: new Date('2026-10-01T00:00:00Z') }, 'customer_inactive'],
    ['a visit with no customer row', { customer_active: null }, 'customer_inactive'],
    ['a customer with no phone', { phone: null }, 'no_phone'],
    ['an unreviewed voice-agent booking', { source_action: 'voice_agent' }, 'office_review_pending'],
  ])('%s: %s', async (_label, patch, reason) => {
    state.service = { ...state.service, ...patch };
    expect(await handOff()).toEqual({ ok: false, reason });
    expectNothingWritten();
  });

  test("Auto-Dispatch's customer fallback off: auto_dispatch_off", async () => {
    isCustomerRecurringDispatchEnabled.mockReturnValue(false);
    expect(await handOff()).toEqual({ ok: false, reason: 'auto_dispatch_off' });
    expectNothingWritten();
  });

  test('the text verdict is the canonical send\'s, asked for this phone, visit and purpose', async () => {
    await handOff();
    const input = consent.loadContactState.mock.calls[0][0];
    expect(input).toEqual({
      to: '+19415550100', channel: 'sms', audience: 'customer', purpose: 'appointment', customerId: 'cust-1', appointmentId: 'svc-1',
    });
    expect(suppression.checkSuppression).toHaveBeenCalledWith(input, expect.objectContaining({}), expect.objectContaining({ suppressionLoaded: true }));
    expect(consent.checkConsentForPurpose).toHaveBeenCalledWith(input, expect.objectContaining({}), expect.objectContaining({ suppressionLoaded: true }));
  });

  test.each([
    ['a STOP / non-mobile suppression', () => suppression.checkSuppression.mockResolvedValue({ ok: false, code: 'SUPPRESSED' }), 'customer_texts_off'],
    ['texts turned off for appointments', () => consent.checkConsentForPurpose.mockResolvedValue({ ok: false, code: 'PURPOSE_DISABLED' }), 'customer_texts_off'],
    ['an unreadable consent record', () => consent.loadContactState.mockResolvedValue({ prefs: null, customer: null, lookupFailed: true }), 'text_check_failed'],
    ['an unreadable suppression list', () => suppression.loadSuppressionState.mockImplementation(async (_i, s) => ({ ...s, suppressionLookupFailed: true })), 'text_check_failed'],
    ['a consent lookup failure verdict', () => consent.checkConsentForPurpose.mockResolvedValue({ ok: false, code: 'CONSENT_LOOKUP_FAILED' }), 'text_check_failed'],
  ])('%s: %s', async (_label, arrange, reason) => {
    arrange();
    expect(await handOff()).toEqual({ ok: false, reason });
    expectNothingWritten();
  });

  test.each([
    ['absent', null],
    ['disabled (the ops kill switch)', { body: BODY, is_active: false }],
  ])('template row %s: pick_template_unavailable', async (_label, template) => {
    state.template = template;
    expect(await handOff()).toEqual({ ok: false, reason: 'pick_template_unavailable' });
    expectNothingWritten();
  });

  test('an admin edit that dropped {pick_url}: pick_text_unavailable (and the template defect is audited)', async () => {
    state.template = { body: BODY.replace('{pick_url}', 'our website'), is_active: true };
    expect(await handOff()).toEqual({ ok: false, reason: 'pick_text_unavailable' });
    await new Promise((resolve) => { setImmediate(resolve); }); // the audit write is not awaited by the renderer
    expectNothingWritten();
    expect(writes('audit_log').map((w) => w.row.metadata.event_type)).toEqual(['missing_required_placeholder']);
  });

  test('the link is measured read-only on the row before the write (never minted)', async () => {
    await handOff();
    expect(buildRescheduleLink.mock.calls[0]).toEqual(['svc-1', {
      customerId: 'cust-1', reuseExisting: true, previewOnly: true, assumeConfirmed: true,
    }]);
  });

  test.each([
    ['no link for the visit', { url: null, line: '' }, 'no_reschedule_link'],
    ['a failed link read', { url: null, line: '', failed: true }, 'link_unavailable'],
  ])('%s: %s', async (_label, built, reason) => {
    buildRescheduleLink.mockResolvedValueOnce(built);
    expect(await handOff()).toEqual({ ok: false, reason });
    expectNothingWritten();
  });

  test('a read failure refuses: pick_check_failed', async () => {
    state.templateError = new Error('connection reset');
    expect(await handOff()).toEqual({ ok: false, reason: 'pick_check_failed' });
    expectNothingWritten();
  });

  test('a text that cannot fit two segments even without its closing sentence: pick_text_too_long', async () => {
    state.service.service_type = `Quarterly Pest Control Service ${'and Perimeter Barrier Treatment '.repeat(3)}`.trim();
    expect(await handOff()).toEqual({ ok: false, reason: 'pick_text_too_long' });
    expectNothingWritten();
  });

  test.each([
    ['the start moved', { window_start: '13:00:00' }],
    ['the date moved', { scheduled_date: '2026-11-02' }],
    ['dispatch reassigned it', { technician_id: 'tech-2' }],
    ['it went on site', { status: 'on_site' }],
    ['it was grouped into a stop', { visit_id: 'visit-9' }],
    ['it was re-filed to another customer', { customer_id: 'cust-2' }],
  ])('the locked row changed after the checks (%s): state_changed, nothing written or sent', async (_label, patch) => {
    state.locked = { ...state.locked, ...patch };
    expect(await handOff()).toEqual({ ok: false, reason: 'state_changed' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expectNothingWritten();
    expect(notifyVisitRescheduled).not.toHaveBeenCalled();
  });

  test('an admin hand-off pins no technician: a reassignment is not a conflict', async () => {
    state.locked = { ...state.locked, technician_id: 'tech-2' };
    const r = await handOff({ initiatedBy: 'admin', actorUserId: 'admin-1', requireAssignedTechnicianId: null });
    expect(r.ok).toBe(true);
  });
});

describe('handOffToCustomer writes and texts', () => {
  test('a pending visit: the exact columns, the preclose, the log row, the text, and the result the sheets read', async () => {
    const r = await handOff();

    const [update, ...rest] = state.writes;
    expect(update).toEqual({
      op: 'update',
      table: 'scheduled_services',
      patch: {
        window_start: null, window_end: null, time_window: null, window_display: null, route_order: null,
        recurring_dispatch_due_date: DUE,
        scheduled_date: DUE,
        status: 'pending',
        customer_confirmed: false,
        confirmed_at: null,
        customer_pick_by: PICK_BY,
        date_exception: true,
        date_exception_source: 'tech',
        date_exception_at: expect.any(Date),
        date_exception_cadence_date: TODAY,
        track_token_expires_at: 'TRACK_EXPIRY_SQL',
        updated_at: expect.any(Date),
      },
    });
    // The windowless reminder pre-close runs inside the same transaction, after the write.
    expect(AppointmentReminders.precloseWindowlessReminderInTx).toHaveBeenCalledTimes(1);
    expect(AppointmentReminders.precloseWindowlessReminderInTx.mock.calls[0][1]).toBe('svc-1');
    // No status change: no job_status_history row.
    expect(rest).toEqual([{
      op: 'insert',
      table: 'reschedule_log',
      row: {
        scheduled_service_id: 'svc-1', customer_id: 'cust-1', original_date: TODAY, new_date: DUE,
        reason_code: 'customer_pick', initiated_by: 'tech',
        // The pick page reads the bare Quick Move reason from notes.
        notes: 'weather_rain',
        original_window: '09:00:00-10:00:00', new_window: null,
        occurrence_service_type: 'Quarterly Pest Control Service', occurrence_service_id: 'catalog-1', occurrence_property_id: 'prop-1',
      },
    }]);
    expect(resolveForService).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'svc-1', resolution: 'rebooked', resolvedBy: 'tech' }));
    expect(SmartRebooker.applyLiveMovePostCommitEffects).not.toHaveBeenCalled();
    expect(notifyVisitRescheduled).toHaveBeenCalledWith({
      visitId: 'svc-1', technicianId: 'tech-1', actorId: 'tech-1',
      previous: { date: TODAY, windowStart: '09:00:00', windowEnd: '10:00:00' },
      snapshot: { date: DUE, windowStart: null, windowEnd: null },
    });

    // The send link is built on the landed row (no preview, no assumeConfirmed): the dead-link guard applies.
    expect(buildRescheduleLink.mock.calls[1]).toEqual(['svc-1', { customerId: 'cust-1', reuseExisting: true }]);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toEqual({
      to: '+19415550100',
      body: REFERENCE_TEXT,
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment',
      customerId: 'cust-1',
      appointmentId: 'svc-1',
      enforceMoveHold: true,
      identityTrustLevel: 'phone_matches_customer',
      operatorInitiated: true,
      metadata: {
        original_message_type: 'rain_out_customer_pick_v1',
        reason_code: 'weather_rain',
        adminUserId: 'tech-1',
        templateKey: 'rain_out_customer_pick_v1',
      },
    });

    expect(r).toEqual({
      ok: true,
      dueDate: DUE,
      pickBy: PICK_BY.toISOString(),
      pickByLabel: 'Wed 8 PM',
      textSent: true,
      needsAttention: [],
      qualityDates: [TODAY, DUE],
      movedCount: 1, coveredCount: 0, failedCount: 0, overlapCount: 0, overlapWarnings: [],
      results: [{ id: 'svc-1', ok: true, newDate: DUE, newWindow: null, smsSent: true, smsReason: null }],
    });
  });

  test('a live (en route) visit lands on confirmed with its tracker rewound, a status history row, and the technician released', async () => {
    const live = { status: 'en_route', track_state: 'en_route', en_route_at: new Date('2026-11-03T13:40:00Z'), track_sms_sent_at: new Date('2026-11-03T13:40:05Z') };
    state.service = { ...state.service, ...live };
    state.locked = { ...state.locked, ...live };
    const r = await handOff();

    expect(r.ok).toBe(true);
    const update = writes('scheduled_services')[0].patch;
    expect(update).toEqual(expect.objectContaining({ status: 'confirmed', ...SmartRebooker.LIVE_LIFECYCLE_RESET }));
    expect(writes('job_status_history')).toEqual([{
      op: 'insert', table: 'job_status_history',
      row: { job_id: 'svc-1', from_status: 'en_route', to_status: 'confirmed', transitioned_by: null },
    }]);
    expect(SmartRebooker.applyLiveMovePostCommitEffects).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'svc-1', technician_id: 'tech-1', scheduled_date: DUE, window_start: null, status: 'confirmed' }),
      { toStatus: 'confirmed' },
    );
  });

  test('a confirmed visit keeps its status (no history row) and a repeated exception keeps its cadence date', async () => {
    const patch = { status: 'confirmed', date_exception: true, date_exception_cadence_date: '2026-10-30' };
    state.service = { ...state.service, ...patch };
    state.locked = { ...state.locked, ...patch };
    await handOff({ initiatedBy: 'admin', actorUserId: 'admin-1', requireAssignedTechnicianId: null });

    const update = writes('scheduled_services')[0].patch;
    expect(update).toEqual(expect.objectContaining({
      status: 'confirmed', date_exception_source: 'admin', date_exception_cadence_date: '2026-10-30',
    }));
    expect(update).not.toHaveProperty('track_state');
    expect(writes('job_status_history')).toEqual([]);
    expect(writes('reschedule_log')[0].row.initiated_by).toBe('admin');
    expect(sendCustomerMessage.mock.calls[0][0].metadata.adminUserId).toBe('admin-1');
  });

  test('an extra reason while its gate is on states the operational cause', async () => {
    process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
    await handOff({ reasonCode: 'running_late' });
    expect(sentBody()).toMatch(/^Hi Maria - we're running behind schedule today, so we need to move your Quarterly Pest Control Service\./);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.reason_code).toBe('running_late');
  });

  test('a long name that would bill a third segment sends without the closing "Questions? Reply here."', async () => {
    state.service.first_name = 'Maximiliana-Josephine';
    state.service.service_type = 'Quarterly Pest Control Service Plus';
    const r = await handOff();

    expect(r.textSent).toBe(true);
    const body = sentBody();
    expect(body.endsWith("we'll book the best open time and text you.")).toBe(true);
    expect(body).not.toMatch(/Questions\? Reply here\./);
    expect(countSegments(body).segmentCount).toBe(2);
    expect(countSegments(`${body} Questions? Reply here.`).segmentCount).toBe(3);
  });

  test('the service name keeps its catalog casing and loses only an admin suffix', async () => {
    state.service.service_type = 'Quarterly Pest Control Service (Monthly)';
    await handOff();
    expect(sentBody()).toContain('so we need to move your Quarterly Pest Control Service. Pick');
  });

  describe('the visit is handed off but the text does not go: textSent false and a follow-up', () => {
    const notTexted = (reason) => ({
      textSent: false,
      needsAttention: [{ id: 'svc-1', code: 'CUSTOMER_NOT_TEXTED', message: 'Customer not texted — follow up manually', reason }],
      results: [{ id: 'svc-1', ok: true, newDate: DUE, newWindow: null, smsSent: false, smsReason: reason }],
    });

    test.each([
      ['no link on the landed row', () => buildRescheduleLink.mockResolvedValueOnce({ url: LINK }).mockResolvedValueOnce({ url: null, line: '' }), 'no_link'],
      ['a failed link build', () => buildRescheduleLink.mockResolvedValueOnce({ url: LINK }).mockResolvedValueOnce({ url: null, line: '', failed: true }), 'link_failed'],
      ['a blocked send', () => sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'MOVE_HOLD' }), 'MOVE_HOLD'],
      ['a suppressed send (sentinel id)', () => sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'owner-silence' }), 'owner-silence'],
      ['a throwing send', () => sendCustomerMessage.mockRejectedValue(new Error('provider down')), 'send_failed'],
    ])('%s', async (_label, arrange, reason) => {
      arrange();
      const r = await handOff();
      expect(r).toEqual(expect.objectContaining({ ok: true, dueDate: DUE, ...notTexted(reason) }));
      // The hand-off itself committed.
      expect(writes('scheduled_services')).toHaveLength(1);
      expect(writes('reschedule_log')).toHaveLength(1);
    });

    test('a landed link long enough to bill a third segment even trimmed: not sent', async () => {
      buildRescheduleLink.mockResolvedValueOnce({ url: LINK })
        .mockResolvedValueOnce({ url: `https://portal.wavespestcontrol.com/reschedule/${'t'.repeat(90)}` });
      const r = await handOff();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(r).toEqual(expect.objectContaining(notTexted('text_unavailable')));
    });
  });
});

describe('customerPickOffer (the sheets\' offer)', () => {
  test('gate off: undefined, nothing read', async () => {
    delete process.env.GATE_QUICKMOVE_CUSTOMER_PICK;
    expect(await RainOut.customerPickOffer('svc-1')).toBeUndefined();
    expect(db).not.toHaveBeenCalled();
  });

  test('an eligible visit: the deadline and the exact text for every preset reason, measured, nothing written or minted', async () => {
    const offer = await RainOut.customerPickOffer('svc-1');
    expect(offer).toEqual({
      available: true,
      unavailableReason: null,
      pickBy: PICK_BY.toISOString(),
      pickByLabel: 'Wed 8 PM',
      previewByReason: {
        // The preview carries a placeholder of the link's real length, never the working link.
        weather_rain: REFERENCE_TEXT.replace('k3j9m2x7qp', 'xxxxxxxxxx'),
        weather_wind: expect.stringContaining('Hi Maria - winds are too high to spray safely today, so we need to move your Quarterly Pest Control Service.'),
        weather_lightning: expect.stringContaining("Hi Maria - there's lightning in the area, so we need"),
        weather_heat: expect.stringContaining("Hi Maria - today's heat is too extreme to treat safely, so we need"),
      },
      segments: { count: 2, remaining: expect.any(Number) },
    });
    // The counter follows the tightest preview: room left under 2 GSM-7 segments (306).
    const longest = Math.max(...Object.values(offer.previewByReason).map((body) => body.length));
    expect(offer.segments.remaining).toBe(306 - longest);
    expect(Object.values(offer.previewByReason).some((body) => body.includes('k3j9m2x7qp'))).toBe(false);
    expect(buildRescheduleLink).toHaveBeenCalledTimes(1);
    expect(buildRescheduleLink.mock.calls[0][1]).toEqual(expect.objectContaining({ previewOnly: true }));
    expect(state.writes).toEqual([]);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test("a legacy 5-character code is measured at its own length (the send reuses it)", async () => {
    buildRescheduleLink.mockResolvedValue({ url: 'https://portal.wavespestcontrol.com/l/ab12c' });
    const offer = await RainOut.customerPickOffer('svc-1');
    expect(offer.previewByReason.weather_rain).toContain('Pick a new time here: portal.wavespestcontrol.com/l/xxxxx\n\n');
  });

  test('the extra reasons are offered while their gate is on (never custom)', async () => {
    process.env.GATE_QUICKMOVE_EXTRA_REASONS = 'true';
    const offer = await RainOut.customerPickOffer({ ...VISIT, ...CUSTOMER });
    expect(Object.keys(offer.previewByReason)).toEqual([
      'weather_rain', 'weather_wind', 'weather_lightning', 'weather_heat',
      'running_late', 'equipment_issue', 'tech_emergency', 'customer_noshow', 'gate_locked',
    ]);
  });

  test.each([
    ['a one-time visit', () => { state.service.is_recurring = false; }, 'not_recurring_plan_visit'],
    ["Auto-Dispatch's customer fallback off", () => isCustomerRecurringDispatchEnabled.mockReturnValue(false), 'auto_dispatch_off'],
    ['the customer opted out', () => suppression.checkSuppression.mockResolvedValue({ ok: false, code: 'SUPPRESSED' }), 'customer_texts_off'],
    ['a gone visit', () => { state.service = null; }, 'not_found'],
    ['a read failure', () => { state.templateError = new Error('connection reset'); }, 'pick_check_failed'],
    ['no reason fits two segments', () => { state.service.service_type = 'Quarterly Pest Control Service and Perimeter Barrier Treatment and Interior Spot Treatment and Rodent Check'; }, 'pick_text_too_long'],
    ['a template edit that dropped {pick_by}', () => { state.template = { body: BODY.replace('{pick_by}', 'tomorrow night'), is_active: true }; }, 'pick_text_unavailable'],
  ])('%s: unavailable with the reason, no previews', async (_label, arrange, reason) => {
    arrange();
    const offer = await RainOut.customerPickOffer('svc-1');
    expect(offer).toEqual(expect.objectContaining({
      available: false, unavailableReason: reason, pickByLabel: 'Wed 8 PM', previewByReason: {}, segments: null,
    }));
  });

  test('a broken template files one audit row per offer, not one per reason', async () => {
    state.template = { body: BODY.replace('{pick_by}', 'tomorrow night'), is_active: true };
    await RainOut.customerPickOffer('svc-1');
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(writes('audit_log')).toHaveLength(1);
  });
});
