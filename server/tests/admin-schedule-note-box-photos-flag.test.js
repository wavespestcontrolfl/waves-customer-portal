/**
 * Schedule payload flag `noteBoxPhotosEnabled` (photos in the notes box,
 * owner "ok go" 2026-10-02): true only while GATE_NOTE_BOX_PHOTOS is exactly
 * 'true', read at call time, and never for a lawn or tree, shrub & palm
 * visit (another lane owns those completions and their photo steps). Every
 * schedule projection that carries the completion flags carries this one.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => null),
}));

const fs = require('fs');
const path = require('path');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const services = [
  { id: 'pest', service_type: 'Quarterly Pest Control' },
  { id: 'rodent', service_type: 'Rodent Trapping Service' },
  { id: 'lawn', service_type: 'Lawn Care' },
  { id: 'tree', service_type: 'Tree & Shrub Care' },
  { id: 'palm', service_type: 'Palm Injection' },
];
const flags = async () => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return Object.fromEntries(services.map((s) => [s.id, map.get(s.id).noteBoxPhotosEnabled]));
};

describe('noteBoxPhotosEnabled', () => {
  const saved = process.env.GATE_NOTE_BOX_PHOTOS;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_NOTE_BOX_PHOTOS; else process.env.GATE_NOTE_BOX_PHOTOS = saved;
  });

  test('gate exactly "true": on, except lawn and tree, shrub & palm', async () => {
    process.env.GATE_NOTE_BOX_PHOTOS = 'true';
    expect(await flags()).toEqual({ pest: true, rodent: true, lawn: false, tree: false, palm: false });
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: off everywhere', async (value) => {
    if (value === undefined) delete process.env.GATE_NOTE_BOX_PHOTOS; else process.env.GATE_NOTE_BOX_PHOTOS = value;
    expect(Object.values(await flags()).every((on) => on === false)).toBe(true);
  });

  test('every schedule projection that carries the completion flags carries this one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/noteBoxPhotosEnabled: projectCompletionContext\.noteBoxPhotosEnabled === true/g))
      .toBe(count(/fastCompleteRecapEnabled: projectCompletionContext\.fastCompleteRecapEnabled === true/g));
  });
});
