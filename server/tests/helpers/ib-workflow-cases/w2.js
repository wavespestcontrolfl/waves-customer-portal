'use strict';

// W2 Customer situation before a call. Reads only. The scripted model looks the customer up and
// reads detail, schedule, thread and open promises; every fact in the results is checked against
// the rows this case seeded, and nothing may be written.

const { phone, nextWeekdayET, plusDaysET } = require('../ib-workflow-fixtures');
const { sameDay, pick, lookupThen, has, rowState, noWrites } = require('./common');

async function seedBriefSet(cast) {
  const set = {};
  set.fennimore = await cast.customer({ first_name: 'Quill', last_name: 'Fennimore', phone: phone(301) });
  set.fennimoreHome = await cast.property(set.fennimore.id, { is_primary: true, label: 'home', address_line1: '3 Fixture Row' });
  set.promise = await cast.commitment(set.fennimore.id, { description: 'Call them back about the quote', due_at: new Date(Date.now() + 40 * 60000) });
  set.inbound = await cast.sms(set.fennimore.id, { direction: 'inbound', from_phone: set.fennimore.phone, to_phone: '+19413335555', message_body: 'Can you come sooner?', status: 'received', created_at: new Date(Date.now() - 2 * 3600000) });
  set.outbound = await cast.sms(set.fennimore.id, { direction: 'outbound', from_phone: '+19413335555', to_phone: set.fennimore.phone, message_body: 'We will call you shortly.', status: 'delivered', created_at: new Date(Date.now() - 3600000) });
  set.ostrander = await cast.customer({ first_name: 'Rune', last_name: 'Ostrander', phone: phone(302) });
  await cast.property(set.ostrander.id, { is_primary: true, address_line1: '5 Fixture Row' });
  set.pellham = await cast.customer({ first_name: 'Pia', last_name: 'Pellham', phone: phone(303) });
  set.pellhamHome = await cast.property(set.pellham.id, { is_primary: true, address_line1: '7 Fixture Row' });
  set.pellhamNext = await cast.visit(set.pellham.id, { scheduled_date: nextWeekdayET(2), window_start: '09:00', window_end: '11:00', property_id: set.pellhamHome.id });
  set.pellhamLastDate = plusDaysET(-10);
  set.pellhamLast = await cast.visit(set.pellham.id, { scheduled_date: set.pellhamLastDate, status: 'completed', property_id: set.pellhamHome.id });
  await cast.serviceRecord(set.pellham.id, { service_date: set.pellhamLastDate });
  set.murphyA = await cast.customer({ first_name: 'Ada', last_name: 'Murphy', phone: phone(111) });
  set.murphyAHome = await cast.property(set.murphyA.id, { is_primary: true, label: 'home', address_line1: '11 Fixture Row' });
  set.murphyARental = await cast.property(set.murphyA.id, { label: 'rental', address_line1: '13 Fixture Row', occupancy_type: 'rental_investment', relationship: 'rental_owned' });
  set.murphyB = await cast.customer({ first_name: 'Bram', last_name: 'Murphy', phone: phone(222) });
  set.murphyBHome = await cast.property(set.murphyB.id, { is_primary: true, label: 'home', address_line1: '17 Fixture Row' });
  return set;
}

// The four readers a pre-call brief draws on, in one round after the customer lookup.
const briefTools = (id) => [['get_customer_detail', { customer_id: id }], ['get_open_commitments', { customer_id: id }], ['get_conversation_thread', { customer_id: id }], ['get_schedule_view', { date_from: plusDaysET(-30), date_to: plusDaysET(30) }]];

