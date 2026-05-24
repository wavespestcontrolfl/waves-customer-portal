#!/usr/bin/env node

const db = require('../models/db');
const { releasePipelineRun } = require('../services/seo/seo-pipeline-runs');
const { runSeoPipelineWorker } = require('../services/seo/seo-pipeline-worker');

const DEFAULT_RELEASE_DELAY_SECONDS = 120;

let stopping = false;
let activeRun = null;
let shutdownPromise = null;
let shutdownSignal = null;

function releaseDelaySeconds(value = process.env.SEO_PIPELINE_RELEASE_DELAY_SECONDS) {
  const seconds = parseInt(value, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RELEASE_DELAY_SECONDS;
}

async function releaseAndExit(signal, run) {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    const now = new Date();
    const claimAfter = new Date(now.getTime() + releaseDelaySeconds() * 1000);
    const daysBack = run?.result?.options?.days_back || run?.result?.days_back;
    const reason = `SEO pipeline worker received ${signal}; run returned to queue`;
    const released = await releasePipelineRun(run.id, reason, now, claimAfter, daysBack);
    console.log(JSON.stringify({
      status: released ? 'released' : 'release_skipped',
      signal,
      run_id: run.id,
      domain: run.domain,
      claim_after: claimAfter.toISOString(),
    }));
  })()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.destroy();
      process.exit(process.exitCode || 0);
    });

  return shutdownPromise;
}

async function shutdown(signal) {
  stopping = true;
  shutdownSignal = signal;

  const run = activeRun;
  if (run?.id) return releaseAndExit(signal, run);

  return null;
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

async function main() {
  const once = process.argv.includes('--once') || process.env.SEO_PIPELINE_WORKER_ONCE === 'true';
  const result = await runSeoPipelineWorker({
    once,
    shouldStop: () => stopping,
    onClaimed: async (run) => {
      activeRun = run;
      if (stopping) await releaseAndExit(shutdownSignal || 'SIGTERM', run);
    },
    onSettled: (run) => {
      if (activeRun?.id === run.id) activeRun = null;
    },
  });

  if (once || result.status === 'stopped') {
    console.log(JSON.stringify(result));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
