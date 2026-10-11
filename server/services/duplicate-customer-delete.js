/**
 * Empty duplicate customer delete — the domain half of the Intelligence Bar
 * tool delete_duplicate_customer (tool definition, gate and dispatch live in
 * services/intelligence-bar/customer-lifecycle-tools.js).
 * server/services/duplicate-customer-delete.js
 *
 * Owner ruling 2026-10-07 (Q3): "soft-delete for empty stubs only (no visits,
 * invoices, payments), carded, restorable." The bar may archive ONE customer
 * record that is only an unknown-contact stub of a real customer sharing its
 * phone. A record with ANY history, or any field the stub creator does not
 * write, is refused and pointed at merge_customers, which moves history onto
 * the real record.
 *
 * ARCHIVE ONLY. The commit is the customer page's own delete handler
 * (routes/admin-customers.js archiveCustomerAsAdmin: billing wind-down guard,
 * deletion gate, newsletter relink, customer.archive audit row). Nothing is
 * merged and nothing is moved: the other record (the "keeper") is only read,
 * never written, so no backfill, dunning release or payment-session change can
 * touch it. The undo is the page's restore route, PATCH
 * /api/admin/customers/:id/restore (clears deleted_at).
 *
 * Inside the archive transaction, in this order (the handler's own lock, then
 * its `precheck`):
 *   1. BOTH customer rows, the archived one and the retained one, are locked
 *      FOR UPDATE in ONE statement in ascending id order (the order the merge
 *      engine locks its pair in, so a delete and a merge on the same pair
 *      cannot deadlock) and held until the archive commits;
 *   2. acquirePairAdjudicationLock(keeper, stub) - the lock the "not a
 *      duplicate" dismissal takes - so a dismissal cannot commit alongside
 *      (the merge engine also takes it after its row locks);
 *   3. the duplicate queue's verdict again (duplicateWinnerFor, same-identity
 *      only): the pair must still be eligible and the keeper must be the one
 *      on the card;
 *   4. BOTH content pins must match: a fingerprint of the allow-listed columns
 *      (customer-empty-loser.js contentFingerprint), because the Customer 360
 *      save edits those columns without bumping updated_at;
 *   5. the emptiness scan again on the locked row (customer-empty-loser.js).
 * Then the archive writes.
 *
 * SAME IDENTITY ONLY. The queue lists some pairs as a possible match (a
 * different name, or a phone line holding more than one identity). Those are
 * not confirmed duplicates; the tool refuses them and points at
 * merge_customers.
 *
 * The retained record comes from ONE queue build (duplicateWinnerFor). The
 * queue is phone-based and no email pair check exists, so a record linked only
 * by a shared email is refused.
 *
 * Remaining window, the same one the customer page delete and the merge engine
 * have: no lock is shared by every history writer, so a foreign-key child
 * insert waiting on the row lock, or a write to a pointer with no foreign key,
 * can commit just after the archive and attach to the archived row. The record
 * stays restorable. This tool adds no post-commit snapshot.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { CHECKS, readEmptiness, notEmptyRefusal, contentFingerprint } = require('./customer-empty-loser');

function phone10(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function maskEmail(address) {
  const text = String(address || '').trim();
  if (!text) return null;
  const [local, domain] = text.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `(***) ***-${digits.slice(-4)}` : null;
}

function customerName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';
}

function identityLine(row) {
  const parts = [maskPhone(row.phone) && `phone ${maskPhone(row.phone)}`, maskEmail(row.email) && `email ${maskEmail(row.email)}`].filter(Boolean);
  return `${customerName(row)} (${parts.join(', ') || 'no phone or email'}), created ${row.created_on || 'unknown date'}`;
}

// The date a record was created, as the office sees it: the repo's Eastern
// calendar date (utils/datetime-et etDateString). The database session runs
// in UTC, so formatting the timestamp in SQL puts an evening record on the
// next day.
const createdOnET = (row) => (row.created_at ? etDateString(new Date(row.created_at)) : null);

async function loadCustomer(customerId, conn = db) {
  const row = await conn('customers').where({ id: customerId }).first();
  return row ? { ...row, created_on: createdOnET(row), version: contentFingerprint(row) } : row;
}

// Refusal path only: why the queue names no winner for this record. Live
// records sharing its phone or email, to tell "the queue keeps this record"
// from "only an email links it" from "nothing links it".
async function findLinkedLiveRecords(stub, conn = db) {
  const phone = phone10(stub.phone);
  const email = String(stub.email || '').trim().toLowerCase();
  if (!phone && !email) return [];
  return conn('customers')
    .whereNull('deleted_at')
    .whereNot('id', stub.id)
    .where((q) => {
      if (phone) q.orWhereRaw("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone]);
      if (email) q.orWhereRaw('lower(email) = ?', [email]);
    })
    .select('id', 'phone', 'email')
    .limit(25);
}

// The retained record for `stub`, from ONE queue build. Refusals never name a
// person (the route runs the preview before validating the target). Returns
// { winner } or a refusal.
async function retainedRecordFor(stub, conn = db) {
  const { duplicateWinnerFor } = require('./customer-dedupe');
  const verdict = await duplicateWinnerFor(stub.id, conn, { requireSameIdentity: true });
  if (!verdict.winnerId) {
    const linked = await findLinkedLiveRecords(stub, conn);
    const phone = phone10(stub.phone);
    if (!linked.length) {
      return { error: 'No live duplicate found — this tool only removes a duplicate of a real customer (no other live record shares its phone or email).', code: 'no_duplicate' };
    }
    if (!phone || !linked.some((r) => phone10(r.phone) === phone)) {
      return {
        error: 'The only live record linked to this one shares an email, not a phone. The duplicate queue is phone-based and the bar has no email duplicate check, so it will not delete this record. Use merge_customers or the customer page.',
        code: 'email_only_duplicate',
      };
    }
    return {
      error: `The duplicate queue does not list this record as a duplicate of the record sharing its phone (${verdict.code}: ${verdict.reason || 'the queue keeps this record'}). Select the other record, or use merge_customers.`,
      code: 'not_a_mergeable_duplicate',
      pair_code: verdict.code,
    };
  }
  if (!verdict.eligible) {
    return {
      error: `The duplicate queue does not list this record as a mergeable duplicate (${verdict.code}: ${verdict.reason}). Select the other record, or use merge_customers.`,
      code: 'not_a_mergeable_duplicate',
      pair_code: verdict.code,
    };
  }
  const winner = await loadCustomer(verdict.winnerId, conn);
  if (!winner || winner.deleted_at) {
    return { error: 'The record the duplicate queue keeps is no longer available — ask again for a fresh card.', code: 'record_unavailable' };
  }
  return { winner };
}

const RESTORE_LINE = 'Restorable: an admin can restore it from the customer record (restore route); nothing is moved or merged.';
const WINDOW_LINE = 'Same window as the customer page delete: a visit, message or lead written at the very instant of the delete can attach to the archived record. It stays restorable.';
const NO_MESSAGE_LINE = 'No customer message is sent';

async function previewDeleteDuplicateCustomer(customerId) {
  const stub = await loadCustomer(customerId);
  if (!stub) return { error: 'customer_id does not match a customer', code: 'record_unavailable' };
  if (stub.deleted_at) return { error: 'This customer is already deleted — nothing to do.', code: 'record_unavailable' };

  const retained = await retainedRecordFor(stub);
  if (retained.error) return retained;
  const { winner } = retained;

  const refusal = notEmptyRefusal(await readEmptiness(stub, db, winner));
  if (refusal) return refusal;

  const checks = Object.fromEntries(CHECKS.map((c) => [c.label, 'none']));
  const how = 'It is archived only (nothing is moved or merged); the record above is not touched.';
  return {
    preview: true,
    customer_id: stub.id,
    stub: { name: customerName(stub), phone_masked: maskPhone(stub.phone), email_masked: maskEmail(stub.email), created_on: stub.created_on || null },
    duplicate_of: {
      customer_id: winner.id,
      name: customerName(winner),
      phone_masked: maskPhone(winner.phone),
      email_masked: maskEmail(winner.email),
      created_on: winner.created_on || null,
      version: winner.version,
    },
    checks,
    restore: RESTORE_LINE,
    window: WINDOW_LINE,
    customer_message: NO_MESSAGE_LINE,
    _version: stub.version,
    // Curated card lines (routes/admin-intelligence-bar.js PINNED_DISPLAY_BUILDERS).
    card: {
      delete: `Delete the empty duplicate record ${identityLine(stub)}`,
      duplicate_of: `${identityLine(winner)}; stays as is`,
      how,
      checks,
      restore: RESTORE_LINE,
      window: WINDOW_LINE,
      customer_message: NO_MESSAGE_LINE,
    },
    note_to_operator: `${customerName(stub)} holds nothing beyond an unknown-contact stub (every check above is none). ${how} Nothing was changed yet.`,
  };
}

const changedError = (error, code, extra = {}) => Object.assign(new Error(error), { previewChanged: true, code, ...extra });

// The locked checks, one entry each, run in this order inside the archive
// transaction (see the header). `state` = { trx, row, keeper, stubVersion }.
// Each throws changedError to refuse, and may set state.keeperRow.
const LOCKED_STEPS = [
  {
    name: 'stub still live',
    run: async (state) => {
      state.row = await loadCustomer(state.customerId, state.trx);
      if (!state.row || state.row.deleted_at) throw changedError('This customer is already deleted or no longer exists.', 'record_unavailable');
    },
  },
  {
    name: 'pair adjudication lock',
    run: async ({ trx, keeper, customerId }) => {
      const { acquirePairAdjudicationLock } = require('./customer-dedupe');
      await acquirePairAdjudicationLock(trx, keeper.id, customerId);
    },
  },
  {
    name: 'queue verdict',
    run: async ({ trx, keeper, customerId }) => {
      const { duplicateWinnerFor } = require('./customer-dedupe');
      const verdict = await duplicateWinnerFor(customerId, trx, { requireSameIdentity: true });
      if (!verdict.eligible) {
        throw changedError(`The duplicate queue no longer lists this record as a confirmed duplicate (${verdict.code}). Ask again for a fresh card, or use merge_customers.`, verdict.code === 'possible_match_only' ? verdict.code : 'not_a_mergeable_duplicate');
      }
      if (String(verdict.winnerId) !== String(keeper.id)) {
        throw changedError('The record the duplicate queue keeps changed after the card was shown. Ask again for a fresh card.', 'keeper_changed');
      }
    },
  },
  {
    name: 'stub content pin',
    run: async ({ row, stubVersion }) => {
      if (String(row.version) !== String(stubVersion)) {
        throw changedError('This customer record changed after the card was shown. Ask again for a fresh card.', 'version_changed');
      }
    },
  },
  {
    name: 'keeper content pin',
    run: async (state) => {
      state.keeperRow = await loadCustomer(state.keeper.id, state.trx);
      if (!state.keeperRow || state.keeperRow.deleted_at) {
        throw changedError('The record this duplicate belongs to is no longer available. Ask again for a fresh card.', 'record_unavailable');
      }
      if (String(state.keeperRow.version) !== String(state.keeper.version)) {
        throw changedError('The record this duplicate belongs to changed after the card was shown. Ask again for a fresh card.', 'keeper_version_changed');
      }
    },
  },
  {
    name: 'still empty',
    run: async ({ trx, row, keeperRow }) => {
      const refusal = notEmptyRefusal(await readEmptiness(row, trx, keeperRow));
      if (refusal) throw changedError(refusal.error, refusal.code, { found: refusal.found });
    },
  },
];

// The pins the locked section asserts. A call with no card (direct) pins what
// is read now; with a card the approved pins are used. Returns { keeper,
// stubVersion } or a refusal.
async function resolvePins(stub, approvedVersion, approvedKeeper) {
  if (approvedKeeper) return { keeper: approvedKeeper, stubVersion: approvedVersion || stub.version };
  const retained = await retainedRecordFor(stub);
  if (retained.error) return { refusal: { error: retained.error, code: retained.code, preview_changed: true } };
  return { keeper: { id: retained.winner.id, version: retained.winner.version }, stubVersion: approvedVersion || stub.version };
}

// The page handler's reply as the tool's result.
function archiveOutcome({ status, json }, customerId, keeperId) {
  if (status === 200 && json?.success) {
    logger.info(`[intelligence-bar] delete_duplicate_customer archived customer ${customerId} (duplicate of ${keeperId}; nothing moved)`);
    return { success: true, customer_id: customerId, deleted: true, restore: RESTORE_LINE, customer_message: NO_MESSAGE_LINE };
  }
  const message = json?.message || json?.error || `Delete failed (HTTP ${status})`;
  return { error: message, ...(status === 404 ? { preview_changed: true } : {}) };
}

// The archive-only commit: the customer page's delete handler, with the
// decisive checks in its `precheck` (inside the archive transaction, after
// both row locks, before any write). `approvedVersion` and `approvedKeeper`
// ({ id, version }) are the card's content pins (route-owned).
async function commitDeleteDuplicateCustomer(customerId, actionContext, approvedVersion = null, approvedKeeper = null) {
  const stub = await loadCustomer(customerId);
  if (!stub || stub.deleted_at) {
    return { error: 'This customer is already deleted or no longer exists.', code: 'record_unavailable', preview_changed: true };
  }
  const pins = await resolvePins(stub, approvedVersion, approvedKeeper);
  if (pins.refusal) return pins.refusal;
  const { keeper, stubVersion } = pins;

  const precheck = async (trx) => {
    const state = { trx, customerId, keeper, stubVersion };
    for (const step of LOCKED_STEPS) await step.run(state);
  };

  const { archiveCustomerAsAdmin } = require('../routes/admin-customers');
  let reply;
  try {
    reply = await archiveCustomerAsAdmin({
      customerId,
      actor: { technicianId: actionContext.technicianId || null, userAgent: 'intelligence-bar:delete_duplicate_customer' },
      precheck,
      alsoLock: keeper.id,
    });
  } catch (err) {
    if (err && err.previewChanged) return { error: err.message, code: err.code, ...(err.found ? { found: err.found } : {}), preview_changed: true };
    throw err;
  }
  return archiveOutcome(reply, customerId, keeper.id);
}

module.exports = {
  previewDeleteDuplicateCustomer,
  commitDeleteDuplicateCustomer,
  RESTORE_LINE,
  WINDOW_LINE,
  NO_MESSAGE_LINE,
  _test: { createdOnET, maskEmail, maskPhone, LOCKED_STEPS },
};
