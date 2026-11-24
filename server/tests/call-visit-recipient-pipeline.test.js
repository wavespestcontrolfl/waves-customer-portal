// The call pipeline's use of the visit-only recipient (GATE_CALL_GIVEN_VISIT_TEXTS, owner 2026-11-24
// "yes, visit only"): recording the number on the booked visit (recordForCall, which the booking step calls).
// Its confirmation is NOT sent here: it reaches the person through deliverAppointmentNotice like every other
// confirmation (call-visit-recipient.test.js). The recipient's own SQL runs on real PostgreSQL in
// call-visit-recipient-postgres.test.js.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));
const VisitRecipient = require('../services/call-visit-recipient');
const { _test } = require('../services/call-recording-processor');

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
afterAll(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });
beforeEach(() => { jest.clearAllMocks(); delete process.env[GATE]; });

const BOB = '+19415550002';
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
  const bob = { first_name: 'Bob', last_name: 'Roe', phone_e164: BOB, role: 'spouse_partner', wants_appointment_texts: true };
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

  test('the pipeline sends the visit-only confirmation itself nowhere: it goes through deliverAppointmentNotice', () => {
    expect(source).not.toContain('sendVisitOnlyConfirmations');
    expect(source).not.toContain('notifyVisitRecipients');
    expect(_test.sendVisitOnlyConfirmations).toBeUndefined();
  });

  test('the slot path is unchanged: a held on-site phone still keeps the account consent stamp', () => {
    expect(source).toContain('holdPhone: onSiteBlockedBeforeWrite && !onSiteAlreadyConfirmed');
    expect(source).toContain('keepConsentStamp: onSiteBlockedBeforeWrite');
  });
});
