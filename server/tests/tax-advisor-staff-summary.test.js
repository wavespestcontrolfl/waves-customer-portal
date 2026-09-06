// The weekly tax prompt's headcount line reads technicians.employment_status
// live instead of naming one person (Field Team Program, Phase 0 item 4).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('@anthropic-ai/sdk', () => null);
jest.mock('../services/twilio', () => ({}));

const db = require('../models/db');
const logger = require('../services/logger');
const TaxAdvisor = require('../services/tax-advisor');

function rowsChain(rows) {
  const chain = {};
  chain.where = jest.fn((filter) => { chain.filter = filter; return chain; });
  chain.select = jest.fn(async () => rows);
  return chain;
}

beforeEach(() => jest.clearAllMocks());

describe('TaxAdvisor.getStaffSummary', () => {
  test('classifies ACTIVE rows by payroll employment_type — an unclassified owner/admin login is not an employee', async () => {
    const chain = rowsChain([{ employment_type: null }]);
    db.mockReturnValue(chain);
    const out = await TaxAdvisor.getStaffSummary();
    expect(out).toMatch(/^0 W-2 employees, 0 1099 contractors, 1 active staff login with no payroll classification/);
    expect(db).toHaveBeenCalledWith('technicians');
    // prospective placeholders and offboarded rows are excluded up front
    expect(chain.filter).toEqual({ employment_status: 'active' });
    expect(chain.select).toHaveBeenCalledWith('employment_type');
  });

  test('W-2 and 1099 rows are counted separately; never a name', async () => {
    db.mockReturnValue(rowsChain([
      { employment_type: 'w2' }, { employment_type: 'w2' }, { employment_type: '1099' }, { employment_type: null },
    ]));
    const out = await TaxAdvisor.getStaffSummary();
    expect(out).toMatch(/^2 W-2 employees, 1 1099 contractor, 1 active staff login with no payroll classification/);
    expect(out).not.toMatch(/Adam/);
  });

  test('a failed read degrades to a neutral line and warns', async () => {
    db.mockImplementation(() => { throw new Error('relation missing'); });
    await expect(TaxAdvisor.getStaffSummary()).resolves.toBe('owner-operator plus staff (live payroll classification unavailable)');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('staff count failed'));
  });
});
