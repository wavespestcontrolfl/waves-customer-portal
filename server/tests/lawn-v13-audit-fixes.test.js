// Lawn protocol v13 audit fixes (owner 2026-10-06, "I approve all changes"; evidence:
// the Fable premise audit of 2026-10-06). The recipe text, the plan's gate notes, and
// migration 20261007140000. The migration suite is DB-backed (self-skips without
// DATABASE_URL, like the other Postgres suites) and runs against an owned schema.
//
// Pins: the bahia track is gone and a bahia lawn never borrows another grass's program;
// Arena, Celsius, Certainty, Blindside and the atrazine bag carry their yearly caps;
// every fertilizer visit carries the ordinance safety block; North Port skips the summer
// Nutra-TECH passes; Dismiss is out of the recipe lines; the February atrazine option is
// St. Augustine only with its label rules; the same-group rule no longer contradicts the
// program; the Acelepryn caterpillar line carries the 24-hour hold.
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const v13 = require('../config/lawn-protocol-v13.json');
const engine = require('../services/waveguard-plan-engine');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const migration = require('../models/migrations/20261007140000_lawn_v13_audit_fixes');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const V13_GRASSES = Object.keys(v13);
const lines = (text) => String(text || '').split('\n').filter(Boolean);
const visitFor = (grass, month) => v13[grass].visits.find((v) => v.month === month);
const everyTrack = (fn) => { for (const grass of V13_GRASSES) fn(v13[grass], grass); };

