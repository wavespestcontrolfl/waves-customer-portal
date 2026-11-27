/**
 * procurement/weekly-buy-alert.js — the Monday buy list and its daily recheck,
 * as admin alerts (owner 2026-11-27, see weekly-buy-list.js). No gate: it writes
 * admin notifications only and orders, texts and charges nothing.
 *
 * One alert per technician (and one for unassigned visits) that has something to
 * buy or a warning for the week. dedupeKey `weekly-buy:<technicianId|unassigned>:<weekStart>`.
 *   - Monday 7:00 AM ET (runWeeklyBuyList): the whole Monday-Saturday week.
 *   - Tuesday-Saturday 7:00 AM ET (the same call, counted from today). A
 *     technician's list that gained a short product, or more packs than the alert
 *     last stated, updates that week's alert and rings it again once. A list that
 *     only shrank or changed words updates the row quietly. An identical list does
 *     nothing. A list with nothing left to buy and no warning closes the alert.
 *   - Every run closes the alerts of earlier weeks (owner 2026-11-26: a repeat
 *     check must not ring forever).
 * A person's Done on a still-standing list stays done unless the list grows.
 */
const { createHash } = require('crypto');
const { composeAdminAlert, breaksAlertRules, cutAtWord, MAX_WHY_CHARS } = require('../admin-alert-compose');
const { fitAction } = require('../admin-alert-names');
const { buildWeeklyBuyList, UNASSIGNED } = require('./weekly-buy-list');

const CATEGORY = 'system';
const KEY_PREFIX = 'weekly-buy:';
const LINK = '/admin/inventory?tab=restock';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const keyFor = (group, weekStart) => `${KEY_PREFIX}${group.technicianId || UNASSIGNED}:${weekStart}`;
const monthDay = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; };
// Display only: amounts keep full precision everywhere else. Small amounts (a tank mix in gallons) show 4 places.
const num = (n) => String(Number(Number(n).toFixed(Number(n) < 1 ? 4 : 2)));
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const plural = (n, one, many) => (n === 1 ? one : many);
const hasContent = (group) => group.items.length > 0 || group.warnings.length > 0;

// Every number says its unit and where it comes from: need and on hand in the stock unit, "already ordered" (bought,
// not yet received), packs in the pack label, and the vendor the pack and price are from.
function itemLine(item) {
  const ordered = item.onOrder > 0 ? `, already ordered ${num(item.onOrder)} ${item.unit}` : '';
  const stock = `need ${num(item.needQty)} ${item.unit}, on hand ${num(item.onHand)} ${item.unit}${ordered}`;
  const from = item.vendorName ? ` from ${item.vendorName}` : '';
  if (item.packs === 0) return `HOLD ${item.name}: short ${num(item.shortQty)} ${item.unit} (${stock}); N/P fertilizer blackout, not bought`;
  const branch = item.otherBranch ? ', price not from the store\'s branch' : '';
  if (item.packs == null) return `${item.name}: buy about ${num(item.shortQty)} ${item.unit}, no pack or price on file${from}${branch} (${stock})`;
  const spare = item.reasons.includes('spare_floor') ? ', includes one extra pack so one pack of it is left after the week' : '';
  return `${item.packs} x ${item.packLabel || 'pack'} ${item.name}${from}${item.plusShipping ? ', plus shipping' : ''}${branch} (${stock}${spare})`;
}

function detailFor(group, list) {
  const lines = [
    `Preferred store: ${group.supplyStore || 'not set'} (each line names the vendor its pack and price come from)`,
    `Week: ${monthDay(list.weekStart)} to ${monthDay(list.weekEnd)}${list.fromDate > list.weekStart ? `, counted from ${monthDay(list.fromDate)}` : ''}`,
    ...group.items.map(itemLine),
  ];
  if (group.estTotalCents != null || group.unpricedLines) lines.push(`Estimated total: ${totalText(group)}`);
  // List-wide warnings are already on every group they affect (weekly-buy-list.js warnGroups).
  if (group.notes.length) lines.push('Notes:', ...group.notes.map((n) => `- ${n}`));
  if (group.warnings.length) lines.push('Check:', ...group.warnings.map((w) => `- ${w}`));
  return lines.join('\n');
}

// A lines-to-buy count that leaves out the fertilizer-blackout holds: a held line is not bought.
const buyLines = (group) => group.items.filter((i) => i.packs !== 0);
const heldLines = (group) => group.items.filter((i) => i.packs === 0);

