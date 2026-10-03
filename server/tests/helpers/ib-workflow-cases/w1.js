'use strict';

// W1 What needs my attention today. Reads only. The scripted model calls the
// Needs Me reader the way a correct model would; every fact in the tool result
// the model receives is checked against rows this case seeded, and the case
// proves nothing was resolved, acknowledged or newly raised by reading.


const { foreignNotifications } = require('../ib-workflow-state');

const BILLING = 'Billing'; // area names are the reader's own vocabulary

// 14 work items (4 Billing, 3 Schedule, 2 Comms, 1 each Estimates, Leads, Customers,
// Inventory, System) plus 3 raw unsorted rows: the "alerts-mixed" fixture.
const MIXED = [
  ...Array(4).fill('Billing'), ...Array(3).fill('Schedule'), ...Array(2).fill('Comms'),
  'Estimates', 'Leads', 'Customers', 'Inventory', 'System',
];

async function seedAlerts(cast, areas, { unsorted = 0, subjectCustomer = null, doneWhen = 'resolved_in_page' } = {}) {
  const work = [];
  for (let i = 0; i < areas.length; i += 1) {
    const area = areas[i];
    const row = await cast.notification({
      category: 'system', title: `${area} item ${i + 1}`, body: `${area} fixture alert ${i + 1}`,
      link: `/admin/${area.toLowerCase()}?fixture=${i + 1}`,
      metadata: { area, severity: i % 5 === 0 ? 'broken' : 'needs-you', who: i % 7 === 3 ? 'claude' : 'person', doneWhen,
        subject: subjectCustomer && i < 2 ? { type: 'customer', id: subjectCustomer } : { type: 'check', id: `fixture${i + 1}` } },
    });
    work.push({ id: row.id, area, who: i % 7 === 3 ? 'claude' : 'person' });
  }
  const raw = [];
  for (let i = 0; i < unsorted; i += 1) {
    const row = await cast.notification({ category: 'system', title: `Raw unlabeled row ${i + 1}`, link: '/admin/dashboard', metadata: {} });
    raw.push({ id: row.id });
  }
  return { work, raw };
}

async function snapshotState(h, cast) {
  const ids = cast.notificationIds;
  const rows = ids.length ? await h.db('notifications').whereIn('id', ids).select('id', 'done_at', 'read_at', 'resolution') : [];
  const total = await foreignNotifications(h, cast); // notifications raised during this case that are not its fixtures
  // Every column of each seeded row, by id: a title, link, metadata or done_by edited in place changes no count.
  const values = ids.length ? await h.db('notifications').whereIn('id', ids).select('*') : [];
  return { open: rows.filter((r) => !r.done_at).length, read: rows.filter((r) => r.read_at).length, total, rows: Object.fromEntries(values.map((r) => [r.id, JSON.stringify(r)])) };
}

async function ambient(opts = {}) {
  const { listNeedsMe } = require('../../../services/needs-me'); // lazy: the database env is set at boot
  return listNeedsMe({ limit: 500, ...opts });
}

function needsMeCall(ctx, turn) {
  const call = turn.toolCalls.find((c) => c.name === 'needs_me');
  ctx.check(!!call, 'tool_result', 'needs_me_not_called', 'the scripted needs_me call did not reach the reader');
  return call && call.result;
}

function checkNothingResolved(ctx, before, after, label = '') {
  ctx.check(after.open === before.open, 'side_effect', 'alert_resolved_by_read', `${label} open seeded alerts ${before.open} -> ${after.open}`);
  ctx.check(after.read === before.read, 'side_effect', 'alert_acknowledged_by_read', `${label} read-marked seeded alerts ${before.read} -> ${after.read}`);
  ctx.check(after.total === before.total, 'side_effect', 'notification_raised_by_read', `${label} notification rows ${before.total} -> ${after.total}`);
  const edited = Object.keys(before.rows).filter((id) => before.rows[id] !== after.rows[id]);
  ctx.check(edited.length === 0, 'side_effect', 'alert_row_changed_by_read', `${label} ${edited.length} seeded notification row(s) changed value`);
}

