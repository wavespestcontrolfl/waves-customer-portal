const { PROGRAM, ruleDefinition, allocatedCents, splitCents, production, outcomeBonus, commission, assessmentResult, schemas, validate } = require('../services/field-team-rules');
const { execFileSync } = require('node:child_process');

const rule = ruleDefinition({ service_rules: [{ service_key: 'pest_quarterly', credit_type: 'routine', rework_window_days: 30 }], rework_minimum: 10, handoff_minimum: 10, activation_share_bps: null });
const allocation = { service_key: 'pest_quarterly', net_value_cents: 60000, planned_visits: 4, credit_type: 'routine' };
const productionInput = { rule, allocation, roleKey: 'technician_i', serviceKey: 'pest_quarterly', ordinal: 1, participant: { value_cents: 15000, share_bps: 10000 }, exclusion: 'none', provenance: 'verified' };
const linkedReturn = { return_service_id: 'return-service', same_issue_confirmed: true, return_service_date: '2026-03-10' };
const evidence = (overrides = {}) => ({ service_key: 'pest_quarterly', service_date: '2026-03-01', created_at: '2026-04-01T16:00:00Z', facts: { provenance: 'verified', exclusion: 'none', complete_at_cutoff: true, cutoff_at: '2026-03-01T23:00:00Z', repair_reason: 'none', rework_outcome: 'no_return', ...overrides } });
const cohort = (size, failures = 0, kind = 'rework') => Array.from({ length: size }, (_, i) => evidence(i < failures ? kind === 'rework' ? { ...linkedReturn, rework_outcome: 'technician_execution' } : { complete_at_cutoff: false } : {}));

