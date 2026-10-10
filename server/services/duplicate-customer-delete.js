/**
 * Empty duplicate customer delete — the domain half of the Intelligence Bar
 * tool delete_duplicate_customer (tool definition, gate and dispatch live in
 * services/intelligence-bar/customer-lifecycle-tools.js).
 * server/services/duplicate-customer-delete.js
 *
 * Owner ruling 2026-10-07 (Q3): "soft-delete for empty stubs only (no visits,
 * invoices, payments), carded, restorable." The bar may remove ONE customer
 * record that holds nothing — typically an "Unknown" stub that shares a real
 * customer's phone. A record with ANY history is refused and pointed at
 * merge_customers, which moves that history onto the real record.
 *
 * This is a thin PRESET of the merge engine, not a second delete path. The
 * commit is customer-dedupe.js executeMerge with the stub as the loser and
 * the record the duplicate queue keeps as the winner, exactly as
 * merge_customers calls it, plus one extra precondition the engine checks
 * itself (requireEmptyLoser):
 *   - the pair's final queue verdict runs under the engine's row locks and
 *     the pair adjudication lock (the lock the "not a duplicate" dismissal
 *     takes), so a dismissal cannot commit alongside the delete;
 *   - the loser must hold nothing, read under those same locks, before the
 *     first write (customer-empty-loser.js: the engine's own blocker and
 *     effect readers plus the history a merge rewrites with no customer_id
 *     column);
 *   - the loser is archived the way every merge archives it (deleted_at, its
 *     phone and email retired) and journaled, so the duplicate queue's undo
 *     reverses it.
 * Nothing moves, because the record holds nothing. The same fence as every
 * merge applies: a row that commits after the merge was blocked on the
 * customer lock lands on the archived record, which the undo then refuses to
 * revert as untouched (the engine's own activity gate).
 *
 * The retained record comes from ONE queue build (duplicateWinnerFor): the
 * group that lists the stub as a candidate names its winner. The queue is
 * phone-based and no email pair check exists, so a record linked only by a
 * shared email is refused.
 *
 * Two-step (WRITE_TWO_STEP_TOOL_NAMES): an unconfirmed call is
 * mutation-free and returns the card. The preview carries the stub's
 * version (`_version`), so the route's fingerprint pin refuses Confirm when
 * the card, the retained record or any check changed, and the engine
 * re-asserts the approved version under its locks.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { CHECKS, readEmptiness, notEmptyRefusal } = require('./customer-empty-loser');

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
  const row = await conn('customers').where({ id: customerId })
    .select('*', db.raw('updated_at::text AS version'))
    .first();
  return row ? { ...row, created_on: createdOnET(row) } : row;
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

// The retained record for `stub`, from ONE queue build, plus the merge
// executor's other deterministic refusals (rowLevelMergeConflict and
// dbLevelMergeConflict — billing, payer, a different multi-property account
// with other live members). Refusals never name a person (the route runs the
// preview before validating the target). Returns { winner } or a refusal.
async function retainedRecordFor(stub, conn = db) {
  const { duplicateWinnerFor, rowLevelMergeConflict, dbLevelMergeConflict } = require('./customer-dedupe');
  const verdict = await duplicateWinnerFor(stub.id, conn);
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
  const conflict = rowLevelMergeConflict(winner, stub) || await dbLevelMergeConflict(conn, winner, stub);
  if (conflict) {
    return { error: `The merge path would refuse this duplicate (${conflict.code}: ${conflict.message}). Use merge_customers after resolving it.`, code: 'merge_conflict', merge_code: conflict.code };
  }
  return { winner };
}

const UNDO_LINE = "Reversible: the delete is archived through the merge engine and journaled, so the duplicate queue's undo brings it back.";
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
  const stubLine = identityLine(stub);
  const winnerLine = identityLine(winner);
  const how = 'It is archived into the record above through the merge engine; nothing moves because the record holds nothing.';
  return {
    preview: true,
    customer_id: stub.id,
    stub: { name: customerName(stub), phone_masked: maskPhone(stub.phone), email_masked: maskEmail(stub.email), created_on: stub.created_on || null },
    archived_into: {
      customer_id: winner.id,
      name: customerName(winner),
      phone_masked: maskPhone(winner.phone),
      email_masked: maskEmail(winner.email),
      created_on: winner.created_on || null,
      version: winner.version,
    },
    checks,
    undo: UNDO_LINE,
    customer_message: NO_MESSAGE_LINE,
    _version: stub.version,
    // Curated card lines (routes/admin-intelligence-bar.js PINNED_DISPLAY_BUILDERS).
    card: {
      delete: `Delete the empty duplicate record ${stubLine}`,
      archived_into: `${winnerLine}; stays as is`,
      how,
      checks,
      undo: UNDO_LINE,
      customer_message: NO_MESSAGE_LINE,
    },
    note_to_operator: `${customerName(stub)} holds nothing (every check above is none). ${how} Nothing was changed yet.`,
  };
}

// The commit IS executeMerge, the same call merge_customers makes, with the
// stub as the loser, the queue's retained record as the winner and
// requireEmptyLoser. Everything decisive runs inside the engine's locked
// section: the stub's approved version, the pair's queue verdict under the
// pair adjudication lock, the engine's other refusals, and "still empty".
async function commitDeleteDuplicateCustomer(customerId, actionContext, approvedVersion = null) {
  const stub = await loadCustomer(customerId);
  if (!stub || stub.deleted_at) {
    return { error: 'This customer is already deleted or no longer exists.', code: 'record_unavailable', preview_changed: true };
  }
  // One queue build picks the retained record (the engine re-checks the pair
  // under its locks; this read only names the winner).
  const retained = await retainedRecordFor(stub);
  if (retained.error) return { error: retained.error, code: retained.code, preview_changed: true };
  const { winner } = retained;

  const { executeMerge } = require('./customer-dedupe');
  try {
    const result = await executeMerge({
      winnerId: winner.id,
      loserId: stub.id,
      performedBy: `ib:${actionContext.technicianId || 'unknown'}`,
      performedById: actionContext.technicianId || null,
      mode: 'intelligence_bar',
      evidence: { via: 'intelligence_bar', preset: 'delete_duplicate_customer' },
      // The APPROVED card's stub version (route pin), else the one just read;
      // validated by the engine under its row locks.
      expectedVersions: { loser: approvedVersion || stub.version },
      requireQueueEligibility: true,
      requireEmptyLoser: true,
    });
    logger.info(`[intelligence-bar] delete_duplicate_customer archived ${customerId} into ${winner.id} (journal ${result.journalId})`);
    return {
      success: true,
      customer_id: customerId,
      deleted: true,
      archived_into: winner.id,
      journal_id: result.journalId,
      undo: UNDO_LINE,
      customer_message: NO_MESSAGE_LINE,
    };
  } catch (err) {
    if (err && err.emptyLoserRefusal) {
      const { error, code, found } = err.emptyLoserRefusal;
      return { error, code, found, preview_changed: true };
    }
    // The engine's own refusals (version moved, pair no longer mergeable, a
    // billing conflict, a live collection call) are plain domain errors:
    // relay the message; nothing committed (one transaction).
    const drifted = err && (err.previewChanged === true || /deleted|not found/i.test(err.message || ''));
    if (!err || !err.message) throw err;
    return { error: err.message, ...(err.mergeConflictCode ? { code: err.mergeConflictCode } : {}), ...(drifted ? { preview_changed: true } : {}) };
  }
}

module.exports = {
  previewDeleteDuplicateCustomer,
  commitDeleteDuplicateCustomer,
  UNDO_LINE,
  NO_MESSAGE_LINE,
  _test: { createdOnET, maskEmail, maskPhone },
};
