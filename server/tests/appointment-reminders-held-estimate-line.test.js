// A held call-booking confirmation (quiet hours / grouped move) is delivered
// by the stranded-confirmation sweep through the canonical renderer. The
// re-armed row carries confirmation_estimate_id; the sweep re-verifies the
// pinned estimate and appends the accept line for the account holder's own
// number ONLY (GH codex #3814 r2 P2 follow-up; r1 P1 recipient rule).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/estimate-card-holds', () => ({ cardHoldReminderLine: jest.fn(async () => '') }));
jest.mock('../config/feature-gates', () => ({
  gateEnvValue: jest.fn(() => true),
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/composer-customer-links', () => ({
  resolveConfirmationEstimate: jest.fn(),
  appendEstimateAcceptLine: jest.fn(async (body) => `${body}\n\nYou can accept your estimate and choose your plan here: https://l.example/abc`),
}));

const gates = require('../config/feature-gates');
const { resolveConfirmationEstimate, appendEstimateAcceptLine } = require('../services/composer-customer-links');
const { appendHeldEstimateAcceptLine } = require('../services/appointment-reminders')._test;

const customer = { id: 'c1', phone: '+19415550100' };
const primary = { phone: '(941) 555-0100', role: 'primary' };
const record = { id: 'r1', confirmation_estimate_id: 'e-ok' };
const args = (over = {}) => ({ record, contact: primary, customer, scheduledServiceId: 'v1', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  gates.gateEnvValue.mockReturnValue(true);
  gates.isEnabled.mockReturnValue(true);
  resolveConfirmationEstimate.mockResolvedValue({ id: 'e-ok' });
});

test('appends the accept line for the account holder when the pinned estimate still adopts the visit', async () => {
  const out = await appendHeldEstimateAcceptLine('Booked.', args());
  expect(out).toContain('accept your estimate and choose your plan here: https://l.example/abc');
  expect(resolveConfirmationEstimate).toHaveBeenCalledWith({ customerId: 'c1', scheduledServiceId: 'v1', estimateId: 'e-ok' });
  expect(appendEstimateAcceptLine).toHaveBeenCalledWith('Booked.', { id: 'e-ok' }, { scheduledServiceId: 'v1' });
});

test('a row with no pin renders the plain confirmation and never resolves', async () => {
  expect(await appendHeldEstimateAcceptLine('Booked.', args({ record: { id: 'r1', confirmation_estimate_id: null } }))).toBe('Booked.');
  expect(resolveConfirmationEstimate).not.toHaveBeenCalled();
});

test('service contacts and a primary whose number is not the saved customer phone never get the bearer link', async () => {
  expect(await appendHeldEstimateAcceptLine('Booked.', args({ contact: { phone: '+19415550199', role: 'spouse' } }))).toBe('Booked.');
  expect(await appendHeldEstimateAcceptLine('Booked.', args({ contact: { phone: '+19415550199', role: 'primary' } }))).toBe('Booked.');
  expect(resolveConfirmationEstimate).not.toHaveBeenCalled();
});

test('either gate off at delivery time is a live kill', async () => {
  gates.gateEnvValue.mockReturnValue(false);
  expect(await appendHeldEstimateAcceptLine('Booked.', args())).toBe('Booked.');
  gates.gateEnvValue.mockReturnValue(true);
  gates.isEnabled.mockReturnValue(false);
  expect(await appendHeldEstimateAcceptLine('Booked.', args())).toBe('Booked.');
  expect(resolveConfirmationEstimate).not.toHaveBeenCalled();
});

test('a pin that no longer resolves, or a resolver failure, sends the plain confirmation', async () => {
  resolveConfirmationEstimate.mockResolvedValueOnce(null);
  expect(await appendHeldEstimateAcceptLine('Booked.', args())).toBe('Booked.');
  resolveConfirmationEstimate.mockRejectedValueOnce(new Error('db down'));
  expect(await appendHeldEstimateAcceptLine('Booked.', args())).toBe('Booked.');
  expect(appendEstimateAcceptLine).not.toHaveBeenCalled();
});
