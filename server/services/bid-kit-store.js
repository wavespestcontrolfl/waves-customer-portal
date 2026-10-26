'use strict';

// Bid kit data access (GATE_BID_KIT, dark, admin only). The only module that reads or writes bid_kit_items. A row read
// here never carries the private file key: has_file says whether a file exists, and the key comes out only through
// fileInfo() for the signed-link route. Dates are read as text (YYYY-MM-DD) so no time zone can move them.
const db = require('../models/db');
const logger = require('./logger');
const { errorTag } = require('./bid-kit-log');

const TABLE = 'bid_kit_items';

const DAY = (column) => `to_char(i.${column}, 'YYYY-MM-DD') AS ${column}`;
const SELECT = [
  'i.id', 'i.kind', 'i.item_key', 'i.label', 'i.value', 'i.file_name', 'i.file_content_type', 'i.file_size',
  'i.limits', 'i.details', 'i.source_document', 'i.attested_by', 'i.attested_at', 'i.notes', 'i.archived_at', 'i.created_at', 'i.updated_at',
];
function selectRows(conn) {
  return conn(`${TABLE} as i`)
    .select(SELECT)
    .select(conn.raw('(i.file_s3_key IS NOT NULL) AS has_file'))
    .select(conn.raw(DAY('checked_on')), conn.raw(DAY('expires_on')), conn.raw(DAY('permission_on')));
}

// Items in checklist order: kind, key, then oldest first. Archived rows only when asked.
async function listItems({ all = false } = {}) {
  const query = selectRows(db).orderBy([{ column: 'i.kind' }, { column: 'i.item_key' }, { column: 'i.created_at' }]);
  if (!all) query.whereNull('i.archived_at');
  return query;
}

async function getItem(id, conn = db) {
  return selectRows(conn).where('i.id', id).first();
}

// The private key and name for the signed link; never part of any list or detail response.
async function fileInfo(id) {
  const row = await db(TABLE).where({ id }).whereNull('archived_at').first('file_s3_key', 'file_name', 'file_content_type');
  if (!row) return null;
  return { key: row.file_s3_key, fileName: row.file_name, contentType: row.file_content_type };
}

// One live row per catalog item unless it takes many (references, custom). The check runs under a lock on the item key,
// so two quick saves cannot both pass it.
async function createItem(row, { unique = false } = {}) {
  return db.transaction(async (trx) => {
    if (unique) {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`bid-kit:${row.kind}:${row.item_key}`]);
      const existing = await trx(TABLE).where({ kind: row.kind, item_key: row.item_key }).whereNull('archived_at').first('id');
      if (existing) return { duplicate: true };
    }
    const [{ id }] = await trx(TABLE).insert(row).returning('id');
    return { item: await getItem(id, trx) };
  });
}

// Reads the row under a lock, lets `compute(row)` decide, and writes in the same transaction.
// compute returns { error } to refuse, or { patch } to write (an empty patch writes nothing).
async function updateItem(id, compute) {
  return db.transaction(async (trx) => {
    const locked = await trx(TABLE).where({ id }).forUpdate().first('id');
    if (!locked) return { notFound: true };
    const row = await getItem(id, trx);
    if (!row || row.archived_at) return { notFound: true };
    const decision = compute(row);
    if (decision.error) return { error: decision.error };
    if (decision.patch && Object.keys(decision.patch).length) {
      await trx(TABLE).where({ id }).update({ ...decision.patch, updated_at: trx.raw('clock_timestamp()') });
    }
    return { item: await getItem(id, trx), before: row };
  });
}

// What a caller may conclude from a failed replaceFile. The transaction is run by hand so the two cases can be told apart:
//   'rolled_back' the failure came BEFORE a commit was issued (no transaction, a failed statement, a failed rollback): the
//                 row was not changed, so the caller may delete the new object it stored;
//   'unknown'     the commit itself failed (a lost acknowledgement): the row may point at the new object, so the caller must
//                 keep it. Any error without a tag is treated as unknown.
const outcomeOf = (err, outcome) => {
  const tagged = err && typeof err === 'object' ? err : new Error('replaceFile failed');
  tagged.bidKitOutcome = outcome;
  return tagged;
};

