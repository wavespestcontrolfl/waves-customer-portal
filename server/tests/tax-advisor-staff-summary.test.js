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

function countChain(count) {
  const chain = {};
  chain.where = jest.fn((filter) => { chain.filter = filter; return chain; });
  chain.count = jest.fn(async () => [{ count }]);
  return chain;
}

beforeEach(() => jest.clearAllMocks());

describe('TaxAdvisor.getStaffSummary', () => {
  test('one active row = the owner-operator alone', async () => {
    const chain = countChain('1');
    db.mockReturnValue(chain);
    await expect(TaxAdvisor.getStaffSummary()).resolves.toBe('owner-operator, no other employees');
    expect(db).toHaveBeenCalledWith('technicians');
    // prospective placeholders and offboarded rows are not employees
    expect(chain.filter).toEqual({ employment_status: 'active' });
  });

  test('several active rows report the live count, never a name', async () => {
    db.mockReturnValue(countChain('3'));
    const out = await TaxAdvisor.getStaffSummary();
    expect(out).toBe('3 active staff on payroll including the owner-operator');
    expect(out).not.toMatch(/Adam/);
  });

  test('a failed read degrades to a neutral line and warns', async () => {
    db.mockImplementation(() => { throw new Error('relation missing'); });
    await expect(TaxAdvisor.getStaffSummary()).resolves.toBe('owner-operator plus staff (live count unavailable)');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('staff count failed'));
  });
});
