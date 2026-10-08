// The Celsius applications a customer's lawn has had this year, as the portal's cap copy shows them.
// Counted the way the cap is enforced (application-limits): per lawn, from the application ledger, the
// treated property being the one frozen on the ledger row (a legacy row without one: its visit's
// property). With a property in scope the count is that lawn's (rows that cannot be placed at any
// property still count); with none it is the customer's busiest lawn plus the unplaced rows, never the
// sum across properties.
const db = require('../models/db');
const { worstPropertyCount } = require('../utils/property-counts');

async function celsiusApplicationsThisYear(customerId, yearStart, { propertyId = null, knex = db } = {}) {
  const rows = await knex('property_application_history as pah')
    .leftJoin('products_catalog as pc', 'pc.id', 'pah.product_id')
    .leftJoin('service_products as sp', 'sp.id', 'pah.service_product_id')
    .leftJoin('service_records as sr', 'sr.id', 'pah.service_record_id')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('pah.customer_id', customerId)
    .where('pah.application_date', '>=', yearStart)
    .whereNull('pah.retracted_at')
    .where((q) => q.whereRaw("pc.name ilike '%celsius%'").orWhereRaw("sp.product_name ilike '%celsius%'"))
    .select('pah.property_id', 'ss.property_id as visit_property_id');
  const placed = rows.map((row) => ({ treated_property_id: row.property_id || row.visit_property_id || null }));
  if (!propertyId) return worstPropertyCount(placed);
  return placed.filter((row) => !row.treated_property_id || String(row.treated_property_id) === String(propertyId)).length;
}

module.exports = { celsiusApplicationsThisYear };
