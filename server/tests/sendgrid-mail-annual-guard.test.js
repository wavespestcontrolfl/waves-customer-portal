// Codex round 3 on #4608 (structural move, P1 PRRT_kwDOR3YQi86j8Ydm/Ydn):
// the annual-offer guard's AUTHORITATIVE check now lives inside sendOne
// itself — the true provider boundary — not in any higher-level handoff
// (sendTemplate, the provider retry sweep, bounce recovery, a raw caller)
// that could sit above it and be bypassed. These tests prove the boundary
// itself: the guard runs before the SendGrid request, a blocked verdict
// never reaches fetch and throws a distinct non-retryable refusal, and a
// guard LOOKUP failure throws a separately-flagged, distinct error too.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
}));

const { annualHandoffGuard } = require('../services/estimate-annual-guard');

describe('sendgrid-mail sendOne: annual-offer guard at the provider boundary', () => {
  const originalApiKey = process.env.SENDGRID_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    annualHandoffGuard.mockReturnValue(async () => ({ blocked: false, reason: null, estimateId: null }));
    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: jest.fn(() => 'msg-1') },
    }));
  });

  afterEach(() => {
    delete global.fetch;
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = originalApiKey;
  });

  test('the guard runs BEFORE the SendGrid request, with the html/text and explicit estimateIds', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    await sendgrid.sendOne({
      to: 'customer@example.test',
      fromEmail: 'contact@example.test',
      subject: 'Your estimate',
      html: '<p>hello</p>',
      text: 'hello',
      estimateIds: ['est-1'],
    });

    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      db: expect.anything(), estimateIds: ['est-1'], texts: ['<p>hello</p>', 'hello'],
    }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // The guard call must precede the fetch call order-wise.
    expect(annualHandoffGuard.mock.invocationCallOrder[0]).toBeLessThan(global.fetch.mock.invocationCallOrder[0]);
  });

  test('a single estimateId (non-array) is normalized to a one-element list', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    await sendgrid.sendOne({
      to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'S', html: 'h', text: 't',
      estimateIds: 'est-solo',
    });
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({ estimateIds: ['est-solo'] }));
  });

  test('no estimateIds at all defaults to an empty explicit-id list', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    await sendgrid.sendOne({ to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'S', html: 'h', text: 't' });
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({ estimateIds: [] }));
  });

  test('a blocked verdict throws a distinct, non-retryable refusal — fetch is never called', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));
    const sendgrid = require('../services/sendgrid-mail');

    const err = await sendgrid.sendOne({
      to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'S', html: 'h', text: 't', estimateIds: ['est-1'],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.annualOfferWithheld).toBe(true);
    expect(err.code).toBe('ANNUAL_OFFER_WITHHELD');
    expect(err.retryable).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(sendgrid.isAnnualOfferWithheld(err)).toBe(true);
  });

  test('a guard LOOKUP failure throws a separately-flagged, distinct error — fetch is never called', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => { throw new Error('estimates lookup unavailable'); });
    const sendgrid = require('../services/sendgrid-mail');

    const err = await sendgrid.sendOne({
      to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'S', html: 'h', text: 't', estimateIds: ['est-1'],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.annualOfferGuardFailed).toBe(true);
    expect(err.code).toBe('ANNUAL_OFFER_GUARD_FAILED');
    expect(err.annualOfferWithheld).toBeUndefined();
    expect(err.message).toMatch(/estimates lookup unavailable/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(sendgrid.isAnnualOfferWithheld(err)).toBe(false);
  });

  test('a not-blocked verdict sends normally', async () => {
    const sendgrid = require('../services/sendgrid-mail');
    const result = await sendgrid.sendOne({
      to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'S', html: 'h', text: 't',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ messageId: 'msg-1' });
  });
});
