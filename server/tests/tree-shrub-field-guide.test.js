const { treeShrubFieldGuide } = require('../services/tree-shrub-field-guide');
const { treeShrubDueReason } = require('../services/tree-shrub-completion-defaults');
const { tree_shrub: program } = require('../config/protocols.json');
const visit = month => program.visits.find(row => row.month === month);
afterEach(() => { delete process.env.GATE_TREE_SHRUB_FIELD_GUIDE; });

test('dark guide stays off; scheduled month projects only its own product details and equipment', () => {
  expect(treeShrubFieldGuide(visit('Jan'))).toBeNull();
  process.env.GATE_TREE_SHRUB_FIELD_GUIDE = 'true';
  const january = treeShrubFieldGuide(visit('Jan'));
  expect(january.products.snapshot.equipment).toEqual(['hand', 'push']);
  expect(january.products.merit.equipment).toEqual(['soil']);
  expect(january.products.talus).toBeUndefined();
  const september = treeShrubFieldGuide(visit('Sep'));
  // Snapshot and the palm feed are routine on every month card (due gates decide).
  expect(september.products.snapshot.equipment).toEqual(['hand', 'push']);
  expect(september.products.f0016).toBeDefined();
  // Talus (residential use prohibited) and Headway (turf-only label) are gone.
  expect(september.products.talus).toBeUndefined();
  expect(september.products.headway).toBeUndefined();
  expect(september.products.tristar.mix).toBeUndefined();
});

test('Talus and Headway are not in the reference; TriStar carries the verified Cleary label', () => {
  const reference = require('../config/tree-shrub-field-guide.json');
  expect(reference.products.talus).toBeUndefined();
  expect(reference.products.headway).toBeUndefined();
  expect(JSON.stringify(reference)).not.toMatch(/talus|headway/i);
  expect(reference.products.tristar).toMatchObject({ name: 'TriStar 8.5 SL', equipment: ['bg', 'flowzone', 'rig'] });
  // One rate row per label pest group (EPA 8033-106 ornamental table; Codex r3 #6185).
  expect(reference.products.tristar.rates).toEqual([
    ['4.0 fl oz / 100 gal', 'Aphids.'],
    ['8.5 fl oz / 100 gal', 'Mealybugs.'],
    ['8.5–16.5 fl oz / 100 gal', 'Whiteflies and soft scales. Use the higher rate when pressure is high.'],
  ]);
  expect(reference.products.tristar.mixes).toEqual([
    ['Aphids', 0.04, 0.04], ['Mealybugs', 0.085, 0.085], ['Whitefly or soft scale', 0.085, 0.165],
  ]);
  // The TriTek label lists sooty mold only for citrus: not an oil target here.
  expect(JSON.stringify([reference.products.tritek, reference.products.tritek15])).not.toMatch(/sooty/i);
  expect(reference.products.tristar.source).toMatch(/8033-106-1001/);
  // Every product a month card names exists in the reference.
  for (const row of program.visits) {
    for (const { key } of [...row.fieldGuide.routine, ...row.fieldGuide.conditional]) {
      expect(reference.products[key]).toBeDefined();
    }
    // Every month card offers Snapshot and the season's palm feed as routine.
    const routine = row.fieldGuide.routine.map(r => r.key);
    expect(routine).toContain('snapshot');
    expect(routine).toContain(['Jun', 'Jul', 'Aug', 'Sep'].includes(row.month) ? 'f0016' : 'f8012');
  }
});

const application = (product_name, date, overrides = {}) => ({ product_name, application_date: date, property_id: 'property-a', rate_unit: 'lb', application_rate: 2.3, ...overrides });
test('Snapshot respects property, recent applications, rolling limits and unknown history units', () => {
  const due = rows => treeShrubDueReason('snapshot', rows, '2028-07-01', 'property-a');
  expect(due([])).toBeNull();
  expect(due([application('Snapshot 2.5TG', '2028-06-01')])).toMatch(/60 days/);
  expect(due([application('Snapshot 2.5TG', '2028-06-01', { property_id: 'property-b' })])).toBeNull();
  expect(due([application('Snapshot 2.5TG', '2028-04-01', { property_id: null })])).toMatch(/unconfirmed property/);
  expect(due([application('Snapshot 2.5TG', '2028-04-01', { rate_unit: 'oz' })])).toMatch(/prior Snapshot rates/);
  expect(due(['2027-10-01', '2028-01-01', '2028-04-01'].map(date => application('Snapshot 2.5TG', date, { application_rate: 3.45 })))).toMatch(/annual limit/);
  expect(due([application('Snapshot 2.5TG', '2028-07-01')])).toMatch(/already recorded/);
  for (const date of [null, '', 'invalid', new Date(NaN)]) {
    expect(due([application('Snapshot 2.5TG', date)])).toMatch(/unconfirmed property or date/);
    expect(treeShrubDueReason('snapshot', [], date, 'property-a')).toMatch(/visit date/);
  }
});

