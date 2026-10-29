'use strict';

// The bell's No bid / Bid buttons on a new bid invite's row (owner 2026-10-29 "bid buttons, as a trial";
// docs/admin-notifications.md section 2, part 9, kind bid_decision; GATE_BID_ALERT_BUTTONS). A tap runs the Bid
// desk's own save step (routes/admin-bid-desk.js saveBidUpdate, behind the page's Save decision) with two more
// checks under its lock: the bid is still new, and Bid needs a confirmed due date, the only kind its reminders run
// on. It sends nothing to a buyer or customer and moves no money. Week-1 read-out: ops job bid-buttons-trial-week1.

const db = require('../../models/db');

const KIND = 'bid_decision';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEMS = {
  no_bid: { label: 'No bid', prompt: 'Mark this bid No bid and close its other notifications?' },
  bid: { label: 'Bid', prompt: 'Mark this bid Bid and keep its due-date reminders?' },
};

// Both are stored on the row when it is raised (alerts.js newBidSpec); visibleItems decides which ones the bell shows.
const bidButtons = () => ({ kind: KIND, items: Object.entries(ITEMS).map(([id, { label, prompt }]) => ({ id, label, prompt })) });

// A due date the operator confirmed on the Bid desk (rules.js reminderDue runs on no other kind).
const dateConfirmed = (bid) => bid.due_confirmed === true && !!bid.due_at && !bid.needs_date_confirmation;
const allowedFor = (bid) => (bid?.status === 'new' ? ['no_bid', ...(dateConfirmed(bid) ? ['bid'] : [])] : []);
const bidIdOf = (metadata) => (UUID.test(String(metadata?.bidId || '')) ? String(metadata.bidId) : null);

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

// Serving the bell: one read for every bid row on the page. A decided or missing bid serves no button.
async function visibleItems(rows) {
  const ids = [...new Set(rows.map((row) => bidIdOf(row.metadata)).filter(Boolean))];
  const bids = ids.length
    ? await db('bid_opportunities').whereIn('id', ids).select('id', 'status', 'due_at', 'due_confirmed', 'needs_date_confirmation')
    : [];
  const byId = new Map(bids.map((bid) => [String(bid.id), bid]));
  return new Map(rows.map((row) => [row.id, allowedFor(byId.get(bidIdOf(row.metadata)))]));
}

const REFUSALS = {
  decided: { message: 'This bid was already decided on the Bid desk.', close: 'Bid already decided on the Bid desk' },
  gone: { message: 'This bid is no longer on the Bid desk.', close: 'Bid no longer on the Bid desk' },
  date_not_confirmed: { message: 'Confirm the due date on the Bid desk first.' },
  refused: { message: 'Open the Bid desk to save this decision.' },
};
const refuse = (code) => ({ ok: false, code, ...REFUSALS[code] });

async function run({ row, item }) {
  const choice = Object.hasOwn(ITEMS, item.id) ? item.id : null;
  if (!choice) return { ok: false, code: 'unknown_action', message: 'This button is not known.' };
  const bidId = bidIdOf(parseMetadata(row.metadata));
  if (!bidId) return refuse('refused');
  const { saveBidUpdate } = require('../../routes/admin-bid-desk');
  const precheck = (bid) => {
    if (bid.status !== 'new') return { status: 409, body: { error: 'decided' } };
    if (choice === 'bid' && !dateConfirmed(bid)) return { status: 409, body: { error: 'date_not_confirmed' } };
    return null;
  };
  const outcome = await db.transaction((trx) => saveBidUpdate(trx, bidId, { status: choice }, { precheck }));
  if (outcome.status === 200) return { ok: true, message: `Marked ${ITEMS[choice].label}.`, resolution: ITEMS[choice].label };
  if (outcome.status === 404) return refuse('gone');
  const code = outcome.body?.error;
  return refuse(code === 'decided' || code === 'date_not_confirmed' ? code : 'refused');
}

const buttonHandler = {
  // The Bid desk's own gate too: its routes answer 404 while GATE_BID_DESK is off.
  live: () => {
    const gates = require('../../config/feature-gates');
    return gates.bidAlertButtonsLive() && gates.bidDeskLive();
  },
  visibleItems,
  run,
};

module.exports = { bidButtons, buttonHandler, _private: { ITEMS, dateConfirmed, allowedFor } };
