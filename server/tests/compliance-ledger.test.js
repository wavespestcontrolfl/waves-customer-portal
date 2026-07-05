/**
 * FDACS compliance ledger wiring (property_application_history).
 *
 * The corrected ComplianceService.createComplianceRecords is the single
 * source of truth for ledger writes: the live V2 completion calls it INSIDE
 * the completion transaction ({ trx }), the legacy admin-schedule path calls
 * it fire-and-forget with no trx. These tests pin:
 *   - the full DACS column set (target_pest, area, weather, quantity,
 *     applicator license) the inspector export reads,
 *   - idempotency on double-complete / retry (service_product_id dedupe +
 *     ON CONFLICT backstop + legacy-row fallback),
 *   - the legacy call shape still writing,
 *   - application-limits annual caps counting writer-shaped rows,
 *   - the backfill dry-run summary shape.
 *
 * NOTE: jest.clearAllMocks() does NOT clear mockReturnValueOnce queues —
 * beforeEach uses mockReset() on the db fn.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const ComplianceService = require('../services/compliance');
const applicationLimits = require('../services/application-limits');
const { runBackfill } = require('../scripts/backfill-compliance-ledger');

function chain({ rows = [], first: firstVal, returningRows } = {}) {
  const q = {};
  for (const m of [
    'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'andWhere',
    'select', 'orderBy', 'orderByRaw', 'limit', 'leftJoin', 'modify',
    'whereExists', 'whereNotExists',
  ]) {
    q[m] = jest.fn(() => q);
  }
  q.first = jest.fn(async () => firstVal);
  q.insert = jest.fn((row) => { q.insertedRow = row; return q; });
  q.onConflict = jest.fn(() => q);
  q.ignore = jest.fn(() => q);
  q.returning = jest.fn(async () => (returningRows !== undefined ? returningRows : [q.insertedRow]));
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  q.catch = (fn) => Promise.resolve(rows).catch(fn);
  return q;
}

const SERVICE_RECORD = {
  id: 'rec-1',
  customer_id: 'cust-1',
  technician_id: 'tech-1',
  service_date: '2026-07-01',
  status: 'completed',
  soil_temp: null,
  conditions: {
    sky: 'Partly cloudy',
    temp_f: 84.2,
    humidity_pct: 71,
    wind_mph: 6.4,
    soil_temp_f: 78.1,
    provider: 'open_meteo',
  },
};

// Shape the V2 completion inserts into service_products.
const V2_SERVICE_PRODUCT = {
  id: 'sp-1',
  service_record_id: 'rec-1',
  product_id: 'prod-1',
  product_name: 'Demand CS',
  product_category: 'insecticide',
  active_ingredient: null,
  moa_group: 'Group 3A',
  application_rate: '0.5',
  rate_unit: 'oz',
  total_amount: '2.5',
  amount_unit: 'oz',
  application_method: 'perimeter_spray',
  application_area: 'perimeter',
  epa_reg_number: null,
  targets: ['ants', 'german_roaches'],
  area_value: '1200.00',
  area_unit: 'sqft',
  notes: null,
};

const CATALOG_PRODUCT = {
  id: 'prod-1',
  name: 'Demand CS',
  active_ingredient: 'Lambda-cyhalothrin',
  moa_group: 'Group 3A',
  category: 'insecticide',
  epa_registration_number: '100-1066',
  restricted_use: false,
};

const TECH = { id: 'tech-1', name: 'Adam', fl_applicator_license: 'JB351547' };

describe('ComplianceService.createComplianceRecords (corrected writer)', () => {
  beforeEach(() => {
    db.mockReset();
    db.transaction = jest.fn(async (fn) => fn(db));
  });

  test('live-path write carries the full DACS column set the export reads', async () => {
    const insertChain = chain();
    db
      .mockReturnValueOnce(chain({ first: SERVICE_RECORD }))
      .mockReturnValueOnce(chain({ rows: [V2_SERVICE_PRODUCT] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [] })) // no existing ledger rows
      .mockReturnValueOnce(chain({ first: CATALOG_PRODUCT }))
      .mockReturnValueOnce(insertChain);

    const records = await ComplianceService.createComplianceRecords('rec-1');

    expect(records).toHaveLength(1);
    expect(insertChain.insert).toHaveBeenCalledTimes(1);
    const row = insertChain.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      customer_id: 'cust-1',
      service_record_id: 'rec-1',
      service_product_id: 'sp-1',
      product_id: 'prod-1',
      technician_id: 'tech-1',
      application_date: '2026-07-01',
      // quantity = amount actually applied, not the rate
      quantity_applied: 2.5,
      quantity_unit: 'oz',
      application_rate: '0.5',
      rate_unit: 'oz',
      active_ingredient: 'Lambda-cyhalothrin',
      moa_group: 'Group 3A',
      category: 'insecticide',
      epa_registration_number: '100-1066',
      application_method: 'perimeter_spray',
      // targets joined verbatim (underscores humanized), never guessed
      target_pest: 'ants, german roaches',
      // explicit sqft only
      area_treated_sqft: 1200,
      application_site: 'perimeter',
      // weather from service_records.conditions
      weather_conditions: 'Partly cloudy 84F 71% RH',
      wind_speed_mph: 6,
      soil_temp_f: 78.1,
      restricted_use: false,
      applicator_license: 'JB351547',
    });
    // Idempotency backstop on the unique product-row link.
    expect(insertChain.onConflict).toHaveBeenCalledWith('service_product_id');
    expect(insertChain.ignore).toHaveBeenCalled();
  });

  test('runs every query through the provided trx (completion-transaction call shape)', async () => {
    const trx = jest.fn();
    trx
      .mockReturnValueOnce(chain({ first: SERVICE_RECORD }))
      .mockReturnValueOnce(chain({ rows: [V2_SERVICE_PRODUCT] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [] }))
      .mockReturnValueOnce(chain({ first: CATALOG_PRODUCT }))
      .mockReturnValueOnce(chain());

    const records = await ComplianceService.createComplianceRecords('rec-1', { trx });

    expect(records).toHaveLength(1);
    expect(trx).toHaveBeenCalledTimes(6);
    // Nothing may escape the completion transaction — a half-committed
    // ledger is the exact failure mode this wiring exists to prevent.
    expect(db).not.toHaveBeenCalled();
  });

  test('double-complete / retry: a product row already ledgered by id is skipped', async () => {
    db
      .mockReturnValueOnce(chain({ first: SERVICE_RECORD }))
      .mockReturnValueOnce(chain({ rows: [V2_SERVICE_PRODUCT] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [{ service_product_id: 'sp-1', product_id: 'prod-1' }] }));

    const records = await ComplianceService.createComplianceRecords('rec-1');

    expect(records).toEqual([]);
    // sr + products + tech + existing scan — no catalog lookup, no insert.
    expect(db).toHaveBeenCalledTimes(4);
  });

  test('concurrent retry: ON CONFLICT ignore means a lost race adds no row to the result', async () => {
    db
      .mockReturnValueOnce(chain({ first: SERVICE_RECORD }))
      .mockReturnValueOnce(chain({ rows: [V2_SERVICE_PRODUCT] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [] }))
      .mockReturnValueOnce(chain({ first: CATALOG_PRODUCT }))
      .mockReturnValueOnce(chain({ returningRows: [] })); // conflict → DO NOTHING

    const records = await ComplianceService.createComplianceRecords('rec-1');

    expect(records).toEqual([]);
  });

  test('pre-refactor legacy row (NULL service_product_id) dedupes by catalog product', async () => {
    db
      .mockReturnValueOnce(chain({ first: SERVICE_RECORD }))
      .mockReturnValueOnce(chain({ rows: [V2_SERVICE_PRODUCT] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [{ service_product_id: null, product_id: 'prod-1' }] }))
      .mockReturnValueOnce(chain({ first: CATALOG_PRODUCT }));

    const records = await ComplianceService.createComplianceRecords('rec-1');

    expect(records).toEqual([]);
    expect(db).toHaveBeenCalledTimes(5); // catalog looked up, insert never reached
  });

  test('unidentifiable legacy row + unidentifiable product: skip, never risk a ledger duplicate', async () => {
    const namelessProduct = { ...V2_SERVICE_PRODUCT, id: 'sp-2', product_id: null, product_name: 'Hand-mixed bait' };
    db
      .mockReturnValueOnce(chain({ first: SERVICE_RECORD }))
      .mockReturnValueOnce(chain({ rows: [namelessProduct] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [{ service_product_id: null, product_id: null }] }))
      .mockReturnValueOnce(chain({ first: undefined })); // ilike catalog match misses

    const records = await ComplianceService.createComplianceRecords('rec-1');

    expect(records).toEqual([]);
  });

  test('legacy path call shape (no trx, legacy product columns) still writes', async () => {
    const legacySr = { ...SERVICE_RECORD, conditions: null };
    const legacySp = {
      id: 'sp-legacy',
      service_record_id: 'rec-1',
      product_name: 'Talstar P',
      product_category: 'insecticide',
      application_rate: '1.0',
      rate_unit: 'oz',
      notes: 'perimeter band',
      // no product_id / targets / area_value / total_amount columns populated
    };
    const insertChain = chain();
    db
      .mockReturnValueOnce(chain({ first: legacySr }))
      .mockReturnValueOnce(chain({ rows: [legacySp] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [] }))
      .mockReturnValueOnce(chain({ first: undefined })) // no catalog match
      .mockReturnValueOnce(insertChain);

    const records = await ComplianceService.createComplianceRecords('rec-1');

    expect(records).toHaveLength(1);
    const row = insertChain.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      service_product_id: 'sp-legacy',
      product_id: null,
      application_rate: '1.0',
      rate_unit: 'oz',
      applicator_license: 'JB351547',
      notes: 'perimeter band',
    });
    // Conservative NULLs — no data, no guess.
    expect(row.target_pest).toBeNull();
    expect(row.area_treated_sqft).toBeNull();
    expect(row.weather_conditions).toBeNull();
    expect(row.wind_speed_mph).toBeNull();
    // Rate is never misreported as quantity.
    expect(row.quantity_applied).toBeNull();
    expect(row.quantity_unit).toBeNull();
  });

  test('linear_ft area is never converted into area_treated_sqft', async () => {
    const linearFt = { ...V2_SERVICE_PRODUCT, id: 'sp-3', area_value: '180', area_unit: 'linear_ft' };
    const insertChain = chain();
    db
      .mockReturnValueOnce(chain({ first: SERVICE_RECORD }))
      .mockReturnValueOnce(chain({ rows: [linearFt] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [] }))
      .mockReturnValueOnce(chain({ first: CATALOG_PRODUCT }))
      .mockReturnValueOnce(insertChain);

    await ComplianceService.createComplianceRecords('rec-1');

    expect(insertChain.insert.mock.calls[0][0].area_treated_sqft).toBeNull();
  });
});

describe('application-limits annual caps count writer-shaped ledger rows', () => {
  beforeEach(() => {
    db.mockReset();
  });

  test('three live-path Celsius rows this year hard-block the fourth application', async () => {
    const celsius = {
      id: 'prod-celsius',
      name: 'Celsius WG',
      moa_group: null,
      category: 'herbicide',
    };
    // Rows exactly as the corrected writer inserts them on the live path.
    const writerShapedHistory = ['2026-02-10', '2026-04-15', '2026-06-20'].map((date, i) => ({
      id: `pah-${i}`,
      customer_id: 'cust-1',
      service_record_id: `rec-${i}`,
      service_product_id: `sp-${i}`,
      product_id: 'prod-celsius',
      application_date: date,
      application_rate: '0.05',
    }));
    db
      .mockReturnValueOnce(chain({ first: celsius }))                 // products_catalog
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', city: 'Bradenton' } })) // customers
      .mockReturnValueOnce(chain({ rows: writerShapedHistory }))      // product history
      .mockReturnValueOnce(chain({
        rows: [{
          id: 'lim-1', product_id: 'prod-celsius', match_type: 'product',
          limit_type: 'annual_max_apps', limit_value: 3, severity: 'hard_block',
          description: 'Celsius WG: max 3 applications per year per property.',
        }],
      })); // product_limits (no moa_group → moa queries skipped)

    const result = await applicationLimits.checkLimits('cust-1', 'prod-celsius', new Date('2026-07-04T12:00:00Z'));

    expect(result.allowed).toBe(false);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ type: 'annual_max_apps', current: 3, max: 3 });
  });
});

describe('backfill-compliance-ledger dry-run', () => {
  beforeEach(() => {
    db.mockReset();
    // Pass-through transaction: propagate the writer's rows AND the dry-run
    // rollback sentinel exactly like knex (thrown error rejects the trx).
    db.transaction = jest.fn(async (fn) => fn(db));
  });

  test('dry-run reports counts + sample without executing, and rolls the write back', async () => {
    const candidate = {
      id: 'rec-9',
      customer_id: 'cust-1',
      service_date: '2026-06-12',
      service_type: 'Quarterly Pest Control Service',
      status: 'completed',
    };
    const insertChain = chain();
    db
      .mockReturnValueOnce(chain({ rows: [candidate] }))           // candidate batch 1
      // inside the (rolled back) transaction — writer sequence:
      .mockReturnValueOnce(chain({ first: { ...SERVICE_RECORD, id: 'rec-9' } }))
      .mockReturnValueOnce(chain({ rows: [{ ...V2_SERVICE_PRODUCT, service_record_id: 'rec-9' }] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [] }))
      .mockReturnValueOnce(chain({ first: CATALOG_PRODUCT }))
      .mockReturnValueOnce(insertChain)
      // sample enrichment: catalog name
      .mockReturnValueOnce(chain({ first: { name: 'Demand CS' } }))
      // candidate batch 2 → done
      .mockReturnValueOnce(chain({ rows: [] }));

    const summary = await runBackfill({ execute: false });

    expect(summary).toMatchObject({
      executed: false,
      recordsScanned: 1,
      recordsReconstructed: 1,
      rowsWritten: 1,
      rowsMissingTargetPest: 0,
    });
    expect(summary.samples).toHaveLength(1);
    expect(summary.samples[0]).toMatchObject({
      serviceRecordId: 'rec-9',
      applicationDate: '2026-07-01',
      product: 'Demand CS',
      targetPest: 'ants, german roaches',
      areaTreatedSqft: 1200,
      quantityApplied: 2.5,
      quantityUnit: 'oz',
      weather: 'Partly cloudy 84F 71% RH',
      applicatorLicense: 'JB351547',
    });
    // The reconstruction ran inside a transaction that the dry-run aborts.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('a record whose products are already covered by legacy rows counts as scanned, not reconstructed', async () => {
    const candidate = { id: 'rec-legacy', customer_id: 'cust-1', service_date: '2026-03-01', service_type: 'Pest', status: 'completed' };
    db
      .mockReturnValueOnce(chain({ rows: [candidate] }))
      .mockReturnValueOnce(chain({ first: SERVICE_RECORD }))
      .mockReturnValueOnce(chain({ rows: [V2_SERVICE_PRODUCT] }))
      .mockReturnValueOnce(chain({ first: TECH }))
      .mockReturnValueOnce(chain({ rows: [{ service_product_id: null, product_id: 'prod-1' }] }))
      .mockReturnValueOnce(chain({ first: CATALOG_PRODUCT }))
      .mockReturnValueOnce(chain({ rows: [] })); // batch 2 → done

    const summary = await runBackfill({ execute: false });

    expect(summary).toMatchObject({
      recordsScanned: 1,
      recordsReconstructed: 0,
      rowsWritten: 0,
    });
    expect(summary.samples).toEqual([]);
  });
});
