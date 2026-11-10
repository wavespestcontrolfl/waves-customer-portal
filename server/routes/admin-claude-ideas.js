const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { sendIdeaToClaude, cancelClaudeIdea, ideaSendLive, answerSendLive } = require('../services/admin-claude-ideas');
const { UUID_RE } = require('../services/admin-alert-send-to-claude');
const { ibFullAccess } = require('../services/intelligence-bar/ib-access');

// Owner login only (Codex security review on #7548): requireAdmin accepts every admin account, and an idea's text goes
// into a Claude terminal tab. ibFullAccess keys off the login's own technicians-row email (IB_FULL_ACCESS_EMAILS).
const OWNER_ONLY = 'This action is limited to the owner account.';

router.use(adminAuthenticate, requireAdmin);

// GET /api/admin/claude-ideas/status — does the Intelligence Bar box show "Send to Claude"? enabled only for the owner
// login while GATE_IB_SEND_TO_CLAUDE is on; never 404, so the palette can ask. `answerButton: true` joins it while
// GATE_IB_ANSWER_SEND_TO_CLAUDE is on too (the button under a stuck answer); absent otherwise.
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const enabled = ideaSendLive() && ibFullAccess(req);
  res.json({ enabled, ...(enabled && answerSendLive() ? { answerButton: true } : {}) });
});

// POST /api/admin/claude-ideas — the box's free "Send to Claude" button (GATE_IB_SEND_TO_CLAUDE, owner 2026-11-03). Body:
// { text, page: { route }, ids: { customer_id, property_id, estimate_id, appointment_id, product_id, viewed_date }, pasted }.
// Makes NO model call: writes one admin notification row into Claude's queue, where the Mac launcher opens a Claude tab
// (services/admin-claude-ideas.js). 400 for a missing or over-long idea, 200 `duplicate` when the same idea is still open,
// 422 when the row is suppressed. Sends nothing to anyone. Gate off: 404, the same as an unknown route.
router.post('/', async (req, res, next) => {
  try {
    if (!ideaSendLive()) return res.status(404).json({ error: 'Not found' });
    if (!ibFullAccess(req)) return res.status(403).json({ error: OWNER_ONLY });
    const { status, body } = await sendIdeaToClaude({ ...req.body, by: req.technicianId });
    res.status(status).json(body);
  } catch (err) { next(err); }
});

// POST /api/admin/claude-ideas/:id/cancel — the 10-second Undo after a send. `at` (required): the time the send answered
// with. Closes the idea row while it is open, still that send and no Mac tab has started on it; 409 `started`, `changed`
// or `done` otherwise. Gate off: 404.
router.post('/:id/cancel', async (req, res, next) => {
  try {
    if (!ideaSendLive()) return res.status(404).json({ error: 'Not found' });
    if (!ibFullAccess(req)) return res.status(403).json({ error: OWNER_ONLY });
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid notification id' });
    const at = req.body?.at;
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return res.status(400).json({ error: 'at is required' });
    const { status, body } = await cancelClaudeIdea(id, { at, by: req.technicianId, role: req.techRole, technicianId: req.technicianId });
    res.status(status).json(body);
  } catch (err) { next(err); }
});

module.exports = router;
