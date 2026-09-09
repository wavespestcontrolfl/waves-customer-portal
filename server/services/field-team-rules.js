const Joi = require('joi');
const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');

// Keep this legacy definition fixed: already-retained revision 2b rules did
// not carry a formula snapshot. New rules persist their own formula inputs.
const VERSION_FORMULAS = {
  'field-team-rev-2b': {
    production_bps: { technician_i: 600, technician_ii: 800 }, commission_bps: 500,
    outcome_curves: {
      rework: { maximum: 20000, zeroFailureRate: 0.06, fullFailureRate: 0.02 },
      handoff: { maximum: 10000, zeroFailureRate: 0.10, fullFailureRate: 0.02 },
    }, interpolation: 'linear simulation',
  },
};
const PROGRAM = {
  version: 'field-team-rev-2b',
  mode: 'simulation',
  notice: 'Simulation only. These amounts illustrate the proposed incentive formula; they are not earned compensation. Your current compensation terms remain in effect.',
  roles: [
    { key: 'trainee', title: 'Trainee', hourlyCents: null, annualBaseCents: null, targetIncentiveCents: null, productionBps: null },
    { key: 'technician_i', title: 'Technician I', hourlyCents: 2300, annualBaseCents: 4784000, targetIncentiveCents: 2016000, productionBps: 600 },
    { key: 'technician_ii', title: 'Technician II', hourlyCents: 2500, annualBaseCents: 5200000, targetIncentiveCents: 2760000, productionBps: 800 },
    { key: 'service_manager', title: 'Service Manager', hourlyCents: null, annualBaseCents: 6500000, targetIncentiveCents: 2500000, productionBps: null },
    { key: 'general_manager', title: 'General Manager', hourlyCents: null, annualBaseCents: 8500000, targetIncentiveCents: 3500000, productionBps: null },
  ],
};
function ruleDefinition(data) {
  return { ...data, program_version: PROGRAM.version, formula: structuredClone(VERSION_FORMULAS[PROGRAM.version]) };
}
function formulaForRule(rule) {
  return rule?.formula || VERSION_FORMULAS[rule?.program_version] || null;
}
const ROLE_KEYS = PROGRAM.roles.map(role => role.key);
const REPAIR_REASONS = ['none', 'technician_omission', 'office_change', 'customer_change', 'software_issue', 'unresolved'];
const REWORK_OUTCOMES = ['unobserved', 'no_return', 'technician_execution', 'protocol', 'scheduling', 'customer', 'other', 'unresolved'];
const EXCLUSIONS = ['none', 'corrective', 'planned_followup', 'duplicate', 'unnecessary', 'inspection'];

