/**
 * reportPhotoSetPdfSignature — photo-set key component + render fence input
 * (Codex #4091 P1: a public /pdf render started before recovered closeout
 * photos land is untracked by service_report_pdf_jobs and would otherwise
 * store its photo-less output under the deterministic key).
 *
 * Also covers two pre-push P1s (2026-09-28):
 *  - Round 1: a lawn visit's report/preview can show a customer-visible
 *    lawn_assessment_photos row (report-data.js appends these to the
 *    gallery/previewPhoto candidate for serviceLine === 'lawn') even with
 *    ZERO service_photos rows, so the old service_photos-only signature
 *    stayed unmoved while the shown photo changed. report-data.js and this
 *    signature resolve that set through the SAME function,
 *    resolveLawnReportPhotos (report-photo-set.js).
 *  - Round 2: the render's before/after slider also shows a customer-visible
 *    photo from the visit's BASELINE assessment, not only the currently
 *    linked one — the signature ignored that assessment entirely — and an
 *    all-turf-photos-hidden lawn visit collapsed back onto the exact bare
 *    key a pre-this-change cached PDF used, serving it forever. Both are
 *    fixed by resolveLawnPhotoAssessmentIds (current + baseline assessment
 *    identity, shared with the render via report-data.js's
 *    resolveLawnAssessmentAndHistory) and an unconditional, versioned
 *    '-lp<count>-<digest>' term for every lawn service line.
 */
const { reportPhotoSetPdfSignature } = require('../services/service-report/photo-set-signature');

const knexWith = (rows, serviceData = null) => (table) => {
  const chain = {
    where() { return chain; },
    orderBy() { return chain; },
    async select() { if (rows === 'throw') throw new Error('down'); return rows; },
    async first() { return table === 'service_records' ? { service_data: serviceData } : null; },
  };
  return chain;
};
const parked = { typedReportSnapshot: { photoSummary: null, photoSummaryPendingRecovery: 'Three shrubs treated.' } };
const restored = { typedReportSnapshot: { photoSummary: 'Three shrubs treated.' } };