test('both palm fertilizers and the old palm product share one three-month/four-feeding history', () => {
  const history = [application('8-2-12 palm fertilizer', '2028-04-30')];
  expect(treeShrubDueReason('f0016', history, '2028-07-29', 'property-a')).toMatch(/three months/);
  expect(treeShrubDueReason('f0016', history, '2028-07-30', 'property-a')).toBeNull();
  const four = ['2027-10-01', '2028-01-01', '2028-04-01', '2028-07-01'].map(date => application('LESCO 0-0-16', date));
  expect(treeShrubDueReason('f8012', four, '2028-09-30', 'property-a')).toMatch(/Four applications/);
  expect(treeShrubDueReason('f8012', [], '2028-10-01', null)).toMatch(/Confirm the service property/);
});

test('lawn winterizer does not count as a palm feeding but the confirmed palm SKU does', () => {
  expect(treeShrubDueReason('f0016', [application('0-0-16 Winterizer', '2028-09-01')], '2028-10-01', 'property-a')).toBeNull();
  expect(treeShrubDueReason('f0016', [application('LESCO 0-0-16 Winterizer', '2028-09-01')], '2028-10-01', 'property-a')).toBeNull();
  expect(treeShrubDueReason('f8012', [application('LESCO 0-0-16 #510513', '2028-09-01')], '2028-10-01', 'property-a')).toMatch(/three months/);
});

test('Fast Complete Snapshot rows (total, no rate) count toward the annual limit instead of blocking', () => {
  const due = rows => treeShrubDueReason('snapshot', rows, '2028-07-01', 'property-a');
  const fast = (date, overrides = {}) => application('Snapshot 2.5TG', date, { application_rate: null, rate_unit: null, total_amount: 25.5, amount_unit: 'lb', ...overrides });
  // One earlier-quarter row with no area reserves the label max (4.6) and leaves room.
  expect(due([fast('2028-04-01')])).toBeNull();
  // Two reserved rows plus the next max-rate pass exceed the rolling limit.
  expect(due([fast('2027-10-01'), fast('2028-01-01')])).toMatch(/annual limit/);
  // With the bed area recorded, the rate is derived: 25.5 lb over 11,000 sq ft = 2.32.
  expect(due([fast('2027-10-01', { area_value: 11000, area_unit: 'sqft' }), fast('2028-01-01', { area_value: 11000, area_unit: 'sqft' })])).toBeNull();
  // Neither a rate nor an amount: still unreviewable.
  expect(due([fast('2028-04-01', { total_amount: null })])).toMatch(/prior Snapshot rates/);
  expect(due([fast('2028-04-01', { amount_unit: 'fl oz' })])).toMatch(/prior Snapshot rates/);
});

