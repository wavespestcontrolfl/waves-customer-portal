/**
 * Record that a vendor cancelled ONE automatic order (the "revoke" the cancel
 * guard asks for: order-dispatch.js assertManualActionAllowed), so its restock
 * request can close and a replacement can be ordered.
 *
 * Two callers share these rules:
 *   - the Restock tab's "Record vendor cancellation" (POST
 *     /admin/inventory/restock-requests/:id/vendor-cancellation, owner-only):
 *     recordVendorCancellation below, which also checks that the order is the
 *     one the tab showed;
 *   - ops/agents/auto-order-revoke.js (the maintenance CLI, a system actor).
 *
 * Nothing is sent to the vendor: cancelling with Sticker Mule / SiteOne stays
 * manual (Sticker Mule has no cancel endpoint). The record must FOLLOW that
 * cancellation, never precede it: it re-enables request cancel and replacement
 * ordering.
 *
 * The ledger row (status `placed`, or a post-submit `needs_review` park with
 * placed_at set) goes to needs_review with the STRUCTURED evidence.revokedAt
 * marker the cancel guard, the dispatcher's prior-order belt and the spend caps
 * read. A `placing` row is still the dispatcher's: reopening its request would
 * race the in-flight vendor call into a double purchase, so it is refused.
 * The restock request is CANCELLED (reason revoked_vendor_order), not reopened:
 * restock_request_id is UNIQUE on the ledger, so a reopened request could never
 * be auto-dispatched again, and an OPEN request with an auto-orderable vendor
 * gets no manual bell either (the sweep leaves it to the dispatcher), so it
 * would sit silently unworked (pre-push P1). Cancelled, the next low-stock
 * sweep raises a fresh request the dispatcher can claim (the revoked order is
 * excluded from the prior-order guard), or the office orders by hand. A
 * received request whose order landed after that receipt stays received: its
 * stock was counted.
 */
const db = require('../../models/db');
const { auditVendorOrder } = require('../audit-log');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseEvidence = (raw) => (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : raw) || {};

function refusal(code, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode: 409, code, isOperational: true, ...extra });
}

// What the tab pins: the ledger row's last write. Any write since (a late
// placement, a re-rung bell, a park) makes the operator's decision stale.
const versionOf = (row) => (row && row.updated_at ? new Date(row.updated_at).toISOString() : null);

// Whether this ledger row is a dispatched order an operator may revoke now.
// null when it is, else { code, message, inFlight } (inFlight = the dispatcher
// still owns the row; the CLI exits 1 on it).
function revokeBlocker(row) {
  const evidence = parseEvidence(row.evidence);
  if (evidence.revokedAt) return { code: 'already_revoked', message: `Already revoked at ${evidence.revokedAt} — nothing to do.` };
  // A needs_review row is revocable only when its vendor call was DISPATCHED
  // (placed_at set). Recording the revoke is what lets the office cancel the
  // request; a pre-submit park (nothing sent) needs no revoke and its request
  // cancels freely.
  if (row.status === 'needs_review' && !row.placed_at) return { code: 'not_dispatched', message: 'needs_review with nothing dispatched — no vendor order to revoke; cancel the request on the Restock tab.' };
  if (row.status === 'failed') return { code: 'not_dispatched', message: 'Row is failed (nothing was ordered) — revoke does not apply.' };
  // The vendor call may be in flight: reopening the request now would let
  // staff order while the dispatcher still lands the original (double
  // purchase). The dispatcher itself resolves a placing row — revoke only
  // after it has.
  if (row.status === 'placing') return { code: 'placing', inFlight: true, message: 'Row is still placing — the dispatcher owns it until it resolves; re-run once it is placed or needs_review.' };
  return null;
}

// The locked ledger row must still be a dispatched order, not already
// revoked, and unchanged since the operator READ it — a late placement (order
// number, total, latePlacementAt, or any write at all) makes the decision
// stale: re-read and decide again (Codex r4 P1). Throws the reason.
function assertRevocableLocked(locked, row) {
  if (!locked || !(locked.status === 'placed' || (locked.status === 'needs_review' && locked.placed_at))) throw refusal('not_dispatched', `ledger row is ${locked?.status || 'missing'} — not a dispatched order; re-run`);
  const lockedEvidence = parseEvidence(locked.evidence);
  if (lockedEvidence.revokedAt) throw refusal('already_revoked', `ledger row was revoked at ${lockedEvidence.revokedAt} by a concurrent run — nothing to do`);
  const same = (a, b) => String(a ?? '') === String(b ?? '');
  const changed = !same(locked.external_order_number, row.external_order_number) || !same(locked.amount_cents, row.amount_cents)
    || !same(lockedEvidence.latePlacementAt, parseEvidence(row.evidence).latePlacementAt) || !same(versionOf(locked), versionOf(row));
  if (changed) throw refusal('order_changed', `ledger row changed since you read it (now ${locked.status}, #${locked.external_order_number || '—'} $${(Number(locked.amount_cents || 0) / 100).toFixed(2)}${lockedEvidence.latePlacementAt ? `, order confirmed late at ${lockedEvidence.latePlacementAt}` : ''}) — re-run to decide on the current facts`);
}

