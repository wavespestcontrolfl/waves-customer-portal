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
  const state = { markers: [...markers], deleted: [], upserts: [], upsertRows: [], checkedSince: [], checkedUntil: null };
  const fakeDb = (table) => {
    if (table === 'ops_email_send_state') {
      const builder = {
        // The re-arm sweep scopes its scan with LIKE 'impact-paused:%'. Honour
        // it here — a fake that returns every marker would let the sweep
        // "recover" and delete unrelated keys (e.g. the rollup watermark),
        // which real SQL would never do.
        where: (arg, op, pattern) => {
          if (typeof arg === 'string') { builder._likePrefix = String(pattern || '').replace(/%$/, ''); return builder; }
          builder._key = arg.email_key;
          return builder;
        },
        first: async () => state.markers.find((m) => m.email_key === builder._key) || undefined,
        select: async () => (builder._likePrefix
          ? state.markers.filter((m) => String(m.email_key).startsWith(builder._likePrefix))
          : state.markers),
        del: async () => { state.deleted.push(builder._key); state.markers = state.markers.filter((m) => m.email_key !== builder._key); return 1; },
        insert: (row) => ({ onConflict: () => ({ merge: async () => { state.upserts.push(row.email_key); state.upsertRows.push(row); state.markers.push(row); } }) }),
      };
      return builder;
    }
    const q = {
      where: () => q,
      // checkedSince keys the window on COALESCE(checked_21d_at,
      // checked_14d_at). Capture the SQL + boundary so both the
      // single-verdict-per-row semantics and the inclusive/exclusive window
      // are assertable.
      whereRaw: (sql, binds) => {
        if (sql.includes('<=')) { state.checkedUntil = binds && binds[0]; return q; }
        const op = /COALESCE\([^)]*\)\s*(>=|>)/.exec(sql);
        state.checkedSince.push({ sql, op: op ? op[1] : null, since: binds && binds[0] });
        return q;
      },
      orWhere: () => q,
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
  test('stays silent below the measured floor — a quiet engine is not a blind one', () => {
    expect(composeBlindLoopAlert({ ungraded: 4 })).toBeNull();
    expect(composeBlindLoopAlert({ ungraded: 0 })).toBeNull();
  });

  test('fires FIX: once enough optimizations were measured and none graded', () => {
    const out = composeBlindLoopAlert({ ungraded: 12 });
    expect(out.subject).toBe('FIX: impact loop graded nothing in 21 days — 12 measured, none graded');
    expect(out.text).toContain('cannot grade its own work');
  });

  test('counts OPTIMIZATIONS, never "checks" — one row can carry two check events but only one verdict', () => {
    // checkPending writes a provisional verdict at 14d and overwrites it at
    // 21d, so the row set cannot honestly report a number of check events.
    const out = composeBlindLoopAlert({ ungraded: 12 });
    expect(out.text).not.toMatch(/\bchecks\b/);
    expect(out.subject).not.toMatch(/\bchecks\b/);
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

  test('FAIL CLOSED: a non-internal recipient skips the send — and reads as a FAILED job', async () => {
    process.env.IMPACT_DIGEST_EMAIL = 'someone@gmail.com';
    const fakeDb = makeDb();
    // A finding existed but could not be delivered: job_health must not record
    // a healthy run (the turf-variance convention).
    await expect(digest.sendImpactDigestsIfDue({
      db: fakeDb, sendgrid, tracker: tracker([{ bucket: 'thin_content', regressions: 3 }]),
    })).rejects.toThrow(/paused:recipient/);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a failing leg never suppresses the others — every leg still runs before the throw', async () => {
    const fakeDb = makeDb();
    const exploding = { pausedBuckets: async () => { throw new Error('boom') } };
    // The rollup leg reads ops_email_send_state; if the paused leg had
    // short-circuited the loop, that read would never happen.
    await expect(digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: exploding }))
      .rejects.toThrow(/paused:error/);
  });

  test('an unreadable pause state stands down instead of wiping every dedupe marker', async () => {
    // pausedBuckets returns [] on its own query error by default, which would
    // read as "every paused lane recovered" and delete all markers.
    const fakeDb = makeDb({ markers: [{ email_key: pausedMarkerKey('thin_content'), last_sent_at: new Date() }] });
    const strictTracker = { pausedBuckets: jest.fn(async ({ strict }) => { if (strict) throw new Error('db down'); return []; }) };
    await expect(digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: strictTracker }))
      .rejects.toThrow(/paused:error/);
    expect(strictTracker.pausedBuckets).toHaveBeenCalledWith(expect.objectContaining({ strict: true }));
    expect(fakeDb.state.deleted).toHaveLength(0);
  });

  test('a quiet run is healthy — no throw when every leg simply has nothing to say', async () => {
    const fakeDb = makeDb();
    const out = await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: tracker([]) });
    expect(out.paused.skipped).toBe('none-paused');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
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

  test('the previous send is an EXCLUSIVE watermark, so its boundary batch is not recounted', async () => {
    // Last week's rollup went out on the 8am tick; those checks are stamped at
    // (or a beat after) that instant, and a >= boundary would sweep the whole
    // batch into this week's email too.
    const lastSent = new Date(Date.now() - 8 * 86400000);
    const fakeDb = makeDb({
      rows: [{ verdict: 'improved' }],
      markers: [{ email_key: 'impact-verdict-rollup', last_sent_at: lastSent }],
    });
    await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: { pausedBuckets: async () => [] } });

    const rollupQuery = fakeDb.state.checkedSince.at(-1);
    expect(rollupQuery.op).toBe('>');
    expect(rollupQuery.since.getTime()).toBe(lastSent.getTime());
  });

  test('with no prior send it falls back to the fixed window, inclusive', async () => {
    const fakeDb = makeDb({ rows: [{ verdict: 'improved' }] });
    await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: { pausedBuckets: async () => [] } });

    const rollupQuery = fakeDb.state.checkedSince.at(-1);
    expect(rollupQuery.op).toBe('>=');
  });

  test('is NOT due at six days — the alert markers\' re-nag interval must not shorten the week', async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 86400000);
    const fakeDb = makeDb({
      rows: [{ verdict: 'improved' }],
      markers: [{ email_key: 'impact-verdict-rollup', last_sent_at: sixDaysAgo }],
    });
    const out = await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: { pausedBuckets: async () => [] } });
    expect(out.rollup.skipped).toBe('not-due');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('IS due at seven days, even though the marker was stamped at that tick\'s own cutoff', async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    const fakeDb = makeDb({
      rows: [{ verdict: 'improved' }],
      markers: [{ email_key: 'impact-verdict-rollup', last_sent_at: sevenDaysAgo }],
    });
    const out = await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: { pausedBuckets: async () => [] } });
    expect(out.rollup.sent).toBe(true);
  });

  test('an UNREADABLE watermark stands down — it must not fall back and then advance the marker', async () => {
    // A real watermark older than 7d that we cannot see would otherwise be
    // replaced by a 7d fallback window, and the stamp would skip everything
    // between the two boundaries forever.
    const fakeDb = makeDb({ rows: [{ verdict: 'improved' }] });
    let call = 0;
    const orig = fakeDb.state.markers;
    fakeDb.state.markers = orig;
    const brokenDb = (table) => {
      if (table === 'ops_email_send_state') {
        call += 1;
        // First read is sentRecently's; the second is the watermark read.
        if (call >= 2) return { where: () => ({ first: async () => { throw new Error('db down'); } }) };
      }
      return fakeDb(table);
    };
    brokenDb.state = fakeDb.state;

    await expect(digest.sendImpactDigestsIfDue({ db: brokenDb, sendgrid, tracker: { pausedBuckets: async () => [] } }))
      .rejects.toThrow(/rollup:error/);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(fakeDb.state.upserts).not.toContain('impact-verdict-rollup');
  });

  test('the query is upper-bounded and the STAMP is that same cutoff, not the send time', async () => {
    // checkPending runs outside this module's lock. Without an upper bound,
    // a verdict written by a concurrent sweep after our query but before our
    // stamp would fall below the next window's `>` boundary and be lost.
    const fakeDb = makeDb({ rows: [{ verdict: 'improved' }] });
    await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: { pausedBuckets: async () => [] } });

    const cutoff = fakeDb.state.checkedUntil;
    expect(cutoff).toBeInstanceOf(Date);
    const stamped = fakeDb.state.upsertRows.find((r) => r.email_key === 'impact-verdict-rollup');
    expect(stamped.last_sent_at.getTime()).toBe(cutoff.getTime());
  });

  test('the window keys on the LATEST check, so the verdict always matches the event', async () => {
    // One row = one verdict (21d overwrites 14d). Selecting on "either
    // timestamp in window" would report a 14d-selected row under a verdict
    // written at 21d.
    const fakeDb = makeDb({ rows: [{ verdict: 'improved' }] });
    await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: { pausedBuckets: async () => [] } });

    for (const q of fakeDb.state.checkedSince) {
      expect(q.sql).toContain('COALESCE(checked_21d_at, checked_14d_at)');
    }
  });

  test('the subject describes the ACTUAL window, not a hardcoded 7d', async () => {
    const lastSent = new Date(Date.now() - 12 * 86400000);
    const fakeDb = makeDb({
      rows: [{ verdict: 'improved' }],
      markers: [{ email_key: 'impact-verdict-rollup', last_sent_at: lastSent }],
    });
    await digest.sendImpactDigestsIfDue({ db: fakeDb, sendgrid, tracker: { pausedBuckets: async () => [] } });
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('(12d)') }));
  });
});

describe('email links', () => {
  test('point at a REGISTERED admin route', () => {
    // /admin/content is not in the client router; the content UI lives at
    // /admin/blog?tab=autopilot.
    for (const email of [
      composePausedAlert([{ bucket: 'thin_content', regressions: 3 }]),
      composeBlindLoopAlert({ ungraded: 12 }),
      composeVerdictRollup([{ verdict: 'improved' }]),
    ]) {
      expect(email.text).toContain('/admin/blog?tab=autopilot');
      expect(email.text).not.toMatch(/\/admin\/content\b/);
    }
  });
});