// The total, and what it leaves out: lines to buy with no price make the estimate partial.
function costParts(group) {
  const open = group.unpricedLines;
  return {
    total: group.estTotalCents == null ? null : `${money(group.estTotalCents)}${group.shippingLines ? ' plus shipping' : ''}`,
    gap: open ? `${open} ${plural(open, 'line has', 'lines have')} no price, so the total leaves ${plural(open, 'it', 'them')} out` : null,
  };
}
const totalText = (group) => { const { total, gap } = costParts(group); return [total, gap].filter(Boolean).join('; '); };

// One sentence, 110 characters at most: what to buy, where and about what cost; or, with nothing to buy, what to check.
function whyFor(group) {
  const n = buyLines(group).length;
  const held = heldLines(group).length;
  const w = group.warnings.length;
  const store = group.supplyStore && !breaksAlertRules(group.supplyStore) ? group.supplyStore : null;
  const parts = [];
  const { total, gap } = costParts(group);
  if (n) parts.push([`${n} ${plural(n, 'product', 'products')} to buy${store ? `, preferred store ${store}` : ''}`, total && `about ${total}`, gap && `${group.unpricedLines} unpriced`].filter(Boolean).join(', '));
  if (held) parts.push(`${held} held for the fertilizer blackout`);
  if (w) parts.push(`${w} ${plural(w, 'warning', 'warnings')} to check`);
  const cut = cutAtWord(parts.join('; '), MAX_WHY_CHARS - 1);
  return cut.endsWith('…') ? cut : `${cut}.`;
}

function specFor(group, list) {
  const key = keyFor(group, list.weekStart);
  const md = monthDay(list.weekStart);
  const first = group.technicianName ? String(group.technicianName).trim().split(/\s+/)[0] : null;
  const verb = buyLines(group).length ? 'buy' : 'check';
  const action = first
    ? fitAction('Inventory', first, [(n) => `${verb} ${n}'s supplies, week of ${md}`, (n) => `${n}: ${verb} list, week of ${md}`])
    : fitAction('Inventory', 'Unassigned', [(n) => `${n} visits: ${verb} list, week of ${md}`]);
  return {
    key,
    spec: { area: 'Inventory', action, why: whyFor(group), severity: 'needs-you', link: LINK, subject: { type: 'check', id: key }, doneWhen: 'supplies_bought', who: 'person' },
  };
}

// What the alert states per product, for the next recheck to compare with.
const stated = (group) => group.items.map((i) => ({ productId: i.productId, packs: i.packs, packLabel: i.packLabel, shortQty: i.shortQty }));

// Everything the alert says, so a corrected store, pack label, price or note refreshes its text quietly. The
// "counted from" day moves every day and is left out; growth (below) is the only reason to ring again.
const signatureOf = (group, list) => JSON.stringify([
  stated(group), specFor(group, list).spec, detailFor(group, { ...list, fromDate: list.weekStart }),
]);

// True when the list has a product to buy that the alert did not state, or more of one. Packs are compared with
// packs only when both sides are whole packs of the same size; otherwise the short amount in stock units decides,
// so a pack that became known or unknown with the same demand neither rings nor hides real growth.
function growth(group, priorItems) {
  // A held line was never stated as a purchase: when it becomes one, that is a new product to buy.
  const before = new Map((priorItems || []).filter((i) => i.packs !== 0).map((i) => [String(i.productId), i]));
  return stated({ items: buyLines(group) }).some((now) => {
    const was = before.get(String(now.productId));
    if (!was) return true;
    const samePacks = now.packs != null && was.packs != null && (now.packLabel ?? null) === (was.packLabel ?? null);
    return samePacks ? now.packs > was.packs : now.shortQty > was.shortQty + 1e-9;
  });
}