function checkMixedFacts(ctx, result, seeded, base) {
  if (!result) return;
  ctx.check(result.total_open === base.total + seeded.work.length, 'tool_result', 'total_open_mismatch',
    `reader total_open ${result.total_open}, expected ${base.total} ambient + ${seeded.work.length} seeded`);
  ctx.check(result.unsorted_total === base.unsortedTotal + seeded.raw.length, 'tool_result', 'unsorted_total_mismatch',
    `reader unsorted_total ${result.unsorted_total}, expected ${base.unsortedTotal} ambient + ${seeded.raw.length} seeded`);
  const itemIds = new Set((result.items || []).map((i) => i.id));
  const unsortedIds = new Set((result.unsorted || []).map((i) => i.id));
  const missingWork = seeded.work.filter((w) => !itemIds.has(w.id));
  ctx.check(missingWork.length === 0, 'tool_result', 'work_item_missing', `${missingWork.length} seeded work items absent from items`);
  ctx.check(!seeded.raw.some((r) => itemIds.has(r.id)), 'tool_result', 'unsorted_counted_as_work', 'a raw unlabeled row appeared among work items');
  ctx.check(seeded.raw.every((r) => unsortedIds.has(r.id)), 'tool_result', 'unsorted_not_listed_apart', 'a raw unlabeled row is missing from the unsorted list');
  const unlinked = (result.items || []).filter((i) => !i.link);
  ctx.check(unlinked.length === 0, 'tool_result', 'item_without_source_link', `${unlinked.length} listed items carry no link`);
}

const CASES = {};

CASES['W1-dev-01'] = async (ctx, h, cast) => {
  const base = await ambient();
  const seeded = await seedAlerts(cast, MIXED, { unsorted: 3 });
  const before = await snapshotState(h, cast);
  const turn = await ctx.turn(h.actors.owner, { prompt: 'What needs my attention today?', rounds: [{ tools: [['needs_me', { limit: 100 }]] }] });
  const result = needsMeCall(ctx, turn);
  checkMixedFacts(ctx, result, seeded, base);
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.markCompleted();
};

CASES['W1-dev-02'] = async (ctx, h, cast) => {
  const base = await ambient();
  const seeded = await seedAlerts(cast, MIXED, { unsorted: 3 });
  const before = await snapshotState(h, cast);
  // A correct model summarises what it read, so its saved answer names the first item.
  const first = await ctx.turn(h.actors.owner, { prompt: 'Anything open I should know about right now?', rounds: [{ tools: [['needs_me', { limit: 100 }]] },
    (prev) => ({ text: `${prev.find((p) => p.name === 'needs_me').result.items.length} items are open. The first is ${prev.find((p) => p.name === 'needs_me').result.items[0].headline}.` })] });
  checkMixedFacts(ctx, needsMeCall(ctx, first), seeded, base);
  // The panel is closed and reopened: the client recovers the task and its saved reply.
  const taskId = first.body && first.body.taskId;
  const recovered = taskId ? await h.task(h.actors.owner, taskId, first.sessionId) : { status: 0 };
  ctx.check(recovered.status === 200 && recovered.body && recovered.body.taskId === taskId, 'recovery', 'task_not_recoverable', `GET task status ${recovered.status}`);
  const savedReply = recovered.body && (recovered.body.response || (recovered.body.structuredData && 'present'));
  ctx.check(!!savedReply, 'recovery', 'saved_answer_missing_after_reopen', 'the recovered task carries no saved reply');
  const list = await h.api(h.actors.owner, 'GET', `/tasks?session_id=${first.sessionId}`);
  ctx.check(list.status === 200 && (list.body.tasks || []).some((t) => t.id === taskId), 'recovery', 'task_missing_from_session_list', 'the task is not listed for its session');
  // Follow-up in the same session: the model must still hold the earlier read.
  const second = await ctx.turn(h.actors.owner, { prompt: 'what was the first one again?', rounds: [], discover: false,
    conversationHistory: first.body && first.body.conversationHistory, sessionId: first.sessionId });
  ctx.check(second.status === 200, 'proposal', 'follow_up_turn_failed', `status ${second.status}`);
  const firstHeadline = first.toolCalls.find((c) => c.name === 'needs_me').result.items[0].headline;
  const sent = JSON.stringify((second.requests[0] && second.requests[0].messages) || []);
  ctx.check(sent.includes(firstHeadline), 'recovery', 'follow_up_lost_earlier_read', 'the follow-up request to the model does not carry the earlier answer that named the first item');
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.markCompleted();
};

