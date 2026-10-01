// Unit tests for the report product-copy config + gate
// (owner-approved 2026-09-28, GATE_REPORT_PRODUCT_COPY). Pure modules,
// synthetic data only — no DB.

const {
  REPORT_PRODUCT_COPY, findReportProductCopyEntry, reportProductCopyFor,
  floorToMultipleOf25, normalizeReportCity, buildAlsoLabeledForText,
} = require('../config/report-product-copy');
const {
  reportProductCopyGateOn,
  reportProductCopyForApplicationProduct,
} = require('../services/service-report/report-product-copy');

describe('reportProductCopyGateOn', () => {
  const ORIGINAL = process.env.GATE_REPORT_PRODUCT_COPY;
  afterEach(() => { process.env.GATE_REPORT_PRODUCT_COPY = ORIGINAL; });

  it('is off unless exactly "true"', () => {
    delete process.env.GATE_REPORT_PRODUCT_COPY;
    expect(reportProductCopyGateOn()).toBe(false);
    process.env.GATE_REPORT_PRODUCT_COPY = '1';
    expect(reportProductCopyGateOn()).toBe(false);
    process.env.GATE_REPORT_PRODUCT_COPY = 'TRUE';
    expect(reportProductCopyGateOn()).toBe(false);
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    expect(reportProductCopyGateOn()).toBe(true);
  });
});

// The 12 owner-approved products, matched by their REAL products_catalog
// name (per the migrations that seed them — 20260712100000_catalog_label_
// rate_backfill.js and 20260507000004_mosquito_program_pricing_products.js)
// and EPA registration number, exactly as they read on the approved wording
// page.
const APPROVED_CATALOG_PRODUCTS = [
  { name: 'Taurus SC', epaReg: '53883-279' },
  { name: 'Atticus Talak', epaReg: '91234-145' }, // catalog's canonical name — NOT "... 7.9 F"
  { name: 'Alpine WSG', epaReg: '499-561' },
  { name: 'Demand CS', epaReg: '100-1066' },
  { name: 'Onslaught Fastcap', epaReg: '1021-2574' },
  { name: 'Advion Evolution Cockroach Gel Bait', epaReg: '100-1484' },
  { name: 'Advion Ant Bait Gel', epaReg: '100-1498' },
  { name: 'Advion WDG Granular', epaReg: '100-1483' },
  { name: 'Gentrol IGR', epaReg: '2724-351' },
  { name: 'Tekko Pro IGR', epaReg: '53883-335' },
  { name: 'Delta Dust', epaReg: '432-772' },
  { name: 'LESCO 90/10 Nonionic Surfactant', epaReg: null }, // adjuvant, not a pesticide
];

describe('REPORT_PRODUCT_COPY config', () => {
  it('carries exactly the 12 owner-approved products, no more, no fewer', () => {
    expect(REPORT_PRODUCT_COPY).toHaveLength(12);
  });

  it('every entry\'s wording clears the shared banned-copy guard (premium-experience.js validateCustomerCopy)', () => {
    const { validateCustomerCopy } = require('../services/service-report/premium-experience');
    for (const entry of REPORT_PRODUCT_COPY) {
      expect(validateCustomerCopy(entry.howItWorks)).toBe(true);
      if (entry.alsoLabeledForPestCount) {
        expect(validateCustomerCopy(buildAlsoLabeledForText(entry.alsoLabeledForPestCount, 'Bradenton'))).toBe(true);
        expect(validateCustomerCopy(buildAlsoLabeledForText(entry.alsoLabeledForPestCount, null))).toBe(true);
      }
      expect(validateCustomerCopy(entry.petsKids)).toBe(true);
    }
  });
});

describe('passesReportCopyScreen', () => {
  const { passesReportCopyScreen } = require('../services/service-report/report-product-copy');

  it('passes every owner-approved line', () => {
    for (const entry of REPORT_PRODUCT_COPY) {
      expect(passesReportCopyScreen(entry.howItWorks)).toBe(true);
      if (entry.alsoLabeledForPestCount) {
        expect(passesReportCopyScreen(buildAlsoLabeledForText(entry.alsoLabeledForPestCount, 'Bradenton'))).toBe(true);
        expect(passesReportCopyScreen(buildAlsoLabeledForText(entry.alsoLabeledForPestCount, null))).toBe(true);
      }
      expect(passesReportCopyScreen(entry.petsKids)).toBe(true);
    }
  });

  it.each([
    'Pet-safe once the spray is down.',
    'Safe for your kids and pets.',
    'An EPA-approved barrier around your home.',
  ])('fails closed on a banned compliance claim: %s', (line) => {
    expect(passesReportCopyScreen(line)).toBe(false);
  });
});

