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
jest.mock('../services/bid-desk/alert-buttons', () => ({
  buttonHandler: { live: jest.fn(() => true), run: jest.fn(), visibleItems: jest.fn() },
}));
jest.mock('../config/feature-gates', () => ({ alertCloseButtonsLive: jest.fn(() => true) }));
jest.mock('../services/sms-operational-actions', () => ({ settleCommitmentsForDoneAlert: jest.fn(async () => 1) }));

let mockRow;
let mockReread; // the row a lost claim reads back: every read after the first
let mockReads = 0;
let mockClaimed;
const mockClaimedVersion = 'c'.repeat(32); // the row's version after the claim wrote it
const mockUpdates = [];
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    if (table !== 'notifications') throw new Error(`unexpected table ${table}`);
    const q = {
      where: jest.fn(() => q),
      first: jest.fn(async () => (mockReads++ === 0 ? mockRow : (mockReread ?? mockRow))),
      update: jest.fn(async (patch) => { mockUpdates.push({ claim: false, patch }); return 1; }),
    };
    return q;
  });
  // The claim is the one conditional UPDATE, run raw so it can return the row's version after it.
  db.raw = jest.fn((sql, bindings) => {
    if (/^UPDATE notifications/.test(sql)) {
      mockUpdates.push({ claim: true, sql, bindings });
      return Promise.resolve({ rows: mockClaimed ? [{ version: mockClaimedVersion }] : [] });
    }
    return { __raw: sql, bindings };
  });
  return db;
});

const NotificationService = require('../services/notification-service');
const gates = require('../config/feature-gates');
const { settleCommitmentsForDoneAlert } = require('../services/sms-operational-actions');
const { buttonHandler } = require('../services/referral-inbound-bell');
const { buttonHandler: bidHandler } = require('../services/bid-desk/alert-buttons');
const logger = require('../services/logger');
const { withAlertButtons, runAlertButton, closeNoteButtons } = require('../services/admin-alert-buttons');

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

// The tap record finishTap appended, and the claim that came before it.
const claimOf = () => mockUpdates.find((u) => u.claim);
const tapOf = () => JSON.parse(mockUpdates.find((u) => !u.claim).patch.metadata.bindings[0]);

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdates.length = 0;
  mockReread = undefined;
  mockReads = 0;
  mockClaimed = 1;
  mockRow = row();
  buttonHandler.live.mockReturnValue(true);
});

