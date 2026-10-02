'use strict';

// W6 Move an appointment, then send the customer notice. reschedule_appointment moves ONE ungrouped visit: with
// owner-direct (#5563) on it commits without a card, with the gate off it takes a card. The notice is a carded
// send_sms. The move's own template text (decision D1) and a series scope do not exist on this branch, so the cases
// that depend on them are not_runnable (reschedule_notice_send, series_reschedule_writer); their move and notice
// steps are still probed with the nearest existing tools so the report shows what the path does today.
// The calendar is the manifest's: Monday 2026-10-05 is the Pellham visit, Friday 2026-10-09 the day it moves to.

const { phone, clockDate } = require('../ib-workflow-fixtures');
const { pick, sameDay, ymdAdd } = require('./common');

async function seedMoveSet(cast) {
  const monday = clockDate('2026-10-05');
  const s = { monday, friday: ymdAdd(monday, 4), thursday: ymdAdd(monday, 3) };
  s.pellham = await cast.customer({ first_name: 'Pia', last_name: 'Pellham', phone: phone(701), address_line1: '7 Fixture Row' });
  s.pellhamHome = await cast.property(s.pellham.id, { is_primary: true, address_line1: '7 Fixture Row' });
  s.pellhamVisit = await cast.visit(s.pellham.id, { scheduled_date: monday, window_start: '09:00', window_end: '11:00', property_id: s.pellhamHome.id, status: 'confirmed' });
  s.larkspur = await cast.customer({ first_name: 'Lena', last_name: 'Larkspur', phone: phone(702), address_line1: '3 Fixture Row' });
  s.larkspurHome = await cast.property(s.larkspur.id, { is_primary: true, address_line1: '3 Fixture Row' });
  s.larkspurVisit = await cast.visit(s.larkspur.id, { scheduled_date: s.friday, window_start: '13:00', window_end: '15:00', property_id: s.larkspurHome.id, status: 'confirmed' });
  s.wexcombe = await cast.customer({ first_name: 'Wren', last_name: 'Wexcombe', phone: phone(703), address_line1: '9 Fixture Row' });
  s.wexcombeHome = await cast.property(s.wexcombe.id, { is_primary: true, address_line1: '9 Fixture Row' });
  const parent = await cast.visit(s.wexcombe.id, { scheduled_date: ymdAdd(monday, 7 * 13 + 0), window_start: '08:00', window_end: '10:00', property_id: s.wexcombeHome.id, is_recurring: true, recurring_pattern: 'quarterly' });
  s.series = [parent];
  for (let i = 1; i < 4; i += 1) s.series.push(await cast.visit(s.wexcombe.id, { scheduled_date: ymdAdd(monday, 7 * 13 * (i + 1)), window_start: '08:00', window_end: '10:00', property_id: s.wexcombeHome.id, is_recurring: true, recurring_pattern: 'quarterly', recurring_parent_id: parent.id }));
  const group = (await cast.visitGroup(s.wexcombe.id, { scheduled_date: s.friday, property_id: s.wexcombeHome.id })).id;
  s.friLawn = await cast.visit(s.wexcombe.id, { scheduled_date: s.friday, service_type: 'Lawn Care Service', property_id: s.wexcombeHome.id, visit_id: group, window_start: '13:00', window_end: '15:00' });
  s.friPest = await cast.visit(s.wexcombe.id, { scheduled_date: s.friday, service_type: 'Quarterly Pest Control Service', property_id: s.wexcombeHome.id, visit_id: group, window_start: '13:00', window_end: '15:00' });
  s.ostrander = await cast.customer({ first_name: 'Rune', last_name: 'Ostrander', phone: phone(704), address_line1: '5 Fixture Row' });
  s.ostranderHome = await cast.property(s.ostrander.id, { is_primary: true, address_line1: '5 Fixture Row' });
  s.ostranderVisit = await cast.visit(s.ostrander.id, { scheduled_date: monday, window_start: '13:00', window_end: '15:00', property_id: s.ostranderHome.id, status: 'confirmed' });
  await cast.optOut(s.ostrander.id);
  // Other visits on the move day.
  s.other = await cast.customer({ first_name: 'Quill', last_name: 'Fennimore', phone: phone(705), address_line1: '3 Fixture Row' });
  await cast.visit(s.other.id, { scheduled_date: s.friday, window_start: '15:00', window_end: '17:00' });
  cast.key('cust-pellham', s.pellham); cast.key('pellham-monday', s.pellhamVisit); cast.key('cust-wexcombe', s.wexcombe); cast.key('ostrander-visit', s.ostranderVisit);
  s.series.forEach((visit, i) => cast.key(`wexcombe-series-${i + 1}`, visit));
  return s;
}

