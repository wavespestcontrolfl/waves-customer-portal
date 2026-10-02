'use strict';

// W4 Second service property labeled rental. The property tools preview, then commit. Owner-direct (#5563) commits an
// unlabelled property edit without a card; a label is customer-visible copy, so a labelled add keeps its card, and so
// does moving a grouped visit. ctx.commit follows the manifest's card flag for each step.

const { phone, nextWeekdayET, plusDaysET } = require('../ib-workflow-fixtures');

async function seedLarkspur(cast, { withRental = false } = {}) {
  const s = {};
  s.customer = await cast.customer({ first_name: 'Lena', last_name: 'Larkspur', phone: phone(501), address_line1: '3 Fixture Row' });
  s.home = await cast.property(s.customer.id, { is_primary: true, label: 'home', address_line1: '3 Fixture Row' });
  s.v1 = await cast.visit(s.customer.id, { scheduled_date: plusDaysET(4), property_id: s.home.id });
  s.v2 = await cast.visit(s.customer.id, { scheduled_date: plusDaysET(11), property_id: s.home.id });
  if (withRental) s.rental = await cast.property(s.customer.id, { is_primary: false, label: 'rental', address_line1: '27 Sample Court', city: 'Samplecity', zip: '34200', occupancy_type: 'rental_investment', relationship: 'rental_owned' });
  cast.key('cust-larkspur', s.customer);
  if (s.rental) cast.key('larkspur-rental', s.rental);
  return s;
}

async function seedWexcombe(cast) {
  const s = {};
  s.customer = await cast.customer({ first_name: 'Wren', last_name: 'Wexcombe', phone: phone(502), address_line1: '9 Fixture Row' });
  s.home = await cast.property(s.customer.id, { is_primary: true, label: 'home', address_line1: '9 Fixture Row' });
  s.lake = await cast.property(s.customer.id, { is_primary: false, label: 'lake house', address_line1: '21 Sample Court', occupancy_type: 'seasonal', relationship: 'own_home' });
  const friday = nextWeekdayET(5, 2);
  const group = (await cast.visitGroup(s.customer.id, { scheduled_date: friday, property_id: s.home.id })).id;
  s.friLawn = await cast.visit(s.customer.id, { scheduled_date: friday, service_type: 'Lawn Care Service', property_id: s.home.id, visit_id: group });
  s.friPest = await cast.visit(s.customer.id, { scheduled_date: friday, service_type: 'Quarterly Pest Control Service', property_id: s.home.id, visit_id: group });
  s.mon = await cast.visit(s.customer.id, { scheduled_date: nextWeekdayET(1, 2), property_id: s.home.id });
  cast.key('cust-wexcombe', s.customer); cast.key('wexcombe-lake-house', s.lake); cast.key('wexcombe-friday-lawn', s.friLawn);
  return s;
}

const propRows = (h, customerId) => h.db('customer_properties').where({ customer_id: customerId }).orderBy('created_at').select('id', 'label', 'address_line1', 'is_primary', 'active', 'occupancy_type', 'relationship');
const visitProps = async (h, customerId) => (await h.db('scheduled_services').where({ customer_id: customerId }).select('id', 'property_id')).reduce((m, r) => ({ ...m, [r.id]: r.property_id }), {});
const customerCount = async (h, ids) => Number((await h.db('customers').whereIn('id', ids).whereNull('deleted_at').count('* as n').first()).n);

const addRentalInput = (customerId) => ({ customer_id: customerId, address_line1: '27 Sample Court', address_line2: null, city: 'Samplecity', state: 'FL', zip: '34200', label: 'rental', occupancy_type: 'rental_investment', relationship: 'rental_owned' });
const addRentalRounds = (customerId) => [{ tools: [['get_customer_detail', { customer_id: customerId }]] }, { tools: [['add_customer_property', addRentalInput(customerId)]] }];

