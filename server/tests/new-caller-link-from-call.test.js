// GATE_NEW_CALLER_BOOKING, the call-recording agent's link step
// (services/booking/new-caller-link-from-call.js). After the processor's fenced
// customer checkpoint, a visit the office booked by address for the call gets
// the call's customer, its reminders and its confirmation (D1, D3, D6); a visit
// the pass leaves unlinked rings its bell (D4a). The bell runs through the real
// composer, so a copy-rule break fails here. Unit cases run everywhere; the
// link on Postgres runs in CI (DATABASE_URL). Fixtures fictitious.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockNewCallerGate = true;
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (gate) => (gate === 'newCallerBooking' ? mockNewCallerGate : actual.isEnabled(gate)) };
});
// The link itself is the real one unless a case queues an answer; reminders and texts never run here.
jest.mock('../services/booking/new-caller-visit', () => {
  const actual = jest.requireActual('../services/booking/new-caller-visit');
  return {
    ...actual,
    linkNewCallerVisit: jest.fn((...args) => actual.linkNewCallerVisit(...args)),
    armLinkedVisitComms: jest.fn(async () => ({ remindersArmed: true, confirmationSent: true })),
  };
});

const fs = require('fs');
const NotificationService = require('../services/notification-service');
const newCallerVisit = require('../services/booking/new-caller-visit');
const { linkOfficeVisitFromCall, _private } = require('../services/booking/new-caller-link-from-call');

const VISIT_ID = '0f8b9d1e-2c3a-4b5d-8e6f-7a8b9c0d1e2f';
const CUSTOMER_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const CALL = { id: '2b3c4d5e-6f70-4b1c-9d2e-3f4a5b6c7d8e', twilio_call_sid: 'CAsynthetic' };
const LINK = `/admin/dispatch?tab=schedule&date=2031-03-07&appointment=${VISIT_ID}`;
const officeVisit = (overrides = {}) => ({
  id: VISIT_ID, customer_id: null, source_call_log_id: CALL.id, source_action: 'admin_new_caller', status: 'pending',
  scheduled_date: '2031-03-07', window_start: '13:00:00', service_type: 'Waves Assessment',
  service_address_line1: '100 Example St', service_address_line2: '', service_address_zip: '34200', ...overrides,
});
const linkedVisit = () => officeVisit({ customer_id: CUSTOMER_ID });
const TEXT_OK = { passBlocked: false, extraction: { consent: { sms_consent_given: true } }, impliedConsent: false, callerPhone: '+15555550142' };
const PAT = { phone: '+15555550142' };

// Answers each read by table: rows.visit (the office-visit lookup), rows.call (the claimed call row),
// rows.customer (every customers read), rows.recheck (the visit re-read after a refused link).
function fakeConn(rows, { throwOn = null } = {}) {
  const reads = [];
  const conn = (table) => {
    const wheres = [];
    const chain = {
      where: (...args) => { wheres.push(args); return chain; },
      whereNull: (...args) => { wheres.push(['null', ...args]); return chain; },
      whereNotIn: (...args) => { wheres.push(['notIn', ...args]); return chain; },
      orderBy: () => chain,
      first: async (...columns) => {
        reads.push({ table, wheres, columns });
        if (table === throwOn) throw new Error('synthetic read failure with select * from call_log');
        if (table === 'scheduled_services') return columns.length ? rows.recheck : rows.visit;
        if (table === 'call_log') return rows.call;
        if (table === 'customers') return rows.customer;
        throw new Error(`unexpected read of ${table}`);
      },
    };
    return chain;
  };
  conn.reads = reads;
  return conn;
}

let notify;
beforeEach(() => {
  jest.clearAllMocks();
  mockNewCallerGate = true;
  notify = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
});
afterEach(() => notify.mockRestore());