describe('reportPhotoSetPdfSignature', () => {
  test('no photo rows → empty: photo-less reports keep their existing keys', async () => {
    expect(await reportPhotoSetPdfSignature('rec-1', knexWith([]))).toBe('');
    expect(await reportPhotoSetPdfSignature(null, knexWith([{ id: 'p1' }]))).toBe('');
    expect(await reportPhotoSetPdfSignature('rec-1', null)).toBe('');
  });

  test('derives from the SET of rows — a recovered photo moves the key', async () => {
    const one = await reportPhotoSetPdfSignature('rec-1', knexWith([{ id: 'p1' }]));
    const two = await reportPhotoSetPdfSignature('rec-1', knexWith([{ id: 'p1' }, { id: 'p2' }]));
    const swapped = await reportPhotoSetPdfSignature('rec-1', knexWith([{ id: 'p9' }]));
    expect(one).toMatch(/^-ph1-[0-9a-f]{8}$/);
    expect(two).toMatch(/^-ph2-[0-9a-f]{8}$/);
    expect(new Set([one, two, swapped]).size).toBe(3);
    expect(await reportPhotoSetPdfSignature('rec-1', knexWith([{ id: 'p1' }]))).toBe(one);
  });

  test('the parked photo summary is part of the identity: restoring it moves the key even with the same rows', async () => {
    const rows = [{ id: 'p1' }, { id: 'p2' }];
    const whileParked = await reportPhotoSetPdfSignature('rec-1', knexWith(rows, parked));
    const afterRestore = await reportPhotoSetPdfSignature('rec-1', knexWith(rows, restored));
    expect(whileParked).toMatch(/^-ph2-[0-9a-f]{8}-ps$/);
    expect(afterRestore).toMatch(/^-ph2-[0-9a-f]{8}$/);
    expect(whileParked).not.toBe(afterRestore);
    // jsonb delivered as a string is handled the same way.
    expect(await reportPhotoSetPdfSignature('rec-1', knexWith(rows, JSON.stringify(parked)))).toBe(whileParked);
    // Every closeout upload failed (no rows) but the summary is parked: still keyed.
    expect(await reportPhotoSetPdfSignature('rec-1', knexWith([], parked))).toBe('-ps');
  });

  test('options.serviceData derives the marker from the caller\'s loaded snapshot, not a fresh read (pre-push P1 on 3d69b662c)', async () => {
    const rows = [{ id: 'p1' }, { id: 'p2' }];
    let recordReads = 0;
    const counting = (liveData) => (table) => {
      const chain = knexWith(rows, liveData)(table);
      const first = chain.first;
      chain.first = async () => { recordReads += 1; return first(); };
      return chain;
    };
    // Snapshot loaded while parked; the summary was restored before the
    // BEFORE capture ran. The capture must still say "parked" (what the
    // render will print), so the live AFTER re-read differs and the fence trips.
    // recordReads still climbs by exactly 1 per call either way (the lawn-
    // photo identity check always reads service_records once for
    // customer_id/service_line — this mock's service line never resolves to
    // 'lawn', so it contributes no signature part, but the read itself still
    // happens) — the invariant this test protects is that the MARKER never
    // comes from that read, only from options.serviceData when given; that's
    // what the marker assertions below still check.
    const before = await reportPhotoSetPdfSignature('rec-1', counting(restored), { serviceData: parked });
    expect(before).toMatch(/-ps$/);
    expect(recordReads).toBe(1);
    const after = await reportPhotoSetPdfSignature('rec-1', counting(restored));
    expect(after).not.toMatch(/-ps$/);
    expect(recordReads).toBe(2);
    expect(before).not.toBe(after);
    // A snapshot with nothing parked (null / string jsonb) → no marker.
    expect(await reportPhotoSetPdfSignature('rec-1', counting(parked), { serviceData: null })).toMatch(/^-ph2-[0-9a-f]{8}$/);
    expect(await reportPhotoSetPdfSignature('rec-1', counting(parked), { serviceData: JSON.stringify(parked) })).toBe(before);
    expect(recordReads).toBe(4);
  });

  test('a failed lookup is a UNIQUE token: never matches a stored key, trips the fence', async () => {
    const a = await reportPhotoSetPdfSignature('rec-1', knexWith('throw'));
    const b = await reportPhotoSetPdfSignature('rec-1', knexWith('throw'));
    expect(a).toMatch(/^-phu-/);
    expect(a).not.toBe(b);
  });

  test('options.serviceData without lawnFields and a vanished service_records row → failure token, never a non-lawn key', async () => {
    const vanished = (table) => {
      const chain = knexWith([{ id: 'p1' }])(table);
      chain.first = async () => undefined;
      return chain;
    };
    const a = await reportPhotoSetPdfSignature('rec-1', vanished, { serviceData: null });
    expect(a).toMatch(/^-phu-/);
    // Same without serviceData (pdf-queue's post-render re-check shape).
    expect(await reportPhotoSetPdfSignature('rec-1', vanished)).toMatch(/^-phu-/);
  });
});

