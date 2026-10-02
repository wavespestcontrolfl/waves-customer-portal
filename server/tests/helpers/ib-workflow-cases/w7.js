'use strict';

// W7 Draft, revise, send a customer SMS. draft_sms is a read; send_sms is a carded write that goes through the
// real consent / suppression middleware to a STUBBED provider (no text ever reaches a real number). The stub
// records every submission, so "one send" and "which number" are read from it and from the sms_log reservation.

const { phone, uuid } = require('../ib-workflow-fixtures');
const { pick, noSends, sendState, OPT_OUT_PATTERN } = require('./common');

async function seedSmsSet(cast) {
  const s = {};
  s.pellham = await cast.customer({ first_name: 'Pia', last_name: 'Pellham', phone: phone(101), secondary_phone: phone(102), secondary_contact_name: 'Pia household member', address_line1: '7 Fixture Row' });
  s.fennimore = await cast.customer({ first_name: 'Quill', last_name: 'Fennimore', phone: phone(301), address_line1: '3 Fixture Row' });
  s.ostrander = await cast.customer({ first_name: 'Rune', last_name: 'Ostrander', phone: phone(401), address_line1: '5 Fixture Row' });
  await cast.optOut(s.ostrander.id);
  s.murphyA = await cast.customer({ first_name: 'Ada', last_name: 'Murphy', phone: phone(111), address_line1: '11 Fixture Row' });
  s.murphyB = await cast.customer({ first_name: 'Bram', last_name: 'Murphy', phone: phone(222), address_line1: '15 Fixture Row' });
  cast.key('cust-pellham', s.pellham); cast.key('cust-fennimore', s.fennimore);
  return s;
}

const stub = (h) => h.providers.sms;
const submissions = (h) => stub(h).mock.calls.map((c) => c[0]);
const digits = (v) => String(v || '').replace(/\D/g, '');
// The messaging audit row the send middleware writes for every accepted or blocked attempt (the stubbed provider writes no sms_log row).
const reservations = (h, customerId) => h.db('messaging_audit_log').where({ customer_id: customerId }).whereNull('blocked_code').select('id', 'to_last4', 'body_preview', 'provider_message_id');

const draftRounds = (customerId, message) => [{ tools: [['draft_sms', { customer_id: customerId, message, purpose: 'custom' }]] }];
const sendRounds = (customerId, message, extra = {}) => [{ tools: [['send_sms', { customer_id: customerId, message, message_type: 'manual', ...extra }]] }];

