// "Send to Claude" for an idea (GATE_IB_SEND_TO_CLAUDE): the status route never 404s; the send and cancel routes answer 404
// with the gate off; cleanIdea, route, ids, date and pasted filtering; the dedupe answer; a suppressed row; and the cancel
// fence. The row itself against Postgres is admin-claude-ideas-db.test.js.
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(),
  getAdminNotificationForExplainer: jest.fn(),
  markAdminIdeaCancelled: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({ ibSendToClaudeLive: jest.fn(() => true) }));
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
const { ibSendToClaudeLive } = require('../config/feature-gates');
const { cleanIdea, ideaDedupeKey, firstLine } = require('../services/admin-claude-ideas');
const router = require('../routes/admin-claude-ideas');

const ID = '00000000-0000-4000-8000-0000000000a1';
const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-11-03T15:00:00.000Z';

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/claude-ideas', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/admin/claude-ideas`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const call = (base, path, { who = 'admin', method = 'POST', body } = {}) => fetch(`${base}${path}`, {
  method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

beforeEach(() => {
  jest.clearAllMocks();
  ibSendToClaudeLive.mockReturnValue(true);
  NotificationService.notifyAdmin.mockResolvedValue({ id: ID, deduped: false });
});

describe('cleanIdea', () => {
  test('removes control, format, bidi, zero-width and tag characters and keeps newlines', () => {
    const dirty = `  Add a ‮button‬​ to the\tinvoice\u0007 page second line\n\n\n\nthird\u{E0041}  `;
    expect(cleanIdea(dirty)).toEqual({ idea: 'Add a button to the invoice page\nsecond line\n\nthird' });
  });
  test('4,000 characters pass, 4,001 do not (code points, not UTF-16 units)', () => {
    expect(cleanIdea('a'.repeat(4000)).idea).toHaveLength(4000);
    expect(cleanIdea('a'.repeat(4001))).toEqual({ error: 'idea_too_long' });
    expect(cleanIdea('\u{1F600}'.repeat(4000))).toHaveProperty('idea');
    expect(cleanIdea('\u{1F600}'.repeat(4001))).toEqual({ error: 'idea_too_long' });
  });
  test('required: empty, missing, only hidden characters, and non-strings', () => {
    for (const raw of [undefined, null, '', '   \n ', '​‍']) expect(cleanIdea(raw)).toEqual({ error: 'idea_required' });
    for (const raw of [5, {}, ['x'], true]) expect(cleanIdea(raw)).toEqual({ error: 'invalid_idea' });
  });
});

describe('dedupe key and body', () => {
  test('case and spacing do not make a new idea', () => {
    expect(ideaDedupeKey('Add  a button')).toBe(ideaDedupeKey('add a\nbutton '));
    expect(ideaDedupeKey('Add a button')).toMatch(/^owner-idea:[0-9a-f]{16}$/);
    expect(ideaDedupeKey('Add a button')).not.toBe(ideaDedupeKey('Add a link'));
  });
  test('the body is the first line cut to 100 characters', () => {
    expect(firstLine('short\nsecond')).toBe('short');
    expect(firstLine('x'.repeat(150))).toHaveLength(100);
    expect(firstLine('\u{20000}'.repeat(80)).length).toBeLessThanOrEqual(100);
  });
});

