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
// Real Postgres on a loaded CI runner: past jest's 5 s default (like the other DATABASE_URL suites).
jest.setTimeout(120000);
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
      if (fb.unreadableOnce && (init.method || 'GET') === 'GET' && url.pathname.endsWith('/conversations')) {
        fb.unreadableOnce = false;
        return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
      }
      if (init.method === 'POST') {
        sends.push(JSON.parse(init.body));
        if (fb.sendThrows) throw new TypeError('fetch failed');
        return json(fb.sendStatus === 200 ? fb.sendResult : { error: { code: 10, message: 'synthetic refusal' } }, fb.sendStatus);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      const [, id, edge] = parts;
      if (id === 'me' && !edge) return json({ id: fb.meId || PAGE, name: 'Waves Pest Control' });
      const pageEntry = fb.pageAs || { id: PAGE, name: 'Waves Pest Control' };
      if (edge === 'conversations') {
        const sorted = [...fb.conversations].sort((a, b) => b.updated - a.updated);
        const at = Number(url.searchParams.get('__page') || 0);
        const slice = sorted.slice(at * pageSize, (at + 1) * pageSize);
        const more = (at + 1) * pageSize < sorted.length;
        return json({
          data: slice.map((c) => ({
            id: c.id, updated_time: c.updated.toISOString(), unread_count: c.unread, message_count: c.messages.length,
            participants: { data: [pageEntry, { id: c.psid, name: c.name }, ...(c.extraParticipants || [])] },
          })),
          ...(more ? { paging: { next: `https://graph.facebook.com/v25.0/${PAGE}/conversations?__page=${at + 1}&access_token=${url.searchParams.get('access_token')}` } } : {}),
        });
      }
      if (edge === 'messages') {
        if (fb.failMessagesFor === id) return json({ error: { code: 2 } }, 500);
        const conv = fb.conversations.find((c) => c.id === id);
        const newestFirst = [...conv.messages].sort((a, b) => b.at - a.at);
        const size = fb.messagePageSize || newestFirst.length || 1;
        const at = Number(url.searchParams.get('__page') || 0);
        const more = (at + 1) * size < newestFirst.length;
        return json({
          ...(more ? { paging: { next: `https://graph.facebook.com/v25.0/${id}/messages?__page=${at + 1}&access_token=${url.searchParams.get('access_token')}` } } : {}),
          data: newestFirst.slice(at * size, (at + 1) * size).map((m) => ({
            id: m.id, message: m.text, created_time: m.at.toISOString(),
            from: m.fromPage ? pageEntry : { id: conv.psid, name: conv.name },
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
    await db('system_settings').where({ key: 'messenger_inbox_bootstrap_done' }).del();
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
    messenger._private.resetPageIdentity();
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

    test('a second poll re-reads only the conversation at the cursor and changes nothing; resetting the cursor re-reads everything and stores nothing twice', async () => {
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'Hello there', at: ago(3) }] });
      conversation('z', { name: 'Kim Sample', unread: 0, messages: [{ fromPage: false, text: 'Older one', at: ago(30) }] });
      await messenger.pollMessenger();
      const [first] = await bellsOf('a');
      await db('notifications').where({ id: first.id }).update({ read_at: new Date() });

      fb.calls.length = 0;
      // The boundary is inclusive: the newest conversation is read again, the older one is not.
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 1, inserted: 0, firstRun: false });
      expect(fb.calls.filter((c) => c.endsWith('/messages'))).toHaveLength(1);
      expect(await messagesOf('a')).toHaveLength(1);
      // The same message is the same bell version: no second ring.
      const [again] = await bellsOf('a');
      expect(again.id).toBe(first.id);
      expect(again.read_at).not.toBeNull();

      await resetCursor();
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 2, inserted: 0 });
      expect(await messagesOf('a')).toHaveLength(1);
      expect(await bellsOf('a')).toHaveLength(1);
    });

    test('pages through conversations and reads back to the cursor', async () => {
      installFacebook(1);
      for (const [key, hours] of [['a', 10], ['b', 20], ['c', 30]]) {
        conversation(key, { name: `Pat Synthetic ${key}`, unread: 1, messages: [{ fromPage: false, text: `hello ${key}`, at: ago(hours) }] });
      }
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 3, inserted: 3 });
      expect(fb.calls.filter((c) => c.endsWith('/conversations'))).toHaveLength(3);

      fb.calls.length = 0;
      conversation('d', { name: 'Pat Synthetic d', messages: [{ fromPage: false, text: 'new one', at: ago(1) }] });
      // The new conversation plus the one at the cursor; the page after them is older and stops the walk.
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 2, inserted: 1 });
      expect(fb.calls.filter((c) => c.endsWith('/conversations'))).toHaveLength(3);
    });

    test('two conversations sharing an update time: the one that fails is read again, never skipped by the cursor', async () => {
      const when = ago(6);
      conversation('z', { name: 'Lee Example', unread: 1, messages: [{ fromPage: false, text: 'older group', at: ago(20) }] });
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'same time a', at: when }] });
      const b = conversation('b', { name: 'Kim Sample', unread: 1, messages: [{ fromPage: false, text: 'same time b', at: when }] });
      fb.failMessagesFor = b.id;
      await expect(messenger.pollMessenger()).rejects.toThrow(/left 1 conversation/);
      // The cursor stops at the older group: never at or past the shared time.
      expect(new Date(await cursor()).getTime()).toBe(fb.conversations.find((c) => c.psid === psid('z')).updated.getTime());
      expect(await threadOf('b')).toBeUndefined();

      fb.failMessagesFor = null;
      expect(await messenger.pollMessenger()).toMatchObject({ inserted: 1 });
      expect((await messagesOf('b')).map((m) => m.body)).toEqual(['same time b']);
      expect(await messagesOf('a')).toHaveLength(1);
      expect(new Date(await cursor()).getTime()).toBe(when.getTime());

      // Replaying the whole group at the cursor writes nothing twice.
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 2, inserted: 0 });
      expect(await messagesOf('a')).toHaveLength(1);
      expect(await messagesOf('b')).toHaveLength(1);
    });

    test('a bell that failed after the messages were stored is finished by the next poll, and a replay does not ring twice', async () => {
      const compose = require('../services/admin-alert-compose');
      const conv = conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'Please call me', at: ago(2) }] });
      const spy = jest.spyOn(compose, 'raiseAdminAlert').mockRejectedValueOnce(new Error('bell write failed'));
      try {
        await expect(messenger.pollMessenger()).rejects.toThrow(/left 1 conversation/);
        expect(await messagesOf('a')).toHaveLength(1);
        expect(await bellsOf('a')).toHaveLength(0);
        expect(await cursor()).toBeUndefined();

        // Run 2 stores nothing new and still rings.
        expect(await messenger.pollMessenger()).toMatchObject({ inserted: 0 });
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
      const bells = await bellsOf('a');
      expect(bells).toHaveLength(1);
      expect(bells[0].done_at).toBeNull();
      await db('notifications').where({ id: bells[0].id }).update({ read_at: new Date() });
      // The same message again is the same version: no ring.
      await resetCursor();
      await messenger.pollMessenger();
      expect((await bellsOf('a'))[0].read_at).not.toBeNull();

      // A reply stored whose close failed is closed by the next poll.
      conv.messages.push({ id: mid('a', 1), fromPage: true, text: 'Calling now', at: ago(1) });
      conv.updated = ago(1);
      const close = jest.spyOn(require('../services/notification-service'), 'markAdminDone').mockRejectedValueOnce(new Error('close failed'));
      try {
        await expect(messenger.pollMessenger()).rejects.toThrow(/left 1 conversation/);
        expect((await bellsOf('a'))[0].done_at).toBeNull();
        await messenger.pollMessenger();
      } finally {
        close.mockRestore();
      }
      expect((await bellsOf('a'))[0]).toMatchObject({ done_by: 'messenger-inbox', resolution: 'Answered in Messenger' });
      // Closing again is a no-op.
      await resetCursor();
      await messenger.pollMessenger();
      expect(await bellsOf('a')).toHaveLength(1);
    });

    test('an unreadable conversation list fails the poll and does not finish the first import', async () => {
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'Please call me', at: ago(2) }] });
      fb.unreadableOnce = true;
      await expect(messenger.pollMessenger()).rejects.toThrow();
      expect(await messagesOf('a')).toHaveLength(0);
      expect(await db('system_settings').where({ key: 'messenger_inbox_bootstrap_done' }).first()).toBeUndefined();
      await messenger.pollMessenger();
      expect(await messagesOf('a')).toHaveLength(1);
    });

    test('a bell write that answers null fails the import, and the next poll rings it', async () => {
      const compose = require('../services/admin-alert-compose');
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'Please call me', at: ago(2) }] });
      const spy = jest.spyOn(compose, 'raiseAdminAlert').mockResolvedValueOnce(null);
      try {
        await expect(messenger.pollMessenger()).rejects.toThrow(/left 1 conversation/);
        expect(await bellsOf('a')).toHaveLength(0);
        expect(await messenger.pollMessenger()).toMatchObject({ inserted: 0 });
      } finally {
        spy.mockRestore();
      }
      expect(await bellsOf('a')).toHaveLength(1);
    });

    test('a conversation list that hits its page cap leaves the cursor alone and fails the job; so does a message cap', async () => {
      installFacebook(1);
      for (const [key, hours] of [['a', 10], ['b', 20], ['c', 30]]) {
        conversation(key, { name: `Pat Synthetic ${key}`, unread: 1, messages: [{ fromPage: false, text: `hello ${key}`, at: ago(hours) }] });
      }
      await expect(messenger.pollMessenger({ limits: { conversationPages: 2 } })).rejects.toThrow(/page cap/);
      expect(await cursor()).toBeUndefined();
      expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('stopped at 2 page(s)'));
      // A poll with room finishes the job and stores each message once.
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 3 });
      expect(await cursor()).toBeDefined();
      expect(await db('messages').whereIn('conversation_id', db('conversations').where({ our_endpoint_id: `messenger:${PAGE}` }).select('id'))).toHaveLength(3);

      // A conversation with more message pages than the cap counts as failed.
      await wipe();
      installFacebook(25);
      fb.messagePageSize = 1;
      conversation('m', { name: 'Kim Sample', unread: 1, messages: [0, 1, 2].map((n) => ({ fromPage: false, text: `msg ${n}`, at: ago(5 - n) })) });
      await expect(messenger.pollMessenger({ limits: { messagePages: 2 } })).rejects.toThrow(/left 1 conversation/);
      expect(await cursor()).toBeUndefined();
      expect(await threadOf('m')).toBeUndefined();
      expect(await messenger.pollMessenger()).toMatchObject({ inserted: 3 });
    });

    test('no paging link is ever stored', async () => {
      installFacebook(1);
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'hello', at: ago(2) }] });
      conversation('b', { name: 'Kim Sample', unread: 1, messages: [{ fromPage: false, text: 'hello', at: ago(3) }] });
      await messenger.pollMessenger();
      const stored = JSON.stringify([
        await db('system_settings').where({ key: 'messenger_inbox_cursor' }),
        await db('messages').whereIn('conversation_id', db('conversations').where({ our_endpoint_id: `messenger:${PAGE}` }).select('id')),
      ]);
      expect(stored).not.toContain('access_token');
      expect(stored).not.toContain('graph.facebook.com');
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
      expect(await messenger.pollMessenger()).toMatchObject({ conversations: 2, inserted: 1 });
      expect(await threadOf('b')).toBeTruthy();
    });

    test('a partial first import is not finished: the retry reads the failed thread back the full window under the first-run policy, then incremental polls resume', async () => {
      const days = (n) => ago(n * 24);
      conversation('a', { name: 'Pat Synthetic', unread: 0, messages: [{ fromPage: false, text: 'recent and read', at: days(2) }] });
      const old = conversation('old', {
        name: 'Kim Sample', unread: 0,
        messages: [{ fromPage: false, text: 'five months ago', at: days(150) }, { fromPage: true, text: 'we replied then', at: days(149) }, { fromPage: false, text: 'last week', at: days(7) }],
      });
      fb.failMessagesFor = old.id;
      await expect(messenger.pollMessenger()).rejects.toThrow(/left 1 conversation/);
      expect(await db('system_settings').where({ key: 'messenger_inbox_bootstrap_done' }).first()).toBeUndefined();
      expect(await threadOf('old')).toBeUndefined();

      // Run 2: the cursor from run 1 is progress only; the failed thread comes in whole, read, with no bell.
      fb.failMessagesFor = null;
      expect(await messenger.pollMessenger()).toMatchObject({ firstRun: true });
      const rows = await messagesOf('old');
      expect(rows.map((m) => m.body)).toEqual(['five months ago', 'we replied then', 'last week']);
      expect(rows.filter((m) => m.direction === 'inbound').every((m) => m.is_read)).toBe(true);
      expect(await bellsOf('old')).toHaveLength(0);
      expect(await db('system_settings').where({ key: 'messenger_inbox_bootstrap_done' }).first()).toBeTruthy();

      // Run 3 is a normal incremental poll: it starts at the cursor and a new message is unread and rings.
      old.messages.push({ id: mid('old', 9), fromPage: false, text: 'new today', at: ago(1) });
      old.updated = ago(1);
      expect(await messenger.pollMessenger()).toMatchObject({ firstRun: false, inserted: 1 });
      expect((await bellsOf('old'))).toHaveLength(1);
    });

    test('the first-run policy still rings a Facebook-unread thread on the retry', async () => {
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'call me', at: ago(40) }] });
      const bad = conversation('bad', { name: 'Kim Sample', unread: 2, messages: [{ fromPage: false, text: 'waiting since august', at: ago(24 * 100) }] });
      fb.failMessagesFor = bad.id;
      await expect(messenger.pollMessenger()).rejects.toThrow();
      fb.failMessagesFor = null;
      await messenger.pollMessenger();
      expect((await messagesOf('bad'))[0].is_read).toBe(false);
      expect(await bellsOf('bad')).toHaveLength(1);
    });

    test('the page under an alias id: the id the page token reports is also the page, and direction follows the customer id', async () => {
      fb.meId = `true-${RUN}`;
      fb.pageAs = { id: fb.meId, name: 'Renamed Page Label' };
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'question', at: ago(5) }, { fromPage: true, text: 'answer', at: ago(4) }, { fromPage: false, text: 'follow up', at: ago(3) }] });
      await messenger.pollMessenger();
      expect(await threadOf('a')).toMatchObject({ contact_external_id: `messenger:${psid('a')}`, our_endpoint_id: `messenger:${PAGE}` });
      expect((await messagesOf('a')).map((m) => [m.direction, m.body])).toEqual([['inbound', 'question'], ['outbound', 'answer'], ['inbound', 'follow up']]);
    });

    test('the page under an unknown id is recognised by its name; the one remaining participant is the customer', async () => {
      fb.meId = `true-${RUN}`;
      fb.pageAs = { id: `unknown-${RUN}`, name: 'Waves Pest Control' };
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'question', at: ago(5) }, { fromPage: true, text: 'answer', at: ago(4) }] });
      await messenger.pollMessenger();
      expect((await messagesOf('a')).map((m) => m.direction)).toEqual(['inbound', 'outbound']);
      expect((await threadOf('a')).contact_label).toBe('Pat Synthetic');
    });

    test('a conversation with two unknown participants is skipped, nothing is stored, and the cursor holds', async () => {
      fb.meId = `true-${RUN}`;
      fb.pageAs = { id: `unknown-${RUN}`, name: 'Some Other Label' };
      conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'question', at: ago(5) }] });
      await expect(messenger.pollMessenger()).rejects.toThrow(/left 1 conversation/);
      expect(await threadOf('a')).toBeUndefined();
      expect(await db('messages').whereIn('conversation_id', db('conversations').where({ our_endpoint_id: `messenger:${PAGE}` }).select('id'))).toHaveLength(0);
      expect(await cursor()).toBeUndefined();
      expect(await db('system_settings').where({ key: 'messenger_inbox_bootstrap_done' }).first()).toBeUndefined();
    });

    test('a failed page identity read does not stop the poll: the configured id still works', async () => {
      const fetchSpy = global.fetch;
      global.fetch = jest.fn(async (rawUrl, init) => (new URL(rawUrl).pathname.endsWith('/me')
        ? { ok: false, status: 500, json: async () => ({ error: { code: 1 } }) }
        : fetchSpy(rawUrl, init)));
      try {
        conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'question', at: ago(5) }] });
        expect(await messenger.pollMessenger()).toMatchObject({ inserted: 1 });
      } finally {
        global.fetch = fetchSpy;
      }
    });

    test('closing the bell is fenced to the customer message the decision saw: a bell refreshed to a newer one stays open', async () => {
      const conv = conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'message A', at: ago(4) }] });
      await messenger.pollMessenger();
      const thread = await threadOf('a');
      const seenA = (await messagesOf('a'))[0];

      // Customer message B arrives and rings the bell (version B) after the decision was made from A.
      conv.messages.push({ id: mid('a', 1), fromPage: false, text: 'message B', at: ago(2) });
      conv.updated = ago(2);
      await messenger.pollMessenger();
      expect((await bellsOf('a'))[0].metadata.dedupeVersion).toBe(messenger.messageKey(mid('a', 1)));

      expect(await messenger._private.closeBell(thread.id, { through: seenA })).toBe(0);
      expect((await bellsOf('a'))[0].done_at).toBeNull();

      // Decided from B (or later), the same close goes through.
      const seenB = (await messagesOf('a'))[1];
      expect(await messenger._private.closeBell(thread.id, { through: seenB })).toBe(1);
      expect((await bellsOf('a'))[0]).toMatchObject({ done_by: 'messenger-inbox' });
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

      const { threads, unanswered, hasMore } = await (await get('/threads')).json();
      expect(hasMore).toBe(false);
      expect(unanswered).toBe(summary.unanswered);
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

    test('a long thread shows its newest messages, oldest first, and says older ones exist', async () => {
      conversation('long', { name: 'Pat Synthetic', unread: 0, messages: [0, 1, 2, 3, 4].map((n) => ({ fromPage: n % 2 === 1, text: `msg ${n}`, at: ago(10 - n) })) });
      await messenger.pollMessenger();
      const { id } = await threadOf('long');
      const req = { techRole: 'admin', technicianId: null };
      const capped = await messenger.getThread(req, id, new Date(), { limit: 3 });
      expect(capped.hasOlder).toBe(true);
      expect(capped.messages.map((m) => m.body)).toEqual(['msg 2', 'msg 3', 'msg 4']);
      const exact = await messenger.getThread(req, id, new Date(), { limit: 5 });
      expect(exact.hasOlder).toBe(false);
      expect(exact.messages.map((m) => m.body)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
      expect((await (await get(`/threads/${id}`)).json()).hasOlder).toBe(false);
    });

    test('the list is paged by keyset; the unanswered total stays the server total when the list is capped', async () => {
      for (const [key, hours, fromPage] of [['p1', 1, false], ['p2', 2, false], ['p3', 3, true], ['p4', 4, false]]) {
        conversation(key, { name: `Pat Synthetic ${key}`, unread: 0, messages: [{ fromPage, text: `hello ${key}`, at: ago(hours) }] });
      }
      await messenger.pollMessenger();
      const req = { techRole: 'admin', technicianId: null };
      const first = await messenger.listThreads(req, new Date(), { limit: 2 });
      expect(first.threads.map((t) => t.name)).toEqual(['Pat Synthetic p1', 'Pat Synthetic p2']);
      expect(first.hasMore).toBe(true);
      // Three threads wait for an answer; the capped page shows two of them but the total is three.
      expect(first.unanswered).toBeGreaterThanOrEqual(3);
      const last = first.threads[1];
      const next = await messenger.listThreads(req, new Date(), { limit: 2, before: last.lastMessageAt, beforeId: last.id });
      expect(next.threads.map((t) => t.name)).toEqual(['Pat Synthetic p3', 'Pat Synthetic p4']);
      expect(next.hasMore).toBe(false);
      expect(next.unanswered).toBe(first.unanswered);

      // Over HTTP: the keyset parameters reach the same page.
      const page = await (await get(`/threads?before=${encodeURIComponent(last.lastMessageAt)}&beforeId=${last.id}`)).json();
      expect(page.threads.slice(0, 2).map((t) => t.name)).toEqual(['Pat Synthetic p3', 'Pat Synthetic p4']);
      expect(page.unanswered).toBe(first.unanswered);
    });

    test('two threads with the same last-message time are split by id across pages without a repeat or a gap', async () => {
      const when = ago(2);
      for (const key of ['t1', 't2', 't3']) conversation(key, { name: `Lee Example ${key}`, unread: 0, messages: [{ fromPage: false, text: key, at: when }] });
      await messenger.pollMessenger();
      const req = { techRole: 'admin', technicianId: null };
      const seen = [];
      let cursorArgs = {};
      for (let i = 0; i < 5; i += 1) {
        const page = await messenger.listThreads(req, new Date(), { limit: 1, ...cursorArgs });
        seen.push(...page.threads.map((t) => t.name));
        if (!page.hasMore) break;
        const tail = page.threads[0];
        cursorArgs = { before: tail.lastMessageAt, beforeId: tail.id };
      }
      expect([...seen].sort()).toEqual(['Lee Example t1', 'Lee Example t2', 'Lee Example t3']);
      expect(new Set(seen).size).toBe(3);
    });

    test('opening a thread marks its customer messages read, up to the newest one on screen', async () => {
      await seed();
      const { threads } = await (await get('/threads')).json();
      const open = threads.find((t) => t.name === 'Pat Synthetic');
      const detail = await (await get(`/threads/${open.id}`)).json();
      const readBefore = detail.messages[detail.messages.length - 1].createdAt;
      expect((await post(`/threads/${open.id}/read`, {})).status).toBe(400);
      expect((await post(`/threads/${open.id}/read`, { readBefore: 'later' })).status).toBe(400);
      expect(await (await post(`/threads/${open.id}/read`, { readBefore })).json()).toEqual({ updated: 1 });
      const after = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Pat Synthetic');
      expect(after.unread).toBe(0);
      expect(await (await post(`/threads/${open.id}/read`, { readBefore })).json()).toEqual({ updated: 0 });
    });

    test('a customer message stored after the snapshot stays unread and still rings', async () => {
      const conv = conversation('a', { name: 'Pat Synthetic', unread: 1, messages: [{ fromPage: false, text: 'first', at: ago(3) }] });
      await messenger.pollMessenger();
      const thread = await threadOf('a');
      const detail = await (await get(`/threads/${thread.id}`)).json();
      const readBefore = detail.messages[detail.messages.length - 1].createdAt;

      // The poll stores a newer customer message after the person's view was served, before the read lands.
      const { appendMessage } = require('../services/conversations');
      const later = ago(1);
      await appendMessage({
        conversationId: thread.id, channel: 'facebook_messenger', direction: 'inbound', authorType: 'customer', body: 'second, after the snapshot',
        twilioSid: messenger.messageKey(mid('a', 1)), createdAt: later, isRead: false, metadata: { graph_mid: mid('a', 1), source: 'facebook' },
      });
      expect(await (await post(`/threads/${thread.id}/read`, { readBefore })).json()).toEqual({ updated: 1 });
      expect((await messagesOf('a')).map((m) => [m.body, m.is_read])).toEqual([['first', true], ['second, after the snapshot', false]]);

      // The next poll finds the unread message and rings for it.
      conv.messages.push({ id: mid('a', 1), fromPage: false, text: 'second, after the snapshot', at: later });
      conv.updated = later;
      await messenger.pollMessenger();
      const [bell] = await bellsOf('a');
      expect(bell.done_at).toBeNull();
      expect(bell.metadata.dedupeVersion).toBe(messenger.messageKey(mid('a', 1)));
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

    test('a reply does not close a bell raised for a customer message newer than the reply', async () => {
      await seed();
      const open = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Pat Synthetic');
      const [first] = await messagesOf('open');
      // A customer message stored for a moment after the reply goes out.
      await db('messages').insert({
        conversation_id: open.id, channel: 'facebook_messenger', direction: 'inbound', author_type: 'customer',
        body: 'Also the side gate', twilio_sid: messenger.messageKey(`m_later_${RUN}`), is_read: false,
        media: '[]', metadata: JSON.stringify({ graph_mid: `m_later_${RUN}` }),
        created_at: new Date(Date.now() + 60 * 1000), updated_at: new Date(),
      });
      expect(first).toBeTruthy();
      const res = await post(`/threads/${open.id}/reply`, { text: 'We can call you at 3.' });
      expect(res.status).toBe(200);
      const [bell] = await bellsOf('open');
      expect(bell.done_at).toBeNull();
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

    test('a send Facebook never confirmed is 504 send_uncertain and writes nothing; the bell stays open', async () => {
      await seed();
      const open = (await (await get('/threads')).json()).threads.find((t) => t.name === 'Pat Synthetic');
      const before = (await messagesOf('open')).length;
      fb.sendThrows = true;
      const dropped = await post(`/threads/${open.id}/reply`, { text: 'We can call you at 3.' });
      expect(dropped.status).toBe(504);
      expect(await dropped.json()).toEqual({ error: 'send_uncertain' });
      fb.sendThrows = false;
      fb.sendResult = {};
      const noId = await post(`/threads/${open.id}/reply`, { text: 'We can call you at 3.' });
      expect(noId.status).toBe(504);
      expect(await noId.json()).toEqual({ error: 'send_uncertain' });
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
