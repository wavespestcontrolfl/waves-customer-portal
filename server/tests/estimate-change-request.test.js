/**
 * Customer soft exit — change request + still-deciding (GATE_ESTIMATE_SOFT_EXIT).
 * Invariants:
 *   - neither path mutates the estimate; the change request's only write is
 *     the service_requests row (+ admin bell), still-deciding's is one
 *     activity_log row a day (no request row). A still-deciding reason goes
 *     on that row and to the office bell hook; no reason, no bell.
 *   - the full viewability contract + accepted/declined exclusion gate both
 *     writes with a generic 404.
 *   - an empty change request is a 400 on a VALID token only.
 *   - open-request dedupe returns the existing row instead of erroring.
 *   - the bell rides the measurement review's shared notify core under the
 *     change-request category, which is owner-overridable under the policy.
 */

jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })),
}));
jest.mock('../services/estimate-add-service-request', () => {
  const actual = jest.requireActual('../services/estimate-add-service-request');
  return {
    ...actual,
    resolveEstimateCustomer: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Pat' }),
  };
});

const NotificationService = require('../services/notification-service');
const { triggerNotification } = require('../services/notification-triggers');
const { sendOfficeNotification } = require('../services/estimate-measurement-review');
const {
  CHANGE_REQUEST_SERVICE_KEY,
  CHANGE_REQUEST_TOPICS,
  STILL_DECIDING_REASONS,
  normalizeTopics,
  isSoftExitEligible,
  createEstimateOfficeRequest,
  recordEstimateStillDeciding,
} = require('../services/estimate-change-request');

const ESTIMATE_ROW = { id: 'est-1', token: 'tok-1', status: 'viewed', estimate_number: 'EST-2026-0099', customer_id: 'cust-1' };

