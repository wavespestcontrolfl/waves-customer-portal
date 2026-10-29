// Buttons on admin bell rows (docs/admin-notifications.md section 2, part 9): what the bell list serves,
// and what one tap runs. The kind's handler is a stand-in; its own rules are in referral-inbound-bell.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  markAdminDone: jest.fn(async () => 1),
  _private: { NOTIFICATION_VERSION_SQL: 'md5(content)' },
}));
jest.mock('../services/referral-inbound-bell', () => ({
  buttonHandler: { live: jest.fn(() => true), run: jest.fn() },
}));

let mockRow;
const mockUpdates = [];
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    if (table !== 'notifications') throw new Error(`unexpected table ${table}`);
    const q = {
      where: jest.fn(() => q),
      first: jest.fn(async () => mockRow),
      update: jest.fn(async (patch) => { mockUpdates.push(patch); return 1; }),
    };
    return q;
  });
  db.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return db;
});

const NotificationService = require('../services/notification-service');
const { buttonHandler } = require('../services/referral-inbound-bell');
const { withAlertButtons, runAlertButton } = require('../services/admin-alert-buttons');

const ID = '00000000-0000-4000-8000-0000000000a1';
const VERSION = 'a'.repeat(32);
const BUTTONS = {
  kind: 'referral_inbound',
  items: [
    { id: 'confirm', label: 'Confirm Lea Quill', prompt: 'Make Lea Quill the referrer of Ames Fenn?', args: { referrerCustomerId: 'c-2' } },
    { id: 'dismiss', label: 'Not a referral' },
  ],
};
const row = (over = {}) => ({ id: ID, done_at: null, version: VERSION, metadata: { buttons: BUTTONS, subject: { type: 'customer', id: 'c-1' } }, ...over });
const tap = (over = {}) => runAlertButton({ notificationId: ID, actionId: 'confirm', version: VERSION, technicianId: 't-1', role: 'admin', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdates.length = 0;
  mockRow = row();
  buttonHandler.live.mockReturnValue(true);
});

describe('withAlertButtons: what the bell list serves', () => {
  test('an admin gets each open row\'s buttons as actions, without the args', () => {
    const [served, plain] = withAlertButtons([row(), { id: 'n2', metadata: { area: 'Comms' } }], { role: 'admin' });
    expect(served.actions).toEqual([
      { id: 'confirm', label: 'Confirm Lea Quill', prompt: 'Make Lea Quill the referrer of Ames Fenn?' },
      { id: 'dismiss', label: 'Not a referral' },
    ]);
    expect(plain).not.toHaveProperty('actions');
  });

  test('a string metadata column is read the same way', () => {
    const [served] = withAlertButtons([row({ metadata: JSON.stringify({ buttons: BUTTONS }) })], { role: 'admin' });
    expect(served.actions).toHaveLength(2);
  });

  test.each([
    ['a technician login', [row()], { role: 'technician' }],
    ['a done row', [row({ done_at: new Date() })], { role: 'admin' }],
    ['a live overlay row', [row({ id: 'live:ar_overdue' })], { role: 'admin' }],
    ['a kind this server does not know', [row({ metadata: { buttons: { ...BUTTONS, kind: 'mystery' } } })], { role: 'admin' }],
    ['stored buttons that break the shape', [row({ metadata: { buttons: { ...BUTTONS, items: [{ id: 'x', label: '' }] } } })], { role: 'admin' }],
  ])('no buttons for %s', (_name, rows, opts) => {
    expect(withAlertButtons(rows, opts)[0]).not.toHaveProperty('actions');
  });

  test('no buttons while the kind is off, and the gate is read once per list', () => {
    buttonHandler.live.mockReturnValue(false);
    const served = withAlertButtons([row(), row({ id: 'n3' })], { role: 'admin' });
    expect(served.every((r) => !('actions' in r))).toBe(true);
    expect(buttonHandler.live).toHaveBeenCalledTimes(1);
  });
});

