/**
 * Backlink Manager v2 step 4a — §6.3 decision function + §3.8 policy row.
 * Table-driven: (path, domain, policy) → the required authority instances and
 * their levels. Every policy floor proves DENY beats every AUTO and OWNER
 * branch; every required signal proves null/NaN/undefined → INVALID; a waived
 * OWNER_HUMAN_STEP stays OWNER_HUMAN_STEP; a waiver is refused on INVALID.
 */
const P = require('../services/seo/link-authority-policy');
const R = require('../services/seo/link-registry');

const HASH = 'a'.repeat(64);
const defaults = () => P.normalizePolicyRow(null);
const path = (over = {}) => ({
  acquisition_type: 'self_service_free', submission_url: 'https://x.example/submit',
  estimated_cost_cents: null, currency: 'unknown', merchant_binding: null,
  account_required: false, email_verification: false, payment_required: false, legal_attestation: false,
  legal_terms_hash: null, agent_completable: true, terms_accepted_by_send: false, execution_after_send: true,
  baseline: false, link_type: 'directory', confidence: '0.80', last_investigated_at: '2026-09-02T00:00:00Z', superseded_by: null,
  ...over,
});
const domain = (over = {}) => ({ spam_score: 2, score: 75, ...over });
const paid = (over = {}) => path({
  acquisition_type: 'paid_listing', payment_required: true, estimated_cost_cents: 4500, currency: 'USD', fee_scope: 'per_location',
  merchant_binding: { checkout_origin: 'https://x.example', processor: { host: 'checkout.stripe.com', merchant_account_id: 'acct_1' } },
  ...over,
});
const outreach = (over = {}) => path({ acquisition_type: 'resource_outreach', link_type: 'resource', ...over });
const level = (r, dimension, kind = '-') => r.instances.find((i) => i.dimension === dimension && i.instance_kind === kind)?.level;

describe('shipped defaults (§6.2)', () => {
  test('every AUTO capability is off/null; floors as specified', () => {
    const d = defaults();
    expect(d).toMatchObject({
      auto_free_acquisition: false, auto_account_creation: false, auto_outreach_min_score: null, auto_outreach_daily_cap: 0,
      auto_submission_daily_cap: 0, owner_price_tolerance_cents: 0, presentment_window_days: 10, monthly_paid_budget_cents: 0,
      owner_monthly_budget_cents: null, max_auto_purchase_cents: 0, auto_paid_min_score: null, auto_paid_min_d30_confidence: null,
      min_score: 60, membership_requires_owner: true, legal_attestation_requires_owner: true, min_path_confidence: 0.6,
      max_spam_score: 10, preferred_provider: 'deterministic_runner',
    });
    expect(Object.keys(d).sort()).toEqual([...P.POLICY_FIELD_NAMES].sort());
  });
  test('pg NUMERIC strings normalize to numbers; booleans stay literal', () => {
    const d = P.normalizePolicyRow({ min_path_confidence: '0.70', auto_paid_min_d30_confidence: '0.50', auto_free_acquisition: true });
    expect(d.min_path_confidence).toBe(0.7);
    expect(d.auto_paid_min_d30_confidence).toBe(0.5);
    expect(d.auto_free_acquisition).toBe(true);
  });
  test('with defaults, every level is owner-routed — GATE_LINK_AUTHORITY would change nothing', () => {
    const d = defaults();
    const rows = [path(), path({ acquisition_type: 'self_service_account', account_required: true }), paid(), outreach(), paid({ acquisition_type: 'membership' })];
    for (const p of rows) {
      const r = P.decideAuthority({ path: p, domain: domain(), policy: d });
      expect(r.verdict).toBe('ok');
      expect(r.instances.length).toBeGreaterThan(0);
      for (const i of r.instances) expect(i.level).toMatch(/^OWNER_/);
    }
  });
});

