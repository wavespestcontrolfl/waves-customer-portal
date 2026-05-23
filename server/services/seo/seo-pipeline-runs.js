const db = require('../../models/db');
const { extractDomain } = require('../../utils/normalize-url');

async function claimPipelineRun({ domain, idempotencyKey, requestedBy }) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return { error: 'idempotencyKey is required to run SEO pipeline' };
  const d = extractDomain(domain) || 'wavespestcontrol.com';

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

async function completePipelineRun(id, result, status = 'completed') {
  await db('seo_pipeline_runs')
    .where('id', id)
    .update({
      status,
      completed_at: new Date(),
      result: result || {},
      updated_at: new Date(),
    });
}

async function failPipelineRun(id, error) {
  await db('seo_pipeline_runs')
    .where('id', id)
    .update({
      status: 'failed',
      completed_at: new Date(),
      error: error?.message || String(error || 'Pipeline failed'),
      updated_at: new Date(),
    });
}

module.exports = {
  claimPipelineRun,
  completePipelineRun,
  failPipelineRun,
};
