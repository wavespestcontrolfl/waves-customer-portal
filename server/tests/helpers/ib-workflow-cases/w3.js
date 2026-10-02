'use strict';

// W3 Lead first name and customer contact details. update_lead_contact edits the lead row, update_customer the
// account. Owner-direct mode (#5563) commits a lead edit or a contact-field edit without a card; an email or a
// pipeline-stage change, and every edit with the gate off, takes its card. ctx.commit follows the manifest's card flag.

const { phone, uuid } = require('../ib-workflow-fixtures');

async function seedMurphyLeads(cast) {
  const s = {};
  s.l1 = await cast.lead({ first_name: 'Gwen', last_name: 'Murphy', phone: phone(141) });
  s.l2 = await cast.lead({ first_name: 'Hal', last_name: 'Murphy', phone: phone(143) });
  s.l3 = await cast.lead({ first_name: null, last_name: 'Murphy', phone: phone(142), customer_id: null });
  s.cA = await cast.customer({ first_name: 'Ada', last_name: 'Murphy', phone: phone(111), email: 'ada.murphy@example.invalid', address_line1: '11 Fixture Row' });
  s.cB = await cast.customer({ first_name: 'Bram', last_name: 'Murphy', phone: phone(222), address_line1: '15 Fixture Row' });
  s.cC = await cast.customer({ first_name: 'Cole', last_name: 'Murphy', phone: phone(333), address_line1: '19 Fixture Row' });
  s.l4 = await cast.lead({ first_name: null, last_name: 'Murphy', phone: phone(144), customer_id: s.cC.id });
  [s.l1, s.l2, s.l3, s.l4].forEach((lead, i) => cast.key(`murphy-lead-${i + 1}`, lead));
  [s.cA, s.cB, s.cC].forEach((customer, i) => cast.key(`cust-murphy-${'abc'[i]}`, customer));
  return s;
}

const leadsState = async (h, s) => (await h.db('leads').whereIn('id', [s.l1.id, s.l2.id, s.l3.id, s.l4.id].filter(Boolean)).select('id', 'first_name', 'last_name', 'phone', 'status', 'customer_id', 'deleted_at')).reduce((m, r) => ({ ...m, [r.id]: r }), {});
const customersState = async (h, ids) => (await h.db('customers').whereIn('id', ids).select('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'pipeline_stage', 'deleted_at', 'updated_at')).reduce((m, r) => ({ ...m, [r.id]: r }), {});
const activityCount = (h, leadId) => h.db('lead_activities').where({ lead_id: leadId, performed_by: 'Intelligence Bar' }).count('* as n').first().then((r) => Number(r.n));

// The tool calls a correct model makes for a lead name: look the leads up, then edit the one that fits.
const leadEditRounds = (leadId, firstName) => [
  { tools: [['query_leads', { search: 'Murphy' }]] },
  { tools: [['update_lead_contact', { lead_id: leadId, first_name: firstName }]] },
];

const CASES = {};

// --- owner-direct dependent (probed): one lead gets a first name ---
async function leadFirstName(ctx, h, cast, c, { target, name, prompt, page }) {
  const s = await seedMurphyLeads(cast);
  const want = s[target];
  const before = await leadsState(h, s);
  const customersBefore = await customersState(h, [s.cA.id, s.cB.id, s.cC.id]);
  const est = await ctx.establish({ prompt: prompt || c.request, page: page ? page(s) : {}, lead: want });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: leadEditRounds(want.id, name) });
  const done = await ctx.commit(turn, { card: c.expected.card, tool: 'update_lead_contact', label: 'lead_edit' });
  const after = await leadsState(h, s);
  ctx.check(after[want.id].first_name === name, 'read_back', 'first_name_not_saved', `lead ${want.id.slice(0, 8)} first_name ${after[want.id].first_name}`);
  for (const id of [s.l1, s.l2, s.l3, s.l4].map((l) => l.id).filter((id) => id !== want.id)) {
    ctx.check(after[id].first_name === before[id].first_name, 'side_effect', 'other_murphy_lead_changed', `lead ${id.slice(0, 8)} first_name ${before[id].first_name} -> ${after[id].first_name}`);
  }
  ctx.check(after[want.id].last_name === before[want.id].last_name && after[want.id].phone === before[want.id].phone, 'side_effect', 'unnamed_field_changed', 'last name or phone changed');
  ctx.check(JSON.stringify(await customersState(h, [s.cA.id, s.cB.id, s.cC.id])) === JSON.stringify(customersBefore), 'side_effect', 'customer_changed_by_lead_edit', 'a Murphy customer row changed');
  if (done.direct || done.confirmed) ctx.check((await activityCount(h, want.id)) === 1, 'receipt', 'lead_audit_row_missing', 'lead_activities has no single Intelligence Bar entry for the edit');
  ctx.markCompleted();
  return { s, turn };
}

