/**
 * Customer soft exit — change request + still-deciding (GATE_ESTIMATE_SOFT_EXIT).
 * Invariants:
 *   - neither path mutates the estimate; the change request's only write is
 *     the service_requests row (+ admin bell), still-deciding's is one
 *     activity_log row (no bell, no request row).
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
jest.mock('../services/estimate-add-service-request', () => {
  const actual = jest.requireActual('../services/estimate-add-service-request');
  return {
    ...actual,
    resolveEstimateCustomer: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Pat' }),
  };
});

const NotificationService = require('../services/notification-service');
const {
  CHANGE_REQUEST_SERVICE_KEY,
  CHANGE_REQUEST_TOPICS,
  normalizeTopics,
  isSoftExitEligible,
  createEstimateChangeRequest,
  recordEstimateStillDeciding,
} = require('../services/estimate-change-request');

const ESTIMATE_ROW = { id: 'est-1', token: 'tok-1', status: 'viewed', estimate_number: 'EST-2026-0099', customer_id: 'cust-1' };

function mockDb({ estimate = ESTIMATE_ROW, dupeRow = null, recentSignal = null } = {}) {
  const inserts = [];
  const activity = [];
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
    if (table === 'activity_log') {
      return {
        where: () => ({ where: () => ({ first: async () => recentSignal }) }),
        insert: async (row) => { activity.push(row); return [1]; },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  database.raw = (s) => s;
  database.inserts = inserts;
  database.activity = activity;
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

describe('createEstimateChangeRequest', () => {
  test('empty note on a VALID estimate is a 400 and writes nothing', async () => {
    const database = mockDb();
    await expect(createEstimateChangeRequest({ estimateToken: 'tok-1', topics: ['price'], note: '  ', database, viewabilityCheck: viewable }))
      .rejects.toMatchObject({ status: 400 });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('unknown token / unviewable / terminal rows all 404 before content validation', async () => {
    for (const [estimate, check] of [[null, viewable], [ESTIMATE_ROW, () => false], [{ ...ESTIMATE_ROW, status: 'declined' }, viewable]]) {
      const database = mockDb({ estimate });
      await expect(createEstimateChangeRequest({ estimateToken: 'tok-1', note: '', database, viewabilityCheck: check }))
        .rejects.toMatchObject({ status: 404 });
      expect(database.inserts).toHaveLength(0);
    }
  });

  test('parks ONE request row with a dedicated key and rings the change-request bell', async () => {
    const database = mockDb();
    const out = await createEstimateChangeRequest({
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
    // Direct customer communication rings by default (explicit bell tag).
    expect(opts.bell).toBe(true);
    expect(opts.metadata).toMatchObject({ estimateId: 'est-1', requestId: 'req-1' });
  });

  test('a second open request dedupes to the existing delivered row (no insert, no second bell)', async () => {
    const database = mockDb({ dupeRow: { id: 'req-0', pricing_revision: JSON.stringify({ notifiedAt: '2026-09-01T00:00:00Z' }) } });
    const out = await createEstimateChangeRequest({ estimateToken: 'tok-1', note: 'again', database, viewabilityCheck: viewable });
    expect(out).toEqual({ success: true, deduped: true });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('the call-side verdict fails closed', async () => {
    const database = mockDb();
    await expect(createEstimateChangeRequest({
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
