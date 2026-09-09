/** Shared restock queue and provider-state projection. Owner spend remains server-selected. */
const db = require('../models/db');

function restockMeta(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

async function listRestockRequests({ status = 'active', limit = 100, showSpend = false, requestId, productId } = {}) {
    if (requestId && require('joi').string().guid().validate(requestId).error) throw Object.assign(new Error('Invalid restock request id'), { statusCode: 400, isOperational: true });
    if (productId && require('joi').string().guid().validate(productId).error) throw Object.assign(new Error('Invalid product id'), { statusCode: 400, isOperational: true });
    if (!(await db.schema.hasTable('product_restock_requests'))) {
      return { requests: [] };
    }
    status = String(status).toLowerCase();
    if (!['open', 'ordered', 'active', 'received', 'cancelled', 'all'].includes(status)) throw Object.assign(new Error('Invalid request status'), { statusCode: 400, isOperational: true });
    // vendor_orders (PR 2 ledger) is one row per request at most; absent
    // table (older schema) → no order columns.
    const hasOrders = await db.schema.hasTable('vendor_orders');
    let query = db('product_restock_requests as prr')
      .leftJoin('products_catalog as pc', 'prr.product_id', 'pc.id')
      .leftJoin('scheduled_services as ss', 'prr.scheduled_service_id', 'ss.id')
      .leftJoin('customers as c', 'prr.customer_id', 'c.id')
      .select(
        'prr.*',
        'pc.name as product_name',
        'pc.category as product_category',
        'pc.inventory_on_hand',
        'pc.inventory_unit',
        'pc.best_vendor',
        'ss.scheduled_date',
        'ss.service_type',
        'c.first_name',
        'c.last_name',
        'c.address_line1',
        'c.city',
        ...(hasOrders ? ['vo.status as order_status', 'vo.external_order_number as order_number', 'vo.amount_cents as order_amount_cents', 'vo.error as order_error', 'vo.placed_at as order_placed_at', 'vo.adapter as order_adapter', db.raw("vo.evidence->>'revokedAt' as order_revoked_at"), db.raw("vo.evidence->>'landedAfterReceive' as order_landed_after_receive"), db.raw("vo.request_payload->>'orderedQuantity' as order_ordered_quantity")] : []),
      )
      .modify((q) => { if (hasOrders) q.leftJoin('vendor_orders as vo', 'vo.restock_request_id', 'prr.id'); })
      .orderByRaw("case prr.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end")
      .orderByRaw('prr.needed_by asc nulls last')
      .orderBy('prr.created_at', 'desc')
      .limit(Math.max(1, Math.min(200, Number(limit) || 100)));
    // Active includes a received request whose automatic order landed after
    // that receipt (evidence.landedAfterReceive): it still needs the second
    // Receive or a revoke, and its bell links here (Codex r29 P2).
    if (status === 'active' && hasOrders) query = query.where((q) => q.whereIn('prr.status', ['open', 'ordered']).orWhereRaw("(prr.status = 'received' AND NULLIF(vo.evidence->>'landedAfterReceive', '') IS NOT NULL)"));
    else if (status !== 'all') query = query.whereIn('prr.status', status === 'active' ? ['open', 'ordered'] : [status]);
    if (requestId) query = query.where('prr.id', requestId);
    if (productId) query = query.where('prr.product_id', productId);
    const rows = await query;
    // Technicians see the order outcome (placed / needs review), never the
    // spend: a single-product order total IS the unit cost — owner-only,
    // like every other cost field on this router (Codex r1 P2).
    return {
      requests: rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        productCategory: row.product_category,
        status: row.status,
        priority: row.priority,
        requestedQuantity: row.requested_quantity != null ? Number(row.requested_quantity) : null,
        unit: row.unit,
        currentStock: row.current_stock != null ? Number(row.current_stock) : null,
        liveStock: row.inventory_on_hand != null ? Number(row.inventory_on_hand) : null,
        inventoryUnit: row.inventory_unit,
        targetStock: row.target_stock != null ? Number(row.target_stock) : null,
        vendor: row.vendor || row.best_vendor || null,
        // Auto-reorder requests carry the vendor SKU + product URL in
        // metadata; the tab renders them as the order link (Codex r3 P2).
        vendorSku: restockMeta(row.metadata).vendorSku || null,
        vendorProductUrl: restockMeta(row.metadata).vendorProductUrl || null,
        // Automatic order outcome (null = never dispatched): placing | placed
        // | failed | needs_review, with the vendor number, total and the
        // parked reason so the tab explains why a request still needs a hand.
        order: hasOrders ? restockOrderView(row, showSpend) : null,
        neededBy: row.needed_by,
        reason: row.reason,
        source: row.source,
        scheduledServiceId: row.scheduled_service_id,
        scheduledDate: row.scheduled_date,
        serviceType: row.service_type,
        customerName: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null,
        address: row.address_line1,
        city: row.city,
        createdByName: row.created_by_name,
        createdAt: row.created_at,
      })),
    };
}

function restockOrderView(row, showSpend) {
  if (!row.order_status) return null;
  return {
    status: row.order_status,
    adapter: row.order_adapter,
    externalOrderNumber: row.order_number || null,
    amountCents: showSpend && row.order_amount_cents != null ? Number(row.order_amount_cents) : null,
    // The parked message can quote the total (cap wording): techs get the
    // reason code only.
    error: !row.order_error ? null : showSpend ? row.order_error : String(row.order_error).split(':')[0],
    placedAt: row.order_placed_at || null,
    revokedAt: row.order_revoked_at || null,
    // What the order actually bought, in the request's unit (packages round
    // up) — the tab's receive default; a revoked order is not what arrives.
    orderedQuantity: row.order_placed_at && !row.order_revoked_at && row.order_ordered_quantity != null ? Number(row.order_ordered_quantity) : null,
    // The order landed after the request was received by hand: the tab
    // offers one more receive (the late order's own) on the received row.
    landedAfterReceive: !!row.order_landed_after_receive,
  };
}

module.exports = { listRestockRequests, restockMeta };
