'use strict';

// W8 Existing-customer lawn estimate, then change the cadence. save_customer_estimate prices from the saved property
// facts through the real engine and persistence, previews on a card, and commits on a confirmed card; it never sends.
// The scripted model issues the calls a correct (or, for guard cases, a naive) model would; every case verifies the
// estimates table itself. This branch has no direct (card-free) owner mode, so the cases whose contract commits a
// draft without a card are reported not_runnable and only probed.

const { phone } = require('../ib-workflow-fixtures');
const { pick } = require('./common');

async function ensurePricing(db) {
  // Canonical code defaults seed the isolated database; the same seeding the platform estimate suite uses.
  const { PEST, LAWN_PRICING_V2, LAWN_BRACKETS } = require('../../../services/pricing-engine/constants');
  await db('pricing_config').insert([
    { config_key: 'pest_base', name: 'Synthetic pricing baseline', category: 'pest', data: JSON.stringify(PEST) },
    { config_key: 'lawn_pricing_v2', name: 'Synthetic lawn baseline', category: 'lawn', data: JSON.stringify(LAWN_PRICING_V2) },
  ]).onConflict('config_key').ignore();
  if (!(await db('lawn_pricing_brackets').first())) {
    const tiers = ['standard', 'enhanced', 'premium'];
    await db('lawn_pricing_brackets').insert(Object.entries(LAWN_BRACKETS).flatMap(([grass_track, brackets]) =>
      brackets.flatMap((row) => tiers.map((tier, index) => ({ grass_track, sqft_bracket: row[0], tier, monthly_price: row[index + 1] })))));
  }
}

async function lawnCustomer(cast, { first, last, phoneLast4, street, sqft = 5000 }) {
  const customer = await cast.customer({ first_name: first, last_name: last, phone: phone(phoneLast4), address_line1: street, city: 'Bradenton', state: 'FL', zip: '34208',
    pipeline_stage: 'active_customer', ...(sqft ? { property_sqft: sqft, lot_sqft: 10000, lawn_type: 'St. Augustine' } : {}) });
  const property = await cast.property(customer.id, { is_primary: true, address_line1: street, city: 'Bradenton', zip: '34208', ...(sqft ? { property_sqft: sqft, lot_sqft: 10000, lawn_type: 'St. Augustine' } : {}) });
  return { customer, property };
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const draftsOf = (h, f) => h.db('estimates').where({ customer_id: f.customer.id, property_id: f.property.id }).whereNull('archived_at').orderBy('created_at');
const freqOf = (row) => { const d = parse(row.estimate_data); return d && d.engineInputs && d.engineInputs.services && d.engineInputs.services.lawn ? d.engineInputs.services.lawn.lawnFreq : null; };
const engineAnnual = (row) => { const d = parse(row.estimate_data); return d && d.engineResult && d.engineResult.summary ? d.engineResult.summary.recurringAnnualAfterDiscount : null; };
const snap = (row) => JSON.stringify({ id: row.id, status: row.status, annual: String(row.annual_total), monthly: String(row.monthly_total), sent_at: row.sent_at, updated_at: row.updated_at, freq: freqOf(row) });

async function seedEstimateSet(cast, h) {
  await ensurePricing(h.db);
  const s = {};
  s.thistle = await lawnCustomer(cast, { first: 'Tess', last: 'Thistledown', phoneLast4: 801, street: '21 Fixture Row' });
  s.lark = await lawnCustomer(cast, { first: 'Lena', last: 'Larkspur', phoneLast4: 802, street: '23 Fixture Row', sqft: null });
  s.wex = await lawnCustomer(cast, { first: 'Wren', last: 'Wexcombe', phoneLast4: 803, street: '25 Fixture Row' });
  cast.key('cust-thistledown', s.thistle.customer); cast.key('thistledown-home', s.thistle.property);
  return s;
}

/** A quote that was already sent and is honored: made by the real tool, then marked sent as the editor's send would. */
async function seedSentQuote(ctx, h, f) {
  const turn = await ctx.turn(h.actors.owner, { prompt: `For ${f.customer.first_name} ${f.customer.last_name}: seed quote`, page: { customerId: f.customer.id }, sessionKey: 'seed-sent',
    rounds: [{ tools: [['save_customer_estimate', { customer_id: f.customer.id, property_id: f.property.id, lawn_applications: 12 }]] }] });
  if (turn.card) await h.confirm(h.actors.owner, turn.card);
  await h.db('estimates').where({ customer_id: f.customer.id }).update({ status: 'sent', sent_at: new Date() });
  return (await draftsOf(h, f))[0];
}

/** Propose a save (a card, nothing written), optionally revising an existing draft. */
async function proposeSave(ctx, h, f, { apps, estimateId, prompt, sessionId, sessionKey, expectCard = true, ids }) {
  const est = await ctx.establish({ prompt, page: { customerId: f.customer.id }, customer: f.customer });
  const input = { customer_id: f.customer.id, property_id: f.property.id, ...(apps ? { lawn_applications: apps } : {}), ...(estimateId ? { estimate_id: estimateId } : {}) };
  const before = await draftsOf(h, f);
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, sessionId, sessionKey,
    rounds: [{ tools: [['get_customer_estimate_context', { customer_id: f.customer.id }]] }, { tools: [['save_customer_estimate', input]] }] });
  const context = pick(turn, 'get_customer_estimate_context');
  ctx.check(!!context && !context.error && (context.property || {}).id === f.property.id, 'tool_result', 'estimate_context_not_loaded', `context ${JSON.stringify(context).slice(0, 200)}`);
  if (expectCard) ctx.check(turn.cards.length === 1, 'proposal', 'no_card_for_estimate_save', `cards ${turn.cards.length}; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 260)}`);
  const after = await draftsOf(h, f);
  ctx.check(after.length === before.length && after.every((r, i) => snap(r) === snap(before[i])), 'side_effect', 'estimate_written_before_confirm', 'an estimate row changed before the card was confirmed');
  void ids;
  return { turn, est, preview: turn.card };
}