CASES['W3-dev-01'] = (ctx, h, cast, c) => leadFirstName(ctx, h, cast, c, { target: 'l3', name: 'Jay' });

CASES['W3-dev-02'] = async (ctx, h, cast, c) => {
  const { s, turn } = await leadFirstName(ctx, h, cast, c, { target: 'l4', name: 'Jay' }); // the forced first resolution
  // wrong one, the one with the phone ending 0142: a new operation with its own receipt.
  const estFix = await ctx.establish({ prompt: c.corrections[0].request, lead: s.l3 });
  const fix = await ctx.turn(h.actors.owner, { prompt: estFix.prompt, page: estFix.page, sessionId: turn.sessionId, rounds: [{ tools: [['update_lead_contact', { lead_id: s.l3.id, first_name: 'Jay' }]] }] });
  const done = await ctx.commit(fix, { card: c.corrections[0].expected.card, tool: 'update_lead_contact', label: 'correction' });
  const after = await leadsState(h, s);
  ctx.check(after[s.l3.id].first_name === 'Jay', 'read_back', 'correction_not_saved', `lead 3 first_name ${after[s.l3.id].first_name}`);
  ctx.check(after[s.l4.id].first_name === 'Jay', 'side_effect', 'first_change_not_left_in_place', `lead 4 first_name ${after[s.l4.id].first_name}`);
  ctx.check(done.direct && fix.body.taskId !== turn.body.taskId, 'receipt', 'correction_without_own_receipt', 'the correction did not carry its own task and receipt');
  ctx.check((await activityCount(h, s.l3.id)) === 1 && (await activityCount(h, s.l4.id)) === 1, 'receipt', 'lead_audit_row_missing', 'each lead should carry one Intelligence Bar entry for its own edit');
  ctx.markCompleted();
};

CASES['W3-dev-03'] = (ctx, h, cast, c) => leadFirstName(ctx, h, cast, c, { target: 'l3', name: 'Jay' });

CASES['W3-dev-04'] = async (ctx, h, cast, c) => {
  const s = await seedMurphyLeads(cast);
  const ids = [s.cA.id, s.cB.id, s.cC.id];
  const before = await customersState(h, ids);
  const page = { customerId: s.cA.id };
  const { prompt } = await ctx.establish({ prompt: c.request, page, customer: s.cA });
  const turn = await ctx.turn(h.actors.owner, { prompt, page, rounds: [{ tools: [['update_customer', { customer_id: s.cA.id, updates: { phone: '+19415550173' } }]] }] });
  await ctx.commit(turn, { card: c.expected.card, tool: 'update_customer', label: 'phone_edit' });
  const after = await customersState(h, ids);
  ctx.check(String(after[s.cA.id].phone).replace(/\D/g, '').endsWith('9415550173'), 'read_back', 'phone_not_saved', `phone ${after[s.cA.id].phone}`);
  ctx.check(after[s.cA.id].email === before[s.cA.id].email && after[s.cA.id].address_line1 === before[s.cA.id].address_line1, 'side_effect', 'unnamed_field_changed', 'email or address changed');
  ctx.check(JSON.stringify(after[s.cB.id]) === JSON.stringify(before[s.cB.id]) && JSON.stringify(after[s.cC.id]) === JSON.stringify(before[s.cC.id]), 'side_effect', 'other_murphy_customer_changed', 'a second Murphy customer changed');
  ctx.markCompleted();
};

