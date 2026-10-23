'use strict';

/**
 * Bid Desk admin notifications (GATE_BID_DESK). The specs are pure; raise() sends them through raiseAdminAlert
 * (docs/admin-notifications.md). Nothing here writes to a buyer, a contractor or a customer: the audience is the
 * admin bell only.
 */
const { raiseAdminAlert, composeAdminAlert, cutAtWord, breaksAlertRules, MAX_WHY_CHARS } = require('../admin-alert-compose');
const { raiseAdminAlertWithReopen } = require('../admin-alert-episodes');
const { fitAction, shortDateET } = require('../admin-alert-names');
const { daysLeft } = require('./rules');

const AREA = 'Estimates';
const CATEGORY = 'lead';
const STATUS_LABEL = { new: 'no decision yet', bid: 'marked as bid' };
const WINDOW_LABEL = { '14d': '14-day', '7d': '7-day', '2d': '2-day' };

const linkFor = (bid) => `/admin/bid-desk?bid=${bid.id}`;
const subjectFor = (bid) => ({ type: 'lead', id: bid.id });

function dueWords(bid) {
  if (!bid.due_at) return 'due date not read';
  return `due ${shortDateET(bid.due_at)}${bid.due_confirmed ? '' : ' (not confirmed)'}`;
}

function etTimeWords(value) {
  const at = new Date(value);
  const time = at.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return time === '11:59 PM' ? '' : ` at ${time}`;
}

// Words that came from an email (a subject, a project name) go into the headline and the why. The copy rule refuses
// code-shaped tokens (long hex runs, ISO dates, brackets, underscores), so those are cleaned out, and a text that
// still breaks the rule is replaced by the fallback rather than costing the bell.
function plain(text, fallback) {
  const cleaned = String(text || '')
    .replace(/\b[0-9a-f]{12,}\b/gi, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/[[\]!_]/g, ' ')
    .replace(/([.?!])\s+(?=[A-Z])/g, ', ')
    .replace(/\s+/g, ' ').trim();
  return cleaned && !breaksAlertRules(cleaned) ? cleaned : fallback;
}

// What the office calls the bid: the project from the template, else the email's own subject line.
const titleOf = (bid, email) => plain(bid.project_title || email?.subject, 'a bid');
const buyerOf = (bid, email) => plain(bid.gc_or_agency || bid.buyer_name || email?.from_name || email?.from_address, 'a buyer');

function newBidSpec(bid, email) {
  const title = titleOf(bid, email);
  const buyer = buyerOf(bid, email);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, buyer, [(n) => `review the bid invite from ${n}`, (n) => `review bid invite, ${n}`]),
      why: cutAtWord(`${title}, ${dueWords(bid)}.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: linkFor(bid),
      subject: subjectFor(bid),
      doneWhen: 'bid_decided',
      who: 'person',
    },
    detail: `New bid invite: ${title} from ${buyer}, ${dueWords(bid)}`,
  };
}

// A SAM.gov notice that closed (inactive, awarded, or no longer returned) is not a date question: the bid waits on a
// decision, so confirming a date never clears it.
function closedNoticeSpec(bid) {
  const title = titleOf(bid, null);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, title, [(n) => `SAM.gov closed ${n}: decide the bid`, (n) => `SAM.gov closed ${n}`, (n) => `notice closed, ${n}`]),
      why: cutAtWord(`${plain(bid.due_source_line, 'SAM.gov no longer lists this notice as active')}; mark the bid passed or lost, or check the notice.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: linkFor(bid),
      subject: subjectFor(bid),
      doneWhen: 'bid_decided',
      who: 'person',
    },
    detail: `SAM.gov closed ${title}: check the notice on SAM.gov, then decide the bid`,
  };
}

