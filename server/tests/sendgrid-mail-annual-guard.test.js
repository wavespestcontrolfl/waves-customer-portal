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
  // Round 9 structural fix (P1): sendOne resolves the rewrite-vs-refuse
  // policy through this — default 'refuse' (like the real function for any
  // non-receipt templateKey) so these pre-existing tests are unaffected;
  // the rewrite path itself is covered by sendgrid-mail-annual-guard-
  // rewrite.test.js.
  withheldLinkPolicyForTemplate: jest.fn(() => 'refuse'),
  rewriteWithheldEstimateLinks: jest.fn(async ({ html, text }) => ({ html, text, rewrittenIds: [] })),
}));

const { annualHandoffGuard, withheldLinkPolicyForTemplate, rewriteWithheldEstimateLinks } = require('../services/estimate-annual-guard');

describe('sendgrid-mail sendOne: annual-offer guard at the provider boundary', () => {
  const originalApiKey = process.env.SENDGRID_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    annualHandoffGuard.mockReturnValue(async () => ({ blocked: false, reason: null, estimateId: null }));
    withheldLinkPolicyForTemplate.mockReturnValue('refuse');
    rewriteWithheldEstimateLinks.mockImplementation(async ({ html, text }) => ({ html, text, rewrittenIds: [] }));
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

// Round 9 structural fix (P1): the rewrite-vs-refuse policy decision — and
// the rewrite itself — moved to sendOne, the true provider boundary, so it
// fires identically for a fresh sendTemplate call, the automatic retry
// sweep, and bounce recovery (none of which composed it before: only
// email-template-library.js's own sendTemplate had an opinion, via a
// caller-supplied withheldLinkPolicy the retry/bounce-recovery paths never
// passed). Policy is resolved from `templateKey` via estimate-annual-
// guard.js's withheldLinkPolicyForTemplate unless the caller passes an
// explicit `withheldLinkPolicy` override.
describe('sendgrid-mail sendOne: withheldLinkPolicy rewrite at the provider boundary (round 9 P1)', () => {
  const originalApiKey = process.env.SENDGRID_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    annualHandoffGuard.mockReturnValue(async () => ({ blocked: false, reason: null, estimateId: null }));
    withheldLinkPolicyForTemplate.mockReturnValue('refuse');
    rewriteWithheldEstimateLinks.mockImplementation(async ({ html, text }) => ({ html, text, rewrittenIds: [] }));
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

  test('templateKey resolving to "rewrite" rewrites the content, strips explicit ids, and sends — never refuses', async () => {
    withheldLinkPolicyForTemplate.mockReturnValue('rewrite');
    rewriteWithheldEstimateLinks.mockResolvedValueOnce({
      html: '<p>https://portal.wavespestcontrol.com</p>',
      text: 'https://portal.wavespestcontrol.com',
      rewrittenIds: ['est-1'],
    });
    const sendgrid = require('../services/sendgrid-mail');

    const result = await sendgrid.sendOne({
      to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'Your receipt',
      html: '<p>https://portal.example/estimate/withheld-tok</p>', text: 'https://portal.example/estimate/withheld-tok',
      estimateIds: ['est-1'], templateKey: 'deposit.receipt',
    });

    expect(withheldLinkPolicyForTemplate).toHaveBeenCalledWith('deposit.receipt');
    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledWith(expect.objectContaining({
      html: '<p>https://portal.example/estimate/withheld-tok</p>', text: 'https://portal.example/estimate/withheld-tok',
    }));
    // The guard runs on the REWRITTEN content with the withheld id stripped
    // — forcing the original id through would refuse anyway, defeating the
    // rewrite.
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      estimateIds: [], texts: ['<p>https://portal.wavespestcontrol.com</p>', 'https://portal.wavespestcontrol.com'],
    }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentBody.content).toEqual(expect.arrayContaining([
      { type: 'text/html', value: '<p>https://portal.wavespestcontrol.com</p>' },
    ]));
    // html/text ride along on the result too — so a caller with its own
    // durable snapshot (email-template-library.js, the retry sweep, bounce
    // recovery) can persist the exact bytes actually sent.
    expect(result).toEqual({
      messageId: 'msg-1', withheldLinksRewritten: ['est-1'],
      html: '<p>https://portal.wavespestcontrol.com</p>', text: 'https://portal.wavespestcontrol.com',
    });
  });

  test('an explicit withheldLinkPolicy override wins over the template-keyed default', async () => {
    withheldLinkPolicyForTemplate.mockReturnValue('refuse');
    rewriteWithheldEstimateLinks.mockResolvedValueOnce({
      html: '<p>rewritten</p>', text: 'rewritten', rewrittenIds: ['est-2'],
    });
    const sendgrid = require('../services/sendgrid-mail');

    await sendgrid.sendOne({
      to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'S',
      html: '<p>orig</p>', text: 'orig', templateKey: 'some.unrelated_template', withheldLinkPolicy: 'rewrite',
    });

    // withheldLinkPolicyForTemplate is never even consulted — the explicit
    // override short-circuits it.
    expect(withheldLinkPolicyForTemplate).not.toHaveBeenCalled();
    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledTimes(1);
  });

  test('nothing to rewrite in the content (rewrittenIds empty): sends the original render, no marker on the result', async () => {
    withheldLinkPolicyForTemplate.mockReturnValue('rewrite');
    const sendgrid = require('../services/sendgrid-mail');

    const result = await sendgrid.sendOne({
      to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'S',
      html: '<p>no links here</p>', text: 'no links here', templateKey: 'deposit.receipt',
    });

    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      estimateIds: [], texts: ['<p>no links here</p>', 'no links here'],
    }));
    expect(result).toEqual({ messageId: 'msg-1' });
    expect(result.withheldLinksRewritten).toBeUndefined();
  });

  test('a non-receipt templateKey (policy resolves "refuse") still refuses a withheld send — never silently rewrites', async () => {
    withheldLinkPolicyForTemplate.mockReturnValue('refuse');
    annualHandoffGuard.mockReturnValue(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-3' }));
    const sendgrid = require('../services/sendgrid-mail');

    const err = await sendgrid.sendOne({
      to: 'customer@example.test', fromEmail: 'contact@example.test', subject: 'S',
      html: '<p>https://portal.example/estimate/withheld-tok</p>', text: 't',
      estimateIds: ['est-3'], templateKey: 'service.visit_summary',
    }).catch((e) => e);

    expect(rewriteWithheldEstimateLinks).not.toHaveBeenCalled();
    expect(err.annualOfferWithheld).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