async function confirmSave(ctx, h, proposed) {
  if (!proposed.turn.card) return null;
  const confirmed = await h.confirm(h.actors.owner, proposed.turn.card);
  ctx.check(confirmed.status === 200 && confirmed.body && confirmed.body.success === true && confirmed.body.outcome === 'completed', 'confirm', 'estimate_confirm_not_completed', `confirm ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 240)}`);
  const receipt = await h.receipt(h.actors.owner, proposed.turn.card);
  ctx.check(receipt.status === 200 && receipt.body && receipt.body.success === true, 'receipt', 'receipt_missing', `receipt ${receipt.status}`);
  return confirmed;
}

/** The saved draft against the contract: one draft, draft status, the cadence, the engine price, never sent, no deposit. */
async function checkDraft(ctx, h, f, { apps, count = 1 }) {
  const rows = await draftsOf(h, f);
  ctx.check(rows.length === count, 'read_back', 'draft_count_wrong', `${rows.length} estimates for the customer and property, expected ${count}`);
  const row = rows[rows.length - 1];
  if (!row) return null;
  ctx.check(row.status === 'draft' && !row.sent_at, 'read_back', 'draft_not_unsent', `status ${row.status}, sent_at ${row.sent_at}`);
  ctx.check(freqOf(row) === apps, 'read_back', 'cadence_wrong', `saved cadence ${freqOf(row)}, expected ${apps}`);
  ctx.check(Number(row.annual_total) > 0 && Number(row.annual_total) === Number(engineAnnual(row)), 'read_back', 'price_is_not_the_engine_output', `annual_total ${row.annual_total} vs engine ${engineAnnual(row)}`);
  ctx.check(!/deposit/i.test(JSON.stringify(((parse(row.estimate_data) || {}).engineResult || {}).lineItems || [])), 'side_effect', 'deposit_line_present', 'a deposit line is on the estimate');
  return row;
}

