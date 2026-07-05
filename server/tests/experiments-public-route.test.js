/**
 * /api/public/experiments — the client-side GrowthBook surface (Phase 2).
 *
 * Contract (mirrored in AGENTS.md's public-route inventory):
 *  - POST /exposure is gated behind GATE_GROWTHBOOK (404 when off).
 *  - SERVER-owned experiment keys are ALWAYS refused — sticky replay trusts
 *    experiment_exposures, so a public post must never pre-assign a real
 *    unit's arm — and refusal returns the SAME 204 as acceptance (no
 *    experiment-enumeration oracle).
 *  - unit_type='anon' + metadata.source='client' are forced server-side.
 *  - GET /status never 404s and returns ONLY the master-gate boolean — the
 *    client SDK's rollback probe (no feature fetch unless enabled).
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/experimentation/growthbook', () => ({
  ESTIMATE_VIEW_EXPERIMENT: 'estimate-view',
  BOOKING_RECOVERY_EXPERIMENT: 'booking-abandon-recovery',
  isKnownTrackingKey: jest.fn(() => true),
  hasFeatureCache: jest.fn(() => true),
  logExposure: jest.fn(async () => {}),
}));

const express = require('express');
const { isEnabled } = require('../config/feature-gates');
const Experiments = require('../services/experimentation/growthbook');

// No supertest in this repo — run the real router on an ephemeral port and
// hit it with the built-in fetch.
let server;
let base;

beforeAll(async () => {
  const a = express();
  a.use(express.json());
  a.use('/api/public/experiments', require('../routes/experiments-public'));
  server = a.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function get(path) {
  return fetch(`${base}${path}`);
}

function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => jest.clearAllMocks());

describe('GET /status — master-gate probe', () => {
  test('reflects the gate and returns ONLY the boolean (never 404)', async () => {
    isEnabled.mockReturnValue(false);
    let res = await get('/api/public/experiments/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });

    isEnabled.mockReturnValue(true);
    res = await get('/api/public/experiments/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  test('reports disabled while the server feature cache is cold (exposure intake could not validate keys)', async () => {
    isEnabled.mockReturnValue(true);
    Experiments.hasFeatureCache.mockReturnValue(false);
    const res = await get('/api/public/experiments/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    Experiments.hasFeatureCache.mockReturnValue(true);
  });

  test('is NOT rate-limited (kill-switch probe must survive exposure bursts)', async () => {
    isEnabled.mockReturnValue(true);
    for (let i = 0; i < 40; i += 1) {
      const res = await get('/api/public/experiments/status');
      expect(res.status).toBe(200);
    }
  });
});

describe('POST /exposure', () => {
  const good = {
    experimentKey: 'homepage-hero',
    variationId: 1,
    variationKey: 'v1',
    unitId: 'abcd1234-efgh-5678',
    value: true,
  };

  test('404 with the gate off; nothing logged', async () => {
    isEnabled.mockReturnValue(false);
    const res = await post('/api/public/experiments/exposure', good);
    expect(res.status).toBe(404);
    expect(Experiments.logExposure).not.toHaveBeenCalled();
  });

  test('gate-off probes NEVER see 429 — the dark-surface 404 wins even under a burst', async () => {
    isEnabled.mockReturnValue(false);
    for (let i = 0; i < 40; i += 1) {
      const res = await post('/api/public/experiments/exposure', good);
      expect(res.status).toBe(404);
    }
    expect(Experiments.logExposure).not.toHaveBeenCalled();
  });

  test('live-key exposure stores with FORCED anon unit_type + client source (client fields ignored)', async () => {
    isEnabled.mockReturnValue(true);
    const res = await post('/api/public/experiments/exposure', { ...good, unitType: 'phone', metadata: { source: 'server' } });
    expect(res.status).toBe(204);
    expect(Experiments.logExposure).toHaveBeenCalledTimes(1);
    expect(Experiments.logExposure).toHaveBeenCalledWith(expect.objectContaining({
      experimentKey: 'homepage-hero',
      unitId: good.unitId,
      unitType: 'anon',
      metadata: expect.objectContaining({ source: 'client' }),
    }));
  });

  test('server-owned keys are refused with the SAME 204 (no oracle, no row)', async () => {
    isEnabled.mockReturnValue(true);
    for (const experimentKey of ['estimate-view', 'booking-abandon-recovery']) {
      const res = await post('/api/public/experiments/exposure', { ...good, experimentKey });
      expect(res.status).toBe(204);
    }
    expect(Experiments.logExposure).not.toHaveBeenCalled();
  });

  test('unknown tracking keys drop silently with 204; malformed shapes 400', async () => {
    isEnabled.mockReturnValue(true);
    Experiments.isKnownTrackingKey.mockReturnValue(false);
    let res = await post('/api/public/experiments/exposure', good);
    expect(res.status).toBe(204);
    expect(Experiments.logExposure).not.toHaveBeenCalled();

    Experiments.isKnownTrackingKey.mockReturnValue(true);
    for (const bad of [
      { ...good, experimentKey: 'BAD KEY!' },
      { ...good, unitId: 'short' },
      { ...good, variationId: 'one' },
      { ...good, variationId: 1000 },
      { ...good, variationKey: 'nope nope' },
    ]) {
      res = await post('/api/public/experiments/exposure', bad);
      expect(res.status).toBe(400);
    }
    expect(Experiments.logExposure).not.toHaveBeenCalled();
  });
});