CASES['W1-dev-03'] = async (ctx, h, cast) => {
  const base = await ambient({ area: BILLING });
  const seeded = await seedAlerts(cast, MIXED, { unsorted: 3 });
  const before = await snapshotState(h, cast);
  const turn = await ctx.turn(h.actors.owner, { prompt: 'What is waiting in billing?', rounds: [{ tools: [['needs_me', { area: BILLING, limit: 100 }]] }] });
  const result = needsMeCall(ctx, turn);
  if (result) {
    ctx.check(result.total_open === base.total + 4, 'tool_result', 'area_total_mismatch', `Billing total_open ${result.total_open}, expected ${base.total} ambient + 4`);
    const wrongArea = (result.items || []).filter((i) => i.area !== BILLING);
    ctx.check(wrongArea.length === 0, 'tool_result', 'area_filter_leaked', `${wrongArea.length} non-Billing items returned`);
    const billingSeeded = seeded.work.filter((w) => w.area === BILLING);
    ctx.check(billingSeeded.every((w) => (result.items || []).some((i) => i.id === w.id)), 'tool_result', 'billing_item_missing', 'a seeded Billing item is absent');
  }
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.markCompleted();
};

CASES['W1-dev-04'] = async (ctx, h, cast) => {
  const base = await ambient({ who: 'claude' });
  const seeded = await seedAlerts(cast, MIXED, { unsorted: 3 });
  const before = await snapshotState(h, cast);
  const turn = await ctx.turn(h.actors.owner, { prompt: 'Is there anything Claude can just fix on its own?', rounds: [{ tools: [['needs_me', { who: 'claude', limit: 100 }]] }] });
  const result = needsMeCall(ctx, turn);
  if (result) {
    const claudeSeeded = seeded.work.filter((w) => w.who === 'claude');
    ctx.check(result.total_open === base.total + claudeSeeded.length, 'tool_result', 'who_total_mismatch', `claude total ${result.total_open}, expected ${base.total} + ${claudeSeeded.length}`);
    const wrongWho = (result.items || []).filter((i) => i.who !== 'claude');
    ctx.check(wrongWho.length === 0, 'tool_result', 'who_filter_leaked', `${wrongWho.length} person items listed as Claude work`);
  }
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.markCompleted();
};

