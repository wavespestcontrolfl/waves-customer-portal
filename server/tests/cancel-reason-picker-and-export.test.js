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
  test('exports zero-PII CSV with episode identifiers and omits arbitrary free text', () => {
    const csv = buildExportCsv([
      {
        id: 'cust-1',
        pipeline_stage: 'churned',
        churn_episode_id: 'ep-1111',
        churned_at: '2026-09-12',
        monthly_rate: 79,
        churn_reason: 'Jane Doe 941-555-0199 =HYPERLINK("bad")',
        case_reason_code: 'moving_or_property_change',
      },
      {
        id: 'cust-2',
        pipeline_stage: 'dormant',
        churn_episode_id: null,
        churned_at: '2026-10-01',
        monthly_rate: 55.5,
        churn_reason: 'price',
        case_reason_code: null,
      },
    ]);
    expect(csv).not.toContain('Jane Doe');
    expect(csv).not.toContain('941-555-0199');
    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      customer_id: 'cust-1',
      churn_episode_id: 'ep-1111',
      recognized_legacy_code: '',
      suggested_code: 'moving',
      new_churn_reason_code: '',
    });
    expect(parsed[1]).toMatchObject({
      customer_id: 'cust-2',
      churn_episode_id: '',
      recognized_legacy_code: 'price',
      suggested_code: 'price',
    });
  });

  test('validates filled assignments, requires episode/date guard, and rejects invalid/unclassified/duplicate rows', () => {
    const rows = [
      { __line: 2, customer_id: 'c1', pipeline_stage: 'churned', churn_episode_id: 'ep-1', churned_at: '2026-09-01', new_churn_reason_code: 'price' },
      { __line: 3, customer_id: 'c2', pipeline_stage: 'churned', churn_episode_id: '', churned_at: '2026-09-02', new_churn_reason_code: '' },
      { __line: 4, customer_id: 'c3', pipeline_stage: 'dormant', churn_episode_id: '', churned_at: '2026-09-03', new_churn_reason_code: 'results_lawn' },
      { __line: 5, customer_id: 'c4', pipeline_stage: 'churned', churn_episode_id: 'ep-4', churned_at: '2026-09-04', new_churn_reason_code: 'unclassified' },
      { __line: 6, customer_id: 'c1', pipeline_stage: 'churned', churn_episode_id: 'ep-1', churned_at: '2026-09-01', new_churn_reason_code: 'moving' },
      { __line: 7, customer_id: 'c5', pipeline_stage: 'churned', churn_episode_id: 'ep-5', churned_at: '2026-09-05', new_churn_reason_code: 'not_a_code' },
      { __line: 8, customer_id: 'c6', pipeline_stage: 'churned', churn_episode_id: '', churned_at: '', new_churn_reason_code: 'price' },
    ];
    const { accepted, errors } = validateAssignments(rows);
    expect(accepted).toEqual([
      { customerId: 'c1', code: 'price', churnEpisodeId: 'ep-1', churnedAt: '2026-09-01', pipelineStage: 'churned', line: 2 },
      { customerId: 'c3', code: 'results', churnEpisodeId: null, churnedAt: '2026-09-03', pipelineStage: 'dormant', line: 4 },
    ]);
    expect(errors).toHaveLength(4);
  });

  test('applyAssignments defaults to dry-run, skips changed churn episodes, and only updates matching unclassified rows with --confirm', async () => {
    const store = [
      { id: 'c1', pipeline_stage: 'churned', churn_episode_id: 'ep-1', churned_at: '2026-09-01', churn_reason_code: null, deleted_at: null },
      { id: 'c2', pipeline_stage: 'active_customer', churn_episode_id: null, churned_at: null, churn_reason_code: null, deleted_at: null },
      { id: 'c3', pipeline_stage: 'dormant', churn_episode_id: null, churned_at: '2026-10-01', churn_reason_code: 'unclassified', deleted_at: null },
      { id: 'c4', pipeline_stage: 'churned', churn_episode_id: 'ep-4', churned_at: '2026-09-10', churn_reason_code: 'moving', deleted_at: null },
      { id: 'c5', pipeline_stage: 'churned', churn_episode_id: 'ep-new', churned_at: '2026-11-20', churn_reason_code: null, deleted_at: null },
    ];
    const makeDb = () => {
      const runQuery = () => {
        let filterIds = null;
        let eqId = null;
        let stageEq = null;
        let episodeEq;
        let episodeNull = false;
        let dateRaw = null;
        let onlyUnclassified = false;
        const q = {
          whereIn(col, vals) {
            if (col === 'id') filterIds = vals;
            return q;
          },
          where(arg, val) {
            if (typeof arg === 'function') onlyUnclassified = true;
            else if (typeof arg === 'string') {
              if (arg === 'pipeline_stage') stageEq = val;
              if (arg === 'churn_episode_id') episodeEq = val;
            } else if (arg && arg.id) eqId = arg.id;
            return q;
          },
          whereNull(col) {
            if (col === 'churn_episode_id') episodeNull = true;
            return q;
          },
          whereRaw(_sql, binds) {
            if (Array.isArray(binds) && binds[0]) dateRaw = binds[0];
            return q;
          },
          select() {
            return Promise.resolve(store.filter((r) => !filterIds || filterIds.includes(r.id)).map((r) => ({ ...r })));
          },
          async update(patch) {
            const hits = store.filter((r) => (
              r.id === eqId
              && (!stageEq || r.pipeline_stage === stageEq)
              && (episodeEq === undefined || r.churn_episode_id === episodeEq)
              && (!episodeNull || r.churn_episode_id == null)
              && (!dateRaw || r.churned_at === dateRaw)
              && (!onlyUnclassified || r.churn_reason_code == null || r.churn_reason_code === 'unclassified')
            ));
            for (const h of hits) Object.assign(h, patch);
            return hits.length;
          },
        };
        return q;
      };
      const db = () => runQuery();
      db.raw = (sql) => sql;
      db.fn = { now: () => 'NOW' };
      db.transaction = async (fn) => fn(db);
      return db;
    };

    const db = makeDb();
    const assignments = [
      { customerId: 'c1', code: 'price', churnEpisodeId: 'ep-1', churnedAt: '2026-09-01', pipelineStage: 'churned' },
      { customerId: 'c2', code: 'moving', churnEpisodeId: 'ep-2', churnedAt: '2026-09-02', pipelineStage: 'churned' },
      { customerId: 'c3', code: 'seasonal_pause', churnEpisodeId: null, churnedAt: '2026-10-01', pipelineStage: 'dormant' },
      { customerId: 'c4', code: 'results', churnEpisodeId: 'ep-4', churnedAt: '2026-09-10', pipelineStage: 'churned' },
      { customerId: 'c5', code: 'competitor', churnEpisodeId: 'ep-old', churnedAt: '2026-09-15', pipelineStage: 'churned' },
      { customerId: 'missing', code: 'other', churnEpisodeId: 'ep-x', churnedAt: '2026-09-20', pipelineStage: 'churned' },
    ];

    const dry = await applyAssignments(db, assignments, { confirm: false });
    expect(dry.dryRun).toBe(true);
    expect(dry.applied).toBe(0);
    expect(dry.wouldApply).toBe(2);
    expect(dry.skipped).toEqual([
      { customerId: 'c2', reason: 'stage_is_active_customer' },
      { customerId: 'c4', reason: 'already_classified_moving' },
      { customerId: 'c5', reason: 'episode_changed' },
      { customerId: 'missing', reason: 'not_found' },
    ]);
    expect(store[0].churn_reason_code).toBeNull();

    const live = await applyAssignments(db, assignments, { confirm: true });
    expect(live.dryRun).toBe(false);
    expect(live.applied).toBe(2);
    expect(store[0].churn_reason_code).toBe('price');
    expect(store[2].churn_reason_code).toBe('seasonal_pause');
    expect(store[3].churn_reason_code).toBe('moving');
    expect(store[4].churn_reason_code).toBeNull();
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
