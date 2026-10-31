/**
 * Messenger inbox against live Postgres (GATE_MESSENGER_INBOX): the poll's
 * mapping, paging, cursor, dedupe, first-run rules and bell lifecycle, and the
 * thread routes with a reply through a mocked Facebook Send API. Facebook is a
 * fake fetch; nothing here calls Meta. Every name and id is synthetic and tagged
 * with this run's id; cleanup removes only those rows. It refuses any database
 * but a private QA one or CI's.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'messenger-inbox-postgres-only';

const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const role = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || 'admin';
    req.technicianId = role === 'technician' ? '00000000-0000-4000-8000-000000000001' : null;
    req.techRole = role;
    next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
}));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('messenger inbox (live Postgres)', () => {
  const RUN = randomUUID().slice(0, 8);
  const PAGE = `9${RUN.replace(/\D/g, '1')}01`;
  const HOUR = 60 * 60 * 1000;
  const ago = (hours) => new Date(Date.now() - hours * HOUR);
  const psid = (n) => `${RUN}-psid-${n}`;
  let db;
  let messenger;
  let server;
  let base;
  let fb;
  let sends;
  // The service reads Facebook through global fetch (faked); the route calls use the real one.
  const realFetch = global.fetch;

  // A fake Graph. Conversations: { id, psid, name, updated, unread, messages: [{ id, fromPage, text, at, files }] }.
  function installFacebook(pageSize = 25) {
    fb = { conversations: [], failMessagesFor: null, sendResult: { message_id: `m_sent_${RUN}` }, sendStatus: 200, calls: [] };
    sends = [];
    global.fetch = jest.fn(async (rawUrl, init = {}) => {
      const url = new URL(rawUrl);
      fb.calls.push(`${init.method || 'GET'} ${url.pathname}`);
      const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
      if (init.method === 'POST') {
        sends.push(JSON.parse(init.body));
        return json(fb.sendStatus === 200 ? fb.sendResult : { error: { code: 10, message: 'synthetic refusal' } }, fb.sendStatus);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      const [, id, edge] = parts;
      if (edge === 'conversations') {
        const sorted = [...fb.conversations].sort((a, b) => b.updated - a.updated);
        const at = Number(url.searchParams.get('__page') || 0);
        const slice = sorted.slice(at * pageSize, (at + 1) * pageSize);
        const more = (at + 1) * pageSize < sorted.length;
        return json({
          data: slice.map((c) => ({
            id: c.id, updated_time: c.updated.toISOString(), unread_count: c.unread, message_count: c.messages.length,
            participants: { data: [{ id: PAGE, name: 'Waves Pest Control' }, { id: c.psid, name: c.name }] },
          })),
          ...(more ? { paging: { next: `https://graph.facebook.com/v25.0/${PAGE}/conversations?__page=${at + 1}&access_token=${url.searchParams.get('access_token')}` } } : {}),
        });
      }
      if (edge === 'messages') {
        if (fb.failMessagesFor === id) return json({ error: { code: 2 } }, 500);
        const conv = fb.conversations.find((c) => c.id === id);
        const newestFirst = [...conv.messages].sort((a, b) => b.at - a.at);
        return json({
          data: newestFirst.map((m) => ({
            id: m.id, message: m.text, created_time: m.at.toISOString(),
            from: m.fromPage ? { id: PAGE, name: 'Waves Pest Control' } : { id: conv.psid, name: conv.name },
            ...(m.files ? { attachments: { data: m.files.map((mime_type) => ({ id: 'att', mime_type })) } } : {}),
          })),
        });
      }
      return json({}, 404);
    });
  }

  const mid = (conv, n) => `m_${RUN}_${conv}_${n}_${'x'.repeat(70)}`;
  function conversation(key, { name, unread = 0, messages }) {
    const c = { id: `t_${RUN}_${key}`, psid: psid(key), name, unread, messages: messages.map((m, i) => ({ id: mid(key, i), ...m })) };
    c.updated = c.messages.reduce((latest, m) => (m.at > latest ? m.at : latest), c.messages[0].at);
    fb.conversations.push(c);
    return c;
  }

  const threadOf = (key) => db('conversations').where({ contact_external_id: `messenger:${psid(key)}`, channel: 'facebook_messenger' }).first();
  const messagesOf = async (key) => db('messages').where({ conversation_id: (await threadOf(key)).id }).orderBy('created_at', 'asc');
  const bellsOf = async (key) => db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [messenger.bellKey((await threadOf(key)).id)]);
  const cursor = async () => (await db('system_settings').where({ key: 'messenger_inbox_cursor' }).first('value'))?.value;
  const resetCursor = () => db('system_settings').where({ key: 'messenger_inbox_cursor' }).del();

  async function wipe() {
    const threads = await db('conversations').where({ our_endpoint_id: `messenger:${PAGE}` }).select('id');
    const keys = threads.map((t) => messenger.bellKey(t.id));
    if (keys.length) await db('notifications').whereRaw("metadata->>'dedupeKey' = ANY(?::text[])", [keys]).del();
    await db('conversations').where({ our_endpoint_id: `messenger:${PAGE}` }).del();
    await resetCursor();
  }

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    messenger = require('../services/messenger-inbox');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/messenger', require('../routes/admin-messenger'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/admin/messenger`;
  }, 60000);

  afterAll(async () => {
    delete process.env.GATE_MESSENGER_INBOX;
    global.fetch = realFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await wipe();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_MESSENGER_INBOX = 'true';
    process.env.FACEBOOK_ACCESS_TOKEN = 'synthetic-page-token';
    process.env.FACEBOOK_PAGE_ID = PAGE;
    await wipe();
    installFacebook();
  });

  describe('the poll', () => {
    test('first run maps inbound and outbound, stores photo and file placeholders, keeps Graph ids, and moves the cursor', async () => {
      conversation('a', {
        name: 'Pat Synthetic', unread: 1,
        messages: [
          { fromPage: false, text: 'Do you treat for ants?', at: ago(30) },
          { fromPage: true, text: 'Yes we do.', at: ago(29) },
          { fromPage: false, text: '', files: ['image/jpeg'], at: ago(28) },
          { fromPage: false, text: '', files: ['application/pdf'], at: ago(27) },
        ],
      });
      const result = await messenger.pollMessenger();
      expect(result).toMatchObject({ conversations: 1, inserted: 4, firstRun: true });

      const thread = await threadOf('a');
      expect(thread).toMatchObject({ channel: 'facebook_messenger', our_endpoint_id: `messenger:${PAGE}`, contact_label: 'Pat Synthetic', unknown_contact: true });
      const rows = await messagesOf('a');
      expect(rows.map((r) => [r.direction, r.author_type, r.body])).toEqual([
        ['inbound', 'customer', 'Do you treat for ants?'],
        ['outbound', 'admin', 'Yes we do.'],
        ['inbound', 'customer', '[Photo]'],
        ['inbound', 'customer', '[Attachment]'],
      ]);
      rows.forEach((row, i) => {
        expect(row.twilio_sid).toBe(messenger.messageKey(mid('a', i)));
        expect(row.twilio_sid).toMatch(/^fb:[0-9a-f]{48}$/);
        expect(row.metadata).toMatchObject({ graph_mid: mid('a', i), source: 'facebook' });
        expect(row.channel).toBe('facebook_messenger');
        expect(row.admin_user_id).toBeNull();
      });
      expect(new Date(await cursor()).getTime()).toBe(fb.conversations[0].updated.getTime());
    });

    test('first run leaves a message unread only where Facebook shows the conversation unread, and rings only those', async () => {
      conversation('a', { name: 'Pat Synthetic', unread: 2, messages: [{ fromPage: false, text: 'Still waiting on a call back', at: ago(5) }] });
      conversation('b', { name: 'Kim Sample', unread: 0, messages: [{ fromPage: false, text: 'Thanks, all set', at: ago(20) }] });
      conversation('c', { name: 'Lee Example', unread: 0, messages: [{ fromPage: false, text: 'Price?', at: ago(40) }, { fromPage: true, text: 'Sent you a quote', at: ago(39) }] });
      await messenger.pollMessenger();

      expect((await messagesOf('a'))[0].is_read).toBe(false);
      expect((await messagesOf('b'))[0].is_read).toBe(true);
      expect((await bellsOf('a'))).toHaveLength(1);
      expect((await bellsOf('b'))).toHaveLength(0);
      expect((await bellsOf('c'))).toHaveLength(0);
      const [bell] = await bellsOf('a');
      expect(bell).toMatchObject({ category: 'alert', done_at: null });
      expect(bell.title).toContain('Pat Synthetic');
      expect(bell.link).toBe(`/admin/communications#tab=messenger&thread=${(await threadOf('a')).id}`);
      expect(bell.metadata).toMatchObject({ area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'customer_answered', conversationId: (await threadOf('a')).id });
    });

    test('a second poll with nothing new reads no messages; resetting the cursor re-reads everything and stores nothing twice', async () => {
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'Hello there', at: ago(3) }] });
      await messenger.pollMessenger();
      fb.calls.length = 0;
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 0, inserted: 0, firstRun: false });
      expect(fb.calls.some((c) => c.endsWith('/messages'))).toBe(false);

      await resetCursor();
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 1, inserted: 0 });
      expect(await messagesOf('a')).toHaveLength(1);
      const bells = await bellsOf('a');
      expect(bells).toHaveLength(1);
    });

    test('pages through conversations and stops at the cursor', async () => {
      installFacebook(1);
      for (const [key, hours] of [['a', 10], ['b', 20], ['c', 30]]) {
        conversation(key, { name: `Pat Synthetic ${key}`, unread: 1, messages: [{ fromPage: false, text: `hello ${key}`, at: ago(hours) }] });
      }
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 3, inserted: 3 });
      expect(fb.calls.filter((c) => c.endsWith('/conversations'))).toHaveLength(3);

      fb.calls.length = 0;
      conversation('d', { name: 'Pat Synthetic d', messages: [{ fromPage: false, text: 'new one', at: ago(1) }] });
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 1, inserted: 1 });
      // The newest page holds the new conversation and the next page's first row is at the cursor: two list calls, not four.
      expect(fb.calls.filter((c) => c.endsWith('/conversations'))).toHaveLength(2);
    });

    test('a new customer message rings that thread once, each later message re-rings the same row, and a Facebook-side reply closes it', async () => {
      const conv = conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'First question', at: ago(8) }] });
      await messenger.pollMessenger();
      const [first] = await bellsOf('a');

      // Staff reads the bell, then the customer writes again.
      await db('notifications').where({ id: first.id }).update({ read_at: new Date() });
      conv.messages.push({ id: mid('a', 1), fromPage: false, text: 'Second question', at: ago(4) });
      conv.updated = ago(4);
      await messenger.pollMessenger();
      const afterSecond = await bellsOf('a');
      expect(afterSecond).toHaveLength(1);
      expect(afterSecond[0].id).toBe(first.id);
      expect(afterSecond[0].read_at).toBeNull();
      expect(afterSecond[0].done_at).toBeNull();
      expect(afterSecond[0].body).toContain('Second question');

      // The same words again are still a new message and still ring.
      await db('notifications').where({ id: first.id }).update({ read_at: new Date() });
      conv.messages.push({ id: mid('a', 2), fromPage: false, text: 'Second question', at: ago(3) });
      conv.updated = ago(3);
      await messenger.pollMessenger();
      expect((await bellsOf('a'))[0].read_at).toBeNull();

      // Somebody answers in Facebook: the poll sees an outbound message and closes the bell.
      conv.messages.push({ id: mid('a', 3), fromPage: true, text: 'Calling you now', at: ago(2) });
      conv.updated = ago(2);
      await messenger.pollMessenger();
      const [closed] = await bellsOf('a');
      expect(closed.done_at).not.toBeNull();
      expect(closed.done_by).toBe('messenger-inbox');
      expect(closed.resolution).toBe('Answered in Messenger');
      const outbound = (await messagesOf('a')).filter((m) => m.direction === 'outbound');
      expect(outbound).toHaveLength(1);
      expect(outbound[0]).toMatchObject({ author_type: 'admin', admin_user_id: null });
      expect(outbound[0].metadata.source).toBe('facebook');

      // A customer who writes after the reply reopens the same row.
      conv.messages.push({ id: mid('a', 4), fromPage: false, text: 'One more thing', at: ago(1) });
      conv.updated = ago(1);
      await messenger.pollMessenger();
      const reopened = await bellsOf('a');
      expect(reopened).toHaveLength(1);
      expect(reopened[0].done_at).toBeNull();
    });

    test('a conversation that cannot be read keeps the cursor behind it, is retried, and fails the job', async () => {
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'older thread', at: ago(20) }] });
      const broken = conversation('b', { name: 'Kim Sample', unread: 1, messages: [{ fromPage: false, text: 'newer thread', at: ago(10) }] });
      fb.failMessagesFor = broken.id;
      await expect(messenger.pollMessenger()).rejects.toThrow(/left 1 conversation/);
      expect(await threadOf('a')).toBeTruthy();
      expect(await threadOf('b')).toBeUndefined();
      expect(new Date(await cursor()).getTime()).toBe(fb.conversations.find((c) => c.id !== broken.id).updated.getTime());

      fb.failMessagesFor = null;
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 1, inserted: 1 });
      expect(await threadOf('b')).toBeTruthy();
    });

    test('a linked customer thread keeps its customer and takes new messages', async () => {
      const conv = conversation('a', { name: 'Pat Synthetic', unread: 0, messages: [{ fromPage: false, text: 'hi', at: ago(50) }] });
      await messenger.pollMessenger();
      const [customer] = await db('customers').insert({ first_name: 'Pat', last_name: `Synthetic${RUN}`, phone: `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}` }).returning('id');
      try {
        await db('conversations').where({ id: (await threadOf('a')).id }).update({ customer_id: customer.id, unknown_contact: false });
        conv.messages.push({ id: mid('a', 1), fromPage: false, text: 'hi again', at: ago(2) });
        conv.updated = ago(2);
        await messenger.pollMessenger();
        expect(await db('conversations').where({ our_endpoint_id: `messenger:${PAGE}`, contact_external_id: `messenger:${psid('a')}` })).toHaveLength(1);
        expect((await messagesOf('a')).map((m) => m.body)).toEqual(['hi', 'hi again']);
      } finally {
        await db('conversations').where({ our_endpoint_id: `messenger:${PAGE}` }).update({ customer_id: null });
        await db('customers').where({ id: customer.id }).del();
      }
    });
  });

  describe('the routes', () => {
    const get = (path, who = 'admin') => realFetch(`${base}${path}`, { headers: { Authorization: `Bearer ${who}` } });
    const post = (path, body, who = 'admin') => realFetch(`${base}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });

    async function seed() {
      conversation('open', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'Can someone call me about wasps?', at: ago(2) }] });
      conversation('late', { name: 'Kim Sample', unread: 1, messages: [{ fromPage: false, text: 'Need a quote', at: ago(30) }] });
      conversation('done', { name: 'Lee Example', unread: 0, messages: [{ fromPage: false, text: 'Thanks', at: ago(6) }, { fromPage: true, text: 'Anytime', at: ago(5) }] });
      await messenger.pollMessenger();
    }

    test('summary counts threads waiting for an answer; the list and a thread carry the documented shapes', async () => {
      await seed();
      const summary = await (await get('/summary')).json();
      expect(summary).toMatchObject({ enabled: true });
      expect(summary.unanswered).toBeGreaterThanOrEqual(2);

      const { threads } = await (await get('/threads')).json();
      const mine = threads.filter((t) => ['Pat Synthetic', 'Kim Sample', 'Lee Example'].includes(t.name));
      expect(mine.map((t) => t.name)).toEqual(['Pat Synthetic', 'Lee Example', 'Kim Sample']);
      const open = mine.find((t) => t.name === 'Pat Synthetic');
      expect(open).toMatchObject({ snippet: 'Can someone call me about wasps?', unread: 1, answered: false, canReply: true });
      expect(Object.keys(open).sort()).toEqual(['answered', 'canReply', 'id', 'lastInboundAt', 'lastMessageAt', 'name', 'snippet', 'unread']);
      expect(mine.find((t) => t.name === 'Kim Sample')).toMatchObject({ answered: false, canReply: false });
      expect(mine.find((t) => t.name === 'Lee Example')).toMatchObject({ answered: true });

      const detail = await (await get(`/threads/${open.id}`)).json();
      expect(detail.thread.id).toBe(open.id);
      expect(detail.messages).toEqual([expect.objectContaining({ direction: 'inbound', body: 'Can someone call me about wasps?', author: { type: 'customer', name: 'Pat Synthetic' } })]);
      expect((await get('/threads/not-a-uuid')).status).toBe(404);
      expect((await get(`/threads/${randomUUID()}`)).status).toBe(404);
    });

    test('opening a thread marks its customer messages read', async () => {
      await seed();
      const { threads } = await (await get('/threads')).json();
      const open = threads.find((t) => t.name === 'Pat Synthetic');
      expect(await (await post(`/threads/${open.id}/read`)).json()).toEqual({ updated: 1 });
      const after = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Pat Synthetic');
      expect(after.unread).toBe(0);
      expect(await (await post(`/threads/${open.id}/read`)).json()).toEqual({ updated: 0 });
    });

    test('a reply inside the window goes to Facebook, is stored under the sender, and closes the bell', async () => {
      await seed();
      const open = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Pat Synthetic');
      expect(await bellsOf('open')).toHaveLength(1);
      const res = await post(`/threads/${open.id}/reply`, { text: 'We can call you at 3.' });
      expect(res.status).toBe(200);
      expect(sends).toEqual([{ recipient: { id: psid('open') }, messaging_type: 'RESPONSE', message: { text: 'We can call you at 3.' } }]);
      const rows = await messagesOf('open');
      const sent = rows[rows.length - 1];
      expect(sent).toMatchObject({ direction: 'outbound', author_type: 'admin', body: 'We can call you at 3.', is_read: true });
      expect(sent.twilio_sid).toBe(messenger.messageKey(`m_sent_${RUN}`));
      expect(sent.metadata).toMatchObject({ graph_mid: `m_sent_${RUN}`, source: 'portal' });
      const [bell] = await bellsOf('open');
      expect(bell).toMatchObject({ done_by: 'messenger-inbox', resolution: 'Answered in Messenger' });
      const thread = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Pat Synthetic');
      expect(thread.answered).toBe(true);

      // The next poll sees the same message in Facebook and stores nothing twice.
      const conv = fb.conversations.find((c) => c.psid === psid('open'));
      conv.messages.push({ id: `m_sent_${RUN}`, fromPage: true, text: 'We can call you at 3.', at: new Date() });
      conv.updated = new Date();
      await messenger.pollMessenger();
      expect((await messagesOf('open')).filter((m) => m.direction === 'outbound')).toHaveLength(1);
    });

    test('a reply past 24 hours is 409 outside_window: nothing goes to Facebook and nothing is stored', async () => {
      await seed();
      const late = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Kim Sample');
      const before = (await messagesOf('late')).length;
      const res = await post(`/threads/${late.id}/reply`, { text: 'Sorry for the wait' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'outside_window' });
      expect(sends).toEqual([]);
      expect(await messagesOf('late')).toHaveLength(before);
      expect((await bellsOf('late'))[0].done_at).toBeNull();
    });

    test('Facebook refusing the send is 502 and writes nothing; the bell stays open', async () => {
      await seed();
      const open = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Pat Synthetic');
      const before = (await messagesOf('open')).length;
      fb.sendStatus = 400;
      const res = await post(`/threads/${open.id}/reply`, { text: 'We can call you at 3.' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'send_failed' });
      expect(await messagesOf('open')).toHaveLength(before);
      expect((await bellsOf('open'))[0].done_at).toBeNull();
    });

    test('a technician sees no thread that is not linked to a customer on their route', async () => {
      await seed();
      const open = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Pat Synthetic');
      expect(await (await get('/summary', 'technician')).json()).toEqual({ enabled: true, unanswered: 0 });
      expect((await (await get('/threads', 'technician')).json()).threads).toEqual([]);
      expect((await get(`/threads/${open.id}`, 'technician')).status).toBe(404);
      expect((await post(`/threads/${open.id}/reply`, { text: 'hi' }, 'technician')).status).toBe(404);
      expect(sends).toEqual([]);
    });

    test('gate off: the routes answer enabled:false / 404 and the poll reads nothing', async () => {
      await seed();
      process.env.GATE_MESSENGER_INBOX = 'false';
      expect(await (await get('/summary')).json()).toEqual({ enabled: false });
      expect((await get('/threads')).status).toBe(404);
      fb.calls.length = 0;
      expect(await messenger.pollMessenger()).toEqual({ skipped: 'gate_off' });
      expect(fb.calls).toEqual([]);
    });
  });
});
