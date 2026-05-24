const db = require('../../models/db');
const { extractDomain } = require('../../utils/normalize-url');

const DEFAULT_STALE_AFTER_MINUTES = 30;
const DEFAULT_PIPELINE_DAYS_BACK = 7;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function staleAfterMinutes(value = process.env.SEO_PIPELINE_STALE_AFTER_MINUTES) {
  const minutes = parseInt(value, 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_STALE_AFTER_MINUTES;
}

function staleCutoff(now = new Date(), minutes = staleAfterMinutes()) {
  return new Date(now.getTime() - minutes * 60 * 1000);
}

function pipelineDaysBack(value, fallback = DEFAULT_PIPELINE_DAYS_BACK) {
  const days = parseInt(value, 10);
  return Number.isFinite(days) && days > 0 ? days : fallback;
}

function queuedResult({ daysBack, queuedAt }) {
  return {
    queued: true,
    queued_at: queuedAt.toISOString(),
    options: {
      days_back: pipelineDaysBack(daysBack),
    },
  };
}

function isUuid(value) {
  return UUID_RE.test(String(value || ''));
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

async function enqueuePipelineRun({ domain, idempotencyKey, requestedBy, daysBack } = {}) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return { error: 'idempotencyKey is required to run SEO pipeline' };
  const d = extractDomain(domain) || 'wavespestcontrol.com';
  const now = new Date();

  await reapStaleSeoRuns();

  const existing = await db('seo_pipeline_runs').where({ idempotency_key: key }).first();
  if (existing) return { enqueued: false, run: existing };

  try {
    const [created] = await db('seo_pipeline_runs')
      .insert({
        idempotency_key: key,
        domain: d,
        status: 'queued',
        requested_by: requestedBy || null,
        started_at: now,
        result: queuedResult({ daysBack, queuedAt: now }),
      })
      .returning('*');
    return { enqueued: true, run: created };
  } catch (err) {
    if (err.code === '23505') {
      const replayed = await db('seo_pipeline_runs').where({ idempotency_key: key }).first();
      if (replayed) return { enqueued: false, run: replayed };
    }
    throw err;
  }
}

async function claimPipelineRun(args) {
  const queued = await enqueuePipelineRun(args);
  if (queued.error || !queued.enqueued || queued.run?.status !== 'queued') {
    return { ...queued, claimed: false };
  }

  const claim = await claimQueuedPipelineRun({ id: queued.run.id });
  return {
    ...queued,
    claimed: claim.claimed,
    run: claim.run || queued.run,
  };
}

async function claimQueuedPipelineRun({ id = null, now = new Date() } = {}) {
  if (id && !isUuid(id)) return { claimed: false, run: null };

  await reapStaleSeoRuns({ now });

  const params = [];
  const idClause = id ? 'AND id = CAST(? AS uuid)' : '';
  if (id) params.push(id);
  params.push(now, now, now, now);

  const result = await db.raw(`
    WITH next_run AS (
      SELECT id
      FROM seo_pipeline_runs
      WHERE status = 'queued'
        ${idClause}
        AND (
          result->>'requeue_claim_after' IS NULL
          OR CAST(result->>'requeue_claim_after' AS timestamptz) <= CAST(? AS timestamptz)
        )
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE seo_pipeline_runs AS run
    SET status = 'running',
        started_at = ?,
        updated_at = ?,
        error = NULL,
        result = COALESCE(run.result, '{}'::jsonb)
          || jsonb_build_object('claimed_at', CAST(? AS timestamptz))
    FROM next_run
    WHERE run.id = next_run.id
    RETURNING run.*
  `, params);

  const run = result.rows?.[0] || null;
  return { claimed: Boolean(run), run };
}

async function heartbeatPipelineRun(id, result = null) {
  const update = { updated_at: new Date() };
  if (result) update.result = result;
  return db('seo_pipeline_runs')
    .where({ id, status: 'running' })
    .update(update);
}

async function releasePipelineRun(id, reason, now = new Date(), claimAfter = now, daysBack = DEFAULT_PIPELINE_DAYS_BACK) {
  if (!isUuid(id)) return 0;
  const safeDaysBack = pipelineDaysBack(daysBack);

  return db('seo_pipeline_runs')
    .where({ id, status: 'running' })
    .update({
      status: 'queued',
      completed_at: null,
      error: null,
      updated_at: now,
      result: db.raw(`
        COALESCE(result, '{}'::jsonb)
          || jsonb_build_object(
            'queued', true,
            'requeued_at', CAST(? AS timestamptz),
            'requeue_claim_after', CAST(? AS timestamptz),
            'options', COALESCE(result->'options', '{}'::jsonb)
              || jsonb_build_object('days_back', CAST(? AS int)),
            'requeue_reason', ?
          )
      `, [now, claimAfter, safeDaysBack, reason || 'Worker stopped before pipeline completed']),
    });
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
  DEFAULT_PIPELINE_DAYS_BACK,
  DEFAULT_STALE_AFTER_MINUTES,
  claimQueuedPipelineRun,
  claimPipelineRun,
  completePipelineRun,
  enqueuePipelineRun,
  failPipelineRun,
  heartbeatPipelineRun,
  releasePipelineRun,
  reapStaleSeoRuns,
  _internals: {
    isUuid,
    pipelineDaysBack,
    queuedResult,
    staleAfterMinutes,
    staleCutoff,
  },
};
