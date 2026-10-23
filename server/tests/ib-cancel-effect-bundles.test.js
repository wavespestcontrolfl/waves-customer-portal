/**
 * Intelligence Bar cancel recovery (services/ib-cancel-effect-bundles.js): the card's approved effects are saved in the
 * cancel transaction, the request marks them complete, and a sweep finishes a stale bundle through the SAME pinned paths
 * (runVisitCancellationFollowThrough with pinnedEffects, handleCancellation with the approved text). The database is a
 * small in-memory fake of the four tables the service touches; the real SQL (the SKIP LOCKED claim, the indexes) is
 * proven on PostgreSQL in ib-cancel-effect-bundles-postgres.test.js. Synthetic ids and names only.
 */
let mockNow = new Date('2026-10-23T15:00:00Z'); // 11:00 AM ET: inside the 8 AM to 8 PM send window
const mockStore = { bundles: [], visits: [], history: [], customers: [], actions: [] };
const mockTableKey = {
  ib_cancel_effect_bundles: 'bundles',
  scheduled_services: 'visits',
  job_status_history: 'history',
  customers: 'customers',
  ib_pending_actions: 'actions',
};
const JSONB = ['approved_notice', 'linked_children', 'approved_money', 'followthrough_outcome', 'notice_outcome'];

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../models/db', () => {
  const strip = (col) => String(col).replace(/^[a-z]+\./, '');
  const evalValue = (v) => {
    if (v && v.__now) return new Date(mockNow);
    if (v && v.__raw) {
      const m = /^(now\(\)|clock_timestamp\(\))(?: ([+-]) \(\? \* interval '1 millisecond'\))?$/.exec(v.__raw);
      if (m) return m[2] ? new Date(mockNow.getTime() + (m[2] === '+' ? 1 : -1) * v.bindings[0]) : new Date(mockNow);
    }
    return v;
  };
  const same = (a, b) => (a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : a === b);
  const compare = (a, op, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    const x = a instanceof Date || b instanceof Date ? new Date(a).getTime() : a;
    const y = a instanceof Date || b instanceof Date ? new Date(b).getTime() : b;
    if (op === 'not like') return !String(x).startsWith(String(y).replace(/%$/, ''));
    return { '=': x === y, '<': x < y, '<=': x <= y, '>': x > y, '>=': x >= y }[op];
  };
  const parseJson = (patch) => {
    const out = { ...patch };
    for (const key of JSONB) if (typeof out[key] === 'string') out[key] = JSON.parse(out[key]);
    return out;
  };

  class Query {
    constructor(table) { this.table = table; this.conds = []; this.max = Infinity; this.order = null; }
    _push(bool, test) { this.conds.push({ bool, test }); return this; }
    _where(bool, a, b, c) {
      if (typeof a === 'function') { const sub = new Query(this.table); a.call(sub); return this._push(bool, (r) => sub._match(r)); }
      if (a && typeof a === 'object') return this._push(bool, (r) => Object.entries(a).every(([k, v]) => same(r[strip(k)], v)));
      const [op, val] = c === undefined ? ['=', b] : [b, c];
      return this._push(bool, (r) => compare(r[strip(a)], op, evalValue(val)));
    }
    where(a, b, c) { return this._where('and', a, b, c); }
    orWhere(a, b, c) { return this._where('or', a, b, c); }
    whereNot(col, val) { return this._push('and', (r) => !same(r[strip(col)], val)); }
    whereNull(col) { return this._push('and', (r) => r[strip(col)] === null || r[strip(col)] === undefined); }
    orWhereNull(col) { return this._push('or', (r) => r[strip(col)] === null || r[strip(col)] === undefined); }
    whereIn(col, vals) { return this._push('and', (r) => vals.some((v) => same(r[strip(col)], v))); }
    leftJoin() { return this; }
    select() { return this; }
    forUpdate() { return this; }
    count() { this.counting = true; return this; }
    orderBy(col) { this.order = strip(col); return this; }
    limit(n) { this.max = n; return this; }
    _match(r) {
      let ok = null;
      for (const c of this.conds) {
        const v = c.test(r);
        ok = ok === null ? v : (c.bool === 'or' ? ok || v : ok && v);
      }
      return ok === null ? true : ok;
    }
    _rows() {
      let rows = mockStore[mockTableKey[this.table.split(' ')[0]]].filter((r) => this._match(r));
      if (this.order) rows = [...rows].sort((a, b) => new Date(a[this.order]) - new Date(b[this.order]));
      return rows.slice(0, this.max);
    }
    async first() {
      if (this.counting) return { n: String(this._rows().length) };
      const [row] = this._rows();
      if (!row) return undefined;
      if (this.table.startsWith('scheduled_services as s')) {
        const customer = mockStore.customers.find((c) => c.id === row.customer_id) || {};
        return { ...row, first_name: customer.first_name, last_name: customer.last_name };
      }
      return { ...row };
    }
    async update(patch) {
      const rows = this._rows();
      for (const row of rows) {
        const applied = parseJson(patch);
        for (const [k, v] of Object.entries(applied)) {
          if (v && v.__raw === 'GREATEST(attempts - 1, 0)') row[k] = Math.max((row.attempts || 0) - 1, 0);
          else row[k] = evalValue(v);
        }
      }
      return rows.length;
    }
    async del() {
      const key = mockTableKey[this.table];
      const doomed = new Set(this._rows());
      mockStore[key] = mockStore[key].filter((r) => !doomed.has(r));
      return doomed.size;
    }
    insert(row) {
      const key = mockTableKey[this.table];
      const failInsert = mockStore.failInsert === this.table;
      return {
        returning: async () => {
          if (failInsert) throw new Error('insert failed');
          const stored = { id: `bundle-${mockStore.bundles.length + 1}`, status: 'pending', attempts: 0, ...parseJson(row) };
          for (const [k, v] of Object.entries(stored)) stored[k] = evalValue(v);
          mockStore[key].push(stored);
          return [{ id: stored.id }];
        },
      };
    }
    then(resolve, reject) { return Promise.resolve(this._rows().map((r) => ({ ...r }))).then(resolve, reject); }
  }

  const db = (table) => new Query(table);
  db.fn = { now: () => ({ __now: true }) };
  db.raw = (sql, bindings = []) => {
    const marker = { __raw: sql.trim(), bindings };
    if (!/^UPDATE ib_cancel_effect_bundles/i.test(marker.__raw)) return marker;
    const svc = require('../services/ib-cancel-effect-bundles');
    const [token, leaseMs, a, b] = bindings;
    const leaseFree = (x) => !x.lease_until || new Date(x.lease_until) < mockNow;
    let candidate;
    if (/status = 'complete'/.test(marker.__raw)) {
      // The receipt-gap claim: request-completed rows 10 minutes old or more, inside the hard stop, lease free.
      candidate = mockStore.bundles
        .filter((x) => x.status === 'complete' && x.finish_note === 'request' && x.pending_action_id
          && new Date(x.finished_at) <= new Date(mockNow.getTime() - a)
          && new Date(x.finished_at) > new Date(mockNow.getTime() - b)
          && leaseFree(x))
        .sort((x, y) => new Date(x.finished_at) - new Date(y.finished_at))[0];
      if (candidate) Object.assign(candidate, { lease_owner: token, lease_until: new Date(mockNow.getTime() + leaseMs) });
    } else if (/OR attempts >= \?/.test(marker.__raw)) {
      // The unactable claim: pending, lease free, past the hard stop or out of attempts. No attempt is counted.
      candidate = mockStore.bundles
        .filter((x) => x.status === 'pending' && leaseFree(x)
          && (new Date(x.created_at) <= new Date(mockNow.getTime() - a) || x.attempts >= b))
        .sort((x, y) => new Date(x.created_at) - new Date(y.created_at))[0];
      if (candidate) Object.assign(candidate, { lease_owner: token, lease_until: new Date(mockNow.getTime() + leaseMs) });
    } else {
      // The recovery claim: oldest pending row past the grace, inside the hard stop, with attempts left and no live lease.
      candidate = mockStore.bundles
        .filter((x) => x.status === 'pending'
          && new Date(x.created_at) <= new Date(mockNow.getTime() - svc.GRACE_MS)
          && new Date(x.created_at) > new Date(mockNow.getTime() - svc.HARD_STOP_MS)
          && x.attempts < svc.MAX_ATTEMPTS
          && leaseFree(x)
          && (!x.next_attempt_at || new Date(x.next_attempt_at) <= mockNow))
        .sort((x, y) => new Date(x.created_at) - new Date(y.created_at))[0];
      if (candidate) Object.assign(candidate, { lease_owner: token, lease_until: new Date(mockNow.getTime() + leaseMs), attempts: candidate.attempts + 1 });
    }
    return Promise.resolve({ rows: candidate ? [{ ...candidate }] : [] });
  };
  db.transaction = async (cb) => {
    const snapshot = JSON.parse(JSON.stringify(mockStore.bundles));
    const trx = (table) => new Query(table);
    trx.raw = db.raw; trx.fn = db.fn;
    try { return await cb(trx); } catch (err) { mockStore.bundles = snapshot; throw err; }
  };
  return db;
});