describe('the recipe text', () => {
  test('no bahia track', () => {
    expect(V13_GRASSES).toEqual(['st_augustine', 'bermuda', 'zoysia']);
  });

  test('Dismiss leaves every recipe line; the note says use up the jug and do not reorder; Certainty carries sedges', () => {
    everyTrack((track) => {
      for (const visit of track.visits) expect(`${visit.primary}\n${visit.secondary}`).not.toMatch(/dismiss/i);
      const text = [...track.notes, ...track.safety_rules].join('\n');
      expect(text).toContain('Dismiss: use up the jug on green kyllinga under 85°F; do not reorder.');
      expect(text).toContain('Certainty also carries sedges.');
      expect(text).not.toMatch(/November to March/);
    });
  });

  test('Arena: up to 2 applications per lawn per year, never the same area twice (notes and every Arena line)', () => {
    everyTrack((track) => {
      expect(track.notes.join('\n')).toContain('Arena: up to 2 applications per lawn per year, never the same area twice.');
      const arenaLines = track.visits.flatMap((visit) => lines(visit.secondary)).filter((line) => line.startsWith('Arena 50 WDG'));
      expect(arenaLines).toHaveLength(3); // April, May, June
      for (const line of arenaLines) expect(line).toContain('up to 2 applications per lawn per year, never the same area twice');
    });
  });

  test('Celsius + Certainty: 2 passes per spot per year', () => {
    everyTrack((track) => expect(track.notes.join('\n')).toContain('Celsius + Certainty: 2 passes per spot per year'));
  });

  test('every fertilizer visit carries the safety block; October rides on the track notes and rules', () => {
    for (const grass of V13_GRASSES) {
      for (const month of ['Feb', 'Apr', 'Nov', 'Dec']) expect(visitFor(grass, month).notes).toMatch(/Fertilizer safety: deflector on, 10 ft water band kept/);
      for (const text of [v13[grass].notes.join('\n'), v13[grass].safety_rules.join('\n')]) {
        for (const phrase of ['deflector shield', '10 ft fertilizer-free band', 'wetland, seawall or top of bank', 'severe thunderstorm, flood or tropical watch or warning', 'sweep fertilizer off driveways, sidewalks and streets', 'Manatee BMP decal']) {
          expect(text).toContain(phrase);
        }
      }
      // Months with no N carry no safety line, and the N targets still parse.
      for (const month of ['Jan', 'Mar', 'May', 'Jun', 'Jul', 'Aug', 'Sep']) expect(visitFor(grass, month).notes).not.toMatch(/Fertilizer safety/);
      expect([2, 4, 11, 12].map((m) => engine.parseVisitNutrientTargets(visitFor(grass, MONTH_ABBR[m - 1]).notes).targetNPer1000)).toEqual([0.75, 0.5, 0.75, 0.5]);
    }
  });

  test('North Port: no Nutra-TECH June to September until the city confirms', () => {
    everyTrack((track) => {
      expect(track.notes.join('\n')).toMatch(/North Port: no Nutra-TECH hose passes from June through September until the city confirms/);
      expect(track.safety_rules.join('\n')).toMatch(/North Port: no Nutra-TECH June through September/);
      for (const visit of track.visits) {
        const hasNote = /North Port: skip Nutra-TECH on this visit until the city confirms/.test(visit.notes);
        expect({ month: visit.month, hasNote }).toEqual({ month: visit.month, hasNote: ['Jun', 'Aug', 'Sep'].includes(visit.month) });
      }
    });
  });

  test('the same-group rule applies to curative sequences on one target; pre-emergents are all Group 3 this season', () => {
    everyTrack((track) => {
      const text = [...track.notes, ...track.safety_rules].join('\n');
      expect(text).not.toContain('Never use the same chemical group twice in a row on one lawn');
      expect(text).not.toContain('Never repeat a chemical group on the next application');
      expect(text).toContain('Never use the same chemical group twice in a row on the same target.');
      expect(text).toContain('curative fungicide, insecticide and post-emergent');
      expect(text).toContain('Pre-emergents are all Group 3 this season (owner accepted 2026-10-06); a non-Group-3 option is under review for next season.');
    });
  });

  test('the Acelepryn caterpillar lines and the track note carry the 24-hour hold', () => {
    everyTrack((track) => {
      const acelepryn = track.visits.flatMap((visit) => lines(visit.secondary)).filter((line) => line.startsWith('Acelepryn Insecticide'));
      expect(acelepryn).toHaveLength(3); // July, August, September
      for (const line of acelepryn) expect(line).toContain('delay watering (irrigation) or mowing for 24 hours after application');
      expect(track.notes.join('\n')).toContain('Acelepryn on caterpillars: delay watering (irrigation) or mowing for 24 hours after application.');
    });
  });

  test('the February atrazine option: St. Augustine only, one line, the owner rule text, not the default bag', () => {
    const atrazine = lines(visitFor('st_augustine', 'Feb').secondary).filter((line) => line.startsWith(migration.NAMES.ATRAZINE));
    expect(atrazine).toHaveLength(1);
    const [line] = atrazine;
    for (const phrase of [
      '4.0 lb per 1,000 sq ft (0.72 lb N)',
      'Water in right after application (label: must be watered in immediately).',
      'Not on bermuda, zoysia or bahia.',
      'Not on wet or sandy lots with a high water table.',
      'Not within 200 ft of a lake or pond or 66 ft of a storm inlet until the bag label is read.',
      '2 applications a year at most and 2 months apart',
    ]) expect(line).toContain(phrase);
    // The default February bag and the other tracks are untouched.
    expect(lines(visitFor('st_augustine', 'Feb').primary)).toEqual(['LESCO 24-0-11 with PolyPlus OPTI — 3.1 lb per 1,000 sq ft (0.75 lb N), spreader']);
    for (const grass of ['bermuda', 'zoysia']) expect(JSON.stringify(v13[grass])).not.toMatch(/atrazine/i);
    // The plan engine reads it as a conditional line that matches the catalog row by its exact name.
    const [parsed] = engine.parseProtocolLines(line, 'conditional', { exactName: true });
    expect(parsed.conditional).toBe(true);
    expect(engine.matchCatalogProduct(parsed, [{ id: 'a', name: migration.NAMES.ATRAZINE, active: true }]).name).toBe(migration.NAMES.ATRAZINE);
  });
});