/** The send step: card, confirm, then the stub, the reservation and the receipt against what was approved. */
async function sendApproved(ctx, h, s, customer, message, { to, prompt, sessionId, page, extra, expectedCount = 1 } = {}) {
  stub(h).mockClear();
  const preTurn = await sendState(h, ctx.cast); // rows and stubs as they are now: an earlier approved send in the same case is not "before confirm"
  const est = await ctx.establish({ prompt, page: page || { customerId: customer.id }, customer });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, sessionId, rounds: sendRounds(customer.id, message, extra) });
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_send', `cards ${turn.cards.length}; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 240)}`);
  await noSends(ctx, h, ctx.cast, { what: 'a proposal before its card is confirmed', since: preTurn, codes: { sms: 'sent_before_confirm', smsRows: 'send_row_before_confirm' } });
  let confirmed;
  if (turn.card) {
    confirmed = await h.confirm(h.actors.owner, turn.card);
    ctx.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true && ['completed', 'provider_accepted'].includes(confirmed.body.outcome), 'confirm', 'send_confirm_not_completed', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 240)}`);
    const receipt = await h.receipt(h.actors.owner, turn.card);
    const state = receipt.body && receipt.body.result && receipt.body.result.state;
    ctx.check(receipt.status === 200 && receipt.body && receipt.body.success === true, 'receipt', 'receipt_missing', `receipt ${receipt.status}`);
    ctx.check(state === 'provider_accepted' && !/delivered/i.test(JSON.stringify(receipt.body.result || {})), 'receipt', 'receipt_status_claims_delivery', `receipt state ${state}`);
    ctx.check(!!(receipt.body && receipt.body.result && receipt.body.result.providerMessageId), 'receipt', 'receipt_without_provider_sid', 'the receipt carries no provider message id');
  }
  const sent = submissions(h);
  ctx.check(sent.length === expectedCount, 'side_effect', 'send_count_wrong', `${sent.length} provider submissions, expected ${expectedCount}`);
  const call = sent[0];
  if (call) {
    ctx.check(call.body === message, 'read_back', 'sent_text_differs_from_approved_draft', `sent ${JSON.stringify(call.body)}`);
    ctx.check(digits(call.to).endsWith(digits(to || customer.phone).slice(-10)), 'read_back', 'sent_to_wrong_number', `sent to ...${digits(call.to).slice(-4)}, expected ...${digits(to || customer.phone).slice(-4)}`);
  }
  const rows = await reservations(h, customer.id);
  ctx.check(rows.length === expectedCount, 'receipt', 'message_audit_rows_wrong', `${rows.length} messaging audit rows, expected ${expectedCount}`);
  return { turn, confirmed };
}

const CASES = {};

CASES['W7-dev-01'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  const draftText = 'We will be there Tuesday between 9 and 11.';
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.pellham.id }, customer: s.pellham });
  stub(h).mockClear();
  const draft = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: draftRounds(s.pellham.id, draftText) });
  const result = pick(draft, 'draft_sms');
  ctx.check(!!result && !result.error, 'tool_result', 'draft_failed', JSON.stringify(result).slice(0, 200));
  ctx.check(draft.cards.length === 0, 'side_effect', 'sent_with_the_draft', 'a card accompanied the draft');
  await noSends(ctx, h, cast, { what: 'a draft', codes: { sms: 'sent_with_the_draft', smsRows: 'send_row_with_the_draft' } });
  await sendApproved(ctx, h, s, s.pellham, draftText, { prompt: c.corrections[0].request, sessionId: draft.sessionId });
  ctx.markCompleted();
};

CASES['W7-dev-02'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  const drafts = ['We are running late.', 'Running late.', 'Running a little late, we will be there between 9 and 11.'];
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.pellham.id }, customer: s.pellham });
  stub(h).mockClear();
  let sessionId;
  for (let i = 0; i < 3; i += 1) {
    const prompt = i === 0 ? est.prompt : (await ctx.establish({ prompt: c.corrections[i - 1].request, page: est.page, customer: s.pellham })).prompt;
    const turn = await ctx.turn(h.actors.owner, { prompt, page: est.page, sessionId, rounds: draftRounds(s.pellham.id, drafts[i]) });
    sessionId = turn.sessionId;
    ctx.check(turn.cards.length === 0, 'side_effect', 'sent_with_a_draft', `draft ${i + 1} produced a card`);
    await noSends(ctx, h, cast, { what: `draft ${i + 1}`, settle: i === 2, codes: { sms: 'sent_with_a_draft', smsRows: 'send_row_with_a_draft' } });
  }
  await sendApproved(ctx, h, s, s.pellham, drafts[2], { prompt: 'Send it.', sessionId });
  ctx.check(!submissions(h).some((x) => x.body === drafts[0] || x.body === drafts[1]), 'side_effect', 'superseded_draft_sent', 'an earlier draft was sent');
  ctx.markCompleted();
};

CASES['W7-dev-03'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  const message = 'We will be there Tuesday at 9.';
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.pellham.id }, customer: s.pellham });
  stub(h).mockClear();
  // The card for the primary number comes first; the operator then asks for the household member's number.
  const first = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: sendRounds(s.pellham.id, message) });
  const second = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, sessionId: first.sessionId, sessionKey: 'second', rounds: sendRounds(s.pellham.id, message, { phone: s.pellham.secondary_phone }) });
  ctx.check(second.cards.length === 1, 'proposal', 'no_card_for_secondary_number', `cards ${second.cards.length}; ${JSON.stringify(second.toolCalls.slice(-1).map((t) => t.result)).slice(0, 240)}`);
  const cardText = JSON.stringify(second.card || {});
  ctx.check(cardText.includes('0102'), 'proposal', 'card_does_not_name_the_number', 'the card does not show the number ending 0102');
  if (first.card && second.card) {
    const stale = await h.confirm(h.actors.owner, first.card);
    ctx.check(!(stale.status === 200 && stale.body && stale.body.success === true), 'confirm', 'superseded_send_card_still_executable', `confirming the primary-number card after the recipient changed returned ${stale.status}`);
  }
  const wrong = submissions(h).filter((x) => digits(x.to).endsWith('0101'));
  ctx.check(wrong.length === 0, 'side_effect', 'text_sent_to_the_wrong_number', `${wrong.length} submissions to the primary number`);
  stub(h).mockClear();
  if (second.card) {
    const confirmed = await h.confirm(h.actors.owner, second.card);
    ctx.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true, 'confirm', 'send_confirm_not_completed', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 240)}`);
  }
  const sent = submissions(h);
  ctx.check(sent.length === 1 && digits(sent[0].to).endsWith('0102'), 'read_back', 'sent_to_wrong_number', `${sent.length} submissions; to ...${sent[0] ? digits(sent[0].to).slice(-4) : 'none'}`);
  ctx.markCompleted();
};

