// Tap to Pay card save (no charge): mint, validate, the charge fence and
// complete-setup. Routes run for real over an in-memory fake of the few
// tables they touch; Stripe, the plan context and finishVerifiedSecureCapture
// are fakes. Synthetic data only.
process.env.TERMINAL_HANDOFF_SECRET = 'h'.repeat(40);

const mockState = { tables: {}, gateOn: true };
const mockStripe = {
  setupIntents: { create: jest.fn(), retrieve: jest.fn() },
  terminal: { connectionTokens: { create: jest.fn(async () => ({ secret: 'pst_test' })) } },
};
const mockFinish = jest.fn();
const mockStillNeeds = jest.fn();
const mockPlanContext = jest.fn();
const mockRetrieveSetupIntent = jest.fn();
const mockAudit = {
  auditTerminalHandoffMint: jest.fn(),
  auditTerminalHandoffRateLimited: jest.fn(),
  auditTerminalHandoffValidate: jest.fn(),
};

jest.mock('../models/db', () => {
  const now = { __now: true };
  const matches = (row, key, op, val) => {
    if (op === '=') return row[key] === val;
    const left = row[key] instanceof Date ? row[key].getTime() : row[key];
    const right = val && val.__now ? Date.now() : val;
    return op === '>' ? left > right : left < right;
  };
  function table(name) {
    const rows = () => (mockState.tables[name] = mockState.tables[name] || []);
    const filters = [];
    const find = () => rows().filter((row) => filters.every((f) => f(row)));
    const api = {
      where(a, b, c) {
        if (a && typeof a === 'object') Object.entries(a).forEach(([k, v]) => filters.push((r) => matches(r, k, '=', v)));
        else if (c === undefined) filters.push((r) => matches(r, a, '=', b));
        else if (c && c.__raw) filters.push((r) => r[a] && new Date(r[a]).getTime() > Date.now() - 3600 * 1000);
        else filters.push((r) => matches(r, a, b, c));
        return api;
      },
      whereNull(k) { filters.push((r) => r[k] == null); return api; },
      forUpdate() { return api; },
      async first() { return find()[0]; },
      select(...cols) {
        if (cols.some((c) => c && c.__raw)) {
          const hit = find();
          const oldest = hit.map((r) => new Date(r.created_at).getTime()).sort()[0];
          return Promise.resolve([{ count: hit.length, oldest: oldest ? new Date(oldest) : null }]);
        }
        return Promise.resolve(find());
      },
      update(patch) {
        const hit = find();
        hit.forEach((r) => Object.assign(r, patch, patch.used_at && patch.used_at.__now ? { used_at: new Date() } : {}));
        const out = Promise.resolve(hit.length);
        out.returning = () => Promise.resolve(hit.map((r) => ({ ...r })));
        return out;
      },
      async insert(row) {
        rows().push({ created_at: new Date(), used_at: null, kind: 'collect', ...row });
      },
    };
    return api;
  }
  const db = jest.fn((name) => table(name));
  db.fn = { now: () => now };
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.transaction = async (cb) => {
    const trx = jest.fn((name) => table(name));
    trx.raw = jest.fn((sql) => ({ __raw: sql }));
    return cb(trx);
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ jwt: { secret: 'staff-jwt-secret' } }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_placeholder' }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => mockState.gateOn) }));
jest.mock('../services/audit-log', () => ({
  ...mockAudit,
  ipFromReq: jest.fn(() => '203.0.113.9'),
  uaFromReq: jest.fn(() => 'WavesAdmin/1.8'),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (!req.headers['x-test-role']) return res.status(401).json({ error: 'Authentication required' });
    req.technicianId = 'tech-1';
    req.techRole = req.headers['x-test-role'];
    req.staffToken = { tokenVersion: 3, mfa: true };
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin'
    ? next() : res.status(403).json({ error: 'Admin access required' })),
  isStaffAccessToken: jest.fn(() => true),
  staffTokenVersionMatches: jest.fn(() => true),
}));
jest.mock('../services/staff-mfa', () => ({ sessionMfaBlock: jest.fn(() => null) }));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(),
  parkInvoiceForSavedCardReconciliation: jest.fn(),
  ensureStripeCustomer: jest.fn(async () => 'cus_test1'),
  retrieveSetupIntent: (...args) => mockRetrieveSetupIntent(...args),
}));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn() }));
jest.mock('../services/appointment-card-request', () => ({
  STICKY_DISCLOSURE_VERSION: 'sticky_v1',
  secureVisitStillNeedsCard: (...args) => mockStillNeeds(...args),
  finishVerifiedSecureCapture: (...args) => mockFinish(...args),
}));
jest.mock('../services/secure-appointment-plans', () => ({
  buildSecurePlanContext: (...args) => mockPlanContext(...args),
}));
jest.mock('stripe', () => jest.fn(() => mockStripe));