/** The card step and (when the case commits) the confirm, with the state checks every property add shares. */
async function addRental(ctx, h, cast, c, { actor = h.actors.owner, withRental = false, prompt, commit = true } = {}) {
  const s = await seedLarkspur(cast, { withRental });
  const page = { customerId: s.customer.id };
  const before = { props: await propRows(h, s.customer.id), visits: await visitProps(h, s.customer.id), customers: await customerCount(h, cast.customers) };
  const est = await ctx.establish({ prompt: prompt || c.request, page, customer: s.customer });
  const turn = await ctx.turn(actor, { prompt: est.prompt, page, rounds: addRentalRounds(s.customer.id) });
  return { s, page, before, turn };
}

function checkAdded(ctx, h, s, before, after, { expectNew }) {
  const beforeIds = new Set(before.props.map((p) => p.id));
  const added = after.props.filter((p) => !beforeIds.has(p.id));
  if (expectNew) {
    ctx.check(added.length === 1, 'read_back', 'property_row_count_wrong', `${added.length} new property rows`);
    const row = added[0];
    if (row) {
      ctx.check(row.label === 'rental', 'read_back', 'label_not_rental', `label ${row.label}`);
      ctx.check(row.address_line1 === '27 Sample Court', 'read_back', 'address_wrong', `address ${row.address_line1}`);
      ctx.check(row.is_primary === false, 'side_effect', 'new_property_promoted_to_primary', 'the new property is primary');
    }
  } else {
    ctx.check(added.length === 0, 'domain_rule', 'duplicate_property_created', `${added.length} new rows for an address the customer already has`);
  }
  const primaryBefore = before.props.find((p) => p.is_primary);
  const primaryAfter = after.props.find((p) => p.id === (primaryBefore && primaryBefore.id));
  ctx.check(!primaryBefore || (primaryAfter && primaryAfter.is_primary), 'side_effect', 'primary_flag_changed', 'the existing primary property lost its flag');
}

const CASES = {};

// Owner-direct dependent cases share this body: propose, confirm the card (probe), verify.
async function directAdd(ctx, h, cast, c, extra = {}) {
  const { s, before, turn } = await addRental(ctx, h, cast, c, extra);
  if (c.expected.card) {
    const mid = await propRows(h, s.customer.id);
    ctx.check(turn.cards.length === 1 && mid.length === before.props.length, 'side_effect', 'property_saved_before_confirm', `${turn.cards.length} card(s); a row appeared before the card was confirmed: ${mid.length - before.props.length}`);
  }
  const done = await ctx.commit(turn, { card: c.expected.card, tool: 'add_customer_property', label: 'property_add' });
  const auditId = done.result && done.result.audit_id;
  if (done.confirmed || done.direct) {
    if (auditId) ctx.check(!!(await h.db('audit_log').where({ id: auditId }).first()), 'receipt', 'audit_row_missing', `no audit_log row ${auditId}`);
    else ctx.check(false, 'receipt', 'audit_id_missing', 'the committed result carries no audit id');
  }
  const after = { props: await propRows(h, s.customer.id), visits: await visitProps(h, s.customer.id), customers: await customerCount(h, cast.customers) };
  checkAdded(ctx, h, s, before, after, { expectNew: !extra.existing });
  ctx.check(JSON.stringify(after.visits) === JSON.stringify(before.visits), 'side_effect', 'visit_repointed', 'an existing appointment changed property');
  ctx.check(after.customers === before.customers, 'side_effect', 'second_customer_created', `customers ${before.customers} -> ${after.customers}`);
  return { s, turn, confirmed: done.confirmed, before, after };
}

CASES['W4-dev-01'] = (ctx, h, cast, c) => directAdd(ctx, h, cast, c).then(() => ctx.markCompleted());
CASES['W4-dev-02'] = (ctx, h, cast, c) => directAdd(ctx, h, cast, c).then(() => ctx.markCompleted());

