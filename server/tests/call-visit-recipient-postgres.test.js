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
// A service contact's own text choices need the contact-login tables; pass through, with a hook to force a decline.
jest.mock('../services/contact-notification-prefs', () => {
  const actual = jest.requireActual('../services/contact-notification-prefs');
  return { ...actual, contactPhoneDeclinesText: jest.fn((...args) => actual.contactPhoneDeclinesText(...args)) };
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

    test('Bob is owed nothing for another visit on the same account', async () => {
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
    let contactPhoneDeclinesText;
    const HELD = {
      sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, retryable: true, nextAllowedAt: `${VISIT_DATE}T12:00:00.000Z`,
    };
    const notify = (kind, extra = {}) => VisitRecipient.notifyVisitRecipients({ scheduledServiceId: visitId, kind, excludePhones: [HOLDER], ...extra });
    const sentTo = () => sendCustomerMessage.mock.calls.map(([input]) => input.to);
    const queued = () => db('sms_log').where({ customer_id: customerId, to_phone: BOB, status: 'scheduled' });

    beforeEach(async () => {
      process.env[GATE] = 'true';
      ({ sendCustomerMessage } = require('../services/messaging/send-customer-message'));
      ({ contactPhoneDeclinesText } = require('../services/contact-notification-prefs'));
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

    test('each kind is its own text; the reminders carry no link and the en-route text carries only Bob\'s OWN tracker link', async () => {
      const HOLDER_TOKEN = 'a'.repeat(64);
      await db('scheduled_services').where({ id: visitId }).update({ track_view_token: HOLDER_TOKEN, track_token_expires_at: new Date(Date.now() + 86400000) });
      for (const kind of ['confirmation', 'reminder_72h', 'reminder_24h']) await notify(kind);
      await notify('en_route', { context: { techName: 'Pat', etaMinutes: 12, trackUrlFor: async (token) => `https://x.test/track/${token}` } });
      expect(sendCustomerMessage.mock.calls.map(([i]) => i.purpose)).toEqual([
        'appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h', 'tech_en_route',
      ]);
      for (const [input] of sendCustomerMessage.mock.calls.slice(0, 3)) expect(input.body).not.toMatch(/https?:|track|reschedule/i);
      const [{ track_token: bobToken }] = await rows();
      expect(bobToken).toMatch(/^[a-f0-9]{64}$/);
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

    test('a link builder that fails sends the text without a link', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      await notify('en_route', { context: { techName: 'Pat', trackUrlFor: async () => { throw new Error('shortener down'); } } });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage.mock.calls[0][0].body).not.toContain('Track live');
    });

    test('Bob gets nothing for another visit on the account, a cancelled visit, or when the sender already texts his number', async () => {
      await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: otherVisitId, kind: 'confirmation', excludePhones: [HOLDER] });
      await notify('confirmation', { excludePhones: [HOLDER, BOB] });
      await db('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
      await notify('confirmation');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('an existing decline is honored by every sender: a recipient_optin decline, STOP or suppression, and his own text choices', async () => {
      const optinRow = { customer_id: customerId, phone_key: BOB.slice(-10), phone_e164: BOB };
      await db('recipient_optin').insert({ ...optinRow, status: 'declined' });
      await notify('confirmation');
      await db('recipient_optin').where({ customer_id: customerId }).del();
      await suppress(BOB);
      await notify('reminder_72h');
      await db('messaging_suppression').where({ phone: BOB }).del();
      contactPhoneDeclinesText.mockResolvedValueOnce(true);
      await notify('en_route');
      expect(contactPhoneDeclinesText).toHaveBeenCalledWith(customerId, BOB, 'tech_en_route', expect.any(Object));
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
      await expect(VisitRecipient.releaseDeferredClaim(meta, { conn: failing })).rejects.toThrow('db down');
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
    const TOKEN_FORMAT = /^[a-f0-9]{64}$/;
    let contactPhoneDeclinesText;
    beforeEach(async () => {
      process.env[GATE] = 'true';
      ({ contactPhoneDeclinesText } = require('../services/contact-notification-prefs'));
      await record();
    });
    afterEach(() => { delete process.env[GATE]; });

    test('minted once on first use, the same value after, never the holder\'s; two racing mints agree', async () => {
      const [{ id }] = await rows();
      expect((await rows())[0].track_token).toBeNull();
      const minted = await Promise.all([VisitRecipient.ensureTrackToken(id), VisitRecipient.ensureTrackToken(id), VisitRecipient.ensureTrackToken(id)]);
      expect(minted[0]).toMatch(TOKEN_FORMAT);
      expect(new Set(minted).size).toBe(1);
      expect((await rows())[0].track_token).toBe(minted[0]);
    });

    test('the token opens exactly its own visit while the gate is on, and is unique per row', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id);
      expect(await VisitRecipient.visitForTrackToken(token)).toEqual({ visitId, recipientId: id });
      const [other] = await db('visit_text_recipients').insert({
        scheduled_service_id: otherVisitId, phone_key: BOB.slice(-10), phone_e164: BOB, consent_version: 'x', track_token: token === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
      }).returning('id');
      await expect(db('visit_text_recipients').where({ id: other.id }).update({ track_token: token })).rejects.toMatchObject({ code: '23505' });
    });

    test('a callback-number hold added after the text was sent closes the link (the same check as the send)', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id);
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      await db('disclaimed_number_holds').insert({ phone_e164: HOLDER, customer_id: customerId, source_call_log_id: callLogId, held_at: new Date() });
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
      await db('disclaimed_number_holds').where({ source_call_log_id: callLogId }).del();
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
    });

    test('a callback-number hold on the recipient\'s OWN number closes the link', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id);
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
      await db('disclaimed_number_holds').insert({ phone_e164: BOB, customer_id: null, source_call_log_id: callLogId, held_at: new Date() });
      expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
      await db('disclaimed_number_holds').where({ source_call_log_id: callLogId }).del();
      expect(await VisitRecipient.visitForTrackToken(token)).not.toBeNull();
    });

    test('a completed or on-site visit still opens the link', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000), status: 'completed' });
      const [{ id }] = await rows();
      expect(await VisitRecipient.visitForTrackToken(await VisitRecipient.ensureTrackToken(id))).not.toBeNull();
    });

    test('404 cases: gate off, a wrong token, a declined person, the visit gone, no live expiry', async () => {
      await db('scheduled_services').where({ id: visitId }).update({ track_token_expires_at: new Date(Date.now() + 86400000) });
      const [{ id }] = await rows();
      const token = await VisitRecipient.ensureTrackToken(id);
      expect(await VisitRecipient.visitForTrackToken('c'.repeat(64))).toBeNull();
      contactPhoneDeclinesText.mockResolvedValueOnce(true);
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