describe('env tightening (§3.8)', () => {
  test('LINK_OUTREACH_DAILY_CAP applies only below the row', () => {
    const d = { ...defaults(), auto_outreach_daily_cap: 10 };
    expect(P.applyEnvTightening(d, { LINK_OUTREACH_DAILY_CAP: '12' })).toEqual({ policy: d, overrides: [] });
    const t = P.applyEnvTightening(d, { LINK_OUTREACH_DAILY_CAP: '4' });
    expect(t.policy.auto_outreach_daily_cap).toBe(4);
    expect(t.overrides).toEqual([{ field: 'auto_outreach_daily_cap', env: 'LINK_OUTREACH_DAILY_CAP', row: 10, applied: 4 }]);
    expect(P.applyEnvTightening(d, { LINK_OUTREACH_DAILY_CAP: 'abc' }).overrides).toEqual([]);
    expect(P.applyEnvTightening(d, { LINK_OUTREACH_DAILY_CAP: '-1' }).overrides).toEqual([]);
    // the sender's default ceiling (12) governs when the env is unset or unusable
    const high = { ...defaults(), auto_outreach_daily_cap: 20 };
    expect(P.applyEnvTightening(high, {})).toEqual({ policy: { ...high, auto_outreach_daily_cap: 12 }, overrides: [{ field: 'auto_outreach_daily_cap', env: 'LINK_OUTREACH_DAILY_CAP', row: 20, applied: 12 }] });
    expect(P.applyEnvTightening(high, { LINK_OUTREACH_DAILY_CAP: '0' }).policy.auto_outreach_daily_cap).toBe(12);
    expect(P.outreachDailyCeiling({})).toBe(P.DEFAULT_OUTREACH_DAILY_CAP);
  });
});

describe('parseField (the Policy panel contract)', () => {
  test.each([
    ['min_score', 101, /≤ 100/], ['min_score', -1, /≥ 0/], ['min_score', 1.5, /integer/], ['min_score', 'x', /number/],
    ['min_score', null, /cannot be empty/], ['min_score', true, /number/], ['min_score', [50], /number/], ['min_score', '  ', /cannot be empty|number/], ['nope', 1, /unknown policy field/], ['constructor', 1, /unknown policy field/], ['__proto__', 1, /unknown policy field/], ['preferred_provider', 'human2', /one of/],
    ['auto_free_acquisition', 'yes', /boolean/], ['min_path_confidence', 1.2, /≤ 1/],
    ['monthly_paid_budget_cents', 2147483648, /≤ 2147483647/], ['auto_outreach_daily_cap', 1e12, /≤ 2147483647/],
    ['min_path_confidence', 0.655, /at most 2 decimal places/], ['auto_paid_min_d30_confidence', '0.123', /at most 2 decimal places/],
  ])('%s = %p rejects', (name, value, re) => {
    expect(P.parseField(name, value, null).error).toMatch(re);
  });
  test('nullable thresholds accept blank; presentment window may only be raised', () => {
    expect(P.parseField('auto_outreach_min_score', '', 80)).toEqual({ value: null });
    expect(P.parseField('auto_outreach_min_score', '80', null)).toEqual({ value: 80 });
    expect(P.parseField('presentment_window_days', 9, 10).error).toMatch(/only be raised/);
    expect(P.parseField('presentment_window_days', 12, 10)).toEqual({ value: 12 });
    expect(P.parseField('auto_free_acquisition', 'true', false)).toEqual({ value: true });
    expect(P.parseField('preferred_provider', 'stagehand', 'deterministic_runner')).toEqual({ value: 'stagehand' });
    expect(P.parseField('min_path_confidence', '0.70', 0.6)).toEqual({ value: 0.7 });
    expect(P.parseField('monthly_paid_budget_cents', 2147483647, 0)).toEqual({ value: 2147483647 });
    expect(P.parseField('auto_paid_min_d30_confidence', 0.65, null)).toEqual({ value: 0.65 });
  });
});