function reject(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function validate(schema, value) {
  const result = schema.validate(value, { abortEarly: false, convert: false });
  if (result.error) reject(result.error.details.map(item => item.message).join('; '));
  return result.value;
}
function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value == null ? null : String(value).slice(0, 10);
}
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : helpers.error('any.invalid');
});
const month = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/);
const uuid = Joi.string().uuid();
const cents = Joi.number().integer().min(0).max(100000000);
const text = Joi.string().trim().max(2000);
const instant = Joi.string().isoDate().pattern(/(?:Z|[+-]\d{2}:\d{2})$/);
const schemas = {
  rule: Joi.object({
    id: uuid.required(), label: Joi.string().trim().max(100).required(), effective_date: day.required(),
    service_rules: Joi.array().items(Joi.object({
      service_key: Joi.string().trim().max(150).required(),
      credit_type: Joi.string().valid('routine', 'specialty').required(),
      rework_window_days: Joi.number().integer().min(1).max(365).allow(null).required(),
    })).unique('service_key').max(200).required(),
    rework_minimum: Joi.number().integer().min(1).max(10000).allow(null).required(),
    handoff_minimum: Joi.number().integer().min(1).max(10000).allow(null).required(),
    activation_share_bps: Joi.number().integer().min(0).max(10000).allow(null).required(),
  }),
  level: Joi.object({ id: uuid.required(), technician_id: uuid.required(), role_key: Joi.string().valid(...ROLE_KEYS).required(), effective_date: day.required() }),
  allocation: Joi.object({
    id: uuid.required(), customer_id: uuid.required(), property_id: uuid.allow(null).required(), service_key: Joi.string().trim().max(150).required(),
    coverage_start: day.required(), coverage_end: day.required(), credit_type: Joi.string().valid('routine', 'specialty').required(),
    net_value_cents: cents.required(), planned_visits: Joi.number().integer().min(1).max(366).required(), source_reference: text.required(),
  }),
  evidence: Joi.object({
    id: uuid.required(), service_id: uuid.required(), base_id: uuid.allow(null).required(),
    allocation_id: uuid.allow(null).required(), ordinal: Joi.number().integer().min(1).max(366).allow(null).required(),
    participants: Joi.array().items(Joi.object({ technician_id: uuid.required(), share_bps: Joi.number().integer().min(1).max(10000).required() })).unique('technician_id').min(1).max(10).required(),
    provenance: Joi.string().valid('verified', 'backfilled', 'synthetic').required(), source_reference: text.required(),
    exclusion: Joi.string().valid(...EXCLUSIONS).required(),
    cutoff_at: instant.allow(null).required(), complete_at_cutoff: Joi.boolean().allow(null).required(),
    repair_reason: Joi.string().valid(...REPAIR_REASONS).required(), repair_reference: text.allow('').required(),
    rework_outcome: Joi.string().valid(...REWORK_OUTCOMES).required(), return_service_id: uuid.allow(null).required(),
    same_issue_confirmed: Joi.boolean().required(), rework_reference: text.allow('').required(),
  }),
  business: Joi.object({
    id: uuid.required(), base_id: uuid.allow(null).required(), estimate_id: uuid.required(), technician_id: uuid.required(),
    baseline_cents: cents.required(), accepted_net_cents: cents.required(), source_reference: text.required(),
    activation_date: day.allow(null).required(), payment_reference: text.allow('').required(),
    retained_at_90: Joi.boolean().allow(null).required(), retention_reference: text.allow('').required(),
  }),
  assessment: Joi.object({
    id: uuid.required(), technician_id: uuid.required(), previous_id: uuid.allow(null).required(),
    from_role: Joi.string().valid(...ROLE_KEYS).required(), to_role: Joi.string().valid(...ROLE_KEYS).required(),
    assessed_date: day.required(), rubric_version: Joi.string().trim().max(100).required(),
    items: Joi.array().items(Joi.object({ label: Joi.string().trim().max(250).required(), critical: Joi.boolean().required(), result: Joi.string().valid('pass', 'needs_work', 'not_observed').required(), evidence: text.required() })).min(1).max(50).required(),
    sustained_results: Joi.string().valid('verified', 'needs_work', 'not_enough_evidence').required(), outcome_reference: text.required(),
    paid_development_reference: text.allow('').required(), position_available: Joi.boolean().allow(null).required(),
  }),
};

