const { randomUUID } = require('node:crypto');

const TABLE = 'schedule_quality_refresh_jobs';
const LEASE_MS = 15 * 60 * 1000;
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

const later = (now, ms) => new Date(now.getTime() + ms);

async function registerQualityRefresh(payload, now, conn) {
  const attemptToken = randomUUID();
  const [row] = await conn(TABLE).insert({
    payload: JSON.stringify(payload),
    available_at: later(now, LEASE_MS),
    attempts: 1,
    attempt_token: attemptToken,
  }).returning(['id', 'payload', 'available_at', 'attempts', 'attempt_token']);
  return { ...row, attempt_token: attemptToken };
}

async function captureResolvedDates(job, dates, conn) {
  const payload = { ...job.payload, resolvedDates: dates };
  const [row] = await conn(TABLE).where({ id: job.id, attempt_token: job.attempt_token })
    .update({ payload: JSON.stringify(payload) }).returning(['id']);
  if (!row) throw Object.assign(new Error('Schedule quality refresh claim was superseded'), { code: 'STALE_REFRESH_CLAIM' });
  job.payload = payload;
}

async function claimQualityRefresh(now, conn) {
  const attemptToken = randomUUID();
  const result = await conn.raw(`
    WITH due AS (
      SELECT id FROM ${TABLE}
      WHERE available_at <= ?
      ORDER BY available_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE ${TABLE} AS job
       SET attempt_token = ?, available_at = ?, attempts = job.attempts + 1
      FROM due
     WHERE job.id = due.id
    RETURNING job.id, job.payload, job.available_at, job.attempts, job.attempt_token
  `, [now, attemptToken, later(now, LEASE_MS)]);
  return result.rows[0] || null;
}

async function completeQualityRefresh(job, conn) {
  return conn(TABLE).where({ id: job.id, attempt_token: job.attempt_token }).del();
}

async function retryQualityRefresh(job, error, now, conn) {
  const exponent = Math.max(0, Math.min(job.attempts - 1, 4));
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** exponent));
  return conn(TABLE).where({ id: job.id, attempt_token: job.attempt_token }).update({
    available_at: later(now, delay),
    last_error: String(error || 'schedule_quality_refresh_failed').slice(0, 1000),
  });
}

module.exports = {
  registerQualityRefresh,
  captureResolvedDates,
  claimQualityRefresh,
  completeQualityRefresh,
  retryQualityRefresh,
  LEASE_MS,
};
