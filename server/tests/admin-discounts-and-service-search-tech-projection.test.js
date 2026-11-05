// Technician visibility audit 2026-11-04.
// A7: GET /api/admin/discounts gives a technician name and amount (what the
//     checkout and appointment discount pickers read) without the business
//     totals (times_applied, total_discount_given) or any promo-code field.
// A9: GET /api/admin/projects/service-search gives a technician only what the
//     project form's title picker reads, not material cost or internal notes.
// An admin still gets every field of both. Synthetic rows only.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: jest.fn() }));
jest.mock('../services/discount-engine', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/service-library', () => ({ getServices: jest.fn() }));

const db = require('../models/db');
const jwt = require('jsonwebtoken');
const config = require('../config');
const serviceLibrary = require('../services/service-library');
const discountsRouter = require('../routes/admin-discounts');
const projectsRouter = require('../routes/admin-projects');

const discountRow = {
  id: 'disc-1', discount_key: 'example_promo', name: 'Example Promo', discount_type: 'percentage',
  amount: '10', is_active: true, sort_order: 1, stack_group: 'promo',
  times_applied: 42, total_discount_given: '1234.50',
  promo_code: 'EXAMPLE10', promo_code_max_uses: 100, promo_code_current_uses: 42, promo_code_expiry: '2027-01-01',
};
const serviceRow = {
  id: 'svc-1', service_key: 'example_service', name: 'Example Service', short_name: 'Example',
  description: 'Synthetic description', internal_notes: 'Synthetic internal note',
  category: 'pest', billing_type: 'recurring', default_duration_minutes: 45,
  base_price: '99.00', price_range_min: '80.00', price_range_max: '120.00', typical_materials_cost: '12.00',
};

let token;
function authAs(role) {
  token = jwt.sign({ technicianId: `${role}-1`, type: 'access', tokenVersion: 1 }, config.jwt.secret, { expiresIn: '5m' });
  db.mockImplementation((table) => {
    if (table === 'technicians') {
      return { where: () => ({ first: async () => ({ id: `${role}-1`, role, employment_status: 'active', auth_token_version: 1 }) }) };
    }
    const q = { orderBy: () => q, then: (resolve, reject) => Promise.resolve([discountRow]).then(resolve, reject) };
    return q;
  });
}

function dispatch(router, url) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url, headers: { authorization: `Bearer ${token}` }, query: Object.fromEntries(new URL(`http://x${url}`).searchParams) };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    router.handle(req, res, reject);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  serviceLibrary.getServices.mockResolvedValue({ services: [{ ...serviceRow }], total: 1, limit: 10, offset: 0 });
});

describe('GET /api/admin/discounts', () => {
  const OWNER_FIELDS = ['times_applied', 'total_discount_given', 'promo_code', 'promo_code_max_uses', 'promo_code_current_uses', 'promo_code_expiry'];

  test('a technician gets no totals and no promo-code field', async () => {
    authAs('technician');
    const { status, body } = await dispatch(discountsRouter, '/');
    expect(status).toBe(200);
    for (const field of OWNER_FIELDS) expect(body[0]).not.toHaveProperty(field);
    expect(JSON.stringify(body)).not.toContain('EXAMPLE10');
  });

  test('a technician keeps what the discount pickers read', async () => {
    authAs('technician');
    const { body } = await dispatch(discountsRouter, '/');
    expect(body[0]).toMatchObject({
      id: 'disc-1', discount_key: 'example_promo', name: 'Example Promo', discount_type: 'percentage',
      amount: 10, is_active: true, sort_order: 1,
    });
    // The classification was worked out before the strip: a promo code makes an invoice promo.
    expect(body[0].catalogClassification).toMatchObject({ key: 'example_promo', name: 'Example Promo', invoicePromo: true });
  });

  test('an admin still gets every field', async () => {
    authAs('admin');
    const { body } = await dispatch(discountsRouter, '/');
    for (const field of OWNER_FIELDS) expect(body[0]).toHaveProperty(field);
    expect(body[0].promo_code).toBe('EXAMPLE10');
    expect(body[0].total_discount_given).toBe('1234.50');
  });
});

describe('GET /api/admin/projects/service-search', () => {
  const OWNER_FIELDS = ['typical_materials_cost', 'internal_notes', 'base_price', 'price_range_min', 'price_range_max', 'description'];

  test('a technician gets only what the title picker reads', async () => {
    authAs('technician');
    const { status, body } = await dispatch(projectsRouter, '/service-search?search=example');
    expect(status).toBe(200);
    expect(body.services).toEqual([{
      id: 'svc-1', service_key: 'example_service', name: 'Example Service',
      category: 'pest', billing_type: 'recurring', default_duration_minutes: 45,
    }]);
    for (const field of OWNER_FIELDS) expect(body.services[0]).not.toHaveProperty(field);
    expect(body).toMatchObject({ total: 1, limit: 10, offset: 0 });
  });

  test('an admin still gets the full service row', async () => {
    authAs('admin');
    const { body } = await dispatch(projectsRouter, '/service-search?search=example');
    expect(body.services[0]).toMatchObject({ typical_materials_cost: '12.00', internal_notes: 'Synthetic internal note', base_price: '99.00' });
  });
});
