/**
 * GATE_SERVICE_LINE_MAP=live, estimate accept: a program added to the picked trip
 * keeps its own line's technician instead of copying the reserved visit's hour and
 * technician. Gate off or shadow, an unmapped line, or the same technician: today's copy.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/line-technician', () => ({
  lineMapLive: jest.fn(() => true),
  pickLineTechnician: jest.fn(),
}));

const lineTechnician = require('../services/scheduling/line-technician');
const { ownLineTechnicianForPromotedUnit } = require('../services/scheduling/promoted-unit-line');

// The accept's transaction: the lookup runs in a savepoint (`database.transaction`), so a
// failed read rolls back only the savepoint and the accept can go on.
const savepoint = jest.fn();
const database = Object.assign(jest.fn(), {
  transaction: jest.fn(async (work) => work(savepoint)),
});
const args = (over = {}) => ({
  row: { service_id: 'svc-lawn', service_type: 'Lawn Care' },
  unit: { catalogServiceKey: 'lawn_care_monthly' },
  unitDate: '2027-05-20',
  reservedStart: { technician_id: 'tech-pest', window_start: '09:00:00', window_end: '10:00:00' },
  ...over,
});

describe('ownLineTechnicianForPromotedUnit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lineTechnician.lineMapLive.mockReturnValue(true);
  });

  test('gate not live: null and no map read', async () => {
    lineTechnician.lineMapLive.mockReturnValue(false);
    await expect(ownLineTechnicianForPromotedUnit(database, args())).resolves.toBeNull();
    expect(lineTechnician.pickLineTechnician).not.toHaveBeenCalled();
  });

  test('unmapped line: null (today\'s copy)', async () => {
    lineTechnician.pickLineTechnician.mockResolvedValue({ mapped: false, line: 'lawn', technicianId: null, reason: 'no_map' });
    await expect(ownLineTechnicianForPromotedUnit(database, args())).resolves.toBeNull();
  });

  test('the line\'s technician is the reserved visit\'s own: null (copy as today)', async () => {
    lineTechnician.pickLineTechnician.mockResolvedValue({ mapped: true, line: 'general', technicianId: 'tech-pest', reason: 'home' });
    await expect(ownLineTechnicianForPromotedUnit(database, args())).resolves.toBeNull();
  });

  test('a different technician owns the line: split to that technician', async () => {
    lineTechnician.pickLineTechnician.mockResolvedValue({ mapped: true, line: 'lawn', technicianId: 'tech-lawn', reason: 'home' });
    await expect(ownLineTechnicianForPromotedUnit(database, args())).resolves.toEqual({ technicianId: 'tech-lawn' });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(lineTechnician.pickLineTechnician).toHaveBeenCalledWith(savepoint, {
      serviceId: 'svc-lawn', serviceKey: 'lawn_care_monthly', serviceType: 'Lawn Care', date: '2027-05-20',
    });
  });

  test('nobody can take the line that day: split, unassigned', async () => {
    lineTechnician.pickLineTechnician.mockResolvedValue({ mapped: true, line: 'lawn', technicianId: null, reason: 'none' });
    await expect(ownLineTechnicianForPromotedUnit(database, args())).resolves.toEqual({ technicianId: null });
  });

  test('the reserved visit has no technician: the line\'s technician still splits the program out', async () => {
    lineTechnician.pickLineTechnician.mockResolvedValue({ mapped: true, line: 'lawn', technicianId: 'tech-lawn', reason: 'home' });
    const out = await ownLineTechnicianForPromotedUnit(database, args({ reservedStart: { technician_id: null } }));
    expect(out).toEqual({ technicianId: 'tech-lawn' });
  });

  test('an unreadable map keeps today\'s copy, and the failed read stays inside its savepoint', async () => {
    lineTechnician.pickLineTechnician.mockRejectedValue(new Error('db down'));
    await expect(ownLineTechnicianForPromotedUnit(database, args())).resolves.toBeNull();
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(lineTechnician.pickLineTechnician).toHaveBeenCalledWith(savepoint, expect.anything());
  });

  test('gate not live: no savepoint either', async () => {
    lineTechnician.lineMapLive.mockReturnValue(false);
    await ownLineTechnicianForPromotedUnit(database, args());
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

describe('estimate accept wiring (source)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services/estimate-converter.js'), 'utf8');

  test('the split sits after the catalog lookup and before the window recompute, never for a combined capacity member', () => {
    const at = text.indexOf("require('./scheduling/promoted-unit-line').ownLineTechnicianForPromotedUnit(");
    expect(at).toBeGreaterThan(text.indexOf("if (!standaloneRow.service_id && unit.catalogServiceKey === 'palm_injection_semiannual')"));
    expect(at).toBeLessThan(text.indexOf('windowEndFromStart(standaloneRow.window_start, standaloneRow.estimated_duration_minutes)'));
    expect(at).toBeLessThan(text.indexOf('if (combinedCapacity && sameTrip) {\n              Object.assign(standaloneRow'));
    expect(text.slice(text.lastIndexOf('\n', at - 80), at)).toContain('const own = await');
    expect(text.slice(text.lastIndexOf('if (sameTrip', at), at)).toContain('if (sameTrip && !combinedCapacity) {');
  });

  test('the split drops the copied hour and technician and writes plain-words note text', () => {
    const at = text.indexOf("require('./scheduling/promoted-unit-line').ownLineTechnicianForPromotedUnit(");
    const block = text.slice(at, at + 900);
    expect(block).toContain('delete standaloneRow.window_start;');
    expect(block).toContain('delete standaloneRow.window_end;');
    expect(block).toContain('delete standaloneRow.technician_id;');
    expect(block).toContain('This program has its own technician, so we will set its time separately.');
  });
});
