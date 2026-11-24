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
      await db('sms_log').where({ customer_id: customerId, to_phone: BOB }).del();
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
      customer_id: customerId, scheduled_date: '2026-12-01', window_start: '09:00', service_type: 'Pest Control', status: 'confirmed',
    }).returning('id');
    [{ id: otherVisitId }] = await db('scheduled_services').insert({
      customer_id: customerId, scheduled_date: '2027-03-02', window_start: '09:00', service_type: 'Pest Control', status: 'confirmed',
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
      expect(Object.keys(deliveries)).toEqual(['confirmation:2026-12-01T09:00']);
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
        phone: BOB, name: 'Bob Roe', role: 'visit_text_recipient', claimKey: 'reminder_24h:2026-12-01T09:00',
      });
      expect(contacts[0].role.startsWith('service_contact')).toBe(false);
    });

    test('Bob is owed nothing for another visit on the same account', async () => {
      await record();
      expect(await VisitRecipient.contactsForVisit(otherVisitId, 'confirmation')).toEqual([]);
      expect(await VisitRecipient.contactsForVisit(otherVisitId, 'en_route')).toEqual([]);
    });

    test('a cancelled, skipped, completed, no-show or on-site visit sends nothing; a rescheduled visit keeps the recipient', async () => {
      await record();
      for (const status of ['cancelled', 'skipped', 'completed', 'no_show', 'on_site']) {
        await db('scheduled_services').where({ id: visitId }).update({ status });
        expect(await VisitRecipient.contactsForVisit(visitId, 'reminder_24h')).toEqual([]);
      }
      await db('scheduled_services').where({ id: visitId }).update({ status: 'rescheduled', scheduled_date: '2026-12-09', window_start: '13:00' });
      const [moved] = await VisitRecipient.contactsForVisit(visitId, 'reminder_24h');
      expect(moved.claimKey).toBe('reminder_24h:2026-12-09T13:00');
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
      await db('scheduled_services').where({ id: visitId }).update({ status: 'rescheduled', scheduled_date: '2026-12-09' });
      const [moved] = await VisitRecipient.contactsForVisit(visitId, 'reminder_24h');
      await VisitRecipient.sendOnce(moved, send);
      await VisitRecipient.sendOnce(moved, send);
      expect(send).toHaveBeenCalledTimes(2);
      expect(Object.keys((await rows())[0].deliveries).sort()).toEqual(['reminder_24h:2026-12-01T09:00', 'reminder_24h:2026-12-09T09:00']);
    });
  });

  describe('notifyVisitRecipients (real database, stubbed provider)', () => {
    let sendCustomerMessage;
    let contactPhoneDeclinesText;
    const HELD = {
      sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, retryable: true, nextAllowedAt: '2026-12-01T12:00:00.000Z',
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
      expect(input.body).toContain('December 1');
      expect(input.body).not.toMatch(/https?:|www\.|reschedule|track/i);
    });

    test('each kind is its own text; the reminder purposes and the en-route text carry no link either', async () => {
      for (const kind of ['confirmation', 'reminder_72h', 'reminder_24h']) await notify(kind);
      await notify('en_route', { context: { techName: 'Pat', etaMinutes: 12, trackUrl: 'https://x.test/track/abc' } });
      expect(sendCustomerMessage.mock.calls.map(([i]) => i.purpose)).toEqual([
        'appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h', 'tech_en_route',
      ]);
      for (const [input] of sendCustomerMessage.mock.calls) expect(input.body).not.toMatch(/https?:|track|reschedule/i);
      expect(sendCustomerMessage.mock.calls[3][0].body).toContain('Pat is on the way, about 12 minutes away.');
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
        replay_purpose: 'appointment_confirmation', requires_registered_dispatch: true, slot_scheduled_date: '2026-12-01', slot_window_start: '09:00',
      });
      expect(row.metadata.refresh_customer_phone).toBeUndefined();
      // The replay's fresh check: owed now; gate off, a moved slot, a decline or a cancelled visit each suppress it.
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      const meta = { ...row.metadata, to_phone: BOB, customer_id: customerId };
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', meta)).toEqual({ eligible: true });
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', { ...meta, slot_scheduled_date: '2026-12-02' })).toMatchObject({ eligible: false });
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

    test('with the gate off nothing is read or sent', async () => {
      delete process.env[GATE];
      await expect(notify('confirmation')).resolves.toBe(true);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
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
