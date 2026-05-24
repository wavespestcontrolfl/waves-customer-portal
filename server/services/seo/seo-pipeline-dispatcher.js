const logger = require('../logger');
const {
  claimQueuedPipelineRun,
  enqueuePipelineRun,
} = require('./seo-pipeline-runs');
const { runClaimedSeoPipeline } = require('./seo-pipeline-runner');

function queueOnlyEnabled(value = process.env.SEO_PIPELINE_QUEUE_ONLY) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function pendingStatus(status) {
  return ['queued', 'running'].includes(status);
}

function runPayload({ run, idempotencyKey, deduped = false, message }) {
  return {
    status: run.status,
    domain: run.domain,
    idempotencyKey,
    deduped,
    run_id: run.id,
    started_at: run.started_at,
    completed_at: run.completed_at,
    result: run.result || null,
    ...(message ? { message } : {}),
  };
}

async function dispatchSeoPipeline({ domain, idempotencyKey, requestedBy, daysBack, logPrefix = 'pipeline' }) {
  const queued = await enqueuePipelineRun({
    domain,
    idempotencyKey,
    requestedBy,
    daysBack,
  });
  if (queued.error) return { error: queued.error, statusCode: 400 };

  const run = queued.run;
  if (!queueOnlyEnabled() && run.status === 'queued') {
    const claim = await claimQueuedPipelineRun({ id: run.id });
    if (claim.claimed) {
      runClaimedSeoPipeline({
        pipelineRun: claim.run,
        domain: claim.run.domain,
        daysBack,
        logPrefix,
      }).catch((err) => logger.error(`[${logPrefix}] background runner failed: ${err.message}`, err));

      return {
        statusCode: 202,
        payload: {
          ...runPayload({
            run: claim.run,
            idempotencyKey,
            deduped: !queued.enqueued,
            message: 'Pipeline running in background. Check /dashboard for results.',
          }),
          status: 'started',
        },
      };
    }
  }

  const isPending = pendingStatus(run.status);
  return {
    statusCode: isPending ? 202 : 200,
    payload: runPayload({
      run,
      idempotencyKey,
      deduped: !queued.enqueued,
      message: run.status === 'queued'
        ? 'Pipeline queued. A worker will process it; check /dashboard for results.'
        : undefined,
    }),
  };
}

module.exports = {
  dispatchSeoPipeline,
  _internals: {
    pendingStatus,
    queueOnlyEnabled,
    runPayload,
  },
};