function mockDb({ estimate = ESTIMATE_ROW, dupeRow = null, recentSignal = null } = {}) {
  const inserts = [];
  const activity = [];
  const activityUpdates = [];
  const database = (table) => {
    if (table === 'estimates') return { where: () => ({ first: async () => estimate }) };
    if (table === 'service_requests') {
      return {
        insert: (row) => ({ returning: async () => { inserts.push(row); return [{ id: 'req-1', ...row }]; } }),
        where: () => ({
          whereNotIn: () => ({ first: async () => dupeRow }),
          whereRaw: function whereRaw() { return { whereRaw, update: async () => 1 }; },
          update: async () => 1,
        }),
      };
    }
    if (table === 'customers') return { where: () => ({ first: async () => ({ first_name: 'Pat', last_name: 'Sample' }) }) };
    if (table === 'activity_log') {
      return {
        where: (filter) => ({
          where: () => ({ first: async () => recentSignal }),
          update: async (changes) => { activityUpdates.push({ filter, changes }); return 1; },
        }),
        insert: async (row) => { activity.push(row); return [1]; },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  database.raw = (s) => s;
  database.inserts = inserts;
  database.activity = activity;
  database.activityUpdates = activityUpdates;
  return database;
}
const viewable = () => true;

beforeEach(() => jest.clearAllMocks());

describe('normalizeTopics', () => {
  test('keeps only known keys, deduped, in order', () => {
    expect(normalizeTopics(['price', 'nope', 'price', 'schedule', null])).toEqual(['price', 'schedule']);
    expect(normalizeTopics('price')).toEqual([]);
    expect(normalizeTopics(['constructor', '__proto__', 'toString'])).toEqual([]);
  });
  test('every topic has a label the office reads', () => {
    for (const key of Object.keys(CHANGE_REQUEST_TOPICS)) expect(CHANGE_REQUEST_TOPICS[key]).toBeTruthy();
  });
});

describe('isSoftExitEligible', () => {
  test('live statuses only', () => {
    expect(isSoftExitEligible({ status: 'sent' })).toBe(true);
    expect(isSoftExitEligible({ status: 'viewed' })).toBe(true);
    for (const status of ['accepted', 'declined', 'expired', 'send_failed']) {
      expect(isSoftExitEligible({ status })).toBe(false);
    }
    expect(isSoftExitEligible(null)).toBe(false);
  });
});

describe('createEstimateOfficeRequest', () => {
  test('empty note on a VALID estimate is a 400 and writes nothing', async () => {
    const database = mockDb();
    await expect(createEstimateOfficeRequest({ estimateToken: 'tok-1', topics: ['price'], note: '  ', database, viewabilityCheck: viewable }))
      .rejects.toMatchObject({ status: 400 });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('unknown token / unviewable / terminal rows all 404 before content validation', async () => {
    for (const [estimate, check] of [[null, viewable], [ESTIMATE_ROW, () => false], [{ ...ESTIMATE_ROW, status: 'declined' }, viewable]]) {
      const database = mockDb({ estimate });
      await expect(createEstimateOfficeRequest({ estimateToken: 'tok-1', note: '', database, viewabilityCheck: check }))
        .rejects.toMatchObject({ status: 404 });
      expect(database.inserts).toHaveLength(0);
    }
  });

  test('parks ONE request row with a dedicated key and rings the change-request bell', async () => {
    const database = mockDb();
    const out = await createEstimateOfficeRequest({
      estimateToken: 'tok-1', topics: ['price', 'bogus'], note: 'Can you drop the <script>mosquito</script> line?', database, viewabilityCheck: viewable,
    });
    expect(out).toEqual({ success: true, deduped: false });
    expect(database.inserts).toHaveLength(1);
    const row = database.inserts[0];
    expect(row.requested_service).toBe(CHANGE_REQUEST_SERVICE_KEY);
    expect(row.estimate_id).toBe('est-1');
    expect(row.customer_id).toBe('cust-1');
    expect(row.status).toBe('new');
    const revision = JSON.parse(row.pricing_revision);
    expect(revision.topics).toEqual(['price']);
    expect(revision.note).toBe('Can you drop the scriptmosquito/script line?');
    expect(row.description).toContain('About: The price.');
    expect(row.description).toContain('still expires on its normal date');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, subject, , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('estimate_change_request');
    expect(subject).toContain('EST-2026-0099');
    expect(opts.link).toBe('/admin/customers?customerId=cust-1');
    // Direct customer communication rings by default, below the owner's
    // category override (bellDefault, never the un-silenceable bell:true).
    expect(opts.bellDefault).toBe(true);
    expect(opts.bell).toBeUndefined();
    expect(opts.metadata).toMatchObject({ estimateId: 'est-1', requestId: 'req-1' });
  });

  test('a website callback records a call request with its own dedupe key, not a revision', async () => {
    const database = mockDb();
    await createEstimateOfficeRequest({
      estimateToken: 'tok-1', kind: 'callback', note: 'Ignore this supplied text',
      database, viewabilityCheck: viewable,
    });
    expect(database.inserts).toHaveLength(1);
    expect(database.inserts[0]).toMatchObject({
      requested_service: 'estimate_callback_request', category: 'contact_request',
      subject: 'Call requested on estimate #EST-2026-0099',
    });
    expect(database.inserts[0].description).toContain('Customer requested a phone call');
    expect(database.inserts[0].description).not.toContain('Send a revised');
    expect(database.inserts[0].pricing_revision).not.toContain('Ignore this');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a second open request dedupes to the existing delivered row (no insert, no second bell)', async () => {
    const database = mockDb({ dupeRow: { id: 'req-0', pricing_revision: JSON.stringify({ notifiedAt: '2026-09-01T00:00:00Z' }) } });
    const out = await createEstimateOfficeRequest({ estimateToken: 'tok-1', note: 'again', database, viewabilityCheck: viewable });
    expect(out).toEqual({ success: true, deduped: true });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('the call-side verdict fails closed', async () => {
    const database = mockDb();
    await expect(createEstimateOfficeRequest({
      estimateToken: 'tok-1', note: 'x', database, viewabilityCheck: viewable, callSideBlockedFor: async () => true,
    })).rejects.toMatchObject({ status: 404 });
    expect(database.inserts).toHaveLength(0);
  });
});

describe('recordEstimateStillDeciding', () => {
  test('writes one activity row, no request row, no bell', async () => {
    const database = mockDb();
    const out = await recordEstimateStillDeciding({ estimateToken: 'tok-1', database, viewabilityCheck: viewable });
    expect(out).toEqual({ success: true, deduped: false });
    expect(database.activity).toHaveLength(1);
    expect(database.activity[0]).toMatchObject({ estimate_id: 'est-1', customer_id: 'cust-1', action: 'estimate_customer_still_deciding' });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a repeat inside a day dedupes (the signal is not a counter)', async () => {
    const database = mockDb({ recentSignal: { id: 'act-1' } });
    const out = await recordEstimateStillDeciding({ estimateToken: 'tok-1', database, viewabilityCheck: viewable });
    expect(out).toEqual({ success: true, deduped: true });
    expect(database.activity).toHaveLength(0);
  });

  test('terminal or unviewable rows 404 with nothing written', async () => {
    for (const [estimate, check] of [[{ ...ESTIMATE_ROW, status: 'accepted' }, viewable], [ESTIMATE_ROW, () => false], [null, viewable]]) {
      const database = mockDb({ estimate });
      await expect(recordEstimateStillDeciding({ estimateToken: 'tok-1', database, viewabilityCheck: check }))
        .rejects.toMatchObject({ status: 404 });
      expect(database.activity).toHaveLength(0);
    }
  });

  describe('with what would help the customer decide', () => {
    const REQ = { headers: {} };
    const at = new Date('2026-11-21T15:00:00.000Z');
    const record = (database, reason, noteReason) => recordEstimateStillDeciding({
      estimateToken: 'tok-1', reason, req: REQ, database, viewabilityCheck: viewable, noteReason, now: () => at,
    });

    test('the keys are the five reasons the sheet offers', () => {
      expect(STILL_DECIDING_REASONS).toEqual({
        price: 'A lower price',
        person: 'Talking to a person first',
        quotes: 'Comparing other quotes',
        timing: 'Not the right time yet',
        other: 'Something else',
      });
    });

    test('a first signal with a reason: one row that carries the reason and its time, then the office hook', async () => {
      const database = mockDb();
      const noteReason = jest.fn(async () => undefined);
      const out = await record(database, 'person', noteReason);
      expect(out).toEqual({ success: true, deduped: false });
      expect(database.activity).toHaveLength(1);
      expect(database.activity[0].description).toBe('Customer is still deciding on their estimate. What would help: Talking to a person first.');
      expect(JSON.parse(database.activity[0].metadata)).toEqual({ source: 'public_estimate', reason: 'person', reason_at: at.toISOString() });
      expect(noteReason).toHaveBeenCalledTimes(1);
      expect(noteReason).toHaveBeenCalledWith(REQ, 'est-1', 'person');
      expect(database.inserts).toHaveLength(0);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });

    test('the sheet\'s order (signal on the tap, reason after it): the day\'s row takes the reason, no second row', async () => {
      const database = mockDb({ recentSignal: { id: 'act-1' } });
      const noteReason = jest.fn(async () => undefined);
      const out = await record(database, 'price', noteReason);
      expect(out).toEqual({ success: true, deduped: true });
      expect(database.activity).toHaveLength(0);
      expect(database.activityUpdates).toHaveLength(1);
      expect(database.activityUpdates[0].filter).toEqual({ id: 'act-1' });
      expect(database.activityUpdates[0].changes.description).toBe('Customer is still deciding on their estimate. What would help: A lower price.');
      expect(JSON.parse(database.activityUpdates[0].changes.metadata)).toEqual({ source: 'public_estimate', reason: 'price', reason_at: at.toISOString() });
      expect(noteReason).toHaveBeenCalledWith(REQ, 'est-1', 'price');
    });

    // The sheet says "We will call you" only on this answer, so it is true only when a call can be made.
    test('the answer promises a call only for "Talking to a person first" on an estimate with a phone', async () => {
      const withPhone = { ...ESTIMATE_ROW, customer_phone: ' +19415550100 ' };
      const noteReason = async () => undefined;
      expect(await record(mockDb({ estimate: withPhone }), 'person', noteReason)).toEqual({ success: true, deduped: false, callPromised: true });
      expect(await record(mockDb({ estimate: withPhone, recentSignal: { id: 'act-1' } }), 'person', noteReason))
        .toEqual({ success: true, deduped: true, callPromised: true });
      expect(await record(mockDb({ estimate: { ...ESTIMATE_ROW, customer_phone: '  ' } }), 'person', noteReason)).toEqual({ success: true, deduped: false });
      expect(await record(mockDb({ estimate: withPhone }), 'price', noteReason)).toEqual({ success: true, deduped: false });
      expect(await record(mockDb({ estimate: withPhone }), undefined, noteReason)).toEqual({ success: true, deduped: false });
    });

    test('a signal with no reason never clears a reason and rings nothing', async () => {
      for (const reason of [undefined, null, '']) {
        const database = mockDb({ recentSignal: { id: 'act-1', metadata: { reason: 'person' } } });
        const noteReason = jest.fn(async () => undefined);
        expect(await record(database, reason, noteReason)).toEqual({ success: true, deduped: true });
        expect(database.activityUpdates).toHaveLength(0);
        expect(database.activity).toHaveLength(0);
        expect(noteReason).not.toHaveBeenCalled();
      }
      const database = mockDb();
      const noteReason = jest.fn(async () => undefined);
      await record(database, undefined, noteReason);
      expect(JSON.parse(database.activity[0].metadata)).toEqual({ source: 'public_estimate' });
      expect(noteReason).not.toHaveBeenCalled();
    });

    test('a reason the sheet does not offer is a 400 on a VALID token only, with nothing written or rung', async () => {
      for (const reason of ['cheaper', 'constructor', '__proto__', 'toString', ['price'], { key: 'price' }, 7]) {
        const database = mockDb();
        const noteReason = jest.fn(async () => undefined);
        await expect(record(database, reason, noteReason)).rejects.toMatchObject({ status: 400 });
        expect(database.activity).toHaveLength(0);
        expect(database.activityUpdates).toHaveLength(0);
        expect(noteReason).not.toHaveBeenCalled();
      }
      const dead = mockDb({ estimate: { ...ESTIMATE_ROW, status: 'declined' } });
      await expect(record(dead, 'cheaper', jest.fn())).rejects.toMatchObject({ status: 404 });
    });

    test('the office hook runs only after the write committed', async () => {
      const events = [];
      const database = mockDb();
      database.transaction = async (fn) => {
        const trx = (table) => (table === 'estimates'
          ? { where: () => ({ forUpdate: () => ({ first: async () => ESTIMATE_ROW }), first: async () => ESTIMATE_ROW }) }
          : database(table));
        trx.raw = database.raw;
        const out = await fn(trx);
        events.push('commit');
        return out;
      };
      await record(database, 'quotes', async () => { events.push('hook'); });
      expect(events).toEqual(['commit', 'hook']);

      // A write the locked row refuses never reaches the hook.
      const refused = mockDb();
      refused.transaction = async (fn) => {
        const locked = { ...ESTIMATE_ROW, status: 'accepted' };
        const trx = (table) => (table === 'estimates'
          ? { where: () => ({ forUpdate: () => ({ first: async () => locked }), first: async () => locked }) }
          : refused(table));
        trx.raw = refused.raw;
        return fn(trx);
      };
      const hook = jest.fn();
      await expect(record(refused, 'quotes', hook)).rejects.toMatchObject({ status: 404 });
      expect(hook).not.toHaveBeenCalled();
    });
  });

  test('runs under the estimate row lock and re-validates the LOCKED row (pre-push codex P0)', async () => {
    // The pre-lock read sees a live row; the locked re-read sees it accepted.
    // The write must follow the locked row: 404, nothing written.
    const events = [];
    const lockedRow = { ...ESTIMATE_ROW, status: 'accepted' };
    const database = mockDb();
    database.transaction = async (fn) => {
      const trx = (table) => {
        if (table === 'estimates') {
          return {
            where: () => ({
              forUpdate: () => ({ first: async () => { events.push('lock'); return lockedRow; } }),
              first: async () => lockedRow,
            }),
          };
        }
        return database(table);
      };
      trx.raw = database.raw;
      events.push('begin');
      return fn(trx);
    };
    await expect(recordEstimateStillDeciding({
      estimateToken: 'tok-1',
      database,
      viewabilityCheck: viewable,
      callSideBlockedFor: async (dbx) => { events.push(dbx === database ? 'verdict:outside' : 'verdict:trx'); return false; },
    })).rejects.toMatchObject({ status: 404 });
    expect(events).toEqual(['begin', 'lock']);
    expect(database.activity).toHaveLength(0);

    // Live locked row: the verdict runs on the trx connection, then the insert.
    lockedRow.status = 'viewed';
    events.length = 0;
    const out = await recordEstimateStillDeciding({
      estimateToken: 'tok-1',
      database,
      viewabilityCheck: viewable,
      callSideBlockedFor: async (dbx) => { events.push(dbx === database ? 'verdict:outside' : 'verdict:trx'); return false; },
    });
    expect(out).toEqual({ success: true, deduped: false });
    expect(events).toEqual(['begin', 'lock', 'verdict:trx']);
    expect(database.activity).toHaveLength(1);
  });
});

describe('bell policy', () => {
  test('estimate_change_request is owner-overridable (silenceable) while the send itself carries bell:true', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/notification-bell-policy'), 'utf8');
    const allowlistBlock = src.slice(src.indexOf('CATEGORY_BELL_ALLOWLIST = new Set(['), src.indexOf(']);', src.indexOf('CATEGORY_BELL_ALLOWLIST = new Set([')));
    const overridableStart = src.indexOf('OVERRIDABLE_CATEGORIES = [');
    const overridableBlock = src.slice(overridableStart, src.indexOf('];', overridableStart));
    expect(allowlistBlock).not.toContain("'estimate_change_request'");
    expect(overridableBlock).toContain("'estimate_change_request'");
  });
});

// The estimate page's change and call requests also page the admin phones, after the bell row
// exists and the delivery stamp is written. The measurement review (same notify core) is not part of this.
describe('the phone page on the estimate page asks', () => {
  const pushes = () => triggerNotification.mock.calls.filter(([key]) => key === 'portal_ask');
  // The push is not awaited by the request (it must not hold the customer): let it settle before reading it.
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  beforeEach(() => { require('../services/portal-ask-push').__private.resetPageLimits(); });

  test('a change request pushes once: first name and last initial, no note, no contact details', async () => {
    await createEstimateOfficeRequest({ estimateToken: 'tok-1', topics: ['price'], note: 'Call me at 941-555-0100', database: mockDb(), viewabilityCheck: viewable });
    await settle();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(pushes()).toHaveLength(1);
    const [key, payload, opts] = pushes()[0];
    expect(key).toBe('portal_ask');
    expect(opts).toEqual({ pushOnly: true });
    expect(payload).toEqual(expect.objectContaining({
      itemKey: 'estimate-request:req-1',
      title: 'Change an estimate for a customer',
      body: 'Pat S. asked for a change to an estimate',
      link: '/admin/customers?customerId=cust-1',
      customerId: 'cust-1',
    }));
    expect(JSON.stringify(payload)).not.toMatch(/941|555/);
  });

  test('a call request pushes once and says so', async () => {
    await createEstimateOfficeRequest({ kind: 'callback', estimateToken: 'tok-1', database: mockDb(), viewabilityCheck: viewable });
    await settle();
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][1].title).toBe('Call a customer about an estimate');
    expect(pushes()[0][1].body).toBe('Pat S. asked for a call about an estimate');
  });

  test('a bell the policy withheld pushes nothing', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true });
    await createEstimateOfficeRequest({ estimateToken: 'tok-1', topics: ['price'], note: 'Lower it', database: mockDb(), viewabilityCheck: viewable });
    await settle();
    expect(pushes()).toHaveLength(0);
  });

  test('a bell that failed twice pushes nothing', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await createEstimateOfficeRequest({ estimateToken: 'tok-1', topics: ['price'], note: 'Lower it', database: mockDb(), viewabilityCheck: viewable });
    await settle();
    expect(pushes()).toHaveLength(0);
  });

  test('a bell that lands on the second try pushes once', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'notif-2' });
    await createEstimateOfficeRequest({ estimateToken: 'tok-1', topics: ['price'], note: 'Lower it', database: mockDb(), viewabilityCheck: viewable });
    await settle();
    expect(pushes()).toHaveLength(1);
  });

  test('a deduped second submission with a delivery stamp writes no bell and pushes nothing', async () => {
    const dupeRow = { id: 'req-0', subject: 's', description: 'd', customer_id: 'cust-1', pricing_revision: { notifiedAt: '2026-11-01T00:00:00Z' } };
    await createEstimateOfficeRequest({ estimateToken: 'tok-1', topics: ['price'], note: 'Lower it', database: mockDb({ dupeRow }), viewabilityCheck: viewable });
    await settle();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(pushes()).toHaveLength(0);
  });

  test('a push that throws costs the request nothing', async () => {
    triggerNotification.mockRejectedValueOnce(new Error('push down'));
    await expect(createEstimateOfficeRequest({ estimateToken: 'tok-1', topics: ['price'], note: 'Lower it', database: mockDb(), viewabilityCheck: viewable }))
      .resolves.toEqual({ success: true, deduped: false });
  });

  test('the measurement review kind (same notify core) sends no push', async () => {
    await sendOfficeNotification(mockDb(), { subject: 'Re-measure lawn for estimate #1', description: 'd', customerId: 'cust-1', estimateId: 'est-1', requestId: 'req-9' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(pushes()).toHaveLength(0);
  });
});
