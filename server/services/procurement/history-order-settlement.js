/**
 * procurement/history-order-settlement.js — charge-check, late read-back
 * settlement, 35-day cap-hold expiry, stale-recovery order parsing, and
 * post-receipt money-alert wording for history-total auto-orders (Sticker Mule).
 *
 * Extracted from order-dispatch.js to keep both modules small, focused, and
 * free of circular dependencies (helpers passed explicitly by order-dispatch).
 */
const logger = require('../logger');
const { addETDaysAtWallClock } = require('../../utils/datetime-et');
const { auditVendorOrder } = require('../audit-log');
const { CAPS_LOCK_KEY } = require('./history-order-policy');

const HOLD_READ_DAYS = 35;

// Three alerts of a history-total order say its charge accounting is wrong, drifted, or unknown:
// a charge read back above what was held against the caps (evidence.overHoldAt),
// a charge the vendor never confirmed within HOLD_READ_DAYS (evidence.holdExpiredAt),
// and an immediate or late read-back charge that drifted >5% and >$2 from the last identical order
// (evidence.driftAlertAt). Each is a money alert of its own: re-rung until it lands regardless of
// request status (unless revoked), and never closed simply by receiving the stock.
const CAP_ALERT_SQL = "(NULLIF(vo.evidence->>'overHoldAt', '') IS NOT NULL OR NULLIF(vo.evidence->>'holdExpiredAt', '') IS NOT NULL OR NULLIF(vo.evidence->>'driftAlertAt', '') IS NOT NULL)";
const capAlert = (evidence) => !!(evidence?.overHoldAt || evidence?.holdExpiredAt || evidence?.driftAlertAt);

const positiveCents = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const dollars = (cents) => (cents == null ? 'unknown amount' : `$${(Number(cents) / 100).toFixed(2)}`);
const meta = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
};

// Tolerance in integer cents with no rounding: more than 5% AND more than $2 off the last identical order.
const offHistoryTotal = (cents, historyCents) => {
  const drift = Math.abs(cents - historyCents);
  return drift > 200 && drift * 20 > historyCents;
};

const alsoCheck = (check) => (check ? ` Also: ${check.message}` : '');

function historyTotalCheck({ vendor, placed, finalCents, historyCents }) {
  if (!(historyCents > 0)) return null;
  const order = `${vendor.name} order ${placed.externalOrderNumber || '?'}`;
  const reason = 'history_total_check';
  if (!(placed.amountCents > 0)) {
    return {
      reason,
      message: `${order} was placed, but the vendor has not confirmed a paid total for it yet; ${dollars(finalCents)} (the per-order cap) is held against the monthly cap until a later run reads the charge. The last identical order was ${dollars(historyCents)}. Check the charge on the ${vendor.name} account.`,
    };
  }
  const overHold = placed.evidence?.overHoldAt ? ' That is MORE than was held against the caps.' : '';
  if (!overHold && !offHistoryTotal(finalCents, historyCents)) return null;
  return {
    reason,
    message: `${order} was placed at ${dollars(finalCents)}; the last identical order was ${dollars(historyCents)}.${overHold} Check the charge on the ${vendor.name} account.`,
  };
}

function heldCheck(historyCents, heldCents) {
  if (!(historyCents > 0)) return null;
  return {
    reason: 'history_total_check',
    message: `The charge is not confirmed: ${dollars(heldCents)} is held against the monthly cap; the last identical order was ${dollars(historyCents)}.`,
  };
}

function withHistoryTotal(placed, historyCents, holdCents) {
  if (!historyCents) return placed;
  const cents = positiveCents(placed.amountCents);
  const overHold = cents != null && cents > holdCents;
  const drifted = !overHold && cents != null && offHistoryTotal(cents, historyCents);
  const at = overHold || drifted ? new Date().toISOString() : null;
  return {
    ...placed,
    evidence: {
      ...(placed.evidence || {}),
      historyCents,
      ...(overHold ? { overHoldAt: at } : {}),
      ...(drifted ? { driftAlertAt: at } : {}),
    },
  };
}

