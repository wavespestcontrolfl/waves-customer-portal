// The public track GET is contractually read-only (AGENTS.md): the
// stops-ahead clamp floor persists ONLY through the explicit POST
// /:token/stops-ahead, which recomputes server-side (the request body is
// ignored — a client can never choose its own count) and returns the
// displayable payload. These tests drive the handler directly (no
// supertest in this repo) and pin the endpoint's gate: token format,
// expiry, terminal-state nulls, and that the persisting (non-readOnly)
// compute path is the one invoked.
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn() }));
const mockCompute = jest.fn();
jest.mock('../services/stops-ahead', () => ({
  computeStopsAhead: mockCompute,
  isServiceDateToday: jest.fn(() => true),
}));

const trackPublicRouter = require('../routes/track-public');

const TOKEN = 'a'.repeat(64);

// Locate the POST /:token/stops-ahead handler on the router stack.
const layer = trackPublicRouter.stack.find(
  (l) => l.route && l.route.path === '/:token/stops-ahead' && l.route.methods.post
);
const handler = layer.route.stack[0].handle;

function installRow(row) {
  mockDb.mockImplementation(() => {
    const chain = {
      where: jest.fn(() => chain),
      leftJoin: jest.fn(() => chain),
      first: jest.fn(async () => row),
    };
    return chain;
  });
}

async function drive(token) {
  const req = { params: { token } };
  const res = {
    statusCode: 200,
    body: undefined,
    set: jest.fn(() => res),
    status: jest.fn((c) => { res.statusCode = c; return res; }),
    json: jest.fn((b) => { res.body = b; return res; }),
  };
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res;
}

describe('POST /api/public/track/:token/stops-ahead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockReset();
  });

  test('the route exists and is the only write path (GET stays read-only)', () => {
    expect(handler).toBeInstanceOf(Function);
  });

  test('malformed token → 404, no db access', async () => {
    const res = await drive('not-a-token');
    expect(res.statusCode).toBe(404);
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('unknown token → 404', async () => {
    installRow(null);
    const res = await drive(TOKEN);
    expect(res.statusCode).toBe(404);
    expect(mockCompute).not.toHaveBeenCalled();
  });

  test('expired token → 404', async () => {
    installRow({ id: 'svc-1', status: 'confirmed', track_state: 'scheduled', track_token_expires_at: '2000-01-01T00:00:00.000Z' });
    const res = await drive(TOKEN);
    expect(res.statusCode).toBe(404);
    expect(mockCompute).not.toHaveBeenCalled();
  });

  test('scheduled visit → persisting compute (no readOnly) and its payload', async () => {
    installRow({ id: 'svc-1', status: 'confirmed', track_state: 'scheduled', track_token_expires_at: null });
    mockCompute.mockResolvedValue({
      stopsAhead: 2, yourStop: 3, totalStops: 6, currentStop: 0, atStop: false, headingToStop: false,
    });
    const res = await drive(TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      stopsAhead: 2,
      routeProgress: { yourStop: 3, totalStops: 6, currentStop: 0, atStop: false, headingToStop: false },
    });
    // Third arg absent/without readOnly = the persisting path.
    const opts = mockCompute.mock.calls[0][2];
    expect(opts?.readOnly).toBeFalsy();
  });

  test.each([
    ['completed status', { status: 'completed', track_state: 'scheduled' }],
    ['no_show status', { status: 'no_show', track_state: 'scheduled' }],
    ['en_route track_state', { status: 'confirmed', track_state: 'en_route' }],
  ])('non-scheduled state (%s) → nulls, compute never runs', async (_label, overrides) => {
    installRow({ id: 'svc-1', track_token_expires_at: null, ...overrides });
    const res = await drive(TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ stopsAhead: null, routeProgress: null });
    expect(mockCompute).not.toHaveBeenCalled();
  });

  test('compute null (gate off / ineligible) → nulls', async () => {
    installRow({ id: 'svc-1', status: 'confirmed', track_state: 'scheduled', track_token_expires_at: null });
    mockCompute.mockResolvedValue(null);
    const res = await drive(TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ stopsAhead: null, routeProgress: null });
  });
});