describe('gate off', () => {
  test('status answers enabled:false, send and cancel answer 404', async () => {
    ibSendToClaudeLive.mockReturnValue(false);
    await withServer(async (base) => {
      expect(await call(base, '/status', { method: 'GET' })).toEqual({ status: 200, body: { enabled: false } });
      expect((await call(base, '/', { body: { text: 'An idea' } })).status).toBe(404);
      expect((await call(base, `/${ID}/cancel`, { body: { at: AT } })).status).toBe(404);
    });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
  test('a missing reader reads as off', async () => {
    ibSendToClaudeLive.mockReturnValue(undefined);
    await withServer(async (base) => {
      expect((await call(base, '/status', { method: 'GET' })).body).toEqual({ enabled: false });
    });
  });
});

describe('routes', () => {
  test('status answers enabled:true for an admin; a technician is refused; no login is refused', async () => {
    await withServer(async (base) => {
      expect(await call(base, '/status', { method: 'GET' })).toEqual({ status: 200, body: { enabled: true } });
      expect((await call(base, '/status', { method: 'GET', who: 'tech' })).status).toBe(403);
      expect((await call(base, '/', { who: 'tech', body: { text: 'x' } })).status).toBe(403);
      expect((await call(base, '/status', { method: 'GET', who: 'nobody' })).status).toBe(401);
    });
  });

  test('owner only: another admin sees no button, and its send and cancel are refused 403 (Codex security review)', async () => {
    await withServer(async (base) => {
      expect(await call(base, '/status', { method: 'GET', who: 'office' })).toEqual({ status: 200, body: { enabled: false } });
      expect(await call(base, '/', { who: 'office', body: { text: 'An idea' } }))
        .toEqual({ status: 403, body: { error: 'This action is limited to the owner account.' } });
      expect((await call(base, '/00000000-0000-4000-8000-0000000000a1/cancel', { who: 'office', body: { at: '2026-11-03T15:00:00.000Z' } })).status).toBe(403);
    });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a send writes one system row for Claude\'s queue with the exact shape', async () => {
    await withServer(async (base) => {
      const out = await call(base, '/', {
        body: {
          text: '  Show the last tech note on the dispatch card.\nIt hides today.  ',
          page: { route: '/admin/dispatch' },
          ids: { customer_id: CUSTOMER.toUpperCase(), viewed_date: '2026-11-03' },
          pasted: true,
        },
      });
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ sent: true, id: ID, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), message: 'Sent to Claude. A Claude tab opens on the Mac within about 10 minutes.' });
    });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect([category, title, body]).toEqual(['system', 'Idea for Claude', 'Show the last tech note on the dispatch card.']);
    expect(opts.detail).toBe('Show the last tech note on the dispatch card.\nIt hides today.');
    expect(opts.link).toBe('/admin/dispatch');
    expect(opts.dedupeOpenOnly).toBe(true);
    expect(opts.dedupeKey).toMatch(/^owner-idea:[0-9a-f]{16}$/);
    expect(opts.metadata).toEqual({
      feed: 'activity',
      who: 'claude',
      severity: 'needs-you',
      claudeQueue: 'sent-to-claude',
      dedupeKey: opts.dedupeKey,
      sentToClaude: {
        at: expect.any(String),
        by: '11111111-1111-4111-8111-111111111111',
        kind: 'owner-idea',
        records: { customerId: CUSTOMER },
        page: { route: '/admin/dispatch' },
        viewedDate: '2026-11-03',
        pasted: true,
        was: { who: null, severity: null },
      },
    });
  });

  test('route, ids, viewed_date and pasted are filtered', async () => {
    const sendWith = async (body) => {
      NotificationService.notifyAdmin.mockClear();
      await withServer((base) => call(base, '/', { body: { text: 'An idea', ...body } }));
      return NotificationService.notifyAdmin.mock.calls[0][3];
    };
    for (const route of ['/admin/../etc', '/customers', 'https://evil.example/admin', '/admin/a b', '/admin/a/b/c/d/e/f/g', '/admin?x=1', 5, null]) {
      const opts = await sendWith({ page: { route } });
      expect(opts.metadata.sentToClaude.page).toEqual({ route: null });
      expect(opts.link).toBe('/admin');
    }
    expect((await sendWith({ page: { route: '/admin' } })).link).toBe('/admin');
    expect((await sendWith({ page: { route: '/admin/customers/detail_1' } })).metadata.sentToClaude.page.route).toBe('/admin/customers/detail_1');
    const filtered = await sendWith({
      ids: { customer_id: 'not-a-uuid', property_id: CUSTOMER, estimate_id: 5, appointment_id: null, product_id: `${CUSTOMER}; drop`, viewed_date: '11/03/2026', extra_id: CUSTOMER },
      pasted: 'yes',
    });
    expect(filtered.metadata.sentToClaude.records).toEqual({ propertyId: CUSTOMER });
    expect(filtered.metadata.sentToClaude).not.toHaveProperty('viewedDate');
    expect(filtered.metadata.sentToClaude.pasted).toBe(false);
    const all = await sendWith({ ids: { customer_id: CUSTOMER, property_id: CUSTOMER, estimate_id: CUSTOMER, appointment_id: CUSTOMER, product_id: CUSTOMER } });
    expect(Object.keys(all.metadata.sentToClaude.records)).toEqual(['customerId', 'propertyId', 'estimateId', 'appointmentId', 'productId']);
  });

  test('a bad idea is refused with its reason and writes nothing', async () => {
    await withServer(async (base) => {
      expect((await call(base, '/', { body: {} })).body).toEqual({ error: 'idea_required' });
      expect((await call(base, '/', { body: { text: 7 } })).body).toEqual({ error: 'invalid_idea' });
      const long = await call(base, '/', { body: { text: 'a'.repeat(4001) } });
      expect([long.status, long.body]).toEqual([400, { error: 'idea_too_long' }]);
    });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('an idea still open answers duplicate with the standing id', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: ID, deduped: true });
    await withServer(async (base) => {
      expect(await call(base, '/', { body: { text: 'An idea' } })).toEqual({ status: 200, body: { duplicate: true, id: ID } });
    });
  });

  test('a suppressed row answers 422 not_sent; a failed write answers 500', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true, deduped: false });
    await withServer(async (base) => {
      expect(await call(base, '/', { body: { text: 'An idea' } })).toEqual({ status: 422, body: { error: 'not_sent' } });
      NotificationService.notifyAdmin.mockResolvedValue(null);
      expect((await call(base, '/', { body: { text: 'An idea' } })).status).toBe(500);
    });
  });
});

