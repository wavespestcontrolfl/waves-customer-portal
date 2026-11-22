'use strict';

/**
 * Tech-confirmed roof points on the customer estimate (owner ruling 2026-11-20, choice 4A, no new spend).
 *
 * The customer estimate shows ONLY the roof points the technician confirmed, on the county roof photo, in the Waves AI
 * card in place of the satellite photo. Two halves:
 *   - freezeRoofPointsForEstimate: at every send with a real provider handoff (and for each group sibling once that send
 *     published it), copy what customerPointsFromRow gives for the newest finished read of the estimate's own context
 *     whose points the technician set into estimate_roof_points (a re-send replaces it; no points now deletes it). The points must have been saved for the
 *     address the estimate has now (points_address: the address the staff lookup ran for, sent by the panel with the
 *     points and the photo centre), or nothing is copied. The copy names the handoff that wrote it (delivered_at).
 *     Between sends the copy never changes, so a re-read, an edit or a label change cannot alter an estimate the
 *     customer already holds. Fail-soft by contract: it never throws, so it can never block or fail a send.
 *   - roofPointsDocBlock: the /data key `{ roofPoints: { imageUrl, imageYear, pins } }`, or `{}` so a response with no
 *     snapshot stays byte-identical. Staff hiding is immediate (checked against the estimate's read rows NOW), and
 *     the read the copy came from must still be one of the estimate's own; the content is the frozen copy. An estimate moved to another address since the send prints nothing, and so does a copy older than
 *     the estimate's latest handoff (a later send could not replace or delete it).
 *
 * A lead's copy and the first customer (owner 2026-11-21, follow-up "keep"; migration 20261121210000): the copy a lead
 * already holds stays on the page for the FIRST customer the estimate takes after that send (copyForHolder), and a send
 * to that customer keeps it while no points were saved for them (keepOrFreeze, leadCopyToKeep). No row changes its owner and nothing
 * new is published: it is the same copy, for the person the lead became.
 */

const db = require('../models/db');
const logger = require('./logger');
const { customerPointsFromRow, matchesContext, shownPinLabel } = require('./roof-entry-read');
const { addressKey, addressZip } = require('./misting-layout-validate');

const TABLE = 'estimate_roof_points';
const READS = 'roof_entry_reads';
const NEWEST = [{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }];
// Knex puts bound values (the address, the photo centre, the technician's notes) in err.message: log the code only.
const errCode = (err) => err?.code || 'error';