describe('updatePolicy — the one writer, audited', () => {
  function fakeDb(row) {
    const state = { row: { id: 1, ...row }, audit: [], updates: [] };
    const q = (table) => ({
      where: () => ({
        forUpdate: () => ({ first: async () => state.row }),
        first: async () => state.row,
        update: async (u) => { state.updates.push({ table, u }); Object.assign(state.row, u); return 1; },
      }),
      insert: async (rows) => { state.audit.push(...rows); return rows.length; },
    });
    const db = Object.assign(q, { transaction: async (cb) => cb(q) });
    return { db, state };
  }
  test('rejects the whole patch on one bad field; writes nothing', async () => {
    const { db, state } = fakeDb({ min_score: 60 });
    const r = await P.updatePolicy(db, { min_score: 70, max_spam_score: -3 });
    expect(r.errors).toEqual(['max_spam_score must be ≥ 0']);
    expect(state.updates).toEqual([]);
    expect(state.audit).toEqual([]);
  });
  test('writes only changed fields, one audit row each, with actor + timestamp', async () => {
    const { db, state } = fakeDb({ min_score: 60, auto_outreach_daily_cap: 0, auto_outreach_min_score: null });
    const r = await P.updatePolicy(db, { min_score: '60', auto_outreach_daily_cap: 10, auto_outreach_min_score: 80 }, { actor: 'Adam' });
    expect(r.changed).toEqual([
      { field: 'auto_outreach_daily_cap', old: 0, new: 10 },
      { field: 'auto_outreach_min_score', old: null, new: 80 },
    ]);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].u).toMatchObject({ auto_outreach_daily_cap: 10, auto_outreach_min_score: 80, updated_by: 'Adam' });
    expect(state.updates[0].u.updated_at).toBeInstanceOf(Date);
    expect(state.updates[0].u.min_score).toBeUndefined();
    expect(state.audit).toEqual([
      { field: 'auto_outreach_daily_cap', old_value: '0', new_value: '10', changed_by: 'Adam' },
      { field: 'auto_outreach_min_score', old_value: null, new_value: '80', changed_by: 'Adam' },
    ]);
  });
  test('a no-op patch writes nothing', async () => {
    const { db, state } = fakeDb({ min_score: 60 });
    const r = await P.updatePolicy(db, { min_score: 60 });
    expect(r.changed).toEqual([]);
    expect(state.updates).toEqual([]);
  });
  test('non-object patches are rejected', async () => {
    expect(await P.updatePolicy(null, [1])).toEqual({ errors: ['patch must be an object'] });
  });
});

describe('requiredInstances (§3.3b)', () => {
  test.each([
    ['free self-service', path(), [['execution', '-']]],
    ['paid listing', paid(), [['execution', '-'], ['payment', '-']]],
    ['plain outreach', outreach(), [['communication', '-']]],
    ['outreach + account', outreach({ account_required: true }), [['execution', '-'], ['communication', '-']]],
    ['content submission', outreach({ acquisition_type: 'content_submission' }), [['execution', '-'], ['communication', '-']]],
    ['outreach + legal only', outreach({ legal_attestation: true, legal_terms_hash: HASH }), [['execution', 'terms'], ['communication', '-']]],
    ['paid guest post + terms + account', outreach({ acquisition_type: 'editorial_outreach', link_type: 'guest_post', payment_required: true, account_required: true, legal_attestation: true, legal_terms_hash: HASH }),
      [['execution', 'terms'], ['execution', '-'], ['payment', '-'], ['communication', '-']]],
  ])('%s', (_, p, expected) => {
    expect(P.requiredInstances(p).map((i) => [i.dimension, i.instance_kind])).toEqual(expected);
  });
});

