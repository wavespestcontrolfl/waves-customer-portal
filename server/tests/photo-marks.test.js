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

  test('the photo gate alone does not enforce satellite geometry (codex P1 r10)', async () => {
    // The leak the ineligible-lane test above could not see. A typed lawn
    // visit IS satellite-eligible ('outline'), so it reached modeMismatchBlock
    // while the registry's own gate was still off — and the client posts
    // 'perimeter' in exactly that configuration, because traceFeedFields
    // reports traceVariant:null with the eligibility gate off and SchedulePage
    // then falls back to `isLawn`, which isTypedFindings forces FALSE for
    // aeration/fungicide/insect-control. Result: flipping GATE_PHOTO_MARKS
    // alone killed treatment-zone capture with a 400 on lawn visits that have
    // nothing to do with marks.
    jest.resetModules();
    jest.doMock('../services/service-completion-profiles', () => ({
      resolveCompletionProfileForScheduledService: async () => ({
        serviceKey: 'lawn_care_recurring', findingsType: 'one_time_lawn_treatment',
      }),
    }));
    const fresh = require('../services/service-report/trace-eligibility');
    const lawnService = { id: 'ss-lawn', service_type: 'Lawn Insect Control' };

    const marksOnly = await withBothGates({ eligibility: undefined, marks: 'true' },
      () => fresh.traceCaptureBlockPayload(lawnService, null, { captureMode: 'perimeter' }));
    expect(marksOnly).toBeNull();

    // ...and the check is still in force once its OWN gate is on, so this
    // defers the validation rather than deleting it.
    const bothOn = await withBothGates({ eligibility: 'true', marks: 'true' },
      () => fresh.traceCaptureBlockPayload(lawnService, null, { captureMode: 'perimeter' }));
    expect(bothOn).toMatchObject({
      status: 400,
      payload: { code: 'trace_capture_mode_mismatch', reason: 'outline' },
    });

    // The matching mode passes under both gates — the block is about geometry
    // disagreement, not about lawn visits.
    const matched = await withBothGates({ eligibility: 'true', marks: 'true' },
      () => fresh.traceCaptureBlockPayload(lawnService, null, { captureMode: 'lawn' }));
    expect(matched).toBeNull();

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

  test('a photo add-on is found BEHIND an eligible earlier line', async () => {
    // combineLineVerdicts stops at the primary (when eligible) or the first
    // eligible add-on, so a foam line behind a trenching primary or an
    // earlier spray add-on was invisible — while the tech route offered marks
    // for it, producing marks the report silently dropped (codex P1 r4).
    const verdicts = await addonVerdictsFromLines(
      [
        { serviceKey: 'termite_trenching', findingsType: 'termite_treatment', service_name: 'Trenching' },
        { serviceKey: 'foam_drill', findingsType: 'termite_treatment', service_name: 'Drill-and-Foam Termite' },
      ],
      knexStub([]),
    );
    // The combined verdict picks the FIRST eligible line...
    const { combineLineVerdicts } = require('../services/service-report/trace-eligibility');
    expect(combineLineVerdicts({ eligible: false, reason: 'bait_station_lane' }, verdicts).variant)
      .toBe('spray');
    // ...so the photo lane must be found by an independent scan.
    const photoLine = verdicts.find((v) => v?.eligible && v.variant === 'photo');
    expect(photoLine).toMatchObject({ variant: 'photo', serviceKey: 'foam_drill' });
  });

  test('a mixed visit keeps BOTH artifacts: satellite line stays eligible', async () => {
    // A trenching+foam visit earns a trace from the trenching line AND a
    // marked photo from the foam line. Suppressing the trace because a photo
    // lane exists silently dropped a trace the tech had already saved — the
    // capture path and field feed both use the combined satellite verdict
    // (codex P1 r5).
    const verdicts = await addonVerdictsFromLines(
      [
        { serviceKey: 'termite_trenching', findingsType: 'termite_treatment', service_name: 'Trenching' },
        { serviceKey: 'foam_drill', findingsType: 'termite_treatment', service_name: 'Drill-and-Foam Termite' },
      ],
      knexStub([]),
    );
    const photoLine = verdicts.find((v) => v?.eligible && v.variant === 'photo');
    const satelliteLine = verdicts.find((v) => v?.eligible && v.variant !== 'photo');
    expect(photoLine).toBeTruthy();
    expect(satelliteLine).toBeTruthy();
    // Both present ⇒ the render must NOT suppress the satellite trace.
    expect(Boolean(photoLine) && !satelliteLine).toBe(false);
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

describe('coordinate validation rejects rather than coerces', () => {
  // Number(null) is 0, Number('') is 0, Number(true) is 1 — a client that
  // serialized a failed measurement to null would otherwise publish a
  // fabricated point at a corner of the photo as treatment evidence
  // (codex P2 r6).
  test.each([null, undefined, '', '   ', true, false, [], {}, 'abc'])(
    'rejects %p as a coordinate',
    (bad) => {
      const result = validateMarks([{ x: bad, y: 0.5, kind: 'foam_injection' }], { serviceKey: 'foam_drill' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/must be numbers/);
    },
  );

  test('still accepts numeric strings and genuine zero', () => {
    const result = validateMarks(
      [{ x: '0', y: '0.25', kind: 'foam_injection' }],
      { serviceKey: 'foam_drill' },
    );
    expect(result.ok).toBe(true);
    expect(result.marks[0]).toMatchObject({ x: 0, y: 0.25 });
  });
});

describe('the marks gate keys the PDF cache', () => {
  const { photoMarksPdfSignature } = require('../services/service-report/photo-marks');

  test('empty while dark, so pre-flip keys are untouched', () => {
    withGate(undefined, () => expect(photoMarksPdfSignature()).toBe(''));
    withGate('false', () => expect(photoMarksPdfSignature()).toBe(''));
  });

  test('present when live, so a revoke actually removes the card', () => {
    // Without this the kill switch would clear the live payload while cached
    // PDFs kept serving the marked document indefinitely (codex P2 r6).
    withGate('true', () => expect(photoMarksPdfSignature()).toBe('-pm1'));
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

describe('a foam trace re-keys its cached PDF (caller audit)', () => {
  // Consumer audit of resolveTraceRenderVerdict: treatmentZonePdfSignature is
  // the one caller not exercised by the other suites. The render suppresses a
  // foam visit's legacy trace, so the cached PDF must re-key or the customer
  // keeps downloading the perimeter map the live report just removed.
  const { treatmentZonePdfSignature } = require('../services/treatment-zone-maps');
  const TRACED = {
    updated_at: new Date(1700000000000),
    created_at: new Date(1700000000000),
    capture_mode: 'perimeter',
  };
  // Linked identity — how a real foam visit resolves (#3306 links service_id).
  const foamRecord = {
    scheduled_service_id: 'ss-foam-sig',
    service_type: 'Drill-and-Foam Termite',
    service_data: JSON.stringify({ completedServiceKey: 'foam_drill', completedAddonLines: [] }),
  };
  const knexStub = (name) => ({
    where: () => ({
      first: async () => (name === 'treatment_zone_maps' ? TRACED
        : (name === 'scheduled_services'
          ? { id: 'ss-foam-sig', service_id: 'cat-foam', service_type: 'Drill-and-Foam Termite' }
          : null)),
      select: async () => [],
      orderBy: () => ({ orderBy: () => ({ select: async () => [] }) }),
    }),
    whereIn: () => ({ select: async () => [], where: () => ({ select: async () => [] }) }),
  });

  const sigWith = async (env) => {
    const prev = {
      GATE_TRACE_ELIGIBILITY: process.env.GATE_TRACE_ELIGIBILITY,
      GATE_PHOTO_MARKS: process.env.GATE_PHOTO_MARKS,
    };
    for (const k of Object.keys(prev)) delete process.env[k];
    Object.assign(process.env, env);
    try {
      return await treatmentZonePdfSignature(foamRecord, knexStub);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test('dark: the pre-flip key is untouched', async () => {
    expect(await sigWith({})).toBe('-tz1700000000000');
  });

  test('marks gate alone re-keys the traced foam record', async () => {
    // Without this the live report drops the spray map while every download
    // keeps serving it.
    expect(await sigWith({ GATE_PHOTO_MARKS: 'true' })).toMatch(/-te0-cmperimeter$/);
  });

  test('either gate produces the same suppressed key', async () => {
    const marks = await sigWith({ GATE_PHOTO_MARKS: 'true' });
    const elig = await sigWith({ GATE_TRACE_ELIGIBILITY: 'true' });
    const both = await sigWith({ GATE_PHOTO_MARKS: 'true', GATE_TRACE_ELIGIBILITY: 'true' });
    expect(elig).toBe(marks);
    expect(both).toBe(marks);
  });
});

describe('concurrent whole-set saves are serialized (codex P2 r11)', () => {
  // Verified against real Postgres 16 before this guard was written: two
  // savers racing the same photo each delete a set neither can see, then both
  // insert mark_number 1 — the loser dies on
  // service_photo_marks_..._mark_number_uni and the route returns 500 instead
  // of the documented last-save-wins. The row lock made it 0 failures / 1
  // surviving row. Jest has no database, so this asserts the ORDER that fix
  // depends on: the lock must be taken BEFORE the delete, or it serializes
  // nothing.
  const { saveMarksForPhoto } = require('../services/service-report/photo-marks');

  const fakeKnex = (calls) => {
    const trx = (table) => {
      const chain = {
        where: () => chain,
        forUpdate: () => { calls.push(`forUpdate:${table}`); return chain; },
        first: async () => { calls.push(`first:${table}`); return { id: 'ss-1' }; },
        del: async () => { calls.push(`del:${table}`); return 1; },
        insert: async () => { calls.push(`insert:${table}`); return []; },
      };
      return chain;
    };
    return { transaction: (cb) => cb(trx) };
  };

  test('locks the parent row before deleting the old set', async () => {
    const calls = [];
    await saveMarksForPhoto({
      scheduledServiceId: 'ss-1',
      s3Key: 'photos/wall.jpg',
      marks: [{ mark_number: 1, x: 0.5, y: 0.5, kind: 'foam_injection' }],
      knex: fakeKnex(calls),
    });
    expect(calls).toEqual([
      'forUpdate:scheduled_services',
      'first:scheduled_services',
      'del:service_photo_marks',
      'insert:service_photo_marks',
    ]);
  });

  test('clearing marks takes the lock too', async () => {
    // "Skip" after marks were saved is still a whole-set replacement, and it
    // races the same way.
    const calls = [];
    await saveMarksForPhoto({
      scheduledServiceId: 'ss-1', s3Key: 'photos/wall.jpg', marks: [], knex: fakeKnex(calls),
    });
    expect(calls.slice(0, 3)).toEqual([
      'forUpdate:scheduled_services',
      'first:scheduled_services',
      'del:service_photo_marks',
    ]);
    expect(calls).not.toContain('insert:service_photo_marks');
  });
});
