'use strict';

/**
 * GATE_LAWN_REPORT_LAYOUT (owner 2026-10-08/09): the lawn web report is reordered for a phone and
 * trimmed (client/src/components/report/lawnV2/LawnLayout.jsx). The page does the ordering from data
 * the report already carries; the one thing it needs from the server is this payload key:
 *
 *   lawnLayout: { mowingRange: { minInches, maxInches, grassLabel } | null }
 *
 * mowingRange comes ONLY from the per-grass height-of-cut table the Mowing Height chart already
 * uses (turf-height.js HEIGHT_BAND_BY_GRASS). A grass the table does not list (mixed, unknown,
 * centipede) gets null, never the table's St. Augustine default, so the page prints no mowing line.
 *
 * Gate off, or not a lawn report: an empty object, so the payload is byte-identical to before.
 * Pure. No database read, no model call.
 */

const featureGates = require('../../config/feature-gates');
const { HEIGHT_BAND_BY_GRASS, normalizeGrassKey } = require('./turf-height');

// A partial feature-gates mock (a test) means off, never a crash in a report build.
function layoutLive() {
  return typeof featureGates.lawnReportLayoutLive === 'function' && featureGates.lawnReportLayoutLive();
}

// The grass names the report already prints for the lawn (lawn-report-v2.js GRASS_LABEL), without
// the word "lawn": the sentence supplies it.
const GRASS_NAME = Object.freeze({
  st_augustine: 'St. Augustine',
  bahia: 'Bahia',
  bermuda: 'Bermuda',
  zoysia: 'Zoysia',
});

/** The height-of-cut range for a grass the table lists, else null. */
function mowingRangeFor(grassType) {
  const key = normalizeGrassKey(grassType);
  if (!Object.hasOwn(HEIGHT_BAND_BY_GRASS, key) || !Object.hasOwn(GRASS_NAME, key)) return null;
  const band = HEIGHT_BAND_BY_GRASS[key];
  return { minInches: band.min, maxInches: band.max, grassLabel: GRASS_NAME[key] };
}

/**
 * The payload keys the layout adds. Spread into the report payload.
 * @param {{serviceLine?: string, reportV2?: object|null, lawnAssessment?: object|null, mowingHeight?: object|null}} args
 */
function lawnLayoutPayload({ serviceLine, reportV2, lawnAssessment, mowingHeight } = {}) {
  if (serviceLine !== 'lawn' || !reportV2 || !layoutLive()) return {};
  const grass = (mowingHeight && mowingHeight.grassType) || (lawnAssessment && lawnAssessment.turfProfile && lawnAssessment.turfProfile.grassType) || null;
  return { lawnLayout: { mowingRange: mowingRangeFor(grass) } };
}

module.exports = { lawnLayoutPayload, mowingRangeFor, layoutLive, GRASS_NAME };