CASES['W7-dev-04'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  const owner = h.actors.owner;
  const queued = uuid();
  await h.db('sms_log').insert({ id: queued, customer_id: s.fennimore.id, direction: 'outbound', from_phone: '+19413335555', to_phone: s.fennimore.phone, message_body: 'Staff-scheduled text for later.', status: 'scheduled', message_type: 'manual', admin_user_id: owner.id, scheduled_for: new Date(Date.now() + 6 * 3600000), metadata: JSON.stringify({}) });
  cast.key('fennimore-staff-scheduled', { id: queued });
  stub(h).mockClear();
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.fennimore.id }, customer: s.fennimore });
  const turn = await ctx.turn(owner, { prompt: est.prompt, page: est.page, rounds: [{ tools: [['list_queued_messages', { customer_id: s.fennimore.id }]] }, (prev) => ({ tools: [['cancel_queued_message', { message_id: ((prev[0].result.messages || [])[0] || {}).message_id || queued, customer_id: s.fennimore.id, channel: 'sms' }]] })] });
  const listing = pick(turn, 'list_queued_messages');
  ctx.note(`queued listing ${JSON.stringify(listing).slice(0, 160)}; cancel ${JSON.stringify(pick(turn, 'cancel_queued_message')).slice(0, 160)}`);
  ctx.check(!!listing && (listing.messages || []).some((m) => m.message_id === queued), 'tool_result', 'queued_text_not_listed', `listing ${JSON.stringify(listing).slice(0, 220)}`);
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_cancel', `cards ${turn.cards.length}`);
  if (turn.card) {
    const confirmed = await h.confirm(owner, turn.card);
    ctx.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true, 'confirm', 'cancel_confirm_failed', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 220)}`);
  }
  const row = await h.db('sms_log').where({ id: queued }).first('status');
  ctx.check(!row || /cancel/i.test(String(row.status)), 'read_back', 'queued_text_not_canceled', `status ${row && row.status}`);
  await h.settle(); // the runner's sends guard (manifest sends 0) covers every channel
  ctx.markCompleted();
};

CASES['W7-dev-05'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  const message = 'We will be there Tuesday at 9.';
  stub(h).mockClear();
  // The provider accepts the text, then the call times out before a status returns.
  stub(h).mockImplementationOnce(async () => ({ sent: false, provider: 'twilio', deliveryOutcome: 'uncertain', error: 'timeout', retryable: true, providerAlerted: true }));
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.pellham.id }, customer: s.pellham });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: sendRounds(s.pellham.id, message) });
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_send', `cards ${turn.cards.length}`);
  if (turn.card) {
    const confirmed = await h.confirm(h.actors.owner, turn.card);
    ctx.check(confirmed.body && confirmed.body.outcome === 'outcome_unknown' && confirmed.body.success === false, 'receipt', 'unknown_outcome_not_recorded', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 240)}`);
    const receipt = await h.receipt(h.actors.owner, turn.card);
    ctx.check(receipt.body && receipt.body.outcome === 'outcome_unknown' && receipt.body.retryAllowed === false, 'receipt', 'unknown_outcome_retry_allowed', `receipt ${JSON.stringify(receipt.body).slice(0, 200)}`);
    const replay = await h.confirm(h.actors.owner, turn.card);
    ctx.check(replay.status === 409, 'recovery', 'replay_not_refused', `replay returned ${replay.status}`);
  }
  // A fresh send of the same text before the outcome is reconciled.
  const before = submissions(h).length;
  const reservedBefore = (await reservations(h, s.pellham.id)).length;
  const again = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, sessionKey: 'again', rounds: sendRounds(s.pellham.id, message) });
  if (again.card) await h.confirm(h.actors.owner, again.card);
  ctx.check(submissions(h).length === before && (await reservations(h, s.pellham.id)).length === reservedBefore, 'recovery', 'resend_before_reconciliation', `${submissions(h).length - before} further provider submissions and ${(await reservations(h, s.pellham.id)).length - reservedBefore} further accepted audit rows while the first outcome was unknown`);
  ctx.markCompleted();
};

CASES['W7-dev-06'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  stub(h).mockClear();
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.ostrander.id }, customer: s.ostrander });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: sendRounds(s.ostrander.id, 'We are running late.') });
  let confirmed;
  if (turn.card) {
    ctx.check(false, 'proposal', 'card_shown_for_a_send_that_will_be_blocked', 'a send card was offered for a number with STOP on file');
    confirmed = await h.confirm(h.actors.owner, turn.card);
  }
  await h.settle(); // the runner's sends guard (manifest sends 0) covers every channel
  ctx.check(!(confirmed && confirmed.body && confirmed.body.success === true), 'domain_rule', 'opt_out_not_honored', `confirm ${confirmed && JSON.stringify(confirmed.body).slice(0, 200)}`);
  // With no card the refusal has to be the send tool's own opt-out answer; absence of a card alone is not evidence of the opt-out.
  if (!turn.card) ctx.expectRefusal(turn, 'send_sms', { error: OPT_OUT_PATTERN }, 'opt_out_refusal_not_reported');
  if (confirmed) ctx.expectConfirmRefusal(confirmed, 'blocked_reason_not_reported');
  ctx.markCompleted();
};

