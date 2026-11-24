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
    q.update = jest.fn((patch) => { calls.updates.push(patch); return q; });
    q.returning = jest.fn(async () => calls.returning ?? []);
    q.insert = jest.fn(async () => {});
    return q;
  });
  mockDb.raw = jest.fn((sql) => ({ sql }));
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/contact-notification-prefs', () => ({ contactPhoneDeclinesText: jest.fn(async () => false) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberHeldForVisit: jest.fn(async () => false) }));

const { contactPhoneDeclinesText } = require('../services/contact-notification-prefs');
const VisitRecipient = require('../services/call-visit-recipient');

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
const TOKEN = 'b'.repeat(64);
const ROW = { id: 'r-1', scheduled_service_id: 'ss-1', phone_key: '9415550002', phone_e164: '+19415550002' };
const VISIT = { id: 'ss-1', customer_id: 'cust-1' };

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  process.env[GATE] = 'true';
  contactPhoneDeclinesText.mockResolvedValue(false);
});
afterAll(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });

function seed({ row = ROW, visit = VISIT, optin = null, suppressed = null } = {}) {
  const require_ = require('../models/db');
  require_.mockClear();
  mockTables.visit_text_recipients = { reads: [], rows: [], updates: [], first: row };
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

  test('a row whose visit is gone resolves nothing', async () => {
    seed({ visit: null });
    expect(await VisitRecipient.visitForTrackToken(TOKEN)).toBeNull();
  });

  test.each([
    ['the person turned off en-route texts', () => contactPhoneDeclinesText.mockResolvedValue(true), {}],
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
    await expect(VisitRecipient.visitForTrackToken(TOKEN)).rejects.toThrow('db down');
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
