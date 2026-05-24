#!/usr/bin/env node

const db = require('../models/db');
const { runSeoPipelineWorker } = require('../services/seo/seo-pipeline-worker');

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

async function main() {
  const once = process.argv.includes('--once') || process.env.SEO_PIPELINE_WORKER_ONCE === 'true';
  const result = await runSeoPipelineWorker({
    once,
    shouldStop: () => stopping,
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
