// Lawn protocol v13 field rules (owner 2026-10-06): the recipe text, the gate notes,
// the North Port product hold and the completion flag. No database; the migration
// and the plan through PostgreSQL are in lawn-v13-field-rules.db.test.js.
// Synthetic data only.

const v13 = require('../config/lawn-protocol-v13.json');
const engine = require('../services/waveguard-plan-engine');
const { heldProductBlocks, freezeReportProductFacts } = require('../services/complete-scheduled-service');
const rules = require('../models/migrations/20261007150000_lawn_v13_field_rules');

const TRACKS = Object.keys(v13);
const visit = (grass, month) => v13[grass].visits.find((v) => v.month === month);
const everything = (grass) => JSON.stringify(v13[grass]);
const lines = (text) => String(text || '').split('\n').filter(Boolean);

describe('recipe text', () => {
  test.each(TRACKS)('%s: Dismiss is retired and the jug note replaces it', (grass) => {
    const track = v13[grass];
    for (const v of track.visits) expect({ month: v.month, dismiss: /dismiss/i.test(v.primary + v.secondary + v.notes) }).toEqual({ month: v.month, dismiss: false });
    const note = 'Dismiss: use up the jug on green kyllinga under 85°F; do not reorder.';
    expect(track.safety_rules).toContain(note);
    expect(track.notes.some((line) => line.endsWith(note))).toBe(true);
    expect(everything(grass)).not.toMatch(/November to March/);
  });

  test.each(TRACKS)('%s: the chemical group rule has two named exceptions and no target scoping', (grass) => {
    const track = v13[grass];
    const rule = track.notes.find((line) => line.startsWith('Never use the same chemical group'));
    expect(rule).toMatch(/twice in a row\. Two exceptions/);
    expect(rule).toMatch(/Group 3 pre-emergents \(all of them are Group 3 this season/);
    expect(rule).toMatch(/take-all pair \(Artavia, then Headway 30 days later, or Artavia twice; both recorded for take-all\)/);
    expect(JSON.stringify(track)).not.toMatch(/same target|on one lawn/);
    expect(track.safety_rules.some((line) => /Never repeat a chemical group on the next application/.test(line))).toBe(false);
    expect(track.safety_rules.find((line) => /chemical group/.test(line))).toMatch(/Exceptions: Group 3 pre-emergents .* take-all pair \(Artavia, then Headway or Artavia\), both recorded for take-all/);
  });

  test.each(TRACKS)('%s: Acelepryn carries the label wait of 24 hours for watering (irrigation) or mowing, on every line', (grass) => {
    const track = v13[grass];
    const wait = 'delay watering (irrigation) or mowing for 24 hours after application';
    expect(track.notes.find((line) => line.startsWith('Caterpillars:'))).toContain(wait);
    const acelepryn = track.visits.flatMap((v) => lines(v.secondary)).filter((line) => line.startsWith('Acelepryn'));
    expect(acelepryn).toHaveLength(3);
    for (const line of acelepryn) expect(line).toContain(wait);
  });

  test.each(TRACKS)('%s: the fertilizer safety block is notes only, on the N visits', (grass) => {
    const track = v13[grass];
    for (const text of [track.notes, track.safety_rules]) {
      const line = text.find((entry) => entry.startsWith('Fertilizer safety:'));
      expect(line).toMatch(/deflector shield/);
      expect(line).toMatch(/10 ft fertilizer-free band from any water body, wetland, seawall or top of bank/);
      expect(line).toMatch(/severe thunderstorm, flood or tropical watch or warning/);
      expect(line).toMatch(/sweep fertilizer off driveways, sidewalks and streets back onto the lawn/);
      expect(line).toMatch(/Manatee BMP decal/);
    }
    for (const month of ['Feb', 'Apr', 'Nov', 'Dec']) expect(visit(grass, month).notes).toMatch(/Fertilizer safety: deflector on, 10 ft water band kept/);
    // October is a separate change (the track text covers it); every other visit says nothing of it.
    for (const month of ['Jan', 'Mar', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']) expect(visit(grass, month).notes).not.toMatch(/Fertilizer safety/);
    // No new task or tap: the visits keep the notes and lines they had.
    expect(everything(grass)).not.toMatch(/fertilizer_safety_check|checkbox/i);
  });

  test.each(TRACKS)('%s: North Port Nutra-TECH is said once in the track text and on the three summer visits', (grass) => {
    const track = v13[grass];
    expect(track.notes.some((line) => line.startsWith('North Port: no Nutra-TECH on the June, August and September visits'))).toBe(true);
    expect(track.safety_rules.some((line) => line.startsWith('North Port: no Nutra-TECH June through September'))).toBe(true);
    for (const month of ['Jun', 'Aug', 'Sep']) expect(visit(grass, month).notes).toContain('North Port: skip Nutra-TECH on this visit until the city confirms.');
    for (const month of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jul', 'Oct', 'Nov', 'Dec']) expect(visit(grass, month).notes).not.toMatch(/North Port: skip Nutra-TECH/);
  });

  test.each(TRACKS)('%s: North Port April keeps its Nutra-TECH pass (owner ruling 2026-10-07)', (grass) => {
    const track = v13[grass];
    expect(visit(grass, 'Mar').notes).toContain('North Port (N ban starts April 1): the tech swaps March to granular Dimension, the last N before the ban, and April to Nutra-TECH.');
    expect(visit(grass, 'Apr').notes).not.toMatch(/North Port/);
    expect(JSON.stringify(track)).not.toMatch(/inspect and spot work only|no fertilizer or Nutra-TECH|no fertilizer of any kind/);
    expect(track.notes.find((line) => line.startsWith('North Port: no Nutra-TECH'))).toMatch(/June, August and September visits until the city confirms\. The April Nutra-TECH pass stays/);
    expect(track.safety_rules.find((line) => line.startsWith('North Port: no Nutra-TECH'))).toBe('North Port: no Nutra-TECH June through September until the city confirms.');
  });

  test('the product window gate sits on the summer Nutra-TECH rows only, never on an April row', () => {
    const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
    for (const windowKey of rules.NORTH_PORT_WINDOWS) {
      expect(staged.PRODUCTS.some(([key, spec]) => key === windowKey && spec[0] === staged.NAMES.NT)).toBe(true);
    }
    expect(rules.NORTH_PORT_WINDOWS).not.toContain('apr_v13_spreader_feeding');
    // An April Nutra-TECH row (none is staged today) would carry no gate, so the plan would not hold it.
    expect(rules.missingGates({ product_name: rules.NAMES.NUTRA, window_key: 'apr_v13_spreader_feeding', gates: {} })).toEqual({});
    const rows = new Map([['nutra', { gates: {} }]]);
    const items = [{ product: { id: 'nutra' }, selected: true }];
    expect(engine.holdNorthPortProducts(items, rows, 'North Port')).toEqual(items);
  });

  test('the tracks stay one program (identical but for the name)', () => {
    const body = ({ name, ...rest }) => JSON.stringify(rest);
    for (const grass of TRACKS) expect(body(v13[grass])).toBe(body(v13.st_augustine));
  });
});

describe('the migration declares its gate rules', () => {
  const { missingGates, RULES, NAMES, NORTH_PORT_WINDOWS } = rules;
  const row = (productName, windowKey, gates = {}) => ({ product_name: productName, window_key: windowKey, gates });

  test('Nutra-TECH gets the product window key in the June, August and September windows only', () => {
    for (const windowKey of NORTH_PORT_WINDOWS) expect(missingGates(row(NAMES.NUTRA, windowKey))).toEqual({ northPortProductWindow: true });
    for (const windowKey of ['jan_v13_pre_m_hose', 'mar_v13_pre_m_hose']) expect(missingGates(row(NAMES.NUTRA, windowKey))).toEqual({});
    expect(missingGates(row('Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', 'jun_v13_hose_blackout'))).toEqual({});
  });

  test('Acelepryn gets the wait on every row, and a key a row already carries is never overwritten', () => {
    expect(missingGates(row(NAMES.ACELEPRYN, 'jul_v13_inspect_spot'))).toEqual({ delayWateringOrMowingHours: 24 });
    expect(missingGates(row(NAMES.ACELEPRYN, 'jul_v13_inspect_spot', JSON.stringify({ delayWateringOrMowingHours: 48 })))).toEqual({});
    expect(RULES.map((rule) => rule.key)).toEqual(['northPortProductWindow', 'delayWateringOrMowingHours']);
  });
});

describe('gate notes', () => {
  const keys = (notes) => notes.map((n) => `${n.severity}:${n.key}`);

  test('the product window note shows in North Port only', () => {
    expect(keys(engine.v13GateNotes({ northPortProductWindow: true }, { municipality: 'North Port' }))).toEqual(['required:northPortProductWindow']);
    expect(engine.v13GateNotes({ northPortProductWindow: true }, { municipality: 'Sarasota' })).toEqual([]);
    expect(engine.v13GateNotes({ northPortProductWindow: true }, {})).toEqual([]);
  });

  test('the Acelepryn wait is one note and leaves the customer watering text alone', () => {
    const [note] = engine.v13GateNotes({ delayWateringOrMowingHours: 24 });
    expect(note).toEqual({ key: 'delayWateringOrMowingHours', severity: 'note', text: 'Delay watering (irrigation) or mowing for 24 hours after application (label).' });
  });
});

describe('the North Port hold', () => {
  const nutra = { id: 'nutra', name: 'Nutra' };
  const rows = new Map([['nutra', { gates: { northPortProductWindow: true } }], ['dim', { gates: {} }]]);
  const items = [{ product: nutra, selected: true, selectionReason: 'base_or_explicit_selection' }, { product: { id: 'dim' }, selected: true }, { product: null, selected: true }];

  test('in North Port the row is not selected and the line state is held (no amount)', () => {
    const held = engine.holdNorthPortProducts(items, rows, 'North Port');
    expect(held.map((item) => item.selected)).toEqual([false, true, true]);
    expect(held[0].selectionReason).toBe('north_port_product_window');
    expect(engine.v13LineState(nutra, rows, new Set(), { municipality: 'North Port' }).state).toBe('held');
  });

  test('anywhere else the row is untouched and calculates as before', () => {
    for (const city of ['Sarasota', '', null, undefined, 'Port Charlotte']) {
      expect(engine.holdNorthPortProducts(items, rows, city)).toEqual(items);
    }
    expect(engine.v13LineState({ id: 'dim' }, new Map([['dim', { applicationMode: 'broadcast', ratePer1000: 1, gates: {} }]]), new Set(), { municipality: 'Sarasota' }).state).toBe('calculate');
    expect(engine.v13LineState(nutra, new Map([['nutra', { applicationMode: 'broadcast', ratePer1000: 12, gates: { northPortProductWindow: true } }]]), new Set(), {}).state).toBe('calculate');
  });

  test('the held line explains itself and warns on the plan', () => {
    expect(engine.v13ItemFields({ row: rows.get('nutra'), state: 'held' }, {}, nutra).unavailable.reason).toMatch(/North Port holds this product/);
    const [warning] = engine.v13HoldWarnings([{ product: { id: 'nutra', name: 'Nutra' }, selectionReason: 'north_port_product_window' }, { product: { id: 'dim', name: 'Dim' }, selectionReason: 'x' }]);
    expect(warning).toMatchObject({ code: 'lawn_v13_north_port_product_window', severity: 'warning', productId: 'nutra' });
  });
});

describe('completion flags a recording of a held product like the nitrogen ban', () => {
  const plan = { mixCalculator: { items: [{ product: { id: 'dim', name: 'Dim' }, selectionReason: 'base_or_explicit_selection' }] }, protocol: {
    base: [
      { product: { id: 'nutra', name: 'Nutra' }, selectionReason: 'north_port_product_window' },
      { product: { id: 'dim', name: 'Dim' }, selectionReason: 'base_or_explicit_selection' },
    ],
    conditional: [],
  } };

  test('a held product submitted as applied is one block; skipping it is none', () => {
    expect(heldProductBlocks(plan, [{ productId: 'nutra' }, { productId: 'nutra' }, { productId: 'dim' }]))
      .toEqual([expect.objectContaining({ code: 'actual_north_port_product_window', severity: 'block', message: expect.stringContaining('Nutra is recorded as applied') })]);
    expect(heldProductBlocks(plan, [{ productId: 'dim' }])).toEqual([]);
    expect(heldProductBlocks(plan, [])).toEqual([]);
  });

  test('a plan with no held product, or no plan, flags nothing', () => {
    expect(heldProductBlocks({ protocol: { base: [{ product: { id: 'nutra' }, selectionReason: 'x' }] } }, [{ productId: 'nutra' }])).toEqual([]);
    expect(heldProductBlocks(null, [{ productId: 'nutra' }])).toEqual([]);
    expect(heldProductBlocks({}, undefined)).toEqual([]);
  });
});

describe('Acelepryn caterpillar hold reaches the customer instruction', () => {
  const { approvedReportProductFacts, withApplicationHold } = require('../services/service-report/report-data');
  const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
  const acelepryn = { name: 'Acelepryn Insecticide', category: 'insecticide', epa_reg_number: '100-1489', approved_for_service_report: true };
  const AT = '2026-08-12T14:00:00.000Z';
  const instruct = (facts) => buildWateringInstruction({ rules: [{ name: facts.name, rule: facts.wateringRule, mowHoldDays: facts.mowHoldDays }], completedAt: AT });

  test('the catalog alone says nothing about watering or mowing for Acelepryn', () => {
    const facts = approvedReportProductFacts(acelepryn);
    expect(facts.wateringRule).toBeNull();
    expect(instruct(facts)).toMatchObject({ state: null, lines: [], mowHold: null });
  });

  test('a caterpillar use with the row gate freezes a 24-hour hold: skip watering and no mowing for a day', () => {
    const facts = withApplicationHold(approvedReportProductFacts(acelepryn), { hours: 24, targets: ['caterpillars'] });
    expect(facts.wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24, source: 'label' });
    expect(facts.mowHoldDays).toBe(1);
    const instruction = instruct(facts);
    expect(instruction.state).toBe('hold');
    expect(instruction.lines[0]).toMatch(/^Skip your turf watering until /);
    expect(instruction.mowHold).toMatchObject({ days: 1 });
    expect(instruction.mowHold.line).toMatch(/^Mowing: hold off until .*, 1 day after today's treatment\.$/);
  });

  test('a grub use (target says grubs) or a row with no gate is unchanged, so the water-in is not contradicted', () => {
    const base = approvedReportProductFacts(acelepryn);
    expect(withApplicationHold(base, { hours: 24, targets: ['White grubs'] })).toBe(base);
    expect(withApplicationHold(base, { hours: 24 })).toBe(base);
    expect(withApplicationHold(base, { hours: 24, targets: ['Billbugs'] })).toBe(base);
    expect(withApplicationHold(base, { hours: undefined, targets: ['caterpillars'] })).toBe(base);
    expect(withApplicationHold(base, {})).toBe(base);
  });

  test('the completion freeze applies the applied protocol row gate and the use target', () => {
    const id = '7f1e2d3c-0000-4000-8000-000000000001';
    const catalogById = new Map([[id, { id, ...acelepryn }]]);
    const plan = { protocol: { structured: { products: [{ productId: id, gates: { trigger: 'caterpillars', delayWateringOrMowingHours: 24 } }] } } };
    const frozen = (submitted, p = plan) => freezeReportProductFacts({ productIds: [id], submitted, catalogById, plan: p })[id];
    expect(frozen([{ productId: id, targets: ['caterpillars'] }]).wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24 });
    // No recorded target, or a target that is not a caterpillar pest, takes no hold.
    expect(frozen([{ productId: id }]).wateringRule).toBeNull();
    expect(frozen([{ productId: id, targets: [] }]).wateringRule).toBeNull();
    for (const target of ['Billbugs', 'White grubs', 'Chinch bugs', 'Mole crickets']) expect(frozen([{ productId: id, targets: [target] }]).wateringRule).toBeNull();
    for (const target of ['Armyworms', 'Sod webworm', 'Grass looper', 'Cutworms', 'Tropical sod webworm', 'Grassworms']) {
      expect(frozen([{ productId: id, targets: ['Mole crickets', target] }]).wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24 });
    }
    // A grub use, or a plan whose row carries no hold, freezes the catalog's silence as before.
    expect(frozen([{ productId: id, targets: ['grubs'] }]).wateringRule).toBeNull();
    expect(frozen([{ productId: id, targets: ['caterpillars'] }], { protocol: { structured: { products: [{ productId: id, gates: {} }] } } }).wateringRule).toBeNull();
    expect(frozen([{ productId: id }], null).wateringRule).toBeNull();
  });

  test('a product with its own catalog rule keeps it, and a product not approved for reports stays unapproved', () => {
    const withRule = approvedReportProductFacts({ ...acelepryn, post_application_watering: { mode: 'water_in', source: 'label' } });
    expect(withApplicationHold(withRule, { hours: 24, targets: ['caterpillars'] })).toBe(withRule);
    expect(withApplicationHold(null, { hours: 24 })).toBeNull();
  });
});

describe('the April customer line', () => {
  test('keeps the main wording: North Port April still gets a feeding-type pass (Nutra-TECH)', () => {
    const { PROGRAM_LINES_V13 } = require('../services/service-report/lawn-program-line');
    expect(PROGRAM_LINES_V13[4].line).toBe('In April the program focuses on a light feeding, plus spot treatment for root disease and chinch bugs where needed.');
    expect(PROGRAM_LINES_V13[4].claims.feed).toBe('a light feeding');
  });
});
