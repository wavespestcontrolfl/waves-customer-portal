/**
 * The booking-win "Link it" button (owner 2026-11-23) is offered only for an open quote a staff booking would accept.
 * `bookable` on GET /admin/customers/:id/schedule-estimates comes from estimateBookableByStaff, which applies the same
 * row refusals POST /admin/schedule applies before it creates any rows. The two heavy modules are mocked so this is a
 * pure wiring test; the bill-by-invoice predicate is real.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockManual = {
  planStartManualAcceptRefusal: jest.fn(),
  persistedAddOnRefusal: jest.fn(),
};
jest.mock('../services/estimate-manual-acceptance', () => mockManual);
const mockRetired = jest.fn();
jest.mock('../routes/estimate-public', () => ({ recurringTreeShrubRowAtRetiredCadence: (...a) => mockRetired(...a) }));

const { estimateBookableByStaff, staffBookingRefusalForOpenEstimate } = require('../services/estimate-staff-booking-eligibility');

const PROPOSAL = {
  enabled: true,
  title: 'Sample Office Proposal',
  buildings: [{ name: 'Main', lineItems: [{ description: 'Quarterly pest', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true, amount: 300 }] }],
  commercialTerms: { paymentTerms: 'net30' },
};
const open = (extra = {}) => ({ id: 'est-1', status: 'sent', source: null, bill_by_invoice: false, estimate_data: {}, ...extra });

beforeEach(() => {
  mockManual.planStartManualAcceptRefusal.mockReset().mockReturnValue(null);
  mockManual.persistedAddOnRefusal.mockReset().mockReturnValue(null);
  mockRetired.mockReset().mockReturnValue(false);
});

describe('estimateBookableByStaff', () => {
  test('an ordinary open quote is bookable', () => {
    expect(estimateBookableByStaff(open())).toBe(true);
    expect(mockManual.persistedAddOnRefusal).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-1' }), { action: 'booking from it', billingTerm: 'standard', checkRecurring: true });
  });

  test('a portal plan-start quote is not (only the customer can accept it)', () => {
    mockManual.planStartManualAcceptRefusal.mockReturnValue({ code: 'plan_start_self_serve', message: 'x' });
    expect(estimateBookableByStaff(open({ source: 'plan_start' }))).toBe(false);
    expect(staffBookingRefusalForOpenEstimate(open({ source: 'plan_start' })).code).toBe('plan_start_self_serve');
  });

  test('a bill-by-invoice proposal that is not won is not; a won one is', () => {
    const proposal = open({ bill_by_invoice: true, estimate_data: { proposal: PROPOSAL } });
    expect(estimateBookableByStaff(proposal)).toBe(false);
    expect(staffBookingRefusalForOpenEstimate(proposal).code).toBe('proposal_not_won');
    expect(estimateBookableByStaff({ ...proposal, status: 'accepted' })).toBe(true);
  });

  test('a quote whose add-ons the booking would refuse is not', () => {
    mockManual.persistedAddOnRefusal.mockReturnValue({ code: 'ADDON', message: 'x' });
    expect(estimateBookableByStaff(open())).toBe(false);
  });

  test('a retired tree-and-shrub cadence is not', () => {
    mockRetired.mockReturnValue(true);
    expect(estimateBookableByStaff(open())).toBe(false);
  });

  test('a missing row, or any unexpected error, reads as not bookable', () => {
    expect(estimateBookableByStaff(null)).toBe(false);
    mockManual.persistedAddOnRefusal.mockImplementation(() => { throw new Error('boom'); });
    expect(estimateBookableByStaff(open())).toBe(false);
  });
});