CASES['W1-dev-05'] = async (ctx, h, cast) => {
  const base = await ambient();
  const seeded = await seedAlerts(cast, Array.from({ length: 37 }, (_, i) => ['Billing', 'Schedule', 'Comms', 'Customers'][i % 4]), {});
  const before = await snapshotState(h, cast);
  const total = base.total + 37;
  const pageSize = 15;
  const turn = await ctx.turn(h.actors.owner, { prompt: 'Show me everything that is open, a page at a time.', rounds: [{ tools: [['needs_me', { limit: pageSize }]] }] });
  const first = needsMeCall(ctx, turn);
  const seen = [];
  if (first) {
    ctx.check(first.total_open === total, 'tool_result', 'total_open_mismatch', `total_open ${first.total_open}, expected ${total}`);
    ctx.check(!!first.next_cursor, 'tool_result', 'next_cursor_missing', 'first page has no cursor although more items are open');
    seen.push(...first.items.map((i) => i.id));
    let cursor = first.next_cursor;
    let guard = 0;
    while (cursor && guard < 20) {
      guard += 1;
      const next = await ctx.turn(h.actors.owner, { prompt: 'show the rest', rounds: [{ tools: [['needs_me', { limit: pageSize, after: cursor }]] }], sessionId: turn.sessionId });
      const page = needsMeCall(ctx, next);
      if (!page) break;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
    }
    ctx.check(new Set(seen).size === seen.length, 'tool_result', 'paging_repeats_item', `${seen.length - new Set(seen).size} items repeated across pages`);
    ctx.check(seen.length === total, 'tool_result', 'paging_drops_items', `${seen.length} items across pages, total_open ${total}`);
    ctx.check(seeded.work.every((w) => seen.includes(w.id)), 'tool_result', 'seeded_item_never_listed', 'a seeded item never appeared on any page');
  }
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.markCompleted();
};

CASES['W1-dev-06'] = async (ctx, h, cast) => {
  const base = await ambient();
  const baseSchedule = await ambient({ area: 'Schedule' });
  const seeded = await seedAlerts(cast, MIXED, { unsorted: 3 });
  const before = await snapshotState(h, cast);
  const turn = await ctx.turn(h.actors.owner, { prompt: 'What needs me today?', rounds: [{ tools: [['needs_me', { limit: 100 }]] }] });
  checkMixedFacts(ctx, needsMeCall(ctx, turn), seeded, base);
  const filtered = await ctx.turn(h.actors.owner, { prompt: 'only scheduling', rounds: [{ tools: [['needs_me', { area: 'Schedule', limit: 100 }]] }], sessionId: turn.sessionId });
  const result = needsMeCall(ctx, filtered);
  if (result) {
    ctx.check(result.total_open === baseSchedule.total + 3, 'tool_result', 'filtered_total_mismatch', `Schedule total ${result.total_open}, expected ${baseSchedule.total} + 3`);
    ctx.check((result.items || []).every((i) => i.area === 'Schedule'), 'tool_result', 'area_filter_leaked', 'a non-Schedule item was returned');
  }
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.markCompleted();
};

CASES['W1-dev-07'] = async (ctx, h, cast) => {
  const base = await ambient();
  const fennimore = await cast.customer({ first_name: 'Quill', last_name: 'Fennimore' });
  const seeded = await seedAlerts(cast, MIXED, { unsorted: 3, subjectCustomer: fennimore.id });
  const before = await snapshotState(h, cast);
  const turn = await ctx.turn(h.actors.owner, { prompt: 'What needs my attention?', page: { route: `/admin/customers/${fennimore.id}`, customerId: fennimore.id },
    rounds: [{ tools: [['needs_me', { limit: 100 }]] }] });
  const result = needsMeCall(ctx, turn);
  checkMixedFacts(ctx, result, seeded, base);
  if (result) ctx.check(result.total_open === base.total + 14, 'target_resolution', 'page_context_narrowed_read', `page context narrowed the read to ${result.total_open}`);
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.markCompleted();
};

CASES['W1-dev-08'] = async (ctx, h, cast) => {
  await ambient();
  const seeded = await seedAlerts(cast, MIXED, { unsorted: 3 });
  const before = await snapshotState(h, cast);
  // A correct model reads what is open, finds no tool that resolves alerts, and says so.
  const turn = await ctx.turn(h.actors.owner, { prompt: 'Clear everything that is open so I can start fresh.', rounds: [{ tools: [['needs_me', { limit: 100 }]] }] });
  ctx.check(turn.cards.length === 0, 'proposal', 'resolve_all_proposed', 'a confirmation card was proposed for a request nothing can perform');
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.check(seeded.work.length === 14, 'harness', 'seed_size', 'fixture size');
  ctx.expectNoAttempt('the only resolver is a person in the notification UI; no tool marks an alert done, so the correct model reads and says so');
  ctx.markCompleted();
};

