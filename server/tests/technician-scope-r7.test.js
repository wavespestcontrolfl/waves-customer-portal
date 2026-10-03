// Codex #5568 r7: a technician's job timer and recap preview need a visit of
// their own; the project list honors the current-visit window.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
let mockJob = null;
const mockCalls = [];
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => {
    const c = { table, wheres: [] };
    for (const m of ['where', 'whereNot', 'whereNotIn', 'whereIn', 'update']) c[m] = (...a) => { c.wheres.push([m, ...a]); return c; };
    c.forUpdate = () => c;
    c.first = async () => (table === 'time_entries' ? { id: 'shift-1' } : (table === 'scheduled_services' ? mockJob : null));
    c.insert = (row) => { mockCalls.push(['insert', table, row]); return { returning: async () => [{ id: 'entry-1', ...row }] }; };
    mockCalls.push(['query', table, c]);
    return c;
  });
  fn.transaction = async (cb) => cb(fn);
  fn.raw = (x) => x;
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/street-level-hold', () => ({ isStreetLevelHoldVisit: async () => false, HOLD_REFUSAL: 'hold' }));
const mockMarkOnProperty = jest.fn(async () => ({ ok: true }));
jest.mock('../services/track-transitions', () => ({ markOnProperty: (...a) => mockMarkOnProperty(...a) }));
jest.mock('../services/track-transition-alerts', () => ({ recordTrackTransitionResultFailure: async () => {} }));

const timeTracking = require('../services/time-tracking');

beforeEach(() => { jest.clearAllMocks(); mockCalls.length = 0; mockJob = null; });

describe('startJob with a technician request', () => {
  const techReq = { techRole: 'technician', technicianId: 'tech-A' };

  test("another technician's visit → job_not_assigned, no timer, no arrival transition", async () => {
    await expect(timeTracking.startJob('tech-A', 'job-B', { scopeReq: techReq }))
      .rejects.toMatchObject({ code: 'job_not_assigned', status: 404 });
    expect(mockCalls.some(([k]) => k === 'insert')).toBe(false);
    expect(mockMarkOnProperty).not.toHaveBeenCalled();
    const jobRead = mockCalls.find(([k, t]) => k === 'query' && t === 'scheduled_services')[2];
    expect(jobRead.wheres).toEqual(expect.arrayContaining([['where', 'scheduled_services.technician_id', 'tech-A']]));
  });

  test('an owned live visit starts the timer', async () => {
    mockJob = { id: 'job-A', customer_id: 'cust-1', service_type: 'Pest' };
    const entry = await timeTracking.startJob('tech-A', 'job-A', { scopeReq: techReq });
    expect(entry).toMatchObject({ job_id: 'job-A', customer_id: 'cust-1' });
  });

  test('the geofence path (no scopeReq) is unchanged', async () => {
    mockJob = { id: 'job-B', customer_id: 'cust-2', service_type: 'Pest' };
    await timeTracking.startJob('tech-A', 'job-B', {});
    const jobRead = mockCalls.find(([k, t]) => k === 'query' && t === 'scheduled_services')[2];
    expect(jobRead.wheres).toEqual([['where', 'scheduled_services.id', 'job-B']]);
  });
});

describe('route wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('both technician start paths pass the request as scope and answer 404', () => {
    for (const rel of ['routes/tech-timetracking.js', 'routes/tech-notifications.js']) {
      const src = read(rel);
      expect(src).toMatch(/startJob\(req\.technicianId, [^)]*scopeReq: req \}\)/);
      expect(src).toMatch(/job_not_assigned'\) return res\.status\(404\)/);
    }
  });

  test('recap preview refuses a technician without an owned visit before the model chain', () => {
    const src = read('routes/admin-dispatch.js');
    const handler = src.slice(src.indexOf("router.post('/recap-preview'"));
    const guardAt = handler.indexOf('if (isTechnicianRequest(req))');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(handler.indexOf('CompletionRecap.generateRecap'));
  });

  test('the project list scopes the visit branch by dead status and access window', () => {
    const src = read('routes/admin-projects.js');
    expect(src).toMatch(/this\.where\('ssp\.technician_id', req\.technicianId\)\s*\.whereNotIn\('ssp\.status', TECH_DEAD_ASSIGNMENT_STATUSES\)\s*\.where\('ssp\.scheduled_date', '>=', techAccessCutoff\(\)\)/);
  });
});
