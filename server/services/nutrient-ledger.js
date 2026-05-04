const { etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function amountToPounds(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const normalized = normalizeText(unit);
  if (['lb', 'lbs', 'pound', 'pounds'].includes(normalized)) return n;
  if (['oz', 'ounce', 'ounces'].includes(normalized)) return n / 16;
  if (['g', 'gram', 'grams'].includes(normalized)) return n / 453.59237;
  if (['kg', 'kilogram', 'kilograms'].includes(normalized)) return n * 2.20462262;
  if (['fl oz', 'fl_oz', 'floz', 'fluid ounce', 'fluid ounces', 'ml', 'milliliter', 'milliliters', 'gal', 'gallon', 'gallons'].includes(normalized)) return null;
  return null;
}

function calculateAppliedNutrients({ product, amount, amountUnit, lawnSqft }) {
  const treatedUnits = Number(lawnSqft || 0) / 1000;
  const pounds = amountToPounds(amount, amountUnit);
  if (!treatedUnits || pounds == null) return null;

  return {
    nAppliedPer1000: Number(((pounds * (Number(product?.analysis_n || 0) / 100)) / treatedUnits).toFixed(4)),
    pAppliedPer1000: Number(((pounds * (Number(product?.analysis_p || 0) / 100)) / treatedUnits).toFixed(4)),
    kAppliedPer1000: Number(((pounds * (Number(product?.analysis_k || 0) / 100)) / treatedUnits).toFixed(4)),
  };
}

function hasNutrients(product) {
  return Number(product?.analysis_n || 0) > 0
    || Number(product?.analysis_p || 0) > 0
    || Number(product?.analysis_k || 0) > 0;
}

function toDateOnly(value) {
  if (!value) return etDateString();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? etDateString() : etDateString(parsed);
}

async function recordServiceProductNutrients(trx, {
  customerId,
  turfProfile,
  serviceRecord,
  serviceProduct,
  product,
  applicationDate,
  blackoutStatus = null,
}) {
  if (!customerId || !serviceRecord || !serviceProduct || !product || !hasNutrients(product)) return null;

  const nutrients = calculateAppliedNutrients({
    product,
    amount: serviceProduct.total_amount,
    amountUnit: serviceProduct.amount_unit,
    lawnSqft: turfProfile?.lawn_sqft,
  });
  if (!nutrients) return null;

  const dateOnly = toDateOnly(applicationDate || serviceRecord.service_date);
  const applicationYear = etParts(parseETDateTime(`${dateOnly}T12:00`)).year;

  const [row] = await trx('property_nutrient_ledger').insert({
    customer_id: customerId,
    turf_profile_id: turfProfile?.id || null,
    service_record_id: serviceRecord.id,
    service_product_id: serviceProduct.id,
    product_id: product.id,
    application_date: dateOnly,
    application_year: applicationYear,
    product_name: product.name,
    analysis: `${Number(product.analysis_n || 0)}-${Number(product.analysis_p || 0)}-${Number(product.analysis_k || 0)}`,
    rate: serviceProduct.application_rate || null,
    rate_unit: serviceProduct.rate_unit || null,
    amount_used: serviceProduct.total_amount ?? null,
    amount_unit: serviceProduct.amount_unit || null,
    lawn_sqft: turfProfile?.lawn_sqft || null,
    n_applied_per_1000: nutrients.nAppliedPer1000,
    p_applied_per_1000: nutrients.pAppliedPer1000,
    k_applied_per_1000: nutrients.kAppliedPer1000,
    slow_release_n_pct: product.slow_release_n_pct || null,
    municipality: turfProfile?.municipality || null,
    county: turfProfile?.county || null,
    blackout_status: blackoutStatus,
    metadata: {
      productCategory: product.category || null,
      activeIngredient: product.active_ingredient || null,
    },
  }).returning('*');

  return row;
}

function summarizeLedgerRows(rows, year) {
  const totals = rows.reduce((acc, row) => {
    acc.nApplied += Number(row.n_applied_per_1000 || row.nAppliedPer1000 || 0);
    acc.pApplied += Number(row.p_applied_per_1000 || row.pAppliedPer1000 || 0);
    acc.kApplied += Number(row.k_applied_per_1000 || row.kAppliedPer1000 || 0);
    return acc;
  }, { nApplied: 0, pApplied: 0, kApplied: 0 });

  return {
    year,
    nApplied: Number(totals.nApplied.toFixed(3)),
    pApplied: Number(totals.pApplied.toFixed(3)),
    kApplied: Number(totals.kApplied.toFixed(3)),
    totalN: Number(totals.nApplied.toFixed(3)),
    totalP: Number(totals.pApplied.toFixed(3)),
    totalK: Number(totals.kApplied.toFixed(3)),
    entries: rows.length,
    source: 'property_nutrient_ledger',
  };
}

module.exports = {
  amountToPounds,
  calculateAppliedNutrients,
  recordServiceProductNutrients,
  summarizeLedgerRows,
  toDateOnly,
};
