const db = require('../../models/db');
const logger = require('../logger');

const DEFAULT_STALE_AFTER_HOURS = 2;

async function reapStuckRuns({ staleAfterHours = DEFAULT_STALE_AFTER_HOURS } = {}) {
  const staleInterval = `${Number(staleAfterHours) || DEFAULT_STALE_AFTER_HOURS} hours`;

  const rows = await db('data_hygiene_runs')
    .where({ status: 'running' })
    .where('started_at', '<', db.raw(`now() - ?::interval`, [staleInterval]))
    .update({
      status: 'failed',
      finished_at: db.fn.now(),
      error_message: db.raw("coalesce(error_message, 'reaped stale running scan')"),
    })
    .returning(['id', 'mode', 'started_at']);

  if (rows.length > 0) {
    logger.warn(`[data-hygiene] reaped ${rows.length} stale running scan(s): ${rows.map((r) => r.id).join(', ')}`);
  }

  return { reaped: rows.length, runs: rows };
}

module.exports = { reapStuckRuns, DEFAULT_STALE_AFTER_HOURS };
