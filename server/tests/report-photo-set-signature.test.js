/**
 * reportPhotoSetPdfSignature — photo-set key component + render fence input
 * (Codex #4091 P1: a public /pdf render started before recovered closeout
 * photos land is untracked by service_report_pdf_jobs and would otherwise
 * store its photo-less output under the deterministic key).
 *
 * Also covers the third-round pre-push P1 (2026-09-28): a lawn visit's
 * report/preview can show a customer-visible lawn_assessment_photos row
 * (report-data.js appends these to the gallery/previewPhoto candidate for
 * serviceLine === 'lawn') even with ZERO service_photos rows, so the old
 * service_photos-only signature stayed unmoved while the shown photo
 * changed. Both report-data.js and this signature now resolve that set
 * through the SAME function, resolveLawnReportPhotos (report-photo-set.js)
 * — see the "shared resolver import wiring" describe block below.
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
    // photo identity check, added by the third-round pre-push P1, always
    // reads service_records once for customer_id/service_line — this mock's
    // service line never resolves to 'lawn', so it contributes no signature
    // part, but the read itself still happens) — the invariant this test
    // protects is that the MARKER never comes from that read, only from
    // options.serviceData when given; that's what the marker assertions below
    // still check.
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
});

describe('reportPhotoSetPdfSignature — lawn turf photo identity (pre-push P1, third round, 2026-09-28)', () => {
  const LAWN_SERVICE_RECORD = {
    service_data: null,
    customer_id: 'cust-1',
    service_line: 'lawn',
    service_type: 'Lawn Care',
    scheduled_service_id: 'sched-1',
    service_id: null,
  };
  const ASSESSMENT = { id: 'assess-1', confirmed_by_tech: true };

  // A minimal knex fake covering exactly the tables reportPhotoSetPdfSignature
  // touches for a lawn record: service_photos (existing), service_records
  // (existing, extended with the lawn-detection columns), lawn_assessments
  // (loadLinkedLawnAssessment, reused from report-data.js rather than
  // reimplemented here), and lawn_assessment_photos (resolveLawnReportPhotos).
  function knexForLawn({
    turfPhotos = [], assessment = ASSESSMENT, serviceRecord = LAWN_SERVICE_RECORD, servicePhotoRows = [],
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
        const chain = { where() { return chain; }, orderBy() { return chain; }, async first() { return assessment; } };
        return chain;
      }
      if (table === 'lawn_assessment_photos') {
        const chain = {
          where() { return chain; },
          orderBy() { return chain; },
          catch(fn) { return Promise.resolve(turfPhotos).catch(fn); },
        };
        return chain;
      }
      throw new Error(`unexpected table in this test's knex fake: ${table}`);
    };
  }

  test('a lawn visit with zero service_photos and one linked customer-visible turf photo → signature differs from the empty set', async () => {
    const withPhoto = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      turfPhotos: [{ id: 'tp-1', updated_at: '2026-09-01T00:00:00Z' }],
    }));
    const withoutPhoto = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotos: [] }));
    expect(withPhoto).toMatch(/-lp1-[0-9a-f]{8}/);
    expect(withoutPhoto).not.toMatch(/-lp/);
    expect(withPhoto).not.toBe(withoutPhoto);
    // This is exactly the finding this closes: previously a gate-on preview
    // built from zero service_photos stayed bare '-pgon' either way; now the
    // signature the writer/reader compare actually moves.
    expect(`-pgon${withPhoto}`).not.toBe(`-pgon${withoutPhoto}`);
  });

  test('hiding or removing the linked turf photo changes the signature', async () => {
    // resolveLawnReportPhotos only ever sees customer_visible: true rows, so
    // "hidden" and "removed" are the same thing from here: the row simply
    // isn't in the result set any more — exactly what the mock simulates.
    const visible = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({
      turfPhotos: [{ id: 'tp-1', updated_at: '2026-09-01T00:00:00Z' }],
    }));
    const hidden = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotos: [] }));
    expect(visible).not.toBe(hidden);
  });

  test('turf-photo signature ordering is deterministic for the same row set', async () => {
    const rows = [
      { id: 'tp-1', updated_at: '2026-09-01T00:00:00Z' },
      { id: 'tp-2', updated_at: '2026-09-02T00:00:00Z' },
    ];
    const a = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotos: rows }));
    const b = await reportPhotoSetPdfSignature('rec-lawn-1', knexForLawn({ turfPhotos: [...rows] }));
    expect(a).toBe(b);
    expect(a).toMatch(/-lp2-[0-9a-f]{8}/);
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

  test('a lawn visit with no linked assessment → no lawn signature part', async () => {
    const result = await reportPhotoSetPdfSignature('rec-lawn-2', knexForLawn({ assessment: null }));
    expect(result).not.toMatch(/-lp/);
  });
});

describe('shared resolver import wiring (so report-data.js and the preview-image cache-signature path cannot drift again)', () => {
  const fs = require('fs');
  const path = require('path');

  test('report-data.js resolves lawn turf photos through report-photo-set.js\'s resolveLawnReportPhotos, not a duplicated inline query', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/report-photo-set['"]\)\.resolveLawnReportPhotos/);
  });

  test('photo-set-signature.js resolves the SAME lawn turf photos through resolveLawnReportPhotos', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/photo-set-signature.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/report-photo-set['"]\)/);
    expect(src).toMatch(/resolveLawnReportPhotos/);
  });

  test('preview-image.js (the SMS-preview writer) imports the shared resolver transitively, through reportPhotoSetPdfSignature', () => {
    // preview-image.js never queries lawn_assessment_photos itself — it
    // keys its cache off reportPhotoSetPdfSignature, which is what now
    // carries the lawn-photo identity. Asserting the require wiring here
    // (rather than duplicating a lawn-photo scenario against the writer)
    // is what keeps this path from drifting back to a service_photos-only
    // signature without also updating report-data.js's own resolver.
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/preview-image.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/photo-set-signature['"]\)/);
    expect(src).toMatch(/reportPhotoSetPdfSignature/);
  });
});