const mockFollowThrough = jest.fn(async () => ({ settled: 1 }));
jest.mock('../services/visit-cancellation-followthrough', () => ({
  runVisitCancellationFollowThrough: (...a) => mockFollowThrough(...a),
}));
const mockNoticeStatus = jest.fn(async () => 'ready');
const mockHandleCancellation = jest.fn(async (_id, opts) => { opts.outcome.notificationSent = true; });
jest.mock('../services/appointment-reminders', () => ({
  approvedCancellationNoticeStatus: (...a) => mockNoticeStatus(...a),
  handleCancellation: (...a) => mockHandleCancellation(...a),
}));
const mockRecordResult = jest.fn(async () => true);
jest.mock('../services/intelligence-bar/pending-actions', () => ({ recordResult: (...a) => mockRecordResult(...a) }));
// The alert goes through the REAL composer so the copy is checked against docs/admin-notifications.md.
const mockRaised = [];
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return {
    ...actual,
    raiseAdminAlert: jest.fn(async (category, spec, opts) => { actual.composeAdminAlert(spec); mockRaised.push({ category, spec, opts }); return { id: 'notif-1' }; }),
  };
});

const svc = require('../services/ib-cancel-effect-bundles');
const db = require('../models/db');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SERVICE = '00000000-0000-4000-8000-0000000000a1';
const CHILD = '00000000-0000-4000-8000-0000000000c1';
const ACTION = '00000000-0000-4000-8000-0000000000b1';
const NOTICE = [{ recipient_key: 'abc123abc123abc1', body: 'Hi Synthia, your visit on Oct 30 is cancelled.' }];
const MONEY = { invoices: [{ id: 'inv-1', total: 90, payment_intent_id: null }], creditReversalOfferIds: ['offer-1'] };

function seedBundle(overrides = {}) {
  const row = {
    id: 'bundle-1',
    pending_action_id: ACTION,
    scheduled_service_id: SERVICE,
    actor_id: 'admin-1',
    notes: 'Cancelled via Intelligence Bar: customer asked',
    notify_customer: true,
    approved_notice: NOTICE,
    linked_children: [{ id: CHILD, status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control' }],
    approved_money: MONEY,
    restorations_seen: 0,
    status: 'pending',
    lease_owner: 'request',
    lease_until: new Date(mockNow.getTime() - 20 * MIN),
    attempts: 0,
    followthrough_done_at: null,
    followthrough_outcome: null,
    notice_outcome: null,
    created_at: new Date(mockNow.getTime() - 30 * MIN),
    ...overrides,
  };
  mockStore.bundles.push(row);
  return row;
}

// Only Date is faked: the service reads the wall clock for the send window and the visit-date check.
const setNow = (date) => { mockNow = date; jest.setSystemTime(date); };
beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  setNow(new Date('2026-10-23T15:00:00Z'));
  mockStore.bundles = [];
  mockStore.actions = [];
  mockStore.failInsert = null;
  mockStore.visits = [
    { id: SERVICE, status: 'cancelled', customer_id: 'cust-1', service_type: 'Pest Control', scheduled_date: '2026-10-30' },
    { id: CHILD, status: 'confirmed', customer_id: 'cust-1', service_type: 'Pest Control', scheduled_date: '2026-11-02' },
  ];
  mockStore.history = [{ id: 1, job_id: SERVICE, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: new Date(mockNow.getTime() - 30 * MIN) }];
  mockStore.customers = [{ id: 'cust-1', first_name: 'Synthia', last_name: 'Tester' }];
  mockRaised.length = 0;
  jest.clearAllMocks();
  mockNoticeStatus.mockResolvedValue('ready');
  mockHandleCancellation.mockImplementation(async (_id, opts) => { opts.outcome.notificationSent = true; });
  mockFollowThrough.mockImplementation(async () => ({ settled: 1 }));
});