describe('findReportProductCopyEntry / reportProductCopyFor — matching', () => {
  it.each(APPROVED_CATALOG_PRODUCTS)('matches $name by its real catalog name + EPA reg', ({ name, epaReg }) => {
    const byEpa = epaReg ? findReportProductCopyEntry({ epaReg, name: 'some unrelated free-text name' }) : null;
    if (epaReg) expect(byEpa).not.toBeNull();
    const byName = findReportProductCopyEntry({ epaReg: null, name });
    expect(byName).not.toBeNull();
    expect(byName.names.map((n) => n.toLowerCase())).toContain(name.toLowerCase());
  });

  it('matches the wording page\'s longer "Atticus Talak 7.9 F" display spelling as a second alias', () => {
    const entry = findReportProductCopyEntry({ epaReg: null, name: 'Atticus Talak 7.9 F' });
    expect(entry).not.toBeNull();
    expect(entry.epaReg).toBe('91234-145');
  });

  it('EPA registration number wins over a non-matching name (label-truth over display spelling)', () => {
    const entry = findReportProductCopyEntry({ epaReg: '53883-279', name: 'some hand-typed spelling' });
    expect(entry).not.toBeNull();
    expect(entry.names).toContain('taurus sc');
  });

  it('never fuzzy-matches — a superstring/substring of an approved name gets nothing', () => {
    expect(findReportProductCopyEntry({ epaReg: null, name: 'Taurus SC Plus Extra' })).toBeNull();
    expect(findReportProductCopyEntry({ epaReg: null, name: 'Demand' })).toBeNull();
  });

  it('a present but UNRECOGNIZED EPA reg is authoritative — never falls back to a name alias for a different product (codex P1 2026-09-28)', () => {
    // Talstar XTRA's real EPA reg (279-3206) is not in the config; "Taurus
    // SC" IS an alias, but for a DIFFERENT product's entry. Before the fix
    // this returned the Taurus SC entry — a mismatched match.
    expect(findReportProductCopyEntry({ epaReg: '279-3206', name: 'Taurus SC' })).toBeNull();
    expect(reportProductCopyFor({ epaReg: '279-3206', name: 'Taurus SC' })).toBeNull();
  });

  it('name-alias matching only applies when NO EPA reg is recorded at all', () => {
    // Empty string / null / undefined EPA reg still falls through to the
    // name alias — only a non-empty, unrecognized reg is treated as
    // authoritative-and-absent.
    expect(findReportProductCopyEntry({ epaReg: '', name: 'Taurus SC' })).not.toBeNull();
    expect(findReportProductCopyEntry({ epaReg: null, name: 'Taurus SC' })).not.toBeNull();
    expect(findReportProductCopyEntry({ name: 'Taurus SC' })).not.toBeNull();
  });

  it('an unapproved/unlisted product gets no copy at all — fail closed', () => {
    for (const name of ['Adjourn SC', 'Cyper TC', 'Talstar XTRA', 'Tim-bor', 'Temprid FX', 'Suspend SC', 'Random Fertilizer']) {
      expect(reportProductCopyFor({ epaReg: null, name })).toBeNull();
    }
  });

  it('a product with neither EPA reg nor a recognized name gets no copy', () => {
    expect(reportProductCopyFor({})).toBeNull();
    expect(reportProductCopyFor({ epaReg: '', name: '' })).toBeNull();
  });
});

