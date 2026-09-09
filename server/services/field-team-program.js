const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const { hash } = require('./staff-document-source');
const { recordAuditEvent } = require('./audit-log');
const { resolveServiceRecord } = require('./job-costing');
const { etDateString, parseETDateTime, addETDays, etWeekStart } = require('../utils/datetime-et');
const {
  PROGRAM, schemas, validate, reject, dateOnly, allocatedCents, splitCents,
  production, outcomeBonus, commission, assessmentResult,
} = require('./field-team-rules');

function requireManager(actor) {
  if (actor.role !== 'admin') reject('Admin access required', 403);
}
function baseRow(data, actor) {
  return { id: data.id, created_by: actor.id, input_hash: hash(data) };
}
async function replay(conn, table, data, actor) {
  const prior = await conn(table).where({ id: data.id }).first();
  if (prior && (prior.input_hash !== hash(data) || prior.created_by !== actor.id)) reject('This request identifier was already used. Reload before saving.', 409);
  return prior;
}
async function audit(trx, table, row, actor) {
  await recordAuditEvent({ actor_type: 'admin', actor_id: actor.id, action: 'field_program.recorded', resource_type: table, resource_id: row.id, metadata: { mode: 'simulation' }, critical: true, trx });
}
async function employee(conn, id, { lock = false } = {}) {
  const query = conn('technicians').where({ id }).select('id', 'name', 'employment_status', 'job_title', 'pay_rate', 'role');
  const person = await (lock ? query.forUpdate() : query).first();
  if (!person || person.employment_status === 'prospective' || !['admin', 'technician'].includes(person.role)) reject('Employee is not available for this program.', 404);
  return person;
}
function ruleAt(conn, date) {
  return conn('field_program_rules').where('effective_date', '<=', date).orderBy('effective_date', 'desc').first();
}
function levelAt(conn, id, date) {
  return conn('field_program_levels').where({ technician_id: id }).where('effective_date', '<=', date).orderBy('effective_date', 'desc').first();
}
function currentOnly(query, table, alias) {
  return query.whereNotExists(function () {
    this.select(db.raw('1')).from(`${table} as newer`).whereRaw('newer.base_id = ??.id', [alias]);
  });
}

async function saveRule(input, actor) {
  requireManager(actor);
  const data = validate(schemas.rule, input);
  if (!data.effective_date.endsWith('-01')) reject('Simulation definitions take effect on the first day of a month.');
  return db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['field-program-rules']);
    const prior = await replay(trx, 'field_program_rules', data, actor);
    if (prior) return prior;
    const last = await trx('field_program_rules').orderBy('effective_date', 'desc').first();
    if (last && data.effective_date <= dateOnly(last.effective_date)) reject('Append a later effective definition; earlier definitions are retained.', 409);
    const keys = data.service_rules.map(row => row.service_key);
    const catalog = await trx('services').whereIn('service_key', keys).pluck('service_key');
    if (keys.some(key => !catalog.includes(key))) reject('Choose service keys from the current service catalog.');
    const [row] = await trx('field_program_rules').insert({ ...baseRow(data, actor), label: data.label, effective_date: data.effective_date, definition: { ...data, program_version: PROGRAM.version } }).returning('*');
    await audit(trx, 'field_program_rules', row, actor);
    return row;
  });
}

async function saveLevel(input, actor) {
  requireManager(actor);
  const data = validate(schemas.level, input);
  return db.transaction(async trx => {
    const person = await employee(trx, data.technician_id, { lock: true });
    const prior = await replay(trx, 'field_program_levels', data, actor);
    if (prior) return prior;
    if (person.employment_status !== 'active') reject('Only active employees can receive a new simulation level.', 409);
    const last = await trx('field_program_levels').where({ technician_id: data.technician_id }).orderBy('effective_date', 'desc').first();
    if (last && data.effective_date <= dateOnly(last.effective_date)) reject('Append a later effective level; earlier levels are retained.', 409);
    const [row] = await trx('field_program_levels').insert({ ...data, ...baseRow(data, actor) }).returning('*');
    await audit(trx, 'field_program_levels', row, actor);
    return row;
  });
}

