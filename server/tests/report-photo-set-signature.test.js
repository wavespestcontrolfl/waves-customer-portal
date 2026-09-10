/**
 * reportPhotoSetPdfSignature — photo-set key component + render fence input
 * (Codex #4091 P1: a public /pdf render started before recovered closeout
 * photos land is untracked by service_report_pdf_jobs and would otherwise
 * store its photo-less output under the deterministic key).
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

  test('a failed lookup is a UNIQUE token: never matches a stored key, trips the fence', async () => {
    const a = await reportPhotoSetPdfSignature('rec-1', knexWith('throw'));
    const b = await reportPhotoSetPdfSignature('rec-1', knexWith('throw'));
    expect(a).toMatch(/^-phu-/);
    expect(a).not.toBe(b);
  });
});
