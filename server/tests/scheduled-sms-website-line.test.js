/**
 * The scheduled-text dispatcher runs the website-line rule again right before a send
 * (scheduled-sms-delivery.js scheduledWebsiteLineRefusal): a website-only line texts only someone who
 * already called or texted it, and a queued row can change after the writer checked it. The real cron
 * tick, the phone fan-out and the blocked row run on Postgres in scheduled-sms-link-check-postgres.test.js;
 * these cases cover the rail's inputs and its retry. Synthetic names and 555 numbers only.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('no database read expected'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/deferred-replay-registry', () => ({ requiresDurableFinalize: () => false }));
jest.mock('../services/website-line-contact', () => ({ websiteLineRefusal: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({ customerLinkSendRefusal: jest.fn(async () => null) }));
jest.mock('../services/composer-customer-links', () => ({ nestedOwnedLinkRuns: jest.fn(() => []) }));
// The alert is built by the real rules (docs/admin-notifications.md), so copy that breaks one fails here; only the
// write is left out.
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(async (_category, spec) => actual.composeAdminAlert(spec)) };
});
jest.mock('../services/admin-alert-names', () => ({
  ...jest.requireActual('../services/admin-alert-names'),
  lookupCustomerName: jest.fn(async () => 'Fixture Sample'),
}));

const { websiteLineRefusal } = require('../services/website-line-contact');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const logger = require('../services/logger');
const { dispatchScheduledSms } = require('../services/scheduled-sms-delivery');

const WEB_LINE = '+19412542617';
const QUEUED_TO = '+12025550141';
const SENDS_TO = '+12025550142';
const row = () => ({ id: 'queued-1', customer_id: 'customer-1', from_phone: WEB_LINE, to_phone: QUEUED_TO, message_body: 'Synthetic reply.' });
const notSent = { sent: false, deliveryOutcome: 'not_sent' };

beforeEach(() => {
  websiteLineRefusal.mockReset();
  raiseAdminAlert.mockClear();
  logger.warn.mockClear();
});

test('it checks the number the replay sends to, and a refusal blocks the row with one office alert and no number', async () => {
  websiteLineRefusal.mockResolvedValue('WEBSITE_LINE_REFUSAL');
  const send = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
  const result = await dispatchScheduledSms(row(), { human_authored: true, scheduled_sms_attempts: 1 }, send, 'conversational', 3, SENDS_TO);
  expect(websiteLineRefusal).toHaveBeenCalledWith(WEB_LINE, SENDS_TO);
  expect(send).not.toHaveBeenCalled();
  expect(result).toEqual({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: false, code: 'WEBSITE_LINE_REFUSED', reason: 'website_line_first_contact' });
  expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  await expect(raiseAdminAlert.mock.results[0].value).resolves.toMatchObject({
    headline: 'Comms — send the text to Fixture S from another line',
    why: 'It was set to go from a website-only line that this number never called or texted, so it was not sent.',
  });
  expect(raiseAdminAlert.mock.calls[0][2].detail).toBe('A scheduled text to Fixture S was not sent: it was set to go from a website-only line that this number never called or texted. Open Communications to send it from another line.');
  expect(JSON.stringify(raiseAdminAlert.mock.calls[0])).not.toMatch(/555\D?014[12]|254\D?2617/);
});

test('a reply the check passes goes to the send; a row that sends from the customer\'s location line, or texts no one, is not checked', async () => {
  websiteLineRefusal.mockResolvedValue(null);
  const send = jest.fn(async () => notSent);
  // With no recipient given, the check judges the row's own number.
  expect(await dispatchScheduledSms(row(), { human_authored: true }, send, 'conversational')).toBe(notSent);
  expect(websiteLineRefusal).toHaveBeenCalledWith(WEB_LINE, QUEUED_TO);
  expect(send).toHaveBeenCalledTimes(1);

  websiteLineRefusal.mockClear();
  expect(await dispatchScheduledSms(row(), { resolve_from_by_customer: true }, send, 'appointment', 3, SENDS_TO)).toBe(notSent);
  // A registered Email-only billing replay has no phone: it texts no one.
  expect(await dispatchScheduledSms(row(), { entry_point: 'fixture_email_only' }, send, 'billing', 3, null)).toBe(notSent);
  expect(websiteLineRefusal).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(3);
  expect(raiseAdminAlert).not.toHaveBeenCalled();
});

test('a failed read goes back on the retry rail with no alert; on the last attempt the row ends blocked with one alert', async () => {
  websiteLineRefusal.mockRejectedValue(new Error('synthetic read failure'));
  const send = jest.fn(async () => notSent);
  expect(await dispatchScheduledSms(row(), { human_authored: true, scheduled_sms_attempts: 1 }, send, 'conversational', 3, SENDS_TO))
    .toEqual({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, code: 'WEBSITE_LINE_REFUSED', reason: 'website_line_unverified' });
  expect(raiseAdminAlert).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith('[scheduled-sms] website-line contact read failed for queued-1: synthetic read failure');

  expect(await dispatchScheduledSms(row(), { human_authored: true, scheduled_sms_attempts: 3 }, send, 'conversational', 3, SENDS_TO))
    .toMatchObject({ blocked: true, retryable: false, code: 'WEBSITE_LINE_REFUSED', reason: 'website_line_unverified' });
  expect(send).not.toHaveBeenCalled();
  expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  await expect(raiseAdminAlert.mock.results[0].value).resolves.toMatchObject({
    why: 'The website-only line it was set to go from could not be checked, so it was not sent.',
  });
});
