/**
 * get_stop_details access facts follow the visit-brief GATE_VISIT_FACTS
 * policy. The tool used to dump raw property_preferences (gate codes,
 * lockbox) unconditionally — bypassing the gate and the shared fail-soft
 * access block that governs GET /:id/visit-brief. Contract:
 *   - gate OFF: legacy raw-prefs property block, unchanged
 *   - gate ON + live visit today: property = deterministicVisitFacts().access
 *   - gate ON + no visit today: property null (codes are a per-visit answer)
 *   - gate ON + facts throw: property null (fail-soft), rest of the answer intact
 */
const state = { customers: [], scheduled_services: [], property_preferences: [], service_records: [] };

jest.mock('../models/db', () => {
  function query(table) {
    const preds = [];
    const api = {
      where(a, op, val) {
        if (typeof a === 'function') return api;
        if (typeof a === 'object') {
          Object.entries(a).forEach(([k, v]) => preds.push((r) => r[k] === v));
        } else if (val === undefined) {
          preds.push((r) => r[a] === op);
        } else if (op === '>=') {
          preds.push((r) => r[a] >= val);
        } else {
          preds.push((r) => r[a] === val);
        }
        return api;
      },
      whereNotIn(col, arr) { preds.push((r) => !arr.includes(r[col])); return api; },
      whereIn(col, arr) { preds.push((r) => arr.includes(r[col])); return api; },
      whereNull(col) { preds.push((r) => r[col] == null); return api; },
      orderBy() { return api; },
      limit() { return api; },
      select() { return api; },
      distinct() { return api; },
      first() {
        const match = (state[table] || []).find((r) => preds.every((p) => p(r)));
        return Promise.resolve(match ? { ...match } : undefined);
      },
      then(resolve) { return Promise.resolve((state[table] || []).filter((r) => preds.every((p) => p(r)))).then(resolve); },
    };
    return api;
  }
  const db = (table) => query(table);
  db.raw = (sql) => ({ __raw: sql });
  return db;
});

const mockVisitFactsGateEnabled = jest.fn(() => false);
const mockDeterministicVisitFacts = jest.fn();
jest.mock('../services/previsit-brief', () => ({
  visitFactsGateEnabled: (...a) => mockVisitFactsGateEnabled(...a),
  deterministicVisitFacts: (...a) => mockDeterministicVisitFacts(...a),
}));

const { etDateString, addETDays } = require('../utils/datetime-et');
const { executeTechTool } = require('../services/intelligence-bar/tech-tools');

const ACCESS_BLOCK = {
  codes: { neighborhoodGate: '1234', propertyGate: null, garage: null, lockbox: null },
  pets: '2 dogs', petsSecuredPlan: null, chemicalSensitivities: null,
  accessNotes: 'side gate', parkingNotes: null, specialInstructions: null, alerts: [],
};