describe('Field Team Program revision 2b simulation contract', () => {
  test.each(['UTC', 'America/New_York'])('preserves PostgreSQL DATE calendar values under %s', timezone => {
    const result = execFileSync(process.execPath, ['-e', "const {dateOnly}=require(process.argv[1]); const parse=require('pg').types.getTypeParser(1082); process.stdout.write(JSON.stringify([dateOnly(parse('2026-09-09')), dateOnly('2026-09-09'), dateOnly(null)]));", require.resolve('../services/field-team-rules')], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual(['2026-09-09', '2026-09-09', null]);
  });
  test('keeps Technician II as the highest field title and the modeled targets reconcile', () => {
    expect(PROGRAM.roles.map(role => role.title)).toEqual(['Trainee', 'Technician I', 'Technician II', 'Service Manager', 'General Manager']);
    expect(PROGRAM.roles.slice(1).map(role => role.annualBaseCents + role.targetIncentiveCents)).toEqual([6800000, 7960000, 9000000, 12000000]);
    expect(PROGRAM.roles[0].hourlyCents).toBeNull();
    expect(PROGRAM.notice).toContain('not earned compensation');
  });
  test.each(['UTC', 'America/New_York'])('normalizes database dates before outcome arithmetic under %s', timezone => {
    const input = { rule, rows: cohort(10, 1) };
    const script = "const {outcomeBonus}=require(process.argv[1]); const parse=require('pg').types.getTypeParser(1082); const {rule,rows}=JSON.parse(process.argv[2]); rows.forEach(row=>{ row.service_date=parse(row.service_date); if(row.facts.return_service_date) row.facts.return_service_date=parse(row.facts.return_service_date); }); process.stdout.write(JSON.stringify(['rework','handoff'].map(kind=>outcomeBonus(kind,rows,rule,'2026-04-01'))));";
    const result = execFileSync(process.execPath, ['-e', script, require.resolve('../services/field-team-rules'), JSON.stringify(input)], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    expect(JSON.parse(result)).toMatchObject([{ status: 'simulated', failures: 1, amount_cents: 0 }, { status: 'simulated', amount_cents: 10000 }]);
  });
  test('allocates accepted program value by scheduled applications regardless of billing cadence', () => {
    expect(allocatedCents(60000, 4, 1)).toBe(15000);
    expect(allocatedCents(108000, 9, 9)).toBe(12000);
    expect([1, 2, 3].map(ordinal => allocatedCents(100, 3, ordinal))).toEqual([34, 33, 33]);
    expect(() => allocatedCents(60000, 4, 5)).toThrow('Invalid allocation');
  });
  test('crew splits reconcile to cents and reject two full shares', () => {
    const crew = [{ technician_id: 'b', share_bps: 5000 }, { technician_id: 'a', share_bps: 5000 }];
    expect(splitCents(15001, crew).map(p => [p.technician_id, p.value_cents])).toEqual([['a', 7501], ['b', 7500]]);
    expect(() => splitCents(15000, crew.map(p => ({ ...p, share_bps: 10000 })))).toThrow('total 100%');
  });
  test.each([['technician_i', 900], ['technician_ii', 1200]])('%s adds the modeled production amount', (roleKey, amount) => {
    expect(production({ ...productionInput, roleKey })).toMatchObject({ status: 'simulated', amount_cents: amount });
  });
  test.each(['corrective', 'duplicate', 'unnecessary', 'planned_followup', 'inspection'])('%s produces no credit', exclusion => {
    expect(production({ ...productionInput, exclusion })).toMatchObject({ status: 'excluded', amount_cents: 0 });
  });
  test.each([{ provenance: 'backfilled' }, { rule: null }, { serviceKey: 'unknown' }])('exclusions cannot hide unverified or unmapped production: %j', change => {
    expect(production({ ...productionInput, exclusion: 'corrective', ...change }).amount_cents).toBeNull();
  });
  test('verified corrective work needs no allocation, while production must use the matching service key', () => {
    expect(production({ ...productionInput, exclusion: 'corrective', allocation: null, roleKey: null })).toMatchObject({ status: 'excluded', amount_cents: 0 });
    expect(production({ ...productionInput, allocation: { ...allocation, service_key: 'different_routine' } }).amount_cents).toBeNull();
  });
  test.each([
    { provenance: 'synthetic' }, { provenance: 'backfilled' }, { rule: null }, { roleKey: null },
    { allocation: null }, { serviceKey: 'new_unmapped_service' }, { roleKey: 'trainee' }, { roleKey: 'service_manager' },
    { rule: { service_rules: [{ service_key: 'pest_quarterly', credit_type: 'specialty' }] }, allocation: { ...allocation, credit_type: 'specialty' } },
  ])('does not invent credit when eligibility or evidence is missing: %j', changes => {
    expect(production({ ...productionInput, ...changes }).amount_cents).toBeNull();
  });
  test.each([[0, 20000], [2, 20000], [4, 10000], [6, 0], [10, 0]])('rework %i%% maps to the stated simulation endpoints', (failures, amount) => {
    expect(outcomeBonus('rework', cohort(100, failures), rule, '2026-04-01').amount_cents).toBe(amount);
  });
  test.each([[0, 10000], [2, 10000], [6, 5000], [10, 0], [20, 0]])('handoff failures %i%% use the modeled curve', (failures, amount) => {
    expect(outcomeBonus('handoff', cohort(100, failures, 'handoff'), rule, '2026-04-01').amount_cents).toBe(amount);
  });
  test('missing definitions, low volume, maturity and unresolved evidence stay distinct', () => {
    expect(outcomeBonus('rework', cohort(100), { ...rule, rework_minimum: null }, '2026-04-01').status).toBe('definition_needed');
    expect(outcomeBonus('rework', [], rule, '2026-04-01').status).toBe('not_enough_evidence');
    expect(outcomeBonus('rework', cohort(100), rule, '2026-03-30').status).toBe('observing');
    expect(outcomeBonus('rework', [evidence({ rework_outcome: 'unresolved' })], rule, '2026-04-01').status).toBe('unresolved');
    expect(outcomeBonus('handoff', [evidence({ complete_at_cutoff: null })], rule, '2026-04-01').amount_cents).toBeNull();
    expect(outcomeBonus('rework', [{ ...evidence(), service_date: null }], rule, '2026-04-01').status).toBe('unresolved');
  });
  test('a return outside the observation window does not become technician fault', () => {
    expect(outcomeBonus('rework', [evidence({ ...linkedReturn, rework_outcome: 'technician_execution', return_service_date: '2026-05-01' })], { ...rule, rework_minimum: 1 }, '2026-05-02')).toMatchObject({ status: 'unresolved', amount_cents: null });
  });
  test('unverified or unmapped evidence cannot disappear from an otherwise passing cohort', () => {
    for (const kind of ['handoff', 'rework']) {
      expect(outcomeBonus(kind, [...cohort(10), evidence({ provenance: 'backfilled' })], rule, '2026-04-01').status).toBe('unresolved');
      expect(outcomeBonus(kind, [...cohort(10), { ...evidence(), service_key: null }], rule, '2026-04-01').status).toBe('unresolved');
      expect(outcomeBonus(kind, [...cohort(10), evidence({ exclusion: 'corrective', provenance: 'backfilled' })], rule, '2026-04-01').status).toBe('unresolved');
      expect(outcomeBonus(kind, [...cohort(10), { ...evidence({ exclusion: 'corrective' }), service_key: null }], rule, '2026-04-01').status).toBe('unresolved');
      expect(outcomeBonus(kind, [...cohort(10), { ...evidence(), service_key: 'not_in_effective_rule' }], rule, '2026-04-01').status).toBe('unresolved');
      expect(outcomeBonus(kind, [...cohort(10), { ...evidence({ exclusion: 'corrective' }), service_key: 'not_in_effective_rule' }], rule, '2026-04-01').status).toBe('unresolved');
    }
  });
  test.each([{ return_service_id: null }, { same_issue_confirmed: false }, { return_service_date: null }, { return_service_date: '2026-02-01' }])('keeps an unqualified return unresolved: %j', missing => {
    expect(outcomeBonus('rework', [...cohort(10), evidence({ ...linkedReturn, rework_outcome: 'technician_execution', ...missing })], rule, '2026-04-01')).toMatchObject({ status: 'unresolved', amount_cents: null });
  });
  test('dated rules retain all formula inputs independently of the current model', () => {
    const later = ruleDefinition({ ...rule, activation_share_bps: 4000 });
    later.formula.production_bps.technician_i = 900;
    later.formula.commission_bps = 700;
    later.formula.outcome_curves.rework.maximum = 30000;
    expect(production({ ...productionInput, rule: later }).amount_cents).toBe(1350);
    expect(production(productionInput).amount_cents).toBe(900);
    expect(outcomeBonus('rework', cohort(10), later, '2026-04-01').amount_cents).toBe(30000);
    expect(outcomeBonus('rework', cohort(10), rule, '2026-04-01').amount_cents).toBe(20000);
    const facts = { accepted_net_cents: 60000, baseline_cents: 10000, activation_date: null };
    expect(commission(facts, later, '2026-04-01').potential_cents).toBe(3500);
    expect(commission(facts, rule, '2026-04-01').potential_cents).toBe(2500);
    expect(production({ ...productionInput, rule: { ...rule, formula: undefined } }).amount_cents).toBe(900);
    expect(production({ ...productionInput, rule: { ...rule, formula: undefined, program_version: 'unknown' } }).amount_cents).toBeNull();
  });
  test('a premature no-return review needs a review after the observation window closes', () => {
    expect(outcomeBonus('rework', [...cohort(10), { ...evidence(), created_at: '2026-03-02T16:00:00Z' }], rule, '2026-04-01')).toMatchObject({ status: 'unresolved', amount_cents: null });
  });
  test('non-technician causation does not count as avoidable rework', () => {
    expect(outcomeBonus('rework', cohort(10).map(row => ({ ...row, facts: { ...row.facts, ...linkedReturn, rework_outcome: 'protocol' } })), rule, '2026-04-01')).toMatchObject({ amount_cents: 20000, failures: 0 });
  });
  test('missing rework windows never produce a passing result', () => {
    expect(outcomeBonus('rework', cohort(100), { ...rule, service_rules: [{ ...rule.service_rules[0], rework_window_days: null }] }, '2026-04-01').amount_cents).toBeNull();
  });
  test('unknown commission splits stay unset; there is no implicit 50/50', () => {
    const facts = { accepted_net_cents: 60000, baseline_cents: 10000, activation_date: null };
    expect(commission(facts, rule, '2026-04-01')).toMatchObject({ potential_cents: 2500, amount_cents: null, activation_cents: null });
  });
  test('activation needs payment evidence and retention needs the complete 90 days and review', () => {
    const facts = { accepted_net_cents: 60000, baseline_cents: 10000, activation_date: '2026-01-01', payment_reference: 'Verified payment', retained_at_90: true, retention_reference: 'Verified retained account' };
    const defined = { ...rule, activation_share_bps: 4000 };
    expect(commission({ ...facts, payment_reference: '' }, defined, '2026-04-01').amount_cents).toBe(0);
    expect(commission(facts, defined, '2026-03-31')).toMatchObject({ activation_cents: 1000, retention_cents: 0, retention_due: '2026-04-01' });
    expect(commission(facts, defined, '2026-04-01')).toMatchObject({ activation_cents: 1000, retention_cents: 1500, amount_cents: 2500 });
    expect(commission({ ...facts, retained_at_90: false }, defined, '2026-04-01').retention_cents).toBe(0);
  });
  test('technical advancement needs evidence but no management vacancy', () => {
    const facts = { from_role: 'technician_i', to_role: 'technician_ii', sustained_results: 'verified', items: [{ result: 'pass', critical: true }], position_available: false };
    expect(assessmentResult(facts)).toEqual({ status: 'qualified_for_consideration', management: false, position_available: null });
    expect(assessmentResult({ ...facts, items: [{ result: 'not_observed', critical: true }] }).status).toBe('development_needed');
    expect(assessmentResult({ ...facts, sustained_results: 'not_enough_evidence' }).status).toBe('development_needed');
  });
  test('management development is paid and qualification remains separate from vacancy', () => {
    const facts = { from_role: 'technician_ii', to_role: 'service_manager', sustained_results: 'verified', items: [{ result: 'pass' }], paid_development_reference: '', position_available: false };
    expect(assessmentResult(facts).status).toBe('development_needed');
    expect(assessmentResult({ ...facts, paid_development_reference: 'Retained paid assignment' })).toMatchObject({ status: 'qualified_for_consideration', position_available: false });
    expect(() => assessmentResult({ ...facts, to_role: 'general_manager' })).toThrow('next step');
  });
  test('request schemas reject attempted live amounts or payroll statuses', () => {
    expect(() => validate(schemas.level, { id: '00000000-0000-4000-8000-000000000001', technician_id: '00000000-0000-4000-8000-000000000002', role_key: 'technician_i', effective_date: '2026-09-01', status: 'earned', amount_cents: 500 })).toThrow('not allowed');
  });
});