describe('the bundle is written in the cancel transaction', () => {
  const pins = {
    pendingActionId: ACTION, scheduledServiceId: SERVICE, actorId: 'admin-1', notes: 'n', notifyCustomer: true,
    approvedNotice: NOTICE, linkedChildren: [{ id: CHILD }], approvedMoney: MONEY,
  };

  test('it stores exactly what the card approved, as JSON, with a request lease', async () => {
    const id = await db.transaction((trx) => svc.insertBundle(trx, pins));
    const [row] = mockStore.bundles;
    expect(id).toBe(row.id);
    expect(row).toMatchObject({
      pending_action_id: ACTION, scheduled_service_id: SERVICE, actor_id: 'admin-1', notes: 'n', notify_customer: true,
      approved_notice: NOTICE, linked_children: [{ id: CHILD }], approved_money: MONEY, status: 'pending', lease_owner: 'request',
    });
    expect(row.lease_until.getTime()).toBe(mockNow.getTime() + svc.LEASE_MS);
  });

  test('it pins the cancellation GENERATION: how many restorations the visit had before this cancel (no times)', async () => {
    mockStore.history.push(
      { id: 5, job_id: SERVICE, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(mockNow.getTime() - 90 * MIN) },
      { id: 6, job_id: SERVICE, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: new Date(mockNow.getTime() - 80 * MIN) },
      { id: 7, job_id: SERVICE, from_status: 'cancelled', to_status: 'pending', transitioned_at: new Date(mockNow.getTime() - 70 * MIN) },
      { id: 8, job_id: SERVICE, from_status: 'cancelled', to_status: 'cancelled', transitioned_at: new Date(mockNow.getTime() - 60 * MIN) }, // same-status audit row: not a restoration
      { id: 9, job_id: 'some-other-visit', from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(mockNow.getTime() - 60 * MIN) },
    );
    await db.transaction((trx) => svc.insertBundle(trx, pins));
    expect(mockStore.bundles[0].restorations_seen).toBe(2);
  });

  test('each approved linked visit also pins its OWN restoration count', async () => {
    mockStore.history.push(
      { id: 40, job_id: CHILD, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(mockNow.getTime() - 60 * MIN) },
      { id: 41, job_id: CHILD, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: new Date(mockNow.getTime() - 50 * MIN) },
    );
    await db.transaction((trx) => svc.insertBundle(trx, { ...pins, linkedChildren: [{ id: CHILD, status: 'confirmed' }] }));
    expect(mockStore.bundles[0].linked_children).toEqual([{ id: CHILD, status: 'confirmed', restorations_seen: 1 }]);
  });

  test('the no-text choice is stored as a bundle with no approved notice', async () => {
    await db.transaction((trx) => svc.insertBundle(trx, { ...pins, notifyCustomer: false, approvedNotice: null }));
    expect(mockStore.bundles[0]).toMatchObject({ notify_customer: false, approved_notice: null });
  });

  test('a rollback of the cancel takes the bundle with it', async () => {
    await expect(db.transaction(async (trx) => {
      await svc.insertBundle(trx, pins);
      throw new Error('the status change failed');
    })).rejects.toThrow('the status change failed');
    expect(mockStore.bundles).toEqual([]);
  });

  test('an insert failure throws, so the cancel aborts instead of committing without its record', async () => {
    mockStore.failInsert = 'ib_cancel_effect_bundles';
    await expect(db.transaction((trx) => svc.insertBundle(trx, pins))).rejects.toThrow('insert failed');
    expect(mockStore.bundles).toEqual([]);
  });
});

describe('the request marks its bundle complete', () => {
  test('liveFinish completes a pending bundle with the follow-through reports and frees the lease', async () => {
    const row = seedBundle({ created_at: new Date(mockNow.getTime() - 1 * MIN) });
    await svc.liveFinish({ ibCancelBundleId: row.id, ibMoneyReport: { skipped: [{ kind: 'invoice', id: 'inv-1', reason: 'x' }] }, ibLinkedChildReport: { skipped: [] } });
    expect(row).toMatchObject({ status: 'complete', finish_note: 'request', lease_owner: null, lease_until: null });
    expect(row.followthrough_outcome).toEqual({ money_skipped: [{ kind: 'invoice', id: 'inv-1', reason: 'x' }], linked_skipped: [] });
  });

  test('a dispatch cancel with no bundle (no id on the request) touches nothing', async () => {
    seedBundle();
    await svc.liveStart({});
    await svc.liveNotice({}, { notificationSent: true });
    await svc.liveFinish({});
    expect(mockStore.bundles[0].status).toBe('pending');
  });

  test('liveStart renews the request lease; it does not take a lease a sweep holds', async () => {
    const mine = seedBundle({ lease_owner: 'request', lease_until: new Date(mockNow.getTime() + 1 * MIN) });
    await svc.liveStart({ ibCancelBundleId: mine.id });
    expect(mine.lease_until.getTime()).toBe(mockNow.getTime() + svc.LEASE_MS);
    mockStore.bundles = [];
    const held = seedBundle({ lease_owner: 'sweep-token', lease_until: new Date(mockNow.getTime() + 5 * MIN) });
    await svc.liveStart({ ibCancelBundleId: held.id });
    expect(held.lease_owner).toBe('sweep-token');
  });

  test('liveNotice records the text outcome the request reported', async () => {
    const row = seedBundle();
    await svc.liveNotice({ ibCancelBundleId: row.id }, { notificationSent: false, notificationError: 'blocked for +19415550100' });
    expect(row.notice_outcome).toEqual({ state: 'not_sent', error: 'blocked for [number]', by: 'request' });
  });

  test('a database failure in these calls never throws into the request', async () => {
    const original = db.fn.now;
    db.fn.now = () => { throw new Error('connection lost'); };
    await expect(svc.liveFinish({ ibCancelBundleId: 'bundle-1' })).resolves.toBeNull();
    db.fn.now = original;
  });
});

