const {
  CUSTOMER_VISIBLE_STATUSES,
  CARD_TAKEN_DOWN_STATUSES,
  isCardCustomerSurfaceable,
} = require('../services/lawn-recommendation-visibility');

describe('isCardCustomerSurfaceable', () => {
  const approvedVisible = {
    type: 'tier_upgrade', customer_visible: true, status: 'approved', approved_at: new Date(), requires_human_approval: true,
  };
  const eduAutoPublish = {
    type: 'customer_education', customer_visible: false, status: 'draft', approved_at: null, requires_human_approval: false,
  };

  test('surfaces admin-approved + visible cards', () => {
    expect(isCardCustomerSurfaceable(approvedVisible)).toBe(true);
  });

  test('an approved card NOT yet made visible stays hidden', () => {
    expect(isCardCustomerSurfaceable({ ...approvedVisible, customer_visible: false })).toBe(false);
  });

  test('a visible card without approved_at stays hidden (non-education)', () => {
    expect(isCardCustomerSurfaceable({ ...approvedVisible, approved_at: null, status: 'customer_visible' })).toBe(false);
  });

  test('auto-publishes a low-risk education card even though it is born hidden/draft', () => {
    expect(isCardCustomerSurfaceable(eduAutoPublish)).toBe(true);
  });

  test('an education card that still needs approval does NOT auto-publish', () => {
    expect(isCardCustomerSurfaceable({ ...eduAutoPublish, requires_human_approval: true })).toBe(false);
  });

  test.each(CARD_TAKEN_DOWN_STATUSES)('a %s education card stays hidden (explicitly taken down)', (status) => {
    expect(isCardCustomerSurfaceable({ ...eduAutoPublish, status })).toBe(false);
  });

  test('exposes the canonical status lists', () => {
    expect(CUSTOMER_VISIBLE_STATUSES).toEqual(['approved', 'customer_visible', 'accepted']);
    expect(CARD_TAKEN_DOWN_STATUSES).toEqual(['dismissed', 'expired']);
  });
});
