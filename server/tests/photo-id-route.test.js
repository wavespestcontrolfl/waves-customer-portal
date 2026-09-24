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
      let rows = (TABLES[table] || []).filter((r) => matches(r, filters));
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
      const rows = (TABLES[table] || []).filter((r) => matches(r, filters));
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

  test('tree_shrub: reservice access uses the lawn lane (tree has no lane of its own)', async () => {
    mockReserviceAccess.mockResolvedValue({ token: 'tok-tree', lanes: ['lawn'] });
    await withServer(async (base) => {
      const res = await post(base, '/api/photo-id/tree_shrub', photoBody());
      const body = await res.json();
      expect(body.next_step.kind).toBe('reservice');
      expect(body.next_step.url).toBe('/reservice/tok-tree');
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
