/**
 * tech-tools.js get_my_truck_kit — the tech's own truck from the login
 * (never from input); gate off = enabled:false; an admin borrowing the tech
 * reads (no techId) gets no truck; the service's ambiguous-truck error is
 * returned as text, not thrown.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/truck-kit', () => {
  class TruckCheckError extends Error { constructor(code, message) { super(message); this.code = code; } }
  return {
    TruckCheckError,
    truckKitEnabled: jest.fn(() => true),
    truckKitStatus: jest.fn(async () => ({
      truck: { id: 'v1', name: 'Truck 1', asset_tag: 'VEH-1' }, due: false, intervalDays: 7, lastCheck: null,
      kit: [{ id: 'e1', name: 'Duster', category: 'tool', kit_key: null, open_issue: null }], gaps: [],
    })),
  };
});
const truckKit = require('../services/truck-kit');
const { TECH_TOOLS, executeTechTool } = require('../services/intelligence-bar/tech-tools');

beforeEach(() => { jest.clearAllMocks(); truckKit.truckKitEnabled.mockReturnValue(true); });

test('the tool is offered to the tech bar and reads the login\'s truck', async () => {
  expect(TECH_TOOLS.map((t) => t.name)).toContain('get_my_truck_kit');
  const out = await executeTechTool('get_my_truck_kit', { technician_id: 'someone-else' }, { techId: 't1', techName: 'Synthetic tech' });
  expect(truckKit.truckKitStatus).toHaveBeenCalledWith('t1');
  expect(out).toEqual({ truck: { id: 'v1', name: 'Truck 1', asset_tag: 'VEH-1' }, due: false, interval_days: 7, last_check: null, items: [{ name: 'Duster', category: 'tool', kit_key: null, open_issue: null }], today_gaps: [] });
});

test('gate off, no login, no truck, ambiguous truck', async () => {
  truckKit.truckKitEnabled.mockReturnValueOnce(false);
  expect(await executeTechTool('get_my_truck_kit', {}, { techId: 't1' })).toEqual({ enabled: false, error: expect.stringMatching(/GATE_TRUCK_KIT/) });
  expect(await executeTechTool('get_my_truck_kit', {}, {})).toEqual({ error: 'This read needs a technician login' });
  expect(truckKit.truckKitStatus).not.toHaveBeenCalled();
  truckKit.truckKitStatus.mockResolvedValueOnce({ truck: null, kit: [], gaps: [] });
  expect(await executeTechTool('get_my_truck_kit', {}, { techId: 't1' })).toEqual({ truck: null, note: 'No truck is assigned to you. Ask the office.' });
  truckKit.truckKitStatus.mockRejectedValueOnce(new truckKit.TruckCheckError('ambiguous_truck', 'More than one truck is assigned to you.'));
  expect(await executeTechTool('get_my_truck_kit', {}, { techId: 't1' })).toEqual({ error: 'More than one truck is assigned to you.', code: 'ambiguous_truck' });
});