describe('the agent links the office visit after the call checkpoint', () => {
  test('the gate off, or no claim to fence on: nothing is read', async () => {
    const conn = fakeConn({});
    mockNewCallerGate = false;
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn })).resolves.toEqual({ outcome: 'off' });
    mockNewCallerGate = true;
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: null, conn })).resolves.toEqual({ outcome: 'off' });
    expect(conn.reads).toHaveLength(0);
  });

  test('a call with no visit booked by address reads one row and does nothing else', async () => {
    const conn = fakeConn({ visit: undefined });
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn })).resolves.toEqual({ outcome: 'none' });
    expect(conn.reads).toHaveLength(1);
    expect(conn.reads[0].wheres).toEqual(expect.arrayContaining([
      [{ source_call_log_id: CALL.id, source_action: 'admin_new_caller' }], ['null', 'customer_id'], ['null', 'parent_service_id'],
    ]));
  });

  test('a pass that lost its claim links nothing and rings nothing', async () => {
    const conn = fakeConn({ visit: officeVisit(), call: undefined });
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn })).resolves.toEqual({ outcome: 'claim_lost' });
    expect(conn.reads[1]).toMatchObject({ table: 'call_log', wheres: [[{ id: CALL.id, processing_token: 'tok-1' }]] });
    expect(newCallerVisit.linkNewCallerVisit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('a call with no customer rings the visit bell (D4a): its own key, the visit, a person to link it', async () => {
    const conn = fakeConn({ visit: officeVisit(), call: { customer_id: null } });
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn })).resolves.toEqual({ outcome: 'unlinked', visitId: VISIT_ID });
    expect(newCallerVisit.linkNewCallerVisit).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('schedule', "Schedule — link the new caller's visit on Fri Mar 7", _private.UNLINKED_WHY.no_customer, expect.objectContaining({
      dedupeKey: `new-caller-visit:${VISIT_ID}`,
      bellDefault: true,
      link: LINK,
      detail: expect.stringContaining('use Link customer'),
      metadata: expect.objectContaining({ area: 'Schedule', severity: 'needs-you', subject: { type: 'visit', id: VISIT_ID }, doneWhen: 'visit_linked', who: 'person' }),
    }));
  });

  test('links under this pass\'s claim with the call pipeline as the property source, then sends; a clean link rings nothing', async () => {
    const conn = fakeConn({ visit: officeVisit(), call: { customer_id: CUSTOMER_ID }, customer: PAT });
    newCallerVisit.linkNewCallerVisit.mockResolvedValueOnce({ visit: linkedVisit(), addedProperty: true });

    const out = await linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn, text: TEXT_OK });

    expect(out).toEqual({ outcome: 'linked', visitId: VISIT_ID, remindersArmed: true, confirmationSent: true, heldText: null });
    expect(newCallerVisit.linkNewCallerVisit).toHaveBeenCalledWith({
      visitId: VISIT_ID, customerId: CUSTOMER_ID, propertySource: 'call_pipeline', claimFence: { callLogId: CALL.id, procToken: 'tok-1' }, conn,
    });
    expect(newCallerVisit.armLinkedVisitComms).toHaveBeenCalledWith({ visit: linkedVisit(), sendConfirmation: true });
    expect(notify).not.toHaveBeenCalled();
  });

  test('a refused link rings the visit bell with the refusal while the visit waits; a peer\'s claim or a settled visit rings nothing', async () => {
    const refusal = Object.assign(new Error('This address was removed from the customer\'s account, so the visit cannot use it.'), { status: 409, isOperational: true });
    const waiting = { customer_id: null, status: 'pending' };

    newCallerVisit.linkNewCallerVisit.mockRejectedValueOnce(refusal);
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn: fakeConn({ visit: officeVisit(), call: { customer_id: CUSTOMER_ID }, recheck: waiting }) }))
      .resolves.toEqual({ outcome: 'unlinked', visitId: VISIT_ID });
    expect(notify).toHaveBeenLastCalledWith('schedule', expect.any(String), _private.UNLINKED_WHY.refused, expect.objectContaining({
      dedupeKey: `new-caller-visit:${VISIT_ID}`, detail: expect.stringContaining('removed from the customer\'s account'),
    }));

    // A database error never reaches the bell's words: it can echo SQL.
    newCallerVisit.linkNewCallerVisit.mockRejectedValueOnce(new Error('insert into customer_properties failed'));
    await linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn: fakeConn({ visit: officeVisit(), call: { customer_id: CUSTOMER_ID }, recheck: waiting }) });
    expect(notify.mock.calls[1][3].detail).toContain('An error stopped it.');
    expect(notify.mock.calls[1][3].detail).not.toContain('customer_properties');

    newCallerVisit.linkNewCallerVisit.mockRejectedValueOnce(Object.assign(new Error('The call changed while the visit was being linked.'), { code: 'call_claim_lost' }));
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn: fakeConn({ visit: officeVisit(), call: { customer_id: CUSTOMER_ID } }) }))
      .resolves.toEqual({ outcome: 'claim_lost' });

    newCallerVisit.linkNewCallerVisit.mockRejectedValueOnce(Object.assign(new Error('This visit already has a customer, or it was cancelled.'), { status: 409, isOperational: true }));
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn: fakeConn({ visit: officeVisit(), call: { customer_id: CUSTOMER_ID }, recheck: { customer_id: 'cust-office', status: 'pending' } }) }))
      .resolves.toEqual({ outcome: 'settled', visitId: VISIT_ID });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('a text the pass blocks is held: the reminders are set up, the confirmation is not sent', async () => {
    const conn = fakeConn({ visit: officeVisit(), call: { customer_id: CUSTOMER_ID }, customer: PAT });
    newCallerVisit.linkNewCallerVisit.mockResolvedValueOnce({ visit: linkedVisit(), addedProperty: true });
    newCallerVisit.armLinkedVisitComms.mockResolvedValueOnce({ remindersArmed: true, confirmationSent: false });

    const out = await linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn, text: { ...TEXT_OK, passBlocked: true } });

    expect(newCallerVisit.armLinkedVisitComms).toHaveBeenCalledWith({ visit: linkedVisit(), sendConfirmation: false });
    expect(out).toEqual({ outcome: 'linked', visitId: VISIT_ID, remindersArmed: true, confirmationSent: false, heldText: 'consent' });
    expect(notify).not.toHaveBeenCalled();
  });

  test('a failed phone read after the link still sets up the reminders and holds only the text', async () => {
    const conn = fakeConn({ visit: officeVisit(), call: { customer_id: CUSTOMER_ID } }, { throwOn: 'customers' });
    newCallerVisit.linkNewCallerVisit.mockResolvedValueOnce({ visit: linkedVisit(), addedProperty: false });
    newCallerVisit.armLinkedVisitComms.mockResolvedValueOnce({ remindersArmed: true, confirmationSent: false });

    const out = await linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn, text: { passBlocked: false, extraction: null, impliedConsent: true, callerPhone: PAT.phone } });

    expect(newCallerVisit.armLinkedVisitComms).toHaveBeenCalledWith({ visit: linkedVisit(), sendConfirmation: false });
    expect(out).toMatchObject({ outcome: 'linked', remindersArmed: true, heldText: 'unknown' });
  });

  test('a failure anywhere never escapes the call pass; the visit bell rings while the visit waits', async () => {
    const conn = fakeConn({ visit: officeVisit(), recheck: { customer_id: null, status: 'pending' } }, { throwOn: 'call_log' });
    await expect(linkOfficeVisitFromCall({ call: CALL, procToken: 'tok-1', conn })).resolves.toEqual({ outcome: 'error' });
    expect(notify).toHaveBeenCalledWith('schedule', expect.any(String), _private.UNLINKED_WHY.refused, expect.objectContaining({
      detail: expect.stringContaining('An error stopped it.'),
    }));
  });
});

