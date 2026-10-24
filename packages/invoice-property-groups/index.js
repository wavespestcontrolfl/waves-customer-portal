'use strict';

/**
 * @waves/invoice-property-groups
 *
 * An invoice line item may name the saved property it was performed at:
 *   property_id       — customer_properties.id (opaque, non-bearer)
 *   property_address  — { address_line1, address_line2, city, state, zip },
 *                       frozen from that property when the invoice is written
 *                       (the same historical-presentation rule as
 *                       invoices.customer_address_snapshot).
 *
 * When an invoice's service lines span MORE THAN ONE property, the customer
 * documents (pay page, receipt page, PDF) group the lines under each
 * property's address, with that property's line-item discounts and a
 * per-property subtotal. Every other invoice renders as a flat list, so this
 * module answers `null` for it.
 *
 * Pure CommonJS shared by server and client so the two cannot drift.
 */

const PROPERTY_ADDRESS_FIELDS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];

function clean(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function lineAmount(item) {
  const amount = Number(item?.amount ?? ((Number(item?.quantity) || 1) * (Number(item?.unit_price) || 0)));
  return Number.isFinite(amount) ? amount : 0;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Same rule the pay page, receipt page and PDF already use to hide discount rows. */
function isDiscountLine(item) {
  return item?._kind === 'discount' || !!item?.discount_for || lineAmount(item) < 0;
}

function parseLineItems(lineItems) {
  let items = lineItems;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  return Array.isArray(items) ? items : [];
}

/** The five address fields of a property row, null where missing. */
function propertyAddressSnapshot(row) {
  return Object.fromEntries(PROPERTY_ADDRESS_FIELDS.map((field) => [field, clean(row?.[field]) || null]));
}

/** "1842 Palm Harbor Dr Unit 2" — street line(s) only; '' without a street. */
function propertyStreetLine(address) {
  const line1 = clean(address?.address_line1);
  if (!line1) return '';
  return [line1, clean(address?.address_line2)].filter(Boolean).join(' ');
}

/** "Bradenton, FL 34209" — '' when nothing is known. */
function propertyCityStateZip(address) {
  const city = clean(address?.city);
  const stateZip = [clean(address?.state), clean(address?.zip)].filter(Boolean).join(' ');
  return [city, stateZip].filter(Boolean).join(', ');
}

/** "1842 Palm Harbor Dr, Bradenton, FL 34209" — '' without a street line. */
function propertyAddressLabel(address) {
  const street = propertyStreetLine(address);
  if (!street) return '';
  return [street, propertyCityStateZip(address)].filter(Boolean).join(', ');
}

/**
 * Groups for a multi-property invoice, in first-appearance order, or null
 * when the invoice should render as a flat list: no service lines, a service
 * line without a property, or every line at one property.
 *
 * Each group: { property_id, address, label, lines, discounts, subtotal }.
 * `discounts` are the line-item discount rows whose `discount_for` names a
 * service line in the group. Document-wide discounts (no `discount_for`)
 * belong to the invoice totals, never to a group.
 */
function groupInvoiceLinesByProperty(lineItems) {
  const items = parseLineItems(lineItems);
  const services = items.filter((item) => !isDiscountLine(item));
  if (!services.length || services.some((item) => !clean(item.property_id))) return null;

  const groups = [];
  const byProperty = new Map();
  for (const line of services) {
    const key = clean(line.property_id);
    let group = byProperty.get(key);
    if (!group) {
      const address = line.property_address && typeof line.property_address === 'object'
        ? propertyAddressSnapshot(line.property_address)
        : null;
      group = {
        property_id: key,
        address,
        label: propertyAddressLabel(address) || 'Service property',
        lines: [],
        discounts: [],
        subtotal: 0,
        clientIds: new Set(),
      };
      byProperty.set(key, group);
      groups.push(group);
    }
    group.lines.push(line);
    if (line.client_id) group.clientIds.add(String(line.client_id));
  }
  if (groups.length < 2) return null;

  for (const item of items) {
    if (!isDiscountLine(item) || !item.discount_for) continue;
    const parent = groups.find((group) => group.clientIds.has(String(item.discount_for)));
    if (parent) parent.discounts.push(item);
  }

  return groups.map(({ clientIds, ...group }) => ({
    ...group,
    subtotal: roundMoney(
      group.lines.reduce((sum, line) => sum + lineAmount(line), 0)
      + group.discounts.reduce((sum, line) => sum + lineAmount(line), 0),
    ),
  }));
}

/** Distinct property address labels across a multi-property invoice; [] for a flat invoice. */
function invoicePropertyLabels(lineItems) {
  const groups = groupInvoiceLinesByProperty(lineItems);
  return groups ? groups.map((group) => group.label) : [];
}

module.exports = {
  PROPERTY_ADDRESS_FIELDS,
  lineAmount,
  isDiscountLine,
  parseLineItems,
  propertyAddressSnapshot,
  propertyStreetLine,
  propertyCityStateZip,
  propertyAddressLabel,
  groupInvoiceLinesByProperty,
  invoicePropertyLabels,
};
