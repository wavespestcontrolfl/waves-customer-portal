#!/usr/bin/env node
// MUTATES (dry-run default) — revoke ONE automatic vendor order
// (server/services/procurement/order-dispatch.js). The rules and the write
// live in server/services/procurement/order-revoke.js, shared with the
// Restock tab's "Record vendor cancellation" (owner-only): the vendor_orders ledger
// row (status `placed` ONLY — a `placing` row is still the dispatcher's, and
// reopening its request would race the in-flight vendor call into a double
// purchase) goes to needs_review and its restock request is CANCELLED
// (reason revoked_vendor_order), with a critical audit row. Nothing is sent
// to the vendor — cancelling with Sticker Mule / SiteOne stays manual
// (Sticker Mule has no cancel endpoint). Because restock_request_id is
// UNIQUE on the ledger, the revoked request could never be auto-dispatched
// again — and an OPEN request the sweep sees with an auto-orderable vendor
// gets no manual bell either (the sweep leaves it to the dispatcher), so
// reopening it would leave it silently unworked (pre-push P1). Cancelling
// it instead lets the next 6:10 sweep raise a fresh request while stock is
// still low, which the dispatcher can claim (the revoked order is excluded
// from the prior-order guard) — or the office orders by hand from the
// Restock tab. Idempotent: a row already needs_review is reported, not
// rewritten.
//
//   railway run --service Postgres node ops/agents/auto-order-revoke.js --order=<vendor_orders.id>            # dry run
//   railway run --service Postgres node ops/agents/auto-order-revoke.js --order=<vendor_orders.id> --cancelled-with-vendor --execute   # after the vendor has cancelled the order
//   railway run --service Postgres node ops/agents/auto-order-revoke.js --list                                # every unreconciled dispatched row, all months: placed + post-submit needs_review (placing shown, not revocable)
//
// Run from the repo root (resolves the server's modules). Output carries ids,
// vendor names and amounts only.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/auto-order-revoke.js …');
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { RECEIVED_SETTLES_SQL } = require(path.join(__dirname, '..', '..', 'server', 'services', 'procurement', 'order-dispatch'));
const { revokeBlocker, revokeOrder } = require(path.join(__dirname, '..', '..', 'server', 'services', 'procurement', 'order-revoke'));

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const EXECUTE = process.argv.includes('--execute');
// The revoke marker re-enables request cancel + replacement ordering, so it
// must only ever be written AFTER the vendor order is cancelled with the
// vendor — the operator confirms that explicitly (Codex r14 P1).
const CANCELLED_WITH_VENDOR = process.argv.includes('--cancelled-with-vendor');
const LIST = process.argv.includes('--list');
const orderId = arg('order');
const dollars = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

// --list: every automatic order whose vendor call was dispatched or is in
// flight and whose request is not yet received — placing (shown, not
// revocable), placed, and post-submit needs_review rows (placed_at set:
// "may or may not have gone out"), which are precisely the ones an operator
// must reconcile (Codex r2 P2). No month filter: an order outstanding across
// an ET month boundary still needs its ledger id here (Codex r12 P2). A row
// already revoked (evidence.revokedAt) is reconciled — its request is
// cancelled, not received — and stays off the list (Codex r23 P2); a late
// placement strips the marker and puts it back. A received request settles
// its row unless the order landed after that receipt (evidence
// .landedAfterReceive): that one is listed, it is what the operator must
// reconcile (hook r27 P1).
async function listDispatched() {
  const rows = await db('vendor_orders as vo')
    .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
    .leftJoin('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .whereRaw("(vo.status IN ('placing', 'placed') OR (vo.status = 'needs_review' AND vo.placed_at IS NOT NULL))")
    .whereRaw(RECEIVED_SETTLES_SQL)
    .whereRaw("NULLIF(vo.evidence->>'revokedAt', '') IS NULL")
    .orderBy('vo.created_at', 'desc')
    .select('vo.id', 'vo.status', 'vo.amount_cents', 'vo.external_order_number', 'vo.placed_at', 'v.name as vendor', 'pc.name as product', 'prr.status as request_status');
  if (!rows.length) console.log('No unreconciled dispatched automatic orders.');
  for (const r of rows) {
    console.log(`${r.id}  ${r.status.padEnd(12)} ${(r.vendor || '?').padEnd(14)} ${dollars(r.amount_cents).padStart(9)}  #${r.external_order_number || '—'}  ${r.product || '?'}  (request ${r.request_status})`);
  }
}

// The eligibility checks, the locked re-checks and the revoke transaction are
// server/services/procurement/order-revoke.js (revokeBlocker, revokeOrder).

(async () => {
  try {
    if (LIST) { await listDispatched(); process.exit(0); }
    if (!orderId) { console.error('--order=<vendor_orders.id> (or --list) is required'); process.exit(2); }

    const row = await db('vendor_orders as vo')
      .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
      .leftJoin('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
      .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
      .where('vo.id', orderId)
      .first('vo.*', 'v.name as vendor', 'pc.name as product', 'prr.status as request_status');
    if (!row) { console.error(`vendor_orders ${orderId} not found`); process.exit(1); }
    console.log(`Ledger ${row.id}: ${row.status}, ${row.vendor || '?'} #${row.external_order_number || '—'} ${dollars(row.amount_cents)} for ${row.product || '?'}; request ${row.restock_request_id} is ${row.request_status}`);
    const blocker = revokeBlocker(row);
    if (blocker && blocker.inFlight) { console.error(blocker.message); process.exit(1); }
    if (blocker) { console.log(blocker.message); process.exit(0); }

    console.log(`Would set ledger → needs_review, request ${row.request_status} → cancelled (revoked_vendor_order), stamp evidence.revokedAt, write audit row procurement.vendor_order.revoked.`);
    console.log(`FIRST cancel order #${row.external_order_number || '?'} with ${row.vendor || 'the vendor'} by hand. Recording the revoke clears the way for a replacement order (the next sweep raises a fresh request), so it must follow the vendor cancellation, never precede it.`);
    if (!EXECUTE) { console.log('Dry run. Once the vendor has cancelled it, re-run with --execute --cancelled-with-vendor to apply.'); process.exit(0); }
    if (!CANCELLED_WITH_VENDOR) { console.error('Refusing: --execute needs --cancelled-with-vendor, your confirmation that the vendor order is already cancelled.'); process.exit(2); }
    await revokeOrder(row, { actorType: 'system' }); // no technicians.id to carry: the CLI is a system actor (Codex r22 P2)
    console.log('Revoked: ledger needs_review, request cancelled — the next low-stock sweep raises a fresh request (or order by hand from the Restock tab).');
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
