const cron = require('node-cron');
const db = require('../models/db');
const TwilioService = require('./twilio');
const logger = require('./logger');
const { etDateString, addETDays, etParts, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isEnabled } = require('../config/feature-gates');
const { runExclusive } = require('../utils/cron-lock');

const SCHEDULED_SMS_CLAIM_LIMIT = 20;
const SCHEDULED_SMS_STALE_CLAIM_MS = 30 * 60 * 1000;
const SCHEDULED_SMS_MAX_ATTEMPTS = 3;
const SCHEDULED_ESTIMATE_CLAIM_LIMIT = 20;
const SCHEDULED_ESTIMATE_STALE_CLAIM_MS = 30 * 60 * 1000;
const SCHEDULED_ESTIMATE_MAX_ATTEMPTS = 3;
const SCHEDULED_ESTIMATE_RETRY_DELAY_MS = 5 * 60 * 1000;
const CONTENT_REGISTRY_LIVE_STATUSES = ['matched', 'db_changed_since_sync', 'conflict', 'db_published_missing_astro'];
const CONTENT_REGISTRY_LIVE_LIMIT = 300;

function purposeForScheduledMessageType(messageType) {
  const type = String(messageType || '').toLowerCase();
  if (type.includes('billing') || type.includes('payment') || type.includes('invoice')) return 'billing';
  if (type.includes('review')) return 'review_request';
  if (type.includes('referral')) return 'referral';
  if (type.includes('retention') || type.includes('renewal') || type.includes('save')) return 'retention';
  if (type.includes('marketing') || type.includes('seasonal') || type.includes('promo')) return 'marketing';
  if (type.includes('appointment') || type.includes('reminder') || type.includes('confirmation') || type.includes('en_route')) return 'appointment';
  return 'conversational';
}

function scheduledSmsAttemptSql() {
  return `
    CASE
      WHEN COALESCE(metadata->>'scheduled_sms_attempts', '') ~ '^[0-9]+$'
        THEN (metadata->>'scheduled_sms_attempts')::int
      ELSE 0
    END
  `;
}

async function recoverStaleScheduledSmsClaims(now) {
  const staleBefore = new Date(now.getTime() - SCHEDULED_SMS_STALE_CLAIM_MS);
  const attemptsSql = scheduledSmsAttemptSql();
  const result = await db.raw(`
    UPDATE sms_log
    SET status = CASE
          WHEN ${attemptsSql} >= ? THEN 'failed'
          ELSE 'scheduled'
        END,
        updated_at = ?,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'scheduled_sms_recovered_at', ?::timestamptz
        )
    WHERE status = 'sending'
      AND scheduled_for IS NOT NULL
      AND scheduled_for <= ?
      AND updated_at <= ?
    RETURNING status, metadata
  `, [SCHEDULED_SMS_MAX_ATTEMPTS, now, now, now, staleBefore]);

  const recovered = result.rows || [];
  if (recovered.length > 0) {
    const retryCount = recovered.filter(row => row.status === 'scheduled').length;
    const failedCount = recovered.filter(row => row.status === 'failed').length;
    logger.warn(`[scheduled-sms] Recovered ${recovered.length} stale claim(s): ${retryCount} retried, ${failedCount} failed`);

    // Rows that exhausted their attempts will never send — any Agent Review
    // decisions parked behind them must return to the composer now, not
    // after the 48h expiry sweep. Retried rows keep their decisions parked.
    const decisionIds = [];
    for (const row of recovered) {
      if (row.status !== 'failed') continue;
      let meta = row.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      meta = meta || {};
      if (meta.agent_decision_id) decisionIds.push(meta.agent_decision_id);
      if (Array.isArray(meta.parked_decision_ids)) decisionIds.push(...meta.parked_decision_ids);
    }
    if (decisionIds.length) {
      await require('./sms-suggest-mode').reopenScheduledSuggestions({
        decisionIds,
        reason: 'Scheduled send failed after repeated claim timeouts — suggestion reopened.',
      });
    }
  }
}

async function claimDueScheduledSms(now) {
  const result = await db.raw(`
    WITH due AS (
      SELECT id
      FROM sms_log
      WHERE status = 'scheduled'
        AND scheduled_for IS NOT NULL
        AND scheduled_for <= ?
      ORDER BY scheduled_for ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ?
    )
    UPDATE sms_log AS s
    SET status = 'sending',
        updated_at = ?,
        metadata = COALESCE(s.metadata, '{}'::jsonb) || jsonb_build_object(
          'scheduled_sms_claimed_at', ?::timestamptz,
          'scheduled_sms_attempts',
          CASE
            WHEN COALESCE(s.metadata->>'scheduled_sms_attempts', '') ~ '^[0-9]+$'
              THEN (s.metadata->>'scheduled_sms_attempts')::int + 1
            ELSE 1
          END
        )
    FROM due
    WHERE s.id = due.id
    RETURNING s.*
  `, [now, SCHEDULED_SMS_CLAIM_LIMIT, now, now]);

  return result.rows || [];
}

async function recoverStaleScheduledEstimateClaims(now) {
  const staleBefore = new Date(now.getTime() - SCHEDULED_ESTIMATE_STALE_CLAIM_MS);
  const result = await db.raw(`
    UPDATE estimates
    SET status = CASE
          WHEN COALESCE(scheduled_send_attempts, 0) >= ? THEN 'send_failed'
          ELSE 'scheduled'
        END,
        last_send_error = COALESCE(last_send_error, 'Scheduled estimate send claim timed out'),
        updated_at = ?
    WHERE status = 'sending'
      AND scheduled_at IS NOT NULL
      AND updated_at <= ?
    RETURNING status
  `, [SCHEDULED_ESTIMATE_MAX_ATTEMPTS, now, staleBefore]);

  const recovered = result.rows || [];
  if (recovered.length > 0) {
    const retryCount = recovered.filter(row => row.status === 'scheduled').length;
    const failedCount = recovered.filter(row => row.status === 'send_failed').length;
    logger.warn(`[scheduled-estimates] Recovered ${recovered.length} stale claim(s): ${retryCount} retried, ${failedCount} failed`);
  }
}

async function claimDueScheduledEstimates(now) {
  const result = await db.raw(`
    WITH due AS (
      SELECT id
      FROM estimates
      WHERE status = 'scheduled'
        AND scheduled_at IS NOT NULL
        AND scheduled_at <= ?
      ORDER BY scheduled_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ?
    )
    UPDATE estimates AS e
    SET status = 'sending',
        scheduled_send_attempts = COALESCE(e.scheduled_send_attempts, 0) + 1,
        last_send_error = NULL,
        updated_at = ?
    FROM due
    WHERE e.id = due.id
    RETURNING e.*
  `, [now, SCHEDULED_ESTIMATE_CLAIM_LIMIT, now]);

  return result.rows || [];
}

async function markScheduledEstimateSendFailure(est, errorMessage, { retry = false, now = new Date() } = {}) {
  const attempts = Number(est.scheduled_send_attempts || 0);
  const shouldRetry = retry && attempts < SCHEDULED_ESTIMATE_MAX_ATTEMPTS;
  await db('estimates')
    .where({ id: est.id, status: 'sending' })
    .update({
      status: shouldRetry ? 'scheduled' : 'send_failed',
      scheduled_at: shouldRetry ? new Date(now.getTime() + SCHEDULED_ESTIMATE_RETRY_DELAY_MS) : null,
      last_send_error: String(errorMessage || 'Scheduled estimate send failed').slice(0, 1000),
      updated_at: db.fn.now(),
    });
}

