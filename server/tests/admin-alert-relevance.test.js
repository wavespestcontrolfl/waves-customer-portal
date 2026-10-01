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
    // Values compare like Postgres: a Date by its instant, not its identity.
    const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
    b.where = (...args) => {
      q.calls.push(['where', ...args]);
      if (args.length === 1 && args[0] && typeof args[0] === 'object') Object.entries(args[0]).forEach(([k, v]) => conds.push((r) => same(r[k], v)));
      if (args.length === 2 && typeof args[0] === 'string') conds.push((r) => same(r[strip(args[0])], args[1]));
      if (args.length === 3 && args[0] === 'id' && args[1] === '>') conds.push((r) => String(r.id) > String(args[2]));
      return b;
    };
    b.whereNull = (col) => { q.calls.push(['whereNull', col]); conds.push((r) => r[col] == null); return b; };
    b.whereNotNull = (col) => { q.calls.push(['whereNotNull', col]); conds.push((r) => r[col] != null); return b; };
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
      // The candidate query leaves a row this module already retired alone.
      if (text === "metadata->'retired' IS NULL") conds.push((r) => meta(r)?.retired == null);
      // The re-arm pass: this module's stamp, inside the window (ISO text order).
      if (text === "metadata->'retired'->>'by' = ?") conds.push((r) => meta(r)?.retired?.by === args[0]);
      if (text === "metadata->'retired'->>'at' > ?") conds.push((r) => meta(r)?.retired?.at != null && String(meta(r).retired.at) > args[0]);
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
          // Column raws as Postgres would evaluate them against the row's own
          // values: doneColumns' keepExisting COALESCEs and the put-back's CASE.
          const resolved = Object.fromEntries(Object.entries(rest).map(([col, v]) => {
            if (!v || typeof v !== 'object' || !v.__raw) return [col, v];
            const sql = String(v.__raw);
            if (/^COALESCE\(\w+, \?(::timestamptz)?\)$/.test(sql)) return [col, r[col] ?? v.bindings[0]];
            if (/^CASE WHEN read_at = \?::timestamptz THEN NULL ELSE read_at END$/.test(sql)) {
              return [col, r.read_at instanceof Date && r.read_at.getTime() === v.bindings[0].getTime() ? null : r.read_at];
            }
            throw new Error(`fake db cannot evaluate raw: ${sql}`);
          }));
          Object.assign(r, resolved);
          if (metadata && metadata.__raw && /- 'retired'/.test(metadata.__raw)) {
            // jsonb minus every key the expression names.
            const dropped = [...metadata.__raw.matchAll(/- '(\w+)'/g)].map((m) => m[1]);
            const kept = Object.fromEntries(Object.entries(parse(r.metadata)).filter(([k]) => !dropped.includes(k)));
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
const {
  runAdminAlertRelevanceSweep, classify, loadSubjects, subjectFor, refsFromRow,
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
// service_date: the loader's to_char of scheduled_date — before TODAY by default.
const visit = (over = {}) => ({ id: VISIT, customer_id: CUST, status: 'pending', service_date: '2026-09-20', ...over });

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
// A note() bell rings at 2026-09-27T12:00Z: evidence either side of it.
const AFTER_BELL = new Date('2026-09-27T15:00:00Z');
const BEFORE_BELL = new Date('2026-09-27T11:00:00Z');

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
    // Visits, leads, the lead's estimate plus every quote sent to the lead's
    // customer, and the lead customer's latest booked visit — per batch, never per row.
    expect(counts).toEqual({ 'scheduled_services as ss': 1, leads: 1, estimates: 2, scheduled_services: 1 });
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

  test('stale visit: judged by the bell\'s own predicate — a visit from before today still on_site or en_route — never by the customer', async () => {
    const row = staleNote(uid(400));
    for (const status of ['on_site', 'en_route']) {
      mockTables['scheduled_services as ss'] = [visit({ status })];
      expect(await reasonFor(row)).toEqual({ cls: 'stale_visit', reason: null });
    }
    // Closed, or corrected back out of in-progress: the stale condition ended.
    for (const status of ['completed', 'cancelled', 'skipped', 'pending', 'confirmed', 'rescheduled']) {
      mockTables['scheduled_services as ss'] = [visit({ status })];
      expect((await reasonFor(row)).reason).toBe('Visit is no longer in progress');
    }
    // Moved to today or later (Eastern dates): no longer past its date.
    for (const service_date of [TODAY, '2026-10-02']) {
      mockTables['scheduled_services as ss'] = [visit({ status: 'on_site', service_date })];
      expect((await reasonFor(row)).reason).toBe('Visit is no longer past its date');
    }
    // The visit row is gone.
    mockTables['scheduled_services as ss'] = [];
    expect((await reasonFor(row)).reason).toBe('Visit is gone');
    // A bell that names no visit is never judged.
    expect((await reasonFor(note({ category: 'alert', metadata: { dedupeKey: 'stale-visit:z' } }))).reason).toBeNull();
  });

  test('promise marks: settled once every promise it names is closed, gone, or acted on by the office after the bell', async () => {
    const P1 = uid(510);
    const P2 = uid(511);
    const marks = note({ category: 'alert', link: `/admin/customers?customerId=${CUST}&tab=comms`, metadata: { dedupeKey: `visit-promise-marks:${VISIT}`, promise_ids: [P1, P2] } });
    const promises = (one, two) => { mockTables.call_commitments = [{ id: P1, status: 'open', reviewed_at: null, ...one }, { id: P2, status: 'open', reviewed_at: null, ...two }]; };
    promises({}, {});
    expect(await reasonFor(marks)).toEqual({ cls: 'promise_marks', reason: null });
    // One closed, the other still open and untouched: still relevant.
    promises({ status: 'fulfilled' }, { reviewed_at: BEFORE_BELL });
    expect((await reasonFor(marks)).reason).toBeNull();
    // The office acted on the other after the bell (a note, a confirm): settled.
    promises({ status: 'fulfilled' }, { reviewed_at: AFTER_BELL });
    expect((await reasonFor(marks)).reason).toBe('Every promise it named is settled');
    // Dismissed, or gone.
    mockTables.call_commitments = [{ id: P1, status: 'dismissed', reviewed_at: null }];
    expect((await reasonFor(marks)).reason).toBe('Every promise it named is settled');
    // A bell that names no promise is never judged.
    expect((await reasonFor(note({ category: 'alert', metadata: { dedupeKey: 'visit-promise-marks:x' } }))).reason).toBeNull();
  });

  const move = (metadata = {}) => note({
    category: 'schedule_conflict', link: '/admin/dispatch?tab=schedule',
    metadata: { scheduledServiceId: VISIT, seriesMoveId: 'move-1', conflicts: [], overlapDates: ['2026-10-05'], preservedOccurrences: [], ...metadata },
  });

  test('series move: settled item by item — a conflict given a time, closed or gone; a preserved occurrence closed or gone; never the moved visit alone', async () => {
    const card = move({ overlapDates: [], conflicts: [{ id: PARENT, date: '2026-10-12' }], preservedOccurrences: [{ id: OPEN_VISIT, date: '2026-11-09' }] });
    const visits = (conflict, preserved, moved = {}) => {
      mockTables['scheduled_services as ss'] = [visit(moved), visit({ id: PARENT, service_date: '2026-10-12', window_start: null, ...conflict }),
        visit({ id: OPEN_VISIT, service_date: '2026-11-09', ...preserved })];
    };
    visits({ status: 'confirmed' }, { status: 'confirmed' });
    expect(await reasonFor(card)).toEqual({ cls: 'series_move', reason: null });
    // The conflict got the time the card asked for; the preserved occurrence still needs its review.
    visits({ status: 'confirmed', window_start: '09:00' }, { status: 'confirmed' });
    expect((await reasonFor(card)).reason).toBeNull();
    visits({ status: 'confirmed', window_start: '09:00' }, { status: 'cancelled' });
    expect((await reasonFor(card)).reason).toBe('Everything it flagged is settled');
    // A closed conflict settles too, and so does a visit that is gone.
    visits({ status: 'cancelled' }, { status: 'completed' });
    expect((await reasonFor(card)).reason).toBe('Everything it flagged is settled');
    mockTables['scheduled_services as ss'] = [visit()];
    expect((await reasonFor(card)).reason).toBe('Everything it flagged is settled');
    // The moved visit is the card's subject, not its work: closing only it settles nothing.
    visits({ status: 'confirmed' }, { status: 'confirmed' }, { status: 'cancelled' });
    expect((await reasonFor(card)).reason).toBeNull();
  });

  test('series move: an item\'s day passes by the visit\'s current date (Eastern), else the date the card stored; an overlap date only by its day', async () => {
    mockTables['scheduled_services as ss'] = [visit()];
    // Every stored day past, nothing loaded for them: settled.
    expect((await reasonFor(move({ overlapDates: ['2026-09-20', '2026-09-27'], conflicts: [{ id: 'not-a-uuid', date: '2026-09-01' }], preservedOccurrences: [{ date: '2026-08-01' }] }))).reason)
      .toBe('Everything it flagged is settled');
    // Today is not past; a future overlap date keeps the card.
    expect((await reasonFor(move({ overlapDates: [TODAY] }))).reason).toBeNull();
    expect((await reasonFor(move())).reason).toBeNull();
    // A windowless conflict moved to a later date is judged where it is now, not where the card left it.
    mockTables['scheduled_services as ss'] = [visit(), visit({ id: PARENT, status: 'confirmed', window_start: null, service_date: '2026-10-20' })];
    expect((await reasonFor(move({ overlapDates: [], conflicts: [{ id: PARENT, date: '2026-09-21' }] }))).reason).toBeNull();
    // A card that names no item is never judged — nor ever the customer's account.
    expect((await reasonFor(move({ overlapDates: [], conflicts: [], preservedOccurrences: [] }))).reason).toBeNull();
  });

  test('a schedule_conflict row that is not a series move is not in the table', () => {
    expect(classify(note({ category: 'schedule_conflict', metadata: { scheduledServiceId: VISIT } }))).toBeNull();
  });

  test('new lead: judged only by what happened after the bell — deleted, its estimate sent, or a live visit booked', async () => {
    mockTables.leads = [lead({ deleted_at: AFTER_BELL })];
    expect((await reasonFor(leadNote())).reason).toBe('Lead was deleted');
    mockTables.leads = [lead({ estimate_id: EST })];
    mockTables.estimates = [{ id: EST, sent_at: AFTER_BELL }];
    expect((await reasonFor(leadNote())).reason).toBe('Estimate was sent');
    mockTables.estimates = [{ id: EST, sent_at: null }];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    mockTables.leads = [lead()];
    mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: AFTER_BELL }];
    expect((await reasonFor(leadNote())).reason).toBe('A visit was booked');
    // A child the system generated on its own (series top-up, seeded follow-up)
    // is not a booking anyone made for it.
    mockTables.scheduled_services = [
      { customer_id: CUST, latest_created_at: AFTER_BELL, recurring_parent_id: VISIT },
      { customer_id: CUST, latest_created_at: AFTER_BELL, parent_service_id: VISIT },
    ];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // Degraded emitter path: leadId is really a customer id, no lead row -> unknown, never "deleted".
    mockTables.leads = [];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // Lead id from the link alone.
    mockTables.leads = [lead({ deleted_at: AFTER_BELL })];
    expect((await reasonFor(note({ category: 'new_lead', link: `/admin/leads?lead=${LEAD}`, metadata: { triggerKey: 'new_lead' } }))).reason).toBe('Lead was deleted');
  });

  test('new lead: a quote sent after the bell stays evidence when a newer draft takes over the lead\'s estimate pointer', async () => {
    const DRAFT = uid(60);
    // writeGuardedLeadEstimateLink lets a newer draft replace leads.estimate_id.
    mockTables.leads = [lead({ estimate_id: DRAFT })];
    mockTables.estimates = [{ id: EST, customer_id: CUST, sent_at: AFTER_BELL }, { id: DRAFT, customer_id: CUST, sent_at: null }];
    expect((await reasonFor(leadNote())).reason).toBe('Estimate was sent');
    // A quote to the customer from before the bell is not.
    mockTables.estimates = [{ id: EST, customer_id: CUST, sent_at: BEFORE_BELL }, { id: DRAFT, customer_id: CUST, sent_at: null }];
    expect((await reasonFor(leadNote())).reason).toBeNull();
  });

  test('new lead: a conversion is never evidence on its own — booking stamps it, cancelling the visit never clears it, so only the live booking counts', async () => {
    // Converted by a booking after the bell, then the visit was cancelled: no live booking is left.
    mockTables.leads = [lead({ converted_at: AFTER_BELL })];
    mockTables.scheduled_services = [];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: AFTER_BELL }];
    expect((await reasonFor(leadNote())).reason).toBe('A visit was booked');
    expect(classify(note({ category: 'new_lead', link: '/admin/leads', metadata: { triggerKey: 'new_lead' } }))).toBeNull();
  });

  test('new lead (codex #5477 r2/r3 P1): a lead whose CURRENT status is handled is moved on whatever the timestamps say, even when the close landed before the bell', async () => {
    for (const updated_at of [AFTER_BELL, BEFORE_BELL, undefined]) {
      mockTables.leads = [lead({ status: 'handled', customer_id: null, updated_at })];
      expect((await reasonFor(leadNote())).reason).toBe('Request was handled');
    }
    // reopened by staff after being handled: not handled any more, so relevant again (the sweep puts the bell back)
    mockTables.leads = [lead({ status: 'new', customer_id: null, updated_at: AFTER_BELL })];
    expect((await reasonFor(leadNote())).reason).toBeNull();
  });

  test('new lead: the lead\'s state from before the bell never counts — a website submission attached to a lead already quoted, worked or booked stays relevant', async () => {
    // applyLeadAttachUpdate keeps an open lead's status, and the intake trigger rings for the new submission.
    for (const status of ['estimate_sent', 'estimate_viewed', 'contacted', 'spam', 'cancelled', 'won', 'lost', 'duplicate']) {
      mockTables.leads = [lead({ status, estimate_id: EST })];
      mockTables.estimates = [{ id: EST, customer_id: CUST, sent_at: BEFORE_BELL }];
      mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: BEFORE_BELL }];
      expect((await reasonFor(leadNote())).reason).toBeNull();
    }
    mockTables.leads = [lead({ deleted_at: BEFORE_BELL })];
    expect((await reasonFor(leadNote())).reason).toBeNull();
    // A bell with no raise time on record is never judged.
    mockTables.leads = [lead({ deleted_at: AFTER_BELL })];
    expect((await reasonFor({ ...leadNote(), created_at: null })).reason).toBeNull();
  });

  test('new lead: only the intake bell is judged — a repeat submission filed as a duplicate, or an email follow-up\'s new draft, is fresh work', async () => {
    mockTables.leads = [lead({ status: 'duplicate', converted_at: AFTER_BELL })];
    const repeat = note({ category: 'new_lead', link: '/admin/leads', metadata: { leadId: LEAD, duplicateOfLeadId: uid(8) } });
    const followUp = note({ category: 'new_lead', link: `/admin/leads?lead=${LEAD}`, metadata: { leadId: LEAD, estimateId: EST } });
    for (const row of [repeat, followUp]) expect(classify(row)).toBeNull();
    mockTables.notifications = [repeat, followUp];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ retired: 0 });
    expect([repeat.read_at, followUp.read_at]).toEqual([null, null]);
    // The intake bell for the same lead is judged.
    expect((await reasonFor(leadNote())).cls).toBe('new_lead');
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