describe('the confirmation text follows the pass\'s own consent rules', () => {
  const explicit = { consent: { sms_consent_given: true } };
  test.each([
    ['the pass blocks texts (enforce consent, a disclaimed or no-text number)', { passBlocked: true, extraction: explicit }, PAT.phone, { send: false, held: 'consent' }],
    ['no pass verdict given: closed', { extraction: explicit }, PAT.phone, { send: false, held: 'consent' }],
    ['explicit consent on the call', { passBlocked: false, extraction: explicit }, '+15555550177', { send: true }],
    ['no consent data and no implied consent', { passBlocked: false, extraction: null, impliedConsent: false }, PAT.phone, { send: false, held: 'consent' }],
    ['a do-not-contact request beats implied consent', { passBlocked: false, extraction: { consent: { do_not_contact_request: true } }, impliedConsent: true }, PAT.phone, { send: false, held: 'consent' }],
    ['implied consent, the phone on file is the number that called', { passBlocked: false, extraction: null, impliedConsent: true, callerPhone: '+1 (555) 555-0142' }, '5555550142', { send: true }],
    ['implied consent, the phone on file is another number', { passBlocked: false, extraction: null, impliedConsent: true, callerPhone: '+15555550142' }, '+15555550177', { send: false, held: 'other_number' }],
  ])('%s', async (_label, text, phone, expected) => {
    await expect(_private.textDecision(fakeConn({ customer: { phone } }), CUSTOMER_ID, text)).resolves.toEqual(expected);
  });
});

