'use strict';

/**
 * Tech-confirmed roof points on the customer estimate (owner ruling 2026-11-20, choice 4A, no new spend).
 *
 * The customer estimate shows ONLY the roof points the technician confirmed, on the county roof photo, in the Waves AI
 * card in place of the satellite photo. Two halves:
 *   - freezeRoofPointsForEstimate: at every send with a real provider handoff (and for each group sibling once that send
 *     published it), copy what customerPointsFromRow gives for the newest finished read that has confirmed points into
 *     estimate_roof_points (a re-send replaces it; no points now deletes it). The points must have been saved for the
 *     address the estimate has now (points_address: the address the staff lookup ran for, sent by the panel with the
 *     points and the photo centre), or nothing is copied. The copy names the handoff that wrote it (delivered_at).
 *     Between sends the copy never changes, so a re-read, an edit or a label change cannot alter an estimate the
 *     customer already holds. Fail-soft by contract: it never throws, so it can never block or fail a send.
 *   - roofPointsDocBlock: the /data key `{ roofPoints: { imageUrl, imageYear, pins } }`, or `{}` so a response with no
 *     snapshot stays byte-identical. Staff hiding is immediate (checked against the estimate's read rows NOW); the
 *     content is the frozen copy. An estimate moved to another address since the send prints nothing, and so does a copy older than
 *     the estimate's latest handoff (a later send could not replace or delete it).
 */

const db = require('../models/db');
const logger = require('./logger');
const { customerPointsFromRow } = require('./roof-entry-read');
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

/**
 * The newest finished read for the estimate on which the technician saved points (hidden or not), or undefined. A saved
 * empty list counts: the technician confirmed none, so an older read's points must not come back.
 */
function newestPointsRead(estimateId, knex) {
  return knex(READS)
    .where({ estimate_id: estimateId, status: 'done' })
    .whereRaw("tech_pins IS NOT NULL AND jsonb_typeof(tech_pins) = 'array'")
    .orderBy(NEWEST)
    .first();
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

const timeMs = (v) => (v ? new Date(v).getTime() : NaN);

/**
 * Freeze (or clear) one estimate's roof points for the send handed off at `deliveredAt` (the lastDeliveredAt that send
 * stamps on the estimate). `estimate` needs { id, address }. Returns 'frozen', 'cleared' or 'skipped' (never throws; a
 * storage error is logged and reported as 'skipped', and the page then omits the older copy: see copyIsCurrent).
 */
async function freezeRoofPointsForEstimate(estimate, { deliveredAt, knex = db } = {}) {
  if (!estimate?.id || !Number.isFinite(timeMs(deliveredAt))) return 'skipped';
  try {
    const row = await newestPointsRead(estimate.id, knex);
    // The points were saved for the address the staff lookup ran for (the same lookup gave the photo centre). An
    // estimate that has another address now is another roof: it gets no points until staff read and confirm that one.
    const points = sameHome(row?.points_address, estimate.address) ? customerPointsFromRow(row) : null;
    if (!points) {
      await knex(TABLE).where({ estimate_id: estimate.id }).del();
      return 'cleared';
    }
    const record = {
      estimate_id: estimate.id,
      read_id: row.id,
      address: String(estimate.address),
      snapshot: JSON.stringify(points),
      delivered_at: new Date(deliveredAt).toISOString(),
      frozen_at: knex.fn.now(),
    };
    await knex(TABLE).insert(record).onConflict('estimate_id').merge();
    return 'frozen';
  } catch (err) {
    logger.warn(`[estimate-roof-points] freeze skipped for estimate ${estimate.id}: ${errCode(err)}`);
    return 'skipped';
  }
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

/**
 * True when staff hid the estimate's roof points NOW. Hide or show is one choice for the estimate: saveTechCount writes
 * it to every read of the estimate and a new read starts with it. So the answer is "any read of this estimate is
 * hidden" (plus the read the copy came from, by id): no later read, with or without points, brings hidden points back.
 */
async function hiddenNow(estimateId, readId, knex) {
  const [frozen, anyHidden] = await Promise.all([
    readId ? knex(READS).where({ id: readId }).first('hide_on_estimate') : null,
    knex(READS).where({ estimate_id: estimateId, hide_on_estimate: true }).first('id'),
  ]);
  return Boolean(frozen?.hide_on_estimate || anyHidden);
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
      label: String(p.label || ''),
      action: String(p.action || ''),
    })),
  };
}

/** The /data key for the customer estimate: `{ roofPoints }`, or `{}`. Fail-soft: a storage hiccup omits the section. */
async function roofPointsDocBlock(estimate, { knex = db } = {}) {
  if (!estimate?.id) return {};
  try {
    const row = await knex(TABLE).where({ estimate_id: estimate.id }).first();
    if (!row || !copyIsCurrent(row, estimate)) return {};
    if (!sameHome(row.address, estimate.address)) return {};
    const snapshot = cleanSnapshot(row.snapshot);
    if (!snapshot) return {};
    if (await hiddenNow(estimate.id, row.read_id, knex)) return {};
    return { roofPoints: snapshot };
  } catch (err) {
    logger.warn(`[estimate-roof-points] section skipped for estimate ${estimate.id}: ${errCode(err)}`);
    return {};
  }
}

module.exports = {
  freezeRoofPointsForEstimate,
  roofPointsDocBlock,
  newestPointsRead,
};