describe('runAlertButton: one tap', () => {
  test('the step runs, the tap is recorded, and the row is marked done by the person', async () => {
    buttonHandler.run.mockResolvedValue({ ok: true, message: 'Lea Quill is confirmed.', resolution: 'Referrer confirmed' });
    await expect(tap()).resolves.toEqual({ status: 200, body: { success: true, message: 'Lea Quill is confirmed.' } });
    expect(buttonHandler.run).toHaveBeenCalledWith({ row: mockRow, item: BUTTONS.items[0], technicianId: 't-1' });
    const tapPatch = JSON.parse(mockUpdates[0].metadata.bindings[0]);
    expect(tapPatch).toMatchObject({ action: 'confirm', by: 't-1', outcome: 'done' });
    expect(NotificationService.markAdminDone).toHaveBeenCalledWith([ID], { by: 't-1', resolution: 'Referrer confirmed', role: 'admin' });
  });

  test('a refusal for a record answered elsewhere closes the row as a system close and answers 409', async () => {
    buttonHandler.run.mockResolvedValue({ ok: false, code: 'answered', message: 'This referral was already answered.', close: 'Referrer confirmed' });
    await expect(tap()).resolves.toEqual({ status: 409, body: { error: 'answered', message: 'This referral was already answered.' } });
    expect(NotificationService.markAdminDone).toHaveBeenCalledWith([ID], { by: 'alert-button', resolution: 'Referrer confirmed' });
    expect(JSON.parse(mockUpdates[0].metadata.bindings[0]).outcome).toBe('answered');
  });

  test('a refusal that leaves the record open keeps the row open', async () => {
    buttonHandler.run.mockResolvedValue({ ok: false, code: 'first_visit_done', message: 'Confirm it in Referrals → Queue.' });
    await expect(tap()).resolves.toEqual({ status: 409, body: { error: 'first_visit_done', message: 'Confirm it in Referrals → Queue.' } });
    expect(NotificationService.markAdminDone).not.toHaveBeenCalled();
  });

  test.each([
    ['a technician', { role: 'technician' }, 403, { error: 'Admin access required' }],
    ['no technician id', { technicianId: null }, 403, { error: 'Admin access required' }],
  ])('%s cannot tap', async (_name, over, status, body) => {
    await expect(tap(over)).resolves.toEqual({ status, body });
    expect(buttonHandler.run).not.toHaveBeenCalled();
  });

  test('a missing row answers 404', async () => {
    mockRow = undefined;
    await expect(tap()).resolves.toEqual({ status: 404, body: { error: 'not_found' } });
  });

  test('a second tap on a done row runs nothing', async () => {
    mockRow = row({ done_at: new Date() });
    await expect(tap()).resolves.toEqual({ status: 409, body: { error: 'done', message: 'That alert was already handled.' } });
    expect(buttonHandler.run).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(0);
  });

  test('a row whose content changed since the bell served it answers 409 changed', async () => {
    mockRow = row({ version: 'b'.repeat(32) });
    await expect(tap()).resolves.toEqual({ status: 409, body: { error: 'changed' } });
    expect(buttonHandler.run).not.toHaveBeenCalled();
  });

  test('only a button the row carries can run', async () => {
    await expect(tap({ actionId: 'refund' })).resolves.toEqual({ status: 400, body: { error: 'unknown_action' } });
    mockRow = row({ metadata: { subject: { type: 'customer', id: 'c-1' } } });
    await expect(tap()).resolves.toEqual({ status: 400, body: { error: 'unknown_action' } });
    expect(buttonHandler.run).not.toHaveBeenCalled();
  });

  test('a kind that is off runs nothing', async () => {
    buttonHandler.live.mockReturnValue(false);
    await expect(tap()).resolves.toMatchObject({ status: 409, body: { error: 'off' } });
    expect(buttonHandler.run).not.toHaveBeenCalled();
  });
});