describe('§6.3 1a validity — INVALID for every dimension, never overrideable', () => {
  const cases = [
    ['spam_score null', path(), domain({ spam_score: null })],
    ['spam_score NaN', path(), domain({ spam_score: 'x' })],
    ['score null', path(), domain({ score: null })],
    ['score undefined', path(), { spam_score: 1 }],
    ['confidence null', path({ confidence: null }), domain()],
    ['confidence > 1', path({ confidence: '1.20' }), domain()],
    ['not_reproducible', path({ acquisition_type: 'not_reproducible' }), domain()],
    ['unknown type', path({ acquisition_type: 'unknown' }), domain()],
    ['never investigated', path({ last_investigated_at: null }), domain()],
    ['unclaimable link_type', path({ link_type: 'sponsored_post' }), domain()],
    ['outreach type in a signup lane', outreach({ link_type: 'directory' }), domain()],
    ['signup type in an outreach lane', path({ link_type: 'resource' }), domain()],
    ['site-executed type without submission_url', path({ submission_url: null }), domain()],
    ['site-executed type with a blank submission_url', path({ submission_url: '  ' }), domain()],
    ['send-accepted terms on a signup-only type', paid({ terms_accepted_by_send: true, legal_attestation: true, legal_terms_hash: HASH, execution_after_send: true }), domain()],
    ...P.BOOLEAN_FLAGS.map((f) => [`${f} not a literal boolean`, path({ [f]: 'true' }), domain()]),
    ['paid type without payment_required', path({ acquisition_type: 'paid_listing', payment_required: false }), domain()],
    ['self_service_free with payment', path({ payment_required: true, estimated_cost_cents: 100, currency: 'USD' }), domain()],
    ['paid path without fee_scope', paid({ fee_scope: null }), domain()],
    ['paid path with an unknown fee_scope', paid({ fee_scope: 'global' }), domain()],
    ['send-accepted terms + submit-first deadlock', outreach({ execution_after_send: false, terms_accepted_by_send: true }), domain()],
    ['send-accepted terms without legal_attestation', outreach({ terms_accepted_by_send: true, legal_attestation: false, execution_after_send: true }), domain()],
    ['legal_attestation without hash', path({ legal_attestation: true, legal_terms_hash: null }), domain()],
    ['legal_attestation with malformed hash', path({ legal_attestation: true, legal_terms_hash: 'ABC' }), domain()],
    ['superseded path', path({ superseded_by: 'x' }), domain()],
    ['baseline placeholder', path({ baseline: true }), domain()],
  ];
  test.each(cases)('%s → INVALID', (_, p, d) => {
    const r = P.decideAuthority({ path: p, domain: d, policy: { ...defaults(), auto_free_acquisition: true } });
    expect(r.verdict).toBe('INVALID');
    expect(r.instances.length).toBeGreaterThan(0);
    for (const i of r.instances) expect(i.level).toBe('INVALID');
  });
  test('a floor waiver is refused on INVALID', () => {
    const r = P.decideAuthority({ path: path({ last_investigated_at: null }), domain: domain({ spam_score: 50 }), policy: defaults(), waiver: { id: 'w1' } });
    expect(r.verdict).toBe('INVALID');
  });
  test('the string confidence pg returns passes', () => {
    expect(P.decideAuthority({ path: path({ confidence: '0.70' }), domain: domain(), policy: defaults() }).verdict).toBe('ok');
  });
});

describe('§6.3 1b floors — DENY beats every AUTO_* and OWNER_* branch', () => {
  const loose = () => ({
    ...defaults(), auto_free_acquisition: true, auto_account_creation: true, auto_outreach_min_score: 50, auto_outreach_daily_cap: 10,
    monthly_paid_budget_cents: 50000, max_auto_purchase_cents: 5000, auto_paid_min_score: 50, auto_paid_min_d30_confidence: 0.5,
    membership_requires_owner: false, legal_attestation_requires_owner: false,
  });
  const rows = () => [path(), path({ acquisition_type: 'self_service_account', account_required: true }), paid(), outreach(), paid({ acquisition_type: 'membership' })];
  test.each([
    ['spam_score above max', domain({ spam_score: 11 }), {}],
    ['confidence below min', domain(), { confidence: '0.50' }],
    ['score below min', domain({ score: 59 }), {}],
  ])('%s', (_, d, pathOver) => {
    for (const base of rows()) {
      const r = P.decideAuthority({ path: { ...base, ...pathOver }, domain: d, policy: loose(), d30Confidence: 0.9, draftClean: true });
      expect(r.verdict).toBe('DENY');
      for (const i of r.instances) expect(i.level).toBe('DENY');
    }
  });
  test('a valid waiver treats floors as passed; the per-dimension decision runs normally', () => {
    const r = P.decideAuthority({ path: path(), domain: domain({ score: 10 }), policy: loose(), waiver: { id: 'w1' } });
    expect(r.verdict).toBe('ok');
    expect(level(r, 'execution')).toBe('AUTO_FREE');
    expect(r.instances[0].reason).toMatch(/floors waived \(w1\)/);
  });
  test('a waived OWNER_HUMAN_STEP dimension stays OWNER_HUMAN_STEP (unleasable)', () => {
    const r = P.decideAuthority({ path: path({ agent_completable: false }), domain: domain({ score: 10 }), policy: loose(), waiver: { id: 'w1' } });
    expect(level(r, 'execution')).toBe('OWNER_HUMAN_STEP');
  });
  test('a waiver never promotes a dimension whose AUTO switch is off', () => {
    const r = P.decideAuthority({ path: path(), domain: domain({ score: 10 }), policy: defaults(), waiver: { id: 'w1' } });
    expect(level(r, 'execution')).toBe('OWNER_FREE');
  });
});

