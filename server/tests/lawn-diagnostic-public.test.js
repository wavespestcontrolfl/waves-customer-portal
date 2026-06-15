// Controls for the db mock — set per test.
let mockDiagnosticRow = null;   // what lawn_diagnostics .first() returns
let mockUpdateResult = 1;       // rows affected by the one-shot lead-link update
const mockLeadInsert = jest.fn(() => ({ returning: () => Promise.resolve([{ id: 'lead-uuid-1' }]) }));

function builder(table) {
  const b = {
    where: () => b,
    whereNull: () => b,
    first: () => Promise.resolve(table === 'lawn_diagnostics' ? mockDiagnosticRow : null),
    insert: (obj) => (table === 'leads' ? mockLeadInsert(obj) : { returning: () => Promise.resolve([{ id: 'x' }]) }),
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

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const publicRouter = require('../routes/public-lawn-diagnostic');
const { buildPublicLawnReport, validateQuoteRequest } = publicRouter._test;

const TOKEN = '0123456789abcdef0123456789abcdef';

function appServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/public/lawn-diagnostic', publicRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

function sentDiagnostic(overrides = {}) {
  return {
    id: 'diag-1',
    status: 'sent',
    overall_score: 62,
    report_expires_at: new Date(Date.now() + 86400000).toISOString(),
    contact_snapshot: JSON.stringify({ first_name: 'Dana', last_name: 'Prospect', email: 'dana@example.com', phone: '9415551234' }),
    address_snapshot: JSON.stringify({ line1: '123 Palm St', city: 'Venice', state: 'FL', zip: '34285' }),
    report_contract: JSON.stringify({
      input_assessment: { photo_quality: 'limited', missing_inputs: ['assigned irrigation days missing'], human_review_required: false },
      diagnosis: {
        primary_finding: 'Chinch bug pressure',
        confidence: 'moderate',
        findings: [{
          name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate',
          observed_evidence: ['sunny edge browning'], internal_copy: 'turf score 40/100',
          customer_wording: 'The browning along the sunny edge is most consistent with suspected insect pressure.',
        }],
      },
      treatment_rationale: [{ product_id: 'P1', product_name: 'Talstar P', addresses_findings: ['F1'] }],
      reconciliation_flags: [{ type: 'untreated_condition', issue: 'internal issue text', recommended_action: 'Schedule follow-up', customer_visible: true, customer_wording: 'one area to re-check' }],
      watering: { customer_sequence: 'Water Wednesday and Saturday only.', ongoing_irrigation: { restriction_summary_customer: 'You may water Wednesday and Saturday only.' } },
      expectations: { weeds: 'Visible weed response often takes 10-14 days.' },
      watch_items: ['Watch the sunny edge for spread.'],
      seasonal_context: 'Peak season',
      customer_summary: 'We saw stress along the sunny edge and treated it as suspected insect pressure.',
      internal_quality_flags: [{ type: 'photo_confirmation_honesty', issue: 'internal note' }],
      human_review_required: false,
      repairs_applied: ['confirmed_language_downgraded'],
      release_mode: 'conservative',
    }),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDiagnosticRow = null;
  mockUpdateResult = 1;
});

describe('buildPublicLawnReport whitelisting', () => {
  const INTERNAL_MARKERS = [
    'internal_quality_flags', 'reconciliation_flags', 'treatment_rationale', 'Talstar',
    'product_name', 'human_review_required', 'release_mode', 'repairs_applied',
    'observed_evidence', 'internal_copy', 'recommended_action', 'photo_quality',
    'missing_inputs', 'input_assessment', '123 Palm St',
  ];

  test('exposes customer-safe fields only', () => {
    const report = buildPublicLawnReport(sentDiagnostic());
    expect(report.summary).toContain('suspected insect pressure');
    expect(report.primary_finding).toBe('Chinch bug pressure');
    expect(report.findings[0].customer_note).toContain('suspected insect pressure');
    expect(report.first_name).toBe('Dana');
    expect(report.city).toBe('Venice');
    expect(report.watering.customer_sequence).toBe('Water Wednesday and Saturday only.');
    expect(report.overall_status).toBe('Keep an eye on it');
  });

  test('never leaks internal scores, raw AI, product names, or tech notes', () => {
    const serialized = JSON.stringify(buildPublicLawnReport(sentDiagnostic()));
    INTERNAL_MARKERS.forEach((marker) => expect(serialized).not.toContain(marker));
    expect(buildPublicLawnReport(sentDiagnostic()).overall_score).toBeUndefined();
  });

  test('findings carry no evidence/internal fields', () => {
    const report = buildPublicLawnReport(sentDiagnostic());
    expect(Object.keys(report.findings[0]).sort()).toEqual(['confidence', 'customer_note', 'name', 'severity']);
  });

  test('scrubs confirmed-language and brand names from published free text (egress defense)', () => {
    const diag = sentDiagnostic({
      report_contract: JSON.stringify({
        diagnosis: {
          primary_finding: 'Chinch bug pressure',
          confidence: 'moderate',
          findings: [{ name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate', customer_wording: 'We confirmed active chinch; we applied Talstar P.' }],
        },
        watering: {},
        customer_summary: 'We confirmed chinch and treated with Talstar P at the labeled rate.',
        watch_items: ['Reapply Talstar if it spreads.'],
      }),
    });
    const report = buildPublicLawnReport(diag);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/talstar/i);
    expect(serialized).not.toMatch(/\bconfirmed\b/i);
    expect(report.findings[0].customer_note.toLowerCase()).toContain('suspected');
  });

  test('clamps enum fields and uses a fixed expectations shape — no injected keys leak', () => {
    const diag = sentDiagnostic({
      report_contract: JSON.stringify({
        diagnosis: {
          primary_finding: 'Weed pressure',
          confidence: 'HACKED',
          findings: [{ name: 'Weed pressure', confidence: 'bogus', severity: 'evil', customer_wording: 'ok' }],
        },
        expectations: { weeds: 'Visible response ~10-14 days.', secret_internal_note: 'TECH ONLY do not show' },
        watering: {},
        customer_summary: 'ok',
      }),
    });
    const report = buildPublicLawnReport(diag);
    expect(report.confidence).toBeNull();
    expect(report.findings[0].confidence).toBeNull();
    expect(report.findings[0].severity).toBeNull();
    expect(Object.keys(report.expectations).sort()).toEqual(['fungus', 'insects', 'turf_recovery', 'weeds']);
    expect(JSON.stringify(report)).not.toContain('secret_internal_note');
    expect(JSON.stringify(report)).not.toContain('TECH ONLY');
  });
});

describe('validateQuoteRequest', () => {
  test.each([
    ['empty body', {}, 'name_required'],
    ['blank name', { name: '   ' }, 'name_required'],
    ['null name', { name: null, email: 'a@b.co' }, 'name_required'],
    ['false name', { name: false, email: 'a@b.co' }, 'name_required'],
    ['array name', { name: [], email: 'a@b.co' }, 'name_required'],
    ['name but no contact', { name: 'Dana' }, 'contact_required'],
    ['name + bad email', { name: 'Dana', email: 'nope' }, 'contact_required'],
    ['array body', [], 'invalid_body'],
    ['null body', null, 'invalid_body'],
  ])('rejects %s', (_label, body, error) => {
    const r = validateQuoteRequest(body);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(error);
  });

  test('accepts a valid email and strips phone formatting', () => {
    expect(validateQuoteRequest({ name: 'Dana Prospect', email: 'dana@example.com' })).toMatchObject({ ok: true, value: { email: 'dana@example.com', phone: null } });
    expect(validateQuoteRequest({ name: 'Dana', phone: '(941) 555-1234' })).toMatchObject({ ok: true, value: { phone: '9415551234' } });
  });
});

describe('GET /api/public/lawn-diagnostic/:token', () => {
  test('returns a whitelisted report + privacy headers for a sent, unexpired token', async () => {
    mockDiagnosticRow = sentDiagnostic();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/public/lawn-diagnostic/${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
      const body = await res.json();
      expect(body.report.primary_finding).toBe('Chinch bug pressure');
      expect(JSON.stringify(body)).not.toContain('Talstar');
    });
  });

  test('404s a malformed token without hitting the db', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/public/lawn-diagnostic/not-a-real-token`);
      expect(res.status).toBe(404);
      expect(mockDb).not.toHaveBeenCalled();
    });
  });

  test('404s when no sent diagnostic matches', async () => {
    mockDiagnosticRow = null;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/public/lawn-diagnostic/${TOKEN}`);
      expect(res.status).toBe(404);
    });
  });

  test('404s an expired report', async () => {
    mockDiagnosticRow = sentDiagnostic({ report_expires_at: new Date(Date.now() - 1000).toISOString() });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/public/lawn-diagnostic/${TOKEN}`);
      expect(res.status).toBe(404);
    });
  });
});

describe('POST /api/public/lawn-diagnostic/:token/quote-request', () => {
  async function post(baseUrl, body) {
    return fetch(`${baseUrl}/api/public/lawn-diagnostic/${TOKEN}/quote-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  test('201 on the first valid request and links a lead', async () => {
    mockDiagnosticRow = sentDiagnostic();
    mockUpdateResult = 1;
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { name: 'Dana Prospect', email: 'dana@example.com', best_time: 'mornings' });
      expect(res.status).toBe(201);
      expect(mockLeadInsert).toHaveBeenCalledTimes(1);
    });
  });

  test('400 on invalid body (no name)', async () => {
    mockDiagnosticRow = sentDiagnostic();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { email: 'dana@example.com' });
      expect(res.status).toBe(400);
      expect(mockLeadInsert).not.toHaveBeenCalled();
    });
  });

  test('409 when a lead is already linked (one-shot guard)', async () => {
    mockDiagnosticRow = sentDiagnostic();
    mockUpdateResult = 0;
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { name: 'Dana', phone: '9415551234' });
      expect(res.status).toBe(409);
    });
  });

  test('404 on a malformed token', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/public/lawn-diagnostic/bad/quote-request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(404);
    });
  });
});
