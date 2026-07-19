/**
 * admin-pricing-config: write authorization + pre-commit validation +
 * margin-check honesty (estimator audit P1 #4 and the /margin-check P2).
 *
 * - Writes (lawn-brackets, discount-rules, PUT /:key) are ADMIN-only;
 *   technician logins keep reads and the calculators.
 * - Every write validates the FULL payload before any row commits —
 *   pricing_config is DB-authoritative (db-bridge syncs it over the in-code
 *   constants), so a bad commit poisons live pricing immediately.
 * - /margin-check honors the requested WaveGuard tier (bundle size drives
 *   the engine-derived discount) and includes the ADMIN_ANNUAL allocation
 *   in fully-allocated cost per docs/pricing/POLICY.md.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockWrites = [];
let mockPricingConfigRow = null;
let mockDiscountRuleRow = null;
let mockLawnBracketRows = [];
let mockProposalRow = null;

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = {
      where() { return b; },
      whereIn() { return b; },
      whereNull() { return b; },
      join() { return b; },
      select() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      async first() {
        if (table === 'pricing_config') return mockPricingConfigRow;
        if (table === 'service_discount_rules') return mockDiscountRuleRow;
        if (table === 'pricing_engine_proposals') return mockProposalRow;
        return null;
      },
      async update(payload) { mockWrites.push({ table, op: 'update', payload }); return 1; },
      async insert(payload) { mockWrites.push({ table, op: 'insert', payload }); return [1]; },
      then(resolve, reject) {
        if (table === 'lawn_pricing_brackets') return Promise.resolve(mockLawnBracketRows).then(resolve, reject);
        return Promise.resolve([]).then(resolve, reject);
      },
      catch() { return b; },
    };
    return b;
  };
  const db = jest.fn((table) => makeBuilder(table));
  db.schema = { hasTable: jest.fn().mockResolvedValue(false) };
  db.raw = jest.fn();
  db.transaction = async (fn) => fn(db);
  return db;
});

// Role-driven middleware mirror: adminAuthenticate stamps techRole from a
// test header; requireAdmin/requireTechOrAdmin enforce it exactly like the
// real middleware, so these tests pin that the WRITE routes actually wire
// requireAdmin (the P1: every technician could write pricing config).
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = req.headers['x-test-role'] || 'technician'; next(); },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const { GLOBAL } = require('../services/pricing-engine/constants');
const pricingConfigRouter = require('../routes/admin-pricing-config');
const pricingProposalsRouter = require('../routes/admin-pricing-proposals');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/pricing-config', pricingConfigRouter);
  app.use('/admin/pricing-proposals', pricingProposalsRouter);
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

async function call(baseUrl, method, path, { role = 'technician', body } = {}) {
  const res = await fetch(`${baseUrl}/admin/pricing-config${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(() => {
  mockWrites.length = 0;
  mockPricingConfigRow = null;
  mockDiscountRuleRow = null;
  mockLawnBracketRows = [];
  mockProposalRow = null;
});

describe('write authorization — technician logins cannot change pricing', () => {
  test.each([
    ['PUT', '/lawn-brackets/st_augustine', { brackets: [{ sqft_bracket: 3000, tier: 'basic', monthly_price: 45 }] }],
    ['PUT', '/discount-rules/pest', { max_discount_pct: 0.15 }],
    ['PUT', '/global_labor_rate', { data: { value: 40 } }],
  ])('%s %s is 403 for a technician and persists nothing', async (method, path, body) => {
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, method, path, { role: 'technician', body });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('Admin access required');
      expect(mockWrites).toEqual([]);
    });
  });

  test('admin can still write (lawn bracket happy path)', async () => {
    mockLawnBracketRows = [{ sqft_bracket: 3000, tier: 'basic', monthly_price: '40', grass_track: 'st_augustine' }];
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PUT', '/lawn-brackets/st_augustine', {
        role: 'admin',
        body: { brackets: [{ sqft_bracket: 3000, tier: 'basic', monthly_price: 45 }], reason: 'test' },
      });
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(mockWrites.some((w) => w.table === 'lawn_pricing_brackets' && w.op === 'update')).toBe(true);
    });
  });

  test('technician keeps the margin calculator (read/calc surface unchanged)', async () => {
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'POST', '/margin-check', { role: 'technician', body: { waveguardTier: 'gold' } });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.services)).toBe(true);
    });
  });
});

describe('pre-commit validation — nothing persists on a bad payload', () => {
  test('lawn bracket batch with one zero/negative cell rejects the WHOLE batch before any write', async () => {
    mockLawnBracketRows = [{ sqft_bracket: 3000, tier: 'basic', monthly_price: '40', grass_track: 'st_augustine' }];
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PUT', '/lawn-brackets/st_augustine', {
        role: 'admin',
        body: {
          brackets: [
            { sqft_bracket: 3000, tier: 'basic', monthly_price: 45 },
            { sqft_bracket: 4000, tier: 'basic', monthly_price: 0 },
          ],
        },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/positive number/);
      expect(mockWrites).toEqual([]);
    });
  });

  test('booleans never coerce to prices — Number(true) === 1 must not become $1/hr labor', async () => {
    mockPricingConfigRow = { config_key: 'global_labor_rate', category: 'global', data: { value: 35 } };
    mockLawnBracketRows = [{ sqft_bracket: 3000, tier: 'basic', monthly_price: '40', grass_track: 'st_augustine' }];
    await withServer(async (baseUrl) => {
      const labor = await call(baseUrl, 'PUT', '/global_labor_rate', { role: 'admin', body: { data: { value: true } } });
      expect(labor.status).toBe(400);

      const bracket = await call(baseUrl, 'PUT', '/lawn-brackets/st_augustine', {
        role: 'admin',
        body: { brackets: [{ sqft_bracket: 3000, tier: 'basic', monthly_price: true }] },
      });
      expect(bracket.status).toBe(400);

      const credit = await call(baseUrl, 'PUT', '/discount-rules/pest', { role: 'admin', body: { flat_credit: true } });
      expect(credit.status).toBe(400);
      expect(mockWrites).toEqual([]);
    });
  });

  test('lawn bracket identifiers validate: unknown cell and duplicate cell reject before write', async () => {
    mockLawnBracketRows = [{ sqft_bracket: 3000, tier: 'basic', monthly_price: '40', grass_track: 'st_augustine' }];
    await withServer(async (baseUrl) => {
      const unknown = await call(baseUrl, 'PUT', '/lawn-brackets/st_augustine', {
        role: 'admin',
        body: { brackets: [{ sqft_bracket: 9999, tier: 'basic', monthly_price: 45 }] },
      });
      expect(unknown.status).toBe(400);
      expect(unknown.json.error).toMatch(/unknown bracket cell/);

      const dupe = await call(baseUrl, 'PUT', '/lawn-brackets/st_augustine', {
        role: 'admin',
        body: {
          brackets: [
            { sqft_bracket: 3000, tier: 'basic', monthly_price: 45 },
            { sqft_bracket: 3000, tier: 'basic', monthly_price: 50 },
          ],
        },
      });
      expect(dupe.status).toBe(400);
      expect(dupe.json.error).toMatch(/duplicate bracket cell/);

      const badTier = await call(baseUrl, 'PUT', '/lawn-brackets/st_augustine', {
        role: 'admin',
        body: { brackets: [{ sqft_bracket: 3000, tier: '', monthly_price: 45 }] },
      });
      expect(badTier.status).toBe(400);
      expect(mockWrites).toEqual([]);
    });
  });

  test('discount rule ratio out of range rejects before write', async () => {
    mockDiscountRuleRow = { service_key: 'pest', max_discount_pct: '0.10' };
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PUT', '/discount-rules/pest', { role: 'admin', body: { max_discount_pct: 1.5 } });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/ratio in \[0, 1\)/);
      expect(mockWrites).toEqual([]);
    });
  });

  test.each([
    ['global_labor_rate', { value: -5 }, /positive/],
    ['global_labor_rate', { value: null }, /positive/],
    ['global_margin_floor', { value: 35 }, /ratio in \(0, 1\)/],
    // Zero returns success today but syncConstantsFromDB applies these via
    // truthy checks — the runtime would silently ignore the stored 0.
    ['global_margin_floor', { value: 0 }, /ratio in \(0, 1\)/],
    ['global_drive_time', { value: 0 }, /positive number/],
    ['global_admin_annual', { value: null }, /positive number/],
  ])('PUT /%s with invalid value rejects before write', async (key, data, message) => {
    mockPricingConfigRow = { config_key: key, category: 'global', data: { value: 35 } };
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PUT', `/${key}`, { role: 'admin', body: { data } });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(message);
      expect(mockWrites).toEqual([]);
    });
  });

  test('pest_base validates the COMPLETE payload the sync consumes, not just base', async () => {
    mockPricingConfigRow = { config_key: 'pest_base', category: 'pest', data: { base: 117, floor: 89 } };
    await withServer(async (baseUrl) => {
      const badFloor = await call(baseUrl, 'PUT', '/pest_base', { role: 'admin', body: { data: { base: 117, floor: -1 } } });
      expect(badFloor.status).toBe(400);
      expect(badFloor.json.error).toMatch(/pest_base\.floor/);

      const badRoach = await call(baseUrl, 'PUT', '/pest_base', {
        role: 'admin',
        body: { data: { base: 117, floor: 89, initial_roach: { german: [{ sqft: 2000, price: 0 }] } } },
      });
      expect(badRoach.status).toBe(400);
      expect(badRoach.json.error).toMatch(/initial_roach\.german/);
      expect(mockWrites).toEqual([]);

      const good = await call(baseUrl, 'PUT', '/pest_base', {
        role: 'admin',
        body: { data: { base: 120, floor: 89, enforce_floor_post_discount: true, initial_roach: { german: [{ sqft: 2000, price: 275 }, { sqft: 'Infinity', price: 350 }] } } },
      });
      expect(good.status).toBe(200);
      expect(mockWrites.some((w) => w.table === 'pricing_config' && w.op === 'update')).toBe(true);
    });
  });

  test('roach brackets enforce the engine invariants the sync would reject AFTER persisting', async () => {
    mockPricingConfigRow = {
      config_key: 'pest_base',
      category: 'pest',
      data: { base: 117, floor: 89, initial_roach: { german: [{ sqft: 2000, price: 275 }, { sqft: 'Infinity', price: 350 }] } },
    };
    const body = (german) => ({ data: { base: 117, floor: 89, initial_roach: { german } } });
    await withServer(async (baseUrl) => {
      // Unsorted brackets.
      const unsorted = await call(baseUrl, 'PUT', '/pest_base', {
        role: 'admin',
        body: body([{ sqft: 3000, price: 300 }, { sqft: 2000, price: 275 }, { sqft: 'Infinity', price: 350 }]),
      });
      expect(unsorted.status).toBe(400);
      expect(unsorted.json.error).toMatch(/sorted ascending/);

      // Infinity before the final row.
      const midInfinity = await call(baseUrl, 'PUT', '/pest_base', {
        role: 'admin',
        body: body([{ sqft: 'Infinity', price: 350 }, { sqft: 2000, price: 275 }]),
      });
      expect(midInfinity.status).toBe(400);
      expect(midInfinity.json.error).toMatch(/only on the final bracket/);

      // No terminal Infinity at all.
      const noTerminal = await call(baseUrl, 'PUT', '/pest_base', {
        role: 'admin',
        body: body([{ sqft: 2000, price: 275 }, { sqft: 5000, price: 320 }]),
      });
      expect(noTerminal.status).toBe(400);
      expect(noTerminal.json.error).toMatch(/final bracket's sqft must be null or 'Infinity'/);
      expect(mockWrites).toEqual([]);
    });
  });

  test('lawn grid config with a non-positive price rejects before write', async () => {
    mockPricingConfigRow = {
      config_key: 'lawn_st_augustine',
      category: 'lawn',
      data: [[0, 35, 45], [3000, 35, 45]],
    };
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PUT', '/lawn_st_augustine', {
        role: 'admin',
        body: { data: [[0, 35, 45], [3000, 0, 45]] },
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/positive number/);
      expect(mockWrites).toEqual([]);
    });
  });

  test('numeric STRINGS are rejected — the raw payload is what gets persisted and synced', async () => {
    // A stored "51" would concatenate in pricing arithmetic (100 + "51").
    mockPricingConfigRow = { config_key: 'global_admin_annual', category: 'global', data: { value: 51 } };
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PUT', '/global_admin_annual', { role: 'admin', body: { data: { value: '51' } } });
      expect(res.status).toBe(400);
      expect(mockWrites).toEqual([]);
    });
  });

  test('whole-object PUT cannot silently DROP stored keys (raw-JSON editor path)', async () => {
    mockPricingConfigRow = {
      config_key: 'waveguard_tiers',
      category: 'waveguard',
      data: {
        bronze: { min_services: 1, discount: 0 },
        silver: { min_services: 2, discount: 0.10 },
        gold: { min_services: 3, discount: 0.15 },
        platinum: { min_services: 4, discount: 0.20 },
      },
    };
    await withServer(async (baseUrl) => {
      const emptied = await call(baseUrl, 'PUT', '/waveguard_tiers', { role: 'admin', body: { data: {} } });
      expect(emptied.status).toBe(400);
      expect(emptied.json.error).toMatch(/drops existing key/);
    });

    mockPricingConfigRow = {
      config_key: 'pest_base',
      category: 'pest',
      data: { base: 117, floor: 89, initial_roach: { german: [{ sqft: 2000, price: 275 }] } },
    };
    await withServer(async (baseUrl) => {
      const dropped = await call(baseUrl, 'PUT', '/pest_base', { role: 'admin', body: { data: { base: 117, floor: 89 } } });
      expect(dropped.status).toBe(400);
      expect(dropped.json.error).toMatch(/initial_roach/);
      expect(mockWrites).toEqual([]);
    });

    // Nested drop: initial_roach present but a stored species omitted.
    mockPricingConfigRow = {
      config_key: 'pest_base',
      category: 'pest',
      data: {
        base: 117,
        floor: 89,
        initial_roach: {
          regular: [{ sqft: null, price: 250 }],
          german: [{ sqft: 'Infinity', price: 350 }],
        },
      },
    };
    await withServer(async (baseUrl) => {
      const nested = await call(baseUrl, 'PUT', '/pest_base', {
        role: 'admin',
        body: { data: { base: 117, floor: 89, initial_roach: { german: [{ sqft: 'Infinity', price: 355 }] } } },
      });
      expect(nested.status).toBe(400);
      expect(nested.json.error).toMatch(/drops stored species regular/);
      expect(mockWrites).toEqual([]);
    });
  });

  test('shape mismatch (object replaced by string) rejects before write', async () => {
    mockPricingConfigRow = { config_key: 'pest_features', category: 'pest', data: { indoor: 15 } };
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PUT', '/pest_features', { role: 'admin', body: { data: 'oops' } });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/shape mismatch/);
      expect(mockWrites).toEqual([]);
    });
  });

  test('a valid global write still lands and audits', async () => {
    mockPricingConfigRow = { config_key: 'global_labor_rate', category: 'global', data: { value: 35 } };
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'PUT', '/global_labor_rate', {
        role: 'admin',
        body: { data: { value: 38 }, reason: 'cost review' },
      });
      expect(res.status).toBe(200);
      expect(mockWrites.some((w) => w.table === 'pricing_config' && w.op === 'update')).toBe(true);
      expect(mockWrites.some((w) => w.table === 'pricing_config_audit' && w.op === 'insert')).toBe(true);
    });
  });
});

describe('/margin-check — honors the requested tier, costs are fully allocated', () => {
  test('bronze prices a single-service bundle; platinum prices four', async () => {
    await withServer(async (baseUrl) => {
      const bronze = await call(baseUrl, 'POST', '/margin-check', { role: 'admin', body: { waveguardTier: 'bronze' } });
      expect(bronze.json.waveguardTier).toBe('bronze');
      const bronzeServices = bronze.json.services.map((s) => s.service);
      expect(bronzeServices.some((s) => /lawn|mosquito|treeShrub|tree_shrub/i.test(s))).toBe(false);

      const platinum = await call(baseUrl, 'POST', '/margin-check', { role: 'admin', body: { waveguardTier: 'platinum' } });
      expect(platinum.json.waveguardTier).toBe('platinum');
      expect(platinum.json.services.length).toBeGreaterThan(bronze.json.services.length);
    });
  });

  test('an unknown tier falls back to gold instead of silently pricing platinum', async () => {
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'POST', '/margin-check', { role: 'admin', body: { waveguardTier: 'diamond' } });
      expect(res.json.waveguardTier).toBe('gold');
      expect(res.json.waveguardTierRequested).toBe('gold');
    });
  });

  test('the label is the ENGINE-derived tier, with requested/mismatch surfaced', async () => {
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'POST', '/margin-check', { role: 'admin', body: { waveguardTier: 'silver' } });
      // With default thresholds the two agree; the contract is that the
      // label always comes from the priced bundle, never just the request.
      expect(res.json.waveguardTierRequested).toBe('silver');
      expect(res.json.waveguardTier).toBe(String(res.json.waveGuard?.tier || 'silver').toLowerCase());
      expect(res.json.waveguardTierMismatch).toBe(res.json.waveguardTier !== 'silver');
    });
  });

  test('estimated cost includes the ADMIN_ANNUAL allocation (POLICY.md fully-allocated COGS)', async () => {
    await withServer(async (baseUrl) => {
      const res = await call(baseUrl, 'POST', '/margin-check', { role: 'admin', body: { waveguardTier: 'bronze' } });
      const pest = res.json.services.find((s) => /pest/i.test(s.service));
      expect(pest).toBeDefined();
      // Fallback COGS for quarterly pest: (labor 20min + material 6.67 +
      // drive 20min) × 4 visits, PLUS the per-service-line admin allocation.
      const laborPerVisit = (GLOBAL.LABOR_RATE * 20) / 60;
      const drivePerVisit = (GLOBAL.LABOR_RATE * GLOBAL.DRIVE_TIME) / 60;
      const expected = Math.round((laborPerVisit + 6.67 + drivePerVisit) * 4 + GLOBAL.ADMIN_ANNUAL);
      expect(pest.estimatedCost).toBe(expected);
    });
  });
});

describe('pricing-proposals mutations — same admin gate as direct pricing writes', () => {
  test('technician cannot approve or reject a proposal (the queue is not a pricing-write side door)', async () => {
    await withServer(async (baseUrl) => {
      const approve = await fetch(`${baseUrl}/admin/pricing-proposals/p1/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'technician' },
        body: JSON.stringify({}),
      });
      expect(approve.status).toBe(403);

      const reject = await fetch(`${baseUrl}/admin/pricing-proposals/p1/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'technician' },
        body: JSON.stringify({}),
      });
      expect(reject.status).toBe(403);
      expect(mockWrites).toEqual([]);
    });
  });

  test('approve runs the SAME key-specific range validation as PUT /:key on the prospective row', async () => {
    // Finite but wrong: margin floor of 35 (percent) instead of 0.35 (ratio).
    mockProposalRow = {
      id: 'p1',
      status: 'pending',
      config_key: 'global_margin_floor.value',
      current_value: 0.35,
      proposed_value: 35,
    };
    mockPricingConfigRow = { config_key: 'global_margin_floor', category: 'global', data: { value: 0.35 } };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pricing-proposals/p1/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'admin' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/fails pricing validation/);
      expect(mockWrites.filter((w) => w.table === 'pricing_config')).toEqual([]);
    });
  });

  test('approve refuses a non-numeric proposed_value before any write (jsonb null guard)', async () => {
    mockProposalRow = {
      id: 'p1',
      status: 'pending',
      config_key: 'pest_base.base',
      current_value: 117,
      proposed_value: 'abc',
    };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/pricing-proposals/p1/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'admin' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/non-numeric proposed_value/);
      expect(mockWrites).toEqual([]);
    });
  });
});
