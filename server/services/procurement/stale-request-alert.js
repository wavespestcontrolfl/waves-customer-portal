/**
 * procurement/stale-request-alert.js — one admin alert for an automatic restock request that has stayed
 * open too long (owner 2026-11-27, "build fixes"). No gate: it writes admin notifications only.
 *
 * A request from the auto-reorder sweep (source auto_reorder) in any status but received or cancelled, older
 * than STALE_DAYS, gets one alert: "Inventory — check the <product> restock, open N days". dedupeKey
 * `restock-open:<request id>`.
 *   - The first run past 7 days rings once. Every later run only refreshes the row (the day count) quietly,
 *     so a stuck request never rings daily (owner 2026-11-26). A person's Done stays done.
 *   - Each run closes the alert of any request that is no longer open and stale (received, cancelled or gone).
 * It does not overlap macWatchdog (order-dispatch.js): that one hands a SiteOne request the Mac did not touch
 * for 30 hours to the office. This one reports any automatic request older than a week, whatever stalled it
 * (a park with its own alert, a manual order never received, an unclaimed request).
 * Called from runVendorOrderDispatch's reconcile step (the server's run), once a day with the 6:10 sweep.
 */
const { composeAdminAlert } = require('../admin-alert-compose');
const { fitAction } = require('../admin-alert-names');

const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = 'restock-open:';
const LINK = '/admin/inventory?tab=restock';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function specFor({ request, days }) {
  const key = `${KEY_PREFIX}${request.id}`;
  const { etParts } = require('../../utils/datetime-et');
  const since = etParts(new Date(request.created_at));
  // An order may exist that this portal never recorded (an ambiguous or in-flight submit, or one staff placed by
  // hand and never marked), so an open request is never "nothing ordered": it says to check the vendor account.
  const vendorName = request.vendor_name && request.vendor_name.length <= 30 ? request.vendor_name : 'vendor';
  const state = request.status === 'ordered' ? 'marked ordered, nothing received' : `no order recorded, check the ${vendorName} account`;
  return {
    key,
    spec: {
      area: 'Inventory',
      action: fitAction('Inventory', request.product_name || 'a product', [(n) => `check the ${n} restock, open ${days} days`, (n) => `${n} restock, open ${days} days`]),
      why: `Open since ${MONTHS[since.month - 1]} ${since.day}; ${state}.`,
      severity: 'needs-you',
      link: LINK,
      subject: { type: 'check', id: key },
      doneWhen: 'request_closed',
      who: 'person',
    },
  };
}

/**
 * Raise or quietly refresh the alert of every stale request, close the alerts of requests that are not stale
 * and open any more. `notify` is the alert writer (weekly-buy-alert's raiseOn(knex)); returns the counts.
 */
async function syncStaleRequestAlerts({ knex = require('../../models/db'), now = new Date(), notify = null } = {}) {
  const episodes = require('../admin-alert-episodes');
  const write = notify || require('./weekly-buy-alert').raiseOn(knex);
  const rows = await knex('product_restock_requests as prr')
    .leftJoin('products_catalog as pc', 'pc.id', 'prr.product_id')
    .leftJoin('vendor_orders as vo', 'vo.restock_request_id', 'prr.id')
    .leftJoin('vendors as v', knex.raw("v.id::text = COALESCE(vo.vendor_id::text, prr.metadata->>'vendorId')"))
    .where('prr.source', 'auto_reorder')
    .whereNotIn('prr.status', ['received', 'cancelled'])
    .where('prr.created_at', '<=', new Date(now.getTime() - STALE_DAYS * DAY_MS))
    .select('prr.id', 'prr.status', 'prr.created_at', 'pc.name as product_name', 'v.name as vendor_name');
  const live = new Set();
  const errors = [];
  for (const request of rows) {
    const days = Math.floor((now.getTime() - new Date(request.created_at).getTime()) / DAY_MS);
    const { key, spec } = specFor({ request, days });
    live.add(key);
    try {
      const composed = composeAdminAlert(spec);
      const row = await write('system', composed.headline, composed.why, {
        bell: true,
        dedupeKey: key,
        refreshOnDedupe: true,
        ringOnRefresh: () => false, // only the first raise rings; the day count refreshes the row quietly
        link: composed.link,
        metadata: composed.metadata,
      });
      if (!row) throw new Error('not persisted');
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  }
  const standing = await episodes.openAdminAlertKeys(knex, KEY_PREFIX);
  const gone = standing.filter((k) => !live.has(k));
  const closed = gone.length ? Number(await episodes.closeAdminAlertKeys(knex, gone, 'request_closed', { now, resolution: 'Cleared: the restock request is closed' })) || 0 : 0;
  if (errors.length) throw Object.assign(new Error(`Stale restock alerts: ${errors.join('; ')}`), { result: { stale: live.size, closed } });
  return { stale: live.size, closed };
}

module.exports = { syncStaleRequestAlerts, specFor, STALE_DAYS, KEY_PREFIX };