describe('reportProductCopyFor — public shape', () => {
  it('returns how_it_works / also_labeled_for / pets_kids for a normal approved product, also_labeled_for as a rounded count + city sentence', () => {
    const copy = reportProductCopyFor({ epaReg: '53883-279', name: 'Taurus SC', city: 'Bradenton' });
    expect(copy).toEqual({
      how_it_works: expect.stringContaining('walk right through the treated band'),
      also_labeled_for: 'Labeled for 25+ Bradenton pests', // raw count 35 -> floors to 25+
      pets_kids: expect.stringContaining('Keep people and pets off treated areas'),
    });
  });

  it('falls back to the no-city wording when no city is given', () => {
    const copy = reportProductCopyFor({ epaReg: '53883-279', name: 'Taurus SC' });
    expect(copy.also_labeled_for).toBe('Labeled for 25+ pests');
  });

  it('LESCO carries no also_labeled_for KEY at all (owner ruling) — never null, never an empty string', () => {
    const copy = reportProductCopyFor({ epaReg: null, name: 'LESCO 90/10 Nonionic Surfactant', city: 'Bradenton' });
    expect(copy).not.toBeNull();
    expect(copy).not.toHaveProperty('also_labeled_for');
    expect(copy.how_it_works).toMatch(/spreader/i);
    expect(copy.pets_kids).toBe('Follows the spray it’s mixed into.');
  });

  it.each([
    ['Advion Evolution Cockroach Gel Bait', '100-1484'],
    ['Advion Ant Bait Gel', '100-1498'],
    ['Advion WDG Granular', '100-1483'],
    ['Gentrol IGR', '2724-351'],
    ['Tekko Pro IGR', '53883-335'],
  ])('narrow product %s carries no also_labeled_for key at all (owner ruling 2026-09-29)', (name, epaReg) => {
    const copy = reportProductCopyFor({ epaReg, name, city: 'Bradenton' });
    expect(copy).not.toBeNull();
    expect(copy).not.toHaveProperty('also_labeled_for');
  });

  it.each([
    [169, 150],
    [88, 75],
    [90, 75],
    [66, 50],
    [35, 25],
    [30, 25],
  ])('rounds a raw label count of %i down to a multiple of 25 (%i+)', (raw, expected) => {
    expect(floorToMultipleOf25(raw)).toBe(expected);
  });

  it('composes "Labeled for {N}+ {City} pests" with a city, and "Labeled for {N}+ pests" without one', () => {
    expect(buildAlsoLabeledForText(169, 'Bradenton')).toBe('Labeled for 150+ Bradenton pests');
    expect(buildAlsoLabeledForText(169, null)).toBe('Labeled for 150+ pests');
    expect(buildAlsoLabeledForText(169, '')).toBe('Labeled for 150+ pests');
    expect(buildAlsoLabeledForText(169, '   ')).toBe('Labeled for 150+ pests');
  });

  it('normalizeReportCity title-cases an ALL-CAPS value, trims, and collapses internal whitespace', () => {
    expect(normalizeReportCity('BRADENTON')).toBe('Bradenton');
    expect(normalizeReportCity('LAKEWOOD  RANCH')).toBe('Lakewood Ranch');
    expect(normalizeReportCity('  lakewood ranch  ')).toBe('Lakewood Ranch'); // all-lowercase is title-cased too
    expect(normalizeReportCity('North port')).toBe('North port'); // mixed case is trusted as entered
    expect(normalizeReportCity('Port Charlotte')).toBe('Port Charlotte');
  });

  it('normalizeReportCity returns null for blank or unusable input — never invents a city', () => {
    expect(normalizeReportCity(null)).toBeNull();
    expect(normalizeReportCity(undefined)).toBeNull();
    expect(normalizeReportCity('')).toBeNull();
    expect(normalizeReportCity('   ')).toBeNull();
    expect(normalizeReportCity('12345')).toBeNull();
    expect(normalizeReportCity('---')).toBeNull();
  });
});

describe('reportProductCopyForApplicationProduct — report-data.js shape', () => {
  it('a city name that looks like a claim word ("Safety Harbor") keeps all three lines (codex r1 on #5352)', () => {
    const copy = reportProductCopyForApplicationProduct({ product_name: 'Taurus SC', epa_reg_number: '53883-279' }, 'Safety Harbor');
    expect(copy).not.toBeNull();
    expect(copy.also_labeled_for).toBe('Labeled for 25+ Safety Harbor pests');
    expect(copy.how_it_works).toBeTruthy();
    expect(copy.pets_kids).toBeTruthy();
  });

  it('reads epa_reg_number and product_name off the enriched service_products row', () => {
    const copy = reportProductCopyForApplicationProduct({ product_name: 'Demand CS', epa_reg_number: '100-1066' });
    expect(copy).not.toBeNull();
    expect(copy.how_it_works).toMatch(/Microscopic capsules/);
  });

  it('falls back to the legacy `epa_reg` field when `epa_reg_number` is absent', () => {
    const copy = reportProductCopyForApplicationProduct({ product_name: 'ignored', epa_reg: '432-772' });
    expect(copy).not.toBeNull();
    expect(copy.how_it_works).toMatch(/waterproof dust/);
  });

  it('a product with no product_id / no catalog join still resolves by its snapshotted product_name — Gentrol is a narrow IGR with no also_labeled_for line', () => {
    const copy = reportProductCopyForApplicationProduct({ product_name: 'Gentrol IGR' }, 'Bradenton');
    expect(copy).not.toBeNull();
    expect(copy).not.toHaveProperty('also_labeled_for');
  });

  it('threads the visit city through to also_labeled_for', () => {
    const copy = reportProductCopyForApplicationProduct({ product_name: 'Demand CS', epa_reg_number: '100-1066' }, 'Bradenton');
    expect(copy.also_labeled_for).toBe('Labeled for 75+ Bradenton pests'); // raw count 90 -> floors to 75+
  });

  it('an unapproved product on the applied-products list gets no report_copy', () => {
    expect(reportProductCopyForApplicationProduct({ product_name: 'Talstar XTRA', epa_reg_number: '279-3206' })).toBeNull();
  });

  it('an unrecognized EPA reg never borrows another product\'s wording via a coincidental name alias', () => {
    expect(reportProductCopyForApplicationProduct({ product_name: 'Taurus SC', epa_reg_number: '279-3206' })).toBeNull();
  });
});