/** Facts in the detail result against the seeded rows. */
function checkDetail(ctx, detail, customer, { properties = [], upcoming = [], recentDates = [] } = {}) {
  if (!ctx.check(detail && detail.profile, 'tool_result', 'detail_missing', `get_customer_detail returned ${detail && (detail.code || detail.error) || 'nothing'}`)) return;
  ctx.check(detail.profile.id === customer.id && detail.profile.name === `${customer.first_name} ${customer.last_name}`, 'tool_result', 'profile_mismatch', `profile ${detail.profile.name}`);
  ctx.check(detail.profile.phone === customer.phone, 'tool_result', 'profile_phone_mismatch', `phone ${detail.profile.phone}`);
  const addresses = (detail.properties || []).map((p) => p.address_line1);
  for (const p of properties) ctx.check(addresses.includes(p.address_line1), 'tool_result', 'property_missing', `property ${p.address_line1} absent from ${JSON.stringify(addresses)}`);
  ctx.check((detail.properties || []).length === properties.length, 'tool_result', 'property_count_mismatch', `${(detail.properties || []).length} properties, expected ${properties.length}`);
  for (const v of upcoming) {
    const found = (detail.upcoming_services || []).find((u) => u.id === v.id);
    ctx.check(!!found, 'tool_result', 'upcoming_visit_missing', `upcoming visit ${v.id} absent`);
    if (found) {
      ctx.check(sameDay(found.date, v.scheduled_date), 'tool_result', 'upcoming_date_mismatch', `date ${found.date}, seeded ${v.scheduled_date}`);
      ctx.check(String(found.time_window || '').startsWith(`${v.window_start}`) && String(found.time_window || '').includes(`${v.window_end}`), 'tool_result', 'upcoming_window_mismatch', `window ${found.time_window}, seeded ${v.window_start}-${v.window_end}`);
      ctx.check(found.property_id === v.property_id, 'tool_result', 'upcoming_property_mismatch', `property ${found.property_id}, seeded ${v.property_id}`);
    }
  }
  for (const date of recentDates) ctx.check((detail.recent_services || []).some((s) => sameDay(s.date, date) && s.status === 'completed'), 'tool_result', 'last_visit_missing', `completed visit on ${date} absent from recent_services`);
}

function checkThread(ctx, thread, set) {
  if (!ctx.check(thread && Array.isArray(thread.messages), 'tool_result', 'thread_missing', `thread ${thread && (thread.code || thread.error) || 'nothing'}`)) return;
  const inbound = thread.messages.find((m) => m.body === set.inbound.message_body);
  const outbound = thread.messages.find((m) => m.body === set.outbound.message_body);
  ctx.check(inbound && inbound.direction === 'inbound' && Math.abs(new Date(inbound.time) - new Date(set.inbound.created_at)) < 2000, 'tool_result', 'inbound_message_wrong', `inbound ${JSON.stringify(inbound)}`);
  ctx.check(outbound && outbound.direction === 'outbound' && Math.abs(new Date(outbound.time) - new Date(set.outbound.created_at)) < 2000, 'tool_result', 'outbound_message_wrong', `outbound ${JSON.stringify(outbound)}`);
}

function checkCommitments(ctx, result, expected) {
  if (!ctx.check(result && Array.isArray(result.commitments), 'tool_result', 'commitments_missing', `commitments ${result && (result.code || result.error) || 'nothing'}`)) return;
  ctx.check(result.total_open === expected.length, 'tool_result', 'commitment_count_mismatch', `total_open ${result.total_open}, expected ${expected.length}`);
  for (const c of expected) {
    const found = result.commitments.find((r) => r.id === c.id);
    ctx.check(!!found && found.description === c.description && !!found.due_at, 'tool_result', 'commitment_wrong', `commitment ${JSON.stringify(found)}`);
  }
}

// Row VALUES, not counts: a status flipped, a message marked read or a promise edited in place must fail a read.
const snapshot = (h, cast) => rowState(h, cast);

