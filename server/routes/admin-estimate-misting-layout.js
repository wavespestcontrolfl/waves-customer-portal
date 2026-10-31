/**
 * Saved misting layouts for an estimate (GATE_MISTING_LAYOUT_DESIGNER, step 3).
 *
 *   GET /api/admin/estimates/:id/misting-layout   the saved layout + a signed picture link, or { layout: null }
 *   PUT /api/admin/estimates/:id/misting-layout   multipart: snapshot (PNG) + payload (JSON) -> upsert, returns { layout }
 *
 * Admin only (estimates are a sales surface, like the rest of admin-estimates.js). Both gates are
 * read per request; with either off every route answers 404, before the upload is buffered.
 * Lives beside admin-estimates.js because that file is already crowded (same call as admin-estimate-slots.js).
 */
const express = require('express');
const multer = require('multer');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const {
  MAX_SNAPSHOT_BYTES,
  layoutEnabled,
  isEstimateId,
  getLayoutForEstimate,
  saveLayout,
  estimateExists,
} = require('../services/misting-layouts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SNAPSHOT_BYTES, files: 1 } });

const notEnabled = (req, res, next) => (layoutEnabled() ? next() : res.status(404).json({ error: 'Not enabled' }));
const adminOnly = [adminAuthenticate, requireAdmin, notEnabled];

function readSnapshot(req, res, next) {
  upload.single('snapshot')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Snapshot exceeds the 8MB limit' });
    return res.status(400).json({ error: 'The upload could not be read' });
  });
}

router.get('/:id/misting-layout', ...adminOnly, async (req, res, next) => {
  try {
    if (!isEstimateId(req.params.id) || !(await estimateExists(req.params.id))) {
      return res.status(404).json({ error: 'Estimate not found' });
    }
    return res.json({ layout: await getLayoutForEstimate(req.params.id) });
  } catch (err) {
    logger.error(`[admin-estimate-misting-layout] read failed: ${err.message}`);
    return next(err);
  }
});

router.put('/:id/misting-layout', ...adminOnly, readSnapshot, async (req, res, next) => {
  try {
    if (!isEstimateId(req.params.id)) return res.status(404).json({ error: 'Estimate not found' });
    let payload;
    try {
      payload = JSON.parse(req.body?.payload || '');
    } catch {
      return res.status(400).json({ error: 'payload must be valid JSON' });
    }
    // The type is the caller's claim; saveLayout also checks the PNG signature in the bytes.
    if (req.file && req.file.mimetype !== 'image/png') return res.status(400).json({ error: 'snapshot must be a PNG' });
    const layout = await saveLayout({
      estimateId: req.params.id,
      payload,
      pngBuffer: req.file?.buffer || null,
      actorId: req.technicianId || null,
    });
    logger.info(
      `[admin-estimate-misting-layout] saved estimate=${req.params.id} by=${req.technicianId || 'n/a'} `
      + `nozzles=${layout.counts.nozzles} risers=${layout.counts.risers}`,
    );
    return res.json({ layout });
  } catch (err) {
    if (err?.isOperational) return res.status(err.statusCode || 400).json({ error: err.message });
    logger.error(`[admin-estimate-misting-layout] save failed: ${err.message}`);
    return next(err);
  }
});

module.exports = router;