// Puts a new file on the row and clears the sign-off in the same update, but only against the version the page loaded
// (millisecond precision, like every other versioned write): a row that changed since is { conflict: true } and nothing is
// written. Returns the old key so the caller can remove it AFTER this has committed. A thrown error carries bidKitOutcome.
// options (the daily Product List rebuild only; the route passes none): `details` is merged into the row's details object in
// the same update, and `attestBySystem` leaves the new file signed off by the system (attested_by null, attested_at now)
// instead of clearing the sign-off.
async function replaceFile(id, file, expectedUpdatedAt, options = {}) {
  let trx;
  try {
    trx = await db.transaction();
  } catch (err) {
    throw outcomeOf(err, 'rolled_back');
  }
  // A rollback with no error rejects this promise by design: nothing waits on it on those paths, so mark it handled.
  trx.executionPromise.catch(() => {});
  let result;
  try {
    const locked = await trx(TABLE).where({ id }).forUpdate().first('id', 'file_s3_key', 'archived_at', 'updated_at');
    if (!locked || locked.archived_at) result = { notFound: true };
    else if (new Date(locked.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) result = { conflict: true };
    else {
      await trx(TABLE).where({ id }).update({
        file_s3_key: file.key,
        file_name: file.fileName,
        file_content_type: file.contentType,
        file_size: file.size,
        attested_by: null,
        attested_at: options.attestBySystem ? trx.raw('clock_timestamp()') : null,
        ...(options.details ? { details: trx.raw("COALESCE(details, '{}'::jsonb) || ?::jsonb", [JSON.stringify(options.details)]) } : {}),
        updated_at: trx.raw('clock_timestamp()'),
      });
      result = { item: await getItem(id, trx), oldKey: locked.file_s3_key || null };
    }
  } catch (err) {
    await trx.rollback().catch(() => {});
    throw outcomeOf(err, 'rolled_back');
  }
  if (result.notFound || result.conflict) {
    await trx.rollback().catch(() => {});
    return result;
  }
  // Knex reports a failed COMMIT through trx.executionPromise, and trx.commit() itself can still resolve. Both are awaited, so a
  // commit that did not go through is never mistaken for one that did, and the unknown outcome is reported as such.
  try {
    await trx.commit();
    await trx.executionPromise;
  } catch (err) {
    throw outcomeOf(err, 'unknown');
  }
  return result;
}

// One UPDATE that archives the row only while it is live and still the version the page loaded (millisecond precision, the
// precision the page has). Nothing matched: { notFound } for a row that is gone or already archived, { conflict } for a row
// that changed since, and nothing is written in either case.
async function archiveItem(id, expectedUpdatedAt) {
  const [row] = await db(TABLE).where({ id }).whereNull('archived_at')
    .whereRaw("date_trunc('milliseconds', updated_at) = ?::timestamptz", [expectedUpdatedAt])
    .update({ archived_at: db.fn.now(), updated_at: db.fn.now() }).returning('id');
  if (row) return { item: await getItem(row.id) };
  const live = await db(TABLE).where({ id }).whereNull('archived_at').first('id');
  return live ? { conflict: true } : { notFound: true };
}

// Same shape as admin-credentials.js: the Activity page can show "last updated by". Field names only, never values.
async function logActivity(adminUserId, action, description, metadata) {
  try {
    await db('activity_log').insert({
      admin_user_id: adminUserId || null,
      action,
      description,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
  } catch (err) {
    logger.warn(`[bid-kit] activity_log write failed: ${errorTag(err)}`);
  }
}

module.exports = { TABLE, listItems, getItem, fileInfo, createItem, updateItem, replaceFile, archiveItem, logActivity };
