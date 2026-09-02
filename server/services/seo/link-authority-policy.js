/**
 * Backlink Manager v2 — acquisition authority policy + decision
 * (docs/design/backlink-manager-plan.md §3.8, §6.1–6.3; step 4 PR 1 of 4).
 *
 * Two things live here:
 *
 *  1. The POLICY ROW — `seo_link_policy` (single row, id = 1) is the ONLY
 *     source of authority/spend thresholds. `loadPolicy()` returns the row
 *     with environment TIGHTENING applied (an env value counts only when it is
 *     more restrictive than the row — a lower cap — never when it would
 *     loosen; the applied overrides are reported so an audit can see which
 *     limit actually bound). `updatePolicy()` is the ONE writer: validated,
 *     typed, and every changed field lands in `seo_link_policy_audit`.
 *
 *  2. `decideAuthority()` — the PURE §6.3 decision: (path, domain, policy,
 *     evidence) → the SET of required authority instances, one per dimension
 *     the path touches (execution `acquire` / `accept_terms`, payment,
 *     communication). No I/O, no clock, no randomness. Validity (§6.3 1a) and
 *     the quality floors (1b) are evaluated first and are fail-closed: a row
 *     that fails validity is INVALID for every dimension (nobody can act, the
 *     owner included); a row that fails a floor is DENY unless the caller
 *     presents a valid floor waiver. Policy thresholds are compared ONLY when
 *     configured — `null >= 0` is true in JS, so an unconfigured AUTO
 *     capability is simply absent, never a comparison.
 *
 * Nothing here writes authority rows, leases, sends, or spends: the bridge
 * job, owner cards and the claim-predicate re-check are the later step-4 PRs.
 */

const {
  ATTEMPT_PROVIDERS, PAID_ACQUISITION_TYPES, OUTREACH_ACQUISITION_TYPES, ACQUISITION_TYPES, CURRENCIES, PATH_LINK_TYPES,
} = require('./link-registry');

const MEMBERSHIP_TYPES = Object.freeze(['membership', 'association', 'sponsorship']);
// §3.2: every authority-relevant flag is NOT NULL and must be a literal boolean
const BOOLEAN_FLAGS = Object.freeze([
  'account_required', 'email_verification', 'payment_required', 'legal_attestation',
  'agent_completable', 'terms_accepted_by_send', 'execution_after_send',
]);

// ---------------------------------------------------------------------------
// Policy fields — the §6.2 table. `type` drives parsing + validation in
// updatePolicy; `env` names the ONLY environment variable allowed to tighten
// the field (the hard ceiling the sender already enforces).
// ---------------------------------------------------------------------------
const POLICY_FIELDS = Object.freeze({
  auto_free_acquisition: { type: 'boolean', default: false },
  auto_account_creation: { type: 'boolean', default: false },
  auto_outreach_min_score: { type: 'int', nullable: true, min: 0, max: 100, default: null },
  auto_outreach_daily_cap: { type: 'int', min: 0, default: 0, env: 'LINK_OUTREACH_DAILY_CAP' },
  auto_submission_daily_cap: { type: 'int', min: 0, default: 0 },
  owner_price_tolerance_cents: { type: 'int', min: 0, default: 0 },
  presentment_window_days: { type: 'int', min: 0, default: 10, raiseOnly: true },
  monthly_paid_budget_cents: { type: 'int', min: 0, default: 0 },
  owner_monthly_budget_cents: { type: 'int', nullable: true, min: 0, default: null },
  max_auto_purchase_cents: { type: 'int', min: 0, default: 0 },
  auto_paid_min_score: { type: 'int', nullable: true, min: 0, max: 100, default: null },
  auto_paid_min_d30_confidence: { type: 'number', nullable: true, min: 0, max: 1, default: null },
  min_score: { type: 'int', min: 0, max: 100, default: 60 },
  membership_requires_owner: { type: 'boolean', default: true },
  legal_attestation_requires_owner: { type: 'boolean', default: true },
  min_path_confidence: { type: 'number', min: 0, max: 1, default: 0.6 },
  max_spam_score: { type: 'int', min: 0, default: 10 },
  preferred_provider: { type: 'enum', values: ATTEMPT_PROVIDERS, default: 'deterministic_runner' },
});
const POLICY_FIELD_NAMES = Object.freeze(Object.keys(POLICY_FIELDS));

