/**
 * SMS draft-route canary: alerts on a failing routed provider (bad model ID,
 * revoked key, rate-limit denial), stays quiet while a known failure persists
 * (< 24h), re-alerts on a reason change, and sends a recovery notice.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn(async () => true) };
  return fn;
});

jest.mock('../services/llm/call', () => ({
  dispatch: jest.fn(),
}));

jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })),
}));

jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(async () => ({ sid: 'SM1' })),
}));

const { dispatch } = require('../services/llm/call');
const NotificationService = require('../services/notification-service');
const TwilioService = require('../services/twilio');
const MODELS = require('../config/models');
const { runSmsDraftCanary, CANARY_ROUTES, _test } = require('../services/sms-draft-canary');

beforeEach(() => {
  dispatch.mockReset();
  NotificationService.notifyAdmin.mockClear();
  TwilioService.sendSMS.mockClear();
  _test.state.clear();
  process.env.ADAM_PHONE = '+19415550001';
});

test('probes each distinct route once and stays quiet when healthy', async () => {
  dispatch.mockResolvedValue({ ok: true, text: 'ok', model: 'x' });

  const results = await runSmsDraftCanary();

  expect(results.every((r) => r.ok)).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(CANARY_ROUTES.length);
  expect(dispatch).toHaveBeenCalledWith(MODELS.ROUTES.smsDraftDefault, expect.any(Object));
  expect(dispatch).toHaveBeenCalledWith(MODELS.ROUTES.smsDraftSaveSale, expect.any(Object));
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('failure alerts immediately with the reason and fallback model', async () => {
  dispatch.mockImplementation(async (route) =>
    route === MODELS.ROUTES.smsDraftDefault
      ? { ok: false, reason: 'openai_404' }
      : { ok: true, text: 'ok', model: 'x' });

  const results = await runSmsDraftCanary();

  expect(results.find((r) => r.key === 'smsDraftDefault')).toMatchObject({ ok: false, reason: 'openai_404' });
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  const [, title, body] = NotificationService.notifyAdmin.mock.calls[0];
  expect(title).toMatch(/FAILING/);
  expect(body).toContain('openai_404');
  expect(body).toContain(MODELS.FLAGSHIP);
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  // allowOwnerSms: internal_alert to a known owner phone is otherwise
  // redirected into the notification trigger — the bell already fired above,
  // so without the bypass Adam never gets the out-of-band text.
  expect(TwilioService.sendSMS).toHaveBeenCalledWith(
    process.env.ADAM_PHONE,
    expect.any(String),
    expect.objectContaining({ messageType: 'internal_alert', allowOwnerSms: true }),
  );
});

test('same persisting failure does not re-alert within 24h; reason change does', async () => {
  dispatch.mockResolvedValue({ ok: false, reason: 'no_key' });
  await runSmsDraftCanary();
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(CANARY_ROUTES.length);

  NotificationService.notifyAdmin.mockClear();
  TwilioService.sendSMS.mockClear();
  await runSmsDraftCanary(); // same reason, same day → silent
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();

  dispatch.mockResolvedValue({ ok: false, reason: 'openai_429' });
  await runSmsDraftCanary(); // reason changed → alert again
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(CANARY_ROUTES.length);
});

test('recovery after a failure sends a recovery notice', async () => {
  dispatch.mockResolvedValue({ ok: false, reason: 'openai_401' });
  await runSmsDraftCanary();
  NotificationService.notifyAdmin.mockClear();

  dispatch.mockResolvedValue({ ok: true, text: 'ok', model: 'x' });
  await runSmsDraftCanary();

  const titles = NotificationService.notifyAdmin.mock.calls.map((c) => c[1]);
  expect(titles.every((t) => /recovered/.test(t))).toBe(true);
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(CANARY_ROUTES.length);
});

test('empty routed response counts as a failure', async () => {
  dispatch.mockResolvedValue({ ok: true, text: '   ', model: 'x' });

  const results = await runSmsDraftCanary();

  expect(results.every((r) => r.ok === false && r.reason === 'empty_response')).toBe(true);
});

test('a crashing probe never throws out of the canary', async () => {
  dispatch.mockRejectedValue(new Error('socket hang up'));

  await expect(runSmsDraftCanary()).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ ok: false })]),
  );
});
