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
//   railway run --service Postgres node ops/agents/auto-order-revoke.js --list                                # dispatched rows this month: placed + post-submit needs_review (placing shown, not revocable)
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

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const EXECUTE = process.argv.includes('--execute');
const LIST = process.argv.includes('--list');
const orderId = arg('order');
const dollars = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

const parseEvidence = (raw) => (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : raw) || {};

// --list: every automatic order whose vendor call was dispatched or is in
// flight and whose request is not yet received — placing (shown, not
// revocable), placed, and post-submit needs_review rows (placed_at set:
// "may or may not have gone out"), which are precisely the ones an operator
// must reconcile (Codex r2 P2). No month filter: an order outstanding across
// an ET month boundary still needs its ledger id here (Codex r12 P2).
async function listDispatched() {
  const rows = await db('vendor_orders as vo')
    .leftJoin('vendors as v', 'v.id', 'vo.vendor_id')
    .leftJoin('product_restock_requests as prr', 'prr.id', 'vo.restock_request_id')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .whereRaw("(vo.status IN ('placing', 'placed') OR (vo.status = 'needs_review' AND vo.placed_at IS NOT NULL))")
    .whereNot('prr.status', 'received')
    .orderBy('vo.created_at', 'desc')
    .select('vo.id', 'vo.status', 'vo.amount_cents', 'vo.external_order_number', 'vo.placed_at', 'vo.evidence', 'v.name as vendor', 'pc.name as product', 'prr.status as request_status');
  if (!rows.length) console.log('No unreconciled dispatched automatic orders.');
  for (const r of rows) {
    const revoked = parseEvidence(r.evidence).revokedAt ? '  REVOKED' : '';
    console.log(`${r.id}  ${r.status.padEnd(12)} ${(r.vendor || '?').padEnd(14)} ${dollars(r.amount_cents).padStart(9)}  #${r.external_order_number || '—'}  ${r.product || '?'}  (request ${r.request_status})${revoked}`);
  }
}

// Whether this ledger row is a dispatched order an operator may revoke now.
// Returns null when it is, else the message to print (exit 0) or an Error
// (exit 1) for a row the dispatcher still owns.
function revokeBlocker(row) {
  const evidence = parseEvidence(row.evidence);
  if (evidence.revokedAt) return `Already revoked at ${evidence.revokedAt} — nothing to do.`;
  // A needs_review row is revocable only when its vendor call was DISPATCHED
  // (placed_at set). Recording the revoke is what lets the office cancel the
  // request; a pre-submit park (nothing sent) needs no revoke and its request
  // cancels freely.
  if (row.status === 'needs_review' && !row.placed_at) return 'needs_review with nothing dispatched — no vendor order to revoke; cancel the request on the Restock tab.';
  if (row.status === 'failed') return 'Row is failed (nothing was ordered) — revoke does not apply.';
  // The vendor call may be in flight: reopening the request now would let
  // staff order while the dispatcher still lands the original (double
  // purchase). The dispatcher itself resolves a placing row — revoke only
  // after it has.
  if (row.status === 'placing') return new Error('Row is still placing — the dispatcher owns it until it resolves; re-run once it is placed or needs_review.');
  return null;
}

// The revoke itself: ledger → needs_review with the STRUCTURED
// evidence.revokedAt marker the cancel guard and the dispatcher's prior-order
// belt read (order-dispatch.js), request ordered → open, critical audit row.
// Eligibility AND idempotency are re-checked on the LOCKED row: two --execute
// runs that both passed the unlocked check must not double-revoke (Codex r2
// P2).
async function revoke(row) {
  await db.transaction(async (trx) => {
    const locked = await trx('vendor_orders').where({ id: row.id }).forUpdate().first('status', 'placed_at', 'evidence', 'external_order_number', 'amount_cents', 'updated_at');
    if (!locked || !(locked.status === 'placed' || (locked.status === 'needs_review' && locked.placed_at))) throw new Error(`ledger row is ${locked?.status || 'missing'} — not a dispatched order; re-run`);
    const lockedEvidence = parseEvidence(locked.evidence);
    if (lockedEvidence.revokedAt) throw new Error(`ledger row was revoked at ${lockedEvidence.revokedAt} by a concurrent run — nothing to do`);
    // The operator's decision was made on the row they READ: if a late
    // placement landed in between (order number, total, latePlacementAt —
    // or any write at all), the decision is stale — re-read and decide again
    // (Codex r4 P1).
    const same = (a, b) => String(a ?? '') === String(b ?? '');
    const changed = !same(locked.external_order_number, row.external_order_number) || !same(locked.amount_cents, row.amount_cents)
      || !same(lockedEvidence.latePlacementAt, parseEvidence(row.evidence).latePlacementAt) || !same(new Date(locked.updated_at).toISOString(), new Date(row.updated_at).toISOString());
    if (changed) throw new Error(`ledger row changed since you read it (now ${locked.status}, #${locked.external_order_number || '—'} ${dollars(locked.amount_cents)}${lockedEvidence.latePlacementAt ? `, order confirmed late at ${lockedEvidence.latePlacementAt}` : ''}) — re-run to decide on the current facts`);
    const revokedAt = new Date().toISOString();
    await trx('vendor_orders').where({ id: row.id }).update({
      status: 'needs_review',
      error: `revoked: operator revoke ${revokedAt} (was ${locked.status})`.slice(0, 400),
      evidence: trx.raw("COALESCE(evidence, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ revokedAt })]),
      updated_at: new Date(),
    });
    const req = await trx('product_restock_requests').where({ id: row.restock_request_id }).forUpdate().first('status');
    if (req?.status === 'ordered') await trx('product_restock_requests').where({ id: row.restock_request_id }).update({ status: 'open', updated_at: new Date() });
    await auditVendorOrder({ vendor_order_id: row.id, restock_request_id: row.restock_request_id, vendor_id: row.vendor_id, adapter: row.adapter, outcome: 'revoked', amount_cents: row.amount_cents, external_order_number: row.external_order_number, reason: `operator revoke (was ${locked.status})`, actor_type: 'technician', trx });
  });
}

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
    if (blocker instanceof Error) { console.error(blocker.message); process.exit(1); }
    if (blocker) { console.log(blocker); process.exit(0); }

    console.log(`Would set ledger → needs_review${row.request_status === 'ordered' ? ', request → open' : ''}, stamp evidence.revokedAt, write audit row procurement.vendor_order.revoked.`);
    if (!EXECUTE) { console.log('Dry run. Re-run with --execute to apply.'); process.exit(0); }
    await revoke(row);
    console.log('Revoked. Cancel with the vendor by hand if the order shipped.');
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
