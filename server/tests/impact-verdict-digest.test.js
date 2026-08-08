jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: (_name, fn) => fn() }));

const digest = require('../services/seo/impact-verdict-digest');
const { composePausedAlert, composeBlindLoopAlert, composeVerdictRollup } = digest;
const { tallyVerdicts, pausedMarkerKey } = digest._internals;

// Minimal knex stand-in. `markers` is the ops_email_send_state table; every
// other table read resolves to `rows`. Records what was inserted/deleted so
// the marker lifecycle can be asserted.
function makeDb({ rows = [], markers = [] } = {}) {
  const state = { markers: [...markers], deleted: [], upserts: [] };
  const fakeDb = (table) => {
    if (table === 'ops_email_send_state') {
      const builder = {
        where: (arg) => {
          if (typeof arg === 'string') { builder._like = true; return builder; }
          builder._key = arg.email_key;
          return builder;
        },
        first: async () => state.markers.find((m) => m.email_key === builder._key) || undefined,
        select: async () => state.markers,
        del: async () => { state.deleted.push(builder._key); state.markers = state.markers.filter((m) => m.email_key !== builder._key); return 1; },
        insert: (row) => ({ onConflict: () => ({ merge: async () => { state.upserts.push(row.email_key); state.markers.push(row); } }) }),
      };
      return builder;
    }
    const q = {
      where: () => q, orWhere: () => q,
      select: async () => rows,
      then: (res) => Promise.resolve(rows).then(res),
    };
    return q;
  };
  fakeDb.state = state;
  return fakeDb;
}

const sendgrid = require('../services/sendgrid-mail');

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  process.env.GATE_IMPACT_DIGEST = 'true';
  delete process.env.IMPACT_DIGEST_EMAIL;
});

afterAll(() => { delete process.env.GATE_IMPACT_DIGEST; });

describe('composePausedAlert', () => {
  test('null when no bucket is paused — a quiet day sends nothing', () => {
    expect(composePausedAlert([])).toBeNull();
    expect(composePausedAlert(undefined)).toBeNull();
  });

  test('single bucket: FIX: subject names the bucket and the regression count', () => {
    const out = composePausedAlert([{ bucket: 'thin_content', regressions: 3 }]);
    expect(out.subject).toBe('FIX: content lane auto-paused — thin_content (3 confirmed regressions)');
    expect(out.text).toContain('STOPPED drafting');
    expect(out.buckets).toEqual(['thin_content']);
  });

  test('multiple buckets collapse into one email', () => {
    const out = composePausedAlert([
      { bucket: 'thin_content', regressions: 3 },
      { bucket: 'aeo_gap', regressions: 4 },
    ]);
    expect(out.subject).toBe('FIX: 2 content lanes auto-paused — thin_content, aeo_gap');
    expect(out.buckets).toEqual(['thin_content', 'aeo_gap']);
  });

  test('bucket names are HTML-escaped', () => {
    const out = composePausedAlert([{ bucket: '<img src=x>', regressions: 3 }]);
    expect(out.html).not.toContain('<img src=x>');
    expect(out.html).toContain('&lt;img src=x&gt;');
  });
});

describe('composeBlindLoopAlert', () => {
  test('stays silent below the checked floor — a quiet engine is not a blind one', () => {
    expect(composeBlindLoopAlert({ checked: 4 })).toBeNull();
    expect(composeBlindLoopAlert({ checked: 0 })).toBeNull();
  });

  test('fires FIX: once enough rows were checked and none graded', () => {
    const out = composeBlindLoopAlert({ checked: 12 });
    expect(out.subject).toBe('FIX: impact loop graded nothing in 21 days — 12 checks, all insufficient data');
    expect(out.text).toContain('cannot grade its own work');
  });
});

