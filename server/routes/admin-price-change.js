/**
 * Admin price-change workflow — POST /api/admin/price-change/{preview,send}.
 *
 * Two-step, same contract as the Automations segment send: preview returns
 * the LIVE per-customer current → new price list; send re-derives the list
 * and refuses on count drift, so the operator always confirms exactly what
 * goes out. The workflow sends NOTICES only — it never touches
 * customers.monthly_rate (applying the new rate stays a deliberate,
 * separate admin action).
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { previewPriceChange, createAndSendBatch } = require('../services/price-change-notices');

router.use(adminAuthenticate, requireAdmin);

router.post('/preview', async (req, res) => {
  try {
    const result = await previewPriceChange({
      locationId: req.body?.locationId || null,
      increase: req.body?.increase,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-price-change] preview failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    const result = await createAndSendBatch({
      locationId: req.body?.locationId || null,
      increase: req.body?.increase,
      effectiveDate: req.body?.effectiveDate,
      cadenceLabel: req.body?.cadenceLabel || 'month',
      expectedCount: Number(req.body?.expectedCount),
      expectedDigest: req.body?.expectedDigest || null,
      actorId: req.technicianId || null,
    });
    if (!result.ok && result.reason === 'count_drift') {
      return res.status(409).json({ error: `The list is now ${result.count} customers (you previewed ${req.body?.expectedCount}). Preview again to confirm the current list.`, count: result.count });
    }
    if (!result.ok && result.reason === 'list_changed') {
      return res.status(409).json({ error: 'The customer list or amounts changed since your preview (the count happens to match). Preview again to confirm the current list.', count: result.count });
    }
    if (!result.ok && result.reason === 'empty') {
      return res.status(400).json({ error: 'No matching recurring customers — nothing to send.' });
    }
    if (!result.ok && result.reason === 'over_cap') {
      return res.status(400).json({ error: `List (${result.count}) exceeds the batch cap — narrow by location.` });
    }
    if (!result.ok && result.reason === 'invalid_amounts') {
      return res.status(400).json({ error: 'This adjustment would take at least one customer to $0 or below — check the amount.' });
    }
    const failNote = result.failed ? ` ⚠️ ${result.failed} FAILED — check logs; re-running the same change is safe (customers already notified are skipped).` : '';
    res.json({
      ...result,
      message: `${result.created} notices created — ${result.emailed} emailed, ${result.texted} texted${result.unreachable ? `, ${result.unreachable} unreachable (no email or phone)` : ''}${result.alreadyNotified ? `, ${result.alreadyNotified} already notified (skipped)` : ''}.${failNote}`,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-price-change] send failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
