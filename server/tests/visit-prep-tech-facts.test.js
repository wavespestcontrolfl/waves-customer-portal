/**
 * services/visit-prep.js — the two new, self-contained tech-facing reads
 * added in PR 3a (customer photos before a visit, tech Visit Brief
 * surface): customerFlaggedFacts (feeds previsit-brief.js's
 * deterministicVisitFacts.customerFlagged) and stopPhotoViewUrls (feeds
 * GET /:id/visit-prep-photos, the thumbnail endpoint). Both resolve the
 * stop's CURRENT scheduled_services membership via the existing
 * stopMemberIds — never a submission's own snapshotted visit_id — so
 * these tests exercise that with a real grouped-stop membership change.
 *
 * A separate suite (visit-prep-postgres.test.js style, real Postgres) is
 * out of scope here — this is pure/unit coverage against a small
 * chainable knex stub, matching visit-prep.test.js's own convention.
 */

jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(async (s3Key, expiresIn) => `signed://${s3Key}?ttl=${expiresIn}`),
}));

const visitPrep = require('../services/visit-prep');
const PhotoService = require('../services/photos');
const { customerFlaggedFacts, stopPhotoViewUrls, TECH_PHOTO_VIEW_TTL_SECONDS } = visitPrep;

// A minimal chainable knex stub keyed by table + an in-memory row set per
// table. Supports exactly the calls these two functions make: where /
// whereIn / orderBy (no-op) / select (array) / first (scalar, unused here).
function fakeConn(tables) {
  return (table) => {
    const q = { _table: table, _where: {}, _whereIn: null, _order: [] };
    q.where = (w) => { Object.assign(q._where, w); return q; };
    q.whereIn = (col, vals) => { q._whereIn = { col, vals }; return q; };
    // Real ordering (not a no-op) — this suite specifically asserts photo
    // order, which the real query gets from ORDER BY photo_index asc.
    q.orderBy = (col, dir = 'asc') => { q._order.push([col, dir]); return q; };
    q.select = async () => {
      const rows = tables[table] || [];
      const filtered = rows.filter((r) => {
        if (q._whereIn && !q._whereIn.vals.includes(r[q._whereIn.col])) return false;
        return Object.entries(q._where).every(([k, v]) => r[k] === v);
      });
      return filtered.slice().sort((a, b) => {
        for (const [col, dir] of q._order) {
          if (a[col] === b[col]) continue;
          const cmp = a[col] < b[col] ? -1 : 1;
          return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    };
    return q;
  };
}

describe('customerFlaggedFacts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no CURRENT-membership submissions → null (never an empty array)', async () => {
    const conn = fakeConn({
      scheduled_services: [],
      visit_prep_submissions: [],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts).toBeNull();
  });

  test('ungrouped stop with submissions: shaped entries, ordered photo ids, no S3 keys/URLs', async () => {
    const conn = fakeConn({
      scheduled_services: [],
      visit_prep_submissions: [
        {
          id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T23:42:00Z'),
          topic: 'lawn', location_on_property: 'back_yard', note: 'Brown spots spreading',
        },
      ],
      visit_prep_photos: [
        { id: 'photo-b', submission_id: 'sub-1', photo_index: 1, s3_key: 'visitprep/b.jpg' },
        { id: 'photo-a', submission_id: 'sub-1', photo_index: 0, s3_key: 'visitprep/a.jpg' },
      ],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts).toEqual([{
      id: 'sub-1',
      sentAt: '2026-09-30T23:42:00.000Z',
      topic: 'lawn',
      locationOnProperty: 'back_yard',
      note: 'Brown spots spreading',
      photoIds: ['photo-a', 'photo-b'],
    }]);
    // Never S3 keys or URLs in facts (scope §7).
    expect(JSON.stringify(facts)).not.toMatch(/visitprep|s3_key|signed:\/\//);
  });

  test('grouped stop: resolves CURRENT membership, not the submission\'s own snapshotted visit_id', async () => {
    // svc-A and svc-B currently share visit_id "visit-9". A third
    // submission was recorded against svc-C, which used to be in this
    // group (its snapshotted visit_id still says "visit-9") but has since
    // been detached — the CURRENT scheduled_services read no longer lists
    // it as a member, so its photos must NOT appear for this stop.
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-A', visit_id: 'visit-9' },
        { id: 'svc-B', visit_id: 'visit-9' },
      ],
      visit_prep_submissions: [
        { id: 'sub-A', scheduled_service_id: 'svc-A', created_at: new Date('2026-09-30T10:00:00Z'), topic: 'pest', location_on_property: null, note: null },
        { id: 'sub-B', scheduled_service_id: 'svc-B', created_at: new Date('2026-09-30T11:00:00Z'), topic: null, location_on_property: null, note: null },
        { id: 'sub-C', scheduled_service_id: 'svc-C', created_at: new Date('2026-09-30T12:00:00Z'), topic: null, location_on_property: null, note: null },
      ],
      visit_prep_photos: [
        { id: 'photo-A', submission_id: 'sub-A', photo_index: 0, s3_key: 'visitprep/A.jpg' },
        { id: 'photo-C', submission_id: 'sub-C', photo_index: 0, s3_key: 'visitprep/C.jpg' },
      ],
    });
    // Whichever member's brief is opened, the stop-level list is the same
    // (svc-A here).
    const facts = await customerFlaggedFacts({ id: 'svc-A', visit_id: 'visit-9' }, conn);
    const ids = facts.map((s) => s.id);
    expect(ids).toEqual(['sub-A', 'sub-B']);
    expect(ids).not.toContain('sub-C');
    expect(facts.find((s) => s.id === 'sub-A').photoIds).toEqual(['photo-A']);
  });

  test('submissions exist for the stop but none carry photos yet (note-only submission)', async () => {
    const conn = fakeConn({
      scheduled_services: [],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'), topic: 'other', location_on_property: null, note: 'Ants near the mailbox' },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts).toEqual([{
      id: 'sub-1', sentAt: '2026-09-30T10:00:00.000Z', topic: 'other',
      locationOnProperty: null, note: 'Ants near the mailbox', photoIds: [],
    }]);
  });
});

