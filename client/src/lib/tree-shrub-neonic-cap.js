// client/src/lib/tree-shrub-neonic-cap.js
//
// The yearly neonicotinoid cap on the Tree & Shrub Fast Complete sheet (GATE_TS_NEONIC_CAP,
// owner 2026-10-09). Pure functions: the server sends `neonicCap` in the fast context (how much
// of each capped product's yearly amount the property has used, and the product amounts in the
// product's own unit). This shows what is left and holds Complete on an amount over it. Like the
// live-insect check, the hold is the sheet's: /complete does not refuse, and an application that
// was made is always recorded.
//
// Products that share an active ingredient share one cap: an amount is a share of its own
// product's yearly amount, and the shares of the year so far and of this visit's rows add up to 1.
import { submittedAmount } from './measure-units';

const SHARE_EPSILON = 1e-9;
// Mirrors server/services/inventory-units.js for the units this sheet sends: a volume unit and
// a weight unit never convert to each other, and a bare "oz" stands in for either.
const UNITS = {
  fl_oz: { dimension: 'volume', factor: 1 },
  gal: { dimension: 'volume', factor: 128 },
  oz: { dimension: 'ambiguous', factor: 1 },
  g: { dimension: 'weight', factor: 0.035274 },
  lb: { dimension: 'weight', factor: 16 },
};
const UNIT_LABEL = { fl_oz: 'fl oz' };
const unitLabel = (unit) => UNIT_LABEL[unit] || unit;

// An amount in another unit, or null when the units do not convert.
export function convertAmount(amount, fromUnit, toUnit) {
  const n = Number(amount);
  if (!(n > 0)) return null;
  if (fromUnit === toUnit) return n;
  const from = UNITS[fromUnit];
  const to = UNITS[toUnit];
  if (!from || !to) return null;
  const sameDimension = from.dimension === to.dimension || from.dimension === 'ambiguous' || to.dimension === 'ambiguous';
  return sameDimension ? (n * from.factor) / to.factor : null;
}

// One decimal from 1 up, two below. An entered amount rounds up and what is left rounds down, so a
// message never understates an overage.
const places = (n) => (n >= 1 ? 1 : 2);
const scaled = (n) => n * 10 ** places(n);
export const formatEntered = (n) => (Math.ceil(scaled(n) - 1e-9) / 10 ** places(n)).toFixed(places(n));
export const formatLeft = (n) => (Math.floor(scaled(n) + 1e-9) / 10 ** places(n)).toFixed(places(n));
const formatYearly = (n) => (Math.round(scaled(n)) / 10 ** places(n)).toFixed(places(n));

// The sheet's active rows that sit under a cap, with the share each entered amount is of its
// product's yearly amount (null share: no amount yet, or a unit that does not convert).
function cappedRows(ingredient, rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row?.active) continue;
    const product = (ingredient.capByProduct || []).find((entry) => String(entry.productId) === String(row.productId));
    if (!product) continue;
    const { totalAmount, amountUnit } = submittedAmount(row.totalAmount, row.amountUnit);
    const amount = product.yearlyAmount ? convertAmount(totalAmount, amountUnit, product.unit) : null;
    out.push({ row, product, amount, share: amount ? amount / product.yearlyAmount : 0 });
  }
  return out;
}

function ingredientResult(ingredient, rows) {
  const lines = {};
  const holds = [];
  const capped = cappedRows(ingredient, rows);
  if (ingredient.reason) {
    for (const { row, product } of capped) lines[row.productId] = `${product.name}: bed area needed to check the yearly limit.`;
    return { lines, holds };
  }
  const used = ingredient.usedShare || 0;
  const thisVisit = capped.reduce((sum, entry) => sum + entry.share, 0);
  const over = used + thisVisit > 1 + SHARE_EPSILON;
  const note = ingredient.unsized > 0 ? ` (${ingredient.unsized} earlier ${ingredient.unsized === 1 ? 'application' : 'applications'} not counted)` : '';
  for (const { row, product, amount, share } of capped) {
    const left = Math.max(0, 1 - used - (thisVisit - share)) * product.yearlyAmount;
    const unit = unitLabel(product.unit);
    lines[row.productId] = `${product.name} left this year: ${formatLeft(left)} ${unit} of ${formatYearly(product.yearlyAmount)}${note}`;
    // An amount in a unit that does not convert ("each") cannot be checked: hold it, never skip it.
    if (!amount && Number(row.totalAmount) > 0) holds.push(`${product.name}: enter the amount in ${unit} so the yearly limit can be checked.`);
    if (over && share > 0) {
      holds.push(`${product.name}: ${formatEntered(amount)} ${unit} is over the ${formatLeft(left)} ${unit} left this year for this property.`);
    }
  }
  return { lines, holds };
}

/**
 * context: the fast context's `neonicCap` (null = gate off, or the read failed: nothing shows and
 * nothing holds). rows: the sheet's product rows (only the active ones count).
 * Returns { lines: { [productId]: text }, holds: [text], blockMessage }.
 */
export function evaluateNeonicCap(context, rows) {
  const out = { lines: {}, holds: [], blockMessage: '' };
  if (!context || typeof context !== 'object' || context.available === false) return out;
  for (const ingredient of context.ingredients || []) {
    const result = ingredientResult(ingredient, rows);
    Object.assign(out.lines, result.lines);
    out.holds.push(...result.holds);
  }
  out.blockMessage = out.holds[0] || '';
  return out;
}
