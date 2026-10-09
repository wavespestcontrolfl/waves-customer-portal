// GATE_LAWN_REPORT_FACTS through the REAL write-gate entry point (finalizeLawnReportSynthesis) with a confirmed
// assessment and its run in the store. The store HONORS COLUMN LISTS (first(...cols) returns only those columns),
// so a read that forgets a column the verification needs (the run's severities) fails here as it would in
// production. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(),
  ensureReportToken: jest.fn(async () => 'c'.repeat(32)),
}));
// The report build itself is not under test; everything the facts freeze reads is REAL (report-data's catalog
// enrichment and assessment loader).
jest.mock('../services/service-report/report-data', () => ({
  ...jest.requireActual('../services/service-report/report-data'),
  buildReportV1Data: jest.fn(async () => ({ lawnAssessment: null, reportV2: null })),
}));

const { loadServiceRecordForPdf } = require('../services/service-report/pdf-queue');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');
const facts = require('../services/service-report/lawn-report-facts');

const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P_FUNG = UUID(3);
const P_ARENA = UUID(4);
const P_CATERPILLAR = UUID(5);

// The confirmed assessment and its run as the store really holds them: the run carries `severities`, the
// assessment row carries no per-photo reads (a run-backed assessment).
const ASSESSMENT = {
  id: 'as-1', customer_id: 'c-1', service_record_id: 'sr-1', confirmed_by_tech: true,
  confirmed_at: '2026-10-08T15:00:00Z', created_at: '2026-10-08T14:00:00Z', composite_scores: null,
};
const runWith = (severities) => ({
  assessment_id: 'as-1', customer_id: 'c-1', reviewed_at: '2026-10-08T15:01:00Z',
  reviewed_findings: JSON.stringify([]), added_details: JSON.stringify([]),
  severities: JSON.stringify(severities), scores_raw: JSON.stringify({}),
});
const catalog = (n, category, extra = {}) => ({
  id: UUID(n), name: `Catalog ${n}`, category, epa_reg_number: '12345-67', approved_for_service_report: true,
  rei_hours: 0, reentry_summary: 'Keep people and pets off treated areas until dry.', ...extra,
});
const CATALOG = [catalog(3, 'fungicide'), catalog(4, 'insecticide'), catalog(5, 'insecticide')];
const STAGED = [
  { product_id: P_FUNG, role: 'fungicide_spot', gates: { trigger: 'mapped_large_patch' } },
  { product_id: P_ARENA, role: 'insecticide_spot', gates: { trigger: 'chinch_20_to_25_per_sqft' } },
  { product_id: P_CATERPILLAR, role: 'insecticide_spot', gates: { trigger: 'caterpillars' } },
];
const productRow = (n, id) => ({
  id: `sp-${id}`, service_record_id: 'sr-1', product_id: UUID(n), product_name: `Catalog ${n}`,
  application_method: 'spot_treatment', area_value: 100, area_unit: 'sqft', created_at: `2026-10-08T15:0${id}:00Z`,
});