async function noSends(ctx, h, f) {
  const sent = await h.settle();
  ctx.check(sent === 0, 'side_effect', 'estimate_save_sent_a_text', `${sent} provider submissions for an estimate save`);
  const rows = await h.db('sms_log').where({ customer_id: f.customer.id, direction: 'outbound' }).count('* as n').first();
  ctx.check(Number(rows.n) === 0, 'side_effect', 'estimate_save_logged_an_outbound_text', `${rows.n} outbound sms_log rows`);
}

const CASES = {};

async function plainSave(ctx, h, cast, c, apps, { prompt } = {}) {
  const s = await seedEstimateSet(cast, h);
  const proposed = await proposeSave(ctx, h, s.thistle, { apps, prompt: prompt || c.request });
  await confirmSave(ctx, h, proposed);
  await checkDraft(ctx, h, s.thistle, { apps: apps || 9 });
  await noSends(ctx, h, s.thistle);
  return { s, proposed };
}

CASES['W8-dev-01'] = async (ctx, h, cast, c) => { await plainSave(ctx, h, cast, c, 12); ctx.markCompleted(); };
CASES['W8-dev-02'] = async (ctx, h, cast, c) => { await plainSave(ctx, h, cast, c, 12); ctx.markCompleted(); };

CASES['W8-dev-03'] = async (ctx, h, cast, c) => {
  const s = await seedEstimateSet(cast, h);
  const first = await proposeSave(ctx, h, s.thistle, { apps: 9, prompt: c.request });
  await confirmSave(ctx, h, first);
  const draft = (await draftsOf(h, s.thistle))[0];
  if (draft) cast.key('thistledown-draft', draft);
  const nineAnnual = draft && Number(draft.annual_total);
  // "then switch it to twelve": a revision of the same draft, not a second one.
  const second = await proposeSave(ctx, h, s.thistle, { apps: 12, estimateId: draft && draft.id, prompt: 'Switch it to twelve.', sessionId: first.turn.sessionId });
  await confirmSave(ctx, h, second);
  const row = await checkDraft(ctx, h, s.thistle, { apps: 12 });
  ctx.check(!!draft && !!row && row.id === draft.id, 'read_back', 'revision_made_a_second_draft', `draft ${draft && draft.id.slice(0, 8)} became ${row && row.id.slice(0, 8)}`);
  ctx.check(!!row && Number(row.annual_total) !== nineAnnual, 'read_back', 'revised_price_not_recomputed', `annual stayed ${nineAnnual}`);
  await noSends(ctx, h, s.thistle);
  ctx.markCompleted();
};

CASES['W8-dev-04'] = async (ctx, h, cast, c) => {
  const s = await seedEstimateSet(cast, h);
  const first = await proposeSave(ctx, h, s.thistle, { apps: 9, prompt: c.request });
  await confirmSave(ctx, h, first);
  const draft = (await draftsOf(h, s.thistle))[0];
  const before = draft && snap(draft);
  // "make it 6 times a year": there is no 6x program. A naive model passes 6 anyway; the layer must refuse and leave the draft.
  const second = await ctx.turn(h.actors.owner, { prompt: c.corrections[0].request, page: { customerId: s.thistle.customer.id }, sessionId: first.turn.sessionId, sessionKey: 'six',
    rounds: [{ tools: [['save_customer_estimate', { customer_id: s.thistle.customer.id, property_id: s.thistle.property.id, estimate_id: draft && draft.id, lawn_applications: 6 }]] }] });
  const rows = await draftsOf(h, s.thistle);
  ctx.check(second.cards.length === 0, 'proposal', 'six_times_a_year_proposed', `cards ${second.cards.length}; ${JSON.stringify(second.toolCalls.slice(-1).map((t) => t.result)).slice(0, 220)}`);
  if (second.card) await h.confirm(h.actors.owner, second.card);
  const after = await draftsOf(h, s.thistle);
  ctx.check(rows.length === 1 && after.length === 1 && snap(after[0]) === before, 'side_effect', 'draft_changed_by_unsupported_cadence', 'the 9x draft changed or a second draft appeared');
  ctx.check(after.every((r) => [9, 12].includes(freqOf(r))), 'domain_rule', 'cadence_outside_9_or_12_saved', `cadence ${after.map(freqOf).join(',')}`);
  ctx.markCompleted();
};