describe('the sweep finishes a stale bundle through the pinned paths', () => {
  test('it runs the follow-through with exactly the arguments the Dispatch handler passes, then the approved text', async () => {
    seedBundle();
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ recovered: 1, failed: 0 });
    const args = mockFollowThrough.mock.calls[0][0];
    expect(args).toMatchObject({
      targetIds: [SERVICE], actorId: 'admin-1', waiveFee: false, reason: 'Cancelled via Intelligence Bar: customer asked',
      pinnedEffects: { [SERVICE]: MONEY }, linkedChildren: [{ id: CHILD, status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control' }],
    });
    expect(args.linkedChildReport).toEqual({ skipped: [] });
    expect(args.moneyReport).toEqual({ skipped: [] });
    // Same key set as the request's call in admin-dispatch.js (a drift here means the two paths diverged).
    expect(Object.keys(svc.followThroughArgs(mockStore.bundles[0], [], { money: {}, linked: {} })).sort())
      .toEqual(['actorId', 'linkedChildReport', 'linkedChildren', 'moneyReport', 'pinnedEffects', 'reason', 'source', 'targetIds', 'waiveFee']);
    // The text: the approved bodies only, never the live template.
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation.mock.calls[0][0]).toBe(SERVICE);
    expect(mockHandleCancellation.mock.calls[0][1]).toMatchObject({ sendNotification: true, approvedNotice: NOTICE });
    // The claim itself is bound to this cancellation (one statement), and the delivery proof counts every approved recipient.
    expect(mockHandleCancellation.mock.calls[0][1].cancelGeneration).toEqual({ visitId: SERVICE, restorations: 0, hits: [] });
    expect(mockNoticeStatus).toHaveBeenCalledWith(SERVICE, { recipientKeys: ['abc123abc123abc1'] });
    expect(mockStore.bundles[0]).toMatchObject({ status: 'recovered', finish_note: 'sweep', lease_owner: null });
    expect(mockStore.bundles[0].notice_outcome).toMatchObject({ state: 'sent', by: 'sweep' });
  });

  test('the receipt lands on the pending action (only if it has none) and the office is told', async () => {
    seedBundle();
    await svc.sweepIbCancelBundles();
    expect(mockRecordResult).toHaveBeenCalledWith(ACTION, expect.objectContaining({ success: true, recovered_after_interruption: true, customer_text_sent: true, customer_name: 'Synthia Tester', service_type: 'Pest Control', date: '2026-10-30' }), { onlyIfEmpty: true });
    expect(mockRaised).toHaveLength(1);
    expect(mockRaised[0].spec).toMatchObject({ area: 'Schedule', severity: 'fyi', subject: { type: 'visit', id: SERVICE } });
    expect(mockRaised[0].opts).toMatchObject({ dedupeKey: 'ib-cancel-bundle:bundle-1', fyiRow: true, bell: false });
    expect(mockRaised[0].spec.action).toContain('Synthia Tester');
  });

  test('a skipped effect is reported to the office as needs-you, not forced', async () => {
    seedBundle();
    mockFollowThrough.mockImplementationOnce(async ({ moneyReport, linkedChildReport }) => {
      moneyReport.skipped.push({ kind: 'invoice', id: 'inv-1', reason: 'not_voided_changed_since_card' });
      linkedChildReport.skipped.push({ id: CHILD, reason: 'date_changed' });
    });
    await svc.sweepIbCancelBundles();
    const [{ spec, opts }] = mockRaised;
    expect(spec.severity).toBe('needs-you');
    expect(opts.bell).toBe(true);
    expect(opts.detail).toContain('invoice inv-1 (not voided changed since card)');
    expect(opts.detail).toContain(`Linked visit ${CHILD} was not cancelled (date changed)`);
    expect(mockRecordResult.mock.calls[0][1]).toMatchObject({
      money_skipped: [{ kind: 'invoice', id: 'inv-1', reason: 'not_voided_changed_since_card' }],
      linked_visits_skipped: [{ id: CHILD, reason: 'date_changed' }],
    });
    expect(mockRecordResult.mock.calls[0][1].warning).toMatch(/skipped|not/i);
  });

  test('the pinned child generation rides to the cascade untouched, so a child restored since can be recognised there', async () => {
    seedBundle({ linked_children: [{ id: CHILD, status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control', restorations_seen: 3 }] });
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough.mock.calls[0][0].linkedChildren).toEqual([{ id: CHILD, status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control', restorations_seen: 3 }]);
  });

  test('a linked visit the request already cancelled is not asked again and is not reported as changed', async () => {
    seedBundle();
    mockStore.visits.find((v) => v.id === CHILD).status = 'cancelled';
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough.mock.calls[0][0].linkedChildren).toEqual([]);
    expect(mockStore.bundles[0].followthrough_outcome).toMatchObject({ linked_skipped: [], linked_already_cancelled: [CHILD] });
  });

  test('nothing newer than the grace period is touched, nothing is claimed twice', async () => {
    seedBundle({ created_at: new Date(mockNow.getTime() - 9 * MIN) });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ recovered: 0 });
    expect(mockFollowThrough).not.toHaveBeenCalled();
    mockStore.bundles = [];
    seedBundle({ lease_owner: 'other-pod', lease_until: new Date(mockNow.getTime() + 5 * MIN) });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ recovered: 0 });
    expect(mockFollowThrough).not.toHaveBeenCalled();
  });

  test('a bundle the request completed is never run', async () => {
    seedBundle({ status: 'complete' });
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
  });

  test('a bundle for a card that chose no text runs the money and linked work and sends nothing', async () => {
    seedBundle({ notify_customer: false, approved_notice: null });
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0].notice_outcome).toMatchObject({ state: 'no_text' });
  });
});

describe('the approved text is sent at most once and never when it cannot be proven safe', () => {
  test('the request already reported its text step: the sweep does not look at the text again', async () => {
    seedBundle({ notice_outcome: { state: 'not_sent', error: 'blocked', by: 'request' } });
    await svc.sweepIbCancelBundles();
    expect(mockNoticeStatus).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    // ...and the receipt still tells the office the text did not go out.
    expect(mockRaised[0].opts.detail).toContain('The customer text did not go out');
  });

  test.each([
    ['uncertain', 'uncertain', /may have gone out/],
    ['partial', 'partial', /some recipients, not all/],
    ['delivered', 'sent', /went out/],
    ['suppressed', 'not_sent', /did not go out/],
    ['no_reminder', 'not_sent', /did not go out/],
    ['other', 'not_sent', /did not go out/],
  ])('reminder state %s is final: no send, recorded as %s', async (status, state, detail) => {
    seedBundle();
    mockNoticeStatus.mockResolvedValue(status);
    await svc.sweepIbCancelBundles();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0].notice_outcome).toMatchObject({ state });
    expect(mockRaised[0].opts.detail).toMatch(detail);
  });

  test('provider handoff began (marker sent, no accepted audit): UNCERTAIN, office review, not sent again', async () => {
    seedBundle();
    mockNoticeStatus.mockResolvedValue('uncertain');
    await svc.sweepIbCancelBundles();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockRaised[0].spec.severity).toBe('needs-you');
    expect(mockRecordResult.mock.calls[0][1]).toMatchObject({ customer_text_uncertain: true, customer_text_sent: false });
  });

  test('a send the approved path reports as uncertain or partial is recorded that way', async () => {
    seedBundle();
    mockHandleCancellation.mockImplementation(async (_id, opts) => { Object.assign(opts.outcome, { notificationSent: false, notificationUncertain: true, notificationError: 'may have gone out' }); });
    await svc.sweepIbCancelBundles();
    expect(mockStore.bundles[0].notice_outcome).toMatchObject({ state: 'uncertain' });
  });

  test('an approved text with no saved bodies is never sent', async () => {
    seedBundle({ approved_notice: null });
    await svc.sweepIbCancelBundles();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0].notice_outcome).toMatchObject({ state: 'not_sent' });
  });

  test('the visit date has passed: no late text', async () => {
    mockStore.visits[0].scheduled_date = '2026-10-20';
    seedBundle();
    await svc.sweepIbCancelBundles();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0].notice_outcome.note).toMatch(/date has passed/);
  });

  test('outside the 8 AM to 8 PM window the money work runs now and the text waits, without using up an attempt', async () => {
    setNow(new Date('2026-10-24T05:00:00Z')); // 1:00 AM ET
    seedBundle({ created_at: new Date(mockNow.getTime() - 30 * MIN), lease_until: new Date(mockNow.getTime() - 20 * MIN) });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ deferred: 1, recovered: 0 });
    expect(mockFollowThrough).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0]).toMatchObject({ status: 'pending', attempts: 0, lease_owner: null, notice_outcome: null });
    // Parked until the window opens (8 AM ET = 12:00Z), so the next passes do not claim it again tonight.
    expect(new Date(mockStore.bundles[0].next_attempt_at).toISOString()).toBe('2026-10-24T12:00:00.000Z');
    expect(mockStore.bundles[0].followthrough_done_at).toBeTruthy();
    expect(mockRaised).toEqual([]);
    // Next morning: the money step is not redone, the text goes, the bundle completes.
    setNow(new Date('2026-10-24T13:00:00Z')); // 9:00 AM ET
    mockStore.visits[0].scheduled_date = '2026-10-30';
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockStore.bundles[0].status).toBe('recovered');
  });
});

