/**
 * intelligence-bar/truck-kit-tools.js — the office's read-only truck kit
 * tools: every call is refused with the gate off; get_truck_kit answers an
 * overview with no name, candidates for an ambiguous name, one truck's kit
 * for a single match (an ambiguous truck is the service's own error);
 * get_tool_issues maps the fleet's open tool alerts.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const techs = { rows: [] };
jest.mock('../models/db', () => jest.fn((table) => {
  const c = {};
  c.where = (col, op, val) => { techs.query = [table, col, op, val]; return c; };
  for (const m of ['orderBy', 'limit']) c[m] = () => c;
  c.select = async () => techs.rows;
  return c;
}));
jest.mock('../services/truck-kit', () => {
  class TruckCheckError extends Error { constructor(code, message) { super(message); this.code = code; } }
  return {
    TruckCheckError,
    truckKitEnabled: jest.fn(() => true),
    trucksOverview: jest.fn(async () => [{ id: 'v1', name: 'Truck 1', items: 2 }]),
    truckKitStatus: jest.fn(async () => ({
      truck: { id: 'v1', name: 'Truck 1', asset_tag: 'VEH-1' }, due: true, intervalDays: 7,
      lastCheck: { checked_at: '2026-10-01T12:00:00Z', technician_name: 'Synthetic tech', missing_count: 1, damaged_count: 0 },
      kit: [{ id: 'e1', name: 'Moisture meter', category: 'tool', kit_key: 'moisture_meter', open_issue: 'missing', serial_number: 'S1' }],
      gaps: [{ serviceId: 's1', tools: ['Moisture meter'] }],
    })),
    openToolAlerts: jest.fn(async () => [{ id: 'a1', alert_type: 'tool_damaged', description: 'cracked', created_at: '2026-10-20T12:00:00Z', name: 'Duster', kit_key: null, vehicle_name: 'Truck 1', technician_name: 'Synthetic tech' }]),
  };
});
const truckKit = require('../services/truck-kit');
const { TRUCK_KIT_TOOLS, executeTruckKitTool } = require('../services/intelligence-bar/truck-kit-tools');

beforeEach(() => { jest.clearAllMocks(); truckKit.truckKitEnabled.mockReturnValue(true); techs.rows = []; });

test('two read tools, no write, both refused with the gate off', async () => {
  expect(TRUCK_KIT_TOOLS.map((t) => t.name)).toEqual(['get_truck_kit', 'get_tool_issues']);
  truckKit.truckKitEnabled.mockReturnValue(false);
  for (const name of ['get_truck_kit', 'get_tool_issues']) {
    expect(await executeTruckKitTool(name, {})).toEqual({ error: expect.stringMatching(/GATE_TRUCK_KIT/), code: 'integration_disabled' });
  }
  expect(truckKit.trucksOverview).not.toHaveBeenCalled();
  truckKit.truckKitEnabled.mockReturnValue(true);
  expect(await executeTruckKitTool('set_truck_kit', {})).toEqual({ error: 'Unknown truck kit read' });
});

test('get_truck_kit with no name is the fleet overview', async () => {
  expect(await executeTruckKitTool('get_truck_kit', {})).toEqual({ trucks: [{ id: 'v1', name: 'Truck 1', items: 2 }] });
  expect(await executeTruckKitTool('get_truck_kit', { technician_name: null })).toEqual({ trucks: [{ id: 'v1', name: 'Truck 1', items: 2 }] });
});

test('get_truck_kit by name: no match, candidates, or one compact kit', async () => {
  expect(await executeTruckKitTool('get_truck_kit', { technician_name: 'Nobody' })).toEqual({ error: 'No technician matches "Nobody"' });
  // technicians has one `name` column: the search reads that column only.
  expect(techs.query).toEqual(['technicians', 'name', 'ilike', '%Nobody%']);
  techs.rows = [{ id: 't1', name: 'Synthetic Adam' }, { id: 't2', name: 'Synthetic Adams' }];
  expect(await executeTruckKitTool('get_truck_kit', { technician_name: 'adam' })).toEqual({ candidates: ['Synthetic Adam', 'Synthetic Adams'], note: 'Ask which technician is meant.' });
  techs.rows = [{ id: 't1', name: 'Synthetic Adam' }];
  const out = await executeTruckKitTool('get_truck_kit', { technician_name: 'adam' });
  expect(truckKit.truckKitStatus).toHaveBeenCalledWith('t1');
  expect(out).toEqual({
    technician: 'Synthetic Adam', truck: { id: 'v1', name: 'Truck 1', asset_tag: 'VEH-1' }, due: true, interval_days: 7,
    last_check: { at: '2026-10-01T12:00:00Z', by: 'Synthetic tech', missing: 1, damaged: 0 },
    items: [{ name: 'Moisture meter', category: 'tool', kit_key: 'moisture_meter', open_issue: 'missing' }],
    today_gaps: [{ serviceId: 's1', tools: ['Moisture meter'] }],
  });
  truckKit.truckKitStatus.mockRejectedValueOnce(new truckKit.TruckCheckError('ambiguous_truck', 'More than one truck is assigned to you. Ask the office to fix the assignment.'));
  expect(await executeTruckKitTool('get_truck_kit', { technician_name: 'adam' })).toEqual({ technician: 'Synthetic Adam', error: expect.stringMatching(/More than one truck/), code: 'ambiguous_truck' });
});

test('get_tool_issues maps the open alerts', async () => {
  expect(await executeTruckKitTool('get_tool_issues', {})).toEqual({ open: 1, issues: [{ tool: 'Duster', kit_key: null, issue: 'damaged', truck: 'Truck 1', technician: 'Synthetic tech', note: 'cracked', reported_at: '2026-10-20T12:00:00Z' }] });
});
