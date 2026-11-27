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
const { composeAdminAlert, breaksAlertRules, cutAtWord, MAX_WHY_CHARS } = require('../admin-alert-compose');
const { fitAction } = require('../admin-alert-names');
const { buildWeeklyBuyList, UNASSIGNED } = require('./weekly-buy-list');

const CATEGORY = 'system';
const KEY_PREFIX = 'weekly-buy:';
const LINK = '/admin/inventory?tab=restock';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const keyFor = (group, weekStart) => `${KEY_PREFIX}${group.technicianId || UNASSIGNED}:${weekStart}`;
const monthDay = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; };
const num = (n) => String(Number(Number(n).toFixed(2)));
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const plural = (n, one, many) => (n === 1 ? one : many);
const hasContent = (group) => group.items.length > 0 || group.warnings.length > 0;

function itemLine(item) {
  const stock = `need ${num(item.needQty)} ${item.unit}, on hand ${num(item.onHand)} ${item.unit}`;
  if (item.packs === 0) return `HOLD ${item.name}: short ${num(item.shortQty)} ${item.unit} (${stock}); N/P fertilizer blackout, not bought`;
  if (item.packs == null) return `${item.name}: buy about ${num(item.shortQty)} ${item.unit}, no pack or price on file (${stock})`;
  const spare = item.reasons.includes('spare_floor') ? ', includes one spare container' : '';
  return `${item.packs} x ${item.packLabel || 'pack'} ${item.name} (${stock}${spare})`;
}

function detailFor(group, list) {
  const lines = [
    `Store: ${group.supplyStore || 'not set'}`,
    `Week: ${monthDay(list.weekStart)} to ${monthDay(list.weekEnd)}${list.fromDate > list.weekStart ? `, counted from ${monthDay(list.fromDate)}` : ''}`,
    ...group.items.map(itemLine),
  ];
  if (group.estTotalCents != null) lines.push(`Estimated total: ${money(group.estTotalCents)}`);
  const check = [...group.warnings, ...list.warnings];
  if (group.notes.length) lines.push('Notes:', ...group.notes.map((n) => `- ${n}`));
  if (check.length) lines.push('Check:', ...check.map((w) => `- ${w}`));
  return lines.join('\n');
}

// One sentence, 110 characters at most: what to buy, where and about what cost.
function whyFor(group) {
  const n = group.items.length;
  const store = group.supplyStore && !breaksAlertRules(group.supplyStore) ? group.supplyStore : null;
  const w = group.warnings.length;
  let text = n ? `${n} ${plural(n, 'product', 'products')} to buy` : `${w} ${plural(w, 'warning', 'warnings')} to check`;
  if (store) text += ` at ${store}`;
  if (group.estTotalCents != null) text += `, about ${money(group.estTotalCents)}`;
  if (n && w) text += `; ${w} to check`;
  const cut = cutAtWord(text, MAX_WHY_CHARS - 1);
  return cut.endsWith('…') ? cut : `${cut}.`;
}

function specFor(group, list) {
  const key = keyFor(group, list.weekStart);
  const md = monthDay(list.weekStart);
  const first = group.technicianName ? String(group.technicianName).trim().split(/\s+/)[0] : null;
  const action = first
    ? fitAction('Inventory', first, [(n) => `buy ${n}'s supplies, week of ${md}`, (n) => `${n}: buy list, week of ${md}`])
    : fitAction('Inventory', 'Unassigned', [(n) => `${n} visits: buy list, week of ${md}`]);
  return {
    key,
    spec: { area: 'Inventory', action, why: whyFor(group), severity: 'needs-you', link: LINK, subject: { type: 'check', id: key }, doneWhen: 'supplies_bought', who: 'person' },
  };
}

// What the alert states per product, for the next recheck to compare with.
const stated = (group) => group.items.map((i) => ({ productId: i.productId, packs: i.packs, shortQty: i.shortQty }));
const amountOf = (i) => (i.packs == null ? i.shortQty : i.packs);
const signatureOf = (group) => JSON.stringify([stated(group), [...group.warnings].sort()]);

// True when the list has a product the alert did not state, or more of one.
function growth(group, priorItems) {
  const before = new Map((priorItems || []).map((i) => [String(i.productId), amountOf(i)]));
  return stated(group).some((i) => !before.has(String(i.productId)) || amountOf(i) > before.get(String(i.productId)) + 1e-9);
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
  const signature = signatureOf(group);
  const grew = growth(group, prior?.items);
  if (known && !grew && (!known.open || prior?.signature === signature)) return 'unchanged';
  const composed = composeAdminAlert(spec);
  const row = await notify(CATEGORY, composed.headline, composed.why, {
    bell: true,
    dedupeKey: key,
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

/**
 * Monday-Saturday 7:00 AM ET. buildWeeklyBuyList counts from today (never before
 * Monday), so Monday is the whole week and a later day is the recheck: the sync
 * rings only on growth, so the same call serves both.
 */
async function runWeeklyBuyList({ knex = require('../../models/db'), now = new Date(), notify, io, list } = {}) {
  const built = list || await buildWeeklyBuyList({ knex, now });
  const sink = notify || require('../admin-alert-episodes').raiseAdminAlertWithReopen;
  return { weekStart: built.weekStart, ...(await syncWeeklyBuyAlerts({ list: built, io: io || defaultIo(knex), notify: sink })) };
}

module.exports = { runWeeklyBuyList, syncWeeklyBuyAlerts, specFor, detailFor, whyFor, growth, keyFor };
