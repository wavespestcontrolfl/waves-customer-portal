const db = require('../../models/db');
const { extractDomain } = require('../../utils/normalize-url');

const DEFAULT_STALE_AFTER_MINUTES = 30;

function staleAfterMinutes(value = process.env.SEO_PIPELINE_STALE_AFTER_MINUTES) {
  const minutes = parseInt(value, 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_STALE_AFTER_MINUTES;
}

function staleCutoff(now = new Date(), minutes = staleAfterMinutes()) {
  return new Date(now.getTime() - minutes * 60 * 1000);
}

async function reapStaleSeoRuns({ now = new Date(), staleMinutes = staleAfterMinutes() } = {}) {
  const cutoff = staleCutoff(now, staleMinutes);
  const error = `No SEO pipeline heartbeat for ${staleMinutes} minutes; run was likely interrupted by deploy or process exit`;

  const pipelineRuns = await db('seo_pipeline_runs')
    .where({ status: 'running' })
    .where('updated_at', '<', cutoff)
    .update({
      status: 'failed',
      completed_at: now,
      error,
      updated_at: now,
    })
    .returning(['id', 'domain', 'idempotency_key', 'updated_at']);

  const siteAuditRuns = await db('seo_site_audit_runs')
    .where({ status: 'running' })
    .where('updated_at', '<', cutoff)
    .update({
      status: 'failed',
      updated_at: now,
    })
    .returning(['id', 'domain', 'run_date', 'updated_at']);

  return {
    reaped: pipelineRuns.length + siteAuditRuns.length,
    pipelineRuns,
    siteAuditRuns,
    staleMinutes,
    cutoff,
  };
}

async function claimPipelineRun({ domain, idempotencyKey, requestedBy }) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return { error: 'idempotencyKey is required to run SEO pipeline' };
  const d = extractDomain(domain) || 'wavespestcontrol.com';

  await reapStaleSeoRuns();

  const existing = await db('seo_pipeline_runs').where({ idempotency_key: key }).first();
  if (existing) return { claimed: false, run: existing };

  try {
    const [created] = await db('seo_pipeline_runs')
      .insert({
        idempotency_key: key,
        domain: d,
        status: 'running',
        requested_by: requestedBy || null,
        started_at: new Date(),
      })
      .returning('*');
    return { claimed: true, run: created };
  } catch (err) {
    if (err.code === '23505') {
      const replayed = await db('seo_pipeline_runs').where({ idempotency_key: key }).first();
      if (replayed) return { claimed: false, run: replayed };
    }
    throw err;
  }
}

async function heartbeatPipelineRun(id, result = null) {
  const update = { updated_at: new Date() };
  if (result) update.result = result;
  return db('seo_pipeline_runs')
    .where({ id, status: 'running' })
    .update(update);
}

async function completePipelineRun(id, result, status = 'completed') {
  await db('seo_pipeline_runs')
    .where({ id, status: 'running' })
    .update({
      status,
      completed_at: new Date(),
      result: result || {},
      updated_at: new Date(),
    });
}

async function failPipelineRun(id, error) {
  await db('seo_pipeline_runs')
    .where({ id, status: 'running' })
    .update({
      status: 'failed',
      completed_at: new Date(),
      error: error?.message || String(error || 'Pipeline failed'),
      updated_at: new Date(),
    });
}

module.exports = {
  DEFAULT_STALE_AFTER_MINUTES,
  claimPipelineRun,
  completePipelineRun,
  failPipelineRun,
  heartbeatPipelineRun,
  reapStaleSeoRuns,
  _internals: {
    staleAfterMinutes,
    staleCutoff,
  },
};