CASES['W4-dev-03'] = async (ctx, h, cast, c) => {
  const { s, turn } = await directAdd(ctx, h, cast, c);
  // The same address typed twice: the second attempt must report the existing row and add nothing.
  const countBefore = (await propRows(h, s.customer.id)).length;
  const est = await ctx.establish({ prompt: c.corrections[0].request, page: { customerId: s.customer.id }, customer: s.customer });
  const again = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: { customerId: s.customer.id }, sessionId: turn.sessionId, rounds: [{ tools: [['add_customer_property', addRentalInput(s.customer.id)]] }] });
  const toolResult = JSON.stringify(again.toolCalls.map((t) => t.result)).slice(0, 300);
  if (again.card) {
    const confirmed = await h.confirm(h.actors.owner, again.card);
    ctx.check(!(confirmed.body && confirmed.body.success === true) || (await propRows(h, s.customer.id)).length === countBefore, 'domain_rule', 'duplicate_property_created', `the second add confirmed: ${JSON.stringify(confirmed.body).slice(0, 200)}`);
  }
  const rows = await propRows(h, s.customer.id);
  ctx.check(rows.filter((r) => r.address_line1 === '27 Sample Court').length === 1, 'domain_rule', 'duplicate_property_row', `${rows.filter((r) => r.address_line1 === '27 Sample Court').length} rows for 27 Sample Court`);
  const secondAdd = again.toolCalls.filter((t) => t.name === 'add_customer_property').pop();
  ctx.check(again.cards.length === 0 && !!secondAdd && !!secondAdd.result && secondAdd.result.code === 'property_exists', 'proposal', 'second_add_not_reported_as_existing', `the second attempt must be answered property_exists with no card (cards ${again.cards.length}); tool result ${toolResult}`);
  ctx.markCompleted();
};

CASES['W4-dev-04'] = async (ctx, h, cast, c) => {
  const { s } = await directAdd(ctx, h, cast, c);
  // "they moved into the rental, make it their primary home": a property recorded as a rental cannot be made primary while it stays
  // one, so the correct model reclassifies it (own home, owner occupied; no label, so both edits are direct) and then promotes it.
  const rows = await propRows(h, s.customer.id);
  const rental = rows.find((r) => r.address_line1 === '27 Sample Court');
  cast.key('larkspur-rental', rental);
  const visitsBefore = await visitProps(h, s.customer.id);
  const page = { customerId: s.customer.id };
  const est = await ctx.establish({ prompt: c.corrections[0].request, page, customer: s.customer });
  const step = c.corrections[0].expected;
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: [
    { tools: [['update_customer_property', { customer_id: s.customer.id, property_id: rental && rental.id, occupancy_type: 'owner_occupied', relationship: 'own_home' }]] },
    { tools: [['set_primary_property', { customer_id: s.customer.id, property_id: rental && rental.id }]] },
  ] });
  const edit = await ctx.commit(turn, { card: step.card, tool: 'update_customer_property', label: 'reclassify' });
  const promote = await ctx.commit({ ...turn, cards: [] }, { card: step.card, tool: 'set_primary_property', label: 'primary_change' });
  void edit; void promote;
  const task = await h.task(h.actors.owner, turn.body.taskId, turn.sessionId);
  ctx.check(task.status === 200 && (task.body.receipts || []).length === 2, 'receipt', 'receipt_per_edit_missing', `${task.status}: ${(task.body && task.body.receipts || []).length} receipts for two direct edits`);
  const after = await propRows(h, s.customer.id);
  const now = after.find((r) => r.address_line1 === '27 Sample Court');
  ctx.check(now.is_primary === true && after.filter((r) => r.is_primary).length === 1, 'read_back', 'primary_flag_wrong', JSON.stringify(after.map((r) => [r.address_line1, r.is_primary])));
  ctx.check(now.occupancy_type === 'owner_occupied' && now.relationship === 'own_home', 'read_back', 'rental_not_reclassified', `occupancy ${now.occupancy_type}, relationship ${now.relationship}`);
  ctx.check(now.label === 'rental', 'side_effect', 'label_changed_by_promotion', `label ${now.label}`);
  ctx.check(JSON.stringify(await visitProps(h, s.customer.id)) === JSON.stringify(visitsBefore), 'side_effect', 'visit_repointed', 'making the rental primary re-pointed an existing visit');
  ctx.markCompleted();
};

