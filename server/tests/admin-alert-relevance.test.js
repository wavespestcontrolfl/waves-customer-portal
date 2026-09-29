// Admin alert relevance (owner ruling 2026-09-28: "we don't want garbage"): an
// unread admin bell clears itself when the visit / series move / lead it is
// about has moved on, and a fresh row that has ALREADY moved on is written
// activity-only through notifyAdmin's existing ringGate seam. The rule table is
// deliberately narrow (stale_visit, series_move, new_lead); alerts whose emitter
// re-raises a stable key are the emitter's to clear and must stay untouched.
//
// The fake db below is a thenable knex-chain stub over in-memory mockTables: it
// honors where({..}), whereNull, whereIn, where('id','>',x) and the notification
// writes (insert / first / update) so the real NotificationService and the real
// module run end to end, and it records every query so batching and the
// candidate filter can be asserted. SQL text itself is not executed (Postgres
// suites skip locally). All identities are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: () => false }));
let mockTables;
let mockQueries;
let mockHooks;
let mockFailTable;
let mockTrxs;
jest.mock('../models/db', () => {
  const strip = (col) => String(col).split('.').pop();
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
  // Key-order-free JSON, like jsonb equality.
  const canon = (v) => (v && typeof v === 'object'
    ? (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`)
    : JSON.stringify(v ?? null));
  const builder = (table) => {
    const conds = [];
    const q = { table, calls: [] };
    let cap = null;
    const b = {};
    for (const m of ['select', 'leftJoin', 'orderBy', 'groupBy', 'max', 'whereNotIn', 'forShare', 'forUpdate']) {
      b[m] = (...args) => { q.calls.push([m, ...args]); return b; };
    }
    b.limit = (n) => { cap = n; q.calls.push(['limit', n]); return b; };
    b.modify = (fn) => { fn(b); return b; };
    b.where = (...args) => {
      q.calls.push(['where', ...args]);
      if (args.length === 1 && args[0] && typeof args[0] === 'object') Object.entries(args[0]).forEach(([k, v]) => conds.push((r) => r[k] === v));
      if (args.length === 2 && typeof args[0] === 'string') conds.push((r) => r[strip(args[0])] === args[1]);
      if (args.length === 3 && args[0] === 'id' && args[1] === '>') conds.push((r) => String(r.id) > String(args[2]));
      return b;
    };
    b.whereNull = (col) => { q.calls.push(['whereNull', col]); conds.push((r) => r[col] == null); return b; };
    b.whereIn = (col, ids) => { q.calls.push(['whereIn', col, ids]); conds.push((r) => ids.includes(String(r[strip(col)]))); return b; };
    b.whereRaw = (sql, args = []) => {
      q.calls.push(['whereRaw', sql, args]);
      const text = String(sql);
      const meta = (r) => (r.metadata == null ? null : parse(r.metadata));
      if (text.startsWith("metadata->>'dedupeKey' =")) conds.push((r) => parse(r.metadata).dedupeKey === args[0]);
      // The retire's version fence and its own-stamp match.
      if (text === 'link IS NOT DISTINCT FROM ?') conds.push((r) => (r.link ?? null) === (args[0] ?? null));
      if (text === 'metadata IS NOT DISTINCT FROM ?::jsonb') conds.push((r) => canon(meta(r)) === canon(args[0] == null ? null : JSON.parse(args[0])));
      if (text === "metadata->'retired'->>'at' = ?") conds.push((r) => meta(r)?.retired?.at === args[0]);
      // The candidate query's bell-visible filter.
      if (text === "COALESCE(metadata->>'feed', '') <> 'activity'") conds.push((r) => meta(r)?.feed !== 'activity');
      return b;
    };
    const hit = () => (mockTables[table] || []).filter((r) => conds.every((c) => c(r)));
    b.first = async () => {
      mockQueries.push(q);
      if (mockHooks[`${table}:first`]) mockHooks[`${table}:first`]();
      return hit()[0] || null;
    };
    b.update = (patch) => {
      let applied = null;
      const apply = () => {
        if (applied) return applied;
        mockQueries.push(q);
        applied = hit();
        applied.forEach((r) => {
          const { metadata, ...rest } = patch;
          Object.assign(r, rest);
          if (metadata && metadata.__raw && /- 'retired'/.test(metadata.__raw)) {
            const { retired: _dropped, ...kept } = parse(r.metadata);
            r.metadata = JSON.stringify({ ...kept, ...(metadata.bindings?.[0] ? JSON.parse(metadata.bindings[0]) : {}) });
          } else if (metadata && metadata.__raw) r.metadata = JSON.stringify({ ...parse(r.metadata), ...JSON.parse(metadata.bindings[0]) });
          else if (metadata !== undefined) r.metadata = metadata;
        });
        return applied;
      };
      const done = Promise.resolve().then(() => apply().length);
      done.returning = async () => apply().map((r) => ({ id: r.id, read_at: r.read_at }));
      return done;
    };
    b.insert = (row) => ({
      returning: async () => {
        const created = { id: `00000000-0000-4000-8000-9${String((mockTables[table] ||= []).length).padStart(11, '0')}`, ...row };
        mockTables[table].push(created);
        return [created];
      },
    });
    b.then = (res, rej) => {
      mockQueries.push(q);
      return Promise.resolve().then(() => {
        if (mockFailTable === table) throw new Error(`boom:${table}`);
        if (mockHooks[table]) mockHooks[table]();
        const rows = hit();
        return cap ? rows.sort((a, c) => String(a.id).localeCompare(String(c.id))).slice(0, cap) : rows;
      }).then(res, rej);
    };
    return b;
  };
  const fn = jest.fn((table) => builder(table));
  fn.fn = { now: () => 'NOW' };
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  const makeTrx = () => {
    const trx = jest.fn((table) => builder(table));
    trx.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
    trx.fn = fn.fn;
    trx.transaction = jest.fn(async (cb) => cb(trx));
    trx.isTransaction = true;
    mockTrxs.push(trx);
    return trx;
  };
  fn.transaction = jest.fn(async (cb) => cb(makeTrx()));
  return fn;
});

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const {
  runAdminAlertRelevanceSweep, classify, loadSubjects, subjectFor, refsFromRow, ringTimeCheck,
} = require('../services/admin-alert-relevance');
const { adminAlertRelevanceLive } = require('../config/feature-gates');

const TODAY = '2026-09-28';
const NOW = new Date('2026-09-28T16:00:00Z');
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = uid(1);
const VISIT = uid(2);
const PARENT = uid(3);
const INV = uid(4);
const EST = uid(6);
const LEAD = uid(7);
const OPEN_VISIT = uid(9);

let seq = 0;
const note = (over = {}) => ({
  id: uid(100 + (seq += 1)), recipient_type: 'admin', read_at: null, created_at: new Date('2026-09-27T12:00:00Z'),
  link: null, ...over, metadata: JSON.stringify(over.metadata || {}),
});
const visit = (over = {}) => ({ id: VISIT, customer_id: CUST, status: 'pending', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ADMIN_ALERT_RELEVANCE;
  mockTables = { notifications: [], scheduled_services: [], 'scheduled_services as ss': [], leads: [], estimates: [] };
  mockQueries = [];
  mockHooks = {};
  mockFailTable = null;
  mockTrxs = [];
});

// The reason a row's class gives against the current fake mockTables (null = still relevant).
async function reasonFor(row) {
  const cls = classify(row);
  if (!cls) return { cls: null, reason: null };
  const data = await loadSubjects([row]);
  return { cls: cls.key, reason: cls.rule(subjectFor(row, data, TODAY)) || null };
}

const staleNote = (id, over = {}) => note({ id, category: 'alert', metadata: { dedupeKey: `stale-visit:${id}`, scheduled_service_id: VISIT, customer_id: CUST, ...over } });
const leadNote = (extra = {}) => note({
  category: 'new_lead', link: `/admin/leads?lead=${LEAD}`, metadata: { triggerKey: 'new_lead', payload: { leadId: LEAD }, ...extra },
});
const lead = (over = {}) => ({ id: LEAD, status: 'new', converted_at: null, deleted_at: null, created_at: new Date('2026-09-27T10:00:00Z'), customer_id: CUST, estimate_id: null, ...over });

describe('kill switch', () => {
  test.each([[undefined, true], ['', true], ['on', true], ['true', true], ['off', false], ['OFF', false], [' False ', false], ['0', false], ['false', false]])(
    'ADMIN_ALERT_RELEVANCE=%j -> live=%s', (value, live) => {
      if (value === undefined) delete process.env.ADMIN_ALERT_RELEVANCE; else process.env.ADMIN_ALERT_RELEVANCE = value;
      expect(adminAlertRelevanceLive()).toBe(live);
    });
});

describe('subject references are parsed defensively', () => {
  test('metadata keys, payload and link params all resolve; bad ids never throw', () => {
    const refs = refsFromRow(note({
      link: `/admin/dispatch?tab=schedule&appointment=${VISIT}&invoice=${INV}&estimateId=${EST}&lead=${LEAD}&customerId=${CUST}`,
      metadata: { conflicts: [{ id: PARENT, date: '2026-10-12' }, { id: 'not-a-uuid' }, null], preservedOccurrences: [{ id: 42 }, null] },
    }));
    expect(refs).toMatchObject({ visitId: VISIT, estimateId: EST, leadId: LEAD });
    expect(refs.visitIds).toEqual([VISIT, PARENT]);
    // Customers and invoices are not subjects of any class in the table.
    expect(refs).not.toHaveProperty('customerId');
    expect(refs).not.toHaveProperty('invoiceIds');
    expect(refsFromRow(note({ metadata: { payload: { leadId: LEAD, customerId: CUST } } }))).toMatchObject({ leadId: LEAD });
    const junk = refsFromRow({ link: 'http://[bad', metadata: '{not json', category: 'alert' });
    expect(junk).toMatchObject({ visitId: null, estimateId: null, leadId: null, visitIds: [] });
    expect(refsFromRow({ metadata: { scheduledServiceId: ['x'], estimateId: { $ne: 1 } } })).toMatchObject({ visitId: null, estimateId: null });
  });

  test('a batch reads each table once, and a row with only bad ids reads nothing', async () => {
    mockTables['scheduled_services as ss'] = [visit(), visit({ id: PARENT })];
    mockTables.leads = [lead({ estimate_id: EST })];
    mockTables.estimates = [{ id: EST, status: 'draft', archived_at: null, sent_at: null, customer_id: CUST }];
    await loadSubjects([
      note({ category: 'alert', metadata: { dedupeKey: 'stale-visit:a', scheduled_service_id: VISIT } }),
      note({ category: 'alert', metadata: { dedupeKey: 'stale-visit:b', scheduled_service_id: PARENT } }),
      leadNote(),
      note({ category: 'billing', metadata: { invoiceId: INV } }),
    ]);
    const counts = mockQueries.reduce((a, q) => ({ ...a, [q.table]: (a[q.table] || 0) + 1 }), {});
    // Visits, leads, the lead's estimate, and the lead customer's latest booked visit.
    expect(counts).toEqual({ 'scheduled_services as ss': 1, leads: 1, estimates: 1, scheduled_services: 1 });
    mockQueries = [];
    await loadSubjects([note({ metadata: { scheduledServiceId: 'nope', customerId: 'nope' } })]);
    expect(mockQueries).toEqual([]);
  });
});

describe('class rules', () => {
  test.each([
    ['unpriced-series:', 'alert', { series_root_id: PARENT }],
    ['prepay-coverage:', 'alert', {}],
    ['accepted-schedule:', 'alert', { estimate_id: EST }],
    ['first_application_sibling_divergence:', 'billing', { alertKind: 'diverged', invoiceId: INV, stampedInvoiceId: INV }],
    ['estimate_hot_view:', 'estimate_hot_view', { estimateId: EST }],
  ])('%s rows are their emitter\'s to clear: not classified, and the sweep never touches them', async (prefix, category, extra) => {
    const row = note({ category, metadata: { dedupeKey: `${prefix}${VISIT}:x`, scheduled_service_id: VISIT, customer_id: CUST, ...extra } });
    expect(classify(row)).toBeNull();
    // Even with every record it names closed or gone, nothing here retires it.
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.estimates = [{ id: EST, status: 'accepted', archived_at: new Date(), sent_at: null, customer_id: CUST }];
    mockTables.notifications = [row];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0, byClass: {} });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('stale visit: retires only when its visit is closed, never-ran or gone — nothing about the customer', async () => {
    const row = staleNote(uid(400));
    mockTables['scheduled_services as ss'] = [visit({ status: 'on_site' })];
    expect(await reasonFor(row)).toEqual({ cls: 'stale_visit', reason: null });
    for (const status of ['completed', 'cancelled', 'skipped']) {
      mockTables['scheduled_services as ss'] = [visit({ status })];
      expect((await reasonFor(row)).reason).toEqual(expect.stringContaining('no longer open'));
    }
    // The visit row is gone.
    mockTables['scheduled_services as ss'] = [];
    expect((await reasonFor(row)).reason).toEqual(expect.stringContaining('no longer open'));
    // A rescheduled visit is still open; a bell that names no visit is never judged closed.
    mockTables['scheduled_services as ss'] = [visit({ status: 'rescheduled' })];
    expect((await reasonFor(row)).reason).toBeNull();
    expect((await reasonFor(note({ category: 'alert', metadata: { dedupeKey: 'stale-visit:z' } }))).reason).toBeNull();
  });

  const move = (metadata = {}) => note({
    category: 'schedule_conflict', link: '/admin/dispatch?tab=schedule',
    metadata: { scheduledServiceId: VISIT, seriesMoveId: 'move-1', conflicts: [], overlapDates: ['2026-10-05'], preservedOccurrences: [], ...metadata },
  });

  test('series move: relevant while any flagged date is today or later', async () => {
    mockTables['scheduled_services as ss'] = [visit()];
    expect(await reasonFor(move())).toEqual({ cls: 'series_move', reason: null });
    expect((await reasonFor(move({ overlapDates: ['2026-09-20'], conflicts: [{ id: VISIT, date: '2026-09-28' }] }))).reason).toBeNull();
  });

  test('series move: every overlap / conflict / preserved date in the past (Eastern), or every visit it named closed — never the customer leaving', async () => {
    mockTables['scheduled_services as ss'] = [visit()];
    expect((await reasonFor(move({ overlapDates: ['2026-09-20', '2026-09-27'], conflicts: [{ id: VISIT, date: '2026-09-01' }], preservedOccurrences: [{ date: '2026-08-01' }] }))).reason)
      .toEqual(expect.stringContaining('passed'));
    mockTables['scheduled_services as ss'] = [visit({ status: 'cancelled' })];
    expect((await reasonFor(move({ overlapDates: [], conflicts: [{ id: VISIT, date: '2026-10-05' }] }))).reason).toEqual(expect.stringContaining('closed'));
    // Never on the customer's account: the card is written once per move, and only the visits and dates decide it.
    mockTables['scheduled_services as ss'] = [visit()];
    expect((await reasonFor(move())).reason).toBeNull();
  });

  test('series move: a card with an overlap date names only the moved visit, not the sibling on that date — closing every visit it names keeps it until the date passes', async () => {
    const overlapping = move({ overlapDates: ['2026-10-05'], conflicts: [{ id: PARENT, date: '2026-10-12' }] });
    mockTables['scheduled_services as ss'] = [visit({ status: 'cancelled' }), visit({ id: PARENT, status: 'cancelled' })];
    expect((await reasonFor(overlapping)).reason).toBeNull();
    expect((await reasonFor(move({ overlapDates: ['2026-09-20'], conflicts: [{ id: PARENT, date: '2026-09-21' }] }))).reason).toEqual(expect.stringContaining('passed'));
  });

  test('series move: cancelling only the moved visit keeps the alert while a conflict or preserved occurrence it named is still open', async () => {
    const named = move({ overlapDates: [], conflicts: [{ id: PARENT, date: '2026-10-12' }], preservedOccurrences: [{ id: OPEN_VISIT, date: '2026-11-09' }] });
    mockTables['scheduled_services as ss'] = [visit({ status: 'cancelled' }), visit({ id: PARENT, status: 'pending' }), visit({ id: OPEN_VISIT, status: 'completed' })];
    expect((await reasonFor(named)).reason).toBeNull();
    mockTables['scheduled_services as ss'] = [visit({ status: 'cancelled' }), visit({ id: PARENT, status: 'cancelled' }), visit({ id: OPEN_VISIT, status: 'completed' })];
    expect((await reasonFor(named)).reason).toEqual(expect.stringContaining('closed'));
  });

  test('a schedule_conflict row that is not a series move is not in the table', () => {
    expect(classify(note({ category: 'schedule_conflict', metadata: { scheduledServiceId: VISIT } }))).toBeNull();
  });

  test.each([
    ['new', false], ['contacted', false], ['open', false], ['qualified', false],
    ['estimate_sent', true], ['estimate_viewed', true], ['won', true], ['lost', true], ['duplicate', true], ['spam', true], ['unresponsive', true], ['disqualified', true],
  ])('new lead: status %s -> retired=%s', async (status, retired) => {
    mockTables.leads = [lead({ status })];
    expect((await reasonFor(leadNote())).reason !== null).toBe(retired);
  });

  test('new lead: deleted, converted, estimate sent, or a visit booked after it was created retires it; anything earlier or unknown does not', async () => {
    mockTables.leads = [lead({ deleted_at: new Date() })];
    expect((await reasonFor(leadNote())).reason).toEqual(expect.stringContaining('deleted'));
    mockTables.leads = [lead({ converted_at: new Date() })];
    expect((await reasonFor(leadNote())).reason).toEqual(expect.stringContaining('converted'));
    mockTables.leads = [lead({ estimate_id: EST })];
    mockTables.estimates = [{ id: EST, status: 'sent', archived_at: null, sent_at: new Date(), customer_id: CUST }];
    expect((await reasonFor(leadNote())).reason).toEqual(expect.stringContaining('Estimate'));
    mockTables.estimates = [{ id: EST, status: 'draft', archived_at: null, sent_at: null, customer_id: CUST }];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    mockTables.leads = [lead()];
    mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: new Date('2026-09-27T15:00:00Z') }];
    expect((await reasonFor(leadNote())).reason).toEqual(expect.stringContaining('visit'));
    mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: new Date('2026-09-20T15:00:00Z') }];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // A child the system generated on its own (series top-up, seeded follow-up)
    // after the lead is not a booking anyone made for it.
    mockTables.scheduled_services = [
      { customer_id: CUST, latest_created_at: new Date('2026-09-27T15:00:00Z'), recurring_parent_id: VISIT },
      { customer_id: CUST, latest_created_at: new Date('2026-09-27T16:00:00Z'), parent_service_id: VISIT },
    ];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // Degraded emitter path: leadId is really a customer id, no lead row -> unknown, never "deleted".
    mockTables.leads = [];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // Lead id from the link alone.
    mockTables.leads = [lead({ status: 'won' })];
    expect((await reasonFor(note({ category: 'new_lead', link: `/admin/leads?lead=${LEAD}` }))).cls).toBe('new_lead');
    expect(classify(note({ category: 'new_lead', link: '/admin/leads' }))).toBeNull();
  });

  test('customer-contact bells and money-owed alerts are never in the table, whatever their metadata says', () => {
    const lookalike = { customerId: CUST, invoiceId: INV, scheduled_service_id: VISIT, alertKind: 'diverged', seriesMoveId: 'm', estimateId: EST, payload: { leadId: LEAD } };
    for (const category of ['inbound_sms', 'inbound_email', 'missed_call', 'voicemail_callback', 'review', 'payment', 'payment_failed', 'refund', 'dispute', 'system']) {
      for (const dedupeKey of [null, 'unpriced-series:x', 'stale-visit:x', 'prepay-coverage:x', 'accepted-schedule:x', 'first_application_sibling_divergence:x']) {
        expect(classify(note({ category, metadata: { ...lookalike, ...(dedupeKey ? { dedupeKey } : {}) } }))).toBeNull();
      }
    }
    // Same categories the classes use, but another emitter's dedupe key.
    expect(classify(note({ category: 'billing', metadata: { dedupeKey: 'payment-failed:x', alertKind: 'diverged' } }))).toBeNull();
    expect(classify(note({ category: 'alert', metadata: { dedupeKey: 'sms-commitment:x' } }))).toBeNull();
  });
});

describe('pushIsMovedOn (the push verdict for the trigger dispatcher)', () => {
  const { pushIsMovedOn } = require('../services/admin-alert-relevance');
  const leadEvent = { category: 'new_lead', link: null, metadata: { triggerKey: 'new_lead', payload: { leadId: LEAD } } };
  const leadRow = (over = {}) => ({ id: LEAD, status: 'new', converted_at: null, deleted_at: null, created_at: new Date('2026-09-28T12:00:00Z'), customer_id: CUST, estimate_id: null, ...over });

  test('a bell row written activity-only at ring time stays silent; a rung or sweep-retired row pushes', async () => {
    const quiet = { metadata: { feed: 'activity', quiet: true, retired: { by: 'alert-relevance', reason: 'x' } } };
    expect(await pushIsMovedOn({ bellRow: quiet, bellWritten: true, pushTo: ['a'], ...leadEvent })).toBe(true);
    expect(await pushIsMovedOn({ bellRow: { metadata: { retired: { by: 'alert-relevance' } } }, bellWritten: true, pushTo: ['a'], ...leadEvent })).toBe(false);
    expect(await pushIsMovedOn({ bellRow: { metadata: JSON.stringify({ triggerKey: 'new_lead' }) }, bellWritten: true, pushTo: ['a'], ...leadEvent })).toBe(false);
  });

  test('push-only (no bell row): judged directly — a worked lead stays silent, a new one pushes, nobody to push or the switch off never reads', async () => {
    mockTables.leads = [leadRow({ status: 'won' })];
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], ...leadEvent })).toBe(true);
    mockTables.leads = [leadRow()];
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], ...leadEvent })).toBe(false);
    db.mockClear();
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: [], ...leadEvent })).toBe(false);
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    mockTables.leads = [leadRow({ status: 'won' })];
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], ...leadEvent })).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('a failed read fails open (pushes); an event outside the table is never judged', async () => {
    mockTables.leads = [leadRow({ status: 'won' })];
    mockFailTable = 'leads';
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], ...leadEvent })).toBe(false);
    mockFailTable = null;
    expect(await pushIsMovedOn({ bellRow: null, bellWritten: false, pushTo: ['a'], category: 'inbound_sms', metadata: { customerId: CUST } })).toBe(false);
  });
});

describe('runAdminAlertRelevanceSweep', () => {
  // Reads of the visits table, in order: 1 = the batch, 2 = the fresh read
  // before the write, 3 = the final judgement after it. The hook runs before
  // the read it counts, so a change made on read N is seen by read N.
  const onVisitRead = (fn) => {
    let reads = 0;
    mockHooks['scheduled_services as ss'] = () => { reads += 1; fn(reads); };
  };

  test('retires only unread matching rows whose subject moved on; stamps the reason and touches nothing else', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' }), visit({ id: OPEN_VISIT, status: 'on_site' })];
    mockTables.leads = [lead({ status: 'won' })];
    const staleMeta = { dedupeKey: `stale-visit:${uid(501)}`, dedupeVersion: 'fp::g2', autoCleared: false, recurrenceGeneration: 2, scheduled_service_id: VISIT, customer_id: CUST };
    const stale = note({ id: uid(501), category: 'alert', metadata: staleMeta });
    const leadRow = { ...leadNote(), id: uid(502) };
    const leadBefore = JSON.parse(leadRow.metadata);
    const alreadyRead = { ...staleNote(uid(503)), read_at: new Date('2026-09-27T13:00:00Z') };
    const stillOpen = staleNote(uid(504), { scheduled_service_id: OPEN_VISIT });
    const contact = note({ id: uid(505), category: 'inbound_sms', metadata: { customerId: CUST } });
    mockTables.notifications = [stale, leadRow, alreadyRead, stillOpen, contact];

    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 4, retired: 2, byClass: { stale_visit: 1, new_lead: 1 } });
    expect(stale.read_at).toBeInstanceOf(Date);
    // Pure read + retired marker: every emitter-owned key survives as it was,
    // dedupe key included.
    expect(JSON.parse(stale.metadata)).toEqual({ ...staleMeta, retired: { by: 'alert-relevance', reason: 'Visit is no longer open', at: NOW.toISOString() } });
    expect(leadRow.read_at).toBeInstanceOf(Date);
    expect(JSON.parse(leadRow.metadata)).toEqual({ ...leadBefore, retired: { by: 'alert-relevance', reason: 'Lead is won', at: NOW.toISOString() } });
    expect(alreadyRead.read_at).toEqual(new Date('2026-09-27T13:00:00Z'));
    expect(JSON.parse(alreadyRead.metadata).retired).toBeUndefined();
    for (const untouched of [stillOpen, contact]) { expect(untouched.read_at).toBeNull(); expect(JSON.parse(untouched.metadata).retired).toBeUndefined(); }
  });

  test('the candidate query is unread, admin and bell-visible, with no age cut-off (a refreshed bell keeps its first created_at)', async () => {
    mockTables.notifications = [];
    await runAdminAlertRelevanceSweep({ now: NOW });
    const q = mockQueries.find((x) => x.table === 'notifications');
    const flat = JSON.stringify(q.calls);
    expect(q.calls).toEqual(expect.arrayContaining([['where', { recipient_type: 'admin' }], ['whereNull', 'read_at']]));
    expect(flat).toContain("metadata->>'feed'");
    expect(flat).not.toContain('created_at');
  });

  test('an unread bell first raised months ago (then re-rung by a refresh) is still judged and retired', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const old = { ...staleNote(uid(540)), created_at: new Date('2026-06-01T12:00:00Z') };
    mockTables.notifications = [old];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 1 });
    expect(old.read_at).toBeInstanceOf(Date);
  });

  test('the retirement is judged on a fresh read: a visit that reopens after the batch read keeps the stale-visit alert ringing', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(550));
    mockTables.notifications = [row];
    onVisitRead((n) => { if (n === 2) mockTables['scheduled_services as ss'][0].status = 'on_site'; });
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('a change that lands between the write and the final judgement puts the bell back exactly as it was', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(551));
    const before = JSON.parse(row.metadata);
    mockTables.notifications = [row];
    onVisitRead((n) => { if (n === 3) mockTables['scheduled_services as ss'][0].status = 'on_site'; });
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata)).toEqual(before);
  });

  test('the put-back also holds for a lead reopened in that window', async () => {
    mockTables.leads = [lead({ status: 'won' })];
    const row = leadNote();
    const before = JSON.parse(row.metadata);
    mockTables.notifications = [row];
    let leadReads = 0;
    mockHooks.leads = () => { leadReads += 1; if (leadReads === 3) mockTables.leads[0].status = 'contacted'; };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata)).toEqual(before);
  });

  test('the retire writes an explicit millisecond read_at (never NOW(), whose microseconds a read-back would lose) and the put-back matches it exactly', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(557));
    mockTables.notifications = [row];
    const retireWrites = [];
    onVisitRead((n) => {
      if (n === 3) { retireWrites.push(row.read_at); mockTables['scheduled_services as ss'][0].status = 'on_site'; }
    });
    await runAdminAlertRelevanceSweep({ now: NOW });
    expect(retireWrites[0]).toBeInstanceOf(Date);
    expect(retireWrites[0]).not.toBe('NOW');
    expect(row.read_at).toBeNull(); // put back by an exact read_at match
  });

  test('a person who reads the bell in that window keeps their read: nothing is put back over it', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(552));
    mockTables.notifications = [row];
    const theirRead = new Date('2026-09-28T16:00:01Z');
    onVisitRead((n) => {
      if (n === 3) { mockTables['scheduled_services as ss'][0].status = 'on_site'; row.read_at = theirRead; }
    });
    await runAdminAlertRelevanceSweep({ now: NOW });
    expect(row.read_at).toBe(theirRead);
  });

  test('no row locks anywhere: the sweep never takes FOR SHARE / FOR UPDATE (invoice settlement takes the visit FOR UPDATE NOWAIT)', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.leads = [lead({ status: 'won' })];
    mockTables.notifications = [staleNote(uid(553)), { ...leadNote(), id: uid(554) }];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ retired: 2 });
    expect(mockQueries.some((q) => q.calls.some(([m]) => m === 'forShare' || m === 'forUpdate'))).toBe(false);
  });

  test('a row a refresh rewrote after the batch read is left for the next sweep', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(560));
    mockTables.notifications = [row];
    onVisitRead((n) => {
      if (n === 1) mockTables.notifications[0] = { ...row, metadata: JSON.stringify({ ...JSON.parse(row.metadata), dedupeVersion: 'refreshed' }) };
    });
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(mockTables.notifications[0].read_at).toBeNull();
  });

  test('switch off: no reads, no writes, nothing retired', async () => {
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.notifications = [staleNote(uid(510))];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toEqual({ skipped: true, reason: 'switch_off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockTables.notifications[0].read_at).toBeNull();
  });

  test('a row a person reads mid-sweep is never touched', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(520));
    mockTables.notifications = [row];
    const readAt = new Date('2026-09-28T15:59:00Z');
    onVisitRead((n) => { if (n === 1) row.read_at = readAt; });
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toMatchObject({ scanned: 1, retired: 0, byClass: {} });
    expect(row.read_at).toBe(readAt);
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('pages through more unread rows than one page and keeps every read per-page batched', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.notifications = Array.from({ length: 205 }, (_v, i) => staleNote(uid(1000 + i)));
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toMatchObject({ scanned: 205, retired: 205 });
    expect(mockTables.notifications.every((r) => r.read_at instanceof Date)).toBe(true);
    // The batched first pass reads visits once per page; each retirement then
    // judges its row on a fresh read before the write and once after it.
    expect(mockQueries.filter((q) => q.table === 'scheduled_services as ss')).toHaveLength(2 + 205 * 2);
  });

  test('one unreadable row is skipped, not fatal', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const good = staleNote(uid(530));
    const odd = { ...note({ category: 'alert' }), id: uid(529), metadata: { dedupeKey: 'stale-visit:odd', scheduled_service_id: {} } };
    mockTables.notifications = [odd, good];
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result.retired).toBe(1);
    expect(good.read_at).toBeInstanceOf(Date);
  });

  test('a refresh that rewrote the bell between the fresh read and the write keeps it ringing: the retire lands only on the version it judged', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' }), visit({ id: OPEN_VISIT, status: 'on_site' })];
    const row = staleNote(uid(570));
    mockTables.notifications = [row];
    const refreshed = { ...JSON.parse(row.metadata), scheduled_service_id: OPEN_VISIT, dedupeVersion: 'refreshed' };
    // During the fresh verdict's own visit read (the 2nd), the emitter's
    // refresh rewrites the same row onto a visit that is still open.
    onVisitRead((n) => { if (n === 2) row.metadata = JSON.stringify(refreshed); });
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata)).toEqual(refreshed);
  });

  test('a quiet refresh after the write is judged as it stands: the final verdict reads the bell again and puts it back when the new content has not moved on', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(571));
    mockTables.notifications = [row];
    const refreshed = { ...JSON.parse(row.metadata), scheduled_service_id: OPEN_VISIT, dedupeVersion: 'refreshed' };
    let reads = 0;
    // 1st read: the fresh read before the write. 2nd: the read after it — a
    // quiet refresh (read_at untouched, the stamp merged in) lands just before,
    // onto a visit that is still open.
    mockHooks['notifications:first'] = () => {
      reads += 1;
      if (reads === 2) {
        row.metadata = JSON.stringify({ ...refreshed, retired: JSON.parse(row.metadata).retired });
        mockTables['scheduled_services as ss'].push(visit({ id: OPEN_VISIT, status: 'on_site' }));
      }
    };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect(row.read_at).toBeNull();
    expect(JSON.parse(row.metadata)).toEqual(refreshed);
  });
});

describe('ring time, through the existing ringGate seam', () => {
  const raise = (opts = {}) => NotificationService.notifyAdmin('new_lead', 'New lead', 'body', {
    link: `/admin/leads?lead=${LEAD}`, ...opts, metadata: { triggerKey: 'new_lead', payload: { leadId: LEAD } },
  });
  const stored = () => mockTables.notifications.map((r) => JSON.parse(r.metadata));

  test('a fresh row whose lead was already worked lands activity-only with the retired stamp (never skipped, never rung)', async () => {
    mockTables.leads = [lead({ status: 'won' })];
    const created = await raise();
    expect(created.id).toEqual(expect.any(String));
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ quiet: true, feed: 'activity', retired: { by: 'alert-relevance', reason: expect.stringContaining('won'), at: expect.any(String) } });
    expect(stored()[0].rungAt).toBeUndefined();
    expect(mockTables.notifications[0].read_at).toBeUndefined();
  });

  test('a series-move card whose flagged dates have all passed lands activity-only too', async () => {
    await NotificationService.notifyAdmin('schedule_conflict', 'Series moved', 'body', {
      link: '/admin/dispatch?tab=schedule', metadata: { seriesMoveId: 'move-1', overlapDates: ['2020-01-05'], conflicts: [], preservedOccurrences: [] },
    });
    expect(stored()[0]).toMatchObject({ quiet: true, feed: 'activity', retired: { by: 'alert-relevance', reason: expect.stringContaining('passed') } });
  });

  test('a lead still being worked rings as before (rungAt stamped, no quiet)', async () => {
    mockTables.leads = [lead()];
    await raise();
    expect(stored()[0]).toMatchObject({ rungAt: expect.any(String) });
    expect(stored()[0].quiet).toBeUndefined();
    expect(stored()[0].retired).toBeUndefined();
  });

  test('switch off = today\'s behavior: a plain insert, no subject reads, no transaction', async () => {
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    mockTables.leads = [lead({ status: 'won' })];
    await raise();
    expect(stored()[0].quiet).toBeUndefined();
    expect(mockQueries.filter((q) => ['leads', 'scheduled_services as ss', 'estimates'].includes(q.table))).toEqual([]);
    expect(mockTrxs).toHaveLength(0);
  });

  test('a caller that passes its own ringGate keeps it — the relevance check never overrides it', async () => {
    mockTables.leads = [lead({ status: 'won' })];
    await raise({ ringGate: async () => true });
    expect(stored()[0]).toMatchObject({ rungAt: expect.any(String) });
    expect(stored()[0].retired).toBeUndefined();
  });

  test('a row outside the class table takes the untouched plain path (no subject reads)', async () => {
    mockTables.leads = [lead({ status: 'won' })];
    await NotificationService.notifyAdmin('service', 'Something else', 'body', { dedupeKey: 'other:1', metadata: { customerId: CUST, payload: { leadId: LEAD } } });
    expect(stored()[0]).toEqual({ dedupeKey: 'other:1', customerId: CUST, payload: { leadId: LEAD } });
    expect(mockQueries.filter((q) => q.table === 'leads')).toEqual([]);
  });

  test('a failed subject read rings (fail open) on a savepoint, never aborting the caller\'s transaction', async () => {
    mockFailTable = 'leads';
    await raise();
    expect(stored()[0]).toMatchObject({ rungAt: expect.any(String) });
    expect(stored()[0].quiet).toBeUndefined();
    // The read ran inside a nested transaction (savepoint) on the insert's own transaction.
    expect(mockTrxs).toHaveLength(1);
    expect(mockTrxs[0].transaction).toHaveBeenCalledTimes(1);
  });

  test('ringTimeCheck is null when the switch is off or the row is not in the table', () => {
    expect(ringTimeCheck({ category: 'inbound_sms', metadata: {} })).toBeNull();
    expect(ringTimeCheck({ category: 'billing', metadata: { dedupeKey: 'first_application_sibling_divergence:x' } })).toBeNull();
    expect(ringTimeCheck({ category: 'new_lead', link: `/admin/leads?lead=${LEAD}`, metadata: {} })).not.toBeNull();
    process.env.ADMIN_ALERT_RELEVANCE = '0';
    expect(ringTimeCheck({ category: 'new_lead', link: `/admin/leads?lead=${LEAD}`, metadata: { payload: { leadId: LEAD } } })).toBeNull();
  });
});