const configured = (x) => typeof x === 'number' && Number.isFinite(x);

// pg returns NUMERIC/DECIMAL as strings — normalize once, here.
function normalizePolicyRow(row) {
  const out = {};
  for (const name of POLICY_FIELD_NAMES) {
    const spec = POLICY_FIELDS[name];
    const v = row ? row[name] : undefined;
    if (v === null || v === undefined) out[name] = spec.type === 'boolean' ? spec.default : (spec.nullable ? null : spec.default);
    else if (spec.type === 'boolean') out[name] = v === true || v === 'true';
    else if (spec.type === 'enum') out[name] = String(v);
    else out[name] = Number(v);
  }
  return out;
}

// §3.8: env may only TIGHTEN. Returns { policy, overrides } where overrides lists
// every field the env bound below the row.
function applyEnvTightening(policy, env = process.env) {
  const effective = { ...policy };
  const overrides = [];
  for (const name of POLICY_FIELD_NAMES) {
    const spec = POLICY_FIELDS[name];
    if (!spec.env) continue;
    const raw = env[spec.env];
    if (raw === undefined || raw === '') continue;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n < effective[name]) {
      overrides.push({ field: name, env: spec.env, row: effective[name], applied: n });
      effective[name] = n;
    }
  }
  return { policy: effective, overrides };
}

async function loadPolicy(db, { env = process.env } = {}) {
  const row = await db('seo_link_policy').where({ id: 1 }).first();
  const stored = normalizePolicyRow(row);
  const { policy, overrides } = applyEnvTightening(stored, env);
  return { stored, policy, overrides, updated_at: row?.updated_at || null, updated_by: row?.updated_by || null };
}