async function saveAllocation(input, actor) {
  requireManager(actor);
  const data = validate(schemas.allocation, input);
  if (data.coverage_end < data.coverage_start) reject('Coverage must end on or after it begins.');
  if (data.credit_type === 'specialty' && data.planned_visits !== 1) reject('Record separately priced work as one defined allocation.');
  return db.transaction(async trx => {
    if (!await trx('customers').where({ id: data.customer_id }).forUpdate().first('id')) reject('Customer not found.', 404);
    const prior = await replay(trx, 'field_credit_allocations', data, actor);
    if (prior) return prior;
    if (!await trx('services').where({ service_key: data.service_key }).first('id')) reject('Service key not found.', 404);
    if (data.property_id && !await trx('customer_properties').where({ id: data.property_id, customer_id: data.customer_id }).first('id')) reject('The property does not belong to this customer.');
    const owners = await allocationCustomers(trx, data.customer_id);
    const overlap = await trx('field_credit_allocations').whereIn('customer_id', owners).where({ property_id: data.property_id, service_key: data.service_key, credit_type: data.credit_type })
      .where('coverage_start', '<=', data.coverage_end).where('coverage_end', '>=', data.coverage_start).first();
    if (overlap) reject('An allocation already covers this service and period. Use its original scheduled count.', 409);
    const [row] = await trx('field_credit_allocations').insert({ ...data, ...baseRow(data, actor) }).returning('*');
    await audit(trx, 'field_credit_allocations', row, actor);
    return row;
  });
}

// The merge journal retains original account identities. Follow only active
// merges; never repoint immutable accepted-value history or duplicate its cap.
async function allocationCustomers(conn, customerId) {
  const result = await conn.raw(`WITH RECURSIVE owners(id) AS (
    SELECT ?::uuid UNION
    SELECT j.loser_customer_id FROM customer_merge_journal j
    JOIN owners o ON j.winner_customer_id = o.id WHERE j.undone_at IS NULL
  ) SELECT id FROM owners`, [customerId]);
  return result.rows.map(row => row.id);
}

async function visitFacts(conn, id, lock = false) {
  const query = conn('scheduled_services').where({ id });
  const visit = await (lock ? query.forUpdate() : query).first('id', 'customer_id', 'property_id', 'technician_id', 'service_id', 'service_key_snapshot', 'service_type', 'scheduled_date', 'status', 'is_callback');
  if (!visit) reject('Service not found.', 404);
  const catalog = visit.service_id ? await conn('services').where({ id: visit.service_id }).first('service_key') : null;
  return { ...visit, service_key: visit.service_key_snapshot || catalog?.service_key || null, service_date: dateOnly(visit.scheduled_date) };
}

async function validateServiceEvidence(conn, data, visit, last) {
  if (visit.status !== 'completed' || visit.service_date > etDateString(new Date())) reject('Record evidence for a completed service with a past or current service date.');
  if (!visit.technician_id) reject('The original service needs an assigned technician.');
  if (last.id !== data.base_id) reject('Service evidence changed. Reload before recording a revision.', 409);
  if (last.allocation_id && ['allocation_id', 'ordinal'].some(key => last[key] !== data[key])) reject('A revision retains the original allocation and ordinal.', 409);
  if (hash(last.facts.participants) !== hash(data.participants)) reject('A revision retains the original employee shares.', 409);
  if (!data.participants.some(p => p.technician_id === last.technician_id)) reject('Include the original assigned technician in the employee shares.');
  splitCents(0, data.participants);
  // Deterministic order prevents crossed two-person crews from deadlocking.
  for (const id of data.participants.map(p => p.technician_id).sort()) await employee(conn, id, { lock: true });
  const isReturn = !['unobserved', 'no_return', 'unresolved'].includes(data.rework_outcome);
  const references = [
    [data.complete_at_cutoff != null, data.cutoff_at, 'Record the cutoff used to assess completeness.'],
    [!['none', 'unresolved'].includes(data.repair_reason), data.repair_reference, 'Record the evidence for the substantive repair reason.'],
    [data.rework_outcome !== 'unobserved', data.rework_reference, 'Record the evidence for the rework review.'],
    [isReturn, data.return_service_id, 'Identify the qualifying return.'],
    [isReturn, data.same_issue_confirmed, 'Confirm that the qualifying return concerns the same issue.'],
  ];
  for (const [required, reference, message] of references) if (required && !reference) reject(message);
  if (data.cutoff_at && [new Date(data.cutoff_at) > new Date(), etDateString(new Date(data.cutoff_at)) < visit.service_date].some(Boolean)) reject('The cutoff must be on or after the service date and no later than now.');
  let returned = null;
  if (data.return_service_id) {
    returned = await visitFacts(conn, data.return_service_id);
    const sameScope = !!visit.service_key && ['customer_id', 'property_id', 'service_key'].every(key => returned[key] === visit[key]);
    if ([returned.id === visit.id, !sameScope, returned.service_date < visit.service_date, returned.status !== 'completed'].some(Boolean)) reject('The qualifying return must be a completed later service for the same property and service key.');
  }
  if (data.rework_outcome === 'no_return' && data.return_service_id) reject('A no-return finding cannot include a qualifying return.');
  return returned;
}

