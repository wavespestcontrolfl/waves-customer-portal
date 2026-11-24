/**
 * Intelligence Bar — what a past visit's service record holds, read from the
 * columns that exist.
 * server/services/intelligence-bar/service-record-facts.js
 *
 * service_records has no `notes`, `products_used` or `technician_name` column:
 * the technician's words are `technician_notes`, the technician is
 * `technician_id` (technicians.name), and the products applied are rows in
 * `service_products` keyed by `service_record_id`. The bar's history readers
 * read the missing names for months, so every answer said "no products
 * logged" and named no technician (owner question 11-19, gap audit 11-23).
 *
 * The column lists below are exported so a Postgres suite can check each one
 * against the real schema: a renamed or dropped column fails CI there instead
 * of reading as undefined in production.
 */
const db = require('../../models/db');

const SERVICE_RECORD_COLUMNS = ['id', 'service_date', 'service_type', 'technician_id', 'technician_notes', 'labor_hours'];
const SERVICE_PRODUCT_COLUMNS = [
  'service_record_id', 'product_name', 'product_category', 'application_rate', 'rate_unit', 'total_amount', 'amount_unit',
];
const TECHNICIAN_COLUMNS = ['id', 'name'];

function amountText(value, unit) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return unit ? `${n} ${unit}` : String(n);
}

// hideUnit(unit) true drops that figure (the tech rail never shows an mL
// figure, owner ruling: nothing a technician reads is in mL).
function productLine(row, hideUnit) {
  const shown = (value, unit) => (hideUnit && unit && hideUnit(unit) ? null : amountText(value, unit));
  return {
    name: row.product_name,
    category: row.product_category || null,
    rate: shown(row.application_rate, row.rate_unit),
    amount: shown(row.total_amount, row.amount_unit),
  };
}

// The products and technician name for a set of service records, in two reads.
// Returns lookups keyed by record id / technician id.
async function loadServiceRecordFacts(records, { hideUnit = null } = {}) {
  const ids = [...new Set((records || []).map((r) => r && r.id).filter(Boolean).map(String))];
  const techIds = [...new Set((records || []).map((r) => r && r.technician_id).filter(Boolean).map(String))];
  const [products, techs] = await Promise.all([
    ids.length
      ? db('service_products').whereIn('service_record_id', ids).select(SERVICE_PRODUCT_COLUMNS).orderBy('created_at', 'asc')
      : [],
    techIds.length ? db('technicians').whereIn('id', techIds).select(TECHNICIAN_COLUMNS) : [],
  ]);
  const productsByRecord = new Map();
  for (const row of products || []) {
    const key = String(row.service_record_id);
    if (!productsByRecord.has(key)) productsByRecord.set(key, []);
    productsByRecord.get(key).push(productLine(row, hideUnit));
  }
  const techNames = new Map((techs || []).map((t) => [String(t.id), t.name || null]));
  return {
    productsFor: (record) => productsByRecord.get(String(record.id)) || [],
    technicianFor: (record) => (record.technician_id ? techNames.get(String(record.technician_id)) || null : null),
    notesFor: (record) => record.technician_notes || null,
  };
}

module.exports = {
  loadServiceRecordFacts,
  SERVICE_RECORD_COLUMNS,
  SERVICE_PRODUCT_COLUMNS,
  TECHNICIAN_COLUMNS,
};