describe('reportPhotoSetPdfSignature — lawn turf photo identity (pre-push P1s, 2026-09-28)', () => {
  const LAWN_SERVICE_RECORD = {
    service_data: null,
    customer_id: 'cust-1',
    service_line: 'lawn',
    service_type: 'Lawn Care',
    scheduled_service_id: 'sched-1',
    service_id: null,
  };
  const CURRENT_ASSESSMENT = { id: 'assess-current', confirmed_by_tech: true, service_date: '2026-08-01', created_at: '2026-08-01T00:00:00Z' };
  const BASELINE_ASSESSMENT = { id: 'assess-baseline', confirmed_by_tech: true, service_date: '2026-02-01', created_at: '2026-02-01T00:00:00Z' };

  // A minimal knex fake covering exactly the tables reportPhotoSetPdfSignature
  // touches for a lawn record:
  //  - service_photos / service_records: as before
  //  - lawn_assessments: TWO distinct query shapes hit this same table —
  //    loadLinkedLawnAssessment's "find the one linked to this visit" (ends
  //    in .first(), keyed by service_record_id/service_id) and
  //    resolveLawnAssessmentAndHistory's plain-gate-off "every confirmed
  //    assessment for this customer" list (awaited directly or via .catch(),
  //    never .first()) — distinguished here by which .where() keys arrive,
  //    exactly like the real two call sites.
  //  - lawn_assessment_photos: resolveLawnReportPhotos, now whereIn-based to
  //    cover more than one assessment id at once.
  function knexForLawn({
    turfPhotosByAssessment = {}, // { [assessmentId]: rows | 'throw' }
    currentAssessment = CURRENT_ASSESSMENT,
    historyAssessments = [CURRENT_ASSESSMENT], // ascending service_date, as the real query orders it
    serviceRecord = LAWN_SERVICE_RECORD,
    servicePhotoRows = [],
  } = {}) {
    return (table) => {
      if (table === 'service_photos') {
        const chain = { where() { return chain; }, orderBy() { return chain; }, async select() { return servicePhotoRows; } };
        return chain;
      }
      if (table === 'service_records') {
        return { where() { return this; }, async first() { return serviceRecord; } };
      }
      if (table === 'lawn_assessments') {
        let mode = null;
        const chain = {
          where(cond) {
            if (cond && (Object.hasOwn(cond, 'service_record_id') || Object.hasOwn(cond, 'service_id'))) mode = 'current';
            else if (mode == null) mode = 'history';
            return chain;
          },
          orderBy() { return chain; },
          async first() {
            if (mode !== 'current') return null;
            if (currentAssessment === 'throw') throw new Error('lawn_assessments (current) query failed');
            return currentAssessment;
          },
          then(resolve, reject) {
            if (historyAssessments === 'throw') return Promise.reject(new Error('lawn_assessments (history) query failed')).then(resolve, reject);
            return Promise.resolve(historyAssessments).then(resolve, reject);
          },
          catch(fn) {
            if (historyAssessments === 'throw') return Promise.reject(new Error('lawn_assessments (history) query failed')).catch(fn);
            return Promise.resolve(historyAssessments).catch(fn);
          },
        };
        return chain;
      }
      if (table === 'lawn_assessment_photos') {
        // failClosed:true (resolveLawnReportPhotos) awaits this chain
        // directly, with no .catch() call of its own — so it must be
        // properly thenable, not just support .catch(fn) the way the
        // fail-soft render path calls it.
        let requestedIds = [];
        const chain = {
          whereIn(col, ids) { requestedIds = ids; return chain; },
          where() { return chain; },
          orderBy() { return chain; },
          then(resolve, reject) {
            if (requestedIds.some((id) => turfPhotosByAssessment[id] === 'throw')) {
              return Promise.reject(new Error('lawn_assessment_photos query failed')).then(resolve, reject);
            }
            const rows = requestedIds.flatMap((id) => turfPhotosByAssessment[id] || []);
            return Promise.resolve(rows).then(resolve, reject);
          },
          catch(fn) {
            if (requestedIds.some((id) => turfPhotosByAssessment[id] === 'throw')) {
              return Promise.reject(new Error('lawn_assessment_photos query failed')).catch(fn);
            }
            const rows = requestedIds.flatMap((id) => turfPhotosByAssessment[id] || []);
            return Promise.resolve(rows).catch(fn);
          },
        };
        return chain;
      }
      throw new Error(`unexpected table in this test's knex fake: ${table}`);
    };
  }

  test('options.lawnFields (caller already has the service_records row) skips the extra service_records read (Sonnet fallback-audit P1, 2026-09-28)', async () => {
    let recordReads = 0;
    const counting = (config) => (table) => {
      const chain = knexForLawn(config)(table);
      if (table === 'service_records') {
        const first = chain.first;
        chain.first = async (...args) => { recordReads += 1; return first(...args); };
      }
      return chain;
    };
    const turfPhotosByAssessment = { [CURRENT_ASSESSMENT.id]: [{ id: 'tp-1', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-09-01T00:00:00Z' }] };
    const withLawnFields = await reportPhotoSetPdfSignature('rec-lawn-1', counting({ turfPhotosByAssessment }), {
      serviceData: null,
      lawnFields: LAWN_SERVICE_RECORD,
    });
    expect(recordReads).toBe(0);
    // Identical to the same scenario resolved the slow way (an extra
    // service_records read) — passing lawnFields changes nothing about the
    // computed signature, only whether this function fetches it itself.
    const withoutLawnFields = await reportPhotoSetPdfSignature('rec-lawn-1', counting({ turfPhotosByAssessment }), { serviceData: null });
    expect(recordReads).toBe(1);
    expect(withLawnFields).toBe(withoutLawnFields);
    expect(withLawnFields).toMatch(/-lp1-[0-9a-f]{8}/);
  });

  test('a lawn visit with zero service_photos and one linked customer-visible turf photo → signature differs from the empty set', async () => {
    const withPhoto = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      turfPhotosByAssessment: { [CURRENT_ASSESSMENT.id]: [{ id: 'tp-1', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-09-01T00:00:00Z' }] },
    }));
    const withoutPhoto = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotosByAssessment: {} }));
    expect(withPhoto).toMatch(/-lp1-[0-9a-f]{8}/);
    expect(withoutPhoto).toMatch(/-lp0-[0-9a-f]{8}/);
    expect(withPhoto).not.toBe(withoutPhoto);
    // This is exactly the finding this closes: previously a gate-on preview
    // built from zero service_photos stayed bare '-pgon' either way; now the
    // signature the writer/reader compare actually moves.
    expect(`-pgon${withPhoto}`).not.toBe(`-pgon${withoutPhoto}`);
  });

  test('hiding or removing the CURRENT assessment\'s turf photo changes the signature', async () => {
    // resolveLawnReportPhotos only ever sees customer_visible: true rows, so
    // "hidden" and "removed" are the same thing from here: the row simply
    // isn't in the result set any more — exactly what the mock simulates.
    const visible = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      turfPhotosByAssessment: { [CURRENT_ASSESSMENT.id]: [{ id: 'tp-1', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-09-01T00:00:00Z' }] },
    }));
    const hidden = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotosByAssessment: {} }));
    expect(visible).not.toBe(hidden);
  });

  test('replacing the CURRENT assessment\'s turf photo (same row, updated_at bumped) changes the signature', async () => {
    const before = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      turfPhotosByAssessment: { [CURRENT_ASSESSMENT.id]: [{ id: 'tp-1', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-09-01T00:00:00Z' }] },
    }));
    const after = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      turfPhotosByAssessment: { [CURRENT_ASSESSMENT.id]: [{ id: 'tp-1', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-09-05T00:00:00Z' }] },
    }));
    expect(before).not.toBe(after);
  });

  test('a visit with lawn history hashes BOTH the current and baseline assessment\'s turf photos', async () => {
    const historyAssessments = [BASELINE_ASSESSMENT, CURRENT_ASSESSMENT];
    const withBoth = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      historyAssessments,
      turfPhotosByAssessment: {
        [BASELINE_ASSESSMENT.id]: [{ id: 'tp-base', assessment_id: BASELINE_ASSESSMENT.id, updated_at: '2026-02-01T00:00:00Z' }],
        [CURRENT_ASSESSMENT.id]: [{ id: 'tp-cur', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-08-01T00:00:00Z' }],
      },
    }));
    expect(withBoth).toMatch(/-lp2-[0-9a-f]{8}/);

    // Hiding/replacing the BASELINE photo (current photo untouched) moves the
    // signature — the P1 this round closes: the render's before/after slider
    // shows this photo too, and the old signature never looked past the
    // currently linked assessment.
    const baselineHidden = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      historyAssessments,
      turfPhotosByAssessment: {
        [CURRENT_ASSESSMENT.id]: [{ id: 'tp-cur', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-08-01T00:00:00Z' }],
      },
    }));
    expect(baselineHidden).toMatch(/-lp1-[0-9a-f]{8}/);
    expect(baselineHidden).not.toBe(withBoth);

    const baselineReplaced = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      historyAssessments,
      turfPhotosByAssessment: {
        [BASELINE_ASSESSMENT.id]: [{ id: 'tp-base', assessment_id: BASELINE_ASSESSMENT.id, updated_at: '2026-02-15T00:00:00Z' }],
        [CURRENT_ASSESSMENT.id]: [{ id: 'tp-cur', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-08-01T00:00:00Z' }],
      },
    }));
    expect(baselineReplaced).not.toBe(withBoth);

    // Hiding/replacing the CURRENT photo (baseline untouched) also moves it,
    // and lands somewhere different from hiding the baseline photo — the two
    // are independent contributions to the same hash.
    const currentHidden = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      historyAssessments,
      turfPhotosByAssessment: {
        [BASELINE_ASSESSMENT.id]: [{ id: 'tp-base', assessment_id: BASELINE_ASSESSMENT.id, updated_at: '2026-02-01T00:00:00Z' }],
      },
    }));
    expect(currentHidden).toMatch(/-lp1-[0-9a-f]{8}/);
    expect(currentHidden).not.toBe(withBoth);
    expect(currentHidden).not.toBe(baselineHidden);
  });

  test('when the current assessment IS the earliest one (no separate baseline), only one assessment is hashed', async () => {
    const result = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      historyAssessments: [CURRENT_ASSESSMENT],
      turfPhotosByAssessment: {
        [CURRENT_ASSESSMENT.id]: [{ id: 'tp-1', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-08-01T00:00:00Z' }],
      },
    }));
    expect(result).toMatch(/-lp1-[0-9a-f]{8}/);
  });

  test('turf-photo signature ordering is deterministic for the same row set', async () => {
    const historyAssessments = [BASELINE_ASSESSMENT, CURRENT_ASSESSMENT];
    const turfPhotosByAssessment = {
      [BASELINE_ASSESSMENT.id]: [{ id: 'tp-base', assessment_id: BASELINE_ASSESSMENT.id, updated_at: '2026-02-01T00:00:00Z' }],
      [CURRENT_ASSESSMENT.id]: [{ id: 'tp-1', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-08-01T00:00:00Z' }, { id: 'tp-2', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-08-02T00:00:00Z' }],
    };
    const a = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ historyAssessments, turfPhotosByAssessment }));
    const b = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ historyAssessments, turfPhotosByAssessment: { ...turfPhotosByAssessment } }));
    expect(a).toBe(b);
    expect(a).toMatch(/-lp3-[0-9a-f]{8}/);
  });

  test('a non-lawn service line never queries lawn_assessments or lawn_assessment_photos', async () => {
    const pestRecord = { ...LAWN_SERVICE_RECORD, service_line: 'pest', service_type: 'Quarterly Pest Control' };
    // knexForLawn throws on any table besides the four it knows — a lawn
    // table reference here would surface as a thrown error, which
    // reportPhotoSetPdfSignature's own try/catch would swallow into a
    // '-phu-' token, so assert on the RETURNED value shape instead: a
    // pest record with no service_photos and nothing parked returns the
    // untouched '' this function has always returned for that case, never
    // a '-phu' failure token or an '-lp' part.
    const result = await reportPhotoSetPdfSignature('rec-pest-1', knexForLawn({ serviceRecord: pestRecord }));
    expect(result).toBe('');
  });

  test('a lawn visit with NO linked assessment still gets the versioned empty-set "-lp0" marker (pre-push P1, round 2: never collapse to the pre-this-change legacy bare key)', async () => {
    const result = await reportPhotoSetPdfSignature('rec-lawn-2', knexForLawn({ currentAssessment: null, historyAssessments: [] }));
    expect(result).toMatch(/-lp0-[0-9a-f]{8}/);
    // The legacy pre-this-change key for this same (zero service_photos, no
    // lawn signal) state was bare '' — a lawn record must never produce that
    // again, or a cached PDF stored under it would match forever.
    expect(result).not.toBe('');
  });

  test('the turf-photo query throwing → the unique failure token, never a valid empty-set signature (failClosed)', async () => {
    const a = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotosByAssessment: { [CURRENT_ASSESSMENT.id]: 'throw' } }));
    const b = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotosByAssessment: { [CURRENT_ASSESSMENT.id]: 'throw' } }));
    const emptySet = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotosByAssessment: {} }));
    expect(a).toMatch(/^-phu-/);
    // Two failures never collide (same guarantee as the existing
    // "a failed lookup is a UNIQUE token" test above) — a stale render from
    // one failed attempt can never be mistakenly served/stored against a
    // later one.
    expect(a).not.toBe(b);
    // The core regression this closes: previously an unreadable photo set
    // resolved to [] and produced the SAME signature as a genuinely empty
    // one, so a caller could match/store against it. Now it can't.
    expect(a).not.toBe(emptySet);
    expect(emptySet).not.toMatch(/^-phu-/);
  });

  test('the turf-photo query throwing for the BASELINE assessment alone → the unique failure token', async () => {
    const a = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      historyAssessments: [BASELINE_ASSESSMENT, CURRENT_ASSESSMENT],
      turfPhotosByAssessment: {
        [BASELINE_ASSESSMENT.id]: 'throw',
        [CURRENT_ASSESSMENT.id]: [{ id: 'tp-cur', assessment_id: CURRENT_ASSESSMENT.id, updated_at: '2026-08-01T00:00:00Z' }],
      },
    }));
    expect(a).toMatch(/^-phu-/);
  });

  test('the linked-assessment lookup throwing → the unique failure token, never a valid empty-set signature', async () => {
    const a = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ currentAssessment: 'throw' }));
    const b = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ currentAssessment: 'throw' }));
    const noAssessment = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ currentAssessment: null, historyAssessments: [] }));
    expect(a).toMatch(/^-phu-/);
    expect(a).not.toBe(b);
    // "couldn't tell if there's a linked assessment" must never look like
    // "confirmed there is none" — the latter is a legitimate, stable key.
    expect(a).not.toBe(noAssessment);
    expect(noAssessment).not.toMatch(/^-phu-/);
  });

  test('the baseline-history lookup throwing → the unique failure token, never a valid empty-set signature', async () => {
    const a = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ historyAssessments: 'throw' }));
    const b = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ historyAssessments: 'throw' }));
    expect(a).toMatch(/^-phu-/);
    expect(a).not.toBe(b);
  });
});

