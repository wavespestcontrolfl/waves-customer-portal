// Codex #5568 r9: the AI draft never reads another customer's texts through
// a shared phone, and a technician's arrival transition stays bound to their
// assignment after the timer transaction commits.
let mockRow = null;
const mockWrites = [];
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => {
    const c = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'select', 'leftJoin', 'join', 'orderBy']) c[m] = () => c;
    c.first = async () => (table === 'scheduled_services' ? mockRow : null);
    c.update = async (row) => { mockWrites.push([table, row]); return 1; };
    return c;
  });
  fn.transaction = async (cb) => cb(fn);
  fn.raw = (x) => x;
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockHold = jest.fn(async () => false);
jest.mock('../services/street-level-hold', () => ({ isStreetLevelHoldVisit: (...a) => mockHold(...a), HOLD_REFUSAL: 'hold' }));

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

beforeEach(() => { jest.clearAllMocks(); mockWrites.length = 0; });

describe('arrival transition', () => {
  test('a reassigned visit is refused before any write or hold check', async () => {
    mockRow = { id: 'job-1', technician_id: 'tech-B', status: 'confirmed', track_state: 'scheduled', scheduled_date: '2026-10-02' };
    const { markOnProperty } = require('../services/track-transitions');
    const result = await markOnProperty('job-1', { actingTechId: 'tech-A', expectTechnicianId: 'tech-A' });
    expect(result).toEqual({ ok: false, reason: 'technician_changed' });
    expect(mockWrites).toEqual([]);
    expect(mockHold).not.toHaveBeenCalled();
  });

  test('the on-property flip carries the technician predicate when expected', () => {
    const src = read('services/track-transitions.js');
    expect(src).toMatch(/if \(opts\.expectTechnicianId\) flip\.where\('technician_id', opts\.expectTechnicianId\);/);
  });

  test('both technician start paths bind the arrival to the acting technician; geofence does not', () => {
    expect(read('services/time-tracking.js')).toMatch(/isTechnicianRequest\(scopeReq\) \? \{ expectTechnicianId: technicianId \}/);
    expect(read('routes/tech-notifications.js')).toMatch(/req\.techRole === 'technician' \? \{ expectTechnicianId: req\.technicianId \}/);
    expect(read('services/geofence-handler.js')).not.toMatch(/expectTechnicianId/);
  });
});

describe('AI draft', () => {
  test('a technician drafts only when every customer on the phone is on their route', () => {
    const src = read('routes/admin-communications.js');
    const handler = src.slice(src.indexOf("router.post('/ai-draft'"));
    const guard = handler.slice(0, handler.indexOf("db('sms_log')"));
    expect(guard).toMatch(/const sharing = await db\('customers'\)\s*\.whereRaw\("right\(regexp_replace\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\), 10\) = \?", \[cleanPhone\]\)\s*\.select\('id'\);/);
    expect(guard).toMatch(/for \(const row of sharing\) \{\s*if \(!\(await technicianServicesCustomer\(req, row\.id\)\)\) return res\.status\(404\)/);
  });
});

describe('arrival after a CAS miss', () => {
  test('a reassigned visit already on property is refused, and the SMS claim carries the technician', () => {
    const src = read('services/track-transitions.js');
    const miss = src.slice(src.indexOf("if (fresh?.track_state !== 'on_property') {\n        return { ok: false, reason: 'concurrent_update' };"));
    expect(miss.slice(0, 600)).toMatch(/opts\.expectTechnicianId && String\(fresh\.technician_id \|\| ''\) !== String\(opts\.expectTechnicianId\)\) \{\s*return \{ ok: false, reason: 'technician_changed' \};/);
    expect(src).toMatch(/if \(expectTechnicianId\) claimQuery\.where\('technician_id', expectTechnicianId\);/);
    expect(src).toMatch(/maybeSendArrivalSms\(arrivalRow, serviceId, opts\.actingTechId, claimArrivedAt, opts\.expectTechnicianId \|\| null\)/);
  });
});

describe('staged photo changes (main #5590-era routes, #5568 sweep)', () => {
  test('the locked visit read judges the canonical current-assignment rule', () => {
    const src = read('services/service-photos.js');
    const fn = src.slice(src.indexOf('async function lockStagedPhotoForChange('));
    expect(fn).toMatch(/\.first\('id', 'technician_id', 'status', 'scheduled_date'\)/);
    expect(fn).toMatch(/!technicianVisitRowInScope\(\{ techRole: 'technician', technicianId: actor\?\.technicianId \}, visit\)/);
    expect(fn.slice(0, 1200)).not.toMatch(/visit\.technician_id !== actor/);
  });
});
