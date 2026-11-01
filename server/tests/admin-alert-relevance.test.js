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
// The customer-contact witnesses' SQL runs in the Postgres suite; here the loader is a stub that
// hands back whatever bundles a test sets, and the shadow audit writer records what it is given.
let mockBundles;
const mockLoadContactBundles = jest.fn(async () => (typeof mockBundles === 'function' ? mockBundles() : mockBundles));
jest.mock('../services/admin-alert-contact-witnesses', () => ({ loadContactBundles: (...args) => mockLoadContactBundles(...args) }));
const mockAuditWouldClose = jest.fn(async ({ items }) => items.length);
jest.mock('../services/audit-log', () => ({ auditAlertWouldClose: (...args) => mockAuditWouldClose(...args) }));
// The quiet request resolve the portal item classes run after a close (its SQL runs in the Postgres suite).
const mockResolveRequest = jest.fn(async () => 1);
jest.mock('../services/portal-inbox', () => ({ resolveRequestQuietly: (...args) => mockResolveRequest(...args) }));
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
    for (const m of ['select', 'leftJoin', 'orderBy', 'groupBy', 'max', 'whereNotIn', 'forShare', 'forUpdate', 'whereNotExists', 'groupByRaw']) {
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
  runAdminAlertRelevanceSweep, classify, loadSubjects, subjectFor, refsFromRow, judge,
} = require('../services/admin-alert-relevance');
const {
  adminAlertRelevanceLive, alertContactCloseMode, voicemailVisitUnderwayMode, leadContactedCloseMode, staffActionAnswersMode, portalChatAnsweredCloseMode,
} = require('../config/feature-gates');

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
  delete process.env.GATE_ALERT_CONTACT_CLOSE;
  delete process.env.GATE_VOICEMAIL_VISIT_UNDERWAY;
  delete process.env.GATE_LEAD_CONTACTED_CLOSE;
  delete process.env.GATE_PORTAL_CHAT_ANSWERED_CLOSE;
  delete process.env.GATE_SMS_STAFF_ACTION_ANSWERS;
  delete process.env.GATE_PORTAL_ITEM_CLOSE;
  delete process.env.GATE_PORTAL_LATE_RERING;
  mockBundles = new Map();
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
  test('stale consent: settled only by a consent row at the CURRENT text version recorded after the bell (codex local review on #5434)', async () => {
    const { CONSENT_VERSION } = require('../services/payment-method-consent-text');
    const row = note({ category: 'billing', metadata: { dedupeKey: 'consent_version_stale:pi_1', customerId: CUST, intentId: 'pi_1' } });
    expect(classify(row)?.key).toBe('consent_version_stale');
    // No re-authorization at all.
    expect(await reasonFor(row)).toEqual({ cls: 'consent_version_stale', reason: null });
    // An older-version row after the bell is not a re-authorization.
    // (The fake answers the grouped max() with pre-shaped rows, like the scheduled_services cases.)
    mockTables.payment_method_consents = [{ customer_id: CUST, consent_text_version: 'v11_2026-08-25', latest_created_at: AFTER_BELL }];
    expect(await reasonFor(row)).toEqual({ cls: 'consent_version_stale', reason: null });
    // A current-version row from BEFORE the bell is what the bell already judged stale.
    mockTables.payment_method_consents.push({ customer_id: CUST, consent_text_version: CONSENT_VERSION, latest_created_at: BEFORE_BELL });
    expect(await reasonFor(row)).toEqual({ cls: 'consent_version_stale', reason: null });
    // The customer re-authorized under the current text after the bell: settled.
    mockTables.payment_method_consents = [{ customer_id: CUST, consent_text_version: CONSENT_VERSION, latest_created_at: AFTER_BELL }];
    expect(await reasonFor(row)).toEqual({ cls: 'consent_version_stale', reason: 'Authorization was re-collected' });
    // An after-visit reauthorization (its own current version label) settles
    // the bell too; a card-hold consent is not a recurring authorization.
    const { AFTER_VISIT_CONSENT_VERSION } = require('../services/payment-method-consent-text');
    mockTables.payment_method_consents = [{ customer_id: CUST, consent_text_version: AFTER_VISIT_CONSENT_VERSION, latest_created_at: AFTER_BELL }];
    expect(await reasonFor(row)).toEqual({ cls: 'consent_version_stale', reason: 'Authorization was re-collected' });
    mockTables.payment_method_consents = [{ customer_id: CUST, consent_text_version: 'hold_v1_2026-10-01', latest_created_at: AFTER_BELL }];
    expect(await reasonFor(row)).toEqual({ cls: 'consent_version_stale', reason: null });
    // A bell naming no customer is never judged.
    const anonymous = note({ category: 'billing', metadata: { dedupeKey: 'consent_version_stale:pi_2', intentId: 'pi_2' } });
    expect(await reasonFor(anonymous)).toEqual({ cls: 'consent_version_stale', reason: null });
  });

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

  test('self-booked re-service bell: done once its visit is completed, cancelled or gone; open stays (owner 2026-10-05)', async () => {
    const bell = (over = {}) => note({
      category: 'schedule',
      link: `/admin/dispatch?tab=schedule&date=2026-10-09&appointment=${VISIT}`,
      metadata: { triggerKey: 'reservice_self_booked', dedupeKey: `reservice-booked:${VISIT}`, payload: { customerId: CUST }, ...over },
    });
    for (const status of ['pending', 'confirmed', 'en_route', 'on_site']) {
      mockTables['scheduled_services as ss'] = [visit({ status })];
      expect(await reasonFor(bell())).toEqual({ cls: 'reservice_booked', reason: null });
    }
    for (const status of ['completed', 'cancelled', 'no_show', 'skipped']) {
      mockTables['scheduled_services as ss'] = [visit({ status })];
      expect((await reasonFor(bell())).reason).toBe('Visit is closed');
    }
    mockTables['scheduled_services as ss'] = [];
    expect((await reasonFor(bell())).reason).toBe('Visit is gone');
    // Another schedule bell (a reschedule request) is not this class.
    expect(classify(note({ category: 'schedule', metadata: { triggerKey: 'appointment_reschedule_intent', dedupeKey: `reservice-booked:${VISIT}` } }))).toBeNull();
  });

  test('phone-booking rain notice: done once its visit is closed, gone, moved or past its date (owner 2026-10-08)', async () => {
    const bell = (over = {}) => note({
      category: 'schedule',
      link: `/admin/dispatch?tab=schedule&date=2026-09-30&appointment=${VISIT}`,
      metadata: { dedupeKey: `call-booking-rain:${VISIT}`, scheduledServiceId: VISIT, scheduled_date: '2026-09-30', window_start: '14:00', rain_chance_pct: 88, ...over },
    });
    const booked = (over = {}) => visit({ service_date: '2026-09-30', window_start: '14:00:00', ...over });
    // Still the visit it was raised for: open.
    for (const status of ['pending', 'confirmed']) {
      mockTables['scheduled_services as ss'] = [booked({ status })];
      expect(await reasonFor(bell())).toEqual({ cls: 'call_booking_rain', reason: null });
    }
    for (const status of ['completed', 'cancelled', 'no_show', 'skipped']) {
      mockTables['scheduled_services as ss'] = [booked({ status })];
      expect((await reasonFor(bell())).reason).toBe('Visit is closed');
    }
    // Moved to another day, or to another start on the same day.
    mockTables['scheduled_services as ss'] = [booked({ service_date: '2026-10-02' })];
    expect((await reasonFor(bell())).reason).toBe('Visit was moved');
    mockTables['scheduled_services as ss'] = [booked({ window_start: '09:00:00' })];
    expect((await reasonFor(bell())).reason).toBe('Visit was moved');
    // Its day has passed (TODAY is 2026-09-28).
    mockTables['scheduled_services as ss'] = [booked({ service_date: '2026-09-27' })];
    expect((await reasonFor(bell({ scheduled_date: '2026-09-27' }))).reason).toBe('Visit date has passed');
    mockTables['scheduled_services as ss'] = [];
    expect((await reasonFor(bell())).reason).toBe('Visit is gone');
    // The self-booked re-service bell on the same category is another class.
    expect(classify(note({ category: 'schedule', metadata: { triggerKey: 'reservice_self_booked', dedupeKey: `reservice-booked:${VISIT}` } })).key).toBe('reservice_booked');
  });

  test('call last-name suggestion: done once the customer has a last name or is gone; a live customer with a blank one keeps it (owner 2026-10-08)', async () => {
    const bell = (over = {}) => note({
      category: 'customer',
      link: `/admin/customers?customerId=${CUST}`,
      metadata: { dedupeKey: `call-last-name-suggestion:${CUST}`, customerId: CUST, callLogId: uid(40), suggestions: [{ surname: 'Sample', sources: ['email'] }], ...over },
    });
    const pat = (over = {}) => ({ id: CUST, first_name: 'Pat', last_name: '', ...over });
    // Live customer, blank (or whitespace-only, or null) last name: the bell stays.
    for (const last_name of ['', '   ', null]) {
      mockTables.customers = [pat({ last_name })];
      expect(await reasonFor(bell())).toEqual({ cls: 'call_last_name_suggestion', reason: null });
    }
    mockTables.customers = [pat({ last_name: 'Sample' })];
    expect((await reasonFor(bell())).reason).toBe('Last name was saved');
    // Deleted (soft-deleted rows are not loaded) or hard-deleted: gone.
    mockTables.customers = [pat({ deleted_at: AFTER_BELL })];
    expect((await reasonFor(bell())).reason).toBe('Customer is gone');
    mockTables.customers = [];
    expect((await reasonFor(bell())).reason).toBe('Customer is gone');
    // The customer id falls back to the link when the metadata has none.
    mockTables.customers = [pat({ last_name: 'Sample' })];
    expect((await reasonFor(bell({ customerId: undefined }))).reason).toBe('Last name was saved');
    // A bell naming no usable customer is never judged and reads no customer.
    mockQueries = [];
    expect((await reasonFor(bell({ customerId: 'not-an-id' }))).reason).toBeNull();
    const nobody = note({ category: 'customer', link: '/admin/customers', metadata: { dedupeKey: 'call-last-name-suggestion:x', customerId: 42 } });
    expect(await reasonFor(nobody)).toEqual({ cls: 'call_last_name_suggestion', reason: null });
    expect(mockQueries.filter((q) => q.table === 'customers')).toEqual([]);
    // Another category with a look-alike key, or another customer-category bell, is not this class.
    expect(classify(note({ category: 'alert', metadata: { dedupeKey: `call-last-name-suggestion:${CUST}`, customerId: CUST } }))).toBeNull();
    expect(classify(note({ category: 'customer', metadata: { dedupeKey: `missing-last-name:${CUST}`, customerId: CUST } }))).toBeNull();
    // Other classes' bells that carry a customerId read no customer.
    mockQueries = [];
    await loadSubjects([staleNote(uid(41)), note({ category: 'alert', metadata: { dedupeKey: 'portal-chat-escalation:e', customerId: CUST, topic: 'add_service' } })]);
    expect(mockQueries.filter((q) => q.table === 'customers')).toEqual([]);
  });

  test('promise chaser: settled once the promise it chases is closed; a missing promise or another missed-call bell is never judged (owner 2026-10-03)', async () => {
    const P = uid(520);
    const chaser = (over = {}) => note({
      category: 'missed_call',
      metadata: { triggerKey: 'promise_chaser', dedupeKey: `promise_chaser:${P}:0:2026-09-27`, payload: { commitmentId: P, what: 'quote', customerId: CUST }, ...over },
    });
    mockTables.call_commitments = [{ id: P, status: 'open', human_state: null }];
    expect(await reasonFor(chaser())).toEqual({ cls: 'promise_chaser', reason: null });
    // Kept, dismissed, or dismissed by staff while the status stays open.
    for (const closed of [{ status: 'fulfilled' }, { status: 'dismissed' }, { status: 'open', human_state: 'dismissed' }]) {
      mockTables.call_commitments = [{ id: P, human_state: null, ...closed }];
      expect((await reasonFor(chaser())).reason).toBe('The promise was closed');
    }
    // The promise row is gone: unknown, not closed.
    mockTables.call_commitments = [];
    expect((await reasonFor(chaser())).reason).toBeNull();
    // An ordinary missed-call bell is not this class, whatever it carries.
    expect(classify(note({ category: 'missed_call', metadata: { triggerKey: 'missed_call', payload: { commitmentId: P } } }))).toBeNull();
  });

  // The fake answers the handoff-witness query (call-commitments.js
  // handedOffWithin + the ownership fence) with whatever estimates it holds;
  // the SQL itself is proved in admin-alert-relevance-db.test.js.
  test('portal chat about adding a service: settled once the handoff witness finds an estimate for that customer after the bell; other topics are never judged (owner 2026-10-03)', async () => {
    const chat = (topic) => note({
      category: 'alert', link: `/admin/customers?customerId=${CUST}`,
      metadata: { dedupeKey: 'portal-chat-escalation:esc-1', customerId: CUST, escalationId: 'esc-1', ...(topic ? { topic } : {}) },
    });
    const row = chat('add_service');
    expect(await reasonFor(row)).toEqual({ cls: 'portal_chat_add_service', reason: null });
    // The witness is asked about this customer, from the bell's own time.
    const asked = mockQueries.filter((q) => q.table === 'estimates').pop();
    expect(JSON.stringify(asked.calls)).toContain(CUST);
    mockTables.estimates = [{ id: uid(533), customer_id: CUST }];
    expect((await reasonFor(row)).reason).toBe('Estimate was sent');
    // A bell with no usable customer id asks nothing and is never settled.
    const nobody = note({ category: 'alert', metadata: { dedupeKey: 'portal-chat-escalation:esc-2', customerId: 'not-an-id', topic: 'add_service' } });
    expect((await reasonFor(nobody)).reason).toBeNull();
    // A cancellation or a complaint is not answered by an estimate, and a bell
    // from before the topic was stored is left to a person.
    for (const other of [chat('cancellation'), chat('complaint'), chat(null)]) expect(classify(other)).toBeNull();
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

  // The fake answers the contact read (sms_log through deliveredTexts) with
  // whatever rows it holds; the delivered-text SQL is auto-text-holds.js's own.
  test('repeat-form alert (codex #6625 P2s): closed once a staff text reached the lead after its latest form, or by work on the lead; a call row, an automated text or another customer\'s text never counts', async () => {
    const repeat = () => note({
      category: 'lead', link: `/admin/leads?lead=${LEAD}`,
      metadata: { dedupeKey: `lead-repeat-form:${CUST}`, customerId: CUST, leadId: LEAD, source: 'lead_repeat_form' },
    });
    mockTables.leads = [lead()];
    expect(await reasonFor(repeat())).toEqual({ cls: 'lead_repeat_form', reason: null });
    // A staff text after the alert closes it; one from before its latest form
    // never does (a later form re-rings the row and moves its time).
    mockTables.sms_log = [{ customer_id: CUST, direction: 'outbound', message_type: 'manual', latest_created_at: AFTER_BELL }];
    expect((await reasonFor(repeat())).reason).toBe('Lead was contacted');
    expect((await reasonFor({ ...repeat(), created_at: new Date('2026-09-27T16:00:00Z') })).reason).toBeNull();
    // An automated text, or another customer's staff text, never counts.
    mockTables.sms_log = [
      { customer_id: CUST, direction: 'outbound', message_type: 'auto_reply', latest_created_at: AFTER_BELL },
      { customer_id: uid(99), direction: 'outbound', message_type: 'manual', latest_created_at: AFTER_BELL },
    ];
    expect((await reasonFor(repeat())).reason).toBeNull();
    // A dialer call row is not contact, even one staff bridged after the alert:
    // it is written before Twilio dials and does not prove the lead answered.
    mockTables.sms_log = [];
    mockTables.call_log = [{ customer_id: CUST, direction: 'outbound', source: 'admin-click', bridged_at: AFTER_BELL, created_at: AFTER_BELL }];
    expect((await reasonFor(repeat())).reason).toBeNull();
    mockTables.call_log = [];
    // Work on the lead after the alert closes it too. The fake answers the
    // handoff witness (handedOffWithin + the ownership fence) with whatever
    // estimates it holds; a suppressed send is proved in the Postgres suite.
    mockTables.estimates = [{ id: EST, customer_id: CUST, sent_at: AFTER_BELL }];
    expect((await reasonFor(repeat())).reason).toBe('Estimate was sent');
    mockTables.estimates = [];
    mockTables.leads = [lead()];
    mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: AFTER_BELL }];
    expect((await reasonFor(repeat())).reason).toBe('A visit was booked');
    mockTables.scheduled_services = [];
    mockTables.leads = [lead({ deleted_at: AFTER_BELL })];
    expect((await reasonFor(repeat())).reason).toBe('Lead was deleted');
    // A lead marked handled before this form is the lead coming back: still open
    // (the new-lead bell's handled shortcut does not apply).
    mockTables.leads = [lead({ status: 'handled' })];
    expect((await reasonFor(repeat())).reason).toBeNull();
    // Another Leads alert is not this class.
    expect(classify(note({ category: 'lead', metadata: { dedupeKey: `sms-lead:${LEAD}`, customerId: CUST } }))).toBeNull();
  });

  test('repeat-form alert with no lead row (it opens the customer): a quote, a booking or contact for that customer still closes it', async () => {
    const customerOnly = () => note({
      category: 'lead', link: `/admin/customers?customerId=${CUST}`,
      metadata: { dedupeKey: `lead-repeat-form:${CUST}`, customerId: CUST, leadId: null, source: 'lead_repeat_form' },
    });
    expect(await reasonFor(customerOnly())).toEqual({ cls: 'lead_repeat_form', reason: null });
    mockTables.estimates = [{ id: EST, customer_id: CUST, sent_at: AFTER_BELL }];
    expect((await reasonFor(customerOnly())).reason).toBe('Estimate was sent');
    mockTables.estimates = [];
    mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: AFTER_BELL }];
    expect((await reasonFor(customerOnly())).reason).toBe('A visit was booked');
    mockTables.scheduled_services = [];
    mockTables.sms_log = [{ customer_id: CUST, direction: 'outbound', message_type: 'manual', latest_created_at: AFTER_BELL }];
    expect((await reasonFor(customerOnly())).reason).toBe('Lead was contacted');
  });

  test('with the contact gate off, customer-contact bells and money-owed alerts are never in the table, whatever their metadata says', () => {
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

  test('a last-name suggestion is retired by the sweep once the name is saved, and put back (unread) if the name is blanked again', async () => {
    const bell = () => note({ category: 'customer', link: `/admin/customers?customerId=${CUST}`, metadata: { dedupeKey: `call-last-name-suggestion:${CUST}`, customerId: CUST } });
    const row = bell();
    mockTables.customers = [{ id: CUST, first_name: 'Pat', last_name: 'Sample' }];
    mockTables.notifications = [row];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ scanned: 1, retired: 1, byClass: { call_last_name_suggestion: 1 } });
    expect(row).toMatchObject({ done_at: NOW, done_by: 'relevance', resolution: 'Last name was saved' });
    expect(JSON.parse(row.metadata).retired).toEqual({ by: 'alert-relevance', reason: 'Last name was saved', at: NOW.toISOString() });
    // The office blanks the name again inside the window: the bell comes back.
    mockTables.customers[0].last_name = '';
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 1, retired: 0 });
    expect([row.read_at, row.done_at, row.done_by, row.resolution]).toEqual([null, null, null, null]);
    expect(JSON.parse(row.metadata).retired).toBeUndefined();
  });

  test('a promise-chaser retirement is final: the promise reopened later does not put the bell back (its emitter\'s own close is final too)', async () => {
    const P = uid(720);
    mockTables.call_commitments = [{ id: P, status: 'open', human_state: null }];
    const chaser = swept(note({ category: 'missed_call', metadata: { triggerKey: 'promise_chaser', dedupeKey: `promise_chaser:${P}:0:2026-09-27`, payload: { commitmentId: P } } }), 'The promise was closed');
    mockTables.notifications = [chaser];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 0, retired: 0 });
    expect([chaser.done_by, chaser.resolution]).toEqual(['relevance', 'The promise was closed']);
  });

  test('a repeat-form retirement is final: never put back beside the fresh row the lead\'s next form rings', async () => {
    mockTables.leads = [lead()];
    const bell = swept(note({ category: 'lead', link: `/admin/leads?lead=${LEAD}`, metadata: { dedupeKey: `lead-repeat-form:${CUST}`, customerId: CUST, leadId: LEAD } }), 'Lead was contacted');
    mockTables.notifications = [bell];
    expect(await runAdminAlertRelevanceSweep({ now: NOW })).toMatchObject({ rearmed: 0, retired: 0 });
    expect([bell.done_by, bell.resolution]).toEqual(['relevance', 'Lead was contacted']);
  });

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

