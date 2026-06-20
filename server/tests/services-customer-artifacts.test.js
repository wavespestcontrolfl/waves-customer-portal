jest.mock('../models/db', () => jest.fn());
jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
}));

const servicesRouter = require('../routes/services');

describe('customer services artifact suppression', () => {
  test('detects frozen non-auto-send delivery as customer-artifact suppressed', () => {
    const { parseJsonObject, suppressesCustomerArtifacts } = servicesRouter._test;

    expect(suppressesCustomerArtifacts(
      parseJsonObject(JSON.stringify({ typedReportDelivery: 'disabled' })),
    )).toBe(true);
    expect(suppressesCustomerArtifacts({ typedReportDelivery: 'internal_only' })).toBe(true);
    expect(suppressesCustomerArtifacts({ typedReportDelivery: 'auto_send' })).toBe(false);
    expect(suppressesCustomerArtifacts({})).toBe(false);
  });
});
