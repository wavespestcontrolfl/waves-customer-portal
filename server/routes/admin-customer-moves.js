/**
 * Admin moving routes (owner 2026-11-02, dark behind GATE_MOVING_FLOW), mounted
 * under /api/admin/customers so Customer 360's Moving card can call them.
 *
 *   GET  /:id/moves         the customer's latest 5 moves and where "Text
 *                           moving link" opens ({ phone, hasTexts }). Gate
 *                           off: 200 { enabled: false, moves: [] } so the
 *                           card hides. With GATE_MOVING_ESTIMATE on, each
 *                           move carries new_home ({ action, estimateId,
 *                           reason }) for the "Estimate for new home" button;
 *                           with GATE_MOVING_APPLY on, apply ({ action,
 *                           reason }) for the "Apply move" button. A prepay
 *                           or monthly refusal adds steps (BILLING_STEPS).
 *   GET  /:id/moves/:moveId/estimate-source
 *                           what the estimator needs to start the new
 *                           house's estimate (moving PR B1). 404 when
 *                           GATE_MOVING_ESTIMATE is off; 409 { code, error }
 *                           when the move cannot get one.
 *   GET  /:id/moves/:moveId/apply-preview
 *                           what "Apply move" would do (moving PR B2): the
 *                           primary change, the old-house plans that stop
 *                           after move-out, the termite pickup task, and the
 *                           version the confirm must send. 404 when
 *                           GATE_MOVING_APPLY is off; 409 { code, error }
 *                           when the move cannot be applied.
 *   POST /:id/moves/:moveId/apply { version }
 *                           apply it. 409 apply_changed when the preview is
 *                           stale; a step that fails answers { code, error,
 *                           progress } and the next confirm resumes it.
 *   POST /:id/moving-link   open (or reuse) the customer's move and answer its
 *                           link { url, moveId, status }. Sends nothing.
 *   POST /:id/moving-email  email the link on this staff click { ok, sent, reason }.
 *
 * Every route is requireAdmin, per route: this router shares the
 * /api/admin/customers prefix with routers that admit technicians, so it must
 * not gate paths it does not own. Gate off, the two POST routes answer 404.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { movingFlowLive, movingEstimateLive, movingApplyLive } = require('../config/feature-gates');
const Moves = require('../services/customer-moves');
// A knex error message carries the query's bindings (typed addresses, link
// tokens): log the code only (AGENTS.md, no PII in logs).
const errCode = (err) => String(err?.code || err?.name || 'error');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const adminOnly = [adminAuthenticate, requireAdmin];

function gateOn(req, res, next) {
  if (!movingFlowLive()) return res.status(404).json({ error: 'Not found' });
  return next();
}

async function liveCustomer(req, res, next) {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Customer not found' });
  try {
    const customer = await db('customers').where({ id }).whereNull('deleted_at').first('id');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    return next();
  } catch (err) {
    logger.error(`[admin-customer-moves] customer lookup failed (${errCode(err)})`);
    return res.status(500).json({ error: 'Could not load the customer' });
  }
}

router.get('/:id/moves', ...adminOnly, async (req, res) => {
  if (!movingFlowLive()) return res.json({ enabled: false, moves: [] });
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Customer not found' });
  try {
    const [rows, text] = await Promise.all([Moves.recentMoves(id, 5), Moves.textTarget(id)]);
    const estimateEnabled = movingEstimateLive();
    const applyEnabled = movingApplyLive();
    const moves = await Promise.all(rows.map(async (move) => ({
      ...move,
      new_home: estimateEnabled ? await Moves.newHomeAction(move) : null,
      apply: applyEnabled ? await Moves.applyAction(move) : null,
    })));
    return res.json({ enabled: true, estimateEnabled, applyEnabled, moves, text });
  } catch (err) {
    logger.error(`[admin-customer-moves] list failed (${errCode(err)})`);
    return res.status(500).json({ error: 'Could not load moves' });
  }
});

router.post('/:id/moving-link', ...adminOnly, gateOn, liveCustomer, async (req, res) => {
  try {
    const move = await Moves.openMoveForCustomer(req.params.id, { actorId: req.technicianId || null });
    const url = await Moves.movingLinkFor(move);
    return res.json({ url, moveId: move.id, status: move.status });
  } catch (err) {
    logger.error(`[admin-customer-moves] link failed (${errCode(err)})`);
    return res.status(500).json({ error: 'Could not make the moving link' });
  }
});

router.post('/:id/moving-email', ...adminOnly, gateOn, liveCustomer, async (req, res) => {
  try {
    const result = await Moves.sendMovingEmail({ customerId: req.params.id, actorId: req.technicianId || null });
    return res.json({ ok: result.ok, sent: result.sent, reason: result.reason, moveId: result.moveId });
  } catch (err) {
    logger.error(`[admin-customer-moves] email failed (${errCode(err)})`);
    return res.status(500).json({ error: 'Could not send the moving email' });
  }
});

router.get('/:id/moves/:moveId/estimate-source', ...adminOnly, gateOn, liveCustomer, async (req, res) => {
  try {
    return res.json(await Moves.moveEstimateSource(req.params.id, String(req.params.moveId || '')));
  } catch (err) {
    if (err instanceof Moves.MoveError) return res.status(err.status).json(moveErrorBody(err));
    logger.error(`[admin-customer-moves] estimate source failed (${errCode(err)})`);
    return res.status(500).json({ error: 'Could not load the move for an estimate' });
  }
});

function moveErrorBody(err) {
  return {
    error: err.message,
    code: err.code,
    ...(err.estimateId ? { estimateId: err.estimateId } : {}),
    ...(err.progress ? { progress: err.progress } : {}),
  };
}

function applyGate(req, res, next) {
  if (!movingApplyLive()) return res.status(404).json({ error: 'Not found' });
  return next();
}

router.get('/:id/moves/:moveId/apply-preview', ...adminOnly, gateOn, applyGate, liveCustomer, async (req, res) => {
  try {
    return res.json(await Moves.applyMovePreview(req.params.id, String(req.params.moveId || '')));
  } catch (err) {
    if (err instanceof Moves.MoveError) return res.status(err.status).json(moveErrorBody(err));
    logger.error(`[admin-customer-moves] apply preview failed (${errCode(err)})`);
    return res.status(500).json({ error: 'Could not read what Apply move would do' });
  }
});

router.post('/:id/moves/:moveId/apply', ...adminOnly, gateOn, applyGate, liveCustomer, async (req, res) => {
  try {
    const version = typeof req.body?.version === 'string' ? req.body.version : '';
    const result = await Moves.applyMove(req.params.id, String(req.params.moveId || ''), {
      version, actorId: req.technicianId || null,
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof Moves.MoveError) return res.status(err.status).json(moveErrorBody(err));
    logger.error(`[admin-customer-moves] apply failed (${errCode(err)})`);
    return res.status(500).json({
      error: 'Apply move stopped. Refresh the card: it shows what is left, and Apply move resumes from there.',
      ...(err && err.progress ? { progress: err.progress } : {}),
    });
  }
});

module.exports = router;