describe('what the plan tells the tech', () => {
  const noteKeys = (gates, context) => engine.v13GateNotes(gates, context).map((note) => note.key);

  test('the atrazine bag asks for St. Augustine: a required note on any other grass, none on St. Augustine', () => {
    const gates = { stAugustineOnly: true, avoidHighWaterTable: true, waterInNow: true, replacesDefaultBag: true, minDistanceFromWaterFt: 200 };
    const onBermuda = engine.v13GateNotes(gates, { grassType: 'bermuda' });
    expect(onBermuda.find((n) => n.key === 'stAugustineOnly')).toMatchObject({ severity: 'required', text: expect.stringContaining('Not on bermuda, zoysia, bahia or mixed lawns') });
    expect(noteKeys(gates, { grassType: 'mixed' })).toContain('stAugustineOnly');
    expect(noteKeys(gates, { grassType: null })).toContain('stAugustineOnly');
    expect(noteKeys(gates, { grassType: 'st_augustine' })).not.toContain('stAugustineOnly');
    expect(engine.v13GateNotes(gates, { grassType: 'st_augustine' }).map((n) => n.text)).toEqual(expect.arrayContaining([
      'Not on wet or sandy lots with a high water table.',
      'Keep 200 ft from ponds, lakes and canals; skip that strip.',
      expect.stringContaining('must be watered in immediately'),
      expect.stringContaining('Instead of the 24-0-11'),
    ]));
  });

  test('fertilizerSafety is a required note; Arena and Acelepryn notes read as the label rules', () => {
    expect(engine.v13GateNotes({ fertilizerSafety: true })[0]).toMatchObject({ key: 'fertilizerSafety', severity: 'required' });
    expect(engine.v13GateNotes({ fertilizerSafety: true })[0].text).toMatch(/deflector shield.*10 ft fertilizer-free band.*Manatee BMP decal/);
    expect(engine.v13GateNotes({ oncePerAreaPerYear: true })[0].text).toBe('Up to 2 applications per lawn per year; never the same area twice in a year.');
    expect(engine.v13GateNotes({ delayWateringHours: 24, delayMowingHours: 24 }).map((n) => n.text)).toEqual(['Delay watering for 24 hours.', 'Delay mowing for 24 hours.']);
  });

  test('the North Port gate on a Nutra-TECH row asks only in North Port', () => {
    expect(noteKeys({ northPortBlocked: true }, { municipality: 'North Port' })).toEqual(['northPortBlocked']);
    expect(noteKeys({ northPortBlocked: true }, { municipality: 'Bradenton' })).toEqual([]);
  });

  test('a wholeLawn row is sized on the whole lawn although its line reads as a weed-spot product', () => {
    const [line] = engine.parseProtocolLines(lines(visitFor('st_augustine', 'Feb').secondary).find((l) => l.startsWith(migration.NAMES.ATRAZINE)), 'conditional', { exactName: true });
    expect(line.scope).toBe('SPOT_ALLOWANCE');
    expect(engine.effectiveAreaFactor(line, {})).toBe(0.25);
    expect(engine.effectiveAreaFactor(engine.v13AreaLine(line, { gates: { wholeLawn: true } }), {})).toBe(1);
    // The other row flags are unchanged: sunnyTurfOnly narrows a whole-lawn line, no flag leaves the line alone.
    const [tetrino] = engine.parseProtocolLines(visitFor('st_augustine', 'May').primary, 'base', { exactName: true });
    expect(engine.v13AreaLine(tetrino, { gates: { sunnyTurfOnly: true } })).toMatchObject({ sunnyTurfOnly: true });
    expect(engine.v13AreaLine(tetrino, { gates: {} })).toBe(tetrino);
    expect(engine.v13AreaLine(tetrino, null)).toBe(tetrino);
  });
});

