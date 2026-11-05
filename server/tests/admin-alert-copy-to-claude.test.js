// "Send a copy to Claude (read-only)" (step 3, GATE_ALERT_SEND_TO_CLAUDE_COPY): the refusal table, the one row a send writes
// (no customer words anywhere in it), the version fence, the dedupe and suppressed answers, the 10-second Undo fence, the two
// routes (gate off 404, another admin 403), the bell list's marking and owner-only pass-through, and the alert-button
// route's owner-only refusal. The row itself against Postgres is notification-admin-claude-queue.test.js (the fenced write).
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  getAdminNotifications: jest.fn(async () => []),
  getAdminDoneNotifications: jest.fn(async () => []),
  getAdminNotificationForExplainer: jest.fn(),
  isAdminOwnerOnly: jest.fn(async () => false),
  notifyAdmin: jest.fn(),
  markAdminIdeaCancelled: jest.fn(),
}));
jest.mock('../services/sms-operational-actions', () => ({ withTextNoteSources: jest.fn(async (rows) => rows) }));
jest.mock('../services/push-notifications', () => ({ status: jest.fn(() => ({ available: true, configured: true })) }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn(async () => ({ alerts: [] })) }));
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => true }));
jest.mock('../services/admin-unread', () => ({
  liveAlertNotifications: jest.fn(async () => ({ live: [], liveKeys: new Set() })),
  isLiveDuplicate: () => false,
  getUnreadCountForAdmin: jest.fn(),
}));
jest.mock('../services/admin-alert-buttons', () => ({
  withAlertButtons: jest.fn(async (rows) => rows),
  runAlertButton: jest.fn(async () => ({ status: 200, body: { success: true } })),
}));
jest.mock('../services/admin-alert-explainer', () => ({
  explainerLive: jest.fn(() => false),
  withExplainerFields: jest.fn(async (rows) => rows),
  explainAdminAlert: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  alertSendToClaudeLive: jest.fn(() => true),
  alertSendToClaudeCopyLive: jest.fn(() => true),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const users = {
      admin: { id: '11111111-1111-4111-8111-111111111111', role: 'admin', email: 'contact@wavespestcontrol.com' },
      office: { id: '33333333-3333-4333-8333-333333333333', role: 'admin', email: 'office@example.test' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technicianId = user.id;
    req.techRole = user.role;
    req.technician = { id: user.id, email: user.email || null };
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

const NotificationService = require('../services/notification-service');
const { alertSendToClaudeCopyLive, alertSendToClaudeLive } = require('../config/feature-gates');
const { runAlertButton } = require('../services/admin-alert-buttons');
const {
  copyRefusal, withSendCopyToClaudeFields, sendAlertCopyToClaude, cancelAlertCopy, copyLive,
} = require('../services/admin-alert-copy-to-claude');
const router = require('../routes/admin-notifications');

const PARENT = '00000000-0000-4000-8000-0000000000b1';
const COPY = '00000000-0000-4000-8000-0000000000b2';
const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VISIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION = 'a'.repeat(32);
const AT = '2026-11-04T15:00:00.000Z';
const OWNER = '11111111-1111-4111-8111-111111111111';
const WORDS = 'Synthetic Customer says the gate code is 0000 and asks to move Tuesday';

const contactRow = (over = {}) => ({
  id: PARENT, category: 'inbound_sms', title: `Text from ${WORDS}`, body: WORDS, detail: WORDS, done_at: null, version: VERSION,
  metadata: { dedupeKey: 'sms-inbound:abc', customerId: CUSTOMER, subject: { type: 'visit', id: VISIT }, payload: { body: WORDS } },
  ...over,
});
const stranger = (over = {}) => ({
  id: PARENT, category: 'service_request', title: WORDS, body: WORDS, done_at: null, version: VERSION,
  metadata: { dedupeKey: 'service-request:xyz', customerId: CUSTOMER }, ...over,
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/notifications', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/admin/notifications`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const call = (base, path, { who = 'admin', method = 'POST', body } = {}) => fetch(`${base}${path}`, {
  method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

beforeEach(() => {
  jest.clearAllMocks();
  alertSendToClaudeCopyLive.mockReturnValue(true);
  alertSendToClaudeLive.mockReturnValue(true);
  NotificationService.getAdminNotifications.mockResolvedValue([]);
  NotificationService.isAdminOwnerOnly.mockResolvedValue(false);
  NotificationService.getAdminNotificationForExplainer.mockResolvedValue(contactRow());
  NotificationService.notifyAdmin.mockResolvedValue({ id: COPY, deduped: false });
});

describe('copyRefusal', () => {
  test('null for a customer contact row and for a row our code did not write', () => {
    expect(copyRefusal(contactRow())).toBeNull();
    expect(copyRefusal(stranger())).toBeNull();
  });
  test('"sendable" for a row step 1 covers', () => {
    expect(copyRefusal({ id: PARENT, category: 'system', done_at: null, metadata: { dedupeKey: 'x:1' } })).toBe('sendable');
  });
  test.each([
    ['no row', null, 'not_found'],
    ['a live overlay row', contactRow({ id: 'live:alert-1' }), 'not_found'],
    ['a done row', contactRow({ done_at: new Date() }), 'done'],
    ['an Activity-only row', contactRow({ metadata: { feed: 'activity' } }), 'not_in_bell'],
    ['a guarded copy', contactRow({ metadata: { feed: 'activity', sentToClaude: { kind: 'guarded-copy' } } }), 'is_copy'],
    ['an owner idea', contactRow({ metadata: { sentToClaude: { kind: 'owner-idea' } } }), 'is_copy'],
  ])('%s', (_name, row, reason) => {
    expect(copyRefusal(row)).toBe(reason);
  });
  test('metadata as JSON text is read too', () => {
    expect(copyRefusal(contactRow({ metadata: JSON.stringify({ feed: 'activity' }) }))).toBe('not_in_bell');
  });
});

describe('copyLive', () => {
  test('reads the gate; a missing or throwing reader reads as off', () => {
    expect(copyLive()).toBe(true);
    alertSendToClaudeCopyLive.mockReturnValue(undefined);
    expect(copyLive()).toBe(false);
    alertSendToClaudeCopyLive.mockImplementation(() => { throw new Error('boom'); });
    expect(copyLive()).toBe(false);
  });
});

describe('withSendCopyToClaudeFields', () => {
  const rows = () => [contactRow(), { id: 'r2', category: 'system', done_at: null, metadata: { dedupeKey: 'x:1' }, sendToClaude: true }, stranger({ id: 'r3' })];
  test('marks refused rows for the owner login while the gate is on, and never a row step 1 marked', () => {
    const out = withSendCopyToClaudeFields(rows(), { role: 'admin', fullAccess: true });
    expect(out.map((r) => r.sendCopyToClaude === true)).toEqual([true, false, true]);
  });
  test.each([
    ['another admin login', { role: 'admin', fullAccess: false }],
    ['a technician', { role: 'technician', fullAccess: true }],
  ])('%s gets the rows as they are', (_name, opts) => {
    const input = rows();
    expect(withSendCopyToClaudeFields(input, opts)).toBe(input);
  });
  test('gate off: rows as they are; a throwing check leaves the row unmarked', () => {
    alertSendToClaudeCopyLive.mockReturnValue(false);
    const input = rows();
    expect(withSendCopyToClaudeFields(input, { role: 'admin', fullAccess: true })).toBe(input);
    alertSendToClaudeCopyLive.mockReturnValue(true);
    const bad = { id: 'r4', get category() { throw new Error('boom'); }, get done_at() { return null; }, metadata: {} };
    expect(withSendCopyToClaudeFields([bad], { role: 'admin', fullAccess: true })).toEqual([bad]);
  });
});

describe('sendAlertCopyToClaude', () => {
  const send = (over = {}) => sendAlertCopyToClaude(PARENT, { version: VERSION, by: OWNER, role: 'admin', technicianId: OWNER, ...over });

  test('writes ONE row with the exact shape and no customer words anywhere in the call', async () => {
    const out = await send({ note: '  Please read the whole thread  ' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ sent: true, id: COPY, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), message: 'Copy sent to Claude. A locked Claude tab opens on the Mac within about 10 minutes.' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect([category, title, body]).toEqual(['system', 'Copy for Claude', 'A copy of an alert. Claude reads it in a locked tab and writes a plan for you.']);
    expect(opts).not.toHaveProperty('detail');
    expect(opts.link).toBe('/admin');
    expect(opts.dedupeKey).toBe(`claude-copy:${PARENT}`);
    expect(opts.dedupeOpenOnly).toBe(true);
    expect(opts.metadata).toEqual({
      feed: 'activity',
      who: 'claude',
      severity: 'needs-you',
      claudeQueue: 'sent-to-claude',
      ownerOnly: true,
      dedupeKey: `claude-copy:${PARENT}`,
      sentToClaude: {
        at: out.body.at,
        by: OWNER,
        kind: 'guarded-copy',
        guarded: true,
        parentId: PARENT,
        parentKind: 'sms-inbound',
        parentCategory: 'inbound_sms',
        records: { customerId: CUSTOMER, visitId: VISIT },
        note: 'Please read the whole thread',
      },
    });
    const everything = JSON.stringify(NotificationService.notifyAdmin.mock.calls[0]);
    for (const word of ['Synthetic', 'gate code', 'Tuesday', 'move']) expect(everything).not.toContain(word);
  });

  test('the parent row is not written', async () => {
    await send();
    expect(NotificationService.markAdminIdeaCancelled).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('no note leaves the key out; a category or kind that is not a plain name is null; non-UUID ids are dropped', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(
      contactRow({ category: 'Bad Category!', metadata: { triggerKey: 'Not A Key', customerId: 'not-a-uuid', subject: { type: 'visit', id: `${VISIT}; drop` } } }),
    );
    await send();
    const stamp = NotificationService.notifyAdmin.mock.calls[0][3].metadata.sentToClaude;
    expect(stamp).not.toHaveProperty('note');
    expect(stamp).toMatchObject({ parentKind: null, parentCategory: null, records: {} });
  });

  test('a row that is gone answers 404; a changed version answers 409 changed; nothing is written', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValueOnce(null);
    expect(await send()).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await send({ version: 'b'.repeat(32) })).toEqual({ status: 409, body: { error: 'changed' } });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test.each([
    ['a row step 1 covers', { id: PARENT, category: 'system', title: 'x', done_at: null, version: VERSION, metadata: { dedupeKey: 'x:1' } }, 'sendable'],
    ['a done row', contactRow({ done_at: new Date() }), 'done'],
    ['an Activity-only row', contactRow({ metadata: { feed: 'activity' } }), 'not_in_bell'],
    ['a copy row', contactRow({ metadata: { sentToClaude: { kind: 'guarded-copy' } } }), 'is_copy'],
  ])('%s answers 409 with the reason and writes nothing', async (_name, row, error) => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row);
    expect(await send()).toEqual({ status: 409, body: { error } });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a bad note answers 400 and writes nothing', async () => {
    expect(await send({ note: 5 })).toEqual({ status: 400, body: { error: 'invalid_note' } });
    expect(await send({ note: 'x'.repeat(501) })).toEqual({ status: 400, body: { error: 'note_too_long' } });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('an open copy answers duplicate; a suppressed row 422; a failed write 500', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: COPY, deduped: true });
    expect(await send()).toEqual({ status: 200, body: { duplicate: true, id: COPY } });
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true, deduped: false });
    expect(await send()).toEqual({ status: 422, body: { error: 'not_sent' } });
    NotificationService.notifyAdmin.mockResolvedValue(null);
    expect((await send()).status).toBe(500);
  });
});

describe('cancelAlertCopy', () => {
  const copyRow = (stamp = {}, over = {}) => ({
    id: COPY, done_at: null, metadata: { claudeQueue: 'sent-to-claude', sentToClaude: { at: AT, kind: 'guarded-copy', ...stamp } }, ...over,
  });
  const cancel = () => cancelAlertCopy(COPY, { at: AT, by: OWNER, role: 'admin', technicianId: OWNER });

  test('an open untouched copy is cancelled as done by the owner, with the guarded-copy kind', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(copyRow());
    NotificationService.markAdminIdeaCancelled.mockResolvedValue(1);
    expect(await cancel()).toEqual({ status: 200, body: { cancelled: true } });
    expect(NotificationService.markAdminIdeaCancelled).toHaveBeenCalledWith(COPY, AT, OWNER, 'Cancelled by the owner.', 'guarded-copy');
  });
  test('a missing row answers 404', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(null);
    expect(await cancel()).toEqual({ status: 404, body: { error: 'not_found' } });
  });
  test.each([
    ['a Mac tab started', copyRow({ startedAt: AT }), 'started'],
    ['a different send', copyRow({ at: '2026-11-04T16:00:00.000Z' }), 'changed'],
    ['an idea, not a copy', copyRow({ kind: 'owner-idea' }), 'changed'],
    ['not in the queue', copyRow({}, { metadata: { sentToClaude: { at: AT, kind: 'guarded-copy' } } }), 'changed'],
    ['already done', copyRow({}, { done_at: new Date() }), 'done'],
  ])('%s answers 409 and writes nothing', async (_name, row, error) => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row);
    expect(await cancel()).toEqual({ status: 409, body: { error } });
    expect(NotificationService.markAdminIdeaCancelled).not.toHaveBeenCalled();
  });
  test('a copy that started between the read and the write answers with the state it is in now', async () => {
    NotificationService.getAdminNotificationForExplainer
      .mockResolvedValueOnce(copyRow()).mockResolvedValueOnce(copyRow({ startedAt: AT }));
    NotificationService.markAdminIdeaCancelled.mockResolvedValue(0);
    expect(await cancel()).toEqual({ status: 409, body: { error: 'started' } });
    NotificationService.getAdminNotificationForExplainer.mockResolvedValueOnce(copyRow()).mockResolvedValueOnce(null);
    expect(await cancel()).toEqual({ status: 404, body: { error: 'not_found' } });
  });
});

