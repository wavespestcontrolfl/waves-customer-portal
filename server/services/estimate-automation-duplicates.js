const db = require('../models/db');
const { normalizePhone } = require('../utils/phone');
const { samePremiseDisplay, parseDisplayAddress } = require('./lead-address-unverified');
const { normalizeUnitLine, unitLineValueKey } = require('../utils/address-normalizer');
const { DRAFT_ELIGIBLE_SQL } = require('./estimate-draft-retire');

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
  // A clarify re-run's own attempt: the rows the SAME reply held (one
  // token per reply) are the drafts being corrected, not concurrent
  // duplicates — they stay held for the operator and must not block the
  // replacement (codex r13 P2 on #3804; the same-call probe already
  // excludes them).
  if (options.excludeRepriceAttempt) {
    query.whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'reprice_attempt', '') <> ?", [String(options.excludeRepriceAttempt)]);
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
  // A clarify re-run's own attempt: the rows the SAME reply held (one
  // token per reply) are the drafts being corrected, not concurrent
  // duplicates — they stay held for the operator and must not block the
  // replacement (codex r13 P2 on #3804; the same-call probe already
  // excludes them).
  if (options.excludeRepriceAttempt) {
    query.whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'reprice_attempt', '') <> ?", [String(options.excludeRepriceAttempt)]);
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
 * Supersede support for a clarify-reply re-draft — two steps that bracket
 * the duplicate check so the original is NEVER lost:
 *   1. lockSupersededDraftInTx — SELECT … FOR UPDATE the unsent 'draft'
 *      (not archived, not sent); returns the row or null. The caller
 *      excludes it from the open-estimate listing by id.
 *   2. archiveSupersededDraftInTx — after the replacement row is inserted
 *      (same transaction), archive it with the superseded stamp. If the
 *      duplicate check blocks or the insert never happens, nothing is
 *      archived and the transaction leaves the original standing.
 * A sent/scheduled/terminal row never qualifies (the send flow or the
 * customer owns it). Marker + estimator_engine stamp mirror the
 * linkage-invalidation precedent (estimator-engine/index.js).
 */
async function lockSupersededDraftInTx(trx, { estimateId, attempt = null }) {
  if (!trx || !estimateId) return null;
  // 'scheduled' = an unsent draft with a due time; superseding it must
  // also cancel that schedule (archive below returns it to an inert draft).
  // 'send_failed' = a refused/failed delivery attempt (the reprice guard
  // itself parks a row there) — still unsent, still ours to replace.
  const stale = await trx('estimates')
    .select('id', 'status', 'estimate_data')
    .where({ id: estimateId })
    .whereIn('status', ['draft', 'scheduled', 'send_failed'])
    .whereNull('sent_at')
    .whereNull('archived_at')
    // The re-price attempt that stamped this row must still own it: an
    // operator revision deletes the token, invalidating any in-flight
    // re-draft so it can never archive a corrected draft.
    .modify((q) => { if (attempt) q.whereRaw("estimate_data->'estimatorEngine'->>'reprice_attempt' = ?", [String(attempt)]); })
    .forUpdate()
    .first();
  return stale || null;
}

async function archiveSupersededDraftInTx(trx, stale, { reason } = {}) {
  if (!trx || !stale?.id) return false;
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
    .where({ id: stale.id })
    .whereIn('status', ['draft', 'scheduled', 'send_failed'])
    .whereNull('sent_at')
    .whereNull('archived_at')
    .update({
      archived_at: new Date(),
      // A scheduled row returns to an inert draft with no due time — the
      // cron must never deliver the superseded price (same transition as
      // linkage invalidation, estimator-engine/index.js).
      status: 'draft',
      scheduled_at: null,
      estimate_data: JSON.stringify(data),
      updated_at: new Date(),
    });
  return changed > 0;
}

