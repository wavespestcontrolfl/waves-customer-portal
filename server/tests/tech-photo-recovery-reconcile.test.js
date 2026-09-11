/**
 * POST /api/tech/services/:id/photos/reconcile — completion-aware
 * reconciliation after the completion panel recovers failed closeout photos
 * (Codex #4091 P1: the attachment route only inserts the row).
 *
 * Invariants: same ownership rule as the photo routes; 409 not_completed when
 * no service_record exists; the cached PDF key is cleared on every success;
 * a render is re-queued ONLY when one was queued before (never starts a
 * render for a report that never rendered); an in-flight render answers 409
 * so the panel keeps its marker; a Tree & Shrub visit raises a one-time
 * dispatch alert instead of silently keeping the partial scoring — with or
 * without an assessment row yet (the auto-scorer may still be running); a failed PDF-key write fails the request (fail-closed).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const tables = {};
const updates = [];
let updateError = null;

function mockChain(table) {
  const state = { table, where: null };
  const c = {
    where: jest.fn((w) => { state.where = w; return c; }),
    whereIn: jest.fn(() => c),
    orderBy: jest.fn(() => c),
    count: jest.fn(() => { state.count = true; return c; }),
    select: jest.fn(async () => (tables[table] || []).filter((r) => !state.where || Object.entries(state.where).every(([k, v]) => r[k] === v))),
    first: jest.fn(async () => {
      const rows = (tables[table] || []).filter((r) => !state.where || Object.entries(state.where).every(([k, v]) => r[k] === v));
      if (state.count) return { n: String(rows.length) };
      return rows[0] || null;
    }),
    update: jest.fn(async (patch) => {
      if (updateError) throw updateError;
      updates.push({ table, where: state.where, patch });
      return 1;
    }),
  };
  return c;
}

jest.mock('../models/db', () => jest.fn((table) => mockChain(table)));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockEnqueue = jest.fn();
jest.mock('../services/service-report/pdf-queue', () => ({ enqueuePdfRenderJob: (...a) => mockEnqueue(...a) }));
const mockAlert = jest.fn();
jest.mock('../services/dispatch-alerts', () => ({ createAlertOnce: (...a) => mockAlert(...a) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
      other: { id: 'tech-2', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const express = require('express');
const router = require('../routes/tech-track');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/services', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const reconcile = (baseUrl, token = 'tech') => fetch(`${baseUrl}/api/tech/services/svc-1/photos/reconcile`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}` },
});

describe('POST /:id/photos/reconcile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updates.length = 0;
    updateError = null;
    for (const k of Object.keys(tables)) delete tables[k];
    tables.scheduled_services = [{ id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: '2026-09-01' }];
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest' }];
    tables.service_report_pdf_jobs = [];
    tables.tree_shrub_assessments = [];
    tables.service_photos = [];
    tables.dispatch_alerts = [];
    mockEnqueue.mockResolvedValue({ ok: true, queued: true, job: { status: 'queued' } });
    mockAlert.mockResolvedValue({ created: true });
  });

  test('another tech is refused; admin is allowed', async () => {
    await withServer(async (baseUrl) => {
      expect((await reconcile(baseUrl, 'other')).status).toBe(403);
      expect((await reconcile(baseUrl, 'admin')).status).toBe(200);
    });
  });

  test('409 not_completed when the visit has no completion record', async () => {
    tables.service_records = [];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('not_completed');
      expect(updates).toHaveLength(0);
    });
  });

  test('clears the cached PDF key and does NOT start a render for a report that never rendered', async () => {
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, serviceRecordId: 'rec-1', photoSummary: { pending: false, restored: false }, pdf: { invalidated: true, requeued: false }, treeShrub: null });
      expect(updates).toEqual([{ table: 'service_records', where: { id: 'rec-1' }, patch: { pdf_storage_key: null } }]);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  test('re-queues the render with the prior token when a render was queued before', async () => {
    tables.service_report_pdf_jobs = [{ id: 'job-1', service_record_id: 'rec-1', status: 'succeeded', payload: { source: 'dispatch_complete', token: 'tok-1' } }];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).pdf).toEqual({ invalidated: true, requeued: true });
      expect(mockEnqueue).toHaveBeenCalledWith({ serviceRecordId: 'rec-1', payload: { source: 'photo_recovery', token: 'tok-1' } });
    });
  });

  test('an in-flight render answers 409 so the panel keeps its recovery marker', async () => {
    tables.service_report_pdf_jobs = [{ id: 'job-1', service_record_id: 'rec-1', status: 'rendering', payload: '{"token":"tok-1"}' }];
    mockEnqueue.mockResolvedValue({ ok: true, queued: false, job: { status: 'rendering' } });
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('report_render_in_flight');
    });
  });

  test('a Tree & Shrub visit with a closeout assessment raises a one-time review alert, never a re-score', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'tree_shrub' }];
    tables.tree_shrub_assessments = [{ id: 'ta-1', service_record_id: 'rec-1' }];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).treeShrub).toEqual({ assessmentId: 'ta-1', rescored: false, flaggedForReview: true, alertId: null, alertDeduped: false });
      expect(mockAlert).toHaveBeenCalledTimes(1);
      expect(mockAlert.mock.calls[0][0]).toMatchObject({
        type: 'tree_shrub_assessment_partial_photos', severity: 'warn', jobId: 'svc-1', techId: 'tech-1',
        payload: { source: 'photo_recovery', serviceRecordId: 'rec-1', assessmentId: 'ta-1' },
      });
    });
  });

  test('a Tree & Shrub visit whose auto-score has not landed yet is STILL flagged (scorer closes over the closeout subset)', async () => {
    // Completion waits at most 12 s for the scorer and schedules a 60 s
    // retry; a recovery in that window finds no row, but the row that lands
    // later covers only the closeout-time photos (Codex r-375c002 P1).
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'tree_shrub' }];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).treeShrub).toEqual({ assessmentId: null, rescored: false, flaggedForReview: true, alertId: null, alertDeduped: false });
      expect(mockAlert).toHaveBeenCalledTimes(1);
      expect(mockAlert.mock.calls[0][0]).toMatchObject({
        type: 'tree_shrub_assessment_partial_photos', severity: 'warn', jobId: 'svc-1', techId: 'tech-1',
        payload: { source: 'photo_recovery', serviceRecordId: 'rec-1', assessmentId: null, scoringPending: true },
      });
      expect(mockAlert.mock.calls[0][0].payload.message).toMatch(/once scoring lands/);
    });
  });

  test('a palm visit without an assessment is NOT flagged — palm has no closeout scorer, so nothing is pending', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'palm' }];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).treeShrub).toEqual({ assessmentId: null, rescored: false, flaggedForReview: false });
      expect(mockAlert).not.toHaveBeenCalled();
    });
  });

  test('a palm visit WITH an assessment row is still flagged (the row was scored on the partial set)', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'palm' }];
    tables.tree_shrub_assessments = [{ id: 'ta-9', service_record_id: 'rec-1' }];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect((await res.json()).treeShrub).toEqual({ assessmentId: 'ta-9', rescored: false, flaggedForReview: true, alertId: null, alertDeduped: false });
      expect(mockAlert.mock.calls[0][0].payload).toMatchObject({ assessmentId: 'ta-9', scoringPending: false });
    });
  });

  test('a retry after dispatch resolved the alert does not raise a second alert for the same photo set (Codex r-63b2098 P2)', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'tree_shrub' }];
    tables.tree_shrub_assessments = [{ id: 'ta-1', service_record_id: 'rec-1' }];
    tables.service_photos = [{ id: 'ph-2', service_record_id: 'rec-1' }, { id: 'ph-1', service_record_id: 'rec-1' }];
    mockAlert.mockResolvedValue({ created: true, row: { id: 'alert-1' } });
    await withServer(async (baseUrl) => {
      const first = await (await reconcile(baseUrl)).json();
      expect(first.treeShrub).toEqual({ assessmentId: 'ta-1', rescored: false, flaggedForReview: true, alertId: 'alert-1', alertDeduped: false });
      const { photoSetKey } = mockAlert.mock.calls[0][0].payload;
      expect(photoSetKey).toMatch(/^2-[0-9a-f]{16}$/);
      // Dispatch reviewed and resolved it; the partial unique index no longer
      // covers the row. The panel's uncertain-response retry lands now.
      tables.dispatch_alerts = [{
        id: 'alert-1', type: 'tree_shrub_assessment_partial_photos', job_id: 'svc-1', resolved_at: '2026-09-10T00:00:00Z',
        payload: JSON.stringify({ source: 'photo_recovery', photoSetKey }),
      }];
      const retry = await (await reconcile(baseUrl)).json();
      expect(retry.treeShrub).toEqual({ assessmentId: 'ta-1', rescored: false, flaggedForReview: true, alertId: 'alert-1', alertDeduped: true });
      expect(mockAlert).toHaveBeenCalledTimes(1);
      // A later recovery that attached ANOTHER photo is a new set: fresh alert.
      tables.service_photos.push({ id: 'ph-3', service_record_id: 'rec-1' });
      const later = await (await reconcile(baseUrl)).json();
      expect(later.treeShrub.alertDeduped).toBe(false);
      expect(mockAlert).toHaveBeenCalledTimes(2);
      expect(mockAlert.mock.calls[1][0].payload.photoSetKey).not.toBe(photoSetKey);
      expect(mockAlert.mock.calls[1][0].payload.photoSetKey).toMatch(/^3-/);
    });
  });

  test('the photo-set key ignores row order (same set, different SELECT order)', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'tree_shrub' }];
    tables.tree_shrub_assessments = [{ id: 'ta-1', service_record_id: 'rec-1' }];
    tables.service_photos = [{ id: 'ph-1', service_record_id: 'rec-1' }, { id: 'ph-2', service_record_id: 'rec-1' }];
    await withServer(async (baseUrl) => {
      await reconcile(baseUrl);
      tables.service_photos.reverse();
      await reconcile(baseUrl);
      expect(mockAlert.mock.calls[0][0].payload.photoSetKey).toBe(mockAlert.mock.calls[1][0].payload.photoSetKey);
    });
  });

  test('a non-Tree & Shrub visit never raises the partial-photos alert', async () => {
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).treeShrub).toBeNull();
      expect(mockAlert).not.toHaveBeenCalled();
    });
  });

  test('a failed PDF-key write fails the request instead of reporting success', async () => {
    updateError = new Error('db down');
    await withServer(async (baseUrl) => {
      expect((await reconcile(baseUrl)).status).toBe(500);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });
});

describe('POST /:id/photos/reconcile — parked photo summary', () => {
  const SUMMARY = 'Two after photos show the treated bed line.';
  const parked = () => ({ typedReportSnapshot: { photoSummary: null, photoSummaryPendingRecovery: SUMMARY, serviceLabel: 'Pest' } });
  beforeEach(() => {
    jest.clearAllMocks();
    updates.length = 0;
    updateError = null;
    for (const k of Object.keys(tables)) delete tables[k];
    tables.scheduled_services = [{ id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1' }];
    tables.service_report_pdf_jobs = [];
    tables.tree_shrub_assessments = [];
    mockEnqueue.mockResolvedValue({ ok: true, queued: true, job: { status: 'queued' } });
  });

  test('restores the summary before clearing the PDF key once every closeout photo is attached', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest', service_data: parked(),
      structured_notes: { completionPhotos: { uploaded: 1, failed: 1 } } }];
    tables.service_photos = [
      { id: 'p1', service_record_id: 'rec-1', photo_type: 'after' },
      { id: 'p2', service_record_id: 'rec-1', photo_type: 'after' },
      { id: 'p3', service_record_id: 'rec-1', photo_type: 'progress' },
    ];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).photoSummary).toEqual({ pending: true, restored: true });
      expect(updates).toHaveLength(2);
      expect(updates[0].where).toEqual({ id: 'rec-1' });
      expect(JSON.parse(updates[0].patch.service_data).typedReportSnapshot).toEqual({ photoSummary: SUMMARY, serviceLabel: 'Pest' });
      expect(updates[1].patch).toEqual({ pdf_storage_key: null });
    });
  });

  test('jsonb columns delivered as strings are handled the same way', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest', service_data: JSON.stringify(parked()),
      structured_notes: JSON.stringify({ completionPhotos: { uploaded: 0, failed: 1 } }) }];
    tables.service_photos = [{ id: 'p1', service_record_id: 'rec-1', photo_type: 'after' }];
    await withServer(async (baseUrl) => {
      expect((await (await reconcile(baseUrl)).json()).photoSummary).toEqual({ pending: true, restored: true });
    });
  });

  test('409 photos_still_missing keeps the summary parked and touches nothing when photos are still short', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest', service_data: parked(),
      structured_notes: { completionPhotos: { uploaded: 1, failed: 2 } } }];
    tables.service_photos = [
      { id: 'p1', service_record_id: 'rec-1', photo_type: 'after' },
      { id: 'p2', service_record_id: 'rec-1', photo_type: 'after' },
    ];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('photos_still_missing');
      expect(updates).toHaveLength(0);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  test('a failed summary write fails the request before the PDF key is cleared or a render queued', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest', service_data: parked(),
      structured_notes: { completionPhotos: { uploaded: 0, failed: 1 } } }];
    tables.service_photos = [{ id: 'p1', service_record_id: 'rec-1', photo_type: 'after' }];
    tables.service_report_pdf_jobs = [{ id: 'job-1', service_record_id: 'rec-1', status: 'succeeded', payload: { token: 't' } }];
    updateError = new Error('db down');
    await withServer(async (baseUrl) => {
      expect((await reconcile(baseUrl)).status).toBe(500);
      expect(updates).toHaveLength(0);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  test('a record with no parked summary (no upload failed at closeout) skips the restore', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest',
      service_data: { typedReportSnapshot: { photoSummary: SUMMARY } }, structured_notes: {} }];
    await withServer(async (baseUrl) => {
      expect((await (await reconcile(baseUrl)).json()).photoSummary).toEqual({ pending: false, restored: false });
      expect(updates).toEqual([{ table: 'service_records', where: { id: 'rec-1' }, patch: { pdf_storage_key: null } }]);
    });
  });
});

describe('POST /:id/photos/reconcile — distinct expected image hashes', () => {
  const SUMMARY = 'Two after photos show the treated bed line.';
  const parked = () => ({ typedReportSnapshot: { photoSummary: null, photoSummaryPendingRecovery: SUMMARY } });
  beforeEach(() => {
    jest.clearAllMocks();
    updates.length = 0;
    updateError = null;
    for (const k of Object.keys(tables)) delete tables[k];
    tables.scheduled_services = [{ id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1' }];
    tables.service_report_pdf_jobs = [];
    tables.tree_shrub_assessments = [];
  });

  test('the same image submitted twice plus one failed image: recovery completes with two distinct rows', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest', service_data: parked(),
      structured_notes: { completionPhotos: { uploaded: 2, failed: 1, expectedImageHashes: ['aaa', 'bbb'] } } }];
    tables.service_photos = [
      { id: 'p1', service_record_id: 'rec-1', photo_type: 'after', image_sha256: 'aaa' },
      { id: 'p2', service_record_id: 'rec-1', photo_type: 'after', image_sha256: 'bbb' },
    ];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).photoSummary).toEqual({ pending: true, restored: true });
    });
  });

  test('an expected image already on the record under another photo_type counts (uploader dedupes per record, not per type)', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest', service_data: parked(),
      structured_notes: { completionPhotos: { uploaded: 1, failed: 1, expectedImageHashes: ['aaa', 'bbb'] } } }];
    tables.service_photos = [
      { id: 'p1', service_record_id: 'rec-1', photo_type: 'after', image_sha256: 'aaa' },
      { id: 'p2', service_record_id: 'rec-1', photo_type: 'progress', image_sha256: 'bbb' },
      { id: 'p3', service_record_id: 'rec-other', photo_type: 'after', image_sha256: 'ccc' },
    ];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).photoSummary).toEqual({ pending: true, restored: true });
    });
  });

  test('enough rows but the wrong image is still photos_still_missing', async () => {
    tables.service_records = [{ id: 'rec-1', scheduled_service_id: 'svc-1', service_line: 'pest', service_data: parked(),
      structured_notes: { completionPhotos: { uploaded: 1, failed: 1, expectedImageHashes: ['aaa', 'bbb'] } } }];
    tables.service_photos = [
      { id: 'p1', service_record_id: 'rec-1', photo_type: 'after', image_sha256: 'aaa' },
      { id: 'p2', service_record_id: 'rec-1', photo_type: 'after', image_sha256: 'ccc' },
    ];
    await withServer(async (baseUrl) => {
      const res = await reconcile(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('photos_still_missing');
      expect(updates).toHaveLength(0);
    });
  });
});
