const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { isUserFeatureEnabled } = require('../services/feature-flags');
const { buildAgentEstimateContext } = require('../services/agent-estimate-context');

const FEATURE_KEY = 'agent_estimate';

router.use(adminAuthenticate, requireTechOrAdmin);
router.use(async (req, res, next) => {
  try {
    const enabled = await isUserFeatureEnabled(req.technicianId, FEATURE_KEY, false);
    if (!enabled) return res.status(404).json({ error: 'Agent Estimate is not enabled' });
    return next();
  } catch (err) {
    return next(err);
  }
});

router.get('/lead/:leadId', async (req, res, next) => {
  try {
    const context = await buildAgentEstimateContext(req.params.leadId);
    if (context.error === 'lead_not_found') return res.status(404).json({ error: 'Lead not found' });
    return res.json({ context });
  } catch (err) {
    return next(err);
  }
});

router.get('/memory', async (req, res, next) => {
  try {
    const rows = await db('agent_estimate_memory')
      .leftJoin('technicians as creator', 'agent_estimate_memory.created_by', 'creator.id')
      .leftJoin('technicians as reviewer', 'agent_estimate_memory.reviewed_by', 'reviewer.id')
      .select('agent_estimate_memory.*', 'creator.name as created_by_name', 'reviewer.name as reviewed_by_name')
      .orderByRaw("CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END")
      .orderBy('agent_estimate_memory.created_at', 'desc')
      .limit(100);
    res.json({ memories: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/memory', async (req, res, next) => {
  try {
    const ruleText = String(req.body?.rule_text || '').trim();
    const rationale = String(req.body?.rationale || '').trim();
    const sourceLeadId = req.body?.source_lead_id || null;
    if (ruleText.length < 12 || ruleText.length > 2000) {
      return res.status(400).json({ error: 'rule_text must be 12-2000 characters' });
    }
    if (rationale.length > 4000) return res.status(400).json({ error: 'rationale is too long' });
    // Version allocation must be atomic: two concurrent submissions reading
    // the same max would both insert the same version, duplicating labels in
    // the approved-learning prompt and breaking audit ordering. An advisory
    // xact lock serializes the read+insert without needing a schema change.
    const memory = await db.transaction(async (trx) => {
      await trx.raw("select pg_advisory_xact_lock(hashtext('agent_estimate_memory_version'))");
      const latest = await trx('agent_estimate_memory').max('version as max_version').first();
      const version = Math.max(0, Number(latest?.max_version) || 0) + 1;
      const [inserted] = await trx('agent_estimate_memory').insert({
        rule_text: ruleText,
        rationale: rationale || null,
        source_lead_id: sourceLeadId,
        created_by: req.technicianId,
        status: 'pending',
        version,
      }).returning('*');
      return inserted;
    });
    res.status(201).json({ memory });
  } catch (err) {
    next(err);
  }
});

router.patch('/memory/:id', requireAdmin, async (req, res, next) => {
  try {
    const status = String(req.body?.status || '');
    if (!['approved', 'rejected', 'retired'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved, rejected, or retired' });
    }
    const [memory] = await db('agent_estimate_memory')
      .where({ id: req.params.id })
      .update({
        status,
        reviewed_by: req.technicianId,
        reviewed_at: db.fn.now(),
        updated_at: db.fn.now(),
      })
      .returning('*');
    if (!memory) return res.status(404).json({ error: 'Learning candidate not found' });
    return res.json({ memory });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.FEATURE_KEY = FEATURE_KEY;
