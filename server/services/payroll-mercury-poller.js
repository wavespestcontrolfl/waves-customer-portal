/**
 * The Mercury status poller (owner plan A, 2026-10-30): every 15 minutes, behind GATE_PAYROLL_MERCURY_STATUS (and
 * GATE_PAYROLL). READ-ONLY toward Mercury: it never makes a payment request and never repeats one. It moves each
 * open payroll_payments row on from what Mercury says and rings the bells (payroll-mercury-alerts.js).
 *
 *   queued     older than 5 minutes: the server stopped before the answer was saved -> unknown
 *   requested  GET the request: still pending stays; approved -> approved; rejected / cancelled -> that state
 *   approved   find the transaction (Mercury filters the account's transactions by request id): sent -> sent with
 *              the day it posted; failed -> failed
 *   unknown    list the account's requests for the recipient created since the attempt: one carrying our note is
 *              linked and takes its state; a same-amount one without our note stays unknown and rings "probably
 *              ours"; none stays unknown. Unknown for 30 minutes rings.
 *   sent       read again once a day for 60 days; a failed, reversed or refunded transaction -> returned. After 60
 *              days it stops being read, and the row stays listed.
 *   a 401 or 403 from Mercury rings one bell (the key was deleted or lowered to read-only) and ends the run.
 *
 * A returned ACH changes payroll_payments only: never wages, taxes or filed figures. Nothing is logged from a
 * Mercury answer: ids and states only.
 */
const db = require('../models/db');
const logger = require('./logger');
const alerts = require('./payroll-mercury-alerts');
const { createClient, MercuryError } = require('./mercury-client');
const { previousBusinessDayIrs } = require('./payroll-tax-calendar');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const QUEUED_STALE_MS = 5 * MINUTE_MS;
const UNKNOWN_BELL_MS = 30 * MINUTE_MS;
const SENT_WINDOW_MS = 60 * DAY_MS;
const SENT_REREAD_MS = 23 * 60 * MINUTE_MS;
const LOOKBACK_MS = 5 * MINUTE_MS;
const RETURN_WINDOW_NOTE = 'No return seen in 60 days';
const BAD_TRANSACTION = ['failed', 'cancelled', 'blocked'];

const gateOn = (name) => {
  const gates = require('../config/feature-gates');
  return typeof gates[name] === 'function' && gates[name]();
};
const payrollOn = () => gateOn('payrollLive');
const statusOn = () => gateOn('payrollMercuryStatusLive');

// ---- Pure decisions: each returns the patch for the row (or null for no change) plus the bell to ring

const REQUEST_STATES = { approved: 'approved', rejected: 'rejected', cancelled: 'cancelled' };

// A request's status as the payment's next state. pendingApproval keeps the row as it is.
function stateForRequest(status) {
  return REQUEST_STATES[status] || null;
}

function patchForRequest(request) {
  const state = stateForRequest(request.status);
  if (!state) return { patch: {}, bell: null, linked: request.status === 'pendingApproval' };
  const closed = state === 'rejected' || state === 'cancelled';
  return {
    patch: { state, ...(closed ? { resolved_at: 'now', resolution: `Mercury shows the request as ${state}` } : {}) },
    bell: closed ? state : null,
    linked: true,
  };
}

// The transaction an approved request made, from the account's transactions (filtered by request id).
function transactionFor(row, transactions) {
  const mine = transactions.find((t) => t.requestId === row.mercury_request_id && t.amountCents === Number(row.amount_cents));
  if (mine) return mine;
  // Fallback when Mercury does not tie the request id: our note, this amount, this recipient.
  return transactions.find((t) => t.note === row.note && t.amountCents === Number(row.amount_cents) && t.counterpartyId === row.recipient_id) || null;
}

const postedOn = (tx) => (tx.postedAt ? etDateString(new Date(tx.postedAt)) : null);

function patchForTransaction(row, tx) {
  if (!tx) return { patch: {}, bell: null };
  if (tx.status === 'sent') {
    return { patch: { state: 'sent', mercury_transaction_id: tx.id, posted_on: postedOn(tx), resolved_at: 'now', resolution: 'Mercury shows the money sent' }, bell: null, settled: true };
  }
  if (BAD_TRANSACTION.includes(tx.status) || tx.failedAt) {
    return { patch: { state: 'failed', mercury_transaction_id: tx.id, error: 'Mercury could not complete the transfer.', resolved_at: 'now', resolution: 'Mercury shows the transfer failed' }, bell: 'failed' };
  }
  if (tx.status === 'reversed') {
    return { patch: { state: 'returned', mercury_transaction_id: tx.id, resolved_at: 'now', resolution: 'Mercury shows the transfer reversed' }, bell: 'returned' };
  }
  return { patch: tx.id === row.mercury_transaction_id ? {} : { mercury_transaction_id: tx.id }, bell: null };
}

