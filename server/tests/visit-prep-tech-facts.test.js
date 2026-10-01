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
// The service_visits rows the canonical stop rule (visit-groups.js
// rowStillAtVisitStop) compares members against, unless a test supplies its own.
const DEFAULT_VISITS = [
  { id: 'visit-9', scheduled_date: '2026-10-02', window_start: null, window_end: null },
  { id: 'visit-10', scheduled_date: '2026-10-02', window_start: null, window_end: null },
];

function fakeConn(tables) {
  tables = { service_visits: DEFAULT_VISITS, ...tables };
  return (table) => {
    const q = { _table: table, _where: {}, _whereIn: null, _order: [] };
    q.where = (w) => { Object.assign(q._where, w); return q; };
    q.whereIn = (col, vals) => { q._whereIn = { col, vals }; return q; };
    // Real ordering (not a no-op) — this suite specifically asserts photo
    // order, which the real query gets from ORDER BY photo_index asc.
    q.orderBy = (col, dir = 'asc') => { q._order.push([col, dir]); return q; };
    q.first = async () => (await q.select())[0];
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
  // The read line rides only while the pest-read gate is live.
  beforeEach(() => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    process.env.GATE_VISIT_PREP_PEST_READ = 'true';
    process.env.GATE_VISIT_FACTS = 'true';
  });
  afterEach(() => {
    delete process.env.GATE_VISIT_PREP_PHOTOS;
    delete process.env.GATE_VISIT_PREP_PEST_READ;
    delete process.env.GATE_VISIT_FACTS;
  });

  beforeEach(() => jest.clearAllMocks());

  test('no CURRENT-membership submissions → null (never an empty array)', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null }],
      visit_prep_submissions: [],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts).toBeNull();
  });

  test('ungrouped stop with submissions: shaped entries, ordered photo ids, no S3 keys/URLs', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Quarterly Pest Control' }],
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
      // No read_status on the fixture row (pre-PR-5 shape / column
      // default) — reads back as 'none', same as gate-off or "engine
      // never ran".
      read: { status: 'none' },
    }]);
    // Never S3 keys or URLs in facts (scope §7).
    expect(JSON.stringify(facts)).not.toMatch(/visitprep|s3_key|signed:\/\//);
  });

  test('an unread submission from today is marked awaiting only while the recovery sweep is live (Codex #5320 r10)', async () => {
    // Only the clock is frozen (a fixed 1 PM ET), so "40 minutes ago" is
    // always today in ET, whatever time the suite runs.
    jest.useFakeTimers({
      now: new Date('2026-10-01T17:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    const seed = () => fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Quarterly Pest Control' }],
      visit_prep_submissions: [{
        id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(Date.now() - 40 * 60 * 1000), read_status: 'none',
      }],
      visit_prep_photos: [],
    });
    expect((await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, seed()))[0].read).toEqual({ status: 'none' });
    process.env.GATE_VISIT_PREP_READ_SWEEP = 'true';
    try {
      expect((await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, seed()))[0].read).toEqual({ status: 'none', awaiting: true });
    } finally {
      delete process.env.GATE_VISIT_PREP_READ_SWEEP;
      jest.useRealTimers();
    }
  });

  test('grouped stop: resolves CURRENT membership, not the submission\'s own snapshotted visit_id', async () => {
    // svc-A and svc-B currently share visit_id "visit-9". A third
    // submission was recorded against svc-C, which used to be in this
    // group (its snapshotted visit_id still says "visit-9") but has since
    // been detached — the CURRENT scheduled_services read no longer lists
    // it as a member, so its photos must NOT appear for this stop.
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-A', visit_id: 'visit-9', scheduled_date: '2026-10-02' },
        { id: 'svc-B', visit_id: 'visit-9', scheduled_date: '2026-10-02' },
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
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Quarterly Pest Control' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'), topic: 'other', location_on_property: null, note: 'Ants near the mailbox' },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts).toEqual([{
      id: 'sub-1', sentAt: '2026-09-30T10:00:00.000Z', topic: 'other',
      locationOnProperty: null, note: 'Ants near the mailbox', photoIds: [],
      read: { status: 'none' },
    }]);
  });

  test('a stop reclassified to a non-pest service after the read shows no read (unsupported)', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Lawn Weed & Feed' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'), topic: null, location_on_property: null, note: null, read_status: 'done', read_ref: 'pi-1' },
      ],
      visit_prep_photos: [],
      pest_identifications: [{ id: 'pi-1', report_contract: JSON.stringify({ v2: { entry: { common_name: 'German cockroach' } } }) }],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'unsupported' });
  });

  test('a PENDING read on a stop reclassified to lawn shows no pending line (unsupported)', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Lawn Weed & Feed' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(), topic: null, location_on_property: null, note: null, read_status: 'pending', read_ref: null },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'unsupported' });
  });

  test('a failure loading the read keeps the note and photos (no read field)', async () => {
    const base = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Quarterly Pest Control' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(), topic: null, location_on_property: null, note: 'Ants by the slider', read_status: 'done', read_ref: 'pi-1' },
      ],
      visit_prep_photos: [],
    });
    const conn = (table) => {
      if (table === 'pest_identifications') throw new Error('db hiccup');
      return base(table);
    };
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].note).toBe('Ants by the slider');
    expect(facts[0]).not.toHaveProperty('read');
  });

  test('pest-read gate off: stored reads are not served at all (the kill switch hides them)', async () => {
    delete process.env.GATE_VISIT_PREP_PEST_READ;
    delete process.env.GATE_VISIT_FACTS;
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'), topic: null, location_on_property: null, note: null, read_status: 'done', read_ref: 'pi-1' },
      ],
      visit_prep_photos: [],
      pest_identifications: [{ id: 'pi-1', report_contract: JSON.stringify({ v2: { entry: { common_name: 'German cockroach' } } }) }],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0]).not.toHaveProperty('read');
  });

  test('a DONE read merges ONLY the fixed engine fields from the stored contract, batched in one query', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Quarterly Pest Control' }],
      visit_prep_submissions: [
        {
          id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'),
          topic: 'pest', location_on_property: null, note: null, read_status: 'done', read_ref: 'pi-1',
        },
        {
          // Sent just now: a pending read is shown as pending only inside
          // its 15-minute window, so a fixed date would go stale.
          id: 'sub-2', scheduled_service_id: 'svc-1', created_at: new Date(),
          topic: null, location_on_property: null, note: null, read_status: 'pending', read_ref: null,
        },
      ],
      visit_prep_photos: [],
      pest_identifications: [
        {
          id: 'pi-1',
          report_contract: JSON.stringify({
            contract_version: 'pest_id_v1',
            identification: { slug: 'german-cockroach', label: 'German cockroach', category: 'pest_issue' },
            safety: {
              stinging: false, venomous: false, disease_vector: true, structural_threat: false,
            },
            // v1 model prose must never reach the tech read.
            observations: ['MODEL PROSE: looks like a roach near the sink'],
            distinguishing_features: ['MODEL PROSE: maybe'],
            v2: {
              answer: { wording: 'likely', node_id: 'german-cockroach' },
              entry: { slug: 'german-cockroach', common_name: 'German cockroach' },
              evidence: { matches: ['Two dark stripes behind the head'], still_need: ['A clear top-down photo'] },
              referral: null,
            },
          }),
        },
      ],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    const sub1 = facts.find((s) => s.id === 'sub-1');
    expect(sub1.read).toEqual({
      status: 'done',
      wordingTier: 'likely',
      commonName: 'German cockroach',
      groupLabel: null,
      groupHeadline: null,
      matches: ['Two dark stripes behind the head'],
      stillNeed: ['A clear top-down photo'],
      referralKind: null,
      hazards: {
        stinging: false, venomous: false, disease_vector: true, structural_threat: false,
      },
    });
    // No free model prose anywhere in the facts payload — every string in
    // the read object traces back to a fixed catalog/engine field.
    expect(facts.find((s) => s.id === 'sub-2').read).toEqual({ status: 'pending' });
  });
});