describe('the text claim is bound to the original cancellation', () => {
  test('a claim refused because the visit changed between the check and the claim abandons the bundle, not "text failed"', async () => {
    seedBundle();
    mockHandleCancellation.mockImplementationOnce(async (_id, opts) => {
      Object.assign(opts.outcome, { notificationSent: false, notificationError: 'A cancellation notice was already handled for this visit' });
      mockStore.visits[0].status = 'confirmed';
    });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ abandoned: 1 });
    expect(mockStore.bundles[0].finish_note).toBe('visit_is_confirmed_during_recovery');
  });

  // The send this sweep could not claim reads "not sent", but the original request may have stamped the reminder 'sent'
  // (just before its provider handoff) after the status was read as ready. The state is re-read before any hand-send advice.
  const unclaimed = async (laterStatus) => {
    seedBundle();
    mockNoticeStatus.mockResolvedValueOnce('ready').mockResolvedValueOnce(laterStatus);
    mockHandleCancellation.mockImplementationOnce(async (_id, opts) => {
      Object.assign(opts.outcome, { notificationSent: false, notificationError: 'A cancellation notice is already being handled for this visit' });
    });
    await svc.sweepIbCancelBundles();
    return mockStore.bundles[0];
  };

  test('a genuine send failure (the marker ended terminal suppressed) stays a not-sent text', async () => {
    const row = await unclaimed('suppressed');
    expect(row.notice_outcome).toMatchObject({ state: 'not_sent' });
    expect(row.status).toBe('recovered');
    expect(mockRaised[0].opts.detail).toContain('Send it by hand');
  });

  test.each([
    ['sent marker with no audit yet (the request is mid-handoff)', 'uncertain', 'uncertain'],
    ['sent marker with the audit now present', 'delivered', 'sent'],
    ['sent marker, some recipients proven', 'partial', 'partial'],
    ['marker untouched or another marker (unknown who holds it)', 'ready', 'uncertain'],
    ['a marker the card did not approve', 'other', 'uncertain'],
  ])('a lost claim where the reminder now reads: %s -> recorded %s, never "send it by hand"', async (_label, laterStatus, expected) => {
    const row = await unclaimed(laterStatus);
    expect(row.notice_outcome).toMatchObject({ state: expected });
    expect(mockRaised[0].opts.detail).not.toContain('Send it by hand');
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
  });
});

describe('a text claim the fence refused', () => {
  test('only busy: nothing is saved or sent, and the text retries on the next pass', async () => {
    seedBundle();
    mockHandleCancellation.mockImplementationOnce(async (_id, opts) => {
      opts.cancelGeneration.hits.push('visit_busy');
      Object.assign(opts.outcome, { notificationSent: false, notificationError: 'cancellation fence: visit_busy' });
    });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ failed: 1, recovered: 0 });
    expect(mockStore.bundles[0]).toMatchObject({ status: 'pending', notice_outcome: null });
    expect(mockStore.bundles[0].followthrough_done_at).toBeTruthy();
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ recovered: 1 });
    expect(mockFollowThrough).toHaveBeenCalledTimes(1);
  });

  test('a changed visit abandons the bundle', async () => {
    seedBundle();
    mockHandleCancellation.mockImplementationOnce(async (_id, opts) => {
      opts.cancelGeneration.hits.push('visit_is_confirmed');
      mockStore.visits[0].status = 'confirmed';
    });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ abandoned: 1 });
  });
});

describe('races and a lost lease', () => {
  test('the request finishes the bundle while the sweep works: the sweep tells no one and writes nothing', async () => {
    const row = seedBundle();
    mockFollowThrough.mockImplementationOnce(async () => { row.status = 'complete'; row.lease_owner = null; });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ recovered: 0, failed: 0, lost: 1 });
    expect(mockRaised).toEqual([]);
    expect(mockRecordResult).not.toHaveBeenCalled();
    expect(row.status).toBe('complete');
  });

  test('two sweeps back to back: the second finds nothing to claim (no second text, no second void)', async () => {
    seedBundle();
    await svc.sweepIbCancelBundles();
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockRaised).toHaveLength(1);
  });

  test('a sweep that crashed after the money step resumes with the text only', async () => {
    seedBundle({ followthrough_done_at: new Date(mockNow.getTime() - 5 * MIN), followthrough_outcome: { money_skipped: [], linked_skipped: [] } });
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockStore.bundles[0].status).toBe('recovered');
  });

  test('a failed run leaves the bundle pending with a free lease for the next tick', async () => {
    seedBundle();
    mockFollowThrough.mockRejectedValueOnce(new Error('database down'));
    const summary = await svc.sweepIbCancelBundles();
    expect(summary.failed).toBe(1);
    expect(mockStore.bundles[0]).toMatchObject({ status: 'pending', lease_owner: null, attempts: 1 });
    await svc.sweepIbCancelBundles();
    expect(mockStore.bundles[0].status).toBe('recovered');
  });

  test('out of attempts: reported to the office, not run again', async () => {
    seedBundle({ attempts: svc.MAX_ATTEMPTS, lease_owner: null, lease_until: null });
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockStore.bundles[0]).toMatchObject({ status: 'expired', finish_note: 'attempts_exhausted' });
    expect(mockRaised[0].spec.severity).toBe('needs-you');
  });
});

