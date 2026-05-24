const logger = require('../logger');
const UrlIntelligence = require('./url-intelligence');
const {
  completePipelineRun,
  failPipelineRun,
  heartbeatPipelineRun,
} = require('./seo-pipeline-runs');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;
const DEFAULT_GSC_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

function errorMessage(err) {
  return err?.message || String(err || 'Unknown error');
}

function positiveInt(value, fallback) {
  const ms = parseInt(value, 10);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

function heartbeatIntervalMs(value = process.env.SEO_PIPELINE_HEARTBEAT_INTERVAL_MS) {
  return positiveInt(value, DEFAULT_HEARTBEAT_INTERVAL_MS);
}

function gscSyncTimeoutMs(value = process.env.SEO_PIPELINE_GSC_SYNC_TIMEOUT_MS) {
  return positiveInt(value, DEFAULT_GSC_SYNC_TIMEOUT_MS);
}

function progressPayload({ steps, start, currentStep, options = null, extra = {} }) {
  return {
    current_step: currentStep,
    steps,
    duration_ms: Date.now() - start,
    ...(options ? { options } : {}),
    ...extra,
  };
}

async function heartbeat(pipelineRun, state, currentStep, extra = {}) {
  state.currentStep = currentStep;
  await heartbeatPipelineRun(
    pipelineRun.id,
    progressPayload({
      steps: state.steps,
      start: state.start,
      currentStep,
      options: state.options,
      extra,
    }),
  );
}

async function withHeartbeatInterval({ work, beat, logPrefix, step }) {
  let inFlight = null;
  const sendBeat = () => {
    if (inFlight) return;
    inFlight = beat()
      .catch((err) => logger.warn(`[${logPrefix}] heartbeat failed during ${step}: ${err.message}`))
      .finally(() => { inFlight = null; });
  };

  const timer = setInterval(sendBeat, heartbeatIntervalMs());
  try {
    return await work();
  } finally {
    clearInterval(timer);
    if (inFlight) await inFlight;
  }
}

async function withTimeout({ work, timeoutMs, message }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  try {
    return await Promise.race([
      work(controller?.signal || null),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(message);
          if (controller) controller.abort(err);
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runStep({ pipelineRun, state, step, label, logPrefix, fn }) {
  logger.info(`[${logPrefix}] ${label}`);
  await heartbeat(pipelineRun, state, step);
  try {
    const result = await withHeartbeatInterval({
      work: fn,
      beat: () => heartbeat(pipelineRun, state, step),
      logPrefix,
      step,
    });
    const entry = { step, status: 'ok', ...(result || {}) };
    state.steps.push(entry);
    await heartbeat(pipelineRun, state, step);
    return entry;
  } catch (err) {
    const entry = { step, status: 'failed', error: errorMessage(err) };
    state.steps.push(entry);
    logger.warn(`[${logPrefix}] ${step} failed: ${entry.error}`);
    await heartbeat(pipelineRun, state, step);
    return entry;
  }
}

async function runClaimedSeoPipeline({ pipelineRun, domain, daysBack = 7, logPrefix = 'pipeline' }) {
  const state = {
    steps: [],
    start: Date.now(),
    currentStep: null,
    options: { days_back: daysBack },
  };

  try {
    await runStep({
      pipelineRun,
      state,
      step: 'gsc_sync',
      label: `Step 1/8: GSC sync for ${domain}`,
      logPrefix,
      fn: async () => {
        const SearchConsole = require('./search-console-v2');
        const timeoutMs = gscSyncTimeoutMs();
        const detail = await withTimeout({
          work: (signal) => SearchConsole.syncDailyData(daysBack, domain, { signal }),
          timeoutMs,
          message: `GSC sync timed out after ${timeoutMs}ms`,
        });
        return { detail };
      },
    });

    await runStep({
      pipelineRun,
      state,
      step: 'site_audit',
      label: `Step 2/8: Site audit for ${domain}`,
      logPrefix,
      fn: async () => {
        const SiteAuditor = require('./site-auditor');
        const auditResult = await SiteAuditor.runSiteAudit({
          domain,
          onProgress: (progress) => heartbeat(pipelineRun, state, 'site_audit', { site_audit: progress }),
        });
        return { pages: Number(auditResult?.pages || 0) };
      },
    });

    await runStep({
      pipelineRun,
      state,
      step: 'url_intelligence_refresh',
      label: `Step 3/8: URL Intelligence refresh for ${domain}`,
      logPrefix,
      fn: async () => UrlIntelligence.refreshDomain(domain),
    });

    await runStep({
      pipelineRun,
      state,
      step: 'sitemap_validation',
      label: `Step 4/8: Sitemap validation for ${domain}`,
      logPrefix,
      fn: async () => {
        const SitemapValidator = require('./sitemap-validator');
        return SitemapValidator.validateDomain(domain);
      },
    });

    await runStep({
      pipelineRun,
      state,
      step: 'duplicate_detection',
      label: `Step 5/8: Duplicate detection for ${domain}`,
      logPrefix,
      fn: async () => UrlIntelligence.buildDuplicateClusters(domain),
    });

    logger.info(`[${logPrefix}] Step 6/8: Intent map + link graph for ${domain}`);
    await heartbeat(pipelineRun, state, 'intent_map_and_link_graph');
    const [intentResult, linkResult] = await withHeartbeatInterval({
      work: () => Promise.allSettled([
        UrlIntelligence.buildIntentMap(domain),
        UrlIntelligence.buildInternalLinkGraph(domain),
      ]),
      beat: () => heartbeat(pipelineRun, state, 'intent_map_and_link_graph'),
      logPrefix,
      step: 'intent_map_and_link_graph',
    });
    state.steps.push({
      step: 'intent_map',
      status: intentResult.status === 'fulfilled' ? 'ok' : 'failed',
      ...(intentResult.status === 'fulfilled' ? intentResult.value : { error: errorMessage(intentResult.reason) }),
    });
    state.steps.push({
      step: 'link_graph',
      status: linkResult.status === 'fulfilled' ? 'ok' : 'failed',
      ...(linkResult.status === 'fulfilled' ? linkResult.value : { error: errorMessage(linkResult.reason) }),
    });
    await heartbeat(pipelineRun, state, 'intent_map_and_link_graph');

    logger.info(`[${logPrefix}] Step 7/8: Cannibalization + canonical conflicts for ${domain}`);
    await heartbeat(pipelineRun, state, 'cannibalization_and_conflicts');
    const Cannibalization = require('./cannibalization');
    const [cannibalResult, conflictResult] = await withHeartbeatInterval({
      work: () => Promise.allSettled([
        Cannibalization.detect(domain),
        UrlIntelligence.detectCanonicalConflicts(),
      ]),
      beat: () => heartbeat(pipelineRun, state, 'cannibalization_and_conflicts'),
      logPrefix,
      step: 'cannibalization_and_conflicts',
    });
    state.steps.push({
      step: 'cannibalization',
      status: cannibalResult.status === 'fulfilled' ? 'ok' : 'failed',
      ...(cannibalResult.status === 'fulfilled' ? cannibalResult.value : { error: errorMessage(cannibalResult.reason) }),
    });
    state.steps.push({
      step: 'canonical_conflicts',
      status: conflictResult.status === 'fulfilled' ? 'ok' : 'failed',
      ...(conflictResult.status === 'fulfilled' ? conflictResult.value : { error: errorMessage(conflictResult.reason) }),
    });
    await heartbeat(pipelineRun, state, 'cannibalization_and_conflicts');

    logger.info(`[${logPrefix}] Step 8/8: Generate actions for ${domain}`);
    await heartbeat(pipelineRun, state, 'action_generation');
    try {
      const SeoActionGenerator = require('./seo-action-generator');
      const diagnosisResult = await withHeartbeatInterval({
        work: () => UrlIntelligence.refreshDiagnoses(domain),
        beat: () => heartbeat(pipelineRun, state, 'diagnosis_refresh'),
        logPrefix,
        step: 'diagnosis_refresh',
      });
      state.steps.push({ step: 'diagnosis_refresh', status: 'ok', ...diagnosisResult });
      await heartbeat(pipelineRun, state, 'diagnosis_refresh');
      const actionResult = await withHeartbeatInterval({
        work: () => SeoActionGenerator.generateActionsFromDiagnosis(domain),
        beat: () => heartbeat(pipelineRun, state, 'action_generation'),
        logPrefix,
        step: 'action_generation',
      });
      state.steps.push({ step: 'action_generation', status: 'ok', ...actionResult });
      await heartbeat(pipelineRun, state, 'action_generation');
      const autoResult = await withHeartbeatInterval({
        work: () => SeoActionGenerator.autoApprove(domain),
        beat: () => heartbeat(pipelineRun, state, 'auto_approve'),
        logPrefix,
        step: 'auto_approve',
      });
      state.steps.push({ step: 'auto_approve', status: 'ok', ...autoResult });
      await heartbeat(pipelineRun, state, 'auto_approve');
    } catch (err) {
      const entry = { step: 'action_generation', status: 'failed', error: errorMessage(err) };
      state.steps.push(entry);
      logger.warn(`[${logPrefix}] Action generation failed: ${entry.error}`);
      await heartbeat(pipelineRun, state, 'action_generation');
    }

    const duration = Date.now() - state.start;
    const succeeded = state.steps.filter((s) => s.status === 'ok').length;
    const failed = state.steps.filter((s) => s.status === 'failed').length;
    const status = failed > 0 ? 'completed_with_errors' : 'completed';
    const result = { steps: state.steps, duration_ms: duration, succeeded, failed };

    logger.info(`[${logPrefix}] Complete: ${succeeded} succeeded, ${failed} failed, ${duration}ms`, { steps: state.steps });
    await completePipelineRun(pipelineRun.id, result, status);
    return { status, ...result };
  } catch (err) {
    logger.error(`[${logPrefix}] Fatal error: ${errorMessage(err)}`, err);
    await failPipelineRun(pipelineRun.id, err)
      .catch((persistErr) => logger.warn(`[${logPrefix}] failed to persist fatal status: ${persistErr.message}`));
    throw err;
  }
}

module.exports = {
  runClaimedSeoPipeline,
  _internals: {
    errorMessage,
    gscSyncTimeoutMs,
    heartbeatIntervalMs,
    progressPayload,
    withHeartbeatInterval,
    withTimeout,
  },
};
