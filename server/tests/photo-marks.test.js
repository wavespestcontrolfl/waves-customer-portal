/**
 * Treated-point marks — vocabulary, validation, and the report-side context.
 * Rulings under test (docs/design/treatment-animation-scope.md):
 *   - marks are TYPED, from a closed per-lane vocabulary
 *   - marks are OPTIONAL (no marks → no card, never an error)
 *   - the card NEVER states a count
 */
const {
  markKindsForLane,
  defaultKindForLane,
  laneSupportsMarks,
  validateMarks,
  buildMarkedPhotoContext,
  photoMarksGateOn,
  MAX_MARKS_PER_PHOTO,
} = require('../services/service-report/photo-marks');
const { resolveTraceEligibility } = require('../services/service-report/trace-eligibility');

const withGate = (value, fn) => {
  const prev = process.env.GATE_PHOTO_MARKS;
  if (value === undefined) delete process.env.GATE_PHOTO_MARKS;
  else process.env.GATE_PHOTO_MARKS = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.GATE_PHOTO_MARKS;
    else process.env.GATE_PHOTO_MARKS = prev;
  }
};

const FOAM = { eligible: true, variant: 'photo', captionKey: 'foamPoints' };
const mark = (over = {}) => ({ n: 1, x: 0.5, y: 0.5, kind: 'foam_injection', label: 'Drilled & foamed', ...over });

describe('mark vocabulary', () => {
  test('foam lanes expose the typed vocabulary with foam as the default', () => {
    for (const key of ['foam_drill', 'foam_recurring']) {
      expect(laneSupportsMarks(key)).toBe(true);
      expect(defaultKindForLane(key)).toBe('foam_injection');
      expect(markKindsForLane(key).map((k) => k.kind))
        .toEqual(['foam_injection', 'spot_treatment', 'wood_treatment']);
    }
  });

  test('lanes that are not point-localized expose nothing', () => {
    // termite_liquid and termite_trenching share foam's TYPED findings type
    // but are perimeter applications — marks must not be offered there.
    for (const key of ['termite_liquid', 'termite_trenching', 'pest_general_quarterly', 'lawn_care_monthly', null]) {
      expect(laneSupportsMarks(key)).toBe(false);
      expect(markKindsForLane(key)).toEqual([]);
      expect(defaultKindForLane(key)).toBeNull();
    }
  });
});