describe('the hard stop and a visit that is no longer cancelled', () => {
  test('older than 24 hours: reported only, nothing runs', async () => {
    seedBundle({ created_at: new Date(mockNow.getTime() - 25 * HOUR), lease_until: new Date(mockNow.getTime() - 24 * HOUR) });
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockNoticeStatus).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0]).toMatchObject({ status: 'expired', finish_note: 'hard_stop' });
    expect(mockRaised[0].spec.severity).toBe('needs-you');
    expect(mockRaised[0].opts.detail).toContain('Nothing more will run on its own');
    expect(mockRecordResult.mock.calls[0][1].warning).toMatch(/could not be confirmed/);
  });

  test('a visit restored since the cancel: nothing is voided or texted, the office is told', async () => {
    seedBundle();
    mockStore.visits[0].status = 'confirmed';
    mockStore.history.push({ id: 2, job_id: SERVICE, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(mockNow.getTime() - 10 * MIN) });
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0]).toMatchObject({ status: 'abandoned', finish_note: 'visit_is_confirmed' });
    expect(mockRaised[0].spec.severity).toBe('needs-you');
  });

  test('cancelled, restored and cancelled again by someone else: the old bundle is abandoned', async () => {
    seedBundle();
    mockStore.history.push(
      { id: 2, job_id: SERVICE, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(mockNow.getTime() - 20 * MIN) },
      { id: 3, job_id: SERVICE, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: new Date(mockNow.getTime() - 10 * MIN) },
    );
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockStore.bundles[0]).toMatchObject({ status: 'abandoned', finish_note: 'visit_restored_since' });
  });
});

describe('an exhausted bundle is claimed before it is reported', () => {
  const exhausted = (over = {}) => seedBundle({ attempts: svc.MAX_ATTEMPTS, lease_owner: null, lease_until: null, ...over });

  test('the claim is a report-prefixed lease; the request cannot complete the row while the report runs', async () => {
    const row = exhausted();
    let ownerDuringReport = null;
    mockRecordResult.mockImplementationOnce(async () => {
      ownerDuringReport = row.lease_owner;
      // The original request wakes up and finishes while the sweep is reporting.
      await svc.liveFinish({ ibCancelBundleId: row.id, ibMoneyReport: { skipped: [] }, ibLinkedChildReport: { skipped: [] } });
      return true;
    });
    const summary = await svc.sweepIbCancelBundles();
    expect(ownerDuringReport).toMatch(/^report:/);
    expect(summary).toMatchObject({ reported: 1, lost: 0, failed: 0 });
    expect(row).toMatchObject({ status: 'expired', finish_note: 'attempts_exhausted', lease_owner: null });
    expect(mockRaised).toHaveLength(1);
  });

  test('a row the request completed before the claim is never reported', async () => {
    const row = exhausted({ status: 'complete', finish_note: 'request', finished_at: new Date(mockNow.getTime() - 1 * MIN) });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary.reported).toBe(0);
    expect(mockRaised).toEqual([]);
    expect(row.status).toBe('complete');
  });

  test('a request still holding a live lease is not claimed or reported', async () => {
    const row = exhausted({ lease_owner: 'request', lease_until: new Date(mockNow.getTime() + 5 * MIN) });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary.reported).toBe(0);
    expect(mockRaised).toEqual([]);
    expect(mockRecordResult).not.toHaveBeenCalled();
    expect(row.status).toBe('pending');
  });

  test('a second sweep running during the report cannot claim the same row: one receipt, one alert', async () => {
    exhausted();
    let nested = null;
    mockRecordResult.mockImplementationOnce(async () => {
      nested = await svc.sweepIbCancelBundles();
      return true;
    });
    await svc.sweepIbCancelBundles();
    expect(nested.reported).toBe(0);
    expect(mockRecordResult).toHaveBeenCalledTimes(1);
    expect(mockRaised).toHaveLength(1);
  });

  test('the claim lost before the alert: no alert and no status change', async () => {
    const row = exhausted();
    mockRecordResult.mockImplementationOnce(async () => {
      // Another actor took the row over between the receipt and the alert.
      row.lease_owner = 'someone-else';
      return true;
    });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ reported: 0, lost: 1, failed: 0 });
    expect(mockRaised).toEqual([]);
    expect(row.status).toBe('pending');
  });

  test('a report that throws leaves the row pending with a free lease for the next pass', async () => {
    const row = exhausted();
    const composer = require('../services/admin-alert-compose');
    composer.raiseAdminAlert.mockRejectedValueOnce(new Error('alert store down'));
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ reported: 0, failed: 1 });
    expect(row).toMatchObject({ status: 'pending', lease_owner: null });
    const again = await svc.sweepIbCancelBundles();
    expect(again.reported).toBe(1);
    expect(row.status).toBe('expired');
  });
});

