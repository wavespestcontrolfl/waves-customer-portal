'use strict';

/**
 * Bid Desk checklist (GATE_BID_CHECKLIST). One list per bid, built from shared/bid-checklist-templates.cjs when the
 * operator presses "Start checklist", then edited by hand: custom lines (with the quote or page cite from the
 * solicitation), edits, order, tick and untick, archive. Nothing here sends anything to a buyer, a contractor or an
 * agency. Every function takes the connection (a transaction in the routes), so a start runs under the bid-row lock.
 */
const { templateRows, SECTION_CUSTOM } = require('../../../shared/bid-checklist-templates.cjs');

const ITEM_COLUMNS = [
  'id', 'bid_id', 'position', 'section', 'label', 'source_text', 'required', 'template_key', 'checked_at', 'checked_by',
  'notes', 'created_at', 'updated_at',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The live (not archived) lines of a bid, in order. */
function listItems(conn, bidId) {
  return conn('bid_checklist_items').where({ bid_id: bidId }).whereNull('archived_at')
    .orderBy([{ column: 'position' }, { column: 'created_at' }, { column: 'id' }]).select(ITEM_COLUMNS);
}

/** { checked, required, total }: ticked required lines of the required lines; total counts every live line. */
function progressOf(items) {
  const live = items.filter((item) => !item.archived_at);
  const required = live.filter((item) => item.required);
  return { checked: required.filter((item) => item.checked_at).length, required: required.length, total: live.length };
}

// The highest position in use, archived lines included, so a new line never lands among old ones.
async function nextPosition(conn, bidId) {
  const row = await conn('bid_checklist_items').where({ bid_id: bidId }).max({ top: 'position' }).first();
  return Number(row?.top || 0) + 1;
}

/**
 * Inserts the template lines for `type`. Idempotent: a bid that already has lines is left alone, unless `addMissing`,
 * which adds only the template lines the bid does not carry (matched by template_key; an archived line still counts as
 * carried, so a line the operator removed does not come back).
 * @returns {Promise<{ added: number, existing: number }>}
 */
async function startChecklist(conn, bidId, type, { addMissing = false } = {}) {
  const have = await conn('bid_checklist_items').where({ bid_id: bidId }).select('template_key');
  if (have.length && !addMissing) return { added: 0, existing: have.length };
  const carried = new Set(have.map((row) => row.template_key).filter(Boolean));
  const rows = templateRows(type).filter((row) => !carried.has(row.template_key));
  if (!rows.length) return { added: 0, existing: have.length };
  const first = await nextPosition(conn, bidId);
  await conn('bid_checklist_items').insert(rows.map((row, index) => ({ bid_id: bidId, position: first + index, ...row })));
  return { added: rows.length, existing: have.length };
}

/** A custom line the operator typed (no template key). */
async function addItem(conn, bidId, { label, sourceText, notes, required }) {
  const [row] = await conn('bid_checklist_items').insert({
    bid_id: bidId,
    position: await nextPosition(conn, bidId),
    section: SECTION_CUSTOM,
    label,
    source_text: sourceText || null,
    notes: notes || null,
    required: required !== false,
  }).returning(ITEM_COLUMNS);
  return row;
}

const liveItem = (conn, bidId, itemId) => conn('bid_checklist_items').where({ id: itemId, bid_id: bidId }).whereNull('archived_at');

/**
 * Edits one line. `checked` true stamps checked_at (now) and checked_by (the actor, when it is a staff id); false clears
 * both. Returns the new row, or null when the line is not a live line of that bid.
 */
async function updateItem(conn, bidId, itemId, changes, actorId) {
  const patch = { updated_at: conn.fn.now() };
  if (changes.label !== undefined) patch.label = changes.label;
  if (changes.sourceText !== undefined) patch.source_text = changes.sourceText || null;
  if (changes.notes !== undefined) patch.notes = changes.notes || null;
  if (changes.required !== undefined) patch.required = changes.required;
  if (changes.checked !== undefined) {
    patch.checked_at = changes.checked ? conn.fn.now() : null;
    patch.checked_by = changes.checked && UUID.test(String(actorId || '')) ? actorId : null;
  }
  const [row] = await liveItem(conn, bidId, itemId).update(patch).returning(ITEM_COLUMNS);
  return row || null;
}

/** Removes a line from the list without losing it (archived_at). Returns whether a live line was archived. */
async function archiveItem(conn, bidId, itemId) {
  const count = await liveItem(conn, bidId, itemId).update({ archived_at: conn.fn.now(), updated_at: conn.fn.now() });
  return count > 0;
}

/**
 * Re-orders the live lines. `ids` must be exactly the bid's live line ids, each once; otherwise nothing changes and the
 * answer is false (the page reloads and tries again).
 */
async function reorderItems(conn, bidId, ids) {
  const live = await conn('bid_checklist_items').where({ bid_id: bidId }).whereNull('archived_at').forUpdate().select('id');
  const want = new Set(live.map((row) => row.id));
  if (ids.length !== want.size || new Set(ids).size !== ids.length || !ids.every((id) => want.has(id))) return false;
  for (let index = 0; index < ids.length; index += 1) {
    await conn('bid_checklist_items').where({ id: ids[index], bid_id: bidId }).update({ position: index + 1, updated_at: conn.fn.now() });
  }
  return true;
}

/** Progress for many bids at once (the list page's chip): { [bidId]: { checked, required } }. */
async function progressForBids(conn, bidIds) {
  if (!bidIds.length) return {};
  const rows = await conn('bid_checklist_items').whereIn('bid_id', bidIds).whereNull('archived_at').where('required', true)
    .groupBy('bid_id').select('bid_id')
    .count({ required: '*' })
    .select(conn.raw('COUNT(checked_at) AS checked'));
  const out = {};
  for (const row of rows) out[row.bid_id] = { checked: Number(row.checked), required: Number(row.required) };
  return out;
}

module.exports = { listItems, progressOf, startChecklist, addItem, updateItem, archiveItem, reorderItems, progressForBids, ITEM_COLUMNS };