test('the last-name suggestion prefix here is the emitter\'s own (the two files each hold the constant)', () => {
  const emitter = jest.requireActual('../services/call-last-name-lookup').SUGGESTION_KEY_PREFIX;
  const src = require('fs').readFileSync(require.resolve('../services/admin-alert-relevance'), 'utf8');
  expect(emitter).toBe('call-last-name-suggestion:');
  expect(src).toContain(`const SUGGESTION_KEY_PREFIX = '${emitter}';`);
});

// ---- customer-contact classes (GATE_ALERT_CONTACT_CLOSE) -------------------------------------
describe('customer-contact classes', () => {
  const T0 = new Date('2026-09-27T12:00:00Z');
  const at = (minutes) => new Date(T0.getTime() + minutes * 60 * 1000);
  const gate = (mode) => { process.env.GATE_ALERT_CONTACT_CLOSE = mode; };
  const SID = 'SM0000000000000000000000000000aa01';
  const CALL = uid(41);
  const EMAIL = uid(42);

  const smsThread = (over = {}) => note({ category: 'inbound_sms', link: `/admin/communications?thread=${CUST}&message=${SID}`,
    metadata: { triggerKey: 'sms_reply', dedupeKey: `sms-thread:${CUST}`, payload: { twilioSid: SID, threadId: CUST } }, ...over });
  const smsUnknown = () => note({ category: 'inbound_sms', link: `/admin/communications?message=${SID}`,
    metadata: { triggerKey: 'sms_reply', dedupeKey: `sms-reply:${SID}`, payload: { twilioSid: SID, threadId: null } } });
  const voicemail = () => note({ category: 'voicemail_callback', metadata: { triggerKey: 'customer_voicemail_callback', payload: { callLogId: CALL, customerId: CUST, phone: '+15555550101' } } });
  const missed = () => note({ category: 'missed_call', metadata: { triggerKey: 'customer_missed_call', payload: { callLogId: CALL, customerId: CUST, phone: '+15555550101' } } });
  const email = () => note({ category: 'inbound_email', metadata: { triggerKey: 'customer_email_received', payload: { emailId: EMAIL, customerId: CUST } } });
  // A bundle as the witnesses module hands it back; every witness absent unless a test sets it.
  const bundle = (over = {}) => ({ anchor: T0, pending: null, textAt: null, backAt: null, inAt: null, visitAt: null, quote: false, replyAt: null, ...over });
  const verdictFor = async (row, bundleOver = null) => {
    mockBundles = new Map(bundleOver ? [[String(row.id), bundle(bundleOver)]] : []);
    const cls = classify(row);
    const data = await loadSubjects([row]);
    return { cls: cls?.key ?? null, ...judge(cls, subjectFor(row, data, TODAY)) };
  };

  test.each([
    [undefined, 'off'], ['', 'off'], ['true ', 'true'], ['TRUE', 'true'], [' Shadow', 'shadow'], ['shadow', 'shadow'], ['on', 'off'], ['1', 'off'], ['false', 'off'],
  ])('GATE_ALERT_CONTACT_CLOSE=%j -> %s', (value, mode) => {
    if (value === undefined) delete process.env.GATE_ALERT_CONTACT_CLOSE; else process.env.GATE_ALERT_CONTACT_CLOSE = value;
    expect(alertContactCloseMode()).toBe(mode);
  });

  test('the classes exist only while the gate is shadow or true, and match by the emitter\'s trigger (a missed-call bell has no class here: missed-call-bell.js owns it; the promise chaser keeps its own)', () => {
    const rows = { sms: smsThread(), voicemail: voicemail(), email: email() };
    for (const row of Object.values(rows)) expect(classify(row)).toBeNull();
    for (const mode of ['shadow', 'true']) {
      gate(mode);
      expect(Object.fromEntries(Object.entries(rows).map(([k, row]) => [k, classify(row)?.key])))
        .toEqual({ sms: 'inbound_sms', voicemail: 'voicemail_callback', email: 'inbound_email' });
    }
    gate('true');
    for (const other of [
      missed(),
      note({ category: 'missed_call', metadata: { triggerKey: 'repeat_caller', payload: { callLogId: CALL } } }),
      note({ category: 'missed_call', metadata: { triggerKey: 'relay_unbooked_call', payload: { callLogId: CALL } } }),
      note({ category: 'inbound_sms', metadata: { payload: { twilioSid: SID } } }),
      note({ category: 'inbound_email', metadata: { triggerKey: 'something_else' } }),
      note({ category: 'review', metadata: { triggerKey: 'sms_reply' } }),
    ]) expect(classify(other)).toBeNull();
    // The promise chaser keeps its own class and owner.
    expect(classify(note({ category: 'missed_call', metadata: { triggerKey: 'promise_chaser', dedupeKey: 'promise_chaser:p:d' } })).key).toBe('promise_chaser');
    // The re-arm pass asks for them in every mode.
    delete process.env.GATE_ALERT_CONTACT_CLOSE;
    expect(classify(smsThread(), { anyMode: true }).key).toBe('inbound_sms');
  });

  test('the emitter\'s thread-bell key prefix is the one this module reads', () => {
    const source = require('fs').readFileSync(require.resolve('../services/sms-reply-alert-delivery'), 'utf8');
    expect(source).toContain('const threadBellKey = (customerId) => `sms-thread:${customerId}`;');
    expect(classify(smsThread(), { anyMode: true }).key).toBe('inbound_sms');
  });

  test('the loader gets each row\'s own references (a known sender\'s text sid and customer, a call, an email, a lead\'s phone), never an unknown sender\'s text, and is not called with the gate off', async () => {
    const rows = [smsThread(), smsUnknown(), voicemail(), email(), { ...leadNote(), id: uid(77) }];
    mockTables.leads = [lead({ phone: '+15555550102' })];
    await loadSubjects(rows);
    expect(mockLoadContactBundles).not.toHaveBeenCalled();
    gate('shadow');
    await loadSubjects(rows);
    const items = mockLoadContactBundles.mock.calls[0][0];
    expect(items.map((i) => [i.kind, i.refs])).toEqual([
      ['sms', { sid: SID, customerId: CUST }],
      ['voice', { callLogId: CALL, customerId: CUST, phone: '+15555550101' }],
      ['email', { emailId: EMAIL, customerId: CUST }],
      ['lead', { customerId: CUST, phone: '+15555550102' }],
    ]);
    // A bad id parses to null, never throws.
    mockLoadContactBundles.mockClear();
    await loadSubjects([note({ category: 'voicemail_callback', metadata: { triggerKey: 'customer_voicemail_callback', payload: { callLogId: 'nope', customerId: 'nope' } } })]);
    expect(mockLoadContactBundles.mock.calls[0][0][0].refs).toMatchObject({ callLogId: null, customerId: null });
  });

  describe('rules', () => {
    beforeEach(() => gate('true'));

    test('a text: closed once the Messages reader no longer counts the conversation, with the witness named; still pending, an unidentified text or a failed read stay', async () => {
      expect((await verdictFor(smsThread(), { pending: true })).reason).toBeNull();
      expect((await verdictFor(smsThread(), { pending: null })).reason).toBeNull();
      expect((await verdictFor(smsThread())).reason).toBeNull();
      expect((await verdictFor(smsThread(), { pending: false, textAt: at(10) })).reason).toBe('Answered by text');
      expect((await verdictFor(smsThread(), { pending: false, backAt: at(10) })).reason).toBe('Answered by a call');
      expect((await verdictFor(smsThread(), { pending: false, inAt: at(10) })).reason).toBe('Answered by a call');
      // A courtesy text, or one the assistant answered: the reader says nothing is waiting and no person witness is named.
      expect((await verdictFor(smsThread(), { pending: false })).reason).toBe('Answered, or no reply needed');
      // A shared phone: the reader's verdict is not used, only this customer's own evidence.
      expect((await verdictFor(smsThread(), { shared: true, pending: false })).reason).toBeNull();
      expect((await verdictFor(smsThread(), { shared: true, pending: true, textAt: at(10) })).reason).toBe('Answered by text');
      expect((await verdictFor(smsThread(), { shared: true, pending: false, backAt: at(10) })).reason).toBe('Answered by a call');
      expect((await verdictFor(smsThread(), { shared: true, pending: false, textAt: at(-10), backAt: at(-10) })).reason).toBeNull();
      // A person's text or call from BEFORE the text never names the answer.
      expect((await verdictFor(smsThread(), { pending: false, textAt: at(-30), backAt: at(-30) })).reason).toBe('Answered, or no reply needed');
      // An unknown sender's text bell is never judged (no references, so no bundle), whatever was sent to the number.
      expect((await verdictFor(smsUnknown(), { pending: false, textAt: at(5) })).reason).toBeNull();
    });

    test.each([['voicemail', voicemail]])('a %s: a person\'s call back, a call in a person answered, a person\'s text, a booked visit or a quote after the call closes it; nothing, or only earlier contact, keeps it', async (_name, make) => {
      expect((await verdictFor(make(), {})).reason).toBeNull();
      expect((await verdictFor(make())).reason).toBeNull();
      expect((await verdictFor(make(), { backAt: at(20) })).reason).toBe('A person called back');
      expect((await verdictFor(make(), { inAt: at(20) })).reason).toBe('A person answered their call');
      expect((await verdictFor(make(), { textAt: at(20) })).reason).toBe('Answered by text');
      expect((await verdictFor(make(), { visitAt: at(20) })).reason).toBe('A visit was booked');
      expect((await verdictFor(make(), { quote: true })).reason).toBe('Estimate was sent');
      // Every witness from before the call (or at the same instant) is ignored.
      expect((await verdictFor(make(), { backAt: at(-5), inAt: at(-5), textAt: at(-5), visitAt: at(-5), replyAt: at(-5) })).reason).toBeNull();
      expect((await verdictFor(make(), { backAt: T0, textAt: T0 })).reason).toBeNull();
      // The call back outranks the weaker witnesses.
      expect((await verdictFor(make(), { backAt: at(20), textAt: at(10), visitAt: at(5) })).reason).toBe('A person called back');
    });

    test('an email: a person\'s reply in its thread, else the same witnesses as a call; an earlier reply or none keeps it', async () => {
      expect((await verdictFor(email(), {})).reason).toBeNull();
      expect((await verdictFor(email(), { replyAt: at(30) })).reason).toBe('Answered by email');
      expect((await verdictFor(email(), { replyAt: at(-30) })).reason).toBeNull();
      expect((await verdictFor(email(), { textAt: at(30) })).reason).toBe('Answered by text');
      expect((await verdictFor(email(), { backAt: at(30), replyAt: at(40) })).reason).toBe('Answered by email');
      expect((await verdictFor(email(), { visitAt: at(30) })).reason).toBe('A visit was booked');
      expect((await verdictFor(email(), { quote: true })).reason).toBe('Estimate was sent');
    });

    test('a new lead: "Lead was contacted" by a person\'s text or call back after the bell, only when the gate is true; its own reasons stay always on', async () => {
      const row = { ...leadNote(), id: uid(78) };
      mockTables.leads = [lead()];
      expect(await verdictFor(row, { anchor: T0 })).toMatchObject({ cls: 'new_lead', reason: null, would: null });
      expect((await verdictFor(row, { textAt: at(20) })).reason).toBe('Lead was contacted');
      expect((await verdictFor(row, { backAt: at(20) })).reason).toBe('Lead was contacted');
      expect((await verdictFor(row, { textAt: at(-20), backAt: at(-20) })).reason).toBeNull();
      // Shadow: the reason is only what WOULD close.
      gate('shadow');
      expect(await verdictFor(row, { textAt: at(20) })).toMatchObject({ reason: null, would: 'Lead was contacted' });
      // Off: the class keeps its old reasons and nothing else.
      delete process.env.GATE_ALERT_CONTACT_CLOSE;
      expect(await verdictFor(row, { textAt: at(20) })).toMatchObject({ reason: null, would: null });
      mockTables.leads = [lead({ deleted_at: AFTER_BELL })];
      expect((await verdictFor(row)).reason).toBe('Lead was deleted');
      // A lead row that is gone is unknown, never contacted.
      gate('true');
      mockTables.leads = [];
      expect((await verdictFor(row, { textAt: at(20) })).reason).toBeNull();
    });
  });

  describe('the sweep', () => {
    const answered = (row, over = {}) => mockBundles.set(String(row.id), bundle({ pending: false, textAt: at(10), ...over }));
    const NOW_AFTER = new Date('2026-09-28T16:00:00Z');

    test('gate off: the classes are not in the table, so nothing about them is read, recorded or closed (the candidate query\'s own filter runs in the Postgres suite)', async () => {
      const row = smsThread();
      mockTables.notifications = [row];
      answered(row);
      const result = await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
      expect(result).toEqual({ skipped: false, scanned: 1, retired: 0, byClass: {}, rearmed: 0 });
      expect(row.done_at ?? null).toBeNull();
      expect(mockLoadContactBundles).not.toHaveBeenCalled();
      expect(mockAuditWouldClose).not.toHaveBeenCalled();
    });

    test('shadow: records what would close (class, reason, bell id, ET day) and changes nothing on the bell; a person\'s own Done is not recorded', async () => {
      gate('shadow');
      const open = smsThread();
      const mail = email();
      const waiting = voicemail();
      const personDone = { ...voicemail(), done_at: new Date('2026-09-27T14:00:00Z'), done_by: '7', read_at: new Date('2026-09-27T14:00:00Z') };
      mockTables.notifications = [open, mail, waiting, personDone];
      answered(open);
      mockBundles.set(String(mail.id), bundle({ replyAt: at(30) }));
      mockBundles.set(String(waiting.id), bundle());
      mockBundles.set(String(personDone.id), bundle({ backAt: at(30) }));
      const snapshot = JSON.stringify(mockTables.notifications);

      const result = await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
      expect(result).toMatchObject({ skipped: false, scanned: 4, retired: 0, byClass: {}, wouldClose: 2 });
      expect(JSON.stringify(mockTables.notifications)).toBe(snapshot);
      expect(mockAuditWouldClose).toHaveBeenCalledTimes(1);
      expect(mockAuditWouldClose.mock.calls[0][0]).toEqual({
        et_day: '2026-09-28',
        items: [
          { notification_id: open.id, alert_class: 'inbound_sms', reason: 'Answered by text', judged_at: NOW_AFTER.toISOString() },
          { notification_id: mail.id, alert_class: 'inbound_email', reason: 'Answered by email', judged_at: NOW_AFTER.toISOString() },
        ],
      });
    });

    test('shadow: a failing audit write is logged and never fails the sweep', async () => {
      gate('shadow');
      const row = smsThread();
      mockTables.notifications = [row];
      answered(row);
      mockAuditWouldClose.mockRejectedValueOnce(new Error('audit down'));
      expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ skipped: false, scanned: 1, retired: 0, wouldClose: 0 });
      expect(row.done_at ?? null).toBeNull();
    });

    test('true: closes the row with the reason as its resolution (done_by relevance, retired stamp), only the rows whose witnesses say so', async () => {
      gate('true');
      const open = smsThread();
      const waiting = voicemail();
      const mail = email();
      mockTables.notifications = [open, waiting, mail];
      answered(open, { textAt: null, backAt: at(10) });
      mockBundles.set(String(waiting.id), bundle());
      mockBundles.set(String(mail.id), bundle({ visitAt: at(10) }));
      const result = await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
      expect(result).toEqual({ skipped: false, scanned: 3, retired: 2, byClass: { inbound_sms: 1, inbound_email: 1 }, rearmed: 0 });
      expect(open).toMatchObject({ read_at: NOW_AFTER, done_at: NOW_AFTER, done_by: 'relevance', resolution: 'Answered by a call' });
      expect(JSON.parse(open.metadata).retired).toEqual({ by: 'alert-relevance', reason: 'Answered by a call', at: NOW_AFTER.toISOString() });
      expect(mail).toMatchObject({ done_by: 'relevance', resolution: 'A visit was booked' });
      expect(waiting.done_at ?? null).toBeNull();
      expect(mockAuditWouldClose).not.toHaveBeenCalled();
    });

    test('true: the retire is judged on a fresh read — a text that arrives between the batch read and the write keeps the bell', async () => {
      gate('true');
      const row = smsThread();
      mockTables.notifications = [row];
      let reads = 0;
      mockBundles = () => {
        reads += 1;
        // Read 1 = the batch, 2 = the fresh read before the write: the sender texted again by then.
        return new Map([[String(row.id), bundle({ pending: reads >= 2, textAt: at(10) })]]);
      };
      const result = await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
      expect(result).toMatchObject({ retired: 0 });
      expect(row.done_at ?? null).toBeNull();
      expect(reads).toBe(2);
    });

    test('true: witnesses that fail to load are no verdict — nothing is closed, and a retire already written is put back', async () => {
      gate('true');
      const row = smsThread();
      mockTables.notifications = [row];
      mockBundles = () => { throw new Error('witness query failed'); };
      expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ scanned: 1, retired: 0 });
      expect(row.done_at ?? null).toBeNull();
      // Batch and fresh reads fine, the final check fails: the bell goes back exactly as it was.
      let reads = 0;
      mockBundles = () => {
        reads += 1;
        if (reads >= 3) throw new Error('witness query failed');
        return new Map([[String(row.id), bundle({ pending: false, textAt: at(10) })]]);
      };
      expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ retired: 0 });
      expect(row.done_at ?? null).toBeNull();
      expect(row.read_at ?? null).toBeNull();
      expect(JSON.parse(row.metadata).retired).toBeUndefined();
    });

    test('true: a person\'s own Done on a text that was answered is taken over (done_by relevance); the kill switch stops it all', async () => {
      gate('true');
      const doneAt = new Date('2026-09-27T14:00:00Z');
      const row = { ...smsThread(), read_at: doneAt, done_at: doneAt, done_by: '7', resolution: 'Handled' };
      mockTables.notifications = [row];
      answered(row);
      await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
      expect(row).toMatchObject({ done_by: 'relevance', resolution: 'Handled' });
      expect(row.done_at).toEqual(doneAt);
      process.env.ADMIN_ALERT_RELEVANCE = 'off';
      mockLoadContactBundles.mockClear();
      expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toEqual({ skipped: true, reason: 'switch_off' });
      expect(mockLoadContactBundles).not.toHaveBeenCalled();
    });
  });

  describe('re-arm', () => {
    const AT = '2026-09-27T16:00:00.123Z';
    const closed = (row, reason) => {
      row.read_at = new Date(AT);
      row.done_at = new Date(AT);
      row.done_by = 'relevance';
      row.resolution = reason;
      row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), retired: { by: 'alert-relevance', reason, at: AT } });
      return row;
    };
    const NOW_AFTER = new Date('2026-09-28T16:00:00Z');

    test('an unknown sender\'s text bell is never judged: never closed whatever the witnesses say, and a close this class once wrote on one is put back (nothing holds it)', async () => {
      gate('true');
      const unknown = closed(smsUnknown(), 'Answered by text');
      const open = smsUnknown();
      open.id = uid(900);
      mockTables.notifications = [unknown, open];
      mockBundles = new Map([[String(unknown.id), bundle({ pending: true })], [String(open.id), bundle({ pending: false, textAt: at(10) })]]);
      const result = await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
      expect(result).toMatchObject({ rearmed: 1, retired: 0 });
      expect(unknown.done_at ?? null).toBeNull();
      expect(open.done_at ?? null).toBeNull();
      expect(mockAuditWouldClose).not.toHaveBeenCalled();
    });

    test('a call bell whose visit was cancelled again is put back; a failed witness load leaves every closed row as it is', async () => {
      gate('true');
      const row = closed(voicemail(), 'A visit was booked');
      mockTables.notifications = [row];
      mockBundles = new Map([[String(row.id), bundle({ visitAt: at(20) })]]);
      expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(0);
      expect(row.done_by).toBe('relevance');
      mockBundles = () => { throw new Error('witness query failed'); };
      expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(0);
      expect(row.done_by).toBe('relevance');
      mockBundles = new Map([[String(row.id), bundle()]]);
      expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(1);
      expect(row.done_at ?? null).toBeNull();
    });

    test('switching the gate off or back to shadow puts back what the contact classes closed (a rollback restores the bell); an always-on class stays closed', async () => {
      const sms = closed(smsThread(), 'Answered by text');
      const stale = closed(staleNote(uid(901)), 'Visit is no longer in progress');
      mockTables['scheduled_services as ss'] = [visit({ status: 'completed' })];
      mockTables.notifications = [sms, stale];
      expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(1);
      expect(sms.done_at ?? null).toBeNull();
      expect(stale.done_by).toBe('relevance');
      closed(sms, 'Answered by text');
      gate('shadow');
      mockBundles = new Map([[String(sms.id), bundle({ pending: false, textAt: at(10) })]]);
      expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(1);
      expect(sms.done_at ?? null).toBeNull();
    });
  });

  // ---- own gates (owner 2026-10-29, "Stuck Alert Fixes" F3 and F5) ---------------------------
  describe('own gates', () => {
    const VISIT_RESOLUTION = "The customer's visit went ahead after the call";
    const NOW_AFTER = new Date('2026-09-28T16:00:00Z');
    const f3 = (mode) => { if (mode === undefined) delete process.env.GATE_VOICEMAIL_VISIT_UNDERWAY; else process.env.GATE_VOICEMAIL_VISIT_UNDERWAY = mode; };
    const f5 = (mode) => { if (mode === undefined) delete process.env.GATE_LEAD_CONTACTED_CLOSE; else process.env.GATE_LEAD_CONTACTED_CLOSE = mode; };
    // The Leads bell the four lead emitters raise (metadata.leadId + the link's ?lead=, doneWhen lead_contacted).
    const leadAlert = (over = {}) => note({
      category: 'lead', link: `/admin/leads?lead=${LEAD}`,
      metadata: { dedupeKey: `sms-lead:${LEAD}`, doneWhen: 'lead_contacted', leadId: LEAD, source: 'sms_lead_extraction', ...over },
    });
    const judged = async (row, bundleOver = null, opts = {}) => {
      mockBundles = new Map(bundleOver ? [[String(row.id), bundle(bundleOver)]] : []);
      const cls = classify(row, opts);
      if (!cls) return { cls: null, reason: null, would: null };
      const data = await loadSubjects([row]);
      return { cls: cls.key, ...judge(cls, subjectFor(row, data, TODAY)) };
    };
    const closedRow = (row, reason) => {
      const stampAt = '2026-09-27T16:00:00.123Z';
      row.read_at = new Date(stampAt);
      row.done_at = new Date(stampAt);
      row.done_by = 'relevance';
      row.resolution = reason;
      row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), retired: { by: 'alert-relevance', reason, at: stampAt } });
      return row;
    };

    test.each([
      [undefined, 'off'], ['', 'off'], ['on', 'off'], ['1', 'off'], ['false', 'off'], [' Shadow', 'shadow'], ['TRUE ', 'true'], ['true', 'true'],
    ])('GATE_VOICEMAIL_VISIT_UNDERWAY and GATE_LEAD_CONTACTED_CLOSE = %j -> %s', (value, mode) => {
      f3(value); f5(value);
      expect([voicemailVisitUnderwayMode(), leadContactedCloseMode()]).toEqual([mode, mode]);
    });

    describe('voicemail: the visit went ahead (GATE_VOICEMAIL_VISIT_UNDERWAY)', () => {
      beforeEach(() => gate('true'));
      const ran = { visitRanAt: at(30) };

      test('off: no reason and nothing asked of the witnesses; shadow: would only; true: the missed-call lane\'s wording', async () => {
        expect(await judged(voicemail(), ran)).toMatchObject({ cls: 'voicemail_callback', reason: null, would: null });
        await loadSubjects([voicemail()]);
        expect(mockLoadContactBundles.mock.calls[0][1].visitRan).toBe(false);
        f3('shadow');
        expect(await judged(voicemail(), ran)).toMatchObject({ reason: null, would: VISIT_RESOLUTION });
        mockLoadContactBundles.mockClear();
        await loadSubjects([voicemail()]);
        expect(mockLoadContactBundles.mock.calls[0][1].visitRan).toBe(true);
        f3('true');
        expect(await judged(voicemail(), ran)).toMatchObject({ reason: VISIT_RESOLUTION, would: null });
        expect(VISIT_RESOLUTION).toBe(require('../services/missed-call-bell').VISIT_UNDERWAY_RESOLUTION);
      });

      test('it applies only when no contact witness does, and only after the call (a visit before it, or no visit, closes nothing)', async () => {
        f3('true');
        for (const [over, reason] of [
          [{ backAt: at(20), visitRanAt: at(30) }, 'A person called back'],
          [{ inAt: at(20), visitRanAt: at(30) }, 'A person answered their call'],
          [{ textAt: at(20), visitRanAt: at(30) }, 'Answered by text'],
          [{ visitAt: at(20), visitRanAt: at(30) }, 'A visit was booked'],
          [{ quote: true, visitRanAt: at(30) }, 'Estimate was sent'],
          [{ visitRanAt: at(30) }, VISIT_RESOLUTION],
          [{ visitRanAt: at(-5) }, null],
          [{ visitRanAt: T0 }, null],
          [{ visitRanAt: null }, null],
        ]) expect((await judged(voicemail(), over)).reason).toBe(reason);
      });

      test('it never closes more than the contact gate allows, and an email bell never gets it', async () => {
        f3('true');
        gate('shadow');
        expect(await judged(voicemail(), ran)).toMatchObject({ reason: null, would: VISIT_RESOLUTION });
        gate('true');
        expect(await judged(email(), ran)).toMatchObject({ cls: 'inbound_email', reason: null, would: null });
        // With the contact gate off the class is not offered at all, whatever this gate says.
        delete process.env.GATE_ALERT_CONTACT_CLOSE;
        expect(classify(voicemail())).toBeNull();
      });

      test('the sweep: shadow records it and closes nothing; true closes with the wording; the gate switched off puts the bell back', async () => {
        const row = voicemail();
        mockTables.notifications = [row];
        mockBundles = new Map([[String(row.id), bundle(ran)]]);
        f3('shadow');
        const shadowRun = await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
        expect(shadowRun).toMatchObject({ retired: 0, wouldClose: 1 });
        expect(mockAuditWouldClose.mock.calls[0][0].items).toEqual([
          { notification_id: row.id, alert_class: 'voicemail_callback', reason: VISIT_RESOLUTION, judged_at: NOW_AFTER.toISOString() },
        ]);
        expect(row.done_at ?? null).toBeNull();
        f3('true');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ retired: 1, byClass: { voicemail_callback: 1 } });
        expect(row).toMatchObject({ done_by: 'relevance', resolution: VISIT_RESOLUTION });
        // The witness still says the visit ran, but the gate is off: the re-arm pass puts the bell back.
        f3(undefined);
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ rearmed: 1 });
        expect(row.done_at ?? null).toBeNull();
        expect(JSON.parse(row.metadata).retired).toBeUndefined();
      });
    });

    describe('a text: a staff action answers it (GATE_SMS_STAFF_ACTION_ANSWERS)', () => {
      beforeEach(() => gate('true'));
      const f1 = (mode) => { if (mode === undefined) delete process.env.GATE_SMS_STAFF_ACTION_ANSWERS; else process.env.GATE_SMS_STAFF_ACTION_ANSWERS = mode; };
      const booked = { staffActionAt: at(10), staffActionKind: 'visit' };
      const paid = { staffActionAt: at(10), staffActionKind: 'payment' };

      test.each([
        [undefined, 'off'], ['', 'off'], ['on', 'off'], ['1', 'off'], ['false', 'off'], [' Shadow', 'shadow'], ['TRUE ', 'true'], ['true', 'true'],
      ])('GATE_SMS_STAFF_ACTION_ANSWERS = %j -> %s', (value, mode) => {
        f1(value);
        expect(staffActionAnswersMode()).toBe(mode);
      });

      test('off: no reason and the witnesses are not asked; shadow: would only, with the action named; true: closes with the action named', async () => {
        expect(await judged(smsThread(), { pending: true, ...booked })).toMatchObject({ cls: 'inbound_sms', reason: null, would: null });
        await loadSubjects([smsThread()]);
        expect(mockLoadContactBundles.mock.calls[0][1].staffActions).toBe(false);
        f1('shadow');
        expect(await judged(smsThread(), { pending: true, ...booked })).toMatchObject({ reason: null, would: 'A visit was booked' });
        expect(await judged(smsThread(), { pending: true, ...paid })).toMatchObject({ reason: null, would: 'A payment was recorded' });
        mockLoadContactBundles.mockClear();
        await loadSubjects([smsThread()]);
        expect(mockLoadContactBundles.mock.calls[0][1].staffActions).toBe(true);
        f1('true');
        expect(await judged(smsThread(), { pending: true, ...booked })).toMatchObject({ reason: 'A visit was booked', would: null });
        expect(await judged(smsThread(), { pending: true, ...paid })).toMatchObject({ reason: 'A payment was recorded', would: null });
        // The contact gate caps it: in shadow the staff reason is a would-close even with its own gate true.
        gate('shadow');
        expect(await judged(smsThread(), { pending: true, ...booked })).toMatchObject({ reason: null, would: 'A visit was booked' });
      });

      test('nothing before the text counts, and no action keeps a pending text; a text with no customer-id action stays', async () => {
        f1('true');
        expect((await judged(smsThread(), { pending: true, staffActionAt: at(-5), staffActionKind: 'visit' })).reason).toBeNull();
        expect((await judged(smsThread(), { pending: true, staffActionAt: T0, staffActionKind: 'visit' })).reason).toBeNull();
        expect((await judged(smsThread(), { pending: true, staffActionAt: null, staffActionKind: null })).reason).toBeNull();
        expect((await judged(smsThread(), { pending: true, staffActionAt: at(10), staffActionKind: 'unknown' })).reason).toBeNull();
      });

      test('a shared phone: the customer-id action closes it; with none it stays, and a text or call still comes first', async () => {
        f1('true');
        expect((await judged(smsThread(), { shared: true, pending: false })).reason).toBeNull();
        expect((await judged(smsThread(), { shared: true, pending: true, ...booked })).reason).toBe('A visit was booked');
        expect((await judged(smsThread(), { shared: true, pending: false, ...paid })).reason).toBe('A payment was recorded');
        expect((await judged(smsThread(), { shared: true, pending: false, textAt: at(5), ...booked })).reason).toBe('Answered by text');
        expect((await judged(smsThread(), { shared: true, pending: false, backAt: at(5), ...booked })).reason).toBe('Answered by a call');
        f1('shadow');
        expect(await judged(smsThread(), { shared: true, pending: false, ...booked })).toMatchObject({ reason: null, would: 'A visit was booked' });
      });

      test('the plain fallback: a text or call comes first, the action next (true), the plain words last; in shadow the real close keeps its plain reason', async () => {
        f1('true');
        expect((await judged(smsThread(), { pending: false, textAt: at(5), ...booked })).reason).toBe('Answered by text');
        expect((await judged(smsThread(), { pending: false, inAt: at(5), ...booked })).reason).toBe('Answered by a call');
        expect((await judged(smsThread(), { pending: false, ...booked })).reason).toBe('A visit was booked');
        expect((await judged(smsThread(), { pending: false, ...paid })).reason).toBe('A payment was recorded');
        expect((await judged(smsThread(), { pending: false })).reason).toBe('Answered, or no reply needed');
        f1('shadow');
        expect(await judged(smsThread(), { pending: false, ...booked })).toMatchObject({ reason: 'Answered, or no reply needed', would: null });
        f1(undefined);
        expect(await judged(smsThread(), { pending: false, ...booked })).toMatchObject({ reason: 'Answered, or no reply needed', would: null });
      });

      test('the sweep: shadow records it and closes nothing; true closes with the wording; the gate switched off puts the bell back', async () => {
        const NOW_AFTER_F1 = new Date('2026-09-28T16:00:00Z');
        const row = smsThread();
        mockTables.notifications = [row];
        mockBundles = new Map([[String(row.id), bundle({ pending: true, ...booked })]]);
        f1('shadow');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER_F1 })).toMatchObject({ retired: 0, wouldClose: 1 });
        expect(mockAuditWouldClose.mock.calls[0][0].items).toEqual([
          { notification_id: row.id, alert_class: 'inbound_sms', reason: 'A visit was booked', judged_at: NOW_AFTER_F1.toISOString() },
        ]);
        expect(row.done_at ?? null).toBeNull();
        f1('true');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER_F1 })).toMatchObject({ retired: 1, byClass: { inbound_sms: 1 } });
        expect(row).toMatchObject({ done_by: 'relevance', resolution: 'A visit was booked' });
        f1(undefined);
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER_F1 })).toMatchObject({ rearmed: 1 });
        expect(row.done_at ?? null).toBeNull();
      });
    });

    describe('lead_contacted Leads bells (GATE_LEAD_CONTACTED_CLOSE)', () => {
      beforeEach(() => { mockTables.leads = [lead()]; });

      test('the class exists only while its gate is shadow or true (the contact gate does not matter), and matches only doneWhen lead_contacted with a lead id', () => {
        const row = leadAlert();
        expect(classify(row)).toBeNull();
        expect(classify(row, { anyMode: true }).key).toBe('lead_contacted');
        for (const mode of ['shadow', 'true']) {
          f5(mode);
          expect(classify(row).key).toBe('lead_contacted');
        }
        f5('true');
        // The lead id may sit in metadata.leadId or the link's ?lead=; the other four emitters differ only by key.
        expect(classify(leadAlert({ leadId: undefined })).key).toBe('lead_contacted');
        expect(classify(note({ category: 'lead', metadata: { doneWhen: 'lead_contacted', leadId: LEAD } })).key).toBe('lead_contacted');
        for (const key of ['lead-call-text-followup:r1', 'lead-call-reply-missed:c1', `lead-unverified-hold:${LEAD}`]) {
          expect(classify(leadAlert({ dedupeKey: key })).key).toBe('lead_contacted');
        }
        // A bid invite, an FYI, a repeat-form bell (its own class), a customer-only bell and other categories never match.
        expect(classify(leadAlert({ doneWhen: 'bid_decided' }))).toBeNull();
        expect(classify(leadAlert({ doneWhen: 'already_done' }))).toBeNull();
        expect(classify(note({ category: 'lead', link: '/admin/bids', metadata: { doneWhen: 'lead_contacted' } }))).toBeNull();
        expect(classify(note({ category: 'lead', link: `/admin/customers?customerId=${CUST}`, metadata: { doneWhen: 'lead_contacted', leadId: null } }))).toBeNull();
        expect(classify(note({ category: 'lead', metadata: { dedupeKey: `lead-repeat-form:${CUST}`, doneWhen: 'lead_contacted', leadId: LEAD } })).key).toBe('lead_repeat_form');
        expect(classify(note({ category: 'alert', metadata: { doneWhen: 'lead_contacted', leadId: LEAD } }))).toBeNull();
      });

      test('off = no reason; shadow = would only; true = the reason, whatever the contact gate says', async () => {
        const reach = { textAt: at(20) };
        expect(await judged(leadAlert(), reach)).toMatchObject({ cls: null, reason: null, would: null });
        expect(await judged(leadAlert(), reach, { anyMode: true })).toMatchObject({ cls: 'lead_contacted', reason: null, would: null });
        f5('shadow');
        expect(await judged(leadAlert(), reach)).toMatchObject({ reason: null, would: 'Lead was contacted' });
        f5('true');
        expect(await judged(leadAlert(), reach)).toMatchObject({ reason: 'Lead was contacted', would: null });
        gate('shadow');
        expect(await judged(leadAlert(), reach)).toMatchObject({ reason: 'Lead was contacted', would: null });
      });

      test('the three reasons, each only from a fact after the bell; a missing lead row is unknown', async () => {
        f5('true');
        const row = () => leadAlert();
        expect((await judged(row(), { textAt: at(20) })).reason).toBe('Lead was contacted');
        expect((await judged(row(), { backAt: at(20) })).reason).toBe('Lead was contacted');
        expect((await judged(row(), { textAt: at(-20), backAt: at(-20), inAt: at(20), visitAt: at(20), quote: true })).reason).toBeNull();
        mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: AFTER_BELL }];
        expect((await judged(row())).reason).toBe('A visit was booked');
        mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: BEFORE_BELL }];
        expect((await judged(row())).reason).toBeNull();
        mockTables.scheduled_services = [
          { customer_id: CUST, latest_created_at: AFTER_BELL, recurring_parent_id: VISIT },
          { customer_id: CUST, latest_created_at: AFTER_BELL, parent_service_id: VISIT },
        ];
        expect((await judged(row())).reason).toBeNull();
        mockTables.scheduled_services = [];
        // The handoff witness (the fake answers it with the estimates it holds); asked of the lead's customer.
        mockTables.estimates = [{ id: EST, customer_id: CUST, sent_at: AFTER_BELL }];
        expect((await judged(row())).reason).toBe('Estimate was sent');
        mockTables.estimates = [];
        expect((await judged(row())).reason).toBeNull();
        // A lead row that is gone is unknown: nothing closes it, whatever else is on file. (That a bare
        // estimates.sent_at is not the witness is proved in the Postgres suite.)
        mockTables.leads = [];
        mockTables.estimates = [{ id: EST, customer_id: CUST, sent_at: AFTER_BELL }];
        expect((await judged(row(), { textAt: at(20) })).reason).toBeNull();
      });

      test('a refreshed bell is judged from its LATEST event: contact, a booking or a handoff that predates the refresh (rungAt) never settles the new request; one after it does', async () => {
        f5('true');
        // The bell rang at T0 (note's created_at) and was refreshed with new content at T0+60 (a ringing refresh stamps rungAt
        // and keeps created_at). An evidence boundary of T0 would let the earlier reply close it.
        const refreshed = () => leadAlert({ rungAt: at(60).toISOString() });
        const bundleAt = (over) => ({ anchor: at(60), ...over });
        const asked = async (row, over) => {
          mockBundles = new Map([[String(row.id), bundle(bundleAt(over))]]);
          const data = await loadSubjects([row]);
          return judge(classify(row), subjectFor(row, data, TODAY));
        };
        // The witnesses are asked from the refresh, not from the first ring.
        await asked(refreshed(), {});
        expect(mockLoadContactBundles.mock.calls.pop()[0][0].bellAt).toEqual(at(60));
        // A later created_at (bumpOnRefresh) wins over an older rungAt; a bad stamp is ignored.
        mockLoadContactBundles.mockClear();
        await loadSubjects([leadAlert({ rungAt: at(-30).toISOString() }), { ...leadAlert({ rungAt: 'not a date' }), id: uid(95) }]);
        expect(mockLoadContactBundles.mock.calls[0][0].map((i) => i.bellAt)).toEqual([T0, T0]);
        // A text or call back: the bundle's own anchor is the boundary (contactAfter), so earlier contact is not "after".
        expect((await asked(refreshed(), { textAt: at(30), backAt: at(30) })).reason).toBeNull();
        expect((await asked(refreshed(), { textAt: at(90) })).reason).toBe('Lead was contacted');
        // A visit booked before the refresh does not count; one after it does.
        mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: at(30) }];
        expect((await asked(refreshed(), {})).reason).toBeNull();
        expect((await asked(leadAlert(), {})).reason).toBe('A visit was booked');
        mockTables.scheduled_services = [{ customer_id: CUST, latest_created_at: at(90) }];
        expect((await asked(refreshed(), {})).reason).toBe('A visit was booked');
        mockTables.scheduled_services = [];
        // The estimate handoff is asked from the same boundary (SQL; proved in the Postgres suite).
      });

      test('with the contact gate off, only this class reads witnesses (not the new-lead bell), and only while its gate is on', async () => {
        const mine = leadAlert();
        const intake = { ...leadNote(), id: uid(79) };
        await loadSubjects([mine, intake, smsThread()]);
        expect(mockLoadContactBundles).not.toHaveBeenCalled();
        f5('shadow');
        await loadSubjects([mine, intake, smsThread()]);
        expect(mockLoadContactBundles.mock.calls[0][0].map((i) => [i.id, i.kind])).toEqual([[mine.id, 'lead']]);
      });

      test('the sweep: shadow records and closes nothing; true closes; the gate switched off puts the bell back', async () => {
        const row = leadAlert();
        mockTables.notifications = [row];
        mockBundles = new Map([[String(row.id), bundle({ backAt: at(20) })]]);
        f5('shadow');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ scanned: 1, retired: 0, wouldClose: 1 });
        expect(mockAuditWouldClose.mock.calls[0][0].items).toEqual([
          { notification_id: row.id, alert_class: 'lead_contacted', reason: 'Lead was contacted', judged_at: NOW_AFTER.toISOString() },
        ]);
        expect(row.done_at ?? null).toBeNull();
        f5('true');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ retired: 1, byClass: { lead_contacted: 1 } });
        expect(row).toMatchObject({ done_by: 'relevance', resolution: 'Lead was contacted' });
        f5(undefined);
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ rearmed: 1, retired: 0 });
        expect(row.done_at ?? null).toBeNull();
      });

      test('re-arm: while the gate is true a close holds only while a fact after the bell does; a failed witness load leaves it', async () => {
        f5('true');
        const row = closedRow(leadAlert(), 'Lead was contacted');
        mockTables.notifications = [row];
        mockBundles = new Map([[String(row.id), bundle({ textAt: at(20) })]]);
        expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(0);
        mockBundles = () => { throw new Error('witness query failed'); };
        expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(0);
        expect(row.done_by).toBe('relevance');
        mockBundles = new Map([[String(row.id), bundle()]]);
        expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(1);
        expect(row.done_at ?? null).toBeNull();
      });
    });

    describe('portal chat hand-off bells answered by a person (GATE_PORTAL_CHAT_ANSWERED_CLOSE)', () => {
      const pc = (mode) => { if (mode === undefined) delete process.env.GATE_PORTAL_CHAT_ANSWERED_CLOSE; else process.env.GATE_PORTAL_CHAT_ANSWERED_CLOSE = mode; };
      const CONVERSATION = uid(55);
      // The bell notifyTeamOfEscalation raises (assistant.js): dedupeKey portal-chat-escalation:<id>, doneWhen
      // customer_answered, customerId in metadata. `topic` is set only for a known topic.
      const chatBell = (over = {}) => note({
        category: 'alert', link: `/admin/customers?customerId=${CUST}`,
        metadata: { dedupeKey: 'portal-chat-escalation:esc-9', doneWhen: 'customer_answered', customerId: CUST, escalationId: 'esc-9', conversationId: CONVERSATION, ...over },
      });
      const emailChangeBell = () => note({
        category: 'alert', link: `/admin/customers?customerId=${CUST}`,
        metadata: { dedupeKey: `portal-chat-email-change:${CONVERSATION}:pat@example.invalid`, doneWhen: 'email_changed', customerId: CUST, escalationId: 'esc-9', conversationId: CONVERSATION },
      });

      test.each([
        [undefined, 'off'], ['', 'off'], ['on', 'off'], ['1', 'off'], ['false', 'off'], [' Shadow', 'shadow'], ['TRUE ', 'true'], ['true', 'true'],
      ])('GATE_PORTAL_CHAT_ANSWERED_CLOSE = %j -> %s', (value, mode) => {
        pc(value);
        expect(portalChatAnsweredCloseMode()).toBe(mode);
      });

      test('the new class exists only while its gate is shadow or true; add_service chats stay in the first class; the email-change bell, a bell with no customer id and one that promises no answer never match', () => {
        gate('true');
        const row = chatBell();
        expect(classify(row)).toBeNull();
        expect(classify(row, { anyMode: true }).key).toBe('portal_chat_answered');
        for (const mode of ['shadow', 'true']) {
          pc(mode);
          expect(classify(row).key).toBe('portal_chat_answered');
          // first match wins: an add-a-service chat keeps its own class, whatever the new gate says
          expect(classify(chatBell({ topic: 'add_service' })).key).toBe('portal_chat_add_service');
          expect(classify(chatBell({ topic: 'cancellation' })).key).toBe('portal_chat_answered');
          expect(classify(emailChangeBell(), { anyMode: true })).toBeNull();
          expect(classify(chatBell({ customerId: undefined }))).toBeNull();
          expect(classify(chatBell({ customerId: 'not-an-id' }))).toBeNull();
          expect(classify(chatBell({ doneWhen: 'email_changed' }))).toBeNull();
          expect(classify(chatBell({ doneWhen: undefined }))).toBeNull();
        }
        // The class is its own: the contact gate off still lets the class be offered (judge then says nothing).
        pc('true');
        gate(undefined);
        expect(classify(row).key).toBe('portal_chat_answered');
      });

      test('the four reasons, in order, each only from a fact after the bell; booking a visit or an estimate is no reason here', async () => {
        gate('true'); pc('true');
        const row = () => chatBell();
        expect((await judged(row(), { backAt: at(20), inAt: at(20), textAt: at(20), replyAt: at(20) })).reason).toBe('A person called back');
        expect((await judged(row(), { inAt: at(20), textAt: at(20), replyAt: at(20) })).reason).toBe('A person answered their call');
        expect((await judged(row(), { textAt: at(20), replyAt: at(20) })).reason).toBe('Answered by text');
        expect((await judged(row(), { replyAt: at(20) })).reason).toBe('Answered by email');
        // before the bell, equal to it, a visit, a quote or nothing at all: still open
        expect(await judged(row(), { backAt: at(-20), inAt: at(-20), textAt: at(-20), replyAt: at(-20) })).toMatchObject({ reason: null, would: null });
        expect(await judged(row(), { backAt: T0, textAt: T0, replyAt: T0 })).toMatchObject({ reason: null, would: null });
        expect(await judged(row(), { visitAt: at(20), quote: true })).toMatchObject({ reason: null, would: null });
        expect(await judged(row(), null)).toMatchObject({ cls: 'portal_chat_answered', reason: null, would: null });
      });

      test('off = not judged, nothing read; shadow = would only; true = closes; it follows the weaker of this gate and GATE_ALERT_CONTACT_CLOSE', async () => {
        const reach = { textAt: at(20) };
        gate('true');
        expect(await judged(chatBell(), reach)).toMatchObject({ cls: null, reason: null, would: null });
        expect(await judged(chatBell(), reach, { anyMode: true })).toMatchObject({ cls: 'portal_chat_answered', reason: null, would: null });
        expect(mockLoadContactBundles).not.toHaveBeenCalled();
        pc('shadow');
        expect(await judged(chatBell(), reach)).toMatchObject({ reason: null, would: 'Answered by text' });
        pc('true');
        expect(await judged(chatBell(), reach)).toMatchObject({ reason: 'Answered by text', would: null });
        gate('shadow');
        expect(await judged(chatBell(), reach)).toMatchObject({ reason: null, would: 'Answered by text' });
        // The contact gate off: the class is offered, but nothing is judged and no witness is read.
        gate(undefined);
        mockLoadContactBundles.mockClear();
        expect(await judged(chatBell(), reach)).toMatchObject({ cls: 'portal_chat_answered', reason: null, would: null });
        expect(mockLoadContactBundles).not.toHaveBeenCalled();
      });

      test('the witnesses are asked about the customer from the bell\'s LATEST event (created_at or the re-ring\'s rungAt); contact before the re-ring never settles it', async () => {
        gate('true'); pc('true');
        const rung = () => chatBell({ rungAt: at(60).toISOString() });
        const asked = async (row, over) => {
          mockBundles = new Map([[String(row.id), bundle({ anchor: at(60), ...over })]]);
          const data = await loadSubjects([row]);
          return judge(classify(row), subjectFor(row, data, TODAY));
        };
        await asked(rung(), {});
        expect(mockLoadContactBundles.mock.calls.pop()[0].map((i) => [i.kind, i.refs, i.bellAt])).toEqual([['customer', { customerId: CUST }, at(60)]]);
        mockLoadContactBundles.mockClear();
        await loadSubjects([chatBell({ rungAt: 'not a date' }), { ...chatBell({ topic: 'add_service' }), id: uid(96) }]);
        expect(mockLoadContactBundles.mock.calls[0][0].map((i) => [i.kind, i.bellAt])).toEqual([['customer', T0], ['customer', T0]]);
        expect((await asked(rung(), { textAt: at(30), backAt: at(30), replyAt: at(30) })).reason).toBeNull();
        expect((await asked(rung(), { replyAt: at(90) })).reason).toBe('Answered by email');
        expect((await asked(chatBell(), { anchor: T0, textAt: at(30) })).reason).toBe('Answered by text');
      });

      test('the add-a-service chat keeps its estimate rule with the new gate off, and also closes on a person\'s contact when the gate is true', async () => {
        const addService = () => chatBell({ topic: 'add_service' });
        gate('true');
        // gate off: only the estimate rule, and no portal chat witness is read
        expect(await judged(addService(), { backAt: at(20) })).toMatchObject({ cls: 'portal_chat_add_service', reason: null, would: null });
        expect(mockLoadContactBundles).not.toHaveBeenCalled();
        mockTables.estimates = [{ id: uid(533), customer_id: CUST }];
        expect(await judged(addService(), { backAt: at(20) })).toMatchObject({ reason: 'Estimate was sent', would: null });
        mockTables.estimates = [];
        pc('true');
        expect(await judged(addService(), { backAt: at(20) })).toMatchObject({ cls: 'portal_chat_add_service', reason: 'A person called back', would: null });
        expect(await judged(addService(), { backAt: at(-20) })).toMatchObject({ reason: null, would: null });
        pc('shadow');
        expect(await judged(addService(), { inAt: at(20) })).toMatchObject({ reason: null, would: 'A person answered their call' });
      });

      test('the sweep: shadow records and closes nothing; true closes; the gate switched off puts the bell back; the email-change bell is never touched', async () => {
        const row = chatBell();
        const other = emailChangeBell();
        mockTables.notifications = [row, other];
        mockBundles = new Map([[String(row.id), bundle({ textAt: at(20) })], [String(other.id), bundle({ textAt: at(20) })]]);
        gate('true'); pc('shadow');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ retired: 0, wouldClose: 1 });
        expect(mockAuditWouldClose.mock.calls[0][0].items).toEqual([
          { notification_id: row.id, alert_class: 'portal_chat_answered', reason: 'Answered by text', judged_at: NOW_AFTER.toISOString() },
        ]);
        expect(row.done_at ?? null).toBeNull();
        pc('true');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ retired: 1, byClass: { portal_chat_answered: 1 } });
        expect(row).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
        expect(other.done_at ?? null).toBeNull();
        pc(undefined);
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ rearmed: 1, retired: 0 });
        expect(row.done_at ?? null).toBeNull();
      });

      test('re-arm: while the gate is true a close holds only while a fact after the bell does', async () => {
        gate('true'); pc('true');
        const row = closedRow(chatBell(), 'Answered by email');
        mockTables.notifications = [row];
        mockBundles = new Map([[String(row.id), bundle({ replyAt: at(20) })]]);
        expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(0);
        mockBundles = new Map([[String(row.id), bundle()]]);
        expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(1);
        expect(row.done_at ?? null).toBeNull();
      });
    });

    describe('portal items close like chat items (GATE_PORTAL_ITEM_CLOSE)', () => {
      const REQ = uid(61);
      const pi = (value) => { if (value === undefined) delete process.env.GATE_PORTAL_ITEM_CLOSE; else process.env.GATE_PORTAL_ITEM_CLOSE = value; };
      // The bell POST /api/requests raises (requests.js): category service, doneWhen request_answered, requestId + customerId.
      const requestBell = (over = {}) => note({
        category: 'service', link: `/admin/customers?customerId=${CUST}`,
        metadata: { area: 'Customers', doneWhen: 'request_answered', requestId: REQ, customerId: CUST, category: 'general', ...over },
      });
      const cancellationBell = () => requestBell({ doneWhen: 'cancellation_reviewed' });
      // The add-service bell (notification-triggers bundle_quote_requested): trigger fields under payload; with the gate on the
      // request id and customer ride at the top as well.
      const bundleBell = (over = {}) => note({
        category: 'estimate', link: `/admin/customers?customerId=${CUST}`,
        metadata: { triggerKey: 'bundle_quote_requested', priority: 'high', payload: { customerId: CUST, requestId: REQ, bundled: false }, requestId: REQ, customerId: CUST, ...over },
      });

      test.each([[undefined, false], ['', false], ['on', false], ['1', false], ['TRUE', false], [' true', false], ['true', true]])('GATE_PORTAL_ITEM_CLOSE = %j -> live %s (strict)', (value, live) => {
        pi(value);
        expect(require('../config/feature-gates').portalItemCloseLive()).toBe(live);
      });
      test.each([[undefined, false], ['yes', false], ['TRUE', false], ['true', true]])('GATE_PORTAL_LATE_RERING = %j -> live %s (strict)', (value, live) => {
        if (value === undefined) delete process.env.GATE_PORTAL_LATE_RERING; else process.env.GATE_PORTAL_LATE_RERING = value;
        expect(require('../config/feature-gates').portalLateReringLive()).toBe(live);
      });

      test('the classes exist only while the gate is true; a cancellation bell, a bell with no request id or customer, and a bundle bell whose request id is still nested never match', () => {
        gate('true');
        const rows = [requestBell(), bundleBell()];
        for (const row of rows) { expect(classify(row)).toBeNull(); }
        expect(classify(requestBell(), { anyMode: true }).key).toBe('portal_request_answered');
        expect(classify(bundleBell(), { anyMode: true }).key).toBe('portal_add_service_request');
        pi('true');
        expect(classify(requestBell()).key).toBe('portal_request_answered');
        expect(classify(bundleBell()).key).toBe('portal_add_service_request');
        expect(classify(cancellationBell())).toBeNull();
        expect(classify(requestBell({ requestId: undefined }))).toBeNull();
        expect(classify(requestBell({ requestId: 'not-an-id' }))).toBeNull();
        expect(classify(requestBell({ customerId: undefined }))).toBeNull();
        expect(classify(requestBell({ doneWhen: undefined }))).toBeNull();
        // Raised before the gate: the request id is nested under payload only, so it is not judged.
        expect(classify(bundleBell({ requestId: undefined, customerId: undefined }))).toBeNull();
        expect(classify(bundleBell({ requestId: undefined }))).toBeNull();
        // The same trigger's self-applied bundle (no request row) carries no request id at all.
        expect(classify(note({ category: 'estimate', metadata: { triggerKey: 'bundle_quote_requested', payload: { bundled: true, customerId: CUST } } }))).toBeNull();
      });

      test('the ask is the boundary: metadata.askedAt (stamped by the late re-ring, which bumps created_at) is read before created_at, for the witnesses and the estimate check; a later emitter ring still moves it', async () => {
        gate('true'); pi('true');
        const bumped = new Date(T0.getTime() + 3 * 60 * 60 * 1000);
        const asked = (over = {}) => requestBell({ askedAt: T0.toISOString(), lateReRungAt: bumped.toISOString(), ...over });
        const row = asked();
        row.created_at = bumped; // the re-ring moved the row to the top
        await judged(row, { textAt: at(20) });
        expect(mockLoadContactBundles.mock.calls.pop()[0].map((i) => i.bellAt)).toEqual([T0]);
        const { bellEventAt } = require('../services/admin-alert-relevance');
        expect(bellEventAt(row)).toEqual(T0);
        // A chat hand-off refreshed by its emitter AFTER the stamp is a new ask.
        const later = asked({ rungAt: at(120).toISOString() });
        later.created_at = bumped;
        expect(bellEventAt(later)).toEqual(at(120));
        // A bad stamp falls back to created_at.
        const bad = asked({ askedAt: 'not a date' });
        expect(bellEventAt(bad)).toEqual(bad.created_at);
        // No stamp: today's behavior.
        expect(bellEventAt(requestBell())).toEqual(T0);
      });

      test('a request bell: the four reasons in order, only from a fact after the bell; a visit or an estimate is no reason; own gate off = nothing read', async () => {
        gate('true'); pi('true');
        expect((await judged(requestBell(), { backAt: at(20), inAt: at(20), textAt: at(20), replyAt: at(20) })).reason).toBe('A person called back');
        expect((await judged(requestBell(), { inAt: at(20), textAt: at(20) })).reason).toBe('A person answered their call');
        expect((await judged(requestBell(), { textAt: at(20), replyAt: at(20) })).reason).toBe('Answered by text');
        expect((await judged(requestBell(), { replyAt: at(20) })).reason).toBe('Answered by email');
        expect(await judged(requestBell(), { backAt: at(-20), inAt: at(-20), textAt: at(-20), replyAt: at(-20) })).toMatchObject({ reason: null, would: null });
        expect(await judged(requestBell(), { textAt: T0 })).toMatchObject({ reason: null, would: null });
        expect(await judged(requestBell(), { visitAt: at(20), quote: true })).toMatchObject({ reason: null, would: null });
        // The witnesses are read for the customer, from the bell's creation, under the new gate alone (the chat gate stays off).
        expect(mockLoadContactBundles.mock.calls.pop()[0].map((i) => [i.kind, i.refs, i.bellAt])).toEqual([['customer', { customerId: CUST }, T0]]);
        pi(undefined);
        mockLoadContactBundles.mockClear();
        expect(await judged(requestBell(), { textAt: at(20) })).toMatchObject({ cls: null, reason: null });
        expect(mockLoadContactBundles).not.toHaveBeenCalled();
      });

      test('it rides on GATE_ALERT_CONTACT_CLOSE: shadow there = would only, off there = nothing', async () => {
        pi('true');
        gate('shadow');
        expect(await judged(requestBell(), { textAt: at(20) })).toMatchObject({ reason: null, would: 'Answered by text' });
        gate(undefined);
        mockLoadContactBundles.mockClear();
        expect(await judged(requestBell(), { textAt: at(20) })).toMatchObject({ cls: 'portal_request_answered', reason: null, would: null });
        expect(mockLoadContactBundles).not.toHaveBeenCalled();
      });

      test('an add-service request bell closes on an estimate handed to its customer, not on contact alone; the estimate lookup is made for it only under the gate', async () => {
        gate('true'); pi('true');
        expect(await judged(bundleBell(), { backAt: at(20), textAt: at(20) })).toMatchObject({ cls: 'portal_add_service_request', reason: null });
        mockTables.estimates = [{ id: uid(534), customer_id: CUST }];
        expect(await judged(bundleBell(), null)).toMatchObject({ cls: 'portal_add_service_request', reason: 'Estimate was sent' });
        mockTables.estimates = [];
        expect(await judged(bundleBell(), null)).toMatchObject({ reason: null });
      });

      test('the sweep (gate on): an answered request bell closes and its request resolves quietly with the reason; an estimate closes the add-service bell as "Estimate sent"; a cancellation bell and a nested bundle bell are untouched', async () => {
        const request = requestBell();
        const cancel = cancellationBell();
        const bundle1 = bundleBell();
        const nested = bundleBell({ requestId: undefined });
        const answeredOnly = requestBell({ requestId: uid(62) });
        mockTables.notifications = [request, cancel, bundle1, nested, answeredOnly];
        mockTables.estimates = [{ id: uid(535), customer_id: CUST }];
        mockBundles = new Map([[String(request.id), bundle({ textAt: at(20) })], [String(cancel.id), bundle({ textAt: at(20) })], [String(answeredOnly.id), bundle()]]);
        gate('true');
        // Gate off: nothing closes, nothing resolves.
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ retired: 0 });
        expect(mockResolveRequest).not.toHaveBeenCalled();
        pi('true');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ retired: 2, byClass: { portal_request_answered: 1, portal_add_service_request: 1 } });
        expect(request).toMatchObject({ done_by: 'relevance', resolution: 'Answered by text' });
        expect(bundle1).toMatchObject({ done_by: 'relevance', resolution: 'Estimate was sent' });
        for (const open of [cancel, nested, answeredOnly]) expect(open.done_at ?? null).toBeNull();
        expect(mockResolveRequest).toHaveBeenCalledTimes(2);
        // the boundary is the closing bell's ask time (askedAt, else created_at)
        expect(mockResolveRequest).toHaveBeenCalledWith(REQ, CUST, 'Answered by text', { notAfter: request.created_at });
        expect(mockResolveRequest).toHaveBeenCalledWith(REQ, CUST, 'Estimate sent', { notAfter: bundle1.created_at });
      });

      test('a failed request resolve is logged and never undoes the bell\'s close; the gate switched off puts the bell back and resolves nothing', async () => {
        const request = requestBell();
        mockTables.notifications = [request];
        mockBundles = new Map([[String(request.id), bundle({ backAt: at(20) })]]);
        mockResolveRequest.mockRejectedValueOnce(new Error('boom'));
        gate('true'); pi('true');
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ retired: 1 });
        expect(request).toMatchObject({ done_by: 'relevance', resolution: 'A person called back' });
        expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('the request behind it was not resolved'));
        mockResolveRequest.mockClear();
        pi(undefined);
        expect(await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).toMatchObject({ rearmed: 1, retired: 0 });
        expect(request.done_at ?? null).toBeNull();
        expect(mockResolveRequest).not.toHaveBeenCalled();
      });

      test('a bell a person marked Done first: once the answer is verified the takeover also resolves the request quietly; with no answer the Done and the request stand', async () => {
        gate('true'); pi('true');
        const doneAt = new Date('2026-09-27T14:00:00Z');
        const answered = { ...requestBell(), read_at: doneAt, done_at: doneAt, done_by: '7', resolution: 'Handled' };
        const waiting = { ...requestBell({ requestId: uid(63) }), read_at: doneAt, done_at: doneAt, done_by: '7', resolution: 'Handled' };
        mockTables.notifications = [answered, waiting];
        mockBundles = new Map([[String(answered.id), bundle({ textAt: at(20) })], [String(waiting.id), bundle()]]);
        await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
        expect(answered).toMatchObject({ done_by: 'relevance', resolution: 'Handled' });
        expect(waiting.done_by).toBe('7');
        expect(mockResolveRequest).toHaveBeenCalledTimes(1);
        expect(mockResolveRequest).toHaveBeenCalledWith(REQ, CUST, 'Answered by text', { notAfter: answered.created_at });
      });

      test('the request boundary is the ask, not a re-ring\'s bumped created_at (metadata.askedAt first)', async () => {
        gate('true'); pi('true');
        const row = requestBell({ askedAt: T0.toISOString(), lateReRungAt: at(180).toISOString() });
        row.created_at = at(180);
        mockTables.notifications = [row];
        mockBundles = new Map([[String(row.id), bundle({ anchor: T0, textAt: at(20) })]]);
        await runAdminAlertRelevanceSweep({ now: NOW_AFTER });
        expect(mockResolveRequest).toHaveBeenCalledWith(REQ, CUST, 'Answered by text', { notAfter: T0 });
      });

      test('re-arm: a request bell stays closed only while a person\'s contact after the bell holds', async () => {
        gate('true'); pi('true');
        const row = closedRow(requestBell(), 'Answered by text');
        mockTables.notifications = [row];
        mockBundles = new Map([[String(row.id), bundle({ textAt: at(20) })]]);
        expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(0);
        mockBundles = new Map([[String(row.id), bundle()]]);
        expect((await runAdminAlertRelevanceSweep({ now: NOW_AFTER })).rearmed).toBe(1);
      });
    });
  });
});