// Replaces pre-receipt AND late-receive ("receive the stock / receive once more / record vendor
// cancellation") clauses with received-state charge-review wording once the stock has been received
// (including after the second receipt clears landedAfterReceive).
const POST_SUBMIT_RECONCILE_RE = /Do NOT re-order: check the .+ account(?: \(order [^)]+\))? and reconcile by hand — receive the stock, or cancel with the vendor and then use Record vendor cancellation on the Restock tab\./;
const LATE_PLACEMENT_RECONCILE_RE = /The request is back to ordered — receive the stock when it arrives, or cancel with the vendor and then use Record vendor cancellation on the Restock tab(?: again)?\./;
const LATE_RECEIVE_RECONCILE_RE = /(?:Do NOT re-order: )?[Tt]he stock counted at (?:that|the) receipt was not this order: receive the request once more when it arrives \(the tab allows it for this order\), or cancel with the vendor and then use Record vendor cancellation on the Restock tab(?:; new requests for the product are blocked until then)?\./;
const PARK_ON_RECEIVED_RE = / — the stock counted was not this order\. Receive the request once more when it arrives \(the tab allows it for this order\), or cancel with the vendor and then use Record vendor cancellation on the Restock tab; new requests for the product are blocked until then\./;

function rewriteCapAlertForReceipt(bell, { vendorName, orderNumber, versioned }) {
  if (!bell?.body) return null;
  const acct = vendorName ? `the ${vendorName} account` : 'the vendor account';
  const ord = orderNumber ? ` (order ${orderNumber})` : '';
  const receivedNext = `Do NOT re-order: the stock was received, so only the charge is left: check it on ${acct}${ord}, then mark this alert done.`;
  let nextBody = bell.body;
  if (PARK_ON_RECEIVED_RE.test(nextBody)) nextBody = nextBody.replace(PARK_ON_RECEIVED_RE, '.');
  if (POST_SUBMIT_RECONCILE_RE.test(nextBody)) nextBody = nextBody.replace(POST_SUBMIT_RECONCILE_RE, receivedNext);
  else if (LATE_RECEIVE_RECONCILE_RE.test(nextBody)) nextBody = nextBody.replace(LATE_RECEIVE_RECONCILE_RE, receivedNext);
  else if (LATE_PLACEMENT_RECONCILE_RE.test(nextBody)) nextBody = nextBody.replace(LATE_PLACEMENT_RECONCILE_RE, receivedNext);
  return nextBody !== bell.body ? versioned({ title: bell.title, body: nextBody }) : null;
}

// Stale-recovery park fields when a placing claim already carries a confirmed vendor order number.
function savedOrderPark(row) {
  if (!row.external_order_number) return {};
  const evidence = meta(row.evidence);
  const vendor = row.vendor_name || 'vendor';
  const history = positiveCents(evidence.historyCents);
  const amount = positiveCents(row.amount_cents == null ? null : Number(row.amount_cents));
  const hold = positiveCents(evidence.holdCents);
  if (amount != null && hold != null && amount > hold) {
    return {
      reason: 'history_total_check',
      markRequestOrdered: true,
      placed: { externalOrderNumber: row.external_order_number },
      evidence: { ...evidence, totalSource: 'vendor', overHoldAt: new Date().toISOString() },
      message: `${vendor} order ${row.external_order_number} was charged ${dollars(amount)}, MORE than the ${dollars(hold)} held against the caps; the dispatcher stopped before it recorded the order.${history == null ? '' : ` The last identical order was ${dollars(history)}.`} Check the charge on the ${vendor} account.`,
    };
  }
  const held = row.amount_cents == null ? 'nothing' : dollars(Number(row.amount_cents));
  return {
    reason: 'history_total_check',
    markRequestOrdered: true,
    placed: { externalOrderNumber: row.external_order_number },
    evidence: { ...evidence, totalSource: 'none' },
    message: `${vendor} order ${row.external_order_number} was placed, but the dispatcher stopped before it read the charge; ${held} is held against the monthly cap until a later run reads the charge.${history == null ? '' : ` The last identical order was ${dollars(history)}.`} Check the charge on the ${vendor} account.`,
  };
}

async function bellStillOpen(trx, ledgerId, evidence, bellKey) {
  if (!evidence.bellAt) return true;
  return !!(await trx('notifications')
    .whereRaw("metadata->>'dedupeKey' = ?", [bellKey(ledgerId, evidence.bell.v)])
    .whereNull('done_at')
    .first('id'));
}

async function chargeAlertBell(trx, { row, vendor, evidence, reason, message, amountCents }, { parkBell, versioned }) {
  const placed = { externalOrderNumber: row.external_order_number };
  const request = await trx('product_restock_requests').where({ id: row.restock_request_id }).first('status');
  if (request?.status !== 'received') {
    return parkBell({ reason, status: 'needs_review', product: { name: row.product_name || '?' }, vendor, request: {}, amountCents, placed, message });
  }
  const next = evidence.landedAfterReceive
    ? 'the stock counted at the receipt was not this order: receive the request once more when it arrives (the tab allows it for this order), or cancel with the vendor and then use Record vendor cancellation on the Restock tab.'
    : `the stock was received, so only the charge is left: check it on the ${vendor.name} account (order ${row.external_order_number}), then mark this alert done.`;
  return versioned({ title: `Auto-order needs review: ${row.product_name || '?'} (${vendor.name})`, body: `${message} Do NOT re-order: ${next}` });
}

