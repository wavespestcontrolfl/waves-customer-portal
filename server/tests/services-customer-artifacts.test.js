jest.mock('../models/db', () => jest.fn());
jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
}));

const servicesRouter = require('../routes/services');

describe('customer services artifact suppression', () => {
  test('detects frozen non-auto-send delivery as customer-artifact suppressed', () => {
    const { parseJsonObject, suppressesCustomerArtifacts } = servicesRouter._test;

    expect(suppressesCustomerArtifacts(
      parseJsonObject(JSON.stringify({ typedReportDelivery: 'disabled' })),
    )).toBe(true);
    expect(suppressesCustomerArtifacts({ typedReportDelivery: 'internal_only' })).toBe(true);
    expect(suppressesCustomerArtifacts({ typedReportDelivery: 'auto_send' })).toBe(false);
    expect(suppressesCustomerArtifacts({})).toBe(false);
  });
});

// The visit note in the service history follows the one rule for customer
// renders (context-aggregator.js customerSafeVisitNotes, owner ruling 2026-10-01): the reviewed
// report text only, never the tech's raw note.
describe('customer services visit note', () => {
  const db = require('../models/db');
  beforeAll(() => { db.raw = jest.fn((sql) => sql); });
  const REVIEWED = [
    'WHAT WE DID',
    'We treated the exterior perimeter and knocked down webs on the lanai.',
    'WHAT WE FOUND',
    'Light ant activity along the kitchen slab and no other concerns.',
  ].join('\n');
  const BODY = 'We treated the exterior perimeter and knocked down webs on the lanai. Light ant activity along the kitchen slab and no other concerns.';
  const RAW = 'Gate code 4417. Customer owes $40 from last time.';
  const row = (id, technicianNotes) => ({
    id, customer_id: 'cust-1', service_date: '2026-09-30', service_type: 'Pest Control',
    technician_notes: technicianNotes, structured_notes: null, service_data: null, completion_source: null,
  });

  function chain(rows) {
    const c = {};
    ['where', 'whereRaw', 'whereIn', 'leftJoin', 'select', 'orderBy', 'limit', 'offset', 'count'].forEach((m) => { c[m] = jest.fn(() => c); });
    c.first = jest.fn(async () => rows[0] || { count: 0 });
    c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return c;
  }

  async function call(path, req) {
    const layer = servicesRouter.stack.find((l) => l.route?.path === path && l.route.methods.get);
    let body = null;
    let error = null;
    const res = { json: (payload) => { body = payload; }, status: () => res };
    await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, params: {}, customerId: 'cust-1', ...req }, res, (err) => { error = err; });
    if (error) throw error;
    return body;
  }

  test("the list shows the reviewed report's text and never a raw note", async () => {
    db.mockImplementation((table) => (table === 'service_records'
      ? chain([row('sr-1', RAW), row('sr-2', REVIEWED)])
      : chain([])));
    const body = await call('/', {});
    expect(body.services.map((s) => s.notes)).toEqual([null, BODY]);
    expect(JSON.stringify(body)).not.toContain('4417');
  });

  test("one visit's detail shows the reviewed report's text and never a raw note", async () => {
    db.mockImplementation((table) => (table === 'service_records' ? chain([row('sr-1', RAW)]) : chain([])));
    expect((await call('/:id', { params: { id: 'sr-1' } })).notes).toBeNull();
    db.mockImplementation((table) => (table === 'service_records' ? chain([row('sr-2', REVIEWED)]) : chain([])));
    expect((await call('/:id', { params: { id: 'sr-2' } })).notes).toBe(BODY);
  });

  test('withholds staged photos and completion notes for a held WDO project until released (B-58)', async () => {
    const heldWdoRecord = {
      id: 'sr-wdo-1',
      customer_id: 'cust-1',
      service_date: '2026-11-27',
      service_type: 'WDO Inspection',
      technician_notes: 'Project completed: Secret Termite Findings',
      structured_notes: JSON.stringify({
        projectCompletion: true,
        projectId: 'proj-wdo-1',
        projectType: 'wdo_inspection',
        projectTitle: 'Secret Termite Findings',
        reportHeld: true,
      }),
      service_data: null,
      completion_source: 'project_completion',
    };
    const fakePhotos = [{ id: 'ph-1', photo_type: 'evidence', caption: 'Evidence', s3_key: 'k/1.jpg' }];
    let holdStatus = 'held';
    db.mockImplementation((table) => {
      if (table === 'service_records') return chain([heldWdoRecord]);
      if (table === 'projects') return chain([{ report_hold_status: holdStatus }]);
      if (table === 'service_photos') return chain(fakePhotos);
      return chain([]);
    });

    const heldDetail = await call('/:id', { params: { id: 'sr-wdo-1' } });
    expect(heldDetail.photos).toEqual([]);
    expect(heldDetail.notes).toBeNull();

    const heldList = await call('/', {});
    expect(heldList.services[0].photoCount).toBe(0);
    expect(heldList.services[0].notes).toBeNull();
    expect(heldList.services[0].reportAvailable).toBe(false);

    // Once payment releases the hold, staged photos unlock normally.
    holdStatus = 'released';
    const PhotoService = require('../services/photos');
    PhotoService.getViewUrl.mockResolvedValue('https://example.invalid/photo-1.jpg');
    const releasedDetail = await call('/:id', { params: { id: 'sr-wdo-1' } });
    expect(releasedDetail.photos).toHaveLength(1);
    expect(releasedDetail.photos[0].id).toBe('ph-1');
  });
});