function addendumSpec(bid, email) {
  if (!email && bid.source === 'sam_gov' && bid.source_active === false) return closedNoticeSpec(bid);
  const title = titleOf(bid, email);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, title, [(n) => `addendum on ${n}: confirm the due date`, (n) => `addendum on ${n}`, (n) => `addendum, ${n}`]),
      why: cutAtWord(`${email || bid.source !== 'sam_gov' ? 'A new email may change the date' : 'SAM.gov changed this notice'}, so confirm it; the bid reads ${dueWords(bid)}.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: linkFor(bid),
      subject: subjectFor(bid),
      doneWhen: 'due_date_confirmed',
      who: 'person',
    },
    detail: email || bid.source !== 'sam_gov' ? `Addendum on ${title}: confirm the due date` : `SAM.gov changed ${title}: check the notice and confirm the due date`,
  };
}

// The words for how far off the due date is, from the date itself: a reminder can fire late or for a date
// confirmed inside its window, so the window ('7d' / '2d') is never the day count.
function dueInWords(bid, now) {
  const days = daysLeft(bid.due_at, now);
  if (days == null) return 'bid due';
  if (days <= 0) return 'bid due today';
  if (days === 1) return 'bid due tomorrow';
  return `bid due in ${days} days`;
}

function reminderSpec(bid, window, now = new Date()) {
  const title = titleOf(bid, null);
  const due = dueInWords(bid, now);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, title, [(n) => `${due}: ${n}`, (n) => `${due}, ${n}`]),
      why: cutAtWord(`Due ${shortDateET(bid.due_at)}${etTimeWords(bid.due_at)}; ${STATUS_LABEL[bid.status] || bid.status}.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: linkFor(bid),
      subject: subjectFor(bid),
      doneWhen: 'bid_decided',
      who: 'person',
    },
    detail: `Bid reminder (${WINDOW_LABEL[window] || '7-day'}): ${title} is due ${shortDateET(bid.due_at)}${etTimeWords(bid.due_at)}. Status: ${bid.status}.`,
  };
}

// "in 2 days" / "tomorrow" / "today" for a date, from the date itself (a reminder can fire late).
function inWords(value, now) {
  const days = daysLeft(value, now);
  if (days == null || days <= 0) return 'today';
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

// GATE_BID_CHECKLIST: the last day to send questions to the buyer. The reminder is for the office only.
function questionsReminderSpec(bid, now = new Date()) {
  const title = titleOf(bid, null);
  const when = inWords(bid.questions_due_at, now);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, title, [(n) => `questions due ${when}: ${n}`, (n) => `questions due ${when}, ${n}`]),
      why: cutAtWord(`Questions due ${shortDateET(bid.questions_due_at)}${etTimeWords(bid.questions_due_at)}; ${STATUS_LABEL[bid.status] || bid.status}.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: linkFor(bid),
      subject: subjectFor(bid),
      doneWhen: 'bid_decided',
      who: 'person',
    },
    detail: `Bid reminder (questions): ${title} questions are due ${shortDateET(bid.questions_due_at)}${etTimeWords(bid.questions_due_at)}. Status: ${bid.status}.`,
  };
}

// GATE_BID_CHECKLIST: the job walk (site visit). A mandatory walk is named as such: missing it can disqualify the bid.
function jobWalkReminderSpec(bid, now = new Date()) {
  const title = titleOf(bid, null);
  const when = inWords(bid.job_walk_at, now);
  const kind = bid.job_walk_mandatory ? 'mandatory job walk' : 'job walk';
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, title, [(n) => `${kind} ${when}: ${n}`, (n) => `${kind} ${when}, ${n}`]),
      why: cutAtWord(`${bid.job_walk_mandatory ? 'Mandatory job walk' : 'Job walk'} ${shortDateET(bid.job_walk_at)}${etTimeWords(bid.job_walk_at)}; ${STATUS_LABEL[bid.status] || bid.status}.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: linkFor(bid),
      subject: subjectFor(bid),
      doneWhen: 'bid_decided',
      who: 'person',
    },
    detail: `Bid reminder (${kind}): ${title} ${kind} is ${shortDateET(bid.job_walk_at)}${etTimeWords(bid.job_walk_at)}. Status: ${bid.status}.`,
  };
}

// Rings once per key: the dedupe key is the bid (and email or window), so a retry never rings twice.
async function raise({ spec, detail }, dedupeKey, trx) {
  return raiseAdminAlert(CATEGORY, spec, { bell: true, dedupeKey, detail, metadata: { bidId: spec.subject.id }, trx });
}

// A recurring alert (a reminder for a due date that can come back after a change: A, then B, then A again) goes
// through the shared episode path: an auto-closed earlier episode under the same key rings again, a standing one
// dedupes silently. The copy is composed by the same rules as raise().
async function raiseReopening({ spec, detail }, dedupeKey, trx) {
  const composed = composeAdminAlert(spec);
  return raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
    bell: true, dedupeKey, detail, trx, link: composed.link, metadata: { bidId: spec.subject.id, ...composed.metadata },
  });
}

module.exports = { newBidSpec, addendumSpec, reminderSpec, questionsReminderSpec, jobWalkReminderSpec, raise, raiseReopening, linkFor };
