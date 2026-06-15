process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockAnalyzePhoto = jest.fn();
let mockColumnInfo = {};
let mockCatalogRows = [];
const mockDb = jest.fn(() => ({
  columnInfo: jest.fn(() => Promise.resolve(mockColumnInfo)),
  whereIn: jest.fn(() => ({ select: jest.fn(() => Promise.resolve(mockCatalogRows)) })),
}));

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: token, role: token === 'admin' ? 'admin' : 'technician' };
    req.technicianId = token;
    req.techRole = req.technician.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
}));
jest.mock('../services/lawn-assessment', () => ({
  analyzePhoto: (...args) => mockAnalyzePhoto(...args),
  mapToDisplayScores: (composite) => ({
    turf_density: composite.turf_density,
    weed_suppression: 100 - composite.weed_coverage,
    color_health: Math.round(composite.color_health * 10),
    fungus_control: composite.fungal_activity === 'none' ? 95 : 50,
    thatch_level: 60,
    overwatering_signal: !!composite.overwatering_signal,
    observations: composite.observations || '',
  }),
  getSeason: () => 'peak',
  applySeasonalAdjustment: (scores) => scores,
}));

const express = require('express');
const techLawnDiagnosticRouter = require('../routes/tech-lawn-diagnostic');
const {
  enrichAppliedProducts,
  labelConstraintsFromCatalog,
  normalizeContact,
  hasSendableContact,
  contactName,
} = techLawnDiagnosticRouter._test;

function appServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/tech/lawn-diagnostic', techLawnDiagnosticRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('tech lawn diagnostic analyze route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockColumnInfo = {};
    mockCatalogRows = [];
  });

  test('requires authenticated tech access', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tech/lawn-diagnostic/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: [{ name: 'Visible weed pressure' }] }),
      });
      expect(res.status).toBe(401);
    });
  });

  test('builds a non-persisted contract from supplied findings without calling vision', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tech/lawn-diagnostic/analyze`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photos: [{ quality: 'adequate' }],
          findings: [{
            finding_id: 'F1',
            name: 'Possible fungal margin',
            confidence: 'low',
            severity: 'moderate',
            urgency: 'follow_up',
            negative_evidence: ['No close-up blade image'],
          }],
          appliedProducts: [{
            product_id: 'P1',
            product_name: 'Insecticide',
            category: 'insecticide',
            product_label_constraints: {
              source: 'product_db',
              post_app_irrigation: 'hold 24h',
              confidence: 'db_authoritative',
              requires_label_review: false,
            },
          }],
          compliance: {
            irrigation_compliance: { assigned_days: ['Tuesday', 'Saturday'] },
          },
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, persisted: false, aiAvailable: false });
      expect(body.reportContract.reconciliation_flags).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'untreated_condition', finding_id: 'F1' }),
      ]));
      // Auto-release model: never blocks. Manual low-confidence findings with an
      // untreated condition release in conservative mode, gate pinned false.
      expect(body.reportContract.human_review_required).toBe(false);
      expect(body.findingsSource).toBe('manual');
      expect(body.releaseMode).toBe('conservative');
      expect(mockAnalyzePhoto).not.toHaveBeenCalled();
    });
  });

  test('degrades to a minimal-safe report when vision fails and no findings supplied (no 502)', async () => {
    mockAnalyzePhoto.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tech/lawn-diagnostic/analyze`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: [{ data: 'ZmFrZQ==', mimeType: 'image/jpeg' }] }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.findingsSource).toBe('minimal_fallback');
      expect(body.releaseMode).toBe('minimal');
      expect(body.reportContract.diagnosis.primary_finding).toBeNull();
      expect(body.reportContract.human_review_required).toBe(false);
    });
  });

  test('rejects metadata-only photos when no diagnostic findings are supplied', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tech/lawn-diagnostic/analyze`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: [{ quality: 'adequate' }] }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/photo with image data/i);
      expect(mockAnalyzePhoto).not.toHaveBeenCalled();
    });
  });

  test('catalog label constraints override request-provided constraints', () => {
    const constraints = labelConstraintsFromCatalog({
      label_verified_at: '2026-06-14T12:00:00.000Z',
      rainfast_minutes: 240,
      irrigation_required: false,
      reentry_text: 'after dry',
    }, {
      source: 'product_db',
      post_app_irrigation: 'hold 1h',
      rainfast_hours: 1,
      confidence: 'db_authoritative',
      requires_label_review: false,
    });

    expect(constraints).toMatchObject({
      source: 'product_db',
      post_app_irrigation: 'hold 4h',
      rainfast_hours: 4,
      reentry_note: 'after dry',
      confidence: 'db_authoritative',
      requires_label_review: false,
    });
  });

  test('catalog misses downgrade request-provided authoritative label constraints', async () => {
    const products = await enrichAppliedProducts([{
      product_id: 'missing-product',
      product_name: 'Request Product',
      product_label_constraints: {
        source: 'product_db',
        post_app_irrigation: 'hold 1h',
        confidence: 'db_authoritative',
        requires_label_review: false,
      },
    }]);

    expect(products[0].product_label_constraints).toMatchObject({
      source: 'request',
      post_app_irrigation: 'hold 1h',
      confidence: 'inferred',
      requires_label_review: true,
    });
  });

  test('catalog enrichment keeps DB compliance fields authoritative', async () => {
    mockColumnInfo = {
      id: true,
      name: true,
      category: true,
      active_ingredient: true,
      analysis_n: true,
      analysis_p: true,
      analysis_k: true,
      label_verified_at: true,
      rainfast_minutes: true,
    };
    mockCatalogRows = [{
      id: 'P1',
      name: '16-4-8 Fertilizer',
      category: 'fertilizer',
      active_ingredient: 'fertilizer blend',
      analysis_n: 16,
      analysis_p: 4,
      analysis_k: 8,
      label_verified_at: '2026-06-14T12:00:00.000Z',
      rainfast_minutes: 240,
    }];

    const products = await enrichAppliedProducts([{
      product_id: 'P1',
      product_name: 'Request Label',
      category: 'iron',
      active_ingredient: 'iron',
      analysis_n: 0,
      analysis_p: 0,
      addresses_findings: ['F1'],
    }]);

    expect(products[0]).toMatchObject({
      product_id: 'P1',
      product_name: 'Request Label',
      category: 'fertilizer',
      active_ingredient: 'fertilizer blend',
      analysis_n: 16,
      analysis_p: 4,
      analysis_k: 8,
      addresses_findings: ['F1'],
    });
  });

  test('analyzes photos and derives cautious findings from composite scores', async () => {
    mockAnalyzePhoto.mockResolvedValue({
      claude: {},
      gemini: {},
      composite: {
        turf_density: 62,
        weed_coverage: 34,
        color_health: 6.4,
        fungal_activity: 'moderate',
        thatch_visibility: 'moderate',
        overwatering_signal: true,
        observations: 'Photo shows thin turf, weeds, and fungal fruiting bodies.',
      },
      divergenceFlags: [],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tech/lawn-diagnostic/analyze`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photos: [{ data: 'base64-photo', mimeType: 'image/jpeg' }],
          appliedProducts: [{
            product_id: 'P1',
            product_name: 'Fungicide',
            category: 'fungicide',
            addresses_findings: ['F2'],
            product_label_constraints: {
              source: 'product_db',
              post_app_irrigation: 'hold 12h',
              confidence: 'db_authoritative',
              requires_label_review: false,
            },
          }],
          compliance: {
            irrigation_compliance: { assigned_days: ['Wednesday', 'Saturday'] },
          },
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.aiAvailable).toBe(true);
      expect(body.analyzedPhotoCount).toBe(1);
      expect(body.reportContract.diagnosis.findings.map((finding) => finding.name)).toEqual(expect.arrayContaining([
        'Visible weed pressure',
        'Possible fungal activity',
        'Thin turf density',
        'Turf color stress',
        'Overwatering signal',
      ]));
      expect(body.reportContract.customer_summary).toMatch(/most consistent|photos show/i);
      expect(mockAnalyzePhoto).toHaveBeenCalledWith('base64-photo', 'image/jpeg');
    });
  });
});

describe('lawn diagnostic send-gate helpers', () => {
  test('contactName prefers explicit name, else first+last', () => {
    expect(contactName({ name: 'Dana Prospect' })).toBe('Dana Prospect');
    expect(contactName({ first_name: 'Dana', last_name: 'Prospect' })).toBe('Dana Prospect');
    expect(contactName(null)).toBeNull();
  });

  test('normalizeContact drops empties and returns null when blank', () => {
    expect(normalizeContact({ first_name: '  ', email: '', phone: '' })).toBeNull();
    expect(normalizeContact({ name: 'Dana', email: 'dana@example.com' })).toMatchObject({ name: 'Dana', email: 'dana@example.com' });
    expect(normalizeContact('nope')).toBeNull();
  });

  test('hasSendableContact requires a name plus email or address', () => {
    expect(hasSendableContact({ name: 'Dana' }, null)).toBe(false);
    expect(hasSendableContact({ name: 'Dana', email: 'dana@example.com' }, null)).toBe(true);
    expect(hasSendableContact({ name: 'Dana' }, { line1: '123 Palm St' })).toBe(true);
    expect(hasSendableContact({ name: 'Dana' }, { city: 'Venice', state: 'FL' })).toBe(true);
    expect(hasSendableContact(null, { line1: '123 Palm St' })).toBe(false);
    expect(hasSendableContact({ email: 'dana@example.com' }, null)).toBe(false);
  });
});