describe('routes', () => {
  const send = (base, o = {}) => call(base, `/${o.id || PARENT}/send-copy-to-claude`, { who: o.who, body: o.body || { version: VERSION.toUpperCase() } });
  const cancel = (base, o = {}) => call(base, `/${o.id || COPY}/cancel-copy`, { who: o.who, body: o.body || { at: AT } });

  test('gate off: both routes answer 404 like an unknown route and write nothing', async () => {
    alertSendToClaudeCopyLive.mockReturnValue(false);
    await withServer(async (base) => {
      expect(await send(base)).toEqual({ status: 404, body: { error: 'Not found' } });
      expect(await cancel(base)).toEqual({ status: 404, body: { error: 'Not found' } });
    });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('another admin login is refused 403, a technician 403, no login 401', async () => {
    await withServer(async (base) => {
      expect(await send(base, { who: 'office' })).toEqual({ status: 403, body: { error: 'This action is limited to the owner account.' } });
      expect((await cancel(base, { who: 'office' })).status).toBe(403);
      expect((await send(base, { who: 'tech' })).status).toBe(403);
      expect((await send(base, { who: 'nobody' })).status).toBe(401);
    });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('the owner send reaches the service with the lower-cased version and the caller\'s scope', async () => {
    await withServer(async (base) => {
      const out = await send(base, { body: { version: VERSION.toUpperCase(), note: 'Read the thread' } });
      expect(out.status).toBe(200);
      expect(out.body.sent).toBe(true);
    });
    expect(NotificationService.getAdminNotificationForExplainer).toHaveBeenCalledWith(PARENT, { role: 'admin', technicianId: OWNER });
    expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata.sentToClaude).toMatchObject({ note: 'Read the thread', by: OWNER });
  });

  test('a bad id is 404, a missing version or at is 400', async () => {
    await withServer(async (base) => {
      expect((await send(base, { id: 'not-a-uuid' })).status).toBe(404);
      expect((await cancel(base, { id: 'not-a-uuid' })).status).toBe(404);
      expect((await send(base, { body: {} })).status).toBe(400);
      expect((await send(base, { body: { version: 'short' } })).status).toBe(400);
      for (const at of [undefined, 5, 'yesterday', '2026-11-04']) expect((await cancel(base, { body: { at } })).status).toBe(400);
    });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a bad note answers 400 with its reason', async () => {
    await withServer(async (base) => {
      expect(await send(base, { body: { version: VERSION, note: 'x'.repeat(501) } })).toEqual({ status: 400, body: { error: 'note_too_long' } });
    });
  });

  test('the cancel route reaches the undo with the copy id and at', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue({
      id: COPY, done_at: null, metadata: { claudeQueue: 'sent-to-claude', sentToClaude: { at: AT, kind: 'guarded-copy' } },
    });
    NotificationService.markAdminIdeaCancelled.mockResolvedValue(1);
    await withServer(async (base) => {
      expect(await cancel(base)).toEqual({ status: 200, body: { cancelled: true } });
    });
    expect(NotificationService.markAdminIdeaCancelled).toHaveBeenCalledWith(COPY, AT, OWNER, 'Cancelled by the owner.', 'guarded-copy');
  });
});

describe('the bell list', () => {
  const listed = (over = {}) => [contactRow(over), { id: 'r2', category: 'system', title: 'Sync behind', done_at: null, metadata: { dedupeKey: 'x:1' } }];

  test('the owner login passes fullAccess and sees the copy button on a refused row only', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue(listed());
    await withServer(async (base) => {
      const out = await call(base, '/', { method: 'GET' });
      expect(out.status).toBe(200);
      expect(out.body.notifications.map((n) => [n.id, n.sendToClaude === true, n.sendCopyToClaude === true])).toEqual([
        [PARENT, false, true], ['r2', true, false],
      ]);
    });
    expect(NotificationService.getAdminNotifications).toHaveBeenCalledWith(51, 0, expect.objectContaining({ fullAccess: true, role: 'admin' }));
  });

  test('another admin login passes fullAccess false and gets no copy button', async () => {
    NotificationService.getAdminNotifications.mockResolvedValue(listed());
    await withServer(async (base) => {
      const out = await call(base, '/', { method: 'GET', who: 'office' });
      expect(out.body.notifications.some((n) => n.sendCopyToClaude)).toBe(false);
    });
    expect(NotificationService.getAdminNotifications).toHaveBeenCalledWith(51, 0, expect.objectContaining({ fullAccess: false }));
  });

  test('gate off: no copy button even for the owner', async () => {
    alertSendToClaudeCopyLive.mockReturnValue(false);
    NotificationService.getAdminNotifications.mockResolvedValue(listed());
    await withServer(async (base) => {
      const out = await call(base, '/', { method: 'GET' });
      expect(out.body.notifications.some((n) => n.sendCopyToClaude)).toBe(false);
    });
  });
});

describe('the alert-button tap route and owner-only rows', () => {
  const tap = (base, who) => call(base, `/${PARENT}/actions/dismiss`, { who, body: { version: VERSION } });

  test('another admin login gets 404 on an owner-only row and the button never runs', async () => {
    NotificationService.isAdminOwnerOnly.mockResolvedValue(true);
    await withServer(async (base) => {
      expect(await tap(base, 'office')).toEqual({ status: 404, body: { error: 'not_found' } });
    });
    expect(runAlertButton).not.toHaveBeenCalled();
    expect(NotificationService.isAdminOwnerOnly).toHaveBeenCalledWith(PARENT, { role: 'admin', technicianId: '33333333-3333-4333-8333-333333333333' });
  });

  test('the owner login is not asked and the button runs; a row that is not owner-only still runs for another admin', async () => {
    await withServer(async (base) => {
      expect((await tap(base, 'admin')).status).toBe(200);
      expect((await tap(base, 'office')).status).toBe(200);
    });
    expect(runAlertButton).toHaveBeenCalledTimes(2);
    expect(NotificationService.isAdminOwnerOnly).toHaveBeenCalledTimes(1);
  });
});
