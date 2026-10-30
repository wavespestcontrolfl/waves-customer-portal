/**
 * Office "Auto" with the service-line map LIVE (build 4, owner 2026-10-30): a mapped line
 * decides first, among the technicians that may take the visit that day; an unmapped line (or a
 * gate that is not live) keeps the existing only_assignable / scheduling_pick logic.
 */
const mockState = { live: false, linePick: null, techs: [], pickerActive: false, pick: null };

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({
  applyAssignable: (q) => q,
  absentTechDays: jest.fn(async () => new Set()),
}));
jest.mock('../services/technician-capabilities', () => ({ stateOf: jest.fn(() => 'on') }));
jest.mock('../services/scheduling/line-technician', () => ({
  serviceLineFor: jest.fn(async () => ({ line: null, lineFrom: null })),
  lineMapLive: () => mockState.live,
  pickLineTechnician: jest.fn(async () => mockState.linePick),
}));
jest.mock('../services/scheduling/pick-technician', () => ({
  pickTechnicianActive: () => mockState.pickerActive,
  pickTechnicianForVisit: jest.fn(async () => mockState.pick),
}));

const lineTech = require('../services/scheduling/line-technician');
const picker = require('../services/scheduling/pick-technician');
const { resolveOfficeAutoTechnician } = require('../services/scheduling/office-auto-technician');

const A = { id: 'tech-a', name: 'Tech A' };
const B = { id: 'tech-b', name: 'Tech B' };

function makeConn() {
  return jest.fn(() => {
    const chain = {};
    ['where', 'whereIn'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.select = jest.fn(() => Promise.resolve(mockState.techs));
    return chain;
  });
}

const input = () => ({
  conn: makeConn(), date: '2099-01-05', windowStart: '10:00', windowEnd: '11:00', durationMinutes: 60,
  serviceId: 'svc-1', serviceKey: 'k', serviceType: 'General Pest', customerId: 'cust-1', lat: 27.4, lng: -82.5,
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockState, { live: true, linePick: null, techs: [A, B], pickerActive: false, pick: null });
});

describe('resolveOfficeAutoTechnician — service-line map live', () => {
  test('the line\'s home technician takes it, asked among the assignable technicians, with the probe only while the picker is active', async () => {
    mockState.linePick = { mapped: true, line: 'general', technicianId: 'tech-b', reason: 'home' };
    expect(await resolveOfficeAutoTechnician(input())).toEqual({ technicianId: 'tech-b', result: 'assigned', reason: 'line_home' });
    expect(lineTech.pickLineTechnician).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serviceId: 'svc-1', serviceKey: 'k', serviceType: 'General Pest', date: '2099-01-05', windowStart: '10:00', windowEnd: '11:00',
      durationMinutes: 60, excludeCustomerId: 'cust-1', candidateIds: ['tech-a', 'tech-b'], checkFree: false,
    }));
    mockState.pickerActive = true;
    await resolveOfficeAutoTechnician(input());
    expect(lineTech.pickLineTechnician).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ checkFree: true }));
  });

  test('the gap technician takes it when the home technician cannot', async () => {
    mockState.linePick = { mapped: true, line: 'general', technicianId: 'tech-a', reason: 'gap_off_day' };
    expect(await resolveOfficeAutoTechnician(input())).toEqual({ technicianId: 'tech-a', result: 'assigned', reason: 'line_gap' });
  });

  test('neither can: unassigned, line_none (even though two technicians are assignable)', async () => {
    mockState.linePick = { mapped: true, line: 'general', technicianId: null, reason: 'none' };
    expect(await resolveOfficeAutoTechnician(input())).toEqual({ technicianId: null, result: 'unassigned', reason: 'line_none' });
    expect(picker.pickTechnicianForVisit).not.toHaveBeenCalled();
  });

  test('a mapped line decides even when only one technician is assignable', async () => {
    mockState.techs = [A];
    mockState.linePick = { mapped: true, line: 'lawn', technicianId: null, reason: 'none' };
    expect(await resolveOfficeAutoTechnician(input())).toMatchObject({ result: 'unassigned', reason: 'line_none' });
  });

  test('an unmapped line keeps today\'s logic', async () => {
    mockState.linePick = { mapped: false, line: 'general', technicianId: null, reason: 'no_map' };
    expect(await resolveOfficeAutoTechnician(input())).toMatchObject({ result: 'unassigned', reason: 'several_assignable' });
    mockState.techs = [A];
    expect(await resolveOfficeAutoTechnician(input())).toEqual({ technicianId: 'tech-a', result: 'assigned', reason: 'only_assignable' });
    mockState.techs = [A, B];
    mockState.pickerActive = true;
    mockState.pick = { active: true, technician: B, reason: 'closest_route' };
    expect(await resolveOfficeAutoTechnician(input())).toEqual({ technicianId: 'tech-b', result: 'assigned', reason: 'scheduling_pick' });
  });

  test('nobody assignable: none_assignable, the line is not asked', async () => {
    mockState.techs = [];
    expect(await resolveOfficeAutoTechnician(input())).toMatchObject({ reason: 'none_assignable' });
    expect(lineTech.pickLineTechnician).not.toHaveBeenCalled();
  });

  test('gate not live: the line is not asked', async () => {
    mockState.live = false;
    expect(await resolveOfficeAutoTechnician(input())).toMatchObject({ reason: 'several_assignable' });
    expect(lineTech.pickLineTechnician).not.toHaveBeenCalled();
  });

  test('an unreadable line leaves the visit unassigned, lookup_failed, and never throws', async () => {
    lineTech.pickLineTechnician.mockRejectedValueOnce(new Error('db down'));
    expect(await resolveOfficeAutoTechnician(input())).toMatchObject({ result: 'unassigned', reason: 'lookup_failed' });
  });
});