// A sent payment read again: a failed, reversed or refunded transaction means the money came back.
function patchForSentReread(row, tx) {
  if (!tx) return { patch: {}, bell: null };
  if (BAD_TRANSACTION.includes(tx.status) || tx.status === 'reversed' || tx.hasReturn || tx.failedAt) {
    return { patch: { state: 'returned', resolved_at: 'now', resolution: 'The bank transfer came back' }, bell: 'returned' };
  }
  const day = postedOn(tx);
  return { patch: day && !row.posted_on ? { posted_on: day } : {}, bell: null };
}

// A request list for an unknown payment: ours (carries our note), or probably ours (same amount, no note).
function matchUnknown(row, requests) {
  const since = new Date(row.created_at).getTime() - LOOKBACK_MS;
  const near = requests.filter((r) => r.recipientId === row.recipient_id && r.createdAt && new Date(r.createdAt).getTime() >= since);
  const ours = near.find((r) => typeof r.memo === 'string' && r.memo.includes(row.note));
  if (ours) return { kind: 'ours', request: ours };
  const likely = near.find((r) => r.amountCents === Number(row.amount_cents) && !['rejected', 'cancelled'].includes(r.status));
  return likely ? { kind: 'probably_ours' } : { kind: 'none' };
}

// ---- Applying a patch

const resolveNow = (patch, now) => Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === 'now' ? now : value]));

async function applyPatch(conn, row, patch, now) {
  const changed = await conn('payroll_payments').where({ id: row.id, state: row.state })
    .update({ ...resolveNow(patch, now), updated_at: now, last_polled_at: now });
  return Number(changed) > 0;
}

async function afterChange(row, result, patch, conn) {
  if (result.bell) await alerts.raisePaymentAlert(result.bell, { ...row, ...patch }, { conn });
  if (patch.state === 'approved') await alerts.closePaymentBells(row.id, 'The request was approved in Mercury', { conn });
  if (patch.state === 'sent') await alerts.closePaymentBells(row.id, 'Mercury shows the money sent', { conn });
  const day = patch.posted_on || null;
  if (day && String(day).slice(0, 7) !== String(row.pay_date).slice(0, 7)) {
    await alerts.raisePaymentAlert('month_mismatch', { ...row, posted_on: day }, { conn });
  }
}

// ---- One row

async function stepQueued(row, ctx) {
  // Judged on updated_at, which a send touches right before it asks Mercury (dispatch claims the row the same way), so a
  // row being sent now is never taken, and a row taken here is never sent afterwards.
  const cutoff = new Date(ctx.now.getTime() - QUEUED_STALE_MS);
  const changed = await ctx.conn('payroll_payments').where({ id: row.id, state: 'queued' }).where('updated_at', '<', cutoff).update({
    state: 'unknown', updated_at: ctx.now, last_polled_at: ctx.now,
    error: 'The server stopped before Mercury answered. The request may or may not have reached it.',
  });
  return Number(changed) > 0;
}

async function stepRequested(row, ctx) {
  const result = patchForRequest(await ctx.client.getRequest(row.mercury_request_id));
  const changed = await applyPatch(ctx.conn, row, result.patch, ctx.now);
  if (changed && result.patch.state) await afterChange(row, result, resolveNow(result.patch, ctx.now), ctx.conn);
  if (!result.patch.state) await maybeRingPendingNoon(row, ctx);
  return changed;
}

async function maybeRingPendingNoon(row, ctx) {
  const day = previousBusinessDayIrs(String(row.pay_date).slice(0, 10));
  if (ctx.now.getTime() >= parseETDateTime(`${day}T12:00`).getTime()) {
    await alerts.raisePaymentAlert('pending_noon', row, { conn: ctx.conn });
  }
}

async function stepApproved(row, ctx) {
  let transactions = await ctx.client.listTransactions({ requestId: row.mercury_request_id, start: etDateString(new Date(row.created_at)) });
  let tx = transactionFor(row, transactions);
  if (!tx) {
    transactions = await ctx.client.listTransactions({ start: etDateString(new Date(row.created_at)) });
    tx = transactionFor(row, transactions);
  }
  const result = patchForTransaction(row, tx);
  const changed = await applyPatch(ctx.conn, row, result.patch, ctx.now);
  if (changed && result.patch.state) await afterChange(row, result, resolveNow(result.patch, ctx.now), ctx.conn);
  return changed;
}

async function stepSent(row, ctx) {
  // From the day the request was made: Mercury's own default is the last 30 days, short of the 60-day watch.
  const transactions = await ctx.client.listTransactions({ requestId: row.mercury_request_id, start: etDateString(new Date(row.created_at)) });
  const result = patchForSentReread(row, transactionFor(row, transactions));
  const changed = await applyPatch(ctx.conn, row, result.patch, ctx.now);
  if (changed && (result.patch.state || result.patch.posted_on)) await afterChange(row, result, resolveNow(result.patch, ctx.now), ctx.conn);
  return changed;
}

