/**
 * Equipment reads for a technician caller: operational columns only.
 *
 * Owner 2026-10-03 ("narrow"): no vendor prices and no job costs for a
 * technician. Owner 2026-11-04 ("ok go for all"): the same rule for the
 * equipment pages. Each strip below removes money fields from one kind of
 * row; an admin response never goes through here.
 *
 * Callers decide the role: `isTechnicianCaller(req)` is true for any staff
 * role that is not 'admin'.
 */

const EQUIPMENT_OWNER_ONLY_FIELDS = [
  'purchase_price',
  'purchase_vendor',
  'book_value',
  'depreciation_annual',
  'depreciation_method',
  'salvage_value',
  'tax_equipment_id',
  'avg_maintenance_cost',
];

// receipt_url is the vendor receipt image: it shows the prices.
const MAINTENANCE_RECORD_OWNER_ONLY_FIELDS = [
  'parts_cost',
  'labor_cost',
  'vendor_cost',
  'total_cost',
  'receipt_url',
];

const SCHEDULE_OWNER_ONLY_FIELDS = ['estimated_cost'];
const DOWNTIME_OWNER_ONLY_FIELDS = ['revenue_impact'];
const FLEET_OVERVIEW_OWNER_ONLY_FIELDS = ['ytd_maintenance_spend', 'ytd_fuel_cost', 'ytd_irs_deduction'];

// Keys of a tank mix a technician never sees: the chemical cost per tank and
// per 1,000 sq ft (owner ruling D3 A, 2026-11-04), and the incomplete-cost
// flag that only exists to qualify those totals. The recipe and the rates stay.
const MIX_OWNER_ONLY_FIELDS = ['cost_per_tank', 'cost_per_1000sf', 'cost_incomplete'];
const MIX_LINE_OWNER_ONLY_FIELDS = ['cost_per_oz', 'cost_in_tank', 'cost_unknown'];

function isTechnicianCaller(req) {
  return req.techRole !== 'admin';
}

function omit(row, keys) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of keys) delete out[key];
  return out;
}

const stripEquipmentRow = (row) => omit(row, EQUIPMENT_OWNER_ONLY_FIELDS);
const stripMaintenanceRecord = (row) => omit(row, MAINTENANCE_RECORD_OWNER_ONLY_FIELDS);
const stripSchedule = (row) => omit(row, SCHEDULE_OWNER_ONLY_FIELDS);
const stripDowntime = (row) => omit(row, DOWNTIME_OWNER_ONLY_FIELDS);
const stripFleetOverview = (row) => omit(row, FLEET_OVERVIEW_OWNER_ONLY_FIELDS);

function mapRows(rows, strip) {
  return Array.isArray(rows) ? rows.map(strip) : rows;
}

// Strips a tank mix row. `products` keeps its stored shape (a JSON string
// stays a string, an array stays an array).
function stripMixCosts(mix) {
  if (!mix || typeof mix !== 'object') return mix;
  const out = omit(mix, MIX_OWNER_ONLY_FIELDS);
  const wasString = typeof out.products === 'string';
  let lines;
  try {
    lines = wasString ? JSON.parse(out.products) : (out.products || []);
  } catch {
    lines = [];
  }
  if (!Array.isArray(lines)) return out;
  const stripped = lines.map((line) => (line && typeof line === 'object' ? omit(line, MIX_LINE_OWNER_ONLY_FIELDS) : line));
  return { ...out, products: wasString ? JSON.stringify(stripped) : stripped };
}

module.exports = {
  EQUIPMENT_OWNER_ONLY_FIELDS,
  MAINTENANCE_RECORD_OWNER_ONLY_FIELDS,
  SCHEDULE_OWNER_ONLY_FIELDS,
  DOWNTIME_OWNER_ONLY_FIELDS,
  FLEET_OVERVIEW_OWNER_ONLY_FIELDS,
  MIX_OWNER_ONLY_FIELDS,
  MIX_LINE_OWNER_ONLY_FIELDS,
  isTechnicianCaller,
  stripEquipmentRow,
  stripMaintenanceRecord,
  stripSchedule,
  stripDowntime,
  stripFleetOverview,
  stripMixCosts,
  mapRows,
};
