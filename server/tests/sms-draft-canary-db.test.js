/**
 * sms-draft-canary against live Postgres: the FAILING bell is one durable row.
 * Repeated failures update it and ring once, a fresh module (a restart) finds the
 * same row, a success closes it without a new bell, and a success with nothing
 * open writes nothing. The canary's own rules are in sms-draft-canary.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/llm/call', () => ({ dispatch: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({ sid: 'SM1' })) }));

maybeDescribe('sms-draft-canary durable alert (live Postgres)', () => {
  let db;
  let dispatch;
  let TwilioService;
  const PREFIX = 'sms-draft-canary:';

  const rows = () => db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [PREFIX]).orderBy('created_at', 'asc');
  const wipe = () => db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [PREFIX]).del();
  // A fresh copy of the canary, as after a process restart.
  const freshCanary = () => {
    let mod;
    jest.isolateModules(() => { mod = require('../services/sms-draft-canary'); });
    return mod;
  };

  beforeAll(() => {
    db = require('../models/db');
    dispatch = require('../services/llm/call').dispatch;
    TwilioService = require('../services/twilio');
  });
  beforeEach(async () => {
    await wipe();
    dispatch.mockReset();
    TwilioService.sendSMS.mockClear();
    process.env.ADAM_PHONE = '+19415550001';
  });
  afterAll(async () => {
    await wipe();
    await db.destroy();
  });

  test('repeated failures keep one open row and one text; a restart still dedupes', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'openai_401' });
    const { CANARY_ROUTES } = freshCanary();

    await freshCanary().runSmsDraftCanary();
    await freshCanary().runSmsDraftCanary();
    await freshCanary().runSmsDraftCanary();

    const all = await rows();
    expect(all).toHaveLength(CANARY_ROUTES.length);
    expect(all.every((r) => r.done_at === null && r.read_at === null)).toBe(true);
    expect(new Set(all.map((r) => r.metadata.dedupeKey)).size).toBe(CANARY_ROUTES.length);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(CANARY_ROUTES.length);
  });

  test('a changed reason rewrites the standing row without ringing again', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'openai_401' });
    await freshCanary().runSmsDraftCanary();
    await db('notifications').whereRaw("starts_with(metadata->>'dedupeKey', ?)", [PREFIX]).update({ read_at: db.fn.now() });

    dispatch.mockResolvedValue({ ok: false, reason: 'openai_429' });
    await freshCanary().runSmsDraftCanary();

    const all = await rows();
    expect(all.length).toBe(2);
    expect(all.every((r) => r.read_at !== null && r.done_at === null)).toBe(true);
    expect(all.every((r) => r.metadata.reason === 'openai_429')).toBe(true);
  });

  test('success after a failure closes the row with a recovered note and no new bell', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'openai_401' });
    await freshCanary().runSmsDraftCanary();
    const before = await rows();

    dispatch.mockResolvedValue({ ok: true, text: 'ok', model: 'x' });
    await freshCanary().runSmsDraftCanary();

    const after = await rows();
    expect(after).toHaveLength(before.length);
    for (const r of after) {
      expect(r.done_at).not.toBeNull();
      expect(r.resolution).toMatch(/^Recovered at /);
      expect(r.metadata.autoCleared).toBe(true);
    }
  });

  test('a failure after recovery is a fresh row and rings again', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'openai_401' });
    await freshCanary().runSmsDraftCanary();
    dispatch.mockResolvedValue({ ok: true, text: 'ok', model: 'x' });
    await freshCanary().runSmsDraftCanary();
    TwilioService.sendSMS.mockClear();

    dispatch.mockResolvedValue({ ok: false, reason: 'openai_401' });
    const { CANARY_ROUTES } = freshCanary();
    await freshCanary().runSmsDraftCanary();

    const all = await rows();
    expect(all).toHaveLength(CANARY_ROUTES.length * 2);
    expect(all.filter((r) => r.done_at === null)).toHaveLength(CANARY_ROUTES.length);
    // one failing text per route; the recovery text came before the clear
    expect(TwilioService.sendSMS.mock.calls.filter((c) => /FAILING/.test(c[1]))).toHaveLength(CANARY_ROUTES.length);
  });

  test('success with nothing open writes nothing', async () => {
    dispatch.mockResolvedValue({ ok: true, text: 'ok', model: 'x' });
    await freshCanary().runSmsDraftCanary();
    expect(await rows()).toHaveLength(0);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});
