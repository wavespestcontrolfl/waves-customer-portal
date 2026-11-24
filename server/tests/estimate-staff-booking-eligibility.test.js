/**
 * The booking-win "Link it" button (owner 2026-11-23) is offered only for an open quote a staff booking would accept.
 * `bookable` on GET /admin/customers/:id/schedule-estimates comes from estimateBookableByStaff, which applies the same
 * row refusals POST /admin/schedule applies before it creates any rows. The two heavy modules are mocked so this is a
 * pure wiring test; the bill-by-invoice predicate is real.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The real accept-on-book predicates (estimate-manual-acceptance) run here. Only the 33k-line public estimate router is
// replaced, for its retired tree-and-shrub cadence check.
const mockRetired = jest.fn();
jest.mock('../routes/estimate-public', () => ({ recurringTreeShrubRowAtRetiredCadence: (...a) => mockRetired(...a) }));

const { estimateBookableByStaff, staffBookingRefusalForOpenEstimate, quotedAddressPropertyIds } = require('../services/estimate-staff-booking-eligibility');

const PROPOSAL = {
  enabled: true,
  title: 'Sample Office Proposal',
  buildings: [{ name: 'Main', lineItems: [{ description: 'Quarterly pest', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true, amount: 300 }] }],
  commercialTerms: { paymentTerms: 'net30' },
};
const open = (extra = {}) => ({
  id: 'est-1', status: 'sent', customer_id: 'cust-1', source: null, bill_by_invoice: false, show_one_time_option: false,
  estimate_data: {}, ...extra,
});

beforeEach(() => { mockRetired.mockReset().mockReturnValue(false); });

describe('estimateBookableByStaff (real accept-on-book predicates)', () => {
  test('an ordinary open quote is bookable', () => {
    expect(estimateBookableByStaff(open())).toBe(true);
    expect(estimateBookableByStaff(open({ status: 'viewed' }))).toBe(true);
  });

  test('a portal plan-start quote is not (only the customer can accept it)', () => {
    const row = open({ source: 'plan_start' });
    expect(estimateBookableByStaff(row)).toBe(false);
    expect(staffBookingRefusalForOpenEstimate(row).code).toBe('plan_start_self_serve');
  });

  test('a bill-by-invoice proposal that is not won is not; a won one is', () => {
    const proposal = open({ bill_by_invoice: true, estimate_data: { proposal: PROPOSAL } });
    expect(estimateBookableByStaff(proposal)).toBe(false);
    expect(staffBookingRefusalForOpenEstimate(proposal).code).toBe('proposal_not_won');
    expect(estimateBookableByStaff({ ...proposal, status: 'accepted' })).toBe(true);
  });

  test('a sent quote with unresolved manager approval is not (the accept-on-book would refuse it after the visit commits)', () => {
    const row = open({ estimate_data: { lineItems: [{ name: 'Sample line', requiresManagerApproval: true }] } });
    expect(estimateBookableByStaff(row)).toBe(false);
    expect(staffBookingRefusalForOpenEstimate(row).message).toMatch(/Manager approval is required/);
  });

  test('a normal invoice-mode quote and a one-time-option quote are not (they accept only through the customer link)', () => {
    expect(estimateBookableByStaff(open({ bill_by_invoice: true }))).toBe(false);
    expect(estimateBookableByStaff(open({ show_one_time_option: true }))).toBe(false);
  });

  test('a quote held for a re-price is not, and a quote a call-linkage correction pulled is not', () => {
    const held = open({ estimate_data: { estimatorEngine: { reprice_pending_at: '2026-11-20T15:00:00Z' } } });
    expect(estimateBookableByStaff(held)).toBe(false);
    expect(staffBookingRefusalForOpenEstimate(held).message).toMatch(/held for a re-price/);
    for (const marker of [{ linkage_invalidated_at: '2026-11-20T15:00:00Z' }, { invalidation_pending_at: '2026-11-20T15:00:00Z' }]) {
      const pulled = open({ estimate_data: { estimatorEngine: { callLogId: 'call-1', ...marker } } });
      expect(estimateBookableByStaff(pulled)).toBe(false);
      expect(staffBookingRefusalForOpenEstimate(pulled).message).toMatch(/quarantined by a call-linkage correction/);
    }
    // A call-composed draft with no marker passes the row-only check (the accept still reads the call log).
    expect(estimateBookableByStaff(open({ estimate_data: { estimatorEngine: { callLogId: 'call-1' } } }))).toBe(true);
  });

  test('assertNotQuarantined keeps its behavior: the shared row check and its messages are the ones it throws', async () => {
    const { rowQuarantineRefusal } = require('../services/estimate-manual-acceptance');
    expect(rowQuarantineRefusal({}, { estimatorEngine: { reprice_pending_at: 'x' } }).message).toMatch(/held for a re-price/);
    expect(rowQuarantineRefusal({ archived_at: new Date() }, { estimatorEngine: { callLogId: 'c' } }).message).toMatch(/quarantined/);
    expect(rowQuarantineRefusal({ archived_at: new Date() }, { estimatorEngine: {} })).toBeNull();
    expect(rowQuarantineRefusal({}, null)).toBeNull();
  });

  test('an open row with price_locked_at set is not bookable', () => {
    expect(estimateBookableByStaff(open({ price_locked_at: '2026-11-20T15:00:00Z' }))).toBe(false);
    expect(estimateBookableByStaff(open({ price_locked_at: null }))).toBe(true);
  });

  test('a commercial estimate or proposal is not bookable, even a Net-30 proposal with invoice mode off', () => {
    expect(estimateBookableByStaff(open({ category: 'COMMERCIAL' }))).toBe(false);
    expect(estimateBookableByStaff(open({ category: 'commercial' }))).toBe(false);
    const net30 = open({ bill_by_invoice: false, estimate_data: { proposal: PROPOSAL } });
    expect(estimateBookableByStaff(net30)).toBe(false);
    expect(staffBookingRefusalForOpenEstimate(net30).code).toBe('commercial');
    expect(estimateBookableByStaff(open({ category: 'RESIDENTIAL' }))).toBe(true);
  });

  test('an accepted row runs the helper too: a gated or dropped add-on makes it not bookable, an ordinary one is', () => {
    const manual = require('../services/estimate-manual-acceptance');
    const spy = jest.spyOn(manual, 'persistedAddOnRefusal').mockReturnValue({ code: 'ADDON_GATED', message: 'gated' });
    try {
      expect(estimateBookableByStaff(open({ status: 'accepted' }))).toBe(false);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }), expect.objectContaining({ checkRecurring: false }));
    } finally {
      spy.mockRestore();
    }
    expect(estimateBookableByStaff(open({ status: 'accepted' }))).toBe(true);
  });

  test('a quote that yields no schedulable line (quote-required-only items) is not bookable', () => {
    expect(estimateBookableByStaff(open(), { schedulableLineCount: 0 })).toBe(false);
    expect(estimateBookableByStaff(open(), { schedulableLineCount: 2 })).toBe(true);
    expect(estimateBookableByStaff(open({ status: 'accepted' }), { schedulableLineCount: 0 })).toBe(false);
  });

  test('a retired tree-and-shrub cadence is not', () => {
    mockRetired.mockReturnValue(true);
    expect(estimateBookableByStaff(open())).toBe(false);
  });

  test('a missing row, or any unexpected error, reads as not bookable', () => {
    expect(estimateBookableByStaff(null)).toBe(false);
    mockRetired.mockImplementation(() => { throw new Error('boom'); });
    expect(estimateBookableByStaff(open())).toBe(false);
  });
});

describe('quotedAddressPropertyIds (a property-unlinked quote that carries a street)', () => {
  const props = [
    { id: 'prop-home', address_line1: '12 Test Lane', address_line2: null, city: 'Bradenton', zip: '34205' },
    { id: 'prop-rental', address_line1: '99 Sample Ave', address_line2: null, city: 'Sarasota', zip: '34236' },
  ];

  test('names the saved properties the quoted street matches, with the real address matcher', () => {
    expect(quotedAddressPropertyIds(open({ address: '12 Test Lane, Bradenton, FL 34205, USA' }), props)).toEqual(['prop-home']);
    expect(quotedAddressPropertyIds(open({ address: '99 Sample Ave, Sarasota, FL 34236' }), props)).toEqual(['prop-rental']);
  });

  test('a street that matches none of them (a former address) gives an empty list', () => {
    expect(quotedAddressPropertyIds(open({ address: '500 Old Road, Bradenton, FL 34205' }), props)).toEqual([]);
    expect(quotedAddressPropertyIds(open({ address: '12 Test Lane, Venice, FL 34285' }), props)).toEqual([]);
  });

  test('null when the quote is tied to a property or carries no address, and unknown properties match nothing', () => {
    expect(quotedAddressPropertyIds(open({ property_id: 'prop-home', address: '500 Old Road, Bradenton, FL 34205' }), props)).toBeNull();
    expect(quotedAddressPropertyIds(open({ address: '  ' }), props)).toBeNull();
    expect(quotedAddressPropertyIds(open({ address: null }), props)).toBeNull();
    expect(quotedAddressPropertyIds(open({ address: '12 Test Lane, Bradenton, FL 34205' }), [])).toEqual([]);
  });
});