CASES['W8-dev-05'] = async (ctx, h, cast, c) => {
  const s = await seedEstimateSet(cast, h);
  const first = await proposeSave(ctx, h, s.thistle, { apps: 12, prompt: c.request });
  await confirmSave(ctx, h, first);
  await checkDraft(ctx, h, s.thistle, { apps: 12 });
  const draft = (await draftsOf(h, s.thistle))[0];
  cast.key('thistledown-draft', draft);
  const context = pick(first.turn, 'get_customer_estimate_context');
  // "use the back lot measurement": the same draft is saved again through a second card. The measurement itself cannot be named (below).
  const again = await proposeSave(ctx, h, s.thistle, { apps: 12, estimateId: draft && draft.id, prompt: c.corrections[0].request, sessionId: first.turn.sessionId, sessionKey: 'back-lot' });
  await confirmSave(ctx, h, again);
  ctx.check((await draftsOf(h, s.thistle)).length === 1, 'side_effect', 'second_draft_for_the_same_estimate', 'a re-save made a second draft');
  // The tool reads one saved measurement per property and has no way to name a different one ("use the back lot").
  const hasChoice = context && context.property && Array.isArray(context.property.measurements) && context.property.measurements.length > 1;
  ctx.checkScored(!!hasChoice, 'capability', 'measurement_choice_not_supported', 'the estimate context exposes one lawn measurement per property and the save tool takes no measurement selector, so "use the back lot measurement" cannot be carried out');
  ctx.note('measurement choice: one saved measurement per property, no selector on save_customer_estimate');
  ctx.markCompleted();
};

CASES['W8-dev-06'] = async (ctx, h, cast, c) => {
  const s = await seedEstimateSet(cast, h);
  const first = await proposeSave(ctx, h, s.thistle, { apps: 12, prompt: c.request });
  // The saved lawn measurement changes after the price was computed and before the card is confirmed.
  await h.db('customer_properties').where({ id: s.thistle.property.id }).update({ property_sqft: 12000, updated_at: new Date() });
  await h.db('customers').where({ id: s.thistle.customer.id }).update({ property_sqft: 12000 });
  let stale;
  if (first.turn.card) {
    stale = await h.confirm(h.actors.owner, first.turn.card);
    ctx.check(!(stale.status === 200 && stale.body && stale.body.success === true), 'confirm', 'drifted_estimate_saved_at_stale_price', `the card priced before the measurement edit confirmed: ${stale.status} ${JSON.stringify(stale.body).slice(0, 200)}`);
  }
  ctx.check((await draftsOf(h, s.thistle)).length === 0, 'side_effect', 'draft_saved_at_the_stale_price', 'a draft exists after the refused confirm');
  const redo = await proposeSave(ctx, h, s.thistle, { apps: 12, prompt: c.request, sessionKey: 'redo' });
  await confirmSave(ctx, h, redo);
  const row = await checkDraft(ctx, h, s.thistle, { apps: 12 });
  const stalePrice = first.turn.card && JSON.stringify(first.turn.card).match(/\$[\d,]+(?:\.\d\d)?/g);
  const freshPrice = redo.turn.card && JSON.stringify(redo.turn.card).match(/\$[\d,]+(?:\.\d\d)?/g);
  ctx.check(!!row && JSON.stringify(stalePrice) !== JSON.stringify(freshPrice), 'proposal', 'recomputed_card_shows_the_old_price', `old ${JSON.stringify(stalePrice)} new ${JSON.stringify(freshPrice)}`);
  ctx.markCompleted();
};

