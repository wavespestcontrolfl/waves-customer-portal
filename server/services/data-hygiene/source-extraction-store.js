const crypto = require('crypto');
const db = require('../../models/db');

const TERMINAL_STATUSES = ['ok', 'no_fields', 'failed_max_retries'];
const RETRY_STATUSES = ['parse_error', 'failed'];

function hashExtractionSource(value) {
  return crypto
    .createHash('sha256')
    .update(value || '')
    .digest('hex');
}

async function getSourceExtraction({
  trx = null,
  source_type,
  source_id,
  extractor_version,
  source_hash,
}) {
  const conn = trx || db;
  return conn('data_hygiene_source_extractions')
    .where({ source_type, source_id, extractor_version, source_hash })
    .first();
}

async function shouldSkipExtraction(args) {
  const existing = await getSourceExtraction(args);
  return {
    skip: !!existing && TERMINAL_STATUSES.includes(existing.status),
    existing: existing || null,
  };
}

async function recordExtractionAttempt({
  trx = null,
  source_type,
  source_id,
  extractor_version,
  source_hash,
  status,
  proposal_count = 0,
  error_message = null,
}) {
  if (!['ok', 'no_fields', 'parse_error', 'failed', 'failed_max_retries'].includes(status)) {
    throw new Error(`recordExtractionAttempt: invalid status '${status}'`);
  }

  const conn = trx || db;
  const [row] = await conn('data_hygiene_source_extractions')
    .insert({
      source_type,
      source_id,
      extractor_version,
      source_hash,
      status,
      proposal_count,
      error_message,
      attempt_count: 1,
    })
    .onConflict(['source_type', 'source_id', 'extractor_version', 'source_hash'])
    .merge({
      status: conn.raw(`
        CASE
          WHEN data_hygiene_source_extractions.attempt_count + 1 >= 3
           AND EXCLUDED.status IN ('parse_error','failed')
          THEN 'failed_max_retries'
          ELSE EXCLUDED.status
        END
      `),
      proposal_count: conn.raw('EXCLUDED.proposal_count'),
      error_message: conn.raw('EXCLUDED.error_message'),
      last_attempted_at: conn.fn.now(),
      attempt_count: conn.raw('data_hygiene_source_extractions.attempt_count + 1'),
      processed_at: conn.raw(`
        CASE
          WHEN EXCLUDED.status IN ('ok','no_fields') THEN now()
          ELSE data_hygiene_source_extractions.processed_at
        END
      `),
    })
    .returning(['id', 'status', 'attempt_count', 'proposal_count']);

  return row;
}

module.exports = {
  TERMINAL_STATUSES,
  RETRY_STATUSES,
  hashExtractionSource,
  getSourceExtraction,
  shouldSkipExtraction,
  recordExtractionAttempt,
};
