/**
 * Admin cancel-reason picker backend + zero-cost historical churn CSV tool.
 */
const { CHURN_REASON_CODES, normalizeChurnReasonCode } = require('../services/churn-reason-map');
const { stageLifecycleStamps, promoteCustomerOnBooking } = require('../services/customer-stages');
const {
  buildExportCsv,
  parseCsv,
  validateAssignments,
  applyAssignments,
  parseCliArgs,
} = require('../scripts/export-unclassified-churn');

describe('normalizeChurnReasonCode', () => {
  test('accepts direct churn taxonomy codes and maps v2 cancel codes', () => {
    for (const code of CHURN_REASON_CODES) {
      expect(normalizeChurnReasonCode(code)).toBe(code);
    }
    expect(normalizeChurnReasonCode('moving_or_property_change')).toBe('moving');
    expect(normalizeChurnReasonCode('results_pest')).toBe('results');
    expect(normalizeChurnReasonCode('away')).toBe('seasonal_pause');
  });

  test('rejects unknown codes and optionally rejects unclassified', () => {
    expect(normalizeChurnReasonCode('bogus_code')).toBeNull();
    expect(normalizeChurnReasonCode('')).toBeNull();
    expect(normalizeChurnReasonCode(null)).toBeNull();
    expect(normalizeChurnReasonCode('unclassified', { allowUnclassified: false })).toBeNull();
  });
});

describe('stageLifecycleStamps churn_reason_code handling', () => {
  const TODAY = '2026-11-27';

  test('records churn_reason_code on active -> churned and allows classifying an already-churned row', () => {
    const move = stageLifecycleStamps('active_customer', 'churned', { member_since: '2025-05-01' }, {
      today: TODAY, churnReason: 'too expensive', churnReasonCode: 'price',
    });
    expect(move).toMatchObject({
      churned_at: TODAY,
      churn_reason: 'too expensive',
      churn_reason_code: 'price',
    });

    const classify = stageLifecycleStamps('churned', 'churned', { member_since: '2025-05-01', churned_at: '2026-08-01' }, {
      today: TODAY, churnReasonCode: 'moving',
    });
    expect(classify).toEqual({ churn_reason_code: 'moving' });
  });

  test('clears churn_reason_code on reactivation and booking promotion', async () => {
    const reactivated = stageLifecycleStamps('churned', 'active_customer', {
      member_since: '2025-05-01', churned_at: '2026-08-01', churn_reason_code: 'price',
    }, { today: TODAY });
    expect(reactivated.churn_reason_code).toBeNull();

    let updated = null;
    const fakeDb = () => ({
      where: () => ({
        first: async () => ({
          id: 'c1', pipeline_stage: 'churned', member_since: '2025-05-01', active: false, churned_at: '2026-08-01',
        }),
        update: async (patch) => { updated = patch; return 1; },
      }),
    });
    const wrote = await promoteCustomerOnBooking(fakeDb, 'c1', { serviceType: 'Quarterly Pest Control Service' });
    expect(wrote).toBe(true);
    expect(updated.churn_reason_code).toBeNull();
  });
});

