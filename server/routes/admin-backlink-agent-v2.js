const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return null; }
}

// GET /api/admin/backlink-agent/stats
router.get('/stats', async (req, res, next) => {
  try {
    const [total, pending, processing, completed, verified, failed, skipped] = await Promise.all([
      db('backlink_agent_queue').count('* as c').first(),
      db('backlink_agent_queue').where({ status: 'pending' }).count('* as c').first(),
      db('backlink_agent_queue').where({ status: 'processing' }).count('* as c').first(),
      db('backlink_agent_queue').where({ status: 'signup_complete' }).count('* as c').first(),
      db('backlink_agent_queue').where({ status: 'verified' }).count('* as c').first(),
      db('backlink_agent_queue').where({ status: 'failed' }).count('* as c').first(),
      db('backlink_agent_queue').where({ status: 'skipped' }).count('* as c').first(),
    ]);
    const profiles = await db('backlink_agent_profiles').count('* as c').first();

    res.json({
      total: parseInt(total.c), pending: parseInt(pending.c), processing: parseInt(processing.c),
      completed: parseInt(completed.c), verified: parseInt(verified.c),
      failed: parseInt(failed.c), skipped: parseInt(skipped.c),
      profiles: parseInt(profiles.c),
      successRate: parseInt(total.c) > 0 ? Math.round(((parseInt(completed.c) + parseInt(verified.c)) / parseInt(total.c)) * 100) : 0,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/backlink-agent/queue
router.get('/queue', async (req, res, next) => {
  try {
    const { status, source, page = 1, limit = 50 } = req.query;
    let query = db('backlink_agent_queue').orderBy('created_at', 'desc');
    if (status) query = query.where({ status });
    if (source) query = query.where({ source });
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const items = await query.limit(parseInt(limit)).offset(offset);
    res.json({ items });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/queue — add manual URLs
router.post('/queue', async (req, res, next) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'urls array required' });

    let added = 0, skipped = 0, duplicates = [];
    for (const rawUrl of urls) {
      const url = rawUrl.trim();
      if (!url) continue;
      const domain = extractDomain(url);
      if (!domain) { skipped++; continue; }

      const exists = await db('backlink_agent_queue').where({ domain }).first();
      if (exists) { duplicates.push(domain); skipped++; continue; }

      await db('backlink_agent_queue').insert({ url, original_url: url, source: 'manual', domain });
      added++;
    }

    res.json({ added, skipped, duplicates });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/queue/:id/retry
router.post('/queue/:id/retry', async (req, res, next) => {
  try {
    await db('backlink_agent_queue').where({ id: req.params.id }).update({ status: 'pending', error_message: null, updated_at: new Date() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/queue/:id/skip
router.post('/queue/:id/skip', async (req, res, next) => {
  try {
    await db('backlink_agent_queue').where({ id: req.params.id }).update({ status: 'skipped', updated_at: new Date() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/process — trigger worker
router.post('/process', async (req, res, next) => {
  try {
    const { limit = 3 } = req.body;
    const SignupWorker = require('../services/backlink-agent/signup-worker');
    // Run async — don't block the response
    SignupWorker.processQueue(parseInt(limit)).then(result => {
      logger.info(`[backlink-agent] Queue processing done: ${JSON.stringify(result)}`);
    }).catch(err => {
      logger.error(`[backlink-agent] Queue processing failed: ${err.message}`);
    });
    res.json({ started: true, message: `Processing up to ${limit} items in background` });
  } catch (err) { next(err); }
});

// GET /api/admin/backlink-agent/profiles
router.get('/profiles', async (req, res, next) => {
  try {
    const profiles = await db('backlink_agent_profiles')
      .leftJoin('backlink_agent_queue', 'backlink_agent_profiles.queue_id', 'backlink_agent_queue.id')
      .select('backlink_agent_profiles.*', 'backlink_agent_queue.domain', 'backlink_agent_queue.status as queue_status')
      .orderBy('backlink_agent_profiles.created_at', 'desc');
    res.json({ profiles });
  } catch (err) { next(err); }
});

// =========================================================================
// X TARGETS
// =========================================================================
router.get('/targets', async (req, res, next) => {
  try {
    const targets = await db('backlink_agent_targets').orderBy('created_at', 'desc');
    res.json({ targets });
  } catch (err) { next(err); }
});

router.post('/targets', async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const clean = username.replace('@', '').trim();
    const [target] = await db('backlink_agent_targets').insert({ x_username: clean }).returning('*');
    res.json({ target });
  } catch (err) { next(err); }
});

router.delete('/targets/:id', async (req, res, next) => {
  try {
    await db('backlink_agent_targets').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/poll — trigger X feed poll
router.post('/poll', async (req, res, next) => {
  try {
    const XPoller = require('../services/backlink-agent/x-poller');
    const result = await XPoller.pollAllTargets();
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/verify-emails — trigger email check
router.post('/verify-emails', async (req, res, next) => {
  try {
    const EmailVerifier = require('../services/backlink-agent/email-verifier');
    const result = await EmailVerifier.checkVerificationEmails();
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// STRATEGY AGENT — Managed Agent autonomous backlink strategy
// =========================================================================

// POST /api/admin/backlink-agent/strategy/run — run the weekly strategy cycle
router.post('/strategy/run', async (req, res, next) => {
  try {
    const BacklinkStrategyAgent = require('../services/seo/backlink-strategy-agent');
    const { competitors, skipScan, skipLLM, focus } = req.body;

    const runPromise = BacklinkStrategyAgent.run({
      competitors: competitors || undefined,
      skipScan: skipScan || false,
      skipLLM: skipLLM || false,
      focus: focus || undefined,
    });

    if (req.query.wait === 'true') {
      const result = await runPromise;
      return res.json(result);
    }

    runPromise
      .then(result => logger.info(`[backlink-strategy] Completed: ${result.targetsAdded} targets, ${result.gapsFound} gaps, ${result.durationSeconds}s`))
      .catch(err => logger.error(`[backlink-strategy] Failed: ${err.message}`));

    res.json({
      status: 'started',
      message: 'Backlink strategy agent running. Check /api/admin/backlink-agent/strategy/reports for results.',
    });
  } catch (err) { next(err); }
});

// GET /api/admin/backlink-agent/strategy/reports — strategy report history
router.get('/strategy/reports', async (req, res, next) => {
  try {
    const { limit = 10 } = req.query;
    const reports = await db('backlink_strategy_reports')
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit));
    res.json({ reports });
  } catch (err) { next(err); }
});

module.exports = router;