/** No other seeded customer's id, number or name appears in any reader result of the turn (a brief is one account). */
function noOtherAccounts(ctx, turn, set, others) {
  const results = turn.toolCalls.map((t) => t.result);
  for (const other of others) {
    const found = [other.id, other.phone, `${other.first_name} ${other.last_name}`].filter((needle) => has(results, needle));
    const tools = [...new Set(turn.toolCalls.filter((t) => has(t.result, other.id) || has(t.result, other.phone) || has(t.result, `${other.first_name} ${other.last_name}`)).map((t) => t.name))];
    ctx.check(found.length === 0, 'target_resolution', 'other_account_facts_in_brief', `${other.last_name} (${found.length} of id, phone, name) appears in the result of ${tools.join(', ')} for a brief of ${set.fennimore.last_name}`);
  }
}

const CASES = {};

async function fennimoreBrief(ctx, h, cast, c, page) {
  const set = await seedBriefSet(cast);
  const before = await snapshot(h, cast);
  const { prompt } = await ctx.establish({ prompt: c.request, page: page(set), customer: set.fennimore });
  const turn = await ctx.turn(h.actors.owner, { prompt, page: page(set), rounds: lookupThen('Fennimore', briefTools) });
  checkDetail(ctx, pick(turn, 'get_customer_detail'), set.fennimore, { properties: [set.fennimoreHome] });
  checkCommitments(ctx, pick(turn, 'get_open_commitments'), [set.promise]);
  checkThread(ctx, pick(turn, 'get_conversation_thread'), set);
  noOtherAccounts(ctx, turn, set, [set.ostrander, set.pellham, set.murphyA, set.murphyB]);
  await noWrites(ctx, h, cast, before);
  ctx.markCompleted();
  return { set, turn };
}

CASES['W2-dev-01'] = (ctx, h, cast, c) => fennimoreBrief(ctx, h, cast, c, () => ({}));
CASES['W2-dev-02'] = (ctx, h, cast, c) => fennimoreBrief(ctx, h, cast, c, (set) => ({ customerId: set.fennimore.id }));

CASES['W2-dev-03'] = async (ctx, h, cast, c) => {
  const set = await seedBriefSet(cast);
  const before = await snapshot(h, cast);
  const page = { customerId: set.murphyA.id };
  const first = await ctx.establish({ prompt: c.request, page, customer: set.murphyA });
  const turn = await ctx.turn(h.actors.owner, { prompt: first.prompt, page, rounds: [{ tools: briefTools(set.murphyA.id) }] });
  checkDetail(ctx, pick(turn, 'get_customer_detail'), set.murphyA, { properties: [set.murphyAHome, set.murphyARental] });
  // The correction: the other Murphy, with Murphy A still open behind the bar.
  const corr = c.corrections[0].request;
  const second = await ctx.establish({ prompt: corr, page, customer: set.murphyB });
  const turn2 = await ctx.turn(h.actors.owner, { prompt: second.prompt, page, sessionId: turn.sessionId, rounds: [{ tools: briefTools(set.murphyB.id) }] });
  const detailB = pick(turn2, 'get_customer_detail');
  checkDetail(ctx, detailB, set.murphyB, { properties: [set.murphyBHome] });
  ctx.check(!has(turn2.toolCalls.map((t) => t.result), set.murphyARental.address_line1) && !has(detailB, set.murphyA.id), 'target_resolution', 'other_account_facts_carried_over', 'Murphy A facts appeared in the re-brief of Murphy B');
  await noWrites(ctx, h, cast, before);
  ctx.markCompleted();
};

CASES['W2-dev-04'] = async (ctx, h, cast, c) => {
  const set = await seedBriefSet(cast);
  const before = await snapshot(h, cast);
  const { prompt } = await ctx.establish({ prompt: c.request, customer: set.ostrander });
  const turn = await ctx.turn(h.actors.owner, { prompt, rounds: lookupThen('Ostrander', (id) => [['get_open_commitments', { customer_id: id }]]) });
  checkCommitments(ctx, pick(turn, 'get_open_commitments'), []);
  await noWrites(ctx, h, cast, before);
  ctx.markCompleted();
};

