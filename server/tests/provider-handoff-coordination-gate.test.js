const mockGate = { enabled: false, activatedAt: null };

jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'smsGratitudeReplies' && mockGate.enabled),
  gateEnvTimestamp: jest.fn(() => mockGate.activatedAt),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  canonicalCoordinationApplies,
  directCoordinationApplies,
} = require('../services/messaging/provider-handoff-reservation');

const customerSms = { audience: 'customer', channel: 'sms' };

beforeEach(() => {
  mockGate.enabled = false;
  mockGate.activatedAt = null;
});

test('a never-activated dark lane coordinates nothing', () => {
  expect(canonicalCoordinationApplies(customerSms)).toBe(false);
  expect(directCoordinationApplies({ messageType: 'manual' })).toBe(false);
});

test.each([
  ['the gate is on', true, null],
  ['the gate was disabled after activation', false, new Date('2026-09-24T12:00:00Z')],
])('generic sends publish provider reservations while %s', (_label, enabled, activatedAt) => {
  // An older instance can still claim during a rolling disable, and a
  // retained uncertain claim outlives the gate, so publication must too.
  mockGate.enabled = enabled;
  mockGate.activatedAt = activatedAt;
  expect(canonicalCoordinationApplies(customerSms)).toBe(true);
  expect(directCoordinationApplies({ messageType: 'manual' })).toBe(true);
  expect(directCoordinationApplies({ messageType: 'internal_alert' })).toBe(false);
});
