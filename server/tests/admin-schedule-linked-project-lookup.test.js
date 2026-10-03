/**
 * Schedule payload flag `linkedProjectLookupFailed`: a linked-project query
 * that fails is not "no linked project". Every service in the batch carries
 * the marker, so the tech home does not complete a project-backed visit on
 * its own record; an answered lookup carries neither marker nor a false one.
 */
const mockQuery = { rows: [], error: null };
jest.mock('../models/db', () => jest.fn(() => {
  const chain = {
    whereIn: () => chain,
    orderByRaw: () => chain,
    orderBy: () => chain,
    select: async () => {
      if (mockQuery.error) throw mockQuery.error;
      return mockQuery.rows;
    },
  };
  return chain;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({ serviceKey: 'bed_bug_treatment' })),
}));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const services = [{ id: 'svc-a', service_type: 'Bed Bug Treatment' }, { id: 'svc-b', service_type: 'Bed Bug Treatment' }];

afterEach(() => { mockQuery.rows = []; mockQuery.error = null; jest.clearAllMocks(); });

describe('linkedProjectLookupFailed', () => {
  test('a failed query marks every service in the batch, none looks project-free, and the warn log stays', async () => {
    mockQuery.error = new Error('connection reset');
    const map = await loadProjectCompletionContextByServiceId(services);
    for (const { id } of services) {
      expect(map.get(id)).toMatchObject({ linkedProject: null, linkedProjectLookupFailed: true });
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Linked project lookup failed: connection reset'));
  });

  test('an answered query carries the project where there is one and no failure marker anywhere', async () => {
    mockQuery.rows = [{
      scheduled_service_id: 'svc-a', id: 'proj-1', status: 'draft', project_type: 'bed_bug', title: 'Bed bug report',
      report_token: null, service_record_id: null, portal_visible: false,
    }];
    const map = await loadProjectCompletionContextByServiceId(services);
    expect(map.get('svc-a')).toMatchObject({ linkedProject: { id: 'proj-1' }, linkedProjectLookupFailed: false });
    expect(map.get('svc-b')).toMatchObject({ linkedProject: null, linkedProjectLookupFailed: false });
  });

  test('both schedule projections (day and week) carry the marker beside linkedProject', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/linkedProjectLookupFailed: projectCompletionContext\.linkedProjectLookupFailed === true/g))
      .toBe(count(/linkedProject: projectCompletionContext\.linkedProject \|\| null/g));
  });
});
