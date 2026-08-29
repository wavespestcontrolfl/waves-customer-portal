const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { isEnabled } = require('../config/feature-gates');
const logger = require('../services/logger');
const { claimProspectDomain, lockProspectDomain, findPlacementRow, ACTIVE_OUTREACH_STATUSES } = require('../services/seo/prospect-domain-lock');
const linkIntake = require('../services/seo/link-registry-intake');
const { etDateString } = require('../utils/datetime-et');
const { SIGNUP_TYPES } = require('../services/seo/link-prospect-worker');

router.use(adminAuthenticate, requireAdmin);

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

// =========================================================================
// LINK PROSPECTS — outbound link-building board (Backlink Manager M1)
// =========================================================================

// The status contract (plan v2 §3.3). `awaiting_owner` = parked on an owner
// decision (payment / membership / legal); `watching` = unactionable today,
// rechecked. The worker's claim() leases only 'prospect', so neither is ever
// leased; both join the per-domain guard sets in prospect-domain-lock.
const PROSPECT_STATUSES = Object.freeze(['prospect', 'contacted', 'negotiating', 'placed', 'live', 'indexed', 'lost', 'rejected', 'awaiting_owner', 'watching']);
const PARKED_STATUSES = Object.freeze(['awaiting_owner', 'watching']);
// Sources the owner's paste box may stamp. Bulk lists are list_import; a seed
// the owner typed to be investigated first is owner_seed (§3.5).
const INTAKE_SOURCES = Object.freeze(['list_import', 'owner_seed']);