CASES['W4-dev-05'] = async (ctx, h, cast, c) => {
  const s = await seedWexcombe(cast);
  const page = { customerId: s.customer.id };
  const before = await visitProps(h, s.customer.id);
  const est = await ctx.establish({ prompt: c.request, page, customer: s.customer });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: [{ tools: [['get_customer_detail', { customer_id: s.customer.id }]] }, { tools: [['switch_appointment_property', { appointment_id: s.friLawn.id, property_id: s.lake.id }]] }] });
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_grouped_move', `cards ${turn.cards.length}; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 240)}`);
  const text = JSON.stringify(turn.card || {});
  // Both grouped rows by their pinned ids: a card that says "group" but lists only the lawn row would leave the pest row's move unseen.
  const named = [s.friLawn, s.friPest].filter((row) => text.includes(row.id));
  ctx.check(named.length === 2, 'proposal', 'card_does_not_say_both_rows_move', `the card names ${named.length} of the 2 grouped service rows (lawn ${s.friLawn.id.slice(0, 8)}, pest ${s.friPest.id.slice(0, 8)})`);
  const mid = await visitProps(h, s.customer.id);
  ctx.check(JSON.stringify(mid) === JSON.stringify(before), 'side_effect', 'visit_moved_before_confirm', 'a visit changed property before the card was confirmed');
  ctx.markCompleted();
};

CASES['W4-dev-06'] = async (ctx, h, cast, c) => {
  const { s, before, turn } = await addRental(ctx, h, cast, c);
  ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_property_add', `cards ${turn.cards.length}; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 240)}`);
  // The card's own effects: the address being saved and the label being set, not words that happen to appear anywhere in it.
  const effects = (turn.card && turn.card.contract && turn.card.contract.effects) || [];
  ctx.check(effects.some((e) => /27 Sample Court/.test(String(e.label || ''))) && effects.some((e) => /^label:/i.test(String(e.label || '')) && e.after === 'rental'), 'proposal', 'card_preview_incomplete', 'the card effects do not show the address being saved and the label set to rental');
  const mid = await propRows(h, s.customer.id);
  ctx.check(mid.length === before.props.length, 'side_effect', 'property_saved_before_confirm', 'a row appeared before the card was confirmed');
  ctx.markCompleted();
};

CASES['W4-dev-07'] = async (ctx, h, cast, c) => {
  // The rental already exists as 27 Sample Court; the abbreviation 27 Sample Ct normalizes to the same address.
  const s = await seedLarkspur(cast, { withRental: true });
  const before = { props: await propRows(h, s.customer.id), visits: await visitProps(h, s.customer.id), customers: await customerCount(h, cast.customers) };
  const page = { customerId: s.customer.id };
  const est = await ctx.establish({ prompt: c.request, page, customer: s.customer });
  const input = { ...addRentalInput(s.customer.id), address_line1: '27 Sample Ct' };
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page, rounds: [{ tools: [['get_customer_detail', { customer_id: s.customer.id }]] }, { tools: [['add_customer_property', input]] }] });
  const result = JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 300);
  if (turn.card) {
    const confirmed = await h.confirm(h.actors.owner, turn.card);
    ctx.note(`a card was shown for the abbreviated duplicate; confirm returned ${confirmed.status}`);
  }
  const after = { props: await propRows(h, s.customer.id), visits: await visitProps(h, s.customer.id) };
  ctx.check(after.props.length === before.props.length, 'domain_rule', 'duplicate_property_created', `abbreviated address created a row; tool result ${result}`);
  // The contract is a no-op that says why: the tool must report the address as already on file (`property_exists`) and offer no
  // card. Any other zero-card answer (an unavailable tool, an unrelated validation error) is not the duplicate check.
  const added = turn.toolCalls.filter((t) => t.name === 'add_customer_property').pop();
  ctx.check(turn.cards.length === 0, 'proposal', 'duplicate_not_reported_before_card', `a card was proposed for an address the customer already has; tool result ${result}`);
  ctx.check(!!added && !!added.result && added.result.code === 'property_exists', 'tool_result', 'duplicate_property_not_identified', `add_customer_property did not answer property_exists for the abbreviated duplicate: ${result}`);
  ctx.check(JSON.stringify(after.visits) === JSON.stringify(before.visits), 'side_effect', 'visit_repointed', 'a visit changed property');
  ctx.markCompleted();
};

