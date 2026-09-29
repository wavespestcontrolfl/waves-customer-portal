// applications[].product.report_copy on the public v1 report payload
// (owner-approved 2026-09-28, GATE_REPORT_PRODUCT_COPY). Same fake-knex
// harness as report-data-protocol-action-labels-egress.test.js. The gate is
// read fresh at CALL time (reportProductCopyGateOn in
// services/service-report/report-product-copy.js, same posture as
// reportPhotoContentLive) — no jest.resetModules() dance needed.

const { buildReportV1Data } = require('../services/service-report/report-data');

function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const q = {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 2) {
          rows = rows.filter((r) => r[a] === b);
        }
        return q;
      },
      andWhere: () => q,
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(criteria) {
        rows = rows.filter((r) => !Object.entries(criteria).every(([k, v]) => r[k] === v));
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy: () => q,
      first: () => Promise.resolve(rows[0] || null),
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const SERVICE = {
  id: 'svc-product-copy-1',
  scheduled_service_id: 'ss-product-copy',
  customer_id: 'cust-product-copy',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: '2026-07-16',
  first_name: 'Test',
  last_name: 'Customer',
  // The visit's own city (COALESCE stamped service_address_city,
  // customers.city, as every real caller's query already aliases it) — the
  // "Labeled for N+ City pests" ruling's city source (owner 2026-09-29).
  city: 'Bradenton',
  areas_serviced: JSON.stringify(['Perimeter']),
  structured_notes: '{}',
  service_data: '{}',
  pressure_index: 0,
};

const BASE_FIXTURES = {
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
  scheduled_services: [],
};

// A catalog-linked, approved Taurus SC application (real catalog name + EPA
// reg, exactly as the products_catalog seed migrations carry it) plus the
// LESCO surfactant (no EPA reg — adjuvant) and an unapproved product that
// must get no copy at all.
const FIXTURES = {
  ...BASE_FIXTURES,
  service_products: [
    {
      id: 'sp-taurus',
      service_record_id: SERVICE.id,
      product_id: 'cat-taurus',
      product_name: 'Taurus SC',
      created_at: '2026-07-16T00:00:00Z',
    },
    {
      id: 'sp-lesco',
      service_record_id: SERVICE.id,
      product_id: 'cat-lesco',
      product_name: 'LESCO 90/10 Nonionic Surfactant',
      created_at: '2026-07-16T00:00:01Z',
    },
    {
      // No product_id at all (hand-entered, never joined the catalog) —
      // must still resolve by its snapshotted product_name alone.
      id: 'sp-gentrol-noid',
      service_record_id: SERVICE.id,
      product_id: null,
      product_name: 'Gentrol IGR',
      created_at: '2026-07-16T00:00:02Z',
    },
    {
      id: 'sp-unapproved',
      service_record_id: SERVICE.id,
      product_id: 'cat-unapproved',
      product_name: 'Talstar XTRA',
      created_at: '2026-07-16T00:00:03Z',
    },
  ],
  products_catalog: [
    {
      id: 'cat-taurus',
      name: 'Taurus SC',
      category: 'insecticide',
      product_type: 'pesticide',
      epa_reg_number: '53883-279',
      approved_for_service_report: true,
      active_ingredient: 'Fipronil',
    },
    {
      id: 'cat-lesco',
      name: 'LESCO 90/10 Nonionic Surfactant',
      category: 'adjuvant',
      product_type: 'other',
      epa_reg_number: null,
      approved_for_service_report: true,
    },
    {
      id: 'cat-unapproved',
      name: 'Talstar XTRA',
      category: 'insecticide',
      product_type: 'pesticide',
      epa_reg_number: '279-3206',
      approved_for_service_report: true,
    },
  ],
};

describe('report_copy on applications[].product (GATE_REPORT_PRODUCT_COPY)', () => {
  const ORIGINAL = process.env.GATE_REPORT_PRODUCT_COPY;
  afterEach(() => { process.env.GATE_REPORT_PRODUCT_COPY = ORIGINAL; });

  test('gate OFF: no report_copy key anywhere, byte-identical to today', async () => {
    delete process.env.GATE_REPORT_PRODUCT_COPY;
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-off', makeKnex(FIXTURES));
    expect(data.applications).toHaveLength(4);
    for (const app of data.applications) {
      expect(app.product).not.toHaveProperty('report_copy');
    }
    expect(JSON.stringify(data)).not.toContain('report_copy');
  });

  test('gate ON: approved catalog-linked product gets its three lines, also_labeled_for as a rounded count + the visit\'s city', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-on', makeKnex(FIXTURES));
    const taurus = data.applications.find((a) => a.product.name === 'Taurus SC');
    // Taurus SC's raw label count is 35 -> floors to 25+; SERVICE.city is
    // 'Bradenton' (owner ruling 2026-09-29).
    expect(taurus.product.report_copy).toEqual({
      how_it_works: expect.stringContaining('treated band'),
      also_labeled_for: 'Labeled for 25+ Bradenton pests',
      pets_kids: expect.stringContaining('Keep people and pets off treated areas'),
    });
  });

  test('gate ON: no usable city on the visit falls back to the no-city wording', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const noCityService = { ...SERVICE, id: 'svc-product-copy-no-city', city: null };
    const noCityFixtures = {
      ...FIXTURES,
      service_products: FIXTURES.service_products.map((row) => ({ ...row, service_record_id: noCityService.id })),
    };
    const data = await buildReportV1Data(noCityService, 'token-product-copy-no-city', makeKnex(noCityFixtures));
    const taurus = data.applications.find((a) => a.product.name === 'Taurus SC');
    expect(taurus.product.report_copy.also_labeled_for).toBe('Labeled for 25+ pests');
  });

  test('gate ON: LESCO gets how_it_works + pets_kids but NO also_labeled_for key at all', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-lesco', makeKnex(FIXTURES));
    const lesco = data.applications.find((a) => a.product.name === 'LESCO 90/10 Nonionic Surfactant');
    expect(lesco.product.report_copy).not.toHaveProperty('also_labeled_for');
    expect(lesco.product.report_copy.how_it_works).toMatch(/spreader/i);
    expect(lesco.product.report_copy.pets_kids).toMatch(/Follows the spray/);
  });

  test('gate ON: a hand-entered row with no product_id still resolves by its snapshotted product_name — Gentrol is a narrow IGR, so it gets how_it_works/pets_kids but NO also_labeled_for line (owner ruling 2026-09-29)', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-noid', makeKnex(FIXTURES));
    const gentrol = data.applications.find((a) => a.product.name === 'Gentrol IGR');
    expect(gentrol.product.report_copy).not.toBeNull();
    expect(gentrol.product.report_copy).not.toHaveProperty('also_labeled_for');
    expect(gentrol.product.report_copy.how_it_works).toMatch(/insect growth regulator/i);
  });

  test('gate ON: an unapproved product (not on the owner-approved list) gets NO report_copy key — fail closed', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-unapproved', makeKnex(FIXTURES));
    const talstar = data.applications.find((a) => a.product.name === 'Talstar XTRA');
    expect(talstar.product).not.toHaveProperty('report_copy');
  });

  test('gate ON: never feeds moa_group/rainfast_minutes-style internal facts — report_copy carries only the three approved strings', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-shape', makeKnex(FIXTURES));
    const taurus = data.applications.find((a) => a.product.name === 'Taurus SC');
    expect(Object.keys(taurus.product.report_copy).sort()).toEqual(['also_labeled_for', 'how_it_works', 'pets_kids']);
  });

  // Termite exclusion (codex P1 2026-09-28): Taurus SC's approved wording is
  // written for the pest line (ant/spider/roach labeled-for text) and is
  // wrong on a termite liquid/trench/bait visit that happens to use the same
  // product. Reuses the same serviceLine classifier every other
  // termite-vs-not branch in report-data.js already reads
  // (service.service_line || detectServiceLine(service.service_type)).
  test('gate ON: a termite-family service gets NO report_copy, even for an otherwise-approved product', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const termiteService = { ...SERVICE, id: 'svc-product-copy-termite', service_line: 'termite', service_type: 'Termite Liquid Treatment' };
    const termiteFixtures = {
      ...FIXTURES,
      service_products: FIXTURES.service_products.map((row) => ({ ...row, service_record_id: termiteService.id })),
    };
    const data = await buildReportV1Data(termiteService, 'token-product-copy-termite', makeKnex(termiteFixtures));
    const taurus = data.applications.find((a) => a.product.name === 'Taurus SC');
    expect(taurus.product).not.toHaveProperty('report_copy');
  });

  test('gate ON: the same product on a general pest service still gets report_copy (control)', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-pest-control', makeKnex(FIXTURES));
    const taurus = data.applications.find((a) => a.product.name === 'Taurus SC');
    expect(taurus.product.report_copy).not.toBeNull();
    expect(taurus.product.report_copy.how_it_works).toMatch(/treated band/);
  });
});

