/**
 * Admin API for the company facts bank (owner 2026-11-25; services/company-facts-bank.js holds every rule).
 *
 *   GET    /                list, ?status=draft|approved|retired|all, ?limit=1..500 (default 500), ?cursor=<nextCursor>; newest first,
 *                           answers { facts, nextCursor, viewer: { ownerActions } } (nextCursor null on the last page; ownerActions
 *                           is true for the owner account only, so the page can hide Approve)
 *   POST   /                add a draft { topic, factText, question?, ownerWords?, source?, sourceRef? }
 *   GET    /preview         the approved lines exactly as the agents' snapshot would load them, from a fresh read: { lines, count,
 *                           version, ids } (rows that fail the checks again are left out, so this can be shorter than the approved list);
 *                           503 PREVIEW_UNAVAILABLE when the read fails
 *   GET    /:id             one fact
 *   GET    /:id/history     its events, oldest first, each with actor_name (the staff member's name, null when gone)
 *   PATCH  /:id             edit a draft in place; an edit of an approved fact makes a NEW draft that supersedes it. Send only the
 *                           fields that changed; baseTextSha256 (the hash of the wording the editor opened) is refused 409 STALE_TEXT
 *                           when the wording changed since
 *   DELETE /:id             discard a draft
 *   POST   /:id/approve     OWNER ACCOUNT ONLY (requireFullAccess); { textSha256 (the hash the page showed; 409 STALE_TEXT
 *                           when the wording changed since), ownerWords?, acknowledgeWarnings (literal true), reviewedWarnings? (the codes
 *                           the owner ticked: a warning found now that is not among them is 409 WARNINGS_NOT_ACKNOWLEDGED) }
 *   POST   /:id/retire      any admin; { reason } is required
 *   POST   /:id/restore     a retired fact comes back as a NEW draft
 *
 * Admin only: a technician is refused by requireAdmin. Nothing here reaches a customer: no agent reads the bank
 * in this release. Errors log codes only, never fact text.
 */

const express = require('express');
const router = express.Router();

const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { ibFullAccess, requireFullAccess } = require('../services/intelligence-bar/ib-access');
const Bank = require('../services/company-facts-bank');

router.use(adminAuthenticate, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const actorOf = (req) => ({ id: req.technicianId, isOwner: ibFullAccess(req) });

function sendError(res, err, where) {
  if (err instanceof Bank.FactError) return res.status(err.status).json({ error: err.code, code: err.code, ...err.detail });
  logger.error(`[admin-company-facts] ${where} failed (code ${err?.code || 'unknown'})`);
  return res.status(500).json({ error: 'Company facts request failed' });
}

// Wraps a handler: id format gate first, then the service call, then the one error shape.
const handle = (where, { needsId = true, status = 200 } = {}, run) => async (req, res) => {
  if (needsId && !UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', code: 'INVALID_ID' });
  try {
    return res.status(status).json(await run(req, actorOf(req)));
  } catch (err) {
    return sendError(res, err, where);
  }
};

const withCheck = (fact) => ({ fact, check: fact.check_result || null });

// `viewer.ownerActions` tells the page whether to show Approve (the same shape admin-careers gives its offer panel); the server still refuses everyone else.
router.get('/', handle('list', { needsId: false }, async (req, actor) => ({
  ...(await Bank.listFacts({ status: req.query.status, limit: req.query.limit, cursor: req.query.cursor })),
  viewer: { ownerActions: actor.isOwner },
})));

router.post('/', handle('create', { needsId: false, status: 201 }, async (req, actor) => withCheck(await Bank.createDraft(req.body, actor))));

// Before /:id. A fresh verified read, so the owner sees what the agents can receive now. A failed read is a 503 PREVIEW_UNAVAILABLE,
// never an empty list: an empty answer would read as "every approved fact failed its checks".
router.get('/preview', handle('preview', { needsId: false }, async () => {
  let facts;
  try {
    facts = await Bank.readVerifiedFacts();
  } catch (err) {
    logger.error(`[admin-company-facts] preview read failed (code ${err?.code || 'unknown'})`);
    throw new Bank.FactError('PREVIEW_UNAVAILABLE', 503);
  }
  return { lines: Bank.renderBankFactsLines(facts), count: facts.length, version: Bank.bankVersionHash(facts), ids: facts.map((f) => f.id) };
}));

router.get('/:id/history', handle('history', {}, async (req) => ({ events: await Bank.factHistory(req.params.id) })));

router.get('/:id', handle('get', {}, async (req) => withCheck(await Bank.getFact(req.params.id))));

router.patch('/:id', handle('edit', {}, async (req, actor) => withCheck(await Bank.editFact(req.params.id, req.body, actor))));

router.delete('/:id', handle('discard', {}, (req, actor) => Bank.discardDraft(req.params.id, actor)));

// The server enforces the owner rule: requireFullAccess answers 403 for any other admin, and the service refuses again.
router.post('/:id/approve', requireFullAccess, handle('approve', {}, async (req, actor) => withCheck(await Bank.approveFact(req.params.id, req.body, actor))));

router.post('/:id/retire', handle('retire', {}, async (req, actor) => withCheck(await Bank.retireFact(req.params.id, req.body, actor))));

router.post('/:id/restore', handle('restore', { status: 201 }, async (req, actor) => withCheck(await Bank.restoreAsDraft(req.params.id, actor))));

module.exports = router;
