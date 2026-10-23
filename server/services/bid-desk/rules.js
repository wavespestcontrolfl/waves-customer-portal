'use strict';

/**
 * Bid Desk rules (GATE_BID_DESK). PURE: no database, no clock of its own, NO LLM.
 *
 *   attachPatch(bid, parsed, kind)  what a later email changes on an existing bid
 *   reminderDue(bid, now)           which due-date reminder (if any) is owed right now
 *   datesDue(bid, now)              the questions and job-walk reminders owed right now (GATE_BID_CHECKLIST)
 *   daysLeft(dueAt, now)            whole ET calendar days until the due date
 *
 * The date rule: an email never overwrites a due date. A date the operator confirmed is final; a date that was read
 * from an earlier email stays as it was and the bid is flagged `needs_date_confirmation` so a person looks.
 * A later email may fill a due date that was never read, and that date is still unconfirmed.
 */
const { etDateString } = require('../../utils/datetime-et');

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = ['new', 'bid'];

const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

// Columns an attached email may fill, only where the bid has nothing yet.
const FILL_FIELDS = ['gc_or_agency', 'project_title', 'package_name', 'location', 'buyer_name', 'buyer_email', 'job_walk_at'];

/**
 * @returns {{ patch: object, notifyAddendum: boolean }} `patch` holds only columns that change.
 */
function attachPatch(bid, parsed, kind) {
  const patch = {};
  for (const field of FILL_FIELDS) {
    if (bid[field] == null && parsed[field] != null) patch[field] = parsed[field];
  }
  let needsConfirmation = kind === 'addendum';
  if (parsed.due_at) {
    if (bid.due_at == null) {
      // Fills a due date that was never read; it stays unconfirmed (due_confirmed is untouched, false for a null date)
      // and is flagged, so the office hears about a date that appeared after the first email (an unconfirmed date
      // never reminds).
      patch.due_at = parsed.due_at;
      patch.due_source_line = parsed.due_source_line;
      needsConfirmation = true;
    } else if (!sameInstant(bid.due_at, parsed.due_at)) {
      needsConfirmation = true;
    }
  }
  if (needsConfirmation && !bid.needs_date_confirmation) patch.needs_date_confirmation = true;
  const open = OPEN_STATUSES.includes(bid.status) && !bid.historical;
  // Ring for every addendum, and for any email that newly flags the date (a provider "Reminder" carrying a
  // different Bid Due line flags it too, and a flag pauses the reminders, so the office must hear about it).
  return { patch, notifyAddendum: open && (kind === 'addendum' || patch.needs_date_confirmation === true) };
}

/**
 * '7d' | '2d' | null (and '14d' when `checklist` is on: GATE_BID_CHECKLIST). A reminder needs a due date the operator
 * confirmed, an open status, a bid that is not historical, and (a SAM.gov bid) a notice still open on SAM.gov. Each
 * fires once: a bid already inside 2 days that never had the 7-day reminder gets the 2-day one only, and the 14-day
 * reminder is only for a date still more than 7 days away.
 */
function reminderDue(bid, now = new Date(), { checklist = false } = {}) {
  if (!bid || bid.historical || bid.due_confirmed !== true || !bid.due_at || bid.needs_date_confirmation) return null;
  // A notice SAM.gov lists as closed (archived, awarded, gone) never reminds, even after the date is confirmed.
  if (bid.source_active === false) return null;
  if (!OPEN_STATUSES.includes(bid.status)) return null;
  const left = new Date(bid.due_at).getTime() - new Date(now).getTime();
  if (!(left > 0)) return null;
  if (left <= 2 * DAY_MS) return bid.reminder_2d_sent_at ? null : '2d';
  if (left <= 7 * DAY_MS) return bid.reminder_7d_sent_at ? null : '7d';
  if (checklist && left <= 14 * DAY_MS) return bid.reminder_14d_sent_at ? null : '14d';
  return null;
}

/**
 * The date reminders of GATE_BID_CHECKLIST: ['questions'] and / or ['job_walk'], each owed once, 2 days before its date.
 * The caller checks the gate. The same eligibility as the due-date reminders: an open bid that is not historical, a
 * notice still open on SAM.gov, and no date waiting on an addendum check (an addendum may move these dates too). A
 * questions date is never read from mail, so a value there was typed by the operator and counts as confirmed. A
 * job-walk date can be read from an invite, so it reminds only once `job_walk_confirmed` is true (the operator typed it
 * or confirmed it as read). Changing a date clears its sent stamp (the route), so each fires once for the date it was
 * computed for.
 */
function datesDue(bid, now = new Date()) {
  if (!bid || bid.historical || bid.needs_date_confirmation || bid.source_active === false) return [];
  if (!OPEN_STATUSES.includes(bid.status)) return [];
  const within = (value) => {
    if (!value) return false;
    const left = new Date(value).getTime() - new Date(now).getTime();
    return left > 0 && left <= 2 * DAY_MS;
  };
  const due = [];
  if (within(bid.questions_due_at) && !bid.questions_reminder_sent_at) due.push('questions');
  if (bid.job_walk_confirmed === true && within(bid.job_walk_at) && !bid.job_walk_reminder_sent_at) due.push('job_walk');
  return due;
}

// ET calendar days from today to the due date (0 = due today, negative = past). null without a date.
function daysLeft(dueAt, now = new Date()) {
  if (!dueAt) return null;
  const toUtcDay = (value) => {
    const [y, m, d] = etDateString(new Date(value)).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtcDay(dueAt) - toUtcDay(now)) / DAY_MS);
}

module.exports = { attachPatch, reminderDue, datesDue, daysLeft, OPEN_STATUSES, FILL_FIELDS };