describe('techStopMemberIds (Codex #5239 r1 P1)', () => {
  const { techStopMemberIds } = visitPrep;
  // A frozen visit keeps visit_id on a member dispatch reassigned or moved;
  // that member is someone else's stop now and must not ride svc-A's access.
  const members = [
    { id: 'svc-A', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: new Date('2026-10-02T00:00:00Z'), status: 'confirmed' },
    { id: 'svc-B', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', status: 'confirmed' },
    { id: 'svc-other-tech', visit_id: 'visit-9', technician_id: 'tech-2', scheduled_date: '2026-10-02', status: 'confirmed' },
    { id: 'svc-other-day', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-05', status: 'confirmed' },
    { id: 'svc-cancelled', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', status: 'cancelled' },
  ];

  test('keeps only members still on svc\'s current technician and date, not dead; svc itself always first', async () => {
    const conn = fakeConn({ scheduled_services: members });
    expect(await techStopMemberIds({ id: 'svc-A', visit_id: 'visit-9' }, conn)).toEqual(['svc-A', 'svc-B']);
  });

  test('reads svc\'s technician and date from the database, not the caller\'s copy', async () => {
    const conn = fakeConn({ scheduled_services: members });
    const stale = { id: 'svc-A', visit_id: 'visit-9', technician_id: 'tech-2', scheduled_date: '2026-10-05' };
    expect(await techStopMemberIds(stale, conn)).toEqual(['svc-A', 'svc-B']);
  });

  test('facts and signed photos exclude a reassigned member\'s submission and photos', async () => {
    const conn = fakeConn({
      scheduled_services: members,
      visit_prep_submissions: [
        { id: 'sub-A', scheduled_service_id: 'svc-A', created_at: new Date('2026-09-30T10:00:00Z'), topic: 'pest', location_on_property: null, note: 'mine' },
        { id: 'sub-X', scheduled_service_id: 'svc-other-tech', created_at: new Date('2026-09-30T11:00:00Z'), topic: 'lawn', location_on_property: null, note: 'not mine' },
      ],
      visit_prep_photos: [
        { id: 'photo-A', submission_id: 'sub-A', scheduled_service_id: 'svc-A', photo_index: 0, s3_key: 'visitprep/A.jpg' },
        { id: 'photo-X', submission_id: 'sub-X', scheduled_service_id: 'svc-other-tech', photo_index: 0, s3_key: 'visitprep/X.jpg' },
      ],
    });
    const svc = { id: 'svc-A', visit_id: 'visit-9' };
    expect((await customerFlaggedFacts(svc, conn)).map((f) => f.id)).toEqual(['sub-A']);
    expect((await stopPhotoViewUrls(svc, conn)).map((p) => p.id)).toEqual(['photo-A']);
  });
});

describe('stopPhotoViewUrls', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no CURRENT-membership photos → []', async () => {
    const conn = fakeConn({ scheduled_services: [], visit_prep_photos: [] });
    const urls = await stopPhotoViewUrls({ id: 'svc-1', visit_id: null }, conn);
    expect(urls).toEqual([]);
    expect(PhotoService.getViewUrl).not.toHaveBeenCalled();
  });

  test('signs every photo on the CURRENT stop membership at the 1-hour TTL, never S3 keys back to the caller', async () => {
    expect(TECH_PHOTO_VIEW_TTL_SECONDS).toBe(3600);
    const conn = fakeConn({
      scheduled_services: [],
      visit_prep_photos: [
        { id: 'photo-1', submission_id: 'sub-1', photo_index: 0, s3_key: 'visitprep/1.jpg', scheduled_service_id: 'svc-1' },
        { id: 'photo-2', submission_id: 'sub-1', photo_index: 1, s3_key: 'visitprep/2.jpg', scheduled_service_id: 'svc-1' },
      ],
    });
    const urls = await stopPhotoViewUrls({ id: 'svc-1', visit_id: null }, conn);
    expect(urls).toEqual([
      { id: 'photo-1', submissionId: 'sub-1', url: 'signed://visitprep/1.jpg?ttl=3600' },
      { id: 'photo-2', submissionId: 'sub-1', url: 'signed://visitprep/2.jpg?ttl=3600' },
    ]);
    expect(PhotoService.getViewUrl).toHaveBeenCalledWith('visitprep/1.jpg', 3600);
    expect(urls.every((u) => !('s3Key' in u) && !('s3_key' in u))).toBe(true);
  });

  test('grouped stop: only CURRENT members\' photos are signed', async () => {
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-A', visit_id: 'visit-9' },
        { id: 'svc-B', visit_id: 'visit-9' },
      ],
      visit_prep_photos: [
        { id: 'photo-A', submission_id: 'sub-A', photo_index: 0, s3_key: 'visitprep/A.jpg', scheduled_service_id: 'svc-A' },
        { id: 'photo-C', submission_id: 'sub-C', photo_index: 0, s3_key: 'visitprep/C.jpg', scheduled_service_id: 'svc-C' },
      ],
    });
    const urls = await stopPhotoViewUrls({ id: 'svc-A', visit_id: 'visit-9' }, conn);
    // visit_prep_photos is filtered on scheduled_service_id IN (current
    // members) by the query itself — the fake conn's whereIn over
    // scheduled_service_id models that.
    expect(urls.map((u) => u.id)).toEqual(['photo-A']);
  });
});
