const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const pricingEngineV2 = require('../services/pricing-engine-v2');
const dbBridge = require('../services/pricing-engine/db-bridge');

router.use(adminAuthenticate, requireTechOrAdmin);

// ---- helpers -------------------------------------------------------------

// pg returns numeric(12,4) columns as JS strings. Coerce to Number before
// JSON.stringify so jsonb_set stores a jsonb number, not a jsonb string.
const numVal = (v) => (v == null ? null : Number(v));

function determineCategory(configKey) {
  if (!configKey || typeof configKey !== 'string') return 'rule';
  const rowKey = configKey.split('.')[0];
  if (rowKey.startsWith('vendor_') || rowKey.startsWith('cogs_')) return 'bug';
  return 'rule';
}

function isKnownCosmetic(configKey) {
  return typeof configKey === 'string' && configKey.startsWith('global_margin_target_ts');
}

function buildRationaleText(proposal, reviewNotes, technicianId) {
  const lines = [];
  lines.push(`Approved by technician_id=${technicianId} at ${new Date().toISOString()}.`);
  lines.push(`Config key: ${proposal.config_key}`);
  lines.push(`Change: ${JSON.stringify(numVal(proposal.current_value))} -> ${JSON.stringify(numVal(proposal.proposed_value))}`);
  if (proposal.pct_change != null) lines.push(`Pct change: ${proposal.pct_change}%`);
  if (proposal.trigger_source) lines.push(`Trigger source: ${proposal.trigger_source}`);
  if (proposal.evidence) {
    try {
      const ev = typeof proposal.evidence === 'string' ? JSON.parse(proposal.evidence) : proposal.evidence;
      lines.push(`Evidence: ${JSON.stringify(ev)}`);
    } catch {
      lines.push(`Evidence: ${String(proposal.evidence)}`);
    }
  }
  if (proposal.price_impact) {
    try {
      const pi = typeof proposal.price_impact === 'string' ? JSON.parse(proposal.price_impact) : proposal.price_impact;
      lines.push(`Price impact: ${JSON.stringify(pi)}`);
    } catch {
      lines.push(`Price impact: ${String(proposal.price_impact)}`);
    }
  }
  if (reviewNotes) lines.push(`Admin review_notes: ${reviewNotes}`);
  if (isKnownCosmetic(proposal.config_key)) {
    lines.push('NOTE: global_margin_target_ts is cosmetic in pricing_config — db-bridge does not sync it into the engine (engine reads TREE_SHRUB.marginTarget from constants.js directly). This approval updates the DB row for consistency but will not change engine behavior.');
  }
  return lines.join('\n');
}

function splitConfigKey(configKey) {
  if (!configKey || typeof configKey !== 'string') return { rowKey: null, jsonPath: [] };
  const idx = configKey.indexOf('.');
  if (idx === -1) return { rowKey: configKey, jsonPath: [] };
  return {
    rowKey: configKey.slice(0, idx),
    jsonPath: configKey.slice(idx + 1).split('.'),
  };
}

async function applyConfigUpdate(trx, proposal) {
  const { rowKey, jsonPath } = splitConfigKey(proposal.config_key);
  if (!rowKey) throw new Error(`Invalid config_key: ${proposal.config_key}`);
  if (jsonPath.length === 0) {
    throw new Error(`config_key '${proposal.config_key}' has no dotted path — whole-row updates are not supported by this approval queue`);
  }

  const row = await trx('pricing_config').where('config_key', rowKey).first();
  if (!row) throw new Error(`pricing_config row '${rowKey}' not found`);

  const pathLiteral = `{${jsonPath.join(',')}}`;
  const proposedJson = JSON.stringify(numVal(proposal.proposed_value));

  const updated = await trx('pricing_config')
    .where('config_key', rowKey)
    .update({
      data: trx.raw('jsonb_set(data, ?::text[], ?::jsonb, true)', [pathLiteral, proposedJson]),
      updated_at: trx.fn.now(),
    });

  return updated > 0;
}

// ---- routes --------------------------------------------------------------