describe('a complete bundle whose receipt was never saved', () => {
  const FT_SKIPPED = { money_skipped: [{ kind: 'invoice', id: 'inv-1', reason: 'paid_since_card' }], linked_skipped: [] };
  const completed = (over = {}) => seedBundle({
    status: 'complete', finish_note: 'request', lease_owner: null, lease_until: null,
    finished_at: new Date(mockNow.getTime() - 15 * MIN),
    followthrough_done_at: new Date(mockNow.getTime() - 15 * MIN),
    followthrough_outcome: FT_SKIPPED,
    notice_outcome: { state: 'sent', by: 'request' },
    ...over,
  });
  const action = (result) => mockStore.actions.push({ id: ACTION, result });

  test('the receipt is rebuilt from the stored outcome and the office is told about the skipped step', async () => {
    const row = completed();
    action(null);
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ receipts: 1, failed: 0 });
    expect(mockRecordResult).toHaveBeenCalledTimes(1);
    const [id, result, opts] = mockRecordResult.mock.calls[0];
    expect(id).toBe(ACTION);
    expect(opts).toEqual({ onlyIfEmpty: true });
    expect(result).toMatchObject({ success: true, ran_dispatch_cancel: true, customer_text_sent: true, money_skipped: FT_SKIPPED.money_skipped });
    expect(result.warning).toMatch(/stopped before it saved this result/);
    expect(result.warning).toMatch(/invoice inv-1/);
    expect(mockRaised).toHaveLength(1);
    expect(mockRaised[0].spec.severity).toBe('needs-you');
    expect(row).toMatchObject({ status: 'complete', finish_note: 'request+receipt', lease_owner: null });
    // Nothing is run again: the receipt is the only thing this path touches.
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    // And once marked, a second pass leaves it alone.
    await svc.sweepIbCancelBundles();
    expect(mockRecordResult).toHaveBeenCalledTimes(1);
    expect(mockRaised).toHaveLength(1);
  });

  test('a clean stored outcome saves the receipt and leaves a quiet row, not a bell', async () => {
    completed({ followthrough_outcome: { money_skipped: [], linked_skipped: [] } });
    action(null);
    await svc.sweepIbCancelBundles();
    expect(mockRecordResult.mock.calls[0][1].warning).toBeUndefined();
    expect(mockRaised[0].spec.severity).toBe('fyi');
  });

  test('the request saved its own receipt: nothing is written or alerted, the row is marked checked', async () => {
    const row = completed();
    action({ success: true, warning: 'Money steps skipped: invoice inv-1' });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary.receipts).toBe(0);
    expect(mockRecordResult).not.toHaveBeenCalled();
    expect(mockRaised).toEqual([]);
    expect(row.finish_note).toBe('request+receipt');
  });

  test('a text outcome the request never recorded is reported as uncertain, never as sent', async () => {
    completed({ notice_outcome: null });
    action(null);
    await svc.sweepIbCancelBundles();
    const result = mockRecordResult.mock.calls[0][1];
    expect(result.customer_text_sent).toBe(false);
    expect(result.customer_text_uncertain).toBe(true);
    expect(mockRaised[0].spec.severity).toBe('needs-you');
  });

  test('a card with no text choice needs no text outcome', async () => {
    completed({ notify_customer: false, approved_notice: null, notice_outcome: null, followthrough_outcome: { money_skipped: [], linked_skipped: [] } });
    action(null);
    await svc.sweepIbCancelBundles();
    expect(mockRaised[0].spec.severity).toBe('fyi');
  });

  test('a row the request completed less than 10 minutes ago is left to the request', async () => {
    completed({ finished_at: new Date(mockNow.getTime() - 3 * MIN) });
    action(null);
    const summary = await svc.sweepIbCancelBundles();
    expect(summary.receipts).toBe(0);
    expect(mockRecordResult).not.toHaveBeenCalled();
  });

  test('a row finished by the sweep itself, or past the hard stop, is not reconciled', async () => {
    completed({ id: 'a', finish_note: 'sweep', status: 'recovered', pending_action_id: ACTION });
    completed({ id: 'b', pending_action_id: '00000000-0000-4000-8000-0000000000b2', finished_at: new Date(mockNow.getTime() - 25 * HOUR) });
    action(null);
    mockStore.actions.push({ id: '00000000-0000-4000-8000-0000000000b2', result: null });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary.receipts).toBe(0);
    expect(mockRecordResult).not.toHaveBeenCalled();
  });

  test('a pending action that is gone: marked checked, nothing alerted', async () => {
    const row = completed();
    const summary = await svc.sweepIbCancelBundles();
    expect(summary.receipts).toBe(0);
    expect(mockRaised).toEqual([]);
    expect(row.finish_note).toBe('request+receipt');
  });

  test('an alert failure frees the claim; the retry saves nothing twice and alerts once', async () => {
    const row = completed();
    action(null);
    const composer = require('../services/admin-alert-compose');
    composer.raiseAdminAlert.mockRejectedValueOnce(new Error('alert store down'));
    const first = await svc.sweepIbCancelBundles();
    expect(first.failed).toBe(1);
    expect(row).toMatchObject({ finish_note: 'request', lease_owner: null });
    // The first attempt did save the receipt; it is ours, so the retry still raises the alert and does not rewrite it.
    mockStore.actions[0].result = mockRecordResult.mock.calls[0][1];
    await svc.sweepIbCancelBundles();
    expect(mockRaised).toHaveLength(1);
    expect(row.finish_note).toBe('request+receipt');
  });

  test('two sweeps at once: the second cannot claim the same row', async () => {
    completed();
    action(null);
    let nested = null;
    mockRecordResult.mockImplementationOnce(async () => { nested = await svc.sweepIbCancelBundles(); return true; });
    await svc.sweepIbCancelBundles();
    expect(nested.receipts).toBe(0);
    expect(mockRaised).toHaveLength(1);
  });
});

describe('a receipt or alert that did not save keeps the row retryable', () => {
  const composer = () => require('../services/admin-alert-compose');
  const FT = { money_skipped: [{ kind: 'invoice', id: 'inv-1', reason: 'paid_since_card' }], linked_skipped: [] };
  const cases = {
    recovered: { seed: () => seedBundle(), open: { status: 'pending' }, done: { status: 'recovered' } },
    abandoned: {
      seed: () => { mockStore.visits[0].status = 'confirmed'; return seedBundle(); },
      open: { status: 'pending' }, done: { status: 'abandoned' },
    },
    expired: { seed: () => seedBundle({ attempts: svc.MAX_ATTEMPTS, lease_owner: null, lease_until: null }), open: { status: 'pending' }, done: { status: 'expired' } },
    receipt: {
      seed: () => {
        mockStore.actions.push({ id: ACTION, result: null });
        return seedBundle({
          status: 'complete', finish_note: 'request', lease_owner: null, lease_until: null, finished_at: new Date(mockNow.getTime() - 15 * MIN),
          followthrough_done_at: new Date(mockNow.getTime() - 15 * MIN), followthrough_outcome: FT, notice_outcome: { state: 'sent', by: 'request' },
        });
      },
      open: { status: 'complete', finish_note: 'request' }, done: { status: 'complete', finish_note: 'request+receipt' },
    },
  };

  for (const [name, c] of Object.entries(cases)) {
    test(`${name}: a receipt save that reports failure (false) is not marked finished and is saved on the next pass`, async () => {
      const row = c.seed();
      mockRecordResult.mockResolvedValueOnce(false);
      const first = await svc.sweepIbCancelBundles();
      expect(first.failed).toBe(1);
      expect(row).toMatchObject({ ...c.open, lease_owner: null });
      expect(mockRaised).toEqual([]);
      const second = await svc.sweepIbCancelBundles();
      expect(second.failed).toBe(0);
      expect(row).toMatchObject(c.done);
      expect(mockRaised).toHaveLength(1);
    });

    test(`${name}: an office alert that was not saved (null) is not marked finished and is raised on the next pass`, async () => {
      const row = c.seed();
      composer().raiseAdminAlert.mockResolvedValueOnce(null);
      const first = await svc.sweepIbCancelBundles();
      expect(first.failed).toBe(1);
      expect(row).toMatchObject({ ...c.open, lease_owner: null });
      const second = await svc.sweepIbCancelBundles();
      expect(second.failed).toBe(0);
      expect(row).toMatchObject(c.done);
    });
  }

  test('a deliberately suppressed alert (an object, not null) is a success', async () => {
    const row = seedBundle();
    composer().raiseAdminAlert.mockResolvedValueOnce({ id: null, suppressed: true, reason: 'preference_disabled' });
    expect((await svc.sweepIbCancelBundles()).failed).toBe(0);
    expect(row.status).toBe('recovered');
  });
});

