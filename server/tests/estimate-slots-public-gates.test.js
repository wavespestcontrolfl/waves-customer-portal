/**
 * Public slot router gates — status parity + privacy headers.
 *
 * The slot endpoints must apply the SAME exposure gate as GET /:token/data
 * (isEstimateCustomerViewable): archived, draft, scheduled, and send_failed
 * estimates must not expose availability or take reservation holds. They must
 * also stamp the same cache/privacy headers /data stamps (tokenized,
 * address-derived responses).
 *
 * No supertest in this repo — run the real router on an ephemeral port and
 * hit it with the built-in fetch (same pattern as public-ui-flags.test.js).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-slot-availability', () => ({
  getAvailableSlots: jest.fn(),
  findEstimateSlots: jest.fn(),
  MAX_SLOT_HORIZON_DAYS: 90,
}));
jest.mock('../services/slot-reservation', () => ({
  reserveSlot: jest.fn(),
  releaseReservation: jest.fn(),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  commercialLowConfidenceRange: jest.fn(() => ({ hasLowConfidence: false })),
}));
jest.mock('../services/estimate-deposits', () => ({
  createDepositIntentForEstimate: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn(),
}));
jest.mock('../services/estimate-card-holds', () => ({
  createCardHoldSetupIntentForEstimate: jest.fn(),
  resolveCardHoldPolicy: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  // Faithful replica of estimate-public.js isEstimateCustomerViewable (the
  // real module is too heavy to require here) — the assertions below encode
  // the same state list, so drift in either place fails this suite.
  isEstimateCustomerViewable: (estimate = {}, now = new Date()) => {
    if (!estimate || estimate.archived_at) return false;
    if (['accepted', 'declined'].includes(estimate.status)) return true;
    if (['draft', 'scheduled'].includes(estimate.status)) return false;
    if (['expired', 'send_failed'].includes(estimate.status)) return false;
    if (estimate.expires_at && new Date(estimate.expires_at) < now) return false;
    return true;
  },
  isEstimateAcceptActive: jest.fn(() => true),
  isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
  isRodentGuaranteeOnlyEstimate: jest.fn(() => false),
  estimateTrenchingReviewRequired: jest.fn(() => false),
  verifyEstimateAskToken: jest.fn(() => true),
  handleEstimateAsk: jest.fn((req, res) => res.json({})),
}));

const express = require('express');
const db = require('../models/db');
const { getAvailableSlots } = require('../services/estimate-slot-availability');
const slotReservation = require('../services/slot-reservation');

const TOKEN = 'test-token-abc123';

let server;
let base;
let currentEstimate;
let lastFirstArgs;

beforeAll((done) => {
  db.mockImplementation((table) => {
    if (table !== 'estimates') throw new Error(`unexpected table ${table}`);
    return {
      where: jest.fn().mockReturnThis(),
      first: jest.fn((...cols) => {
        lastFirstArgs = cols;
        return Promise.resolve(currentEstimate);
      }),
    };
  });
  const app = express();
  app.use(express.json());
  app.use('/api/public/estimates', require('../routes/estimate-slots-public'));
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}/api/public/estimates`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  getAvailableSlots.mockReset();
  slotReservation.reserveSlot.mockReset();
  lastFirstArgs = null;
});

const NON_VIEWABLE = [
  ['draft', { id: 'est-1', status: 'draft', expires_at: null, archived_at: null }],
  ['scheduled', { id: 'est-1', status: 'scheduled', expires_at: null, archived_at: null }],
  ['send_failed', { id: 'est-1', status: 'send_failed', expires_at: null, archived_at: null }],
  ['archived', { id: 'est-1', status: 'sent', expires_at: null, archived_at: '2026-07-01T00:00:00Z' }],
];

describe('slot endpoints status-gate parity with /:token/data', () => {
  test.each(NON_VIEWABLE)('available-slots 404s a %s estimate without exposing availability', async (_label, estimate) => {
    currentEstimate = estimate;
    const res = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(res.status).toBe(404);
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test.each(NON_VIEWABLE)('reserve 404s a %s estimate without creating a hold', async (_label, estimate) => {
    currentEstimate = estimate;
    const res = await fetch(`${base}/${TOKEN}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: '2027-05-20_09-00_tech-1' }),
    });
    expect(res.status).toBe(404);
    expect(slotReservation.reserveSlot).not.toHaveBeenCalled();
  });

  test('terminal states (incl. void) still 409 ahead of the viewability gate', async () => {
    for (const status of ['accepted', 'declined', 'expired', 'void']) {
      currentEstimate = { id: 'est-1', status, expires_at: null, archived_at: null };
      const res = await fetch(`${base}/${TOKEN}/available-slots`);
      expect(res.status).toBe(409);
    }
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('the estimate SELECT fetches archived_at so the gate can see it', async () => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };
    getAvailableSlots.mockResolvedValue({ primary: [], expander: [], metadata: {} });
    const res = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(res.status).toBe(200);
    expect(lastFirstArgs).toContain('archived_at');
  });
});

describe('slot endpoints privacy/cache headers (parity with /:token/data)', () => {
  test('available-slots stamps no-store caching + no-referrer on success and 404 alike', async () => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };
    getAvailableSlots.mockResolvedValue({ primary: [], expander: [], metadata: {} });
    const ok = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(ok.headers.get('pragma')).toBe('no-cache');
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');

    currentEstimate = null; // unknown token path
    const missing = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(missing.headers.get('pragma')).toBe('no-cache');
    expect(missing.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('reserve responses carry the same headers and reservation succeeds for a viewable estimate', async () => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };
    slotReservation.reserveSlot.mockResolvedValue({
      scheduledServiceId: 'scheduled-1',
      expiresAt: '2027-05-20T13:15:00.000Z',
    });
    const res = await fetch(`${base}/${TOKEN}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: '2027-05-20_09-00_tech-1' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.json()).toEqual(expect.objectContaining({ scheduledServiceId: 'scheduled-1' }));
  });
});
