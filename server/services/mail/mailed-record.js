'use strict';

/**
 * The record of what was mailed (mailer step 3): which new-home homes got a postcard, in which batch, and the price
 * printed on the label (migration 20261124160000). The one writer of mailed_at, mail_batch and mailed_price is
 * markBatch below, called by ops/agents/mark-mail-batch.js. The table itself refuses any later change to a mailed row's
 * price or mailed record (a BEFORE UPDATE trigger, code 23514).
 *
 * The label of a home shows its MONTHLY price (annual / 12 from whole cents, the same toPrice as the admin list and the
 * home's page), the office line to text and the date the price is held until (PRICE_HOLD_DAYS from the day it was marked).
 * Nothing here sends anything and no paid service is called.
 */

const db = require('../../models/db');
const { toPrice } = require('../prospects/mail-list');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { resolveServiceLocation, matchServiceLocation } = require('../../config/locations');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');

const LIST_KEY = 'new_home'; // services/mail/new-home-list.js LIST_KEY
const PLAN = 'pest_quarterly';
const PRICE_HOLD_DAYS = 60;
const BATCH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PRICE_COLUMNS = ['id', 'status', 'price_status', 'price_annual', 'price_setup_fee', 'priced_at', 'mailed_at', 'mail_batch', 'mailed_price'];

/** What the label shows, frozen: dollars as numbers (the unit of price_annual), monthly from whole cents. */
function snapshotOf(row) {
  const price = toPrice(row);
  if (price.annual == null || price.setupFee == null || !(price.annual > 0)) return null;
  return { plan: PLAN, annual: price.annual, monthly: price.monthly, setupFee: price.setupFee, pricedAt: price.pricedAt };
}

/** The printed price of a mailed row as the page shows it ({ monthly, annual, setupFee, pricedAt }), or null. */
function printedPriceOf(row) {
  if (!row || !row.mailed_at) return null;
  let snap = row.mailed_price;
  if (typeof snap === 'string') {
    try { snap = JSON.parse(snap); } catch { snap = null; }
  }
  if (!snap || ![snap.annual, snap.monthly, snap.setupFee].every((n) => Number.isFinite(n))) return null;
  return { monthly: snap.monthly, annual: snap.annual, setupFee: snap.setupFee, pricedAt: snap.pricedAt || null };
}

/** The Eastern calendar day the hold ends, "YYYY-MM-DD": PRICE_HOLD_DAYS after the day the label was marked. */
function heldUntilOf(mailedAt) {
  if (!mailedAt) return null;
  const at = new Date(mailedAt);
  if (Number.isNaN(at.getTime())) return null;
  return etDateString(addETDays(at, PRICE_HOLD_DAYS));
}

/** "2027-01-19" -> "Jan 19" (the label's own wording). */
function heldUntilLabel(day) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day || '');
  return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : null;
}

/** The price of one application, from whole cents (a quarterly plan is 4 applications a year), formatted like labelPrice. */
function perApplicationLabel(annual) {
  return labelPrice(Math.round(Math.round(Number(annual) * 100) / 4) / 100);
}