describe('readFactsFromContract', () => {
  const { readFactsFromContract } = visitPrep._internal;
  test('a group-only answer carries the catalog group label, never an entry name', () => {
    const facts = readFactsFromContract('done', {
      v2: { answer: { wording: 'group_only' }, entry: null, group: { id: 'ants', label: 'Ants' }, evidence: { matches: [], still_need: [] } },
    });
    expect(facts.commonName).toBeNull();
    expect(facts.groupLabel).toBe('Ants');
  });
  test('a category-level answer (no group block) carries the engine\'s fixed headline', () => {
    const facts = readFactsFromContract('done', {
      v2: { answer: { wording: 'group_only', headline: 'Looks like a beetle' }, entry: null, group: null, evidence: { matches: [], still_need: [] } },
    });
    expect(facts.groupLabel).toBeNull();
    expect(facts.groupHeadline).toBe('Looks like a beetle');
  });

  test('a done read with no stored contract reads as failed, never an empty result', () => {
    expect(readFactsFromContract('done', null)).toEqual({ status: 'failed' });
  });
});

describe('effectiveReadStatus (a read interrupted by a redeploy never sticks on pending)', () => {
  const { effectiveReadStatus } = visitPrep._internal;
  const created = new Date('2026-10-01T12:00:00Z');
  test('pending within 15 minutes stays pending', () => {
    expect(effectiveReadStatus('pending', created, created.getTime() + 14 * 60 * 1000)).toBe('pending');
  });
  test('pending older than 15 minutes reads as failed', () => {
    expect(effectiveReadStatus('pending', created, created.getTime() + 16 * 60 * 1000)).toBe('failed');
  });
  test('a read claimed long after the photos were sent is timed from its claim (Codex #5320 r10)', () => {
    const claimed = new Date(created.getTime() + 3 * 60 * 60 * 1000);
    expect(effectiveReadStatus('pending', created, claimed.getTime() + 5 * 60 * 1000, claimed)).toBe('pending');
    expect(effectiveReadStatus('pending', created, claimed.getTime() + 16 * 60 * 1000, claimed)).toBe('failed');
  });
  test('other statuses pass through', () => {
    for (const s of ['none', 'done', 'failed', 'unsupported']) {
      expect(effectiveReadStatus(s, created, created.getTime() + 60 * 60 * 1000)).toBe(s);
    }
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

  test('keeps members still on svc\'s current technician and date, whatever their status; svc itself always first', async () => {
    const conn = fakeConn({ scheduled_services: members });
    // A cancelled service on the same technician's same stop is the same
    // customer's visit and nobody else sees it, so it still counts.
    expect(await techStopMemberIds({ id: 'svc-A', visit_id: 'visit-9' }, conn)).toEqual(['svc-A', 'svc-B', 'svc-cancelled']);
  });

  test('reads svc\'s technician and date from the database, not the caller\'s copy', async () => {
    const conn = fakeConn({ scheduled_services: members });
    const stale = { id: 'svc-A', visit_id: 'visit-9', technician_id: 'tech-2', scheduled_date: '2026-10-05' };
    expect(await techStopMemberIds(stale, conn)).toEqual(['svc-A', 'svc-B', 'svc-cancelled']);
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

describe('members re-resolved after the read (Codex #5239 r2 P1)', () => {
  // svc-B is on the stop when the member list is first read, then dispatch
  // reassigns it to another technician while the notes are read / the URLs
  // are signed. The second (post-work) membership read no longer includes
  // it, so its note and photo must not come back.
  function reassignedMidRead() {
    const before = [
      { id: 'svc-A', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', service_type: 'Quarterly Pest Control' },
      { id: 'svc-B', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', service_type: 'Quarterly Pest Control' },
    ];
    const after = [before[0], { ...before[1], technician_id: 'tech-2' }];
    const base = fakeConn({
      scheduled_services: before,
      visit_prep_submissions: [
        { id: 'sub-A', scheduled_service_id: 'svc-A', created_at: new Date('2026-09-30T10:00:00Z'), topic: 'pest', location_on_property: null, note: 'mine' },
        { id: 'sub-B', scheduled_service_id: 'svc-B', created_at: new Date('2026-09-30T11:00:00Z'), topic: 'lawn', location_on_property: null, note: 'reassigned away' },
      ],
      visit_prep_photos: [
        { id: 'photo-A', submission_id: 'sub-A', scheduled_service_id: 'svc-A', photo_index: 0, s3_key: 'visitprep/A.jpg' },
        { id: 'photo-B', submission_id: 'sub-B', scheduled_service_id: 'svc-B', photo_index: 0, s3_key: 'visitprep/B.jpg' },
      ],
    });
    let memberReads = 0;
    return (table) => {
      if (table !== 'scheduled_services') return base(table);
      memberReads += 1;
      // Each membership resolution reads the anchor, then its group: the
      // first resolution (reads 1–2) sees svc-B on the stop, the post-work
      // re-resolution sees it reassigned.
      return fakeConn({ scheduled_services: memberReads <= 2 ? before : after })(table);
    };
  }

  test('customerFlaggedFacts drops a sibling reassigned mid-read', async () => {
    const facts = await customerFlaggedFacts({ id: 'svc-A', visit_id: 'visit-9' }, reassignedMidRead());
    expect(facts.map((f) => f.id)).toEqual(['sub-A']);
  });

  test('with reads on, the read contracts are fetched BEFORE the final membership recheck (Codex #5305 r7 P1)', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    process.env.GATE_VISIT_PREP_PEST_READ = 'true';
    process.env.GATE_VISIT_FACTS = 'true';
    try {
      const inner = reassignedMidRead();
      // Both submissions carry a finished read, so the contracts ARE fetched.
      const withReads = fakeConn({
        visit_prep_submissions: [
          { id: 'sub-A', scheduled_service_id: 'svc-A', created_at: new Date('2026-09-30T10:00:00Z'), topic: null, location_on_property: null, note: 'mine', read_status: 'done', read_ref: 'pi-A' },
          { id: 'sub-B', scheduled_service_id: 'svc-B', created_at: new Date('2026-09-30T11:00:00Z'), topic: null, location_on_property: null, note: 'reassigned away', read_status: 'done', read_ref: 'pi-B' },
        ],
        pest_identifications: [
          { id: 'pi-A', report_contract: JSON.stringify({ v2: { entry: { common_name: 'German cockroach' } } }) },
          { id: 'pi-B', report_contract: JSON.stringify({ v2: { entry: { common_name: 'Fire ant' } } }) },
        ],
      });
      const order = [];
      const conn = (table) => {
        order.push(table);
        return (table === 'visit_prep_submissions' || table === 'pest_identifications') ? withReads(table) : inner(table);
      };
      const facts = await customerFlaggedFacts({ id: 'svc-A', visit_id: 'visit-9' }, conn);
      expect(facts.map((f) => f.id)).toEqual(['sub-A']);
      expect(facts[0].read.commonName).toBe('German cockroach');
      expect(order).toContain('pest_identifications');
      const lastMembership = order.lastIndexOf('scheduled_services');
      expect(order.slice(lastMembership + 1)).not.toContain('pest_identifications');
    } finally {
      delete process.env.GATE_VISIT_PREP_PHOTOS;
      delete process.env.GATE_VISIT_PREP_PEST_READ;
    delete process.env.GATE_VISIT_FACTS;
    }
  });

  test('a pest sibling that leaves the stop during the final recheck: the lawn anchor\'s read is not served as pest (Codex #5305 r16)', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    process.env.GATE_VISIT_PREP_PEST_READ = 'true';
    process.env.GATE_VISIT_FACTS = 'true';
    try {
      const before = [
        { id: 'svc-A', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', service_type: 'Lawn Weed & Feed' },
        { id: 'svc-B', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', service_type: 'Quarterly Pest Control' },
      ];
      const after = [before[0], { ...before[1], technician_id: 'tech-2' }];
      const base = fakeConn({
        visit_prep_submissions: [
          { id: 'sub-A', scheduled_service_id: 'svc-A', created_at: new Date(), topic: null, location_on_property: null, note: 'lawn spot', read_status: 'done', read_ref: 'pi-A' },
        ],
        visit_prep_photos: [],
        pest_identifications: [{ id: 'pi-A', report_contract: JSON.stringify({ v2: { entry: { common_name: 'German cockroach' } } }) }],
      });
      let memberReads = 0;
      const conn = (table) => {
        if (table !== 'scheduled_services') return base(table);
        memberReads += 1;
        return fakeConn({ scheduled_services: memberReads <= 2 ? before : after })(table);
      };
      const facts = await customerFlaggedFacts({ id: 'svc-A', visit_id: 'visit-9' }, conn);
      expect(facts.map((f) => f.id)).toEqual(['sub-A']);
      expect(facts[0].read).toEqual({ status: 'unsupported' });
    } finally {
      delete process.env.GATE_VISIT_PREP_PHOTOS;
      delete process.env.GATE_VISIT_PREP_PEST_READ;
      delete process.env.GATE_VISIT_FACTS;
    }
  });

  test('stopPhotoViewUrls drops a sibling reassigned while URLs were signed, and never returns the internal row id', async () => {
    const photos = await stopPhotoViewUrls({ id: 'svc-A', visit_id: 'visit-9' }, reassignedMidRead());
    expect(photos.map((p) => p.id)).toEqual(['photo-A']);
    expect(Object.keys(photos[0]).sort()).toEqual(['id', 'submissionId', 'url']);
  });
});

describe('anchor re-read from the database (Codex #5239 r3 P2)', () => {
  const { techStopMemberIds } = visitPrep;

  test('a requested row regrouped mid-request resolves its CURRENT stop, not the old group', async () => {
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-A', visit_id: 'visit-10', technician_id: 'tech-1', scheduled_date: '2026-10-02' },
        { id: 'svc-B', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02' },
        { id: 'svc-C', visit_id: 'visit-10', technician_id: 'tech-1', scheduled_date: '2026-10-02' },
      ],
    });
    // The caller still holds svc-A's old visit_id (visit-9).
    expect(await techStopMemberIds({ id: 'svc-A', visit_id: 'visit-9' }, conn)).toEqual(['svc-A', 'svc-C']);
  });

  test('a requested row detached from its group resolves to itself only', async () => {
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-A', visit_id: null, technician_id: 'tech-1', scheduled_date: '2026-10-02' },
        { id: 'svc-B', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02' },
      ],
    });
    expect(await techStopMemberIds({ id: 'svc-A', visit_id: 'visit-9' }, conn)).toEqual(['svc-A']);
  });

  test('a requested row that no longer exists resolves to nothing, so neither read returns data', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-B', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02' }],
      visit_prep_submissions: [
        { id: 'sub-B', scheduled_service_id: 'svc-B', created_at: new Date('2026-09-30T10:00:00Z'), topic: null, location_on_property: null, note: 'old group' },
      ],
      visit_prep_photos: [{ id: 'photo-B', submission_id: 'sub-B', scheduled_service_id: 'svc-B', photo_index: 0, s3_key: 'visitprep/B.jpg' }],
    });
    const svc = { id: 'svc-A', visit_id: 'visit-9' };
    expect(await techStopMemberIds(svc, conn)).toEqual([]);
    expect(await customerFlaggedFacts(svc, conn)).toBeNull();
    expect(await stopPhotoViewUrls(svc, conn)).toEqual([]);
  });
});

