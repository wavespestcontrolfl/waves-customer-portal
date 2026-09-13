// @vitest-environment jsdom
/**
 * Codex #4405 P1 — Edit appointment (EditServiceModal) treated stacking as
 * disabled while the probe was unconfirmed, but the appointment-level
 * "Discount" control (pre-existing before this lane) still exposed and
 * still let Save through. For a visit with an existing add-on/primary line
 * discount, the server independently reads the REAL gate at save time,
 * reconstructs the stored line slot (reconstructStoredLineSlot), and
 * compounds it with the appointment discount — persisting a different total
 * than the client, which computed with compound: stackingEnabled==false,
 * previewed.
 */
import { describe, it, expect } from 'vitest';
import { editApptStackingSaveBlocked } from './SchedulePage';

describe('editApptStackingSaveBlocked (Edit appointment — unconfirmed gate)', () => {
  it('blocks when an appointment discount is selected AND the primary line already carries a discount slot', () => {
    expect(editApptStackingSaveBlocked({
      known: false,
      appointmentDiscountSelected: true,
      primaryLineDiscount: { id: 'd1', discount_type: 'percentage', amount: 10 },
      lines: [],
    })).toBe(true);
  });

  it('blocks when an appointment discount is selected AND an add-on line carries a STORED discount (_origDiscountType), even with no live lineDiscount slot', () => {
    expect(editApptStackingSaveBlocked({
      known: false,
      appointmentDiscountSelected: true,
      primaryLineDiscount: null,
      lines: [{ lineDiscount: null, _origDiscountType: 'percentage', _origDiscountAmount: 10 }],
    })).toBe(true);
  });

  it('blocks when an add-on line carries a freshly-picked lineDiscount this session', () => {
    expect(editApptStackingSaveBlocked({
      known: false,
      appointmentDiscountSelected: true,
      primaryLineDiscount: null,
      lines: [{ lineDiscount: { id: 'd2', discount_type: 'fixed_amount', amount: 5 } }],
    })).toBe(true);
  });

  it('does NOT block once the gate resolves (known:true), regardless of what is selected', () => {
    expect(editApptStackingSaveBlocked({
      known: true,
      appointmentDiscountSelected: true,
      primaryLineDiscount: { id: 'd1', discount_type: 'percentage', amount: 10 },
      lines: [],
    })).toBe(false);
  });

  it('does NOT block when no appointment discount is selected — nothing to compound with a line slot', () => {
    expect(editApptStackingSaveBlocked({
      known: false,
      appointmentDiscountSelected: false,
      primaryLineDiscount: { id: 'd1', discount_type: 'percentage', amount: 10 },
      lines: [],
    })).toBe(false);
  });

  it('does NOT block a plain single-discount save: appointment discount selected, but no line anywhere carries one — byte-identical to main', () => {
    expect(editApptStackingSaveBlocked({
      known: false,
      appointmentDiscountSelected: true,
      primaryLineDiscount: null,
      lines: [{ lineDiscount: null, _origDiscountType: null }, { lineDiscount: null }],
    })).toBe(false);
  });
});