describe('the bell passes the notification rule', () => {
  test('each why', () => {
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    const spec = { area: 'Schedule', action: "link the new caller's visit", severity: 'needs-you', link: LINK, subject: { type: 'visit', id: VISIT_ID }, doneWhen: 'visit_linked', who: 'person' };
    for (const why of Object.values(_private.UNLINKED_WHY)) expect(() => composeAdminAlert({ ...spec, why })).not.toThrow();
  });
});

describe('the processor runs the link step right after its customer checkpoint', () => {
  test('after the fenced checkpoint and before the booking branch, with the pass\'s own text verdict', () => {
    const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const checkpoint = src.indexOf("if (!checkpointRows) return abandonToPeer('the customer checkpoint write');");
    const link = src.indexOf("await require('./booking/new-caller-link-from-call').linkOfficeVisitFromCall({");
    const booking = src.indexOf('const existing = await findExistingCallAppointment({');
    expect(checkpoint).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(checkpoint);
    expect(link).toBeLessThan(booking);
    const args = src.slice(link, src.indexOf('});', link));
    expect(args).toContain('passBlocked: v2SmsBlocked,');
    expect(args).toContain("impliedConsent: isEnabled('callInboundImpliedConsent') && outboundImpliedConsentEligible(call, outboundReturnMessagesEligible),");
    expect(args).toContain('callerPhone: contactPhone,');
  });
});

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('the agent link on Postgres', () => {
  let db;
  const made = { callIds: [], visitIds: [], customerIds: [] };
  const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
  const ADDRESS = { line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 };

  async function insertCustomer(lastName, phone) {
    const id = require('crypto').randomUUID();
    await db('customers').insert({ id, first_name: 'Synthetic', last_name: lastName, phone, address_line1: '1 Synthetic Ln', city: 'Bradenton', zip: '34201', active: true });
    made.customerIds.push(id);
    return id;
  }

  // An answered inbound call, a visit the office booked for it, then the pass's checkpoint state.
  async function bookedCall({ scheduledDate, customerId, token }) {
    const [call] = await db('call_log').insert({
      direction: 'inbound', from_phone: '+15555550100', to_phone: '+15555550999', status: 'in-progress',
      twilio_call_sid: `CA${require('crypto').randomBytes(16).toString('hex')}`, duration_seconds: 0,
      created_at: minutesAgo(6), updated_at: minutesAgo(1),
      metadata: JSON.stringify({ forward_acceptance: { accepted: true, csr_name: 'Office', answered_by_number: '+15555550123', accepted_at: minutesAgo(5).toISOString() } }),
    }).returning(['id']);
    made.callIds.push(call.id);
    const svc = await db('services').whereNot('service_key', 'mosquito_one_time').whereNotNull('name').first('id');
    const booked = await newCallerVisit.bookNewCallerVisit({
      input: { scheduledDate, windowStart: '13:00', serviceId: svc.id, address: ADDRESS, callLogId: call.id },
    });
    made.visitIds.push(booked.visit.id);
    await db('call_log').where({ id: call.id }).update({ customer_id: customerId, processing_token: token });
    return { callId: call.id, visitId: booked.visit.id };
  }

  beforeAll(() => {
    db = require('../models/db');
  });
  afterAll(async () => {
    if (made.visitIds.length) {
      await db('activity_log').whereIn('action', ['new_caller_visit_booked', 'new_caller_visit_linked']).whereRaw("metadata->>'scheduled_service_id' = ANY(?)", [made.visitIds]).del();
      await db('scheduled_services').whereIn('id', made.visitIds).del();
    }
    if (made.callIds.length) await db('call_log').whereIn('id', made.callIds).del();
    if (made.customerIds.length) {
      await db('customer_properties').whereIn('customer_id', made.customerIds).del();
      await db('customers').whereIn('id', made.customerIds).del();
    }
    await db.destroy();
  });

  test('links the visit to the call\'s customer: the booked address as a call-pipeline property, logged as the call recording\'s link', async () => {
    const customerId = await insertCustomer('Linked', '+15555550145');
    const { callId, visitId } = await bookedCall({ scheduledDate: '2031-04-07', customerId, token: 'tok-pass-1' });

    const out = await linkOfficeVisitFromCall({ call: { id: callId }, procToken: 'tok-pass-1', text: { ...TEXT_OK, callerPhone: '+15555550145' } });

    expect(out).toEqual({ outcome: 'linked', visitId, remindersArmed: true, confirmationSent: true, heldText: null });
    const visit = await db('scheduled_services').where({ id: visitId }).first('customer_id', 'property_id');
    expect(visit.customer_id).toBe(customerId);
    const property = await db('customer_properties').where({ id: visit.property_id }).first('address_line1', 'source', 'is_primary');
    expect(property).toEqual({ address_line1: '100 Example Way', source: 'call_pipeline', is_primary: false });
    const logged = await db('activity_log').where({ action: 'new_caller_visit_linked' }).whereRaw("metadata->>'scheduled_service_id' = ?", [visitId]).first('metadata');
    expect((typeof logged.metadata === 'string' ? JSON.parse(logged.metadata) : logged.metadata).linked_by).toBe('call_recording');
    expect(newCallerVisit.armLinkedVisitComms).toHaveBeenCalledWith({ visit: expect.objectContaining({ id: visitId, customer_id: customerId }), sendConfirmation: true });
  });

  test('a pass whose claim moved links nothing: a rotated token, or a call relinked to another customer inside the link', async () => {
    const customerId = await insertCustomer('Fenced', '+15555550146');
    const otherId = await insertCustomer('Other', '+15555550147');
    const { callId, visitId } = await bookedCall({ scheduledDate: '2031-04-08', customerId, token: 'tok-new' });

    await expect(linkOfficeVisitFromCall({ call: { id: callId }, procToken: 'tok-old', text: TEXT_OK })).resolves.toEqual({ outcome: 'claim_lost' });
    await expect(newCallerVisit.linkNewCallerVisit({ visitId, customerId, propertySource: 'call_pipeline', claimFence: { callLogId: callId, procToken: 'tok-old' } }))
      .rejects.toMatchObject({ status: 409, code: 'call_claim_lost' });
    await expect(newCallerVisit.linkNewCallerVisit({ visitId, customerId: otherId, propertySource: 'call_pipeline', claimFence: { callLogId: callId, procToken: 'tok-new' } }))
      .rejects.toMatchObject({ status: 409, code: 'call_customer_moved' });

    expect((await db('scheduled_services').where({ id: visitId }).first('customer_id')).customer_id).toBeNull();
    expect(await db('customer_properties').where({ customer_id: otherId, address_line1: '100 Example Way' }).first('id')).toBeUndefined();
    expect(newCallerVisit.armLinkedVisitComms).not.toHaveBeenCalled();
  });
});
