/**
 * Follow-up emails hold while the customer is signing up.
 *
 * 8 of 176 estimate follow-up emails since Aug 28 went out 1-3 minutes before
 * the customer accepted (the engaged-moment rules fire ~1 minute after a page
 * view). estimateMidCheckout is the shared answer: a live visit-time hold for
 * the estimate, or a card step touched in the last 20 minutes. safetyGate (the
 * legacy stages, the payment-step stage and the deferred-text replay) skips on
 * it; the engagement engine defers on it (its own suite).
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((key) => key !== 'sendRequiresServerPricing'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: (s) => String(s || ''),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => null),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceInterest: jest.fn(() => ''),
}));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => null),
}));
const mockPdf = { copy: { attachments: [], payload: {} } };
jest.mock('../services/estimate-email-pdf', () => ({
  openEstimateEmailPdf: jest.fn(async () => mockPdf.copy),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const EmailTemplateLibrary = require('../services/email-template-library');
const { _private } = require('../services/estimate-follow-up');

// A knex-builder stub per table: every chain method returns the builder, and
// first() resolves the row the test set for that table (or rejects with an error).
function tableStub(result) {
  const calls = { where: [], whereIn: [], whereRaw: [] };
  const b = {};
  b.where = jest.fn((arg) => { calls.where.push(arg); return b; });
  b.whereIn = jest.fn((col, ids) => { calls.whereIn.push([col, ids]); return b; });
  b.whereRaw = jest.fn((sql, bindings) => { calls.whereRaw.push([sql, bindings]); return b; });
  b.first = jest.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
  b.calls = calls;
  return b;
}

function arrange({ hold = undefined, card = undefined } = {}) {
  const stubs = { scheduled_services: tableStub(hold), estimate_checkout_events: tableStub(card) };
  db.mockImplementation((table) => stubs[table] || tableStub(undefined));
  return stubs;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('estimateMidCheckout', () => {
  test('a live visit-time hold for the estimate means the customer is booking', async () => {
    const stubs = arrange({ hold: { id: 'hold-1' } });

    await expect(_private.estimateMidCheckout('est-1')).resolves.toBe(true);

    // The hold row is found by the estimate it was made for, still unexpired.
    expect(stubs.scheduled_services.calls.whereIn).toEqual([['source_estimate_id', ['est-1']]]);
    expect(stubs.scheduled_services.calls.whereRaw[0][0]).toMatch(/reservation_expires_at > NOW\(\)/);
  });

  test('a card step touched in the last 20 minutes means the customer is booking', async () => {
    const stubs = arrange({ hold: undefined, card: { id: 'evt-1' } });

    await expect(_private.estimateMidCheckout('est-1')).resolves.toBe(true);

    expect(_private.CHECKOUT_ACTIVE_MINUTES).toBe(20);
    expect(stubs.estimate_checkout_events.calls.whereIn).toEqual([['estimate_id', ['est-1']]]);
    expect(stubs.estimate_checkout_events.calls.whereRaw[0]).toEqual([
      'updated_at > NOW() - make_interval(mins => ?)',
      [20],
    ]);
  });

  test('no hold and no recent card step: the customer is not booking', async () => {
    arrange();
    await expect(_private.estimateMidCheckout('est-1')).resolves.toBe(false);
  });

  test('a lookup error fails open (a held email only delays) and logs the code alone', async () => {
    arrange({ hold: Object.assign(new Error('select * from x where phone = 5551234'), { code: '42P01' }) });

    await expect(_private.estimateMidCheckout('est-1')).resolves.toBe(false);

    const logged = logger.warn.mock.calls.map((c) => c[0]).join(' ');
    expect(logged).toContain('42P01');
    expect(logged).not.toContain('5551234');
  });

  test('a grouped estimate looks for a hold or card step on EVERY estimate in the group, published or not', async () => {
    // One plain read of the group's ids; no link lister that could drop a sibling.
    const estimates = tableStub(undefined);
    estimates.select = jest.fn(() => Promise.resolve([{ id: 'est-1' }, { id: 'est-2' }, { id: 'est-3' }]));
    const stubs = { estimates, scheduled_services: tableStub(undefined), estimate_checkout_events: tableStub({ id: 'evt-2' }) };
    db.mockImplementation((table) => stubs[table] || tableStub(undefined));

    await expect(_private.estimateMidCheckout('est-1', { groupId: 'grp-1' })).resolves.toBe(true);

    expect(estimates.calls.where).toEqual([{ estimate_group_id: 'grp-1' }]);
    expect(stubs.scheduled_services.calls.whereIn).toEqual([['source_estimate_id', ['est-1', 'est-2', 'est-3']]]);
    expect(stubs.estimate_checkout_events.calls.whereIn).toEqual([['estimate_id', ['est-1', 'est-2', 'est-3']]]);
  });

  test('an unreadable group is not "no checkout": the replay holds, the cron fails open', async () => {
    const estimates = tableStub(undefined);
    estimates.select = jest.fn(() => Promise.reject(Object.assign(new Error('db down'), { code: '57P01' })));
    db.mockImplementation((table) => (table === 'estimates' ? estimates : tableStub(undefined)));

    await expect(_private.estimateMidCheckout('est-1', { groupId: 'grp-1', throwOnError: true })).rejects.toThrow('db down');
    await expect(_private.estimateMidCheckout('est-1', { groupId: 'grp-1' })).resolves.toBe(false);
  });

  test('reads through the connection it is given (the engine passes its snapshot transaction)', async () => {
    const trx = jest.fn((table) => tableStub(table === 'estimate_checkout_events' ? { id: 'evt-1' } : undefined));
    await expect(_private.estimateMidCheckout('est-1', { conn: trx })).resolves.toBe(true);
    expect(trx).toHaveBeenCalledWith('scheduled_services');
    expect(trx).toHaveBeenCalledWith('estimate_checkout_events');
    expect(db).not.toHaveBeenCalled();
  });

  test('with throwOnError (the deferred replay) a lookup error propagates instead of reading "not booking"', async () => {
    arrange({ hold: Object.assign(new Error('db down'), { code: '57P01' }) });
    await expect(_private.estimateMidCheckout('est-1', { throwOnError: true })).rejects.toThrow('db down');
  });
});

describe('safetyGate', () => {
  const est = { id: 'est-1', status: 'viewed', customer_id: null, customer_phone: null, customer_email: 'pat@example.com' };

  test('skips a send while the customer is mid-checkout, and says why', async () => {
    arrange({ hold: { id: 'hold-1' } });
    const gate = await _private.safetyGate(est, new Date('2026-11-19T15:00:00Z'));
    expect(gate).toEqual({ skip: true, reason: 'customer-mid-checkout' });
  });

  test('lets the send through when the customer is not booking', async () => {
    arrange();
    const gate = await _private.safetyGate(est, new Date('2026-11-19T15:00:00Z'));
    expect(gate).toEqual({ skip: false });
  });
});

describe('deferredFollowupStillEligible (quiet-hours text replay)', () => {
  const { deferredFollowupStillEligible } = require('../services/estimate-follow-up');
  const NOW = new Date('2026-11-19T15:00:00Z');

  // The estimates row comes from the stub for 'estimates'; the checkout tables
  // from arrange()-style stubs. customer id, phone and email are all null so
  // the reply check (which throws on replay) has nothing to look up.
  // Any other table (the reply-pause reads) answers "no rows" to any chain.
  function emptyBuilder() {
    const b = new Proxy(() => {}, {
      get: (_t, prop) => (prop === 'then' ? (resolve) => resolve(undefined) : () => b),
    });
    return b;
  }

  function arrangeReplay({ hold, card, est: estOverrides = {} } = {}) {
    const est = { id: 'est-1', status: 'viewed', customer_id: null, customer_phone: null, customer_email: null, ...estOverrides };
    const stubs = {
      estimates: tableStub(est),
      scheduled_services: tableStub(hold),
      estimate_checkout_events: tableStub(card),
    };
    db.mockImplementation((table) => stubs[table] || emptyBuilder());
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a customer who is mid-checkout gets a retryable verdict that returns after the 20-minute window', async () => {
    arrangeReplay({ hold: { id: 'hold-1' } });

    const verdict = await deferredFollowupStillEligible('est-1');

    expect(verdict).toMatchObject({ eligible: false, reason: 'customer-mid-checkout', retryable: true });
    expect(verdict.retryAt).toEqual(new Date(NOW.getTime() + 20 * 60000));
  });

  test('a recent page view (last_viewed_at set) is a retryable wait, never a stale verdict, with or without checkout', async () => {
    const viewedAt = new Date(NOW.getTime() - 10 * 60000);
    // Reopened the estimate and started checkout: the gate answers recently-opened first.
    arrangeReplay({ hold: { id: 'hold-1' }, est: { last_viewed_at: viewedAt } });

    const verdict = await deferredFollowupStillEligible('est-1');

    expect(verdict).toMatchObject({ eligible: false, reason: 'recently-opened', retryable: true });
    // Retries when the 2-hour view window ends.
    expect(verdict.retryAt).toEqual(new Date(viewedAt.getTime() + 2 * 3600000));
  });

  test('a view older than the window no longer holds the replay', async () => {
    arrangeReplay({ est: { last_viewed_at: new Date(NOW.getTime() - 3 * 3600000) } });
    await expect(deferredFollowupStillEligible('est-1')).resolves.toEqual({ eligible: true });
  });

  test('a terminal estimate is still a final verdict, not a retry', async () => {
    arrangeReplay({ est: { status: 'accepted' } });
    await expect(deferredFollowupStillEligible('est-1')).resolves.toEqual({ eligible: false, reason: 'terminal-status:accepted' });
  });

  test('the unopened-estimate reminder is final once the estimate was opened; other stages keep the timed retry', async () => {
    const viewedAt = new Date(NOW.getTime() - 10 * 60000);
    arrangeReplay({ est: { viewed_at: viewedAt, last_viewed_at: viewedAt } });

    await expect(deferredFollowupStillEligible('est-1', { stage: 'unviewed' }))
      .resolves.toEqual({ eligible: false, reason: 'estimate-viewed' });
    for (const stage of ['viewed', 'final', 'expiring', null]) {
      const verdict = await deferredFollowupStillEligible('est-1', { stage });
      expect(verdict).toMatchObject({ reason: 'recently-opened', retryable: true });
    }
  });

  test('an expiring text whose quoted deadline changed while it waited is final, even mid-checkout or after a view', async () => {
    const quoted = new Date('2026-11-25T15:00:00Z');
    const viewedAt = new Date(NOW.getTime() - 10 * 60000);
    arrangeReplay({ hold: { id: 'hold-1' }, est: { expires_at: new Date('2026-12-02T15:00:00Z'), last_viewed_at: viewedAt, viewed_at: viewedAt } });

    await expect(deferredFollowupStillEligible('est-1', { stage: 'expiring', quotedExpiresAt: quoted.toISOString() }))
      .resolves.toEqual({ eligible: false, reason: 'deadline-changed' });
  });

  test('an unchanged quoted deadline keeps the timed retry; a row without the stamp skips the check', async () => {
    const expires = new Date('2026-11-25T15:00:00Z');
    const viewedAt = new Date(NOW.getTime() - 10 * 60000);
    arrangeReplay({ est: { expires_at: expires, last_viewed_at: viewedAt, viewed_at: viewedAt } });

    await expect(deferredFollowupStillEligible('est-1', { stage: 'expiring', quotedExpiresAt: expires.toISOString() }))
      .resolves.toMatchObject({ reason: 'recently-opened', retryable: true });
    await expect(deferredFollowupStillEligible('est-1', { stage: 'expiring' }))
      .resolves.toMatchObject({ reason: 'recently-opened', retryable: true });
  });

  test('the unopened-estimate reminder on an estimate that was never opened stays eligible', async () => {
    arrangeReplay();
    await expect(deferredFollowupStillEligible('est-1', { stage: 'unviewed' })).resolves.toEqual({ eligible: true });
  });

  test('a lookup error on the checkout check fails closed and retryable (never authorizes the replay)', async () => {
    arrangeReplay({ hold: Object.assign(new Error('db down'), { code: '57P01' }) });

    await expect(deferredFollowupStillEligible('est-1')).resolves.toEqual({
      eligible: false,
      reason: 'recheck-failed',
      retryable: true,
    });
  });

  test('no checkout activity: the replay stays eligible', async () => {
    arrangeReplay();
    await expect(deferredFollowupStillEligible('est-1')).resolves.toEqual({ eligible: true });
  });
});

describe('provider-boundary checkout check (sendDualChannel with an outcome)', () => {
  const est = { id: 'est-1', status: 'sent', customer_id: null, customer_phone: null, customer_email: 'pat@example.com', estimate_group_id: null };
  const email = { templateKey: 'estimate.engage_x', stage: 'engage_x', payload: {} };

  beforeEach(() => {
    mockPdf.copy = { attachments: [], payload: {} };
    EmailTemplateLibrary.sendTemplate.mockClear();
  });

  // Hands the library's dispatch to the installed handoff; returns the check it was given.
  async function installedCheck(outcome) {
    await _private.sendDualChannel(est, { email }, outcome);
    const handoff = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].withProviderHandoff;
    let check;
    await handoff(async (_database, providerCheck) => { check = providerCheck; });
    return check;
  }

  test('a customer who starts checkout after preparation vetoes the send at the provider boundary and says why', async () => {
    arrange();
    const outcome = {};
    const check = await installedCheck(outcome);
    // Idle when the email was prepared; booking by the time the request is due.
    arrange({ hold: { id: 'hold-1' } });

    await expect(check()).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'customer_mid_checkout' });
    expect(outcome.midCheckout).toBe(true);
  });

  test('an idle customer passes the boundary check', async () => {
    arrange();
    const outcome = {};
    const check = await installedCheck(outcome);
    await expect(check()).resolves.toEqual({ ok: true });
    expect(outcome.midCheckout).toBeUndefined();
  });

  test('runs after the PDF fence; a PDF veto stops it first and is not read as a checkout hold', async () => {
    arrange({ hold: { id: 'hold-1' } });
    const pdfCheck = jest.fn(async () => { throw Object.assign(new Error('pdf veto'), { providerBoundaryBlocked: true, reason: 'estimate_changed_since_render' }); });
    mockPdf.copy = { attachments: [], payload: {}, withProviderHandoff: async (dispatch) => { await dispatch(undefined, pdfCheck); return { ok: true }; } };
    const outcome = {};
    const check = await installedCheck(outcome);

    await expect(check()).rejects.toMatchObject({ reason: 'estimate_changed_since_render' });
    expect(outcome.midCheckout).toBeUndefined();
  });

  test('without an outcome (the stage cron: legacy and payment-step sends) the same veto applies', async () => {
    arrange();
    await _private.sendDualChannel(est, { email });
    const handoff = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].withProviderHandoff;
    let check;
    await handoff(async (_database, providerCheck) => { check = providerCheck; });
    arrange({ hold: { id: 'hold-1' } });
    await expect(check()).rejects.toMatchObject({ providerBoundaryBlocked: true, reason: 'customer_mid_checkout' });
  });

  test('a vetoed send returns false, so every stage caller releases its claim and counts nothing', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, aborted: true, boundaryBlocked: true, reason: 'provider_boundary_blocked' });
    await expect(_private.sendDualChannel(est, { email })).resolves.toBe(false);
  });
});