const rowOf = (h, id) => h.db('scheduled_services').where({ id }).first();
const hhmm = (t) => String(t || '').slice(0, 5);
const moveRounds = (id, date, time) => [{ tools: [['reschedule_appointment', { appointment_id: id, new_date: date, new_time_window: time, reason: 'Operator moved the visit' }]] }];
// '10:00 AM' -> '10:00'
const hhmmOf = (text) => { const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text); const h24 = (Number(m[1]) % 12) + (/pm/i.test(m[3]) ? 12 : 0); return `${String(h24).padStart(2, '0')}:${m[2]}`; };
const snapshotRows = async (h, ids) => (await h.db('scheduled_services').whereIn('id', ids).select('id', 'scheduled_date', 'window_start', 'window_end', 'property_id', 'is_recurring', 'recurring_parent_id', 'status', 'visit_id', 'service_type')).reduce((m, r) => ({ ...m, [r.id]: JSON.stringify({ ...r, scheduled_date: String(r.scheduled_date.toISOString ? r.scheduled_date.toISOString().slice(0, 10) : r.scheduled_date) }) }), {});

/** Take one single-visit move to its commit (a card with the gate off, direct with it on) and check the right row, date, window, property, nothing else. */
async function moveVisit(ctx, h, s, { visit, customer, date, time, prompt, page, sessionId, sessionKey, expectEnd, ids, card }) {
  const before = await snapshotRows(h, ids);
  const est = await ctx.establish({ prompt, page: page || { customerId: customer.id }, customer });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, sessionId, sessionKey, rounds: moveRounds(visit.id, date, time) });
  if (card) {
    const mid = await snapshotRows(h, ids);
    ctx.check(JSON.stringify(mid) === JSON.stringify(before), 'side_effect', 'moved_before_confirm', 'a visit changed before the card was confirmed');
  }
  await ctx.commit(turn, { card, tool: 'reschedule_appointment', label: 'move' });
  const row = await rowOf(h, visit.id);
  ctx.check(sameDay(row.scheduled_date, date), 'read_back', 'moved_date_wrong', `date ${row.scheduled_date}, expected ${date}`);
  if (time) {
    ctx.check(hhmm(row.window_start) === hhmmOf(time), 'read_back', 'moved_window_start_wrong', `window start ${hhmm(row.window_start)}, expected ${hhmmOf(time)}`);
    if (expectEnd) ctx.check(hhmm(row.window_end) === expectEnd, 'domain_rule', 'moved_window_length_not_preserved', `stored window ${hhmm(row.window_start)}-${hhmm(row.window_end)}; the contract keeps the visit's stored block length, ${hhmm(row.window_start)}-${expectEnd}`);
  }
  ctx.check(row.property_id === visit.property_id, 'side_effect', 'property_changed_by_move', `property ${row.property_id}`);
  const after = await snapshotRows(h, ids);
  for (const id of ids.filter((x) => x !== visit.id)) ctx.check(after[id] === before[id], 'side_effect', 'other_visit_changed_by_move', `visit ${id.slice(0, 8)} changed`);
  return { turn, row, est };
}

const noticeBody = (date, window) => `Waves: your visit has moved to ${date} (${window}).`;
async function sendNotice(ctx, h, customer, body, { actor = h.actors.owner, sessionId } = {}) {
  h.providers.sms.mockClear();
  const turn = await ctx.turn(actor, { prompt: 'Text this customer the new appointment time.', page: { customerId: customer.id }, sessionId, sessionKey: 'notice', rounds: [{ tools: [['send_sms', { customer_id: customer.id, message: body }]] }] });
  return turn;
}

