jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const db = require('../models/db');

function chain(result = []) {
  const q = {};
  ['where', 'andWhere', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhereNull', 'whereRaw', 'modify', 'select', 'orderBy', 'limit', 'leftJoin', 'join']
    .forEach((m) => { q[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q, q); return q; }); });
  q.pluck = jest.fn(async () => []);
  q.update = jest.fn(async () => 0);
  q.del = jest.fn(async () => 0);
  q.first = jest.fn(async () => null);
  q.returning = jest.fn(async () => []);
  q.then = (res) => Promise.resolve(result).then(res);
  q.catch = (fn) => Promise.resolve(result).catch(fn);
  return q;
}
db.raw = jest.fn((sql) => ({ sql }));
db.transaction = jest.fn(async (fn) => fn(db));

test('a technician read scope excludes hidden recruiting rows; an admin scope does not', async () => {
  const { markInboundSmsRead } = require('../services/inbound-sms-read');
  const calls = [];
  db.mockImplementation((table) => { const q = chain([]); calls.push([table, q]); return q; });
  await markInboundSmsRead({ messageIds: ['m-1'], adminUserId: 'tech-1', role: 'technician' }).catch(() => {});
  const techScoped = calls.filter(([t]) => t === 'messages').some(([, q]) => q.orWhere.mock.calls.some((c) => c[0] === 'message_type' && c[1] === 'not like' && c[2] === 'job\\_%'));
  expect(techScoped).toBe(true);
  calls.length = 0;
  await markInboundSmsRead({ messageIds: ['m-1'], adminUserId: 'admin-1', role: 'admin' }).catch(() => {});
  const adminScoped = calls.filter(([t]) => t === 'messages').some(([, q]) => q.orWhere.mock.calls.some((c) => c[0] === 'message_type'));
  expect(adminScoped).toBe(false);
});

test('countUnreadInboundSms excludes recruiting rows from the customer SMS response rail', async () => {
  const { countUnreadInboundSms } = require('../services/inbound-sms-read');
  db.raw.mockResolvedValue({ rows: [] });
  await countUnreadInboundSms({ role: 'admin' });
  expect(db.raw.mock.calls.at(-1)[0]).toContain("s.message_type NOT LIKE 'job\\_%'");
});

test('an application scope reads that application\'s applicant replies up to the snapshot and clears its bells through the notification service (PR #4623 r20)', async () => {
  const { markInboundSmsRead } = require('../services/inbound-sms-read');
  const NotificationService = require('../services/notification-service');
  const bellSpy = jest.spyOn(NotificationService, 'markApplicantRepliesReadAdmin').mockResolvedValue(2);
  const sidSpy = jest.spyOn(NotificationService, 'markInboundSmsReadAdmin').mockResolvedValue(0);
  const chains = [];
  db.mockImplementation(() => { const q = chain([]); chains.push(q); return q; });
  const readBefore = new Date('2027-03-16T15:00:00.000Z');
  await expect(markInboundSmsRead({ applicationId: 'app-1', replyMessageIds: ['m-1'], adminUserId: 'admin-1', role: 'admin' })).rejects.toThrow(/readBefore required/);
  // the replies IN the snapshot are required (Codex r29 P1): a time cutoff alone would read a reply nobody saw
  await expect(markInboundSmsRead({ applicationId: 'app-1', readBefore, adminUserId: 'admin-1', role: 'admin' })).rejects.toThrow(/replyMessageIds/);
  // an empty snapshot acknowledges nothing and clears no bell
  await expect(markInboundSmsRead({ applicationId: 'app-1', replyMessageIds: [], readBefore, adminUserId: 'admin-1', role: 'admin' })).resolves.toEqual({ updated: 0, notificationsCleared: 0 });
  expect(bellSpy).not.toHaveBeenCalled();
  const result = await markInboundSmsRead({ applicationId: 'app-1', replyMessageIds: ['m-1', 'm-2'], replyEntryIds: ['e-1', 'e-2'], readBefore, adminUserId: 'admin-1', role: 'admin' });
  // the scope names the application's reply rows, bounded to the snapshot's message ids
  const scoped = chains.filter((q) => q.whereRaw.mock.calls.some((c) => /job_application_id/.test(c[0]) && c[1][0] === 'app-1'));
  expect(scoped.length).toBeGreaterThan(0);
  expect(scoped[0].whereIn.mock.calls.some((c) => c[0] === 'id' && c[1].join() === 'm-1,m-2')).toBe(true);
  expect(scoped[0].where.mock.calls.some((c) => c[0] === 'created_at' && c[1] === '<=' && c[2] === readBefore)).toBe(true);
  expect(scoped[0].where.mock.calls.some((c) => c[0] && c[0].message_type === 'job_applicant_reply')).toBe(true);
  // bells: only the snapshot replies (SIDs of those rows + the entry ids), never the whole application
  expect(bellSpy).toHaveBeenCalledTimes(1);
  expect(bellSpy.mock.calls[0][0]).toMatchObject({ applicationId: 'app-1', before: readBefore, role: 'admin', replyIds: expect.arrayContaining(['e-1', 'e-2']) });
  expect(result.notificationsCleared).toBeGreaterThanOrEqual(2);
  bellSpy.mockRestore(); sidSpy.mockRestore();
});
