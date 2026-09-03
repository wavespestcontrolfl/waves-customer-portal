#!/usr/bin/env node
// MUTATES (dry-run default) — revoke ONE automatic vendor order
// (server/services/procurement/order-dispatch.js): the vendor_orders ledger
// row (status `placed` ONLY — a `placing` row is still the dispatcher's, and
// reopening its request would race the in-flight vendor call into a double
// purchase) goes to needs_review and its restock request back to open, with
// a critical audit row, so the office re-orders by hand. Nothing is sent to
// the vendor — cancelling with Sticker Mule / SiteOne stays manual (Sticker
// Mule has no cancel endpoint). Because restock_request_id is UNIQUE on the
// ledger, the revoked request can never be auto-dispatched again; a fresh
// restock request is the way back in. Idempotent: a row already
// needs_review is reported, not rewritten.
//
//   railway run --service Postgres node ops/agents/auto-order-revoke.js --order=<vendor_orders.id>            # dry run
//   railway run --service Postgres node ops/agents/auto-order-revoke.js --order=<vendor_orders.id> --execute
//   railway run --service Postgres node ops/agents/auto-order-revoke.js --list                                # placed rows this month (placing shown, not revocable)
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
const { auditVendorOrder } = require(path.join(__dirname, '..', '..', 'server', 'services', 'audit-log'));
const { startOfETMonth } = require(path.join(__dirname, '..', '..', 'server', 'utils', 'datetime-et'));

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const EXECUTE = process.argv.includes('--execute');
const LIST = process.argv.includes('--list');
const orderId = arg('order');
const dollars = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

(async () => {
  try {
    if (LIST) {
      const rows = await db('vendor_orders as vo')
        .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
        .leftJoin('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
        .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
        .where('vo.created_at', '>=', startOfETMonth(new Date()))
        .whereIn('vo.status', ['placing', 'placed'])
        .orderBy('vo.created_at', 'desc')
        .select('vo.id', 'vo.status', 'vo.amount_cents', 'vo.external_order_number', 'vo.placed_at', 'v.name as vendor', 'pc.name as product', 'prr.status as request_status');
      if (!rows.length) console.log('No placing/placed automatic orders this month.');
      for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(12)} ${(r.vendor || '?').padEnd(14)} ${dollars(r.amount_cents).padStart(9)}  #${r.external_order_number || '—'}  ${r.product || '?'}  (request ${r.request_status})`);
      process.exit(0);
    }
    if (!orderId) { console.error('--order=<vendor_orders.id> (or --list) is required'); process.exit(2); }

    const row = await db('vendor_orders as vo')
      .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
      .leftJoin('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
      .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
      .where('vo.id', orderId)
      .first('vo.*', 'v.name as vendor', 'pc.name as product', 'prr.status as request_status');
    if (!row) { console.error(`vendor_orders ${orderId} not found`); process.exit(1); }
    console.log(`Ledger ${row.id}: ${row.status}, ${row.vendor || '?'} #${row.external_order_number || '—'} ${dollars(row.amount_cents)} for ${row.product || '?'}; request ${row.restock_request_id} is ${row.request_status}`);
    if (row.status === 'needs_review') { console.log('Already needs_review — nothing to do.'); process.exit(0); }
    if (row.status === 'failed') { console.log('Row is failed (nothing was ordered) — revoke does not apply.'); process.exit(0); }
    if (row.status === 'placing') {
      // The vendor call may be in flight: reopening the request now would let
      // staff order while the dispatcher still lands the original (double
      // purchase). The dispatcher itself resolves a placing row (placed /
      // needs_review / failed / released) — revoke only after it has.
      console.error('Row is still placing — the dispatcher owns it until it resolves; re-run once it is placed or needs_review.');
      process.exit(1);
    }

    console.log(`Would set ledger → needs_review${row.request_status === 'ordered' ? ', request → open' : ''}, write audit row procurement.vendor_order.revoked.`);
    if (!EXECUTE) { console.log('Dry run. Re-run with --execute to apply.'); process.exit(0); }

    await db.transaction(async (trx) => {
      const locked = await trx('vendor_orders').where({ id: row.id }).forUpdate().first('status');
      if (!locked || locked.status !== 'placed') throw new Error(`ledger row is ${locked?.status || 'missing'}, not placed — re-run`);
      await trx('vendor_orders').where({ id: row.id }).update({ status: 'needs_review', error: `revoked: operator revoke ${new Date().toISOString()} (was ${locked.status})`.slice(0, 400), updated_at: new Date() });
      const req = await trx('product_restock_requests').where({ id: row.restock_request_id }).forUpdate().first('status');
      if (req?.status === 'ordered') await trx('product_restock_requests').where({ id: row.restock_request_id }).update({ status: 'open', updated_at: new Date() });
      await auditVendorOrder({ vendor_order_id: row.id, restock_request_id: row.restock_request_id, vendor_id: row.vendor_id, adapter: row.adapter, outcome: 'revoked', amount_cents: row.amount_cents, external_order_number: row.external_order_number, reason: `operator revoke (was ${locked.status})`, actor_type: 'technician', trx });
    });
    console.log('Revoked. Cancel with the vendor by hand if the order shipped.');
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
