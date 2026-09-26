// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Codex #4940 r6 P1: the portal renewal decline raises its dated station-
// retrieval task through the REAL raiseTermiteRetrievalTask + notifyAdmin.
// The decline has no service request; passed as request `null` it used to
// rank as the OLDEST event, so ANY earlier request-keyed retrieval row on
// the account (even one staff already read) made the helper yield —
// `raised: true, supersededByNewer` with nothing created — and the decline
// recorded itself settled. Now it passes its real event time (eventAt), and
// it settles (the activity_log marker) only once its own task row exists.
//
// Needs a disposable, fully migrated local database, e.g.:
//   DATABASE_URL=postgresql://waves_user@localhost:5432/<throwaway> \
//     npx jest --runInBand --forceExit server/tests/termite-annual-decline-retrieval-chronology-postgres.test.js
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(120000);

const ymdOffset = (days) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
const daysAgo = (days) => new Date(Date.now() - days * 24 * 3600 * 1000);

postgres('portal renewal decline — station-retrieval chronology (real helper, migrated Postgres)', () => {
  let database;
  let trx;
  let Renewals;
  let termRetrievalDedupeKey;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    Renewals = require('../services/annual-prepay-renewals');
    ({ termRetrievalDedupeKey } = require('../services/cancellation-processor'));
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  // A paid, installed termite annual term the customer declined in the
  // portal `declinedDaysAgo` days ago, with one Waves-owned station.
  async function portalDeclinedTerm({ declinedDaysAgo = 1 } = {}) {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const termId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Decline', email: `${customerId}@example.invalid`,
      phone: `fixture-${customerId.slice(0, 8)}`,
    });
    await trx('termite_stations').insert({
      customer_id: customerId, station_number: 1, geometry_image: JSON.stringify({}), program: 'termite', owned_by: 'waves', is_active: true,
    });
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'paid', paid_at: new Date(), subtotal: 450, total: 450,
      line_items: '[]', invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: randomUUID(),
    });
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, prepay_invoice_id: invoiceId,
      status: 'cancelled', renewal_decision: 'cancel', renewal_decision_at: daysAgo(declinedDaysAgo), cancel_disposition: 'end_at_term',
      coverage_service_type: 'Termite Monitoring Visit', coverage_visit_count: 1, coverage_cadence: 'annual',
      prepay_amount: 450, term_start: ymdOffset(-60), term_end: ymdOffset(300),
      annual_plan_version: 'v3', installation_anchored_at: daysAgo(59),
    });
    const decidedAt = daysAgo(declinedDaysAgo);
    await trx('activity_log').insert({
      customer_id: customerId, action: 'termite_annual_renewal_declined', description: 'Declined renewal online.',
      metadata: JSON.stringify({ term_id: termId, source: 'customer_portal', decided_at: decidedAt.toISOString() }),
      created_at: decidedAt,
    });
    return { customerId, termId, termEnd: ymdOffset(300) };
  }

  // An admin cancellation request and its request-keyed retrieval row.
  async function requestKeyedRetrievalRow(customerId, { openedDaysAgo, read }) {
    const requestId = randomUUID();
    await trx('service_requests').insert({
      id: requestId, customer_id: customerId, category: 'cancellation', subject: 'Cancel plan', source: 'admin', status: 'resolved',
      created_at: daysAgo(openedDaysAgo), updated_at: daysAgo(openedDaysAgo),
    });
    await trx('notifications').insert({
      recipient_type: 'admin', category: 'service', title: 'Termite stations to retrieve after cancellation', body: 'x',
      read_at: read ? daysAgo(openedDaysAgo - 1) : null,
      metadata: JSON.stringify({
        kind: 'termite_station_retrieval', customerId, requestId, dedupeKey: `termite_station_retrieval:${customerId}:${requestId}`,
      }),
    });
    return requestId;
  }

  const ownTaskRow = (t) => trx('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [termRetrievalDedupeKey(t.termId, 'portal_renewal_decline', t.termEnd)])
    .first('id', 'read_at', 'metadata');
  const marker = (t) => trx('activity_log')
    .where({ action: 'termite_annual_decline_retrieval' })
    .whereRaw("metadata->>'term_id' = ?", [t.termId])
    .first('id', 'metadata');

  test('an OLDER read request-keyed retrieval row no longer swallows the decline: its own dated task is raised, then the marker', async () => {
    const t = await portalDeclinedTerm({ declinedDaysAgo: 1 });
    await requestKeyedRetrievalRow(t.customerId, { openedDaysAgo: 30, read: true });

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 1 });

    const row = await ownTaskRow(t);
    expect(row).toBeTruthy();
    expect(row.read_at).toBeNull();
    expect(row.metadata).toEqual(expect.objectContaining({ termId: t.termId, retrieveAfter: t.termEnd, eventAt: expect.any(String) }));
    expect((await marker(t)).metadata).toEqual(expect.objectContaining({ outcome: 'raised', term_end: t.termEnd }));
    // Settled — the next sweep is a no-op.
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 0, raised: 0 });
  });

  test('a NEWER request-keyed instruction (opened after the decline) wins: nothing raised; settled only once staff are belled to confirm', async () => {
    const t = await portalDeclinedTerm({ declinedDaysAgo: 10 });
    await requestKeyedRetrievalRow(t.customerId, { openedDaysAgo: 2, read: false });

    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 1, raised: 0 });
    expect(await ownTaskRow(t)).toBeUndefined();
    const bell = await trx('notifications')
      .whereRaw("metadata->>'dedupeKey' = ?", [`termite-annual-decline-retrieval:${t.termId}:superseded_by_newer`])
      .first('body');
    expect(bell.body).toContain('A newer station-retrieval instruction already stands on this account');

    // The confirmed bell settles it (outcome superseded_by_newer), so the
    // sweep stops re-checking it and it never holds a bounded slot.
    expect((await marker(t)).metadata).toEqual(expect.objectContaining({ outcome: 'superseded_by_newer' }));
    expect(await Renewals.raisePendingDeclineRetrievalTasks()).toEqual({ scanned: 0, raised: 0 });
  });
});