describe('§6.3 2a execution', () => {
  test('human step wins over everything', () => {
    const r = P.decideAuthority({ path: path({ agent_completable: false, account_required: true }), domain: domain(), policy: { ...defaults(), auto_account_creation: true } });
    expect(level(r, 'execution')).toBe('OWNER_HUMAN_STEP');
  });
  test.each([['membership'], ['association'], ['sponsorship']])('%s → OWNER_MEMBERSHIP while membership_requires_owner', (t) => {
    const r = P.decideAuthority({ path: paid({ acquisition_type: t }), domain: domain(), policy: { ...defaults(), auto_free_acquisition: true } });
    expect(level(r, 'execution')).toBe('OWNER_MEMBERSHIP');
    expect(level(r, 'payment')).toBe('OWNER_PAYMENT');
  });
  test('membership with the owner switch off falls through to the account/free rules', () => {
    const r = P.decideAuthority({ path: paid({ acquisition_type: 'membership', account_required: true }), domain: domain(), policy: { ...defaults(), membership_requires_owner: false, auto_account_creation: true } });
    expect(level(r, 'execution')).toBe('AUTO_ACCOUNT');
  });
  test('account_required: AUTO_ACCOUNT only on the literal true switch', () => {
    const p = path({ acquisition_type: 'self_service_account', account_required: true });
    expect(level(P.decideAuthority({ path: p, domain: domain(), policy: { ...defaults(), auto_account_creation: true } }), 'execution')).toBe('AUTO_ACCOUNT');
    expect(level(P.decideAuthority({ path: p, domain: domain(), policy: { ...defaults(), auto_account_creation: 'true' } }), 'execution')).toBe('OWNER_ACCOUNT');
  });
  test('free: AUTO_FREE only on the literal true switch', () => {
    expect(level(P.decideAuthority({ path: path(), domain: domain(), policy: { ...defaults(), auto_free_acquisition: true } }), 'execution')).toBe('AUTO_FREE');
    expect(level(P.decideAuthority({ path: path(), domain: domain(), policy: { ...defaults(), auto_free_acquisition: 1 } }), 'execution')).toBe('OWNER_FREE');
  });
  test('accept_terms is its own instance: OWNER_LEGAL by default, AUTO_ACCOUNT/OWNER_ACCOUNT otherwise', () => {
    const p = path({ legal_attestation: true, legal_terms_hash: HASH });
    let r = P.decideAuthority({ path: p, domain: domain(), policy: defaults() });
    expect(level(r, 'execution', 'terms')).toBe('OWNER_LEGAL');
    expect(level(r, 'execution', '-')).toBe('OWNER_FREE');
    r = P.decideAuthority({ path: p, domain: domain(), policy: { ...defaults(), legal_attestation_requires_owner: false } });
    expect(level(r, 'execution', 'terms')).toBe('OWNER_ACCOUNT');
    r = P.decideAuthority({ path: p, domain: domain(), policy: { ...defaults(), legal_attestation_requires_owner: false, auto_account_creation: true } });
    expect(level(r, 'execution', 'terms')).toBe('AUTO_ACCOUNT');
  });
  test('a plain outreach path with only legal_attestation gets accept_terms ALONE, no acquire', () => {
    const r = P.decideAuthority({ path: outreach({ legal_attestation: true, legal_terms_hash: HASH }), domain: domain(), policy: defaults() });
    expect(r.instances.map((i) => [i.dimension, i.instance_kind, i.level])).toEqual([
      ['execution', 'terms', 'OWNER_LEGAL'], ['communication', '-', 'OWNER_LEGAL'],
    ]);
  });
});

