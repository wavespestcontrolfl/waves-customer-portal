const { coverageMonths, annualPrepaySetupFeeWaived } = require('../services/invoice-prepay');

describe('invoice-prepay helpers', () => {
  describe('coverageMonths', () => {
    it('resolves a standard one-year term to 12 months', () => {
      expect(coverageMonths('2026-06-06', '2027-06-05')).toBe(12);
    });

    it('rounds a partial term to the nearest whole month', () => {
      expect(coverageMonths('2026-01-01', '2026-07-01')).toBe(6);
    });

    it('accepts Date objects as well as strings', () => {
      expect(coverageMonths(new Date('2026-06-06'), new Date('2027-06-05'))).toBe(12);
    });

    it('returns null when a date is missing or invalid', () => {
      expect(coverageMonths(null, '2027-06-05')).toBeNull();
      expect(coverageMonths('2026-06-06', null)).toBeNull();
      expect(coverageMonths('not-a-date', '2027-06-05')).toBeNull();
    });

    it('returns null for a non-positive span', () => {
      expect(coverageMonths('2027-06-05', '2026-06-06')).toBeNull();
      expect(coverageMonths('2026-06-06', '2026-06-06')).toBeNull();
    });
  });

  describe('annualPrepaySetupFeeWaived', () => {
    it('detects the waiver from a line item description', () => {
      const invoice = {
        line_items: [
          { description: 'WaveGuard Membership — 12 months prepaid (setup fee waived)' },
        ],
      };
      expect(annualPrepaySetupFeeWaived(invoice)).toBe(true);
    });

    it('detects the waiver from invoice notes', () => {
      const invoice = { line_items: [], notes: 'Annual plan, setup fee waived for prepay.' };
      expect(annualPrepaySetupFeeWaived(invoice)).toBe(true);
    });

    it('parses line items delivered as a JSON string', () => {
      const invoice = {
        line_items: JSON.stringify([{ description: 'Setup waived for the year' }]),
      };
      expect(annualPrepaySetupFeeWaived(invoice)).toBe(true);
    });

    it('returns false when nothing mentions a waived setup fee', () => {
      const invoice = {
        line_items: [{ description: 'Quarterly pest control — April 2026' }],
        notes: 'Thanks for your business.',
      };
      expect(annualPrepaySetupFeeWaived(invoice)).toBe(false);
    });
  });
});
