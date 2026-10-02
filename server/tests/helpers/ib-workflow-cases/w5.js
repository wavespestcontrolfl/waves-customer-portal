'use strict';

// W5 Book one service at an address and time. create_appointment prices, proposes a card that discloses the
// confirmation text, and commits on a confirmed card. The scripted model issues the calls a correct model
// would; the case verifies the saved row, the sends, and the recovery behaviour against the database.

const { phone, uuid, clockDate, plusDaysET } = require('../ib-workflow-fixtures');
const { pick, sendState } = require('./common');

const SERVICE = 'One-Time Pest Control Service';

async function seedBookSet(cast, { catalogPrice = 149 } = {}) {
  const s = {};
  s.service = await cast.oneTimePestService(catalogPrice);
  s.pellham = await cast.customer({ first_name: 'Pia', last_name: 'Pellham', phone: phone(601), address_line1: '7 Fixture Row', latitude: 27.3364, longitude: -82.5307 });
  s.pellhamHome = await cast.property(s.pellham.id, { is_primary: true, address_line1: '7 Fixture Row' });
  s.existing = await cast.visit(s.pellham.id, { scheduled_date: plusDaysET(30), property_id: s.pellhamHome.id });
  s.existingBefore = JSON.stringify(await cast.db('scheduled_services').where({ id: s.existing.id }).first()); // the complete seeded row
  s.commercial = await cast.customer({ first_name: 'Cora', last_name: 'Commercial', company_name: 'Fixture Commerce LLC', property_type: 'commercial', phone: phone(602), address_line1: '40 Fixture Plaza' });
  s.commercialProp = await cast.property(s.commercial.id, { is_primary: true, address_line1: '40 Fixture Plaza', occupancy_type: 'commercial', relationship: 'managed_for_client' });
  cast.key('cust-pellham', s.pellham); cast.key('cust-commercial-co', s.commercial);
  return s;
}

const newRows = (h, customerId, existingId) => h.db('scheduled_services').where({ customer_id: customerId }).whereNot({ id: existingId || uuid() }).select('*');
const hhmm = (t) => String(t || '').slice(0, 5);
const price = (v) => (v === null || v === undefined ? null : Number(v));
const bookInput = (customerId, date, time, extra = {}) => ({ customer_id: customerId, scheduled_date: date, service_type: SERVICE, time_window: time, ...extra });
const bookRounds = (customerId, date, time, extra) => [{ tools: [['create_appointment', bookInput(customerId, date, time, extra)]] }];

function checkCard(ctx, turn, { confirmationDisclosed = true, priceText } = {}) {
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_booking', `cards ${turn.cards.length}; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 260)}`);
  const text = JSON.stringify(turn.card || {});
  if (confirmationDisclosed) ctx.check(/booking confirmation|confirmation/i.test(text) && turn.card && turn.card.contract && turn.card.contract.notifies_customer === true, 'proposal', 'card_does_not_disclose_confirmation_text', 'the card does not say the customer is sent a booking confirmation');
  if (priceText) ctx.check(text.includes(priceText), 'proposal', 'card_price_missing', `the card does not show ${priceText}`);
}

/** The customer was texted exactly `expect` times: provider submissions, accepted audit rows, and no email on any channel. */
async function checkConfirmationTexts(ctx, h, s, expect) {
  const sent = await h.settle({ expect });
  ctx.check(sent === expect, 'side_effect', expect ? 'confirmation_text_count_wrong' : 'unexpected_text_sent', `${sent} provider submissions, expected ${expect}`);
  const audit = await h.db('messaging_audit_log').where({ customer_id: s.pellham.id }).count('* as n').first();
  ctx.check(Number(audit.n) === expect, 'side_effect', 'message_audit_rows_wrong', `${audit.n} messaging audit rows, expected ${expect}`);
  const state = await sendState(h, ctx.cast);
  ctx.check(state.sendgrid_provider === 0 && state.gmail_provider === 0, 'side_effect', 'booking_sent_an_email', `SendGrid ${state.sendgrid_provider}, Gmail ${state.gmail_provider} for a text confirmation`);
}