describe('withAlertButtons: what the bell list serves', () => {
  test('an admin gets each open row\'s buttons as actions, without the args', async () => {
    const [served, plain] = await withAlertButtons([row(), { id: 'n2', metadata: { area: 'Comms' } }], { role: 'admin' });
    expect(served.actions).toEqual([
      { id: 'confirm', label: 'Confirm Lea Quill', prompt: 'Make Lea Quill the referrer of Ames Fenn?' },
      { id: 'dismiss', label: 'Not a referral' },
    ]);
    expect(plain).not.toHaveProperty('actions');
  });

  test('a string metadata column is read the same way', async () => {
    const [served] = await withAlertButtons([row({ metadata: JSON.stringify({ buttons: BUTTONS }) })], { role: 'admin' });
    expect(served.actions).toHaveLength(2);
  });

  test.each([
    ['a technician login', [row()], { role: 'technician' }],
    ['a done row', [row({ done_at: new Date() })], { role: 'admin' }],
    ['a live overlay row', [row({ id: 'live:ar_overdue' })], { role: 'admin' }],
    ['a kind this server does not know', [row({ metadata: { buttons: { ...BUTTONS, kind: 'mystery' } } })], { role: 'admin' }],
    ['stored buttons that break the shape', [row({ metadata: { buttons: { ...BUTTONS, items: [{ id: 'x', label: '' }] } } })], { role: 'admin' }],
  ])('no buttons for %s', async (_name, rows, opts) => {
    expect((await withAlertButtons(rows, opts))[0]).not.toHaveProperty('actions');
  });

  test('no buttons while the kind is off, and the gate is read once per list', async () => {
    buttonHandler.live.mockReturnValue(false);
    const served = await withAlertButtons([row(), row({ id: 'n3' })], { role: 'admin' });
    expect(served.every((r) => !('actions' in r))).toBe(true);
    expect(buttonHandler.live).toHaveBeenCalledTimes(1);
  });

  describe('a kind that checks its records when the list is served (visibleItems)', () => {
    const BID = { kind: 'bid_decision', items: [{ id: 'no_bid', label: 'No bid' }, { id: 'bid', label: 'Bid' }] };
    const bidRow = (id, over = {}) => row({ id, metadata: { buttons: BID, bidId: `bid-${id}` }, ...over });

    beforeEach(() => bidHandler.live.mockReturnValue(true));

    test('each row serves only the buttons its record allows now, from one check for the whole list', async () => {
      bidHandler.visibleItems.mockResolvedValue(new Map([['b1', ['no_bid', 'bid']], ['b2', ['no_bid']], ['b3', []]]));
      const served = await withAlertButtons([bidRow('b1'), bidRow('b2'), bidRow('b3'), bidRow('b4'), row()], { role: 'admin' });
      expect(served.map((r) => r.actions?.map((a) => a.id))).toEqual([['no_bid', 'bid'], ['no_bid'], undefined, undefined, ['confirm', 'dismiss']]);
      expect(bidHandler.visibleItems).toHaveBeenCalledTimes(1);
      expect(bidHandler.visibleItems).toHaveBeenCalledWith(['b1', 'b2', 'b3', 'b4'].map((id) => ({ id, metadata: { buttons: BID, bidId: `bid-${id}` } })));
    });

    test('a failed check serves none of that kind\'s buttons, and the other kinds are untouched', async () => {
      bidHandler.visibleItems.mockRejectedValue(new Error('connection reset'));
      const served = await withAlertButtons([bidRow('b1'), row()], { role: 'admin' });
      expect(served[0]).not.toHaveProperty('actions');
      expect(served[1].actions).toHaveLength(2);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bid_decision button check failed'));
    });

    test('a kind that is off is not checked', async () => {
      bidHandler.live.mockReturnValue(false);
      await withAlertButtons([bidRow('b1')], { role: 'admin' });
      expect(bidHandler.visibleItems).not.toHaveBeenCalled();
    });
  });
});