describe('export-unclassified-churn CLI helpers ($0 CSV workflow)', () => {
  test('exports zero-PII CSV with deterministic suggested_code and escapes spreadsheet formulas', () => {
    const csv = buildExportCsv([
      {
        id: 'cust-1',
        pipeline_stage: 'churned',
        churned_at: '2026-09-12',
        monthly_rate: 79,
        churn_reason: '=HYPERLINK("bad")',
        case_reason_code: 'moving_or_property_change',
      },
      {
        id: 'cust-2',
        pipeline_stage: 'dormant',
        churned_at: '2026-10-01',
        monthly_rate: 55.5,
        churn_reason: 'Called, asked to pause',
        case_reason_code: null,
      },
    ]);
    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      customer_id: 'cust-1',
      suggested_code: 'moving',
      new_churn_reason_code: '',
    });
    expect(parsed[0].legacy_churn_reason.startsWith("'=")).toBe(true);
    expect(parsed[1]).toMatchObject({
      customer_id: 'cust-2',
      legacy_churn_reason: 'Called, asked to pause',
      suggested_code: '',
    });
  });

  test('validates filled assignments, rejects invalid/unclassified/duplicate rows, and skips blanks', () => {
    const rows = [
      { __line: 2, customer_id: 'c1', new_churn_reason_code: 'price' },
      { __line: 3, customer_id: 'c2', new_churn_reason_code: '' },
      { __line: 4, customer_id: 'c3', new_churn_reason_code: 'results_lawn' },
      { __line: 5, customer_id: 'c4', new_churn_reason_code: 'unclassified' },
      { __line: 6, customer_id: 'c1', new_churn_reason_code: 'moving' },
      { __line: 7, customer_id: 'c5', new_churn_reason_code: 'not_a_code' },
    ];
    const { accepted, errors } = validateAssignments(rows);
    expect(accepted).toEqual([
      { customerId: 'c1', code: 'price', line: 2 },
      { customerId: 'c3', code: 'results', line: 4 },
    ]);
    expect(errors).toHaveLength(3);
  });

  test('applyAssignments defaults to dry-run and only updates still-unclassified churned/dormant rows with --confirm', async () => {
    const store = [
      { id: 'c1', pipeline_stage: 'churned', churn_reason_code: null, deleted_at: null },
      { id: 'c2', pipeline_stage: 'active_customer', churn_reason_code: null, deleted_at: null },
      { id: 'c3', pipeline_stage: 'dormant', churn_reason_code: 'unclassified', deleted_at: null },
      { id: 'c4', pipeline_stage: 'churned', churn_reason_code: 'moving', deleted_at: null },
    ];
    const makeDb = () => {
      const runQuery = () => {
        let filterIds = null;
        let eqId = null;
        let stages = null;
        let onlyUnclassified = false;
        const q = {
          whereIn(col, vals) {
            if (col === 'id') filterIds = vals;
            if (col === 'pipeline_stage') stages = vals;
            return q;
          },
          where(arg) {
            if (typeof arg === 'function') onlyUnclassified = true;
            else if (arg && arg.id) eqId = arg.id;
            return q;
          },
          whereNull() { return q; },
          select() {
            return Promise.resolve(store.filter((r) => !filterIds || filterIds.includes(r.id)).map((r) => ({ ...r })));
          },
          async update(patch) {
            const hits = store.filter((r) => (
              r.id === eqId
              && (!stages || stages.includes(r.pipeline_stage))
              && (!onlyUnclassified || r.churn_reason_code == null || r.churn_reason_code === 'unclassified')
            ));
            for (const h of hits) Object.assign(h, patch);
            return hits.length;
          },
        };
        return q;
      };
      const db = () => runQuery();
      db.fn = { now: () => 'NOW' };
      db.transaction = async (fn) => fn(db);
      return db;
    };

    const db = makeDb();
    const assignments = [
      { customerId: 'c1', code: 'price' },
      { customerId: 'c2', code: 'moving' },
      { customerId: 'c3', code: 'seasonal_pause' },
      { customerId: 'c4', code: 'results' },
      { customerId: 'missing', code: 'other' },
    ];

    const dry = await applyAssignments(db, assignments, { confirm: false });
    expect(dry.dryRun).toBe(true);
    expect(dry.applied).toBe(0);
    expect(dry.wouldApply).toBe(2);
    expect(dry.skipped).toEqual([
      { customerId: 'c2', reason: 'stage_is_active_customer' },
      { customerId: 'c4', reason: 'already_classified_moving' },
      { customerId: 'missing', reason: 'not_found' },
    ]);
    expect(store[0].churn_reason_code).toBeNull();

    const live = await applyAssignments(db, assignments, { confirm: true });
    expect(live.dryRun).toBe(false);
    expect(live.applied).toBe(2);
    expect(store[0].churn_reason_code).toBe('price');
    expect(store[2].churn_reason_code).toBe('seasonal_pause');
    expect(store[3].churn_reason_code).toBe('moving');
  });

  test('parseCliArgs parses export and apply flags cleanly', () => {
    expect(parseCliArgs(['--months', '6', '--out', '/tmp/a.csv'])).toEqual({
      months: 6, out: '/tmp/a.csv', apply: null, confirm: false,
    });
    expect(parseCliArgs(['--apply', '/tmp/a.csv', '--confirm'])).toEqual({
      months: 12, out: null, apply: '/tmp/a.csv', confirm: true,
    });
  });
});