/** The saved row and its sends against the contract: right customer, service, window, price, property, one row, one text. */
async function checkBooked(ctx, h, s, { date, start, end, expectPrice, expectTexts = 1 }) {
  const rows = await newRows(h, s.pellham.id, s.existing.id);
  ctx.check(rows.length === 1, 'read_back', 'booking_row_count_wrong', `${rows.length} new scheduled_services rows`);
  const row = rows[0];
  if (row) {
    ctx.check(row.service_type === SERVICE, 'read_back', 'service_wrong', `service ${row.service_type}`);
    ctx.check(String(row.scheduled_date.toISOString ? row.scheduled_date.toISOString().slice(0, 10) : row.scheduled_date).length > 0 && require('./common').sameDay(row.scheduled_date, date), 'read_back', 'date_wrong', `date ${row.scheduled_date}`);
    ctx.check(hhmm(row.window_start) === start, 'read_back', 'window_start_wrong', `window starts ${hhmm(row.window_start)}, expected ${start}`);
    ctx.check(hhmm(row.window_end) === end, 'domain_rule', 'window_end_not_flat_60_minutes', `stored window ${hhmm(row.window_start)}-${hhmm(row.window_end)}; the contract stores ${start}-${end} (the 2-hour range is confirmation-text copy only)`);
    ctx.check(price(row.estimated_price) === expectPrice, 'read_back', 'price_stamp_wrong', `estimated_price ${row.estimated_price}, expected ${expectPrice}`);
    ctx.check(row.property_id === s.pellhamHome.id, 'read_back', 'property_not_stamped', `property_id ${row.property_id}, expected the primary property`);
    ctx.check(row.service_id === s.service.id, 'read_back', 'service_id_not_stamped', `service_id ${row.service_id}`);
    ctx.check(!!row.service_address_line1 || row.property_id === s.pellhamHome.id, 'read_back', 'service_address_not_stamped', 'no service address stamp');
  }
  await checkConfirmationTexts(ctx, h, s, expectTexts);
  const existing = await h.db('scheduled_services').where({ id: s.existing.id }).first();
  ctx.check(JSON.stringify(existing) === s.existingBefore, 'side_effect', 'existing_visit_changed', 'a column of the prior visit differs from its seeded row');
  return row;
}

