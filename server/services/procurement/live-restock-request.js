/**
 * procurement/live-restock-request.js — THE any-source live-request check
 * every restock creator runs after taking the product row lock.
 *
 * A live request is one in 'open' or 'ordered' for the product, whatever
 * raised it (staff readiness route, forecast route, Intelligence Bar tool,
 * auto-reorder sweep). The product row lock serializes the writers; this
 * read, run UNDER that lock, is what stops the writer that resumes after a
 * concurrent commit from raising a second live request — a manual request
 * and its automatic twin (Codex r8 P1, r9 P1). Oldest first, so the row a
 * caller hands back is the one the Restock queue already shows.
 */
const LIVE_RESTOCK_STATUSES = ['open', 'ordered'];

async function findLiveRestockRequest(conn, productId) {
  return conn('product_restock_requests')
    .where({ product_id: productId })
    .whereIn('status', LIVE_RESTOCK_STATUSES)
    .orderBy('created_at', 'asc')
    .first();
}

module.exports = { findLiveRestockRequest, LIVE_RESTOCK_STATUSES };
