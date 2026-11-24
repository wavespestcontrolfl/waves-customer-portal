// The call pipeline's two uses of the visit-only recipient (GATE_CALL_GIVEN_VISIT_TEXTS, owner 2026-11-24
// "yes, visit only"): the same-call booking confirmation (sendVisitOnlyConfirmations) and recording the
// number on the booked visit (recordForCall, which the booking step calls). The recipient's own SQL runs on
// real PostgreSQL in call-visit-recipient-postgres.test.js.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  confirmationLoggedForVisitPhone: jest.fn(async () => false),
  renderAppointmentPageTemplate: jest.fn(async (key, factory, fallback) => `Hi ${fallback.first_name}, confirmed`),
  confirmationArrivalWindow: jest.fn(async () => '9-11 AM'),
}));
jest.mock('../services/appointment-link', () => ({ buildAppointmentLink: jest.fn(async () => ({ line: 'link' })) }));
jest.mock('../services/call-visit-recipient', () => {
  const actual = jest.requireActual('../services/call-visit-recipient');
  return {
    ...actual,
    contactsForVisit: jest.fn(async () => []),
    sendOnce: jest.fn(async (contact, send) => ({ skipped: false, result: await send() })),
  };
});

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const Reminders = require('../services/appointment-reminders');
const VisitRecipient = require('../services/call-visit-recipient');
const { _test } = require('../services/call-recording-processor');

const { sendVisitOnlyConfirmations } = _test;
const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
afterAll(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });

