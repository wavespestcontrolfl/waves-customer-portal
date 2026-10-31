/**
 * Territories by ZIP, build 7 (GATE_TERRITORY_NIGHT_RUN, owner 2026-10-30): the auto-dispatch
 * night run gives an unassigned pest / termite visit only to its ZIP's territory technician.
 * No database: the territory read is mocked; candidateFromSlot runs on a hand-built slot.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/territory', () => ({
  ...jest.requireActual('../services/territory'),
  territoryTechnicianFor: jest.fn(),
}));
jest.mock('../services/scheduling/line-technician', () => ({ liveServiceLine: jest.fn() }));

const territory = require('../services/territory');
const lineTech = require('../services/scheduling/line-technician');
const { _internals } = require('../services/auto-dispatch/candidate-slots');

const { candidateFromSlot, territoryTechnicianForVisit } = _internals;
const GATE = 'GATE_TERRITORY_NIGHT_RUN';
const prior = process.env[GATE];

afterEach(() => {
  if (prior === undefined) delete process.env[GATE]; else process.env[GATE] = prior;
  jest.clearAllMocks();
});

describe('territoryTechnicianForVisit', () => {
  const geo = { lat: 27.05, lng: -82.4 };
  const unassigned = {
    id: 'visit-1', technician_id: null, customer_id: 'cust-1', service_address_zip: '34293',
    service_id: 'svc-1', service_key_snapshot: 'pest_quarterly', service_type: 'Quarterly Pest Control',
  };

  test('gate off: no rule and no read at all', async () => {
    delete process.env[GATE];
    await expect(territoryTechnicianForVisit(unassigned, geo)).resolves.toBeNull();
    expect(lineTech.liveServiceLine).not.toHaveBeenCalled();
    expect(territory.territoryTechnicianFor).not.toHaveBeenCalled();
  });

  test('gate on: an unassigned pest visit (catalog-first line) reads its ZIP, pin and customer', async () => {
    process.env[GATE] = 'true';
    lineTech.liveServiceLine.mockResolvedValue('general');
    territory.territoryTechnicianFor.mockResolvedValue('tech-south');
    await expect(territoryTechnicianForVisit(unassigned, geo)).resolves.toBe('tech-south');
    expect(lineTech.liveServiceLine).toHaveBeenCalledWith(null, { serviceId: 'svc-1', serviceKey: 'pest_quarterly', serviceType: 'Quarterly Pest Control' });
    expect(territory.territoryTechnicianFor).toHaveBeenCalledWith(null, { zip: '34293', lat: 27.05, lng: -82.4, customerId: 'cust-1' });
  });

  test('a catalog lawn row named like pest ("Top Dress"), or an assessment (no line): no rule', async () => {
    process.env[GATE] = 'true';
    territory.territoryTechnicianFor.mockResolvedValue('tech-south');
    lineTech.liveServiceLine.mockResolvedValue('lawn');
    await expect(territoryTechnicianForVisit({ ...unassigned, service_type: 'Top Dress' }, geo)).resolves.toBeNull();
    lineTech.liveServiceLine.mockResolvedValue(null);
    await expect(territoryTechnicianForVisit({ ...unassigned, service_type: 'Waves Assessment' }, geo)).resolves.toBeNull();
    expect(territory.territoryTechnicianFor).not.toHaveBeenCalled();
  });

  test('a visit with a technician, or an unreadable line or territory: no rule', async () => {
    process.env[GATE] = 'true';
    lineTech.liveServiceLine.mockResolvedValue('termite');
    territory.territoryTechnicianFor.mockResolvedValue('tech-south');
    await expect(territoryTechnicianForVisit({ ...unassigned, technician_id: 'tech-a' }, geo)).resolves.toBeNull();
    territory.territoryTechnicianFor.mockRejectedValue(new Error('db down'));
    await expect(territoryTechnicianForVisit(unassigned, geo)).resolves.toBeNull();
    lineTech.liveServiceLine.mockRejectedValue(new Error('catalog down'));
    await expect(territoryTechnicianForVisit(unassigned, geo)).resolves.toBeNull();
  });
});

describe('candidateFromSlot — territory rule', () => {
  const slot = (techId) => ({
    date: '2027-03-02', start_time: '09:00', end_time: '10:00', detour_minutes: 5, total_drive_minutes: 40,
    stops_that_day: 3, score: 1, technician: { id: techId, name: techId },
  });
  const hard = (territoryTechId, drops) => ({
    service: { technician_id: null, skip_weekends: false },
    prefs: { blackout: [] },
    ctx: { keepTech: false, capabilityFor: () => 'standard' },
    category: 'general',
    siblingDates: new Set(),
    drops,
    territoryTechId,
  });

  test('another technician\'s slot is dropped and counted; the territory technician\'s stays', () => {
    const drops = { other_territory: 0 };
    expect(candidateFromSlot(slot('tech-north'), hard('tech-south', drops))).toBeNull();
    expect(drops.other_territory).toBe(1);
    expect(candidateFromSlot(slot('tech-south'), hard('tech-south', drops))).toMatchObject({ technician_id: 'tech-south' });
  });

  test('no territory technician: every technician stays a candidate', () => {
    const drops = {};
    expect(candidateFromSlot(slot('tech-north'), hard(null, drops))).toMatchObject({ technician_id: 'tech-north' });
    expect(drops.other_territory).toBeUndefined();
  });
});