describe('runAdminAlertRelevanceSweep', () => {
  // Reads of the visits table, in order: 1 = the batch, 2 = the fresh read
  // before the write, 3 = the final judgement after it. The hook runs before
  // the read it counts, so a change made on read N is seen by read N.
  const onVisitRead = (fn) => {
    let reads = 0;
    mockHooks['scheduled_services as ss'] = () => { reads += 1; fn(reads); };
  };

  test('retires every open matching row whose subject moved on (a row someone only READ is still open work); stamps the reason and touches nothing else', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' }), visit({ id: OPEN_VISIT, status: 'on_site' })];
    mockTables.leads = [lead({ deleted_at: AFTER_BELL })];
    const staleMeta = { dedupeKey: `stale-visit:${uid(501)}`, dedupeVersion: 'fp::g2', autoCleared: false, recurrenceGeneration: 2, scheduled_service_id: VISIT, customer_id: CUST };
    const stale = note({ id: uid(501), category: 'alert', metadata: staleMeta });
    const leadRow = { ...leadNote(), id: uid(502) };
    const leadBefore = JSON.parse(leadRow.metadata);
    const alreadyRead = { ...staleNote(uid(503)), read_at: new Date('2026-09-27T13:00:00Z') };
    const stillOpen = staleNote(uid(504), { scheduled_service_id: OPEN_VISIT });
    const contact = note({ id: uid(505), category: 'inbound_sms', metadata: { customerId: CUST } });
    mockTables.notifications = [stale, leadRow, alreadyRead, stillOpen, contact];

    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 5, retired: 3, byClass: { stale_visit: 2, new_lead: 1 }, rearmed: 0 });
    // A retire is DONE: it leaves the bell, with its reason as the resolution; an unread row is read at the done instant.
    expect(stale).toMatchObject({ read_at: NOW, done_at: NOW, done_by: 'relevance', resolution: 'Visit is no longer in progress' });
    // Pure read + retired marker: every emitter-owned key survives as it was,
    // dedupe key included.
    expect(JSON.parse(stale.metadata)).toEqual({ ...staleMeta, retired: { by: 'alert-relevance', reason: 'Visit is no longer in progress', at: NOW.toISOString() } });
    expect(leadRow).toMatchObject({ read_at: NOW, done_at: NOW, done_by: 'relevance' });
    expect(JSON.parse(leadRow.metadata)).toEqual({ ...leadBefore, retired: { by: 'alert-relevance', reason: 'Lead was deleted', at: NOW.toISOString() } });
    // Read is not done: the person's read is retired too, and their own read_at stands.
    expect(alreadyRead).toMatchObject({ read_at: new Date('2026-09-27T13:00:00Z'), done_at: NOW, done_by: 'relevance', resolution: 'Visit is no longer in progress' });
    expect(JSON.parse(alreadyRead.metadata).retired).toMatchObject({ by: 'alert-relevance', at: NOW.toISOString() });
    for (const untouched of [stillOpen, contact]) {
      expect([untouched.read_at, untouched.done_at ?? null]).toEqual([null, null]);
      expect(JSON.parse(untouched.metadata).retired).toBeUndefined();
    }
  });

  test('the candidate query is open (done_at IS NULL, never read_at), not already retired, admin and bell-visible, with no age cut-off (a refreshed bell keeps its first created_at)', async () => {
    mockTables.notifications = [];
    await runAdminAlertRelevanceSweep({ now: NOW });
    // The retire pass's query (the re-arm pass reads stamped rows first).
    const q = mockQueries.find((x) => x.table === 'notifications' && x.calls.some(([m, sql]) => m === 'whereRaw' && sql === "metadata->'retired' IS NULL"));
    const flat = JSON.stringify(q.calls);
    expect(q.calls).toEqual(expect.arrayContaining([['where', { recipient_type: 'admin' }], ['whereRaw', "metadata->'retired' IS NULL", []]]));
    // Read is not done: a row someone opened is still open work.
    expect(q.calls).not.toContainEqual(['whereNull', 'read_at']);
    expect(flat).toContain("metadata->>'feed'");
    // created_at is read (a new lead is judged by what came after it), never filtered on.
    expect(JSON.stringify(q.calls.filter(([m]) => m !== 'select'))).not.toContain('created_at');
  });

  test('an unread bell first raised months ago (then re-rung by a refresh) is still judged and retired', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const old = { ...staleNote(uid(540)), created_at: new Date('2026-06-01T12:00:00Z') };
    mockTables.notifications = [old];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 1 });
    expect(old).toMatchObject({ read_at: NOW, done_at: NOW });
  });

  test('the retirement is judged on a fresh read: a visit that reopens after the batch read keeps the stale-visit alert ringing', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(550));
    mockTables.notifications = [row];
    onVisitRead((n) => { if (n === 2) mockTables['scheduled_services as ss'][0].status = 'on_site'; });
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect([row.read_at, row.done_at ?? null]).toEqual([null, null]);
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('a change that lands between the write and the final judgement puts the bell back exactly as it was', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(551));
    const before = JSON.parse(row.metadata);
    mockTables.notifications = [row];
    onVisitRead((n) => { if (n === 3) mockTables['scheduled_services as ss'][0].status = 'on_site'; });
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect([row.read_at, row.done_at, row.done_by, row.resolution]).toEqual([null, null, null, null]);
    expect(JSON.parse(row.metadata)).toEqual(before);
  });

  test('a check after the write that fails is no verdict: the bell is put back exactly as it was', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(552));
    const before = JSON.parse(row.metadata);
    mockTables.notifications = [row];
    onVisitRead((n) => { if (n === 3) throw new Error('connection reset'); });
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect([row.read_at, row.done_at, row.done_by, row.resolution]).toEqual([null, null, null, null]);
    expect(JSON.parse(row.metadata)).toEqual(before);
  });

  test('the put-back also holds for a lead restored in that window', async () => {
    mockTables.leads = [lead({ deleted_at: AFTER_BELL })];
    const row = leadNote();
    const before = JSON.parse(row.metadata);
    mockTables.notifications = [row];
    let leadReads = 0;
    // The lead is restored between the retire write and the final judgement.
    mockHooks.leads = () => { leadReads += 1; if (leadReads === 3) mockTables.leads[0].deleted_at = null; };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect([row.read_at, row.done_at, row.done_by, row.resolution]).toEqual([null, null, null, null]);
    expect(JSON.parse(row.metadata)).toEqual(before);
  });

  test('the retire writes an explicit millisecond done_at (never NOW(), whose microseconds a read-back would lose) and the put-back matches it exactly', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(557));
    mockTables.notifications = [row];
    const retireWrites = [];
    onVisitRead((n) => {
      if (n === 3) { retireWrites.push([row.done_at, row.read_at]); mockTables['scheduled_services as ss'][0].status = 'on_site'; }
    });
    await runAdminAlertRelevanceSweep({ now: NOW });
    expect(retireWrites[0][0]).toBeInstanceOf(Date);
    expect(retireWrites[0][0]).not.toBe('NOW');
    expect(retireWrites[0]).toEqual([NOW, NOW]);
    // Put back by an exact done_at match: open again, and unread because the read was this module's own.
    expect([row.done_at, row.done_by, row.read_at]).toEqual([null, null, null]);
  });

  test('a person who reopens the bell in that window keeps it: nothing is put back over it, and the sweep never retires it again', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(552));
    mockTables.notifications = [row];
    onVisitRead((n) => {
      if (n === 3) {
        mockTables['scheduled_services as ss'][0].status = 'on_site';
        Object.assign(row, { done_at: null, done_by: null, resolution: null }); // their reopen
      }
    });
    await runAdminAlertRelevanceSweep({ now: NOW });
    // Their reopen is theirs: the fence (done_at = our stamp) no longer matches, so the row is left exactly as they made it.
    expect([row.done_at, row.read_at]).toEqual([null, NOW]);
    expect(JSON.parse(row.metadata).retired).toMatchObject({ by: 'alert-relevance' });
    // …and the stamp survives the reopen, so a later sweep does not close it behind their back.
    mockTables['scheduled_services as ss'][0].status = 'completed';
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 0, retired: 0 });
    expect(row.done_at ?? null).toBeNull();
  });

  test('a person who reads the bell in that window keeps their read: the put-back reopens it but never un-reads it', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(558));
    mockTables.notifications = [row];
    const theirRead = new Date('2026-09-27T13:00:00Z');
    row.read_at = theirRead; // read before the sweep got to it
    onVisitRead((n) => { if (n === 3) mockTables['scheduled_services as ss'][0].status = 'on_site'; });
    await runAdminAlertRelevanceSweep({ now: NOW });
    expect([row.done_at, row.done_by]).toEqual([null, null]);
    expect(row.read_at).toBe(theirRead);
  });

  test('no row locks anywhere: the sweep never takes FOR SHARE / FOR UPDATE (invoice settlement takes the visit FOR UPDATE NOWAIT)', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.leads = [lead({ deleted_at: AFTER_BELL })];
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
    expect([mockTables.notifications[0].read_at, mockTables.notifications[0].done_at ?? null]).toEqual([null, null]);
  });

  test('switch off: no reads, no writes, nothing retired', async () => {
    process.env.ADMIN_ALERT_RELEVANCE = 'off';
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.notifications = [staleNote(uid(510))];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toEqual({ skipped: true, reason: 'switch_off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockTables.notifications[0].read_at).toBeNull();
  });

  test('a row a person READS mid-sweep is still retired (read is not done) and keeps their read_at', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(520));
    mockTables.notifications = [row];
    const readAt = new Date('2026-09-28T15:59:00Z');
    onVisitRead((n) => { if (n === 1) row.read_at = readAt; });
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toMatchObject({ scanned: 1, retired: 1, byClass: { stale_visit: 1 } });
    expect(row).toMatchObject({ read_at: readAt, done_at: NOW, done_by: 'relevance' });
    expect(JSON.parse(row.metadata).retired).toMatchObject({ by: 'alert-relevance', at: NOW.toISOString() });
  });

  test('a row a person marks DONE whose subject moved on is taken over (done_by relevance, no Reopen), not retired: their done, resolution and read stand', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(521));
    mockTables.notifications = [row];
    const doneAt = new Date('2026-09-28T15:59:00Z');
    onVisitRead((n) => { if (n === 1) Object.assign(row, { done_at: doneAt, done_by: '7', resolution: 'Handled by phone', read_at: doneAt }); });
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toMatchObject({ scanned: 1, retired: 0, byClass: {} });
    expect(row).toMatchObject({ done_at: doneAt, done_by: 'relevance', resolution: 'Handled by phone', read_at: doneAt });
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('pages through more unread rows than one page and keeps every read per-page batched', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    mockTables.notifications = Array.from({ length: 205 }, (_v, i) => staleNote(uid(1000 + i)));
    const result = await runAdminAlertRelevanceSweep({ now: NOW });
    expect(result).toMatchObject({ scanned: 205, retired: 205 });
    expect(mockTables.notifications.every((r) => r.read_at instanceof Date && r.done_at instanceof Date)).toBe(true);
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
    expect(good).toMatchObject({ read_at: NOW, done_at: NOW });
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
    expect([row.read_at, row.done_at ?? null]).toEqual([null, null]);
    expect(JSON.parse(row.metadata)).toEqual(refreshed);
  });

  test('a quiet refresh after the write is judged as it stands: the final verdict reads the bell again and puts it back when the new content has not moved on', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = staleNote(uid(571));
    mockTables.notifications = [row];
    const refreshed = { ...JSON.parse(row.metadata), scheduled_service_id: OPEN_VISIT, dedupeVersion: 'refreshed' };
    let reads = 0;
    // 1st read: the fresh read before the write. 2nd: the read after it — a
    // quiet refresh (done_at untouched, the stamp merged in) lands just before,
    // onto a visit that is still open.
    mockHooks['notifications:first'] = () => {
      reads += 1;
      if (reads === 2) {
        row.metadata = JSON.stringify({ ...refreshed, retired: JSON.parse(row.metadata).retired });
        mockTables['scheduled_services as ss'].push(visit({ id: OPEN_VISIT, status: 'on_site' }));
      }
    };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 0 });
    expect([row.read_at, row.done_at, row.done_by]).toEqual([null, null, null]);
    expect(JSON.parse(row.metadata)).toEqual(refreshed);
  });
});