const BOB = '+19415550002';
const CONTACT = { phone: BOB, name: 'Bob Roe', role: VisitRecipient.ROLE, visitRecipientId: 'vtr-1', claimKey: 'confirmation:2026-12-01T09:00' };
const base = (over = {}) => ({
  scheduledServiceId: 'ss-1',
  customerId: 'cust-1',
  call: { id: 'call-1', direction: 'inbound', created_at: new Date().toISOString() },
  excludePhones: ['+19415550001', '+19415550001'],
  blocked: false,
  claimStillOwned: jest.fn(async () => true),
  visit: {
    serviceType: 'Pest Control', firstName: 'Phyllis', parsedDate: 'Tuesday, December 1', parsedTime: '9:00 AM',
    preferredDateTime: '2026-12-01T09:00', scheduledDate: '2026-12-01', windowStart: '09:00',
  },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[GATE];
  VisitRecipient.contactsForVisit.mockResolvedValue([CONTACT]);
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

describe('sendVisitOnlyConfirmations', () => {
  test('gate off: nothing is read and nobody is texted', async () => {
    await expect(sendVisitOnlyConfirmations(base())).resolves.toBe(true);
    expect(VisitRecipient.contactsForVisit).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('gate on: the recipient gets this visit\'s confirmation with their own first name, as a non-contact', async () => {
    process.env[GATE] = 'true';
    await expect(sendVisitOnlyConfirmations(base())).resolves.toBe(true);
    expect(VisitRecipient.contactsForVisit).toHaveBeenCalledWith('ss-1', 'confirmation', { excludePhones: ['+19415550001', '+19415550001'] });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({
      to: BOB,
      body: 'Hi Bob, confirmed',
      purpose: 'appointment_confirmation',
      customerId: 'cust-1',
      appointmentId: 'ss-1',
      identityTrustLevel: 'phone_matches_customer',
      customerInitiated: true,
      metadata: { original_message_type: 'confirmation', appointment_contact_role: VisitRecipient.ROLE },
    });
    expect(sendCustomerMessage.mock.calls[0][0].renderedSlotMs).toEqual(expect.any(Number));
  });

  test.each([
    ['the call SMS is blocked, do-not-contact, or the re-armed sweep owns the confirmation', { blocked: true }],
  ])('gate on: nobody is texted when %s', async (_label, over) => {
    process.env[GATE] = 'true';
    await expect(sendVisitOnlyConfirmations(base(over))).resolves.toBe(true);
    expect(VisitRecipient.contactsForVisit).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('gate on: a number that already holds this visit\'s confirmation (the slot fan-out, an earlier pass) is not texted again', async () => {
    process.env[GATE] = 'true';
    Reminders.confirmationLoggedForVisitPhone.mockResolvedValueOnce(true);
    await sendVisitOnlyConfirmations(base());
    expect(Reminders.confirmationLoggedForVisitPhone).toHaveBeenCalledWith({ scheduledServiceId: 'ss-1', phone: BOB });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('gate on: a pass that lost its claim stops and tells the caller to abandon', async () => {
    process.env[GATE] = 'true';
    await expect(sendVisitOnlyConfirmations(base({ claimStillOwned: jest.fn(async () => false) }))).resolves.toBe(false);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('gate on: a failure never throws into the booking', async () => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockRejectedValue(new Error('boom'));
    await expect(sendVisitOnlyConfirmations(base())).resolves.toBe(true);
    VisitRecipient.contactsForVisit.mockResolvedValue([CONTACT]);
    sendCustomerMessage.mockRejectedValue(new Error('twilio down'));
    await expect(sendVisitOnlyConfirmations(base())).resolves.toBe(true);
  });

  test('gate on: a send the layer blocks (STOP, suppression, window) is logged and does not throw', async () => {
    process.env[GATE] = 'true';
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED' });
    await expect(sendVisitOnlyConfirmations(base())).resolves.toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('gate on: a template that renders nothing sends nothing', async () => {
    process.env[GATE] = 'true';
    Reminders.renderAppointmentPageTemplate.mockResolvedValueOnce(null);
    await sendVisitOnlyConfirmations(base());
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('recordForCall (the booking step)', () => {
  const db = require('../models/db');
  const inserts = [];
  const chain = () => {
    const q = {};
    ['where', 'whereNull', 'whereRaw', 'join', 'onConflict', 'ignore'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => null);
    q.insert = jest.fn((row) => { inserts.push(row); return q; });
    q.returning = jest.fn(async () => [{ id: 'vtr-1' }]);
    return q;
  };
  const bob = { first_name: 'Bob', last_name: 'Roe', phone_e164: BOB, role: 'spouse_partner', wants_notifications: true };
  const callArgs = (over = {}) => ({
    scheduledServiceId: 'ss-1',
    customerId: 'cust-1',
    call: { id: 'call-1', from_phone: '+19415550010', to_phone: '+19413180000' },
    contactPhone: '+19415550010',
    extracted: { phone: '+19415550011' },
    v2Extraction: {
      caller: { phone_e164: '+19415550012' },
      secondary_contacts: [bob, { ...bob, first_name: 'Dee', phone_e164: '+19415550011' }, { ...bob, first_name: 'Eve', phone_e164: '+19415550012' }],
    },
    blocked: false,
    ...over,
  });

  beforeEach(() => {
    inserts.length = 0;
    db.mockImplementation(() => chain());
  });

  test('gate off: nothing is written', async () => {
    await expect(VisitRecipient.recordForCall(callArgs())).resolves.toBeNull();
    expect(inserts).toEqual([]);
  });

  test('gate on: the visit the call booked gets only the named person, never a call leg or the caller\'s own numbers', async () => {
    process.env[GATE] = 'true';
    await VisitRecipient.recordForCall(callArgs());
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      scheduled_service_id: 'ss-1', phone_key: '9415550002', phone_e164: BOB, call_log_id: 'call-1',
      source: 'call_caller_provided', consent_version: 'owner-ruling-2026-11-24-visit-only',
    });
  });

  test('gate on: a blocked call (do-not-contact, TCPA gate, disclaimed caller number) records nothing', async () => {
    process.env[GATE] = 'true';
    await VisitRecipient.recordForCall(callArgs({ blocked: true }));
    expect(inserts).toEqual([]);
  });

  test('gate on: a write error is swallowed (nothing extra is texted, the booking is untouched)', async () => {
    process.env[GATE] = 'true';
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(VisitRecipient.recordForCall(callArgs())).resolves.toBeNull();
  });

  test('a call with no customer records nothing', async () => {
    process.env[GATE] = 'true';
    await expect(VisitRecipient.recordForCall(callArgs({ customerId: null }))).resolves.toBeNull();
    expect(inserts).toEqual([]);
  });
});

describe('the booking step wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-recording-processor.js'), 'utf8');

  test('the number is recorded where the visit is booked, before its reminders arm, with the call SMS verdict', () => {
    const recordAt = source.indexOf("await require('./call-visit-recipient').recordForCall({");
    const armAt = source.indexOf('await registerScheduleSideEffects({', recordAt);
    expect(recordAt).toBeGreaterThan(0);
    expect(armAt).toBeGreaterThan(recordAt);
    const block = source.slice(recordAt, armAt);
    expect(block).toContain('scheduledServiceId: svc.id');
    expect(block).toContain('v2Extraction: v2CanonicalExtraction');
    expect(block).toContain('blocked: v2SmsBlocked || v2DoNotContact || callbackNumberNeededHoldActive');
  });

  test('the same-call confirmation runs after the slot fan-out and before the primary result returns, skipped when the sweep owns it', () => {
    const fanOutAt = source.indexOf('secondary confirmation fan-out skipped');
    const callAt = source.indexOf('await sendVisitOnlyConfirmations({', fanOutAt);
    const returnAt = source.indexOf('return primaryOk;', callAt);
    expect(fanOutAt).toBeGreaterThan(0);
    expect(callAt).toBeGreaterThan(fanOutAt);
    expect(returnAt).toBeGreaterThan(callAt);
    expect(source.slice(callAt, returnAt)).toContain('blocked: confirmationRearmed || v2SmsBlocked || v2DoNotContact');
  });

  test('the slot path is unchanged: a held on-site phone still keeps the account consent stamp', () => {
    expect(source).toContain('holdPhone: onSiteBlockedBeforeWrite && !onSiteAlreadyConfirmed');
    expect(source).toContain('keepConsentStamp: onSiteBlockedBeforeWrite');
  });
});
