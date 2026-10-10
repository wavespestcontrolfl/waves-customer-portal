'use strict';

/**
 * What the office sees beside the new-sod fields in Customer 360 (Access &
 * Preferences). Read-only, computed here so the client never restates a rule:
 * holdLines, the plain hold lines for a recorded sod, from sodHolds(), and the
 * record they were built from.
 *
 * Nothing here writes, texts or emails.
 */

const { sodHolds } = require('./lawn-sod-holds');
const { etCalendarDayOf, validCalendarDate } = require('../utils/datetime-et');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ymdOrNull(value) {
  if (value == null || value === '') return null;
  try {
    return validCalendarDate(etCalendarDayOf(value)) || null;
  } catch {
    return null;
  }
}

// 'YYYY-MM-DD' as 'Oct 1, 2027'.
function formatDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// The three plain lines for a recorded sod. Dates are the fixed hold end days
// (read as of the sod date); "hold is over" is added once today is past them.
// A part-of-lawn record holds no fertilizer line, but through day 30 the sheet keeps fertilizer off the new sod
// (lawn-sod-holds.js `fertilizerKeepOff`): the office line says so, active until that date, then the plain line.
function partFertilizerLine(atStart, now) {
  const keepOff = atStart.fertilizerKeepOff;
  if (keepOff?.on && now.fertilizerKeepOff?.on) {
    return {
      key: 'fertilizer',
      active: true,
      text: `Fertilizer stays off the new sod until ${formatDay(keepOff.until)}. The rest of the lawn is fertilized as planned.`,
    };
  }
  return { key: 'fertilizer', active: false, text: 'Fertilizer is not held. The new sod covers only part of the lawn.' };
}

function holdLinesFor(prefsRow, todayEt) {
  const laid = ymdOrNull(prefsRow?.sod_laid_on);
  if (!laid) return [];
  const base = {
    sodLaidOn: laid,
    sodCovers: prefsRow.sod_covers,
    sodArea: prefsRow.sod_area,
    sodRootedOn: prefsRow.sod_rooted_on,
  };
  // The first sod day gives each hold's end date; today gives where it stands.
  const atStart = sodHolds({ ...base, visitDate: laid });
  const today = ymdOrNull(todayEt);
  const now = today && today >= laid ? sodHolds({ ...base, visitDate: today }) : atStart;
  if (!atStart || !now) return [];

  const overNote = (stillHeld) => (stillHeld ? '' : ' (this hold is over)');
  const lines = [];

  lines.push(atStart.fertilizer.held
    ? {
      key: 'fertilizer',
      active: now.fertilizer.held,
      text: `Fertilizer is held until ${formatDay(atStart.fertilizer.until)}${overNote(now.fertilizer.held)}.`,
    }
    : partFertilizerLine(atStart, now));

  const rootedNote = now.weedKiller.held ? '' : ' (this hold is over)';
  const areaNote = atStart.covers === 'part' ? ' The hold covers the named area only.' : '';
  lines.push({
    key: 'weedKiller',
    active: now.weedKiller.held,
    text: `Weed killer is held until ${formatDay(atStart.weedKiller.until)} and until the technician confirms the sod is rooted${rootedNote}.${areaNote}`,
  });

  lines.push({
    key: 'preEmergent',
    active: now.preEmergent.held,
    text: `Pre-emergent is held until ${formatDay(atStart.preEmergent.until)}${overNote(now.preEmergent.held)}.${areaNote}`,
  });
  return lines;
}

/**
 * The whole read-only object the form needs.
 * @param {object} args
 * @param {object|null} args.prefsRow  property_preferences row (or null)
 * @param {string} args.todayEt  today as 'YYYY-MM-DD' (America/New_York)
 */
function buildNewSodSummary({ prefsRow, todayEt }) {
  return {
    holdLines: holdLinesFor(prefsRow, todayEt),
    // The record the lines were built from, as stored. The form shows the lines
    // only beside the same record (another person may have changed it between
    // the two reads).
    record: {
      sod_laid_on: prefsRow?.sod_laid_on ?? null,
      sod_covers: prefsRow?.sod_covers ?? null,
      sod_area: prefsRow?.sod_area ?? null,
    },
  };
}

module.exports = {
  formatDay,
  holdLinesFor,
  buildNewSodSummary,
};