/** The monthly price as the label and the page print it: whole dollars bare, else two decimals. */
function labelPrice(monthly) {
  const n = Number(monthly);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV']);
const title = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/**
 * The names on the label from the Clerk's list ("LAST FIRST M" for each buyer): "Alex Tester", "Alex & Jamie Tester" for
 * one family name. { name, check: true } when a name is not that shape (a suffix, three words, a symbol): it is listed as
 * the Clerk wrote it, title case, and the person printing the labels looks at it.
 */
function labelName(recipientNames) {
  const people = [];
  let check = false;
  for (const raw of Array.isArray(recipientNames) ? recipientNames : []) {
    const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
    const plain = words.length >= 2 && words.length <= 3 && words.every((w) => /^[A-Za-z]+$/.test(w));
    const middle = words.length === 3 && words[2].length <= 2 && !SUFFIXES.has(words[2].toUpperCase());
    if (!plain || (words.length === 3 && !middle)) {
      check = true;
      people.push({ last: null, text: words.map(title).join(' ') });
    } else {
      people.push({ last: title(words[0]), text: title(words[1]) });
    }
  }
  if (!people.length) return { name: '', check: true };
  const lasts = people.map((p) => p.last);
  if (people.length > 1 && lasts[0] && lasts.every((l) => l === lasts[0])) {
    return { name: `${people.map((p) => p.text).join(' & ')} ${lasts[0]}`, check };
  }
  return {
    name: people.map((p) => (p.last ? `${p.text} ${p.last}` : p.text)).join(' & '),
    check,
  };
}

/** The office line the home texts: { number: "(941) 297-2817", byDefault } (byDefault: no city or ZIP named an office). */
function officeLineOf(row) {
  const place = { city: row.city, zip: row.zip };
  const matched = matchServiceLocation(place);
  const location = matched || resolveServiceLocation(place);
  const line = TWILIO_NUMBERS.locations[location.id];
  return { number: line ? line.formatted : location.phone, byDefault: !matched };
}

function checkBatch(batch) {
  if (typeof batch !== 'string' || !BATCH_RE.test(batch)) {
    throw new TypeError('batch: 1 to 40 letters, digits, dashes or underscores, starting with a letter or digit');
  }
}

function checkIds(ids) {
  if (ids == null) return null;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !ID_RE.test(id))) {
    throw new TypeError('ids: a list of prospect ids (uuid)');
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

// The homes that can be marked: eligible (a held-back home gets no card), priced, not yet mailed, on the new-home list.
function mailable(conn, ids) {
  const query = conn('mail_prospects')
    .where({ list_key: LIST_KEY, status: 'eligible', price_status: 'priced' })
    .whereNull('mailed_at')
    .whereNotNull('price_annual')
    .whereNotNull('price_setup_fee')
    .orderBy([{ column: 'recorded_date', order: 'asc' }, { column: 'id', order: 'asc' }]);
  return ids ? query.whereIn('id', ids) : query;
}

/**
 * Read only: the homes markBatch would mark now, with the price each would print. `ids` limits it to those prospects.
 * @returns {Promise<{ homes: { id: string, monthly: number, annual: number, setupFee: number }[], notMailable: string[] }>}
 */
async function wouldMark({ ids } = {}, conn = db) {
  const list = checkIds(ids);
  const rows = await mailable(conn, list).select(...PRICE_COLUMNS);
  const homes = [];
  for (const row of rows) {
    const snap = snapshotOf(row);
    if (snap) homes.push({ id: row.id, monthly: snap.monthly, annual: snap.annual, setupFee: snap.setupFee });
  }
  const found = new Set(homes.map((h) => h.id));
  return { homes, notMailable: list ? list.filter((id) => !found.has(id)) : [] };
}

/**
 * Mark the mailable homes (all of them, or `ids`) as mailed in `batch`, in ONE transaction: mailed_at = `now`, the batch
 * name and the frozen snapshot of the price the label prints. A mailed row is never touched again (the select skips it and
 * the update names mailed_at IS NULL), and a batch name that already has homes marks nothing (batchExists), so a second run of
 * the same call is a no-op even when more homes have been priced since.
 * @returns {Promise<{ marked: string[], notMailable: string[], batchExists?: boolean }>}
 */
async function markBatch({ batch, ids, now = new Date() }, conn = db) {
  checkBatch(batch);
  const list = checkIds(ids);
  return conn.transaction(async (trx) => {
    // A batch name is used once, so a retry (or a second operator) can never add homes that priced since to a print run that
    // was already exported. The advisory lock makes two runs with one name take turns; the second sees the first's rows.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mail_batch:${batch}`]);
    if (await trx('mail_prospects').where({ mail_batch: batch }).first('id')) return { marked: [], notMailable: list || [], batchExists: true };
    const rows = await mailable(trx, list).forUpdate().select(...PRICE_COLUMNS);
    const marked = [];
    for (const row of rows) {
      const snap = snapshotOf(row);
      if (!snap) continue;
      const updated = await trx('mail_prospects')
        .where({ id: row.id })
        .whereNull('mailed_at')
        .update({ mailed_at: now, mail_batch: batch, mailed_price: JSON.stringify(snap), updated_at: trx.fn.now() });
      if (updated) marked.push(row.id);
    }
    const done = new Set(marked);
    return { marked, notMailable: list ? list.filter((id) => !done.has(id)) : [] };
  });
}

/**
 * Read only: the label rows [{ name, price, slug, token, textNumber, heldUntil }] for the homes of `batch`, or (no batch)
 * for the homes markBatch would mark at `now`. price is the monthly price the label shows; for a marked home it is the frozen
 * snapshot and heldUntil counts from its mailed_at. Also returns the prospect ids whose name or office needs a look.
 */
async function labelsFor({ batch, ids, now = new Date() } = {}, conn = db) {
  const list = checkIds(ids);
  if (batch !== undefined && batch !== null) checkBatch(batch);
  const columns = [...PRICE_COLUMNS, 'recipient_names', 'page_slug', 'page_token', 'city', 'zip'];
  let query;
  if (batch) {
    query = conn('mail_prospects').where({ list_key: LIST_KEY, mail_batch: batch })
      .orderBy([{ column: 'recorded_date', order: 'asc' }, { column: 'id', order: 'asc' }]);
    if (list) query = query.whereIn('id', list);
  } else {
    query = mailable(conn, list);
  }
  const rows = await query.select(...columns);
  const labels = [];
  const nameCheck = [];
  const officeByDefault = [];
  for (const row of rows) {
    const printed = row.mailed_at ? printedPriceOf(row) : null;
    const priceNow = printed || snapshotOf(row);
    if (!priceNow || priceNow.monthly == null) continue;
    const { monthly, annual } = priceNow;
    const { name, check } = labelName(row.recipient_names);
    const office = officeLineOf(row);
    if (check) nameCheck.push(row.id);
    if (office.byDefault) officeByDefault.push(row.id);
    labels.push({
      name,
      price: labelPrice(monthly),
      perApplication: perApplicationLabel(annual),
      slug: row.page_slug || null,
      token: row.page_token,
      textNumber: office.number,
      heldUntil: heldUntilLabel(heldUntilOf(row.mailed_at || now)),
    });
  }
  return { labels, nameCheck, officeByDefault };
}

module.exports = {
  markBatch, wouldMark, labelsFor, snapshotOf, printedPriceOf, heldUntilOf, heldUntilLabel, labelPrice, perApplicationLabel, labelName, officeLineOf,
  PRICE_HOLD_DAYS, PLAN, BATCH_RE,
};