CASES['W2-dev-05'] = async (ctx, h, cast, c) => {
  const set = await seedBriefSet(cast);
  const before = await snapshot(h, cast);
  const { prompt } = await ctx.establish({ prompt: c.request, customer: set.pellham });
  const turn = await ctx.turn(h.actors.owner, { prompt, rounds: lookupThen('Pellham', (id) => [['get_customer_detail', { customer_id: id }], ['get_schedule_view', { date_from: plusDaysET(0), date_to: plusDaysET(14) }]]) });
  checkDetail(ctx, pick(turn, 'get_customer_detail'), set.pellham, { properties: [set.pellhamHome], upcoming: [set.pellhamNext] });
  const schedule = pick(turn, 'get_schedule_view');
  const entry = schedule && (schedule.appointments || []).find((a) => a.id === set.pellhamNext.id);
  ctx.check(!!entry && sameDay(entry.date, set.pellhamNext.scheduled_date), 'tool_result', 'schedule_view_missing_visit', 'next visit absent from the schedule view');
  if (entry) ctx.check(String(entry.time_window || '').includes('11'), 'tool_result', 'schedule_view_window_has_no_end', `schedule view window "${entry.time_window}" carries the start only, seeded 09:00-11:00`);
  await noWrites(ctx, h, cast, before);
  ctx.markCompleted();
};

CASES['W2-dev-06'] = async (ctx, h, cast, c) => {
  const set = await seedBriefSet(cast);
  // brief-visit-unfinished: the latest visit row is still scheduled, no completion record.
  await h.db('scheduled_services').where({ id: set.pellhamLast.id }).update({ status: 'confirmed' });
  await h.db('service_records').where({ customer_id: set.pellham.id }).del();
  const before = await snapshot(h, cast);
  const { prompt } = await ctx.establish({ prompt: c.request, customer: set.pellham });
  const turn = await ctx.turn(h.actors.owner, { prompt, rounds: lookupThen('Pellham', (id) => [['get_customer_detail', { customer_id: id }], ['get_schedule_view', { date_from: plusDaysET(-14), date_to: plusDaysET(0) }]]) });
  const detail = pick(turn, 'get_customer_detail');
  ctx.check(!((detail && detail.recent_services) || []).some((s) => sameDay(s.date, set.pellhamLastDate) && s.status === 'completed'), 'tool_result', 'completion_invented', 'a completed service record exists for a visit that has none');
  const schedule = pick(turn, 'get_schedule_view');
  const row = schedule && (schedule.appointments || []).find((a) => a.id === set.pellhamLast.id);
  ctx.check(!!row && row.status !== 'completed', 'tool_result', 'unfinished_visit_not_visible', `the past scheduled visit is ${row ? `reported as ${row.status}` : 'absent from the schedule view'}, so the brief cannot say its outcome is unknown`);
  await noWrites(ctx, h, cast, before);
  ctx.markCompleted();
};

CASES['W2-dev-07'] = async (ctx, h, cast, c) => {
  const set = await seedBriefSet(cast);
  const before = await snapshot(h, cast);
  const page = { customerId: set.fennimore.id };
  const turn = await ctx.turn(h.actors.owner, { prompt: c.request, page, rounds: [{ tools: [['query_customers', { search: 'Murphy' }]] }] });
  const found = ((pick(turn, 'query_customers') || {}).customers || []).map((x) => x.id).sort();
  ctx.check(JSON.stringify(found) === JSON.stringify([set.murphyA.id, set.murphyB.id].sort()), 'tool_result', 'murphy_lookup_wrong', `lookup returned ${found.length} accounts`);
  ctx.check(!turn.body.taskTarget || turn.body.taskTarget.customer_id !== set.fennimore.id, 'target_resolution', 'viewed_customer_selected_over_named', 'the viewed Fennimore account became the target of a request naming Murphy');
  ctx.check(!has(turn.toolCalls.map((t) => t.result), set.fennimore.id), 'target_resolution', 'wrong_account_facts_delivered', 'Fennimore facts reached the model for a Murphy request');
  ctx.expectNoAttempt('the correct model asks which Murphy; the lookup above returns both accounts and no write is issued');
  await noWrites(ctx, h, cast, before);
  ctx.markCompleted();
};

