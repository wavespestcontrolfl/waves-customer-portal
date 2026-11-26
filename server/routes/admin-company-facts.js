/**
 * Admin API for the company facts bank (owner 2026-11-25; services/company-facts-bank.js holds every rule).
 *
 *   GET    /                list, ?status=draft|approved|retired|all, ?limit=1..500 (default 500), ?cursor=<nextCursor>; newest first,
 *                           answers { facts, nextCursor } (nextCursor null on the last page)
 *   POST   /                add a draft { topic, factText, question?, ownerWords?, source?, sourceRef? }
 *   GET    /:id             one fact
 *   GET    /:id/history     its events, oldest first
 *   PATCH  /:id             edit a draft in place; an edit of an approved fact makes a NEW draft that supersedes it
 *   DELETE /:id             discard a draft
 *   POST   /:id/approve     OWNER ACCOUNT ONLY (requireFullAccess); { textSha256 (the hash the page showed; 409 STALE_TEXT
 *                           when the wording changed since), ownerWords?, acknowledgeWarnings (literal true) }
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

router.get('/', handle('list', { needsId: false }, (req) => Bank.listFacts({ status: req.query.status, limit: req.query.limit, cursor: req.query.cursor })));

router.post('/', handle('create', { needsId: false, status: 201 }, async (req, actor) => withCheck(await Bank.createDraft(req.body, actor))));

router.get('/:id/history', handle('history', {}, async (req) => ({ events: await Bank.factHistory(req.params.id) })));

router.get('/:id', handle('get', {}, async (req) => withCheck(await Bank.getFact(req.params.id))));

router.patch('/:id', handle('edit', {}, async (req, actor) => withCheck(await Bank.editFact(req.params.id, req.body, actor))));

router.delete('/:id', handle('discard', {}, (req, actor) => Bank.discardDraft(req.params.id, actor)));

// The server enforces the owner rule: requireFullAccess answers 403 for any other admin, and the service refuses again.
router.post('/:id/approve', requireFullAccess, handle('approve', {}, async (req, actor) => withCheck(await Bank.approveFact(req.params.id, req.body, actor))));

router.post('/:id/retire', handle('retire', {}, async (req, actor) => withCheck(await Bank.retireFact(req.params.id, req.body, actor))));

router.post('/:id/restore', handle('restore', { status: 201 }, async (req, actor) => withCheck(await Bank.restoreAsDraft(req.params.id, actor))));

module.exports = router;