// The standing row for a key, newest first, with what it last stated.
function defaultIo(knex) {
  const episodes = require('../admin-alert-episodes');
  return {
    openKeys: (prefix) => episodes.openAdminAlertKeys(knex, prefix),
    close: (keys, reason, resolution) => episodes.closeAdminAlertKeys(knex, keys, reason, { resolution }),
    async standing(key) {
      const row = await knex('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [key])
        .orderBy('created_at', 'desc').first('done_at', 'metadata');
      if (!row) return null;
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
      return { open: row.done_at == null, cleared: meta.autoCleared === true, weeklyBuy: meta.weeklyBuy || null };
    },
  };
}

async function raiseOne({ group, list, io, notify }) {
  const { key, spec } = specFor(group, list);
  const standing = await io.standing(key);
  // A row this module closed itself (nothing was short) states nothing: a comeback is growth.
  const known = standing && !standing.cleared ? standing : null;
  const prior = known?.weeklyBuy || null;
  const signature = signatureOf(group, list);
  const grew = growth(group, prior?.items);
  if (known && !grew && (!known.open || prior?.signature === signature)) return 'unchanged';
  const composed = composeAdminAlert(spec);
  const row = await notify(CATEGORY, composed.headline, composed.why, {
    bell: true,
    dedupeKey: key,
    // The writer compares the display text only; a change the text does not show (a shortage growing inside the rounding, a
    // product swapped for another with the same name) is in the signature, so the signature's hash is the version.
    dedupeVersion: createHash('sha256').update(signature).digest('hex').slice(0, 24),
    refreshOnDedupe: true,
    ringOnRefresh: () => grew,
    detail: detailFor(group, list),
    link: composed.link,
    metadata: { ...composed.metadata, weeklyBuy: { weekStart: list.weekStart, technicianId: group.technicianId, signature, items: stated(group) } },
  });
  if (!row) throw new Error(`weekly buy list alert not persisted (${key})`);
  return known ? (grew ? 'rang_again' : 'refreshed') : 'raised';
}

/**
 * Raise, refresh or close the week's alerts so they match `list`.
 * Returns the count per outcome; throws after the pass when an alert did not land.
 */
async function syncWeeklyBuyAlerts({ list, io, notify }) {
  const result = { raised: 0, rang_again: 0, refreshed: 0, unchanged: 0, closed: 0 };
  const errors = [];
  const live = new Set();
  for (const group of [...list.technicians, list.unassigned]) {
    if (!hasContent(group)) continue;
    live.add(keyFor(group, list.weekStart));
    try {
      result[await raiseOne({ group, list, io, notify })] += 1;
    } catch (err) {
      errors.push(`${keyFor(group, list.weekStart)}: ${err.message}`);
    }
  }
  const standing = await io.openKeys(KEY_PREFIX);
  const over = standing.filter((k) => !k.endsWith(`:${list.weekStart}`));
  const spent = standing.filter((k) => k.endsWith(`:${list.weekStart}`) && !live.has(k));
  if (over.length) result.closed += Number(await io.close(over, 'week_over', 'Cleared: that week is over')) || 0;
  if (spent.length) result.closed += Number(await io.close(spent, 'count_zero', 'Cleared: nothing is short for this week now')) || 0;
  if (errors.length) throw Object.assign(new Error(`Weekly buy list: ${errors.join('; ')}`), { result });
  return result;
}

// The alert writer on the SAME connection pool (or transaction) the run reads and closes through, never the global
// one: raiseAdminAlertWithReopen takes the connection as `trx`, so one transaction per alert on this knex, or the
// caller's own transaction when it holds one (its errors then belong to the caller). The supply snapshot of
// buildWeeklyBuyList is closed before any alert is written; it is never the write connection.
function raiseOn(knex) {
  const episodes = require('../admin-alert-episodes');
  const raise = (trx, category, title, body, opts) => episodes.raiseAdminAlertWithReopen(category, title, body, { ...opts, trx });
  return (category, title, body, opts) => (knex.isTransaction
    ? raise(knex, category, title, body, opts)
    : knex.transaction((trx) => raise(trx, category, title, body, opts)));
}

/**
 * Monday-Saturday 7:00 AM ET. buildWeeklyBuyList counts from today (never before
 * Monday), so Monday is the whole week and a later day is the recheck: the sync
 * rings only on growth, so the same call serves both.
 */
async function runWeeklyBuyList({ knex = require('../../models/db'), now = new Date(), notify, io, list } = {}) {
  const built = list || await buildWeeklyBuyList({ knex, now });
  const sink = notify || raiseOn(knex);
  return { weekStart: built.weekStart, ...(await syncWeeklyBuyAlerts({ list: built, io: io || defaultIo(knex), notify: sink })) };
}

module.exports = { runWeeklyBuyList, syncWeeklyBuyAlerts, specFor, detailFor, whyFor, growth, keyFor };
