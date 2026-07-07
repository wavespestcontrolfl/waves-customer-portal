// Controls for the db mock — set per test.
let mockDiagnosticRow = null;      // what lawn_diagnostics .first() returns (claim path)
let mockUpdateResult = 1;          // rows affected by the one-shot claim update
const inserts = { lawn_diagnostics: [], lawn_diagnostic_photos: [], leads: [], ad_service_attribution: [] };

function builder(table) {
  const b = {
    where: () => b,
    whereNull: () => b,
    whereNotNull: () => b,
    first: () => Promise.resolve(table === 'lawn_diagnostics' ? mockDiagnosticRow : null),
    insert: (obj) => {
      (inserts[table] = inserts[table] || []).push(obj);
      if (table === 'leads') return { returning: () => Promise.resolve([{ id: 'lead-uuid-1' }]) };
      if (table === 'ad_service_attribution') return { onConflict: () => ({ ignore: () => Promise.resolve() }) };
      if (table === 'lawn_diagnostics') {
        return {
          returning: () => Promise.resolve([{
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            overall_score: 55,
            report_contract: obj.report_contract,
            created_at: '2026-07-07T12:00:00.000Z',
          }]),
        };
      }
      return Promise.resolve([]);
    },
    update: () => Promise.resolve(mockUpdateResult),
  };
  return b;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.fn = { now: () => 'NOW' };
mockDb.transaction = (cb) => {
  const trx = (t) => builder(t);
  trx.fn = { now: () => 'NOW' };
  return Promise.resolve().then(() => cb(trx));
};

const mockGateState = { lawnAssessmentMagnet: true, leadTurnstile: false, pestIdentifier: false };
let mockHoneypotTripped = false;
// Mirrors utils/turnstile contract: a VERIFIED token is { ok:true, enforced:true }.
let mockTurnstileResult = { ok: true, enforced: false };

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: (gate) => !!mockGateState[gate] }));
jest.mock('../utils/turnstile', () => ({
  verifyTurnstileToken: jest.fn(async () => mockTurnstileResult),
}));
jest.mock('../utils/lead-abuse', () => ({
  isHoneypotTripped: () => mockHoneypotTripped,
  resolveSubmitHost: () => 'wavespestcontrol.com',
}));
const mockLadder = jest.fn();
jest.mock('../services/lawn-diagnostic-analyze', () => {
  const actual = jest.requireActual('../services/lawn-diagnostic-analyze');
  return {
    ...actual,
    runFindingsLadder: (...args) => mockLadder(...args),
    applyWriterSummary: jest.fn(async () => {}),
  };
});
jest.mock('../services/lawn-assessment', () => ({ getSeason: () => 'peak' }));
jest.mock('../utils/funnel-photos', () => ({ storeFunnelPhotos: jest.fn(async () => {}) }));
jest.mock('../services/pricing-engine', () => ({
  syncConstantsFromDB: jest.fn(async () => {}),
  priceLawnCare: jest.fn(() => ({
    tiers: [
      { tier: 'standard', visits: 6, perApp: 118, annual: 708, monthly: 59, label: '6 Applications', recommended: false },
      { tier: 'enhanced', visits: 9, perApp: 105, annual: 945, monthly: 78.75, label: '9 Applications', recommended: true },
      { tier: 'premium', visits: 12, perApp: 99, annual: 1188, monthly: 99, label: '12 Applications', recommended: false },
    ],
  })),
}));

const express = require('express');
const funnelRouter = require('../routes/public-lawn-assessment');

const ROW_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLAIM_TOKEN = 'c'.repeat(32);

function appServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/public/lawn-assessment', funnelRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const LADDER_RESULT = {
  findings: [
    { finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate', urgency: 'follow_up', observed_evidence: ['sunny edge browning'], negative_evidence: [], confirmation_step: 'INTERNAL: float test at margin' },
    { finding_id: 'F2', name: 'Thin turf density', confidence: 'moderate', severity: 'mild', urgency: 'monitor', observed_evidence: [], negative_evidence: [], confirmation_step: 'INTERNAL: check shade' },
  ],
  findingsSource: 'multimodel',
  fallbackReason: null,
  photoAnalysis: null,
  // Sentinel provenance values — model IDs live in server/config/models.js
  // only (AGENTS.md); tests must not pin real model literals.
  provenance: { challenge: { passed: true }, perceptionModel: 'perception-model-sentinel', challengeModel: 'challenge-model-sentinel', writerModel: null },
};

function analyzeBody(overrides = {}) {
  return {
    photos: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }],
    note: 'brown patches by the driveway',
    turnstile_token: 'tok',
    ...overrides,
  };
}

