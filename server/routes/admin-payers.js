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
const StripeService = require('../services/stripe');
const { settleStatementPaid, PAYABLE_STATEMENT_STATUSES } = require('../services/payer-statement-settle');

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
      // First-delivery-only: send ONLY when this request actually freshly closed
      // the statement (finalized, never sent). finalizeStatement is idempotent —
      // a double-click / retry returns an already-sent/viewed row, and re-sending
      // it here would mail AP a duplicate. Intentional resends go via /send.
      // `firstDelivery: true` pins the base idempotency key so the concurrent
      // race (a sibling stamps `sent` between this check and the send's re-read)
      // dedupes on the base key instead of going keyless.
      const freshClose = frozen?.status === 'finalized' && !frozen?.sent_at;
      delivery = freshClose
        ? await sendStatementEmail(statement.id, { dryRun: !!req.body?.dryRun, firstDelivery: true })
        : { ok: true, skipped: 'already_delivered', status: frozen?.status };
    }
    // Log the ACTUAL send outcome — a failed AP delivery must not read as sent.
    let sendNote = '';
    if (req.body?.send) {
      if (delivery?.skipped) sendNote = ` (already ${frozen?.status}; not re-sent)`;
      else if (delivery?.deduped) sendNote = ' (already in flight; not re-sent)';
      else if (delivery?.ok) sendNote = delivery.dryRun ? ' (dry-run send ok)' : ' + sent';
      else sendNote = ` (close ok, send FAILED: ${delivery?.error || 'unknown'})`;
    }
    logger.info(`[payers] statement ${statement.id} closed${sendNote}`);

    // Close committed; if the chained send was requested and genuinely failed,
    // surface it (mirror /send → 422) so "close & send" never reports a silent AP
    // miss. A skipped already-delivered send is not a failure. The frozen
    // statement is always returned (re-close is idempotent).
    if (req.body?.send && delivery && !delivery.ok && !delivery.skipped) {
      return res.status(422).json({ statement: frozen, delivery, error: delivery.error || 'send_failed' });
    }
    res.json({ statement: frozen, delivery });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payers/:id/statements/:statementId/send — (re)send a closed
// statement. Body { dryRun?: bool, force?: bool }. 409 if still open. A normal
// send stays idempotent (stable first-delivery key — a double-click can't mail
// AP twice); `force: true` makes a fresh attempt to RETRY a known blocked/
// suppressed delivery (which the terminal key would otherwise dedupe forever).
router.post('/:id/statements/:statementId/send', async (req, res, next) => {
  if (!isEnabled('payerStatements')) return res.status(403).json({ error: 'Payer statements are not enabled' });
  try {
    const statement = await loadOwnedStatement(req.params.id, req.params.statementId);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });
    if (statement.status === 'open') return res.status(409).json({ error: 'Statement must be closed before sending' });

    const delivery = await sendStatementEmail(statement.id, { dryRun: !!req.body?.dryRun, forceResend: !!req.body?.force });
    if (!delivery.ok) return res.status(422).json({ error: delivery.error || 'send_failed', delivery });
    res.json({ delivery });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payers/:id/statements/:statementId/reconcile — record an
// OFFLINE settlement (check/ACH/wire) against a statement and cascade. The common
// AP path. Refuses while `processing` (online payment in flight) or `paid`, and
// CANCELS any unconfirmed online PI first so the AP can't also pay online after
// the operator records the check. Body { method?, amount? }. Gated.
router.post('/:id/statements/:statementId/reconcile', async (req, res, next) => {
  if (!isEnabled('payerStatements')) return res.status(403).json({ error: 'Payer statements are not enabled' });
  try {
    const owned = await loadOwnedStatement(req.params.id, req.params.statementId);
    if (!owned) return res.status(404).json({ error: 'Statement not found' });

    const method = String(req.body?.method || 'check').toLowerCase(); // check | ach | wire | offline
    // OFFLINE methods only — a card/unknown value would record a card-family
    // settlement at the BASE amount with no surcharge (the surcharge MUST derive
    // from computeChargeAmount on the online pay path, never here).
    if (!['check', 'ach', 'wire', 'offline'].includes(method)) {
      return res.status(400).json({ error: 'Reconcile method must be one of: check, ach, wire, offline' });
    }
    const rawAmount = req.body?.amount; // validated against the LOCKED total inside the txn

    // Cancel + settle UNDER ONE LOCK: a concurrent /pay/statement/:token/setup
    // also takes `forUpdate` on the statement, so holding the lock across the PI
    // cancel and the settle prevents it from minting + storing a new confirmable
    // PI between the two (which would let the AP confirm online after the check is
    // recorded — double collection). Status AND amount are validated against the
    // LOCKED row (a close/reroll between the pre-lock read and here can change the
    // total). cancelStatementPaymentIntentIfUnconfirmed throws 409 if money is
    // truly in flight (and fails closed if the PI can't be verified).
    let settledAmount;
    const result = await db.transaction(async (trx) => {
      const locked = await trx('payer_statements').where({ id: owned.id }).forUpdate().first();
      if (!locked) { const e = new Error('Statement not found'); e.statusCode = 404; throw e; }
      if (locked.status === 'paid') { const e = new Error('Statement is already paid'); e.statusCode = 409; throw e; }
      if (locked.status === 'processing') { const e = new Error('An online payment is in flight — wait for it to resolve before reconciling'); e.statusCode = 409; throw e; }
      if (!PAYABLE_STATEMENT_STATUSES.has(locked.status)) { const e = new Error('Close the statement before reconciling'); e.statusCode = 400; throw e; }

      const total = Number(locked.total);
      const amount = rawAmount != null ? Number(rawAmount) : total;
      // Mirror the invoice reconcile's $1 tolerance — a materially different
      // amount would drift the ledger from the statement.
      if (!Number.isFinite(amount) || Math.abs(amount - total) > 1) {
        const e = new Error(`Amount mismatch — recorded $${(Number(amount) || 0).toFixed(2)} but statement is $${total.toFixed(2)}. Edit the statement first if it changed.`);
        e.statusCode = 400;
        throw e;
      }
      settledAmount = amount;

      if (locked.stripe_payment_intent_id) {
        await StripeService.cancelStatementPaymentIntentIfUnconfirmed(owned.id);
      }
      return settleStatementPaid(owned.id, {
        paymentMethod: method,
        amountCents: Math.round(amount * 100),
        source: 'admin_reconcile',
      }, { database: trx, allowedStatuses: PAYABLE_STATEMENT_STATUSES });
    });

    logger.info(`[payers] statement ${owned.id} reconciled offline via ${method} ($${settledAmount.toFixed(2)})`);
    res.json({ ok: true, statement: result.statement, alreadyPaid: !!result.alreadyPaid, childrenSettled: result.childrenSettled || 0 });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: err.message });
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
