/**
 * The applicant sender number equals what services/twilio.js would actually
 * send from for a customer-less send (deriveOutboundNumber → the Bradenton
 * line), under the REAL number configuration — the reply classifier's
 * number check depends on the two agreeing.
 */
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

test('outboundNumberForApplicants resolves the same line services/twilio.js derives for a customer-less send', async () => {
  const TwilioService = require('../services/twilio');
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const { outboundNumberForApplicants } = require('../services/recruiting-comms');
  const ours = await outboundNumberForApplicants();
  const theirs = await TwilioService.deriveOutboundNumber({});
  expect(ours).toBe(theirs);
  expect(ours).toBe(TWILIO_NUMBERS.getOutboundNumber('bradenton'));
  expect(typeof ours).toBe('string');
});