describe('validateMarks', () => {
  test('accepts in-range marks and numbers them server-side in placement order', () => {
    const result = validateMarks(
      [
        { x: 0.1, y: 0.2, kind: 'foam_injection', n: 99 },
        { x: 0.9, y: 0.8, kind: 'wood_treatment', n: 99 },
      ],
      { serviceKey: 'foam_drill' },
    );
    expect(result.ok).toBe(true);
    // Client-supplied numbers are ignored — a duplicate could otherwise reach
    // the unique index, or the customer's card.
    expect(result.marks.map((m) => m.mark_number)).toEqual([1, 2]);
    expect(result.marks[1].kind).toBe('wood_treatment');
  });

  test('an empty set is valid — marks are optional', () => {
    const result = validateMarks([], { serviceKey: 'foam_drill' });
    expect(result.ok).toBe(true);
    expect(result.marks).toEqual([]);
  });

  test('rejects out-of-range coordinates rather than clamping them', () => {
    // Clamping would pin a mark to an edge it was never placed on.
    for (const bad of [{ x: 1.4, y: 0.5 }, { x: 0.5, y: -0.1 }]) {
      const result = validateMarks([{ ...bad, kind: 'foam_injection' }], { serviceKey: 'foam_drill' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/between 0 and 1/);
    }
  });

  test('rejects a kind the lane cannot record', () => {
    const result = validateMarks(
      [{ x: 0.5, y: 0.5, kind: 'sealed_entry_point' }],
      { serviceKey: 'foam_drill' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsupported kind/);
  });

  test('rejects marks on a lane that does not support them', () => {
    const result = validateMarks(
      [{ x: 0.5, y: 0.5, kind: 'foam_injection' }],
      { serviceKey: 'termite_liquid' },
    );
    expect(result.ok).toBe(false);
  });

  test('caps the per-photo mark count', () => {
    const many = Array.from({ length: MAX_MARKS_PER_PHOTO + 1 }, () => ({ x: 0.5, y: 0.5, kind: 'foam_injection' }));
    expect(validateMarks(many, { serviceKey: 'foam_drill' }).ok).toBe(false);
  });
});

describe('buildMarkedPhotoContext', () => {
  test('is dark until GATE_PHOTO_MARKS is exactly true', () => {
    withGate(undefined, () => {
      expect(photoMarksGateOn()).toBe(false);
      expect(buildMarkedPhotoContext({ marks: [mark()], eligibility: FOAM }))
        .toMatchObject({ available: false, reason: 'disabled' });
    });
    withGate('1', () => {
      expect(buildMarkedPhotoContext({ marks: [mark()], eligibility: FOAM }).available).toBe(false);
    });
  });

  test('publishes marks for an eligible photo lane', () => {
    withGate('true', () => {
      const context = buildMarkedPhotoContext({
        marks: [mark(), mark({ n: 2, kind: 'wood_treatment', label: 'Wood treated' })],
        eligibility: FOAM,
      });
      expect(context.available).toBe(true);
      expect(context.marks).toHaveLength(2);
      expect(context.captionKey).toBe('foamPoints');
    });
  });

  test('NEVER publishes a count or total', () => {
    withGate('true', () => {
      const context = buildMarkedPhotoContext({ marks: [mark(), mark({ n: 2 })], eligibility: FOAM });
      // Foam is priced by drill-point count and marks need not be exhaustive,
      // so any total here invites a customer to tally pins against billed
      // points. This is the deliberate divergence from the station map.
      expect(context.summary).toBeUndefined();
      expect(context.total).toBeUndefined();
      expect(context.count).toBeUndefined();
    });
  });

  test('legend carries only the kinds actually present', () => {
    withGate('true', () => {
      const context = buildMarkedPhotoContext({ marks: [mark(), mark({ n: 2 })], eligibility: FOAM });
      expect(context.legend).toEqual([{ kind: 'foam_injection', label: 'Drilled & foamed' }]);
    });
  });

  test('no marks is a complete visit, not a failure', () => {
    withGate('true', () => {
      expect(buildMarkedPhotoContext({ marks: [], eligibility: FOAM }))
        .toMatchObject({ available: false, reason: 'no_marks' });
    });
  });

  test('a non-photo lane never gets the card', () => {
    withGate('true', () => {
      expect(buildMarkedPhotoContext({
        marks: [mark()],
        eligibility: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
      })).toMatchObject({ available: false, reason: 'lane_not_eligible' });
    });
  });

  test('all-or-nothing: one unresolvable mark suppresses the whole card', () => {
    withGate('true', () => {
      // A subset would silently understate what the technician recorded.
      expect(buildMarkedPhotoContext({
        marks: [mark(), mark({ n: 2, x: Number.NaN })],
        eligibility: FOAM,
      })).toMatchObject({ available: false, reason: 'marks_unresolvable' });
      expect(buildMarkedPhotoContext({
        marks: [mark(), mark({ n: 2, kind: 'not_a_kind' })],
        eligibility: FOAM,
      })).toMatchObject({ available: false, reason: 'marks_unresolvable' });
    });
  });
});

describe('photo-lane capture block is independent of GATE_TRACE_ELIGIBILITY', () => {
  // The rollout allows GATE_PHOTO_MARKS on while GATE_TRACE_ELIGIBILITY is
  // still off. Under that ordering the photo-lane block must still fire, or a
  // foam visit can save a satellite trace and publish a perimeter band beside
  // its marked photo (codex P1).
  const { traceCaptureBlockPayload } = require('../services/service-report/trace-eligibility');
  const foamService = { id: 'ss-foam', service_type: 'Drill-and-Foam Termite' };

  const withBothGates = async ({ eligibility, marks }, fn) => {
    const prevE = process.env.GATE_TRACE_ELIGIBILITY;
    const prevP = process.env.GATE_PHOTO_MARKS;
    if (eligibility === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
    else process.env.GATE_TRACE_ELIGIBILITY = eligibility;
    if (marks === undefined) delete process.env.GATE_PHOTO_MARKS;
    else process.env.GATE_PHOTO_MARKS = marks;
    try { return await fn(); } finally {
      if (prevE === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
      else process.env.GATE_TRACE_ELIGIBILITY = prevE;
      if (prevP === undefined) delete process.env.GATE_PHOTO_MARKS;
      else process.env.GATE_PHOTO_MARKS = prevP;
    }
  };

  // Profile resolver stub: foam catalog key, shared typed pointer.
  jest.mock('../services/service-completion-profiles', () => ({
    resolveCompletionProfileForScheduledService: async () => ({
      serviceKey: 'foam_drill', findingsType: 'termite_treatment',
    }),
  }), { virtual: false });

  test('blocks the satellite tracer with only the photo gate on', async () => {
    const block = await withBothGates({ eligibility: undefined, marks: 'true' },
      () => traceCaptureBlockPayload(foamService, null, { captureMode: 'perimeter' }));
    expect(block).toMatchObject({ status: 403, payload: { code: 'trace_photo_lane' } });
  });

  test('blocks it with both gates on', async () => {
    const block = await withBothGates({ eligibility: 'true', marks: 'true' },
      () => traceCaptureBlockPayload(foamService, null, { captureMode: 'perimeter' }));
    expect(block).toMatchObject({ status: 403, payload: { code: 'trace_photo_lane' } });
  });

  test('stays fully inert with both gates off', async () => {
    const block = await withBothGates({ eligibility: undefined, marks: undefined },
      () => traceCaptureBlockPayload(foamService, null, { captureMode: 'perimeter' }));
    expect(block).toBeNull();
  });

  test('the photo gate alone does not activate the wider registry', async () => {
    // An ineligible NON-photo lane must keep pre-gate behavior when only the
    // marks gate is on — turning on foam marks cannot silently start
    // suppressing captures across unrelated lanes.
    jest.resetModules();
    jest.doMock('../services/service-completion-profiles', () => ({
      resolveCompletionProfileForScheduledService: async () => ({
        serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping',
      }),
    }));
    const fresh = require('../services/service-report/trace-eligibility');
    const block = await withBothGates({ eligibility: undefined, marks: 'true' },
      () => fresh.traceCaptureBlockPayload({ id: 'ss-trap', service_type: 'Rodent Trap Check' }, null, {}));
    expect(block).toBeNull();
    jest.dontMock('../services/service-completion-profiles');
    jest.resetModules();
  });
});

describe('a foam ADD-ON makes the visit a photo lane', () => {
  // A termite-bait primary with a foam add-on is a foam visit for photo
  // purposes. With only GATE_PHOTO_MARKS on, the add-on combine that the
  // eligibility gate normally performs is skipped, so the capture path has to
  // resolve add-ons itself or the visit can still save a satellite trace
  // (codex P1 r3).
  const { traceCaptureBlockPayload, addonVerdictsFromLines } = require('../services/service-report/trace-eligibility');

  const knexStub = (addonRows) => {
    const fn = (table) => {
      if (table === 'scheduled_service_addons') {
        return {
          where: () => ({
            orderBy: () => ({ orderBy: () => ({ select: async () => addonRows }) }),
          }),
        };
      }
      if (table === 'services') {
        return { whereIn: () => ({ select: async () => [{ id: 'cat-foam', service_key: 'foam_drill' }] }) };
      }
      if (table === 'service_completion_profiles') {
        return {
          whereIn: () => ({
            where: () => ({ select: async () => [{ service_key: 'foam_drill', project_type: 'termite_treatment' }] }),
          }),
        };
      }
      return { where: () => ({ first: async () => null }) };
    };
    return fn;
  };

  const withGates = async (eligibility, marks, fn) => {
    const prevE = process.env.GATE_TRACE_ELIGIBILITY;
    const prevP = process.env.GATE_PHOTO_MARKS;
    if (eligibility === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
    else process.env.GATE_TRACE_ELIGIBILITY = eligibility;
    if (marks === undefined) delete process.env.GATE_PHOTO_MARKS;
    else process.env.GATE_PHOTO_MARKS = marks;
    try { return await fn(); } finally {
      if (prevE === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
      else process.env.GATE_TRACE_ELIGIBILITY = prevE;
      if (prevP === undefined) delete process.env.GATE_PHOTO_MARKS;
      else process.env.GATE_PHOTO_MARKS = prevP;
    }
  };

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../services/service-completion-profiles', () => ({
      // Ineligible PRIMARY: a termite bait station check.
      resolveCompletionProfileForScheduledService: async () => ({
        serviceKey: 'termite_installation_setup', findingsType: 'termite_bait_station',
      }),
    }));
  });
  afterEach(() => { jest.dontMock('../services/service-completion-profiles'); jest.resetModules(); });

  test('add-on verdicts carry the service key the vocabulary is drawn from', async () => {
    const verdicts = await addonVerdictsFromLines(
      [{ service_id: 'cat-foam', service_name: 'Drill-and-Foam Termite' }],
      knexStub([]),
    );
    expect(verdicts[0]).toMatchObject({ eligible: true, variant: 'photo', serviceKey: 'foam_drill' });
  });

  test('capture is blocked with only the marks gate on', async () => {
    const fresh = require('../services/service-report/trace-eligibility');
    const block = await withGates(undefined, 'true', () => fresh.traceCaptureBlockPayload(
      { id: 'ss-1', service_type: 'Termite Bait Station Check' },
      knexStub([{ service_id: 'cat-foam', service_name: 'Drill-and-Foam Termite' }]),
      { captureMode: 'perimeter' },
    ));
    expect(block).toMatchObject({ status: 403, payload: { code: 'trace_photo_lane' } });
  });

  test('a visit with no foam line keeps pre-gate capture behavior', async () => {
    const fresh = require('../services/service-report/trace-eligibility');
    const block = await withGates(undefined, 'true', () => fresh.traceCaptureBlockPayload(
      { id: 'ss-2', service_type: 'Termite Bait Station Check' },
      knexStub([]),
      { captureMode: 'perimeter' },
    ));
    expect(block).toBeNull();
  });
});

describe('traceFeedFields — the schedule/dispatch tracer affordance', () => {
  // traceEligible means "offer the SATELLITE tracer". A photo lane is mapped
  // by marking a photo, so offering the tracer is a dead end: the capture
  // block rejects the eventual save with trace_photo_lane (codex P2).
  const { traceFeedFields } = require('../services/service-report/trace-eligibility');
  const withEligibilityGate = (value, fn) => {
    const prev = process.env.GATE_TRACE_ELIGIBILITY;
    if (value === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
    else process.env.GATE_TRACE_ELIGIBILITY = value;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
      else process.env.GATE_TRACE_ELIGIBILITY = prev;
    }
  };
  const photo = { eligible: true, variant: 'photo', captionKey: 'foamPoints' };
  const spray = { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' };
  const ineligible = { eligible: false, reason: 'trap_lane' };

  test('a photo lane never offers the tracer, under either gate', () => {
    for (const gate of [undefined, 'true']) {
      withEligibilityGate(gate, () => {
        expect(traceFeedFields(photo)).toEqual({ traceEligible: false, traceVariant: 'photo' });
      });
    }
  });

  test('satellite lanes are unchanged with the eligibility gate on', () => {
    withEligibilityGate('true', () => {
      expect(traceFeedFields(spray)).toEqual({ traceEligible: true, traceVariant: 'spray' });
      expect(traceFeedFields(ineligible)).toEqual({ traceEligible: false, traceVariant: null });
    });
  });

  test('with the eligibility gate off, only a photo lane may hide the tracer', () => {
    withEligibilityGate(undefined, () => {
      // Enabling marks must not start hiding tracers across unrelated lanes.
      expect(traceFeedFields(ineligible)).toEqual({ traceEligible: true, traceVariant: null });
      expect(traceFeedFields(spray)).toEqual({ traceEligible: true, traceVariant: null });
      expect(traceFeedFields(null)).toEqual({ traceEligible: true, traceVariant: null });
    });
  });
});

describe('foam routes to the photo variant', () => {
  test('the catalog key wins over the shared termite_treatment pointer', () => {
    // Foam completes as termite_treatment, which it shares with liquid
    // perimeter and trenching, and typed lanes resolve FIRST. Without
    // overridesSnapshot a foam visit would inherit that lane's spray variant.
    for (const serviceKey of ['foam_drill', 'foam_recurring']) {
      expect(resolveTraceEligibility({ serviceKey, findingsType: 'termite_treatment' }))
        .toMatchObject({ eligible: true, variant: 'photo', captionKey: 'foamPoints' });
    }
  });

  test('the shared perimeter lanes are untouched', () => {
    expect(resolveTraceEligibility({ serviceKey: 'termite_liquid', findingsType: 'termite_treatment' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
  });
});