describe('the atrazine bag catalog values', () => {
  const p = migration.ATRAZINE_PRODUCT;

  test('label numbers: 3.27 to 4.37 lb per 1,000 sq ft, 4.0 chosen = 0.72 lb N and 1.83 lb ai per acre; 2 applications = 8.74 lb', () => {
    expect(p).toMatchObject({ epa_reg_number: '10404-94', siteone_sku: '702202', rate_unit: 'lb', min_label_rate_per_1000: 3.27, max_label_rate_per_1000: 4.37, default_rate_per_1000: 4 });
    expect((p.default_rate_per_1000 * p.analysis_n) / 100).toBeCloseTo(0.72, 2);
    expect(p.default_rate_per_1000 * (p.ai_pct / 100) * 43.56).toBeCloseTo(1.83, 2);
    expect(p.max_annual_per_1000).toBeCloseTo(2 * p.max_label_rate_per_1000, 2);
    expect(p.max_label_rate_per_1000 * (p.ai_pct / 100) * 43.56 * 2).toBeLessThan(4); // the label's 4 lb ai per acre per year
    expect(p.cost_per_unit).toBeCloseTo(36.14 / 50, 3);
    expect(JSON.parse(p.labeled_turf_species)).toEqual(['st_augustine', 'centipede']);
    expect(JSON.parse(p.excluded_turf_species)).toEqual(expect.arrayContaining(['bermuda', 'zoysia', 'bahia']));
  });

  test('the watering rule is valid and reads as an immediate water-in', () => {
    const checked = validateRule(migration.ATRAZINE_WATERING);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'water_in', source: 'label', water_in_by_hours: 1 });
    expect(migration.ATRAZINE_WATERING.label_note).toMatch(/watered in immediately/);
    // The customer line: water in the same day, an hour after the visit.
    const instruction = buildWateringInstruction({ rules: [{ name: migration.NAMES.ATRAZINE, rule: migration.ATRAZINE_WATERING }], completedAt: new Date('2026-02-12T15:00:00-05:00') });
    expect(instruction).toMatchObject({ state: 'water_in', waterInInches: 0.25, ruleSource: 'label' });
    expect(instruction.lines[0]).toMatch(/^Water in today.s treatment by 4 PM today\.$/);
  });
});

// ── The migration, against Postgres ─────────────────────────────────────────
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const N = migration.NAMES;
const TABLES = ['products_catalog', 'product_aliases', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_gates',
  'lawn_protocol_audit_log', 'lawn_protocol_product_actuals', 'product_limits', 'audit_log'];

