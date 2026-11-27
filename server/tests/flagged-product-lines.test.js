'use strict';

const { flaggedDeductionsOf, isFlaggedLine, notFlaggedLineSql, storedThousandths, FLAGGED_STATUS } = require('../services/flagged-product-lines');

const flaggedNotes = (...entries) => ({ inventoryDeductions: entries.map((e) => ({ status: FLAGGED_STATUS, ...e })) });

describe('flaggedDeductionsOf', () => {
  test('keeps only the over-ceiling entries; a string, a missing or a malformed record reads as none', () => {
    const notes = { inventoryDeductions: [{ status: 'deducted', serviceProductId: 'a' }, { status: FLAGGED_STATUS, serviceProductId: 'b' }, null] };
    expect(flaggedDeductionsOf(notes)).toEqual([{ status: FLAGGED_STATUS, serviceProductId: 'b' }]);
    expect(flaggedDeductionsOf(JSON.stringify(notes))).toHaveLength(1);
    for (const value of [null, undefined, '', 'not json', [], { inventoryDeductions: 'x' }, {}]) expect(flaggedDeductionsOf(value)).toEqual([]);
  });
});

describe('isFlaggedLine (the one match rule, same as pest-recap)', () => {
  test('a deduction with a service product id matches that line only, whatever its amount', () => {
    const flagged = flaggedDeductionsOf(flaggedNotes({ serviceProductId: 'sp-1', productId: 'p', amount: 1, amountUnit: 'oz' }));
    expect(isFlaggedLine({ id: 'sp-1', product_id: 'p', total_amount: '9', amount_unit: 'lb' }, flagged)).toBe(true);
    expect(isFlaggedLine({ id: 'sp-2', product_id: 'p', total_amount: '1.000', amount_unit: 'oz' }, flagged)).toBe(false);
  });

  test('an older deduction (no service product id) matches the same product, unit (any case) and amount at 3 decimals', () => {
    const flagged = flaggedDeductionsOf(flaggedNotes({ productId: 'p', amount: 50000, amountUnit: 'LB' }));
    expect(isFlaggedLine({ id: 'sp-9', product_id: 'p', total_amount: '50000.000', amount_unit: 'lb' }, flagged)).toBe(true);
    expect(isFlaggedLine({ id: 'sp-9', product_id: 'p', total_amount: '2.000', amount_unit: 'lb' }, flagged)).toBe(false);
    expect(isFlaggedLine({ id: 'sp-9', product_id: 'p', total_amount: '50000.000', amount_unit: 'oz' }, flagged)).toBe(false);
    expect(isFlaggedLine({ id: 'sp-9', product_id: 'q', total_amount: '50000.000', amount_unit: 'lb' }, flagged)).toBe(false);
    const rounded = flaggedDeductionsOf(flaggedNotes({ productId: 'p', amount: 12.3456, amountUnit: 'oz' }));
    expect(isFlaggedLine({ product_id: 'p', total_amount: '12.346', amount_unit: 'oz' }, rounded)).toBe(true);
  });

  test('the amount is compared as PostgreSQL stores it: half-steps round up on the decimal text, a null never matches', () => {
    const half = flaggedDeductionsOf(flaggedNotes({ productId: 'p', amount: 512.0015, amountUnit: 'lb' }));
    expect(isFlaggedLine({ product_id: 'p', total_amount: '512.002', amount_unit: 'lb' }, half)).toBe(true);
    expect(isFlaggedLine({ product_id: 'p', total_amount: '512.001', amount_unit: 'lb' }, half)).toBe(false);
    const zero = flaggedDeductionsOf(flaggedNotes({ productId: 'p', amount: null, amountUnit: 'lb' }));
    expect(isFlaggedLine({ product_id: 'p', total_amount: null, amount_unit: 'lb' }, zero)).toBe(false);
    expect(isFlaggedLine({ product_id: 'p', total_amount: '0.000', amount_unit: 'lb' }, zero)).toBe(false);
    expect(storedThousandths('406.0005')).toBe(406001n);
  });

  test('no flagged deductions, or no line, is never a match', () => {
    expect(isFlaggedLine({ id: 'a' }, [])).toBe(false);
    expect(isFlaggedLine(null, [{ serviceProductId: 'a' }])).toBe(false);
    expect(isFlaggedLine({ id: 'a' }, undefined)).toBe(false);
  });
});

describe('notFlaggedLineSql (the SQL twin)', () => {
  test('uses the given aliases and both match branches', () => {
    const sql = notFlaggedLineSql('sp', 'sr');
    expect(sql).toMatch(/^NOT EXISTS \(/);
    expect(sql).toContain("d->>'status' = 'not_deducted_implausible'");
    expect(sql).toContain("d->>'serviceProductId' = sp.id::text");
    expect(sql).toContain("d->>'productId' = sp.product_id::text");
    expect(sql).toContain('ROUND((d->>\'amount\')::numeric, 3) = sp.total_amount');
    expect(notFlaggedLineSql('x', 'y')).toContain('y.structured_notes');
  });
});