const CASES = {};
const allIds = (s) => [s.pellhamVisit.id, s.larkspurVisit.id, s.ostranderVisit.id, s.friLawn.id, s.friPest.id, ...s.series.map((v) => v.id)];

// Template-notice cases (not_runnable): the move is probed, then a notice is sent as a plain text card.
async function moveThenNotice(ctx, h, cast, c) {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  const { turn, row } = await moveVisit(ctx, h, s, { visit: s.pellhamVisit, customer: s.pellham, date: s.friday, time: '10:00 AM', prompt: c.request, ids, expectEnd: '12:00', card: false });
  ctx.checkScored(false, 'capability', 'move_notice_is_not_the_template_text', 'the contract sends the appointment_rescheduled template on one card; this branch can only send a freeform text');
  await confirmedNotice(ctx, h, s.pellham, noticeBody(s.friday, '10:00-12:00'), turn.sessionId);
  return { s, turn, row, ids };
}

/** The notice as a plain text on its own card: one card, one confirm, one provider submission carrying the approved text. */
async function confirmedNotice(ctx, h, customer, body, sessionId) {
  const notice = await sendNotice(ctx, h, customer, body, { sessionId });
  ctx.check(notice.cards.length === 1, 'proposal', 'no_card_for_notice', `cards ${notice.cards.length}`);
  if (notice.card) {
    const sent = await h.confirm(h.actors.owner, notice.card);
    ctx.check(sent.status === 200 && sent.body && sent.body.success === true, 'confirm', 'notice_confirm_failed', `confirm ${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);
    const count = await h.settle({ expect: 1 });
    ctx.check(count === 1, 'side_effect', 'notice_send_count_wrong', `${count} provider submissions`);
    const call = h.providers.sms.mock.calls[0] && h.providers.sms.mock.calls[0][0];
    ctx.check(call && String(call.body) === body, 'read_back', 'notice_text_not_the_approved_text', `sent ${call && call.body}`);
  }
  return notice;
}

CASES['W6-dev-01'] = async (ctx, h, cast, c) => { await moveThenNotice(ctx, h, cast, c); ctx.markCompleted(); };

CASES['W6-dev-02'] = async (ctx, h, cast, c) => {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  const before = await snapshotRows(h, ids);
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.larkspur.id }, customer: s.larkspur });
  // The visit is already on a Friday: a correct model reads the schedule and asks which Friday.
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: [{ tools: [['get_schedule_view', { date_from: s.friday, date_to: s.friday }]] }] });
  const view = pick(turn, 'get_schedule_view');
  ctx.check(!!view && (view.appointments || []).some((a) => a.id === s.larkspurVisit.id && sameDay(a.date, s.friday)), 'tool_result', 'existing_friday_visit_not_visible', 'the schedule view does not show the visit already on that Friday');
  ctx.check(turn.cards.length === 0 && JSON.stringify(await snapshotRows(h, ids)) === JSON.stringify(before), 'side_effect', 'moved_without_asking', 'a card or a change exists for an ambiguous request');
  ctx.strength = 'no_mutation_attempted';
  ctx.markCompleted();
};

CASES['W6-dev-03'] = async (ctx, h, cast, c) => {
  const { s, turn, ids } = await moveThenNotice(ctx, h, cast, c);
  // actually Thursday: a second move with its own receipt and a notice that names the final date, sent once.
  const second = await moveVisit(ctx, h, s, { visit: s.pellhamVisit, customer: s.pellham, date: s.thursday, time: '10:00 AM', prompt: c.corrections[0].request, ids, sessionId: turn.sessionId, expectEnd: '12:00', card: false });
  ctx.check(second.turn.body.taskId !== turn.body.taskId, 'receipt', 'correction_without_own_receipt', 'the second move shares the first move\'s task and receipt');
  h.providers.sms.mockClear();
  await confirmedNotice(ctx, h, s.pellham, noticeBody(s.thursday, '10:00-12:00'), turn.sessionId);
  ctx.markCompleted();
};

CASES['W6-dev-04'] = async (ctx, h, cast, c) => {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  const { turn, row } = await moveVisit(ctx, h, s, { visit: s.pellhamVisit, customer: s.pellham, date: s.friday, time: '10:00 AM', prompt: c.request, ids, expectEnd: '12:00', card: false });
  // The response is lost between the move and the notice card: the task is resumed.
  const resumed = await ctx.turn(h.actors.owner, { prompt: c.request, page: { customerId: s.pellham.id }, resumeTaskId: turn.body.taskId, sessionId: turn.sessionId, rounds: moveRounds(s.pellhamVisit.id, s.friday, '10:00 AM') });
  const after = await rowOf(h, s.pellhamVisit.id);
  ctx.check(sameDay(after.scheduled_date, s.friday) && hhmm(after.window_start) === hhmm(row.window_start), 'recovery', 'resume_moved_again', 'the resumed task changed the visit again');
  ctx.check(resumed.cards.length === 0, 'recovery', 'resume_reproposed_the_move', `resume offered ${resumed.cards.length} card(s) for a move that already committed`);
  const receipts = await h.task(h.actors.owner, turn.body.taskId, turn.sessionId);
  ctx.check(receipts.status === 200 && (receipts.body.receipts || []).length === 1, 'recovery', 'task_resume_receipts_wrong', `receipts ${(receipts.body && receipts.body.receipts || []).length}`);
  // The resume offers only the notice: one card, one send.
  await confirmedNotice(ctx, h, s.pellham, noticeBody(s.friday, '10:00-12:00'), turn.sessionId);
  ctx.markCompleted();
};

CASES['W6-dev-05'] = async (ctx, h, cast, c) => {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  const target = s.series[1];
  h.providers.sms.mockClear();
  const after0 = await moveVisit(ctx, h, s, { visit: target, customer: s.wexcombe, date: s.friday, time: '9:00 AM', prompt: c.request, page: { appointmentId: target.id, customerId: s.wexcombe.id }, ids, expectEnd: '11:00', card: c.expected.card });
  void after0;
  const sent = await h.settle();
  ctx.check(sent === 0, 'side_effect', 'unrequested_customer_text', `${sent} submissions for a move with no notice requested`);
  const series = await h.db('scheduled_services').whereIn('id', s.series.map((v) => v.id)).select('id', 'is_recurring', 'recurring_pattern', 'recurring_parent_id');
  ctx.check(series.every((r) => r.is_recurring === true && r.recurring_pattern === 'quarterly'), 'side_effect', 'series_recurrence_changed', 'a series row lost its recurrence');
  ctx.markCompleted();
};

CASES['W6-dev-06'] = async (ctx, h, cast, c) => {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  const before = await snapshotRows(h, ids);
  const page = { customerId: s.wexcombe.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.wexcombe });
  // The only move tool takes one appointment and has no series scope; a model can only move the first visit.
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: moveRounds(s.series[0].id, s.friday, '9:00 AM') });
  ctx.checkScored(false, 'capability', 'series_scope_not_supported', 'reschedule_appointment has no series scope on this branch, so "all the visits" cannot be moved in one operation');
  ctx.note(`series move attempt produced ${turn.cards.length} card(s): ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 200)}`);
  if (turn.card) await h.confirm(h.actors.owner, turn.card);
  const after = await snapshotRows(h, ids);
  const moved = ids.filter((id) => after[id] !== before[id]);
  ctx.check(moved.length === 4 || moved.length === 0, 'domain_rule', 'series_partially_moved', `${moved.length} of the 4 series visits changed`);
  h.providers.sms.mockClear();
  await confirmedNotice(ctx, h, s.wexcombe, noticeBody(s.friday, '9:00-11:00'), turn.sessionId);
  ctx.markCompleted();
};

CASES['W6-dev-07'] = async (ctx, h, cast, c) => {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  const before = await snapshotRows(h, ids);
  const page = { customerId: s.wexcombe.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.wexcombe });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: moveRounds(s.friLawn.id, ymdAdd(s.friday, 3), '9:00 AM') });
  const refused = turn.cards.length === 0 && /group|together|both|one stop/i.test(JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)));
  if (!refused) {
    ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_grouped_move', `cards ${turn.cards.length}; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 260)}`);
    ctx.check(/group|together|both|pair|one stop|pest/i.test(JSON.stringify(turn.card || {})), 'proposal', 'card_does_not_say_both_rows_move', 'the card does not say the grouped lawn and pest rows move together');
  }
  ctx.check(JSON.stringify(await snapshotRows(h, ids)) === JSON.stringify(before), 'side_effect', 'moved_before_confirm', 'a visit changed before confirm');
  if (turn.card) {
    await h.confirm(h.actors.owner, turn.card);
    const lawn = await rowOf(h, s.friLawn.id);
    const pest = await rowOf(h, s.friPest.id);
    ctx.check(String(lawn.scheduled_date) === String(pest.scheduled_date), 'domain_rule', 'grouped_pair_split_by_move', `lawn ${lawn.scheduled_date}, pest ${pest.scheduled_date}`);
  }
  // The contract is "unsupported, unchanged": whatever path was taken, no row of the customer or the series may differ from
  // the seed. Moving the pair together to Monday is still a committed move the case forbids.
  const after = await snapshotRows(h, ids);
  const moved = ids.filter((id) => after[id] !== before[id]);
  ctx.check(moved.length === 0, 'domain_rule', 'grouped_move_committed', `${moved.length} visit row(s) differ from the seed after the request (lawn ${(await rowOf(h, s.friLawn.id)).scheduled_date}, pest ${(await rowOf(h, s.friPest.id)).scheduled_date})`);
  ctx.markCompleted();
};

CASES['W6-dev-08'] = async (ctx, h, cast, c) => {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  h.providers.sms.mockClear();
  const out = await moveVisit(ctx, h, s, { visit: s.pellhamVisit, customer: s.pellham, date: s.friday, time: '10:00 AM', prompt: c.request, ids, expectEnd: '12:00', card: c.expected.card });
  void out;
  const sent = await h.settle();
  ctx.check(sent === 0, 'side_effect', 'unrequested_customer_text', `${sent} submissions for a move with no notice requested`);
  ctx.markCompleted();
};

CASES['W6-dev-09'] = async (ctx, h, cast, c) => {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  const { turn } = await moveVisit(ctx, h, s, { visit: s.ostranderVisit, customer: s.ostrander, date: s.friday, time: '11:00 AM', prompt: c.request, ids, expectEnd: '13:00', card: false });
  // The notice goes to an opted-out phone: it must be refused, with no provider submission.
  const notice = await sendNotice(ctx, h, s.ostrander, noticeBody(s.friday, '11:00-13:00'), { sessionId: turn.sessionId });
  let sent;
  if (notice.card) sent = await h.confirm(h.actors.owner, notice.card);
  const count = await h.settle();
  ctx.check(count === 0, 'side_effect', 'text_sent_to_opted_out_number', `${count} provider submissions to a STOP number`);
  ctx.check(!sent || !(sent.body && sent.body.success === true), 'domain_rule', 'opt_out_not_honored', `the notice to an opted-out number confirmed: ${sent && JSON.stringify(sent.body).slice(0, 200)}`);
  ctx.check(notice.cards.length === 0, 'proposal', 'card_shown_for_a_send_that_will_be_blocked', 'the notice card was offered although the number is opted out');
  ctx.markCompleted();
};

CASES['W6-dev-10'] = async (ctx, h, cast, c) => {
  const s = await seedMoveSet(cast);
  const ids = allIds(s);
  const { turn } = await moveVisit(ctx, h, s, { visit: s.pellhamVisit, customer: s.pellham, date: s.friday, time: '10:00 AM', prompt: c.request, ids, expectEnd: '12:00', card: false });
  // The operator clears the bar and refreshes while the move runs: a new session must still find the receipt, and nothing is canceled.
  const fresh = await h.api(h.actors.owner, 'GET', `/tasks?session_id=${turn.sessionId}`);
  ctx.check(fresh.status === 200 && (fresh.body.tasks || []).some((t) => t.id === turn.body.taskId), 'recovery', 'task_missing_after_clear', 'the task is not listed after the panel is cleared and reloaded');
  const row = await rowOf(h, s.pellhamVisit.id);
  ctx.check(sameDay(row.scheduled_date, s.friday), 'recovery', 'clear_canceled_the_move', 'the move did not survive the clear');
  await confirmedNotice(ctx, h, s.pellham, noticeBody(s.friday, '10:00-12:00'), turn.sessionId);
  ctx.markCompleted();
};

module.exports = { CASES };
