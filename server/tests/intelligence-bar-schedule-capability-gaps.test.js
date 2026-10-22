/**
 * Schedule tool refusals that must reach the gap list (Codex #6371 r12): a
 * recurring template appointment address change is a coded refusal (not a
 * thrown fault), and a batch move that leaves its grouped stops behind carries
 * `capability_gaps` so the collector can record it. Synthetic names only.
 */
const mockStops = [];
jest.mock('../models/db', () => {
  const api = {
    whereIn: () => api, leftJoin: () => api, select: () => api,
    then: (resolve, reject) => Promise.resolve(mockStops.map((row) => ({ ...row }))).then(resolve, reject),
  };
  return jest.fn(() => api);
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const mockRebooker = { needsLifecycleRewind: jest.fn(() => false), collectiveMoveGateOn: jest.fn(() => false) };
jest.mock('../services/rebooker', () => mockRebooker);
const mockFrozen = new Set();
const mockMembers = new Map();
jest.mock('../services/visit-groups', () => ({
  openMembers: jest.fn(async (conn, visitId) => mockMembers.get(visitId) || [{ id: visitId }]),
  frozenVisitVerdict: jest.fn(async (conn, visitId) => (mockFrozen.has(visitId) ? { frozen: true, reason: 'has_records' } : { frozen: false })),
  dateOnly: (value) => String(value).slice(0, 10),
}));
let mockPlan;
jest.mock('../services/appointment-address', () => ({
  planAppointmentAddress: jest.fn(async () => mockPlan),
  lockAppointmentAddress: jest.fn(),
  applyAppointmentAddress: jest.fn(),
  refreshAppointmentAddressBriefs: jest.fn(),
}));

const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
const { _private: { recordableRefusalCode } } = require('../services/agent-gap-reports');

const UUID_A = '00000000-0000-0000-0000-0000000000a1';
const UUID_P = '00000000-0000-0000-0000-0000000000b1';

describe('switch_appointment_property on a recurring template appointment', () => {
  test('returns a coded refusal the gap list records, and does not throw', async () => {
    mockPlan = {
      propertyId: UUID_P, packageChildIds: [], anchor: { customer_id: 'c1' },
      rows: [{ id: UUID_A, status: 'scheduled', is_recurring: true, recurring_parent_id: null }],
    };
    const result = await executeScheduleTool('switch_appointment_property', { appointment_id: UUID_A, property_id: UUID_P });
    expect(result.code).toBe('recurring_template_property_unsupported');
    expect(result.error).toMatch(/^The bar can't change the address of a recurring template appointment from here yet/);
    expect(result.error).not.toMatch(/Dispatch address editor/);
    expect(recordableRefusalCode(result)).toBe('recurring_template_property_unsupported');
  });
});

describe('move_stops_to_day with a grouped stop beside movable ones', () => {
  const stop = (id, visitId) => ({ id, visit_id: visitId, status: 'scheduled', scheduled_date: '2098-12-01', customer_id: `c-${id}`, first_name: 'Pat', last_name: 'Placeholder', city: 'Testville' });
  const run = (confirmed) => executeScheduleTool('move_stops_to_day', { service_ids: ['s1', 's2'], new_date: '2099-01-05', confirmed });

  test('the successful proposal carries the grouped capability gap (the collector test reads it)', async () => {
    mockStops.splice(0, mockStops.length, stop('s1', null), stop('s2', 'visit-grouped'));
    mockMembers.set('visit-grouped', [{ id: 's2' }, { id: 's3' }]);
    const proposal = await run(false);
    expect(proposal.proposal).toBe(true);
    expect(proposal.stops.map((s) => s.id)).toEqual(['s1']);
    expect(proposal.skipped_grouped).toHaveLength(1);
    expect(proposal.capability_gaps).toEqual([{ code: 'grouped_visit_move_unsupported' }]);
  });

  test('no grouped stop, no capability_gaps key', async () => {
    mockStops.splice(0, mockStops.length, stop('s1', null), stop('s2', null));
    const proposal = await run(false);
    expect(proposal.proposal).toBe(true);
    expect(proposal).not.toHaveProperty('capability_gaps');
  });

  test('frozen and collective (series) skips each add their own code, deduped, in the proposal (Codex #6371 r13)', async () => {
    mockStops.splice(0, mockStops.length,
      stop('s1', null),
      stop('s2', 'visit-frozen'),
      stop('s3', 'visit-frozen-2'),
      { ...stop('s4', null), is_recurring: true });
    mockFrozen.add('visit-frozen');
    mockFrozen.add('visit-frozen-2');
    mockRebooker.collectiveMoveGateOn.mockReturnValue(true);
    try {
      const proposal = await executeScheduleTool('move_stops_to_day', { service_ids: ['s1', 's2', 's3', 's4'], new_date: '2099-01-05' });
      expect(proposal.stops.map((s) => s.id)).toEqual(['s1']);
      expect(proposal.capability_gaps).toEqual([{ code: 'frozen_visit_move_unsupported' }, { code: 'collective_move_unsupported' }]);
    } finally {
      mockRebooker.collectiveMoveGateOn.mockReturnValue(false);
      mockFrozen.clear();
    }
  });

  test('an all-skipped batch with grouped and frozen stops keeps grouped as the top code and lists both kinds (Codex #6371 r15)', async () => {
    mockStops.splice(0, mockStops.length, stop('s1', 'visit-grouped'), stop('s2', 'visit-frozen'));
    mockMembers.set('visit-grouped', [{ id: 's1' }, { id: 's3' }]);
    mockFrozen.add('visit-frozen');
    try {
      const result = await executeScheduleTool('move_stops_to_day', { service_ids: ['s1', 's2'], new_date: '2099-01-05' });
      expect(result.code).toBe('grouped_visit_move_unsupported');
      expect(result.capability_gaps).toEqual([{ code: 'grouped_visit_move_unsupported' }, { code: 'frozen_visit_move_unsupported' }]);
    } finally {
      mockFrozen.clear();
      mockMembers.clear();
    }
  });

  test('an unreadable check anywhere keeps the refusal a plain fault with no gaps', async () => {
    const { openMembers } = require('../services/visit-groups');
    mockStops.splice(0, mockStops.length, stop('s1', 'visit-grouped'), stop('s2', 'visit-broken'));
    mockMembers.set('visit-grouped', [{ id: 's1' }, { id: 's3' }]);
    openMembers.mockImplementationOnce(async (conn, visitId) => mockMembers.get(visitId))
      .mockImplementationOnce(async () => { throw new Error('read failed'); });
    try {
      const result = await executeScheduleTool('move_stops_to_day', { service_ids: ['s1', 's2'], new_date: '2099-01-05' });
      expect(result.code).toBeUndefined();
      expect(result).not.toHaveProperty('capability_gaps');
    } finally {
      mockMembers.clear();
    }
  });
});