// Integer arithmetic throughout. Remainder cents are allocated by ordinal;
// four applications always reconcile to the accepted net program price.
function allocatedCents(total, count, ordinal) {
  if (![total, count, ordinal].every(Number.isSafeInteger) || total < 0 || count < 1 || ordinal < 1 || ordinal > count) reject('Invalid allocation.');
  return Math.floor(total / count) + (ordinal <= total % count ? 1 : 0);
}
function splitCents(total, participants) {
  if (participants.reduce((sum, p) => sum + p.share_bps, 0) !== 10000) reject('Employee shares must total 100%.');
  const ordered = [...participants].sort((a, b) => a.technician_id.localeCompare(b.technician_id));
  const rows = ordered.map(p => ({ ...p, value_cents: Math.floor(total * p.share_bps / 10000), remainder: total * p.share_bps % 10000 }));
  const remaining = total - rows.reduce((sum, p) => sum + p.value_cents, 0);
  [...rows].sort((a, b) => b.remainder - a.remainder || a.technician_id.localeCompare(b.technician_id))
    .slice(0, remaining).forEach(p => { p.value_cents += 1; });
  return rows;
}
function production({ roleKey, rule, serviceKey, allocation, ordinal, participant, exclusion, provenance }) {
  const result = { status: 'not_enough_evidence', amount_cents: null, rate_bps: null, value_cents: null, reason: null };
  if (exclusion !== 'none') return { ...result, status: 'excluded', amount_cents: 0, reason: `Excluded service: ${exclusion}.` };
  const reasons = [
    [provenance !== 'verified', 'Verified service-value evidence is required.'],
    [!rule, 'No simulation definition effective on the service date.'],
    [!roleKey, 'No simulation level effective on the service date.'],
    [!allocation, 'Accepted service-value allocation is not recorded.'],
  ];
  const problem = reasons.find(([blocked]) => blocked);
  if (problem) return { ...result, reason: problem[1] };
  const serviceRule = rule.service_rules.find(item => item.service_key === serviceKey);
  if (!serviceRule || serviceRule.credit_type !== allocation.credit_type) return { ...result, reason: 'This service key and credit type are not included in the simulation definition.' };
  const rate = formulaForRule(rule)?.production_bps[roleKey];
  if (rate == null) return { ...result, reason: 'A production rate is not defined for this role and effective rule.' };
  // Specialty compensation needs a separate pre-assignment amount; do not
  // silently apply the routine 6/8% rate to its accepted selling price.
  if (allocation.credit_type === 'specialty') return { ...result, reason: 'A separately defined specialty incentive amount is required.' };
  return {
    status: 'simulated', amount_cents: Math.round(participant.value_cents * rate / 10000),
    rate_bps: rate, value_cents: participant.value_cents, share_bps: participant.share_bps,
    allocation_value_cents: allocatedCents(allocation.net_value_cents, allocation.planned_visits, ordinal),
    reason: null,
  };
}

function outcomeBonus(kind, evidence, rule, asOfDate) {
  const formula = formulaForRule(rule);
  const curve = formula?.outcome_curves[kind];
  const minimum = rule?.[`${kind}_minimum`];
  const base = { status: 'definition_needed', amount_cents: null, total: evidence.length, observed: 0, unresolved: 0, immature: 0, excluded: 0, missing_window: 0, failures: 0, rate: null, minimum: minimum ?? null,
    formula: { ...curve, interpolation: formula?.interpolation } };
  if ([minimum, curve].some(value => value == null)) return { ...base, reason: 'Set the formula, observation definition and minimum sample for this simulation.' };
  const rework = kind === 'rework';
  for (const row of evidence) {
    const facts = row.facts;
    const serviceRule = rule.service_rules.find(item => item.service_key === row.service_key);
    const window = serviceRule?.rework_window_days;
    const mature = window == null ? null : etDateString(addETDays(parseETDateTime(`${row.service_date}T12:00`), window));
    const reviewedDate = row.created_at ? etDateString(new Date(row.created_at)) : '';
    const returnOutcome = !['no_return', 'unobserved', 'unresolved'].includes(facts.rework_outcome);
    const linkedReturn = [facts.return_service_id, facts.same_issue_confirmed, facts.return_service_date, facts.return_service_date >= row.service_date].every(Boolean);
    // First matching reason owns the observation; excluded work and missing
    // evidence can never increment the observed denominator.
    const checks = [
      [!row.service_key, 'unresolved'],
      [facts.provenance !== 'verified', 'unresolved'],
      [facts.exclusion !== 'none', 'excluded'],
      [!serviceRule, 'excluded'],
      ...(rework ? [
        [window == null, 'missing_window'],
        [asOfDate < mature, 'immature'],
        // A premature no-return review does not cover the rest of its window.
        [facts.rework_outcome === 'no_return' && reviewedDate < mature, 'unresolved'],
        [['unobserved', 'unresolved'].includes(facts.rework_outcome), 'unresolved'],
        [returnOutcome && !linkedReturn, 'unresolved'],
        [facts.return_service_date > mature, 'unresolved'],
      ] : [
        [facts.complete_at_cutoff == null, 'unresolved'],
        [!facts.cutoff_at, 'unresolved'],
        [facts.repair_reason === 'unresolved', 'unresolved'],
      ]),
    ];
    const state = checks.find(([blocked]) => blocked)?.[1] || 'observed';
    base[state] += 1;
    const failed = { rework: facts.rework_outcome === 'technician_execution',
      handoff: [!facts.complete_at_cutoff, facts.repair_reason === 'technician_omission'].some(Boolean) }[kind];
    if (state === 'observed' && failed) base.failures += 1;
  }
  const blocked = [
    [base.missing_window > 0, 'definition_needed', `${base.missing_window} services need an observation window.`],
    [base.unresolved > 0, 'unresolved', 'Evidence or responsibility still needs review.'],
    [base.immature > 0, 'observing', 'The rework observation window is still open.'],
    [base.observed < minimum, 'not_enough_evidence', 'Not enough observations for this simulation.'],
  ].find(([condition]) => condition);
  if (blocked) return { ...base, status: blocked[1], reason: blocked[2] };
  const failureRate = base.failures / base.observed;
  const fraction = (curve.zeroFailureRate - failureRate) / (curve.zeroFailureRate - curve.fullFailureRate);
  return { ...base, status: 'simulated', rate: rework ? failureRate : 1 - failureRate,
    amount_cents: Math.round(curve.maximum * Math.max(0, Math.min(1, fraction))), reason: 'Linear simulation between the revision 2b endpoints.' };
}