describe('re-arm: a retirement holds only while its rule does', () => {
  const AT = '2026-09-27T16:00:00.123Z';
  const READ_AT = new Date(AT);
  const retiredStamp = (reason, at = AT) => ({ retired: { by: 'alert-relevance', reason, at } });
  // As the sweep writes it: the stamp's `at` is the done_at (and, on an unread row, the read_at) it stored.
  const swept = (row, reason, at = AT) => {
    row.read_at = new Date(at);
    row.done_at = new Date(at);
    row.done_by = 'relevance';
    row.resolution = reason;
    row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), ...retiredStamp(reason, at) });
    return row;
  };

  test('a retired bell whose subject is relevant again is unread again with the stamp gone; one still moved on stays retired', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'on_site' }), visit({ id: OPEN_VISIT, status: 'completed' })];
    mockTables.leads = [lead({ status: 'new' })];
    const reopened = swept(staleNote(uid(700)), 'Visit is no longer in progress');
    const stillClosed = swept(staleNote(uid(701), { scheduled_service_id: OPEN_VISIT }), 'Visit is no longer in progress');
    // A lead whose booking was cancelled: nothing raises a new-lead event again.
    const bookingCancelled = swept(leadNote(), 'A visit was booked');
    mockTables.notifications = [reopened, stillClosed, bookingCancelled];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 2, retired: 0 });
    for (const back of [reopened, bookingCancelled]) {
      expect([back.read_at, back.done_at, back.done_by, back.resolution]).toEqual([null, null, null, null]);
      expect(JSON.parse(back.metadata).retired).toBeUndefined();
    }
    expect([stillClosed.read_at, stillClosed.done_at, stillClosed.done_by]).toEqual([READ_AT, READ_AT, 'relevance']);
    expect(JSON.parse(stillClosed.metadata).retired).toMatchObject({ by: 'alert-relevance', at: AT });
  });

  test('a retirement older than the window is final; a human dismissal or another module\'s stamp is never re-armed', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'on_site' })];
    const final = swept(staleNote(uid(710)), 'Visit is no longer in progress', '2026-09-13T15:59:59.000Z');
    const human = { ...staleNote(uid(711)), read_at: READ_AT };
    const other = { ...staleNote(uid(712), { retired: { by: 'someone-else', at: AT } }), read_at: READ_AT };
    mockTables.notifications = [final, human, other];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 0 });
    expect([final.read_at, final.done_at]).toEqual([new Date('2026-09-13T15:59:59.000Z'), new Date('2026-09-13T15:59:59.000Z')]);
    for (const row of [human, other]) expect(row.read_at).toEqual(READ_AT);
  });

  test('the put-back lands only on the version read: a row rewritten or closed again by a person meanwhile is left alone', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'on_site' })];
    const rewritten = swept(staleNote(uid(720)), 'Visit is no longer in progress');
    const reread = swept(staleNote(uid(721)), 'Visit is no longer in progress');
    const THEIR_DONE = new Date('2026-09-28T15:00:00Z');
    mockTables.notifications = [rewritten, reread];
    // New row versions land between the page read and the write (the page
    // holds the versions it read, as Postgres would).
    mockHooks['scheduled_services as ss'] = () => {
      mockTables.notifications = mockTables.notifications.map((r) => {
        if (r.id === rewritten.id) return { ...r, metadata: JSON.stringify({ ...JSON.parse(r.metadata), note: 'refreshed' }) };
        // A person reopened it and closed it again by hand: a done of their own.
        if (r.id === reread.id) return { ...r, done_at: THEIR_DONE, done_by: '7', resolution: 'Handled', read_at: THEIR_DONE };
        return r;
      });
    };
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 0 });
    const live = (id) => mockTables.notifications.find((r) => r.id === id);
    expect([live(rewritten.id).read_at, live(rewritten.id).done_at]).toEqual([READ_AT, READ_AT]);
    expect(live(reread.id)).toMatchObject({ read_at: THEIR_DONE, done_at: THEIR_DONE, done_by: '7', resolution: 'Handled' });
    // …and on every later run: the stamp still names this module's done, which is no longer the row's.
    mockHooks['scheduled_services as ss'] = null;
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 1 });
    expect(live(reread.id)).toMatchObject({ read_at: THEIR_DONE, done_at: THEIR_DONE, done_by: '7' });
    expect([live(rewritten.id).read_at, live(rewritten.id).done_at]).toEqual([null, null]);
  });

  test('a person who read the retired bell keeps their read through the put-back; the row is open again', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'on_site' })];
    const THEIR_READ = new Date('2026-09-28T15:00:00Z');
    const row = swept(staleNote(uid(722)), 'Visit is no longer in progress');
    row.read_at = THEIR_READ; // read after the retire: the row's read is no longer the module's own
    // …and one a person had already read BEFORE the retire (the retire kept their read_at, not the stamp's).
    const earlier = swept(staleNote(uid(723)), 'Visit is no longer in progress');
    earlier.read_at = new Date('2026-09-27T13:00:00Z');
    mockTables.notifications = [row, earlier];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 2 });
    expect([row.done_at, row.done_by, row.resolution]).toEqual([null, null, null]);
    expect(row.read_at).toBe(THEIR_READ);
    expect([earlier.done_at, earlier.done_by]).toEqual([null, null]);
    expect(earlier.read_at).toEqual(new Date('2026-09-27T13:00:00Z'));
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('a backlog past the page cap is walked across runs: the next run resumes where the last one stopped', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' }), visit({ id: OPEN_VISIT, status: 'on_site' })];
    // 50 pages of 200 retired rows still moved on, then one relevant again.
    const backlog = Array.from({ length: 50 * 200 }, (_, i) => swept(staleNote(uid(10000 + i)), 'Visit is no longer in progress'));
    const last = swept(staleNote(uid(30000), { scheduled_service_id: OPEN_VISIT }), 'Visit is no longer in progress');
    mockTables.notifications = [...backlog, last];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 0 });
    expect([last.read_at, last.done_at]).toEqual([READ_AT, READ_AT]);
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 1 });
    expect([last.read_at, last.done_at]).toEqual([null, null]);
  });

  test('a retire whose put-back failed is judged again by the next run: kept while still moved on, put back once relevant', async () => {
    mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
    const row = swept(staleNote(uid(730)), 'Visit is no longer in progress');
    mockTables.notifications = [row];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 0 });
    expect([row.read_at, row.done_at]).toEqual([READ_AT, READ_AT]);
    mockTables['scheduled_services as ss'][0].status = 'on_site';
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 1 });
    expect([row.read_at, row.done_at]).toEqual([null, null]);
  });
});
