const db = require('../models/db');

function coordinatesOf(row) {
  const values = [row?.latitude, row?.longitude];
  if (values.some((value) => value == null || typeof value === 'boolean' || String(value).trim() === '')) return null;
  const [latitude, longitude] = values.map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

// A saved house owns its entire coordinate pair. Missing/foreign property
// rows must never inherit the customer's primary address. Historical
// assessments may reference a retired property, so ownership is the filter.
async function resolvePropertyCoordinates(customerId, propertyId, { knex = db, customer } = {}) {
  if (!customerId) return null;
  if (propertyId != null) {
    const property = await knex('customer_properties')
      .where({ id: propertyId, customer_id: customerId })
      .first('latitude', 'longitude');
    return coordinatesOf(property);
  }
  const row = customer && String(customer.id) === String(customerId)
    ? customer
    : await knex('customers').where({ id: customerId }).first('latitude', 'longitude');
  return coordinatesOf(row);
}

module.exports = { coordinatesOf, resolvePropertyCoordinates };