const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../routes/stripe-terminal');
const { CONSENT_VERSION } = require('../services/payment-method-consent-text');

const SECRET = process.env.TERMINAL_HANDOFF_SECRET;
const STAFF_SECRET = 'staff-jwt-secret';
const SECURE_TOKEN = 'A'.repeat(22);

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe/terminal', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/stripe/terminal`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ADMIN = { 'x-test-role': 'admin' };
const mintBody = (extra = {}) => ({ secure_token: SECURE_TOKEN, consent_text_version: CONSENT_VERSION, agreed: true, ...extra });

function seed(overrides = {}) {
  mockState.gateOn = true;
  mockState.tables = {
    appointment_card_requests: [{
      id: 'req-1', token: SECURE_TOKEN, status: 'pending', kind: 'visit', customer_id: 'cust-1',
      scheduled_service_id: 'visit-1', selected_plan: null, ...overrides.request,
    }],
    customers: [{ id: 'cust-1', first_name: 'Test', last_name: 'Customer', stripe_customer_id: 'cus_test1' }],
    scheduled_services: [{ id: 'visit-1', service_type: 'Quarterly Pest Control Service' }],
    technicians: [{ id: 'tech-1', name: 'Tech One', role: 'admin', active: true, auth_token_version: 3 }],
    payment_methods: [],
    terminal_handoff_tokens: [],
  };
}

function signHandoff(claims = {}, options = {}) {
  return jwt.sign({
    tech_user_id: 'tech-1', staff_token_version: 3, staff_mfa: true, jti: 'jti-save-1',
    kind: 'save_card', card_request_id: 'req-1', ...claims,
  }, SECRET, { algorithm: 'HS256', issuer: 'waves-portal', audience: 'waves-pay-ios', expiresIn: 60, ...options });
}

