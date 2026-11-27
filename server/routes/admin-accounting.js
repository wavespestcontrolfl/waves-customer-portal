/**
 * Admin Accounting & General Ledger API (QuickBooks-style double-entry core),
 * dark behind GATE_ACCOUNTING_GL=true.
 *
 * Security & controls:
 * - Every route requires adminAuthenticate + requireAdmin (technicians default-denied).
 * - Responses carry Cache-Control: no-store.
 * - GET /status works while dark ({ enabled: boolean }) without reading the DB.
 * - While GATE_ACCOUNTING_GL !== 'true', every other route returns 404 { enabled: false }.
 * - All accounting mutations (JE post/reverse, transfers, opening balances, sync,
 *   account create/edit, reconciliation finish/reopen, period close/lock/reopen,
 *   vendor create/edit) require the owner account (requireFullAccess) and write
 *   critical audit_log events inside the same DB transaction.
 */

const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { requireFullAccess } = require('../services/intelligence-bar/ib-access');
const { accountingGlLive } = require('../config/feature-gates');
const ledger = require('../services/accounting/ledger');
const rules = require('../services/accounting/posting-rules');
const statements = require('../services/accounting/statements');
const reconciliation = require('../services/accounting/reconciliation');
const periods = require('../services/accounting/periods');
const vendors = require('../services/accounting/vendors');
const syncBridge = require('../services/accounting/sync-bridge');

const router = express.Router();

router.use(adminAuthenticate);
router.use(requireAdmin);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/status', (req, res) => {
  res.json({ enabled: accountingGlLive() });
});

router.use((req, res, next) => {
  if (!accountingGlLive()) return res.status(404).json({ enabled: false });
  return next();
});

function actorContext(req) {
  return {
    actorId: req.technicianId || null,
    requestMeta: {
      ip: req.ip || null,
      userAgent: req.get('user-agent') || null,
    },
  };
}

function fail(res, what, err) {
  if (err && err.name === 'AccountingError') {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  if (err && (err.code === '23514' || err.code === 'P0001')) {
    return res.status(409).json({ error: err.message || 'Accounting integrity constraint refused this change.' });
  }
  logger.error(`[admin-accounting] ${what} failed (${(err && (err.code || err.name)) || 'error'})`);
  return res.status(500).json({ error: 'Accounting operation failed. Try again.' });
}

// ── Executive Overview ───────────────────────────────────────────────────────

router.get('/overview', async (req, res) => {
  try {
    res.json(await statements.getAccountingOverview());
  } catch (err) {
    fail(res, 'overview', err);
  }
});

// ── Chart of Accounts & Account Registers ────────────────────────────────────

router.get('/accounts', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const accounts = await ledger.listAccounts({ includeInactive });
    res.json({ accounts });
  } catch (err) {
    fail(res, 'listAccounts', err);
  }
});

router.post('/accounts', requireFullAccess, async (req, res) => {
  try {
    const account = await ledger.createAccount(req.body, actorContext(req));
    res.status(201).json({ account });
  } catch (err) {
    fail(res, 'createAccount', err);
  }
});

router.patch('/accounts/:id', requireFullAccess, async (req, res) => {
  try {
    const account = await ledger.updateAccount(req.params.id, req.body || {}, actorContext(req));
    res.json({ account });
  } catch (err) {
    fail(res, 'updateAccount', err);
  }
});

