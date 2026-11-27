/**
 * visit_text_recipients on real PostgreSQL (GATE_CALL_GIVEN_VISIT_TEXTS, owner 2026-11-24 "yes, visit only").
 *
 * Proves the SQL semantics the unit suites only pin by shape, on the migrated database:
 *   - a number is recorded once per visit and number, so a retry of the call processing changes nothing
 *     and loses nothing;
 *   - the number is recorded on the visit the call booked and is owed texts for THAT visit only;
 *   - the excluded numbers (call legs, caller numbers, the account holder, a disclaimed number, a
 *     suppressed number) and a blocked call record nothing;
 *   - a text is claimed once per kind and slot, in one atomic write, so two senders never both send;
 *     a text that was not accepted is released and stays owed; a visit moved to a new slot is owed again;
 *   - the row goes with its visit, and the customer row is never written.
 *
 * Rows are committed (the claim race needs separate connections), made fresh in beforeEach with numbers
 * unique to this run, and deleted in afterEach and afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
// The provider is the one thing stubbed: the database, the send-window answer and every read are real.
jest.mock('../services/messaging/send-customer-message', () => ({
  ...jest.requireActual('../services/messaging/send-customer-message'),
  sendCustomerMessage: jest.fn(),
}));
// A service contact's own text choices need the contact-login tables; pass through (the module reads the person's choices
// row directly: getContactPrefRow + contactAllows, whatever GATE_CONTACT_LOGIN says), with a hook to force a decline.
jest.mock('../services/contact-notification-prefs', () => {
  const actual = jest.requireActual('../services/contact-notification-prefs');
  return {
    ...actual,
    getContactPrefRow: jest.fn((...args) => actual.getContactPrefRow(...args)),
  };
});

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
// Ten digits unique to this run: area code 941, five random digits, then a two-digit index.
const run = String(Math.floor(10000 + Math.random() * 89999));
const phone = (n) => `+1941${run}${String(100 + n).slice(-2)}`;
// Visit dates relative to today (ET), so the replay's "visit is upcoming" check never ages out of the fixture.
const { etDateString, parseETDateTime, formatETDate } = require('../utils/datetime-et');
const daysAhead = (n) => etDateString(new Date(Date.now() + n * 24 * 60 * 60 * 1000));
const VISIT_DATE = daysAhead(30);
const MOVED_DATE = daysAhead(38);
const NEXT_DATE = daysAhead(31);
const OTHER_DATE = daysAhead(90);
const VISIT_DATE_TEXT = formatETDate(parseETDateTime(`${VISIT_DATE}T09:00`));
const HOLDER = phone(1);
const BOB = phone(2);
const ANI = phone(10);
const OUR_LINE = phone(11);

const entry = (over = {}) => ({
  first_name: 'Bob', last_name: 'Roe', phone_e164: BOB, role: 'spouse_partner', wants_appointment_texts: true, ...over,
});
const extraction = (...entries) => ({ secondary_contacts: entries });

(SKIP ? describe.skip : describe)('visit_text_recipients on PostgreSQL', () => {
  let db;
  let VisitRecipient;
  let Holds;
  let customerId;
  let visitId;
  let otherVisitId;
  let callLogId;
  const suppressed = [];

  beforeAll(() => {
    db = require('../models/db');
    VisitRecipient = require('../services/call-visit-recipient');
    Holds = require('../services/disclaimed-number-holds');
  });

  const cleanup = async () => {
    if (customerId) {
      await db('sms_log').where({ customer_id: customerId }).del();
      await db('messaging_audit_log').where({ customer_id: customerId }).del();
      await db('customers').where({ id: customerId }).del();
    } // visits, then their recipient rows, cascade
    if (callLogId) {
      await db('disclaimed_number_holds').where({ source_call_log_id: callLogId }).del();
      await db('call_log').where({ id: callLogId }).del();
    }
    if (suppressed.length) await db('messaging_suppression').whereIn('phone', suppressed.splice(0)).del();
    customerId = null;
    callLogId = null;
  };

  afterAll(async () => {
    delete process.env[GATE];
    await cleanup();
    await db.destroy();
  });

  afterEach(cleanup);

  beforeEach(async () => {
    [{ id: customerId }] = await db('customers').insert({ first_name: 'Phyllis', last_name: 'Roe', phone: HOLDER }).returning('id');
    [{ id: visitId }] = await db('scheduled_services').insert({
      customer_id: customerId, scheduled_date: VISIT_DATE, window_start: '09:00', service_type: 'Pest Control', status: 'confirmed',
    }).returning('id');
    [{ id: otherVisitId }] = await db('scheduled_services').insert({
      customer_id: customerId, scheduled_date: OTHER_DATE, window_start: '09:00', service_type: 'Pest Control', status: 'confirmed',
    }).returning('id');
    [{ id: callLogId }] = await db('call_log').insert({ direction: 'inbound', from_phone: ANI, to_phone: OUR_LINE }).returning('id');
  });

  const suppress = async (number, active = true) => {
    await db('messaging_suppression').insert({ phone: number, active, reason: 'stop' });
    suppressed.push(number); // only a row THIS test inserted is ever deleted
  };
  const record = (extra = {}, ...entries) => VisitRecipient.recordForVisit({
    scheduledServiceId: visitId,
    callLogId,
    v2Extraction: extraction(...(entries.length ? entries : [entry()])),
    excludePhones: VisitRecipient.callerNumbers({ call: { from_phone: ANI, to_phone: OUR_LINE }, contactPhone: ANI }),
    ...extra,
  });
  const rows = () => db('visit_text_recipients').where({ scheduled_service_id: visitId });

  describe('recording', () => {
    test('Bob is recorded on the visit with E.164, source, version and the call id; a retry changes nothing', async () => {
      const first = await record();
      expect(first.recorded).toEqual([{ phoneKey: BOB.slice(-10), created: true }]);
      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        phone_e164: BOB,
        phone_key: BOB.slice(-10),
        first_name: 'Bob',
        source: 'call_caller_provided',
        consent_version: 'owner-ruling-2026-11-24-visit-only',
        call_log_id: callLogId,
        deliveries: {},
      });
      // Retry of the call pass, and a reprocess with a different extraction (the entry gone): nothing duplicated, nothing lost.
      const retry = await record();
      expect(retry.recorded).toEqual([{ phoneKey: BOB.slice(-10), created: false }]);
      await record({}, entry({ phone_e164: phone(99) }));
      const after = await rows();
      expect(after.map((row) => row.phone_key).sort()).toEqual([BOB.slice(-10), phone(99).slice(-10)]);
      expect(after.find((row) => row.phone_key === BOB.slice(-10)).id).toBe(stored[0].id);
    });

    test('a fresh call for the same visit and number REPLACES an ineligible row by delete-and-insert (a NEW id), and leaves an eligible one exactly as it is', async () => {
      await record({}, entry({ first_name: 'Bob', role: 'spouse_partner' }));
      const [first] = await rows();
      const claim = { 'confirmation:2031-01-01T09:00': 'token-1' };
      await db('visit_text_recipients').where({ id: first.id }).update({ track_token: `vr_${'d'.repeat(48)}`, deliveries: claim });
      // (1) already bound to the visit's customer: nothing changes, nothing is reported as created
      const same = await record({}, entry({ first_name: 'Robert', role: 'friend' }));
      expect(same.recorded).toEqual([{ phoneKey: BOB.slice(-10), created: false }]);
      const kept = (await rows())[0];
      expect(kept).toMatchObject({ id: first.id, first_name: 'Bob', role: 'spouse_partner', customer_id: customerId, track_token: `vr_${'d'.repeat(48)}` });
      expect(kept.deliveries).toEqual(claim);
      // (2) never bound (customer_id null): the old row is gone and a fresh one (new id) stands, with no token and no claims
      await db('visit_text_recipients').where({ id: first.id }).update({ customer_id: null });
      const [{ id: secondCall }] = await db('call_log').insert({ direction: 'inbound', from_phone: ANI, to_phone: OUR_LINE }).returning('id');
      try {
        const replaced = await record({ callLogId: secondCall }, entry({ first_name: 'Robert', role: 'friend' }));
        expect(replaced.recorded).toEqual([{ phoneKey: BOB.slice(-10), created: true }]);
        const after = await rows();
        expect(after).toHaveLength(1);
        expect(after[0].id).not.toBe(first.id);
        expect(after[0]).toMatchObject({ customer_id: customerId, call_log_id: secondCall, first_name: 'Robert', role: 'friend', track_token: null });
        expect(after[0].deliveries).toEqual({});
        expect(await db('visit_text_recipients').where({ id: first.id }).first()).toBeUndefined();
        // (3) bound to a customer the visit has since left: replaced the same way, with yet another id
        const [{ id: otherCustomerId }] = await db('customers').insert({ first_name: 'Zed', last_name: 'Other', phone: phone(41) }).returning('id');
        try {
          await db('visit_text_recipients').where({ id: after[0].id }).update({ customer_id: otherCustomerId, track_token: `vr_${'e'.repeat(48)}`, deliveries: claim });
          const again = await record({ callLogId: secondCall }, entry({ first_name: 'Rob' }));
          expect(again.recorded).toEqual([{ phoneKey: BOB.slice(-10), created: true }]);
          const final = await rows();
          expect(final).toHaveLength(1);
          expect(final[0].id).not.toBe(after[0].id);
          expect(final[0]).toMatchObject({ customer_id: customerId, first_name: 'Rob', track_token: null });
          expect(final[0].deliveries).toEqual({});
        } finally {
          await db('visit_text_recipients').where({ scheduled_service_id: visitId }).del();
          await db('customers').where({ id: otherCustomerId }).del();
        }
      } finally {
        await db('call_log').where({ id: secondCall }).del();
      }
    });

    test('concurrent authorizations from two customers for one visit: the visit\'s current customer\'s survives, never the stale one', async () => {
      const [{ id: otherCustomerId }] = await db('customers').insert({ first_name: 'Zed', last_name: 'Other', phone: phone(42) }).returning('id');
      try {
        // the visit now belongs to the OTHER customer (reassigned); calls from both customers race to record the same number
        await db('scheduled_services').where({ id: visitId }).update({ customer_id: otherCustomerId });
        const results = await Promise.all([
          record({ customerId }, entry({ first_name: 'Stale' })),
          record({ customerId: otherCustomerId }, entry({ first_name: 'Fresh' })),
          record({ customerId }, entry({ first_name: 'Stale2' })),
        ]);
        expect(results[0].skipped).toEqual([{ reason: 'customer_mismatch' }]);
        expect(results[2].skipped).toEqual([{ reason: 'customer_mismatch' }]);
        const stored = await rows();
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ customer_id: otherCustomerId, first_name: 'Fresh' });
        // and the other order: a row recorded for the old customer is replaced when the visit's new customer records
        await db('visit_text_recipients').where({ scheduled_service_id: visitId }).del();
        await db('scheduled_services').where({ id: visitId }).update({ customer_id: customerId });
        await record({ customerId }, entry({ first_name: 'Old' }));
        await db('scheduled_services').where({ id: visitId }).update({ customer_id: otherCustomerId });
        await Promise.all([record({ customerId: otherCustomerId }, entry({ first_name: 'Fresh' })), record({ customerId }, entry({ first_name: 'Stale' }))]);
        const settled = await rows();
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ customer_id: otherCustomerId, first_name: 'Fresh' });
      } finally {
        await db('scheduled_services').where({ id: visitId }).update({ customer_id: customerId });
        await db('visit_text_recipients').where({ scheduled_service_id: visitId }).del();
        await db('customers').where({ id: otherCustomerId }).del();
      }
    });

    test('a retry never resets a delivery claim', async () => {
      await record();
      const [contact] = await VisitRecipient.contactsForVisit(visitId, 'confirmation');
      await VisitRecipient.sendOnce(contact, async () => ({ sent: true }));
      await record();
      const [{ deliveries }] = await rows();
      expect(Object.keys(deliveries)).toEqual([`confirmation:${VISIT_DATE}T09:00`]);
    });

    test('nothing is recorded for a call leg, the caller, the account holder, a disclaimed or a suppressed number', async () => {
      await Holds.recordDisclaimedNumberHold({ phone: phone(3), callLogId });
      await suppress(phone(4));
      const result = await record({}, ...[ANI, OUR_LINE, HOLDER, phone(3), phone(4)].map((phone_e164) => entry({ phone_e164 })));
      expect(result.recorded).toEqual([]);
      expect(result.skipped.map((s) => s.reason).sort()).toEqual(['disclaimed_number', 'suppressed']);
      expect(await rows()).toEqual([]);
    });

    test('a lifted suppression and an inactive one do not block', async () => {
      await suppress(BOB, false);
      expect((await record()).recorded).toHaveLength(1);
    });

    test('a call whose SMS is blocked (do-not-contact, disclaimed caller number, TCPA gate) records nothing', async () => {
      const result = await record({ blocked: true });
      expect(result.recorded).toEqual([]);
      expect(await rows()).toEqual([]);
    });

    test('a report-only or presence-only entry, a flag on another entry, or an impossible number records nothing', async () => {
      await record({}, entry({ wants_appointment_texts: false, wants_notifications: true }), entry({ wants_appointment_texts: false, on_site: true }), entry({ phone_e164: null }), entry({ phone_e164: '+11735550100' }));
      expect(await rows()).toEqual([]);
    });
  });

  describe('who is owed a text', () => {
    test('Bob is owed the visit he was recorded on, with a slot-scoped claim key and no service-contact role', async () => {
      await record();
      const contacts = await VisitRecipient.contactsForVisit(visitId, 'reminder_24h');
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toMatchObject({
        phone: BOB, name: 'Bob Roe', role: 'visit_text_recipient', claimKey: `reminder_24h:${VISIT_DATE}T09:00`,
      });
      expect(contacts[0].role.startsWith('service_contact')).toBe(false);
    });

    test('before any send copies him, another visit has no row of its own', async () => {
      await record();
      expect(await VisitRecipient.contactsForVisit(otherVisitId, 'confirmation')).toEqual([]);
      expect(await VisitRecipient.contactsForVisit(otherVisitId, 'en_route')).toEqual([]);
    });

    test('a cancelled, skipped, completed, no-show or on-site visit sends nothing; a visit waiting to be rebooked announces nothing, keeps the recipient, and resumes on its new slot', async () => {
      await record();
      for (const status of ['cancelled', 'skipped', 'completed', 'no_show', 'on_site']) {
        await db('scheduled_services').where({ id: visitId }).update({ status });
        expect(await VisitRecipient.contactsForVisit(visitId, 'reminder_24h')).toEqual([]);
      }
      // The pending-rebook placeholder keeps the OBSOLETE slot: nothing is announced until the replacement slot is live.
      await db('scheduled_services').where({ id: visitId }).update({ status: 'rescheduled' });
      expect(await VisitRecipient.contactsForVisit(visitId, 'reminder_24h')).toEqual([]);
      await db('scheduled_services').where({ id: visitId }).update({ status: 'confirmed', scheduled_date: MOVED_DATE, window_start: '13:00' });
      const [moved] = await VisitRecipient.contactsForVisit(visitId, 'reminder_24h');
      expect(moved.claimKey).toBe(`reminder_24h:${MOVED_DATE}T13:00`);
    });

    test('a number the sender already texts, or the account holder number, is not listed again', async () => {
      await record();
      expect(await VisitRecipient.contactsForVisit(visitId, 'confirmation', { excludePhones: [BOB] })).toEqual([]);
      await db('customers').where({ id: customerId }).update({ phone: BOB });
      expect(await VisitRecipient.contactsForVisit(visitId, 'confirmation')).toEqual([]);
    });
  });

  describe('delivery claims', () => {
    test('a text is sent once per kind and slot, however many senders ask', async () => {
      await record();
      const [contact] = await VisitRecipient.contactsForVisit(visitId, 'confirmation');
      const send = jest.fn(async () => ({ sent: true }));
      const results = await Promise.all(Array.from({ length: 6 }, () => VisitRecipient.sendOnce(contact, send)));
      expect(send).toHaveBeenCalledTimes(1);
      expect(results.filter((r) => r.skipped)).toHaveLength(5);
      expect(results.filter((r) => r.skipped).every((r) => r.reason === 'already_sent')).toBe(true);
      const again = await VisitRecipient.sendOnce(contact, send);
      expect(again).toEqual({ skipped: true, reason: 'already_sent' });
      // Another kind on the same visit is its own claim.
      const [reminder] = await VisitRecipient.contactsForVisit(visitId, 'reminder_72h');
      await VisitRecipient.sendOnce(reminder, send);
      expect(send).toHaveBeenCalledTimes(2);
    });

    test('a text that was not accepted releases its claim and stays owed; an accepted or uncertain one keeps it', async () => {
      await record();
      const [contact] = await VisitRecipient.contactsForVisit(visitId, 'en_route');
      await VisitRecipient.sendOnce(contact, async () => ({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD' }));
      expect((await rows())[0].deliveries).toEqual({});
      await VisitRecipient.sendOnce(contact, async () => false);
      expect((await rows())[0].deliveries).toEqual({});
      const send = jest.fn(async () => ({ sent: true }));
      await VisitRecipient.sendOnce(contact, send);
      expect(Object.keys((await rows())[0].deliveries)).toEqual([contact.claimKey]);
      await VisitRecipient.sendOnce(contact, send);
      expect(send).toHaveBeenCalledTimes(1);
      await db('visit_text_recipients').where({ id: contact.visitRecipientId }).update({ deliveries: {} });
      await VisitRecipient.sendOnce(contact, async () => ({ sent: false, deliveryOutcome: 'uncertain' }));
      expect(Object.keys((await rows())[0].deliveries)).toEqual([contact.claimKey]);
    });

    test('a throw with no proof it never reached the provider keeps the claim (no double text)', async () => {
      await record();
      const [contact] = await VisitRecipient.contactsForVisit(visitId, 'confirmation');
      await expect(VisitRecipient.sendOnce(contact, async () => { throw new Error('socket hang up'); })).rejects.toThrow('socket hang up');
      expect(Object.keys((await rows())[0].deliveries)).toEqual([contact.claimKey]);
    });

    test('a visit moved to a new slot is owed its reminder again; the old slot stays claimed', async () => {
      await record();
      const send = jest.fn(async () => ({ sent: true }));
      const [first] = await VisitRecipient.contactsForVisit(visitId, 'reminder_24h');
      await VisitRecipient.sendOnce(first, send);
      await db('scheduled_services').where({ id: visitId }).update({ status: 'confirmed', scheduled_date: MOVED_DATE });
      const [moved] = await VisitRecipient.contactsForVisit(visitId, 'reminder_24h');
      await VisitRecipient.sendOnce(moved, send);
      await VisitRecipient.sendOnce(moved, send);
      expect(send).toHaveBeenCalledTimes(2);
      expect(Object.keys((await rows())[0].deliveries).sort()).toEqual([`reminder_24h:${VISIT_DATE}T09:00`, `reminder_24h:${MOVED_DATE}T09:00`].sort());
    });
  });

  describe('notifyVisitRecipients (real database, stubbed provider)', () => {
    let sendCustomerMessage;
    let getContactPrefRow;
    const HELD = {
      sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, retryable: true, nextAllowedAt: `${VISIT_DATE}T12:00:00.000Z`,
    };
    const notify = (kind, extra = {}) => VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind, excludePhones: [HOLDER], ...extra });
    const sentTo = () => sendCustomerMessage.mock.calls.map(([input]) => input.to);
    const queued = () => db('sms_log').where({ customer_id: customerId, to_phone: BOB, status: 'scheduled' });

    beforeEach(async () => {
      process.env[GATE] = 'true';
      ({ sendCustomerMessage } = require('../services/messaging/send-customer-message'));
      ({ getContactPrefRow } = require('../services/contact-notification-prefs'));
      sendCustomerMessage.mockReset();
      sendCustomerMessage.mockResolvedValue({ sent: true });
      await record();
    });
    afterEach(() => { delete process.env[GATE]; });

    test('Bob gets the informational confirmation once: no link, no customer-initiated exemption, no push routing, the visit named', async () => {
      await notify('confirmation');
      await notify('confirmation');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const input = sendCustomerMessage.mock.calls[0][0];
      expect(input).toMatchObject({
        to: BOB, channel: 'sms', purpose: 'appointment_confirmation', customerId, appointmentId: visitId, identityTrustLevel: 'phone_matches_customer',
        metadata: { original_message_type: 'confirmation', appointment_contact_role: 'visit_text_recipient' },
      });
      expect(input.customerInitiated).toBeUndefined();
      expect(input.metadata.useCustomerChannel).toBeUndefined();
      expect(input.body).toContain('Hi Bob,');
      expect(input.body).toContain(VISIT_DATE_TEXT);
      expect(input.body).not.toMatch(/https?:|www\.|reschedule|track/i);
    });

    // the visit as it is when the en-route text goes: en route by status AND tracker, with its start on record
    const EN_ROUTE_NOW = () => ({ status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 60 * 1000) });

    test('each kind is its own text; the reminders carry no link and the en-route text carries only Bob\'s OWN tracker link', async () => {
      const HOLDER_TOKEN = 'a'.repeat(64);
      await db('scheduled_services').where({ id: visitId }).update({ track_view_token: HOLDER_TOKEN, track_token_expires_at: new Date(Date.now() + 86400000), ...EN_ROUTE_NOW() });
      for (const kind of ['confirmation', 'reminder_72h', 'reminder_24h']) await notify(kind);
      await notify('en_route', { context: { techName: 'Pat', etaMinutes: 12, trackUrlFor: async (token) => `https://x.test/track/${token}` } });
      expect(sendCustomerMessage.mock.calls.map(([i]) => i.purpose)).toEqual([
        'appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h', 'tech_en_route',
      ]);
      for (const [input] of sendCustomerMessage.mock.calls.slice(0, 3)) expect(input.body).not.toMatch(/https?:|track|reschedule/i);
      const [{ track_token: bobToken }] = await rows();
      expect(bobToken).toMatch(/^vr_[a-f0-9]{48}$/);
      expect(bobToken).not.toBe(HOLDER_TOKEN);
      const enRouteBody = sendCustomerMessage.mock.calls[3][0].body;
      expect(enRouteBody).toContain(`Pat is on the way, about 12 minutes away. Track live: https://x.test/track/${bobToken}`);
      expect(enRouteBody).not.toContain(HOLDER_TOKEN);
      expect(enRouteBody).not.toMatch(/reschedule/i);
    });

    test('a sender that passes the holder\'s link in the context still gets no holder link into the text', async () => {
      await notify('en_route', { context: { techName: 'Pat', trackUrl: 'https://x.test/track/HOLDERLINK' } });
      expect(sendCustomerMessage.mock.calls[0][0].body).not.toContain('HOLDERLINK');
      expect(sendCustomerMessage.mock.calls[0][0].body).not.toContain('Track live');
      expect((await rows())[0].track_token).toBeNull();
    });

    test('a visit whose own link has no live expiry gets the text without a link, and no token is minted', async () => {
      const builder = jest.fn(async (token) => `https://x.test/track/${token}`);
      for (const expiry of [null, new Date(Date.now() - 1000)]) {
        sendCustomerMessage.mockClear();
        await db('visit_text_recipients').where({ scheduled_service_id: visitId }).update({ deliveries: '{}' });
        await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: expiry });
        await notify('en_route', { context: { techName: 'Pat', trackUrlFor: builder } });
        expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
        expect(sendCustomerMessage.mock.calls[0][0].body).not.toContain('Track live');
        expect((await rows())[0].track_token).toBeNull();
      }
      expect(builder).not.toHaveBeenCalled();
    });

    test('a visit the tracker route would NOT open (not en route / on site / just completed, parked, a stale start) gets the text without a link, and no token is minted', async () => {
      const builder = jest.fn(async (token) => `https://x.test/track/${token}`);
      const live = new Date(Date.now() + 86400000);
      const HOUR = 60 * 60 * 1000;
      const states = [
        { status: 'confirmed', track_state: 'scheduled' },
        { status: 'cancelled', track_state: 'cancelled' },
        { status: 'en_route', track_state: 'en_route', en_route_at: null },
        { status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 4 * HOUR) },
        { status: 'en_route', track_state: 'scheduled', en_route_at: new Date(Date.now() - 60000) },
        { ...EN_ROUTE_NOW(), customer_pick_by: new Date(Date.now() + HOUR), window_start: null },
      ];
      for (const state of states) {
        sendCustomerMessage.mockClear();
        await db('visit_text_recipients').where({ scheduled_service_id: visitId }).update({ deliveries: '{}' });
        await db('scheduled_services').where({ id: visitId }).update({ status: 'confirmed', track_state: 'scheduled', en_route_at: null, customer_pick_by: null, window_start: '09:00', track_token_expires_at: live, ...state });
        await notify('en_route', { context: { techName: 'Pat', trackUrlFor: builder } });
        if (state.status === 'cancelled') { expect(sendCustomerMessage).not.toHaveBeenCalled(); continue; }
        expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
        expect(sendCustomerMessage.mock.calls[0][0].body).not.toContain('Track live');
        expect((await rows())[0].track_token).toBeNull();
      }
      expect(builder).not.toHaveBeenCalled();
      // control: the same visit en route now gets its link
      sendCustomerMessage.mockClear();
      await db('visit_text_recipients').where({ scheduled_service_id: visitId }).update({ deliveries: '{}' });
      await db('scheduled_services').where({ id: visitId }).update({ ...EN_ROUTE_NOW(), customer_pick_by: null, window_start: '09:00' });
      await notify('en_route', { context: { techName: 'Pat', trackUrlFor: builder } });
      expect(sendCustomerMessage.mock.calls[0][0].body).toContain('Track live');
      expect((await rows())[0].track_token).toMatch(/^vr_[a-f0-9]{48}$/);
    });

    test('the link is made only after the slot claim is won: repeated or concurrent attempts mint one link and one token, a skipped attempt mints nothing', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000), ...EN_ROUTE_NOW() });
      const builder = jest.fn(async (token) => `https://x.test/track/${token}`);
      const attempt = () => notify('en_route', { context: { techName: 'Pat', trackUrlFor: builder } });
      await Promise.all([attempt(), attempt(), attempt()]);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(builder).toHaveBeenCalledTimes(1);
      await attempt();
      await attempt();
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(builder).toHaveBeenCalledTimes(1);
      expect((await rows())[0].track_token).toMatch(/^vr_[a-f0-9]{48}$/);
    });

    test('a skipped attempt mints no token: with the slot already claimed, no token and no link are made', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000), ...EN_ROUTE_NOW() });
      await db('visit_text_recipients').where({ scheduled_service_id: visitId }).update({ deliveries: JSON.stringify({ [`en_route:${VISIT_DATE}T09:00`]: 'claimed-elsewhere' }) });
      const builder = jest.fn(async (token) => `https://x.test/track/${token}`);
      await notify('en_route', { context: { techName: 'Pat', trackUrlFor: builder } });
      expect(builder).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((await rows())[0].track_token).toBeNull();
    });

    test('a link builder that fails sends the text without a link', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000), ...EN_ROUTE_NOW() });
      await notify('en_route', { context: { techName: 'Pat', trackUrlFor: async () => { throw new Error('shortener down'); } } });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage.mock.calls[0][0].body).not.toContain('Track live');
    });

    test('Bob gets nothing for a cancelled visit, or when the sender already texts his number', async () => {
      await notify('confirmation', { excludePhones: [HOLDER, BOB] });
      await db('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
      await notify('confirmation');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    describe('every visit (customer_reminder_contacts; owner 2026-11-26 "simpler")', () => {
      const listed = () => db('customer_reminder_contacts').where({ customer_id: customerId });
      const otherRows = () => db('visit_text_recipients').where({ scheduled_service_id: otherVisitId });

      test('a recorded person goes on the customer\'s list once; a retry and a second call change nothing', async () => {
        await record();
        await record({}, entry({ first_name: 'Robert' }));
        const list = await listed();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ phone_key: BOB.slice(-10), phone_e164: BOB, first_name: 'Bob', call_log_id: callLogId, consent_version: 'owner-ruling-2026-11-24-every-visit' });
      });

      test('Bob gets the texts of ANOTHER visit of the same customer, once, through a copied visit row', async () => {
        await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: otherVisitId, kind: 'confirmation', excludePhones: [HOLDER] });
        await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: otherVisitId, kind: 'confirmation', excludePhones: [HOLDER] });
        expect(sentTo()).toEqual([BOB]);
        const copied = await otherRows();
        expect(copied).toHaveLength(1);
        expect(copied[0]).toMatchObject({ phone_key: BOB.slice(-10), customer_id: customerId, source: 'customer_reminder_contact' });
      });

      test('a visit of ANOTHER customer gets nothing, and a visit moved to another customer gets that customer\'s list only', async () => {
        const [{ id: otherCustomerId }] = await db('customers').insert({ first_name: 'Zed', last_name: 'Other', phone: phone(43) }).returning('id');
        try {
          await db('scheduled_services').where({ id: otherVisitId }).update({ customer_id: otherCustomerId });
          await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: otherVisitId, kind: 'confirmation', excludePhones: [HOLDER] });
          expect(sendCustomerMessage).not.toHaveBeenCalled();
          expect(await otherRows()).toHaveLength(0);
        } finally {
          await db('scheduled_services').where({ id: otherVisitId }).update({ customer_id: customerId });
          await db('customers').where({ id: otherCustomerId }).del();
        }
      });

      test('a notice built for another customer copies and sends nothing (one staff bell)', async () => {
        const notifications = require('../services/notification-service');
        const bell = jest.spyOn(notifications, 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
        try {
          await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: otherVisitId, kind: 'confirmation', customerId: '00000000-0000-0000-0000-000000000001', excludePhones: [HOLDER] });
          expect(sendCustomerMessage).not.toHaveBeenCalled();
          expect(await otherRows()).toHaveLength(0);
          expect(bell).toHaveBeenCalledTimes(1);
        } finally {
          bell.mockRestore();
        }
      });

      test('a closed visit keeps its old rows: the copy never deletes or rebinds on a cancelled or completed visit', async () => {
        const [{ id: otherCustomerId }] = await db('customers').insert({ first_name: 'Zed', last_name: 'Other', phone: phone(47) }).returning('id');
        try {
          const [{ id: oldRow }] = await db('visit_text_recipients').insert({
            scheduled_service_id: otherVisitId, customer_id: otherCustomerId, phone_key: BOB.slice(-10), phone_e164: BOB, consent_version: 'x',
          }).returning('id');
          await db('scheduled_services').where({ id: otherVisitId }).update({ status: 'completed' });
          await VisitRecipient.materializeForVisit(otherVisitId);
          expect((await otherRows()).map((r) => r.id)).toEqual([oldRow]);
        } finally {
          await db('visit_text_recipients').where({ scheduled_service_id: otherVisitId }).del();
          await db('customers').where({ id: otherCustomerId }).del();
        }
      });

      test('a cancelled or waiting-to-rebook visit copies nobody', async () => {
        for (const status of ['cancelled', 'rescheduled', 'completed']) {
          await db('scheduled_services').where({ id: otherVisitId }).update({ status });
          await VisitRecipient.materializeForVisit(otherVisitId);
          expect(await otherRows()).toHaveLength(0);
        }
      });


      test('"just this visit" records the visit only and puts nobody on the list; it never narrows a listed person', async () => {
        // Bob is listed (every visit) by the beforeEach call; a "just this visit" person joins the visit only
        await record({}, entry({ phone_e164: phone(60), appointment_texts_scope: 'this_visit' }));
        expect((await rows()).map((row) => row.phone_key)).toContain(phone(60).slice(-10));
        // a "just this visit" answer about Bob removes nothing
        await record({}, entry({ appointment_texts_scope: 'this_visit' }));
        const list = await listed();
        expect(list.map((row) => row.phone_key)).toEqual([BOB.slice(-10)]);
      });

      test('once a visit has the person, no reprocess and no second call about that visit lists them; a call about another visit can', async () => {
        await db('customer_reminder_contacts').where({ customer_id: customerId }).del();
        const CARL = phone(61);
        await record({}, entry({ phone_e164: CARL, appointment_texts_scope: 'this_visit' }));
        await record({}, entry({ phone_e164: CARL }));
        const [{ id: laterCall }] = await db('call_log').insert({ direction: 'inbound', from_phone: ANI, to_phone: OUR_LINE }).returning('id');
        try {
          await record({ callLogId: laterCall }, entry({ phone_e164: CARL, appointment_texts_scope: 'ongoing' }));
          expect(await listed()).toHaveLength(0);
          await record({ callLogId: laterCall, scheduledServiceId: otherVisitId }, entry({ phone_e164: CARL, appointment_texts_scope: 'ongoing' }));
          expect((await listed()).map((row) => row.phone_key)).toEqual([CARL.slice(-10)]);
        } finally {
          await db('customer_reminder_contacts').where({ customer_id: customerId }).del();
          await db('visit_text_recipients').where({ scheduled_service_id: otherVisitId }).del();
          await db('call_log').where({ id: laterCall }).del();
        }
      });

      test('a left-over row for the same number bound to another customer is replaced by a fresh row (new id, no token, no claims)', async () => {
        const [{ id: otherCustomerId }] = await db('customers').insert({ first_name: 'Zed', last_name: 'Other', phone: phone(44) }).returning('id');
        try {
          const [{ id: staleId }] = await db('visit_text_recipients').insert({
            scheduled_service_id: otherVisitId, customer_id: otherCustomerId, phone_key: BOB.slice(-10), phone_e164: BOB,
            source: 'call_caller_provided', consent_version: 'x', track_token: `vr_${'f'.repeat(48)}`,
            deliveries: { [`confirmation:${OTHER_DATE}T09:00`]: 'old' },
          }).returning('id');
          await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: otherVisitId, kind: 'confirmation', excludePhones: [HOLDER] });
          expect(sentTo()).toEqual([BOB]);
          const copied = await otherRows();
          expect(copied).toHaveLength(1);
          expect(copied[0].id).not.toBe(staleId);
          expect(copied[0]).toMatchObject({ customer_id: customerId, source: 'customer_reminder_contact' });
          expect(copied[0].track_token).not.toBe(`vr_${'f'.repeat(48)}`);
        } finally {
          await db('visit_text_recipients').where({ scheduled_service_id: otherVisitId }).del();
          await db('customers').where({ id: otherCustomerId }).del();
        }
      });

      test('a call about a visit that has a LIVE list copy leaves it as it is (link, claims, entry)', async () => {
        await VisitRecipient.materializeForVisit(otherVisitId);
        const [copy] = await otherRows();
        await db('visit_text_recipients').where({ id: copy.id }).update({ track_token: `vr_${'a'.repeat(48)}` });
        const again = await record({ scheduledServiceId: otherVisitId }, entry({ appointment_texts_scope: 'this_visit' }));
        expect(again.recorded).toEqual([{ phoneKey: BOB.slice(-10), created: false }]);
        const [row] = await otherRows();
        expect(row).toMatchObject({ id: copy.id, source: 'customer_reminder_contact', track_token: `vr_${'a'.repeat(48)}` });
      });

      test('a copy moved to an account that does not list the number grants nothing: no text, no link', async () => {
        await VisitRecipient.materializeForVisit(otherVisitId);
        const [{ id: winnerId }] = await db('customers').insert({ first_name: 'Win', last_name: 'Ner', phone: phone(49) }).returning('id');
        try {
          // what a merge does: the visit and its rows move to the winner; the list stays on the old account
          await db('scheduled_services').where({ id: otherVisitId }).update({ customer_id: winnerId });
          await db('visit_text_recipients').where({ scheduled_service_id: otherVisitId }).update({ customer_id: winnerId });
          expect(await VisitRecipient.contactsForVisit(otherVisitId, 'confirmation')).toEqual([]);
          expect(await VisitRecipient.contactsForVisit(otherVisitId, 'en_route', { anyVisitStatus: true })).toEqual([]);
          // a call from the winner naming the person for this visit takes the stale copy over (same id, claims and link kept)
          await db('visit_text_recipients').where({ scheduled_service_id: otherVisitId }).update({ track_token: `vr_${'d'.repeat(48)}` });
          const [stale] = await otherRows();
          const taken = await record({ scheduledServiceId: otherVisitId, customerId: winnerId }, entry({ appointment_texts_scope: 'this_visit' }));
          expect(taken.recorded).toEqual([{ phoneKey: BOB.slice(-10), created: true }]);
          const [row] = await otherRows();
          expect(row).toMatchObject({ id: stale.id, source: 'call_caller_provided', customer_id: winnerId, track_token: `vr_${'d'.repeat(48)}` });
          expect(await VisitRecipient.contactsForVisit(otherVisitId, 'confirmation')).toHaveLength(1);
          expect(await db('customer_reminder_contacts').where({ customer_id: winnerId })).toHaveLength(0);
        } finally {
          await db('scheduled_services').where({ id: otherVisitId }).update({ customer_id: customerId });
          await db('visit_text_recipients').where({ scheduled_service_id: otherVisitId }).del();
          await db('customers').where({ id: winnerId }).del();
        }
      });

      test('a customer merge never moves the list: the loser\'s entries stay on the loser', async () => {
        const { REPOINT_EXCLUDED_TABLES } = require('../services/customer-dedupe');
        expect(REPOINT_EXCLUDED_TABLES.has('customer_reminder_contacts')).toBe(true);
      });

    });

    test('an existing decline is honored by every sender: a recipient_optin decline, STOP or suppression, and his own text choices', async () => {
      const optinRow = { customer_id: customerId, phone_key: BOB.slice(-10), phone_e164: BOB };
      await db('recipient_optin').insert({ ...optinRow, status: 'declined' });
      await notify('confirmation');
      await db('recipient_optin').where({ customer_id: customerId }).del();
      await suppress(BOB);
      await notify('reminder_72h');
      await db('messaging_suppression').where({ phone: BOB }).del();
      getContactPrefRow.mockResolvedValueOnce({ tech_en_route: false });
      await notify('en_route');
      expect(getContactPrefRow).toHaveBeenCalledWith(customerId, BOB, expect.any(Object));
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      // A pending Reply-YES ask is NOT a decline: this is the permission that does not wait for the YES.
      await db('recipient_optin').insert({ ...optinRow, status: 'pending' });
      await notify('reminder_24h');
      expect(sentTo()).toEqual([BOB]);
    });

    test('a text with an unknown fate keeps its claim and is never resent; a blocked text gives the claim back', async () => {
      sendCustomerMessage.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'uncertain' });
      await notify('confirmation');
      await notify('confirmation');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'NON_MOBILE_SMS_RECIPIENT' });
      await notify('reminder_72h');
      await notify('reminder_72h');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(3);
    });

    test('a confirmation or 72 h reminder held for the send window is persisted for the replay, and not resent meanwhile', async () => {
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      await notify('confirmation');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const [row] = await queued();
      expect(row).toMatchObject({ to_phone: BOB, message_type: 'confirmation', customer_id: customerId });
      expect(row.scheduled_for).toEqual(new Date(HELD.nextAllowedAt));
      expect(row.message_body).toContain('Hi Bob,');
      expect(row.metadata).toMatchObject({
        entry_point: 'visit_text_recipient_deferred', scheduled_service_id: visitId, kind: 'confirmation',
        replay_purpose: 'appointment_confirmation', requires_registered_dispatch: true, slot_scheduled_date: VISIT_DATE, slot_window_start: '09:00',
      });
      expect(row.metadata.refresh_customer_phone).toBeUndefined();
      // The replay's fresh check: owed now; gate off, a moved slot, a decline or a cancelled visit each suppress it.
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toEqual({ eligible: true });
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', { ...meta, slot_scheduled_date: NEXT_DATE })).toMatchObject({ eligible: false });
      await db('recipient_optin').insert({ customer_id: customerId, phone_key: BOB.slice(-10), phone_e164: BOB, status: 'declined' });
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toMatchObject({ eligible: false, reason: 'recipient-not-owed' });
      await db('recipient_optin').where({ customer_id: customerId }).del();
      delete process.env[GATE];
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toMatchObject({ eligible: false });
      process.env[GATE] = 'true';
      await db('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toMatchObject({ eligible: false });
    });

    test('a queued replay carrying the OLD row id is dropped once the number is rebound to a new row; the new confirmation is sent once', async () => {
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [row] = await queued();
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      // the send carried the row id AND its customer binding
      expect(meta.recipient_customer_id).toBe(customerId);
      expect(meta.visit_recipient_id).toBeTruthy();
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toEqual({ eligible: true });
      // a replay that names no customer binding is not owed either
      const { recipient_customer_id: _unbound, ...withoutBinding } = meta;
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', withoutBinding)).toMatchObject({ eligible: false, reason: 'recipient-not-owed' });
      // the visit is reassigned to another customer, whose call records the same number: delete-and-insert, a NEW row id
      const [{ id: otherCustomerId }] = await db('customers').insert({ first_name: 'Zed', last_name: 'Other', phone: phone(43) }).returning('id');
      try {
        await db('scheduled_services').where({ id: visitId }).update({ customer_id: otherCustomerId });
        await VisitRecipient.recordForVisit({ scheduledServiceId: visitId, customerId: otherCustomerId, callLogId, v2Extraction: extraction(entry()), excludePhones: [] });
        const [fresh] = await rows();
        expect(fresh.id).not.toBe(meta.visit_recipient_id);
        expect(fresh.customer_id).toBe(otherCustomerId);
        // the OLD queued replay (old id, old binding) finds no row and drops, at the replay recheck and at the provider handoff
        expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toMatchObject({ eligible: false, reason: 'recipient-not-owed' });
        expect(await VisitRecipient.providerCheck({ ...meta, replay: true })).toMatchObject({ ok: false, code: 'VISIT_RECIPIENT_NOT_OWED' });
        // the new row's confirmation goes out once
        sendCustomerMessage.mockReset();
        sendCustomerMessage.mockResolvedValue({ sent: true });
        await notify('confirmation');
        await notify('confirmation');
        expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
        // and that send's own recheck (its row id and binding) passes at the handoff
        const handoff = await sendCustomerMessage.mock.calls[0][0].providerPreSendCheck();
        expect(handoff).toEqual({ ok: true });
      } finally {
        await db('scheduled_services').where({ id: visitId }).update({ customer_id: customerId });
        await db('visit_text_recipients').where({ scheduled_service_id: visitId }).del();
        await db('sms_log').where({ customer_id: otherCustomerId }).del();
        await db('customers').where({ id: otherCustomerId }).del();
      }
    });

    test('a replay that ends without a send gives the claim back, so a later sender still owes the text', async () => {
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [row] = await queued();
      await notify('confirmation');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const { onTerminalDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      await onTerminalDeferredReplay('visit_text_recipient_deferred', { ...row.metadata, to_phone: BOB, customer_id: customerId });
      await notify('confirmation');
      expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    });

    test('a held 24 h reminder or en-route text is dropped, not queued, and stays owed to a later sender', async () => {
      sendCustomerMessage.mockResolvedValue(HELD);
      await notify('reminder_24h');
      await notify('en_route', { context: { techName: 'Pat' } });
      expect(await queued()).toEqual([]);
      sendCustomerMessage.mockResolvedValue({ sent: true });
      await notify('reminder_24h');
      await notify('en_route', { context: { techName: 'Pat' } });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(4);
    });

    test('an aborting gate stops the loop; a skipping gate sends nothing for that person', async () => {
      await expect(notify('confirmation', { gate: async () => 'skip' })).resolves.toBe(true);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      await expect(notify('confirmation', { gate: async () => 'abort' })).resolves.toBe(false);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('every send names the visit and the role in its metadata (a bounce is recognised as the recipient\'s), and the sender is "Waves"', async () => {
      for (const kind of ['confirmation', 'reminder_72h', 'reminder_24h']) await notify(kind);
      await notify('en_route', { context: { techName: 'Pat' } });
      for (const [input] of sendCustomerMessage.mock.calls) {
        expect(input.metadata).toMatchObject({ appointment_contact_role: 'visit_text_recipient', scheduled_service_id: visitId });
        expect(input.body).toMatch(/\bWaves\b/);
        expect(input.body).not.toContain('Waves Pest Control');
      }
    });

    test('a day-only notice gives the person the same day promise: day copy, the day marker, no arrival window', async () => {
      await notify('confirmation', { dayOnly: true });
      const input = sendCustomerMessage.mock.calls[0][0];
      expect(input.body).toContain(`scheduled for`);
      expect(input.body).toContain('We will text you the arrival window the day before');
      expect(input.body).not.toMatch(/arriving|between/);
      expect(input.promisedWindowUnknown).toBe(true);
      expect(input.metadata).toMatchObject({ promise_level: 'day', window_unknown: true, promised_date: VISIT_DATE });
      // A 24 h reminder is always the window copy, whatever the holder's notice promised.
      await notify('reminder_24h', { dayOnly: true });
      expect(sendCustomerMessage.mock.calls[1][0].body).toMatch(/arriving/);
      expect(sendCustomerMessage.mock.calls[1][0].metadata.promise_level).toBeUndefined();
    });

    test('a held day-only text is queued with its day promise, so the replay records a day promise and rechecks it', async () => {
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('reminder_72h', { dayOnly: true });
      const [row] = await queued();
      expect(row.metadata).toMatchObject({ promise_level: 'day', window_unknown: true, promised_date: VISIT_DATE, appointment_contact_role: 'visit_text_recipient' });
      expect(row.message_body).not.toMatch(/arriving/);
      const entry = require('../services/messaging/deferred-replay-registry')._registry.visit_text_recipient_deferred;
      expect(entry.recheck.toString()).toContain('dayPromiseStillValid');
    });

    test('the copy and the move guard come from ONE arrival: a later service in a combined reservation quotes and guards the shared start', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ window_start: '11:00', reservation_service_mix: JSON.stringify({ allocatedServiceIds: [visitId] }) });
      const { rows: [{ start }] } = await db.raw('SELECT reservation_arrival_start(?) AS start', [visitId]);
      await notify('confirmation');
      const input = sendCustomerMessage.mock.calls[0][0];
      const { spokenArrivalWindow } = require('../utils/sms-time-format');
      const shared = String(start || '11:00').slice(0, 5);
      expect(input.body).toContain(spokenArrivalWindow(shared));
      expect(input.renderedSlotMs).toBe(parseETDateTime(`${VISIT_DATE}T${shared}`).getTime());
    });

    test('the send carries a provider-handoff recheck of the permission: it passes now, and fails once the person declines, the gate goes off or the visit is on a callback-number hold', async () => {
      await notify('confirmation');
      const input = sendCustomerMessage.mock.calls[0][0];
      expect(typeof input.providerPreSendCheck).toBe('function');
      expect(await input.providerPreSendCheck({ channel: 'sms' })).toEqual({ ok: true });
      await db('recipient_optin').insert({ customer_id: customerId, phone_key: BOB.slice(-10), phone_e164: BOB, status: 'declined' });
      expect(await input.providerPreSendCheck({ channel: 'sms' })).toMatchObject({ ok: false, code: 'VISIT_RECIPIENT_NOT_OWED' });
      await db('recipient_optin').where({ customer_id: customerId }).del();
      await suppress(BOB);
      expect(await input.providerPreSendCheck({ channel: 'sms' })).toMatchObject({ ok: false });
      await db('messaging_suppression').where({ phone: BOB }).del();
      expect(await input.providerPreSendCheck({ channel: 'sms' })).toEqual({ ok: true });
      // The visit-wide hold: the caller\'s number on the account was disclaimed (a hold on THAT number, not on Bob\'s).
      await db('disclaimed_number_holds').insert({ phone_e164: HOLDER, customer_id: customerId, source_call_log_id: callLogId, held_at: new Date() });
      expect(await input.providerPreSendCheck({ channel: 'sms' })).toMatchObject({ ok: false, code: 'CALLBACK_NUMBER_HOLD' });
      await db('disclaimed_number_holds').where({ source_call_log_id: callLogId }).del();
      delete process.env[GATE];
      expect(await input.providerPreSendCheck({ channel: 'sms' })).toMatchObject({ ok: false, code: 'VISIT_TEXT_GATE_OFF' });
    });

    test('the replay recheck\'s failure carries a code only: the registry\'s fail-closed log holds no phone, and the row is held for a retry', async () => {
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      const holds = require('../services/disclaimed-number-holds');
      const logger = require('../services/logger');
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [queuedRow] = await queued();
      const meta = { ...queuedRow.metadata, to_phone: BOB, customer_id: customerId };
      const spy = jest.spyOn(holds, 'disclaimedNumberHeld').mockRejectedValue(Object.assign(new Error(`select from holds where phone_e164 = '${BOB}' - connection terminated`), { code: '57P01' }));
      try {
        const verdict = await recheckDeferredReplay('visit_text_recipient_deferred', meta);
        expect(verdict).toMatchObject({ eligible: false, retryable: true });
        const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
        expect(logged).toContain('holding for retry');
        expect(logged).not.toContain(BOB.slice(-10));
        // the claim release at a terminal replay is code-only too
        const failingConn = Object.assign(() => { throw Object.assign(new Error(`update visit_text_recipients set deliveries ... '${BOB}'`), { code: '57P01' }); }, { raw: db.raw.bind(db) });
        const releaseErr = await VisitRecipient.releaseDeferredClaim({ visit_recipient_id: 'r-1', claim_key: 'k', claim_token: 't' }, { conn: failingConn }).catch((e) => e);
        expect(releaseErr.code).toBe('57P01');
        expect(`${releaseErr.message} ${releaseErr.stack}`).not.toContain(BOB.slice(-10));
      } finally {
        spy.mockRestore();
      }
    });

    test('a queued window text is pinned to the arrival it quoted AND the slot; a same-day time change keeps a still-valid day-only text', async () => {
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [windowRow] = await queued();
      expect(windowRow.metadata.arrival_start).toBe('09:00');
      const windowMeta = { ...windowRow.metadata, to_phone: BOB, customer_id: customerId };
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', windowMeta)).toEqual({ eligible: true });
      // The shared arrival moves while this member\'s own start stays fixed: the queued window is no longer true.
      expect(await VisitRecipient.recipientStillOwed({ ...windowRow.metadata, arrival_start: '10:30' })).toMatchObject({ ok: false, code: 'VISIT_ARRIVAL_MOVED' });
      // A same-day time change drops a window text, but not a day-only one on the same date.
      await db('scheduled_services').where({ id: visitId }).update({ window_start: '13:00' });
      expect(await VisitRecipient.recipientStillOwed(windowMeta)).toMatchObject({ ok: false, code: 'VISIT_SLOT_MOVED' });
      expect(await VisitRecipient.recipientStillOwed({ ...windowMeta, promise_level: 'day', arrival_start: undefined })).toEqual({ ok: true });
      // A different DATE drops the day-only one too.
      await db('scheduled_services').where({ id: visitId }).update({ scheduled_date: MOVED_DATE });
      expect(await VisitRecipient.recipientStillOwed({ ...windowMeta, promise_level: 'day', arrival_start: undefined })).toMatchObject({ ok: false, code: 'VISIT_SLOT_MOVED' });
    });

    test('a replay honors a callback-number hold put on the visit overnight, and its provider handoff rechecks it too', async () => {
      const { recheckDeferredReplay, deferredProviderPreSendCheck } = require('../services/messaging/deferred-replay-registry');
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [row] = await queued();
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      await db('disclaimed_number_holds').insert({ phone_e164: HOLDER, customer_id: customerId, source_call_log_id: callLogId, held_at: new Date() });
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toMatchObject({ eligible: false });
      const check = deferredProviderPreSendCheck('visit_text_recipient_deferred', meta);
      expect(typeof check).toBe('function');
      expect(await check({ channel: 'sms' })).toMatchObject({ ok: false, code: 'CALLBACK_NUMBER_HOLD' });
      await db('disclaimed_number_holds').where({ source_call_log_id: callLogId }).del();
      expect(await check({ channel: 'sms' })).toEqual({ ok: true });
    });

    test('the claim holds a token: a replay releases only ITS claim, a repeat of the hook after another sender claimed the slot deletes nothing, and a failed release throws', async () => {
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [row] = await queued();
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      expect(typeof meta.claim_token).toBe('string');
      expect((await rows())[0].deliveries[meta.claim_key]).toBe(meta.claim_token);
      await VisitRecipient.releaseDeferredClaim(meta);
      expect((await rows())[0].deliveries).toEqual({});
      // Another sender claims the same kind and slot and delivers; the hook runs again (a worker crashed before clearing it).
      sendCustomerMessage.mockResolvedValueOnce({ sent: true });
      await notify('confirmation');
      const [{ deliveries }] = await rows();
      expect(deliveries[meta.claim_key]).toBeDefined();
      await VisitRecipient.releaseDeferredClaim(meta);
      expect((await rows())[0].deliveries[meta.claim_key]).toBe(deliveries[meta.claim_key]);
      // A row queued before tokens existed proves no ownership: nothing is released.
      await VisitRecipient.releaseDeferredClaim({ ...meta, claim_token: undefined });
      expect((await rows())[0].deliveries[meta.claim_key]).toBe(deliveries[meta.claim_key]);
      // A failed release is thrown to the worker, which retries the hook.
      const failing = jest.fn(() => { const q = { where: () => q, whereRaw: () => q, update: () => Promise.reject(new Error('db down')) }; return q; });
      failing.raw = db.raw.bind(db);
      await expect(VisitRecipient.releaseDeferredClaim(meta, { conn: failing })).rejects.toMatchObject({ message: 'visit-only replay release failed' });
    });

    test('a failed callback-hold read is retried, never read as a hold: the handoff check says retry and the replay holds the row', async () => {
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [row] = await queued();
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      const spy = jest.spyOn(Holds, 'disclaimedNumberHeldForVisit').mockRejectedValue(new Error('read failed'));
      try {
        await expect(VisitRecipient.recipientStillOwed(meta)).rejects.toThrow('read failed');
        expect(await VisitRecipient.providerCheck(meta)).toMatchObject({ ok: false, code: 'VISIT_RECIPIENT_CHECK_FAILED', retryable: true });
        expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toMatchObject({ eligible: false, retryable: true });
      } finally { spy.mockRestore(); }
    });

    test('a DEFERRED replay rings the manual-text bell only on its LAST attempt; an immediate send rings at once', async () => {
      const { SCHEDULED_SMS_MAX_ATTEMPTS } = require('../services/messaging/scheduled-sms-limits');
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [row] = await queued();
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      const notifications = require('../services/notification-service');
      const bell = jest.spyOn(notifications, 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
      const spy = jest.spyOn(Holds, 'disclaimedNumberHeldForVisit').mockRejectedValue(new Error('read failed'));
      try {
        // earlier attempts: held for a retry, quietly
        for (let attempt = 1; attempt < SCHEDULED_SMS_MAX_ATTEMPTS; attempt += 1) {
          expect(await VisitRecipient.providerCheck({ ...meta, replay: true, scheduled_sms_attempts: attempt })).toMatchObject({ ok: false, code: 'VISIT_RECIPIENT_CHECK_FAILED', retryable: true });
        }
        expect(await VisitRecipient.providerCheck({ ...meta, replay: true })).toMatchObject({ retryable: true });
        expect(bell).not.toHaveBeenCalled();
        // the last attempt ends undelivered: the bell rings, naming the person by first name and last 4 only
        expect(await VisitRecipient.providerCheck({ ...meta, replay: true, scheduled_sms_attempts: SCHEDULED_SMS_MAX_ATTEMPTS })).toMatchObject({ ok: false, code: 'VISIT_RECIPIENT_CHECK_FAILED' });
        expect(bell).toHaveBeenCalledTimes(1);
        expect(bell.mock.calls[0][3].detail).toContain(`Bob, ending ${BOB.slice(-4)}`);
        // an immediate send is never retried: it rings on its first failed check
        bell.mockClear();
        await VisitRecipient.providerCheck({ ...meta, replay: false, scheduled_sms_attempts: undefined });
        expect(bell).toHaveBeenCalledTimes(1);
      } finally { spy.mockRestore(); bell.mockRestore(); }
    });

    test('a permission read failing on EVERY replay attempt: no bell on the earlier attempts, ONE deduped bell on the last (through the replay registry)', async () => {
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      const { SCHEDULED_SMS_MAX_ATTEMPTS } = require('../services/messaging/scheduled-sms-limits');
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('confirmation');
      const [row] = await queued();
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      const notifications = require('../services/notification-service');
      const bell = jest.spyOn(notifications, 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
      const spy = jest.spyOn(Holds, 'disclaimedNumberHeldForVisit').mockRejectedValue(Object.assign(new Error(`select where phone '${BOB}'`), { code: '57P01' }));
      try {
        for (let attempt = 1; attempt < SCHEDULED_SMS_MAX_ATTEMPTS; attempt += 1) {
          expect(await recheckDeferredReplay('visit_text_recipient_deferred', { ...meta, scheduled_sms_attempts: attempt })).toMatchObject({ eligible: false, retryable: true });
        }
        expect(bell).not.toHaveBeenCalled();
        // the last attempt: held for nothing more, so staff are told, once, with the recipient named by first name and last 4 only
        expect(await recheckDeferredReplay('visit_text_recipient_deferred', { ...meta, scheduled_sms_attempts: SCHEDULED_SMS_MAX_ATTEMPTS })).toMatchObject({ eligible: false, retryable: true });
        expect(bell).toHaveBeenCalledTimes(1);
        const opts = bell.mock.calls[0][3];
        expect(opts.detail).toContain(`Bob, ending ${BOB.slice(-4)}`);
        expect(JSON.stringify(bell.mock.calls)).not.toContain(BOB.slice(-10));
        // a repeat carries the same dedupe key (the bell store keeps one row)
        await recheckDeferredReplay('visit_text_recipient_deferred', { ...meta, scheduled_sms_attempts: SCHEDULED_SMS_MAX_ATTEMPTS });
        expect(bell.mock.calls.map((c) => c[3].dedupeKey)).toEqual([opts.dedupeKey, opts.dedupeKey]);
        // the module's own throw carries the code only
        const thrown = await VisitRecipient.recipientStillOwedDeferred({ ...meta, scheduled_sms_attempts: 1 }).catch((e) => e);
        expect(thrown.code).toBe('57P01');
        expect(`${thrown.message} ${thrown.stack}`).not.toContain(BOB.slice(-10));
      } finally { spy.mockRestore(); bell.mockRestore(); }
    });

    test('call_log_v1_phone is IMMUTABLE and PARALLEL UNSAFE (its exception block opens a subtransaction)', async () => {
      const { rows } = await db.raw("SELECT provolatile, proparallel FROM pg_proc WHERE proname = 'call_log_v1_phone'");
      expect(rows).toEqual([{ provolatile: 'i', proparallel: 'u' }]);
      // 20261124195000 set call_log parallel_workers = 0 for the index builds, 20261124220000 reset it once the function was UNSAFE
      const { rows: opts } = await db.raw("SELECT reloptions FROM pg_class WHERE relname = 'call_log'");
      expect(opts[0].reloptions || []).not.toContain('parallel_workers=0');
    });

    test('a queued day-only text is revalidated at the replay handoff (the 24 h reminder switched off, a later promise delivered); a fresh send is not asked again', async () => {
      const Reminders = require('../services/appointment-reminders');
      sendCustomerMessage.mockResolvedValueOnce(HELD);
      await notify('reminder_72h', { dayOnly: true });
      const [row] = await queued();
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      const spy = jest.spyOn(Reminders, 'revalidateDelayedDaySend');
      try {
        spy.mockResolvedValue('day');
        expect(await VisitRecipient.providerCheck({ ...meta, replay: true })).toEqual({ ok: true });
        spy.mockResolvedValue('window');
        expect(await VisitRecipient.providerCheck({ ...meta, replay: true })).toMatchObject({ ok: false, code: 'VISIT_DAY_PROMISE_STALE' });
        spy.mockResolvedValue('suppress');
        expect(await VisitRecipient.providerCheck({ ...meta, replay: true })).toMatchObject({ ok: false, reason: 'day-promise-superseded' });
        spy.mockClear();
        expect(await VisitRecipient.providerCheck(meta)).toEqual({ ok: true });
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });

    test('the holder-recovery evidence lookups of the call processor (audit + sms_log) leave out a visit-only delivery', async () => {
      // The audit ledger: a visit-only row carries its role in metadata.
      await db('messaging_audit_log').insert([
        { body_hash: 'b1', to_hash: 'h1', to_last4: '0002', customer_id: customerId, appointment_id: visitId, audience: 'customer', purpose: 'appointment_confirmation', channel: 'sms', validators_passed: [], validators_failed: [], sent_at: new Date(), metadata: { appointment_contact_role: 'visit_text_recipient', scheduled_service_id: visitId } },
      ]);
      const evidence = () => db('messaging_audit_log')
        .where({ appointment_id: String(visitId), purpose: 'appointment_confirmation' })
        .whereNotNull('sent_at')
        .whereRaw("COALESCE(metadata->>'appointment_contact_role', '') <> 'visit_text_recipient'")
        .first('id');
      expect(await evidence()).toBeUndefined();
      await db('messaging_audit_log').insert({ body_hash: 'b2', to_hash: 'h2', to_last4: '0001', customer_id: customerId, appointment_id: visitId, audience: 'customer', purpose: 'appointment_confirmation', channel: 'sms', validators_passed: [], validators_failed: [], sent_at: new Date(), metadata: { scheduled_service_id: visitId } });
      expect(await evidence()).toBeDefined();
      await db('messaging_audit_log').where({ customer_id: customerId }).del();
      // The sms_log fallback: Bob's accepted confirmation is not the holder's.
      await db('sms_log').insert({ customer_id: customerId, direction: 'outbound', from_phone: phone(50), to_phone: BOB, message_type: 'confirmation', twilio_sid: 'SM1234567890', message_body: 'x', status: 'delivered' });
      const smsEvidence = () => db('sms_log')
        .where({ customer_id: customerId, message_type: 'confirmation', direction: 'outbound' })
        .whereRaw("twilio_sid ~ '^(SM|MM)'")
        .whereRaw("right(regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g'), 10) NOT IN (SELECT phone_key FROM visit_text_recipients WHERE scheduled_service_id = ?)", [visitId])
        .first('id');
      expect(await smsEvidence()).toBeUndefined();
      await db('sms_log').insert({ customer_id: customerId, direction: 'outbound', from_phone: phone(50), to_phone: HOLDER, message_type: 'confirmation', twilio_sid: 'SM1234567891', message_body: 'x', status: 'delivered' });
      expect(await smsEvidence()).toBeDefined();
      await db('sms_log').where({ customer_id: customerId, to_phone: HOLDER }).del();
    });

    test('with the gate off nothing is read or sent', async () => {
      delete process.env[GATE];
      await expect(notify('confirmation')).resolves.toBe(true);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  describe('the recipient\'s own tracker token', () => {
    const TOKEN_FORMAT = /^vr_[a-f0-9]{48}$/;
    let getContactPrefRow;
    beforeEach(async () => {
      process.env[GATE] = 'true';
      ({ getContactPrefRow } = require('../services/contact-notification-prefs'));
      await record();
      // The link's lifetime: en route (or on site, or just completed). The tests below move the visit through the others.
      await db('scheduled_services').where({ id: visitId }).update({ status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 10 * 60 * 1000) });
    });
    afterEach(() => { delete process.env[GATE]; });

    test('a token of any other shape (an old 64-hex one) is replaced once by the recognizable vr_ shape, then stays', async () => {
      const [{ id }] = await rows();
      await db('visit_text_recipients').where({ id }).update({ track_token: 'c'.repeat(64) });
      const minted = await VisitRecipient.ensureTrackToken(id, customerId);
      expect(minted).toMatch(TOKEN_FORMAT);
      expect(minted.length).toBeLessThanOrEqual(64);
      expect(await VisitRecipient.ensureTrackToken(id, customerId)).toBe(minted);
      // the old shape no longer opens anything
      expect(await VisitRecipient.visitForTrackToken('c'.repeat(64))).toBeNull();
    });

    test('minted once on first use, the same value after, never the holder\'s; two racing mints agree', async () => {
      const [{ id }] = await rows();
      expect((await rows())[0].track_token).toBeNull();
      const minted = await Promise.all([VisitRecipient.ensureTrackToken(id, customerId), VisitRecipient.ensureTrackToken(id, customerId), VisitRecipient.ensureTrackToken(id, customerId)]);
      expect(minted[0]).toMatch(TOKEN_FORMAT);
      expect(new Set(minted).size).toBe(1);
      expect((await rows())[0].track_token).toBe(minted[0]);
    });

    test('the token opens exactly its own visit while the gate is on, and is unique per row', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id, customerId);
      expect(await VisitRecipient.visitForTrackToken(token)).toEqual({ visitId, recipientId: id, customerId });
      const [other] = await db('visit_text_recipients').insert({
        scheduled_service_id: otherVisitId, phone_key: BOB.slice(-10), phone_e164: BOB, consent_version: 'x', track_token: token === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
      }).returning('id');
      await expect(db('visit_text_recipients').where({ id: other.id }).update({ track_token: token })).rejects.toMatchObject({ code: '23505' });
    });

    test('a callback-number hold added after the text was sent closes the link (the same check as the send)', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id, customerId);
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      await db('disclaimed_number_holds').insert({ phone_e164: HOLDER, customer_id: customerId, source_call_log_id: callLogId, held_at: new Date() });
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
      await db('disclaimed_number_holds').where({ source_call_log_id: callLogId }).del();
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
    });

    test('a callback-number hold on the recipient\'s OWN number closes the link', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id, customerId);
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      await db('disclaimed_number_holds').insert({ phone_e164: BOB, customer_id: null, source_call_log_id: callLogId, held_at: new Date() });
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
      await db('disclaimed_number_holds').where({ source_call_log_id: callLogId }).del();
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
    });

    describe('an already-issued link closes on a revocation recorded after it was sent', () => {
      let token;
      beforeEach(async () => {
        await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
        const [{ id }] = await rows();
        token = await VisitRecipient.ensureTrackToken(id, customerId);
        expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      });
      const noMoreLink = async () => expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();

      test('a do-not-contact request on a call with Bob\'s number (V2 shape, then the legacy shape)', async () => {
        const [{ id: dncCall }] = await db('call_log').insert({
          direction: 'inbound', from_phone: BOB, to_phone: OUR_LINE,
          ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: true } }),
        }).returning('id');
        try {
          await noMoreLink();
          await db('call_log').where({ id: dncCall }).update({ ai_extraction_enriched: null, ai_extraction: '{"do_not_contact_request": true}' });
          await noMoreLink();
          await db('call_log').where({ id: dncCall }).update({ ai_extraction: '{"do_not_contact_request": false}' });
          expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
        } finally {
          await db('call_log').where({ id: dncCall }).del();
        }
      });

      test('an explicit "no texts" on a call with Bob\'s number, and on a call that SPOKE his number as the callback', async () => {
        const [{ id: noTexts }] = await db('call_log').insert({
          direction: 'inbound', from_phone: BOB, to_phone: OUR_LINE, v2_extraction_status: 'valid',
          ai_extraction_enriched: JSON.stringify({ consent: { sms_declined: true } }),
        }).returning('id');
        try {
          await noMoreLink();
          await db('call_log').where({ id: noTexts }).update({
            from_phone: ANI, ai_extraction_enriched: JSON.stringify({ caller: { phone_e164: BOB }, consent: { sms_declined: true } }),
          });
          await noMoreLink();
        } finally {
          await db('call_log').where({ id: noTexts }).del();
        }
      });

      test('a do-not-contact request on a call that SPOKE Bob\'s number as the callback, with "no texts" unset', async () => {
        const holds = require('../services/messaging/auto-text-holds');
        const [{ id: spokenDnc }] = await db('call_log').insert({
          direction: 'inbound', from_phone: ANI, to_phone: OUR_LINE,
          ai_extraction_enriched: JSON.stringify({ caller: { phone_e164: BOB }, consent: { do_not_contact_request: true } }),
        }).returning('id');
        try {
          await noMoreLink();
          // the first-touch lane's own reach is unchanged: without the option the spoken number is not matched
          expect(await holds.askedNotToBeContactedOnAnyCall(BOB)).toBe(false);
          expect(await holds.askedNotToBeContactedOnAnyCall(BOB, { includeSpokenNumber: true })).toBe(true);
        } finally {
          await db('call_log').where({ id: spokenDnc }).del();
        }
      });

      test('every place a spoken number lives, for BOTH vetoes: V1-only (no V2 extraction at all), V2 callback, V2 text number', async () => {
        const insertCall = async (row) => (await db('call_log').insert({ direction: 'inbound', from_phone: ANI, to_phone: OUR_LINE, ...row }).returning('id'))[0].id;
        const made = [];
        try {
          // legacy V1 only: ai_extraction_enriched is NULL, the number sits in ai_extraction.phone, do-not-contact in the flat field
          made.push(await insertCall({ ai_extraction: JSON.stringify({ phone: BOB, do_not_contact_request: true }) }));
          await noMoreLink();
          await db('call_log').whereIn('id', made).del(); made.length = 0;
          expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
          // V1 number, V2 "no texts" (sms_declined is a V2-only field; the spoken number is found in the V1 text)
          made.push(await insertCall({ v2_extraction_status: 'valid', ai_extraction: JSON.stringify({ phone: BOB }), ai_extraction_enriched: JSON.stringify({ consent: { sms_declined: true } }) }));
          await noMoreLink();
          await db('call_log').whereIn('id', made).del(); made.length = 0;
          // V2 text number
          made.push(await insertCall({ v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ caller: { text_phone_e164: BOB }, consent: { sms_declined: true } }) }));
          await noMoreLink();
          await db('call_log').whereIn('id', made).del(); made.length = 0;
          // a formatted legacy number still matches on its last 10 digits
          made.push(await insertCall({ ai_extraction: JSON.stringify({ phone: `(${BOB.slice(2, 5)}) ${BOB.slice(5, 8)}-${BOB.slice(8)}`, do_not_contact_request: true }) }));
          await noMoreLink();
        } finally {
          if (made.length) await db('call_log').whereIn('id', made).del();
        }
        expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      });

      test('the legacy V1 phone is the TOP-LEVEL key only, and malformed extraction text is safe', async () => {
        const insertCall = async (row) => (await db('call_log').insert({ direction: 'inbound', from_phone: ANI, to_phone: OUR_LINE, ...row }).returning('id'))[0].id;
        const made = [];
        try {
          // a malformed extraction text in the log must not fail the read (the function answers NULL), whatever else is in it
          made.push(await insertCall({ ai_extraction: `not json {{{ "phone": "${BOB}" do_not_contact_request true` }));
          made.push(await insertCall({ ai_extraction: '[1,2' }));
          made.push(await insertCall({ ai_extraction: '"just a string"' }));
          made.push(await insertCall({ ai_extraction: '' }));
          expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
          // top-level phone null, a secondary contact's phone is Bob's: Bob's number is NOT the caller's, so no match
          made.push(await insertCall({ ai_extraction: JSON.stringify({ phone: null, do_not_contact_request: true, secondary_contact: { first_name: 'Bob', phone: BOB } }) }));
          expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
          // a nested object with a phone BEFORE the caller's own top-level phone: the top-level one is what matches
          made.push(await insertCall({ ai_extraction: `{"secondary_contact":{"phone":"+19415550999"},"phone":"${BOB}","do_not_contact_request":true}` }));
          await noMoreLink();
        } finally {
          await db('call_log').whereIn('id', made).del();
        }
        expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      });

      test('ONE call_log query per open-link request, covering both vetoes, and its plan uses the call_log last-10 indexes', async () => {
        const seen = [];
        const counting = Object.assign((table) => { if (table === 'call_log') seen.push(table); return db(table); }, { raw: db.raw.bind(db), fn: db.fn, transaction: db.transaction.bind(db) });
        expect(await VisitRecipient.visitForTrackToken(token, { conn: counting })).not.toBeNull();
        expect(seen).toEqual(['call_log']);
        // the plan: with sequential scans off, every number branch is answered by an index of migration 20261124200000
        const holds = require('../services/messaging/auto-text-holds');
        const { sql, bindings } = holds._callVetoQuery(db, BOB.slice(-10)).toSQL();
        const plan = await db.transaction(async (trx) => {
          await trx.raw('SET LOCAL enable_seqscan = off');
          const res = await trx.raw(`EXPLAIN ${sql}`, bindings);
          return res.rows.map((r) => r['QUERY PLAN']).join('\n');
        });
        for (const index of ['call_log_from_phone_last10_index', 'call_log_to_phone_last10_index', 'call_log_spoken_phone_last10_index', 'call_log_spoken_text_phone_last10_index', 'call_log_v1_phone_last10_index']) {
          expect(plan).toContain(index);
        }
      });

      test('a staff do-not-contact on Bob\'s number', async () => {
        await suppress(BOB);
        await db('messaging_suppression').where({ phone: BOB }).update({ reason: 'manual_dnc' });
        await noMoreLink();
      });
    });

    test('an unreadable veto read at the provider handoff holds the text and raises the one deduped bell (the initial lookup was fine)', async () => {
      const notifications = require('../services/notification-service');
      const bell = jest.spyOn(notifications, 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
      try {
        const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
        sendCustomerMessage.mockReset();
        sendCustomerMessage.mockResolvedValue({ sent: true });
        // call_log is readable for the initial lookup (which does not touch it) and fails at the handoff recheck
        const failingAtHandoff = Object.assign((table) => {
          if (table === 'call_log') throw Object.assign(new Error(`select from call_log where phone '${BOB}' - connection terminated`), { code: '57P01' });
          return db(table);
        }, { raw: db.raw.bind(db), fn: db.fn, transaction: db.transaction.bind(db) });
        await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'confirmation', excludePhones: [HOLDER], conn: failingAtHandoff });
        expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
        const input = sendCustomerMessage.mock.calls[0][0];
        const verdict = await input.providerPreSendCheck({ channel: 'sms' });
        expect(verdict).toMatchObject({ ok: false, code: 'VISIT_RECIPIENT_CHECK_FAILED', retryable: true });
        expect(bell).toHaveBeenCalledTimes(1);
        const [category, title, , opts] = bell.mock.calls[0];
        expect(category).toBe('appointment');
        expect(title).toBe('Schedule — check the person named on the call before texting');
        expect(opts.dedupeKey).toBe(`visit-recipient-text-unsent:${visitId}:confirmation`);
        // the recipient is known on this path: first name and the LAST 4 digits only, never the full number
        expect(opts.detail).toContain(`Bob, ending ${BOB.slice(-4)}`);
        expect(opts.detail).toMatch(/still on the visit, the visit time, and that they may be texted/);
        expect(JSON.stringify(bell.mock.calls)).not.toContain(BOB.slice(-10));
        // the bell opens the visit on its own day (the dispatch page\'s date and appointment parameters)
        expect(opts.link).toBe(`/admin/dispatch?tab=schedule&date=${VISIT_DATE}&appointment=${visitId}`);
        expect(JSON.stringify(bell.mock.calls)).not.toContain(BOB.slice(-10));
        // a second recheck of the same notice carries the same key (the bell store keeps one row)
        await input.providerPreSendCheck({ channel: 'sms' });
        expect(bell.mock.calls.map((c) => c[3].dedupeKey)).toEqual([opts.dedupeKey, opts.dedupeKey]);
      } finally {
        bell.mockRestore();
      }
    });

    test('a decline SAVED in the choices table binds the link and the text with GATE_CONTACT_LOGIN off (the default)', async () => {
      expect(process.env.GATE_CONTACT_LOGIN).toBeUndefined();
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id, customerId);
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      await db('service_contact_notification_prefs').insert({ customer_id: customerId, phone_key: BOB.slice(-10), tech_en_route: false });
      try {
        expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
        const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
        sendCustomerMessage.mockReset();
        sendCustomerMessage.mockResolvedValue({ sent: true });
        await db('visit_text_recipients').where({ id }).update({ deliveries: '{}' });
        await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'en_route', excludePhones: [HOLDER] });
        expect(sendCustomerMessage).not.toHaveBeenCalled();
        // another notice the person did not turn off still goes (the row is per notice)
        await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'confirmation', excludePhones: [HOLDER] });
        expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      } finally {
        await db('service_contact_notification_prefs').where({ customer_id: customerId }).del();
      }
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
    });

    test('a missing choices table denies: the link errors and a text is held, never read as "no choices"', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id, customerId);
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
      // The same database, except that the per-contact choices table does not exist (Postgres 42P01).
      const { TABLE } = jest.requireActual('../services/contact-notification-prefs');
      const withoutChoicesTable = Object.assign((table) => {
        if (table !== TABLE) return db(table);
        const missing = Object.assign(new Error(`relation "${TABLE}" does not exist`), { code: '42P01' });
        const q = { where: () => q, select: async () => { throw missing; } };
        return q;
      }, { raw: db.raw.bind(db), fn: db.fn, transaction: db.transaction.bind(db) });
      // after the token lookup, an error answers as an unknown token (null), never an error
      expect(await VisitRecipient.visitForTrackToken(token, { conn: withoutChoicesTable })).toBeNull();
      // control: the same text goes out when the table can be read
      sendCustomerMessage.mockReset();
      sendCustomerMessage.mockResolvedValue({ sent: true });
      await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'en_route', excludePhones: [HOLDER] });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      sendCustomerMessage.mockClear();
      await db('visit_text_recipients').where({ id }).update({ deliveries: '{}' });
      await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'en_route', excludePhones: [HOLDER], conn: withoutChoicesTable });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
    });

    test('a MISSING disclaimed-number table (42P01) is never read as "no hold": the link answers like an unknown token and the text is held', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000), status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 10 * 60 * 1000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id, customerId);
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
      const holdsTable = 'disclaimed_number_holds';
      // the REAL helpers, over a database where only that table does not exist
      const withoutHoldsTable = Object.assign((table) => {
        if (table !== holdsTable) return db(table);
        const missing = Object.assign(new Error(`relation "${holdsTable}" does not exist for '${BOB}'`), { code: '42P01' });
        const q = { where: () => q, whereNull: () => q, first: async () => { throw missing; } };
        return q;
      }, { raw: db.raw.bind(db), fn: db.fn, transaction: db.transaction.bind(db) });
      // the strict option itself: a code-only throw where the default read says "no hold"
      const thrown = await Holds.disclaimedNumberHeld(BOB, withoutHoldsTable, { strict: true }).catch((e) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.code).toBe('42P01');
      expect(`${thrown.message} ${thrown.stack}`).not.toContain(BOB.slice(-10));
      expect(await Holds.disclaimedNumberHeld(BOB, withoutHoldsTable)).toBe(false); // the other callers keep the old reading
      // the recipient's two checks (the visit's holder number, and the person's own number) both go through it
      expect(await VisitRecipient.visitForTrackToken(token, { conn: withoutHoldsTable })).toBeNull();
      await db('visit_text_recipients').where({ id }).update({ deliveries: '{}' });
      sendCustomerMessage.mockReset();
      sendCustomerMessage.mockResolvedValue({ sent: true });
      const notifications = require('../services/notification-service');
      const bell = jest.spyOn(notifications, 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
      try {
        await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'en_route', excludePhones: [HOLDER], conn: withoutHoldsTable });
        // the text reaches the provider boundary only to be HELD there: the handoff recheck says retry, never "no hold"
        expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
        const handoff = await sendCustomerMessage.mock.calls[0][0].providerPreSendCheck();
        expect(handoff).toMatchObject({ ok: false, code: 'VISIT_RECIPIENT_CHECK_FAILED', retryable: true });
      } finally { bell.mockRestore(); }
      sendCustomerMessage.mockClear();
      await db('visit_text_recipients').where({ id }).update({ deliveries: '{}' });
      // control: with the table readable, the link opens and the text goes
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'en_route', excludePhones: [HOLDER] });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    });

    describe('the row is bound to the customer whose call authorized it', () => {
      let otherCustomerId;
      beforeEach(async () => {
        [{ id: otherCustomerId }] = await db('customers').insert({ first_name: 'Zed', last_name: 'Other', phone: phone(40) }).returning('id');
      });
      afterEach(async () => {
        await db('scheduled_services').where({ id: visitId }).update({ customer_id: customerId });
        await db('customers').where({ id: otherCustomerId }).del();
      });
      const reassign = (to) => db('scheduled_services').where({ id: visitId }).update({ customer_id: to });

      test('recording writes the visit\'s customer, and a call from another customer records nothing', async () => {
        expect((await record()).recorded).toHaveLength(1);
        expect((await rows())[0].customer_id).toBe(customerId);
        await db('visit_text_recipients').where({ scheduled_service_id: visitId }).del();
        const mismatch = await record({ customerId: otherCustomerId });
        expect(mismatch.recorded).toEqual([]);
        expect(mismatch.skipped).toEqual([{ reason: 'customer_mismatch' }]);
        expect(await rows()).toHaveLength(0);
      });

      test('a visit reassigned to another customer: no text, no claim, and the link answers like an unknown token', async () => {
        await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000), status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 10 * 60 * 1000) });
        await record();
        const [{ id }] = await rows();
        const token = await VisitRecipient.ensureTrackToken(id, customerId);
        expect(await VisitRecipient.visitForTrackToken(token)).toMatchObject({ visitId, customerId });
        const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
        sendCustomerMessage.mockReset();
        sendCustomerMessage.mockResolvedValue({ sent: true });
        await reassign(otherCustomerId);
        expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
        await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'en_route', excludePhones: [] });
        expect(sendCustomerMessage).not.toHaveBeenCalled();
        expect((await rows())[0].deliveries).toEqual({});
        // the replay and handoff rechecks say the same, and a token is not minted for the reassigned visit
        expect(await VisitRecipient.recipientStillOwed({ scheduled_service_id: visitId, kind: 'en_route', visit_recipient_id: id, claim_key: `en_route:${VISIT_DATE}T09:00` })).toMatchObject({ ok: false, code: 'VISIT_RECIPIENT_NOT_OWED' });
        expect(await VisitRecipient.ensureTrackToken(id, otherCustomerId)).toBeNull();
        // it comes back when the visit does
        await reassign(customerId);
        expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      });

      test('a row with NO customer_id (never bound) is ineligible: no text, no link', async () => {
        await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000), status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 10 * 60 * 1000) });
        // a visit-only person (not on the every-visit list, which would replace the unbound row with a fresh copy)
        await db('visit_text_recipients').where({ scheduled_service_id: visitId }).del();
        await db('customer_reminder_contacts').where({ customer_id: customerId }).del();
        await record({}, entry({ appointment_texts_scope: 'this_visit' }));
        const [{ id }] = await rows();
        const token = await VisitRecipient.ensureTrackToken(id, customerId);
        await db('visit_text_recipients').where({ id }).update({ customer_id: null });
        const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
        sendCustomerMessage.mockReset();
        sendCustomerMessage.mockResolvedValue({ sent: true });
        expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
        await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind: 'en_route', excludePhones: [] });
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });

      test('the mint itself requires the visit\'s CURRENT customer: a visit reassigned after the contacts were read mints nothing', async () => {
        await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
        await record();
        const [{ id }] = await rows();
        // the sender read its contacts (the row bound to customerId), then the visit moved to another customer before the write
        await reassign(otherCustomerId);
        expect(await VisitRecipient.ensureTrackToken(id, customerId)).toBeNull();
        expect((await rows())[0].track_token).toBeNull();
        // control: back on the row's customer, the same call mints
        await reassign(customerId);
        expect(await VisitRecipient.ensureTrackToken(id, customerId)).toMatch(/^vr_[a-f0-9]{48}$/);
      });

      describe('the route\'s FINAL read joins the recipient row as it stands now (all three routes)', () => {
        const trackPublicRouter = require('../routes/track-public');
        const find = (path, method) => trackPublicRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;
        const ROUTES = [['/:token', 'get'], ['/:token/stops-ahead', 'post'], ['/:token/view', 'post']];
        const hit = async (path, method, token) => {
          const res = { statusCode: 200, body: undefined, headers: {}, set: jest.fn((h) => { Object.assign(res.headers, h); return res; }), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }), end: jest.fn(() => res) };
          const next = jest.fn();
          await find(path, method)({ params: { token }, headers: {}, get: () => null }, res, next);
          return { statusCode: res.statusCode, body: res.body, headers: res.headers, nextCalled: next.mock.calls.length };
        };
        const fresh = async () => {
          await db('visit_text_recipients').whereIn('scheduled_service_id', [visitId, otherVisitId]).del();
          await record();
          const [{ id }] = await rows();
          return { id, token: await VisitRecipient.ensureTrackToken(id, customerId) };
        };
        // Between the module's permission check and the route's final read: each change the module already passed.
        const CHANGES = {
          'the row deleted': ({ id }) => db('visit_text_recipients').where({ id }).del(),
          'the row replaced (deleted, then re-inserted with the same token, visit and customer)': async ({ id, token }) => {
            const old = await db('visit_text_recipients').where({ id }).first();
            await db('visit_text_recipients').where({ id }).del();
            const { id: _drop, created_at: _c, updated_at: _u, ...copy } = old;
            await db('visit_text_recipients').insert({ ...copy, track_token: token });
          },
          'the row given a new token': ({ id }) => db('visit_text_recipients').where({ id }).update({ track_token: `vr_${'9'.repeat(48)}` }),
          'the row rebound to another customer': ({ id }) => db('visit_text_recipients').where({ id }).update({ customer_id: otherCustomerId }),
          'the row moved to another visit': ({ id }) => db('visit_text_recipients').where({ id }).update({ scheduled_service_id: otherVisitId }),
          'a list copy whose customer does not list the number': async ({ id }) => {
            await db('visit_text_recipients').where({ id }).update({ source: 'customer_reminder_contact' });
            await db('customer_reminder_contacts').where({ customer_id: customerId }).del();
          },
        };
        let spy;
        beforeEach(async () => {
          await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000), status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 10 * 60 * 1000) });
        });
        afterEach(() => { if (spy) spy.mockRestore(); spy = null; });

        test.each(ROUTES)('%s (%s): control, an unchanged row is served', async (path, method) => {
          const { token } = await fresh();
          expect((await hit(path, method, token)).statusCode).not.toBe(404);
        });

        test.each(ROUTES)('%s (%s): a row changed after the permission check answers exactly as an unknown token', async (path, method) => {
          const unknown = await hit(path, method, `vr_${'7'.repeat(48)}`);
          expect(unknown.statusCode).toBe(404);
          for (const [label, change] of Object.entries(CHANGES)) {
            const made = await fresh();
            const real = VisitRecipient.visitForTrackToken;
            spy = jest.spyOn(VisitRecipient, 'visitForTrackToken').mockImplementation(async (...args) => {
              const answer = await real(...args);
              await change(made);
              return answer;
            });
            const answer = await hit(path, method, made.token);
            spy.mockRestore();
            spy = null;
            expect({ label, ...answer }).toEqual({ label, ...unknown });
          }
        });
      });

      test('the migration backfills ONLY from the call the number was given on (and only when that call\'s customer is the visit\'s current one); everything else stays NULL, and other rows are untouched', async () => {
        const migration = require('../models/migrations/20261124230000_visit_text_recipients_customer_id');
        await record();
        const [{ id: provedId }] = await rows();
        await db('call_log').where({ id: callLogId }).update({ customer_id: customerId });
        await db('visit_text_recipients').where({ id: provedId }).update({ customer_id: null });
        // four DISTINCT fixed numbers (unique to this run); the key is always the last 10 digits of the E.164
        const numbers = [phone(50), phone(51), phone(52), phone(53)];
        const base = (n, over) => ({ phone_e164: numbers[n], phone_key: numbers[n].slice(-10), consent_version: 'test', ...over });
        // the whole run is one transaction that is ROLLED BACK: the assertions read inside it, nothing else is ever touched
        const rollback = new Error('rollback');
        let seen;
        await db.transaction(async (trx) => {
          const [{ id: otherCallId }] = await trx('call_log').insert({ direction: 'inbound', from_phone: ANI, to_phone: OUR_LINE, customer_id: otherCustomerId }).returning('id');
          const [{ id: noCustomerCallId }] = await trx('call_log').insert({ direction: 'inbound', from_phone: ANI, to_phone: OUR_LINE }).returning('id');
          const make = async (n, over) => (await trx('visit_text_recipients').insert(base(n, { scheduled_service_id: otherVisitId, ...over })).returning('id'))[0].id;
          const conflicting = await make(0, { call_log_id: otherCallId });         // the call was another customer's
          const callWithoutCustomer = await make(1, { call_log_id: noCustomerCallId });
          const noCall = await make(2, {});                                           // no call on record
          const alreadyBound = await make(3, { call_log_id: callLogId, customer_id: otherCustomerId }); // bound elsewhere: never overwritten
          await migration.up(trx);
          const customerOf = async (rowId) => (await trx('visit_text_recipients').where({ id: rowId }).first('customer_id')).customer_id;
          seen = {
            proved: await customerOf(provedId),
            conflicting: await customerOf(conflicting),
            callWithoutCustomer: await customerOf(callWithoutCustomer),
            noCall: await customerOf(noCall),
            alreadyBound: await customerOf(alreadyBound),
          };
          throw rollback;
        }).catch((err) => { if (err !== rollback) throw err; });
        expect(seen).toEqual({ proved: customerId, conflicting: null, callWithoutCustomer: null, noCall: null, alreadyBound: otherCustomerId });
        // after the rollback nothing the migration did persists, and the scratch rows are gone
        expect((await rows())[0].customer_id).toBeNull();
        expect(await db('visit_text_recipients').where({ scheduled_service_id: otherVisitId }).count('* as n').first()).toMatchObject({ n: '0' });
      });
    });

    test('the lifetime: en route and on site open; completed opens for 2 hours; scheduled, cancelled, skipped, rebooking and older completions do not', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id, customerId);
      const setVisit = (patch) => db('scheduled_services').where({ id: visitId }).update(patch);
      const open = async () => (await VisitRecipient.visitForTrackToken(token)) !== null;
      await setVisit({ status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 10 * 60 * 1000) });
      expect(await open()).toBe(true);
      await setVisit({ status: 'on_site', track_state: 'on_property', arrived_at: new Date(Date.now() - 5 * 60 * 1000) });
      expect(await open()).toBe(true);
      await setVisit({ status: 'completed', track_state: 'complete', completed_at: new Date(Date.now() - 60 * 60 * 1000) });
      expect(await open()).toBe(true);
      await setVisit({ completed_at: new Date(Date.now() - 3 * 60 * 60 * 1000) });
      expect(await open()).toBe(false);
      for (const patch of [
        { status: 'confirmed', track_state: 'scheduled', completed_at: null },
        { status: 'cancelled', track_state: 'cancelled' },
        { status: 'skipped', track_state: 'scheduled' },
        { status: 'rescheduled', track_state: 'scheduled' },
      ]) {
        await setVisit(patch);
        expect(await open()).toBe(false);
      }
    });

    test('404 cases: gate off, a wrong token, a declined person, the visit gone, no live expiry', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id, customerId);
      expect(await VisitRecipient.visitForTrackToken('c'.repeat(64))).toBeNull();
      getContactPrefRow.mockResolvedValueOnce({ tech_en_route: false });
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
      await suppress(BOB);
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
      await db('messaging_suppression').where({ phone: BOB }).update({ active: false });
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: null });
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      delete process.env[GATE];
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
      process.env[GATE] = 'true';
      await db('scheduled_services').where({ id: visitId }).del();
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
    });
  });

  describe('scope', () => {
    test('the row goes with its visit', async () => {
      await record();
      await db('scheduled_services').where({ id: visitId }).del();
      expect(await db('visit_text_recipients').where({ scheduled_service_id: visitId }).select('id')).toEqual([]);
    });

    test('the customer row is never written: no consent stamp, no slot, no preferences', async () => {
      const before = await db('customers').where({ id: customerId }).first();
      await record();
      const [contact] = await VisitRecipient.contactsForVisit(visitId, 'confirmation');
      await VisitRecipient.sendOnce(contact, async () => ({ sent: true }));
      expect(await db('customers').where({ id: customerId }).first()).toEqual(before);
      expect(before.service_contacts_consent_at).toBeNull();
    });

    test('one visit and number is one row even under a concurrent double record', async () => {
      await Promise.all([record(), record(), record()]);
      expect(await rows()).toHaveLength(1);
    });
  });
});