function seedSaveCardRow(extra = {}) {
  mockState.tables.terminal_handoff_tokens.push({
    jti: 'jti-save-1', tech_user_id: 'tech-1', kind: 'save_card', invoice_id: null, amount_cents: 0,
    appointment_card_request_id: 'req-1', stripe_setup_intent_id: 'seti_1', consent_text_version: CONSENT_VERSION,
    staff_mfa: true, expires_at: new Date(Date.now() + 60000), ...extra,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  mockStillNeeds.mockResolvedValue({ ok: true });
  mockPlanContext.mockResolvedValue(null);
  mockStripe.setupIntents.create.mockImplementation(async () => ({ id: 'seti_1', client_secret: 'seti_1_secret' }));
  mockStripe.setupIntents.retrieve.mockImplementation(async () => ({
    id: 'seti_1', status: 'requires_payment_method', client_secret: 'seti_1_secret',
    metadata: { appointment_card_request_id: 'req-1' },
  }));
});

describe('POST /save-card-handoff', () => {
  test('is a 404 while the gate is off, before auth and before any Stripe call', async () => {
    mockState.gateOn = false;
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody());
      expect(res.status).toBe(404);
    });
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
  });

  test('refuses a non-admin', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody(), { 'x-test-role': 'technician' });
      expect(res.status).toBe(403);
    });
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
  });

  test.each([
    ['agreed is false', { agreed: false }, 400, 'consent_required'],
    ['agreed is missing', { agreed: undefined }, 400, 'consent_required'],
    ['the consent version is stale', { consent_text_version: 'v1_2020-01-01' }, 409, 'CONSENT_VERSION_STALE'],
    ['the consent version is missing', { consent_text_version: undefined }, 409, 'CONSENT_VERSION_STALE'],
  ])('refuses when %s', async (_label, extra, status, code) => {
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody(extra), ADMIN);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
    });
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
    expect(mockState.tables.terminal_handoff_tokens).toHaveLength(0);
  });

  test('refuses an unknown secure token', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody({ secure_token: 'B'.repeat(22) }), ADMIN);
      expect(res.status).toBe(404);
    });
  });

  test.each([
    ['completed', 409, 'request_not_pending'],
    ['satisfied', 409, 'request_not_pending'],
  ])('refuses a %s request', async (status, httpStatus, code) => {
    seed({ request: { status } });
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody(), ADMIN);
      expect(res.status).toBe(httpStatus);
      expect(res.body.code).toBe(code);
    });
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
  });

  test('refuses when the visit no longer needs a card', async () => {
    mockStillNeeds.mockResolvedValue({ ok: false, code: 'no_longer_needed' });
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody(), ADMIN);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('no_longer_needed');
    });
  });

  test('refuses a recurring plan that has not picked per_application', async () => {
    mockPlanContext.mockResolvedValue({ mode: 'recurring' });
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody(), ADMIN);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('plan_required');
    });
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
  });

  test('allows a recurring plan that picked per_application', async () => {
    seed({ request: { selected_plan: 'per_application' } });
    mockPlanContext.mockResolvedValue({ mode: 'recurring' });
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody(), ADMIN);
      expect(res.status).toBe(200);
    });
  });

  test('mints the SetupIntent, the jti row and the signed deep link', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody(), ADMIN);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['deep_link', 'expires_at', 'jti', 'token']);
      expect(res.body.deep_link).toBe(`wavespay://save-card?t=${encodeURIComponent(res.body.token)}`);

      const claims = jwt.verify(res.body.token, SECRET, { issuer: 'waves-portal', audience: 'waves-pay-ios' });
      expect(claims).toEqual(expect.objectContaining({
        kind: 'save_card', card_request_id: 'req-1', tech_user_id: 'tech-1', jti: res.body.jti,
        staff_token_version: 3, staff_mfa: true,
      }));
      expect(claims.invoice_id).toBeUndefined();
      expect(claims.amount_cents).toBeUndefined();
      expect(claims.exp - claims.iat).toBe(60);

      const [row] = mockState.tables.terminal_handoff_tokens;
      expect(row).toEqual(expect.objectContaining({
        jti: res.body.jti, kind: 'save_card', invoice_id: null, amount_cents: 0,
        appointment_card_request_id: 'req-1', stripe_setup_intent_id: 'seti_1',
        consent_text_version: CONSENT_VERSION, staff_mfa: true, tech_user_id: 'tech-1', used_at: null,
      }));
    });
    expect(mockStripe.setupIntents.create).toHaveBeenCalledTimes(1);
    const [params, opts] = mockStripe.setupIntents.create.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({
      payment_method_types: ['card_present'], customer: 'cus_test1', usage: 'off_session',
      metadata: expect.objectContaining({
        appointment_card_request_id: 'req-1', scheduled_service_id: 'visit-1', source: 'admin_tap_to_pay',
        consent_text_version: CONSENT_VERSION,
      }),
    }));
    expect(opts.idempotencyKey).toMatch(/^tap_save_card_[0-9a-f]{32}$/);
    expect(mockAudit.auditTerminalHandoffMint).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'save_card', card_request_id: 'req-1', tech_user_id: 'tech-1',
    }));
  });

  test('stores the sticky disclosure echo only when it is the accepted value', async () => {
    await withServer(async (base) => {
      await post(base, '/save-card-handoff', mintBody({ disclosure_version: 'sticky_v1' }), ADMIN);
      await post(base, '/save-card-handoff', mintBody({ disclosure_version: 'bogus' }), ADMIN);
      await post(base, '/save-card-handoff', mintBody(), ADMIN);
    });
    expect(mockState.tables.terminal_handoff_tokens.map((r) => r.disclosure_version)).toEqual(['sticky_v1', null, null]);
  });

  test('shares the per-tech hourly mint budget and creates nothing when limited', async () => {
    for (let i = 0; i < 20; i += 1) {
      mockState.tables.terminal_handoff_tokens.push({ jti: `old-${i}`, tech_user_id: 'tech-1', kind: 'collect', created_at: new Date() });
    }
    await withServer(async (base) => {
      const res = await post(base, '/save-card-handoff', mintBody(), ADMIN);
      expect(res.status).toBe(429);
    });
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
    expect(mockAudit.auditTerminalHandoffRateLimited).toHaveBeenCalled();
  });
});