describe('canonical physical-stop rule (Codex #5239 r4 P2)', () => {
  const { techStopMemberIds } = visitPrep;
  const visit = [{ id: 'visit-9', scheduled_date: '2026-10-02', window_start: '09:00', window_end: '11:00' }];

  test('a same-technician member moved to a non-overlapping window the same day is a second stop', async () => {
    const conn = fakeConn({
      service_visits: visit,
      scheduled_services: [
        { id: 'svc-A', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', window_start: '09:00', window_end: '10:00', status: 'confirmed' },
        { id: 'svc-B', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', window_start: '10:00', window_end: '11:00', status: 'confirmed' },
        { id: 'svc-moved', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', window_start: '15:00', window_end: '16:00', status: 'confirmed' },
      ],
    });
    expect(await techStopMemberIds({ id: 'svc-A', visit_id: 'visit-9' }, conn)).toEqual(['svc-A', 'svc-B']);
  });

  test('a requested row itself moved off the stop resolves to itself only', async () => {
    const conn = fakeConn({
      service_visits: visit,
      scheduled_services: [
        { id: 'svc-A', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', window_start: '15:00', window_end: '16:00', status: 'confirmed' },
        { id: 'svc-B', visit_id: 'visit-9', technician_id: 'tech-1', scheduled_date: '2026-10-02', window_start: '09:00', window_end: '10:00', status: 'confirmed' },
      ],
    });
    expect(await techStopMemberIds({ id: 'svc-A', visit_id: 'visit-9' }, conn)).toEqual(['svc-A']);
  });
});

describe('stopPhotoViewUrls', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no CURRENT-membership photos → []', async () => {
    const conn = fakeConn({ scheduled_services: [{ id: 'svc-1', visit_id: null }], visit_prep_photos: [] });
    const urls = await stopPhotoViewUrls({ id: 'svc-1', visit_id: null }, conn);
    expect(urls).toEqual([]);
    expect(PhotoService.getViewUrl).not.toHaveBeenCalled();
  });

  test('signs every photo on the CURRENT stop membership at the 1-hour TTL, never S3 keys back to the caller', async () => {
    expect(TECH_PHOTO_VIEW_TTL_SECONDS).toBe(3600);
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null }],
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
        { id: 'svc-A', visit_id: 'visit-9', scheduled_date: '2026-10-02' },
        { id: 'svc-B', visit_id: 'visit-9', scheduled_date: '2026-10-02' },
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

// GATE_VISIT_PREP_PLANT_READ — the lawn / tree & shrub sibling of the pest
// read's own facts coverage above. These tests exercise ONLY the additive
// plant path; none of them touch GATE_VISIT_PREP_PEST_READ, so the pest
// suite above is unaffected.
describe('plantReadFactsFromResult', () => {
  const { plantReadFactsFromResult } = visitPrep._internal;

  test('a done row carries only fixed engine/catalog fields, kind=plant', () => {
    const facts = plantReadFactsFromResult('done', {
      subject_type: 'lawn',
      v2: {
        answer: { level: 'entry', wording: 'likely', headline: 'Likely: Brown Patch' },
        subject: { plant: { common_name: 'St. Augustinegrass' } },
        possibilities: [{
          common_name: 'Brown Patch', fits: ['Roughly circular brown patch'], not_yet: ['A smoke-ring edge'], safety_line: null, safety: null,
        }],
        next_step_hint: { kind: 'inspection', text: 'A technician checks this on your next visit.' },
        referral: null,
      },
    });
    expect(facts).toEqual({
      status: 'done',
      kind: 'plant',
      subjectType: 'lawn',
      wordingTier: 'likely',
      headline: 'Likely: Brown Patch',
      plantCommonName: 'St. Augustinegrass',
      weedNames: [],
      conditionName: 'Brown Patch',
      fits: ['Roughly circular brown patch'],
      notYet: ['A smoke-ring edge'],
      nextStepText: 'A technician checks this on your next visit.',
      referralKind: null,
      safetyLines: [],
      hazards: null,
    });
  });

  test('a weed-focused read names the approved weeds the engine found (Codex #5320 r13)', () => {
    const facts = plantReadFactsFromResult('done', {
      subject_type: 'lawn',
      v2: {
        answer: { level: 'symptom', wording: null, headline: 'Weeds in the lawn' },
        subject: { plant: null, weeds: [{ common_name: 'Spotted Spurge', wording: 'likely' }, { common_name: 'Dollarweed', wording: 'possibly' }] },
        possibilities: [],
      },
    });
    expect(facts.weedNames).toEqual(['Spotted Spurge', 'Dollarweed']);
  });

  test('a symptom-level (unnamed) answer carries no conditionName', () => {
    const facts = plantReadFactsFromResult('done', {
      subject_type: 'lawn',
      v2: {
        answer: { level: 'symptom', wording: null, headline: 'Brown patches in the lawn' },
        subject: { plant: null },
        possibilities: [],
        next_step_hint: { kind: 'unclear', text: "We can't tell from these photos; a technician can take a look on your next visit." },
        referral: null,
      },
    });
    expect(facts.conditionName).toBeNull();
    expect(facts.wordingTier).toBeNull();
    expect(facts.headline).toBe('Brown patches in the lawn');
  });

  test('a done row with no stored result reads as failed, never an empty result', () => {
    expect(plantReadFactsFromResult('done', null)).toEqual({ status: 'failed' });
  });

  test('non-done statuses pass through untouched', () => {
    for (const s of ['none', 'pending', 'failed', 'unsupported']) {
      expect(plantReadFactsFromResult(s, null)).toEqual({ status: s });
    }
  });
});

describe('customerFlaggedFacts — plant read integration (GATE_VISIT_PREP_PLANT_READ)', () => {
  beforeEach(() => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    process.env.GATE_VISIT_PREP_PLANT_READ = 'true';
    process.env.GATE_VISIT_FACTS = 'true';
  });
  afterEach(() => {
    delete process.env.GATE_VISIT_PREP_PHOTOS;
    delete process.env.GATE_VISIT_PREP_PLANT_READ;
    delete process.env.GATE_VISIT_FACTS;
  });

  test('a lawn stop with a DONE plant read serves the plant shape from read_result', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Weekly Lawn Care' }],
      visit_prep_submissions: [
        {
          id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'), topic: null, location_on_property: null, note: 'Brown spots', read_status: 'done', read_ref: null,
          read_result: JSON.stringify({
            subject_type: 'lawn',
            v2: {
              answer: { level: 'entry', wording: 'likely', headline: 'Likely: Brown Patch' },
              subject: { plant: { common_name: 'St. Augustinegrass' } },
              possibilities: [{ common_name: 'Brown Patch', fits: ['Roughly circular brown patch'], not_yet: [] }],
              next_step_hint: { kind: 'inspection', text: 'A technician checks this on your next visit.' },
              referral: null,
            },
          }),
        },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read.status).toBe('done');
    expect(facts[0].read.kind).toBe('plant');
    expect(facts[0].read.conditionName).toBe('Brown Patch');
  });

  test('a stop reclassified to pest after a plant read shows unsupported, not a stale plant line', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Quarterly Pest Control' }],
      visit_prep_submissions: [
        {
          id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'), topic: null, location_on_property: null, note: null, read_status: 'done', read_result: JSON.stringify({ subject_type: 'lawn', v2: { answer: { level: 'entry', wording: 'likely' }, possibilities: [{ common_name: 'Brown Patch' }] } }),
        },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'unsupported' });
  });

  test('a PENDING PEST read on a stop reclassified to lawn is not shown as a plant read (unsupported)', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Weekly Lawn Care' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(), topic: null, location_on_property: null, note: null, read_status: 'pending', read_result: null },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'unsupported' });
  });

  test('a fresh unclaimed (none) row on a lawn stop stays none, so the tech panel keeps polling', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Weekly Lawn Care' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(), topic: null, location_on_property: null, note: null, read_status: 'none', read_result: null },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'none' });
  });

  test('an unclaimed row the pest engine marked unsupported on a lawn stop reads none (the plant read hasn\'t claimed yet)', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Weekly Lawn Care' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(), topic: null, location_on_property: null, note: null, read_status: 'unsupported', read_result: null },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'none' });
  });

  test('a DONE lawn read on a stop reclassified to tree & shrub is not shown (unsupported)', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Quarterly Tree & Shrub Care' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(), topic: null, location_on_property: null, note: null, read_status: 'done', read_result: JSON.stringify({ engine: 'plant', subject_type: 'lawn', v2: { answer: { headline: 'Likely: Dollar spot' } } }) },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'unsupported' });
  });

  test('a PENDING lawn read on a stop reclassified to tree & shrub is not shown (unsupported)', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Quarterly Tree & Shrub Care' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(), topic: null, location_on_property: null, note: null, read_status: 'pending', read_result: JSON.stringify({ engine: 'plant', subject_type: 'lawn' }) },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'unsupported' });
  });

  test('a PENDING plant read on a currently-lawn stop shows pending', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Weekly Lawn Care' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date(), topic: null, location_on_property: null, note: null, read_status: 'pending', read_result: JSON.stringify({ engine: 'plant' }) },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0].read).toEqual({ status: 'pending' });
  });

  test('plant-read gate off: stored plant reads are not served at all', async () => {
    delete process.env.GATE_VISIT_PREP_PLANT_READ;
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', visit_id: null, service_type: 'Weekly Lawn Care' }],
      visit_prep_submissions: [
        { id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'), topic: null, location_on_property: null, note: null, read_status: 'done', read_result: JSON.stringify({ subject_type: 'lawn', v2: {} }) },
      ],
      visit_prep_photos: [],
    });
    const facts = await customerFlaggedFacts({ id: 'svc-1', visit_id: null }, conn);
    expect(facts[0]).not.toHaveProperty('read');
  });
});

