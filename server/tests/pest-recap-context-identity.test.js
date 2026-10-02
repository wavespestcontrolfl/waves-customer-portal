jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn() }));
jest.mock('../services/track-transitions', () => ({ markComplete: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/completion-recap', () => ({ generateRecap: jest.fn(), smsRecap: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn().mockResolvedValue({ category: 'pest_control' }),
}));

const { buildRecapContext } = require('../services/pest-recap');

function contextDb(visit) {
  return jest.fn((table) => {
    if (!['scheduled_services', 'job_status_history', 'products_catalog', 'service_records', 'scheduled_service_addons'].includes(table)) {
      throw new Error(`Unexpected recap context table: ${table}`);
    }
    const q = {
      where: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(table === 'scheduled_services' ? visit : null),
      select: jest.fn(() => (table === 'scheduled_services' ? q : Promise.resolve([]))),
    };
    return q;
  });
}

const visit = {
  id: 'visit-example', customer_id: 'customer-example', property_id: 'property-a',
  service_type: 'Quarterly Pest Control', service_id: 'cat-1', scheduled_date: '2026-09-09', status: 'confirmed',
  cust_address_line1: '100 Example Court', cust_address_line2: 'Unit 3',
  cust_city: 'Example City', cust_state: 'FL', cust_zip: '34201',
};

test('recap context exposes the live property and resolved legacy primary address', async () => {
  const result = await buildRecapContext(visit.id, contextDb(visit));
  expect(result.service).toMatchObject({
    propertyId: 'property-a',
    catalogServiceId: 'cat-1',
    address: { line1: '100 Example Court', line2: 'Unit 3', city: 'Example City', state: 'FL', zip: '34201' },
  });
});

test('a same-customer property reassignment returns the new stamped visit address', async () => {
  const changedVisit = {
    ...visit, property_id: 'property-b', service_address_line1: '200 Example Court',
    service_address_city: 'Example City', service_address_state: 'FL', service_address_zip: '34201',
  };
  const before = await buildRecapContext(visit.id, contextDb(visit));
  const after = await buildRecapContext(visit.id, contextDb(changedVisit));
  expect(after.service).toMatchObject({
    propertyId: 'property-b',
    address: { line1: '200 Example Court', line2: null, city: 'Example City', state: 'FL', zip: '34201' },
  });
  expect(after.service.customerId).toBe(before.service.customerId);
  expect(after.service.scheduledDate).toBe(before.service.scheduledDate);
  expect(after.service.serviceType).toBe(before.service.serviceType);
  expect(after.service.address).not.toEqual(before.service.address);
});

test('legacy primary address edits change recap identity without a property id', async () => {
  const before = await buildRecapContext(visit.id, contextDb({ ...visit, property_id: null }));
  const after = await buildRecapContext(visit.id, contextDb({
    ...visit, property_id: null, cust_address_line1: '300 Example Court',
  }));
  expect(before.service.propertyId).toBeNull();
  expect(after.service.propertyId).toBeNull();
  expect(after.service.address.line1).toBe('300 Example Court');
  expect(after.service.address).not.toEqual(before.service.address);
});

test('a visit stamp with an inline unit does not inherit the primary unit', async () => {
  const result = await buildRecapContext(visit.id, contextDb({
    ...visit, service_address_line1: '100 Example Court Unit 5',
  }));
  expect(result.service.address.line1).toBe('100 Example Court Unit 5');
  expect(result.service.address.line2).toBeNull();
});

// The Fast Complete report flow treats a free callback booked under a regular
// service key as a re-service (no pay link, no review ask): the context says
// so, and the flag never joins the visit identity the client echoes back.
test('the context says whether the visit is a free callback', async () => {
  expect((await buildRecapContext(visit.id, contextDb({ ...visit, is_callback: true }))).service.isCallback).toBe(true);
  expect((await buildRecapContext(visit.id, contextDb(visit))).service.isCallback).toBe(false);
});