describe('POST /validate-save-card-handoff', () => {
  test('burns the jti once and returns the SetupIntent and a card-save-only token', async () => {
    seedSaveCardRow();
    await withServer(async (base) => {
      const token = signHandoff();
      const first = await post(base, '/validate-save-card-handoff', { token });
      expect(first.status).toBe(200);
      expect(Object.keys(first.body).sort()).toEqual([
        'auth_token', 'card_request_id', 'customer_name', 'kind', 'service_name',
        'setup_intent_client_secret', 'setup_intent_id',
      ]);
      expect(first.body).toEqual(expect.objectContaining({
        kind: 'save_card', setup_intent_client_secret: 'seti_1_secret', setup_intent_id: 'seti_1',
        customer_name: 'Test Customer', service_name: 'Quarterly Pest Control Service', card_request_id: 'req-1',
      }));
      const terminal = jwt.verify(first.body.auth_token, STAFF_SECRET);
      expect(terminal).toEqual(expect.objectContaining({
        scope: 'terminal', save_card: true, jti: 'jti-save-1', technicianId: 'tech-1', mfa: true, tokenVersion: 3,
      }));
      expect(mockState.tables.terminal_handoff_tokens[0].used_at).toBeInstanceOf(Date);

      const second = await post(base, '/validate-save-card-handoff', { token });
      expect(second.status).toBe(410);
      expect(second.body.code).toBe('replay');
    });
  });

  test('refuses a payment token without burning it', async () => {
    mockState.tables.terminal_handoff_tokens.push({
      jti: 'jti-pay-1', tech_user_id: 'tech-1', kind: 'collect', invoice_id: 'inv-1', amount_cents: 5000,
      staff_mfa: true, expires_at: new Date(Date.now() + 60000),
    });
    const paymentToken = jwt.sign(
      { invoice_id: 'inv-1', amount_cents: 5000, tech_user_id: 'tech-1', staff_token_version: 3, staff_mfa: true, jti: 'jti-pay-1' },
      SECRET,
      { algorithm: 'HS256', issuer: 'waves-portal', audience: 'waves-pay-ios', expiresIn: 60 },
    );
    await withServer(async (base) => {
      const res = await post(base, '/validate-save-card-handoff', { token: paymentToken });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('wrong_token_kind');
    });
    expect(mockState.tables.terminal_handoff_tokens[0].used_at).toBeFalsy();
  });

  test('/validate-handoff refuses a save_card token without burning it', async () => {
    seedSaveCardRow();
    await withServer(async (base) => {
      const res = await post(base, '/validate-handoff', { token: signHandoff() });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('wrong_token_kind');
    });
    expect(mockState.tables.terminal_handoff_tokens[0].used_at).toBeFalsy();
  });

  test('refuses an expired token and an expired row', async () => {
    seedSaveCardRow({ expires_at: new Date(Date.now() - 1000) });
    await withServer(async (base) => {
      const stale = await post(base, '/validate-save-card-handoff', { token: signHandoff() });
      expect(stale.status).toBe(410);
      expect(stale.body.code).toBe('expired');
      const expiredJwt = await post(base, '/validate-save-card-handoff', { token: signHandoff({}, { expiresIn: -10 }) });
      expect(expiredJwt.status).toBe(410);
      expect(expiredJwt.body.code).toBe('expired');
    });
  });

  test('refuses a bad signature and an unknown jti', async () => {
    await withServer(async (base) => {
      const forged = jwt.sign({ kind: 'save_card', jti: 'x' }, 'wrong-secret-wrong-secret-wrong-secret!', {
        issuer: 'waves-portal', audience: 'waves-pay-ios',
      });
      expect((await post(base, '/validate-save-card-handoff', { token: forged })).status).toBe(401);
      const unknown = await post(base, '/validate-save-card-handoff', { token: signHandoff({ jti: 'nope' }) });
      expect(unknown.status).toBe(401);
      expect(unknown.body.code).toBe('signature_invalid');
    });
  });

  test('refuses when the card request changed after the mint', async () => {
    seedSaveCardRow();
    mockState.tables.appointment_card_requests[0].status = 'completed';
    await withServer(async (base) => {
      const res = await post(base, '/validate-save-card-handoff', { token: signHandoff() });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('request_changed');
    });
  });

  test('refuses a revoked staff session', async () => {
    seedSaveCardRow();
    mockState.tables.technicians[0].auth_token_version = 4;
    await withServer(async (base) => {
      const res = await post(base, '/validate-save-card-handoff', { token: signHandoff() });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('staff_session_revoked');
    });
  });
});

