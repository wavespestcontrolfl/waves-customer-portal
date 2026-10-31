/**
 * same-question-refresh — the owner-page rewrite row queued when the
 * same-question check blocks a new post (GATE_SAME_QUESTION_CHECK on).
 * The producer must go through every refresh gate: protected pages, the
 * shared page-edit lock + in-flight check, and the frozen-row upsert guard.
 */

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const refresh = require('../services/content/same-question-refresh');

const OWNER = { url: '/pest-control/millipede-vs-centipede-southwest-florida/', title: 'Millipede vs Centipede in Southwest Florida' };
const ARGS = { owner: OWNER, tokens: ['millipede'], question: 'florida millipede', sourceOpportunityId: 41, sourceRunId: 9 };

function wireTransaction(insertRows) {
  // trx is callable too: supersedeCitabilityBackfillsForPage reads backfill rows through it (none here).
  const chain = { where: () => chain, whereIn: () => chain, whereNotNull: () => chain, whereRaw: () => chain, forUpdate: () => chain, select: async () => [], update: async () => 0 };
  const trx = Object.assign(jest.fn(() => chain), { raw: jest.fn(async (sql) => (/INSERT INTO opportunity_queue/.test(sql) ? { rows: insertRows } : { rows: [] })) });
  db.transaction.mockImplementation(async (fn) => fn(trx));
  return trx;
}
const deps = (over = {}) => ({
  protectedPages: { isProtected: jest.fn().mockResolvedValue({ protected: false }) },
  refreshAudit: { _identity: { urlToPath: (u) => new URL(u).pathname.replace(/\/+$/, '') }, findInflightPageEdit: jest.fn().mockResolvedValue(null) },
  now: new Date('2026-10-30T12:00:00Z'),
  ...over,
});

beforeEach(() => { jest.clearAllMocks(); });

describe('buildRow', () => {
  test('a page-only ANSWER-GAP refresh row on the owner page, with the question as the one unanswered query', () => {
    const row = refresh.buildRow({ ...ARGS, now: new Date('2026-10-30T12:00:00Z') });
    expect(row).toMatchObject({
      bucket: 'same_question_refresh',
      action_type: 'refresh_existing_page',
      query: null,
      city: null,
      status: 'pending',
      page_url: 'https://www.wavespestcontrol.com/pest-control/millipede-vs-centipede-southwest-florida/',
      service: 'pest',
    });
    expect(row.score).toBe(refresh._internals.BASE_SCORE);
    expect(row.score).toBeGreaterThanOrEqual(75); // the refresh floor
    expect(row.signal_metadata.unanswered_queries).toEqual([
      expect.objectContaining({ query: 'florida millipede', impressions: 0, source: 'same_question_refresh' }),
    ]);
    expect(row.signal_metadata.same_question).toMatchObject({ owner_url: row.page_url, tokens: ['millipede'], question: 'florida millipede', source_opportunity_id: 41 });
    expect(row.expires_at.getTime()).toBe(new Date('2026-10-30T12:00:00Z').getTime() + 60 * 86400_000);
  });

  test('dedupe is per (owner page, question words): token order and page-URL spelling do not matter', () => {
    const a = refresh.dedupeKeyFor('/pest-control/x/', ['b', 'a']);
    expect(a).toBe(refresh.dedupeKeyFor('https://www.wavespestcontrol.com/pest-control/x', ['a', 'b', 'a']));
    expect(a).not.toBe(refresh.dedupeKeyFor('/pest-control/x/', ['a']));
    expect(a).not.toBe(refresh.dedupeKeyFor('/pest-control/y/', ['a', 'b']));
    expect(a.length).toBeLessThanOrEqual(200);
    expect(refresh.dedupeKeyFor(`/pest-control/${'x'.repeat(300)}/`, ['a']).length).toBeLessThanOrEqual(200);
  });

  test('service follows the owner URL category', () => {
    expect(refresh._internals.serviceForOwner('/lawn-care/dollar-weed/')).toBe('lawn');
    expect(refresh._internals.serviceForOwner('/termite/swarm/')).toBe('termite');
    expect(refresh._internals.serviceForOwner('/unknown/foo/')).toBe('pest');
  });
});

