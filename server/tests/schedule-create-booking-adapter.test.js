/**
 * createScheduleBooking (routes/admin-schedule.js) — the Schedule-screen
 * create without an HTTP request, for the Intelligence Bar's
 * start-a-recurring-program tool (owner 2026-10-06). It must run the SAME
 * handler as POST /: these cases pin that the router-level catalog prime
 * runs, the handler sees the body and the actor, its status and body come
 * back unchanged (201 and 409), and an error it hands to next() rejects.
 * Harness from admin-schedule-create-tech-absence.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
// GATE_EDIT_APPT_ADDRESS is deliberately left unset (off, the default): a
// createScheduleBooking caller's explicit propertyId (start_program's pinned
// property) is honoured whatever that screen gate says.
delete process.env.GATE_EDIT_APPT_ADDRESS;
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  assignDispatchJob: jest.fn(),
  emitDispatchJobUpdate: jest.fn(),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
  acquireOccupancyLocks: jest.fn().mockResolvedValue(undefined),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
  withCustomerCommsLock: jest.fn(async (db, customerId, fn) => db.transaction(async (trx) => fn(trx))),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../services/lead-estimate-link', () => ({
  ...jest.requireActual('../services/lead-estimate-link'),
  convertLeadFromEvent: jest.fn().mockResolvedValue({ converted: false, reason: 'no_open_lead' }),
}));
jest.mock('../services/inspection-credit', () => ({
  ...jest.requireActual('../services/inspection-credit'),
  redeemInspectionCreditForBooking: jest.fn().mockResolvedValue(undefined),
  markBookingForInspectionCredit: jest.fn().mockResolvedValue(undefined),
  lockInspectionCreditCustomer: jest.fn().mockResolvedValue(undefined),
  projectRedeemableOfferAmount: jest.fn().mockResolvedValue(0),
}));

const db = require('../models/db');
const {
  redeemInspectionCreditForBooking, markBookingForInspectionCredit, lockInspectionCreditCustomer,
  projectRedeemableOfferAmount, CREDIT_FREE_CARD_EVENT_SOURCE,
} = require('../services/inspection-credit');
const { createScheduleBooking } = require('../routes/admin-schedule');

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  scheduled_date: '2099-07-01',
  day: '2099-07-01',
  window_start: '09:00:00',
  window_end: '10:00:00',
  status: 'confirmed',
  technician_id: null,
  service_type: 'General Pest Control',
  estimated_duration_minutes: 60,
};


function chain(row) {
  const builder = {};
  const self = () => builder;
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit', 'select', 'forUpdate', 'forShare', 'returning', 'leftJoin', 'join', 'groupBy', 'distinct', 'andWhere', 'orWhere', 'modify', 'clone']) {
    builder[m] = jest.fn(self);
  }
  builder.first = jest.fn().mockResolvedValue(row);
  builder.pluck = jest.fn().mockResolvedValue([]);
  builder.count = jest.fn().mockResolvedValue([{ count: '0' }]);
  builder.update = jest.fn().mockResolvedValue(1);
  builder.insert = jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ ...SVC, id: 'new-1' }]), onConflict: jest.fn(() => ({ ignore: jest.fn().mockResolvedValue([]) })) }));
  builder.del = jest.fn().mockResolvedValue(0);
  builder.delete = jest.fn().mockResolvedValue(0);
  builder.columnInfo = jest.fn().mockResolvedValue({ source_action: {} });
  builder.then = (resolve, reject) => Promise.resolve(row === undefined ? [] : [row]).then(resolve, reject);
  return builder;
}

let inserts;
beforeEach(() => {
  jest.clearAllMocks();
  inserts = [];
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null } : undefined)));
  const trx = jest.fn((table) => {
    if (table === 'technicians') return chain({ id: 'tech-1', name: 'Test Tech', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true });
    const c = chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1' } : undefined));
    if (table === 'scheduled_services') {
      c.insert = jest.fn((data) => {
        inserts.push(data);
        return { returning: jest.fn().mockResolvedValue([{ ...SVC, ...data, id: `new-${inserts.length}` }]) };
      });
    }
    return c;
  });
  trx.raw = jest.fn(async (sql, bindings) => ({ sql, bindings, rows: [] }));
  trx.fn = { now: jest.fn(() => 'now()') };
  trx.transaction = jest.fn(async (cb) => cb(trx));
  db.transaction = jest.fn(async (cb) => cb(trx));
});

// The 201 path's post-commit side effects run in a setImmediate after the
// reply; let them finish before Jest tears the module registry down.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 500)));

const actor = { technicianId: 'staff-1', technicianName: 'Test Admin' };
const oneOff = {
  customerId: 'cust-1',
  scheduledDate: '2099-07-03',
  windowStart: '10:00',
  serviceType: 'General Pest Control',
  sendConfirmationSms: false,
  technicianId: 'tech-1',
  estimatedPrice: 89,
};

describe('createScheduleBooking runs the POST / handler', () => {
  // First: the catalog prime is TTL-cached, so only the first call reads it.
  test('runs the router-level percent-discount catalog prime before the handler', async () => {
    const result = await createScheduleBooking({ body: { ...oneOff, expected_discount_stacking: 'stale' }, actor });
    expect(db.raw).toHaveBeenCalledWith('select service_key, engine_keys from services where engine_keys is not null');
    expect(result.status).toBe(409);
  });

  test('a refusal comes back with the handler\'s status and body', async () => {
    const result = await createScheduleBooking({ body: { ...oneOff, expected_discount_stacking: 'stale' }, actor });
    expect(result).toEqual({
      status: 409,
      json: { error: 'Discount rules changed since this was previewed — reload and try again', code: 'DISCOUNT_STACKING_GATE_DIVERGED' },
    });
  });

  test('a booking comes back 201 with the created visit, built from the body and booked as the actor', async () => {
    const result = await createScheduleBooking({ body: oneOff, actor });
    expect(result.status).toBe(201);
    expect(result.json.id).toBe('new-1');
    expect(result.json.recurringCreated).toBe(1);
    expect(inserts.map((d) => [d.customer_id, d.scheduled_date])).toEqual([['cust-1', '2099-07-03']]);
    expect(redeemInspectionCreditForBooking).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'admin:Test Admin' }));
  });

  test('the Schedule screen path takes no credit lock and stamps the ordinary booking source', async () => {
    const result = await createScheduleBooking({ body: oneOff, actor });
    expect(result.status).toBe(201);
    expect(lockInspectionCreditCustomer).not.toHaveBeenCalled();
    expect(projectRedeemableOfferAmount).not.toHaveBeenCalled();
    expect(markBookingForInspectionCredit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'admin_schedule' }));
  });

  test('creditFreeCard: re-checks credit under the credit lock and stamps the booking credit-free', async () => {
    const result = await createScheduleBooking({ body: oneOff, actor, creditFreeCard: true });
    expect(result.status).toBe(201);
    expect(lockInspectionCreditCustomer).toHaveBeenCalledWith(expect.anything(), 'cust-1');
    expect(projectRedeemableOfferAmount).toHaveBeenCalledWith('cust-1', expect.objectContaining({ includePaused: true }));
    expect(markBookingForInspectionCredit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: CREDIT_FREE_CARD_EVENT_SOURCE }));
  });

  test('creditFreeCard: an offer recorded since the card refuses and books nothing', async () => {
    projectRedeemableOfferAmount.mockResolvedValueOnce(25);
    const result = await createScheduleBooking({ body: oneOff, actor, creditFreeCard: true });
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('INSPECTION_CREDIT_CHANGED');
    expect(inserts).toEqual([]);
    expect(markBookingForInspectionCredit).not.toHaveBeenCalled();
  });

  test('lead conversion: the Schedule screen path runs it; skipLeadConversion skips it', async () => {
    const { convertLeadFromEvent } = require('../services/lead-estimate-link');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    expect((await createScheduleBooking({ body: oneOff, actor })).status).toBe(201);
    await settle();
    expect(convertLeadFromEvent).toHaveBeenCalledWith(expect.objectContaining({ source: 'appointment_booked', customerId: 'cust-1' }));
    convertLeadFromEvent.mockClear();
    expect((await createScheduleBooking({ body: oneOff, actor, skipLeadConversion: true })).status).toBe(201);
    await settle();
    expect(convertLeadFromEvent).not.toHaveBeenCalled();
  });

  describe('approvedServiceAnchor (Intelligence Bar start_program)', () => {
    test('the anchor the card showed books; the Schedule screen path never checks', async () => {
      expect((await createScheduleBooking({ body: oneOff, actor, approvedServiceAnchor: { propertyId: null, address: 'no address on file' } })).status).toBe(201);
      expect((await createScheduleBooking({ body: oneOff, actor })).status).toBe(201);
    });

    test('a different address refuses with ADDRESS_CHANGED and books nothing', async () => {
      const result = await createScheduleBooking({ body: oneOff, actor, approvedServiceAnchor: { propertyId: null, address: '1 Example St, Sarasota, FL 34201' } });
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('ADDRESS_CHANGED');
      expect(inserts).toEqual([]);
    });
  });

  describe('approvedBilling (Intelligence Bar start_program)', () => {
    const billing = { payer_id: null, billing_mode: null, per_application_fee: null, waveguard_tier: null, monthly_rate: null };

    test('the billing the card was built on books', async () => {
      expect((await createScheduleBooking({ body: oneOff, actor, approvedBilling: billing })).status).toBe(201);
    });

    test('billing that changed under the lock refuses with BILLING_CHANGED and books nothing', async () => {
      const result = await createScheduleBooking({ body: oneOff, actor, approvedBilling: { ...billing, billing_mode: 'monthly_membership' } });
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('BILLING_CHANGED');
      expect(inserts).toEqual([]);
    });
  });

  describe('approvedVisitDates / approvedNoOpenEstimate / approvedWelcome / propertyId (Intelligence Bar start_program)', () => {
    const recurringBody = { ...oneOff, isRecurring: true, recurringPattern: 'monthly', recurringOngoing: true, createInvoice: true };

    test('the dates the handler plans book; any other dates refuse with DATES_CHANGED before any insert', async () => {
      const plain = await createScheduleBooking({ body: recurringBody, actor });
      expect(plain.status).toBe(201);
      const dates = plain.json.appointments.map((a) => a.date);
      inserts.length = 0;
      expect((await createScheduleBooking({ body: recurringBody, actor, approvedVisitDates: dates })).status).toBe(201);
      inserts.length = 0;
      const changed = await createScheduleBooking({ body: recurringBody, actor, approvedVisitDates: [dates[0], '2099-12-31'] });
      expect(changed.status).toBe(409);
      expect(changed.json.code).toBe('DATES_CHANGED');
      expect(inserts).toEqual([]);
    });

    test('approvedContact threads to the rail: a recipient key that moved refuses with CONTACT_CHANGED', async () => {
      const Contact = require('../services/booking-contact-state');
      const spy = jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-b');
      const refused = await createScheduleBooking({ body: oneOff, actor, approvedContact: 'key-a' });
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('CONTACT_CHANGED');
      expect(inserts).toEqual([]);
      spy.mockResolvedValue('key-a');
      expect((await createScheduleBooking({ body: oneOff, actor, approvedContact: 'key-a' })).status).toBe(201);
      spy.mockRestore();
    });

    test('the pin stores the stamped property, and the adapter threads the round 11 pins to the rails (round 11)', async () => {
      const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
      expect(src).toContain('property_id: c.req.approvedServiceAnchor?.propertyId || null');
      expect(src).toContain("...(typeof approvedWelcomeContact === 'string' ? { approvedWelcomeContact } : {})");
      expect(src).toContain('...(approvedNotCommercial === true ? { approvedNotCommercial: true } : {})');
      expect(src).toContain("...(typeof approvedLedgerPin === 'string' ? { approvedLedgerPin } : {})");
      // The send-time check reads the confirmation key for the stamped property and the welcome key for the account.
      expect(src).toContain("currentContactKey(c.customerId, { propertyId: c.req.approvedServiceAnchor?.propertyId || null })");
      expect(src).toContain("currentContactKey(c.customerId, { kind: 'welcome' })");
    });

    test('the booking transaction writes the recipient pin for each created visit; a page booking writes none (round 10)', async () => {
      const Contact = require('../services/booking-contact-state');
      const spy = jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-a');
      const pins = [];
      const baseTransaction = db.transaction.getMockImplementation();
      db.transaction = jest.fn(async (cb) => baseTransaction(async (trx) => {
        const wrapped = jest.fn((table) => {
          const c = trx(table);
          if (table === 'activity_log') c.insert = jest.fn(async (rows) => { pins.push(...[].concat(rows)); return [1]; });
          return c;
        });
        Object.assign(wrapped, trx);
        return cb(wrapped);
      }));
      expect((await createScheduleBooking({ body: oneOff, actor, approvedContact: 'key-a' })).status).toBe(201);
      expect(pins).toHaveLength(1);
      expect(pins[0]).toMatchObject({ customer_id: 'cust-1', action: 'booking_contact_pin' });
      expect(JSON.parse(pins[0].metadata)).toEqual({ scheduled_service_id: 'new-1', contact_key: 'key-a', property_id: null });
      pins.length = 0;
      expect((await createScheduleBooking({ body: oneOff, actor })).status).toBe(201);
      expect(pins).toEqual([]);
      spy.mockRestore();
    });

    test('the deferred confirmation and welcome go to the pinned recipients only: drift after the commit skips both and warns', async () => {
      const Contact = require('../services/booking-contact-state');
      const AppointmentReminders = require('../services/appointment-reminders');
      const Welcome = require('../services/new-recurring-welcome-sms');
      const logger = require('../services/logger');
      const { sendDeferredConfirmations, sendRecurringWelcome, bookingContactDrifted } = require('../routes/admin-schedule')._test;
      const keySpy = jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-a');
      const confirmSpy = jest.spyOn(AppointmentReminders, 'sendConfirmation').mockResolvedValue(true);
      const welcomeSpy = jest.spyOn(Welcome, 'sendNewRecurringWelcome').mockResolvedValue({ queued: true });
      const booked = () => ({ customerId: 'cust-1', customer: { id: 'cust-1' }, svc: { id: 'visit-1' }, recurringPattern: 'monthly', createdAppointments: [{ id: 'visit-1', confirmation: true }], req: { approvedContact: 'key-a' } });
      // Same recipients: both go out, and the confirmation names the booked visit.
      const same = booked();
      await sendDeferredConfirmations(same);
      await sendRecurringWelcome(same);
      expect(confirmSpy).toHaveBeenCalledWith('visit-1');
      expect(welcomeSpy).toHaveBeenCalledTimes(1);
      // Changed after the lock: neither goes out, the check runs once, and the log names the customer.
      confirmSpy.mockClear(); welcomeSpy.mockClear(); keySpy.mockClear(); logger.warn.mockClear();
      keySpy.mockResolvedValue('key-b');
      const moved = booked();
      await sendDeferredConfirmations(moved);
      await sendRecurringWelcome(moved);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(welcomeSpy).not.toHaveBeenCalled();
      expect(keySpy).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cust-1'));
      // A Schedule-page booking pins nothing and reads nothing.
      keySpy.mockClear();
      expect(await bookingContactDrifted({ ...booked(), req: {} })).toBe(false);
      expect(keySpy).not.toHaveBeenCalled();
      keySpy.mockRestore(); confirmSpy.mockRestore(); welcomeSpy.mockRestore();
    });

    test('the queued welcome and the tagger both carry the card recipient key (round 9)', async () => {
      const Contact = require('../services/booking-contact-state');
      const Welcome = require('../services/new-recurring-welcome-sms');
      const Tagger = require('../services/appointment-tagger');
      const { sendRecurringWelcome, tagScheduledService } = require('../routes/admin-schedule')._test;
      jest.spyOn(Contact, 'currentContactKey').mockImplementation(async (_id, opts = {}) => (opts.kind === 'welcome' ? 'key-w' : 'key-a'));
      const welcomeSpy = jest.spyOn(Welcome, 'sendNewRecurringWelcome').mockResolvedValue({ queued: true });
      const tagSpy = jest.spyOn(Tagger, 'onServiceScheduled').mockResolvedValue(undefined);
      const c = { customerId: 'cust-1', customer: { id: 'cust-1' }, svc: { id: 'visit-1' }, recurringPattern: 'monthly', createdAppointments: [], req: { approvedContact: 'key-a', approvedWelcomeContact: 'key-w', approvedWelcome: true } };
      await sendRecurringWelcome(c);
      await tagScheduledService(c);
      // The welcome and the tagger carry the ACCOUNT-level welcome key; the confirmation key is property-scoped.
      expect(welcomeSpy).toHaveBeenCalledWith(expect.objectContaining({ contactKey: 'key-w' }));
      expect(tagSpy).toHaveBeenCalledWith('visit-1', { approvedWelcome: true, approvedContact: 'key-w' });
      welcomeSpy.mockClear();
      await sendRecurringWelcome({ ...c, contactDrifted: undefined, req: {} });
      expect(welcomeSpy.mock.calls[0][0]).not.toHaveProperty('contactKey');
      jest.restoreAllMocks();
    });

    test('drift closes the unsent reminder row so the recovery sweep cannot pick it up, and leaves an audit row (round 8)', async () => {
      const Contact = require('../services/booking-contact-state');
      const AppointmentReminders = require('../services/appointment-reminders');
      const { sendDeferredConfirmations } = require('../routes/admin-schedule')._test;
      const keySpy = jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-b');
      const confirmSpy = jest.spyOn(AppointmentReminders, 'sendConfirmation').mockResolvedValue(true);
      const reminder = { scheduled_service_id: 'visit-1', cancelled: false, confirmation_sent: false, windows_preclosed: false };
      const audits = [];
      const base = db.getMockImplementation();
      db.mockImplementation((table) => {
        const c = base(table);
        if (table === 'appointment_reminders') {
          c.update = jest.fn(async (patch) => { Object.assign(reminder, patch); return 1; });
        }
        if (table === 'activity_log') c.insert = jest.fn(async (row) => { audits.push(row); return [1]; });
        return c;
      });
      // The recovery sweep's own filter (exported from the service that runs it) selects the row before the booking.
      const sweepSelects = (row) => Object.entries(AppointmentReminders.STRANDED_CONFIRMATION_FILTER).every(([k, v]) => row[k] === v);
      expect(sweepSelects(reminder)).toBe(true);
      await sendDeferredConfirmations({
        customerId: 'cust-1', customer: { id: 'cust-1' }, svc: { id: 'visit-1' }, recurringPattern: 'monthly',
        createdAppointments: [{ id: 'visit-1', confirmation: true }], req: { approvedContact: 'key-a' },
      });
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(sweepSelects(reminder)).toBe(false);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ customer_id: 'cust-1', action: 'confirmation_suppressed_contact_drift' });
      expect(audits[0].description).toContain('send the confirmation by hand');
      keySpy.mockRestore(); confirmSpy.mockRestore();
    });

    test('the recovery sweep reads the exported filter, not its own copy of the conditions', () => {
      const src = require('fs').readFileSync(require.resolve('../services/appointment-reminders'), 'utf8');
      expect(src).toContain('.where(STRANDED_CONFIRMATION_FILTER)');
      expect(require('../services/appointment-reminders').STRANDED_CONFIRMATION_FILTER).toEqual({ cancelled: false, confirmation_sent: false, windows_preclosed: false });
    });

    test('approvedConsultations threads to the rail: a consultation the card did not list refuses with CONSULTATIONS_CHANGED', async () => {
      const Consultations = require('../services/consultation-outcomes');
      const spy = jest.spyOn(Consultations, 'openConsultationCandidates').mockResolvedValue([{ outcome_id: 9, outcome: 'warm' }]);
      const refused = await createScheduleBooking({ body: oneOff, actor, approvedConsultations: [] });
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('CONSULTATIONS_CHANGED');
      expect(inserts).toEqual([]);
      expect((await createScheduleBooking({ body: oneOff, actor, approvedConsultations: ['9:warm'] })).status).toBe(201);
      spy.mockRestore();
    });

    test('an open estimate found inside the transaction refuses with ESTIMATE_OPENED; none books', async () => {
      const StartProgram = require('../services/intelligence-bar/start-program');
      const spy = jest.spyOn(StartProgram, 'openEstimateForCustomer').mockResolvedValueOnce({ id: 'est-1', status: 'sent' });
      const refused = await createScheduleBooking({ body: oneOff, actor, approvedNoOpenEstimate: true });
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe('ESTIMATE_OPENED');
      expect(spy).toHaveBeenCalledWith('cust-1', expect.anything());
      expect(inserts).toEqual([]);
      spy.mockResolvedValueOnce(null);
      expect((await createScheduleBooking({ body: oneOff, actor, approvedNoOpenEstimate: true })).status).toBe(201);
      spy.mockRestore();
    });

    test('the open-estimate check takes the per-customer estimate lock first, so an in-flight estimate insert is waited for', async () => {
      const StartProgram = require('../services/intelligence-bar/start-program');
      const EstimateLock = require('../utils/customer-estimate-lock');
      const lockSpy = jest.spyOn(EstimateLock, 'lockCustomerEstimates').mockResolvedValue(undefined);
      const readSpy = jest.spyOn(StartProgram, 'openEstimateForCustomer').mockResolvedValue(null);
      const Seeder = require('../services/recurring-appointment-seeder');
      const seriesGuard = jest.spyOn(Seeder, 'checkActiveSeriesLocked').mockResolvedValue({ matches: [], guardError: null });
      const recurringBody = { ...oneOff, isRecurring: true, recurringPattern: 'monthly', recurringOngoing: true, createInvoice: true };
      expect((await createScheduleBooking({ body: recurringBody, actor, approvedNoOpenEstimate: true })).status).toBe(201);
      expect(lockSpy).toHaveBeenCalledWith(expect.anything(), 'cust-1');
      expect(lockSpy.mock.invocationCallOrder[0]).toBeLessThan(readSpy.mock.invocationCallOrder[0]);
      // The estimate lock is a leaf: taken after the series lock (and so after the customer row lock).
      expect(seriesGuard.mock.invocationCallOrder[0]).toBeLessThan(lockSpy.mock.invocationCallOrder[0]);
      seriesGuard.mockRestore();
      lockSpy.mockClear();
      expect((await createScheduleBooking({ body: oneOff, actor })).status).toBe(201);
      expect(lockSpy).not.toHaveBeenCalled();
      lockSpy.mockRestore();
      readSpy.mockRestore();
    });

    test('approvedWelcome: the pinned welcome verdict is used as given, with no lookup; the tagger gets it too', async () => {
      const { newRecurringWelcomeVerdict } = require('../routes/admin-schedule');
      const callsBefore = db.mock.calls.length;
      expect(await newRecurringWelcomeVerdict({ approvedWelcome: false }, 'cust-1')).toBe(false);
      expect(await newRecurringWelcomeVerdict({ approvedWelcome: true }, 'cust-1')).toBe(true);
      expect(db.mock.calls.length).toBe(callsBefore);
      // Page bookings pass nothing: the live lookup runs as before.
      await newRecurringWelcomeVerdict({}, 'cust-1');
      expect(db.mock.calls.length).toBeGreaterThan(callsBefore);
      const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
      expect(src).toMatch(/onServiceScheduled\(svc\.id, \.\.\.\(typeof welcomeVerdict === 'boolean'\s*\? \[\{ approvedWelcome: welcomeVerdict, \.\.\.\(typeof req\.approvedWelcomeContact === 'string' \? \{ approvedContact: req\.approvedWelcomeContact \} : \{\}\) \}\] : \[\]\)\)/);
      // The pinned verdict is withheld (false) when the customer's contact changed after the card.
      expect(src).toContain('const welcomeVerdict = (await bookingContactDrifted(c)) ? false : req.approvedWelcome;');
    });

    test('an explicit propertyId stamps that property on the visit with GATE_EDIT_APPT_ADDRESS off (a programmatic booking is exempt)', async () => {
      const PROP = '00000000-0000-4000-8000-00000000a001';
      const propertyRow = { id: PROP, customer_id: 'cust-1', active: true, address_line1: '1 Example St', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34201' };
      const baseDb = db.getMockImplementation();
      db.mockImplementation((table) => {
        if (table === 'customer_properties') return chain(propertyRow);
        const c = baseDb(table);
        if (table === 'scheduled_services') {
          c.columnInfo = jest.fn().mockResolvedValue({ source_action: {}, property_id: {}, service_address_line1: {}, service_address_line2: {}, service_address_city: {}, service_address_state: {}, service_address_zip: {} });
        }
        return c;
      });
      const baseTrx = db.transaction.getMockImplementation();
      db.transaction.mockImplementation(async (cb) => baseTrx(async (trx) => {
        const wrapped = jest.fn((table) => (table === 'customer_properties' ? chain(propertyRow) : trx(table)));
        Object.assign(wrapped, trx);
        return cb(wrapped);
      }));
      const result = await createScheduleBooking({ body: { ...oneOff, propertyId: PROP }, actor });
      expect(result.status).toBe(201);
      // The zone comes from the pinned property (Sarasota), not the customer
      // row (no city here -> the lakewood_ranch default).
      expect(inserts[0]).toMatchObject({ property_id: PROP, service_address_line1: '1 Example St', service_address_city: 'Sarasota', zone: 'sarasota' });
    });
  });

  describe('child overlaps (approvedOverlapFacts set)', () => {
    const { findConflictingVisits } = require('../services/scheduling/occupancy');
    const recurring = { ...oneOff, isRecurring: true, recurringPattern: 'monthly', recurringOngoing: true, createInvoice: true };
    const childClash = [{ id: 'visit-7', window_start: '10:00:00', window_end: '11:00:00', status: 'confirmed', service_type: 'Lawn Care' }];

    test('a child occurrence that overlaps refuses with OVERLAP_CHANGED before any visit is inserted (the rails step)', async () => {
      findConflictingVisits.mockResolvedValueOnce([]).mockResolvedValue(childClash);
      const result = await createScheduleBooking({ body: recurring, actor, approvedOverlapFacts: [] });
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('OVERLAP_CHANGED');
      expect(inserts).toEqual([]);
      findConflictingVisits.mockResolvedValue([]);
    });

    test('a child overlap the card showed (its fact is approved) books; a different one refuses', async () => {
      findConflictingVisits.mockResolvedValue([]);
      const plain = await createScheduleBooking({ body: recurring, actor });
      const childDates = plain.json.appointments.map((a) => a.date).slice(1);
      inserts.length = 0;
      const factFor = (id) => (date) => `${id}||Lawn Care|${date}|10:00 AM-11:00 AM`;
      findConflictingVisits.mockResolvedValueOnce([]).mockResolvedValue(childClash);
      const shown = await createScheduleBooking({ body: recurring, actor, approvedOverlapFacts: childDates.map(factFor('visit-7')) });
      expect(shown.status).toBe(201);
      inserts.length = 0;
      findConflictingVisits.mockResolvedValueOnce([]).mockResolvedValue(childClash);
      const other = await createScheduleBooking({ body: recurring, actor, approvedOverlapFacts: childDates.map(factFor('visit-8')) });
      expect(other.status).toBe(409);
      expect(other.json.code).toBe('OVERLAP_CHANGED');
      findConflictingVisits.mockResolvedValue([]);
    });

    test('the Schedule screen path books the series with an overlap warning', async () => {
      findConflictingVisits.mockResolvedValueOnce([]).mockResolvedValue(childClash);
      const result = await createScheduleBooking({ body: recurring, actor });
      expect(result.status).toBe(201);
      expect(result.json.recurringCreated).toBeGreaterThan(1);
      expect(result.json.warnings.length).toBeGreaterThan(0);
      findConflictingVisits.mockResolvedValue([]);
    });
  });

  describe('approvedOverlapFacts (Intelligence Bar start_program)', () => {
    const { findConflictingVisits } = require('../services/scheduling/occupancy');
    const clash = { id: 'visit-9', scheduled_date: '2099-07-03', window_start: '10:00:00', window_end: '11:00:00', status: 'confirmed', service_type: 'Pest Control' };
    const approvedFact = 'visit-9||Pest Control|2099-07-03|10:00 AM-11:00 AM';

    test('the Schedule screen path books through an overlap with a warning', async () => {
      findConflictingVisits.mockResolvedValue([clash]);
      const result = await createScheduleBooking({ body: oneOff, actor });
      expect(result.status).toBe(201);
      findConflictingVisits.mockResolvedValue([]);
    });

    test('an overlap the card showed books through', async () => {
      findConflictingVisits.mockResolvedValue([clash]);
      const result = await createScheduleBooking({ body: oneOff, actor, approvedOverlapFacts: [approvedFact] });
      expect(result.status).toBe(201);
      findConflictingVisits.mockResolvedValue([]);
    });

    test('an overlap the card did not show refuses with OVERLAP_CHANGED', async () => {
      findConflictingVisits.mockResolvedValue([clash]);
      const result = await createScheduleBooking({ body: oneOff, actor, approvedOverlapFacts: [] });
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('OVERLAP_CHANGED');
      findConflictingVisits.mockResolvedValue([]);
    });
  });

  test('an error the handler passes to next() rejects', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(createScheduleBooking({ body: oneOff, actor })).rejects.toThrow('db down');
  });
});