describe('composeVerdictRollup', () => {
  test('null when nothing was graded — the blind-loop leg owns that case', () => {
    expect(composeVerdictRollup([])).toBeNull();
    expect(composeVerdictRollup([{ verdict: 'insufficient_data' }])).toBeNull();
  });

  test('OK: when the window is clean, FYI: once anything regressed', () => {
    const clean = composeVerdictRollup([{ verdict: 'improved' }, { verdict: 'neutral' }]);
    expect(clean.subject).toBe('OK: content impact — 1 improved, 1 neutral (7d)');

    const dirty = composeVerdictRollup([
      { verdict: 'improved' },
      { verdict: 'regressed', page_url: 'https://x.test/a', bucket: 'thin_content', estimated_lift_position: -4.2 },
    ]);
    expect(dirty.subject).toBe('FYI: content impact — 1 improved, 1 regressed (7d)');
    expect(dirty.text).toContain('https://x.test/a');
  });

  test('insufficient_data is reported but never counted as measured', () => {
    const out = composeVerdictRollup([{ verdict: 'improved' }, { verdict: 'insufficient_data' }]);
    expect(out.measured).toBe(1);
    expect(out.counts.insufficient_data).toBe(1);
  });
});

describe('tallyVerdicts', () => {
  test('ignores null and unknown verdicts', () => {
    expect(tallyVerdicts([{ verdict: null }, { verdict: 'bogus' }, { verdict: 'improved' }]))
      .toEqual({ improved: 1, neutral: 0, regressed: 0, insufficient_data: 0 });
  });
});

describe('paused-lane leg — marker lifecycle', () => {
  const tracker = (paused) => ({ pausedBuckets: async () => paused });

  test('sends once, then suppresses while the bucket stays paused', async () => {
    const fakeDb = makeDb();
    const paused = [{ bucket: 'thin_content', regressions: 3 }];

    const first = await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: tracker(paused) });
    expect(first.paused.sent).toBe(true);
    expect(fakeDb.state.upserts).toContain(pausedMarkerKey('thin_content'));

    sendgrid.sendOne.mockClear();
    const second = await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: tracker(paused) });
    expect(second.paused.skipped).toBe('already-alerted');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a recovered bucket clears its marker so a re-pause alerts immediately', async () => {
    const fakeDb = makeDb({ markers: [{ email_key: pausedMarkerKey('thin_content'), last_sent_at: new Date() }] });
    const out = await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: tracker([]) });
    expect(out.paused.skipped).toBe('none-paused');
    expect(fakeDb.state.deleted).toContain(pausedMarkerKey('thin_content'));
  });

  test('gate OFF shadow-logs and never sends or stamps', async () => {
    process.env.GATE_IMPACT_DIGEST = 'false';
    const fakeDb = makeDb();
    const out = await digest.sendImpactDigestsIfDue({
      db: fakeDb, sendgrid, tracker: tracker([{ bucket: 'thin_content', regressions: 3 }]),
    });
    expect(out.paused.skipped).toBe('gated');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(fakeDb.state.upserts).toHaveLength(0);
  });

  test('FAIL CLOSED: a non-internal recipient skips the send', async () => {
    process.env.IMPACT_DIGEST_EMAIL = 'someone@gmail.com';
    const fakeDb = makeDb();
    const out = await digest.sendImpactDigestsIfDue({
      db: fakeDb, sendgrid, tracker: tracker([{ bucket: 'thin_content', regressions: 3 }]),
    });
    expect(out.paused.skipped).toBe('recipient');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a failing leg never suppresses the others', async () => {
    const fakeDb = makeDb();
    const exploding = { pausedBuckets: async () => { throw new Error('boom'); } };
    const out = await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: exploding });
    expect(out.paused.skipped).toBe('error');
    expect(out).toHaveProperty('blind');
    expect(out).toHaveProperty('rollup');
  });
});

describe('rollup leg — quiet windows do not stamp the weekly marker', () => {
  test('empty window sends nothing and leaves the marker unset', async () => {
    const fakeDb = makeDb({ rows: [] });
    const out = await digest.sendImpactDigestsIfDue({
      db: fakeDb, sendgrid, tracker: { pausedBuckets: async () => [] },
    });
    expect(out.rollup.skipped).toBe('empty');
    expect(fakeDb.state.upserts).not.toContain('impact-verdict-rollup');
  });
});