describe('cancel', () => {
  const stamped = (over = {}) => ({
    id: ID,
    done_at: null,
    metadata: { claudeQueue: 'sent-to-claude', sentToClaude: { at: AT, kind: 'owner-idea' }, ...over },
  });
  const cancel = (body = { at: AT }, id = ID) => withServer((base) => call(base, `/${id}/cancel`, { body }));

  test('rejects a bad id and a bad at', async () => {
    expect((await cancel({ at: AT }, 'not-a-uuid')).status).toBe(400);
    for (const at of [undefined, 5, 'yesterday', '2026-11-03']) expect((await cancel({ at })).status).toBe(400);
    expect(NotificationService.getAdminNotificationForExplainer).not.toHaveBeenCalled();
  });

  test('an open untouched idea is cancelled as done by the admin', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(stamped());
    NotificationService.markAdminIdeaCancelled.mockResolvedValue(1);
    expect(await cancel()).toEqual({ status: 200, body: { cancelled: true } });
    expect(NotificationService.markAdminIdeaCancelled).toHaveBeenCalledWith(ID, AT, '11111111-1111-4111-8111-111111111111', 'Cancelled by the owner.');
  });

  test('a missing row answers 404 not_found', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(null);
    expect(await cancel()).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  test.each([
    ['a Mac tab started', stamped({ sentToClaude: { at: AT, kind: 'owner-idea', startedAt: AT } }), 'started'],
    ['a different send', stamped({ sentToClaude: { at: '2026-11-03T16:00:00.000Z', kind: 'owner-idea' } }), 'changed'],
    ['a bell send, not an idea', stamped({ sentToClaude: { at: AT, kind: 'accepted-schedule' } }), 'changed'],
    ['not in Claude\'s queue', stamped({ claudeQueue: undefined }), 'changed'],
    ['already done', { ...stamped(), done_at: new Date() }, 'done'],
  ])('%s answers 409 and writes nothing', async (_name, row, error) => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row);
    expect(await cancel()).toEqual({ status: 409, body: { error } });
    expect(NotificationService.markAdminIdeaCancelled).not.toHaveBeenCalled();
  });

  test('a row that started between the read and the write answers with the state it is in now', async () => {
    NotificationService.getAdminNotificationForExplainer
      .mockResolvedValueOnce(stamped())
      .mockResolvedValueOnce(stamped({ sentToClaude: { at: AT, kind: 'owner-idea', startedAt: AT } }));
    NotificationService.markAdminIdeaCancelled.mockResolvedValue(0);
    expect(await cancel()).toEqual({ status: 409, body: { error: 'started' } });
  });
});
