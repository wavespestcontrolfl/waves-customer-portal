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
// Force the deterministic/fallback path in /analyze tests regardless of API keys, so
// pre-push/CI never depends on a live model. The pure helpers (symptomFindingsFrom-
// Observations, normalizeDiagnosisJson, etc.) stay real via requireActual; only the
// three model-calling stages + the legacy passes are stubbed (default: not-ok).
jest.mock('../services/lawn-diagnostic-prompt', () => {
  const actual = jest.requireActual('../services/lawn-diagnostic-prompt');
  return {
    ...actual,
    runPerception: jest.fn().mockResolvedValue({ ok: false, reason: 'no_gemini_key' }),
    runChallenge: jest.fn().mockResolvedValue({ ok: false, reason: 'no_api', findings: [], challenge: { attempted: false, model: 'opus', passed: false, degraded: true, failureType: 'no_api', removedFindingIds: [], softenedFindingIds: [], requiredConfirmationSteps: [] } }),
    runWriter: jest.fn().mockResolvedValue({ ok: false, reason: 'no_openai_key' }),
    runNarrative: jest.fn().mockResolvedValue({ ok: false, reason: 'no_api' }),
    PROMPT_VERSION: 'lawn-diagnostic-test',
  };
});
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
const { normalizeProductLabelConstraints } = require('../services/lawn-diagnostic-report');
const {
  enrichAppliedProducts,
  labelConstraintsFromCatalog,
  deriveOverallScore,
  buildFindingsFromVision,
  normalizeContact,
  hasSendableContact,
  contactName,
  canonicalSnapshot,
  resolveRecipient,
} = techLawnDiagnosticRouter._test;
const { safeConditionLabel, NO_VISIBLE_STRESS_FINDING } = require('../services/lawn-diagnostic-report');
const lawnPrompt = require('../services/lawn-diagnostic-prompt'); // the mocked module (per-test overrides)
const { LAWN_CHALLENGE } = require('../config/models'); // registry = single source of truth for the Anthropic id

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

  test('catalog misses strip TOP-LEVEL request label authority even with no nested constraints', async () => {
    const products = await enrichAppliedProducts([{
      product_id: 'missing-product',
      product_name: 'Request Product',
      // Authority asserted ONLY via top-level fields (no nested constraints) —
      // these previously survived and normalized to product_db/db_authoritative,
      // publishing exact watering instructions for an unverified product.
      label_verified_at: '2026-06-14T12:00:00.000Z',
      label_source: 'product_db',
      post_app_irrigation: 'hold 48h',
    }]);

    const p = products[0];
    expect(p.label_verified_at).toBeUndefined();
    expect(p.label_source).toBeUndefined();
    expect(p.post_app_irrigation).toBeUndefined();

    // Normalizing the downgraded product must never yield label authority.
    const norm = normalizeProductLabelConstraints(p);
    expect(norm.source).not.toBe('product_db');
    expect(norm.confidence).not.toBe('db_authoritative');
    expect(norm.requires_label_review).toBe(true);
  });

  test('catalog HIT strips request top-level label timing when the catalog has no directive', async () => {
    mockColumnInfo = { id: true, name: true, label_verified_at: true };
    mockCatalogRows = [{ id: 'P1', name: 'Reviewed Product', label_verified_at: '2026-06-14T12:00:00.000Z' }];
    const products = await enrichAppliedProducts([{
      product_id: 'P1',
      // Request asserts authoritative timing at TOP LEVEL; catalog row has no directive.
      post_app_irrigation: 'hold 48h',
      label_source: 'product_db',
    }]);

    const p = products[0];
    expect(p.post_app_irrigation).toBeNull();
    // normalize must not treat the stripped request timing as db-authoritative.
    const norm = normalizeProductLabelConstraints(p);
    expect(norm.confidence).not.toBe('db_authoritative');
    expect(norm.requires_label_review).toBe(true);
  });

  test('deriveOverallScore is null for a no-finding/minimal report, and caps inflated client scores', () => {
    expect(deriveOverallScore({ diagnosis: { findings: [] } }, 100)).toBeNull();
    expect(deriveOverallScore({ diagnosis: { findings: [], severity: 'moderate' } })).toBeNull();
    expect(deriveOverallScore({ diagnosis: { findings: [{ severity: 'severe' }] } }, 100)).toBeLessThanOrEqual(39);
  });

  test('vision-fallback fungal finding is capped at low confidence so egress downgrades it', () => {
    const findings = buildFindingsFromVision({
      composite: { fungal_activity: 'moderate', observations: 'patchy browning' },
      adjustedScores: { weed_suppression: 90, turf_density: 90, color_health: 90 },
      divergenceFlags: [],
    });
    const fungal = findings.find((f) => f.name === 'Possible fungal activity');
    expect(fungal.confidence).toBe('low');
    // egress label then downgrades the named disease to a generic symptom
    expect(safeConditionLabel(fungal.name, fungal.confidence)).toBe('general lawn stress');
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

  test('multimodel path: perception + Opus challenge drive findings and the GPT-5.5 writer runs', async () => {
    lawnPrompt.runPerception.mockResolvedValueOnce({ ok: true, model: 'gemini-3.5-flash', overall_notes: 'ok', observations: [{ area: 'front', color: 'browning', pattern: 'irregular patch', distribution: 'one section', detail: 'crown intact' }] });
    lawnPrompt.runChallenge.mockResolvedValueOnce({ ok: true, findings: [{ finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate', urgency: 'follow_up', observed_evidence: ['sunny-edge browning'], confirmation_step: 'float test' }], challenge: { attempted: true, model: LAWN_CHALLENGE, passed: true, degraded: false, failureType: null, removedFindingIds: [], softenedFindingIds: [], requiredConfirmationSteps: ['float test'] } });
    lawnPrompt.runWriter.mockResolvedValueOnce({ ok: true, model: 'gpt-5.5', customer_summary: "The photos show signs most consistent with chinch pressure; today's visit targeted it." });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tech/lawn-diagnostic/analyze`, {
        method: 'POST', headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: [{ data: 'x', mimeType: 'image/jpeg' }] }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.findingsSource).toBe('multimodel');
      expect(body.provenance).toMatchObject({ perceptionModel: 'gemini-3.5-flash', challengeModel: LAWN_CHALLENGE, writerModel: 'gpt-5.5' });
      expect(body.provenance.challenge.passed).toBe(true);
      expect(body.aiAvailable).toBe(true);
      expect(lawnPrompt.runWriter).toHaveBeenCalled();
      // Gemini is the only vision touch on the happy path — the Claude+Gemini composite never runs.
      expect(mockAnalyzePhoto).not.toHaveBeenCalled();
      expect(body.reportContract.customer_summary).toMatch(/chinch/i);
    });
  });

  test('challenge unavailable: degrades to SYMPTOM-only, names no cause, skips the writer, records provenance', async () => {
    lawnPrompt.runPerception.mockResolvedValueOnce({ ok: true, model: 'gemini-3.5-flash', overall_notes: 'limited', observations: [{ area: 'front', color: 'browning', pattern: 'irregular', distribution: 'one section', detail: 'not visible' }] });
    // runChallenge stays on the default stub → ok:false with degraded provenance.
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/tech/lawn-diagnostic/analyze`, {
        method: 'POST', headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: [{ data: 'x', mimeType: 'image/jpeg' }] }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.findingsSource).toBe('challenge_degraded');
      expect(body.provenance.challenge).toMatchObject({ passed: false, degraded: true });
      // un-challenged → no named cause anywhere in the contract; the finding is a symptom.
      expect(JSON.stringify(body.reportContract).toLowerCase()).not.toContain('chinch');
      expect(body.reportContract.diagnosis.findings[0].name).toMatch(/turf stress/i);
      // the polished writer never runs for a degraded report, and the Claude composite isn't needed.
      expect(lawnPrompt.runWriter).not.toHaveBeenCalled();
      expect(mockAnalyzePhoto).not.toHaveBeenCalled();
    });
  });

  test('symptomFindingsFromObservations: low-confidence symptom for stress, never a cause', () => {
    const out = lawnPrompt.symptomFindingsFromObservations([{ color: 'browning', pattern: 'irregular patch', detail: 'crown chewed' }]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('low');
    expect(out[0].name).toMatch(/turf stress/i);
    expect(safeConditionLabel(out[0].name, out[0].confidence)).not.toMatch(/chinch|fungal|large patch/i);
    expect(lawnPrompt.symptomFindingsFromObservations([])).toEqual([]);
  });

  test('symptomFindingsFromObservations: healthy / negated-cue observations route to the clean no-stress sentinel', () => {
    const healthy = lawnPrompt.symptomFindingsFromObservations([{ color: 'green', pattern: 'uniform', detail: 'dense healthy canopy' }]);
    expect(healthy).toHaveLength(1);
    // Named the canonical sentinel → classifyReleaseMode routes it to the minimal/clean path.
    expect(healthy[0].name).toBe(NO_VISIBLE_STRESS_FINDING);
    expect(healthy[0].severity).toBe('mild');
    expect(safeConditionLabel(healthy[0].name, healthy[0].confidence)).toBe('no major visible stress');
    // Negated absence cues ("no weeds or lesions visible") must not trip the stress regex.
    const negated = lawnPrompt.symptomFindingsFromObservations([{ color: 'green', pattern: 'uniform', detail: 'no weeds or lesions visible' }]);
    expect(negated[0].name).toBe(NO_VISIBLE_STRESS_FINDING);
    // A real problem still downgrades to symptom-level stress.
    expect(lawnPrompt.symptomFindingsFromObservations([{ color: 'browning', detail: 'irregular patch' }])[0].name).toMatch(/turf stress/i);
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

  test('canonicalSnapshot drives token rotation: stable for unchanged recipients, differs on edits', () => {
    // Key-order independent + ignores null/'' fields → a true idempotent resend keeps
    // the token (equal canonical), while an edited name/city rotates it (differs).
    const a = { first_name: 'Dana', email: 'dana@example.com', phone: null };
    const reordered = { email: 'dana@example.com', first_name: 'Dana', phone: '' };
    expect(canonicalSnapshot(a)).toBe(canonicalSnapshot(reordered));
    // Changed recipient → different canonical (route rotates the report token).
    expect(canonicalSnapshot(a)).not.toBe(canonicalSnapshot({ ...a, first_name: 'Casey' }));
    expect(canonicalSnapshot({ city: 'Venice' })).not.toBe(canonicalSnapshot({ city: 'North Port' }));
    // Null / non-object inputs collapse to a stable empty marker.
    expect(canonicalSnapshot(null)).toBe('');
    expect(canonicalSnapshot(undefined)).toBe(canonicalSnapshot(null));
  });

  test('resolveRecipient uses request-only when asserted, inherits stored only on a bare resend', () => {
    const row = {
      contact_snapshot: JSON.stringify({ name: 'Dana', email: 'dana@example.com' }),
      address_snapshot: JSON.stringify({ line1: '123 Palm St', city: 'Venice', state: 'FL' }),
    };
    // Cleared recipient on the request → NOT inherited (the send gate then fails closed).
    expect(resolveRecipient({ body: { contact: null, address: null } }, row)).toEqual({ contact: null, address: null });
    // Only a new contact supplied → address is absent, never mixed with the stored one.
    const partial = resolveRecipient({ body: { contact: { name: 'Casey', email: 'casey@x.co' } } }, row);
    expect(partial.contact).toMatchObject({ name: 'Casey', email: 'casey@x.co' });
    expect(partial.address).toBeNull();
    // Bare API resend (no recipient keys) → inherit the stored snapshot verbatim.
    const inherited = resolveRecipient({ body: {} }, row);
    expect(inherited.contact).toMatchObject({ name: 'Dana', email: 'dana@example.com' });
    expect(inherited.address).toMatchObject({ city: 'Venice', line1: '123 Palm St' });
  });
});

describe('lawn diagnostic durable run provenance', () => {
  const { hashFindings, shouldUseRunSummary, runProvenanceFields } = techLawnDiagnosticRouter._test;

  test('hashFindings is stable, order-independent, and sensitive to finding changes', () => {
    const a = [
      { finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate' },
      { finding_id: 'F2', name: 'Weed pressure', confidence: 'low', severity: 'mild' },
    ];
    expect(hashFindings(a)).toBe(hashFindings([a[1], a[0]])); // order-independent
    expect(hashFindings(a)).not.toBe(hashFindings([{ ...a[0], confidence: 'high' }, a[1]])); // confidence change
    expect(hashFindings(a)).not.toBe(hashFindings([a[0]])); // dropped finding
    expect(hashFindings([])).toBe(hashFindings([]));
  });

  test('runProvenanceFields maps findingsSource + challenge provenance to durable mode/status', () => {
    expect(runProvenanceFields('multimodel', { challenge: { passed: true, attempted: true } }))
      .toEqual({ perceptionMode: 'multimodal_challenged', challengeStatus: 'passed' });
    expect(runProvenanceFields('challenge_degraded', { challenge: { passed: false, attempted: true } }))
      .toEqual({ perceptionMode: 'challenge_degraded', challengeStatus: 'failed' });
    expect(runProvenanceFields('deterministic_fallback', { challenge: null }))
      .toEqual({ perceptionMode: 'deterministic_fallback', challengeStatus: 'not_run' });
  });

  test('shouldUseRunSummary unlocks the stored summary ONLY for a verified, findings-matched, challenge-passed run', () => {
    const hash = hashFindings([{ finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate' }]);
    const good = { challenge_status: 'passed', perception_mode: 'multimodal_challenged', customer_summary: 'GPT-5.5 copy', findings_hash: hash, created_by_technician_id: 'tech-1' };
    expect(shouldUseRunSummary(good, hash, 'tech-1')).toBe(true);
    expect(shouldUseRunSummary(good, 'deadbeef', 'tech-1')).toBe(false);                       // forged/stale findings
    expect(shouldUseRunSummary({ ...good, challenge_status: 'not_run' }, hash, 'tech-1')).toBe(false); // not challenged
    expect(shouldUseRunSummary({ ...good, perception_mode: 'deterministic_fallback' }, hash, 'tech-1')).toBe(false);
    expect(shouldUseRunSummary({ ...good, customer_summary: null }, hash, 'tech-1')).toBe(false);      // no stored summary
    expect(shouldUseRunSummary(good, hash, 'tech-2')).toBe(false);                              // different tech
    expect(shouldUseRunSummary(null, hash, 'tech-1')).toBe(false);                              // missing run
  });
});
