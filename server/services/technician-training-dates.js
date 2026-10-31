'use strict';

// Deadline math for a technician's ID card and training (GATE_TECH_TRAINING_DATES, dark). Pure: no I/O, no clock.
// Every date is a calendar date ('YYYY-MM-DD', Eastern); `today` is passed in (etDateString()), and the math runs on the
// date text at noon UTC, never `new Date(dateOnlyString)` day arithmetic.
//
// Where the dates come from (verified 2026-10-28):
//  - F.S. 482.091(1)(b): the licensee or certified operator in charge applies for an employee's ID card within 30 days
//    after employment (form FDACS-13606).
//  - F.S. 482.091(3) and rule 5E-14.1421: at least 5 days (40 hours) of field training under a certified operator before
//    pest control work; keep the written record 2 years.
//  - F.S. 482.091(10): 4 classroom hours within 6 months after the card is ISSUED; at least 2 hours of continuing
//    training before each yearly renewal.
//  - F.S. 482.091(4): the card expires on the licensee's next anniversary date; technicians.license_expiry holds it.
const { addMonthsSameDay, dateOnlyString } = require('../utils/date-only');

const ID_CARD_APPLY_DAYS = 30;
const CLASSROOM_MONTHS = 6;
const RENEWAL_CYCLE_MONTHS = 12;
const DUE_SOON_DAYS = 14;
const REQUIRED_TRAINING_DAYS = 5;
const REQUIRED_TRAINING_HOURS = 40;
const TRAINING_CATEGORIES = Object.freeze(['GHP', 'L&O', 'Termite/WDO', 'Fumigation']);

const DAY_MS = 86400000;
const noonUtc = (day) => Date.parse(`${day}T12:00:00Z`);

function addDays(day, days) {
  const ymd = dateOnlyString(day);
  if (!ymd) return null;
  return new Date(noonUtc(ymd) + days * DAY_MS).toISOString().slice(0, 10);
}

// Whole calendar days from `from` to `to` (negative when `to` is earlier). Null when either is unreadable.
function daysBetween(from, to) {
  const a = dateOnlyString(from);
  const b = dateOnlyString(to);
  if (!a || !b) return null;
  return Math.round((noonUtc(b) - noonUtc(a)) / DAY_MS);
}

// done | overdue | due_soon (14 days or fewer left, including the due day) | due. Null with no date to judge.
function statusOf({ dueOn, doneOn, today }) {
  if (doneOn) return 'done';
  if (!dueOn) return null;
  const left = daysBetween(today, dueOn);
  if (left === null) return null;
  if (left < 0) return 'overdue';
  return left <= DUE_SOON_DAYS ? 'due_soon' : 'due';
}

const same = (value) => dateOnlyString(value) || null;

// The ID card is due 30 days after the hire date. A card that is issued has been applied for.
function idCardDeadline({ hireDate, appliedOn, issuedOn, today }) {
  const applied = same(appliedOn);
  const issued = same(issuedOn);
  const applicationDueOn = addDays(hireDate, ID_CARD_APPLY_DAYS);
  return {
    appliedOn: applied,
    applicationDueOn,
    issuedOn: issued,
    status: statusOf({ dueOn: applicationDueOn, doneOn: applied || issued, today }),
  };
}

// Four classroom hours are due 6 months after the issue date printed on the card (month-end clamped).
function classroomDeadline({ issuedOn, doneOn, today }) {
  const done = same(doneOn);
  const dueOn = addMonthsSameDay(issuedOn, CLASSROOM_MONTHS);
  return { dueOn, doneOn: done, status: statusOf({ dueOn, doneOn: done, today }) };
}

// Two continuing-training hours are due before the yearly renewal. A date counts for the current cycle only: one on or
// before the previous renewal belongs to an earlier year, so moving license_expiry forward re-opens it by itself.
function renewalTrainingDeadline({ licenseExpiry, doneOn, today }) {
  const dueBy = same(licenseExpiry);
  const done = same(doneOn);
  const cycleStart = dueBy ? addMonthsSameDay(dueBy, -RENEWAL_CYCLE_MONTHS) : null;
  const doneThisCycle = done && (!cycleStart || done > cycleStart) ? done : null;
  return { dueBy, doneOn: done, status: statusOf({ dueOn: dueBy, doneOn: doneThisCycle, today }) };
}

// Days, hours, categories and the two readiness checks from the dated training rows.
function trainingSummary(rows) {
  const dates = new Set();
  const byCategory = new Map();
  let hours = 0;
  for (const row of rows || []) {
    const day = dateOnlyString(row.training_date);
    if (!day) continue;
    dates.add(day);
    hours += Number(row.hours) || 0;
    if (!byCategory.has(row.category)) byCategory.set(row.category, new Set());
    byCategory.get(row.category).add(day);
  }
  const totalHours = Math.round(hours * 100) / 100;
  return {
    days: dates.size,
    hours: totalHours,
    categories: [...byCategory.keys()].sort(),
    fiveDaysDone: [...byCategory.values()].some((set) => set.size >= REQUIRED_TRAINING_DAYS),
    fortyHoursDone: totalHours >= REQUIRED_TRAINING_HOURS,
  };
}

// The block GET /licenses adds for one technician with a hire date.
function technicianTrainingBlock(tech, trainingRows, today) {
  return {
    training: trainingSummary(trainingRows),
    idCard: idCardDeadline({ hireDate: tech.hire_date, appliedOn: tech.id_card_applied_on, issuedOn: tech.id_card_issued_on, today }),
    classroom: classroomDeadline({ issuedOn: tech.id_card_issued_on, doneOn: tech.classroom_hours_done_on, today }),
    renewalTraining: renewalTrainingDeadline({ licenseExpiry: tech.license_expiry, doneOn: tech.renewal_training_done_on, today }),
  };
}

module.exports = {
  ID_CARD_APPLY_DAYS,
  CLASSROOM_MONTHS,
  DUE_SOON_DAYS,
  REQUIRED_TRAINING_DAYS,
  REQUIRED_TRAINING_HOURS,
  TRAINING_CATEGORIES,
  addDays,
  daysBetween,
  statusOf,
  idCardDeadline,
  classroomDeadline,
  renewalTrainingDeadline,
  trainingSummary,
  technicianTrainingBlock,
};
