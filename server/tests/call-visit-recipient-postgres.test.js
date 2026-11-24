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

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
// Ten digits unique to this run: area code 941, a random exchange and line.
const run = String(Math.floor(1000000 + Math.random() * 8999999));
const phone = (n) => `+1941${run.slice(0, 3)}${String(1000 + n).slice(-4)}`;
const HOLDER = phone(1);
const BOB = phone(2);
const ANI = phone(10);
const OUR_LINE = phone(11);

const entry = (over = {}) => ({
  first_name: 'Bob', last_name: 'Roe', phone_e164: BOB, role: 'spouse_partner', wants_notifications: true, ...over,
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
    if (customerId) await db('customers').where({ id: customerId }).del(); // visits, then their recipient rows, cascade
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
    suppressed.push(number);
    await db('messaging_suppression').insert({ phone: number, active, reason: 'stop' });
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

    test('an entry with no request, a flag on another entry, or an impossible number records nothing', async () => {
      await record({}, entry({ wants_notifications: false }), entry({ phone_e164: null }), entry({ phone_e164: '+11735550100' }));
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
      await db('visit_text_recipients').update({ deliveries: {} });
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

  describe('scope', () => {
    test('the row goes with its visit', async () => {
      await record();
      await db('scheduled_services').where({ id: visitId }).del();
      expect(await db('visit_text_recipients').select('id')).toEqual([]);
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