async function allocationForVisit(conn, data, visit) {
  if (!data.allocation_id) {
    if (data.ordinal != null) reject('Choose an allocation before its application number.');
    return null;
  }
  const allocation = await conn('field_credit_allocations').where({ id: data.allocation_id }).forUpdate().first();
  const owners = await allocationCustomers(conn, visit.customer_id);
  if (!allocation || !owners.includes(allocation.customer_id) || allocation.property_id !== visit.property_id || allocation.service_key !== visit.service_key) reject('Use this property’s allocation for the same service key.');
  if (visit.service_date < dateOnly(allocation.coverage_start) || visit.service_date > dateOnly(allocation.coverage_end)) reject('The service date is outside the allocation coverage period.');
  if (data.ordinal == null || data.ordinal > allocation.planned_visits) reject('Choose an application number within the original scheduled count.');
  const claim = await conn('field_service_evidence').where({ allocation_id: data.allocation_id, ordinal: data.ordinal, claims_allocation: true }).first();
  if (claim && claim.service_id !== visit.id) reject('This application number is already credited to another service.', 409);
  return allocation;
}

async function saveServiceEvidence(input, actor) {
  requireManager(actor);
  const data = validate(schemas.evidence, input);
  return db.transaction(async trx => {
    const visit = await visitFacts(trx, data.service_id, true);
    const prior = await replay(trx, 'field_service_evidence', data, actor);
    if (prior) return prior;
    const last = await trx('field_service_evidence').where({ service_id: visit.id }).orderBy('revision', 'desc').first() || {
      id: null, allocation_id: null, revision: 0, technician_id: visit.technician_id,
      service_date: visit.service_date, service_key: visit.service_key, service_label: visit.service_type, facts: data,
    };
    const returned = await validateServiceEvidence(trx, data, visit, last);
    const record = await resolveServiceRecord(trx, visit, { scheduled_service_id: true });
    const callback = [visit.is_callback, record.record?.is_callback].some(Boolean);
    const facts = { ...data, return_service_date: returned?.service_date || null, exclusion: callback ? 'corrective' : data.exclusion };
    if (record.ambiguous && facts.provenance === 'verified') reject('Historical service records are ambiguous. Resolve their attribution before verifying credit.');
    const claimsAllocation = !!data.allocation_id && !last.allocation_id;
    if (facts.exclusion !== 'none' && claimsAllocation) reject('An excluded service cannot claim a scheduled application. Remove its allocation.');
    const allocation = await allocationForVisit(trx, data, visit);
    const [row] = await trx('field_service_evidence').insert({
      ...baseRow(data, actor), service_id: visit.id, technician_id: last.technician_id,
      base_id: data.base_id, revision: last.revision + 1,
      service_date: last.service_date, service_key: last.service_key || visit.service_key,
      service_label: last.service_label, allocation_id: data.allocation_id, ordinal: data.ordinal,
      claims_allocation: claimsAllocation, facts,
    }).returning('*');
    const total = allocation ? allocatedCents(allocation.net_value_cents, allocation.planned_visits, data.ordinal) : 0;
    const shares = splitCents(total, data.participants);
    const previousCalculations = await trx('field_production_simulations').where({ evidence_id: last.id });
    for (const participant of shares) {
      const previous = previousCalculations.find(item => item.technician_id === participant.technician_id) || {};
      const rule = (previous.rule_id ? await trx('field_program_rules').where({ id: previous.rule_id }).first() : await ruleAt(trx, dateOnly(row.service_date))) || { id: null, definition: null };
      const level = (previous.level_id ? await trx('field_program_levels').where({ id: previous.level_id }).first() : await levelAt(trx, participant.technician_id, dateOnly(row.service_date))) || { id: null, role_key: null };
      await trx('field_production_simulations').insert({
        id: randomUUID(), evidence_id: row.id, technician_id: participant.technician_id,
        rule_id: rule.id, level_id: level.id,
        calculation: production({ roleKey: level.role_key, rule: rule.definition, serviceKey: row.service_key, allocation, ordinal: data.ordinal, participant, exclusion: facts.exclusion, provenance: facts.provenance }),
      });
    }
    await audit(trx, 'field_service_evidence', row, actor);
    return row;
  });
}