describe('report-data.js render path keeps the fail-SOFT [] behavior (pre-push P1 follow-up: only the SIGNATURE path fails closed)', () => {
  const { buildReportV1Data } = require('../services/service-report/report-data');

  // Minimal known-good lawn fixture set, matching
  // report-lawn-next-visit.test.js's makeKnex — trimmed to exactly what
  // buildReportV1Data needs for a lawn render to complete.
  function makeKnex(fixtures) {
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const sortKeys = [];
      const q = {};
      const applySort = () => {
        rows = [...rows].sort((a, b) => {
          for (const { col, dir } of sortKeys) {
            const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
            if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
      };
      Object.assign(q, {
        select: () => q,
        leftJoin: () => q,
        modify(fn) { fn(q); return q; },
        limit(n) { rows = rows.slice(0, n); return q; },
        where(a, b) {
          if (typeof a === 'function') return q;
          if (a && typeof a === 'object') {
            rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
          } else if (arguments.length === 2) {
            rows = rows.filter((r) => r[a] === b);
          }
          return q;
        },
        whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
        whereNot(a, b) {
          if (a && typeof a === 'object') rows = rows.filter((r) => !Object.entries(a).every(([k, v]) => r[k] === v));
          else rows = rows.filter((r) => r[a] !== b);
          return q;
        },
        whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
        whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
        orderBy(col, dir = 'asc') { sortKeys.push({ col, dir }); applySort(); return q; },
        first() { return Promise.resolve(rows[0] || null); },
        columnInfo: () => Promise.resolve({}),
        catch: () => Promise.resolve(rows),
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      });
      return q;
    };
    knex.raw = (sql) => sql;
    return knex;
  }

  const LAWN_SERVICE = {
    id: 'svc-lawn-1',
    scheduled_service_id: 'ss-current',
    customer_id: 'cust-lawn',
    service_line: 'lawn',
    service_type: 'Lawn Care Treatment Program',
    service_date: '2026-05-16',
    first_name: 'Test',
    last_name: 'Customer',
    areas_serviced: JSON.stringify(['Front Lawn']),
    structured_notes: '{}',
    service_data: '{}',
  };

  const FIXTURES = {
    service_products: [],
    property_geometries: [],
    property_zones: [],
    service_findings: [],
    service_photos: [],
    lawn_water_intake_snapshots: [],
    lawn_assessments: [{
      id: 'la-1',
      customer_id: 'cust-lawn',
      service_record_id: 'svc-lawn-1',
      confirmed_by_tech: true,
      service_date: '2026-05-16',
      created_at: '2026-05-16T14:00:00Z',
      turf_density: 78,
      weed_suppression: 82,
      color_health: 75,
      stress_damage: 30,
    }],
    // Deliberately NOT provided: lawn_assessment_photos — the render's own
    // query for it (via resolveLawnReportPhotos, no failClosed) must reject.
  };

  test('a throwing lawn_assessment_photos query still renders the report, with no turf photos in the gallery', async () => {
    const baseKnex = makeKnex(FIXTURES);
    const throwingLawnPhotosChain = () => {
      const chain = {
        where() { return chain; },
        whereIn() { return chain; },
        orderBy() { return chain; },
        // buildLawnAssessmentReportData's OWN separate lawn_assessment_photos
        // queries (the scorecard's "photos" field and before/after
        // candidates — different call sites, untouched by this fix's
        // shared-resolver extraction) also chain .limit() before their own
        // .catch(() => []); keep that pre-existing fail-soft behavior
        // working here too.
        limit() { return chain; },
        then(resolve, reject) { return Promise.reject(new Error('lawn_assessment_photos query failed')).then(resolve, reject); },
        catch(fn) { return Promise.reject(new Error('lawn_assessment_photos query failed')).catch(fn); },
      };
      return chain;
    };
    const knex = (table) => (table === 'lawn_assessment_photos' ? throwingLawnPhotosChain() : baseKnex(table));

    const data = await buildReportV1Data(LAWN_SERVICE, 'token-lawn-render', knex);

    expect(data.serviceLine).toBe('lawn');
    expect((data.photos || []).some((p) => String(p.id).startsWith('lawn-'))).toBe(false);
  });
});

describe('shared resolver import wiring (so report-data.js and the preview-image cache-signature path cannot drift again)', () => {
  const fs = require('fs');
  const path = require('path');

  test('report-data.js resolves lawn turf photos through report-photo-set.js\'s resolveLawnReportPhotos, not a duplicated inline query', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/report-photo-set['"]\)\.resolveLawnReportPhotos/);
  });

  test('report-data.js exports the ONE assessment+history resolver the render and the signature both build on', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(src).toMatch(/resolveLawnAssessmentAndHistory,/);
    expect(src).toMatch(/resolveLawnPhotoAssessmentIds,/);
  });

  test('photo-set-signature.js resolves the SAME lawn turf photos and assessment identity through report-photo-set.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/photo-set-signature.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/report-photo-set['"]\)/);
    expect(src).toMatch(/resolveLawnReportPhotos/);
    expect(src).toMatch(/resolveLawnPhotoAssessmentIds/);
  });

  test('report-photo-set.js resolves assessment identity through report-data.js\'s resolver, not a re-implementation', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-photo-set.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/report-data['"]\)/);
    expect(src).toMatch(/resolveLawnPhotoAssessmentIds/);
  });

});

