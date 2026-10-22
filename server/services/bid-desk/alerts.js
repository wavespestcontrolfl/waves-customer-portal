'use strict';

/**
 * Bid Desk admin notifications (GATE_BID_DESK). The specs are pure; raise() sends them through raiseAdminAlert
 * (docs/admin-notifications.md). Nothing here writes to a buyer, a contractor or a customer: the audience is the
 * admin bell only.
 */
const { raiseAdminAlert, cutAtWord, breaksAlertRules, MAX_WHY_CHARS } = require('../admin-alert-compose');
const { fitAction, shortDateET } = require('../admin-alert-names');

const AREA = 'Estimates';
const CATEGORY = 'lead';
const STATUS_LABEL = { new: 'no decision yet', bid: 'marked as bid' };

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

function addendumSpec(bid, email) {
  const title = titleOf(bid, email);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, title, [(n) => `addendum on ${n}: confirm the due date`, (n) => `addendum on ${n}`, (n) => `addendum, ${n}`]),
      why: cutAtWord(`A new email may change the date, so confirm it; the bid reads ${dueWords(bid)}.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: linkFor(bid),
      subject: subjectFor(bid),
      doneWhen: 'due_date_confirmed',
      who: 'person',
    },
    detail: `Addendum on ${title}: confirm the due date`,
  };
}

function reminderSpec(bid, window) {
  const title = titleOf(bid, null);
  const days = window === '2d' ? 2 : 7;
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, title, [(n) => `bid due in ${days} days: ${n}`, (n) => `bid due in ${days} days, ${n}`]),
      why: cutAtWord(`Due ${shortDateET(bid.due_at)}${etTimeWords(bid.due_at)}; ${STATUS_LABEL[bid.status] || bid.status}.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: linkFor(bid),
      subject: subjectFor(bid),
      doneWhen: 'bid_decided',
      who: 'person',
    },
    detail: `Bid reminder: ${title} is due ${shortDateET(bid.due_at)}${etTimeWords(bid.due_at)} (${days} days). Status: ${bid.status}.`,
  };
}

// Rings once per key: the dedupe key is the bid (and email or window), so a retry never rings twice.
async function raise({ spec, detail }, dedupeKey, trx) {
  return raiseAdminAlert(CATEGORY, spec, { bell: true, dedupeKey, detail, metadata: { bidId: spec.subject.id }, trx });
}

module.exports = { newBidSpec, addendumSpec, reminderSpec, raise, linkFor };