// A store that honors column lists and records the service_records freeze.
function store(tables, down = new Set()) {
  const state = { notes: {} };
  const knex = (table) => {
    const base = String(table).split(' as ')[0];
    if (down.has(base)) {
      const dead = { where: () => dead, whereIn: () => dead, whereRaw: () => dead, orderBy: () => dead, select: () => dead, first: () => Promise.reject(new Error('down')), catch: (fn) => Promise.resolve(fn(new Error('down'))), then: (r, j) => Promise.reject(new Error('down')).then(r, j) };
      return dead;
    }
    let rows = [...(tables[base] || [])];
    const project = (row, cols) => (!row || !cols.length ? row : Object.fromEntries(cols.map((c) => [c.split(' as ').pop().split('.').pop(), row[c.split(' as ')[0].split('.').pop()]])));
    const q = {};
    q.where = (criteria) => {
      if (criteria && typeof criteria === 'object') rows = rows.filter((row) => Object.entries(criteria).every(([k, v]) => row[k] === v));
      return q;
    };
    q.whereIn = (key, values) => { const col = key.split('.').pop(); rows = rows.filter((row) => values.includes(row[col])); return q; };
    q.whereRaw = () => q;
    q.orderBy = () => q;
    q.select = (...cols) => { rows = rows.map((row) => project(row, cols)); return q; };
    q.first = (...cols) => Promise.resolve(base === 'service_records'
      ? { structured_notes: JSON.stringify(state.notes) }
      : project(rows[0] || null, cols.flat()));
    q.update = async ({ structured_notes: raw }) => {
      if (state.notes.lawnReportFacts) return 0;
      Object.assign(state.notes, JSON.parse(raw.bindings[0]));
      return 1;
    };
    q.catch = () => Promise.resolve(rows);
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  };
  knex.raw = (sql, bindings) => ({ sql, bindings });
  return { knex, state };
}

const GATES = ['GATE_LAWN_REPORT_FACTS', 'GATE_LAWN_VISIT_SUMMARY_V2', 'GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD'];
const live = () => { for (const name of GATES) process.env[name] = 'true'; };
afterEach(() => { for (const name of GATES) delete process.env[name]; jest.clearAllMocks(); });

// Complete a visit: the technician's recorded guide echo is in structured_notes, the products are applied, the
// confirmed assessment and its run are in the store. Returns what the freeze stored.
async function complete({ cards, productRows, severities, assessment = ASSESSMENT, withRun = true }) {
  const notes = { lawnTreatmentGuide: { v: 1, cards } };
  loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', structured_notes: JSON.stringify(notes) });
  const { knex, state } = store({
    service_products: productRows,
    products_catalog: CATALOG,
    lawn_assessments: assessment ? [assessment] : [],
    lawn_assessment_runs: withRun ? [runWith(severities)] : [],
    lawn_protocol_products: STAGED,
  });
  const out = await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
  const block = state.notes.lawnReportFacts;
  return { out, block, techTies: block && block.ties ? block.ties.items.filter((t) => t.source === 'technician') : null };
}
const card = (kind, productId, extra = {}) => ({ kind, shown: true, checked: 'found', taken: true, productIds: [productId], ...extra });

describe('a technician fungus or caterpillar find, through the real write gate', () => {
  test('the gate reads the run\'s severities: a fungus card with a moderate fungal read becomes a customer tie', async () => {
    live();
    const { techTies, out } = await complete({ cards: [card('fungus', P_FUNG)], productRows: [productRow(3, 1)], severities: { fungal_activity: { level: 'moderate' } } });
    expect(techTies).toEqual([{ source: 'technician', kind: 'fungus', product: 'fungicide' }]);
    expect(out.reportFactsFreeze.ties.items).toEqual(techTies);
  });

  test('a caterpillar card with severe insect damage becomes a tie', async () => {
    live();
    const { techTies } = await complete({ cards: [card('caterpillars', P_CATERPILLAR)], productRows: [productRow(5, 1)], severities: { insect_damage: { level: 'severe' } } });
    expect(techTies).toEqual([{ source: 'technician', kind: 'caterpillars', product: 'insecticide' }]);
  });

  test('the same cards with NO matching read in the run still fail closed (the check is real, not skipped)', async () => {
    live();
    expect((await complete({ cards: [card('fungus', P_FUNG)], productRows: [productRow(3, 1)], severities: { fungal_activity: { level: 'none' } } })).techTies).toEqual([]);
    expect((await complete({ cards: [card('caterpillars', P_CATERPILLAR)], productRows: [productRow(5, 1)], severities: { insect_damage: { level: 'minor' } } })).techTies).toEqual([]);
  });

  test('no run at all, or an unconfirmed assessment, fails closed for these two kinds; the standing chinch tap needs neither', async () => {
    live();
    expect((await complete({ cards: [card('fungus', P_FUNG)], productRows: [productRow(3, 1)], withRun: false })).techTies).toEqual([]);
    expect((await complete({ cards: [card('fungus', P_FUNG)], productRows: [productRow(3, 1)], severities: { fungal_activity: { level: 'moderate' } }, assessment: { ...ASSESSMENT, confirmed_by_tech: false } })).techTies).toEqual([]);
    expect((await complete({ cards: [card('chinch', P_ARENA)], productRows: [productRow(4, 1)], assessment: null, withRun: false })).techTies)
      .toEqual([{ source: 'technician', kind: 'chinch', product: 'insecticide' }]);
  });

  test('the run read selects the severities the verification needs', async () => {
    live();
    // The store projects columns: this is the regression check for a read that omits them.
    const { techTies } = await complete({ cards: [card('fungus', P_FUNG)], productRows: [productRow(3, 1)], severities: { fungal_activity: { level: 'minor' } } });
    expect(techTies).toHaveLength(1);
  });

  test('the tie part not live: nothing of this is read or stored', async () => {
    process.env.GATE_LAWN_REPORT_FACTS = 'true';
    const { block } = await complete({ cards: [card('fungus', P_FUNG)], productRows: [productRow(3, 1)], severities: { fungal_activity: { level: 'moderate' } } });
    expect(block).not.toHaveProperty('ties');
    expect(facts.frozenTies(JSON.stringify({ lawnReportFacts: block }), 'as-1')).toEqual([]);
  });
});

