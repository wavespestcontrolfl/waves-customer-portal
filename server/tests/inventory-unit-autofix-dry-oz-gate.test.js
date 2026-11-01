/**
 * GATE_INVENTORY_UNIT_AUTOFIX_DRY_OZ is read at CALL time (strict 'true'), so
 * the real reader is tested here without the feature-gates mock the sweep
 * suite uses.
 */
const { inventoryUnitAutofixDryOzLive } = require('../config/feature-gates');

describe('inventoryUnitAutofixDryOzLive', () => {
  const saved = process.env.GATE_INVENTORY_UNIT_AUTOFIX_DRY_OZ;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_INVENTORY_UNIT_AUTOFIX_DRY_OZ;
    else process.env.GATE_INVENTORY_UNIT_AUTOFIX_DRY_OZ = saved;
  });

  it('is off when unset and on only for exactly "true", read at each call', () => {
    delete process.env.GATE_INVENTORY_UNIT_AUTOFIX_DRY_OZ;
    expect(inventoryUnitAutofixDryOzLive()).toBe(false);
    process.env.GATE_INVENTORY_UNIT_AUTOFIX_DRY_OZ = 'true';
    expect(inventoryUnitAutofixDryOzLive()).toBe(true);
    for (const value of ['TRUE', '1', 'yes', 'shadow', ' true', '']) {
      process.env.GATE_INVENTORY_UNIT_AUTOFIX_DRY_OZ = value;
      expect(inventoryUnitAutofixDryOzLive()).toBe(false);
    }
  });
});
