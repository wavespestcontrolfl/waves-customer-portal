// Admin review queue for price-match email drafts (PR3 of the price-scan lane).
// Owner-only (requireAdmin): the send target is an external SiteOne rep, so only
// the owner reviews proof links + per-unit pricing and clicks send.
const express = require('express');

const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const draftSvc = require('../services/price-scan/price-match-draft');

router.use(adminAuthenticate, requireAdmin);

const actorOf = (req) => (req.technician && (req.technician.name || req.technician.email)) || null;

// GET /api/admin/price-match/drafts?status=active|pending|sent|... — review queue.
// Default 'active' = pending + sending, so a draft stuck mid-send is never hidden.
router.get('/drafts', async (req, res, next) => {
  try {
    const q = req.query.status || 'active';
    const status = q === 'all' ? null : (q === 'active' ? ['pending', 'sending'] : q);
    const drafts = await draftSvc.listDrafts(db, { status });
    res.json({ recipient: draftSvc.markEmail(), drafts });
  } catch (err) { next(err); }
});

// GET /api/admin/price-match/drafts/:id — full draft (subject/html/text + matches)
router.get('/drafts/:id', async (req, res, next) => {
  try {
    const draft = await draftSvc.getDraft(db, Number(req.params.id));
    if (!draft) return res.status(404).json({ error: 'not_found' });
    return res.json({ draft });
  } catch (err) { return next(err); }
});

// POST /api/admin/price-match/drafts/:id/send — owner approves; emails Mark
router.post('/drafts/:id/send', async (req, res, next) => {
  try {
    const result = await draftSvc.sendDraft(db, Number(req.params.id), { actor: actorOf(req) });
    if (!result.ok) return res.status(409).json(result);
    // IDs only — no recipient email / admin name in logs (PII).
    const logFields = { draftId: Number(req.params.id), technicianId: req.technicianId, messageId: result.messageId || null };
    if (result.reconcile) logger.error('price-match draft sent but not finalized — reconcile', logFields);
    else logger.info('price-match draft sent', logFields);
    return res.json(result);
  } catch (err) { return next(err); }
});

// POST /api/admin/price-match/drafts/:id/dismiss — drop without sending
router.post('/drafts/:id/dismiss', async (req, res, next) => {
  try {
    const row = await draftSvc.dismissDraft(db, Number(req.params.id), { actor: actorOf(req) });
    if (!row) return res.status(409).json({ error: 'not_pending' });
    return res.json({ draft: row });
  } catch (err) { return next(err); }
});

// POST /api/admin/price-match/drafts/:id/reset — recover a draft stuck in 'sending'
// (crash between claim and finalize) back to pending for re-review.
router.post('/drafts/:id/reset', async (req, res, next) => {
  try {
    const row = await draftSvc.resetStuckDraft(db, Number(req.params.id));
    if (!row) return res.status(409).json({ error: 'not_sending' });
    logger.info('price-match draft reset from sending', { draftId: Number(req.params.id), technicianId: req.technicianId });
    return res.json({ draft: row });
  } catch (err) { return next(err); }
});

module.exports = router;
