/**
 * Admin Messenger inbox (GATE_MESSENGER_INBOX, owner 2026-10-31).
 *
 * Communications -> Messenger tab: the Facebook page's Messenger threads, read
 * into the unified messages store by the 3-minute poll (services/messenger-inbox.js).
 * Staff roles, like the SMS tab; a technician sees only threads linked to a
 * customer on their route. Dark gate: the summary answers `{ enabled: false }`,
 * every other endpoint 404 `{ enabled: false }`.
 *
 * A reply goes out through Facebook's Send API inside Meta's 24-hour window
 * (409 outside_window after it). A refused send answers 502 and writes nothing.
 */

const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { messengerInboxLive } = require('../config/feature-gates');
const messenger = require('../services/messenger-inbox');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(adminAuthenticate, requireTechOrAdmin);

function requireLive(req, res, next) {
  if (!messengerInboxLive()) return res.status(404).json({ enabled: false });
  res.set('Cache-Control', 'private, no-store');
  return next();
}

// GET /api/admin/messenger/summary -> { enabled: false } | { enabled: true, unanswered }
router.get('/summary', async (req, res, next) => {
  try {
    if (!messengerInboxLive()) return res.json({ enabled: false });
    res.set('Cache-Control', 'private, no-store');
    res.json({ enabled: true, ...(await messenger.summary(req)) });
  } catch (err) { next(err); }
});

// GET /api/admin/messenger/threads[?before=<lastMessageAt ISO>&beforeId=<thread id>]
//   -> { enabled, threads: [{ id, name, lastMessageAt, lastInboundAt, snippet, unread, answered, canReply }], hasMore, unanswered }
// `unanswered` is the total across every thread (the same count as /summary), not the page.
router.get('/threads', requireLive, async (req, res, next) => {
  try {
    const { before, beforeId } = req.query;
    if (before !== undefined && (typeof before !== 'string' || Number.isNaN(new Date(before).getTime()))) {
      return res.status(400).json({ error: 'before must be a timestamp' });
    }
    if (beforeId !== undefined && !(typeof beforeId === 'string' && UUID_RE.test(beforeId))) {
      return res.status(400).json({ error: 'beforeId must be a thread id' });
    }
    const page = await messenger.listThreads(req, new Date(), {
      ...(before ? { before: new Date(before).toISOString() } : {}),
      ...(before && beforeId ? { beforeId } : {}),
    });
    res.json({ enabled: true, ...page });
  } catch (err) { next(err); }
});

// GET /api/admin/messenger/threads/:id -> { enabled, thread, messages: [{ id, direction, body, createdAt, author }] }
router.get('/threads/:id', requireLive, async (req, res, next) => {
  try {
    const found = await messenger.getThread(req, req.params.id);
    if (!found) return res.status(404).json({ error: 'not_found' });
    res.json({ enabled: true, ...found });
  } catch (err) { next(err); }
});

// POST /api/admin/messenger/threads/:id/read -> { updated }
router.post('/threads/:id/read', requireLive, async (req, res, next) => {
  try {
    const result = await messenger.markThreadRead(req, req.params.id, req.technicianId);
    if (!result) return res.status(404).json({ error: 'not_found' });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/messenger/threads/:id/reply { text } -> { sent: true } | 409 outside_window | 502 send_failed
// (Facebook refused: nothing went out) | 504 send_uncertain (no confirmation: check Facebook before resending)
router.post('/threads/:id/reply', requireLive, async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > messenger.REPLY_MAX_CHARS) {
      return res.status(400).json({ error: `Reply must be 1 to ${messenger.REPLY_MAX_CHARS} characters` });
    }
    const result = await messenger.sendReply(req, req.params.id, text);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ sent: true, message: result.message });
  } catch (err) { next(err); }
});

module.exports = router;
