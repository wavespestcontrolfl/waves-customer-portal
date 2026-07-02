const db = require('../models/db');
const { normalizePhone } = require('../utils/phone');

const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed'];
const AUTOMATED_ESTIMATE_LOCK_NAMESPACE = 'estimate_automation_duplicate';

function phoneLookupValues(phone) {
  const raw = phone == null ? '' : String(phone).trim();
  const normalized = normalizePhone(raw);
  const digits = String(normalized || raw).replace(/\D/g, '');
  if (digits.length < 10) {
    return { raw, normalized: normalized || null, last10: null };
  }
  return {
    raw,
    normalized: normalized || null,
    last10: digits.slice(-10),
  };
}

async function findDuplicateEstimateByPhone(phone, options = {}) {
  const database = options.database || db;
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses
    : OPEN_ESTIMATE_STATUSES;
  const values = phoneLookupValues(phone);
  if (!values.last10) return null;

  const query = database('estimates')
    .select('id', 'status', 'source', 'created_at')
    .whereRaw(
      "right(regexp_replace(coalesce(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?",
      [values.last10]
    )
    .whereIn('status', statuses)
    // An archived row keeps its status but the courtship already closed —
    // it must not block a genuinely new automated estimate.
    .whereNull('archived_at')
    .orderBy('created_at', 'desc');

  if (options.excludeEstimateId) {
    query.whereNot('id', options.excludeEstimateId);
  }

  return query.first();
}

function automatedDuplicateBlock(existingEstimate) {
  if (!existingEstimate) return null;
  return {
    blocked: true,
    reason: 'duplicate_phone',
    existingEstimateId: existingEstimate.id,
    existingStatus: existingEstimate.status || null,
    existingSource: existingEstimate.source || null,
    message: 'Automation skipped this estimate because another estimate already exists for this phone number. Create the new estimate manually in Waves admin if it is still needed.',
  };
}

async function blockIfAutomatedEstimateDuplicate(phone, options = {}) {
  const existingEstimate = await findDuplicateEstimateByPhone(phone, options);
  return automatedDuplicateBlock(existingEstimate);
}

async function withAutomatedEstimatePhoneLock(phone, callback, options = {}) {
  const database = options.database || db;
  const values = phoneLookupValues(phone);
  if (!values.last10) return callback(database, values);

  return database.transaction(async (trx) => {
    await trx.raw(
      'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      [AUTOMATED_ESTIMATE_LOCK_NAMESPACE, values.last10]
    );
    return callback(trx, values);
  });
}

module.exports = {
  automatedDuplicateBlock,
  blockIfAutomatedEstimateDuplicate,
  findDuplicateEstimateByPhone,
  OPEN_ESTIMATE_STATUSES,
  phoneLookupValues,
  withAutomatedEstimatePhoneLock,
};
