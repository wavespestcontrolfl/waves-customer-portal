'use strict';

// Bid kit data access (GATE_BID_KIT, dark, admin only). The only module that reads or writes bid_kit_items. A row read
// here never carries the private file key: has_file says whether a file exists, and the key comes out only through
// fileInfo() for the signed-link route. Dates are read as text (YYYY-MM-DD) so no time zone can move them.
const db = require('../models/db');
const logger = require('./logger');

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

// Puts a new file on the row and clears the sign-off in the same update, but only against the version the page loaded
// (millisecond precision, like every other versioned write): a row that changed since is { conflict: true } and nothing is
// written. Returns the old key so the caller can remove it.
async function replaceFile(id, file, expectedUpdatedAt) {
  return db.transaction(async (trx) => {
    const locked = await trx(TABLE).where({ id }).forUpdate().first('id', 'file_s3_key', 'archived_at', 'updated_at');
    if (!locked || locked.archived_at) return { notFound: true };
    if (new Date(locked.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) return { conflict: true };
    await trx(TABLE).where({ id }).update({
      file_s3_key: file.key,
      file_name: file.fileName,
      file_content_type: file.contentType,
      file_size: file.size,
      attested_by: null,
      attested_at: null,
      updated_at: trx.raw('clock_timestamp()'),
    });
    return { item: await getItem(id, trx), oldKey: locked.file_s3_key || null };
  });
}

async function archiveItem(id) {
  const [row] = await db(TABLE).where({ id }).whereNull('archived_at')
    .update({ archived_at: db.fn.now(), updated_at: db.fn.now() }).returning('id');
  return row ? getItem(row.id) : null;
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
    logger.warn(`[bid-kit] activity_log write failed: ${err.message}`);
  }
}

module.exports = { TABLE, listItems, getItem, fileInfo, createItem, updateItem, replaceFile, archiveItem, logActivity };