CASES['W8-dev-07'] = async (ctx, h, cast, c) => {
  const s = await seedEstimateSet(cast, h);
  const sent = await seedSentQuote(ctx, h, s.wex);
  ctx.check(!!sent && sent.status === 'sent', 'harness', 'sent_quote_not_seeded', `sent quote ${sent && sent.status}`);
  const before = sent && snap(sent);
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.wex.customer.id }, customer: s.wex.customer });
  // A naive model revises the sent quote in place; the layer must stop at the honored quote.
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, sessionKey: 'revise-sent',
    rounds: [{ tools: [['get_customer_estimate_context', { customer_id: s.wex.customer.id }]] }, { tools: [['save_customer_estimate', { customer_id: s.wex.customer.id, property_id: s.wex.property.id, estimate_id: sent && sent.id, lawn_applications: 9 }]] }] });
  const context = pick(turn, 'get_customer_estimate_context');
  ctx.check(!!context && (context.estimates || []).some((e) => sent && e.id === sent.id && e.status === 'sent'), 'tool_result', 'sent_status_not_visible', 'the context does not show the quote as sent');
  ctx.check(turn.cards.length === 0, 'domain_rule', 'sent_quote_revision_offered', `a card to revise the sent quote in place was offered; ${JSON.stringify(turn.toolCalls.slice(-1).map((t) => t.result)).slice(0, 200)}`);
  if (turn.card) await h.confirm(h.actors.owner, turn.card);
  const after = await draftsOf(h, s.wex);
  ctx.check(after.length === 1 && snap(after[0]) === before, 'side_effect', 'sent_quote_changed', 'the sent quote changed or a second estimate appeared');
  ctx.markCompleted();
};

CASES['W8-dev-08'] = async (ctx, h, cast, c) => {
  const s = await seedEstimateSet(cast, h);
  // The tool has no price field: a model can only save at the engine price (the default 9 applications), and must say it cannot hand-enter 50.
  const proposed = await proposeSave(ctx, h, s.thistle, { apps: 9, prompt: c.request });
  await confirmSave(ctx, h, proposed);
  const row = await checkDraft(ctx, h, s.thistle, { apps: 9 });
  ctx.check(!!row && !JSON.stringify(parse(row.estimate_data).engineResult || {}).includes('"perApplication":50'), 'side_effect', 'operator_typed_price_on_estimate', 'a 50 dollar line is on the estimate');
  await noSends(ctx, h, s.thistle);
  ctx.markCompleted();
};

CASES['W8-dev-09'] = async (ctx, h, cast, c) => {
  const s = await seedEstimateSet(cast, h);
  const est = await ctx.establish({ prompt: c.request, page: { customerId: s.lark.customer.id }, customer: s.lark.customer });
  const turn = await ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page,
    rounds: [{ tools: [['get_customer_estimate_context', { customer_id: s.lark.customer.id }]] }, { tools: [['save_customer_estimate', { customer_id: s.lark.customer.id, property_id: s.lark.property.id, lawn_applications: 12 }]] }] });
  const save = pick(turn, 'save_customer_estimate');
  ctx.check(turn.cards.length === 0, 'proposal', 'estimate_card_without_a_measurement', `cards ${turn.cards.length}`);
  ctx.check(!!save && (save.success === false || !!save.error) && /measure|lawn|area|facts|property/i.test(JSON.stringify(save)), 'tool_result', 'missing_measurement_not_reported', `save result ${JSON.stringify(save).slice(0, 220)}`);
  ctx.check((await draftsOf(h, s.lark)).length === 0, 'side_effect', 'estimate_saved_without_a_measurement', 'a draft exists for a property with no lawn measurement');
  ctx.markCompleted();
};

CASES['W8-dev-10'] = async (ctx, h, cast, c) => {
  const s = await seedEstimateSet(cast, h);
  const proposed = await proposeSave(ctx, h, s.thistle, { apps: 12, prompt: c.request });
  await confirmSave(ctx, h, proposed);
  await checkDraft(ctx, h, s.thistle, { apps: 12 });
  await noSends(ctx, h, s.thistle);
  ctx.markCompleted();
};

module.exports = { CASES };