CASES['W2-dev-08'] = async (ctx, h, cast, c) => {
  const set = await seedBriefSet(cast);
  const before = await snapshot(h, cast);
  const page = { customerId: set.pellham.id };
  const { prompt } = await ctx.establish({ prompt: c.request, page, customer: set.pellham });
  const turn = await ctx.turn(h.actors.owner, { prompt, page, rounds: [{ tools: [['get_customer_detail', { customer_id: set.pellham.id }]] }] });
  const detail = pick(turn, 'get_customer_detail');
  checkDetail(ctx, detail, set.pellham, { properties: [set.pellhamHome] });
  ctx.check(detail && detail.coverage && detail.coverage.invoices, 'tool_result', 'invoice_coverage_not_declared', 'the customer reader does not declare how much of the invoice history it read');
  ctx.check(detail && Array.isArray(detail.recent_invoices) && !detail.balance, 'tool_result', 'balance_stated_without_reader', 'a balance field appeared with no invoice or payment reader behind it');
  await noWrites(ctx, h, cast, before);
  ctx.markCompleted();
};

CASES['W2-dev-09'] = async (ctx, h, cast, c) => {
  const set = await seedBriefSet(cast);
  const before = await snapshot(h, cast);
  const { prompt } = await ctx.establish({ prompt: c.request, customer: set.pellham });
  const turn = await ctx.turn(h.actors.admin, { prompt, rounds: lookupThen('Pellham', (id) => [['get_customer_detail', { customer_id: id }], ['get_schedule_view', { date_from: plusDaysET(0), date_to: plusDaysET(14) }]]) });
  checkDetail(ctx, pick(turn, 'get_customer_detail'), set.pellham, { properties: [set.pellhamHome], upcoming: [set.pellhamNext] });
  ctx.check(turn.cards.length === 0, 'proposal', 'read_proposed_a_card', 'a read produced a confirmation card');
  await noWrites(ctx, h, cast, before);
  ctx.markCompleted();
};

CASES['W2-dev-10'] = async (ctx, h, cast, c) => {
  const set = await seedBriefSet(cast);
  const before = await snapshot(h, cast);
  const { prompt } = await ctx.establish({ prompt: c.request, customer: set.fennimore });
  const first = await ctx.turn(h.actors.owner, { prompt, rounds: lookupThen('Fennimore', briefTools) });
  checkThread(ctx, pick(first, 'get_conversation_thread'), set);
  // The response is lost; the panel reloads and recovers the saved task.
  const taskId = first.body && first.body.taskId;
  const recovered = taskId ? await h.task(h.actors.owner, taskId, first.sessionId) : { status: 0 };
  ctx.check(recovered.status === 200 && recovered.body && recovered.body.taskId === taskId, 'recovery', 'task_not_recoverable', `GET task status ${recovered.status}`);
  // A new inbound text arrives, then the operator asks again.
  await noWrites(ctx, h, cast, before);
  const arrived = await cast.sms(set.fennimore.id, { direction: 'inbound', from_phone: set.fennimore.phone, to_phone: '+19413335555', message_body: 'Also the gate is open now.', created_at: new Date() });
  await ctx.fixtureChanged();
  const afterArrival = await snapshot(h, cast); // the arrival is the one legitimate new row; the second ask may not change anything
  const again = await ctx.turn(h.actors.owner, { prompt, rounds: lookupThen('Fennimore', briefTools), sessionKey: 'second' });
  const thread = pick(again, 'get_conversation_thread');
  ctx.check(thread && (thread.messages || []).some((m) => m.body === arrived.message_body && m.direction === 'inbound' && Math.abs(new Date(m.time) - new Date(arrived.created_at)) < 2000), 'tool_result', 'new_inbound_text_missing', 'the second ask does not include the text that arrived after the first');
  await noWrites(ctx, h, cast, afterArrival);
  ctx.markCompleted();
};

module.exports = { CASES };
