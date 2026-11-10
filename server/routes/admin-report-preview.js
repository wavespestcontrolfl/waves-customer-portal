/**
 * Admin report preview — the customer service report for a visit that is NOT
 * completed yet, exactly as the customer would see it, before anything is sent.
 *
 *   GET /api/admin/report-preview/:scheduledServiceId/data
 *
 * READ-ONLY by construction: it sends nothing (no SMS/email), charges nothing
 * (no autopay) and writes nothing. The visit becomes an in-memory stand-in
 * record (services/service-report/report-preview.js) that goes through the same
 * builder as the customer route (buildServiceReportV1ResponseData) with
 * `preview: true`, which skips every durable write on the render path. No
 * view tracking, no report token, no service_records row.
 *
 * Admin only (not technicians): the preview shows what has not been reviewed.
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { loadPreviewService } = require('../services/service-report/report-preview');

router.use(adminAuthenticate);
router.use(requireAdmin);

const REFUSALS = {
  invalid_id: [404, 'Visit not found'],
  not_found: [404, 'Visit not found'],
  completed: [409, 'This visit is already completed. Open its real report instead.'],
  closed: [409, 'This visit is closed (cancelled, rescheduled, skipped or no-show). There is no report to preview.'],
  unsupported_line: [409, 'Preview works for lawn visits only. Other reports are built from what the technician enters at completion.'],
  has_report: [409, 'A report already exists for this visit. Open the real report instead.'],
};

// GET /:scheduledServiceId/data — the report payload ReportViewPage renders.
router.get('/:scheduledServiceId/data', async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const loaded = await loadPreviewService(req.params.scheduledServiceId);
    if (loaded.error) {
      const [status, error] = REFUSALS[loaded.error] || [404, 'Visit not found'];
      return res.status(status).json({ error });
    }

    // Required lazily: reports-public pulls in the whole report stack, which an
    // unrelated admin boot path should not pay for.
    const { buildServiceReportV1ResponseData } = require('./reports-public');
    const data = await buildServiceReportV1ResponseData(loaded.service, null, {
      mode: 'live',
      // A CUSTOMER view: staffViewer would add the internal_only companion
      // sections the customer never gets. The page suppresses its event posts
      // from the `preview` flag instead.
      staffViewer: false,
      composeOffers: true,
      // Off (Codex #6531 r1): plan totals count completed records, and this
      // visit has none yet, so the card would read one visit short.
      planSummary: false,
      upcomingVisitsCard: true,
      nearYou: true,
      lawnPhotoFindings: true,
      lawnLighting: true,
      lawnWateringCloseOut: true,
      lawnRainfastWatch: true,
      lawnWaterInRain: true,
      preview: true,
    });
    // The customer route's live-view glass default (no recap in a preview: a
    // recap video exists only after completion).
    data.glassDefault = true;
    // No token means no tokened URLs: the PDF download and the standalone map
    // endpoint do not exist for a visit with no record, so the page gets none
    // (a null pdfUrl disables the Download button).
    return res.json({ ...data, preview: true, pdfUrl: null, mapSvgUrl: null });
  } catch (err) {
    logger.warn(`[admin-report-preview] failed for visit ${req.params.scheduledServiceId}: ${err.message}`);
    return next(err);
  }
});

module.exports = router;