describe('the charge fence', () => {
  const saveCardAuth = () => ({
    authorization: `Bearer ${jwt.sign({
      technicianId: 'tech-1', role: 'admin', scope: 'terminal', type: 'access', tokenVersion: 3, save_card: true, jti: 'jti-save-1',
    }, STAFF_SECRET, { expiresIn: '15m' })}`,
  });
  const paymentAuth = () => ({
    authorization: `Bearer ${jwt.sign({
      technicianId: 'tech-1', role: 'admin', scope: 'terminal', type: 'access', tokenVersion: 3,
    }, STAFF_SECRET, { expiresIn: '15m' })}`,
  });

  test.each(['/payment-intent', '/apply-surcharge'])('%s refuses a save_card token', async (path) => {
    await withServer(async (base) => {
      const res = await post(base, path, { jti: 'jti-save-1', surcharge_capable: true }, saveCardAuth());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('save_card_token');
    });
    expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
  });

  test('a save_card jti is refused on the payment routes even for a payment token', async () => {
    seedSaveCardRow({ used_at: new Date() });
    await withServer(async (base) => {
      for (const path of ['/payment-intent', '/apply-surcharge']) {
        const res = await post(base, path, { jti: 'jti-save-1', surcharge_capable: true }, paymentAuth());
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('save_card_token');
      }
    });
  });

  test('/connection-token accepts both kinds', async () => {
    await withServer(async (base) => {
      expect((await post(base, '/connection-token', {}, saveCardAuth())).status).toBe(200);
      expect((await post(base, '/connection-token', {}, paymentAuth())).status).toBe(200);
    });
  });

  test('/complete-setup refuses a payment token', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, paymentAuth());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('save_card_token_required');
    });
  });
});

