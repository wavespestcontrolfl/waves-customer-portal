'use strict';

/**
 * Tech-confirmed roof points on the customer estimate (owner ruling 2026-11-20, choice 4A, no new spend).
 *
 * The customer estimate shows ONLY the roof points the technician confirmed, on the county roof photo, in the Waves AI
 * card in place of the satellite photo. Two halves:
 *   - freezeRoofPointsForEstimate: at every send, copy what customerPointsFromRow gives for the newest finished read that
 *     has confirmed points into estimate_roof_points (a re-send replaces it; no points now deletes it). Between sends the
 *     copy never changes, so a re-read, an edit or a label change cannot alter an estimate the customer already holds.
 *     Fail-soft by contract: it never throws, so it can never block or fail a send.
 *   - roofPointsDocBlock: the /data key `{ roofPoints: { imageUrl, imageYear, pins } }`, or `{}` so a response with no
 *     snapshot stays byte-identical. Staff hiding is immediate (checked against the read rows NOW); the content is the
 *     frozen copy. An estimate moved to another address since the send prints nothing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { customerPointsFromRow } = require('./roof-entry-read');
const { sameProperty } = require('./misting-layout-validate');

const TABLE = 'estimate_roof_points';
const READS = 'roof_entry_reads';

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
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .first();
}

/**
 * Freeze (or clear) one estimate's roof points. `estimate` needs { id, address }. Returns 'frozen', 'cleared' or 'skipped'
 * (never throws; a storage error is logged and reported as 'skipped').
 */
async function freezeRoofPointsForEstimate(estimate, { knex = db } = {}) {
  if (!estimate?.id) return 'skipped';
  try {
    const row = await newestPointsRead(estimate.id, knex);
    const points = row ? customerPointsFromRow(row) : null;
    if (!points) {
      await knex(TABLE).where({ estimate_id: estimate.id }).del();
      return 'cleared';
    }
    const record = {
      estimate_id: estimate.id,
      read_id: row.id,
      address: estimate.address ? String(estimate.address) : null,
      snapshot: JSON.stringify(points),
      frozen_at: knex.fn.now(),
    };
    await knex(TABLE).insert(record).onConflict('estimate_id').merge();
    return 'frozen';
  } catch (err) {
    logger.warn(`[estimate-roof-points] freeze skipped for estimate ${estimate.id}: ${err.message}`);
    return 'skipped';
  }
}

/** Freeze every row in turn (the sent estimate plus any group sibling the same send published). Never throws. */
async function freezeRoofPointsForSend(estimates, opts) {
  for (const e of estimates || []) {
     
    await freezeRoofPointsForEstimate(e, opts);
  }
}

/** True when staff hid the points: the frozen read, or the estimate's newest finished read, has hide_on_estimate set. */
async function hiddenNow(estimateId, readId, knex) {
  if (readId) {
    const frozen = await knex(READS).where({ id: readId }).first('hide_on_estimate');
    if (frozen?.hide_on_estimate) return true;
  }
  const newest = await newestPointsRead(estimateId, knex);
  return Boolean(newest?.hide_on_estimate);
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
    if (!row) return {};
    if (!sameProperty(row.address, estimate.address)) return {};
    const snapshot = cleanSnapshot(row.snapshot);
    if (!snapshot) return {};
    if (await hiddenNow(estimate.id, row.read_id, knex)) return {};
    return { roofPoints: snapshot };
  } catch (err) {
    logger.warn(`[estimate-roof-points] section skipped for estimate ${estimate.id}: ${err.message}`);
    return {};
  }
}

module.exports = {
  freezeRoofPointsForEstimate,
  freezeRoofPointsForSend,
  roofPointsDocBlock,
  newestPointsRead,
};
