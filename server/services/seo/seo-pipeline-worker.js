const logger = require('../logger');
const {
  DEFAULT_PIPELINE_DAYS_BACK,
  claimQueuedPipelineRun,
} = require('./seo-pipeline-runs');
const { runClaimedSeoPipeline } = require('./seo-pipeline-runner');

const DEFAULT_WORKER_POLL_MS = 30000;

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function workerPollMs(value = process.env.SEO_PIPELINE_WORKER_POLL_MS) {
  return positiveInt(value, DEFAULT_WORKER_POLL_MS);
}

function runDaysBack(run) {
  return positiveInt(
    run?.result?.options?.days_back || run?.result?.days_back,
    DEFAULT_PIPELINE_DAYS_BACK,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processNextQueuedPipelineRun({
  logPrefix = 'seo-pipeline-worker',
  onClaimed = null,
  onSettled = null,
} = {}) {
  const claim = await claimQueuedPipelineRun();
  if (!claim.claimed || !claim.run) {
    return { status: 'idle' };
  }

  const run = claim.run;
  const daysBack = runDaysBack(run);
  if (onClaimed) await onClaimed(run);
  logger.info(`[${logPrefix}] claimed SEO pipeline run ${run.id} for ${run.domain}`);

  try {
    const result = await runClaimedSeoPipeline({
      pipelineRun: run,
      domain: run.domain,
      daysBack,
      logPrefix,
    });

    return {
      status: result.status,
      run_id: run.id,
      domain: run.domain,
      daysBack,
      succeeded: result.succeeded,
      failed: result.failed,
      duration_ms: result.duration_ms,
    };
  } finally {
    if (onSettled) onSettled(run);
  }
}

async function runSeoPipelineWorker({
  once = false,
  pollMs = workerPollMs(),
  logPrefix = 'seo-pipeline-worker',
  shouldStop = () => false,
  onClaimed = null,
  onSettled = null,
} = {}) {
  while (!shouldStop()) {
    try {
      const result = await processNextQueuedPipelineRun({ logPrefix, onClaimed, onSettled });
      if (once) return result;
      if (result.status !== 'idle') continue;
    } catch (err) {
      logger.error(`[${logPrefix}] worker iteration failed: ${err.message}`, err);
      if (once) throw err;
    }

    await sleep(pollMs);
  }

  return { status: 'stopped' };
}

module.exports = {
  DEFAULT_WORKER_POLL_MS,
  processNextQueuedPipelineRun,
  runSeoPipelineWorker,
  _internals: {
    positiveInt,
    runDaysBack,
    workerPollMs,
  },
};