describe('§6.3 2b payment — independent of the other dimensions', () => {
  const autoPolicy = () => ({ ...defaults(), monthly_paid_budget_cents: 50000, max_auto_purchase_cents: 5000, auto_paid_min_score: 70, auto_paid_min_d30_confidence: 0.6 });
  test('unparseable price → OWNER_INPUT_REQUIRED; unknown currency → OWNER_INPUT_REQUIRED; foreign → OWNER_MANUAL_PAYMENT', () => {
    expect(level(P.decideAuthority({ path: paid({ estimated_cost_cents: null }), domain: domain(), policy: defaults() }), 'payment')).toBe('OWNER_INPUT_REQUIRED');
    expect(level(P.decideAuthority({ path: paid({ estimated_cost_cents: 0 }), domain: domain(), policy: defaults() }), 'payment')).toBe('OWNER_INPUT_REQUIRED');
    expect(level(P.decideAuthority({ path: paid({ currency: 'unknown' }), domain: domain(), policy: defaults() }), 'payment')).toBe('OWNER_INPUT_REQUIRED');
    expect(level(P.decideAuthority({ path: paid({ currency: 'foreign' }), domain: domain(), policy: defaults() }), 'payment')).toBe('OWNER_MANUAL_PAYMENT');
    expect(level(P.decideAuthority({ path: paid({ currency: 'foreign', estimated_cost_cents: null }), domain: domain(), policy: defaults() }), 'payment')).toBe('OWNER_MANUAL_PAYMENT');
    // a missing fee scope is data validity, never a routing: INVALID for every dimension
    expect(P.decideAuthority({ path: paid({ fee_scope: null, currency: 'unknown' }), domain: domain(), policy: defaults() }).verdict).toBe('INVALID');
  });
  test('the price-entry park still evaluates every other dimension', () => {
    const r = P.decideAuthority({ path: paid({ estimated_cost_cents: null, account_required: true }), domain: domain(), policy: { ...defaults(), auto_account_creation: true } });
    expect(r.verdict).toBe('ok');
    expect(level(r, 'execution')).toBe('AUTO_ACCOUNT');
    expect(level(r, 'payment')).toBe('OWNER_INPUT_REQUIRED');
  });
  test('no merchant binding → OWNER_MANUAL_PAYMENT even inside policy; a processor host alone never binds a merchant', () => {
    for (const mb of [
      null, {}, { checkout_origin: '' }, { checkout_origin: 'https://x', processor: {} },
      { checkout_origin: 'https://x', processor: { host: 'checkout.stripe.com' } },
      { checkout_origin: 'https://x', processor: { host: 'checkout.stripe.com', merchant_account_id: '' } },
      { checkout_origin: 'https://x', processor: { host: 'checkout.stripe.com', merchant_account_id: '   ' } },
      { checkout_origin: 'https://x', processor: { host: '', merchant_account_id: 'acct_1' } },
      { checkout_origin: 'https://x', processor: ['checkout.stripe.com', 'acct_1'] },
    ]) {
      const r = P.decideAuthority({ path: paid({ merchant_binding: mb }), domain: domain(), policy: autoPolicy(), d30Confidence: 0.9 });
      expect(level(r, 'payment')).toBe('OWNER_MANUAL_PAYMENT');
      expect(r.instances.some((i) => i.level === 'AUTO_PAID_WITHIN_POLICY')).toBe(false);
    }
    expect(P.isValidMerchantBinding({ checkout_origin: 'https://x', processor: { host: 'checkout.stripe.com', merchant_account_id: 'acct_1' } })).toBe(true);
  });
  test('AUTO_PAID_WITHIN_POLICY only when every input is configured, in range, and evidenced', () => {
    const ok = P.decideAuthority({ path: paid(), domain: domain(), policy: autoPolicy(), d30Confidence: 0.7, monthSpendCents: 40000 });
    expect(level(ok, 'payment')).toBe('AUTO_PAID_WITHIN_POLICY');
    const owner = (over, extra = {}) => level(P.decideAuthority({ path: paid(), domain: domain(), policy: { ...autoPolicy(), ...over }, d30Confidence: 0.7, monthSpendCents: 0, ...extra }), 'payment');
    expect(owner({ max_auto_purchase_cents: 0 })).toBe('OWNER_PAYMENT');
    expect(owner({ monthly_paid_budget_cents: 0 })).toBe('OWNER_PAYMENT');
    expect(owner({ auto_paid_min_score: null })).toBe('OWNER_PAYMENT');
    expect(owner({ auto_paid_min_d30_confidence: null })).toBe('OWNER_PAYMENT');
    expect(owner({ auto_paid_min_d30_confidence: 1.5 })).toBe('OWNER_PAYMENT');
    expect(owner({ max_auto_purchase_cents: 4499 })).toBe('OWNER_PAYMENT');
    expect(owner({ auto_paid_min_score: 76 })).toBe('OWNER_PAYMENT');
    expect(owner({}, { d30Confidence: null })).toBe('OWNER_PAYMENT');
    expect(owner({}, { d30Confidence: NaN })).toBe('OWNER_PAYMENT');
    expect(owner({}, { d30Confidence: 0.59 })).toBe('OWNER_PAYMENT');
    expect(owner({}, { monthSpendCents: 45501 })).toBe('OWNER_PAYMENT');
    expect(owner({}, { monthSpendCents: NaN })).toBe('OWNER_PAYMENT');
    expect(owner({}, { monthSpendCents: 45500 })).toBe('AUTO_PAID_WITHIN_POLICY');
  });
  test('a paid membership carries BOTH OWNER_MEMBERSHIP and its payment verdict', () => {
    const r = P.decideAuthority({ path: paid({ acquisition_type: 'membership' }), domain: domain(), policy: autoPolicy(), d30Confidence: 0.9 });
    expect(level(r, 'execution')).toBe('OWNER_MEMBERSHIP');
    expect(level(r, 'payment')).toBe('AUTO_PAID_WITHIN_POLICY');
  });
});

