'use strict';

// Bid kit daily expiry check (GATE_BID_KIT, dark). Once a day, in the 6 a.m. ET compliance slot, one admin bell per kit
// item that expired or expires within 30 days, once a week per item. The bell closes when the item is renewed (its date
// moves out of the window) or archived, at once on the save and again on the daily run. The audience is the admin bell
// only; nothing is sent to a customer, an agency or anyone else. Gate off = the job returns before any query.
const { bidKitLive } = require('../config/feature-gates');
const db = require('../models/db');
const store = require('./bid-kit-store');
const episodes = require('./admin-alert-episodes');
const catalog = require('../../shared/bid-kit-catalog.cjs');
const logger = require('./logger');
const { errorTag } = require('./bid-kit-log');
const { composeAdminAlert, cutAtWord, breaksAlertRules, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { fitAction, shortDateET } = require('./admin-alert-names');

const AREA = 'Estimates';
const CATEGORY = 'system';
const DEDUPE_DAYS = 7;

const KEY_PREFIX = 'bid-kit:expiry:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyFor = (item) => `${KEY_PREFIX}${item.id}`;

// The item's name as a person says it. A custom label with a code-shaped word falls back to the catalog's own words.
function nameOf(item) {
  const entry = catalog.catalogItem(item.item_key);
  const label = String(item.label || '').replace(/\s+/g, ' ').trim();
  if (label && !breaksAlertRules(label)) return label;
  return entry ? entry.label : 'a bid paper';
}

// "Expires Nov 4" / "Expired Oct 20", from the date itself (an Eastern calendar day, never a clock instant).
function whenWords(expiresOn, today) {
  const left = catalog.daysBetween(today, expiresOn);
  const date = shortDateET(new Date(`${expiresOn}T12:00:00Z`));
  if (left < 0) return { headline: (n) => `renew ${n}, expired`, why: `Expired ${date}; agencies reject an expired paper.` };
  if (left === 0) return { headline: (n) => `renew ${n}, expires today`, why: `Expires today, ${date}; agencies reject an expired paper.` };
  return { headline: (n) => `renew ${n}, expires ${date}`, why: `Expires ${date}, in ${left} ${left === 1 ? 'day' : 'days'}; bids need a current copy.` };
}

function specFor(item, today) {
  const name = nameOf(item);
  const words = whenWords(item.expires_on, today);
  return {
    spec: {
      area: AREA,
      action: fitAction(AREA, name, [words.headline, (n) => `renew ${n}`]),
      why: cutAtWord(words.why, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: `/admin/bid-kit?item=${item.id}`,
      subject: { type: 'check', id: item.id },
      doneWhen: 'item_renewed',
      who: 'person',
    },
    detail: `Bid kit: ${name} ${words.why}`,
  };
}

// An item rings while it is there (not missing), not archived, and its expiry is past or within 30 days. By date, not by
// status: an unsigned item that expires soon still needs renewing (its status reads needs sign-off).
function qualifies(row, today) {
  if (row.archived_at || !row.expires_on) return false;
  const status = catalog.itemStatus({ ...row, has_file: row.has_file === true }, { today });
  return status !== catalog.STATUS.MISSING && catalog.daysBetween(today, row.expires_on) <= catalog.EXPIRING_DAYS;
}

// One lock per item serializes everything that raises or closes its bell: the daily run, and the close that follows a save,
// a file replacement or an archive. Each of them takes it, then READS THE ROW AGAIN, then decides, all in one transaction.
// A renewal or archive that lands after the daily run listed the items but before it raises is therefore seen (the run
// re-reads and skips), and one that lands after the raise is closed by its own close (which waits for the lock and re-reads).
// Either order leaves the bell right. A transaction-scoped advisory lock, so it is released at commit and never blocks a save.
function withItemLock(id, fn) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`bid-kit:expiry-item:${id}`]);
    return fn(trx);
  });
}

// The bell has done its job when the paper is renewed (the date moved out of the window), the item is archived, or it is no
// longer there: close it the same way every other source does, so it leaves the bell and a real comeback rings again.
async function closeBells(conn, keys, reason) {
  if (!keys.length) return 0;
  return episodes.closeAdminAlertKeys(conn, keys, reason, { resolution: 'Cleared: this paper is renewed, archived or no longer expires within 30 days' });
}