async function stepUnknown(row, ctx) {
  const match = matchUnknown(row, await ctx.client.listRequests());
  let changed = false;
  if (match.kind === 'ours') {
    const result = patchForRequest(match.request);
    const patch = { mercury_request_id: match.request.requestId, error: null, state: result.patch.state || 'requested', ...(result.patch.state ? result.patch : {}) };
    patch.resolution = patch.resolution || 'Found the request in Mercury';
    try {
      changed = await applyPatch(ctx.conn, row, patch, ctx.now);
    } catch (err) {
      if (!(err && err.code === '23505')) throw err;
    }
    if (changed) await afterChange(row, result, resolveNow(patch, ctx.now), ctx.conn);
  } else {
    changed = await applyPatch(ctx.conn, row, {}, ctx.now);
    if (match.kind === 'probably_ours') await alerts.raisePaymentAlert('probably_ours', row, { conn: ctx.conn });
    if (ctx.now.getTime() - new Date(row.created_at).getTime() >= UNKNOWN_BELL_MS) await alerts.raisePaymentAlert('unknown', row, { conn: ctx.conn });
  }
  return changed;
}

const STEPS = { queued: stepQueued, requested: stepRequested, approved: stepApproved, sent: stepSent, unknown: stepUnknown };

// ---- The run

async function dueRows(conn, now) {
  const window = new Date(now.getTime() - SENT_WINDOW_MS);
  const reread = new Date(now.getTime() - SENT_REREAD_MS);
  return conn('payroll_payments as p').join('payroll_checks as c', 'c.id', 'p.check_id')
    .where(function open() {
      this.whereIn('p.state', ['queued', 'requested', 'unknown', 'approved']).orWhere(function sentInWindow() {
        this.where('p.state', 'sent').whereRaw('COALESCE(p.resolved_at, p.created_at) > ?', [window])
          .where(function notReadToday() { this.whereNull('p.last_polled_at').orWhere('p.last_polled_at', '<', reread); });
      });
    })
    .orderBy('p.created_at')
    .limit(200)
    .select('p.*', 'c.employee_name', conn.raw("to_char(c.pay_date, 'YYYY-MM-DD') as pay_date"));
}

// After 60 days a sent payment stops being read. It stays listed; its resolution says so.
async function closeReturnWindow(conn, now, accountId) {
  const window = new Date(now.getTime() - SENT_WINDOW_MS);
  // Only payments this account made: one from another account was never read, so no return was "seen" or missed.
  return conn('payroll_payments').where({ state: 'sent', account_id: accountId }).whereRaw('COALESCE(resolved_at, created_at) <= ?', [window])
    .whereRaw('resolution IS DISTINCT FROM ?', [RETURN_WINDOW_NOTE])
    .update({ resolution: RETURN_WINDOW_NOTE, updated_at: now });
}

// Reads each due row once. Stops at the first refused key. Returns { read, changed, failed, refused, answered }.
async function pollRows(rows, ctx) {
  const out = { read: 0, changed: 0, failed: 0, mismatched: 0, refused: false, answered: false };
  for (const row of rows) {
    // A payment lives in the account it was made in. After an account change it is not read here: surface it instead.
    if (row.state !== 'queued' && row.account_id && ctx.client.accountId && row.account_id !== ctx.client.accountId) {
      out.mismatched += 1;
      await alerts.raisePaymentAlert('account_changed', row, { conn: ctx.conn });
      continue;
    }
    try {
      if (await STEPS[row.state](row, ctx)) out.changed += 1;
      if (row.state !== 'queued') out.answered = true;
      out.read += 1;
    } catch (err) {
      out.failed += 1;
      if (err instanceof MercuryError && err.kind === 'auth') { out.refused = true; break; }
      logger.error(`[payroll-mercury-poller] payment ${row.id} not read (${(err && (err.kind || err.code || err.name)) || 'error'})`);
    }
  }
  return out;
}

async function pollPayments({ client = createClient(), conn = db, now = new Date() } = {}) {
  if (!payrollOn() || !statusOn()) return { read: 0, changed: 0, failed: 0, skipped: 'gate_off' };
  if (!client.configured) return { read: 0, changed: 0, failed: 0, skipped: 'not_configured' };
  const out = await pollRows(await dueRows(conn, now), { client, conn, now });
  if (out.refused) await alerts.raiseKeyAlert();
  else if (out.answered) await alerts.closeKeyBell({ conn });
  try { await closeReturnWindow(conn, now, client.accountId); } catch (err) {
    logger.error(`[payroll-mercury-poller] return window not closed (${(err && (err.code || err.name)) || 'error'})`);
  }
  logger.info(`[payroll-mercury-poller] read ${out.read}, changed ${out.changed}, failed ${out.failed}`);
  return { read: out.read, changed: out.changed, failed: out.failed, skipped: null };
}

module.exports = {
  pollPayments, patchForRequest, patchForTransaction, patchForSentReread, matchUnknown, transactionFor, stateForRequest,
};
