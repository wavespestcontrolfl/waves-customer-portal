/**
 * Property links on invoice line items (multi-property invoices).
 *
 * A service line may carry `property_id` (a saved customer_properties row of
 * the invoice's customer). At every write — create and line-item edit — this
 * module checks that each named property belongs to the customer and freezes
 * the property's address onto the line as `property_address`, so the
 * documents stay historical if the property is later edited or removed.
 * Discount rows inherit the property of the service line they belong to.
 *
 * Rendering is data-driven (@waves/invoice-property-groups): lines without a
 * property, or all at one property, render exactly as before.
 */

const {
  PROPERTY_ADDRESS_FIELDS, isDiscountLine, propertyAddressSnapshot,
} = require('@waves/invoice-property-groups');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function linePropertyError(message) {
  return Object.assign(new Error(message), {
    status: 400, statusCode: 400, isOperational: true, code: 'invalid_line_property',
  });
}

function cleanPropertyId(value) {
  const id = String(value ?? '').trim();
  return id ? id : null;
}

/**
 * Validates and snapshots the property links on `items` (already normalized
 * line items). Returns a new array; throws a 400 when a property is not the
 * customer's. Lines that name no property lose any stale `property_address`.
 */
async function attachInvoiceLineProperties(conn, customerId, items = []) {
  const services = items.filter((item) => !isDiscountLine(item));
  const wanted = [...new Set(services.map((item) => cleanPropertyId(item.property_id)).filter(Boolean))];
  if (wanted.some((id) => !UUID_RE.test(id))) {
    throw linePropertyError('A line item names an invalid property.');
  }

  const snapshots = new Map();
  if (wanted.length) {
    if (!customerId) throw linePropertyError('A line item names a property but the invoice has no customer.');
    const rows = await conn('customer_properties')
      .where({ customer_id: customerId })
      .whereIn('id', wanted)
      .select('id', ...PROPERTY_ADDRESS_FIELDS);
    for (const row of rows) snapshots.set(String(row.id), propertyAddressSnapshot(row));
    const missing = wanted.filter((id) => !snapshots.has(id));
    if (missing.length) {
      throw linePropertyError('A line item names a property that is not saved on this customer.');
    }
  }

  const parentByClientId = new Map();
  const stamped = items.map((item) => {
    if (isDiscountLine(item)) return item;
    const { property_address: _stale, ...rest } = item;
    const propertyId = cleanPropertyId(item.property_id);
    const next = propertyId
      ? { ...rest, property_id: propertyId, property_address: snapshots.get(propertyId) }
      : (() => { const { property_id: _none, ...bare } = rest; return bare; })();
    if (next.client_id) parentByClientId.set(String(next.client_id), next);
    return next;
  });

  // Discount rows take their parent line's property so a grouped document can
  // place each discount under the house it applies to.
  return stamped.map((item) => {
    if (!isDiscountLine(item)) return item;
    const { property_id: _pid, property_address: _addr, ...rest } = item;
    const parent = item.discount_for ? parentByClientId.get(String(item.discount_for)) : null;
    if (!parent || !parent.property_id) return rest;
    return { ...rest, property_id: parent.property_id, property_address: parent.property_address };
  });
}

module.exports = { attachInvoiceLineProperties, linePropertyError, _private: { UUID_RE } };