CASES['W7-dev-07'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  stub(h).mockClear();
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.fennimore.id }, customer: s.fennimore });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: draftRounds(s.fennimore.id, 'We need to move your visit. What day works for you?') });
  const draft = pick(turn, 'draft_sms');
  ctx.check(!!draft && !draft.error && (draft.message || draft.draft || draft.body || JSON.stringify(draft).includes('move your visit')), 'tool_result', 'draft_missing', JSON.stringify(draft).slice(0, 200));
  ctx.check(turn.cards.length === 0, 'side_effect', 'draft_produced_a_send', 'a card accompanied the draft');
  await h.settle(); // the runner's sends guard (manifest sends 0) covers every channel
  ctx.markCompleted();
};

CASES['W7-dev-08'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  // Customer texts are never signed: a correct model drafts without the sign-off and says so.
  await sendApproved(ctx, h, s, s.pellham, 'We are on our way.', { prompt: c.request });
  ctx.markCompleted();
};

CASES['W7-dev-09'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  stub(h).mockClear();
  // A correct model looks the name up, sees two accounts and asks. A naive send_sms by surname must not become a card.
  const turn = await ctx.turn(h.actors.owner, { prompt: c.request, rounds: [{ tools: [['query_customers', { search: 'Murphy' }]] }, { tools: [['send_sms', { customer_name: 'Murphy', message: 'We will be there Tuesday at 9.' }]] }] });
  // Only this case's own customers: the isolated database may hold other people named Murphy.
  const found = ((pick(turn, 'query_customers') || {}).customers || []).map((x) => x.id).filter((id) => cast.customers.includes(id)).sort();
  ctx.check(JSON.stringify(found) === JSON.stringify([s.murphyA.id, s.murphyB.id].sort()), 'tool_result', 'murphy_lookup_wrong', `lookup returned ${found.length} accounts`);
  ctx.expectRefusal(turn, 'send_sms', { error: /Multiple customers match/i }, 'ambiguous_recipient_not_reported');
  ctx.check(turn.cards.length === 0, 'target_resolution', 'ambiguous_recipient_proposed', `a send card was offered for the surname Murphy (${turn.cards.length})`);
  if (turn.card) await h.confirm(h.actors.owner, turn.card);
  await h.settle(); // the runner's sends guard (manifest sends 0) covers every channel
  ctx.markCompleted();
};

CASES['W7-dev-10'] = async (ctx, h, cast, c) => {
  const s = await seedSmsSet(cast);
  const message = 'We will be there Tuesday between 9 and 11.';
  stub(h).mockClear();
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.pellham.id }, customer: s.pellham });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: sendRounds(s.pellham.id, message) });
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_send', `cards ${turn.cards.length}`);
  if (turn.card) {
    // The response is lost after the send; two confirms race and the panel reloads.
    const [a, b] = await Promise.all([h.confirm(h.actors.owner, turn.card), h.confirm(h.actors.owner, turn.card)]);
    const wins = [a, b].filter((r) => r.status === 200 && r.body && r.body.success === true).length;
    ctx.check(wins === 1, 'recovery', 'double_submit_not_single', `statuses ${a.status}/${b.status}`);
    const reload = await h.receipt(h.actors.owner, turn.card);
    ctx.check(reload.status === 200 && reload.body && reload.body.success === true, 'recovery', 'receipt_not_recoverable_after_lost_response', `receipt ${reload.status}`);
    const resumed = await h.task(h.actors.owner, turn.body.taskId, turn.sessionId);
    ctx.check(resumed.status === 200 && (resumed.body.receipts || []).length === 1, 'recovery', 'task_resume_receipts_wrong', `receipts ${(resumed.body && resumed.body.receipts || []).length}`);
  }
  ctx.check(submissions(h).length === 1, 'side_effect', 'duplicate_send', `${submissions(h).length} provider submissions across the double confirm`);
  ctx.check((await reservations(h, s.pellham.id)).length === 1, 'receipt', 'message_audit_rows_wrong', 'more than one messaging audit row for one approved send');
  ctx.markCompleted();
};

// A write the manifest does not declare is a contract failure; these cases drive one on purpose, named here with the reason.
CASES['W7-dev-06'].undeclaredWrites = { tools: ['send_sms'], reason: 'the send to a number with STOP on file, which must be blocked' };
CASES['W7-dev-09'].undeclaredWrites = { tools: ['send_sms'], reason: 'the naive send by the shared surname, which must be refused as ambiguous' };

module.exports = { CASES };
