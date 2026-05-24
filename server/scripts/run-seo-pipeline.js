#!/usr/bin/env node

const db = require('../models/db');
const { claimPipelineRun } = require('../services/seo/seo-pipeline-runs');
const { runClaimedSeoPipeline } = require('../services/seo/seo-pipeline-runner');
const { extractDomain } = require('../utils/normalize-url');

async function main() {
  const domain = extractDomain(process.env.SEO_PIPELINE_DOMAIN || process.argv[2]) || 'wavespestcontrol.com';
  const requestedDaysBack = parseInt(process.env.SEO_PIPELINE_DAYS_BACK || process.argv[3] || '7', 10);
  const daysBack = Number.isFinite(requestedDaysBack) && requestedDaysBack > 0 ? requestedDaysBack : 7;
  const idempotencyKey = process.env.SEO_PIPELINE_IDEMPOTENCY_KEY
    || `seo-pipeline-worker:${domain}:${new Date().toISOString().slice(0, 10)}`;

  const claim = await claimPipelineRun({
    domain,
    idempotencyKey,
    requestedBy: process.env.SEO_PIPELINE_REQUESTED_BY || null,
  });

  if (claim.error) throw new Error(claim.error);
  if (!claim.claimed) {
    console.log(JSON.stringify({
      status: claim.run.status,
      run_id: claim.run.id,
      domain: claim.run.domain,
      idempotencyKey,
      deduped: true,
    }));
    return;
  }

  const result = await runClaimedSeoPipeline({
    pipelineRun: claim.run,
    domain: claim.run.domain,
    daysBack,
    logPrefix: 'seo-pipeline-worker',
  });

  console.log(JSON.stringify({
    status: result.status,
    run_id: claim.run.id,
    domain: claim.run.domain,
    idempotencyKey,
    succeeded: result.succeeded,
    failed: result.failed,
    duration_ms: result.duration_ms,
  }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