describe('housekeeping and copy', () => {
  test('finished bundles are deleted after 90 days; pending ones never', async () => {
    seedBundle({ id: 'old', status: 'recovered', finished_at: new Date(mockNow.getTime() - 91 * 24 * HOUR), created_at: new Date(mockNow.getTime() - 92 * 24 * HOUR) });
    seedBundle({ id: 'recent', status: 'recovered', finished_at: new Date(mockNow.getTime() - 10 * 24 * HOUR), created_at: new Date(mockNow.getTime() - 11 * 24 * HOUR) });
    seedBundle({ id: 'open', created_at: new Date(mockNow.getTime() - 1 * MIN) });
    await svc.sweepIbCancelBundles();
    expect(mockStore.bundles.map((b) => b.id).sort()).toEqual(['open', 'recent']);
  });

  test('the office alert specs follow docs/admin-notifications.md for a long customer name too', () => {
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    const bundle = { id: 'b', scheduled_service_id: SERVICE };
    const info = { name: 'Bartholomew Maximilian Featherstonehaugh-Cholmondeley', day: '2026-10-30', service: 'Pest Control' };
    for (const review of [true, false]) {
      const spec = svc.alertSpec(bundle, info, {
        review,
        action: review ? (name) => `check ${name}'s cancelled visit` : (name) => `${name}'s cancel finished`,
        why: 'The cancel finished after an interruption, but some approved steps were skipped or unconfirmed.',
      });
      expect(() => composeAdminAlert(spec)).not.toThrow();
      expect(spec.link).toBe('/admin/dispatch?tab=schedule&date=2026-10-30');
    }
  });

  test('classifyNoticeOutcome maps what handleCancellation reports', () => {
    expect(svc.classifyNoticeOutcome({})).toBeNull();
    expect(svc.classifyNoticeOutcome({ notificationSent: true })).toEqual({ state: 'sent' });
    expect(svc.classifyNoticeOutcome({ notificationSent: true, notificationPartial: true, notificationError: 'one blocked' })).toMatchObject({ state: 'partial' });
    expect(svc.classifyNoticeOutcome({ notificationSent: false, notificationUncertain: true })).toMatchObject({ state: 'uncertain' });
    expect(svc.classifyNoticeOutcome({ notificationSent: false, notificationError: 'x' })).toMatchObject({ state: 'not_sent' });
  });
});

describe('the recovery is fenced against a restore of the visit', () => {
  test('the follow-through gets a fence for THIS cancellation: the visit and the instant the bundle was written', async () => {
    seedBundle();
    await svc.sweepIbCancelBundles();
    const { cancelFence } = mockFollowThrough.mock.calls[0][0];
    expect(cancelFence).toEqual({ visitId: SERVICE, restorations: 0, hits: [] });
  });

  test('a mutation refused because the visit was restored mid-recovery abandons the bundle, sends no text, and says steps may have run', async () => {
    seedBundle();
    mockFollowThrough.mockImplementationOnce(async ({ cancelFence }) => {
      mockStore.visits[0].status = 'confirmed';
      mockStore.history.push({ id: 9, job_id: SERVICE, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(mockNow.getTime() - 1000) });
      cancelFence.hits.push('visit_is_confirmed');
    });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ abandoned: 1, recovered: 0, failed: 0 });
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0]).toMatchObject({ status: 'abandoned', followthrough_done_at: null });
    expect(mockStore.bundles[0].finish_note).toBe('visit_is_confirmed_during_recovery');
    expect(mockRaised[0].spec.severity).toBe('needs-you');
    expect(mockRaised[0].opts.detail).toContain('Some steps may already have run');
    expect(mockRecordResult.mock.calls[0][1].warning).toMatch(/stopped/);
  });

  test('a mutation refused only because a restore is in flight (visit busy) saves nothing and retries on the next pass', async () => {
    seedBundle();
    mockFollowThrough.mockImplementationOnce(async ({ cancelFence }) => { cancelFence.hits.push('visit_busy'); });
    const first = await svc.sweepIbCancelBundles();
    expect(first).toMatchObject({ failed: 1, recovered: 0 });
    expect(mockStore.bundles[0]).toMatchObject({ status: 'pending', followthrough_done_at: null, lease_owner: null, attempts: 1 });
    expect(mockRaised).toEqual([]);
    const second = await svc.sweepIbCancelBundles();
    expect(second).toMatchObject({ recovered: 1 });
    expect(mockFollowThrough).toHaveBeenCalledTimes(2);
  });

  test('a restore that lands between the money steps and the text stops the text', async () => {
    seedBundle();
    mockFollowThrough.mockImplementationOnce(async () => {
      mockStore.visits[0].status = 'confirmed';
    });
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ abandoned: 1 });
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0].finish_note).toBe('visit_is_confirmed_during_recovery');
  });
});

describe('a deferred text never holds up other bundles', () => {
  test('past the batch size, the parked bundles are skipped and the newer ones are worked in the next pass', async () => {
    setNow(new Date('2026-10-24T05:00:00Z')); // 1:00 AM ET: the text must wait
    for (let i = 1; i <= 12; i += 1) {
      seedBundle({ id: `b${i}`, pending_action_id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, created_at: new Date(mockNow.getTime() - (60 - i) * MIN), lease_until: new Date(mockNow.getTime() - 30 * MIN) });
    }
    const first = await svc.sweepIbCancelBundles();
    expect(first).toMatchObject({ deferred: 10 });
    expect(mockFollowThrough).toHaveBeenCalledTimes(10);
    const second = await svc.sweepIbCancelBundles();
    // The ten parked bundles are not claimed again; the two newest get their money work now.
    expect(second).toMatchObject({ deferred: 2 });
    expect(mockFollowThrough).toHaveBeenCalledTimes(12);
    expect(mockStore.bundles.every((b) => b.followthrough_done_at && !b.notice_outcome && new Date(b.next_attempt_at) > mockNow)).toBe(true);
    // Morning: every parked text goes, the money work is not repeated.
    setNow(new Date('2026-10-24T13:00:00Z'));
    mockStore.visits[0].scheduled_date = '2026-10-30';
    await svc.sweepIbCancelBundles();
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).toHaveBeenCalledTimes(12);
    expect(mockHandleCancellation).toHaveBeenCalledTimes(12);
    expect(mockStore.bundles.every((b) => b.status === 'recovered')).toBe(true);
  });
});

describe('the generation is a count, never a time comparison', () => {
  test('a restoration that STARTED before the bundle was written but committed after it (an earlier transitioned_at) is still caught', async () => {
    const row = seedBundle({ restorations_seen: 0 });
    // The restore transaction began 5 minutes before the bundle existed; its history row carries that start time.
    mockStore.history.push({ id: 20, job_id: SERVICE, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(row.created_at.getTime() - 5 * MIN) });
    // ...and the visit was then cancelled again by a different cancel.
    mockStore.history.push({ id: 21, job_id: SERVICE, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: new Date(mockNow.getTime() - 1 * MIN) });
    expect(mockStore.visits[0].status).toBe('cancelled');
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockStore.bundles[0]).toMatchObject({ status: 'abandoned', finish_note: 'visit_restored_since' });
  });

  test('restorations that happened BEFORE this cancel were pinned with it and do not stop the recovery', async () => {
    seedBundle({ restorations_seen: 2 });
    mockStore.history.push(
      { id: 30, job_id: SERVICE, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(mockNow.getTime() - 3 * 24 * HOUR) },
      { id: 31, job_id: SERVICE, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: new Date(mockNow.getTime() - 2 * 24 * HOUR) },
    );
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ recovered: 1 });
    expect(mockFollowThrough.mock.calls[0][0].cancelFence).toMatchObject({ restorations: 2 });
  });
});