describe('get_stop_details access-facts gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.customers = [{ id: 'c1', first_name: 'Pat', last_name: 'Customer', phone: '941', active: true }];
    state.property_preferences = [{ customer_id: 'c1', property_gate_code: '9876', lockbox_code: '11', pet_count: 1 }];
    state.service_records = [];
    state.scheduled_services = [{ id: 's1', customer_id: 'c1', scheduled_date: etDateString(new Date()), status: 'confirmed', service_type: 'Pest Control', window_start: '09:00' }];
    mockVisitFactsGateEnabled.mockReturnValue(false);
    mockDeterministicVisitFacts.mockResolvedValue({ access: ACCESS_BLOCK, last_visit: null });
  });

  test('gate off: legacy raw prefs block served unchanged', async () => {
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, {});
    expect(r.property).toMatchObject({ property_gate_code: '9876', lockbox_code: '11', pet_count: 1 });
    expect(mockDeterministicVisitFacts).not.toHaveBeenCalled();
  });

  test('gate on + live visit today: shared access block, keyed to the visit row', async () => {
    mockVisitFactsGateEnabled.mockReturnValue(true);
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, {});
    expect(r.property).toEqual(ACCESS_BLOCK);
    expect(mockDeterministicVisitFacts).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', customer_id: 'c1' }));
  });

  test('gate on + no visit today: property withheld (per-visit answer)', async () => {
    mockVisitFactsGateEnabled.mockReturnValue(true);
    state.scheduled_services = [];
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, {});
    expect(r.property).toBeNull();
    expect(mockDeterministicVisitFacts).not.toHaveBeenCalled();
    expect(r.customer.name).toBe('Pat Customer');
  });

  test('gate on + facts failure: fail-soft null, rest of the answer intact', async () => {
    mockVisitFactsGateEnabled.mockReturnValue(true);
    mockDeterministicVisitFacts.mockRejectedValue(new Error('boom'));
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, {});
    expect(r.property).toBeNull();
    expect(r.todays_service).toMatchObject({ id: 's1' });
  });

  test("tech caller: another technician's same-day visit is invisible (no codes, no todays_service)", async () => {
    mockVisitFactsGateEnabled.mockReturnValue(true);
    state.scheduled_services[0].technician_id = 'tech-2';
    // keep the caller authorized on the customer via yesterday's assignment
    state.scheduled_services.push({ id: 's0', customer_id: 'c1', scheduled_date: etDateString(addETDays(new Date(), -1)), status: 'completed', technician_id: 'tech-1' });
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, { techId: 'tech-1' });
    expect(r.todays_service).toBeNull();
    expect(r.property).toBeNull();
    expect(mockDeterministicVisitFacts).not.toHaveBeenCalled();
  });

  test('tech caller: reassignment during the facts read withholds the codes (post-facts recheck)', async () => {
    mockVisitFactsGateEnabled.mockReturnValue(true);
    state.scheduled_services[0].technician_id = 'tech-1';
    mockDeterministicVisitFacts.mockImplementation(async () => {
      state.scheduled_services[0].technician_id = 'tech-2'; // dispatch reassigns mid-read
      return { access: ACCESS_BLOCK, last_visit: null };
    });
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, { techId: 'tech-1' });
    expect(r.property).toBeNull();
  });

  test('tech caller still assigned: shared access block served', async () => {
    mockVisitFactsGateEnabled.mockReturnValue(true);
    state.scheduled_services[0].technician_id = 'tech-1';
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, { techId: 'tech-1' });
    expect(r.property).toEqual(ACCESS_BLOCK);
  });

  test.each(['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'])(
    'dead same-day row (%s) is not a live visit: no codes, no todays_service',
    async (deadStatus) => {
      mockVisitFactsGateEnabled.mockReturnValue(true);
      state.scheduled_services[0].technician_id = 'tech-1';
      state.scheduled_services[0].status = deadStatus;
      // caller stays authorized via yesterday's completed visit
      state.scheduled_services.push({ id: 's0', customer_id: 'c1', scheduled_date: etDateString(addETDays(new Date(), -1)), status: 'completed', technician_id: 'tech-1' });
      const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, { techId: 'tech-1' });
      expect(r.todays_service).toBeNull();
      expect(r.property).toBeNull();
      expect(mockDeterministicVisitFacts).not.toHaveBeenCalled();
    },
  );

  test('date-move race: a live row moved off today mid-read withholds the codes', async () => {
    mockVisitFactsGateEnabled.mockReturnValue(true);
    state.scheduled_services[0].technician_id = 'tech-1';
    mockDeterministicVisitFacts.mockImplementation(async () => {
      state.scheduled_services[0].scheduled_date = etDateString(addETDays(new Date(), 3)); // moved, still live
      return { access: ACCESS_BLOCK, last_visit: null };
    });
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, { techId: 'tech-1' });
    expect(r.property).toBeNull();
  });

  test('reassignment race: a row going dead mid-read also withholds the codes', async () => {
    mockVisitFactsGateEnabled.mockReturnValue(true);
    state.scheduled_services[0].technician_id = 'tech-1';
    mockDeterministicVisitFacts.mockImplementation(async () => {
      state.scheduled_services[0].status = 'rescheduled'; // moved mid-read
      return { access: ACCESS_BLOCK, last_visit: null };
    });
    const r = await executeTechTool('get_stop_details', { customer_id: 'c1' }, { techId: 'tech-1' });
    expect(r.property).toBeNull();
  });
});
