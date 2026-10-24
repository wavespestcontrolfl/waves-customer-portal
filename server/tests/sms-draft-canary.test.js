/**
 * SMS draft-route canary: raises one keyed, open-only alert on a failing
 * routed provider (bad model ID, revoked key, rate-limit denial), texts Adam
 * only for a fresh row, and clears its own row its own row when the route answers again. The durable behavior
 * (one row across restarts) is covered by sms-draft-canary-db.test.js.
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

jest.mock('../services/admin-alert-compose', () => ({
  raiseAdminAlert: jest.fn(),
}));

jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(async () => 1),
}));

jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(async () => ({ sid: 'SM1' })),
}));

const { dispatch } = require('../services/llm/call');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const episodes = require('../services/admin-alert-episodes');
const TwilioService = require('../services/twilio');
const MODELS = require('../config/models');
const { runSmsDraftCanary, CANARY_ROUTES } = require('../services/sms-draft-canary');

// The real composer, so the spec the canary builds is held to the doc's rules.
const { composeAdminAlert } = jest.requireActual('../services/admin-alert-compose');

beforeEach(() => {
  dispatch.mockReset();
  raiseAdminAlert.mockReset();
  raiseAdminAlert.mockResolvedValue({ id: 'n1', deduped: false });
  episodes.openAdminAlertKeys.mockReset();
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  episodes.closeAdminAlertKeys.mockClear();
  TwilioService.sendSMS.mockClear();
  process.env.ADAM_PHONE = '+19415550001';
});

test('probes each distinct route once and stays quiet when healthy', async () => {
  dispatch.mockResolvedValue({ ok: true, text: 'ok', model: 'x' });

  const results = await runSmsDraftCanary();

  expect(results.every((r) => r.ok)).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(CANARY_ROUTES.length);
  expect(dispatch).toHaveBeenCalledWith(MODELS.ROUTES.smsDraftDefault, expect.any(Object));
  expect(dispatch).toHaveBeenCalledWith(MODELS.ROUTES.smsDraftSaveSale, expect.any(Object));
  expect(raiseAdminAlert).not.toHaveBeenCalled();
  expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('failure raises one keyed, open-only, quiet-refresh alert that passes the composer rules', async () => {
  dispatch.mockImplementation(async (route) =>
    route === MODELS.ROUTES.smsDraftDefault
      ? { ok: false, reason: 'openai_404' }
      : { ok: true, text: 'ok', model: 'x' });

  const results = await runSmsDraftCanary();

  expect(results.find((r) => r.key === 'smsDraftDefault')).toMatchObject({ ok: false, reason: 'openai_404' });
  expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
  expect(category).toBe('system');
  expect(() => composeAdminAlert(spec)).not.toThrow();
  expect(spec).toMatchObject({ severity: 'needs-you', doneWhen: 'model_answers' });
  expect(opts).toMatchObject({
    dedupeKey: 'sms-draft-canary:smsDraftDefault',
    dedupeOpenOnly: true,
    refreshOnDedupe: true,
  });
  expect(opts.ringOnRefresh()).toBe(false);
  expect(opts.detail).toContain('openai_404');
  expect(opts.detail).toContain(MODELS.FLAGSHIP);
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  // allowOwnerSms: internal_alert to a known owner phone is otherwise
  // redirected into the notification trigger — the bell already fired above,
  // so without the bypass Adam never gets the out-of-band text.
  expect(TwilioService.sendSMS).toHaveBeenCalledWith(
    process.env.ADAM_PHONE,
    expect.stringContaining('FAILING'),
    expect.objectContaining({ messageType: 'internal_alert', allowOwnerSms: true }),
  );
});

test('every route builds a valid alert spec with its own dedupe key', async () => {
  dispatch.mockResolvedValue({ ok: false, reason: 'no_key' });
  await runSmsDraftCanary();
  const keys = raiseAdminAlert.mock.calls.map((c) => c[2].dedupeKey);
  expect(new Set(keys).size).toBe(CANARY_ROUTES.length);
  for (const [, spec] of raiseAdminAlert.mock.calls) expect(() => composeAdminAlert(spec)).not.toThrow();
});

test('a failure that lands on the standing row sends no text', async () => {
  raiseAdminAlert.mockResolvedValue({ id: 'n1', deduped: true });
  dispatch.mockResolvedValue({ ok: false, reason: 'no_key' });

  await runSmsDraftCanary();

  expect(raiseAdminAlert).toHaveBeenCalledTimes(CANARY_ROUTES.length);
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('a failed bell write still texts Adam', async () => {
  raiseAdminAlert.mockRejectedValue(new Error('db down'));
  dispatch.mockResolvedValue({ ok: false, reason: 'no_key' });

  await runSmsDraftCanary();

  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(CANARY_ROUTES.length);
});

test('recovery closes the open row, texts once, and raises nothing', async () => {
  episodes.openAdminAlertKeys.mockImplementation(async (conn, prefix) => [prefix]);
  dispatch.mockResolvedValue({ ok: true, text: 'ok', model: 'x' });

  await runSmsDraftCanary();

  expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(CANARY_ROUTES.length);
  const [, keys, reason, opts] = episodes.closeAdminAlertKeys.mock.calls[0];
  expect(keys).toEqual(['sms-draft-canary:smsDraftDefault']);
  expect(reason).toBe('route_answering');
  expect(opts.resolution).toMatch(/^Recovered at /);
  expect(raiseAdminAlert).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(CANARY_ROUTES.length);
  expect(TwilioService.sendSMS.mock.calls[0][1]).toMatch(/recovered/);
});

test('success with no open row writes nothing', async () => {
  dispatch.mockResolvedValue({ ok: true, text: 'ok', model: 'x' });

  await runSmsDraftCanary();

  expect(episodes.openAdminAlertKeys).toHaveBeenCalledTimes(CANARY_ROUTES.length);
  expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
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
