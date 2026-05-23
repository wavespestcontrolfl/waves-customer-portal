const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const SeoActionGenerator = require('../services/seo/seo-action-generator');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET / — list actions with filters
router.get('/', async (req, res) => {
  try {
    const { status, tier, type, domain, approval_status, execution_status, limit, offset } = req.query;
    let query = db('seo_actions').orderBy('priority_score', 'desc')
      .limit(parseInt(limit) || 50)
      .offset(parseInt(offset) || 0);

    if (status) query = query.where('status', status);
    else query = query.where('status', 'open');
    if (tier) query = query.where('approval_tier', tier);
    if (type) query = query.where('action_type', type);
    if (domain) query = query.where('domain', domain);
    if (approval_status) query = query.where('approval_status', approval_status);
    if (execution_status) query = query.where('execution_status', execution_status);

    const actions = await query;
    res.json(actions);
  } catch (err) {
    logger.error('[seo-actions] list error', err);
    res.status(500).json({ error: 'Failed to load actions' });
  }
});

// GET /summary — KPI counts
router.get('/summary', async (req, res) => {
  try {
    const data = await SeoActionGenerator.getSummary(req.query.domain);
    res.json(data);
  } catch (err) {
    logger.error('[seo-actions] summary error', err);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

// GET /:id — single action detail
router.get('/:id', async (req, res) => {
  try {
    const action = await db('seo_actions').where('id', req.params.id).first();
    if (!action) return res.status(404).json({ error: 'Action not found' });
    res.json(action);
  } catch (err) {
    logger.error('[seo-actions] detail error', err);
    res.status(500).json({ error: 'Failed to load action' });
  }
});

// POST /generate — generate actions from diagnoses
router.post('/generate', requireAdmin, async (req, res) => {
  try {
    const result = await SeoActionGenerator.generateActionsFromDiagnosis(req.body.domain || 'wavespestcontrol.com');
    res.json(result);
  } catch (err) {
    logger.error('[seo-actions] generate error', err);
    res.status(500).json({ error: 'Action generation failed' });
  }
});

// POST /:id/approve — approve action + write seo_decisions
router.post('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const action = await db('seo_actions').where('id', req.params.id).first();
    if (!action) return res.status(404).json({ error: 'Action not found' });

    await db('seo_actions').where('id', req.params.id).update({
      approval_status: 'approved',
      approved_by_admin_id: req.technicianId,
      approved_at: db.fn.now(),
      approval_notes: req.body.notes || null,
    });

    // Write to seo_decisions for learning loop
    try {
      await db('seo_decisions').insert({
        diagnosis_id: action.diagnosis_id,
        issue_type: action.issue_type,
        target_url: action.url,
        agent_recommendation: JSON.stringify({ action_type: action.action_type, summary: action.summary }),
        agent_impact_score: action.impact_score,
        agent_effort_score: action.effort_score,
        decision: 'accepted',
        decision_reason: req.body.notes || 'Approved via action queue',
        decided_by_admin_id: req.technicianId,
        decided_at: new Date(),
      });
    } catch (decErr) {
      logger.warn('[seo-actions] seo_decisions write failed', decErr.message);
    }

    res.json({ approved: true, id: req.params.id });
  } catch (err) {
    logger.error('[seo-actions] approve error', err);
    res.status(500).json({ error: 'Approval failed' });
  }
});

// POST /:id/reject — reject action + write seo_decisions
router.post('/:id/reject', requireAdmin, async (req, res) => {
  try {
    const action = await db('seo_actions').where('id', req.params.id).first();
    if (!action) return res.status(404).json({ error: 'Action not found' });

    await db('seo_actions').where('id', req.params.id).update({
      approval_status: 'rejected',
      approved_by_admin_id: req.technicianId,
      approved_at: db.fn.now(),
      approval_notes: req.body.notes || null,
      status: 'closed',
    });

    try {
      await db('seo_decisions').insert({
        diagnosis_id: action.diagnosis_id,
        issue_type: action.issue_type,
        target_url: action.url,
        agent_recommendation: JSON.stringify({ action_type: action.action_type, summary: action.summary }),
        agent_impact_score: action.impact_score,
        agent_effort_score: action.effort_score,
        decision: 'rejected',
        decision_reason: req.body.notes || 'Rejected via action queue',
        decided_by_admin_id: req.technicianId,
        decided_at: new Date(),
      });
    } catch (decErr) {
      logger.warn('[seo-actions] seo_decisions write failed', decErr.message);
    }

    res.json({ rejected: true, id: req.params.id });
  } catch (err) {
    logger.error('[seo-actions] reject error', err);
    res.status(500).json({ error: 'Rejection failed' });
  }
});

// POST /:id/defer
router.post('/:id/defer', requireAdmin, async (req, res) => {
  try {
    await db('seo_actions').where('id', req.params.id).update({
      approval_status: 'deferred',
      approval_notes: req.body.notes || null,
    });
    res.json({ deferred: true, id: req.params.id });
  } catch (err) {
    logger.error('[seo-actions] defer error', err);
    res.status(500).json({ error: 'Defer failed' });
  }
});

// POST /:id/execute — mark as done + create experiment
router.post('/:id/execute', requireAdmin, async (req, res) => {
  try {
    const action = await db('seo_actions').where('id', req.params.id).first();
    if (!action) return res.status(404).json({ error: 'Action not found' });

    await db('seo_actions').where('id', req.params.id).update({
      execution_status: 'done',
      started_at: action.started_at || db.fn.now(),
      completed_at: db.fn.now(),
      execution_notes: req.body.notes || 'Manually marked as executed',
      executor: 'manual',
    });

    const experiment = await SeoActionGenerator.createExperiment(action);
    res.json({ executed: true, id: req.params.id, experiment_id: experiment?.id });
  } catch (err) {
    logger.error('[seo-actions] execute error', err);
    res.status(500).json({ error: 'Execution failed' });
  }
});

// POST /generate-drafts — AI draft generation
router.post('/generate-drafts', requireAdmin, async (req, res) => {
  try {
    const result = await SeoActionGenerator.generateAIDrafts(req.body.actionIds);
    res.json(result);
  } catch (err) {
    logger.error('[seo-actions] generate-drafts error', err);
    res.status(500).json({ error: 'Draft generation failed' });
  }
});

// POST /auto-approve
router.post('/auto-approve', requireAdmin, async (req, res) => {
  try {
    if (!req.body.domain) return res.status(400).json({ error: 'domain is required' });
    const result = await SeoActionGenerator.autoApprove(req.body.domain);
    res.json(result);
  } catch (err) {
    logger.error('[seo-actions] auto-approve error', err);
    res.status(500).json({ error: 'Auto-approve failed' });
  }
});

// POST /auto-execute
router.post('/auto-execute', requireAdmin, async (req, res) => {
  try {
    if (!req.body.domain) return res.status(400).json({ error: 'domain is required' });
    const result = await SeoActionGenerator.autoExecute(req.body.domain);
    res.json(result);
  } catch (err) {
    logger.error('[seo-actions] auto-execute error', err);
    res.status(500).json({ error: 'Auto-execute failed' });
  }
});

// POST /measure-experiments
router.post('/measure-experiments', requireAdmin, async (req, res) => {
  try {
    const result = await SeoActionGenerator.measureExperiments();
    res.json(result);
  } catch (err) {
    logger.error('[seo-actions] measure-experiments error', err);
    res.status(500).json({ error: 'Measurement failed' });
  }
});

module.exports = router;
