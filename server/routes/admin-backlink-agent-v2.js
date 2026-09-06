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
const linkPolicy = require('../services/seo/link-authority-policy');
const { REGISTRY_ACTIONS, applyRegistryAction } = require('../services/seo/link-registry');
const ownerQueue = require('../services/seo/link-owner-queue');
const M = require('../services/seo/link-outreach-mandate');

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

    // Every opportunity that enters the legacy signup queue ALSO enters the
    // registry (plan v2 §4 step 2: one intake, never two pipelines) — same
    // dedupe/never-target rules, references parked for the resolver sweep.
    const registryIntake = await linkIntake.intake(db, { text: urls.join('\n'), source: 'list_import', sourceDetail: `legacy_queue_add:${etDateString()}` });

    res.json({ added, skipped, duplicates, registry: { inserted: registryIntake.inserted, existing: registryIntake.existing, pending: registryIntake.items.pending } });
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

// POST /api/admin/backlink-agent/opportunities/bulk — intake (plan v2 §4, step 2):
// normalize → persist every reference as an intake item → dedupe → upsert
// registry domains + touches. Accepts a pasted list, free text, or a CSV with a
// website/domain/url column (CSV upload = same endpoint, §11). References
// (X posts, shortener links) stay pending for the resolver sweep. dryRun
// reports only. Investigation queueing is the investigator's (step 3).
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