async function retireExpiryAlert(trx, { row, evidence, over, drifted }, { retireLedgerBells }) {
  if (!evidence.holdExpiredAt || over || drifted || evidence.landedAfterReceive) return false;
  const request = await trx('product_restock_requests').where({ id: row.restock_request_id }).first('status');
  if (request?.status !== 'received') return false;
  await retireLedgerBells(trx, row.id, 'The charge was confirmed after all, within what was held');
  return true;
}

async function holdSettledBell(trx, { evidence, note, over, drifted, row, cents, held, history }, helpers) {
  const stored = evidence.bell?.title ? evidence.bell : null;
  if (stored && (over || drifted || evidence.holdExpiredAt || await bellStillOpen(trx, row.id, evidence, helpers.bellKey))) {
    return helpers.versioned({ title: stored.title, body: `${stored.body || ''}${note}` });
  }
  if (!over && !drifted) return null;
  const vendor = { name: row.vendor_name || row.adapter };
  if (over) {
    return chargeAlertBell(trx, {
      row,
      vendor,
      evidence,
      reason: 'over_cap_after_placement',
      amountCents: cents,
      message: `${vendor.name} charged ${dollars(cents)} for order ${row.external_order_number}, read back after placement: more than the ${held == null ? 'amount' : dollars(held)} held against the caps.`,
    }, helpers);
  }
  return chargeAlertBell(trx, {
    row,
    vendor,
    evidence,
    reason: 'history_total_check',
    amountCents: cents,
    message: `${vendor.name} charged ${dollars(cents)} for order ${row.external_order_number}, read back after placement; the last identical order was ${dollars(history)}. Check the charge on the ${vendor.name} account.`,
  }, helpers);
}

async function settledHoldAlert(trx, args, helpers) {
  if (await retireExpiryAlert(trx, args, helpers)) return { bell: null, drop: " - 'holdExpiredAt' - 'bellAt' - 'bell'" };
  const bell = await holdSettledBell(trx, args, helpers);
  return { bell, drop: bell ? " - 'holdExpiredAt' - 'bellAt'" : " - 'holdExpiredAt'" };
}

async function settleHoldLocked(trx, row, cents, helpers) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [CAPS_LOCK_KEY]);
  const locked = await trx('vendor_orders').where({ id: row.id }).forUpdate().first('placed_at', 'amount_cents', 'error', 'evidence');
  const evidence = meta(locked?.evidence);
  if (!locked?.placed_at || evidence.totalSource !== 'none' || evidence.revokedAt) return false;
  const held = positiveCents(evidence.holdCents) ?? positiveCents(Number(locked.amount_cents));
  const over = held == null || cents > held;
  const history = positiveCents(evidence.historyCents);
  const drifted = !over && history != null && offHistoryTotal(cents, history);
  const at = new Date().toISOString();
  const verdict = over
    ? ' That is MORE than was held against the caps: check the charge and this month\'s spend.'
    : drifted ? ` The last identical order was ${dollars(history)}: check the charge.` : '';
  const note = ` [Charge confirmed later: ${dollars(cents)}${held == null ? '' : `, replacing the ${dollars(held)} hold`}.${verdict}]`;
  const { bell, drop } = await settledHoldAlert(trx, { evidence, note, over, drifted, row, cents, held, history }, helpers);
  await trx('vendor_orders').where({ id: row.id }).update({
    amount_cents: cents,
    error: `${String(locked.error || '').slice(0, 400 - note.length)}${note}`,
    evidence: trx.raw(`(COALESCE(evidence, '{}'::jsonb)${drop}) || ?::jsonb`, [JSON.stringify({
      totalSource: 'vendor',
      holdSettledAt: at,
      ...(over ? { overHoldAt: at } : {}),
      ...(drifted ? { driftAlertAt: at } : {}),
      ...(bell ? { bell } : {}),
    })]),
    updated_at: new Date(),
  });
  await auditVendorOrder({
    vendor_order_id: row.id,
    restock_request_id: row.restock_request_id,
    vendor_id: row.vendor_id,
    adapter: row.adapter,
    outcome: 'charge_confirmed',
    amount_cents: cents,
    external_order_number: row.external_order_number,
    reason: `read-back ${dollars(cents)} replaced the ${held == null ? 'unrecorded' : dollars(held)} hold${over ? ' (more than the hold)' : drifted ? ` (the last identical order was ${dollars(history)})` : ''}`,
    trx,
  });
  return { bell };
}