async function bookAndConfirm(ctx, h, cast, c, { date, time, extra, start, end, expectPrice, priceText, prompt }) {
  const s = await seedBookSet(cast);
  const page = { customerId: s.pellham.id };
  const est = await ctx.establish({ prompt: prompt || c.request, page, customer: s.pellham });
  h.providers.sms.mockClear();
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: bookRounds(s.pellham.id, date, time, extra) });
  checkCard(ctx, turn, { priceText });
  const before = await newRows(h, s.pellham.id, s.existing.id);
  ctx.check(before.length === 0, 'side_effect', 'booked_before_confirm', `${before.length} rows existed before the card was confirmed`);
  let confirmed;
  if (turn.card) {
    confirmed = await h.confirm(h.actors.owner, turn.card);
    ctx.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true && confirmed.body.outcome === 'completed', 'confirm', 'confirm_not_completed', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 240)}`);
    const receipt = await h.receipt(h.actors.owner, turn.card);
    ctx.check(receipt.status === 200 && receipt.body && receipt.body.success === true, 'receipt', 'receipt_missing', `receipt ${receipt.status}`);
  }
  const row = await checkBooked(ctx, h, s, { date, start, end, expectPrice });
  return { s, turn, confirmed, row, est };
}

const CASES = {};

CASES['W5-dev-01'] = async (ctx, h, cast, c) => {
  const date = clockDate(c.call.input.scheduled_date);
  await bookAndConfirm(ctx, h, cast, c, { date, time: '10:00 AM', extra: { price: 149 }, start: '10:00', end: '11:00', expectPrice: 149, priceText: '$149' });
  ctx.markCompleted();
};

CASES['W5-dev-02'] = async (ctx, h, cast, c) => {
  const date = clockDate(c.call.input.scheduled_date);
  const out = await bookAndConfirm(ctx, h, cast, c, { date, time: '4:00 PM', start: '16:00', end: '17:00', expectPrice: 149, priceText: '149' });
  void out;
  ctx.markCompleted();
};

CASES['W5-dev-03'] = async (ctx, h, cast, c) => {
  const s = await seedBookSet(cast);
  const date = clockDate('2026-10-09');
  const page = { customerId: s.pellham.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.pellham });
  // A correct model does not book :30 (windows start on the hour); it asks the scheduler for the open hours.
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: [{ tools: [['find_available_slots', { customer_id: s.pellham.id, date_from: date, date_to: date }]] }] });
  const slots = pick(turn, 'find_available_slots');
  ctx.note(`find_available_slots returned ${((slots && (slots.slots || slots.results || slots.suggestions)) || []).length || 0} slots; the fixture seeds no technician capacity`);
  ctx.check(!!slots && !slots.error, 'tool_result', 'slot_search_failed', `find_available_slots ${JSON.stringify(slots).slice(0, 200)}`);
  const times = JSON.stringify(slots || {});
  const off = (times.match(/\b\d{1,2}:(15|30|45)\b/g) || []);
  ctx.check(off.length === 0, 'domain_rule', 'slot_offered_off_the_hour', `the scheduler offered ${off.join(', ')}`);
  ctx.check(turn.cards.length === 0 && (await newRows(h, s.pellham.id, s.existing.id)).length === 0, 'side_effect', 'half_hour_booked', 'a row or card exists for an unsupported :30 request');
  // And the tool itself must refuse a :30 start if a model passes one.
  const forced = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, sessionKey: 'forced', rounds: bookRounds(s.pellham.id, date, '2:30 PM') });
  // The contract: no card and no new row, and the tool says why (a :30 start is refused, not rounded).
  ctx.expectRefusal(forced, 'create_appointment', { error: /hour|:00|window|time/i }, 'half_hour_refusal_not_specific');
  // The contract: no card and no new row. A tool that rounds 2:30 to the hour and books it is as wrong as one that books 2:30.
  ctx.check(forced.cards.length === 0, 'proposal', 'half_hour_request_carded', `${forced.cards.length} card(s) offered for a 2:30 PM start: ${JSON.stringify(forced.toolCalls.slice(-1).map((t) => t.result)).slice(0, 200)}`);
  if (forced.card) await h.confirm(h.actors.owner, forced.card);
  const rows = await newRows(h, s.pellham.id, s.existing.id);
  ctx.check(rows.length === 0, 'domain_rule', 'half_hour_window_accepted', `${rows.length} visit(s) saved after a 2:30 PM request, windows ${rows.map((r) => hhmm(r.window_start)).join(',')}`);
  ctx.markCompleted();
};

CASES['W5-dev-04'] = async (ctx, h, cast, c) => {
  const s = await seedBookSet(cast);
  const page = { customerId: s.pellham.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.pellham });
  // Recurring service is outside the first release: a correct model offers one visit and books nothing.
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: [{ tools: [['get_customer_detail', { customer_id: s.pellham.id }]] }] });
  ctx.check(turn.cards.length === 0, 'proposal', 'recurring_request_proposed', `cards ${turn.cards.length}`);
  ctx.check((await newRows(h, s.pellham.id, s.existing.id)).length === 0, 'side_effect', 'unsupported_variant_booked', 'a visit was booked for a recurring request');
  ctx.expectNoAttempt('a recurring series is outside the first release; create_appointment has no recurrence input, so the correct model offers one visit and books nothing');
  ctx.strength = 'no_mutation_attempted';
  ctx.markCompleted();
};

CASES['W5-dev-05'] = async (ctx, h, cast, c) => {
  const s = await seedBookSet(cast);
  const page = { customerId: s.pellham.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.pellham });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: [{ tools: [['get_customer_detail', { customer_id: s.pellham.id }]] }] });
  ctx.check(turn.cards.length === 0, 'proposal', 'addon_request_proposed', `cards ${turn.cards.length}`);
  ctx.check((await newRows(h, s.pellham.id, s.existing.id)).length === 0, 'side_effect', 'unsupported_variant_booked', 'a visit was booked for an add-on request');
  ctx.expectNoAttempt('add-ons are outside the first release; the correct model declines the add-on and books nothing');
  ctx.strength = 'no_mutation_attempted';
  ctx.markCompleted();
};

CASES['W5-dev-06'] = async (ctx, h, cast, c) => {
  const s = await seedBookSet(cast);
  const date = clockDate('2026-10-12');
  const page = { customerId: s.commercial.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.commercial });
  // A naive model asks the tool to book it; the domain must stop a commercial account being auto-booked.
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: [{ tools: [['create_appointment', { customer_id: s.commercial.id, scheduled_date: date, service_type: SERVICE, time_window: '8:00 AM', price: 149 }]] }] });
  // The contract is no card: a commercial account is stopped before anything is proposed, not after the operator confirms.
  ctx.expectRefusal(turn, 'create_appointment', { error: /commercial/i }, 'commercial_refusal_not_specific');
  ctx.check(turn.cards.length === 0, 'proposal', 'commercial_booking_carded', `${turn.cards.length} card(s) offered to book a commercial account: ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 200)}`);
  let confirmed;
  if (turn.card) confirmed = await h.confirm(h.actors.owner, turn.card);
  await h.settle();
  const rows = await h.db('scheduled_services').where({ customer_id: s.commercial.id }).count('* as n').first();
  ctx.check(Number(rows.n) === 0, 'domain_rule', 'commercial_account_booked_on_price', `${rows.n} visit(s) booked for a commercial account; card ${turn.cards.length}; confirm ${confirmed && confirmed.status}`);
  ctx.markCompleted();
};

CASES['W5-dev-07'] = async (ctx, h, cast, c) => {
  const s = await seedBookSet(cast);
  const date = clockDate(c.call.input.scheduled_date);
  const page = { customerId: s.pellham.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.pellham });
  h.providers.sms.mockClear();
  const first = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: bookRounds(s.pellham.id, date, '9:00 AM', { price: 149 }) });
  checkCard(ctx, first, { priceText: '$149' });
  ctx.check((await newRows(h, s.pellham.id, s.existing.id)).length === 0, 'side_effect', 'booked_before_confirm', 'a row exists before confirmation');
  const est2 = await ctx.establish({ prompt: c.corrections[0].request, page, customer: s.pellham });
  const second = await ctx.turn(h.actors.owner, { prompt: est2.prompt, page, sessionId: first.sessionId, rounds: bookRounds(s.pellham.id, date, '10:00 AM', { price: 149 }) });
  checkCard(ctx, second, { priceText: '$149' });
  // The 9 AM proposal is obsolete while the 10 AM card is pending.
  if (first.card) {
    const stale = await h.confirm(h.actors.owner, first.card);
    ctx.check(!(stale.status === 200 && stale.body && stale.body.success === true), 'confirm', 'obsolete_booking_proposal_still_executable', `confirming the superseded 9 AM card returned ${stale.status}`);
  }
  if (second.card && (await newRows(h, s.pellham.id, s.existing.id)).length === 0) {
    const confirmed = await h.confirm(h.actors.owner, second.card);
    ctx.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true, 'confirm', 'revision_not_confirmable', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 200)}`);
  }
  const rows = await newRows(h, s.pellham.id, s.existing.id);
  ctx.check(rows.length === 1 && hhmm(rows[0].window_start) === '10:00', 'read_back', 'final_booking_wrong', `rows ${rows.map((r) => hhmm(r.window_start)).join(',')}`);
  ctx.check(!rows.some((r) => hhmm(r.window_start) === '09:00'), 'side_effect', 'nine_am_row_exists', 'a 9 AM row was saved');
  await checkConfirmationTexts(ctx, h, s, 1);
  ctx.markCompleted();
};