// POST /api/admin/backlink-agent/opportunities/bulk — intake skeleton (plan v2 §4, step 1):
// normalize → dedupe → upsert registry domains + touches. No resolvers, no
// enrichment, no investigation queueing yet (steps 2–3). dryRun reports only.
router.post('/opportunities/bulk', async (req, res, next) => {
  try {
    const { text, source = 'list_import', source_detail, dryRun } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text (domains, URLs, or a pasted list) is required' });
    if (text.length > 200000) return res.status(400).json({ error: 'text too large (200k chars max)' });
    if (!INTAKE_SOURCES.includes(source)) return res.status(400).json({ error: `invalid source; must be one of ${INTAKE_SOURCES.join(', ')}` });
    const detail = typeof source_detail === 'string' && source_detail.trim() ? source_detail.trim().slice(0, 200) : `paste:${etDateString()}`; // ET calendar day (Railway runs UTC)
    const result = await linkIntake.intake(db, { text, source, sourceDetail: detail, dryRun: dryRun === true || dryRun === 'true' });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/backlink-agent/registry — registry list (step 1: read-only view of what intake wrote)
router.get('/registry', async (req, res, next) => {
  try {
    const { agent_state, source, q, page = 1, limit = 100 } = req.query;
    let query = db('seo_link_domains');
    if (agent_state) query = query.where({ agent_state });
    if (source) query = query.where({ source });
    if (q) query = query.whereILike('domain', `%${q}%`);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const items = await query.clone()
      .orderByRaw("CASE discovery_priority WHEN 'owner_seed' THEN 0 ELSE 1 END") // owner seeds first (§3.5: investigate-first)
      .orderBy('created_at', 'desc').limit(lim).offset(offset);
    res.json({ items });
  } catch (err) { next(err); }
});

// GET /api/admin/backlink-agent/prospects — board list (filters + pagination)
router.get('/prospects', async (req, res, next) => {
  try {
    const { status, source, link_type, q, page = 1, limit = 100 } = req.query;
    let query = db('seo_link_prospects');
    if (status) query = query.where({ status });
    if (source) query = query.where({ source });
    if (link_type) query = query.where({ link_type });
    if (q) query = query.where((b) => b.whereILike('target_domain', `%${q}%`).orWhereILike('target_page', `%${q}%`));
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const items = await query.clone()
      .orderByRaw("CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END")
      .orderBy('domain_rating', 'desc')
      .limit(parseInt(limit)).offset(offset);
    res.json({ items });
  } catch (err) { next(err); }
});

// GET /api/admin/backlink-agent/prospects/stats — board KPIs
router.get('/prospects/stats', async (req, res, next) => {
  try {
    const rows = await db('seo_link_prospects').select('status').count('* as c').groupBy('status');
    const byStatus = {};
    rows.forEach((r) => { byStatus[r.status] = parseInt(r.c); });
    const live = byStatus.live || 0;
    const indexed = byStatus.indexed || 0;
    res.json({
      byStatus,
      total: rows.reduce((s, r) => s + parseInt(r.c), 0),
      indexingRate: (live + indexed) > 0 ? Math.round((indexed / (live + indexed)) * 100) : 0,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/prospects — manual add
router.post('/prospects', async (req, res, next) => {
  try {
    const { target_url, target_domain, target_page, anchor_planned, link_type, priority, notes, live_url } = req.body;
    const domain = target_domain || extractDomain(target_url) || extractDomain(live_url);
    if (!domain) return res.status(400).json({ error: 'target_domain, target_url, or live_url is required' });
    if (!target_page) return res.status(400).json({ error: 'target_page (our money page) is required' });

    // Admission through the shared per-domain guard (prospect-domain-lock, the
    // same one every board writer uses): lock, then refuse if the domain already
    // has a row in ACTIVE OUTREACH on any page / spelling (two claimable rows =
    // two emails to one inbox). A site that already links to us may be added
    // for another page. The exact-pair 409 is checked under the lock too.
    const result = await db.transaction(async (trx) => {
      const { inFlight } = await claimProspectDomain(trx, domain);
      if (inFlight) return { inFlight };
      // canonical placement lookup — any spelling of host or page
      const exists = await findPlacementRow(trx, domain, target_page);
      if (exists) return { exists };
      const [row] = await trx('seo_link_prospects').insert({
        target_domain: domain, target_url: target_url || null, target_page,
        anchor_planned: anchor_planned || null, link_type: link_type || null,
        priority: priority || null, notes: notes || null, source: 'manual', owner: req.technician?.name || 'admin',
        // If the admin supplies a live_url, the link is already placed — seed it so the
        // verifier sweep (which selects live_url IS NOT NULL) picks it up next run.
        live_url: live_url || null,
        ...(live_url ? { status: 'placed' } : {}),
      }).returning('*');
      return { row };
    });
    if (result.inFlight) return res.status(409).json({ error: `domain already has a prospect in active outreach (${result.inFlight.status}${result.inFlight.target_page ? ` for ${result.inFlight.target_page}` : ''}) — one conversation per inbox`, id: result.inFlight.id });
    if (result.exists) return res.status(409).json({ error: 'prospect already exists for this domain + target page', id: result.exists.id });
    res.json({ prospect: result.row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/backlink-agent/prospects/:id — edit
router.patch('/prospects/:id', async (req, res, next) => {
  try {
    const allowed = ['status', 'priority', 'link_type', 'anchor_planned', 'live_url', 'target_page', 'target_url', 'domain_rating', 'owner', 'notes', 'placement_date'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ('status' in patch && !PROSPECT_STATUSES.includes(patch.status)) {
      return res.status(400).json({ error: `invalid status; must be one of ${PROSPECT_STATUSES.join(', ')}` });
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no editable fields supplied' });
    patch.updated_at = new Date();
    // A status edit that REOPENS a row into active outreach (lost/rejected/
    // placed/live/indexed → prospect/contacted/negotiating) is a board
    // admission like an insert: it goes through the same per-domain guard
    // (prospect-domain-lock) and is refused while another row for the domain is
    // already in active outreach — otherwise both are claimable by the worker.
    const result = await db.transaction(async (trx) => {
      const current = await trx('seo_link_prospects').where({ id: req.params.id }).first('id', 'status', 'target_domain', 'target_page', 'link_type');
      if (!current) return { missing: true };
      // "In outreach" = active-outreach status AND an outreach-lane link_type:
      // a status flip OR a link_type change out of the signup lane can put a
      // row in front of the outreach worker, and either is a board admission.
      const inOutreach = (status, type) => ACTIVE_OUTREACH_STATUSES.includes(status) && !SIGNUP_TYPES.includes(type || '');
      const entersOutreach = inOutreach('status' in patch ? patch.status : current.status, 'link_type' in patch ? patch.link_type : current.link_type)
        && !inOutreach(current.status, current.link_type);
      if (entersOutreach) {
        const { inFlight } = await claimProspectDomain(trx, current.target_domain);
        if (inFlight && inFlight.id !== current.id) return { inFlight };
      }
      // A target_page edit is a placement move: under the same domain lock,
      // refuse if another row already represents (domain, page) under ANY
      // spelling — a textual variant would slip past the unique key, an exact
      // one would 500 on it.
      if ('target_page' in patch && patch.target_page !== current.target_page) {
        await lockProspectDomain(trx, current.target_domain);
        // Location-AGNOSTIC through the step-1 expand phase: UNIQUE(target_domain,
        // target_page) is still live, so a row at ANY location owns the page; step 2
        // (contract) scopes this probe to the row's own location_key.
        const taken = await findPlacementRow(trx, current.target_domain, patch.target_page, { excludeId: current.id });
        if (taken) return { taken };
      }
      const [row] = await trx('seo_link_prospects').where({ id: req.params.id }).update(patch).returning('*');
      return { row };
    });
    if (result.missing) return res.status(404).json({ error: 'prospect not found' });
    if (result.inFlight) return res.status(409).json({ error: `domain already has a prospect in active outreach (${result.inFlight.status}${result.inFlight.target_page ? ` for ${result.inFlight.target_page}` : ''}) — one conversation per inbox`, id: result.inFlight.id });
    if (result.taken) return res.status(409).json({ error: `another prospect already represents this domain + target page (${result.taken.status})`, id: result.taken.id });
    res.json({ prospect: result.row });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/prospects/:id/recheck — verify + index this one now
router.post('/prospects/:id/recheck', async (req, res, next) => {
  try {
    const prospect = await db('seo_link_prospects').where({ id: req.params.id }).first();
    if (!prospect) return res.status(404).json({ error: 'prospect not found' });
    if (!prospect.live_url) return res.status(400).json({ error: 'no live_url to check yet' });
    const Verifier = require('../services/seo/link-prospect-verifier');
    await Verifier.verifyOne(prospect);
    const verified = await db('seo_link_prospects').where({ id: req.params.id }).first();
    const Indexer = require('../services/seo/link-prospect-indexer');
    await Indexer.runOne(verified);
    const updated = await db('seo_link_prospects').where({ id: req.params.id }).first();
    res.json({ prospect: updated });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/prospects/verify — run the verifier sweep (background)
router.post('/prospects/verify', async (req, res, next) => {
  try {
    const { limit = 200 } = req.body;
    const Verifier = require('../services/seo/link-prospect-verifier');
    Verifier.run({ limit: parseInt(limit) })
      .then((r) => logger.info(`[link-verifier] manual run: ${JSON.stringify(r)}`))
      .catch((e) => logger.error(`[link-verifier] manual run failed: ${e.message}`));
    res.json({ started: true });
  } catch (err) { next(err); }
});

// =========================================================================
// OUTREACH — approval-gated editorial outreach send (Backlink Manager M3b)
// =========================================================================

// GET /api/admin/backlink-agent/prospects/outreach/pending — drafts awaiting approval,
// plus send_error rows needing reconciliation (ambiguous Gmail failures).
router.get('/prospects/outreach/pending', async (req, res, next) => {
  try {
    const orderByPriority = (q) => q
      .orderByRaw("CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END")
      .orderBy('updated_at', 'desc');
    const Outreach = require('../services/seo/link-prospect-outreach');
    const items = await orderByPriority(
      db('seo_link_prospects').where({ outreach_status: 'drafted', status: 'prospect' })
    );
    // Reconcilable = ambiguous sends: a send_error, OR a 'sending' stuck past the
    // stale window (a crashed mid-send) — both resolvable via reconcileSendError.
    const staleCutoff = new Date(Date.now() - Outreach.STALE_SENDING_MS);
    const needsReconcile = await orderByPriority(
      db('seo_link_prospects')
        .where({ status: 'prospect' })
        .where((b) => b
          .where('outreach_status', 'send_error')
          .orWhere((s) => s.where('outreach_status', 'sending').andWhere('updated_at', '<', staleCutoff)))
    );
    const sentToday = await Outreach.dailySendCount();
    res.json({
      items,
      needsReconcile,
      gateOn: isEnabled('linkProspectOutreach'),
      rateLimit: { sentToday, cap: Outreach.dailyCap() },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/prospects/:id/outreach/draft — save/update a draft
router.post('/prospects/:id/outreach/draft', async (req, res, next) => {
  try {
    const { to, subject, body } = req.body || {};
    const Outreach = require('../services/seo/link-prospect-outreach');
    const result = await Outreach.saveDraft({
      prospectId: req.params.id, to, subject, body, owner: req.technician?.name || 'admin',
    });
    if (!result.ok) {
      const status = { not_found: 404, send_in_flight: 409, not_actionable: 409, needs_reconcile: 409 }[result.code] || 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/prospects/:id/outreach/send — approve + send.
// The authenticated operator call IS the approval click (design §9). Sends only
// when the lane gate is on; rate-limited + idempotent (see link-prospect-outreach).
// requireAdmin: sending from the PRIMARY Waves inbox is admin-only — techs may draft
// (compose) but not approve+send.
router.post('/prospects/:id/outreach/send', requireAdmin, async (req, res, next) => {
  try {
    const Outreach = require('../services/seo/link-prospect-outreach');
    const result = await Outreach.sendOutreach({
      prospectId: req.params.id, approvedBy: req.technician?.name || 'admin',
    });
    if (!result.ok) {
      const status = {
        not_found: 404, gate_off: 403, gmail_not_connected: 503, rate_limited: 429,
        already_sent: 409, not_actionable: 409, send_failed: 502, finalize_failed: 500,
      }[result.code] || 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/prospects/:id/outreach/reconcile — resolve a
// send_error (ambiguous Gmail failure) deliberately: { outcome: 'sent' | 'requeue' }.
// requireAdmin: it records/clears a primary-inbox send, same privilege as send.
router.post('/prospects/:id/outreach/reconcile', requireAdmin, async (req, res, next) => {
  try {
    const Outreach = require('../services/seo/link-prospect-outreach');
    const result = await Outreach.reconcileSendError({
      prospectId: req.params.id, outcome: req.body?.outcome, approvedBy: req.technician?.name || 'admin',
    });
    if (!result.ok) {
      const status = { not_found: 404, not_reconcilable: 409, send_in_flight: 409 }[result.code] || 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.PROSPECT_STATUSES = PROSPECT_STATUSES;
module.exports.PARKED_STATUSES = PARKED_STATUSES;
module.exports.INTAKE_SOURCES = INTAKE_SOURCES;