// GET /api/admin/pricing-proposals?status=pending&limit=30
router.get('/', async (req, res) => {
  const { status = 'pending', limit: rawLimit = 30 } = req.query;
  const limit = Math.min(parseInt(rawLimit, 10) || 30, 100);

  try {
    let query = db('pricing_engine_proposals')
      .select('*')
      .orderBy('created_at', 'desc')
      .limit(limit);
    if (status && status !== 'all') query = query.where('status', status);
    const proposals = await query;
    res.json({ proposals });
  } catch (err) {
    logger.error('[pricing-proposals] list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/pricing-proposals/:id
router.get('/:id', async (req, res) => {
  try {
    const proposal = await db('pricing_engine_proposals')
      .where('id', req.params.id)
      .first();
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const { rowKey } = splitConfigKey(proposal.config_key);
    const currentConfig = rowKey
      ? await db('pricing_config').where('config_key', rowKey).first()
      : null;

    res.json({ proposal, current_config: currentConfig });
  } catch (err) {
    logger.error('[pricing-proposals] detail failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/pricing-proposals/:id/approve
router.post('/:id/approve', async (req, res) => {
  const { review_notes = null } = req.body || {};
  const technicianId = req.technicianId;
  const proposalId = req.params.id;

  try {
    let newChangelogId = null;

    await db.transaction(async (trx) => {
      const proposal = await trx('pricing_engine_proposals')
        .where('id', proposalId)
        .first();
      if (!proposal) {
        const e = new Error('Proposal not found');
        e.status = 404;
        throw e;
      }
      if (proposal.status !== 'pending') {
        const e = new Error(`Cannot approve proposal in status '${proposal.status}'`);
        e.status = 400;
        throw e;
      }

      const { jsonPath } = splitConfigKey(proposal.config_key);
      if (jsonPath.length === 0) {
        const e = new Error(`config_key '${proposal.config_key}' has no dotted path — whole-row updates are not supported`);
        e.status = 400;
        throw e;
      }

      const category = determineCategory(proposal.config_key);

      // Sequence-sync safety (Session 8.5 carry-forward)
      await trx.raw(
        "SELECT setval(pg_get_serial_sequence('pricing_changelog', 'id'), (SELECT COALESCE(MAX(id), 0) FROM pricing_changelog), true)"
      );

      const inserted = await trx('pricing_changelog').insert({
        version_from: 'v4.2',
        version_to: 'v4.2',
        changed_by: `admin-${technicianId}`,
        category,
        summary: `Approved proposal ${proposalId}: ${proposal.config_key} ${JSON.stringify(numVal(proposal.current_value))} -> ${JSON.stringify(numVal(proposal.proposed_value))}`,
        affected_services: JSON.stringify([proposal.config_key]),
        before_value: JSON.stringify({ value: numVal(proposal.current_value) }),
        after_value: JSON.stringify({ value: numVal(proposal.proposed_value) }),
        rationale: buildRationaleText(proposal, review_notes, technicianId),
      }).returning('id');

      newChangelogId = Array.isArray(inserted) ? (inserted[0].id || inserted[0]) : inserted;

      const ok = await applyConfigUpdate(trx, proposal);
      if (!ok) throw new Error(`Failed to update pricing_config for key ${proposal.config_key}`);

      await trx('pricing_engine_proposals')
        .where('id', proposalId)
        .update({
          status: 'approved',
          reviewed_by: technicianId,
          reviewed_at: trx.fn.now(),
          review_notes,
          changelog_id: newChangelogId,
        });
    });

    // Bust caches (outside transaction, single-instance in-process)
    try {
      pricingEngineV2.invalidatePricingConfigCache();
      await dbBridge.syncConstantsFromDB(db);
    } catch (cacheErr) {
      logger.warn(`[pricing-proposals] Cache bust failed post-approval: ${cacheErr.message}`);
    }

    res.json({ success: true, proposal_id: proposalId, changelog_id: newChangelogId });
  } catch (err) {
    logger.error('[pricing-proposals] approve failed:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/admin/pricing-proposals/:id/reject
router.post('/:id/reject', async (req, res) => {
  const { review_notes = null } = req.body || {};
  const technicianId = req.technicianId;

  try {
    const proposal = await db('pricing_engine_proposals')
      .where('id', req.params.id)
      .first();
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.status !== 'pending') {
      return res.status(400).json({
        error: `Cannot reject proposal in status '${proposal.status}'`,
      });
    }

    await db('pricing_engine_proposals')
      .where('id', req.params.id)
      .update({
        status: 'rejected',
        reviewed_by: technicianId,
        reviewed_at: db.fn.now(),
        review_notes,
      });

    res.json({ success: true, proposal_id: req.params.id });
  } catch (err) {
    logger.error('[pricing-proposals] reject failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
