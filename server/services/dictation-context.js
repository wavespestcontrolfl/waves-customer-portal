/**
 * The ids a staff mic may steer its word list with, checked once for both audio paths:
 * the recorded clip (routes/tech-dictation.js) and the live words (services/dictation-live.js).
 *
 * A technician's customer and visit ids must belong to them (their assigned visit, or a customer they
 * have a current visit for: services/technician-visit-scope.js). An id that fails is DROPPED, never a
 * 403: the mic keeps working for a visit that was just reassigned, and nothing says whether a customer
 * or visit exists. Administrators are unrestricted.
 *
 * `actor` is anything carrying { techRole, technicianId }: an Express request, or a staff socket's
 * { techRole: socket.userType, technicianId: socket.userId }.
 */
const db = require('../models/db');
const { UUID_RE } = require('./dictation-word-list');
const { isTechnicianRequest, technicianServicesCustomer, technicianVisitRowInScope } = require('./technician-visit-scope');

const uuidOrNull = (value) => (UUID_RE.test(String(value || '')) ? String(value) : null);

/** { customerId, serviceId } with every id that is not a UUID, or not in the actor's scope, set to null. */
async function fenceDictationContext(actor, ids = {}) {
  let customerId = uuidOrNull(ids.customerId);
  let serviceId = uuidOrNull(ids.serviceId);
  if (isTechnicianRequest(actor)) {
    if (serviceId) {
      const svc = await db('scheduled_services').where({ id: serviceId }).first('id', 'technician_id', 'status', 'scheduled_date');
      if (!svc || !technicianVisitRowInScope(actor, svc)) serviceId = null;
    }
    if (customerId && !(await technicianServicesCustomer(actor, customerId))) customerId = null;
  }
  return { customerId, serviceId };
}

module.exports = { fenceDictationContext, uuidOrNull };