function parsed(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// The estimate as a roof-read context (lower-case ids, as roof-entry-read builds them).
const estimateContext = (estimate) => ({
  estimateId: String(estimate.id).toLowerCase(),
  customerId: estimate.customer_id ? String(estimate.customer_id).toLowerCase() : null,
  estimateOwned: Boolean(estimate.customer_id),
});

/**
 * Is this read the estimate's own, so its points and notes may go to whoever holds the estimate now?
 * One rule: points reach a customer only when a person saved them FOR that customer: while that customer held the
 * estimate, or on the read staff made for that customer while the estimate had no customer yet (the two-part read).
 *  - The read and the estimate must name the SAME customer, or both name none. A points save writes the customer who
 *    holds the estimate on a read that names none (saveTechCount), so the read's customer is the one the points were
 *    confirmed for. A read that names A is not B's once the estimate goes to B. A read that names no customer (points
 *    confirmed for a lead) is not a customer's own: no send freezes it for a customer. Staff save the points once more
 *    and that save names the customer. (The copy a lead already holds is another matter: see copyForHolder.) A
 *    duplicate merge repoints the read and the estimate together, so the merged customer keeps it.
 *  - And the roof read's own context rule (matchesContext): the estimate's plain row, or the two-part row of the
 *    customer the estimate belongs to now.
 */
function ownRead(row, estimate) {
  const ctx = estimateContext(estimate);
  const named = row.customer_id ? String(row.customer_id).toLowerCase() : null;
  return named === ctx.customerId && matchesContext(row, ctx);
}

/**
 * The newest finished read of the estimate whose points the technician set, or undefined.
 *  - "Set" is a saved list (an empty one counts: the technician confirmed none) or a cleared one (crop_lat is written
 *    with every points list and a clear leaves it). So neither an empty list nor a clear lets an older read's points
 *    come back. A read on which no list was ever saved is not "set".
 *  - "Of the estimate" is ownRead: a read taken for another customer, while the estimate had no customer or while that
 *    customer held it, is never published on it.
 * Every candidate is judged: there is no limit.
 */
async function newestPointsRead(estimate, knex) {
  const rows = await knex(READS)
    .where({ estimate_id: estimate.id, status: 'done' })
    .whereRaw("(crop_lat IS NOT NULL OR (tech_pins IS NOT NULL AND jsonb_typeof(tech_pins) = 'array'))")
    .orderBy(NEWEST)
    .select();
  return rows.find((row) => ownRead(row, estimate));
}

// The misting layout's address comparison (addressKey: case, spacing, punctuation and a trailing ZIP or state are
// ignored), with two stricter rules. Both sides must name an address: with one missing, blank or only punctuation
// nothing proves the roof is this home's. And two different ZIP codes are two homes (the same street line exists in
// more than one town); a ZIP on one side only still matches.
function sameHome(a, b) {
  const key = addressKey(a);
  if (!key || key !== addressKey(b)) return false;
  const [zipA, zipB] = [addressZip(a), addressZip(b)];
  return !zipA || !zipB || zipA === zipB;
}

/**
 * What a send made now would freeze for this estimate: `{ row, points }` (the newest points read and what
 * customerPointsFromRow gives for it), `points` null when there is nothing to show. The ONE place that decides this: the
 * freeze copies it, and a verified staff preview (roofPointsDocBlock) shows it before the first send.
 * The points were saved for the address the staff lookup ran for (the same lookup gave the photo centre). An estimate
 * that has another address now is another roof: it gets no points until staff read and confirm that one.
 * Hidden points and a read saved for another customer give null here too (customerPointsFromRow, ownRead).
 */
async function nextSendPoints(estimate, knex) {
  const row = await newestPointsRead(estimate, knex);
  const points = sameHome(row?.points_address, estimate.address) ? customerPointsFromRow(row) : null;
  return { row, points };
}

const timeMs = (v) => (v ? new Date(v).getTime() : NaN);

/**
 * Freeze (or clear) one estimate's roof points for the send handed off at `deliveredAt` (the lastDeliveredAt that send
 * stamps on the estimate). `estimate` is the row that send read, as it stood BEFORE this handoff's delivery state.
 * Returns 'frozen', 'kept', 'cleared' or 'skipped' (never throws; a storage error is logged and reported as 'skipped',
 * and the page then omits the older copy: see copyIsCurrent).
 *
 * A send never undoes a later one. Sends of one estimate take no common lock here, so a send can reach its write
 * after a send with a later handoff. Every write therefore names only a copy that no later handoff wrote
 * (copyNotNewer, and the same test in writeCopy): the newer copy is not replaced, re-timed or deleted. A freeze or a
 * keep that loses that way is 'skipped'; a clear leaves the newer copy and is still 'cleared'.
 */
async function freezeRoofPointsForEstimate(estimate, { deliveredAt, knex = db } = {}) {
  if (!estimate?.id || !Number.isFinite(timeMs(deliveredAt))) return 'skipped';
  try {
    const at = new Date(deliveredAt).toISOString();
    const next = await nextSendPoints(estimate, knex);
    if (next.points) return await writeCopy(estimate, next, at, knex);
    // No points of the holder's own. `next.row` is a points read of theirs (no points, hidden, another address): it
    // decides, and the copy goes. With none, the lead's copy of a first customer may stay (keepOrFreeze).
    if (!next.row && (await holdsLeadCopy(estimate, knex))) return await keepOrFreeze(estimate, at, knex);
    await copyNotNewer(knex, estimate, at).del();
    return 'cleared';
  } catch (err) {
    logger.warn(`[estimate-roof-points] freeze skipped for estimate ${estimate.id}: ${errCode(err)}`);
    return 'skipped';
  }
}

// The estimate's copy, unless a handoff later than `at` (an ISO time) wrote it.
const copyNotNewer = (knex, estimate, at) => knex(TABLE).where({ estimate_id: estimate.id }).where('delivered_at', '<=', at);

// Write the estimate's copy with these points for the send handed off at `at`, or replace a copy that is not newer.
async function writeCopy(estimate, { row, points }, at, knex) {
  const record = {
    estimate_id: estimate.id,
    read_id: row.id,
    // Both name the same home here. The copy keeps the one that carries a ZIP: the page then sees a later ZIP change
    // on the estimate even when the estimate had no ZIP at this send.
    address: String(addressZip(row.points_address) ? row.points_address : estimate.address),
    snapshot: JSON.stringify(points),
    // Who this copy is for: the customer who holds the estimate at this send (null = none). The page shows the copy
    // only to that holder (copyForHolder).
    customer_id: estimate.customer_id || null,
    // A lead's copy carries the estimate's count of customer changes as that send read it (copyForHolder). Null for a
    // customer's copy, and when the row has no count.
    lead_changes: !estimate.customer_id && Number.isInteger(estimate.customer_changes) ? estimate.customer_changes : null,
    delivered_at: at,
    frozen_at: knex.fn.now(),
  };
  // The update half of the upsert applies only to a copy that is not newer. It then answers no row.
  const written = await knex(TABLE).insert(record).onConflict('estimate_id').merge()
    .where(`${TABLE}.delivered_at`, '<=', at)
    .returning('estimate_id');
  return written.length ? 'frozen' : 'skipped';
}

/**
 * True when the copy belongs to the estimate's latest handoff. Every real handoff stamps deliveryState.lastDeliveredAt
 * and rewrites or deletes the copy; when that write fails the old copy stays, older than the handoff, and is not shown.
 * A copy newer than the stamp (the copy landed, the estimate's own write is still to come) is that send's copy.
 */
function copyIsCurrent(row, estimate) {
  const latest = timeMs(parsed(estimate.estimate_data)?.deliveryState?.lastDeliveredAt);
  const copy = timeMs(row.delivered_at);
  return Number.isFinite(latest) && Number.isFinite(copy) && copy >= latest;
}

// Is any read of this estimate hidden? (Hide or show is one choice for the estimate: see readsAllowCopy.)
async function anyReadHidden(estimate, knex) {
  return Boolean(await knex(READS).where({ estimate_id: estimate.id, hide_on_estimate: true }).first('id'));
}

/**
 * May the copy be shown NOW, by the read rows as they stand?
 *  - Staff did not hide the estimate's roof points. Hide or show is one choice for the estimate: saveTechCount writes it
 *    to every read of the estimate and a new read starts with it. So "hidden" is "any read of this estimate is hidden"
 *    (plus the read the copy came from, by id): no later read, with or without points, brings hidden points back.
 *  - The read the copy came from is still one of this estimate's own reads (ownRead), so an estimate handed to
 *    another customer since the send does not show a read taken for the first one. A copy whose read is gone cannot be
 *    judged, so it is not shown (no code deletes a read).
 *  - For the lead's copy the first customer keeps (keptForFirstCustomer), that read may also still be the lead's: it
 *    names no customer and has the estimate's own key, as when the copy was frozen. A read that names another customer
 *    is never allowed.
 */
async function readsAllowCopy(estimate, copy, knex) {
  const [frozen, anyHidden] = await Promise.all([
    copy.read_id ? knex(READS).where({ id: copy.read_id }).first('hide_on_estimate', 'context_key', 'customer_id', 'estimate_id') : null,
    anyReadHidden(estimate, knex),
  ]);
  if (anyHidden || !frozen || frozen.hide_on_estimate) return false;
  return ownRead(frozen, estimate) || (keptForFirstCustomer(copy, estimate) && ownRead(frozen, { ...estimate, customer_id: null }));
}

/**
 * Customer changes of the estimate since a lead's copy was frozen (estimates.customer_changes now, less the count that
 * send wrote on the copy). NaN, which equals nothing, for a customer's copy, for a copy from before the count
 * (lead_changes null) and for an estimate row that carries no count.
 */
const changesSince = (row, estimate) => (row.customer_id || !Number.isInteger(row.lead_changes) || !Number.isInteger(estimate.customer_changes)
  ? NaN
  : estimate.customer_changes - row.lead_changes);

/**
 * A lead's copy on an estimate that took its FIRST customer since that send: one change since, and a customer now.
 * The copy was frozen with no customer, and the count goes up by one with every change, so that one change is the
 * step from no customer to this one: the customer the lead became.
 */
const keptForFirstCustomer = (row, estimate) => Boolean(estimate.customer_id) && changesSince(row, estimate) === 1;

/**
 * True when the copy was frozen for the one who holds the estimate now.
 *  - A copy that names a customer: that customer holds the estimate. A deleted customer's copies go with the customer
 *    (the foreign key cascades).
 *  - A lead's copy (it names none) that carries the count: the estimate still has no customer and no change since
 *    (the same lead holds the link), or the estimate took its first customer since (keptForFirstCustomer, owner
 *    follow-up "keep"). After any other change (a second customer, a merge, no customer again) it is not shown,
 *    whatever is saved on its read since: the next send freezes a copy for the holder.
 *  - A lead's copy with no count (from before migration 20261121210000) keeps the rule it had: only while the estimate
 *    has no customer.
 */
function copyForHolder(row, estimate) {
  const lower = (v) => (v ? String(v).toLowerCase() : null);
  if (row.customer_id) return lower(row.customer_id) === lower(estimate.customer_id);
  if (row.lead_changes == null) return !estimate.customer_id;
  return estimate.customer_id ? keptForFirstCustomer(row, estimate) : changesSince(row, estimate) === 0;
}

function cleanSnapshot(snapshot) {
  const s = parsed(snapshot);
  if (!s || typeof s.imageUrl !== 'string' || !s.imageUrl || !Array.isArray(s.pins) || !s.pins.length) return null;
  return {
    imageUrl: s.imageUrl,
    imageYear: s.imageYear ?? null,
    pins: s.pins.map((p, i) => ({
      n: Number.isInteger(p.n) ? p.n : i + 1,
      x: Number(p.x),
      y: Number(p.y),
      type: p.type,
      // The label was screened when its note was saved; it is screened again here, where it is shown.
      label: shownPinLabel(p.type, p.label),
      action: String(p.action || ''),
    })),
  };
}

/**
 * The /data key for the customer estimate: `{ roofPoints }`, or `{}`. Fail-soft: a storage hiccup omits the section.
 * `staffPreview` is true ONLY for a request the route verified as staff (a valid staff token, not just ?adminPreview=1).
 * Then, and only when the customer block below is absent, the answer carries what the next send would freeze, marked
 * `preview: true`, so staff can check the points before the first send. Any other caller gets exactly the customer block.
 */
async function roofPointsDocBlock(estimate, { knex = db, staffPreview = false } = {}) {
  if (!estimate?.id) return {};
  try {
    const frozen = await frozenCopyBlock(estimate, knex);
    if (frozen || staffPreview !== true) return frozen ? { roofPoints: frozen } : {};
    const { points } = await nextSendPoints(estimate, knex);
    // The customer page hides the points while ANY read of the estimate is hidden (readsAllowCopy), so the preview does
    // too: it must show only what the customer would see after that send.
    const snapshot = points && !(await anyReadHidden(estimate, knex)) ? cleanSnapshot(points) : null;
    return snapshot ? { roofPoints: { ...snapshot, preview: true } } : {};
  } catch (err) {
    logger.warn(`[estimate-roof-points] section skipped for estimate ${estimate.id}: ${errCode(err)}`);
    return {};
  }
}

// What the customer's page shows of this copy row: its snapshot when every rule lets it show, else null.
async function shownSnapshot(row, estimate, knex) {
  if (!row || !copyIsCurrent(row, estimate) || !copyForHolder(row, estimate)) return null;
  if (!sameHome(row.address, estimate.address)) return null;
  const snapshot = cleanSnapshot(row.snapshot);
  if (!snapshot) return null;
  if (!(await readsAllowCopy(estimate, row, knex))) return null;
  return snapshot;
}

// The customer's block: the estimate's frozen copy as the page shows it, else null.
async function frozenCopyBlock(estimate, knex) {
  return shownSnapshot(await knex(TABLE).where({ estimate_id: estimate.id }).first(), estimate, knex);
}

// Is the estimate's copy a lead's copy that this row's customer, the first since that send, keeps (keptForFirstCustomer)?
async function holdsLeadCopy(estimate, knex) {
  const copy = await knex(TABLE).where({ estimate_id: estimate.id }).first('customer_id', 'lead_changes');
  return Boolean(copy) && keptForFirstCustomer(copy, estimate);
}

/**
 * The send to a first customer whose estimate carries the lead's copy: keep that copy, or freeze the customer's own
 * points, or clear. It is decided under a lock on the estimate row. A points save holds that row FOR UPDATE
 * (roof-entry-read.js saveUnderEstimate) while it names the customer on the lead's read. Without the lock, such a save
 * landing between the two lookups here would hide the read from both (it is no longer the lead's, and was not yet the
 * customer's), and the send would clear points it must keep or freeze. The wait is 5 seconds; past that the caller
 * reports 'skipped' and the page omits the older copy until the next send.
 *
 * Other sends take no lock, so one may replace the copy while this one decides. Like every write of a send, the keep
 * and the clear name only a copy that no later handoff wrote (copyNotNewer). A keep that finds its copy replaced
 * reports 'skipped' and leaves that copy alone.
 */
async function keepOrFreeze(estimate, at, knex) {
  return knex.transaction(async (trx) => {
    await trx.raw("SET LOCAL lock_timeout = '5s'");
    await trx('estimates').where({ id: estimate.id }).forShare().first('id');
    const next = await nextSendPoints(estimate, trx);
    if (next.points) return writeCopy(estimate, next, at, trx);
    const copy = next.row ? null : await leadCopyToKeep(estimate, trx);
    if (!copy) {
      await copyNotNewer(trx, estimate, at).del();
      return 'cleared';
    }
    // Only the handoff time is written: the snapshot stays the one the lead received, also when the read was edited since.
    const kept = await copyNotNewer(trx, estimate, at).where({ read_id: copy.read_id, lead_changes: copy.lead_changes }).whereNull('customer_id').update({ delivered_at: at });
    return kept === 1 ? 'kept' : 'skipped';
  });
}

/**
 * The lead's copy a send to the first customer keeps, or null. That customer has no points read of their own yet (staff
 * did not press Save points since the lead became this customer). The copy stays, under this handoff's time so that it
 * is still the estimate's latest (copyIsCurrent), when all of this holds:
 *  - the customer's page shows that copy now (shownSnapshot: the first customer, the latest handoff before this one,
 *    the same home, not hidden, its read still the lead's or this customer's);
 *  - and the lead's read it came from would still be sent to a lead: it is the newest points read with no customer and
 *    its points are not cleared. A clear ends the copy at the next send, as it always did.
 */
async function leadCopyToKeep(estimate, knex) {
  const copy = await knex(TABLE).where({ estimate_id: estimate.id }).first();
  if (!copy || !keptForFirstCustomer(copy, estimate) || !(await shownSnapshot(copy, estimate, knex))) return null;
  const lead = await nextSendPoints({ ...estimate, customer_id: null }, knex);
  return lead.points && lead.row.id === copy.read_id ? copy : null;
}

module.exports = {
  freezeRoofPointsForEstimate,
  roofPointsDocBlock,
  newestPointsRead,
};
