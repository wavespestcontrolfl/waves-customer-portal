'use strict';

/**
 * GATE_REPORT_WEB_PROGRAM (owner 2026-10-20 "OK BUILD THEM ALL", idea 9): the live web service report of a
 * recurring lawn plan visit says which month of the program the lawn is in and whether coverage, color and
 * weeds are on track, ahead or behind a per-month target. Fixed sentences only (shared/lawn-program-targets.json);
 * no model prose. Pure: no I/O, no clock, no gate (the route reads the gate).
 *
 * The month is counted from the property's first lawn assessment (the report's own history). The targets are
 * PROPOSED values the owner approves (see the file's _note); a category with no score is left out, and when no
 * category can be judged there is no card. Color is never called "behind" in the cool-season months: the
 * grass loses color for the season, not for the program (lawn-progress.js treats it the same way).
 */

const TARGETS = require('../../../shared/lawn-program-targets.json');

const STATES = Object.freeze(['on_track', 'ahead', 'behind']);

function ymdParts(value) {
  const s = value instanceof Date ? value.toISOString() : String(value || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

/** Whole months from the first assessment to the visit, plus one (program month 1 is the first month). Null when a date is missing or out of order. */
function programMonth(firstDate, visitDate) {
  const a = ymdParts(firstDate);
  const b = ymdParts(visitDate);
  if (!a || !b) return null;
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  return months < 0 ? null : months + 1;
}

/** on_track | ahead | behind for one score against one target (the band is the file's). */
function judge(score, target, band = TARGETS.band) {
  if (score >= target + band) return 'ahead';
  if (score < target - band) return 'behind';
  return 'on_track';
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));

/**
 * @param {{ scores?: object, firstDate?: string|Date, visitDate?: string|Date }} input
 * @returns {{ monthLine: string, month: number, items: Array<{key: string, label: string, state: string, sentence: string}> }|null}
 */
function buildProgramPromise({ scores, firstDate, visitDate } = {}) {
  const month = programMonth(firstDate, visitDate);
  if (!month || !scores || typeof scores !== 'object') return null;
  const row = Math.min(month, 12) - 1;
  const visitMonth = ymdParts(visitDate).m;
  const cool = TARGETS.coolSeasonMonths.includes(visitMonth);
  const items = [];
  for (const [key, def] of Object.entries(TARGETS.categories)) {
    const raw = scores[def.scoreKey];
    if (raw == null || raw === '' || !Number.isFinite(Number(raw))) continue;
    const state = judge(Number(raw), def.byMonth[row]);
    if (key === 'color' && cool && state === 'behind') continue;
    items.push({ key, label: def.label, state, sentence: fill(TARGETS.sentences[state], def) });
  }
  if (!items.length) return null;
  const monthLine = month <= 12
    ? fill(TARGETS.sentences.month, { n: month })
    : fill(TARGETS.sentences.year, { y: Math.floor((month - 1) / 12) + 1 });
  return { monthLine, month, items };
}

module.exports = { buildProgramPromise, programMonth, judge, STATES, TARGETS };