async function expireHoldLocked(trx, row, cutoff, helpers) {
  const locked = await trx('vendor_orders').where({ id: row.id }).forUpdate().first('placed_at', 'amount_cents', 'error', 'evidence');
  const evidence = meta(locked?.evidence);
  if (!locked?.placed_at || new Date(locked.placed_at) > cutoff || evidence.totalSource !== 'none' || evidence.revokedAt || evidence.holdExpiredAt) return false;
  const held = locked.amount_cents == null ? 'nothing' : dollars(Number(locked.amount_cents));
  const vendor = { name: row.vendor_name || row.adapter };
  const message = `${vendor.name} order ${row.external_order_number} was placed more than ${HOLD_READ_DAYS} days ago and the vendor still shows no paid total for it. ${held} stays counted against the monthly cap of the month it was ordered in, and the charge is no longer checked: check it on the ${vendor.name} account.`;
  const bell = await chargeAlertBell(trx, {
    row,
    vendor,
    evidence,
    reason: 'history_total_check',
    message,
    amountCents: locked.amount_cents == null ? null : Number(locked.amount_cents),
  }, helpers);
  const note = ` [No paid total after ${HOLD_READ_DAYS} days: the hold of ${held} stays and the charge is no longer checked.]`;
  await trx('vendor_orders').where({ id: row.id }).update({
    error: `${String(locked.error || '').slice(0, 400 - note.length)}${note}`,
    evidence: trx.raw("(COALESCE(evidence, '{}'::jsonb) - 'bellAt') || ?::jsonb", [JSON.stringify({ holdExpiredAt: new Date().toISOString(), bell })]),
    updated_at: new Date(),
  });
  await auditVendorOrder({
    vendor_order_id: row.id,
    restock_request_id: row.restock_request_id,
    vendor_id: row.vendor_id,
    adapter: row.adapter,
    outcome: 'charge_unconfirmed',
    amount_cents: locked.amount_cents == null ? null : Number(locked.amount_cents),
    external_order_number: row.external_order_number,
    reason: `no paid total read back in ${HOLD_READ_DAYS} days; the hold of ${held} stays`,
    trx,
  });
  return true;
}

async function settleHistoryHolds({ conn, registry, now = new Date() }, helpers) {
  const cutoff = addETDaysAtWallClock(now, -HOLD_READ_DAYS);
  const rows = await conn('vendor_orders as vo')
    .join('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
    .whereNotNull('vo.placed_at')
    .whereNotNull('vo.external_order_number')
    .whereRaw("vo.evidence->>'totalSource' = 'none'")
    .whereRaw("NULLIF(vo.evidence->>'revokedAt', '') IS NULL")
    .whereRaw("NULLIF(vo.evidence->>'holdExpiredAt', '') IS NULL")
    .select('vo.id', 'vo.adapter', 'vo.external_order_number', 'vo.placed_at', 'vo.restock_request_id', 'vo.vendor_id', 'pc.name as product_name', 'v.name as vendor_name');

  const settled = [];
  for (const row of rows) {
    const adapter = registry[row.adapter];
    let cents = null;
    if (adapter && typeof adapter.readCharge === 'function') {
      try { cents = positiveCents(await adapter.readCharge(row.external_order_number)); }
      catch (err) { logger.warn(`[order-dispatch] hold read failed for ledger ${row.id} (order ${row.external_order_number}): ${err.message}`); }
    }
    const write = cents != null
      ? (trx) => settleHoldLocked(trx, row, cents, helpers)
      : new Date(row.placed_at) <= cutoff
        ? (trx) => expireHoldLocked(trx, row, cutoff, helpers)
        : null;
    if (write && await conn.transaction(write)) settled.push(row.id);
  }
  return settled;
}

module.exports = {
  HOLD_READ_DAYS,
  CAP_ALERT_SQL,
  capAlert,
  offHistoryTotal,
  alsoCheck,
  historyTotalCheck,
  heldCheck,
  withHistoryTotal,
  rewriteCapAlertForReceipt,
  savedOrderPark,
  bellStillOpen,
  chargeAlertBell,
  settleHoldLocked,
  expireHoldLocked,
  settleHistoryHolds,
};
