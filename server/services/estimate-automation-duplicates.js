const db = require('../models/db');
const { normalizePhone } = require('../utils/phone');

const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed'];
const AUTOMATED_ESTIMATE_LOCK_NAMESPACE = 'estimate_automation_duplicate';
// Separate namespace so a customer UUID can never collide with a phone key.
const AUTOMATED_ESTIMATE_CUSTOMER_LOCK_NAMESPACE = 'estimate_automation_duplicate_customer';

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

// Open estimates carried by a CUSTOMER IDENTITY, newest first. The phone
// lookup above cannot see these: an estimate is stored with ONE
// customer_phone, so a draft a coordinator created for customer B is filed
// under the coordinator's number and is invisible to every other number
// that reaches the same customer (B's own line, a second service contact).
// Identity is the only key all of them share.
async function listOpenEstimatesByCustomerId(customerId, options = {}) {
  const database = options.database || db;
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses
    : OPEN_ESTIMATE_STATUSES;
  const id = customerId == null ? '' : String(customerId).trim();
  if (!id) return [];

  const query = database('estimates')
    .select('id', 'status', 'source', 'address', 'created_at')
    .where('customer_id', id)
    .whereIn('status', statuses)
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

// A lock target in its canonical shape: `{ phones, customerIds }`. A bare
// array/string is read as phones so single-phone callers stay unchanged.
// ONE normalizer, used by every entry point, so the two cannot drift.
function normalizeLockTarget(target) {
  if (target == null) return { phones: [], customerIds: [] };
  if (Array.isArray(target) || typeof target === 'string') {
    return { phones: [].concat(target), customerIds: [] };
  }
  return { phones: target.phones || [], customerIds: target.customerIds || [] };
}

// Already-resolved keys (what automatedEstimateLockKeys returns) handed back
// in. Recognizing them makes re-resolution IDEMPOTENT: without it, passing a
// resolved list to a function expecting a TARGET would read the objects as
// phones, resolve to nothing, and silently take no locks at all.
function isResolvedLockKeyList(target) {
  return Array.isArray(target) && target.length > 0
    && target.every((k) => k && typeof k === 'object'
      && typeof k.namespace === 'string' && typeof k.key === 'string');
}

// Every advisory lock the duplicate guard can take, in ONE canonical order:
// by namespace, then by key. A caller locking phones + an identity and a
// caller locking a single phone therefore take any SHARED key in the same
// relative order — that ordering IS the deadlock guard. Every acquisition in
// the codebase goes through this function (single-phone callers included,
// via withAutomatedEstimatePhoneLock below).
//
// The order comes from the (namespace, key) PAIR, never from a joined
// string. A joined string needs a separator character, and a separator is
// both an assumption about what may appear inside a key and — as this file
// learned the hard way — an invitation to write a raw control byte into
// source. There is no separator here to get wrong.
function automatedEstimateLockKeys(target) {
  if (isResolvedLockKeyList(target)) return target;
  const spec = normalizeLockTarget(target);
  const byNamespace = new Map();
  const add = (namespace, key) => {
    if (!key) return;
    if (!byNamespace.has(namespace)) byNamespace.set(namespace, new Set());
    byNamespace.get(namespace).add(key);
  };
  for (const phone of spec.phones) add(AUTOMATED_ESTIMATE_LOCK_NAMESPACE, phoneLookupValues(phone).last10);
  for (const id of spec.customerIds) {
    add(AUTOMATED_ESTIMATE_CUSTOMER_LOCK_NAMESPACE, String(id == null ? '' : id).trim());
  }
  const keys = [];
  for (const [namespace, set] of byNamespace) {
    for (const key of set) keys.push({ namespace, key });
  }
  const cmp = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
  keys.sort((a, b) => cmp(a.namespace, b.namespace) || cmp(a.key, b.key));
  return keys;
}

// Take the advisory locks on an EXISTING transaction (callers that already
// opened one — e.g. a call-scoped lock taken first — reuse this so the
// ordering rule still holds). Sequential by design: the order is the point.
async function acquireAutomatedEstimateLocks(trx, target) {
  const keys = automatedEstimateLockKeys(target);
  for (const { namespace, key } of keys) {
    await trx.raw(
      'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      [namespace, key]
    );
  }
  return keys;
}

// Serialize a duplicate decision across EVERY key it will read — each
// dedupe phone AND, when the draft is written against a linked customer,
// that customer's identity. A caller that reads key A while holding only
// key B is not serialized at all: a concurrent run under A's lock sees no
// open estimate either, and both insert (there is no uniqueness constraint
// to catch it). Two service contacts of the same customer share NO phone,
// so identity is the only key that serializes them.
async function withAutomatedEstimateDedupeLocks(target, callback, options = {}) {
  const database = options.database || db;
  const spec = normalizeLockTarget(target);
  // Second-arg contract (unchanged): the PRIMARY phone's lookup values.
  const values = phoneLookupValues(spec.phones[0]);
  const keys = automatedEstimateLockKeys(spec);
  if (!keys.length) return callback(database, values);

  return database.transaction(async (trx) => {
    // Re-resolved from the SAME spec inside the transaction — never from
    // the resolved key list, so there is exactly one ordering code path.
    await acquireAutomatedEstimateLocks(trx, spec);
    return callback(trx, values);
  });
}

async function withAutomatedEstimatePhoneLocks(phones, callback, options = {}) {
  return withAutomatedEstimateDedupeLocks({ phones: [].concat(phones || []) }, callback, options);
}

async function withAutomatedEstimatePhoneLock(phone, callback, options = {}) {
  return withAutomatedEstimatePhoneLocks([phone], callback, options);
}

/**
 * Retire an automated draft that a replacement is about to supersede —
 * INSIDE the dedupe transaction, so the guard's open-estimate listing no
 * longer sees it and the replacement passes. Only an unsent 'draft' that
 * is not already archived qualifies: a sent/scheduled/terminal row is
 * never touched (the send flow or the customer owns it). Returns true
 * when a row was retired. The archive marker + estimator_engine stamp
 * mirror the linkage-invalidation precedent (estimator-engine/index.js).
 */
async function retireSupersededDraftInTx(trx, { estimateId, reason }) {
  if (!trx || !estimateId) return false;
  const stale = await trx('estimates')
    .select('id', 'estimate_data')
    .where({ id: estimateId, status: 'draft' })
    .whereNull('sent_at')
    .whereNull('archived_at')
    .forUpdate()
    .first();
  if (!stale) return false;
  let data = {};
  try {
    data = typeof stale.estimate_data === 'string' ? JSON.parse(stale.estimate_data) : (stale.estimate_data || {});
  } catch { data = {}; }
  if (!data || typeof data !== 'object') data = {};
  data.estimatorEngine = {
    ...(data.estimatorEngine || {}),
    superseded_at: new Date().toISOString(),
    superseded_reason: reason || 'superseded',
  };
  const changed = await trx('estimates')
    .where({ id: stale.id, status: 'draft' })
    .whereNull('sent_at')
    .whereNull('archived_at')
    .update({
      archived_at: new Date(),
      estimate_data: JSON.stringify(data),
      updated_at: new Date(),
    });
  return changed > 0;
}

module.exports = {
  acquireAutomatedEstimateLocks,
  retireSupersededDraftInTx,
  automatedDuplicateBlock,
  automatedEstimateLockKeys,
  blockIfAutomatedEstimateDuplicate,
  listOpenEstimatesByCustomerId,
  findDuplicateEstimateByPhone,
  listOpenEstimatesByPhone,
  OPEN_ESTIMATE_STATUSES,
  phoneLookupValues,
  withAutomatedEstimateDedupeLocks,
  withAutomatedEstimatePhoneLock,
  withAutomatedEstimatePhoneLocks,
};
