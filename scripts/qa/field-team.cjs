'use strict';
// Real Postgres + HTTP/auth verification. Resets ONLY this feature's simulation
// records in the worktree-owned QA database; uses synthetic people and work.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readContext, childEnvironment } = require('../dev/context');
const context = readContext();
if (process.env.WAVES_LOCAL_DEV !== '1') {
  const child = require('node:child_process').spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    cwd: context.root, stdio: 'inherit', env: { ...childEnvironment(context, { database: true }), TZ: 'UTC', GATE_FIELD_TEAM_PROGRAM: 'true' },
  });
  process.exit(child.status ?? 1);
}
if (process.env.RAILWAY_DEPLOYMENT_ID || new URL(process.env.DATABASE_URL).pathname !== `/waves_qa_${context.id.replaceAll('-', '')}`) {
  throw new Error('Field team QA requires this worktree’s dedicated database.');
}
const assert = require('node:assert/strict');
const calendarFields = new Set(['effective_date', 'coverage_start', 'coverage_end', 'scheduled_date', 'service_date', 'accepted_date', 'assessed_date']);
function assertCalendarDates(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (calendarFields.has(key) && item != null) assert.match(item, /^\d{4}-\d{2}-\d{2}$/, `${key} stays a calendar date`);
    else assertCalendarDates(item);
  }
}
const { v5 } = require('uuid');
const jwt = require('jsonwebtoken');
const express = require('express');
const db = require('../../server/models/db');
const { createScheduledService } = require('../../server/services/booking/create-scheduled-service');
const { etDateString, parseETDateTime, addETDays } = require('../../server/utils/datetime-et');
const id = name => v5(`field-team-qa:${name}`, context.id);
const fixtureFile = path.join(context.root, '.tmp', 'qa', 'field-team-fixture.json');
const tables = ['field_program_rules', 'field_program_levels', 'field_credit_allocations', 'field_service_evidence',
  'field_production_simulations', 'field_business_evidence', 'field_promotion_assessments', 'field_simulation_statements'];
const today = etDateString(new Date());
const month = etDateString(addETDays(new Date(), -150)).slice(0, 7);
const start = `${month}-01`;
const visitDate = `${month}-02`;
const f = { admin: id('admin'), tech: id('tech'), crew: id('crew'), prospect: id('prospect'), inactive: id('inactive'),
  merged: id('merged'), deleted: id('deleted'), early: id('early'), late: id('late'), untimed: id('untimed'), backfilled: id('backfilled'), garbled: id('garbled'), free: id('free'), propertyDup: id('propertyDup'), dupReturn: id('dupReturn'), overnight: id('overnight'), nightReturn: id('nightReturn'),
  customer: id('customer'), property: id('property'), visit: id('visit'), callback: id('callback'), missing: id('missing'),
  duplicate: id('duplicate'), unverified: id('unverified'), estimate: id('estimate'), review: id('review'), month, visitDate };

// Visits go through the booking stamping contract like the other QA harnesses (booking-insert-contract test);
// a re-run refreshes the deterministic fixture row in place instead of inserting it again.
async function seedVisit(trx, data) {
  if (await trx('scheduled_services').where({ id: data.id }).first('id')) {
    await trx('scheduled_services').where({ id: data.id }).update(data);
    return;
  }
  await createScheduledService({ trx, cols: await trx('scheduled_services').columnInfo(), source: { sourceAction: 'qa_fixture' }, insertData: data });
}