// The locked request must still be in flight — open or ordered — BEFORE the
// ledger is marked: a request received in between means the stock landed,
// so there is nothing to revoke and a revokedAt marker would falsely audit
// a vendor cancellation (Codex r18 P2). Throws the reason.
// Exception: a received request whose automatic order landed AFTER that
// receipt (ledger evidence.landedAfterReceive) — the order is still out, so
// it is revocable; the request stays received (Codex r27 P1).
function assertRequestInFlight(req, lockedEvidence) {
  if (req?.status === 'received' && lockedEvidence.landedAfterReceive) return;
  if (!req || !new Set(['open', 'ordered']).has(req.status)) {
    throw refusal('request_not_in_flight', `restock request is ${req?.status || 'missing'} — ${req?.status === 'received' ? 'the stock was received; nothing to revoke' : 'not an order in flight'}`, { requestStatus: req?.status || null });
  }
}

// The revoke itself: ledger → needs_review with the evidence.revokedAt
// marker, request open/ordered → cancelled, critical audit row. Eligibility
// AND idempotency are re-checked on the LOCKED rows (two runs that both
// passed the unlocked check must not double-revoke, Codex r2 P2); LOCK ORDER
// ledger → request, the dispatcher's. `row` is the operator's read of the
// ledger row (vo.* plus vendor_id/adapter). Returns the request's status after.
async function revokeOrder(row, { actorType = 'system', actorId = null } = {}) {
  return db.transaction(async (trx) => {
    const locked = await trx('vendor_orders').where({ id: row.id }).forUpdate().first('status', 'placed_at', 'evidence', 'external_order_number', 'amount_cents', 'updated_at');
    assertRevocableLocked(locked, row);
    const req = await trx('product_restock_requests').where({ id: row.restock_request_id }).forUpdate().first('status', 'metadata');
    assertRequestInFlight(req, parseEvidence(locked.evidence));
    const revokedAt = new Date().toISOString();
    // The row's reconciliation bell ("cancel with the vendor or record the
    // revoke") is now obsolete: close the notification done and strip the
    // persisted bell so reringPendingBells never re-sends it (Codex r22 P2).
    await trx('vendor_orders').where({ id: row.id }).update({
      status: 'needs_review',
      error: `revoked: operator revoke ${revokedAt} (was ${locked.status})`.slice(0, 400),
      evidence: trx.raw("(COALESCE(evidence, '{}'::jsonb) - 'bell' - 'bellAt' - 'landedAfterReceive') || ?::jsonb", [JSON.stringify({ revokedAt })]),
      updated_at: new Date(),
    });
    await require('./order-dispatch').retireLedgerBells(trx, row.id, 'The vendor cancellation of this order was recorded');
    // Cancelled, not reopened (see the header). A received request stays
    // received — its stock was counted.
    if (req.status !== 'received') await trx('product_restock_requests').where({ id: row.restock_request_id }).update({
      status: 'cancelled',
      closed_at: new Date(),
      metadata: JSON.stringify({ ...parseEvidence(req.metadata), autoOrderCancelled: 'revoked_vendor_order', autoOrderCancelledAt: revokedAt, revokedVendorOrderId: row.id }),
      updated_at: new Date(),
    });
    await auditVendorOrder({ vendor_order_id: row.id, restock_request_id: row.restock_request_id, vendor_id: row.vendor_id, adapter: row.adapter, outcome: 'revoked', amount_cents: row.amount_cents, external_order_number: row.external_order_number, reason: `operator revoke (was ${locked.status})`, actor_type: actorType, actor_id: actorId, trx });
    return { requestStatus: req.status === 'received' ? 'received' : 'cancelled' };
  });
}

// The Restock tab's wording for each refusal (the CLI keeps its own).
const TAB_MESSAGES = {
  already_revoked: () => 'This order\'s vendor cancellation is already recorded. Reload the Restock tab.',
  not_dispatched: () => 'This request has no automatic order out to cancel. Reload the Restock tab.',
  placing: () => 'This order is still being placed. Wait until the Restock tab shows it placed or needing review, then try again.',
  order_changed: () => 'This order changed after the Restock tab loaded. Reload it and check the order again.',
  request_not_in_flight: (err) => (err.requestStatus === 'received'
    ? 'The stock for this request was already received, so there is no order out to cancel. Reload the Restock tab.'
    : `This request is ${err.requestStatus || 'gone'}, so there is no order out to cancel. Reload the Restock tab.`),
};
const forTab = (err) => (err && TAB_MESSAGES[err.code] ? refusal(err.code, TAB_MESSAGES[err.code](err)) : err);

/**
 * The Restock tab's action. `orderId` and `version` are the ledger row the tab
 * showed (restock queue `order.id` / `order.version`): a different or changed
 * row is refused (409 order_changed) before anything is written, and the
 * locked re-check in revokeOrder closes the window after this read. The route
 * checks the operator's "vendor cancelled it" confirmation before calling.
 */
async function recordVendorCancellation(requestId, { orderId, version, actorId = null } = {}) {
  if (!UUID_RE.test(String(requestId || '')) || !UUID_RE.test(String(orderId || '')) || !version) {
    throw Object.assign(new Error('The order to cancel is missing. Reload the Restock tab and try again.'), { statusCode: 400, code: 'bad_request', isOperational: true });
  }
  const row = await db('vendor_orders').where({ id: orderId, restock_request_id: requestId }).first();
  if (!row || versionOf(row) !== String(version)) throw forTab(refusal('order_changed', 'order changed'));
  const blocker = revokeBlocker(row);
  if (blocker) throw forTab(refusal(blocker.code, blocker.message));
  try {
    return await revokeOrder(row, { actorType: 'technician', actorId });
  } catch (err) {
    throw forTab(err);
  }
}

module.exports = {
  parseEvidence,
  versionOf,
  revokeBlocker,
  assertRevocableLocked,
  assertRequestInFlight,
  revokeOrder,
  recordVendorCancellation,
};
