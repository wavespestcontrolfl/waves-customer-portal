jest.mock('../config', () => ({ jwt: { secret: 'maintenance-test-secret' } }));

const jwt = require('jsonwebtoken');
const {
  canonicalRequestPath,
  isStaffMaintenanceEnabled,
  staffMaintenance,
} = require('../middleware/staff-maintenance');

const SECRET = 'maintenance-test-secret';
const originalMode = process.env.STAFF_MAINTENANCE_MODE;

function makeResponse() {
  const headers = {};
  return {
    headers,
    body: null,
    statusCode: null,
    set: jest.fn((name, value) => {
      headers[name.toLowerCase()] = value;
    }),
    status: jest.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function json(body) {
      this.body = body;
      return this;
    }),
  };
}

function request(url, authorization, extraHeaders = {}) {
  return {
    originalUrl: url,
    url,
    headers: {
      ...extraHeaders,
      ...(authorization ? { authorization } : {}),
    },
  };
}

function run(req) {
  const res = makeResponse();
  const next = jest.fn();
  staffMaintenance(req, res, next);
  return { res, next };
}

afterEach(() => {
  if (originalMode === undefined) delete process.env.STAFF_MAINTENANCE_MODE;
  else process.env.STAFF_MAINTENANCE_MODE = originalMode;
});

describe('Staff maintenance HTTP interlock', () => {
  test.each([undefined, '', 'false', 'TRUE', 'True', '1', ' true '])(
    'only exact lowercase true enables the gate (value: %p)',
    (value) => {
      const env = value === undefined ? {} : { STAFF_MAINTENANCE_MODE: value };
      expect(isStaffMaintenanceEnabled(env)).toBe(false);
    },
  );

  test('exact lowercase true enables the gate', () => {
    expect(isStaffMaintenanceEnabled({ STAFF_MAINTENANCE_MODE: 'true' })).toBe(true);
  });

  test.each([
    '/api/admin/auth/login',
    '/api/tech/timetracking?next=/api/health',
    '/API/DISPATCH/jobs',
    '/api/%6bnowledge/search',
    '/api//admin/settings',
    '/public/../api/admin/timesheets',
    'https://portal.example.com/api/admin/auth/login?next=/api/health',
    '/api/stripe/terminal/validate-handoff',
    '/api/service/records/record-1/validate-photo-chain',
    '/api/ai/admin/escalations',
    '/api/visual-moments/moment-1',
    '/api/jobs/job-1/visual-moments',
    '/api/bouncie/auth',
    '/api/bouncie/callback?code=oauth-code&state=signed-state',
  ])('blocks Staff route %s before route handling', (url) => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const { res, next } = run(request(url, null, {
      'x-original-url': '/api/health',
      'x-rewrite-url': '/api/health',
    }));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'Staff access is temporarily unavailable',
      code: 'STAFF_MAINTENANCE',
    });
    expect(res.headers['retry-after']).toBe('60');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  test('blocks a valid Staff JWT carried on a non-Staff API path', () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const token = jwt.sign({ technicianId: 'tech-1', role: 'admin' }, SECRET);
    const { res, next } = run(request('/api/estimates/token/data', `Bearer ${token}`));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('STAFF_MAINTENANCE');
  });

  test('blocks the first Staff bearer credential even with legacy trailing input', () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const token = jwt.sign({ technicianId: 'tech-1' }, SECRET);
    const { res, next } = run(request('/api/estimates/token/data', `Bearer ${token} ignored`));

    expect(next).not.toHaveBeenCalled();
    expect(res.body.code).toBe('STAFF_MAINTENANCE');
  });

  test('keeps public traffic, customer JWTs, invalid tokens, and health available', () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const customerToken = jwt.sign({ customerId: 'customer-1' }, SECRET);
    const wrongSignature = jwt.sign({ technicianId: 'tech-1' }, 'wrong-secret');

    for (const req of [
      request('/api/public/quote', null),
      request('/api/services', `Bearer ${customerToken}`),
      request('/api/bouncie/vehicles', `Bearer ${customerToken}`),
      request('/api/bouncie/location', `Bearer ${customerToken}`),
      request('/api/administrator-public', null),
      request('/api/technology', null),
      request('/api/dispatches', null),
      request('/api/knowledgebase', null),
      request('/api/stripe/terminally', null),
      request('/api/estimates/token/data', `Bearer ${wrongSignature}`),
      request('/api/health', jwt.sign({ technicianId: 'tech-1' }, SECRET)),
      request('/api/health?probe=staff', `Bearer ${jwt.sign({ technicianId: 'tech-1' }, SECRET)}`),
    ]) {
      const { res, next } = run(req);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  test('leaves every request untouched while disabled', () => {
    process.env.STAFF_MAINTENANCE_MODE = 'false';
    const token = jwt.sign({ technicianId: 'tech-1' }, SECRET);
    const { res, next } = run(request('/api/admin/auth/login', `Bearer ${token}`));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('canonical path ignores query and proxy rewrite headers', () => {
    expect(canonicalRequestPath(request(
      '/API/%2561dmin/auth/login?path=/api/health',
      null,
      { 'x-original-url': '/api/health' },
    ))).toBe('/api/admin/auth/login');
  });
});