describe('reportPhotoSetPdfSignature threads propertyHistoryEnabled/lawnHistory through, rather than re-deriving its own default (Sonnet fallback-audit P1, 2026-09-28)', () => {
  // The gate-ON resolution itself (GATE_LAWN_PROPERTY_HISTORY, which is ON
  // in prod) is covered end to end by the next describe block. This one
  // isolates report-photo-set.js, to prove the exact plumbing bug
  // class the finding named: that reportPhotoSetPdfSignature forwards the
  // CALLER's propertyHistoryEnabled/lawnHistory into resolveLawnPhotoAssessmentIds
  // instead of letting the resolver re-derive its own default independently.
  afterEach(() => {
    jest.dontMock('../services/service-report/report-photo-set');
    jest.resetModules();
  });

  test('propertyHistoryEnabled: true and a supplied lawnHistory both reach resolveLawnPhotoAssessmentIds unchanged', async () => {
    let capturedOptions = null;
    jest.resetModules();
    jest.doMock('../services/service-report/report-photo-set', () => ({
      resolveLawnReportPhotos: async () => [],
      resolveLawnPhotoAssessmentIds: async (service, knex, options) => { capturedOptions = options; return []; },
    }));
    const { reportPhotoSetPdfSignature: freshSignature } = require('../services/service-report/photo-set-signature');

    const record = {
      service_data: null, customer_id: 'cust-1', service_line: 'lawn', service_type: 'Lawn Care',
      scheduled_service_id: 'sched-1', service_id: null,
    };
    const knex = (table) => {
      if (table === 'service_photos') return { where() { return this; }, orderBy() { return this; }, async select() { return []; } };
      if (table === 'service_records') return { where() { return this; }, async first() { return record; } };
      throw new Error(`unexpected table in this isolated test's knex fake: ${table}`);
    };
    const sentinelHistory = { current: { id: 'assess-x' }, rows: [{ id: 'assess-x' }], identity: 'sentinel' };

    await freshSignature('rec-lawn-thread', knex, {
      serviceData: null, propertyHistoryEnabled: true, lawnHistory: sentinelHistory,
    });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.failClosed).toBe(true);
    expect(capturedOptions.propertyHistoryEnabled).toBe(true);
    expect(capturedOptions.lawnHistory).toBe(sentinelHistory);
  });

  test('omitting propertyHistoryEnabled/lawnHistory forwards undefined (the resolver applies its own gate-read default, same as before this fix)', async () => {
    let capturedOptions = null;
    jest.resetModules();
    jest.doMock('../services/service-report/report-photo-set', () => ({
      resolveLawnReportPhotos: async () => [],
      resolveLawnPhotoAssessmentIds: async (service, knex, options) => { capturedOptions = options; return []; },
    }));
    const { reportPhotoSetPdfSignature: freshSignature } = require('../services/service-report/photo-set-signature');

    const record = {
      service_data: null, customer_id: 'cust-1', service_line: 'lawn', service_type: 'Lawn Care',
      scheduled_service_id: 'sched-1', service_id: null,
    };
    const knex = (table) => {
      if (table === 'service_photos') return { where() { return this; }, orderBy() { return this; }, async select() { return []; } };
      if (table === 'service_records') return { where() { return this; }, async first() { return record; } };
      throw new Error(`unexpected table in this isolated test's knex fake: ${table}`);
    };

    await freshSignature('rec-lawn-thread', knex, { serviceData: null });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.propertyHistoryEnabled).toBeUndefined();
    expect(capturedOptions.lawnHistory).toBeUndefined();
  });
});

