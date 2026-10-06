const { recordAuditEvent } = require('./audit-log');

/**
 * The audit_log row for a STAFF removal of a saved payment method, written by
 * both staff surfaces: DELETE /api/admin/customers/:id/payment-methods/:methodId
 * and the Intelligence Bar's remove_saved_payment_method. Call it only for a
 * removal that happened (removePaymentMethod resolved a removedMethod). The
 * detach is already final at Stripe, so callers treat a lost audit row as
 * non-fatal. `extraMetadata` lets a surface mark itself (the bar adds `via`).
 */
function auditStaffPaymentMethodRemoval({ actorId, ip = null, userAgent = null, customerId, removedMethod, extraMetadata = {} }) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: actorId || null,
    action: 'customer.payment_method.remove',
    resource_type: 'customer',
    resource_id: customerId,
    metadata: {
      paymentMethodId: removedMethod.id,
      methodType: removedMethod.method_type || null,
      brand: removedMethod.card_brand || removedMethod.bank_name || null,
      lastFour: removedMethod.last_four || removedMethod.bank_last_four || null,
      ...extraMetadata,
    },
    ip_address: ip,
    user_agent: userAgent,
    critical: false,
    trx: null,
  });
}

module.exports = { auditStaffPaymentMethodRemoval };