function claimBody(overrides = {}) {
  return {
    claim_token: CLAIM_TOKEN,
    first_name: 'Dana',
    last_name: 'Prospect',
    email: 'dana@example.com',
    phone: '941-555-1234',
    address: { line1: '123 Palm St', city: 'Venice', zip: '34285' },
    lawn_size_band: 'medium',
    ...overrides,
  };
}

function analyzedRow(overrides = {}) {
  return {
    id: ROW_ID,
    status: 'analyzed',
    mode: 'prospect',
    source: 'public_funnel',
    claim_token: CLAIM_TOKEN,
    lead_id: null,
    report_contract: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDiagnosticRow = null;
  mockUpdateResult = 1;
  mockHoneypotTripped = false;
  mockTurnstileResult = { ok: true, enforced: false };
  mockGateState.lawnAssessmentMagnet = true;
  mockGateState.leadTurnstile = false;
  Object.keys(inserts).forEach((k) => { inserts[k] = []; });
  mockLadder.mockResolvedValue(LADDER_RESULT);
});

describe('gate contract', () => {
  test('the whole surface 404s while GATE_LAWN_ASSESSMENT is off', async () => {
    mockGateState.lawnAssessmentMagnet = false;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(404);
      expect(mockLadder).not.toHaveBeenCalled();
    });
  });
});

describe('POST /analyze', () => {
  test('honeypot pretends success and never runs the paid pipeline', async () => {
    mockHoneypotTripped = true;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mockLadder).not.toHaveBeenCalled();
      expect(inserts.lawn_diagnostics).toHaveLength(0);
    });
  });

  test('turnstile FAILURE blocks when GATE_LEAD_TURNSTILE is on', async () => {
    mockTurnstileResult = { ok: false, enforced: true };
    mockGateState.leadTurnstile = true;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(403);
      expect(mockLadder).not.toHaveBeenCalled();
    });
  });

  test('a VERIFIED token passes with GATE_LEAD_TURNSTILE on (verified = ok:true, enforced:true)', async () => {
    mockTurnstileResult = { ok: true, enforced: true };
    mockGateState.leadTurnstile = true;
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(201);
      expect(mockLadder).toHaveBeenCalled();
    });
  });

  test('requires at least one photo with data', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody({ photos: [] })),
      });
      expect(res.status).toBe(400);
    });
  });

  test('caps photo count at 5', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analyzeBody({ photos: Array.from({ length: 6 }, () => ({ data: 'aGVsbG8=' })) })),
      });
      expect(res.status).toBe(400);
    });
  });

  test('happy path returns a TEASER only — never the contract or internal fields', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(analyzeBody()),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.assessmentId).toBe(ROW_ID);
      expect(body.claimToken).toMatch(/^[a-f0-9]{32}$/);
      expect(body.teaser.findings_count).toBeGreaterThan(0);
      expect(body.teaser.overall_status).toBeTruthy();
      // Server-gating: the full contract and every internal marker stay server-side.
      const json = JSON.stringify(body);
      expect(json).not.toContain('reportContract');
      expect(json).not.toContain('report_contract');
      expect(json).not.toContain('confirmation_step');
      expect(json).not.toContain('INTERNAL:');
      expect(json).not.toContain('observed_evidence');
      expect(json).not.toContain('watering');
      // At most ONE visible finding in the teaser.
      expect(body.teaser.first_finding).toBeTruthy();
      expect(Array.isArray(body.teaser.findings)).toBe(false);
      // The prospect note is stored for admin, not echoed into model context/copy.
      const stored = inserts.lawn_diagnostics[0];
      expect(stored.ai_analysis).toContain('brown patches by the driveway');
      expect(mockLadder.mock.calls[0][0]).not.toHaveProperty('note');
    });
  });
});

