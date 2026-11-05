// The bell list a technician reads (NotificationService.getAdminNotifications with a non-admin role): a row whose
// trigger names techOmit payload keys is the technician's copy (owner 2026-11-04, technician visibility D1 A: what a
// voicemail caller asked about is call content, never on a technician screen). An admin reads every row as stored.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockRows = [];
jest.mock('../models/db', () => {
  const builder = () => {
    const b = {};
    ['where', 'whereNull', 'whereRaw', 'whereIn', 'select', 'orderByRaw', 'limit'].forEach((m) => { b[m] = () => b; });
    b.offset = async () => mockRows.map((r) => ({ ...r }));
    return b;
  };
  const fn = jest.fn(() => builder());
  fn.raw = jest.fn((sql) => sql);
  return fn;
});

const NotificationService = require('../services/notification-service');

const VOICEMAIL = {
  id: 'n-1', category: 'voicemail_callback', title: 'Voicemail — Test Caller',
  body: 'Test Caller - Asked about WDO Inspection - Callback: (941) 555-0100',
  metadata: JSON.stringify({ triggerKey: 'customer_voicemail_callback', payload: { name: 'Test Caller', service: 'WDO Inspection', phone: '+19415550100' } }),
};
const REPLY = { id: 'n-2', category: 'sms_reply', title: 'Text from Pat Example', body: 'Running late', metadata: { triggerKey: 'sms_reply', payload: {} } };

beforeEach(() => { mockRows = [VOICEMAIL, REPLY]; });

test('a technician reads the voicemail row without what the caller asked about; other rows as stored', async () => {
  const [voicemail, reply] = await NotificationService.getAdminNotifications(50, 0, { role: 'technician', technicianId: 'tech-1' });
  expect(voicemail.title).toBe('Voicemail — Test Caller');
  expect(voicemail.body).toBe('Test Caller - Callback: (941) 555-0100');
  expect(voicemail.metadata.payload).toEqual({ name: 'Test Caller', phone: '+19415550100' });
  expect(reply).toEqual(REPLY);
});

test('an admin, and a caller with no role, read every row as stored', async () => {
  for (const opts of [{ role: 'admin' }, {}]) {
    const rows = await NotificationService.getAdminNotifications(50, 0, opts);
    expect(rows[0].body).toBe(VOICEMAIL.body);
    expect(rows[0].metadata).toBe(VOICEMAIL.metadata);
  }
});