async function seed() {
  await db.transaction(async trx => {
    await trx.raw(`TRUNCATE ${tables.map(() => '??').join(', ')}`, tables);
    for (const [key, role, employment] of [['admin', 'admin', 'active'], ['tech', 'technician', 'active'], ['crew', 'technician', 'active'], ['prospect', 'technician', 'prospective'], ['inactive', 'technician', 'inactive']]) {
      const name = `QA Field ${key}`;
      const prior = await trx('technicians').where({ id: f[key] }).first();
      if (prior && prior.name !== name) throw new Error('Fixture ownership mismatch');
      await trx('technicians').insert({ id: f[key], name, role, employment_status: employment, active: employment === 'active',
        field_dispatchable: role === 'technician' && employment === 'active', email: `qa-field-${key}-${context.id.slice(0, 8)}@example.invalid`,
        pay_rate: key === 'tech' ? 22 : 27, auth_token_version: 1, must_change_password: false }).onConflict('id').merge();
    }
    await trx('customer_accounts').insert({ id: f.customer, first_name: 'QA Field', email: `qa-field-${context.id.slice(0, 8)}@example.invalid` }).onConflict('id').ignore();
    await trx('customers').insert({ id: f.customer, account_id: f.customer, first_name: 'QA', last_name: 'Field Customer',
      phone: '+19415550199', address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219' }).onConflict('id').ignore();
    await trx('customer_properties').insert({ id: f.property, customer_id: f.customer }).onConflict('id').ignore();
    // After a merge, the loser's copy of the same address survives on the winner as an inactive row with its own id.
    await trx('customer_properties').where({ id: f.property }).update({ address_key: `qa-field-${context.id.slice(0, 8)}` });
    await trx('customer_properties').insert({ id: f.propertyDup, customer_id: f.customer, address_key: `qa-field-${context.id.slice(0, 8)}`, is_primary: false, active: false }).onConflict('id').merge();
    // A merged-away account (journaled loser) and a plain soft-deleted account.
    for (const key of ['merged', 'deleted']) {
      await trx('customers').insert({ id: f[key], first_name: 'QA', last_name: `Field ${key}`, phone: `merged-${f[key].slice(0, 8)}`, address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219', active: false, deleted_at: trx.fn.now() }).onConflict('id').merge();
    }
    await trx('customer_merge_journal').where({ loser_customer_id: f.merged }).del();
    await trx('customer_merge_journal').insert({ winner_customer_id: f.customer, loser_customer_id: f.merged, loser_snapshot: {}, tier: 'manual', performed_by: 'qa:field-team' });
    const service = await trx('services').where({ service_key: 'pest_general_quarterly' }).first();
    assert.ok(service, 'migrated service catalog');
    for (const [key, day, status, callback] of [['visit', '02', 'completed', false], ['callback', '05', 'completed', true], ['missing', '06', 'on_site', false], ['duplicate', '07', 'completed', false], ['unverified', '08', 'completed', false]]) {
      await seedVisit(trx, { id: f[key], customer_id: f.customer, property_id: f.property, technician_id: f.tech,
        service_id: service.id, service_type: `${service.name} · QA ${key}`, service_key_snapshot: service.service_key,
        scheduled_date: `${month}-${day}`, status, is_callback: callback, actual_end_time: parseETDateTime(`${month}-${day}T12:00`) });
    }
    // Three completed same-day services for the crew member, ordered by operational end (or with none recorded).
    // Closeout stamps run the other way: the early visit was closed out last and the late one early, so completed_at
    // would order them wrongly; the late visit carries only a check-out time as its operational end.
    const ends = { early: { actual_end_time: '09:00', completed_at: '16:00' }, late: { check_out_time: '15:00', completed_at: '14:00' }, untimed: {} };
    for (const [key, stamps] of Object.entries(ends)) {
      const at = Object.fromEntries(['actual_end_time', 'check_out_time', 'completed_at'].map(col => [col, stamps[col] ? parseETDateTime(`${month}-09T${stamps[col]}`) : null]));
      await seedVisit(trx, { id: f[key], customer_id: f.customer, property_id: f.property, technician_id: f.crew,
        service_id: service.id, service_type: `${service.name} · QA ${key}`, service_key_snapshot: service.service_key,
        scheduled_date: `${month}-09`, status: 'completed', is_callback: false, ...at, actual_start_time: null });
    }
    // A backdated quiet closeout on the same day: completed_at carries the ET-noon day marker and the service record is frozen with structured_notes.backfill.
    await seedVisit(trx, { id: f.backfilled, customer_id: f.customer, property_id: f.property, technician_id: f.crew,
      service_id: service.id, service_type: `${service.name} · QA backfilled`, service_key_snapshot: service.service_key,
      scheduled_date: `${month}-09`, status: 'completed', is_callback: false, actual_end_time: null, completed_at: parseETDateTime(`${month}-09T12:00`), actual_start_time: parseETDateTime(`${month}-09T08:00`) });
    await trx('service_records').where({ scheduled_service_id: f.backfilled }).del();
    await trx('service_records').insert({ customer_id: f.customer, scheduled_service_id: f.backfilled, service_date: `${month}-09`, service_type: `${service.name} · QA backfilled`, status: 'completed', structured_notes: JSON.stringify({ backfill: true }) });
    // A same-day completion whose legacy service record holds a malformed serialized structured_notes string.
    await seedVisit(trx, { id: f.garbled, customer_id: f.customer, property_id: f.property, technician_id: f.crew,
      service_id: service.id, service_type: `${service.name} · QA garbled`, service_key_snapshot: service.service_key,
      scheduled_date: `${month}-09`, status: 'completed', is_callback: false, actual_end_time: null, completed_at: parseETDateTime(`${month}-09T10:00`), actual_start_time: null });
    await trx('service_records').where({ scheduled_service_id: f.garbled }).del();
    await trx('service_records').insert({ customer_id: f.customer, scheduled_service_id: f.garbled, service_date: `${month}-09`, service_type: `${service.name} · QA garbled`, status: 'completed', structured_notes: JSON.stringify('{"backfill": tru') });
    // A later completed return recorded against the retained duplicate property of the same address.
    await seedVisit(trx, { id: f.dupReturn, customer_id: f.customer, property_id: f.propertyDup, technician_id: f.crew,
      service_id: service.id, service_type: `${service.name} · QA duplicate-property return`, service_key_snapshot: service.service_key,
      scheduled_date: `${month}-11`, status: 'completed', is_callback: false, actual_end_time: parseETDateTime(`${month}-11T12:00`) });
    // A visit that runs past Eastern midnight, and a next-day visit that actually finished before it did.
    for (const [key, day, end] of [['overnight', '09', '10T01:00'], ['nightReturn', '10', '10T00:30']]) {
      await seedVisit(trx, { id: f[key], customer_id: f.customer, property_id: f.property, technician_id: f.crew,
        service_id: service.id, service_type: `${service.name} · QA ${key}`, service_key_snapshot: service.service_key,
        scheduled_date: `${month}-${day}`, status: 'completed', is_callback: false, actual_end_time: parseETDateTime(`${month}-${end}`) });
    }
    // An always-free visit type (by name) for the crew member, with a stale positive price.
    await seedVisit(trx, { id: f.free, customer_id: f.customer, property_id: f.property, technician_id: f.crew,
      service_id: service.id, service_type: 'Follow-up · QA free', service_key_snapshot: service.service_key, estimated_price: 95,
      scheduled_date: `${month}-10`, status: 'completed', is_callback: false, followup_included: false, actual_end_time: parseETDateTime(`${month}-10T12:00`) });
    await trx('estimates').insert({ id: f.estimate, customer_id: f.customer, status: 'accepted', accepted_at: parseETDateTime(`${visitDate}T12:00`), customer_name: 'QA Field Customer', created_by_technician_id: f.admin }).onConflict('id').merge();
    await trx('review_incentive_payouts').insert({ id: f.review, technician_id: f.tech, amount_cents: 2500, earned_at: parseETDateTime(`${visitDate}T12:00`), status: 'earned' }).onConflict('id').ignore();
    await trx('user_feature_flags').insert({ user_id: f.tech, flag_key: 'tech-field-workspace', enabled: true }).onConflict(['user_id', 'flag_key']).merge();
  });
}

const app = express();
app.use(express.json());
app.use('/api/tech/pay-growth', require('../../server/routes/tech-pay-growth'));
app.use('/api/admin/auth', require('../../server/routes/admin-auth'));
app.use('/api/admin/feature-flags', require('../../server/routes/admin-feature-flags'));
app.use('/api/admin/timetracking', require('../../server/routes/admin-timetracking'));
app.use('/api/tech/timetracking', require('../../server/routes/tech-timetracking'));
app.use((err, req, res, next) => { console.error('QA route failure', err.code, err.message); res.status(500).json({ error: 'QA route failure' }); });

async function run() {
  await seed();
  const server = await new Promise(resolve => { const listener = app.listen(process.argv.includes('--serve') ? context.ports.api : 0, '127.0.0.1', () => resolve(listener)); });
  let checks = 0;
  const tokens = Object.fromEntries(['admin', 'tech', 'crew', 'prospect', 'inactive'].map(key => [key, jwt.sign({ technicianId: f[key], type: 'access', tokenVersion: 1 }, context.jwtSecret, { expiresIn: '4h' })]));
  const url = `http://127.0.0.1:${server.address().port}/api/tech/pay-growth`;
  async function api(route, body, who = 'admin', expected = body ? 201 : 200) {
    const response = await fetch(`${url}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); checks += 1;
    assertCalendarDates(result);
    return result;
  }
  try {
    await api('/', null, 'prospect', 401); await api('/', null, 'inactive', 401);
    await api(`/?technicianId=${f.crew}`, null, 'tech', 403); await api('/setup', null, 'tech', 403);
    process.env.GATE_FIELD_TEAM_PROGRAM = 'false';
    assert.equal((await api('/availability', null, 'tech')).available, false);
    await api('/', null, 'admin', 404);
    process.env.GATE_FIELD_TEAM_PROGRAM = 'true';
    const rule = { id: randomUUID(), label: 'QA revision 2b', effective_date: start, service_rules: [{ service_key: 'pest_general_quarterly', credit_type: 'routine', rework_window_days: 30 }], rework_minimum: 1, handoff_minimum: 1, activation_share_bps: 4000 };
    await api('/rules', rule, 'tech', 403);
    const savedRule = await api('/rules', rule);
    assert.equal(savedRule.effective_date, start, 'rule calendar date is not serialized as an instant');
    assert.equal(savedRule.definition.formula.production_bps.technician_i, 600);
    assert.equal(savedRule.definition.formula.commission_bps, 500);
    assert.deepEqual((await api('/rules', rule)).definition, savedRule.definition);
    await api('/rules', { ...rule, label: 'Changed retry' }, 'admin', 409);
    for (const [key, role] of [['tech', 'technician_i'], ['crew', 'technician_ii']]) await api('/levels', { id: randomUUID(), technician_id: f[key], role_key: role, effective_date: start });
    await api('/levels', { id: randomUUID(), technician_id: f.prospect, role_key: 'technician_i', effective_date: start }, 'admin', 404);
    // The accepted scope was recorded against the address before the merge, so it sits on the retained duplicate property.
    const allocation = await api('/allocations', { id: randomUUID(), customer_id: f.customer, property_id: f.propertyDup, service_key: 'pest_general_quarterly', coverage_start: start, coverage_end: `${month}-28`, credit_type: 'routine', net_value_cents: 60000, planned_visits: 4, source_reference: 'QA accepted annual scope, four applications; monthly billing does not divide visit value.' });
    const mergedAllocation = { id: randomUUID(), customer_id: f.merged, property_id: null, service_key: 'pest_general_quarterly', coverage_start: start, coverage_end: `${month}-28`, credit_type: 'routine', net_value_cents: 60000, planned_visits: 4, source_reference: 'QA allocation aimed at a merged-away account' };
    assert.match((await api('/allocations', mergedAllocation, 'admin', 409)).error, /merged into another account/);
    // The surviving active property of the same address cannot host a second pool over the same service and period.
    assert.match((await api('/allocations', { id: randomUUID(), customer_id: f.customer, property_id: f.property, service_key: 'pest_general_quarterly', coverage_start: `${month}-20`, coverage_end: `${month}-25`, credit_type: 'routine', net_value_cents: 30000, planned_visits: 2, source_reference: 'QA pool on the merged duplicate property' }, 'admin', 409)).error, /already covers this service and period/);
    // Overlap is judged on customer, property, service and period alone: a shifted specialty pool over the same service is a duplicate.
    assert.match((await api('/allocations', { id: randomUUID(), customer_id: f.customer, property_id: f.property, service_key: 'pest_general_quarterly', coverage_start: `${month}-15`, coverage_end: `${month}-15`, credit_type: 'specialty', net_value_cents: 5000, planned_visits: 1, source_reference: 'QA overlapping specialty pool' }, 'admin', 409)).error, /already covers this service and period/);
    await api('/allocations', { ...mergedAllocation, id: randomUUID(), customer_id: f.deleted }, 'admin', 404);
    assert.equal(Number((await db('field_credit_allocations').whereIn('customer_id', [f.merged, f.deleted]).count('* as count').first()).count), 0);
    const evidence = { id: randomUUID(), service_id: f.visit, base_id: null, allocation_id: allocation.id, ordinal: 1,
      participants: [{ technician_id: f.tech, share_bps: 6000 }, { technician_id: f.crew, share_bps: 4000 }], provenance: 'verified', source_reference: 'QA verified completed visit and accepted scope', exclusion: 'none',
      cutoff_at: parseETDateTime(`${visitDate}T18:00`).toISOString(), complete_at_cutoff: true, repair_reason: 'none', repair_reference: '',
      rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, rework_reference: 'QA reviewed entire mature observation window' };
    await Promise.all([api('/service-evidence', evidence), api('/service-evidence', evidence)]);
    const futureCutoff = await api('/service-evidence', { ...evidence, id: randomUUID(), base_id: evidence.id, cutoff_at: new Date(Date.now() + 86400000).toISOString() }, 'admin', 400);
    assert.match(futureCutoff.error, /cutoff.*no later than now/);
    let view = await api(`/?month=${month}`, null, 'tech');
    assert.equal(view.entries.length, 1); assert.equal(view.entries[0].calculation.amount_cents, 540); assert.equal(view.entries[0].facts.participants.length, 1);
    assert.equal(view.person.pay_rate, '22.00'); assert.equal(view.simulation.handoff.status, 'unresolved'); assert.equal(view.missing.length, 4);
    const crewView = await api(`/?month=${month}`, null, 'crew');
    // A reviewed service reassigned afterwards keeps its frozen evidence and is not missing for the new assignee.
    await db('scheduled_services').where({ id: f.visit }).update({ technician_id: f.crew });
    assert.equal((await api(`/?month=${month}`, null, 'crew')).missing.some(row => row.id === f.visit), false);
    await db('scheduled_services').where({ id: f.visit }).update({ technician_id: f.tech });
    assert.equal(crewView.entries[0].calculation.amount_cents, 480); assert.equal(crewView.entries[0].facts.participants[0].technician_id, f.crew);
    await api(`/services/${f.missing}/score`, null, 'crew', 404);
    const laterCutoff = new Date().toISOString();
    await api('/service-evidence', { ...evidence, id: randomUUID(), service_id: f.duplicate, cutoff_at: laterCutoff }, 'admin', 409);
    await api('/service-evidence', { ...evidence, id: randomUUID(), service_id: f.callback, ordinal: 2, cutoff_at: laterCutoff }, 'admin', 400);
    for (const [key, exclusion, provenance] of [['callback', 'none', 'verified'], ['duplicate', 'duplicate', 'verified'], ['unverified', 'none', 'backfilled']]) {
      await api('/service-evidence', { ...evidence, id: randomUUID(), service_id: f[key], cutoff_at: laterCutoff, participants: [{ technician_id: f.tech, share_bps: 10000 }], allocation_id: null, ordinal: null, exclusion, provenance });
    }
    // Same-day returns: only a later recorded completion qualifies; equal dates alone fail closed.
    const sameDay = { ...evidence, id: randomUUID(), service_id: f.late, allocation_id: null, ordinal: null, participants: [{ technician_id: f.crew, share_bps: 10000 }], cutoff_at: laterCutoff, rework_outcome: 'technician_execution', return_service_id: f.early, same_issue_confirmed: true, rework_reference: 'QA same-day return review' };
    assert.match((await api('/service-evidence', sameDay, 'admin', 400)).error, /completed after the original service/);
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.early, return_service_id: f.untimed }, 'admin', 400)).error, /completed after the original service/);
    const orderedReturn = await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.early, return_service_id: f.late });
    assert.equal(orderedReturn.facts.return_service_date, `${month}-09`);
    // A return on the merged duplicate of the same address is the same property: it is offered and accepted as the qualifying return.
    assert.equal((await api(`/services/${f.early}/evidence`, null, 'admin')).returns.map(row => row.id).includes(f.dupReturn), true);
    assert.equal((await api('/service-evidence', { ...sameDay, id: randomUUID(), base_id: orderedReturn.id, service_id: f.early, return_service_id: f.dupReturn })).facts.return_service_date, `${month}-11`);
    // Real instants order services across midnight: a next-day cutoff or return that precedes the overnight completion is rejected.
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.overnight, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, cutoff_at: parseETDateTime(`${month}-10T00:30`).toISOString() }, 'admin', 400)).error, /may fall after midnight/);
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.overnight, return_service_id: f.nightReturn }, 'admin', 400)).error, /completed after the original service/);
    await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.overnight, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, cutoff_at: parseETDateTime(`${month}-10T02:00`).toISOString() });
    // Same-day cutoffs must follow the recorded completion; a start time alone never orders a same-day return.
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.late, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, cutoff_at: parseETDateTime(`${month}-09T14:00`).toISOString() }, 'admin', 400)).error, /cutoff must follow/);
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.untimed, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, cutoff_at: parseETDateTime(`${month}-09T23:00`).toISOString() }, 'admin', 400)).error, /same-day cutoff must follow/);
    await db('scheduled_services').where({ id: f.untimed }).update({ actual_start_time: parseETDateTime(`${month}-09T16:00`) });
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.late, return_service_id: f.untimed }, 'admin', 400)).error, /completed after the original service/);
    // A backfilled closeout's noon marker never proves sub-day order: a 13:00 cutoff and same-day returns in either direction fail closed.
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.backfilled, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, cutoff_at: parseETDateTime(`${month}-09T13:00`).toISOString() }, 'admin', 400)).error, /backdated closeout records only its service day/);
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.backfilled, return_service_id: f.late }, 'admin', 400)).error, /cannot order a same-day return/);
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.late, return_service_id: f.backfilled }, 'admin', 400)).error, /cannot order a same-day return/);
    await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.backfilled, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, cutoff_at: parseETDateTime(`${month}-10T09:00`).toISOString() });
    // Malformed legacy notes read as not backfilled: the visit stays usable and its real completion instant still orders a same-day cutoff.
    assert.equal((await api(`/services/${f.garbled}/evidence`, null, 'admin')).visit.backfilled, false);
    assert.match((await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.garbled, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, cutoff_at: parseETDateTime(`${month}-09T09:00`).toISOString() }, 'admin', 400)).error, /cutoff must follow/);
    await api('/service-evidence', { ...sameDay, id: randomUUID(), service_id: f.garbled, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, cutoff_at: parseETDateTime(`${month}-09T11:00`).toISOString() });
    // Always-free visit types are forced into the planned-follow-up exclusion and cannot claim an allocation.
    const freeEvidence = { ...sameDay, id: randomUUID(), service_id: f.free, rework_outcome: 'no_return', return_service_id: null, same_issue_confirmed: false, exclusion: 'none' };
    await api('/service-evidence', { ...freeEvidence, allocation_id: allocation.id, ordinal: 3 }, 'admin', 400);
    const freeSaved = await api('/service-evidence', freeEvidence);
    assert.equal(freeSaved.facts.exclusion, 'planned_followup');
    assert.equal((await api(`/services/${f.free}/score`, null, 'crew')).entries[0].calculation.amount_cents, 0);
    const callbackScore = await api(`/services/${f.callback}/score`, null, 'tech');
    assert.equal(callbackScore.entries[0].calculation.amount_cents, 0); assert.equal(callbackScore.entries[0].facts.exclusion, 'corrective');
    await api('/levels', { id: randomUUID(), technician_id: f.tech, role_key: 'technician_ii', effective_date: today });
    const revised = await api('/service-evidence', { ...evidence, id: randomUUID(), base_id: evidence.id, repair_reason: 'software_issue', repair_reference: 'QA verified software delivery error, underlying record complete' });
    view = await api(`/?month=${month}`, null, 'tech');
    assert.equal(view.entries.find(row => row.service_id === f.visit).calculation.amount_cents, 540);
    assert.equal(view.entries.find(row => row.service_id === f.visit).revision, 2);
    await api('/service-evidence', { ...evidence, id: randomUUID(), base_id: evidence.id }, 'admin', 409);
    await api('/service-evidence', { ...evidence, id: randomUUID(), base_id: revised.id, ordinal: 2 }, 'admin', 409);
    const business = { id: randomUUID(), base_id: null, estimate_id: f.estimate, technician_id: f.tech, baseline_cents: 10000, accepted_net_cents: 60000, source_reference: 'QA technician originated opportunity; office closed accepted estimate', activation_date: visitDate, payment_reference: 'QA verified qualifying payment', retained_at_90: null, retention_reference: '' };
    await api('/new-business', business);
    const futureActivation = await api('/new-business', { ...business, id: randomUUID(), base_id: business.id, activation_date: etDateString(addETDays(new Date(), 1)) }, 'admin', 400);
    assert.match(futureActivation.error, /Activation must fall between acceptance and today/);
    view = await api(`/?month=${month}`, null, 'tech'); assert.equal(view.business[0].calculation.amount_cents, 1000);
    await api('/new-business', { ...business, id: randomUUID(), base_id: business.id, technician_id: f.crew }, 'admin', 409);
    await api('/new-business', { ...business, id: randomUUID(), base_id: business.id, retained_at_90: true, retention_reference: 'QA verified retained after 90 days' });
    view = await api(`/?month=${month}`, null, 'tech'); assert.equal(view.business[0].calculation.amount_cents, 2500);
    // The starting role must be the employee's effective level on the assessed date (tech is Technician II from today).
    assert.match((await api('/assessments', { id: randomUUID(), technician_id: f.tech, previous_id: null, from_role: 'technician_i', to_role: 'technician_ii', assessed_date: today, rubric_version: 'QA published practical rubric v1', items: [{ label: 'Route audit', critical: true, result: 'pass', evidence: 'QA observed' }], sustained_results: 'verified', outcome_reference: 'QA retained', paid_development_reference: '', position_available: null }, 'admin', 400)).error, /starting role must match/);
    const assessment = await api('/assessments', { id: randomUUID(), technician_id: f.tech, previous_id: null, from_role: 'technician_ii', to_role: 'service_manager', assessed_date: today, rubric_version: 'QA published practical rubric v1', items: [{ label: 'Lead a route review', critical: true, result: 'pass', evidence: 'QA observed assessment' }], sustained_results: 'verified', outcome_reference: 'QA retained observation period', paid_development_reference: 'QA paid development assignment', position_available: false });
    assert.equal(assessment.result.status, 'qualified_for_consideration'); assert.equal(assessment.result.position_available, false);
    assert.equal((await db('technicians').where({ id: f.tech }).first()).pay_rate, '22.00');
    const snapshot = await api('/statements', { technician_id: f.tech, month });
    assert.equal((await api('/statements', { technician_id: f.tech, month })).id, snapshot.id);
    assert.equal(snapshot.statement.mode, 'simulation'); assert.equal(snapshot.statement.entries.find(row => row.service_id === f.visit).facts.participants.length, 1);
    assert.equal(snapshot.statement.missing[0].id, f.missing);
    assert.equal(snapshot.statement.rework.formula.maximum, 20000);
    assert.equal(snapshot.statement.business[0].calculation.rate_bps, 500);
    await assert.rejects(db('field_service_evidence').where({ id: evidence.id }).update({ revision: 9 }), error => error.code === '23514'); checks += 1;
    await assert.rejects(db('field_simulation_statements').where({ id: snapshot.id }).del(), error => error.code === '23514'); checks += 1;
    assert.equal(Number((await db('review_incentive_payouts').where({ id: f.review }).count('* as count').first()).count), 1);
    assert.equal((await db('review_incentive_payouts').where({ id: f.review }).first()).status, 'earned');
    const setup = await api('/setup'); assert.equal(setup.people.some(person => person.id === f.prospect), false);
    await api(`/visits?technicianId=${f.tech}&month=${month}`);
    // The visit on the surviving property sees and (above) claimed the allocation retained on the duplicate.
    assert.equal((await api(`/services/${f.visit}/evidence`)).allocations.map(row => row.id).includes(allocation.id), true);
    // A merge can retain two equivalent pools over one period; crediting then fails closed until an admin resolves them.
    const pool = await db('field_credit_allocations').where({ id: allocation.id }).first();
    const twinId = randomUUID();
    await db('field_credit_allocations').insert({ ...pool, id: twinId, property_id: f.property, coverage_start: `${month}-03`, coverage_end: `${month}-04`, planned_visits: 1, input_hash: twinId, created_at: undefined, source_reference: 'QA merge-retained duplicate pool' });
    assert.match((await api('/service-evidence', { ...evidence, id: randomUUID(), base_id: revised.id }, 'admin', 409)).error, /Duplicate accepted-value pools/);
    await db('field_credit_allocations').where({ id: twinId }).del().catch(() => {});
    fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
    fs.writeFileSync(fixtureFile, JSON.stringify({ ...f, tokens, revisedEvidence: revised.id }, null, 2), { mode: 0o600 });
    console.log(`Field team QA passed: ${checks} real database / authenticated HTTP checks plus calculation, privacy, immutability, and unchanged review-payout assertions.`);
    if (process.argv.includes('--serve')) { console.log(`QA API ready on loopback port ${server.address().port}`); return; }
  } finally {
    if (!process.argv.includes('--serve')) { await new Promise(resolve => server.close(resolve)); await db.destroy(); }
  }
}
run().catch(error => { console.error(error.stack); process.exit(1); });