describe('reportPhotoSetPdfSignature with GATE_LAWN_PROPERTY_HISTORY on (the live prod path)', () => {
  const CURRENT = { id: 'assess-current', customer_id: 'cust-1' };
  const BASELINE = { id: 'assess-baseline', customer_id: 'cust-1' };
  const record = {
    service_data: null, customer_id: 'cust-1', service_line: 'lawn', service_type: 'Lawn Care',
    scheduled_service_id: 'sched-1', service_id: null,
  };
  const knexFor = (photosByAssessment) => (table) => {
    if (table === 'service_photos') return { where() { return this; }, orderBy() { return this; }, async select() { return []; } };
    if (table === 'service_records') return { where() { return this; }, async first() { return record; } };
    if (table === 'lawn_assessment_photos') {
      let ids = [];
      const run = async () => {
        if (ids.some((id) => photosByAssessment[id] === 'throw')) throw new Error('down');
        return ids.flatMap((id) => photosByAssessment[id] || []);
      };
      const chain = {
        whereIn(_col, value) { ids = value; return chain; },
        where() { return chain; },
        orderBy() { return chain; },
        catch(fn) { return run().catch(fn); },
        then(ok, fail) { return run().then(ok, fail); },
      };
      return chain;
    }
    throw new Error(`unexpected table: ${table}`);
  };
  const load = ({ installed = async () => CURRENT, history = async () => ({ current: CURRENT, isBaseline: false, rows: [BASELINE, CURRENT] }) } = {}) => {
    jest.resetModules();
    jest.doMock('../services/lawn-assessment-history', () => ({ installedForVisit: installed, historyForAssessment: history }));
    return require('../services/service-report/photo-set-signature').reportPhotoSetPdfSignature;
  };
  const photo = (id, assessmentId) => ({ id, assessment_id: assessmentId, updated_at: '2026-09-01T00:00:00Z' });

  afterEach(() => {
    jest.dontMock('../services/lawn-assessment-history');
    jest.resetModules();
  });

  test('hiding the BASELINE assessment\'s turf photo changes the signature', async () => {
    const sign = load();
    const both = await sign('rec-lawn', knexFor({ 'assess-current': [photo('c1', 'assess-current')], 'assess-baseline': [photo('b1', 'assess-baseline')] }), { serviceData: null, propertyHistoryEnabled: true });
    const baselineHidden = await sign('rec-lawn', knexFor({ 'assess-current': [photo('c1', 'assess-current')] }), { serviceData: null, propertyHistoryEnabled: true });
    expect(both).toMatch(/-lp2-[0-9a-f]{8}$/);
    expect(baselineHidden).toMatch(/-lp1-[0-9a-f]{8}$/);
    expect(both).not.toBe(baselineHidden);
  });

  test('the property-history lookup throwing → the unique failure token', async () => {
    const sign = load({ history: async () => { throw new Error('down'); } });
    const a = await sign('rec-lawn', knexFor({}), { serviceData: null, propertyHistoryEnabled: true });
    expect(a).toMatch(/^-phu-/);
  });

  test('the installed-assessment lookup throwing → the unique failure token', async () => {
    const sign = load({ installed: async () => { throw new Error('down'); } });
    const a = await sign('rec-lawn', knexFor({}), { serviceData: null, propertyHistoryEnabled: true });
    expect(a).toMatch(/^-phu-/);
  });
});
