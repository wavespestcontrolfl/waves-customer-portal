// The visit text recipient's OWN tracker credential (GATE_CALL_GIVEN_VISIT_TEXTS, owner 2026-11-24 "yes he gets it").
// The holder's tracker token must never reach the recipient (it opens the report, invoice and the other visits' links
// after completion), so the recipient gets a token minted on their own row. This file pins, with a faked database:
//   - the token is minted lazily, by one write on the recipient's row (the text's own link is pinned in
//     call-visit-recipient.test.js and call-visit-recipient-postgres.test.js);
//   - the link resolves only while the gate is on, the row stands, the visit exists and the person has not declined.
// The SQL itself (unique column, atomic mint, cascade) runs on real PostgreSQL in call-visit-recipient-postgres.test.js.
const mockTables = {};
jest.mock('../models/db', () => {
  const mockDb = jest.fn((table) => {
    const q = {};
    const calls = (mockTables[table] = mockTables[table] || { reads: [], rows: [], updates: [] });
    ['where', 'whereRaw', 'whereNotNull', 'orderBy'].forEach((m) => { q[m] = jest.fn((...a) => { calls.reads.push([m, ...a]); return q; }); });
    q.first = jest.fn(async () => (typeof calls.first === 'function' ? calls.first() : (calls.first ?? null)));
    q.then = (resolve, reject) => Promise.resolve(calls.list ?? []).then(resolve, reject);
    q.update = jest.fn((patch) => { calls.updates.push(patch); return q; });
    q.returning = jest.fn(async () => calls.returning ?? []);
    q.insert = jest.fn(async () => {});
    return q;
  });
  mockDb.raw = jest.fn((sql) => ({ sql }));
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The person's own text choices: a direct read of their choices row (contactPhoneDeclinesText logs err.message, so it is not used).
jest.mock('../services/contact-notification-prefs', () => ({
  getContactPrefRow: jest.fn(async () => null),
  contactAllows: jest.fn((row, column) => !(row && (row.sms_enabled === false || (column && row[column] === false)))),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberHeldForVisit: jest.fn(async () => false), disclaimedNumberHeld: jest.fn(async () => false) }));
const { disclaimedNumberHeldForVisit, disclaimedNumberHeld } = require('../services/disclaimed-number-holds');
jest.mock('../services/messaging/auto-text-holds', () => ({ askedNotToBeContactedOnAnyCall: jest.fn(async () => false), saidNoTextsOnAnyCall: jest.fn(async () => false) }));
const { askedNotToBeContactedOnAnyCall, saidNoTextsOnAnyCall } = require('../services/messaging/auto-text-holds');
const { getContactPrefRow } = require('../services/contact-notification-prefs');
const VisitRecipient = require('../services/call-visit-recipient');

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
const TOKEN = 'b'.repeat(64);
const ROW = { id: 'r-1', scheduled_service_id: 'ss-1', phone_key: '9415550002', phone_e164: '+19415550002', first_name: 'Bob', last_name: 'Roe' };
const LIVE = new Date(Date.now() + 86400000).toISOString();
const VISIT = { id: 'ss-1', customer_id: 'cust-1', status: 'en_route', track_state: 'en_route', completed_at: null, scheduled_date: '2026-12-01', window_start: '09:00:00', service_type: 'Pest Control', track_token_expires_at: LIVE };

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  process.env[GATE] = 'true';
  getContactPrefRow.mockResolvedValue(null);
  disclaimedNumberHeldForVisit.mockResolvedValue(false);
  disclaimedNumberHeld.mockResolvedValue(false);
  askedNotToBeContactedOnAnyCall.mockResolvedValue(false);
  saidNoTextsOnAnyCall.mockResolvedValue(false);
});
afterAll(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });

function seed({ row = ROW, visit = VISIT, optin = null, suppressed = null } = {}) {
  const require_ = require('../models/db');
  require_.mockClear();
  mockTables.visit_text_recipients = { reads: [], rows: [], updates: [], first: row, list: row ? [row] : [] };
  mockTables.customers = { reads: [], rows: [], updates: [], first: { phone: '+19415550001' } };
  mockTables.scheduled_services = { reads: [], rows: [], updates: [], first: visit };
  mockTables.recipient_optin = { reads: [], rows: [], updates: [], first: optin };
  mockTables.messaging_suppression = { reads: [], rows: [], updates: [], first: suppressed };
}

