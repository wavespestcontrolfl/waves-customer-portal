// Inputs for the tree & shrub "From your technician" paragraph
// (GATE_TS_TECH_PARAGRAPH): the note, the applied product names, the kept photo
// findings as { key, kind } under the technician's decisions, and the
// technician's own landscape rating. The watch list, the last visit, the report
// headline and everything about a product but its name are not inputs.
// Synthetic data only.

const {
  gatherTreeShrubTechParagraphInputs, keptPhotoFindings, landscapeConditionOf,
} = require('../services/service-report/tree-shrub-tech-paragraph-inputs');

const row = (key, status) => ({ key, status, label: key, score: status === 'tracking' ? null : 60 });
const DIAGNOSIS = [
  row('foliage_fullness', 'healthy'),
  row('leaf_color_vigor', 'watch'),
  row('pest_activity', 'needs_attention'),
  row('disease_leaf_spot', 'watch'),
  row('water_heat_mechanical_stress', 'tracking'),
];

describe('kept photo findings', () => {
  test('a flagged finding nobody reviewed is a "maybe"', () => {
    expect(keptPhotoFindings(DIAGNOSIS, [])).toEqual([
      { key: 'pest_activity', kind: 'maybe' },
      { key: 'disease_leaf_spot', kind: 'maybe' },
      { key: 'leaf_color_vigor', kind: 'maybe' },
    ]);
  });

  test('a hidden finding never enters, and a rewritten one does not either (the technician\'s words speak for it)', () => {
    const decisions = [
      { key: 'pest_activity', action: 'hidden', detail: null },
      { key: 'disease_leaf_spot', action: 'edit', detail: 'Only dust spots on the leaves.' },
    ];
    expect(keptPhotoFindings(DIAGNOSIS, decisions)).toEqual([{ key: 'leaf_color_vigor', kind: 'maybe' }]);
    expect(JSON.stringify(keptPhotoFindings(DIAGNOSIS, decisions))).not.toContain('dust');
  });

  test('a confirmed finding is "confirmed", even on a row the photo read left clean', () => {
    const out = keptPhotoFindings(DIAGNOSIS, [{ key: 'pest_activity', action: 'confirmed' }, { key: 'foliage_fullness', action: 'confirmed' }]);
    expect(out).toContainEqual({ key: 'pest_activity', kind: 'confirmed' });
    expect(out).toContainEqual({ key: 'foliage_fullness', kind: 'confirmed' });
  });

  test('a monitor decision stays a "maybe"; a tracking row is nothing', () => {
    const out = keptPhotoFindings(DIAGNOSIS, [{ key: 'leaf_color_vigor', action: 'monitor' }]);
    expect(out).toContainEqual({ key: 'leaf_color_vigor', kind: 'maybe' });
    expect(out.map((f) => f.key)).not.toContain('water_heat_mechanical_stress');
  });
});

describe('landscapeConditionOf', () => {
  test('reads the technician\'s own rating from the frozen typed completion, else null', () => {
    const rec = (data) => ({ service_data: JSON.stringify(data) });
    expect(landscapeConditionOf(rec({ typedReportSnapshot: { type: 'tree_shrub', values: { landscape_condition: 'Good' } } }))).toBe('Good');
    expect(landscapeConditionOf({ service_data: { typedReportSnapshot: { values: { landscape_condition: 'Excellent' } } } })).toBe('Excellent');
    for (const bad of [rec({}), rec({ typedReportSnapshot: { values: {} } }), rec({ typedReportSnapshot: { values: { landscape_condition: 3 } } }), { service_data: 'not json' }, null, {}]) {
      expect(landscapeConditionOf(bad)).toBeNull();
    }
  });
});

describe('gatherTreeShrubTechParagraphInputs', () => {
  const REPORT = {
    snapshot: { statusHeadline: 'Healthy — monitoring pest pressure' },
    diagnosis: DIAGNOSIS,
    treatment: {
      products: [
        { name: 'Merit 2F', activeIngredient: 'imidacloprid', kind: 'systemic', method: 'drench', targets: ['scale', 'whitefly'], whatItDoes: 'ignored', area: '400 sq ft' },
        { name: 'Palm Gro 8-2-12', activeIngredient: null, kind: 'fertilizer', method: null, targets: [] },
      ],
    },
  };
  const RECORD = {
    id: 'sr-now',
    technician_notes: 'Found scale on the back hedge. Treated the hedges with Merit.',
    structured_notes: JSON.stringify({
      treeShrubTechFindings: [{ key: 'pest_activity', action: 'hidden' }],
      treeShrubWatchItems: [{ key: 'scale', label: 'Scale', state: 'seen', extent: 'a_few', source: 'tech' }, { key: 'trunk_conk_base', state: 'seen' }],
    }),
    service_data: JSON.stringify({ typedReportSnapshot: { values: { landscape_condition: 'Good' } } }),
  };

  test('assembles exactly four inputs; the watch list, headline, last visit and product details never enter', () => {
    const out = gatherTreeShrubTechParagraphInputs({ record: RECORD, data: { reportV2: REPORT } });
    expect(out).toEqual({
      technicianNote: RECORD.technician_notes,
      products: [{ name: 'Merit 2F' }, { name: 'Palm Gro 8-2-12' }],
      // The hidden pest finding is gone; the Seen watch items never enter.
      findings: [{ key: 'disease_leaf_spot', kind: 'maybe' }, { key: 'leaf_color_vigor', kind: 'maybe' }],
      landscapeCondition: 'Good',
    });
    expect(JSON.stringify(out)).not.toMatch(/conk|400 sq|ignored|imidacloprid|drench|Healthy/i);
  });

  test('no report build, or no record, means no inputs', () => {
    expect(gatherTreeShrubTechParagraphInputs({ record: RECORD, data: { reportV2: null } })).toBeNull();
    expect(gatherTreeShrubTechParagraphInputs({ record: null, data: { reportV2: REPORT } })).toBeNull();
  });

  test('a visit with no note still gathers (the deterministic lines need none)', () => {
    const out = gatherTreeShrubTechParagraphInputs({ record: { ...RECORD, technician_notes: null }, data: { reportV2: REPORT } });
    expect(out.technicianNote).toBe('');
    expect(out.products).toHaveLength(2);
  });
});
