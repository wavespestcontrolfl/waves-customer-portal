/**
 * Phase 2C-2 (P1-19): Public picker routes security contract tests.
 *
 * Covers:
 *   1. Pre-limiter `noStore` + `X-Robots-Tag: noindex, nofollow` headers on
 *      `/api/public/estimates`, `/api/public/reschedule`, and `/api/public/reservice`.
 *   2. `rejectUndecodablePath` on `/api/public/estimates`, `/api/public/reschedule`,
 *      and `/api/public/reservice` returning uniform 404 `{ error: 'Not found' }`
 *      before limiters/handlers.
 *   3. `redactRequestUrl` redaction of bearer segments under `/reschedule/`,
 *      `/reservice/`, `/api/public/reschedule/`, and `/api/public/reservice/`.
 *   4. `DELETE /api/public/estimates/:token/reserve/:scheduledServiceId` UUID gate,
 *      call-side block check, viewability gate, and `reserveLimiter` wiring.
 *   5. `POST /api/public/estimates/:token/find-slots` closing the 403-vs-404 oracle
 *      on unviewable / call-blocked quotes while still gating 409/payload behind
 *      `verifyEstimateAskToken`.
 *   6. All five public picker routers (`estimate-slots-public`, `reschedule-public`,
 *      `reservice-public`, `inspection-public`, `estimate-assessment-public`)
 *      key every `express-rate-limit` middleware with `unauthenticatedAuthLimitKey`
 *      (/64 IPv6 normalization, zero JWT bypass).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { noStore } = require('../middleware/no-store');
const { rejectUndecodablePath } = require('../middleware/reject-undecodable-path');
const { redactRequestUrl } = require('../utils/redact-request-url');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');

async function startApp(setup) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  setup(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('Phase 2C-2 (P1-19): rejectUndecodablePath + noStore on public picker mounts', () => {
  test.each([
    '/api/public/estimates',
    '/api/public/reschedule',
    '/api/public/reservice',
  ])('%s returns 404 Not found with noStore headers on undecodable path before hitting downstream middleware', async (prefix) => {
    let downstreamCalls = 0;
    const { base, close } = await startApp((app) => {
      app.use(prefix, noStore);
      app.use([prefix], rejectUndecodablePath);
      app.use((_req, _res, next) => {
        downstreamCalls += 1;
        next();
      });
    });
    try {
      const res = await fetch(`${base}${prefix}/%E0%A4%A`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');

      // Case-insensitive prefix check must also be caught cleanly.
      const upper = await fetch(`${base}${prefix.toUpperCase()}/%E0%A4%A/available-slots`);
      expect(upper.status).toBe(404);
      expect(await upper.json()).toEqual({ error: 'Not found' });
      expect(downstreamCalls).toBe(0);
    } finally {
      await close();
    }
  });

  test('server/index.js mounts pre-limiter noStore and rejectUndecodablePath for public picker routes before /api/ limiter', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const apiLimiterIdx = indexSrc.indexOf("app.use('/api/',");
    expect(apiLimiterIdx).toBeGreaterThan(0);

    const preLimiter = indexSrc.slice(0, apiLimiterIdx);
    expect(preLimiter).toContain("app.use('/api/public/reschedule', require('./middleware/no-store').noStore)");
    expect(preLimiter).toContain("app.use('/api/public/estimates', require('./middleware/no-store').noStore)");
    expect(preLimiter).toContain("app.use('/api/public/reservice', require('./middleware/no-store').noStore");

    const undecodableMatch = preLimiter.match(/app\.use\(\[([^\]]+)\],\s*require\('\.\/middleware\/reject-undecodable-path'\)\.rejectUndecodablePath\)/);
    expect(undecodableMatch).not.toBeNull();
    expect(undecodableMatch[1]).toContain("'/api/public/estimates'");
    expect(undecodableMatch[1]).toContain("'/api/public/reschedule'");
    expect(undecodableMatch[1]).toContain("'/api/public/reservice'");
  });
});

describe('Phase 2C-2 (P1-19): URL redaction for reschedule & reservice bearer tokens', () => {
  const HEX_64 = 'a'.repeat(64);

  test.each([
    [`/reschedule/${HEX_64}`, '/reschedule/[REDACTED]'],
    [`/api/public/reschedule/${HEX_64}/find-slots`, '/api/public/reschedule/[REDACTED]/find-slots'],
    [`/reservice/${HEX_64}`, '/reservice/[REDACTED]'],
    [`/api/public/reservice/${HEX_64}/find-slots`, '/api/public/reservice/[REDACTED]/find-slots'],
    [`/reschedule/custom.dotted.tok?utm_source=sms`, '/reschedule/[REDACTED]?utm_source=sms'],
    [`/reservice/short-token`, '/reservice/[REDACTED]'],
  ])('redacts %s -> %s', (input, expected) => {
    expect(redactRequestUrl(input)).toBe(expected);
  });
});

describe('Phase 2C-2 (P1-19): estimate-slots-public DELETE hold & find-slots parity + X-Robots-Tag', () => {
  const TOKEN = 'b'.repeat(64);
  const HOLD_UUID = '11111111-2222-4333-8444-555555555555';
  let currentEstimate;
  let callSideBlocked;
  let askTokenValid;
  let dbCalls;
  let releaseReservation;
  let findEstimateSlots;
  let router;
  let serverHelper;

  beforeAll(async () => {
    jest.resetModules();
    dbCalls = 0;
    releaseReservation = jest.fn(async () => ({ released: true }));
    findEstimateSlots = jest.fn(async () => ({ primary: [], expander: [], availableSlots: [], summary: null }));

    jest.doMock('express-rate-limit', () => () => (_req, _res, next) => next());
    jest.doMock('../models/db', () => jest.fn((table) => {
      if (table === 'estimates') {
        return {
          where: () => ({
            first: async () => {
              dbCalls += 1;
              return currentEstimate;
            },
          }),
        };
      }
      return { where: () => ({ first: async () => null }) };
    }));
    jest.doMock('../utils/estimate-claim-sql', () => ({
      callSideBlockForEstimateData: jest.fn(async () => callSideBlocked),
    }));
    jest.doMock('../services/slot-reservation', () => ({
      reserveSlot: jest.fn(),
      extendReservation: jest.fn(),
      releaseReservation,
    }));
    jest.doMock('../services/estimate-slot-availability', () => ({
      getAvailableSlots: jest.fn(async () => ({ primary: [], expander: [], metadata: {} })),
      findEstimateSlots,
      MAX_SLOT_HORIZON_DAYS: 90,
    }));
    jest.doMock('../services/estimate-stuck-alert', () => ({
      noteSlotAnswer: jest.fn(),
      noteSlotListFailed: jest.fn(),
      noteHoldStarted: jest.fn(),
      noteHoldReleased: jest.fn(),
    }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../routes/estimate-public', () => ({
      isEstimateCustomerViewable: (est = {}) => Boolean(est && !est.archived_at && !['draft', 'scheduled', 'expired', 'send_failed'].includes(est.status)),
      isEstimateAcceptActive: jest.fn(() => true),
      verifyEstimateAskToken: jest.fn(() => askTokenValid),
      handleEstimateAsk: jest.fn((_req, res) => res.json({})),
      resolveEstimateQuoteRequirement: jest.fn(() => ({ quoteRequired: false })),
      estimatePublicBlockingState: jest.fn(async () => null),
      isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
      isRodentGuaranteeOnlyEstimate: jest.fn(() => false),
      estimateTrenchingReviewRequired: jest.fn(() => false),
      resolveEstimateInvoiceMode: jest.fn(() => false),
      resolveEstimateAcceptance: jest.fn(async () => ({ acceptance: { mode: 'standard_slot_pick' } })),
      buildPricingBundle: jest.fn(async () => ({})),
      estimateRendersMonthlyBilling: jest.fn(async () => false),
      reconcileFrozenMembershipSnapshot: jest.fn(async () => undefined),
      acceptOfficeReviewBody: jest.fn(() => ({})),
      ACCEPT_OFFICE_REVIEW_MESSAGE: 'parked',
      retireOrDenyDroppedCapture: jest.fn(async () => undefined),
      refuseParkedWrite: jest.fn(async () => ({})),
    }));

    router = require('../routes/estimate-slots-public');
    serverHelper = await startApp((app) => {
      app.use('/api/public/estimates', router);
    });
  });

  afterAll(async () => {
    if (serverHelper) await serverHelper.close();
    jest.dontMock('express-rate-limit');
    jest.dontMock('../models/db');
    jest.dontMock('../utils/estimate-claim-sql');
    jest.dontMock('../services/slot-reservation');
    jest.dontMock('../services/estimate-slot-availability');
    jest.dontMock('../services/estimate-stuck-alert');
    jest.dontMock('../services/logger');
    jest.dontMock('../routes/estimate-public');
  });

  beforeEach(() => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null, estimate_data: {} };
    callSideBlocked = false;
    askTokenValid = false;
    dbCalls = 0;
    releaseReservation.mockClear();
    findEstimateSlots.mockClear();
  });

  test('DELETE /:token/reserve/:scheduledServiceId rejects non-UUID hold id before querying DB and stamps privacy headers', async () => {
    const res = await fetch(`${serverHelper.base}/api/public/estimates/${TOKEN}/reserve/not-a-uuid`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(dbCalls).toBe(0);
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  test.each([
    ['archived', { id: 'est-1', status: 'sent', archived_at: '2026-07-01T00:00:00Z', estimate_data: {} }],
    ['draft', { id: 'est-1', status: 'draft', archived_at: null, estimate_data: {} }],
    ['expired', { id: 'est-1', status: 'expired', archived_at: null, estimate_data: {} }],
  ])('DELETE /:token/reserve/:scheduledServiceId returns 404 for %s estimate', async (_label, est) => {
    currentEstimate = est;
    const res = await fetch(`${serverHelper.base}/api/public/estimates/${TOKEN}/reserve/${HOLD_UUID}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  test('DELETE /:token/reserve/:scheduledServiceId returns 404 for call-side blocked estimate and releases viewable estimate', async () => {
    callSideBlocked = true;
    const blockedRes = await fetch(`${serverHelper.base}/api/public/estimates/${TOKEN}/reserve/${HOLD_UUID}`, {
      method: 'DELETE',
    });
    expect(blockedRes.status).toBe(404);
    expect(releaseReservation).not.toHaveBeenCalled();

    callSideBlocked = false;
    const okRes = await fetch(`${serverHelper.base}/api/public/estimates/${TOKEN}/reserve/${HOLD_UUID}`, {
      method: 'DELETE',
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true, released: true });
    expect(releaseReservation).toHaveBeenCalledWith({ scheduledServiceId: HOLD_UUID, estimateId: 'est-1' });
  });

  test('POST /:token/find-slots 404s unviewable & call-blocked quotes even without askToken (no 403 existence oracle), while terminal/open require askToken', async () => {
    askTokenValid = false;

    for (const est of [
      { id: 'est-1', status: 'draft', archived_at: null, estimate_data: {} },
      { id: 'est-1', status: 'expired', archived_at: null, estimate_data: {} },
      { id: 'est-1', status: 'accepted', archived_at: '2026-07-01T00:00:00Z', estimate_data: {} },
    ]) {
      currentEstimate = est;
      const r = await fetch(`${serverHelper.base}/api/public/estimates/${TOKEN}/find-slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'next week' }),
      });
      expect(r.status).toBe(404);
    }

    currentEstimate = { id: 'est-1', status: 'sent', archived_at: null, estimate_data: {} };
    callSideBlocked = true;
    const blockedRes = await fetch(`${serverHelper.base}/api/public/estimates/${TOKEN}/find-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'next week' }),
    });
    expect(blockedRes.status).toBe(404);

    // Viewable open or terminal quote without valid askToken -> 403 (never leaks 409/200)
    callSideBlocked = false;
    currentEstimate = { id: 'est-1', status: 'accepted', archived_at: null, estimate_data: {} };
    const noAskRes = await fetch(`${serverHelper.base}/api/public/estimates/${TOKEN}/find-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'next week' }),
    });
    expect(noAskRes.status).toBe(403);
    expect(await noAskRes.json()).toEqual({ error: 'estimate_ask_forbidden' });

    askTokenValid = true;
    const termRes = await fetch(`${serverHelper.base}/api/public/estimates/${TOKEN}/find-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'next week' }),
    });
    expect(termRes.status).toBe(409);
    expect(findEstimateSlots).not.toHaveBeenCalled();
  });
});

describe('Phase 2C-2 (P1-19): IPv6 /64 + zero-JWT rate-limit key on all five public picker routers', () => {
  test('unauthenticatedAuthLimitKey groups IPv6 /64 neighbors together and ignores Authorization JWT', () => {
    const a = unauthenticatedAuthLimitKey({
      ip: '2001:db8:abcd:0012::1',
      headers: { authorization: 'Bearer header.payloadA.sigA' },
    });
    const b = unauthenticatedAuthLimitKey({
      ip: '::ffff:2001:db8:abcd:0012::99'.replace('::ffff:', ''),
      headers: { authorization: 'Bearer header.payloadB.sigB' },
    });
    const c = unauthenticatedAuthLimitKey({
      ip: '2001:db8:abcd:0013::1',
      headers: { authorization: 'Bearer header.payloadA.sigA' },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test.each([
    ['../routes/estimate-slots-public', 5, null],
    ['../routes/reschedule-public', 3, 3],
    ['../routes/reservice-public', 4, null],
    ['../routes/inspection-public', 3, 3],
    ['../routes/estimate-assessment-public', 1, 3],
  ])('%s passes keyGenerator: unauthenticatedAuthLimitKey to every rateLimit() call (%i source blocks, runtime %s)', (modulePath, expectedSourceBlocks, expectedRuntimeCount) => {
    const filePath = path.join(__dirname, `${modulePath}.js`);
    const src = fs.readFileSync(filePath, 'utf8');
    const blocks = src.match(/rateLimit\(\{[\s\S]*?\}\)/g) || [];
    expect(blocks.length).toBe(expectedSourceBlocks);
    for (const block of blocks) {
      expect(block).toContain('keyGenerator: unauthenticatedAuthLimitKey');
    }

    if (expectedRuntimeCount !== null) {
      const captured = [];
      let freshKey;
      jest.resetModules();
      jest.doMock('express-rate-limit', () => jest.fn((opts) => {
        captured.push(opts);
        return (_req, _res, next) => next();
      }));
      try {
        jest.isolateModules(() => {
          freshKey = require('../middleware/rate-limit-key').unauthenticatedAuthLimitKey;
          require(modulePath);
        });
      } finally {
        jest.dontMock('express-rate-limit');
      }
      expect(captured.length).toBe(expectedRuntimeCount);
      for (const opts of captured) {
        expect(opts.keyGenerator).toBe(freshKey);
      }
    }
  });
});