function parseListEnv(value, fallback) {
  const items = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function parsePositiveEnvInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runContentRegistryMaintenance({
  registry = require('./content/content-registry'),
  liveStatus = require('./content/content-registry-live-status'),
} = {}) {
  const contentType = String(process.env.CONTENT_REGISTRY_MAINTENANCE_CONTENT_TYPE || '').trim() || null;
  const syncResult = await registry.runContentRegistrySync({
    astroSource: 'github',
    githubRef: process.env.CONTENT_REGISTRY_GITHUB_REF || process.env.GITHUB_ASTRO_DEFAULT_BRANCH || null,
    contentType,
    commit: true,
  });
  if (!syncResult.ok) {
    throw new Error(`sync failed: ${syncResult.error || 'unknown error'}`);
  }

  const statuses = parseListEnv(process.env.CONTENT_REGISTRY_LIVE_STATUS_STATUSES, CONTENT_REGISTRY_LIVE_STATUSES);
  const limit = parsePositiveEnvInt(process.env.CONTENT_REGISTRY_LIVE_STATUS_LIMIT, CONTENT_REGISTRY_LIVE_LIMIT);
  const liveResult = await liveStatus.runContentRegistryLiveStatusCheck({
    statuses,
    limit,
    commit: true,
  });
  if (!liveResult.ok) {
    throw new Error(`live status failed: ${liveResult.error || 'unknown error'}`);
  }

  return {
    sync: syncResult.summary,
    live: liveResult.summary,
    sync_run_id: syncResult.sync_run_id,
    statuses,
    limit,
  };
}

async function runAutonomousOpportunityMining({
  miner = require('./seo/gsc-opportunity-miner'),
} = {}) {
  const periodDays = parsePositiveEnvInt(process.env.AUTONOMOUS_OPPORTUNITY_MINE_PERIOD_DAYS, 28);
  const result = await miner.mineAll({ periodDays, persist: true });
  logger.info(`[autonomous-opportunity-miner] mined period=${periodDays}d persisted=${result.persisted || 0}`);
  return result;
}

function initScheduledJobs() {
  const { isEnabled, logGateStatus } = require('../config/feature-gates');
  logGateStatus();

  if (!isEnabled('cronJobs')) {
    logger.info('[feature-gates] Cron jobs DISABLED — skipping all scheduled tasks');
    return;
  }

  // EVERY 5 MIN — mark deploy-killed SEO pipeline/site-audit runs as failed.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { reapStaleSeoRuns } = require('./seo/seo-pipeline-runs');
      const result = await reapStaleSeoRuns();
      if (result.reaped > 0) {
        logger.warn(`[seo-pipeline] reaped ${result.reaped} stale running run(s) older than ${result.staleMinutes} minutes`);
      }
    } catch (err) {
      logger.error(`[seo-pipeline] stale-run reaper failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:15AM — Data Hygiene deterministic normalization scan
  // =========================================================================
  cron.schedule('15 3 * * *', async () => {
    if (!isEnabled('dataHygieneScanner')) return;
    logger.info('Running: Data Hygiene normalization scan');
    try {
      const result = await require('./data-hygiene').runScan({
        mode: 'cron',
        phases: ['normalization'],
      });
      logger.info(`[data-hygiene] scheduled normalization scan finished with status=${result.status}, run_id=${result.run_id}`);
    } catch (err) {
      logger.error(`Data Hygiene normalization scan failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // SEO COMMAND CENTER CRONS (gated behind GATE_SEO_INTELLIGENCE)
  // =========================================================================

  // DAILY 2AM — Rank tracking (priority 1 daily, all on Sunday)
  cron.schedule('0 2 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: SEO rank tracking');
    try {
      const RankTracker = require('./seo/rank-tracker');
      await RankTracker.trackRanks();
    } catch (err) { logger.error(`Rank tracking failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 2:30AM — AI Overview check (top 20 keywords)
  cron.schedule('30 2 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: AI Overview tracking');
    try {
      const AIOverviewTracker = require('./seo/ai-overview-tracker');
      await AIOverviewTracker.trackDaily();
    } catch (err) { logger.error(`AI Overview tracking failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 3:00AM — LLM mention probe (ChatGPT/Gemini/Claude/AI Overview)
  cron.schedule('0 3 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: LLM mention probe');
    try {
      const prober = require('./seo/llm-mention-prober');
      await prober.runDaily();
    } catch (err) { logger.error(`LLM mention probe failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // QUARTERLY (Jan/Apr/Jul/Oct 1st, 4AM) — Competitor keyword gap mining.
  // Pulls tracked competitors' ranked keywords from DataForSEO Labs, diffs
  // against our rankings + live sitemap, enqueues blog gaps the GSC/AEO
  // miners structurally can't see (zero-footprint topics). ~$1.30/run.
  // runExclusive: the Labs pulls cost real money — never double-run.
  cron.schedule('0 4 1 1,4,7,10 *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Competitor keyword gap mining (quarterly)');
    try {
      await runExclusive('competitor-gap-miner', async () => {
        const miner = require('./seo/competitor-gap-miner');
        await miner.mineAll();
      });
    } catch (err) { logger.error(`Competitor gap mining failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 4:30AM — Terminate stale outreach rows for soft-deleted
  // customers. The cron-side deleted_at filters only SKIP these rows, and
  // the terminal pre-passes only catch rows as they come due — anything
  // armed before a customer was archived (or before those guards shipped)
  // sits pending forever and would fire stale if the customer is restored.
  // =========================================================================
  cron.schedule('30 4 * * 0', async () => {
    logger.info('Running: deleted-customer outreach row cleanup');
    try {
      await runExclusive('deleted-customer-row-cleanup', async () => {
        const deletedCustomers = db('customers').select('id').whereNotNull('deleted_at');

        const reminders = await db('appointment_reminders')
          .where({ cancelled: false })
          .whereIn('customer_id', deletedCustomers.clone())
          .update({ cancelled: true, updated_at: new Date() });

        const reviews = await db('review_requests')
          .where({ status: 'pending' })
          .whereIn('customer_id', deletedCustomers.clone())
          .update({ status: 'suppressed' });

        const followups = await db('invoice_followup_sequences')
          .whereIn('status', ['active', 'autopay_hold'])
          .whereIn('customer_id', deletedCustomers.clone())
          .update({ status: 'paused', next_touch_at: null, updated_at: new Date() });

        if (reminders || reviews || followups) {
          logger.info(`[deleted-cleanup] Terminated stale rows for archived customers: ${reminders} reminder(s), ${reviews} review request(s), ${followups} invoice follow-up sequence(s)`);
        }
      });
    } catch (err) {
      logger.error(`Deleted-customer row cleanup failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // WEEKLY SUNDAY 3:30AM — Backlink scan
  cron.schedule('30 3 * * 0', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Backlink scan');
    try {
      const BacklinkMonitor = require('./seo/backlink-monitor');
      await BacklinkMonitor.scan();
    } catch (err) { logger.error(`Backlink scan failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 4:30AM — Link prospect verifier (live/follow reconcile + crawl fallback)
  cron.schedule('30 4 * * *', async () => {
    logger.info('Running: Link prospect verifier');
    try {
      const Verifier = require('./seo/link-prospect-verifier');
      await Verifier.run();
    } catch (err) { logger.error(`Link prospect verifier failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 5:00AM — Link prospect indexer (linking-page index via DataForSEO + target-page via GSC)
  cron.schedule('0 5 * * *', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Link prospect indexer');
    try {
      const Indexer = require('./seo/link-prospect-indexer');
      await Indexer.run();
    } catch (err) { logger.error(`Link prospect indexer failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // HOURLY :15 — release stale Hermes worker claims back to the prospect pool
  cron.schedule('15 * * * *', async () => {
    try {
      const Worker = require('./seo/link-prospect-worker');
      await Worker.sweepExpiredClaims();
    } catch (err) { logger.error(`Link prospect claim sweep failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 1:30AM — Full site technical audit
  cron.schedule('30 1 * * 1', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Site-wide technical audit');
    try {
      const SiteAuditor = require('./seo/site-auditor');
      await SiteAuditor.runSiteAudit();
    } catch (err) { logger.error(`Site audit failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 5:00AM — BI Briefing Agent (Monday morning SMS to Adam)
  cron.schedule('0 5 * * 1', async () => {
    logger.info('Running: Weekly BI Briefing Agent');
    try {
      const BIAgent = require('./bi-agent');
      await BIAgent.run();
    } catch (err) {
      logger.error(`BI Briefing Agent failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // WEEKLY MONDAY 5:30AM — Content decay check
  cron.schedule('30 5 * * 1', async () => {
    if (!isEnabled('seoIntelligence')) return;
    logger.info('Running: Content decay detection');
    try {
      const ContentDecay = require('./seo/content-decay');
      await ContentDecay.detect();
      const Cannibalization = require('./seo/cannibalization');
      await Cannibalization.detect();
    } catch (err) { logger.error(`Content decay/cannibalization failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 7:15AM ET — Refresh customer-insight clusters before the opportunity
  // miner + runner so customer-question pages draw on current first-party data.
  // Reader against call_log / messages / google_reviews (consent + suppression
  // gated, PII-redacted); writes ONLY customer_insight_clusters aggregates —
  // never raw transcripts. Without this the clusters table goes stale (it was
  // empty in prod until the first manual run). Same gate as the engine.
  cron.schedule('15 7 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: Customer Insights Miner');
    try {
      const insightsMiner = require('./content/customer-insights-miner');
      const result = await insightsMiner.mineAll({ days: 120, persist: true });
      const persistedCount = Array.isArray(result?.persisted) ? result.persisted.length : (result?.persisted ?? '?');
      logger.info(`Customer insights mine: ${result?.cluster_count ?? '?'} clusters (${result?.qualifying_count ?? '?'} qualifying), ${persistedCount} persisted`);
    } catch (err) { logger.error(`Customer insights miner failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 7:30AM ET — Mine fresh GSC opportunities before the 9AM runner.
  // Writes only opportunity_queue rows. The runner still chooses by score and
  // per-lane shadow/canary guards decide whether anything can publish.
  cron.schedule('30 7 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: Autonomous Content Opportunity Miner');
    try {
      await runAutonomousOpportunityMining();
    } catch (err) { logger.error(`Autonomous opportunity miner failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 9AM ET — Autonomous Content Engine daily run (7 days/week).
  // Per v3.1 plan: ET-pinned, shadow mode by default until
  // SHADOW_MODE_<ACTION_TYPE>=false is set per action type. Action types
  // with AUTO_PUBLISH_<ACTION_TYPE>=true skip the human trust-build ramp.
  // Gated behind GATE_AUTONOMOUS_CONTENT so it stays inert in prod
  // until Adam explicitly enables it.
  cron.schedule('0 9 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: Autonomous Content Engine daily');
    try {
      const AutonomousRunner = require('./content/autonomous-runner');
      await AutonomousRunner.runDaily();
    } catch (err) { logger.error(`Autonomous content engine failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // DAILY 8AM ET — Content-optimization impact tracker. Snapshots a baseline
  // for newly-live optimizations, then fills the 14d/21d diff-in-diff windows
  // and records control-adjusted verdicts. Read-only against gsc_pages; writes
  // only content_optimization_impact. Same gate as the engine.
  cron.schedule('0 8 * * *', async () => {
    if (!isEnabled('autonomousContentEngine')) return;
    logger.info('Running: content-optimization impact tracker');
    try {
      const ImpactTracker = require('./seo/impact-tracker');
      await ImpactTracker.sweepNewlyLive({});
      await ImpactTracker.checkPending({});
      await ImpactTracker.checkAeoVisibility({});
    } catch (err) { logger.error(`Impact tracker failed: ${err.message}`); }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4AM — Newsletter event ingestion (P3a). Pulls every enabled
  // RSS source from event_sources, upserts into events_raw. Daily cadence
  // (vs weekly with the newsletter draft) so events added 6 days before
  // a Friday send still make it into the dashboard tiles.
  // =========================================================================
  cron.schedule('0 4 * * *', async () => {
    logger.info('Running: Newsletter event ingestion');
    try {
      const EventIngestion = require('./event-ingestion');
      await EventIngestion.ingestAllEnabledSources();
    } catch (err) {
      logger.error(`Event ingestion failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:45AM ET — Sweep payment_method_consents whose FK to
  // payment_methods never got backfilled. The webhook does the link in
  // real time, but a missed webhook past Stripe's 72h retry window
  // leaves the row orphaned. Nightly sweep tries to match by
  // stripe_payment_method_id and links any payment_methods row that
  // landed without firing the webhook hook.
  // =========================================================================
  cron.schedule('45 3 * * *', async () => {
    try {
      const { sweepOrphanConsents } = require('./payment-method-consents');
      const result = await sweepOrphanConsents({ olderThanHours: 24, staleAfterDays: 30 });
      if (result.linked > 0 || result.stale > 0) {
        logger.info(`[consents-sweep] ${result.total} orphan(s); linked ${result.linked}; ${result.stale} stale beyond 30d`);
      }
    } catch (err) {
      logger.error(`Consents sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 2:45AM ET — Voice-corpus miner (SMS brand-voice loop, Phase A).
  // Mines human-authored SMS replies (on a 7-day-delayed band so each
  // pair's outcome window has closed before the row freezes) + recent
  // consent-gated labeled call transcripts into voice_corpus_examples
  // (redacted). Overlapping 3-day bands + insert-ignore = idempotent, so
  // a missed night self-heals on the next run.
  // =========================================================================
  cron.schedule('45 2 * * *', async () => {
    if (!isEnabled('voiceCorpusMiner')) return;
    logger.info('Running: Voice-corpus miner');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { mineVoiceCorpus } = require('./sms-voice-corpus-miner');
      await runExclusive('voice-corpus-miner', () => mineVoiceCorpus({ sinceDays: 3 }));
    } catch (err) {
      logger.error(`Voice-corpus miner failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:55AM ET — Shadow judge (SMS brand-voice loop, Phase C). Pairs
  // each 24h-matured shadow draft with the human reply that actually went
  // out and scores it per intent class. LLM only when the human replied;
  // batch-capped; unjudged drafts retry next night (anti-join).
  // =========================================================================
  cron.schedule('55 3 * * *', async () => {
    if (!isEnabled('shadowJudge')) return;
    logger.info('Running: Shadow judge');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { judgeShadowDrafts } = require('./sms-shadow-judge');
      await runExclusive('shadow-judge', () => judgeShadowDrafts());
    } catch (err) {
      logger.error(`Shadow judge failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 4:10AM ET — Expire stale composer suggestions (brand-voice loop,
  // Phase D). A pending house-voice suggestion nobody acted on within 48h is
  // marked 'expired' so it stops surfacing under dead threads and doesn't
  // skew the per-intent ignored-rate graduation signal.
  // =========================================================================
  cron.schedule('10 4 * * *', async () => {
    if (!isEnabled('smsSuggestMode')) return;
    logger.info('Running: SMS suggestion expiry sweep');
    try {
      const { runExclusive } = require('../utils/cron-lock');
      const { expireStaleSuggestions } = require('./sms-suggest-mode');
      await runExclusive('sms-suggest-expiry', () => expireStaleSuggestions());
    } catch (err) {
      logger.error(`SMS suggestion expiry sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:30AM ET — Purge stripe_webhook_events older than 90 days.
  // Stripe's retry window is 72h max, so anything past 90d is just historical
  // noise; the table grows ~50–500 rows/day and never shrinks otherwise.
  // Keeps idempotency lookups fast and PG vacuum manageable. The retention
  // window is generous on purpose — operators can still grep for an event
  // ID weeks later without hitting a hole.
  // =========================================================================
  cron.schedule('30 3 * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const db = require('../models/db');
      const purged = await db('stripe_webhook_events')
        .where('received_at', '<', cutoff)
        .del();
      if (purged > 0) {
        logger.info(`[stripe-webhook-purge] Removed ${purged} stripe_webhook_events row(s) older than 90 days`);
      }
    } catch (err) {
      logger.error(`Stripe webhook events purge failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5AM — Newsletter event normalization (P3b leg 3). One hour
  // after ingestion so newly-pulled rows get Claude venue extraction +
  // Google geocoding in the same day. Capped at 50 rows per run so the
  // Claude API spend is bounded (~$1/day).
  // =========================================================================
  cron.schedule('0 5 * * *', async () => {
    logger.info('Running: Newsletter event normalization');
    try {
      const EventNormalizer = require('./event-normalizer');
      await EventNormalizer.normalizeBatch();
    } catch (err) {
      logger.error(`Event normalization failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MIN — Newsletter scheduled sends (dispatches any whose scheduled_for
  // has passed). Intentionally high-frequency so "send at 8:00am" fires close
  // to the minute. Per-tick work is a single indexed query on newsletter_sends.
  // =========================================================================
  cron.schedule('* * * * *', async () => {
    try {
      const NewsletterSender = require('./newsletter-sender');
      await NewsletterSender.processScheduledSends();
    } catch (err) {
      logger.error(`Newsletter scheduler tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // TUESDAYS 7AM ET — Pest Insider monthly autopilot. Fires every Tuesday;
  // runPestInsiderAutopilot's first-Tuesday ET gate + per-month idempotency
  // keep it to one draft a month (node-cron's dom×dow semantics aren't
  // portable, so the gate lives in code). Drafts only — admin reviews and
  // sends manually, same contract as the weekly autopilot. runExclusive:
  // deploy-overlap ticks must not double-draft (the idempotency check is
  // read-then-act).
  // =========================================================================
  cron.schedule('0 7 * * 2', async () => {
    try {
      await runExclusive('pest-insider-autopilot', async () => {
        const { runPestInsiderAutopilot } = require('./pest-insider-autopilot');
        const result = await runPestInsiderAutopilot();
        logger.info(`[pest-insider-autopilot] ${result.skipped ? 'skipped' : 'drafted'}: ${result.reason || result.sendId}`);
      });
    } catch (err) {
      logger.error(`[pest-insider-autopilot] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY THURSDAY 7AM ET — Newsletter autopilot
  // Auto-drafts the weekly flagship digest from approved events. Never
  // auto-sends — creates a draft for admin review. Skips if fewer than 3
  // eligible events and notifies admin to approve more.
  // =========================================================================
  cron.schedule('0 7 * * 4', async () => {
    try {
      const { autoDraftFlagship } = require('./newsletter-autopilot');
      const result = await autoDraftFlagship();
      logger.info(`[newsletter-autopilot] ${result.skipped ? 'skipped' : 'drafted'}: ${result.reason || result.sendId}`);
    } catch (err) {
      logger.error(`[newsletter-autopilot] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // THU–SUN 2PM ET — Missed-tick catch-up for the Thursday-7AM autopilot. If
  // the process was down at 7AM Thursday, the weekly draft never got created.
  // Re-run autoDraftFlagship ONLY for a week that was NEVER ATTEMPTED (no
  // calendar row, or status 'planned'). A deliberately-deleted draft (status
  // 'drafted' with a null send_id) is left alone so it can't silently reappear,
  // and drafted/scheduled/sent/skipped weeks are already handled. The autopilot's
  // own advisory lock + dedupe make a catch-up invocation safe if it races the
  // 7AM run. Runs daily Thu–Sun so a mid-week recovery still lands the draft.
  // A catch-up that hard-fails preflight persists a 'skipped' row, so the
  // following day's tick retires the week instead of re-running + re-notifying.
  // =========================================================================
  cron.schedule('0 14 * * 4,5,6,0', async () => {
    try {
      const { getCurrentNewsletterThursday } = require('./event-freshness');
      const weekOf = getCurrentNewsletterThursday();
      const cal = await db('newsletter_calendar').where('week_of', weekOf).first();
      // Only catch up weeks that were never attempted.
      if (cal && cal.status !== 'planned') return;
      const { autoDraftFlagship } = require('./newsletter-autopilot');
      const result = await autoDraftFlagship();
      logger.info(`[newsletter-autopilot-catchup] ${result.skipped ? 'skipped' : 'drafted'}: ${result.reason || result.sendId}`);
    } catch (err) {
      logger.error(`[newsletter-autopilot-catchup] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM ET — Newsletter indexability decay: noindex stale event digests
  // Event digest archive pages older than 30 days add nothing to search —
  // stale "This Weekend in SWFL" content just dilutes the index. Flips
  // indexability from 'index' → 'noindex' so the Astro archive pages
  // set robots noindex and Google drops them from the SERPs.
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const count = await db('newsletter_sends')
        .where('newsletter_type', 'local-weekly-fresh-events')
        .where('status', 'sent')
        .where('sent_at', '<', cutoff)
        .where('indexability', 'index')
        .update({ indexability: 'noindex', updated_at: new Date() });
      if (count > 0) logger.info(`[newsletter-decay] Set ${count} stale digest(s) to noindex`);
    } catch (err) {
      logger.error(`[newsletter-decay] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:15AM ET — Event auto-curation. Classifies never-examined pending
  // events with Claude and approves real consumer events for the digest, so
  // the Thursday 7AM autopilot has an approved pool without a human working
  // the Event Inbox every week (the lane starved at 0 eligible for two weeks
  // when approval was manual-only). Runs after the 4AM ingest → 5AM
  // normalize → 5:30 expiry → 5:45 dedup chain so it judges clean, classified
  // rows. Rejections stay pending for human review — nothing is auto-rejected.
  // runExclusive: examined-marker writes are idempotent but the Claude calls
  // are not free; don't double-classify on deploy-overlap ticks.
  // Kill switch: EVENT_AUTO_CURATION=false.
  // =========================================================================
  cron.schedule('15 6 * * *', async () => {
    try {
      await runExclusive('event-auto-curation', async () => {
        const { runAutoCuration } = require('./event-curation');
        const result = await runAutoCuration();
        if (result.examined > 0 || result.approved > 0) {
          logger.info(`[event-curation] examined ${result.examined}, approved ${result.approved}`);
        }
      });
    } catch (err) {
      logger.error(`[event-curation] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 3:20AM ET — Incident regression eval. Replays the incident
  // corpus (server/fixtures/incident-eval/) through the LIVE fact-check gate
  // and inbox classifier and notifies admin on regression. The jest tests for
  // these components mock the model, so prompt edits, MODEL_* env swaps, and
  // provider-side drift are invisible to CI — and both components degrade
  // silently (the gate fails open; a classifier drift just fires a different
  // auto-action). Each case is a real past incident; see the corpus README.
  // Read-only against business data: classification runs through the pure
  // classifyEmailContent path (no emails-row writes, no auto-actions).
  // runExclusive: ~10 LLM calls; don't double-spend on deploy-overlap ticks.
  // Kill switch: GATE_INCIDENT_EVAL=false.
  // =========================================================================
  cron.schedule('20 3 * * 1', async () => {
    if (!isEnabled('incidentRegressionEval')) return;
    logger.info('Running: incident regression eval');
    try {
      await runExclusive('incident-regression-eval', async () => {
        const { runIncidentEval } = require('./eval/incident-regression');
        const result = await runIncidentEval();
        logger.info(`Incident eval done: ${result.passed}/${result.total} passed, ${result.failed} failed, ${result.inconclusive} inconclusive`);
      });
    } catch (err) {
      logger.error(`Incident regression eval failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5:30AM ET — Expire past events. classifyFreshness never emits an
  // 'expired' status and nothing else transitions an event out of its fresh
  // state once its date passes, so a one_time/annual event would keep its high
  // freshness_score forever. Mark anything whose effective date (end_at for
  // multi-day, else start_at) is before ET-today as expired so the terminal
  // rejects in isEligibleForFreshDigest + the editorial fetch filters reflect
  // reality and admin/ranking views aren't polluted by past events. Expire-only:
  // an event re-dated back into the future is revived by the ingestion merge
  // (clears freshness) + the normalizer recompute, NOT here — a date-based
  // reviver couldn't tell a system-expired row from an admin's manual 'expired'
  // curation, but ingestion seeing the date move past→future is unambiguous.
  // =========================================================================
  cron.schedule('30 5 * * *', async () => {
    try {
      const { parseETDateTime, etDateString } = require('../utils/datetime-et');
      const etMidnightToday = parseETDateTime(`${etDateString()}T00:00:00`);
      const count = await db('events_raw')
        .whereNot('freshness_status', 'expired')
        .whereRaw('COALESCE(end_at, start_at) < ?', [etMidnightToday])
        .update({ freshness_status: 'expired', freshness_score: 0, updated_at: new Date() });
      if (count > 0) logger.info(`[event-expiry] Marked ${count} past event(s) expired`);
    } catch (err) {
      logger.error(`[event-expiry] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 5:45AM ET — Cross-source duplicate auto-merge. Ingest dedupes only on
  // (source_id, external_id), so the same real-world event pulled from two feeds
  // becomes two rows and could both reach a digest. Cluster upcoming events
  // (normalized title + ET day + city — conservative, near-zero false positives)
  // and collapse each cluster into one survivor (highest-priority source, then
  // most complete). Runs after the 5AM normalize + 5:30AM expire, before the
  // Thursday-7AM autopilot, so the lineup it sees is already de-duplicated.
  // =========================================================================
  cron.schedule('45 5 * * *', async () => {
    try {
      const { autoMergeDuplicates } = require('./event-dedup');
      await autoMergeDuplicates();
    } catch (err) {
      logger.error(`[event-dedup] auto-merge run failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3AM ET — Purge stale double-opt-in pending subscribers. A 'pending'
  // row whose confirmation link aged past the purge window (30d) never
  // confirmed; delete it so the table doesn't accrue dead rows and the email is
  // free for a fresh signup. (The link already stops confirming after 7d via
  // the lookupByToken TTL.)
  // =========================================================================
  cron.schedule('0 3 * * *', async () => {
    try {
      const { purgeStalePendingSubscribers } = require('./newsletter-subscribers');
      const removed = await purgeStalePendingSubscribers();
      if (removed > 0) logger.info(`[newsletter] Purged ${removed} stale pending subscriber(s)`);
    } catch (err) {
      logger.error(`[newsletter-pending-purge] failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MIN — Automation runner. Fires the next step of any enrollment
  // whose next_send_at has passed. Indexed query on automation_enrollments.
  // =========================================================================
  cron.schedule('* * * * *', async () => {
    try {
      // Every-minute cadence + multi-second SendGrid sends = the next
      // tick (or an overlapping deploy instance) re-selects enrollments
      // whose cursor hasn't advanced yet — duplicate customer emails.
      await runExclusive('automation-runner', async () => {
        const AutomationRunner = require('./automation-runner');
        await AutomationRunner.processDueSteps();
      });
    } catch (err) {
      logger.error(`Automation runner tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY MIN — Email template automation executor. Sends due delayed/retry
  // runs created by trigger-mapped email template automations.
  // =========================================================================
  cron.schedule('* * * * *', async () => {
    try {
      if (!isEnabled('emailTemplateAutomations')) return;
      const EmailTemplateAutomationExecutor = require('./email-template-automation-executor');
      await EmailTemplateAutomationExecutor.processDueRuns();
    } catch (err) {
      logger.error(`Email template automation tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Appointment reminders (72h, 24h) from appointment_reminders table
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runExclusive('appointment-reminders', async () => {
        const reminders = require('./appointment-reminders');
        await reminders.checkAndSendReminders();
      });
    } catch (err) {
      logger.error(`Reminder check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Storm watch. Probes the NWS hourly forecast at the
  // CUSTOMER coordinates of each tech's upcoming stops and nudges the
  // tech (tech_notifications, same channel as geofence prompts) when
  // heavy rain crosses the threshold inside the look-ahead. Notify-only:
  // never reschedules, never texts customers. Internally gated to ET
  // service hours + one alert per job per day. runExclusive because
  // overlapping deploy instances would double-ping techs.
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runExclusive('storm-watch', async () => {
        const StormWatch = require('./storm-watch');
        await StormWatch.sweep();
      });
    } catch (err) {
      logger.error(`Storm watch sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 MIN — Cloudflare Pages build status for open blog-publish PRs.
  // Updates astro_preview_url once the preview deploy succeeds, or flips
  // the post to build_failed if it blows up.
  // =========================================================================
  cron.schedule('*/2 * * * *', async () => {
    try {
      const PagesPoll = require('./content-astro/pages-poll');
      await PagesPoll.pollPending();
    } catch (err) {
      logger.error(`Pages poll failed: ${err.message}`);
    }
  });

  // =========================================================================
  // EVERY 2 MIN — Autonomous blog PR lifecycle. Autonomous publishes have no
  // blog_posts row, so pages-poll never tracks their PRs; this reconciles
  // autonomous_runs parked at astro_pr_pending_merge with live GitHub state:
  // human merge → completes the run (IndexNow + internal-link planning),
  // close-unmerged → fails it, and — ONLY when AUTONOMOUS_BLOG_AUTO_MERGE is
  // set (default off) — merges green + Codex-clear PRs itself, capped per
  // tick. runExclusive: a merge and its post-merge chain must not double-run
  // across overlapping deploy instances.
  // =========================================================================
  cron.schedule('*/2 * * * *', async () => {
    try {
      await runExclusive('autonomous-pr-poll', async () => {
        const AutonomousPrPoller = require('./content/autonomous-pr-poller');
        await AutonomousPrPoller.pollPending();
      });
    } catch (err) {
      logger.error(`Autonomous PR poll failed: ${err.message}`);
    }
  });

  // =========================================================================
  // DAILY 5:40AM ET — Post-publish visibility sweep. Re-runs the visibility
  // worker (live/canonical/noindex/sitemap/IndexNow/AI-readiness) for
  // content published in the last few days: blog_posts that recently went
  // live AND autonomous_runs publishes (which have no blog_posts row). The
  // one-shot check at live-flip can miss slow-propagating issues; this is
  // the bounded daily backstop. Off-peak, small batch; failures log inside
  // the sweep and never throw out of the cron.
  // =========================================================================
  cron.schedule('40 5 * * *', async () => {
    logger.info('Running: post-publish visibility sweep');
    try {
      await runExclusive('post-publish-visibility-sweep', async () => {
        const VisibilityWorker = require('./content/post-publish-visibility-worker');
        await VisibilityWorker.sweepRecentlyPublished();
        // Same daily cadence doubles as the alert dedupe: one summary text
        // for autonomous PRs parked unmerged past the threshold (Codex
        // block / red build / missing deploy — the 2-min poller retries
        // those forever and silently).
        await VisibilityWorker.alertStuckAutonomousPrs();
      });
    } catch (err) {
      logger.error(`Post-publish visibility sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10AM (weekdays) — 7-Day Late Payment SMS
  // Checks invoices 7+ days overdue, sends tiered reminder SMS
  // =========================================================================
  cron.schedule('0 10 * * 1-5', async () => {
    logger.info('Running: late payment check');
    try {
      await runExclusive('late-payment-check', async () => {
        const LatePaymentService = require('./late-payment-checker');
        const result = await LatePaymentService.checkAndNotify();
        logger.info(`Late payment check done: ${result.notified} reminder(s) sent, ${result.skipped} skipped`);
      });
    } catch (err) {
      logger.error(`Late payment check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10AM (Tue–Fri) — Per-invoice follow-up sequences
  // Fires the next due touch for each unpaid invoice's automated chain.
  // =========================================================================
  cron.schedule('0 10 * * 2-5', async () => {
    logger.info('Running: invoice follow-up sequences');
    try {
      await runExclusive('invoice-followups', async () => {
        const InvoiceFollowUps = require('./invoice-followups');
        const result = await InvoiceFollowUps.runPending();
        logger.info(`Invoice follow-ups done: ${result.sent} sent, ${result.skipped} skipped`);
      });
    } catch (err) {
      logger.error(`Invoice follow-ups failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Process scheduled SMS sends
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();
      let scheduled = [];
      try {
        await recoverStaleScheduledSmsClaims(now);
        scheduled = await claimDueScheduledSms(now);
      } catch { return; /* scheduled_for column may not exist yet */ }

      for (const msg of scheduled) {
        const rowMeta = typeof msg.metadata === 'string'
          ? (() => { try { return JSON.parse(msg.metadata); } catch { return {}; } })()
          : (msg.metadata || {});
        try {
          const purpose = purposeForScheduledMessageType(msg.message_type);
          const smsResult = await sendCustomerMessage({
            to: msg.to_phone,
            body: msg.message_body,
            channel: 'sms',
            audience: msg.customer_id ? 'customer' : 'lead',
            purpose,
            customerId: msg.customer_id || undefined,
            identityTrustLevel: msg.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
            entryPoint: 'scheduled_sms_cron',
            // NOTE: marketing/retention scheduled sends must arrive with a real
            // stored consent record — we no longer manufacture opted_in here.
            // Routes that queue marketing-grade types are responsible for
            // gating against `messaging_consent`.
            metadata: {
              original_message_type: msg.message_type || 'scheduled',
              scheduled_sms_log_id: msg.id,
              fromNumber: msg.from_phone || undefined,
              adminUserId: msg.admin_user_id || undefined,
            },
          });
          const completedAt = new Date();
          if (smsResult.sent) {
            // created_at is re-stamped to send time on purpose — comms
            // threads order by it, and a scheduled SMS composed days ago
            // must appear when it was DELIVERED. Preserve the original
            // queue moment in metadata so the audit trail isn't lost
            // (jsonb_build_object reads the pre-update column value).
            await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
              status: 'sent',
              created_at: completedAt,
              updated_at: completedAt,
              metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('queued_at', created_at)"),
            });
            logger.info(`[scheduled-sms] Sent scheduled SMS ${msg.id}`);

            // A scheduled send composed from an Agent Review draft resolves
            // its decision now that the message actually left — schedule-sms
            // stashed the verified id on the row. Suggestions parked behind
            // the queued reply resolve as ignored (their drafts return to
            // the judge). Internal catches: a resolution failure must not
            // flip a SENT row to failed.
            if (rowMeta.agent_decision_id) {
              const { resolveSuggestionAfterSend } = require('./sms-suggest-mode');
              await resolveSuggestionAfterSend({
                decisionId: rowMeta.agent_decision_id,
                sentBody: msg.message_body,
                reviewedBy: msg.admin_user_id || 'Admin',
              });
            }
            if (Array.isArray(rowMeta.parked_decision_ids) && rowMeta.parked_decision_ids.length) {
              const { ignoreParkedSuggestions } = require('./sms-suggest-mode');
              await ignoreParkedSuggestions({
                decisionIds: rowMeta.parked_decision_ids,
                reviewedBy: msg.admin_user_id || 'Admin',
              });
            }
          } else if (smsResult.code === 'QUIET_HOURS_HOLD' && smsResult.nextAllowedAt) {
            await db('sms_log').where({ id: msg.id, status: 'sending' }).update({
              status: 'scheduled',
              scheduled_for: new Date(smsResult.nextAllowedAt),
              updated_at: completedAt,
              metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('quiet_hours_held_at', ?::timestamptz, 'quiet_hours_reason', ?)", [completedAt, smsResult.reason || null]),
            });
            logger.info(`[scheduled-sms] Held scheduled SMS ${msg.id} until ${smsResult.nextAllowedAt}`);
          } else {
            await db('sms_log').where({ id: msg.id, status: 'sending' }).update({ status: 'blocked', updated_at: completedAt });
            logger.warn(`[scheduled-sms] Blocked/failed scheduled SMS ${msg.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
            // The customer was never answered — used + parked cards return.
            await require('./sms-suggest-mode').reopenScheduledSuggestions({
              decisionIds: [rowMeta.agent_decision_id, ...(Array.isArray(rowMeta.parked_decision_ids) ? rowMeta.parked_decision_ids : [])],
              reason: 'Scheduled send was blocked — suggestion reopened.',
            });
          }
        } catch (err) {
          await db('sms_log').where({ id: msg.id, status: 'sending' }).update({ status: 'failed', updated_at: new Date() });
          logger.error(`[scheduled-sms] Failed: ${err.message}`);
          await require('./sms-suggest-mode').reopenScheduledSuggestions({
            decisionIds: [rowMeta.agent_decision_id, ...(Array.isArray(rowMeta.parked_decision_ids) ? rowMeta.parked_decision_ids : [])],
            reason: 'Scheduled send failed — suggestion reopened.',
          });
        }
      }
    } catch (err) {
      logger.error(`Scheduled SMS processing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Retry queued service report v1 email deliveries
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { processDueServiceReportDeliveries } = require('./service-report/delivery-queue');
      const result = await processDueServiceReportDeliveries();
      if (result.claimed || result.sent || result.skipped || result.failed || result.requeued || result.recovered) {
        logger.info(`Service report deliveries: ${result.sent} sent, ${result.requeued} queued for retry, ${result.skipped} skipped, ${result.failed} failed, ${result.recovered} recovered`);
      }
    } catch (err) {
      logger.error(`Service report delivery cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Retry queued service report PDF renders
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { processDuePdfRenderJobs } = require('./service-report/pdf-queue');
      const result = await processDuePdfRenderJobs();
      if (result.claimed || result.succeeded || result.failed || result.requeued || result.recovered) {
        logger.info(`Service report PDF renders: ${result.succeeded} succeeded, ${result.requeued} queued for retry, ${result.failed} failed, ${result.recovered} recovered`);
      }
    } catch (err) {
      logger.error(`Service report PDF render cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 2:45AM — Build anonymized service report neighborhood pressure rolls
  // =========================================================================
  cron.schedule('45 2 * * *', async () => {
    try {
      const { buildNeighborhoodPressureAggregates } = require('./service-report/neighborhood-pressure-aggregates');
      const result = await buildNeighborhoodPressureAggregates();
      if (result.inserted > 0) {
        logger.info(`[service-report-pressure] Built ${result.inserted} neighborhood aggregate row(s) for ${result.periodStart} to ${result.periodEnd}`);
      }
    } catch (err) {
      logger.error(`Service report neighborhood pressure aggregate failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MINUTES — Send scheduled estimates whose time has arrived
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const now = new Date();
      await recoverStaleScheduledEstimateClaims(now);
      const scheduled = await claimDueScheduledEstimates(now);

      if (scheduled.length === 0) return;

      const { sendEstimateNow } = require('../routes/admin-estimates');
      for (const est of scheduled) {
        try {
          const result = await sendEstimateNow(est, est.send_method || 'both');
          if (result.sent) {
            const suffix = result.partialFailure ? ` with channel issues (${result.failedChannels.join(', ')})` : '';
            logger.info(`Scheduled estimate ${est.id} sent${suffix}`);
          } else {
            logger.warn(`Scheduled estimate ${est.id} was not sent on any channel`);
            await markScheduledEstimateSendFailure(est, 'Estimate was not sent on any requested channel', { retry: false, now });
          }
        } catch (e) {
          logger.error(`Scheduled estimate ${est.id} failed: ${e.message}`);
          await markScheduledEstimateSendFailure(est, e.message, { retry: true, now });
        }
      }
      logger.info(`Scheduled estimates processed: ${scheduled.length}`);
    } catch (err) {
      logger.error(`Scheduled estimate cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MINUTES — Auto-send generated lead-webhook estimates.
  // Explicit gates default OFF. When enabled, this rechecks eligibility after
  // the configured delay and then uses the same sendEstimateNow path as manual
  // and scheduled sends.
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    if (!isEnabled('leadEstimateAutomation') || !isEnabled('leadEstimateAutoSend')) return;
    try {
      const {
        leadEstimateAutoSendConfigFromEnv,
        processLeadEstimateAutoSendBatch,
      } = require('./lead-estimate-auto-send');
      const result = await processLeadEstimateAutoSendBatch({
        config: leadEstimateAutoSendConfigFromEnv(),
      });
      if (result.scanned || result.sent || result.blocked || result.failed || result.recovered || result.staleBlocked) {
        logger.info(`[lead-estimate-auto-send] scanned=${result.scanned} sent=${result.sent} blocked=${result.blocked} failed=${result.failed} skipped=${result.skipped} recovered=${result.recovered} staleBlocked=${result.staleBlocked}`);
      }
    } catch (err) {
      logger.error(`Lead estimate auto-send cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MINUTES — Send scheduled invoices whose time has arrived
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const InvoiceService = require('./invoice');
      const result = await InvoiceService.processScheduledSends();
      if (result.sent || result.failed) {
        logger.info(`Scheduled invoices: ${result.sent} sent, ${result.failed} failed`);
      }
    } catch (err) {
      logger.error(`Scheduled invoice cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 MINUTES — Email sync (Gmail → PostgreSQL)
  // =========================================================================
  cron.schedule('*/2 * * * *', async () => {
    try {
      const { syncEmails } = require('./email/email-sync');
      const result = await syncEmails();
      if (result.newEmails > 0) {
        logger.info(`[email-sync] Synced ${result.newEmails} new emails`);
      }
    } catch (err) {
      logger.error(`[email-sync] Cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 7:30 AM — Morning email digest notification
  // =========================================================================
  cron.schedule('30 7 * * *', async () => {
    try {
      // Window opens at ET midnight yesterday. The previous computation
      // used setHours(0,0,0,0) in server-local time — Railway runs UTC, so
      // the "overnight" window opened at UTC midnight (= 7–8 PM ET two days
      // prior) and the 7:30 AM digest counted ~35 hours of email.
      const windowStart = parseETDateTime(`${etDateString(addETDays(new Date(), -1))}T00:00:00`);

      const emails = await db('emails').where('received_at', '>=', windowStart);
      const unread = await db('emails')
        .where({ is_read: false, is_archived: false })
        .count('* as c').first();

      const leads = emails.filter(e => e.auto_action && e.auto_action.includes('lead_created')).length;
      const invoices = emails.filter(e => e.classification === 'vendor_invoice').length;
      const spam = emails.filter(e => e.classification === 'spam').length;
      const invoiceAmounts = emails
        .filter(e => e.classification === 'vendor_invoice' && e.extracted_data)
        .reduce((sum, e) => {
          const data = typeof e.extracted_data === 'string' ? JSON.parse(e.extracted_data) : e.extracted_data;
          return sum + (parseFloat(data.invoice_amount) || 0);
        }, 0);

      const parts = [`${parseInt(unread?.c || 0)} unread`];
      if (leads > 0) parts.push(`${leads} leads created`);
      if (invoices > 0) parts.push(`${invoices} invoice${invoices > 1 ? 's' : ''} ($${invoiceAmounts.toFixed(2)} logged)`);
      if (spam > 0) parts.push(`${spam} spam blocked`);

      await db('notifications').insert({
        recipient_type: 'admin',
        category: 'email_digest',
        title: 'Morning Email Digest',
        body: `${emails.length} emails overnight. ${parts.join(', ')}. Check /admin/email for details.`,
        icon: '\uD83D\uDCE7',
        link: '/admin/email',
        metadata: JSON.stringify({ severity: parseInt(unread?.c || 0) > 10 ? 'high' : 'low' }),
        created_at: new Date(),
      }).catch(() => {});

      logger.info(`[email-digest] Morning digest: ${emails.length} emails, ${leads} leads, ${spam} spam`);
    } catch (err) {
      logger.error(`[email-digest] Cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 HOURS — Estimate follow-up SMS (unviewed, viewed-not-accepted, expiring)
  // =========================================================================
  cron.schedule('0 */2 * * *', async () => {
    try {
      await runExclusive('estimate-follow-up', async () => {
        const EstimateFollowUp = require('./estimate-follow-up');
        const result = await EstimateFollowUp.checkAll();
        if (result.sent > 0) logger.info(`Estimate follow-ups: ${result.sent} sent`);
      });
    } catch (err) {
      logger.error(`Estimate follow-up job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 HOURS — Onboarding abandonment SMS (24h / 72h / expiring)
  // =========================================================================
  cron.schedule('15 */2 * * *', async () => {
    try {
      await runExclusive('onboarding-follow-up', async () => {
        const OnboardingFollowUp = require('./onboarding-follow-up');
        const result = await OnboardingFollowUp.checkAll();
        if (result.sent > 0) logger.info(`Onboarding follow-ups: ${result.sent} sent`);
      });
    } catch (err) {
      logger.error(`Onboarding follow-up job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Estimate extensions are manual-only. Do not auto-renew expired estimates
  // from cron; staff can extend deliberately through the admin estimate route.

  // =========================================================================
  // EVERY 15 MIN — Release expired slot reservations
  //
  // Reserve→accept holds set scheduled_services.reservation_expires_at to
  // NOW() + 15min. When a customer abandons before accepting (closes tab,
  // network drops, sits past the countdown) the row sticks around marked
  // as occupied for that (tech, date, window) tuple, blocking other
  // customers from picking the slot. Cadence matches the 15-min TTL so
  // worst-case stale-hold lifetime is ~30 min (TTL + cleanup interval).
  //
  // releaseExpiredReservations() is a narrow DELETE on rows where
  // reservation_expires_at < NOW() — see slot-reservation.js for the
  // index that keeps the scan cheap.
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { releaseExpiredReservations } = require('./slot-reservation');
      const result = await releaseExpiredReservations();
      if (result.released > 0) logger.info(`[slot-reservation] released ${result.released} expired reservation(s)`);
    } catch (err) {
      logger.error(`Slot reservation cleanup failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Estimate actuals reconcile — nightly, joins completed services back to
  // the accepted estimate that created them and writes the priced-vs-observed
  // ledger (estimate_actuals). Systematic-bias aggregates are read via
  // GET /api/admin/estimates/actuals-variance.
  // =========================================================================
  cron.schedule('37 2 * * *', async () => {
    try {
      const { runEstimateActualsReconcile } = require('./estimate-actuals');
      const result = await runEstimateActualsReconcile();
      if (result.written > 0) {
        logger.info(`[estimate-actuals] nightly reconcile wrote ${result.written} row(s)`);
      }
    } catch (err) {
      logger.error(`Estimate actuals reconcile cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Dashboard alerts — every 5 minutes, detect transitions in operational
  // alerts and fan out Waves admin notifications.
  // See server/services/dashboard-alerts-cron.js for the diff logic.
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runDashboardAlertsCheck } = require('./dashboard-alerts-cron');
      const result = await runDashboardAlertsCheck();
      if (result.fired > 0 || result.cleared > 0) {
        logger.info(`[dashboard-alerts] fired=${result.fired} cleared=${result.cleared} active=${result.current}`);
      }
    } catch (err) {
      logger.error(`Dashboard alerts cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // Property-lookup parser canary — nightly, one golden parcel per county
  // through the real by-parcel pipeline; alerts when a county PAO layout
  // change silently breaks the scrape-based parsers.
  // See server/services/property-lookup-canary.js.
  // =========================================================================
  cron.schedule('17 4 * * *', async () => {
    try {
      const { runPropertyLookupCanary } = require('./property-lookup-canary');
      const result = await runPropertyLookupCanary();
      if (result.failures?.length) {
        logger.warn(`[property-lookup-canary] ${result.failures.length} failing check(s)`);
      }
    } catch (err) {
      logger.error(`Property-lookup canary cron failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WaveGuard lawn readiness — route-morning protocol preflight snapshot.
  // Stores the readiness ledger and opens an admin alert when appointments
  // are blocked by assignment, calibration, inventory, or property gates.
  // =========================================================================
  cron.schedule('30 5 * * *', async () => {
    try {
      const { runReadinessSnapshot } = require('./lawn-protocol-readiness-cron');
      const result = await runReadinessSnapshot({ days: 14, limit: 100, source: 'scheduled_daily' });
      if (!result.skipped) {
        logger.info(`[lawn-protocol-readiness] ready=${result.ready || 0} warning=${result.warning || 0} blocked=${result.blocked || 0} appointments=${result.appointmentCount || 0}`);
      }
    } catch (err) {
      logger.error(`Lawn protocol readiness snapshot failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WaveGuard inventory forecast — proactive product shortage warning before
  // readiness starts blocking dispatch.
  // =========================================================================
  cron.schedule('45 5 * * *', async () => {
    try {
      const { runWaveGuardInventoryForecastCheck } = require('./waveguard-inventory-forecast');
      const result = await runWaveGuardInventoryForecastCheck({ days: 14, limit: 150, source: 'scheduled_daily' });
      if (!result.skipped) {
        logger.info(`[waveguard-inventory-forecast] ok=${result.ok || 0} warning=${result.warning || 0} short=${result.short || 0} unit_mismatch=${result.unit_mismatch || 0} not_tracked=${result.not_tracked || 0} products=${result.productCount || 0}`);
      }
    } catch (err) {
      logger.error(`WaveGuard inventory forecast check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 8AM — Tax Deadline Alerting (SMS reminders for upcoming filings)
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: tax deadline alert check');
    try {
      await runExclusive('tax-deadline-alerts', async () => {
      const now = new Date();
      const today = etDateString(now);
      const futureDate = etDateString(addETDays(now, 14));

      // Find filings due in the next 14 days that haven't been reminded yet
      const upcomingFilings = await db('tax_filing_calendar')
        .where('due_date', '>=', today)
        .where('due_date', '<=', futureDate)
        .whereNot('status', 'filed')
        .whereNot('status', 'paid')
        .where(function () {
          this.whereNull('reminder_sent_at')
            .orWhere('reminder_sent', false);
        })
        .orderBy('due_date');

      if (upcomingFilings.length === 0) {
        return;
      }

      // Build reminder message. due_date is a DATE column — pg hands it
      // back as midnight, so `new Date(f.due_date)` rendered in ET shows
      // the previous day. Anchor the calendar date at ET noon instead
      // (dateOnly + T12:00 pattern, same as admin-schedule.js) so both the
      // displayed date and the day-count math stay on the right ET day.
      const todayNoon = parseETDateTime(`${today}T12:00`);
      const lines = upcomingFilings.map(f => {
        const dueDate = parseETDateTime(`${dateOnlyString(f.due_date)}T12:00`);
        const daysUntil = Math.round((dueDate.getTime() - todayNoon.getTime()) / (24 * 60 * 60 * 1000));
        const amountStr = f.amount_due ? ` ($${parseFloat(f.amount_due).toLocaleString()})` : '';
        return `- ${f.title}${amountStr} — due ${dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })} (${daysUntil} day${daysUntil !== 1 ? 's' : ''})`;
      });

      const message = `Tax Deadline Alert:\n\n${lines.join('\n')}\n\nReview in the admin portal.`;

      // Send SMS to admin
      if (process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE, message, { messageType: 'internal_alert' });
        logger.info(`[tax-alerts] Sent ${upcomingFilings.length} deadline reminder(s) via SMS`);
      }

      // Mark reminders as sent
      const ids = upcomingFilings.map(f => f.id);
      await db('tax_filing_calendar')
        .whereIn('id', ids)
        .update({ reminder_sent: true, reminder_sent_at: new Date() });
      });
    } catch (err) {
      logger.error(`Tax deadline alert failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // SUNDAY 7AM — Weekly Tax Advisor report
  // =========================================================================
  cron.schedule('0 7 * * 0', async () => {
    try {
      const TaxAdvisor = require('./tax-advisor');
      const advisor = new TaxAdvisor();
      await advisor.generateWeeklyReport();
      logger.info('Tax Advisor weekly report generated');
    } catch (err) {
      logger.error(`Tax Advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 2AM — Recalculate customer health scores
  // =========================================================================
  cron.schedule('0 2 * * *', async () => {
    try {
      const { calculateAllHealthScores } = require('./customer-health-v2');
      const result = await calculateAllHealthScores();
      logger.info(`Health scores updated: ${result.updated} customers`);
    } catch (err) {
      logger.error(`Health score update failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // 28TH OF MONTH 10AM — Send billing reminders (for customers who opted in)
  // =========================================================================
  cron.schedule('0 10 28 * *', async () => {
    logger.info('Running: billing reminder job');
    try {
      await runExclusive('billing-reminders-28th', async () => {
      const customers = await db('customers')
        .join('notification_prefs', 'customers.id', 'notification_prefs.customer_id')
        .where({ 'customers.active': true, 'notification_prefs.billing_reminder': true })
        .whereNull('customers.deleted_at')
        .whereNotNull('customers.monthly_rate')
        .select('customers.id', 'customers.monthly_rate', 'customers.first_name');

      for (const cust of customers) {
        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        const chargeDate = `${nextMonth.toLocaleDateString('en-US', { month: 'long', timeZone: 'America/New_York' })} 1`;

        try {
          await TwilioService.sendBillingReminder(cust.id, cust.monthly_rate, chargeDate);
        } catch (err) {
          logger.error(`Billing reminder failed for ${cust.id}: ${err.message}`);
        }
      }
      });
    } catch (err) {
      logger.error(`Billing reminder job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Process scheduled content (blog + social auto-publish)
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      const ContentScheduler = require('./content-scheduler');
      const result = await ContentScheduler.processScheduledPosts();
      if (result.blogCount > 0 || result.socialCount > 0) {
        logger.info(`Content scheduler: ${result.blogCount} blog(s), ${result.socialCount} social post(s) published`);
      }
      if (result.socialSkipped) {
        // social portion was skipped by feature flag — don't log noise
      }
      // Re-drive newsletter social shares stranded by a crash between
      // send-completion and the fire-and-forget share in sendCampaign.
      await ContentScheduler.retryStrandedNewsletterShares();
    } catch (err) {
      logger.error(`Content scheduler failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 1:20AM ET — Content registry maintenance.
  // Syncs the registry from the pinned GitHub Astro source, then refreshes
  // live HTTP/sitemap status for published/reconciled rows.
  // =========================================================================
  cron.schedule('20 1 * * *', async () => {
    try {
      const result = await runContentRegistryMaintenance();
      logger.info(`[content-registry] maintenance complete: sync=${JSON.stringify(result.sync)} live=${JSON.stringify(result.live)}`);
    } catch (err) {
      logger.error(`[content-registry] maintenance failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 4 HOURS — Check RSS feed for new blog posts → auto-post to social
  // =========================================================================
  cron.schedule('0 */4 * * *', async () => {
    const { SOCIAL_FLAGS } = require('./social-media');
    if (!SOCIAL_FLAGS.automationEnabled || !SOCIAL_FLAGS.rssAutopublish) {
      return; // silently skip — flags not enabled
    }
    logger.info('Running: RSS social media check');
    try {
      const SocialMediaService = require('./social-media');
      const result = await SocialMediaService.checkAndPublish();
      logger.info(`RSS social media check done: ${result.processed} new post(s) published`);
    } catch (err) {
      logger.error(`RSS social media check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 2 HOURS — Adjust ad budgets based on capacity
  // =========================================================================
  cron.schedule('0 */2 * * *', async () => {
    logger.info('Running: ad budget adjustment');
    try {
      const BudgetManager = require('./ads/budget-manager');
      await BudgetManager.adjustBudgets();
    } catch (err) {
      logger.error(`Ad budget adjustment failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 3AM — Customer Intelligence Pipeline
  // =========================================================================
  cron.schedule('0 3 * * *', async () => {
    logger.info('Running: customer intelligence pipeline');
    let step = 'step 1 (signal detection)';
    try {
      const SignalDetector = require('./customer-intelligence/signal-detector');
      const HealthScorer = require('./customer-intelligence/health-scorer');
      const RetentionEngine = require('./customer-intelligence/retention-engine');

      // Step 1: Detect signals
      const signalResult = await SignalDetector.detectAllSignals();
      logger.info(`Signals: ${signalResult.newSignals} new from ${signalResult.customersScanned} customers`);

      // Step 2: Score health
      step = 'step 2 (health scoring)';
      const healthResult = await HealthScorer.calculateAllHealthScores();
      logger.info(`Health: ${healthResult.atRisk} at-risk, ${healthResult.critical} critical`);

      // Step 3: Generate retention outreach for at-risk customers
      step = 'step 3 (retention outreach)';
      const today = etDateString();
      const atRisk = await db('customer_health_scores')
        .where('scored_at', today)
        .whereIn('churn_risk', ['at_risk', 'critical'])
        .select('customer_id');

      let outreachGenerated = 0;
      for (const c of atRisk) {
        const result = await RetentionEngine.generateRetentionOutreach(c.customer_id);
        if (result) outreachGenerated++;
      }

      logger.info(`Customer intelligence complete: ${outreachGenerated} outreach generated`);
    } catch (err) {
      logger.error(`Customer intelligence pipeline failed at ${step}: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY — Verify CSR follow-up tasks
  // =========================================================================
  cron.schedule('30 * * * *', async () => {
    logger.info('Running: follow-up task verification');
    try {
      const CSRCoach = require('./csr/csr-coach');
      await CSRCoach.verifyFollowUps();
    } catch (err) {
      logger.error(`Follow-up verification failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // FRIDAY 8AM — Weekly CSR team recommendation
  // =========================================================================
  cron.schedule('0 8 * * 5', async () => {
    logger.info('Running: weekly CSR recommendation');
    try {
      const CSRCoach = require('./csr/csr-coach');
      const rec = await CSRCoach.generateWeeklyTeamRecommendation();
      if (rec.recommendation && TwilioService && process.env.ADAM_PHONE) {
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📊 Weekly CSR Tip:\n\n${rec.recommendation}\n\n${rec.dataPoint}\n${rec.estimatedImpact}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (err) {
      logger.error(`Weekly CSR rec failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

// =========================================================================
  // DAILY 5AM — Auto-generate next blog post content
  // =========================================================================
  cron.schedule('0 5 * * *', async () => {
    logger.info('Running: blog post auto-generation');
    try {
      const BlogWriter = require('./content/blog-writer');
      const nextPost = await db('blog_posts')
        .where('status', 'queued')
        .whereNull('content')
        .orderBy('publish_date', 'asc')
        .first();

      if (nextPost) {
        await BlogWriter.generatePost(nextPost.id);
        logger.info(`Blog auto-generated: "${nextPost.title}"`);
      }
    } catch (err) {
      logger.error(`Blog auto-generation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 6AM — Full blog content audit
  // =========================================================================
  cron.schedule('0 6 * * 0', async () => {
    logger.info('Running: blog content audit');
    try {
      const BlogAuditor = require('./content/blog-auditor');
      const audit = await BlogAuditor.runFullAudit();
      await db('ai_audits').insert({
        audit_type: 'blog_content',
        audit_date: new Date(),
        report_data: JSON.stringify(audit),
        recommendation_count: audit.recommendations?.length || 0,
        critical_issues: audit.duplicates?.length || 0,
        status: 'completed',
      });
    } catch (err) {
      logger.error(`Blog audit failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // MONTHLY 1ST 6AM — Generate 20 new blog post ideas
  // =========================================================================
  cron.schedule('0 6 1 * *', async () => {
    logger.info('Running: blog idea generation');
    try {
      const BlogWriter = require('./content/blog-writer');
      const ideas = await BlogWriter.generateNewIdeas(20);
      logger.info(`Generated ${ideas.length} new blog post ideas`);
    } catch (err) {
      logger.error(`Blog idea generation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM — Google Ads sync (campaigns, performance, search terms)
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    try {
      const googleAds = require('./ads/google-ads');
      if (!googleAds.isConfigured()) return;
      logger.info('Running: Google Ads daily sync');
      await googleAds.syncCampaigns();
      await googleAds.syncDailyPerformance(7);
      await googleAds.syncSearchTerms(30);
      logger.info('Google Ads daily sync complete');
    } catch (err) {
      logger.error(`Google Ads sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM — Sync Google Search Console data (hub + all spoke domains)
  //
  // syncAllDomains walks NETWORK_DOMAINS in order (hub first) and catches
  // per-domain errors, so one bad spoke property never blocks the rest.
  // A hub failure is critical (wavespestcontrol.com is the primary site) and
  // triggers the seo_sync_failed notification; spoke failures are logged.
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    logger.info('Running: GSC data sync (all domains)');
    try {
      const SearchConsole = require('./seo/search-console-v2');
      const results = await SearchConsole.syncAllDomains(3);
      const failed = results.filter(r => !r.synced);
      logger.info(`GSC sync: ${results.length - failed.length}/${results.length} domains synced`);
      const hubFailure = failed.find(r => r.domain === 'wavespestcontrol.com');
      if (failed.length) {
        logger.error(`GSC sync failures: ${failed.map(r => `${r.domain} (${r.error || 'unknown'})`).join('; ')}`);
      }
      if (hubFailure) {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('seo_sync_failed', { source: 'GSC', reason: `hub sync failed: ${hubFailure.error || 'unknown'}` });
      }
    } catch (err) {
      logger.error(`GSC sync failed: ${err.message}`);
      try {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('seo_sync_failed', { source: 'GSC', reason: err.message });
      } catch { /* notify best-effort */ }
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM ET — Estimate expiration (Estimates v2 spec §5)
  // Flips sent/viewed estimates past ESTIMATE_EXPIRATION_DAYS (default 7) to
  // expired; also flips anything past explicit expires_at.
  // =========================================================================
  cron.schedule('0 6 * * *', async () => {
    logger.info('Running: Estimate expiration sweep');
    try {
      const { runEstimateExpiration } = require('./estimate-expiration');
      await runEstimateExpiration();
    } catch (err) {
      logger.error(`Estimate expiration sweep failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:10AM ET — Document request lifecycle
  // Marks expired e-sign document requests and sends due reminders for
  // requests that were already delivered through email/SMS.
  // =========================================================================
  cron.schedule('10 6 * * *', async () => {
    logger.info('Running: document request lifecycle');
    try {
      const { processDocumentWorkflow } = require('./document-contract-delivery');
      const result = await processDocumentWorkflow();
      logger.info(`Document workflow done: ${result.expired || 0} expired, ${result.reminders?.sent || 0} reminder(s) sent, ${result.reminders?.failed || 0} failed`);
    } catch (err) {
      logger.error(`Document request lifecycle failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6AM ET — Credential expiry check (credentials v1 §7)
  // Scans business_credentials for anything expiring within 60 days; fires a
  // `credential_expiring_soon` notification per credential (deduped 7d).
  // =========================================================================
  cron.schedule('5 6 * * *', async () => {
    logger.info('Running: Credential expiry check');
    try {
      const { runCredentialExpiryCheck } = require('./credential-expiry-checker');
      await runCredentialExpiryCheck();
    } catch (err) {
      logger.error(`Credential expiry check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6:30AM — Sync Google Business Profile performance metrics
  // =========================================================================
  cron.schedule('30 6 * * *', async () => {
    logger.info('Running: GBP performance sync');
    try {
      const GoogleBusiness = require('./google-business');
      await GoogleBusiness.syncPerformanceDaily(3);
    } catch (err) {
      logger.error(`GBP performance sync failed: ${err.message}`);
      try {
        const { triggerNotification } = require('./notification-triggers');
        await triggerNotification('seo_sync_failed', { source: 'GBP', reason: err.message });
      } catch { /* notify best-effort */ }
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // HOURLY — Sync Google review content from Places API
  // GBP performance sync (above) handles impressions / views, NOT review
  // text. Without this hourly sync, the google_reviews table only ever
  // contained the aggregate `_stats` rows seeded by syncAllReviews on
  // first run, so the Reviews tab kept saying "0 reviews" while the GBP
  // total counter climbed each time someone left feedback. The route
  // handler at POST /api/admin/reviews/sync still exists for manual
  // re-pulls — this just makes "Sync Reviews" no longer the only way
  // for reviews to appear in the portal.
  // =========================================================================
  cron.schedule('0 * * * *', async () => {
    logger.info('Running: Google review content sync');
    try {
      const GoogleBusiness = require('./google-business');
      const result = await GoogleBusiness.syncAllReviews();
      logger.info(`Review sync done: ${result.synced || 0} synced, ${result.new || 0} new`);
    } catch (err) {
      logger.error(`Review sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 8AM — AI Campaign Advisor (includes paid + organic)
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: AI campaign advisor');
    try {
      const CampaignAdvisor = require('./ads/campaign-advisor');
      await CampaignAdvisor.generateDailyAdvice();
    } catch (err) {
      logger.error(`AI campaign advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 7AM — SEO Advisor (deep GSC + GBP analysis)
  // =========================================================================
  cron.schedule('0 7 * * 1', async () => {
    logger.info('Running: Weekly SEO Advisor');
    try {
      const SEOAdvisor = require('./seo/seo-advisor');
      await SEOAdvisor.generateWeeklyReport();
    } catch (err) {
      logger.error(`SEO Advisor failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 7AM — Token / Credential Health Check + SMS alert on failures
  // =========================================================================
  cron.schedule('0 7 * * *', async () => {
    logger.info('Running: token credential health check');
    try {
      const tokenHealth = require('./token-health');
      const results = await tokenHealth.checkAll();
      const failures = results.filter(r => r.status === 'expired' || r.status === 'error');
      if (failures.length > 0) {
        const msg = `⚠️ Token Alert: ${failures.length} credential(s) need attention:\n` +
          failures.map(f => `- ${f.platform}: ${f.status} — ${f.lastError || 'check dashboard'}`).join('\n');
        await TwilioService.sendSMS(process.env.ADAM_PHONE || '+19415993489', msg, { messageType: 'internal_alert', skipLogo: true });
      }
      logger.info(`Token health check done: ${failures.length} failure(s) out of ${results.length}`);
    } catch (err) {
      logger.error(`Token health check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 3:30AM — Auto-sync Knowledge Base from live data (products, protocols, pricing, COGS)
  // =========================================================================
  cron.schedule('30 3 * * *', async () => {
    logger.info('Running: Knowledge Base auto-sync');
    try {
      const KBService = require('./knowledge-base');
      const result = await KBService.autoSync();
      logger.info(`KB auto-sync done: ${result.created} created, ${result.updated} updated, ${result.skipped} unchanged`);
    } catch (err) {
      logger.error(`KB auto-sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY FRIDAY 7 AM — AI Knowledge Base Audit ("Question Your Assumptions")
  // Reviews stale and low-confidence entries via Claude, flags anything outdated.
  // =========================================================================
  cron.schedule('0 7 * * 5', async () => {
    logger.info('Running: Knowledge Base AI audit');
    try {
      const KBService = require('./knowledge-base');
      const result = await KBService.runAIAudit({ maxEntries: 15 });
      logger.info(`KB AI audit done: ${result.audited} reviewed, ${result.flagged} flagged`);

      // Admin notification summary if anything was flagged.
      if (result.flagged > 0) {
        try {
          const flaggedEntries = result.results
            .filter(r => r.status === 'flag' || r.status === 'update-needed')
            .map(r => ({ id: r.id, title: r.title, summary: r.summary, status: r.status }));
          const { triggerNotification } = require('./notification-triggers');
          await triggerNotification('kb_audit_flagged', {
            count: result.flagged,
            audited: result.audited,
            entries: flaggedEntries,
          });
        } catch (err) {
          logger.error(`KB AI audit notification failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`KB AI audit failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 5 MIN — Process any pending call recordings
  // =========================================================================
  cron.schedule('*/5 * * * *', async () => {
    try {
      const processor = require('./call-recording-processor');
      if (processor.recoverMissingRecentRecordings) await processor.recoverMissingRecentRecordings();
      if (processor.processAllPending) await processor.processAllPending();
    } catch (e) { logger.error(`Recording batch process failed: ${e.message}`); }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // EVERY 15 MIN — Send scheduled review request SMS
  // Picks up review requests whose scheduled_for has passed.
  // =========================================================================
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runExclusive('review-requests-scheduled', async () => {
        const ReviewService = require('./review-request');
        const result = await ReviewService.processScheduled();
        if (result.sent > 0) logger.info(`Review requests processed: ${result.sent} sent`);
      });
    } catch (err) {
      logger.error(`Review request processing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10:00AM — Review follow-up reminders (Day 3 after initial request)
  // Lands the followup on the 3rd ET-calendar-day after the original review
  // SMS was sent. Eligibility logic is in processFollowups().
  // =========================================================================
  cron.schedule('0 10 * * *', async () => {
    logger.info('Running: review follow-up reminders');
    try {
      await runExclusive('review-followups', async () => {
        const ReviewService = require('./review-request');
        const result = await ReviewService.processFollowups();
        logger.info(`Review follow-ups done: ${result.sent} sent`);
      });
    } catch (err) {
      logger.error(`Review follow-up failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 6AM — Agronomic Wiki refresh (stale pages + seasonal)
  // =========================================================================
  cron.schedule('0 6 * * 0', async () => {
    logger.info('Running: agronomic wiki weekly refresh');
    try {
      const wiki = require('./agronomic-wiki');
      const result = await wiki.weeklyRefresh();
      logger.info(`Agronomic wiki refresh done: ${result.refreshed} pages refreshed`);
    } catch (err) {
      logger.error(`Agronomic wiki refresh failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // NIGHTLY 2:15AM — Customer Health Scoring v3 (churn prediction engine)
  // =========================================================================
  cron.schedule('15 2 * * *', async () => {
    logger.info('Running: customer health scoring v3');
    try {
      const { scoreAllCustomers } = require('./customer-health');
      const result = await scoreAllCustomers();
      logger.info(`Health scoring v3 complete: ${result.scored} scored, ${result.failed} failed`);
    } catch (err) {
      logger.error(`Health scoring v3 failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY SUNDAY 4AM — Cleanup health history older than 365 days
  // =========================================================================
  cron.schedule('0 4 * * 0', async () => {
    logger.info('Running: health history cleanup');
    try {
      const cutoff = etDateString(addETDays(new Date(), -365));
      const deleted = await db('customer_health_history').where('scored_at', '<', cutoff).del();
      logger.info(`Health history cleanup: ${deleted} old records deleted`);
    } catch (err) {
      logger.error(`Health history cleanup failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // TIME TRACKING CRONS (daily summaries, weekly summaries, auto clock-out)
  // =========================================================================
  try {
    const { initTimeTrackingCrons } = require('./time-tracking-crons');
    initTimeTrackingCrons();
    logger.info('Time tracking crons initialized');
  } catch (err) {
    logger.error(`Time tracking crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // EQUIPMENT MAINTENANCE CRONS (nightly checks, warranty alerts)
  // =========================================================================
  try {
    const { initEquipmentCrons } = require('./equipment-crons');
    initEquipmentCrons();
    logger.info('Equipment maintenance crons initialized');
  } catch (err) {
    logger.error(`Equipment crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // STRIPE BILLING — Monthly autopay + payment retries
  //
  // Runs DAILY at 8 AM ET. processMonthlyBilling() walks every active
  // autopay customer and skips those whose billing_day !== today, so the
  // per-customer `billing_day` (1–28) the AutopayCard exposes actually
  // fires on the day the customer picked. Previously this cron ran only
  // on the 1st, which meant any customer with billing_day !== 1 was
  // never charged at all — silent revenue loss. The idempotency guard
  // (existingCharge query in billing-cron.js) keeps the daily cadence
  // safe against re-running on the same calendar day.
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: monthly billing (Stripe)');
    try {
      // Belt over the idempotency keys: serializes the whole sweep so
      // overlapping deploy instances don't even race the per-customer
      // existingCharge check.
      await runExclusive('billing-monthly', async () => {
        const BillingCron = require('./billing-cron');
        const result = await BillingCron.processMonthlyBilling();
        logger.info(`Monthly billing done: ${result.charged} charged, ${result.failed} failed, ${result.skipped} skipped`);
      });
    } catch (err) {
      logger.error(`Monthly billing failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  cron.schedule('0 10 * * *', async () => {
    try {
      await runExclusive('billing-retries', async () => {
        const BillingCron = require('./billing-cron');
        const result = await BillingCron.processPaymentRetries();
        if (result.retried > 0) logger.info(`Payment retries: ${result.retried} retried, ${result.succeeded} succeeded`);
      });
    } catch (err) {
      logger.error(`Payment retry failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Autopay pre-charge reminders — daily 9 AM, 3 days before scheduled charge
  cron.schedule('0 9 * * *', async () => {
    try {
      await runExclusive('autopay-pre-charge-reminders', async () => {
        const { sendPreChargeReminders } = require('./autopay-notifications');
        const r = await sendPreChargeReminders();
        if (r.sent > 0) logger.info(`Autopay reminders: ${r.sent} sent`);
      });
    } catch (err) {
      logger.error(`Autopay pre-charge reminder failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // Card-expiry warnings — Monday 9 AM, cards expiring within 60 days
  cron.schedule('0 9 * * 1', async () => {
    try {
      await runExclusive('card-expiry-warnings', async () => {
        const { sendCardExpiryWarnings } = require('./autopay-notifications');
        const r = await sendCardExpiryWarnings();
        if (r.sent > 0) logger.info(`Card-expiry warnings: ${r.sent} sent`);
      });
    } catch (err) {
      logger.error(`Card-expiry warnings failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // BOUNCIE MILEAGE CRONS (daily sync, monthly summary, trip re-matching)
  // =========================================================================
  try {
    const { initBouncieMileageCrons } = require('./bouncie-mileage-crons');
    initBouncieMileageCrons();
    logger.info('Bouncie mileage crons initialized');
  } catch (err) {
    logger.error(`Bouncie mileage crons failed to init: ${err.message}`);
  }

  // =========================================================================
  // DAILY 9AM — Payment expiry check (cards expiring this/next month)
  // =========================================================================
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running: payment expiry check');
    try {
      await runExclusive('payment-expiry-check', async () => {
        const paymentExpiry = require('./workflows/payment-expiry');
        if (paymentExpiry.checkExpiringCards) {
          const result = await paymentExpiry.checkExpiringCards();
          logger.info(`Payment expiry check done: ${result.notified} notified, ${result.totalExpiring} expiring`);
        }
      });
    } catch (err) {
      logger.error(`Payment expiry check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 6PM — Missed appointment check
  // =========================================================================
  cron.schedule('0 18 * * *', async () => {
    logger.info('Running: missed appointment check');
    try {
      // The reschedule_log dedupe below is check-then-insert — overlapping
      // deploy instances would both pass it and double-count a no-show.
      await runExclusive('missed-appointment-check', async () => {
      const missedAppointment = require('./workflows/missed-appointment');
      if (missedAppointment.onSkip) {
        // Find recent services that were scheduled but not completed.
        // In-progress statuses (en_route / on_site) are intentionally
        // excluded along with completed/cancelled/skipped/rescheduled —
        // a tech actively on the job is not a no-show. The range reaches
        // back to yesterday so evening windows that hadn't elapsed at
        // yesterday's 6 PM sweep — and genuinely closed as no-shows —
        // are picked up today instead of never counting.
        const today = etDateString();
        const yesterday = etDateString(addETDays(new Date(), -1));
        const candidates = await db('scheduled_services')
          .whereBetween('scheduled_date', [yesterday, today])
          .whereIn('status', ['pending', 'confirmed'])
          .select('id', 'scheduled_date', 'window_start', 'window_end');

        // Only flag services whose arrival window has already elapsed at
        // sweep time. Evening jobs (e.g. a 6–8 PM window that completes at
        // 6:30 PM) are still legitimately pending at the 6 PM sweep and
        // must not accrue customer_noshow rows in reschedule_log — two of
        // those in 90 days trigger a false "we've missed you" outreach
        // task (see workflows/missed-appointment.js onSkip).
        const { hour, minute } = etParts();
        const nowET = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        const windowHasPassed = (svc) => {
          // Yesterday's windows have all elapsed by today's sweep.
          const svcDate = svc.scheduled_date instanceof Date
            ? svc.scheduled_date.toISOString().split('T')[0]
            : String(svc.scheduled_date).split('T')[0];
          if (svcDate < today) return true;
          // window_start/window_end are TIME columns ('HH:MM:SS' strings).
          const cutoff = svc.window_end || svc.window_start;
          if (!cutoff) return true; // no window recorded — legacy behavior
          return String(cutoff).slice(0, 5) <= nowET;
        };

        let flagged = 0;
        for (const svc of candidates) {
          if (!windowHasPassed(svc)) continue;
          // onSkip inserts a reschedule_log row unconditionally — with the
          // sweep spanning two days, a service yesterday's pass already
          // flagged must not be re-flagged toward the
          // 2-noshows-in-90-days outreach trigger.
          const alreadyFlagged = await db('reschedule_log')
            .where({ scheduled_service_id: svc.id, reason_code: 'customer_noshow' })
            .first('id');
          if (alreadyFlagged) continue;
          try {
            await missedAppointment.onSkip(svc.id, 'no_show');
            flagged++;
          } catch (skipErr) {
            logger.error(`Missed appointment onSkip failed for ${svc.id}: ${skipErr.message}`);
          }
        }
        logger.info(`Missed appointment check done: ${candidates.length} candidate(s), ${flagged} flagged as no-show`);
      }
      });
    } catch (err) {
      logger.error(`Missed appointment check failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 10AM — Renewal reminders (termite bond, mosquito season, WaveGuard)
  // =========================================================================
  cron.schedule('0 10 * * *', async () => {
    logger.info('Running: renewal reminders');
    try {
      await runExclusive('renewal-reminders', async () => {
        const renewalReminder = require('./workflows/renewal-reminder');
        if (renewalReminder.checkAndSend) {
          const result = await renewalReminder.checkAndSend();
          logger.info(`Renewal reminders done: ${result.sent} sent`);
        }
      });
    } catch (err) {
      logger.error(`Renewal reminders failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // WEEKLY MONDAY 10AM — Seasonal reactivation campaign
  // =========================================================================
  cron.schedule('0 10 * * 1', async () => {
    logger.info('Running: seasonal reactivation campaign');
    try {
      await runExclusive('seasonal-reactivation', async () => {
        const seasonalReactivation = require('./workflows/seasonal-reactivation');
        if (seasonalReactivation.run) {
          const result = await seasonalReactivation.run();
          logger.info(`Seasonal reactivation done: ${result.sent} sent (month ${result.month}, type: ${result.hookType})`);
        }
      });
    } catch (err) {
      logger.error(`Seasonal reactivation failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // DAILY 11AM — Balance reminders (upcoming services with outstanding balance)
  // =========================================================================
  cron.schedule('0 11 * * *', async () => {
    logger.info('Running: balance reminders');
    try {
      await runExclusive('balance-reminders', async () => {
        const balanceReminder = require('./workflows/balance-reminder');
        if (balanceReminder.dailyCheck) {
          await balanceReminder.dailyCheck();
        }
        if (balanceReminder.latePaymentCheck) {
          await balanceReminder.latePaymentCheck();
        }
      });
    } catch (err) {
      logger.error(`Balance reminders failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // GA4 ANALYTICS CRONS (daily sync)
  // =========================================================================
  try {
    const { initGA4Crons } = require('./analytics/ga4-crons');
    initGA4Crons();
    logger.info('GA4 analytics crons initialized');
  } catch (err) {
    logger.error(`GA4 crons failed to init: ${err.message}`);
  }

  // DAILY 1AM — Terminal handoff tokens cleanup
  //
  // Rows expire after 60s of mint. The 1-hour post-expiry buffer is
  // intentional: if a tech reports "the charge didn't go through" within the
  // next hour, support can still inspect whether the token was minted /
  // validated / never used. Anything beyond 1h is forensics we'd read from
  // audit_log anyway.
  //
  // Multi-instance safety: DELETE is idempotent — concurrent runs on
  // Railway replicas just race and one wins. If we ever add a non-idempotent
  // daily job, introduce a cron_leases table with SELECT ... FOR UPDATE
  // SKIP LOCKED first. Don't copy this pattern blindly.
  cron.schedule('0 1 * * *', async () => {
    const started = Date.now();
    try {
      const deleted = await db('terminal_handoff_tokens')
        .where('expires_at', '<', db.raw("NOW() - INTERVAL '1 hour'"))
        .del();
      logger.info(`[terminal-cleanup] ok — deleted ${deleted} expired handoff token(s) in ${Date.now() - started}ms`);
    } catch (err) {
      logger.error(`[terminal-cleanup] failed after ${Date.now() - started}ms: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Orphaned-validated handoff sweeper
  //
  // Targets rows where /validate-handoff burned the jti but /payment-intent
  // was never called (tech's iOS app crashed post-validate, user backed out
  // of the charge screen, network dropped between apps, etc.). 15-minute
  // threshold is deliberately longer than a realistic Tap to Pay flow
  // (20-60s of tech-customer interaction + charge) but short enough that
  // these rows don't accumulate and silently chew the per-tech rate-limit
  // budget.
  //
  // The partial index terminal_handoff_tokens_orphaned_validated_idx covers
  // exactly this WHERE clause — it's a direct index scan, not a table scan.
  // Cheap enough to run every 5 minutes on Railway's shared Postgres.
  //
  // Note: the daily 1AM cleanup above catches these rows eventually (via
  // expires_at), but only after 1h of post-expiry buffer. The 5-min sweeper
  // is specifically for the rate-limit-budget case.
  cron.schedule('*/5 * * * *', async () => {
    const started = Date.now();
    try {
      const deleted = await db('terminal_handoff_tokens')
        .whereNotNull('used_at')
        .whereNull('stripe_payment_intent_id')
        .where('used_at', '<', db.raw("NOW() - INTERVAL '15 minutes'"))
        .del();
      if (deleted > 0) {
        logger.info(`[terminal-sweeper] ok — deleted ${deleted} orphaned-validated handoff(s) in ${Date.now() - started}ms`);
      }
    } catch (err) {
      logger.error(`[terminal-sweeper] failed after ${Date.now() - started}ms: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Tech-late detector (first dispatch alert generator)
  //
  // Reads scheduled_services for jobs whose ET promised arrival due
  // time (at least window_start + 2 hours, or later window_end) has
  // passed by ≥ 30 min while the tech hasn't moved to on_site /
  // completed / cancelled / skipped, and inserts a tech_late
  // dispatch_alert via
  // createAlert (which fans out the dispatch:alert socket broadcast
  // post-commit so the Action Queue right pane updates in real time).
  //
  // Idempotent: skips jobs that already have an unresolved tech_late
  // alert. After the dispatcher resolves a warn, the next tick fires
  // a fresh critical if the job is still late — natural escalation
  // without in-place row mutation.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runTechLateCheck } = require('./tech-late-detector');
      await runTechLateCheck();
    } catch (err) {
      logger.error(`[tech-late-detector] tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // EVERY 5 MIN — Unassigned-overdue detector (second alert generator)
  //
  // Same shape as tech-late-detector but scopes to jobs with
  // technician_id IS NULL. Fires unassigned_overdue alerts when an
  // unassigned job's promised arrival due time (at least window_start
  // + 2 hours, or later window_end) has passed by ≥ 30 min and the
  // job is still pre-terminal. Severity bands: 30–59 → warn, ≥ 60 →
  // critical. Partial unique index closes the cross-process race
  // (migration 20260427000003).
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runUnassignedOverdueCheck } = require('./unassigned-overdue-detector');
      await runUnassignedOverdueCheck();
    } catch (err) {
      logger.error(`[unassigned-overdue-detector] tick failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  logger.info('Scheduled jobs initialized');
}

// Banking sync is a passive Stripe→DB mirror with no customer-facing side
// effects (webhooks already handle real-time updates; this is the catch-up
// safety net). It runs UNGATED so missed payout.* events still get backfilled
// even when GATE_CRON_JOBS is off — matching the behavior of the legacy
// 15-min setInterval that previously lived in server/index.js.
function initBankingSync() {
  cron.schedule('0 8,20 * * *', async () => {
    try {
      const StripeBanking = require('./stripe-banking');
      const result = await StripeBanking.syncPayouts(50);
      logger.info(`[stripe-banking] Scheduled sync: ${result.synced} payouts`);
    } catch (err) {
      logger.error(`[stripe-banking] Scheduled sync failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });
}

module.exports = {
  initScheduledJobs,
  initBankingSync,
  purposeForScheduledMessageType,
  runContentRegistryMaintenance,
  runAutonomousOpportunityMining,
  parseListEnv,
  parsePositiveEnvInt,
  claimDueScheduledEstimates,
  recoverStaleScheduledEstimateClaims,
  markScheduledEstimateSendFailure,
};