CASES['W1-dev-09'] = async (ctx, h, cast) => {
  const labeled = await cast.notification({ category: 'billing', title: 'Card declined on file', body: 'The saved card was declined.', link: '/admin/invoices?fixture=1',
    metadata: { area: 'Billing', severity: 'needs-you', who: 'person', doneWhen: 'card_updated_or_invoice_paid', subject: { type: 'customer', id: (await cast.customer({ first_name: 'Rune', last_name: 'Alder' })).id } } });
  const derived = await cast.notification({ category: 'payment', title: 'Older card declined item', body: 'An older declined card.', link: '/admin/invoices?fixture=2', metadata: { severity: 'needs-you' } });
  const before = await snapshotState(h, cast);
  const turn = await ctx.turn(h.actors.owner, { prompt: 'What would it take to clear the older card-declined item?', rounds: [{ tools: [['needs_me', { area: 'Billing', limit: 100 }]] }] });
  const result = needsMeCall(ctx, turn);
  if (result) {
    const l = (result.items || []).find((i) => i.id === labeled.id);
    const d = (result.items || []).find((i) => i.id === derived.id);
    ctx.check(l && l.done_when === 'card_updated_or_invoice_paid' && l.derived === false, 'tool_result', 'labeled_done_when_wrong', `labeled item: ${JSON.stringify(l && { done_when: l.done_when, derived: l.derived })}`);
    ctx.check(d && d.derived === true && (d.done_when === null || d.done_when === undefined), 'tool_result', 'derived_done_when_guessed', `derived item: ${JSON.stringify(d && { done_when: d.done_when, derived: d.derived })}`);
  }
  checkNothingResolved(ctx, before, await snapshotState(h, cast));
  ctx.markCompleted();
};

CASES['W1-dev-10'] = async (ctx, h, cast) => {
  const base = await ambient();
  const seeded = await seedAlerts(cast, MIXED, { unsorted: 3 });
  const before = await snapshotState(h, cast);
  const turn = await ctx.turn(h.actors.owner, { prompt: 'What needs me? Then check again, I think something just came in.', rounds: [{ tools: [['needs_me', { limit: 100 }]] }] });
  checkMixedFacts(ctx, needsMeCall(ctx, turn), seeded, base);
  // The injected arrival between the two reads.
  const arrived = await cast.notification({ category: 'system', title: 'Estimates item arrived', link: '/admin/estimates?fixture=new',
    metadata: { area: 'Estimates', severity: 'needs-you', who: 'person', doneWhen: 'estimate_reviewed', subject: { type: 'check', id: 'arrived' } } });
  await ctx.fixtureChanged();
  const second = await ctx.turn(h.actors.owner, { prompt: 'anything new?', rounds: [{ tools: [['needs_me', { limit: 100 }]] }], sessionId: turn.sessionId });
  const result = needsMeCall(ctx, second);
  if (result) {
    ctx.check(result.total_open === base.total + 15, 'tool_result', 'new_alert_missing_from_reread', `second read total ${result.total_open}, expected ${base.total + 15}`);
    ctx.check((result.items || []).some((i) => i.id === arrived.id), 'tool_result', 'new_alert_not_listed', 'the newly seeded alert is not in the second read');
  }
  const after = await snapshotState(h, cast);
  ctx.check(after.open === before.open + 1 && after.read === before.read, 'side_effect', 'alert_state_changed_by_read', `open ${before.open} -> ${after.open} (one arrival expected)`);
  ctx.check(Object.keys(before.rows).every((id) => before.rows[id] === after.rows[id]), 'side_effect', 'alert_row_changed_by_read', 'a seeded notification row changed value across the two reads');
  ctx.markCompleted();
};

module.exports = { CASES };
