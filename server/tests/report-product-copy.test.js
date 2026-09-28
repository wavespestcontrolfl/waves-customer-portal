// Unit tests for the report product-copy config + gate
// (owner-approved 2026-09-28, GATE_REPORT_PRODUCT_COPY). Pure modules,
// synthetic data only — no DB.

const { REPORT_PRODUCT_COPY, findReportProductCopyEntry, reportProductCopyFor } = require('../config/report-product-copy');
const {
  reportProductCopyGateOn,
  reportProductCopyForApplicationProduct,
  reportProductCopyPdfSignature,
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

describe('reportProductCopyPdfSignature — cache-key component', () => {
  const ORIGINAL = process.env.GATE_REPORT_PRODUCT_COPY;
  afterEach(() => { process.env.GATE_REPORT_PRODUCT_COPY = ORIGINAL; });

  it('appends -rpc1 while the gate is on, so a flip re-renders cached PDFs once', () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    expect(reportProductCopyPdfSignature()).toBe('-rpc1');
  });

  it('is empty (pre-flip keys untouched) while the gate is off', () => {
    delete process.env.GATE_REPORT_PRODUCT_COPY;
    expect(reportProductCopyPdfSignature()).toBe('');
  });
});

describe('REPORT_PRODUCT_COPY config', () => {
  it('carries exactly the 12 owner-approved products, no more, no fewer', () => {
    expect(REPORT_PRODUCT_COPY).toHaveLength(12);
  });

  it('every entry\'s wording clears the shared banned-copy guard (premium-experience.js validateCustomerCopy)', () => {
    const { validateCustomerCopy } = require('../services/service-report/premium-experience');
    for (const entry of REPORT_PRODUCT_COPY) {
      expect(validateCustomerCopy(entry.howItWorks)).toBe(true);
      if (entry.alsoLabeledFor) expect(validateCustomerCopy(entry.alsoLabeledFor)).toBe(true);
      expect(validateCustomerCopy(entry.petsKids)).toBe(true);
    }
  });
});

describe('passesReportCopyScreen', () => {
  const { passesReportCopyScreen } = require('../services/service-report/report-product-copy');

  it('passes every owner-approved line', () => {
    for (const entry of REPORT_PRODUCT_COPY) {
      expect(passesReportCopyScreen(entry.howItWorks)).toBe(true);
      if (entry.alsoLabeledFor) expect(passesReportCopyScreen(entry.alsoLabeledFor)).toBe(true);
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
  it('returns how_it_works / also_labeled_for / pets_kids for a normal approved product', () => {
    const copy = reportProductCopyFor({ epaReg: '53883-279', name: 'Taurus SC' });
    expect(copy).toEqual({
      how_it_works: expect.stringContaining('walk right through the treated band'),
      also_labeled_for: expect.stringContaining('Big-headed'),
      pets_kids: expect.stringContaining('Keep people and pets off treated areas'),
    });
  });

  it('LESCO carries no also_labeled_for KEY at all (owner ruling) — never null, never an empty string', () => {
    const copy = reportProductCopyFor({ epaReg: null, name: 'LESCO 90/10 Nonionic Surfactant' });
    expect(copy).not.toBeNull();
    expect(copy).not.toHaveProperty('also_labeled_for');
    expect(copy.how_it_works).toMatch(/spreader/i);
    expect(copy.pets_kids).toBe('Follows the spray it’s mixed into.');
  });
});

describe('reportProductCopyForApplicationProduct — report-data.js shape', () => {
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

  it('a product with no product_id / no catalog join still resolves by its snapshotted product_name', () => {
    const copy = reportProductCopyForApplicationProduct({ product_name: 'Gentrol IGR' });
    expect(copy).not.toBeNull();
    expect(copy.also_labeled_for).toMatch(/German and American cockroaches/);
  });

  it('an unapproved product on the applied-products list gets no report_copy', () => {
    expect(reportProductCopyForApplicationProduct({ product_name: 'Talstar XTRA', epa_reg_number: '279-3206' })).toBeNull();
  });
});
