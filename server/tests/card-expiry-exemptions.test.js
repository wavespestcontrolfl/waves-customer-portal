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
  // window ends on (2026, 9): a charged card is "beyond" only when it expires after September 2026
  const WINDOW = { year: 2026, month: 9 };
  test('fully exempt customers always; partially covered ones only when EVERY charged method is a bank row or a card valid beyond the window', () => {
    const e = ex(['c-full'], [
      ['c-beyond', new Set(['pm-late'])],          // card expires after the window
      ['c-edge', new Set(['pm-edge'])],            // expires IN the window's last month → still actionable
      ['c-expired', new Set(['pm-old'])],          // expired before the window (absent from any expiring query)
      ['c-bank', new Set(['pm-bank'])],
      ['c-mixed', new Set(['pm-late', 'pm-old'])],
      ['c-norow', new Set(['pm-missing'])],
      ['c-malformed', new Set(['pm-bad'])],
      ['c-unresolved', null],
      ['c-empty', new Set()],
    ]);
    const rows = [
      { id: 'pm-late', method_type: 'card', exp_month: '10', exp_year: '2026' },
      { id: 'pm-edge', method_type: null, exp_month: '9', exp_year: '26' },
      { id: 'pm-old', method_type: 'card', exp_month: '7', exp_year: '2026' },
      { id: 'pm-bank', method_type: 'us_bank_account', exp_month: null, exp_year: null },
      { id: 'pm-bad', method_type: 'card', exp_month: '13', exp_year: '2027' },
    ];
    expect([...cardExpiryAlertResolvableCustomerIds(e, rows, WINDOW)].sort()).toEqual(['c-bank', 'c-beyond', 'c-full']);
  });
  test('legacy 2-digit years normalize (+2000) — a 12/32 card is beyond the window', () => {
    const e = ex([], [['c1', new Set(['pm-legacy'])]]);
    expect([...cardExpiryAlertResolvableCustomerIds(e, [{ id: 'pm-legacy', exp_month: '12', exp_year: '32' }], WINDOW)]).toEqual(['c1']);
  });
  test('malformed / missing input → only the fully exempt set', () => {
    expect([...cardExpiryAlertResolvableCustomerIds(ex(['c1'], [['c2', new Set(['pm-late'])]]), undefined, WINDOW)]).toEqual(['c1']);
    expect([...cardExpiryAlertResolvableCustomerIds(ex(['c1'], [['c2', new Set(['pm-late'])]]), [{ id: 'pm-late', exp_month: '10', exp_year: '2026' }], {})]).toEqual(['c1']);
    expect(cardExpiryAlertResolvableCustomerIds(null, [], WINDOW).size).toBe(0);
    expect([...cardExpiryAlertResolvableCustomerIds({ customerIds: new Set(['c1']) }, [], WINDOW)]).toEqual(['c1']);
  });
});