// --- the email change keeps its card, then the pending opt-in follows the new address ---
const optinRows = (h, ids) => h.db('newsletter_subscribers').whereIn('customer_id', ids).orderBy('id').select('id', 'customer_id', 'email', 'status', 'confirmation_token', 'unsubscribe_token');

CASES['W3-dev-05'] = async (ctx, h, cast, c) => {
  const s = await seedMurphyLeads(cast);
  const gmail = require('../../../services/email/gmail-client');
  // The fixture's pending newsletter opt-in rows: one for each Murphy customer's own email on file.
  s.cB.email = s.cB.email || `bram.${uuid().slice(0, 6)}@example.invalid`;
  await h.db('customers').where({ id: s.cB.id }).update({ email: s.cB.email });
  for (const customer of [s.cA, s.cB]) await h.db('newsletter_subscribers').insert({ email: customer.email, status: 'pending', source: 'baseline_fixture', customer_id: customer.id, first_name: customer.first_name });
  cast.onRetire((db) => db('newsletter_subscribers').whereIn('customer_id', [s.cA.id, s.cB.id]).del().then(() => db('newsletter_subscribers').whereIn('email', [s.cA.email, s.cB.email, 'murphy.test@example.invalid']).del()));
  h.providers.sendgrid.on = true;
  h.providers.sendgrid.sendOne.mockClear();
  const sentBefore = gmail.sendMessage.mock.calls.length;
  const networkBefore = h.blockedNetwork.length;
  const before = await customersState(h, [s.cA.id]);
  const optinBefore = await optinRows(h, [s.cA.id, s.cB.id]);
  const page = { customerId: s.cA.id };
  const { prompt } = await ctx.establish({ prompt: c.request, page, customer: s.cA });
  const turn = await ctx.turn(h.actors.owner, { prompt, page, rounds: [{ tools: [['update_customer', { customer_id: s.cA.id, updates: { email: 'murphy.test@example.invalid' } }]] }] });
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_email_change', `cards ${turn.cards.length}`);
  const text = JSON.stringify(turn.card || {});
  ctx.check(/opt-?in|confirmation (e-?mail|message)/i.test(text), 'proposal', 'card_does_not_name_optin_email', 'the card does not disclose that changing the email sends an opt-in confirmation email');
  const mid = await customersState(h, [s.cA.id]);
  ctx.check(mid[s.cA.id].email === before[s.cA.id].email, 'side_effect', 'email_changed_before_confirm', `email ${mid[s.cA.id].email}`);
  ctx.check(gmail.sendMessage.mock.calls.length === sentBefore && h.blockedNetwork.length === networkBefore, 'side_effect', 'email_sent_before_card_confirmed', 'a message was sent while the card was still unconfirmed');
  // "Yes, confirm it.": the one card commits, the pending opt-in follows the new address with fresh tokens, one opt-in goes out.
  const done = await ctx.commit(turn, { card: c.corrections[0].expected.card, tool: 'update_customer', label: 'email_change' });
  await h.settle({ quietMs: 1200 });
  const after = await customersState(h, [s.cA.id, s.cB.id]);
  ctx.check(after[s.cA.id].email === 'murphy.test@example.invalid', 'read_back', 'email_not_saved', `email ${after[s.cA.id].email}`);
  ctx.check(after[s.cA.id].phone === before[s.cA.id].phone, 'side_effect', 'unnamed_field_changed', 'phone changed');
  const optinAfter = await optinRows(h, [s.cA.id, s.cB.id]);
  const a0 = optinBefore.find((r) => r.customer_id === s.cA.id);
  const a1 = optinAfter.find((r) => r.customer_id === s.cA.id);
  const b0 = optinBefore.find((r) => r.customer_id === s.cB.id);
  const b1 = optinAfter.find((r) => r.customer_id === s.cB.id);
  ctx.check(!!a1 && a1.email === 'murphy.test@example.invalid' && a1.status === 'pending', 'read_back', 'pending_optin_did_not_follow_email', `subscriber ${a1 && a1.email} ${a1 && a1.status}`);
  ctx.check(!!a0 && !!a1 && a1.confirmation_token !== a0.confirmation_token && a1.unsubscribe_token !== a0.unsubscribe_token, 'read_back', 'optin_tokens_not_rotated', 'the old confirmation or unsubscribe token still resolves');
  ctx.check(!!b0 && !!b1 && b1.email === b0.email && b1.confirmation_token === b0.confirmation_token, 'side_effect', 'other_murphy_optin_changed', 'the other Murphy subscriber row changed');
  const mails = h.providers.sendgrid.sendOne.mock.calls.map((call) => call[0] || {});
  const other = gmail.sendMessage.mock.calls.length - sentBefore + h.blockedNetwork.length - networkBefore;
  ctx.check(mails.length === 1 && mails[0].to === 'murphy.test@example.invalid' && other === 0, 'side_effect', 'optin_resend_count_wrong', `${mails.length} opt-in email(s) to ${mails.map((m) => m.to).join(',')}; ${other} other outbound attempt(s)`);
  ctx.check(!!a1 && mails.length === 1 && String(mails[0].text || '').includes(a1.confirmation_token), 'side_effect', 'optin_sent_with_stale_token', 'the opt-in email does not carry the fresh confirmation token');
  void done;
  ctx.markCompleted();
};

