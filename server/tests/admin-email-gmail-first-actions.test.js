/**
 * admin-email routes (Communications audit 2026-10-30, C03 C04 C07 C08).
 * - Read, star, archive and trash ask Gmail first: a refusal answers 502 and
 *   leaves the row alone, because the next sync copies Gmail's labels back
 *   and would quietly undo a portal-only change. A message Gmail no longer
 *   has (404) keeps the portal change. Opening an email marks it read the
 *   same way and answers the read state it reached.
 * - A reply carries replyEmailId; the route adds that row's Message-ID as
 *   In-Reply-To / References, as the scheduled send does.
 * - "Today" in stats and the daily digest starts at Eastern midnight.
 * - The Vendor view and count include 'vendor', the known-vendor class the
 *   sync stores before the classifier runs.
 * Handlers are called directly with an in-memory knex stand-in; no network,
 * Gmail, database or message.
 */
// Railway and CI run in UTC, where the old server-local midnight shows. On a
// laptop in Eastern time run it as `TZ=UTC npx jest ...` to see that bug.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (req, res, next) => next(), requireAdmin: (req, res, next) => next() }));
jest.mock('../services/email/gmail-client', () => ({
  modifyLabels: jest.fn(), archiveMessage: jest.fn(), trashMessage: jest.fn(), sendMessage: jest.fn(),
}));
jest.mock('../services/email/email-sync', () => ({ syncEmails: jest.fn() }));
jest.mock('../services/email/email-classifier', () => ({ classifyEmail: jest.fn() }));
jest.mock('../services/email/email-actions', () => ({ executeAutoAction: jest.fn() }));
jest.mock('../services/email/spam-blocker', () => ({ unblockSender: jest.fn(), manualBlockSender: jest.fn() }));
jest.mock('../services/staff-oauth-state', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const gmail = require('../services/email/gmail-client');
const router = require('../routes/admin-email');

let tables;
let boundaries;
function chainFor(table, preds = []) {
  let op = 'select';
  let value;
  let first = false;
  const rows = () => tables[table].filter((row) => preds.every((p) => p(row)));
  const chain = {
    where(a, b, c) {
      if (typeof a === 'object') preds.push((row) => Object.entries(a).every(([k, v]) => row[k] === v));
      else if (c !== undefined) {
        boundaries.push({ table, column: a, op: b, value: c });
        preds.push((row) => new Date(row[a]) >= c);
      } else preds.push((row) => row[a] === b);
      return chain;
    },
    whereIn(key, list) { preds.push((row) => list.includes(row[key])); return chain; },
    first() { first = true; return chain; },
    update(data) { op = 'update'; value = data; return chain; },
    count() { op = 'count'; return chain; },
    clone() { return chainFor(table, [...preds]); },
    orderBy() { return chain; },
    offset() { return chain; },
    limit() { return chain; },
    select() { return chain; },
    then(resolve, reject) {
      return Promise.resolve().then(() => {
        const matched = rows();
        if (op === 'update') { matched.forEach((row) => Object.assign(row, value)); return matched.length; }
        if (op === 'count') return [{ count: String(matched.length) }];
        return first ? (matched[0] ? { ...matched[0] } : undefined) : matched.map((row) => ({ ...row }));
      }).then(resolve, reject);
    },
  };
  return chain;
}

function installDb() {
  tables = {
    emails: [{ id: 'email-1', gmail_id: 'gmail-1', gmail_thread_id: 'thread-1', message_id: '<source-1@mail.example>', is_read: false, is_starred: false, is_archived: false }],
    email_attachments: [],
    blocked_email_senders: [],
  };
  boundaries = [];
  db.mockReset();
  db.mockImplementation((table) => {
    if (!(table in tables)) throw new Error(`Unexpected table ${table}`);
    return chainFor(table);
  });
}

const handler = (method, path) => router.stack
  .find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
async function call(method, path, { params = { id: 'email-1' }, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(json) { this.body = json; return this; } };
  await handler(method, path)({ params, query, body, technicianId: 'tech-1' }, res);
  return res;
}
const row = () => tables.emails[0];
const gone = () => Object.assign(new Error('Requested entity was not found.'), { code: 404 });

beforeEach(() => {
  jest.clearAllMocks();
  installDb();
});

describe('label actions ask Gmail first', () => {
  const ACTIONS = [
    ['read', 'modifyLabels', 'is_read', { is_read: true }],
    ['star', 'modifyLabels', 'is_starred', { is_starred: true }],
    ['archive', 'archiveMessage', 'is_archived', { archived: true }],
    ['trash', 'trashMessage', 'is_archived', { trashed: true }],
  ];

  test.each(ACTIONS)('%s: a Gmail refusal answers 502 and leaves the row unchanged', async (action, method, field) => {
    gmail[method].mockRejectedValueOnce(new Error('Gmail refused'));
    const res = await call('post', `/message/:id/${action}`);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Gmail did not accept the change. Try again.' });
    expect(row()[field]).toBe(false);
  });

  test.each(ACTIONS)('%s: an accepted change updates the row', async (action, method, field, response) => {
    gmail[method].mockResolvedValueOnce(undefined);
    const res = await call('post', `/message/:id/${action}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(response);
    expect(row()[field]).toBe(true);
    expect(gmail[method]).toHaveBeenCalledWith('gmail-1', ...(action === 'read' ? [[], ['UNREAD']] : action === 'star' ? [['STARRED'], []] : []));
  });

  test.each(ACTIONS)('%s: a message Gmail no longer has (404) keeps the portal change', async (action, method, field) => {
    gmail[method].mockRejectedValueOnce(gone());
    const res = await call('post', `/message/:id/${action}`);
    expect(res.statusCode).toBe(200);
    expect(row()[field]).toBe(true);
  });

  test('read and star still toggle back off through Gmail', async () => {
    Object.assign(row(), { is_read: true, is_starred: true });
    await call('post', '/message/:id/read');
    await call('post', '/message/:id/star');
    expect(gmail.modifyLabels.mock.calls).toEqual([['gmail-1', ['UNREAD'], []], ['gmail-1', [], ['STARRED']]]);
    expect(row()).toMatchObject({ is_read: false, is_starred: false });
  });
});

describe('opening an email marks it read in Gmail first', () => {
  test('Gmail accepts: the row is read and the answer says so', async () => {
    gmail.modifyLabels.mockResolvedValueOnce(undefined);
    const res = await call('get', '/message/:id');
    expect(res.body).toMatchObject({ id: 'email-1', is_read: true, attachments: [] });
    expect(row().is_read).toBe(true);
  });

  test('Gmail refuses: the email still opens, unread, and the row is unchanged', async () => {
    gmail.modifyLabels.mockRejectedValueOnce(new Error('Gmail refused'));
    const res = await call('get', '/message/:id');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 'email-1', is_read: false });
    expect(row().is_read).toBe(false);
  });

  test('an already-read email makes no Gmail call', async () => {
    row().is_read = true;
    const res = await call('get', '/message/:id');
    expect(res.body.is_read).toBe(true);
    expect(gmail.modifyLabels).not.toHaveBeenCalled();
  });
});

describe('a reply carries the source Message-ID', () => {
  const reply = { to: 'fixture@example.invalid', subject: 'Re: Fixture', body: 'Test only', threadId: 'thread-1' };
  beforeEach(() => gmail.sendMessage.mockResolvedValue({ id: 'sent-1' }));

  test('replyEmailId resolves the stored Message-ID into In-Reply-To', async () => {
    const res = await call('post', '/send', { body: { ...reply, replyEmailId: 'email-1' } });
    expect(res.body).toMatchObject({ status: 'provider_accepted', messageId: 'sent-1' });
    expect(gmail.sendMessage).toHaveBeenCalledWith(reply.to, reply.subject, reply.body, 'thread-1', '<source-1@mail.example>');
  });

  test('a row with no captured Message-ID (or no row) still sends, without the header', async () => {
    row().message_id = null;
    await call('post', '/send', { body: { ...reply, replyEmailId: 'email-1' } });
    await call('post', '/send', { body: { ...reply, replyEmailId: 'missing-row' } });
    expect(gmail.sendMessage.mock.calls.map((args) => args[4])).toEqual([null, null]);
  });

  test('a row from another thread gives no header (it would contradict the thread id)', async () => {
    await call('post', '/send', { body: { ...reply, threadId: 'thread-2', replyEmailId: 'email-1' } });
    expect(gmail.sendMessage).toHaveBeenCalledWith(reply.to, reply.subject, reply.body, 'thread-2', null);
  });

  test('a failed lookup only loses the header; the reply still goes', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const res = await call('post', '/send', { body: { ...reply, replyEmailId: 'email-1' } });
    expect(res.body.status).toBe('provider_accepted');
    expect(gmail.sendMessage).toHaveBeenCalledWith(reply.to, reply.subject, reply.body, 'thread-1', null);
  });
});

describe('"Today" starts at Eastern midnight', () => {
  afterEach(() => jest.useRealTimers());
  const at = (iso) => jest.useFakeTimers({ now: new Date(iso), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

  test.each([
    ['10 AM EDT', '2026-10-30T14:00:00Z', '2026-10-30T04:00:00.000Z'],
    // 10:30 PM EDT on Oct 29 is already Oct 30 in UTC: the UTC midnight
    // would have started "today" two hours ago.
    ['10:30 PM EDT', '2026-10-30T02:30:00Z', '2026-10-29T04:00:00.000Z'],
    ['10 AM EST', '2026-12-15T15:00:00Z', '2026-12-15T05:00:00.000Z'],
  ])('stats at %s', async (_label, now, midnight) => {
    at(now);
    tables.emails.push({ id: 'old', received_at: new Date(new Date(midnight).getTime() - 60000), is_read: true, is_archived: false, is_starred: false });
    tables.emails.push({ id: 'new', received_at: new Date(new Date(midnight).getTime() + 60000), is_read: true, is_archived: false, is_starred: false });
    row().received_at = new Date(midnight);
    const res = await call('get', '/stats');
    const boundary = boundaries.find((b) => b.column === 'received_at');
    expect(boundary.value.toISOString()).toBe(midnight);
    expect(res.body.today).toBe(2);
  });

  test('the daily digest uses the same Eastern day for email and blocked senders', async () => {
    at('2026-10-30T02:30:00Z');
    const res = await call('get', '/daily-digest');
    expect(res.statusCode).toBe(200);
    expect(boundaries.map((b) => [b.table, b.column, b.value.toISOString()])).toEqual([
      ['emails', 'received_at', '2026-10-29T04:00:00.000Z'],
      ['blocked_email_senders', 'created_at', '2026-10-29T04:00:00.000Z'],
    ]);
  });
});

describe('the Vendor view includes known-vendor mail the classifier has not replaced', () => {
  beforeEach(() => {
    tables.emails = ['vendor', 'vendor_invoice', 'vendor_communication', 'lead_inquiry', null].map((classification, i) => ({
      id: `e-${i}`, classification, is_read: true, is_starred: false, is_archived: false, received_at: new Date(),
    }));
  });

  test('inbox ?category=vendor lists all three vendor classes', async () => {
    const res = await call('get', '/inbox', { query: { category: 'vendor' } });
    expect(res.body.total).toBe(3);
    expect(res.body.emails.map((e) => e.classification).sort()).toEqual(['vendor', 'vendor_communication', 'vendor_invoice']);
  });

  test('the Vendor count matches the view', async () => {
    const res = await call('get', '/stats');
    expect(res.body.vendor).toBe(3);
  });
});