describe('the lane the Fast Complete sheet reads (GATE_LANE_VOICE_FILL)', () => {
  const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
  const saved = process.env.GATE_LANE_VOICE_FILL;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_LANE_VOICE_FILL; else process.env.GATE_LANE_VOICE_FILL = saved;
    resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'pest_control' });
  });
  const bedBug = { ...visit, service_type: 'Bed Bug Treatment' };

  test('gate on: a lane visit carries its lane; the recap\'s own eligibility stays pest control only', async () => {
    process.env.GATE_LANE_VOICE_FILL = 'true';
    resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'specialty', serviceKey: 'bed_bug_treatment' });
    const result = await buildRecapContext(bedBug.id, contextDb(bedBug));
    expect(result).toMatchObject({ ok: true, eligible: false, lane: 'bed_bug_treatment' });
  });

  test('never for a visit that completes through a project, a typed form, or a pest visit', async () => {
    process.env.GATE_LANE_VOICE_FILL = 'true';
    resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'specialty', serviceKey: 'bed_bug_treatment', requiresProject: true });
    expect((await buildRecapContext(bedBug.id, contextDb(bedBug))).lane).toBeNull();
    resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'mosquito', serviceKey: 'mosquito_one_time', findingsType: 'mosquito_event' });
    expect((await buildRecapContext(bedBug.id, contextDb(bedBug))).lane).toBeNull();
    resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'pest_control', serviceKey: 'pest_general_quarterly' });
    expect((await buildRecapContext(visit.id, contextDb(visit))).lane).toBeNull();
  });

  test('a profile that could not be read is no lane: whether the visit completes through a project is unknown', async () => {
    process.env.GATE_LANE_VOICE_FILL = 'true';
    resolveCompletionProfileForScheduledService.mockRejectedValueOnce(new Error('profile store down'));
    expect((await buildRecapContext(bedBug.id, contextDb(bedBug))).lane).toBeNull();
  });

  describe('whether a saved trace would show on the lane visit\'s report (codex local r5 on #5629)', () => {
    const savedTraceGate = process.env.GATE_TRACE_ELIGIBILITY;
    afterEach(() => {
      if (savedTraceGate === undefined) delete process.env.GATE_TRACE_ELIGIBILITY; else process.env.GATE_TRACE_ELIGIBILITY = savedTraceGate;
    });
    const fireAnt = { ...visit, service_type: 'Fire Ant Treatment' };

    test('the report\'s own verdict: bed bug\'s indoor work carries no map, fire ant\'s lawn outline does', async () => {
      process.env.GATE_LANE_VOICE_FILL = 'true';
      process.env.GATE_TRACE_ELIGIBILITY = 'true';
      resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'specialty', serviceKey: 'bed_bug_treatment' });
      expect(await buildRecapContext(bedBug.id, contextDb(bedBug))).toMatchObject({ lane: 'bed_bug_treatment', traceOnReport: false });
      resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'specialty', serviceKey: 'fire_ant' });
      expect(await buildRecapContext(fireAnt.id, contextDb(fireAnt))).toMatchObject({ lane: 'fire_ant', traceOnReport: true });
    });

    test('gate off: the report\'s legacy indoor-only rule still hides bed bug\'s map', async () => {
      process.env.GATE_LANE_VOICE_FILL = 'true';
      delete process.env.GATE_TRACE_ELIGIBILITY;
      resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'specialty', serviceKey: 'bed_bug_treatment' });
      expect((await buildRecapContext(bedBug.id, contextDb(bedBug))).traceOnReport).toBe(false);
      resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'specialty', serviceKey: 'fire_ant' });
      expect((await buildRecapContext(fireAnt.id, contextDb(fireAnt))).traceOnReport).toBe(true);
    });

    test('the line is judged from the profile already resolved: a second lookup that would fail is never made', async () => {
      process.env.GATE_LANE_VOICE_FILL = 'true';
      process.env.GATE_TRACE_ELIGIBILITY = 'true';
      resolveCompletionProfileForScheduledService.mockClear();
      resolveCompletionProfileForScheduledService
        .mockResolvedValueOnce({ category: 'specialty', serviceKey: 'fire_ant' })
        .mockRejectedValueOnce(new Error('profile store down'));
      expect((await buildRecapContext(fireAnt.id, contextDb(fireAnt))).traceOnReport).toBe(true);
      expect(resolveCompletionProfileForScheduledService).toHaveBeenCalledTimes(1);
      // The unconsumed rejection must not reach the next case (the outer
      // afterEach restores the default answer).
      resolveCompletionProfileForScheduledService.mockReset();
    });

    test('an add-on read that fails counts as shown, so the sheet\'s holds stand', async () => {
      process.env.GATE_LANE_VOICE_FILL = 'true';
      process.env.GATE_TRACE_ELIGIBILITY = 'true';
      resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'specialty', serviceKey: 'bed_bug_treatment' });
      const db = contextDb(bedBug);
      const failingAddons = jest.fn((table) => {
        if (table === 'scheduled_service_addons') throw new Error('addon read failed');
        return db(table);
      });
      expect((await buildRecapContext(bedBug.id, failingAddons)).traceOnReport).toBe(true);
    });

    test('a pest visit carries no such field', async () => {
      process.env.GATE_LANE_VOICE_FILL = 'true';
      expect(await buildRecapContext(visit.id, contextDb(visit))).not.toHaveProperty('traceOnReport');
    });
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: no lane', async (value) => {
    if (value === undefined) delete process.env.GATE_LANE_VOICE_FILL; else process.env.GATE_LANE_VOICE_FILL = value;
    resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'specialty', serviceKey: 'bed_bug_treatment' });
    expect((await buildRecapContext(bedBug.id, contextDb(bedBug))).lane).toBeNull();
  });
});