// Called after a save, a file replace or an archive (the item passed is only a handle: the row is read again under the
// lock). Closes the item's open bell when the fresh row no longer qualifies. A failure never fails the save: the daily job
// closes it on its next run.
async function syncExpiryBell(item, { now = new Date() } = {}) {
  if (!bidKitLive() || !item || !item.id) return { skipped: 'gate_off' };
  try {
    const today = catalog.etToday(now);
    return await withItemLock(item.id, async (trx) => {
      const fresh = await store.getItem(item.id, trx);
      if (fresh && qualifies(fresh, today)) return { closed: 0 };
      return { closed: await closeBells(trx, [keyFor(item)], fresh && !fresh.archived_at ? 'renewed' : 'archived') };
    });
  } catch (err) {
    logger.warn(`[bid-kit] closing the expiry bell failed: ${errorTag(err)}`);
    return { closed: 0, failed: true };
  }
}

// One candidate from the daily run's snapshot: under the item's lock the row is read again, and the bell is raised only
// while the FRESH row still qualifies. Returns true when it rang.
async function raiseIfStillDue(candidate, today) {
  return withItemLock(candidate.id, async (trx) => {
    const fresh = await store.getItem(candidate.id, trx);
    if (!fresh || !qualifies(fresh, today)) return false;
    const { spec, detail } = specFor(fresh, today);
    // The shared episode path: a bell closed after a renewal rings again when the item comes back inside the window.
    const composed = composeAdminAlert(spec);
    const result = await episodes.raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
      bell: true,
      dedupeKey: keyFor(fresh),
      dedupeWindowMs: DEDUPE_DAYS * 86400000,
      detail,
      link: composed.link,
      trx,
      metadata: { bidKitItemId: fresh.id, ...composed.metadata },
    });
    return Boolean(result && result.rang);
  });
}

// An open bell whose item the snapshot says no longer qualifies: closed under the lock, but only if the fresh row agrees.
async function closeIfNoLongerDue(key, today) {
  const id = key.slice(KEY_PREFIX.length);
  if (!UUID.test(id)) return 0;
  return withItemLock(id, async (trx) => {
    const fresh = await store.getItem(id, trx);
    if (fresh && qualifies(fresh, today)) return 0;
    return closeBells(trx, [key], 'no_longer_qualifies');
  });
}

// The daily job: one bell per qualifying item, and every open bell whose item no longer qualifies is closed.
// Returns { skipped } with the gate off; otherwise { scanned, rang, closed }.
async function runBidKitExpiryCheck({ now = new Date() } = {}) {
  if (!bidKitLive()) return { skipped: 'gate_off' };
  const today = catalog.etToday(now);
  let rows;
  try {
    rows = await store.listItems();
  } catch (err) {
    logger.warn(`[bid-kit] expiry scan failed: ${errorTag(err)}`);
    return { scanned: 0, rang: 0, closed: 0 };
  }
  const due = rows.filter((row) => qualifies(row, today));
  let rang = 0;
  for (const item of due) {
    try {
      if (await raiseIfStillDue(item, today)) rang += 1;
    } catch (err) {
      logger.warn(`[bid-kit] expiry alert failed: ${errorTag(err)}`);
    }
  }
  let closed = 0;
  try {
    const live = new Set(due.map(keyFor));
    const stale = (await episodes.openAdminAlertKeys(db, KEY_PREFIX)).filter((key) => !live.has(key));
    for (const key of stale) {
      try {
        closed += await closeIfNoLongerDue(key, today);
      } catch (err) {
        logger.warn(`[bid-kit] closing a stale expiry bell failed: ${errorTag(err)}`);
      }
    }
  } catch (err) {
    logger.warn(`[bid-kit] closing stale expiry bells failed: ${errorTag(err)}`);
  }
  logger.info(`[bid-kit] expiry check scanned=${due.length} rang=${rang} closed=${closed}`);
  return { scanned: due.length, rang, closed };
}

module.exports = { runBidKitExpiryCheck, syncExpiryBell, qualifies, specFor, keyFor, KEY_PREFIX, DEDUPE_DAYS };