describe('a failed early freeze followed by a succeeding later call (the real entry points, in the completion order)', () => {
  const { freezeReportFactsOnly } = require('../services/service-report/lawn-report-write-gate');
  const tablesFor = () => ({
    service_products: [productRow(3, 1)],
    products_catalog: CATALOG,
    lawn_assessments: [ASSESSMENT],
    lawn_assessment_runs: [runWith({ fungal_activity: { level: 'moderate' } })],
    lawn_protocol_products: STAGED,
  });
  const notesWith = (state, extra = {}) => JSON.stringify({ ...extra, ...state.notes });

  test('the early attempt fails on a read: a marker is recorded; the later synthesis call finds it and freezes nothing different', async () => {
    live();
    const guide = { lawnTreatmentGuide: { v: 1, cards: [card('fungus', P_FUNG)] } };
    const down = new Set(['lawn_assessment_runs']);
    const { knex, state } = store(tablesFor(), down);
    loadServiceRecordForPdf.mockImplementation(async () => ({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', structured_notes: notesWith(state, guide) }));

    const early = await freezeReportFactsOnly({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
    expect(early).toMatchObject({ v: 1, failed: true });
    expect(state.notes.lawnReportFacts).toMatchObject({ failed: true });

    // The read recovers before the write gate runs; its own facts attempt must not now freeze a tie.
    down.clear();
    const out = await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
    expect(state.notes.lawnReportFacts).toMatchObject({ failed: true });
    expect(state.notes.lawnReportFacts).not.toHaveProperty('ties');
    expect(state.notes.lawnReportFacts).not.toHaveProperty('reentry');
    expect(out.reportFactsFreeze).toBeUndefined();
    expect(facts.frozenTies(JSON.stringify(state.notes), 'as-1')).toEqual([]);
  });

  test('a failed verification read fails the whole attempt the same way', async () => {
    live();
    const guide = { lawnTreatmentGuide: { v: 1, cards: [card('fungus', P_FUNG)] } };
    const { knex, state } = store(tablesFor(), new Set(['lawn_protocol_products']));
    loadServiceRecordForPdf.mockImplementation(async () => ({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', structured_notes: notesWith(state, guide) }));
    await freezeReportFactsOnly({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
    expect(state.notes.lawnReportFacts).toMatchObject({ failed: true });
    expect(state.notes.lawnReportFacts).not.toHaveProperty('ties');
  });

  test('a healthy early attempt freezes the facts once; the later call is a no-op', async () => {
    live();
    const guide = { lawnTreatmentGuide: { v: 1, cards: [card('fungus', P_FUNG)] } };
    const { knex, state } = store(tablesFor());
    loadServiceRecordForPdf.mockImplementation(async () => ({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', structured_notes: notesWith(state, guide) }));
    const early = await freezeReportFactsOnly({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
    expect(early.ties.items).toEqual([{ source: 'technician', kind: 'fungus', product: 'fungicide' }]);
    const before = JSON.stringify(state.notes.lawnReportFacts);
    const out = await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
    expect(JSON.stringify(state.notes.lawnReportFacts)).toBe(before);
    expect(out.reportFactsFreeze).toBeUndefined();
  });
});

describe('GATE_LAWN_REPORT_POLISH: the one-label-line decision rides the same freeze (the real write gate)', () => {
  const SPRAY_CATALOG = [{
    ...catalog(6, 'fungicide'),
    reentry_summary: 'Stay off treated areas until the application has dried.',
    customer_precaution_summary: 'Per the product label: keep people and pets off treated areas until sprays have dried.',
  }];
  const sprayRow = { ...productRow(6, 1), application_method: 'broadcast_spray' };
  async function completeSpray() {
    loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', structured_notes: '{}' });
    const { knex, state } = store({ service_products: [sprayRow], products_catalog: SPRAY_CATALOG, lawn_assessments: [], lawn_assessment_runs: [], lawn_protocol_products: [] });
    await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
    return state.notes.lawnReportFacts;
  }

  test('gate live: the block carries labelLines, and the card drops the duplicate precaution', async () => {
    live();
    process.env.GATE_LAWN_REPORT_POLISH = 'true';
    const block = await completeSpray();
    delete process.env.GATE_LAWN_REPORT_POLISH;
    expect(block.labelLines).toEqual({ v: 1, items: { 'sp-1': [0] } });
    const drops = facts.frozenLabelDropsFor('lawn', JSON.stringify({ lawnReportFacts: block }));
    expect(facts.precautionForCard(drops, { id: 'sp-1' }, SPRAY_CATALOG[0].customer_precaution_summary)).toBeNull();
  });

  test('polish live but the facts gate dark: nothing is frozen at all (the dependency is on the facts gate)', async () => {
    process.env.GATE_LAWN_REPORT_POLISH = 'true';
    delete process.env.GATE_LAWN_REPORT_FACTS;
    loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', structured_notes: '{}' });
    const { knex, state } = store({ service_products: [sprayRow], products_catalog: SPRAY_CATALOG, lawn_assessments: [], lawn_assessment_runs: [], lawn_protocol_products: [] });
    await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
    delete process.env.GATE_LAWN_REPORT_POLISH;
    expect(state.notes.lawnReportFacts).toBeUndefined();
  });

  describe('the longer-cycles decision rides the same freeze', () => {
    const PREFS = (extra) => ({ customer_id: 'c-1', irrigation_system: true, watering_days: ['Mon', 'Wed', 'Fri', 'Sat'], sod_laid_on: null, sod_covers: null, sod_area: null, sod_rooted_on: null, ...extra });
    async function complete(prefsRows) {
      loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', service_date: '2026-10-08', structured_notes: '{}' });
      const { knex, state } = store({ service_products: [sprayRow], products_catalog: SPRAY_CATALOG, lawn_assessments: [], lawn_assessment_runs: [], lawn_protocol_products: [], property_preferences: prefsRows });
      await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
      return state.notes.lawnReportFacts;
    }
    const withPolish = async (prefsRows) => {
      live();
      process.env.GATE_LAWN_REPORT_POLISH = 'true';
      try { return await complete(prefsRows); } finally { delete process.env.GATE_LAWN_REPORT_POLISH; }
    };

    test('4 watering days and no new sod: frozen true, and the render helper reads it', async () => {
      const block = await withPolish([PREFS()]);
      expect(block.waterAdvice).toEqual({ v: 1, longerCycles: true });
      expect(facts.frozenLongerCycles('lawn', JSON.stringify({ lawnReportFacts: block }))).toBe(true);
      expect(facts.frozenLongerCycles('pest', JSON.stringify({ lawnReportFacts: block }))).toBe(false);
    });

    test('2 watering days, a new-sod record, no prefs row: frozen false', async () => {
      expect((await withPolish([PREFS({ watering_days: ['Mon', 'Thu'] })])).waterAdvice).toEqual({ v: 1, longerCycles: false });
      expect((await withPolish([PREFS({ sod_laid_on: '2026-09-28', sod_covers: 'whole' })])).waterAdvice).toEqual({ v: 1, longerCycles: false });
      expect((await withPolish([])).waterAdvice).toEqual({ v: 1, longerCycles: false });
    });

    test('a productless lawn visit with 4 watering days freezes a block that carries only the water advice, valid for every reader', async () => {
      live();
      process.env.GATE_LAWN_REPORT_POLISH = 'true';
      let block;
      try {
        loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', service_date: '2026-10-08', structured_notes: '{}' });
        const { knex, state } = store({ service_products: [], products_catalog: [], lawn_assessments: [], lawn_assessment_runs: [], lawn_protocol_products: [], property_preferences: [PREFS()] });
        const out = await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
        block = state.notes.lawnReportFacts;
        expect(out.reportFactsFreeze).toMatchObject({ v: 1, waterAdvice: { v: 1, longerCycles: true } });
      } finally { delete process.env.GATE_LAWN_REPORT_POLISH; }
      expect(block).toMatchObject({ v: 1, productUse: {}, waterAdvice: { v: 1, longerCycles: true } });
      ['reentry', 'ties', 'failed'].forEach((key) => expect(block).not.toHaveProperty(key));
      expect(block.labelLines).toEqual({ v: 1, items: {} });
      const notes = JSON.stringify({ lawnReportFacts: block });
      expect(facts.frozenLongerCycles('lawn', notes)).toBe(true);
      // every other reader tolerates it: no re-entry rule, no spot text, no label drop, no tie, a PDF key that follows it
      expect(facts.frozenReentryText({ structured_notes: notes })).toBeNull();
      expect(facts.frozenUseTextsFor('lawn', notes)).toEqual({});
      expect(facts.frozenLabelDropsFor('lawn', notes)).toEqual({});
      expect(facts.frozenTies(notes, 'as-1')).toEqual([]);
      expect(facts.frozenReportFactsStamp(notes)).toMatch(/^:rf=/);
    });

    test('productless with 2 watering days freezes false; with the polish gate dark it freezes nothing (a later attempt may)', async () => {
      live();
      loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', service_date: '2026-10-08', structured_notes: '{}' });
      const run = async (days, polish) => {
        if (polish) process.env.GATE_LAWN_REPORT_POLISH = 'true';
        try {
          const { knex, state } = store({ service_products: [], products_catalog: [], lawn_assessments: [], lawn_assessment_runs: [], lawn_protocol_products: [], property_preferences: [PREFS({ watering_days: days })] });
          await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
          return state.notes.lawnReportFacts;
        } finally { delete process.env.GATE_LAWN_REPORT_POLISH; }
      };
      expect((await run(['Mon', 'Thu'], true)).waterAdvice).toEqual({ v: 1, longerCycles: false });
      expect(await run(['Mon', 'Tue', 'Wed', 'Thu'], false)).toBeUndefined();
    });

    test('productless: first writer wins, and a failed read of the visit still records the failed marker', async () => {
      live();
      process.env.GATE_LAWN_REPORT_POLISH = 'true';
      try {
        loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', service_date: '2026-10-08', structured_notes: '{}' });
        const tables = { service_products: [], products_catalog: [], lawn_assessments: [], lawn_assessment_runs: [], lawn_protocol_products: [], property_preferences: [PREFS()] };
        const { knex, state } = store(tables);
        await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
        const first = JSON.stringify(state.notes.lawnReportFacts);
        // prefs change afterwards; the second run must not rewrite the decision
        tables.property_preferences[0].watering_days = ['Mon'];
        loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', service_date: '2026-10-08', structured_notes: JSON.stringify(state.notes) });
        await finalizeLawnReportSynthesis({ service: { id: 'sr-1', service_line: 'lawn' }, knex });
        expect(JSON.stringify(state.notes.lawnReportFacts)).toBe(first);

        loadServiceRecordForPdf.mockResolvedValue({ id: 'sr-1', customer_id: 'c-1', service_line: 'lawn', service_date: '2026-10-08', structured_notes: '{}' });
        const down = store(tables, new Set(['service_products']));
        const early = await require('../services/service-report/lawn-report-write-gate').freezeReportFactsOnly({ service: { id: 'sr-1', service_line: 'lawn' }, knex: down.knex });
        expect(early).toMatchObject({ v: 1, failed: true });
        expect(early).not.toHaveProperty('waterAdvice');
      } finally { delete process.env.GATE_LAWN_REPORT_POLISH; }
    });

    test('after an address change the former home\'s schedule freezes false until the customer confirms a new one', async () => {
      const moved = { irrigation_home_changed_at: '2026-09-20T12:00:00Z', irrigation_run_minutes: 30, irrigation_system_type: ['rotor'] };
      const confirmed = JSON.stringify(['irrigation_run_minutes', 'watering_days', 'irrigation_system_type']);
      expect((await withPolish([PREFS({ ...moved, irrigation_confirmed_fields: '[]' })])).waterAdvice).toEqual({ v: 1, longerCycles: false });
      expect((await withPolish([PREFS({ ...moved, irrigation_confirmed_fields: confirmed })])).waterAdvice).toEqual({ v: 1, longerCycles: true });
      // no move on file: the schedule stands as before
      expect((await withPolish([PREFS({ irrigation_run_minutes: 30, irrigation_system_type: ['rotor'] })])).waterAdvice).toEqual({ v: 1, longerCycles: true });
    });

    test('polish gate dark: no waterAdvice key, so a record renders exactly as before', async () => {
      live();
      const block = await complete([PREFS()]);
      expect(block).not.toHaveProperty('waterAdvice');
      expect(facts.frozenLongerCycles('lawn', JSON.stringify({ lawnReportFacts: block }))).toBe(false);
    });

    test('a hand-edited block prints nothing it was not built from', () => {
      const notes = (waterAdvice) => JSON.stringify({ lawnReportFacts: { v: 1, frozenAt: 'x', productUse: {}, waterAdvice } });
      expect(facts.frozenLongerCycles('lawn', notes({ v: 1, longerCycles: true }))).toBe(true);
      [{ v: 2, longerCycles: true }, { v: 1, longerCycles: 'true' }, { v: 1 }, 'yes', null].forEach((bad) => expect(facts.frozenLongerCycles('lawn', notes(bad))).toBe(false));
    });

    test('the PDF key moves only for a record that prints the line', async () => {
      const yes = await withPolish([PREFS()]);
      const no = await withPolish([PREFS({ watering_days: ['Mon'] })]);
      const stamp = (block) => facts.frozenReportFactsStamp(JSON.stringify({ lawnReportFacts: block }));
      expect(stamp(yes)).not.toBe(stamp(no));
    });
  });

  test('gate off: no labelLines key, so a record renders exactly as before', async () => {
    live();
    const block = await completeSpray();
    expect(block).not.toHaveProperty('labelLines');
    expect(facts.frozenLabelDropsFor('lawn', JSON.stringify({ lawnReportFacts: block }))).toEqual({});
  });
});