describe('runAlertButton: one tap', () => {
  test('the step runs, the tap is recorded, and the row is marked done by the person', async () => {
    buttonHandler.run.mockResolvedValue({ ok: true, message: 'Lea Quill is confirmed.', resolution: 'Referrer confirmed' });
    await expect(tap()).resolves.toEqual({ status: 200, body: { success: true, message: 'Lea Quill is confirmed.' } });
    expect(buttonHandler.run).toHaveBeenCalledWith({ row: mockRow, item: BUTTONS.items[0], technicianId: 't-1', claimedVersion: mockClaimedVersion });
    expect(claimOf().bindings).toEqual(['t-1', 'confirm', ID, VERSION, 120]);
    expect(claimOf().sql).toMatch(/done_at IS NULL AND md5\(content\) = \?/);
    expect(tapOf()).toMatchObject({ action: 'confirm', by: 't-1', outcome: 'done' });
    expect(mockUpdates.find((u) => !u.claim).patch.metadata.__raw).toMatch(/- 'buttonClaim'\) \|\| jsonb_build_object\('buttonTaps'/);
    expect(NotificationService.markAdminDone).toHaveBeenCalledWith([ID], { by: 't-1', resolution: 'Referrer confirmed', role: 'admin' });
  });

  test('a refusal for a record answered elsewhere closes the row as a system close and answers 409', async () => {
    buttonHandler.run.mockResolvedValue({ ok: false, code: 'answered', message: 'This referral was already answered.', close: 'Referrer confirmed' });
    await expect(tap()).resolves.toEqual({ status: 409, body: { error: 'answered', message: 'This referral was already answered.' } });
    expect(NotificationService.markAdminDone).toHaveBeenCalledWith([ID], { by: 'alert-button', resolution: 'Referrer confirmed' });
    expect(tapOf().outcome).toBe('answered');
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

  test.each([
    ['another tap holds the row', () => row({ metadata: { buttons: BUTTONS, buttonClaim: { by: 't-2', action: 'dismiss' } } }), { error: 'busy', message: 'Someone is already acting on this alert.' }],
    ['the row closed in between', () => row({ done_at: new Date() }), { error: 'done', message: 'That alert was already handled.' }],
    ['the row changed in between', () => row(), { error: 'changed' }],
  ])('a lost claim runs nothing: %s', async (_name, reread, body) => {
    mockClaimed = 0;
    mockReread = reread();
    await expect(tap()).resolves.toEqual({ status: 409, body });
    expect(claimOf()).toBeDefined();
    expect(buttonHandler.run).not.toHaveBeenCalled();
    expect(mockUpdates.filter((u) => !u.claim)).toHaveLength(0);
  });

  test('a step that throws still records the tap and releases the claim', async () => {
    buttonHandler.run.mockRejectedValue(new Error('connection reset'));
    await expect(tap()).rejects.toThrow('connection reset');
    expect(tapOf()).toMatchObject({ action: 'confirm', outcome: 'error' });
    expect(NotificationService.markAdminDone).not.toHaveBeenCalled();
  });

  test('a kind that is off runs nothing', async () => {
    buttonHandler.live.mockReturnValue(false);
    await expect(tap()).resolves.toMatchObject({ status: 409, body: { error: 'off' } });
    expect(buttonHandler.run).not.toHaveBeenCalled();
  });
});

describe('close-only buttons (close_note): the bell\'s own Done with the button\'s note', () => {
  const CLOSE = closeNoteButtons('called_back');
  const closeRow = (over = {}) => row({ metadata: { buttons: CLOSE, dedupeKey: 'sms-commitment:c-9', customerId: 'c-1' }, ...over });

  beforeEach(() => {
    gates.alertCloseButtonsLive.mockReturnValue(true);
    mockRow = closeRow();
  });

  test('served while the gate is on, never while it is off', async () => {
    expect((await withAlertButtons([closeRow()], { role: 'admin' }))[0].actions).toEqual([{ id: 'called_back', label: 'Called back' }]);
    gates.alertCloseButtonsLive.mockReturnValue(false);
    expect((await withAlertButtons([closeRow()], { role: 'admin' }))[0]).not.toHaveProperty('actions');
  });

  test('a tap marks the row done by the person with the note, on the claimed version, then settles the follow-up', async () => {
    await expect(tap({ actionId: 'called_back' })).resolves.toEqual({ status: 200, body: { success: true, message: 'Marked called back.' } });
    expect(NotificationService.markAdminDone).toHaveBeenNthCalledWith(1, [ID], { by: 't-1', resolution: 'Called back', role: 'admin', expectedVersion: mockClaimedVersion });
    expect(settleCommitmentsForDoneAlert).toHaveBeenCalledWith(expect.anything(), ID, { reviewedBy: 't-1' });
    expect(tapOf()).toMatchObject({ action: 'called_back', outcome: 'done' });
    // The step closed it, fenced; the runner does not close it a second time, unfenced.
    expect(NotificationService.markAdminDone).toHaveBeenCalledTimes(1);
  });

  test('a row a new message rewrote after the claim is not closed, and nothing settles', async () => {
    NotificationService.markAdminDone.mockResolvedValueOnce(0);
    await expect(tap({ actionId: 'called_back' })).resolves.toEqual({ status: 409, body: { error: 'changed' } });
    expect(settleCommitmentsForDoneAlert).not.toHaveBeenCalled();
    expect(NotificationService.markAdminDone).toHaveBeenCalledTimes(1);
    expect(tapOf().outcome).toBe('changed');
  });

  test('a failed settle never undoes the Done', async () => {
    settleCommitmentsForDoneAlert.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(tap({ actionId: 'called_back' })).resolves.toMatchObject({ status: 200 });
  });

  test('a stored button with an unknown note id runs nothing', async () => {
    mockRow = closeRow({ metadata: { buttons: { kind: 'close_note', items: [{ id: 'refunded', label: 'Refunded' }] } } });
    await expect(tap({ actionId: 'refunded' })).resolves.toMatchObject({ status: 409, body: { error: 'unknown_action' } });
    expect(NotificationService.markAdminDone).not.toHaveBeenCalled();
  });
});
