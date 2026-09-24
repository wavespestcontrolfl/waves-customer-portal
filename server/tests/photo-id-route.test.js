// Customer Photo ID API (server/routes/photo-id.js).
//
// Mocks: db (in-memory fake over the three tables the route touches
// directly — pest_identifications / lawn_diagnostics / tree_shrub_assessments;
// their *_photos tables are never hit for real because storeFunnelPhotos /
// storeTreeShrubCustomerPhotos are mocked wholesale), the vision entry points
// (identifyPest / lawn analyzePhoto / previewTreeShrubAssessment), auth, the
// feature gate, and reservice-link. buildPestReportContract, buildPublicPestReport,
// publicIdentificationLabel, buildCustomerTreeShrubReport and
// formatAssessmentScores run for REAL (pure, deterministic, no model/DB calls)
// so the route's egress shaping is actually exercised.

const CUSTOMER_ID = 'cccccccc-1111-4222-8333-444444444444';
const OTHER_CUSTOMER_ID = 'dddddddd-1111-4222-8333-444444444444';

// ── In-memory fake db ───────────────────────────────────────────────────────
const TABLES = { pest_identifications: [], lawn_diagnostics: [], tree_shrub_assessments: [] };
let idCounter = 0;

function resetTables() {
  TABLES.pest_identifications = [];
  TABLES.lawn_diagnostics = [];
  TABLES.tree_shrub_assessments = [];
  idCounter = 0;
}

function matches(row, filters) {
  return Object.keys(filters).every((k) => row[k] === filters[k]);
}

// Mirrors applyPropertyPredicate's mock above (q.__propertyId set only when
// the resolved scope is actually scoped) — unset means "no property filter
// applied", matching every existing (unscoped) test unchanged.
function propertyMatches(q, row) {
  return q.__propertyId === undefined || row.property_id === q.__propertyId;
}

function projectRow(row, cols) {
  if (!cols || !cols.length) return { ...row };
  const out = {};
  for (const c of cols) out[c] = row[c];
  return out;
}

