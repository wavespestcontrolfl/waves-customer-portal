// Inputs for the tree & shrub "From your technician" paragraph
// (GATE_TS_TECH_PARAGRAPH): what the model may see, under the technician's
// decisions. A hidden or rewritten finding never enters, a confirmed one enters
// at high confidence, an unreviewed flagged one at low; Seen watch items enter
// as the technician's own findings; refer-only items and the trunk conk never
// enter. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  gatherTreeShrubTechParagraphInputs, keptPhotoFindings,
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
  test('a flagged finding nobody reviewed enters at low confidence', () => {
    expect(keptPhotoFindings(DIAGNOSIS, [])).toEqual([
      { label: 'pest pressure signals', confidence: 'low', source: 'photo' },
      { label: 'leaf spot signals', confidence: 'low', source: 'photo' },
      { label: 'off-color leaves', confidence: 'low', source: 'photo' },
    ]);
  });

  test('a hidden finding never enters, and a rewritten one does not either (the technician\'s words speak for it)', () => {
    const decisions = [
      { key: 'pest_activity', action: 'hidden', detail: null },
      { key: 'disease_leaf_spot', action: 'edit', detail: 'Only dust spots on the leaves.' },
    ];
    expect(keptPhotoFindings(DIAGNOSIS, decisions)).toEqual([{ label: 'off-color leaves', confidence: 'low', source: 'photo' }]);
    // The technician's edit text itself never reaches the model.
    expect(JSON.stringify(keptPhotoFindings(DIAGNOSIS, decisions))).not.toContain('dust');
  });

  test('a confirmed finding enters at high confidence, even on a row the photo read left clean', () => {
    const decisions = [{ key: 'pest_activity', action: 'confirmed', detail: null }, { key: 'foliage_fullness', action: 'confirmed', detail: null }];
    const out = keptPhotoFindings(DIAGNOSIS, decisions);
    expect(out).toContainEqual({ label: 'pest pressure signals', confidence: 'high', source: 'photo' });
    expect(out).toContainEqual({ label: 'thin foliage', confidence: 'high', source: 'photo' });
  });

  test('a monitor decision keeps the finding low; a tracking row is nothing', () => {
    const out = keptPhotoFindings(DIAGNOSIS, [{ key: 'leaf_color_vigor', action: 'monitor' }]);
    expect(out).toContainEqual({ label: 'off-color leaves', confidence: 'low', source: 'photo' });
    expect(out.map((f) => f.label)).not.toContain('heat or pruning stress');
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
    customer_id: 'c1',
    scheduled_service_id: 'ss-now',
    service_date: '2026-10-05',
    technician_notes: 'Found scale on the back hedge. Treated the hedges with Merit.',
    structured_notes: JSON.stringify({
      treeShrubTechFindings: [{ key: 'pest_activity', action: 'hidden' }],
      treeShrubWatchItems: [{ key: 'scale', label: 'Scale', state: 'seen', extent: 'a_few', source: 'tech' }, { key: 'trunk_conk_base', state: 'seen' }],
    }),
  };

  // One table-aware fake: each table answers `first` / thenable with its fixture.
  function fakeKnex({ property = { property_id: 'p1' }, last = null, lastProducts = [], catalog = [{ name: 'Merit 2F' }, { name: 'Celsius WG' }] } = {}) {
    const calls = [];
    const knex = (table) => {
      calls.push(table);
      const q = {};
      const chain = ['where', 'whereNot', 'join', 'orderBy', 'select'];
      chain.forEach((m) => { q[m] = () => q; });
      q.first = async () => {
        if (table === 'scheduled_services') return property;
        if (table.startsWith('service_records')) return last;
        return null;
      };
      q.then = (resolve, reject) => Promise.resolve(table === 'service_products' ? lastProducts : table === 'products_catalog' ? catalog : []).then(resolve, reject);
      return q;
    };
    return { knex, calls };
  }

  test('assembles the note, products, kept findings, headline and the defense list; the watch list is not an input', async () => {
    const { knex } = fakeKnex();
    const out = await gatherTreeShrubTechParagraphInputs({ record: RECORD, data: { reportV2: REPORT }, knex });
    expect(out.technicianNote).toBe(RECORD.technician_notes);
    expect(out.products.map((p) => [p.name, p.kind, p.targets])).toEqual([['Merit 2F', 'insecticide', ['scale', 'whitefly']], ['Palm Gro 8-2-12', 'fertilizer', []]]);
    // The unreviewed flagged findings only: the hidden pest finding is gone, and
    // the Seen watch items (tech-facing storage only) never enter.
    expect(out.findings).toEqual([
      { label: 'leaf spot signals', confidence: 'low', source: 'photo' },
      { label: 'off-color leaves', confidence: 'low', source: 'photo' },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/conk|400 sq|ignored/i);
    expect(out.facts.headline).toBe('Healthy — monitoring pest pressure');
    expect(out.knownProductNames).toEqual(['Merit 2F', 'Celsius WG']);
    expect(out.prior).toBeNull();
  });

  test('the last completed visit at this property supplies its products, never its watch items', async () => {
    const last = {
      id: 'sr-last', service_date: '2026-08-12',
      structured_notes: { treeShrubWatchItems: [{ key: 'whitefly', state: 'seen' }, { key: 'declining_palms', state: 'seen' }] },
    };
    const { knex } = fakeKnex({ last, lastProducts: [{ product_name: 'Safari 20 SG' }, { product_name: null }] });
    const out = await gatherTreeShrubTechParagraphInputs({ record: RECORD, data: { reportV2: REPORT }, knex });
    expect(out.prior).toMatchObject({ date: '2026-08-12', watched: [] });
    expect(out.prior.products.map((p) => p.name)).toEqual(['Safari 20 SG']);
  });

  test('an unresolved property gives no prior visit and reads no earlier record', async () => {
    const { knex, calls } = fakeKnex({ property: { property_id: null } });
    const out = await gatherTreeShrubTechParagraphInputs({ record: RECORD, data: { reportV2: REPORT }, knex });
    expect(out.prior).toBeNull();
    expect(calls.some((t) => String(t).startsWith('service_records'))).toBe(false);
  });

  test('no report build, or no record, means no inputs; a failed read propagates (the step stores nothing)', async () => {
    const { knex } = fakeKnex();
    expect(await gatherTreeShrubTechParagraphInputs({ record: RECORD, data: { reportV2: null }, knex })).toBeNull();
    expect(await gatherTreeShrubTechParagraphInputs({ record: null, data: { reportV2: REPORT }, knex })).toBeNull();
    const failing = () => { throw new Error('db down'); };
    await expect(gatherTreeShrubTechParagraphInputs({ record: RECORD, data: { reportV2: REPORT }, knex: failing })).rejects.toThrow('db down');
  });
});