function parseField(name, value, current) {
  const spec = POLICY_FIELDS[name];
  if (!spec) return { error: `unknown policy field '${name}'` };
  if (value === null || value === undefined || value === '') {
    if (spec.nullable) return { value: null };
    return { error: `${name} cannot be empty` };
  }
  if (spec.type === 'boolean') {
    if (typeof value === 'boolean') return { value };
    if (value === 'true' || value === 'false') return { value: value === 'true' };
    return { error: `${name} must be a boolean` };
  }
  if (spec.type === 'enum') {
    if (!spec.values.includes(value)) return { error: `${name} must be one of ${spec.values.join(', ')}` };
    return { value };
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return { error: `${name} must be a number` };
  if (spec.type === 'int' && !Number.isInteger(n)) return { error: `${name} must be an integer` };
  if (spec.min !== undefined && n < spec.min) return { error: `${name} must be ≥ ${spec.min}` };
  if (spec.max !== undefined && n > spec.max) return { error: `${name} must be ≤ ${spec.max}` };
  if (spec.raiseOnly && current !== null && current !== undefined && n < current) {
    return { error: `${name} may only be raised (currently ${current})` };
  }
  return { value: n };
}

/**
 * The ONE policy writer. `patch` = { field: value }; unknown fields, bad types
 * and out-of-range values reject the WHOLE patch (400-shaped `{ errors }`),
 * nothing is written. Every changed field appends an audit row in the same
 * transaction. Returns { changed: [{field, old, new}], policy }.
 */
async function updatePolicy(db, patch, { actor = null } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { errors: ['patch must be an object'] };
  return db.transaction(async (trx) => {
    const row = await trx('seo_link_policy').where({ id: 1 }).forUpdate().first();
    const current = normalizePolicyRow(row);
    const errors = [];
    const next = {};
    for (const [name, value] of Object.entries(patch)) {
      const r = parseField(name, value, current[name]);
      if (r.error) errors.push(r.error);
      else next[name] = r.value;
    }
    if (errors.length) return { errors };
    const changed = [];
    const update = {};
    for (const [name, value] of Object.entries(next)) {
      if (Object.is(value, current[name])) continue;
      changed.push({ field: name, old: current[name], new: value });
      update[name] = value;
    }
    if (!changed.length) return { changed, policy: current };
    update.updated_at = new Date();
    update.updated_by = actor;
    await trx('seo_link_policy').where({ id: 1 }).update(update);
    await trx('seo_link_policy_audit').insert(changed.map((c) => ({
      field: c.field,
      old_value: c.old === null ? null : String(c.old),
      new_value: c.new === null ? null : String(c.new),
      changed_by: actor,
    })));
    return { changed, policy: { ...current, ...next } };
  });
}

// ---------------------------------------------------------------------------
// §6.3 decision — pure.
// ---------------------------------------------------------------------------
const LEVELS = Object.freeze({
  AUTO_FREE: 'AUTO_FREE', AUTO_ACCOUNT: 'AUTO_ACCOUNT', AUTO_OUTREACH: 'AUTO_OUTREACH', AUTO_PAID_WITHIN_POLICY: 'AUTO_PAID_WITHIN_POLICY',
  OWNER_FREE: 'OWNER_FREE', OWNER_ACCOUNT: 'OWNER_ACCOUNT', OWNER_OUTREACH: 'OWNER_OUTREACH', OWNER_PAYMENT: 'OWNER_PAYMENT',
  OWNER_MANUAL_PAYMENT: 'OWNER_MANUAL_PAYMENT', OWNER_MEMBERSHIP: 'OWNER_MEMBERSHIP', OWNER_LEGAL: 'OWNER_LEGAL',
  OWNER_HUMAN_STEP: 'OWNER_HUMAN_STEP', OWNER_INPUT_REQUIRED: 'OWNER_INPUT_REQUIRED', DENY: 'DENY', INVALID: 'INVALID',
});

const isLiteralBoolean = (v) => v === true || v === false;
const validLegalTermsHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
// §3.2 merchant_binding: a resolvable recipient identity is a checkout origin
// plus a processor host; anything less closes the automated purchase flow.
function isValidMerchantBinding(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  if (typeof b.checkout_origin !== 'string' || !b.checkout_origin.trim()) return false;
  if (!b.processor || typeof b.processor !== 'object' || typeof b.processor.host !== 'string' || !b.processor.host.trim()) return false;
  return true;
}

// Which authority instances a path REQUIRES (§3.3b / §6.3 2a–2c), independent
// of the level each gets. Exported so the bridge and tests share one answer.
function requiredInstances(path) {
  const type = path.acquisition_type;
  const outreach = OUTREACH_ACQUISITION_TYPES.includes(type);
  const out = [];
  if (path.legal_attestation === true) out.push({ dimension: 'execution', instance_kind: 'terms' });
  if (!outreach || path.account_required === true || type === 'content_submission') out.push({ dimension: 'execution', instance_kind: '-' });
  if (path.payment_required === true) out.push({ dimension: 'payment', instance_kind: '-' });
  if (outreach) out.push({ dimension: 'communication', instance_kind: '-' });
  return out;
}

// Number(null) is 0 and Number('') is 0: a missing signal must read as NaN,
// never as a passing zero.
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

function validityFailure(path, domain, score) {
  const conf = num(path.confidence);
  if (!Number.isFinite(num(domain?.spam_score))) return 'unenriched: spam_score';
  if (!Number.isFinite(score)) return 'unscored';
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return 'confidence not in [0,1]';
  if (!ACQUISITION_TYPES.includes(path.acquisition_type) || ['not_reproducible', 'unknown'].includes(path.acquisition_type)) return `acquisition_type ${path.acquisition_type}: nothing to execute`;
  if (!path.last_investigated_at) return 'never investigated';
  if (!PATH_LINK_TYPES.includes(path.link_type)) return `link_type ${path.link_type} is not claimable`; // = the worker's CLAIMABLE_LINK_TYPES
  for (const f of BOOLEAN_FLAGS) if (!isLiteralBoolean(path[f])) return `${f} is not a literal boolean`;
  if (PAID_ACQUISITION_TYPES.includes(path.acquisition_type) && !path.payment_required) return `${path.acquisition_type} requires payment_required`;
  if (path.acquisition_type === 'self_service_free' && path.payment_required) return 'self_service_free cannot require payment';
  if (path.execution_after_send === false && path.terms_accepted_by_send === true) return 'deadlock: send-accepted terms with submit-first ordering';
  if (path.legal_attestation && !validLegalTermsHash(path.legal_terms_hash)) return 'legal_attestation without a bound agreement hash';
  if (path.superseded_by) return 'path superseded';
  if (path.baseline === true) return 'baseline placeholder is never executable';
  if (!CURRENCIES.includes(path.currency)) return `currency ${path.currency} unknown to the enum`;
  return null;
}

/**
 * decideAuthority({ path, domain, policy, score, d30Confidence, monthSpendCents, draftClean, waiver })
 *   path            seo_link_acquisition_paths row (pg strings tolerated)
 *   domain          seo_link_domains row (spam_score)
 *   policy          the EFFECTIVE policy from loadPolicy().policy
 *   score           the placement/domain score (defaults to domain.score)
 *   d30Confidence   learned D30 confidence in [0,1] or null (step 7 — null ⇒ never AUTO_PAID)
 *   monthSpendCents AUTO spend already reserved/settled this ET month (excluding this placement)
 *   draftClean      true only when a lint-clean draft exists AND passes the §6.4 classifier
 *   waiver          a VALID floor waiver ({ id }) — floors treated as passed; never promotes anything
 * → { verdict: 'ok'|'DENY'|'INVALID', reason, instances: [{ dimension, instance_kind, level, reason }] }
 */
function decideAuthority({ path, domain, policy, score, d30Confidence = null, monthSpendCents = 0, draftClean = false, waiver = null }) {
  const p = policy;
  const s = score === undefined ? num(domain?.score) : num(score);
  const required = requiredInstances(path || {});
  const stamp = (level, reason) => ({ verdict: level, reason, instances: required.map((r) => ({ ...r, level, reason })) });

  // 1a. validity — non-overrideable
  const invalid = validityFailure(path || {}, domain || {}, s);
  if (invalid) return stamp(LEVELS.INVALID, invalid);

  // 1a (payment money) — assigned HERE and closed to 2b
  let payment;
  let paymentReason;
  if (path.payment_required) {
    const amount = path.estimated_cost_cents;
    const money = Number.isSafeInteger(amount) && amount > 0;
    if (!money || path.currency !== 'USD') {
      if (path.currency === 'foreign') { payment = LEVELS.OWNER_MANUAL_PAYMENT; paymentReason = 'confirmed non-USD checkout: manual settlement only'; }
      else { payment = LEVELS.OWNER_INPUT_REQUIRED; paymentReason = money ? 'currency unknown: price entry required' : 'price unparseable: price entry required'; }
    }
  }

  // 1b. quality floors — fail-closed; a valid waiver treats them as passed
  const floors = [];
  if (num(domain.spam_score) > p.max_spam_score) floors.push(`spam_score ${domain.spam_score} > ${p.max_spam_score}`);
  if (num(path.confidence) < p.min_path_confidence) floors.push(`confidence ${path.confidence} < ${p.min_path_confidence}`);
  if (s < p.min_score) floors.push(`score ${s} < ${p.min_score}`);
  if (floors.length && !(waiver && waiver.id)) return stamp(LEVELS.DENY, floors.join('; '));
  const waived = floors.length ? `floors waived (${waiver.id}): ${floors.join('; ')}` : null;

  const instances = [];
  const push = (dimension, instance_kind, level, reason) => instances.push({ dimension, instance_kind, level, reason: waived ? `${reason} · ${waived}` : reason });
  const type = path.acquisition_type;
  const outreach = OUTREACH_ACQUISITION_TYPES.includes(type);

  // 2a. execution
  if (path.legal_attestation) {
    if (p.legal_attestation_requires_owner) push('execution', 'terms', LEVELS.OWNER_LEGAL, 'signed agreement / vendor terms');
    else if (p.auto_account_creation === true) push('execution', 'terms', LEVELS.AUTO_ACCOUNT, 'terms acceptance under auto_account_creation');
    else push('execution', 'terms', LEVELS.OWNER_ACCOUNT, 'terms acceptance; auto_account_creation off');
  }
  if (!outreach || path.account_required || type === 'content_submission') {
    if (!path.agent_completable) push('execution', '-', LEVELS.OWNER_HUMAN_STEP, 'investigator: a human must act');
    else if (MEMBERSHIP_TYPES.includes(type) && p.membership_requires_owner) push('execution', '-', LEVELS.OWNER_MEMBERSHIP, 'membership_requires_owner');
    else if (path.account_required) {
      if (p.auto_account_creation === true) push('execution', '-', LEVELS.AUTO_ACCOUNT, 'auto_account_creation');
      else push('execution', '-', LEVELS.OWNER_ACCOUNT, 'auto_account_creation off');
    } else if (p.auto_free_acquisition === true) push('execution', '-', LEVELS.AUTO_FREE, 'auto_free_acquisition');
    else push('execution', '-', LEVELS.OWNER_FREE, 'auto_free_acquisition off');
  }

  // 2b. payment — closed to step 1's assignment
  if (path.payment_required) {
    if (payment) push('payment', '-', payment, paymentReason);
    else {
      const amount = path.estimated_cost_cents;
      const okMoney = Number.isSafeInteger(amount) && amount > 0 && path.currency === 'USD';
      if (!okMoney) push('payment', '-', LEVELS.OWNER_MANUAL_PAYMENT, 'money guard');
      else if (!isValidMerchantBinding(path.merchant_binding)) push('payment', '-', LEVELS.OWNER_MANUAL_PAYMENT, 'no resolvable merchant binding');
      else {
        const d30 = d30Confidence;
        const spend = Number(monthSpendCents);
        const auto = configured(p.max_auto_purchase_cents) && configured(p.monthly_paid_budget_cents)
          && configured(p.auto_paid_min_score) && configured(p.auto_paid_min_d30_confidence)
          && p.max_auto_purchase_cents > 0 && p.monthly_paid_budget_cents > 0
          && amount <= p.max_auto_purchase_cents && s >= p.auto_paid_min_score
          && Number.isFinite(d30) && d30 >= 0 && d30 <= 1
          && p.auto_paid_min_d30_confidence >= 0 && p.auto_paid_min_d30_confidence <= 1
          && d30 >= p.auto_paid_min_d30_confidence
          && Number.isFinite(spend) && spend >= 0 && (spend + amount) <= p.monthly_paid_budget_cents;
        if (auto) push('payment', '-', LEVELS.AUTO_PAID_WITHIN_POLICY, `${amount}¢ within policy`);
        else push('payment', '-', LEVELS.OWNER_PAYMENT, 'outside AUTO_PAID policy');
      }
    }
  }

  // 2c. communication
  if (outreach) {
    if (path.legal_attestation && p.legal_attestation_requires_owner) push('communication', '-', LEVELS.OWNER_LEGAL, 'send bound to a signed agreement');
    else if (configured(p.auto_outreach_min_score) && configured(p.auto_outreach_daily_cap) && p.auto_outreach_daily_cap > 0
      && s >= p.auto_outreach_min_score && draftClean === true) push('communication', '-', LEVELS.AUTO_OUTREACH, 'score + clean draft within the mandate');
    else push('communication', '-', LEVELS.OWNER_OUTREACH, draftClean === true ? 'outside the auto-outreach policy' : 'no lint-clean draft yet');
  }

  return { verdict: 'ok', reason: waived, instances };
}

module.exports = {
  POLICY_FIELDS, POLICY_FIELD_NAMES, LEVELS, MEMBERSHIP_TYPES, BOOLEAN_FLAGS,
  normalizePolicyRow, applyEnvTightening, loadPolicy, updatePolicy, parseField,
  requiredInstances, validityFailure, isValidMerchantBinding, validLegalTermsHash, decideAuthority,
};