describe('visitForTrackToken: who a recipient link opens', () => {
  test('a live row opens its own visit', async () => {
    seed();
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toEqual({ visitId: 'ss-1', recipientId: 'r-1' });
    // Read by the recipient column, never the holder's.
    const reads = JSON.stringify(mockTables.visit_text_recipients.reads);
    expect(reads).toContain('track_token');
    expect(reads).not.toContain('track_view_token');
  });

  test('gate OFF: nothing resolves and no read happens', async () => {
    delete process.env[GATE];
    seed();
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
    expect(mockTables.visit_text_recipients.reads).toEqual([]);
  });

  test.each([undefined, null, '', 'abc', 'A'.repeat(64), 'b'.repeat(63), `${'b'.repeat(63)}g`])('a malformed token (%s) resolves nothing', async (token) => {
    seed();
    expect(await VisitRecipient.visitForTrackToken(token)).toBeNull();
    expect(mockTables.visit_text_recipients.reads).toEqual([]);
  });

  test('a token no row carries resolves nothing', async () => {
    seed({ row: null });
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['expired', '2000-01-01T00:00:00.000Z'],
    ['not a date', 'not-a-date'],
  ])('a visit whose own link expiry is %s resolves nothing (a missing expiry is refused, unlike the holder\'s legacy link)', async (_label, expiry) => {
    seed({ visit: { ...VISIT, track_token_expires_at: expiry } });
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
  });

  test('the SAME permission check as the send: a callback-number hold added after the text was sent closes the link', async () => {
    seed();
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).not.toBeNull();
    disclaimedNumberHeldForVisit.mockResolvedValue(true);
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
    // and the send's handoff check reads the same hold
    expect((await VisitRecipient.recipientStillOwed({ scheduled_service_id: 'ss-1', kind: 'en_route', visit_recipient_id: 'r-1', claim_key: 'en_route:2026-12-01T09:00' })).code).toBe('CALLBACK_NUMBER_HOLD');
  });

  test('a callback-number hold on the RECIPIENT\'s own number closes the link and the send recheck', async () => {
    seed();
    disclaimedNumberHeld.mockResolvedValue(true);
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
    expect(disclaimedNumberHeld).toHaveBeenCalledWith('+19415550002', expect.anything());
    expect((await VisitRecipient.recipientStillOwed({ scheduled_service_id: 'ss-1', kind: 'en_route', visit_recipient_id: 'r-1', claim_key: 'en_route:2026-12-01T09:00' })).code).toBe('RECIPIENT_NUMBER_HOLD');
  });

  test('a lookup error is rethrown without the bound token (a knex message carries its bindings)', async () => {
    seed();
    mockTables.visit_text_recipients.first = () => { throw Object.assign(new Error(`select * from "visit_text_recipients" where "track_token" = '${TOKEN}' - boom`), { code: '57P01' }); };
    const err = await VisitRecipient.visitForTrackToken(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('57P01');
    expect(`${err.message} ${err.stack}`).not.toContain(TOKEN);
  });

  test('a do-not-contact request recorded on a call with the recipient\'s number closes the link and the send recheck', async () => {
    seed();
    askedNotToBeContactedOnAnyCall.mockResolvedValue(true);
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
    expect((await VisitRecipient.recipientStillOwed({ scheduled_service_id: 'ss-1', kind: 'en_route', visit_recipient_id: 'r-1', claim_key: 'en_route:2026-12-01T09:00' })).code).toBe('CALL_DO_NOT_CONTACT');
    expect(askedNotToBeContactedOnAnyCall).toHaveBeenCalledWith('+19415550002', expect.objectContaining({ dbi: expect.anything() }));
  });

  test('an explicit "no texts" heard on a call with the recipient\'s number (the spoken callback number included) closes the link and the send recheck', async () => {
    seed();
    saidNoTextsOnAnyCall.mockResolvedValue(true);
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
    expect((await VisitRecipient.recipientStillOwed({ scheduled_service_id: 'ss-1', kind: 'en_route', visit_recipient_id: 'r-1', claim_key: 'en_route:2026-12-01T09:00' })).code).toBe('CALL_SMS_DECLINED');
    expect(saidNoTextsOnAnyCall).toHaveBeenCalledWith('+19415550002', expect.objectContaining({ dbi: expect.anything() }));
  });

  test('the choices row is read FAIL-CLOSED, and an unreadable or missing choices table denies (the link errors, the recheck throws)', async () => {
    seed();
    await VisitRecipient.visitForTrackToken(TOKEN);
    expect(getContactPrefRow).toHaveBeenCalledWith('cust-1', '+19415550002', expect.objectContaining({ failClosed: true }));
    getContactPrefRow.mockRejectedValue(Object.assign(new Error('relation "service_contact_notification_prefs" does not exist'), { code: '42P01' }));
    const err = await VisitRecipient.visitForTrackToken(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('42P01');
    await expect(VisitRecipient.recipientStillOwed({ scheduled_service_id: 'ss-1', kind: 'en_route', visit_recipient_id: 'r-1', claim_key: 'x' })).rejects.toThrow();
  });

  test('the cheap lifetime check runs FIRST: a closed link answers with no permission read at all', async () => {
    const minutesAgoIso = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
    for (const closed of [
      { status: 'confirmed', track_state: 'scheduled' },
      { status: 'cancelled', track_state: 'cancelled' },
      { status: 'completed', track_state: 'complete', completed_at: minutesAgoIso(200) },
      { status: 'on_site', track_state: 'en_route' },
      { track_token_expires_at: null },
    ]) {
      seed({ visit: { ...VISIT, ...closed } });
      disclaimedNumberHeldForVisit.mockClear();
      disclaimedNumberHeld.mockClear();
      askedNotToBeContactedOnAnyCall.mockClear();
      saidNoTextsOnAnyCall.mockClear();
      getContactPrefRow.mockClear();
      expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
      for (const read of [disclaimedNumberHeldForVisit, disclaimedNumberHeld, askedNotToBeContactedOnAnyCall, saidNoTextsOnAnyCall, getContactPrefRow]) {
        expect(read).not.toHaveBeenCalled();
      }
      expect(mockTables.recipient_optin?.reads || []).toEqual([]);
      expect(mockTables.messaging_suppression?.reads || []).toEqual([]);
    }
  });

  test('an open link pays for every permission read', async () => {
    seed();
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).not.toBeNull();
    for (const read of [disclaimedNumberHeldForVisit, disclaimedNumberHeld, askedNotToBeContactedOnAnyCall, saidNoTextsOnAnyCall, getContactPrefRow]) {
      expect(read).toHaveBeenCalled();
    }
  });

  test('the choices row is read whatever GATE_CONTACT_LOGIN says (a saved decline binds this feature with that gate off)', async () => {
    const gate = process.env.GATE_CONTACT_LOGIN;
    delete process.env.GATE_CONTACT_LOGIN;
    try {
      seed();
      getContactPrefRow.mockResolvedValue({ tech_en_route: false });
      expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
      expect(getContactPrefRow).toHaveBeenCalledWith('cust-1', '+19415550002', expect.objectContaining({ failClosed: true }));
    } finally {
      if (gate !== undefined) process.env.GATE_CONTACT_LOGIN = gate;
    }
  });

  test('a person no longer on the visit (row not listed for it) resolves nothing', async () => {
    seed();
    mockTables.visit_text_recipients.list = [];
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
  });

  const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
  test.each([
    ['en route', { status: 'en_route', track_state: 'en_route' }],
    ['on site', { status: 'on_site', track_state: 'on_property' }],
    ['completed 5 minutes ago', { status: 'completed', track_state: 'complete', completed_at: minutesAgo(5) }],
    ['completed 119 minutes ago', { status: 'completed', track_state: 'complete', completed_at: minutesAgo(119) }],
  ])('lifetime: a visit that is %s opens the link', async (_label, over) => {
    seed({ visit: { ...VISIT, ...over } });
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toEqual({ visitId: 'ss-1', recipientId: 'r-1' });
  });

  test.each([
    ['scheduled', { status: 'confirmed', track_state: 'scheduled' }],
    ['pending', { status: 'pending', track_state: 'scheduled' }],
    ['cancelled', { status: 'cancelled', track_state: 'cancelled' }],
    ['skipped', { status: 'skipped', track_state: 'scheduled' }],
    ['no show', { status: 'no_show', track_state: 'scheduled' }],
    ['waiting to be rebooked', { status: 'rescheduled', track_state: 'scheduled' }],
    ['en route by status only', { status: 'en_route', track_state: 'scheduled' }],
    ['completed 121 minutes ago', { status: 'completed', track_state: 'complete', completed_at: minutesAgo(121) }],
    ['completed with no completed_at', { status: 'completed', track_state: 'complete', completed_at: null }],
  ])('lifetime: a visit that is %s closes the link', async (_label, over) => {
    seed({ visit: { ...VISIT, ...over } });
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
  });

  test('a row whose visit is gone resolves nothing', async () => {
    seed({ visit: null });
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
  });

  test.each([
    ['the person turned off en-route texts (their own choices row)', () => getContactPrefRow.mockResolvedValue({ tech_en_route: false }), {}],
    ['the person declined at the opt-in', () => {}, { optin: { status: 'declined' } }],
    ['the number is suppressed (STOP)', () => {}, { suppressed: { phone: '+19415550002' } }],
  ])('declined: %s', async (_label, arrange, seedArgs) => {
    seed(seedArgs);
    arrange();
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
  });

  test('an unreadable answer throws instead of opening the view', async () => {
    seed();
    mockTables.visit_text_recipients.first = () => { throw new Error('db down'); };
    await expect(VisitRecipient.visitForTrackToken(TOKEN)).rejects.toThrow('lookup failed');
  });
});

describe('ensureTrackToken: one atomic mint on the recipient row', () => {
  test('writes only the recipient row and returns the token', async () => {
    seed();
    mockTables.visit_text_recipients.returning = [{ track_token: TOKEN }];
    expect(await VisitRecipient.ensureTrackToken('r-1')).toBe(TOKEN);
    expect(mockTables.visit_text_recipients.updates).toHaveLength(1);
    expect(JSON.stringify(mockTables.visit_text_recipients.updates[0])).toContain('COALESCE(track_token');
    expect(mockTables.scheduled_services.updates).toEqual([]);
  });
});