test('palm spacing is one three-calendar-month rule shared with Fast Complete', () => {
  const { palmFeedingTooSoon } = require('../services/tree-shrub-completion-defaults');
  const { buildTreeShrubWarnings } = require('../services/tree-shrub-fast-context');
  // 2028-04-30 → three months later is 2028-07-30; day 80 is still too soon.
  expect(palmFeedingTooSoon('2028-04-30', '2028-07-19')).toBe(true);
  expect(palmFeedingTooSoon('2028-04-30', '2028-07-30')).toBe(false);
  const palm = { id: 'palm', name: 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer (#511542)', category: 'fertilizer' };
  const applications = [{ application_date: '2028-04-30', product_id: 'palm', product_name: palm.name, category: 'fertilizer' }];
  const warn = date => buildTreeShrubWarnings({ catalogRows: [palm], applications, visitDate: date }).filter(w => w.type === 'palm_fertilizer_spacing');
  expect(warn('2028-07-19')).toHaveLength(1);
  expect(warn('2028-07-30')).toHaveLength(0);
});

test('history older than 12 months never holds a suggestion; undated rows still do', () => {
  const due = rows => treeShrubDueReason('snapshot', rows, '2028-07-01', 'property-a');
  expect(due([application('Snapshot 2.5TG', '2026-03-01', { property_id: null })])).toBeNull();
  expect(due([application('Snapshot 2.5TG', '2028-03-01', { property_id: null })])).toMatch(/unconfirmed property/);
  expect(due([application('Snapshot 2.5TG', null)])).toMatch(/unconfirmed property or date/);
});

test('a rate unit written with a comma ("lb/1,000 sq ft") is recognized', () => {
  const due = rows => treeShrubDueReason('snapshot', rows, '2028-07-01', 'property-a');
  expect(due([application('Snapshot 2.5TG', '2028-04-01', { rate_unit: 'lb/1,000 sq ft' })])).toBeNull();
});

describe('DiPel and manganese sulfate guide entries (owner 2026-10-05)', () => {
  const guide = require('../config/tree-shrub-field-guide.json');
  const protocols = require('../config/protocols.json');
  const conditionalKeys = (month) => protocols.tree_shrub.visits
    .find((v) => v.month === month).fieldGuide.conditional.map((c) => c.key);

  test('both products carry a label source and no fluid-ounce mix for the dry Bt powder', () => {
    expect(guide.products.dipel.source).toMatch(/EPA 73049-39/);
    expect(guide.products.dipel.mixes).toBeUndefined();
    expect(guide.products.mnsulfate.url).toMatch(/MANGANESESULFATE/i);
    expect(guide.products.mnsulfate.limits.join(' ')).toMatch(/stain/i);
  });

  test('they are conditional only, in the caterpillar and palm-manganese months', () => {
    for (const m of ['Mar', 'Apr', 'Jun', 'Jul', 'Dec']) expect(conditionalKeys(m)).toContain('dipel');
    for (const m of ['Feb', 'May', 'Jun', 'Sep', 'Nov']) expect(conditionalKeys(m)).toContain('mnsulfate');
    for (const v of protocols.tree_shrub.visits) {
      expect(v.primary).not.toMatch(/dipel|manganese sulfate/i);
      expect((v.fieldGuide.routine || []).map((r) => r.key)).not.toEqual(expect.arrayContaining(['dipel', 'mnsulfate']));
    }
  });
});

describe('Acelepryn, Reliant and the Distance yearly limit (owner 2026-10-09)', () => {
  const guide = require('../config/tree-shrub-field-guide.json');
  const protocols = require('../config/protocols.json');
  const visits = protocols.tree_shrub.visits;
  const conditional = (month) => visits.find((v) => v.month === month).fieldGuide.conditional;

  test('caterpillar jobs name Acelepryn; Mainspring is the whitefly product', () => {
    for (const month of ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']) {
      const visit = visits.find((v) => v.month === month);
      expect(visit.secondary).toMatch(/^Acelepryn Insecticide: 2–16 fl oz\/100 gal for leaf-feeding caterpillars, live finds only; not for whitefly; no more than 0\.37 fl oz per 1,000 sq ft in one spray; not when rain is forecast within 48 hours; at least 7 days between sprays \(\$5\.66\)$/m);
      expect(visit.primary).not.toMatch(/acelepryn/i);
    }
    for (const visit of visits) {
      expect(`${visit.primary}\n${visit.secondary}`).not.toMatch(/mainspring[^\n]*caterpillar/i);
      for (const row of visit.fieldGuide.conditional) {
        expect(row.key === 'mainspring' && /caterpillar/i.test(row.where)).toBe(false);
      }
    }
    // The structured guide replaces the card text when it is on, so every card that names
    // Acelepryn in its text must also carry the guide row.
    for (const visit of visits) {
      const named = /^Acelepryn /m.test(visit.secondary);
      expect(visit.fieldGuide.conditional.some((row) => row.key === 'acelepryn')).toBe(named);
      if (named) expect(visit.fieldGuide.conditional).toContainEqual({ key: 'acelepryn', where: 'Caterpillars, live finds' });
    }
  });

  test('the Acelepryn entry carries the landscape label rate and limits', () => {
    const acelepryn = guide.products.acelepryn;
    expect(acelepryn.source).toMatch(/EPA 100-1489/);
    expect(acelepryn.rates[0][0]).toBe('2–16 fl oz / 100 gal');
    expect(acelepryn.mix).toEqual([0.02, 0.16]);
    expect(acelepryn.targets).toMatch(/no whitefly use/);
    expect(acelepryn.name).toBe('Acelepryn Insecticide');
    expect(acelepryn.limits.join(' ')).toMatch(/rain is forecast within 48 hours/);
    expect(acelepryn.limits.join(' ')).toMatch(/At least 7 days between treatments\..*38\.3 fl oz per acre/);
  });

  test('Reliant takes the KPHITE entry: foliar by the gallon, drench by the rig', () => {
    expect(guide.products.kphite).toBeUndefined();
    const reliant = guide.products.reliant;
    expect(reliant.source).toMatch(/EPA 83416-1/);
    // Codex r1 #6218: the residential table, not the nursery one. Foliar only; the residential
    // drench (0.5–1% at 25 gal per 100 sq ft) is named as a limit, never offered as a rate.
    expect(reliant.source).toMatch(/residential Ornamental Applications/);
    expect(reliant.rates.map((r) => r[0])).toEqual(['Foliar: 2–4 tsp / gal']);
    // No computed mix: a decimal fl oz cannot keep both the 1-gallon (2-4 tsp) and the rig bounds
    // exact, so the row shows the label's own two statements of the rate.
    expect(reliant.mix).toBeUndefined();
    expect(reliant.summary).toBe('2–4 tsp per gallon (1–2 qt per 100 gal)');
    expect(reliant.limits.join(' ')).toMatch(/rain is forecast within 24 hours.*out until the spray dries/);
    expect(JSON.stringify(reliant)).not.toMatch(/6¼|12¾/);
    expect(reliant.limits.join(' ')).toMatch(/No soil drench on the program\..*0\.5–1% mix/);
    for (const month of ['Mar', 'Jun', 'Oct']) {
      expect(conditional(month)).toContainEqual({ key: 'reliant', where: 'Root-rot history or replacement plantings' });
    }
  });

  test('the Acelepryn line resolves to the plain catalog product, not Acelepryn Xtra (Codex r1 #6218)', () => {
    const { matchCatalogProduct } = require('../services/waveguard-plan-engine');
    const catalog = [
      { id: 'xtra', name: 'Acelepryn Xtra', best_price: 150 },
      { id: 'plain', name: 'Acelepryn Insecticide', best_price: 905 },
    ];
    const line = visits.find((v) => v.month === 'Apr').secondary.split('\n').find((l) => /^Acelepryn/.test(l));
    expect(matchCatalogProduct({ raw: line }, catalog)?.id).toBe('plain');
  });

  test('the Mainspring guide entry no longer offers caterpillars', () => {
    const mainspring = guide.products.mainspring;
    expect(mainspring.rates.map((r) => r[1]).join(' ')).not.toMatch(/caterpillar/i);
    expect(mainspring.targets).toMatch(/the program does not use Mainspring for them/);
    expect(mainspring.program).toMatch(/never Mainspring/);
  });

  test('every card key has a guide entry', () => {
    for (const visit of visits) {
      for (const section of ['routine', 'conditional']) {
        for (const row of visit.fieldGuide[section] || []) expect(guide.products[row.key]).toBeDefined();
      }
    }
  });

  test('Distance: whitefly rate with its limits; the scale use is on hold on every line and in the guide', () => {
    const lines = visits.flatMap((v) => `${v.primary}\n${v.secondary}`.split('\n')).filter((line) => /^Distance IGR/.test(line));
    expect(lines).toHaveLength(7);
    for (const line of lines) {
      expect(line).toMatch(/whiteflies 6–8 fl oz\/100 gal, no more than 5 gal of mix per 1,000 sq ft, one 8 fl oz spray a year or 6 then 6 at least 21 days apart; scale: HOLD, call the office first/);
      expect(line).not.toMatch(/listed scales 8–12/);
    }
    const distance = guide.products.distance;
    // No scale rate or mix is offered while the label's two yearly figures for scale are unreconciled.
    expect(distance.mixes).toEqual([['Whiteflies', 0.06, 0.08]]);
    expect(JSON.stringify(distance.rates)).not.toMatch(/8–12/);
    expect(distance.rates[1][0]).toBe('Scale and mealybug: HOLD');
    const limits = distance.limits.join(' ');
    expect(limits).toMatch(/6 fl oz followed by 6 fl oz at least 21 days later/);
    expect(limits).toMatch(/Scale and mealybug use is on hold\./);
    expect(limits).not.toMatch(/two per six months/);
    for (const visit of visits) {
      for (const row of visit.fieldGuide.conditional) if (row.key === 'distance') expect(row.where).toBe('Whitefly nymphs; scale on hold');
    }
  });
});