/**
 * Untouched web-form shells (owner 2026-11-21, "build";
 * GATE_WIZARD_SUPERSEDES_FORM_DRAFT, read by routes/public-quote.js).
 *
 * The web form (source 'lead_webhook') leaves a draft estimate with no price
 * when draft automation cannot price the request. Nobody works that row, yet
 * it is an OPEN estimate for the phone, so it blocked the quote wizard's own
 * estimate, and with no wizard estimate the person gets no booking link.
 *
 * A row is an untouched shell when ALL of these hold:
 *   - the web form made it, and it is still an unarchived 'draft';
 *   - nothing wrote it since it was made (updated_at = created_at, the same
 *     test lead-draft-measurements.js uses). A staff edit, a later automation
 *     write, an unarchive, and this module's own archive all move updated_at,
 *     so a row that staff worked or restored is never a shell again;
 *   - it has no price (monthly, one-time and annual are all empty or 0), the
 *     same test lead-intake.js uses to find a shell it may fill;
 *   - nobody sent, viewed or scheduled it, auto-send did not claim it, and no
 *     lead points at it: the #6394 rule (retireSupersededLeadWebhookDrafts,
 *     admin-estimate-persistence.js);
 *   - it passes the draft-retire sweep's own "safe to archive" rule
 *     (DRAFT_ELIGIBLE_SQL, estimate-draft-retire.js): older than 30 minutes,
 *     so the web form's background work on it is done, and no lead, booking
 *     handoff, staged clarify text, group, price lock, send in flight or
 *     hold marker;
 *   - no office Sold-by action and no logged follow-up: staff work that does
 *     not move updated_at;
 *   - no clarify ask for the phone is open or was sent in the last 7 days
 *     without an answer: the row may be waiting for the customer's reply;
 *   - its data is a JSON object (or empty), so it can carry the marker below;
 *   - it belongs to the wizard run's own contact: the same customer row the
 *     run resolved for itself and the same email. A public caller who types
 *     someone's phone and address must not move that person's draft, and two
 *     people can share a phone and a home;
 *   - it is for the wizard run's own property: one phone can ask for quotes
 *     on two homes, and a draft for the other home is not replaced by this
 *     run. Same door by the test the draft-retire sweep uses
 *     (estimate-draft-retire.js sameProperty): the shared premise matcher
 *     with street, city and ZIP on both sides, plus the same unit. A missing
 *     or incomplete address fails closed: the draft is not a shell.
 *
 * Two steps that bracket the wizard's own estimate write, like
 * lockSupersededDraftInTx / archiveSupersededDraftInTx above, so a shell is
 * never lost without its replacement:
 *   1. lockUntouchedWebFormShellsInTx: row-locks the phone's shells and
 *      returns their ids, but only when they are EVERY open estimate of the
 *      phone. Any other open estimate still blocks (a draft with a price, a
 *      touched draft, a draft for another property, an office or estimator
 *      estimate, the wizard's own older draft), and then no id is returned.
 *   2. archiveWebFormShellsInTx: after the wizard's draft was written in the
 *      same transaction, archives those ids, all or nothing. A planned shell
 *      that is no longer one (a lead linked it in between), or another open
 *      estimate saved for the phone since the plan (the office does not take
 *      the phone lock), makes it throw, so the caller's transaction rolls
 *      the wizard's draft back too.
 *
 * Archived, not deleted: staff can unarchive the row, and every draft reader
 * (auto-send, clarify asks, measurements, lists) skips an archived row. The
 * marker is `estimate_data.supersededByWizard`, deliberately NOT
 * `estimatorEngine.superseded_at`: that stamp makes the unarchive route
 * refuse the row for good.
 *
 * Locks. The caller holds the phone's automated-estimate lock (the web form
 * creates its shell under the same lock) and has taken every other advisory
 * lock it will need. Step 1 then TRIES the phone's clarify lock
 * (estimate-clarify-asks.js withClarifyLock) and keeps it to the end of the
 * transaction: the web form parks its clarify ask after its shell commits, so
 * without the lock an ask could land between the check here and the archive.
 * A try, never a wait: the clarify writers take other locks under theirs, and
 * waiting here could deadlock with them. When a clarify writer holds the lock
 * right now, no shell goes on this run. parkClarifyAsk reads the marker under
 * the same lock and does not park an ask for a shell the wizard archived. It
 * reads the marker with the gate on or off: an archive outlives the gate.
 */
const WEB_FORM_SHELL_SOURCE = 'lead_webhook';
// Same window as estimate-clarify-asks.js RECENT_SENT_WINDOW_MS: a sent ask
// counts as waiting for its answer for 7 days.
const CLARIFY_WAIT_WINDOW_MS = 7 * 86400000;
// The namespace of estimate-clarify-asks.js withClarifyLock (keyed by the
// phone's 10 digits). A second copy of one string, pinned by a test.
const CLARIFY_LOCK_NAMESPACE = 'estimate_clarify';

function untouchedWebFormShells(trx, last10, { now = new Date() } = {}) {
  return trx('estimates')
    .where({ source: WEB_FORM_SHELL_SOURCE, status: 'draft' })
    .whereRaw(
      "right(regexp_replace(coalesce(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?",
      [last10]
    )
    // The draft-retire sweep's own "safe to archive" rule: older than 30
    // minutes (its creator's background work is done), no live lead, no
    // booking handoff, no staged clarify text, no group, no price lock, no
    // scheduled send, no live or uncertain send, no hold marker.
    .whereRaw(DRAFT_ELIGIBLE_SQL)
    .whereNull('sent_at')
    .whereNull('viewed_at')
    .whereRaw('updated_at = created_at')
    // Staff work that does not move updated_at: Sold by, a logged follow-up.
    .whereNull('sold_by_set_at')
    .whereRaw('COALESCE(follow_up_count, 0) = 0')
    .whereRaw('COALESCE(monthly_total, 0) = 0')
    .whereRaw('COALESCE(onetime_total, 0) = 0')
    .whereRaw('COALESCE(annual_total, 0) = 0')
    .whereRaw("COALESCE(estimate_data->'automation'->'autoSend'->>'claimedAt', '') = ''")
    // Only an object can take the marker. A legacy scalar stays a blocker.
    .whereRaw("jsonb_typeof(COALESCE(estimate_data, '{}'::jsonb)) = 'object'")
    // Any lead, soft-deleted ones too (the #6394 rule): the sweep's own
    // lead check skips a soft-deleted lead.
    .whereNotExists(function linkedToLead() {
      this.select(trx.raw('1')).from('leads').whereRaw('leads.estimate_id = estimates.id');
    })
    // By phone, and wider than the sweep's: a text sent in the last 7 days
    // with no answer still holds the draft.
    .whereNotExists(function clarifyAskWaiting() {
      this.select(trx.raw('1')).from('message_drafts')
        .where({ intent: 'estimate_clarify', source_ref: `clarify:${last10}` })
        .whereRaw("(flags->>'answered_at') is null")
        .where(function openOrRecentlySent() {
          this.where(function stillOpen() {
            this.whereIn('status', ['pending', 'approved', 'revised']).whereNull('sent_at');
          }).orWhere('sent_at', '>=', new Date(now.getTime() - CLARIFY_WAIT_WINDOW_MS));
        });
    });
}

