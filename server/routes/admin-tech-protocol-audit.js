/**
 * Owner protocol audit (Tech Rewards Plan D5-3). Admin only; no gate: it sends nothing and moves no money.
 *
 * GET /?month=YYYY-MM          the month's board (default: this ET month): per technician with eligible visits,
 *                              five sampled completed lawn / tree & shrub visits with products, rates, targets,
 *                              counts, photos, the frozen lawn protocol version and window, an evidenceFingerprint and the current mark.
 * PUT /visits/:scheduledServiceId   { result: 'match' | 'mismatch', note?, technicianId, month, recordId,
 *                              evidenceFingerprint } mark one sampled visit (a mismatch needs a note; the last four = what the
 *                              board showed). One row per visit: marking again changes it. 404 not an eligible visit, 409
 *                              STALE_VISIT (record, technician or month changed), STALE_EVIDENCE (photos, products or
 *                              protocol changed) or NOT_IN_SAMPLE.
 * Writes only tech_protocol_audits (read by tech-rewards-scores.js readAudit). Never touches visits or records.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const audit = require('../services/tech-protocol-audit');

const router = express.Router();
router.use(adminAuthenticate);
router.use(requireAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function fail(res, err, what) {
  if (err instanceof audit.ProtocolAuditError) return res.status(err.status).json({ error: err.message, code: err.code });
  // the error text can carry SQL (with customer names): log the operation and a code only
  logger.error(`[admin-tech-protocol-audit] ${what} failed (${err.code || err.name || 'error'})`);
  return res.status(500).json({ error: `Could not ${what}.` });
}

router.get('/', async (req, res) => {
  try {
    res.json(await audit.getBoard(req.query.month));
  } catch (err) {
    fail(res, err, 'load the protocol audit');
  }
});

router.put('/visits/:scheduledServiceId', async (req, res) => {
  try {
    const mark = await audit.saveMark({
      scheduledServiceId: req.params.scheduledServiceId,
      technicianId: req.body?.technicianId,
      month: req.body?.month,
      recordId: req.body?.recordId,
      evidenceFingerprint: req.body?.evidenceFingerprint,
      result: req.body?.result,
      note: req.body?.note,
      auditedBy: req.technicianId,
    });
    res.json({ mark });
  } catch (err) {
    fail(res, err, 'save the protocol audit mark');
  }
});

module.exports = router;
