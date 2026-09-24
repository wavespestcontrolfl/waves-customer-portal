// Invoice statuses under which an annual-prepay invoice can never settle —
// the coverage authority's terminal set (annual-prepay-renewals.js reads it
// from here; admin-cancellation.js's pending-invoice guard reuses it so a
// payment_pending term left pointing at a refunded/cancelled invoice never
// blocks a cancel, churn or archive). A leaf module on purpose: the two
// consumers require each other lazily and tests mock the renewals module.
const INVOICE_CANCELLED_STATUSES = new Set(['void', 'cancelled', 'canceled', 'refunded']);

module.exports = { INVOICE_CANCELLED_STATUSES };