function makeQuery(table) {
  const filters = {};
  let selectCols = null;
  let orderCol = null;
  let orderDir = 'asc';
  let limitN = null;
  const q = {
    where(cond) { Object.assign(filters, cond || {}); return q; },
    whereNull() { return q; },
    whereNotNull() { return q; },
    orderBy(col, dir = 'asc') { orderCol = col; orderDir = dir; return q; },
    limit(n) { limitN = n; return q; },
    select(...cols) {
      selectCols = cols;
      let rows = (TABLES[table] || []).filter((r) => matches(r, filters) && propertyMatches(q, r));
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = a[orderCol]; const bv = b[orderCol];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return orderDir === 'desc' ? -cmp : cmp;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return Promise.resolve(rows.map((r) => projectRow(r, selectCols)));
    },
    first(...cols) {
      const rows = (TABLES[table] || []).filter((r) => matches(r, filters) && propertyMatches(q, r));
      const row = rows[0];
      return Promise.resolve(row ? projectRow(row, cols.length ? cols : null) : undefined);
    },
    insert(obj) {
      idCounter += 1;
      const row = {
        // UUID-shaped so the route's own UUID_RE guard (GET /:type/:id) accepts it.
        id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(idCounter).padStart(12, '0')}`,
        created_at: new Date(Date.now() + idCounter).toISOString(), // monotonic for ordering
        ...obj,
      };
      (TABLES[table] = TABLES[table] || []).push(row);
      return { returning: (cols) => Promise.resolve([projectRow(row, cols)]) };
    },
  };
  return q;
}

const mockDb = jest.fn((table) => makeQuery(table));

const mockGateState = { customerPhotoId: true };
const mockIdentifyPest = jest.fn();
const mockLawnAnalyzePhoto = jest.fn();
const mockPreviewTreeShrub = jest.fn();
const mockReserviceAccess = jest.fn(async () => null);
// Unscoped by default (gate off / single-home) — matches every existing test
// (property_id stamped null, no read filtering). codex GH r1 P1 tests below
// override this to exercise the scoped path.
const mockResolveSessionScope = jest.fn(async () => ({
  enabled: false, multi: false, scoped: false, closed: false, property: null,
}));
const mockApplyPropertyPredicateCalls = [];
const mockStoreFunnelPhotos = jest.fn(async () => {});
const mockStoreTreeShrubPhotos = jest.fn(async () => {});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: (gate) => !!mockGateState[gate] }));
// express-rate-limit's default store is in-memory and lives for the life of
// the router module — which this whole test file shares — so every test
// that doesn't care about quota gets a FRESH default customer id per test
// (mockScopeCustomerId, reset in beforeEach) rather than the fixed
// CUSTOMER_ID constant, or one test's POSTs would exhaust another's quota.
 
var mockScopeCustomerId = CUSTOMER_ID;
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customer = { id: req.headers['x-test-customer-id'] || mockScopeCustomerId }; next(); },
}));
jest.mock('../routes/requests', () => ({
  VALID_LOCATIONS: ['front_yard', 'back_yard', 'side_yard', 'inside_home', 'garage_lanai', 'garden_beds', 'other'],
}));
jest.mock('../services/lawn-grass-context', () => ({
  loadCustomerGrassContext: jest.fn(async () => ({ grassTypeLabel: null, irrigationSystem: null })),
  grassTypeLabel: (v) => (v ? String(v).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null),
}));
jest.mock('../services/reservice-link', () => ({ reserviceStreamlineAccess: (...args) => mockReserviceAccess(...args) }));
jest.mock('../services/account-properties', () => ({
  resolveSessionScope: (...args) => mockResolveSessionScope(...args),
  // Real behavior for the ONE thing these tests need to verify (the row
  // must match the scoped property), without needing the fake db's simple
  // .where(cond) to support a knex function-form predicate: apply the
  // resolved property directly onto our own filter object instead of
  // building real SQL, and record every call for assertion.
  applyPropertyPredicate: (qb, scope) => {
    mockApplyPropertyPredicateCalls.push(scope);
    if (scope && scope.enabled && scope.scoped && scope.property) qb.__propertyId = scope.property.id;
    return qb;
  },
}));
jest.mock('../utils/funnel-photos', () => ({
  storeFunnelPhotos: (...args) => mockStoreFunnelPhotos(...args),
  storeTreeShrubCustomerPhotos: (...args) => mockStoreTreeShrubPhotos(...args),
}));
jest.mock('../services/pest-identification', () => {
  const actual = jest.requireActual('../services/pest-identification');
  return { ...actual, identifyPest: (...args) => mockIdentifyPest(...args) };
});
jest.mock('../services/lawn-assessment', () => ({
  analyzePhoto: (...args) => mockLawnAnalyzePhoto(...args),
}));
jest.mock('../services/tree-shrub-assessment', () => {
  const actual = jest.requireActual('../services/tree-shrub-assessment');
  return { ...actual, previewTreeShrubAssessment: (...args) => mockPreviewTreeShrub(...args) };
});

const express = require('express');
const { PEST_LIBRARY } = jest.requireActual('../services/pest-identification');
const photoIdRouter = require('../routes/photo-id');

function libraryEntry(slug) {
  return PEST_LIBRARY.find((e) => e.slug === slug);
}

function pestResultFor(slug, confidence = 'high', contested = false) {
  const entry = libraryEntry(slug);
  return {
    ok: true,
    identification: { entry, confidence, category: entry.category, contested },
    perPhoto: [{
      entry, confidence, category: entry.category, agreement: 'match', model_count: 2, observations: ['raw model text'], distinguishing_features: [], alternate_slugs: [],
    }],
    observations: ['raw model observation'],
    distinguishing_features: ['raw feature'],
    alternate_slugs: [],
  };
}

function appServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/photo-id', photoIdRouter);
   
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const PHOTO_DATA_URL = 'data:image/jpeg;base64,aGVsbG8=';

function photoBody(overrides = {}) {
  return { photos: [PHOTO_DATA_URL], note: 'a note', location: 'front_yard', ...overrides };
}

async function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

let testCounter = 0;
beforeEach(() => {
  jest.clearAllMocks();
  resetTables();
  testCounter += 1;
  mockScopeCustomerId = `auto-customer-${testCounter}`;
  mockGateState.customerPhotoId = true;
  mockReserviceAccess.mockResolvedValue(null);
  mockResolveSessionScope.mockResolvedValue({
    enabled: false, multi: false, scoped: false, closed: false, property: null,
  });
  mockApplyPropertyPredicateCalls.length = 0;
  mockIdentifyPest.mockResolvedValue(pestResultFor('ghost-ant'));
  mockLawnAnalyzePhoto.mockResolvedValue({
    composite: {
      turf_density: 80, weed_coverage: 10, color_health: 8, fungal_activity: 'none', insect_damage: 'none', mechanical_damage: 'none', drought_stress: 'none', thatch_visibility: 'low', overwatering_signal: false, grass_type: 'st_augustine', observations: 'Lawn looks healthy.',
    },
  });
  mockPreviewTreeShrub.mockResolvedValue({
    scores: {
      foliageFullness: 80, leafColorVigor: 75, pestActivity: 90, diseaseLeafSpot: 95, waterHeatStress: 85, overallScore: 85,
    },
    observations: 'Plants look healthy.',
    aiSummary: 'No urgent visible plant issues found.',
    findings: [],
    scoredCount: 1,
    photoCount: 1,
  });
});

// ── Gate contract ────────────────────────────────────────────────────────
describe('gate contract', () => {
  test('every handler 404s while GATE_CUSTOMER_PHOTO_ID is off', async () => {
    mockGateState.customerPhotoId = false;
    await withServer(async (base) => {
      const list = await fetch(`${base}/api/photo-id`);
      expect(list.status).toBe(404);
      const post1 = await post(base, '/api/photo-id/pest', photoBody());
      expect(post1.status).toBe(404);
      expect(mockIdentifyPest).not.toHaveBeenCalled();
      const detail = await fetch(`${base}/api/photo-id/pest/${'a'.repeat(8)}-1111-4222-8333-444444444444`);
      expect(detail.status).toBe(404);
    });
  });
});

// ── Happy paths ──────────────────────────────────────────────────────────
describe('POST /api/photo-id/:type happy paths', () => {
  test('pest: matched, non-inspection entry shapes the customer-safe result', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe('pest');
      expect(body.result.label).toBe('Ghost Ants');
      expect(body.result.hedged).toBe(false);
      expect(body.result.not_a_pest).toBe(false);
      expect(body.result).not.toHaveProperty('first_name');
      expect(body.result).not.toHaveProperty('city');
      expect(body.result).not.toHaveProperty('pricing');
      expect(body.result).not.toHaveProperty('next_step');
      expect(body.next_step.kind).toBe('request');
      expect(TABLES.pest_identifications).toHaveLength(1);
      expect(TABLES.pest_identifications[0].mode).toBe('customer');
      expect(TABLES.pest_identifications[0].source).toBe('portal');
      expect(TABLES.pest_identifications[0].customer_id).toBe(mockScopeCustomerId);
      expect(mockStoreFunnelPhotos).toHaveBeenCalledWith(expect.objectContaining({ table: 'pest_identification_photos', keyPrefix: 'pestid/customer' }));
    });
  });

  test('lawn: scores, signals, and grass type shape the result', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/lawn', photoBody());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe('lawn');
      expect(body.result.scores).toEqual({ turf_density: 80, weed_coverage: 10, color_health: 8 });
      expect(body.result.grass_type).toBe('St Augustine');
      expect(Array.isArray(body.result.signals)).toBe(true);
      expect(TABLES.lawn_diagnostics).toHaveLength(1);
      expect(TABLES.lawn_diagnostics[0].mode).toBe('customer');
      expect(mockStoreFunnelPhotos).toHaveBeenCalledWith(expect.objectContaining({ table: 'lawn_diagnostic_photos', keyPrefix: 'lawnfunnel/customer' }));
    });
  });

  test('lawn: a severe reading on one photo is never masked by a healthy first photo, and customer copy is never the raw model text', async () => {
    // codex r2 P1 — severity fields take the worst photo, never diluted by a
    // healthy first photo. codex r6 P1 — the customer-facing `observations`
    // field is deterministic, allowlisted wording built from the signal
    // vocabulary, never the model's own free-text prose (which can name a
    // specific disease/insect or overclaim).
    mockLawnAnalyzePhoto
      .mockResolvedValueOnce({
        composite: {
          turf_density: 90, weed_coverage: 5, color_health: 9, fungal_activity: 'none', insect_damage: 'none', mechanical_damage: 'none', drought_stress: 'none', thatch_visibility: 'low', overwatering_signal: false, grass_type: 'st_augustine', observations: 'This front section looks healthy.',
        },
      })
      .mockResolvedValueOnce({
        composite: {
          turf_density: 40, weed_coverage: 30, color_health: 5, fungal_activity: 'severe', insect_damage: 'none', mechanical_damage: 'none', drought_stress: 'none', thatch_visibility: 'low', overwatering_signal: false, grass_type: 'st_augustine', observations: 'Severe brown patch fungal disease near the back fence.',
        },
      });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/lawn', photoBody({ photos: [PHOTO_DATA_URL, PHOTO_DATA_URL] }));
      const body = await res.json();
      const fungalSignal = body.result.signals.find((s) => s.key === 'fungal_activity');
      expect(fungalSignal.level).toBe('severe');
      expect(body.result.observations).toContain('fungal activity');
      expect(body.result.observations).not.toContain('brown patch');
      expect(body.result.observations).not.toContain('back fence');
      expect(body.result.observations).not.toContain('This front section looks healthy');
    });
  });

  test('lawn: one photo failing to analyze forces unclear rather than a confident read off the rest', async () => {
    // codex r3 P1 — a trouble-spot photo failing while an overview photo
    // succeeds must never silently present the successful subset as complete.
    mockLawnAnalyzePhoto
      .mockResolvedValueOnce({
        composite: {
          turf_density: 90, weed_coverage: 5, color_health: 9, fungal_activity: 'none', insect_damage: 'none', mechanical_damage: 'none', drought_stress: 'none', thatch_visibility: 'low', overwatering_signal: false, grass_type: 'st_augustine', observations: 'Looks healthy.',
        },
      })
      .mockResolvedValueOnce(null);
    mockReserviceAccess.mockResolvedValue({ token: 'tok-x', lanes: ['lawn'] }); // would otherwise win as 'reservice'
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/lawn', photoBody({ photos: [PHOTO_DATA_URL, PHOTO_DATA_URL] }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.next_step.kind).toBe('unclear');
      // codex GH r1 P1: the successful photo's healthy scores must not stand
      // in the result alongside the unclear warning.
      expect(body.result.scores).toEqual({ turf_density: null, weed_coverage: null, color_health: null });
      expect(body.result.signals).toEqual([]);
      expect(body.result.observations).not.toContain('Looks healthy');
    });
  });

  test('tree_shrub: scores + signals shape the result', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/tree_shrub', photoBody());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe('tree_shrub');
      expect(body.result.scores.overall).toBe(85);
      expect(Array.isArray(body.result.signals)).toBe(true);
      expect(body.result.plant_groups).toEqual([]);
      expect(TABLES.tree_shrub_assessments).toHaveLength(1);
      expect(TABLES.tree_shrub_assessments[0].mode).toBe('customer');
      expect(TABLES.tree_shrub_assessments[0].source).toBe('portal');
      expect(mockStoreTreeShrubPhotos).toHaveBeenCalledWith(expect.objectContaining({ keyPrefix: 'treeshrub/customer' }));
    });
  });

  test('unknown type is rejected', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/rodent', photoBody());
      expect(res.status).toBe(400);
    });
  });
});

// ── next_step branches ───────────────────────────────────────────────────
describe('next_step branches', () => {
  test('pest: termite (inspection-first) -> inspection', async () => {
    mockIdentifyPest.mockResolvedValue(pestResultFor('subterranean-termite'));
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('inspection');
      expect(body.next_step.request_prefill).toEqual({ category: 'pest_issue', location: 'front_yard', note: 'a note' });
    });
  });

  test('pest: not_a_pest -> none', async () => {
    mockIdentifyPest.mockResolvedValue(pestResultFor('lovebug'));
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.result.not_a_pest).toBe(true);
      expect(body.next_step.kind).toBe('none');
      expect(body.next_step.request_prefill).toBeUndefined();
    });
  });

  test('pest: low-confidence matched entry (hedged + generic) -> unclear', async () => {
    mockIdentifyPest.mockResolvedValue(pestResultFor('ghost-ant', 'low'));
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.result.hedged).toBe(true);
      expect(body.next_step.kind).toBe('unclear');
      expect(body.next_step.request_prefill.category).toBe('pest_issue');
    });
  });

  test('pest: matched + no reservice access -> request', async () => {
    mockReserviceAccess.mockResolvedValue(null);
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('request');
    });
  });

  test('pest: matched + reservice access covering the pest lane -> reservice with url', async () => {
    mockReserviceAccess.mockResolvedValue({ token: 'tok-abc', lanes: ['pest', 'lawn'] });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('reservice');
      expect(body.next_step.url).toBe('/reservice/tok-abc');
    });
  });

  test('pest: one photo silently failing to merge forces unclear, never a confident read off the rest', async () => {
    // codex r4 P1 — identifyPest returns ok:true as soon as ONE photo merges;
    // a benign photo succeeding while a real pest photo fails must not read
    // as "nothing to worry about" (or any other confident outcome).
    const benign = pestResultFor('ghost-ant');
    mockIdentifyPest.mockResolvedValue({ ...benign, perPhoto: benign.perPhoto.slice(0, 1) });
    mockReserviceAccess.mockResolvedValue({ token: 'tok-z', lanes: ['pest'] }); // would otherwise win as 'reservice'
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody({ photos: [PHOTO_DATA_URL, PHOTO_DATA_URL] }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.next_step.kind).toBe('unclear');
      // codex GH r1 P1: the benign identification's label/not_a_pest/
      // recommendation must not stand alongside the unclear warning.
      expect(body.result.label).toBeNull();
      expect(body.result.not_a_pest).toBe(false);
      expect(body.result.recommendation).toBeNull();
    });
  });

  test('pest: contested/low-confidence not_a_pest read -> unclear, never "nothing to worry about"', async () => {
    // A lovebug/beneficial call that disagreed across photos must not read as
    // confidently benign (codex r1 P1).
    mockIdentifyPest.mockResolvedValue(pestResultFor('lovebug', 'low', true));
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.result.not_a_pest).toBe(true);
      expect(body.next_step.kind).toBe('unclear');
      expect(body.next_step.title).not.toMatch(/nothing to worry about/i);
    });
  });

  test('pest: confident, uncontested not_a_pest read -> still none', async () => {
    mockIdentifyPest.mockResolvedValue(pestResultFor('lovebug', 'high', false));
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('none');
    });
  });

  test('pest: moderate-confidence not_a_pest read ("Likely a Lovebug") is still hedged -> unclear, not none', async () => {
    // codex GH r1 P1 — moderate confidence is hedged but still NAMED
    // (specificity 'named', "Likely X"), so the generic-only guard alone
    // never catches it.
    mockIdentifyPest.mockResolvedValue(pestResultFor('lovebug', 'moderate', false));
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.result.hedged).toBe(true);
      expect(body.result.not_a_pest).toBe(true);
      expect(body.next_step.kind).toBe('unclear');
      expect(body.next_step.title).not.toMatch(/nothing to worry about/i);
    });
  });

  test('lawn: explicit null scores are treated as missing, not a measured zero -> unclear', async () => {
    mockLawnAnalyzePhoto.mockResolvedValue({
      composite: {
        turf_density: null, weed_coverage: null, color_health: null, grass_type: null, observations: '',
      },
    });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/lawn', photoBody());
      const body = await res.json();
      expect(body.result.scores).toEqual({ turf_density: null, weed_coverage: null, color_health: null });
      expect(body.next_step.kind).toBe('unclear');
    });
  });

  test('lawn: no usable scores -> unclear', async () => {
    mockLawnAnalyzePhoto.mockResolvedValue({ composite: {} });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/lawn', photoBody());
      const body = await res.json();
      expect(body.result.scores).toEqual({ turf_density: null, weed_coverage: null, color_health: null });
      expect(body.next_step.kind).toBe('unclear');
    });
  });

  test('lawn: total vision failure -> 503, no row stored', async () => {
    mockLawnAnalyzePhoto.mockResolvedValue(null);
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/lawn', photoBody());
      expect(res.status).toBe(503);
      expect(TABLES.lawn_diagnostics).toHaveLength(0);
    });
  });

  test('lawn: reservice access covering the lawn lane -> reservice', async () => {
    mockReserviceAccess.mockResolvedValue({ token: 'tok-lawn', lanes: ['lawn'] });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/lawn', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('reservice');
      expect(body.next_step.url).toBe('/reservice/tok-lawn');
    });
  });

  test('tree_shrub: no usable scores -> unclear', async () => {
    mockPreviewTreeShrub.mockResolvedValue({
      scores: {
        foliageFullness: null, leafColorVigor: null, pestActivity: null, diseaseLeafSpot: null, waterHeatStress: null, overallScore: null,
      },
      observations: '',
      aiSummary: null,
      findings: [],
      scoredCount: 1,
      photoCount: 1,
    });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/tree_shrub', photoBody());
      const body = await res.json();
      expect(body.result.scores.overall).toBeNull();
      expect(body.next_step.kind).toBe('unclear');
    });
  });

  test('tree_shrub: one photo failing to score forces unclear AND suppresses the successful subset\'s scores', async () => {
    // codex r3 P1 — scoredCount < photoCount must not read as a complete
    // next_step. codex GH r1 P1 — it must not leave the successful subset's
    // healthy-looking scores standing in the result either.
    mockReserviceAccess.mockResolvedValue({ token: 'tok-y', lanes: ['lawn'] }); // would otherwise win as 'reservice'
    mockPreviewTreeShrub.mockResolvedValue({
      scores: {
        foliageFullness: 80, leafColorVigor: 75, pestActivity: 90, diseaseLeafSpot: 95, waterHeatStress: 85, overallScore: 85,
      },
      observations: 'Plants look healthy.',
      aiSummary: 'No urgent visible plant issues found.',
      findings: [],
      scoredCount: 1,
      photoCount: 2,
    });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/tree_shrub', photoBody({ photos: [PHOTO_DATA_URL, PHOTO_DATA_URL] }));
      const body = await res.json();
      expect(body.result.scores.overall).toBeNull();
      expect(body.result.signals).toEqual([]);
      expect(body.next_step.kind).toBe('unclear');
    });
  });

  test('tree_shrub: a valid-JSON response missing severity data ("synthesized" healthy scores) reads unclear, not healthy', async () => {
    // codex GH r1 P1 — toCategoryScores defaults a MISSING severity field to
    // 'none' (95), so an all-photos-"succeeded" batch with no real evidence
    // still produces a non-null, healthy-looking overallScore. Only
    // foliageFullness/leafColorVigor stay genuinely null with no evidence.
    mockPreviewTreeShrub.mockResolvedValue({
      scores: {
        foliageFullness: null, leafColorVigor: null, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 95, overallScore: 95,
      },
      observations: '',
      aiSummary: 'No urgent visible plant issues found.',
      findings: [],
      scoredCount: 1,
      photoCount: 1,
    });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/tree_shrub', photoBody());
      const body = await res.json();
      expect(body.result.scores.overall).toBeNull();
      expect(body.next_step.kind).toBe('unclear');
    });
  });

  test('tree_shrub: total vision failure -> 503, no row stored', async () => {
    mockPreviewTreeShrub.mockResolvedValue(null);
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/tree_shrub', photoBody());
      expect(res.status).toBe(503);
      expect(TABLES.tree_shrub_assessments).toHaveLength(0);
    });
  });

  test('tree_shrub: never reservice-eligible even when the customer has lawn-lane access (codex r5 P1)', async () => {
    // reservice-scheduler.js explicitly excludes tree & shrub from both
    // lanes — lawn-lane coverage must not be read as covering tree & shrub.
    mockReserviceAccess.mockResolvedValue({ token: 'tok-tree', lanes: ['pest', 'lawn'] });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/tree_shrub', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('request');
      expect(body.next_step.url).toBeUndefined();
    });
  });

  test('pest: a lawn-targeting pest (chinch bugs) checks the lawn lane, not the pest lane', async () => {
    mockIdentifyPest.mockResolvedValue(pestResultFor('chinch-bug'));
    mockReserviceAccess.mockResolvedValue({ token: 'tok-lawn2', lanes: ['lawn'] }); // no 'pest' lane
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('reservice');
      expect(body.next_step.url).toBe('/reservice/tok-lawn2');
    });
  });

  test('pest: a mosquito identification is never reservice-eligible, whatever the customer\'s plan covers', async () => {
    mockIdentifyPest.mockResolvedValue(pestResultFor('mosquito'));
    mockReserviceAccess.mockResolvedValue({ token: 'tok-both', lanes: ['pest', 'lawn'] });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('request');
    });
  });
});

// ── Quota ────────────────────────────────────────────────────────────────
describe('per-customer daily quota', () => {
  test('11th submission in 24h 429s and names the office phone', async () => {
    await withServer(async (base) => {
      for (let i = 0; i < 10; i += 1) {
         
        const res = await post(base, '/api/photo-id/pest', photoBody());
        expect(res.status).toBe(200);
      }
      const eleventh = await post(base, '/api/photo-id/pest', photoBody());
      expect(eleventh.status).toBe(429);
      const body = await eleventh.json();
      expect(body.error).toMatch(/941\) 297-5749/);
    });
  });
});

// ── Ownership ────────────────────────────────────────────────────────────
describe('GET /api/photo-id/:type/:id ownership', () => {
  test('a row belonging to a different customer 404s', async () => {
    await withServer(async (base) => {
      const created = await post(base, '/api/photo-id/pest', photoBody(), { 'x-test-customer-id': OTHER_CUSTOMER_ID });
      const createdBody = await created.json();
      const res = await fetch(`${base}/api/photo-id/pest/${createdBody.id}`, {
        headers: { 'x-test-customer-id': CUSTOMER_ID },
      });
      expect(res.status).toBe(404);
    });
  });

  test('the owning customer can read their own row back', async () => {
    await withServer(async (base) => {
      const created = await post(base, '/api/photo-id/pest', photoBody());
      const createdBody = await created.json();
      // Same (default) customer id as the POST above — no header override.
      const res = await fetch(`${base}/api/photo-id/pest/${createdBody.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(createdBody.id);
      expect(body.result.label).toBe('Ghost Ants');
    });
  });

  test('a non-uuid id 404s rather than throwing', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/photo-id/pest/not-a-uuid`);
      expect(res.status).toBe(404);
    });
  });
});

// ── Listing ──────────────────────────────────────────────────────────────
describe('GET /api/photo-id', () => {
  test('lists this customer\'s submissions across all three types', async () => {
    await withServer(async (base) => {
      await post(base, '/api/photo-id/pest', photoBody());
      await post(base, '/api/photo-id/lawn', photoBody());
      await post(base, '/api/photo-id/tree_shrub', photoBody());
      const res = await fetch(`${base}/api/photo-id`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(3);
      const types = body.items.map((i) => i.type).sort();
      expect(types).toEqual(['lawn', 'pest', 'tree_shrub']);
      for (const item of body.items) {
        expect(item).toHaveProperty('headline');
        expect(item).toHaveProperty('next_step_kind');
      }
    });
  });

  test('never returns another customer\'s submissions', async () => {
    await withServer(async (base) => {
      await post(base, '/api/photo-id/pest', photoBody(), { 'x-test-customer-id': OTHER_CUSTOMER_ID });
      const res = await fetch(`${base}/api/photo-id`, { headers: { 'x-test-customer-id': CUSTOMER_ID } });
      const body = await res.json();
      expect(body.items).toHaveLength(0);
    });
  });
});

// ── Property scope (codex GH r1 P1) ──────────────────────────────────────
describe('property scope (GATE_APP_PROPERTY_SCOPE)', () => {
  test('POST stamps property_id from the resolved session scope', async () => {
    mockResolveSessionScope.mockResolvedValue({
      enabled: true, multi: true, scoped: true, closed: false, property: { id: 'prop-1', is_primary: false },
    });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/pest', photoBody());
      expect(res.status).toBe(200);
      expect(TABLES.pest_identifications[0].property_id).toBe('prop-1');
    });
  });

  test('POST stamps property_id null when unscoped (gate off / single home)', async () => {
    await withServer(async (base) => {
      await post(base, '/api/photo-id/lawn', photoBody());
      expect(TABLES.lawn_diagnostics[0].property_id).toBeNull();
    });
  });

  test('GET / applies the property predicate to all three type queries', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/api/photo-id`);
      expect(mockApplyPropertyPredicateCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  test('GET /:type/:id 404s a row scoped to a DIFFERENT property than the one currently selected', async () => {
    // Row was written while scoped to prop-1...
    mockResolveSessionScope.mockResolvedValue({
      enabled: true, multi: true, scoped: true, closed: false, property: { id: 'prop-1', is_primary: false },
    });
    const created = await withServer((base) => post(base, '/api/photo-id/pest', photoBody()).then((r) => r.json()));
    // ...customer switches the selected property to prop-2 before reading it back.
    mockResolveSessionScope.mockResolvedValue({
      enabled: true, multi: true, scoped: true, closed: false, property: { id: 'prop-2', is_primary: false },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/photo-id/pest/${created.id}`);
      expect(res.status).toBe(404);
    });
  });
});

// ── Comms-free ───────────────────────────────────────────────────────────
describe('comms-free module contract', () => {
  test('the route module never requires a customer-comms sender', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/photo-id'), 'utf8');
    // Strip comments first — the module's own header PROSE documents the
    // comms-free contract by naming what it must never require, which would
    // otherwise trip a naive substring match on this very file.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const requireCalls = code.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || [];
    expect(requireCalls.some((r) => /send-customer-message|sendCustomerMessage/.test(r))).toBe(false);
    expect(requireCalls.some((r) => /notification-service/i.test(r))).toBe(false);
    expect(requireCalls.some((r) => /nodemailer|sendgrid|resend/i.test(r))).toBe(false);
  });
});
