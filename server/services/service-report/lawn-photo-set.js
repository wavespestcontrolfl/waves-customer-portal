'use strict';

/**
 * The lawn report's photo SET (lawn report rebuild P23, GATE_LAWN_REPORT_PHOTO_SET).
 *
 * A visit captured under the photo shot list carries one photo per named shot
 * (front, back, close-up, ...). The report used to show them as a swipe-one-
 * at-a-time strip ordered by quality. The set is the same photos in SHOT order,
 * each with its fixed customer label from shared/lawn-photo-shots.json
 * (`reportLabel`, never model text). Pure: no I/O, no gate read. The caller
 * (report-data.js buildLawnAssessmentReportData) decides whether the gate and
 * the visit's shot-list marker allow a set, and passes in rows whose URLs it
 * has already signed. Nothing here stores a URL.
 */
const shotList = require('../lawn-photo-shots');

// The label for a photo the technician did not tag with a shot.
const UNTAGGED_LABEL = 'Lawn photo';

const SHOT_ORDER = new Map(shotList.SHOT_KEYS.map((key, index) => [key, index]));

/**
 * @param {Array<{url: string|null, zone: string|null, photoOrder: number|null}>} rows
 *   the visit's customer-visible photos, URLs already signed
 * @returns {Array<{url: string, shot: string|null, label: string}>}
 *   shot order, then the technician's own order inside a shot; a photo with no
 *   resolved URL is left out (never a broken image). Empty when nothing shows.
 */
function buildLawnPhotoSet(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row, index) => ({ row, index, shot: shotList.normalizeShotZone(row?.zone) }))
    .filter(({ row }) => row && typeof row.url === 'string' && row.url)
    .sort((a, b) => {
      const rankA = a.shot ? SHOT_ORDER.get(a.shot) : SHOT_ORDER.size;
      const rankB = b.shot ? SHOT_ORDER.get(b.shot) : SHOT_ORDER.size;
      if (rankA !== rankB) return rankA - rankB;
      const orderA = Number.isFinite(Number(a.row.photoOrder)) ? Number(a.row.photoOrder) : Infinity;
      const orderB = Number.isFinite(Number(b.row.photoOrder)) ? Number(b.row.photoOrder) : Infinity;
      return orderA - orderB || a.index - b.index;
    })
    .map(({ row, shot }) => ({
      url: row.url,
      shot,
      // GATE_LAWN_PHOTO_LABEL_PICK: the caller adds pickedLabel (already customer wording) only for a live gate and a real pick.
      label: row.pickedLabel || (shot && shotList.SHOT_REPORT_LABELS[shot]) || UNTAGGED_LABEL,
    }));
}

module.exports = { buildLawnPhotoSet, UNTAGGED_LABEL };
