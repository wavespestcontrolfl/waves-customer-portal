'use strict';

// Bid kit daily expiry check (GATE_BID_KIT, dark). Once a day, in the 6 a.m. ET compliance slot, one admin bell per kit
// item that expired or expires within 30 days, once a week per item. The bell closes when the item is renewed (its date
// moves out of the window) or archived, at once on the save and again on the daily run. The audience is the admin bell
// only; nothing is sent to a customer, an agency or anyone else. Gate off = the job returns before any query.
const { bidKitLive } = require('../config/feature-gates');
const crypto = require('node:crypto');
const db = require('../models/db');
const store = require('./bid-kit-store');
const episodes = require('./admin-alert-episodes');
const catalog = require('../../shared/bid-kit-catalog.cjs');
const logger = require('./logger');
const { errorTag } = require('./bid-kit-log');
const { composeAdminAlert, cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { fitAction, shortDateET } = require('./admin-alert-names');

const AREA = 'Estimates';
const CATEGORY = 'system';
const DEDUPE_DAYS = 7;

// docs/admin-notifications.md rule 3: a class that would push past the daily ring budget becomes a standing count. One run
// raises at most this many per-item bells; the rest are one quiet Activity-only row (a standing count) with the list in detail.
const MAX_NEW_BELLS = 3;
const OVERFLOW_KEY = 'bid-kit:expiry-overflow'; // not under KEY_PREFIX: the per-item sweep never sees it

const KEY_PREFIX = 'bid-kit:expiry:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyFor = (item) => `${KEY_PREFIX}${item.id}`;

// The item's name as a person says it: the catalog's own words. A custom row's label is free text (it can hold a name, a
// phone number or an address), so an alert never copies it: fixed words, and the link opens the item.
function nameOf(item) {
  const entry = item.item_key === 'custom' ? null : catalog.catalogItem(item.item_key);
  return entry ? entry.label : 'a custom bid paper';
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
  const today = catalog.etToday(now);
  let result;
  try {
    result = await withItemLock(item.id, async (trx) => {
      const fresh = await store.getItem(item.id, trx);
      if (fresh && qualifies(fresh, today)) return { closed: 0 };
      return { closed: await closeBells(trx, [keyFor(item)], fresh && !fresh.archived_at ? 'renewed' : 'archived') };
    });
  } catch (err) {
    logger.warn(`[bid-kit] closing the expiry bell failed: ${errorTag(err)}`);
    result = { closed: 0, failed: true };
  }
  await refreshOverflowFor(item.id, today);
  return result;
}

// An item listed in the standing count (it had no bell because the run's budget was spent): after its save, file replace or
// archive the count is rebuilt from its listed items read again, so a renewed or archived paper leaves the list at once and a
// corrected date shows. The count closes when nothing is left. A failure never fails the save: the daily run rebuilds it.
async function refreshOverflowFor(itemId, today) {
  try {
    // A cheap look first, so a save whose item is not listed takes no lock; the list is read again under the lock.
    const standing = (await episodes.openAdminAlertMetadata(db, OVERFLOW_KEY)).find((meta) => meta.dedupeKey === OVERFLOW_KEY);
    if (!standing || !Array.isArray(standing.itemKeys) || !standing.itemKeys.includes(itemId)) return;
    await syncOverflowRow(null, today, { onlyIfListed: itemId });
  } catch (err) {
    logger.warn(`[bid-kit] refreshing the standing expiry count failed: ${errorTag(err)}`);
  }
}

// One candidate from the daily run's snapshot: under the item's lock the row is read again, and the bell is raised only
// while the FRESH row still qualifies. Returns true when it rang. refreshOnly (past the run's ring budget): only an item
// whose bell is open has its words rewritten, onto that row whatever its age; never a new row, never a ring.
async function raiseIfStillDue(candidate, today, { refreshOnly = false } = {}) {
  return withItemLock(candidate.id, async (trx) => {
    const fresh = await store.getItem(candidate.id, trx);
    if (!fresh || !qualifies(fresh, today)) return false;
    if (refreshOnly && !(await episodes.openAdminAlertKeys(trx, keyFor(fresh))).includes(keyFor(fresh))) return false;
    const { spec, detail } = specFor(fresh, today);
    // The shared episode path: a bell closed after a renewal rings again when the item comes back inside the window.
    const composed = composeAdminAlert(spec);
    const result = await episodes.raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
      bell: true,
      dedupeKey: keyFor(fresh),
      ...(refreshOnly ? {} : { dedupeWindowMs: DEDUPE_DAYS * 86400000 }),
      // The words count down ("in 12 days") and follow a changed date: a standing bell is rewritten each day, quietly
      // (never rung again inside the week); a bell closed by a renewal still rings when the item comes back.
      refreshOnDedupe: true,
      ringOnRefresh: () => false,
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

// Soonest expiry first, so an expired paper comes before one that expires later.
const byUrgency = (a, b) => (a.expires_on < b.expires_on ? -1 : a.expires_on > b.expires_on ? 1 : String(a.id).localeCompare(String(b.id)));

// The standing count for items past the per-run bell budget: one row, never rung, rewritten while the list changes, closed at
// zero. Same shape as the overdue-promises backlog (notify with metadata.feed = 'activity'). Everything is decided under the
// count's own lock from rows read again there: the standing row's list, then each candidate item, so a renewal or archive
// that landed after the daily snapshot is never listed again, and two refreshes never write from stale rows.
// candidateIds: the daily run's overflow, or null to recount the standing row's own list (after a save, only when onlyIfListed
// is on that list). Returns how many papers the count now lists.
async function syncOverflowRow(candidateIds, today, { onlyIfListed = null } = {}) {
  return withItemLock(OVERFLOW_KEY, async (trx) => {
    const standing = (await episodes.openAdminAlertMetadata(trx, OVERFLOW_KEY)).find((meta) => meta.dedupeKey === OVERFLOW_KEY);
    const listed = standing && Array.isArray(standing.itemKeys) ? standing.itemKeys : [];
    if (onlyIfListed && !listed.includes(onlyIfListed)) return listed.length;
    const overflow = [];
    for (const id of candidateIds || listed) {
      const fresh = await store.getItem(id, trx);
      if (fresh && qualifies(fresh, today)) overflow.push(fresh);
    }
    overflow.sort(byUrgency);
    if (!overflow.length) {
      if (standing) await episodes.closeAdminAlertKeys(trx, [OVERFLOW_KEY], 'count_zero', { resolution: 'Cleared: no expiring paper is waiting without a bell' });
      return 0;
    }
    const n = overflow.length;
    const spec = {
      area: AREA,
      action: `renew ${n} more bid ${n === 1 ? 'paper' : 'papers'}`,
      why: cutAtWord(`${n} more ${n === 1 ? 'paper expires' : 'papers expire'} within 30 days; the full list is under Show full text.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: '/admin/bid-kit',
      subject: { type: 'check', id: 'bid-kit-expiry-overflow' },
      doneWhen: 'count_zero',
      who: 'person',
    };
    const composed = composeAdminAlert(spec);
    const lines = overflow.map((item) => `${nameOf(item)}: ${catalog.daysBetween(today, item.expires_on) < 0 ? 'expired' : 'expires'} ${shortDateET(new Date(`${item.expires_on}T12:00:00Z`))}`);
    const ids = overflow.map((item) => item.id).sort();
    await episodes.raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
      // bell: true admits the row under the admin bell policy (a bell:false row is dropped there); metadata.feed = 'activity'
      // keeps it off the bell list, its unread count and mark-all-read, exactly like the overdue-promises backlog row.
      bell: true,
      dedupeKey: OVERFLOW_KEY,
      dedupeVersion: crypto.createHash('sha256').update(ids.join(',')).digest('hex'),
      refreshOnDedupe: true,
      ringOnRefresh: () => false, // a changed count or list is rewritten quietly: it stays an Activity-only standing count
      detail: `Bid kit: ${lines.join('; ')}`,
      link: composed.link,
      trx,
      metadata: { ...composed.metadata, count: n, itemKeys: ids, feed: 'activity', quiet: true },
    });
    return n;
  });
}

// The daily job. Per run it raises at most MAX_NEW_BELLS per-item bells (expired first, then soonest expiry); items with no
// open bell that did not fit become the standing count. Every open bell whose item no longer qualifies is closed.
// Returns { skipped } with the gate off; otherwise { scanned, rang, closed, overflow }.
async function runBidKitExpiryCheck({ now = new Date() } = {}) {
  if (!bidKitLive()) return { skipped: 'gate_off' };
  const today = catalog.etToday(now);
  let rows;
  try {
    rows = await store.listItems();
  } catch (err) {
    logger.warn(`[bid-kit] expiry scan failed: ${errorTag(err)}`);
    return { scanned: 0, rang: 0, closed: 0, overflow: 0 };
  }
  const due = rows.filter((row) => qualifies(row, today)).sort(byUrgency);
  let holders = new Set();
  let standing = false;
  try {
    // One read of every open bid-kit expiry row: the per-item bells, and whether a standing count is open (only to skip the
    // count's lock when there is nothing to count and nothing to close; the count itself is decided under its lock).
    const open = await episodes.openAdminAlertKeys(db, 'bid-kit:expiry');
    holders = new Set(open.filter((key) => key.startsWith(KEY_PREFIX)));
    standing = open.includes(OVERFLOW_KEY);
  } catch (err) {
    logger.warn(`[bid-kit] reading open expiry bells failed: ${errorTag(err)}`);
  }
  let rang = 0;
  const overflow = [];
  for (const item of due) {
    // Out of budget: an item with no bell is counted; one with a bell only has its words refreshed (it never rings here).
    const spent = rang >= MAX_NEW_BELLS;
    if (spent && !holders.has(keyFor(item))) {
      overflow.push(item);
      continue;
    }
    try {
      if (await raiseIfStillDue(item, today, { refreshOnly: spent })) rang += 1;
    } catch (err) {
      logger.warn(`[bid-kit] expiry alert failed: ${errorTag(err)}`);
    }
  }
  let counted = overflow.length;
  try {
    if (overflow.length || standing) counted = await syncOverflowRow(overflow.map((item) => item.id), today);
  } catch (err) {
    logger.warn(`[bid-kit] standing expiry count failed: ${errorTag(err)}`);
  }
  let closed = 0;
  try {
    const live = new Set(due.map(keyFor));
    const stale = [...holders].filter((key) => !live.has(key));
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
  logger.info(`[bid-kit] expiry check scanned=${due.length} rang=${rang} closed=${closed} overflow=${counted}`);
  return { scanned: due.length, rang, closed, overflow: counted };
}

module.exports = { runBidKitExpiryCheck, syncExpiryBell, qualifies, specFor, keyFor, KEY_PREFIX, DEDUPE_DAYS, MAX_NEW_BELLS, OVERFLOW_KEY };
