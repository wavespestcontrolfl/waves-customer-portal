/**
 * Draft→sent learning loop (estimator backlog PR4).
 *
 * Pins: lazy baseline capture on first PRE-SEND revise only (AI sources
 * only, post-send edits skipped, conflict = counter bump), the pure edit
 * summary (totals/contact/address/tier/interest/service-key diffs, the
 * no-baseline ⇒ sent-unedited rule, non-comparable service shapes), and
 * the first-send-only sent event with lane pulled from the baseline's
 * estimatorEngine snapshot after a revise destroyed it on the live row.
 */

let mockDbState;

function freshDbState() {
  return {
    estimates: [],
    baselines: [],
    inserts: [],
    updates: [],
    deletes: [],
  };
}

jest.mock('../models/db', () => {
  const builderFor = (table) => {
    const state = { table, insert: null, conflicted: false, wheres: [] };
    const builder = {
      insert(payload) {
        state.insert = payload;
        return builder;
      },
      onConflict() {
        return builder;
      },
      ignore() {
        mockDbState.inserts.push({ table, payload: state.insert });
        if (table === 'estimate_draft_baselines') {
          state.conflicted = mockDbState.baselines.some(
            (row) => row.estimate_id === state.insert.estimate_id,
          );
        }
        return builder;
      },
      returning: async () => (state.conflicted ? [] : [{ id: 'new-row' }]),
      where(cond) {
        state.wheres.push(cond);
        return builder;
      },
      first: async () => {
        if (table === 'knex_migrations') return mockDbState.migrationRow || null;
        const rows = table === 'estimates' ? mockDbState.estimates : mockDbState.baselines;
        const cond = state.wheres[0] || {};
        const key = cond.id !== undefined ? 'id' : 'estimate_id';
        return rows.find((row) => row[key] === cond[key]) || null;
      },
      update: async (payload) => {
        mockDbState.updates.push({ table, payload, where: state.wheres[0] });
        return 1;
      },
      del: async () => {
        mockDbState.deletes.push({ table, where: state.wheres[0] });
        return 1;
      },
    };
    return builder;
  };
  const mock = jest.fn((table) => builderFor(table));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  computeEditSummary,
  recordPreSendRevision,
  recordSentLearningEvent,
  resetDraftBaseline,
  _private,
} = require('../services/estimate-learning');

beforeEach(() => {
  jest.clearAllMocks();
  mockDbState = freshDbState();
  // Deterministic cutover per test: the module caches the ledger cutover
  // for the process lifetime, and a well-known default keeps the fixtures
  // (no created_at or far-future created_at) on the post-cutover branch.
  _private.resetLedgerCutoverCache();
  mockDbState.migrationRow = { migration_time: '2026-07-01T00:00:00Z' };
});

function baselineRow(overrides = {}) {
  return {
    estimate_id: 'est-1',
    source: 'estimator_engine',
    capture_point: 'first_revise',
    revise_count: 1,
    baseline_estimate_data: {
      engineInputs: { services: { pest: {}, lawn: {} } },
      estimatorEngine: { lane: 'yellow' },
    },
    baseline_fields: {
      address: '123 Main St, Bradenton, FL',
      customer_name: 'Caller Name',
      customer_phone: '9415550100',
      customer_email: null,
      monthly_total: 79,
      annual_total: 948,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
      service_interest: 'Pest + Lawn',
      category: 'RESIDENTIAL',
    },
    ...overrides,
  };
}

function sentRow(overrides = {}) {
  return {
    id: 'est-1',
    source: 'estimator_engine',
    sent_at: '2026-07-18T10:00:00Z',
    address: '123 Main St, Bradenton, FL',
    customer_name: 'Caller Name',
    customer_phone: '9415550100',
    customer_email: null,
    monthly_total: '79.00',
    annual_total: '948.00',
    onetime_total: '0',
    waveguard_tier: 'Bronze',
    service_interest: 'Pest + Lawn',
    category: 'RESIDENTIAL',
    estimate_data: {
      engineRequest: { services: { pest: {}, lawn: {} } },
    },
    ...overrides,
  };
}

describe('computeEditSummary', () => {
  test('no baseline ⇒ never revised ⇒ sent unedited', () => {
    const summary = computeEditSummary({ baseline: null, sentRow: sentRow() });
    expect(summary).toEqual({ reviseCount: 0, baselineCapture: null, sentUnedited: true });
  });

  test('identical baseline and sent row still counts the revise', () => {
    const summary = computeEditSummary({ baseline: baselineRow(), sentRow: sentRow() });
    expect(summary.reviseCount).toBe(1);
    expect(summary.totalsChanged).toBeUndefined();
    expect(summary.servicesComparable).toBe(true);
    // A revise happened, so even a value-identical send is not "unedited".
    expect(summary.sentUnedited).toBe(false);
  });

  test('totals, address, and service-key changes are itemized', () => {
    const summary = computeEditSummary({
      baseline: baselineRow(),
      sentRow: sentRow({
        monthly_total: '92.50',
        address: '456 Other Rd, Parrish, FL',
        estimate_data: { engineRequest: { services: { pest: {}, mosquito: {} } } },
      }),
    });
    expect(summary.totalsChanged.monthly_total).toEqual({ from: 79, to: 92.5 });
    expect(summary.totalsChanged.annual_total).toBeUndefined();
    expect(summary.addressChanged).toBe(true);
    expect(summary.servicesAdded).toEqual(['mosquito']);
    expect(summary.servicesRemoved).toEqual(['lawn']);
    expect(summary.sentUnedited).toBe(false);
  });

  test('string-vs-number totals and whitespace/case contact noise do not diff', () => {
    const summary = computeEditSummary({
      baseline: baselineRow(),
      sentRow: sentRow({ customer_name: '  caller  NAME ', monthly_total: 79 }),
    });
    expect(summary.totalsChanged).toBeUndefined();
    expect(summary.contactChanged).toBeUndefined();
  });

  test('unparseable service shapes report non-comparable, never a false empty diff', () => {
    const summary = computeEditSummary({
      baseline: baselineRow({ baseline_estimate_data: { freeform: true } }),
      sentRow: sentRow(),
    });
    expect(summary.servicesComparable).toBe(false);
    expect(summary.servicesAdded).toBeUndefined();
    expect(summary.servicesRemoved).toBeUndefined();
  });

  test('admin-builder service codes are translated to engine keys before the diff', () => {
    const summary = computeEditSummary({
      baseline: baselineRow(),
      sentRow: sentRow({
        // Admin revise persists the raw /calculate-estimate payload: an
        // ARRAY of builder codes (PEST), not the engine's object map (pest).
        estimate_data: { engineRequest: { profile: {}, selectedServices: ['PEST', 'MOSQUITO', 'PEST'], options: {} } },
      }),
    });
    expect(summary.servicesComparable).toBe(true);
    expect(summary.servicesAdded).toEqual(['mosquito']);
    expect(summary.servicesRemoved).toEqual(['lawn']);
  });

  test('the same services under builder codes are not a service change', () => {
    const summary = computeEditSummary({
      baseline: baselineRow({
        baseline_estimate_data: { engineInputs: { services: { pest: {}, oneTimePest: {}, rodentBait: {} } } },
      }),
      sentRow: sentRow({
        estimate_data: { engineRequest: { selectedServices: ['RODENT_BAIT', 'OT_PEST', 'PEST'] } },
      }),
    });
    expect(summary.servicesComparable).toBe(true);
    expect(summary.servicesAdded).toBeUndefined();
    expect(summary.servicesRemoved).toBeUndefined();
  });

  test('codes the translator does not know are not comparable, never a false change', () => {
    const summary = computeEditSummary({
      baseline: baselineRow(),
      sentRow: sentRow({ estimate_data: { engineRequest: { selectedServices: ['NOT_A_SERVICE'] } } }),
    });
    expect(summary.servicesComparable).toBe(false);
    expect(summary.servicesAdded).toBeUndefined();
    expect(summary.servicesRemoved).toBeUndefined();
  });

  test('the same property in the autocomplete form is not an address change', () => {
    const same = (a, b) => computeEditSummary({
      baseline: baselineRow({ baseline_fields: { ...baselineRow().baseline_fields, address: a } }),
      sentRow: sentRow({ address: b }),
    }).addressChanged;
    expect(same('123 Main St, Bradenton, FL', '123 Main Street, Bradenton, FL 34205, USA')).toBeUndefined();
    expect(same('123 Main St, Bradenton, FL 34205', '123 Main St Bradenton FL 34205')).toBeUndefined();
    expect(same('123 East Oak St, Bradenton, FL', '123 E Oak Street Bradenton Florida 34205')).toBeUndefined();
    // A state or ZIP on one side only is formatting.
    expect(same('123 Main St, Bradenton', '123 Main St, Bradenton, FL 34205-1234')).toBeUndefined();
    expect(same('123 Main St, Bradenton, FL 34205', '123 Main St Bradenton')).toBeUndefined();
    expect(same(null, null)).toBeUndefined();
    // Another house, street, direction, unit, city or ZIP is a real change,
    // and so is one added or dropped at the end.
    expect(same('123 Main St, Bradenton, FL', '125 Main St, Bradenton, FL')).toBe(true);
    expect(same('123 Main St, Bradenton, FL', '123 Oak St, Bradenton, FL')).toBe(true);
    expect(same('123 East Oak St, Bradenton, FL', '123 East Pine St, Bradenton, FL 34205')).toBe(true);
    expect(same('123 Oak St, Bradenton, FL', '123 Oak Ave, Bradenton, FL')).toBe(true);
    expect(same('123 Main St, Bradenton, FL', '123 Main St E, Bradenton, FL')).toBe(true);
    expect(same('123 Main St, Bradenton, FL', '123 Main St Apt 4, Bradenton, FL 34205')).toBe(true);
    expect(same('123 Main St, Bradenton, FL', '123 Main St, Sarasota, FL')).toBe(true);
    expect(same('123 Main St, Bradenton, FL 34205', '123 Main St, Bradenton, FL 34219')).toBe(true);
    expect(same('123 Main St', '123 Main St E')).toBe(true);
    expect(same('123 Main St', '123 Main St Apt 4')).toBe(true);
    expect(same('123 Main St Apt 4', '123 Main St')).toBe(true);
    // A state inserted before a ZIP both sides share is formatting.
    expect(same('123 Main St, Bradenton 34205', '123 Main St, Bradenton, FL 34205, USA')).toBeUndefined();
    expect(same('123 Main St, Bradenton, FL', '123 Main St, Bradenton 34205-1234')).toBeUndefined();
    expect(same('123 Main St, Bradenton, FL 34205-1234', '123 Main St, Bradenton, FL 34205-9999')).toBe(true);
    // A unit written after the ZIP is not a ZIP+4.
    expect(same('123 Main St, Bradenton, FL 34205', '123 Main St, Bradenton, FL 34205 #1234')).toBe(true);
    expect(same('123 Main St, Bradenton, FL 34205 #1234', '123 Main St, Bradenton, FL 34205 #5678')).toBe(true);
    // A lone four-digit ending is a unit, not a ZIP+4.
    expect(same('123 Main St, Bradenton', '123 Main St, Bradenton #1234')).toBe(true);
    expect(same('123 Main St, Bradenton, FL 34205', '123 Main St, Bradenton, FL 34205-1234')).toBeUndefined();
    expect(same('123 Main St, Bradenton', '123 Main St, Bradenton, 34205 FL')).toBe(true);
    expect(same('123 Main St', '123 Main St, Bradenton')).toBe(true);
    // Too little to match on, or one side missing.
    expect(same('123 Main', '123 Main 34205')).toBe(true);
    expect(same(null, '123 Main St')).toBe(true);
  });

  test('the display label counts only when the service keys cannot be compared', () => {
    const relabeled = { service_interest: 'Pest Control' };
    expect(computeEditSummary({ baseline: baselineRow(), sentRow: sentRow(relabeled) }).serviceInterestChanged).toBeUndefined();
    const summary = computeEditSummary({
      baseline: baselineRow({ baseline_estimate_data: { freeform: true } }),
      sentRow: sentRow(relabeled),
    });
    expect(summary.servicesComparable).toBe(false);
    expect(summary.serviceInterestChanged).toBe(true);
  });

  test('totals are compared as stored; the setup fee a builder row carries is recorded beside them', () => {
    const builderData = (oneTime) => ({ engineRequest: { selectedServices: ['PEST'] }, result: { oneTime } });
    const summary = computeEditSummary({
      baseline: baselineRow(),
      sentRow: sentRow({ onetime_total: '99.00', estimate_data: builderData({ membershipFee: 99, total: 99 }) }),
    });
    // Never netted out: whether the draft already owed the fee is not decided here.
    expect(summary.totalsChanged.onetime_total).toEqual({ from: 0, to: 99 });
    expect(summary.sentSetupFee).toBe(99);
    // An engine-shaped sent row carries no builder fee.
    const engineShape = computeEditSummary({ baseline: baselineRow(), sentRow: sentRow({ onetime_total: '99.00' }) });
    expect(engineShape.totalsChanged.onetime_total).toEqual({ from: 0, to: 99 });
    expect(engineShape.sentSetupFee).toBeUndefined();
    // Both sides builder-saved with the fee: nothing to note.
    const both = computeEditSummary({
      baseline: baselineRow({
        baseline_estimate_data: builderData({ membershipFee: 99, total: 99 }),
        baseline_fields: { ...baselineRow().baseline_fields, onetime_total: 99 },
      }),
      sentRow: sentRow({ onetime_total: '99.00', estimate_data: builderData({ membershipFee: 99, total: 99 }) }),
    });
    expect(both.totalsChanged).toBeUndefined();
    expect(both.sentSetupFee).toBeUndefined();
  });
});

describe('resetDraftBaseline', () => {
  test('drops the baseline row so the re-composed draft reads as unedited again', async () => {
    mockDbState.baselines.push(baselineRow());
    await resetDraftBaseline({ estimateId: 'est-1' });
    expect(mockDbState.deletes).toEqual([
      { table: 'estimate_draft_baselines', where: { estimate_id: 'est-1' } },
    ]);
  });

  test('rides a provided transaction executor instead of the root connection', async () => {
    const trxDeletes = [];
    const trx = () => ({
      where: (cond) => ({
        del: async () => {
          trxDeletes.push(cond);
          return 1;
        },
      }),
    });
    await resetDraftBaseline({ estimateId: 'est-1', trx });
    expect(trxDeletes).toEqual([{ estimate_id: 'est-1' }]);
    expect(mockDbState.deletes).toHaveLength(0);
  });

  test('missing estimateId is a no-op', async () => {
    expect(await resetDraftBaseline({ estimateId: null })).toBeNull();
    expect(mockDbState.deletes).toHaveLength(0);
  });
});

describe('recordPreSendRevision', () => {
  test('captures the pre-edit row for an AI draft on first revise', async () => {
    await recordPreSendRevision({
      priorEstimate: { ...sentRow(), sent_at: null, status: 'draft' },
    });
    const insert = mockDbState.inserts.find((i) => i.table === 'estimate_draft_baselines');
    expect(insert).toBeTruthy();
    expect(insert.payload.estimate_id).toBe('est-1');
    expect(insert.payload.source).toBe('estimator_engine');
    expect(insert.payload.revise_count).toBe(1);
    const fields = JSON.parse(insert.payload.baseline_fields);
    expect(fields.monthly_total).toBe(79);
    expect(mockDbState.updates).toHaveLength(0);
  });

  test('second revise bumps the counter instead of re-capturing', async () => {
    mockDbState.baselines.push(baselineRow());
    await recordPreSendRevision({
      priorEstimate: { ...sentRow(), sent_at: null, status: 'draft' },
    });
    expect(mockDbState.updates).toHaveLength(1);
    expect(mockDbState.updates[0].table).toBe('estimate_draft_baselines');
    expect(mockDbState.updates[0].payload.revise_count).toEqual({ __raw: 'revise_count + 1' });
  });

  test('manual sources and post-send edits are skipped', async () => {
    await recordPreSendRevision({
      priorEstimate: { ...sentRow(), sent_at: null, source: 'manual' },
    });
    await recordPreSendRevision({ priorEstimate: sentRow() });
    expect(mockDbState.inserts).toHaveLength(0);
    expect(mockDbState.updates).toHaveLength(0);
  });

  test('errors propagate to the caller instead of being swallowed', async () => {
    // Inside the revise transaction a caught PG error would poison the trx
    // anyway — the capture must surface failures, not pretend to be soft.
    const trx = () => ({
      insert: () => {
        throw new Error('connection reset');
      },
    });
    trx.fn = { now: () => 'NOW' };
    trx.raw = (sql) => ({ __raw: sql });
    await expect(recordPreSendRevision({
      priorEstimate: { ...sentRow(), sent_at: null, status: 'draft' },
      trx,
    })).rejects.toThrow('connection reset');
  });
});

// The recorder takes the claimed PRE-FINALIZE snapshot — sent_at is still
// null on a true first send; a set sent_at marks a resend and is skipped.
function claimedSnapshot(overrides = {}) {
  return { ...sentRow(), sent_at: null, ...overrides };
}

describe('recordSentLearningEvent', () => {
  test('never-revised AI draft stamps a sent-unedited event', async () => {
    const summary = await recordSentLearningEvent({ estimateId: 'est-1', sentRow: claimedSnapshot() });
    expect(summary.sentUnedited).toBe(true);
    const insert = mockDbState.inserts.find((i) => i.table === 'estimate_learning_events');
    expect(insert.payload.event_type).toBe('sent');
    expect(insert.payload.sent_unedited).toBe(true);
    // Lane survives on the snapshot when no revise destroyed it.
    expect(insert.payload.lane).toBeNull();
  });

  test('revised draft diffs against the baseline and recovers the lane from it', async () => {
    mockDbState.baselines.push(baselineRow());
    await recordSentLearningEvent({
      estimateId: 'est-1',
      sentRow: claimedSnapshot({ monthly_total: '95.00' }),
    });
    const insert = mockDbState.inserts.find((i) => i.table === 'estimate_learning_events');
    expect(insert.payload.lane).toBe('yellow');
    expect(insert.payload.sent_unedited).toBe(false);
    const summary = JSON.parse(insert.payload.edit_summary);
    expect(summary.totalsChanged.monthly_total).toEqual({ from: 79, to: 95 });
  });

  test('manual estimates never stamp events', async () => {
    const result = await recordSentLearningEvent({
      estimateId: 'est-1',
      sentRow: claimedSnapshot({ source: 'manual' }),
    });
    expect(result).toBeNull();
    expect(mockDbState.inserts).toHaveLength(0);
  });

  test('a resend snapshot (prior sent_at) never stamps — first send only', async () => {
    // If the first send's stamp was lost to a transient failure, a resend
    // must not back-fill it with the post-edit composition.
    const result = await recordSentLearningEvent({ estimateId: 'est-1', sentRow: sentRow() });
    expect(result).toBeNull();
    expect(mockDbState.inserts).toHaveLength(0);
  });

  test('a missing snapshot never stamps — the live row is not a substitute', async () => {
    mockDbState.estimates.push(sentRow());
    const result = await recordSentLearningEvent({ estimateId: 'est-1' });
    expect(result).toBeNull();
    expect(mockDbState.inserts).toHaveLength(0);
  });

  test('pre-ledger drafts stamp an explicit unknown, never a false unedited', async () => {
    // Draft created before the ledger migration ran, no baseline: its edit
    // history is unknowable (the capture hook did not exist yet).
    mockDbState.migrationRow = { migration_time: '2026-07-18T12:00:00Z' };
    const summary = await recordSentLearningEvent({
      estimateId: 'est-1',
      sentRow: claimedSnapshot({ created_at: '2026-07-10T09:00:00Z' }),
    });
    expect(summary).toEqual({ reviseCount: null, baselineCapture: 'pre_ledger', sentUnedited: null });
    const insert = mockDbState.inserts.find((i) => i.table === 'estimate_learning_events');
    expect(insert.payload.sent_unedited).toBeNull();
  });

  test('post-cutover drafts keep the no-baseline ⇒ unedited rule', async () => {
    mockDbState.migrationRow = { migration_time: '2026-07-18T12:00:00Z' };
    const summary = await recordSentLearningEvent({
      estimateId: 'est-1',
      sentRow: claimedSnapshot({ created_at: '2026-07-18T15:00:00Z' }),
    });
    expect(summary.sentUnedited).toBe(true);
  });

  test('drafts created in the migrate→rollout window read as unknown too', async () => {
    // Railway migrates before the app rollout — a hook-less old pod can
    // still create/revise drafts just after migration_time.
    mockDbState.migrationRow = { migration_time: '2026-07-18T12:00:00Z' };
    const summary = await recordSentLearningEvent({
      estimateId: 'est-1',
      sentRow: claimedSnapshot({ created_at: '2026-07-18T12:30:00Z' }),
    });
    expect(summary).toEqual({ reviseCount: null, baselineCapture: 'pre_ledger', sentUnedited: null });
  });

  test('the snapshot is diffed even when a customer already rewrote the live row', async () => {
    // Acceptance rewrites totals/estimate_data with the CUSTOMER's choices;
    // diffing the live row would report them as pre-send operator edits.
    mockDbState.estimates.push(sentRow({ status: 'accepted', monthly_total: '129.00' }));
    mockDbState.baselines.push(baselineRow());
    await recordSentLearningEvent({ estimateId: 'est-1', sentRow: claimedSnapshot() });
    const insert = mockDbState.inserts.find((i) => i.table === 'estimate_learning_events');
    const summary = JSON.parse(insert.payload.edit_summary);
    expect(summary.totalsChanged).toBeUndefined();
  });

  test('a failed cutover lookup stamps unknown, never a guessed unedited', async () => {
    // First-send-wins makes a wrong stamp permanent — an unreadable
    // knex_migrations row must not default a baseline-less draft to true.
    mockDbState.migrationRow = null;
    const summary = await recordSentLearningEvent({
      estimateId: 'est-1',
      sentRow: claimedSnapshot({ created_at: '2026-07-18T15:00:00Z' }),
    });
    expect(summary).toEqual({ reviseCount: null, baselineCapture: 'cutover_unknown', sentUnedited: null });
    const insert = mockDbState.inserts.find((i) => i.table === 'estimate_learning_events');
    expect(insert.payload.sent_unedited).toBeNull();
  });

  test('commercial proposal rows never stamp events — proposal edits bypass revise', async () => {
    expect(await recordSentLearningEvent({
      estimateId: 'est-1',
      sentRow: claimedSnapshot({ category: 'COMMERCIAL' }),
    })).toBeNull();
    expect(await recordSentLearningEvent({
      estimateId: 'est-1',
      sentRow: claimedSnapshot({
        estimate_data: { engineInputs: { services: { pest: {} } }, proposal: { enabled: true } },
      }),
    })).toBeNull();
    expect(mockDbState.inserts).toHaveLength(0);
  });
});
