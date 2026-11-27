'use strict';

/**
 * Product lines flagged over their per-visit ceiling (owner 2026-11-26: completion only warns, never blocks).
 * The line is saved as entered; structured_notes.inventoryDeductions[] holds an entry with
 * status 'not_deducted_implausible'. Every derived reader (stock, cost, nutrients, usual amount, last amount)
 * skips such a line. This is the ONE match rule, in SQL (pest-recap's usual amount) and in JS (the fast-complete
 * "last amount" defaults):
 *   - by serviceProductId when the deduction carries it, else
 *   - an older deduction (no serviceProductId): same product, same unit (case-insensitive), same amount at the
 *     stored decimal(8,3).
 */

const FLAGGED_STATUS = 'not_deducted_implausible';

// structured_notes is jsonb (an object) in prod but may surface as a string depending on driver config.
function parseNotes(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The flagged deductions on one record's structured_notes ([] when none). */
function flaggedDeductionsOf(structuredNotes) {
  const list = parseNotes(structuredNotes).inventoryDeductions;
  return Array.isArray(list) ? list.filter((d) => d && d.status === FLAGGED_STATUS) : [];
}

// The amount as decimal(8,3) stores it, in thousandths: the shortest decimal text of the number rounded half up ONCE, the way
// PostgreSQL rounds the text it is sent (406.0005 stores as 406.001, 512.0015 as 512.002), never a binary double scaled and
// rounded twice. A numeric column's own text ("406.001") reads the same way. Shared with job-costing's ledger skip.
function storedThousandths(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const text = /e/i.test(String(n)) ? n.toFixed(20) : String(n);
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const padded = `${fraction}0000`;
  return BigInt(whole + padded.slice(0, 3)) + (padded[3] >= '5' ? 1n : 0n);
}
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Whether one service_products row ({ id, product_id, total_amount, amount_unit }) is a flagged line, given the
 * flagged deductions of its record. A row with no id can only match an older deduction.
 */
function isFlaggedLine(line, flaggedDeductions) {
  if (!line || !flaggedDeductions || !flaggedDeductions.length) return false;
  return flaggedDeductions.some((d) => {
    if (d.serviceProductId != null) return sameId(d.serviceProductId, line.id);
    // SQL: ROUND(NULL) = NULL never matches, so a missing amount on either side is no match (Number(null) would read 0).
    const amount = d.amount == null || line.total_amount == null ? null : storedThousandths(d.amount);
    return sameId(d.productId, line.product_id)
      && amount !== null && amount === storedThousandths(line.total_amount)
      && String(d.amountUnit || '').toLowerCase() === String(line.amount_unit || '').toLowerCase();
  });
}

/**
 * The SQL twin of isFlaggedLine: a NOT EXISTS predicate (no leading AND) over the service_products alias `sp` and the
 * service_records alias `sr`. Keep it in step with isFlaggedLine.
 */
function notFlaggedLineSql(sp = 'sp', sr = 'sr') {
  return `NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${sr}.structured_notes->'inventoryDeductions') = 'array' THEN ${sr}.structured_notes->'inventoryDeductions' ELSE '[]'::jsonb END) AS d
          WHERE d->>'status' = '${FLAGGED_STATUS}'
            AND (d->>'serviceProductId' = ${sp}.id::text
              -- a deduction saved before the service product id was kept: the same product, unit and amount at the stored decimal(8,3)
              OR (d->>'serviceProductId' IS NULL AND d->>'productId' = ${sp}.product_id::text
                AND ROUND((d->>'amount')::numeric, 3) = ${sp}.total_amount
                AND LOWER(COALESCE(d->>'amountUnit', '')) = LOWER(COALESCE(${sp}.amount_unit, '')))))`;
}

module.exports = { FLAGGED_STATUS, flaggedDeductionsOf, isFlaggedLine, notFlaggedLineSql, storedThousandths };
