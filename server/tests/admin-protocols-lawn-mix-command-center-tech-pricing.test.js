/**
 * ADMIN-BUG-R44 (audit repro r2-tech-reachable-leftovers-dispatch-protocols-2)
 *
 * GET /api/admin/protocols/lawn-mix and GET /api/admin/protocols/lawn/command-center
 * were technician-reachable (router.use(adminAuthenticate, requireTechOrAdmin)) yet
 * emitted owner-only vendor pricing (bestPrice / costPerUnit / bestVendor /
 * material-cost total) with no role projection, unlike the neighbouring job-card
 * routes (viewerSeesPricing).
 *
 * Fixed: lawn-mix applies viewerSeesPricing's projection (stripLawnMixItemPricing)
 * — still technician-reachable, pricing/materialCost fields stripped. command-center
 * is locked to requireAdmin outright (an owner-only Service Library screen with no
 * technician UI caller — /admin/service-library is not in
 * TECH_ALLOWED_PATH_PREFIXES), so its test below is an HTTP-level 403 check rather
 * than a body projection.
 *
 * lawn-mix pattern copied from tests/admin-protocols-lawn-mix-planned.test.js (db
 * mocked, handler invoked directly with req.techRole = 'technician' as the job-card
 * test does).
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: async () => false };
  fn.raw = () => ({});
  return fn;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../config/protocols.json', () => ({
  lawn: { st_augustine: { name: 'Fixture lawn track', visits: [] } },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lawn-protocol-operating-layer', () => ({
  getActiveLawnProtocol: jest.fn(),
  getProtocolWindowContext: jest.fn(),
  summarizeProtocolContext: jest.fn(),
  protocolReferenceSyncIssues: jest.fn(async () => []),
  lockDraftProtocol: jest.fn(),
}));

const db = require('../models/db');
const protocols = require('../config/protocols.json');
const adminProtocolsRouter = require('../routes/admin-protocols');

const CATALOG = [
  {
    id: 'kflow', name: 'LESCO K-Flow 0-0-25', aliases: ['K-Flow'],
    default_rate_per_1000: 3, rate_unit: 'fl_oz',
    best_price: 89.5, best_vendor: 'SiteOne', cost_per_unit: 0.12, cost_unit: 'fl_oz', needs_pricing: false,
  },
];

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'orWhereNull', 'whereIn', 'whereNotNull', 'whereRaw', 'join', 'select', 'orderByRaw', 'orderBy', 'limit', 'count']) {
    query[method] = jest.fn(() => query);
  }
  query.first = jest.fn(async () => rows[0] || null);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  query.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return query;
}

const handlerFor = (path) => adminProtocolsRouter.stack.find((layer) => (
  layer.route?.path === path && layer.route.methods.get
)).route.stack[0].handle;

async function callAsTechnician(path, query, actorOverride) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handlerFor(path)({ query, techRole: 'technician', technicianId: 'tech-1', ...actorOverride }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledTimes(1);
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}

beforeEach(() => {
  jest.clearAllMocks();
  const calibration = {
    id: 'calibration-fixture', equipment_system_id: 'tank-fixture',
    system_name: 'Fixture tank', system_type: 'tank',
    // A real Date instance — codex round-3 P1: deepStripPriceTokens
    // recursed into it like a plain object (Object.entries(date) is [])
    // and turned it into {}; ProtocolTankSheet then read expiresAt as
    // missing and hid the calibration/quantity it gates.
    carrier_gal_per_1000: 2, tank_capacity_gal: 40, expires_at: new Date('2030-06-01T00:00:00.000Z'),
  };
  protocols.lawn.st_augustine.visits = [{
    month: 'Sep', visit: 9, notes: '', primary: 'K-Flow 0-0-25 ($2.18)', secondary: '',
  }];
  db.mockImplementation((table) => {
    if (table === 'equipment_calibrations as ec') return readQuery([calibration]);
    if (table === 'products_catalog') return readQuery(CATALOG);
    if (table === 'product_aliases') return readQuery(CATALOG.flatMap((p) => p.aliases.map((alias_name) => ({ product_id: p.id, alias_name }))));
    if (table === 'lawn_protocol_audit_log') return readQuery([{ id: 'a1', action: 'update', actor_name: 'Owner', actor_email: 'owner@example.test' }]);
    // lawn_protocols (validation lookup + drafts), knowledge_base, completions: empty
    return readQuery([]);
  });
});

test('lawn-mix: control — an admin token still sees vendor pricing and the material-cost total', async () => {
  const body = await callAsTechnician('/lawn-mix', { track: 'st_augustine', month: 'Sep', lawnSqft: '8000' }, { techRole: 'admin', technicianId: 'admin-1' });
  expect(body.items[0].product).toMatchObject({ bestPrice: 89.5, costPerUnit: 0.12 });
  expect(typeof body.materialCostSummary?.total).toBe('number');
});

test('lawn-mix: a technician token gets no per-product vendor pricing and no material-cost total', async () => {
  const body = await callAsTechnician('/lawn-mix', { track: 'st_augustine', month: 'Sep', lawnSqft: '8000' });
  expect(body.items).toHaveLength(1);
  const product = body.items[0].product;
  expect(product).toMatchObject({ id: 'kflow' });
  // Expected (job-card projection / admin-inventory OWNER_ONLY_PRODUCT_FIELDS): stripped for technicians.
  expect(product).not.toHaveProperty('bestPrice');
  expect(product).not.toHaveProperty('costPerUnit');
  expect(product).not.toHaveProperty('costUnit');
  expect(body.materialCostSummary?.total ?? null).toBeNull();
  expect(body.items[0].jobMix?.materialCost ?? null).toBeNull();
});

test('codex round-3 P1: a Date field (equipment.expiresAt) survives deepStripPriceTokens intact — never corrupted into {}', async () => {
  const body = await callAsTechnician('/lawn-mix', { track: 'st_augustine', month: 'Sep', lawnSqft: '8000' });
  expect(body.equipment).toBeTruthy();
  expect(body.equipment.expiresAt).not.toEqual({});
  expect(new Date(body.equipment.expiresAt).getTime()).toBe(new Date('2030-06-01T00:00:00.000Z').getTime());
});

test("lawn-mix: codex round-1 P1 — item.raw and visit.primary/secondary still carried the priced-line text verbatim (ProtocolReferenceTabV2.jsx renders it unconditionally); no '$' digit anywhere in the technician response now", async () => {
  const body = await callAsTechnician('/lawn-mix', { track: 'st_augustine', month: 'Sep', lawnSqft: '8000' });
  expect(body.items[0].raw).not.toMatch(/\$/);
  expect(body.items[0].raw).toContain('K-Flow 0-0-25');
  expect(body.visit.primary).not.toMatch(/\$/);
  expect(JSON.stringify(body)).not.toMatch(/\$\s?\d/);
});

test('lawn-mix: control — an admin token still sees the priced-line text verbatim', async () => {
  const body = await callAsTechnician('/lawn-mix', { track: 'st_augustine', month: 'Sep', lawnSqft: '8000' }, { techRole: 'admin', technicianId: 'admin-1' });
  expect(body.items[0].raw).toContain('$2.18');
  expect(body.visit.primary).toContain('$2.18');
});

test("lawn-mix: an unmatched priced line's warning message and lines[] also lose their dollar figures for a technician", async () => {
  protocols.lawn.st_augustine.visits = [{
    month: 'Sep', visit: 9, notes: '', primary: 'Some Unmatched Product Spray ($4.50)', secondary: '',
  }];
  const body = await callAsTechnician('/lawn-mix', { track: 'st_augustine', month: 'Sep', lawnSqft: '8000' });
  const warning = body.warnings.find((w) => w.code === 'unmatched_product');
  expect(warning).toBeTruthy();
  expect(warning.message).not.toMatch(/\$/);
  expect(warning.lines.join(' ')).not.toMatch(/\$/);
  expect(JSON.stringify(body)).not.toMatch(/\$\s?\d/);
});

test("lawn/command-center: requireAdmin sits directly in front of the handler, and it is the REAL requireAdmin (not this file's no-op mock)", () => {
  const layer = adminProtocolsRouter.stack.find((l) => l.route?.path === '/lawn/command-center' && l.route.methods.get);
  expect(layer).toBeTruthy();
  // Two middlewares now: requireAdmin, then the handler — a technician
  // token never reaches the vendor-pricing / staff-email / drafts payload.
  // (route.stack[0].handle is this file's mocked requireAdmin — jest.fn() —
  // so we exercise the REAL implementation directly below instead.)
  expect(layer.route.stack.length).toBe(2);
});

test('lawn/command-center: the REAL requireAdmin refuses a technician (403) and passes an admin through', () => {
  const { requireAdmin } = jest.requireActual('../middleware/admin-auth');
  const res403 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  requireAdmin({ techRole: 'technician' }, res403, next);
  expect(res403.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();

  const res200 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const nextAdmin = jest.fn();
  requireAdmin({ techRole: 'admin' }, res200, nextAdmin);
  expect(res200.status).not.toHaveBeenCalled();
  expect(nextAdmin).toHaveBeenCalledTimes(1);
});