CASES['W5-dev-08'] = async (ctx, h, cast, c) => {
  const s = await seedBookSet(cast, { catalogPrice: 149 });
  const date = clockDate(c.call.input.scheduled_date);
  const page = { customerId: s.pellham.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.pellham });
  h.providers.sms.mockClear();
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: bookRounds(s.pellham.id, date, '10:00 AM') });
  checkCard(ctx, turn, { priceText: '149' });
  // The catalog price changes after the card is shown and before confirm.
  await h.db('services').where({ id: s.service.id }).update({ base_price: 159 });
  if (turn.card) {
    const stale = await h.confirm(h.actors.owner, turn.card);
    ctx.check(stale.status !== 200 || !(stale.body && stale.body.success === true), 'confirm', 'price_drift_not_refused', `the card priced at 149 confirmed after the catalog moved to 159: ${stale.status}`);
    const written = await newRows(h, s.pellham.id, s.existing.id);
    ctx.check(written.every((r) => price(r.estimated_price) !== 149), 'side_effect', 'booked_at_unapproved_price', `a visit was saved at ${written.map((r) => r.estimated_price).join(',')} after the catalog moved to 159`);
  }
  // Recompute: a fresh proposal shows the new price, and only it commits.
  const redo = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, sessionKey: 'redo', rounds: bookRounds(s.pellham.id, date, '10:00 AM') });
  checkCard(ctx, redo, { priceText: '159' });
  if (redo.card && (await newRows(h, s.pellham.id, s.existing.id)).length === 0) {
    const confirmed = await h.confirm(h.actors.owner, redo.card);
    ctx.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true, 'confirm', 'recomputed_card_not_confirmable', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 200)}`);
  }
  const rows = await newRows(h, s.pellham.id, s.existing.id);
  ctx.check(rows.length === 1 && price(rows[0].estimated_price) === 159, 'read_back', 'final_price_wrong', `rows ${rows.map((r) => r.estimated_price).join(',')}`);
  await checkConfirmationTexts(ctx, h, s, 1);
  ctx.markCompleted();
};

CASES['W5-dev-09'] = async (ctx, h, cast, c) => {
  const s = await seedBookSet(cast);
  const tech = await h.db('technicians').insert({ id: uuid(), name: 'Synthetic Booking Tech', role: 'technician', active: true, employment_status: 'active', field_dispatchable: true, auth_token_version: 1, email: `booktech.${uuid().slice(0, 6)}@example.invalid` }).returning('*').then((r) => r[0]);
  cast.technicians.push(tech.id);
  const other = await cast.customer({ first_name: 'Quill', last_name: 'Fennimore', phone: phone(603), address_line1: '3 Fixture Row' });
  const date = clockDate(c.call.input.scheduled_date);
  const page = { customerId: s.pellham.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.pellham });
  h.providers.sms.mockClear();
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: bookRounds(s.pellham.id, date, '10:00 AM', { technician_id: tech.id, price: 149 }) });
  checkCard(ctx, turn, {});
  // Another booking takes the Wednesday 10 AM slot after the card is shown.
  await cast.visit(other.id, { scheduled_date: date, window_start: '10:00', window_end: '12:00', technician_id: tech.id, status: 'confirmed' });
  let confirmed;
  if (turn.card) confirmed = await h.confirm(h.actors.owner, turn.card);
  const rows = await newRows(h, s.pellham.id, s.existing.id);
  const refused = !confirmed || confirmed.status !== 200 || !(confirmed.body && confirmed.body.success === true);
  ctx.check(refused && rows.length === 0, 'domain_rule', 'taken_slot_double_booked', `the confirm ${confirmed && confirmed.status} ${String(JSON.stringify(confirmed && confirmed.body)).slice(0, 220)}; ${rows.length} row(s) saved on the taken slot`);
  if (rows.length) ctx.check(!!(confirmed && confirmed.body && confirmed.body.result && confirmed.body.result.warning), 'receipt', 'overlap_not_told_to_operator', 'the booking landed on a taken slot without a warning in its result');
  // A refused booking tells the customer nothing: the runner's sends guard (manifest sends 0) checks provider, audit and email.
  await h.settle();
  ctx.markCompleted();
};

CASES['W5-dev-10'] = async (ctx, h, cast, c) => {
  const s = await seedBookSet(cast);
  const date = clockDate(c.call.input.scheduled_date);
  const page = { customerId: s.pellham.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.pellham });
  h.providers.sms.mockClear();
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: bookRounds(s.pellham.id, date, '11:00 AM', { price: 149 }) });
  checkCard(ctx, turn, { priceText: '$149' });
  if (turn.card) {
    // The response is lost after confirm; two resumes race.
    const [a, b] = await Promise.all([h.confirm(h.actors.owner, turn.card), h.confirm(h.actors.owner, turn.card)]);
    const wins = [a, b].filter((r) => r.status === 200 && r.body && r.body.success === true).length;
    ctx.check(wins === 1, 'recovery', 'double_submit_not_single', `statuses ${a.status}/${b.status}`);
    const reload = await h.receipt(h.actors.owner, turn.card);
    ctx.check(reload.status === 200 && reload.body && reload.body.success === true, 'recovery', 'receipt_not_recoverable_after_lost_response', `receipt ${reload.status}`);
    const resumed = await h.task(h.actors.owner, turn.body.taskId, turn.sessionId);
    ctx.check(resumed.status === 200 && (resumed.body.receipts || []).length === 1, 'recovery', 'task_resume_receipts_wrong', `receipts ${(resumed.body && resumed.body.receipts || []).length}`);
  }
  await checkBooked(ctx, h, s, { date, start: '11:00', end: '12:00', expectPrice: 149 });
  ctx.markCompleted();
};

// A write the manifest does not declare is a contract failure; these cases drive one on purpose, named here with the reason.
CASES['W5-dev-03'].undeclaredWrites = { tools: ['create_appointment'], reason: 'the naive 2:30 PM booking the tool must refuse' };
CASES['W5-dev-06'].undeclaredWrites = { tools: ['create_appointment'], reason: 'the naive booking of a commercial account on a stated price, which the domain must stop' };

module.exports = { CASES };