describe('the typed form the Fast Complete sheet reads (GATE_TYPED_VOICE_FILL)', () => {
  const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
  const savedTyped = process.env.GATE_TYPED_VOICE_FILL;
  const savedTrace = process.env.GATE_TRACE_ELIGIBILITY;
  afterEach(() => {
    if (savedTyped === undefined) delete process.env.GATE_TYPED_VOICE_FILL; else process.env.GATE_TYPED_VOICE_FILL = savedTyped;
    if (savedTrace === undefined) delete process.env.GATE_TRACE_ELIGIBILITY; else process.env.GATE_TRACE_ELIGIBILITY = savedTrace;
    resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'pest_control' });
  });
  const roach = { ...visit, service_type: 'Cockroach Control' };
  const ROACH = { category: 'pest_control', serviceKey: 'cockroach_control', findingsType: 'cockroach' };

  test('gate on: a typed visit the reader reads carries its form, and whether a saved trace would show on its report', async () => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    resolveCompletionProfileForScheduledService.mockResolvedValue(ROACH);
    expect(await buildRecapContext(roach.id, contextDb(roach))).toMatchObject({ typedType: 'cockroach', traceOnReport: true, lane: null });
    // An inspection's report carries no map.
    const inspection = { ...visit, service_type: 'Rodent Inspection' };
    resolveCompletionProfileForScheduledService.mockResolvedValue({ category: 'rodent', serviceKey: 'rodent_inspection', findingsType: 'rodent_inspection' });
    expect(await buildRecapContext(inspection.id, contextDb(inspection))).toMatchObject({ typedType: 'rodent_inspection', traceOnReport: false });
  });

  test.each([
    ['completes through a project', { ...ROACH, requiresProject: true }],
    ['is project-backed', { ...ROACH, projectBacked: true }],
    ['is a combined visit, whose companion sections the sheet has none of', { ...ROACH, companions: [{ type: 'rodent_bait_station' }] }],
    ['is a form the reader does not read', { category: 'tree_shrub', serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub' }],
    ['is untyped', { category: 'pest_control', serviceKey: 'pest_general_quarterly' }],
  ])('never for a visit that %s', async (_label, profile) => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    resolveCompletionProfileForScheduledService.mockResolvedValue(profile);
    const result = await buildRecapContext(roach.id, contextDb(roach));
    expect(result).not.toHaveProperty('typedType');
    expect(result).not.toHaveProperty('traceOnReport');
  });

  test('the sheet books a suggested follow-up only while the gate is on', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue(ROACH);
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    expect((await buildRecapContext(roach.id, contextDb(roach))).followupBooking).toBe(true);
    delete process.env.GATE_TYPED_VOICE_FILL;
    expect((await buildRecapContext(roach.id, contextDb(roach))).followupBooking).toBe(false);
  });

  test('a profile that could not be read is no typed form', async () => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    resolveCompletionProfileForScheduledService.mockRejectedValueOnce(new Error('profile store down'));
    expect(await buildRecapContext(roach.id, contextDb(roach))).not.toHaveProperty('typedType');
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: no typed form', async (value) => {
    if (value === undefined) delete process.env.GATE_TYPED_VOICE_FILL; else process.env.GATE_TYPED_VOICE_FILL = value;
    resolveCompletionProfileForScheduledService.mockResolvedValue(ROACH);
    expect(await buildRecapContext(roach.id, contextDb(roach))).not.toHaveProperty('typedType');
  });
});
