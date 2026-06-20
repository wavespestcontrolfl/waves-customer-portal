/**
 * Admin API for third-party payers (Bill-To accounts).
 *
 * A payer is a reusable Bill-To entity attached to a customer (default) and/or
 * a specific scheduled service (per-job override). Invoices resolve and
 * snapshot the payer at creation, then route the invoice email to the payer's
 * AP inbox. See server/services/payer.js + the 20260617000002 migration.
 *
 * Billing data → admin-only.
 */

const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const PayerService = require('../services/payer');
const logger = require('../services/logger');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { finalizeStatement, loadStatementLines } = require('../services/payer-statements');
const { sendStatementEmail } = require('../services/payer-statement-email');

router.use(adminAuthenticate, requireAdmin);

// Load a statement and confirm it belongs to the addressed payer. Returns null
// (→ 404) on mismatch so one payer's URL can't reach another's statement.
async function loadOwnedStatement(payerId, statementId) {
  const pid = Number(payerId);
  const sid = Number(statementId);
  if (!Number.isInteger(pid) || !Number.isInteger(sid)) return null;
  const statement = await db('payer_statements').where({ id: sid }).first();
  if (!statement || Number(statement.payer_id) !== pid) return null;
  return statement;
}

// GET /api/admin/payers?search=&includeInactive=true
router.get('/', async (req, res, next) => {
  try {
    const payers = await PayerService.listPayers({
      search: req.query.search,
      includeInactive: req.query.includeInactive === 'true' || req.query.includeInactive === '1',
    });
    res.json({ payers });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const payer = await PayerService.getPayer(req.params.id);
    if (!payer) return res.status(404).json({ error: 'Payer not found' });
    res.json({ payer });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payers
router.post('/', async (req, res, next) => {
  try {
    const { payer, error } = await PayerService.createPayer(req.body || {});
    if (error) return res.status(400).json({ error });
    logger.info(`[payers] created payer ${payer.id}`);
    res.status(201).json({ payer });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/payers/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { payer, error, notFound } = await PayerService.updatePayer(req.params.id, req.body || {});
    if (notFound) return res.status(404).json({ error });
    if (error) return res.status(400).json({ error });
    res.json({ payer });
  } catch (err) {
    next(err);
  }
});

// --- NET-terms statements (Phase 2) -----------------------------------------
// Read paths are ungated (they return [] for everyone today since no statements
// exist until the gate is flipped). The mutating close/send paths are gated.

// GET /api/admin/payers/:id/statements — recent statements for a payer.
router.get('/:id/statements', async (req, res, next) => {
  try {
    const pid = Number(req.params.id);
    if (!Number.isInteger(pid)) return res.status(400).json({ error: 'Invalid payer id' });
    const statements = await db('payer_statements')
      .where({ payer_id: pid })
      .orderBy('period_start', 'desc')
      .limit(48);
    res.json({ statements });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payers/:id/statements/:statementId — statement + its visit lines.
router.get('/:id/statements/:statementId', async (req, res, next) => {
  try {
    const statement = await loadOwnedStatement(req.params.id, req.params.statementId);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });
    const lines = await loadStatementLines(statement.id);
    res.json({ statement, lines });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payers/:id/statements/:statementId/close — finalize (freeze
// totals/snapshot/due-date). Body { send?: bool, dryRun?: bool } chains the
// AP send so "close & send" is one operator click. Idempotent: re-closing a
// finalized statement returns it unchanged.
router.post('/:id/statements/:statementId/close', async (req, res, next) => {
  if (!isEnabled('payerStatements')) return res.status(403).json({ error: 'Payer statements are not enabled' });
  try {
    const statement = await loadOwnedStatement(req.params.id, req.params.statementId);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    const frozen = await db.transaction((trx) => finalizeStatement(statement.id, { database: trx }));

    let delivery = null;
    if (req.body?.send) {
      delivery = await sendStatementEmail(statement.id, { dryRun: !!req.body?.dryRun });
    }
    // Log the ACTUAL send outcome — a failed AP delivery must not read as sent.
    const sendNote = !req.body?.send
      ? ''
      : delivery?.ok
        ? (delivery.dryRun ? ' (dry-run send ok)' : ' + sent')
        : ` (close ok, send FAILED: ${delivery?.error || 'unknown'})`;
    logger.info(`[payers] statement ${statement.id} closed${sendNote}`);

    // Close committed; if the chained send was requested and failed, surface it
    // (mirror /send → 422) so "close & send" never reports a silent AP miss. The
    // frozen statement is still returned — re-close is idempotent, so the operator
    // can safely retry the send.
    if (req.body?.send && delivery && !delivery.ok) {
      return res.status(422).json({ statement: frozen, delivery, error: delivery.error || 'send_failed' });
    }
    res.json({ statement: frozen, delivery });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payers/:id/statements/:statementId/send — (re)send a closed
// statement. Body { dryRun?: bool }. 409 if still open (close it first).
router.post('/:id/statements/:statementId/send', async (req, res, next) => {
  if (!isEnabled('payerStatements')) return res.status(403).json({ error: 'Payer statements are not enabled' });
  try {
    const statement = await loadOwnedStatement(req.params.id, req.params.statementId);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });
    if (statement.status === 'open') return res.status(409).json({ error: 'Statement must be closed before sending' });

    const delivery = await sendStatementEmail(statement.id, { dryRun: !!req.body?.dryRun });
    if (!delivery.ok) return res.status(422).json({ error: delivery.error || 'send_failed', delivery });
    res.json({ delivery });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