async function saveBusinessEvidence(input, actor) {
  requireManager(actor);
  const data = validate(schemas.business, input);
  if (data.accepted_net_cents < data.baseline_cents) reject('Accepted net value must include the original baseline.');
  return db.transaction(async trx => {
    const estimate = await trx('estimates').where({ id: data.estimate_id }).forUpdate().first('id', 'status', 'accepted_at');
    const prior = await replay(trx, 'field_business_evidence', data, actor);
    if (prior) return prior;
    if (!estimate?.accepted_at || estimate.status !== 'accepted') reject('Use an accepted estimate with an acceptance date.');
    await employee(trx, data.technician_id, { lock: true });
    const last = await trx('field_business_evidence').where({ estimate_id: data.estimate_id }).orderBy('revision', 'desc').first() || {
      id: null, technician_id: data.technician_id, accepted_date: etDateString(new Date(estimate.accepted_at)), rule_id: null, revision: 0,
    };
    if (last.id !== data.base_id) reject('New-business evidence changed. Reload before saving.', 409);
    if (last.technician_id !== data.technician_id) reject('Origination stays with the recorded technician through later milestone reviews.', 409);
    const accepted = dateOnly(last.accepted_date);
    const today = etDateString(new Date());
    if (data.activation_date && (data.activation_date < accepted || data.activation_date > today)) reject('Activation must fall between acceptance and today.');
    if (data.retained_at_90 != null) {
      const due = data.activation_date && etDateString(addETDays(parseETDateTime(`${data.activation_date}T12:00`), 90));
      if (!due || due > today || !data.retention_reference) reject('Record a 90-day review after the milestone with supporting evidence.');
    }
    const rule = last.rule_id ? { id: last.rule_id } : await ruleAt(trx, accepted);
    const [row] = await trx('field_business_evidence').insert({ ...baseRow(data, actor), estimate_id: data.estimate_id, technician_id: data.technician_id, base_id: data.base_id, revision: last.revision + 1, accepted_date: accepted, rule_id: rule?.id || null, facts: data }).returning('*');
    await audit(trx, 'field_business_evidence', row, actor);
    return row;
  });
}