function commission(facts, rule, asOfDate) {
  const rate = formulaForRule(rule)?.commission_bps;
  const potential = rate == null ? null : Math.round(Math.max(0, facts.accepted_net_cents - facts.baseline_cents) * rate / 10000);
  const share = rule?.activation_share_bps;
  const due = facts.activation_date ? etDateString(addETDays(parseETDateTime(`${facts.activation_date}T12:00`), 90)) : null;
  const result = { status: 'definition_needed', potential_cents: potential, amount_cents: null, activation_cents: null, retention_cents: null, retention_due: due,
    rate_bps: rate ?? null, activation_share_bps: share ?? null };
  if ([share, rate].some(value => value == null)) return { ...result, reason: 'The commission formula or activation / 90-day split has not been defined.' };
  const activated = !!facts.activation_date && facts.activation_date <= asOfDate && !!facts.payment_reference;
  const retained = activated && due <= asOfDate && facts.retained_at_90 === true && !!facts.retention_reference;
  const activation = Math.round(potential * share / 10000);
  return { ...result, status: 'simulated', activation_cents: activated ? activation : 0, retention_cents: retained ? potential - activation : 0, amount_cents: (activated ? activation : 0) + (retained ? potential - activation : 0), reason: !activated ? 'Activation and qualifying payment evidence are still needed.' : !retained ? 'The 90-day portion still needs its milestone and retained-customer evidence.' : null };
}

function assessmentResult(data) {
  if (ROLE_KEYS.indexOf(data.to_role) !== ROLE_KEYS.indexOf(data.from_role) + 1) reject('Assess the next step in the published ladder.');
  const management = ['service_manager', 'general_manager'].includes(data.to_role);
  const missing = data.items.some(item => item.result !== 'pass') || data.sustained_results !== 'verified' || (management && !data.paid_development_reference);
  return { status: missing ? 'development_needed' : 'qualified_for_consideration', management, position_available: management ? data.position_available : null };
}

module.exports = { PROGRAM, ROLE_KEYS, REPAIR_REASONS, REWORK_OUTCOMES, EXCLUSIONS, schemas, uuid, day, month, validate, reject, dateOnly, ruleDefinition, allocatedCents, splitCents, production, outcomeBonus, commission, assessmentResult };
