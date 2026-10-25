// Unit tests for the W-4 service that need no database: input validation (a
// refused input never reaches the connection) and the proof that the election
// currentW4For() returns is the shape computePaycheck() takes as `w4`.
// Names are synthetic.
jest.mock('../models/db', () => ({}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { computePaycheck } = require('../services/payroll-calc');
const { currentW4For, recordW4, setPayMethod } = require('../services/payroll-w4');
const { etDateString, addETDays } = require('../utils/datetime-et');

const TECH_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const today = etDateString();
const dayFromToday = (n) => etDateString(addETDays(new Date(), n));
const thisYear = Number(today.slice(0, 4));

// A connection that fails the test if anything touches it.
const untouched = Object.assign(() => { throw new Error('connection used'); }, {
  transaction: () => { throw new Error('connection used'); },
  raw: () => { throw new Error('connection used'); },
});

const valid = () => ({
  formYear: 2026, filingStatus: 'married_jointly', step2Checkbox: true,
  step3Amount: '2000.00', step4aOtherIncome: '500', step4bDeductions: '1000.50',
  step4cExtraWithholding: '5', exempt: false, signedOn: dayFromToday(-3), note: 'From the paper form',
});

describe('recordW4 validation', () => {
  const reject = async (patch, message) => {
    await expect(recordW4(TECH_ID, { ...valid(), ...patch }, ACTOR_ID, untouched))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
  };

  it.each([
    ['exponent notation', { step3Amount: '1e3' }, /Step 3/],
    ['negative amount', { step4aOtherIncome: '-1' }, /Step 4\(a\)/],
    ['three decimals', { step4bDeductions: '10.123' }, /Step 4\(b\)/],
    ['text', { step4cExtraWithholding: 'abc' }, /Step 4\(c\)/],
    ['over the cap', { step3Amount: '1000000.01' }, /at most/],
    ['negative number', { step3Amount: -5 }, /Step 3/],
  ])('refuses an amount that is %s', async (_name, patch, message) => reject(patch, message));

  it.each([
    ['a form year before 2020', { formYear: 2019 }, /2020 or later/],
    ['a form year two years ahead', { formYear: thisYear + 2 }, /or earlier/],
    ['a fractional form year', { formYear: 2026.5 }, /Form year/],
    ['an unknown filing status', { filingStatus: 'widowed' }, /filing status/],
    ['a missing filing status', { filingStatus: undefined }, /filing status/],
    ['an impossible signed date', { signedOn: '2026-02-31' }, /real date/],
    ['a signed date in the future', { signedOn: dayFromToday(1) }, /future/],
    ['a missing signed date', { signedOn: undefined }, /Date signed/],
    ['a first pay date before the signed date', { effectiveOn: dayFromToday(-10) }, /before the date signed/],
    ['an impossible first pay date', { effectiveOn: '2026-13-01' }, /real date/],
    ['a note over 500 characters', { note: 'x'.repeat(501) }, /500/],
  ])('refuses %s', async (_name, patch, message) => reject(patch, message));

  it('refuses a field it does not know, so an SSN cannot ride along', async () => {
    await reject({ ssn: '123-45-6789' }, /ssn/);
    await reject({ accountNumber: '000111' }, /accountNumber/);
  });

  it('refuses a technician id that is not a UUID before any query', async () => {
    await expect(recordW4('not-an-id', valid(), ACTOR_ID, untouched)).rejects.toMatchObject({ status: 404 });
  });
});

describe('setPayMethod validation', () => {
  const reject = async (input, message) => {
    await expect(setPayMethod(TECH_ID, input, ACTOR_ID, untouched))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
  };
  it('needs a known method', async () => {
    await reject({ payMethod: 'cash' }, /paper check or bank transfer/);
    await reject({}, /paper check or bank transfer/);
  });
  it('needs the written OK date for a bank transfer', async () => {
    await reject({ payMethod: 'bank_transfer' }, /written OK/);
    await reject({ payMethod: 'bank_transfer', consentOn: '' }, /written OK/);
  });
  it('refuses a future or impossible written OK date', async () => {
    await reject({ payMethod: 'bank_transfer', consentOn: dayFromToday(1) }, /future/);
    await reject({ payMethod: 'bank_transfer', consentOn: '2026-02-30' }, /real date/);
  });
});

describe('currentW4For shape', () => {
  // The row as Postgres returns it: NUMERIC columns come back as strings.
  const row = {
    id: '33333333-3333-4333-8333-333333333333', form_year: 2026, filing_status: 'married_jointly',
    step2_checkbox: true, step3_amount: '2000.00', step4a_other_income: '500.00',
    step4b_deductions: '1000.50', step4c_extra_withholding: '5.00', exempt: false,
    signed_on: '2026-10-20', effective_on: '2026-11-01', note: null, created_at: new Date(),
  };
  const conn = Object.assign(() => ({
    where() { return this; }, orderBy() { return this; }, first: async () => row,
  }), { raw: (sql) => sql });

  it('returns the election in the shape computePaycheck takes as w4', async () => {
    const w4 = await currentW4For(TECH_ID, '2026-11-06', conn);
    expect(w4).toMatchObject({
      formYear: 2026, filingStatus: 'married_jointly', step2Checkbox: true, step3Amount: '2000.00',
      step4aOtherIncome: '500.00', step4bDeductions: '1000.50', step4cExtraWithholding: '5.00',
      exempt: false, signedOn: '2026-10-20', effectiveOn: '2026-11-01',
    });
    const pay = { payDate: '2026-11-06', hourlyRate: '23.00', regularMinutes: '2400.00' };
    const viaService = computePaycheck({ ...pay, w4 });
    // The same election typed by hand, with numbers instead of NUMERIC strings.
    const byHand = computePaycheck({
      ...pay,
      w4: { formYear: 2026, filingStatus: 'married_jointly', step2Checkbox: true, step3Amount: 2000, step4aOtherIncome: 500, step4bDeductions: 1000.5, step4cExtraWithholding: 5, exempt: false },
    });
    expect(viaService).toEqual(byHand);
    expect(JSON.stringify(viaService)).not.toMatch(/NaN|undefined/);
  });

  it('returns null when no election applies yet', async () => {
    const empty = Object.assign(() => ({ where() { return this; }, orderBy() { return this; }, first: async () => undefined }), { raw: (s) => s });
    await expect(currentW4For(TECH_ID, '2026-11-06', empty)).resolves.toBeNull();
  });

  it('refuses a pay date that is not a real date', async () => {
    await expect(currentW4For(TECH_ID, '2026-02-31', conn)).rejects.toThrow(/payDate/);
  });
});
