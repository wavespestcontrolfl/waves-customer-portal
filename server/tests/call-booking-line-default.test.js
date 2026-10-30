/**
 * After-call booking with the service-line map LIVE (build 4, owner 2026-10-30): the default
 * technician for ONE call-booked visit becomes the line's pick for that visit's own service and
 * day (lineDefaultCallBookingTechnician); unmapped, gate not live or an unreadable read keep the
 * old default (null here = "nothing to replace it with"). The wiring into the fresh insert and the
 * reused row is pinned at source level, in the style of multi-tech-confirm-scope.test.js.
 */
const fs = require('fs');
const path = require('path');

const mockLive = { value: true };
jest.mock('../services/scheduling/line-technician', () => {
  const actual = jest.requireActual('../services/scheduling/line-technician');
  return { ...actual, lineMapLive: () => mockLive.value, pickLineTechnician: jest.fn() };
});

const lineTech = require('../services/scheduling/line-technician');
const logger = require('../services/logger');
const { lineDefaultCallBookingTechnician } = require('../services/call-recording-processor')._test;

// trx.transaction(fn) runs fn on a savepoint; sp('technicians').where().first('name') → the tech row.
function fakeTrx({ techName = 'Tech Home', throwInTransaction = null } = {}) {
  const sp = jest.fn(() => ({ where: () => ({ first: async () => (techName ? { name: techName } : undefined) }) }));
  const trx = { transaction: jest.fn(async (fn) => { if (throwInTransaction) throw throwInTransaction; return fn(sp); }), sp };
  return trx;
}
const visit = { serviceId: 'svc-1', serviceKey: 'k', serviceType: 'General Pest', date: '2099-01-05' };

beforeEach(() => {
  jest.clearAllMocks();
  mockLive.value = true;
});

describe('lineDefaultCallBookingTechnician', () => {
  test('a mapped line returns the picked technician with the name, asked without the free-time probe, on its own savepoint', async () => {
    lineTech.pickLineTechnician.mockResolvedValue({ mapped: true, line: 'general', technicianId: 'tech-home', reason: 'home' });
    const trx = fakeTrx();
    await expect(lineDefaultCallBookingTechnician(trx, visit)).resolves.toEqual({ id: 'tech-home', name: 'Tech Home' });
    expect(trx.transaction).toHaveBeenCalledTimes(1);
    expect(lineTech.pickLineTechnician).toHaveBeenCalledWith(trx.sp, { ...visit, checkFree: false });
  });

  test('a mapped line where neither technician fits returns "nobody": the visit is saved unassigned', async () => {
    lineTech.pickLineTechnician.mockResolvedValue({ mapped: true, line: 'lawn', technicianId: null, reason: 'none' });
    await expect(lineDefaultCallBookingTechnician(fakeTrx(), visit)).resolves.toEqual({ id: null, name: null });
  });

  test('an unmapped line returns null: the old default stands', async () => {
    lineTech.pickLineTechnician.mockResolvedValue({ mapped: false, line: 'general', technicianId: null, reason: 'no_map' });
    await expect(lineDefaultCallBookingTechnician(fakeTrx(), visit)).resolves.toBeNull();
  });

  test('gate not live: null, and nothing is read', async () => {
    mockLive.value = false;
    const trx = fakeTrx();
    await expect(lineDefaultCallBookingTechnician(trx, visit)).resolves.toBeNull();
    expect(trx.transaction).not.toHaveBeenCalled();
    expect(lineTech.pickLineTechnician).not.toHaveBeenCalled();
  });

  test('a failed read keeps the old default and logs a warning', async () => {
    lineTech.pickLineTechnician.mockRejectedValue(new Error('db down'));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(lineDefaultCallBookingTechnician(fakeTrx(), visit)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('line-map technician read failed (default technician kept): db down'));
    warn.mockRestore();
  });
});

describe('after-call wiring (source)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('the fresh booking and the reused row each take the line\'s pick as their default, with the capability re-read kept', () => {
    // Fresh: the visit's own catalog service and day; not "picked" (no free-time re-pick off the line).
    expect(src).toMatch(/const bookingLineTech = await lineDefaultCallBookingTechnician\(trx, \{\s+serviceId: callBookingCatalogRow\?\.id \|\| null,\s+serviceKey: callBookingCatalogRow\?\.service_key \|\| null,\s+serviceType,\s+date: scheduledDate,/);
    expect(src).toContain('bookingTechnicianId = bookingLineTech.id;');
    expect(src).toContain('if (bookingTechnicianPicked || bookingLineMapped) {');
    // Reused: the row's OWN service and day.
    expect(src).toMatch(/const reuseLineTech = await lineDefaultCallBookingTechnician\(trx, \{\s+serviceId: existing\.service_id \|\| null,\s+serviceKey: existing\.service_key_snapshot \|\| null,\s+serviceType: existing\.service_type \|\| serviceType,\s+date: callBookingDateOnly\(existing\.scheduled_date\),/);
    expect(src).toContain('reuseCandidateTechId = reuseLineTech.id;');
    expect(src).toContain('if (reuseTechPicked || reuseLineMapped) {');
    // The free-time re-pick stays tied to the scheduling pick alone.
    expect(src).toContain('if (bookingTechnicianPicked && bookingTechnicianId && (bookingTimeConflicts.length || pickedTechnicianBlocked)) {');
    expect(src).toContain('if (reuseTechId && reuseTechPicked && existing.window_start) {');
  });

  test('visit 2 copies visit 1; with no technician on visit 1 it takes the same default visit 1 got', () => {
    expect(src).toContain('let followUpTechId = primaryRow.technician_id || followUpDefaultTechId || null;');
    expect(src).toContain('followUpDefaultTechId = bookingLineTech.id;');
    expect(src).toContain('followUpDefaultTechId = reuseLineTech.id;');
  });
});
