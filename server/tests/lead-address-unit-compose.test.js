/**
 * leads.address is a single free-text column — the unit captured in
 * address_line2 must be composed into it, or the lead card, pipeline card, and
 * estimate prefill (LeadsTabs → params.address) all drop the caller's unit
 * while the customer row keeps it (prod, 2026-08-29).
 */

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  logGateStatus: jest.fn(),
}));

const { composeLeadAddress } = require('../services/call-recording-processor')._test;

describe('composeLeadAddress', () => {
  test('appends the unit to the street', () => {
    expect(composeLeadAddress('100 Main St', 'Apt 4')).toBe('100 Main St, Apt 4');
    expect(composeLeadAddress('100 Main St', '#4')).toBe('100 Main St, #4');
  });

  test('street alone when no unit', () => {
    expect(composeLeadAddress('100 Main St', null)).toBe('100 Main St');
    expect(composeLeadAddress('100 Main St', '   ')).toBe('100 Main St');
  });

  test('null when no street (fill-if-empty guard upstream never writes a bare unit)', () => {
    expect(composeLeadAddress('', 'Apt 4')).toBeNull();
    expect(composeLeadAddress(null, null)).toBeNull();
  });

  test('does not duplicate a unit the street already embeds', () => {
    expect(composeLeadAddress('100 Main St Apt 4', 'Apt 4')).toBe('100 Main St Apt 4');
    expect(composeLeadAddress('100 Main St #4', 'Unit 4')).toBe('100 Main St #4');
  });

  test('a different embedded unit is not treated as a duplicate', () => {
    expect(composeLeadAddress('100 Main St Apt 4', 'Apt 5')).toBe('100 Main St Apt 4, Apt 5');
  });
});
