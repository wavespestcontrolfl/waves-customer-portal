// Pure per-method exemption verdicts shared by the three card-expiry
// warning surfaces (services/card-expiry-exemptions.js).
const {
  emptyCardExpiryExemptions, isCardExpiryExemptMethod, cardExpiryAlertResolvableCustomerIds,
} = require('../services/card-expiry-exemptions');

const ex = (customerIds = [], charged = []) => ({ customerIds: new Set(customerIds), chargeMethodIdsByCustomer: new Map(charged) });

describe('isCardExpiryExemptMethod', () => {
  test('fully exempt customer → every method exempt', () => {
    expect(isCardExpiryExemptMethod(ex(['c1']), 'c1', 'pm-any')).toBe(true);
    expect(isCardExpiryExemptMethod(ex(['c1']), 'c1', null)).toBe(true);
  });
  test('covered customer with a charge coming → only the charged methods warn', () => {
    const e = ex([], [['c1', new Set(['pm-hold'])]]);
    expect(isCardExpiryExemptMethod(e, 'c1', 'pm-hold')).toBe(false);
    expect(isCardExpiryExemptMethod(e, 'c1', 'pm-autopay')).toBe(true);
    expect(isCardExpiryExemptMethod(e, 1, 'pm-autopay')).toBe(false); // different customer
  });
  test('unresolved charge (null), unknown method, uncovered customer, malformed input → warn', () => {
    expect(isCardExpiryExemptMethod(ex([], [['c1', null]]), 'c1', 'pm-x')).toBe(false);
    expect(isCardExpiryExemptMethod(ex([], [['c1', new Set(['pm-hold'])]]), 'c1', null)).toBe(false);
    expect(isCardExpiryExemptMethod(ex(), 'c1', 'pm-x')).toBe(false);
    expect(isCardExpiryExemptMethod(null, 'c1', 'pm-x')).toBe(false);
    expect(isCardExpiryExemptMethod({}, 'c1', 'pm-x')).toBe(false);
    expect(isCardExpiryExemptMethod(emptyCardExpiryExemptions(), 'c1', 'pm-x')).toBe(false);
  });
});

describe('cardExpiryAlertResolvableCustomerIds', () => {
  test('fully exempt customers always; partially covered ones only when none of their expiring cards will be charged', () => {
    const e = ex(['c-full'], [
      ['c-other-card', new Set(['pm-hold'])], // charge on a card that is not expiring
      ['c-charged', new Set(['pm-exp'])],     // charge on the expiring card itself
      ['c-unresolved', null],
      ['c-no-expiring', new Set(['pm-z'])],   // nothing of theirs is expiring at all
    ]);
    const expiring = [
      { id: 'pm-autopay', customer_id: 'c-other-card' },
      { id: 'pm-exp', customer_id: 'c-charged' },
      { id: 'pm-u', customer_id: 'c-unresolved' },
      { id: 'pm-n', customer_id: 'c-nobody' },
    ];
    expect([...cardExpiryAlertResolvableCustomerIds(e, expiring)].sort()).toEqual(['c-full', 'c-no-expiring', 'c-other-card']);
  });
  test('malformed / empty input → only the fully exempt set', () => {
    expect([...cardExpiryAlertResolvableCustomerIds(ex(['c1']), undefined)]).toEqual(['c1']);
    expect(cardExpiryAlertResolvableCustomerIds(null, []).size).toBe(0);
    expect([...cardExpiryAlertResolvableCustomerIds({ customerIds: new Set(['c1']) }, [])]).toEqual(['c1']);
  });
});