CASES['W3-dev-06'] = async (ctx, h, cast, c) => {
  const s = await seedMurphyLeads(cast);
  const est1 = await ctx.establish({ prompt: c.request, lead: s.l3 });
  const first = await ctx.turn(h.actors.owner, { prompt: est1.prompt, page: est1.page, rounds: leadEditRounds(s.l3.id, 'Jay') });
  ctx.check(first.cards.length === 1, 'proposal', 'no_card_for_lead_edit', `cards ${first.cards.length}`);
  const mid = await leadsState(h, s);
  ctx.check(mid[s.l3.id].first_name === null, 'side_effect', 'lead_changed_before_confirm', `first_name ${mid[s.l3.id].first_name}`);
  // actually put Jason: a change of mind before anything executed.
  const est2 = await ctx.establish({ prompt: c.corrections[0].request, page: est1.page, lead: s.l3 });
  const second = await ctx.turn(h.actors.owner, { prompt: est2.prompt, page: est2.page, sessionId: first.sessionId, rounds: [{ tools: [['update_lead_contact', { lead_id: s.l3.id, first_name: 'Jason' }]] }] });
  ctx.check(second.cards.length === 1, 'proposal', 'no_new_card_for_revision', `cards ${second.cards.length}`);
  if (second.card) {
    const confirmed = await h.confirm(h.actors.owner, second.card);
    ctx.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true, 'confirm', 'revision_not_confirmable', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 200)}`);
  }
  const after = await leadsState(h, s);
  ctx.check(after[s.l3.id].first_name === 'Jason', 'read_back', 'final_value_not_saved', `lead 3 first_name ${after[s.l3.id].first_name}`);
  for (const id of [s.l1.id, s.l2.id, s.l4.id]) ctx.check(after[id].first_name === mid[id].first_name, 'side_effect', 'other_murphy_lead_changed', `lead ${id.slice(0, 8)} first_name ${mid[id].first_name} -> ${after[id].first_name}`);
  // The superseded Jay card, confirmed after the final value committed, must not overwrite it.
  if (first.card) {
    const late = await h.confirm(h.actors.owner, first.card);
    const row = (await leadsState(h, s))[s.l3.id];
    ctx.check(!(late.status === 200 && late.body && late.body.success === true) && row.first_name === 'Jason', 'confirm', 'obsolete_card_overwrites_final', `the superseded Jay card returned ${late.status}; the lead reads ${row.first_name}`);
  }
  // And while both cards are still pending, the superseded one must not be able to commit (a stricter reading of "the first card is discarded").
  const page4 = { route: '/admin/pipeline', leadId: s.l4.id };
  const cardX = await ctx.turn(h.actors.owner, { prompt: 'This lead: give it Zed as a first name.', page: page4, sessionKey: 'supersede', rounds: [{ tools: [['update_lead_contact', { lead_id: s.l4.id, first_name: 'Zed' }]] }] });
  const cardY = await ctx.turn(h.actors.owner, { prompt: 'This lead: make it Zane instead.', page: page4, sessionKey: 'supersede', rounds: [{ tools: [['update_lead_contact', { lead_id: s.l4.id, first_name: 'Zane' }]] }] });
  if (cardX.card && cardY.card) {
    const stale = await h.confirm(h.actors.owner, cardX.card);
    ctx.check(!(stale.status === 200 && stale.body && stale.body.success === true), 'confirm', 'superseded_pending_card_still_executable', `confirming the superseded Zed card while the Zane card is pending returned ${stale.status}`);
  }
  ctx.markCompleted();
};

CASES['W3-dev-07'] = async (ctx, h, cast, c) => {
  const lead = cast.key('lead-ostrander', await cast.lead({ first_name: null, last_name: 'Ostrander', phone: phone(401) }));
  const est = await ctx.establish({ prompt: c.request, lead });
  const requestKey = uuid();
  const rounds = [{ tools: [['query_leads', { search: 'Ostrander' }]] }, { tools: [['update_lead_contact', { lead_id: lead.id, first_name: 'Pat' }]] }];
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, requestKey, rounds });
  await ctx.commit(turn, { card: c.expected.card, tool: 'update_lead_contact', label: 'lead_edit' });
  // The response is lost; the client submits the same request again with the same key. The saved task answers it.
  const retry = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, requestKey, sessionId: turn.sessionId, rounds });
  ctx.check(retry.status === 200, 'recovery', 'retry_after_lost_response_failed', `retry ${retry.status} ${JSON.stringify(retry.body).slice(0, 160)}`);
  const resumed = await h.task(h.actors.owner, turn.body.taskId, turn.sessionId);
  ctx.check(resumed.status === 200 && (resumed.body.receipts || []).length === 1, 'recovery', 'task_resume_receipts_wrong', `receipts ${(resumed.body && resumed.body.receipts || []).length}`);
  const row = await h.db('leads').where({ id: lead.id }).first('first_name', 'last_name', 'phone');
  ctx.check(row.first_name === 'Pat' && row.last_name === 'Ostrander' && row.phone === lead.phone, 'read_back', 'lead_row_wrong', JSON.stringify(row));
  ctx.check((await activityCount(h, lead.id)) === 1, 'recovery', 'double_submit_wrote_twice', 'the lead was written more than once');
  ctx.markCompleted();
};

CASES['W3-dev-08'] = async (ctx, h, cast, c) => {
  const s = await seedMurphyLeads(cast);
  const ids = [s.cA.id, s.cB.id, s.cC.id];
  const before = await customersState(h, ids);
  const leadsBefore = await leadsState(h, s);
  const page = { customerId: s.cA.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.cA });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: [{ tools: [['update_customer', { customer_id: s.cA.id, updates: { pipeline_stage: 'estimate_sent' } }]] }] });
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_stage_change', `cards ${turn.cards.length}; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 220)}`);
  const mid = await customersState(h, ids);
  ctx.check(mid[s.cA.id].pipeline_stage === before[s.cA.id].pipeline_stage, 'side_effect', 'stage_changed_before_confirm', `stage ${mid[s.cA.id].pipeline_stage}`);
  // "Go ahead.": the card commits with the canonical lifecycle stamps.
  await ctx.commit(turn, { card: c.corrections[0].expected.card, tool: 'update_customer', label: 'stage_change' });
  const after = await customersState(h, ids);
  ctx.check(after[s.cA.id].pipeline_stage === 'estimate_sent', 'read_back', 'stage_not_saved', `stage ${after[s.cA.id].pipeline_stage}`);
  const stamp = await h.db('customers').where({ id: s.cA.id }).first('pipeline_stage_changed_at');
  ctx.check(!!stamp.pipeline_stage_changed_at, 'read_back', 'stage_stamp_missing', 'pipeline_stage_changed_at was not stamped with the stage change');
  ctx.check(JSON.stringify(after[s.cB.id]) === JSON.stringify(before[s.cB.id]) && JSON.stringify(after[s.cC.id]) === JSON.stringify(before[s.cC.id]), 'side_effect', 'other_murphy_customer_changed', 'another Murphy customer changed');
  ctx.check(JSON.stringify(await leadsState(h, s)) === JSON.stringify(leadsBefore), 'side_effect', 'lead_changed_by_customer_stage_edit', 'a lead row changed');
  ctx.markCompleted();
};

CASES['W3-dev-09'] = async (ctx, h, cast, c) => {
  const s = await seedMurphyLeads(cast);
  const before = await leadsState(h, s);
  const customersBefore = await customersState(h, [s.cA.id, s.cB.id, s.cC.id]);
  // A correct model looks for a merge capability; the only one is gated and customer-to-customer.
  const turn = await ctx.turn(h.actors.owner, { prompt: c.request, rounds: [{ tools: [['discover_capabilities', { query: 'merge lead into customer' }]] }] });
  ctx.check(turn.cards.length === 0, 'proposal', 'merge_proposed_for_unsupported_request', `cards ${turn.cards.length}`);
  ctx.check(JSON.stringify(await leadsState(h, s)) === JSON.stringify(before), 'side_effect', 'lead_changed', 'a lead row changed');
  ctx.check(JSON.stringify(await customersState(h, [s.cA.id, s.cB.id, s.cC.id])) === JSON.stringify(customersBefore), 'side_effect', 'customer_changed', 'a customer row changed');
  ctx.markCompleted();
};

CASES['W3-dev-10'] = async (ctx, h, cast, c) => {
  const s = await seedMurphyLeads(cast);
  const est = await ctx.establish({ prompt: c.request, page: { leadId: s.l3.id }, lead: s.l3 });
  // The operator's write access is revoked before the request reaches the commit: the technician rail has no lead writer.
  await h.db('technicians').where({ id: h.actors.owner.id }).update({ role: 'technician' });
  let turn;
  try {
    turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, rounds: [{ tools: [['update_lead_contact', { lead_id: s.l3.id, first_name: 'Jay' }]] }] });
  } finally { await h.db('technicians').where({ id: h.actors.owner.id }).update({ role: 'admin' }); }
  const call = turn.toolCalls.find((t) => t.name === 'update_lead_contact');
  ctx.check(turn.cards.length === 0, 'proposal', 'card_for_revoked_actor', `${turn.cards.length} card(s) for an actor whose write access was revoked`);
  ctx.check(!call || !!(call.result && (call.result.error || call.result.code)), 'confirm', 'revoked_actor_not_refused', `update_lead_contact answered ${JSON.stringify(call && call.result).slice(0, 200)}`);
  const row = (await leadsState(h, s))[s.l3.id];
  ctx.check(row.first_name === null, 'side_effect', 'unauthorized_write_committed', `first_name ${row.first_name}`);
  ctx.markCompleted();
};

module.exports = { CASES };