// report_copy is LIVE-VIEW ONLY (codex P1 2026-09-28) — stripLiveOnlyReportProductCopy
// removes it from the payload at the same boundary stripLiveOnlyScheduleFields
// uses. buildReportV1Data itself always attaches it (mode-blind); the strip
// is the route helper's / pdf-queue's job, exercised directly here.
describe('stripLiveOnlyReportProductCopy', () => {
  const { stripLiveOnlyReportProductCopy } = require('../services/service-report/report-data');
  const ORIGINAL = process.env.GATE_REPORT_PRODUCT_COPY;
  afterEach(() => { process.env.GATE_REPORT_PRODUCT_COPY = ORIGINAL; });

  test('removes report_copy from every application product', async () => {
    process.env.GATE_REPORT_PRODUCT_COPY = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-strip', makeKnex(FIXTURES));
    const taurusBefore = data.applications.find((a) => a.product.name === 'Taurus SC');
    expect(taurusBefore.product.report_copy).not.toBeNull();
    stripLiveOnlyReportProductCopy(data);
    for (const app of data.applications) {
      expect(app.product).not.toHaveProperty('report_copy');
    }
  });

  test('is a no-op when no application carries report_copy (gate off)', async () => {
    delete process.env.GATE_REPORT_PRODUCT_COPY;
    const data = await buildReportV1Data(SERVICE, 'token-product-copy-strip-off', makeKnex(FIXTURES));
    expect(() => stripLiveOnlyReportProductCopy(data)).not.toThrow();
    for (const app of data.applications) {
      expect(app.product).not.toHaveProperty('report_copy');
    }
  });

  test('handles missing/malformed input without throwing', () => {
    expect(stripLiveOnlyReportProductCopy(null)).toBeNull();
    expect(stripLiveOnlyReportProductCopy(undefined)).toBeUndefined();
    expect(stripLiveOnlyReportProductCopy({})).toEqual({});
  });
});