describe('POST /:id/claim', () => {
  test('happy path creates ONE lead, mints the report token, prices from the size band', async () => {
    mockDiagnosticRow = analyzedRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody()),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.token).toMatch(/^[a-f0-9]{32}$/);
      expect(body.reportUrl).toBe(`/lawn-report/${body.token}`);
      expect(body.pricing.tiers).toHaveLength(3);
      expect(body.pricing.tiers[1].recommended).toBe(true);
      expect(body.pricing.basis_note).toContain('first visit');

      expect(inserts.leads).toHaveLength(1);
      const lead = inserts.leads[0];
      expect(lead.first_contact_channel).toBe('lawn_assessment_funnel');
      expect(lead.service_interest).toBe('lawn care');
      expect(lead.status).toBe('new');
      expect(JSON.parse(lead.extracted_data).lawn_size_band).toBe('medium');

      // Funnel-by-source attribution row: reports alongside every other channel.
      expect(inserts.ad_service_attribution).toHaveLength(1);
      const attribution = inserts.ad_service_attribution[0];
      expect(attribution.lead_id).toBe('lead-uuid-1');
      expect(attribution.lead_source).toBe('lawn_assessment');
      expect(attribution.service_line).toBe('lawn');
      expect(attribution.funnel_stage).toBe('lead');
      expect(attribution.is_paid).toBe(false);
    });
  });

  test('replayed claim returns 409 and rolls back the lead link', async () => {
    mockDiagnosticRow = analyzedRow();
    mockUpdateResult = 0; // one-shot update misses → replay
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody()),
      });
      expect(res.status).toBe(409);
    });
  });

  test('already-unlocked row returns 409 before any writes', async () => {
    mockDiagnosticRow = analyzedRow({ status: 'sent', lead_id: 'lead-prior' });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody()),
      });
      expect(res.status).toBe(409);
      expect(inserts.leads).toHaveLength(0);
    });
  });

  test('malformed claim token reads as generic 404 (not probeable)', async () => {
    mockDiagnosticRow = analyzedRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody({ claim_token: 'nope' })),
      });
      expect(res.status).toBe(404);
    });
  });

  test('first-touch attribution rides the claim onto the lead and the funnel row', async () => {
    mockDiagnosticRow = analyzedRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/${ROW_ID}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(claimBody({
          attribution: {
            utm: { source: 'gbp', medium: 'organic', campaign: 'venice-profile', term: null, content: null },
            gclid: 'test-gclid',
            referrer: 'https://www.google.com/',
            landing_url: 'https://wavespestcontrol.com/lawn-assessment/?utm_source=gbp',
            junk_key: 'dropped',
          },
        })),
      });
      expect(res.status).toBe(201);
      const stored = JSON.parse(inserts.leads[0].extracted_data);
      expect(stored.attribution.gclid).toBe('test-gclid');
      expect(stored.attribution.utm.campaign).toBe('venice-profile');
      expect(stored.attribution.junk_key).toBeUndefined();
      const attribution = inserts.ad_service_attribution[0];
      expect(attribution.gclid).toBe('test-gclid');
      expect(attribution.utm_campaign).toBe('venice-profile');
      // Evidence only — the magnet stays its own organic channel.
      expect(attribution.lead_source).toBe('lawn_assessment');
      expect(attribution.is_paid).toBe(false);
    });
  });

  test('accepts the camelCase claimToken field the analyze response returned', async () => {
    mockDiagnosticRow = analyzedRow();
    await withServer(async (base) => {
      const body = claimBody();
      delete body.claim_token;
      body.claimToken = CLAIM_TOKEN;
      const res = await fetch(`${base}/api/public/lawn-assessment/${ROW_ID}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
    });
  });

  test('missing contact info is a 400', async () => {
    mockDiagnosticRow = analyzedRow();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/lawn-assessment/${ROW_ID}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(claimBody({ email: 'not-an-email', phone: '123' })),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('isPlausibleAnalyzeBody (paid daily-limiter predicate)', () => {
  const { isPlausibleAnalyzeBody } = require('../routes/public-lawn-assessment');

  test('accepts a body that could reach a paid vision call', () => {
    expect(isPlausibleAnalyzeBody({ photos: [{ data: 'aGVsbG8=' }] })).toBe(true);
  });

  test('rejects malformed/empty/honeypot bodies so they never burn the budget', () => {
    expect(isPlausibleAnalyzeBody(undefined)).toBe(false);
    expect(isPlausibleAnalyzeBody(null)).toBe(false);
    expect(isPlausibleAnalyzeBody({})).toBe(false);
    expect(isPlausibleAnalyzeBody({ photos: [] })).toBe(false);
    expect(isPlausibleAnalyzeBody({ photos: [{}] })).toBe(false);
    expect(isPlausibleAnalyzeBody({ photos: [{ data: '' }] })).toBe(false);
    expect(isPlausibleAnalyzeBody({ photos: Array.from({ length: 6 }, () => ({ data: 'aGVsbG8=' })) })).toBe(false);
    expect(isPlausibleAnalyzeBody({ photos: [{ data: 'a'.repeat(6_000_001) }] })).toBe(false);
    expect(isPlausibleAnalyzeBody({ photos: [{ data: 'aGVsbG8=' }], fax_number: 'bot' })).toBe(false);
  });
});
