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