describe('POST /complete-setup', () => {
  const auth = () => ({
    authorization: `Bearer ${jwt.sign({
      technicianId: 'tech-1', role: 'admin', scope: 'terminal', type: 'access', tokenVersion: 3, save_card: true, jti: 'jti-save-1',
    }, STAFF_SECRET, { expiresIn: '15m' })}`,
  });
  const succeeded = (overrides = {}) => ({
    id: 'seti_1', status: 'succeeded', customer: 'cus_test1',
    metadata: { appointment_card_request_id: 'req-1', source: 'admin_tap_to_pay' },
    latest_attempt: { payment_method_details: { card_present: { generated_card: 'pm_generated1' } } },
    ...overrides,
  });

  beforeEach(() => {
    seedSaveCardRow({ used_at: new Date() });
    mockRetrieveSetupIntent.mockResolvedValue(succeeded());
    mockFinish.mockImplementation(async ({ request, stripePaymentMethodId, setupIntentId }) => {
      Object.assign(mockState.tables.appointment_card_requests[0], {
        status: 'completed', stripe_setup_intent_id: setupIntentId, stripe_payment_method_id: stripePaymentMethodId,
      });
      mockState.tables.payment_methods.push({
        stripe_payment_method_id: stripePaymentMethodId, card_brand: 'VISA', last_four: '4242', card_funding: 'credit',
      });
      expect(request.id).toBe('req-1');
      return { ok: true };
    });
  });

  test('saves the generated card through the shared completion tail', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, card: { brand: 'visa', last4: '4242', funding: 'credit' } });
    });
    expect(mockRetrieveSetupIntent).toHaveBeenCalledWith('seti_1', { expand: ['latest_attempt'] });
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({
      stripePaymentMethodId: 'pm_generated1', setupIntentId: 'seti_1', consentSource: 'admin_tap_to_pay',
      ip: '203.0.113.9', userAgent: 'WavesAdmin/1.8', disclosureVersion: null,
    }));
  });

  test('passes the stored disclosure echo through, null when absent', async () => {
    mockState.tables.terminal_handoff_tokens[0].disclosure_version = 'sticky_v1';
    await withServer(async (base) => {
      await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth());
    });
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ disclosureVersion: 'sticky_v1' }));
  });

  test('a retry after the save finished answers the same without saving again', async () => {
    await withServer(async (base) => {
      const first = await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth());
      const retry = await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth());
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
    });
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect(mockRetrieveSetupIntent).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['no attempt', { latest_attempt: null }],
    ['no generated card', { latest_attempt: { payment_method_details: { card_present: { generated_card: null } } } }],
    ['an unexpanded attempt', { latest_attempt: 'setatt_1' }],
  ])('answers 409 no_generated_card for %s', async (_label, overrides) => {
    mockRetrieveSetupIntent.mockResolvedValue(succeeded(overrides));
    await withServer(async (base) => {
      const res = await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth());
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        code: 'no_generated_card',
        error: 'This card cannot be saved for later charges. Try another card.',
      });
    });
    expect(mockFinish).not.toHaveBeenCalled();
  });

  test('refuses a SetupIntent that is not the one the handoff started', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/complete-setup', { setup_intent_id: 'seti_other' }, auth());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('setup_intent_mismatch');
    });
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
    expect(mockFinish).not.toHaveBeenCalled();
  });

  test('refuses an intent whose metadata, customer or status is wrong', async () => {
    await withServer(async (base) => {
      mockRetrieveSetupIntent.mockResolvedValue(succeeded({ metadata: { appointment_card_request_id: 'req-2', source: 'admin_tap_to_pay' } }));
      expect((await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth())).body.code).toBe('intent_mismatch');
      mockRetrieveSetupIntent.mockResolvedValue(succeeded({ customer: 'cus_someone_else' }));
      expect((await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth())).body.code).toBe('intent_mismatch');
      mockRetrieveSetupIntent.mockResolvedValue(succeeded({ status: 'requires_payment_method' }));
      expect((await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth())).body.code).toBe('setup_not_succeeded');
    });
    expect(mockFinish).not.toHaveBeenCalled();
  });

  test('refuses a handoff that was never validated', async () => {
    mockState.tables.terminal_handoff_tokens[0].used_at = null;
    await withServer(async (base) => {
      const res = await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('handoff_not_validated');
    });
  });

  test.each([
    ['no_longer_needed', 409],
    ['plan_required', 409],
    ['completion_in_progress', 409],
    ['completion_failed', 409],
    ['pm_ownership_mismatch', 409],
  ])('maps the completion tail refusal %s to a clear 409', async (code, status) => {
    mockFinish.mockResolvedValue({ ok: false, code });
    await withServer(async (base) => {
      const res = await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth());
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(typeof res.body.error).toBe('string');
    });
  });

  test('maps a stale consent refusal to the shared stale-version response', async () => {
    mockFinish.mockResolvedValue({ ok: false, code: 'consent_version_stale' });
    await withServer(async (base) => {
      const res = await post(base, '/complete-setup', { setup_intent_id: 'seti_1' }, auth());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONSENT_VERSION_STALE');
    });
  });
});
