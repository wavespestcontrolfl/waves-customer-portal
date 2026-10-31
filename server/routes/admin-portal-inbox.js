/**
 * Admin portal inbox (GATE_PORTAL_INBOX, owner 2026-10-31, option A).
 *
 * Communications -> Portal tab: what customers asked for inside the customer
 * portal (chat hand-offs, service requests) and nobody answered. Owner-only,
 * like the Email / Calls / Triage tabs. Dark gate: every endpoint answers
 * `{ enabled: false }` (summary) or 404 `{ enabled: false }` (the rest).
 *
 * Marking one item handled uses the existing routes
 * (PUT /api/ai/admin/escalations/:id, PATCH /api/admin/requests/:id).
 * "Close all older" closes the items older than 14 days and sends NOTHING to
 * a customer.
 */

const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { portalInboxLive } = require('../config/feature-gates');
const portalInbox = require('../services/portal-inbox');

router.use(adminAuthenticate, requireAdmin);

function requireLive(req, res, next) {
  if (!portalInboxLive()) {
    return res.status(404).json({ enabled: false });
  }
  return next();
}

// GET /api/admin/portal-inbox/summary -> { enabled, count } (open items, last 14 days)
router.get('/summary', async (req, res, next) => {
  try {
    if (!portalInboxLive()) return res.json({ enabled: false });
    res.set('Cache-Control', 'private, no-store');
    res.json({ enabled: true, ...(await portalInbox.summary()) });
  } catch (err) { next(err); }
});

// GET /api/admin/portal-inbox -> { enabled, cutoff, items, older: { chats, requests } }
router.get('/', requireLive, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json({ enabled: true, ...(await portalInbox.list()) });
  } catch (err) { next(err); }
});

// POST /api/admin/portal-inbox/close-older  { cutoff } -> { closed: { chats, requests } }
// One transaction. No email, no text. Alerts for the closed items are marked Done.
router.post('/close-older', requireLive, async (req, res, next) => {
  try {
    const parsed = portalInbox.parseCloseCutoff((req.body || {}).cutoff);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const closed = await portalInbox.closeOlder(parsed.cutoff, {
      technicianId: req.technicianId,
      role: req.techRole,
    });
    res.json({ closed });
  } catch (err) { next(err); }
});

module.exports = router;