// Same door, by the test the draft-retire sweep uses for "a draft another
// estimate replaced" (estimate-draft-retire.js sameProperty): the shared
// premise matcher with locality required, plus the same unit.
function sameDoor(addressA, addressB) {
  if (!samePremiseDisplay(addressA, addressB, { requireLocality: true })) return false;
  const unit = (text) => unitLineValueKey(normalizeUnitLine(parseDisplayAddress(text).unit));
  return unit(addressA) === unit(addressB);
}

// The draft belongs to the wizard run's own contact: the customer row the
// run resolved for itself (findExistingCustomerByContact) and the same email.
// The caller is a public route. A typed phone and address alone must never
// archive a draft: two people can share a phone and a home.
function sameContact(row, { customerId, email }) {
  const runEmail = String(email || '').trim().toLowerCase();
  if (!customerId || !runEmail) return false;
  return String(row.customer_id || '') === String(customerId)
    && String(row.customer_email || '').trim().toLowerCase() === runEmail;
}

async function lockUntouchedWebFormShellsInTx(trx, { phone, address, customerId, email, now = new Date() } = {}) {
  const values = phoneLookupValues(phone);
  if (!trx || !values.last10) return [];

  const locked = await trx.raw(
    'select pg_try_advisory_xact_lock(hashtext(?), hashtext(?)) as got',
    [CLARIFY_LOCK_NAMESPACE, values.last10]
  );
  if (locked?.rows?.[0]?.got !== true) return [];

  const open = await listOpenEstimatesByPhone(phone, { database: trx });
  if (!open.length) return [];

  // Row locks, so the verdict below is read on rows no other writer can
  // promote, price or claim before the archive lands.
  const shells = await untouchedWebFormShells(trx, values.last10, { now })
    .whereIn('id', open.map((row) => row.id))
    .forUpdate()
    .select('id', 'address', 'customer_id', 'customer_email');
  const shellIds = (Array.isArray(shells) ? shells : [])
    .filter((row) => sameContact(row, { customerId, email }) && sameDoor(row.address, address))
    .map((row) => row.id);
  // Every open estimate of the phone must be one of this run's shells.
  // Anything else still blocks the run, and then no shell goes.
  const shellKeys = new Set(shellIds.map(String));
  return open.every((row) => shellKeys.has(String(row.id))) ? shellIds : [];
}

async function archiveWebFormShellsInTx(trx, { phone, shellIds = [], leadId = null, replacementId = null, now = new Date() } = {}) {
  const values = phoneLookupValues(phone);
  if (!trx || !values.last10 || !shellIds.length) return [];
  const marker = JSON.stringify({ at: now.toISOString(), leadId: leadId == null ? null : String(leadId) });
  // Guarded by the full predicate again: the update can only land on a row
  // that is still an untouched shell.
  const retired = await untouchedWebFormShells(trx, values.last10, { now })
    .whereIn('id', shellIds)
    .update({
      archived_at: now,
      estimate_data: trx.raw(
        "jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{supersededByWizard}', ?::jsonb, true)",
        [marker]
      ),
      updated_at: now,
    })
    .returning('id');
  const retiredIds = (Array.isArray(retired) ? retired : []).map((row) => (row && typeof row === 'object' ? row.id : row));
  // All or nothing. The row locks cover the estimate rows, not the leads
  // table, and the phone lock serializes the automated writers only: since
  // the plan, a lead can have linked a shell, and the office can have saved
  // its own estimate for the phone. The caller planned its write on "the
  // shells are every open estimate", so it must not commit.
  const others = await listOpenEstimatesByPhone(phone, { database: trx, excludeEstimateId: replacementId || undefined });
  if (retiredIds.length !== shellIds.length || others.length) {
    throw new Error(`web-form shell changed under the wizard run: planned ${shellIds.length}, archived ${retiredIds.length}, other open estimates ${others.length}`);
  }
  return retiredIds;
}

module.exports = {
  acquireAutomatedEstimateLocks,
  lockSupersededDraftInTx,
  archiveSupersededDraftInTx,
  lockUntouchedWebFormShellsInTx,
  archiveWebFormShellsInTx,
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