describe('customerFlaggedFacts — combined Lawn & Pest read (owner ruling 2026-09-30)', () => {
  beforeEach(() => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    process.env.GATE_VISIT_PREP_PEST_READ = 'true';
    process.env.GATE_VISIT_PREP_PLANT_READ = 'true';
    process.env.GATE_VISIT_FACTS = 'true';
  });
  afterEach(() => {
    delete process.env.GATE_VISIT_PREP_PHOTOS;
    delete process.env.GATE_VISIT_PREP_PEST_READ;
    delete process.env.GATE_VISIT_PREP_PLANT_READ;
    delete process.env.GATE_VISIT_FACTS;
  });

  const PLANT_V2 = {
    answer: { level: 'entry', wording: 'likely', headline: 'Likely: Brown Patch' },
    subject: { plant: { common_name: 'St. Augustinegrass' } },
    possibilities: [{ common_name: 'Brown Patch', fits: ['Roughly circular brown patch'], not_yet: [] }],
    next_step_hint: { kind: 'inspection', text: 'A technician checks this on your next visit.' },
    referral: null,
  };
  const PEST_CONTRACT = {
    safety: { stinging: false },
    v2: { answer: { wording: 'likely' }, entry: { common_name: 'German cockroach' }, evidence: { matches: ['Two stripes'], still_need: [] }, referral: null },
  };
  const combo = (overrides = {}, extra = {}) => ({
    id: 'sub-1', scheduled_service_id: 'svc-1', created_at: new Date('2026-09-30T10:00:00Z'), topic: null, location_on_property: null, note: null, read_status: 'done', read_ref: 'pi-1',
    read_result: JSON.stringify({
      engine: 'combo', subject_type: 'lawn', pest: { status: 'done' }, plant: { status: 'done', v2: PLANT_V2 }, ...overrides,
    }),
    ...extra,
  });
  const stopWith = (types, submission) => fakeConn({
    scheduled_services: types.map((service_type, i) => ({ id: `svc-${i + 1}`, visit_id: types.length > 1 ? 'visit-9' : null, scheduled_date: '2026-10-02', service_type, status: 'confirmed' })),
    visit_prep_submissions: [submission],
    visit_prep_photos: [],
    pest_identifications: [{ id: 'pi-1', report_contract: JSON.stringify(PEST_CONTRACT) }],
  });
  const svcFor = (types) => ({ id: 'svc-1', visit_id: types.length > 1 ? 'visit-9' : null });

  test.each([
    ['(a) one combined service_type', ['Quarterly Pest Control Service + Lawn Care Service']],
    ['(b) separate pest-only and lawn-only members', ['Quarterly Pest Control Service', 'Weekly Lawn Care']],
  ])('%s: a DONE combo read serves BOTH notes (pest and lawn)', async (_name, types) => {
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo()));
    const { read } = facts[0];
    expect(read.status).toBe('done');
    expect(read.kind).toBe('combo');
    expect(read.pest).toMatchObject({ status: 'done', commonName: 'German cockroach', matches: ['Two stripes'] });
    expect(read.plant).toMatchObject({ status: 'done', kind: 'plant', subjectType: 'lawn', conditionName: 'Brown Patch', plantCommonName: 'St. Augustinegrass' });
  });

  test('a partial combo (plant failed) serves the pest note and a null plant note', async () => {
    const types = ['Lawn Care + Pest Control'];
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo({ plant: { status: 'failed' } })));
    expect(facts[0].read).toMatchObject({ status: 'done', kind: 'combo', plant: null, pest: { commonName: 'German cockroach' } });
  });

  test('a partial combo (pest failed, no read_ref) serves the plant note and a null pest note', async () => {
    const types = ['Lawn Care + Pest Control'];
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo({ pest: { status: 'failed' } }, { read_ref: null })));
    expect(facts[0].read).toMatchObject({ status: 'done', kind: 'combo', pest: null, plant: { conditionName: 'Brown Patch' } });
  });

  test('a combo read where both parts failed is served as failed (quiet)', async () => {
    const types = ['Lawn Care + Pest Control'];
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo({ pest: { status: 'failed' }, plant: { status: 'failed' } }, { read_status: 'failed', read_ref: null })));
    expect(facts[0].read).toEqual({ status: 'failed' });
  });

  test('a PENDING combo read shows pending (the panel keeps waiting)', async () => {
    const types = ['Lawn Care + Pest Control'];
    const pending = combo({}, { read_status: 'pending', created_at: new Date(), read_result: JSON.stringify({ engine: 'combo', subject_type: 'lawn' }), read_ref: null });
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, pending));
    expect(facts[0].read).toEqual({ status: 'pending' });
  });

  test('a combo read on a stop that lost its lawn part still serves the pest note only', async () => {
    const types = ['Quarterly Pest Control Service'];
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo()));
    expect(facts[0].read).toMatchObject({ status: 'done', kind: 'combo', plant: null, pest: { commonName: 'German cockroach' } });
  });

  test('a combo read whose stop moved to another plant subject hides the plant note', async () => {
    const types = ['Quarterly Pest Control Service', 'Quarterly Tree & Shrub Care'];
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo()));
    expect(facts[0].read).toMatchObject({ kind: 'combo', plant: null, pest: { commonName: 'German cockroach' } });
  });

  test('plant gate dark: only the pest note of a stored combo is served', async () => {
    delete process.env.GATE_VISIT_PREP_PLANT_READ;
    const types = ['Lawn Care + Pest Control'];
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo()));
    expect(facts[0].read).toMatchObject({ kind: 'combo', plant: null, pest: { commonName: 'German cockroach' } });
  });

  test('pest gate dark: only the plant note of a stored combo is served', async () => {
    delete process.env.GATE_VISIT_PREP_PEST_READ;
    const types = ['Lawn Care + Pest Control'];
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo()));
    expect(facts[0].read).toMatchObject({ kind: 'combo', pest: null, plant: { conditionName: 'Brown Patch' } });
  });

  test('a stop that is no combo shape at all (mosquito) serves a stored combo as unsupported', async () => {
    const types = ['Mosquito Control Service'];
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, combo()));
    expect(facts[0].read).toEqual({ status: 'unsupported' });
  });

  test('a stored PEST read on a stop that is now a combo is still shown (until the sweep re-reads it as a combo)', async () => {
    const types = ['Quarterly Pest Control Service', 'Weekly Lawn Care'];
    const pestOnly = combo({}, { read_result: null });
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, pestOnly));
    expect(facts[0].read).toMatchObject({ status: 'done', commonName: 'German cockroach' });
    expect(facts[0].read.kind).toBeUndefined();
  });

  test('a stored PLANT read on a stop that is now a combo is still shown', async () => {
    const types = ['Quarterly Pest Control Service', 'Weekly Lawn Care'];
    const plantOnly = combo({}, { read_ref: null, read_result: JSON.stringify({ engine: 'plant', subject_type: 'lawn', v2: PLANT_V2 }) });
    const facts = await customerFlaggedFacts(svcFor(types), stopWith(types, plantOnly));
    expect(facts[0].read).toMatchObject({ status: 'done', kind: 'plant', conditionName: 'Brown Patch' });
  });
});

describe('plant read safety lines (Codex #5320 r1)', () => {
  const { plantReadFactsFromResult } = visitPrep._internal;
  test('every catalog safety line (plant, weeds, every possibility) is kept, deduplicated', () => {
    const read = plantReadFactsFromResult('done', {
      engine: 'plant',
      v2: {
        answer: { wording: 'likely', level: 'entry', headline: 'Likely: Citrus canker' },
        subject: { plant: { common_name: 'Citrus', safety_line: 'Citrus leaves can upset pets.' }, weeds: [{ safety_line: 'Spotted spurge sap irritates skin.' }] },
        possibilities: [{ common_name: 'Citrus canker', safety_line: null }, { safety_line: 'Spotted spurge sap irritates skin.' }],
      },
    });
    expect(read.safetyLines).toEqual(['Citrus leaves can upset pets.', 'Spotted spurge sap irritates skin.']);
  });
});