router.get('/accounts/:id/register', async (req, res) => {
  try {
    const data = await ledger.getAccountRegister(req.params.id, {
      from: req.query.from || null,
      to: req.query.to || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(data);
  } catch (err) {
    fail(res, 'getAccountRegister', err);
  }
});

// ── Journal Entries, Transfers, Opening Balances & Subledger Sync ────────────

router.get('/journal-entries', async (req, res) => {
  try {
    const data = await ledger.listJournalEntries({
      from: req.query.from || null,
      to: req.query.to || null,
      sourceType: req.query.sourceType || null,
      entryType: req.query.entryType || null,
      search: req.query.search || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(data);
  } catch (err) {
    fail(res, 'listJournalEntries', err);
  }
});

router.get('/journal-entries/:id', async (req, res) => {
  try {
    const validId = ledger.assertOptionalUuid(req.params.id, 'id');
    const entry = await ledger.loadEntryWithLines(require('../models/db'), validId);
    if (!entry) return res.status(404).json({ error: 'Journal entry not found' });
    return res.json({ entry });
  } catch (err) {
    return fail(res, 'getJournalEntry', err);
  }
});

function requireSubmissionIdempotencyKey(req) {
  const raw = req.body?.idempotencyKey || req.body?.idempotency_key || req.get('idempotency-key') || '';
  const key = String(raw).trim();
  if (key.length < 8 || key.length > 180) {
    throw new ledger.AccountingError(
      400,
      'idempotencyKey (8-180 chars, or Idempotency-Key header) is required to prevent duplicate postings on retry',
    );
  }
  return key;
}

router.post('/journal-entries', requireFullAccess, async (req, res) => {
  try {
    const idempotencyKey = requireSubmissionIdempotencyKey(req);
    const { entry, created } = await ledger.postJournalEntry(
      { ...(req.body || {}), idempotencyKey },
      actorContext(req),
    );
    res.status(created ? 201 : 200).json({ entry, created });
  } catch (err) {
    fail(res, 'postJournalEntry', err);
  }
});

router.patch('/journal-entries/:id/vendor', requireFullAccess, async (req, res) => {
  try {
    const result = await ledger.linkJournalEntryVendor(req.params.id, {
      vendorId: req.body?.vendorId || req.body?.vendor_id,
      reason: req.body?.reason || '',
      ...actorContext(req),
    });
    res.json(result);
  } catch (err) {
    fail(res, 'linkJournalEntryVendor', err);
  }
});

router.post('/journal-entries/:id/reverse', requireFullAccess, async (req, res) => {
  try {
    const result = await ledger.reverseJournalEntry(req.params.id, {
      reversalDate: req.body?.reversalDate || null,
      reason: req.body?.reason || '',
      ...actorContext(req),
    });
    res.status(201).json(result);
  } catch (err) {
    fail(res, 'reverseJournalEntry', err);
  }
});

router.post('/quick-transfer', requireFullAccess, async (req, res) => {
  try {
    const b = req.body || {};
    const sourceId = requireSubmissionIdempotencyKey(req);
    const payload = rules.buildTransferEntry({
      sourceId,
      entryDate: b.entryDate,
      amountCents: b.amountCents,
      fromAccountId: b.fromAccountId || null,
      fromAccountCode: b.fromAccountCode || undefined,
      toAccountId: b.toAccountId || null,
      toAccountCode: b.toAccountCode || undefined,
      memo: b.memo || 'Internal account transfer',
      reference: b.reference || null,
    });
    const { entry, created } = await ledger.postJournalEntry(payload, actorContext(req));
    res.status(created ? 201 : 200).json({ entry, created });
  } catch (err) {
    fail(res, 'quickTransfer', err);
  }
});

router.post('/opening-balances', requireFullAccess, async (req, res) => {
  try {
    const b = req.body || {};
    const resolvedItems = await ledger.resolveOpeningBalanceItems(b.items);
    const payload = rules.buildOpeningBalanceEntry({
      asOfDate: b.asOfDate,
      items: resolvedItems,
      memo: b.memo || null,
    });
    const { entry, created } = await ledger.postJournalEntry(payload, actorContext(req));
    res.status(created ? 201 : 200).json({ entry, created });
  } catch (err) {
    fail(res, 'openingBalances', err);
  }
});

router.post('/sync', requireFullAccess, async (req, res) => {
  try {
    const b = req.body || {};
    const summary = await syncBridge.syncSubledgersToGl({
      fromDate: b.fromDate || null,
      toDate: b.toDate || null,
      dryRun: Boolean(b.dryRun),
      ...actorContext(req),
    });
    res.json(summary);
  } catch (err) {
    fail(res, 'syncSubledgers', err);
  }
});

// ── Financial Statements ─────────────────────────────────────────────────────

router.get('/reports/trial-balance', async (req, res) => {
  try {
    res.json(await statements.getTrialBalance({ asOf: req.query.asOf || null }));
  } catch (err) {
    fail(res, 'trialBalance', err);
  }
});

router.get('/reports/pnl', async (req, res) => {
  try {
    res.json(await statements.getProfitAndLoss({
      from: req.query.from || null,
      to: req.query.to || null,
      basis: req.query.basis === 'cash' ? 'cash' : 'accrual',
    }));
  } catch (err) {
    fail(res, 'pnl', err);
  }
});

router.get('/reports/balance-sheet', async (req, res) => {
  try {
    res.json(await statements.getBalanceSheet({ asOf: req.query.asOf || null }));
  } catch (err) {
    fail(res, 'balanceSheet', err);
  }
});

router.get('/reports/cash-flow', async (req, res) => {
  try {
    res.json(await statements.getCashFlowStatement({
      from: req.query.from || null,
      to: req.query.to || null,
    }));
  } catch (err) {
    fail(res, 'cashFlow', err);
  }
});

router.get('/reports/sales-tax', async (req, res) => {
  try {
    res.json(await statements.getSalesTaxLiabilitySummary({
      from: req.query.from || null,
      to: req.query.to || null,
    }));
  } catch (err) {
    fail(res, 'salesTax', err);
  }
});

router.get('/reports/1099', async (req, res) => {
  try {
    res.json(await statements.get1099VendorSummary({ year: req.query.year || null }));
  } catch (err) {
    fail(res, '1099Summary', err);
  }
});

// ── Statement Reconciliation ─────────────────────────────────────────────────

router.get('/reconciliations', async (req, res) => {
  try {
    const reconciliations = await reconciliation.listReconciliations({ accountId: req.query.accountId || null });
    res.json({ reconciliations });
  } catch (err) {
    fail(res, 'listReconciliations', err);
  }
});

router.post('/reconciliations', requireFullAccess, async (req, res) => {
  try {
    const workspace = await reconciliation.startReconciliation({
      ...(req.body || {}),
      ...actorContext(req),
    });
    res.status(201).json(workspace);
  } catch (err) {
    fail(res, 'startReconciliation', err);
  }
});

router.get('/reconciliations/:id', async (req, res) => {
  try {
    const workspace = await reconciliation.getReconciliationWorkspace(req.params.id);
    res.json(workspace);
  } catch (err) {
    fail(res, 'getReconciliation', err);
  }
});

router.patch('/reconciliations/:id', requireFullAccess, async (req, res) => {
  try {
    const workspace = await reconciliation.updateReconciliation(req.params.id, {
      ...(req.body || {}),
      ...actorContext(req),
    });
    res.json(workspace);
  } catch (err) {
    fail(res, 'updateReconciliation', err);
  }
});

router.delete('/reconciliations/:id', requireFullAccess, async (req, res) => {
  try {
    const result = await reconciliation.cancelReconciliation(req.params.id, {
      reason: req.body?.reason || req.query?.reason || '',
      ...actorContext(req),
    });
    res.json(result);
  } catch (err) {
    fail(res, 'cancelReconciliation', err);
  }
});

router.patch('/reconciliations/:id/lines', requireFullAccess, async (req, res) => {
  try {
    const workspace = await reconciliation.toggleClearedLines(req.params.id, {
      lineIds: req.body?.lineIds,
      cleared: req.body?.cleared,
      ...actorContext(req),
    });
    res.json(workspace);
  } catch (err) {
    fail(res, 'toggleClearedLines', err);
  }
});

router.post('/reconciliations/:id/finish', requireFullAccess, async (req, res) => {
  try {
    const workspace = await reconciliation.finishReconciliation(req.params.id, actorContext(req));
    res.json(workspace);
  } catch (err) {
    fail(res, 'finishReconciliation', err);
  }
});

router.post('/reconciliations/:id/reopen', requireFullAccess, async (req, res) => {
  try {
    const workspace = await reconciliation.reopenReconciliation(req.params.id, {
      reason: req.body?.reason || '',
      ...actorContext(req),
    });
    res.json(workspace);
  } catch (err) {
    fail(res, 'reopenReconciliation', err);
  }
});

// ── Accounting Periods (Close & Lock Books) ──────────────────────────────────

router.get('/periods', async (req, res) => {
  try {
    const list = await periods.listPeriods();
    res.json({ periods: list });
  } catch (err) {
    fail(res, 'listPeriods', err);
  }
});

router.post('/periods/:month/close', requireFullAccess, async (req, res) => {
  try {
    const period = await periods.closePeriod(req.params.month, {
      notes: req.body?.notes || null,
      ...actorContext(req),
    });
    res.json({ period });
  } catch (err) {
    fail(res, 'closePeriod', err);
  }
});

router.post('/periods/:month/lock', requireFullAccess, async (req, res) => {
  try {
    const period = await periods.lockPeriod(req.params.month, {
      notes: req.body?.notes || null,
      ...actorContext(req),
    });
    res.json({ period });
  } catch (err) {
    fail(res, 'lockPeriod', err);
  }
});

router.post('/periods/:month/reopen', requireFullAccess, async (req, res) => {
  try {
    const period = await periods.reopenPeriod(req.params.month, {
      notes: req.body?.notes || null,
      ...actorContext(req),
    });
    res.json({ period });
  } catch (err) {
    fail(res, 'reopenPeriod', err);
  }
});

// ── Vendor Master (1099 / W-9) ───────────────────────────────────────────────

router.get('/vendors', async (req, res) => {
  try {
    const list = await vendors.listVendors({ includeInactive: req.query.includeInactive === 'true' });
    res.json({ vendors: list });
  } catch (err) {
    fail(res, 'listVendors', err);
  }
});

router.post('/vendors', requireFullAccess, async (req, res) => {
  try {
    const vendor = await vendors.createVendor(req.body || {}, actorContext(req));
    res.status(201).json({ vendor });
  } catch (err) {
    fail(res, 'createVendor', err);
  }
});

router.patch('/vendors/:id', requireFullAccess, async (req, res) => {
  try {
    const vendor = await vendors.updateVendor(req.params.id, req.body || {}, actorContext(req));
    res.json({ vendor });
  } catch (err) {
    fail(res, 'updateVendor', err);
  }
});

module.exports = router;
