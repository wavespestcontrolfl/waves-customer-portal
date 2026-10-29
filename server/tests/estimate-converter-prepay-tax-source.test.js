/**
 * resolveCommercialPrepayTax passes the estimate's saved property to the tax
 * calculator, and its `source` (shown beside the proposal builder's rate) says
 * when the property's ZIP named the county (GATE_TAX_SERVICE_COUNTY).
 */
jest.mock('../services/tax-calculator', () => ({ calculateTax: jest.fn() }));

const TaxCalculator = require('../services/tax-calculator');
const { resolveCommercialPrepayTax } = require('../services/estimate-converter');

beforeEach(() => TaxCalculator.calculateTax.mockReset());

describe('resolveCommercialPrepayTax source', () => {
  test("passes the estimate's property and names the property's county", async () => {
    TaxCalculator.calculateTax.mockResolvedValue({ rate: 0.06, amount: 0.06, taxable: true, county: 'Charlotte', countySource: 'property' });
    await expect(resolveCommercialPrepayTax('cust-1', { database: 'conn', propertyId: 'prop-1' }))
      .resolves.toEqual({ rate: 0.06, source: 'Charlotte County (property ZIP)' });
    expect(TaxCalculator.calculateTax).toHaveBeenCalledWith(
      'cust-1', 'nonresidential_pest_control', 1, { database: 'conn', isCommercial: true, propertyId: 'prop-1' },
    );
  });

  test("the customer's county keeps its plain label", async () => {
    TaxCalculator.calculateTax.mockResolvedValue({ rate: 0.07, amount: 0.07, taxable: true, county: 'Sarasota' });
    await expect(resolveCommercialPrepayTax('cust-1', { database: 'conn' })).resolves.toEqual({ rate: 0.07, source: 'Sarasota County' });
  });

  test("a property ZIP with no known county says it was the property's", async () => {
    TaxCalculator.calculateTax.mockResolvedValue({ rate: 0.07, amount: 0.07, taxable: true, county: 'unknown', countySource: 'property' });
    await expect(resolveCommercialPrepayTax('cust-1', { propertyId: 'prop-1' }))
      .resolves.toEqual({ rate: 0.07, source: "Florida commercial rate (county not found from the property's ZIP)" });
  });

  test("no property: the customer's ZIP label stays as before", async () => {
    TaxCalculator.calculateTax.mockResolvedValue({ rate: 0.07, amount: 0.07, taxable: true, county: 'unknown' });
    await expect(resolveCommercialPrepayTax('cust-1', {}))
      .resolves.toEqual({ rate: 0.07, source: "Florida commercial rate (county not found from the customer's ZIP)" });
  });
});
