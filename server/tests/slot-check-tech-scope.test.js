// Second technician (GATE_MULTI_TECH_CONFIRM + capacity mode): the admin
// overlap hint counts only the named technician's rows plus unassigned ones,
// matching the edit/reschedule saves' route check and the picker strip.
// Gate off, capacity off or no technician named = tech-blind, as before.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { conflictsForTarget } = require('../services/rain-out');

const DATE = '2035-01-02';
const row = (id, technicianId) => ({
  id, technician_id: technicianId, customer_id: `c-${id}`, date: DATE, startMin: 9 * 60, endMin: 10 * 60,
  service_type: 'Pest Control', reservation_expires_at: null,
});
const occupancy = {
  rows: [row('tech-a-visit', 'tech-a'), row('unassigned-visit', null), row('tech-b-visit', 'tech-b')],
  canName: () => false, nameById: new Map(),
};
const ids = (conflicts) => conflicts.map((c) => c.id).sort();
const probe = (technicianId) => ids(conflictsForTarget(occupancy, null, DATE, { start: '09:00', end: '10:00' }, { technicianId }));

const saved = {};
beforeEach(() => {
  for (const key of ['GATE_MULTI_TECH_CONFIRM', 'GATE_SCHEDULING_CAPACITY']) saved[key] = process.env[key];
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('gate on: technician B is not warned about technician A, but unassigned rows still count', () => {
  process.env.GATE_MULTI_TECH_CONFIRM = 'true';
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  expect(probe('tech-b')).toEqual(['tech-b-visit', 'unassigned-visit']);
  // No technician named (auto / unassigned booking): everyone counts.
  expect(probe(undefined)).toEqual(['tech-a-visit', 'tech-b-visit', 'unassigned-visit']);
});

test('gate off: tech-blind whatever technician is named', () => {
  delete process.env.GATE_MULTI_TECH_CONFIRM;
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  expect(probe('tech-b')).toEqual(['tech-a-visit', 'tech-b-visit', 'unassigned-visit']);
});
