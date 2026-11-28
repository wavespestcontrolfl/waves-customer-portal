/**
 * Targeted regression tests for Communications Audit PR 5 (C2-26 & C2-27):
 * - C2-26: portal-late-rering live open status checks on ai_escalations & service_requests,
 *          admin-alert-relevance loadQuoteHandoffs anchored on bellEventAt,
 *          notification-service mergeRefreshMetadata clearing lateReRungAt on ringing refresh.
 * - C2-27: messenger-inbox explicit pageId outbound classification (never misclassify missing from.id),
 *          same-second timestamp tie preservation on portal replies,
 *          server-side reply idempotency via requestId (in-flight + persisted).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describe('C2-26c: notification-service clears lateReRungAt on ringing refresh', () => {
  test('ringing refresh drops lateReRungAt while quiet refresh preserves it', () => {
    jest.resetModules();
    const { _private: { mergeRefreshMetadata } } = require('../services/notification-service');
    const existing = {
      dedupeKey: 'portal-chat-escalation:esc-1',
      customerId: 'cust-1',
      lateReRungAt: '2026-11-27T15:00:00.000Z',
      retired: { by: 'alert-relevance', reason: 'Answered', at: '2026-11-27T16:00:00.000Z' },
    };

    const rung = mergeRefreshMetadata(existing, { dedupeVersion: 'v2' }, true);
    expect(rung.lateReRungAt).toBeUndefined();
    expect(rung.retired).toBeUndefined();
    expect(rung.rungAt).toEqual(expect.any(String));
    expect(rung.dedupeVersion).toBe('v2');

    const quiet = mergeRefreshMetadata(existing, { dedupeVersion: 'v2' }, false);
    expect(quiet.lateReRungAt).toBe('2026-11-27T15:00:00.000Z');
  });
});

describe('C2-26a: portal-late-rering checks live open status on ai_escalations and service_requests', () => {
  const NOW = new Date('2026-11-02T20:00:00Z'); // 3 PM ET; 10 AM ET ask was due at 11 AM ET
  const ASK = new Date('2026-11-02T15:00:00Z');
  const ESC_OPEN = '11111111-1111-4111-8111-111111111111';
  const ESC_CLOSED = '22222222-2222-4222-8222-222222222222';
  const REQ_OPEN = '33333333-3333-4333-8333-333333333333';
  const REQ_CLOSED = '44444444-4444-4444-8444-444444444444';
  const CUST = '55555555-5555-4555-8555-555555555555';

  function setupReringMocks({ notificationRows, escalations = [], requests = [] }) {
    jest.resetModules();
    const updatedIds = [];
    const mockDb = jest.fn((table) => {
      const state = { table, verb: 'select', id: null };
      const chain = new Proxy({}, {
        get(_, prop) {
          if (prop === 'then') {
            return (res, rej) => {
              let result;
              if (state.verb === 'update') {
                updatedIds.push(state.id);
                result = 1;
              } else if (state.table === 'notifications') {
                result = notificationRows;
              } else if (state.table === 'ai_escalations') {
                result = escalations;
              } else if (state.table === 'service_requests') {
                result = requests;
              } else if (state.table === 'customers') {
                result = { first_name: 'Pat', last_name: 'Sample' };
              } else {
                result = [];
              }
              return Promise.resolve(result).then(res, rej);
            };
          }
          return (...args) => {
            if (prop === 'update' || prop === 'first') state.verb = prop;
            if (prop === 'where' && args[0] && typeof args[0] === 'object' && args[0].id) state.id = args[0].id;
            return chain;
          };
        },
      });
      return chain;
    });
    mockDb.raw = jest.fn((sql) => sql);
    mockDb.fn = { now: () => 'now()' };

    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/notification-service', () => ({
      _private: { excludeActivityOnlyFromBell: (q) => q, DONE_CLEARED: {} },
      normalizeAdminText: ({ title, body, detail }) => ({ title, body, detail }),
      safeErrorSummary: (e) => e.message,
    }));
    jest.doMock('../services/admin-alert-relevance', () => ({
      classify: (row) => {
        if (row.metadata.triggerKey === 'bundle_quote_requested') return { key: 'portal_add_service_request' };
        if (row.metadata.doneWhen === 'request_answered') return { key: 'portal_request_answered' };
        return { key: 'portal_chat_answered' };
      },
      bellEventAt: (row) => new Date(row.created_at),
      parseMeta: (m) => (typeof m === 'string' ? JSON.parse(m) : m || {}),
      quoteAnswered: jest.fn(async () => false),
    }));
    jest.doMock('../services/admin-alert-contact-witnesses', () => ({
      loadContactBundles: jest.fn(async (items) => new Map(items.map((i) => [String(i.id), { anchor: ASK, textAt: null, backAt: null, inAt: null, replyAt: null }]))),
    }));
    jest.doMock('../services/portal-ask-push', () => ({
      pushPortalAsk: jest.fn(async () => ({})),
      customerShortName: jest.fn(async () => 'Pat S.'),
    }));

    return { rering: require('../services/portal-late-rering'), updatedIds };
  }

  test('skips closed ai_escalations and closed service_requests in 1-hour late re-ring while ringing open ones', async () => {
    const notificationRows = [
      { id: 'n-esc-open', category: 'alert', title: 'Chat', body: 'Open chat', metadata: { customerId: CUST, escalationId: ESC_OPEN, dedupeKey: `portal-chat-escalation:${ESC_OPEN}` }, created_at: ASK, created_at_token: ASK.toISOString() },
      { id: 'n-esc-closed', category: 'alert', title: 'Chat', body: 'Closed chat', metadata: { customerId: CUST, escalationId: ESC_CLOSED, dedupeKey: `portal-chat-escalation:${ESC_CLOSED}` }, created_at: ASK, created_at_token: ASK.toISOString() },
      { id: 'n-req-open', category: 'service', title: 'Req', body: 'Open req', metadata: { customerId: CUST, requestId: REQ_OPEN, doneWhen: 'request_answered' }, created_at: ASK, created_at_token: ASK.toISOString() },
      { id: 'n-req-closed', category: 'service', title: 'Req', body: 'Closed req', metadata: { customerId: CUST, requestId: REQ_CLOSED, doneWhen: 'request_answered' }, created_at: ASK, created_at_token: ASK.toISOString() },
    ];
    const { rering, updatedIds } = setupReringMocks({
      notificationRows,
      escalations: [
        { id: ESC_OPEN, status: 'pending' },
        { id: ESC_CLOSED, status: 'resolved' },
      ],
      requests: [
        { id: REQ_OPEN, status: 'new' },
        { id: REQ_CLOSED, status: 'resolved' },
      ],
    });

    const out = await rering.runPortalLateRering({ now: NOW });
    expect(out).toEqual({ skipped: false, due: 4, rung: 2 });
    expect(updatedIds).toEqual(['n-esc-open', 'n-req-open']);
  });

  test('skips closed service_requests in 2-business-day owed-estimate re-ring', async () => {
    const THREE_DAYS_AGO = new Date('2026-10-30T15:00:00Z');
    const notificationRows = [
      { id: 'n-est-open', category: 'estimate', title: 'Add svc', body: 'Open add-svc', metadata: { customerId: CUST, requestId: REQ_OPEN, triggerKey: 'bundle_quote_requested' }, created_at: THREE_DAYS_AGO, created_at_token: THREE_DAYS_AGO.toISOString() },
      { id: 'n-est-closed', category: 'estimate', title: 'Add svc', body: 'Closed add-svc', metadata: { customerId: CUST, requestId: REQ_CLOSED, triggerKey: 'bundle_quote_requested' }, created_at: THREE_DAYS_AGO, created_at_token: THREE_DAYS_AGO.toISOString() },
    ];
    const { rering, updatedIds } = setupReringMocks({
      notificationRows,
      requests: [
        { id: REQ_OPEN, status: 'new' },
        { id: REQ_CLOSED, status: 'cancelled' },
      ],
    });

    const out = await rering.runPortalEstimateRering({ now: NOW });
    expect(out).toEqual({ skipped: false, due: 2, rung: 1 });
    expect(updatedIds).toEqual(['n-est-open']);
  });
});

describe('C2-26b: admin-alert-relevance loadQuoteHandoffs anchors on bellEventAt (rungAt)', () => {
  test('uses rungAt when bell was refreshed so an older estimate cannot close a freshly re-rung add-service chat', async () => {
    jest.resetModules();
    jest.dontMock('../services/admin-alert-relevance');
    const seenBoundaries = [];
    jest.doMock('../services/call-commitments', () => ({
      handedOffWithin: jest.fn((query, bellAt) => {
        seenBoundaries.push(bellAt);
        return query;
      }),
      whereEstimateCustomerOwnership: jest.fn((query) => query),
    }));
    const mockConn = jest.fn(() => ({
      first: jest.fn(async () => ({ id: 'est-1' })),
    }));
    jest.doMock('../models/db', () => mockConn);

    const { loadSubjects } = require('../services/admin-alert-relevance');
    const createdAt = new Date('2026-11-01T15:00:00.000Z');
    const rungAt = '2026-11-02T18:00:00.000Z';
    const row = {
      id: 'bell-1',
      category: 'alert',
      created_at: createdAt,
      metadata: {
        dedupeKey: 'portal-chat-escalation:11111111-1111-4111-8111-111111111111',
        topic: 'add_service',
        customerId: '55555555-5555-4555-8555-555555555555',
        askedAt: createdAt.toISOString(),
        rungAt,
      },
    };
    const data = await loadSubjects([row], mockConn);
    expect(seenBoundaries).toHaveLength(1);
    expect(seenBoundaries[0].toISOString()).toBe(rungAt);
    expect(data.quoteHandedOff.has('bell-1')).toBe(true);
  });
});

describe('C2-27a: messenger-inbox outbound classification, same-second tie, and reply idempotency', () => {
  const PAGE_ID = '999001';
  const THREAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PSID = 'psid-customer-1';

  test('missing from.id is classified as inbound (customer), never staff outbound; same-second portal reply is not truncated backwards', async () => {
    jest.resetModules();
    const appended = [];
    const updatedTimestamps = [];
    const storedReply = {
      id: 'msg-portal-reply',
      twilio_sid: null, // filled below after messageKey is loaded
      created_at: new Date('2026-11-27T15:00:00.450Z'),
    };
    const mockTrx = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      max: jest.fn().mockReturnThis(),
      first: jest.fn(async () => null),
    }));
    mockTrx.raw = jest.fn(async () => ({}));

    const mockDb = jest.fn((table) => {
      const chain = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        orderByRaw: jest.fn().mockReturnThis(),
        select: jest.fn(async () => (table === 'messages' ? [storedReply] : [])),
        first: jest.fn(async () => {
          if (table === 'system_settings') return { value: '2026-11-27T14:00:00.000Z' };
          if (table === 'conversations') return { id: THREAD_ID, contact_label: 'Pat', contact_external_id: `messenger:${PSID}` };
          return null;
        }),
        insert: jest.fn().mockReturnThis(),
        onConflict: jest.fn().mockReturnThis(),
        merge: jest.fn(async () => ({})),
        update: jest.fn(async (patch) => {
          if (table === 'messages' && patch.created_at) updatedTimestamps.push(patch.created_at);
          return 1;
        }),
      };
      return chain;
    });
    mockDb.fn = { now: () => new Date() };
    mockDb.transaction = jest.fn(async (fn) => fn(mockTrx));

    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/conversations', () => ({
      findOrCreateThread: jest.fn(async () => ({ id: THREAD_ID, contact_label: 'Pat' })),
      appendMessage: jest.fn(async (msg) => { appended.push(msg); return { id: 'm-new', ...msg }; }),
    }));

    process.env.FACEBOOK_ACCESS_TOKEN = 'test-token';
    process.env.FACEBOOK_PAGE_ID = PAGE_ID;
    const messenger = require('../services/messenger-inbox');
    messenger._private.resetPageIdentity();
    storedReply.twilio_sid = messenger.messageKey('mid-portal-reply');

    global.fetch = jest.fn(async (rawUrl) => {
      const url = new URL(rawUrl);
      const okJson = (data) => ({ ok: true, status: 200, json: async () => data });
      if (url.pathname.endsWith('/me')) return okJson({ id: PAGE_ID, name: 'Waves Pest Control' });
      if (url.pathname.endsWith('/conversations')) {
        return okJson({
          data: [{
            id: 'conv-1',
            updated_time: '2026-11-27T15:05:00.000Z',
            unread_count: 1,
            participants: { data: [{ id: PAGE_ID, name: 'Waves Pest Control' }, { id: PSID, name: 'Pat' }] },
          }],
        });
      }
      if (url.pathname.endsWith('/messages')) {
        return okJson({
          data: [
            // Missing from.id: must NOT be misclassified as outbound!
            { id: 'mid-no-from', message: 'Are you open?', created_time: '2026-11-27T15:05:00.000Z', from: {} },
            // Portal reply returned by Facebook with 1-second truncated created_time in the same second as 15:00:00.450Z
            { id: 'mid-portal-reply', message: 'Yes!', created_time: '2026-11-27T15:00:00.000Z', from: { id: PAGE_ID, name: 'Waves Pest Control' } },
          ],
        });
      }
      return okJson({});
    });

    await messenger.pollMessenger({ now: new Date('2026-11-27T15:06:00.000Z') });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      direction: 'inbound',
      authorType: 'customer',
      body: 'Are you open?',
    });
    // Same-second portal reply must NOT be moved backwards from .450Z to .000Z
    expect(updatedTimestamps).toHaveLength(0);
  });

  test('sendReply authorizes caller first, durably claims requestId, deduplicates retries, and rejects text mismatch with 409', async () => {
    jest.resetModules();
    const persisted = [];
    const settings = new Map();
    const makeTableBuilder = (table) => {
      const state = { table, reqId: null, settingKey: null };
      const chain = {
        where: jest.fn((cond) => {
          if (table === 'system_settings' && cond && typeof cond === 'object' && cond.key) state.settingKey = cond.key;
          return chain;
        }),
        whereIn: jest.fn(() => {
          // Technician scope check: return empty for unauthorized tech
          state.techScoped = true;
          return chain;
        }),
        whereRaw: jest.fn((sql, params) => {
          if (sql.includes('clientRequestId')) state.reqId = params[0];
          return chain;
        }),
        joinRaw: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        max: jest.fn().mockReturnThis(),
        insert: jest.fn((row) => {
          if (table === 'system_settings') settings.set(row.key, row.value);
          return chain;
        }),
        onConflict: jest.fn().mockReturnThis(),
        merge: jest.fn(async () => ({})),
        del: jest.fn(async () => {
          if (table === 'system_settings' && state.settingKey) settings.delete(state.settingKey);
          return 1;
        }),
        update: jest.fn(async () => 1),
        first: jest.fn(async () => {
          if (table === 'conversations as c') {
            if (state.techScoped) return null;
            return {
              id: THREAD_ID,
              contact_label: 'Pat',
              contact_external_id: `messenger:${PSID}`,
              last_in: new Date('2026-11-27T14:55:00.000Z'),
              last_out: null,
              unread: 1,
              snippet: 'Hello',
            };
          }
          if (table === 'system_settings' && state.settingKey) {
            return settings.has(state.settingKey) ? { value: settings.get(state.settingKey) } : null;
          }
          if (table === 'messages' && state.reqId) {
            return persisted.find((m) => m.requestId === state.reqId) || null;
          }
          return null;
        }),
      };
      return chain;
    };
    const mockDb = jest.fn(makeTableBuilder);
    mockDb.raw = jest.fn((sql) => sql);
    mockDb.fn = { now: () => new Date() };
    mockDb.transaction = jest.fn(async (fn) => {
      const trx = jest.fn(makeTableBuilder);
      trx.raw = jest.fn(async () => ({}));
      trx.fn = { now: () => new Date() };
      return fn(trx);
    });

    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/technician-visit-scope', () => ({
      isTechnicianRequest: (r) => r?.techRole === 'technician',
      technicianCustomerIdsSubquery: jest.fn(() => []),
    }));
    jest.doMock('../services/conversations', () => ({
      findOrCreateThread: jest.fn(),
      appendMessage: jest.fn(async (msg) => {
        const saved = { id: 'saved-msg-1', body: msg.body, created_at: msg.createdAt, admin_user_id: msg.adminUserId, requestId: msg.metadata?.clientRequestId };
        persisted.push(saved);
        return saved;
      }),
    }));

    let resolveGraph;
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
    global.fetch = jest.fn(() => {
      markFetchStarted();
      return new Promise((resolve) => {
        resolveGraph = () => resolve({ ok: true, status: 200, json: async () => ({ message_id: 'fb-mid-1' }) });
      });
    });
    process.env.FACEBOOK_ACCESS_TOKEN = 'test-token';
    process.env.FACEBOOK_PAGE_ID = PAGE_ID;

    const messenger = require('../services/messenger-inbox');
    const now = new Date('2026-11-27T15:00:00.000Z');
    const adminReq = { technicianId: 'admin-1', techRole: 'admin' };
    const unauthTechReq = { technicianId: 'tech-2', techRole: 'technician' };

    // Start an authorized send
    const p1 = messenger.sendReply(adminReq, THREAD_ID, 'On our way', { now, requestId: 'req-dup-1' });
    await fetchStarted;

    // Unauthorized technician with same thread + requestId must get 404, NOT the in-flight promise
    const unauthRes = await messenger.sendReply(unauthTechReq, THREAD_ID, 'On our way', { now, requestId: 'req-dup-1' });
    expect(unauthRes).toEqual({ ok: false, status: 404, error: 'not_found' });

    // Authorized caller reusing same requestId with DIFFERENT text while in-flight gets 409
    const conflictInFlight = await messenger.sendReply(adminReq, THREAD_ID, 'Different text', { now, requestId: 'req-dup-1' });
    expect(conflictInFlight).toEqual({ ok: false, status: 409, error: 'request_id_conflict' });

    // Authorized retry with SAME text shares the in-flight send
    const p2 = messenger.sendReply(adminReq, THREAD_ID, 'On our way', { now, requestId: 'req-dup-1' });
    resolveGraph();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ ok: true, message: { id: 'saved-msg-1' } });
    expect(r2).toMatchObject({ ok: true, message: { id: 'saved-msg-1' } });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Later retry with same requestId + same text hits durable claim and does NOT call Facebook again
    const r3 = await messenger.sendReply(adminReq, THREAD_ID, 'On our way', { now, requestId: 'req-dup-1' });
    expect(r3).toMatchObject({ ok: true, message: { id: 'saved-msg-1' } });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Later retry with same requestId + different text returns 409 request_id_conflict
    const conflictStored = await messenger.sendReply(adminReq, THREAD_ID, 'Changed text', { now, requestId: 'req-dup-1' });
    expect(conflictStored).toEqual({ ok: false, status: 409, error: 'request_id_conflict' });
  });
});