describeDb('migration 20261007140000 (owned schema)', () => {
  let knex;
  let schema;
  let catalog;

  beforeEach(async () => {
    schema = `v13_audit_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    // The recipe's products by exact catalog name, Celsius with its seeded caps, then the staged protocols.
    catalog = {};
    for (const name of [...Object.values(staged.NAMES), 'Blindside Herbicide']) {
      const [row] = await knex('products_catalog').insert({ id: randomUUID(), name, active: true, category: 'herbicide' }).returning(['id', 'name']);
      catalog[name] = row.id;
    }
    await knex('product_limits').insert([
      { product_id: catalog['Celsius WG'], match_type: 'product', limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block', description: 'Celsius WG: max 3 applications per year per property. Exceeding voids warranty and risks turf damage.' },
      { product_id: catalog['Celsius WG'], match_type: 'product', limit_type: 'annual_max_rate', limit_value: 0.171, limit_unit: 'oz/1000sf/year', severity: 'hard_block', description: 'Celsius rate' },
    ]);
    for (const t of staged.TRACKS) {
      await knex('lawn_protocols').insert({ protocol_key: t.key, version: '2026.06', name: 'Old', status: 'active', grass_track: t.track, region: 'swfl' });
    }
    await staged.up(knex);
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const v13Protocols = () => knex('lawn_protocols').where({ version: staged.V13_VERSION }).select('id', 'grass_track');
  const rowsOf = (protocolId) => knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where('w.lawn_protocol_id', protocolId)
    .select('p.*', 'w.window_key', 'w.required_tasks');
  const limitsFor = async (name) => knex('product_limits').where({ product_id: catalog[name] }).select('limit_type', 'limit_value', 'severity');
  const snapshot = async () => ({
    products: (await knex('lawn_protocol_products').select('id', 'gates').orderBy('id')).map((r) => [r.id, r.gates]),
    windows: (await knex('lawn_protocol_windows').select('id', 'required_tasks').orderBy('id')).map((r) => [r.id, r.required_tasks]),
    limits: (await knex('product_limits').select('id', 'limit_value', 'description').orderBy('id')),
    audit: (await knex('lawn_protocol_audit_log').count('* as n').first()).n,
  });

  test('yearly caps: Arena, Certainty, Blindside and the atrazine bag at 2 (atrazine 60 days apart); Celsius 3 becomes 2; Blindside drops bahia', async () => {
    await migration.up(knex);
    for (const name of [N.ARENA, N.CERTAINTY, 'Blindside Herbicide']) {
      expect(await limitsFor(name)).toEqual([expect.objectContaining({ limit_type: 'annual_max_apps', limit_value: '2.0000', severity: 'hard_block' })]);
    }
    expect(await limitsFor('Celsius WG')).toEqual(expect.arrayContaining([
      expect.objectContaining({ limit_type: 'annual_max_apps', limit_value: '2.0000' }),
      expect.objectContaining({ limit_type: 'annual_max_rate', limit_value: '0.1710' }),
    ]));
    const atrazineId = (await knex('products_catalog').where({ name: N.ATRAZINE }).first()).id;
    expect((await knex('product_limits').where({ product_id: atrazineId }).select('limit_type', 'limit_value', 'severity')).sort((a, b) => a.limit_type.localeCompare(b.limit_type))).toEqual([
      expect.objectContaining({ limit_type: 'annual_max_apps', limit_value: '2.0000', severity: 'hard_block' }),
      expect.objectContaining({ limit_type: 'min_interval_days', limit_value: '60.0000', severity: 'hard_block' }),
    ]);
    const blindside = await knex('products_catalog').where({ name: 'Blindside Herbicide' }).first();
    expect(blindside.excluded_turf_species).toEqual(['bahia', 'seashore_paspalum']);
  });

  test('the atrazine catalog row carries the label values and the immediate water-in rule', async () => {
    await migration.up(knex);
    const row = await knex('products_catalog').where({ name: N.ATRAZINE }).first();
    expect(row).toMatchObject({ epa_reg_number: '10404-94', siteone_sku: '702202', category: 'herbicide', product_type: 'pesticide', formulation: 'granular', aquatic_buffer_ft: 200, reapplication_interval_days: 60 });
    expect(Number(row.default_rate_per_1000)).toBe(4);
    expect(row.excluded_turf_species).toEqual(expect.arrayContaining(['bermuda', 'zoysia', 'bahia']));
    expect(row.post_application_watering).toMatchObject({ mode: 'water_in', source: 'label' });
    expect(validateRule(row.post_application_watering).errors).toEqual([]);
  });

  test('the atrazine option is one non-default row in the St. Augustine February window only', async () => {
    await migration.up(knex);
    for (const protocol of await v13Protocols()) {
      const rows = (await rowsOf(protocol.id)).filter((r) => r.product_name === N.ATRAZINE);
      if (protocol.grass_track !== 'st_augustine') { expect(rows).toEqual([]); continue; }
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ window_key: 'feb_v13_spreader_green_up', default_in_plan: false, application_mode: 'broadcast', rate_unit: 'lb' });
      expect(Number(rows[0].rate_per_1000)).toBe(4);
      expect(rows[0].product_id).toBe((await knex('products_catalog').where({ name: N.ATRAZINE }).first()).id);
      expect(rows[0].gates).toMatchObject({ stAugustineOnly: true, wholeLawn: true, waterInNow: true, avoidHighWaterTable: true, minDistanceFromWaterFt: 200, replacesDefaultBag: true });
    }
  });

  test('gates: Arena once per area, Acelepryn 24-hour holds, Nutra-TECH North Port gate Jun/Aug/Sep only, fertilizer safety on the spreader rows only', async () => {
    await migration.up(knex);
    for (const protocol of await v13Protocols()) {
      for (const row of await rowsOf(protocol.id)) {
        const spreaderWindow = migration.FERTILIZER_WINDOWS.has(row.window_key);
        expect({ id: `${row.window_key}|${row.product_name}`, v: row.gates.oncePerAreaPerYear === true }).toEqual({ id: `${row.window_key}|${row.product_name}`, v: row.product_name === N.ARENA });
        expect({ id: `${row.window_key}|${row.product_name}`, v: row.gates.delayWateringHours === 24 && row.gates.delayMowingHours === 24 }).toEqual({ id: `${row.window_key}|${row.product_name}`, v: row.product_name === N.ACELEPRYN });
        if (row.product_name === N.NUTRA) expect({ w: row.window_key, v: row.gates.northPortBlocked === true }).toEqual({ w: row.window_key, v: migration.NORTH_PORT_WINDOWS.has(row.window_key) });
        const wholeLawnSpreader = spreaderWindow && row.default_in_plan === true;
        expect({ id: `${row.window_key}|${row.product_name}`, v: row.gates.fertilizerSafety === true }).toEqual({ id: `${row.window_key}|${row.product_name}`, v: wholeLawnSpreader || row.product_name === N.ATRAZINE });
      }
    }
  });

  test('the checklist line is on the five fertilizer windows, nowhere else', async () => {
    await migration.up(knex);
    const windows = await knex('lawn_protocol_windows').select('window_key', 'required_tasks');
    for (const window of windows) expect({ w: window.window_key, v: window.required_tasks.includes(migration.SAFETY_TASK) }).toEqual({ w: window.window_key, v: migration.FERTILIZER_WINDOWS.has(window.window_key) });
    // The windows' own earlier tasks are kept.
    expect(windows.find((w) => w.window_key === 'apr_v13_spreader_feeding').required_tasks).toEqual(['north_port_zero_np', migration.SAFETY_TASK]);
  });

  test('Dismiss rows leave the windows, except a row a completion already references', async () => {
    const protocols = await v13Protocols();
    const keep = (await rowsOf(protocols[0].id)).find((r) => r.product_name === N.DISMISS);
    await knex('lawn_protocol_product_actuals').insert({ lawn_protocol_service_completion_id: randomUUID(), protocol_product_id: keep.id, product_name: N.DISMISS });
    await migration.up(knex);
    const left = await knex('lawn_protocol_products').where({ product_name: N.DISMISS }).select('id');
    expect(left.map((r) => r.id)).toEqual([keep.id]);
  });

  test('re-running changes nothing', async () => {
    await migration.up(knex);
    const once = await snapshot();
    await migration.up(knex);
    expect(await snapshot()).toEqual(once);
  });

  test('down puts back the gates, the checklist line, the Dismiss rows, the limits and Celsius at 3; the catalog row stays', async () => {
    const before = await snapshot();
    const dismissBefore = (await knex('lawn_protocol_products').where({ product_name: N.DISMISS }).select('lawn_protocol_window_id', 'role', 'application_mode', 'gates', 'default_in_plan')).length;
    await migration.up(knex);
    await migration.down(knex);
    const after = await snapshot();
    expect(after.windows).toEqual(before.windows);
    expect(after.limits.map((r) => [r.id, r.limit_value, r.description])).toEqual(before.limits.map((r) => [r.id, r.limit_value, r.description]));
    expect(after.audit).toBe(before.audit);
    // Same product rows by value (the Dismiss rows come back with new ids).
    const gatesByKey = async () => (await knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id').select('p.product_name', 'w.window_key', 'p.gates', 'p.default_in_plan'))
      .map((r) => `${r.window_key}|${r.product_name}|${JSON.stringify(Object.entries(r.gates).sort())}|${r.default_in_plan}`).sort();
    expect(await gatesByKey()).toHaveLength(before.products.length);
    expect(await knex('lawn_protocol_products').where({ product_name: N.DISMISS })).toHaveLength(dismissBefore);
    expect(await knex('lawn_protocol_products').where({ product_name: N.ATRAZINE })).toHaveLength(0);
    expect(await knex('products_catalog').where({ name: N.ATRAZINE })).toHaveLength(1);
    const celsius = await knex('product_limits').where({ product_id: catalog['Celsius WG'], limit_type: 'annual_max_apps' }).first();
    expect(Number(celsius.limit_value)).toBe(3);
    // Up again after down lands in the same place.
    await migration.up(knex);
    expect((await knex('lawn_protocol_products').where({ product_name: N.ATRAZINE })).length).toBe(1);
  });
});