describe('enqueueOwnerRefresh', () => {
  test('queues one pending row under the shared page-edit lock', async () => {
    const trx = wireTransaction([{ id: 7, status: 'pending' }]);
    const d = deps();
    const r = await refresh.enqueueOwnerRefresh(ARGS, d);
    expect(r).toMatchObject({ queued: true, reason: 'queued', page_url: 'https://www.wavespestcontrol.com/pest-control/millipede-vs-centipede-southwest-florida/' });
    expect(trx.raw.mock.calls[0][0]).toMatch(/pg_advisory_xact_lock\(hashtext\('opportunity_page_edit'\)\)/);
    const insert = trx.raw.mock.calls.find(([s]) => /INSERT INTO opportunity_queue/.test(s));
    expect(insert[0]).toMatch(/ON CONFLICT \(dedupe_key\) DO UPDATE/);
    expect(insert[0]).toMatch(/WHERE opportunity_queue\.status NOT IN \('claimed', 'done', 'pending_review', 'skipped'\)/);
    expect((insert[0].match(/\?/g) || []).length).toBe(insert[1].length); // one placeholder per binding, none in comments
    expect(insert[1][0]).toBe('same_question_refresh');
    expect(d.refreshAudit.findInflightPageEdit).toHaveBeenCalledWith(trx, { path: '/pest-control/millipede-vs-centipede-southwest-florida', targetDomain: 'wavespestcontrol.com' });
  });

  test('a protected owner page is never queued (money page, registry, high traffic)', async () => {
    const trx = wireTransaction([{ id: 7, status: 'pending' }]);
    const d = deps({ protectedPages: { isProtected: jest.fn().mockResolvedValue({ protected: true, reason: 'high_traffic' }) } });
    const r = await refresh.enqueueOwnerRefresh(ARGS, d);
    expect(r).toMatchObject({ queued: false, reason: 'protected_page:high_traffic' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(trx.raw).not.toHaveBeenCalled();
  });

  test('a protected-check error fails closed as protected', async () => {
    wireTransaction([]);
    const d = deps({ protectedPages: { isProtected: jest.fn().mockResolvedValue({ protected: true, reason: 'protected_check_error' }) } });
    expect((await refresh.enqueueOwnerRefresh(ARGS, d)).queued).toBe(false);
  });

  test('another page edit already queued or running on the page → no row (page_edit_in_flight)', async () => {
    const trx = wireTransaction([{ id: 7, status: 'pending' }]);
    const d = deps();
    d.refreshAudit.findInflightPageEdit.mockResolvedValue({ dedupe_key: 'decay_refresh::x', status: 'claimed' });
    const r = await refresh.enqueueOwnerRefresh(ARGS, d);
    expect(r).toMatchObject({ queued: false, reason: 'page_edit_in_flight', status: 'claimed' });
    expect(trx.raw.mock.calls.some(([s]) => /INSERT INTO opportunity_queue/.test(s))).toBe(false);
  });

  test('the same question already queued is idempotent (already_queued), not a second row', async () => {
    wireTransaction([]);
    const d = deps();
    const key = refresh.dedupeKeyFor(OWNER.url, ['millipede']);
    d.refreshAudit.findInflightPageEdit.mockResolvedValue({ dedupe_key: key, status: 'pending' });
    expect((await refresh.enqueueOwnerRefresh(ARGS, d)).reason).toBe('already_queued');
  });

  test('a frozen row (done / skipped / claimed) is not reopened: the guarded upsert returns no row', async () => {
    wireTransaction([]);
    const r = await refresh.enqueueOwnerRefresh(ARGS, deps());
    expect(r).toMatchObject({ queued: false, reason: 'already_handled' });
  });

  test('an incomplete match queues nothing', async () => {
    expect((await refresh.enqueueOwnerRefresh({ owner: OWNER, tokens: [], question: 'x' }, deps())).reason).toBe('incomplete_match');
    expect((await refresh.enqueueOwnerRefresh({ owner: OWNER, tokens: ['a'], question: '  ' }, deps())).reason).toBe('incomplete_match');
    expect((await refresh.enqueueOwnerRefresh({ tokens: ['a'], question: 'x' }, deps())).reason).toBe('incomplete_match');
  });
});