// GET /api/admin/backlink-agent/intake-items — durable references (§3.4d): what
// was fed, what resolved, what is waiting or dropped and why.
const INTAKE_ITEM_STATES = Object.freeze(['pending', 'unresolved', 'resolved', 'dropped']);
router.get('/intake-items', async (req, res, next) => {
  try {
    const { state, source, q, page = 1, limit = 100 } = req.query;
    if (state && !INTAKE_ITEM_STATES.includes(state)) return res.status(400).json({ error: `invalid state; must be one of ${INTAKE_ITEM_STATES.join(', ')}` });
    let query = db('seo_link_intake_items');
    if (state) query = query.where({ state });
    if (source) query = query.where({ source });
    if (q) query = query.where((b) => b.whereILike('raw_url', `%${q}%`).orWhereILike('resolved_host', `%${q}%`));
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const [items, counts] = await Promise.all([
      query.clone().orderBy('last_seen_at', 'desc').limit(lim).offset(offset),
      db('seo_link_intake_items').select('state').count('* as c').groupBy('state'),
    ]);
    res.json({ items, counts: Object.fromEntries(counts.map((r) => [r.state, Number(r.c)])) });
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/registry/jobs/:job — run one step-2 job now
// (the scheduler runs the same services on its own cadence). Bounded per call;
// dryRun supported everywhere. `enrich` spends DataForSEO credits and is gated
// by GATE_SEO_INTELLIGENCE inside the service (reports `gated: true` when off).
const REGISTRY_JOBS = Object.freeze({
  resolve: (opts) => require('../services/seo/link-registry-intake').resolveIntakeItems(db, { limit: opts.limit || 50, dryRun: opts.dryRun }),
  baseline: async (opts) => {
    const run = () => require('../services/seo/link-registry-baseline').importExistingBacklinks(db, { dryRun: opts.dryRun, limit: opts.limit || null });
    if (opts.dryRun) return run();
    // Same lease the Sunday feeders take: never import while a backlink scan is
    // still transitioning rows. A held lease is reported, not queued.
    const r = await require('../utils/cron-lock').runExclusive('backlink-scan', run, { recordHealth: false });
    return r && r.skipped ? { skipped: r.reason || 'lease_held' } : r;
  },
  gap: (opts) => require('../services/seo/link-registry-gap-ingest').ingestCompetitorGap(db, { dryRun: opts.dryRun, limit: opts.limit || null }),
  enrich: (opts) => require('../services/seo/link-registry-enrich').enrichDomains(db, { dryRun: opts.dryRun, limit: opts.limit || 200, force: opts.force === true }),
  // Step 3: fetches + one WORKHORSE call per domain; gated by
  // GATE_LINK_INVESTIGATOR inside the service (reports `gated: true` when off).
  // A LIVE run can hold a request open for many minutes (per domain: up to 8
  // page fetches + a 60s model call + retries), so it is started in the
  // background and the response returns immediately — the service's own
  // session lock serializes runs (a second click reports the held lease via
  // the next run's `skipped`), and the summary lands in the server log.
  // dryRun and the gated case are fast and stay synchronous.
  investigate: async (opts) => {
    const svc = require('../services/seo/link-path-investigator');
    const args = { dryRun: opts.dryRun, ...(opts.limit ? { limit: opts.limit } : {}) };
    if (opts.dryRun || !isEnabled('linkInvestigator')) return svc.investigatePaths(db, args);
    // Probe the lease BEFORE reporting startup: a held lease means no work
    // will run, and the operator must not read "started" off a no-op. (The
    // probe races the background acquire by design — a lease taken in the
    // gap still lands as a logged skip, never a false failure.) A probe that
    // could not run (null: pool exhausted, DB blip) is NOT a free lease — the
    // detached run would fail the same way with only a log to show for it,
    // so report it as not started and let the operator retry.
    const held = await require('../utils/cron-lock').isLocked(svc.LOCK_KEY);
    if (held === null) return { started: false, skipped: 'probe_failed' };
    if (held) return { started: false, skipped: 'lease_held' };
    void svc.investigatePaths(db, args)
      .then((r) => logger.info(`[link-investigator] admin run: ${r.skipped ? `SKIPPED (${r.skipped}) ` : ''}selected ${r.selected} investigated ${r.investigated} (qualified ${r.qualified} watching ${r.watching} not_reproducible ${r.notReproducible} refreshes ${r.pathRefreshes}) paths ${r.pathsWritten} failed ${r.failed.length} fetches ${r.fetches} llm ${r.llmCalls}`))
      .catch((err) => logger.error(`[link-investigator] admin run failed: ${err.message}`));
    return Promise.resolve({ started: true });
  },
  // Step 4 (PR 2a): the authority bridge — decisions + parks only, no network,
  // fast enough to run inline. Gated by GATE_LINK_AUTHORITY inside the service
  // (reports `gated: true` when off); a held lease reports `skipped`.
  authority: (opts) => require('../services/seo/link-authority-bridge').runAuthorityBridge(db, { dryRun: opts.dryRun, ...(opts.limit ? { limit: opts.limit } : {}) }),
});
router.post('/registry/jobs/:job', async (req, res, next) => {
  try {
    const run = REGISTRY_JOBS[req.params.job];
    if (!run) return res.status(404).json({ error: `unknown job; must be one of ${Object.keys(REGISTRY_JOBS).join(', ')}` });
    const { dryRun, limit, force } = req.body || {};
    const lim = limit == null ? null : Math.min(Math.max(parseInt(limit, 10) || 0, 1), 1000);
    const result = await run({ dryRun: dryRun === true || dryRun === 'true', limit: lim, force });
    res.json({ job: req.params.job, ...result });
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
    // Best-path summary for the Registry table (§11: type · cost · expected rel).
    const bestIds = items.map((d) => d.best_path_id).filter(Boolean);
    if (bestIds.length) {
      const paths = await db('seo_link_acquisition_paths').whereIn('id', bestIds)
        .select('id', 'acquisition_type', 'submission_url', 'estimated_cost_cents', 'currency', 'expected_rel', 'confidence', 'payment_required');
      const byId = new Map(paths.map((p) => [p.id, p]));
      for (const d of items) d.best_path = byId.get(d.best_path_id) || null;
    }
    // Acquire anyway applies only to a rejected domain whose best path fails a quality floor NOW — the row says so
    // (`waivable`) so the button never offers a click the service refuses with 409
    const rejected = items.filter((d) => d.agent_state === 'rejected' && d.best_path_id);
    if (rejected.length) {
      const { policy } = await linkPolicy.loadPolicy(db);
      const full = await db('seo_link_acquisition_paths').whereIn('id', rejected.map((d) => d.best_path_id));
      const fullById = new Map(full.map((p) => [p.id, p]));
      for (const d of rejected) d.waivable = ownerQueue.waivableFloors(fullById.get(d.best_path_id) || null, d, policy).length > 0;
    }
    res.json({ items });
  } catch (err) { next(err); }
});

// GET /api/admin/backlink-agent/registry/:id — one domain: active paths first,
// provenance touches, placements summary (Registry row expand, §11).
router.get('/registry/:id', async (req, res, next) => {
  try {
    const domain = await db('seo_link_domains').where({ id: req.params.id }).first();
    if (!domain) return res.status(404).json({ error: 'not found' });
    const [paths, touches, placements] = await Promise.all([
      db('seo_link_acquisition_paths').where({ domain_id: domain.id })
        .orderByRaw('CASE WHEN superseded_by IS NULL THEN 0 ELSE 1 END').orderBy('updated_at', 'desc'),
      db('seo_link_domain_sources').where({ domain_id: domain.id }).orderBy('seen_at', 'asc'),
      db('seo_link_prospects').where({ domain_id: domain.id }).select('id', 'status', 'target_page', 'location_key', 'link_type', 'live_url'),
    ]);
    // Attempt history (§11: the drilldown audits what previous attempts did).
    // Attempts key on path/prospect, not domain — collect via both.
    const pathIds = paths.map((p) => p.id);
    const prospectIds = placements.map((pl) => pl.id);
    const attempts = (pathIds.length || prospectIds.length)
      ? await db('seo_link_attempts')
        .where((b) => {
          if (pathIds.length) b.orWhereIn('path_id', pathIds);
          if (prospectIds.length) b.orWhereIn('prospect_id', prospectIds);
        })
        .orderBy('created_at', 'desc').limit(50)
        .select('id', 'path_id', 'prospect_id', 'provider', 'action', 'outcome', 'cost_cents', 'sandbox', 'evidence_url', 'created_at')
      : [];
    // the owner's active "Acquire anyway" waiver on the best path (step 4 PR 2b) — shown only while the bridge
    // would still honour it: its floors hash must equal the CURRENT floors (a moved score / spam / confidence /
    // policy floor makes it stale until the next run invalidates it)
    let waiver = null;
    const bestPath = domain.best_path_id ? paths.find((p) => p.id === domain.best_path_id) : null;
    if (bestPath) {
      const w = await db('seo_link_floor_waivers').where({ domain_id: domain.id, path_id: bestPath.id }).whereNull('invalidated_at').orderBy('approved_at', 'desc')
        .first('id', 'overridden_floors', 'decision_inputs_hash', 'note', 'approved_by', 'approved_at');
      if (w) {
        const { policy } = await linkPolicy.loadPolicy(db);
        if (w.decision_inputs_hash === linkPolicy.floorInputsHash({ path: bestPath, domain, policy, score: domain.score })) waiver = w;
      }
    }
    res.json({ domain, paths, touches, placements, attempts, waiver });
  } catch (err) { next(err); }
});

// PATCH /api/admin/backlink-agent/registry/:id — owner registry actions (§11:
// Watch / Reject / Reopen). acquiring/acquired are lane-owned aggregates the
// investigator/bridge recompute — never hand-set; "Acquire anyway" is step 4
// (it needs a stamped authority, not a state flip).
const actorOf = (req) => (req.technician ? (req.technician.name || String(req.technician.id)) : null);
router.patch('/registry/:id', async (req, res, next) => {
  try {
    const { action, note = null } = req.body || {};
    const nextState = REGISTRY_ACTIONS[action];
    if (!nextState) return res.status(400).json({ error: `invalid action; must be one of ${Object.keys(REGISTRY_ACTIONS).join(', ')}` });
    const domain = await db('seo_link_domains').where({ id: req.params.id }).first('id', 'domain', 'agent_state', 'score_reasons');
    if (!domain) return res.status(404).json({ error: 'not found' });
    // Reject / Watch is the SAME decision the Owner-queue buttons make, whatever the state: ONE audited, attributed path
    // (decideDomain writes the per-row decision records, invalidates approvals and waivers, then the registry action) —
    // never a state-only sibling. A domain that left the queue (Reopen → investigating) can still carry approved rows.
    // Lane-owned states are refused by the service with the same 409. Reopen stays the plain action below.
    if (action === 'reject' || action === 'watch') {
      let r;
      try {
        r = await ownerQueue.decideDomain(db, { domainId: domain.id, decision: action === 'reject' ? 'rejected' : 'watch', actor: actorOf(req), note });
      } catch (err) {
        if (err instanceof ownerQueue.OwnerQueueError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
      logger.info(`[backlink-registry] ${actorOf(req)} ${action}: ${domain.domain} (${domain.agent_state} -> ${r.agent_state}; ${r.audited} row(s) audited)`);
      return res.json({ id: domain.id, domain: domain.domain, agent_state: r.agent_state, watch_recheck_at: r.watch_recheck_at, audited: r.audited });
    }
    // the ONE registry-action writer (link-registry.applyRegistryAction): the
    // patch, the lane-owned guard IN the update and the coverage reset are
    // shared with the Owner-queue cards
    const { updated: n, watchRecheckAt } = await db.transaction((trx) => applyRegistryAction(trx, domain, action, new Date()));
    if (!n) {
      const current = await db('seo_link_domains').where({ id: domain.id }).first('agent_state');
      if (!current) return res.status(404).json({ error: 'not found' });
      return res.status(409).json({ error: `agent_state '${current.agent_state}' is lane-owned; registry actions apply to pre-acquisition states only` });
    }
    logger.info(`[backlink-registry] admin ${action}: ${domain.domain} (${domain.agent_state} -> ${nextState})`);
    res.json({ id: domain.id, domain: domain.domain, agent_state: nextState, watch_recheck_at: watchRecheckAt });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// §11 items 2–3 / §3.6b / §6.3 1b — the Owner queue (step 4 PR 2b). The
// service is the only writer of seo_link_approvals / seo_link_floor_waivers;
// every click is attributed to the signed-in admin. Errors the service raises
// carry an HTTP status (400 / 404 / 409); anything else is a real failure.
// ---------------------------------------------------------------------------
const ownerQueueCall = (res, next, fn) => fn().then((r) => res.json(r)).catch((err) => {
  if (err instanceof ownerQueue.OwnerQueueError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.review ? { review: err.review } : {}) });
  return next(err);
});
// GET /api/admin/backlink-agent/owner-queue — one card per parked placement
router.get('/owner-queue', (req, res, next) => ownerQueueCall(res, next, async () => ({ ...(await ownerQueue.listOwnerQueue(db)), gateOn: isEnabled('linkAuthority') })));
// POST /api/admin/backlink-agent/owner-queue/rows/:id/approve — { approved_amount_cents?, note? }
router.post('/owner-queue/rows/:id/approve', (req, res, next) => ownerQueueCall(res, next, async () => {
  const { approved_amount_cents: cents = null, note = null } = req.body || {};
  const r = await ownerQueue.approveRow(db, { authorityId: req.params.id, actor: actorOf(req), approvedAmountCents: cents, note });
  logger.info(`[backlink-owner-queue] ${actorOf(req)} approved ${r.approval.dimension}/${r.approval.action} ${r.approval.instance_key} on ${r.attached.length} row(s); bridge ${r.bridge.gated ? 'gated' : r.bridge.skipped || `released ${r.bridge.released}`}`);
  return r;
}));
// POST …/owner-queue/domains/:id/reject | /watch — { note? }. Literal paths: the public-route scanner
// (tests/route-surface) must be able to prove what every mount exposes.
const decideDomainHandler = (decision) => (req, res, next) => ownerQueueCall(res, next, async () => {
  const r = await ownerQueue.decideDomain(db, { domainId: req.params.id, decision, actor: actorOf(req), note: (req.body || {}).note || null });
  logger.info(`[backlink-owner-queue] ${actorOf(req)} ${decision}: ${r.domain} → ${r.agent_state} (${r.audited} row(s) audited)`);
  return r;
});
// POST /api/admin/backlink-agent/owner-queue/rows/:id/send — { draft_hash, reviewed_lookup_hash? }. The click IS the send
// approval (§6.3 2c) of the draft the card DISPLAYED (draft_hash, §3.6b); requireAdmin like the board's send: it mails
// from the primary inbox.
router.post('/owner-queue/rows/:id/send', requireAdmin, (req, res, next) => ownerQueueCall(res, next, async () => {
  const { reviewed_lookup_hash: hash, draft_hash: draftHash } = req.body || {};
  const r = await ownerQueue.sendRow(db, { authorityId: req.params.id, actor: actorOf(req), reviewedLookupHash: typeof hash === 'string' ? hash : null, draftHash: typeof draftHash === 'string' ? draftHash : null });
  logger.info(`[backlink-owner-queue] ${actorOf(req)} sent the pitch for ${r.prospectId} (${r.authority ? r.authority.level : 'no authority row'})`);
  return r;
}));
router.post('/owner-queue/domains/:id/reject', decideDomainHandler('rejected'));
router.post('/owner-queue/domains/:id/watch', decideDomainHandler('watch'));
// POST /api/admin/backlink-agent/registry/:id/acquire-anyway — { note? } (a floor waiver, never an approval)
router.post('/registry/:id/acquire-anyway', (req, res, next) => ownerQueueCall(res, next, async () => {
  const r = await ownerQueue.acquireAnyway(db, { domainId: req.params.id, actor: actorOf(req), note: (req.body || {}).note || null });
  logger.info(`[backlink-owner-queue] ${actorOf(req)} acquire anyway: ${r.domain} waived ${r.floors.map((x) => x.floor).join(', ')}; bridge ${r.bridge.gated ? 'gated' : r.bridge.skipped || `parked ${r.bridge.parked}`}; ${r.awaiting} awaiting`);
  return r;
}));

// ---------------------------------------------------------------------------
// §3.8 / §6.2 / §11 item 4 — acquisition-authority policy (step 4a). The DB row
// is the only source of thresholds; env may only tighten (reported as
// `overrides`); every edit is audited. Nothing consumes the row until the
// step-4 bridge/claim PRs, and GATE_LINK_AUTHORITY is display-only here.
// ---------------------------------------------------------------------------
// GET /api/admin/backlink-agent/policy
router.get('/policy', async (req, res, next) => {
  try {
    const { stored, policy, overrides, updated_at, updated_by } = await linkPolicy.loadPolicy(db);
    const audit = await db('seo_link_policy_audit').orderBy('changed_at', 'desc').limit(25)
      .select('id', 'field', 'old_value', 'new_value', 'changed_by', 'changed_at');
    res.json({
      stored, policy, overrides, updated_at, updated_by, audit,
      fields: linkPolicy.POLICY_FIELDS,
      gateOn: isEnabled('linkAuthority'),
    });
  } catch (err) { next(err); }
});

// PATCH /api/admin/backlink-agent/policy — { field: value, ... }; whole patch
// rejected on any invalid field; changed fields audited.
router.patch('/policy', async (req, res, next) => {
  try {
    const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!patch || !Object.keys(patch).length) return res.status(400).json({ error: 'a non-empty object of policy fields is required' });
    const actor = req.technician ? (req.technician.name || String(req.technician.id)) : null;
    const r = await linkPolicy.updatePolicy(db, patch, { actor });
    if (r.errors) return res.status(400).json({ error: r.errors.join('; '), errors: r.errors });
    if (r.changed.length) logger.info(`[backlink-policy] ${actor || 'admin'} changed ${r.changed.map((c) => `${c.field}: ${c.old} -> ${c.new}`).join(', ')}`);
    const { policy, overrides } = await linkPolicy.loadPolicy(db);
    res.json({ changed: r.changed, stored: r.policy, policy, overrides });
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
router.post('/prospects/:id/reconcile-backlink', async (req, res, next) => {
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(req.params.id) || !uuid.test(req.body?.backlink_id || '')) return res.status(400).json({ error: 'valid placement and backlink ids required' });
    const result = await require('../utils/cron-lock').runExclusive('backlink-scan', () => require('../services/seo/link-prospect-verifier').reconcileOutreach({ ownerMatch: { prospectId: req.params.id.toLowerCase(), backlinkId: req.body.backlink_id.toLowerCase(), actorId: req.technician?.id || null } }), { recordHealth: false });
    if (!result.matched) return res.status(409).json({ error: 'This link no longer matches an available outreach placement. Refresh the queue.' });
    res.json(result);
  } catch (err) { next(err); }
});

router.patch('/prospects/:id', async (req, res, next) => {
  try {
    const allowed = ['status', 'priority', 'link_type', 'anchor_planned', 'live_url', 'target_page', 'target_url', 'domain_rating', 'owner', 'notes', 'placement_date'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ('status' in patch && !PROSPECT_STATUSES.includes(patch.status)) {
      return res.status(400).json({ error: `invalid status; must be one of ${PROSPECT_STATUSES.join(', ')}` });
    }
    const verdict = req.body.submission_verdict;
    const negativeVerdict = verdict === 'not_submitted';
    if (verdict !== undefined) {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!['not_submitted', 'placed'].includes(verdict) || !uuid.test(req.body.submission_attempt_id || '')
        || Object.keys(patch).some((key) => key !== 'live_url') || (negativeVerdict && 'live_url' in patch)) {
        return res.status(400).json({ error: 'A submission verdict requires its attempt id and no unrelated board edits' });
      }
      if (!negativeVerdict) {
        let url;
        try { url = new URL(patch.live_url); } catch { return res.status(400).json({ error: 'A confirmed publisher URL is required' }); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return res.status(400).json({ error: 'A valid publisher URL is required' });
        patch.status = 'placed';
      }
    }
    if (!negativeVerdict && Object.keys(patch).length === 0) return res.status(400).json({ error: 'no editable fields supplied' });
    patch.updated_at = new Date();
    // A status edit that REOPENS a row into active outreach (lost/rejected/
    // placed/live/indexed → prospect/contacted/negotiating) is a board
    // admission like an insert: it goes through the same per-domain guard
    // (prospect-domain-lock) and is refused while another row for the domain is
    // already in active outreach — otherwise both are claimable by the worker.
    const result = await db.transaction(async (trx) => {
      const current = await trx('seo_link_prospects').where({ id: req.params.id }).first('id', 'status', 'target_domain', 'target_page', 'live_url', 'link_type', 'location_key', 'parked_from_status', 'outreach_status', 'follow_up_status', 'follow_up_due_at', 'conversation_closed_at', 'path_id');
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
      // a status edit INTO the active outreach lifecycle (prospect / contacted / negotiating / awaiting_owner) — a reopen
      // from lost / rejected above all — drops the closure stamp with it: conversationClosed (the §13 inbox guard) would
      // otherwise keep reading the live row as closed and free its inbox to a second conversation; lost-link recovery
      // clears it the same way. The clear is tied to the edits that REOPEN: a status edit into the active lifecycle, or
      // the row entering the outreach lane (a link_type edit alone, the status already active) — never an unrelated
      // edit (notes, a page move) on a row that carries the stamp.
      const resultStatus = 'status' in patch ? patch.status : current.status;
      if (ACTIVE_OUTREACH_STATUSES.includes(resultStatus) && ('status' in patch || entersOutreach)) patch.conversation_closed_at = null;
      // a CLOSED conversation reopened by that edit (the stamp dropped on a row that was already in the active set, so
      // entersOutreach did not run the probe) is a board admission too: the closure released the domain to a later
      // placement, and two conversations for one publisher must not become active — the same per-domain admission probe
      // (the probe ignores closure-stamped rows, so the row being reopened is not its own conflict)
      if (patch.conversation_closed_at === null && current.conversation_closed_at && !entersOutreach) {
        const { inFlight } = await claimProspectDomain(trx, current.target_domain);
        if (inFlight && inFlight.id !== current.id) return { inFlight };
      }
      // an edit whose RESULT is an open conversation (§13: contacted / negotiating, a park from them, or a sent pitch
      // on a row the reopen above just made active again) while the current row is not one OPENS it for the
      // recipient: the same recipient-level lock + predicate the send claim takes, so no two writers open the same inbox
      const Outreach = require('../services/seo/link-prospect-outreach');
      // the predicate is path-aware (a submit-first row's follow-up is owed past its outcome): the row's path rides along
      const currentPath = current.path_id ? await trx('seo_link_acquisition_paths').where({ id: current.path_id }).first('id', 'execution_after_send', 'acquisition_type', 'account_required') : null;
      const opensConversation = Outreach.conversationOpen({ ...current, ...patch }, currentPath) && !Outreach.conversationOpen(current, currentPath);
      if (opensConversation) {
        // the same lock ORDER as the send claim (domain → inbox advisory lock → row lock) for EVERY conversation-opening
        // edit, not only a board admission — a page move below re-takes the domain lock, which must never follow the
        // inbox lock; the recipient read before the locks is re-read under the row lock — re-addressed meanwhile means
        // the inbox locked is not this row's; refuse
        await lockProspectDomain(trx, current.target_domain);
        const before = await trx('seo_link_prospects').where({ id: current.id }).first('outreach_to_email');
        const recipient = before && before.outreach_to_email;
        if (recipient) {
          const open = await Outreach.inboxConflict(trx, { recipient, excludeId: current.id });
          if (open) return { inbox: open };
        }
        // the row lock + re-read for EVERY conversation-opening edit, an empty recipient included: a draft saved between
        // the read and the update would open the conversation with an address no inbox lock covers
        const locked = await trx('seo_link_prospects').where({ id: current.id }).forUpdate().first('outreach_to_email');
        if (!locked || M.normalizeEmail(locked.outreach_to_email) !== M.normalizeEmail(recipient)) return { readdressed: true };
      }
      // A target_page edit is a placement move: under the same domain lock,
      // refuse if another row already represents (domain, page) under ANY
      // spelling — a textual variant would slip past the unique key, an exact
      // one would 500 on it.
      if ('target_page' in patch && patch.target_page !== current.target_page) {
        await lockProspectDomain(trx, current.target_domain);
        // Placement identity is (target_domain, target_page, location_key) since
        // step 2 dropped the legacy 2-column key: the probe is scoped to the row's
        // OWN location ('-' included), so a Venice row may move onto a page a
        // Sarasota row already holds.
        const taken = await findPlacementRow(trx, current.target_domain, patch.target_page, { excludeId: current.id, location: current.location_key });
        if (taken) return { taken };
      }
      // Ordinary URL edits must not rewrite the evidence a held verdict compares.
      // Preserve domain → row lock order and re-read after acquiring the lock.
      if (verdict === undefined && 'live_url' in patch) {
        await lockProspectDomain(trx, current.target_domain);
        const locked = await trx('seo_link_prospects').where({ id: current.id }).forUpdate().first('live_url');
        const held = await trx('seo_link_attempts').where({ prospect_id: current.id, action: 'submit', outcome: 'submit_ambiguous' }).first('id');
        if (held && patch.live_url !== locked.live_url) return { reconciliationError: 'Resolve the held submission before changing its publisher URL' };
      }
      if (negativeVerdict || ['placed', 'live', 'indexed'].includes(patch.status)) {
        await lockProspectDomain(trx, current.target_domain);
        const confirmed = await require('../services/seo/link-execution-authority').reconcileOwnerPlacement(trx, { prospectId: current.id, status: patch.status, attemptId: req.body.submission_attempt_id || null, notSubmitted: negativeVerdict, liveUrl: patch.live_url || current.live_url, targetPage: patch.target_page, actorId: req.technician?.id || null });
        if (!confirmed.ok) return { reconciliationError: confirmed.error };
        if (verdict === 'placed') patch.status = confirmed.status;
        await require('../services/seo/link-registry').settleRetiredPlacements(trx, { prospectIds: [current.id] });
      }
      const [row] = await trx('seo_link_prospects').where({ id: req.params.id }).update(patch).returning('*');
      return { row };
    });
    if (result.missing) return res.status(404).json({ error: 'prospect not found' });
    if (result.reconciliationError) return res.status(409).json({ error: result.reconciliationError });
    if (result.inFlight) return res.status(409).json({ error: `domain already has a prospect in active outreach (${result.inFlight.status}${result.inFlight.target_page ? ` for ${result.inFlight.target_page}` : ''}) — one conversation per inbox`, id: result.inFlight.id });
    if (result.readdressed) return res.status(409).json({ error: 'the prospect was re-addressed while you edited it — reload and retry' });
    if (result.inbox) return res.status(409).json({ error: `another placement already has a conversation with this recipient (${result.inbox.status}${result.inbox.outreach_status ? ` / ${result.inbox.outreach_status}` : ''}) — one conversation per inbox`, id: result.inbox.id });
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
    // an open draft, or one the nightly bridge parked for the owner's send (awaiting_owner, PR 3a)
    const drafts = await orderByPriority(db('seo_link_prospects').where({ outreach_status: 'drafted' }));
    const pathIds = [...new Set(drafts.map((p) => p.path_id).filter(Boolean))];
    const pathById = new Map((pathIds.length ? await db('seo_link_acquisition_paths').whereIn('id', pathIds) : []).map((p) => [p.id, p]));
    // Submit-first placements keep their verified lifecycle while their initial pitch awaits approval.
    const { BRIDGE_STATES } = require('../services/seo/link-authority-selection');
    const domainIds = [...new Set(drafts.map((p) => p.domain_id).filter(Boolean))];
    const eligiblePaths = new Map((domainIds.length ? await db('seo_link_domains').whereIn('id', domainIds)
      .whereIn('agent_state', BRIDGE_STATES).select('id', 'best_path_id') : []).map((d) => [d.id, d.best_path_id]));
    const executions = drafts.length ? await db('seo_link_placement_authorities').whereIn('prospect_id', drafts.map((p) => p.id))
      .where({ dimension: 'execution', instance_kind: '-' }).whereNull('ended_at').select('prospect_id', 'path_id', 'satisfied_at') : [];
    const executionById = new Map(executions.map((r) => [r.prospect_id, r]));
    const items = drafts.filter((p) => Outreach.SENDABLE_STATUSES.includes(p.status)
      || (p.path_id && eligiblePaths.get(p.domain_id) === p.path_id && Outreach.lateSend(p, pathById.get(p.path_id))
        && !Outreach.submitStepOwed(pathById.get(p.path_id), executionById.get(p.id))));
    // Reconcilable = ambiguous sends: a send_error, OR a 'sending' stuck past the
    // stale window (a crashed mid-send) — both resolvable via reconcileSendError.
    // WHATEVER the lifecycle status reads: an ambiguous send holds its recipient's inbox until it is reconciled
    // (conversationOpen), so a row moved on by hand must stay in the one place the operator can settle it.
    const staleCutoff = new Date(Date.now() - Outreach.STALE_SENDING_MS);
    const needsReconcile = await orderByPriority(
      db('seo_link_prospects')
        .where((b) => b
          .where('outreach_status', 'send_error')
          .orWhere((s) => s.where('outreach_status', 'sending').andWhere('updated_at', '<', staleCutoff)))
    );
    // …and a FOLLOW-UP send in the same ambiguous states (§6.4) — settled by the same decision over its own columns;
    // aged from the follow-up's own attempt stamp (the verifier bumps updated_at on a Judge-owned placed / live row)
    const followUpReconcile = await orderByPriority(
      db('seo_link_prospects')
        .where((b) => b
          .where('follow_up_status', 'send_error')
          .orWhere((s) => s.where('follow_up_status', 'sending').andWhere('follow_up_attempted_at', '<', staleCutoff)))
    );
    for (const p of followUpReconcile) needsReconcile.push({ ...p, follow_up: true, outreach_subject: p.follow_up_subject });
    // …and a DRAFTED follow-up the automatic attempt routed to the owner on a marker (reply check failed, recipient review
    // required): sendable from the Owner queue while the cause is transient — and, when it is not (a thread deleted, a
    // match the owner declines), skippable HERE, the one terminal action (`outcome: 'skip'`); "It sent" / "Re-queue"
    // do not apply to it (the endpoint refuses them)
    // …or ANY drafted follow-up while the authority contract is off (nothing can send it — the skip is the one action)
    const unverifiable = await orderByPriority(
      isEnabled('linkAuthority')
        ? db('seo_link_prospects').where({ follow_up_status: 'drafted' }).whereIn('follow_up_skipped_reason', [...M.OWNER_MARKERS])
        : db('seo_link_prospects').where({ follow_up_status: 'drafted' })
    );
    for (const p of unverifiable) needsReconcile.push({ ...p, follow_up: true, unverifiable: true, outreach_subject: p.follow_up_subject });
    const sentToday = await Outreach.dailySendCount();
    // §6.4 / §13 — what the owner sees before Approve & send: the draft review and the recipient match to acknowledge
    let byEmail = null; let reviewError = null;
    try { byEmail = await M.reviewByEmail(db, items.map((p) => p.outreach_to_email)); } catch (err) { reviewError = err.message; } // one batch for the whole list
    // the click's bindings (§3.6b): the hash of the text THIS list displays (the click carries it back; the claim refuses
    // a draft edited since) — and the send's legal context on an attested path (the open communication row's level, the
    // agreement the owner reads before a send that attests to it), shown here as the Owner queue shows it
    const openRows = items.length ? await db('seo_link_placement_authorities').whereIn('prospect_id', items.map((p) => p.id)).where({ dimension: 'communication', instance_kind: '-' }).whereNull('ended_at').whereNull('satisfied_at').select('prospect_id', 'level') : [];
    const levelByProspect = new Map(openRows.map((r) => [r.prospect_id, r.level]));
    for (const p of items) {
      p.draft_hash = M.draftHash(p);
      p.authority_level = levelByProspect.get(p.id) || null;
      const path = pathById.get(p.path_id) || null;
      p.legal_attestation = Boolean(path && path.legal_attestation === true);
      p.legal_terms_url = p.legal_attestation ? ownerQueue.legalTermsUrlOf(path) : null;
      p.draft_review = M.draftReview(p);
      p.recipient_review = byEmail ? byEmail.get(p.outreach_to_email) || null : { kind: 'error', recipient: p.outreach_to_email, matched: [], lookup_hash: null, error: reviewError };
    }
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

// POST /api/admin/backlink-agent/prospects/:id/outreach/send — approve + send:
// { draft_hash, reviewed_lookup_hash? }. The authenticated operator call IS the
// approval click (design §9) of the draft the list DISPLAYED (draft_hash, §3.6b —
// required: the claim refuses a draft edited since). Sends only when the lane gate
// is on; rate-limited + idempotent (see link-prospect-outreach). requireAdmin:
// sending from the PRIMARY Waves inbox is admin-only — techs may draft (compose)
// but not approve+send.
router.post('/prospects/:id/outreach/send', requireAdmin, async (req, res, next) => {
  try {
    const { reviewed_lookup_hash: hash, draft_hash: draftHash } = req.body || {};
    if (typeof draftHash !== 'string' || !draftHash) return res.status(400).json({ ok: false, code: 'draft_hash_required', error: 'the hash of the draft the list displayed is required — reload and send again' });
    const Outreach = require('../services/seo/link-prospect-outreach');
    const result = await Outreach.sendOutreach({
      prospectId: req.params.id, approvedBy: actorOf(req) || 'admin', mode: 'owner', reviewedLookupHash: typeof hash === 'string' ? hash : null, draftHash,
    });
    if (!result.ok) {
      const status = ownerQueue.SEND_CODE_STATUS[result.code] || 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/backlink-agent/prospects/:id/outreach/reconcile — resolve a
// send_error (ambiguous Gmail failure) deliberately: { outcome: 'sent' | 'requeue' } — and, with follow_up: true,
// { outcome: 'skip' } settles a follow-up the owner has reviewed and will not send (§6.4).
// requireAdmin: it records/clears a primary-inbox send, same privilege as send.
router.post('/prospects/:id/outreach/reconcile', requireAdmin, async (req, res, next) => {
  try {
    const Outreach = require('../services/seo/link-prospect-outreach');
    const result = await Outreach.reconcileSendError({
      prospectId: req.params.id, outcome: req.body?.outcome, approvedBy: req.technician?.name || 'admin', followUp: req.body?.follow_up === true,
    });
    if (!result.ok) {
      const status = { not_found: 404, not_reconcilable: 409, not_requeueable: 409, send_in_flight: 409, bad_outcome: 400 }[result.code] || 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.PROSPECT_STATUSES = PROSPECT_STATUSES;
module.exports.PARKED_STATUSES = PARKED_STATUSES;
module.exports.INTAKE_SOURCES = INTAKE_SOURCES;