CASES['W4-dev-08'] = async (ctx, h, cast, c) => {
  const { s, before, turn } = await addRental(ctx, h, cast, c, { prompt: c.request });
  // The correct model adds the property and does not blanket re-point visits (the contract asks which visit).
  await ctx.commit(turn, { card: c.expected.card, tool: 'add_customer_property', label: 'property_add' });
  const after = { props: await propRows(h, s.customer.id), visits: await visitProps(h, s.customer.id) };
  checkAdded(ctx, h, s, before, after, { expectNew: true });
  ctx.check(JSON.stringify(after.visits) === JSON.stringify(before.visits), 'side_effect', 'visit_repointed', 'upcoming visits changed property on a blanket instruction');
  ctx.markCompleted();
};

CASES['W4-dev-09'] = async (ctx, h, cast, c) => {
  const s = await seedLarkspur(cast);
  const before = await propRows(h, s.customer.id);
  const page = { customerId: s.customer.id };
  const turn = await ctx.turn(h.actors.tech, { prompt: c.request, page, rounds: [{ tools: [['add_customer_property', addRentalInput(s.customer.id)]] }] });
  ctx.check(turn.cards.length === 0, 'proposal', 'technician_got_a_card', `cards ${turn.cards.length}`);
  ctx.expectRefusal(turn, 'add_customer_property', { error: /not available to your role/i }, 'technician_property_tool_not_refused');
  ctx.check((await propRows(h, s.customer.id)).length === before.length, 'side_effect', 'unauthorized_write_committed', 'a technician session added a property');
  ctx.markCompleted();
};

CASES['W4-dev-10'] = async (ctx, h, cast, c) => {
  const { s, turn, confirmed } = await directAdd(ctx, h, cast, c);
  // The response is lost after the write committed: reload, then resubmit the same confirm.
  if (turn.card) {
    const reload = await h.receipt(h.actors.owner, turn.card);
    ctx.check(reload.status === 200 && reload.body && reload.body.success === true, 'recovery', 'receipt_not_recoverable_after_lost_response', `receipt ${reload.status}`);
    const replay = await h.confirm(h.actors.owner, turn.card);
    ctx.check(replay.status === 409, 'recovery', 'replay_not_refused', `replay returned ${replay.status}`);
    const rows = (await propRows(h, s.customer.id)).filter((r) => r.address_line1 === '27 Sample Court');
    ctx.check(rows.length === 1, 'recovery', 'duplicate_mutation', `${rows.length} rows after reload and replay`);
    const resumed = await h.task(h.actors.owner, turn.body.taskId, turn.sessionId);
    ctx.check(resumed.status === 200 && (resumed.body.receipts || []).length === 1, 'recovery', 'task_resume_receipts_wrong', `receipts ${(resumed.body && resumed.body.receipts || []).length}`);
  }
  void confirmed;
  ctx.markCompleted();
};

module.exports = { CASES };