describe('§6.3 2c communication', () => {
  const mandate = () => ({ ...defaults(), auto_outreach_min_score: 80, auto_outreach_daily_cap: 10 });
  test('OWNER_OUTREACH without a clean draft, AUTO_OUTREACH with one inside the mandate', () => {
    expect(level(P.decideAuthority({ path: outreach(), domain: domain({ score: 90 }), policy: mandate() }), 'communication')).toBe('OWNER_OUTREACH');
    expect(level(P.decideAuthority({ path: outreach(), domain: domain({ score: 90 }), policy: mandate(), draftClean: true }), 'communication')).toBe('AUTO_OUTREACH');
    expect(level(P.decideAuthority({ path: outreach(), domain: domain({ score: 79 }), policy: mandate(), draftClean: true }), 'communication')).toBe('OWNER_OUTREACH');
    expect(level(P.decideAuthority({ path: outreach(), domain: domain({ score: 90 }), policy: { ...mandate(), auto_outreach_daily_cap: 0 }, draftClean: true }), 'communication')).toBe('OWNER_OUTREACH');
    expect(level(P.decideAuthority({ path: outreach(), domain: domain({ score: 90 }), policy: { ...mandate(), auto_outreach_min_score: null }, draftClean: true }), 'communication')).toBe('OWNER_OUTREACH');
    expect(level(P.decideAuthority({ path: outreach(), domain: domain({ score: 90 }), policy: mandate(), draftClean: 'true' }), 'communication')).toBe('OWNER_OUTREACH');
  });
  test('a signed agreement is never sent under AUTO_OUTREACH', () => {
    const r = P.decideAuthority({ path: outreach({ legal_attestation: true, legal_terms_hash: HASH }), domain: domain({ score: 95 }), policy: mandate(), draftClean: true });
    expect(level(r, 'communication')).toBe('OWNER_LEGAL');
    expect(level(r, 'execution', 'terms')).toBe('OWNER_LEGAL');
  });
  test('a paid guest post needs BOTH a payment and a communication verdict', () => {
    const r = P.decideAuthority({ path: outreach({ acquisition_type: 'editorial_outreach', link_type: 'guest_post', payment_required: true, estimated_cost_cents: 20000, currency: 'USD', fee_scope: 'per_location' }), domain: domain({ score: 90 }), policy: mandate(), draftClean: true });
    expect(level(r, 'payment')).toBe('OWNER_MANUAL_PAYMENT'); // no merchant binding yet
    expect(level(r, 'communication')).toBe('AUTO_OUTREACH');
    expect(r.instances.map((i) => i.dimension)).toEqual(['payment', 'communication']);
  });
});

describe('levels agree with the registry enum', () => {
  test('every level the function can emit is in AUTHORITY_LEVELS', () => {
    for (const l of Object.values(P.LEVELS)) expect(R.AUTHORITY_LEVELS).toContain(l);
  });
});

