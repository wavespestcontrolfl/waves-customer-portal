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

// All of a phone's open estimates, newest first. Callers doing
// property-level duplicate decisions need every open row (each with its
// address), not just the newest — a phone can hold open estimates for
// several properties at once.
async function listOpenEstimatesByPhone(phone, options = {}) {
  const database = options.database || db;
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses
    : OPEN_ESTIMATE_STATUSES;
  const values = phoneLookupValues(phone);
  if (!values.last10) return [];

  const query = database('estimates')
    .select('id', 'status', 'source', 'address', 'created_at')
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

  return query;
}

async function findDuplicateEstimateByPhone(phone, options = {}) {
  const rows = await listOpenEstimatesByPhone(phone, options);
  return rows[0] || null;
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

// The lock keys a set of phones resolves to: unique last-10s, ASCENDING.
// The sort is the deadlock guard — a duplicate decision that reads two
// phones must take both locks, and two overlapping runs that share a phone
// would deadlock if they grabbed the pair in opposite orders. Every caller
// goes through this one ordering (single-phone callers included, via
// withAutomatedEstimatePhoneLock below), so no two lock acquisitions in the
// codebase can disagree about the order.
function automatedEstimateLockKeys(phones) {
  const list = Array.isArray(phones) ? phones : [phones];
  const keys = new Set();
  for (const phone of list) {
    const { last10 } = phoneLookupValues(phone);
    if (last10) keys.add(last10);
  }
  return [...keys].sort();
}

// Take the advisory locks on an EXISTING transaction (callers that already
// opened one — e.g. a call-scoped lock taken first — reuse this so the
// ordering rule still holds). Sequential by design: the order is the point.
async function acquireAutomatedEstimatePhoneLocks(trx, phones) {
  const keys = automatedEstimateLockKeys(phones);
  for (const key of keys) {
    await trx.raw(
      'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      [AUTOMATED_ESTIMATE_LOCK_NAMESPACE, key]
    );
  }
  return keys;
}

// Serialize a duplicate decision across EVERY phone it will read. A caller
// that reads phone A's open estimates while holding only phone B's lock is
// not serialized at all: a concurrent run under A's lock sees no open
// estimate either, and both insert (there is no uniqueness constraint to
// catch it). Pass every dedupe phone; the callback runs with all of them
// locked for the whole transaction, reads and insert included.
async function withAutomatedEstimatePhoneLocks(phones, callback, options = {}) {
  const database = options.database || db;
  const list = Array.isArray(phones) ? phones : [phones];
  // Second-arg contract (unchanged): the PRIMARY phone's lookup values.
  const values = phoneLookupValues(list[0]);
  const keys = automatedEstimateLockKeys(list);
  if (!keys.length) return callback(database, values);

  return database.transaction(async (trx) => {
    await acquireAutomatedEstimatePhoneLocks(trx, keys);
    return callback(trx, values);
  });
}

async function withAutomatedEstimatePhoneLock(phone, callback, options = {}) {
  return withAutomatedEstimatePhoneLocks([phone], callback, options);
}

module.exports = {
  acquireAutomatedEstimatePhoneLocks,
  automatedDuplicateBlock,
  automatedEstimateLockKeys,
  blockIfAutomatedEstimateDuplicate,
  findDuplicateEstimateByPhone,
  listOpenEstimatesByPhone,
  OPEN_ESTIMATE_STATUSES,
  phoneLookupValues,
  withAutomatedEstimatePhoneLock,
  withAutomatedEstimatePhoneLocks,
};
