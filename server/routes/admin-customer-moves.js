/**
 * Admin moving routes (owner 2026-11-02, dark behind GATE_MOVING_FLOW), mounted
 * under /api/admin/customers so Customer 360's Moving card can call them.
 *
 *   GET  /:id/moves         the customer's latest 5 moves and where "Text
 *                           moving link" opens ({ phone, hasTexts }). Gate
 *                           off: 200 { enabled: false, moves: [] } so the
 *                           card hides.
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
const { movingFlowLive } = require('../config/feature-gates');
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
    const [moves, text] = await Promise.all([Moves.recentMoves(id, 5), Moves.textTarget(id)]);
    return res.json({ enabled: true, moves, text });
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

module.exports = router;