describe('decision-inputs hash (§3.6b — per dimension + shared floors)', () => {
  const ctx = () => ({ path: paid({ legal_attestation: true, legal_terms_hash: HASH }), domain: domain(), policy: defaults() });
  test('stable under key order and identical objects', () => {
    const a = ctx();
    const b = { ...ctx(), path: Object.fromEntries(Object.entries(a.path).reverse()) };
    for (const d of ['payment', 'communication', 'execution']) expect(P.decisionInputsHash(d, a)).toBe(P.decisionInputsHash(d, b));
  });
  test('a price change moves the payment hash only; a submission_url change moves execution only', () => {
    const a = ctx();
    const price = { ...a, path: { ...a.path, estimated_cost_cents: 9999 } };
    expect(P.decisionInputsHash('payment', price)).not.toBe(P.decisionInputsHash('payment', a));
    expect(P.decisionInputsHash('communication', price)).toBe(P.decisionInputsHash('communication', a));
    expect(P.decisionInputsHash('execution', price)).toBe(P.decisionInputsHash('execution', a));
    const url = { ...a, path: { ...a.path, submission_url: 'https://x.example/other' } };
    expect(P.decisionInputsHash('execution', url)).not.toBe(P.decisionInputsHash('execution', a));
    expect(P.decisionInputsHash('payment', url)).toBe(P.decisionInputsHash('payment', a));
  });
  test('the instance key is part of EVERY dimension\'s hash: generation 2 never hashes like generation 1', () => {
    const a = { ...ctx(), instanceKey: '-:1' };
    const b = { ...a, instanceKey: '-:2' };
    for (const d of ['payment', 'communication', 'execution']) {
      expect(P.decisionInputs(d, a)).toMatchObject({ instance_key: '-:1' });
      expect(P.decisionInputsHash(d, a)).not.toBe(P.decisionInputsHash(d, b));
    }
    expect(P.decisionInputs('payment', ctx())).toMatchObject({ instance_key: null });
  });
  test('the currency attestation (id on the path + the immutable row hash via ctx.attestation) is a PAYMENT input only', () => {
    const a = ctx();
    expect(P.decisionInputs('payment', a)).toMatchObject({ currency_attestation_id: null, currency_attestation_hash: null });
    const withId = { ...a, path: { ...a.path, currency_attestation_id: 'att-1' } };
    const withHash = { ...withId, attestation: { hash: 'h'.repeat(64) } };
    expect(P.decisionInputs('payment', withHash)).toMatchObject({ currency_attestation_id: 'att-1', currency_attestation_hash: 'h'.repeat(64) });
    expect(P.decisionInputsHash('payment', withId)).not.toBe(P.decisionInputsHash('payment', a));
    expect(P.decisionInputsHash('payment', withHash)).not.toBe(P.decisionInputsHash('payment', withId));
    for (const d of ['communication', 'execution']) expect(P.decisionInputsHash(d, withHash)).toBe(P.decisionInputsHash(d, a));
  });
  test('legal_terms_hash moves EVERY dimension (§3.3b: all three revisions bump on a terms change)', () => {
    const a = ctx();
    const b = { ...a, path: { ...a.path, legal_terms_hash: 'b'.repeat(64) } };
    for (const d of ['payment', 'communication', 'execution']) expect(P.decisionInputsHash(d, b)).not.toBe(P.decisionInputsHash(d, a));
  });
  test('a moved floor or floor policy value moves every dimension and the floors hash; an unrelated policy field moves nothing', () => {
    const a = ctx();
    const spam = { ...a, domain: { ...a.domain, spam_score: 9 } };
    const floor = { ...a, policy: { ...a.policy, min_score: 70 } };
    const other = { ...a, policy: { ...a.policy, auto_outreach_daily_cap: 10 } };
    for (const d of ['payment', 'communication', 'execution']) {
      expect(P.decisionInputsHash(d, spam)).not.toBe(P.decisionInputsHash(d, a));
      expect(P.decisionInputsHash(d, floor)).not.toBe(P.decisionInputsHash(d, a));
      expect(P.decisionInputsHash(d, other)).toBe(P.decisionInputsHash(d, a));
    }
    expect(P.floorInputsHash(spam)).not.toBe(P.floorInputsHash(a));
    expect(P.floorInputsHash(floor)).not.toBe(P.floorInputsHash(a));
    expect(P.floorInputsHash(other)).toBe(P.floorInputsHash(a));
    expect(P.floorInputsHash({ ...a, path: { ...a.path, estimated_cost_cents: 1 } })).toBe(P.floorInputsHash(a));
  });
  test('every DIMENSION_INPUT_FIELDS field is present in decisionInputs (null when the path lacks it)', () => {
    for (const [d, fields] of Object.entries(P.DIMENSION_INPUT_FIELDS)) {
      const inputs = P.decisionInputs(d, { path: {}, domain: {}, policy: defaults() });
      for (const f of fields) expect(inputs).toHaveProperty(f, null);
      expect(inputs.floors).toEqual(expect.objectContaining({ min_score: 60 }));
    }
    expect(() => P.decisionInputs('nope', {})).toThrow(/unknown authority dimension/);
  });
});