async function saveAssessment(input, actor) {
  requireManager(actor);
  const data = validate(schemas.assessment, input);
  if (data.assessed_date > etDateString(new Date())) reject('An assessment date cannot be in the future.');
  const result = assessmentResult(data);
  return db.transaction(async trx => {
    await employee(trx, data.technician_id, { lock: true });
    const prior = await replay(trx, 'field_promotion_assessments', data, actor);
    if (prior) return prior;
    if (data.previous_id) {
      const previous = await trx('field_promotion_assessments').where({ id: data.previous_id, technician_id: data.technician_id, to_role: data.to_role }).first();
      if (!previous || dateOnly(previous.assessed_date) > data.assessed_date) reject('Reassessment must follow this employee’s assessment for the same next step.');
    }
    const [row] = await trx('field_promotion_assessments').insert({ ...baseRow(data, actor), technician_id: data.technician_id, previous_id: data.previous_id, assessed_date: data.assessed_date, from_role: data.from_role, to_role: data.to_role, rubric_version: data.rubric_version, assessment: data, result }).returning('*');
    await audit(trx, 'field_promotion_assessments', row, actor);
    return row;
  });
}

function monthRange(month) {
  const start = `${month}-01`;
  const next = new Date(`${start}T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: next.toISOString().slice(0, 10) };
}

async function serviceRows(conn, technicianId, range, serviceId = null) {
  const query = conn('field_production_simulations as p')
    .join('field_service_evidence as e', 'e.id', 'p.evidence_id')
    .join('technicians as reviewer', 'reviewer.id', 'e.created_by')
    .where('p.technician_id', technicianId)
    .select('p.id', 'p.rule_id', 'p.level_id', 'p.calculation', 'e.id as evidence_id', 'e.base_id', 'e.revision', 'e.service_id', 'e.service_date', 'e.service_key', 'e.service_label', 'e.facts', 'e.created_at', 'reviewer.name as reviewer_name');
  if (serviceId) query.where('e.service_id', serviceId);
  if (range) query.where('e.service_date', '>=', range.start).where('e.service_date', '<', range.end);
  const rows = await currentOnly(query, 'field_service_evidence', 'e').orderBy('e.service_date', 'desc').orderBy('e.service_id').limit(5001);
  if (rows.length > 5000) reject('This period is too large to calculate in one statement.', 409);
  return rows.map(row => ({ ...row, service_date: dateOnly(row.service_date), workweek_start: etWeekStart(parseETDateTime(`${dateOnly(row.service_date)}T12:00`)), facts: { ...row.facts, participants: row.facts.participants.filter(p => p.technician_id === technicianId) } }));
}

async function missingServices(conn, technicianId, range, evidence) {
  const rows = await conn('scheduled_services').where({ technician_id: technicianId })
    .where('scheduled_date', '>=', range.start).where('scheduled_date', '<', range.end)
    .where(q => q.where('status', 'completed').orWhereNotNull('actual_end_time').orWhereNotNull('completed_at'))
    .whereNotIn('id', evidence.map(row => row.service_id))
    .select('id', 'service_type', 'scheduled_date', 'status').orderBy('scheduled_date').limit(5001);
  if (rows.length > 5000) reject('Too many services without evidence to calculate this period.', 409);
  return rows.map(row => ({ ...row, scheduled_date: dateOnly(row.scheduled_date) }));
}

function outcomeWithCoverage(kind, evidence, rule, today, missing, level) {
  const outcome = outcomeBonus(kind, evidence, rule, today);
  if (!['technician_i', 'technician_ii'].includes(level?.role_key)) return { ...outcome, status: 'definition_needed', amount_cents: null, reason: 'The monthly field outcome bonus is modeled for Technician I and II only.' };
  if (!missing.length) return outcome;
  return { ...outcome, status: 'unresolved', amount_cents: null, rate: null, missing_evidence: missing.length, reason: `${missing.length} performed services still need evidence. They have not been treated as successful handoffs or rework-free services.` };
}

async function loadOverview(conn, technicianId, selectedMonth) {
  const person = await employee(conn, technicianId);
  const range = monthRange(selectedMonth);
  const today = etDateString(new Date());
  const [entries, levels, rule, assessments, businesses, reviews, statements] = await Promise.all([
    serviceRows(conn, technicianId, range),
    conn('field_program_levels').where({ technician_id: technicianId }).orderBy('effective_date', 'desc'),
    ruleAt(conn, range.start),
    conn('field_promotion_assessments as a').join('technicians as assessor', 'assessor.id', 'a.created_by')
      .where('a.technician_id', technicianId).select('a.*', 'assessor.name as assessor_name').orderBy('a.assessed_date', 'desc').orderBy('a.created_at', 'desc').limit(100),
    currentOnly(conn('field_business_evidence as b').where('b.technician_id', technicianId)
      .where('b.accepted_date', '>=', range.start).where('b.accepted_date', '<', range.end).select('b.*'), 'field_business_evidence', 'b').orderBy('b.accepted_date', 'desc').orderBy('b.estimate_id').limit(5001),
    conn('review_incentive_payouts').where({ technician_id: technicianId })
      .where('earned_at', '>=', parseETDateTime(`${range.start}T00:00`)).where('earned_at', '<', parseETDateTime(`${range.end}T00:00`))
      .select('id', 'amount_cents', 'currency', 'status', 'earned_at', 'exported_at', 'paid_at').orderBy('earned_at', 'desc'),
    conn('field_simulation_statements').where({ technician_id: technicianId, month: selectedMonth }).select('id', 'created_at', 'statement').orderBy('created_at', 'desc').limit(20),
  ]);
  if (businesses.length > 5000) reject('Too many new-business records to calculate this period.', 409);
  const missing = await missingServices(conn, technicianId, range, entries);
  const level = levels.find(row => dateOnly(row.effective_date) <= today) || null;
  const monthlyLevel = levels.find(row => dateOnly(row.effective_date) <= range.start) || null;
  const businessRules = businesses.length ? await conn('field_program_rules').whereIn('id', businesses.map(row => row.rule_id).filter(Boolean)) : [];
  const business = businesses.map(row => ({ ...row, accepted_date: dateOnly(row.accepted_date), calculation: commission(row.facts, businessRules.find(item => item.id === row.rule_id)?.definition, today) }));
  const simulation = {
    mode: 'simulation', program_version: PROGRAM.version, month: selectedMonth, as_of_date: today,
    period_closed: range.end <= today, rule_id: rule?.id || null,
    production: { amount_cents: entries.reduce((sum, row) => sum + (row.calculation.amount_cents || 0), 0), calculated: entries.filter(row => row.calculation.status === 'simulated').length, needs_evidence: entries.filter(row => row.calculation.amount_cents == null).length + missing.length },
    rework: outcomeWithCoverage('rework', entries, rule?.definition, today, missing, monthlyLevel),
    handoff: outcomeWithCoverage('handoff', entries, rule?.definition, today, missing, monthlyLevel),
    commission: { amount_cents: business.reduce((sum, row) => sum + (row.calculation.amount_cents || 0), 0), potential_cents: business.reduce((sum, row) => sum + row.calculation.potential_cents, 0), needs_definition: business.filter(row => row.calculation.amount_cents == null).length },
    evidence_ids: entries.map(row => row.evidence_id).sort(), business_evidence_ids: business.map(row => row.id).sort(),
    missing_service_ids: missing.map(row => row.id).sort(),
  };
  // A mid-month level change requires a defined monthly treatment before
  // the model can award a full role-specific monthly bonus.
  if (levels.some(row => dateOnly(row.effective_date) > range.start && dateOnly(row.effective_date) < range.end && dateOnly(row.effective_date) <= today)) {
    for (const kind of ['rework', 'handoff']) simulation[kind] = { ...simulation[kind], status: 'definition_needed', amount_cents: null, reason: 'Monthly treatment of an effective level change has not been defined.' };
  }
  return { program: PROGRAM, person, month: selectedMonth, level, levels, rule, entries, missing, business, assessments, reviews, simulation, statements };
}

async function overview(technicianId, selectedMonth) {
  return db.transaction(async trx => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return loadOverview(trx, technicianId, selectedMonth);
  });
}

async function saveStatement(technicianId, selectedMonth, actor) {
  requireManager(actor);
  return db.transaction(async trx => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const view = await loadOverview(trx, technicianId, selectedMonth);
    // Keep the actual formulas and source snapshots with the saved result.
    // It must still be explainable after a future algorithm revision.
    const statement = { ...view.simulation, rule: view.rule, levels: view.levels, entries: view.entries, missing: view.missing, business: view.business };
    const inputHash = hash(statement);
    const row = { id: randomUUID(), technician_id: technicianId, month: selectedMonth, created_by: actor.id, input_hash: inputHash, statement };
    const [saved] = await trx('field_simulation_statements').insert(row).onConflict(['technician_id', 'month', 'input_hash']).ignore().returning('*');
    if (saved) await audit(trx, 'field_simulation_statements', saved, actor);
    return saved || trx('field_simulation_statements').where({ technician_id: technicianId, month: selectedMonth, input_hash: inputHash }).first();
  });
}

async function setup() {
  const [people, services, rules] = await Promise.all([
    db('technicians').whereNot('employment_status', 'prospective').whereIn('role', ['admin', 'technician']).select('id', 'name', 'employment_status').orderBy('name'),
    db('services').whereNotNull('service_key').select('service_key', 'name', 'category').orderBy('name'),
    db('field_program_rules').orderBy('effective_date', 'desc'),
  ]);
  return { people, services, rules, program: PROGRAM };
}

async function visitOptions(technicianId, selectedMonth) {
  await employee(db, technicianId);
  const range = monthRange(selectedMonth);
  return db('scheduled_services as ss').leftJoin('services as s', 's.id', 'ss.service_id')
    .where('ss.technician_id', technicianId).where('ss.scheduled_date', '>=', range.start).where('ss.scheduled_date', '<', range.end)
    .where(q => q.where('ss.status', 'completed').orWhereNotNull('ss.actual_end_time').orWhereNotNull('ss.completed_at'))
    .select('ss.id', 'ss.customer_id', 'ss.service_type', 'ss.scheduled_date', 'ss.status', db.raw('COALESCE(ss.service_key_snapshot, s.service_key) as service_key'))
    .orderBy('ss.scheduled_date', 'desc').limit(500);
}

async function evidenceDetail(serviceId) {
  const visit = await visitFacts(db, serviceId);
  const owners = await allocationCustomers(db, visit.customer_id);
  const [revisions, allocations, returns] = await Promise.all([
    db('field_service_evidence').where({ service_id: serviceId }).orderBy('revision', 'desc'),
    db('field_credit_allocations').whereIn('customer_id', owners).where({ property_id: visit.property_id, service_key: visit.service_key }).orderBy('coverage_start', 'desc'),
    db('scheduled_services as ss').leftJoin('services as s', 's.id', 'ss.service_id')
      .where({ 'ss.customer_id': visit.customer_id, 'ss.property_id': visit.property_id, 'ss.status': 'completed' }).whereNot('ss.id', visit.id)
      .where('ss.scheduled_date', '>=', visit.service_date).whereRaw('COALESCE(ss.service_key_snapshot, s.service_key) = ?', [visit.service_key])
      .select('ss.id', 'ss.service_type', 'ss.scheduled_date').orderBy('ss.scheduled_date', 'desc').limit(200),
  ]);
  return { visit, revisions, allocations, returns };
}

async function estimateOptions(selectedMonth) {
  const range = monthRange(selectedMonth);
  return db('estimates').where({ status: 'accepted' }).where('accepted_at', '>=', parseETDateTime(`${range.start}T00:00`))
    .where('accepted_at', '<', parseETDateTime(`${range.end}T00:00`)).select('id', 'customer_name', 'accepted_at').orderBy('accepted_at', 'desc').limit(500);
}

async function score(serviceId, actor) {
  const visit = await visitFacts(db, serviceId);
  const technicianId = actor.role === 'admin' ? visit.technician_id : actor.id;
  const rows = technicianId ? await serviceRows(db, technicianId, null, serviceId) : [];
  if (actor.role !== 'admin' && visit.technician_id !== actor.id && !rows.length) reject('Service not found.', 404);
  return { program: PROGRAM, entries: rows, service_id: serviceId, can_manage: actor.role === 'admin' };
}

module.exports = { saveRule, saveLevel, saveAllocation, saveServiceEvidence, saveBusinessEvidence, saveAssessment, overview, saveStatement, setup, visitOptions, evidenceDetail, estimateOptions, score };
